/* The site's own name, place and logo, on the supervisor pages and the guns.
   All three live in the settings table so they travel with the database and
   every backup, and are one small answer for a gun to cache. The name and the
   place start as the site's own and can be changed under Settings → Logins & site;
   every page, the scanner app, the board and the installed app's manifest
   read them from here, so a change lands everywhere. */
import { db } from '../db.js';

const MAX_CHARS = 600_000;   // ~450 KB of image: plenty for a header mark, small enough to send to every gun
const KIND = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;

const get = (key) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; };
const put = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
const drop = (key) => db.prepare('DELETE FROM settings WHERE key = ?').run(key);

export const DEFAULT_NAME = 'Full Harvest Inventory';
export const DEFAULT_PLACE = 'Front Royal';
const MAX_NAME = 60;

const clean = (v, fallback) => {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return t || fallback;
};

/** What every page and gun asks for: the name, the place, the logo, and whether the guns show it. */
export function branding() {
  const logo = get('siteLogo');
  return {
    name: clean(get('siteName'), DEFAULT_NAME),
    place: get('sitePlace') == null ? DEFAULT_PLACE : clean(get('sitePlace'), ''),
    logo: logo || null, onGuns: logo ? get('siteLogoOnGuns') !== '0' : false, updatedAt: logo ? get('siteLogoAt') : null,
  };
}

/** The name across the top and the place under it. An empty name goes back to
    the default; an empty place is allowed, and means no second line. */
export function saveName({ name, place } = {}) {
  if (name !== undefined) {
    const n = clean(name, '');
    if (n) put('siteName', n); else drop('siteName');
  }
  if (place !== undefined) put('sitePlace', clean(place, ''));
  return branding();
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
