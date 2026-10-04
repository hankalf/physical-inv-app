/*
 * The superadmin: the one login a site starts with, put in the database at
 * startup from the environment (Railway variables). There is no shared
 * password any more - a password typed with no username is the superadmin's.
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
const PW = 'the-railway-password';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

const dir = mkdtempSync(join(tmpdir(), 'superadmin-'));
const DB = join(dir, 'inv.db');

let dbSeq = 0;
async function boot(extra, fn, { freshDb = false } = {}) {
  const db = freshDb ? join(dir, `scratch-${++dbSeq}.db`) : DB;
  const env = { ...process.env, PORT: String(PORT), DB_PATH: db, BACKUP_DIR: join(dir, 'b'), ...extra };
  for (const k of ['ADMIN_PASSWORD', 'SUPERADMIN_USER', 'SUPERADMIN_PASSWORD', 'SUPERADMIN_NAME']) if (!(k in extra)) delete env[k];
  const srv = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
const SA = { SUPERADMIN_USER: 'ROBIN', SUPERADMIN_NAME: 'Robin Vance', SUPERADMIN_PASSWORD: PW };

/* ---- seeded, and it is a real admin ---- */
let tok = '';
await boot(SA, async (log) => {
  check('It creates the account on first boot', /superadmin: created ROBIN/.test(log()));
  const res = await asUser('ROBIN', PW);
  check('The superadmin signs in with the Railway password', res.ok, String(res.status));
  const me = await j(res);
  tok = me.token;
  check('...as a real admin, under its own name, not a starter', me.role === 'admin' && me.name === 'Robin Vance' && me.mustChange === false,
    `${me.name} (${me.role}) mustChange=${me.mustChange}`);
  check('...and it can do admin things, like manage logins', (await fetch(`${BASE}/api/admin/users`, { headers: { authorization: 'Bearer ' + tok } })).ok);
  const bare = await login({ password: PW });
  check('A password typed with no username is the superadmin\'s', bare.ok && (await j(bare)).username === 'ROBIN', String(bare.status));
  check('There is no shared password: a made-up name is refused', (await login({ username: 'Somebody', name: 'Somebody', password: PW })).status === 401);
  check('Seeding it is recorded in the audit log',
    (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: { authorization: 'Bearer ' + tok } })))
      .some((r) => r.action === 'created the superadmin account'), '');
  check('The username is normalised the same as any other', (await asUser('robin', PW)).ok, 'lowercase works');
});

/* ---- the one that matters: a restart must not undo a password change ---- */
await boot(SA, async (log) => {
  check('A restart leaves the existing account alone', /already exists, left untouched/.test(log()));
  const t = (await j(await asUser('ROBIN', PW))).token;
  const changed = await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: { ...hdr, authorization: 'Bearer ' + t }, body: JSON.stringify({ current: PW, next: 'robin-picked-this-one' }) });
  check('The superadmin can change its own password', changed.ok);
});
await boot(SA, async () => {
  check('After a restart the chosen password still works', (await asUser('ROBIN', 'robin-picked-this-one')).ok);
  check('...and the environment password no longer opens it — a restart is not a way back in',
    (await asUser('ROBIN', PW)).status === 401, 'seeding never overwrites');
});

/* ---- older deployments: ADMIN_PASSWORD alone still seeds an ADMIN login ---- */
await boot({ ADMIN_PASSWORD: 'a-different-secret' }, async (log) => {
  check('ADMIN_PASSWORD on its own seeds a superadmin called ADMIN', /superadmin: created ADMIN/.test(log()) && (await asUser('ADMIN', 'a-different-secret')).ok);
  check('...and a bare password opens it', (await login({ password: 'a-different-secret' })).ok);
}, { freshDb: true });

/* ---- a weak password is allowed through with a warning, never silently ---- */
await boot({ ...SA, SUPERADMIN_PASSWORD: 'changeme' }, async (log) => {
  check('A "changeme" password is seeded with a loud warning', /created ROBIN/.test(log()) && /password is "changeme"/.test(log()) && (await asUser('ROBIN', 'changeme')).ok);
}, { freshDb: true });

/* ---- bad input must never stop the app coming up ---- */
await boot({ SUPERADMIN_USER: 'not a username!', SUPERADMIN_PASSWORD: PW }, async (log) => {
  check('A malformed username is refused, and the app still starts',
    /not a valid username/.test(log()) && (await fetch(`${BASE}/api/health`)).ok,
    (log().split('\n').find((l) => /not a valid username/.test(l)) || '').trim());
  check('...and it says plainly that nobody can sign in', /NO admin account/.test(log()));
}, { freshDb: true });
await boot({ SUPERADMIN_USER: 'SHORTY', SUPERADMIN_PASSWORD: 'abc' }, async (log) => {
  check('A too-short password is refused, and the app still starts',
    /at least 8 characters/.test(log()) && (await fetch(`${BASE}/api/health`)).ok);
  check('...with no way in at all, since there is no shared password', (await login({ password: 'abc' })).status === 401);
}, { freshDb: true });

/* ---- nothing set: nothing seeded, and it says so ---- */
await boot({}, async (log) => {
  check('With nothing set nothing is seeded, and the log says nobody can sign in', !/superadmin:/.test(log()) && /NO admin account/.test(log()));
}, { freshDb: true });

rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} superadmin checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
