/*
 * Floor bins: REC and the staging spots PRYSTG#1 to PRYSTG#16, counted by a
 * team like an aisle. The site's bin list files REC under AREAS (not an aisle)
 * and the layout leaves staging out of the count; the floor list puts them on
 * the count as their own aisles with no levels. Then on the scanners: a team
 * signs on to REC, scans the floor label as the bin and each pallet after it;
 * another walks PRYSTG#1, #2 … #16 in that order, and a rack bin scanned there
 * is "Not your aisle". The plan, the aisle sheet, the readiness check and the
 * count-day checklist all know about them.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { signIn, pickSession, expandSubTabs, openPlanMore } from './helpers.mjs';

const S = new URL('.', import.meta.url).pathname;
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

/* ---------------- the list, and what it means ---------------- */
let fl = await get('/api/admin/floor-bins');
check('Shipped: REC as one bin and PRYSTG#1-16 as sixteen spots in one aisle', fl.areas.length === 2 && fl.areas[0].aisle === 'REC' && fl.areas[0].bins === 1 && fl.areas[1].aisle === 'PRYSTG' && fl.areas[1].bins === 16 && fl.areas[1].first === 'PRYSTG#1' && fl.areas[1].last === 'PRYSTG#16', JSON.stringify(fl.areas.map((a) => [a.aisle, a.bins])));
let bad = await post('/api/admin/floor-bins', { text: 'REC\nPRYSTG#1-16\nREC: again' });
check('A bin on the list twice is refused, naming the line', bad.status === 400 && /line 3: REC is on the list twice/.test((await j(bad)).error));
bad = await post('/api/admin/floor-bins', { text: 'REC\nPRYSTG#16-1' });
check('A run that counts backwards is refused', bad.status === 400 && /runs backwards/.test((await j(bad)).error));

/* ---------------- the site's own bin list, with the layout ---------------- */
const S1 = (await pj('/api/admin/sessions', { name: 'Floor count', layout: 'front-royal' })).id;
const up = await j(await fetch(`${BASE}/api/admin/sessions/${S1}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}fixtures/front-royal-bins.csv`, 'utf8') }));
const aislesBefore = await get(`/api/admin/sessions/${S1}/aisles`);
const rawBins = await (await fetch(`${BASE}/api/admin/sessions/${S1}/export/bins.csv`, { headers: A })).text();
check('The site\'s bin list alone: 28 rack aisles, REC filed under AREAS where no team can be sent, staging left out', up.totals.aisles === 28 && !aislesBefore.some((a) => a.aisle === 'REC' || a.aisle === 'PRYSTG') && /^REC,[^,]*,AREAS,/m.test(rawBins) && !/PRYSTG/.test(rawBins), `${up.totals.aisles} aisles`);
let ready = await get(`/api/admin/readiness?session=${S1}`);
let r = ready.checks.find((c) => /floor bins/i.test(c.title));
check('Ready for count day says the floor bins are not on the count, and where to put them on', r && r.level === 'warn' && /not on the count: REC, PRYSTG/.test(r.title) && r.fix && r.fix.card === 'floorCard', r && r.title);
let cd = await get(`/api/admin/sessions/${S1}/countday`);
let line = cd.phases.flatMap((p) => p.items).find((x) => x.key === 'floor');
check('The count-day checklist has the line, open, saying what is missing', line && !line.done && /not on the count yet: REC, PRYSTG/.test(line.detail) && line.how.length === 3 && line.goto.card === 'floorCard', line && line.detail);

/* put them on */
const put = await pj(`/api/admin/sessions/${S1}/floor-bins`);
check('Put them on this count: REC moves out of AREAS to its own aisle, the 16 staging spots are added', put.aisles.join() === 'REC,PRYSTG' && put.added === 16 && put.moved.length === 1 && /REC \(was under AREAS\)/.test(put.moved[0]), JSON.stringify([put.added, put.moved, put.kept]));
const aisles = await get(`/api/admin/sessions/${S1}/aisles`);
const rec = aisles.find((a) => a.aisle === 'REC'), stg = aisles.find((a) => a.aisle === 'PRYSTG');
check('…both are aisles now: REC with 1 bin, PRYSTG with 16, zone Floor, marked as floor', rec && stg && rec.bins === 1 && stg.bins === 16 && rec.zone === 'FLOOR' && rec.floor === 1 && stg.floor === 1 && aisles.length === 30, `${aisles.length} aisles`);
const binsCsv = await (await fetch(`${BASE}/api/admin/sessions/${S1}/export/bins.csv`, { headers: A })).text();
check('…the loaded bin list has PRYSTG#1 to PRYSTG#16 with no level, and REC under aisle REC', /PRYSTG#1,FLOOR,PRYSTG,,/.test(binsCsv) && /PRYSTG#16,FLOOR,PRYSTG,,/.test(binsCsv) && /^REC,FLOOR,REC,,/m.test(binsCsv));
check('…the other AREAS bins stay where they were', /^SHIP,[^,]*,AREAS,/m.test(binsCsv));
ready = await get(`/api/admin/readiness?session=${S1}`);
r = ready.checks.find((c) => /floor bins/i.test(c.title));
check('Ready for count day: on the count, now nobody is counting them', r && r.level === 'warn' && /Nobody is counting the floor bins: REC, PRYSTG/.test(r.title) && r.fix.page === '/admin', r && r.title);
const again = await pj(`/api/admin/sessions/${S1}/floor-bins`);
check('Pressing it again changes nothing: all 17 already there', again.added === 0 && again.moved.length === 0 && again.kept === 17);

/* a re-upload keeps them */
const re = await j(await fetch(`${BASE}/api/admin/sessions/${S1}/master?kind=bins&replace=1`, { method: 'POST', headers: csv, body: readFileSync(`${S}fixtures/front-royal-bins.csv`, 'utf8') }));
check('A Replace upload of the bin list puts the floor bins straight back', re.floor && re.floor.aisles.join() === 'REC,PRYSTG' && re.totals.aisles === 30 && (await get(`/api/admin/sessions/${S1}/aisles`)).some((a) => a.aisle === 'PRYSTG' && a.bins === 16), JSON.stringify(re.floor && [re.floor.added, re.floor.moved.length]));
const S2 = (await pj('/api/admin/sessions', { name: 'Plain count' })).id;
await fetch(`${BASE}/api/admin/sessions/${S2}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nK01A001,Dry,K01\n' });
check('A count that never had them put on is left alone by an upload', (await get(`/api/admin/sessions/${S2}/aisles`)).length === 1);

/* ---------------- the plan ---------------- */
await pj('/api/admin/people/teams', { name: 'S1-DS07', shift: '1' });
await pj('/api/admin/people/employees', { badge: 'FL1', name: 'Flo Reyes', shift: '1', equipment: ['DOCK TRUCK'] });
await pj('/api/admin/people/assign', { badge: 'FL1', teamId: (await get('/api/admin/people')).teams.find((t) => t.name === 'S1-DS07').id });
let q = await post(`/api/admin/sessions/${S1}/assignments`, { team: 'S1-DS07', aisles: 'REC', levels: '' });
let qj = await j(q);
check('Queue REC onto a team with no levels ticked: accepted, as floor', q.status === 200 && qj.added[0] === 'REC (floor)' && qj.activated.some((a) => a.aisle === 'REC'), JSON.stringify(qj).slice(0, 120));
q = await post(`/api/admin/sessions/${S1}/assignments`, { team: 'S1-DS07', aisles: 'F01', levels: '' });
check('A rack aisle still needs its levels', q.status === 400 && /levels required/.test((await j(q)).error));
q = await post(`/api/admin/sessions/${S1}/assignments`, { team: '8', aisles: 'PRYSTG', levels: 'A-B' });
qj = await j(q);
check('Queue PRYSTG with levels ticked anyway: stored with none, any team reaches it', q.status === 200 && qj.added[0] === 'PRYSTG (floor)' && (await get(`/api/admin/sessions/${S1}/assignments`)).find((a) => a.aisle === 'PRYSTG').levels === '');
const dev0 = await pj('/api/admin/devices', { name: 'FLOOR-00' });
const G = { authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev0.uid}`, { method: 'POST' }))).token };
const st = await j(await fetch(`${BASE}/api/sessions/${S1}/team-status?team=8`, { headers: G }));
check('The team\'s walk: PRYSTG#1, #2 … #9, #10 … #16 in the order the numbers read, and the aisle is marked floor', st.active && st.active.floor === true && st.bins.join(',') === Array.from({ length: 16 }, (_, i) => `PRYSTG#${i + 1}`).join(','), st.bins.slice(0, 12).join(','));
const plan = await (await fetch(`${BASE}/api/admin/sessions/${S1}/export/plan.csv`, { headers: A })).text();
check('The plan file has the floor rows with blank levels', /S1-DS07,REC,,,001 end/.test(plan) && /8,PRYSTG,,,001 end/.test(plan), plan.split('\n').filter((l) => /REC|PRYSTG/.test(l)).join(' | '));
const planUp = await j(await fetch(`${BASE}/api/admin/sessions/${S1}/plan?replace=1`, { method: 'POST', headers: csv, body: 'Team,Aisle,Levels\n9,PRYSTG,\n9,F02,\n' }));
check('…and a plan upload takes a floor row with no levels, while a rack row without them is still skipped', planUp.planned === 1 && planUp.skipped === 1 && planUp.skippedNoLevels === 1, JSON.stringify([planUp.planned, planUp.skipped]));
await fetch(`${BASE}/api/admin/sessions/${S1}/plan?replace=1`, { method: 'POST', headers: csv, body: 'Team,Aisle,Levels\nS1-DS07,REC,\n8,PRYSTG,\n' });
ready = await get(`/api/admin/readiness?session=${S1}`);
r = ready.checks.find((c) => /floor bins/i.test(c.title));
check('Ready for count day: the floor bins are on the count and with a team', r && r.level === 'ok', r && r.title);
cd = await get(`/api/admin/sessions/${S1}/countday`);
line = cd.phases.flatMap((p) => p.items).find((x) => x.key === 'floor');
check('…the checklist line ticks itself and names the teams', line.done && /REC: team S1-DS07/.test(line.detail) && /PRYSTG: team 8/.test(line.detail), line.detail);
const sheet = await (await fetch(`${BASE}/api/admin/sessions/${S1}/export/aisle-sheet.csv?plan=1`, { headers: A })).text();
check('The aisle sheet lists REC and PRYSTG, zone Floor, no levels, with their teams', /^REC,FLOOR,,1,,S1-DS07/m.test(sheet) && /^PRYSTG,FLOOR,,16,,8/m.test(sheet), sheet.split('\n').filter((l) => /^(REC|PRYSTG),/.test(l)).join(' | '));
const labelsRes = await fetch(`${BASE}/api/admin/sessions/${S1}/print/floor-labels?t=${encodeURIComponent(tok)}`);
const labels = await labelsRes.text();
check('Floor bin labels print: 17 big Code 128 labels, PRYSTG spots numbered 1 of 16 to 16 of 16', labelsRes.status === 200 && (labels.match(/class="label"/g) || []).length === 17 && (labels.match(/<svg/g) || []).length === 17 && /PRYSTG · 16 OF 16/.test(labels) && />REC</.test(labels) && />PRYSTG#7</.test(labels), `${labelsRes.status} ${labels.slice(0, 160)}`);

/* ---------------- on the scanners ---------------- */
await fetch(`${BASE}/api/admin/sessions/${S1}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,UOM,Qty,Location\nFLR-001,SKU-7,Floor pallet one,CS,30,REC\nFLR-002,SKU-7,Floor pallet two,CS,30,REC\nSTG-001,SKU-9,Staged order,CS,12,PRYSTG#1\nSTG-010,SKU-9,Staged order,CS,12,PRYSTG#10\n' });
await pj(`/api/admin/sessions/${S1}/settings`, { guided: true, askComments: false, palletMode: 'off' });
await pj('/api/admin/default-session', { sessionId: S1 });
const d1 = await pj('/api/admin/devices', { name: 'FLOOR-01' });
const d2 = await pj('/api/admin/devices', { name: 'FLOOR-02' });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const newGun = async (uid, team, badge) => {
  const gun = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
  gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
  gun.on('dialog', (d) => d.accept());
  await gun.goto(`${BASE}/?d=${uid}`);
  await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(600);
  await gun.selectOption('#fSession', String(S1)).catch(() => {});
  await gun.fill('#fTeam', team);
  await gun.fill('#fEmployee', badge); await gun.press('#fEmployee', 'Enter');
  await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active', { timeout: 90000 }); await gun.waitForTimeout(500);
  return gun;
};
const scanOn = (gun) => async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(450); };
const nextCode = async (gun) => (await gun.$eval('#nextBin .nb-code', (el) => el.textContent.trim()).catch(() => ''));

/* team S1-DS07: the receiving floor */
const g1 = await newGun(d1.uid, 'S1-DS07', 'FL1');
const assign1 = clean(await g1.textContent('#assignCard'));
check('Gun 1: signed on to REC — "floor pallets, count every pallet standing here", 1 bin, no level talk', /REC/.test(assign1) && /floor pallets — count every pallet standing here/.test(assign1) && /0 of 1 bins/.test(assign1) && !/level/i.test(assign1), assign1.slice(0, 140));
check('…the Count button says so too', /Count REC \(floor pallets\)/.test(clean(await g1.textContent('#btnCount'))), clean(await g1.textContent('#btnCount')));
await g1.click('#btnCount'); await g1.waitForSelector('#scrScan.active'); await g1.waitForTimeout(600);
check('Gun 1: the guide points at REC, with nothing about a level or a position', /Next bin\s*REC/.test(clean(await g1.textContent('#nextBin'))) && !/Level|Position/.test(clean(await g1.textContent('#nextBin'))), clean(await g1.textContent('#nextBin')).slice(0, 80));
check('…and the header row says your aisle is REC, floor pallets', /Your aisle\s*REC · floor pallets/.test(clean(await g1.textContent('#ctx'))), clean(await g1.textContent('#ctx')).slice(0, 80));
const s1 = scanOn(g1);
await s1('FLR-001'); await s1('30'); await s1('REC');
check('Gun 1: pallet, quantity, then the REC floor label as the bin — recorded, no override asked', !(await g1.$('#scrOverride.active')) && /Counted FLR-001.*@ REC/.test(clean(await g1.textContent('#scanMsg'))), clean(await g1.textContent('#scanMsg')).slice(0, 80));
const still = clean(await g1.textContent('#nextBin'));
check('…the guide stays in REC: "Still in this bin", 1 of 2 tags the report puts there', /Still in this bin\s*REC/.test(still) && /1 of 2 tags/.test(still), still.slice(0, 90));
await s1('FLR-002'); await s1('30'); await s1('REC');
await g1.waitForTimeout(500);
check('…the second: both tags the report expects are in, so REC is done — "every bin in REC has a count"', /Every bin in REC has a count/.test(clean(await g1.textContent('#nextBin'))), clean(await g1.textContent('#nextBin')).slice(0, 90));
await s1('FLR-EXTRA'); await s1('8'); await s1('REC');
await g1.waitForTimeout(600);
check('…a third pallet the report did not expect still counts into REC, no override asked', !(await g1.$('#scrOverride.active')) && /Counted FLR-EXTRA.*@ REC/.test(clean(await g1.textContent('#scanMsg'))), clean(await g1.textContent('#scanMsg')).slice(0, 80));

/* team 8: the staging spots, in order */
await pj('/api/admin/people/teams', { name: '8', shift: '1' });
await pj('/api/admin/people/employees', { badge: 'FL2', name: 'Stan Diaz', shift: '1', equipment: [] });
await pj('/api/admin/people/assign', { badge: 'FL2', teamId: (await get('/api/admin/people')).teams.find((t) => t.name === '8').id });
const g2 = await newGun(d2.uid, '8', 'FL2');
const assign2 = clean(await g2.textContent('#assignCard'));
check('Gun 2: team 8 on PRYSTG, 16 spots, floor pallets', /PRYSTG/.test(assign2) && /floor pallets/.test(assign2) && /0 of 16 bins/.test(assign2) && /PRYSTG#1\s*PRYSTG#2\s*PRYSTG#3/.test(assign2), assign2.slice(0, 160));
await g2.click('#btnCount'); await g2.waitForSelector('#scrScan.active'); await g2.waitForTimeout(600);
check('Gun 2: first spot PRYSTG#1, 0 of 16', (await nextCode(g2)) === 'PRYSTG#1' && /0 of 16/.test(clean(await g2.textContent('#nextBin'))), clean(await g2.textContent('#nextBin')).slice(0, 80));
const s2 = scanOn(g2);
await s2('STG-001'); await s2('12'); await s2('PRYSTG#1');
check('Gun 2: a bin code with # in it scans and is recorded', /Counted STG-001.*@ PRYSTG#1/.test(clean(await g2.textContent('#scanMsg'))) && !(await g2.$('#scrOverride.active')), clean(await g2.textContent('#scanMsg')).slice(0, 80));
await g2.waitForTimeout(400);
check('…then the guide moves to PRYSTG#2, not PRYSTG#10', (await nextCode(g2)) === 'PRYSTG#2' && /1 of 16/.test(clean(await g2.textContent('#nextBin'))), clean(await g2.textContent('#nextBin')).slice(0, 80));
await s2('STG-010'); await s2('12'); await s2('PRYSTG#10');
check('…counting spot 10 out of order is fine: the guide walks on to 11 and notes the 8 spots passed', !(await g2.$('#scrOverride.active')) && (await nextCode(g2)) === 'PRYSTG#11' && /2 of 16 · 8 passed/.test(clean(await g2.textContent('#nextBin'))), clean(await g2.textContent('#nextBin')).slice(0, 80));
await g2.click('#btnEmpty').catch(() => {}); await g2.waitForTimeout(250); await s2('PRYSTG#2');
check('…an empty staging spot is checked off as empty, and the guide goes on to 3', /PRYSTG#2 recorded as EMPTY/.test(clean(await g2.textContent('#scanMsg'))) && (await nextCode(g2)) === 'PRYSTG#3' && /3 of 16/.test(clean(await g2.textContent('#nextBin'))), clean(await g2.textContent('#scanMsg')).slice(0, 60) + ' | ' + clean(await g2.textContent('#nextBin')).slice(0, 50));
/* a run of empty staging spots: from #3 to #16, the numbers in order, not a dictionary slice */
await g2.click('#btnEmptyRun'); await g2.waitForTimeout(300);
const er = async (v) => { await g2.fill('#fEmptyScan', v); await g2.press('#fEmptyScan', 'Enter'); await g2.waitForTimeout(350); };
await er('PRYSTG#3'); await er('PRYSTG#16');
const erRows = await g2.$$eval('#erList .errow', (rs) => rs.map((r) => ({ code: r.querySelector('b').textContent, on: r.querySelector('input').checked, done: r.querySelector('input').disabled })));
check('Several empty bins in a row, PRYSTG#3 to PRYSTG#16: the fourteen spots between, in number order, #10 already counted', erRows.map((r) => r.code).join(',') === Array.from({ length: 14 }, (_, i) => `PRYSTG#${i + 3}`).join(',') && erRows.find((r) => r.code === 'PRYSTG#10').done && erRows.filter((r) => r.on).length === 13, erRows.map((r) => r.code).join(','));
await g2.click('#btnEmptyRunSave'); await g2.waitForTimeout(800);
check('…one tap marks the 13 empty', /13 bins recorded as EMPTY/.test(clean(await g2.textContent('#scanMsg'))), clean(await g2.textContent('#scanMsg')).slice(0, 60));
await s2('P-RACK'); await s2('4'); await s2('F01A001');
check('Gun 2: a rack bin scanned on the staging team is "Not your aisle"', !!(await g2.$('#scrOverride.active')) && /Not your aisle/.test(clean(await g2.textContent('#ovTitle'))) && /aisle F01.*assigned to aisle PRYSTG/.test(clean(await g2.textContent('#ovWhy'))), clean(await g2.textContent('#ovWhy')).slice(0, 100));
await g2.click('#btnOverrideCancel'); await g2.waitForTimeout(400);
check('No page errors on either scanner', !errors.length, errors.join(' | '));

/* what the office sees */
await g1.waitForTimeout(1500); await g2.waitForTimeout(500);
const counts = await (await fetch(`${BASE}/api/admin/sessions/${S1}/export/counts.csv`, { headers: A })).text();
check('The count lines are in the office under REC and PRYSTG#1 / PRYSTG#10', /FLR-001/.test(counts) && /FLR-EXTRA/.test(counts) && /PRYSTG#1\b/.test(counts) && /PRYSTG#10/.test(counts), counts.split('\n').filter((l) => /FLR|STG/.test(l)).length + ' lines');
const ov = await get(`/api/admin/sessions/${S1}/aisles`);
check('The aisle overview: REC 1 of 1 bins counted, 3 pallets; PRYSTG 16 of 16 (3 counted, 13 empty)', ov.find((a) => a.aisle === 'REC').bins_counted === 1 && ov.find((a) => a.aisle === 'REC').pallets_counted === 3 && ov.find((a) => a.aisle === 'PRYSTG').bins_counted === 16, JSON.stringify(ov.filter((a) => a.floor).map((a) => [a.aisle, a.bins_counted, a.pallets_counted])));

/* ---------------- the pages ---------------- */
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => errors.push('page: ' + e.message));
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/settings#lists`);
await signIn(page);
await pickSession(page, S1);
await page.waitForSelector('#floorTable tr', { timeout: 10000 }); await page.waitForTimeout(400);
const card = clean(await page.textContent('#floorCard'));
check('Settings → Lists & racking → Floor bins: the list, and a row per aisle saying on the count, team, counted', /REC/.test(card) && /PRYSTG\s*16 · PRYSTG#1 to PRYSTG#16/.test(card) && /team S1-DS07/.test(card) && /team 8/.test(card) && /16 of 16/.test(card), card.slice(0, 200));
await page.fill('#fFloorBins', 'REC: Receiving floor\nPRYSTG#1-16: Staged orders\nRETWRK 1-4: Rework');
await page.waitForTimeout(2200);
fl = await get(`/api/admin/floor-bins?session=${S1}`);
check('Type a third line and it saves itself, parsed: RETWRK with 4 spots, not on the count yet', fl.areas.length === 3 && fl.areas[2].aisle === 'RETWRK' && fl.areas[2].bins === 4 && fl.areas[2].onCount === 0 && /Saved/.test(clean(await page.textContent('#floorMsg'))), JSON.stringify(fl.areas.map((a) => [a.aisle, a.bins, a.onCount])));
await page.click('#btnFloorApply'); await page.waitForTimeout(1200);
check('Put them on this count: RETWRK 1 to 4 join, the rest already there', /On the count: REC, PRYSTG, RETWRK/.test(clean(await page.textContent('#floorMsg'))) && /4 added/.test(clean(await page.textContent('#floorMsg'))) && (await get(`/api/admin/sessions/${S1}/aisles`)).some((a) => a.aisle === 'RETWRK' && a.bins === 4), clean(await page.textContent('#floorMsg')).slice(0, 120));

/* the Team plan: quick assign */
await page.goto(`${BASE}/admin#teams`); await page.waitForTimeout(800);
if (await page.isVisible('#fPassword')) await signIn(page); else { await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); }
await openPlanMore(page);
await page.waitForSelector('#qaAisles .qa-aisle', { timeout: 10000 }); await page.waitForTimeout(500);
const floorZone = await page.$$eval('#qaAisles .qa-zone', (zs) => zs.map((z) => z.textContent.replace(/\s+/g, ' ').trim()).find((t) => /^Floor/.test(t)) || '');
check('Quick assign groups PRYSTG, REC and RETWRK under Floor, saying who has them and how many spots', /^Floor\s*PRYSTG\s*team 8 counting\s*REC\s*team S1-DS07 counting\s*RETWRK\s*4 floor spots/.test(floorZone), floorZone);
await page.click('#qaTeams .qa-team[data-team="S1-DS07"]'); await page.waitForTimeout(200);
for (const c of 'ABCDEF') { const b = await page.$(`#qaLevels .lv.selected[data-level="${c}"]`); if (b) await b.click(); }
await page.click('#qaAisles .qa-aisle[data-aisle="RETWRK"]'); await page.waitForTimeout(200);
check('Pick a team and RETWRK with no level ticked: Queue is ready, "floor pallets, no levels"', !(await page.$eval('#btnQuickQueue', (b) => b.disabled)) && /Queue RETWRK for team S1-DS07 · floor pallets, no levels/.test(clean(await page.textContent('#btnQuickQueue'))), clean(await page.textContent('#btnQuickQueue')));
await page.click('#btnQuickQueue'); await page.waitForTimeout(900);
check('…queued as floor', /queued RETWRK \(floor\) for team S1-DS07/.test(clean(await page.textContent('#assignMsg'))), clean(await page.textContent('#assignMsg')).slice(0, 100));
/* taken off the floor list, RETWRK is an ordinary aisle again: its bins stay, levels are asked for */
await post('/api/admin/floor-bins', { text: 'REC: Receiving floor\nPRYSTG#1-16: Staged orders' });
const after = await get(`/api/admin/sessions/${S1}/aisles`);
check('Take RETWRK off the list: its bins stay on the count, but it is no longer floor', after.some((a) => a.aisle === 'RETWRK' && a.bins === 4 && a.floor === 0) && after.find((a) => a.aisle === 'REC').floor === 1);
check('…and the auto plan leaves the floor bins to be handed out by hand', (await pj(`/api/admin/sessions/${S1}/assignments/auto`, { teams: 'S1-DS07', preview: true }).catch(() => ({ skipped: [] }))).skipped?.some((x) => x.aisle === 'PRYSTG' && /floor bins/.test(x.why)) ?? false);
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
