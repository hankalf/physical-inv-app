/*
 * Reset on the Classroom training card, seen from the scanners.
 *
 * A gun signed on to the training count, or to the classroom cycle count, while
 * the trainer presses Reset for the next class: within a sync or two it has to
 * look like a fresh start - nothing counted in the aisle, the guide back at the
 * first bin, History empty, a pallet counted before the reset countable again,
 * the cycle list back to all six bins - without anybody signing off.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });

const t = await j(await post('/api/admin/training', {}));
const S = t.session.id, C = t.cycle.id;
await post('/api/admin/scanner-layout', { order: ['bin', 'pallet', 'qty'] });
const dev = await j(await post('/api/admin/devices', { name: 'TRAIN-GUN' }));
const cdev = await j(await post('/api/admin/devices', { name: 'TRAIN-CYC' }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const open = async (uid) => {
  const g = await browser.newPage({ viewport: { width: 400, height: 780 } });
  g.on('pageerror', (e) => errors.push(e.message));
  g.on('dialog', (d) => d.accept());
  await g.goto(`${BASE}/?d=${uid}`);
  await g.waitForSelector('#scrSignon.active'); await g.waitForTimeout(600);
  return g;
};
const scanOn = (g) => async (v) => {
  await g.waitForSelector('#scrScan.active #fScan', { timeout: 5000 });
  await g.fill('#fScan', v); await g.press('#fScan', 'Enter');
  await g.waitForFunction(() => document.getElementById('fScan').value === '', null, { timeout: 5000 }).catch(() => {});
  await g.waitForTimeout(300);
};
/* the gun's own lines, from its store */
const lines = (g) => g.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('invcount');
  req.onsuccess = () => { const all = req.result.transaction('lines', 'readonly').objectStore('lines').getAll(); all.onsuccess = () => resolve(all.result); };
}));
/* a sync, as the twenty-second tick does it */
const tick = async (g) => { await g.evaluate(() => window.dispatchEvent(new Event('online'))); await g.waitForTimeout(1200); };

/* ---------------- a team on the full training count ---------------- */
const gun = await open(dev.uid);
await gun.selectOption('#fSession', String(S));
await gun.fill('#fTeam', 'S1-DS01');
await gun.fill('#fEmployee', 'TRN-01'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active'); await gun.waitForTimeout(500);
await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(300);
const scan = scanOn(gun);
await scan('T01A001'); await scan('TRN-1001'); await scan('40');
await gun.waitForTimeout(1200);
await tick(gun);
const before = clean(await gun.textContent('#nextBin'));
check('Before: T01A001 counted, the guide past it', !/T01A001/.test(before), before);

/* ---------------- the cycle list on another gun ---------------- */
const cyc = await open(cdev.uid);
await cyc.click('#btnModeCycle'); await cyc.waitForTimeout(300);
await cyc.selectOption('#fSession', String(C));
await cyc.fill('#fEmployee', 'TRN-07'); await cyc.press('#fEmployee', 'Enter');
await cyc.click('#btnStart'); await cyc.waitForSelector('#scrAssign.active'); await cyc.waitForTimeout(600);
await cyc.click('#btnRecounts'); await cyc.waitForSelector('#scrScan.active'); await cyc.waitForTimeout(400);
const cscan = scanOn(cyc);
await cscan('T01A002'); await cscan('TRN-1002'); await cscan('32');
await cscan('T01A002'); await cscan('TRN-1003'); await cscan('28');
await cyc.waitForTimeout(1500);
await tick(cyc);
const listBefore = clean(await cyc.textContent('#recountBanner').catch(() => '')) + ' | ' + clean(await cyc.textContent('#scanMsg').catch(() => ''));
await cyc.click('#btnRecountDone').catch(() => {}); await cyc.waitForTimeout(1200); await tick(cyc);
const cycBefore = clean(await cyc.textContent('#recountBanner').catch(() => ''));
check('Before: the cycle gun finished its first bin and moved on', !/T01A002/.test(cycBefore), cycBefore);

/* ---------------- the trainer presses Reset ---------------- */
const reset = await j(await post('/api/admin/training/reset', {}));
check('Reset cleared both counts on the server', reset.counted.lines === 0 && reset.cycle.lines === 0 && reset.cycle.done === 0, JSON.stringify(reset.cleared));

/* the gun on the full count: within a sync or two, without signing off */
for (let i = 0; i < 3; i++) await tick(gun);
await gun.waitForTimeout(16000); await tick(gun); await tick(gun);
const after = clean(await gun.textContent('#nextBin'));
check('Full count gun: the guide is back at the first bin', /T01A001/.test(after), after);
const mine = (await lines(gun)).filter((l) => l.sessionId === S);
check('…the lines counted before the reset are gone from the gun', mine.length === 0, `${mine.length} left`);
check('…it says the trainer reset it, not that it is the real count now', /trainer reset this count/i.test(clean(await gun.textContent('#scanMsg'))) && !/real count/i.test(clean(await gun.textContent('#scanMsg'))), clean(await gun.textContent('#scanMsg')));
if (!(await gun.isVisible('#scrScan.active'))) { await gun.click('#btnCount').catch(() => {}); await gun.waitForTimeout(500); }
await scan('T01A001'); await scan('TRN-1001');
check('…a pallet counted before the reset is countable again: no "already counted"', !/already counted/i.test(clean(await gun.textContent('#scrScan'))) && /CANTIDAD|QUANTITY|qty/i.test(clean(await gun.textContent('#stepTitle').catch(() => '')) + clean(await gun.textContent('#scrScan'))), clean(await gun.textContent('#scanMsg')));
await scan('40'); await gun.waitForTimeout(1200); await tick(gun);
await gun.click('#btnHistory'); await gun.waitForSelector('#scrHistory.active'); await gun.waitForTimeout(300);
const hist = await gun.$$eval('#historyList .item', (els) => els.map((e) => e.textContent));
check('…History holds only what was counted since', hist.length === 1 && /TRN-1001/.test(hist[0]), `${hist.length}: ${hist.map((h) => h.slice(0, 30)).join(' | ')}`);

/* the cycle gun */
for (let i = 0; i < 3; i++) await tick(cyc);
await cyc.waitForTimeout(16000); await tick(cyc); await tick(cyc);
const banner = clean(await cyc.textContent('#recountBanner').catch(() => ''));
check('Cycle gun: straight back to the first bin of the six', await cyc.isVisible('#scrScan.active') && /T01A002/.test(banner), banner);
check('…and it says the trainer reset it', /trainer reset this count/i.test(clean(await cyc.textContent('#scanMsg'))), clean(await cyc.textContent('#scanMsg')));
await cscan('T01A002'); await cscan('TRN-1002'); await cscan('32'); await cscan('T01A002'); await cscan('TRN-1003'); await cscan('28');
await cyc.click('#btnRecountDone').catch(() => {}); await cyc.waitForTimeout(1500); await tick(cyc);
const st = await j(await fetch(`${BASE}/api/admin/training`, { headers: A }));
check('…and counting it again lands on the new list: one of six done', st.cycle.done === 1 && st.cycle.lines === 2, JSON.stringify(st.cycle));
const cl = (await lines(cyc)).filter((l) => l.sessionId === C);
check('…the gun holds only the two lines counted since the reset', cl.length === 2 && cl.every((l) => /TRN-100[23]/.test(l.palletId)), `${cl.length} lines`);

check('No page errors', !errors.length, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
