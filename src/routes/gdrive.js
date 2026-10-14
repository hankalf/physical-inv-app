/*
 * Off-site backups, to Google Drive - with nothing for IT to set up.
 *
 * OneDrive needs an app registration in Azure, which in a company is IT's to
 * give. Google has a way round that: an Apps Script. Somebody signed in to the
 * Google account the backups should go to opens script.google.com, pastes the
 * short script Settings shows them (it carries a key only this server knows),
 * and deploys it as a web app that runs as them. That gives a web address;
 * pasted into Settings, every backup is sent to it, the script saves it in a
 * Drive folder and keeps the newest few. No Google Cloud project, no client ID,
 * no password here - only that address and the key.
 *
 * Each copy is the backup gzipped (a SQLite file shrinks five to ten times),
 * sent as one request. Apps Script takes up to about 50 MB in one, so a copy
 * over 30 MB gzipped is refused with a word to use OneDrive for a site that
 * big. Nothing here blocks the server: sends run in the background, a failed
 * one is written down for Settings and tried again half an hour later.
 */
import { readFile, unlink } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { listBackups, backupPath, onBackup, makeBackup } from './admin-ops.js';

const DEFAULT_FOLDER = 'Full Harvest Inventory backups';
const DEFAULT_KEEP = 30;
const RETRY_MS = 30 * 60 * 1000;
const MAX_GZ = Number(process.env.GDRIVE_MAX_BYTES) || 30 * 1024 * 1024;
const HOUR = () => Number(process.env.GDRIVE_HOUR_MS) || 60 * 60 * 1000;
const TICK = () => Number(process.env.GDRIVE_TICK_MS) || 5 * 60 * 1000;
export const EVERY = [24, 12, 6, 2, 1];
/* A deployed Apps Script web app: script.google.com/macros/s/<id>/exec, or the
   /a/<domain>/ form a Google Workspace account gets. Tests point it at a
   stand-in on this machine. */
const ALLOW = () => process.env.GDRIVE_ALLOW_URL_PREFIX || '';
const SCRIPT_URL = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]{10,}\/exec$/;

/* ------------------------------------------------------------ what is kept */
function load() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'gdrive'").get();
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
function save(c) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('gdrive', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(c));
}
const patch = (p) => { const c = { ...load(), ...p }; save(c); return c; };
/* the key the script checks: made once, kept until somebody asks for a new one */
function key() {
  const c = load();
  if (c.key) return c.key;
  const k = randomBytes(24).toString('hex');
  patch({ key: k });
  return k;
}
const folder = (c = load()) => String(c.folder || DEFAULT_FOLDER).trim() || DEFAULT_FOLDER;
const keep = (c = load()) => Math.max(3, Math.min(365, Number(c.keep) || DEFAULT_KEEP));
const every = (c = load()) => (EVERY.includes(Number(c.every)) ? Number(c.every) : 24);

let busy = null;

/** The script to paste into script.google.com, with this server's key in it. */
export function scriptText() {
  return `// Full Harvest Inventory - off-site backups to this Google Drive.
// Paste all of this into a new project at script.google.com (replacing what is
// there), save, then Deploy > New deployment > Web app:
//   Execute as: Me    Who has access: Anyone
// and copy the Web app URL into Settings > Backups & log > Google Drive.
// The key below is this server's own: a request without it is turned away.
const KEY = '${key()}';

function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.key !== KEY) return out({ ok: false, error: 'wrong key' });
    const folder = folderNamed(b.folder || '${DEFAULT_FOLDER}');
    if (b.action === 'ping') {
      return out({ ok: true, account: Session.getEffectiveUser().getEmail(), folder: folder.getName(), folderUrl: folder.getUrl() });
    }
    if (b.action === 'upload') {
      const blob = Utilities.newBlob(Utilities.base64Decode(b.data), 'application/gzip', b.name);
      list(folder.getFilesByName(b.name)).forEach(function (f) { f.setTrashed(true); });
      const file = folder.createFile(blob);
      return out({ ok: true, id: file.getId(), bytes: file.getSize(), removed: prune(folder, Number(b.keep) || 30) });
    }
    return out({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err) });
  }
}

function folderNamed(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
function list(it) { const a = []; while (it.hasNext()) a.push(it.next()); return a; }
function prune(folder, keep) {
  const ours = list(folder.getFiles())
    .filter(function (f) { return /^inventory-.*\\.db(\\.gz)?$/.test(f.getName()); })
    .sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  ours.slice(keep).forEach(function (f) { f.setTrashed(true); });
  return Math.max(0, ours.length - keep);
}
function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

/** What Settings shows: never the key on its own, only inside the script. */
export function gdriveStatus() {
  const c = load();
  return {
    url: c.url || '',
    configured: !!c.url,
    connected: !!(c.url && c.account),
    account: c.account || '', folderUrl: c.folderUrl || '', connectedAt: c.connectedAt || '', connectedBy: c.connectedBy || '',
    folder: folder(c), keep: keep(c), every: every(c), everyChoices: EVERY,
    nextAt: c.account && every(c) < 24
      ? new Date(Math.max(Date.now(), (c.lastUpload ? Date.parse(c.lastUpload.at) : Date.now()) + every(c) * HOUR())).toISOString()
      : null,
    uploading: !!busy,
    lastUpload: c.lastUpload || null,
    lastError: c.lastError || null,
    script: scriptText(),
  };
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** The web app address, the folder, how many to keep and how often. */
export function setGdriveConfig({ url, folder: f, keep: k, every: ev } = {}) {
  const c = load();
  const next = { ...c };
  if (url !== undefined) {
    const v = String(url || '').trim();
    if (v && !(SCRIPT_URL.test(v) || (ALLOW() && v.startsWith(ALLOW())))) {
      throw bad(/script\.google\.com\/.*\/dev$/.test(v)
        ? 'that is the test address (it ends in /dev) - use the Web app URL from Deploy > Manage deployments, which ends in /exec'
        : 'that is not an Apps Script web app address - it looks like https://script.google.com/macros/s/…/exec, from Deploy > New deployment');
    }
    // a different address is a different script: it has to be checked again
    if (v !== String(c.url || '')) { delete next.account; delete next.folderUrl; delete next.connectedAt; next.lastError = null; }
    next.url = v;
  }
  if (f !== undefined) {
    const v = String(f || '').trim();
    if (v.length > 100) throw bad('a folder name of 100 characters at most');
    next.folder = v || DEFAULT_FOLDER;
  }
  if (k !== undefined) next.keep = Math.max(3, Math.min(365, Number(k) || DEFAULT_KEEP));
  if (ev !== undefined) {
    if (!EVERY.includes(Number(ev))) throw bad(`how often must be one of ${EVERY.join(', ')} hours`);
    next.every = Number(ev);
  }
  save(next);
  return gdriveStatus();
}

/* One request to the script. Apps Script answers a POST with a redirect to
   where the answer waits; fetch follows it. What comes back is said in words. */
async function call(body, { timeout = 120000 } = {}) {
  const c = load();
  if (!c.url) throw bad('put in the web app address first', 409);
  let r;
  try {
    r = await fetch(c.url, {
      method: 'POST', redirect: 'follow', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, key: key(), folder: folder(c) }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw bad(err.name === 'TimeoutError' ? 'Google took too long to answer - try again in a minute' : `could not reach Google: ${err.message}`, 502);
  }
  const text = await r.text();
  let b = null;
  try { b = JSON.parse(text); } catch { /* not JSON: a Google page instead of the script's answer */ }
  if (!b) {
    if (r.status === 404) throw bad('Google does not know that address - the deployment may have been deleted; deploy the script again and paste the new address', 502);
    if (/accounts\.google\.com|ServiceLogin|Sign in/i.test(text)) throw bad('Google asked for a sign-in, so the web app is not open to the server - in Deploy > Manage deployments, set "Who has access" to "Anyone"', 502);
    if (/authoriz|permission/i.test(text)) throw bad('the script has not been given permission yet - in the Apps Script editor, run Deploy again and press Authorize access', 502);
    throw bad(`Google answered with a page, not the script (${r.status}) - check the address ends in /exec`, 502);
  }
  if (!b.ok) {
    if (b.error === 'wrong key') throw bad('the script has a different key from this server - copy the script from Settings again, paste it over the old one, and deploy a new version', 502);
    throw bad(`the script said: ${b.error || 'no'}`, 502);
  }
  return b;
}

/** Check the address: the script answers with the account and the folder. */
export async function checkConnection(by = '') {
  try {
    const b = await call({ action: 'ping' }, { timeout: 30000 });
    patch({ account: b.account || 'Google Drive', folderUrl: b.folderUrl || '', connectedAt: new Date().toISOString(), connectedBy: by, lastError: null });
    catchUp().catch(() => {});                 // the newest backup goes straight away
    return gdriveStatus();
  } catch (err) {
    const c = load();
    delete c.account; delete c.folderUrl; c.lastError = { at: new Date().toISOString(), message: err.message };
    save(c);
    throw err;
  }
}

/** Stop sending. A new key means the old script stops working too. */
export function disconnectGdrive({ newKey = false } = {}) {
  const c = load();
  delete c.url; delete c.account; delete c.folderUrl; delete c.connectedAt; delete c.connectedBy;
  c.lastError = null;
  if (newKey) delete c.key;
  save(c);
  return gdriveStatus();
}

/** Send one backup now (the newest if none is named). */
export async function uploadToGdrive(name) {
  if (busy) return busy;
  const c = load();
  if (!c.url || !c.account) throw bad('Google Drive is not connected - paste the web app address and press Check the connection', 409);
  const target = name || (listBackups()[0] || {}).name;
  if (!target) throw bad('there is no backup to send yet - take one first', 409);
  busy = (async () => {
    const t0 = Date.now();
    try {
      const full = backupPath(target);
      if (!full) throw new Error(`not a backup: ${target}`);
      const raw = await readFile(full);
      if (!raw.length) throw new Error('the backup file is empty');
      const gz = gzipSync(raw, { level: 9 });
      if (gz.length > MAX_GZ) throw new Error(`the backup is ${Math.round(gz.length / 1048576)} MB even squeezed, more than Google takes in one go - use OneDrive for a database this size`);
      const b = await call({ action: 'upload', name: `${target}.gz`, data: gz.toString('base64'), keep: keep(c) });
      const lastUpload = { name: `${target}.gz`, bytes: gz.length, rawBytes: raw.length, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10, removed: Number(b.removed) || 0 };
      patch({ lastUpload, lastError: null });
      return lastUpload;
    } catch (err) {
      patch({ lastError: { at: new Date().toISOString(), message: err.message, name: target } });
      throw Object.assign(err, { status: err.status || 502 });
    } finally { busy = null; }
  })();
  return busy;
}

/** If the newest backup is newer than the last copy in Drive, send it. */
export async function catchUp() {
  const c = load();
  if (!c.url || !c.account || busy) return null;
  // never the hourly copy another off-site sender took for itself and is about to delete
  const newest = listBackups().find((b) => !/-offsite(-\d+)?\.db$/.test(b.name));
  if (!newest) return null;
  if (c.lastUpload && (c.lastUpload.name === `${newest.name}.gz` || Date.parse(c.lastUpload.at) >= Date.parse(newest.at))) return null;
  return uploadToGdrive(newest.name);
}

/* More often than daily: a fresh copy taken for Drive alone, sent, and not kept here. */
async function onTheHour() {
  const c = load();
  const ev = every(c);
  if (!c.url || !c.account || busy || ev >= 24) return null;
  const last = c.lastUpload ? Date.parse(c.lastUpload.at) : 0;
  if (Date.now() - last < ev * HOUR() - TICK() / 2) return null;
  if (c.lastError && Date.now() - Date.parse(c.lastError.at) < Math.min(RETRY_MS, (ev * HOUR()) / 2)) return null;
  const b = makeBackup('offsite');
  try { return await uploadToGdrive(b.name); }
  finally { const full = backupPath(b.name); if (full) await unlink(full).catch(() => {}); }
}

/** Every backup the app takes goes to Drive too; a failure is tried again later. */
export function startGdrive() {
  onBackup((b) => { if (b.reason !== 'offsite') catchUp().catch(() => {}); });
  setInterval(() => { catchUp().catch(() => {}); }, RETRY_MS).unref();
  setInterval(() => { onTheHour().catch(() => {}); }, TICK()).unref();
  setTimeout(() => { catchUp().catch(() => {}); }, 60000).unref();
}
