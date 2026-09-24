/*
 * Two things that came off the floor.
 *
 * A label that will not scan: freezer labels come off, ice over, get clipped by
 * a forklift. The pallet is still there and still has to be counted, so the
 * counter says which kind of problem it is and carries on - and a supervisor
 * gets the walk-round list for somebody with a label printer.
 *
 * And a line on the office board: when lunch is, which dock is blocked. Written
 * on the dashboard, read from across the room. Messages go to the scanners;
 * this goes on the wall.
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

const BINS = 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\n';
const PALLETS = ['Pallet ID,SKU,Description,Qty,Location',
  'LB1,SKU-A,Chicken breast 40lb,100,F01A001',
  'LB2,SKU-B,Ground beef 10lb,50,F01A002'].join('\n') + '\n';

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'labels' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: BINS });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: PALLETS });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'LBL-01' }) }));

/* ================= on the gun ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 400, height: 780 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(900);
await gun.selectOption('#fSession', String(sess.id));
await gun.fill('#fTeam', '1'); await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForTimeout(2500);
if (await gun.$('#scrAssign.active')) await gun.click('#btnCount');
await gun.waitForSelector('#scrScan.active', { timeout: 90000 }); await gun.waitForTimeout(600);

const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(500); };
const prompt = async () => clean(await gun.textContent('#prompt'));

check('Gun: the way out of an unreadable label is offered on the pallet step',
  await gun.$eval('#btnNoScan', (b) => !b.hidden));

/* ---- one that can be read, but not scanned ---- */
await gun.click('#btnNoScan'); await gun.waitForTimeout(300);
check('Gun: it asks which kind of problem it is rather than guessing',
  await gun.$eval('#noScanRow', (b) => !b.hidden));
await gun.click('#btnNoScanType'); await gun.waitForTimeout(400);
check('Gun: "I can read it" turns the keyboard on, because now somebody has to type',
  (await gun.$eval('#fScan', (f) => f.inputMode)) === 'text', await gun.$eval('#fScan', (f) => f.inputMode));
await scan('LB1');
check('Gun: and the pallet goes on as normal from there', /QUANTITY/.test(await prompt()), await prompt());
await scan('100');
await scan('F01A001');
await gun.waitForTimeout(1500);

/* ---- one with nothing readable on it at all ---- */
await gun.click('#btnNoScan'); await gun.waitForTimeout(300);
await gun.click('#btnNoScanNone'); await gun.waitForTimeout(600);
const said = clean(await gun.textContent('#scanMsg'));
check('Gun: a pallet with no readable ID is still counted rather than skipped',
  /no label/i.test(said), said.slice(0, 140));
check('Gun: and it moves straight on to the quantity — the counter is holding a pallet',
  /QUANTITY/.test(await prompt()), await prompt());
await scan('42');
await scan('F01A002');
await gun.waitForTimeout(2200);

/* ---- the label on the racking, which is the worse one ---- */
await scan('LB2');
await scan('50');
check('Gun: the way out is offered on the bin step too', await gun.$eval('#btnNoScan', (b) => !b.hidden));
check('Gun: and it is worded for the label in front of the counter',
  /Bin label will not scan/.test(clean(await gun.textContent('#btnNoScan'))), clean(await gun.textContent('#btnNoScan')));
await gun.click('#btnNoScan'); await gun.waitForTimeout(300);
/* This count is not guided and nothing has been counted in a bin yet on this
   line, so the app falls back to where the report puts this pallet. */
check('Gun: it offers the bin it believes the counter is standing at, rather than asking them to type one',
  /It is F01A002/.test(clean(await gun.textContent('#btnNoScanNone'))), clean(await gun.textContent('#btnNoScanNone')));
await gun.click('#btnNoScanNone'); await gun.waitForTimeout(2200);

/* ---- a rack label with nothing on it, and nothing for the app to suggest ---- */
await scan('NEWTAG-77');                       // not on the report, so no expected bin
if (await gun.$('#scrOverride.active')) {
  await gun.selectOption('#fReason', { index: 1 }).catch(() => {});
  await gun.click('#btnOverrideAccept');
  await gun.waitForTimeout(800);
}
await scan('12');
await gun.click('#btnNoScan'); await gun.waitForTimeout(300);
check('Gun: with nothing to suggest, it offers to record it without a bin code rather than guessing',
  /No readable bin label/.test(clean(await gun.textContent('#btnNoScanNone'))), clean(await gun.textContent('#btnNoScanNone')));
await gun.click('#btnNoScanNone'); await gun.waitForTimeout(2200);
check('Gun: and it does not ask why — the counter has just said why',
  !(await gun.$('#scrOverride.active')), await gun.$eval('#prompt', (el) => el.textContent));

const lines = (await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text()).trim().split('\n');
const head = lines[0].split(',');
const at = (row, name) => row.split(',')[head.indexOf(name)];
const rows = lines.slice(1);
check('Four lines landed', rows.length === 4, String(rows.length));
const noBin = rows.find((r) => /NO-LABEL-BIN/.test(r));
check('The one with no readable bin label is still counted, flagged as an unknown bin',
  at(noBin, 'bin_label_issue') === 'none' && at(noBin, 'unknown_location') === '1' && at(noBin, 'qty') === '12', noBin);
const lb2 = rows.find((r) => r.includes('LB2'));
check('The rack label is recorded against the line, separately from the pallet\'s',
  at(lb2, 'bin_label_issue') === 'assumed' && at(lb2, 'label_issue') === '', lb2);
check('...and the line still lands in a real bin, with its quantity',
  at(lb2, 'location_code') === 'F01A002' && at(lb2, 'qty') === '50', lb2);
check('The typed one is marked as a label to replace',
  at(rows.find((r) => r.includes('LB1')), 'label_issue') === 'typed', rows.find((r) => r.includes('LB1')));
const noLabel = rows.find((r) => /NO-LABEL/.test(r));
check('The one with nothing readable is marked too, and carries its quantity',
  at(noLabel, 'label_issue') === 'none' && at(noLabel, 'qty') === '42', noLabel);
/* Named after the bin it actually turned up in, not the one before it: the
   whole point is that somebody can walk to it with a printer. */
check('...and is named after the bin it is in',
  at(noLabel, 'pallet_id') === `NO-LABEL-${at(noLabel, 'location_code')}-1`,
  `${at(noLabel, 'pallet_id')} in ${at(noLabel, 'location_code')}`);
check('The pallet label on that line is not marked — only the rack one was wrong',
  at(lb2, 'label_issue') === '', lb2);

/* ================= what a supervisor does with it ================= */
const { labels } = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/labels`, { headers: A }));
check('All four are on the relabel list', labels.length === 4, String(labels.length));
check('...and it says which kind each was',
  labels.some((r) => r.issue === 'NO READABLE ID') && labels.some((r) => r.issue === 'BARCODE WOULD NOT SCAN'),
  labels.map((r) => r.issue).join(' | '));
check('...whether it was on a pallet or on the racking',
  labels.filter((r) => r.what === 'PALLET').length === 2 && labels.filter((r) => r.what === 'BIN').length === 2,
  labels.map((r) => r.what).join(' '));
check('...with the rack ones first, because everybody walks up to those',
  labels[0].what === 'BIN', labels.map((r) => r.what).join(' '));
check('...with the bin to walk to', labels.filter((r) => /^F01A00/.test(r.location_code)).length === 3,
  labels.map((r) => r.location_code).join(' '));
const labelCsv = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/labels.csv`, { headers: A })).text();
check('The list exports as a file for whoever carries the printer',
  /NO-LABEL/.test(labelCsv) && /BARCODE WOULD NOT SCAN/.test(labelCsv) && /^what,location_code/.test(labelCsv),
  clean(labelCsv.split('\n')[1] || ''));
check('A label problem counts as an exception, so it is in that report too',
  /label_issue/.test(await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/exceptions.csv`, { headers: A })).text()));
check('The list needs a supervisor sign-in', (await fetch(`${BASE}/api/admin/sessions/${sess.id}/labels`)).status === 401);

/* ================= the note on the board ================= */
const empty = await j(await fetch(`${BASE}/api/board?session=${sess.id}`));
check('A board with nothing to say carries no note', !empty.note, String(empty.note));

const put = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/note`, { method: 'POST', headers: A,
  body: JSON.stringify({ note: '  Lunch 11:30–12:00   ·  Team 4 breaks first ' }) }));
check('A note is put on the board, tidied up on the way',
  put.note === 'Lunch 11:30–12:00 · Team 4 breaks first', JSON.stringify(put.note));
check('...and says who wrote it', put.noteBy === 'Dana Whitfield', put.noteBy);
const shown = await j(await fetch(`${BASE}/api/board?session=${sess.id}`));
check('The board - which nobody signs in to - has it', shown.note === put.note, shown.note);
check('Putting one up is in the log',
  (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }))).some((r) => r.action === 'put a note on the board'));
check('Writing one needs a supervisor sign-in',
  (await fetch(`${BASE}/api/admin/sessions/${sess.id}/note`, { method: 'POST', headers: hdr, body: JSON.stringify({ note: 'hello' }) })).status === 401);

const board = await browser.newPage({ viewport: { width: 1600, height: 900 } });
board.on('pageerror', (e) => errors.push('board: ' + e.message));
await board.goto(`${BASE}/board?session=${sess.id}`);
await board.waitForTimeout(1500);
check('Board: the note is on the screen', await board.$eval('#bNote', (el) => !el.hidden));
check('Board: reading what was written', /Lunch 11:30/.test(clean(await board.textContent('#bNoteText'))), clean(await board.textContent('#bNoteText')));
check('Board: above the progress bar, where somebody walking past looks first',
  await board.evaluate(() => {
    const note = document.getElementById('bNote').getBoundingClientRect();
    const bar = document.querySelector('.headline').getBoundingClientRect();
    return note.bottom <= bar.top + 1;
  }));
check('Board: and big enough to read from across the room',
  await board.$eval('#bNoteText', (el) => parseFloat(getComputedStyle(el).fontSize) >= 18),
  await board.$eval('#bNoteText', (el) => getComputedStyle(el).fontSize));
await board.screenshot({ path: new URL('./screenshots/board-note.png', import.meta.url).pathname });

/* Taken down again: the board goes back to being all progress. */
await fetch(`${BASE}/api/admin/sessions/${sess.id}/note`, { method: 'POST', headers: A, body: JSON.stringify({ note: '' }) });
await board.reload();
await board.waitForTimeout(1500);
check('Board: clearing the box takes it off the board', await board.$eval('#bNote', (el) => el.hidden));

/* ================= writing it from the dashboard ================= */
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => errors.push('admin: ' + e.message));
page.on('dialog', (d) => d.accept());
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForTimeout(1200);
await page.fill('#fBoardNote', 'Dock 4 blocked until 2pm');
await page.click('#btnSaveNote');
await page.waitForTimeout(1200);
check('Dashboard: the note box is under the progress dashboard and works',
  /On the board/.test(clean(await page.textContent('#noteMsg'))), clean(await page.textContent('#noteMsg')));
check('Dashboard: and the board now carries it',
  (await j(await fetch(`${BASE}/api/board?session=${sess.id}`))).note === 'Dock 4 blocked until 2pm');
check('Dashboard: the relabel list is on the reports tab, rack labels and pallet labels alike',
  /NO-LABEL/.test(clean(await page.textContent('#labelTable')))
  && /RACK/.test(clean(await page.textContent('#labelTable'))),
  clean(await page.textContent('#labelTable')).slice(0, 160));
await page.click('#btnClearNote');
await page.waitForTimeout(1000);
check('Dashboard: and Clear takes it down',
  !(await j(await fetch(`${BASE}/api/board?session=${sess.id}`))).note);

check('No script errors anywhere', errors.length === 0, errors.join(' | '));
await browser.close();

console.log(`\n${results.filter(Boolean).length}/${results.length} label and note checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
