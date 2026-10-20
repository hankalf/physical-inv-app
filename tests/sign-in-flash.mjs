/*
 * Moving between the office pages while signed in: the sign-in box never
 * shows, not even for the moment it takes the page to check the sign-in.
 * Signed out, or with a sign-in that has gone stale, it shows as before.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
/* every frame, from the first one: was the sign-in box on screen? */
await ctx.addInitScript(() => {
  window.__loginSeen = 0;
  const look = () => {
    const el = document.getElementById('scrLogin');
    if (el && el.offsetParent !== null && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0) window.__loginSeen++;
    if (!window.__stopLook) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// a slow network: the sign-in check takes a while, which is when the box used to show
await page.route('**/api/admin/me', async (route) => { await new Promise((r) => setTimeout(r, 700)); await route.continue(); });

await page.goto(`${BASE}/admin`);
await page.waitForSelector('#scrLogin.active');
check('Signed out, the sign-in box shows', (await page.evaluate(() => window.__loginSeen)) > 0);
await page.fill('#fPassword', 'changeme');
await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active');

for (const path of ['/settings', '/teams', '/full', '/cycle', '/guide', '/admin']) {
  await page.goto(BASE + path);
  await page.waitForSelector('#scrMain.active, main .card', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(900);
  const seen = await page.evaluate(() => window.__loginSeen);
  const inPage = await page.evaluate(() => !document.documentElement.classList.contains('resuming'));
  check(`Signed in, opening ${path} never shows the sign-in box`, seen === 0 && inPage, `seen in ${seen} frames`);
}

/* a sign-in that has gone stale: the box comes back */
await page.evaluate(() => sessionStorage.setItem('admToken', 'not-a-real-token'));
await page.goto(`${BASE}/settings`);
await page.waitForSelector('#scrLogin.active', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(400);
check('A stale sign-in: the sign-in box shows once the check says so', (await page.isVisible('#fPassword')) && !(await page.evaluate(() => document.documentElement.classList.contains('signed-in'))));
check('No page errors', !errors.length, errors.join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
