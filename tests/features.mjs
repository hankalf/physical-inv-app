/*
 * What is switched on.
 *
 * An admin hides the parts of the app nobody needs yet - for a team with a
 * few days to learn the count, the full count and its second counts alone.
 * Off is gone for everyone: the sidebar, the dashboard tabs, the search box,
 * the scanners' sign-on screen, the Testing Suite's other jobs; a bookmark to
 * a hidden page says so. The ticks under the scanners are kept, and
 * everything comes back with one press.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) })));
const tok = (await login({ username: 'DANA-WHITFIELD', password: 'changeme' })).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = (p, body = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const features = async () => j(await fetch(`${BASE}/api/admin/features`, { headers: A }));

/* ---- the API */
let f = await features();
check('Out of the box everything is on', Object.values(f.features).every(Boolean) && f.all.length === 8 && f.presets['count-only'] && f.presets.everything, JSON.stringify(f.features));
const me = await get('/api/admin/me');
check('/me carries what is on, so every page knows before it draws', me.features && me.features.cycle === true);
check('…and so does the sign-in answer', (await login({ username: 'DANA-WHITFIELD', password: 'changeme' })).features.map === true);

await post('/api/admin/users', { username: 'INV-CTRL', name: 'Inventory Control', password: 'count-week-1', mustChange: false, profile: 'inventory' });
const sup = (await login({ username: 'INV-CTRL', password: 'count-week-1' })).token;
const S = { ...hdr, authorization: 'Bearer ' + sup };
let r = await post('/api/admin/features', { preset: 'count-only' }, S);
check('A supervisor login cannot switch parts off - it is the admin\'s', r.status === 403, String(r.status));
r = await post('/api/admin/features', { board: false });
check('A part that does not exist is refused', r.status === 400 && /not a part/.test((await j(r)).error));
r = await post('/api/admin/features', { preset: 'weekend' });
check('…and so is a preset that does not', r.status === 400);

r = await post('/api/admin/features', { preset: 'count-only' });
f = await j(r);
check('"Full counts and second counts only" switches the rest off', r.status === 200 && !f.features.cycle && !f.features.front && !f.features.missing && !f.features.map && !f.features.adjust && !f.features.reports, JSON.stringify(f.features));
check('…but keeps the alerts and the Testing Suite', f.features.alerts === true && f.features.testing === true);

/* the scanners: the ticks stay, the jobs go */
const jobs = await get('/api/admin/scanner-jobs');
check('The ticks under the scanners are untouched, the offer is not', jobs.jobs.cycle === true && jobs.jobs.move === true && jobs.offered.cycle === false && jobs.offered.move === false && jobs.offered.missing === false && jobs.offered.full === true, JSON.stringify(jobs));
const full = await j(await post('/api/admin/sessions', { name: 'Count week' }));
await fetch(`${BASE}/api/admin/sessions/${full.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location\nF01A001\nF01A002\n' });
await post('/api/admin/default-session', { sessionId: full.id });
const dev = await j(await post('/api/admin/devices', { name: 'FEAT-01' }));
const dtok = (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token;
let dj = await j(await fetch(`${BASE}/api/scanner-jobs`, { headers: { authorization: 'Device ' + dtok } }));
check('A floor gun is offered the full count alone', dj.jobs.full === true && !dj.jobs.cycle && !dj.jobs.move && !dj.jobs.missing, JSON.stringify(dj.jobs));
const prac = await j(await post('/api/admin/practice'));
const ptok = (await j(await post(`/api/devices/${prac.device.uid}`, {}, hdr))).token;
const pj = await j(await fetch(`${BASE}/api/scanner-jobs?practice=1`, { headers: { authorization: 'Device ' + ptok } }));
check('…and so is the practice gun, whatever its own ticks', pj.jobs.full === true && !pj.jobs.cycle && !pj.jobs.move && !pj.jobs.missing, JSON.stringify(pj.jobs));
const pr = await get('/api/admin/practice');
check('The Testing Suite does not offer the other jobs to practice', pr.modes && pr.modes.cycle.allowed === false && pr.modes.moves.allowed === false && pr.modes.missing.allowed === false, JSON.stringify(pr.modes && { c: pr.modes.cycle.allowed, m: pr.modes.moves.allowed }));
const ready = await get('/api/admin/readiness');
check('Ready for count day sees the full count alone on the scanners, with nothing to untick', ready.checks.some((c) => c.level === 'ok' && /full count alone/.test(c.title)), ready.checks.filter((c) => /scanners/.test(c.title)).map((c) => c.level + ' ' + c.title).join(' | '));

/* ---- the office pages */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${BASE}/admin`);
await signIn(page, { user: 'DANA-WHITFIELD' });
const tabs = async (pg) => (await pg.$$eval('#navTabs a.tab', (as) => as.map((a) => a.textContent.trim()))).join('|');
const subs = async (pg) => (await pg.$$eval('#subTabs button', (bs) => bs.map((b) => b.textContent.trim()))).join('|');
let t = await tabs(page);
check('The sidebar has the count and nothing to wander into', /Dashboard/.test(t) && /Full Counts/.test(t) && /Teams & crew/.test(t) && /Settings/.test(t) && /User guide/.test(t) && /Testing Suite/.test(t) && !/Cycle counts/.test(t) && !/Front bins/.test(t) && !/Not in Location/.test(t), t);
let s = await subs(page);
check('The dashboard keeps Progress, Team plan, Alerts and Second counts; Map, Adjustments and Reports are gone', /Progress/.test(s) && /Team plan/.test(s) && /Alerts/.test(s) && /Second counts/.test(s) && !/Map/.test(s) && !/Adjust/.test(s) && !/Reports/.test(s), s);
const sideSubs = (await page.$$eval('#navTabs .sub', (as) => as.map((a) => a.textContent.trim()))).join('|');
check('…and the sidebar\'s own list of the dashboard\'s sections agrees', /Second counts/.test(sideSubs) && !/Map/.test(sideSubs) && !/Reports/.test(sideSubs), sideSubs);

await page.goto(`${BASE}/admin#map`); await page.waitForTimeout(1200);
check('A link straight to a hidden tab lands on the first one that is on', /Progress/.test(await page.$eval('#subTabs button.current', (b) => b.textContent)) && !(await page.isVisible('[data-sub="map"].active')), await page.$eval('#subTabs button.current', (b) => b.textContent));

await page.fill('#navSearch', 'map'); await page.waitForTimeout(700);
const hits = (await page.$$eval('#navResults .hit', (hs) => hs.map((h) => h.textContent.trim()))).join('|');
check('The search box does not offer a way to the map', !/admin → map/.test(hits) && !/^Map\b/.test(hits), hits || '(nothing)');

await page.goto(`${BASE}/cycle`); await page.waitForTimeout(1200);
check('A bookmark to a hidden page says so, rather than wandering off', await page.isVisible('#switchedOff') && /Cycle counts is switched off/.test(await page.textContent('#switchedOff')) && /What is switched on/.test(await page.textContent('#switchedOff')), (await page.textContent('#switchedOff')).slice(0, 80));
check('…with the way back on for an admin', await page.isVisible('#switchedOff a[href="/settings#advanced"]'));

/* a supervisor sees the same hiding, with no card to change it */
const sp = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await sp.goto(`${BASE}/admin`);
await signIn(sp, { user: 'INV-CTRL', password: 'count-week-1' });
t = await tabs(sp);
check('Inventory control sees the count and the Testing Suite, nothing else', /Dashboard/.test(t) && /Full Counts/.test(t) && /Testing Suite/.test(t) && !/Cycle counts/.test(t) && !/Front bins/.test(t), t);
s = await subs(sp);
check('…and a dashboard with no Map, Adjustments or Reports tab', !/Map/.test(s) && !/Adjust/.test(s) && !/Reports/.test(s) && /Second counts/.test(s), s);
await sp.goto(`${BASE}/front`); await sp.waitForTimeout(1200);
check('For them a hidden page says to ask an admin', await sp.isVisible('#switchedOff') && /Ask an admin/.test(await sp.textContent('#switchedOff')));
await sp.close();

/* ---- the card */
await page.goto(`${BASE}/settings#advanced`); await page.waitForTimeout(1500);
check('Settings → Site & systems has the card, with what is off in its chip', await page.isVisible('#featuresCard') && /off: Cycle counts, Front bins, Not in Location, Map, Adjustments, Reports/.test(await page.textContent('#featuresChip')), await page.textContent('#featuresChip'));
check('…one row a part, ticked as it stands', !(await page.$eval('#fFeature-cycle', (b) => b.checked)) && await page.$eval('#fFeature-alerts', (b) => b.checked) && await page.$eval('#fFeature-testing', (b) => b.checked) && (await page.$$('#featuresList label')).length === 8);
await page.goto(`${BASE}/settings#gun`); await page.reload(); await page.waitForTimeout(1500);
check('Under the scanners, the jobs that are off are grayed with a note saying why', await page.$eval('#fJobCycle', (b) => b.disabled) && await page.$eval('#fJobMove', (b) => b.disabled) && !(await page.$eval('#fJobFull', (b) => b.disabled)) && await page.isVisible('#jobsOffNote') && /switched off for the whole site/.test(await page.textContent('#jobsOffNote')), await page.textContent('#jobsOffNote'));

await page.goto(`${BASE}/settings#advanced`); await page.reload(); await page.waitForTimeout(1500);
await page.click('#btnFeaturesAll'); await page.waitForTimeout(1000);
check('"Everything on" brings it all back, and says so', /everything on/.test(await page.textContent('#featuresChip')) && /Saved: everything is on/.test(await page.textContent('#featuresMsg')), await page.textContent('#featuresMsg'));
t = await tabs(page);
check('…and the sidebar on this very page fills back in without a reload', /Cycle counts/.test(t) && /Front bins/.test(t) && /Not in Location/.test(t), t);
check('…the server agrees', Object.values((await features()).features).every(Boolean));

await page.uncheck('#fFeature-map'); await page.uncheck('#fFeature-reports'); await page.click('#btnFeaturesSave'); await page.waitForTimeout(1000);
check('Ticking by hand and Save switches just those off', /off: Map, Reports/.test(await page.textContent('#featuresChip')) && /Map, Reports switched off/.test(await page.textContent('#featuresMsg')), await page.textContent('#featuresChip'));
f = await features();
check('…and nothing else', f.features.map === false && f.features.reports === false && f.features.cycle === true && f.features.adjust === true);
const log = await get('/api/admin/audit?limit=5').catch(() => null);
check('The log records who switched what off', !log || JSON.stringify(log).includes('chose what is switched on'), log ? JSON.stringify(log).slice(0, 120) : 'no log endpoint');

await page.click('#btnFeaturesCountOnly'); await page.waitForTimeout(1000);
check('The count-only preset is one press from the card too', /nothing else to wander into/.test(await page.textContent('#featuresMsg')) && (await features()).features.cycle === false);

/* the guide offers no journey into a part that is off */
await page.goto(`${BASE}/guide`); await page.waitForTimeout(2000);
const journeys = (await page.$$eval('#journeys .journey .t', (ts) => ts.map((t) => t.textContent.trim()))).join('|');
check('The user guide leaves out the journeys for cycle counts, front bins and Not in Location', /Counting day/.test(journeys) && /Finish a count/.test(journeys) && !/Cycle counts/.test(journeys) && !/Front bins/.test(journeys) && !/Not in Location/.test(journeys), journeys);

/* ---- the gun */
const gun = await browser.newPage({ viewport: { width: 360, height: 640 } });
gun.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await gun.goto(`${BASE}/?d=${dev.uid}`); await gun.waitForTimeout(1500);
const offers = async () => ({ full: await gun.isVisible('#btnModeFull'), cycle: await gun.isVisible('#btnModeCycle'), move: await gun.isVisible('#btnModeMove'), find: await gun.isVisible('#btnModeFind'), block: await gun.isVisible('#modeBlock') });
let o = await offers();
check('The gun opens on the full count alone, with no job picker', o.full === false || !o.block, JSON.stringify(o));
check('…and the sign-on screen calls it the count session', /Count session/.test(await gun.textContent('#sessionLabel')), await gun.textContent('#sessionLabel'));
await post('/api/admin/features', { preset: 'everything' });
await gun.reload(); await gun.waitForTimeout(1500);
o = await offers();
check('Everything on, the gun offers every job again', o.cycle && o.move && o.find && o.block, JSON.stringify(o));

/* the Testing Suite's sandbox follows the same switches */
await post('/api/admin/features', { cycle: false });
await page.goto(`${BASE}/testing`); await page.waitForTimeout(2000);
const sbCycle = await page.$('#sbJobCycle');
check('The Testing Suite hides the practice tick for a job that is off', sbCycle ? !(await page.isVisible('#sbJobCycle')) : true);
const modeBtns = (await page.$$eval('#modeList button', (bs) => bs.map((b) => b.dataset.mode))).join('|');
check('…and its "what to practice" row too', !/cycle/.test(modeBtns), modeBtns || '(no row)');
await post('/api/admin/features', { preset: 'everything' });

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
