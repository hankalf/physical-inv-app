/*
 * The file checked before it is loaded: what the upload would find wrong with
 * a bin list or an inventory report - the same bin on two rows, a pallet in
 * two bins, a pallet in a bin that is not on the list, blank or unreadable
 * quantities, codes with odd characters, a System column half filled - so the
 * person uploading sees it first and loads the file knowing, or fixes it.
 * Nothing is written: the import does that, with the same reading of the file.
 */
import { db, norm, getSession } from '../db.js';
import { parseRecords, pick } from '../util/csv.js';
import { parseBinCode } from '../util/bincode.js';
import { ALIASES, deriveAisle } from './master.js';

const RACK = /^[A-Z]+\d+[A-Z]\d+$/;
const ODD = /[^A-Z0-9#&+()\-_./]/;        // after norm(): anything but letters, digits and the punctuation a site uses (R&DSAMP, WIP-2, DOCK.3)
const few = (list, n = 10) => list.slice(0, n);

export function checkMaster(sessionId, kind, text, { source = '', replace = false } = {}) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  const findings = [];
  const add = (level, key, title, n, list = [], detail = '') => findings.push({ level, key, title, n, list: few(list), more: Math.max(0, list.length - 10), detail });
  const { headers, records } = parseRecords(text);
  const has = (aliases) => headers.some((h) => aliases.includes(String(h).toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (!records.length) {
    add('fail', 'empty', 'No data rows in the file', 0, [], 'Only a header line, or nothing at all. Check the sheet and the export.');
    return done();
  }

  if (kind === 'bins') {
    if (!has(ALIASES.location)) add('fail', 'noBinColumn', 'No bin column', 0, headers, 'The file needs a Bin Location (or Location, Bin, Code) column. The columns found are listed.');
    else {
      const seen = new Map();
      const dups = [];
      const odd = [];
      const noAisle = [];
      let blank = 0;
      for (const rec of records) {
        const code = norm(pick(rec, ALIASES.location));
        if (!code) { blank++; continue; }
        seen.set(code, (seen.get(code) || 0) + 1);
        if (seen.get(code) === 2) dups.push(code);
        if (ODD.test(code) || /\s/.test(String(pick(rec, ALIASES.location)).trim())) odd.push(String(pick(rec, ALIASES.location)).trim());
        const aisle = norm(pick(rec, ALIASES.aisle)) || deriveAisle(code);
        if (!aisle) noAisle.push(code);
      }
      if (dups.length) add('warn', 'dupBins', `${dups.length} bin${dups.length === 1 ? '' : 's'} on more than one row`, dups.length, dups.map((c) => `${c} ×${seen.get(c)}`), 'One row per bin: the later rows update the first. Usually a sheet pasted twice, or two zones listing the same bin.');
      if (odd.length) add('warn', 'oddBins', `${odd.length} bin code${odd.length === 1 ? '' : 's'} with odd characters`, odd.length, odd, 'A space, a quote or a stray symbol in a code will never match what a label scans. Fix the export, or the label.');
      if (noAisle.length) add('warn', 'noAisle', `${noAisle.length} bin${noAisle.length === 1 ? '' : 's'} with no aisle`, noAisle.length, noAisle, 'No Aisle column and nothing in the code to read one from: these bins cannot be given to a team.');
      if (blank) add('info', 'blankBins', `${blank} row${blank === 1 ? '' : 's'} with no bin code`, blank, [], 'Skipped.');
      const have = db.prepare('SELECT COUNT(*) AS n FROM locations WHERE session_id = ?').get(id).n;
      const counted = db.prepare('SELECT COUNT(DISTINCT location_code) AS n FROM counts WHERE session_id = ? AND voided = 0').get(id).n;
      if (replace && have) {
        const inFile = new Set([...seen.keys()]);
        const gone = db.prepare('SELECT code FROM locations WHERE session_id = ?').all(id).map((r) => r.code).filter((c) => !inFile.has(c));
        if (gone.length) add('warn', 'binsGone', `${gone.length} bin${gone.length === 1 ? '' : 's'} on the count now are not in this file`, gone.length, gone, 'Replace what is there is ticked: these bins come off the list. Counts already taken against them stay but no longer match a bin.');
      }
      if (counted) add('info', 'countsExist', `Counting has started on this count: ${counted.toLocaleString()} bin${counted === 1 ? '' : 's'} already have a count`, counted, [], 'A new bin list is checked against those counts as they stand.');
    }
  }

  if (kind === 'pallets') {
    if (!has(ALIASES.pallet)) add('fail', 'noPalletColumn', 'No pallet column', 0, headers, 'The file needs a Container No. (or Pallet ID, LPN) column. The columns found are listed.');
    if (!has(ALIASES.location)) add('fail', 'noBinColumn', 'No bin column', 0, headers, 'The file needs a Bin Code (or Location, Bin) column. The columns found are listed.');
    if (findings.some((f) => f.level === 'fail')) return done();
    const binList = new Set(db.prepare('SELECT code FROM locations WHERE session_id = ?').all(id).map((r) => r.code));
    const hasQty = has(ALIASES.qty);
    const hasSource = has(ALIASES.source);
    const seen = new Map();          // pallet -> { bins:Set, systems:Set, rows }
    const notOnList = new Map();     // bin -> rows
    const blankQty = [], badQty = [], nonPositive = [], huge = [], oddIds = [], likeBins = [], blankBin = [], noSystem = [], noItem = [];
    let openRows = 0, skipped = 0;
    for (const rec of records) {
      const rawId = String(pick(rec, ALIASES.pallet)).trim();
      const pallet = norm(rawId).replace(/^\$+/, '');
      const bin = norm(pick(rec, ALIASES.location));
      if (!pallet) { if (bin) openRows++; else skipped++; continue; }
      const e = seen.get(pallet) || { bins: new Set(), systems: new Set(), rows: 0 };
      e.rows++; if (bin) e.bins.add(bin);
      const sys = norm(pick(rec, ALIASES.source)) || norm(source);
      if (sys) e.systems.add(sys);
      seen.set(pallet, e);
      if (!bin) blankBin.push(pallet);
      else if (binList.size && !binList.has(bin)) notOnList.set(bin, (notOnList.get(bin) || 0) + 1);
      if (hasQty) {
        const raw = String(pick(rec, ALIASES.qty)).trim();
        const q = Number(raw.replace(/[, ]/g, ''));
        if (raw === '') blankQty.push(pallet);
        else if (!Number.isFinite(q)) badQty.push(`${pallet} "${raw}"`);
        else if (q <= 0) nonPositive.push(`${pallet} ${q}`);
        else if (q > 1e6) huge.push(`${pallet} ${q.toLocaleString()}`);
      }
      if (ODD.test(pallet) || /\s/.test(rawId.replace(/^\$+/, ''))) oddIds.push(rawId);
      if (RACK.test(pallet) && binList.has(pallet)) likeBins.push(pallet);
      if (hasSource && !norm(pick(rec, ALIASES.source))) noSystem.push(pallet);
      if (!norm(pick(rec, ALIASES.sku))) noItem.push(pallet);
    }
    const twoBins = [...seen].filter(([, e]) => e.bins.size > 1);
    const sameBin = [...seen].filter(([, e]) => e.rows > 1 && e.bins.size <= 1);
    const twoSystems = [...seen].filter(([, e]) => e.systems.size > 1);
    if (twoBins.length) add('warn', 'dupPallets', `${twoBins.length} pallet${twoBins.length === 1 ? '' : 's'} listed in two different bins`, twoBins.length, twoBins.map(([p, e]) => `${p} (${[...e.bins].join(' and ')})`), 'A pallet is in one place. The first row stands and the rest are reported after loading; the count will flag it WRONG BIN wherever it is found. Check the export, or decide which bin is right.');
    if (twoSystems.length) add('warn', 'dupSystems', `${twoSystems.length} pallet${twoSystems.length === 1 ? '' : 's'} listed under two systems`, twoSystems.length, twoSystems.map(([p, e]) => `${p} (${[...e.systems].join(', ')})`), 'The same container number in two systems: one of them is wrong, or two systems share a number. The first row stands.');
    if (sameBin.length) add('info', 'mergedPallets', `${sameBin.length} pallet${sameBin.length === 1 ? '' : 's'} on more than one row in the same bin`, sameBin.length, sameBin.map(([p, e]) => `${p} ×${e.rows}`), 'Ledger entries for one pallet: the quantities are added up.');
    if (notOnList.size) {
      const list = [...notOnList].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${b} (${n})`);
      const rows = [...notOnList.values()].reduce((t, n) => t + n, 0);
      add('warn', 'binsNotOnList', `${rows.toLocaleString()} pallet${rows === 1 ? '' : 's'} in ${notOnList.size} bin${notOnList.size === 1 ? '' : 's'} not on the bin list`, rows, list, 'The report puts them in bins the count does not have. Either the bin list is short (upload the missing bins) or the report names bins the warehouse has not got; a scan into such a bin is refused or flagged.');
    } else if (!binList.size) add('warn', 'noBinList', 'No bin list on this count yet', 0, [], 'Upload the bin list first: without it the report\'s bins cannot be checked, and no aisle can be given to a team.');
    if (!hasQty) add('warn', 'noQtyColumn', 'No quantity column', 0, headers, 'Without a Quantity column every pallet counts as a match: nothing can be a QTY VARIANCE.');
    if (blankQty.length) add('warn', 'blankQty', `${blankQty.length} pallet${blankQty.length === 1 ? '' : 's'} with no quantity`, blankQty.length, blankQty, 'A pallet with no quantity is found or missing, never over or under.');
    if (badQty.length) add('warn', 'badQty', `${badQty.length} quantit${badQty.length === 1 ? 'y' : 'ies'} that will not read as a number`, badQty.length, badQty, 'Text in the quantity column: these load with no quantity.');
    if (nonPositive.length) add('info', 'nonPositive', `${nonPositive.length} zero or negative quantit${nonPositive.length === 1 ? 'y' : 'ies'}`, nonPositive.length, nonPositive, 'Kept as the report says.');
    if (huge.length) add('warn', 'hugeQty', `${huge.length} quantit${huge.length === 1 ? 'y' : 'ies'} over a million`, huge.length, huge, 'Probably a unit mix-up (grams for cases) or a column slip.');
    if (oddIds.length) add('warn', 'oddIds', `${oddIds.length} pallet ID${oddIds.length === 1 ? '' : 's'} with odd characters`, oddIds.length, oddIds, 'A space, a quote or a stray symbol will never match what the label scans.');
    if (likeBins.length) add('warn', 'idsLikeBins', `${likeBins.length} pallet ID${likeBins.length === 1 ? '' : 's'} that are bin codes`, likeBins.length, likeBins, 'The container column holds a bin code: the columns may be swapped on those rows.');
    if (blankBin.length) add('warn', 'blankBin', `${blankBin.length} pallet${blankBin.length === 1 ? '' : 's'} with no bin`, blankBin.length, blankBin, 'Nowhere expected: found anywhere, they are a move; not found, they are missing.');
    if (noSystem.length && noSystem.length < seen.size) add('warn', 'noSystem', `${noSystem.length} pallet${noSystem.length === 1 ? '' : 's'} with no System while the rest have one`, noSystem.length, noSystem, source ? `They take the system picked for the upload: ${norm(source)}.` : 'They load with no system and will not show under any system filter. Pick a system for the upload, or fill the column.');
    if (noItem.length) add('info', 'noItem', `${noItem.length} pallet${noItem.length === 1 ? '' : 's'} with no item`, noItem.length, noItem, 'The scanner shows no description for them.');
    if (openRows) add('info', 'openRows', `${openRows.toLocaleString()} empty position${openRows === 1 ? '' : 's'} (a bin and no container)`, openRows, [], 'Expected to be found empty.');
    if (skipped) add('info', 'skippedRows', `${skipped} row${skipped === 1 ? '' : 's'} with neither pallet nor bin`, skipped, [], 'Skipped.');
    const already = db.prepare('SELECT COUNT(*) AS n FROM pallets WHERE session_id = ?').get(id).n;
    if (already && !replace) {
      const have = new Set(db.prepare('SELECT pallet_id FROM pallets WHERE session_id = ?').all(id).map((r) => r.pallet_id));
      const upd = [...seen.keys()].filter((p) => have.has(p)).length;
      if (upd) add('info', 'updates', `${upd.toLocaleString()} pallet${upd === 1 ? '' : 's'} already on the count will be updated`, upd, [], `${already.toLocaleString()} pallets are loaded; this file adds to them. Tick Replace what is there to start from the file alone.`);
    }
    const counted = db.prepare('SELECT COUNT(*) AS n FROM counts WHERE session_id = ? AND voided = 0').get(id).n;
    if (counted) add('info', 'countsExist', `Counting has started on this count: ${counted.toLocaleString()} line${counted === 1 ? '' : 's'} taken`, counted, [], 'The new report is compared against the counts as they stand.');
  }

  return done();
  function done() {
    const order = { fail: 0, warn: 1, info: 2 };
    findings.sort((a, b) => order[a.level] - order[b.level]);
    return {
      kind, rows: records.length, headers, findings,
      fails: findings.filter((f) => f.level === 'fail').length,
      warns: findings.filter((f) => f.level === 'warn').length,
      infos: findings.filter((f) => f.level === 'info').length,
    };
  }
}
