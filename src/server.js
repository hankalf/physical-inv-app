import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  db, listSessions, getSession, createSession, publicSession, masterPayload,
  saveCounts, countedPallets, recordSignon, norm,
} from './db.js';
import { importMaster } from './routes/master.js';
import {
  aisleOverview, listAssignments, setBlock, autoBlock, queueAssignments,
  setAssignmentStatus, deleteAssignment, teamStatus,
} from './routes/assignments.js';
import { progress, palletReport, uncountedBins, rawCounts, exceptions, mapData } from './routes/reports.js';
import { toCsv } from './util/csv.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MAX_BODY = Number(process.env.MAX_UPLOAD_MB || 64) * 1024 * 1024;

if (ADMIN_PASSWORD === 'changeme') {
  console.warn('[warn] ADMIN_PASSWORD is unset - the dashboard password is "changeme".');
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

function send(req, res, status, body, headers = {}) {
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const h = { 'cache-control': 'no-store', ...headers };
  const accepts = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (accepts && payload.length > 1024 && !h['content-encoding']) {
    payload = gzipSync(payload);
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

const adminTokens = new Set();

function passwordMatches(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!adminTokens.has(token)) throw httpError(401, 'unauthorized');
}

/* ------------------------------------------------------------ static */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html'
    : /^\/admin\/?$/.test(pathname) ? '/admin.html'
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

function openSession(id) {
  const s = getSession(id);
  if (!s) throw httpError(404, 'session not found');
  if (s.status !== 'open') throw httpError(409, 'session is closed');
  return s;
}

async function handleHandheld(req, res, url, m) {
  const method = req.method;
  const p = url.pathname;

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
    return sendJson(req, res, 200, teamStatus(m[1], body.team));
  }

  if ((m = p.match(/^\/api\/sessions\/(\d+)\/team-status$/)) && method === 'GET') {
    if (!getSession(m[1])) throw httpError(404, 'session not found');
    return sendJson(req, res, 200, teamStatus(m[1], url.searchParams.get('team') || ''));
  }

  // A team declares an aisle finished from the handheld; the block frees up.
  if ((m = p.match(/^\/api\/sessions\/(\d+)\/assignments\/(\d+)\/complete$/)) && method === 'POST') {
    openSession(m[1]);
    const body = await readJson(req);
    const row = db.prepare('SELECT * FROM assignments WHERE id = ? AND session_id = ?').get(Number(m[2]), Number(m[1]));
    if (!row) throw httpError(404, 'assignment not found');
    if (row.team !== norm(body.team)) throw httpError(403, 'that aisle belongs to another team');
    setAssignmentStatus(m[1], m[2], 'done');
    return sendJson(req, res, 200, teamStatus(m[1], body.team));
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
    return sendJson(req, res, 200, saveCounts(m[1], rows));
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
    if (!passwordMatches(body.password)) throw httpError(401, 'bad password');
    const token = randomUUID();
    adminTokens.add(token);
    return sendJson(req, res, 200, { token });
  }

  requireAdmin(req);

  if (p === '/api/admin/sessions' && method === 'GET') return sendJson(req, res, 200, listSessions());

  if (p === '/api/admin/sessions' && method === 'POST') {
    const body = await readJson(req);
    if (!body.name || !String(body.name).trim()) throw httpError(400, 'name required');
    return sendJson(req, res, 200, createSession({
      name: String(body.name).trim(),
      palletMode: body.palletMode,
      guided: body.guided !== false,
      askComments: body.askComments !== false,
    }));
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/settings$/)) && method === 'POST') {
    const body = await readJson(req);
    const s = getSession(m[1]);
    if (!s) throw httpError(404, 'session not found');
    const mode = ['off', 'warn', 'strict'].includes(body.palletMode) ? body.palletMode : s.pallet_mode;
    db.prepare('UPDATE sessions SET pallet_mode = ?, guided = ?, ask_comments = ?, master_version = master_version + 1 WHERE id = ?')
      .run(mode, body.guided == null ? s.guided : (body.guided ? 1 : 0),
           body.askComments == null ? s.ask_comments : (body.askComments ? 1 : 0), s.id);
    return sendJson(req, res, 200, getSession(m[1]));
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/master$/)) && method === 'POST') {
    const kind = url.searchParams.get('kind') || 'bins';
    const text = await readBody(req);
    return sendJson(req, res, 200, importMaster(m[1], kind, text, { replace: url.searchParams.get('replace') === '1' }));
  }

  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/status$/)) && method === 'POST') {
    const body = await readJson(req);
    const status = body.status === 'closed' ? 'closed' : 'open';
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
    return sendJson(req, res, 200, queueAssignments(m[1], body.team, aisles));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/assignments\/(\d+)$/)) && method === 'POST') {
    const body = await readJson(req);
    return sendJson(req, res, 200, setAssignmentStatus(m[1], m[2], body.status));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/assignments\/(\d+)$/)) && method === 'DELETE') {
    return sendJson(req, res, 200, deleteAssignment(m[1], m[2]));
  }

  // --- reports
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/pallets$/)) && method === 'GET') {
    let rows = palletReport(m[1]);
    if (url.searchParams.get('only') === 'exceptions') rows = rows.filter((r) => r.status !== 'MATCH');
    const limit = Number(url.searchParams.get('limit') || 500);
    return sendJson(req, res, 200, { total: rows.length, rows: rows.slice(0, limit) });
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/map$/)) && method === 'GET') {
    return sendJson(req, res, 200, mapData(m[1]));
  }
  if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/uncounted$/)) && method === 'GET') {
    return sendJson(req, res, 200, uncountedBins(m[1]));
  }

  const COUNT_COLS = [
    'id', 'pallet_id', 'qty', 'location_code', 'aisle', 'sku', 'description', 'comments',
    'team', 'employees', 'device_id', 'unknown_pallet', 'unknown_location', 'off_assignment',
    'duplicate_pallet', 'override_reason', 'voided', 'scanned_at', 'received_at',
  ];
  const PALLET_COLS = [
    'pallet_id', 'sku', 'description', 'uom', 'expected_qty', 'counted_qty', 'variance_qty',
    'expected_location', 'found_location', 'times_counted', 'teams', 'comments', 'last_scan', 'status',
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
    if (p === '/api/health') return sendJson(req, res, 200, { ok: true, time: new Date().toISOString() });
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
    return sendJson(req, res, status, { error: err.message || 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`physical-inv-app listening on http://${HOST}:${PORT}`);
  console.log(`  scanner:   http://<server-ip>:${PORT}/`);
  console.log(`  dashboard: http://<server-ip>:${PORT}/admin.html`);
});
