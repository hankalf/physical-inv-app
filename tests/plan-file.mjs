/*
 * Dashboard → Team plan: every team on Teams & crew has a row on the plan
 * before anything is queued for it; the plan goes out as a CSV in the
 * columns the upload reads, and comes back in - with a sample to start from.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + await login({ password: 'changeme' }) };
const csv = (h) => ({ authorization: h.authorization, 'content-type': 'text/csv' });
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));

/* a count with five aisles, and three teams on Teams & crew with nothing queued */
const S = (await j(await post('/api/admin/sessions', { name: 'Plan file count' }))).id;
const AISLES = ['P11', 'P12', 'P13', 'P14', 'P15'];
await post(`/api/admin/sessions/${S}/master?kind=bins`, 'Bin Location,Zone,Aisle\n' + AISLES.map((a) => `${a}A001,Dry,${a}\n${a}A002,Dry,${a}`).join('\n') + '\n', csv(A));
for (const name of ['31', '32', '33']) await post('/api/admin/people/teams', { name, shift: name === '33' ? '2' : '1' });

let r = await fetch(`${BASE}/api/admin/sessions/${S}/plan`, { headers: A });
let d = await j(r);
check('The plan knows every team on Teams & crew, queued or not', r.status === 200 && ['31', '32', '33'].every((n) => d.teams.some((t) => t.name === n)), JSON.stringify(d.teams && d.teams.map((t) => t.name)));

/* queue by hand, then export */
await post(`/api/admin/sessions/${S}/assignments`, { team: '31', aisles: 'P11, P12', levels: 'A-C', force: true });
await post(`/api/admin/sessions/${S}/assignments`, { team: '32', aisles: 'P13', levels: 'A-F', direction: 'down', force: true });
r = await fetch(`${BASE}/api/admin/sessions/${S}/export/plan.csv`, { headers: A });
const out = await r.text();
const lines = out.trim().split(/\r?\n/);
check('Export the plan: a CSV named for the count, in the upload\'s columns plus Status', r.status === 200 && /plan-Plan-file-count\.csv/.test(r.headers.get('content-disposition') || '') && lines[0] === 'Team,Aisle,Levels,Start,Status', `${r.headers.get('content-disposition')} | ${lines[0]}`);
check('…a row per assignment, team by team in counting order, levels as a range', lines.slice(1).join('|') === '31,P11,A-C,001 end,counting|31,P12,A-C,001 end,queued|32,P13,A-F,far end,counting', lines.slice(1).join('|'));

/* round trip: the exported file comes back, replacing what is queued, with one line changed */
const edited = out.replace('31,P12,A-C,001 end,queued', '33,P14,D-F,001 end,queued') + '33,P15,D-F,far end,\n31,NOPE,A-C,,\n';
r = await post(`/api/admin/sessions/${S}/plan?replace=1`, edited, csv(A));
let st = await j(r);
check('Upload it back with Replace: every row taken, the unknown aisle skipped and said', r.status === 200 && st.planned === 4 && st.skipped === 1, JSON.stringify({ planned: st.planned, skipped: st.skipped }));
const plan = (await get(`/api/admin/sessions/${S}/assignments`)).map((a) => `${a.team}:${a.aisle}:${a.levels}:${a.direction}`).sort().join('|');
check('…the plan is the file: team 33 has P14 and P15 (from the far end), P12 is gone', plan === '31:P11:ABC:up|32:P13:ABCDEF:down|33:P14:DEF:up|33:P15:DEF:down', plan);
check('…and the log says a plan was uploaded', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'uploaded a counting plan' && /4 aisle assignment/.test(x.detail) && /replacing/.test(x.detail)));
r = await post(`/api/admin/sessions/${S}/plan`, 'Team,Aisle,Levels\n31,P15,A-C\n', csv(A));
check('Without Replace, a plan adds to what is there', (await j(r)).planned === 1 && (await get(`/api/admin/sessions/${S}/assignments`)).length === 5);
check('The sample plan downloads', (await fetch(`${BASE}/templates/plan-template.csv`)).ok);

/* who may: queueing needs Queue aisles; the file out needs Downloads */
await post('/api/admin/users', { username: 'PLAN-LOOK', name: 'Pat Look', password: 'only-looks-1', mustChange: false, profile: 'custom', access: ['dashboard.teams'] });
const L = { ...hdr, authorization: 'Bearer ' + await login({ username: 'PLAN-LOOK', password: 'only-looks-1' }) };
check('A login with the Team plan but not Queue aisles sees the teams, but may not upload a plan', (await fetch(`${BASE}/api/admin/sessions/${S}/plan`, { headers: L })).status === 200
  && (await post(`/api/admin/sessions/${S}/plan`, 'Team,Aisle,Levels\n31,P14,A-C\n', csv(L))).status === 403);
check('…nor export one without Downloads', (await fetch(`${BASE}/api/admin/sessions/${S}/export/plan.csv`, { headers: L })).status === 403);

/* ------------------------------------------------------------------ the page */
await post('/api/admin/people/teams', { name: '34', shift: '1' });         // a fourth team, nothing queued
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (dlg) => dlg.accept());
await page.goto(`${BASE}/admin#teams`);
await signIn(page);
await pickSession(page, S);
await page.waitForSelector('#teamList .team[data-team="34"]', { timeout: 8000 }).catch(() => {});
const box = page.locator('#teamList .team[data-team="34"]');
check('Team plan: a team from Teams & crew with nothing queued has its own row', (await box.count()) === 1 && /nothing queued/.test(clean(await box.textContent())), clean(await box.textContent().catch(() => '')));
await box.locator('button[data-queue-for="34"]').click();
check('…Queue aisles for this team fills the form with it, and puts the cursor on the aisles', (await page.inputValue('#fAssignTeam')) === '34' && await page.evaluate(() => document.activeElement && document.activeElement.id === 'fAssignAisles'));
check('…and the Team box offers every team by name', (await page.$$eval('#planTeamNames option', (o) => o.map((x) => x.value))).join() === '31,32,33,34');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnPlanExport')]);
check('⬇ Export the plan downloads it, named for the count', /^plan-Plan-file-count\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
await page.setInputFiles('#fPlanFile', { name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from('Team,Aisle,Levels,Start\n34,P12,A-C,far end\n') });
await page.click('#btnPlanUpload');
await page.waitForTimeout(1200);
check('Upload a plan on the tab: it says what came in, and team 34 is counting P12', /1 aisle assignment from plan\.csv/.test(clean(await page.textContent('#planFileMsg'))) && /P12/.test(await page.textContent('#teamList .team[data-team="34"]')), clean(await page.textContent('#planFileMsg')));
await page.click('#btnPlanUpload');
check('Upload with no file chosen says what to choose', /Choose a plan file first/.test(await page.textContent('#planFileMsg')));
check('⬇ Sample plan links the template', (await page.getAttribute('#lnkPlanSample', 'href')) === '/templates/plan-template.csv');
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
