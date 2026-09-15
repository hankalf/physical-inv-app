/* Guiding a team down an aisle, and which count a gun lands on. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

const full = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'guided walk' }) }));
await fetch(`${BASE}/api/admin/sessions/${full.id}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${full.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: readFileSync(`${S}fixtures/pallets.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${full.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: true, askComments: false }) });
await fetch(`${BASE}/api/admin/sessions/${full.id}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '1', aisles: 'F01', levels: 'A', force: true }) });
const cyc = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'the cycle programme', mode: 'cycle' }) }));
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'GUIDE-01' }) }));

/* ---------------- which count a gun lands on ---------------- */
check('No default to begin with', (await j(await fetch(`${BASE}/api/admin/default-session`, { headers: A }))).sessionId === 0);
const set = await j(await fetch(`${BASE}/api/admin/default-session`, { method: 'POST', headers: A, body: JSON.stringify({ sessionId: full.id }) }));
check('A supervisor can name the count scanners start on', set.sessionId === full.id, String(set.sessionId));
const pub = await j(await fetch(`${BASE}/api/sessions`, { headers: { authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token } }));
check('The gun is told which one that is', pub.find((x) => x.id === full.id).isDefault === true && pub.find((x) => x.id === cyc.id).isDefault === false);
const bad = await fetch(`${BASE}/api/admin/default-session`, { method: 'POST', headers: A, body: JSON.stringify({ sessionId: 999999 }) });
check('A count that is not open cannot be the default', bad.status === 400, (await j(bad)).error);
await fetch(`${BASE}/api/admin/sessions/${cyc.id}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'closed' }) });
await fetch(`${BASE}/api/admin/default-session`, { method: 'POST', headers: A, body: JSON.stringify({ sessionId: full.id }) });
await fetch(`${BASE}/api/admin/sessions/${full.id}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'closed' }) });
check('Closing the default quietly stops it being the default, rather than sending guns to a closed count',
  (await j(await fetch(`${BASE}/api/admin/default-session`, { headers: A }))).sessionId === 0);
await fetch(`${BASE}/api/admin/sessions/${full.id}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'open' }) });
await fetch(`${BASE}/api/admin/default-session`, { method: 'POST', headers: A, body: JSON.stringify({ sessionId: full.id }) });

/* ================= down the aisle ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(900);
check('Gun: it lands on the count the supervisor picked, without being told',
  (await gun.inputValue('#fSession')) === String(full.id),
  `picked #${await gun.inputValue('#fSession')}, wanted #${full.id}`);

await gun.fill('#fTeam', '1');
await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active', { timeout: 20000 });
await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(700);

const first = clean(await gun.textContent('#nextBin'));
check('Gun: it names the first bin in the aisle, in order', /Next bin\s*F01A001/.test(first), first.slice(0, 90));
check('Gun: and says where that is and how far along the aisle they are',
  /Level A/.test(first) && /Position 001/.test(first) && /of \d+/.test(first), first.slice(0, 110));

const pallets = readFileSync(`${S}fixtures/pallets.csv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(420); };
const byBin = (b) => pallets.find((c) => c[5] === b);
const countBin = async (bin) => {
  const p = byBin(bin);
  if (p) { await scan(p[0]); await scan(String(p[4])); await scan(bin); }
  else { await gun.click('#btnEmpty'); await gun.waitForTimeout(250); await scan(bin); }
  await gun.waitForTimeout(500);
};
await countBin('F01A001');
check('Gun: counting 001 moves the guide on to 002', /Next bin\s*F01A002/.test(clean(await gun.textContent('#nextBin'))), clean(await gun.textContent('#nextBin')).slice(0, 60));
await countBin('F01A002');
check('Gun: then 003 — it walks the aisle 001, 002, 003', /Next bin\s*F01A003/.test(clean(await gun.textContent('#nextBin'))), clean(await gun.textContent('#nextBin')).slice(0, 60));

// counting out of order is allowed, and the guide simply skips what is done
await countBin('F01A005');
check('Gun: counting out of order is fine — it just points at the next one still open',
  /Next bin\s*F01A003/.test(clean(await gun.textContent('#nextBin'))), clean(await gun.textContent('#nextBin')).slice(0, 60));
await gun.screenshot({ path: `${S}screenshots/gun-next-bin.png` });

const prog = clean(await gun.textContent('#nextBin'));
check('Gun: the progress counter keeps up', /3 of \d+/.test(prog), prog.slice(prog.indexOf('of') - 6));
await gun.close();

/* an unguided session gets no guide: there is no aisle to walk */
await fetch(`${BASE}/api/admin/sessions/${full.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false }) });
const free = await browser.newPage({ viewport: { width: 480, height: 800 } });
free.on('dialog', (d) => d.accept());
await free.goto(`${BASE}/?d=${dev.uid}`);
await free.waitForSelector('#scrSignon.active'); await free.waitForTimeout(900);
await free.fill('#fTeam', '1'); await free.fill('#fEmployee', 'E1001'); await free.press('#fEmployee', 'Enter');
await free.click('#btnStart'); await free.waitForTimeout(2500);
if (await free.$('#scrAssign.active')) await free.click('#btnCount');
await free.waitForSelector('#scrScan.active', { timeout: 20000 });
await free.waitForTimeout(600);
check('Gun: counting freely shows no bin guide, because there is no aisle to walk',
  await free.$eval('#nextBin', (el) => el.hidden));
await free.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} gun-guidance checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
