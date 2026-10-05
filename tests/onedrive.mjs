/*
 * Backups to OneDrive.
 *
 * A stand-in for Microsoft runs here - the sign-in endpoints and the slice of
 * Graph the app uses - and the app is started pointing at it (run-all sets
 * that up). It walks the whole of it: an ID that is not one, an app Microsoft
 * does not know, the device-code sign-in, the first copy going by itself, a
 * copy sent from the button in pieces and arriving whole, the newest few kept,
 * a failed send written down and recovered from, a withdrawn sign-in, and the
 * Settings card showing all of it to an admin and none of it to anyone else.
 */
import http from 'node:http';
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MOCK = Number(process.env.ONEDRIVE_MOCK_PORT || 3989);
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the stand-in for Microsoft */
const GOOD = '11111111-2222-3333-4444-555555555555';
const UNKNOWN = '99999999-8888-7777-6666-555555555555';
const ms = {
  approved: false, revoked: false, failPut: false, shortTokens: false,
  files: new Map(),          // name -> { id, bytes, created }
  sessions: new Map(),       // upload id -> { name, size, got: [] }
  putAuth: false, chunks: 0, refreshes: 0, seq: 0,
};
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK}`);
  const p = decodeURIComponent(url.pathname);
  const body = await readBody(req);
  const f = Object.fromEntries(new URLSearchParams(body.toString()));
  if (/\/oauth2\/v2\.0\/devicecode$/.test(p)) {
    if (f.client_id === UNKNOWN) return json(res, 400, { error: 'unauthorized_client', error_description: "AADSTS700016: Application with identifier '" + UNKNOWN + "' was not found in the directory 'Microsoft Accounts'." });
    if (!/offline_access/.test(f.scope) || !/Files\.ReadWrite/.test(f.scope)) return json(res, 400, { error: 'invalid_scope' });
    return json(res, 200, { device_code: 'dc-1', user_code: 'BKUP-4271', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 });
  }
  if (/\/oauth2\/v2\.0\/token$/.test(p)) {
    if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (!ms.approved) return json(res, 400, { error: 'authorization_pending', error_description: 'AADSTS70016: pending' });
      return json(res, 200, { access_token: 'at-' + (++ms.seq), refresh_token: 'rt-1', expires_in: ms.shortTokens ? 1 : 3600, token_type: 'Bearer' });
    }
    if (f.grant_type === 'refresh_token') {
      ms.refreshes++;
      if (ms.revoked) return json(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired or is invalid.' });
      return json(res, 200, { access_token: 'at-' + (++ms.seq), refresh_token: 'rt-' + (ms.seq + 1), expires_in: ms.shortTokens ? 1 : 3600 });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  // Graph: the sign-in header on everything but the upload pieces
  if (p.startsWith('/v1.0/')) {
    if (!/^Bearer at-\d+$/.test(req.headers.authorization || '')) return json(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'no token' } });
    const g = p.slice('/v1.0'.length);
    if (g === '/me/drive' && req.method === 'GET') return json(res, 200, { driveType: 'personal', owner: { user: { displayName: 'Dana Whitfield', email: 'dana@example.com' } } });
    let m;
    if ((m = g.match(/^\/me\/drive\/root:\/(.+)\/([^/]+):\/createUploadSession$/)) && req.method === 'POST') {
      const id = 'u' + (++ms.seq);
      ms.sessions.set(id, { folder: m[1], name: m[2], got: [] });
      return json(res, 200, { uploadUrl: `http://127.0.0.1:${MOCK}/upload/${id}`, expirationDateTime: new Date(Date.now() + 3600e3).toISOString() });
    }
    if ((m = g.match(/^\/me\/drive\/root:\/(.+):\/children$/)) && req.method === 'GET') {
      return json(res, 200, { value: [...ms.files.values()].filter((x) => x.folder === m[1]).map((x) => ({ id: x.id, name: x.name, createdDateTime: x.created })) });
    }
    if ((m = g.match(/^\/me\/drive\/items\/(.+)$/)) && req.method === 'DELETE') {
      for (const [k, v] of ms.files) if (v.id === m[1]) ms.files.delete(k);
      res.writeHead(204); return res.end();
    }
    return json(res, 404, { error: { message: 'not here: ' + g } });
  }
  let m;
  if ((m = p.match(/^\/upload\/(.+)$/)) && req.method === 'PUT') {
    if (req.headers.authorization) ms.putAuth = true;
    const s = ms.sessions.get(m[1]);
    if (!s) return json(res, 404, {});
    if (ms.failPut) return json(res, 500, { error: { message: 'boom' } });
    const [, a, b, total] = String(req.headers['content-range']).match(/bytes (\d+)-(\d+)\/(\d+)/) || [];
    if (Number(a) !== s.got.reduce((n, x) => n + x.length, 0) || Number(b) - Number(a) + 1 !== body.length) return json(res, 416, {});
    s.got.push(body);
    ms.chunks++;
    const have = s.got.reduce((n, x) => n + x.length, 0);
    if (have < Number(total)) return json(res, 202, { nextExpectedRanges: [`${have}-`] });
    const file = Buffer.concat(s.got);
    const item = { id: 'item-' + (++ms.seq), name: s.name, folder: s.folder, bytes: file.length, head: file.subarray(0, 16).toString('latin1'), created: new Date().toISOString() };
    ms.files.set(`${s.folder}/${s.name}`, item);
    return json(res, 201, { id: item.id, name: item.name, size: item.bytes });
  }
  json(res, 404, {});
});
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));

/* ------------------------------------------------------------ the app */
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'DANA-WHITFIELD', password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const get = async (p, h = A) => fetch(BASE + p, { headers: h });
const post = async (p, body = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) });
const status = async () => j(await get('/api/admin/onedrive'));
const until = async (fn, ms2 = 8000) => { const t = Date.now(); while (Date.now() - t < ms2) { const v = await fn(); if (v) return v; await wait(250); } return null; };

let st = await status();
check('Out of the box it is not set up, and says so', !st.configured && !st.connected && st.folder === 'Full Harvest Inventory backups' && st.keep === 30, JSON.stringify(st).slice(0, 160));

await post('/api/admin/users', { username: 'SUP-ONE', name: 'Sup One', password: 'dock-side-77', mustChange: false, profile: 'supervisor' });
const supTok = (await j(await post('/api/admin/login', { username: 'SUP-ONE', password: 'dock-side-77' }, hdr))).token;
const S = { ...hdr, authorization: 'Bearer ' + supTok };
check('A supervisor can neither see where the backups go nor change it', (await get('/api/admin/onedrive', S)).status === 403 && (await post('/api/admin/onedrive/connect', {}, S)).status === 403);

let r = await post('/api/admin/onedrive/connect');
check('Connecting before there is an Application ID says what is missing', r.status === 400 && /Application \(client\) ID/.test((await j(r)).error));
r = await post('/api/admin/onedrive/config', { clientId: 'my-app' });
check('Something that is not an Application ID is refused, with what one looks like', r.status === 400 && /looks like/.test((await j(r)).error));
r = await post('/api/admin/onedrive/config', { folder: 'Backups: <today>' });
check('A folder name OneDrive would refuse is refused here first', r.status === 400);

await post('/api/admin/onedrive/config', { clientId: UNKNOWN });
r = await post('/api/admin/onedrive/connect');
let b = await j(r);
check('An Application ID Microsoft does not know is explained in plain words', r.status === 400 && /does not know that Application/.test(b.error), b.error);

st = await j(await post('/api/admin/onedrive/config', { clientId: GOOD, folder: '/FH test/backups/', keep: 3 }));
check('A good ID, a folder (slashes tidied) and how many to keep are saved', st.configured && st.clientId === GOOD && st.folder === 'FH test/backups' && st.keep === 3, JSON.stringify([st.folder, st.keep]));

st = await j(await post('/api/admin/onedrive/connect'));
check('Connect shows the code to type and where to type it', st.pending && st.pending.userCode === 'BKUP-4271' && /microsoft\.com\/devicelogin/.test(st.pending.verificationUri) && !st.connected);
await wait(1500);
check('…and keeps waiting while nobody has signed in', (await status()).pending && !(await status()).connected);

// the office manager signs in on their own phone
ms.approved = true;
st = await until(async () => { const s = await status(); return s.connected ? s : null; });
check('Once someone signs in, the app is connected by itself, naming the account', st && st.account === 'Dana Whitfield · dana@example.com' && !st.pending, st && st.account);
check('The status never carries the sign-in tokens', !JSON.stringify(st).includes('rt-') && !JSON.stringify(st).includes('at-'));

// the backup taken at start-up goes straight away
st = await until(async () => { const s = await status(); return s.lastUpload ? s : null; });
const backups = (await j(await get('/api/admin/backups'))).backups;
check('The newest backup goes to OneDrive as soon as it is connected', st && st.lastUpload.name === backups[0].name && ms.files.has(`FH test/backups/${backups[0].name}`), st && st.lastUpload && st.lastUpload.name);
const first = ms.files.get(`FH test/backups/${backups[0].name}`);
check('…whole: the same size as the file here, and a real SQLite database', first && first.bytes === backups[0].bytes && first.head.startsWith('SQLite format 3'), first && `${first.bytes} vs ${backups[0].bytes}`);
check('…sent in pieces, the pieces carrying no sign-in of their own', ms.chunks > 1 && !ms.putAuth, `${ms.chunks} pieces`);

// the button: a fresh backup, sent now
r = await post('/api/admin/onedrive/upload');
b = await j(r);
check('"Back up to OneDrive now" takes a backup and sends it', r.status === 200 && b.sent && ms.files.has(`FH test/backups/${b.sent.name}`) && /-manual/.test(b.sent.name), b.sent && b.sent.name);

// an ordinary backup (the daily one, or the button under Backups & log) goes too
const made = await j(await post('/api/admin/backups'));
const went = await until(async () => ms.files.has(`FH test/backups/${made.name}`));
check('An ordinary backup goes to OneDrive by itself', !!went, made.name);

for (let i = 0; i < 3; i++) await post('/api/admin/onedrive/upload');
const inFolder = [...ms.files.values()].filter((x) => x.folder === 'FH test/backups');
check('Only the newest three are kept in the folder', inFolder.length === 3, inFolder.map((x) => x.name).join(' | '));

// OneDrive having a bad day
ms.failPut = true;
r = await post('/api/admin/onedrive/upload');
st = await status();
check('A failed send is an error now, and written down for Settings', r.status === 502 && st.lastError && /refused part/.test(st.lastError.message), st.lastError && st.lastError.message);
ms.failPut = false;
r = await post('/api/admin/onedrive/upload');
st = await status();
check('…and the next one that works clears it', r.status === 200 && !st.lastError);

// the sign-in withdrawn on the Microsoft side
ms.shortTokens = true;
await post('/api/admin/onedrive/disconnect');
ms.approved = false;
await post('/api/admin/onedrive/connect');
ms.approved = true;
await until(async () => (await status()).connected);
ms.revoked = true;
r = await post('/api/admin/onedrive/upload');
st = await status();
check('A sign-in Microsoft has withdrawn says to connect again, and stops pretending to be connected', r.status >= 400 && !st.connected && st.lastError && /connect again/.test(st.lastError.message), st.lastError && st.lastError.message);
ms.revoked = false; ms.shortTokens = false;

const log = await j(await get('/api/admin/audit?limit=100'));
check('Connecting and sending are in the activity log', log.some((a) => a.action === 'started connecting OneDrive for backups') && log.some((a) => a.action === 'sent a backup to OneDrive'));

/* ------------------------------------------------------------ how often */
r = await post('/api/admin/onedrive/config', { every: 3 });
check('"How often" takes only the choices offered', r.status === 400);
ms.approved = false;
await post('/api/admin/onedrive/connect');
ms.approved = true;
await until(async () => (await status()).connected);
await until(async () => { const s2 = await status(); return s2.lastUpload && !s2.uploading; });
st = await j(await post('/api/admin/onedrive/config', { every: 1 }));
check('Every hour is saved, with when the next copy goes', st.every === 1 && !!st.nextAt, JSON.stringify([st.every, st.nextAt]));
const before = new Set(ms.files.keys());
const extra = await until(async () => [...ms.files.keys()].find((k) => !before.has(k) && /-offsite\.db$/.test(k)), 12000);
check('A fresh copy goes on the hour by itself', !!extra, extra || [...ms.files.keys()].join(' | '));
const localNames = (await j(await get('/api/admin/backups'))).backups.map((b) => b.name);
check('…and is not kept on the server, so the dailies are not crowded out', !localNames.some((n) => /-offsite/.test(n)), localNames.join(' | '));
await post('/api/admin/onedrive/config', { every: 24 });
const settled = new Set(ms.files.keys());
await wait(5000);
check('Back to once a day, no copies go on their own', [...ms.files.keys()].every((k) => settled.has(k)));
ms.approved = false;
await post('/api/admin/onedrive/disconnect');

/* ------------------------------------------------------------ the Settings card */
ms.approved = false;
await post('/api/admin/onedrive/connect');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings`);
await signIn(page, { user: 'DANA-WHITFIELD', password: 'changeme' });
await page.waitForTimeout(800);
check('Settings shows the code to type while a sign-in waits', await page.isVisible('#odCode') && (await page.textContent('#odUserCode')) === 'BKUP-4271' && /waiting/.test(await page.textContent('#odState')));
ms.approved = true;
await page.waitForFunction(() => /connected/.test(document.getElementById('odState').textContent) && !/waiting/.test(document.getElementById('odState').textContent), null, { timeout: 10000 }).catch(() => {});
const said = (await page.textContent('#odStatus')).replace(/\s+/g, ' ');
check('…and notices by itself when it is done: connected, to whom, and where', /Dana Whitfield/.test(said) && /FH test\/backups/.test(said) && await page.isHidden('#odCode'), said.slice(0, 200));
await page.click('#btnOdUpload');
await page.waitForFunction(() => /Sent/.test(document.getElementById('odMsg').textContent), null, { timeout: 10000 }).catch(() => {});
check('The button sends one and says so', /Sent — inventory-/.test(await page.textContent('#odMsg')), (await page.textContent('#odMsg')).slice(0, 120));
page.once('dialog', (d) => d.accept());
await page.click('#btnOdDisconnect');
await page.waitForTimeout(600);
check('Disconnect asks first, then backups stay here only', /not connected/.test(await page.textContent('#odState')) && await page.isVisible('#btnOdConnect'));

const sup = await browser.newPage();
await sup.goto(`${BASE}/settings`);
await sup.fill('#fUser', 'SUP-ONE'); await sup.fill('#fPassword', 'dock-side-77'); await sup.click('#btnLogin');
await sup.waitForTimeout(1200);
check('A supervisor never sees the card', !(await sup.isVisible('#onedriveCard')));
check('No page errors', errors.length === 0, errors.join(' | '));
await browser.close();
mock.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
