// Bin code parsing shared by the importer and the map.
//
//   A03-12-1   separated: aisle A03, bay 12, level 1
//   F01A001    fixed:     zone F, aisle 01, level A, bin 001  -> aisle F01, level A, bay 001
//   AA0102     letters-then-digits with no level: aisle AA, bay 0102
const SEP = /[-_./\\ ]/;
const FIXED = /^([A-Z]+\d+)([A-Z])(\d+)$/;

export function parseBinCode(raw) {
  const code = String(raw == null ? '' : raw).trim().toUpperCase();
  const parts = code.split(SEP).filter(Boolean);
  if (parts.length >= 2) return { aisle: parts[0], bay: parts[1], level: parts[2] || '' };
  const m = FIXED.exec(code);
  if (m) return { aisle: m[1], level: m[2], bay: m[3] };
  const alpha = /^([A-Z]+)(\d*)$/.exec(code);
  if (alpha) return { aisle: alpha[1], bay: alpha[2] || code, level: '' };
  return { aisle: code, bay: code, level: '' };
}

// "F01" -> "1", "A03" -> "3", "12" -> "12": the number a layout drawing uses.
export const aisleNumber = (aisle) => {
  const m = /(\d+)\s*$/.exec(String(aisle || ''));
  return m ? String(Number(m[1])) : String(aisle || '').toUpperCase();
};

// "A-C", "a,b,c", "ABC", "A C" -> "ABC"; "" or "all" -> "" (every level)
export function normLevels(raw) {
  const t = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!t || t === 'ALL' || t === '*') return '';
  const out = new Set();
  for (const part of t.split(/[,\s;]+/).filter(Boolean)) {
    const range = /^([A-Z])\s*[-–]\s*([A-Z])$/.exec(part);
    if (range) {
      for (let c = range[1].charCodeAt(0); c <= range[2].charCodeAt(0); c++) out.add(String.fromCharCode(c));
    } else {
      for (const ch of part.replace(/[^A-Z]/g, '')) out.add(ch);
    }
  }
  return [...out].sort().join('');
}

// "ABC" -> "A–C", "ACE" -> "A, C, E", "" -> "all levels"
export function levelsLabel(levels) {
  const l = String(levels || '');
  if (!l) return 'all levels';
  if (l.length === 1) return `level ${l}`;
  const contiguous = [...l].every((c, i) => i === 0 || c.charCodeAt(0) === l.charCodeAt(i - 1) + 1);
  return contiguous ? `levels ${l[0]}–${l[l.length - 1]}` : `levels ${[...l].join(', ')}`;
}

// do two level sets overlap? '' means every level
export const levelsOverlap = (a, b) => !a || !b || [...a].some((c) => b.includes(c));
