/*
 * The office side on a phone.
 *
 * "Add to Home Screen" makes it an app of its own: a manifest that opens on
 * the sign-in, in a window without the browser's bars, named after the site.
 * On a phone-sized screen the side panel folds into a bar with a Menu button,
 * so the page starts on the first screen rather than under a wall of tabs.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

/* ------------------------------------------------------------ the manifest */
let man = await j(await fetch(`${BASE}/office.webmanifest`));
check('The office app opens on the sign-in, in its own window', man.start_url === '/admin' && man.display === 'standalone' && man.id === '/admin', JSON.stringify([man.start_url, man.display, man.id]));
check('…named after the site, with a short name for under the icon', man.name === 'Full Harvest Inventory Office' && man.short_name === 'FH Office', `${man.name} / ${man.short_name}`);
check('…with icons a phone can use, a maskable one included', man.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable') && man.icons.some((i) => i.sizes === '192x192'));
const gunMan = await j(await fetch(`${BASE}/manifest.webmanifest`));
check('The scanner app is a different app: its own id and start', gunMan.id !== man.id && gunMan.start_url !== man.start_url);

const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'DANA-WHITFIELD', password: 'changeme' }) }))).token;
await fetch(`${BASE}/api/admin/site-name`, { method: 'POST', headers: { ...hdr, authorization: 'Bearer ' + tok }, body: JSON.stringify({ name: 'North Ridge Cold Storage', place: 'Winchester' }) });
man = await j(await fetch(`${BASE}/office.webmanifest`));
check('Renaming the site renames the installed office app', man.name === 'North Ridge Cold Storage Office' && man.short_name === 'NRC Office', `${man.name} / ${man.short_name}`);
await fetch(`${BASE}/api/admin/site-name`, { method: 'POST', headers: { ...hdr, authorization: 'Bearer ' + tok }, body: JSON.stringify({ name: '', place: '' }) });

const missingOn = [];
for (const page of ['/admin', '/full', '/cycle', '/front', '/missing', '/teams', '/settings', '/testing', '/guide']) {
  const html = await (await fetch(BASE + page)).text();
  if (!/rel="manifest" href="\/office\.webmanifest"/.test(html) || !/apple-touch-icon/.test(html) || !/apple-mobile-web-app-capable/.test(html)) missingOn.push(page);
}
check('Every office page links the office app, with the iPhone tags too', missingOn.length === 0, missingOn.join(' '));
const gunHtml = await (await fetch(`${BASE}/?d=x`)).text();
check('The scanner page keeps its own manifest', /href="\/manifest\.webmanifest"/.test(gunHtml) && !/office\.webmanifest/.test(gunHtml));

/* ------------------------------------------------------------ a phone-sized screen */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
phone.on('pageerror', (e) => errors.push(e.message));
await phone.goto(`${BASE}/admin`);
await phone.fill('#fUser', 'DANA-WHITFIELD');
await phone.fill('#fPassword', 'changeme');
await phone.click('#btnLogin');
await phone.waitForSelector('#scrMain.active');
await phone.waitForTimeout(600);
check('On a phone the side panel is a bar with a Menu button', await phone.isVisible('#navMenuBtn') && /Dashboard/.test(await phone.textContent('#navMenuBtn')));
check('…and the tabs, search and sign-out are folded away', await phone.isHidden('#navTabs') && await phone.isHidden('#navSearch') && await phone.isHidden('#navLogout'));
const h1Top = await phone.$eval('.topbar h1', (e) => e.getBoundingClientRect().top);
check('…so the page starts on the first screen', h1Top < 140, `heading at ${Math.round(h1Top)}px`);
check('Nothing is wider than the phone', await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await phone.click('#navMenuBtn');
await phone.waitForTimeout(200);
check('Menu opens the pages, the search box and the sign-out', await phone.isVisible('#navTabs') && await phone.isVisible('#navSearch') && await phone.isVisible('#navLogout'));
check('…and says it is open', (await phone.getAttribute('#navMenuBtn', 'aria-expanded')) === 'true');
await phone.click('.topbar h1', { force: true }).catch(() => {});
await phone.mouse.click(200, 800);
await phone.waitForTimeout(200);
check('A tap back on the page puts it away', await phone.isHidden('#navTabs'));
await phone.click('#navMenuBtn');
await phone.click('#navTabs a.tab[href="/settings"]');
await phone.waitForURL(/\/settings/);
await phone.waitForTimeout(600);
check('Picking a page goes there, with the menu folded and named for it', await phone.isHidden('#navTabs') && /Settings/.test(await phone.textContent('#navMenuBtn')));
check('Nothing is wider than the phone on Settings either', await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

/* ------------------------------------------------------------ a desk */
const desk = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await desk.goto(`${BASE}/admin`);
await signIn(desk, { user: 'DANA-WHITFIELD', password: 'changeme' });
check('On a desk the side panel is as it was: no Menu button, the tabs showing', await desk.isHidden('#navMenuBtn') && await desk.isVisible('#navTabs'));
check('No page errors', errors.length === 0, errors.join(' | '));
await browser.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
