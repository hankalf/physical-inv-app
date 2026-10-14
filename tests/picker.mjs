/*
 * The count picker in the office header.
 *
 * A page opens on an open full count - the one the scanners land on, else
 * the newest - and, with no full count open, on an open cycle count. It lists
 * only the kinds of count the login may work and the site has switched on.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) });
const get = async (p) => j(await fetch(BASE + p, { headers: A }));

/* a cycle count made first, a full count after it: the full count is still the one to open on */
const cyc = await j(await post('/api/admin/sessions', { name: 'Daily cycle', mode: 'cycle' }));
const full1 = await j(await post('/api/admin/sessions', { name: 'October count' }));
const full2 = await j(await post('/api/admin/sessions', { name: 'November count' }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await page.goto(`${BASE}/admin`);
await signIn(page, { user: 'DANA-WHITFIELD' });
const current = async () => clean(await page.textContent('#sessionPick .sess-btn'));
const rows = async () => { await page.click('#sessionPick .sess-btn'); await page.waitForTimeout(300); const r = await page.$$eval('#sessionPick .sess-row', (rs) => rs.map((x) => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 40))); await page.keyboard.press('Escape'); return r; };
check('The dashboard opens on the newest open full count, not the newer cycle count', /FULL.*November count/.test(await current()), await current());
await post('/api/admin/default-session', { sessionId: full1.id });
await page.reload(); await page.waitForSelector('#sessionPick .sess-btn'); await page.waitForTimeout(1200);
check('…unless the scanners land on another full count: then that one', /FULL.*October count/.test(await current()), await current());
let r = await rows();
check('The menu lists both full counts and the cycle count', r.some((x) => /CYCLE.*Daily cycle/.test(x)) && r.filter((x) => /FULL/.test(x)).length === 2, r.join(' | '));
await post(`/api/admin/sessions/${full1.id}/status`, { status: 'closed' });
await post(`/api/admin/sessions/${full2.id}/status`, { status: 'closed' });
await page.reload(); await page.waitForSelector('#sessionPick .sess-btn'); await page.waitForTimeout(1200);
check('With no full count open, it opens on the open cycle count', /CYCLE.*Daily cycle/.test(await current()), await current());
check('The Full Counts page still opens on a full count, the newest closed one', await (async () => { await page.goto(`${BASE}/full`); await page.waitForTimeout(1500); return /November count|October count/.test(await current()); })(), await current());
await page.goto(`${BASE}/admin`); await page.waitForTimeout(1200);

/* cycle counts switched off for the site: gone from the list and the picker */
await post('/api/admin/features', { cycle: false });
check('With cycle counts switched off, the session list has no cycle count', !(await get('/api/admin/sessions')).some((s) => s.mode === 'cycle'));
await page.reload(); await page.waitForSelector('#sessionPick .sess-btn'); await page.waitForTimeout(1200);
r = await rows();
check('…and the picker shows none, opening on the newest full count instead', !r.some((x) => /CYCLE/.test(x)) && /FULL/.test(await current()), r.join(' | ') + ' · ' + await current());
await post('/api/admin/features', { preset: 'everything' });
check('Switched back on, the cycle count is back', (await get('/api/admin/sessions')).some((s) => s.mode === 'cycle'));

/* a login without the Cycle counts page never sees cycle counts, as before */
await post('/api/admin/users', { username: 'INV-ONLY', name: 'Inv Only', password: 'count-week-1', mustChange: false, profile: 'inventory' });
const it = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'INV-ONLY', password: 'count-week-1' }) }))).token;
const invList = await j(await fetch(`${BASE}/api/admin/sessions`, { headers: { authorization: 'Bearer ' + it } }));
check('Inventory control, with no Cycle counts page, is listed no cycle count', invList.length === 2 && !invList.some((s) => s.mode === 'cycle'), JSON.stringify(invList.map((s) => [s.name, s.mode])));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
