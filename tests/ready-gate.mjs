/*
 * Hold sign-on until the count-day check passes: with the option on, a red
 * item on Ready for count day turns every scanner away, naming the items;
 * clear them or turn the hold off and the scanners are let in.
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
const get = async (p) => j(await fetch(BASE + p, { headers: A }));
const pj = async (p, b = {}) => j(await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) }));

/* a count with a bin list; the site admin's password is still "changeme", which is a red item */
const S = (await pj('/api/admin/sessions', { name: 'Gated count' })).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\nF01A001,Freezer,F01\n' });
await pj(`/api/admin/sessions/${S}/settings`, { guided: false, askComments: false });
const dev = await pj('/api/admin/devices', { name: 'GATE-01' });
const D = { ...hdr, authorization: 'Device ' + (await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST' }))).token };
const signon = () => fetch(`${BASE}/api/sessions/${S}/signon`, { method: 'POST', headers: D, body: JSON.stringify({ deviceId: 'GATE-01', team: '1', employees: ['E1'] }) });

let r = await get(`/api/admin/readiness?session=${S}`);
check('The count-day check has a red item (the password is still changeme) and the hold is off', r.fails >= 1 && r.hold.on === false && r.hold.held === false, JSON.stringify(r.hold));
check('With the hold off, the scanner signs on', (await signon()).status === 200);
await fetch(`${BASE}/api/sessions/${S}/signoff`, { method: 'POST', headers: D, body: JSON.stringify({ deviceId: 'GATE-01', team: '1' }) });

const st = await pj(`/api/admin/sessions/${S}/settings`, { holdUntilReady: true });
check('The count takes the hold', st.hold_until_ready === 1, JSON.stringify(st.hold_until_ready));
r = await get(`/api/admin/readiness?session=${S}`);
check('The readiness check says sign-on is held, and names the blockers', r.hold.on && r.hold.held && r.hold.blockers.some((b) => /changeme/.test(b)), JSON.stringify(r.hold));
const held = await signon();
const body = await j(held);
check('The scanner is turned away: 409, code notReady, the red items named', held.status === 409 && body.code === 'notReady' && /Sign-on is held until the count-day check passes: .*changeme/.test(body.error) && body.blockers.length >= 1, `${held.status} ${body.error}`);
check('…and it is in the log', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'refused a sign-on: the count is not ready'));
await pj(`/api/admin/sessions/${S}/settings`, { holdUntilReady: false });
check('Hold off again: the scanner is let in', (await signon()).status === 200);

/* ---------------- the Settings page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#start`);
await signIn(page);
await page.waitForSelector('#fHoldUntilReady', { timeout: 10000 });
await pickSession(page, S);
await page.waitForTimeout(600);
check('Settings → Count session: the option is there, off', await page.isVisible('#fHoldUntilReady') && !(await page.isChecked('#fHoldUntilReady')));
await page.check('#fHoldUntilReady');
await page.click('#btnSaveSettings'); await page.waitForTimeout(900);
check('Ticked and saved: the count holds sign-on', (await get(`/api/admin/sessions`)).find((x) => x.id === S).hold_until_ready === 1);
await page.click('#btnReadyRecheck'); await page.waitForTimeout(900);
check('…and the readiness card says sign-on is HELD', /Sign-on to it is HELD until the red items are fixed/.test(clean(await page.textContent('#readyMsg'))), clean(await page.textContent('#readyMsg')));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
