/*
 * The office's heavy reads, worked out once per change.
 *
 * The dashboard, the Reports tab and the office board all ask the same
 * questions - how far along is the count, what does the pallet report say -
 * every ten or twenty seconds, from every screen that is open. On a
 * twenty-thousand-bin count each answer is a tenth of a second or more of the
 * one thread the server has, so three screens asking the same thing between
 * two scans was three times the work for the same answer.
 *
 * Every request that can change something (anything but a GET) moves the
 * generation on when it finishes, and an answer is kept only for the
 * generation it was worked out in - so nobody ever sees a figure from before a
 * change they made. Work done on a timer rather than a request (the
 * stopped-scanning alert, the cycle batches) is caught by the answer also
 * going stale after a few seconds whatever happens.
 */

let generation = 0;
const MAX_AGE_MS = 5000;
const MAX_ENTRIES = 64;
const kept = new Map();   // key -> { gen, at, day, value }

/** Something may have changed: every kept answer is now out of date. */
export function changed() { generation++; }

export const currentGeneration = () => generation;

/** The answer for `key`, worked out by `fn` only when the one kept is out of date. */
export function memo(key, fn) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);   // "expires soon" moves with the date
  const hit = kept.get(key);
  if (hit && hit.gen === generation && hit.day === day && now - hit.at < MAX_AGE_MS) return hit.value;
  const gen = generation;
  const value = fn();
  kept.delete(key);
  kept.set(key, { gen, at: now, day, value });
  if (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value);
  return value;
}

export function forget() { kept.clear(); }
