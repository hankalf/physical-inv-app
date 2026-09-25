/*
 * The made-up warehouse the manual and the demo video are both filmed in.
 *
 * Real bins - the Front Royal list that ships as a template - with a frozen-food
 * inventory report laid over them: ten SKUs a cold store would actually hold,
 * lots, best-before dates, and positions that hold one pallet, or two, or four,
 * because a picture of a warehouse where every bay holds exactly one pallet
 * teaches somebody the wrong thing.
 *
 * Kept here so the screenshots and the video are filmed in the same building.
 * Pure data: no server, no HTTP. The tools post it themselves.
 */

export const ITEMS = [
  ['SKU-4120', 'Chicken breast IQF 40lb'], ['SKU-4180', 'Chicken thigh boneless 30lb'],
  ['SKU-2210', 'Peas petite 12x2lb'], ['SKU-2240', 'Sweetcorn supersweet 20lb'],
  ['SKU-6610', 'Salmon fillet skin-on 10lb'], ['SKU-6640', 'Cod loin 8lb'],
  ['SKU-3310', 'Fries shoestring 6x5lb'], ['SKU-3350', 'Hash brown patty 240ct'],
  ['SKU-8810', 'Blueberry wild 30lb'], ['SKU-8840', 'Strawberry sliced 20lb'],
];

/* Between them a team has to reach every level it is given: a dock truck and a
   scissor lift for B and C, a high reach for D to F. */
export const CREW = [
  ['E1043', 'Marcus Obi', ['HIGH REACH', 'SCISSOR LIFT'], '1'], ['E1088', 'Priya Raman', ['DOCK TRUCK', 'FOOT'], '1'],
  ['E1102', 'Tom Zielinski', ['HIGH REACH', 'SCISSOR LIFT'], '2'], ['E1157', 'Ava Delgado', ['DOCK TRUCK', 'FOOT'], '2'],
  ['E1163', 'Luis Ferreira', ['HIGH REACH', 'SCISSOR LIFT'], '3'], ['E1190', 'Grace Kim', ['DOCK TRUCK', 'FOOT'], '3'],
  ['E1204', 'Nadia Haddad', ['FOOT'], ''], ['E1219', 'Owen Blackwell', ['DOCK TRUCK'], ''],
];

export const AISLES = ['F01', 'F02', 'F03', 'F04', 'F05', 'F06'];
const BINS_WITH_STOCK = 300;             // a freezer aisle is never full to the roof
// most positions hold one pallet, some hold two, a few hold three or four
const palletsIn = (i) => (i % 23 === 7 ? 4 : i % 11 === 3 ? 3 : i % 5 === 2 ? 2 : 1);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/**
 * Build the inventory report CSV over a bin list.
 *
 * Returns the file itself, what every pallet is supposed to be (so a tool can
 * type the right quantity, lot and date), and which pallets are in each bin (so
 * one can film a bay that holds three).
 */
export function buildReport(binCsv) {
  const bins = binCsv.trim().split('\n').slice(1).map((l) => l.split(',')[0]);
  const binsOf = (a) => bins.filter((b) => b.startsWith(a));
  const expected = new Map();
  const palletAt = new Map();
  let report = 'Pallet ID,SKU,Description,Qty,Location,Lot Code,Best Before\n';
  for (const a of AISLES) {
    let seq = 0;
    binsOf(a).slice(0, BINS_WITH_STOCK).forEach((bin, i) => {
      const here = [];
      for (let k = 0; k < palletsIn(i); k++) {
        const n = ++seq;
        const [sku, desc] = ITEMS[(i + k) % ITEMS.length];
        const id = `${a}-${String(n).padStart(3, '0')}`;
        const qty = 24 + ((n * 7) % 40);
        const lot = `L2026${String(100 + ((i * 13) % 800))}`;
        const exp = day(n % 17 === 0 ? -20 : n % 11 === 0 ? 12 : 120 + (n % 400));
        expected.set(id, { bin, qty, sku, desc, lot, exp });
        here.push(id);
        report += `${id},${sku},"${desc}",${qty},${bin},${lot},${exp}\n`;
      }
      palletAt.set(bin, here);
    });
  }
  return { report, expected, palletAt, bins, binsOf };
}
