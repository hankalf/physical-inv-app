/*
 * Where the sign-ons come from.
 *
 * Every scanner that opens its link or signs a team on, and every login to
 * the office pages, is written down with the network address it came from.
 * Each distinct address is looked up once - country, region, city, the
 * network it belongs to, and a point for the map - and kept. The site admin
 * reads it under Settings → Logins: a map and a list, so a scanner link
 * opened from the wrong side of the world, or a login from a cafe, is
 * something somebody sees.
 *
 * The lookup is a plain request to a public service (ipwho.is unless
 * GEOIP_BASE says otherwise). It is best effort and never in the way: a
 * sign-on is recorded whether or not the lookup works, and the lookup runs
 * after the answer has gone back. An address on a private network - the
 * warehouse's own Wi-Fi reaching a server in the building - has no place in
 * the world to look up, and says so.
 */
import { db } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS access_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,          -- scanner | login
  who        TEXT NOT NULL,          -- the scanner's name, or the username
  detail     TEXT,
  ip         TEXT NOT NULL,
  ua         TEXT,
  at         TEXT NOT NULL,
  session_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_access_at ON access_log(at);
CREATE INDEX IF NOT EXISTS idx_access_ip ON access_log(ip);
CREATE TABLE IF NOT EXISTS geo_ip (
  ip           TEXT PRIMARY KEY,
  looked_at    TEXT,
  ok           INTEGER NOT NULL DEFAULT 0,
  country      TEXT,
  country_code TEXT,
  region       TEXT,
  city         TEXT,
  lat          REAL,
  lon          REAL,
  isp          TEXT,
  error        TEXT
);
`);

const GEO = () => (process.env.GEOIP_BASE || 'https://ipwho.is').replace(/\/$/, '');
const now = () => new Date().toISOString();

/** An address with no place in the world: the building's own network, or the server itself. */
export const isPrivate = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|::$|fc|fd|fe80|unknown$|localhost$)/i.test(String(ip || ''));

/* The lookups run one at a time, after the request they came from, so a
   burst of sign-ons at shift start is a queue, not a flood. */
let chain = Promise.resolve();
const queue = (fn) => { chain = chain.then(fn).catch(() => {}); return chain; };

/** Write a sign-on down, and look its address up if it is new. */
export function recordAccess(kind, { who, detail = '', ip = '', ua = '', sessionId = null } = {}) {
  const address = String(ip || 'unknown').trim() || 'unknown';
  db.prepare('INSERT INTO access_log (kind, who, detail, ip, ua, at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(kind, String(who || '?'), String(detail || '').slice(0, 200), address, String(ua || '').slice(0, 300), now(), sessionId == null ? null : Number(sessionId));
  if (!db.prepare('SELECT 1 FROM geo_ip WHERE ip = ?').get(address)) queue(() => lookupIp(address));
}

/** Look one address up and keep the answer; a failure is kept too, and tried again later. */
export async function lookupIp(ip) {
  const put = (row) => db.prepare(
    `INSERT INTO geo_ip (ip, looked_at, ok, country, country_code, region, city, lat, lon, isp, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET looked_at = excluded.looked_at, ok = excluded.ok, country = excluded.country, country_code = excluded.country_code,
       region = excluded.region, city = excluded.city, lat = excluded.lat, lon = excluded.lon, isp = excluded.isp, error = excluded.error`,
  ).run(ip, now(), row.ok ? 1 : 0, row.country || null, row.country_code || null, row.region || null, row.city || null, row.lat ?? null, row.lon ?? null, row.isp || null, row.error || null);
  if (isPrivate(ip)) { put({ ok: 0, error: 'private' }); return geoOf(ip); }
  try {
    const res = await fetch(`${GEO()}/${encodeURIComponent(ip)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.success === false) throw new Error(d.message || `lookup answered ${res.status}`);
    put({
      ok: 1, country: d.country || '', country_code: d.country_code || '', region: d.region || '', city: d.city || '',
      lat: Number.isFinite(Number(d.latitude)) ? Number(d.latitude) : null, lon: Number.isFinite(Number(d.longitude)) ? Number(d.longitude) : null,
      isp: (d.connection && (d.connection.isp || d.connection.org)) || d.isp || d.org || '',
    });
  } catch (err) {
    put({ ok: 0, error: String(err && err.message || err).slice(0, 120) });
  }
  return geoOf(ip);
}
export const geoOf = (ip) => db.prepare('SELECT * FROM geo_ip WHERE ip = ?').get(ip) || null;

/** Addresses never looked up, or whose lookup failed more than a day ago: try them, a few at a time. */
export async function lookupPending(limit = 25) {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const ips = db.prepare(
    `SELECT DISTINCT a.ip FROM access_log a LEFT JOIN geo_ip g ON g.ip = a.ip
      WHERE g.ip IS NULL OR (g.ok = 0 AND g.error != 'private' AND g.looked_at < ?) LIMIT ?`,
  ).all(dayAgo, limit).map((r) => r.ip);
  for (const ip of ips) await lookupIp(ip);
  return ips.length;
}

/* "Mozilla/5.0 (Linux; Android 11; MC93) ... Chrome/120..." -> "Android · Chrome 120" */
export function deviceWord(ua) {
  const s = String(ua || '');
  if (!s) return '';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  let m;
  const browser = (m = /Edg\/(\d+)/.exec(s)) ? `Edge ${m[1]}` : (m = /Firefox\/(\d+)/.exec(s)) ? `Firefox ${m[1]}` : (m = /Chrome\/(\d+)/.exec(s)) ? `Chrome ${m[1]}` : /Safari\//.test(s) ? 'Safari' : /HeadlessChrome/.test(s) ? 'Chrome' : '';
  return [os, browser].filter(Boolean).join(' · ');
}

/** The map and the list: every sign-on in the window, and each address once with what is known about it. */
export function accessMap({ days = 30, kind = '' } = {}) {
  const n = Math.max(1, Math.min(3650, Number(days) || 30));
  const since = new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
  const rows = db.prepare(`SELECT * FROM access_log WHERE at >= ? ${kind ? 'AND kind = ?' : ''} ORDER BY at DESC LIMIT 2000`).all(...(kind ? [since, kind] : [since]));
  const geo = new Map(db.prepare('SELECT * FROM geo_ip').all().map((g) => [g.ip, g]));
  const placeOf = (g, ip) => {
    if (isPrivate(ip)) return { private: true, place: 'the building\'s own network', resolved: false };
    if (!g) return { private: false, place: '', resolved: false, pending: true };
    if (!g.ok) return { private: false, place: '', resolved: false, error: g.error || 'lookup failed' };
    return { private: false, resolved: true, place: [g.city, g.region, g.country].filter(Boolean).join(', '), country: g.country, country_code: g.country_code, city: g.city, region: g.region, lat: g.lat, lon: g.lon, isp: g.isp };
  };
  const places = new Map();
  for (const r of rows) {
    const p = places.get(r.ip) || { ip: r.ip, ...placeOf(geo.get(r.ip), r.ip), scanners: 0, logins: 0, first: r.at, last: r.at, who: [] };
    if (r.kind === 'scanner') p.scanners += 1; else p.logins += 1;
    if (r.at < p.first) p.first = r.at;
    if (r.at > p.last) p.last = r.at;
    if (!p.who.includes(r.who)) p.who.push(r.who);
    places.set(r.ip, p);
  }
  const list = [...places.values()].sort((a, b) => b.last.localeCompare(a.last));
  return {
    days: n, kind,
    rows: rows.map((r) => ({ id: r.id, kind: r.kind, who: r.who, detail: r.detail || '', ip: r.ip, at: r.at, device: deviceWord(r.ua), sessionId: r.session_id, ...placeOf(geo.get(r.ip), r.ip) })),
    places: list,
    summary: {
      signons: rows.length, scanners: rows.filter((r) => r.kind === 'scanner').length, logins: rows.filter((r) => r.kind === 'login').length,
      addresses: list.length, countries: [...new Set(list.filter((p) => p.resolved).map((p) => p.country))].length,
      pending: list.filter((p) => p.pending).length, failed: list.filter((p) => p.error).length, private: list.filter((p) => p.private).length,
    },
  };
}
