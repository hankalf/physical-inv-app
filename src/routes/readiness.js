/*
 * Ready for count day.
 *
 * The Count setup checklist says what one count still needs (its bin list,
 * its report). This is the site around it: the jobs the scanners offer, the
 * scanners themselves, the crew list, the alerts, the backups - the settings
 * that are set once and forgotten, and then found wrong at six in the morning
 * with forty people waiting. Worked out from what is there every time, never
 * from a box somebody ticked.
 *
 * Each check is ok, warn (works, but you would want to know) or fail (the
 * count will not go as planned), and says where to put it right.
 */
import { db, getSession, listDevices } from '../db.js';
import { defaultSessionId, scannerJobs, scannerPrompts, JOBS } from './scanner-prompts.js';
import { idleConfig } from './idle.js';
import { listEmployees } from './people.js';
import { listBackups } from './admin-ops.js';
import { onedriveStatus } from './onedrive.js';
import { teamsConfig } from '../util/teams.js';
import { passwordIs } from './users.js';

const DAY = 24 * 60 * 60 * 1000;
const fix = (sub, card, label, page = '/settings') => ({ page, sub, card, label });

/** The count the check is about: the one asked for, else the one the scanners land on, else the newest open wall-to-wall. */
function countFor(sessionId) {
  const asked = sessionId ? getSession(sessionId) : null;
  if (asked && !asked.practice && (asked.mode || 'full') !== 'cycle') return asked;
  const def = defaultSessionId() ? getSession(defaultSessionId()) : null;
  if (def && !def.practice && (def.mode || 'full') !== 'cycle') return def;
  return db.prepare("SELECT * FROM sessions WHERE status = 'open' AND practice = 0 AND COALESCE(mode, 'full') != 'cycle' ORDER BY id DESC LIMIT 1").get() || null;
}

export function readiness(sessionId) {
  const checks = [];
  const add = (level, title, detail, where) => checks.push({ level, title, detail, fix: where || null });

  /* ---- the count */
  const s = countFor(sessionId);
  if (!s) {
    add('fail', 'No open full count', 'There is nothing for the scanners to count into yet.', fix('start', 'sessionCard', 'Make one'));
  } else {
    const def = defaultSessionId();
    if (s.status !== 'open') add('fail', `"${s.name}" is closed`, 'A closed count takes no scans. Reopen it, or make a new one.', fix('start', 'sessionCard', 'Count session'));
    else if (def === s.id) add('ok', `Scanners land on "${s.name}"`, 'It is the count every scanner starts on.');
    else add('warn', `Scanners do not land on "${s.name}"`, def ? `They start on #${def} instead - make this one the count scanners land on.` : 'No count is set as the one scanners land on, so each counter picks from a list.', fix('start', 'sessionCard', 'Count session'));
    if (s.trial) add('warn', 'The count is still a trial run', 'Lines scanned now are rehearsal and are cleared when the trial ends. End the trial before the real count.', fix('start', 'sessionCard', 'Count session'));
    const bins = db.prepare('SELECT COUNT(*) n FROM locations WHERE session_id = ?').get(s.id).n;
    const pallets = db.prepare('SELECT COUNT(*) n FROM pallets WHERE session_id = ?').get(s.id).n;
    if (!bins) add('fail', 'No bin list on the count', 'Scanned bins cannot be checked, and there are no aisles to hand out.', fix('lists', 'binsCard', 'Bin list'));
    else add('ok', `${bins.toLocaleString()} bins on the count`, 'Every scanned bin is checked against them.');
    if (!pallets) add('warn', 'No inventory report on the count', 'The count still records what is there, but nothing is compared: no variances, no second counts.', fix('lists', 'reportCard', 'Inventory report'));
    else add('ok', `${pallets.toLocaleString()} pallets on the report`, 'What the count is compared against.');
  }

  /* ---- what the scanners offer */
  const jobs = scannerJobs();
  const label = Object.fromEntries(JOBS);
  const others = JOBS.map(([k]) => k).filter((k) => k !== 'full' && jobs[k]);
  if (!jobs.full) add('fail', 'The scanners do not offer the full count', 'Tick Full count under the jobs, or nobody can count into it.', fix('gun', 'offersCard', 'Jobs on the scanners'));
  else if (others.length) add('warn', `The scanners also offer ${others.map((k) => label[k]).join(', ')}`, 'On count day, untick everything but Full count so nobody signs on to another job by mistake. Tick them back afterwards.', fix('gun', 'offersCard', 'Jobs on the scanners'));
  else add('ok', 'The scanners offer the full count alone', 'Nobody can wander into another job.');

  /* ---- the scanners */
  const devices = listDevices();
  const enrolled = devices.filter((d) => d.token_hash || d.enrolled_at);
  const recent = enrolled.filter((d) => d.last_seen && Date.now() - Date.parse(d.last_seen) < 14 * DAY);
  if (!devices.length) add('fail', 'No scanners registered', 'Add each handheld and open its link on the device once.', fix('gun', 'devicesCard', 'Scanner setup'));
  else if (!enrolled.length) add('fail', 'No scanner has opened its link', `${devices.length} registered, none signed in. Open each link on its device once.`, fix('gun', 'devicesCard', 'Scanner setup'));
  else if (enrolled.length < devices.length) add('warn', `${devices.length - enrolled.length} of ${devices.length} scanners have never opened their link`, 'They cannot send counts until they do.', fix('gun', 'devicesCard', 'Scanner setup'));
  else add('ok', `All ${devices.length} scanners are signed in`, recent.length < enrolled.length ? `${enrolled.length - recent.length} not seen in the last two weeks - switch them on and check they still open the app.` : 'Each has been seen in the last two weeks.');

  /* ---- the people */
  const crew = listEmployees().filter((e) => e.active);
  if (!crew.length) add('warn', 'No crew list', 'Without one, any clock-in number can sign on and the scanner header shows numbers, not names.', fix('', '', 'Teams & crew', '/teams'));
  else add('ok', `${crew.length.toLocaleString()} people on the crew list`, 'A clock-in number not on it is turned away at sign-on: see a supervisor.');

  /* ---- when something goes wrong */
  const idle = idleConfig();
  if (!idle.minutes) add('warn', 'The stopped-scanning alert is off', 'A team that goes quiet will not show on the dashboard.', fix('gun', 'idleCard', 'When a team stops scanning'));
  else add('ok', `A team quiet for ${idle.minutes} minutes is flagged`, 'On the dashboard' + (idle.teams && teamsConfig().on ? ' and in Teams.' : '.'));
  const prompts = scannerPrompts();
  if (!(prompts.overrides || []).length) add('warn', 'No override reasons', 'A counter overriding a check has no reason to give.', fix('gun', 'offersCard', 'Override reasons'));
  const tc = teamsConfig();
  if (!tc.on) add('ok', 'No Teams channel', 'An SOS shows on the dashboard and the board. A channel is optional; send a test card if you set one.', fix('erp', 'teamsCard', 'Teams channel'));
  else add('ok', 'SOS alerts also go to Teams', 'Send a test card before count day to be sure the address still works.', fix('erp', 'teamsCard', 'Teams channel'));

  /* ---- the backups */
  const newest = listBackups()[0];
  if (!newest) add('warn', 'No backup yet', 'One is taken each day; take one now to be sure it works.', fix('backups', 'backupsCard', 'Backups & log'));
  else if (Date.now() - Date.parse(newest.at) > 1.5 * DAY) add('warn', 'The newest backup is more than a day old', `${newest.name}. Take one now.`, fix('backups', 'backupsCard', 'Backups & log'));
  else add('ok', 'Backed up in the last day', newest.name);
  const od = onedriveStatus();
  if (!od.connected) add('warn', 'Backups are only on this server', 'If the server is lost, so are they. Connect OneDrive so each one is copied off-site.', fix('backups', 'onedriveCard', 'Off-site copy'));
  else if (od.lastError) add('warn', 'The last OneDrive copy failed', od.lastError.message, fix('backups', 'onedriveCard', 'Off-site copy'));
  else add('ok', 'Each backup is copied to OneDrive', od.lastUpload ? `Last copy ${od.lastUpload.name}.` : 'The next backup is the first copy.');

  /* ---- the way in */
  const su = process.env.SUPERADMIN_USER;
  if (su && passwordIs(su, 'changeme')) add('fail', 'The site admin still has the password "changeme"', 'Anyone who has read the set-up notes can sign in as the site admin. Change it now.', fix('advanced', 'loginsCard', 'Your password'));

  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  return {
    session: s ? { id: s.id, name: s.name, status: s.status } : null,
    state: fails ? 'not-ready' : warns ? 'nearly' : 'ready',
    fails, warns,
    checks: [...checks.filter((c) => c.level === 'fail'), ...checks.filter((c) => c.level === 'warn'), ...checks.filter((c) => c.level === 'ok')],
    at: new Date().toISOString(),
  };
}
