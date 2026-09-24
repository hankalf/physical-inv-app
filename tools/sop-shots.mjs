/*
 * The screenshots in docs/SOP.md.
 *
 * Boots the app on a throwaway database, fills it with a believable count in
 * progress - the real Front Royal bin list, six aisles handed to three teams,
 * a few thousand lines counted with the variances and flags a real count throws
 * up - then photographs every screen the manual talks about.
 *
 *   node tools/sop-shots.mjs
 *
 * Re-run it whenever a screen changes; the SOP points at these files by name.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'docs', 'images');
const PORT = Number(process.env.PORT || 3399);
const BASE = `http://127.0.0.1:${PORT}`;
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'sopshots-'));
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'demo.db'), ADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* still starting */ }
    await wait(200);
  }

  /* ------------------------------------------------------------- seed */
  const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) }))).token;
  const A = { ...hdr, authorization: 'Bearer ' + tok };
  const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
  const post = (p, body, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) }).then(j);

  const sess = await post('/api/admin/sessions', { name: 'Q3 2026 wall-to-wall' });
  const binCsv = readFileSync(join(ROOT, 'public', 'templates', 'front-royal-bins.csv'), 'utf8');
  await post(`/api/admin/sessions/${sess.id}/master?kind=bins`, binCsv, csv);

  // a believable frozen-food inventory report over the aisles the teams get
  const bins = binCsv.trim().split('\n').slice(1).map((l) => l.split(',')[0]);
  const ITEMS = [
    ['SKU-4120', 'Chicken breast IQF 40lb'], ['SKU-4180', 'Chicken thigh boneless 30lb'],
    ['SKU-2210', 'Peas petite 12x2lb'], ['SKU-2240', 'Sweetcorn supersweet 20lb'],
    ['SKU-6610', 'Salmon fillet skin-on 10lb'], ['SKU-6640', 'Cod loin 8lb'],
    ['SKU-3310', 'Fries shoestring 6x5lb'], ['SKU-3350', 'Hash brown patty 240ct'],
    ['SKU-8810', 'Blueberry wild 30lb'], ['SKU-8840', 'Strawberry sliced 20lb'],
  ];
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const AISLES = ['F01', 'F02', 'F03', 'F04', 'F05', 'F06'];
  const binsOf = (a) => bins.filter((b) => b.startsWith(a));
  const BINS_WITH_STOCK = 300;           // a freezer aisle is never full to the roof
  // most positions hold one pallet, some hold two, a few hold three or four
  const palletsIn = (i) => (i % 23 === 7 ? 4 : i % 11 === 3 ? 3 : i % 5 === 2 ? 2 : 1);

  let report = 'Pallet ID,SKU,Description,Qty,Location,Lot Code,Best Before\n';
  const expected = new Map();
  const palletAt = new Map();            // bin -> the pallet ids in it
  let seq = 0;
  for (const a of AISLES) {
    seq = 0;
    binsOf(a).slice(0, BINS_WITH_STOCK).forEach((bin, i) => {
      const here = [];
      for (let k = 0; k < palletsIn(i); k++) {
        const n = ++seq;
        const [sku, desc] = ITEMS[(i + k) % ITEMS.length];
        const id = `${a}-${String(n).padStart(3, '0')}`;
        const qty = 24 + ((n * 7) % 40);
        const lot = `L2026${String(100 + ((i * 13) % 800))}`;
        const exp = day(n % 17 === 0 ? -20 : n % 11 === 0 ? 12 : 120 + (n % 400));
        expected.set(id, { bin, qty, sku, desc, lot, exp });
        here.push(id);
        report += `${id},${sku},"${desc}",${qty},${bin},${lot},${exp}\n`;
      }
      palletAt.set(bin, here);
    });
  }
  await post(`/api/admin/sessions/${sess.id}/master?kind=pallets`, report, csv);

  await post(`/api/admin/sessions/${sess.id}/settings`, {
    guided: true, askComments: true, autoRecount: true, askLot: true, askExpiry: true,
    palletMode: 'warn', layout: 'front-royal', recountMinQty: 3, recountMinPct: 5, recountCap: 60,
  });
  await post(`/api/admin/sessions/${sess.id}/aisles/auto-block`, { size: 2, offset: 0 }).catch(() => {});
  await post('/api/admin/default-session', { sessionId: sess.id }).catch(() => {});

  // a crew, so the team plan and the equipment-reach check have something to show
  /* Between them a team has to reach every level it is given: a dock truck and
     a scissor lift for B and C, a high reach for D to F. */
  const CREW = [
    ['E1043', 'Marcus Obi', ['HIGH REACH', 'SCISSOR LIFT'], '1'], ['E1088', 'Priya Raman', ['DOCK TRUCK', 'FOOT'], '1'],
    ['E1102', 'Tom Zielinski', ['HIGH REACH', 'SCISSOR LIFT'], '2'], ['E1157', 'Ava Delgado', ['DOCK TRUCK', 'FOOT'], '2'],
    ['E1163', 'Luis Ferreira', ['HIGH REACH', 'SCISSOR LIFT'], '3'], ['E1190', 'Grace Kim', ['DOCK TRUCK', 'FOOT'], '3'],
    ['E1204', 'Nadia Haddad', ['FOOT'], ''], ['E1219', 'Owen Blackwell', ['DOCK TRUCK'], ''],
  ];
  for (const [badge, name, equipment] of CREW) {
    await post('/api/admin/people/employees', { badge, name, dept: 'Warehouse', equipment }).catch(() => {});
  }
  for (const name of ['1', '2', '3']) {
    const team = await post('/api/admin/people/teams', { name }).catch(() => null);
    if (!team || !team.id) continue;
    for (const [badge, , , t] of CREW) if (t === name) await post('/api/admin/people/assign', { badge, teamId: team.id }).catch(() => {});
  }
  const crewOf = (team) => CREW.filter(([, , , t]) => t === team).map(([b]) => b);

  const devices = [];
  for (const [name, notes] of [['SCANNER-01', 'freezer unit A'], ['SCANNER-02', 'freezer unit B'], ['SCANNER-03', 'freezer unit C'], ['SCANNER-04', 'spare, in the office']]) {
    const d = await post('/api/admin/devices', { name, notes });
    const t = (await post(`/api/devices/${d.uid}`, {}, {})).token;
    devices.push({ ...d, name, token: t, H: { ...hdr, authorization: 'Device ' + t } });
  }
  const gunOf = { 1: devices[0], 2: devices[1], 3: devices[2] };

  for (const [team, list] of [['1', ['F01', 'F02', 'F07']], ['2', ['F03', 'F04', 'F08']], ['3', ['F05', 'F06']]]) {
    await post(`/api/admin/sessions/${sess.id}/assignments`, { team, aisles: list, levels: 'A-F', force: true });
    await post(`/api/sessions/${sess.id}/signon`, { deviceId: gunOf[team].name, team, employees: crewOf(team) }, gunOf[team].H);
  }

  /* A morning's work: two aisles finished and handed back, three being counted
     now - with the handful of things that actually go wrong on a count day. */
  const SKIP = new Set(['F01-034', 'F01-062', 'F03-019']);        // pallets nobody found
  const PLAN = [
    { team: '1', aisle: 'F01', upTo: null, endsMinAgo: 95 },      // every bin, finished mid-morning
    { team: '1', aisle: 'F02', upTo: 240, endsMinAgo: 3 },
    { team: '2', aisle: 'F03', upTo: null, endsMinAgo: 70 },
    { team: '2', aisle: 'F04', upTo: 180, endsMinAgo: 9 },
    { team: '3', aisle: 'F05', upTo: 120, endsMinAgo: 1 },
  ];
  let n = 0;
  for (const { team, aisle, upTo, endsMinAgo } of PLAN) {
    const gun = gunOf[team];
    const list = binsOf(aisle).slice(0, upTo || undefined);
    const lines = [];
    for (const bin of list) {
      const here = (palletAt.get(bin) || []).filter((id) => !SKIP.has(id));
      n++;
      const at = new Date(Date.now() - endsMinAgo * 60000 - (list.length - list.indexOf(bin)) * 11000).toISOString();
      if (!(palletAt.get(bin) || []).length) {
        lines.push({ clientId: `seed-${n}`, palletId: 'EMPTY', qty: 0, emptyBin: 1, location: bin,
          aisle, team, employees: crewOf(team), deviceId: gun.name, scannedAt: at });
        continue;
      }
      for (const id of here) {                                     // every tag in the position
        const e = expected.get(id);
        lines.push({ clientId: `seed-${n}-${id}`, palletId: id, qty: e.qty, location: bin, aisle, sku: e.sku,
          team, employees: crewOf(team), deviceId: gun.name, lot: e.lot, expiry: e.exp, scannedAt: at });
      }
    }
    // what a real count turns up: a short pallet, an over-count, one in the wrong
    // bin, one with a hand-written label nobody can match to the report
    const withPallet = lines.filter((l) => l.palletId !== 'EMPTY');
    if (withPallet.length > 60) {
      withPallet[7].qty -= 14;
      withPallet[23].qty += 9;
      withPallet[38].comments = 'Shrink wrap torn';
      withPallet[51].location = binsOf(aisle)[BINS_WITH_STOCK + 12];
      withPallet[51].comments = 'Found on the wrong side of the bay';
      if (aisle === 'F02') {
        Object.assign(withPallet[60], { palletId: `HANDWRITTEN-${aisle}`, unknownPallet: 1,
          overrideReason: 'Hand-written ID', comments: 'New receipt, not on the report', lot: null, expiry: null });
      }
    }
    for (let i = 0; i < lines.length; i += 400) {
      await post(`/api/sessions/${sess.id}/counts`, lines.slice(i, i + 400), gun.H);
    }
  }

  /* a couple of words from the office, one of them already read - so the manual
     shows the card doing its job rather than empty */
  const note1 = await post(`/api/admin/sessions/${sess.id}/messages`, { team: '2', body: 'Skip F04 level D — the forklift is in it until 11' });
  await post(`/api/admin/sessions/${sess.id}/messages`, { body: 'Fifteen minute break at 10:30, leave the guns on charge', urgent: true });
  await post(`/api/sessions/${sess.id}/messages/${note1.id}/ack`, { team: '2' }, gunOf[2].H).catch(() => {});

  // the two finished aisles are handed back from the gun, which frees the racking
  const live = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { headers: A }));
  for (const [team, aisle] of [['1', 'F01'], ['2', 'F03']]) {
    const row = live.find((r) => r.team === team && r.aisle === aisle);
    if (row) await post(`/api/sessions/${sess.id}/assignments/${row.id}/complete`, { team }, gunOf[team].H).catch(() => {});
  }
  await post(`/api/admin/sessions/${sess.id}/recounts/generate`, {});

  /* Approvals and the accuracy report, so the manual can show both doing their
     job. The threshold is what keeps the list readable, which is the point the
     screenshot has to make. */
  await post(`/api/admin/sessions/${sess.id}/settings`, { requireApproval: true, approvalMinQty: 5, approvalMinPct: 5, trackAbc: true });
  await post(`/api/admin/sessions/${sess.id}/abc/derive`, {});
  // one already signed for, so the table is not a screenful of the same word
  const waiting = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/adjustments`, { headers: A }));
  const first = (waiting.adjustments || []).find((r) => r.status === 'pending');
  if (first) {
    await post(`/api/admin/sessions/${sess.id}/adjustments/decide`,
      { palletIds: [first.pallet_id], decision: 'approve', reason: 'Miscount — first count was wrong' });
  }
  // and a line on the office board, the way a shift actually starts
  await post(`/api/admin/sessions/${sess.id}/note`, { note: 'Lunch 11:30–12:00 · Team 4 breaks first · Dock 4 blocked until 2pm' });

  // an untouched count as well, so the manual can show the checklist with
  // everything still to do, which is what a first-time user actually sees
  const blank = await post('/api/admin/sessions', { name: 'October spot check' });

  /* a cycle-count programme too, so /cycle has a batch to show */
  const cyc = await post('/api/admin/sessions', { name: 'Cycle count programme 2026', mode: 'cycle' });
  await post(`/api/admin/sessions/${cyc.id}/master?kind=bins`, binCsv, csv);
  await post(`/api/admin/sessions/${cyc.id}/master?kind=pallets`, report, csv);
  await post(`/api/admin/sessions/${cyc.id}/cycle/batches`, { target: 40, strategy: 'oldest', name: `${new Date().toISOString().slice(0, 10)} · freezer sweep` }).catch(() => {});

  /* ------------------------------------------------------------ capture */
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const shots = [];
  const save = async (target, name) => {
    await target.screenshot({ path: join(OUT, `${name}.png`) });
    shots.push(name);
    process.stdout.write(`  ${name}.png\n`);
  };
  const cardOf = async (page, sel) => (await (await page.$(sel)).evaluateHandle((el) => el.closest('.card'))).asElement();
  /* A pallet report with five hundred rows is thirty thousand pixels of PNG and
     nobody reads past the tenth row. Cap the scrolling panes so each picture is
     the readable top of the table, the way it looks on a screen. */
  const saveCard = async (page, sel, name, rows = 12) => {
    const card = await cardOf(page, sel);
    await card.evaluate((el, r) => {
      for (const box of el.querySelectorAll('.scroll')) {
        box.dataset.sopHeight = box.style.maxHeight || '';
        box.style.maxHeight = `${34 + r * 31}px`;
        box.style.overflow = 'hidden';
      }
    }, rows);
    // the page header is sticky and would otherwise print across the card
    const hide = await page.addStyleTag({ content: 'header, .subtabs, .scope { visibility: hidden !important; }' });
    await save(card, name);
    await hide.evaluate((el) => el.remove());
    await card.evaluate((el) => {
      for (const box of el.querySelectorAll('.scroll')) {
        box.style.maxHeight = box.dataset.sopHeight || '';
        box.style.overflow = '';
      }
    });
  };

  /* ---------- the supervisor pages ---------- */
  const desk = await browser.newPage({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 1 });
  desk.on('dialog', (d) => d.accept());
  const signIn = async (path) => {
    await desk.goto(BASE + path);
    if (await desk.$('#scrLogin.active')) {
      await desk.fill('#fPassword', 'changeme');
      await desk.click('#btnLogin');
    }
    await desk.waitForSelector('#scrMain.active');
    await wait(1800);
  };
  const sub = async (name) => { await desk.evaluate((s) => window.appApi.showSub(s), name); await wait(1400); };
  /* Both supervisor pages default to the newest count, which is the cycle
     programme; the manual's screenshots are of the wall-to-wall. */
  const pick = async (id) => {
    const menu = await desk.$('#sessionPick .sess-btn');
    if (!menu) {                              // Settings uses a plain select
      await desk.selectOption('#fSessionPick', String(id)).catch(() => {});
      await wait(1600);
      return;
    }
    await menu.click();
    await desk.waitForSelector('#sessionPick .sess-menu:not([hidden])', { timeout: 5000 });
    await desk.click(`#sessionPick .sess-row[data-id="${id}"]`);
    await wait(1600);
  };

  await desk.goto(BASE + '/settings'); await wait(900);
  await save(desk, 'sign-in');

  await signIn('/settings');
  await pick(sess.id);
  await sub('start');  await saveCard(desk, '#startSteps', 'settings-getting-started');
  await pick(blank.id);
  await sub('start');  await saveCard(desk, '#startSteps', 'settings-getting-started-new');
  await pick(sess.id);
  await sub('start');
  await sub('logins'); await saveCard(desk, '#userTable', 'settings-logins');
  await sub('scanners');
  await saveCard(desk, '#deviceTable', 'settings-scanners');
  await saveCard(desk, '#commentList', 'settings-reason-codes');
  await saveCard(desk, '#reasonList', 'settings-adjustment-reasons');
  await sub('gun');    await saveCard(desk, '#stepOrder', 'settings-scanner-screen');
  await sub('lists');
  await saveCard(desk, '#fFile-bins', 'settings-bin-list');
  await saveCard(desk, '#aisleTable', 'settings-racking-blocks', 10);
  await sub('erp');
  await saveCard(desk, '#fErpFormat', 'settings-erp');
  await saveCard(desk, '#backupTable', 'settings-backups', 8);

  // the printable setup cards, as they come off the printer
  const cards = await browser.newPage({ viewport: { width: 1000, height: 1100 }, deviceScaleFactor: 1 });
  await cards.goto(`${BASE}/api/admin/print/scanner-cards?t=${tok}`); await wait(2500);
  await save(cards, 'scanner-setup-cards');
  await cards.close();

  await signIn('/admin');
  await pick(sess.id);
  await sub('progress');
  await saveCard(desk, '#fPalletMode', 'dashboard-count-options');
  await saveCard(desk, '#teamTable', 'dashboard-progress');
  await desk.click('#sessionPick .sess-btn').catch(() => {});
  await wait(700);
  await save(desk, 'dashboard-session-picker');
  await desk.keyboard.press('Escape'); await wait(400);
  await sub('map');
  // with an aisle picked, which is how a supervisor reads it
  await desk.click('#map g.aisle-g[data-aisle="F02"]').catch(() => {});
  await wait(1200);
  await saveCard(desk, '#mapSub', 'dashboard-map-aisle');
  await sub('teams');
  await saveCard(desk, '#teamList', 'dashboard-team-plan');
  await saveCard(desk, '#msgTable', 'dashboard-message-floor', 6);
  await sub('second'); await saveCard(desk, '#recountTable', 'dashboard-second-counts', 10);
  await sub('adjust'); await saveCard(desk, '#adjustTable', 'dashboard-adjustments', 10);
  await sub('reports');
  await saveCard(desk, '#accuracyTable', 'dashboard-accuracy', 8);
  await saveCard(desk, '#labelTable', 'dashboard-labels', 6);
  // a lot that really is in the seeded report, on a pallet in every aisle
  await desk.fill('#fLotSearch', expected.get('F01-005').lot);
  await desk.click('#btnFindLot'); await wait(1400);
  await saveCard(desk, '#lotTable', 'dashboard-find-a-lot', 8);
  // the exceptions view is the one a supervisor actually works from
  await desk.check('#fOnlyExceptions').catch(() => {});
  await wait(1800);
  await saveCard(desk, '#palletTable', 'dashboard-pallet-report', 10);
  await desk.goto(BASE + '/teams');
  await desk.waitForSelector('#scrMain.active', { state: 'attached' }); await wait(1800);
  await save(desk, 'teams-and-crew');
  await desk.goto(BASE + '/cycle');
  await desk.waitForSelector('#scrMain.active', { state: 'attached' }); await wait(2400);
  await save(desk, 'cycle-counts');
  await sub('setup'); await wait(800);
  await save(desk, 'cycle-batches');
  await desk.close();

  /* ---------- the office board ---------- */
  const board = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await board.goto(`${BASE}/board?session=${sess.id}`); await wait(2600);
  await save(board, 'office-board');
  // the note strip on its own, which is the part the manual is talking about
  const strip = await board.$('#bNote');
  if (strip) await save(strip, 'board-note');
  await board.close();

  /* ---------- the handheld ---------- */
  const gun = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
  gun.on('dialog', (d) => d.accept());
  const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await wait(500); };
  await gun.goto(`${BASE}/?d=${devices[0].uid}`);
  await gun.waitForSelector('#scrSignon.active'); await wait(1200);
  await gun.selectOption('#fSession', String(sess.id));
  await gun.fill('#fTeam', '1');
  await gun.fill('#fEmployee', 'E1043'); await gun.press('#fEmployee', 'Enter');
  await gun.fill('#fEmployee', 'E1088'); await gun.press('#fEmployee', 'Enter');
  await wait(400);
  await save(gun, 'gun-sign-on');
  await gun.click('#btnStart'); await wait(3000);
  if (await gun.$('#scrAssign.active')) await save(gun, 'gun-your-aisle');
  if (await gun.$('#scrAssign.active')) await gun.click('#btnCount');
  await gun.waitForSelector('#scrScan.active', { timeout: 90000 }); await wait(900);

  /* count a few pallets first, so the screenshots show a gun mid-aisle rather
     than one that has just signed on */
  const countOne = async (id) => {
    const p = expected.get(id);
    await scan(id); await scan(String(p.qty)); await scan(p.lot); await scan(p.exp); await scan(p.bin);
    await gun.click('#btnSkip').catch(() => {});
    await wait(700);
  };
  const f02 = binsOf('F02');
  // the first uncounted position in this team's aisle, and one that holds more
  // than a single pallet, so the manual can show both banners
  const countedHere = [];
  const firstOpen = f02.slice(240).find((b) => (palletAt.get(b) || []).length === 1);
  countedHere.push(firstOpen);
  const multi = f02.slice(240).find((b) => (palletAt.get(b) || []).length > 2);
  for (const id of palletAt.get(firstOpen) || []) await countOne(id);
  await save(gun, 'gun-step-pallet-mid');

  // a position with three tags in it: the guide stays put until they are all in
  const stack = palletAt.get(multi) || [];
  {
    const p1 = expected.get(stack[0]);
    await scan(stack[0]); await scan(String(p1.qty)); await scan(p1.lot); await scan(p1.exp); await scan(p1.bin);
    await gun.click('#btnSkip').catch(() => {});
    await wait(800);
    await save(gun, 'gun-bin-more-tags');
    for (const id of stack.slice(1)) await countOne(id);
    await wait(600);
  }

  const nextBin = f02.slice(240).find((b) => (palletAt.get(b) || []).length === 1 && !countedHere.includes(b));
  countedHere.push(nextBin, multi);
  const nextId = (palletAt.get(nextBin) || [])[0];
  const e = expected.get(nextId);
  await scan(nextId);
  await save(gun, 'gun-pallet-scanned');
  await scan(String(e.qty));
  await save(gun, 'gun-step-lot');
  await scan(e.lot);
  await scan(e.exp);
  await save(gun, 'gun-step-bin');
  await scan(e.bin);
  await wait(600);
  await save(gun, 'gun-step-comments');
  await gun.click('#btnSkip'); await wait(900);

  // the override screen: a pallet that is not on the report
  await scan('NO-LABEL-4471'); await wait(900);
  if (await gun.$('#scrOverride.active')) {
    await save(gun, 'gun-override');
    await gun.selectOption('#fReason', 'Hand-written ID').catch(() => {});
    await gun.fill('#fReasonNote', 'Tag written by receiving');
    await wait(300);
    await save(gun, 'gun-override-reason');
  }
  await gun.click('#btnOverrideCancel'); await wait(600);

  // a word from the office, waiting on the counting screen
  await post(`/api/admin/sessions/${sess.id}/messages`, { team: '1', urgent: true,
    body: 'Bring the pallet jack back to the dock when you finish this aisle' });
  await gun.evaluate(() => window.dispatchEvent(new Event('online')));
  await gun.waitForFunction(() => {
    const el = document.getElementById('msgBar');
    return el && !el.hidden;
  }, null, { timeout: 40000, polling: 700 }).catch(() => {});
  await save(gun, 'gun-message');
  await gun.click('#btnMsgAck').catch(() => {});
  await wait(900);

  // two labels on one pallet
  await gun.click('#btnSameLabel'); await wait(500);
  await save(gun, 'gun-second-label-ask');
  await scan('OLD-TAG-88');
  await wait(900);
  await save(gun, 'gun-second-label-done');

  // a label that will not scan
  await gun.click('#btnNoScan'); await wait(600);
  await save(gun, 'gun-no-scan');
  await gun.click('#btnNoScan'); await wait(400);          // put the choices away again

  /* and the same question about the label on the racking, which is the one
     every counter after this one walks up to */
  const rackId = (palletAt.get(f02.slice(240).find((b) => (palletAt.get(b) || []).length === 1
    && !(countedHere || []).includes(b))) || [])[0];
  if (rackId) {
    const r = expected.get(rackId);
    await scan(rackId); await scan(String(r.qty)); await scan(r.lot); await scan(r.exp);
    await gun.click('#btnNoScan'); await wait(600);
    await save(gun, 'gun-no-scan-bin');
    await gun.click('#btnNoScanNone'); await wait(1200);   // takes the bin the guide is on
    await gun.click('#btnSkip').catch(() => {});
    await wait(800);
  }

  await gun.click('#btnHistory'); await wait(1200);
  if (await gun.$('#scrHistory.active')) await save(gun, 'gun-history');
  await gun.close();

  console.log(`\n${shots.length} screenshots written to docs/images/`);
} finally {
  if (browser) await browser.close();
  server.kill();
  await wait(300);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
