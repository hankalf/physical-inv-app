/*
 * What is switched on.
 *
 * The app does more than any one week needs: a wall-to-wall count, cycle
 * counts, the warehouse jobs, the map, adjustments, reports, a practice page.
 * People with a few days to learn the count do not want the rest in front of
 * them, so an admin can switch parts off for the whole site - the office
 * pages, the dashboard tabs, the search box and the scanners' sign-on screen
 * all follow - and back on when the time comes.
 *
 * Off is hidden, not forbidden: a login's role still says what it may use,
 * and the data behind a hidden page is untouched. The count itself - the
 * Full Counts page, the dashboard's progress, team plan and second counts,
 * Teams & crew, Settings and the guide - is always on.
 */
import { db } from '../db.js';

export const FEATURES = [
  ['cycle', 'Cycle counts', 'The Cycle counts page, and the cycle count job on the scanners'],
  ['front', 'Front bins', 'The Front bins page with its move desk, and Front2Back on the scanners'],
  ['missing', 'Not in Location', 'The Not in Location page with its find desk, and the job on the scanners'],
  ['map', 'Map', 'The Map tab on the dashboard'],
  ['alerts', 'Alerts', 'The Alerts tab on the dashboard - SOS calls and scanners that stopped. Leave it on while scanners are counting'],
  ['adjust', 'Adjustments', 'The Adjustments tab on the dashboard'],
  ['reports', 'Reports', 'The Reports tab on the dashboard'],
  ['testing', 'Testing Suite', 'The practice page, with its own scanner and count'],
];
export const FEATURE_KEYS = FEATURES.map(([k]) => k);

/* The two presets. "Count day" is the full count and its second counts and
   nothing to wander into; the alerts stay, because an SOS from the floor
   needs an answer, and so does the practice page, because that is where a
   new team learns the count. */
export const PRESETS = {
  everything: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])),
  'count-only': Object.fromEntries(FEATURE_KEYS.map((k) => [k, k === 'alerts' || k === 'testing'])),
};

export function features() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'features'").get();
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  const out = {};
  for (const k of FEATURE_KEYS) out[k] = saved[k] !== false;
  return out;
}
export const featureOn = (k) => !FEATURE_KEYS.includes(k) || features()[k];

/** What an admin sent: a map of key -> on/off, or a preset by name. */
export function saveFeatures(body = {}) {
  const now = features();
  let next = { ...now };
  if (body.preset !== undefined) {
    const p = PRESETS[String(body.preset)];
    if (!p) throw Object.assign(new Error(`not a preset: ${body.preset} - "everything" or "count-only"`), { status: 400 });
    next = { ...p };
  }
  const given = body.features && typeof body.features === 'object' ? body.features : body;
  for (const k of FEATURE_KEYS) if (given[k] !== undefined) next[k] = !!given[k];
  const bad = Object.keys(given).filter((k) => !FEATURE_KEYS.includes(k) && k !== 'preset' && k !== 'features');
  if (bad.length) throw Object.assign(new Error(`not a part of the app that can be switched off: ${bad[0]}`), { status: 400 });
  db.prepare("INSERT INTO settings (key, value) VALUES ('features', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  return next;
}

/** The names of what is off, for the log and the card: "Cycle counts, Map". */
export const offNames = (f = features()) => FEATURES.filter(([k]) => !f[k]).map(([, l]) => l);
