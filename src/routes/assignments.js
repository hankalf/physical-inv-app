import { db, norm } from '../db.js';

/*
 * Guided counting.
 *
 * Aisles are assigned to teams. Racking that backs onto itself is grouped into a
 * "block": aisles 3 and 4 sharing racking belong to one block, and only one team
 * may be active in a block at a time. A team's next aisle therefore waits until
 * the block it belongs to is clear, which is what staggers the teams apart.
 */

const now = () => new Date().toISOString();

export function aisleOverview(sessionId) {
  const id = Number(sessionId);
  return db
    .prepare(
      `SELECT a.aisle,
              a.block,
              (SELECT COUNT(*) FROM locations l WHERE l.session_id = a.session_id AND l.aisle = a.aisle) AS bins,
              (SELECT COUNT(DISTINCT c.location_code)
                 FROM counts c JOIN locations l
                   ON l.session_id = c.session_id AND l.code = c.location_code
                WHERE c.session_id = a.session_id AND c.voided = 0 AND l.aisle = a.aisle) AS bins_counted,
              (SELECT COUNT(*) FROM counts c JOIN locations l
                   ON l.session_id = c.session_id AND l.code = c.location_code
                WHERE c.session_id = a.session_id AND c.voided = 0 AND l.aisle = a.aisle) AS pallets_counted,
              (SELECT team FROM assignments s
                WHERE s.session_id = a.session_id AND s.aisle = a.aisle AND s.status = 'active') AS active_team,
              (SELECT GROUP_CONCAT(team, ', ') FROM assignments s
                WHERE s.session_id = a.session_id AND s.aisle = a.aisle AND s.status = 'queued') AS queued_teams,
              (SELECT COUNT(*) FROM assignments s
                WHERE s.session_id = a.session_id AND s.aisle = a.aisle AND s.status = 'done') AS done_count
         FROM aisles a
        WHERE a.session_id = ?
        ORDER BY a.block, a.aisle`
    )
    .all(id);
}

export const listAssignments = (sessionId) =>
  db
    .prepare(
      `SELECT s.*, a.block
         FROM assignments s
         LEFT JOIN aisles a ON a.session_id = s.session_id AND a.aisle = s.aisle
        WHERE s.session_id = ?
        ORDER BY s.team, s.position, s.id`
    )
    .all(Number(sessionId));

export const blockOf = (sessionId, aisle) =>
  db.prepare('SELECT block FROM aisles WHERE session_id = ? AND aisle = ?').get(Number(sessionId), norm(aisle))
    ?.block ?? norm(aisle);

// Which team, if any, currently holds the block this aisle belongs to.
export function blockHolder(sessionId, aisle, exceptTeam) {
  const block = blockOf(sessionId, aisle);
  const rows = db
    .prepare(
      `SELECT s.team, s.aisle
         FROM assignments s
         LEFT JOIN aisles a ON a.session_id = s.session_id AND a.aisle = s.aisle
        WHERE s.session_id = ? AND s.status = 'active'
          AND COALESCE(a.block, s.aisle) = ?`
    )
    .all(Number(sessionId), block);
  return rows.find((r) => r.team !== norm(exceptTeam)) || null;
}

export function setBlock(sessionId, aisle, block) {
  db.prepare(
    `INSERT INTO aisles (session_id, aisle, block) VALUES (?, ?, ?)
     ON CONFLICT(session_id, aisle) DO UPDATE SET block = excluded.block`
  ).run(Number(sessionId), norm(aisle), norm(block) || norm(aisle));
}

/**
 * Pair aisles into blocks in sorted order: A01+A02, A03+A04, ...
 * `size` is how many adjacent aisles share racking (2 for back-to-back).
 * `offset` shifts where the pairing starts, for a warehouse whose first aisle
 * has an outside wall behind it.
 */
export function autoBlock(sessionId, size = 2, offset = 0) {
  const id = Number(sessionId);
  const aisles = db
    .prepare('SELECT aisle FROM aisles WHERE session_id = ? ORDER BY aisle').all(id).map((r) => r.aisle);
  const n = Math.max(1, Number(size) || 2);
  const off = Number(offset) || 0;

  const groups = new Map();
  aisles.forEach((aisle, i) => {
    const g = Math.floor((i + off) / n);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(aisle);
  });

  db.exec('BEGIN');
  try {
    for (const members of groups.values()) {
      const label = members.length > 1 ? `${members[0]}+${members[members.length - 1]}` : members[0];
      for (const aisle of members) {
        db.prepare('UPDATE aisles SET block = ? WHERE session_id = ? AND aisle = ?').run(label, id, aisle);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return aisleOverview(id);
}

export function queueAssignments(sessionId, team, aisles) {
  const id = Number(sessionId);
  const t = norm(team);
  if (!t) throw Object.assign(new Error('team required'), { status: 400 });
  const maxPos = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM assignments WHERE session_id = ? AND team = ?')
    .get(id, t).p;
  let pos = maxPos;
  const added = [];
  const skipped = [];
  db.exec('BEGIN');
  try {
    for (const raw of aisles) {
      const aisle = norm(raw);
      if (!aisle) continue;
      const known = db.prepare('SELECT 1 FROM aisles WHERE session_id = ? AND aisle = ?').get(id, aisle);
      if (!known) { skipped.push({ aisle, reason: 'no such aisle in this session' }); continue; }
      const existing = db
        .prepare('SELECT status FROM assignments WHERE session_id = ? AND team = ? AND aisle = ?')
        .get(id, t, aisle);
      if (existing) { skipped.push({ aisle, reason: `already ${existing.status} for team ${t}` }); continue; }
      pos += 1;
      db.prepare(
        `INSERT INTO assignments (session_id, team, aisle, position, status, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`
      ).run(id, t, aisle, pos, now());
      added.push(aisle);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const activated = autoActivate(id);
  return { added, skipped, activated };
}

/**
 * Give every team without an active aisle its next queued aisle, as long as that
 * aisle's block is free. Called after any change so the board self-heals.
 */
export function autoActivate(sessionId) {
  const id = Number(sessionId);
  const teams = db
    .prepare("SELECT DISTINCT team FROM assignments WHERE session_id = ? AND status = 'queued'")
    .all(id).map((r) => r.team);
  const activated = [];
  for (const team of teams) {
    const busy = db
      .prepare("SELECT 1 FROM assignments WHERE session_id = ? AND team = ? AND status = 'active'")
      .get(id, team);
    if (busy) continue;
    const next = db
      .prepare(
        `SELECT * FROM assignments
          WHERE session_id = ? AND team = ? AND status = 'queued'
          ORDER BY position, id LIMIT 1`
      )
      .get(id, team);
    if (!next) continue;
    if (blockHolder(id, next.aisle, team)) continue; // another team holds the racking
    db.prepare("UPDATE assignments SET status = 'active', started_at = ? WHERE id = ?").run(now(), next.id);
    activated.push({ team, aisle: next.aisle });
  }
  return activated;
}

export function setAssignmentStatus(sessionId, assignmentId, status) {
  const id = Number(sessionId);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ? AND session_id = ?').get(Number(assignmentId), id);
  if (!row) throw Object.assign(new Error('assignment not found'), { status: 404 });

  if (status === 'done') {
    db.prepare("UPDATE assignments SET status = 'done', completed_at = ? WHERE id = ?").run(now(), row.id);
  } else if (status === 'queued') {
    db.prepare("UPDATE assignments SET status = 'queued', started_at = NULL WHERE id = ?").run(row.id);
  } else if (status === 'active') {
    const holder = blockHolder(id, row.aisle, row.team);
    if (holder) {
      throw Object.assign(
        new Error(`Aisle ${row.aisle} shares racking with aisle ${holder.aisle}, which team ${holder.team} is counting`),
        { status: 409 }
      );
    }
    db.prepare("UPDATE assignments SET status = 'active', started_at = ? WHERE id = ?").run(now(), row.id);
  } else {
    throw Object.assign(new Error('unknown status'), { status: 400 });
  }
  const activated = autoActivate(id);
  return { assignment: db.prepare('SELECT * FROM assignments WHERE id = ?').get(row.id), activated };
}

export function deleteAssignment(sessionId, assignmentId) {
  db.prepare('DELETE FROM assignments WHERE id = ? AND session_id = ?').run(Number(assignmentId), Number(sessionId));
  return { activated: autoActivate(Number(sessionId)) };
}

/** What a handheld shows after sign-on: this team's current aisle and queue. */
export function teamStatus(sessionId, team) {
  const id = Number(sessionId);
  const t = norm(team);
  autoActivate(id);

  const active = db
    .prepare("SELECT * FROM assignments WHERE session_id = ? AND team = ? AND status = 'active' LIMIT 1")
    .get(id, t);
  const queued = db
    .prepare("SELECT * FROM assignments WHERE session_id = ? AND team = ? AND status = 'queued' ORDER BY position, id")
    .all(id, t);
  const done = db
    .prepare("SELECT aisle FROM assignments WHERE session_id = ? AND team = ? AND status = 'done' ORDER BY completed_at")
    .all(id, t).map((r) => r.aisle);

  let bins = [];
  let progress = null;
  if (active) {
    bins = db
      .prepare('SELECT code FROM locations WHERE session_id = ? AND aisle = ? ORDER BY code')
      .all(id, active.aisle).map((r) => r.code);
    // Which bins already have a count, from any scanner, so a second device on
    // the same team sees the same picture.
    const countedBins = db
      .prepare(
        `SELECT DISTINCT c.location_code AS code
           FROM counts c JOIN locations l ON l.session_id = c.session_id AND l.code = c.location_code
          WHERE c.session_id = ? AND c.voided = 0 AND l.aisle = ?`
      )
      .all(id, active.aisle).map((r) => r.code);
    progress = { bins: bins.length, counted: countedBins.length, countedBins };
  }

  // If nothing is active, say who the team is waiting on rather than just "none".
  let waitingOn = null;
  if (!active && queued.length) {
    const holder = blockHolder(id, queued[0].aisle, t);
    waitingOn = holder
      ? { aisle: queued[0].aisle, blockedByTeam: holder.team, blockedByAisle: holder.aisle }
      : { aisle: queued[0].aisle, blockedByTeam: null, blockedByAisle: null };
  }

  return {
    team: t,
    active: active ? { id: active.id, aisle: active.aisle, startedAt: active.started_at } : null,
    bins,
    progress,
    queued: queued.map((q) => q.aisle),
    done,
    waitingOn,
  };
}
