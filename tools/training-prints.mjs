/*
 * The classroom prints as PDFs, for the training bundle: the wall (big and small
 * labels, the trainer's key) and the pocket cards in English and Spanish. The same
 * pages an admin prints from Testing Suite → Classroom training, rendered on a
 * throwaway copy of the app so nothing touches a real database.
 *
 *   node tools/training-prints.mjs      -> docs/training/print/*.pdf
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const OUT = process.env.OUT || join(ROOT, 'docs', 'training', 'print');
const PORT = Number(process.env.PORT || 3419);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'training-prints-'));
mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'prints.db'), SUPERADMIN_USER: 'DANA-WHITFIELD', SUPERADMIN_NAME: 'Dana Whitfield', SUPERADMIN_PASSWORD: 'changeme' },
  stdio: 'ignore',
});
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  const hdr = { 'content-type': 'application/json' };
  const tok = (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) })).json()).token;
  const r = await fetch(`${BASE}/api/admin/training`, { method: 'POST', headers: { ...hdr, authorization: 'Bearer ' + tok }, body: '{}' });
  if (!r.ok) throw new Error(`could not set the training count up: ${r.status}`);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage();
  const pdf = async (path, file) => {
    await page.goto(`${BASE}${path}&t=${tok}`);
    await page.waitForTimeout(400);
    await page.pdf({ path: join(OUT, file), format: 'Letter', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    console.log(`${join(OUT, file)} written`);
  };
  await pdf('/api/admin/training/print/wall?size=big', 'training-wall-labels-big.pdf');
  await pdf('/api/admin/training/print/wall?size=small', 'training-wall-labels-small.pdf');
  await pdf('/api/admin/training/print/wall?part=key', 'training-wall-trainers-key.pdf');
  await pdf('/api/admin/training/print/pocket-card?lang=en', 'scanner-pocket-card-en.pdf');
  await pdf('/api/admin/training/print/pocket-card?lang=es', 'scanner-pocket-card-es.pdf');
} finally {
  if (browser) await browser.close();
  srv.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
