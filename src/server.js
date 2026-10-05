import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  db, listSessions, getSession, createSession, sandboxOf, deleteSession, checkSessionDeletable, sessionContents, lastUsedLayout, publicSession, masterPayload,
  saveCounts, countedPallets, recordSignon, norm,
  listDevices, getDevice, createDevice, updateDevice, deleteDevice, touchDevice,
  enrollDevice, deviceByToken, resetDevice, saveAdminToken, adminTokenInfo, dropAdminToken, dropAdminTokensFor, purgeAdminTokens } from './db.js';
import { importMaster, pruneAreaAisles } from './routes/master.js';
import { boardData } from './routes/board.js';
import { sendMessage, listMessages, messagesFor, ackMessage, clearMessage } from './routes/messages.js';
import { listAdjustments, adjustmentView, decideAdjustments, adjustmentReasons, saveAdjustmentReasons } from './routes/adjustments.js';
import { setupState } from './routes/setup.js';
import { searchAll } from './routes/search.js';
import { importMissing, addMissing, listMissing, missingForGun, markFound, foundByHand, closeMissing, deleteMissing } from './routes/missing.js';
import { raiseIssue, fixIssue, fixList, ISSUE_MENU } from './routes/issues.js';
import { buildMoves, importMoves, listMoves, movesForGun, finishMove, clearOpenMoves, referenceSession } from './routes/moves.js';
import { autoPlan, applyPlan } from './routes/auto-plan.js';
import { endTrial, setTrial } from './routes/trial.js';
import { exportEverything } from './routes/export-all.js';
import { archiveAisle, finalReadiness, finalReport, listArchives, archivePath } from './routes/archive.js';
import { idleConfig, saveIdleConfig, teamClocks, checkIdle, answerIdle, openIdleAlerts, recentIdleAlerts, tellTeamsIdle, idleTick, recordSignoff } from './routes/idle.js';
import { practiceJobs, practiceSession, ensurePractice, resetPractice, practiceDevice, practiceSheet, practiceHistory, practiceReadiness, practiceFromFile, practiceOptions, setPracticeOptions, practiceSandbox, setPracticeSandbox, practiceExport, ownerOf, practiceModes, startPracticeMode, MODE_ACCESS } from './routes/practice.js';
import { branding, saveLogo, clearLogo, saveName } from './routes/branding.js';
import { raiseAlert, tellTeams, listAlerts, seeAlert, closeAlert, alertsForDevice, sosReasons, saveSosReasons, DEFAULT_REASONS } from './routes/alerts.js';
import { teamsConfig, saveTeamsConfig, postToTeams, testCard, alertCard } from './util/teams.js';
import { scannerPrompts, saveScannerPrompts, defaultScannerPrompts, scannerLayout, saveScannerLayout, defaultScannerLayout, defaultSessionId, setDefaultSessionId, migrateCommentTimeout, scannerJobs, saveScannerJobs, JOBS } from './routes/scanner-prompts.js';
import {
  aisleOverview, listAssignments, setBlock, autoBlock, queueAssignments,
  setAssignmentStatus, deleteAssignment, teamStatus, applyLayoutBlocks,
} from './routes/assignments.js';
import { sourcesOf, progress, palletReport, uncountedBins, rawCounts, exceptions, mapData, findLot, labelsToReplace } from './routes/reports.js';
import {
  listRecounts, createRecount, generateFromVariances, autoAfterCounts, autoAfterAisle,
  tasksForTeam, takeRecount, finishRecount, updateRecount, deleteRecount,
} from './routes/recounts.js';
import { generateBatch, previewBatch, binList, listBatches, deleteBatch, coverage, runSchedules, STRATEGIES, levelsOnOpenTasks } from './routes/cycles.js';
import {
  listEmployees, upsertEmployee, deleteEmployee, importEmployees, importHelpers,
  listTeams, createTeam, deleteTeam, setTeamShift, assignMember, getConfig, setConfig, getEmployee,
  crewCheck, crewShortfall,
} from './routes/people.js';

import { toCsv, parseRecords, pick } from './util/csv.js';
import { listLayouts, loadLayout } from './util/layouts.js';
import { siteTimezone, localDate, localHour } from './util/localtime.js';
import { changed, memo } from './cache.js';
import { clientIp, waitFor, noteFailure, noteSuccess, listLocks, unlockLogin, unlockPlace, PER_LOGIN, PER_PLACE } from './routes/login-limit.js';
import { audit, listAudit, makeBackup, listBackups, backupPath, startBackupSchedule } from './routes/admin-ops.js';
import { countSheet, scannerCards, barcodeBook } from './routes/printing.js';
import {
  countUsers, countAdmins, listUsers, createUser, updateUser, deleteUser, authenticate, changeOwnPassword, getUser, ensureSuperadmin,
} from './routes/users.js';
import { routeNeeds, allowed, parseAccess, ACCESS, PROFILES, TABS } from './routes/access.js';
import { listFormats, saveFormat, buildExport, availableFields } from './routes/erp.js';

// people.js parses uploaded rosters with the shared CSV helpers
importHelpers.parseRecords = parseRecords;
importHelpers.pick = pick;

// Scanners authenticate by default. Set SCANNER_AUTH=off only on a network
// where anyone who can reach the server is already trusted.
const SCANNER_AUTH = String(process.env.SCANNER_AUTH || 'required').toLowerCase() !== 'off';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
/* The one login that exists before anyone makes another: the superadmin, set
   in the environment (Railway variables). There is no shared password - every
   person signs in as themselves, and the log names them. ADMIN_PASSWORD is
   still read as the superadmin's password, for deployments set up before. */
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || (SUPERADMIN_PASSWORD ? 'ADMIN' : '');
const SUPERADMIN_NAME = process.env.SUPERADMIN_NAME || '';
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
const SHELL_FILES = ['index.html', 'i18n.js', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js'];
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

/* The name under the icon on a phone's home screen: the site's initials and
   "Office" - "Full Harvest Inventory" is "FH Office" - short enough not to be
   cut off. */
function officeShortName(name) {
  const words = String(name || '').replace(/\s+inventory$/i, '').split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0].toUpperCase()).join('').slice(0, 3);
  return initials ? `${initials} Office` : 'Office';
}

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

function currentUser(req, url) {
  const auth = String(req.headers.authorization || '');
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // a count sheet is opened in a new tab, which cannot carry a header
  if (!token && url && /\/print\//.test(url.pathname)) token = url.searchParams.get('t') || '';
  let t = adminTokens.get(token);
  if (!t && token) {
    // a sign-in from before the last restart: the row remembers it
    const saved = adminTokenInfo(token);
    if (saved) { t = { name: saved.name, username: saved.username }; adminTokens.set(token, t); }
  }
  if (!t) return null;
  /* The role and the access list come from the account every time, not from
     the sign-in: a change an admin makes applies to the next request, and a
     deactivated account is out at once. */
  if (t.username) {
    const acct = getUser(t.username);
    if (!acct || !acct.active) return null;
    return { ...t, role: acct.role, access: acct.role === 'admin' ? null : parseAccess(acct.access) };
  }
  return { ...t, access: null };
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
    : /^\/full\/?$/.test(pathname) ? '/full.html'
    : /^\/settings\/?$/.test(pathname) ? '/settings.html'
    : /^\/board\/?$/.test(pathname) ? '/board.html'
    : /^\/testing\/?$/.test(pathname) ? '/testing.html'
    : /^\/front\/?$/.test(pathname) ? '/front.html'
    : /^\/missing\/?$/.test(pathname) ? '/missing.html'
    : /^\/guide\/?$/.test(pathname) ? '/guide.html'
    : pathname;
  const filePath = join(PUBLIC_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(req, res, 403, 'forbidden');
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    let body = await readFile(filePath);
    const ext = extname(filePath);
    // the installed app carries the site's name, whatever it was renamed to
    if (rel === '/manifest.webmanifest') {
      const b = branding();
      const m = JSON.parse(body.toString('utf8'));
      m.name = b.name;
      m.short_name = b.name.replace(/\s+inventory$/i, '').slice(0, 12) || b.name.slice(0, 12);
      body = Buffer.from(JSON.stringify(m, null, 2));
    }
    // and so does the office side, installed on a phone: "<name> Office"
    if (rel === '/office.webmanifest') {
      const b = branding();
      const m = JSON.parse(body.toString('utf8'));
      m.name = `${b.name} Office`;
      m.short_name = officeShortName(b.name);
      body = Buffer.from(JSON.stringify(m, null, 2));
    }
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
    /* A gun on the floor never sees the Testing tab's practice count, and the
       practice gun sees nothing else - so nobody tests into the live count. */
    const practice = url.searchParams.get('practice') === '1';
    // only the counts a supervisor has ticked "show on the scanners"
    if (!practice) return sendJson(req, res, 200, listSessions('open').filter((s) => !s.practice && s.show_on_guns !== 0).map(publicSession));
    // a test scanner sees its own person's practice count, and only that
    const auth = String(req.headers.authorization || '');
    const me = device || (auth.startsWith('Device ') ? deviceByToken(auth.slice(7)) : null);
    const owner = me && me.practice_owner;
    return sendJson(req, res, 200, listSessions('open').filter((s) => s.practice && owner && s.practice_owner === owner).map(publicSession));
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

  // --- the Not in Location list, for the gun to watch for as it scans
  if (p === '/api/missing' && method === 'GET') return sendJson(req, res, 200, { pallets: missingForGun((device && device.practice_owner) || null) });

  // --- a lost pallet found from the gun's find desk: the bin it is in
  if (p === '/api/missing/found' && method === 'POST') {
    const body = await readJson(req);
    const r = markFound(body.pallet, { bin: body.bin, team: body.team, device: device ? device.name : body.deviceId, sessionId: body.sessionId || null, how: 'found', owner: (device && device.practice_owner) || null });
    if (r) audit(device ? device.name : 'a scanner', 'found a Not in Location pallet', `${r.pallet_id} in ${r.found_bin || '?'}`, body.sessionId || null);
    return sendJson(req, res, 200, r ? { found: true, pallet: r } : { found: false, already: true });
  }
  // --- which jobs the sign-on screen offers; a practice gun always has all of them
  if (p === '/api/scanner-jobs' && method === 'GET') {
    const practice = url.searchParams.get('practice') === '1' || !!(device && device.practice_owner);
    if (!practice) return sendJson(req, res, 200, { jobs: scannerJobs() });
    // a practice gun: the jobs its person ticked in the Testing Suite, every one by default
    const ps = device && device.practice_owner ? practiceSession(device.practice_owner) : null;
    return sendJson(req, res, 200, { jobs: ps ? practiceJobs(ps) : Object.fromEntries(JOBS.map(([k]) => [k, true])) });
  }
  // --- the pallet system's address, for the move desk on the gun
  if (p === '/api/pallet-system' && method === 'GET') {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'palletSystemUrl'").get();
    return sendJson(req, res, 200, { url: row ? row.value : '' });
  }

  // --- the fix list: a problem seen on the floor, reported from the gun
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/issues$/)) && method === 'GET') {
    return sendJson(req, res, 200, { menu: ISSUE_MENU });
  }
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/issues$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    const out = raiseIssue(m[1], { ...body, deviceId: device ? device.name : body.deviceId });
    if (!out.already) audit(out.issue.device_id || 'a scanner', 'reported a problem', `${out.issue.reason}${out.issue.bin ? ' at ' + out.issue.bin : ''}${out.issue.pallet_id ? ' (' + out.issue.pallet_id + ')' : ''}`, m[1]);
    return sendJson(req, res, 200, out);
  }

  // --- pallets to move back: the list by aisle, and each one done or skipped
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/moves$/)) && method === 'GET') {
    return sendJson(req, res, 200, movesForGun(m[1]));
  }
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/moves\/(\d+)\/(done|skip)$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    const out = finishMove(m[1], m[2], { team: body.team, deviceId: device ? device.name : body.deviceId, actualBin: body.actualBin, status: m[3] === 'skip' ? 'skipped' : 'done', reason: body.reason });
    if (!out.already && out.move.status === 'done') markFound(out.move.pallet_id, { bin: out.move.actual_bin, team: body.team, device: device ? device.name : body.deviceId, sessionId: m[1], how: 'moved', owner: (device && device.practice_owner) || null });
    return sendJson(req, res, 200, out);
  }

  /* The crew is done with this scanner: its clock stops, and nobody is told it
     went quiet. Best effort - a gun that signs off with no signal just times out. */
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/signoff$/)) && method === 'POST') {
    const body = await readJson(req);
    return sendJson(req, res, 200, recordSignoff(m[1], { deviceId: device ? device.name : body.deviceId, team: body.team }));
  }

  if ((m = p.match(/^\/api\/sessions\/(\d+)\/signon$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    if (!norm(body.deviceId)) throw httpError(400, 'deviceId required');
    if (!norm(body.team)) throw httpError(400, 'team required');
    /* Nobody signs on with a clock-in number the site does not know. Once a
       crew list is loaded, an unknown number stops the sign-on: see a
       supervisor, who adds the person under Teams & crew. The practice count
       in the Testing Suite is exempt - its numbers are made up. */
    const sess = getSession(m[1]);
    if (sess && !sess.practice && listEmployees().length) {
      const known = crewCheck(Array.isArray(body.employees) ? body.employees : [], body.team);
      if (known.unknown.length) {
        audit(device ? device.name : body.deviceId, 'refused a sign-on: clock-in number not on the crew list', known.unknown.join(', '), m[1]);
        throw Object.assign(httpError(403, `${known.unknown.join(', ')} ${known.unknown.length === 1 ? 'is' : 'are'} not on the crew list — see a supervisor`), { code: 'crew', unknown: known.unknown });
      }
    }
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
    // the aisle is filed the moment it is handed back
    const filed = archiveAisle(m[1], row.aisle, { team: row.team, by: `team ${row.team}` });
    if (filed) audit(`team ${row.team}`, 'aisle filed', `${filed.aisle}: ${filed.lines} lines → ${filed.name}`, m[1]);
    return sendJson(req, res, 200, teamStatus(m[1], body.team));
  }

  /* Messages from the office. The gun asks on its sync tick and puts anything
     live on the screen; acknowledging is what takes it off. */
  /* --- SOS from a handheld: what is wrong, and where they are. The reasons are
         handed out with it so a gun that has just signed on has the site's own
         list without a second call. */
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/alerts$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    const who = device ? device.name : body.deviceId;
    const { alert, already } = raiseAlert(m[1], { ...body, deviceId: who });
    if (!already) {
      audit(who || 'a scanner', 'raised an SOS', `${alert.reason}${alert.detail ? ' - ' + alert.detail : ''}`, m[1]);
      /* The handheld is not kept waiting on Teams: the alert is already on the
         dashboard, and what the channel did is recorded on the row. */
      const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`;
      tellTeams(alert.id, { dashboard: `${origin}/admin` }).catch(() => { /* recorded on the alert */ });
    }
    return sendJson(req, res, 200, { alert, already });
  }
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/alerts$/)) && method === 'GET') {
    if (!getSession(m[1])) throw httpError(404, 'session not found');
    const who = device ? device.name : url.searchParams.get('device') || '';
    // a practice count can have its own list, from the Testing Suite's sandbox
    const own = sandboxOf(getSession(m[1])).sosReasons;
    return sendJson(req, res, 200, { reasons: own || sosReasons().reasons, mine: alertsForDevice(m[1], who) });
  }

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
    /* a pallet on the Not in Location list, scanned anywhere, is found */
    const ok = new Set(result.accepted);
    result.found = [];
    for (const r of rows) {
      if (!ok.has(r.clientId) || r.emptyBin || !r.palletId) continue;
      const f = markFound(r.palletId, { bin: r.location, team: r.team, device: device ? device.name : r.deviceId, sessionId: m[1], how: 'counted', owner: (device && device.practice_owner) || null });
      if (f) { result.found.push({ pallet: f.pallet_id, bin: f.found_bin }); audit(f.found_device || 'a scanner', 'found a pallet from the Not in Location list', `${f.pallet_id} in ${f.found_bin}`, m[1]); }
    }
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

let lastOrigin = '';

const tipsKey = (owner) => `practiceTips:${owner}`;
const tipsSeen = (owner) => !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(tipsKey(owner));

/** Everything the Testing tab draws, for one person. */
function practicePayload(who, owner, s, dev) {
  return {
    owner,
    // their first time: the guide and the tips come up by themselves
    firstTime: !tipsSeen(owner),
    ...practiceSheet(s.id),
    device: { uid: dev.uid, name: dev.name },
    history: practiceHistory(owner),
    ready: practiceReadiness(who, s.id, dev),
    options: practiceOptions(s.id),
    sandbox: practiceSandbox(s),
    // the other jobs a scanner does, each ready to practise on this run
    modes: practiceModes(who, owner, s),
    teamsChannel: teamsConfig().on,
  };
}

async function handleAdmin(req, res, url, m) {
  const method = req.method;
  const p = url.pathname;

  if (p === '/api/admin/login' && method === 'POST') {
    const body = await readJson(req);
    const token = randomUUID();
    // a password with no username is the superadmin's: the one login the site started with
    const username = String(body.username || '').trim() || SUPERADMIN_USER;
    // too many wrong passwords from here: wait it out, whatever is typed now
    const ip = clientIp(req);
    const wait = waitFor(username, ip);
    if (wait) {
      res.setHeader('retry-after', String(Math.ceil(wait / 1000)));
      throw Object.assign(httpError(429, `too many wrong passwords - try again in ${Math.ceil(wait / 60000)} minute${Math.ceil(wait / 60000) === 1 ? '' : 's'}, or ask an admin to unlock it`), { code: 'locked' });
    }
    const user = username ? authenticate(username, body.password) : null;
    if (!user) {
      const locked = noteFailure(username, ip);
      if (locked) audit('sign-in', locked === 'login' ? 'locked a login for 15 minutes' : 'locked an address for 15 minutes',
        locked === 'login' ? `${String(username).toUpperCase()}: ${PER_LOGIN} wrong passwords from ${ip}` : `${PER_PLACE} wrong passwords from ${ip}`);
      throw httpError(401, 'that username and password do not match');
    }
    noteSuccess(username, ip);
    adminTokens.set(token, { name: user.name, username: user.username, role: user.role });
    saveAdminToken(token, { username: user.username, name: user.name });
    audit(user.name, 'signed in', `as ${user.username} (${user.role})`);
    // a starter password gets them in, but only as far as choosing a real one
    return sendJson(req, res, 200, {
      token, name: user.name, username: user.username, role: user.role,
      mustChange: user.mustChange, accounts: countUsers(),
    });
  }

  const actor = requireAdmin(req, url);
  // signing out ends this sign-in on the server too, not only in the browser
  if (p === '/api/admin/logout' && method === 'POST') {
    const token = String(req.headers.authorization || '').slice(7);
    adminTokens.delete(token);
    dropAdminToken(token);
    return sendJson(req, res, 200, { ok: true });
  }
  // the address supervisors reach this on, for the link in a Teams card the timer sends
  lastOrigin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`;

  /* Who may do what, read fresh from the account every time so a change an
     admin makes applies to the next request, not the next sign-in. */
  const whoNow = currentUser(req, url);
  const requireAccess = (key) => {
    if (allowed(whoNow, key)) return;
    throw httpError(403, key === 'admin' ? 'only an admin can change the site\'s settings' : `this login is not able to do that (${key}) - an admin can give it under Settings → Advanced → Supervisor logins`);
  };
  for (const need of routeNeeds(p, method)) requireAccess(need);

  // --- team clocks and stopped-scanning alerts
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/clocks$/)) && method === 'GET') {
    const s = getSession(m[1]);
    if (s && !s.practice && s.status === 'open') {
      const raised = checkIdle(m[1]);
      if (raised.length) tellTeamsIdle(m[1], raised, { dashboard: `${lastOrigin}/admin` }).catch(() => {});
    }
    return sendJson(req, res, 200, {
      clocks: teamClocks(m[1]), open: openIdleAlerts(m[1]), recent: recentIdleAlerts(m[1], 30),
      config: idleConfig(), now: new Date().toISOString(),
    });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/clocks\/(\d+)$/)) && method === 'POST') {
    const body = await readJson(req);
    const a = answerIdle(m[1], m[2], { action: body.action, by: actor });
    audit(actor, 'answered a stopped-scanning alert', `team ${a.team}: ${a.why}`, m[1]);
    return sendJson(req, res, 200, a);
  }
  if (p === '/api/admin/idle-config' && method === 'GET') return sendJson(req, res, 200, idleConfig());
  if (p === '/api/admin/idle-config' && method === 'POST') {
    const cfg = saveIdleConfig(await readJson(req));
    audit(actor, 'changed the stopped-scanning alert', cfg.minutes ? `after ${cfg.minutes} min${cfg.teams ? ', also to Teams' : ''}` : 'off');
    return sendJson(req, res, 200, cfg);
  }

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

  if (p === '/api/admin/sessions' && method === 'GET') {
    // a practice count is its owner's alone, and only the one they are on -
    // except to an admin, who sees every count on the site, practice ones included
    const who = currentUser(req, url);
    const mine = ownerOf(who);
    const admin = who && who.role === 'admin';
    // and a login sees only the kinds of count it may work: cycle counts need the
    // Cycle counts page, full counts any of the pages that work a full count
    const mayCycle = allowed(who, 'cycle');
    const mayFull = ['dashboard', 'full', 'teams', 'front', 'missing'].some((k) => allowed(who, k));
    return sendJson(req, res, 200, listSessions().filter((s) => {
      if (s.practice) { if (!(admin || s.practice_owner === mine) || s.status !== 'open') return false; }
      return (s.mode || 'full') === 'cycle' ? mayCycle : mayFull;
    }));
  }

  // --- the Testing tab: a practice count and a scanner of this supervisor's own
  if (p === '/api/admin/practice' && (method === 'GET' || method === 'POST')) {
    const who = currentUser(req, url);
    const owner = ownerOf(who);
    const s = method === 'POST' ? ensurePractice(owner) : practiceSession(owner);
    if (!s) return sendJson(req, res, 200, { session: null, history: practiceHistory(owner), owner, firstTime: !tipsSeen(owner) });
    const dev = practiceDevice(who);
    return sendJson(req, res, 200, practicePayload(who, owner, s, dev));
  }
  // the sandbox: the gun's prompts and screen settings, for this practice count alone
  if (p === '/api/admin/practice/sandbox' && method === 'POST') {
    const who = currentUser(req, url);
    const owner = ownerOf(who);
    const s = setPracticeSandbox(owner, await readJson(req));
    audit(actor, 'changed the scanner settings in their sandbox', '', s.id);
    return sendJson(req, res, 200, practicePayload(who, owner, s, practiceDevice(who)));
  }
  // the tips have been seen (or are wanted back) - kept with the login, not the browser
  if (p === '/api/admin/practice/tips' && method === 'POST') {
    const owner = ownerOf(currentUser(req, url));
    const body = await readJson(req);
    if (body.seen === false) db.prepare('DELETE FROM settings WHERE key = ?').run(tipsKey(owner));
    else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(tipsKey(owner), new Date().toISOString());
    return sendJson(req, res, 200, { seen: body.seen !== false });
  }
  if (p === '/api/admin/practice/export' && method === 'GET') {
    requireAccess('export');
    return sendJson(req, res, 200, practiceExport(ownerOf(currentUser(req, url))));
  }
  if (p === '/api/admin/practice/reset' && method === 'POST') {
    const who = currentUser(req, url);
    const owner = ownerOf(who);
    const body = await readJson(req);
    const s = resetPractice(owner, { builtIn: !!body.builtIn });
    audit(actor, 'started a new practice run', `now #${s.id}${body.builtIn ? ' on the built-in data' : ''}`, s.id);
    return sendJson(req, res, 200, practicePayload(who, owner, s, practiceDevice(who)));
  }
  /* The other jobs a scanner does - a cycle count, moving pallets back, the
     Not in Location list - set up on this person's practice alone, and only
     the jobs their login may do for real. */
  if (p === '/api/admin/practice/mode' && method === 'POST') {
    const who = currentUser(req, url);
    const owner = ownerOf(who);
    const body = await readJson(req);
    const mode = String(body.mode || '');
    if (!MODE_ACCESS[mode]) throw httpError(400, 'that is not a practice mode');
    requireAccess(MODE_ACCESS[mode]);
    const s = ensurePractice(owner);
    const out = startPracticeMode(owner, mode);
    audit(actor, `set up ${mode === 'cycle' ? 'a practice cycle count' : mode === 'moves' ? 'practice pallet moves' : 'a practice Not in Location list'}`, out.note || '', s.id);
    return sendJson(req, res, 200, practicePayload(who, owner, getSession(s.id), practiceDevice(who)));
  }
  // the features that ship off, switched on for this person's practice count only
  if (p === '/api/admin/practice/options' && method === 'POST') {
    const who = currentUser(req, url);
    const owner = ownerOf(who);
    const body = await readJson(req);
    // a feature this login may not use for real is not offered to practise either
    if (body.requireApproval && !allowed(whoNow, 'approve')) throw httpError(403, 'this login may not approve adjustments, so approvals are not something to try here');
    // working the classes out is asking to try the feature, so it goes on too
    const s = setPracticeOptions(owner, body);
    audit(actor, 'changed the options on their practice count', JSON.stringify(body), s.id);
    return sendJson(req, res, 200, practicePayload(who, owner, getSession(s.id), practiceDevice(who)));
  }
  // a practice run from the person's own Bin / Pallet / Qty file
  if (p === '/api/admin/practice/upload' && method === 'POST') {
    const who = currentUser(req, url);
    const owner = ownerOf(who);
    const s = practiceFromFile(owner, await readBody(req), url.searchParams.get('name') || 'your file');
    audit(actor, 'uploaded their own practice pallets', `now #${s.id}`, s.id);
    return sendJson(req, res, 200, practicePayload(who, owner, s, practiceDevice(who)));
  }

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

  // --- a trial run: on, off, and cleared ready for the real thing
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/trial$/)) && method === 'POST') {
    const body = await readJson(req);
    if (body.end) {
      const out = endTrial(m[1]);
      audit(actor, 'ended the trial run and cleared it', `${out.cleared.lines} lines, ${out.cleared.signons} sign-ons, ${out.cleared.sos} SOS, ${out.cleared.secondCounts} second counts cleared`, m[1]);
      return sendJson(req, res, 200, out);
    }
    const s = setTrial(m[1], !!body.on);
    audit(actor, body.on ? 'made this count a trial run' : 'turned the trial run off (counts kept)', '', m[1]);
    return sendJson(req, res, 200, { session: s });
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/settings$/)) && method === 'POST') {
    const body = await readJson(req);
    requireAccess(Object.keys(body).every((k) => k === 'layout') ? 'assign' : 'admin');
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
      approvals: { on: body.requireApproval, minQty: apprQty, minPct: apprPct }, showOnGuns: body.showOnGuns }), m[1]);
    if (body.showOnGuns != null) db.prepare('UPDATE sessions SET show_on_guns = ? WHERE id = ?').run(body.showOnGuns ? 1 : 0, s.id);
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
    const source = String(url.searchParams.get('source') || '').trim().slice(0, 40);
    const stats = importMaster(m[1], kind, text, { replace: url.searchParams.get('replace') === '1', source });
    audit(actor, `uploaded ${kind}`, `${stats.rows} rows, ${stats.skipped} skipped${source ? `, system ${source}` : ''}${url.searchParams.get('replace') === '1' ? ', replacing what was there' : ''}`, m[1]);
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
    return sendJson(req, res, 200, memo(`progress:${m[1]}`, () => progress(m[1])));
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
  // a staggered plan for every team at once: preview, then apply
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/assignments\/auto$/)) && method === 'POST') {
    const body = await readJson(req);
    if (body.preview) return sendJson(req, res, 200, autoPlan(m[1], body));
    const out = applyPlan(m[1], body);
    audit(actor, 'auto-assigned the aisles', `${out.queued} aisle assignments across ${out.teams.filter((t) => t.aisles.length).length} teams${body.replace ? ', replacing what was queued' : ''}`, m[1]);
    return sendJson(req, res, 200, out);
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
    const out = setAssignmentStatus(m[1], m[2], body.status);
    if (body.status === 'done') {
      const filed = archiveAisle(m[1], out.assignment.aisle, { team: out.assignment.team, by: actor });
      if (filed) audit(actor, 'aisle filed', `${filed.aisle}: ${filed.lines} lines → ${filed.name}`, m[1]);
    }
    return sendJson(req, res, 200, out);
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
      ...who, role: whoNow.role, access: whoNow.access, accessKeys: ACCESS, tabs: TABS, profiles: PROFILES.map(([key, label, list]) => ({ key, label, access: list === undefined ? null : list })), mustChange: !!(account && account.must_change),
      accounts: countUsers(), admins: countAdmins(),
    });
  }
  /* The site admin - the login the site started with - is nobody else's to
     change: another admin cannot reset its password, take its pages or switch
     it off. It can still change its own. */
  const guardSuper = (target, me) => {
    if (SUPERADMIN_USER && norm(target) === norm(SUPERADMIN_USER) && norm(me.username || '') !== norm(SUPERADMIN_USER)) {
      throw httpError(403, "only the site admin can change the site admin's account");
    }
  };
  if (p === '/api/admin/users' && method === 'GET') {
    requireAccountAdmin(req, url);
    return sendJson(req, res, 200, { users: listUsers(), locks: listLocks() });
  }
  // lift a lock that wrong passwords put on a login or an address
  if (p === '/api/admin/login-locks/unlock' && method === 'POST') {
    const me = requireAccountAdmin(req, url);
    const body = await readJson(req);
    if (body.username) guardSuper(body.username, me);
    const n = body.username ? unlockLogin(body.username) : body.ip ? unlockPlace(String(body.ip)) : 0;
    audit(actor, 'lifted a sign-in lock', body.username ? String(body.username).toUpperCase() : String(body.ip || ''));
    return sendJson(req, res, 200, { unlocked: n, locks: listLocks() });
  }
  if (p === '/api/admin/users' && method === 'POST') {
    const me = requireAccountAdmin(req, url);
    const body = await readJson(req);
    const u = createUser(body, me.username || me.name);
    audit(actor, 'created an account', `${u.username} (${u.role})`);
    return sendJson(req, res, 200, u);
  }
  if ((m = p.match(/^\/api\/admin\/users\/([A-Za-z0-9._-]+)$/)) && method === 'POST') {
    const me = requireAccountAdmin(req, url);
    guardSuper(m[1], me);
    const body = await readJson(req);
    const u = updateUser(m[1], body);
    // a login taken away, or a password reset, ends every sign-in that login had
    if (body.password !== undefined) unlockLogin(u.username);
    if (body.active === false || body.password !== undefined) {
      dropAdminTokensFor(u.username);
      for (const [tok, info] of adminTokens) if (info.username === u.username) adminTokens.delete(tok);
    }
    audit(actor, 'changed an account', `${u.username}: ${Object.keys(body).filter((k) => k !== 'password').join(', ') || 'password'}`);
    return sendJson(req, res, 200, u);
  }
  if ((m = p.match(/^\/api\/admin\/users\/([A-Za-z0-9._-]+)$/)) && method === 'DELETE') {
    guardSuper(m[1], requireAccountAdmin(req, url));
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
  if ((m = p.match(/^\/api\/admin\/people\/teams\/(\d+)\/shift$/)) && method === 'POST') {
    const team = setTeamShift(m[1], (await readJson(req)).shift);
    audit(actor, 'set a team\'s shift', `team ${team.name}: ${team.shift ? (team.shift === '1' ? '1st' : '2nd') + ' shift' : 'no shift'}`);
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
    if (getSession(m[1])?.trial) throw httpError(409, 'this count is a trial run - end the trial and count it for real before sending anything to the ERP');
    const source = url.searchParams.has('source') ? url.searchParams.get('source') : null;
    const built = buildExport(m[1], m[2], { source });
    audit(actor, 'exported to the ERP',
      `${m[2]}${source != null ? ` for ${source || 'rows with no system'}` : ''}: ${built.rows} rows${built.held ? `, ${built.held} held back waiting for approval` : ''}`, m[1]);
    const tag = source ? `-${source.replace(/[^A-Za-z0-9]+/g, '-')}` : '';
    return sendCsv(req, res, `${m[2]}${tag}-session-${m[1]}-${localDate()}.csv`, built.csv);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/erp\/([a-z0-9-]+)\/preview$/)) && method === 'GET') {
    const built = buildExport(m[1], m[2], { source: url.searchParams.has('source') ? url.searchParams.get('source') : null });
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
      `${saved.order.join(' → ')}${saved.textSize === 'large' ? ', large text' : ''}${saved.showNextBin ? '' : ', bin guide off'}`);
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
  if (p === '/api/admin/scanner-jobs' && method === 'GET') return sendJson(req, res, 200, { jobs: scannerJobs(), all: JOBS });
  if (p === '/api/admin/scanner-jobs' && method === 'POST') {
    requireAccess('admin');
    const jobs = saveScannerJobs(await readJson(req));
    audit(actor, 'chose which jobs the scanners offer', JOBS.filter(([k]) => jobs[k]).map(([, l]) => l).join(', '));
    return sendJson(req, res, 200, { jobs, all: JOBS });
  }
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
  // --- Not in Location: pallets the system has lost track of
  if (p === '/api/admin/missing' && method === 'GET') return sendJson(req, res, 200, listMissing({ status: url.searchParams.get('status') || '' }));
  if (p === '/api/admin/missing' && method === 'POST') {
    const out = addMissing(await readJson(req));
    audit(actor, 'added a pallet to Not in Location', '', null);
    return sendJson(req, res, 200, out);
  }
  if (p === '/api/admin/missing/import' && method === 'POST') {
    const out = importMissing(await readBody(req), { label: url.searchParams.get('name') || '' });
    audit(actor, 'uploaded a Not in Location list', `${out.added} added, ${out.updated} updated (${out.batch})`);
    return sendJson(req, res, 200, out);
  }
  if (p === '/api/admin/missing.csv' && method === 'GET') {
    const rows = listMissing().rows.map((r) => ({
      Pallet: r.pallet_id, Item: r.sku || '', Description: r.description || '', Qty: r.qty ?? '', UOM: r.uom || '', Lot: r.lot || '',
      'Last known location': r.last_location || '', Note: r.note || '', Status: r.status === 'found' ? 'Found' : r.status === 'closed' ? 'Closed' : 'Missing',
      'Found in': r.found_bin || '', 'Found by': r.found_team ? `team ${r.found_team}` : r.found_device || '', 'Found at': r.found_at || '', How: r.found_how || '',
      'Closed by': r.closed_by || '', Outcome: r.outcome || '', Uploaded: r.created_at, Batch: r.batch || '',
    }));
    return sendCsv(req, res, `not-in-location-${localDate()}.csv`, toCsv(rows, ['Pallet', 'Item', 'Description', 'Qty', 'UOM', 'Lot', 'Last known location', 'Note', 'Status', 'Found in', 'Found by', 'Found at', 'How', 'Closed by', 'Outcome', 'Uploaded', 'Batch']));
  }
  if ((m = p.match(/^\/api\/admin\/missing\/(\d+)\/found$/)) && method === 'POST') {
    const body = await readJson(req);
    const r = foundByHand(m[1], { bin: body.bin, by: actor });
    audit(actor, 'marked a Not in Location pallet found', `${r.pallet_id}${r.found_bin ? ' in ' + r.found_bin : ''}`);
    return sendJson(req, res, 200, r);
  }
  if ((m = p.match(/^\/api\/admin\/missing\/(\d+)\/close$/)) && method === 'POST') {
    const body = await readJson(req);
    const r = closeMissing(m[1], { by: actor, outcome: body.outcome, reopen: !!body.reopen });
    audit(actor, body.reopen ? 'put a pallet back on Not in Location' : 'closed a Not in Location pallet', `${r.pallet_id}${r.outcome ? ': ' + r.outcome : ''}`);
    return sendJson(req, res, 200, r);
  }
  if ((m = p.match(/^\/api\/admin\/missing\/(\d+)$/)) && method === 'DELETE') {
    return sendJson(req, res, 200, { deleted: deleteMissing(m[1]) });
  }

  // --- Front bins: a job on the warehouse, not on a count. The site's bin list
  //     is the newest real count's; the page never asks which.
  /* The pallet system's own web UI, framed under the move desk on Front bins.
     Its address is a site setting; the office side alone sees it. */
  if (p === '/api/admin/pallet-system' && method === 'GET') {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'palletSystemUrl'").get();
    return sendJson(req, res, 200, { url: row ? row.value : '' });
  }
  if (p === '/api/admin/pallet-system' && method === 'POST') {
    const body = await readJson(req);
    const u = String(body.url || '').trim().slice(0, 500);
    if (u && !/^https?:\/\//i.test(u)) throw httpError(400, 'the address has to start with http:// or https://');
    if (u) db.prepare("INSERT INTO settings (key, value) VALUES ('palletSystemUrl', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(u);
    else db.prepare("DELETE FROM settings WHERE key = 'palletSystemUrl'").run();
    audit(actor, u ? 'set the pallet system address' : 'cleared the pallet system address', u);
    return sendJson(req, res, 200, { url: u });
  }
  if (p.startsWith('/api/admin/front/')) {
    const ref = referenceSession();
    const sub = p.slice('/api/admin/front/'.length);
    if (sub === 'status' && method === 'GET') {
      return sendJson(req, res, 200, ref
        ? { ready: true, binList: { from: ref.name, sessionId: ref.id, bins: db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ?').get(ref.id).n, pallets: db.prepare('SELECT COUNT(*) n FROM pallets WHERE session_id = ?').get(ref.id).n } }
        : { ready: false, why: 'no bin list yet - upload one under Settings → Lists & racking (or create a count and upload its bins)' });
    }
    if (!ref) throw httpError(409, 'no bin list yet - upload one under Settings → Lists & racking first');
    // the same routes as a count's, on the site's list
    url.pathname = `/api/admin/sessions/${ref.id}/${sub === 'bins' ? 'cycle/bins' : sub}`;
    return handleAdmin(req, res, url, null);
  }

  // --- pallets to move back
  /* A move finished from the office's desk rather than a gun: the person at the
     desk did it in the pallet system and ticks it off here. */
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/moves\/(\d+)\/(done|skip)$/)) && method === 'POST') {
    const body = await readJson(req);
    const out = finishMove(m[1], m[2], { team: 'desk', deviceId: actor, actualBin: body.actualBin, status: m[3] === 'skip' ? 'skipped' : 'done', reason: body.reason });
    if (!out.already && out.move.status === 'done') markFound(out.move.pallet_id, { bin: out.move.actual_bin, team: 'desk', device: actor, sessionId: m[1], how: 'moved', owner: (getSession(m[1]) || {}).practice_owner || null });
    audit(actor, m[3] === 'skip' ? 'skipped a move from the desk' : 'finished a move from the desk', `${out.move.pallet_id} ${out.move.from_bin} → ${out.move.actual_bin || out.move.to_bin}`, m[1]);
    return sendJson(req, res, 200, out);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/moves$/)) && method === 'GET') {
    return sendJson(req, res, 200, listMoves(m[1], { status: url.searchParams.get('status') || '', aisle: url.searchParams.get('aisle') || '' }));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/moves\.csv$/)) && method === 'GET') {
    const rows = listMoves(m[1]).moves.map((r) => ({
      Pallet: r.pallet_id, 'From bin': r.from_bin, 'To bin': r.to_bin, Aisle: r.aisle, Level: r.level,
      Status: r.status === 'done' ? 'Moved' : r.status === 'skipped' ? 'Skipped' : 'To move', 'Put in': r.actual_bin || '', Reason: r.reason || '',
      Team: r.team || '', Scanner: r.device_id || '', When: r.done_at || '', Source: r.source === 'upload' ? 'Uploaded' : 'From the report',
    }));
    return sendCsv(req, res, `moves-session-${m[1]}.csv`, toCsv(rows, ['Pallet', 'From bin', 'To bin', 'Aisle', 'Level', 'Status', 'Put in', 'Reason', 'Team', 'Scanner', 'When', 'Source']));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/moves\/build$/)) && method === 'POST') {
    const body = await readJson(req);
    const out = buildMoves(m[1], body);
    audit(actor, 'built the move list from the report', `${out.added} pallets to move back${body.aisle ? ' in ' + body.aisle : ''}`, m[1]);
    return sendJson(req, res, 200, out);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/moves\/import$/)) && method === 'POST') {
    const out = importMoves(m[1], await readBody(req), { replace: url.searchParams.get('replace') === '1' });
    audit(actor, 'uploaded a move list', `${out.added} pallets to move back`, m[1]);
    return sendJson(req, res, 200, out);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/moves$/)) && method === 'DELETE') {
    const n = clearOpenMoves(m[1]);
    audit(actor, 'cleared the open moves', `${n} taken off the list`, m[1]);
    return sendJson(req, res, 200, { cleared: n });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/cycle\/bins$/)) && method === 'GET') {
    const q = Object.fromEntries(url.searchParams);
    const list = binList(m[1], q);
    if (q.format === 'csv') {
      return sendCsv(req, res, `${list.face || 'all'}-bins-session-${m[1]}.csv`, toCsv(list.bins.map((b) => ({
        Bin: b.code, Zone: b.zone, Aisle: b.aisle, Level: b.level, Face: b.face ? b.face[0].toUpperCase() + b.face.slice(1) : '',
        'Last counted': b.last_counted ? b.last_counted.slice(0, 10) : 'never', 'Cycle task open': b.open_task ? 'Yes' : 'No',
      })), ['Bin', 'Zone', 'Aisle', 'Level', 'Face', 'Last counted', 'Cycle task open']));
    }
    return sendJson(req, res, 200, list);
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
      face: ['front', 'back'].includes(body.face) ? body.face : '',
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

  /* --- SOS: the list the gun offers, the alerts themselves, and the channel */
  // --- the logo (Settings → Advanced)
  if (p === '/api/admin/logo' && method === 'GET') return sendJson(req, res, 200, branding());
  if (p === '/api/admin/logo' && method === 'POST') {
    const body = await readJson(req);
    const out = saveLogo(body);
    audit(actor, body.dataUrl !== undefined ? (out.logo ? 'uploaded the site logo' : 'removed the site logo') : 'changed where the logo shows',
      out.logo ? `${Math.round(out.logo.length * 0.75 / 1024)} KB · ${out.onGuns ? 'on the guns too' : 'supervisor pages only'}` : '');
    return sendJson(req, res, 200, out);
  }
  // the site's name and place: the sidebar, the splash, the guns, the board, the installed app
  if (p === '/api/admin/site-name' && method === 'POST') {
    requireAccess('admin');
    const body = await readJson(req);
    const out = saveName(body);
    audit(actor, 'renamed the site', `${out.name}${out.place ? ' · ' + out.place : ''}`);
    return sendJson(req, res, 200, out);
  }
  if (p === '/api/admin/logo' && method === 'DELETE') {
    const out = clearLogo();
    audit(actor, 'removed the site logo');
    return sendJson(req, res, 200, out);
  }
  if (p === '/api/admin/sos-reasons' && method === 'GET') {
    return sendJson(req, res, 200, { ...sosReasons(), defaults: DEFAULT_REASONS });
  }
  if (p === '/api/admin/sos-reasons' && method === 'POST') {
    const body = await readJson(req);
    const saved = saveSosReasons(body.reasons);
    audit(actor, 'changed the SOS reasons', saved.reasons.join(' | '));
    return sendJson(req, res, 200, saved);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/alerts$/)) && method === 'GET') {
    return sendJson(req, res, 200, listAlerts(m[1], { status: url.searchParams.get('status') || '' }));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/alerts\/(\d+)\/seen$/)) && method === 'POST') {
    const out = seeAlert(m[1], m[2], actor);
    if (out.seen) audit(actor, 'answered an SOS', out.alert.reason, m[1]);
    return sendJson(req, res, 200, out);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/alerts\/(\d+)\/close$/)) && method === 'POST') {
    const body = await readJson(req);
    const out = closeAlert(m[1], m[2], { who: actor, outcome: body.outcome });
    if (out.closed) {
      audit(actor, 'closed an SOS', `${out.alert.reason}${out.alert.outcome ? ' - ' + out.alert.outcome : ''}`, m[1]);
      /* The channel that was told about it is told it is dealt with, so nobody
         drives over for something that was sorted twenty minutes ago. */
      if (teamsConfig().on && teamsConfig().tellWhenClosed) {
        postToTeams(alertCard(out.alert)).catch(() => { /* the dashboard is the record */ });
      }
    }
    return sendJson(req, res, 200, out);
  }
  if (p === '/api/admin/teams-webhook' && method === 'GET') {
    const cfg = teamsConfig();
    return sendJson(req, res, 200, { on: cfg.on, configured: cfg.configured, masked: cfg.masked, tellWhenClosed: cfg.tellWhenClosed });
  }
  if (p === '/api/admin/teams-webhook' && method === 'POST') {
    const body = await readJson(req);
    const saved = saveTeamsConfig(body);
    audit(actor, 'changed the Teams channel for alerts',
      `${saved.configured ? saved.masked : 'no address'} · ${saved.on ? 'on' : 'off'}`);
    return sendJson(req, res, 200, { on: saved.on, configured: saved.configured, masked: saved.masked, tellWhenClosed: saved.tellWhenClosed });
  }
  if (p === '/api/admin/teams-webhook/test' && method === 'POST') {
    const out = await postToTeams(testCard(actor));
    audit(actor, 'tested the Teams channel', out.sent ? 'accepted' : out.why);
    return sendJson(req, res, 200, out);
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
  /* The notes the office writes for the board: several at once, each one
     changed or taken down on its own. The old single-note call still works:
     text adds a note, nothing clears the board. */
  const noteRows = (sid) => db.prepare('SELECT id, text, by, at, updated_at, updated_by FROM board_notes WHERE session_id = ? ORDER BY id').all(sid);
  const cleanNote = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 300);
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/notes$/)) && method === 'GET') {
    if (!getSession(m[1])) throw httpError(404, 'session not found');
    return sendJson(req, res, 200, { notes: noteRows(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/notes?$/)) && method === 'POST') {
    const body = await readJson(req);
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    const text = cleanNote(body.text != null ? body.text : body.note);
    if (!text) {
      // the old call with an empty box: the board is cleared
      db.prepare('DELETE FROM board_notes WHERE session_id = ?').run(s.id);
      audit(actor, 'cleared the board note', '', m[1]);
      return sendJson(req, res, 200, { note: '', noteBy: '', noteAt: '', notes: [] });
    }
    const at = new Date().toISOString();
    db.prepare('INSERT INTO board_notes (session_id, text, by, at) VALUES (?, ?, ?, ?)').run(s.id, text, actor, at);
    audit(actor, 'put a note on the board', text, m[1]);
    return sendJson(req, res, 200, { note: text, noteBy: actor, noteAt: at, notes: noteRows(s.id) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/notes\/(\d+)$/)) && method === 'POST') {
    const body = await readJson(req);
    const text = cleanNote(body.text);
    if (!text) throw httpError(400, 'a note needs some words - delete it instead');
    const r = db.prepare('UPDATE board_notes SET text = ?, updated_at = ?, updated_by = ? WHERE id = ? AND session_id = ?').run(text, new Date().toISOString(), actor, m[2], m[1]);
    if (!r.changes) throw httpError(404, 'that note is not on the board');
    audit(actor, 'changed a note on the board', text, m[1]);
    return sendJson(req, res, 200, { notes: noteRows(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/notes\/(\d+)$/)) && method === 'DELETE') {
    const r = db.prepare('DELETE FROM board_notes WHERE id = ? AND session_id = ?').run(m[2], m[1]);
    if (!r.changes) throw httpError(404, 'that note is not on the board');
    audit(actor, 'took a note off the board', `#${m[2]}`, m[1]);
    return sendJson(req, res, 200, { notes: noteRows(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/notes$/)) && method === 'DELETE') {
    db.prepare('DELETE FROM board_notes WHERE session_id = ?').run(m[1]);
    audit(actor, 'cleared the board note', '', m[1]);
    return sendJson(req, res, 200, { notes: [] });
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
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/adjustments\/view$/)) && method === 'GET') {
    return sendJson(req, res, 200, adjustmentView(m[1]));
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

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/fixlist$/)) && method === 'GET') {
    return sendJson(req, res, 200, fixList(m[1], { status: url.searchParams.get('status') || '' }));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/issues\/(\d+)\/fix$/)) && method === 'POST') {
    const body = await readJson(req);
    const i = fixIssue(m[1], m[2], { by: actor, outcome: body.outcome, reopen: !!body.reopen });
    audit(actor, body.reopen ? 'reopened a fix-list item' : 'marked a fix-list item fixed', `${i.reason}${i.bin ? ' at ' + i.bin : ''}`, m[1]);
    return sendJson(req, res, 200, i);
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/fixlist\.csv$/))) {
    const KIND = { label: 'Label to replace', damage: 'Damage', blocked: 'Blocked bin', other: 'Other' };
    const rows = fixList(m[1]).rows.map((r) => ({
      Kind: KIND[r.kind] || r.kind, What: r.target ? r.target[0].toUpperCase() + r.target.slice(1) : '', Bin: r.bin || '', Aisle: r.aisle || '', Pallet: r.pallet_id || '',
      Problem: r.reason, Note: r.note || '', 'Reported by team': r.team || '', Scanner: r.device_id || '', Reported: r.created_at || '',
      Status: r.status === 'fixed' ? 'Fixed' : 'Open', 'Fixed by': r.fixed_by || '', 'Fixed at': r.fixed_at || '', Outcome: r.outcome || '',
    }));
    return sendCsv(req, res, `fix-list-session-${m[1]}.csv`, toCsv(rows, ['Kind', 'What', 'Bin', 'Aisle', 'Pallet', 'Problem', 'Note', 'Reported by team', 'Scanner', 'Reported', 'Status', 'Fixed by', 'Fixed at', 'Outcome']));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/labels$/)) && method === 'GET') {
    return sendJson(req, res, 200, { labels: labelsToReplace(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/labels\.csv$/))) {
    return sendCsv(req, res, `labels-to-replace-session-${m[1]}.csv`, toCsv(labelsToReplace(m[1]), [
      'what', 'location_code', 'aisle', 'pallet_id', 'issue', 'sku', 'description', 'qty', 'team', 'device_id', 'comments', 'scanned_at',
    ]));
  }

  // --- reports
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/sources$/)) && method === 'GET') {
    return sendJson(req, res, 200, { sources: sourcesOf(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/pallets$/)) && method === 'GET') {
    /* The Reports tab takes the whole report and filters it on the page; kept
       ready to send, so every screen on the same count between two scans
       shares the one answer - worked out, written out and zipped once. */
    const body = memo(`pallets-out:${m[1]}:${url.search}`, () => {
      let rows = memo(`pallets:${m[1]}`, () => palletReport(m[1]));
      // one system at a time, when three share the warehouse
      if (url.searchParams.has('source')) { const src = url.searchParams.get('source'); rows = rows.filter((r) => (r.source || '') === src); }
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
      return JSON.stringify({ total: rows.length, rows: rows.slice(0, limit) });
    });
    return send(req, res, 200, body, { 'content-type': 'application/json; charset=utf-8' });
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
    return sendJson(req, res, 200, { ...memo(`map:${m[1]}`, () => mapData(m[1])), layout: loadLayout(s.layout) });
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
    'pallet_id', 'source', 'sku', 'description', 'variant', 'uom', 'entry_no', 'expected_qty', 'counted_qty', 'variance_qty',
    'expected_location', 'found_location', 'times_counted', 'teams', 'comments', 'last_scan', 'status',
    'recounted', 'first_count_qty', 'open_recounts',
    'expected_lot', 'found_lot', 'lot_status', 'expiry', 'expiry_status', 'alias_of', 'also_tagged',
  ];
  // --- what has been filed as the count went, and the final report at the end
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/archives$/)) && method === 'GET') {
    return sendJson(req, res, 200, { archives: listArchives(m[1]), readiness: finalReadiness(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/archives\/final$/)) && method === 'POST') {
    const out = finalReport(m[1], { by: actor });
    audit(actor, 'filed the final report', `${out.sheets} sheets → ${out.name}`, m[1]);
    return sendJson(req, res, 200, { ...out, archives: listArchives(m[1]), readiness: finalReadiness(m[1]) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/archives\/file$/)) && method === 'GET') {
    const full = archivePath(m[1], url.searchParams.get('folder') || '', url.searchParams.get('file') || '');
    if (!full) throw httpError(404, 'no such file');
    const body = await readFile(full);
    return send(req, res, 200, body, { 'content-type': full.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${full.split('/').slice(-2).join('-')}"` });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/everything$/)) && method === 'GET') {
    const out = exportEverything(m[1], { by: actor });
    audit(actor, 'exported everything', `${out.sheets.length} sheets`, m[1]);
    return sendJson(req, res, 200, out);
  }
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
  /* a request that can change something makes every kept answer out of date,
     as it starts and again once its writes are done (see cache.js) */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    changed();
    const end = res.end;
    res.end = function (...a) { changed(); return end.apply(this, a); };   // before the answer goes out, so the next read is fresh
    res.once('close', changed);
  }
  try {
    if (p === '/api/health') {
      return sendJson(req, res, 200, {
        ok: true, time: new Date().toISOString(), siteDate: localDate(), siteTimezone: siteTimezone(),
        // what the handhelds check themselves against - see appBuild above
        build: appBuild.version, shell: appBuild.files,
      });
    }
    // The site's logo: on the sign-in page before anybody has signed in, and on
    // every gun, so it is open - it is a picture of the company, nothing more.
    if (p === '/api/branding' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-cache');
      return sendJson(req, res, 200, branding());
    }
    // The office board is deliberately open: it goes on a screen nobody signs in,
    // and it carries progress only - no pallet IDs, no clock in numbers, no controls.
    if (p === '/api/board' && req.method === 'GET') {
      return sendJson(req, res, 200, memo(`board:${url.searchParams.get('session') || ''}`, () => boardData(url.searchParams.get('session'))));
    }
    if (p.startsWith('/api/admin/')) return await handleAdmin(req, res, url, null);
    if (p.startsWith('/api/')) {
      const handled = await handleHandheld(req, res, url, null);
      if (handled === false) throw httpError(404, 'unknown endpoint');
      return handled;
    }
    // The bare address is the office's: it opens the supervisor sign-in. A
    // scanner is opened from its own link (/?d=<uid>) and from then on carries
    // a cookie, so its home-screen icon still lands on the app; so does the
    // Testing Suite's practice gun. Offline, the service worker answers before
    // this is reached.
    if (p === '/' && req.method === 'GET') {
      const isGun = url.searchParams.has('d') || url.searchParams.has('practice') || /(?:^|;\s*)gun=1(?:;|$)/.test(String(req.headers.cookie || ''));
      if (!isGun) {
        res.statusCode = 302;
        res.setHeader('location', '/admin');
        res.setHeader('cache-control', 'no-store');
        return res.end();
      }
      // a real scanner's link marks the browser as a scanner; the practice gun inside the Testing Suite must not
      if (url.searchParams.has('d') && !url.searchParams.has('practice')) res.setHeader('set-cookie', 'gun=1; Path=/; Max-Age=31536000; SameSite=Lax');
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

// Teams that have stopped scanning, checked every minute
setInterval(() => {
  idleTick({ dashboard: lastOrigin ? `${lastOrigin}/admin` : '' }).catch((err) => console.warn('[idle] check failed:', err.message));
}, 60 * 1000).unref();

// a copy of the database, once a day, kept for BACKUP_KEEP days
startBackupSchedule().unref();

server.listen(PORT, HOST, () => {
  console.log(`physical-inv-app listening on http://${HOST}:${PORT}`);
  console.log(`  site clock: ${siteTimezone()} - today is ${localDate()}, hour ${localHour()}`);
  console.log(`  scanner:   http://<server-ip>:${PORT}/`);
  console.log(`  dashboard: http://<server-ip>:${PORT}/admin`);
  console.log(`  office board: http://<server-ip>:${PORT}/board`);

  /* Seed the superadmin before reporting the state, so the two agree. Create
     only: an account already there is never touched, so a password changed in
     the app survives every restart. */
  purgeAdminTokens();
  if (SUPERADMIN_USER) {
    try {
      const seeded = ensureSuperadmin({ username: SUPERADMIN_USER, name: SUPERADMIN_NAME, password: SUPERADMIN_PASSWORD });
      if (seeded.status === 'created') {
        console.log(`  superadmin: created ${seeded.username} - sign in with it and change its password`);
        if (SUPERADMIN_PASSWORD === 'changeme') console.warn('[warn] its password is "changeme" - set SUPERADMIN_PASSWORD to something real and change it in the app');
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
  console.log(`  sign-in:   ${admins} admin account(s), ${countUsers()} login(s) in total - everyone signs in as themselves`);
  if (!admins) {
    console.warn('[warn] there is NO admin account, so nobody can sign in. Set SUPERADMIN_USER and');
    console.warn('       SUPERADMIN_PASSWORD (at least 8 characters) in the environment and restart.');
  }
});
