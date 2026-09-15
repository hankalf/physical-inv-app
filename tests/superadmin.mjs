/*
 * The seeded superadmin: a real admin login put in the database at startup, so
 * a site never has to bootstrap through the shared password.
 *
 * Its own servers, because seeding happens at boot from the environment.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const PORT = 3177;
const BASE = `http://127.0.0.1:${PORT}`;
const SHARED = 'the-railway-password';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

const dir = mkdtempSync(join(tmpdir(), 'superadmin-'));
const DB = join(dir, 'inv.db');

let dbSeq = 0;
async function boot(extra, fn, { freshDb = false } = {}) {
  const db = freshDb ? join(dir, `scratch-${++dbSeq}.db`) : DB;
  const srv = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, '..', 'src', 'server.js')],
    { env: { ...process.env, PORT: String(PORT), DB_PATH: db, BACKUP_DIR: join(dir, 'b'), ADMIN_PASSWORD: SHARED, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return await fn(() => log);
  } finally { srv.kill(); await new Promise((r) => setTimeout(r, 350)); }
}
const login = (body) => fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
const asUser = (username, password) => login({ username, password });
const asShared = () => login({ password: SHARED, name: 'Somebody' });
const SA = { SUPERADMIN_USER: 'ROBIN', SUPERADMIN_NAME: 'Robin Vance' };

/* ---- it refuses to put a live admin behind the default password ---- */
await boot({ ...SA, ADMIN_PASSWORD: 'changeme' }, async (log) => {
  // "changeme" IS the shared password here, so that sign-in succeeds as the
  // shared password - the point is that no ADMIN ACCOUNT was created behind it.
  const tk = (await j(await login({ password: 'changeme', name: 'Checker' }))).token;
  const { users } = await j(await fetch(`${BASE}/api/admin/users`, { headers: { authorization: 'Bearer ' + tk } }));
  check('It will not seed an admin whose password would be "changeme"',
    /not created: its password would be/.test(log()) && users.length === 0,
    `${users.length} account(s) created`);
}, { freshDb: true });

/* ---- seeded, and it is a real admin ---- */
let tok = '';
await boot({ ...SA, SHARED_PASSWORD_LOGIN: 'off' }, async (log) => {
  check('It creates the account on first boot', /superadmin: created ROBIN/.test(log()));
  const res = await asUser('ROBIN', SHARED);
  check('The superadmin signs in with the Railway password', res.ok, String(res.status));
  const me = await j(res);
  tok = me.token;
  check('...as a real admin, under its own name, not a starter', me.role === 'admin' && me.name === 'Robin Vance' && me.mustChange === false,
    `${me.name} (${me.role}) mustChange=${me.mustChange}`);
  check('...and it can do admin things, like manage logins', (await fetch(`${BASE}/api/admin/users`, { headers: { authorization: 'Bearer ' + tok } })).ok);
  check('Because a real admin now exists, the shared password is refused',
    (await asShared()).status === 401, 'SHARED_PASSWORD_LOGIN=off took effect');
  check('Seeding it is recorded in the audit log',
    (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: { authorization: 'Bearer ' + tok } })))
      .some((r) => r.action === 'created the superadmin account'), '');
  check('The username is normalised the same as any other', (await asUser('robin', SHARED)).ok, 'lowercase works');
});

/* ---- the one that matters: a restart must not undo a password change ---- */
await boot({ ...SA, SHARED_PASSWORD_LOGIN: 'off' }, async (log) => {
  check('A restart leaves the existing account alone', /already exists, left untouched/.test(log()));
  const t = (await j(await asUser('ROBIN', SHARED))).token;
  const changed = await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: { ...hdr, authorization: 'Bearer ' + t }, body: JSON.stringify({ current: SHARED, next: 'robin-picked-this-one' }) });
  check('The superadmin can change its own password', changed.ok);
});
await boot({ ...SA, SHARED_PASSWORD_LOGIN: 'off' }, async () => {
  check('After a restart the chosen password still works', (await asUser('ROBIN', 'robin-picked-this-one')).ok);
  check('...and the environment password no longer opens it — a restart is not a way back in',
    (await asUser('ROBIN', SHARED)).status === 401, 'seeding never overwrites');
});

/* ---- a separate password, for sites that want the two different ---- */
await boot({ SUPERADMIN_USER: 'OPS.LEAD', SUPERADMIN_PASSWORD: 'a-different-secret', SHARED_PASSWORD_LOGIN: 'off' }, async () => {
  check('SUPERADMIN_PASSWORD can differ from the shared password', (await asUser('OPS.LEAD', 'a-different-secret')).ok);
  check('...and the shared password does not open it', (await asUser('OPS.LEAD', SHARED)).status === 401);
});

/* ---- bad input must never stop the app coming up ---- */
await boot({ SUPERADMIN_USER: 'not a username!', SHARED_PASSWORD_LOGIN: 'off' }, async (log) => {
  check('A malformed username is refused, and the app still starts',
    /not a valid username/.test(log()) && (await fetch(`${BASE}/api/health`)).ok,
    (log().split('\n').find((l) => /not a valid username/.test(l)) || '').trim());
}, { freshDb: true });
await boot({ SUPERADMIN_USER: 'SHORTY', SUPERADMIN_PASSWORD: 'abc', SHARED_PASSWORD_LOGIN: 'off' }, async (log) => {
  check('A too-short password is refused, and the app still starts',
    /at least 8 characters/.test(log()) && (await fetch(`${BASE}/api/health`)).ok);
  check('...and with still no admin, the shared password is held open rather than locking out',
    (await asShared()).ok, 'the lockout guard covers a failed seed too');
}, { freshDb: true });

/* ---- unset: nothing changes ---- */
await boot({}, async (log) => {
  check('With SUPERADMIN_USER unset nothing is seeded', !/superadmin:/.test(log()));
}, { freshDb: true });

rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} superadmin checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
