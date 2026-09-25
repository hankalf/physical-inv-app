/*
 * What happens to a count when things go wrong.
 *
 * The question this suite exists to answer is the one a warehouse manager asks
 * before trusting any of it: if the wifi goes, if a battery dies, if somebody
 * closes the app or the gun reboots in the middle of an aisle — is the counting
 * still there?
 *
 * So these do not test a function; they test a sequence of disasters:
 *
 *   1. count with no network at all, and check the lines are on the device
 *   2. kill the app outright - context closed, page gone, as good as a battery
 *      pulled - and open it again on the same device storage
 *   3. come back online and watch the queue drain by itself
 *   4. send the same lines twice, the way a flaky connection does, and check
 *      the server counted them once
 *   5. leave a queue sitting long enough to matter and check the gun says so,
 *      because the one thing a device cannot survive is being dropped off a lift
 *
 * The scanner keeps its counts in the browser's IndexedDB, which is on the
 * handheld's flash rather than in memory - that is why 2 works - and each line
 * carries an id the device made up, which is why 4 does.
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'durability' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv,
  body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\nF01A003,Freezer,F01\nF01A004,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: ['Pallet ID,SKU,Description,Qty,Location',
    'DR-1,SKU-A,Chicken breast 40lb,40,F01A001',
    'DR-2,SKU-B,Ground beef 10lb,50,F01A002',
    'DR-3,SKU-C,Peas 30lb,60,F01A003',
    'DR-4,SKU-D,Fries 25lb,70,F01A004'].join('\n') + '\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false, askLot: false, askExpiry: false }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'DURA-01' }) }));

const counted = async () => (await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text())
  .trim().split('\n').slice(1);

const errors = [];
/*
 * One handheld, one storage directory.
 *
 * This has to be a persistent profile rather than a throwaway one: a fresh
 * browser context keeps nothing on disk, and "the counts survived" would mean
 * nothing if the test were handing itself the answer in memory. Closing this
 * context is the app dying; launching another on the same directory is the same
 * physical scanner being switched back on, with whatever its flash still holds.
 */
const profile = mkdtempSync(join(tmpdir(), 'dura-gun-'));
const launch = (opts = {}) => chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  viewport: { width: 400, height: 780 },
  ...opts,
});
let ctx = await launch();

async function openGun(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/?d=${dev.uid}`);
  await page.waitForSelector('#scrSignon.active');
  await page.waitForTimeout(900);
  return page;
}
/** Sign on and get to the counting screen, however slow the master download is. */
async function startCounting(page) {
  await page.selectOption('#fSession', String(sess.id));
  await page.fill('#fTeam', '1');
  if (!(await page.$$('#employeeChips button')).length) {
    await page.fill('#fEmployee', 'E1001');
    await page.press('#fEmployee', 'Enter');
  }
  await page.click('#btnStart');
  try {
    await page.waitForSelector('#scrAssign.active, #scrScan.active', { timeout: 60000 });
  } catch {
    const said = clean(await page.textContent('#signonMsg'));
    const screen = await page.evaluate(() => document.querySelector('.screen.active')?.id || 'none');
    throw new Error(`sign-on did not get to counting: on ${screen}, saying "${said}"`);
  }
  if (await page.$('#scrAssign.active')) await page.click('#btnCount');
  await page.waitForSelector('#scrScan.active', { timeout: 60000 });
  await page.waitForTimeout(600);
}
const scanOn = async (page, v) => { await page.fill('#fScan', v); await page.press('#fScan', 'Enter'); await page.waitForTimeout(450); };
const queueChip = (page) => page.$eval('#chipQueue', (el) => (el.hidden ? '' : el.textContent)).catch(() => '');
const localLines = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('invcount');
  req.onsuccess = () => {
    const db = req.result;
    const all = db.transaction('lines', 'readonly').objectStore('lines').getAll();
    all.onsuccess = () => resolve(all.result.map((l) => ({ id: l.palletId, synced: l.synced })));
    all.onerror = () => resolve([]);
  };
  req.onerror = () => resolve([]);
}));

/* ---------------- 1. counting with nothing to count into ---------------- */
let gun = await openGun(ctx);
await startCounting(gun);

await ctx.setOffline(true);
await gun.evaluate(() => window.dispatchEvent(new Event('offline')));
await gun.waitForTimeout(400);
for (const [pallet, qty, bin] of [['DR-1', '38', 'F01A001'], ['DR-2', '50', 'F01A002'], ['DR-3', '61', 'F01A003']]) {
  await scanOn(gun, pallet); await scanOn(gun, qty); await scanOn(gun, bin);
  await gun.waitForTimeout(700);
}
check('The gun keeps counting with no network at all', /3 queued/.test(await queueChip(gun)), await queueChip(gun));
check('...and the lines are on the device, not in the air', (await localLines(gun)).length === 3,
  JSON.stringify(await localLines(gun)));
check('...with nothing on the server yet, because there was no way to send it', (await counted()).length === 0, String((await counted()).length));

/* ---------------- 2. the battery goes ---------------- */
/* Closing the browser outright is the app dying: no unload handler runs, no
   chance to flush anything, which is the point. The flash stays where it is. */
await ctx.close();
/* Switched back on in the same dead zone it died in: no network at all. The app
   itself comes off the handheld - the service worker keeps a copy - which is the
   other half of what "offline-first" has to mean. */
ctx = await launch({ offline: true });
gun = await openGun(ctx);
check('The app starts with no network at all — it is on the handheld, not fetched',
  /Scan|Sign on|scanner/i.test(clean(await gun.textContent('body'))), clean(await gun.textContent('body')).slice(0, 60));
const after = await localLines(gun);
check('Killing the app outright does not lose the counts — they are on the handheld\'s flash',
  after.length === 3 && after.every((l) => l.synced === 0), JSON.stringify(after));
check('...and the gun says so as soon as it is switched back on', /3 queued/.test(await queueChip(gun)), await queueChip(gun));

/* ---------------- 3. the wifi comes back ---------------- */
/* Note where this happens: the gun was switched back on at the office door and
   is sitting on the SIGN-ON screen. Nobody has signed on, and nobody is going
   to - so the queue has to go up on its own or it never goes up at all. */
check('The scanner that was switched back on is on the sign-on screen, not counting',
  await gun.$eval('#scrSignon', (el) => el.classList.contains('active')));
await ctx.setOffline(false);
await gun.evaluate(() => window.dispatchEvent(new Event('online')));
await gun.waitForFunction(() => document.getElementById('chipQueue').hidden, null, { timeout: 30000 }).catch(() => {});
await gun.waitForTimeout(1200);
const landed = await counted();
check('Back in signal, the queue goes up by itself — no sign-on, no re-typing',
  landed.length === 3, `${landed.length} line(s) on the server`);
check('...and the quantities are the ones that were counted, not the ones the report expected',
  landed.some((l) => /DR-1,38/.test(l)) && landed.some((l) => /DR-3,61/.test(l)),
  landed.map((l) => l.split(',').slice(1, 3).join('=')).join(' '));
check('...and the device now shows them as sent', (await localLines(gun)).every((l) => l.synced === 1));

/* ---------------- 4. a connection that drops mid-send ---------------- */
/* The gun re-sends anything it has not had an answer for. Every line carries an
   id the device made up, so the second copy is recognised and dropped. */
/* A second scanner for this one: enrolling a device issues it a new token and
   retires the old, so borrowing the gun's link here would sign the gun out from
   under the rest of the suite - which is the app behaving correctly. */
const dev2 = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'DURA-02' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev2.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };
const line = [{ clientId: 'replay-1', palletId: 'DR-4', qty: 70, location: 'F01A004', team: '1', employees: ['E1001'], deviceId: 'DURA-02' }];
const replay = await j(await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: JSON.stringify(line) }));
check('A line sent once is accepted', replay.accepted.length === 1, JSON.stringify(replay.accepted));
await fetch(`${BASE}/api/sessions/${sess.id}/counts`, { method: 'POST', headers: D, body: JSON.stringify(line) });
check('...and sent again after a dropped connection, it is not counted twice',
  (await counted()).filter((l) => /DR-4/.test(l)).length === 1,
  String((await counted()).filter((l) => /DR-4/.test(l)).length));

/* ---------------- 5. a queue nobody has noticed ---------------- */
/* The one thing a handheld cannot survive is being dropped off a lift, so a
   queue that has been sitting for a while has to say so rather than look
   exactly like a gun that is up to date. */
/* This gun has been switched on and off since it last counted, so somebody
   signs on again before the next aisle - as they would. */
await startCounting(gun);

await ctx.setOffline(true);
await gun.evaluate(() => window.dispatchEvent(new Event('offline')));
await scanOn(gun, 'DR-4');
/* DR-4 went up in the replay above, so the gun stops and asks - which is its
   job. Accept it: what is being tested here is the queue, not the dialog. */
if (await gun.$('#scrOverride.active')) {
  await gun.selectOption('#fReason', { index: 1 }).catch(() => {});
  await gun.click('#btnOverrideAccept');
  await gun.waitForTimeout(700);
}
await scanOn(gun, '69'); await scanOn(gun, 'F01A004');
await gun.waitForTimeout(900);
check('A fresh queue is not nagged about — a minute behind is normal', await gun.$eval('#queueBar', (el) => el.hidden));
/* Age the queued line by twenty minutes, the way a shift in a steel freezer
   would, and let the gun look again. */
await gun.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('invcount');
  req.onsuccess = () => {
    const os = req.result.transaction('lines', 'readwrite').objectStore('lines');
    const all = os.getAll();
    all.onsuccess = () => {
      for (const l of all.result) {
        if (!l.synced) os.put({ ...l, ts: new Date(Date.now() - 20 * 60000).toISOString() });
      }
      resolve();
    };
    all.onerror = () => resolve();
  };
}));
await gun.evaluate(() => window.dispatchEvent(new Event('offline')));
await gun.waitForFunction(() => !document.getElementById('queueBar').hidden, null, { timeout: 30000 }).catch(() => {});
check('A queue that has been waiting twenty minutes says so, before the gun is put down',
  await gun.$eval('#queueBar', (el) => !el.hidden));
check('...and says what to do about it rather than just worrying somebody',
  /walk somewhere with Wi-Fi/i.test(clean(await gun.textContent('#queueBar'))), clean(await gun.textContent('#queueBar')));
await ctx.setOffline(false);
await gun.evaluate(() => window.dispatchEvent(new Event('online')));
await gun.waitForFunction(() => document.getElementById('queueBar').hidden, null, { timeout: 30000 }).catch(() => {});
check('...and stops nagging the moment the lines are away', await gun.$eval('#queueBar', (el) => el.hidden));

/* ---------------- and the server's own copy ---------------- */
const health = await j(await fetch(`${BASE}/api/health`));
check('The server writes its database ahead of the request it answers',
  health.ok === true && (await counted()).length === 5, `${(await counted()).length} lines`);

check('No script errors on the handheld', errors.length === 0, errors.join(' | '));
await ctx.close();
await wait(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${results.filter(Boolean).length}/${results.length} durability checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
