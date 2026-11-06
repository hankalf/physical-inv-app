/*
 * The guide down an aisle walks forward. A bin the team passed - the report
 * expected two, one was there - does not drag them back mid-aisle: the guide
 * points at the next bin ahead and brings the passed ones up at the end, as
 * "Go back to". A bin that cannot be counted now is skipped with a reason,
 * which goes on the fix list; counting it later takes it off.
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
const get = async (p) => j(await fetch(BASE + p, { headers: A }));
const pj = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));

/* six bins, a pallet in each; F01A002 expects two and has one */
const S = (await pj('/api/admin/sessions', { name: 'Guide forward' })).id;
let bins = 'Bin Location,Zone,Aisle\n';
for (let i = 1; i <= 6; i++) bins += `F01A${String(i).padStart(3, '0')},Freezer,F01\n`;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: bins });
let pal = 'Pallet ID,SKU,Description,Qty,Location\n';
for (let i = 1; i <= 6; i++) pal += `P${i},SKU-${i},Item ${i},10,F01A${String(i).padStart(3, '0')}\n`;
pal += 'P2B,SKU-2,Item 2 again,10,F01A002\n';
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: pal });
await pj(`/api/admin/sessions/${S}/settings`, { guided: true, askComments: false, autoRecount: false });
await pj(`/api/admin/sessions/${S}/assignments`, { team: '1', aisles: 'F01', levels: 'A', force: true });
const dev = await pj('/api/admin/devices', { name: 'FWD-01' });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 } });
gun.on('pageerror', (e) => errors.push(e.message));
gun.on('dialog', (dd) => dd.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(600);
await gun.selectOption('#fSession', String(S));
await gun.fill('#fTeam', '1'); await gun.fill('#fEmployee', 'E1'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active', { timeout: 90000 });
await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(600);
const banner = async () => clean(await gun.textContent('#nextBin'));
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
const count = async (pallet, bin) => { await scan(pallet); await scan('10'); await scan(bin); await gun.waitForTimeout(500); };

check('The guide starts at F01A001', /Next bin\s*F01A001/.test(await banner()), await banner());
await count('P1', 'F01A001');
await count('P2', 'F01A002');
check('F01A002 expects two tags and has one: "Still in this bin", 1 of 2', /Still in this bin\s*F01A002/.test(await banner()) && /1 of 2 tags/.test(await banner()), await banner());
/* the team walks on: the guide walks with them */
await count('P4', 'F01A004');
check('Counting F01A004 next: the guide points ahead at F01A005, noting 2 passed (A002 unfinished, A003 not counted)', /Next bin\s*F01A005/.test(await banner()) && /2 passed/.test(await banner()), await banner());
await count('P5', 'F01A005');
await count('P6', 'F01A006');
check('At the end of the aisle it brings the team back: "Go back to F01A002 · passed earlier · 2 to go back to"', /Go back to\s*F01A002/.test(await banner()) && /passed earlier · 2 to go back to/.test(await banner()), await banner());
await gun.click('#btnBinDone').catch(() => {});   // not offered here: Go back to has a Skip instead
/* skip one of them: a reason, the fix list, the guide moves on */
check('A Skip this bin button is offered on the guide', await gun.isVisible('#btnBinSkip'));
await gun.click('#btnBinSkip'); await gun.waitForTimeout(200);
check('…tapping it shows the reasons', await gun.isVisible('#binSkipReasons') && (await gun.locator('#binSkipReasons button[data-skip-reason]').count()) === 4);
await gun.click('#binSkipReasons button[data-skip-reason="Cannot reach it"]'); await gun.waitForTimeout(1200);
check('Skip F01A002 "Cannot reach it": the guide moves on to F01A003, and the gun says what it did', /Go back to\s*F01A003/.test(await banner()) && /F01A002 skipped/.test(clean(await gun.textContent('#scanMsg'))), `${await banner()} | ${clean(await gun.textContent('#scanMsg'))}`);
const fix = await get(`/api/admin/sessions/${S}/fixlist`);
const sk = fix.rows.find((r) => r.bin === 'F01A002');
check('…and it is on the fix list as a blocked bin, with the reason and the team', sk && sk.kind === 'blocked' && /Skipped on the gun: Cannot reach it/.test(sk.reason) && sk.team === '1' && sk.status === 'open', JSON.stringify(fix.rows.map((r) => [r.bin, r.kind, r.reason])));
await count('P3', 'F01A003');
check('The last passed bin counted: the aisle is whole except the skipped one, and the banner says which', /Every bin in F01 has a count except 1 skipped: F01A002/.test(await banner()), await banner());
/* the team gets to it after all */
await count('P2B', 'F01A002');
check('Counting the skipped bin takes it off the skipped list: F01A002 now has 2 of 2, every bin has a count', /Every bin in F01 has a count — tell your supervisor/.test(await banner()), await banner());
check('No page errors', !errors.length, errors.join(' | '));
await gun.screenshot({ path: new URL('./screenshots/gun-skip-bin.png', import.meta.url).pathname }).catch(() => {});
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
