/*
 * The how-to guides inside the User guide page: the guides for users for
 * every login, the admin editions for admins too; read on the page, the PDF
 * to download, and their sections found by Ask the guide.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + await login({ password: 'changeme' }) };
await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'GUIDE-SUP', name: 'Guide Sup', password: 'reads-the-guide-1', mustChange: false, profile: 'floor' }) });
const S = { ...hdr, authorization: 'Bearer ' + await login({ username: 'GUIDE-SUP', password: 'reads-the-guide-1' }) };

const adminList = (await j(await fetch(`${BASE}/api/admin/guides`, { headers: A }))).guides;
const supList = (await j(await fetch(`${BASE}/api/admin/guides`, { headers: S }))).guides;
check('Every login gets the six guides for users, the first full count first', supList.map((g) => `${g.edition}/${g.name}`).join() === 'user/first-full-count,user/second-and-third-counts,user/erp-upload-by-aisle,user/reports-and-exports,user/employees-teams-and-gear,user/live-and-test', supList.map((g) => g.name).join());
check('…an admin gets the admin editions too, the set-up guide for second and third counts among them', adminList.length === 13 && adminList.filter((g) => g.edition === 'admin').length === 7 && adminList.some((g) => g.edition === 'admin' && g.name === 'set-up-second-and-third-counts' && g.sections.length >= 9));
const exRes = await fetch(`${BASE}/api/admin/guides/user/reports-and-exports`, { headers: S });
const ex = await j(exRes);
check('The exports guide is there for every login, a section for each export button', exRes.status === 200 && ['Download this list (CSV)', 'ERP worksheet', 'Adjustments CSV', 'Fix list CSV', 'Final report', 'Export everything', 'Pallet report CSV', 'Raw counts CSV', 'Exceptions CSV', 'Uncounted bins CSV', 'Count sheets'].every((t) => ex.html.includes(t)), exRes.status);
check('…and says nothing about Railway or setting the system up', !/railway|SYSTEM_|link key|Settings → Logins/i.test(ex.html));
check('…each with its title, who it is for, a lead and its sections', supList.every((g) => g.title && g.who && g.blurb.length > 40 && g.sections.length >= 5 && g.pdf));
/* the first full count, start to finish: every step for an admin, the floor's part for everyone else */
const ffcAdmin = await j(await fetch(`${BASE}/api/admin/guides/admin/first-full-count`, { headers: A }));
check('First full count (admin): every step from the first sign-in to the closed count, full counts only', ffcAdmin.sections && ffcAdmin.sections.length >= 25 && ['Sign in for the first time', 'Register and set up the scanners', 'Create the count', 'Upload the bin list and the inventory report', 'Give the teams their aisles', 'Close the count and keep a copy', 'The tick list'].every((t) => ffcAdmin.sections.some((x) => x.title === t)), (ffcAdmin.sections || []).map((x) => x.title).join(' | '));
check('…and nothing about Railway or server variables', !/railway|SYSTEM_|link key|environment variable/i.test(ffcAdmin.html));
const ffcPics = [...ffcAdmin.html.matchAll(/src="(\/guide-images\/[a-z0-9-]+\.png)"/g)].map((m) => m[1]);
check('…its pictures all load', ffcPics.length >= 15 && (await Promise.all(ffcPics.map((u) => fetch(BASE + u).then((x) => x.status)))).every((st) => st === 200), ffcPics.length);
const ffcUser = await j(await fetch(`${BASE}/api/admin/guides/user/first-full-count`, { headers: S }));
check('First full count (users): signing in to the ERP upload, with no Settings, Railway or server variables', ffcUser.sections && ffcUser.sections.length >= 10 && !/railway|SYSTEM_|link key|Settings →/i.test(ffcUser.html) && /Sign on &amp; load list|Sign on & load list/.test(ffcUser.html), (ffcUser.sections || []).length);
let r = await fetch(`${BASE}/api/admin/guides/admin/live-and-test`, { headers: S });
check('A supervisor cannot open an admin edition', r.status === 403);
r = await fetch(`${BASE}/api/admin/guides/user/live-and-test`, { headers: S });
const doc = await j(r);
check('A guide comes as its page: headings, the contents, pictures from the app', r.status === 200 && /<h2 id="1--in-one-minute">/.test(doc.html) && /href="#2--which-one-am-i-on"/.test(doc.html) && /src="\/guide-images\/guide-ring-live\.png"/.test(doc.html), doc.html.slice(0, 120));
check('…and the user edition says nothing about Railway or settings', !/railway|SYSTEM_|link key/i.test(doc.html));
r = await fetch(`${BASE}/guide-images/guide-ring-live.png`);
check('Its pictures load', r.status === 200 && r.headers.get('content-type') === 'image/png');
check('…by plain name only', (await fetch(`${BASE}/guide-images/..%2F..%2Fpackage.json`)).status === 404);
r = await fetch(`${BASE}/api/admin/guides/user/live-and-test.pdf`, { headers: S });
const pdf = Buffer.from(await r.arrayBuffer());
check('Its PDF downloads', r.status === 200 && r.headers.get('content-type') === 'application/pdf' && pdf.slice(0, 4).toString() === '%PDF' && /live-and-test\.pdf/.test(r.headers.get('content-disposition')));
check('Signed out, no guides', (await fetch(`${BASE}/api/admin/guides`)).status === 401);
check('A name that is not a guide is a 404', (await fetch(`${BASE}/api/admin/guides/user/nope`, { headers: S })).status === 404);

/* the page */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/guide`);
await page.fill('#fUser', 'GUIDE-SUP'); await page.fill('#fPassword', 'reads-the-guide-1'); await page.click('#btnLogin');
await page.waitForSelector('#howtos .howto');
check('User guide: a How-to guides card with the six for users', (await page.locator('#howtos .howto').count()) === 6 && !(await page.isVisible('#howtosAdmin')));
await page.locator('#howtos .howto[data-guide="user/erp-upload-by-aisle"] button.primary').click();
await page.waitForSelector('#readerCard:not([hidden]) #readerBody h2');
check('Read shows the guide on the page', /The ERP upload, an aisle at a time/.test(await page.textContent('#readerTitle')) && (await page.locator('#readerBody h2').count()) >= 6 && (await page.locator('#readerBody img').count()) >= 3);
const imgOk = await page.$$eval('#readerBody img', (imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0));
check('…with its pictures', imgOk);
await page.click('#readerBody a[href="#6--a-line-counted-again-after-it-went-in"]');
await page.waitForTimeout(800);
check('…its contents jump within the page', (await page.evaluate(() => document.getElementById('6--a-line-counted-again-after-it-went-in').getBoundingClientRect().top)) < 300);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#readerPdf')]);
check('⬇ PDF downloads it', /erp-upload-by-aisle\.pdf$/.test(dl.suggestedFilename()), dl.suggestedFilename());
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1500);
check('An open guide stays open on a reload', !(await page.isHidden('#readerCard')) && /ERP upload/.test(await page.textContent('#readerTitle')));
await page.click('#readerClose');
check('Close puts it away', await page.isHidden('#readerCard'));
await page.fill('#askInput', 'third count team that did neither');
await page.waitForTimeout(500);
const hit = page.locator('#answers .answer[data-kind="howto"]').first();
check('Ask the guide finds the guides too', (await hit.count()) === 1 && /Second and third counts/.test(await hit.textContent()), clean(await page.textContent('#answers')).slice(0, 160));
await hit.locator('a', { hasText: 'Read it in the guide' }).click();
await page.waitForSelector('#readerCard:not([hidden]) #readerBody h2');
check('…and Read it in the guide opens the guide at that section', /Second and third counts/.test(await page.textContent('#readerTitle')));
check('No page errors', !errors.length, errors.join(' | '));

/* an admin sees both editions */
const ap = await ctx.newPage();
await ap.goto(`${BASE}/guide`);
await ap.fill('#fPassword', 'changeme'); await ap.click('#btnLogin');
await ap.waitForSelector('#howtosAdminList .howto');
check('An admin sees the admin editions under For admins', (await ap.locator('#howtosAdminList .howto').count()) === 7 && /Admin edition/.test(await ap.textContent('#howtosAdminList')));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
