/*
 * Backups to Google Drive, through an Apps Script the admin deploys themselves.
 *
 * A stand-in for Google runs here, and it runs the very script Settings hands
 * out - with stand-ins for DriveApp, Utilities, ContentService and Session -
 * so what is tested is what gets pasted into script.google.com. It answers the
 * way Apps Script does: the POST is redirected to where the answer waits. The
 * suite walks an address that is not one, a script with the wrong key, a web
 * app not open to "Anyone", the check that names the account, the newest
 * backup going by itself, gzipped and arriving whole, the newest few kept, a
 * failed send written down, a new key stopping the old script, and the card
 * shown to an admin and nobody else.
 */
import http from 'node:http';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MOCK = Number(process.env.GDRIVE_MOCK_PORT || 3988);
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = (p, b = {}, h = A) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
const get = async (p, h = A) => j(await fetch(BASE + p, { headers: h }));

/* ------------------------------------------------------------ a Drive, as Apps Script sees it */
const drive = { folders: new Map(), seq: 0, failNext: false, created: 0 };
const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
function makeFolder(name) {
  const f = { name, files: [] };
  return {
    getName: () => name, getUrl: () => `https://drive.google.com/drive/folders/F-${name.replace(/\W+/g, '')}`,
    getFilesByName: (n) => iter(f.files.filter((x) => !x.trashed && x.name === n).map(wrapFile)),
    getFiles: () => iter(f.files.filter((x) => !x.trashed).map(wrapFile)),
    createFile: (blob) => { if (drive.failNext) { drive.failNext = false; throw new Error('Drive storage quota exceeded'); } const x = { id: 'id' + ++drive.seq, name: blob.name, bytes: blob.bytes, trashed: false }; f.files.push(x); drive.created++; return wrapFile(x); },
    _f: f,
  };
}
const wrapFile = (x) => ({ getName: () => x.name, getId: () => x.id, getSize: () => x.bytes.length, setTrashed: (t) => { x.trashed = !!t; } });
const DriveApp = {
  getFoldersByName: (n) => iter(drive.folders.has(n) ? [drive.folders.get(n)] : []),
  createFolder: (n) => { const f = makeFolder(n); drive.folders.set(n, f); return f; },
};
const Utilities = {
  base64Decode: (s) => [...Buffer.from(s, 'base64')],
  newBlob: (bytes, type, name) => ({ bytes: Buffer.from(bytes), type, name }),
};
const ContentService = { MimeType: { JSON: 'application/json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) };
const Session = { getEffectiveUser: () => ({ getEmail: () => 'backups.fullharvest@gmail.com' }) };

/* the script the admin pasted in: whatever Settings handed out, last */
let deployed = null;
const deploy = (text) => {
  const ctx = vm.createContext({ DriveApp, Utilities, ContentService, Session, JSON, String, Number, Math });
  vm.runInContext(text, ctx);
  deployed = ctx;
};

const answers = new Map();
let seen = 0;
let openToAnyone = true;
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK}`);
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  if (req.method === 'POST' && /^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)) {
    seen++;
    if (!openToAnyone) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>Sign in - Google Accounts</title><a href="https://accounts.google.com/ServiceLogin">Sign in</a></html>'); return; }
    if (!deployed) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>Sorry, unable to open the file at this time.</html>'); return; }
    const out = deployed.doPost({ postData: { contents: body, type: 'application/json' } });
    const id = String(++drive.seq);
    answers.set(id, out.text);
    // Apps Script hands a POST's answer back through a redirect
    res.writeHead(302, { location: `http://127.0.0.1:${MOCK}/macros/echo?user_content_key=${id}` }); res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/macros/echo') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(answers.get(url.searchParams.get('user_content_key')) || '{}');
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
const ADDRESS = `http://127.0.0.1:${MOCK}/macros/s/AKfycbTESTSCRIPT123/exec`;

/* ------------------------------------------------------------ not set up */
let st = await get('/api/admin/gdrive');
check('Not set up to start with, and the script to paste comes with it', !st.configured && !st.connected && /function doPost\(e\)/.test(st.script) && /const KEY = '[0-9a-f]{48}'/.test(st.script));
check('…the script names the steps: Web app, Execute as Me, Anyone', /Web app/.test(st.script) && /Execute as: Me/.test(st.script) && /Who has access: Anyone/.test(st.script));
let r = await post('/api/admin/gdrive/config', { url: 'https://drive.google.com/drive/folders/abc' });
check('An address that is not an Apps Script web app is refused, saying what one looks like', r.status === 400 && /script\.google\.com\/macros\/s\/…\/exec/.test((await j(r)).error));
r = await post('/api/admin/gdrive/config', { url: 'https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxx/dev' });
check('…and the /dev test address is caught, pointing at the /exec one', r.status === 400 && /ends in \/dev/.test((await j(r)).error));
r = await post('/api/admin/gdrive/check');
check('Checking with no address says to put one in', r.status === 409);

/* ------------------------------------------------------------ the web app is deployed, but wrongly */
r = await post('/api/admin/gdrive/config', { url: ADDRESS, folder: 'FH test backups', keep: 3, every: 24 });
st = await j(r);
check('The web app address is taken, with the folder and how many to keep', r.status === 200 && st.configured && !st.connected && st.folder === 'FH test backups' && st.keep === 3);
r = await post('/api/admin/gdrive/check');
check('Before the script is deployed Google does not know the address, and the app says so', r.status === 502 && /deploy the script again/.test((await j(r)).error));
deploy(st.script.replace(/const KEY = '[0-9a-f]+'/, "const KEY = 'somebody-elses-key'"));
r = await post('/api/admin/gdrive/check');
check('A script with another key is turned away, with what to do', r.status === 502 && /different key/.test((await j(r)).error));
deploy(st.script);
openToAnyone = false;
r = await post('/api/admin/gdrive/check');
check('A web app not open to "Anyone" comes back as a Google sign-in page, and the app says which setting', r.status === 502 && /Who has access/.test((await j(r)).error));
openToAnyone = true;

/* ------------------------------------------------------------ connected */
r = await post('/api/admin/gdrive/check');
st = await j(r);
check('Checked: the account and the folder come back from the script itself', r.status === 200 && st.connected && st.account === 'backups.fullharvest@gmail.com' && /drive\.google\.com\/drive\/folders\//.test(st.folderUrl), JSON.stringify([st.account, st.folderUrl]));
check('…and the folder is made in that Drive', drive.folders.has('FH test backups'));
for (let t = 0; t < 40 && !(await get('/api/admin/gdrive')).lastUpload; t++) await wait(250);
st = await get('/api/admin/gdrive');
check('The newest backup goes by itself once connected', !!st.lastUpload && /^inventory-.*\.db\.gz$/.test(st.lastUpload.name), JSON.stringify(st.lastUpload));
const folderFiles = () => drive.folders.get('FH test backups')._f.files.filter((x) => !x.trashed);
const first = folderFiles()[0];
const unzipped = first ? gunzipSync(first.bytes) : Buffer.alloc(0);
check('…gzipped, and whole: unzipped it is a SQLite database the size the server had', unzipped.subarray(0, 15).toString() === 'SQLite format 3' && unzipped.length === st.lastUpload.rawBytes && first.bytes.length < unzipped.length, `${first && first.bytes.length} gz / ${unzipped.length} raw`);

/* more backups: the newest three are kept */
for (let i = 0; i < 4; i++) {
  await post('/api/admin/backups');
  await wait(1100);
  r = await post('/api/admin/gdrive/upload');
  if (r.status !== 200) console.log('upload', r.status, await r.text());
}
check('Back up to Google Drive now sends it, and the newest three are all that are kept', folderFiles().length === 3, folderFiles().map((x) => x.name).join(', '));
check('…the oldest went, not the newest', folderFiles().every((x) => x.name >= first.name) && !folderFiles().some((x) => x.name === first.name));

/* a failed send */
await post('/api/admin/backups'); await wait(1500);         // its own copy goes by itself first
drive.failNext = true;
r = await post('/api/admin/gdrive/upload');
st = await get('/api/admin/gdrive');
check('A send Google refuses is written down, in Google\'s words', r.status === 502 && st.lastError && /quota/.test(st.lastError.message), st.lastError && st.lastError.message);
r = await post('/api/admin/gdrive/upload');
st = await get('/api/admin/gdrive');
check('…and the next one clears it', r.status === 200 && !st.lastError);

/* a new key stops the old script */
const oldScript = st.script;
r = await post('/api/admin/gdrive/disconnect', { newKey: true });
st = await j(r);
check('Make a new key: disconnected, and the script carries a different key', !st.configured && st.script !== oldScript);
await post('/api/admin/gdrive/config', { url: ADDRESS });
r = await post('/api/admin/gdrive/check');
check('…so the old script, still deployed, is turned away until the new one is pasted', r.status === 502 && /different key/.test((await j(r)).error));
deploy(st.script);
r = await post('/api/admin/gdrive/check');
check('…and with the new one deployed it connects again', r.status === 200 && (await j(r)).connected);

/* only an admin */
await post('/api/admin/users', { username: 'INV-CTRL', name: 'Inventory Control', password: 'count-week-1', mustChange: false, profile: 'inventory' });
const it = (await j(await post('/api/admin/login', { username: 'INV-CTRL', password: 'count-week-1' }, hdr))).token;
const I = { ...hdr, authorization: 'Bearer ' + it };
check('Nobody but an admin can see it - the status carries the key', (await fetch(`${BASE}/api/admin/gdrive`, { headers: I })).status === 403);
check('…or change it', (await post('/api/admin/gdrive/config', { url: '' }, I)).status === 403);
const log = await get('/api/admin/audit?limit=60');
check('Connecting and sending are in the log', log.some((a) => a.action === 'connected Google Drive for backups') && log.some((a) => a.action === 'sent a backup to Google Drive'));

/* ------------------------------------------------------------ the card */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/settings#backups`);
await signIn(page);
await page.evaluate(() => window.appApi.showSub('backups')); await page.waitForTimeout(1200);
const card = (await page.textContent('#gdriveCard')).replace(/\s+/g, ' ');
check('Settings → Backups & log has the Google Drive card above OneDrive, connected, with the account and the last copy', await page.isVisible('#gdriveCard') && /connected/.test(await page.textContent('#gdState')) && /backups\.fullharvest@gmail\.com/.test(card) && /Last copy: inventory-/.test(card)
  && await page.evaluate(() => document.querySelector('#gdriveCard').compareDocumentPosition(document.querySelector('#onedriveCard')) & Node.DOCUMENT_POSITION_FOLLOWING), card.slice(0, 160));
await page.click('#btnGdDisconnect', { trial: true });
page.once('dialog', (d) => d.accept());
await page.click('#btnGdDisconnect'); await page.waitForTimeout(800);
check('Disconnect from the card: not set up, and the set-up steps open', /not set up/.test(await page.textContent('#gdState')) && await page.evaluate(() => document.querySelector('#gdHow').open));
await page.click('#btnGdCopy'); await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
check('Copy the script puts the script, key and all, on the clipboard', /function doPost\(e\)/.test(clip) && /const KEY = '[0-9a-f]{48}'/.test(clip), clip.slice(0, 60));
await page.fill('#fGdUrl', ADDRESS);
await page.click('#btnGdSave'); await page.waitForTimeout(1500);
check('Save and check the connection, from the card, connects', /Connected to backups\.fullharvest@gmail\.com/.test(await page.textContent('#gdMsg')) && /connected/.test(await page.textContent('#gdState')), (await page.textContent('#gdMsg')).trim());
check('No script errors', errors.length === 0, errors.join(' | '));

const inv = await browser.newPage();
await inv.goto(`${BASE}/settings`);
await signIn(inv, { user: 'INV-CTRL', password: 'count-week-1' });
await inv.waitForTimeout(800);
check('Someone who is not an admin never gets as far as the card', !(await inv.isVisible('#gdriveCard')));
await browser.close();
mock.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
