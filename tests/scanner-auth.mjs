/* Scanners must prove which scanner they are before the server takes a count. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

const { token } = await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }));
const A = { ...hdr, authorization: 'Bearer ' + token };
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'auth session' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/csv' }, body: readFileSync(new URL('../public/templates/front-royal-bins.csv', import.meta.url).pathname, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/csv' }, body: readFileSync(`${S}fixtures/pallets.csv`, 'utf8') });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'SCANNER-01' }) }));

const line = (id) => JSON.stringify([{ clientId: id, palletId: 'PLT01001A', qty: 40, location: 'F01A001', team: '1', deviceId: 'CLAIMED', employees: ['E1'] }]);

/* ---------------- without a token ---------------- */
const bare = await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: hdr, body: line('x1') });
check('A count with no token is refused', bare.status === 401, `${bare.status} ${(await bare.json()).error}`);
for (const [what, path] of [['the session list', '/api/sessions'], ['the bin and pallet lists', `/api/sessions/${sess.id}/master`], ['what other scanners counted', `/api/sessions/${sess.id}/counted-pallets`]]) {
  const r = await fetch(BASE + path);
  check(`${what} needs a token too`, r.status === 401, String(r.status));
}
const badTok = await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: { ...hdr, authorization: 'Device not-a-real-token' }, body: line('x2') });
check('A made-up token is refused', badTok.status === 401 && (await badTok.json()).code === 'device');

/* ---------------- enrolment ---------------- */
const unknown = await fetch(`${BASE}/api/devices/zzzzzzzz`, { method: 'POST' });
check('An unregistered link gets nothing', unknown.status === 404);
const enrolled = await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }));
check('Opening a registered link hands back a token', typeof enrolled.token === 'string' && enrolled.token.length > 30 && enrolled.name === 'SCANNER-01', `${enrolled.name}, ${enrolled.token.length} chars`);
const D = { ...hdr, authorization: 'Device ' + enrolled.token };
const ok = await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: line('x3') });
check('With the token, the count is taken', ok.status === 200 && (await ok.json()).accepted.length === 1);
const storedCsv = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text();
check('The line is stamped with the scanner the token proves, not the one it claimed',
  /SCANNER-01/.test(storedCsv) && !/CLAIMED/.test(storedCsv), (storedCsv.split('\r\n')[1] || '').slice(0, 90));

/* ---------------- revocation ---------------- */
const reset = await j(await fetch(`${BASE}/api/admin/devices/${dev.uid}/reset`, { method: 'POST', headers: A, body: '{}' }));
check('Resetting a scanner issues a new link', reset.uid !== dev.uid, `${dev.uid} -> ${reset.uid}`);
const afterReset = await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: line('x4') });
check('The old token stops working the moment the link is reset', afterReset.status === 401);
const oldLink = await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' });
check('The old link stops working too', oldLink.status === 404);
const re = await j(await fetch(`${BASE}/api/devices/${reset.uid}`, { method: 'POST' }));
const D2 = { ...hdr, authorization: 'Device ' + re.token };
check('The new link works', (await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D2, body: line('x5') })).status === 200);
await fetch(`${BASE}/api/admin/devices/${reset.uid}`, { method: 'DELETE', headers: A });
check('Removing a scanner stops it counting', (await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D2, body: line('x6') })).status === 401);

/* ---------------- on the gun ---------------- */
const dev2 = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'SCANNER-07' }) }));
// give the crew an aisle, so the run is a normal one and the only thing under test is the token
await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '3', aisles: 'F01', levels: 'A-F' }) });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
const gun = await ctx.newPage();
gun.on('pageerror', (e) => errors.push(e.message));
const T = (sel) => gun.textContent(sel).then(clean);
await gun.goto(`${BASE}/?d=${dev2.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(400);
check('Gun: opening its link signs the scanner in silently', (await gun.getAttribute('#deviceProblem', 'hidden')) !== null && /registered as SCANNER-07/.test(await T('#deviceInfo')));
await gun.selectOption('#fSession', String(sess.id));
await gun.fill('#fTeam', '3'); await gun.fill('#fEmployee', 'E9001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrScan.active, #scrAssign.active', { timeout: 20000 });
check('Gun: a signed-in scanner can sign on and load the lists', true);
if (await gun.$('#btnCount')) { await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); }
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(250); };
await scan('PLT01004A'); await scan('40'); await scan('F01A004'); await gun.click('#btnSkip'); await gun.waitForTimeout(700);
check('Gun: it counts normally', /Counted PLT01004A/.test(await T('#scanMsg')), await T('#scanMsg'));

// a supervisor pulls the scanner while the counter is working
await fetch(`${BASE}/api/admin/devices/${dev2.uid}/reset`, { method: 'POST', headers: A, body: '{}' });
await scan('PLT01005A'); await scan('40'); await scan('F01A005'); await gun.click('#btnSkip'); await gun.waitForTimeout(2500);
check('Gun: when the scanner is cut off it says so plainly, not "network error"',
  (await gun.getAttribute('#deviceProblem', 'hidden')) === null && /no longer authorised/.test(await T('#deviceProblem')), (await T('#deviceProblem')).slice(0, 120));
check('Gun: the line it just counted is kept, not lost', /queued/.test(await T('#chipQueue')), await T('#chipQueue'));
await gun.screenshot({ path: `${S}screenshots/auth-cut-off.png` });
const csv = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text();
check('And the server did not take it', !/PLT01005A/.test(csv));

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} scanner-auth checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
