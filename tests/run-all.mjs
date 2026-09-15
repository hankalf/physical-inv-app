/*
 * npm test — runs every suite in a real browser against a freshly started app.
 *
 * Each suite gets its own server and its own database: they create sessions,
 * teams and scanners by name, and would otherwise trip over each other's.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const BASE_PORT = Number(process.env.PORT || 3111);
const SUITES = process.argv.slice(2).length
  ? process.argv.slice(2).map((n) => (n.endsWith('.mjs') ? n : `${n}.mjs`))
  : ['full-count.mjs', 'cycle-count.mjs', 'roster.mjs', 'ops.mjs', 'scanner-auth.mjs', 'settings.mjs', 'board.mjs', 'lockout.mjs', 'superadmin.mjs', 'setup-guide.mjs', 'recount-threshold.mjs', 'scanner-prompts.mjs', 'gun-guidance.mjs'];

mkdirSync(join(HERE, 'screenshots'), { recursive: true });

async function withServer(port, fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'invtest-'));
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dataDir, 'test.db'), ADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode}:\n${log}`);
      try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error(`the server never answered on ${base}\n${log}`);
    return await fn(base);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 250));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const run = (file, base) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, file)], { env: { ...process.env, BASE_URL: base }, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code === 0));
  });

const failed = [];
let port = BASE_PORT;
for (const suite of SUITES) {
  console.log(`\n──────── ${suite} ────────`);
  try {
    const ok = await withServer(port++, (base) => run(suite, base));
    if (!ok) failed.push(suite);
  } catch (err) {
    console.error(err.message);
    failed.push(suite);
  }
}

if (failed.length) {
  console.error(`\nFAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nAll suites passed.');
