/*
 * Systems: LIVE, DEV - each its own deployment at its own address, reached
 * from the one place people already sign in.
 *
 * One system is the home: LIVE, as it ships. Its admin lists the others (DEV,
 * a training copy...) with their web addresses, says which logins may use each
 * one, and whether the scanners may switch to it. The home holds the logins;
 * an other system is "linked" to it and takes the people the home sends.
 *
 * Switching is a hand-off through the browser. The home writes a ticket - who
 * this is, what they may do, where they are going, good for two minutes and
 * once - and signs it with a link key the two systems share. The other system
 * checks the signature, makes or brings up to date the login or the scanner,
 * and signs the person in. Nothing travels between the servers themselves, and
 * no second password is needed. Going back is just the home's own address: the
 * browser still has its sign-in there, and a scanner still has its link.
 *
 * Trust runs one way. A linked system believes the home; the home believes
 * nobody, so DEV - which runs the newest code - can never sign anyone in to LIVE.
 * Each address keeps its own storage on a scanner, so DEV's counts and LIVE's
 * never share a queue.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, norm } from '../db.js';

const KEY = 'systems';
const TICKET_SECONDS = () => Number(process.env.SYSTEM_TICKET_SECONDS) || 120;
export const COLORS = ['green', 'orange', 'purple', 'blue', 'red', 'gray'];

db.exec(`CREATE TABLE IF NOT EXISTS handoff_nonces (n TEXT PRIMARY KEY, exp TEXT NOT NULL)`);
const hasCol = (t, c) => db.prepare(`PRAGMA table_info('${t}')`).all().some((x) => x.name === c);
// which other systems a login may use; an admin may use them all
if (!hasCol('users', 'systems')) db.exec('ALTER TABLE users ADD COLUMN systems TEXT');

/* ------------------------------------------------------------ what is kept */
function load() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
function save(c) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(c));
}
const cleanName = (v) => norm(v).replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 16);
const cleanColor = (v, d) => (COLORS.includes(String(v)) ? String(v) : d);
const cleanUrl = (v) => {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw Object.assign(new Error(`"${s}" is not a web address - it looks like https://full-harvest-dev.up.railway.app`), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol) || u.pathname.replace(/\/+$/, '') || u.search) throw Object.assign(new Error('just the address of the site, like https://full-harvest-dev.up.railway.app - no page after it'), { status: 400 });
  return u.origin;
};

/** This system: its name and color, whether it is the home, and where the home is. */
export function selfSystem(c = load()) {
  const homeUrl = cleanUrl(process.env.SYSTEM_HOME_URL || c.homeUrl || '');
  return {
    name: cleanName(process.env.SYSTEM_NAME || c.name) || (homeUrl ? 'TEST' : 'LIVE'),
    color: cleanColor(process.env.SYSTEM_COLOR || c.color, homeUrl ? 'orange' : 'green'),
    role: homeUrl ? 'linked' : 'home',
    homeUrl,
    homeName: c.homeName || 'LIVE',
    nameFromEnv: !!process.env.SYSTEM_NAME, homeFromEnv: !!process.env.SYSTEM_HOME_URL, keyFromEnv: !!process.env.SYSTEM_LINK_KEY,
  };
}

/* The link key: the home makes one; a linked system is given it. */
function linkKey() {
  // a key pasted into a variable often comes with a space or quotes around it
  if (process.env.SYSTEM_LINK_KEY) return String(process.env.SYSTEM_LINK_KEY).trim().replace(/^["']|["']$/g, '');
  const c = load();                     // always the stored one: never a copy read before a key was made
  if (c.key) return c.key;
  if (selfSystem(c).role === 'linked') return '';
  const k = randomBytes(24).toString('base64url');
  save({ ...c, key: k });
  return k;
}

/** The other systems the home knows of. On a linked system: the home, and what the last ticket said. */
export function otherSystems(c = load()) {
  const me = selfSystem(c);
  if (me.role === 'linked') {
    const seen = Array.isArray(c.seen) ? c.seen.filter((s) => s.name !== me.name) : [];
    return [{ name: me.homeName, url: me.homeUrl, color: c.homeColor || 'green', home: true }, ...seen.filter((s) => s.url !== me.homeUrl && !s.home)];
  }
  return (Array.isArray(c.list) ? c.list : []).map((s) => ({ name: s.name, url: s.url, color: s.color || 'orange', scanners: !!s.scanners }));
}

/** The settings card, for an admin. The key is only for the home's admin to copy. */
export function systemsConfig() {
  const key = linkKey();                 // made here the first time, before anything else is read
  const c = load();
  const me = selfSystem(c);
  return {
    self: me,
    systems: otherSystems(c),
    key: me.role === 'home' ? key : '',
    keySet: !!key,
    colors: COLORS,
  };
}

export function saveSystems(body = {}) {
  const c = load();
  const next = { ...c };
  if (body.name !== undefined) {
    const n = cleanName(body.name);
    if (!n) throw Object.assign(new Error('give this system a short name, like LIVE or TEST'), { status: 400 });
    next.name = n;
  }
  if (body.color !== undefined) next.color = cleanColor(body.color, 'green');
  if (body.homeUrl !== undefined) next.homeUrl = cleanUrl(body.homeUrl);
  if (body.homeName !== undefined) next.homeName = cleanName(body.homeName) || 'LIVE';
  if (body.key !== undefined) {
    const k = String(body.key || '').trim().replace(/^["']|["']$/g, '');
    if (k && k.length < 24) throw Object.assign(new Error('that link key is too short - copy the whole key from the home system'), { status: 400 });
    next.key = k;
  }
  if (body.newKey) next.key = randomBytes(24).toString('base64url');
  if (body.systems !== undefined) {
    if (!Array.isArray(body.systems)) throw Object.assign(new Error('send the list of systems'), { status: 400 });
    const me = cleanName(next.name) || 'LIVE';
    const seen = new Set([me]);
    next.list = body.systems.map((s, i) => {
      const name = cleanName(s && s.name);
      if (!name) throw Object.assign(new Error(`system ${i + 1} needs a name`), { status: 400 });
      if (seen.has(name)) throw Object.assign(new Error(`${name} is on the list twice (or is this system's own name)`), { status: 400 });
      seen.add(name);
      const url = cleanUrl(s.url);
      if (!url) throw Object.assign(new Error(`${name} needs its web address`), { status: 400 });
      return { name, url, color: cleanColor(s.color, 'orange'), scanners: !!s.scanners };
    }).slice(0, 6);
  }
  save(next);
  return systemsConfig();
}

/* ------------------------------------------------------------ who may use what */
const parseList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(cleanName).filter(Boolean) : []; } catch { return []; } };

/** The other systems one login may switch to. */
export function systemsFor(user) {
  if (!user) return [];
  const all = otherSystems();
  if (selfSystem().role === 'linked') return all;               // the way back is always there
  if (user.role === 'admin') return all;
  const row = user.username ? db.prepare('SELECT systems FROM users WHERE username = ?').get(norm(user.username)) : null;
  const mine = new Set(parseList(row && row.systems));
  return all.filter((s) => mine.has(s.name));
}

/** The table on the card: every login, and the systems it may use. */
export function systemAccess() {
  return db.prepare('SELECT username, name, role, active, systems FROM users ORDER BY role = \'admin\' DESC, name').all()
    .map((u) => ({ username: u.username, name: u.name, role: u.role, active: !!u.active, systems: u.role === 'admin' ? otherSystems().map((s) => s.name) : parseList(u.systems) }));
}

export function setSystemAccess(username, systems) {
  const u = db.prepare('SELECT username, role FROM users WHERE username = ?').get(norm(username));
  if (!u) throw Object.assign(new Error('no such login'), { status: 404 });
  const known = new Set(otherSystems().map((s) => s.name));
  const list = [...new Set((Array.isArray(systems) ? systems : []).map(cleanName).filter((n) => known.has(n)))];
  db.prepare('UPDATE users SET systems = ? WHERE username = ?').run(JSON.stringify(list), u.username);
  return systemAccess().find((x) => x.username === u.username);
}

/* ------------------------------------------------------------ tickets */
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (payload, key) => createHmac('sha256', key).update(payload).digest('base64url');

/** A ticket from the home to another system: for a login, or for a scanner. */
export function makeTicket(toName, { user, device, path } = {}) {
  const me = selfSystem();
  if (me.role !== 'home') throw Object.assign(new Error('only the home system hands people over'), { status: 409 });
  const to = otherSystems().find((s) => s.name === cleanName(toName));
  if (!to) throw Object.assign(new Error(`there is no system called ${toName}`), { status: 404 });
  const body = {
    v: 1, iss: me.name, aud: to.name, exp: Date.now() + TICKET_SECONDS() * 1000, n: randomBytes(12).toString('base64url'),
    home: { name: me.name, url: '', color: me.color },
    systems: otherSystems().map((s) => ({ name: s.name, url: s.url, color: s.color })),
  };
  if (user) {
    body.kind = 'user';
    const row = user.username ? db.prepare('SELECT username, name, role, access, email FROM users WHERE username = ?').get(norm(user.username)) : null;
    if (!row) throw Object.assign(new Error('a switch needs a login of your own - the shared password cannot be handed over'), { status: 409 });
    body.user = { username: row.username, name: row.name, role: row.role, access: row.access ? JSON.parse(row.access) : null, email: row.email || '' };
    body.path = safePath(path);
  } else if (device) {
    body.kind = 'device';
    body.device = { uid: device.uid, name: device.name, notes: device.notes || '' };
  } else throw new Error('a ticket is for a login or a scanner');
  const payload = b64(JSON.stringify(body));
  return { url: `${to.url}/handoff?t=${payload}.${sign(payload, linkKey())}`, to };
}

/* where a person lands on the other side: one of the office pages, never somewhere else */
function safePath(p) {
  const s = String(p || '/admin');
  return /^\/(admin|full|cycle|front|missing|teams|settings|testing|guide|practice)?(#[A-Za-z0-9_-]*)?$/.test(s) ? s : '/admin';
}

/** On a linked system: the ticket checked, once. Returns what it carries. */
export function readTicket(t) {
  const body = checkTicket(t);
  db.prepare('DELETE FROM handoff_nonces WHERE exp < ?').run(new Date().toISOString());
  try { db.prepare('INSERT INTO handoff_nonces (n, exp) VALUES (?, ?)').run(String(body.n), new Date(Number(body.exp)).toISOString()); }
  catch { throw Object.assign(new Error('that hand-off has been used already - switch again from the home system'), { status: 403 }); }
  // remember what the home said about itself and the others, for the way back
  const c = load();
  save({ ...c, homeName: cleanName(body.iss) || c.homeName || 'LIVE', homeColor: cleanColor(body.home && body.home.color, 'green'),
    seen: (body.systems || []).map((s) => ({ name: cleanName(s.name), url: String(s.url || ''), color: cleanColor(s.color, 'orange') })) });
  return body;
}

/** The checks alone - signature, which system it is for, still in date - with nothing used up. */
export function checkTicket(t) {
  const me = selfSystem();
  if (me.role !== 'linked') throw Object.assign(new Error('this is the home system - it does not take hand-offs'), { status: 409 });
  const key = linkKey();
  if (!key) throw Object.assign(new Error('this system has no link key yet - an admin pastes the home system\'s key under Settings → Logins & site → Systems'), { status: 409 });
  const [payload, sig] = String(t || '').split('.');
  if (!payload || !sig) throw Object.assign(new Error('that hand-off link is not whole'), { status: 400 });
  const want = Buffer.from(sign(payload, key));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw Object.assign(new Error('that hand-off was not signed with this system\'s link key - the two systems need the same key'), { status: 403 });
  let body;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw Object.assign(new Error('that hand-off link is not whole'), { status: 400 }); }
  if (body.v !== 1 || cleanName(body.aud) !== me.name) throw Object.assign(new Error(`that hand-off was for ${body.aud || 'another system'}, and this is ${me.name}`), { status: 403 });
  if (!(Number(body.exp) > Date.now())) throw Object.assign(new Error('that hand-off ran out - switch again from the home system'), { status: 403 });
  return body;
}

/* ------------------------------------------------------------ checking the link
   From the home, server to server: can the other system be reached, is it
   running a version that has systems, does it know it is linked to this one,
   is it called what this one calls it, and does it hold the same key. Each
   answer in words, with what to change and where. */
export async function checkLink(name, homeOrigin = '') {
  const me = selfSystem();
  if (me.role !== 'home') throw Object.assign(new Error('the link is checked from the home system'), { status: 409 });
  const to = otherSystems().find((s) => s.name === cleanName(name));
  if (!to) throw Object.assign(new Error(`there is no system called ${name}`), { status: 404 });
  const steps = [];
  const say = (ok, text, fix = '') => { steps.push({ ok, text, fix }); return ok; };
  const get = async (path) => {
    const r = await fetch(to.url + path, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a page, not an answer */ }
    return { status: r.status, json };
  };
  let pub;
  try { pub = await get('/api/system'); }
  catch (err) { say(false, `${to.url} could not be reached (${err.name === 'TimeoutError' ? 'no answer in 12 seconds' : err.message})`, `Check the address, and that the ${to.name} service is running in Railway.`); return { system: to.name, ok: false, steps }; }
  if (!pub.json || !pub.json.self) {
    say(false, `${to.url} answered, but not with this app's systems (${pub.status})`, `${to.name} is running an older version of the app, or the address is another site. Deploy the same branch as here to ${to.name}.`);
    return { system: to.name, ok: false, steps };
  }
  say(true, `${to.url} answers, and runs a version with systems`);
  const them = pub.json.self;
  const ok1 = say(them.role === 'linked', them.role === 'linked' ? `${to.url} knows it is linked to a home system` : `${to.url} thinks it is a home system itself`,
    them.role === 'linked' ? '' : `On ${to.name}'s Railway service, set SYSTEM_HOME_URL to ${homeOrigin || "this system's address"} (or put it in ${to.name}'s Settings → Logins & site → Systems), then redeploy.`);
  if (ok1 && pub.json.home && homeOrigin) {
    const same = cleanUrl(pub.json.home.url) === cleanUrl(homeOrigin);
    say(same, same ? `…and that home is this system (${homeOrigin})` : `…but its home is set to ${pub.json.home.url}, not ${homeOrigin}`, same ? '' : `Set SYSTEM_HOME_URL on ${to.name} to ${homeOrigin}.`);
  }
  const named = cleanName(them.name) === to.name;
  say(named, named ? `It calls itself ${them.name}, as it is listed here` : `It calls itself ${them.name}, but it is listed here as ${to.name}`,
    named ? '' : `Either rename it here to ${them.name}, or set SYSTEM_NAME=${to.name} on its Railway service.`);
  if (!ok1) return { system: to.name, ok: false, steps };
  // a hand-off it can check but never use: the key, the name and the clock, all at once
  const body = { v: 1, iss: me.name, aud: to.name, exp: Date.now() + TICKET_SECONDS() * 1000, n: randomBytes(12).toString('base64url'), kind: 'probe' };
  const payload = b64(JSON.stringify(body));
  try {
    const v = await get(`/api/system/verify?t=${payload}.${sign(payload, linkKey())}`);
    if (v.json && v.json.ok) say(true, 'It holds the same link key: a hand-off from here is accepted');
    else if (v.status === 404 || !v.json) say(false, `${to.name} cannot check a hand-off yet (${v.status})`, `Deploy the same branch as here to ${to.name}.`);
    else say(false, `It refuses a hand-off from here: ${v.json.error}`, /link key/.test(v.json.error) ? `Copy the link key from this card into ${to.name}'s SYSTEM_LINK_KEY variable (no spaces or quotes) and redeploy it.` : '');
  } catch (err) { say(false, `The key check could not reach ${to.name}: ${err.message}`); }
  return { system: to.name, ok: steps.every((s) => s.ok), steps };
}

/** Make or bring up to date the login a ticket carries. The home decides the role and the pages. */
export function provisionUser(u) {
  const username = norm(u.username);
  if (!/^[A-Z0-9._-]{2,32}$/.test(username)) throw Object.assign(new Error('that login name cannot be used here'), { status: 400 });
  const role = u.role === 'admin' ? 'admin' : 'supervisor';
  const access = Array.isArray(u.access) ? JSON.stringify(u.access) : null;
  const have = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
  if (have) {
    db.prepare('UPDATE users SET name = ?, role = ?, access = ?, active = 1, must_change = 0, last_login = ? WHERE username = ?')
      .run(String(u.name || username), role, access, new Date().toISOString(), username);
  } else {
    // a password nobody knows: this login only ever arrives from the home
    db.prepare('INSERT INTO users (username, name, password_hash, role, active, created_at, created_by, must_change, access, email, last_login) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?)')
      .run(username, String(u.name || username), `handoff:${randomBytes(32).toString('hex')}`, role, new Date().toISOString(), 'the home system', access, u.email || null, new Date().toISOString());
  }
  return db.prepare('SELECT username, name, role FROM users WHERE username = ?').get(username);
}

/** Make or bring up to date the scanner a ticket carries, under the same link it has at home. */
export function provisionDevice(d) {
  const uid = String(d.uid || '');
  if (!/^[a-z0-9]{4,32}$/.test(uid)) throw Object.assign(new Error('that scanner link cannot be used here'), { status: 400 });
  const name = norm(d.name);
  const at = new Date().toISOString();
  const byUid = db.prepare('SELECT uid FROM devices WHERE uid = ?').get(uid);
  const byName = db.prepare('SELECT uid FROM devices WHERE name = ?').get(name);
  if (byUid) {
    if (byName && byName.uid !== uid) db.prepare('UPDATE devices SET name = ? WHERE uid = ?').run(`${name}-OLD-${byName.uid.slice(0, 4)}`.toUpperCase(), byName.uid);
    db.prepare('UPDATE devices SET name = ? WHERE uid = ?').run(name, uid);
  } else if (byName) {
    // the same scanner, registered here by hand before: it takes the home's link
    db.prepare('UPDATE devices SET uid = ? WHERE uid = ?').run(uid, byName.uid);
  } else {
    db.prepare('INSERT INTO devices (uid, name, notes, created_at) VALUES (?, ?, ?, ?)').run(uid, name, d.notes || 'arrived from the home system', at);
  }
  return db.prepare('SELECT uid, name FROM devices WHERE uid = ?').get(uid);
}

/** What any page or scanner may know: this system's name and the others' addresses. */
export function publicSystems() {
  const me = selfSystem();
  return { self: { name: me.name, color: me.color, role: me.role }, home: me.role === 'linked' ? { name: me.homeName, url: me.homeUrl } : null, systems: otherSystems().map((s) => ({ name: s.name, url: s.url, color: s.color, home: !!s.home })) };
}
