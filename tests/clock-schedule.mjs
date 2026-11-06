/*
 * The hours a count is worked. Given the shift and its breaks, the clock's
 * "done about" steps over a break and stops at the end of the shift, saying
 * how many bins would be left at the bell; a quiet spell inside a break is
 * named as the break. Set per count under Settings → Count setup, saved as
 * it is changed.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: typeof b === 'string' ? b : JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;
const mins = (ms) => Math.round(ms / 60000);
/* the site's clock (America/New_York on the test server): minutes past midnight now, and HH:MM of a moment */
const TZ = 'America/New_York';
const localHM = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`; };

/* the count from the clock suite: 8 lines over 16 counting minutes, 2 bins left, 6 bins an hour lately */
await post('/api/admin/idle-config', { minutes: 10, teams: false });
const sid = (await j(await post('/api/admin/sessions', { name: 'Shift-clocked count' }))).id;
await post(`/api/admin/sessions/${sid}/master?kind=bins`, 'Bin Location\n' + Array.from({ length: 10 }, (_, i) => `F01A00${i + 1}`).join('\n') + '\n', csv);
const dev = await j(await post('/api/admin/devices', { name: 'CLOCK-02' }));
const T = { ...hdr, authorization: 'Device ' + (await j(await post(`/api/devices/${dev.uid}`, {}, hdr))).token };
const now = Date.now();
const ago = (m) => new Date(now - m * 60000).toISOString();
const AT = [180, 178, 176, 120, 118, 10, 8, 6];
await post(`/api/sessions/${sid}/counts`, AT.map((m, i) => ({ clientId: `cs${i}`, palletId: `P-${i + 1}`, qty: 40, location: `F01A00${i + 1}`, team: '1', deviceId: 'CLOCK-02', scannedAt: ago(m) })), T);
const clock = async () => (await get(`/api/admin/sessions/${sid}/clocks`)).count;

/* no hours: every minute from now counts */
let c = await clock();
check('Without hours the finish is twenty minutes out, as before', c.binsLeft === 2 && near(mins(Date.parse(c.finishAt) - now), 20) && !c.schedule.on && c.finishNote === '', `${mins(Date.parse(c.finishAt) - now)} min, note "${c.finishNote}"`);

/* a break that starts in five minutes and lasts half an hour */
const brk = { from: localHM(now + 5 * 60000), to: localHM(now + 35 * 60000), label: 'Lunch' };
let sc = await j(await post(`/api/admin/sessions/${sid}/clock-schedule`, { on: true, breaks: [brk] }));
check('A schedule is saved per count and read back in words', sc.on && sc.breaks.length === 1 && sc.breaks[0].label === 'Lunch' && /breaks .*Lunch/.test(sc.words), sc.words);
c = await clock();
check('With a half-hour break in the way, the twenty minutes of counting finish about fifty minutes out', near(mins(Date.parse(c.finishAt) - now), 50) && c.finishBasis === 'recent', `${mins(Date.parse(c.finishAt) - now)} min`);
check('…and the clock says so: after lunch, with its times', /after lunch \d\d:\d\d–\d\d:\d\d/.test(c.finishNote) && c.schedule.on && /Lunch/.test(c.schedule.words), c.finishNote);

/* a shift that ends in eight minutes: the bell comes first */
const startHM = localHM(now - 4 * 3600000), endHM = localHM(now + 8 * 60000);
sc = await j(await post(`/api/admin/sessions/${sid}/clock-schedule`, { on: true, start: startHM, end: endHM, breaks: [] }));
c = await clock();
const finish = Date.parse(c.finishAt) - now;
check('The shift ends before the bins are done: the finish is next shift, and the note says what would be left at the bell', finish > 12 * 3600000 && finish < 36 * 3600000 && /not by \d\d:\d\d: about 1 bins? would be left at the bell/.test(c.finishNote) && c.binsLeftAtBell === 1 && c.shiftEndsAt, `${mins(finish)} min, "${c.finishNote}" left ${c.binsLeftAtBell}`);
check('…the schedule words carry the shift', new RegExp(`Shift ${startHM}–${endHM}`).test(c.schedule.words), c.schedule.words);

/* a quiet spell that is a scheduled break is named as one */
const lunch = { from: localHM(now - 60 * 60000), to: localHM(now - 20 * 60000), label: 'Lunch' };   // the 108-minute quiet spell ran through it
sc = await j(await post(`/api/admin/sessions/${sid}/clock-schedule`, { on: true, breaks: [lunch] }));
c = await clock();
check('A quiet spell that falls in a break is marked as that break; the other is not', c.spells.length === 2 && c.spells[1].scheduled === 'Lunch' && !c.spells[0].scheduled, JSON.stringify(c.spells.map((x) => x.scheduled)));
check('…and the time scheduled off inside the count is reckoned', mins(c.schedule.scheduledOffMs) === 40, String(mins(c.schedule.scheduledOffMs)));

/* what is refused */
check('A time that is not a time is refused, naming it', (await post(`/api/admin/sessions/${sid}/clock-schedule`, { on: true, start: '6 o\'clock' })).status === 400);
check('A break with one time is refused', (await post(`/api/admin/sessions/${sid}/clock-schedule`, { on: true, breaks: [{ from: '12:00' }] })).status === 400);
check('Switched off, the hours are kept but not used', !(await j(await post(`/api/admin/sessions/${sid}/clock-schedule`, { on: false, breaks: [lunch] }))).on && (await get(`/api/admin/sessions/${sid}/clock-schedule`)).breaks.length === 1 && !(await clock()).schedule.on);

/* the pages */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/settings#start`);
await signIn(page);
await pickSession(page, sid);
await page.waitForSelector('#clockCard'); await page.waitForTimeout(600);
check('Settings → Count setup has the card, with the break kept from before and the hours off', !(await page.isChecked('#fClockOn')) && /Lunch/.test(clean(await page.textContent('#clockBreaks'))), clean(await page.textContent('#clockBreaks')));
await page.click('#fClockOn'); await page.fill('#fClockStart', '06:00'); await page.fill('#fClockEnd', '14:30'); await page.waitForTimeout(1500);
sc = await get(`/api/admin/sessions/${sid}/clock-schedule`);
check('Tick Use these hours and type the shift: saved with no Save pressed', sc.on && sc.start === '06:00' && sc.end === '14:30', JSON.stringify(sc));
await page.fill('#fBreakFrom', '09:30'); await page.fill('#fBreakTo', '09:45'); await page.fill('#fBreakLabel', 'Coffee'); await page.click('#btnAddBreak'); await page.waitForTimeout(1500);
sc = await get(`/api/admin/sessions/${sid}/clock-schedule`);
check('Add a break: on the card as a chip, and saved', sc.breaks.length === 2 && sc.breaks.some((b) => b.label === 'Coffee' && b.from === '09:30') && (await page.locator('#clockBreaks .chip-btn').count()) === 2, JSON.stringify(sc.breaks));
await page.click('#clockBreaks .chip-btn[data-break="09:30-09:45"]'); await page.waitForTimeout(1500);
check('…click the chip and it is gone, and saved', (await get(`/api/admin/sessions/${sid}/clock-schedule`)).breaks.length === 1);
check('…the card says what it saved, in words', /Shift 06:00–14:30/.test(clean(await page.textContent('#clockMsg'))), clean(await page.textContent('#clockMsg')));
await page.goto(`${BASE}/admin`); await page.waitForSelector('#scrMain.active'); await pickSession(page, sid); await page.waitForTimeout(1500);
const strip = clean(await page.textContent('#countClock'));
check('The dashboard clock strip shows the hours, and where they are set', /Shift 06:00–14:30/.test(strip) && /Settings → Count setup/.test(strip), strip.slice(-160));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
