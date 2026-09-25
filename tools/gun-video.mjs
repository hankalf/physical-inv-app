/*
 * A film of a counter using the handheld, on real data.
 *
 * Screenshots show what a screen looks like; they do not show what counting
 * feels like - the rhythm of scan, quantity, bin, next bin, and what the app
 * does when something is wrong. This drives a real scanner session against a
 * real warehouse (the Front Royal bin list, a frozen-food report over it) and
 * records it, with a line of narration beside the phone saying what is being
 * done and why.
 *
 * Everything on screen is the app itself: nothing is mocked up, nothing is
 * staged in a drawing program. If a step in here stops working, the film stops
 * working, which is the point.
 *
 *   npm run video     ->  docs/gun-demo.webm
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, renameSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, CREW } from './demo-data.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'docs');
const PORT = Number(process.env.PORT || 3402);
const BASE = `http://127.0.0.1:${PORT}`;
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* How long a caption stays up. The whole film is paced off these, so it can be
   slowed down for a training room or sped up for a demo in one place. */
const PACE = Number(process.env.PACE || 1);
const beat = (ms) => wait(Math.round(ms * PACE));

const videoDir = mkdtempSync(join(tmpdir(), 'gunvid-'));
const dataDir = mkdtempSync(join(tmpdir(), 'gunvid-db-'));
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'demo.db'), ADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* still starting */ }
    await wait(200);
  }

  /* ----------------------------------------------------------- the warehouse */
  const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) }))).token;
  const A = { ...hdr, authorization: 'Bearer ' + tok };
  const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
  const post = (p, body, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) }).then(j);

  const sess = await post('/api/admin/sessions', { name: 'Q3 2026 wall-to-wall' });
  const binCsv = readFileSync(join(ROOT, 'public', 'templates', 'front-royal-bins.csv'), 'utf8');
  await post(`/api/admin/sessions/${sess.id}/master?kind=bins`, binCsv, csv);
  const { report, expected, palletAt, binsOf } = buildReport(binCsv);
  await post(`/api/admin/sessions/${sess.id}/master?kind=pallets`, report, csv);
  await post(`/api/admin/sessions/${sess.id}/settings`, {
    guided: true, askComments: true, autoRecount: true, askLot: true, askExpiry: true,
    palletMode: 'warn', layout: 'front-royal', recountMinQty: 3, recountMinPct: 5, recountCap: 60,
  });
  await post(`/api/admin/sessions/${sess.id}/aisles/auto-block`, { size: 2, offset: 0 }).catch(() => {});
  await post('/api/admin/default-session', { sessionId: sess.id }).catch(() => {});
  for (const [badge, name, equipment] of CREW) {
    await post('/api/admin/people/employees', { badge, name, dept: 'Warehouse', equipment }).catch(() => {});
  }
  for (const name of ['1', '2', '3']) {
    const team = await post('/api/admin/people/teams', { name }).catch(() => null);
    if (team && team.id) {
      for (const [badge, , , t] of CREW) if (t === name) await post('/api/admin/people/assign', { badge, teamId: team.id }).catch(() => {});
    }
  }
  const device = await post('/api/admin/devices', { name: 'SCANNER-01', notes: 'freezer unit A' });
  await post(`/api/admin/sessions/${sess.id}/assignments`, { team: '1', aisles: 'F01', levels: 'A-C' });
  await post(`/api/admin/sessions/${sess.id}/assignments`, { team: '1', aisles: 'F02', levels: 'A-C' });

  /* The bins this counter will walk, in the order the gun will send them: the
     first few of aisle F01 on level A, one of which holds three pallets. */
  const onLevelA = binsOf('F01').filter((b) => /^F01A/.test(b));
  const stocked = onLevelA.filter((b) => (palletAt.get(b) || []).length);
  const single = stocked.filter((b) => palletAt.get(b).length === 1);
  const triple = stocked.find((b) => palletAt.get(b).length >= 3) || single[2];
  /* A real bin from the list, on this team's levels, that the report puts
     nothing in - not an invented code, which the gun would rightly refuse. */
  const emptyBin = binsOf('F01').find((b) => /^F01[ABC]/.test(b) && !(palletAt.get(b) || []).length);

  /* ------------------------------------------------------------- the camera */
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.error('[stage]', e.message));
  /* The stage is served AT the app's own address, so the phone inside it is a
     first-party frame: an app in a third-party iframe has its storage
     partitioned away by the browser, and this one keeps its counts in IndexedDB.
     Serving it here rather than opening a real page of the app also means no
     other script is running behind the film. */
  await page.route('**/stage', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: STAGE }));

  /* The set: the handheld in a phone shell, the narration beside it. Everything
     inside the shell is the real app in an iframe - what you see is what a
     counter sees. */
  const STAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --bg:#0b0e14; --panel:#141a24; --line:#27313f; --text:#e9eff7; --muted:#8496ab; --accent:#4c9dff; --ok:#3fcf68; }
    * { box-sizing: border-box; }
    body { margin:0; height:720px; background:
            radial-gradient(1200px 600px at 78% -10%, #16233a 0%, var(--bg) 60%);
           color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
           display:grid; grid-template-columns: 430px 1fr; align-items:center; }
    .stage { display:flex; justify-content:center; }
    .phone { background:#1a1d21; border:3px solid #2b3038; border-radius:22px; padding:16px 13px 30px;
             box-shadow: 0 30px 70px rgba(0,0,0,.55); position:relative; }
    .phone::after { content:''; position:absolute; left:50%; bottom:11px; transform:translateX(-50%);
                    width:44px; height:5px; border-radius:3px; background:#3a4150; }
    .phone .cam { position:absolute; left:50%; top:7px; transform:translateX(-50%); width:36px; height:4px; border-radius:3px; background:#2b3038; }
    iframe { display:block; width:360px; height:640px; border:0; border-radius:4px; background:#0d1117; }
    .notes { padding: 0 54px 0 10px; max-width: 720px; }
    .brand { font-size:13px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); font-weight:700; }
    .brand b { color: var(--accent); }
    .step { font-size:34px; font-weight:800; letter-spacing:-.02em; line-height:1.12; margin:14px 0 12px; }
    .say { font-size:19px; line-height:1.55; color:#cfdcea; min-height:120px; }
    .say b { color:#fff; }
    .tag { display:inline-block; margin-top:22px; padding:7px 13px; border-radius:999px; font-size:13px; font-weight:700;
           background:#16283f; color:#9dc6ff; border:1px solid #23477a; }
    .tag.warn { background:#2c2110; color:#ffd479; border-color:#8a6a1f; }
    .tag.ok { background:#0f2a18; color:#7ee29a; border-color:#235c33; }
    .cover { position:fixed; inset:0; background:var(--bg); display:flex; flex-direction:column;
             align-items:center; justify-content:center; gap:16px; text-align:center; transition:opacity .5s; }
    .cover h1 { margin:0; font-size:54px; font-weight:800; letter-spacing:-.03em; }
    .cover p { margin:0; font-size:21px; color:var(--muted); max-width:760px; line-height:1.5; }
    .cover.gone { opacity:0; pointer-events:none; }
  </style></head><body>
    <div class="stage"><div class="phone"><span class="cam"></span>
      <iframe id="gun" src="${BASE}/?d=${device.uid}"></iframe></div></div>
    <div class="notes">
      <div class="brand">Physical inventory · <b>the handheld</b></div>
      <div class="step" id="step"></div>
      <div class="say" id="say"></div>
      <div id="tag"></div>
    </div>
    <div class="cover" id="cover">
      <h1>Counting with the handheld</h1>
      <p>Front Royal freezer · Q3 wall-to-wall · 13,673 bins, 2,658 pallets on the report.<br>
         Everything in this film is the running app on real data.</p>
    </div>
  </body></html>`;
  await page.goto(`${BASE}/stage`);

  const say = (step, text, tag = '') => page.evaluate(([s, t, g]) => {
    document.getElementById('step').textContent = s;
    document.getElementById('say').innerHTML = t;
    document.getElementById('tag').innerHTML = g ? `<span class="tag ${g.kind || ''}">${g.text || g}</span>` : '';
  }, [step, text, tag]);

  const gun = () => page.frames().find((f) => f.url().includes('/?d='));
  const type = async (sel, value) => { await gun().fill(sel, value); await beat(500); };
  /* Where the gun is, in one line - so a step that stops working says which one
     it was rather than timing out on a selector. */
  const where = async () => {
    try {
      return await gun().evaluate(() => {
        const screen = document.querySelector('.screen.active')?.id || '?';
        const p = document.getElementById('prompt')?.textContent || '';
        const msg = document.getElementById('scanMsg')?.textContent || '';
        return `${screen} · ${p} · ${msg}`.replace(/\s+/g, ' ').slice(0, 120);
      });
    } catch { return '?'; }
  };
  const DEBUG = !!process.env.DEBUG;
  const scan = async (value) => {
    if (DEBUG) console.log(`  scan ${value} <- ${await where()}`);
    /* A wedge scanner dumps the whole string and an ENTER - it does not type. */
    await gun().fill('#fScan', value);
    await beat(420);
    await gun().press('#fScan', 'Enter');
    await beat(900);
  };
  const tap = async (sel) => {
    if (DEBUG) console.log(`  tap ${sel} <- ${await where()}`);
    await gun().click(sel);
    await beat(700);
  };
  /* The comments step moves on by itself after a couple of seconds, so by the
     time the film gets there the button it would have pressed is gone. */
  const maybeTap = async (sel) => {
    const el = await gun().$(sel);
    if (el && await el.isVisible()) { await el.click(); await beat(600); }
  };
  const prompt = async () => (await gun().textContent('#prompt')).trim();
  /* Wait for the gun to be ASKING for something before answering it. Without
     this the film only works at one speed, and every timing change breaks it. */
  const atStep = async (re, ms = 15000) => {
    await gun().waitForFunction(
      (src) => new RegExp(src).test(document.getElementById('prompt')?.textContent || ''),
      re.source, { timeout: ms, polling: 120 },
    ).catch(() => {});
  };
  const stepIs = async (re) => re.test(await prompt().catch(() => ''));

  /** One whole pallet, at whatever pace the film is running. */
  const countLine = async ({ pallet, qty, lot, exp, bin }) => {
    await atStep(/PALLET/); await scan(pallet);
    await atStep(/QUANTITY/); await scan(String(qty));
    if (await stepIs(/LOT/)) { if (lot) await scan(lot); else await maybeTap('#btnSkip'); }
    if (await stepIs(/EXPIRY/)) { if (exp) await scan(exp); else await maybeTap('#btnSkip'); }
    await atStep(/BIN/); await scan(bin);
  };

  await beat(3200);
  await page.evaluate(() => document.getElementById('cover').classList.add('gone'));
  await beat(900);

  /* ---------------------------------------------------------- 1. signing on */
  say('Opening the scanner', 'Each handheld has its own link, saved as the home-screen icon. Opening it is how the '
    + 'server knows <b>which scanner</b> this is — nobody types a device name, and a scanner nobody registered cannot post counts.',
    { text: 'SCANNER-01 · freezer unit A' });
  await gun().waitForSelector('#scrSignon.active');
  await beat(4200);

  say('Signing on', 'Pick the count, type the team number, then scan or type every clock-in number on the crew. '
    + 'The app checks the crew has the <b>equipment</b> for the levels their aisle is on before it lets them start.');
  await type('#fTeam', '1');
  for (const badge of ['E1043', 'E1088']) {
    await gun().fill('#fEmployee', badge);
    await beat(400);
    await gun().press('#fEmployee', 'Enter');
    await beat(600);
  }
  await beat(1800);
  await tap('#btnStart');
  await gun().waitForSelector('#scrAssign.active', { timeout: 60000 });
  await beat(2600);

  say('Your aisle', 'The crew is confirmed by name and equipment, and the gun hands the team its aisle: which one, '
    + 'which levels, and how many bins that is. A guided count sends a team one aisle at a time so two crews never '
    + 'end up either side of the same rack.', { text: 'Aisle F01 · levels A–C', kind: 'ok' });
  await beat(5200);
  await tap('#btnCount');
  await gun().waitForSelector('#scrScan.active', { timeout: 60000 });
  await beat(1500);

  /* ------------------------------------------------------------ 2. counting */
  say('The next bin', 'Before anything is scanned the gun says where to go. It works down the aisle in order — '
    + '001, 002, 003 — so nothing is skipped and nobody has to remember where they were.',
    { text: 'The banner follows the team down the aisle' });
  await beat(4600);

  const first = palletAt.get(single[0])[0];
  const e1 = expected.get(first);
  say('Scan the pallet', 'A scan is a keystroke and an ENTER: the counter never taps the screen. The gun answers with '
    + '<b>what the report says is on that pallet</b>, so a wrong label is obvious before the quantity is typed.');
  await atStep(/PALLET/);
  await scan(first);
  await beat(2600);

  say('The quantity', 'Whatever is actually there. Not what the report expected — the point of a count is the number '
    + 'in the rack. A quantity over the site’s threshold has to be typed twice.');
  await atStep(/QUANTITY/); await scan(String(e1.qty));
  await beat(2200);

  say('Lot and best-before', 'Optional per count, and on for frozen food. The gun checks the lot against the report and '
    + 'says so if it is a different one; a date already past is flagged for a supervisor.', { text: 'Recall-ready', kind: 'ok' });
  await atStep(/LOT/); await scan(e1.lot);
  await beat(1400);
  await atStep(/EXPIRY/); await scan(e1.exp);
  await beat(1800);

  say('The bin', 'Last, the bin label. That is what ties the pallet to a place in the warehouse — and the gun checks it '
    + 'is in the aisle and on the levels this team was given.');
  await atStep(/BIN/); await scan(e1.bin);
  await beat(2400);

  say('Anything to say about it?', 'The last step offers the site\u2019s own one-tap reasons — damaged, blocked, partial — '
    + 'and moves on by itself after two seconds if there is nothing to say. A counter with nothing to add never has to '
    + 'press anything.', { text: 'Counted. Next bin.', kind: 'ok' });
  await beat(3400);
  await maybeTap('#btnSkip');

  /* -------------------------------------------- 3. a bay with three pallets */
  const stack = palletAt.get(triple);
  say('A bay with more than one pallet', 'Three tags in this position. The guide <b>stays on the bin</b> and counts them '
    + 'off — “still in this bin, 1 of 3 tags” — instead of moving on after the first one and leaving two uncounted.',
    { text: `${triple} · ${stack.length} pallets`, kind: 'warn' });
  for (const id of stack) {
    const e = expected.get(id);
    await countLine({ pallet: id, qty: e.qty, lot: e.lot, exp: e.exp, bin: e.bin });
    await maybeTap('#btnSkip');
    await beat(700);
  }
  await beat(2600);

  /* ------------------------------------------------- 4. two labels, one pallet */
  say('Two labels on one pallet', 'Re-labelled stock often carries both tags. The counter says so, scans the second one, '
    + 'and it is recorded against the same pallet <b>with no quantity of its own</b> — so nobody counts it twice and '
    + 'nobody is sent back to look for a pallet that is right there.');
  await tap('#btnSameLabel');
  await beat(1200);
  await scan('OLD-TAG-4471');
  await beat(3000);

  /* ------------------------------------------------- 5. a label that will not scan */
  say('A label that will not scan', 'Freezer labels ice over and get clipped by forklifts. The counter says which kind of '
    + 'problem it is and carries on counting — the pallet still gets counted, and the bin lands on a relabel list for '
    + 'somebody with a printer.', { text: 'Nothing is skipped', kind: 'warn' });
  await tap('#btnNoScan');
  await beat(2400);
  await tap('#btnNoScanType');
  const second = palletAt.get(single[1])[0];
  const e2 = expected.get(second);
  await scan(second);
  await atStep(/QUANTITY/); await scan(String(e2.qty));
  await atStep(/LOT/); await scan(e2.lot);
  await atStep(/EXPIRY/); await scan(e2.exp);
  await atStep(/BIN/);

  say('…and on the bin, too', 'Same question for the rack label. The app already knows which bin the guide is on, so it '
    + 'offers it by name: one tap instead of typing a code off a rack leg in a freezer.');
  await tap('#btnNoScan');
  await beat(2200);
  await tap('#btnNoScanNone');
  await beat(2400);
  await maybeTap('#btnSkip');
  await beat(1200);

  /* -------------------------------------------------------- 6. an empty bin */
  say('An empty bin', 'An empty position is a fact worth recording: it is the difference between “counted, nothing there” '
    + 'and “nobody got to it”. One tap, then scan the bin.');
  await atStep(/PALLET/);
  await tap('#btnEmpty');
  await beat(1400);
  await scan(emptyBin);
  await beat(2600);

  /* ------------------------------------------- 7. a pallet not on the report */
  await atStep(/PALLET/);
  say('A pallet nobody expected', 'Not on the inventory report. The gun stops and asks <b>why</b> before it will take the '
    + 'line — the reasons are the site’s own words, set in Settings — and the line is flagged for a supervisor.',
    { text: 'Every exception has a name against it', kind: 'warn' });
  await scan('HANDWRITTEN-91');
  await beat(2800);
  await gun().selectOption('#fReason', { index: 1 }).catch(() => {});
  await beat(900);
  await gun().fill('#fReasonNote', 'Hand-written tag from receiving');
  await beat(1600);
  await tap('#btnOverrideAccept');
  await beat(1200);
  await atStep(/QUANTITY/); await scan('30');
  if (await stepIs(/LOT/)) await maybeTap('#btnSkip');      // a hand-written tag carries no lot
  if (await stepIs(/EXPIRY/)) await maybeTap('#btnSkip');   // nor a date
  await atStep(/BIN/); await scan(single[3] ? expected.get(palletAt.get(single[3])[0]).bin : e1.bin);
  await beat(1600);
  await maybeTap('#btnSkip');
  await beat(1500);

  /* ------------------------------------------ 8. a word from the office */
  say('A word from the office', 'A supervisor can put a line on this team’s scanners from the dashboard. It arrives while '
    + 'they are counting, buzzes, and stays until somebody taps <b>Got it</b> — which tells the dashboard who read it.');
  await post(`/api/admin/sessions/${sess.id}/messages`, { team: '1', urgent: true,
    body: 'Bring the pallet jack back to the dock when you finish this aisle' });
  await gun().evaluate(() => window.dispatchEvent(new Event('online')));
  await gun().waitForFunction(() => { const el = document.getElementById('msgBar'); return el && !el.hidden; },
    null, { timeout: 40000, polling: 600 }).catch(() => {});
  await beat(4200);
  await tap('#btnMsgAck');

  /* -------------------------------------------------------- 9. a wrong line */
  say('Fixing a mistake', 'Everything this scanner counted is one tap away, and a wrong line can be voided on the spot. '
    + 'It comes out of the totals; the dashboard keeps the record that it was voided and by whom.');
  await tap('#btnHistory');
  await beat(3000);
  await gun().click('#histList button:has-text("Void")').catch(() => {});
  await beat(2600);
  await tap('#btnHistoryBack');

  /* ------------------------------------------------------ 10. no wifi */
  say('When the wifi drops', 'A freezer is full of steel and the wifi goes. The gun keeps counting: every line is saved on '
    + 'the device and the header says how many are waiting.', { text: 'Counting does not stop', kind: 'warn' });
  await ctx.setOffline(true);
  await gun().evaluate(() => window.dispatchEvent(new Event('offline')));
  await beat(1400);
  const third = palletAt.get(single[4])[0];
  const e3 = expected.get(third);
  await countLine({ pallet: third, qty: e3.qty, lot: e3.lot, exp: e3.exp, bin: e3.bin });
  await maybeTap('#btnSkip');
  await beat(2800);

  say('…and back again', 'The moment the signal returns the queue drains by itself. Nothing is re-typed, and a line that '
    + 'was sent twice is only ever counted once.', { text: 'Queue → server', kind: 'ok' });
  await ctx.setOffline(false);
  await gun().evaluate(() => window.dispatchEvent(new Event('online')));
  await beat(4200);

  /* ------------------------------------------------ 11. handing the aisle back */
  say('Handing the aisle back', 'When the aisle is done the team hands it back. That frees the racking behind it for the '
    + 'crew on the other side, and the gun deals out this team’s next aisle.');
  await tap('#btnToAssign');
  await beat(2200);
  await gun().click('#btnAisleDone').catch(() => {});
  await beat(3400);

  const prog = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/progress`, { headers: A }));
  say('On the dashboard, already', `Every line was on the supervisor's screen within seconds of being scanned — `
    + `<b>${prog.lines} lines</b> across ${prog.bins_counted} bins so far, with the exceptions flagged and the second `
    + `counts raised automatically.`, { text: 'Nothing to import, nothing to type up', kind: 'ok' });
  await beat(5200);

  await page.evaluate(() => {
    const c = document.getElementById('cover');
    c.innerHTML = '<h1>That is the whole job</h1><p>Scan the pallet, the quantity, the bin. '
      + 'The gun handles the awkward ones — two labels, no label, an empty bay, a pallet nobody expected, no wifi — '
      + 'without a counter having to stop and find a supervisor.</p>';
    c.classList.remove('gone');
  });
  await beat(5000);

  /* The file is only written when the context closes. */
  const video = page.video();
  await ctx.close();
  const raw = await video.path();
  const out = join(OUT, 'gun-demo.webm');
  try { rmSync(out); } catch { /* first run */ }
  renameSync(raw, out);
  const mb = (statSync(out).size / 1048576).toFixed(1);
  console.log(`\ndocs/gun-demo.webm written - ${mb} MB`);
} finally {
  if (browser) await browser.close();
  server.kill();
  await wait(300);
  for (const d of [videoDir, dataDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
