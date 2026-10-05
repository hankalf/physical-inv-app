/*
 * Inviting someone by email.
 *
 * A login added with an email can be sent a link instead of a password: it
 * works once, for three days, and its owner chooses their own password on it.
 * No working password ever goes into an email. The admin sends it from their
 * own mail (a ready-made message) or copies the link; a new invite replaces
 * the old one; a password reset or switching the login off ends it.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = (username, password) => fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { ...hdr, 'x-forwarded-for': `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ username, password }) });
const tok = (await j(await login('DANA-WHITFIELD', 'changeme'))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = async (p, body = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) });
const tokenOf = (link) => new URL(link).searchParams.get('invite');

let r = await post('/api/admin/users', { username: 'NO-MAIL', name: 'No Mail', invite: true, profile: 'supervisor' });
check('An invite needs an email to go to', r.status === 400 && /email/.test((await j(r)).error));
r = await post('/api/admin/users', { username: 'BAD-MAIL', name: 'Bad Mail', email: 'not an address', invite: true, profile: 'supervisor' });
check('An email that does not look like one is refused', r.status === 400);

r = await post('/api/admin/users', { username: 'MARIA-L', name: 'Maria Lopez', email: 'maria@example.com', invite: true, profile: 'inventory' });
let u = await j(r);
check('Adding a login with an invite gives a one-time link to this site', r.status === 200 && u.invite && /\/admin\?invite=/.test(u.invite.link) && !u.starterPassword, u.invite && u.invite.link);
check('…valid for three days', Math.abs(Date.parse(u.invite.expiresAt) - Date.now() - 3 * 86400000) < 60000);
check('…and the login shows as invited, with its email', u.invited && u.email === 'maria@example.com' && !u.mustChange);
const first = tokenOf(u.invite.link);

let users = await j(await fetch(`${BASE}/api/admin/users`, { headers: A }));
check('The list of logins never carries the link itself', !JSON.stringify(users).includes(first));
check('Nobody can sign in as them before they choose a password', (await login('MARIA-L', '')).status === 401);

r = await fetch(`${BASE}/api/invite/${first}`);
let b = await j(r);
check('The link says who it is for and which site', r.status === 200 && b.username === 'MARIA-L' && b.name === 'Maria Lopez' && b.site === 'Full Harvest Inventory', JSON.stringify(b));
check('A made-up link does not work', (await fetch(`${BASE}/api/invite/${'x'.repeat(43)}`)).status === 410);

await post('/api/admin/users', { username: 'SUP-I', name: 'Sup I', password: 'dock-side-77', mustChange: false, profile: 'supervisor' });
const supTok = (await j(await login('SUP-I', 'dock-side-77'))).token;
check('A supervisor cannot send invites', (await post('/api/admin/users/MARIA-L/invite', {}, { ...hdr, authorization: 'Bearer ' + supTok })).status === 403);

r = await post('/api/admin/users/MARIA-L/invite');
const again = await j(r);
check('Invite again makes a new link…', r.status === 200 && again.link && tokenOf(again.link) !== first);
check('…and the old one stops working', (await fetch(`${BASE}/api/invite/${first}`)).status === 410);
const second = tokenOf(again.link);

r = await post('/api/invite/accept', { token: second, password: 'short' }, hdr);
check('A password under 8 characters is refused', r.status === 400);
r = await post('/api/invite/accept', { token: second, password: 'freezer-maria-26' }, hdr);
check('Choosing a password takes the invite up', r.status === 200 && (await j(r)).username === 'MARIA-L');
check('…and they can sign in with it', (await login('MARIA-L', 'freezer-maria-26')).status === 200);
check('…while the link is now used up', (await fetch(`${BASE}/api/invite/${second}`)).status === 410
  && (await post('/api/invite/accept', { token: second, password: 'another-one-99' }, hdr)).status === 410);
users = await j(await fetch(`${BASE}/api/admin/users`, { headers: A }));
check('…and the login is no longer shown as invited', !users.users.find((x) => x.username === 'MARIA-L').invited);

// a reset or a switched-off login ends a waiting invite
const third = tokenOf((await j(await post('/api/admin/users/MARIA-L/invite'))).link);
await post('/api/admin/users/MARIA-L', { password: 'reset-by-admin-1' });
check('Resetting the password ends a waiting invite', (await fetch(`${BASE}/api/invite/${third}`)).status === 410);
const fourth = tokenOf((await j(await post('/api/admin/users/MARIA-L/invite'))).link);
await post('/api/admin/users/MARIA-L', { active: false });
check('So does switching the login off', (await fetch(`${BASE}/api/invite/${fourth}`)).status === 410);
check('…and a switched-off login cannot be invited', (await post('/api/admin/users/MARIA-L/invite')).status === 409);

const log = await j(await fetch(`${BASE}/api/admin/audit?limit=100`, { headers: A }));
check('Invites and taking them up are in the activity log', log.some((a) => a.action === 'sent an invite') && log.some((a) => a.action === 'took up an invite and chose a password'));

/* ------------------------------------------------------------ the pages */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#advanced`);
await signIn(page, { user: 'DANA-WHITFIELD', password: 'changeme' });
await page.fill('#fNewUser', 'JOSE-R');
await page.fill('#fNewFullName', 'Jose Ramirez');
await page.fill('#fNewEmail', 'jose@example.com');
check('Typing an email ticks "invite" by itself', await page.$eval('#fNewInvite', (c) => c.checked));
await page.click('#btnAddUser');
await page.waitForSelector('#inviteBox[style*="block"]', { timeout: 5000 }).catch(() => {});
const link = await page.$eval('#inviteLink', (i) => i.value).catch(() => '');
const mailto = await page.getAttribute('#btnInviteMail', 'href').catch(() => '');
check('The page shows the link once, with a ready-made email', /\/admin\?invite=/.test(link) && /^mailto:jose%40example\.com\?subject=/.test(mailto) && decodeURIComponent(mailto).includes(link), mailto.slice(0, 80));
check('…the email saying the username and when the link runs out', /username is JOSE-R/.test(decodeURIComponent(mailto)) && /works once, until/.test(decodeURIComponent(mailto)));
await page.waitForTimeout(600);
const row = await page.evaluate(() => [...document.querySelectorAll('#userTable tr')].map((t) => t.textContent).find((t) => t.includes('JOSE-R')) || '');
check('The new login shows as invited, with its email and an Invite again button', /invited/.test(row) && /jose@example\.com/.test(row) && /Invite again/.test(row), row.replace(/\s+/g, ' ').slice(0, 160));

// Jose opens the link on his own computer
const jose = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await jose.goto(link);
await jose.waitForSelector('#fInvitePass', { timeout: 5000 }).catch(() => {});
const welcome = (await jose.textContent('#scrLogin')).replace(/\s+/g, ' ');
check('The link opens a welcome with the username, asking for a password', /Welcome to Full Harvest Inventory, Jose Ramirez/.test(welcome) && /JOSE-R/.test(welcome), welcome.slice(0, 160));
await jose.fill('#fInvitePass', 'cold-room-jose-1');
await jose.fill('#fInvitePass2', 'cold-room-jose-2');
await jose.click('#btnInviteGo');
await jose.waitForTimeout(300);
check('Two different passwords are caught', /not the same/.test(await jose.textContent('#inviteMsg')));
await jose.fill('#fInvitePass2', 'cold-room-jose-1');
await jose.click('#btnInviteGo');
await jose.waitForSelector('#scrMain.active', { timeout: 6000 }).catch(() => {});
check('Setting it signs them straight in', await jose.$eval('#scrMain', (e) => e.classList.contains('active')).catch(() => false) && !/invite=/.test(jose.url()), jose.url());
const used = await (await browser.newContext()).newPage();
await used.goto(link);
await used.waitForTimeout(1200);
check('The same link a second time says it has been used', /expired or has already been used/.test(await used.textContent('#scrLogin')));
check('No page errors', errors.length === 0, errors.join(' | '));
await browser.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
