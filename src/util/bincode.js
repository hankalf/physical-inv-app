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
