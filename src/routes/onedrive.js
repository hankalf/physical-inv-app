/*
 * Off-site backups, to OneDrive.
 *
 * The daily backups sit on the same Railway volume as the database they copy,
 * so a lost volume takes them with it. This sends every backup the app takes
 * to a folder in a OneDrive as well, and keeps the last few there.
 *
 * Signing in uses Microsoft's device-code sign-in: Settings shows a short code,
 * somebody opens microsoft.com/devicelogin on any computer or phone, types it
 * and signs in with the Microsoft account the backups should go to. The app
 * never sees that password; it keeps a refresh token in the settings table and
 * uses it to send each backup. Microsoft needs an app registration for this - a
 * free, five-minute job in the Azure portal, done once (see the SOP); its
 * Application (client) ID goes in Settings or the ONEDRIVE_CLIENT_ID variable.
 *
 * Nothing here blocks the server: uploads run in the background, a failed one
 * is written down for Settings to show and tried again half an hour later.
 */
import { open, stat, unlink } from 'node:fs/promises';
import { db } from '../db.js';
import { listBackups, backupPath, onBackup, makeBackup } from './admin-ops.js';

const LOGIN = () => (process.env.ONEDRIVE_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, '');
const GRAPH = () => (process.env.ONEDRIVE_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const SCOPE = 'Files.ReadWrite offline_access User.Read';
// 5 MiB a piece: Graph wants multiples of 320 KiB (the tests use small pieces to see several go)
const CHUNK = Number(process.env.ONEDRIVE_CHUNK_BYTES) || 320 * 1024 * 16;
const DEFAULT_FOLDER = 'Full Harvest Inventory backups';
const DEFAULT_KEEP = 30;
const RETRY_MS = 30 * 60 * 1000;
/* How often a copy goes: with each daily backup, or more often than that. An
   hour is an hour unless a test says otherwise. */
const HOUR = () => Number(process.env.ONEDRIVE_HOUR_MS) || 60 * 60 * 1000;
const TICK = () => Number(process.env.ONEDRIVE_TICK_MS) || 5 * 60 * 1000;
export const EVERY = [24, 12, 6, 2, 1];

/* ------------------------------------------------------------ what is kept */
function load() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'onedrive'").get();
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
function save(cfg) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('onedrive', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cfg));
}
const patch = (p) => { const c = { ...load(), ...p }; save(c); return c; };

const clientId = (c = load()) => String(process.env.ONEDRIVE_CLIENT_ID || c.clientId || '').trim();
const tenant = (c = load()) => String(process.env.ONEDRIVE_TENANT || c.tenant || 'common').trim() || 'common';
const folder = (c = load()) => String(c.folder || DEFAULT_FOLDER).trim().replace(/^\/+|\/+$/g, '') || DEFAULT_FOLDER;
const keep = (c = load()) => Math.max(3, Math.min(365, Number(c.keep) || DEFAULT_KEEP));
const every = (c = load()) => (EVERY.includes(Number(c.every)) ? Number(c.every) : 24);

let pending = null;      // a sign-in waiting on someone to type the code
let access = null;       // { token, exp }
let busy = null;         // the upload in flight, so two never run at once

/** What Settings shows. Never the tokens. */
export function onedriveStatus() {
  const c = load();
  return {
    clientId: clientId(c), clientIdFromEnv: !!process.env.ONEDRIVE_CLIENT_ID, tenant: tenant(c),
    folder: folder(c), keep: keep(c), every: every(c), everyChoices: EVERY,
    nextAt: c.refreshToken && every(c) < 24
      ? new Date(Math.max(Date.now(), (c.lastUpload ? Date.parse(c.lastUpload.at) : Date.now()) + every(c) * HOUR())).toISOString()
      : null,
    configured: !!clientId(c),
    connected: !!c.refreshToken,
    account: c.account || '', connectedAt: c.connectedAt || '', connectedBy: c.connectedBy || '',
    pending: pending && pending.expiresAt > Date.now()
      ? { userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: new Date(pending.expiresAt).toISOString() }
      : null,
    signInError: c.signInError || '',
    uploading: !!busy,
    lastUpload: c.lastUpload || null,
    lastError: c.lastError || null,
  };
}

/** The Application (client) ID, the folder and how many to keep. */
export function setOnedriveConfig({ clientId: id, tenant: t, folder: f, keep: k, every: ev } = {}) {
  const c = load();
  const next = { ...c };
  if (id !== undefined) {
    const v = String(id || '').trim();
    if (v && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      throw Object.assign(new Error('that is not an Application (client) ID - it looks like 1a2b3c4d-1234-5678-9abc-1234567890ab, on the app registration\'s Overview page'), { status: 400 });
    }
    // a different app registration cannot use the old one's sign-in
    if (v !== String(c.clientId || '')) { delete next.refreshToken; delete next.account; access = null; }
    next.clientId = v;
  }
  if (t !== undefined) next.tenant = String(t || 'common').trim() || 'common';
  if (f !== undefined) {
    const v = String(f || '').trim().replace(/^\/+|\/+$/g, '');
    if (/[\\:*?"<>|]/.test(v)) throw Object.assign(new Error('a OneDrive folder name cannot have \\ : * ? " < > | in it'), { status: 400 });
    next.folder = v || DEFAULT_FOLDER;
  }
  if (k !== undefined) next.keep = Math.max(3, Math.min(365, Number(k) || DEFAULT_KEEP));
  if (ev !== undefined) {
    if (!EVERY.includes(Number(ev))) throw Object.assign(new Error(`how often must be one of ${EVERY.join(', ')} hours`), { status: 400 });
    next.every = Number(ev);
  }
  save(next);
  return onedriveStatus();
}

/* ------------------------------------------------------------ signing in */
const form = (o) => new URLSearchParams(o).toString();
const formHdr = { 'content-type': 'application/x-www-form-urlencoded' };

/* Microsoft's errors, in words a warehouse office can act on. */
function explain(code, desc) {
  const d = String(desc || '');
  if (/AADSTS7000218|client_assertion|client_secret/.test(d)) return 'the app registration does not allow this kind of sign-in - in the Azure portal, open it, Authentication, and turn on "Allow public client flows"';
  if (/AADSTS700016|not found in the directory/.test(d)) return 'Microsoft does not know that Application (client) ID - check it against the app registration\'s Overview page';
  if (/AADSTS50059|AADSTS90002|tenant/i.test(d) && code !== 'authorization_pending') return 'Microsoft could not find that tenant - leave it as "common" unless your IT says otherwise';
  if (/AADSTS65001|consent/i.test(d)) return 'the account was not allowed to give this app access to its files - an administrator of that Microsoft 365 tenant may need to approve it';
  if (code === 'expired_token') return 'the code ran out before anyone signed in - start again';
  if (code === 'authorization_declined') return 'the sign-in was turned down on the Microsoft page';
  if (code === 'invalid_grant') return 'the OneDrive connection has expired or was taken away - connect again';
  return d.split('\n')[0].replace(/^AADSTS\d+:\s*/, '') || code || 'Microsoft said no';
}

/** Ask Microsoft for a code; the server waits for the sign-in by itself. */
export async function startSignIn(by = '') {
  const c = load();
  if (!clientId(c)) throw Object.assign(new Error('put in the Application (client) ID first'), { status: 400 });
  const r = await fetch(`${LOGIN()}/${encodeURIComponent(tenant(c))}/oauth2/v2.0/devicecode`, {
    method: 'POST', headers: formHdr, body: form({ client_id: clientId(c), scope: SCOPE }),
  }).catch((err) => { throw Object.assign(new Error(`could not reach Microsoft: ${err.message}`), { status: 502 }); });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.device_code) throw Object.assign(new Error(explain(b.error, b.error_description)), { status: 400 });
  patch({ signInError: '' });
  pending = {
    deviceCode: b.device_code, userCode: b.user_code, verificationUri: b.verification_uri || 'https://microsoft.com/devicelogin',
    expiresAt: Date.now() + (Number(b.expires_in) || 900) * 1000, interval: Math.max(1, Number(b.interval) || 5), by,
  };
  waitForSignIn(pending);
  return onedriveStatus();
}

function waitForSignIn(p) {
  const tick = async () => {
    if (pending !== p) return;                          // started again, or cancelled
    if (Date.now() > p.expiresAt) { pending = null; patch({ signInError: explain('expired_token') }); return; }
    const c = load();
    let b = {};
    try {
      const r = await fetch(`${LOGIN()}/${encodeURIComponent(tenant(c))}/oauth2/v2.0/token`, {
        method: 'POST', headers: formHdr,
        body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId(c), device_code: p.deviceCode }),
      });
      b = await r.json().catch(() => ({}));
      if (r.ok && b.refresh_token) {
        pending = null;
        access = { token: b.access_token, exp: Date.now() + (Number(b.expires_in) || 3600) * 1000 };
        // whose OneDrive it is, looked up before it shows as connected, so the two arrive together
        const who = await whoIs().catch(() => '');
        patch({ refreshToken: b.refresh_token, account: who, connectedAt: new Date().toISOString(), connectedBy: p.by, signInError: '', lastError: null });
        catchUp().catch(() => {});                       // the newest backup goes straight away
        return;
      }
    } catch { /* the network blinked: ask again on the next tick */ }
    if (b.error === 'slow_down') p.interval += 5;
    else if (b.error && b.error !== 'authorization_pending') { pending = null; patch({ signInError: explain(b.error, b.error_description) }); return; }
    setTimeout(tick, p.interval * 1000).unref();
  };
  setTimeout(tick, p.interval * 1000).unref();
}

export function cancelSignIn() { pending = null; return onedriveStatus(); }

export function disconnect() {
  pending = null; access = null;
  const c = load();
  delete c.refreshToken; delete c.account; delete c.connectedAt; delete c.connectedBy;
  c.lastError = null;
  save(c);
  return onedriveStatus();
}

async function token() {
  if (access && access.exp - Date.now() > 120000) return access.token;
  const c = load();
  if (!c.refreshToken) {
    // mid sign-in: the token just handed over is good until it runs out
    if (access && access.exp > Date.now()) return access.token;
    throw new Error('OneDrive is not connected');
  }
  const r = await fetch(`${LOGIN()}/${encodeURIComponent(tenant(c))}/oauth2/v2.0/token`, {
    method: 'POST', headers: formHdr,
    body: form({ grant_type: 'refresh_token', client_id: clientId(c), refresh_token: c.refreshToken, scope: SCOPE }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) {
    // a refresh token Microsoft has withdrawn will never work again: say so plainly
    if (b.error === 'invalid_grant') { const n = load(); delete n.refreshToken; save(n); access = null; }
    throw new Error(explain(b.error, b.error_description));
  }
  access = { token: b.access_token, exp: Date.now() + (Number(b.expires_in) || 3600) * 1000 };
  if (b.refresh_token) patch({ refreshToken: b.refresh_token });   // Microsoft hands out a fresh one now and then
  return access.token;
}

async function graph(path, opts = {}) {
  const t = await token();
  const r = await fetch(GRAPH() + path, { ...opts, headers: { authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(`OneDrive answered ${r.status}${b.error && b.error.message ? `: ${b.error.message}` : ''}`);
  }
  return r.status === 204 ? null : r.json();
}

async function whoIs() {
  const d = await graph('/me/drive');
  const o = (d && d.owner && (d.owner.user || d.owner.group)) || {};
  return [o.displayName, o.email].filter(Boolean).join(' · ') || (d && d.driveType === 'personal' ? 'personal OneDrive' : 'OneDrive');
}

/* ------------------------------------------------------------ sending a backup */
const itemPath = (name) => `/me/drive/root:/${folder().split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(name)}:`;

async function send(name) {
  const full = backupPath(name);
  if (!full) throw new Error(`not a backup: ${name}`);
  const size = (await stat(full)).size;
  // an upload session takes a file of any size, a piece at a time
  const s = await graph(`${itemPath(name)}/createUploadSession`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  const fh = await open(full, 'r');
  try {
    let at = 0;
    let done = null;
    while (at < size) {
      const len = Math.min(CHUNK, size - at);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, at);
      // the upload address carries its own permission: no sign-in header on these
      const r = await fetch(s.uploadUrl, { method: 'PUT', headers: { 'content-length': String(len), 'content-range': `bytes ${at}-${at + len - 1}/${size}` }, body: buf });
      if (!r.ok) throw new Error(`OneDrive refused part of the file (${r.status})`);
      if (r.status === 200 || r.status === 201) done = await r.json().catch(() => ({}));
      at += len;
    }
    if (size === 0) throw new Error('the backup file is empty');
    return { name, bytes: size, id: done && done.id };
  } finally { await fh.close(); }
}

/** Keep the newest few in the OneDrive folder; the rest go. */
async function prune() {
  const list = await graph(`${itemPath('').replace(/\/:$/, ':')}/children?$select=id,name,createdDateTime&$top=999`);
  const ours = (list.value || []).filter((i) => /^inventory-.*\.db$/.test(i.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
  let removed = 0;
  for (const it of ours.slice(keep())) { await graph(`/me/drive/items/${encodeURIComponent(it.id)}`, { method: 'DELETE' }); removed++; }
  return removed;
}

/** Send one backup now (the newest if none is named). */
export async function uploadNow(name) {
  if (busy) return busy;
  const c = load();
  if (!c.refreshToken) throw Object.assign(new Error('OneDrive is not connected'), { status: 409 });
  const target = name || (listBackups()[0] || {}).name;
  if (!target) throw Object.assign(new Error('there is no backup to send yet - take one first'), { status: 409 });
  busy = (async () => {
    const t0 = Date.now();
    try {
      const out = await send(target);
      let removed = 0;
      try { removed = await prune(); } catch { /* the copy is there; tidying can wait for the next one */ }
      const lastUpload = { name: out.name, bytes: out.bytes, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10, removed };
      patch({ lastUpload, lastError: null });
      return lastUpload;
    } catch (err) {
      patch({ lastError: { at: new Date().toISOString(), message: err.message, name: target } });
      throw Object.assign(err, { status: err.status || 502 });
    } finally { busy = null; }
  })();
  return busy;
}

/** If the newest backup is newer than the last copy in OneDrive, send it. */
export async function catchUp() {
  const c = load();
  if (!c.refreshToken || busy) return null;
  const newest = listBackups()[0];
  if (!newest) return null;
  if (c.lastUpload && (c.lastUpload.name === newest.name || Date.parse(c.lastUpload.at) >= Date.parse(newest.at))) return null;
  return uploadNow(newest.name);
}

/* More often than once a day: a fresh copy of the database taken for OneDrive
   alone, sent, and not kept here - the server keeps its dailies, OneDrive gets
   the hourly ones, and neither crowds the other out. */
async function onTheHour() {
  const c = load();
  const ev = every(c);
  if (!c.refreshToken || busy || ev >= 24) return null;
  const last = c.lastUpload ? Date.parse(c.lastUpload.at) : 0;
  if (Date.now() - last < ev * HOUR() - TICK() / 2) return null;
  // a send that just failed is not retried every few minutes: give OneDrive a moment
  if (c.lastError && Date.now() - Date.parse(c.lastError.at) < Math.min(RETRY_MS, (ev * HOUR()) / 2)) return null;
  const b = makeBackup('offsite');
  try { return await uploadNow(b.name); }
  finally { const full = backupPath(b.name); if (full) await unlink(full).catch(() => {}); }
}

/** Every backup the app takes goes off-site too; a failure is tried again later. */
export function startOnedrive() {
  onBackup((b) => { if (b.reason !== 'offsite') catchUp().catch(() => {}); });
  const t = setInterval(() => { catchUp().catch(() => {}); }, RETRY_MS);
  t.unref();
  setInterval(() => { onTheHour().catch(() => {}); }, TICK()).unref();
  setTimeout(() => { catchUp().catch(() => {}); }, 60000).unref();
  return t;
}
