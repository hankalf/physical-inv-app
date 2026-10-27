/*
 * The classroom prints as PDFs, for the training bundle: the wall (big and small
 * labels, the trainer's key) and the pocket cards in English and Spanish. The same
 * pages an admin prints from Testing Suite → Classroom training, rendered on a
 * throwaway copy of the app so nothing touches a real database.
 *
 *   node tools/training-prints.mjs      -> docs/training/print/*.pdf
 *   TEAMS=S1-DS01,S1-DS01,S2-RT05 (or TEAMS=a-file.txt, one per line) also renders the pocket
 *   cards two-sided, each person's team card on the back.
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  await pdf('/api/admin/training/print/roster?x=1', 'training-roster.pdf');
  for (const l of ['en', 'es']) {
    await pdf(`/api/admin/training/print/checkoff?lang=${l}&count=4`, `scanner-check-off-${l}.pdf`);
    await pdf(`/api/admin/training/print/quiz?lang=${l}`, `scanner-quiz-${l}.pdf`);
  }
  await pdf('/api/admin/training/print/words?x=1', 'scanner-words-en-es.pdf');
  /* the same pieces as Word documents, to edit */
  const file = async (path, name) => {
    const r = await fetch(`${BASE}${path}`, { headers: { authorization: 'Bearer ' + tok } });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    writeFileSync(join(OUT, name), Buffer.from(await r.arrayBuffer()));
    console.log(`${join(OUT, name)} written`);
  };
  await file('/api/admin/training/print/pocket-card.docx?lang=en', 'scanner-pocket-card-en.docx');
  await file('/api/admin/training/print/pocket-card.docx?lang=es', 'scanner-pocket-card-es.docx');
  await file('/api/admin/training/print/wall.docx', 'training-wall.docx');
  await file('/api/admin/training/roster.docx', 'training-roster.docx');
  await file('/api/admin/guides/admin/run-the-training-day.docx', 'run-the-training-day.docx');
  await file('/api/admin/guides/on-the-scanner.docx', 'on-the-scanner.docx');
  await file('/api/admin/guides/en-el-escaner.docx', 'en-el-escaner.docx');
  for (const l of ['en', 'es']) {
    await file(`/api/admin/training/print/checkoff.docx?lang=${l}&count=4`, `scanner-check-off-${l}.docx`);
    await file(`/api/admin/training/print/quiz.docx?lang=${l}`, `scanner-quiz-${l}.docx`);
  }
  await file('/api/admin/training/print/words.docx', 'scanner-words-en-es.docx');
  const raw = process.env.TEAMS || '';
  const teams = (raw && existsSync(raw) ? readFileSync(raw, 'utf8') : raw).split(/[\s,;]+/).filter(Boolean);
  if (teams.length) {
    await pdf(`/api/admin/training/print/pocket-card?lang=en&teams=${encodeURIComponent(teams.join(','))}`, 'scanner-pocket-cards-two-sided-en.pdf');
    await pdf(`/api/admin/training/print/pocket-card?lang=es&teams=${encodeURIComponent(teams.join(','))}`, 'scanner-pocket-cards-two-sided-es.pdf');
    await file(`/api/admin/training/print/pocket-card.docx?lang=en&teams=${encodeURIComponent(teams.join(','))}`, 'scanner-pocket-cards-two-sided-en.docx');
    await file(`/api/admin/training/print/pocket-card.docx?lang=es&teams=${encodeURIComponent(teams.join(','))}`, 'scanner-pocket-cards-two-sided-es.docx');
    console.log(`${teams.length} two-sided cards`);
  }
} finally {
  if (browser) await browser.close();
  srv.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
