/*
 * Wrong passwords at the supervisor sign-in.
 *
 * Five wrong for one login from one address locks that login, from that
 * address, for fifteen minutes - the right password included. Another address
 * is not locked (so a guesser outside cannot shut the office out). Twenty
 * wrong from one address, whatever the logins, locks the address. An admin
 * sees the lock under Settings → Advanced → Logins and can lift it; resetting
 * the login's password lifts it too.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const from = (ip) => ({ ...hdr, 'x-forwarded-for': ip });
const tryLogin = (username, password, ip = '10.0.0.5') => fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: from(ip), body: JSON.stringify({ username, password }) });

const tok = (await j(await tryLogin('DANA-WHITFIELD', 'changeme', '10.9.9.9'))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = async (p, body = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) });
await post('/api/admin/users', { username: 'LOCK-ME', name: 'Lock Me', password: 'cold-room-42', mustChange: false, profile: 'supervisor' });

/* ------------------------------------------------------------ one login */
const codes = [];
for (let i = 0; i < 5; i++) codes.push((await tryLogin('lock-me', 'not-it')).status);
check('Five wrong passwords are each turned away as a mismatch', codes.every((c) => c === 401), codes.join(','));
let r = await tryLogin('LOCK-ME', 'cold-room-42');
let b = await j(r);
check('…and then even the right one is refused: the login is locked from here', r.status === 429 && b.code === 'locked', `${r.status} ${b.error}`);
check('…with how long to wait, in words and in a Retry-After header', /try again in 15 minutes/.test(b.error) && Number(r.headers.get('retry-after')) > 800, `${b.error} / ${r.headers.get('retry-after')}`);
r = await tryLogin('LOCK-ME', 'cold-room-42', '10.0.0.77');
check('The same login from another address still signs in', r.status === 200, String(r.status));
r = await tryLogin('LOCK-ME', 'not-it', '10.0.0.77');
check('…and a wrong one from there is an ordinary mismatch, not a lock', r.status === 401);

const audit = await j(await fetch(`${BASE}/api/admin/audit`, { headers: A }));
const rows = Array.isArray(audit) ? audit : audit.rows;
check('The lock is in the activity log', JSON.stringify(rows).includes('locked a login for 15 minutes'));

/* ------------------------------------------------------------ the admin sees it and lifts it */
let users = await j(await fetch(`${BASE}/api/admin/users`, { headers: A }));
const lk = (users.locks || []).find((l) => l.username === 'LOCK-ME');
check('An admin sees the lock, the address and the minutes left', lk && lk.ip === '10.0.0.5' && lk.minutes >= 14, JSON.stringify(users.locks));

// a supervisor may not lift locks
const supTok = (await j(await tryLogin('LOCK-ME', 'cold-room-42', '10.0.0.77'))).token;
r = await post('/api/admin/login-locks/unlock', { username: 'LOCK-ME' }, { ...hdr, authorization: 'Bearer ' + supTok });
check('A supervisor cannot lift a lock', r.status === 403, String(r.status));

r = await post('/api/admin/login-locks/unlock', { username: 'lock-me' });
b = await j(r);
check('An admin lifts it', r.status === 200 && b.unlocked === 1 && !b.locks.some((l) => l.username === 'LOCK-ME'), JSON.stringify(b));
r = await tryLogin('LOCK-ME', 'cold-room-42');
check('…and the login signs in from that address again', r.status === 200, String(r.status));

// a password reset lifts it as well
for (let i = 0; i < 5; i++) await tryLogin('LOCK-ME', 'nope');
check('Locked again after five more', (await tryLogin('LOCK-ME', 'cold-room-42')).status === 429);
await post('/api/admin/users/LOCK-ME', { password: 'brand-new-pass-1', mustChange: false });
r = await tryLogin('LOCK-ME', 'brand-new-pass-1');
check('Resetting the password lifts the lock', r.status === 200, String(r.status));

// a right password clears the count, so slips spread over a shift do not add up
for (let i = 0; i < 4; i++) await tryLogin('LOCK-ME', 'nope', '10.0.0.8');
await tryLogin('LOCK-ME', 'brand-new-pass-1', '10.0.0.8');
for (let i = 0; i < 4; i++) await tryLogin('LOCK-ME', 'nope', '10.0.0.8');
check('A good sign-in in between starts the count again', (await tryLogin('LOCK-ME', 'brand-new-pass-1', '10.0.0.8')).status === 200);

// the site admin's lock is the site admin's to lift
await post('/api/admin/users', { username: 'OTHER-ADMIN', name: 'Other Admin', password: 'other-admin-9', mustChange: false, profile: 'admin' });
const otherTok = (await j(await tryLogin('OTHER-ADMIN', 'other-admin-9', '10.9.9.9'))).token;
r = await post('/api/admin/login-locks/unlock', { username: 'DANA-WHITFIELD' }, { ...hdr, authorization: 'Bearer ' + otherTok });
check("Another admin cannot touch the site admin's lock", r.status === 403, String(r.status));

/* ------------------------------------------------------------ one address, many logins */
for (let i = 0; i < 20; i++) await tryLogin(`GUESS-${i % 7}`, 'x', '10.0.0.66');
r = await tryLogin('LOCK-ME', 'brand-new-pass-1', '10.0.0.66');
check('Twenty wrong from one address, across logins, locks the address', r.status === 429, String(r.status));
users = await j(await fetch(`${BASE}/api/admin/users`, { headers: A }));
check('…shown to an admin as a locked address', (users.locks || []).some((l) => !l.username && l.ip === '10.0.0.66'));
await post('/api/admin/login-locks/unlock', { ip: '10.0.0.66' });
check('…and lifted by address', (await tryLogin('LOCK-ME', 'brand-new-pass-1', '10.0.0.66')).status === 200);

/* ------------------------------------------------------------ the pages */
for (let i = 0; i < 5; i++) await tryLogin('LOCK-ME', 'nope', '127.0.0.1');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.goto(`${BASE}/admin`);
await page.fill('#fUser', 'LOCK-ME');
await page.fill('#fPassword', 'brand-new-pass-1');
await page.click('#btnLogin');
await page.waitForTimeout(500);
const said = (await page.textContent('#loginMsg')).replace(/\s+/g, ' ');
check('The sign-in page says the login is locked and for how long', /too many wrong passwords/i.test(said) && /minute/.test(said), said);

const adm = await browser.newPage();
await adm.goto(`${BASE}/settings`);
await signIn(adm, { user: 'DANA-WHITFIELD', password: 'changeme' });
await adm.waitForTimeout(800);
const rowText = await adm.evaluate(() => [...document.querySelectorAll('#userTable tr')].map((tr) => tr.textContent).find((t) => t.includes('LOCK-ME')) || '');
check('Settings → Logins shows the login as locked, with an Unlock button', /locked/.test(rowText) && /Unlock/.test(rowText), rowText.replace(/\s+/g, ' ').slice(0, 160));
await adm.evaluate(() => [...document.querySelectorAll('#userTable tr')].find((tr) => tr.textContent.includes('LOCK-ME')).querySelector('button').click());
await adm.waitForTimeout(800);
const after = await adm.evaluate(() => [...document.querySelectorAll('#userTable tr')].map((tr) => tr.textContent).find((t) => t.includes('LOCK-ME')) || '');
check('…and Unlock clears it', !/locked/.test(after), after.replace(/\s+/g, ' ').slice(0, 160));
await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active', { timeout: 5000 }).catch(() => {});
check('…so the person can sign in', await page.$eval('#scrMain', (e) => e.classList.contains('active')).catch(() => false));
await browser.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
