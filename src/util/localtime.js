// The warehouse's clock, not the server's. Railway runs in UTC, so a batch
// generated at 9pm in Front Royal would otherwise be dated tomorrow and a
// schedule set for 6am would fire at 1am.
const TZ = process.env.SITE_TIMEZONE || process.env.TZ || 'America/New_York';

export const siteTimezone = () => TZ;

function parts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const out = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Today at the site, as YYYY-MM-DD. */
export function localDate(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hour of the day at the site, 0-23. */
export function localHour(date = new Date()) {
  const h = Number(parts(date).hour);
  return h === 24 ? 0 : h;   // some locales render midnight as 24
}

/** Minutes since midnight at the site, 0-1439: for a shift that starts at 6:30. */
export function localMinutes(date = new Date()) {
  const p = parts(date);
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

/** The time of day at the site, as a wall clock says it: "5:40 PM". */
export function localTime(date = new Date()) {
  const p = parts(date);
  const h = Number(p.hour) % 24;
  return `${h % 12 || 12}:${p.minute} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Day of the week at the site, 0 = Sunday. */
export function localWeekday(date = new Date()) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts(date).weekday);
}

/**
 * The other way: a day at the site and minutes past its midnight, as a
 * timestamp. Two passes, so a day the clocks change still lands right.
 */
export function localToMs(dateStr, minutesPastMidnight = 0) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  let guess = Date.UTC(y, mo - 1, d, 0, 0) + minutesPastMidnight * 60000;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess));
    const got = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
    const want = Date.UTC(y, mo - 1, d, 0, 0) + minutesPastMidnight * 60000;
    guess += want - got;
  }
  return guess;
}

/** The site's date `days` days after a given one: "2026-11-06" + 1 -> "2026-11-07". */
export function addDays(dateStr, days) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
