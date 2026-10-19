/*
 * Gear sizes: each person's department, jacket, bibs (overalls) and boots, on
 * their card and in a table of everyone, with the totals an order is placed
 * from and an Excel export of names, sizes and grand totals.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const person = async (badge) => (await get('/api/admin/people')).employees.find((e) => e.badge === badge);

/* sizes the way people write them on a spreadsheet */
let r = await post('/api/admin/people/employees/import?replace=1', [
  'Clock In Number,Name,Department,Equipment,Jacket Size,Overalls,Boot Size',
  'G1,Ana Ruiz,Freezer,Scissor lift,xx-large,Large,10 1/2',
  'G2,Ben Ortiz,Freezer,,M,m,9',
  'G3,Cy Park,Dry Dock,Dock truck,Large,XL,11W',
  'G4,Di Long,Dry Dock,,,,',
  'G5,Ed Moss,,High reach,M,,12',
].join('\n'), csv);
let st = await j(r);
check('A crew list with size columns uploads', r.status === 200 && st.imported === 5 && st.sizes === 4, JSON.stringify(st));
let a = await person('G1');
check('…and sizes written any old way come out one way: xx-large → 2XL, Large → L, 10 1/2 → 10.5', a.jacket === '2XL' && a.bibs === 'L' && a.boots === '10.5', JSON.stringify([a.jacket, a.bibs, a.boots]));
check('…a wide boot keeps its W', (await person('G3')).boots === '11W');

r = await post('/api/admin/people/employees/import', 'Clock In Number,Name,Department,Equipment\nG1,Ana Ruiz,Freezer,Scissor lift\n', csv);
a = await person('G1');
check('A later upload with no size columns leaves the sizes alone', r.status === 200 && a.jacket === '2XL' && a.boots === '10.5', JSON.stringify(a));

r = await post('/api/admin/people/employees/G4/gear', { dept: 'Freezer', jacket: 's', bibs: 'Small', boots: '8' });
a = await j(r);
check('Department and sizes are set for one person', r.status === 200 && a.dept === 'Freezer' && a.jacket === 'S' && a.bibs === 'S' && a.boots === '8', JSON.stringify(a));
r = await post('/api/admin/people/employees/G4/gear', { boots: '' });
a = await j(r);
check('…a key left out is left alone, an empty one clears it', a.boots === '' && a.jacket === 'S' && a.dept === 'Freezer', JSON.stringify(a));
r = await post('/api/admin/people/employees/NOPE/gear', { jacket: 'M' });
check('…and someone not on the list is a 404', r.status === 404);

let g = await get('/api/admin/people/gear');
const jackets = g.totals.find((t) => t.key === 'jacket');
const boots = g.totals.find((t) => t.key === 'boots');
check('Totals: jackets by size, in the order they are worn', JSON.stringify(jackets.sizes) === JSON.stringify([{ size: 'S', count: 1 }, { size: 'M', count: 2 }, { size: 'L', count: 1 }, { size: '2XL', count: 1 }]), JSON.stringify(jackets.sizes));
check('…boots in number order, and the people with none counted as not entered', boots.sizes.map((s) => s.size).join(',') === '9,10.5,11W,12' && boots.missing === 1 && boots.entered === 4, JSON.stringify(boots));
const grand = g.sheets.find((s) => s.name === 'Grand totals');
check('The export has names and sizes, grand totals and a by-department sheet', g.sheets.map((s) => s.name).join('|') === 'Names and sizes|Grand totals|By department' && /^gear-sizes-\d{4}-\d{2}-\d{2}\.xlsx$/.test(g.filename), g.filename);
check('…a grand total per item and the head count', grand.rows.some((x) => x.Item === 'Jackets — grand total' && x.Count === 5) && grand.rows.some((x) => x.Item === 'Boots — grand total' && x.Count === 4) && grand.rows.some((x) => x.Item === 'People on the list' && x.Count === 5), JSON.stringify(grand.rows.filter((x) => /total|People/.test(x.Item))));
check('…names sorted by department, with every column', g.sheets[0].rows[0].Department === 'Dry Dock' && Object.keys(g.sheets[0].rows[0]).join(',') === 'Clock in number,Name,Department,Team,Jacket,Bibs,Boots', JSON.stringify(g.sheets[0].rows[0]));
const byDept = g.sheets.find((s) => s.name === 'By department');
check('…and the by-department sheet counts each department on its own', byDept.rows.some((x) => x.Department === 'Freezer' && x.Item === 'Jackets' && x.Size === 'M' && x.Count === 1) && byDept.rows.some((x) => x.Department === 'Freezer — people' && x.Count === 3));
g = await get('/api/admin/people/gear?dept=Dry%20Dock');
check('One department on its own', g.people.length === 1 && g.people[0].badge === 'G3' && g.filename.startsWith('gear-sizes-dry-dock-') && g.depts.join('|') === 'Dry Dock|Freezer', JSON.stringify([g.people.length, g.filename, g.depts]));
const csvOut = await (await fetch(`${BASE}/api/admin/people/export/employees.csv`, { headers: A })).text();
check('The crew-list CSV export carries the sizes too', /jacket,bibs,boots/.test(csvOut.split('\n')[0]) && /G1,Ana Ruiz.*2XL,L,10\.5/.test(csvOut), csvOut.split('\n')[0]);

/* who may: the Gear sizes tab is its own tick in the access list */
await post('/api/admin/users', { username: 'GEARONLY', name: 'Gear Desk', password: 'boots-and-bibs-1', mustChange: false, access: ['teams.gear'] });
await post('/api/admin/users', { username: 'CREWONLY', name: 'Crew Desk', password: 'crew-list-only-1', mustChange: false, access: ['teams.crew'] });
const as = async (u, pw) => ({ ...hdr, authorization: 'Bearer ' + (await j(await post('/api/admin/login', { username: u, password: pw }, hdr))).token });
const G = await as('GEARONLY', 'boots-and-bibs-1');
const C = await as('CREWONLY', 'crew-list-only-1');
check('A login with only Gear sizes can read and change sizes', (await fetch(`${BASE}/api/admin/people/gear`, { headers: G })).status === 200 && (await post('/api/admin/people/employees/G2/gear', { boots: '9.5' }, G)).status === 200);
check('…but not the rest of the crew page', (await fetch(`${BASE}/api/admin/people`, { headers: G })).status === 403);
check('A login with only Crew & teams cannot change sizes', (await post('/api/admin/people/employees/G2/gear', { boots: '10' }, C)).status === 403 && (await person('G2')).boots === '9.5');

/* ------------------------------------------------------------------ the pages */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/teams`);
await signIn(page);

const card = page.locator('.person[data-badge="G1"]');
check('A card shows the department where it can be seen', clean(await card.locator('.deptchip').textContent()) === 'Freezer');
check('…and the sizes under the equipment', clean(await card.locator('.gearline').textContent()) === 'Jacket 2XL · Bibs L · Boots 10.5', clean(await card.locator('.gearline').textContent()));
check('Someone with no department says so', clean(await page.locator('.person[data-badge="G5"] .deptchip').textContent()) === 'No department');
await card.locator('[data-gear-edit]').click();
check('Dept & sizes opens an editor on the card, and the card stops dragging', (await card.locator('.gearedit').count()) === 1 && (await card.getAttribute('draggable')) === 'false');
await card.locator('.gearedit input[data-gear="dept"]').fill('Shipping');
await card.locator('.gearedit select[data-gear="jacket"]').selectOption('XL');
await card.locator('.gearedit button.primary').click();
await page.waitForTimeout(500);
a = await person('G1');
check('…Save keeps the department and the size', a.dept === 'Shipping' && a.jacket === 'XL' && a.bibs === 'L', JSON.stringify(a));
check('…and the card shows them', clean(await page.locator('.person[data-badge="G1"] .deptchip').textContent()) === 'Shipping' && /Jacket XL/.test(await page.locator('.person[data-badge="G1"] .gearline').textContent()));

/* the Gear sizes tab */
await page.evaluate(() => window.appApi.showSub('gear'));
await page.waitForSelector('#gearTable tbody tr[data-badge="G1"]');
check('The Gear sizes table lists everyone', (await page.locator('#gearTable tbody tr').count()) === 5);
const jacketBox = page.locator('.gearbox[data-item="jacket"]');
check('…with totals per item', clean(await jacketBox.locator('.grand').textContent()) === 'Total 5' && /XL\s*1/.test(clean(await jacketBox.textContent())), clean(await jacketBox.textContent()));
await page.locator('#gearTable tr[data-badge="G4"] select[data-gear="boots"]').selectOption('8.5');
await page.waitForTimeout(700);
check('Picking a size saves it', (await person('G4')).boots === '8.5');
check('…and the boot total follows', clean(await page.locator('.gearbox[data-item="boots"] .grand').textContent()) === 'Total 5', clean(await page.locator('.gearbox[data-item="boots"]').textContent()));
await page.fill('#fGearFind', 'ortiz');
check('Find narrows the table', (await page.locator('#gearTable tbody tr').count()) === 1);
await page.fill('#fGearFind', '');
await page.check('#fGearMissing');
check('…and "only missing a size" shows the gaps', (await page.locator('#gearTable tbody tr').count()) === 1 && (await page.locator('#gearTable tbody tr[data-badge="G5"]').count()) === 1);
await page.uncheck('#fGearMissing');
await page.selectOption('#fGearDept', 'Freezer');
await page.waitForTimeout(500);
check('The department picker shows one department', (await page.locator('#gearTable tbody tr').count()) === 2, String(await page.locator('#gearTable tbody tr').count()));
await page.selectOption('#fGearDept', '');
await page.waitForTimeout(500);

const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnGearExport')]);
const file = await dl.path();
check('Export names and sizes downloads a workbook', /^gear-sizes-\d{4}-\d{2}-\d{2}\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
/* read it back with the same SheetJS the app ships */
const sandbox = { window: {}, self: {}, console };
vm.runInNewContext(readFileSync(new URL('../public/vendor/xlsx.full.min.js', import.meta.url), 'utf8'), sandbox);
const XLSX = sandbox.XLSX || sandbox.window.XLSX || sandbox.self.XLSX;
const wb = XLSX.read(readFileSync(file), { type: 'buffer' });
const totalsSheet = XLSX.utils.sheet_to_json(wb.Sheets['Grand totals']);
check('…with the three sheets', wb.SheetNames.join('|') === 'Names and sizes|Grand totals|By department', wb.SheetNames.join('|'));
check('…and the grand totals in it', totalsSheet.some((x) => x.Item === 'Jackets — grand total' && x.Count === 5) && totalsSheet.some((x) => x.Item === 'Boots — grand total' && x.Count === 5), JSON.stringify(totalsSheet.slice(0, 3)));
check('No page errors', !errors.length, errors.join(' | '));

/* the gear-only login sees only its tab */
const p2 = await ctx.newPage();
await p2.goto(`${BASE}/teams`);
await p2.fill('#fUser', 'GEARONLY');
await p2.fill('#fPassword', 'boots-and-bibs-1');
await p2.click('#btnLogin');
await p2.waitForSelector('#scrMain.active');
await p2.waitForSelector('#gearTable tbody tr');
const tabs = await p2.$$eval('#subTabs button', (bs) => bs.map((b) => b.dataset.goto));
check('A gear-only login sees the Gear sizes tab alone, filled in', tabs.join(',') === 'gear' && (await p2.locator('#gearTable tbody tr').count()) === 5, tabs.join(','));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
