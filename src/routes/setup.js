import { db } from '../db.js';

/*
 * What a count still needs before anyone can scan.
 *
 * Worked out from the database rather than from a checkbox somebody ticked, so
 * it cannot drift: every step reports what is actually there. A full count and
 * a cycle count need different things, so they get different lists.
 */

const one = (sql, ...args) => db.prepare(sql).get(...args);

export function setupState(sessionId) {
  const id = Number(sessionId);
  const s = one('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) return null;
  const cycle = (s.mode || 'full') === 'cycle';

  const bins = one('SELECT COUNT(*) n FROM locations WHERE session_id = ?', id).n;
  // the aisles table, not distinct location.aisle: areas like DOORS and WIP hold
  // bins but are not aisles, and every other screen counts them the same way
  const aisles = one('SELECT COUNT(*) n FROM aisles WHERE session_id = ?', id).n;
  const pallets = one('SELECT COUNT(*) n FROM pallets WHERE session_id = ?', id).n;
  const dated = one("SELECT COUNT(*) n FROM locations WHERE session_id = ? AND COALESCE(last_counted,'') != ''", id).n;
  const blocked = one(
    `SELECT COUNT(*) n FROM (SELECT block FROM aisles WHERE session_id = ?
       GROUP BY block HAVING COUNT(*) > 1)`, id).n;
  const assigned = one('SELECT COUNT(*) n FROM assignments WHERE session_id = ?', id).n;
  const teams = one('SELECT COUNT(*) n FROM teams').n;
  const crew = one('SELECT COUNT(*) n FROM employees').n;
  const scanners = one('SELECT COUNT(*) n FROM devices').n;
  const enrolled = one("SELECT COUNT(*) n FROM devices WHERE COALESCE(enrolled_at,'') != ''").n;
  const batches = cycle ? one('SELECT COUNT(*) n FROM cycle_batches WHERE session_id = ?', id).n : 0;
  const counted = one('SELECT COUNT(DISTINCT location_code) n FROM counts WHERE session_id = ? AND voided = 0', id).n;

  /* need: 'required' blocks counting, 'wanted' is strongly recommended and
     explains what you lose without it, 'optional' is a nicety. */
  const steps = [
    {
      key: 'bins', need: 'required', done: bins > 0,
      title: 'Upload the bin list',
      why: 'Every location in the warehouse. It is what a scanned bin is checked against, and it defines the aisles teams get assigned to.',
      detail: bins ? `${bins.toLocaleString()} bins in ${aisles} aisles` : 'nothing uploaded yet',
      goto: { page: '/settings', sub: 'lists' }, label: 'Upload it',
    },
    {
      key: 'pallets',
      need: cycle ? 'required' : 'wanted',
      done: pallets > 0,
      title: 'Upload the inventory report',
      why: cycle
        ? 'What the system thinks is on hand, and when each bin was last counted — which is what picks the bins for each batch.'
        : 'What the system thinks is on hand. Without it a count still records what is there, but nothing is compared, so there are no variances and no second counts.',
      detail: pallets
        ? `${pallets.toLocaleString()} pallets${dated ? ` · ${dated.toLocaleString()} bins carry a last-counted date` : ''}`
        : 'nothing uploaded yet',
      goto: { page: '/settings', sub: 'lists' }, label: 'Upload it',
    },
    {
      key: 'scanners', need: 'required', done: scanners > 0,
      title: 'Register the scanners',
      why: 'Each handheld gets its own link. The server only takes counts from a scanner that has signed in with one.',
      detail: scanners
        ? `${scanners} registered · ${enrolled} signed in`
        : 'none registered yet',
      goto: { page: '/settings', sub: 'scanners' }, label: 'Add scanners',
    },
  ];

  if (!cycle) {
    steps.push(
      {
        key: 'layout', need: 'optional', done: !!s.layout,
        title: 'Pick the rack drawing',
        why: 'Draws progress over the real floor plan instead of a schematic.',
        detail: s.layout ? `using ${s.layout}` : 'on the schematic',
        goto: { page: '/admin', sub: 'progress' }, label: 'Choose one',
      },
      {
        key: 'blocks', need: 'wanted', done: blocked > 0,
        title: 'Pair the aisles that share racking',
        why: 'Two teams either side of the same rack get in each other’s way. Pairing them keeps only one team in a block at a time.',
        detail: blocked ? `${blocked} block(s) of more than one aisle` : 'every aisle is its own block',
        goto: { page: '/settings', sub: 'lists' }, label: 'Pair them',
      },
      {
        key: 'crew', need: 'optional', done: crew > 0 && teams > 0,
        title: 'Add the crew and the teams',
        why: 'Lets the app check a team has the equipment for the levels it is given, and check who signed on.',
        detail: crew || teams ? `${crew} on the crew list · ${teams} team(s)` : 'no crew list yet',
        goto: { page: '/teams', sub: 'crew' }, label: 'Set them up',
      },
      {
        key: 'plan', need: 'required', done: assigned > 0,
        title: 'Queue the aisles onto teams',
        why: 'A guided count sends each team to its next aisle. Without a plan the scanners have nothing to hand out.',
        detail: assigned ? `${assigned} aisle assignment(s)` : 'nothing queued yet',
        goto: { page: '/admin', sub: 'teams' }, label: 'Queue them',
      },
    );
  } else {
    steps.push({
      key: 'batch', need: 'required', done: batches > 0,
      title: 'Generate the first batch',
      why: 'Picks the bins to count today, oldest first. The scanners hand them out at sign-on.',
      detail: batches ? `${batches} batch(es) generated` : 'none generated yet',
      goto: { page: '/cycle', sub: 'today' }, label: 'Generate one',
    });
  }

  const blocking = steps.filter((x) => x.need === 'required' && !x.done);
  return {
    session: { id: s.id, name: s.name, mode: cycle ? 'cycle' : 'full', status: s.status },
    steps,
    counted,
    started: counted > 0,
    ready: blocking.length === 0,
    blocking: blocking.map((x) => x.key),
    done: steps.filter((x) => x.done).length,
    total: steps.length,
  };
}
