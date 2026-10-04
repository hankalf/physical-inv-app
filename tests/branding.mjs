/*
 * The site's name and place.
 *
 * "Full Harvest Inventory · Front Royal" out of the box, and an admin can
 * rename both under Settings → Advanced. The change has to land everywhere
 * at once: the sidebar on every supervisor page, the sign-in splash, the
 * window title, the scanner app's header, the office board and the installed
 * app's manifest - and an empty name goes back to the default.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const login = async (body) => (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) })).json()).token;
const tok = await login({ username: 'DANA-WHITFIELD', password: 'changeme' });
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = async (p, body = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) });
const j = (r) => r.json();

/* ------------------------------------------------------------ the API */
let b = await j(await fetch(`${BASE}/api/branding`));
check('Out of the box the site is Full Harvest Inventory, Front Royal', b.name === 'Full Harvest Inventory' && b.place === 'Front Royal', JSON.stringify(b));
let man = await j(await fetch(`${BASE}/manifest.webmanifest`));
check('…and the installed app is named after it', man.name === 'Full Harvest Inventory' && man.short_name === 'Full Harvest', JSON.stringify([man.name, man.short_name]));

const html = await (await fetch(`${BASE}/admin`)).text();
check('Nothing on the pages still says Ripe & Ready', !/Ripe/.test(html) && !/Ripe/.test(await (await fetch(`${BASE}/`)).text()) && !/Ripe/.test(await (await fetch(`${BASE}/i18n.js`)).text()));

let r = await post('/api/admin/site-name', { name: '  Full  Harvest   Cold Storage ', place: 'Winchester, VA' });
b = await j(r);
check('An admin renames the site and the place; spaces are tidied', r.status === 200 && b.name === 'Full Harvest Cold Storage' && b.place === 'Winchester, VA', JSON.stringify(b));
b = await j(await fetch(`${BASE}/api/branding`));
check('…and the open branding answer carries it, for the guns and the board', b.name === 'Full Harvest Cold Storage' && b.place === 'Winchester, VA');
man = await j(await fetch(`${BASE}/manifest.webmanifest`));
check('…and so does the manifest', man.name === 'Full Harvest Cold Storage' && man.short_name.length <= 12, JSON.stringify([man.name, man.short_name]));

// a supervisor who is not an admin may not
await post('/api/admin/users', { username: 'NAME-SUP', name: 'Name Sup', password: 'dock-side-77', mustChange: false, profile: 'supervisor' });
const supTok = await login({ username: 'NAME-SUP', password: 'dock-side-77' });
r = await post('/api/admin/site-name', { name: 'Nope' }, { ...hdr, authorization: 'Bearer ' + supTok });
check('A supervisor login cannot rename it', r.status === 403, String(r.status));
check('…and the name stands', (await j(await fetch(`${BASE}/api/branding`))).name === 'Full Harvest Cold Storage');

/* ------------------------------------------------------------ the pages */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${BASE}/admin`);
await page.waitForSelector('#scrLogin .splashbrand .name');
await page.waitForTimeout(600);
check('The sign-in splash carries the new name and place', await page.$eval('#scrLogin .splashbrand .name', (n) => n.textContent === 'Full Harvest Cold StorageWinchester, VA' && n.querySelector('span').textContent === 'Winchester, VA'), await page.$eval('#scrLogin .splashbrand .name', (n) => n.textContent));
await signIn(page, { user: 'DANA-WHITFIELD' });
check('The sidebar brand on the dashboard reads the new name over the place', await page.$eval('.side .brand', (n) => n.childNodes[0].textContent === 'Full Harvest Cold Storage' && n.querySelector('span').textContent === 'Winchester, VA'), await page.$eval('.side .brand', (n) => n.textContent));
check('…and the window title starts with it', /^Full Harvest Cold Storage — Dashboard$/.test(await page.title()), await page.title());
for (const path of ['/cycle', '/teams', '/front', '/missing', '/testing', '/guide']) {
  await page.goto(BASE + path);
  await page.waitForSelector('#scrMain.active', { state: 'attached' });
  await page.waitForTimeout(500);
  const brand = await page.$eval('.side .brand', (n) => n.childNodes[0].textContent + '|' + (n.querySelector('span') || {}).textContent);
  check(`${path}: the sidebar carries it too`, brand === 'Full Harvest Cold Storage|Winchester, VA' && (await page.title()).startsWith('Full Harvest Cold Storage — '), brand + ' / ' + await page.title());
}

/* Settings → Advanced: the card, and a change made from it */
await page.goto(`${BASE}/settings#advanced`);
await page.waitForSelector('#scrMain.active', { state: 'attached' });
await page.waitForTimeout(1200);
check('Settings → Advanced shows the current name and place in the card', await page.$eval('#fSiteName', (i) => i.value) === 'Full Harvest Cold Storage' && await page.$eval('#fSitePlace', (i) => i.value) === 'Winchester, VA');
await page.fill('#fSiteName', 'Full Harvest Inventory');
await page.fill('#fSitePlace', 'Front Royal');
await page.click('#btnSiteNameSave');
await page.waitForTimeout(900);
check('Saving from the card changes the sidebar at once, no reload', await page.$eval('.side .brand', (n) => n.childNodes[0].textContent === 'Full Harvest Inventory' && n.querySelector('span').textContent === 'Front Royal') && /^Full Harvest Inventory — Settings$/.test(await page.title()), await page.title());
check('…with a word of confirmation', /now “Full Harvest Inventory” · Front Royal/.test(await page.textContent('#siteNameMsg')), await page.textContent('#siteNameMsg'));
await page.fill('#fSitePlace', '');
await page.click('#btnSiteNameSave');
await page.waitForTimeout(700);
check('A blank place means no second line', await page.$eval('.side .brand', (n) => !n.querySelector('span')) && (await j(await fetch(`${BASE}/api/branding`))).place === '');
await page.fill('#fSiteName', '');
await page.fill('#fSitePlace', 'Front Royal');
await page.click('#btnSiteNameSave');
await page.waitForTimeout(700);
check('A blank name goes back to the default', (await j(await fetch(`${BASE}/api/branding`))).name === 'Full Harvest Inventory' && await page.$eval('#fSiteName', (i) => i.value) === 'Full Harvest Inventory');

/* the gun and the board */
await post('/api/admin/site-name', { name: 'Full Harvest Cold Storage', place: 'Winchester, VA' });
const gun = await browser.newPage({ viewport: { width: 480, height: 800 } });
await gun.goto(`${BASE}/`);
await gun.waitForTimeout(1500);
check('The scanner app’s header shows the short name', await gun.$eval('#hdrTitle', (n) => n.textContent) === 'Full Harvest Cold Storage' && await gun.title() === 'Full Harvest Cold Storage', await gun.$eval('#hdrTitle', (n) => n.textContent));
const board = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await board.goto(`${BASE}/board`);
await board.waitForTimeout(1800);
check('The office board names the site under its heading', /Full Harvest Cold Storage · Winchester, VA/.test(await board.textContent('#bSite')), await board.textContent('#bSite'));

await post('/api/admin/site-name', { name: '', place: 'Front Royal' });   // leave it as found
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
