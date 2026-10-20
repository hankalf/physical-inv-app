/*
 * Systems: LIVE and DEV, each its own deployment, reached from one sign-in and
 * one scanner link.
 *
 * The server run-all started is LIVE, the home. This suite starts a second one
 * as DEV - its own database, linked to LIVE by the link key - and walks the
 * hand-off: a login LIVE lets use DEV goes over and arrives signed in with the
 * same role; one it does not is refused; a ticket used twice, altered, out of
 * date or for another system is turned away; a scanner switches under its own
 * link and comes back; and DEV's counts stay in DEV.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const DEV_PORT = Number(process.env.SYSTEMS_DEV_PORT || 3986);
const DEV = `http://127.0.0.1:${DEV_PORT}`;
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (base, body) => j(await fetch(`${base}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }));
const H = (t) => ({ ...hdr, authorization: 'Bearer ' + t });
const post = (base, p, b = {}, h) => fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
const get = async (base, p, h) => j(await fetch(base + p, { headers: h }));

/* ---- LIVE, the home */
const A = H((await login(BASE, { password: 'changeme' })).token);
let pub = await get(BASE, '/api/system');
check('Out of the box this is LIVE, the home, with no other system', pub.self.name === 'LIVE' && pub.self.role === 'home' && pub.systems.length === 0, JSON.stringify(pub));
let st = await get(BASE, '/api/admin/systems', A);
check('The home makes a link key for the others', typeof st.key === 'string' && st.key.length >= 24);
const FIRST_KEY = st.key;              // what an admin sees the first time they open the card
check('…and it is the key it keeps: the card shows the same one next time', (await get(BASE, '/api/admin/systems', A)).key === FIRST_KEY);
let r = await post(BASE, '/api/admin/systems', { systems: [{ name: 'DEV', url: 'not a web address' }] }, A);
check('An address that is not one is refused, with an example', r.status === 400 && /railway\.app/.test((await j(r)).error));
r = await post(BASE, '/api/admin/systems', { systems: [{ name: 'LIVE', url: DEV }] }, A);
check('…and so is a second system with this one\'s own name', r.status === 400 && /twice/.test((await j(r)).error));
r = await post(BASE, '/api/admin/systems', { systems: [{ name: 'dev', url: DEV + '/', color: 'orange', scanners: false }] }, A);
st = await j(r);
check('DEV is added with its address', r.status === 200 && st.systems.length === 1 && st.systems[0].name === 'DEV' && st.systems[0].url === DEV, JSON.stringify(st.systems));
const KEY = FIRST_KEY;
check('Saving the systems does not change the key', st.key === FIRST_KEY);

/* two supervisors: one may use DEV, one may not */
await post(BASE, '/api/admin/users', { username: 'INV-CTRL', name: 'Inventory Control', password: 'count-week-1', mustChange: false, profile: 'inventory' }, A);
await post(BASE, '/api/admin/users', { username: 'FLOOR-SUP', name: 'Floor Sup', password: 'dock-side-77', mustChange: false, profile: 'floor' }, A);
r = await post(BASE, '/api/admin/systems/access', { username: 'INV-CTRL', systems: ['DEV'] }, A);
st = await j(r);
check('Who may use each system: Inventory Control is given DEV; admins have it already', st.access.find((u) => u.username === 'INV-CTRL').systems.join() === 'DEV' && st.access.find((u) => u.username === 'DANA-WHITFIELD').systems.join() === 'DEV' && st.access.find((u) => u.username === 'FLOOR-SUP').systems.length === 0);
const INV = H((await login(BASE, { username: 'INV-CTRL', password: 'count-week-1' })).token);
const FLR = H((await login(BASE, { username: 'FLOOR-SUP', password: 'dock-side-77' })).token);
check('/me says which system this is and where the login may go', (await get(BASE, '/api/admin/me', INV)).systems.map((s) => s.name).join() === 'DEV' && (await get(BASE, '/api/admin/me', FLR)).systems.length === 0 && (await get(BASE, '/api/admin/me', INV)).system.name === 'LIVE');
check('Only an admin sees the systems card', (await fetch(`${BASE}/api/admin/systems`, { headers: INV })).status === 403);

/* ---- DEV: the app again, its own database, linked to LIVE */
const dev = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', new URL('../src/server.js', import.meta.url).pathname], {
  env: { ...process.env, PORT: String(DEV_PORT), DB_PATH: join(mkdtempSync(join(tmpdir(), 'invdev-')), 'dev.db'), SUPERADMIN_USER: 'DEV-ADMIN', SUPERADMIN_NAME: 'Dev Admin', SUPERADMIN_PASSWORD: 'dev-only-pass',
    SYSTEM_NAME: 'DEV', SYSTEM_HOME_URL: BASE, SYSTEM_LINK_KEY: KEY, SITE_TIMEZONE: 'America/New_York' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopDev = () => { try { dev.kill(); } catch { /* gone */ } };
process.on('exit', stopDev);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${DEV}/api/health`)).ok) break; } catch { /* not up */ } await wait(200); }
pub = await get(DEV, '/api/system');
check('DEV knows it is DEV, linked to LIVE', pub.self.name === 'DEV' && pub.self.role === 'linked' && pub.home.url === BASE.replace(/\/$/, ''), JSON.stringify(pub));

/* ---- a login goes over */
r = await post(BASE, '/api/admin/systems/handoff', { to: 'DEV', path: '/admin#progress' }, FLR);
check('A login not given DEV cannot switch to it, and is told who can give it', r.status === 403 && /Settings → Site & systems → Systems/.test((await j(r)).error));
r = await post(BASE, '/api/admin/systems/handoff', { to: 'DEV', path: '/admin#progress' }, INV);
const ho = await j(r);
check('Inventory Control gets a hand-off to DEV\'s own address', r.status === 200 && ho.url.startsWith(`${DEV}/handoff?t=`), ho.url && ho.url.slice(0, 60));
let page = await fetch(ho.url);
let html = await page.text();
const devToken = (html.match(/setItem\('admToken', "([^"]+)"\)/) || [])[1];
check('DEV takes it: a sign-in, and on to the page asked for', page.status === 200 && !!devToken && /location\.replace\("\/admin#progress"\)/.test(html));
let me = await get(DEV, '/api/admin/me', H(devToken));
check('…the same login, the same role and pages, on DEV', me.username === 'INV-CTRL' && me.name === 'Inventory Control' && me.role === 'supervisor' && JSON.stringify(me.access) === JSON.stringify((await get(BASE, '/api/admin/me', INV)).access) && me.system.name === 'DEV', JSON.stringify([me.username, me.role, me.system]));
check('…with the way back to LIVE', me.systems.some((s) => s.name === 'LIVE' && s.home && s.url === BASE.replace(/\/$/, '')));
page = await fetch(ho.url);
check('A hand-off used twice is turned away', page.status === 403 && /used already/.test(await page.text()));
const forge = (body, key = KEY) => { const p = Buffer.from(JSON.stringify(body)).toString('base64url'); return `${DEV}/handoff?t=${p}.${createHmac('sha256', key).update(p).digest('base64url')}`; };
const ticket = (extra) => ({ v: 1, iss: 'LIVE', aud: 'DEV', exp: Date.now() + 60000, n: Math.random().toString(36).slice(2), kind: 'user', path: '/admin', home: { name: 'LIVE' }, systems: [], user: { username: 'MALLORY', name: 'Mallory', role: 'admin', access: null }, ...extra });
page = await fetch(forge(ticket(), 'not-the-real-key-at-all-not-at-all'));
check('A hand-off signed with any other key is turned away', page.status === 403 && /link key/.test(await page.text()));
page = await fetch(forge(ticket({ exp: Date.now() - 1000 })));
check('…and one out of date', page.status === 403 && /ran out/.test(await page.text()));
page = await fetch(forge(ticket({ aud: 'TRAINING' })));
check('…and one for another system', page.status === 403 && /for TRAINING/.test(await page.text()));
const [p0, s0] = new URL(ho.url).searchParams.get('t').split('.');
const bent = JSON.parse(Buffer.from(p0, 'base64url').toString()); bent.user.role = 'admin'; bent.n = 'x' + bent.n;
page = await fetch(`${DEV}/handoff?t=${Buffer.from(JSON.stringify(bent)).toString('base64url')}.${s0}`);
check('…and one altered on the way (a supervisor made admin)', page.status === 403);
r = await post(DEV, '/api/admin/systems/handoff', { to: 'LIVE', path: '/full' }, H(devToken));
check('From DEV the way back is just LIVE\'s own address: DEV signs nobody in to LIVE', r.status === 200 && (await j(r)).url === `${BASE.replace(/\/$/, '')}/full`);
const devLogins = await get(DEV, '/api/admin/users', H((await login(DEV, { username: 'DEV-ADMIN', password: 'dev-only-pass' })).token));
const arrived = devLogins.users.find((u) => u.username === 'INV-CTRL');
check('On DEV the login has no password of its own: it only ever arrives from LIVE', arrived && (await login(DEV, { username: 'INV-CTRL', password: 'count-week-1' })).error && !(await login(DEV, { username: 'INV-CTRL', password: 'count-week-1' })).token);

/* ---- DEV's data is DEV's */
const devSess = await j(await post(DEV, '/api/admin/sessions', { name: 'DEV rehearsal' }, H((await login(DEV, { username: 'DEV-ADMIN', password: 'dev-only-pass' })).token)));
check('A count made on DEV is not on LIVE', devSess.id && !(await get(BASE, '/api/admin/sessions', A)).some((s) => s.name === 'DEV rehearsal'));

/* ---- a scanner goes over, and comes back */
const gunDev = await j(await post(BASE, '/api/admin/devices', { name: 'MC93-07' }, A));
const T = { ...hdr, authorization: 'Device ' + (await j(await post(BASE, `/api/devices/${gunDev.uid}`, {}, hdr))).token };
let sys = await get(BASE, '/api/systems', T);
check('Until the office allows it, the gun is offered no other system', sys.systems.length === 0 && sys.self.name === 'LIVE');
r = await post(BASE, '/api/systems/handoff', { to: 'DEV' }, T);
check('…and a switch is refused, saying who can allow it', r.status === 403 && /may not switch to DEV/.test((await j(r)).error));
await post(BASE, '/api/admin/systems', { systems: [{ name: 'DEV', url: DEV, color: 'orange', scanners: true }] }, A);
sys = await get(BASE, '/api/systems', T);
check('Allowed: the gun is offered DEV', sys.systems.map((s) => s.name).join() === 'DEV');
r = await post(BASE, '/api/systems/handoff', { to: 'DEV' }, T);
const gho = await j(r);
page = await fetch(gho.url, { redirect: 'manual' });
check('The hand-off makes the scanner on DEV under its own link, and opens the gun there', page.status === 302 && page.headers.get('location') === `/?d=${gunDev.uid}`, `${page.status} ${page.headers.get('location')}`);
const dt = await j(await post(DEV, `/api/devices/${gunDev.uid}`, {}, hdr));
check('…where the link signs it in, as itself', dt.name === 'MC93-07' && !!dt.token);
const TD = { ...hdr, authorization: 'Device ' + dt.token };
sys = await get(DEV, '/api/systems', TD);
check('On DEV the gun is offered the way back to LIVE', sys.self.name === 'DEV' && sys.systems.some((s) => s.name === 'LIVE' && s.home));
r = await post(DEV, '/api/systems/handoff', { to: 'LIVE' }, TD);
check('…which is LIVE\'s own address, where its link still holds', r.status === 200 && (await j(r)).url === `${BASE.replace(/\/$/, '')}/`);

/* ---- Check the link: LIVE asks the other system, server to server */
let ck = await j(await post(BASE, '/api/admin/systems/check', { name: 'DEV' }, A));
check('Check the link: DEV answers, is linked to this LIVE, is called DEV, and takes a hand-off', ck.ok && ck.steps.length >= 4 && ck.steps.every((x) => x.ok), JSON.stringify(ck.steps.map((x) => x.text)));
check('…and checking used nothing up: the probe is not a sign-in', (await get(DEV, '/api/admin/users', H((await login(DEV, { username: 'DEV-ADMIN', password: 'dev-only-pass' })).token))).users.length === devLogins.users.length);
await post(BASE, '/api/admin/systems', { systems: [{ name: 'DEV', url: DEV, color: 'orange', scanners: true }, { name: 'GHOST', url: 'http://127.0.0.1:1' }, { name: 'SELF', url: BASE.includes('127.0.0.1') ? BASE.replace('127.0.0.1', 'localhost') : BASE.replace('localhost', '127.0.0.1') }, { name: 'STAGE', url: DEV }] }, A);   // LIVE again, by another name for it: a system with no home set
ck = await j(await post(BASE, '/api/admin/systems/check', { name: 'GHOST' }, A));
check('An address nothing answers on says so, and what to check', !ck.ok && /could not be reached/.test(ck.steps[0].text) && /running in Railway/.test(ck.steps[0].fix), JSON.stringify(ck.steps[0]));
ck = await j(await post(BASE, '/api/admin/systems/check', { name: 'SELF' }, A));
check('A system that thinks it is the home is told to set SYSTEM_HOME_URL - to this address', !ck.ok && ck.steps.some((x) => !x.ok && /thinks it is a home/.test(x.text) && /SYSTEM_HOME_URL/.test(x.fix) && x.fix.includes(BASE.replace(/\/$/, ''))), JSON.stringify(ck.steps));
ck = await j(await post(BASE, '/api/admin/systems/check', { name: 'STAGE' }, A));
check('Listed under another name than it calls itself: both ways to fix it are named', !ck.ok && ck.steps.some((x) => !x.ok && /calls itself DEV, but it is listed here as STAGE/.test(x.text) && /SYSTEM_NAME=STAGE/.test(x.fix)), JSON.stringify(ck.steps.filter((x) => !x.ok)));
await post(BASE, '/api/admin/systems', { systems: [{ name: 'DEV', url: DEV, color: 'orange', scanners: true }] }, A);

/* ---- in the browser: the office */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];
const tab = await ctx.newPage(); tab.on('pageerror', (e) => errors.push(e.message));
await tab.goto(`${BASE}/admin`);
await tab.waitForSelector('#fSignInSystem', { timeout: 8000 }).catch(() => {});
check('LIVE\'s sign-in box offers "Sign in to" LIVE or DEV', (await tab.$$eval('#fSignInSystem option', (o) => o.map((x) => x.textContent))).join('|') === 'LIVE (this one)|DEV');
await tab.fill('#fUser', 'INV-CTRL'); await tab.fill('#fPassword', 'count-week-1');
await tab.selectOption('#fSignInSystem', 'DEV');
await tab.click('#btnLogin');
await tab.waitForURL(`${DEV}/**`, { timeout: 10000 }).catch(() => {});
await tab.waitForSelector('#scrMain.active', { timeout: 10000 }).catch(() => {});
check('Signing in "to DEV" lands on DEV\'s dashboard, signed in', tab.url().startsWith(`${DEV}/admin`) && await tab.isVisible('#scrMain'), tab.url());
check('…with the DEV banner across the page and the way back', /DEV — not the live system/.test(clean(await tab.textContent('#systemBanner').catch(() => ''))) && /Back to LIVE/.test(clean(await tab.textContent('#systemBanner').catch(() => ''))));
check('…and DEV in the sidebar', /DEV/.test(clean(await tab.textContent('#navSystem').catch(() => ''))));
await tab.click('#systemBanner button');
await tab.waitForURL(`${BASE.replace(/\/$/, '')}/**`, { timeout: 10000 }).catch(() => {});
await tab.waitForSelector('#scrMain.active', { timeout: 10000 }).catch(() => {});
check('Back to LIVE: LIVE, still signed in, no banner', tab.url().startsWith(BASE) && await tab.isVisible('#scrMain') && !(await tab.$('#systemBanner')), tab.url());
await tab.selectOption('#navSystemPick', 'DEV');
await tab.waitForURL(`${DEV}/**`, { timeout: 10000 }).catch(() => {});
await tab.waitForSelector('#systemBanner', { timeout: 10000 }).catch(() => {});
check('Switch to… DEV from the sidebar goes over again, to the same page', tab.url().startsWith(`${DEV}/admin`) && await tab.isVisible('#systemBanner'), tab.url());

/* ---- in the browser: the gun */
const gctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
const gun = await gctx.newPage(); gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
await gun.goto(`${BASE}/?d=${gunDev.uid}`); await gun.waitForTimeout(2000);
check('The gun on LIVE says LIVE, and offers DEV on the sign-on screen', /LIVE/.test(await gun.textContent('#chipSystem')) && await gun.isVisible('#systemBlock') && /DEV/.test(await gun.textContent('#systemPick')));
await gun.click('#systemPick button[data-system="DEV"]');
await gun.waitForURL(`${DEV}/**`, { timeout: 10000 }).catch(() => {});
await gun.waitForTimeout(2500);
check('One tap: the same gun is on DEV, under its own name, saying DEV', gun.url().startsWith(DEV) && /DEV/.test(await gun.textContent('#chipSystem')) && /MC93-07/.test(await gun.textContent('#chipDevice')), gun.url());
await gun.click('#systemPick button[data-system="LIVE"]');
await gun.waitForURL(`${BASE.replace(/\/$/, '')}/**`, { timeout: 10000 }).catch(() => {});
await gun.waitForTimeout(2500);
check('Back to LIVE: LIVE again, still signed in as itself', gun.url().startsWith(BASE) && /LIVE/.test(await gun.textContent('#chipSystem')) && /MC93-07/.test(await gun.textContent('#chipDevice')), gun.url());
check('No script errors', errors.length === 0, errors.join(' | '));
/* ---- which system the scanners use: both, LIVE alone, or DEV alone - the admin chooses on LIVE */
{
  // the browser gun above signed the link in again, on both: fresh tokens for these calls
  const T = { ...hdr, authorization: 'Device ' + (await j(await post(BASE, `/api/devices/${gunDev.uid}`, {}, hdr))).token };
  const TD = { ...hdr, authorization: 'Device ' + (await j(await post(DEV, `/api/devices/${gunDev.uid}`, {}, hdr))).token };
  let st0 = await get(BASE, '/api/admin/systems', A);
  check('On the scanners: DEV ticked the old way reads as both', st0.scanners === 'all', st0.scanners);
  r = await post(BASE, '/api/admin/systems', { systems: [{ name: 'DEV', url: DEV, color: 'orange' }], scanners: 'DEV' }, A);
  st0 = await j(r);
  check('An admin puts the scanners on DEV alone', r.status === 200 && st0.scanners === 'DEV', JSON.stringify(st0.scanners));
  check('…and the log says so', (await get(BASE, '/api/admin/audit?limit=10', A)).some((x) => x.action === 'chose which system the scanners use' && /DEV only/.test(x.detail)));
  check('…and LIVE says it to anyone who asks, for DEV to read', (await get(BASE, '/api/system')).scanners === 'DEV');
  sys = await get(BASE, '/api/systems', T);
  check('DEV alone: a gun on LIVE is sent to DEV, and offered nothing else', sys.goTo === 'DEV' && sys.scanners === 'DEV' && sys.systems.map((s) => s.name).join() === 'DEV', JSON.stringify(sys));
  sys = await get(DEV, '/api/systems', TD);
  check('…a gun on DEV stays there: no way back to LIVE', !sys.goTo && sys.systems.length === 0 && sys.scanners === 'DEV', JSON.stringify(sys));
  r = await post(BASE, '/api/admin/systems', { scanners: 'home' }, A);
  check('LIVE alone', r.status === 200 && (await j(r)).scanners === 'home');
  sys = await get(BASE, '/api/systems', T);
  check('…a gun on LIVE is offered no other system', !sys.goTo && sys.systems.length === 0 && sys.scanners === 'LIVE', JSON.stringify(sys));
  r = await post(BASE, '/api/systems/handoff', { to: 'DEV' }, T);
  check('…and a switch to DEV is refused', r.status === 403);
  sys = await get(DEV, '/api/systems', TD);
  check('…a gun still on DEV is sent back to LIVE', sys.goTo === 'LIVE' && sys.systems.map((s) => s.name).join() === 'LIVE', JSON.stringify(sys));
  check('…and DEV\'s Systems card shows what LIVE chose', (await get(DEV, '/api/admin/systems', H((await login(DEV, { username: 'DEV-ADMIN', password: 'dev-only-pass' })).token))).scanners === 'LIVE');
  r = await post(BASE, '/api/admin/systems', { scanners: 'NOPE' }, A);
  check('A system that is not on the list is refused', r.status === 400 && /no system called NOPE/.test((await j(r)).error));

  /* the gun, on its own */
  await post(BASE, '/api/admin/systems', { scanners: 'DEV' }, A);
  await gun.goto(`${BASE}/?d=${gunDev.uid}`);
  await gun.waitForURL(`${DEV}/**`, { timeout: 12000 }).catch(() => {});
  await gun.waitForTimeout(2500);
  check('DEV alone: the gun opened on LIVE goes to DEV by itself', gun.url().startsWith(DEV) && /DEV/.test(await gun.textContent('#chipSystem')) && /MC93-07/.test(await gun.textContent('#chipDevice')), gun.url());
  check('…where it signs on as usual, with no System row to leave by', await gun.isHidden('#systemBlock') && await gun.isVisible('#btnStart') && await gun.isHidden('#sysGoTo'));
  await post(BASE, '/api/admin/systems', { scanners: 'home' }, A);
  await gun.reload();
  await gun.waitForURL(`${BASE.replace(/\/$/, '')}/**`, { timeout: 12000 }).catch(() => {});
  await gun.waitForTimeout(2500);
  check('LIVE alone: the gun on DEV comes back to LIVE by itself', gun.url().startsWith(BASE) && /LIVE/.test(await gun.textContent('#chipSystem')), gun.url());
  check('…and is offered no System row there', await gun.isHidden('#systemBlock') && await gun.isVisible('#btnStart'));

  /* the Settings card */
  const sp = await ctx.newPage();
  sp.on('pageerror', (e) => errors.push('scan pick: ' + e.message));
  await sp.goto(`${BASE}/settings#advanced`);
  await signIn(sp);
  await sp.evaluate(() => window.appApi && window.appApi.showSub && window.appApi.showSub('advanced')).catch(() => {});
  await sp.waitForSelector('#sysScanPick input[type=radio]', { timeout: 8000 }).catch(() => {});
  const opts = clean(await sp.textContent('#sysScanPick').catch(() => ''));
  check('Settings → Systems → On the scanners: both, LIVE only, DEV only — LIVE only chosen', /LIVE and DEV/.test(opts) && /LIVE only/.test(opts) && /DEV only/.test(opts) && await sp.isChecked('#sysScanPick input[value="home"]'), opts);
  await sp.check('#sysScanPick input[value="all"]');
  await sp.click('#btnSysSave');
  await sp.waitForTimeout(900);
  check('…choosing both and saving puts the System row back on the guns', (await get(BASE, '/api/admin/systems', A)).scanners === 'all' && (await get(BASE, '/api/systems', { ...hdr, authorization: 'Device ' + (await j(await post(BASE, `/api/devices/${gunDev.uid}`, {}, hdr))).token })).systems.map((s) => s.name).join() === 'DEV');
  await sp.close();
}
/* ---- Copy logins from DEV: the ones made there before it was linked, brought to LIVE with their passwords */
{
  const DA = H((await login(DEV, { username: 'DEV-ADMIN', password: 'dev-only-pass' })).token);
  await post(DEV, '/api/admin/users', { username: 'TEST-ONLY', name: 'Tess Only', password: 'only-on-test-9', mustChange: false, profile: 'floor', email: 'tess@example.com' }, DA);
  await post(DEV, '/api/admin/users', { username: 'FLOOR-SUP', name: 'Floor Sup on DEV', password: 'another-pass-8', mustChange: false }, DA);
  await post(DEV, '/api/admin/users', { username: 'NOT-YET', name: 'Not Yet', email: 'notyet@example.com', invite: true }, DA);
  let pv = await j(await post(BASE, '/api/admin/systems/logins', { name: 'DEV' }, A));
  const st = (u) => (pv.logins.find((x) => x.username === u) || {}).status || 'absent';
  check('Copy logins from DEV: the list says what would happen to each', st('TEST-ONLY') === 'new' && st('FLOOR-SUP') === 'here' && st('NOT-YET') === 'invite' && st('DEV-ADMIN') === 'new',
    pv.logins.map((x) => `${x.username}:${x.status}`).join(', '));
  check('…the logins that came from LIVE are not DEV\'s to give back', st('INV-CTRL') === 'absent');
  check('…DEV\'s own superadmin is marked as such', (pv.logins.find((x) => x.username === 'DEV-ADMIN') || {}).startup === true);
  check('…and nothing has been copied by looking', !(await get(BASE, '/api/admin/users', A)).users.some((u) => u.username === 'TEST-ONLY'));
  r = await post(BASE, '/api/admin/systems/logins', { name: 'DEV', copy: true, usernames: ['TEST-ONLY', 'FLOOR-SUP', 'NOT-YET'] }, A);
  const out = await j(r);
  check('Copying: the new one is copied, the others skipped and said why', r.status === 200 && out.copied.join() === 'TEST-ONLY' && out.skipped.map((x) => x.username).sort().join() === 'FLOOR-SUP,NOT-YET', JSON.stringify(out));
  const tess = (await get(BASE, '/api/admin/users', A)).users.find((u) => u.username === 'TEST-ONLY');
  check('…with its name, email and role', tess && tess.name === 'Tess Only' && tess.email === 'tess@example.com' && tess.profile === 'floor', JSON.stringify(tess));
  const tl = await login(BASE, { username: 'TEST-ONLY', password: 'only-on-test-9' });
  check('…and it signs in on LIVE with the password it has on DEV', !!tl.token, JSON.stringify(tl).slice(0, 120));
  check('…and may still switch to DEV', ((await get(BASE, '/api/admin/systems', A)).access.find((u) => u.username === 'TEST-ONLY') || {}).systems?.join() === 'DEV');
  check('FLOOR-SUP on LIVE is left exactly as it was', !!(await login(BASE, { username: 'FLOOR-SUP', password: 'dock-side-77' })).token);
  check('The log says what was copied', (await get(BASE, '/api/admin/audit?limit=10', A)).some((x) => x.action === 'copied logins from DEV' && /TEST-ONLY/.test(x.detail)));
  r = await post(DEV, '/api/system/logins', { t: 'made.up' });
  check('DEV hands its logins to nobody but LIVE', r.status === 403 && !(await j(r)).logins);
  r = await fetch(`${BASE}/api/admin/systems/logins`, { method: 'POST', headers: INV, body: JSON.stringify({ name: 'DEV' }) });
  check('…and on LIVE only an admin may ask', r.status === 403);
  /* on the page */
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push('copy: ' + e.message));
  pg.on('dialog', (d) => d.accept());
  await pg.goto(`${BASE}/settings#advanced`);
  await signIn(pg);
  await pg.waitForSelector('#copyLoginsBtns button[data-copy-from="DEV"]');
  await pg.click('#copyLoginsBtns button[data-copy-from="DEV"]');
  await pg.waitForSelector('#copyLoginsTable tbody tr[data-user]');
  check('Supervisor logins: Copy logins from DEV shows the list first', (await pg.locator('#copyLoginsTable tr[data-user="TEST-ONLY"]').textContent()).includes('already a login here')
    && (await pg.locator('#copyLoginsTable tr[data-user="DEV-ADMIN"] input').isChecked()) === false && !(await pg.locator('#copyLoginsTable tr[data-user="DEV-ADMIN"] input').isDisabled()));
  await pg.close();
}

/* ---- DEV's scanners are LIVE's: nothing is registered, reset or printed on DEV */
{
  const DA = H((await login(DEV, { username: 'DEV-ADMIN', password: 'dev-only-pass' })).token);
  r = await post(DEV, '/api/admin/devices', { name: 'MADE-ON-DEV' }, DA);
  const why = (await j(r)).error || '';
  check('DEV refuses to register a scanner, and says where to', r.status === 409 && /registered on LIVE/.test(why), why);
  const devs = await get(DEV, '/api/admin/devices', DA);
  check('…its scanner list says the home is LIVE, and still has the gun that came over', devs.home && devs.home.name === 'LIVE' && devs.devices.some((d) => d.name === 'MC93-07'));
  const came = devs.devices.find((d) => d.name === 'MC93-07');
  r = await post(DEV, `/api/admin/devices/${came.uid}/reset`, {}, DA);
  check('…and will not give a gun a new link there', r.status === 409);
  const ready = await get(DEV, '/api/admin/readiness', DA);
  const sc = (ready.checks || []).find((c) => /scanner/.test(c.title) && /LIVE/.test(c.title));
  check('…Ready for count day on DEV counts the guns that came from LIVE, not ones to register', sc && sc.level !== 'fail', JSON.stringify(sc));
  r = await post(DEV, '/api/admin/practice', {}, DA);
  check('…while the Testing Suite\'s own practice gun still works on DEV', r.status === 200 && !!(await j(r)).device, String(r.status));
  check('LIVE still registers scanners as before', (await post(BASE, '/api/admin/devices', { name: 'MC93-12' }, A)).status === 200);
  const dp = await ctx.newPage();
  dp.on('pageerror', (e) => errors.push('dev scanners: ' + e.message));
  await dp.goto(`${DEV}/settings#gun`);
  await dp.fill('#fUser', 'DEV-ADMIN'); await dp.fill('#fPassword', 'dev-only-pass'); await dp.click('#btnLogin');
  await dp.waitForSelector('#devLinkedNote', { timeout: 8000 }).catch(() => {});
  check('DEV\'s Scanner setup: no Add scanner, no setup cards, a note pointing to LIVE', !(await dp.isVisible('#btnAddDevice')) && !(await dp.isVisible('#btnCards'))
    && /registered on LIVE/.test(await dp.textContent('#devLinkedNote').catch(() => '')) && (await dp.getAttribute('#devLinkedNote a', 'href').catch(() => '')).startsWith(BASE.replace(/\/$/, '')));
  check('…and no Reset link or Copy on the gun that came over', (await dp.locator('#deviceTable tbody tr', { hasText: 'MC93-07' }).locator('button', { hasText: /Reset link|Copy/ }).count()) === 0);
  await dp.close();
}

/* a new key here, and DEV still holding the old one: the check says which key to copy where */
await post(BASE, '/api/admin/systems', { newKey: true }, A);
ck = await j(await post(BASE, '/api/admin/systems/check', { name: 'DEV' }, A));
check('After a new key here, Check the link says DEV refuses it, and to copy the key into SYSTEM_LINK_KEY', !ck.ok && ck.steps.some((x) => !x.ok && /link key/.test(x.text) && /SYSTEM_LINK_KEY/.test(x.fix)), JSON.stringify(ck.steps.filter((x) => !x.ok)));

/* ---- the logins table: which systems each login may switch to, ticked where the login is */
{
  const pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push('logins: ' + e.message));
  pg.on('dialog', (d) => d.accept());
  await pg.goto(`${BASE}/settings#advanced`);
  await signIn(pg);
  await pg.waitForSelector('#userTable td.syscell');
  const heads = await pg.$$eval('#userTable thead th', (t) => t.map((x) => x.textContent.trim()));
  const ticks = async (user) => pg.$$eval('#userTable tbody tr', (rows, u) => {
    const tr = rows.find((r) => r.firstChild && r.firstChild.textContent.trim() === u);
    return tr ? [...tr.querySelectorAll('td.syscell input')].map((b) => `${b.parentElement.textContent.trim()}:${b.checked ? 'on' : 'off'}${b.disabled ? '(fixed)' : ''}`).join(',') : 'no row';
  }, user);
  check('Supervisor logins has a Systems column', heads.includes('Systems'), heads.join('|'));
  check('…LIVE always, DEV as ticked: Inventory Control has DEV, the floor supervisor not', (await ticks('INV-CTRL')) === 'LIVE:on(fixed),DEV:on' && (await ticks('FLOOR-SUP')) === 'LIVE:on(fixed),DEV:off', `${await ticks('INV-CTRL')} / ${await ticks('FLOOR-SUP')}`);
  check('…an admin has every system, fixed', /DEV:on\(fixed\)/.test(await ticks('DANA-WHITFIELD')), await ticks('DANA-WHITFIELD'));
  await pg.locator('#userTable tbody tr', { hasText: 'FLOOR-SUP' }).locator('input[data-user-system="DEV"]').check();
  await pg.waitForTimeout(600);
  const acc = (await get(BASE, '/api/admin/systems', A)).access;
  check('Ticking DEV for a login gives it DEV', acc.find((u) => u.username === 'FLOOR-SUP').systems.join() === 'DEV');
  check('…and the Systems card\'s own table follows', await pg.isChecked('#sysAccess tr[data-user="FLOOR-SUP"] input[data-system="DEV"]'));
  await pg.fill('#fNewUser', 'NEW-SUP'); await pg.fill('#fNewFullName', 'New Sup');
  check('Add login offers "may also switch to DEV"', await pg.isVisible('#fNewSystems input[data-system="DEV"]'));
  await pg.check('#fNewSystems input[data-system="DEV"]');
  await pg.click('#btnAddUser');
  await pg.waitForTimeout(900);
  check('…and a login made with it ticked may use DEV from the start', ((await get(BASE, '/api/admin/systems', A)).access.find((u) => u.username === 'NEW-SUP') || {}).systems?.join() === 'DEV');
  await pg.close();
}

/* ---- a TEST whose way home is its own address: said, not a click that does nothing */
r = await post(BASE, '/api/admin/systems', { systems: [{ name: 'DEV', url: DEV, color: 'orange' }, { name: 'SELF', url: BASE }] }, A);
check('LIVE refuses a system listed with LIVE\'s own address', r.status === 400 && /own address/.test((await j(r)).error));
{
  const BAD_PORT = DEV_PORT + 7;
  const BAD = `http://127.0.0.1:${BAD_PORT}`;
  const bad = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', new URL('../src/server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(BAD_PORT), DB_PATH: join(mkdtempSync(join(tmpdir(), 'invbad-')), 'bad.db'), SUPERADMIN_USER: 'BAD-ADMIN', SUPERADMIN_PASSWORD: 'bad-only-pass',
      SYSTEM_NAME: 'TEST', SYSTEM_HOME_URL: BAD, SYSTEM_LINK_KEY: KEY, SITE_TIMEZONE: 'America/New_York' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BAD}/api/health`)).ok) break; } catch { /* not up */ } await wait(200); }
  const BH = H((await login(BAD, { username: 'BAD-ADMIN', password: 'bad-only-pass' })).token);
  r = await post(BAD, '/api/admin/systems/handoff', { to: 'LIVE', path: '/admin' }, BH);
  const err = (await j(r)).error || '';
  check('Back to LIVE on a TEST whose SYSTEM_HOME_URL is its own address says so, and how to fix it', r.status === 409 && /own address/.test(err) && /SYSTEM_HOME_URL/.test(err), err);
  const card = await get(BAD, '/api/admin/systems', BH);
  check('…and its Systems card knows', card.homeIsSelf === true);
  const bp = await ctx.newPage();
  const said = [];
  bp.on('dialog', (d) => { said.push(d.message()); d.dismiss(); });
  await bp.goto(`${BAD}/settings#advanced`);
  await bp.fill('#fUser', 'BAD-ADMIN'); await bp.fill('#fPassword', 'bad-only-pass'); await bp.click('#btnLogin');
  await bp.waitForSelector('#systemBanner button', { timeout: 8000 }).catch(() => {});
  await bp.click('#systemBanner button').catch(() => {});
  await bp.waitForTimeout(800);
  check('…the button says what is wrong instead of doing nothing', said.some((x) => /own address/.test(x)), said.join(' | '));
  await bp.evaluate(() => window.appApi.showSub('advanced')).catch(() => {});
  await bp.waitForTimeout(800);
  check('…and so does the Systems card', /own address/.test(clean(await bp.textContent('#sysStatus').catch(() => ''))), clean(await bp.textContent('#sysStatus').catch(() => '')));
  await bp.close();
  try { bad.kill(); } catch { /* gone */ }
}
check('No script errors on the logins table', errors.length === 0, errors.join(' | '));

await browser.close();
stopDev();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
