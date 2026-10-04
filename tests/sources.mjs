/* Three systems share one warehouse. Each pallet row carries the system its
   report came from, and the office side keeps them apart: the pallet report,
   adjustments, the ERP file (one per system), exports and search. The scanners
   never see it. */
import { chromium } from 'playwright-core';
import { signIn, pickSession, expandSubTabs } from './helpers.mjs';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'three systems' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location\nF01A001\nF01A002\nF01A003\nF01A004\n' });
/* one report per system: the first names its system on the upload, the second carries a System column, the third names none */
const up1 = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets&source=NAV`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nF11111-111,SKU-1,Strawberry,40,F01A001\nF11111-112,SKU-1,Strawberry,40,F01A002\n' }));
check('An upload can name the system its report came from', up1.pallets === 2 && up1.bySource && up1.bySource.NAV === 2, JSON.stringify(up1.bySource));
const up2 = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location,System\nF22222-111,SKU-2,Blueberry,30,F01A003,WMS\n' }));
check('…or the file can carry a System column', up2.bySource && up2.bySource.WMS === 1, JSON.stringify(up2.bySource));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nF33333-111,SKU-3,Mango,20,F01A004\n' });

const srcs = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/sources`, { headers: A }))).sources;
check('The count lists its systems, with how far each is counted', srcs.map((x) => `${x.source || '(none)'}:${x.pallets}`).join(',') === '(none):1,NAV:2,WMS:1', JSON.stringify(srcs));
const all = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?only=all`, { headers: A }))).rows;
check('Every pallet on the report says which system it is from', all.find((r) => r.pallet_id === 'F11111-111').source === 'NAV' && all.find((r) => r.pallet_id === 'F22222-111').source === 'WMS' && all.find((r) => r.pallet_id === 'F33333-111').source === '');
const nav = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?only=all&source=NAV`, { headers: A }))).rows;
check('The pallet report can be read one system at a time', nav.length === 2 && nav.every((r) => r.source === 'NAV'), `${nav.length} rows`);
const none = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?only=all&source=`, { headers: A }))).rows;
check('…including the rows that named no system', none.length === 1 && none[0].pallet_id === 'F33333-111');

/* a count, so there are adjustments and lines to carry the tag */
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'SRC-01' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: JSON.stringify([
  { clientId: 's1', palletId: 'F11111-111', qty: 36, location: 'F01A001', team: '1', deviceId: 'SRC-01' },
  { clientId: 's2', palletId: 'F22222-111', qty: 30, location: 'F01A003', team: '1', deviceId: 'SRC-01' },
  { clientId: 's3', palletId: 'F33333-111', qty: 25, location: 'F01A004', team: '1', deviceId: 'SRC-01' },
]) });
const view = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/adjustments/view`, { headers: A }));
const adjRows = [...view.positive.rows, ...view.negative.rows];
check('Adjustments carry the system too', adjRows.find((r) => r.pallet_id === 'F11111-111').source === 'NAV' && adjRows.find((r) => r.pallet_id === 'F33333-111').source === '', JSON.stringify(adjRows.map((r) => [r.pallet_id, r.source])));
const prog = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/progress`, { headers: A }));
check('Progress says how far each system is counted', prog.bySource.find((x) => x.source === 'NAV').counted === 1 && prog.bySource.find((x) => x.source === 'WMS').counted === 1, JSON.stringify(prog.bySource));

/* the ERP file: one per system */
const fmt = Object.keys((await j(await fetch(`${BASE}/api/admin/erp/formats`, { headers: A }))).formats)[0];
const whole = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/${fmt}.csv`, { headers: A })).text();
const navFile = await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/${fmt}.csv?source=NAV`, { headers: A });
const navCsv = await navFile.text();
check('The ERP file can be made for one system only', navCsv.includes('F11111-111') && !navCsv.includes('F22222-111') && !navCsv.includes('F33333-111') && whole.includes('F22222-111'), navCsv.split('\n')[1]);
check('…and the file is named for it', /NAV/.test(navFile.headers.get('content-disposition') || ''), navFile.headers.get('content-disposition'));
const prev = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp/${fmt}/preview?source=WMS`, { headers: A }));
check('The preview counts that system\'s rows alone', prev.rows === 1, String(prev.rows));

/* everything else that lists a pallet */
const ev = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/everything`, { headers: A }));
const pal = ev.sheets.find((s) => s.name === 'Pallets');
check('Export everything has a System column on pallets, lines and adjustments',
  pal.columns.includes('System') && pal.rows.find((r) => r.Pallet === 'F22222-111').System === 'WMS'
    && ev.sheets.find((s) => s.name === 'Count lines').columns.includes('System') && ev.sheets.find((s) => s.name === 'Adjustments').columns.includes('System'));
check('…and the summary names the systems', /NAV: 1 of 2 found/.test(ev.sheets[0].rows.find((r) => r.What === 'Systems on the report').Value), ev.sheets[0].rows.find((r) => r.What === 'Systems on the report').Value);
const found = await j(await fetch(`${BASE}/api/admin/search?q=F22222-111&session=${sess.id}`, { headers: A }));
const hit = JSON.stringify(found);
check('Search says which system a pallet belongs to', /system WMS/.test(hit), hit.slice(0, 200));
const gun = await j(await fetch(`${BASE}/api/sessions/${sess.id}/master`, { headers: D }));
check('The scanners get the same list as before — no system on it', JSON.stringify(gun).indexOf('NAV') === -1 && JSON.stringify(gun).indexOf('"source"') === -1);

/* ---------------- in the browser ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForTimeout(1800);
check('Dashboard: progress shows each system', !(await page.$eval('#bySystem', (el) => el.hidden)) && /NAV — pallets found/.test(await page.textContent('#bySystem')), clean(await page.textContent('#bySystem')).slice(0, 120));
check('Dashboard: the pallet report has a System column and a picker', (await page.$$eval('#palletTable th', (th) => th.map((x) => x.textContent))).includes('System') && (await page.$$('#fPalletSource option')).length === 4);
await page.selectOption('#fPalletSource', 'NAV'); await page.waitForTimeout(900);
const shown = await page.$$eval('#palletTable tbody tr', (trs) => trs.map((tr) => tr.textContent));
check('…and picking a system narrows it', shown.length === 2 && shown.every((t) => /NAV/.test(t)), `${shown.length} rows`);
check('Dashboard: adjustments have the picker too', (await page.$$('#fAdjSource option')).length === 4);
/* the filters: read the report here rather than export it */
await page.selectOption('#fPalletSource', ''); await page.uncheck('#fOnlyExceptions'); await page.waitForTimeout(600);
const rowsOf = async () => page.$$eval('#palletTable tbody tr', (trs) => trs.map((tr) => tr.textContent));
check('Pallet report: with matches shown, every pallet is there', (await rowsOf()).length === 4, `${(await rowsOf()).length}`);
await page.check('#fHideMissing'); await page.waitForTimeout(400);
check('…Hide missing drops the pallet nobody has counted', (await rowsOf()).length === 3 && !(await rowsOf()).some((t) => /F11111-112/.test(t)), `${(await rowsOf()).length}`);
await page.uncheck('#fHideMissing'); await page.selectOption('#fPalletStatus', 'QTY VARIANCE'); await page.waitForTimeout(400);
check('…a status picks out just those rows', (await rowsOf()).length === 2 && (await rowsOf()).every((t) => /QTY VARIANCE/.test(t)), `${(await rowsOf()).length}`);
await page.selectOption('#fPalletStatus', ''); await page.fill('#fPalletFind', 'mango'); await page.waitForTimeout(400);
check('…and Find narrows by pallet, SKU or description', (await rowsOf()).length === 1 && /F33333-111/.test((await rowsOf())[0]), `${(await rowsOf()).length}`);
await page.fill('#fPalletFind', ''); await page.fill('#fPalletBin', 'F01A00'); await page.waitForTimeout(400);
check('…an aisle or bin prefix too, with the count of matches shown', (await rowsOf()).length === 4 && /4 row\(s\) match/.test(await page.textContent('#palletNote')), clean(await page.textContent('#palletNote')));
await page.click('#btnPalletClear'); await page.waitForTimeout(400);
check('…and Clear filters is back to the usual view: matches hidden', (await rowsOf()).length === 3 && await page.isChecked('#fOnlyExceptions'));
await page.goto(BASE + '/settings#lists'); await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); await page.waitForTimeout(1200);
await page.selectOption('#fSessionPick', String(sess.id)); await page.waitForTimeout(900);
check('Settings: the inventory report upload asks which system, offering the ones already used', !!(await page.$('#fSource-pallets')) && (await page.$$eval('#sourceList option', (os) => os.map((o) => o.value))).join(',') === 'NAV,WMS');
check('Settings: the ERP card offers one file per system', (await page.$$eval('#fErpSource option', (os) => os.map((o) => o.textContent))).some((t) => /NAV only/.test(t)));
check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} source-system checks passed`);
if (results.some((r) => !r)) process.exitCode = 1;
