/*
 * What changed on the gun for the floor:
 *
 *   - a blind count: the gun is never told what is on a pallet;
 *   - a pallet not on the list is one question, YES or NO, and a YES lands with
 *     the office as a pallet to add;
 *   - a run of empty bins is marked in one go;
 *   - English and Spanish, switched on the gun and kept.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) })).json()).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p, h = A) => (await fetch(BASE + p, { headers: h })).json();
const post = async (p, body = {}, h = A) => (await fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) })).json();

const sess = await post('/api/admin/sessions', { name: 'Floor test' });
const bins = ['F01A001', 'F01A002', 'F01A003', 'F01A004', 'F01A005', 'F01A006', 'F01A007', 'F01A008', 'F02A001'];
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv,
  body: 'Bin Location,Zone,Aisle\n' + bins.map((b) => `${b},Freezer,${b.slice(0, 3)}`).join('\n') + '\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nFL-1,SKU-4120,Chicken breast IQF 40lb,40,F01A001\nFL-2,SKU-2210,Peas petite 12x2lb,30,F01A008\nFL-3,SKU-2240,Sweetcorn 20lb,20,F02A001\n' });
await post(`/api/admin/sessions/${sess.id}/settings`, { guided: false, askLot: false, askExpiry: false });
const dev = await post('/api/admin/devices', { name: 'FLOOR-01' });

/* ---------------- blind count: what the gun is sent ---------------- */
const dev2 = await post('/api/admin/devices', { name: 'FLOOR-02' });
const D2 = { ...hdr, authorization: 'Device ' + (await post(`/api/devices/${dev2.uid}`, {}, hdr)).token };
const master = await get(`/api/sessions/${sess.id}/master`, D2);
const fl1 = master.pallets.find((p) => p[0] === 'FL-1');
check('The gun is never sent what is on a pallet', fl1 && fl1[1] === '' && fl1[2] === '', JSON.stringify(fl1));
check('…only where it should be', fl1 && fl1[3] === 'F01A001');
check('Nor any expected quantity', !JSON.stringify(master.pallets).includes('"40"') && !master.pallets.some((p) => p.includes(40)));

/* ---------------- the gun ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
const gun = await ctx.newPage();
const errors = [];
gun.on('pageerror', (e) => errors.push(e.message));
gun.on('dialog', (d) => d.accept().catch(() => {}));
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForTimeout(1500);
await gun.fill('#fTeam', '3'); await gun.press('#fTeam', 'Enter');
await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart');
await gun.waitForSelector('#scrScan.active', { timeout: 8000 });
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
const skip = async () => { if (await gun.isVisible('#btnSkip')) { await gun.click('#btnSkip'); await gun.waitForTimeout(400); } };
const screen = () => gun.evaluate(() => document.querySelector('.screen.active')?.id);

await scan('FL-1');
const afterPallet = clean(await gun.textContent('#scanMsg')) + ' ' + clean(await gun.textContent('#ctx'));
check('Scanning a pallet says which pallet, and nothing of what is on it', /FL-1/.test(afterPallet) && !/Chicken|SKU-4120|40lb/i.test(afterPallet), afterPallet);
await scan('38'); await scan('F01A001'); await skip();
const done1 = clean(await gun.textContent('#scanMsg'));
check('…nor when the line is saved', /Counted FL-1/.test(done1) && !/Chicken/.test(done1), done1);
await wait(2500);
const raw = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text().catch(() => '');
check('The office still gets the SKU on the line, from the report', /FL-1,38,F01A001.*SKU-4120/.test(raw.replace(/"/g, '')) || /SKU-4120/.test(raw), raw.split('\n').find((l) => l.includes('FL-1')));

/* ---------------- a pallet wearing two labels ---------------- */
await scan('FL-3');
check('Right after the pallet scan there is a button for a pallet with another label', await gun.isVisible('#btnMoreLabels'));
await gun.click('#btnMoreLabels');
check('…which asks for the other label before the quantity', /Scan the OTHER label on FL-3/.test(await gun.textContent('#prompt')));
await scan('FL-3');
check('The same label again is refused', /already read/.test(await gun.textContent('#scanMsg')));
await gun.click('#btnMoreLabels');
await scan('FL-3-OLD');
check('The other label is taken, and the gun goes on to the quantity', /FL-3-OLD is the same pallet as FL-3/.test(await gun.textContent('#scanMsg')) && /QUANTITY/.test(await gun.textContent('#prompt')) && /2 labels/.test(await gun.textContent('#scanMsg')), clean(await gun.textContent('#scanMsg')));
check('…and the context shows both labels on the one pallet', /FL-3 \+ FL-3-OLD/.test(await gun.textContent('#ctx')));
await scan('20'); await scan('F02A001'); await skip();
await wait(2500);
const rep3 = (await get(`/api/admin/sessions/${sess.id}/pallets?limit=100`)).rows;
const main3 = rep3.find((r) => r.pallet_id === 'FL-3');
const tag3 = rep3.find((r) => r.pallet_id === 'FL-3-OLD');
check('The pallet counts once, with its other label beside it', main3 && Number(main3.counted_qty) === 20 && main3.also_tagged === 'FL-3-OLD', main3 && `${main3.counted_qty} · ${main3.also_tagged}`);
check('…and the other label is a second label, not an unknown pallet', tag3 && tag3.status === 'SECOND LABEL' && tag3.alias_of === 'FL-3', tag3 && tag3.status);
await scan('FL-3-OLD');
check('Scanning that other label later is caught as already counted', (await screen()) === 'scrOverride' && /already counted/.test(await gun.textContent('#ovWhy')));
await gun.click('#btnOverrideCancel'); await gun.waitForTimeout(300);

/* ---------------- a pallet not on the list ---------------- */
await scan('FOUND-77');
check('A pallet not on the list asks one thing: count it anyway?', (await screen()) === 'scrOverride'
  && clean(await gun.textContent('#ovAsk')) === 'Count it anyway?' && await gun.isVisible('#btnOvYes') && await gun.isVisible('#btnOvNo'));
check('…with no reason to pick and no note to type', await gun.isHidden('#fReason') && await gun.isHidden('#fReasonNote'));
await gun.click('#btnOvNo'); await gun.waitForTimeout(400);
check('NO goes back to scan again, and nothing is counted', (await screen()) === 'scrScan' && /PALLET/.test(await gun.textContent('#prompt')));
await scan('FOUND-77');
await gun.click('#btnOvYes'); await gun.waitForTimeout(400);
check('YES carries on to the quantity', /QUANTITY/.test(await gun.textContent('#prompt')), await gun.textContent('#prompt'));
check('…and says a supervisor will add it', /supervisor will add it/.test(await gun.textContent('#scanMsg')), clean(await gun.textContent('#scanMsg')));
await scan('12'); await scan('F01A002'); await skip();
await wait(2500);
const adj = await get(`/api/admin/sessions/${sess.id}/adjustments/view`);
const found = adj.positive.rows.find((r) => r.pallet_id === 'FOUND-77');
check('It lands on the backend as a positive adjustment — a pallet to add, approvals or not', found && found.kind === 'NOT IN MASTER' && Number(found.variance_qty) === 12,
  found ? `${found.kind} ${found.variance_qty} · ${found.why}` : JSON.stringify(adj).slice(0, 160));
const short = adj.negative.rows.find((r) => r.pallet_id === 'FL-1');
check('…and a pallet counted short is a negative one', short && Number(short.variance_qty) === -2 && /Less than the report/.test(short.why), short && `${short.variance_qty} ${short.why}`);
check('The totals add up: positive, negative and net', adj.positive.units === 12 && adj.negative.units === -2 && adj.net === 10, `${adj.positive.units} / ${adj.negative.units} / ${adj.net}`);

/* other stops still ask why */
await scan('FL-1');
check('A pallet already counted still asks for a reason', (await screen()) === 'scrOverride' && await gun.isVisible('#fReason') && await gun.isHidden('#btnOvYes'));
await gun.click('#btnOverrideCancel'); await gun.waitForTimeout(400);

/* ---------------- a run of empty bins ---------------- */
check('The pallet step offers "several empty bins in a row"', await gun.isVisible('#btnEmptyRun'));
await gun.click('#btnEmptyRun'); await gun.waitForTimeout(300);
check('…which asks for the first empty bin', (await screen()) === 'scrEmptyRun' && /FIRST/.test(await gun.textContent('#erPrompt')));
const er = async (v) => { await gun.fill('#fEmptyScan', v); await gun.press('#fEmptyScan', 'Enter'); await gun.waitForTimeout(350); };
await er('F01A001');
check('…then the last', /LAST/.test(await gun.textContent('#erPrompt')));
await er('F02A001');
check('Two bins in different aisles are refused', /same aisle/.test(await gun.textContent('#erMsg')));
await er('F01A007');
const rows = await gun.$$eval('#erList .errow', (rs) => rs.map((r) => ({ code: r.querySelector('b').textContent, on: r.querySelector('input').checked, done: r.querySelector('input').disabled })));
check('Every bin between them is listed in walking order', rows.map((r) => r.code).join(',') === 'F01A001,F01A002,F01A003,F01A004,F01A005,F01A006,F01A007', rows.map((r) => r.code).join(','));
check('…the ones already counted are shown and left alone', rows[0].done && rows[1].done && !rows[0].on);
check('…the rest ticked', rows.slice(2).every((r) => r.on && !r.done));
await gun.click('#erList .errow:has(b:text("F01A005")) input');
check('Unticking one that is not empty takes it out of the count', clean(await gun.textContent('#btnEmptyRunSave')) === 'Mark 4 bins EMPTY', await gun.textContent('#btnEmptyRunSave'));
await gun.click('#btnEmptyRunSave'); await gun.waitForTimeout(600);
check('One tap records them all', (await screen()) === 'scrScan' && /4 bins recorded as EMPTY/.test(await gun.textContent('#scanMsg')), clean(await gun.textContent('#scanMsg')));
await wait(2500);
const counted = await get(`/api/admin/sessions/${sess.id}/progress`);
check('…each as its own EMPTY line on the server', counted.empty_bins === 4, `${counted.empty_bins} empty`);
const rawAfter = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text().catch(() => '');
check('…and F01A005, unticked, is not one of them', !/EMPTY[^\n]*F01A005|F01A005[^\n]*EMPTY/.test(rawAfter));

/* ---------------- Spanish ---------------- */
check('The header has a language button, offering Spanish', clean(await gun.textContent('#btnLang')) === 'Español');
await gun.click('#btnLang'); await gun.waitForTimeout(300);
check('Tapping it turns the gun to Spanish', clean(await gun.textContent('#prompt')) === 'Escanea la TARIMA', await gun.textContent('#prompt'));
check('…and the button now offers English', clean(await gun.textContent('#btnLang')) === 'English');
const ENGLISH = /\b(the|your|scan|pallet|bin|bins|count|team|sign|tap|this|with|and|refresh|next|empty|label|quantity|history|back|start|aisle|level|position|when|are|is|it|has|have|for|on|of|to|last|or)\b/i;
const leftovers = async () => gun.evaluate((src) => {
  const re = new RegExp(src, 'i');
  const out = [];
  const roots = [document.querySelector('header'), document.querySelector('.screen.active')];
  for (const r of roots) {
    const it = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('[hidden]') || el.closest('[data-no-i18n]') || getComputedStyle(el).display === 'none') continue;
      if (re.test(n.nodeValue)) out.push(n.nodeValue.trim());
    }
    for (const el of r.querySelectorAll('[placeholder]')) if (re.test(el.placeholder)) out.push('placeholder: ' + el.placeholder);
  }
  return out;
}, ENGLISH.source);
let bad = await leftovers();
check('The counting screen has no English left on it', bad.length === 0, bad.join(' | '));
await scan('FL-2');
check('A pallet scan answers in Spanish', /Tarima FL-2/.test(await gun.textContent('#scanMsg')) && /CANTIDAD/.test(await gun.textContent('#prompt')), clean(await gun.textContent('#scanMsg')));
await scan('30');
bad = await leftovers();
check('…so does the bin step', bad.length === 0 && /UBICACIÓN/.test(await gun.textContent('#prompt')), bad.join(' | '));
await scan('F01A008'); await skip();
check('…and the saved line', /Contada FL-2/.test(await gun.textContent('#scanMsg')), clean(await gun.textContent('#scanMsg')));
await scan('NEW-99');
bad = await leftovers();
check('The yes-or-no question is in Spanish', /¿Contarla de todos modos\?/.test(await gun.textContent('#ovAsk')) && clean(await gun.textContent('#btnOvYes')) === 'SÍ' && bad.length === 0, bad.join(' | '));
await gun.click('#btnOvNo'); await gun.waitForTimeout(300);
await gun.click('#btnEmptyRun'); await gun.waitForTimeout(300);
bad = await leftovers();
check('The empty-bin run is in Spanish', /PRIMERA/.test(await gun.textContent('#erPrompt')) && bad.length === 0, bad.join(' | '));
await gun.click('#btnEmptyRunBack'); await gun.waitForTimeout(300);
await gun.click('#btnSos'); await gun.waitForTimeout(500);
bad = await leftovers();
check('The SOS screen, and the shipped reasons, are in Spanish', /¿Qué pasa\?/.test(await gun.textContent('.screen.active'))
  && /Se descompuso el equipo/.test(await gun.textContent('#sosReasons')) && bad.length === 0, bad.join(' | '));
await gun.click('#sosReasons button:has-text("Necesito un supervisor")'); await gun.waitForTimeout(1200);
const alerts = await get(`/api/admin/sessions/${sess.id}/alerts`);
check('…but what reaches the office stays in English', alerts.alerts.some((a) => a.reason === 'Need a supervisor'), alerts.alerts.map((a) => a.reason).join(','));
await gun.click('#btnSosBack').catch(() => {}); await gun.waitForTimeout(300);
await gun.click('#btnHistory'); await gun.waitForTimeout(400);
bad = await leftovers();
check('The history screen is in Spanish', /Conteos recientes/.test(await gun.textContent('.screen.active')) && bad.length === 0, bad.join(' | '));
await gun.click('#btnHistoryBack'); await gun.waitForTimeout(300);

await gun.reload(); await gun.waitForTimeout(1800);
check('The choice survives a restart', clean(await gun.textContent('#btnLang')) === 'English' && /Número de equipo/.test(await gun.textContent('#scrSignon')));
bad = await leftovers();
check('The sign-on screen has no English left on it', bad.length === 0, bad.join(' | '));
await gun.click('#btnLang'); await gun.waitForTimeout(300);
check('And back to English, exactly as it was', /Team number/.test(await gun.textContent('#scrSignon')) && clean(await gun.textContent('#btnLang')) === 'Español');

check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} gun floor checks passed`);
process.exit(failed ? 1 : 0);
