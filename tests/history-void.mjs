/*
 * History on the gun is the team's own: the lines the signed-on team counted on
 * this scanner, in the last twenty bins it scanned - not the crew before them.
 * Voiding a line sends the team back to that bin: the guide points at it until a
 * count lands there again.
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
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* one aisle of 24 bins, a pallet in each */
const bins = Array.from({ length: 24 }, (_, i) => `H01A${String(i + 1).padStart(3, '0')}`);
await (async () => {
  const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'History count' }) }));
  globalThis.S = sess.id;
})();
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\n' + bins.map((b) => `${b},Dry,H01`).join('\n') + '\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location\n' + bins.map((b, i) => `HP-${i + 1},SKU-${i + 1},Item ${i + 1},${10 + i},${b}`).join('\n') + '\n' });
await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ order: ['bin', 'pallet', 'qty'] }) });
await fetch(`${BASE}/api/admin/sessions/${S}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: true, askComments: false, autoRecount: false }) });
await fetch(`${BASE}/api/admin/sessions/${S}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '7', aisles: 'H01', levels: 'A-F', force: true }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'HIST-01' }) }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 400, height: 780 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
const scan = async (v) => {
  await gun.waitForSelector('#scrScan.active #fScan', { timeout: 5000 });
  await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter');
  await gun.waitForFunction(() => document.getElementById('fScan').value === '', null, { timeout: 5000 }).catch(() => {});
  await gun.waitForTimeout(260);
};
const signOn = async (team, badge) => {
  await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(500);
  await gun.selectOption('#fSession', String(S));
  await gun.fill('#fTeam', team);
  await gun.fill('#fEmployee', badge); await gun.press('#fEmployee', 'Enter');
  await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active'); await gun.waitForTimeout(500);
  await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(300);
};
const countBin = async (i) => { await scan(bins[i]); await scan(`HP-${i + 1}`); await scan(String(10 + i)); };

/* the first crew counts two bins on this gun, then signs off */
await gun.goto(`${BASE}/?d=${dev.uid}`);
await signOn('7', 'E7001');
await countBin(0); await countBin(1);
await gun.waitForTimeout(900);   // the last line lands before the crew signs off
await gun.click('#btnSignoff').catch(() => {}); await gun.waitForTimeout(600);
if (!(await gun.isVisible('#scrSignon.active'))) { await gun.click('#btnToAssign').catch(() => {}); await gun.waitForTimeout(300); await gun.click('#btnSignoff'); await gun.waitForTimeout(600); }
// the aisle goes back to team 7 for the next crew: the same team number, a different person, is the common case - so use another team for the "not yours" check
await fetch(`${BASE}/api/admin/sessions/${S}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '8', aisles: 'H01', levels: 'A-F', force: true }) });
const plan = await j(await fetch(`${BASE}/api/admin/sessions/${S}/assignments`, { headers: A }));
for (const a of plan.filter((x) => x.team === '7')) await fetch(`${BASE}/api/admin/sessions/${S}/assignments/${a.id}`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'done' }) });
await fetch(`${BASE}/api/admin/sessions/${S}/assignments/${plan.find((x) => x.team === '8').id}`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'active' }) }).catch(() => {});

/* the second crew, team 8, on the same gun: 22 bins, then History */
await signOn('8', 'E8001');
check('Team 8 is counting the aisle on the same gun', /H01/.test(clean(await gun.textContent('#scrScan'))));
for (let i = 2; i < 24; i++) await countBin(i);
await gun.click('#btnHistory'); await gun.waitForSelector('#scrHistory.active'); await gun.waitForTimeout(300);
const items = await gun.$$eval('#historyList .item .top span:first-child', (els) => els.map((e) => e.textContent));
check('Lines pair pallet and bin as scanned', items.includes('HP-24 @ H01A024') && items.includes('HP-10 @ H01A010'), items.slice(0, 3).join(' | '));
check('History holds team 8\'s lines only, in its last 20 bins: not team 7\'s two bins, not team 8\'s first two', items.length === 20 && items.every((t) => !/H01A00[1-4]\b/.test(t)) && items[0].includes('H01A024') && items[19].includes('H01A005'), `${items.length} · ${items[0]} … ${items[items.length - 1]}`);
check('…and the screen says whose lines they are', /Your team/.test(clean(await gun.textContent('#scrHistory'))));

/* void the line in H01A010: back to that bin */
const row = gun.locator('#historyList .item', { hasText: 'H01A010' });
await row.locator('button').click(); await gun.waitForTimeout(700);
check('Void sends the team back to the scan screen, the guide pointing at that bin', await gun.isVisible('#scrScan.active') && /Go back to/.test(clean(await gun.textContent('#nextBin'))) && /H01A010/.test(clean(await gun.textContent('#nextBin'))) && /a line was voided here/.test(clean(await gun.textContent('#nextBin'))), clean(await gun.textContent('#nextBin')));
check('…with the message saying what to do', /Line voided — go back to H01A010/.test(clean(await gun.textContent('#scanMsg'))), clean(await gun.textContent('#scanMsg')));
await countBin(9);
check('A count landing in that bin ends the redirect: the guide moves on', !/Go back to/.test(clean(await gun.textContent('#nextBin'))), clean(await gun.textContent('#nextBin')));
await gun.click('#btnHistory'); await gun.waitForSelector('#scrHistory.active'); await gun.waitForTimeout(300);
check('History shows the voided line crossed out and the new one', (await gun.$$('#historyList .item.voided')).length === 1 && (await gun.$$eval('#historyList .item', (els) => els.filter((e) => /H01A010/.test(e.textContent)).length)) === 2);
const voided = (await j(await fetch(`${BASE}/api/admin/sessions/${S}/pallets?limit=50`, { headers: A }))).rows.find((r) => r.pallet_id === 'HP-10');
check('…and the office has the new count for that pallet', voided && Number(voided.counted_qty ?? voided.counted ?? voided.qty) === 19, JSON.stringify(voided && { status: voided.status, counted: voided.counted_qty ?? voided.counted }));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
