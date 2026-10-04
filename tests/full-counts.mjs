/*
 * The Full Counts page.
 *
 * Every wall-to-wall on the site in one place - open and closed, how far each
 * got, which one the scanners land on - a new count started from it, and a
 * set-up list for the one in the picker. And the picker itself only shows a
 * login the kinds of count it may work.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }))).token;
const tok = await login({ username: 'DANA-WHITFIELD', password: 'changeme' });
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(j);

const q3 = await post('/api/admin/sessions', { name: 'Q3 physical' });
const cyc = await post('/api/admin/sessions', { name: 'Cycle 2026', mode: 'cycle' });
await fetch(`${BASE}/api/admin/sessions/${q3.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location\nF01A001\nF01A002\n' });
await post(`/api/admin/sessions/${q3.id}/status`, { status: 'closed' });
const q4 = await post('/api/admin/sessions', { name: 'Q4 physical' });
await post('/api/admin/default-session', { sessionId: q4.id });

/* ---------------- the picker shows what the login may work ---------------- */
await post('/api/admin/users', { username: 'INV-CTRL', name: 'Inventory Ctrl', password: 'dock-side-77', mustChange: false, profile: 'inventory' });
await post('/api/admin/users', { username: 'CYC-ONLY', name: 'Cycle Only', password: 'dock-side-77', mustChange: false, profile: 'cycle' });
const inv = { ...hdr, authorization: 'Bearer ' + await login({ username: 'INV-CTRL', password: 'dock-side-77' }) };
const cyo = { ...hdr, authorization: 'Bearer ' + await login({ username: 'CYC-ONLY', password: 'dock-side-77' }) };
const invList = await j(await fetch(`${BASE}/api/admin/sessions`, { headers: inv }));
const cyoList = await j(await fetch(`${BASE}/api/admin/sessions`, { headers: cyo }));
const admList = await j(await fetch(`${BASE}/api/admin/sessions`, { headers: A }));
check('An inventory-control login, with no Cycle counts page, sees no cycle count in its picker', invList.some((s) => s.id === q4.id) && !invList.some((s) => s.mode === 'cycle'), invList.map((s) => s.name).join(' | '));
check('A cycle-counter login sees only cycle counts', cyoList.length >= 1 && cyoList.every((s) => s.mode === 'cycle') && !cyoList.some((s) => s.id === q4.id), cyoList.map((s) => s.name).join(' | '));
check('The admin sees both kinds', admList.some((s) => s.id === q4.id) && admList.some((s) => s.id === cyc.id));

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/full`);
await signIn(page, { user: 'DANA-WHITFIELD' });
await page.waitForSelector('#fcTable tbody tr');
check('Full Counts sits in the sidebar between Dashboard and Cycle counts', (await page.$$eval('#navTabs .tab', (a) => a.map((x) => x.getAttribute('href')))).slice(0, 3).join(',') === '/admin,/full,/cycle');
const rows = await page.$$eval('#fcTable tbody tr', (trs) => trs.map((t) => t.textContent));
check('It lists the full counts only, open and closed, newest first', rows.length === 2 && /Q4 physical/.test(rows[0]) && /Q3 physical/.test(rows[1]) && !rows.join(' ').includes('Cycle 2026'), rows.map((r) => r.slice(0, 50)).join(' | '));
check('…the closed one marked closed, the default one marked as where scanners land', /closed/.test(rows[1]) && /scanners land here/.test(rows[0]));
check('…the picker up top holds the full counts only', !(await page.$$eval('#sessionPick .sess-row', (rs) => rs.map((r) => r.textContent))).join(' ').includes('Cycle 2026'));

/* a new count from here */
await page.fill('#fNewName', 'Q1 2027 physical'); await page.click('#btnCreate'); await page.waitForTimeout(800);
check('A new full count is created from the page', /Created “Q1 2027 physical”/.test(await page.textContent('#newMsg')) && (await page.$$('#fcTable tbody tr')).length === 3);
const setup = await page.$$eval('#setupList .setupstep', (els) => els.map((e) => e.className + ' | ' + e.querySelector('.t').textContent));
check('…and the Set-up tab lists what it still needs, the bin list required first', setup.length >= 4 && /required/.test(setup[0]) && /bin list/i.test(setup[0]) && !/done/.test(setup[0]), setup.slice(0, 2).join(' || '));

/* close and reopen from the list */
await page.locator('#fcTable tr', { hasText: 'Q1 2027 physical' }).locator('button:has-text("Close")').click();
await page.waitForTimeout(800);
check('Close ends a count from the list', /closed/.test(await page.locator('#fcTable tr', { hasText: 'Q1 2027 physical' }).textContent()));
await page.locator('#fcTable tr', { hasText: 'Q1 2027 physical' }).locator('button:has-text("Reopen")').click();
await page.waitForTimeout(800);
check('…and Reopen brings it back', !/closed/.test(await page.locator('#fcTable tr', { hasText: 'Q1 2027 physical' }).textContent()));
await page.locator('#fcTable tr', { hasText: 'Q3 physical' }).locator('button:has-text("Open on the dashboard")').click();
await page.waitForTimeout(1200);
check('Open on the dashboard goes to the dashboard with that count in the picker', /\/admin/.test(page.url()) && /Q3 physical/.test(await page.textContent('#sessionPick .sess-btn')), page.url() + ' ' + clean(await page.textContent('#sessionPick .sess-btn')));

/* a supervisor who is not an admin reads the page but cannot close or create */
await page.evaluate(() => window.appApi.logout());
await page.waitForTimeout(600);
await page.goto(`${BASE}/full`);
await page.fill('#fUser', 'INV-CTRL'); await page.fill('#fPassword', 'dock-side-77'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active', { state: 'attached' }); await page.waitForTimeout(1500);
check('An inventory-control login opens Full Counts and reads the list', (await page.$$('#fcTable tbody tr')).length === 3);
check('…without Close or Scanners land here, and Create is off', (await page.$$('#fcTable button:has-text("Close")')).length === 0 && (await page.$$('#fcTable button:has-text("Scanners land here")')).length === 0 && await page.$eval('#btnCreate', (b) => b.disabled));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
