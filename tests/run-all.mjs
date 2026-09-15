/*
 * npm test — boots the app on a scratch database and runs every suite against
 * it in a real browser. Exits non-zero if anything fails, so a broken import or
 * a regression cannot be pushed quietly.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const SUITES = process.argv.slice(2).length
  ? process.argv.slice(2).map((n) => (n.endsWith('.mjs') ? n : `${n}.mjs`))
  : ['full-count.mjs', 'cycle-count.mjs', 'roster.mjs'];

mkdirSync(join(HERE, 'screenshots'), { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'invtest-'));

const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, '..', 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'test.db'), ADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
server.on('exit', (code) => {
  if (code !== null && code !== 0) {
    console.error(`\nThe server exited with code ${code}:\n${serverLog}`);
    process.exit(1);
  }
});

const stop = () => { server.kill(); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server never answered on ${BASE}\n${serverLog}`);
}

const run = (file) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, file)], { env: { ...process.env, BASE_URL: BASE }, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code === 0));
  });

const health = await waitForServer();
console.log(`app up on ${BASE} — site clock ${health.siteTimezone}, today ${health.siteDate}\n`);

const failed = [];
for (const suite of SUITES) {
  console.log(`\n──────── ${suite} ────────`);
  const ok = await run(suite);
  if (!ok) failed.push(suite);
}

stop();
if (failed.length) {
  console.error(`\nFAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nAll suites passed.');
