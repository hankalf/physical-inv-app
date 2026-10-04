/*
 * The site's own inventory report, as its systems export it.
 *
 * Bin Code, Container No., Item No., Description, Variant Code, Quantity,
 * Unit of Measure Code, Entry No., Lot No., System - fifteen thousand rows of
 * it, with the quirks a real export has: OPEN rows for empty positions, a
 * container listed in two bins, bin codes typed in lower case, a $ on one
 * container number, a few zero and negative quantities. A sample that keeps
 * every quirk is uploaded here, and what comes out the other side is checked:
 * the pallet report, the CSV, the ERP file, the upload summary.
 */
import { readFileSync } from 'node:fs';
import { parseRecords } from '../src/util/csv.js';
const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
const get = async (p) => j(await fetch(BASE + p, { headers: A }));

const sample = readFileSync(`${S}fixtures/site-report-sample.csv`, 'utf8');
// the app's own reader, so a description with a comma or a line break in it is one row here too
const K = { bin: 'bincode', container: 'containerno', item: 'itemno', desc: 'description', variant: 'variantcode', qty: 'quantity', uom: 'unitofmeasurecode', entry: 'entryno', lot: 'lotno', system: 'system' };
const rows = parseRecords(sample).records.map((r) => Object.fromEntries(Object.entries(K).map(([k, col]) => [k, r[col] || ''])));
const withContainer = rows.filter((r) => r.container);
const containers = new Set(withContainer.map((r) => r.container.replace(/^\$/, '')));
const open = rows.filter((r) => !r.container).length;

const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'Site report' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8') });
const up = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: sample }));

check(`The file loads as it comes: ${rows.length} rows, headers as the system writes them`, up.rows === rows.length && !up.error, up.error || `${up.pallets} pallets`);
check('Every container becomes a pallet once', up.pallets === containers.size, `${up.pallets} pallets for ${containers.size} containers`);
check(`OPEN rows are empty positions, not pallets: ${open} of them`, up.openBins === open, `${up.openBins}`);
check('A container on two rows is reported, and the first row stands', up.duplicates === 1 && /4822666 \(F16B039 and F15E045\)/.test(up.duplicateList.join(' ')), up.duplicateList.join(' | '));
check('Zero and negative quantities are counted and kept', up.nonPositive >= 3, `${up.nonPositive}`);
check('The four systems are told apart', up.bySource && up.bySource.JUSTFOOD > 0 && up.bySource.SGI > 0 && up.bySource.NTFF > 0, JSON.stringify(up.bySource));

const report = await get(`/api/admin/sessions/${sess.id}/pallets?limit=5000`);
const byId = new Map(report.rows.map((r) => [r.pallet_id, r]));
const first = withContainer.find((r) => r.variant && r.entry && r.desc) || withContainer.find((r) => r.entry);
const got = byId.get(first.container.toUpperCase());
check('Item No., Description, Unit of Measure Code and Lot No. land in their columns',
  got && got.sku === first.item.toUpperCase() && got.description === first.desc && got.uom === first.uom.toUpperCase() && got.expected_lot === first.lot.toUpperCase(),
  got && `${got.sku} / ${got.uom} / ${got.expected_lot}`);
check('Entry No. and Variant Code come through to the pallet report', got && got.entry_no === first.entry && got.variant === first.variant.toUpperCase(), got && `${got.entry_no} ${got.variant}`);
const dup = byId.get('4822666');
check('The duplicated container is expected where its first row said', dup && dup.expected_location === 'F16B039', dup && dup.expected_location);
const lower = rows.find((r) => r.bin !== r.bin.toUpperCase() && r.container);
check('A bin code typed in lower case is the same bin', byId.get(lower.container.toUpperCase())?.expected_location === lower.bin.toUpperCase(), byId.get(lower.container.toUpperCase())?.expected_location);
const dollar = rows.find((r) => r.container.startsWith('$'));
check('A $ on a container number is the ERP\'s prefix, dropped', !!dollar && byId.has(dollar.container.slice(1).toUpperCase()) && !byId.has(dollar.container), dollar && dollar.container);
check('The System column is on every pallet', report.rows.every((r) => ['JUSTFOOD', 'SGI', 'NTFF'].includes(r.source)));

const out = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/pallets.csv`, { headers: A })).text();
const head = out.trim().split('\n')[0].split(',');
check('The pallet CSV carries system, variant and entry number', ['source', 'variant', 'entry_no'].every((c) => head.includes(c)), head.slice(0, 8).join(','));

const fmt = await get('/api/admin/erp/formats');
check('An ERP format can carry the entry number and the variant back', (fmt.fields || []).includes('entryNo') && (fmt.fields || []).includes('variant'), (fmt.fields || []).slice(0, 12).join(','));

/* the practice count and the shipped template speak the same layout */
const tpl = readFileSync(`${S}../public/templates/pallets-template.csv`, 'utf8').split('\n')[0];
check('The pallet template has the site\'s columns', tpl === 'Bin Code,Container No.,Item No.,Description,Variant Code,Quantity,Unit of Measure Code,Entry No.,Lot No.,System', tpl);
const prac = await j(await fetch(`${BASE}/api/admin/practice`, { method: 'POST', headers: A, body: '{}' }));
check('The practice count is built from a report in that layout, with 25 pallets', prac.totals.pallets === 25 && prac.bins.some((b) => !b.shelf.length));

console.log(`\n${results.filter(Boolean).length}/${results.length} site-report checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
