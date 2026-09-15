/*
 * Turning the shared password off must never brick the deployment.
 *
 * This suite runs its own servers, because the thing under test is an
 * environment variable read at startup.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const PORT = 3179;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = 'a-real-admin-password';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

const dataDir = mkdtempSync(join(tmpdir(), 'lockout-'));
const DB = join(dataDir, 'inv.db');

async function withServer(sharedSetting, fn) {
  const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_PASSWORD: PW, BACKUP_DIR: join(dataDir, 'b') };
  if (sharedSetting !== undefined) env.SHARED_PASSWORD_LOGIN = sharedSetting;
  const srv = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, '..', 'src', 'server.js')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return await fn(() => log);
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 350));
  }
}
const shared = (name = 'Dana') => fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: PW, name }) });
const asUser = (username, password) => fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username, password }) });

/* ---- 1. off, with nobody to sign in as: held open ---- */
let starter = '';
await withServer('off', async (log) => {
  const res = await shared();
  check('Off with no admin account: the shared password is still accepted', res.ok, String(res.status));
  check('...and the server says so loudly at startup',
    /no admin account yet/.test(log()) && /STILL ACCEPTED/.test(log()),
    (log().split('\n').find((l) => /STILL ACCEPTED/.test(l)) || '').trim());
  const me = await j(await fetch(`${BASE}/api/admin/me`, { headers: { authorization: 'Bearer ' + (await j(res)).token } }));
  check('...and says it in the API, so the page can explain itself', me.sharedLoginHeldOpen === true && me.admins === 0, JSON.stringify({ held: me.sharedLoginHeldOpen, admins: me.admins }));

  const tok = (await j(await shared())).token;
  const A = { ...hdr, authorization: 'Bearer ' + tok };
  // a supervisor is NOT enough to shut the door - only an admin can reopen it
  await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'SAM', name: 'Sam Ortiz' }) });
  check('A plain supervisor does not close the door — they cannot manage accounts',
    (await shared()).ok, 'still accepted with only a supervisor');

  const made = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'DANA', name: 'Dana Whitfield', role: 'admin' }) }));
  starter = made.starterPassword;
  check('Adding an admin closes it immediately, with no redeploy', (await shared()).status === 401, `starter ${starter}`);
  check('The refusal tells them what to do instead', /username and password/.test((await j(await shared())).error), (await j(await shared())).error);
});

/* ---- 2. it stays shut across a restart ---- */
await withServer('off', async (log) => {
  check('It stays shut after a restart', (await shared()).status === 401);
  check('The startup banner reports the state plainly',
    /shared password: off/.test(log()) && /1 admin account/.test(log()),
    (log().split('\n').find((l) => /admin account/.test(l)) || '').trim());
  const first = await asUser('DANA', starter);
  check('The admin can still sign in with their starter', first.ok && (await j(first)).mustChange === true);
});

/* ---- 3. the way back in, if it is ever needed ---- */
await withServer('on', async () => {
  check('Putting SHARED_PASSWORD_LOGIN back to on lets you in again', (await shared()).ok);
});

/* ---- 4. the default is unchanged ---- */
await withServer(undefined, async () => {
  check('With the variable unset the shared password works as it always did', (await shared()).ok);
});

/* ---- 5. deactivating the last admin reopens the door rather than sealing it ---- */
await withServer('off', async () => {
  const tok = (await j(await asUser('DANA', starter))).token;
  const A = { ...hdr, authorization: 'Bearer ' + tok };
  await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: A, body: JSON.stringify({ current: starter, next: 'dana-own-password' }) });
  const tok2 = (await j(await asUser('DANA', 'dana-own-password'))).token;
  const A2 = { ...hdr, authorization: 'Bearer ' + tok2 };
  const gone = await fetch(`${BASE}/api/admin/users/DANA`, { method: 'DELETE', headers: A2 });
  check('The last admin still cannot delete themselves', gone.status === 409, String(gone.status));
  check('...so the door cannot be sealed from the inside either', (await asUser('DANA', 'dana-own-password')).ok);
});

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} lockout checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
