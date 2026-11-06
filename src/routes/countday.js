import { db, getSession, listDevices } from '../db.js';
import { defaultSessionId, jobsOffered } from './scanner-prompts.js';
import { listEmployees, listTeams } from './people.js';
import { listBackups } from './admin-ops.js';
import { trainingSession, trainingCycleSession } from './training.js';
import { readiness } from './readiness.js';
import { floorState } from './floor-bins.js';
import { clockSchedule, scheduleWords } from './clock-schedule.js';
import { localDate } from '../util/localtime.js';

/*
 * The count-day checklist.
 *
 * Everything a count day needs, in the order it happens: the week before, the
 * day before, the morning, during, and closing out. Each line says how to do
 * it in a few plain steps, points at the guide section with the full story,
 * and has a button to the place in the app.
 *
 * Where the app can see for itself that a thing is done - the bin list is up,
 * the plan is queued, a backup was taken, the aisle sheet was printed - the
 * line ticks itself, from the database and the log, and cannot be ticked by
 * hand. Where it cannot see - the scanners are on charge, the teams were
 * briefed - a supervisor ticks it, and the tick says who and when. Ticks are
 * kept per count, so a new count starts with a fresh list.
 */

const one = (sql, ...a) => db.prepare(sql).get(...a);
const HOUR = 3600000, DAY = 24 * HOUR;
const GUIDE = 'admin/first-full-count';
const SUPER = 'admin/count-day-for-supervisors';

const ticksKey = (id) => `checklist:${Number(id)}`;
function readTicks(id) {
  const r = one("SELECT value FROM settings WHERE key = ?", ticksKey(id));
  try { return r ? JSON.parse(r.value) : {}; } catch { return {}; }
}
export function tickCountday(sessionId, key, on, by) {
  if (!getSession(sessionId)) throw Object.assign(new Error('session not found'), { status: 404 });
  const ticks = readTicks(sessionId);
  if (on) ticks[key] = { by: String(by || ''), at: new Date().toISOString() }; else delete ticks[key];
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ticksKey(sessionId), JSON.stringify(ticks));
  return countdayChecklist(sessionId);
}

/** The newest log entry of an action, on this count or on none. */
const logged = (action, sessionId) => one('SELECT at FROM audit WHERE action = ? AND (session_id = ? OR session_id IS NULL) ORDER BY id DESC LIMIT 1', action, Number(sessionId));
const since = (row, ms) => !!row && Date.now() - Date.parse(row.at) < ms;

export function countdayChecklist(sessionId) {
  const s = getSession(sessionId);
  if (!s) return null;
  const id = s.id;
  const cycle = (s.mode || 'full') === 'cycle';
  const ticks = readTicks(id);
  const n = (sql, ...a) => one(sql, ...a).n;

  /* ---- what the app can see */
  const bins = n('SELECT COUNT(*) n FROM locations WHERE session_id = ?', id);
  const pallets = n('SELECT COUNT(*) n FROM pallets WHERE session_id = ?', id);
  const blocks = n('SELECT COUNT(*) n FROM (SELECT block FROM aisles WHERE session_id = ? GROUP BY block HAVING COUNT(*) > 1)', id);
  const crew = listEmployees().filter((e) => e.active);
  const teams = listTeams().filter((t) => t.members.length);
  const devices = listDevices();
  const enrolled = devices.filter((d) => d.enrolled_at);
  const tablets = devices.filter((d) => d.kind === 'tablet');
  const plan = n('SELECT COUNT(*) n FROM assignments WHERE session_id = ?', id);
  const planLeft = n("SELECT COUNT(*) n FROM assignments WHERE session_id = ? AND status != 'done'", id);
  const signons = n('SELECT COUNT(*) n FROM signons WHERE session_id = ?', id);
  const lines = n('SELECT COUNT(*) n FROM counts WHERE session_id = ? AND voided = 0', id);
  const recountsOpen = n("SELECT COUNT(*) n FROM recounts WHERE session_id = ? AND status != 'done'", id);
  const recountsAll = n('SELECT COUNT(*) n FROM recounts WHERE session_id = ?', id);
  const sosOpen = n("SELECT COUNT(*) n FROM alerts WHERE session_id = ? AND status != 'closed'", id);
  const pending = n("SELECT COUNT(*) n FROM adjustments WHERE session_id = ? AND status = 'pending'", id);
  const users = n('SELECT COUNT(*) n FROM users');
  const jobs = jobsOffered();
  const others = Object.entries(jobs).filter(([k, v]) => v && k !== 'full').map(([k]) => k);
  const classroom = [trainingSession(), trainingCycleSession()].filter((x) => x && x.status === 'open');
  const backups = listBackups();
  const newest = backups[0];
  const ready = readiness(id);
  const fails = ready.checks.filter((c) => c.level === 'fail');
  const warns = ready.checks.filter((c) => c.level === 'warn');
  const levelsShort = ready.checks.find((c) => /No team can reach level/.test(c.title));

  /* ---- the list */
  const phases = [];
  let phase = null;
  const start = (title, note) => { phase = { title, note, items: [] }; phases.push(phase); };
  /* auto: the app decides; else the tick decides. need: required | wanted | optional */
  const item = (o) => {
    const t = ticks[o.key];
    const done = o.auto != null ? !!o.auto : !!t;
    phase.items.push({ key: o.key, title: o.title, detail: o.detail || '', need: o.need || 'wanted', auto: o.auto != null, done, guideOnly: !!o.guideOnly,
      by: !o.auto && t ? t.by : '', at: !o.auto && t ? t.at : '', how: o.how || [], guide: o.guide || null, goto: o.goto || null, label: o.label || 'Open' });
  };
  const g = (section, name = GUIDE) => ({ name, section });
  const to = (page, sub, card) => ({ page, sub, card: card || null });

  start('The week before', 'The lists, the people and the scanners: everything the count is built on.');
  item({ key: 'count', title: 'Make the count', auto: true, detail: `${s.name} · #${id} · ${cycle ? 'cycle count' : 'full count'} · ${s.status}`,
    how: ['Settings → Count setup → Start a new count.', 'Name it for the day (Q4 wall-to-wall), type Full count, press Create count.', 'Pick it in the box at the top of Settings: the rest of the setup is about the count picked there.'],
    guide: g('11--create-the-count'), goto: to('/settings', 'start', 'sessionCard'), label: 'Count setup' });
  item({ key: 'bins', title: 'Upload the bin list', need: 'required', auto: bins > 0, detail: bins ? `${bins.toLocaleString()} bins` : 'nothing uploaded yet',
    how: ['Settings → Lists & racking → Bin list.', 'Choose the file (Bin Location, Zone, Aisle columns) and press Upload.', 'The count says how many bins and aisles it read.'],
    guide: g('12--upload-the-bin-list-and-the-inventory-report'), goto: to('/settings', 'lists', 'binsCard'), label: 'Bin list' });
  item({ key: 'report', title: 'Upload the inventory report', need: cycle ? 'required' : 'wanted', auto: pallets > 0, detail: pallets ? `${pallets.toLocaleString()} pallets` : 'nothing uploaded yet — without it nothing is compared, so no variances and no second counts',
    how: ['Export the on-hand report from the ERP, with Pallet ID, SKU, Qty and Location (Cost too, for money thresholds).', 'Settings → Lists & racking → Inventory report, choose the file, press Upload.', 'Upload it again the night before if stock moved: the newest copy is what the count compares against.'],
    guide: g('12--upload-the-bin-list-and-the-inventory-report'), goto: to('/settings', 'lists', 'reportCard'), label: 'Report' });
  if (!cycle) item({ key: 'blocks', title: 'Pair the aisles that share racking', auto: blocks > 0, detail: blocks ? `${blocks} racking block${blocks === 1 ? '' : 's'} of more than one aisle` : 'every aisle is its own block — two teams can work both sides of one rack',
    how: ['Settings → Lists & racking → Aisles & racking blocks.', 'Pair each aisle with the one that backs onto the same rack (F01 with F02, and so on).', 'Only one team at a time is sent into a block, so nobody counts from both sides of a rack at once.'],
    guide: g('13--pair-the-aisles-into-racking-blocks'), goto: to('/settings', 'lists', 'aislesCard'), label: 'Racking' });
  item({ key: 'crew', title: 'Load the crew list and the teams', need: 'required', auto: crew.length > 0 && teams.length > 0, detail: crew.length || teams.length ? `${crew.length} people · ${teams.length} team${teams.length === 1 ? '' : 's'} with people on them` : 'no crew list yet',
    how: ['Teams & crew → Employees → Crew workbook: the Employees sheet (clock-in number, name, shift, equipment, sizes) and the Teams sheet (team number, who is on it, what they drive).', 'Press Check, read what it says, fix the file, then Apply.', 'A clock-in number not on the list is turned away at sign-on, so everyone counting has to be on it.'],
    guide: g('6--the-crew-list'), goto: to('/teams', 'people'), label: 'Teams & crew' });
  item({ key: 'levels', title: 'Check what each team reaches', auto: teams.length > 0 && !levelsShort, detail: levelsShort ? levelsShort.title : teams.length ? 'every level on the count has a team that reaches it' : 'no teams yet',
    how: ['Teams & crew → Equipment rules: which levels need which equipment. Shipped: a dock truck reaches A–B, a scissor lift with a dock truck B–C, a high reach with a scissor lift C–F.', 'Each team card shows what its people reach between them. A level nobody reaches will not be handed out.', 'Change a rule, or put the equipment on a team, until every level is covered.'],
    guide: g('7--teams-and-what-their-equipment-reaches'), goto: to('/teams', 'people'), label: 'Equipment rules' });
  item({ key: 'scanners', title: 'Register the scanners and open each link once', need: 'required', auto: devices.length > 0 && enrolled.length === devices.length, detail: devices.length ? `${devices.length} registered · ${enrolled.length} signed in${tablets.length ? ` · ${tablets.length} tablet${tablets.length === 1 ? '' : 's'}` : ''}` : 'none registered yet',
    how: ['Settings → Scanners → Scanner setup: a name for each scanner (what is written on it), Type Zebra scanner or Tablet, Add scanner.', 'Print setup cards and tape one in each cradle.', 'On each device open its link in Chrome once (scan the card), then Add to Home screen. Its row says Signed in when it has.'],
    guide: g('8--register-and-set-up-the-scanners'), goto: to('/settings', 'gun', 'devicesCard'), label: 'Scanner setup' });
  item({ key: 'options', title: 'Set what the scanners ask and how the floor is run', detail: 'guided bin by bin, the pallet check, comments, second counts, approvals',
    how: ['Settings → Scanners → This count on the scanners. Each option says what it does.', 'For a wall-to-wall: Guided by the plan on, Pallet ID check Validate — allow override, Raise second counts automatically on, thresholds as you want them.', 'Press Save. Tick this line when they are the way you want them.'],
    guide: g('14--the-counts-options'), goto: to('/settings', 'gun', 'countGunCard'), label: 'This count on the scanners' });
  item({ key: 'training', title: 'Train the crew, then remove the classroom count', auto: classroom.length ? false : null, detail: classroom.length ? 'the classroom training count is still on the scanners' : 'no training count on the scanners',
    how: ['Testing Suite → Classroom training: Set up, print the wall and the pocket cards, run the classes with the training zip.', 'After the last class press Remove: the training count and trainees go, your real teams stay.', 'Until it is removed a team can sign on to the training count by mistake.'],
    guide: g('16--practice-and-a-trial-run'), goto: to('/testing', '', 'classroomCard'), label: 'Classroom training' });
  if (!cycle) item({ key: 'trial', title: 'Trial run, then end it', need: 'optional', auto: !s.trial && !!s.cleared_at, detail: s.trial ? 'this count is still a trial run — end it before the real count' : s.cleared_at ? `trial cleared ${new Date(s.cleared_at).toLocaleString()}` : 'no trial run (optional)',
    how: ['Settings → Count setup → Trial run → Make this a trial run. Real guns, real teams, a few aisles.', 'When done press End the trial: every line is cleared and the aisles go back to the start.', 'Not ending it is the classic mistake: the real count would be cleared with it.'],
    guide: g('16--practice-and-a-trial-run'), goto: to('/settings', 'start', 'trialSet'), label: 'Trial run' });

  start('The day before', 'The plan, the paper, and the Ready for count day check.');
  if (!cycle) item({ key: 'plan', title: 'Queue the aisles onto the teams', need: 'required', auto: plan > 0, detail: plan ? `${plan} aisle assignment${plan === 1 ? '' : 's'}` : 'nothing queued — the scanners would have nothing to hand out',
    how: ['Dashboard → Team plan. Auto-assign the aisles: pick the teams, press Preview, read the warnings, Queue this plan.', 'Or drag aisles onto teams, or Queue aisles for this team by hand.', 'A team gets only the levels it reaches; what it cannot reach goes to a team that can.'],
    guide: g('15--give-the-teams-their-aisles'), goto: to('/admin', 'teams'), label: 'Team plan' });
  if (!cycle && floorState(id).areas.some((a) => !a.error)) { const fl = floorState(id); const names = fl.areas.filter((a) => !a.error).map((a) => a.bins > 1 ? `${a.aisle} (${a.first} to ${a.last})` : a.aisle).join(', ');
    item({ key: 'floor', title: 'Put the floor bins on the count and give them to a team', auto: bins > 0 && fl.allOn && !fl.unassigned.length,
      detail: !bins ? `after the bin list: ${names}` : !fl.allOn ? `not on the count yet: ${fl.areas.filter((a) => !a.error && a.missing).map((a) => a.aisle).join(', ')}` : fl.unassigned.length ? `on the count, but no team has ${fl.unassigned.join(', ')}` : `${names} · ${fl.areas.filter((a) => !a.error).map((a) => `${a.aisle}: team ${a.teams.join(', ')}`).join(' · ')}`,
      how: ['Settings → Lists & racking → Floor bins: REC and the staging spots PRYSTG#1 to PRYSTG#16, one line each. Press Put them on this count.', 'Print the floor bin labels and hang each where its pallets stand; the scanners read the label as the bin.', 'Dashboard → Team plan: queue REC and PRYSTG onto a team like any aisle. They have no levels, so any team reaches them; the scanner walks the spots in order.'],
      guide: g('12a--floor-bins-rec-and-the-staging-spots'), goto: to('/settings', 'lists', 'floorCard'), label: 'Floor bins' }); }
  { const sc = clockSchedule(id);
    item({ key: 'hours', title: 'Give the clock the shift hours and the breaks', need: 'optional', auto: sc.on && !!(sc.start || sc.end || sc.breaks.length),
      detail: sc.on && (sc.start || sc.end || sc.breaks.length) ? scheduleWords(sc) : 'no hours set — "done about" counts every minute from now, lunch included',
      how: ['Settings → Count setup → The hours the count is worked: tick Use these hours.', 'Type the shift start and end; add each break with its times and a name (Lunch).', 'The Dashboard\'s Done about then steps over the breaks and stops at the bell, and says what would be left.'],
      guide: g('20--count-day-what-the-supervisor-watches'), goto: to('/settings', 'start', 'clockCard'), label: 'Hours' }); }
  if (!cycle) item({ key: 'aisleSheet', title: 'Print the aisle sheet', need: 'optional', auto: !!logged('printed the aisle sheet', id), detail: logged('printed the aisle sheet', id) ? `printed ${new Date(logged('printed the aisle sheet', id).at).toLocaleString()}` : 'the paper copy of who does which aisle',
    how: ['Dashboard → Team plan → 🖨 Aisle sheet.', 'Tick With the plan as it is now to print the teams in; the rest is blank to write.', 'Keep it on the clipboard on the day: team, levels, started, done, checked by.'],
    guide: g('15--give-the-teams-their-aisles'), goto: to('/admin', 'teams'), label: 'Team plan' });
  item({ key: 'teamCards', title: 'Print the team cards', auto: !!logged('printed team number codes', null), detail: logged('printed team number codes', null) ? `printed ${new Date(logged('printed team number codes', null).at).toLocaleString()}` : 'one card per team: the team number as a QR and a barcode, scanned at sign-on',
    how: ['Teams & crew → 🖨 Print team QR codes, every team or one shift.', 'Cut the cards out. Each team keeps its card with the scanner all day.', 'Badge labels (Avery 5960) print each person\'s clock-in number the same way, on the Employees card.'],
    guide: g('7--teams-and-what-their-equipment-reaches'), goto: to('/teams', 'people'), label: 'Teams & crew' });
  item({ key: 'badges', title: 'Badge labels and gear box labels', need: 'optional', auto: !!logged('printed badge labels', null) || !!logged('printed gear box labels', null), detail: 'clock-in numbers to scan, and a 4×6 label for each person\'s gear box',
    how: ['Teams & crew → Employees → ⬇ Badge labels (Avery 5960, Word): three labels a person, their number as a barcode.', '🖨 Gear box labels (4×6): name, number, shift, team and jacket, bibs and boot sizes, for the box their gear waits in.', 'Pack the gear boxes the day before, by shift.'],
    guide: g('6--the-crew-list'), goto: to('/teams', 'people'), label: 'Teams & crew' });
  item({ key: 'offered', title: 'The scanners offer this count, and only the full count', auto: s.show_on_guns !== 0 && jobs.full && !others.length && defaultSessionId() === id, detail: [s.show_on_guns === 0 ? 'Show on the scanners is off' : '', !jobs.full ? 'Full count is not offered' : '', others.length ? `the scanners also offer ${others.join(', ')}` : '', defaultSessionId() !== id ? 'the scanners do not start on this count' : ''].filter(Boolean).join(' · ') || 'shown, started on, and the only job offered',
    how: ['Settings → Scanners → This count on the scanners: tick Show on the scanners and Scanners start here, Save.', 'Settings → Scanners → What the scanners offer: untick every job but Full count, so nobody wanders into a cycle count.', 'Every scanner then lands on this count at sign-on.'],
    guide: g('3--switch-off-everything-but-full-counts'), goto: to('/settings', 'gun', 'countGunCard'), label: 'Scanners' });
  item({ key: 'logins', title: 'A login for each supervisor', auto: users > 1, detail: users > 1 ? `${users} logins` : 'only the site admin — every supervisor on the floor needs their own',
    how: ['Settings → Logins → Add a login: name, username, a first password, profile Supervisor.', 'They change the password the first time they sign in.', 'The log then says who approved what, by name.'],
    guide: g('5--a-login-for-each-supervisor'), goto: to('/settings', 'logins', 'loginsCard'), label: 'Logins' });
  item({ key: 'readyCheck', title: 'Ready for count day: nothing red', need: 'required', auto: !fails.length, detail: fails.length ? `${fails.length} red: ${fails.map((c) => c.title).join('; ')}` : warns.length ? `nothing red · ${warns.length} amber worth a look` : 'all green',
    how: ['Settings → Count setup → Ready for count day: the site checked against what a count day needs, worked out fresh each time.', 'A red line stops the count going as planned: press its button and put it right.', 'Amber works, but you would want to know. Press Check again after each fix.'],
    guide: g('17--the-day-before-ready-for-count-day'), goto: to('/settings', 'start', 'readyCard'), label: 'Ready for count day' });
  item({ key: 'charge', title: 'Every scanner on charge, spares in the cradles', detail: 'a flat gun at 7am is a team doing nothing',
    how: ['Put every scanner and tablet on charge overnight, and the spare batteries in their chargers.', 'Open each one once: it should show its own name on the sign-on screen and the count in the list.', 'A scanner that says its link was removed needs its card scanned again under Scanner setup.'],
    guide: g('18--count-day-the-morning'), goto: to('/settings', 'gun', 'devicesCard'), label: 'Scanner setup' });
  item({ key: 'wifi', title: 'Walk the Wi-Fi with a scanner', detail: 'the freezer and the far aisles',
    how: ['Sign a scanner on and walk the aisles, the freezer and the dock, watching the online chip.', 'A dead zone is fine for counting - lines queue on the gun and send when it is back in signal - but the crew should know where it is.', 'Note it on the aisle sheet for the teams working there.'],
    guide: g('26--when-something-is-not-right'), goto: null, label: '' });
  item({ key: 'backupBefore', title: 'A backup from today', auto: since(newest, DAY), detail: newest ? `newest ${newest.name}` : 'no backup yet',
    how: ['Settings → Backups & log → Back up now.', 'One is taken each day by itself; this is the copy from before the count starts.', 'An off-site copy (Teams channel, Google Drive or OneDrive) means the backup survives the server.'],
    guide: g('25--close-the-count-and-keep-a-copy'), goto: to('/settings', 'backups', 'backupsCard'), label: 'Backups' });

  start('Count morning', 'The first hour: brief, hand out, watch the first sign-ons.');
  item({ key: 'reportFresh', title: 'The inventory report is from this morning', detail: 'stock that moved overnight is on it',
    how: ['Export the on-hand report once the last movement is in, and upload it again under Lists & racking → Inventory report.', 'The count compares against the newest copy; nothing counted is lost by uploading again.', 'Freeze receiving and shipping for the count, or note what moves.'],
    guide: g('18--count-day-the-morning'), goto: to('/settings', 'lists', 'reportCard'), label: 'Report' });
  item({ key: 'brief', title: 'Brief the teams', detail: 'five minutes with the pocket card',
    how: ['Each team: its card, its scanner, its first aisle and levels, its gear box.', 'The three scans - rack, pallet, quantity - and the buttons under them: Bin is EMPTY, more than one label, label will not scan, SOS.', 'Count what is there, not what the label says. Nobody knows the expected quantity, on purpose.'],
    guide: g('19--count-day-what-the-counters-do'), goto: to('/guide', ''), label: 'User guide', guideOnly: true });
  item({ key: 'handout', title: 'Scanners and team cards handed out', detail: 'each team signs on with its card and every badge',
    how: ['The team scans its card, then each person scans their badge, then Sign on & load list.', 'The scanner says which aisle and levels it has; the crew banner says what they reach between them.', 'A badge the gun refuses is not on the crew list: add the person under Teams & crew.'],
    guide: g('19--count-day-what-the-counters-do'), goto: to('/teams', 'people'), label: 'Teams & crew' });
  item({ key: 'signons', title: 'The first teams have signed on', auto: signons > 0, detail: signons ? `${signons} sign-on${signons === 1 ? '' : 's'} so far · ${lines.toLocaleString()} lines counted` : 'nobody signed on yet',
    how: ['Dashboard → the floor map and the team list fill in as the teams start.', 'A team missing after ten minutes: find them, and check the scanner is on the right count.', 'The Crew board by the time clock shows who is on which team.'],
    guide: g('20--count-day-what-the-supervisor-watches'), goto: to('/admin', 'overview'), label: 'Dashboard' });

  start('During the count', 'What the supervisor watches, and what to do about it.');
  item({ key: 'watch', title: 'Watch the dashboard: progress, quiet teams, SOS', detail: `${recountsAll ? `${recountsOpen} of ${recountsAll} second counts open · ` : ''}${sosOpen ? `${sosOpen} SOS open` : 'no SOS open'}`,
    how: ['Dashboard: the map colours in as bins are counted; the team list shows each team\'s aisle and when it last scanned.', 'An amber bar is a team quiet too long: go and look. A red SOS card says who needs help and where - open it, and close it when it is handled.', 'Reports → Fix list is the labels to replace and the problems reported from the guns.'],
    guide: g('20--count-day-what-the-supervisor-watches'), goto: to('/admin', 'overview'), label: 'Dashboard' });
  item({ key: 'recounts', title: 'Second counts are being worked', auto: recountsAll > 0 && recountsOpen === 0 ? true : null, detail: recountsAll ? `${recountsOpen} open of ${recountsAll} raised` : 'none raised yet',
    how: ['Dashboard → Second counts: every bin sent back, who has it, and the first count beside the second when it lands.', 'The scanners offer them under Start second counts to a team that did not count the bin.', 'Hand a pile to a team by name when the floor is slow to pick them up; a bin the two counts still disagree on goes for a third.'],
    guide: g('21--second-counts'), goto: to('/admin', 'second'), label: 'Second counts' });
  item({ key: 'shiftEnd', title: 'End of shift: aisles handed over', detail: 'the next shift picks up where this one stopped',
    how: ['Dashboard → Team plan: an aisle half done stays Counting now for its team; press release to send it to the back of the queue for another team.', 'Teams sign off their scanners (Sign off this scanner) so the next shift signs on clean.', 'Write the hand-over on the aisle sheet.'],
    guide: g('at-the-end-of-a-shift', SUPER), goto: to('/admin', 'teams'), label: 'Team plan' });

  start('Closing out', 'Everything counted, everything checked, the file to the ERP, the count closed.');
  if (!cycle) item({ key: 'aislesDone', title: 'Every planned aisle is done', auto: plan > 0 && planLeft === 0, detail: plan ? `${plan - planLeft} of ${plan} done` : 'no plan',
    how: ['Dashboard → Team plan: every column ends in Done.', 'An aisle with bins uncounted shows on the map; send a team back, or mark it done if those bins are truly empty.', 'Reports → Inventory report lists every bin and pallet with no count.'],
    guide: g('22--read-the-reports'), goto: to('/admin', 'teams'), label: 'Team plan' });
  item({ key: 'recountsDone', title: 'Every second count is done', auto: recountsAll > 0 ? recountsOpen === 0 : null, detail: recountsAll ? `${recountsOpen} still open` : 'none were raised',
    how: ['Dashboard → Second counts: nothing left open.', 'A bin nobody will reach today can be closed by hand with a note.', 'The report shows the second count beside the first for every bin that had one.'],
    guide: g('21--second-counts'), goto: to('/admin', 'second'), label: 'Second counts' });
  item({ key: 'approve', title: 'Adjustments approved', auto: s.require_approval ? pending === 0 : null, detail: s.require_approval ? `${pending} waiting for approval` : 'approval is off for this count',
    how: ['Reports → Adjustments: each difference over the thresholds, with a reason to pick and a signature.', 'Approve, or reject with a note; the rest goes through by itself under the thresholds.', 'Nothing reaches the ERP file until it is approved.'],
    guide: g('23--approve-the-adjustments'), goto: to('/admin', 'adjust'), label: 'Adjustments' });
  item({ key: 'erp', title: 'The file sent to the ERP', auto: !!logged('exported to the ERP', id) || !!logged('downloaded an aisle for the ERP', id), detail: logged('exported to the ERP', id) ? `exported ${new Date(logged('exported to the ERP', id).at).toLocaleString()}` : 'not exported yet',
    how: ['Reports → ERP: download the file in the layout your ERP takes, by aisle or everything.', 'Key it in or import it; mark each aisle uploaded so the Uploaded column follows.', 'The count stays open for second looks until you close it.'],
    guide: g('24--into-the-erp'), goto: to('/admin', 'reports'), label: 'Reports' });
  item({ key: 'close', title: 'Close the count and keep a copy', auto: s.status === 'closed', detail: s.status === 'closed' ? `closed ${s.closed_at ? new Date(s.closed_at).toLocaleString() : ''}` : 'still open',
    how: ['Settings → Backups & log → Back up now, then Download the backup and keep it with the count\'s files.', 'Settings → Count setup → Close session. A closed count takes no more scans and stays on the reports.', 'Untick Show on the scanners so it leaves their list.'],
    guide: g('25--close-the-count-and-keep-a-copy'), goto: to('/settings', 'start', 'sessionCard'), label: 'Count setup' });

  const items = phases.flatMap((p) => p.items);
  return {
    session: { id, name: s.name, mode: cycle ? 'cycle' : 'full', status: s.status },
    phases,
    done: items.filter((x) => x.done).length,
    total: items.length,
    required: items.filter((x) => x.need === 'required' && !x.done).map((x) => x.title),
    printed: localDate(),
  };
}

/** The checklist on paper: the lines, the how, and a box to tick. */
export function countdayPrint(sessionId) {
  const c = countdayChecklist(sessionId);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  if (!c) return '<!doctype html><title>No count</title><p>No count.';
  const body = c.phases.map((p) => `<h2>${esc(p.title)} <span class="muted">${esc(p.note)}</span></h2><table>${p.items.map((it) => `<tr class="${it.done ? 'done' : ''}"><td class="box">${it.done ? '☑' : '☐'}</td><td><b>${esc(it.title)}</b>${it.need === 'required' ? ' <span class="req">needed</span>' : it.need === 'optional' ? ' <span class="muted">optional</span>' : ''}<div class="muted">${esc(it.detail)}</div><ol>${it.how.map((h) => `<li>${esc(h)}</li>`).join('')}</ol></td><td class="who">${it.auto ? '<span class="muted">app</span>' : it.by ? `${esc(it.by)}<br><span class="muted">${esc(new Date(it.at).toLocaleString())}</span>` : '<span class="line">&nbsp;</span>'}</td></tr>`).join('')}</table>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Count-day checklist — ${esc(c.session.name)}</title>
<style>
  @page { size: letter portrait; margin: 12mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #000; background: #fff; margin: 0; padding: 10px; font-size: 10pt; }
  h1 { font-size: 15pt; margin: 0; } .sub { font-size: 9pt; color: #333; margin: 2px 0 8px; }
  h2 { font-size: 11.5pt; margin: 12px 0 4px; border-bottom: 2px solid #000; padding-bottom: 2px; break-after: avoid; }
  h2 .muted { font-weight: 400; font-size: 9pt; }
  table { width: 100%; border-collapse: collapse; } td { border-top: 1px solid #bbb; padding: 5px 6px; vertical-align: top; }
  td.box { width: 22px; font-size: 15pt; } td.who { width: 120px; font-size: 8.5pt; }
  .line { display: inline-block; width: 110px; border-bottom: 1px solid #000; }
  ol { margin: 3px 0 0; padding-left: 18px; font-size: 9pt; color: #222; } li { margin: 1px 0; }
  .muted { color: #555; font-size: 9pt; } .req { color: #a00; font-weight: 700; font-size: 8.5pt; }
  tr { break-inside: avoid; } tr.done td.box { color: #060; }
  .noprint { margin-bottom: 8px; padding: 6px 14px; font-weight: 700; }
  @media print { .noprint { display: none; } }
</style></head><body>
<h1>Count-day checklist — ${esc(c.session.name)}</h1>
<div class="sub">${c.done} of ${c.total} done · printed ${esc(c.printed)} · a line marked <i>app</i> the app ticks by itself from what is in the database; the rest a supervisor ticks, on the page or here</div>
<button class="noprint" onclick="window.print()">Print</button>
${body}
</body></html>`;
}
