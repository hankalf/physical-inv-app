import { db, norm, getSession } from '../db.js';

/*
 * One box that finds anything.
 *
 * A supervisor's question is rarely "open the pallet report". It is "where is
 * pallet F02-118", "who counted F01A005", "which team has aisle F04", "where do
 * I upload the bin list", "what did we say to team 3". Answering those meant
 * knowing which of four pages and twenty cards holds the answer - which is fine
 * once you have used the app for a month, and hopeless on day one.
 *
 * So: type it, and the app looks everywhere it could sensibly mean. Each hit
 * carries enough to answer the question on the spot - a pallet's expected and
 * counted quantity, the team that counted a bin - rather than only a link to a
 * page where the answer might be. Where a hit does have a home, it carries
 * where to go, and the page takes you there.
 *
 * Scoped to the count picked in the header for anything that belongs to a count
 * (pallets, bins, lines, second counts, adjustments, messages); site-wide for
 * the things that outlive one (people, scanners, counts themselves).
 */

const LIMIT = 8;
/* SQLite LIKE treats % and _ as wildcards, so a supervisor typing a bin code
   with an underscore in it would otherwise get every bin. */
const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
const esc = " ESCAPE '\\'";

const some = (rows, kind, map) => (rows.length ? { kind, rows: rows.map(map) } : null);

export function searchAll(sessionId, rawQ) {
  const q = String(rawQ == null ? '' : rawQ).trim();
  if (q.length < 2) return { q, groups: [], tooShort: true };
  const id = Number(sessionId) || 0;
  const session = id ? getSession(id) : null;
  const L = like(q);
  const U = norm(q);
  const groups = [];
  const add = (g) => { if (g) groups.push(g); };

  /* ---------------- pallets: the report's, and any counted that were not on it */
  if (session) {
    const pallets = db.prepare(
      `SELECT p.pallet_id, p.sku, p.description, p.uom, p.expected_qty, p.expected_location, p.lot, p.abc,
              (SELECT SUM(c.qty) FROM counts c
                WHERE c.session_id = p.session_id AND c.pallet_id = p.pallet_id AND c.voided = 0) AS counted_qty,
              (SELECT GROUP_CONCAT(DISTINCT c.location_code) FROM counts c
                WHERE c.session_id = p.session_id AND c.pallet_id = p.pallet_id AND c.voided = 0) AS found_in,
              (SELECT GROUP_CONCAT(DISTINCT c.team) FROM counts c
                WHERE c.session_id = p.session_id AND c.pallet_id = p.pallet_id AND c.voided = 0) AS teams
         FROM pallets p
        WHERE p.session_id = ?
          AND (p.pallet_id LIKE ?${esc} OR p.sku LIKE ?${esc} OR p.description LIKE ?${esc})
        ORDER BY (p.pallet_id = ?) DESC, p.pallet_id LIMIT ?`
    ).all(id, L, L, L, U, LIMIT);

    add(some(pallets, 'Pallets', (p) => ({
      title: p.pallet_id,
      detail: [
        [p.sku, p.description].filter(Boolean).join(' — '),
        p.expected_qty == null ? '' : `report: ${p.expected_qty}${p.uom ? ' ' + p.uom : ''} in ${p.expected_location || 'no bin'}`,
        p.counted_qty == null ? 'not counted yet' : `counted: ${p.counted_qty} in ${p.found_in}${p.teams ? ' by team ' + p.teams : ''}`,
        p.lot ? `lot ${p.lot}` : '',
        p.abc ? `class ${p.abc}` : '',
      ].filter(Boolean).join(' · '),
      goto: { page: '/admin', sub: 'reports' },
    })));

    /* Counted but never on the report - the pallets a supervisor is most often
       hunting for, and the ones a search of the report alone would miss. */
    const strays = db.prepare(
      `SELECT c.pallet_id, c.location_code, c.qty, c.team, c.scanned_at, c.label_issue
         FROM counts c
        WHERE c.session_id = ? AND c.voided = 0 AND c.empty_bin = 0
          AND c.pallet_id LIKE ?${esc}
          AND NOT EXISTS (SELECT 1 FROM pallets p WHERE p.session_id = c.session_id AND p.pallet_id = c.pallet_id)
        GROUP BY c.pallet_id ORDER BY c.pallet_id LIMIT ?`
    ).all(id, L, LIMIT);
    add(some(strays, 'Counted, not on the report', (c) => ({
      title: c.pallet_id,
      detail: `${c.qty} in ${c.location_code} · team ${c.team}${c.label_issue ? ' · label problem' : ''} · ${c.scanned_at.slice(0, 16).replace('T', ' ')}`,
      goto: { page: '/admin', sub: 'reports' },
    })));

    /* ---------------- bins ---------------- */
    const bins = db.prepare(
      `SELECT l.code, l.zone, l.aisle, l.level, l.description, l.last_counted,
              (SELECT COUNT(*) FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0) AS lines,
              (SELECT GROUP_CONCAT(DISTINCT c.team) FROM counts c WHERE c.session_id = l.session_id AND c.location_code = l.code AND c.voided = 0) AS teams
         FROM locations l
        WHERE l.session_id = ?
          AND (l.code LIKE ?${esc} OR l.description LIKE ?${esc})
        ORDER BY (l.code = ?) DESC, l.code LIMIT ?`
    ).all(id, L, L, U, LIMIT);
    add(some(bins, 'Bins', (b) => ({
      title: b.code,
      detail: [
        [b.zone, b.aisle && `aisle ${b.aisle}`, b.level && `level ${b.level}`].filter(Boolean).join(' · '),
        b.lines ? `${b.lines} line(s) counted${b.teams ? ' by team ' + b.teams : ''}` : 'no count yet',
        b.description || '',
      ].filter(Boolean).join(' · '),
      goto: { page: '/admin', sub: 'map' },
    })));

    /* ---------------- lots ---------------- */
    const lots = db.prepare(
      `SELECT lot, COUNT(*) AS lines, SUM(qty) AS qty, GROUP_CONCAT(DISTINCT location_code) AS bins
         FROM counts WHERE session_id = ? AND voided = 0 AND lot IS NOT NULL AND lot != '' AND lot LIKE ?${esc}
        GROUP BY lot ORDER BY lot LIMIT ?`
    ).all(id, L, LIMIT);
    add(some(lots, 'Lots', (r) => ({
      title: r.lot,
      detail: `${r.lines} line(s), ${r.qty} counted · ${String(r.bins).split(',').slice(0, 6).join(', ')}`,
      goto: { page: '/admin', sub: 'reports', focus: 'fLotSearch', value: r.lot, press: 'btnFindLot' },
    })));

    /* ---------------- aisles, and who is in them ---------------- */
    const aisles = db.prepare(
      `SELECT a.aisle, a.block,
              (SELECT COUNT(*) FROM locations l WHERE l.session_id = a.session_id AND l.aisle = a.aisle) AS bins,
              (SELECT GROUP_CONCAT(s.team || ' (' || s.status || ')') FROM assignments s
                WHERE s.session_id = a.session_id AND s.aisle = a.aisle AND s.status != 'done') AS teams
         FROM aisles a
        WHERE a.session_id = ? AND (a.aisle LIKE ?${esc} OR a.block LIKE ?${esc})
        ORDER BY (a.aisle = ?) DESC, a.aisle LIMIT ?`
    ).all(id, L, L, U, LIMIT);
    add(some(aisles, 'Aisles', (a) => ({
      title: a.aisle,
      detail: [`racking block ${a.block}`, `${a.bins} bins`, a.teams ? `team ${a.teams}` : 'nobody on it'].join(' · '),
      goto: { page: '/admin', sub: 'teams' },
    })));

    /* ---------------- second counts ---------------- */
    const recounts = db.prepare(
      `SELECT id, bin, pallet_id, reason, status, team, first_team FROM recounts
        WHERE session_id = ? AND (bin LIKE ?${esc} OR pallet_id LIKE ?${esc} OR reason LIKE ?${esc})
        ORDER BY status = 'done', id DESC LIMIT ?`
    ).all(id, L, L, L, LIMIT);
    add(some(recounts, 'Second counts', (r) => ({
      title: `${r.bin}${r.pallet_id ? ' · ' + r.pallet_id : ''}`,
      detail: `${r.reason} · ${r.status}${r.team ? ' · team ' + r.team : ''}`,
      goto: { page: '/admin', sub: 'second' },
    })));

    /* ---------------- adjustments waiting to be signed ---------------- */
    const adjustments = db.prepare(
      `SELECT pallet_id, sku, location, variance_qty, status, reason, decided_by FROM adjustments
        WHERE session_id = ? AND (pallet_id LIKE ?${esc} OR sku LIKE ?${esc} OR location LIKE ?${esc} OR reason LIKE ?${esc})
        ORDER BY status = 'auto', ABS(variance_qty) DESC LIMIT ?`
    ).all(id, L, L, L, L, LIMIT);
    add(some(adjustments, 'Adjustments', (a) => ({
      title: `${a.pallet_id} ${a.variance_qty > 0 ? '+' : ''}${a.variance_qty}`,
      detail: [a.sku, a.location, a.status, a.reason, a.decided_by && `signed by ${a.decided_by}`].filter(Boolean).join(' · '),
      goto: { page: '/admin', sub: 'adjust' },
    })));

    /* ---------------- what the office said to the floor ---------------- */
    const messages = db.prepare(
      `SELECT id, team, body, sent_by, created_at, cleared_at FROM messages
        WHERE session_id = ? AND body LIKE ?${esc} ORDER BY id DESC LIMIT ?`
    ).all(id, L, LIMIT);
    add(some(messages, 'Messages to the floor', (m) => ({
      title: m.body,
      detail: `${m.team ? 'team ' + m.team : 'every team'} · ${m.sent_by} · ${m.created_at.slice(0, 16).replace('T', ' ')}${m.cleared_at ? ' · taken down' : ''}`,
      goto: { page: '/admin', sub: 'teams' },
    })));
  }

  /* ---------------- things that outlive one count ---------------- */
  const people = db.prepare(
    `SELECT e.badge, e.name, e.dept, e.equipment, e.active,
            (SELECT GROUP_CONCAT(t.name) FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.badge = e.badge) AS teams
       FROM employees e WHERE e.badge LIKE ?${esc} OR e.name LIKE ?${esc} OR e.dept LIKE ?${esc}
      ORDER BY e.name LIMIT ?`
  ).all(L, L, L, LIMIT);
  add(some(people, 'Crew', (p) => {
    let kit = [];
    try { kit = JSON.parse(p.equipment || '[]'); } catch { kit = []; }
    return {
      title: `${p.name} · ${p.badge}`,
      detail: [p.dept, p.teams ? `team ${p.teams}` : 'no team today', kit.join(', '), p.active ? '' : 'inactive'].filter(Boolean).join(' · '),
      goto: { page: '/teams', sub: 'crew' },
    };
  }));

  const devices = db.prepare(
    `SELECT name, notes, last_team, last_seen, token_hash FROM devices
      WHERE name LIKE ?${esc} OR notes LIKE ?${esc} ORDER BY name LIMIT ?`
  ).all(L, L, LIMIT);
  add(some(devices, 'Scanners', (d) => ({
    title: d.name,
    detail: [d.notes, d.last_team ? `last team ${d.last_team}` : '', d.last_seen ? `seen ${d.last_seen.slice(0, 16).replace('T', ' ')}` : 'never used',
      d.token_hash ? '' : 'not signed in'].filter(Boolean).join(' · '),
    goto: { page: '/settings', sub: 'scanners' },
  })));

  const sessions = db.prepare(
    `SELECT id, name, mode, status, created_at FROM sessions
      WHERE name LIKE ?${esc} OR CAST(id AS TEXT) = ? ORDER BY id DESC LIMIT ?`
  ).all(L, q, LIMIT);
  add(some(sessions, 'Counts', (s) => ({
    title: `#${s.id} ${s.name}`,
    detail: `${s.mode === 'cycle' ? 'cycle count' : 'full count'} · ${s.status} · started ${s.created_at.slice(0, 10)}`,
    goto: { page: '/admin', sub: 'progress', session: s.id },
  })));

  const teams = db.prepare(
    `SELECT t.name, COUNT(m.badge) AS crew FROM teams t
       LEFT JOIN team_members m ON m.team_id = t.id
      WHERE t.name LIKE ?${esc} GROUP BY t.id ORDER BY t.name LIMIT ?`
  ).all(L, LIMIT);
  add(some(teams, 'Teams', (t) => ({
    title: `Team ${t.name}`,
    detail: `${t.crew} on the crew list`,
    goto: { page: '/teams', sub: 'teams' },
  })));

  /* ---------------- the log: who did what ---------------- */
  const log = db.prepare(
    `SELECT at, actor, action, detail FROM audit
      WHERE action LIKE ?${esc} OR detail LIKE ?${esc} OR actor LIKE ?${esc}
      ORDER BY id DESC LIMIT ?`
  ).all(L, L, L, LIMIT);
  add(some(log, 'In the log', (r) => ({
    title: `${r.actor} — ${r.action}`,
    detail: `${r.at.slice(0, 16).replace('T', ' ')}${r.detail ? ' · ' + String(r.detail).slice(0, 120) : ''}`,
    goto: { page: '/settings', sub: 'erp' },
  })));

  return { q, sessionId: id, groups, hits: groups.reduce((n, g) => n + g.rows.length, 0) };
}
