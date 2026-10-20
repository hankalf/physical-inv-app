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
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'demo.db'), SUPERADMIN_USER: 'DANA-WHITFIELD', SUPERADMIN_NAME: 'Dana Whitfield', SUPERADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* still starting */ }
    await wait(200);
  }

  /* ------------------------------------------------------------- seed */
  const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'DANA-WHITFIELD', password: 'changeme' }) }))).token;
  const A = { ...hdr, authorization: 'Bearer ' + tok };
  const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
  const post = (p, body, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) }).then(j);

  for (const u of [
    { username: 'MARCUS-OBI', name: 'Marcus Obi', password: 'dock-side-77', mustChange: false, profile: 'supervisor' },
    { username: 'IVY-CHEN', name: 'Ivy Chen', password: 'cold-room-11', mustChange: false, profile: 'inventory' },
    { username: 'LUIS-FERREIRA', name: 'Luis Ferreira', password: 'reach-truck-4', mustChange: true, profile: 'floor' },
  ]) await post('/api/admin/users', u).catch(() => {});
  await post('/api/admin/pallet-system', { url: 'https://wms.example.com/pallets' }).catch(() => {});
  const sess = await post('/api/admin/sessions', { name: 'Q3 2026 wall-to-wall' });
  const binCsv = readFileSync(join(ROOT, 'tests', 'fixtures', 'front-royal-bins.csv'), 'utf8');
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

  let report = 'Pallet ID,SKU,Description,Qty,Location,Lot Code,Best Before,System\n';
  const SYSTEMS = ['WMS', 'ERP', 'Legacy'];
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
        report += `${id},${sku},"${desc}",${qty},${bin},${lot},${exp},${SYSTEMS[n % 11 < 6 ? 0 : n % 11 < 9 ? 1 : 2]}\n`;
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
  /* the departments and gear sizes the Gear sizes tab adds up; one left blank, as there always is */
  const SIZES = { E1043: ['Warehouse', 'XL', 'XL', '11'], E1088: ['Warehouse', 'M', 'M', '8.5'], E1102: ['Warehouse', '2XL', 'XL', '12'],
    E1157: ['Production', 'S', 'M', '7'], E1163: ['Warehouse', 'L', 'L', '10.5'], E1190: ['Production', 'M', 'S', '8'],
    E1204: ['Production', 'L', 'L', '9'], E1219: ['Warehouse', 'XL', '2XL', ''] };
  for (const [badge, name, equipment] of CREW) {
    await post('/api/admin/people/employees', { badge, name, dept: 'Warehouse', equipment }).catch(() => {});
    const [dept, jacket, bibs, boots] = SIZES[badge] || [];
    if (dept) await post(`/api/admin/people/employees/${badge}/gear`, { dept, jacket, bibs, boots }).catch(() => {});
  }
  // teams 1 and 2 work days, team 3 nights: the crew board has both shifts to show
  const SHIFT_OF = { 1: '1', 2: '1', 3: '2' };
  for (const name of ['1', '2', '3']) {
    const team = await post('/api/admin/people/teams', { name, shift: SHIFT_OF[name] }).catch(() => null);
    if (!team || !team.id) continue;
    for (const [badge, , , t] of CREW) if (t === name) {
      await post('/api/admin/people/assign', { badge, teamId: team.id }).catch(() => {});
      await post(`/api/admin/people/employees/${badge}`, { shift: SHIFT_OF[name] }).catch(() => {});
    }
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

  /* a cycle-count program too, so /cycle has a batch to show */
  const cyc = await post('/api/admin/sessions', { name: 'Cycle count program 2026', mode: 'cycle' });
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
  let desk = await browser.newPage({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 1 });
  desk.on('dialog', (d) => d.accept());
  const signIn = async (path) => {
    await desk.goto(BASE + path);
    if (await desk.$('#scrLogin.active')) {
      await desk.fill('#fUser', 'DANA-WHITFIELD');
      await desk.fill('#fPassword', 'changeme');
      await desk.click('#btnLogin');
    }
    await desk.waitForSelector('#scrMain.active');
    await wait(1800);
  };
  const sub = async (name) => { await desk.evaluate((s) => window.appApi.showSub(s), name); await wait(1400); };
  /* Both supervisor pages default to the newest count, which is the cycle
     program; the manual's screenshots are of the wall-to-wall. */
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
  await saveCard(desk, '#readyList', 'settings-ready', 14);
  await saveCard(desk, '#fPalletMode', 'settings-count-session');
  await sub('gun');    await saveCard(desk, '#stepOrder', 'settings-scanner-screen');
  await saveCard(desk, '#btnBookTemplate', 'settings-barcode-book');
  await saveCard(desk, '#deviceTable', 'settings-scanners');
  await desk.uncheck('#fJobCycle').catch(() => {}); await desk.uncheck('#fJobMove').catch(() => {}); await desk.uncheck('#fJobMissing').catch(() => {});
  await desk.click('#btnSaveOffers').catch(() => {}); await wait(1200);
  await saveCard(desk, '#fJobFull', 'settings-jobs');
  await desk.check('#fJobCycle').catch(() => {}); await desk.check('#fJobMove').catch(() => {}); await desk.check('#fJobMissing').catch(() => {});
  await desk.click('#btnSaveOffers').catch(() => {}); await wait(1200);
  await saveCard(desk, '#commentList', 'settings-reason-codes');
  await saveCard(desk, '#sosList', 'settings-sos');
  await sub('lists');
  await saveCard(desk, '#fFile-bins', 'settings-bin-list');
  await saveCard(desk, '#aisleTable', 'settings-racking-blocks', 10);
  await sub('erp');
  await saveCard(desk, '#fErpFormat', 'settings-erp');
  await saveCard(desk, '#reasonList', 'settings-adjustment-reasons');
  await saveCard(desk, '#btnSaveTeams', 'settings-teams-channel');
  await saveCard(desk, '#fPalletSystemUrl', 'settings-pallet-system');
  await sub('backups');
  await saveCard(desk, '#backupTable', 'settings-backups', 6);
  await saveCard(desk, '#fOdClient', 'settings-onedrive');
  await sub('logins');
  /* an invite: a login added with an email gets a link, not a password */
  await desk.fill('#fNewUser', 'ROSA-D'); await desk.fill('#fNewFullName', 'Rosa Delgado');
  await desk.fill('#fNewEmail', 'rosa.delgado@example.com');
  await desk.selectOption('#fNewRole', 'inventory').catch(() => {});
  await desk.click('#btnAddUser'); await wait(1500);
  await saveCard(desk, '#inviteBox', 'settings-invite');
  const inviteLinkUrl = await desk.$eval('#inviteLink', (i) => i.value).catch(() => '');
  await saveCard(desk, '#userTable', 'settings-logins');
  /* the access list, open on one login: what a supervisor may use, down to the tab */
  {
    const row = desk.locator('#userTable tr', { hasText: 'MARCUS-OBI' }).first();
    const pickBtn = row.locator('details.accpick summary');
    if (await pickBtn.count()) {
      await pickBtn.click(); await wait(700);
      const box = await desk.$('#userTable');
      const r = await box.boundingBox();
      const pop = await desk.$('.accpanel');
      const pr = pop ? await pop.boundingBox() : null;
      const top = Math.max(0, Math.min(r.y, pr ? pr.y : r.y) - 60);
      const bottom = Math.max(r.y + Math.min(r.height, 300), pr ? pr.y + pr.height : 0) + 12;
      await save({ screenshot: (o) => desk.screenshot({ ...o, clip: { x: Math.max(0, r.x - 10), y: top, width: Math.min(1540, r.width + 20), height: Math.min(900, bottom - top) } }) }, 'settings-access');
      await desk.evaluate(() => document.querySelectorAll('details.accpick[open]').forEach((d) => { d.open = false; }));
      await desk.mouse.click(4, 4); await wait(400);
    }
  }
  await sub('advanced');
  await saveCard(desk, '#featuresList', 'settings-features', 10);
  await saveCard(desk, '#lookPick', 'settings-appearance');
  await saveCard(desk, '#fSiteName', 'settings-site-name');
  await saveCard(desk, '#fLogo', 'settings-logo');

  /* the invite as Rosa sees it, on her phone */
  if (inviteLinkUrl) {
    const rosa = await (await browser.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, isMobile: true })).newPage();
    await rosa.goto(inviteLinkUrl); await wait(1500);
    await save(rosa, 'invite-welcome');
    await rosa.context().close();
  }

  // the printable setup cards, as they come off the printer
  const cards = await browser.newPage({ viewport: { width: 1000, height: 1100 }, deviceScaleFactor: 1 });
  await cards.goto(`${BASE}/api/admin/print/scanner-cards?t=${tok}`); await wait(2500);
  await save(cards, 'scanner-setup-cards');
  await cards.close();

  // Inventory Control: the dashboard's three tabs on a page of their own, and its overview
  await signIn('/inventory');
  await pick(sess.id);
  await sub('overview');
  await wait(1200);
  await saveCard(desk, '#icOverview .card', 'inventory-control-overview', 0);

  await signIn('/admin');
  await pick(sess.id);
  await sub('progress');
  await saveCard(desk, '#teamTable', 'dashboard-progress');
  if (await desk.$('#bySystem:not([hidden])')) await saveCard(desk, '#bySystem', 'dashboard-systems');
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
  await sub('alerts');
  await saveCard(desk, '#msgTable', 'dashboard-message-floor', 6);
  await sub('second'); await saveCard(desk, '#recountTable', 'dashboard-second-counts', 10);
  /* an SOS waiting to be answered, which is what the bar above the page is for */
  await post(`/api/sessions/${sess.id}/alerts`, {
    clientId: 'sop-sos', reason: 'Racking or a pallet looks unsafe', detail: 'Bay 12 in F04 is leaning',
    team: '2', deviceId: 'SCANNER-02', employees: ['E1102', 'E1157'], aisle: 'F04', bin: 'F04A012',
  }, gunOf[2].H).catch(() => {});
  /* The dashboard looks for alerts every few seconds on its own - no reload,
     which would send the page back to whichever count it defaults to. */
  await sub('alerts');
  await desk.waitForFunction(() => {
    const el = document.getElementById('sosAlert');
    return el && !el.hidden && el.textContent.trim();
  }, null, { timeout: 30000 }).catch(() => {});
  const sosBar = await desk.$('#sosAlert');
  if (sosBar && !(await sosBar.evaluate((el) => el.hidden))) await save(sosBar, 'dashboard-sos');
  await saveCard(desk, '#sosTable', 'dashboard-alerts', 6);
  await sub('adjust'); await saveCard(desk, '#adjustTable', 'dashboard-adjustments', 10);
  await desk.waitForSelector('#erpAislesTable tbody tr[data-aisle]', { timeout: 8000 }).catch(() => {});
  await saveCard(desk, '#erpAislesTable', 'dashboard-erp-aisles', 8);
  await sub('reports');
  await saveCard(desk, '#fixTable', 'dashboard-fix-list', 6);
  // a lot that really is in the seeded report, on a pallet in every aisle
  await desk.fill('#fLotSearch', expected.get('F01-005').lot);
  await desk.click('#btnFindLot'); await wait(1400);
  await saveCard(desk, '#lotTable', 'dashboard-find-a-lot', 8);
  // the exceptions view is the one a supervisor actually works from
  await desk.check('#fOnlyExceptions').catch(() => {});
  await wait(1800);
  await saveCard(desk, '#palletTable', 'dashboard-pallet-report', 10);
  /* the office side on a phone: installed from the home screen, the menu folded away */
  {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
    await phone.goto(BASE + '/admin'); await wait(800);
    await phone.fill('#fUser', 'DANA-WHITFIELD'); await phone.fill('#fPassword', 'changeme');
    await phone.click('#btnLogin'); await phone.waitForSelector('#scrMain.active'); await wait(1800);
    await save(phone, 'phone-dashboard');
    await phone.click('#navMenuBtn'); await wait(500);
    await save(phone, 'phone-menu');
    await phone.context().close();
  }
  /* the search box, with the panel open - the one picture that explains it */
  /* a pallet with a variance on it: the search shows the pallet, the second
     count raised for it and the adjustment waiting to be signed, all at once */
  await desk.fill('#navSearch', String(first ? first.pallet_id : 'F01-008'));
  await desk.waitForTimeout(1200);
  await save({ screenshot: (o) => desk.screenshot({ ...o, clip: { x: 0, y: 0, width: 760, height: 620 } }) }, 'search');
  await desk.fill('#navSearch', '');
  await desk.keyboard.press('Escape');
  await desk.waitForTimeout(300);

  await desk.goto(BASE + '/teams');
  await desk.waitForSelector('#scrMain.active', { state: 'attached' }); await wait(1800);
  await save(desk, 'teams-and-crew');
  /* a crew card with its department and sizes open, then the Gear sizes tab */
  await desk.click('.person[data-badge="E1204"] [data-gear-edit]').catch(() => {}); await wait(400);
  { const c = await desk.$('.person[data-badge="E1204"]'); if (c) await save(c, 'teams-gear-card'); }
  await sub('people'); await wait(800);
  await desk.click('#peopleTable button[data-edit="E1157"]').catch(() => {}); await wait(400);
  await saveCard(desk, '#peopleTable', 'teams-employees', 12);
  await desk.click('#peopleTable button[data-edit="E1157"]').catch(() => {}); await wait(300);
  await sub('gear'); await wait(800);
  await saveCard(desk, '#gearTable', 'teams-gear-sizes', 8);
  await sub('crew');
  await desk.goto(BASE + '/cycle');
  await desk.waitForSelector('#scrMain.active', { state: 'attached' }); await wait(2400);
  await save(desk, 'cycle-counts');
  await sub('setup'); await wait(800);
  await save(desk, 'cycle-batches');

  /* ---------- front bins: the pallets to move back, and the desk ---------- */
  await post(`/api/admin/sessions/${sess.id}/moves/build`, { aisle: 'F03 F04' }).catch(() => {});
  /* a few moves of our own, so the list and the desk have something in hand,
     and the office board standing in for the pallet system's screen */
  const mv = ['F05A001', 'F05A003', 'F06A001'].map((b, i) => [(palletAt.get(b) || [])[0], b, b.replace(/\d{3}$/, (n) => String(Number(n) + 1).padStart(3, '0'))]).filter(([p]) => p);
  /* Front bins works from the site's newest bin list, which is the cycle program's here */
  for (const sid of [sess.id, cyc.id]) await fetch(`${BASE}/api/admin/sessions/${sid}/moves/import`, { method: 'POST', headers: csv, body: 'Pallet,From bin,To bin\n' + mv.map((r) => r.join(',')).join('\n') + '\n' }).catch(() => {});
  await post('/api/admin/pallet-system', { url: `${BASE}/board?session=${sess.id}` }).catch(() => {});
  await desk.goto(BASE + '/front');
  await desk.waitForSelector('#scrMain.active', { state: 'attached' }); await wait(2000);
  await sub('moves'); await wait(600);
  await saveCard(desk, '#mvTable', 'front-moves', 8);
  await sub('desk'); await wait(3000);
  await saveCard(desk, '#deskStrip', 'front-move-desk');
  await post('/api/admin/pallet-system', { url: 'https://wms.example.com/pallets' }).catch(() => {});

  /* ---------- the Testing tab: signed on, a few pallets in ---------- */
  await signIn('/testing');
  await desk.waitForSelector('#shelves table.shelf');
  const tgun = async () => {
    for (let i = 0; i < 60; i++) {
      const f = desk.frames().find((x) => /practice=1/.test(x.url()));
      if (f && await f.evaluate(() => typeof window.wedge === 'function').catch(() => false)) return f;
      await wait(150);
    }
    return null;
  };
  const tg = await tgun();
  if (tg) {
    const tap = async (text) => { await desk.locator('#shelves .scan, .signon .scan', { hasText: new RegExp(`^${text}$`) }).first().click(); await wait(400); };
    await tap('99'); await tap('T1001');
    await tg.click('#btnStart'); await wait(1800);
    await tg.click('#btnCount').catch(() => {}); await wait(600);
    for (const [pal, , b] of [['F12311-111', '40', 'F01A001'], ['F12312-111', '32', 'F01A002']]) {
      await tap(pal);
      await desk.locator('#shelves tr', { has: desk.locator('.scan', { hasText: new RegExp(`^${pal}$`) }) }).locator('.scan.qty').click(); await wait(400);
      await tap(b);
      if (await tg.isVisible('#btnSkip')) { await tg.click('#btnSkip'); await wait(500); }
    }
    await tap('F12312-112');
    await wait(3500);                        // the sheet's own refresh
    await desk.evaluate(() => window.scrollTo(0, 0));
    await save(desk, 'testing-tab');
    // the other jobs: the cycle count's list, set up with one click
    if (await desk.$('#modeList button[data-mode="cycle"]')) {
      await desk.click('#modeList button[data-mode="cycle"]'); await wait(2500);
      await saveCard(desk, '#modeList', 'testing-modes', 8);
    }
    if (await desk.$('#modeList button[data-mode="second"]')) {
      await desk.click('#modeList button[data-mode="second"]'); await wait(2500);
      await saveCard(desk, '#modePane', 'testing-second-counts', 8);
    }
  }
  /* ---------- folded cards: Settings → Scanners the way a person sees it ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('fold:test', '1'); } catch { /* */ } });
    const fp = await ctx.newPage();
    await fp.goto(BASE + '/settings#gun');
    await fp.fill('#fUser', 'DANA-WHITFIELD'); await fp.fill('#fPassword', 'changeme');
    await fp.click('#btnLogin'); await fp.waitForSelector('#scrMain.active'); await wait(1800);
    await fp.evaluate(() => window.appApi.showSub('gun')); await wait(800);
    const pane = await fp.$('[data-sub="gun"]');
    if (pane) await save(pane, 'settings-folded');
    await ctx.close();
  }

  /* ---------- Practice data: every login's practice, for an admin ---------- */
  await desk.goto(BASE + '/practice');
  await desk.waitForSelector('#pdTable tbody tr', { timeout: 15000 }).catch(() => {}); await wait(1200);
  await desk.click('#pdTable tr[data-run] button.linkish').catch(() => {}); await wait(400);
  await saveCard(desk, '#pdTable', 'practice-data', 10);

  /* ---------- Full Counts ---------- */
  await desk.goto(BASE + '/full');
  await desk.waitForSelector('#fcTable tbody tr', { timeout: 15000 }).catch(() => {}); await wait(1500);
  await saveCard(desk, '#fcTable', 'full-counts', 8);

  /* ---------- filed as the count goes ---------- */
  {
    const asg = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/assignments`, { headers: A })).json();
    // another team's aisle: team 1's is the one the handheld shots count in later
    const list = Array.isArray(asg) ? asg : [];
    const done = list.find((a) => a.team !== '1' && a.status === 'active') || list.find((a) => a.team !== '1');
    if (done) await post(`/api/admin/sessions/${sess.id}/assignments/${done.id}`, { status: 'done' }).catch(() => {});
    await desk.goto(BASE + '/admin#reports');
    await desk.waitForSelector('#scrMain.active', { state: 'attached' }); await wait(1500);
    await desk.evaluate((id) => window.appApi.pickSession && window.appApi.pickSession(id), sess.id); await wait(2500);
    await saveCard(desk, '#archiveTable', 'dashboard-filed', 6);
  }

  /* ---------- Not in Location: the find desk ---------- */
  await post('/api/admin/missing', { pallet: 'FR10257294', sku: '2301', description: 'Blueberry wild 30lb', qty: 24, last: 'A02C019' }).catch(() => {});
  await post('/api/admin/pallet-system', { url: `${BASE}/board?session=${sess.id}` }).catch(() => {});
  await desk.goto(BASE + '/missing');
  await desk.waitForSelector('#scrMain.active', { state: 'attached' }); await wait(2500);
  await saveCard(desk, '#fdDeskStrip', 'missing-desk');

  /* ---------- the desks on a gun: Front2Back and Not in Location ---------- */
  {
    const jd = await post('/api/admin/devices', { name: 'SCANNER-07' });
    const g = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
    await g.goto(`${BASE}/?d=${jd.uid}`); await wait(1500);
    if (await g.isVisible('#btnModeMove')) {
      await g.click('#btnModeMove'); await wait(300);
      await g.fill('#fEmployee', 'E1088'); await g.press('#fEmployee', 'Enter');
      await g.click('#btnStart'); await g.waitForSelector('#scrMove.active', { timeout: 10000 }).catch(() => {}); await wait(800);
      await save(g, 'gun-move-aisles');
      if (await g.$('#moveAisles button')) { await g.click('#moveAisles button >> nth=0'); await wait(2500); await save(g, 'gun-move-desk'); }
      await g.click('#btnMoveSignoff').catch(() => {}); await wait(800);
    }
    await g.goto(`${BASE}/?d=${jd.uid}`); await wait(1500);
    if (await g.isVisible('#btnModeFind')) {
      await g.click('#btnModeFind'); await wait(300);
      await g.fill('#fEmployee', 'E1088'); await g.press('#fEmployee', 'Enter');
      await g.click('#btnStart'); await g.waitForSelector('#scrFind.active', { timeout: 10000 }).catch(() => {}); await wait(800);
      if (await g.$('#findAisles button')) { await g.click('#findAisles button >> nth=0'); await wait(2500); await save(g, 'gun-find-desk'); }
    }
    await g.close();
  }
  await post('/api/admin/pallet-system', { url: 'https://wms.example.com/pallets' }).catch(() => {});

  /* ---------- the user guide: a question answered, a journey open ---------- */
  await signIn('/guide');
  await desk.waitForSelector('#journeys .journey'); await wait(1200);
  await desk.fill('#askInput', 'the gun says offline'); await wait(400);
  await saveCard(desk, '#askInput', 'guide-ask');
  await desk.fill('#askInput', ''); await wait(200);
  await saveCard(desk, '#nowList', 'guide-now');
  await desk.click('#journeys .journey[data-key="day"]'); await wait(400);
  await desk.evaluate(() => { const c = document.querySelector('#stepsCard'); c.style.maxHeight = '760px'; c.style.overflow = 'hidden'; });
  await saveCard(desk, '#steps', 'guide-steps');
  await desk.close();

  /* ---------- the office board ---------- */
  const board = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await board.goto(`${BASE}/board?session=${sess.id}`); await wait(2600);
  await save(board, 'office-board');
  // the note strip on its own, which is the part the manual is talking about
  const strip = await board.$('#bNote');
  if (strip) await save(strip, 'board-note');
  await board.close();

  /* ---------- the crew board: who is on which team, by shift ---------- */
  const crew = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await crew.goto(`${BASE}/crew?session=${sess.id}`); await wait(2600);     // the count the manual's teams are on
  await save(crew, 'crew-board');
  await crew.close();

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

  // a pallet that is not on the report: a plain yes or no
  await scan('NO-LABEL-4471'); await wait(900);
  if (await gun.$('#scrOverride.active')) {
    await save(gun, 'gun-override');
    await gun.click('#btnOvNo'); await wait(600);
  }
  // everything else that stops the gun asks why: here, a pallet already counted
  const again = (palletAt.get(firstOpen) || [])[0];
  if (again) {
    await scan(again); await wait(900);
    if (await gun.$('#scrOverride.active')) {
      await gun.selectOption('#fReason', 'Relabeled').catch(() => {});
      await gun.fill('#fReasonNote', 'old label left on');
      await wait(300);
      await save(gun, 'gun-override-reason');
      await gun.click('#btnOverrideCancel'); await wait(600);
    }
  }

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

  // the SOS list, as a counter sees it
  await gun.click('#btnSos'); await wait(900);
  // the question, then the list: a screen shot half way down explains nothing
  await gun.evaluate(() => { document.querySelector('main')?.scrollTo(0, 0); window.scrollTo(0, 0); });
  await wait(300);
  await save(gun, 'gun-sos');
  await gun.click('#btnSosBack'); await wait(600);

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

  /* ================= the how-to guides (docs/guides/) =================
     Last of all, so nothing they set up - a third count, a TEST system -
     shows in the manual's own pictures above. Each part is on its own: one
     that fails is said, and the rest still run. */
  // the supervisor tab was closed above: a fresh one, which signIn, sub and saveCard all use
  desk = await browser.newPage({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 1 });
  desk.on('dialog', (d) => d.accept());
  const part = async (what, fn) => { try { await fn(); } catch (err) { console.log(`  (guide shots: ${what} skipped - ${err.message})`); } };
  /* An export as a table on screen, the way it opens in Excel: the columns
     that matter for the picture, the first rows. */
  const sheetShot = async (name, columns, rows, { fill = null, widths = {}, file = name } = {}) => {
    const page = await browser.newPage({ viewport: { width: 1500, height: 700 }, deviceScaleFactor: 1 });
    const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const head = columns.map((c, i) => `<th style="${widths[c] ? `width:${widths[c]}px` : ''}">${String.fromCharCode(65 + i)}</th>`).join('');
    const body = rows.map((r, n) => `<tr><td class="rn">${n + 2}</td>${columns.map((c) => `<td class="${fill && fill(c, r) ? 'fill' : ''}">${esc(r[c])}</td>`).join('')}</tr>`).join('');
    await page.setContent(`<!doctype html><style>
      body{margin:0;font:12px Calibri,Carlito,Arial,sans-serif;background:#fff;color:#111}
      .bar{background:#217346;color:#fff;padding:6px 12px;font-weight:600}
      table{border-collapse:collapse;margin:0}
      th,td{border:1px solid #d4d4d4;padding:3px 6px;white-space:nowrap;text-align:left}
      th{background:#f3f3f3;font-weight:400;color:#777;text-align:center}
      td.rn,th:first-child{background:#f3f3f3;color:#777;text-align:center;width:28px}
      td.fill{background:#e2f0d9;font-weight:700;color:#1d5c2c}
    </style><div class="bar">${esc(file)}</div><table><tr><th></th>${head}</tr><tr><td class="rn">1</td>${columns.map((c) => `<td><b>${esc(c)}</b></td>`).join('')}</tr>${body}</table>`);
    const tbl = await page.$('body');
    await page.setViewportSize({ width: Math.min(1500, Math.ceil(await page.evaluate(() => document.querySelector('table').scrollWidth)) + 4), height: 700 });
    await save({ screenshot: (o) => tbl.screenshot(o) }, name.replace(/^guide-/, 'guide-'));
    await page.close();
  };

  /* ---- second and third counts */
  await part('third counts', async () => {
    await post(`/api/admin/sessions/${sess.id}/settings`, { thirdCount: true });
    const all = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/recounts`, { headers: A }));
    const open = all.filter((t) => t.status === 'open' && t.reason !== 'CYCLE' && t.first_team === '1' && t.pallet_id);
    const [one, two] = open;
    if (!one) throw new Error('no open second count from team 1');
    // one second count that agrees with nobody: a third count follows
    await post(`/api/sessions/${sess.id}/recounts/${one.id}/take`, { team: '2' }, gunOf[2].H);
    await post(`/api/sessions/${sess.id}/counts`, [{ clientId: 'guide-2nd-a', palletId: one.pallet_id, qty: 7, location: one.bin, team: '2', deviceId: gunOf[2].name, pass: 2, recountId: one.id, scannedAt: new Date().toISOString() }], gunOf[2].H);
    await post(`/api/sessions/${sess.id}/recounts/${one.id}/done`, { team: '2' }, gunOf[2].H);
    // and one that agrees with the first count: settled, the difference is real
    if (two) {
      const firsts = String(two.first_result || '').split(', ').map((x) => x.split(' ×')).filter((x) => x[0]);
      await post(`/api/sessions/${sess.id}/recounts/${two.id}/take`, { team: '3' }, gunOf[3].H);
      await post(`/api/sessions/${sess.id}/counts`, firsts.map(([p, q], i) => ({ clientId: `guide-2nd-b${i}`, palletId: p, qty: Number(q), location: two.bin, team: '3', deviceId: gunOf[3].name, pass: 2, recountId: two.id, scannedAt: new Date().toISOString() })), gunOf[3].H);
      await post(`/api/sessions/${sess.id}/recounts/${two.id}/done`, { team: '3' }, gunOf[3].H);
    }
    const third = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/recounts`, { headers: A }))).find((t) => Number(t.round) === 3);
    if (!third) throw new Error('no third count was raised');
    await post(`/api/admin/sessions/${sess.id}/recounts/${third.id}`, { team: '3' });
    // the option, on the count's settings
    await signIn('/settings');
    await pick(sess.id).catch(() => {});
    await sub('start');
    const fs = await desk.$('#fThirdCount');
    if (fs) { const box = (await fs.evaluateHandle((el) => el.closest('.fieldset'))).asElement(); if (box) await save(box, 'guide-third-count-option'); }
    // the dashboard: the third count with its second count above it
    await signIn('/admin'); await pick(sess.id); await sub('second');
    await desk.waitForSelector(`#recountTable tr[data-recount="${third.id}"]`, { timeout: 8000 });
    // the rows the guide talks about, at the top: the second count that settled nothing, its third, and one that agreed
    await desk.evaluate(({ keep }) => {
      const body = document.querySelector('#recountTable tbody');
      const rows = [...body.querySelectorAll('tr')];
      for (const tr of rows) if (!keep.includes(Number(tr.dataset.recount))) tr.style.display = 'none';
      for (const id of [...keep].reverse()) { const tr = rows.find((x) => Number(x.dataset.recount) === id); if (tr) body.prepend(tr); }
    }, { keep: [one.id, third.id, ...(two ? [two.id] : [])] });
    await saveCard(desk, '#recountTable', 'guide-dashboard-third-count', 12);
    await desk.reload(); await desk.waitForSelector('#scrMain.active'); await wait(1200);
    // the export, as it opens in Excel
    const sbs = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/recounts-side-by-side`, { headers: A }));
    const rows = sbs.sheets[1].rows;
    const pickRows = [...rows.filter((r) => r.Bin === third.bin), ...rows.filter((r) => two && r.Bin === two.bin), ...rows.filter((r) => r.Bin !== third.bin && (!two || r.Bin !== two.bin))].slice(0, 9);
    await sheetShot('guide-export-second-third', ['Bin', 'Pallet', 'Report quantity', '1st count', '1st count team', '2nd count', '2nd count team', '3rd count', '3rd count team', 'Final count', 'Final count is the', 'Which number stands', 'State'], pickRows,
      { fill: (c, r) => c === 'Final count' && r['Final count'] !== '', file: sbs.filename });
    // the gun, on the third count
    const g = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
    g.on('dialog', (d) => d.accept());
    await g.goto(`${BASE}/?d=${gunOf[3].uid}`);
    await g.waitForSelector('#scrSignon.active, #scrAssign.active', { timeout: 15000 }); await wait(1200);
    if (await g.$('#scrSignon.active')) {
      await g.selectOption('#fSession', String(sess.id)).catch(() => {});
      await g.fill('#fTeam', '3');
      for (const b of crewOf('3')) { await g.fill('#fEmployee', b); await g.press('#fEmployee', 'Enter'); }
      await g.click('#btnStart'); await wait(3000);
    }
    if (await g.$('#scrAssign.active')) { await save(g, 'guide-gun-recounts-available'); await g.click('#btnRecounts').catch(() => {}); await wait(2500); }
    if (await g.isVisible('#btnMsgAck')) { await g.click('#btnMsgAck'); await wait(600); }   // the break message from earlier
    await g.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); document.querySelector('#scrScan')?.scrollIntoView({ block: 'start' }); });
    await wait(500);
    if (await g.isVisible('#recountBanner')) await save(g, 'guide-gun-third-count');
    await g.close();
  });

  /* ---- the ERP, an aisle at a time */
  await part('erp aisles', async () => {
    const sheet = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/erp-aisle?aisle=F01`, { headers: A }));
    const rows = sheet.sheets[0].rows.slice(0, 12).map((r, i) => ({ ...r, 'Uploaded to ERP': i < 7 ? 'yes' : '' }));
    await sheetShot('guide-export-erp-aisle', ['Bin', 'Pallet', 'Item', 'Report quantity', 'Counted quantity', 'Adjustment', 'Result', 'Count', 'Uploaded to ERP', 'Uploaded by', 'Uploaded at', 'Changed since uploaded'], rows,
      { fill: (c, r) => c === 'Uploaded to ERP' && r[c], file: sheet.filename });
    await signIn('/admin'); await pick(sess.id); await sub('adjust');
    await desk.waitForSelector('#erpAislesTable tbody tr[data-aisle]', { timeout: 8000 });
    await saveCard(desk, '#erpAislesTable', 'guide-erp-aisles-before', 8);
    // the filled-in sheet back, as the upload button sends it
    const back = 'Pallet,Uploaded to ERP\n' + sheet.sheets[0].rows.map((r) => `${r.Pallet},yes`).join('\n') + '\n';
    await fetch(`${BASE}/api/admin/sessions/${sess.id}/erp-entries/upload?aisle=F01`, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' }, body: back });
    await desk.reload(); await desk.waitForSelector('#scrMain.active'); await wait(1500);
    await sub('adjust');
    await desk.evaluate(() => {
      const m = document.getElementById('erpAislesMsg');
      if (m) { m.className = 'feedback show ok'; m.innerHTML = '<b>Aisle-F01-for-ERP.xlsx: ' + document.querySelector('#erpAislesTable tr[data-aisle="F01"] td:nth-child(2)').textContent + ' lines marked as uploaded to the ERP</b>'; }
    });
    await saveCard(desk, '#erpAislesTable', 'guide-erp-aisles-after', 8);
  });

  /* ---- employees: the add form */
  await part('employees', async () => {
    await signIn('/teams'); await sub('people');
    await desk.fill('#fBadge', 'E1301'); await desk.fill('#fName', 'Rosa Delgado'); await desk.fill('#fDept', 'Warehouse');
    await desk.check('#equipPicker input[value="SCISSOR LIFT"]').catch(() => {});
    await desk.selectOption('#fAddJacket', 'M').catch(() => {}); await desk.selectOption('#fAddBibs', 'M').catch(() => {}); await desk.selectOption('#fAddBoots', '8').catch(() => {});
    await saveCard(desk, '#btnAddPerson', 'guide-add-employee');
    await desk.fill('#fBadge', ''); await desk.fill('#fName', '');
  });

  /* ---- LIVE and TEST: a second server, linked to this one */
  await part('systems', async () => {
    const TPORT = PORT + 1;
    const TBASE = `http://127.0.0.1:${TPORT}`;
    const key = (await j(await fetch(`${BASE}/api/admin/systems`, { headers: A }))).key;
    await post('/api/admin/systems', { systems: [{ name: 'TEST', url: TBASE, color: 'orange', scanners: true }] });
    await post('/api/admin/systems/access', { username: 'MARCUS-OBI', systems: ['TEST'] });
    const tdir = mkdtempSync(join(tmpdir(), 'sopshots-test-'));
    const test = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(ROOT, 'src', 'server.js')], {
      env: { ...process.env, PORT: String(TPORT), DB_PATH: join(tdir, 'test.db'), SUPERADMIN_USER: 'TEST-SETUP', SUPERADMIN_NAME: 'Test setup', SUPERADMIN_PASSWORD: 'test-setup-pass',
        SYSTEM_NAME: 'TEST', SYSTEM_HOME_URL: BASE, SYSTEM_LINK_KEY: key, SITE_TIMEZONE: 'America/New_York' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
      for (let i = 0; i < 100; i++) { try { if ((await fetch(`${TBASE}/api/health`)).ok) break; } catch { /* starting */ } await wait(200); }
      // a login somebody made on TEST before it was linked
      const TA = { ...hdr, authorization: 'Bearer ' + (await j(await fetch(`${TBASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'TEST-SETUP', password: 'test-setup-pass' }) }))).token };
      await fetch(`${TBASE}/api/admin/users`, { method: 'POST', headers: TA, body: JSON.stringify({ username: 'NADIA-H', name: 'Nadia Haddad', password: 'tried-it-on-test-1', mustChange: false, profile: 'floor' }) });
      // LIVE: the Systems card, the logins with their Systems column, and copying from TEST
      await signIn('/settings'); await sub('advanced');
      await desk.evaluate(() => { const c = document.getElementById('systemsCard'); if (c) c.classList.remove('folded'); });
      await wait(800);
      // the address as it reads on Railway, not this run's own port
      await desk.evaluate(() => { for (const i of document.querySelectorAll('#sysTable .sysurl')) i.value = 'https://full-harvest-inv-dev.up.railway.app'; });
      await saveCard(desk, '#sysTable', 'guide-systems-card');
      await sub('logins'); await wait(800);
      await saveCard(desk, '#userTable', 'guide-logins-systems');
      await desk.click('#copyLoginsBtns button[data-copy-from="TEST"]'); await desk.waitForSelector('#copyLoginsTable tbody tr', { timeout: 10000 });
      await saveCard(desk, '#copyLoginsTable', 'guide-copy-logins');
      await desk.click('#copyLogins button.ghost').catch(() => {});
      // the ring: green on LIVE, and over on TEST with its banner
      const top = async (name) => save({ screenshot: (o) => desk.screenshot({ ...o, clip: { x: 0, y: 0, width: 900, height: 330 } }) }, name);
      await signIn('/admin'); await pick(sess.id); await sub('progress');
      await top('guide-ring-live');
      await desk.selectOption('#navSystemPick', 'TEST'); await desk.waitForURL(`${TBASE}/**`, { timeout: 15000 }); await wait(2500);
      await top('guide-ring-test');
      await desk.goto(`${TBASE}/settings#gun`); await wait(2500);
      await saveCard(desk, '#deviceTable', 'guide-test-scanner-setup', 4);
      await desk.goto(`${BASE}/admin`); await wait(1500);
      // the gun: System LIVE | TEST on the sign-on screen, then on TEST
      const g = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
      await g.goto(`${BASE}/?d=${devices[3].uid}`); await wait(2500);
      await save(g, 'guide-gun-system-live');
      await g.click('#systemPick button[data-system="TEST"]'); await g.waitForURL(`${TBASE}/**`, { timeout: 15000 }); await wait(3000);
      await save(g, 'guide-gun-system-test');
      await g.close();
    } finally {
      test.kill();
      await post('/api/admin/systems', { systems: [] }).catch(() => {});
      try { rmSync(tdir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  console.log(`\n${shots.length} screenshots written to docs/images/`);
} finally {
  if (browser) await browser.close();
  server.kill();
  await wait(300);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
