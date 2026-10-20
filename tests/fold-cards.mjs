/*
 * Folding cards: the cards a site sets once and then leaves show their heading
 * alone until they are wanted. A click on the heading opens one, this computer
 * remembers it, and a card someone is sent to opens itself.
 *
 * Automated browsers see every card open (the other suites rely on that), so
 * this one switches folding on with the fold:test flag.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
async function open(path, { fold = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  if (fold) await ctx.addInitScript(() => { try { localStorage.setItem('fold:test', '1'); } catch { /* */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + path);
  await page.fill('#fPassword', 'changeme');
  await page.click('#btnLogin');
  await page.waitForSelector('#scrMain.active');
  await page.waitForTimeout(700);
  return page;
}
const folded = (page, id) => page.$eval('#' + id, (el) => el.classList.contains('folded'));
const shown = (page, sel) => page.$eval(sel, (el) => !!(el.offsetWidth || el.offsetHeight));

let page = await open('/settings#gun');
check('Settings → Scanners: the set-once cards start folded', (await folded(page, 'layoutCard')) && (await folded(page, 'idleCard')) && (await folded(page, 'bookCard')));
check('…the ones used every count do not', !(await folded(page, 'devicesCard').catch(() => false)) && (await page.$eval('#devicesCard', (el) => !el.hasAttribute('data-fold'))));
check('…a folded card still shows its heading, with what it is', (await shown(page, '#idleCard > h2')) && /amber bar/.test(await page.textContent('#idleCard > h2')));
check('…and hides the rest', !(await shown(page, '#fIdleMinutes')));
check('What the scanners offer: Jobs open, the four lists fold as sections', (await shown(page, '#fJobFull')) && (await folded(page, 'offComments')) && (await folded(page, 'offOverride')) && (await folded(page, 'offSos')) && (await folded(page, 'offIssues')));
check('…with the SOS chip still on its heading', await shown(page, '#offSos > h3'));
check('…and the Save for all of them still showing', await shown(page, '#btnSaveOffers'));

await page.click('#idleCard > h2');
check('A click on the heading opens the card', !(await folded(page, 'idleCard')) && (await shown(page, '#fIdleMinutes')));
check('…the caret says so', (await page.getAttribute('#idleCard .foldbtn', 'aria-expanded')) === 'true');
await page.click('#offSos .foldbtn');
check('The caret opens a section', !(await folded(page, 'offSos')) && (await shown(page, '#fNewSos')));
await page.click('#idleCard > h2');
check('…and a second click folds the card again', await folded(page, 'idleCard'));
await page.click('#idleCard > h2');

await page.reload();
await page.waitForSelector('#scrMain.active');
await page.waitForTimeout(700);
check('This computer remembers what was opened', !(await folded(page, 'idleCard')) && !(await folded(page, 'offSos')) && (await folded(page, 'bookCard')));

/* a button in a heading does its own job */
await page.evaluate(() => window.appApi.showSub('backups'));
await page.waitForTimeout(300);
check('Backups: OneDrive folded, Google Drive open', (await folded(page, 'onedriveCard')) && !(await page.$eval('#gdriveCard', (el) => el.classList.contains('folded'))));

/* the search takes you into a folded card and opens it */
await page.evaluate(() => window.appApi.showSub('gun'));
check('(the test book is folded again)', await folded(page, 'bookCard'));
await page.fill('#navSearch', 'barcode test book');
await page.waitForSelector('#navResults .hit');
await page.locator('#navResults .hit').filter({ hasText: 'Barcode test book' }).first().click();
await page.waitForTimeout(600);
check('A search hit for a folded card opens it', !(await folded(page, 'bookCard')));

/* anything that sends someone to an element inside a folded card opens it */
await page.click('#bookCard > h2');
check('(folded again)', await folded(page, 'bookCard'));
await page.evaluate(() => window.appApi.unfold(document.querySelector('#bookCard > :not(h2)')));
check('api.unfold opens whatever holds an element', !(await folded(page, 'bookCard')));

/* the other pages */
page = await open('/settings#advanced');
check('Site & systems: site name, logo, look, what is switched on and Systems fold', (await folded(page, 'siteNameCard')) && (await folded(page, 'logoCard')) && (await folded(page, 'lookCard')) && (await folded(page, 'featuresCard')) && (await folded(page, 'systemsCard')));
page = await open('/settings#logins');
check('Logins: its own tab, open, not folded', await shown(page, '#loginsCard h2') && await shown(page, '#fNewUser') && !(await page.$eval('#loginsCard', (el) => el.classList.contains('folded'))));
page = await open('/admin#reports');
check('Reports: Filed as the count goes, Find a lot and Count sheets fold', (await folded(page, 'archiveCard')) && (await folded(page, 'lotCard')) && (await folded(page, 'sheetsCard')));
page = await open('/teams');
check('Teams: the counting plan folds', await folded(page, 'planCard'));
page = await open('/testing');
await page.waitForTimeout(800);
check('Testing Suite: the extras fold', (await folded(page, 'optionsCard')) && (await folded(page, 'sandboxCard')) && (await folded(page, 'uploadCard')));

page = await open('/settings#gun', { fold: false });
check('An automated browser without the flag sees every card open', !(await folded(page, 'idleCard')) && (await shown(page, '#fIdleMinutes')));
check('No page errors', !errors.length, errors.join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
