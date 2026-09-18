/*
 * Approving what the count is about to do to the ERP.
 *
 * A variance is not an adjustment until somebody owns it. These check the thing
 * that makes that worth having: that nothing unsigned reaches the ERP file,
 * that a reason is required rather than optional, that small differences are not
 * made into paperwork, and - the one an auditor cares about - that a line
 * counted again after it was approved comes back to be approved again, because
 * the number somebody signed for is no longer the number.
 *
 * Off unless a count turns it on, and with it off the export behaves exactly as
 * it did before any of this existed. That is checked first.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

const BINS = 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\nF01A004,Freezer,F01\n';
const PALLETS = ['Pallet ID,SKU,Description,Qty,Location',
  'PA1,SKU-A,Chicken breast 40lb,100,F01A001',
  'PA2,SKU-B,Ground beef 10lb,50,F01A002',
  'PA3,SKU-C,Peas 30lb,200,F01A003',
  'PA4,SKU-D,Fries 25lb,80,F01A004'].join('\n') + '\n';

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'approvals' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: BINS });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: PALLETS });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });

const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'APPR-01' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
await fetch(`${BASE}/api/sessions/${sess.id}/signon`, { method: 'POST', headers: D, body: JSON.stringify({ deviceId: 'APPR-01', team: '1', employees: ['E1001'] }) });

let n = 0;
const line = (o) => ({ clientId: `appr-${++n}`, team: '1', deviceId: 'APPR-01', employees: ['E1001'], ...o });
const send = (rows) => fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: JSON.stringify(rows) }).then(j);
const erp = () => fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/adjustments.csv`, { headers: A }).then((r) => r.text());
const adjustments = async (q = '') => j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/adjustments${q}`, { headers: A }));
const setUp = (body) => fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify(body) }).then(j);

/* PA1 is 20 short, PA2 is 2 short, PA3 is right, PA4 is never counted. */
await send([
  line({ palletId: 'PA1', qty: 80, location: 'F01A001' }),
  line({ palletId: 'PA2', qty: 48, location: 'F01A002' }),
  line({ palletId: 'PA3', qty: 200, location: 'F01A003' }),
]);

/* ---------------- off, which is how it ships ---------------- */
const off = await adjustments();
check('It ships off, and says so rather than showing an empty list', off.on === false, String(off.on));
const before = await erp();
check('With it off, every difference goes into the ERP file as it always did',
  /PA1/.test(before) && /PA2/.test(before), clean(before).slice(0, 120));
check('...and the reason column is what the count found', /QTY VARIANCE/.test(before), clean(before.split('\n')[1] || ''));

/* ---------------- on, with a threshold ---------------- */
await setUp({ requireApproval: true, approvalMinQty: 5 });
const on = await adjustments();
check('Turned on, every difference that matters is waiting for somebody',
  on.on === true && on.summary.pending === 1, JSON.stringify(on.summary));
check('...and a two-case difference is not made into paperwork',
  on.adjustments.find((r) => r.pallet_id === 'PA2')?.status === 'auto',
  on.adjustments.map((r) => `${r.pallet_id}:${r.status}`).join(' '));
check('...and a pallet that matched the report is not on the list at all',
  !on.adjustments.some((r) => r.pallet_id === 'PA3'));
check('...nor is one nobody has walked to yet, on a count still running',
  !on.adjustments.some((r) => r.pallet_id === 'PA4'));

const held = await erp();
check('Nothing unsigned reaches the ERP file', !/PA1/.test(held), clean(held).slice(0, 140));
check('...but what is under the threshold still does — nobody was asked about it', /PA2/.test(held));

/* ---------------- a reason is the point ---------------- */
const noReason = await fetch(`${BASE}/api/admin/sessions/${sess.id}/adjustments/decide`, { method: 'POST', headers: A,
  body: JSON.stringify({ palletIds: ['PA1'], decision: 'approve' }) });
check('Approving without saying why is refused', noReason.status === 400, String(noReason.status));
const nothing = await fetch(`${BASE}/api/admin/sessions/${sess.id}/adjustments/decide`, { method: 'POST', headers: A,
  body: JSON.stringify({ palletIds: [], decision: 'approve', reason: 'Miscount — first count was wrong' }) });
check('...and so is approving nothing', nothing.status === 400, String(nothing.status));
check('Deciding needs a supervisor sign-in',
  (await fetch(`${BASE}/api/admin/sessions/${sess.id}/adjustments/decide`, { method: 'POST', headers: hdr, body: JSON.stringify({ palletIds: ['PA1'], decision: 'approve', reason: 'x' }) })).status === 401);

const ok = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/adjustments/decide`, { method: 'POST', headers: A,
  body: JSON.stringify({ palletIds: ['PA1'], decision: 'approve', reason: 'Miscount — first count was wrong', note: '40 cases on the floor behind it' }) }));
check('Approved with a reason', ok.decided === 1 && ok.summary.approved === 1, JSON.stringify(ok.summary));
const signed = await erp();
check('...and now it is in the ERP file', /PA1/.test(signed));
check('...carrying the reason and the name of whoever signed it',
  /Miscount/.test(signed) && /Dana Whitfield/.test(signed), clean(signed.split('\n').find((l) => /PA1/.test(l)) || ''));
check('Approving is in the log a supervisor reads',
  (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }))).some((r) => r.action === 'approved adjustments'));

/* ---------------- counted again, so signed again ---------------- */
await send([line({ palletId: 'PA1', qty: 95, location: 'F01A001', pass: 2 })]);
const moved = await adjustments();
const pa1 = moved.adjustments.find((r) => r.pallet_id === 'PA1');
check('A pallet counted again after it was approved comes back to be approved again',
  pa1.status === 'pending' && Number(pa1.variance_qty) === -5, `${pa1.status} ${pa1.variance_qty}`);
check('...and the approval that no longer applies is gone with it', !pa1.reason && !pa1.decided_by, `${pa1.reason} / ${pa1.decided_by}`);
check('...and the dashboard says how many came back', moved.reopened >= 1, String(moved.reopened));
check('...and the ERP file has dropped it again', !/PA1/.test(await erp()));

/* ---------------- rejecting, and a count that clears itself ---------------- */
const rej = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/adjustments/decide`, { method: 'POST', headers: A,
  body: JSON.stringify({ palletIds: ['PA1'], decision: 'reject', reason: 'Unknown — investigate' }) }));
check('An adjustment can be refused outright', rej.summary.rejected === 1, JSON.stringify(rej.summary));
check('...and a rejected one never reaches the ERP — the system keeps its number', !/PA1/.test(await erp()));

/* PA2 counted correctly on a second pass: there is nothing left to adjust. */
await send([line({ palletId: 'PA2', qty: 50, location: 'F01A002', pass: 2 })]);
const cleared = await adjustments();
check('A variance a second count has cleared stops asking to be approved',
  !cleared.adjustments.some((r) => r.pallet_id === 'PA2'),
  cleared.adjustments.map((r) => r.pallet_id).join(' '));

/* ---------------- once the count is closed ---------------- */
await fetch(`${BASE}/api/admin/sessions/${sess.id}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'closed' }) });
const closed = await adjustments();
check('Once the count is closed, a pallet that was never found IS an adjustment',
  closed.adjustments.some((r) => r.pallet_id === 'PA4' && r.kind === 'MISSING'),
  closed.adjustments.map((r) => `${r.pallet_id}:${r.kind}`).join(' '));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'open' }) });

/* ---------------- the reasons are the site's own ---------------- */
const def = await j(await fetch(`${BASE}/api/admin/adjustment-reasons`, { headers: A }));
check('It ships with reasons a warehouse actually gives', def.isDefault === true && def.reasons.length >= 6, String(def.reasons.length));
const mine = await j(await fetch(`${BASE}/api/admin/adjustment-reasons`, { method: 'POST', headers: A,
  body: JSON.stringify({ reasons: ['Blown by the blast freezer fan', 'Shipped, not relieved'] }) }));
check('A site can write its own', mine.reasons.length === 2 && mine.isDefault === false, mine.reasons.join(' | '));
const back = await j(await fetch(`${BASE}/api/admin/adjustment-reasons`, { method: 'POST', headers: A, body: JSON.stringify({ reasons: [] }) }));
check('...and put the shipped ones back', back.isDefault === true);

/* ================= the dashboard ================= */
/* Something for a supervisor to actually decide on: PA3 was right first time
   and 50 short on the second count. */
await send([line({ palletId: 'PA3', qty: 150, location: 'F01A003', pass: 2 })]);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForTimeout(1200);

check('Dashboard: the Adjustments tab is there', await page.$('#adjustCard') !== null);
check('Dashboard: with approvals on, the list is shown rather than the "turn it on" note',
  await page.$eval('#adjustBody', (el) => !el.hidden) && await page.$eval('#adjustOff', (el) => el.hidden));
const shown = clean(await page.textContent('#adjustTable'));
check('Dashboard: the pallets waiting are listed', /PA3/.test(shown) && /PENDING/.test(shown), shown.slice(0, 140));

/* Approving from the page: tick it, pick a reason, press the button. */
await page.check('#adjustTable input[type=checkbox]');
await page.selectOption('#fAdjReason', { index: 1 });
await page.click('#btnApprove');
await page.waitForTimeout(1200);
check('Dashboard: approving from the page works', /approved/i.test(clean(await page.textContent('#adjustMsg'))), clean(await page.textContent('#adjustMsg')));
/* Whoever pressed the button is on the line in the file - that is the whole
   point of a signature. */
const pa3Line = (await erp()).split('\n').find((l) => /PA3/.test(l)) || '';
check('Dashboard: and the ERP line carries the reason and a name',
  /Miscount|Damaged|Received/.test(pa3Line) && pa3Line.split(',').filter(Boolean).length >= 8, clean(pa3Line));

/* Approving with nothing ticked says so rather than doing nothing quietly. */
await page.click('#btnAdjNone');
await page.waitForTimeout(500);
await page.click('#btnApprove');
await page.waitForTimeout(400);
check('Dashboard: pressing Approve with nothing ticked says so',
  /Nothing selected/i.test(clean(await page.textContent('#adjustMsg'))), clean(await page.textContent('#adjustMsg')));

/* And with approvals off, the tab says how to turn it on rather than showing
   an empty table nobody can explain. */
await setUp({ requireApproval: false });
await page.reload();
/* The supervisor is still signed in after a reload, so the login screen may not
   be there to fill in. */
await page.waitForSelector('#scrLogin.active, #scrMain.active');
if (await page.$('#scrLogin.active')) await signIn(page);
else await page.waitForTimeout(600);
await pickSession(page, sess.id);
await page.waitForTimeout(1200);
check('Dashboard: with approvals off, the tab explains itself',
  await page.$eval('#adjustOff', (el) => !el.hidden) && /Approvals are off/.test(clean(await page.textContent('#adjustOff'))));

check('No script errors on the dashboard', errors.length === 0, errors.join(' | '));
await browser.close();

console.log(`\n${results.filter(Boolean).length}/${results.length} approval checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
