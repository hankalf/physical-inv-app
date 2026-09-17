/*
 * The comments step used to wait five seconds. It waits two now.
 *
 * A new default only reaches a site that never saved the setting, and this one
 * had - so the number a counter actually waits would have stayed at five until
 * somebody knew to go and change it. The app moves that one value once on the
 * way up, and leaves a site that chooses five alone.
 *
 * Proving that needs the app started twice against the same database, which is
 * what this suite does with servers of its own.
 */
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = new URL('.', import.meta.url).pathname;
const dataDir = mkdtempSync(join(tmpdir(), 'upgrade-'));
const DB = join(dataDir, 'upgrade.db');
let port = 3501;

/** Start the app on this database, run fn against it, then stop it. */
async function withApp(fn) {
  const at = port++;
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(at), DB_PATH: DB, ADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${at}`;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still coming up */ }
      await wait(200);
    }
    const tok = (await j(await fetch(`${base}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
    return await fn({ base, A: { ...hdr, authorization: 'Bearer ' + tok }, log: () => log });
  } finally {
    server.kill();
    await wait(300);
  }
}

try {
  /* ---- a site running the old version, with its reasons saved ---- */
  await withApp(async ({ base, A }) => {
    const saved = await j(await fetch(`${base}/api/admin/scanner-prompts`, { method: 'POST', headers: A,
      body: JSON.stringify({ comments: ['Damaged', 'Frozen to the rack'], commentTimeout: 5 }) }));
    check('A site on the old version has five seconds saved', saved.commentTimeout === 5, String(saved.commentTimeout));
  });

  /* The database now looks like one the old version left behind: settings saved,
     and no record of a version that knows about the two-second default. */
  {
    const raw = new DatabaseSync(DB);
    raw.exec("DELETE FROM settings WHERE key = 'commentTimeoutMovedTo2'");
    raw.close();
  }

  /* ---- the upgrade ---- */
  const note = await withApp(async ({ base, A, log }) => {
    const now = await j(await fetch(`${base}/api/admin/scanner-prompts`, { headers: A }));
    check('Restarting on the new version moves it to two', now.commentTimeout === 2, String(now.commentTimeout));
    check('...and leaves the reasons that site chose alone',
      now.comments.join('|') === 'Damaged|Frozen to the rack', now.comments.join('|'));
    check('...and says so in the start-up log, rather than changing it quietly',
      /comments step: moved from 5s to 2s/.test(log()), (log().split('\n').find((l) => /comments step/.test(l)) || '').trim());
    const audit = await j(await fetch(`${base}/api/admin/audit?limit=20`, { headers: A }));
    check('...and in the log a supervisor reads', audit.some((r) => /comments step moved from 5s to 2s/.test(r.detail || '')));
    return true;
  });
  void note;

  /* ---- a site that wants five keeps five ---- */
  await withApp(async ({ base, A }) => {
    const back = await j(await fetch(`${base}/api/admin/scanner-prompts`, { method: 'POST', headers: A, body: JSON.stringify({ commentTimeout: 5 }) }));
    check('A supervisor who wants five can set it back', back.commentTimeout === 5, String(back.commentTimeout));
  });
  await withApp(async ({ base, A }) => {
    const still = await j(await fetch(`${base}/api/admin/scanner-prompts`, { headers: A }));
    check('And the next restart leaves it alone — the move happens once, not every boot',
      still.commentTimeout === 5, String(still.commentTimeout));
  });

  /* ---- a site that never saved anything just gets the new default ---- */
  const fresh = mkdtempSync(join(tmpdir(), 'upgrade2-'));
  const freshDb = join(fresh, 'new.db');
  const at = port++;
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(at), DB_PATH: freshDb, ADMIN_PASSWORD: 'changeme' }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    const base = `http://127.0.0.1:${at}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still coming up */ }
      await wait(200);
    }
    const tok = (await j(await fetch(`${base}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
    const def = await j(await fetch(`${base}/api/admin/scanner-prompts`, { headers: { authorization: 'Bearer ' + tok } }));
    check('A site with nothing saved simply ships at two', def.commentTimeout === 2 && def.isDefault === true, String(def.commentTimeout));
  } finally {
    server.kill();
    await wait(200);
    rmSync(fresh, { recursive: true, force: true });
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} upgrade checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
