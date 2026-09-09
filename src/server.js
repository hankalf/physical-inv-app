import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  db, listSessions, getSession, createSession, masterPayload,
  saveCounts, progress, variance, rawCounts,
} from './db.js';
import { importMaster } from './routes/master.js';
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
};

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

// --- admin auth: a bearer token minted from the shared password ------------
const adminTokens = new Set();

function passwordMatches(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const cookie = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (adminTokens.has(token) || (cookie && adminTokens.has(cookie))) return true;
  throw Object.assign(new Error('unauthorized'), { status: 401 });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = join(PUBLIC_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(req, res, 403, 'forbidden');
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    const ext = extname(filePath);
    // The service worker must never be served from a stale cache.
    const cache = rel === '/sw.js' ? 'no-store' : 'no-cache';
    send(req, res, 200, body, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': cache,
    });
  } catch {
    send(req, res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  try {
    // ---------------- public / handheld API ----------------
    if (p === '/api/health') {
      return sendJson(req, res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (p === '/api/sessions' && method === 'GET') {
      const rows = listSessions('open').map((s) => ({
        id: s.id, name: s.name, blind: !!s.blind, requireLpn: !!s.require_lpn,
        allowOverride: !!s.allow_override, masterVersion: s.master_version,
      }));
      return sendJson(req, res, 200, rows);
    }

    let m;
    if ((m = p.match(/^\/api\/sessions\/(\d+)\/master$/)) && method === 'GET') {
      const session = getSession(m[1]);
      if (!session) return sendJson(req, res, 404, { error: 'session not found' });
      // Handhelds send ?have=<version> to skip a re-download they already hold.
      const have = url.searchParams.get('have');
      if (have != null && Number(have) === session.master_version) {
        return sendJson(req, res, 200, { unchanged: true, masterVersion: session.master_version });
      }
      return sendJson(req, res, 200, masterPayload(m[1]));
    }

    if ((m = p.match(/^\/api\/sessions\/(\d+)\/counts$/)) && method === 'POST') {
      const session = getSession(m[1]);
      if (!session) return sendJson(req, res, 404, { error: 'session not found' });
      if (session.status !== 'open') return sendJson(req, res, 409, { error: 'session is closed' });
      const body = await readJson(req);
      const rows = Array.isArray(body) ? body : body.counts;
      if (!Array.isArray(rows)) return sendJson(req, res, 400, { error: 'expected an array of counts' });
      const result = saveCounts(m[1], rows);
      return sendJson(req, res, 200, result);
    }

    // A counter's own recent lines, so a device can show (and correct) its history.
    if ((m = p.match(/^\/api\/sessions\/(\d+)\/recent$/)) && method === 'GET') {
      const counter = url.searchParams.get('counter') || '';
      const rows = db
        .prepare(
          `SELECT client_id, location_code, sku, qty, lpn, scanned_at, voided
             FROM counts WHERE session_id = ? AND counter = ?
            ORDER BY id DESC LIMIT 50`
        )
        .all(Number(m[1]), counter);
      return sendJson(req, res, 200, rows);
    }

    if ((m = p.match(/^\/api\/sessions\/(\d+)\/void$/)) && method === 'POST') {
      const body = await readJson(req);
      if (!body.clientId) return sendJson(req, res, 400, { error: 'clientId required' });
      const info = db
        .prepare('UPDATE counts SET voided = 1 WHERE session_id = ? AND client_id = ?')
        .run(Number(m[1]), String(body.clientId));
      return sendJson(req, res, 200, { voided: info.changes });
    }

    // ---------------- admin ----------------
    if (p === '/api/admin/login' && method === 'POST') {
      const body = await readJson(req);
      if (!passwordMatches(body.password)) return sendJson(req, res, 401, { error: 'bad password' });
      const token = randomUUID();
      adminTokens.add(token);
      return sendJson(req, res, 200, { token }, );
    }

    if (p.startsWith('/api/admin/')) {
      requireAdmin(req);

      if (p === '/api/admin/sessions' && method === 'GET') {
        return sendJson(req, res, 200, listSessions());
      }

      if (p === '/api/admin/sessions' && method === 'POST') {
        const body = await readJson(req);
        if (!body.name || !String(body.name).trim())
          return sendJson(req, res, 400, { error: 'name required' });
        return sendJson(req, res, 200, createSession({
          name: String(body.name).trim(),
          blind: body.blind !== false,
          requireLpn: !!body.requireLpn,
          allowOverride: body.allowOverride !== false,
        }));
      }

      if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/master$/)) && method === 'POST') {
        const kind = url.searchParams.get('kind') || 'onhand';
        if (!['onhand', 'locations', 'items', 'barcodes'].includes(kind))
          return sendJson(req, res, 400, { error: `unknown kind "${kind}"` });
        const text = await readBody(req);
        const stats = importMaster(m[1], kind, text, {
          replace: url.searchParams.get('replace') === '1',
        });
        return sendJson(req, res, 200, stats);
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

      if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/variance$/)) && method === 'GET') {
        const only = url.searchParams.get('only');
        let rows = variance(m[1]);
        if (only === 'variance') rows = rows.filter((r) => r.status !== 'MATCH');
        return sendJson(req, res, 200, rows.slice(0, Number(url.searchParams.get('limit') || 500)));
      }

      if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/counts\.csv$/))) {
        const rows = rawCounts(m[1]);
        return sendCsv(req, res, `counts-session-${m[1]}.csv`, toCsv(rows, [
          'id', 'location_code', 'sku', 'description', 'scanned_barcode', 'lpn', 'qty',
          'counter', 'device', 'pass', 'override_reason', 'unknown_item', 'unknown_location',
          'voided', 'scanned_at', 'received_at',
        ]));
      }

      if ((m = p.match(/^\/api\/admin\/sessions\/(\d+)\/export\/variance\.csv$/))) {
        const rows = variance(m[1]);
        return sendCsv(req, res, `variance-session-${m[1]}.csv`, toCsv(rows, [
          'location_code', 'sku', 'description', 'expected_qty', 'counted_qty',
          'variance_qty', 'status', 'passes',
        ]));
      }

      return sendJson(req, res, 404, { error: 'unknown admin endpoint' });
    }

    if (p.startsWith('/api/')) return sendJson(req, res, 404, { error: 'unknown endpoint' });

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
