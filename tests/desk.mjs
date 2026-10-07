/* The move desk on Front bins: the pallet and bins to move at the top, the
   pallet system's own screen underneath, and a move ticked off from the desk. */
import http from 'node:http';
import { chromium } from 'playwright-core';
import { signIn, expandSubTabs, fakeAspx } from './helpers.mjs';
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
const frameW = async () => Math.round(await page.$eval('#deskFrame', (f) => f.getBoundingClientRect().width));
check('…framed at the size of a Zebra’s screen, like the Testing Suite’s gun', (await frameW()) === 360 && await page.$eval('#deskWide', (b) => b.textContent === 'Full width'), `${await frameW()}px`);
await page.click('#deskWide'); await page.waitForTimeout(200);
check('…and Full width opens it out across the card', (await frameW()) > 600 && await page.$eval('#deskWide', (b) => b.textContent === 'Handheld size'), `${await frameW()}px`);
await page.reload(); await page.waitForSelector('#scrMain.active', { state: 'attached' }); await page.waitForTimeout(1500);
check('…a choice this browser remembers', await page.$eval('#deskWrap', (el) => el.classList.contains('wide')));
await page.click('#deskWide'); await page.waitForTimeout(200);
check('…and back to handheld size', (await frameW()) === 360, `${await frameW()}px`);
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
/* ---- placeholders: the address opens on the pallet in hand ---- */
await fetch(`${BASE}/api/admin/front/moves/import`, { method: 'POST', headers: csv, body: 'Pallet,From bin,To bin\nF12313-111,F01A001,F01A002\n' });
let r = await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: A, body: JSON.stringify({ url: `${BASE}/board?pallet={pallet}&from={from}&to={to}&x={nope}` }) });
check('A placeholder the desk cannot fill is refused, naming the ones it can', r.status === 400 && /\{pallet\}/.test((await j(r)).error));
await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: A, body: JSON.stringify({ url: `${BASE}/board?pallet={pallet}&from={from}&to={to}`, mode: 'frame' }) });
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.evaluate(() => window.appApi.showSub('desk')); await page.waitForTimeout(1200);
check('With placeholders, the frame opens the system on the pallet in hand', (await page.getAttribute('#deskFrame', 'src')) === `${BASE}/board?pallet=F12313-111&from=F01A001&to=F01A002`, await page.getAttribute('#deskFrame', 'src'));

/* ---- the check: what the system's headers say ---- */
r = await fetch(`${BASE}/api/admin/pallet-system/check`, { method: 'POST', headers: A, body: JSON.stringify({ url: `${BASE}/board` }) });
let chk = await j(r);
check('Checking the app\'s own board: reachable, frameable', r.status === 200 && chk.reachable && chk.frames === 'yes' && chk.verdict === 'frame', JSON.stringify(chk).slice(0, 200));
// a stand-in for an in-house ASP.NET system: refuses frames, signs in with cookies that have no SameSite
const aspx = http.createServer((q, s) => { s.setHeader('X-Frame-Options', 'SAMEORIGIN'); s.setHeader('Set-Cookie', ['ASP.NET_SessionId=abc; path=/; HttpOnly', '.ASPXAUTH=xyz; path=/; HttpOnly']); s.setHeader('X-Powered-By', 'ASP.NET'); s.end('<html>login</html>'); });
await new Promise((ok) => aspx.listen(0, '127.0.0.1', ok));
const aspxUrl = `http://127.0.0.1:${aspx.address().port}/Login.aspx?ReturnUrl=Move.aspx&pallet={pallet}`;
chk = await j(await fetch(`${BASE}/api/admin/pallet-system/check`, { method: 'POST', headers: A, body: JSON.stringify({ url: aspxUrl }) }));
check('An ASP.NET-style site is read right: will not frame, cookies will not stick, so show it through this app', chk.frames === 'no' && chk.cookies === 'lax' && chk.verdict === 'proxy' && /X-Frame-Options/.test(chk.findings.join(' ')) && /SameSite=None/.test(chk.findings.join(' ')), JSON.stringify(chk.findings));
aspx.close();
chk = await j(await fetch(`${BASE}/api/admin/pallet-system/check`, { method: 'POST', headers: A, body: JSON.stringify({ url: 'http://127.0.0.1:1/Nothing.aspx' }) }));
check('A system the server cannot reach says so rather than guessing', chk.verdict === 'unreachable' && !chk.reachable && /could not reach/.test(chk.findings[0]), chk.findings[0]);
check('A supervisor cannot run the check', (await fetch(`${BASE}/api/admin/pallet-system/check`, { method: 'POST', headers: jo, body: JSON.stringify({ url: `${BASE}/board` }) })).status === 403);

/* ---- its own window: where an ASP.NET sign-in works ---- */
const setW = await j(await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: A, body: JSON.stringify({ url: `${BASE}/board?pallet={pallet}&to={to}`, mode: 'window' }) }));
check('An admin switches it to open in its own window', setW.mode === 'window' && (await j(await fetch(`${BASE}/api/admin/pallet-system`, { headers: jo }))).mode === 'window');
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.evaluate(() => window.appApi.showSub('desk')); await page.waitForTimeout(1200);
check('The desk shows no frame then: a button to open this pallet in the system, and why', await page.$eval('#deskWrap', (el) => el.classList.contains('none')) && await page.isVisible('#deskWindow') && /Open F12313-111 in the pallet system/.test(await page.textContent('#deskWindow')) && await page.isVisible('#deskWindowNote') && await page.isHidden('#deskWide'));
const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 5000 }).catch(() => null), page.click('#deskWindow')]);
check('…which opens the system in a window of its own, on that pallet', !!popup && popup.url() === `${BASE}/board?pallet=F12313-111&to=F01A002`, popup && popup.url());
if (popup) await popup.close();

/* ---- through this app: the frame stays under the strip, and the ASP.NET sign-in sticks ---- */
const wms = await fakeAspx();
await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: A, body: JSON.stringify({ url: `${wms.origin}/Move.aspx?pallet={pallet}&to={to}`, mode: 'proxy' }) });
check('Without a ticket nobody reaches the system through the app', (await fetch(`${BASE}/ps/Move.aspx?pallet=X`)).status === 403);
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.evaluate(() => window.appApi.showSub('desk')); await page.waitForTimeout(1500);
check('Through this app, the frame is back under the strip, on this site, on the pallet in hand', (await page.getAttribute('#deskFrame', 'src')) === '/ps/Move.aspx?pallet=F12313-111&to=F01A002' && !(await page.$eval('#deskWrap', (el) => el.classList.contains('none'))) && await page.isHidden('#deskWindow'), await page.getAttribute('#deskFrame', 'src'));
const viaApp = await page.evaluate(async () => { const r = await fetch('/ps/Login.aspx'); return { status: r.status, xfo: r.headers.get('x-frame-options'), html: await r.text() }; });
check('The system\'s page comes through with its "do not frame me" header gone and its links turned towards this site', viaApp.status === 200 && !viaApp.xfo && /href="\/ps\/WebResource\.axd/.test(viaApp.html) && /action="\/ps\/Login\.aspx/.test(viaApp.html) && /href="\/ps\/Help\.aspx"/.test(viaApp.html), viaApp.html.slice(0, 200));
const wmsFrame = async () => page.frames().find((f) => f.url().includes('/ps/'));
await page.waitForFunction(() => { const f = document.getElementById('deskFrame'); try { return !!(f.contentDocument && f.contentDocument.querySelector('#go')); } catch { return false; } }, null, { timeout: 8000 }).catch(() => {});
let fr = await wmsFrame();
check('The frame shows the system\'s sign-in (it sent the desk there, and the redirect was turned round)', !!fr && /Sign in to the WMS/.test(await fr.textContent('body')) && fr.url().includes('/ps/Login.aspx'), fr && fr.url());
await fr.fill('#user', 'dana'); await fr.fill('#pw', 'secret'); await fr.click('#go');
await page.waitForFunction(() => { const f = document.getElementById('deskFrame'); try { return !!(f.contentDocument && f.contentDocument.querySelector('#welcome')); } catch { return false; } }, null, { timeout: 8000 }).catch(() => {});
fr = await wmsFrame();
check('Signing in inside the frame sticks: the system lands on the pallet, signed in, under the strip', !!fr && /Welcome dana - move F12313-111 to F01A002/.test(await fr.textContent('body')), fr && (await fr.textContent('body')).slice(0, 120));
const jar = (await page.context().cookies(`${BASE}/ps/Move.aspx`)).filter((c) => /ASPXAUTH|ASP\.NET_SessionId|psTicket/.test(c.name));
check('The system\'s cookies live under this site, on the /ps path only', jar.length === 3 && jar.every((c) => c.path === '/ps'), JSON.stringify(jar.map((c) => [c.name, c.path])));
wms.close();

await fetch(`${BASE}/api/admin/pallet-system`, { method: 'POST', headers: A, body: JSON.stringify({ url: '' }) });
await page.reload(); await page.waitForSelector('#scrMain.active'); await page.evaluate(() => window.appApi.showSub('desk')); await page.waitForTimeout(1200);
check('With no address set the desk says where to set it, and the strip still works', /Settings → Integrations/.test(await page.textContent('#deskUrlNote')) && await page.$eval('#deskWrap', (el) => el.classList.contains('none')));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} move desk checks passed`);
if (results.some((r) => !r)) process.exitCode = 1;
