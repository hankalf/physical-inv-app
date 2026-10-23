/*
 * The report's cost: a difference read in money as well as cases. The
 * inventory report carries Cost and Amount (quantity × cost); the pallet
 * report, adjustments and overviews show the money; and second counts,
 * third counts and approvals can be raised by what a difference is worth.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: A.authorization, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));

/* the site's report, as it comes: Cost and Amount on every row, one row with Amount alone, one with no cost at all */
const REPORT = `Bin Code,Container No.,Item No.,Description,Variant Code,Quantity,Unit of Measure Code,Entry No.,Lot No.,System,Cost,Amount
V01A001,FR10247661,OOOB229832,BAG: OO Org Mango 32oz,,"2,400.",BAG,2207965,INABVA260409J-1,JustFood,0.16589,398.136
V01A002,FR10006042,OOOB326110,BAG: OO Org Blackberries 10oz,,"34,025.",BAG,1081941,46372,JustFood,0.08591,2923.08775
V01A003,FR10249946,SKCB432716,BAG: SKC Conv Strawberry and Banana 16oz,,"10,600.",BAG,2262578,PO104515,JustFood,,1142.786
V01A004,FR10275707,OOOB465110,BAG: Pineapple Chunks 10 oz,,"1,000.",BAG,2625259,127527,JustFood,,
V01A005,FR10248469,OOOB135932,BAG: Strawberries&Bananas Family Pack 32oz,DIST,"2,400.",BAG,2541491,INABVA260409J-1,JustFood,0.21708,520.992
V01A006,FR10247670,OOOB229832,BAG: OO Org Mango 32oz,,"1,000.",BAG,2207970,INABVA260409J-1,JustFood,,
`;
const BINS = 'Bin Location,Zone,Aisle\n' + ['V01A001', 'V01A002', 'V01A003', 'V01A004', 'V01A005', 'V01A006'].map((b) => `${b},Dry,V01`).join('\n') + '\n';
async function count(name, settings = {}) {
  const S = (await j(await post('/api/admin/sessions', { name }))).id;
  await post(`/api/admin/sessions/${S}/master?kind=bins`, BINS, csv);
  const up = await j(await post(`/api/admin/sessions/${S}/master?kind=pallets`, REPORT, csv));
  await post(`/api/admin/sessions/${S}/settings`, { autoRecount: false, askComments: false, guided: false, ...settings });
  return { S, up };
}
const dev = await j(await post('/api/admin/devices', { name: 'COST-01' }));
const G = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
let n = 0;
const line = (pallet, qty, bin, extra = {}) => ({ clientId: `cv${++n}`, palletId: pallet, qty, location: bin, team: '3', deviceId: 'COST-01', scannedAt: new Date().toISOString(), ...extra });

/* ---------------- the report carries the money ---------------- */
const a = await count('Priced count');
check('The upload reads the site\'s columns: six pallets, four of them priced on the report', a.up.pallets === 6 && a.up.withCost === 4, JSON.stringify({ pallets: a.up.pallets, withCost: a.up.withCost }));
check('…a row with no cost takes its item\'s cost from the item\'s other rows; an item priced nowhere is named', a.up.costFilled === 1 && a.up.unpriced === 1 && a.up.unpricedItems.join() === 'OOOB465110 ×1', JSON.stringify([a.up.costFilled, a.up.unpriced, a.up.unpricedItems]));
let dl = await (await fetch(`${BASE}/api/admin/sessions/${a.S}/export/master.csv`, { headers: A })).text();
let lines = dl.trim().split(/\r?\n/);
check('The loaded report downloads with Cost, Amount and where the cost came from', /,Cost,Amount,Cost Source$/.test(lines[0]) && lines.some((l) => /^JUSTFOOD,FR10247661,.*,0\.16589,398\.136,report$/.test(l)), lines.find((l) => /FR10247661/.test(l)));
check('…Amount alone gives the cost (1142.786 over 10,600 = 0.10781); a row with neither has neither', lines.some((l) => /^JUSTFOOD,FR10249946,.*,0\.10781,1142\.786,report$/.test(l)) && lines.some((l) => /^JUSTFOOD,FR10275707,.*,,,,,$/.test(l)), lines.filter((l) => /FR10249946|FR10275707/.test(l)).join(' | '));
check('…and the filled row carries the item\'s cost, its amount worked out, marked item', lines.some((l) => /^JUSTFOOD,FR10247670,.*,1000,V01A006,.*,0\.16589,165\.89,item$/.test(l)), lines.find((l) => /FR10247670/.test(l)));

/* counts: one over, one under, one short of a pricey pallet, one matches, one has no cost */
await post(`/api/sessions/${a.S}/counts`, [
  line('FR10247661', 2500, 'V01A001'),   // +100 bags at 0.16589 = +$16.59
  line('FR10006042', 33000, 'V01A002'),  // -1,025 at 0.08591 = -$88.06
  line('FR10249946', 10600, 'V01A003'),  // matches
  line('FR10275707', 900, 'V01A004'),    // -100, no cost
  line('FR10248469', 1400, 'V01A005'),   // -1,000 at 0.21708 = -$217.08
], G);
let rows = (await get(`/api/admin/sessions/${a.S}/pallets?limit=100`)).rows;
const R = (id) => rows.find((x) => x.pallet_id === id);
check('The pallet report prices each difference at the report\'s cost', R('FR10247661').cost === 0.16589 && R('FR10247661').expected_amount === 398.14 && R('FR10247661').counted_amount === 414.73 && R('FR10247661').variance_amount === 16.59, JSON.stringify([R('FR10247661').cost, R('FR10247661').expected_amount, R('FR10247661').counted_amount, R('FR10247661').variance_amount]));
check('…a short pallet is a negative value; a pallet with no cost has none', R('FR10248469').variance_amount === -217.08 && R('FR10275707').cost === '' && R('FR10275707').variance_amount === '' && R('FR10275707').variance_qty === -100, JSON.stringify([R('FR10248469').variance_amount, R('FR10275707').cost, R('FR10275707').variance_amount]));
/* the scanner never sees money: not on its pallet list, not on its sign-on, not on its second-count tasks */
const gunList = await get(`/api/sessions/${a.S}/master`, G);
const gunJson = JSON.stringify(gunList);
check('The scanner\'s pallet list carries no cost or amount - not the words, not the figures - and nothing about the money thresholds', gunList.pallets.length === 6 && !/cost|amount|minValue|min_value/i.test(gunJson) && !/0\.16589|398\.1|2923\.0|0\.21708|520\.99/.test(gunJson), JSON.stringify([gunList.pallets.length, (gunJson.match(/.{0,30}(cost|amount|minValue|min_value).{0,30}/i) || [])[0], (gunJson.match(/0\.16589|398\.1|2923\.0|0\.21708|520\.99/) || [])[0]]));
check('…nor does what the scanner fetches for second counts', !/cost|amount|\$/.test(JSON.stringify(await get(`/api/sessions/${a.S}/recounts`, G))) && !/cost|amount|\$/.test(JSON.stringify(await get(`/api/sessions/${a.S}/team-status?team=3&employees=`, G))));
const p = await get(`/api/admin/sessions/${a.S}/progress`);
check('Progress carries the count in money: the report\'s value, counted so far, the difference, over and under', p.value && p.value.expected === 5150.9 && p.value.variance === -288.55 && p.value.over === 16.59 && p.value.under === -305.14, JSON.stringify(p.value));
const av = await get(`/api/admin/sessions/${a.S}/adjustments/view`);
check('Adjustments: positive and negative in money too, and the unpriced line counted', av.positive.value === 16.59 && av.negative.value === -305.14 && av.negative.unpriced === 1 && av.netValue === -288.55, JSON.stringify([av.positive.value, av.negative.value, av.negative.unpriced, av.netValue]));
const ic = await get(`/api/admin/sessions/${a.S}/inventory-control`);
check('…and the Inventory Control overview says the same', ic.adjustments.netValue === -288.55 && ic.adjustments.negative.value === -305.14, JSON.stringify(ic.adjustments));
const pc = await (await fetch(`${BASE}/api/admin/sessions/${a.S}/export/pallets.csv`, { headers: A })).text();
check('The pallet report CSV has the cost and value columns', /variance_qty,cost,cost_source,expected_amount,counted_amount,variance_amount,/.test(pc.split(/\r?\n/)[0]) && pc.split(/\r?\n/).some((l) => /^FR10248469,/.test(l) && /,0\.21708,report,520\.99,303\.91,-217\.08,/.test(l)), pc.split(/\r?\n/).find((l) => /^FR10248469/.test(l)));
const ev = await get(`/api/admin/sessions/${a.S}/export/everything`);
const sheet = (name) => ev.sheets.find((s) => s.name === name);
check('Export everything: the Pallets sheet has Unit cost and the values, Adjustments its value', sheet('Pallets').columns.includes('Unit cost') && sheet('Pallets').columns.includes('Difference value') && sheet('Pallets').rows.find((r) => r.Pallet === 'FR10248469')['Difference value'] === -217.08 && sheet('Adjustments').columns.includes('Adjustment value'), JSON.stringify(sheet('Pallets').rows.find((r) => r.Pallet === 'FR10248469')));

/* ---------------- second counts by value ---------------- */
let r = await post(`/api/admin/sessions/${a.S}/settings`, { recountMinQty: 0, recountMinPct: 0, recountMinValue: 100 });
check('The money threshold is a setting of the count', r.status === 200 && (await j(r)).recount_min_value === 100, JSON.stringify(await (await fetch(`${BASE}/api/admin/sessions/${a.S}`, { headers: A })).json().then((s) => s.recount_min_value)));
let gen = await j(await post(`/api/admin/sessions/${a.S}/recounts/generate`, {}));
let rc = await get(`/api/admin/sessions/${a.S}/recounts`);
const bins = rc.filter((t) => t.status !== 'done').map((t) => t.bin).sort().join();
check('Raise from all variances at "worth over $100": only the -$217 pallet comes back; the $17, the $88 and the unpriced -100 do not', bins === 'V01A005' && gen.skippedSmall === 3, `${bins} · ${gen.skippedSmall} under the threshold`);
await post(`/api/admin/sessions/${a.S}/settings`, { recountMinQty: 50, recountMinValue: 100 });
gen = await j(await post(`/api/admin/sessions/${a.S}/recounts/generate`, {}));
rc = await get(`/api/admin/sessions/${a.S}/recounts`);
check('Over 50 units OR worth over $100: any one threshold is enough - the +100, the unpriced -100 and the -1,025 come back too', rc.filter((t) => t.status !== 'done').map((t) => t.bin).sort().join() === 'V01A001,V01A002,V01A004,V01A005', rc.map((t) => t.bin).join());

/* ---------------- approvals by value ---------------- */
await post(`/api/admin/sessions/${a.S}/settings`, { requireApproval: true, approvalMinQty: 0, approvalMinPct: 0, approvalMinValue: 50 });
const adj = await get(`/api/admin/sessions/${a.S}/adjustments`);
const st = (id) => (adj.adjustments.find((x) => x.pallet_id === id) || {}).status;
check('Approve when worth over $50: the -$88 and -$217 lines wait for a signature; the +$17 goes through; the unpriced -100 goes through too', st('FR10006042') === 'pending' && st('FR10248469') === 'pending' && st('FR10247661') === 'auto' && st('FR10275707') === 'auto', JSON.stringify(adj.adjustments.map((x) => [x.pallet_id, x.status])));

/* ---------------- third counts by value ---------------- */
const b = await count('Third by value', { thirdCount: true, autoRecount: true, thirdMinValue: 150 });
await post(`/api/sessions/${b.S}/counts`, [line('FR10247661', 2000, 'V01A001'), line('FR10248469', 1400, 'V01A005')], G);   // -400 at $0.166 = $66; -1,000 at $0.217 = $217
rc = await get(`/api/admin/sessions/${b.S}/recounts`);
const task = (bin) => rc.find((t) => t.bin === bin && Number(t.round) !== 3);
check('Both differences raise second counts (no money threshold on those here)', !!task('V01A001') && !!task('V01A005'));
for (const [bin, pallet, qty] of [['V01A001', 'FR10247661', 2200], ['V01A005', 'FR10248469', 1800]]) {
  const t = task(bin);
  await post(`/api/sessions/${b.S}/recounts/${t.id}/take`, { team: '5' }, G);
  await post(`/api/sessions/${b.S}/counts`, [line(pallet, qty, bin, { team: '5', pass: 2, recountId: t.id })], G);   // agrees with neither
  await post(`/api/sessions/${b.S}/recounts/${t.id}/done`, { team: '5' }, G);
}
rc = await get(`/api/admin/sessions/${b.S}/recounts`);
const third = (bin) => rc.find((t) => t.bin === bin && Number(t.round) === 3);
check('At "worth over $150" no third count is raised by itself: V01A001 is 200 × $0.166 = $33 off the report, V01A005 600 × $0.217 = $130', !third('V01A001') && !third('V01A005'), rc.map((t) => `${t.bin}:${t.round}`).join());
const c = await count('Third by value 2', { thirdCount: true, autoRecount: true, thirdMinValue: 100 });
await post(`/api/sessions/${c.S}/counts`, [line('FR10247661', 2000, 'V01A001'), line('FR10248469', 1400, 'V01A005')], G);
rc = await get(`/api/admin/sessions/${c.S}/recounts`);
for (const [bin, pallet, qty] of [['V01A001', 'FR10247661', 2200], ['V01A005', 'FR10248469', 1800]]) {
  const t = rc.find((x) => x.bin === bin);
  await post(`/api/sessions/${c.S}/recounts/${t.id}/take`, { team: '5' }, G);
  await post(`/api/sessions/${c.S}/counts`, [line(pallet, qty, bin, { team: '5', pass: 2, recountId: t.id })], G);
  await post(`/api/sessions/${c.S}/recounts/${t.id}/done`, { team: '5' }, G);
}
rc = await get(`/api/admin/sessions/${c.S}/recounts`);
check('…at "worth over $100": V01A005 (600 × $0.217 = $130) gets its third count, V01A001 (200 × $0.166 = $33) does not', !!rc.find((t) => t.bin === 'V01A005' && Number(t.round) === 3) && !rc.find((t) => t.bin === 'V01A001' && Number(t.round) === 3), rc.map((t) => `${t.bin}:${t.round}`).join());

/* ---------------- the pages ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin#reports`);
await signIn(page);
await pickSession(page, a.S);
await page.evaluate(() => window.appApi.showSub('reports'));
await page.uncheck('#fOnlyExceptions').catch(() => {});
await page.waitForSelector('#palletTable tr[data-pallet="FR10248469"]', { timeout: 8000 });
const heads = await page.$$eval('#palletTable thead th', (ths) => ths.map((t) => t.textContent.trim()));
check('Pallet report: Cost, Report $ and Difference $ columns, after the counts', heads.slice(4, 11).join('|') === 'Expected|1st count|2nd count|Counted|Cost|Report $|Difference $', heads.join('|'));
const row = clean(await page.$eval('#palletTable tr[data-pallet="FR10248469"]', (tr) => [...tr.children].map((td) => td.textContent).join(' ')));
check('…a row shows the cost and the difference in money', /0\.21708 \$520\.99 -\$217\.08/.test(row), row.slice(0, 160));
check('…a cost taken from the item is dimmed and wears an "item" pill', await page.$eval('#palletTable tr[data-pallet="FR10247670"] td.muted', (td) => /item/.test(td.title) && /0\.16589/.test(td.textContent) && /item/.test(td.querySelector('.tag')?.textContent || '')));
check('…a pallet with no cost anywhere wears a "no cost" pill', await page.$eval('#palletTable tr[data-pallet="FR10275707"] td.nocost .tag', (t) => t.textContent === 'no cost'));
await page.evaluate(() => window.appApi.showSub('adjust'));
await page.waitForTimeout(600);
await page.click('#pnSide button[data-side="negative"]');
await page.waitForTimeout(400);
check('…and so does its line on the adjustments', await page.$eval('#pnTable tr[data-pallet="FR10275707"]', (tr) => /no cost/.test(tr.textContent) && !!tr.querySelector('.tag')), await page.$eval('#pnTable tr[data-pallet="FR10275707"]', (tr) => tr.textContent.replace(/\s+/g, ' ').trim()).catch(() => 'no row'));
await page.evaluate(() => window.appApi.showSub('progress'));
await page.waitForTimeout(400);
const stats = clean(await page.textContent('#stats'));
check('Progress: the report\'s value and the difference so far, in money', /\$5,150\.90Report value/.test(stats) && /-\$288\.55Difference so far · \+\$16\.59 \/ -\$305\.14/.test(stats), stats.slice(-160));
await page.evaluate(() => window.appApi.showSub('adjust'));
await page.waitForTimeout(600);
check('Positive and negative: the tiles carry the money', /\+\$16\.59/.test(clean(await page.textContent('#pnPlusSub'))) && /-\$305\.14/.test(clean(await page.textContent('#pnMinusSub'))) && /-\$288\.55/.test(clean(await page.textContent('#pnNetSub'))), clean(await page.textContent('#pnTiles')));
await page.goto(`${BASE}/settings`);
await page.waitForSelector('#fRecMinValue');
await pickSession(page, a.S).catch(() => {});
await page.waitForTimeout(800);
check('Settings: the money thresholds are on the count card and show what was saved', (await page.inputValue('#fRecMinValue')) === '100' && (await page.inputValue('#fApprMinValue')) === '50' && (await page.$('#fThirdMinValue')) !== null, `${await page.inputValue('#fRecMinValue')} / ${await page.inputValue('#fApprMinValue')}`);
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
