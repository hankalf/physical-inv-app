// Minimal RFC4180-ish CSV/TSV reader + writer. Handles quoted fields,
// embedded commas/newlines, CRLF, BOM, and comma/tab/semicolon/pipe delimiters.

export function detectDelimiter(text) {
  const line = text.slice(0, 8192).split(/\r?\n/).find((l) => l.trim().length) || '';
  const counts = [
    [',', (line.match(/,/g) || []).length],
    ['\t', (line.match(/\t/g) || []).length],
    [';', (line.match(/;/g) || []).length],
    ['|', (line.match(/\|/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseCsv(text, delimiter) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (ch === d) {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\n') {
      row.push(field);
      if (started || row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
      started = false;
    } else if (ch === '\r') {
      // handled by the \n branch
    } else {
      field += ch;
      started = true;
    }
  }
  row.push(field);
  if (started || row.some((f) => f !== '')) rows.push(row);
  return rows;
}

// Parses to objects keyed by a normalized header (lowercase, alphanumeric only)
// so "Item Number", "item_number" and "ITEMNUMBER" all land on the same key.
export function parseRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const raw = rows[0].map((h) => h.trim());
  const headers = raw.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => c.trim() === '')) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = (r[j] ?? '').trim();
    obj.__raw = r;
    records.push(obj);
  }
  return { headers: raw, normalized: headers, records };
}

// First matching alias wins; used to accept whatever the ERP export calls things.
export function pick(record, aliases) {
  for (const a of aliases) {
    const key = a.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (record[key] != null && record[key] !== '') return record[key];
  }
  return '';
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [columns.map(esc).join(',')];
  for (const r of rows) out.push(columns.map((c) => esc(r[c])).join(','));
  return out.join('\r\n') + '\r\n';
}
