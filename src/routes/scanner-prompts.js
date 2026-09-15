import { db } from '../db.js';

/*
 * What the gun offers a counter as a one-tap reason.
 *
 * Two lists, both editable without a deploy, because the reasons a site needs
 * are the site's business: "Blocked by a trailer" means something at one
 * warehouse and nothing at another.
 *
 *   comments  - the chips on the comments step
 *   overrides - why a pallet ID that is not on the list is being accepted
 */
const DEFAULTS = {
  comments: ['Damaged', 'Partial pallet', 'Mixed pallet', 'Label unreadable', 'Needs recount', 'Blocked / could not reach'],
  overrides: ['Label unreadable', 'New receipt, not on the report', 'Relabelled', 'Hand-written ID', 'Supervisor said to count it'],
};
/** How long the comments step waits before moving itself on. 0 turns it off. */
const DEFAULT_TIMEOUT = 5;

const clean = (list, cap = 24) => [...new Set(
  (Array.isArray(list) ? list : [])
    .map((x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((x) => x.slice(0, 48)),
)].slice(0, cap);

export function scannerPrompts() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'scannerPrompts'").get();
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  return {
    comments: saved.comments ? clean(saved.comments) : DEFAULTS.comments,
    overrides: saved.overrides ? clean(saved.overrides) : DEFAULTS.overrides,
    commentTimeout: saved.commentTimeout == null
      ? DEFAULT_TIMEOUT
      : Math.max(0, Math.min(120, Number(saved.commentTimeout) || 0)),
    isDefault: !row,
  };
}

export function saveScannerPrompts(body = {}) {
  const now = scannerPrompts();
  const next = {
    comments: body.comments === undefined ? now.comments : clean(body.comments),
    overrides: body.overrides === undefined ? now.overrides : clean(body.overrides),
    commentTimeout: body.commentTimeout === undefined
      ? now.commentTimeout
      : Math.max(0, Math.min(120, Number(body.commentTimeout) || 0)),
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('scannerPrompts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(next));
  return { ...next, isDefault: false };
}

export const defaultScannerPrompts = () => ({ ...DEFAULTS, commentTimeout: DEFAULT_TIMEOUT });
