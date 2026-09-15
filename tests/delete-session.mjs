/* Deleting a count: the only thing here that cannot be undone. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { expandSubTabs } from './helpers.mjs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const BINS = readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8');
const PALLETS = readFileSync(`${S}fixtures/pallets.csv`, 'utf8');

const make = async (name, { withCounts = false } = {}) => {
  const s = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name }) }));
  await fetch(`${BASE}/api/admin/sessions/${s.id}/master?kind=bins`, { method: 'POST', headers: csv, body: BINS });
  await fetch(`${BASE}/api/admin/sessions/${s.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: PALLETS });
  if (withCounts) {
    const d = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'DEL-' + s.id }) }));
    const dt = (await j(await fetch(`${BASE}/api/devices/${d.uid}`, { method: 'POST' }))).token;
    const rows = PALLETS.trim().split('\n').slice(1).map((l) => l.split(',')).filter((c) => /^F01/.test(c[5] || '')).slice(0, 8);
    await fetch(`${BASE}/api/sessions/${s.id}/counts`, { method: 'POST', headers: { ...hdr, authorization: 'Device ' + dt },
      body: JSON.stringify(rows.map((c, i) => ({ clientId: `d${s.id}-${i}`, palletId: c[0], qty: Number(c[4]), location: c[5], team: '1', deviceId: 'DEL-' + s.id }))) });
  }
  return s;
};
const close = (id) => fetch(`${BASE}/api/admin/sessions/${id}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'closed' }) });
const del = (id, body = {}) => fetch(`${BASE}/api/admin/sessions/${id}`, { method: 'DELETE', headers: A, body: JSON.stringify(body) });
const exists = async (id) => (await j(await fetch(`${BASE}/api/admin/sessions`, { headers: A }))).some((x) => x.id === id);

/* ---------------- an open count cannot be deleted ---------------- */
const open1 = await make('still running', { withCounts: true });
const openTry = await del(open1.id);
check('An open count cannot be deleted at all', openTry.status === 409 && /close the count first/.test((await j(openTry)).error), (await j(await del(open1.id))).error);
check('...and it is still there', await exists(open1.id));

/* ---------------- an empty one goes without ceremony ---------------- */
const empty = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'made by mistake' }) }));
await close(empty.id);
const goneEmpty = await del(empty.id);
check('A count with nothing in it deletes without needing its name typed', goneEmpty.ok, String(goneEmpty.status));
check('...and it is gone', !(await exists(empty.id)));

/* ---------------- one with counted lines needs its name back ---------------- */
const real = await make('Q3 wall-to-wall', { withCounts: true });
await close(real.id);
const peek = await j(await fetch(`${BASE}/api/admin/sessions/${real.id}`, { headers: A }));
check('The page can ask what a delete would destroy, before asking to confirm',
  peek.contents.counts === 8 && peek.contents.bins === 13673 && peek.contents.pallets === 486,
  `${peek.contents.counts} lines, ${peek.contents.bins} bins, ${peek.contents.pallets} pallets`);
const noName = await del(real.id);
check('A count holding lines refuses to go without its name typed back',
  noName.status === 409 && /type its name exactly/.test((await j(noName)).error), '');
const wrongName = await del(real.id, { confirmName: 'q3 wall to wall' });
check('...and a near-miss is not good enough', wrongName.status === 409, String(wrongName.status));
check('...it is still there after both refusals', await exists(real.id));
check('A refused delete leaves no backup behind — it is checked before anything expensive happens',
  (await j(await fetch(`${BASE}/api/admin/backups`, { headers: A }))).backups.filter((b) => /before-delete/.test(b.name)).length === 0,
  (await j(await fetch(`${BASE}/api/admin/backups`, { headers: A }))).backups.map((b) => b.name).join(', '));

const before = (await j(await fetch(`${BASE}/api/admin/backups`, { headers: A }))).backups.length;
const gone = await j(await del(real.id, { confirmName: 'Q3 wall-to-wall' }));
check('With the name typed it goes', !(await exists(real.id)) && gone.id === real.id);
check('...and a copy of the database was taken first, because it held counts',
  !!gone.backup && (await j(await fetch(`${BASE}/api/admin/backups`, { headers: A }))).backups.length === before + 1, gone.backup || 'none');

/* ---------------- everything under it goes too ---------------- */
const orphans = await j(await fetch(`${BASE}/api/admin/sessions/${real.id}/setup`, { headers: A }).then(async (r) => ({ json: async () => ({ status: r.status }) })));
check('Its setup, and so its rows, are gone with it', orphans.status === 404, String(orphans.status));
check('Deleting it does not touch the other counts', await exists(open1.id));

/* ---------------- the record outlives the count ---------------- */
const log = await j(await fetch(`${BASE}/api/admin/audit?limit=40`, { headers: A }));
const entry = log.find((r) => r.action === 'DELETED a count');
check('The audit log keeps what was destroyed, after the count is gone',
  !!entry && /Q3 wall-to-wall/.test(entry.detail) && /8 counted lines/.test(entry.detail) && /backed up first/.test(entry.detail),
  (entry?.detail || '').slice(0, 120));

/* ---------------- it stops being the scanners' default ---------------- */
const dflt = await make('the default one');
await fetch(`${BASE}/api/admin/default-session`, { method: 'POST', headers: A, body: JSON.stringify({ sessionId: dflt.id }) });
check('It is the default to begin with', (await j(await fetch(`${BASE}/api/admin/default-session`, { headers: A }))).sessionId === dflt.id);
await close(dflt.id);
await del(dflt.id, { confirmName: 'the default one' });
check('Deleting the default clears it, rather than pointing scanners at nothing',
  (await j(await fetch(`${BASE}/api/admin/default-session`, { headers: A }))).sessionId === 0);

check('Deleting needs a sign-in', (await fetch(`${BASE}/api/admin/sessions/${open1.id}`, { method: 'DELETE' })).status === 401);
check('Deleting one that never existed is a 404', (await del(999999)).status === 404);

/* ================= on the dashboard ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/admin');
await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); await page.waitForTimeout(2200);
check('Dashboard: delete is offered but disabled while the count is open',
  await page.$eval('#btnDeleteSession', (b) => b.disabled) && /Close the count first/.test(await page.$eval('#btnDeleteSession', (b) => b.title)),
  await page.$eval('#btnDeleteSession', (b) => b.title));

const ui = await make('delete me from the page', { withCounts: true });
await close(ui.id);
await page.reload(); await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); await page.waitForTimeout(2200);
await page.evaluate((id) => window.appApi && document.querySelector(`#sessionPick .sess-row[data-id="${id}"]`)?.click(), ui.id).catch(() => {});
await page.click('#sessionPick .sess-btn'); await page.waitForTimeout(400);
await page.click(`#sessionPick .sess-row[data-id="${ui.id}"]`); await page.waitForTimeout(2000);
check('Dashboard: once closed, delete is live', !(await page.$eval('#btnDeleteSession', (b) => b.disabled)));

// it warns, asks for the name, and a cancelled prompt leaves it alone
let asked = '';
let cancelTheName = true;
page.on('dialog', async (d) => {
  if (d.type() === 'confirm') { asked = d.message(); await d.accept(); return; }
  if (cancelTheName) await d.dismiss();
  else await d.accept('delete me from the page');
});
await page.click('#btnDeleteSession'); await page.waitForTimeout(1500);
check('Dashboard: cancelling the name prompt leaves the count alone', await exists(ui.id));
check('Dashboard: it says exactly what will go before it asks',
  /counted lines/.test(asked) && /cannot be undone/.test(asked), clean(asked).slice(0, 120));

cancelTheName = false;
await page.click('#btnDeleteSession');
await page.waitForFunction(() => /Deleted|Not deleted/.test(document.getElementById('sessionMsg').textContent), null, { timeout: 20000 });
await page.waitForTimeout(1500);
check('Dashboard: the count is deleted and the page says where the backup went',
  !(await exists(ui.id)) && /Deleted/.test(await page.textContent('#sessionMsg')) && /backup|copy of the database/i.test(await page.textContent('#sessionMsg')),
  clean(await page.textContent('#sessionMsg')).slice(0, 130));
check('Dashboard: the header picker no longer offers it',
  !(await page.$(`#sessionPick .sess-row[data-id="${ui.id}"]`)));
await page.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} delete-session checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
