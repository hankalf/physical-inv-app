import { db } from '../db.js';
import { palletReport } from './reports.js';
import { localDate } from '../util/localtime.js';
import { toCsv } from '../util/csv.js';

/*
 * The file that goes back into the ERP.
 *
 * Every system wants its own column names and its own idea of a row, so the
 * layout is configuration rather than code: a named format says what a row is
 * and what each column is called. Add a format here (or through the API) and it
 * appears in the dashboard - no deploy.
 */

const FIELDS = {
  bin: (r) => r.location,
  pallet: (r) => r.pallet,
  sku: (r) => r.sku,
  description: (r) => r.description,
  uom: (r) => r.uom,
  counted: (r) => r.counted,
  expected: (r) => r.expected,
  variance: (r) => r.variance,
  status: (r) => r.status,
  countedAt: (r) => r.countedAt,
  countDate: () => localDate(),
  team: (r) => r.team,
  employees: (r) => r.employees,
  zone: (r) => r.zone,
  aisle: (r) => r.aisle,
  level: (r) => r.level,
  reference: (r) => r.reference,
  adjustment: (r) => (r.expected === '' ? r.counted : Number(r.counted) - Number(r.expected || 0)),
};

const BUILTIN = {
  'pallet-lines': {
    label: 'Pallet lines — one row per pallet counted',
    rowsOf: 'pallets',
    columns: [['Location', 'bin'], ['Pallet', 'pallet'], ['Item', 'sku'], ['Description', 'description'],
      ['UOM', 'uom'], ['Quantity', 'counted'], ['Count Date', 'countDate'], ['Reference', 'reference']],
  },
  'adjustments': {
    label: 'Adjustments — only what differs from the report',
    rowsOf: 'variances',
    columns: [['Location', 'bin'], ['Item', 'sku'], ['Pallet', 'pallet'], ['System Qty', 'expected'],
      ['Counted Qty', 'counted'], ['Adjustment', 'adjustment'], ['Reason', 'status'], ['Count Date', 'countDate']],
  },
  'bin-lines': {
    label: 'Bin lines — one row per count line, with who counted it',
    rowsOf: 'lines',
    columns: [['Location', 'bin'], ['Pallet', 'pallet'], ['Item', 'sku'], ['Quantity', 'counted'],
      ['Counted At', 'countedAt'], ['Team', 'team'], ['Clock In Numbers', 'employees'], ['Reference', 'reference']],
  },
};

export function listFormats() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'erpFormats'").get();
  let custom = {};
  try { custom = row ? JSON.parse(row.value) : {}; } catch { custom = {}; }
  return { ...BUILTIN, ...custom };
}

export function saveFormat(id, format) {
  const key = String(id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!key) throw Object.assign(new Error('a name for the format is required'), { status: 400 });
  const columns = (format.columns || []).map((c) => [String(c[0] ?? c.header ?? ''), String(c[1] ?? c.field ?? '')])
    .filter(([h, f]) => h && FIELDS[f]);
  if (!columns.length) throw Object.assign(new Error('at least one column, and its field must be one we can fill'), { status: 400 });
  const row = db.prepare("SELECT value FROM settings WHERE key = 'erpFormats'").get();
  let custom = {};
  try { custom = row ? JSON.parse(row.value) : {}; } catch { custom = {}; }
  custom[key] = {
    label: String(format.label || key),
    rowsOf: ['pallets', 'variances', 'lines'].includes(format.rowsOf) ? format.rowsOf : 'pallets',
    columns,
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('erpFormats', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(custom));
  return listFormats();
}

export const availableFields = () => Object.keys(FIELDS);

/** The rows a format is built from, normalised so every field works everywhere. */
function sourceRows(sessionId, rowsOf) {
  const id = Number(sessionId);
  const reference = `PI-${id}-${localDate()}`;
  if (rowsOf === 'lines') {
    return db.prepare(
      `SELECT c.location_code, c.pallet_id, c.sku, c.qty, c.scanned_at, c.team, c.employees, c.empty_bin,
              COALESCE(p.description,'') AS description, COALESCE(p.uom,'') AS uom,
              COALESCE(l.zone,'') AS zone, COALESCE(l.aisle,'') AS aisle, COALESCE(l.level,'') AS level
         FROM counts c
         LEFT JOIN pallets p ON p.session_id = c.session_id AND p.pallet_id = c.pallet_id
         LEFT JOIN locations l ON l.session_id = c.session_id AND l.code = c.location_code
        WHERE c.session_id = ? AND c.voided = 0 ORDER BY c.id`).all(id)
      .map((r) => ({
        location: r.location_code, pallet: r.empty_bin ? '' : r.pallet_id, sku: r.sku || '', description: r.description,
        uom: r.uom, counted: r.qty, expected: '', variance: '', status: r.empty_bin ? 'EMPTY' : 'COUNTED',
        countedAt: r.scanned_at, team: r.team, employees: (JSON.parse(r.employees || '[]') || []).join('; '),
        zone: r.zone, aisle: r.aisle, level: r.level, reference,
      }));
  }
  const bins = new Map(db.prepare('SELECT code, COALESCE(zone,\'\') zone, COALESCE(aisle,\'\') aisle, COALESCE(level,\'\') level FROM locations WHERE session_id = ?').all(id).map((b) => [b.code, b]));
  let rows = palletReport(id).map((r) => {
    const found = String(r.found_location || '').split(',')[0] || r.expected_location || '';
    const b = bins.get(found) || {};
    return {
      location: found, pallet: r.pallet_id, sku: r.sku, description: r.description, uom: r.uom,
      counted: r.counted_qty === '' ? 0 : r.counted_qty, expected: r.expected_qty, variance: r.variance_qty,
      status: r.status, countedAt: r.last_scan, team: r.teams, employees: '',
      zone: b.zone || '', aisle: b.aisle || '', level: b.level || '', reference,
    };
  });
  // a second label is a tag on a pallet already in this file, never its own adjustment
  rows = rows.filter((r) => r.status !== 'SECOND LABEL');
  if (rowsOf === 'variances') rows = rows.filter((r) => r.status !== 'MATCH');
  return rows;
}

export function buildExport(sessionId, formatId) {
  const formats = listFormats();
  const format = formats[formatId];
  if (!format) throw Object.assign(new Error(`no export format called "${formatId}"`), { status: 404 });
  const rows = sourceRows(sessionId, format.rowsOf);
  const headers = format.columns.map(([h]) => h);
  const out = rows.map((r) => {
    const o = {};
    for (const [header, field] of format.columns) o[header] = FIELDS[field] ? FIELDS[field](r) : '';
    return o;
  });
  return { csv: toCsv(out, headers), rows: out.length, format };
}
