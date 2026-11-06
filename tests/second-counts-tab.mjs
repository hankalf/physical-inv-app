/*
 * Dashboard → Second counts, found and worked in bulk. Every row says where
 * the bin is (aisle, level, which face of the racking) and what the pallet
 * is (item, variant). The page searches over all of it, filters by state,
 * round, face, reason, aisle, level, team and variant, sorts on any column,
 * and ticks rows so one change - hand to a team, mark done, reopen, third
 * count, remove - goes to all of them at once.
 */
import { chromium } from 'playwright-core';
import { inflateRawSync } from 'node:zlib';
import { signIn, pickSession, expandSubTabs } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p) => j(await fetch(BASE + p, { headers: A }));
const post = async (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });
const pj = async (p, b = {}) => j(await post(p, b));

const S = (await pj('/api/admin/sessions', { name: 'Second counts tab' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\nF01B004,Freezer,F01\nF02A001,Freezer,F02\nREC,Floor,REC\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Variant,Qty,Location\nP1,SKU-A,Chicken breast,DIST,40,F01A001\nP2,SKU-B,Peas,REWORK,96,F01A002\nP3,SKU-A,Chicken breast,DIST,40,F01A003\nP5,SKU-C,Mango chunks,,8,F02A001\n' });
const mk = async (bin, palletId, note, team) => (await pj(`/api/admin/sessions/${S}/recounts`, { bin, palletId, note, team })).id;
const r1 = await mk('F01A001', 'P1', 'spot check one', '');
const r2 = await mk('F01A002', 'P2', 'spot check two', '');
const r3 = await mk('F01A003', 'P3', 'spot check three', '5');
const r4 = await mk('F01B004', '', 'empty spot', '5');
const r5 = await mk('F02A001', 'P5', 'the mango', '');
const r6 = await mk('REC', '', 'floor', '');

/* ---------------- what each row carries ---------------- */
let rows = await get(`/api/admin/sessions/${S}/recounts`);
const by = (id) => rows.find((r) => r.id === id);
check('Each row says where the bin is: aisle, level, position and which face of the racking', by(r1).aisle === 'F01' && by(r1).level === 'A' && by(r1).position === 1 && by(r1).face === 'Front' && by(r2).face === 'Back' && by(r4).level === 'B' && by(r4).face === 'Back' && by(r5).aisle === 'F02', JSON.stringify([by(r1).face, by(r2).face, by(r4).level]));
check('…a floor bin has no level, no position and no face', by(r6).aisle === 'REC' && by(r6).level === '' && by(r6).position === null && by(r6).face === '');
check('…and what the pallet is: item, description, the report\'s variant and quantity', by(r1).sku === 'SKU-A' && by(r1).description === 'Chicken breast' && by(r1).variant === 'DIST' && by(r2).variant === 'REWORK' && by(r5).variant === '' && Number(by(r2).expected_qty) === 96, JSON.stringify([by(r1).sku, by(r1).variant, by(r2).expected_qty]));

/* ---------------- one change for many ---------------- */
let out = await pj(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [r1, r2, r5], action: 'assign', team: '7' });
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('Bulk: hand three to team 7', out.changed === 3 && !out.skipped.length && [r1, r2, r5].every((id) => by(id).team === '7'), JSON.stringify(out));
out = await pj(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [r1, r2], action: 'assign', team: '' });
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('…and two of them back to any team', out.changed === 2 && !by(r1).team && !by(r2).team && by(r5).team === '7');
out = await pj(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [r3, r4], action: 'done' });
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('Bulk: mark two done', out.changed === 2 && by(r3).status === 'done' && by(r4).status === 'done');
out = await pj(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [r3, r1], action: 'assign', team: '9' });
check('…a done one is left alone and says so, the open one is handed', out.changed === 1 && out.skipped.length === 1 && out.skipped[0].id === r3 && /already done/.test(out.skipped[0].why), JSON.stringify(out.skipped));
out = await pj(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [r4], action: 'reopen' });
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('Bulk: reopen', out.changed === 1 && by(r4).status === 'open');
out = await pj(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [r3, r4], action: 'third' });
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('Bulk: a third count on the finished one, the open one refused with why', out.changed === 1 && out.skipped.length === 1 && /not finished/.test(out.skipped[0].why) && rows.some((r) => r.parent_id === r3 && Number(r.round) === 3), JSON.stringify(out));
out = await pj(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [r6], action: 'delete' });
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('Bulk: remove', out.changed === 1 && !by(r6));
const bad = await post(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [], action: 'done' });
check('Nothing ticked is refused', bad.status === 400);
check('A nonsense action is refused', (await post(`/api/admin/sessions/${S}/recounts/bulk`, { ids: [r1], action: 'launch' })).status === 400);

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/admin#second`);
await signIn(page);
await page.addStyleTag({ content: '[data-sub] { display: block !important; }' });
await pickSession(page, S);
await page.waitForSelector('#recountTable tr[data-recount]', { timeout: 10000 }); await page.waitForTimeout(400);
const shownBins = () => page.$$eval('#recountTable tbody tr[data-recount]', (trs) => trs.map((tr) => tr.children[1].textContent.trim()));
const count = async () => (await shownBins()).length;
check('Every second count shows, with its aisle, level, face, item and variant columns', (await count()) === 6 && (await page.$$eval('#recountTable thead th', (t) => t.map((x) => x.textContent.trim()))).join('|').includes('Bin|Aisle|Lvl|Face|Pallet|Item|Variant|Reason'), (await page.$$eval('#recountTable thead th', (t) => t.map((x) => x.textContent.trim()))).join('|'));
check('…the reasons as chips with how many, the aisles, levels, teams and variants as boxes', /MANUAL\s*6/.test(clean(await page.textContent('#recReasons'))) && /F01 \(5\)/.test(clean(await page.textContent('#fRecAisleFilter'))) && /Level B \(1\)/.test(clean(await page.textContent('#fRecLevelFilter'))) && /Team 7 \(1\)/.test(clean(await page.textContent('#fRecTeamFilter'))) && /DIST \(3\)/.test(clean(await page.textContent('#fRecVariantFilter'))), [clean(await page.textContent('#fRecAisleFilter')), clean(await page.textContent('#fRecVariantFilter'))].join(' | '));
check('…and the two faces of the racking as a switch', (await page.$$eval('#recFace button', (b) => b.map((x) => x.textContent))).join() === 'Back,Front,Both');

/* by team: a card a team with its bar, and the pool */
check('By team: a card for each team with second counts, saying done, started and to do, and one for the pool', await page.isVisible('#recTeams') && (await page.locator('#recTeams .rt-card[data-rec-team]').count()) >= 3 && /0 of 1 done · 1 to do/.test(clean(await page.textContent('#recTeams .rt-card[data-rec-team="7"]'))) && /waiting for a team/.test(clean(await page.textContent('#recTeams .rt-card[data-rec-team="~none"]'))) && /By team · \d+ of 6 done/.test(clean(await page.textContent('#recTeams .rt-head'))), clean(await page.textContent('#recTeams')).slice(0, 240));
await page.click('#recTeams .rt-card[data-rec-team="7"]'); await page.waitForTimeout(250);
check('…click a team: only its rows, the card lit, the team box set', (await shownBins()).join() === 'F02A001' && (await page.$eval('#recTeams .rt-card[data-rec-team="7"]', (c) => c.classList.contains('selected'))) && (await page.inputValue('#fRecTeamFilter')) === '7');
await page.click('#recTeams .rt-card[data-rec-team="7"]'); await page.waitForTimeout(250);
check('…click it again: every row back', (await count()) === 6 && (await page.inputValue('#fRecTeamFilter')) === '');

/* search */
await page.fill('#fRecSearch', 'mango'); await page.waitForTimeout(250);
check('Search by description: one row', (await shownBins()).join() === 'F02A001' && /1 of 6/.test(clean(await page.textContent('#recShown'))), (await shownBins()).join());
await page.fill('#fRecSearch', 'P2'); await page.waitForTimeout(250);
check('Search by pallet', (await shownBins()).join() === 'F01A002');
await page.fill('#fRecSearch', 'spot check'); await page.waitForTimeout(250);
check('Search by the note: the three spot checks', (await count()) === 3);
await page.fill('#fRecSearch', ''); await page.waitForTimeout(250);

/* filters */
await page.click('#recFace button[data-face="Back"]'); await page.waitForTimeout(200);
check('Back face only: the even positions', (await shownBins()).sort().join() === 'F01A002,F01B004', (await shownBins()).join());
await page.click('#recFace button[data-face=""]'); await page.waitForTimeout(200);
await page.click('#recState button[data-state="done"]'); await page.waitForTimeout(200);
check('Done only', (await shownBins()).join() === 'F01A003');
await page.click('#recState button[data-state="all"]'); await page.waitForTimeout(200);
await page.click('#recRound button[data-round="3"]'); await page.waitForTimeout(200);
check('Third counts only: the one raised, marked 3rd count', (await count()) === 1 && /3rd count · MANUAL/.test(clean(await page.textContent('#recountTable tbody'))));
await page.click('#recRound button[data-round="all"]'); await page.waitForTimeout(200);
await page.selectOption('#fRecLevelFilter', 'B'); await page.waitForTimeout(200);
check('Level B only', (await shownBins()).join() === 'F01B004');
await page.selectOption('#fRecLevelFilter', ''); await page.waitForTimeout(200);
await page.selectOption('#fRecTeamFilter', '~none'); await page.waitForTimeout(200);
check('Nobody yet: the ones no team has - F01A002 and the third count of F01A003', (await shownBins()).sort().join() === 'F01A002,F01A003', (await shownBins()).join());
await page.selectOption('#fRecTeamFilter', '7'); await page.waitForTimeout(200);
check('Team 7: the one handed to it', (await shownBins()).join() === 'F02A001');
await page.selectOption('#fRecTeamFilter', ''); await page.waitForTimeout(200);
await page.selectOption('#fRecVariantFilter', 'REWORK'); await page.waitForTimeout(200);
check('Variant REWORK only', (await shownBins()).join() === 'F01A002');
await page.selectOption('#fRecVariantFilter', ''); await page.waitForTimeout(200);
await page.click('#recReasons button[data-reason="MANUAL"]'); await page.waitForTimeout(200);
check('A reason chip: the manual ones (the third count has the same reason, so 6)', (await count()) === 6);
await page.click('#btnRecClear'); await page.waitForTimeout(200);
check('Clear: every filter off', (await count()) === 6 && !(await page.$('#recReasons .chip-btn.selected')) && /^6$/.test(clean(await page.textContent('#recShown'))));

/* sort */
await page.click('#recountTable thead th[data-sort="bin"]'); await page.waitForTimeout(200);
check('Click Bin: sorted by bin', (await shownBins()).join() === 'F01A001,F01A002,F01A003,F01A003,F01B004,F02A001', (await shownBins()).join());
await page.click('#recountTable thead th[data-sort="bin"]'); await page.waitForTimeout(200);
check('…again: reversed, marked ▼', (await shownBins())[0] === 'F02A001' && (await page.$eval('#recountTable thead th[data-sort="bin"]', (th) => th.classList.contains('desc'))));
await page.click('#recountTable thead th[data-sort="team"]'); await page.waitForTimeout(200);
check('Sort by team: the ones with nobody first, team 9 last', (await page.$$eval('#recountTable tbody tr[data-recount] td:nth-child(13) input', (i) => i.map((x) => x.value))).join() === ',,5,5,7,9', (await page.$$eval('#recountTable tbody tr[data-recount] td:nth-child(13) input', (i) => i.map((x) => x.value))).join());

/* tick and act */
check('Nothing ticked: no bulk bar', await page.isHidden('#recBulk'));
await page.click('#recFace button[data-face="Front"]'); await page.waitForTimeout(200);
await page.click('#recPickAll'); await page.waitForTimeout(200);
check('Tick every row shown (the Front face, four rows): the bar says 4 selected', await page.isVisible('#recBulk') && /4 selected/.test(clean(await page.textContent('#recBulkN'))), clean(await page.textContent('#recBulkN')));
await page.fill('#fBulkTeam', '8'); await page.click('#btnBulkAssign'); await page.waitForTimeout(900);
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('Hand over: the three open Front-face ones go to team 8, the done one is left and said so', /3 second counts handed to team 8/.test(clean(await page.textContent('#recountMsg'))) && /F01A003 \(already done\)/.test(clean(await page.textContent('#recountMsg'))) && by(r1).team === '8' && by(r5).team === '8' && by(r3).team === '5', clean(await page.textContent('#recountMsg')).slice(0, 140));
check('…the bar goes once nothing is ticked', await page.isHidden('#recBulk'));
await page.click('#btnRecClear'); await page.waitForTimeout(200);
await page.click(`#recountTable tr[data-recount="${r2}"] input[data-pick]`); await page.click(`#recountTable tr[data-recount="${r4}"] input[data-pick]`); await page.waitForTimeout(200);
check('Tick two by hand: 2 selected, the rows lit', /2 selected/.test(clean(await page.textContent('#recBulkN'))) && (await page.$$eval('#recountTable tr.picked', (t) => t.length)) === 2);
await page.click('#btnBulkDone'); await page.waitForTimeout(900);
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('Mark done: both done, with a confirm first', /2 second counts marked done/.test(clean(await page.textContent('#recountMsg'))) && by(r2).status === 'done' && by(r4).status === 'done');
const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('#recState button[data-state="done"]'); await page.waitForTimeout(200); await page.click(`#recountTable tr[data-recount="${r2}"] input[data-pick]`); await page.click('#btnBulkExport'); })()]);
check('Shown as CSV: a file of the rows on screen', /second-counts-shown/.test(dl.suggestedFilename()));
check('The 3rd count button still sits on a finished second count with none', (await page.locator(`#recountTable button[data-third="${r2}"]`).count()) === 1);

/* ---------------- the team box, the hover, the popover ---------------- */
await page.click('#btnRecClear'); await page.waitForTimeout(200);
const box = `#recountTable tr[data-recount="${r5}"] input[data-team-for]`;
await page.click(box); await page.fill(box, '12');
await page.waitForTimeout(31000);   // the dashboard redraws every 30 seconds: the box must come through it
check('A team half typed survives the 30-second redraw of the table: still 12, still in the box', (await page.inputValue(box)) === '12' && (await page.evaluate(() => document.activeElement && document.activeElement.dataset.teamFor)) === String(r5), await page.inputValue(box));
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('…and nothing is saved until the box is left', by(r5).team === '8', by(r5).team);
await page.keyboard.press('Tab'); await page.waitForTimeout(700);
rows = await get(`/api/admin/sessions/${S}/recounts`);
check('Click away (Tab): saved to team 12, said so', by(r5).team === '12' && /F02A001 handed to team 12/.test(clean(await page.textContent('#recountMsg'))), clean(await page.textContent('#recountMsg')));
await page.click('#recRound button[data-round="all"]'); await page.waitForTimeout(300);
check('…and a later redraw shows 12, not the old value', (await page.inputValue(box)) === '12', await page.inputValue(box));
await page.hover(`#recountTable tr[data-recount="${r5}"] td[data-full]`); await page.waitForTimeout(300);
check('Hover a cramped cell: a popover with the whole text and a Copy button', await page.isVisible('#cellPop') && /SKU-C — Mango chunks/.test(clean(await page.textContent('#cellPop .cp-text'))) && await page.isVisible('#cellPop button'), clean(await page.textContent('#cellPop')));
await page.click('#cellPop button'); await page.waitForTimeout(200);
check('…Copy says what it did', /Copied|Select and copy/.test(clean(await page.textContent('#cellPop button'))), clean(await page.textContent('#cellPop button')));
await page.mouse.move(5, 5); await page.waitForTimeout(500);
check('…and it goes when the pointer leaves', await page.isHidden('#cellPop'));
check('The row under the pointer is highlighted (a hover rule on the table rows)', await page.evaluate(() => [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => /#recountTable tbody tr:hover/.test(r.selectorText || '')); } catch { return false; } })));

/* ---------------- the workbook by aisle, with the heat map ---------------- */
const xr = await fetch(`${BASE}/api/admin/sessions/${S}/export/second-counts.xlsx`, { headers: A });
const xbuf = Buffer.from(await xr.arrayBuffer());
const parts = {};
{ let off = 0; while (off < xbuf.length && xbuf.readUInt32LE(off) === 0x04034b50) { const nlen = xbuf.readUInt16LE(off + 26), elen = xbuf.readUInt16LE(off + 28), clen = xbuf.readUInt32LE(off + 18); const name = xbuf.toString('utf8', off + 30, off + 30 + nlen); parts[name] = inflateRawSync(xbuf.subarray(off + 30 + nlen + elen, off + 30 + nlen + elen + clen)).toString('utf8'); off += 30 + nlen + elen + clen; } }
const cellsOf = (xml) => Object.fromEntries([...xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>(.*?)<\/c>)/g)].map((m) => [m[1], (m[2] || '').replace(/<[^>]+>/g, '')]));
check('The workbook downloads as an .xlsx with three sheets: By aisle, Heat map, Second counts', xr.status === 200 && /second-counts-by-aisle/.test(xr.headers.get('content-disposition')) && (parts['xl/workbook.xml'] || '').includes('name="By aisle"') && parts['xl/workbook.xml'].includes('name="Heat map"') && parts['xl/workbook.xml'].includes('name="Second counts"'), Object.keys(parts).join());
const s1 = cellsOf(parts['xl/worksheets/sheet1.xml'] || '');
const aisleRow = Object.entries(s1).find(([k, v]) => /^A\d+$/.test(k) && v === 'F01')?.[0]?.slice(1);
check('By aisle: one row an aisle with its bins, second counts, open, started, done, by reason, and who holds the open ones', aisleRow && s1[`C${aisleRow}`] === '4' && s1[`D${aisleRow}`] === '5' && s1[`E${aisleRow}`] === '2' && s1['H1'] === 'Manual' && Object.values(s1).includes('Every aisle'), JSON.stringify([s1[`C${aisleRow}`], s1[`D${aisleRow}`], s1[`E${aisleRow}`], s1[`G${aisleRow}`]]));
const s2 = cellsOf(parts['xl/worksheets/sheet2.xml'] || '');
check('Heat map: aisles down, levels across, the open ones then all of them', Object.values(s2).includes('Level A') && Object.values(s2).includes('Level B') && Object.values(s2).some((v) => /^OPEN second counts/.test(v)) && Object.values(s2).some((v) => /^ALL second counts/.test(v)) && Object.values(s2).includes('F02'));
check('…shaded: the styles carry solid fills in the heat colours, and the grid cells use them', (parts['xl/styles.xml'].match(/patternType="solid"/g) || []).length >= 3 && /FFFFF3E0|FFFFE0B2|FFFFCC80|FFFFB74D|FFFF9800|FFF57C00|FFE65100/.test(parts['xl/styles.xml']) && (parts['xl/worksheets/sheet2.xml'].match(/ s="\d+"/g) || []).length > 10);
const s3 = cellsOf(parts['xl/worksheets/sheet3.xml'] || '');
check('Second counts: the clean list aisle by aisle, bin by bin, with aisle, level, face, state, pallet, item, variant', s3['A1'] === 'Aisle' && s3['B1'] === 'Bin' && s3['D1'] === 'Face' && s3['L1'] === 'Variant' && s3['A2'] === 'F01' && s3['B2'] === 'F01A001' && s3['D2'] === 'Front' && s3['L2'] === 'DIST' && s3['B3'] === 'F01A002', JSON.stringify([s3['A2'], s3['B2'], s3['B3'], s3['B4']]));
check('…and it opens in Excel-type software: sheet data, styles, the two files that name them all', ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml'].every((k) => parts[k]));
const [xdl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportRecountsXlsx')]);
check('The button on the tab downloads it', /second-counts-by-aisle/.test(xdl.suggestedFilename()), xdl.suggestedFilename());
/* ---------------- handing out, and the results ---------------- */
{
  await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A005,Freezer,F01\nF01A006,Freezer,F01\nF02A003,Freezer,F02\nF02A004,Freezer,F02\n' });
  const r7 = await mk('F01A005', '', 'hand-out one', '');
  const r8 = await mk('F02A003', '', 'hand-out two', '');
  const r9 = await mk('F01A006', '', 'hand-out three', '');
  const ho = await pj(`/api/admin/sessions/${S}/recounts/hand-out`, { teams: '21, 22' });
  rows = await get(`/api/admin/sessions/${S}/recounts`);
  check('Hand out: the open ones nobody has go to the teams named, whole aisles to one team - F01 (two) to team 21, then F02 to the less loaded team 22', ho.assigned === 3 && !ho.left && by(r7).team === '21' && by(r9).team === '21' && by(r8).team === '22' && ho.aisles[0].aisle === 'F01', JSON.stringify(ho));
  check('…and the log says who got what', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'handed the open second counts out by aisle'));
  check('No teams named: refused', (await post(`/api/admin/sessions/${S}/recounts/hand-out`, { teams: '' })).status === 400);
  const res = await get(`/api/admin/sessions/${S}/recounts/results`);
  check('Results: how the finished bins came out, and per team', res.done >= 2 && typeof res.byFirst === 'number' && res.byTeam && Object.keys(res.byTeam).length >= 1, JSON.stringify(res));
  await page.waitForTimeout(600);
  await page.reload(); await page.waitForSelector('#recountTable tr[data-recount]'); await page.waitForTimeout(600);
  check('The tab: the Results line reads, and Hand out is away once every open one has a team', /Results · \d+ bins? finished/.test(clean(await page.textContent('#recResults'))) && await page.isHidden('#recHandout'), clean(await page.textContent('#recResults')));
  const r10 = await mk('F02A004', '', 'in the pool', '');
  await page.reload(); await page.waitForSelector('#recHandout:not([hidden])', { timeout: 10000 }); await page.waitForTimeout(400);
  check('…a new one with no team brings Hand out back: a row for its aisle, with a team box and Give', (await page.locator('#recHandTable tr[data-hand-aisle="F02"]').count()) === 1 && /1 open second count nobody has yet/.test(clean(await page.textContent('#recHandoutSub'))), clean(await page.textContent('#recHandoutSub')));
  await page.fill('#recHandTable input[data-hand-team="F02"]', '22'); await page.press('#recHandTable input[data-hand-team="F02"]', 'Enter'); await page.waitForTimeout(1000);
  rows = await get(`/api/admin/sessions/${S}/recounts`);
  check('Give: that aisle\'s open ones go to the team, and the row is gone', by(r10).team === '22' && /handed to team 22/.test(clean(await page.textContent('#recHandMsg'))), clean(await page.textContent('#recHandMsg')));
  await page.click('#btnRecClear'); await page.waitForTimeout(200);
}

check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
