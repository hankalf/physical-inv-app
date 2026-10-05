/* Wrong passwords, counted.
 *
 * Five wrong passwords for one login from one place locks that login out of
 * that place for fifteen minutes; twenty from one place, whatever the logins,
 * locks the place. Keyed on the login and the address together, so somebody
 * guessing at the site admin's password from outside cannot lock the site
 * admin out of the office. Kept in memory: a restart forgets it, which is fine
 * for something that only has to slow a guesser down. An admin can lift a lock
 * from Settings, and resetting a login's password lifts its locks too. */

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
export const PER_LOGIN = 5;
export const PER_PLACE = 20;

const fails = new Map();    // key -> [times]
const locks = new Map();    // key -> { until, username, ip }

const kLogin = (username, ip) => `u:${String(username || '').toUpperCase()}|${ip}`;
const kPlace = (ip) => `ip:${ip}`;

/** The caller's address: Railway sits in front, so the first forwarded one. */
export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function recent(key, now) {
  const list = (fails.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) fails.set(key, list); else fails.delete(key);
  return list;
}

function lockedFor(key, now) {
  const l = locks.get(key);
  if (!l) return 0;
  if (l.until <= now) { locks.delete(key); return 0; }
  return l.until - now;
}

/** Milliseconds this login, from this address, must still wait; 0 if none. */
export function waitFor(username, ip, now = Date.now()) {
  return Math.max(lockedFor(kLogin(username, ip), now), lockedFor(kPlace(ip), now));
}

/** A wrong password. Returns whether it has just locked something. */
export function noteFailure(username, ip, now = Date.now()) {
  let locked = '';
  for (const [key, limit, kind] of [[kLogin(username, ip), PER_LOGIN, 'login'], [kPlace(ip), PER_PLACE, 'place']]) {
    const list = recent(key, now);
    list.push(now);
    fails.set(key, list);
    if (list.length >= limit && !lockedFor(key, now)) {
      locks.set(key, { until: now + LOCK_MS, username: kind === 'login' ? String(username || '').toUpperCase() : '', ip });
      fails.delete(key);
      locked = locked || kind;
    }
  }
  return locked;
}

/** Signed in: this login's count from this address starts again. */
export function noteSuccess(username, ip) {
  fails.delete(kLogin(username, ip));
}

/** The locks still in force, for Settings. */
export function listLocks(now = Date.now()) {
  const out = [];
  for (const [key, l] of locks) {
    if (l.until <= now) { locks.delete(key); continue; }
    out.push({ username: l.username, ip: l.ip, until: new Date(l.until).toISOString(), minutes: Math.ceil((l.until - now) / 60000) });
  }
  return out;
}

/** Lift every lock on a login (an admin unlocked it, or reset its password). */
export function unlockLogin(username) {
  const u = String(username || '').toUpperCase();
  let n = 0;
  for (const [key, l] of locks) if (l.username === u) { locks.delete(key); n++; }
  for (const key of fails.keys()) if (key.startsWith(`u:${u}|`)) fails.delete(key);
  return n;
}

/** Lift a lock on an address. */
export function unlockPlace(ip) {
  const had = locks.delete(kPlace(ip));
  fails.delete(kPlace(ip));
  return had ? 1 : 0;
}

export function resetAll() { fails.clear(); locks.clear(); }
