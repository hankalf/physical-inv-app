/*
 * Off-site backups, into a Teams channel's Files - with nothing for IT to set up.
 *
 * A Teams webhook cannot carry an attachment: a channel post is a card and
 * nothing else. What a channel's Files tab is, though, is a SharePoint folder,
 * and a Teams Workflow (Power Automate, built inside Teams with the standard
 * connectors any Microsoft 365 user has) can save a file there. So the admin
 * builds one Workflow: "When a Teams webhook request is received", the usual
 * "post the card", and one more step, SharePoint "Create file", that writes
 * the backup it is sent into the channel's folder. No app registration, no
 * client ID, nothing in Azure - the Workflow runs as the person who made it.
 *
 * What is sent is one JSON POST: the backup gzipped and in base64, with its
 * name, and the same message-with-a-card envelope the SOS alerts use, so the
 * Workflow's own "post the card" step says in the channel that a backup came.
 *
 * A Workflow answers 202 Accepted and runs on its own afterwards, so "sent"
 * here means Microsoft took it; whether the file landed is for the channel's
 * Files tab to show, and the card in the channel says it was meant to. The
 * address carries its own signature, so it is a key: kept here, never shown
 * back in full. Sends run in the background; a failed one is written down for
 * Settings and tried again half an hour later.
 */
import { readFile, unlink } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { db } from '../db.js';
import { listBackups, backupPath, onBackup, makeBackup } from './admin-ops.js';
import { noticeCard } from '../util/teams.js';
import { branding } from './branding.js';

const RETRY_MS = 30 * 60 * 1000;
const MAX_GZ = () => Number(process.env.TEAMS_BACKUP_MAX_BYTES) || 25 * 1024 * 1024;
const HOUR = () => Number(process.env.TEAMS_BACKUP_HOUR_MS) || 60 * 60 * 1000;
const TICK = () => Number(process.env.TEAMS_BACKUP_TICK_MS) || 5 * 60 * 1000;
export const EVERY = [24, 12, 6, 2, 1];
const KEY = 'teamsBackup';

/* ------------------------------------------------------------ what is kept */
function load() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
function save(c) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(c));
}
const patch = (p) => { const c = { ...load(), ...p }; save(c); return c; };
const every = (c = load()) => (EVERY.includes(Number(c.every)) ? Number(c.every) : 24);
const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
const siteName = () => { const b = branding(); return [b.name, b.place].filter(Boolean).join(' · '); };

let busy = null;

/** What Settings shows: the host of the address, never the signature on it. */
export function teamsBackupStatus() {
  const c = load();
  return {
    configured: !!c.url,
    on: !!(c.url && c.on !== false),
    masked: c.url ? `${originOf(c.url)}/…` : '',
    every: every(c), everyChoices: EVERY,
    maxMB: Math.round(MAX_GZ() / 1048576),
    nextAt: c.url && c.on !== false && every(c) < 24
      ? new Date(Math.max(Date.now(), (c.lastUpload ? Date.parse(c.lastUpload.at) : Date.now()) + every(c) * HOUR())).toISOString()
      : null,
    savedAt: c.savedAt || '', savedBy: c.savedBy || '',
    lastTest: c.lastTest || null,
    uploading: !!busy,
    lastUpload: c.lastUpload || null,
    lastError: c.lastError || null,
  };
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** The Workflow's address, and how often a copy goes. An empty address leaves the saved one alone. */
export function setTeamsBackupConfig({ url, every: ev, on } = {}, by = '') {
  const c = load();
  const next = { ...c };
  if (url !== undefined && String(url).trim() !== '') {
    const v = String(url).trim();
    const loopback = /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\//i.test(v);
    if (!/^https:\/\//i.test(v) && !loopback) throw bad('the Workflow address has to start with https:// — copy it from the Workflow\'s first step, "When a Teams webhook request is received"');
    if (/webhook\.office\.com\/webhookb2\//i.test(v)) {
      throw bad('that is an old Incoming Webhook address, which can only post a card — a backup needs a Workflow with a "Create file" step; the card below says how to make one');
    }
    if (v !== c.url) { next.lastError = null; delete next.lastTest; }
    next.url = v;
  }
  if (ev !== undefined) {
    if (!EVERY.includes(Number(ev))) throw bad(`how often must be one of ${EVERY.join(', ')} hours`);
    next.every = Number(ev);
  }
  if (on !== undefined) next.on = !!on;
  next.savedAt = new Date().toISOString(); next.savedBy = by;
  save(next);
  return teamsBackupStatus();
}

/** Stop sending, and forget the address. What is already in the channel stays. */
export function disconnectTeamsBackup() {
  const c = load();
  save({ every: c.every });
  return teamsBackupStatus();
}

/* One POST to the Workflow. What comes back is said in words a site can act on. */
async function post(body, { timeout = 120000 } = {}) {
  const c = load();
  if (!c.url) throw bad('put in the Workflow address first', 409);
  let r;
  try {
    r = await fetch(c.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw bad(err.name === 'TimeoutError' ? 'Microsoft took too long to answer — try again in a minute' : `could not reach the Workflow: ${err.message}`, 502);
  }
  const text = (await r.text().catch(() => '')).slice(0, 300);
  if (r.ok) return { status: r.status };
  if (r.status === 401 || r.status === 403) throw bad('the Workflow turned the server away — in its first step, set "Who can trigger the flow" to Anyone, save, and copy the address again', 502);
  if (r.status === 404) throw bad('Microsoft does not know that address — the Workflow may have been deleted or turned off; turn it on, or copy the address again', 502);
  if (r.status === 413) throw bad('the backup is too big for the Workflow to take in one go (Microsoft said 413) — download this backup from the table above instead, or use Google Drive', 502);
  if (r.status === 429) throw bad('Microsoft says too many requests — the copy is tried again in half an hour', 502);
  if (r.status === 400 && /trigger|schema|body/i.test(text)) throw bad(`the Workflow did not accept the request: ${text}`, 502);
  throw bad(`the Workflow said ${r.status}${text ? ': ' + text : ''}`, 502);
}

const sizeWords = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** What the Workflow is sent: the card for the channel, and the file for the "Create file" step. */
function envelope({ name, data, bytes, title, subtitle, facts }) {
  const msg = noticeCard({ title, subtitle, tone: 'Good', facts, site: siteName() });
  return { ...msg, backup: { name, contentBase64: data, bytes, contentType: name.endsWith('.gz') ? 'application/gzip' : 'text/plain', site: siteName(), at: new Date().toISOString() } };
}

/** A small text file, so the admin can see one land in the channel's Files before trusting a real backup to it. */
export async function sendTestFile(by = '') {
  const name = `full-harvest-test-${new Date().toISOString().slice(0, 10)}.txt`;
  const text = `A test file from ${siteName()}, sent by ${by || 'an admin'} at ${new Date().toISOString()}.\r\nIf this file is in the channel's Files, the backups will land here too. It can be deleted.\r\n`;
  const raw = Buffer.from(text, 'utf8');
  try {
    await post(envelope({
      name, data: raw.toString('base64'), bytes: raw.length,
      title: 'Backup test from the inventory app', subtitle: `${name} should now be in this channel's Files`,
      facts: [['Sent by', by || 'an admin'], ['File', name]],
    }), { timeout: 30000 });
    const lastTest = { at: new Date().toISOString(), by, name };
    patch({ lastTest, lastError: null });
    return teamsBackupStatus();
  } catch (err) {
    patch({ lastError: { at: new Date().toISOString(), message: err.message, name } });
    throw err;
  }
}

/** Send one backup now (the newest if none is named). */
export async function uploadToTeams(name) {
  if (busy) return busy;
  const c = load();
  if (!c.url) throw bad('the Teams backup is not set up — paste the Workflow address and press Save', 409);
  const target = name || (listBackups()[0] || {}).name;
  if (!target) throw bad('there is no backup to send yet — take one first', 409);
  busy = (async () => {
    const t0 = Date.now();
    try {
      const full = backupPath(target);
      if (!full) throw new Error(`not a backup: ${target}`);
      const raw = await readFile(full);
      if (!raw.length) throw new Error('the backup file is empty');
      const gz = gzipSync(raw, { level: 9 });
      if (gz.length > MAX_GZ()) throw new Error(`the backup is ${sizeWords(gz.length)} even squeezed, more than the ${Math.round(MAX_GZ() / 1048576)} MB sent to a Workflow in one go — use Google Drive, or Download, for a database this size`);
      const fileName = `${target}.gz`;
      await post(envelope({
        name: fileName, data: gz.toString('base64'), bytes: gz.length,
        title: 'Inventory backup', subtitle: `${fileName} · ${sizeWords(gz.length)} — saved to this channel's Files`,
        facts: [['Backup', fileName], ['Size', `${sizeWords(gz.length)} (${sizeWords(raw.length)} unzipped)`], ['Taken', new Date().toLocaleString('en-US')]],
      }));
      const lastUpload = { name: fileName, bytes: gz.length, rawBytes: raw.length, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10 };
      patch({ lastUpload, lastError: null });
      return lastUpload;
    } catch (err) {
      patch({ lastError: { at: new Date().toISOString(), message: err.message, name: target } });
      throw Object.assign(err, { status: err.status || 502 });
    } finally { busy = null; }
  })();
  return busy;
}

/** If the newest backup is newer than the last copy sent to Teams, send it. */
export async function catchUp() {
  const c = load();
  if (!c.url || c.on === false || busy) return null;
  // never the hourly copy another off-site sender took for itself and is about to delete
  const newest = listBackups().find((b) => !/-offsite(-\d+)?\.db$/.test(b.name));
  if (!newest) return null;
  if (c.lastUpload && (c.lastUpload.name === `${newest.name}.gz` || Date.parse(c.lastUpload.at) >= Date.parse(newest.at))) return null;
  if (c.lastError && c.lastError.name === newest.name && Date.now() - Date.parse(c.lastError.at) < RETRY_MS - 60000) return null;
  return uploadToTeams(newest.name);
}

/* More often than daily: a fresh copy taken for Teams alone, sent, and not kept here. */
async function onTheHour() {
  const c = load();
  const ev = every(c);
  if (!c.url || c.on === false || busy || ev >= 24) return null;
  const last = c.lastUpload ? Date.parse(c.lastUpload.at) : 0;
  if (Date.now() - last < ev * HOUR() - TICK() / 2) return null;
  if (c.lastError && Date.now() - Date.parse(c.lastError.at) < Math.min(RETRY_MS, (ev * HOUR()) / 2)) return null;
  const b = makeBackup('offsite');
  try { return await uploadToTeams(b.name); }
  finally { const full = backupPath(b.name); if (full) await unlink(full).catch(() => {}); }
}

/** Every backup the app takes goes to the channel too; a failure is tried again later. */
export function startTeamsBackup() {
  onBackup((b) => { if (b.reason !== 'offsite') catchUp().catch(() => {}); });
  setInterval(() => { catchUp().catch(() => {}); }, RETRY_MS).unref();
  setInterval(() => { onTheHour().catch(() => {}); }, TICK()).unref();
  setTimeout(() => { catchUp().catch(() => {}); }, 60000).unref();
}
