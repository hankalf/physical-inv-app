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
};

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
    const t = norm(part).replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const key = known[t] ? t : ALIASES[t] || ALIASES[t.replace(/ /g, '')] || null;
    if (key && known[key]) out.add(key);
  }
  return [...out];
}

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

/** Why a level is out of reach: the cheapest rule to satisfy, and what is missing. */
export function missingFor(level, equipmentList, cfg = getConfig()) {
  const have = new Set((equipmentList || []).map(norm));
  const options = cfg.levelRules
    .filter((r) => r.levels.includes(norm(level)))
    .map((r) => r.requires.filter((e) => !have.has(norm(e))));
  if (!options.length) return null;
  options.sort((a, b) => a.length - b.length);
  return options[0].map((e) => (cfg.equipment[e] || e).toLowerCase());
}

/* ------------------------------------------------------------- employees */

const shape = (r) => ({
  badge: r.badge, name: r.name, dept: r.dept || '',
  equipment: JSON.parse(r.equipment || '[]'),
  reach: reachOf(JSON.parse(r.equipment || '[]')),
  active: !!r.active, team: r.team || null,
});

export function listEmployees() {
  return db
    .prepare(
      `SELECT e.*, (SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.badge = e.badge) AS team
         FROM employees e ORDER BY e.name, e.badge`
    )
    .all().map(shape);
}

export function upsertEmployee({ badge, name, dept, equipment, active = 1 }) {
  const b = norm(badge);
  if (!b) throw Object.assign(new Error('badge required'), { status: 400 });
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
  return getEmployee(b);
}

export const getEmployee = (badge) => {
  const r = db.prepare('SELECT * FROM employees WHERE badge = ?').get(norm(badge));
  return r ? shape({ ...r, team: db.prepare('SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.badge = ?').get(norm(badge))?.name }) : null;
};

export function deleteEmployee(badge) {
  db.prepare('DELETE FROM team_members WHERE badge = ?').run(norm(badge));
  return db.prepare('DELETE FROM employees WHERE badge = ?').run(norm(badge)).changes;
}

/** Import a roster CSV: badge, name, department, equipment. */
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
      const badge = norm(pick(rec, ['badge', 'badgeid', 'employeeid', 'empid', 'id', 'employeenumber', 'employeeno', 'number']));
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

export function listTeams() {
  const teams = db.prepare('SELECT * FROM teams ORDER BY name').all();
  const members = db
    .prepare('SELECT m.team_id, e.* FROM team_members m JOIN employees e ON e.badge = m.badge ORDER BY e.name')
    .all();
  return teams.map((t) => {
    const mine = members.filter((m) => m.team_id === t.id).map(shape);
    const equip = new Set();
    for (const m of mine) for (const e of m.equipment) equip.add(e);
    return {
      id: t.id, name: t.name, notes: t.notes || '',
      members: mine,
      equipment: [...equip],
      reach: mine.length ? reachOf([...equip]) : '',
      reachLabel: mine.length ? levelsLabel(reachOf([...equip])) : 'nobody assigned',
    };
  });
}

export function createTeam({ name, notes }) {
  const n = norm(name);
  if (!n) throw Object.assign(new Error('team name required'), { status: 400 });
  if (db.prepare('SELECT 1 FROM teams WHERE name = ?').get(n)) throw Object.assign(new Error(`team ${n} already exists`), { status: 409 });
  db.prepare('INSERT INTO teams (name, notes, created_at) VALUES (?, ?, ?)').run(n, String(notes || ''), new Date().toISOString());
  return listTeams().find((t) => t.name === n);
}

export function deleteTeam(id) {
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(Number(id));
  return db.prepare('DELETE FROM teams WHERE id = ?').run(Number(id)).changes;
}

/** Move an employee onto a team, or off every team when teamId is null. */
export function assignMember(badge, teamId) {
  const b = norm(badge);
  if (!db.prepare('SELECT 1 FROM employees WHERE badge = ?').get(b)) throw Object.assign(new Error(`no employee with badge ${b}`), { status: 404 });
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
  const needs = new Set();
  for (const c of short) for (const e of missingFor(c, t.equipment, cfg) || []) needs.add(e);
  const has = t.equipment.length ? t.equipment.map((e) => (cfg.equipment[e] || e).toLowerCase()).join(' and ') : 'no equipment';
  return {
    levels: short.join(', '),
    needs: [...needs],
    message: `Team ${norm(teamName)} cannot reach level${short.length > 1 ? 's' : ''} ${short.join(', ')}: ` +
      `that needs ${[...needs].join(' and ') || 'equipment they do not have'}, and between them they have ${has} (${levelsLabel(t.reach)}).`,
  };
}
