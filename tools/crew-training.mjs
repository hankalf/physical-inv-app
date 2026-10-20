/*
 * The day-one training film for the counting crew, in English or Spanish.
 *
 * gun-demo.webm shows a manager what the handheld does. This one teaches a
 * counter how to use it, slowly enough to follow on a screen in a break room:
 * one thing at a time, a caption in big type beside the scanner saying what to
 * do and why, and on the left the label being scanned - a pallet label, a rack
 * label, a badge, the team's QR card - with a scanner that aims, fires its red
 * line and beeps, so nobody has to imagine what "scan the bin" means.
 *
 * The phone in the middle is the real scanner app on real data, driven step by
 * step, in the language of the film (the Spanish film switches the gun to
 * Español with its own button, so the screens are the ones a crew will see).
 * The beeps are added afterwards, at the moments the scans went in.
 *
 * It also saves a picture of the scanner, and of each label, at every step:
 * the slide decks are built from them, so the deck and the film agree.
 *
 *   node tools/crew-training.mjs           -> docs/training/scanner-training-en.mp4
 *   LANG_FILM=es node tools/crew-training.mjs   -> docs/training/scanner-training-es.mp4
 *   PACE=1.4 slows it further; SHOTS_ONLY=1 skips the video encode.
 */
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, CREW } from './demo-data.mjs';
import { barcodeSvg } from '../src/util/barcode.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..');
const LANG = process.env.LANG_FILM === 'es' ? 'es' : 'en';
const L = (en, es) => (LANG === 'es' ? es : en);
const OUT = join(ROOT, 'docs', 'training');
const SHOTS = join(OUT, 'shots', LANG);
const PORT = Number(process.env.PORT || (LANG === 'es' ? 3412 : 3411));
const BASE = `http://127.0.0.1:${PORT}`;
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.PACE || 0.68);      // the whole film in under ten minutes; PACE=1 is slower still
const beat = (ms) => wait(Math.round(ms * PACE));
/* how long a caption stays up: long enough to read it twice, slowly */
const dwell = (text) => Math.max(4200, String(text).replace(/<[^>]+>/g, '').split(/\s+/).length * 420);

const videoDir = mkdtempSync(join(tmpdir(), 'crewvid-'));
const dataDir = mkdtempSync(join(tmpdir(), 'crewvid-db-'));
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'film.db'), SUPERADMIN_USER: 'DANA-WHITFIELD', SUPERADMIN_NAME: 'Dana Whitfield', SUPERADMIN_PASSWORD: 'changeme', SITE_TIMEZONE: 'America/New_York' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const beeps = [];           // [ms since the film started, 'ok' | 'bad']
let t0 = 0;
let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ }
    await wait(200);
  }

  /* ----------------------------------------------------------- the warehouse */
  const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
  const A = { ...hdr, authorization: 'Bearer ' + tok };
  const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
  const post = (p, body, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) }).then(j);

  const sess = await post('/api/admin/sessions', { name: L('Q4 wall-to-wall', 'Inventario Q4') });
  const binCsv = readFileSync(join(ROOT, 'tests', 'fixtures', 'front-royal-bins.csv'), 'utf8');
  await post(`/api/admin/sessions/${sess.id}/master?kind=bins`, binCsv, csv);
  const { report, expected, palletAt, binsOf } = buildReport(binCsv);
  await post(`/api/admin/sessions/${sess.id}/master?kind=pallets`, report, csv);
  await post(`/api/admin/sessions/${sess.id}/settings`, {
    guided: true, askComments: true, autoRecount: false, askLot: false, askExpiry: false,
    palletMode: 'warn', layout: 'front-royal', recountMinQty: 3, recountMinPct: 5, recountCap: 60,
  });
  await post(`/api/admin/sessions/${sess.id}/aisles/auto-block`, { size: 2, offset: 0 }).catch(() => {});
  await post('/api/admin/default-session', { sessionId: sess.id }).catch(() => {});
  // the comments step waits for the counter, so the film can explain it before moving on
  await post('/api/admin/scanner-prompts', { commentTimeout: 0 });
  // the site counts the bin first: the rack label, then the pallet label, then the quantity
  await post('/api/admin/scanner-layout', { order: ['bin', 'pallet', 'qty'] });
  await post('/api/admin/site-name', { name: 'Full Harvest Inventory', place: 'Front Royal' }).catch(() => {});
  for (const [badge, name, equipment] of CREW) {
    await post('/api/admin/people/employees', { badge, name, dept: 'Warehouse', shift: '1', equipment }).catch(() => {});
  }
  const TEAM = 'S1-DS01';
  const team = await post('/api/admin/people/teams', { name: TEAM, shift: '1', notes: 'Dock stocker · truck 01' });
  for (const [badge, , , t] of CREW) if (t === '1') await post('/api/admin/people/assign', { badge, teamId: team.id }).catch(() => {});
  const device = await post('/api/admin/devices', { name: 'SCANNER-07' });
  await post(`/api/admin/sessions/${sess.id}/assignments`, { team: TEAM, aisles: 'F01', levels: 'A-C' });
  await post(`/api/admin/sessions/${sess.id}/assignments`, { team: TEAM, aisles: 'F03', levels: 'A-C' });

  const onLevelA = binsOf('F01').filter((b) => /^F01A/.test(b));
  const stocked = onLevelA.filter((b) => (palletAt.get(b) || []).length);
  const single = stocked.filter((b) => palletAt.get(b).length === 1);
  const triple = stocked.find((b) => palletAt.get(b).length >= 3);
  const doubles = stocked.filter((b) => palletAt.get(b).length === 2);
  const emptyBin = binsOf('F01').find((b) => /^F01[ABC]/.test(b) && !(palletAt.get(b) || []).length);
  const name = (badge) => CREW.find((c) => c[0] === badge)[1];
  const [B1, B2] = CREW.filter((c) => c[3] === '1').map((c) => c[0]);

  /* ------------------------------------------------------------- the set */
  const svg = (code) => barcodeSvg(code, { module: 0.5, height: 16, quiet: 2, fontSize: 4.2 }).replace(/width="[\d.]+mm"/, 'width="100%"').replace(/height="[\d.]+mm"/, '');
  const STAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --bg:#0a1018; --text:#eef3f9; --muted:#8fa2b8; --accent:#ffc20e; --ok:#3fcf68; --bad:#ff5a5f; --laser:#ff2a2a; }
    * { box-sizing:border-box; }
    body { margin:0; width:1280px; height:720px; overflow:hidden; color:var(--text);
      background: radial-gradient(1100px 620px at 50% -20%, #18293f 0%, var(--bg) 62%);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      display:grid; grid-template-columns: 420px 396px 1fr; align-items:center; }
    /* the scene: the label being scanned, and the scanner */
    #scene { position:relative; height:720px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; padding:0 18px; }
    #scene .what { font-size:15px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); min-height:20px; }
    .prop { width:360px; border-radius:10px; background:#fff; color:#111; box-shadow:0 18px 50px rgba(0,0,0,.5); padding:14px 16px; position:relative; transition: box-shadow .3s, transform .4s; }
    .prop.hit { box-shadow:0 0 0 5px var(--ok), 0 18px 50px rgba(0,0,0,.5); }
    .prop.miss { box-shadow:0 0 0 5px var(--bad), 0 18px 50px rgba(0,0,0,.5); }
    .prop .k { font-size:12px; font-weight:800; letter-spacing:.14em; color:#555; }
    .prop .big { font-size:30px; font-weight:900; font-family: ui-monospace, Menlo, Consolas, monospace; letter-spacing:.02em; }
    .prop .line { font-size:15px; margin-top:2px; }
    .prop .bars { margin-top:10px; height:74px; position:relative; }
    .prop .bars svg { display:block; width:100%; height:74px; }
    .prop.rack { background:#ffd21a; border:3px solid #111; }
    .prop.rack .big { font-size:44px; text-align:center; }
    .prop.rack .arrow { position:absolute; right:16px; top:12px; font-size:30px; }
    .prop.badge { width:250px; text-align:center; border-top:26px solid #1d3b5c; }
    .prop.badge .face { width:70px; height:70px; border-radius:50%; background:#c9d6e3; margin:6px auto 6px; display:flex; align-items:center; justify-content:center; font-size:30px; color:#1d3b5c; font-weight:900; }
    .prop.team { width:260px; text-align:center; border:2px dashed #888; }
    .prop.team .qr { display:flex; justify-content:center; margin:8px 0; min-height:150px; }
    .prop.team .big { font-size:34px; }
    .prop.cases { width:360px; background:#203247; color:#fff; text-align:center; }
    .prop.cases .grid { display:grid; grid-template-columns: repeat(8, 1fr); gap:4px; margin:10px 0; }
    .prop.cases .grid i { display:block; height:22px; border-radius:3px; background:#b98a52; border:1px solid #7a5631; opacity:.35; transition: opacity .12s; }
    .prop.cases .grid i.on { opacity:1; }
    .prop.cases .big { font-size:46px; }
    .prop.keys { width:300px; background:#1c2129; color:#fff; padding:14px; }
    .prop.keys .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; }
    .prop.keys .grid b { display:flex; align-items:center; justify-content:center; height:52px; border-radius:8px; background:#2c3440; font-size:24px; transition: background .15s, transform .15s; }
    .prop.keys .grid b.on { background:var(--accent); color:#111; transform:scale(.94); }
    .prop.keys .shown { font-family: ui-monospace, Menlo, monospace; font-size:34px; text-align:right; padding:6px 10px; margin-bottom:10px; background:#0d1117; border-radius:6px; min-height:52px; }
    .prop.note { width:360px; background:#16263a; color:#e9f1fa; font-size:20px; line-height:1.45; }
    /* the scanner and its red line */
    #gunpic { position:absolute; left:50%; bottom:-260px; width:150px; transform:translateX(-50%) rotate(-8deg); transition: bottom .9s ease; z-index:3; filter: drop-shadow(0 18px 30px rgba(0,0,0,.6)); }
    #gunpic.aim { bottom:24px; }
    #laser { position:absolute; height:4px; background:var(--laser); box-shadow:0 0 12px 4px rgba(255,40,40,.75); border-radius:2px; opacity:0; z-index:4; pointer-events:none; }
    #laser.on { opacity:1; animation: sweep .55s ease-in-out infinite alternate; }
    @keyframes sweep { from { transform: translateY(-14px); } to { transform: translateY(14px); } }
    #beep { position:absolute; z-index:5; font-weight:900; font-size:22px; color:#0b1; background:#e9ffe9; border-radius:999px; padding:6px 14px; opacity:0; transform:scale(.6); transition: all .25s; }
    #beep.on { opacity:1; transform:scale(1); }
    #beep.bad { color:#b00; background:#ffe9e9; }
    #fly { position:fixed; z-index:9; font: 800 22px ui-monospace, Menlo, monospace; color:#111; background:var(--accent); padding:6px 12px; border-radius:8px; opacity:0; pointer-events:none; transition: left 1.1s ease-in-out, top 1.1s ease-in-out, opacity .3s; }
    /* the phone */
    .stage { display:flex; justify-content:center; }
    .phone { background:#1a1d21; border:3px solid #2b3038; border-radius:22px; padding:16px 13px 28px; box-shadow:0 30px 70px rgba(0,0,0,.55); position:relative; }
    .phone .cam { position:absolute; left:50%; top:7px; transform:translateX(-50%); width:36px; height:4px; border-radius:3px; background:#2b3038; }
    iframe { display:block; width:360px; height:640px; border:0; border-radius:4px; background:#0d1117; }
    #ring { position:fixed; z-index:8; border:4px solid var(--accent); border-radius:12px; box-shadow:0 0 0 6px rgba(255,194,14,.25); opacity:0; pointer-events:none; transition: opacity .3s; }
    #ring.on { opacity:1; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { box-shadow:0 0 0 14px rgba(255,194,14,.08); } }
    #finger { position:fixed; z-index:9; font-size:42px; opacity:0; transition: opacity .3s; pointer-events:none; }
    #finger.on { opacity:1; }
    /* the words */
    .notes { padding:0 44px 0 30px; }
    .part { font-size:14px; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); font-weight:800; }
    .step { font-size:36px; font-weight:850; letter-spacing:-.01em; line-height:1.12; margin:12px 0 14px; }
    .say { font-size:23px; line-height:1.5; color:#d8e3ef; }
    .say b { color:#fff; }
    .tip { margin-top:20px; display:inline-block; padding:8px 14px; border-radius:10px; font-size:18px; font-weight:700; background:#2a2412; color:#ffd479; border:1px solid #6d5a1d; }
    .tip.ok { background:#0f2a18; color:#86e8a0; border-color:#235c33; }
    .cover { position:fixed; inset:0; z-index:20; background: radial-gradient(1000px 600px at 50% 0%, #1b3150, var(--bg) 70%); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; text-align:center; padding:0 120px; transition: opacity .6s; }
    .cover .k { font-size:18px; letter-spacing:.2em; text-transform:uppercase; color:var(--accent); font-weight:800; }
    .cover h1 { margin:0; font-size:60px; font-weight:900; letter-spacing:-.02em; }
    .cover p { margin:0; font-size:25px; color:#b7c6d8; line-height:1.5; max-width:900px; }
    .cover.gone { opacity:0; pointer-events:none; }
  </style><script src="/vendor/qrcode.min.js"></script></head><body>
    <div id="scene"><div class="what" id="what"></div><div id="prop"></div>
      <svg id="gunpic" viewBox="0 0 150 230" xmlns="http://www.w3.org/2000/svg">
        <rect x="18" y="6" width="114" height="150" rx="16" fill="#2d3540" stroke="#4a5563" stroke-width="3"/>
        <rect x="32" y="24" width="86" height="70" rx="6" fill="#0e1620"/>
        <rect x="40" y="32" width="70" height="10" rx="3" fill="#2f6fb5"/><rect x="40" y="48" width="52" height="7" rx="3" fill="#3a4a5c"/><rect x="40" y="60" width="62" height="7" rx="3" fill="#3a4a5c"/>
        <g fill="#3a4452">${Array.from({ length: 12 }, (_, i) => `<rect x="${36 + (i % 3) * 27}" y="${102 + Math.floor(i / 3) * 12}" width="22" height="8" rx="2"/>`).join('')}</g>
        <path d="M58 156 h40 l-8 70 h-26 z" fill="#232a33" stroke="#4a5563" stroke-width="3"/>
        <rect x="52" y="0" width="46" height="10" rx="4" fill="#c62828"/>
      </svg>
      <div id="laser"></div><div id="beep">BEEP ✓</div>
    </div>
    <div class="stage"><div class="phone"><span class="cam"></span><iframe id="gun" src="${BASE}/?d=${device.uid}"></iframe></div></div>
    <div class="notes"><div class="part" id="part"></div><div class="step" id="step"></div><div class="say" id="say"></div><div id="tip"></div></div>
    <div id="ring"></div><div id="finger">👆</div><div id="fly"></div>
    <div class="cover" id="cover"><div class="k" id="coverK"></div><h1 id="coverH"></h1><p id="coverP"></p></div>
  </body></html>`;

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: process.env.SHOTS_ONLY ? undefined : { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  await ctx.route('**/stage', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: STAGE }));
  const page = await ctx.newPage();
  t0 = Date.now();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.error('[stage]', e.message));
  await page.goto(`${BASE}/stage`);

  /* ---------------------------------------------------------- the moves */
  const gun = () => page.frames().find((f) => f.url().includes('/?d='));
  /* where the gun is, in one line - so a step that stops working says which one it was */
  const where = async () => {
    try {
      return await gun().evaluate(() => {
        const screen = document.querySelector('.screen.active')?.id || '?';
        const p = document.getElementById('prompt')?.textContent || '';
        const msg = document.getElementById('scanMsg')?.textContent || '';
        return `${screen} · ${p} · ${msg}`.replace(/\s+/g, ' ').slice(0, 160);
      });
    } catch { return '?'; }
  };
  const DEBUG = !!process.env.DEBUG;
  const trace = async (what) => { if (DEBUG) console.log(`  ${Math.round((Date.now() - t0) / 1000)}s ${what} <- ${await where()}`); };
  /* a step that fails leaves a picture of the stage and the gun's state behind */
  process.on('unhandledRejection', async (err) => {
    console.error('[film] failed:', err && err.message);
    console.error('[film] gun was at:', await where());
    try { await page.screenshot({ path: join(OUT, `failed-${LANG}.png`) }); } catch { /* gone */ }
    process.exit(1);
  });
  let shotN = 0;
  const toTop = () => gun().evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTo({ top: 0, behavior: 'smooth' }); }).catch(() => {});
  const toMsg = () => gun().evaluate(() => { const m = document.getElementById('scanMsg'); if (m && m.textContent.trim() && m.offsetParent) m.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }).catch(() => {});
  const shotPhone = async (name) => { await page.locator('.phone').screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) }); };
  const shotProp = async (name) => { const el = await page.$('#prop .prop'); if (el) await el.screenshot({ path: join(SHOTS, `label-${name}.png`) }); };
  let partNow = '';
  const cover = async (k, h, p, ms = 5200) => {
    await page.evaluate(([a, b, c]) => {
      document.getElementById('coverK').textContent = a; document.getElementById('coverH').textContent = b; document.getElementById('coverP').innerHTML = c;
      document.getElementById('cover').classList.remove('gone');
    }, [k, h, p]);
    await beat(ms);
    await page.evaluate(() => document.getElementById('cover').classList.add('gone'));
    await beat(900);
  };
  const part = async (n, title, blurb) => { partNow = `${L('Part', 'Parte')} ${n} · ${title}`; await cover(`${L('Part', 'Parte')} ${n}`, title, blurb, 4800); };
  const say = async (step, text, tip = '', { hold = true } = {}) => {
    await page.evaluate(([pt, s, t, g]) => {
      document.getElementById('part').textContent = pt;
      document.getElementById('step').textContent = s;
      document.getElementById('say').innerHTML = t;
      document.getElementById('tip').innerHTML = g ? `<span class="tip ${g.ok ? 'ok' : ''}">${g.text}</span>` : '';
    }, [partNow, step, text, tip ? (typeof tip === 'string' ? { text: tip } : tip) : null]);
    if (hold) await beat(dwell(text));
  };
  const prop = (html, what = '') => page.evaluate(([h, w]) => {
    document.getElementById('prop').innerHTML = h; document.getElementById('what').textContent = w;
    for (const q of document.querySelectorAll('#prop .qr[data-code]')) {
      try { new QRCode(q, { text: q.dataset.code, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M }); } catch { /* none */ }
    }
  }, [html, what]);
  const props = {
    pallet: (id) => {
      const e = expected.get(id) || {};
      return [`<div class="prop"><div class="k">${L('PALLET LABEL', 'ETIQUETA DE TARIMA')}</div><div class="line"><b>${e.sku || 'SKU-0000'}</b> · ${e.desc || L('Unknown item', 'Producto desconocido')}</div>
        <div class="line">${L('Lot', 'Lote')} ${e.lot || '—'}</div><div class="bars">${svg(id)}</div></div>`, L('The label on the pallet', 'La etiqueta de la tarima')];
    },
    rack: (bin) => [`<div class="prop rack"><div class="k">${L('RACK LABEL', 'ETIQUETA DEL RACK')}</div><div class="arrow">▲</div><div class="big">${bin}</div><div class="bars">${svg(bin)}</div></div>`, L('The label on the rack, under the pallet', 'La etiqueta del rack, debajo de la tarima')],
    badge: (b) => [`<div class="prop badge"><div class="face">${name(b).split(' ').map((w) => w[0]).join('')}</div><div class="line"><b>${name(b)}</b></div><div class="bars">${svg(b)}</div></div>`, L('Your badge', 'Tu gafete')],
    team: (t) => [`<div class="prop team"><div class="k">${L('TEAM · 1st shift', 'EQUIPO · 1er turno')}</div><div class="qr" data-code="${t}"></div><div class="big">${t}</div><div class="bars" style="height:40px">${svg(t)}</div></div>`, L('The team card', 'La tarjeta del equipo')],
    cases: (n) => [`<div class="prop cases"><div class="k" style="color:#9fb4c8">${L('COUNT THE CASES', 'CUENTA LAS CAJAS')}</div><div class="grid">${Array.from({ length: Math.min(64, n) }, () => '<i></i>').join('')}</div><div class="big" id="caseN">0</div></div>`, L('What is really on the pallet', 'Lo que de verdad hay en la tarima')],
    keys: () => [`<div class="prop keys"><div class="shown" id="keyShown"></div><div class="grid">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '⏎'].map((k) => `<b data-k="${k}">${k}</b>`).join('')}</div></div>`, L('The number keys on the scanner', 'Las teclas de números del escáner')],
    note: (html, what = '') => [`<div class="prop note">${html}</div>`, what],
  };
  const show = async (kind, arg, extra) => { const [h, w] = props[kind](arg, extra); await prop(h, w); await beat(600); };
  const clearProp = () => prop('', '');

  /* aim, fire, beep, and the code goes into the scanner */
  const fire = async (value, sel = '#fScan', { bad = false } = {}) => {
    await toTop();
    await page.evaluate(() => document.getElementById('gunpic').classList.add('aim'));
    await beat(1300);
    await page.evaluate(() => {
      const bars = document.querySelector('#prop .bars') || document.querySelector('#prop .qr') || document.querySelector('#prop .prop');
      const r = bars.getBoundingClientRect(); const s = document.getElementById('scene').getBoundingClientRect();
      const l = document.getElementById('laser');
      l.style.left = (r.left - s.left - 14) + 'px'; l.style.width = (r.width + 28) + 'px'; l.style.top = (r.top - s.top + r.height / 2) + 'px';
      l.classList.add('on');
    });
    await beat(1500);
    beeps.push([Date.now() - t0, bad ? 'bad' : 'ok']);
    await page.evaluate(([v, isBad]) => {
      document.getElementById('laser').classList.remove('on');
      const p = document.querySelector('#prop .prop'); if (p) p.classList.add(isBad ? 'miss' : 'hit');
      const b = document.getElementById('beep'); const s = document.getElementById('scene').getBoundingClientRect();
      const r = (document.querySelector('#prop .prop') || document.getElementById('prop')).getBoundingClientRect();
      b.textContent = isBad ? '✗' : 'BEEP ✓'; b.className = isBad ? 'bad on' : 'on';
      b.style.left = (r.right - s.left - 70) + 'px'; b.style.top = (r.top - s.top - 18) + 'px';
      const f = document.getElementById('fly'); f.textContent = v; f.style.transition = 'none';
      f.style.left = (r.left + r.width / 2 - 60) + 'px'; f.style.top = (r.top + 10) + 'px'; f.style.opacity = '1';
      const ph = document.querySelector('iframe').getBoundingClientRect();
      requestAnimationFrame(() => { f.style.transition = ''; f.style.left = (ph.left + 90) + 'px'; f.style.top = (ph.top + 300) + 'px'; });
    }, [value, bad]);
    await beat(1150);
    await trace(`scan ${value} into ${sel}`);
    await gun().fill(sel, value);
    await gun().press(sel, 'Enter');
    await page.evaluate(() => { document.getElementById('fly').style.opacity = '0'; });
    await beat(500);
    await toMsg();
    await beat(800);
    await page.evaluate(() => {
      document.getElementById('beep').className = ''; document.getElementById('gunpic').classList.remove('aim');
      const p = document.querySelector('#prop .prop'); if (p) p.classList.remove('hit', 'miss');
    });
    await beat(700);
  };
  const scanLabel = async (kind, value, opts = {}) => { await show(kind, value); await beat(1400); await fire(value, opts.sel, opts); };

  /* point at a button on the scanner, then press it */
  const tap = async (sel, { hold = 1800, shot = '' } = {}) => {
    const el = await gun().waitForSelector(sel, { state: 'visible', timeout: 20000 });
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await beat(300);
    const box = await el.boundingBox();
    if (box) {
      await page.evaluate((b) => {
        const r = document.getElementById('ring'); r.style.left = (b.x - 6) + 'px'; r.style.top = (b.y - 6) + 'px'; r.style.width = (b.width + 12) + 'px'; r.style.height = (b.height + 12) + 'px'; r.classList.add('on');
        const f = document.getElementById('finger'); f.style.left = (b.x + b.width / 2 - 14) + 'px'; f.style.top = (b.y + b.height - 6) + 'px'; f.classList.add('on');
      }, box);
    }
    await beat(hold);
    if (shot) await shotPhone(shot);
    await trace(`tap ${sel}`);
    await el.click();
    await page.evaluate(() => { document.getElementById('ring').classList.remove('on'); document.getElementById('finger').classList.remove('on'); });
    await beat(500);
    await toTop();
    await beat(700);
  };
  /* type a number on the keys, one key at a time */
  const keyIn = async (digits, sel = '#fScan') => {
    await show('keys');
    await beat(1000);
    await trace(`type ${digits} into ${sel}`);
    await gun().fill(sel, '');
    for (const d of String(digits)) {
      await page.evaluate((k) => { const b = document.querySelector(`#prop b[data-k="${k}"]`); b.classList.add('on'); document.getElementById('keyShown').textContent += k; setTimeout(() => b.classList.remove('on'), 380); }, d);
      await gun().type(sel, d);
      await beat(750);
    }
    await page.evaluate(() => { const b = document.querySelector('#prop b[data-k="⏎"]'); b.classList.add('on'); });
    await beat(700);
    await gun().press(sel, 'Enter');
    await beat(500);
    await toMsg();
    await beat(800);
  };
  const countCases = async (n) => {
    await show('cases', n);
    const steps = Math.min(64, n);
    for (let i = 0; i < steps; i++) {
      await page.evaluate(([k, total, shown]) => { document.querySelectorAll('#prop .grid i')[k].classList.add('on'); document.getElementById('caseN').textContent = String(Math.round(((k + 1) / shown) * total)); }, [i, n, steps]);
      await wait(Math.round(110 * PACE));
    }
    await beat(1600);
  };
  const atStep = async (re, ms = 20000) => {
    await gun().waitForFunction((src) => new RegExp(src).test(document.getElementById('prompt')?.textContent || ''), re.source, { timeout: ms, polling: 150 }).catch(() => {});
  };
  const P = { pallet: L(/PALLET/, /TARIMA/), qty: L(/QUANTITY/, /CANTIDAD/), bin: L(/BIN/, /UBICACIÓN/), comments: L(/omment/, /omentario/) };
  const skipComments = async () => { await atStep(P.comments, 8000); await tap('#btnSkip', { hold: 1400 }); };
  /* one ordinary line, in the site's order: the rack, the pallet, the quantity, a comment */
  const countLine = async (id, bin = expected.get(id).bin) => {
    const e = expected.get(id);
    await atStep(P.bin); await scanLabel('rack', bin);
    await atStep(P.pallet); await scanLabel('pallet', id);
    await atStep(P.qty); await keyIn(e.qty);
    await skipComments();
  };
  /* the first one, talked through */
  const countPallet = async (id) => {
    const e = expected.get(id);
    await atStep(P.bin);
    await say(L('1 · Scan the rack label', '1 · Escanea la etiqueta del rack'), L('Point the scanner at the <b>yellow rack label</b> under the pallet and pull the trigger. Wait for the beep. That tells the system <b>where</b> you are; the scanner checks it is in your aisle.', 'Apunta el escáner a la <b>etiqueta amarilla del rack</b> debajo de la tarima y aprieta el gatillo. Espera el bip. Así el sistema sabe <b>dónde</b> estás; el escáner revisa que sea de tu pasillo.'));
    await scanLabel('rack', e.bin);
    await shotProp('rack'); await shotPhone('rack-scanned');
    await atStep(P.pallet);
    await say(L('2 · Scan the pallet label', '2 · Escanea la etiqueta de la tarima'), L('Now the <b>barcode on the pallet label</b>. The scanner shows the pallet number — it does <b>not</b> tell you how many should be there.', 'Ahora el <b>código de barras de la etiqueta de la tarima</b>. El escáner muestra el número de tarima — <b>no</b> te dice cuántas cajas debería haber.'));
    await scanLabel('pallet', id);
    await shotProp('pallet'); await shotPhone('pallet-scanned');
    await atStep(P.qty);
    await say(L('3 · Count, then type the quantity', '3 · Cuenta y escribe la cantidad'), L('Count the cases that are <b>really there</b>. Type the number on the number keys, then press <b>Enter</b>. Never type what you think it should be.', 'Cuenta las cajas que <b>de verdad están ahí</b>. Escribe el número con las teclas y oprime <b>Enter</b>. Nunca escribas lo que crees que debería ser.'));
    await countCases(e.qty);
    await shotPhone('quantity');
    await keyIn(e.qty);
    await atStep(P.comments, 8000);
  };

  /* ================================================================ the film */
  await cover(L('Day 1 · Counting crew', 'Día 1 · Equipo de conteo'), L('How to count with the scanner', 'Cómo contar con el escáner'),
    L('Scan the rack. Scan the pallet. Type what is there. That is the whole job — this film shows every step, slowly.', 'Escanea el rack. Escanea la tarima. Escribe lo que hay. Ese es todo el trabajo — este video muestra cada paso, despacio.'), 7000);

  /* ---------------------------------------------------------- 1 */
  await part(1, L('Before you start', 'Antes de empezar'), L('The scanner, its buttons, and your language.', 'El escáner, sus botones y tu idioma.'));
  await gun().waitForSelector('#scrSignon.active', { timeout: 30000 });
  await show('note', L('<b>The trigger</b> reads a barcode.<br><b>The number keys</b> type a quantity.<br><b>The screen</b> tells you what to scan next.', '<b>El gatillo</b> lee un código de barras.<br><b>Las teclas</b> escriben una cantidad.<br><b>La pantalla</b> te dice qué escanear.'), L('Three things to know', 'Tres cosas que saber'));
  await say(L('This is your scanner', 'Este es tu escáner'), L('The screen in the middle is the counting app. It asks <b>one thing at a time</b>, in big letters. Read the top of the screen, do what it says, and wait for the beep.', 'La pantalla del centro es la app de conteo. Te pide <b>una cosa a la vez</b>, con letras grandes. Lee la parte de arriba, haz lo que dice y espera el bip.'));
  await shotPhone('signon');
  if (LANG === 'es') {
    await say('Cambia a español', 'El botón <b>Español</b> arriba a la derecha cambia toda la pantalla a español. Se queda así en este escáner hasta que alguien lo cambie otra vez.', { text: 'La oficina siempre lee en inglés', ok: true }, { hold: false });
    await tap('#btnLang', { hold: 3200 });
    await beat(2600);
    await shotPhone('signon-es');
  } else {
    await say('English or Spanish', 'The <b>Español</b> button at the top right switches the whole screen to Spanish. It stays that way on this scanner until somebody switches it back.', { text: 'The office always reads English', ok: true }, { hold: false });
    const el = await gun().$('#btnLang'); const box = await el.boundingBox();
    await page.evaluate((b) => { const r = document.getElementById('ring'); Object.assign(r.style, { left: (b.x - 6) + 'px', top: (b.y - 6) + 'px', width: (b.width + 12) + 'px', height: (b.height + 12) + 'px' }); r.classList.add('on'); }, box);
    await beat(6500);
    await page.evaluate(() => document.getElementById('ring').classList.remove('on'));
  }

  /* ---------------------------------------------------------- 2 */
  await part(2, L('Signing on', 'Iniciar sesión'), L('Your team card, your badges, and your aisle.', 'Tu tarjeta de equipo, tus gafetes y tu pasillo.'));
  await say(L('Scan the team card', 'Escanea la tarjeta del equipo'), L('Your team has a card with a QR code. Scan it into <b>Team number</b>. No typing.', 'Tu equipo tiene una tarjeta con un código QR. Escanéala en <b>Número de equipo</b>. Sin escribir.'), '', { hold: false });
  await beat(2400);
  await gun().focus('#fTeam');
  await scanLabel('team', TEAM, { sel: '#fTeam' });
  await shotProp('team');
  await say(L('Scan every badge on the crew', 'Escanea el gafete de cada persona'), L('Next, everybody on the crew scans their <b>badge</b> — the clock-in number. Each name shows on the screen. Tap a number to take it off if it is wrong.', 'Luego, cada persona del equipo escanea su <b>gafete</b> — el número de empleado. Cada nombre aparece en la pantalla. Toca un número para quitarlo si está mal.'), '', { hold: false });
  await beat(3000);
  await scanLabel('badge', B1, { sel: '#fEmployee' });
  await shotProp('badge');
  await scanLabel('badge', B2, { sel: '#fEmployee' });
  await clearProp();
  await say(L('Sign on', 'Entrar'), L('When the whole crew is in, tap <b>Sign on &amp; load list</b>. The scanner downloads the count and can keep working even with <b>no Wi-Fi</b>.', 'Cuando todo el equipo está, toca <b>Entrar y cargar la lista</b>. El escáner descarga el conteo y puede seguir trabajando aunque <b>no haya Wi-Fi</b>.'), '', { hold: false });
  await beat(4200);
  await tap('#btnStart', { hold: 2600, shot: 'signon-filled' });
  await gun().waitForSelector('#scrAssign.active', { timeout: 60000 });
  await beat(1600);
  await say(L('Your aisle', 'Tu pasillo'), L('The scanner gives your team <b>its aisle</b> and the levels you count. Only your team works this aisle right now. When you are ready, tap <b>Start counting</b>.', 'El escáner le da a tu equipo <b>su pasillo</b> y los niveles que cuentan. Solo tu equipo trabaja este pasillo ahora. Cuando estén listos, toca <b>Empezar a contar</b>.'), { text: L('Aisle F01 · levels A–C', 'Pasillo F01 · niveles A–C'), ok: true });
  await shotPhone('your-aisle');
  await tap('#btnCount', { hold: 2200 });
  await gun().waitForSelector('#scrScan.active', { timeout: 60000 });
  await beat(1400);

  /* ---------------------------------------------------------- 3 */
  await part(3, L('Counting a pallet', 'Contar una tarima'), L('Three steps, over and over: the rack, the pallet, the quantity.', 'Tres pasos, una y otra vez: el rack, la tarima, la cantidad.'));
  await say(L('Where to go next', 'A dónde ir'), L('The box at the top says <b>Next bin</b> — the spot to go to. It walks you down the aisle in order, so nothing is missed.', 'El cuadro de arriba dice <b>Siguiente ubicación</b> — el lugar a donde ir. Te lleva por el pasillo en orden, para que no se pierda nada.'), { text: L('Follow the next bin', 'Sigue la siguiente ubicación') });
  await toTop(); await beat(600);
  await shotPhone('next-bin');
  await countPallet(palletAt.get(single[0])[0]);
  await shotPhone('comments');
  await say(L('4 · A comment, if there is one', '4 · Un comentario, si hay'), L('Last, the scanner offers quick reasons — damaged, partial, and so on. Tap one if it fits. Nothing to say? Tap <b>Skip</b>. On count day it also moves on by itself.', 'Al final, el escáner ofrece razones rápidas — dañada, incompleta, etc. Toca una si aplica. ¿Nada que decir? Toca <b>Saltar</b>. El día del conteo también sigue solo.'));
  await tap('#btnSkip', { hold: 1600 });
  await say(L('Saved', 'Guardado'), L('That pallet is counted and saved. The scanner sends it to the office by itself. Now the next one — the same three steps.', 'Esa tarima ya está contada y guardada. El escáner la manda a la oficina solo. Ahora la siguiente — los mismos tres pasos.'), { text: L('Rack · pallet · quantity', 'Rack · tarima · cantidad'), ok: true });
  /* the wrong label */
  {
    const id = palletAt.get(single[1])[0];
    const e = expected.get(id);
    await atStep(P.bin);
    await say(L('The wrong label? It tells you', '¿Etiqueta equivocada? Te avisa'), L('If you scan the <b>pallet label</b> when it asks for the <b>rack</b>, the scanner says so and records nothing. Just scan the right one.', 'Si escaneas la <b>etiqueta de la tarima</b> cuando pide el <b>rack</b>, el escáner te avisa y no guarda nada. Solo escanea la correcta.'), '', { hold: false });
    await beat(2400);
    await scanLabel('pallet', id, { bad: true });
    await beat(1600);
    await shotPhone('wrong-label');
    await beat(dwell('read the message on the screen it says this is a pallet not a bin'));
    await countLine(id, e.bin);
  }

  /* ---------------------------------------------------------- 4 */
  await part(4, L('When a bin is different', 'Cuando la ubicación es diferente'), L('Several pallets in one spot, and an empty spot.', 'Varias tarimas en un lugar, y un lugar vacío.'));
  {
    const stack = palletAt.get(triple);
    await say(L('More than one pallet in a spot', 'Más de una tarima en un lugar'), L(`This spot holds <b>${stack.length} pallets</b>. After the first one, the box turns orange: <b>Still in this bin</b>, with a count. Count every pallet in the spot before you move on.`, `Este lugar tiene <b>${stack.length} tarimas</b>. Después de la primera, el cuadro se pone naranja: <b>Sigues en esta ubicación</b>, con un contador. Cuenta cada tarima del lugar antes de seguir.`), { text: `${triple} · ${stack.length} ${L('pallets', 'tarimas')}` });
    let k = 0;
    for (const id of stack) {
      await countLine(id);
      if (++k === 1) { await shotPhone('still-in-bin'); await say(L('Still in this bin', 'Sigues en esta ubicación'), L(`<b>1 of ${stack.length}</b>. Keep going in the same spot.`, `<b>1 de ${stack.length}</b>. Sigue en el mismo lugar.`)); }
    }
    await say(L('All counted', 'Todas contadas'), L('When every pallet in the spot is counted, the box goes back to <b>Next bin</b> by itself. If the scanner expects more but there are none, tap <b>Nothing more here →</b>.', 'Cuando cada tarima del lugar está contada, el cuadro regresa a <b>Siguiente ubicación</b> solo. Si el escáner espera más pero no hay, toca <b>No hay más aquí →</b>.'), { text: L('Never leave a spot half counted', 'Nunca dejes un lugar a medias') });
  }
  await atStep(P.bin);
  await say(L('An empty spot', 'Un lugar vacío'), L('Nothing in the spot? That counts too. Scan the rack label as usual, then tap <b>Bin is EMPTY</b> and <b>Yes — it is empty</b>. Now the office knows it was checked and is empty.', '¿No hay nada en el lugar? Eso también cuenta. Escanea la etiqueta del rack como siempre, luego toca <b>Ubicación VACÍA</b> y <b>Sí — está vacía</b>. Así la oficina sabe que se revisó y está vacío.'), '', { hold: false });
  await beat(3600);
  await scanLabel('rack', emptyBin);
  await atStep(P.pallet);
  await tap('#btnEmpty', { hold: 2200, shot: 'empty-button' });
  await tap('#btnEmptyYes', { hold: 2000 });
  await beat(2000);

  /* ---------------------------------------------------------- 5 */
  await part(5, L('Labels', 'Etiquetas'), L('Two labels on one pallet, a label that will not scan, and a pallet nobody expected.', 'Dos etiquetas en una tarima, una etiqueta que no escanea, y una tarima que nadie esperaba.'));
  {
    const [id1, id2] = palletAt.get(doubles[0]);
    const e1 = expected.get(id1); const e2 = expected.get(id2);
    await atStep(P.bin);
    await say(L('A pallet with two labels', 'Una tarima con dos etiquetas'), L('Some pallets carry <b>two loads</b>, each with its own label and its own quantity. Scan the rack as usual. Then, before the first label, tap <b>This pallet has more than one label</b>.', 'Algunas tarimas llevan <b>dos cargas</b>, cada una con su etiqueta y su cantidad. Escanea el rack como siempre. Luego, antes de la primera etiqueta, toca <b>Esta tarima tiene más de una etiqueta</b>.'), '', { hold: false });
    await beat(3000);
    await scanLabel('rack', e1.bin);
    await atStep(P.pallet);
    await tap('#btnMultiLabel', { hold: 2400, shot: 'multi-label-button' });
    await say(L('Label 1 and its quantity', 'Etiqueta 1 y su cantidad'), L('Scan <b>label 1</b>, type its cases.', 'Escanea la <b>etiqueta 1</b>, escribe sus cajas.'), '', { hold: false });
    await scanLabel('pallet', id1);
    await keyIn(e1.qty);
    await skipComments();
    await shotPhone('multi-label-2');
    await say(L('Label 2 and its quantity', 'Etiqueta 2 y su cantidad'), L('Now <b>label 2</b> and its cases. The rack is not asked again.', 'Ahora la <b>etiqueta 2</b> y sus cajas. No pide el rack otra vez.'), '', { hold: false });
    await scanLabel('pallet', id2);
    await keyIn(e2.qty);
    await skipComments();
    await say(L('Done', 'Listo'), L('That was every label: tap <b>Done — that was every label</b>.', 'Esas eran todas las etiquetas: toca <b>Listo — eran todas las etiquetas</b>.'), '', { hold: false });
    await beat(2600);
    await tap('#btnMultiDone', { hold: 2200, shot: 'multi-label-done' });
    await beat(1200);
  }
  {
    const [id1, id2] = palletAt.get(doubles[1]);
    const e2 = expected.get(id2);
    await countLine(id1);
    await atStep(P.bin);
    await say(L('Saw the second label too late?', '¿Viste la segunda etiqueta tarde?'), L('Already counted the pallet and then spotted another label? Tap <b>Another label on the pallet just counted</b>. Scan it, type its cases, then <b>Done</b>.', '¿Ya contaste la tarima y luego viste otra etiqueta? Toca <b>Otra etiqueta en la tarima recién contada</b>. Escanéala, escribe sus cajas y luego <b>Listo</b>.'), '', { hold: false });
    await beat(5600);
    await tap('#btnSameLabel', { hold: 2400, shot: 'same-label-button' });
    await scanLabel('pallet', id2);
    await keyIn(e2.qty);
    await skipComments();
    await tap('#btnMultiDone', { hold: 2000 });
  }
  {
    const id = palletAt.get(single[4])[0];
    const e = expected.get(id);
    await atStep(P.bin); await scanLabel('rack', e.bin);
    await atStep(P.pallet);
    await prop(`<div class="prop"><div class="k">${L('PALLET LABEL', 'ETIQUETA DE TARIMA')}</div><div class="line"><b>${e.sku}</b> · ${e.desc}</div><div class="bars" style="filter:blur(3px) contrast(.4); opacity:.55">${svg(id)}</div><div class="line" style="margin-top:6px">${id}</div></div>`, L('Iced over — it will not scan', 'Con hielo — no escanea'));
    await say(L('A label that will not scan', 'Una etiqueta que no escanea'), L('Ice, a rip, a faded label. <b>Never skip the pallet.</b> Tap <b>Label will not scan</b>. If you can read the number, tap <b>I can read it — let me type it</b> and type it.', 'Hielo, rota, borrosa. <b>Nunca te saltes la tarima.</b> Toca <b>La etiqueta no escanea</b>. Si puedes leer el número, toca <b>La puedo leer — la escribo</b> y escríbelo.'), '', { hold: false });
    await beat(6200);
    await tap('#btnNoScan', { hold: 2200 });
    await shotPhone('no-scan');
    await tap('#btnNoScanType', { hold: 2200 });
    await gun().type('#fScan', id, { delay: Math.round(260 * PACE) });
    await beat(900);
    await gun().press('#fScan', 'Enter');
    await beat(1400);
    await atStep(P.qty); await keyIn(e.qty);
    await skipComments();
    await say(L('It goes on a list', 'Va a una lista'), L('The office gets a list of labels to replace, so somebody comes with a printer. You keep counting.', 'La oficina recibe una lista de etiquetas para cambiar, y alguien viene con una impresora. Tú sigues contando.'), { text: L('The pallet still gets counted', 'La tarima sí se cuenta'), ok: true });
  }
  {
    await atStep(P.bin); await scanLabel('rack', expected.get(palletAt.get(single[5])[0]).bin);
    await atStep(P.pallet);
    await say(L('A pallet nobody expected', 'Una tarima que nadie esperaba'), L('A pallet that is not on the list? The scanner asks <b>Count it anyway?</b> Tap <b>YES</b> and count it like any other. If it was simply the wrong barcode, tap <b>NO</b>.', '¿Una tarima que no está en la lista? El escáner pregunta <b>¿Contarla de todos modos?</b> Toca <b>SÍ</b> y cuéntala como cualquier otra. Si solo era el código equivocado, toca <b>NO</b>.'), '', { hold: false });
    await beat(4600);
    await scanLabel('pallet', 'HANDWRITTEN-91');
    await beat(1200);
    await shotPhone('not-on-list');
    await tap('#btnOvYes', { hold: 3000 });
    await atStep(P.qty); await keyIn(30);
    if (await gun().isVisible('#scrOverride.active').catch(() => false)) await tap('#btnOverrideAccept', { hold: 1600 }).catch(() => {});
    await skipComments().catch(() => {});
    await say(L('Found stock is never lost', 'La mercancía encontrada no se pierde'), L('The office sees it and adds it to the system. If the scanner ever asks <b>why</b> — a spot outside your aisle, a pallet already counted — pick a reason and tap <b>Accept and continue</b>.', 'La oficina la ve y la agrega al sistema. Si alguna vez el escáner pregunta <b>por qué</b> — un lugar fuera de tu pasillo, una tarima ya contada — escoge una razón y toca <b>Aceptar y seguir</b>.'), { text: L('Not sure? Ask your lead', '¿No estás seguro? Pregunta a tu líder') });
  }

  /* ---------------------------------------------------------- 6 */
  await part(6, L('Help and fixes', 'Ayuda y correcciones'), L('Mistakes, messages, no Wi-Fi, problems, and the SOS button.', 'Errores, mensajes, sin Wi-Fi, problemas y el botón SOS.'));
  await atStep(P.bin);
  await say(L('Made a mistake?', '¿Te equivocaste?'), L('Typed the wrong number before finishing? <b>Back</b> goes back one step. Already saved? Tap <b>History</b>: your last 50 lines. <b>Void this line</b> takes a wrong one out.', '¿Escribiste mal antes de terminar? <b>Atrás</b> regresa un paso. ¿Ya se guardó? Toca <b>Historial</b>: tus últimas 50 líneas. <b>Anular esta línea</b> quita una mal hecha.'), '', { hold: false });
  await beat(5400);
  await tap('#btnHistory', { hold: 2000 });
  await beat(1600);
  await shotPhone('history');
  await beat(3200);
  await tap('#btnHistoryBack', { hold: 1800 });
  await post(`/api/admin/sessions/${sess.id}/messages`, { team: TEAM, urgent: true, body: L('Bring the pallet jack to dock 4 when you finish this aisle', 'Lleven el patín a la puerta 4 cuando terminen este pasillo') });
  await gun().evaluate(() => window.dispatchEvent(new Event('online')));
  await say(L('A message from the office', 'Un mensaje de la oficina'), L('Your lead can send a message to your scanner. It buzzes and stays on the screen. Read it, then tap <b>Got it</b> — the office sees that you read it.', 'Tu líder puede mandar un mensaje a tu escáner. Vibra y se queda en la pantalla. Léelo y toca <b>Entendido</b> — la oficina ve que lo leíste.'), '', { hold: false });
  await gun().waitForFunction(() => { const el = document.getElementById('msgBar'); return el && !el.hidden; }, null, { timeout: 45000, polling: 600 }).catch(() => {});
  await beat(5200);
  await shotPhone('message');
  await tap('#btnMsgAck', { hold: 2400 });
  await say(L('No Wi-Fi? Keep counting', '¿Sin Wi-Fi? Sigue contando'), L('In the freezer the Wi-Fi can drop. The top of the screen says <b>OFFLINE</b>. <b>Keep counting.</b> Everything is saved on the scanner and sends by itself when the signal is back.', 'En el congelador el Wi-Fi se puede caer. Arriba dice <b>SIN SEÑAL</b>. <b>Sigue contando.</b> Todo se guarda en el escáner y se manda solo cuando regresa la señal.'), '', { hold: false });
  await ctx.setOffline(true);
  await gun().evaluate(() => window.dispatchEvent(new Event('offline')));
  await beat(4200);
  await countLine(palletAt.get(single[6])[0]);
  await shotPhone('offline');
  await beat(2400);
  await ctx.setOffline(false);
  await gun().evaluate(() => window.dispatchEvent(new Event('online')));
  await say(L('…and it catches up', '…y se pone al día'), L('Signal back: the lines go to the office on their own. Nothing to type again.', 'Regresó la señal: las líneas se van a la oficina solas. No hay que escribir nada otra vez.'), { text: L('Nothing is lost', 'No se pierde nada'), ok: true });
  await atStep(P.pallet);
  await say(L('Something is wrong with the spot', 'Algo está mal en el lugar'), L('Damaged pallet, broken rack, a spot blocked by a truck? Tap <b>Report a problem</b>, pick what it is, and scan to confirm. It goes on the office’s fix list. It is <b>not</b> an emergency.', '¿Tarima dañada, rack roto, un lugar bloqueado por un montacargas? Toca <b>Reportar un problema</b>, escoge qué es y escanea para confirmar. Va a la lista de arreglos de la oficina. <b>No</b> es una emergencia.'), '', { hold: false });
  await beat(6400);
  await tap('#btnIssue', { hold: 2200 });
  await beat(2400);
  await shotPhone('report-problem');
  await beat(2400);
  await tap('#btnIssueBack', { hold: 1600 });
  await say(L('SOS — when you need help now', 'SOS — cuando necesitas ayuda ya'), L('Hurt, stuck, equipment broken, or you need a supervisor: tap the red <b>SOS — I need help</b> and pick what is wrong. The office sees your team, your aisle and your last spot right away.', 'Si alguien se lastima, se queda atrapado, se rompe el equipo o necesitas un supervisor: toca el botón rojo <b>SOS — necesito ayuda</b> y escoge qué pasa. La oficina ve tu equipo, tu pasillo y tu último lugar de inmediato.'), '', { hold: false });
  await beat(6400);
  await tap('#btnSos', { hold: 2400 });
  await gun().waitForSelector('#scrSos.active', { timeout: 10000 }).catch(() => {});
  await beat(2400);
  await shotPhone('sos-list');
  const sosBtns = await gun().$$('#sosReasons button');
  if (sosBtns[2]) {
    const box = await sosBtns[2].boundingBox();
    await page.evaluate((b) => { const r = document.getElementById('ring'); Object.assign(r.style, { left: (b.x - 6) + 'px', top: (b.y - 6) + 'px', width: (b.width + 12) + 'px', height: (b.height + 12) + 'px' }); r.classList.add('on'); }, box);
    await beat(2600);
    await sosBtns[2].click();
    await page.evaluate(() => document.getElementById('ring').classList.remove('on'));
  }
  await beat(2600);
  const alerts = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/alerts`, { headers: A })).catch(() => ({}));
  const open = (alerts.alerts || alerts || []).find?.((a) => a.status === 'open');
  if (open) await post(`/api/admin/sessions/${sess.id}/alerts/${open.id}/seen`, {});
  await gun().evaluate(() => window.dispatchEvent(new Event('online')));
  await say(L('Help is coming', 'La ayuda viene'), L('When a supervisor picks it up, your scanner says <b>who has seen your SOS</b>. Then you know help is on the way. With no signal it tells you it has <b>not</b> been sent — then go and find someone.', 'Cuando un supervisor lo atiende, tu escáner dice <b>quién vio tu SOS</b>. Así sabes que la ayuda viene. Sin señal te dice que <b>no</b> se mandó — entonces ve a buscar a alguien.'), { text: L('Use it for real emergencies', 'Úsalo para emergencias de verdad') });
  await gun().waitForFunction(() => /seen|vio|visto/i.test(document.getElementById('sosBar')?.textContent || ''), null, { timeout: 30000, polling: 600 }).catch(() => {});
  await toTop(); await beat(600);
  await shotPhone('sos-seen');
  await beat(2200);
  if (await gun().isVisible('#btnSosBack').catch(() => false)) await tap('#btnSosBack', { hold: 1600 });

  /* ---------------------------------------------------------- 7 */
  await part(7, L('Second counts, and finishing', 'Segundos conteos, y terminar'), L('Counting a spot again, handing the aisle back, and signing off.', 'Volver a contar un lugar, entregar el pasillo y salir.'));
  const recBin = binsOf('F02').find((b) => /^F02A/.test(b) && (palletAt.get(b) || []).length === 1);
  await post(`/api/admin/sessions/${sess.id}/recounts`, { bin: recBin, team: TEAM, note: 'spot check' });
  await tap('#btnToAssign', { hold: 1800 });
  await gun().waitForSelector('#scrAssign.active', { timeout: 20000 });
  await tap('#btnAssignRefresh', { hold: 1200 }).catch(() => {});
  await beat(1600);
  await say(L('Second counts', 'Segundos conteos'), L('Sometimes the office needs a spot counted <b>again</b>, by a different team. When there are some for you, <b>My aisle</b> shows <b>Start second counts</b>.', 'A veces la oficina necesita contar un lugar <b>otra vez</b>, por otro equipo. Cuando hay para ti, <b>Mi pasillo</b> muestra <b>Empezar segundos conteos</b>.'), '', { hold: false });
  await beat(5400);
  await tap('#btnRecounts', { hold: 2600, shot: 'second-counts-offered' });
  await gun().waitForSelector('#scrScan.active', { timeout: 20000 });
  await beat(1400);
  await say(L('Count it like any spot', 'Cuéntalo como cualquier lugar'), L('The screen shows <b>SECOND COUNT</b> and the spot. Go there and count everything in it — rack, pallet, quantity. You are not told the first count. Then tap <b>Bin done — nothing more here</b>.', 'La pantalla muestra <b>SEGUNDO CONTEO</b> y el lugar. Ve ahí y cuenta todo — rack, tarima, cantidad. No te dicen el primer conteo. Luego toca <b>Ubicación terminada — no hay más aquí</b>.'));
  await toTop(); await beat(600);
  await shotPhone('second-count');
  await countLine(palletAt.get(recBin)[0], recBin);
  await tap('#btnRecountDone', { hold: 2600 });
  await beat(1600);
  if (!(await gun().isVisible('#scrAssign.active').catch(() => false))) await tap('#btnToAssign', { hold: 1400 }).catch(() => {});
  await gun().waitForSelector('#scrAssign.active', { timeout: 20000 }).catch(() => {});
  await say(L('Finished the aisle?', '¿Terminaste el pasillo?'), L('Only when every spot on your levels is counted: open <b>My aisle</b> and tap <b>Aisle complete — next aisle</b>. The scanner gives you the next one.', 'Solo cuando cada lugar de tus niveles está contado: abre <b>Mi pasillo</b> y toca <b>Pasillo terminado — siguiente pasillo</b>. El escáner te da el siguiente.'), '', { hold: false });
  await beat(5600);
  await tap('#btnAisleDone', { hold: 2600, shot: 'aisle-complete' });
  await beat(2600);
  await shotPhone('next-aisle');
  await say(L('End of your shift', 'Fin de tu turno'), L('Going on break or home? Tap <b>Sign off this scanner</b> on <b>My aisle</b> and put the scanner on its charger. The next crew signs on with their own card and badges.', '¿Te vas al descanso o a casa? Toca <b>Salir de este escáner</b> en <b>Mi pasillo</b> y pon el escáner en su cargador. El siguiente equipo entra con su tarjeta y gafetes.'));
  await clearProp();

  await cover(L('That is the job', 'Ese es el trabajo'), L('Rack · Pallet · Quantity', 'Rack · Tarima · Cantidad'),
    L('Count what is <b>really there</b>. Never skip a pallet. Not sure? Ask your lead — or press <b>SOS</b> if you need help now.', 'Cuenta lo que <b>de verdad hay</b>. Nunca te saltes una tarima. ¿Dudas? Pregunta a tu líder — o toca <b>SOS</b> si necesitas ayuda ya.'), 9000);

  /* ------------------------------------------------------------- the file */
  const video = page.video();
  await ctx.close();
  if (video) {
    const raw = await video.path();
    const secs = (Date.now() - t0) / 1000;
    /* the beeps, as a WAV laid under the picture: a bright chirp for a good scan, a low buzz for a refused one */
    const rate = 44100;
    const pcm = new Int16Array(Math.ceil((secs + 2) * rate));
    for (const [ms, kind] of beeps) {
      const start = Math.round((ms / 1000) * rate);
      const len = Math.round((kind === 'bad' ? 0.42 : 0.14) * rate);
      for (let i = 0; i < len && start + i < pcm.length; i++) {
        const t = i / rate;
        const env = Math.min(1, i / 200, (len - i) / 400);
        const v = kind === 'bad' ? Math.sign(Math.sin(2 * Math.PI * 220 * t)) * 0.18 : Math.sin(2 * Math.PI * 2800 * t) * 0.32;
        pcm[start + i] = Math.round(v * env * 32767);
      }
    }
    const wav = Buffer.alloc(44 + pcm.length * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(pcm.length * 2, 40);
    Buffer.from(pcm.buffer).copy(wav, 44);
    const wavPath = join(videoDir, 'beeps.wav');
    writeFileSync(wavPath, wav);
    const out = join(OUT, `scanner-training-${LANG}.mp4`);
    const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-i', wavPath, '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', out], { stdio: 'inherit' });
    if (ff.status !== 0) throw new Error('ffmpeg failed');
    console.log(`\n${out} written - ${(statSync(out).size / 1048576).toFixed(1)} MB, ${Math.round(secs / 60 * 10) / 10} min, ${beeps.length} scans`);
  }
  console.log(`${shotN} scanner pictures in ${SHOTS}`);
} catch (err) {
  /* a step that fails leaves a picture of the stage and the gun's state behind */
  console.error('[film] failed:', err && err.message);
  try {
    const pg = browser && browser.contexts()[0] && browser.contexts()[0].pages()[0];
    const g = pg && pg.frames().find((f) => f.url().includes('/?d='));
    if (g) console.error('[film] gun was at:', await g.evaluate(() => `${document.querySelector('.screen.active')?.id} · ${document.getElementById('prompt')?.textContent} · ${document.getElementById('scanMsg')?.textContent}`.replace(/\s+/g, ' ').slice(0, 200)));
    if (pg) await pg.screenshot({ path: join(OUT, `failed-${LANG}.png`) });
  } catch { /* gone */ }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  await wait(300);
  for (const d of [videoDir, dataDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
