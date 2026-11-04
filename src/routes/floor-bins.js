/* Floor bins: pallets standing on the floor that a team counts like an aisle.
 *
 * The receiving floor (REC) and the staging spots (PRYSTG#1 to PRYSTG#16) are
 * not racking, and the site's bin list files them under areas that the layout
 * keeps off the plan - or leaves out of the count altogether. On count day
 * they still hold pallets, and somebody has to count them.
 *
 * So the site keeps a short list of floor bins. Each line is one "aisle" a
 * team can be given: a single bin (REC), or a run of numbered spots
 * (PRYSTG#1-16, sixteen bins in one aisle). Put on a count, they are ordinary
 * bins to the scanners - scanned, counted, second-counted, exported - with no
 * level, so any team reaches them and the guided walk goes spot by spot.
 *
 * They go onto a count when a supervisor presses the button, and from then on
 * every bin-list upload to that count puts them back, so a Replace upload the
 * night before cannot lose them.
 */
import { db, norm, bumpMasterVersion } from '../db.js';

export const DEFAULT_FLOOR_BINS = 'REC: Receiving floor - pallets on the floor\nPRYSTG#1-16: Staged for after the count - still counted';
export const FLOOR_ZONE = 'FLOOR';
const KEY = 'floorBins';
const onKey = (id) => `floor:${Number(id)}`;
const MAX_RUN = 500;

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const putSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

/** The list as typed, or the shipped one. */
export const floorBinsText = () => { const v = getSetting(KEY); return v == null ? DEFAULT_FLOOR_BINS : v; };

/**
 * One line -> one aisle of floor bins.
 *   "REC"                      -> aisle REC, bin REC
 *   "PRYSTG#1-16"              -> aisle PRYSTG, bins PRYSTG#1 … PRYSTG#16
 *   "DOCK 1-4: Dock doors"     -> aisle DOCK, bins DOCK 1 … DOCK 4, described
 * Anything after a colon is the description. Blank lines are skipped; a line
 * that cannot be read is returned with an error instead of an aisle.
 */
export function parseFloorBins(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const [head, ...rest] = line.split(':');
    const desc = rest.join(':').trim();
    const code = norm(head);
    if (!code) { out.push({ line: i + 1, error: 'no bin code before the colon' }); return; }
    if (/[,;"']/.test(code)) { out.push({ line: i + 1, error: `"${code}" - one bin or run per line, with no commas` }); return; }
    const run = /^(.*?[^\d])(\d+)\s*-\s*(\d+)$/.exec(code);
    if (run) {
      const [, prefix, a, b] = run;
      const from = Number(a), to = Number(b);
      if (!(from <= to)) { out.push({ line: i + 1, error: `"${code}" runs backwards - put the small number first` }); return; }
      if (to - from + 1 > MAX_RUN) { out.push({ line: i + 1, error: `"${code}" is ${to - from + 1} bins - the most in one run is ${MAX_RUN}` }); return; }
      const aisle = prefix.replace(/[#\-_./\\ ]+$/, '').trim();
      if (!aisle) { out.push({ line: i + 1, error: `"${code}" has no name before the numbers` }); return; }
      const bins = [];
      for (let n = from; n <= to; n++) bins.push(`${prefix}${String(n).padStart(a.length, '0')}`.replace(/\s+/g, ' ').trim());
      out.push({ line: i + 1, aisle, bins, description: desc, run: `${bins[0]} to ${bins[bins.length - 1]}` });
      return;
    }
    out.push({ line: i + 1, aisle: code, bins: [code], description: desc, run: '' });
  });
  return out;
}

/** Save the list; a line that cannot be read refuses the whole save and says which. */
export function saveFloorBins(text) {
  const t = String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const parsed = parseFloorBins(t);
  const bad = parsed.filter((p) => p.error);
  if (bad.length) throw Object.assign(new Error(`line ${bad[0].line}: ${bad[0].error}`), { status: 400 });
  const seen = new Set();
  for (const p of parsed) {
    if (seen.has(p.aisle)) throw Object.assign(new Error(`line ${p.line}: ${p.aisle} is on the list twice`), { status: 400 });
    seen.add(p.aisle);
  }
  putSetting(KEY, t);
  return t;
}

/** Whether this count has had the floor bins put on it (so uploads keep them there). */
export const floorOn = (sessionId) => !!getSetting(onKey(sessionId));

const upLocation = db.prepare(
  `INSERT INTO locations (session_id, code, zone, aisle, level, last_counted, description) VALUES (?, ?, ?, ?, '', NULL, ?)
   ON CONFLICT(session_id, code) DO UPDATE SET
     zone = excluded.zone, aisle = excluded.aisle, level = '',
     description = COALESCE(NULLIF(excluded.description, ''), locations.description)`
);
const upAisle = db.prepare('INSERT INTO aisles (session_id, aisle, block) VALUES (?, ?, ?) ON CONFLICT(session_id, aisle) DO NOTHING');

/**
 * Put the floor bins on a count: each run as its own aisle, every bin with no
 * level. A bin the bin list already had (REC under AREAS) moves to its floor
 * aisle; a bin the layout left out (the staging spots) is added. Counts
 * already taken against a bin stay with it. From now on the count keeps them
 * through bin-list uploads.
 */
export function ensureFloorBins(sessionId, { mark = true } = {}) {
  const id = Number(sessionId);
  const areas = parseFloorBins(floorBinsText()).filter((p) => !p.error);
  const result = { aisles: [], added: 0, moved: [], kept: 0 };
  db.exec('BEGIN');
  try {
    for (const a of areas) {
      for (const code of a.bins) {
        const before = db.prepare('SELECT aisle FROM locations WHERE session_id = ? AND code = ?').get(id, code);
        upLocation.run(id, code, FLOOR_ZONE, a.aisle, a.description || '');
        if (!before) result.added++;
        else if (before.aisle !== a.aisle) result.moved.push(`${code} (was under ${before.aisle || 'no aisle'})`);
        else result.kept++;
      }
      upAisle.run(id, a.aisle, a.aisle);
      result.aisles.push(a.aisle);
    }
    if (mark && areas.length) putSetting(onKey(id), new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (areas.length) bumpMasterVersion(id);
  return result;
}

/**
 * Where the floor bins stand on a count: per aisle, how many of its bins are
 * on the count, which teams have it, and how many bins have a count.
 */
export function floorState(sessionId) {
  const id = Number(sessionId) || 0;
  const areas = parseFloorBins(floorBinsText());
  const bins = id ? db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ?').get(id).n : 0;
  const rows = areas.map((a) => {
    if (a.error) return { line: a.line, error: a.error };
    const on = id ? db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ? AND aisle = ? AND code IN (' + a.bins.map(() => '?').join(',') + ')').get(id, a.aisle, ...a.bins).n : 0;
    const teams = id ? db.prepare("SELECT team, status FROM assignments WHERE session_id = ? AND aisle = ? ORDER BY status = 'active' DESC, position").all(id, a.aisle) : [];
    const counted = id ? db.prepare(`SELECT COUNT(DISTINCT c.location_code) n FROM counts c JOIN locations l ON l.session_id = c.session_id AND l.code = c.location_code
                                      WHERE c.session_id = ? AND c.voided = 0 AND l.aisle = ?`).get(id, a.aisle).n : 0;
    return { line: a.line, aisle: a.aisle, bins: a.bins.length, first: a.bins[0], last: a.bins[a.bins.length - 1], run: a.run, description: a.description,
      onCount: on, missing: a.bins.length - on, teams: teams.map((t) => t.team), active: teams.filter((t) => t.status === 'active').map((t) => t.team),
      done: teams.some((t) => t.status === 'done'), counted };
  });
  const good = rows.filter((r) => !r.error);
  return {
    text: floorBinsText(), default: DEFAULT_FLOOR_BINS, sessionId: id || null, countHasBins: bins > 0, on: id ? floorOn(id) : false,
    areas: rows,
    bins: good.reduce((n, r) => n + r.bins, 0),
    onCount: good.reduce((n, r) => n + r.onCount, 0),
    allOn: good.length > 0 && good.every((r) => r.missing === 0),
    unassigned: good.filter((r) => r.onCount > 0 && !r.teams.length).map((r) => r.aisle),
  };
}

/** The aisles the floor list names: REC, PRYSTG … */
export const floorAisleNames = () => new Set(parseFloorBins(floorBinsText()).filter((p) => !p.error).map((p) => p.aisle));

/**
 * Is this aisle floor bins on this count: named on the floor list, with its
 * bins carrying no level? (A site whose rack bins have no level letters at all
 * is not floor: its aisles are still planned by level, as one level.)
 */
export function isFloorAisle(sessionId, aisle) {
  const a = norm(aisle);
  if (!floorAisleNames().has(a)) return false;
  const r = db.prepare(`SELECT COUNT(*) AS bins, SUM(CASE WHEN TRIM(COALESCE(level, '')) != '' THEN 1 ELSE 0 END) AS leveled
                          FROM locations WHERE session_id = ? AND aisle = ?`).get(Number(sessionId), a);
  return !!(r && r.bins > 0 && !r.leveled);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Labels for the floor bins, to print and hang where each one is: a big Code 128 and the code, two to a page. */
export function floorLabels(sessionId, barcodeSvg, { countName = '' } = {}) {
  const areas = parseFloorBins(floorBinsText()).filter((p) => !p.error);
  const cards = areas.flatMap((a) => a.bins.map((code, i) => `
    <div class="label">
      <div class="kicker">FLOOR BIN · ${esc(a.aisle)}${a.bins.length > 1 ? ` · ${i + 1} OF ${a.bins.length}` : ''}</div>
      ${barcodeSvg(code, { module: 0.9, height: 26, quiet: 4, showText: false })}
      <div class="code">${esc(code)}</div>
      <div class="desc">${esc(a.description || 'Pallets on the floor')}</div>
      <div class="how">Count every pallet standing here: scan this label as the bin, then each pallet.</div>
    </div>`));
  const total = cards.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Floor bin labels</title><style>
  @page { size: letter portrait; margin: 10mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #000; background: #fff; margin: 0; padding: 10px; }
  h1 { font-size: 18pt; margin: 0 0 2px; }
  .sub { color: #444; font-size: 9.5pt; margin-bottom: 10px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 8mm; }
  .label { border: 2px solid #000; border-radius: 6px; padding: 8mm 8mm 6mm; text-align: center; break-inside: avoid; page-break-inside: avoid; min-height: 110mm; display: flex; flex-direction: column; justify-content: center; background: #e9f7ea; }
  .label svg { display: block; width: 100%; height: auto; margin: 0 auto; max-width: 160mm; }
  .kicker { font-size: 10pt; font-weight: 800; letter-spacing: .16em; color: #333; margin-bottom: 6px; }
  .code { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 900; letter-spacing: .04em; margin-top: 6px; font-size: 44pt; }
  .desc { font-size: 13pt; font-weight: 700; margin-top: 4px; }
  .how { font-size: 9.5pt; color: #555; margin-top: 6px; }
  .noprint { margin-bottom: 10px; padding: 6px 12px; }
  @media print { .noprint { display: none; } }
</style></head><body>
<h1>Floor bin labels${countName ? ` — ${esc(countName)}` : ''}</h1>
<div class="sub">${total} label${total === 1 ? '' : 's'} · ${areas.map((a) => `${esc(a.aisle)} (${a.bins.length})`).join(' · ')} · Code 128, two to a page. Hang each where its pallets stand; the scanners read it as the bin.</div>
<button class="noprint" onclick="window.print()">Print</button>
<div class="grid">${cards.join('')}</div>
</body></html>`;
}
