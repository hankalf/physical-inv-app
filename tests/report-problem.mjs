/*
 * Report a problem: what the gun offers is the site's to edit, and a report
 * about a bin or a pallet is sent only once the counter has scanned it.
 *
 * Settings → Scanners → What the scanners offer → Report a problem lists each
 * kind of problem with its reasons and what must be scanned to confirm it: the
 * bin, the pallet, either one (a leaning or tipped pallet whose label is out
 * of reach), or nothing. The server holds the gun to it, the dashboard's fix
 * list says what was scanned, and a gun from before the change still gets its
 * queued reports through.
 */
import { chromium } from 'playwright-core';
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

/* ---- the shipped list, and what each kind asks for */
let m = await get('/api/admin/issue-menu');
const by = (label) => m.menu.find((x) => x.label === label);
check('The shipped list: five kinds, each saying what to scan', m.isDefault && m.menu.length === 5 && by('Damaged pallet').confirm === 'either' && by('Damaged rack or bin').confirm === 'bin' && by('Bin blocked — come back later').confirm === 'bin' && by('Something else').confirm === 'none', JSON.stringify(m.menu.map((x) => [x.label, x.confirm])));
check('…a leaning or tipped pallet among the reasons', by('Damaged pallet').reasons.includes('Leaning or unstable') && by('Damaged pallet').reasons.includes('Tipped over'));

/* ---- an admin edits it */
const edited = [
  { ...by('Damaged pallet'), reasons: [...by('Damaged pallet').reasons, 'Overhanging the beam'] },
  { ...by('Damaged rack or bin') },
  { kind: 'other', target: 'pallet', label: 'Wrong label on the pallet', confirm: 'pallet', reasons: ['Label for another item', 'Two labels that differ'] },
  { ...by('Something else') },
];
let r = await post('/api/admin/issue-menu', { menu: edited });
m = await j(r);
check('An admin saves the site\'s own list: a reason added, a kind added, two taken off', r.status === 200 && !m.isDefault && m.menu.length === 4 && by('Damaged pallet').reasons.includes('Overhanging the beam') && by('Wrong label on the pallet').confirm === 'pallet' && !by('Damaged product'), JSON.stringify(m.menu.map((x) => x.label)));
r = await post('/api/admin/issue-menu', { menu: [{ label: 'Nothing to pick', confirm: 'bin', reasons: [] }] });
check('A kind with no reasons is refused, with a word on why', r.status === 400 && /needs at least one reason/.test((await j(r)).error));
r = await post('/api/admin/issue-menu', { menu: [{ label: 'Twice', reasons: ['a'] }, { label: 'twice', reasons: ['b'] }] });
check('…and so is the same name twice', r.status === 400 && /twice/.test((await j(r)).error));
await post('/api/admin/users', { username: 'FLOOR-SUP', name: 'Floor Sup', password: 'dock-side-77', mustChange: false, profile: 'floor' });
const ft = (await j(await post('/api/admin/login', { username: 'FLOOR-SUP', password: 'dock-side-77' }, hdr))).token;
check('Only an admin may change it', (await post('/api/admin/issue-menu', { menu: edited }, { ...hdr, authorization: 'Bearer ' + ft })).status === 403);

/* ---- a count, a gun */
const sess = await j(await post('/api/admin/sessions', { name: 'Problem count' }));
const sid = sess.id;
await post(`/api/admin/sessions/${sid}/master?kind=bins`, 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\n', csv);
await post(`/api/admin/sessions/${sid}/master?kind=pallets`, 'Pallet ID,SKU,Description,Qty,Location\nX-1,S,Chicken,40,F01A001\nX-2,S,Peas,30,F01A002\n', csv);
await post(`/api/admin/sessions/${sid}/settings`, { guided: false, askComments: false });
const dev = await j(await post('/api/admin/devices', { name: 'PROB-01' }));
const D = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
check('The gun is sent the site\'s list', (await get(`/api/sessions/${sid}/issues`, D)).menu.some((x) => x.label === 'Wrong label on the pallet'));

/* ---- the server holds the gun to it */
const raise = (b) => post(`/api/sessions/${sid}/issues`, { clientId: 'c' + Math.random(), team: '1', deviceId: 'PROB-01', ...b }, D);
r = await raise({ kind: 'damage', target: 'rack', label: 'Damaged rack or bin', confirm: 'bin', reason: 'Beam bent', bin: 'F01A001' });
check('A bin problem with nothing scanned is refused', r.status === 400 && /scan the bin/.test((await j(r)).error));
r = await raise({ kind: 'damage', target: 'rack', label: 'Damaged rack or bin', confirm: 'bin', reason: 'Beam bent', confirmed: 'X-1' });
check('…and so is one confirmed with a pallet', r.status === 400 && /scan the bin/.test((await j(r)).error));
r = await raise({ kind: 'damage', target: 'rack', label: 'Damaged rack or bin', confirm: 'bin', reason: 'Beam bent', confirmed: 'F01A002', confirmedAs: 'bin', confirmedHow: 'scanned' });
let issue = (await j(r)).issue;
check('Scanned, it goes through, against the bin that was scanned', r.status === 200 && issue.bin === 'F01A002' && issue.confirmed === 'F01A002' && issue.confirmed_as === 'bin', JSON.stringify(issue));
r = await raise({ kind: 'damage', target: 'pallet', label: 'Damaged pallet', confirm: 'either', reason: 'Tipped over', confirmed: 'F01A001', confirmedHow: 'typed' });
issue = (await j(r)).issue;
check('A tipped pallet may be confirmed by its bin; typed is said', r.status === 200 && issue.confirmed_as === 'bin' && issue.confirmed_how === 'typed' && issue.bin === 'F01A001');
r = await raise({ kind: 'other', target: '', label: 'Something else', confirm: 'none', reason: 'Light out' });
check('"Something else" needs no scan', r.status === 200);
r = await raise({ kind: 'damage', target: 'pallet', reason: 'Broken boards', palletId: 'X-1', bin: 'F01A001' });
check('A report queued on a gun from before the change still goes through', r.status === 200 && !(await j(r)).issue.confirmed);

/* ---- on the gun */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
const gun = await ctx.newPage();
const errors = []; gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
await gun.goto(`${BASE}/?d=${dev.uid}`); await gun.waitForTimeout(1500);
await gun.fill('#fTeam', '1'); await gun.press('#fTeam', 'Enter');
await gun.fill('#fEmployee', 'E1'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrScan.active', { timeout: 8000 });
await gun.click('#btnIssue'); await gun.waitForTimeout(600);
const kinds = await gun.$$eval('#issueKinds button', (bs) => bs.map((b) => b.textContent));
check('The gun offers the edited list', kinds.length === 4 && kinds.includes('Wrong label on the pallet') && !kinds.includes('Damaged product'), kinds.join(' | '));
await gun.click('#issueKinds button:has-text("Wrong label")'); await gun.waitForTimeout(200);
await gun.click('#issueReasons button:has-text("Two labels")'); await gun.waitForTimeout(300);
check('A pallet problem asks for the pallet', /Scan the pallet to confirm/.test(await gun.textContent('#issueScanLabel')) && /Wrong label on the pallet · Two labels that differ/.test(await gun.textContent('#issueChosen')));
await gun.fill('#fIssueScan', 'F01A001'); await gun.press('#fIssueScan', 'Enter'); await gun.waitForTimeout(400);
check('…a bin scanned instead is refused, and the gun says what to scan', /F01A001 is a bin, not a pallet/.test(await gun.textContent('#issueMsg')), clean(await gun.textContent('#issueMsg')));
await gun.click('#btnIssueRepick'); await gun.waitForTimeout(200);
check('Pick another reason goes back to the list', await gun.isVisible('#issueKinds') && !(await gun.isVisible('#issueConfirm')));
await gun.click('#issueKinds button:has-text("Damaged pallet")'); await gun.waitForTimeout(200);
await gun.click('#issueReasons button:has-text("Leaning")'); await gun.waitForTimeout(300);
check('A leaning pallet asks for the pallet or the bin', /Scan the pallet or the bin to confirm/.test(await gun.textContent('#issueScanLabel')));
await gun.evaluate(() => window.wedge('F01A002'));
await gun.waitForTimeout(500);
check('A scan from the trigger lands in the confirm box and sends it', /On the fix list/.test(await gun.textContent('#issueMsg')) && /F01A002/.test(await gun.textContent('#issueMsg')), clean(await gun.textContent('#issueMsg')));
await gun.waitForTimeout(2600);
check('…and the gun goes back to counting', await gun.isVisible('#scrScan'));
let list = await get(`/api/admin/sessions/${sid}/fixlist`);
const leaning = list.rows.find((x) => x.reason === 'Leaning or unstable');
check('On the fix list, against the bin scanned', leaning && leaning.bin === 'F01A002' && leaning.confirmed === 'F01A002' && leaning.confirmed_as === 'bin' && leaning.confirmed_how === 'scanned', JSON.stringify(leaning));
await gun.click('#btnIssue'); await gun.waitForTimeout(400);
await gun.click('#issueKinds button:has-text("Something else")'); await gun.waitForTimeout(200);
await gun.click('#issueReasons button:has-text("Light out")'); await gun.waitForTimeout(400);
check('"Something else" is sent on the tap, no scan asked', /On the fix list/.test(await gun.textContent('#issueMsg')) && !(await gun.isVisible('#issueConfirm')));
await ctx.close();

/* ---- the dashboard's fix list says what was scanned */
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => errors.push('admin: ' + e.message));
await page.goto(`${BASE}/admin`);
await signIn(page);
await page.evaluate((id) => window.appApi.pickSession && window.appApi.pickSession(id), sid); await page.waitForTimeout(1200);
await page.evaluate(() => window.appApi.showSub('reports')); await page.waitForTimeout(1200);
const row = clean(await page.textContent('#fixTable tr:has-text("Leaning or unstable")'));
check('The dashboard\'s fix list marks the bin as scanned', /F01A002 ?✓ scanned/.test(row), row.slice(0, 120));
const typed = clean(await page.textContent('#fixTable tr:has-text("Tipped over")'));
check('…and a typed one as typed', /✓ typed on the gun/.test(typed), typed.slice(0, 120));

/* ---- Settings: the editor */
await page.goto(`${BASE}/settings`);
await page.waitForSelector('#scrMain.active');
await page.evaluate(() => window.appApi.showSub('gun')); await page.waitForTimeout(1000);
check('Settings lists the kinds, each with its scan rule and reasons', (await page.$$('#issueList .ikind')).length === 4 && (await page.$eval('#issueList .ikind[data-i="2"] .iconfirm', (s) => s.value)) === 'pallet' && /set for this site/.test(await page.textContent('#issueChip')));
await page.fill('#fNewIssue', 'Pest sighting'); await page.click('#btnAddIssue'); await page.waitForTimeout(200);
await page.fill('#issueList .ikind[data-i="4"] .inew', 'Droppings'); await page.press('#issueList .ikind[data-i="4"] .inew', 'Enter'); await page.waitForTimeout(150);
await page.selectOption('#issueList .ikind[data-i="4"] .iconfirm', 'none');
await page.selectOption('#issueList .ikind[data-i="0"] .iconfirm', 'pallet');
await page.click('#issueList .ikind[data-i="1"] .chip-btn.remove'); await page.waitForTimeout(150);
await page.click('#btnSaveIssues'); await page.waitForTimeout(900);
m = await get('/api/admin/issue-menu');
check('Add a kind, give it a reason, change a scan rule, take a reason off, Save', /Saved/.test(await page.textContent('#issueMenuMsg')) && m.menu.length === 5 && by('Pest sighting').confirm === 'none' && by('Pest sighting').reasons.join() === 'Droppings' && by('Damaged pallet').confirm === 'pallet' && by('Damaged rack or bin').reasons.length === 4, JSON.stringify(m.menu.map((x) => [x.label, x.confirm, x.reasons.length])));
page.once('dialog', (d) => d.accept());
await page.click('#btnResetIssues'); await page.waitForTimeout(900);
m = await get('/api/admin/issue-menu');
check('Restore the shipped list puts it back', m.isDefault && m.menu.length === 5 && /the shipped list/.test(await page.textContent('#issueChip')));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
