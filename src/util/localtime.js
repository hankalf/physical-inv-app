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
