/*
 * A word from the office to the floor.
 *
 * A supervisor watching the dashboard can see a team stalled in an aisle and
 * has no way to say so through ear defenders. A message goes to one team or to
 * all of them, lands on the handheld, and is acknowledged from the gun - so the
 * dashboard shows who read it rather than who was told.
 */
import { chromium } from 'playwright-core';
import { expandSubTabs, pickSession } from './helpers.mjs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

const BINS = 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A003,Freezer,F01\nF02A001,Freezer,F02\n';
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'radio silence' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: BINS });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });

const mkDevice = async (name) => {
  const d = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name }) }));
  const t = (await j(await fetch(`${BASE}/api/devices/${d.uid}`, { method: 'POST' }))).token;
  return { ...d, name, H: { ...hdr, authorization: 'Device ' + t } };
};
const one = await mkDevice('MSG-01');      // team 1
const two = await mkDevice('MSG-02');      // team 2
for (const [dev, team] of [[one, '1'], [two, '2']]) {
  await fetch(`${BASE}/api/sessions/${sess.id}/signon`, { method: 'POST', headers: dev.H, body: JSON.stringify({ deviceId: dev.name, team, employees: ['E1001'] }) });
}

/* ---------------- one team, not the other ---------------- */
const sent = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { method: 'POST', headers: A,
  body: JSON.stringify({ team: '1', body: '  Come to the dock   when you finish this aisle ' }) }));
check('A message is addressed to a team, and tidied up on the way in',
  sent.team === '1' && sent.body === 'Come to the dock when you finish this aisle', JSON.stringify(sent.body));
check('It says who sent it', sent.sent_by === 'Dana Whitfield', sent.sent_by);

const forOne = await j(await fetch(`${BASE}/api/sessions/${sess.id}/messages?team=1`, { headers: one.H }));
check('The team it was sent to has it', forOne.messages.length === 1 && forOne.messages[0].body === sent.body);
const forTwo = await j(await fetch(`${BASE}/api/sessions/${sess.id}/messages?team=2`, { headers: two.H }));
check('The team it was not sent to does not', forTwo.messages.length === 0, `${forTwo.messages.length} message(s)`);

await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { method: 'POST', headers: A,
  body: JSON.stringify({ body: 'Fifteen minute break at 10', urgent: true }) });
check('A message to every team reaches both',
  (await j(await fetch(`${BASE}/api/sessions/${sess.id}/messages?team=2`, { headers: two.H }))).messages.length === 1
  && (await j(await fetch(`${BASE}/api/sessions/${sess.id}/messages?team=1`, { headers: one.H }))).messages.length === 2);
check('An urgent one is offered first, whatever order it was sent in',
  (await j(await fetch(`${BASE}/api/sessions/${sess.id}/messages?team=1`, { headers: one.H }))).messages[0].urgent === true);
check('An empty message is refused rather than flashing a blank banner at a counter',
  (await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { method: 'POST', headers: A, body: JSON.stringify({ body: '   ' }) })).status === 400);
check('Sending needs a supervisor sign-in',
  (await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { method: 'POST', headers: hdr, body: JSON.stringify({ body: 'hello' }) })).status === 401);

/* ---------------- acknowledging ---------------- */
await fetch(`${BASE}/api/sessions/${sess.id}/messages/${sent.id}/ack`, { method: 'POST', headers: one.H, body: JSON.stringify({ team: '1' }) });
check('Once a scanner says it has read one, that scanner is not shown it again',
  (await j(await fetch(`${BASE}/api/sessions/${sess.id}/messages?team=1`, { headers: one.H }))).messages.every((m) => m.id !== sent.id));
const listed = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { headers: A }))).messages;
const mine = listed.find((m) => m.id === sent.id);
check('...and the dashboard says which scanner read it', mine.acks === 1 && /MSG-01/.test(mine.ack_devices), mine.ack_devices);
check('...out of the scanners it was meant for', mine.sent_to === 1, `${mine.acks} of ${mine.sent_to}`);
check('Acknowledging twice does not count twice',
  (await fetch(`${BASE}/api/sessions/${sess.id}/messages/${sent.id}/ack`, { method: 'POST', headers: one.H, body: JSON.stringify({ team: '1' }) })).ok
  && (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { headers: A }))).messages.find((m) => m.id === sent.id).acks === 1);

const all = listed.find((m) => !m.team);
await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages/${all.id}`, { method: 'DELETE', headers: A });
check('A supervisor can take a message off the scanners without losing what was said',
  (await j(await fetch(`${BASE}/api/sessions/${sess.id}/messages?team=2`, { headers: two.H }))).messages.length === 0
  && (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { headers: A }))).messages.some((m) => m.id === all.id));
check('Sending is recorded in the log',
  (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }))).some((r) => r.action === 'sent a message to the floor'));

/* ================= on the gun ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 400, height: 780 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${one.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(900);

/* ---- the sign-on screen asks the device for no keyboard either ---- */
check('Gun: the clock-in box does not ask for a keyboard — badges are scanned',
  (await gun.$eval('#fEmployee', (f) => f.inputMode || f.getAttribute('inputmode'))) === 'none');
check('Gun: nor does the team box', (await gun.$eval('#fTeam', (f) => f.inputMode || f.getAttribute('inputmode'))) === 'none');
check('Gun: and the cursor is already in the clock-in box, so a badge scan lands without a tap',
  await gun.evaluate(() => document.activeElement && document.activeElement.id === 'fEmployee'),
  await gun.evaluate(() => (document.activeElement || {}).id || 'nothing'));
await gun.click('#btnSignonKeyboard'); await gun.waitForTimeout(300);
check('Gun: whoever has to type says so first, and then gets one',
  (await gun.$eval('#fEmployee', (f) => f.inputMode)) === 'text' && (await gun.$eval('#fTeam', (f) => f.inputMode)) === 'numeric');
await gun.click('#btnSignonKeyboard'); await gun.waitForTimeout(300);
check('Gun: and can put it away again', (await gun.$eval('#fEmployee', (f) => f.inputMode)) === 'none');

check('Gun: the app asks the device to stay upright, one way up', await gun.evaluate(() => {
  // the manifest is what an installed app obeys; the API is the belt to its braces.
  // portrait-primary, not portrait - plain portrait is both ways up, and a gun
  // flipped end over end would be held upside down. See gun-portrait.mjs.
  return fetch('/manifest.webmanifest').then((r) => r.json()).then((mf) => mf.orientation === 'portrait-primary');
}));

await gun.selectOption('#fSession', String(sess.id));
await gun.fill('#fTeam', '1');
await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForTimeout(2600);
if (await gun.$('#scrAssign.active')) await gun.click('#btnCount');
await gun.waitForSelector('#scrScan.active', { timeout: 90000 }); await gun.waitForTimeout(800);

await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { method: 'POST', headers: A,
  body: JSON.stringify({ team: '1', body: 'Bring the pallet jack back to the dock', urgent: true }) });
const shown = await gun.waitForFunction(() => {
  const el = document.getElementById('msgBar');
  return el && !el.hidden && /pallet jack/.test(el.textContent);
}, null, { timeout: 40000, polling: 800 }).then(() => true).catch(() => false);
check('Gun: a message sent while counting arrives on its own', shown);
if (shown) {
  check('Gun: an urgent one is unmistakable', /urgent/i.test(await gun.$eval('#msgBar', (el) => el.className + ' ' + el.textContent)));
  check('Gun: it says who it came from', /Dana Whitfield/.test(clean(await gun.textContent('#msgFrom'))), clean(await gun.textContent('#msgFrom')));
  await gun.screenshot({ path: `${S}screenshots/gun-message.png` });
  await gun.click('#btnMsgAck');
  await gun.waitForTimeout(1200);
  check('Gun: tapping Got it takes it off the screen', await gun.$eval('#msgBar', (el) => el.hidden));
  const after = (await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/messages`, { headers: A }))).messages[0];
  check('...and the dashboard sees that it was read', after.acks === 1 && /MSG-01/.test(after.ack_devices || ''), after.ack_devices);
  check('Gun: and it does not come back on the next sync', await gun.$eval('#msgBar', (el) => el.hidden));
}
await gun.close();

/* ================= from the dashboard ================= */
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/admin');
await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#scrMain.active'); await expandSubTabs(page); await page.waitForTimeout(1800);
await pickSession(page, sess.id);
await page.waitForTimeout(1200);
check('Dashboard: the teams signed on are offered to send to',
  (await page.$$eval('#fMsgTeam option', (o) => o.map((x) => x.textContent))).join('|') === 'Every team|Team 1|Team 2',
  (await page.$$eval('#fMsgTeam option', (o) => o.map((x) => x.textContent))).join('|'));
await page.selectOption('#fMsgTeam', '2');
await page.fill('#fMsgBody', 'Start F02 when you are done');
await page.click('#btnSendMsg');
await page.waitForTimeout(1200);
check('Dashboard: sending says where it went',
  /Sent to team 2/.test(clean(await page.textContent('#msgMsg'))), clean(await page.textContent('#msgMsg')).slice(0, 80));
check('Dashboard: and it is in the list with nobody having read it yet',
  /Start F02 when you are done/.test(await page.textContent('#msgTable')) && /0 of 1/.test(await page.textContent('#msgTable')),
  clean(await page.textContent('#msgTable')).slice(0, 120));
await page.screenshot({ path: `${S}screenshots/dashboard-messages.png` });
await page.close();

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} message checks passed`);
await browser.close();
if (results.some((r) => r === false)) process.exitCode = 1;
