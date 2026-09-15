/* Getting a count started: the header picker, creating one with its lists, and
   the guided checklist that says what is still missing. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { expandSubTabs, pickSession } from './helpers.mjs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const BINS = readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8');
const PALLETS = readFileSync(`${S}fixtures/pallets.csv`, 'utf8');

/* ---------------- the checklist is computed, not remembered ---------------- */
const empty = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'bare count' }) }));
let st = await j(await fetch(`${BASE}/api/admin/sessions/${empty.id}/setup`, { headers: A }));
check('A brand new count is not ready, and says what is blocking it',
  st.ready === false && st.blocking.includes('bins') && st.blocking.includes('plan'), st.blocking.join(', '));
check('A full count lists the steps a full count needs',
  st.steps.map((x) => x.key).join(',') === 'bins,pallets,scanners,layout,blocks,crew,plan', st.steps.map((x) => x.key).join(','));
check('The inventory report is recommended on a full count, not blocking',
  st.steps.find((x) => x.key === 'pallets').need === 'wanted');
check('Each step says why it matters, not just that it is missing',
  st.steps.every((x) => x.why && x.why.length > 30 && x.detail));

await fetch(`${BASE}/api/admin/sessions/${empty.id}/master?kind=bins`, { method: 'POST', headers: { authorization: A.authorization, 'content-type': 'text/csv' }, body: BINS });
st = await j(await fetch(`${BASE}/api/admin/sessions/${empty.id}/setup`, { headers: A }));
const binStep = st.steps.find((x) => x.key === 'bins');
check('Uploading the bin list ticks that step off, with the real numbers',
  binStep.done && /13,673 bins in 28 aisles/.test(binStep.detail), binStep.detail);
check('...and it is no longer blocking', !st.blocking.includes('bins'), st.blocking.join(', '));

/* ---------------- a cycle count needs different things ---------------- */
const cyc = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'cycle programme', mode: 'cycle' }) }));
const cst = await j(await fetch(`${BASE}/api/admin/sessions/${cyc.id}/setup`, { headers: A }));
check('A cycle count gets its own steps — a batch, no aisle plan',
  cst.steps.map((x) => x.key).join(',') === 'bins,pallets,scanners,batch', cst.steps.map((x) => x.key).join(','));
check('...and the inventory report IS required there, for the last-counted dates',
  cst.steps.find((x) => x.key === 'pallets').need === 'required' && cst.blocking.includes('pallets'));
check('The setup of a session that does not exist is a 404',
  (await fetch(`${BASE}/api/admin/sessions/999999/setup`, { headers: A })).status === 404);
check('It needs a sign-in like everything else', (await fetch(`${BASE}/api/admin/sessions/${cyc.id}/setup`)).status === 401);

/* ================= in the browser ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 1.25 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/40[19]/.test(m.text())) errors.push(m.text()); });

/* ---- the header picker ---- */
await page.goto(BASE + '/admin');
await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(2200);
check('Dashboard: the session picker is in the header, not buried in a card',
  (await page.$('#sessionPick .sess-btn')) !== null && (await page.$('#fSessionPick')) === null);
await page.click('#sessionPick .sess-btn'); await page.waitForTimeout(500);
const apiCount = (await j(await fetch(`${BASE}/api/admin/sessions`, { headers: A }))).length;
check('Picker: it opens a menu with a row per count',
  (await page.$$('#sessionPick .sess-row')).length === apiCount, `${(await page.$$('#sessionPick .sess-row')).length} rows for ${apiCount} sessions`);
const firstRow = clean(await page.textContent('#sessionPick .sess-row'));
check('Picker: a row carries the type, the name and the progress — not just a name',
  /FULL|CYCLE/.test(firstRow) && /bins|no bin list/.test(firstRow), firstRow.slice(0, 90));
check('Picker: a cycle count is marked differently from a full one',
  (await page.$$('#sessionPick .sess-kind.cycle')).length >= 1 && (await page.$$('#sessionPick .sess-kind.full')).length >= 1);
check('Picker: open and closed counts are grouped',
  (await page.$$eval('#sessionPick .sess-head', (h) => h.map((x) => x.textContent))).some((t) => /Open/.test(t)));
await page.click(`#sessionPick .sess-row[data-id="${empty.id}"]`); await page.waitForTimeout(1800);
check('Picker: choosing one switches the whole page to it',
  /bare count/.test(await page.textContent('#sessionPick .sess-btn'))
    && new RegExp(`#${empty.id} `).test(clean(await page.textContent('#sessionCardSub'))),
  clean(await page.textContent('#sessionCardSub')));
await page.screenshot({ path: `${S}screenshots/session-picker.png`, clip: { x: 0, y: 0, width: 1000, height: 560 } });

/* ---- creating a count with its lists ---- */
await page.fill('#fNewName', 'count with its lists');
await page.setInputFiles('#fNewBins', { name: 'bins.csv', mimeType: 'text/csv', buffer: Buffer.from(BINS) });
await page.setInputFiles('#fNewPallets', { name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from(PALLETS) });
await page.click('#btnCreate');
await page.waitForFunction(() => /Created/.test(document.getElementById('sessionMsg').textContent), null, { timeout: 60000 });
await page.waitForTimeout(1500);
const created = clean(await page.textContent('#sessionMsg'));
check('Creating a count uploads the bin list and the inventory report with it',
  /Created full count/.test(created) && /bins\.csv/.test(created) && /report\.csv/.test(created), created.slice(0, 150));
const madeId = (await j(await fetch(`${BASE}/api/admin/sessions`, { headers: A }))).find((x) => x.name === 'count with its lists').id;
const madeState = await j(await fetch(`${BASE}/api/admin/sessions/${madeId}/setup`, { headers: A }));
check('...and both land on the new count, not on the one that was open before',
  madeState.steps.find((x) => x.key === 'bins').done && madeState.steps.find((x) => x.key === 'pallets').done,
  madeState.steps.filter((x) => x.done).map((x) => x.key).join(','));

/* ---- the guided setup ---- */
await page.goto(BASE + '/settings');
await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1800);
check('Settings: Getting started is the first sub-tab',
  (await page.$eval('#subTabs button', (b) => b.textContent.trim())) === 'Getting started');
await page.evaluate(() => window.appApi.showSub('start')); await page.waitForTimeout(1500);
await pickSession(page, empty.id).catch(() => {});
await page.selectOption('#fSessionPick', String(empty.id)).catch(() => {});
await page.waitForTimeout(1800);
check('Setup: every step is on screen with a status and an action',
  (await page.$$('#startSteps li')).length === 7 && (await page.$$('#startSteps li button')).length === 7,
  `${(await page.$$('#startSteps li')).length} steps`);
check('Setup: the done step is marked done and the blocking ones are flagged',
  (await page.$$('#startSteps li.done')).length >= 1 && (await page.$$('#startSteps li.blocking')).length >= 1,
  `${(await page.$$('#startSteps li.done')).length} done, ${(await page.$$('#startSteps li.blocking')).length} blocking`);
check('Setup: it says how many things still block counting',
  /still needed before anyone can scan/.test(await page.textContent('#startMsg')), clean(await page.textContent('#startMsg')).slice(0, 80));
check('Setup: a step explains itself rather than just naming a file',
  /what the system thinks is on hand/i.test(await page.textContent('#startSteps')), '');
await page.screenshot({ path: `${S}screenshots/setup-guide.png` });
const jump = await page.$('#startSteps li.blocking button');
await jump.click(); await page.waitForTimeout(900);
check('Setup: its button takes you to the place that does it',
  /lists|scanners/.test(await page.evaluate(() => location.hash)) || (await page.$eval('[data-sub="lists"]', (el) => el.classList.contains('active'))),
  await page.evaluate(() => location.hash));

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} setup-guide checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
