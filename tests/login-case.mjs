/*
 * A login signs in whatever its capitals: HANK.ALFRED, hank.alfred and
 * Hank.Alfred are one account. The password does mind capitals, and the
 * sign-in says so: in its message when the two do not match, and under the
 * password box while Caps Lock is on.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const made = await j(await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'Hank.Alfred', name: 'Hank Alfred', password: 'Wednesday-2026', mustChange: false, profile: 'admin' }) }));
check('A login made as Hank.Alfred is kept as HANK.ALFRED', made.username === 'HANK.ALFRED', JSON.stringify(made).slice(0, 80));
const login = async (username, password) => fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username, password }) });
check('…and signs in as hank.alfred, HANK.ALFRED, Hank.Alfred, or with spaces round it', (await Promise.all(['hank.alfred', 'HANK.ALFRED', 'Hank.Alfred', ' hank.alfred '].map((u) => login(u, 'Wednesday-2026')))).every((r) => r.status === 200));
const wrong = await login('hank.alfred', 'wednesday-2026');
check('The password does mind capitals, and the refusal says which minds what', wrong.status === 401 && /capitals do not matter in the username, but they do in the password/.test((await j(wrong)).error));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings`);
await page.fill('#fUser', 'hank.alfred');
await page.focus('#fPassword');
await page.evaluate(() => document.getElementById('fPassword').dispatchEvent(new KeyboardEvent('keydown', { key: 'W', modifierCapsLock: true, bubbles: true })));
check('Caps Lock on while typing the password: a line under the box says so', await page.isVisible('#capsHint') && /Caps Lock is on/.test(clean(await page.textContent('#capsHint'))));
await page.evaluate(() => document.getElementById('fPassword').dispatchEvent(new KeyboardEvent('keyup', { key: 'W', modifierCapsLock: false, bubbles: true })));
check('…and goes when it is off', !(await page.$('#capsHint')));
await page.fill('#fPassword', 'Wednesday-2026'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active', { timeout: 8000 });
check('Signed in on the page with the lowercase username', /Hank Alfred/.test(clean(await page.textContent('body'))));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
