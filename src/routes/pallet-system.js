/*
 * The pallet system: the web address of the system the pallets live in, and
 * how the desks open it.
 *
 * Framed under the desk is the handiest, and the one that goes wrong: a page
 * inside another site's frame is "third-party", and a sign-in that sets its
 * cookies without SameSite=None (classic ASP.NET, most in-house systems) never
 * sticks there - the form submits, the browser drops the cookie, the login
 * page comes back. Many such sites also refuse to be framed at all. So the
 * address can instead open in its own window, where everything works, and
 * can carry placeholders - {pallet}, {from}, {to}, {bin}, {last} - so each
 * pallet opens the system at the right record.
 */
import { db } from '../db.js';

export const MODES = ['frame', 'proxy', 'window'];
export const PLACEHOLDERS = ['pallet', 'from', 'to', 'bin', 'last'];

export function palletSystem() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'palletSystem'").get();
  if (row) {
    try { const v = JSON.parse(row.value); return { url: String(v.url || ''), mode: MODES.includes(v.mode) ? v.mode : 'frame' }; } catch { /* fall through */ }
  }
  // the address alone, as the first version kept it
  const old = db.prepare("SELECT value FROM settings WHERE key = 'palletSystemUrl'").get();
  return { url: old ? String(old.value) : '', mode: 'frame' };
}

export function savePalletSystem({ url, mode } = {}) {
  const now = palletSystem();
  const u = url === undefined ? now.url : String(url || '').trim().slice(0, 500);
  if (u && !/^https?:\/\//i.test(u)) throw Object.assign(new Error('the address has to start with http:// or https://'), { status: 400 });
  const unknown = [...u.matchAll(/\{([a-z]+)\}/gi)].map((m) => m[1].toLowerCase()).filter((k) => !PLACEHOLDERS.includes(k));
  if (unknown.length) throw Object.assign(new Error(`not a placeholder the desk fills in: {${unknown[0]}} - use ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`), { status: 400 });
  const m = mode === undefined ? now.mode : String(mode);
  if (!MODES.includes(m)) throw Object.assign(new Error('how it opens is "frame", "proxy" or "window"'), { status: 400 });
  if (!u) {
    db.prepare("DELETE FROM settings WHERE key IN ('palletSystem', 'palletSystemUrl')").run();
    return { url: '', mode: m };
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('palletSystem', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ url: u, mode: m }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('palletSystemUrl', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(u);
  return { url: u, mode: m };
}

/** The address with a pallet's own values in it. */
export function fillPalletUrl(url, vars = {}) {
  return String(url || '').replace(/\{([a-z]+)\}/gi, (whole, k) => {
    const v = vars[k.toLowerCase()];
    return v == null ? '' : encodeURIComponent(String(v));
  });
}

/* ------------------------------------------------------------ the check
   What the system's own headers say about being framed and signed in to.
   Read from the server, which may not be able to reach a system on the
   warehouse's own network - that is said rather than guessed. */
export async function probePalletSystem(url) {
  const target = fillPalletUrl(url, { pallet: 'TEST', from: 'TEST', to: 'TEST', bin: 'TEST', last: 'TEST' });
  if (!/^https?:\/\//i.test(target)) throw Object.assign(new Error('the address has to start with http:// or https://'), { status: 400 });
  const out = { url: target, reachable: false, status: 0, frames: 'unknown', cookies: 'unknown', findings: [], verdict: '' };
  let res;
  try {
    res = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(Number(process.env.PALLET_PROBE_MS) || 8000), headers: { 'user-agent': 'Full-Harvest-Inventory/1 (address check)' } });
  } catch (err) {
    out.findings.push(`The server could not reach it (${err.name === 'TimeoutError' ? 'no answer in 8 seconds' : err.message}). A system on the warehouse’s own network is out of the server’s reach, though a browser in the building may still open it; what follows cannot be checked from here.`);
    out.verdict = 'unreachable';
    return out;
  }
  out.reachable = true;
  out.status = res.status;
  const h = (n) => String(res.headers.get(n) || '');
  const xfo = h('x-frame-options').toUpperCase();
  const csp = h('content-security-policy');
  const fa = csp.match(/frame-ancestors\s+([^;]+)/i);
  if (xfo.includes('DENY') || xfo.includes('SAMEORIGIN')) { out.frames = 'no'; out.findings.push(`It refuses to be framed by another site (X-Frame-Options: ${xfo}).`); }
  else if (fa && !/\*|https?:/.test(fa[1])) { out.frames = 'no'; out.findings.push(`It refuses to be framed by another site (Content-Security-Policy frame-ancestors ${fa[1].trim()}).`); }
  else out.frames = 'yes';
  // every Set-Cookie it sent, with or without SameSite=None
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (h('set-cookie') ? [h('set-cookie')] : []);
  if (raw.length) {
    const lax = raw.filter((c) => !/samesite\s*=\s*none/i.test(c));
    if (lax.length) {
      out.cookies = 'lax';
      const names = lax.map((c) => c.split('=')[0].trim()).slice(0, 4).join(', ');
      out.findings.push(`Its cookies (${names}) are set without SameSite=None, so a browser will not send them to a page inside another site’s frame: a sign-in made in the frame does not stick.`);
    } else out.cookies = 'none';
  }
  const aspx = /\.aspx(\?|$)/i.test(target) || /asp\.net/i.test(h('x-powered-by')) || /ASP\.NET_SessionId|\.ASPXAUTH/i.test(raw.join(';'));
  if (aspx && out.cookies === 'unknown') { out.cookies = 'lax'; out.findings.push('It is an ASP.NET site: its sign-in cookies (.ASPXAUTH, ASP.NET_SessionId) are set without SameSite=None unless its web.config says otherwise, so a sign-in made inside a frame does not stick.'); }
  if (res.status >= 400) out.findings.push(`It answered ${res.status} to the server’s request${res.status === 401 || res.status === 403 ? ' (a sign-in is wanted, which is normal)' : ''}.`);
  out.verdict = out.frames === 'no' ? 'proxy' : out.cookies === 'lax' ? 'proxy' : 'frame';
  if (!out.findings.length) out.findings.push('Nothing in its headers stops it being framed or signed in to from the frame.');
  else if (out.verdict === 'proxy') out.findings.push('Shown through this app it works under the desk anyway: the server can reach it, so it can fetch its pages and keep its sign-in.');
  return out;
}
