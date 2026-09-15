/* Configuring the counting screen, and the preview drawn at real device size. */
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

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'layout test' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: readFileSync(`${S}fixtures/pallets.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'LAYOUT-01' }) }));

/* ---------------- the settings ---------------- */
const def = await j(await fetch(`${BASE}/api/admin/scanner-layout`, { headers: A }));
check('It ships asking pallet, quantity, bin — with lot and expiry in place for the counts that use them',
  def.order.join(',') === 'pallet,qty,lot,expiry,bin' && def.isDefault === true, def.order.join(','));
const rev = await j(await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ order: ['bin', 'pallet', 'qty'], textSize: 'large', confirmOver: 500 }) }));
check('The order can be changed to location-first', rev.order.slice(0, 3).join(',') === 'bin,pallet,qty', rev.order.join(','));
const half = await j(await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ order: ['bin'] }) }));
check('A question can never be dropped by accident — the rest are put back',
  half.order.length === 5 && half.order[0] === 'bin', half.order.join(','));
check('...and other settings survive a partial save', half.textSize === 'large' && half.confirmOver === 500, `${half.textSize}, ${half.confirmOver}`);
check('Editing it needs a sign-in', (await fetch(`${BASE}/api/admin/scanner-layout`)).status === 401);

/* ================= the gun really asks in that order ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(900);
await gun.selectOption('#fSession', String(sess.id));
await gun.fill('#fTeam', '1'); await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForTimeout(2500);
if (await gun.$('#scrAssign.active')) await gun.click('#btnCount');
await gun.waitForSelector('#scrScan.active', { timeout: 20000 }); await gun.waitForTimeout(600);

check('Gun: it asks for the bin first now', /BIN LOCATION/.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
check('Gun: large text is applied', await gun.evaluate(() => document.body.classList.contains('big-text')));
const pallets = readFileSync(`${S}fixtures/pallets.csv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
const p1 = pallets.find((c) => /^F01/.test(c[5] || ''));
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
await scan(p1[5]);
check('Gun: then the pallet', /PALLET ID/.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
await scan(p1[0]);
check('Gun: then the quantity', /QUANTITY/.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
await scan(String(p1[4]));
await gun.waitForTimeout(1800);
check('Gun: and the line commits on the last question, whichever one that is',
  /PALLET|BIN/.test(await gun.textContent('#prompt')), clean(await gun.textContent('#prompt')));
const stored = (await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text()).trim().split('\n');
check('Gun: the line is complete — pallet, quantity and bin all landed',
  stored.length === 2 && stored[1].includes(p1[0]) && stored[1].includes(p1[5]), stored[1]?.slice(0, 70));
await gun.close();

/* ================= the preview ================= */
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 1.25 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(BASE + '/settings');
await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1800);
check('Settings: the scanner screen has its own sub-tab',
  (await page.$$eval('#subTabs button', (b) => b.map((x) => x.textContent.trim()))).includes('Scanner screen'));
await page.evaluate(() => window.appApi.showSub('gun')); await page.waitForTimeout(1200);

check('Preview: the questions are listed in order, draggable', (await page.$$('#stepOrder li')).length === 5
  && (await page.$$eval('#stepOrder li', (l) => l.map((x) => x.dataset.step))).slice(0, 3).join(',') === 'bin,pallet,qty',
  (await page.$$eval('#stepOrder li', (l) => l.map((x) => x.dataset.step))).join(','));
const size = await page.$eval('#gunFrame', (f) => ({ w: f.width, h: f.height }));
check('Preview: it is drawn at the MC9090\'s real screen size', String(size.w) === '240' && String(size.h) === '320', `${size.w} × ${size.h}`);
check('Preview: the device is named', /MC9090/.test(await page.textContent('#deviceNote')), clean(await page.textContent('#deviceNote')));
const inFrame = async (sel) => {
  const f = await (await page.$('#gunFrame')).contentFrame();
  return clean(await f.textContent(sel));
};
check('Preview: it shows the first question as the gun would', /BIN LOCATION/.test(await inFrame('.prompt')), await inFrame('.prompt'));
check('Preview: it uses the gun\'s own stylesheet, so it cannot drift',
  await page.$eval('#gunFrame', async (f) => !!f.contentDocument.querySelector('link[href="/styles.css"]')));
await page.selectOption('#fDevice', 'mc9200'); await page.waitForTimeout(600);
const big = await page.$eval('#gunFrame', (f) => ({ w: f.width, h: f.height }));
check('Preview: switching to the MC9200 redraws at 480 × 640', String(big.w) === '480' && String(big.h) === '640', `${big.w} × ${big.h}`);
await page.selectOption('#fPreviewStep', 'qty'); await page.waitForTimeout(600);
check('Preview: a later step shows what has been answered so far',
  /QUANTITY/.test(await inFrame('.prompt')) && /F01A001/.test(await inFrame('.context')), await inFrame('.prompt'));
await page.screenshot({ path: `${S}screenshots/gun-layout.png` });

await page.uncheck('#fShowNextBin'); await page.waitForTimeout(500);
const f2 = await (await page.$('#gunFrame')).contentFrame();
check('Preview: turning the bin guide off takes it out of the preview too',
  (await f2.$$('.nextbin')).length === 0);
await page.click('#btnSaveGun'); await page.waitForTimeout(900);
check('Settings: saving says what the scanners will ask', /bin → pallet id → quantity/.test(await page.textContent('#gunMsg')), clean(await page.textContent('#gunMsg')).slice(0, 100));
const saved = await j(await fetch(`${BASE}/api/admin/scanner-layout`, { headers: A }));
check('Settings: and it is stored', saved.order.slice(0, 3).join(',') === 'bin,pallet,qty' && saved.showNextBin === false, JSON.stringify({ o: saved.order.join(','), n: saved.showNextBin }));
check('Changing it is recorded in the log',
  (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }))).some((r) => r.action === 'changed the scanner screen layout'));
await page.click('#btnResetGun'); await page.waitForTimeout(500);
check('Settings: the defaults can be put back', (await page.$$eval('#stepOrder li', (l) => l.map((x) => x.dataset.step))).join(',') === 'pallet,qty,lot,expiry,bin',
  (await page.$$eval('#stepOrder li', (l) => l.map((x) => x.dataset.step))).join(','));
await page.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} gun-layout checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
