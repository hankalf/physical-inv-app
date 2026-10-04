/* The move desk on Front bins: the pallet and bins to move at the top, the
   pallet system's own screen underneath, and a move ticked off from the desk. */
import { chromium } from 'playwright-core';
import { signIn, expandSubTabs } from './helpers.mjs';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* a site bin list and a move list */
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'desk site' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location\nF01A001\nF01A002\nF01A003\nF01A004\n' });
const up = await j(await fetch(`${BASE}/api/admin/front/moves/import`, { method: 'POST', headers: csv, body: 'Pallet,From bin,To bin\nF12311-111,F01A001,F01A002\nF12312-111,F01A003,F01A004\n' }));
check('Two moves wait on the site list', up.added === 2, JSON.stringify(up));

/* the address: admins set it, and only a web address will do */
check('An empty address to start with', (await j(await fetch(`${BASE}/api/admin/pallet-system`, { headers: A }))).url === '');
check('A bare word is not an address', (await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: A, body: JSON.stringify({ url: 'nav' }) })).status === 400);
const set = await j(await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: A, body: JSON.stringify({ url: `${BASE}/board` }) }));
check('An admin sets the pallet system address', set.url === `${BASE}/board`);
await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'JO', name: 'Jo Lee', password: 'front-bins-9', mustChange: false, profile: 'jobs' }) });
const jo = { ...hdr, authorization: 'Bearer ' + (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'JO', password: 'front-bins-9' }) }))).token };
check('A Warehouse jobs login may read it but not change it', (await fetch(`${BASE}/api/admin/pallet-system`, { headers: jo })).ok && (await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: jo, body: JSON.stringify({ url: 'https://x.example' }) })).status === 403);

/* in the browser, as the Warehouse jobs login */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept('needs a look'));
await page.goto(BASE + '/front');
await page.fill('#fUser', 'JO'); await page.fill('#fPassword', 'front-bins-9'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1200);
await page.evaluate(() => window.appApi.showSub('desk')); await page.waitForTimeout(1200);
check('Front bins has a Move desk tab', (await page.$$eval('#subTabs button', (b) => b.map((x) => x.textContent.trim()))).some((t) => /Move desk/.test(t)));
check('The desk shows the next pallet and its bins at the top', clean(await page.textContent('#deskPallet')) === 'F12311-111' && clean(await page.textContent('#deskFrom')) === 'F01A001' && clean(await page.textContent('#deskTo')) === 'F01A002' && /1 of 2 waiting/.test(await page.textContent('#deskCount')),
  clean(await page.textContent('#deskStrip')).slice(0, 120));
check('…with the pallet system framed underneath, and a new-tab link', (await page.getAttribute('#deskFrame', 'src')) === `${BASE}/board` && await page.isVisible('#deskOpen') && !(await page.$eval('#deskWrap', (el) => el.classList.contains('none'))));
await page.click('#deskNext'); await page.waitForTimeout(300);
check('Next steps to the second move', clean(await page.textContent('#deskPallet')) === 'F12312-111');
await page.click('#deskPrev'); await page.waitForTimeout(300);
await page.click('#deskDone'); await page.waitForTimeout(1200);
const after = await j(await fetch(`${BASE}/api/admin/front/moves`, { headers: A }));
check('Mark moved ticks the move off from the desk, and the next one comes up', after.moves.find((m) => m.pallet_id === 'F12311-111').status === 'done' && clean(await page.textContent('#deskPallet')) === 'F12312-111' && /1 of 1 waiting/.test(await page.textContent('#deskCount')),
  clean(await page.textContent('#deskCount')));
await page.click('#deskSkip'); await page.waitForTimeout(1200);
const after2 = await j(await fetch(`${BASE}/api/admin/front/moves`, { headers: A }));
check('Skip leaves it for a look, with the reason', after2.moves.find((m) => m.pallet_id === 'F12312-111').status === 'skipped' && /needs a look/.test(after2.moves.find((m) => m.pallet_id === 'F12312-111').reason || ''));
check('…and the desk says nothing is waiting', await page.isVisible('#deskNone'));
await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: A, body: JSON.stringify({ url: '' }) });
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.evaluate(() => window.appApi.showSub('desk')); await page.waitForTimeout(1200);
check('With no address set the desk says where to set it, and the strip still works', /Settings → Advanced/.test(await page.textContent('#deskUrlNote')) && await page.$eval('#deskWrap', (el) => el.classList.contains('none')));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} move desk checks passed`);
if (results.some((r) => !r)) process.exitCode = 1;
