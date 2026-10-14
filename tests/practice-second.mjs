/*
 * The Testing Suite: second counts.
 *
 * The crew that made a first count is never offered the second, so the
 * practice team could never be sent back to its own bins. "Second counts"
 * under What to practice has another crew - team 98 - count aisle F03 first
 * and get some of it wrong: four bins come back to the practice gun, blind,
 * and one bin recorded empty is left for the person to raise by hand from the
 * dashboard. The gun, the dashboard's Second counts tab, the checklist and
 * the pane all follow it, and Start over clears the lot.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) })).json()).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const get = async (p, h = A) => (await fetch(BASE + p, { headers: h })).json();
const post = async (p, body = {}, h = A) => (await fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) })).json();

/* ---------------- the API: set up, offered, scoped ---------------- */
const made = await post('/api/admin/practice');
check('A practice count offers second counts to practice, not set up yet', made.modes.second && made.modes.second.allowed && !made.modes.second.on && made.modes.second.team === '98', JSON.stringify(made.modes.second));
const sc = await post('/api/admin/practice/mode', { mode: 'second' });
const S = sc.modes.second;
check('Picking it has team 98 count aisle F03, and four of its bins come back', S.on && S.bins.length === 5 && S.open === 4 && S.bins.filter((b) => b.task).length === 4, JSON.stringify(S.bins.map((b) => [b.bin, b.task && b.task.reason])));
check('…a short count, a missed pallet, a pallet in the wrong bin and one not on the report',
  S.bins.filter((b) => b.task).map((b) => b.task.reason).join('|') === 'Quantity differs from the inventory report|Expected pallet not found here|Pallet found in an unexpected bin|Pallet not on the inventory report',
  S.bins.filter((b) => b.task).map((b) => b.task.reason).join('|'));
const f4 = S.bins.find((b) => b.bin === 'F03A004');
check('…and one bin they recorded empty is left to raise by hand', f4.manual && !f4.task && /empty/.test(f4.first));
check('…each with what the other crew keyed beside what is on the shelf', S.bins[0].first === 'F34511-111 ×36' && S.bins[0].shelf[0].qty === 40 && S.bins[1].shelf.length === 2 && S.bins[4].shelf[0].onReport === false);
check('…with three things to try', ['second', 'secondRaise', 'secondAll'].every((k) => sc.checklist.some((c) => c.key === k && !c.done)));
check('The run is still the run: same practice count, the sheet\'s own two aisles untouched', sc.session.id === made.session.id && sc.bins.length === made.bins.length && sc.totals.bins === made.totals.bins);
const sid = made.session.id;
const dash = await get(`/api/admin/sessions/${sid}/recounts`);
check('The dashboard\'s Second counts tab lists them with the other crew\'s first result', dash.length === 4 && dash.every((r) => /×/.test(r.first_result || '')) && dash.filter((r) => r.first_team === '98').length === 3, JSON.stringify(dash.map((r) => [r.bin, r.reason, r.first_team])));
const T = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${made.device.uid}`, {}, hdr)).token };
const offered = await get(`/api/sessions/${sid}/recounts?team=99`, T);
check('The practice gun, team 99, is offered all four - another crew made the first count', offered.tasks.length === 4 && offered.tasks[0].bin === 'F03A001', JSON.stringify(offered.tasks.map((t) => t.bin)));
check('Asking again changes nothing', (await post('/api/admin/practice/mode', { mode: 'second' })).modes.second.open === 4);
const floorDev = await post('/api/admin/devices', { name: 'FLOOR-08' });
const F = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${floorDev.uid}`, {}, hdr)).token };
check('A gun on the floor is never offered the practice count the other crew counted', !(await get('/api/sessions', F)).some((s) => s.id === sid));

/* ---------------- the gun ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const gun = await browser.newPage({ viewport: { width: 360, height: 640 } });
gun.on('pageerror', (e) => console.log('GUN ERROR', e.message));
await gun.goto(`${BASE}/?d=${made.device.uid}&practice=1`); await wait(1800);
const screenOf = () => gun.evaluate(() => document.querySelector('.screen.active')?.id).catch(() => '');
const waitScreen = async (id, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if ((await screenOf()) === id) return true; await wait(100); } return false; };
const prompt = async () => clean(await gun.textContent('#prompt').catch(() => ''));
const atPrompt = async (re, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if ((await screenOf()) === 'scrScan' && re.test(await prompt())) return true; await wait(100); } return false; };
const scan = async (text, field) => { await gun.evaluate(([t, f]) => window.wedge(t, f), [text, field || null]); await wait(350); };
const skipComments = async () => { for (let t = 0; t < 3000; t += 100) { if (await gun.isVisible('#btnSkip')) { await gun.click('#btnSkip'); await wait(300); return; } await wait(100); } };
const banner = async () => clean(await gun.textContent('#recountBanner').catch(() => ''));

await gun.selectOption('#fSession', String(sid)).catch(() => {});
await scan('99', 'fTeam'); await scan('T1001', 'fEmployee');
await gun.click('#btnStart');
check('The gun signs on to the full count as usual', await waitScreen('scrAssign'));
check('…and says four second counts are waiting, another crew\'s', await gun.isVisible('#recountCard') && clean(await gun.textContent('#recountCount')) === '4' && /Second counts available/.test(clean(await gun.textContent('#recountCardTitle'))), clean(await gun.textContent('#recountCard')));
await gun.click('#btnRecounts');
check('Start second counts takes the first bin, named with its reason and never the numbers', await atPrompt(/PALLET/i) && /SECOND COUNT · bin F03A001/.test(await banner()) && /Quantity differs/.test(await banner()) && !/36|40/.test(await banner()), await banner());
await scan('F34511-111');
check('The pallet goes in', await atPrompt(/QUANTITY/i), await prompt());
await scan('40');
check('…the quantity', await atPrompt(/BIN/i), await prompt());
await scan('F03A002');
check('A second count takes its own bin and no other', /for bin F03A001/.test(clean(await gun.textContent('#scanMsg'))) && await atPrompt(/BIN/i), clean(await gun.textContent('#scanMsg')));
await scan('F03A001');
await skipComments();
check('…then back to the pallet step, still on that bin', await atPrompt(/PALLET/i) && /bin F03A001/.test(await banner()));
await gun.click('#btnRecountDone');
await wait(600);
check('Bin done moves the gun to the next second count', /bin F03A002/.test(await banner()) && /Expected pallet not found/.test(await banner()), await banner());
await wait(1500);
let dash2 = await get(`/api/admin/sessions/${sid}/recounts`);
let row = dash2.find((r) => r.bin === 'F03A001');
check('The second count lands as pass 2 and settles the bin on the dashboard', row && row.status === 'done' && /F34511-111 ×40/.test(row.second_result || ''), JSON.stringify(row && [row.status, row.second_result]));
let pr = await get('/api/admin/practice');
check('…the checklist ticks "do a second count"', pr.checklist.some((c) => c.key === 'second' && c.done) && pr.modes.second.done === 1 && pr.modes.second.bins[0].shelf[0].counted === true);

/* raised by hand from the dashboard, picked up with Refresh */
await post(`/api/admin/sessions/${sid}/recounts`, { bin: 'F03A004', note: 'practice: they said it was empty' });
pr = await get('/api/admin/practice');
check('Raising one by hand from the dashboard ticks the second thing to try', pr.checklist.some((c) => c.key === 'secondRaise' && c.done) && pr.modes.second.raised && pr.modes.second.bins.find((b) => b.bin === 'F03A004').task.source === 'manual');
await gun.click('#btnToAssign'); await waitScreen('scrAssign');
await gun.click('#btnAssignRefresh'); await wait(1200);
check('Refresh on the gun brings the hand-raised bin in with the rest', clean(await gun.textContent('#recountCount')) === '4', clean(await gun.textContent('#recountCount')));
await gun.click('#btnRecounts');
check('…and the gun carries on where it was, with the bin it had in hand', await atPrompt(/PALLET/i) && /bin F03A002/.test(await banner()), await banner());

/* the rest, the quick way, to reach "none open" - the gun took the device's one token when it opened, so a fresh one */
await gun.close();
const T2 = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${made.device.uid}`, {}, hdr)).token };
for (const t of (await get(`/api/sessions/${sid}/recounts?team=99`, T2)).tasks) {
  await post(`/api/sessions/${sid}/recounts/${t.id}/take`, { team: '99' }, T2);
  await post(`/api/sessions/${sid}/recounts/${t.id}/done`, { team: '99' }, T2);
}
pr = await get('/api/admin/practice');
check('With every second count done, the hand-raised one included, the last thing to try ticks', pr.checklist.some((c) => c.key === 'secondAll' && c.done) && pr.modes.second.open === 0 && pr.modes.second.done === 5, JSON.stringify([pr.modes.second.open, pr.modes.second.done]));

/* ---------------- the page ---------------- */
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.goto(BASE + '/testing');
await page.fill('#fUser', 'DANA-WHITFIELD'); await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active');
await page.waitForSelector('#shelves table.shelf');
await wait(800);
const modeBtn = (k) => page.locator(`#modeList button[data-mode="${k}"]`);
check('"What to practice" lists Second counts beside the other jobs, marked as set up', await modeBtn('second').isVisible() && await modeBtn('second').evaluate((b) => b.classList.contains('set')) && (await page.$$('#modeList button')).length === 5);
await modeBtn('second').click(); await wait(900);
const paneText = clean(await page.textContent('#modePane'));
check('…and its pane: the other crew\'s aisle, what they keyed, what is on the shelf, the state of each bin', await page.isVisible('#modePane') && (await page.$$('#modePane tr[data-second-bin]')).length === 6 && /The other crew keyed/.test(paneText) && /F34511-111 ×36/.test(paneText) && /✓ done/.test(paneText), paneText.slice(0, 160));
check('…with the bins and pallets as chips to click into the gun', await page.locator('#modePane .scan', { hasText: /^F34511-111$/ }).isVisible() && await page.locator('#modePane .scan', { hasText: /^F03A001$/ }).isVisible());
check('…and how to do it, in the gun\'s own words', /Start second counts/.test(paneText) && /Bin done/.test(paneText) && /Request second count/.test(paneText));
check('The page threw no errors', errors.length === 0, errors.join(' | '));

/* Start over clears the lot; who may practice it */
const reset = await post('/api/admin/practice/reset', {});
check('Start over clears it: the new run has no second counts set up and nothing raised', !reset.modes.second.on && (await get(`/api/admin/sessions/${reset.session.id}/recounts`)).length === 0);
await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'IVY-CHEN', name: 'Ivy Chen', password: 'cold-room-11', mustChange: false, profile: 'inventory' }) });
await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'CY-ONLY', name: 'Cy Only', password: 'cold-room-12', mustChange: false, profile: 'cycle' }) });
const ivy = await post('/api/admin/practice', {}, { ...hdr, authorization: 'Bearer ' + (await post('/api/admin/login', { username: 'IVY-CHEN', password: 'cold-room-11' }, hdr)).token });
const cy = await post('/api/admin/practice', {}, { ...hdr, authorization: 'Bearer ' + (await post('/api/admin/login', { username: 'CY-ONLY', password: 'cold-room-12' }, hdr)).token });
check('Inventory control, who works the count, may practice second counts; a cycle-only login may not', ivy.modes.second.allowed === true && cy.modes.second.allowed === false);

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
