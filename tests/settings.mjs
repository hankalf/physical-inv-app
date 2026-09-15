/* Settings: per-supervisor logins, and the setup cards that moved off the dashboard. */
import { chromium } from 'playwright-core';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = (body) => fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
const bearer = (t) => ({ ...hdr, authorization: 'Bearer ' + t });

/* ---------------- the shared password, before anyone has an account ---------------- */
const shared = await login({ password: 'changeme', name: 'Dana' });
const D = await j(shared);
check('The shared password still works when there are no accounts', shared.ok && D.role === 'admin' && D.shared === true, `${D.name} / ${D.role}`);
const A = bearer(D.token);
const me0 = await j(await fetch(`${BASE}/api/admin/me`, { headers: A }));
check('Who am I: the shared password has no username of its own', me0.username === '' && me0.accounts === 0 && me0.sharedLogin === true, JSON.stringify(me0));
check('Who am I needs a sign-in', (await fetch(`${BASE}/api/admin/me`)).status === 401);

/* ---------------- creating accounts ---------------- */
const dana = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'dana', name: 'Dana Whitfield', password: 'freezer-2026', role: 'admin' }) }));
check('An account is created, and the username is normalised', dana.username === 'DANA' && dana.role === 'admin' && dana.active === true, JSON.stringify(dana));
const sam = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'SAM', name: 'Sam Ortiz', password: 'dock-truck-9' }) }));
check('An account defaults to supervisor, not admin', sam.role === 'supervisor', sam.role);
check('No password comes back from the server, ever', !('password' in dana) && !('password_hash' in dana), Object.keys(dana).join(','));

const shortPw = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'PAT', password: 'short' }) });
check('A short password is refused', shortPw.status === 400 && /at least 8/.test((await j(shortPw)).error), '');
const badName = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'a b/c', password: 'long-enough-1' }) });
check('A username with spaces or slashes is refused', badName.status === 400, String(badName.status));
const dupe = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'Dana', password: 'long-enough-1' }) });
check('The same username cannot be taken twice', dupe.status === 409, String(dupe.status));

/* ---------------- signing in as yourself ---------------- */
const asDana = await login({ username: 'dana', password: 'freezer-2026' });
const DA = await j(asDana);
check('A supervisor signs in with their own username and password', asDana.ok && DA.username === 'DANA' && DA.name === 'Dana Whitfield' && !DA.shared, `${DA.name} (${DA.role})`);
const wrong = await login({ username: 'dana', password: 'freezer-2025' });
check('A wrong password on a real account is refused', wrong.status === 401 && /do not match/.test((await j(wrong)).error), '');
const sneak = await login({ username: 'dana', name: 'dana', password: 'changeme' });
check('The shared password does NOT open somebody else\'s account', sneak.status === 401, String(sneak.status));
const unknown = await login({ username: 'Casey', name: 'Casey', password: 'changeme' });
check('A name that is not an account still signs in on the shared password, recorded as that name',
  unknown.ok && (await j(unknown.clone())).name === 'Casey' && (await j(unknown)).shared === true, '');

/* ---------------- what a plain supervisor may not do ---------------- */
const SAM = bearer((await j(await login({ username: 'SAM', password: 'dock-truck-9' }))).token);
const nope = await fetch(`${BASE}/api/admin/users`, { headers: SAM });
check('A supervisor cannot even list the accounts', nope.status === 403 && /only an admin/.test((await j(nope)).error), String(nope.status));
const nope2 = await fetch(`${BASE}/api/admin/users/DANA`, { method: 'DELETE', headers: SAM });
check('A supervisor cannot delete an account', nope2.status === 403, String(nope2.status));
const yes = await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: SAM, body: JSON.stringify({ name: 'supervisor session' }) });
check('A supervisor CAN do the actual work — create a count session', yes.ok, String(yes.status));

/* ---------------- your own password ---------------- */
const badCurrent = await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: SAM, body: JSON.stringify({ current: 'nope', next: 'new-password-1' }) });
check('Changing your password needs the old one', badCurrent.status === 403, String(badCurrent.status));
const changed = await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: SAM, body: JSON.stringify({ current: 'dock-truck-9', next: 'high-reach-77' }) });
check('You can change your own password', changed.ok && (await login({ username: 'SAM', password: 'high-reach-77' })).ok, '');
const sharedPw = await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: A, body: JSON.stringify({ current: 'changeme', next: 'something-else' }) });
check('The shared password has no account, so it cannot be changed here', sharedPw.status === 400, String(sharedPw.status));

/* ---------------- the last admin ---------------- */
const lastAdmin = await fetch(`${BASE}/api/admin/users/DANA`, { method: 'POST', headers: bearer(DA.token), body: JSON.stringify({ role: 'supervisor' }) });
check('The last admin cannot demote themselves out of existence', lastAdmin.status >= 400 && /last admin/.test((await j(lastAdmin)).error), '');
await fetch(`${BASE}/api/admin/users/SAM`, { method: 'POST', headers: bearer(DA.token), body: JSON.stringify({ role: 'admin' }) });
const nowFine = await fetch(`${BASE}/api/admin/users/DANA`, { method: 'POST', headers: bearer(DA.token), body: JSON.stringify({ role: 'supervisor' }) });
check('With a second admin in place, the first can step down', nowFine.ok, String(nowFine.status));
await fetch(`${BASE}/api/admin/users/DANA`, { method: 'POST', headers: bearer(DA.token), body: JSON.stringify({ role: 'admin' }) });

const off = await fetch(`${BASE}/api/admin/users/SAM`, { method: 'POST', headers: A, body: JSON.stringify({ active: false }) });
check('An account can be deactivated', off.ok && (await j(off)).active === false, '');
check('A deactivated account cannot sign in', (await login({ username: 'SAM', password: 'high-reach-77' })).status === 401);
check('...and cannot slip in on the shared password either', (await login({ username: 'SAM', name: 'SAM', password: 'changeme' })).status === 401);

/* ---------------- it is all in the log ---------------- */
const log = await j(await fetch(`${BASE}/api/admin/audit?limit=100`, { headers: A }));
const actions = log.map((r) => r.action);
check('Account changes are recorded against the person who made them',
  actions.includes('created an account') && actions.includes('changed an account') && log.find((r) => r.action === 'created an account').actor === 'Dana',
  actions.slice(0, 6).join(' · '));
check('Use of the shared password is logged as exactly that',
  log.some((r) => r.action === 'signed in with the shared password'), '');
check('A sign-in with a real account is logged with the username',
  log.some((r) => r.action === 'signed in' && /as DANA \(admin\)/.test(r.detail || '')), '');

/* ================= in the browser ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.25 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/40[19]|403/.test(m.text())) errors.push(m.text()); });
page.on('dialog', (d) => d.accept('reset-password-42'));

await page.goto(BASE + '/settings');
check('Settings: /settings serves the page', await page.title() === 'Settings');
await page.fill('#fUser', 'nobody'); await page.fill('#fPassword', 'wrong'); await page.click('#btnLogin'); await page.waitForTimeout(400);
check('Settings: a bad sign-in says so and stays on the sign-in screen',
  clean(await page.textContent('#loginMsg')).length > 0 && (await page.$('#scrLogin.active')) !== null, clean(await page.textContent('#loginMsg')));
await page.fill('#fUser', 'DANA'); await page.fill('#fPassword', 'freezer-2026'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1500);
check('Settings: signing in as an account shows who you are in the header',
  /Dana Whitfield/.test(clean(await page.textContent('#navWho'))) && /admin/.test(clean(await page.textContent('#navWho'))), clean(await page.textContent('#navWho')));

const headings = await page.$$eval('#scrMain .card > h2', (h) => h.map((x) => x.firstChild.textContent.trim()));
check('Settings: the six setup cards are all on this page',
  ['Supervisor logins', 'Scanner setup', 'Upload lists (CSV)', 'Aisles & racking blocks', 'Send to the ERP', 'Backups & log']
    .every((t) => headings.some((h) => h.startsWith(t))), headings.join(' | '));

const dash = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await dash.goto(BASE + '/admin');
const dashHeadings = await dash.$$eval('#scrMain .card > h2', (h) => h.map((x) => x.firstChild.textContent.trim()));
check('Dashboard: the setup cards are gone from it',
  !dashHeadings.some((h) => /Scanners|Upload lists|Aisles & racking|Send to the ERP|Backups/.test(h))
    && dashHeadings.some((h) => h.startsWith('Count progress')) && dashHeadings.some((h) => h.startsWith('Team assignments')),
  dashHeadings.join(' | '));
await dash.close();

check('Settings: the accounts table lists everyone', (await page.$$('#userTable tbody tr')).length === 2, clean(await page.textContent('#userTable')).slice(0, 120));
await page.fill('#fNewUser', 'RILEY'); await page.fill('#fNewFullName', 'Riley Chen'); await page.fill('#fNewPass', 'scissor-lift-3');
await page.click('#btnAddUser'); await page.waitForTimeout(900);
check('Settings: a login can be added from the page', /Added RILEY/.test(clean(await page.textContent('#userMsg'))) && (await page.$$('#userTable tbody tr')).length === 3, clean(await page.textContent('#userMsg')).slice(0, 90));
await page.click('#userTable tbody tr:has-text("RILEY") button:text-is("Reset password")'); await page.waitForTimeout(700);
check('Settings: an admin can reset somebody\'s password for them',
  (await login({ username: 'RILEY', password: 'reset-password-42' })).ok, '');
await page.screenshot({ path: `${S}screenshots/settings-accounts.png`, clip: await page.$eval('#userTable', (el) => { const r = el.closest('.card').getBoundingClientRect(); return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, 640) }; }) });

// a plain supervisor sees the page, but not the account controls
const sup = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await sup.goto(BASE + '/settings');
await sup.fill('#fUser', 'RILEY'); await sup.fill('#fPassword', 'reset-password-42'); await sup.click('#btnLogin');
await sup.waitForSelector('#scrMain.active'); await sup.waitForTimeout(1200);
check('Settings: a supervisor is told account management is an admin job, and keeps the rest',
  await sup.$eval('#adminOnly', (el) => el.hidden) && !(await sup.$eval('#notAdmin', (el) => el.hidden))
    && !(await sup.$eval('#ownPassword', (el) => el.hidden)) && (await sup.$$('#deviceTable tbody tr')).length >= 0,
  clean(await sup.textContent('#notAdmin')).slice(0, 80));
await sup.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} settings checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
