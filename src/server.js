import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  db, listSessions, getSession, createSession, deleteSession, checkSessionDeletable, sessionContents, lastUsedLayout, publicSession, masterPayload,
  saveCounts, countedPallets, recordSignon, norm,
  listDevices, getDevice, createDevice, updateDevice, deleteDevice, touchDevice,
  enrollDevice, deviceByToken, resetDevice,
} from './db.js';
import { importMaster, pruneAreaAisles } from './routes/master.js';
import { boardData } from './routes/board.js';
import { sendMessage, listMessages, messagesFor, ackMessage, clearMessage } from './routes/messages.js';
import { listAdjustments, decideAdjustments, adjustmentReasons, saveAdjustmentReasons } from './routes/adjustments.js';
import { accuracy, accuracyCsv, deriveAbc, accuracyTargets, saveAccuracyTargets } from './routes/accuracy.js';
import { setupState } from './routes/setup.js';
import { searchAll } from './routes/search.js';
import { scannerPrompts, saveScannerPrompts, defaultScannerPrompts, scannerLayout, saveScannerLayout, defaultScannerLayout, defaultSessionId, setDefaultSessionId, migrateCommentTimeout } from './routes/scanner-prompts.js';
import {
  aisleOverview, listAssignments, setBlock, autoBlock, queueAssignments,
  setAssignmentStatus, deleteAssignment, teamStatus, applyLayoutBlocks,
} from './routes/assignments.js';
import { progress, palletReport, uncountedBins, rawCounts, exceptions, mapData, findLot, labelsToReplace } from './routes/reports.js';
import {
  listRecounts, createRecount, generateFromVariances, autoAfterCounts, autoAfterAisle,
  tasksForTeam, takeRecount, finishRecount, updateRecount, deleteRecount,
} from './routes/recounts.js';
import { generateBatch, previewBatch, listBatches, deleteBatch, coverage, runSchedules, STRATEGIES, levelsOnOpenTasks } from './routes/cycles.js';
import {
  listEmployees, upsertEmployee, deleteEmployee, importEmployees, importHelpers,
  listTeams, createTeam, deleteTeam, assignMember, getConfig, setConfig, getEmployee,
  crewCheck, crewShortfall,
} from './routes/people.js';

import { toCsv, parseRecords, pick } from './util/csv.js';
import { listLayouts, loadLayout } from './util/layouts.js';
import { siteTimezone, localDate, localHour } from './util/localtime.js';
import { audit, listAudit, makeBackup, listBackups, backupPath, startBackupSchedule } from './routes/admin-ops.js';
import { countSheet, scannerCards, barcodeBook } from './routes/printing.js';
import {
  countUsers, countAdmins, listUsers, createUser, updateUser, deleteUser, authenticate, changeOwnPassword, getUser, ensureSuperadmin,
} from './routes/users.js';
import { listFormats, saveFormat, buildExport, availableFields } from './routes/erp.js';

// people.js parses uploaded rosters with the shared CSV helpers
importHelpers.parseRecords = parseRecords;
importHelpers.pick = pick;

// Scanners authenticate by default. Set SCANNER_AUTH=off only on a network
// where anyone who can reach the server is already trusted.
const SCANNER_AUTH = String(process.env.SCANNER_AUTH || 'required').toLowerCase() !== 'off';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
/* A real admin login, seeded from the environment so a site never has to
   bootstrap through the shared password. The password falls back to
   ADMIN_PASSWORD when SUPERADMIN_PASSWORD is not set separately. */
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || '';
const SUPERADMIN_NAME = process.env.SUPERADMIN_NAME || '';
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || ADMIN_PASSWORD;
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MAX_BODY = Number(process.env.MAX_UPLOAD_MB || 64) * 1024 * 1024;

/*
 * Which build of the handheld app this server is serving.
 *
 * A gun that is left running - an installed app on a cradle, backgrounded
 * overnight - keeps the code it started with for as long as nobody closes it.
 * The service worker fetches from the network first, so a RELOAD always gets the
 * new app; the trouble is that nothing ever makes it reload, and a fleet of
 * thirty scanners in a freezer is not a fleet anybody wants to go round and
 * relaunch by hand.
 *
 * So the server stamps what it is serving, the gun compares it against what it
 * is running, and a scanner that has fallen behind says so and reloads itself
 * when its counter is between pallets. Hashed from the files themselves rather
 * than a version number somebody has to remember to bump.
 */
const SHELL_FILES = ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js'];
const appBuild = { version: 'dev', files: {} };
try {
  const parts = [];
  for (const name of SHELL_FILES) {
    const body = readFileSync(join(PUBLIC_DIR, name));
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
    appBuild.files['/' + name] = hash;
    parts.push(`${name}:${hash}`);
  }
  appBuild.version = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
} catch (err) {
  console.warn(`[warn] could not stamp the app build (${err.message}); scanners will not auto-update.`);
}
console.log(`[app] build ${appBuild.version}`);

if (ADMIN_PASSWORD === 'changeme') {
  console.warn('[warn] ADMIN_PASSWORD is unset - the dashboard password is "changeme".');
}
if (!SCANNER_AUTH) {
  console.warn('[warn] SCANNER_AUTH=off - anyone who can reach this server can post counts.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
};

/* ------------------------------------------------------------ plumbing */

/*
 * Compressing the same half-megabyte master list thirty times over, once per
 * handheld at the start of a shift, is nine milliseconds of the whole server
 * stopped each time. Identical bodies compress to identical bytes, so keep the
 * last few keyed by their digest - hashing is an order of magnitude cheaper.
 */
const GZIP_CACHE = new Map();
const GZIP_CACHE_MIN = 64 * 1024;   // below this, compressing is cheaper than remembering
const GZIP_CACHE_MAX = 4 * 1024 * 1024;
const GZIP_CACHE_KEEP = 6;

function gzipMaybeCached(payload) {
  if (payload.length < GZIP_CACHE_MIN || payload.length > GZIP_CACHE_MAX) return gzipSync(payload);
  const key = createHash('sha1').update(payload).digest('base64');
  const hit = GZIP_CACHE.get(key);
  if (hit) return hit;
  const gz = gzipSync(payload);
  GZIP_CACHE.set(key, gz);
  while (GZIP_CACHE.size > GZIP_CACHE_KEEP) GZIP_CACHE.delete(GZIP_CACHE.keys().next().value);
  return gz;
}

function send(req, res, status, body, headers = {}) {
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const h = { 'cache-control': 'no-store', ...headers };
  const accepts = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (accepts && payload.length > 1024 && !h['content-encoding']) {
    payload = gzipMaybeCached(payload);
    h['content-encoding'] = 'gzip';
  }
  h['content-length'] = payload.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

const sendJson = (req, res, status, obj) =>
  send(req, res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });

const sendCsv = (req, res, filename, csv) =>
  send(req, res, 200, csv, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
  });

function readBody(req) {
  return new Promise((res2, rej) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        rej(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => res2(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ------------------------------------------------------------ admin auth */

// token -> { name, username, role }
const adminTokens = new Map();

/*
 * The shared password is the way in before anyone has an account, and the way
 * back in when everyone has forgotten theirs. Its use is always logged as such.
 *
 * SHARED_PASSWORD_LOGIN=off turns it off - but only once there is an admin
 * account to turn it off in favour of. Off with no admin is not a locked door,
 * it is a bricked deployment: nobody can sign in, and nobody can create the
 * account that would let them, without a redeploy. So the switch waits, says
 * so at startup, and takes effect by itself the moment an admin exists.
 */
const SHARED_LOGIN_WANTED = String(process.env.SHARED_PASSWORD_LOGIN || 'on').toLowerCase() !== 'off';
const sharedLoginOn = () => SHARED_LOGIN_WANTED || countAdmins() === 0;
/** True when the setting is off but being held open because nobody could get back in. */
const sharedLoginHeldOpen = () => !SHARED_LOGIN_WANTED && countAdmins() === 0;

function passwordMatches(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function currentUser(req, url) {
  const auth = String(req.headers.authorization || '');
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // a count sheet is opened in a new tab, which cannot carry a header
  if (!token && url && /\/print\//.test(url.pathname)) token = url.searchParams.get('t') || '';
  return adminTokens.get(token) || null;
}

function requireAdmin(req, url) {
  const who = currentUser(req, url);
  if (!who) throw httpError(401, 'unauthorized');
  return who.name;
}

/** Managing accounts is the one thing a plain supervisor cannot do. */
function requireAccountAdmin(req, url) {
  const who = currentUser(req, url);
  if (!who) throw httpError(401, 'unauthorized');
  if (who.role !== 'admin') throw httpError(403, 'only an admin can manage accounts');
  return who;
}

/* ------------------------------------------------------- scanner auth */

/**
 * A scanner proves itself with the token it got when its link was first opened.
 * The 'device' code tells the gun to say so plainly rather than looking broken.
 */
function requireDevice(req) {
  if (!SCANNER_AUTH) return null;
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Device ') ? auth.slice(7) : '';
  if (!token) throw Object.assign(httpError(401, 'this scanner is not signed in - open its link again'), { code: 'device' });
  const d = deviceByToken(token);
  if (!d) throw Object.assign(httpError(401, 'this scanner is no longer authorised - ask a supervisor for its link'), { code: 'device' });
  return d;
}

/* ------------------------------------------------------------ static */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html'
    : /^\/admin\/?$/.test(pathname) ? '/admin.html'
    : /^\/teams\/?$/.test(pathname) ? '/teams.html'
    : /^\/cycle\/?$/.test(pathname) ? '/cycle.html'
    : /^\/settings\/?$/.test(pathname) ? '/settings.html'
    : /^\/board\/?$/.test(pathname) ? '/board.html'
    : pathname;
  const filePath = join(PUBLIC_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(req, res, 403, 'forbidden');
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    const ext = extname(filePath);
    // The service worker must never be served from a stale cache.
    const cache = rel === '/sw.js' ? 'no-store' : 'no-cache';
    send(req, res, 200, body, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
  } catch {
    send(req, res, 404, 'not found');
  }
}

/* ------------------------------------------------------------ routes */

/**
 * Who signed on and whether they can reach the work. In a full count the levels
 * come from the aisle the team was given; in a cycle count they come from the
 * bins on its list, which is the same question asked of different work.
 */
function crewFor(sessionId, team, badges, status) {
  const check = crewCheck(badges, team);
  const session = getSession(sessionId);
  let levels = '';
  let where = '';
  if (session && session.mode === 'cycle') {
    levels = levelsOnOpenTasks(sessionId, team);
    where = 'the bins on your list';
  } else {
    levels = status.active ? status.active.levels : (status.queuedDetail?.[0]?.levels || '');
    where = status.active ? `Aisle ${status.active.aisle}` : (status.queued?.[0] ? `Aisle ${status.queued[0]}` : '');
  }
  return { ...check, forAisle: where, forLevels: levels, shortfall: crewShortfall(check, levels) };
}

function openSession(id) {
  const s = getSession(id);
  if (!s) throw httpError(404, 'session not found');
  if (s.status !== 'open') throw httpError(409, 'session is closed');
  return s;
}

async function handleHandheld(req, res, url, m) {
  const method = req.method;
  const p = url.pathname;

  // A scanner opening its own link trades it for a token it keeps. This is the
  // only handheld route without one, and the link is the secret that gets it.
  if ((m = p.match(/^\/api\/devices\/([a-z0-9]{4,32})$/)) && (method === 'GET' || method === 'POST')) {
    const d = getDevice(m[1]);
    if (!d) throw httpError(404, 'this scanner link is not registered - ask a supervisor');
    touchDevice(d.uid);
    const enrolled = enrollDevice(d.uid);
    audit(d.name, 'scanner enrolled', `attempt ${(getDevice(d.uid).enrol_count)} for this link`);
    return sendJson(req, res, 200, { uid: d.uid, name: d.name, token: enrolled.token, authRequired: SCANNER_AUTH });
  }

  // past this point a scanner must prove which scanner it is
  const device = requireDevice(req);

  if (p === '/api/sessions' && method === 'GET') {
    return sendJson(req, res, 200, listSessions('open').map(publicSession));
  }

  if ((m = p.match(/^\/api\/sessions\/(\d+)\/master$/)) && method === 'GET') {
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    // Handhelds send ?have=<version> to skip a re-download they already hold.
    const have = url.searchParams.get('have');
    if (have != null && Number(have) === s.master_version) {
      return sendJson(req, res, 200, { unchanged: true, ...publicSession(s) });
    }
    return sendJson(req, res, 200, masterPayload(m[1]));
  }

  if ((m = p.match(/^\/api\/sessions\/(\d+)\/signon$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    if (!norm(body.deviceId)) throw httpError(400, 'deviceId required');
    if (!norm(body.team)) throw httpError(400, 'team required');
    recordSignon(m[1], {
      deviceId: body.deviceId,
      team: body.team,
      employees: Array.isArray(body.employees) ? body.employees.map((e) => norm(e)).filter(Boolean) : [],
    });
    touchDevice(device ? device.uid : body.deviceUid, { team: body.team, sessionId: m[1] });

    // Who actually signed on, and can they reach what this team was given?
    const status = teamStatus(m[1], body.team, { exceptDevice: device ? device.name : body.deviceId });
    return sendJson(req, res, 200, { ...status, crew: crewFor(m[1], body.team, body.employees, status) });
  }

  if ((m = p.match(/^\/api\/sessions\/(\d+)\/team-status$/)) && method === 'GET') {
    if (!getSession(m[1])) throw httpError(404, 'session not found');
    const team = url.searchParams.get('team') || '';
    const status = teamStatus(m[1], team, { exceptDevice: device ? device.name : url.searchParams.get('device') || '' });
    const badges = (url.searchParams.get('employees') || '').split(',').filter(Boolean);
    if (!badges.length) return sendJson(req, res, 200, status);
    return sendJson(req, res, 200, { ...status, crew: crewFor(m[1], team, badges, status) });
  }

  // A team declares an aisle finished from the handheld; the block frees up.
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/assignments\/(\d+)\/complete$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    const row = db.prepare('SELECT * FROM assignments WHERE id = ? AND session_id = ?').get(Number(m[2]), Number(m[1]));
    if (!row) throw httpError(404, 'assignment not found');
    if (row.team !== norm(body.team)) throw httpError(403, 'that aisle belongs to another team');
    setAssignmentStatus(m[1], m[2], 'done');
    autoAfterAisle(m[1], row.aisle, row.levels, row.team);
    return sendJson(req, res, 200, teamStatus(m[1], body.team));
  }

  /* Messages from the office. The gun asks on its sync tick and puts anything
     live on the screen; acknowledging is what takes it off. */
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/messages$/)) && method === 'GET') {
    if (!getSession(m[1])) throw httpError(404, 'session not found');
    const who = device ? device.name : url.searchParams.get('device') || '';
    return sendJson(req, res, 200, { messages: messagesFor(m[1], url.searchParams.get('team') || '', who) });
  }
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/messages\/(\d+)\/ack$/)) && method === 'POST') {
    const body = await readJson(req);
    const who = device ? device.name : body.deviceId;
    return sendJson(req, res, 200, ackMessage(m[1], m[2], { deviceId: who, team: body.team }));
  }

  if ((m = p.match(/^\/api\/sessions\/(\d+)\/counted-pallets$/)) && method === 'GET') {
    if (!getSession(m[1])) throw httpError(404, 'session not found');
    return sendJson(req, res, 200, countedPallets(m[1], url.searchParams.get('since') || null));
  }

  if ((m = p.match(/^\/api\/sessions\/(\d+)\/counts$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    const rows = Array.isArray(body) ? body : body.counts;
    if (!Array.isArray(rows)) throw httpError(400, 'expected an array of counts');
    // the device is whoever the token says, not whatever the payload claims
    const result = saveCounts(m[1], device ? rows.map((r) => ({ ...r, deviceId: device.name })) : rows);
    if (result.firstCountPallets.length) result.recounts = autoAfterCounts(m[1], result.firstCountPallets);
    return sendJson(req, res, 200, result);
  }

  // --- second counts, from the gun
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/recounts$/)) && method === 'GET') {
    if (!getSession(m[1])) throw httpError(404, 'session not found');
    return sendJson(req, res, 200, { tasks: tasksForTeam(m[1], url.searchParams.get('team') || '') });
  }
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/recounts\/(\d+)\/take$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    return sendJson(req, res, 200, takeRecount(m[1], m[2], body.team));
  }
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/recounts\/(\d+)\/done$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    return sendJson(req, res, 200, finishRecount(m[1], m[2], body.team));
  }

  if ((m = p.match(/^\/api\/sessions\/(\d+)\/void$/)) && method === 'POST') {
    const body = await readJson(req);
    if (!body.clientId) throw httpError(400, 'clientId required');
    const info = db
      .prepare('UPDATE counts SET voided = 1 WHERE session_id = ? AND client_id = ?')
      .run(Number(m[1]), String(body.clientId));
    return sendJson(req, res, 200, { voided: info.changes });
  }

  return false;
}

async function handleAdmin(req, res, url, m) {
  const method = req.method;
  const p = url.pathname;

  if (p === '/api/admin/login' && method === 'POST') {
    const body = await readJson(req);
    const token = randomUUID();
    const username = String(body.username || '').trim();

    // A real account first. What was typed can be either a username or, at a site
    // still on the shared password, just a name - so an unknown name falls
    // through, while a name that IS an account must get that account's password.
    if (username) {
      const user = authenticate(username, body.password);
      if (user) {
        adminTokens.set(token, { name: user.name, username: user.username, role: user.role });
        audit(user.name, 'signed in', `as ${user.username} (${user.role})`);
        // a starter password gets them in, but only as far as choosing a real one
        return sendJson(req, res, 200, {
          token, name: user.name, username: user.username, role: user.role,
          mustChange: user.mustChange, accounts: countUsers(),
        });
      }
      if (getUser(username)) throw httpError(401, 'that username and password do not match');
    }

    // otherwise the shared password, which is recorded for what it is
    if (!sharedLoginOn()) throw httpError(401, 'sign in with your username and password');
    if (!passwordMatches(body.password)) throw httpError(401, 'bad password');
    const who = String(body.name || username || '').trim().slice(0, 40) || 'shared password';
    adminTokens.set(token, { name: who, username: '', role: 'admin' });
    audit(who, 'signed in with the shared password', sharedLoginHeldOpen()
      ? 'SHARED_PASSWORD_LOGIN is off but held open - no admin account exists yet'
      : countUsers() ? 'accounts exist - this should be rare' : 'no accounts yet');
    return sendJson(req, res, 200, { token, name: who, username: '', role: 'admin', shared: true, accounts: countUsers() });
  }

  const actor = requireAdmin(req, url);

  // --- scanners
  if (p === '/api/admin/devices' && method === 'GET') return sendJson(req, res, 200, { devices: listDevices(), authRequired: SCANNER_AUTH });
  if (p === '/api/admin/devices' && method === 'POST') {
    const body = await readJson(req);
    const dev = createDevice(body);
    audit(actor, 'registered a scanner', dev.name);
    return sendJson(req, res, 200, dev);
  }
  if ((m = p.match(/^\/api\/admin\/devices\/([a-z0-9]+)$/)) && method === 'POST') {
    const body = await readJson(req);
    return sendJson(req, res, 200, updateDevice(m[1], body));
  }
  if ((m = p.match(/^\/api\/admin\/devices\/([a-z0-9]+)\/reset$/)) && method === 'POST') {
    const before = getDevice(m[1]);
    const after = resetDevice(m[1]);
    audit(actor, 'reset a scanner link', `${before?.name}: the old link and token no longer work`);
    return sendJson(req, res, 200, after);
  }
  if ((m = p.match(/^\/api\/admin\/devices\/([a-z0-9]+)$/)) && method === 'DELETE') {
    audit(actor, 'removed a scanner', getDevice(m[1])?.name || m[1]);
    return sendJson(req, res, 200, { deleted: deleteDevice(m[1]) });
  }

  if (p === '/api/admin/sessions' && method === 'GET') return sendJson(req, res, 200, listSessions());

  if (p === '/api/admin/sessions' && method === 'POST') {
    const body = await readJson(req);
    if (!body.name || !String(body.name).trim()) throw httpError(400, 'name required');
    // A new count inherits the map drawing the site is already using - and if this
    // is the first count, the one drawing that ships takes it. Nobody should have
    // to remember to turn the blueprint back on.
    const shipped = listLayouts();
    const layout = body.layout !== undefined ? String(body.layout || '')
      : lastUsedLayout() || (shipped.length === 1 ? shipped[0].id : '');
    const created = createSession({
      mode: body.mode === 'cycle' ? 'cycle' : 'full',
      name: String(body.name).trim(),
      palletMode: body.palletMode,
      guided: body.guided !== false,
      askComments: body.askComments !== false,
      layout: loadLayout(layout) ? layout : '',
    });
    audit(actor, 'created session', `#${created.id} "${created.name}" (${created.mode})`, created.id);
    return sendJson(req, res, 200, created);
  }

  // what a delete would take with it, so the page can say before it asks
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)$/)) && method === 'GET') {
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    return sendJson(req, res, 200, { ...s, contents: sessionContents(s.id) });
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)$/)) && method === 'DELETE') {
    const body = await readJson(req).catch(() => ({}));
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    /* Check it can go BEFORE doing anything expensive: a refused delete should
       not leave a backup behind, and there were three ways to be refused. */
    const { had } = checkSessionDeletable(m[1], { confirmName: body.confirmName });
    /* A count with lines in it is worth a copy of the database first: the
       delete cannot be undone, and a backup is cheap next to a lost count. */
    let backup = null;
    let backupError = null;
    if (had.counts > 0) {
      try {
        backup = makeBackup('before-delete');
      } catch (err) {
        // a failed backup must not be silent: it changes what this delete costs
        console.warn(`[warn] could not back up before deleting session ${s.id}: ${err.message}`);
        backupError = err.message;
      }
    }
    const gone = deleteSession(m[1], { confirmName: body.confirmName });
    if (defaultSessionId() === gone.id) setDefaultSessionId(0);
    audit(actor, 'DELETED a count', `#${gone.id} "${gone.name}" (${gone.mode}) — `
      + `${had.counts.toLocaleString()} counted lines, ${had.bins.toLocaleString()} bins, ${had.pallets.toLocaleString()} pallets, `
      + `${had.recounts} second counts${backup ? ` · backed up first as ${backup.name}` : ''}`);
    return sendJson(req, res, 200, { ...gone, backup: backup ? backup.name : null, backupError });
  }

  // after a recall notice: where is every case of this lot
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/lot$/)) && method === 'GET') {
    const found = findLot(m[1], url.searchParams.get('q'));
    if (found.lot) audit(actor, 'searched for a lot', `${found.lot} — ${found.counted.length} counted, ${found.expected.length} on the report`, m[1]);
    return sendJson(req, res, 200, found);
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/setup$/)) && method === 'GET') {
    const state = setupState(m[1]);
    if (!state) throw httpError(404, 'session not found');
    return sendJson(req, res, 200, state);
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/settings$/)) && method === 'POST') {
    const body = await readJson(req);
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    const mode = ['off', 'warn', 'strict'].includes(body.palletMode) ? body.palletMode : s.pallet_mode;
    const layout = body.layout === undefined ? s.layout : (body.layout && loadLayout(body.layout) ? body.layout : null);
    // how big a difference has to be before somebody walks back to the bin
    const num = (v, fallback, max) => (v == null || v === '' ? fallback : Math.max(0, Math.min(max, Number(v) || 0)));
    const minQty = num(body.recountMinQty, s.recount_min_qty, 1e6);
    const minPct = num(body.recountMinPct, s.recount_min_pct, 100);
    const cap = num(body.recountCap, s.recount_cap, 1e6);
    // how big an adjustment has to be before somebody has to sign for it
    const apprQty = num(body.approvalMinQty, s.approval_min_qty, 1e6);
    const apprPct = num(body.approvalMinPct, s.approval_min_pct, 100);
    audit(actor, 'changed session settings', JSON.stringify({ palletMode: mode, guided: body.guided, askComments: body.askComments, layout, autoRecount: body.autoRecount, recount: { minQty, minPct, cap },
      approvals: { on: body.requireApproval, minQty: apprQty, minPct: apprPct }, trackAbc: body.trackAbc }), m[1]);
    db.prepare(`UPDATE sessions SET pallet_mode = ?, guided = ?, ask_comments = ?, layout = ?, auto_recount = ?,
                  recount_min_qty = ?, recount_min_pct = ?, recount_cap = ?,
                  ask_lot = ?, ask_expiry = ?,
                  require_approval = ?, approval_min_qty = ?, approval_min_pct = ?, track_abc = ?,
                  master_version = master_version + 1 WHERE id = ?`)
      .run(mode, body.guided == null ? s.guided : (body.guided ? 1 : 0),
           body.askComments == null ? s.ask_comments : (body.askComments ? 1 : 0), layout,
           body.autoRecount == null ? s.auto_recount : (body.autoRecount ? 1 : 0),
           minQty, minPct, cap,
           body.askLot == null ? s.ask_lot : (body.askLot ? 1 : 0),
           body.askExpiry == null ? s.ask_expiry : (body.askExpiry ? 1 : 0),
           body.requireApproval == null ? s.require_approval : (body.requireApproval ? 1 : 0),
           apprQty, apprPct,
           body.trackAbc == null ? s.track_abc : (body.trackAbc ? 1 : 0), s.id);
    return sendJson(req, res, 200, getSession(m[1]));
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/master$/)) && method === 'POST') {
    const kind = url.searchParams.get('kind') || 'bins';
    const text = await readBody(req);
    const stats = importMaster(m[1], kind, text, { replace: url.searchParams.get('replace') === '1' });
    audit(actor, `uploaded ${kind}`, `${stats.rows} rows, ${stats.skipped} skipped${url.searchParams.get('replace') === '1' ? ', replacing what was there' : ''}`, m[1]);
    return sendJson(req, res, 200, stats);
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/status$/)) && method === 'POST') {
    const body = await readJson(req);
    const status = body.status === 'closed' ? 'closed' : 'open';
    audit(actor, status === 'closed' ? 'closed session' : 'reopened session', '', m[1]);
    db.prepare('UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?')
      .run(status, status === 'closed' ? new Date().toISOString() : null, Number(m[1]));
    return sendJson(req, res, 200, getSession(m[1]));
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/progress$/)) && method === 'GET') {
    return sendJson(req, res, 200, progress(m[1]));
  }

  // --- aisles & blocks
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/aisles$/)) && method === 'GET') {
    return sendJson(req, res, 200, aisleOverview(m[1]));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/aisles\/block$/)) && method === 'POST') {
    const body = await readJson(req);
    const updates = Array.isArray(body) ? body : [body];
    for (const u of updates) {
      if (!norm(u.aisle)) throw httpError(400, 'aisle required');
      setBlock(m[1], u.aisle, u.block);
    }
    return sendJson(req, res, 200, aisleOverview(m[1]));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/aisles\/auto-block$/)) && method === 'POST') {
    const body = await readJson(req);
    return sendJson(req, res, 200, autoBlock(m[1], body.size, body.offset));
  }

  // --- assignments
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/assignments$/)) && method === 'GET') {
    return sendJson(req, res, 200, listAssignments(m[1]));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/assignments$/)) && method === 'POST') {
    const body = await readJson(req);
    const aisles = Array.isArray(body.aisles) ? body.aisles : String(body.aisles || '').split(/[,\s]+/);
    const queued = queueAssignments(m[1], body.team, aisles, body.levels || '', { force: !!body.force });
    audit(actor, body.force ? 'assigned aisles OVERRIDING the equipment check' : 'assigned aisles',
      `team ${body.team}: ${queued.added.join(', ') || 'nothing'} (levels ${body.levels})`, m[1]);
    return sendJson(req, res, 200, queued);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/assignments\/(\d+)$/)) && method === 'POST') {
    const body = await readJson(req);
    audit(actor, `assignment ${body.status}`, `assignment ${m[2]}`, m[1]);
    return sendJson(req, res, 200, setAssignmentStatus(m[1], m[2], body.status));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/assignments\/(\d+)$/)) && method === 'DELETE') {
    audit(actor, 'removed an assignment', `assignment ${m[2]}`, m[1]);
    return sendJson(req, res, 200, deleteAssignment(m[1], m[2]));
  }

  // --- accounts
  if (p === '/api/admin/me' && method === 'GET') {
    const who = currentUser(req, url);
    if (!who) throw httpError(401, 'unauthorized');
    const account = who.username ? getUser(who.username) : null;
    return sendJson(req, res, 200, {
      ...who, mustChange: !!(account && account.must_change),
      accounts: countUsers(), admins: countAdmins(),
      sharedLogin: sharedLoginOn(), sharedLoginHeldOpen: sharedLoginHeldOpen(),
    });
  }
  if (p === '/api/admin/users' && method === 'GET') {
    requireAccountAdmin(req, url);
    return sendJson(req, res, 200, { users: listUsers(), sharedLogin: sharedLoginOn(), sharedLoginHeldOpen: sharedLoginHeldOpen() });
  }
  if (p === '/api/admin/users' && method === 'POST') {
    const me = requireAccountAdmin(req, url);
    const body = await readJson(req);
    const u = createUser(body, me.username || me.name);
    audit(actor, 'created an account', `${u.username} (${u.role})`);
    return sendJson(req, res, 200, u);
  }
  if ((m = p.match(/^\/api\/admin\/users\/([A-Za-z0-9._-]+)$/)) && method === 'POST') {
    requireAccountAdmin(req, url);
    const body = await readJson(req);
    const u = updateUser(m[1], body);
    audit(actor, 'changed an account', `${u.username}: ${Object.keys(body).filter((k) => k !== 'password').join(', ') || 'password'}`);
    return sendJson(req, res, 200, u);
  }
  if ((m = p.match(/^\/api\/admin\/users\/([A-Za-z0-9._-]+)$/)) && method === 'DELETE') {
    requireAccountAdmin(req, url);
    audit(actor, 'deleted an account', m[1]);
    return sendJson(req, res, 200, { deleted: deleteUser(m[1]) });
  }
  if (p === '/api/admin/me/password' && method === 'POST') {
    const who = currentUser(req, url);
    if (!who || !who.username) throw httpError(400, 'sign in with an account to change its password');
    const body = await readJson(req);
    const updated = changeOwnPassword(who.username, body.current, body.next);
    audit(actor, 'changed their own password', who.username);
    return sendJson(req, res, 200, { ok: true, ...updated });
  }

  // --- roster: employees, teams, equipment
  if (p === '/api/admin/people' && method === 'GET') {
    return sendJson(req, res, 200, { employees: listEmployees(), teams: listTeams(), config: getConfig() });
  }
  if (p === '/api/admin/people/employees' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(req, res, 200, upsertEmployee(body));
  }
  if (p === '/api/admin/people/employees/import' && method === 'POST') {
    const text = await readBody(req);
    const st = importEmployees(text, { replace: url.searchParams.get('replace') === '1' });
    audit(actor, 'uploaded the crew list', `${st.imported} of ${st.rows} rows${url.searchParams.get('replace') === '1' ? ', replacing the list' : ''}`);
    return sendJson(req, res, 200, st);
  }
  if ((m = p.match(/^\/api\/admin\/people\/employees\/([^/]+)$/)) && method === 'DELETE') {
    return sendJson(req, res, 200, { deleted: deleteEmployee(decodeURIComponent(m[1])) });
  }
  if (p === '/api/admin/people/teams' && method === 'POST') {
    const body = await readJson(req);
    const team = createTeam(body);
    audit(actor, 'created a team', team.name);
    return sendJson(req, res, 200, team);
  }
  if ((m = p.match(/^\/api\/admin\/people\/teams\/(\d+)$/)) && method === 'DELETE') {
    audit(actor, 'deleted a team', `team ${m[1]}`);
    return sendJson(req, res, 200, { deleted: deleteTeam(m[1]) });
  }
  if (p === '/api/admin/people/assign' && method === 'POST') {
    const body = await readJson(req);
    audit(actor, 'moved someone between teams', `${body.badge} -> ${body.teamId ? 'team ' + body.teamId : 'no team'}`);
    return sendJson(req, res, 200, { teams: assignMember(body.badge, body.teamId ?? null) });
  }
  if (p === '/api/admin/people/equipment' && method === 'POST') {
    const body = await readJson(req);
    audit(actor, 'changed the equipment rules', JSON.stringify(body.levelRules || []));
    return sendJson(req, res, 200, setConfig(body));
  }
  if (p === '/api/admin/people/export/employees.csv') {
    const rows = listEmployees().map((e) => ({ ...e, equipment: e.equipment.join('; '), team: e.team || '' }));
    return sendCsv(req, res, 'employees.csv', toCsv(rows, ['badge', 'name', 'dept', 'equipment', 'reach', 'team', 'active']));
  }

  // --- the file that goes back into the ERP
  if (p === '/api/admin/erp/formats' && method === 'GET') {
    return sendJson(req, res, 200, { formats: listFormats(), fields: availableFields() });
  }
  if (p === '/api/admin/erp/formats' && method === 'POST') {
    const body = await readJson(req);
    audit(actor, 'saved an ERP export format', String(body.id || ''));
    return sendJson(req, res, 200, { formats: saveFormat(body.id, body) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/erp\/([a-z0-9-]+)\.csv$/))) {
    const built = buildExport(m[1], m[2]);
    audit(actor, 'exported to the ERP',
      `${m[2]}: ${built.rows} rows${built.held ? `, ${built.held} held back waiting for approval` : ''}`, m[1]);
    return sendCsv(req, res, `${m[2]}-session-${m[1]}-${localDate()}.csv`, built.csv);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/erp\/([a-z0-9-]+)\/preview$/)) && method === 'GET') {
    const built = buildExport(m[1], m[2]);
    return sendJson(req, res, 200, { rows: built.rows, held: built.held || 0, format: built.format, sample: built.csv.split('\r\n').slice(0, 6).join('\n') });
  }

  // --- paper, for when the scanners are not an option
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/print\/count-sheet$/))) {
    const q = url.searchParams;
    const html = countSheet(m[1], {
      aisle: q.get('aisle') || '', levels: q.get('levels') || '', batch: q.get('batch') || '',
      onlyUncounted: q.get('uncounted') === '1', blind: q.get('blind') !== '0',
    });
    audit(actor, 'printed a count sheet', [...q].map(([k, v]) => `${k}=${v}`).join(' ') || 'whole site', m[1]);
    return send(req, res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
  }

  /* --- the test book: real Code 128 labels to practise on, either from this
         count's own bins and pallets or from a sheet somebody filled in */
  if (p === '/api/admin/print/barcode-book') {
    const q = url.searchParams;
    const kind = (q.get('kind') || 'lines').toLowerCase();
    const limit = Math.max(1, Math.min(600, Number(q.get('limit')) || 40));
    const qtyBarcode = q.get('qty') === '1';
    let rows = [];
    let note = '';
    if (method === 'POST') {
      /* A spreadsheet the site filled in: whatever codes they want to practise
         on, which need not exist in any count. */
      const body = await readJson(req);
      rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 600).map((r) => ({
        bin: String(r.bin ?? '').trim(),
        pallet: String(r.pallet ?? '').trim(),
        qty: r.qty === undefined || r.qty === null || r.qty === '' ? '' : String(r.qty).trim(),
        note: String(r.note ?? '').trim().slice(0, 60),
      })).filter((r) => r.bin || r.pallet);
      note = 'from an uploaded sheet';
    } else {
      const id = Number(q.get('session') || 0);
      if (!getSession(id)) throw httpError(404, 'pick a count first');
      const aisle = norm(q.get('aisle') || '');
      if (kind === 'bins') {
        /* Bins on their own: a rack walk, with nothing in the other columns to
           read off - which is the point when practising empty bins. */
        rows = db.prepare(
          `SELECT code, COALESCE(zone, '') AS zone, COALESCE(aisle, '') AS aisle, COALESCE(level, '') AS level
             FROM locations WHERE session_id = ?${aisle ? ' AND aisle = ?' : ''}
            ORDER BY aisle, code LIMIT ?`
        ).all(...(aisle ? [id, aisle, limit] : [id, limit]))
          .map((r) => ({ bin: r.code, pallet: '', qty: '', note: [r.zone, r.level && 'level ' + r.level].filter(Boolean).join(' · ') }));
        note = `bins from count #${id}${aisle ? ', aisle ' + aisle : ''}`;
      } else {
        /* One row per pallet, in bin order: bin, the pallet in it, and what the
           report says is on it - the three things a counter handles per line. */
        rows = db.prepare(
          `SELECT p.pallet_id, COALESCE(p.expected_location, '') AS bin, p.expected_qty,
                  COALESCE(p.sku, '') AS sku, COALESCE(p.uom, '') AS uom
             FROM pallets p
             LEFT JOIN locations l ON l.session_id = p.session_id AND l.code = p.expected_location
            WHERE p.session_id = ?${aisle ? ' AND l.aisle = ?' : ''}
            ORDER BY p.expected_location, p.pallet_id LIMIT ?`
        ).all(...(aisle ? [id, aisle, limit] : [id, limit]))
          .map((r) => ({
            bin: r.bin, pallet: r.pallet_id,
            qty: r.expected_qty == null ? '' : String(r.expected_qty),
            note: [r.sku, r.uom].filter(Boolean).join(' '),
          }));
        note = `pallets from count #${id}${aisle ? ', aisle ' + aisle : ''}`;
      }
    }
    audit(actor, 'printed a barcode test book', `${rows.length} line(s) ${note}`);
    return send(req, res, 200, barcodeBook(rows, { title: 'Barcode test book', note, qtyBarcode }),
      { 'content-type': 'text/html; charset=utf-8' });
  }

  // --- how the counting screen is put together
  if (p === '/api/admin/scanner-layout' && method === 'GET') {
    return sendJson(req, res, 200, { ...scannerLayout(), defaults: defaultScannerLayout() });
  }
  if (p === '/api/admin/scanner-layout' && method === 'POST') {
    const body = await readJson(req);
    const saved = saveScannerLayout(body);
    audit(actor, 'changed the scanner screen layout',
      `${saved.order.join(' → ')}${saved.textSize === 'large' ? ', large text' : ''}${saved.showContents ? '' : ', contents hidden'}${saved.showNextBin ? '' : ', bin guide off'}`);
    return sendJson(req, res, 200, saved);
  }

  // --- which count the scanners land on
  if (p === '/api/admin/default-session' && method === 'GET') {
    return sendJson(req, res, 200, { sessionId: defaultSessionId() });
  }
  if (p === '/api/admin/default-session' && method === 'POST') {
    const body = await readJson(req);
    const id = setDefaultSessionId(body.sessionId);
    const s = id ? getSession(id) : null;
    audit(actor, 'set the default count for scanners', s ? `#${s.id} "${s.name}"` : 'none - scanners choose for themselves', id || null);
    return sendJson(req, res, 200, { sessionId: id });
  }

  // --- what the gun offers as one-tap reasons
  if (p === '/api/admin/scanner-prompts' && method === 'GET') {
    return sendJson(req, res, 200, { ...scannerPrompts(), defaults: defaultScannerPrompts() });
  }
  if (p === '/api/admin/scanner-prompts' && method === 'POST') {
    const body = await readJson(req);
    const saved = saveScannerPrompts(body);
    audit(actor, 'changed the scanner reasons',
      `${saved.comments.length} comment(s), ${saved.overrides.length} override reason(s), comments move on after ${saved.commentTimeout || 'never'}${saved.commentTimeout ? 's' : ''}`);
    return sendJson(req, res, 200, saved);
  }

  // --- setup cards: one QR per scanner, to cut up and tape to the cradles
  if (p === '/api/admin/print/scanner-cards') {
    const only = (url.searchParams.get('only') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const all = listDevices();
    const chosen = only.length ? all.filter((d) => only.includes(d.uid) || only.includes(d.name)) : all;
    const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`;
    audit(actor, 'printed scanner setup cards', `${chosen.length} scanner(s)`);
    return send(req, res, 200, scannerCards(chosen, origin), { 'content-type': 'text/html; charset=utf-8' });
  }

  // --- housekeeping: the log, and copies of the database
  if (p === '/api/admin/audit' && method === 'GET') {
    return sendJson(req, res, 200, listAudit({
      limit: url.searchParams.get('limit'), sessionId: url.searchParams.get('session'),
      actor: url.searchParams.get('actor'), action: url.searchParams.get('action'),
    }));
  }
  if (p === '/api/admin/audit/export.csv') {
    return sendCsv(req, res, 'audit-log.csv', toCsv(listAudit({ limit: 5000 }), ['at', 'actor', 'action', 'detail', 'session_id']));
  }
  if (p === '/api/admin/backups' && method === 'GET') {
    return sendJson(req, res, 200, { backups: listBackups(), keep: Number(process.env.BACKUP_KEEP || 14) });
  }
  if (p === '/api/admin/backups' && method === 'POST') {
    const b = makeBackup('manual');
    audit(actor, 'took a backup', `${b.name} (${Math.round(b.bytes / 1024)} KB)`);
    return sendJson(req, res, 200, b);
  }
  if ((m = p.match(/^\/api\/admin\/backups\/([A-Za-z0-9_.-]+\.db)$/)) && method === 'GET') {
    const full = backupPath(m[1]);
    if (!full) throw httpError(400, 'bad backup name');
    audit(actor, 'downloaded a backup', m[1]);
    const body = await readFile(full).catch(() => { throw httpError(404, 'no such backup'); });
    return send(req, res, 200, body, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${m[1]}"` });
  }

  // --- cycle counting
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/cycle\/batches$/)) && method === 'GET') {
    return sendJson(req, res, 200, {
      batches: listBatches(m[1]),
      coverage: coverage(m[1], url.searchParams.get('days') || 90),
      strategies: STRATEGIES,
      siteDate: localDate(), siteTimezone: siteTimezone(), siteHour: localHour(),
    });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/cycle\/preview$/)) && method === 'POST') {
    const body = await readJson(req);
    return sendJson(req, res, 200, previewBatch(m[1], body));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/cycle\/batches$/)) && method === 'POST') {
    const body = await readJson(req);
    const made = generateBatch(m[1], body);
    audit(actor, 'generated a cycle batch', `${made.created} bins, ${body.strategy || 'oldest'}, due ${made.batch.due_date}`, m[1]);
    return sendJson(req, res, 200, made);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/cycle\/batches\/(\d+)$/)) && method === 'DELETE') {
    audit(actor, 'removed a cycle batch', `batch ${m[2]}`, m[1]);
    return sendJson(req, res, 200, { deleted: deleteBatch(m[1], m[2]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/cycle\/schedule$/)) && method === 'POST') {
    const body = await readJson(req);
    const plan = body && body.every ? JSON.stringify({
      every: body.every === 'week' ? 'week' : 'day',
      bins: Math.max(1, Math.min(5000, Number(body.bins) || 40)),
      strategy: STRATEGIES[body.strategy] ? body.strategy : 'oldest',
      hour: Math.max(0, Math.min(23, Number(body.hour ?? 6))),
      weekday: Number(body.weekday ?? 1),
      weekdays: Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [1, 2, 3, 4, 5],
      zone: body.zone || '', aisle: body.aisle || '', levels: body.levels || '',
    }) : null;
    audit(actor, plan ? 'set the cycle schedule' : 'turned the cycle schedule off', plan || '', m[1]);
    db.prepare('UPDATE sessions SET cycle_schedule = ? WHERE id = ?').run(plan, Number(m[1]));
    return sendJson(req, res, 200, getSession(m[1]));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/cycle\/run-schedule$/)) && method === 'POST') {
    return sendJson(req, res, 200, { generated: runSchedules() });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/coverage\.csv$/))) {
    const rows = db.prepare(
      `SELECT l.aisle, l.code AS bin, l.level, COALESCE(l.zone,'') AS zone, COALESCE(l.last_counted,'') AS last_counted
         FROM locations l WHERE l.session_id = ? ORDER BY COALESCE(l.last_counted,''), l.code`).all(Number(m[1]));
    return sendCsv(req, res, `bin-coverage-session-${m[1]}.csv`, toCsv(rows, ['aisle', 'bin', 'level', 'zone', 'last_counted']));
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/cycle\/open$/)) && method === 'GET') {
    const rows = db.prepare(
      `SELECT r.id, r.bin, r.team, r.status, r.detail, r.batch_id, b.due_date, b.name AS batch,
              l.aisle, l.level, COALESCE(l.zone, '') AS zone
         FROM recounts r
         LEFT JOIN cycle_batches b ON b.id = r.batch_id
         LEFT JOIN locations l ON l.session_id = r.session_id AND l.code = r.bin
        WHERE r.session_id = ? AND r.reason = 'CYCLE' AND r.status != 'done'
        ORDER BY b.due_date, r.bin LIMIT 500`).all(Number(m[1]));
    return sendJson(req, res, 200, rows);
  }

  // --- second counts
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/recounts$/)) && method === 'GET') {
    return sendJson(req, res, 200, listRecounts(m[1]));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/recounts$/)) && method === 'POST') {
    const body = await readJson(req);
    // a manual task names a bin, or a pallet (-> its expected bin, or where it was found)
    let bin = norm(body.bin);
    let palletId = norm(body.palletId) || null;
    if (!bin && palletId) {
      const row = palletReport(m[1], { only: [palletId] })[0];
      bin = row ? (String(row.found_location || '').split(',')[0] || row.expected_location) : '';
      if (!bin) throw httpError(400, `no bin known for pallet ${palletId}`);
    }
    if (!bin) throw httpError(400, 'bin or pallet id required');
    if (!db.prepare('SELECT 1 FROM locations WHERE session_id = ? AND code = ?').get(Number(m[1]), bin)) throw httpError(400, `${bin} is not a bin in this session`);
    audit(actor, 'requested a second count', `${bin}${palletId ? ' / ' + palletId : ''}${body.note ? ' — ' + body.note : ''}`, m[1]);
    return sendJson(req, res, 200, createRecount(m[1], { bin, palletId, reason: 'MANUAL', detail: body.note || '', source: 'manual', team: body.team || null }));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/recounts\/generate$/)) && method === 'POST') {
    const gen = generateFromVariances(m[1]);
    audit(actor, 'raised second counts from the variances',
      `${gen.created} raised from ${gen.considered} pallets`
      + (gen.skippedUnworked ? `, ${gen.skippedUnworked} skipped (aisle not counted yet)` : '')
      + (gen.skippedSmall ? `, ${gen.skippedSmall} under the threshold` : '')
      + (gen.cappedAt ? `, stopped at the cap of ${gen.cappedAt}` : ''), m[1]);
    return sendJson(req, res, 200, gen);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/recounts\/(\d+)$/)) && method === 'POST') {
    const body = await readJson(req);
    audit(actor, 'changed a second count', `#${m[2]} ${JSON.stringify(body)}`, m[1]);
    return sendJson(req, res, 200, updateRecount(m[1], m[2], body));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/recounts\/(\d+)$/)) && method === 'DELETE') {
    audit(actor, 'removed a second count', `#${m[2]}`, m[1]);
    return sendJson(req, res, 200, { deleted: deleteRecount(m[1], m[2]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/recounts\.csv$/))) {
    return sendCsv(req, res, `second-counts-session-${m[1]}.csv`, toCsv(listRecounts(m[1]), [
      'id', 'bin', 'pallet_id', 'reason', 'detail', 'source', 'first_team', 'team', 'status', 'first_result', 'second_result', 'created_at', 'done_at',
    ]));
  }

  // --- messages to the floor
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/messages$/)) && method === 'GET') {
    return sendJson(req, res, 200, { messages: listMessages(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/messages$/)) && method === 'POST') {
    const body = await readJson(req);
    const sent = sendMessage(m[1], { team: body.team, body: body.body, urgent: body.urgent, sentBy: actor });
    audit(actor, 'sent a message to the floor', `${sent.team ? 'team ' + sent.team : 'every team'}: ${sent.body}`, m[1]);
    return sendJson(req, res, 200, sent);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/messages\/(\d+)$/)) && method === 'DELETE') {
    audit(actor, 'took a message off the scanners', `message ${m[2]}`, m[1]);
    return sendJson(req, res, 200, clearMessage(m[1], m[2]));
  }

  /* --- one box that finds anything: pallets, bins, lots, aisles, crew,
         scanners, counts, second counts, adjustments, messages and the log */
  if (p === '/api/admin/search' && method === 'GET') {
    return sendJson(req, res, 200, searchAll(url.searchParams.get('session') || 0, url.searchParams.get('q') || ''));
  }

  // --- a line on the office board: when lunch is, which dock is blocked
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/note$/)) && method === 'POST') {
    const body = await readJson(req);
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    const note = String(body.note == null ? '' : body.note).replace(/\s+/g, ' ').trim().slice(0, 300);
    db.prepare('UPDATE sessions SET board_note = ?, board_note_by = ?, board_note_at = ? WHERE id = ?')
      .run(note || null, note ? actor : null, note ? new Date().toISOString() : null, s.id);
    audit(actor, note ? 'put a note on the board' : 'cleared the board note', note, m[1]);
    return sendJson(req, res, 200, { note, noteBy: note ? actor : '', noteAt: note ? new Date().toISOString() : '' });
  }

  // --- approvals on adjustments
  if (p === '/api/admin/adjustment-reasons' && method === 'GET') {
    return sendJson(req, res, 200, adjustmentReasons());
  }
  if (p === '/api/admin/adjustment-reasons' && method === 'POST') {
    const body = await readJson(req);
    const saved = saveAdjustmentReasons(body.reasons);
    audit(actor, 'changed the adjustment reasons', saved.reasons.join(' | '));
    return sendJson(req, res, 200, saved);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/adjustments$/)) && method === 'GET') {
    return sendJson(req, res, 200, listAdjustments(m[1], { status: url.searchParams.get('status') || '' }));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/adjustments\/decide$/)) && method === 'POST') {
    const body = await readJson(req);
    const done = decideAdjustments(m[1], { ...body, actor });
    audit(actor, done.status === 'rejected' ? 'rejected adjustments' : 'approved adjustments',
      `${done.decided} pallet(s): ${done.reason}${body.note ? ' - ' + String(body.note).slice(0, 200) : ''}`, m[1]);
    return sendJson(req, res, 200, done);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/adjustments\.csv$/))) {
    const rows = listAdjustments(m[1], { limit: 2000 }).adjustments;
    return sendCsv(req, res, `adjustments-session-${m[1]}.csv`, toCsv(rows, [
      'pallet_id', 'sku', 'location', 'kind', 'expected_qty', 'counted_qty', 'variance_qty',
      'status', 'reason', 'note', 'decided_by', 'decided_at',
    ]));
  }

  // --- ABC classes and the accuracy scorecard
  if (p === '/api/admin/accuracy-targets' && method === 'GET') {
    return sendJson(req, res, 200, accuracyTargets());
  }
  if (p === '/api/admin/accuracy-targets' && method === 'POST') {
    const body = await readJson(req);
    const saved = saveAccuracyTargets(body.targets || body);
    audit(actor, 'changed the accuracy targets', JSON.stringify(saved.targets));
    return sendJson(req, res, 200, saved);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/accuracy$/)) && method === 'GET') {
    return sendJson(req, res, 200, accuracy(m[1]));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/abc\/derive$/)) && method === 'POST') {
    const body = await readJson(req);
    const out = deriveAbc(m[1], { force: !!body.force });
    audit(actor, 'worked out ABC classes from the report',
      `${out.classified} pallets classified (A ${out.byClass.A}, B ${out.byClass.B}, C ${out.byClass.C})`, m[1]);
    return sendJson(req, res, 200, out);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/accuracy\.csv$/))) {
    return sendCsv(req, res, `accuracy-session-${m[1]}.csv`, accuracyCsv(m[1]));
  }

  // --- labels that would not scan
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/labels$/)) && method === 'GET') {
    return sendJson(req, res, 200, { labels: labelsToReplace(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/labels\.csv$/))) {
    return sendCsv(req, res, `labels-to-replace-session-${m[1]}.csv`, toCsv(labelsToReplace(m[1]), [
      'what', 'location_code', 'aisle', 'pallet_id', 'issue', 'sku', 'description', 'qty', 'team', 'device_id', 'comments', 'scanned_at',
    ]));
  }

  // --- reports
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/pallets$/)) && method === 'GET') {
    let rows = palletReport(m[1]);
    /* A pallet with the right count of the wrong lot, or one that is out of
       date, is an exception too - the quantity being right does not make it
       something a supervisor can ignore. */
    if (url.searchParams.get('only') === 'exceptions') {
      rows = rows.filter(
        (r) => r.status !== 'MATCH' ||
          (r.lot_status && r.lot_status !== 'LOT MATCH') ||
          r.expiry_status === 'EXPIRED' || r.expiry_status === 'EXPIRES SOON'
      );
    }
    const limit = Number(url.searchParams.get('limit') || 500);
    return sendJson(req, res, 200, { total: rows.length, rows: rows.slice(0, limit) });
  }
  if (p === '/api/admin/layouts' && method === 'GET') return sendJson(req, res, 200, listLayouts());

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/aisles\/apply-layout$/)) && method === 'POST') {
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    const layout = loadLayout(s.layout);
    if (!layout) throw httpError(400, 'pick a layout drawing in the session settings first');
    const pruned = pruneAreaAisles(m[1], layout);
    return sendJson(req, res, 200, { ...applyLayoutBlocks(m[1], layout), pruned });
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/map$/)) && method === 'GET') {
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    return sendJson(req, res, 200, { ...mapData(m[1]), layout: loadLayout(s.layout) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/uncounted$/)) && method === 'GET') {
    return sendJson(req, res, 200, uncountedBins(m[1]));
  }

  const COUNT_COLS = [
    'id', 'pallet_id', 'qty', 'location_code', 'aisle', 'sku', 'description', 'lot', 'expiry', 'alias_of', 'comments',
    'team', 'employees', 'device_id', 'unknown_pallet', 'unknown_location', 'off_assignment',
    'duplicate_pallet', 'empty_bin', 'label_issue', 'bin_label_issue', 'pass', 'recount_id', 'override_reason', 'voided', 'scanned_at', 'received_at',
  ];
  const PALLET_COLS = [
    'pallet_id', 'sku', 'description', 'uom', 'expected_qty', 'counted_qty', 'variance_qty',
    'expected_location', 'found_location', 'times_counted', 'teams', 'comments', 'last_scan', 'status',
    'recounted', 'first_count_qty', 'open_recounts',
    'expected_lot', 'found_lot', 'lot_status', 'expiry', 'expiry_status', 'alias_of', 'also_tagged',
  ];
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/counts\.csv$/))) {
    return sendCsv(req, res, `counts-session-${m[1]}.csv`, toCsv(rawCounts(m[1]), COUNT_COLS));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/exceptions\.csv$/))) {
    return sendCsv(req, res, `exceptions-session-${m[1]}.csv`, toCsv(exceptions(m[1]), COUNT_COLS));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/pallets\.csv$/))) {
    return sendCsv(req, res, `pallets-session-${m[1]}.csv`, toCsv(palletReport(m[1]), PALLET_COLS));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/uncounted\.csv$/))) {
    return sendCsv(req, res, `uncounted-bins-session-${m[1]}.csv`, toCsv(uncountedBins(m[1]), ['aisle', 'code', 'zone']));
  }

  throw httpError(404, 'unknown admin endpoint');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') {
      return sendJson(req, res, 200, {
        ok: true, time: new Date().toISOString(), siteDate: localDate(), siteTimezone: siteTimezone(),
        // what the handhelds check themselves against - see appBuild above
        build: appBuild.version, shell: appBuild.files,
      });
    }
    // The office board is deliberately open: it goes on a screen nobody signs in,
    // and it carries progress only - no pallet IDs, no clock in numbers, no controls.
    if (p === '/api/board' && req.method === 'GET') {
      return sendJson(req, res, 200, boardData(url.searchParams.get('session')));
    }
    if (p.startsWith('/api/admin/')) return await handleAdmin(req, res, url, null);
    if (p.startsWith('/api/')) {
      const handled = await handleHandheld(req, res, url, null);
      if (handled === false) throw httpError(404, 'unknown endpoint');
      return handled;
    }
    return await serveStatic(req, res, p);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    // a code lets the gun tell "your scanner was pulled" from "the Wi-Fi died"
    return sendJson(req, res, status, err.code ? { error: err.message, code: err.code } : { error: err.message || 'server error' });
  }
});

// Scheduled cycle batches. Checked every 15 minutes; generation is keyed on the
// due date, so a restart or a missed window cannot produce two batches for a day.
setInterval(() => {
  try { runSchedules(); } catch (err) { console.warn('[cycle] schedule check failed:', err.message); }
}, 15 * 60 * 1000).unref();

// a copy of the database, once a day, kept for BACKUP_KEEP days
startBackupSchedule().unref();

server.listen(PORT, HOST, () => {
  console.log(`physical-inv-app listening on http://${HOST}:${PORT}`);
  console.log(`  site clock: ${siteTimezone()} - today is ${localDate()}, hour ${localHour()}`);
  console.log(`  scanner:   http://<server-ip>:${PORT}/`);
  console.log(`  dashboard: http://<server-ip>:${PORT}/admin`);
  console.log(`  office board: http://<server-ip>:${PORT}/board`);

  /* Seed the superadmin before reporting the state, so the two agree. Never with
     the default password: that would put a live admin account behind a password
     published in this repo's README. */
  if (SUPERADMIN_USER) {
    if (SUPERADMIN_PASSWORD === 'changeme') {
      console.warn(`[warn] SUPERADMIN_USER=${SUPERADMIN_USER} not created: its password would be "changeme".`);
      console.warn('       Set SUPERADMIN_PASSWORD (or ADMIN_PASSWORD) to something real and restart.');
    } else {
      try {
        const seeded = ensureSuperadmin({ username: SUPERADMIN_USER, name: SUPERADMIN_NAME, password: SUPERADMIN_PASSWORD });
        if (seeded.status === 'created') {
          console.log(`  superadmin: created ${seeded.username} - sign in with it and change its password`);
          audit('startup', 'created the superadmin account', `${seeded.username} from SUPERADMIN_USER`);
        } else if (seeded.status === 'already there') {
          console.log(`  superadmin: ${seeded.username} already exists, left untouched${seeded.note ? ' - ' + seeded.note : ''}`);
        } else if (seeded.status === 'refused') {
          console.warn(`[warn] SUPERADMIN_USER=${SUPERADMIN_USER} not created: ${seeded.why}`);
        }
      } catch (err) {
        // a bad value here must never stop the app coming up
        console.warn(`[warn] could not create SUPERADMIN_USER=${SUPERADMIN_USER}: ${err.message}`);
      }
    }
  }

  /* Settings that changed shape between versions, moved once on the way up. */
  try {
    const moved = migrateCommentTimeout();
    if (moved.moved) {
      console.log(`  comments step: moved from ${moved.from}s to ${moved.to}s (the new default) - change it under Settings → Scanner screen`);
      audit('startup', 'changed the scanner reasons', `comments step moved from ${moved.from}s to ${moved.to}s on upgrade`);
    }
  } catch (err) {
    console.warn(`[warn] could not move the comments timeout: ${err.message}`);
  }

  // Say plainly how somebody signs in, because getting this wrong locks people out.
  const admins = countAdmins();
  console.log(`  sign-in:   ${admins} admin account(s), ${countUsers()} login(s) in total`);
  if (sharedLoginHeldOpen()) {
    console.warn('[warn] SHARED_PASSWORD_LOGIN=off, but there is no admin account yet, so the');
    console.warn('       shared password is STILL ACCEPTED - turning it off now would leave');
    console.warn('       nobody able to sign in. Sign in with it, add an admin under');
    console.warn('       Settings -> Logins, and the setting takes effect on its own.');
  } else if (!SHARED_LOGIN_WANTED) {
    console.log('  shared password: off - everyone signs in with their own login');
  } else if (admins) {
    console.log('  shared password: ON - set SHARED_PASSWORD_LOGIN=off now that admins exist');
  } else {
    console.log('  shared password: ON - the only way in until you add an admin login');
  }
});
