/*
 * The inventory report a count is checked against: any admin adds to it, only
 * the site admin - the login the site started with - overrides it. And both
 * lists come back out as files, so what was loaded can be looked at.
 */
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }))).token;
const SITE = { ...hdr, authorization: 'Bearer ' + (await login({ password: 'changeme' })) };   // the site admin: a password with no username
const post = (p, b = {}, h = SITE) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
const get = async (p, h = SITE) => j(await fetch(BASE + p, { headers: h }));
const upload = (sid, kind, text, q = '', h = SITE) => fetch(`${BASE}/api/admin/sessions/${sid}/master?kind=${kind}${q}`, { method: 'POST', headers: { ...h, 'content-type': 'text/csv' }, body: text });

/* another admin, with everything but the site admin's own things */
await post('/api/admin/users', { username: 'MO-ADMIN', name: 'Mo Admin', password: 'override-1', mustChange: false, profile: 'admin' });
const OTHER = { ...hdr, authorization: 'Bearer ' + (await login({ username: 'MO-ADMIN', password: 'override-1' })) };
check('The site admin knows it is the site admin; another admin is told it is not', (await get('/api/admin/me')).siteAdmin === true && (await get('/api/admin/me', OTHER)).siteAdmin === false && (await get('/api/admin/me', OTHER)).role === 'admin');

const sess = await j(await post('/api/admin/sessions', { name: 'Override test' }));
const S = sess.id;
await upload(S, 'bins', 'Bin Location,Zone,Aisle\nM01A001,Dry,M01\nM01A002,Dry,M01\nM01A003,Dry,M01\n');
let r = await upload(S, 'pallets', 'System,Pallet ID,SKU,Description,Variant,UOM,Entry No,Qty,Location,Lot\nNAV,MO-1,S1,Chicken,DIST,CS,1001,40,M01A001,L1\nNAV,MO-2,S2,Peas,,CS,1002,30,M01A002,\n', '&source=NAV', OTHER);
check('Another admin loads the report', r.status === 200 && (await j(r)).totals.pallets === 2);
r = await upload(S, 'pallets', 'Pallet ID,SKU,Description,Qty,Location\nMO-2,S2,Peas,35,M01A002\nMO-3,S3,Corn,20,M01A003\n', '', OTHER);
check('…and adds to it: a pallet already on it is updated, a new one added, nothing removed', r.status === 200 && (await j(r)).totals.pallets === 3);
r = await upload(S, 'pallets', 'Pallet ID,SKU,Description,Qty,Location\nMO-9,S9,Beans,10,M01A001\n', '&replace=1', OTHER);
check('…but cannot override it: Replace is refused with why', r.status === 403 && /only the site admin can override the inventory report already loaded/.test((await j(r)).error || ''), String(r.status));
check('…and the report is as it was', (await (await fetch(`${BASE}/api/admin/sessions/${S}/export/master.csv`, { headers: OTHER })).text()).trim().split(/\r?\n/).length === 4);
r = await upload(S, 'pallets', 'Pallet ID,SKU,Description,Qty,Location\nMO-9,S9,Beans,10,M01A001\n', '&replace=1');
check('The site admin overrides it', r.status === 200 && (await j(r)).totals.pallets === 1);
check('…and the log says so, with what was thrown away', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'overrode the inventory report' && /replacing what was there \(3 pallets\)/.test(x.detail || '')));
r = await upload(S, 'bins', 'Bin Location,Zone,Aisle\nM02A001,Dry,M02\n', '&replace=1', OTHER);
check('The bin list is not the report: another admin may still replace it', r.status === 200);
r = await upload(S, 'pallets', 'Pallet ID,SKU,Description,Qty,Location\nMO-1,S1,Chicken,40,M02A001\n', '&replace=1', OTHER);
const empty = await j(await post('/api/admin/sessions', { name: 'Override test 2' }));
r = await upload(empty.id, 'pallets', 'Pallet ID,SKU,Description,Qty,Location\nMO-1,S1,Chicken,40,M01A001\n', '&replace=1', OTHER);
check('Replace on a count with no report loaded yet is nothing to guard: it goes through', r.status === 200);

/* ---------------- the lists back out ---------------- */
await upload(S, 'pallets', 'System,Pallet ID,SKU,Description,Variant,UOM,Entry No,Qty,Location,Lot,Expiry\nNAV,MO-1,S1,Chicken,DIST,CS,1001,40,M02A001,L1,2027-01-31\nTEST,MO-2,S2,Peas,,CS,1002,30,M02A001,,\n', '&replace=1');
let csv = await (await fetch(`${BASE}/api/admin/sessions/${S}/export/master.csv`, { headers: OTHER })).text();
let lines = csv.trim().split(/\r?\n/);
check('The inventory report downloads as it is loaded, every column it came with', lines[0] === 'System,Pallet ID,SKU,Description,Variant,UOM,Entry No,Qty,Location,Lot,Expiry,ABC' && lines.length === 3 && /^NAV,MO-1,S1,Chicken,DIST,CS,1001,40,M02A001,L1,2027-01-31,$/.test(lines[1]) && /^TEST,MO-2,S2,Peas,,CS,1002,30,M02A001,,,$/.test(lines[2]), lines.join(' | '));
csv = await (await fetch(`${BASE}/api/admin/sessions/${S}/export/bins.csv`, { headers: OTHER })).text();
lines = csv.trim().split(/\r?\n/);
check('…and so does the bin list', lines[0] === 'Bin Location,Zone,Aisle,Level,Description,Last Counted' && lines.length === 2 && /^M02A001,DRY,M02,A,/.test(lines[1]), lines.join(' | '));
check('Both are in the log', (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'downloaded the inventory report') && (await get('/api/admin/audit?limit=10')).some((x) => x.action === 'downloaded the bin list'));

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const other = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
other.on('pageerror', (e) => errors.push(e.message));
await other.goto(`${BASE}/settings#lists`);
await signIn(other, { user: 'MO-ADMIN', password: 'override-1' });
await other.waitForSelector('#reportCard');
await other.waitForTimeout(800);
check('Settings → Lists: another admin sees Upload and Download on the inventory report, but no Override box', await other.isVisible('#btnUpload-pallets') && await other.isVisible('#btnDownload-pallets') && !(await other.isVisible('#overrideBox')), clean(await other.textContent('#reportCard .inline')));
check('…and the hint says whose it is', /site admin/.test(clean(await other.textContent('#overrideHint'))));
await other.close();
const site = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
site.on('pageerror', (e) => errors.push(e.message));
await site.goto(`${BASE}/settings#lists`);
await signIn(site);
await site.waitForSelector('#reportCard');
await site.waitForTimeout(800);
check('The site admin sees the Override box', await site.isVisible('#overrideBox') && /Override/.test(clean(await site.textContent('#overrideBox'))));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
