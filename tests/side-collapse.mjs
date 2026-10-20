/*
 * The side panel put away for room: « hides it and the page takes the width;
 * the mouse on the left edge slides it out over the page and off it slides it
 * back; » pins it open again. Kept in this browser. A narrow screen keeps its
 * bar along the top.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/admin`);
await signIn(page);
await page.waitForTimeout(600);
const box = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; });
const mainBefore = await box('.shell');
check('The panel has a « button to put it away', await page.isVisible('#navCollapse') && (await page.textContent('#navCollapse')).trim() === '«');
await page.click('#navCollapse');
await page.waitForTimeout(400);
let side = await box('aside.side');
const mainAfter = await box('.shell');
check('« hides the panel, off the left edge', await page.evaluate(() => document.documentElement.classList.contains('side-collapsed')) && side.right <= 0, JSON.stringify(side));
check('…and the page takes its width', mainAfter.left === 0 && mainAfter.width > mainBefore.width + 150, `${mainBefore.width} → ${mainAfter.width}`);
check('…with a thin strip on the left edge to bring it back', await page.isVisible('#sidePeek') && (await box('#sidePeek')).width <= 14);
await page.hover('#sidePeek');
await page.waitForTimeout(400);
side = await box('aside.side');
check('The mouse on the strip slides the panel out, over the page', side.left === 0 && side.width > 150 && (await box('.shell')).left === 0, JSON.stringify(side));
check('…with its pages there to click', await page.isVisible('#navTabs a.tab[href="/full"]'));
await page.hover('aside.side #navTabs');
await page.waitForTimeout(400);
check('…and it stays out while the mouse is on it', (await box('aside.side')).left === 0);
await page.mouse.move(900, 450);
await page.waitForTimeout(700);
check('Off the panel, it slides back', (await box('aside.side')).right <= 0);
await page.reload();
await page.waitForSelector('#scrMain.active');
await page.waitForTimeout(500);
check('Put away, it stays put away after a reload, and on another page', (await box('aside.side')).right <= 0 && await page.evaluate(() => document.documentElement.classList.contains('side-collapsed')));
await page.goto(`${BASE}/settings`);
await page.waitForSelector('#scrMain.active');
await page.waitForTimeout(400);
check('…the same on Settings', (await box('aside.side')).right <= 0);
await page.hover('#sidePeek'); await page.waitForTimeout(400);
check('» on the slid-out panel pins it open again', (await page.textContent('#navCollapse')).trim() === '»');
await page.click('#navCollapse');
await page.mouse.move(900, 450);
await page.waitForTimeout(700);
side = await box('aside.side');
check('…open for good, the page beside it as before', side.left === 0 && !(await page.evaluate(() => document.documentElement.classList.contains('side-collapsed'))) && (await box('.shell')).left >= side.width - 2, JSON.stringify(side));

/* a narrow screen keeps its bar along the top, whatever a desk chose */
await page.click('#navCollapse');                      // put away again on the desk
const narrow = await browser.newContext({ viewport: { width: 800, height: 900 }, storageState: await ctx.storageState() });
const np = await narrow.newPage();
np.on('pageerror', (e) => errors.push('narrow: ' + e.message));
await np.goto(`${BASE}/admin`);
await signIn(np);
await np.waitForTimeout(500);
const nb = await np.$eval('aside.side', (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), width: Math.round(r.width) }; });
check('At 800 wide the panel is the bar along the top, no « and no strip', nb.top === 0 && nb.width >= 790 && await np.isHidden('#navCollapse') && await np.isHidden('#sidePeek'), JSON.stringify(nb));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
