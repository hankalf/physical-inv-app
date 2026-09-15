/* The one-tap reasons the gun offers, and the comments step moving itself on. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { expandSubTabs } from './helpers.mjs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'prompt test' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: readFileSync(`${S}fixtures/pallets.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: true }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'PROMPT-01' }) }));

/* ---------------- the API ---------------- */
const def = await j(await fetch(`${BASE}/api/admin/scanner-prompts`, { headers: A }));
check('It ships with sensible defaults', def.isDefault === true && def.comments.includes('Damaged') && def.commentTimeout === 5,
  `${def.comments.length} comments, timeout ${def.commentTimeout}`);
const saved = await j(await fetch(`${BASE}/api/admin/scanner-prompts`, { method: 'POST', headers: A,
  body: JSON.stringify({ comments: ['Frozen to the rack', '  Frozen to the rack ', 'Shrink wrap torn', ''], commentTimeout: 3 }) }));
check('Saving trims, drops blanks and de-duplicates',
  saved.comments.join('|') === 'Frozen to the rack|Shrink wrap torn', saved.comments.join('|'));
check('...and leaves the list you did not touch alone', saved.overrides.length === def.overrides.length);
const capped = await j(await fetch(`${BASE}/api/admin/scanner-prompts`, { method: 'POST', headers: A, body: JSON.stringify({ commentTimeout: 9999 }) }));
check('A silly timeout is clamped rather than accepted', capped.commentTimeout === 120, String(capped.commentTimeout));
await fetch(`${BASE}/api/admin/scanner-prompts`, { method: 'POST', headers: A, body: JSON.stringify({ commentTimeout: 3 }) });
check('Editing them needs a sign-in', (await fetch(`${BASE}/api/admin/scanner-prompts`)).status === 401);

const pub = await j(await fetch(`${BASE}/api/sessions`, { headers: { authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token } }));
check('The gun is told the list with its session',
  pub[0] && pub[0].prompts && pub[0].prompts.comments.includes('Frozen to the rack'),
  JSON.stringify(pub[0]?.prompts?.comments || []));

/* ================= on the gun ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(800);


/** Walk the gun from wherever it is into the counting screen. */
async function intoCounting(page) {
  for (let i = 0; i < 12; i++) {
    if (await page.$('#scrScan.active')) return true;
    if (await page.$('#scrAssign.active')) { await page.click('#btnCount'); await page.waitForTimeout(600); continue; }
    if (await page.$('#scrSignon.active')) {
      await page.selectOption('#fSession', String(sess.id)).catch(() => {});
      await page.fill('#fTeam', '1');
      if (!(await page.$$('#empChips .chip-btn')).length) { await page.fill('#fEmployee', 'E1001'); await page.press('#fEmployee', 'Enter'); }
      await page.click('#btnStart'); await page.waitForTimeout(1500); continue;
    }
    await page.waitForTimeout(500);
  }
  return !!(await page.$('#scrScan.active'));
}

const pallets = readFileSync(`${S}fixtures/pallets.csv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
const p1 = pallets.find((c) => /^F01/.test(c[5] || ''));
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(400); };
/* Wait for the prompt to come back round before starting the next pallet, or a
   scan lands on the previous line's comments step and the sequence desyncs. */
const atPallet = () => gun.waitForFunction(() => /PALLET/.test(document.getElementById('prompt').textContent), null, { timeout: 15000 });
const countOne = async (c) => { await atPallet(); await scan(c[0]); await scan(String(c[4])); await scan(c[5]); await gun.waitForTimeout(500); };
await intoCounting(gun);
await countOne(p1);
check('Gun: the comments step offers the site\'s reasons, not the shipped ones',
  (await gun.$$eval('#commentChips .chip-btn', (b) => b.map((x) => x.textContent))).join('|') === 'Frozen to the rack|Shrink wrap torn',
  (await gun.$$eval('#commentChips .chip-btn', (b) => b.map((x) => x.textContent))).join('|'));
check('Gun: it says it is about to move on', /Moving on to the next bin/.test(await gun.textContent('#moveOn')), clean(await gun.textContent('#moveOn')));

// left alone, it moves on by itself
await gun.waitForFunction(() => document.getElementById('prompt').textContent.includes('PALLET'), null, { timeout: 12000 });
check('Gun: left alone, the comments step moves on to the next bin by itself', true, 'after ~3s');
const lines = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A }).then((r) => ({ json: async () => (await r.text()).trim().split('\n') })));
check('Gun: the line was still saved when it moved on', lines.length === 2, `${lines.length - 1} line(s)`);

// typing stops the clock
const p2 = pallets.filter((c) => /^F01/.test(c[5] || ''))[1];
await countOne(p2);
await gun.fill('#fScan', 'still writing');
await gun.waitForTimeout(5000);
check('Gun: typing stops the clock, so nobody is cut off mid-note',
  /Take your time/.test(await gun.textContent('#moveOn')) && /Comments/.test(await gun.textContent('#prompt')),
  clean(await gun.textContent('#moveOn')));
await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(2500);
{
  const csvText = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text();
  check('Gun: and the note they typed is kept', /still writing/.test(csvText),
    (csvText.trim().split('\n').slice(1).map((l) => l.split(',')[7]).filter(Boolean).join(' | ') || 'no comments recorded'));
}

/* ---- the override reasons, which are the site's too ---- */
{
  const want = ['Frozen to the rack — cannot move it', 'Hand-written label'];
  await fetch(`${BASE}/api/admin/scanner-prompts`, { method: 'POST', headers: A, body: JSON.stringify({ overrides: want }) });
  await gun.reload(); await gun.waitForTimeout(2000);
  await intoCounting(gun);
  await atPallet();
  await scan('NOT-ON-THE-LIST');       // an unknown pallet is what asks for a reason
  await gun.waitForTimeout(700);
  const opts = await gun.$$eval('#fReason option', (o) => o.map((x) => x.textContent));
  check('Gun: the override reasons are the site\'s, not the ones built into the page',
    want.every((w) => opts.includes(w)) && !opts.includes('New pallet not in master file'), opts.join(' | '));
  check('Gun: "Other" is always offered, whatever the site configured', opts.includes('Other'), opts.join(' | '));
  await gun.click('#btnOverrideCancel'); await gun.waitForTimeout(500);
}

/* ---- an edit mid-shift reaches a gun that is already signed on ---- */
{
  await fetch(`${BASE}/api/admin/scanner-prompts`, { method: 'POST', headers: A,
    body: JSON.stringify({ comments: ['Frozen to the rack', 'Shrink wrap torn', 'Blocked by a trailer'], overrides: ['Supervisor on the radio'] }) });
  // the gun re-reads site settings on its sync tick, so give it one
  await gun.waitForTimeout(18000);
  const p5 = pallets.filter((c) => /^F01/.test(c[5] || ''))[4];
  await countOne(p5);
  const chips = await gun.$$eval('#commentChips .chip-btn', (b) => b.map((x) => x.textContent));
  check('Gun: a reason added mid-shift reaches a scanner nobody signed out of',
    chips.includes('Blocked by a trailer'), chips.join('|'));
  await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(800);
  await atPallet();
  await scan('ALSO-NOT-ON-THE-LIST');
  await gun.waitForTimeout(700);
  const opts = await gun.$$eval('#fReason option', (o) => o.map((x) => x.textContent));
  check('Gun: so does a new override reason', opts.includes('Supervisor on the radio'), opts.join(' | '));
  await gun.click('#btnOverrideCancel'); await gun.waitForTimeout(500);
  await fetch(`${BASE}/api/admin/scanner-prompts`, { method: 'POST', headers: A,
    body: JSON.stringify({ comments: ['Frozen to the rack', 'Shrink wrap torn'],
      overrides: ['Label unreadable', 'New receipt, not on the report', 'Relabelled', 'Hand-written ID'] }) });
  await gun.reload(); await gun.waitForTimeout(1500); await intoCounting(gun);
}

// tapping a chip also stops it
const p3 = pallets.filter((c) => /^F01/.test(c[5] || ''))[2];
await countOne(p3);
await gun.click('#commentChips .chip-btn'); await gun.waitForTimeout(4500);
check('Gun: tapping a reason also stops the clock', /Take your time/.test(await gun.textContent('#moveOn')));
await gun.screenshot({ path: `${S}screenshots/gun-comment-timer.png` });
await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(700);

// turned off, it waits
await fetch(`${BASE}/api/admin/scanner-prompts`, { method: 'POST', headers: A, body: JSON.stringify({ commentTimeout: 0 }) });
await gun.reload(); await gun.waitForTimeout(2000);
if (await intoCounting(gun)) {
  const p4 = pallets.filter((c) => /^F01/.test(c[5] || ''))[3];
  await countOne(p4);
  await gun.waitForTimeout(3000);
  check('Gun: with the timeout at 0 the step waits for the counter',
    await gun.$eval('#moveOn', (el) => el.hidden) && /Comments/.test(await gun.textContent('#prompt')));
} else { check('Gun: with the timeout at 0 the step waits for the counter', false, 'gun did not return to scanning'); }
await gun.close();

/* ================= in the admin panel ================= */
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(BASE + '/settings');
await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); await page.waitForTimeout(1800);
check('Settings: the reasons are listed and removable',
  (await page.$$('#commentList .chip-btn')).length === 2 && (await page.$$('#overrideList .chip-btn')).length >= 3,
  `${(await page.$$('#commentList .chip-btn')).length} comments`);
await page.fill('#fNewComment', 'Pallet on its side'); await page.click('#btnAddComment'); await page.waitForTimeout(300);
check('Settings: a reason can be added', (await page.$$('#commentList .chip-btn')).length === 3);
await page.fill('#fNewComment', 'pallet on its side'); await page.click('#btnAddComment'); await page.waitForTimeout(300);
check('Settings: adding the same one twice is refused', /already there/.test(await page.textContent('#promptMsg')), clean(await page.textContent('#promptMsg')));
await page.click('#commentList .chip-btn'); await page.waitForTimeout(300);
check('Settings: clicking one removes it', (await page.$$('#commentList .chip-btn')).length === 2);
await page.fill('#fCommentTimeout', '7');
await page.click('#btnSavePrompts'); await page.waitForTimeout(800);
check('Settings: saving reports what the scanners will do',
  /move on by itself after 7/.test(await page.textContent('#promptMsg')), clean(await page.textContent('#promptMsg')).slice(0, 90));
const after = await j(await fetch(`${BASE}/api/admin/scanner-prompts`, { headers: A }));
check('Settings: and it really is saved', after.commentTimeout === 7 && after.comments.includes('Pallet on its side'), after.comments.join('|'));
await page.screenshot({ path: `${S}screenshots/scanner-prompts.png`, clip: { x: 0, y: 0, width: 1500, height: 620 } });
const log = await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }));
check('Changing them is recorded in the log', log.some((r) => r.action === 'changed the scanner reasons'));
await page.click('#btnResetPrompts'); await page.waitForTimeout(400);
check('Settings: the defaults can be restored', /press Save/.test(await page.textContent('#promptMsg')));
await page.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} scanner-prompt checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
