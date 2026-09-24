/*
 * A scanner that keeps up with the server on its own.
 *
 * These guns run as an installed app nobody ever closes - it sits on the cradle
 * overnight and is the same page in the morning. The service worker fetches from
 * the network before its cache, so a reload always lands the new app; nothing
 * ever made one reload. Thirty handhelds in a freezer is not a fleet anybody
 * wants to go round and relaunch by hand, and "reinstall it" is not an answer.
 *
 * So the server stamps what it is serving, the gun compares that against what it
 * is actually running, and reloads itself when it has fallen behind - but only
 * between pallets, and only with nothing waiting to be sent. Those two rules are
 * most of what these checks are about: an update that interrupts a count or
 * loses a line is worse than an update that waits five minutes.
 *
 * A deploy is faked here by answering the gun's own health check with a
 * different build, which is exactly what it would see the morning after one.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* ---------------- what the server says it is serving ---------------- */
const health = await j(await fetch(`${BASE}/api/health`));
check('The server stamps the build it is serving', /^[0-9a-f]{12}$/.test(health.build || ''), health.build);
const ownHash = (name) => createHash('sha256').update(readFileSync(`${S}../public/${name}`)).digest('hex').slice(0, 12);
check('...hashed from the files themselves, so nobody has to remember to bump a number',
  health.shell['/app.js'] === ownHash('app.js') && health.shell['/index.html'] === ownHash('index.html'),
  `${health.shell['/app.js']} vs ${ownHash('app.js')}`);
check('...for every file the handheld actually runs',
  ['/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/sw.js'].every((f) => health.shell[f]),
  Object.keys(health.shell).join(' '));
check('The health check needs no sign-in — a scanner asks it before anybody signs on', health.ok === true);

/* ---------------- a count for the gun to be busy with ---------------- */
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'update test' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv,
  body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nUP1,SKU-A,Chicken breast 40lb,100,F01A001\nUP2,SKU-B,Ground beef 10lb,50,F01A002\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'UPD-01' }) }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];

/**
 * A handheld, with a way to fake a deploy underneath it.
 *
 * `deployed(true)` answers the gun's health check with a different build - what
 * it would see the morning after somebody pushed. Each page load bumps a counter
 * that survives a reload, so these checks can tell a reload from a page that
 * simply sat there.
 */
async function handheld() {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 780 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    const n = Number(sessionStorage.getItem('loads') || 0) + 1;
    sessionStorage.setItem('loads', String(n));
  });
  let pretendDeployed = false;
  await ctx.route('**/api/health', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (pretendDeployed) {
      body.build = 'ffffffffffff';
      body.shell = { ...body.shell, '/app.js': 'ffffffffffff' };
    }
    await route.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  return { ctx, page, deployed: (v) => { pretendDeployed = v; } };
}

const loads = (page) => page.evaluate(() => Number(sessionStorage.getItem('loads') || 0));

/* ================= nothing to do ================= */
{
  const { ctx, page } = await handheld();
  await page.goto(`${BASE}/?d=${dev.uid}`);
  await page.waitForSelector('#scrSignon.active');
  await wait(2500);
  check('A scanner running the current app is left alone', (await loads(page)) === 1, `${await loads(page)} load(s)`);
  check('...and says nothing about updates', await page.$eval('#updateBar', (el) => el.hidden));
  await ctx.close();
}

/* ================= behind, and free to take it ================= */
{
  const { ctx, page, deployed } = await handheld();
  await page.goto(`${BASE}/?d=${dev.uid}`);
  await page.waitForSelector('#scrSignon.active');
  await wait(1200);
  deployed(true);
  /* Picking the gun up off the cradle is when it looks, so this is what a
     counter's first touch of the morning does. */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => Number(sessionStorage.getItem('loads') || 0) > 1, null, { timeout: 20000 })
    .catch(() => {});
  check('A scanner left on yesterday\'s app reloads itself, with nothing counted to lose',
    (await loads(page)) === 2, `${await loads(page)} load(s)`);
  /* This fake keeps saying the gun is behind however many times it reloads,
     which is what a proxy serving stale files would look like. One reload per
     build, then it stops and says so - a scanner reloading itself in a loop
     halfway down an aisle is worse than one running last week's app. */
  await wait(4000);
  check('...once, and only once, however stubbornly the server disagrees',
    (await loads(page)) === 2, `${await loads(page)} load(s)`);
  check('...and then it says the update did not take, rather than looping',
    /did not take/i.test(clean(await page.textContent('#scanMsg'))), clean(await page.textContent('#scanMsg')));
  await ctx.close();
}

/* ================= behind, but mid-pallet ================= */
{
  const { ctx, page, deployed } = await handheld();
  await page.goto(`${BASE}/?d=${dev.uid}`);
  await page.waitForSelector('#scrSignon.active'); await wait(900);
  await page.selectOption('#fSession', String(sess.id));
  await page.fill('#fTeam', '1'); await page.fill('#fEmployee', 'E1001'); await page.press('#fEmployee', 'Enter');
  await page.click('#btnStart'); await wait(2500);
  if (await page.$('#scrAssign.active')) await page.click('#btnCount');
  await page.waitForSelector('#scrScan.active', { timeout: 90000 }); await wait(600);
  const before = await loads(page);

  // half way through a pallet: the quantity is in, the bin is not
  const scan = async (v) => { await page.fill('#fScan', v); await page.press('#fScan', 'Enter'); await wait(450); };
  await scan('UP1');
  await scan('100');
  check('Counting: mid-line, on the bin step', /BIN/.test(clean(await page.textContent('#prompt'))), clean(await page.textContent('#prompt')));

  deployed(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await wait(3000);
  check('A counter half way through a pallet does not get the screen pulled out from under them',
    (await loads(page)) === before, `${await loads(page)} vs ${before}`);
  check('...but the gun says an update is waiting rather than doing it silently',
    await page.$eval('#updateBar', (el) => !el.hidden));
  check('...and says it will wait',
    /finish this pallet/.test(clean(await page.textContent('#updateBar'))), clean(await page.textContent('#updateBar')));
  check('...and the line is still there to finish',
    /UP1/.test(clean(await page.textContent('#ctx'))), clean(await page.textContent('#ctx')).slice(0, 80));

  // finish it: the line commits, the queue drains, and then it may reload
  await scan('F01A001');
  await page.waitForFunction(() => Number(sessionStorage.getItem('loads') || 0) > 1, null, { timeout: 20000 })
    .catch(() => {});
  check('...and it takes the update as soon as the pallet is finished', (await loads(page)) === before + 1,
    `${await loads(page)} vs ${before}`);

  // the line survived the reload, which is the whole point of waiting
  await wait(1500);
  const counts = (await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text()).trim().split('\n');
  check('The pallet counted just before the reload is on the server', counts.some((l) => /UP1/.test(l)),
    counts[1] ? counts[1].slice(0, 60) : 'nothing');
  await ctx.close();
}

/* ================= a site that would rather do it itself ================= */
{
  await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ autoUpdate: false }) });
  const saved = await j(await fetch(`${BASE}/api/admin/scanner-layout`, { headers: A }));
  check('Updating itself can be turned off', saved.autoUpdate === false, String(saved.autoUpdate));

  const { ctx, page, deployed } = await handheld();
  await page.goto(`${BASE}/?d=${dev.uid}`);
  await page.waitForSelector('#scrSignon.active'); await wait(900);
  await page.selectOption('#fSession', String(sess.id));
  await page.fill('#fTeam', '1'); await page.fill('#fEmployee', 'E1001'); await page.press('#fEmployee', 'Enter');
  await page.click('#btnStart'); await wait(2500);
  if (await page.$('#scrAssign.active')) await page.click('#btnCount');
  await page.waitForSelector('#scrScan.active', { timeout: 90000 }); await wait(800);
  const before = await loads(page);
  deployed(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await wait(3000);
  check('...and then a scanner keeps what it is running until somebody closes it',
    (await loads(page)) === before && await page.$eval('#updateBar', (el) => el.hidden), String(await loads(page)));
  await ctx.close();

  await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ autoUpdate: true }) });
  check('...and turned back on', (await j(await fetch(`${BASE}/api/admin/scanner-layout`, { headers: A }))).autoUpdate === true);
}

/* The question this whole thing exists to answer - "did this gun get the new
   version?" - is on the sign-on screen, so nobody has to guess. */
{
  const { ctx, page } = await handheld();
  await page.goto(`${BASE}/?d=${dev.uid}`);
  await page.waitForSelector('#scrSignon.active');
  await page.waitForFunction(() => /App build/.test(document.getElementById('buildInfo').textContent), null, { timeout: 15000 }).catch(() => {});
  const line = clean(await page.textContent('#buildInfo'));
  check('The sign-on screen says which build the server has and whether this gun has it',
    new RegExp(`App build ${health.build}`).test(line) && /up to date/.test(line), line);
  await ctx.close();
}

check('It ships on, because a fleet nobody updates is a fleet running last month\'s app',
  (await j(await fetch(`${BASE}/api/admin/scanner-layout`, { headers: A }))).autoUpdate === true);
check('No script errors on the handheld', errors.length === 0, errors.join(' | '));
await browser.close();

console.log(`\n${results.filter(Boolean).length}/${results.length} self-update checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
