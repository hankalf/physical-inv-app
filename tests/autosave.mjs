/*
 * Settings save themselves. A tick or a choice on a settings card saves at
 * once, a typed value once the typing stops, a list edited with its Add and
 * Remove buttons after the click - with no Save pressed. The Save button stays,
 * says Saved ✓, and still works. The integrations keep a real Save.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession, expandSubTabs } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const get = async (p) => j(await fetch(BASE + p, { headers: A }));
const S = (await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'Autosave count' }) }))).id;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/settings#gun`);
await signIn(page);
await pickSession(page, S);
await page.waitForSelector('#countGunCard');
check('The settings cards say they save as you change them', (await page.$$('.autosave-note')).length >= 6 && /saves as you change it/.test(clean(await page.textContent('#countGunCard'))));

/* a tick on the count's card */
const before = await get(`/api/admin/sessions/${S}`);
await page.click('#fThirdCount'); await page.waitForTimeout(900);
let s = await get(`/api/admin/sessions/${S}`);
check('Tick Third count: saved with no Save pressed', before.third_count !== s.third_count && !!s.third_count, `${before.third_count} -> ${s.third_count}`);
check('…the Save button said so', /Saved ✓|Save/.test(clean(await page.textContent('#btnSaveSettings'))) && /Settings saved/.test(clean(await page.textContent('#countGunMsg'))), clean(await page.textContent('#countGunMsg')).slice(0, 60));
/* a typed threshold: saved once the typing stops */
await page.fill('#fRecMinQty', '7'); await page.waitForTimeout(300);
check('Typing a threshold does not save on every keystroke', Number((await get(`/api/admin/sessions/${S}`)).recount_min_qty || 0) !== 7);
await page.waitForTimeout(1400);
check('…it saves once the typing stops', Number((await get(`/api/admin/sessions/${S}`)).recount_min_qty) === 7);
/* a tick that needs a value typed first waits for it */
await page.click('#fRecountTeamOn'); await page.waitForTimeout(900);
check('Send them all to team, ticked with no team yet: no error, nothing saved until the team is typed', !/Which team/.test(clean(await page.textContent('#countGunMsg'))) && !(await get(`/api/admin/sessions/${S}`)).recount_team);
await page.fill('#fRecountTeam', '90'); await page.waitForTimeout(1500);
s = await get(`/api/admin/sessions/${S}`);
check('…type the team and it saves', String(s.recount_team) === '90', JSON.stringify(s.recount_team));

/* the scanners' offers: a tick, and a chip added */
await page.click('#fJobCycle'); await page.waitForTimeout(1500);
check('What the scanners offer: untick a job and it is saved', (await get('/api/admin/scanner-jobs')).jobs.cycle === false);
const sosBefore = (await get('/api/admin/sos-reasons')).reasons.length;
await page.fill('#fNewSos', 'Spill on the dock'); await page.waitForTimeout(1200);
check('Typing a new SOS reason saves nothing yet', (await get('/api/admin/sos-reasons')).reasons.length === sosBefore);
await page.click('#btnAddSos'); await page.waitForTimeout(1800);
const sos = (await get('/api/admin/sos-reasons')).reasons;
check('…Add puts it on the list and the list is saved', sos.length === sosBefore + 1 && sos.includes('Spill on the dock'), sos.join(' | '));

/* the stopped-scanning alert: a number */
await page.fill('#fIdleMinutes', '23'); await page.waitForTimeout(1500);
check('The stopped-scanning minutes save as typed', (await get('/api/admin/idle-config')).minutes === 23);

/* an integration keeps its Save */
check('The Teams channel, Google Drive, OneDrive and the pallet system keep a real Save', !(await page.$('#teamsCard .autosave-note')) && !(await page.$('#gdriveCard .autosave-note')) && !(await page.$('#palletSystemCard .autosave-note')));

/* the Teams page: the level rules */
await page.goto(`${BASE}/teams`);
if (await page.isVisible('#fPassword')) await signIn(page); else { await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); }
await page.waitForSelector('#rules .rule', { timeout: 10000 });
const rulesBefore = (await get('/api/admin/people')).config.levelRules.length;
await page.click('#btnAddRule'); await page.waitForTimeout(1200);
await page.fill('#rules .rule:last-child .lv', 'G'); await page.waitForTimeout(1500);
const rules = (await get('/api/admin/people')).config.levelRules;
check('Teams page: add a level rule and type its levels, saved with no Save rules pressed', rules.length === rulesBefore + 1 && rules[rules.length - 1].levels === 'G', JSON.stringify(rules.map((r) => r.levels)));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
