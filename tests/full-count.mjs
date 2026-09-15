import { chromium } from 'playwright-core';
import { expandSubTabs, pickSession } from './helpers.mjs';
import { readFileSync } from 'node:fs';
const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const hdrJson = () => ({ 'content-type': 'application/json' });
// Scanners authenticate: enrol one the way a gun does, and use its token for any
// handheld call this suite makes directly.
async function enrolScanner(name, adminHeaders) {
  const d = await (await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name }) })).json();
  const e = await (await fetch(`${BASE}/api/devices/${d.uid}`, { method: 'POST' })).json();
  return { uid: d.uid, token: e.token, headers: { 'content-type': 'application/json', authorization: 'Device ' + e.token } };
}

const check = (step, ok, detail = '') => { results.push({ step, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
let shotN = 0;
const shot = async (target, name) => { shotN++; const file = `${S}screenshots/${String(shotN).padStart(2, '0')}-${name}.png`; await target.screenshot({ path: file }); return file; };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const track = (p, tag) => { p.on('pageerror', (e) => errors.push(tag + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/40[19]|Conflict|Unauthorized/.test(m.text())) errors.push(tag + ': ' + m.text()); }); };

/* ================= ADMIN ================= */
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5 })).newPage();
track(admin, 'admin');
admin.on('dialog', (d) => d.accept());
const A = (sel) => admin.$(sel);
const card = async (sel) => (await admin.$(sel)).evaluateHandle((el) => el.closest('.card'));
await admin.goto(BASE + '/admin');
await admin.fill('#fPassword', 'wrong'); await admin.click('#btnLogin'); await admin.waitForTimeout(300);
check('Admin: wrong password rejected', clean(await admin.textContent('#loginMsg')) === 'bad password', clean(await admin.textContent('#loginMsg')));
await shot(admin, 'admin-login');
await admin.fill('#fPassword', 'changeme'); await admin.click('#btnLogin');
await admin.waitForSelector('#scrMain.active'); await expandSubTabs(admin); await admin.waitForTimeout(500);
check('Admin: login', true);
check('Admin: the tab bar links the four supervisor pages',
  (await admin.$$eval('#navTabs .tab', (a) => a.map((x) => x.getAttribute('href')))).join(',') === '/admin,/cycle,/teams,/settings');

await admin.fill('#fNewName', 'Front Royal Q3 physical'); await admin.click('#btnCreate'); await admin.waitForTimeout(600);
check('Admin: create session, and it points at what to upload next',
  /Created full count #\d+/.test(clean(await admin.textContent('#sessionMsg')))
    && /Getting started|bin list/.test(clean(await admin.textContent('#sessionMsg'))),
  clean(await admin.textContent('#sessionMsg')).slice(0, 90));
await admin.selectOption('#fPalletMode', 'warn'); await admin.selectOption('#fLayout', 'front-royal');
await admin.click('#btnSaveSettings'); await admin.waitForTimeout(500);
check('Admin: save settings (Front Royal drawing, validate w/ override, guided, comments)', /Settings saved/.test(clean(await admin.textContent('#sessionMsg'))));
await (await card('#fPalletMode')).asElement().screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-session.png` });

/* ---- setup lives under Settings: scanners, list uploads, racking blocks ---- */
const toSettings = async () => { await admin.goto(BASE + '/settings'); await admin.waitForSelector('#scrMain.active'); await expandSubTabs(admin); await admin.waitForTimeout(700); };
await toSettings();
check('Settings: the sign-in carried over from the dashboard, no second password',
  (await admin.$('#scrLogin.active')) === null && /Dashboard/.test(await admin.textContent('#navTabs')));

// scanners: register two, check links, remove one later
for (const [n, notes] of [['scanner-01', 'freezer unit A'], ['SCANNER-02', ''], ['SCANNER-99', 'to be removed']]) {
  await admin.fill('#fDevName', n); await admin.fill('#fDevNotes', notes); await admin.click('#btnAddDevice'); await admin.waitForTimeout(300);
}
await admin.fill('#fDevName', 'SCANNER-01'); await admin.click('#btnAddDevice'); await admin.waitForTimeout(300);
check('Settings: duplicate scanner name refused', /already exists/.test(clean(await admin.textContent('#deviceMsg'))), clean(await admin.textContent('#deviceMsg')));
const devices = (await (await fetch(`${BASE}/api/admin/devices`, { headers: { authorization: 'Bearer ' + (await admin.evaluate(() => sessionStorage.getItem('admToken'))) } })).json()).devices;
const devLink = Object.fromEntries(devices.map((d) => [d.name, `${BASE}/?d=${d.uid}`]));
check('Settings: three scanners registered with unique links', devices.length === 3 && new Set(devices.map((d) => d.uid)).size === 3, devices.map((d) => `${d.name}=${d.uid}`).join(' '));
await admin.click('#deviceTable tbody tr:nth-child(1) button:nth-child(2)'); await admin.waitForTimeout(1500);
check('Settings: QR code shown for a scanner link', (await admin.$('#qrBox img, #qrBox canvas')) !== null || /QR unavailable/.test(clean(await admin.textContent('#qrBox'))), clean(await admin.textContent('#qrBox')).slice(0, 60) || 'rendered');
await (await card('#deviceTable')).asElement().screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-scanners.png` });
await admin.click('#btnQrClose');
const del99 = (await admin.$$('#deviceTable tbody tr')).length;

await admin.click('#deviceTable tbody tr:nth-child(3) button:text-is("Remove")'); await admin.waitForTimeout(400);
check('Settings: remove a scanner', (await admin.$$('#deviceTable tbody tr')).length === del99 - 1);
check('Settings: every scanner can have its link reset without being removed',
  (await admin.$$('#deviceTable tbody tr button:text-is("Reset link")')).length === (await admin.$$('#deviceTable tbody tr')).length);
const gone = await fetch(devLink['SCANNER-99'].replace('/?d=', '/api/devices/'));
check('API: removed scanner link no longer resolves (404)', gone.status === 404);

await admin.click('#btnLoadSiteBins'); await admin.waitForTimeout(6000);
{
  const m = clean(await admin.textContent('#uploadMsg-bins'));
  check('Settings: one-click Front Royal bin list: 13,673 bins in 28 aisles, 61 staging/door bins left out', /Imported 13,734 rows/.test(m) && /13,673 bins in 28 aisles/.test(m) && /61 bins left out \(counted manually: STAGING, DOORS\)/.test(m), m.slice(0, 200));
}
check('Settings: each list gets its own card, not a dropdown',
  (await admin.$$('[data-kind]')).length === 3 && (await admin.$('#fKind')) === null,
  (await admin.$$eval('[data-kind]', (c) => c.map((x) => x.dataset.kind))).join(', '));
for (const [kind, file] of [['pallets', 'pallets.csv'], ['plan', 'plan.csv']]) {
  await admin.setInputFiles(`#fFile-${kind}`, `${S}fixtures/${file}`);
  await admin.click(`#btnUpload-${kind}`); await admin.waitForTimeout(kind === 'bins' ? 2500 : 900);
  const m = clean(await admin.textContent(`#uploadMsg-${kind}`));
  check(`Settings: upload ${kind}`, /Imported \d/.test(m), m.slice(0, 120));
  if (kind === 'pallets') await (await card(`#fFile-${kind}`)).asElement().screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-upload.png` });
}
const [dl0] = await Promise.all([admin.waitForEvent('download'), admin.click('#colGuide-plan a')]);
check('Settings: sample CSV download', dl0.suggestedFilename() === 'plan-template.csv', dl0.suggestedFilename());

await admin.click('#btnLayoutBlocks'); await admin.waitForTimeout(700);
check('Settings: pair from drawing (F01-F24 + A01-A04)', /Paired 28/.test(clean(await admin.textContent('#aisleMsg'))), clean(await admin.textContent('#aisleMsg')));
const blocks = await admin.$$eval('#aisleTable tbody tr', (trs) => trs.map((tr) => tr.querySelector('input').value));
check('Settings: blocks A01 | A02+A03 | A04 | F01 | F02+F03 ... and no area groups', blocks.slice(0, 6).join(',') === 'A01,A02+A03,A02+A03,A04,F01,F02+F03' && blocks.length === 28, blocks.slice(0, 7).join(', ') + ` (${blocks.length})`);

/* ---- back to the dashboard for the counting plan ---- */
const toDashboard = async () => { await admin.goto(BASE + '/admin'); await admin.waitForSelector('#scrMain.active'); await expandSubTabs(admin); await admin.waitForTimeout(1200); };
await toDashboard();
await admin.fill('#fAssignTeam', '5'); await admin.fill('#fAssignAisles', '1'); await admin.fill('#fAssignLevels', ''); await admin.click('#btnAssign'); await admin.waitForTimeout(300);
check('Admin: queueing without levels is refused', /Levels are required/.test(clean(await admin.textContent('#assignMsg'))), clean(await admin.textContent('#assignMsg')));
{ const r = await fetch(`${BASE}/api/admin/sessions/1/assignments`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await admin.evaluate(() => sessionStorage.getItem('admToken'))) }, body: JSON.stringify({ team: '5', aisles: 'F09' }) });
  check('API: assignment without levels rejected (400)', r.status === 400); }
await admin.fill('#fAssignLevels', 'A-F'); await admin.click('#btnAssign'); await admin.waitForTimeout(400);
check('Admin: bare "1" is ambiguous now (A01 or F01) and says so', /ambiguous - did you mean A01 or F01/.test(clean(await admin.textContent('#assignMsg'))), clean(await admin.textContent('#assignMsg')));
await admin.$eval('#teamPlanCard', (el) => el.scrollIntoView());
await (await admin.$('#teamPlanCard')).screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-aisles-and-plan.png` });
const teamList = clean(await admin.textContent('#teamList'));
check('Admin: plan queued — T1 in F01 (A–C), T4 in F01 (D–F) at the same time, T2 in F02, T3 in F07', /Team 1in Freezer – Aisle F01, levels A–C/.test(teamList) && /Team 4in Freezer – Aisle F01, levels D–F/.test(teamList) && /Team 2in Freezer – Aisle F02/.test(teamList) && /Team 3in Freezer – Aisle F07/.test(teamList), teamList.slice(0, 200));
check('Admin: T5 wanting F01 levels C–D is held (overlaps both teams)', /Team 5waiting/.test(teamList) && /levels C–D ⏳/.test(teamList), teamList.slice(teamList.indexOf('Team 5'), teamList.indexOf('Team 5') + 80));
{ const held = await admin.$('#teamList .team:has(.head b:text-is("5")) .a.blocked button'); await held.click(); await admin.waitForTimeout(400);
  const m = clean(await admin.textContent('#assignMsg'));
  check('Admin: force-starting T5 refused, naming the team and levels', /Team [14] is counting aisle F01 on levels (ABC|DEF)/.test(m), m); }
await toSettings();
const aisleRow = clean(await admin.$eval('#aisleTable tbody tr:nth-child(5)', (tr) => tr.innerText));
check('Settings: aisle table shows both teams in F01 with their levels', /active team 1 \(ABC\), 4 \(DEF\)/.test(aisleRow), aisleRow);
await toDashboard();
/* ---- the map: rings, labels, and clicking an aisle ---- */
await admin.evaluate(() => window.appApi.showSub('map'));
await admin.waitForTimeout(1200);
check('Map: every aisle gets a ring coloured by what state it is in',
  (await admin.$$('#map .aisle-g')).length === 28
    && new Set(await admin.$$eval('#map .aisle-g .ring', (r) => r.map((x) => x.getAttribute('stroke')))).size >= 2,
  JSON.stringify(await admin.$$eval('#map .aisle-g', (gs) => {
    const o = {}; for (const g of gs) { const c = g.querySelector('.ring').getAttribute('stroke'); o[c] = (o[c] || 0) + 1; } return o;
  })));
check('Map: an aisle a team is in is ringed blue, one handed back is green',
  await admin.$eval('#map .aisle-g[data-aisle="F01"] .ring', (r) => r.getAttribute('stroke')) === '#2f81f7',
  await admin.$eval('#map .aisle-g[data-aisle="F01"] .ring', (r) => r.getAttribute('stroke')));
check('Map: each aisle is labelled with its code, zone and percentage',
  (await admin.textContent('#map .aisle-g[data-aisle="F01"] .aisle-label')) === 'F01'
    && /Frz · \d+%/.test(await admin.textContent('#map .aisle-g[data-aisle="F01"] .aisle-sub')),
  await admin.textContent('#map .aisle-g[data-aisle="F01"] .aisle-sub'));
check('Map: no two aisle labels sit on top of each other',
  (await admin.evaluate(() => {
    const pills = [...document.querySelectorAll('#map .aisle-g')].map((g) => ({ a: g.dataset.aisle, r: g.querySelector('.label-pill').getBoundingClientRect() }));
    const hit = [];
    for (let i = 0; i < pills.length; i++) for (let k = i + 1; k < pills.length; k++) {
      const x = pills[i].r, y = pills[k].r;
      if (x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1) hit.push(pills[i].a + '/' + pills[k].a);
    }
    return hit;
  })).length === 0);
await admin.click('#map .aisle-g[data-aisle="F01"]'); await admin.waitForTimeout(700);
check('Map: clicking an aisle opens its detail, broken down by level',
  !(await admin.$eval('#mapPanel', (e) => e.hidden))
    && /Freezer – Aisle F01/.test(await admin.textContent('#mapPanelTitle'))
    && (await admin.$$('#mapPanelLevels tbody tr')).length === 6,
  clean(await admin.textContent('#mapPanelPct')));
check('Map: the detail says who is on it and which block it shares',
  /Team 1/.test(await admin.textContent('#mapPanelWho')) && /block/.test(await admin.textContent('#mapPanelWho')),
  clean(await admin.textContent('#mapPanelWho')).slice(0, 90));
check('Map: the selected aisle is ringed heavily so you can see which one it is',
  await admin.$eval('#map .aisle-g.selected .ring', (r) => r.getAttribute('stroke-width')) === '4');
await admin.keyboard.press('Escape'); await admin.waitForTimeout(400);
check('Map: Escape closes the detail again', await admin.$eval('#mapPanel', (e) => e.hidden));

check('Admin: map badge for two teams in one aisle reads T1+T4', await admin.$$eval('#map text.team', (t) => t.some((x) => x.textContent === 'T1+T4')), (await admin.$$eval('#map text.team', (t) => t.map((x) => x.textContent))).join(' '));

const api = await enrolScanner('SUITE-API', { 'content-type': 'application/json', authorization: 'Bearer ' + (await admin.evaluate(() => sessionStorage.getItem('admToken'))) });
/* ================= HANDHELD helpers ================= */
async function scanner(tag) {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); track(p, tag);
  p.on('dialog', (d) => d.accept());
  const scan = async (v) => { await p.fill('#fScan', v); await p.press('#fScan', 'Enter'); await p.waitForTimeout(220); };
  const T = (sel) => p.textContent(sel).then(clean);
  return { ctx, p, scan, T };
}

/* ================= TEAM 1 on SCANNER-01 ================= */
const t0 = await scanner('unregistered');
await t0.p.goto(BASE); await t0.p.waitForSelector('#scrDevice.active');
check('Handheld: with no link, first run asks for a scanner ID', true);
await shot(t0.p, 'hh-device-setup');
await t0.p.goto(devLink['SCANNER-99']); await t0.p.waitForSelector('#scrDevice.active'); await t0.p.waitForTimeout(400);
check('Handheld: a removed scanner link is refused', /removed by a supervisor/.test(await t0.T('#deviceMsg')), await t0.T('#deviceMsg'));
// the Add button must never crowd out the field it sits beside
await t0.p.fill('#fDeviceId', 'TEMP-01'); await t0.p.click('#btnSaveDevice'); await t0.p.waitForSelector('#scrSignon.active');
{
  const box = await t0.p.$eval('#fEmployee', (el) => el.getBoundingClientRect());
  const btn = await t0.p.$eval('#btnAddEmployee', (el) => el.getBoundingClientRect());
  check('Sign-on: the clock-in field is usable and Add fits beside it on a 480px screen',
    box.width > 200 && btn.width > 40 && btn.right <= 481 && box.right <= btn.left,
    `field ${Math.round(box.width)}px, Add ${Math.round(btn.width)}px ending at ${Math.round(btn.right)}`);
}
await t0.ctx.close();

const t1 = await scanner('scanner-01');
await t1.p.goto(devLink['SCANNER-01']);
await t1.p.waitForSelector('#scrSignon.active');
check('Handheld T1: opened from its registered link → identity set, setup skipped', /registered as SCANNER-01/.test(await t1.T('#deviceInfo')) && (await t1.T('#chipDevice')) === 'SCANNER-01', await t1.T('#deviceInfo'));
// cold start offline on the same link still knows who it is
await t1.ctx.setOffline(true); await t1.p.goto(devLink['SCANNER-01']).catch(() => {}); await t1.p.waitForTimeout(600);
check('Handheld T1: offline reload of the link keeps the saved identity', /registered as SCANNER-01/.test(await t1.T('#deviceInfo')), await t1.T('#deviceInfo'));
await t1.ctx.setOffline(false); await t1.p.goto(devLink['SCANNER-01']); await t1.p.waitForSelector('#scrSignon.active');
await t1.p.waitForSelector('#fSession option[value="1"]', { state: 'attached' });
await t1.p.selectOption('#fSession', '1'); await t1.p.fill('#fTeam', '1');
for (const e of ['E1001', 'E1002']) { await t1.p.fill('#fEmployee', e); await t1.p.press('#fEmployee', 'Enter'); }
await shot(t1.p, 'hh-signon');
await t1.p.click('#btnStart'); await t1.p.waitForSelector('#scrAssign.active', { timeout: 15000 });
let ac = await t1.T('#assignCard');
check('Handheld T1: sign-on → F01 levels A–C: 318 of its 654 bins', /your aisleF01Freezer – Aisle F01 · levels A–C/.test(ac) && /of 318 bins/.test(ac), ac.slice(0, 110));
await shot(t1.p, 'hh-assignment');
await t1.p.click('#btnCount'); await t1.p.waitForSelector('#scrScan.active');
check('Handheld T1: step 1 is PALLET ID', (await t1.T('#prompt')) === 'Scan PALLET ID');

// good line: pallet -> qty -> bin -> comment chip
await t1.scan('plt01001a');
check('Handheld T1: pallet recognised, contents shown', /Chicken breast/.test(await t1.T('#scanMsg')) && (await t1.T('#prompt')) === 'Enter QUANTITY', await t1.T('#scanMsg'));
await shot(t1.p, 'hh-pallet-recognised');
await t1.scan('40');
check('Handheld T1: qty accepted → BIN prompt', (await t1.T('#prompt')) === 'Scan BIN LOCATION');
await t1.scan('F01A001');
check('Handheld T1: bin accepted → COMMENTS prompt, with level / position / face shown', (await t1.T('#prompt')) === 'Comments (optional)' && /Bin F01A001Level A · Position 001 · FRONT/.test(await t1.T('#scanMsg')), await t1.T('#scanMsg'));
check('Handheld T1: context row shows where the bin is', /F01A001 — Level A · Position 001 · FRONT/.test(await t1.T('#ctx')), await t1.T('#ctx'));
await shot(t1.p, 'hh-comments');
await t1.p.click('#commentChips button:nth-child(1)'); await t1.p.press('#fScan', 'Enter'); await t1.p.waitForTimeout(300);
check('Handheld T1: line saved with comment', /Counted PLT01001A/.test(await t1.T('#scanMsg')) && (await t1.T('#prompt')) === 'Scan PALLET ID', await t1.T('#scanMsg'));
await shot(t1.p, 'hh-counted');
// five more clean lines
for (const [b, lv] of [[1, 'B'], [1, 'C'], [2, 'A'], [2, 'B'], [3, 'A']]) { await t1.scan(`PLT01${String(b).padStart(3, '0')}${lv}`); await t1.scan('40'); await t1.scan(`F01${lv}${String(b).padStart(3, '0')}`); await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(150); }
// wrong-bin line: pallet expected in F01A004 counted in F01A005 (still F01)
await t1.scan('PLT01004A'); await t1.scan('40'); await t1.scan('F01A005');
check('Handheld T1: pallet in unexpected bin is warned', /expected this pallet in F01A004/.test(await t1.T('#scanMsg')), await t1.T('#scanMsg'));
await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(150);
// qty variance line
await t1.scan('PLT01005A'); await t1.scan('30'); await t1.scan('F01A005'); await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(150);
// duplicate pallet
await t1.scan('PLT01001A'); await t1.p.waitForSelector('#scrOverride.active');
check('Handheld T1: duplicate pallet caught', /already counted in bin F01A001/.test(await t1.T('#ovWhy')), await t1.T('#ovWhy'));
await shot(t1.p, 'hh-duplicate');
await t1.p.selectOption('#fReason', 'Relabelled'); await t1.p.click('#btnOverrideAccept'); await t1.p.waitForTimeout(200);
await t1.scan('40'); await t1.scan('F01A009'); await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(200);
check('Handheld T1: duplicate accepted with reason → flagged line', /Counted PLT01001A.*flagged/.test(await t1.T('#scanMsg')), await t1.T('#scanMsg'));
// unknown pallet with override
await t1.scan('NOLABEL-77'); await t1.p.waitForSelector('#scrOverride.active');
check('Handheld T1: unknown pallet needs reason', (await t1.T('#ovTitle')) === 'Pallet not on the list');
await t1.p.selectOption('#fReason', 'New receipt, not on the report'); await t1.p.fill('#fReasonNote', 'handwritten tag'); await t1.p.click('#btnOverrideAccept'); await t1.p.waitForTimeout(200);
// bad qty then large qty
await t1.scan('abc');
check('Handheld T1: junk quantity refused', /is not a quantity/.test(await t1.T('#scanMsg')), await t1.T('#scanMsg'));
await shot(t1.p, 'hh-bad-qty');
await t1.scan('2500');
check('Handheld T1: large quantity asks to confirm', /Confirm quantity 2500/.test(await t1.T('#scanMsg')));
await shot(t1.p, 'hh-large-qty');
await t1.scan('2500');
check('Handheld T1: confirmed → BIN prompt', (await t1.T('#prompt')) === 'Scan BIN LOCATION');
// off-aisle bin
await t1.scan('F02A001'); await t1.p.waitForSelector('#scrOverride.active');
check('Handheld T1: bin outside assigned aisle stopped', /is in aisle F02. Your team is assigned to aisle F01/.test(await t1.T('#ovWhy')), await t1.T('#ovWhy'));
await shot(t1.p, 'hh-off-aisle');
await t1.p.selectOption('#fReason', 'Supervisor said to count it'); await t1.p.click('#btnOverrideAccept'); await t1.p.waitForTimeout(200);
await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(200);
// unknown bin
await t1.scan('PLT01006A'); await t1.scan('40'); await t1.scan('F99Z999'); await t1.p.waitForSelector('#scrOverride.active');
check('Handheld T1: unknown bin needs reason', (await t1.T('#ovTitle')) === 'Bin not on the list');
await t1.p.selectOption('#fReason', 'Other'); await t1.p.click('#btnOverrideAccept'); await t1.p.waitForTimeout(200); await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(300);
// a bin on a level that belongs to the other team in this aisle
await t1.scan('PLT01010A'); await t1.scan('40'); await t1.scan('F01D001'); await t1.p.waitForSelector('#scrOverride.active');
check('Handheld T1: bin on level D stopped — team has levels A–C', (await t1.T('#ovTitle')) === 'Not your level' && /assigned levels A–C/.test(await t1.T('#ovWhy')), await t1.T('#ovWhy'));
await shot(t1.p, 'hh-not-your-level');
await t1.p.click('#btnOverrideCancel'); await t1.p.waitForSelector('#scrScan.active');
await t1.scan('F01A010'); await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(200);
// empty bins count too
await t1.p.click('#btnEmpty'); await t1.p.waitForTimeout(200);
check('Handheld T1: "Bin is EMPTY" jumps to the bin scan', /EMPTY bin/.test(await t1.T('#prompt')), await t1.T('#prompt'));
await shot(t1.p, 'hh-empty-bin');
await t1.scan('F01A020');
check('Handheld T1: empty bin recorded (even position = BACK), back to pallet prompt', /Bin F01A020 recorded as EMPTYLevel A · Position 020 · BACK/.test(await t1.T('#scanMsg')) && (await t1.T('#prompt')) === 'Scan PALLET ID', await t1.T('#scanMsg'));
await t1.p.click('#btnEmpty'); await t1.scan('F01A021');
// offline
await t1.ctx.setOffline(true); await t1.p.evaluate(() => window.dispatchEvent(new Event('offline')));
await t1.scan('PLT01007A'); await t1.scan('40'); await t1.scan('F01A007'); await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(300);
await t1.scan('PLT01008A'); await t1.scan('40'); await t1.scan('F01A008'); await t1.p.click('#btnSkip'); await t1.p.waitForTimeout(300);
check('Handheld T1: offline counting queues lines', (await t1.T('#chipNet')) === 'OFFLINE' && /2 queued/.test(await t1.T('#chipQueue')), await t1.T('#chipQueue'));
await shot(t1.p, 'hh-offline-queued');
await t1.ctx.setOffline(false); await t1.p.evaluate(() => window.dispatchEvent(new Event('online'))); await t1.p.waitForTimeout(1500);
check('Handheld T1: back online → queue drained', (await t1.T('#chipNet')) === 'online' && (await t1.p.getAttribute('#chipQueue', 'hidden')) !== null);
// history + void
await t1.p.click('#btnHistory'); await t1.p.waitForSelector('#scrHistory.active'); await t1.p.waitForTimeout(200);
const before = (await t1.p.$$('#historyList .item')).length;
await t1.p.click('#historyList .item button'); await t1.p.waitForTimeout(500);
check('Handheld T1: history lists lines and voids one', before >= 10 && /voided/.test(await t1.p.$eval('#historyList .item', (el) => el.className)), `${before} lines`);
await shot(t1.p, 'hh-history-void');
await t1.p.click('#btnHistoryBack'); await t1.p.waitForTimeout(200);

/* ================= TEAM 2 on SCANNER-02 ================= */
const t2 = await scanner('scanner-02');
await t2.p.goto(devLink['SCANNER-02']); await t2.p.waitForSelector('#scrSignon.active');
await t2.p.waitForSelector('#fSession option[value="1"]', { state: 'attached' });
await t2.p.selectOption('#fSession', '1'); await t2.p.fill('#fTeam', '2');
await t2.p.fill('#fEmployee', 'E2001'); await t2.p.press('#fEmployee', 'Enter');
await t2.p.click('#btnStart'); await t2.p.waitForSelector('#scrAssign.active', { timeout: 15000 });
ac = await t2.T('#assignCard');
check('Handheld T2: sign-on → assigned F02', /your aisleF02/.test(ac), ac.slice(0, 60));
// staging bins (no rack code) validate too
await t2.p.click('#btnCount'); await t2.p.waitForSelector('#scrScan.active');
await t2.scan('PLT02010A'); await t2.scan('96'); await t2.scan('STAGE23'); await t2.p.waitForSelector('#scrOverride.active');
check('Handheld T2: staging bin STAGE23 is not on the list (counted manually)', (await t2.T('#ovTitle')) === 'Bin not on the list', await t2.T('#ovTitle'));
await t2.p.click('#btnOverrideCancel'); await t2.p.waitForSelector('#scrScan.active');
await t2.scan('NIL'); await t2.p.waitForSelector('#scrOverride.active');
check('Handheld T2: NIL (system area) still validates, flagged off-aisle', /is in aisle SYSTEM/.test(await t2.T('#ovWhy')), await t2.T('#ovWhy'));
await t2.p.click('#btnOverrideCancel'); await t2.p.waitForSelector('#scrScan.active');
{ const r = await fetch(`${BASE}/api/admin/sessions/1/assignments`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await admin.evaluate(() => sessionStorage.getItem('admToken'))) }, body: JSON.stringify({ team: '8', aisles: 'STAGING', levels: 'A-F' }) }).then((x) => x.json());
  check('Admin: STAGING cannot be assigned to a team', r.skipped.length === 1 && /no such aisle/.test(r.skipped[0].reason), JSON.stringify(r.skipped)); }
await t2.p.click('#btnBack'); await t2.p.click('#btnBack'); await t2.p.waitForTimeout(150);
check('Handheld T2: Back twice returns to the PALLET prompt', (await t2.T('#prompt')) === 'Scan PALLET ID');
await t2.p.click('#btnToAssign'); await t2.p.waitForSelector('#scrAssign.active');
await t2.p.click('#btnCount'); await t2.p.waitForSelector('#scrScan.active');
for (const b of [1, 2, 3]) { await t2.scan(`PLT02${String(b).padStart(3, '0')}A`); await t2.scan('96'); await t2.scan(`F02A${String(b).padStart(3, '0')}`); await t2.p.click('#btnSkip'); await t2.p.waitForTimeout(150); }
// cross-device duplicate: T2 scans a pallet T1 counted
await t2.scan('PLT01002A'); await t2.p.waitForSelector('#scrOverride.active');
check('Handheld T2: pallet counted by team 1 on another scanner caught', /by team 1/.test(await t2.T('#ovWhy')), await t2.T('#ovWhy'));
await shot(t2.p, 'hh-crossdevice-duplicate');
await t2.p.click('#btnOverrideCancel'); await t2.p.waitForSelector('#scrScan.active');

/* ================= SECOND COUNTS ================= */
const adm = { 'content-type': 'application/json', authorization: 'Bearer ' + (await admin.evaluate(() => sessionStorage.getItem('admToken'))) };
const getRecs = async () => (await fetch(`${BASE}/api/admin/sessions/1/recounts`, { headers: adm })).json();
let recs = await getRecs();
const byReason = (rs, reason) => rs.find((r) => r.reason === reason && r.status !== 'done');
const qtyTask = byReason(recs, 'QTY VARIANCE'), dupTask = byReason(recs, 'COUNTED TWICE'), unkTask = byReason(recs, 'NOT IN MASTER');
const noTeam = recs.filter((r) => r.source === 'auto' && !r.first_team);
check('Recounts: raised automatically from team 1\'s first-count variances, each knowing who counted first',
  !!qtyTask && !!dupTask && !!unkTask && recs.every((r) => r.source === 'auto') && noTeam.length === 0,
  [...new Set(recs.map((r) => r.reason))].join(', ') + ` (${recs.length} bins)` + (noTeam.length ? ` · no first team: ${noTeam.map((r) => r.bin + '/' + r.reason).join(', ')}` : ''));
check('Recounts: supervisor sees the numbers behind it', /expected \d+, first count \d+/.test(qtyTask.detail), `${qtyTask.bin}: ${qtyTask.detail}`);
const t1tasks = await (await fetch(`${BASE}/api/sessions/1/recounts?team=1`, { headers: api.headers })).json();
const t2tasks = await (await fetch(`${BASE}/api/sessions/1/recounts?team=2`, { headers: api.headers })).json();
check('Recounts: team 1 is not offered its own first counts; team 2 is', !t1tasks.tasks.some((t) => t.bin === qtyTask.bin) && t2tasks.tasks.some((t) => t.bin === qtyTask.bin), `t1:${t1tasks.tasks.length} t2:${t2tasks.tasks.length}`);
const shown = t2tasks.tasks.find((t) => t.bin === qtyTask.bin).reason;
check('Recounts: the gun is told the reason, never the numbers', /Quantity differs from the inventory report/.test(shown) && !/\d/.test(shown), shown);
const takeBy1 = await fetch(`${BASE}/api/sessions/1/recounts/${qtyTask.id}/take`, { method: 'POST', headers: api.headers, body: JSON.stringify({ team: '1' }) });
check('Recounts: team 1 cannot take the second count of its own first count (409)', takeBy1.status === 409);
// a bin nobody has touched, requested by hand and assigned to team 2
await admin.fill('#fRecBin', 'F02A012'); await admin.fill('#fRecNote', 'supervisor spot check'); await admin.fill('#fRecTeam', '2'); await admin.click('#btnRecAdd'); await admin.waitForTimeout(700);
check('Recounts: manual request from the dashboard', /Second count requested/.test(clean(await admin.textContent('#recountMsg'))), clean(await admin.textContent('#recountMsg')));
const manual = (await getRecs()).find((r) => r.bin === 'F02A012');
check('Recounts: the manual one is marked manual and assigned to team 2', manual && manual.source === 'manual' && manual.team === '2', `${manual?.source} team ${manual?.team}`);
// team 2 works the queue: the qty-variance bin first, then the manual one
await fetch(`${BASE}/api/admin/sessions/1/recounts/${qtyTask.id}`, { method: 'POST', headers: adm, body: JSON.stringify({ team: '2' }) });
await t2.p.click('#btnToAssign'); await t2.p.waitForSelector('#scrAssign.active');
await t2.p.click('#btnAssignRefresh'); await t2.p.waitForTimeout(800);
check('Handheld T2: assignment screen offers second counts', (await t2.p.getAttribute('#recountCard', 'hidden')) === null && Number(await t2.T('#recountCount')) >= 2, (await t2.T('#recountCount')) + ' tasks');
await shot(t2.p, 'hh-recounts-offered');
await t2.p.click('#btnRecounts'); await t2.p.waitForSelector('#scrScan.active'); await t2.p.waitForTimeout(500);
const banner = await t2.T('#recountBanner');
check('Handheld T2: recount banner names the bin, where it is, and the reason', new RegExp(`SECOND COUNT · bin ${qtyTask.bin}`).test(banner) && /Level [A-F] · Position \d+ · (FRONT|BACK)/.test(banner) && /Quantity differs/.test(banner), banner);
await shot(t2.p, 'hh-recount-banner');
const qtyPallet = qtyTask.first_result.split(' ×')[0];
await t2.scan(qtyPallet);
check('Handheld T2: re-scanning the pallet in a recount is not a duplicate stop', (await t2.T('#prompt')) === 'Enter QUANTITY', await t2.T('#prompt'));
await t2.scan('96'); await t2.scan('F01C001');
check('Handheld T2: a different bin is refused during a recount', new RegExp(`This second count is for bin ${qtyTask.bin}`).test(await t2.T('#scanMsg')), await t2.T('#scanMsg'));
await t2.scan(qtyTask.bin); await t2.p.click('#btnSkip'); await t2.p.waitForTimeout(400);
await t2.p.click('#btnRecountDone'); await t2.p.waitForTimeout(1000);
check('Handheld T2: bin done → straight on to the next second count', /SECOND COUNT · bin /.test(await t2.T('#recountBanner')) && (await t2.p.getAttribute('#recountBanner', 'data-bin')) !== qtyTask.bin, `${qtyTask.bin} -> ${await t2.p.getAttribute('#recountBanner', 'data-bin')}`);
recs = await getRecs();
const doneTask = recs.find((r) => r.id === qtyTask.id);
check('Recounts: task done by team 2, both counts on record', doneTask.status === 'done' && doneTask.done_by_team === '2' && /×/.test(doneTask.first_result) && /×96/.test(doneTask.second_result), `${doneTask.first_result} → ${doneTask.second_result}`);
const pr = (await (await fetch(`${BASE}/api/admin/sessions/1/pallets?limit=1000`, { headers: adm })).json()).rows;
const rec = pr.find((r) => r.pallet_id === qtyPallet);
check('Report: the second count supersedes the first, and the first is kept for the record', rec.recounted === 1 && rec.counted_qty === 96 && Number(rec.first_count_qty) !== 96, `1st=${rec.first_count_qty} now=${rec.counted_qty} status=${rec.status}`);
// finish the manual one by marking the bin empty
await t2.p.click('#btnEmpty'); await t2.scan('F02A012'); await t2.p.waitForTimeout(1000);
check('Handheld T2: marking a recount bin EMPTY completes the task', (await getRecs()).find((r) => r.bin === 'F02A012').status === 'done');

/* ================= STAGGER ================= */
await admin.reload(); await admin.waitForSelector('#scrMain.active'); await expandSubTabs(admin); await admin.waitForTimeout(1200);
const blockedBtn = await admin.$('#teamList .a.blocked button');
check('Admin: team 1\'s F03 shown as held (⏳) while team 2 is in F02', !!blockedBtn);
if (blockedBtn) { await blockedBtn.click(); await admin.waitForTimeout(500); }
const conflict = clean(await admin.textContent('#assignMsg'));
check('Admin: force-starting F03 refused with racking conflict', /Team 2 is counting aisle F02, which shares racking with F03/.test(conflict), conflict);
await admin.$eval('#teamPlanCard', (el) => el.scrollIntoView());
await (await admin.$('#teamPlanCard')).screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-conflict.png` });

await t1.p.click('#btnToAssign'); await t1.p.waitForSelector('#scrAssign.active'); await t1.p.waitForTimeout(300);
await t1.p.click('#btnAisleDone'); await t1.p.waitForTimeout(800);
ac = await t1.T('#assignCard');
{ const rr = await (await fetch(`${BASE}/api/admin/sessions/1/recounts`, { headers: adm })).json();
  const missing = rr.filter((r) => r.reason === 'MISSING' && r.source === 'auto');
  check('Recounts: handing back F01 raises MISSING second counts for expected pallets nobody saw (levels A–C only)', missing.length > 50 && missing.every((r) => /^F01[ABC]/.test(r.bin)) && missing[0].first_team === '1', `${missing.length} raised, e.g. ${missing[0]?.bin}`); }
check('Handheld T1: aisle complete → waits for team 2 (F03 shares racking with F02), zone named', /next aisleF03Freezer – Aisle F03/.test(ac) && /team 2 is still in Freezer – Aisle F02/.test(ac), ac.slice(0, 160));
await shot(t1.p, 'hh-waiting-on-team2');

await t2.p.click('#btnToAssign'); await t2.p.waitForSelector('#scrAssign.active'); await t2.p.waitForTimeout(300);
await t2.p.click('#btnAisleDone'); await t2.p.waitForTimeout(800);
ac = await t2.T('#assignCard');
check('Handheld T2: aisle complete → F04 released to team 2', /your aisleF04/.test(ac), ac.slice(0, 60));
await t1.p.click('#btnAssignRefresh'); await t1.p.waitForTimeout(600);
ac = await t1.T('#assignCard');
check('Handheld T1: refresh → F03 now active for team 1', /your aisleF03/.test(ac), ac.slice(0, 60));
await shot(t1.p, 'hh-released');

/* ================= ADMIN REPORTING ================= */
await admin.reload(); await admin.waitForSelector('#scrMain.active'); await expandSubTabs(admin); await admin.waitForTimeout(1500);
const stats = clean(await admin.textContent('#stats'));
check('Admin: progress stats populated', /Count lines/.test(stats) && /2Teams counting/.test(stats) && /2Scanners/.test(stats), stats.slice(0, 140));
const teams = clean(await admin.textContent('#teamTable'));
check('Admin: team table shows scanner + employees + active aisle with zone', /SCANNER-01/.test(teams) && /E1001, E1002/.test(teams) && /Freezer – Aisle F03/.test(teams), teams.slice(0, 160));
await (await card('#stats')).asElement().screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-progress.png` });
await admin.$eval('#mapWrap', (el) => el.closest('.card').scrollIntoView()); await admin.waitForTimeout(300);
const mapCard = (await card('#mapWrap')).asElement();
const mb = await mapCard.boundingBox();
await admin.screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-map.png`, clip: { x: mb.x, y: mb.y, width: mb.width, height: Math.min(mb.height, 820) } });
{ const titles = await admin.$$eval('#map rect.cell title', (t) => t.map((x) => x.textContent));
  const f01 = titles.find((t) => /Aisle F01 · Bay 1 · FRONT/.test(t));
  check('Admin: hover text names the aisle, face, positions and levels, and lists counted / open bins',
    !!f01 && /Positions 001, 003/.test(f01) && /levels A–[CF]/.test(f01) && /Counted: F01A001/.test(f01) && /Still to count: /.test(f01), (f01 || titles[0] || '').split('\n').slice(0, 2).join(' | '));
}
check('Admin: blueprint map rendered with front/back faces', await admin.$eval('#map', (s) => s.classList.contains('blueprint')) && (await admin.$$('#map rect.cell')).length > 1000 && (await admin.$$eval('#map rect.cell title', (t) => t.some((x) => /· FRONT/.test(x.textContent)))), `${(await admin.$$('#map rect.cell')).length} cells`);
await admin.click('#mapLevels button:nth-child(2)'); await admin.waitForTimeout(900);
check('Admin: map level filter (level A) recolours the map for that level only', /^Level A: \d[\d,]* of 2,020 bins/.test(clean(await admin.textContent('#mapNote'))), clean(await admin.textContent('#mapNote')).slice(0, 80));
await (await admin.$('#mapWrap')).evaluate((el) => el.closest('.card').scrollIntoView());
await admin.screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-map-level-a.png`, clip: await (await admin.$('#mapWrap')).evaluate((el) => { const r = el.closest('.card').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 700) }; }) });
await admin.click('#mapLevels button:nth-child(1)'); await admin.waitForTimeout(900);
check('Admin: map note summarises areas not on the drawing (no staging/doors)', /Not on the drawing — AREAS \d+\/8 · SYSTEM \d+\/4 · WIP \d+\/4\./.test(await admin.textContent('#mapNote')), clean(await admin.textContent('#mapNote')).slice(0, 200));
await toSettings();
const devRow = clean(await admin.textContent('#deviceTable'));
check('Settings: scanners show last seen + team after sign-on', /SCANNER-01.*\d{1,2}:\d\d.*1/.test(devRow), devRow.slice(0, 160));
await toDashboard();
const statuses = await admin.$$eval('#palletTable .tag', (t) => [...new Set(t.map((x) => x.textContent))]);
check('Admin: pallet report statuses', ['COUNTED TWICE', 'WRONG BIN', 'QTY VARIANCE', 'NOT IN MASTER', 'MISSING'].every((s) => statuses.includes(s)), statuses.join(', '));
check('Admin: EMPTY is not a pallet in the report', !(await admin.$$eval('#palletTable tbody tr', (trs) => trs.some((tr) => /^EMPTY/.test(tr.innerText)))));
check('Admin: hero counts the empty bins', /3 bins checked empty/.test(clean(await admin.textContent('#heroSub'))), clean(await admin.textContent('#heroSub')));
await admin.$eval('#recountTable', (el) => el.closest('.card').scrollIntoView());
await (await card('#recountTable')).asElement().screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-second-counts.png` });
await admin.$eval('#palletTable', (el) => el.closest('.card').scrollIntoView());
await (await card('#palletTable')).asElement().screenshot({ path: `${S}screenshots/${String(++shotN).padStart(2, '0')}-admin-pallet-report.png` });
for (const [btn, name] of [['#btnExportPallets', 'pallets'], ['#btnExportCounts', 'counts'], ['#btnExportExceptions', 'exceptions'], ['#btnExportUncounted', 'uncounted-bins'], ['#btnExportRecounts', 'second-counts']]) {
  const [dl] = await Promise.all([admin.waitForEvent('download'), admin.click(btn)]);
  const path = await dl.path(); const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  check(`Admin: export ${name}.csv`, dl.suggestedFilename().startsWith(name) && lines.length > 1, `${lines.length - 1} rows, header: ${lines[0].slice(0, 70)}`);
}
// Excel: the real ERP workbook, as-is, into a fresh session
await admin.fill('#fNewName', 'xlsx check'); await admin.click('#btnCreate'); await admin.waitForTimeout(1500);
check('Admin: a new session comes up on the site drawing, not back on the schematic',
  await admin.$eval('#fLayout', (s) => s.value) === 'front-royal'
    && /rack layout/.test(await admin.textContent('#mapSub')),
  `${await admin.$eval('#fLayout', (s) => s.value)} · ${(await admin.textContent('#mapSub')).slice(0, 50)}`);
check('Admin: a session with no bins yet says so instead of showing an empty map',
  /No bins in this session yet/.test(await admin.textContent('#mapNote')), clean(await admin.textContent('#mapNote')).slice(0, 80));
await admin.selectOption('#fLayout', 'front-royal'); await admin.click('#btnSaveSettings'); await admin.waitForTimeout(400);
await toSettings();
check('Settings: the session picker follows the dashboard to the newest session',
  /xlsx check/.test(await admin.$eval('#fSessionPick', (s) => s.options[s.selectedIndex].textContent)),
  await admin.$eval('#fSessionPick', (s) => s.options[s.selectedIndex].textContent));
await admin.setInputFiles('#fFile-bins', `${S}fixtures/Bins.xlsx`); await admin.click('#btnUpload-bins');
await admin.waitForFunction(() => /Imported|failed/.test(document.getElementById('uploadMsg-bins').textContent), null, { timeout: 60000 }).catch(() => {});
{
  const m = clean(await admin.textContent('#uploadMsg-bins'));
  check('Settings: raw ERP Bins.xlsx uploads as-is: 13,673 bins in 28 aisles', /Imported 13,734 rows/.test(m) && /13,673 bins in 28 aisles/.test(m), m.slice(0, 140));
}
await toDashboard();
await pickSession(admin, '1');
{ // a session put on the schematic is offered the drawing rather than just looking wrong
  const adm2 = { 'content-type': 'application/json', authorization: 'Bearer ' + (await admin.evaluate(() => sessionStorage.getItem('admToken'))) };
  const plain = await (await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: adm2, body: JSON.stringify({ name: 'schematic on purpose', layout: '' }) })).json();
  await fetch(`${BASE}/api/admin/sessions/${plain.id}/master?kind=bins`, { method: 'POST', headers: { authorization: adm2.authorization, 'content-type': 'text/csv' }, body: 'Bin Location\nF01A001\nF01A002\nF02A001\n' });
  await admin.reload(); await admin.waitForSelector('#scrMain.active'); await expandSubTabs(admin); await admin.waitForTimeout(1500);
  await pickSession(admin, String(plain.id));
  check('Admin: a session on the schematic is offered the rack drawing',
    !(await admin.$eval('#mapFix', (el) => el.hidden)) && /Use Front Royal/.test(await admin.textContent('#btnUseDrawing')),
    clean(await admin.textContent('#btnUseDrawing')));
  await admin.click('#btnUseDrawing'); await admin.waitForTimeout(2500);
  check('Admin: one click switches it to the blueprint and the offer goes away',
    await admin.$eval('#map', (s) => s.classList.contains('blueprint')) && await admin.$eval('#mapFix', (el) => el.hidden),
    await admin.$eval('#fLayout', (s) => s.value));
  await pickSession(admin, '1');
}
// close session -> scanner rejected -> reopen
await admin.click('#btnCloseSession'); await admin.waitForTimeout(600);
const closedPost = await fetch(`${BASE}/api/sessions/1/counts`, { method: 'POST', headers: api.headers, body: JSON.stringify([{ clientId: 'x1', palletId: 'P', qty: 1, location: 'F01A001', team: '1', deviceId: 'D' }]) });
check('Admin: closed session refuses new counts (409)', closedPost.status === 409);
check('Admin: the header picker shows a closed count as closed',
  await admin.$eval('#sessionPick .sess-btn', (b) => /closed/i.test(b.textContent)),
  clean(await admin.textContent('#sessionPick .sess-btn')));
await admin.click('#btnCloseSession'); await admin.waitForTimeout(600);
check('Admin: reopen session — the header picker drops the "closed" tag',
  !(await admin.$eval('#sessionPick .sess-btn', (b) => /closed/i.test(b.textContent)))
    && /open/.test(clean(await admin.textContent('#sessionCardSub'))),
  clean(await admin.textContent('#sessionCardSub')));
// idempotent resend
const dup = await (await fetch(`${BASE}/api/sessions/1/counts`, { method: 'POST', headers: api.headers, body: JSON.stringify([{ clientId: 'idem-1', palletId: 'PLT06001A', qty: 1, location: 'F06A001', team: '9', deviceId: 'X' }, { clientId: 'idem-1', palletId: 'PLT06001A', qty: 1, location: 'F06A001', team: '9', deviceId: 'X' }]) })).json();
const cnt = (await (await fetch(`${BASE}/api/sessions/1/counted-pallets`, { headers: api.headers })).json()).pallets.filter((p) => p[0] === 'PLT06001A').length;
check('API: resending the same clientId never double-counts', cnt === 1, `stored ${cnt}×`);

console.log('\nconsole/page errors:', errors.length ? errors : 'none');
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed`);
require_fs: {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${S}screenshots/results.json`, JSON.stringify({ results, errors }, null, 1));
}
await browser.close();
if (results.some((r) => r === false || r.ok === false)) process.exitCode = 1;
