/* Settings: per-supervisor logins, and the setup cards that moved off the dashboard. */
import { chromium } from 'playwright-core';
import { expandSubTabs } from './helpers.mjs';

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

/* ---------------- a login that sets its own password ---------------- */
const gen = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'PAT', name: 'Pat Nkemelu' }) }));
check('With no password given, one is generated and handed back once',
  /^[a-z]+-[A-Z2-9]{4}$/.test(gen.starterPassword || '') && gen.mustChange === true, gen.starterPassword);
check('The starter is never shown again', !(await j(await fetch(`${BASE}/api/admin/users`, { headers: A }))).users.find((u) => u.username === 'PAT').starterPassword);
const patIn = await j(await login({ username: 'PAT', password: gen.starterPassword }));
check('The starter password signs them in, and says a real one is needed', patIn.mustChange === true, JSON.stringify(patIn.mustChange));
const PAT = bearer(patIn.token);
check('Who am I says so too, so a reload cannot skip the step', (await j(await fetch(`${BASE}/api/admin/me`, { headers: PAT }))).mustChange === true);
const same = await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: PAT, body: JSON.stringify({ current: gen.starterPassword, next: gen.starterPassword }) });
check('Keeping the starter as the new password is refused', same.status === 400 && /already have/.test((await j(same)).error), '');
const setOwn = await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: PAT, body: JSON.stringify({ current: gen.starterPassword, next: 'my-own-password' }) });
check('They set their own password and the flag clears', setOwn.ok && (await j(setOwn)).mustChange === false, '');
check('The new password works and the starter no longer does',
  (await login({ username: 'PAT', password: 'my-own-password' })).ok && (await login({ username: 'PAT', password: gen.starterPassword })).status === 401, '');
const reset = await j(await fetch(`${BASE}/api/admin/users/PAT`, { method: 'POST', headers: A, body: JSON.stringify({ password: '' }) }));
check('An admin reset generates a fresh starter and makes them choose again',
  /^[a-z]+-[A-Z2-9]{4}$/.test(reset.starterPassword || '') && reset.mustChange === true, reset.starterPassword);
check('A password an admin types is also a starter, not a permanent password',
  (await j(await fetch(`${BASE}/api/admin/users/PAT`, { method: 'POST', headers: A, body: JSON.stringify({ password: 'typed-by-an-admin' }) }))).mustChange === true, '');

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
await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); await page.waitForTimeout(1500);
check('Settings: signing in as an account shows who you are in the header',
  /Dana Whitfield/.test(clean(await page.textContent('#navWho'))) && /admin/.test(clean(await page.textContent('#navWho'))), clean(await page.textContent('#navWho')));

/* ---- the shell: a sidebar, and sub-tabs that show one thing at a time ---- */
check('Shell: the sidebar links all four pages, with this one marked',
  (await page.$$eval('#navTabs .tab', (a) => a.map((x) => x.getAttribute('href')))).join(',') === '/admin,/cycle,/teams,/settings'
    && (await page.$eval('#navTabs .tab.current', (a) => a.getAttribute('href'))) === '/settings');
check('Shell: Settings is split into sub-tabs',
  (await page.$$eval('#subTabs button', (b) => b.map((x) => x.textContent.replace(/\d+$/, '').trim()))).join(' | ') === 'Getting started | Logins | Scanners | Lists & racking | ERP & backups',
  (await page.$$eval('#subTabs button', (b) => b.map((x) => x.textContent.trim()))).join(' | '));
check('Shell: exactly one pane is on screen at a time',
  (await page.$$eval('[data-sub]', (p) => p.filter((x) => x.classList.contains('active')).length)) === 1);
await page.click('#subTabs button:text-is("Scanners")'); await page.waitForTimeout(500);
check('Shell: clicking a sub-tab swaps the pane and marks the tab',
  await page.$eval('[data-sub="scanners"]', (el) => el.classList.contains('active'))
    && !(await page.$eval('[data-sub="logins"]', (el) => el.classList.contains('active')))
    && await page.$eval('#subTabs button:text-is("Scanners")', (b) => b.classList.contains('current')));
check('Shell: the session bar hides on a pane that has no session to act on',
  await page.$eval('#scopeBar', (el) => el.hidden));
await page.click('#subTabs button:has-text("Lists")'); await page.waitForTimeout(500);
check('Shell: and comes back on one that does', !(await page.$eval('#scopeBar', (el) => el.hidden)));
check('Shell: the sub-tab is in the URL, so a link can point straight at one',
  (await page.evaluate(() => location.hash)) === '#lists', await page.evaluate(() => location.hash));
check('Shell: the open sub-tab survives a reload',
  await (async () => {
    const before = await page.evaluate(() => location.hash);
    await page.reload(); await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1200);
    return (await page.evaluate(() => location.hash)) === before && await page.$eval('[data-sub="lists"]', (el) => el.classList.contains('active'));
  })(), await page.evaluate(() => location.hash));
await page.click('#subTabs button:text-is("Logins")'); await page.waitForTimeout(600);

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

check('Settings: the accounts table lists everyone and flags who is still on a starter',
  (await page.$$('#userTable tbody tr')).length === 3 && /starter/.test(await page.textContent('#userTable')),
  clean(await page.textContent('#userTable')).slice(0, 140));
await page.fill('#fNewUser', 'RILEY'); await page.fill('#fNewFullName', 'Riley Chen');
await page.click('#btnAddUser'); await page.waitForTimeout(900);
const starter = clean(await page.textContent('#starterBox'));
const starterPw = (/([a-z]+-[A-Z2-9]{4})/.exec(starter) || [])[1];
check('Settings: adding a login with no password shows a starter to read out, once',
  !!starterPw && /RILEY can sign in now/.test(starter) && (await page.$$('#userTable tbody tr')).length === 4, starterPw || starter.slice(0, 90));
check('Settings: that starter actually signs them in', (await login({ username: 'RILEY', password: starterPw })).ok, '');
await page.click('#userTable tbody tr:has-text("RILEY") button:text-is("Reset password")'); await page.waitForTimeout(900);
check('Settings: an admin can reset somebody\'s password for them',
  (await login({ username: 'RILEY', password: 'reset-password-42' })).ok, '');
await page.screenshot({ path: `${S}screenshots/settings-accounts.png`, clip: await page.$eval('#userTable', (el) => { const r = el.closest('.card').getBoundingClientRect(); return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, 640) }; }) });

// first sign-in: a starter password gets you as far as choosing a real one, and no further
{
  const fresh = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'NEWBIE', name: 'Ash Kowalski' }) }));
  const np = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  np.on('pageerror', (e) => errors.push('newbie: ' + e.message));
  await np.goto(BASE + '/admin');
  await np.fill('#fUser', 'NEWBIE'); await np.fill('#fPassword', fresh.starterPassword); await np.click('#btnLogin');
  await np.waitForSelector('#navSetPassword.active', { timeout: 15000 });
  await np.waitForTimeout(600);
  check('First sign-in: they land on "Choose your password", not the dashboard',
    (await np.$eval('#scrMain', (el) => el.classList.contains('active'))) === false
      && /starter password/.test(await np.textContent('#npWho')),
    clean(await np.textContent('#npWho')).slice(0, 90));
  check('First sign-in: it does not ask for the password they just typed',
    await np.$eval('#npCurrentWrap', (el) => el.hidden));
  await np.screenshot({ path: `${S}screenshots/settings-first-sign-in.png`, clip: { x: 0, y: 0, width: 1100, height: 560 } });
  await np.fill('#npNext', 'short'); await np.fill('#npConfirm', 'short'); await np.click('#npSave'); await np.waitForTimeout(400);
  check('First sign-in: a short password is refused without a round trip', /8 characters/.test(await np.textContent('#npMsg')), clean(await np.textContent('#npMsg')));
  await np.fill('#npNext', 'apple-cart-9'); await np.fill('#npConfirm', 'apple-cart-8'); await np.click('#npSave'); await np.waitForTimeout(400);
  check('First sign-in: a mistyped confirmation is caught', /do not match/.test(await np.textContent('#npMsg')), clean(await np.textContent('#npMsg')));
  await np.fill('#npNext', 'apple-cart-9'); await np.fill('#npConfirm', 'apple-cart-9'); await np.click('#npSave');
  await np.waitForSelector('#scrMain.active', { timeout: 15000 }); await np.waitForTimeout(1200);
  check('First sign-in: with a real password set they go straight through to the dashboard',
    await np.$eval('#navSetPassword', (el) => el.hidden) && /Ash Kowalski/.test(await np.textContent('#navWho')),
    clean(await np.textContent('#navWho')));
  check('First sign-in: the password they chose is the one that works from now on',
    (await login({ username: 'NEWBIE', password: 'apple-cart-9' })).ok
      && (await login({ username: 'NEWBIE', password: fresh.starterPassword })).status === 401, '');
  // and a reload cannot walk past the step
  const fresh2 = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'NEWBIE2', name: 'Kim Alvarez' }) }));
  await np.evaluate(() => sessionStorage.removeItem('admToken'));
  const tok2 = (await j(await login({ username: 'NEWBIE2', password: fresh2.starterPassword }))).token;
  await np.evaluate((t) => sessionStorage.setItem('admToken', t), tok2);
  await np.goto(BASE + '/teams');
  await np.waitForSelector('#navSetPassword.active', { timeout: 15000 }); await np.waitForTimeout(500);
  check('First sign-in: reloading another tab does not skip it, and it asks for the starter there',
    !(await np.$eval('#npCurrentWrap', (el) => el.hidden)) && /Finish setting up/.test(await np.textContent('#npWho')),
    clean(await np.textContent('#npWho')).slice(0, 80));
  await np.close();
}

// a plain supervisor sees the page, but not the account controls.
// RILEY was just reset, so settle on a password of their own first — otherwise
// they land on "Choose your password", which is itself the point of the step.
const rileyTok = (await j(await login({ username: 'RILEY', password: 'reset-password-42' }))).token;
await fetch(`${BASE}/api/admin/me/password`, { method: 'POST', headers: bearer(rileyTok), body: JSON.stringify({ current: 'reset-password-42', next: 'riley-own-pass' }) });
const sup = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await sup.goto(BASE + '/settings');
await sup.fill('#fUser', 'RILEY'); await sup.fill('#fPassword', 'riley-own-pass'); await sup.click('#btnLogin');
await sup.waitForSelector('#scrMain.active'); await expandSubTabs(sup); await sup.waitForTimeout(1200);
check('Settings: a supervisor is told account management is an admin job, and keeps the rest',
  await sup.$eval('#adminOnly', (el) => el.hidden) && !(await sup.$eval('#notAdmin', (el) => el.hidden))
    && !(await sup.$eval('#ownPassword', (el) => el.hidden)) && (await sup.$$('#deviceTable tbody tr')).length >= 0,
  clean(await sup.textContent('#notAdmin')).slice(0, 80));
await sup.close();

/* ---- every supervisor page on a phone-width screen ---- */
{
  const narrow = await browser.newPage({ viewport: { width: 430, height: 940 } });
  narrow.on('pageerror', (e) => errors.push('narrow: ' + e.message));
  const bad = [];
  for (const path of ['/admin', '/cycle', '/teams', '/settings', '/board']) {
    await narrow.goto(BASE + path);
    if (path === '/board') {
      await narrow.waitForTimeout(1400);
    } else {
      // The sign-in carries across pages, so only the first one asks. Give the
      // page a moment to restore it first, or the click races that and both win.
      await narrow.waitForTimeout(900);
      if (await narrow.$('#scrLogin.active')) {
        await narrow.fill('#fUser', 'DANA'); await narrow.fill('#fPassword', 'freezer-2026'); await narrow.click('#btnLogin');
      }
      // 'attached', not visible: a page with nothing in it yet (no cycle session
      // here) is legitimately zero-height, and that is not what this checks.
      await narrow.waitForSelector('#scrMain.active', { state: 'attached', timeout: 15000 })
        .catch(() => bad.push(`${path} never reached the page`));
      await narrow.waitForTimeout(1200);
    }
    const over = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over) bad.push(`${path} +${over}px`);
  }
  check('Narrow: no page scrolls sideways at 430px — only the tables do, inside their own box',
    bad.length === 0, bad.join(', ') || 'all clean');
  await narrow.goto(BASE + '/admin');
  await narrow.waitForSelector('#scrMain.active'); await narrow.waitForTimeout(1500);
  check('Narrow: the sidebar becomes a top bar and the tabs stay reachable',
    (await narrow.$$('#navTabs .tab')).length === 4
      && await narrow.$eval('#navTabs .tab.current', (a) => a.getBoundingClientRect().top < 260),
    `tab top ${Math.round(await narrow.$eval('#navTabs .tab.current', (a) => a.getBoundingClientRect().top))}px`);
  await narrow.screenshot({ path: `${S}screenshots/settings-narrow.png` });
  await narrow.close();
}

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} settings checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
