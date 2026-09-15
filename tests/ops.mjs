/* Housekeeping: the audit log, backups, the ERP file, and paper count sheets. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();

const { token, name } = await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }));
check('Sign-in records who is at the keyboard', name === 'Dana', name);
const A = { ...hdr, authorization: 'Bearer ' + token };

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'ops session' }) }));
if (!sess.id) { console.error('could not create the session:', sess); process.exit(1); }
const csv = (kind, body) => fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=${kind}`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/csv' }, body });
await csv('bins', readFileSync(new URL('../public/templates/front-royal-bins.csv', import.meta.url).pathname, 'utf8'));
await csv('pallets', readFileSync(`${S}fixtures/pallets.csv`, 'utf8'));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '1', aisles: 'F03', levels: 'A-C' }) });

// Scanners authenticate: enrol one the way a gun does, and use its token for any
// handheld call this suite makes directly.
async function enrolScanner(name, adminHeaders) {
  const d = await (await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name }) })).json();
  const e = await (await fetch(`${BASE}/api/devices/${d.uid}`, { method: 'POST' })).json();
  return { uid: d.uid, token: e.token, headers: { 'content-type': 'application/json', authorization: 'Device ' + e.token } };
}
const api = await enrolScanner('OPS-01', A);
// a few counts, one of them short, so the ERP file has something to say
await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: api.headers, body: JSON.stringify([
  { clientId: 'o1', palletId: 'PLT01001A', qty: 40, location: 'F01A001', team: '1', employees: ['E1001'], deviceId: 'D1' },
  { clientId: 'o2', palletId: 'PLT01002A', qty: 30, location: 'F01A002', team: '1', employees: ['E1001'], deviceId: 'D1' },
  { clientId: 'o3', emptyBin: 1, palletId: '', qty: 0, location: 'F01A003', team: '1', employees: ['E1001'], deviceId: 'D1' },
]) });

/* ---------------- audit ---------------- */
const log = await j(await fetch(`${BASE}/api/admin/audit?limit=50`, { headers: A }));
const actions = log.map((r) => r.action);
check('The log records every dashboard change, attributed to a person',
  log.filter((r) => r.action !== 'scanner enrolled').every((r) => r.actor === 'Dana')
    && actions.includes('created session') && actions.includes('uploaded bins') && actions.includes('assigned aisles'),
  actions.slice(0, 8).join(' · '));
check('A scanner signing itself in is logged against the scanner, not a supervisor',
  log.some((r) => r.action === 'scanner enrolled' && r.actor === 'OPS-01'), log.find((r) => r.action === 'scanner enrolled')?.detail || '');
const assignEntry = log.find((r) => r.action === 'assigned aisles');
check('A log entry says what was done, not just that something was', /team 1: F03 \(ABC\)/.test(assignEntry.detail), assignEntry.detail);
await fetch(`${BASE}/api/admin/people/employees`, { method: 'POST', headers: A, body: JSON.stringify({ badge: 'E1002', name: 'Jordan', equipment: ['SCISSOR LIFT'] }) });
await fetch(`${BASE}/api/admin/people/teams`, { method: 'POST', headers: A, body: JSON.stringify({ name: '9' }) });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '9', aisles: 'F05', levels: 'D-F', force: true }) });
const log2 = await j(await fetch(`${BASE}/api/admin/audit?limit=50`, { headers: A }));
check('An override of the equipment check is recorded as an override',
  log2.some((r) => r.action === 'assigned aisles OVERRIDING the equipment check'), log2[0].action);
const csvLog = await (await fetch(`${BASE}/api/admin/audit/export.csv`, { headers: A })).text();
check('The log exports as CSV', /^at,actor,action,detail,session_id/.test(csvLog) && csvLog.split('\n').length > 5, csvLog.split('\n')[1].slice(0, 70));
check('The log needs a sign-in', (await fetch(`${BASE}/api/admin/audit`)).status === 401);

/* ---------------- backups ---------------- */
const b1 = await j(await fetch(`${BASE}/api/admin/backups`, { headers: A }));
check('A backup is taken automatically when the app starts a new day', b1.backups.some((x) => x.name.includes('daily')), b1.backups.map((x) => x.name).join(', ').slice(0, 80));
const made = await j(await fetch(`${BASE}/api/admin/backups`, { method: 'POST', headers: A, body: '{}' }));
check('A backup can be taken on demand', made.bytes > 10000 && /\.db$/.test(made.name), `${made.name} ${Math.round(made.bytes / 1024)} KB`);
const dl = await fetch(`${BASE}/api/admin/backups/${made.name}`, { headers: A });
const bytes = Buffer.from(await dl.arrayBuffer());
check('A backup downloads, and is a real SQLite file', dl.ok && bytes.subarray(0, 15).toString() === 'SQLite format 3', bytes.subarray(0, 15).toString());
check('A backup name cannot walk out of the backup directory',
  (await fetch(`${BASE}/api/admin/backups/..%2F..%2Fetc%2Fpasswd`, { headers: A })).status >= 400);

/* ---------------- ERP ---------------- */
const fm = await j(await fetch(`${BASE}/api/admin/erp/formats`, { headers: A }));
check('Three ERP layouts ship with the app', ['pallet-lines', 'adjustments', 'bin-lines'].every((k) => fm.formats[k]), Object.keys(fm.formats).join(', '));
const adj = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/adjustments.csv`, { headers: A })).text();
const adjLines = adj.trim().split('\r\n');
check('The adjustments file has only what differs, with a signed adjustment',
  /^Location,Item,Pallet,System Qty,Counted Qty,Adjustment,Reason,Count Date/.test(adjLines[0]) && adjLines.some((l) => /,-18,/.test(l)),
  adjLines.find((l) => /PLT01002A/.test(l)) || adjLines[1]);
const lines = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/bin-lines.csv`, { headers: A })).text();
check('The line-level file carries who counted it', /Clock In Numbers/.test(lines) && /E1001/.test(lines), lines.split('\r\n')[1]);
// a site can define its own layout without a deploy
await fetch(`${BASE}/api/admin/erp/formats`, { method: 'POST', headers: A, body: JSON.stringify({
  id: 'justfood', label: 'JustFood posting file',
  rowsOf: 'variances', columns: [['LOCN', 'bin'], ['ITEM', 'sku'], ['QTY', 'counted'], ['ADJ', 'adjustment'], ['REF', 'reference']],
}) });
const custom = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/justfood.csv`, { headers: A })).text();
check('A site can add its own layout and export it immediately', /^LOCN,ITEM,QTY,ADJ,REF/.test(custom) && /PI-\d+-\d{4}-\d\d-\d\d/.test(custom), custom.split('\r\n')[1]);

/* ---------------- count sheet ---------------- */
const sheetRes = await fetch(`${BASE}/api/admin/sessions/${sess.id}/print/count-sheet?aisle=F03&levels=A&t=${token}`);
const sheet = await sheetRes.text();
check('A count sheet prints for an aisle and level', sheetRes.ok && /<title>Count sheet/.test(sheet) && /F03A001/.test(sheet), `${(sheet.match(/<tr>/g) || []).length} rows`);
check('The sheet is blind by default', !/System says/.test(sheet) && /blind count/.test(sheet));
check('The sheet asks for the clock in numbers', /Clock in numbers/.test(sheet));
const shown = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/print/count-sheet?aisle=F03&levels=A&blind=0&t=${token}`)).text();
check('The sheet can show what the system expects when asked', /System says/.test(shown));
const unc = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/print/count-sheet?aisle=F01&levels=A&uncounted=1&t=${token}`)).text();
check('The sheet can leave out bins that already have a count', !/>F01A001</.test(unc) && /F01A005/.test(unc));
check('A count sheet needs a token', (await fetch(`${BASE}/api/admin/sessions/${sess.id}/print/count-sheet`)).status === 401);

/* ---------------- in the dashboard ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.25 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/40[19]/.test(m.text())) errors.push(m.text()); });
await page.goto(BASE + '/admin');
await page.fill('#fWho', 'Dana'); await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await page.waitForTimeout(1800);
check('Dashboard: the backup list and the log are on screen',
  (await page.$$('#backupTable tbody tr')).length > 0 && (await page.$$('#auditTable tbody tr')).length > 3,
  clean(await page.textContent('#backupSub')).slice(0, 80));
check('Dashboard: the log shows the supervisor by name', /Dana/.test(await page.textContent('#auditTable')));
await page.selectOption('#fErpFormat', 'adjustments');
await page.click('#btnErpPreview'); await page.waitForTimeout(800);
check('Dashboard: an ERP layout previews before anything is downloaded',
  /rows —/.test(clean(await page.textContent('#erpMsg'))) && /Location,Item/.test(await page.textContent('#erpSample')),
  clean(await page.textContent('#erpMsg')).slice(0, 90));
await page.$eval('#backupTable', (el) => el.closest('.card').scrollIntoView()); await page.waitForTimeout(300);
await (await page.$('#backupTable')).evaluate((el) => el.closest('.card').scrollIntoView());
await page.screenshot({ path: `${S}screenshots/ops-dashboard.png`, clip: await (await page.$('#backupTable')).evaluate((el) => { const r = el.closest('.card').getBoundingClientRect(); return { x: r.x, y: Math.max(0, r.y), width: r.width, height: Math.min(r.height, 700) }; }) });
const [sheetTab] = await Promise.all([page.waitForEvent('popup'), page.fill('#fPrintAisle', 'F03').then(() => page.fill('#fPrintLevels', 'A')).then(() => page.click('#btnPrint'))]);
await sheetTab.waitForLoadState();
check('Dashboard: the print button opens a sheet', /Count sheet/.test(await sheetTab.title()), await sheetTab.title());
await sheetTab.screenshot({ path: `${S}screenshots/ops-count-sheet.png`, fullPage: false });
const bump = await j(await fetch(`${BASE}/api/admin/audit?limit=200`, { headers: A }));
check('Printing and exporting are themselves recorded',
  bump.some((r) => r.action === 'printed a count sheet') && bump.some((r) => r.action === 'exported to the ERP'), '');

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} ops checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
