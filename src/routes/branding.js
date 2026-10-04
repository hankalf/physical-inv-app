/* The site's own logo, on the supervisor pages and - if wanted - the guns.
   One image, kept in the settings table as a data URL so it travels with the
   database and every backup, and is one small answer for a gun to cache. */
import { db } from '../db.js';

const MAX_CHARS = 600_000;   // ~450 KB of image: plenty for a header mark, small enough to send to every gun
const KIND = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;

const get = (key) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; };
const put = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
const drop = (key) => db.prepare('DELETE FROM settings WHERE key = ?').run(key);

/** What every page and gun asks for: the logo, and whether the guns show it. */
export function branding() {
  const logo = get('siteLogo');
  return { logo: logo || null, onGuns: logo ? get('siteLogoOnGuns') !== '0' : false, updatedAt: logo ? get('siteLogoAt') : null };
}

export function saveLogo({ dataUrl, onGuns } = {}) {
  if (dataUrl !== undefined) {
    const s = String(dataUrl || '');
    if (!s) return clearLogo();
    if (!KIND.test(s)) throw Object.assign(new Error('that is not an image the browsers show - use PNG, JPEG, WebP, GIF or SVG'), { status: 400 });
    if (s.length > MAX_CHARS) throw Object.assign(new Error('the logo is too big - keep it under about 400 KB (a header mark needs no more than 400 pixels across)'), { status: 413 });
    put('siteLogo', s);
    put('siteLogoAt', new Date().toISOString());
  }
  if (onGuns !== undefined) put('siteLogoOnGuns', onGuns ? '1' : '0');
  return branding();
}

export function clearLogo() {
  drop('siteLogo'); drop('siteLogoAt'); drop('siteLogoOnGuns');
  return branding();
}
