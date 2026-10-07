/*
 * The pallet system, through this app.
 *
 * A system whose sign-in does not survive another site's frame (classic
 * ASP.NET, most in-house systems) works under the desk after all when this
 * server fetches its pages and hands them on under /ps/: to the browser the
 * frame is then part of this site, its cookies are first-party and stick, and
 * the "do not frame me" headers never reach the browser. Only the one system
 * the admin set is reachable this way, and only from a page that holds a
 * ticket - the office desk or a scanner that has signed in.
 *
 * On the way through: the system's cookies are kept under this site's name
 * and path; its redirects, root-relative links and absolute links back to
 * itself are pointed at /ps/; everything else is passed on untouched. The
 * server has to be able to reach the system - a system on the warehouse's
 * own network needs this app running in the building, not on the cloud.
 */
import { createHash, randomBytes } from 'node:crypto';
import { palletSystem } from './pallet-system.js';

export const PREFIX = '/ps';
const TICKET_MS = 12 * 60 * 60 * 1000;
const UPSTREAM_MS = () => Number(process.env.PALLET_PROXY_MS) || 25000;
const tickets = new Map();       // hash -> { until, who }

/* ------------------------------------------------------------ tickets */
export function makeTicket(who) {
  const t = randomBytes(24).toString('base64url');
  tickets.set(createHash('sha256').update(t).digest('hex'), { until: Date.now() + TICKET_MS, who });
  for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k);
  return { ticket: t, maxAge: Math.floor(TICKET_MS / 1000) };
}
const cookieOf = (req, name) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
};
export function hasTicket(req) {
  const t = cookieOf(req, 'psTicket');
  if (!t) return false;
  const row = tickets.get(createHash('sha256').update(t).digest('hex'));
  return !!row && row.until > Date.now();
}
export const ticketCookie = (ticket, maxAge, secure) => `psTicket=${encodeURIComponent(ticket)}; Path=${PREFIX}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

/* ------------------------------------------------------------ addresses */
/** The system's origin and the path a desk opens: "https://wms/Move.aspx?x=1" -> { origin, path } */
export function upstreamOf(url) {
  try { const u = new URL(url); return { origin: u.origin, path: u.pathname + u.search }; } catch { return null; }
}
/** The desk's address for a system shown through this app. */
export const proxiedPath = (url) => { const u = upstreamOf(url); return u ? PREFIX + (u.path.startsWith('/') ? u.path : '/' + u.path) : ''; };

/* The system's own pages point at itself three ways; each is turned towards /ps/. */
function rewriteText(text, origin) {
  const esc = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text.replace(new RegExp(esc + '(?=[/"\'\\s?#)]|$)', 'g'), PREFIX);           // https://wms.example.com/... -> /ps/...
  out = out.replace(new RegExp('//' + esc.replace(/^https?:\\\/\\\//, '') + '(?=[/"\'\\s?#)]|$)', 'g'), PREFIX);   // //wms.example.com/...
  // root-relative links in markup and styles: /x -> /ps/x (never //cdn or /ps/ itself)
  out = out.replace(/((?:href|src|action|data-src|formaction|poster)\s*=\s*["'])\/(?!\/|ps\/)/gi, `$1${PREFIX}/`);
  out = out.replace(/(url\(\s*["']?)\/(?!\/|ps\/)/gi, `$1${PREFIX}/`);
  return out;
}

function rewriteLocation(loc, origin, base) {
  if (!loc) return loc;
  try {
    const u = new URL(loc, base);
    if (u.origin === origin) return PREFIX + u.pathname + u.search + u.hash;
    return loc;
  } catch { return loc; }
}

/* The system's Set-Cookie, kept under this site: no Domain, Path under /ps,
   Secure only where this site is https (a local http server would lose it). */
function rewriteCookie(c, secure) {
  let parts = c.split(';').map((s) => s.trim()).filter(Boolean);
  parts = parts.filter((p) => !/^(domain|path|samesite|secure)=?/i.test(p) && !/^secure$/i.test(p));
  parts.push(`Path=${PREFIX}`);
  parts.push('SameSite=Lax');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

const TEXT = /^(text\/|application\/(javascript|x-javascript|json|xml|xhtml\+xml))/i;

/* ------------------------------------------------------------ the pass-through */
export async function proxyPalletSystem(req, res, url, readBody) {
  const ps = palletSystem();
  const up = ps.mode === 'proxy' && ps.url ? upstreamOf(ps.url) : null;
  if (!up) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('The pallet system is not set to open through this app.'); }
  if (!hasTicket(req)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Open the pallet system from the move desk or a signed-in scanner.'); }
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  const target = up.origin + url.pathname.slice(PREFIX.length) + url.search;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (/^(host|connection|cookie|accept-encoding|content-length|x-forwarded-.*|forwarded|via|te|upgrade)$/i.test(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  // the system's own cookies, which the browser kept under this site, minus our ticket
  const cookie = String(req.headers.cookie || '').split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('psTicket=')).join('; ');
  if (cookie) headers.cookie = cookie;
  headers['accept-encoding'] = 'identity';
  if (req.headers.referer) headers.referer = String(req.headers.referer).replace(/^https?:\/\/[^/]+\/ps/, up.origin);
  if (req.headers.origin) headers.origin = up.origin;

  const method = req.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  let r;
  try {
    r = await fetch(target, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_MS()) });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:20px;color:#333"><b>The pallet system did not answer.</b><div style="margin-top:8px">${err.name === 'TimeoutError' ? 'No answer in 25 seconds.' : String(err.message).replace(/[<>&]/g, '')}</div><div style="margin-top:8px;color:#666">This app’s server has to be able to reach it: a system on the warehouse’s own network needs the app running in the building.</div></body>`);
  }

  const out = {};
  const dropped = /^(x-frame-options|content-security-policy|content-security-policy-report-only|strict-transport-security|content-encoding|content-length|transfer-encoding|connection|keep-alive|set-cookie|location|alt-svc)$/i;
  for (const [k, v] of r.headers) if (!dropped.test(k)) out[k] = v;
  const loc = r.headers.get('location');
  if (loc) out.location = rewriteLocation(loc, up.origin, target);
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
  if (cookies.length) out['set-cookie'] = cookies.map((c) => rewriteCookie(c, secure));
  out['cache-control'] = 'no-store';

  const type = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (TEXT.test(type)) {
    const text = rewriteText(buf.toString('utf8'), up.origin);
    const payload = Buffer.from(text, 'utf8');
    out['content-length'] = payload.length;
    res.writeHead(r.status, out);
    return res.end(method === 'HEAD' ? undefined : payload);
  }
  out['content-length'] = buf.length;
  res.writeHead(r.status, out);
  return res.end(method === 'HEAD' ? undefined : buf);
}
