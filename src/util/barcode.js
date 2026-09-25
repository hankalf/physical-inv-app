/*
 * Code 128, drawn as SVG.
 *
 * For the test book: a page of bin and pallet labels a supervisor can print,
 * tape to a desk and practise on, or use to dry-run a count before the real one.
 * Zebra handhelds read Code 128 out of the box and it is what warehouse labels
 * are normally printed in, so what a counter practises on behaves exactly like
 * the racking will.
 *
 * Code 128 in one paragraph: every character is six bars and spaces, written as
 * a run-length string of six digits (three bars, three spaces, alternating,
 * starting with a bar). A symbol is a start code, the data, a check character
 * (the weighted sum of everything before it, modulo 103) and a stop pattern.
 * Set B covers everything on a keyboard, which is everything a bin code or a
 * pallet ID can be; set C packs digit PAIRS into one symbol, which is what makes
 * a long numeric ID narrow enough to fit on a label.
 */

/* The 107 patterns, values 0-106. Index is the symbol's value; the string is the
   widths of its bars and spaces. */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

/** Set B: printable ASCII 32-126 maps straight onto values 0-94. */
const valueB = (ch) => ch.charCodeAt(0) - 32;

/**
 * Split the text into runs, using set C for stretches of digits long enough to
 * pay for the switch. Four digits is the break-even point; six makes it worth
 * doing mid-string.
 */
function encode(text) {
  const s = String(text);
  const out = [];
  let i = 0;
  let mode = null;

  const digitsAt = (at) => {
    let n = 0;
    while (at + n < s.length && s[at + n] >= '0' && s[at + n] <= '9') n++;
    return n;
  };

  while (i < s.length) {
    const run = digitsAt(i);
    const wantC = run >= (i === 0 ? 4 : 6) || (run >= 2 && i + run === s.length && run % 2 === 0 && run >= 4);
    if (wantC && run >= 2) {
      const pairs = Math.floor(run / 2) * 2;
      if (mode === null) { out.push(START_C); mode = 'C'; }
      else if (mode !== 'C') { out.push(CODE_C); mode = 'C'; }
      for (let k = 0; k < pairs; k += 2) out.push(Number(s.slice(i + k, i + k + 2)));
      i += pairs;
      continue;
    }
    if (mode === null) { out.push(START_B); mode = 'B'; }
    else if (mode !== 'B') { out.push(CODE_B); mode = 'B'; }
    const ch = s[i];
    const v = valueB(ch);
    // anything outside printable ASCII cannot be drawn, and silently dropping it
    // would print a label that scans as something else
    if (v < 0 || v > 94) throw Object.assign(new Error(`"${ch}" cannot go in a Code 128 barcode`), { status: 400 });
    out.push(v);
    i++;
  }
  if (!out.length) { out.push(START_B); }

  /* The check character: start value, plus each data value times its position. */
  let sum = out[0];
  for (let k = 1; k < out.length; k++) sum += out[k] * k;
  out.push(sum % 103);
  out.push(STOP);
  return out;
}

/** The symbol as a run-length string: bar, space, bar, space… in module widths. */
export function widths(text) {
  return encode(text).map((v) => PATTERNS[v]).join('');
}

/**
 * One barcode as an SVG element.
 *
 * `module` is the width of the narrowest bar in millimetres - 0.33mm (13 mil) is
 * the usual floor for a laser-printed label that a warehouse scanner will read
 * across a metre. `height` is the bars only; the text underneath is drawn below
 * them so the code can be typed when a scanner will not have it.
 */
export function barcodeSvg(text, { module = 0.36, height = 14, quiet = 3, showText = true, fontSize = 3.6 } = {}) {
  const runs = widths(text);
  const units = [...runs].reduce((n, c) => n + Number(c), 0);
  const w = (units + quiet * 2) * module;
  const textH = showText ? fontSize + 1.4 : 0;
  const h = height + textH;
  let x = quiet * module;
  let bar = true;
  let rects = '';
  for (const c of runs) {
    const width = Number(c) * module;
    if (bar) rects += `<rect x="${x.toFixed(3)}" y="0" width="${width.toFixed(3)}" height="${height}"/>`;
    x += width;
    bar = !bar;
  }
  const label = showText
    ? `<text x="${(w / 2).toFixed(2)}" y="${(height + fontSize).toFixed(2)}" text-anchor="middle"
         font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${fontSize}"
         letter-spacing="0.2">${String(text).replace(/[<&]/g, (m) => (m === '<' ? '&lt;' : '&amp;'))}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}"
    width="${w.toFixed(2)}mm" height="${h.toFixed(2)}mm" shape-rendering="crispEdges" fill="#000">
    ${rects}${label}</svg>`;
}

/** How wide that barcode will print, in millimetres - for fitting it on a label. */
export const barcodeWidthMm = (text, module = 0.36, quiet = 3) =>
  ([...widths(text)].reduce((n, c) => n + Number(c), 0) + quiet * 2) * module;
