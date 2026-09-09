import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A layout is a floor-plan image plus the pixel box of every aisle on it, plus
// site knowledge the importer can use (how to group non-rack bins into aisles).
// Shipped as public/layouts/<name>.json.
const DIR = resolve(fileURLToPath(new URL('../../public/layouts', import.meta.url)));

export function listLayouts() {
  let files = [];
  try { files = readdirSync(DIR); } catch { return []; }
  const out = [];
  for (const f of files.filter((n) => n.endsWith('.json'))) {
    try {
      const j = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
      out.push({ id: f.replace(/\.json$/, ''), name: j.name || f, aisles: Object.keys(j.aisles || {}).length });
    } catch { /* skip a broken file */ }
  }
  return out;
}

export function loadLayout(id) {
  if (!id || !/^[a-z0-9_-]+$/i.test(id)) return null;
  try { return JSON.parse(readFileSync(join(DIR, id + '.json'), 'utf8')); } catch { return null; }
}

/**
 * Aisle/zone for a bin that is not a rack position, from the layout's rules:
 *   { "match": "^DOOR|^KSTRANS", "aisle": "DOORS", "zone": "Dock" }
 * Rules are tried in order; `match` is a regex on the code, `descMatch` on the description.
 */
export function classifyByRules(layout, code, description) {
  for (const r of (layout && layout.aisleRules) || []) {
    const codeOk = !r.match || new RegExp(r.match, 'i').test(code);
    const descOk = !r.descMatch || new RegExp(r.descMatch, 'i').test(description || '');
    if (codeOk && descOk) return { aisle: r.aisle, zone: r.zone || '' };
  }
  return null;
}
