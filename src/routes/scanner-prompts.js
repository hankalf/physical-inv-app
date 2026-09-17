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
/* How long the comments step waits before moving itself on. Two seconds is
   long enough to tap a chip and short enough that a counter with nothing to say
   is not standing there waiting; 0 turns it off and waits for them. */
const DEFAULT_TIMEOUT = 2;

const clean = (list, cap = 24) => [...new Set(
  (Array.isArray(list) ? list : [])
    .map((x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((x) => x.slice(0, 48)),
)].slice(0, cap);

/* Which count a scanner lands on at sign-on. A site running a wall-to-wall
   alongside its cycle programme wants every gun starting on the right one. */
export function defaultSessionId() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'defaultSessionId'").get();
  const id = row ? Number(row.value) : 0;
  if (!id) return 0;
  const s = db.prepare("SELECT id FROM sessions WHERE id = ? AND status = 'open'").get(id);
  return s ? s.id : 0;     // a closed or deleted one stops being the default
}

export function setDefaultSessionId(id) {
  const n = Number(id) || 0;
  if (n && !db.prepare("SELECT 1 FROM sessions WHERE id = ? AND status = 'open'").get(n)) {
    throw Object.assign(new Error('that count is not open, so scanners cannot start on it'), { status: 400 });
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('defaultSessionId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(n));
  return defaultSessionId();
}

/*
 * The comments step used to wait five seconds and now waits two.
 *
 * A site that had ever saved its reason codes carried the old five in its
 * settings row, so the new default would never have reached it: the number a
 * counter actually waits would still be five, and somebody would have to know
 * to go and change it. This moves that one value once, and leaves a marker so
 * a site that deliberately chooses five keeps it.
 */
export function migrateCommentTimeout() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'commentTimeoutMovedTo2'").get();
  if (done) return { moved: false, reason: 'already done' };
  db.prepare("INSERT INTO settings (key, value) VALUES ('commentTimeoutMovedTo2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(new Date().toISOString());

  const row = db.prepare("SELECT value FROM settings WHERE key = 'scannerPrompts'").get();
  if (!row) return { moved: false, reason: 'nothing saved - it takes the new default anyway' };
  let saved = {};
  try { saved = JSON.parse(row.value); } catch { return { moved: false, reason: 'unreadable' }; }
  if (Number(saved.commentTimeout) !== 5) return { moved: false, reason: `left at ${saved.commentTimeout}` };

  saved.commentTimeout = DEFAULT_TIMEOUT;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'scannerPrompts'").run(JSON.stringify(saved));
  return { moved: true, from: 5, to: DEFAULT_TIMEOUT };
}

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

/* ------------------------------------------------------------ gun layout
 * How the counting screen is put together: which questions, in what order,
 * and how much the gun shows. A site that counts location-first wants bin
 * before pallet; a freezer crew in gloves wants bigger text.
 */
const STEPS = ['pallet', 'qty', 'bin', 'lot', 'expiry'];
const LAYOUT_DEFAULTS = {
  order: ['pallet', 'qty', 'lot', 'expiry', 'bin'],
  textSize: 'normal',      // normal | large
  showContents: true,      // the SKU and description after a pallet scan
  showNextBin: true,       // the next bin in the aisle
  confirmOver: 1000,       // re-key a quantity at least this big
  vibrate: true,
  device: 'mc9090',        // which screen the admin preview draws
  /* Off by default: Chrome announces a page taking the screen with a banner
     carrying the site's address, which on a handheld lands over the counting
     screen. Installing the app from its own link is the quiet way to get the
     same thing, so this is opt-in for sites that want it anyway. */
  fullScreen: false,       // take the whole screen at sign-on
  keepAwake: true,         // hold the screen on while a team is counting
};

function cleanOrder(list) {
  const want = (Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()).filter((x) => STEPS.includes(x));
  const out = [...new Set(want)];
  for (const s of STEPS) if (!out.includes(s)) out.push(s);   // never lose a question
  return out;
}

export function scannerLayout() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'scannerLayout'").get();
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  return {
    order: saved.order ? cleanOrder(saved.order) : LAYOUT_DEFAULTS.order,
    textSize: saved.textSize === 'large' ? 'large' : 'normal',
    showContents: saved.showContents === undefined ? true : !!saved.showContents,
    showNextBin: saved.showNextBin === undefined ? true : !!saved.showNextBin,
    confirmOver: saved.confirmOver === undefined ? LAYOUT_DEFAULTS.confirmOver
      : Math.max(0, Math.min(1e7, Number(saved.confirmOver) || 0)),
    vibrate: saved.vibrate === undefined ? true : !!saved.vibrate,
    fullScreen: saved.fullScreen === undefined ? LAYOUT_DEFAULTS.fullScreen : !!saved.fullScreen,
    keepAwake: saved.keepAwake === undefined ? true : !!saved.keepAwake,
    device: saved.device === 'mc9200' ? 'mc9200' : 'mc9090',
    isDefault: !row,
  };
}

export function saveScannerLayout(body = {}) {
  const now = scannerLayout();
  const next = {
    order: body.order === undefined ? now.order : cleanOrder(body.order),
    textSize: body.textSize === undefined ? now.textSize : (body.textSize === 'large' ? 'large' : 'normal'),
    showContents: body.showContents === undefined ? now.showContents : !!body.showContents,
    showNextBin: body.showNextBin === undefined ? now.showNextBin : !!body.showNextBin,
    confirmOver: body.confirmOver === undefined ? now.confirmOver : Math.max(0, Math.min(1e7, Number(body.confirmOver) || 0)),
    vibrate: body.vibrate === undefined ? now.vibrate : !!body.vibrate,
    fullScreen: body.fullScreen === undefined ? now.fullScreen : !!body.fullScreen,
    keepAwake: body.keepAwake === undefined ? now.keepAwake : !!body.keepAwake,
    device: body.device === undefined ? now.device : (body.device === 'mc9200' ? 'mc9200' : 'mc9090'),
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('scannerLayout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(next));
  return { ...next, isDefault: false };
}

export const defaultScannerLayout = () => ({ ...LAYOUT_DEFAULTS });
