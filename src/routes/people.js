import { db, norm } from '../db.js';
import { normLevels, levelsLabel } from '../util/bincode.js';

/*
 * The roster: who works here, what they can drive, and which team they are on
 * today. Teams and employees outlive a count session, so these tables are not
 * scoped to one.
 *
 * Equipment decides how high a person can reach, and a team's reach is the union
 * of its members'. An aisle assignment is refused when the team cannot reach the
 * levels it asks for - that is the whole point of holding this data.
 */

// How Front Royal actually works. A level names the equipment a team must have
// BETWEEN them - all of it, not any of it - and a level reachable two ways lists
// both. Editable from the teams page; this is only the starting point.
const DEFAULT_CONFIG = {
  equipment: {
    FOOT: 'On foot',
    'DOCK TRUCK': 'Dock truck',
    'SCISSOR LIFT': 'Scissor lift',
    'HIGH REACH': 'High reach truck',
  },
  levelRules: [
    { levels: 'A', requires: [] },
    { levels: 'BC', requires: ['DOCK TRUCK', 'SCISSOR LIFT'] },
    { levels: 'CDEF', requires: ['HIGH REACH', 'SCISSOR LIFT'] },
  ],
};

// what people write in a spreadsheet -> the canonical key
const ALIASES = {
  FOOT: 'FOOT', WALK: 'FOOT', WALKING: 'FOOT', GROUND: 'FOOT', NONE: 'FOOT', 'ON FOOT': 'FOOT',
  DOCK: 'DOCK TRUCK', 'DOCK TRUCK': 'DOCK TRUCK', DOCKTRUCK: 'DOCK TRUCK', PALLETJACK: 'DOCK TRUCK',
  'PALLET JACK': 'DOCK TRUCK', 'ELECTRIC PALLET JACK': 'DOCK TRUCK', WALKIE: 'DOCK TRUCK',
  SCISSOR: 'SCISSOR LIFT', 'SCISSOR LIFT': 'SCISSOR LIFT', SCISSORLIFT: 'SCISSOR LIFT', LIFT: 'SCISSOR LIFT',
  'HIGH REACH': 'HIGH REACH', HIGHREACH: 'HIGH REACH', REACH: 'HIGH REACH', 'REACH TRUCK': 'HIGH REACH',
  'HIGH REACH TRUCK': 'HIGH REACH', FORKLIFT: 'HIGH REACH', FORK: 'HIGH REACH',
  'ORDER PICKER': 'HIGH REACH', 'CHERRY PICKER': 'HIGH REACH', TURRET: 'HIGH REACH',
  // the words on Front Royal's own team sheet
  'DOCK STOCKER': 'DOCK TRUCK', DOCKSTOCKER: 'DOCK TRUCK', 'DOCK STOCKER FORKLIFT': 'DOCK TRUCK', STOCKER: 'DOCK TRUCK',
  'RT': 'HIGH REACH', 'REACH TRUCK DRIVER': 'HIGH REACH',
};
/* a job on the sheet that is not a machine: no equipment, and not "unknown" either */
const ROLES = /^(SUPERVISOR|LEAD|TEAM LEAD|LEADER|COUNTER|CHECKER|SPOTTER|HELPER|PRODUCTION)$/;
/* "Scissor Lift - Counting", "On Foot with Dock Stockers": the machine first, then what the person does on it */
const TRAILING = /\s+(COUNTING|DRIVING|DRIVER|OPERATOR|RIDER|SPOTTER|WITH .*)$/;

export function getConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'equipment'").get();
  if (!row) return structuredClone(DEFAULT_CONFIG);
  try {
    const cfg = JSON.parse(row.value);
    return { equipment: cfg.equipment || DEFAULT_CONFIG.equipment, levelRules: cfg.levelRules || DEFAULT_CONFIG.levelRules };
  } catch { return structuredClone(DEFAULT_CONFIG); }
}

export const getEquipment = () => getConfig().equipment;

export function setConfig({ equipment, levelRules }) {
  const eq = {};
  for (const [k, v] of Object.entries(equipment || {})) {
    const key = norm(k);
    if (key) eq[key] = String(v || k);
  }
  if (!Object.keys(eq).length) throw Object.assign(new Error('at least one kind of equipment is needed'), { status: 400 });
  const rules = (levelRules || []).map((r) => ({
    levels: normLevels(r.levels),
    requires: (r.requires || []).map(norm).filter((e) => eq[e]),
  })).filter((r) => r.levels);
  if (!rules.length) throw Object.assign(new Error('at least one level rule is needed'), { status: 400 });
  const cfg = { equipment: eq, levelRules: rules };
  db.prepare("INSERT INTO settings (key, value) VALUES ('equipment', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(cfg));
  return cfg;
}

/** Free text from a spreadsheet -> canonical equipment keys we know about. */
export function parseEquipment(raw, known = getEquipment()) {
  const out = new Set();
  for (const part of String(raw == null ? '' : raw).split(/[,;/|]+/)) {
    let t = norm(part).replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const look = (x) => (known[x] ? x : ALIASES[x] || ALIASES[x.replace(/ /g, '')] || null);
    let key = look(t);
    while (!key && TRAILING.test(t)) { t = t.replace(TRAILING, ''); key = look(t); }
    if (key && known[key]) out.add(key);
  }
  return [...out];
}

/** A word on the sheet that names a job rather than a machine. */
export const isRoleWord = (raw) => ROLES.test(norm(raw).replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim());

/**
 * Levels a set of equipment can reach: every level whose rule is satisfied in
 * full by what is held. A team pools its members' equipment, so one person on a
 * scissor lift and another on a high reach together reach C-F.
 */
export function reachOf(equipmentList, cfg = getConfig()) {
  const have = new Set((equipmentList || []).map(norm));
  const levels = new Set();
  for (const rule of cfg.levelRules) {
    if (rule.requires.every((e) => have.has(norm(e)))) for (const c of rule.levels) levels.add(c);
  }
  return [...levels].sort().join('');
}

/**
 * The smallest set of extra equipment that would put all of `levels` in reach.
 * Answering per level and merging would over-state it: level C can be had two
 * ways, so "dock truck AND high reach" reads as if both were needed when either
 * would do. Brute force over the catalog - there are only ever a handful.
 */
export function missingForLevels(levels, equipmentList, cfg = getConfig()) {
  const have = (equipmentList || []).map(norm);
  const want = normLevels(levels);
  const covers = (kit) => [...want].every((c) => reachOf(kit, cfg).includes(c));
  if (covers(have)) return [];
  const options = Object.keys(cfg.equipment).filter((k) => k !== 'FOOT' && !have.includes(k));
  for (let size = 1; size <= options.length; size++) {
    const combos = [];
    const build = (start, acc) => {
      if (acc.length === size) { combos.push([...acc]); return; }
      for (let i = start; i < options.length; i++) { acc.push(options[i]); build(i + 1, acc); acc.pop(); }
    };
    build(0, []);
    for (const combo of combos) if (covers([...have, ...combo])) return combo.map((e) => (cfg.equipment[e] || e).toLowerCase());
  }
  return null;   // no combination of known equipment reaches it
}

/* ------------------------------------------------------------- employees */

/*
 * Gear sizes: the jacket, bibs (overalls) and boots each person wears in the
 * freezer, so an order can be placed from the list rather than by asking round.
 * Kept on the person, not the count, and never touched by a crew-list upload
 * that has no size columns.
 */
{
  const have = new Set(db.prepare("PRAGMA table_info('employees')").all().map((c) => c.name));
  for (const c of ['jacket', 'bibs', 'boots']) if (!have.has(c)) db.exec(`ALTER TABLE employees ADD COLUMN ${c} TEXT`);
}
const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const BOOTS = [];
for (let n = 5; n <= 16; n += 0.5) BOOTS.push(String(n));
export const GEAR = [
  { key: 'jacket', label: 'Jacket', plural: 'Jackets', sizes: CLOTHES },
  { key: 'bibs', label: 'Bibs', plural: 'Bibs (overalls)', sizes: CLOTHES },
  { key: 'boots', label: 'Boots', plural: 'Boots', sizes: BOOTS },
];
/* looked up with spaces and dashes taken out: "X-Large", "extra large" and "XL" are one size */
const CLOTHING_WORDS = {
  XSMALL: 'XS', EXTRASMALL: 'XS', SMALL: 'S', SM: 'S', MEDIUM: 'M', MED: 'M', MD: 'M',
  LARGE: 'L', LG: 'L', XLARGE: 'XL', EXTRALARGE: 'XL', XXLARGE: '2XL', XXXLARGE: '3XL',
  XXL: '2XL', XXXL: '3XL', XXXXL: '4XL', XXXXXL: '5XL', '1X': 'XL', '2X': '2XL', '3X': '3XL', '4X': '4XL', '5X': '5XL',
};
/** "xx-large", "XXL", "2x" -> 2XL; "10 1/2", "10.5" -> 10.5; a size it does not know is kept as written. */
export function cleanSize(key, raw) {
  let v = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!v) return '';
  if (key === 'boots') {
    v = v.replace(/^(SIZE|SZ)\s*/, '').replace(/\s*(½|1\/2)$/, '.5').replace(/\s+\.5$/, '.5');
    const n = Number(v.replace(/\s*(W|WIDE|M|MEDIUM|R|REGULAR)$/, ''));
    if (Number.isFinite(n) && n > 0) {
      const wide = /\s*(W|WIDE)$/.test(v) ? 'W' : '';
      return String(Math.round(n * 2) / 2) + wide;
    }
    return v.slice(0, 12);
  }
  v = v.replace(/^(SIZE|SZ)\s*/, '');
  const words = v.replace(/ ?(TALL|T)$/, '');
  const tall = words !== v ? ' TALL' : '';
  const tight = words.replace(/[-\s]/g, '');
  const base = CLOTHING_WORDS[tight] || tight.replace(/^(\d)XL$/, '$1XL');
  return (base + tall).slice(0, 12);
}

const shape = (r) => ({
  badge: r.badge, name: r.name, dept: r.dept || '',
  equipment: JSON.parse(r.equipment || '[]'),
  reach: reachOf(JSON.parse(r.equipment || '[]')),
  active: !!r.active, team: r.team || null,
  jacket: r.jacket || '', bibs: r.bibs || '', boots: r.boots || '',
});

/** Change someone's department or sizes; a key left out is left alone, an empty one clears it. */
export function setGear(badge, body = {}) {
  const b = norm(badge);
  if (!db.prepare('SELECT 1 FROM employees WHERE badge = ?').get(b)) throw Object.assign(new Error(`${b} is not on the crew list`), { status: 404 });
  const sets = []; const vals = [];
  if ('dept' in body) { sets.push('dept = ?'); vals.push(String(body.dept || '').trim().slice(0, 60)); }
  for (const g of GEAR) if (g.key in body) { sets.push(`${g.key} = ?`); vals.push(cleanSize(g.key, body[g.key])); }
  if (sets.length) db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE badge = ?`).run(...vals, b);
  return getEmployee(b);
}

/* sizes in the order they are worn, then anything written some other way */
const sizeOrder = (g) => (a, b) => {
  const ia = g.sizes.indexOf(a.replace(/W$| TALL$/, '')); const ib = g.sizes.indexOf(b.replace(/W$| TALL$/, ''));
  if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  return a.localeCompare(b);
};

/**
 * The size list and its totals: everyone (or one department), how many of each
 * size of each item, and the sheets for the Excel download.
 */
export function gearReport({ dept = '' } = {}) {
  const d = String(dept || '').trim();
  const everyone = listEmployees().filter((e) => e.active);
  const people = d ? everyone.filter((e) => e.dept.trim() === d) : everyone;
  const count = (list, g) => {
    const by = new Map();
    for (const e of list) if (e[g.key]) by.set(e[g.key], (by.get(e[g.key]) || 0) + 1);
    const sizes = [...by.keys()].sort(sizeOrder(g)).map((size) => ({ size, count: by.get(size) }));
    const entered = list.filter((e) => e[g.key]).length;
    return { key: g.key, label: g.label, plural: g.plural, sizes, entered, missing: list.length - entered };
  };
  const totals = GEAR.map((g) => count(people, g));
  const depts = [...new Set(people.map((e) => e.dept.trim() || 'No department'))].sort((a, b) => a.localeCompare(b));
  const byDept = depts.map((name) => {
    const list = people.filter((e) => (e.dept.trim() || 'No department') === name);
    return { dept: name, people: list.length, totals: GEAR.map((g) => count(list, g)) };
  });

  const sheetPeople = {
    name: 'Names and sizes',
    columns: ['Clock in number', 'Name', 'Department', 'Team', 'Jacket', 'Bibs', 'Boots'],
    rows: [...people].sort((a, b) => (!a.dept.trim() - !b.dept.trim()) || a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name)).map((e) => ({
      'Clock in number': e.badge, Name: e.name, Department: e.dept, Team: e.team || '',
      Jacket: e.jacket, Bibs: e.bibs, Boots: e.boots,
    })),
  };
  const totalRows = [];
  for (const t of totals) {
    for (const s of t.sizes) totalRows.push({ Item: t.plural, Size: s.size, Count: s.count });
    if (t.missing) totalRows.push({ Item: t.plural, Size: 'Not entered', Count: t.missing });
    totalRows.push({ Item: `${t.plural} — grand total`, Size: '', Count: t.entered });
    totalRows.push({ Item: '', Size: '', Count: '' });
  }
  totalRows.push({ Item: 'People on the list', Size: '', Count: people.length });
  const deptRows = [];
  for (const g of byDept) {
    for (const t of g.totals) for (const s of t.sizes) deptRows.push({ Department: g.dept, Item: t.plural, Size: s.size, Count: s.count });
    deptRows.push({ Department: `${g.dept} — people`, Item: '', Size: '', Count: g.people });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    gear: GEAR, dept: d, people, totals, byDept, depts: [...new Set(everyone.map((e) => e.dept.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    filename: `gear-sizes${d ? '-' + d.replace(/[^\w-]+/g, '-').toLowerCase() : ''}-${stamp}.xlsx`,
    sheets: [sheetPeople, { name: 'Grand totals', columns: ['Item', 'Size', 'Count'], rows: totalRows },
      { name: 'By department', columns: ['Department', 'Item', 'Size', 'Count'], rows: deptRows }],
  };
}

export function listEmployees() {
  return db
    .prepare(
      `SELECT e.*, (SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.badge = e.badge) AS team
         FROM employees e ORDER BY e.name, e.badge`
    )
    .all().map(shape);
}

export function upsertEmployee({ badge, name, dept, equipment, active = 1, jacket, bibs, boots }, { onlyNew = false } = {}) {
  const b = norm(badge);
  if (!b) throw Object.assign(new Error('clock in number required'), { status: 400 });
  /* Add employee is for someone new: a number already on the list is theirs, and Edit is how it changes */
  const there = onlyNew && db.prepare('SELECT name FROM employees WHERE badge = ?').get(b);
  if (there) throw Object.assign(new Error(`${b} is already ${there.name} on the crew list — use Edit on their row to change them`), { status: 409 });
  if (onlyNew && !String(name || '').trim()) throw Object.assign(new Error('a name is needed'), { status: 400 });
  const known = getEquipment();
  const list = Array.isArray(equipment) ? equipment.map(norm).filter((e) => known[e]) : parseEquipment(equipment);
  db.prepare(
    `INSERT INTO employees (badge, name, dept, equipment, active, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(badge) DO UPDATE SET
       name = COALESCE(NULLIF(excluded.name, ''), employees.name),
       dept = COALESCE(NULLIF(excluded.dept, ''), employees.dept),
       equipment = excluded.equipment,
       active = excluded.active`
  ).run(b, String(name || b).trim(), String(dept || '').trim(), JSON.stringify(list), active ? 1 : 0, new Date().toISOString());
  const sizes = Object.fromEntries(Object.entries({ jacket, bibs, boots }).filter(([, v]) => v != null && String(v).trim()));
  if (Object.keys(sizes).length) return setGear(b, sizes);
  return getEmployee(b);
}

export const getEmployee = (badge) => {
  const r = db.prepare('SELECT * FROM employees WHERE badge = ?').get(norm(badge));
  return r ? shape({ ...r, team: db.prepare('SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.badge = ?').get(norm(badge))?.name }) : null;
};

/**
 * Edit one person: any of clock-in number, name, department, equipment and
 * sizes. A key left out is left alone. A new clock-in number moves their team
 * place and their team-sheet seat with them; the counts already scanned keep
 * the number they were scanned under.
 */
export function updateEmployee(badge, body = {}) {
  const b = norm(badge);
  const was = db.prepare('SELECT * FROM employees WHERE badge = ?').get(b);
  if (!was) throw Object.assign(new Error(`${b} is not on the crew list`), { status: 404 });
  const sets = []; const vals = [];
  if ('name' in body) {
    const name = String(body.name || '').trim();
    if (!name) throw Object.assign(new Error('a name is needed'), { status: 400 });
    sets.push('name = ?'); vals.push(name.slice(0, 80));
  }
  if ('dept' in body) { sets.push('dept = ?'); vals.push(String(body.dept || '').trim().slice(0, 60)); }
  if ('equipment' in body) {
    const known = getEquipment();
    const list = Array.isArray(body.equipment) ? body.equipment.map(norm).filter((e) => known[e]) : parseEquipment(body.equipment);
    sets.push('equipment = ?'); vals.push(JSON.stringify([...new Set(list)]));
  }
  for (const g of GEAR) if (g.key in body) { sets.push(`${g.key} = ?`); vals.push(cleanSize(g.key, body[g.key])); }
  const next = 'badge' in body ? norm(body.badge) : b;
  if (!next) throw Object.assign(new Error('clock in number required'), { status: 400 });
  if (next !== b) {
    const other = db.prepare('SELECT name FROM employees WHERE badge = ?').get(next);
    if (other) throw Object.assign(new Error(`${next} is already ${other.name} on the crew list`), { status: 409 });
  }
  db.exec('BEGIN');
  try {
    if (sets.length) db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE badge = ?`).run(...vals, b);
    if (next !== b) {
      /* the badge is the key the team list hangs off: a copy under the new number, the team place moved, the old row gone */
      db.prepare(`INSERT INTO employees (badge, name, dept, equipment, active, created_at, jacket, bibs, boots)
                  SELECT ?, name, dept, equipment, active, created_at, jacket, bibs, boots FROM employees WHERE badge = ?`).run(next, b);
      db.prepare('UPDATE team_members SET badge = ? WHERE badge = ?').run(next, b);
      db.prepare('UPDATE team_seats SET badge = ? WHERE badge = ?').run(next, b);
      db.prepare('DELETE FROM employees WHERE badge = ?').run(b);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getEmployee(next);
}

export function deleteEmployee(badge) {
  db.prepare('DELETE FROM team_members WHERE badge = ?').run(norm(badge));
  return db.prepare('DELETE FROM employees WHERE badge = ?').run(norm(badge)).changes;
}

const SIZE_COLUMNS = [
  ['jacket', ['jacket', 'jacketsize', 'coat', 'coatsize', 'freezerjacket']],
  ['bibs', ['bibs', 'bib', 'bibsize', 'bibssize', 'overalls', 'overall', 'overallsize', 'overallssize', 'bibsoveralls', 'pants']],
  ['boots', ['boots', 'boot', 'bootsize', 'bootssize', 'shoe', 'shoesize']],
];
/** Import a roster CSV: badge, name, department, equipment, and sizes when it has them. */
export function importEmployees(text, { replace = false } = {}) {
  const { parseRecords, pick } = importHelpers;
  const { headers, records } = parseRecords(text);
  if (!records.length) throw Object.assign(new Error('no data rows found'), { status: 400 });
  const known = getEquipment();
  const stats = { rows: records.length, imported: 0, skipped: 0, unknownEquipment: new Set(), headers };
  db.exec('BEGIN');
  try {
    if (replace) { db.exec('DELETE FROM team_members'); db.exec('DELETE FROM employees'); }
    for (const rec of records) {
      const badge = norm(pick(rec, ['clockinnumber', 'clocknumber', 'clockin', 'clockno', 'badge', 'badgeid', 'employeeid', 'empid', 'id', 'employeenumber', 'employeeno', 'number']));
      if (!badge) { stats.skipped++; continue; }
      const rawEquip = pick(rec, ['equipment', 'equipmentcertified', 'certifications', 'certified', 'licences', 'licenses', 'canoperate', 'machines']);
      for (const part of String(rawEquip).split(/[,;/|]+/)) {
        const t = norm(part).replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (t && !parseEquipment(t, known).length) stats.unknownEquipment.add(t);
      }
      upsertEmployee({
        badge,
        name: pick(rec, ['name', 'employeename', 'fullname', 'employee']),
        dept: pick(rec, ['dept', 'department', 'area', 'shift', 'team']),
        equipment: parseEquipment(rawEquip, known),
      });
      /* sizes only when the sheet has them: a list without size columns leaves what was entered */
      const sizes = {};
      for (const [key, names] of SIZE_COLUMNS) { const v = pick(rec, names); if (String(v || '').trim()) sizes[key] = v; }
      if (Object.keys(sizes).length) { setGear(badge, sizes); stats.sizes = (stats.sizes || 0) + 1; }
      stats.imported++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  stats.unknownEquipment = [...stats.unknownEquipment];
  return stats;
}

// wired in by server.js to avoid a cycle with the CSV helpers
export const importHelpers = {};

/* ----------------------------------------------------------------- teams */

/*
 * A team's seats: the rows of the team sheet. Each is a place on the team -
 * its department, the person in it (or nobody yet: Production sends someone on
 * the day), and the machine it comes with. A seat's machine counts toward what
 * the team can reach whether or not the person is named yet, because the truck
 * is the team's: S1-RT05 has its high reach and its scissor lift either way.
 */
db.exec(`CREATE TABLE IF NOT EXISTS team_seats (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  dept      TEXT NOT NULL DEFAULT '',
  name      TEXT NOT NULL DEFAULT '',
  role      TEXT NOT NULL DEFAULT '',        -- the equipment cell as written: "Scissor Lift - Counting"
  equipment TEXT NOT NULL DEFAULT '[]',      -- what that is, in the app's own terms
  badge     TEXT                             -- the crew-list person in the seat, when matched
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_seats_team ON team_seats(team_id, position)');

export function listTeams() {
  const teams = db.prepare('SELECT * FROM teams ORDER BY name').all();
  const members = db
    .prepare('SELECT m.team_id, e.* FROM team_members m JOIN employees e ON e.badge = m.badge ORDER BY e.name')
    .all();
  const seats = db.prepare('SELECT * FROM team_seats ORDER BY team_id, position, id').all();
  const cfg = getConfig();
  return teams.map((t) => {
    const mine = members.filter((m) => m.team_id === t.id).map(shape);
    const mySeats = seats.filter((s) => s.team_id === t.id).map((s) => ({
      id: s.id, dept: s.dept, name: s.name, role: s.role, badge: s.badge || '',
      equipment: JSON.parse(s.equipment || '[]'),
      open: !s.name,
      onCrewList: !!s.badge,
    }));
    const equip = new Set();
    for (const m of mine) for (const e of m.equipment) equip.add(e);
    for (const s of mySeats) for (const e of s.equipment) equip.add(e);
    const anyone = mine.length || mySeats.length;
    return {
      id: t.id, name: t.name, notes: t.notes || '', shift: t.shift || '',
      members: mine,
      seats: mySeats,
      equipment: [...equip].filter((e) => cfg.equipment[e]),
      reach: anyone ? reachOf([...equip], cfg) : '',
      reachLabel: anyone ? levelsLabel(reachOf([...equip], cfg)) : 'nobody assigned',
    };
  });
}

/* What a team code like S1-DS01 says: the shift, the kind of truck, its number. */
const TEAM_KIND = { DS: 'Dock stocker', RT: 'Reach truck', HR: 'High reach', SL: 'Scissor lift', DT: 'Dock truck', OF: 'On foot', TL: 'Team lead', T0L: 'Team lead', TOL: 'Team lead', SUP: 'Supervisor' };
export function readTeamCode(code) {
  const c = norm(code);
  const m = /^S([12])\s*[-_ ]\s*([A-Z0-9]*?)(\d*)$/.exec(c);
  if (!m) return { shift: '', note: '' };
  const letters = m[2] || '';
  const kind = TEAM_KIND[letters] || TEAM_KIND[letters + m[3]] || (letters ? letters : '');
  const truck = TEAM_KIND[letters + m[3]] ? '' : m[3];
  return { shift: m[1], note: [kind, truck ? `truck ${truck}` : ''].filter(Boolean).join(' · ') };
}

/**
 * The team sheet: one row per seat - Team #, Department, Employee, Equipment
 * (and a clock-in number, if the sheet has one). Every team on it is made or
 * brought up to date: its shift from the S1 / S2 at the front of its number,
 * a note from the rest (DS = dock stocker, RT = reach truck, the truck number),
 * and its seats replaced by the sheet's rows. A named person found on the crew
 * list - by clock-in number, else by name - is put on the team; a blank name is
 * an open seat; teams not on the sheet are left alone.
 */
export function importTeamSheet(text, { replace = false } = {}) {
  const { parseRecords, pick } = importHelpers;
  const { records, headers } = parseRecords(text);
  if (!records.length) throw Object.assign(new Error('no data rows found'), { status: 400 });
  const cfg = getConfig();
  const known = cfg.equipment;
  const teamOf = (rec) => norm(pick(rec, ['team', 'teamno', 'teamnumber', 'teamid', 'crew', 'truck']));
  if (!records.some(teamOf)) throw Object.assign(new Error('the sheet has no Team # column - the columns are Team #, Department, Employee, Equipment'), { status: 400 });
  const byName = new Map(db.prepare('SELECT badge, name FROM employees').all().map((e) => [String(e.name || '').replace(/\s+/g, ' ').trim().toLowerCase(), e.badge]));
  const groups = new Map();
  const stats = { rows: records.length, teams: 0, created: 0, updated: 0, seats: 0, people: 0, matched: 0, notOnCrewList: [], open: 0, unknownEquipment: new Set(), removed: 0, headers };
  for (const rec of records) {
    const team = teamOf(rec);
    if (!team) continue;
    if (!groups.has(team)) groups.set(team, []);
    groups.get(team).push(rec);
  }
  db.exec('BEGIN');
  try {
    if (replace) {
      const keep = new Set(groups.keys());
      for (const t of db.prepare('SELECT id, name FROM teams').all()) if (!keep.has(t.name)) { db.prepare('DELETE FROM team_members WHERE team_id = ?').run(t.id); db.prepare('DELETE FROM team_seats WHERE team_id = ?').run(t.id); db.prepare('DELETE FROM teams WHERE id = ?').run(t.id); stats.removed++; }
    }
    for (const [name, rows] of groups) {
      const code = readTeamCode(name);
      let t = db.prepare('SELECT * FROM teams WHERE name = ?').get(name);
      if (!t) {
        db.prepare('INSERT INTO teams (name, notes, shift, created_at) VALUES (?, ?, ?, ?)').run(name, code.note, code.shift, new Date().toISOString());
        t = db.prepare('SELECT * FROM teams WHERE name = ?').get(name);
        stats.created++;
      } else {
        if (code.shift && t.shift !== code.shift) db.prepare('UPDATE teams SET shift = ? WHERE id = ?').run(code.shift, t.id);
        if (code.note && !t.notes) db.prepare('UPDATE teams SET notes = ? WHERE id = ?').run(code.note, t.id);
        stats.updated++;
      }
      stats.teams++;
      db.prepare('DELETE FROM team_seats WHERE team_id = ?').run(t.id);
      rows.forEach((rec, i) => {
        const person = String(pick(rec, ['employee', 'employe', 'employeename', 'name', 'fullname', 'person'])).replace(/\s+/g, ' ').trim();
        const dept = String(pick(rec, ['department', 'dept', 'area'])).trim();
        const role = String(pick(rec, ['equipment', 'role', 'position', 'job', 'machine'])).replace(/\s+/g, ' ').trim();
        const equipment = parseEquipment(role, known);
        if (role && !equipment.length && !isRoleWord(role)) stats.unknownEquipment.add(role);
        let badge = norm(pick(rec, ['clockinnumber', 'clocknumber', 'clockin', 'badge', 'badgeid', 'employeeid', 'empid', 'employeenumber']));
        if (badge && person) upsertEmployee({ badge, name: person, dept, equipment });
        if (!badge && person) badge = byName.get(person.toLowerCase()) || '';
        if (badge && !db.prepare('SELECT 1 FROM employees WHERE badge = ?').get(badge)) badge = '';
        if (person) { stats.people++; if (badge) stats.matched++; else stats.notOnCrewList.push(`${person} (${name})`); } else stats.open++;
        if (badge) { db.prepare('DELETE FROM team_members WHERE badge = ?').run(badge); db.prepare('INSERT INTO team_members (team_id, badge) VALUES (?, ?)').run(t.id, badge); }
        db.prepare('INSERT INTO team_seats (team_id, position, dept, name, role, equipment, badge) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(t.id, i, dept, person, role, JSON.stringify(equipment), badge || null);
        stats.seats++;
      });
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  stats.unknownEquipment = [...stats.unknownEquipment];
  const teams = listTeams().filter((t) => groups.has(t.name));
  stats.reach = teams.map((t) => ({ team: t.name, shift: t.shift, reach: t.reach, label: t.reachLabel }));
  return stats;
}

/* 1 or 2 - however it was written: "1st", "first", "day", "2nd", "second", "night" */
const cleanShift = (v) => {
  const t = String(v ?? '').trim().toLowerCase();
  if (/^(1|1st|first|day|days|morning|am|a)$/.test(t)) return '1';
  if (/^(2|2nd|second|night|nights|evening|afternoon|pm|b)$/.test(t)) return '2';
  return '';
};

export function createTeam({ name, notes, shift }) {
  const n = norm(name);
  if (!n) throw Object.assign(new Error('team name required'), { status: 400 });
  if (db.prepare('SELECT 1 FROM teams WHERE name = ?').get(n)) throw Object.assign(new Error(`team ${n} already exists`), { status: 409 });
  db.prepare('INSERT INTO teams (name, notes, shift, created_at) VALUES (?, ?, ?, ?)').run(n, String(notes || ''), cleanShift(shift), new Date().toISOString());
  return listTeams().find((t) => t.name === n);
}

/** Which shift a team works: 1st, 2nd, or not set. */
export function setTeamShift(id, shift) {
  const changed = db.prepare('UPDATE teams SET shift = ? WHERE id = ?').run(cleanShift(shift), Number(id)).changes;
  if (!changed) throw Object.assign(new Error('no such team'), { status: 404 });
  return listTeams().find((t) => t.id === Number(id));
}

export function deleteTeam(id) {
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(Number(id));
  db.prepare('DELETE FROM team_seats WHERE team_id = ?').run(Number(id));
  return db.prepare('DELETE FROM teams WHERE id = ?').run(Number(id)).changes;
}

/** Move an employee onto a team, or off every team when teamId is null. */
export function assignMember(badge, teamId) {
  const b = norm(badge);
  if (!db.prepare('SELECT 1 FROM employees WHERE badge = ?').get(b)) throw Object.assign(new Error(`nobody with clock in number ${b}`), { status: 404 });
  db.prepare('DELETE FROM team_members WHERE badge = ?').run(b);
  if (teamId != null && teamId !== '') {
    if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(Number(teamId))) throw Object.assign(new Error('no such team'), { status: 404 });
    db.prepare('INSERT INTO team_members (team_id, badge) VALUES (?, ?)').run(Number(teamId), b);
  }
  return listTeams();
}

/** What a named team can reach, for the assignment check. Null when unknown. */
export function teamReach(name) {
  const t = listTeams().find((x) => x.name === norm(name));
  if (!t || !t.members.length) return null;
  return { reach: t.reach, members: t.members.length, equipment: t.equipment };
}

/** Plain sentence for why a team cannot take levels, or null when they can. */
export function reachShortfall(teamName, levels) {
  const t = teamReach(teamName);
  if (!t) return null;
  const cfg = getConfig();
  const short = [...normLevels(levels)].filter((c) => !t.reach.includes(c));
  if (!short.length) return null;
  const needs = missingForLevels(short.join(''), t.equipment, cfg);
  const has = t.equipment.length ? t.equipment.map((e) => (cfg.equipment[e] || e).toLowerCase()).join(' and ') : 'no equipment';
  return {
    levels: short.join(', '),
    needs: needs || [],
    message: `Team ${norm(teamName)} cannot reach level${short.length > 1 ? 's' : ''} ${short.join(', ')}: ` +
      `that needs ${needs && needs.length ? 'a ' + needs.join(' and a ') : 'equipment they do not have'}, and between them they have ${has} (${levelsLabel(t.reach)}).`,
  };
}

/**
 * What the people signing on add up to: who they are, who is not on the roster,
 * what they can reach between them, and anyone rostered to a different team.
 * Used at sign-on so a crew shuffled at shift change is caught before counting.
 */
export function crewCheck(badges, teamName) {
  const cfg = getConfig();
  const crew = [];
  const unknown = [];
  const elsewhere = [];
  const equipment = new Set();
  for (const raw of badges || []) {
    const badge = norm(raw);
    if (!badge) continue;
    const e = getEmployee(badge);
    if (!e) { unknown.push(badge); continue; }
    crew.push({ badge: e.badge, name: e.name, dept: e.dept, equipment: e.equipment, reach: e.reach, team: e.team });
    for (const k of e.equipment) equipment.add(k);
    if (e.team && norm(e.team) !== norm(teamName)) elsewhere.push({ badge: e.badge, name: e.name, team: e.team });
  }
  return {
    crew,
    unknown,
    elsewhere,
    equipment: [...equipment],
    equipmentLabels: [...equipment].map((k) => cfg.equipment[k] || k),
    reach: crew.length ? reachOf([...equipment], cfg) : '',
  };
}

/** Levels the signed-on crew cannot reach, as a sentence for the gun. */
export function crewShortfall(check, levels) {
  if (!check.crew.length || !levels) return null;
  const cfg = getConfig();
  const short = [...normLevels(levels)].filter((c) => !check.reach.includes(c));
  if (!short.length) return null;
  const needs = missingForLevels(short.join(''), check.equipment, cfg);
  return {
    levels: short.join(', '),
    needs: needs || [],
    message: `Nobody signed on can reach level${short.length > 1 ? 's' : ''} ${short.join(', ')} — that needs ${needs && needs.length ? 'a ' + needs.join(' and a ') : 'equipment nobody here has'}.`,
  };
}
