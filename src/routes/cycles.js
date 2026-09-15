import { db, norm, getSession } from '../db.js';
import { localDate, localHour, localWeekday, siteTimezone } from '../util/localtime.js';

/*
 * Cycle counting.
 *
 * A cycle-count session is long-lived: the manager re-uploads the inventory
 * report whenever they want fresh expected quantities, then generates a batch -
 * "40 bins today" - and the teams work it. Each bin in a batch becomes a task,
 * the same kind of task a second count uses, so the gun, the offline queue and
 * the variance handling are shared.
 *
 * Bins are picked by how long they have gone without a count. That date is
 * seeded from the ERP's "Last Phys. Invt. Date" column and moves forward as
 * lines land, so a batch never re-picks what was counted yesterday.
 */

const now = () => new Date().toISOString();
const today = () => localDate();      // the warehouse's date, not the server's

export const STRATEGIES = {
  oldest: 'Longest since it was counted',
  never: 'Never counted',
  random: 'Random sample',
};

/** Bins eligible for a batch, in the order the strategy wants them. */
function candidates(sessionId, { strategy = 'oldest', zone = '', aisle = '', levels = '' } = {}) {
  const id = Number(sessionId);
  const where = ['l.session_id = ?'];
  const args = [id];
  if (zone) { where.push('UPPER(COALESCE(l.zone, \'\')) = ?'); args.push(norm(zone)); }
  if (aisle) {
    const list = String(aisle).split(/[,\s]+/).map(norm).filter(Boolean);
    if (list.length) { where.push(`l.aisle IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (levels) {
    const list = [...norm(levels)].filter((c) => /[A-Z]/.test(c));
    if (list.length) { where.push(`COALESCE(l.level, '') IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  // never pick a bin that already has an open task
  where.push("NOT EXISTS (SELECT 1 FROM recounts r WHERE r.session_id = l.session_id AND r.bin = l.code AND r.status != 'done')");
  if (strategy === 'never') where.push('l.last_counted IS NULL');

  const order = strategy === 'random' ? 'RANDOM()'
    : strategy === 'never' ? 'l.code'
    : 'l.last_counted IS NOT NULL, l.last_counted, l.code';   // nulls first, then oldest

  return { sql: `SELECT l.code, l.aisle, l.level, l.last_counted FROM locations l WHERE ${where.join(' AND ')} ORDER BY ${order}`, args };
}

export function previewBatch(sessionId, opts) {
  const { sql, args } = candidates(sessionId, opts);
  const target = Math.max(1, Number(opts.target) || 40);
  const rows = db.prepare(sql).all(...args);
  return { available: rows.length, picked: rows.slice(0, target) };
}

export function generateBatch(sessionId, opts = {}) {
  const id = Number(sessionId);
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
  if (s.status !== 'open') throw Object.assign(new Error('session is closed'), { status: 409 });

  const strategy = STRATEGIES[opts.strategy] ? opts.strategy : 'oldest';
  const target = Math.max(1, Math.min(5000, Number(opts.target) || 40));
  const due = String(opts.due || today()).slice(0, 10);
  const scope = { zone: opts.zone || '', aisle: opts.aisle || '', levels: opts.levels || '' };

  const { sql, args } = candidates(id, { ...scope, strategy });
  const picked = db.prepare(sql).all(...args).slice(0, target);
  if (!picked.length) throw Object.assign(new Error('no bins match that scope - they may all have open tasks already'), { status: 400 });

  const name = String(opts.name || '').trim() || `${due} · ${picked.length} bins`;
  const info = db
    .prepare(
      `INSERT INTO cycle_batches (session_id, name, due_date, target, strategy, scope, auto, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, name, due, target, strategy, JSON.stringify(scope), opts.auto ? 1 : 0, now());
  const batchId = info.lastInsertRowid;

  const ins = db.prepare(
    `INSERT INTO recounts (session_id, bin, reason, detail, source, team, batch_id, status, created_at)
     VALUES (?, ?, 'CYCLE', ?, 'cycle', ?, ?, 'open', ?)`
  );
  db.exec('BEGIN');
  try {
    for (const b of picked) {
      ins.run(id, b.code, b.last_counted ? `last counted ${b.last_counted.slice(0, 10)}` : 'never counted',
        opts.team ? norm(opts.team) : null, batchId, now());
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { batch: getBatch(id, batchId), created: picked.length };
}

export const getBatch = (sessionId, batchId) =>
  db.prepare(
    `SELECT b.*,
            (SELECT COUNT(*) FROM recounts r WHERE r.batch_id = b.id) AS bins,
            (SELECT COUNT(*) FROM recounts r WHERE r.batch_id = b.id AND r.status = 'done') AS done
       FROM cycle_batches b WHERE b.session_id = ? AND b.id = ?`
  ).get(Number(sessionId), Number(batchId));

export const listBatches = (sessionId) =>
  db.prepare(
    `SELECT b.*,
            (SELECT COUNT(*) FROM recounts r WHERE r.batch_id = b.id) AS bins,
            (SELECT COUNT(*) FROM recounts r WHERE r.batch_id = b.id AND r.status = 'done') AS done,
            (SELECT GROUP_CONCAT(DISTINCT r.done_by_team) FROM recounts r WHERE r.batch_id = b.id AND r.done_by_team IS NOT NULL) AS teams
       FROM cycle_batches b WHERE b.session_id = ? ORDER BY b.due_date DESC, b.id DESC`
  ).all(Number(sessionId));

export function deleteBatch(sessionId, batchId) {
  const id = Number(sessionId);
  db.prepare("DELETE FROM recounts WHERE session_id = ? AND batch_id = ? AND status != 'done'").run(id, Number(batchId));
  return db.prepare('DELETE FROM cycle_batches WHERE session_id = ? AND id = ?').run(id, Number(batchId)).changes;
}

/** How much of the warehouse has been counted lately, and what is still owed. */
export function coverage(sessionId, days = 90) {
  const id = Number(sessionId);
  const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS bins,
              SUM(CASE WHEN last_counted IS NOT NULL AND last_counted >= ? THEN 1 ELSE 0 END) AS recent,
              SUM(CASE WHEN last_counted IS NULL THEN 1 ELSE 0 END) AS never_counted,
              MIN(last_counted) AS oldest
         FROM locations WHERE session_id = ?`
    )
    .get(cutoff, id);
  const open = db.prepare("SELECT COUNT(*) n FROM recounts WHERE session_id = ? AND status != 'done'").get(id).n;
  return { days: Number(days), bins: row.bins, recent: row.recent || 0, never: row.never_counted || 0, oldest: row.oldest, openTasks: open };
}

/* ---------------------------------------------------------------- schedule */

/**
 * A session can generate its own batches: {every:'day'|'week', bins, strategy,
 * weekdays:[1-5], hour}. Checked on a timer; a batch is only ever created once
 * per due date, so a restart or a missed hour cannot double up.
 */
export function runSchedules() {
  const rows = db.prepare("SELECT * FROM sessions WHERE status = 'open' AND mode = 'cycle' AND cycle_schedule IS NOT NULL").all();
  const made = [];
  for (const s of rows) {
    let plan;
    try { plan = JSON.parse(s.cycle_schedule); } catch { continue; }
    if (!plan || !plan.every) continue;
    const weekday = localWeekday();                  // 0 Sun .. 6 Sat, at the site
    const hour = Number(plan.hour ?? 6);
    if (localHour() < hour) continue;
    if (plan.every === 'week') {
      const wanted = Number(plan.weekday ?? 1);
      if (weekday !== wanted) continue;
    } else if (Array.isArray(plan.weekdays) && plan.weekdays.length && !plan.weekdays.includes(weekday)) {
      continue;
    }
    const due = today();
    if (db.prepare('SELECT 1 FROM cycle_batches WHERE session_id = ? AND due_date = ? AND auto = 1').get(s.id, due)) continue;
    try {
      const r = generateBatch(s.id, { ...plan, target: plan.bins, due, auto: 1, name: `${due} · scheduled` });
      made.push({ session: s.id, bins: r.created });
      console.log(`[cycle] session ${s.id}: generated ${r.created} bins for ${due} (${siteTimezone()})`);
    } catch (err) {
      console.warn(`[cycle] session ${s.id}: ${err.message}`);
    }
  }
  return made;
}

/** Levels a team's open cycle bins sit on — what their equipment has to reach. */
export function levelsOnOpenTasks(sessionId, team) {
  const rows = db
    .prepare(
      `SELECT DISTINCT COALESCE(l.level, '') AS level
         FROM recounts r JOIN locations l ON l.session_id = r.session_id AND l.code = r.bin
        WHERE r.session_id = ? AND r.reason = 'CYCLE' AND r.status != 'done'
          AND (r.team IS NULL OR r.team = ?)`
    )
    .all(Number(sessionId), norm(team));
  return rows.map((r) => r.level).filter(Boolean).sort().join('');
}
