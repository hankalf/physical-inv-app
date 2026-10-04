/* Who may do what. Each login can be limited to the pages and the functions
   it needs; Settings (and Advanced within it) is for admins only. The server
   says no with a 403 whatever the page shows, and the sidebar only offers what
   the person may open. */
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }));
const shared = await login({ password: 'changeme', name: 'Dana Whitfield' });
const A = { ...hdr, authorization: 'Bearer ' + shared.token };

/* an admin account, a limited supervisor, and a count to act on */
await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'DANA', name: 'Dana Whitfield', password: 'freezer-2026', role: 'admin', mustChange: false }) });
const sue = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'SUE', name: 'Sue Park', password: 'dock-side-77', mustChange: false, access: ['dashboard', 'teams', 'alerts'] }) }));
check('A login can be made with a list of what it may use', Array.isArray(sue.access) && sue.access.join() === 'dashboard,teams,alerts', JSON.stringify(sue.access));
const full = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'SAM', name: 'Sam Ortiz', password: 'reach-truck-9', mustChange: false }) }));
check('…and one made without a list may use everything a supervisor can', full.access === null, JSON.stringify(full.access));
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'access check' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: { authorization: A.authorization, 'content-type': 'text/csv' }, body: 'Bin Location\nF01A001\nF01A002\n' });

const sueIn = await login({ username: 'SUE', password: 'dock-side-77' });
const S = { ...hdr, authorization: 'Bearer ' + sueIn.token };
const me = await j(await fetch(`${BASE}/api/admin/me`, { headers: S }));
check('Who am I carries the list, so the pages can follow it', me.role === 'supervisor' && Array.isArray(me.access) && me.access.includes('dashboard') && !me.access.includes('testing'), JSON.stringify(me.access));

/* what she may and may not do, on the server */
const st = async (path, init = {}) => (await fetch(BASE + path, { ...init, headers: { ...S, ...(init.headers || {}) } })).status;
check('Allowed: the dashboard\'s own data', await st(`/api/admin/sessions/${sess.id}/progress`) === 200);
check('Allowed: the crew (Teams & crew is on her list)', await st('/api/admin/people') === 200);
check('Refused: the Testing Suite (not on her list)', await st('/api/admin/practice') === 403);
check('Refused: Not in Location (not on her list)', await st('/api/admin/missing') === 403);
check('Refused: messaging the floor — a function she was not given', await st(`/api/admin/sessions/${sess.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'hello' }) }) === 403);
check('Refused: approving adjustments', await st(`/api/admin/sessions/${sess.id}/adjustments/decide`, { method: 'POST', body: JSON.stringify({ palletIds: ['X'], decision: 'approve' }) }) === 403);
check('Refused: queueing aisles', await st(`/api/admin/sessions/${sess.id}/assignments`, { method: 'POST', body: JSON.stringify({ team: '1', aisles: ['F01'] }) }) === 403);
check('Refused: an export', await st(`/api/admin/sessions/${sess.id}/export/counts.csv`) === 403);
check('Allowed: answering an SOS (she has alerts)', await st(`/api/admin/sessions/${sess.id}/alerts/999999/seen`, { method: 'POST', body: '{}' }) !== 403);
check('Refused: anything under Settings — registering a scanner', await st('/api/admin/devices', { method: 'POST', body: JSON.stringify({ name: 'SUE-01' }) }) === 403);
check('Refused: Settings — making a count', await st('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ name: 'sue count' }) }) === 403);
check('Refused: Settings — changing a count\'s options', await st(`/api/admin/sessions/${sess.id}/settings`, { method: 'POST', body: JSON.stringify({ guided: false }) }) === 403);
check('Refused: Settings — the logo, the Teams channel, the SOS list', await st('/api/admin/logo', { method: 'POST', body: JSON.stringify({ onGuns: false }) }) === 403
  && await st('/api/admin/teams-webhook', { method: 'POST', body: '{}' }) === 403 && await st('/api/admin/sos-reasons', { method: 'POST', body: JSON.stringify({ reasons: [] }) }) === 403);
check('Refused: Settings — a list upload', await st(`/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: 'Bin Location\nX\n' }) === 403);
check('Allowed: reading the site settings the dashboard needs', await st('/api/admin/layouts') === 200 && await st('/api/admin/sessions') === 200);

/* the roles: presets of the list */
const ivy = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'IVY', name: 'Ivy Chen', password: 'count-desk-11', mustChange: false, profile: 'inventory' }) }));
check('A login can be made with a role: Inventory control is the count, adjustments and downloads', ivy.profile === 'inventory' && ivy.role === 'supervisor' && ivy.access.join() === 'dashboard,full,testing,approve,export', JSON.stringify([ivy.profile, ivy.access]));
const ivyIn = await login({ username: 'IVY', password: 'count-desk-11' });
const I = { ...hdr, authorization: 'Bearer ' + ivyIn.token };
const stI = async (path, init = {}) => (await fetch(BASE + path, { ...init, headers: { ...I, ...(init.headers || {}) } })).status;
check('…so Inventory control may read the count and approve', await stI(`/api/admin/sessions/${sess.id}/progress`) === 200 && await stI(`/api/admin/sessions/${sess.id}/adjustments/decide`, { method: 'POST', body: JSON.stringify({ palletIds: [], decision: 'approve' }) }) !== 403);
check('…but nothing on teams, warehouse jobs or cycle counts', await stI('/api/admin/people') === 403 && await stI('/api/admin/missing') === 403 && await stI(`/api/admin/sessions/${sess.id}/cycle/batches`) === 403 && await stI(`/api/admin/sessions/${sess.id}/moves`) === 403);
check('Who am I lists the roles on offer', ((await j(await fetch(`${BASE}/api/admin/me`, { headers: A }))).profiles || []).some((pr) => pr.key === 'inventory'));
check('A list ticked by hand reads as Custom', (await j(await fetch(`${BASE}/api/admin/users/IVY`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['dashboard'] }) }))).profile === 'custom');
check('…and picking the role again puts the preset back', (await j(await fetch(`${BASE}/api/admin/users/IVY`, { method: 'POST', headers: A, body: JSON.stringify({ profile: 'inventory' }) }))).access.join() === 'dashboard,full,testing,approve,export');
check('A role that is not on offer is refused', (await fetch(`${BASE}/api/admin/users/IVY`, { method: 'POST', headers: A, body: JSON.stringify({ profile: 'overlord' }) })).status === 400);

/* down to the tab: a page, or just some of its tabs */
const tabbed = await j(await fetch(`${BASE}/api/admin/users/IVY`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['dashboard.progress', 'dashboard.reports', 'export'] }) }));
check('A login can be given single tabs of a page', tabbed.access.join() === 'dashboard.progress,dashboard.reports,export', JSON.stringify(tabbed.access));
check('…which lets her into the page, and those tabs', await stI(`/api/admin/sessions/${sess.id}/progress`) === 200 && await stI(`/api/admin/sessions/${sess.id}/pallets`) === 200 && await stI(`/api/admin/sessions/${sess.id}/export/counts.csv`) === 200);
check('…and not the other tabs', await stI(`/api/admin/sessions/${sess.id}/map`) === 403 && await stI(`/api/admin/sessions/${sess.id}/adjustments`) === 403 && await stI(`/api/admin/sessions/${sess.id}/recounts`) === 403 && await stI(`/api/admin/sessions/${sess.id}/alerts`) === 403);
check('Giving the whole page drops the tab keys as redundant', (await j(await fetch(`${BASE}/api/admin/users/IVY`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['dashboard', 'dashboard.map', 'export'] }) }))).access.join() === 'dashboard,export');
check('Who am I says which tabs each page has', Array.isArray((await j(await fetch(`${BASE}/api/admin/me`, { headers: A }))).tabs.dashboard));
await fetch(`${BASE}/api/admin/users/IVY`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['dashboard.progress', 'dashboard.reports', 'export'] }) });

/* a supervisor with no list is as before, bar Settings */
const samIn = await login({ username: 'SAM', password: 'reach-truck-9' });
const M = { ...hdr, authorization: 'Bearer ' + samIn.token };
const stM = async (path, init = {}) => (await fetch(BASE + path, { ...init, headers: { ...M, ...(init.headers || {}) } })).status;
check('A supervisor with no list may message the floor', await stM(`/api/admin/sessions/${sess.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'hello' }) }) === 200);
check('…open the Testing Suite', await stM('/api/admin/practice') === 200);
check('…but not Settings', await stM('/api/admin/devices', { method: 'POST', body: JSON.stringify({ name: 'SAM-01' }) }) === 403 && await stM('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ name: 'x' }) }) === 403);

/* the list can be changed, and the change bites at once */
const widened = await j(await fetch(`${BASE}/api/admin/users/SUE`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['dashboard', 'messages'] }) }));
check('An admin can change what a login may use', widened.access.join() === 'dashboard,messages');
check('…and it applies to the next request, no sign-out needed', await st(`/api/admin/sessions/${sess.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'now allowed' }) }) === 200
  && await st('/api/admin/people') === 403);
check('An admin\'s list is ignored: admins have everything', (await j(await fetch(`${BASE}/api/admin/users/DANA`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['dashboard'] }) }))).access === null);
check('A key that does not exist is refused', (await fetch(`${BASE}/api/admin/users/SUE`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['launch-codes'] }) })).status === 400);
await fetch(`${BASE}/api/admin/users/SUE`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['dashboard', 'teams', 'alerts'] }) });

/* ---------------- in the browser ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/admin');
await page.fill('#fUser', 'SUE'); await page.fill('#fPassword', 'dock-side-77'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1500);
const tabs = await page.$$eval('#navTabs .tab', (a) => a.map((x) => x.getAttribute('href')));
check('The sidebar offers only what she may open, plus the guide everyone gets', tabs.join(',') === '/admin,/full,/teams,/guide', tabs.join(','));
check('Message the floor is there to read but not to send', await page.$eval('#btnSendMsg', (b) => b.disabled) && /not able|no access|not allowed/i.test(await page.$eval('#btnSendMsg', (b) => b.title)), await page.$eval('#btnSendMsg', (b) => b.title));
check('Queueing aisles is switched off for her', await page.$eval('#btnAssign', (b) => b.disabled));
await page.goto(BASE + '/settings'); await page.waitForTimeout(2500);
check('Typing /settings into the bar does not get her in', !/\/settings/.test(page.url()) || await page.isVisible('#noAccess'), page.url());
await page.goto(BASE + '/testing'); await page.waitForTimeout(2500);
check('Nor the Testing Suite, which is not on her list', !/\/testing/.test(page.url()) || await page.isVisible('#noAccess'), page.url());

/* the admin sees the Access column and can tick things */
const adm = await browser.newPage({ viewport: { width: 1500, height: 950 } });
adm.on('pageerror', (e) => errors.push('admin: ' + e.message));
await adm.goto(BASE + '/settings#advanced');
await adm.fill('#fUser', 'DANA'); await adm.fill('#fPassword', 'freezer-2026'); await adm.click('#btnLogin');
await adm.waitForSelector('#scrMain.active'); await adm.waitForTimeout(1800);
const sueRow = adm.locator('#userTable tr', { hasText: 'SUE' });
check('Logins: each supervisor row sums up what they may use, in one line', /2 of 7 pages · 1 of 5 functions/.test(await sueRow.locator('details.accpick summary').textContent()), clean(await sueRow.locator('details.accpick summary').textContent()));
check('…an admin row says everything', /everything/i.test(await adm.locator('#userTable tr', { hasText: 'DANA-WHITFIELD' }).textContent()));
await sueRow.locator('details.accpick summary').click(); await adm.waitForTimeout(300);
check('…and opens into a checklist', await sueRow.locator('.accpanel').isVisible() && (await sueRow.locator('input[type=checkbox][data-access]').count()) === 12);
await sueRow.locator('input[data-access="testing"]').check(); await adm.waitForTimeout(900);
check('…whose summary follows the ticks', /3 of 7 pages/.test(await sueRow.locator('details.accpick summary').textContent()), clean(await sueRow.locator('details.accpick summary').textContent()));
check('Logins: the Role column is a picker with the presets', (await sueRow.locator('select.rolepick option').allTextContents()).some((t) => /Inventory control/.test(t)) && await sueRow.locator('select.rolepick').inputValue() === 'custom');
await sueRow.locator('select.rolepick').selectOption('inventory'); await adm.waitForTimeout(900);
check('…and picking Inventory control sets the list to the count, adjustments and downloads', (await j(await fetch(`${BASE}/api/admin/users`, { headers: A }))).users.find((u) => u.username === 'SUE').access.join() === 'dashboard,full,testing,approve,export');
await fetch(`${BASE}/api/admin/users/SUE`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['testing', 'dashboard'] }) });
check('Ticking a box saves it', (await j(await fetch(`${BASE}/api/admin/users`, { headers: A }))).users.find((u) => u.username === 'SUE').access.includes('testing'));
check('…and the page itself has the Advanced tab, being an admin', (await adm.$$eval('#subTabs button', (b) => b.map((x) => x.textContent.trim()))).some((t) => /Advanced/.test(t)));

/* the Testing Suite follows the list too: Sue now has testing and the dashboard, but no exports and no approvals */
await page.goto(BASE + '/testing'); await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(2500);
check('Testing Suite: no export buttons for a login without exports', await page.isHidden('#btnExportMine') && await page.isHidden('#btnExportRuns'));
check('…approvals are not offered to practise when she may not approve for real', (await page.$$('#optList .opt[data-key="requireApproval"]')).length === 0 && (await page.$$('#optList .opt[data-key="askLot"]')).length === 1);
check('…the server says the same', (await fetch(`${BASE}/api/admin/practice/options`, { method: 'POST', headers: S, body: JSON.stringify({ requireApproval: true }) })).status === 403
  && (await fetch(`${BASE}/api/admin/practice/export`, { headers: S })).status === 403);
check('…the office side is there, since she has the dashboard', !(await page.$eval('#dashCard', (el) => el.hidden)) && (await page.$$('#stepDots button')).length === 6);
await fetch(`${BASE}/api/admin/users/SUE`, { method: 'POST', headers: A, body: JSON.stringify({ access: ['testing', 'teams'] }) });
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(2500);
check('…and goes, with its step, when the dashboard is taken off her list', await page.$eval('#dashCard', (el) => el.hidden) && (await page.$$('#stepDots button')).length === 5, `${(await page.$$('#stepDots button')).length} steps`);

/* Ivy, with two tabs of the dashboard: the page shows just those */
const ivyPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
ivyPage.on('pageerror', (e) => errors.push('ivy: ' + e.message));
await ivyPage.goto(BASE + '/admin');
await ivyPage.fill('#fUser', 'IVY'); await ivyPage.fill('#fPassword', 'count-desk-11'); await ivyPage.click('#btnLogin');
await ivyPage.waitForSelector('#scrMain.active'); await ivyPage.waitForTimeout(2000);
const ivyTabs = await ivyPage.$$eval('#subTabs button', (b) => b.map((x) => x.textContent.replace(/\d+$/, '').trim()));
check('Tabs: the dashboard shows only the tabs she was given', ivyTabs.join(' | ') === 'Progress | Reports', ivyTabs.join(' | '));
check('…the sidebar lists only those sections too', (await ivyPage.$$eval('#navTabs .sub', (a) => a.map((x) => x.textContent.trim()))).join(' | ') === 'Progress | Reports', (await ivyPage.$$eval('#navTabs .sub', (a) => a.map((x) => x.textContent.trim()))).join(' | '));
// the pallet report is fetched when its tab is opened, not before
await ivyPage.click('#subTabs button[data-goto="reports"]'); await ivyPage.waitForTimeout(1500);
check('…and the page still works on what she has', /Count progress/.test(await ivyPage.textContent('#scrMain')) && (await ivyPage.$$('#palletTable tr')).length >= 1, `${(await ivyPage.$$('#palletTable tr')).length} rows`);
await ivyPage.close();
/* the popover offers the tabs under each page */
await adm.reload(); await adm.waitForSelector('#scrMain.active'); await adm.waitForTimeout(1500);
const ivyRow = adm.locator('#userTable tr', { hasText: 'IVY' });
await ivyRow.locator('details.accpick summary').click(); await adm.waitForTimeout(300);
check('Logins: the checklist shows each page\'s tabs underneath it', (await ivyRow.locator('input[data-tab^="dashboard."]').count()) === 7 && await ivyRow.locator('input[data-tab="dashboard.progress"]').isChecked() && !(await ivyRow.locator('input[data-tab="dashboard.map"]').isChecked()));
check('…and says the page is held in part', /in part/.test(await ivyRow.locator('details.accpick summary').textContent()), clean(await ivyRow.locator('details.accpick summary').textContent()));
await ivyRow.locator('input[data-tab="dashboard.map"]').check(); await adm.waitForTimeout(900);
check('…ticking a tab grants that tab', (await j(await fetch(`${BASE}/api/admin/users`, { headers: A }))).users.find((u) => u.username === 'IVY').access.includes('dashboard.map'));

/* ---- the site admin's account is nobody else's to change ---- */
await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'ADM2', name: 'Second Admin', password: 'dock-side-77', mustChange: false, role: 'admin' }) });
const adm2 = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'ADM2', password: 'dock-side-77' }) }))).token;
const A2 = { ...hdr, authorization: 'Bearer ' + adm2 };
const touch = await fetch(`${BASE}/api/admin/users/DANA-WHITFIELD`, { method: 'POST', headers: A2, body: JSON.stringify({ active: false }) });
check('Another admin cannot change the site admin\'s account', touch.status === 403 && /only the site admin/.test((await j(touch)).error), String(touch.status));
const del = await fetch(`${BASE}/api/admin/users/DANA-WHITFIELD`, { method: 'DELETE', headers: A2 });
check('…nor delete it', del.status === 403);
const other = await fetch(`${BASE}/api/admin/users/IVY`, { method: 'POST', headers: A2, body: JSON.stringify({ name: 'Ivy Stone' }) });
check('…while any other account is theirs to manage', other.status === 200, String(other.status));
const self = await fetch(`${BASE}/api/admin/users/DANA-WHITFIELD`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'Dana Whitfield' }) });
check('…and the site admin can still change its own', self.status === 200, String(self.status));

check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} access checks passed`);
if (results.some((r) => !r)) process.exitCode = 1;
