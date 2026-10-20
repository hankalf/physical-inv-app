/*
 * Backups into a Teams channel's Files, through a Workflow the admin builds in
 * Teams ("When a Teams webhook request is received" + SharePoint "Create
 * file"). A stand-in for the Workflow runs here and does what the real one is
 * told to: posts the card, and saves triggerBody().backup.name with
 * base64ToBinary(triggerBody().backup.contentBase64). The suite walks the
 * addresses refused, the address kept as a key, the test file arriving as
 * text, a backup going by itself and arriving whole, the Workflow refusing
 * (who can trigger it, deleted), Count-day readiness, and the card shown to
 * an admin and nobody else.
 */
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (body) => (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + await login({ password: 'changeme' }) };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));

/* ------------------------------------------------------------ the stand-in Workflow */
const saved = new Map();          // the channel's Files: name -> Buffer
const cards = [];                 // what the "post the card" step posted
let answer = 202;
const flow = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!/\/workflows\/abc123\/triggers\/manual\/paths\/invoke\?api-version=1&sig=SECRET-SIG/.test(req.url)) { res.writeHead(404); res.end('{"error":{"code":"WorkflowNotFound"}}'); return; }
    if (answer !== 202) { res.writeHead(answer); res.end('{"error":{"code":"Refused"}}'); return; }
    const b = JSON.parse(body);
    for (const a of b.attachments || []) cards.push(a.content);
    if (b.backup) saved.set(b.backup.name, Buffer.from(b.backup.contentBase64, 'base64'));   // Create file, base64ToBinary
    res.writeHead(202); res.end();
  });
});
await new Promise((r) => flow.listen(0, '127.0.0.1', r));
const ADDRESS = `http://127.0.0.1:${flow.address().port}/workflows/abc123/triggers/manual/paths/invoke?api-version=1&sig=SECRET-SIG`;

let st = await get('/api/admin/teams-backup');
check('Not set up to start with', !st.configured && !st.on && !st.masked);
let r = await post('/api/admin/teams-backup/config', { url: 'http://example.com/flow' });
check('An address that is not https is refused', r.status === 400 && /https/.test((await j(r)).error));
r = await post('/api/admin/teams-backup/config', { url: 'https://contoso.webhook.office.com/webhookb2/abc/IncomingWebhook/def/ghi' });
check('…and an old Incoming Webhook, which can only post a card, is refused with what to use instead', r.status === 400 && /Workflow/.test((await j(r)).error));
r = await post('/api/admin/teams-backup/upload');
check('Nothing is sent before there is an address', r.status === 409);

st = await j(await post('/api/admin/teams-backup/config', { url: ADDRESS, every: 24, on: true }));
check('Saved: on, every day, and the address shown only as its host — never the signature', st.on && st.every === 24 && st.masked === `http://127.0.0.1:${flow.address().port}/…` && !JSON.stringify(await get('/api/admin/teams-backup')).includes('SECRET-SIG'), st.masked);

/* the test file */
st = await j(await post('/api/admin/teams-backup/test'));
const testName = [...saved.keys()].find((n) => /^full-harvest-test-\d{4}-\d\d-\d\d\.txt$/.test(n));
check('Send a test file: a small text file lands in the channel\'s Files, readable as text', testName && /If this file is in the channel's Files, the backups will land here too/.test(saved.get(testName).toString('utf8')), testName);
check('…with a card in the channel saying so', cards.some((c) => /Backup test from the inventory app/.test(JSON.stringify(c))) && st.lastTest && st.lastTest.name === testName);

/* a backup: taken by hand, it goes by itself */
const taken = await j(await post('/api/admin/backups'));
for (let i = 0; i < 40 && !saved.has(`${taken.name}.gz`); i++) await wait(250);
const file = saved.get(`${taken.name}.gz`);
check('A backup taken goes to the channel by itself, gzipped', !!file, [...saved.keys()].join());
check('…and arrives whole: unzipped, it is the SQLite database', file && gunzipSync(file).subarray(0, 15).toString() === 'SQLite format 3');
check('…with a card naming it and its size', cards.some((c) => JSON.stringify(c).includes(`${taken.name}.gz`) && /MB|KB/.test(JSON.stringify(c))));
st = await get('/api/admin/teams-backup');
check('The card\'s status has the last copy, no error', st.lastUpload && st.lastUpload.name === `${taken.name}.gz` && st.lastUpload.rawBytes > st.lastUpload.bytes && !st.lastError, JSON.stringify(st.lastUpload));
r = await post('/api/admin/teams-backup/upload');
check('Back up to Teams now sends the newest again', r.status === 200 && (await j(r)).sent.name === `${taken.name}.gz`);

let ready = await get('/api/admin/readiness');
check('Ready for count day: the backups are copied to Teams', ready.checks.some((c) => c.level === 'ok' && /copied to Teams/.test(c.title)), ready.checks.filter((c) => /cop|server/i.test(c.title)).map((c) => c.title).join(' | '));

/* the Workflow refusing */
answer = 401;
r = await post('/api/admin/teams-backup/upload');
const e401 = (await j(r)).error;
check('A Workflow that turns the server away says to set who can trigger it to Anyone', r.status === 502 && /Who can trigger the flow/.test(e401) && /Anyone/.test(e401), e401);
st = await get('/api/admin/teams-backup');
check('…and the failure is written down for the card', st.lastError && /Anyone/.test(st.lastError.message));
ready = await get('/api/admin/readiness');
check('…and Ready for count day says the last copy failed', ready.checks.some((c) => c.level === 'warn' && /last Teams copy failed/.test(c.title)));
answer = 202;
await post('/api/admin/teams-backup/config', { url: ADDRESS.replace('abc123', 'gone99') });
r = await post('/api/admin/teams-backup/upload');
check('A Workflow deleted or turned off says so', r.status === 502 && /deleted or turned off/.test((await j(r)).error));
await post('/api/admin/teams-backup/config', { url: ADDRESS });

const log = await get('/api/admin/audit?limit=40');
check('Setting it up, the test file and the sends are in the log', ['changed the Teams backup settings', 'sent a test file to the Teams backup channel', 'sent a backup to Teams'].every((a) => log.some((x) => x.action === a)));

/* not an admin */
await post('/api/admin/users', { username: 'TB-SUP', name: 'Tb Sup', password: 'no-backups-1', mustChange: false, profile: 'supervisor' });
const S = { ...hdr, authorization: 'Bearer ' + await login({ username: 'TB-SUP', password: 'no-backups-1' }) };
check('Somebody who is not an admin can neither see nor change it', (await fetch(`${BASE}/api/admin/teams-backup`, { headers: S })).status === 403 && (await post('/api/admin/teams-backup/config', { url: ADDRESS }, S)).status === 403);

/* ------------------------------------------------------------ the card */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#backups`);
await signIn(page);
await page.evaluate(() => window.appApi.showSub('backups')); await page.waitForTimeout(1200);
const text = (await page.textContent('#teamsBackupCard')).replace(/\s+/g, ' ');
check('Settings → Backups & log: the Teams card, above Google Drive, on, with the last copy', await page.isVisible('#teamsBackupCard') && /on/.test(await page.textContent('#tbState')) && /Last copy: inventory-/.test(text)
  && await page.evaluate(() => document.querySelector('#teamsBackupCard').compareDocumentPosition(document.querySelector('#gdriveCard')) & Node.DOCUMENT_POSITION_FOLLOWING), text.slice(0, 160));
check('…the address box empty, its host in the hint, the signature nowhere on the page', (await page.inputValue('#fTbUrl')) === '' && /127\.0\.0\.1/.test(await page.getAttribute('#fTbUrl', 'placeholder')) && !(await page.content()).includes('SECRET-SIG'));
check('…and the set-up steps name the two expressions for Create file', /triggerBody\(\)\?\['backup'\]\?\['name'\]/.test(text) && /base64ToBinary\(triggerBody\(\)\?\['backup'\]\?\['contentBase64'\]\)/.test(text));
const before = saved.size;
await page.click('#btnTbTest'); await page.waitForTimeout(1200);
check('Send a test file, from the card', /Microsoft took it/.test(await page.textContent('#tbMsg')) && saved.size >= before, (await page.textContent('#tbMsg')).trim());
page.once('dialog', (d) => d.accept());
await page.click('#btnTbDisconnect'); await page.waitForTimeout(800);
check('Stop sending, from the card: not set up, and the set-up steps open', /not set up/.test(await page.textContent('#tbState')) && await page.evaluate(() => document.querySelector('#tbHow').open));
await page.fill('#fTbUrl', ADDRESS);
await page.click('#btnTbSave'); await page.waitForTimeout(800);
check('Paste the address and Save, from the card: on again, the box cleared', /on/.test(await page.textContent('#tbState')) && (await page.inputValue('#fTbUrl')) === '');
check('No script errors', errors.length === 0, errors.join(' | '));

const sup = await browser.newPage();
await sup.goto(`${BASE}/settings`);
await signIn(sup, { user: 'TB-SUP', password: 'no-backups-1' });
await sup.waitForTimeout(800);
check('Someone who is not an admin never sees the card', !(await sup.isVisible('#teamsBackupCard')));
await browser.close();
await post('/api/admin/teams-backup/disconnect');
flow.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
