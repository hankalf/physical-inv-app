/*
 * The SOS button.
 *
 * A counter in the middle of a freezer aisle cannot radio the office through ear
 * defenders. One button, a list of what is wrong in the site's own words, and a
 * supervisor knowing within seconds - with the team, the aisle and the last bin
 * attached, because where somebody is matters as much as what is wrong.
 *
 * The Teams channel is tested against a real HTTP endpoint this file starts
 * itself: the app posts a card to it exactly as it would to Microsoft, and the
 * card is read back and checked. No internet, no mock inside the app, and the
 * thing under test is the request that would really go out.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana Whitfield' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* ---------------- a channel to post into ---------------- */
const posted = [];
let answerWith = { status: 200, body: '1' };
const channel = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    posted.push({ url: req.url, body: (() => { try { return JSON.parse(body); } catch { return body; } })() });
    res.writeHead(answerWith.status, { 'content-type': 'text/plain' });
    res.end(answerWith.body);
  });
});
await new Promise((r) => channel.listen(0, '127.0.0.1', r));
/* A real Teams address carries its signature in the query string - that is the
   part that must never be shown again. */
const channelUrl = `http://127.0.0.1:${channel.address().port}/hook?sig=SUPERSECRETSIGNATURE`;

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'sos test' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv,
  body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\nF01A002,Freezer,F01\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv,
  body: 'Pallet ID,SKU,Description,Qty,Location\nSOS-1,SKU-A,Chicken breast 40lb,40,F01A001\n' });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false, askLot: false, askExpiry: false }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'SOS-01' }) }));
const dtok = (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token;
const D = { ...hdr, authorization: 'Device ' + dtok };

const alerts = async (q = '') => j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/alerts${q}`, { headers: A }));
const raise = async (body) => j(await fetch(`${BASE}/api/sessions/${sess.id}/alerts`, { method: 'POST', headers: D, body: JSON.stringify(body) }));

/* ---------------- the list a site writes ---------------- */
const def = await j(await fetch(`${BASE}/api/admin/sos-reasons`, { headers: A }));
check('It ships with the things that actually go wrong in a cold store',
  def.isDefault === true && def.reasons.some((r) => /Injury/i.test(r)) && def.reasons.some((r) => /unsafe/i.test(r)),
  def.reasons.slice(0, 3).join(' | '));
const mine = await j(await fetch(`${BASE}/api/admin/sos-reasons`, { method: 'POST', headers: A,
  body: JSON.stringify({ reasons: ['Injury — someone needs help now', 'Blast freezer door will not close', 'Need a supervisor'] }) }));
check('A site writes the list in its own words', mine.reasons.length === 3 && mine.isDefault === false, mine.reasons.join(' | '));
check('Editing it needs a supervisor sign-in',
  (await fetch(`${BASE}/api/admin/sos-reasons`, { method: 'POST', headers: hdr, body: '{}' })).status === 401);

const forGun = await j(await fetch(`${BASE}/api/sessions/${sess.id}/alerts`, { headers: D }));
check('A scanner is handed that list, so the gun offers the site\'s own words',
  forGun.reasons.join(' | ') === mine.reasons.join(' | '), forGun.reasons.join(' | '));

/* ---------------- raising one ---------------- */
const first = await raise({ clientId: 'sos-a', reason: 'Blast freezer door will not close',
  detail: 'It is icing the whole bay', team: '3', deviceId: 'SOS-01', employees: ['E1001', 'E1002'],
  aisle: 'F01', bin: 'F01A002' });
check('A scanner can raise one', first.alert && first.alert.status === 'open', JSON.stringify(first.alert?.reason));
check('...carrying where they are, which is half the point',
  first.alert.aisle === 'F01' && first.alert.bin === 'F01A002' && first.alert.team === '3',
  `${first.alert.team} · ${first.alert.aisle} · ${first.alert.bin}`);
check('...and who is on the gun', first.alert.employees.join(',') === 'E1001,E1002', first.alert.employees.join(','));
const again = await raise({ clientId: 'sos-a', reason: 'Blast freezer door will not close', team: '3', deviceId: 'SOS-01' });
check('A scanner that re-sends after a dropped signal raises one alert, not two',
  again.already === true && again.alert.id === first.alert.id, JSON.stringify(again.already));
check('An SOS with nothing wrong is refused',
  (await fetch(`${BASE}/api/sessions/${sess.id}/alerts`, { method: 'POST', headers: D, body: JSON.stringify({ reason: '' }) })).status === 400);
check('Raising one is in the log',
  (await j(await fetch(`${BASE}/api/admin/audit?limit=20`, { headers: A }))).some((r) => r.action === 'raised an SOS'));

const list = await alerts();
check('The dashboard has it, and counts what is still open', list.open === 1 && list.alerts.length === 1, JSON.stringify(list.open));

/* ---------------- answering it ---------------- */
const seen = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/alerts/${first.alert.id}/seen`, { method: 'POST', headers: A, body: '{}' }));
check('A supervisor says they are on it', seen.seen === true && seen.alert.status === 'seen' && seen.alert.seen_by === 'Dana Whitfield', seen.alert.seen_by);
const toGun = await j(await fetch(`${BASE}/api/sessions/${sess.id}/alerts`, { headers: D }));
check('...and the scanner that raised it is told, by name — which is what the counter is waiting for',
  toGun.mine[0].seen_by === 'Dana Whitfield' && toGun.mine[0].status === 'seen', JSON.stringify(toGun.mine[0]?.status));
const closed = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/alerts/${first.alert.id}/close`, { method: 'POST', headers: A, body: JSON.stringify({ outcome: 'Maintenance reset the door' }) }));
check('Closing it records what happened', closed.closed === true && /Maintenance/.test(closed.alert.outcome), closed.alert.outcome);
check('...and it stops being counted as open', (await alerts()).open === 0, String((await alerts()).open));
check('Answering one needs a supervisor sign-in',
  (await fetch(`${BASE}/api/admin/sessions/${sess.id}/alerts/${first.alert.id}/seen`, { method: 'POST', headers: hdr, body: '{}' })).status === 401);

/* ---------------- the Teams channel ---------------- */
check('With no channel set up, an alert simply stays on the dashboard',
  /teams off/.test((await alerts()).alerts[0].sent_to || ''), (await alerts()).alerts[0].sent_to);
const saved = await j(await fetch(`${BASE}/api/admin/teams-webhook`, { method: 'POST', headers: A,
  body: JSON.stringify({ url: channelUrl, on: true }) }));
check('A channel address is saved', saved.configured === true && saved.on === true);
check('...and never handed back in full — the signature in it is what makes it a key',
  !saved.masked.includes('SUPERSECRET') && saved.masked.includes('…'), saved.masked);
check('An address that is not https is refused — it is a key, crossing the internet',
  (await fetch(`${BASE}/api/admin/teams-webhook`, { method: 'POST', headers: A, body: JSON.stringify({ url: 'http://example.com/hook' }) })).status === 400);
check('...except on this machine, which is where somebody tests the wiring',
  (await fetch(`${BASE}/api/admin/teams-webhook`, { method: 'POST', headers: A, body: JSON.stringify({ url: channelUrl, on: true }) })).ok);

const test = await j(await fetch(`${BASE}/api/admin/teams-webhook/test`, { method: 'POST', headers: A, body: '{}' }));
check('A test card can be sent, so nobody finds out it is broken during an emergency', test.sent === true, JSON.stringify(test));
check('...and it really reached the channel', posted.length === 1, String(posted.length));
const card = posted[0].body;
check('...as an Adaptive Card, which is what Teams renders',
  card.type === 'message' && card.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive',
  card.attachments?.[0]?.contentType);

const live = await raise({ clientId: 'sos-b', reason: 'Injury — someone needs help now',
  detail: 'Marcus caught his hand on the racking', team: '2', deviceId: 'SOS-01', aisle: 'F02', bin: 'F02A011' });
await wait(900);
check('A real SOS goes to the channel', posted.length === 2, String(posted.length));
const sent = JSON.stringify(posted[1].body);
check('...leading with the team and what is wrong, because that is all a phone notification shows',
  /SOS from team 2/.test(sent) && /Injury/.test(sent), sent.slice(0, 160));
check('...with the aisle and the bin in it, so somebody knows where to go',
  /F02/.test(sent) && /F02A011/.test(sent));
check('...and the note the counter typed', /caught his hand/.test(sent));
check('The dashboard records that the channel took it',
  (await alerts()).alerts[0].sent_to === 'teams', (await alerts()).alerts[0].sent_to);

/* Closing it tells the channel too, so nobody drives over for something sorted. */
await fetch(`${BASE}/api/admin/sessions/${sess.id}/alerts/${live.alert.id}/close`, { method: 'POST', headers: A, body: JSON.stringify({ outcome: 'First aid done, back counting' }) });
await wait(900);
check('Closing one tells the channel it is dealt with', posted.length === 3 && /Cleared/.test(JSON.stringify(posted[2].body)),
  JSON.stringify(posted[2]?.body || '').slice(0, 120));

/* A channel that is down must not cost the alert. */
answerWith = { status: 500, body: 'nope' };
const whenDown = await raise({ clientId: 'sos-c', reason: 'Need a supervisor', team: '1', deviceId: 'SOS-01' });
await wait(900);
check('A channel that is down does not lose the alert — it is on the dashboard either way',
  whenDown.alert.status === 'open' && (await alerts()).open === 1, JSON.stringify(whenDown.alert?.status));
check('...and the dashboard says the channel did not take it',
  /teams failed/.test((await alerts()).alerts[0].sent_to || ''), (await alerts()).alerts[0].sent_to);
answerWith = { status: 200, body: '1' };

/* ================= on the gun ================= */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const gun = await browser.newPage({ viewport: { width: 400, height: 780 }, deviceScaleFactor: 2 });
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(900);
await gun.selectOption('#fSession', String(sess.id));
await gun.fill('#fTeam', '4'); await gun.fill('#fEmployee', 'E1001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForTimeout(2500);
if (await gun.$('#scrAssign.active')) await gun.click('#btnCount');
await gun.waitForSelector('#scrScan.active', { timeout: 90000 }); await gun.waitForTimeout(600);

check('Gun: the SOS button is on the counting screen', await gun.$eval('#btnSos', (b) => !b.hidden));
await gun.click('#btnSos');
await gun.waitForSelector('#scrSos.active');
await gun.waitForTimeout(800);
const offered = clean(await gun.textContent('#sosReasons'));
check('Gun: it offers the site\'s own list, not one somebody else wrote',
  /Blast freezer door will not close/.test(offered), offered.slice(0, 120));
check('Gun: and shows where it is about to say they are',
  /Team\s*4/.test(clean(await gun.textContent('#sosWhere'))) && /SOS-01/.test(clean(await gun.textContent('#sosWhere'))),
  clean(await gun.textContent('#sosWhere')));

await gun.fill('#fSosNote', 'Door seal is iced up');
await gun.click('#sosReasons button:has-text("Blast freezer")');
await gun.waitForTimeout(1500);
check('Gun: sending it says so plainly', /supervisor has been told/i.test(clean(await gun.textContent('#sosMsg'))), clean(await gun.textContent('#sosMsg')));
await gun.waitForTimeout(2800);
check('Gun: and it goes back to counting by itself', await gun.$eval('#scrScan', (el) => el.classList.contains('active')));
check('Gun: with a bar saying it is waiting to be picked up',
  await gun.$eval('#sosBar', (el) => !el.hidden) && /waiting/i.test(clean(await gun.textContent('#sosBar'))),
  clean(await gun.textContent('#sosBar')));

const raised = (await alerts()).alerts[0];
check('The dashboard has the one the gun raised, with the note',
  raised.team === '4' && /Blast freezer/.test(raised.reason) && /iced up/.test(raised.detail || ''),
  `${raised.team} · ${raised.reason} · ${raised.detail}`);

await fetch(`${BASE}/api/admin/sessions/${sess.id}/alerts/${raised.id}/seen`, { method: 'POST', headers: A, body: '{}' });
await gun.waitForFunction(() => /has seen your SOS/.test(document.getElementById('sosBar').textContent), null, { timeout: 30000 }).catch(() => {});
check('Gun: the counter is told, by name, that somebody is on it',
  /Dana Whitfield has seen your SOS/.test(clean(await gun.textContent('#sosBar'))), clean(await gun.textContent('#sosBar')));

/* No signal: the one thing worse than no SOS is a counter believing one was
   sent when it was not. */
await gun.context().setOffline(true);
await gun.evaluate(() => window.dispatchEvent(new Event('offline')));
await gun.click('#btnSos'); await gun.waitForSelector('#scrSos.active'); await gun.waitForTimeout(400);
await gun.click('#sosReasons button:has-text("Need a supervisor")');
await gun.waitForTimeout(1500);
check('Gun: with no signal it says the SOS has NOT been sent, rather than pretending',
  /NOT been sent/.test(clean(await gun.textContent('#sosMsg'))), clean(await gun.textContent('#sosMsg')));
const before = (await alerts()).alerts.length;
await gun.context().setOffline(false);
await gun.evaluate(() => window.dispatchEvent(new Event('online')));
await wait(3000);
check('...and sends it the moment there is signal', (await alerts()).alerts.length === before + 1,
  `${before} → ${(await alerts()).alerts.length}`);

/* ================= on the dashboard ================= */
/* Everything raised above is either closed or already answered, so the page
   would have nothing to act on: close the lot and raise one fresh, the way a
   supervisor meets an SOS - open, from somebody, somewhere. */
for (const a of (await alerts()).alerts) {
  if (a.status !== 'closed') {
    await fetch(`${BASE}/api/admin/sessions/${sess.id}/alerts/${a.id}/close`, { method: 'POST', headers: A, body: JSON.stringify({ outcome: 'test tidy-up' }) });
  }
}
/* A second scanner: the gun above enrolled itself when its page opened, which
   retires the token this file minted at the top - the app protecting a link
   from being used twice, doing its job. */
const dev2 = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'SOS-02' }) }));
const dtok2 = (await j(await fetch(`${BASE}/api/devices/${dev2.uid}`, { method: 'POST' }))).token;
const raised2 = await j(await fetch(`${BASE}/api/sessions/${sess.id}/alerts`, { method: 'POST',
  headers: { ...hdr, authorization: 'Device ' + dtok2 },
  body: JSON.stringify({ clientId: 'sos-ui', reason: 'Racking or a pallet looks unsafe',
    detail: 'Bay 12 is leaning', team: '2', deviceId: 'SOS-02', aisle: 'F02', bin: 'F02A012' }) }));
check('One more, for a supervisor to meet on the page', !!raised2.alert && raised2.alert.status === 'open',
  JSON.stringify(raised2.alert?.reason || raised2));
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => errors.push('admin: ' + e.message));
page.on('dialog', (d) => d.accept('Sorted'));
await page.goto(BASE + '/admin');
await signIn(page);
await pickSession(page, sess.id);
await page.waitForTimeout(1500);

check('Dashboard: an open SOS is above the page, not filed in a tab',
  await page.$eval('#sosAlert', (el) => !el.hidden), await page.$eval('#sosAlert', (el) => el.hidden ? 'hidden' : 'shown'));
const banner = clean(await page.textContent('#sosAlert'));
check('Dashboard: reading team, what is wrong and where', /SOS · team/.test(banner) && /aisle|last bin|SOS-01/.test(banner), banner.slice(0, 140));
await page.click('#sosAlert button:has-text("I am on it")');
await page.waitForTimeout(1200);
check('Dashboard: "I am on it" marks it and says who', /is on it/.test(clean(await page.textContent('#sosAlert'))), clean(await page.textContent('#sosAlert')).slice(0, 160));
await page.click('#sosAlert button:has-text("Close")');
await page.waitForTimeout(1500);
check('Dashboard: closing it clears the bar', await page.$eval('#sosAlert', (el) => el.hidden || !el.textContent.trim()));
check('Dashboard: and the list keeps every one of them, with what happened',
  /CLOSED/.test(clean(await page.textContent('#sosTable'))), clean(await page.textContent('#sosTable')).slice(0, 140));

check('No script errors', errors.length === 0, errors.join(' | '));
await browser.close();
await new Promise((r) => channel.close(r));

console.log(`\n${results.filter(Boolean).length}/${results.length} SOS checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
