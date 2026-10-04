/*
 * The wrong thing in the wrong field.
 *
 * A rack label scanned where the pallet goes, a pallet label where the bin
 * goes, a label of any kind where the quantity is typed: the gun says what it
 * was and what to do instead, and records nothing.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'DANA-WHITFIELD', password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }).then(j);

const sess = await post('/api/admin/sessions', { name: 'Wrong field' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location\nF01A001\nF01A002\nF01A003\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Bin Code,Container No.,Item No.,Description,Quantity,Lot No.,System\nF01A001,P-100,SKU-1,Mango,40,L-9,ERP\nF01A002,P-200,SKU-2,Berries,30,L-8,ERP\n' });
await post(`/api/admin/sessions/${sess.id}/settings`, { guided: false, askComments: false, askLot: true });
const dev = await post('/api/admin/devices', { name: 'WRONG-01' });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const gun = await browser.newPage({ viewport: { width: 360, height: 640 } });
gun.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`); await gun.waitForTimeout(1500);
await gun.selectOption('#fSession', String(sess.id)).catch(() => {});
await gun.fill('#fTeam', '1'); await gun.fill('#fEmployee', 'E1'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForTimeout(1500);
if (await gun.$('#scrAssign.active')) { await gun.click('#btnCount'); await gun.waitForTimeout(500); }
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
const prompt = async () => clean(await gun.textContent('#prompt'));
const said = async () => clean(await gun.textContent('#scanMsg'));

/* a bin where the pallet goes */
check('The gun starts at the pallet', /PALLET/.test(await prompt()), await prompt());
await scan('F01A001');
check('A rack label scanned at the pallet step is named for what it is, and refused', /F01A001 is a bin, not a pallet/.test(await said()) && /Scan the label on the pallet/.test(await said()) && /PALLET/.test(await prompt()), await said());
check('…with the empty-bin way out pointed to', /Bin is EMPTY/.test(await said()));

/* a label where the quantity goes */
await scan('P-100');
check('The pallet is taken and the quantity is asked', /QUANTITY/.test(await prompt()), await prompt());
await scan('F01A002');
check('A bin scanned into the quantity is refused, naming it', /That is a bin, not a quantity/.test(await said()) && /typed, not scanned/.test(await said()) && /QUANTITY/.test(await prompt()), await said());
await scan('P-100');
check('…and so is the pallet label', /That is a pallet label, not a quantity/.test(await said()), await said());
await scan('40');

/* a bin or pallet where the lot goes */
check('Then the lot', /LOT/.test(await prompt()), await prompt());
await scan('F01A001');
check('A bin scanned at the lot step is refused', /F01A001 is a bin, not a lot/.test(await said()) && /LOT/.test(await prompt()), await said());
await scan('P-100');
check('…and the pallet\'s own label too', /P-100 is a pallet label, not a lot/.test(await said()), await said());
await scan('L-9');

/* a pallet where the bin goes */
check('Then the bin', /BIN/.test(await prompt()), await prompt());
await scan('P-100');
check('The pallet just scanned, scanned again at the bin step, is named as such', /P-100 is a pallet label, not a bin/.test(await said()) && /pallet you just scanned/.test(await said()) && /BIN/.test(await prompt()), await said());
await scan('P-200');
check('…and so is another pallet from the report', /P-200 is a pallet label, not a bin/.test(await said()), await said());
await scan('F01A001');
await gun.waitForTimeout(800);
check('The right bin finishes the line and the gun is back at the pallet', /PALLET/.test(await prompt()), await prompt());
await gun.waitForTimeout(1500);
const lines = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text();
check('One line reached the server, with the right pallet, quantity and bin; nothing from the refused scans', lines.trim().split('\n').length === 2 && /P-100/.test(lines) && /F01A001/.test(lines) && !/P-200/.test(lines), `${lines.trim().split('\n').length - 1} line(s)`);

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
