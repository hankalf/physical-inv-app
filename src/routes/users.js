import { db, norm } from '../db.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/*
 * Supervisor accounts.
 *
 * Two roles: an admin can manage accounts, a supervisor can do everything else.
 * The shared ADMIN_PASSWORD stays as a way in when nobody has an account yet (or
 * when everyone has forgotten theirs) - it signs in as "shared password", which
 * is what the audit log then records, so its use is never invisible.
 */

const KEYLEN = 64;

function hash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(String(password), salt, KEYLEN).toString('hex')}`;
}

function verify(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const a = Buffer.from(key, 'hex');
  const b = scryptSync(String(password), salt, KEYLEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const countUsers = () => db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get().n;

const shape = (u) => ({
  username: u.username, name: u.name, role: u.role, active: !!u.active,
  created_at: u.created_at, last_login: u.last_login, created_by: u.created_by,
  mustChange: !!u.must_change,
});

/* A starter password is meant to be said out loud once and then replaced, so it
   is short, unambiguous and never reused. No I/O/0/1 - they are misread. */
const WORDS = ['freezer', 'pallet', 'aisle', 'forklift', 'dock', 'rack', 'crate', 'scanner'];
export const starterPassword = () =>
  `${WORDS[randomBytes(1)[0] % WORDS.length]}-${[...randomBytes(4)].map((b) => 'ACDEFGHJKLMNPQRTUVWXY23456789'[b % 29]).join('')}`;

export const listUsers = () => db.prepare('SELECT * FROM users ORDER BY role, username').all().map(shape);
export const getUser = (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(norm(username));

/**
 * Create a login. With no password one is generated and the person is made to
 * replace it the first time they sign in - so an admin never learns, or has to
 * invent, somebody else's real password. The starter is returned once, here,
 * and is not recoverable afterwards.
 */
export function createUser({ username, name, password, role = 'supervisor', mustChange }, createdBy = '') {
  const u = norm(username).replace(/\s+/g, '');
  if (!u) throw Object.assign(new Error('a username is required'), { status: 400 });
  if (!/^[A-Z0-9._-]{2,32}$/.test(u)) throw Object.assign(new Error('usernames are 2-32 characters: letters, digits, . _ -'), { status: 400 });
  const starter = String(password || '') ? '' : starterPassword();
  const pw = starter || String(password);
  if (pw.length < 8) throw Object.assign(new Error('the password must be at least 8 characters'), { status: 400 });
  if (getUser(u)) throw Object.assign(new Error(`${u} already has an account`), { status: 409 });
  const force = mustChange === undefined ? !!starter : !!mustChange;
  db.prepare('INSERT INTO users (username, name, password_hash, role, active, created_at, created_by, must_change) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
    .run(u, String(name || u).trim(), hash(pw), role === 'admin' ? 'admin' : 'supervisor',
         new Date().toISOString(), String(createdBy || ''), force ? 1 : 0);
  return { ...shape(getUser(u)), starterPassword: starter || undefined };
}

export function updateUser(username, { name, role, active, password, mustChange }) {
  const existing = getUser(username);
  if (!existing) throw Object.assign(new Error('no such account'), { status: 404 });
  // never leave the place with no way in
  if ((role && role !== 'admin' && existing.role === 'admin') || active === false) {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND username != ?").get(existing.username).n;
    if (existing.role === 'admin' && admins === 0) throw Object.assign(new Error('this is the last admin account - make someone else an admin first'), { status: 409 });
  }
  // a password set BY somebody else is a starter: the owner replaces it on arrival
  const starter = password === '' ? starterPassword() : '';
  const pw = starter || password;
  if (pw && String(pw).length < 8) throw Object.assign(new Error('the password must be at least 8 characters'), { status: 400 });
  db.prepare('UPDATE users SET name = ?, role = ?, active = ?, password_hash = ?, must_change = ? WHERE username = ?').run(
    name == null ? existing.name : String(name).trim(),
    role == null ? existing.role : (role === 'admin' ? 'admin' : 'supervisor'),
    active == null ? existing.active : (active ? 1 : 0),
    pw ? hash(pw) : existing.password_hash,
    mustChange == null ? (pw ? 1 : existing.must_change) : (mustChange ? 1 : 0),
    existing.username
  );
  return { ...shape(getUser(existing.username)), starterPassword: starter || undefined };
}

export function deleteUser(username) {
  const u = getUser(username);
  if (!u) return 0;
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND username != ?").get(u.username).n === 0) {
    throw Object.assign(new Error('this is the last admin account'), { status: 409 });
  }
  return db.prepare('DELETE FROM users WHERE username = ?').run(u.username).changes;
}

/** Check a sign-in. Returns the account, or null. */
export function authenticate(username, password) {
  const u = getUser(username);
  if (!u || !u.active || !verify(password, u.password_hash)) return null;
  db.prepare('UPDATE users SET last_login = ? WHERE username = ?').run(new Date().toISOString(), u.username);
  return shape(u);
}

/** Change your own password, having proved the old one. Clears any starter flag. */
export function changeOwnPassword(username, currentPassword, newPassword) {
  const u = getUser(username);
  if (!u || !verify(currentPassword, u.password_hash)) throw Object.assign(new Error('that is not your current password'), { status: 403 });
  if (String(newPassword || '').length < 8) throw Object.assign(new Error('the new password must be at least 8 characters'), { status: 400 });
  if (verify(newPassword, u.password_hash)) throw Object.assign(new Error('that is the password you already have - pick a different one'), { status: 400 });
  db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE username = ?').run(hash(newPassword), u.username);
  return shape(getUser(u.username));
}
