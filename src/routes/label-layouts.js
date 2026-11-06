/*
 * Pallet label layouts.
 *
 * Three systems share the warehouse and each prints its own kind of pallet
 * label: FR and eight digits from one, a T and six from another. A scan that
 * fits none of them is not an unknown pallet - it is a misread, a rack label
 * in the wrong field, or a typo. Given the layouts, the gun can say so, and a
 * strict count can refuse the label outright instead of adding a pallet that
 * never existed to the count.
 *
 * A layout is a mask: 9 for a digit, A for a letter, X for either, and any
 * other character for itself (case does not matter). "FR99999999" is FR and
 * eight digits. Several masks for one system are separated by commas. The
 * masks can be worked out from the report itself: see suggestLayouts.
 */
import { db, norm } from '../db.js';

const KEY = 'labelLayouts';

/** a mask -> a regular expression over the whole (upper-cased) label */
export function maskToRegex(mask) {
  const m = String(mask || '').trim().toUpperCase();
  if (!m) return null;
  let out = '^';
  for (const ch of m) out += ch === '9' ? '\\d' : ch === 'A' ? '[A-Z]' : ch === 'X' ? '[A-Z0-9]' : ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  return new RegExp(out + '$');
}
/** the mask a label has: letters -> A, digits -> 9, the rest kept */
export const maskOf = (label) => String(label || '').trim().toUpperCase().replace(/[A-Z]/g, 'A').replace(/\d/g, '9');
const cleanMasks = (raw) => [...new Set(String(Array.isArray(raw) ? raw.join(',') : raw || '').toUpperCase().split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 12);

export function labelLayouts() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  const layouts = (Array.isArray(saved.layouts) ? saved.layouts : [])
    .map((l) => ({ system: norm(l.system || ''), masks: cleanMasks(l.masks), note: String(l.note || '').slice(0, 120) }))
    .filter((l) => l.masks.length);
  return { on: saved.on === true && layouts.length > 0, layouts, isDefault: !row };
}

export function saveLabelLayouts(body = {}) {
  const now = labelLayouts();
  const layouts = body.layouts === undefined ? now.layouts
    : (Array.isArray(body.layouts) ? body.layouts : []).map((l) => ({ system: norm(l.system || ''), masks: cleanMasks(l.masks), note: String(l.note || '').slice(0, 120) })).filter((l) => l.masks.length);
  for (const l of layouts) for (const m of l.masks) if (m.length > 40) throw Object.assign(new Error(`mask too long: ${m}`), { status: 400 });
  const next = { on: body.on === undefined ? now.on : body.on === true, layouts };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(next));
  return { ...labelLayouts(), isDefault: false };
}

/** which system's label this is, by its layout; null when it fits none */
export function labelSystem(label, cfg = labelLayouts()) {
  const v = String(label || '').trim().toUpperCase();
  for (const l of cfg.layouts) for (const m of l.masks) { const re = maskToRegex(m); if (re && re.test(v)) return { system: l.system, mask: m }; }
  return null;
}
/** what the gun gets: the masks by system, in words too */
export function publicLabelLayouts(cfg = labelLayouts()) {
  return cfg.on ? cfg.layouts.map((l) => ({ system: l.system, masks: l.masks, words: l.masks.map(maskWords).join(' or ') })) : [];
}
/** "FR99999999" -> "FR + 8 digits" */
export function maskWords(mask) {
  const parts = [];
  for (const m of String(mask || '').toUpperCase().matchAll(/9+|A+|X+|[^9AX]+/g)) {
    const s = m[0];
    parts.push(s[0] === '9' ? `${s.length} digit${s.length === 1 ? '' : 's'}` : s[0] === 'A' ? `${s.length} letter${s.length === 1 ? '' : 's'}` : s[0] === 'X' ? `${s.length} letter${s.length === 1 ? '' : 's'} or digit${s.length === 1 ? '' : 's'}` : s);
  }
  return parts.join(' + ');
}

/**
 * The layouts a report implies: for each system, the masks its pallet IDs
 * take, most common first, with how many of the system's labels each covers.
 * A mask that covers under 2% of a system's labels is noise - a hand-typed ID
 * - and is listed but not suggested.
 */
export function suggestLayouts(sessionId) {
  const rows = db.prepare("SELECT COALESCE(source, '') AS system, pallet_id FROM pallets WHERE session_id = ?").all(Number(sessionId));
  const by = new Map();
  for (const r of rows) {
    const k = norm(r.system);
    if (!by.has(k)) by.set(k, { system: k, total: 0, masks: new Map() });
    const s = by.get(k); s.total++;
    const m = maskOf(r.pallet_id);
    if (!s.masks.has(m)) s.masks.set(m, { n: 0, labels: [] });
    const g = s.masks.get(m); g.n++; if (g.labels.length < 400) g.labels.push(String(r.pallet_id).trim().toUpperCase());
  }
  /* a letter the same on every label of the shape is part of the layout - FR99999999, not AA99999999 */
  const literal = (shape, labels) => [...shape].map((ch, i) => (ch === 'A' && labels.every((l) => l[i] === labels[0][i]) ? labels[0][i] : ch)).join('');
  return [...by.values()].map((s) => {
    const all = [...s.masks.entries()].sort((a, b) => b[1].n - a[1].n).map(([shape, g]) => { const mask = literal(shape, g.labels); return { mask, n: g.n, pct: Math.round(1000 * g.n / s.total) / 10, words: maskWords(mask), suggested: g.n / s.total >= 0.02 }; });
    return { system: s.system, total: s.total, masks: all.slice(0, 8), suggested: all.filter((x) => x.suggested).map((x) => x.mask) };
  }).sort((a, b) => a.system.localeCompare(b.system));
}
