import { chromium } from 'playwright-core';
import { expandSubTabs, pickSession } from './helpers.mjs';
import { readFileSync } from 'node:fs';
const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
let n = 0;
const shot = async (t, name) => t.screenshot({ path: `${S}screenshots/t${String(++n).padStart(2, '0')}-${name}.png` });

const hdr = { 'content-type': 'application/json' }, j = (r) => r.json();
const { token } = await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }));
const A = { ...hdr, authorization: 'Bearer ' + token };
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'reach test' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/csv' }, body: readFileSync(new URL('../public/templates/front-royal-bins.csv', import.meta.url).pathname, 'utf8') });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const p = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.25 });
p.on('pageerror', (e) => errors.push('teams: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/40[19]/.test(m.text())) errors.push('teams: ' + m.text()); });
p.on('dialog', (d) => d.accept());

await p.goto(BASE + '/teams');
check('Teams page: /teams serves the page', await p.title() === 'Teams & Crew');
await p.fill('#fPassword', 'changeme'); await p.click('#btnLogin');
await p.waitForSelector('#scrMain.active'); await expandSubTabs(p); await p.waitForTimeout(400);

// roster upload
const roster = `Badge,Name,Department,Equipment
E1001,Alex Romero,Freezer,Scissor lift; High reach
E1002,Jordan Blake,Freezer,Scissor lift
E1003,Sam Ortiz,Dry Dock,Dock truck
E1004,Riley Chen,Freezer,
E1005,Morgan Diaz,Shipping,forklift
E1006,Casey Fox,Freezer,jetpack`;
await p.setInputFiles('#fFile', { name: 'crew.csv', mimeType: 'text/csv', buffer: Buffer.from(roster) });
await p.click('#btnUpload'); await p.waitForTimeout(900);
const upMsg = clean(await p.textContent('#uploadMsg'));
check('Teams page: crew list imported, odd spellings understood, unknown kit reported', /Imported 6 of 6 rows/.test(upMsg) && /JETPACK/.test(upMsg), upMsg.slice(0, 150));
const roster1 = await j(await fetch(`${BASE}/api/admin/people`, { headers: A }));
const byBadge = Object.fromEntries(roster1.employees.map((e) => [e.badge, e]));
check('Roster: "forklift" maps to the high reach truck', byBadge.E1005.equipment.join() === 'HIGH REACH', byBadge.E1005.equipment.join());
check('Roster: everyone reaches level A on foot, a scissor lift alone adds nothing', byBadge.E1004.reach === 'A' && byBadge.E1002.reach === 'A', `E1004=${byBadge.E1004.reach} E1002(scissor)=${byBadge.E1002.reach}`);
check('Roster: scissor + high reach reaches A and C-F', byBadge.E1001.reach === 'ACDEF', byBadge.E1001.reach);

// teams and drag/drop
for (const t of ['1', '2']) { await p.fill('#fTeamName', t); await p.click('#btnAddTeam'); await p.waitForTimeout(400); }
check('Teams page: teams created', (await p.$$('#teams .bucket')).length === 2);
const drag = async (badge, teamIdx) => {
  await p.locator(`#pool .person[data-badge="${badge}"]`).dragTo(p.locator(`#teams .bucket >> nth=${teamIdx}`));
  await p.waitForTimeout(500);
};
await drag('E1002', 0);   // scissor only -> team 1 reaches A
await p.waitForTimeout(300);
let cards = await p.$$eval('#teams .bucket .reach', (r) => r.map((x) => x.textContent));
check('Drag and drop: a person moves onto a team and the reach updates', /reaches level A/.test(cards[0]), cards.join(' | '));
await drag('E1003', 0);   // + dock truck -> A-C
await p.waitForTimeout(300);
cards = await p.$$eval('#teams .bucket .reach', (r) => r.map((x) => x.textContent));
check('Reach pools across the team: scissor + dock truck together reach A-C', /reaches levels A–C/.test(cards[0]), cards[0]);
await drag('E1001', 1);   // scissor + high reach -> A, C-F
await p.waitForTimeout(300);
cards = await p.$$eval('#teams .bucket .reach', (r) => r.map((x) => x.textContent));
check('Team 2 with scissor + high reach reaches A, C, D, E, F', /reaches levels A, C, D, E, F/.test(cards[1]), cards[1]);
await shot(p, 'teams-board');
check('Teams page: the reach table spells out every combination', (await p.$$('#reachTable tbody tr')).length === 8);

// enforcement in the dashboard
const admin = await browser.newPage({ viewport: { width: 1500, height: 950 } });
admin.on('dialog', (d) => d.dismiss());   // refuse the "assign anyway" prompt
await admin.goto(BASE + '/admin');
await admin.fill('#fPassword', 'changeme'); await admin.click('#btnLogin');
await admin.waitForSelector('#scrMain.active'); await expandSubTabs(admin); await admin.waitForTimeout(600);
await pickSession(admin, String(sess.id));
await admin.fill('#fAssignTeam', '1'); await admin.fill('#fAssignAisles', 'F01'); await admin.fill('#fAssignLevels', 'A-F');
await admin.click('#btnAssign'); await admin.waitForTimeout(800);
const refused = clean(await admin.textContent('#assignMsg'));
check('Dashboard: team 1 (A–C) refused levels A–F, told exactly what is missing',
  /cannot reach levels D, E, F: that needs a high reach truck/.test(refused) && /they have scissor lift and dock truck/.test(refused), refused.slice(0, 190));
await shot(admin, 'assign-refused');
await admin.fill('#fAssignLevels', 'A-C'); await admin.click('#btnAssign'); await admin.waitForTimeout(800);
check('Dashboard: the same team is allowed A–C', /queued F01/.test(clean(await admin.textContent('#assignMsg'))), clean(await admin.textContent('#assignMsg')).slice(0, 90));
await admin.fill('#fAssignTeam', '2'); await admin.fill('#fAssignAisles', 'F03'); await admin.fill('#fAssignLevels', 'C-F');
await admin.click('#btnAssign'); await admin.waitForTimeout(800);
check('Dashboard: team 2 is allowed C–F', /queued F03/.test(clean(await admin.textContent('#assignMsg'))), clean(await admin.textContent('#assignMsg')).slice(0, 90));
// a supervisor may still insist
admin.removeAllListeners('dialog'); admin.on('dialog', (d) => d.accept());
await admin.fill('#fAssignTeam', '1'); await admin.fill('#fAssignAisles', 'F05'); await admin.fill('#fAssignLevels', 'D-F');
await admin.click('#btnAssign'); await admin.waitForTimeout(900);
check('Dashboard: a supervisor can override the refusal after confirming', /queued F05/.test(clean(await admin.textContent('#assignMsg'))), clean(await admin.textContent('#assignMsg')).slice(0, 90));
// a team with nobody on it is not second-guessed
await admin.fill('#fAssignTeam', '9'); await admin.fill('#fAssignAisles', 'F07'); await admin.fill('#fAssignLevels', 'A-F');
await admin.click('#btnAssign'); await admin.waitForTimeout(700);
check('Dashboard: a team with no roster entry is not blocked', /queued F07/.test(clean(await admin.textContent('#assignMsg'))), clean(await admin.textContent('#assignMsg')).slice(0, 80));

// editable rules
await p.bringToFront();
await p.fill('#rules .rule:nth-child(2) .lv', 'B');
await p.click('#btnSaveRules'); await p.waitForTimeout(700);
const cfg = await j(await fetch(`${BASE}/api/admin/people`, { headers: A }));
check('Teams page: the level rules can be edited and are saved', cfg.config.levelRules[1].levels === 'B', JSON.stringify(cfg.config.levelRules[1]));
await p.click('#btnResetRules'); await p.click('#btnSaveRules'); await p.waitForTimeout(600);
check('Teams page: defaults can be restored', (await j(await fetch(`${BASE}/api/admin/people`, { headers: A }))).config.levelRules[1].levels === 'BC');

/* ---------------- sign-on check on the gun ---------------- */
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'REACH-01' }) }));
const ctx = await browser.newContext({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
const gun = await ctx.newPage();
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
const G = (sel) => gun.textContent(sel).then(clean);
async function signon(team, badges) {
  await gun.goto(`${BASE}/?d=${dev.uid}`);
  await gun.waitForSelector('#scrSignon.active');
  await gun.selectOption('#fSession', String(sess.id));
  // a scanner remembers yesterday's crew until someone signs off; clear it here
  for (const chip of await gun.$$('#employeeChips button')) await chip.click();
  await gun.fill('#fTeam', team);
  for (const b of badges) { await gun.fill('#fEmployee', b); await gun.press('#fEmployee', 'Enter'); }
  /*
   * Signing on downloads the whole warehouse - 13,000 bins - and writes it to
   * the handheld's own storage before the assignment screen appears. Two things
   * used to fail a run here for reasons that were nothing to do with the crew
   * being tested: a machine busy running every other suite took longer than the
   * twenty seconds this allowed, and the download itself occasionally never
   * finished, leaving the gun sitting on the sign-on screen with nothing said.
   *
   * So: room to be slow, one honest retry, and if it still has not moved, the
   * message from the gun rather than a bare timeout. Either screen counts - a
   * crew with no aisle queued lands straight on the counting screen.
   */
  const landed = async (ms) => {
    try {
      await gun.waitForSelector('#scrAssign.active, #scrScan.active', { timeout: ms });
      return true;
    } catch { return false; }
  };
  await gun.click('#btnStart');
  if (!(await landed(45000))) {
    await gun.click('#btnStart');
    if (!(await landed(45000))) {
      throw new Error(`the gun never left the sign-on screen: ${clean(await gun.textContent('#signonMsg'))}`);
    }
  }
  await gun.waitForTimeout(500);
}

// team 2 holds F03 levels C-F and has the right kit
await signon('2', ['E1001']);
check('Gun sign-on: the right crew gets a green confirmation naming their equipment and reach',
  /Signed on: Alex Romero/.test(await G('#crewBanner')) && /Scissor lift \+ High reach truck · reaches levels A, C, D, E, F/.test(await G('#crewBanner')), (await G('#crewBanner')).slice(0, 140));
await shot(gun, 'gun-signon-ok');

// the same aisle, but only a scissor-lift operator turns up
await signon('2', ['E1002']);
let banner = await G('#crewBanner');
check('Gun sign-on: a crew that cannot reach its levels is told, with the machine named',
  /Check your equipment/.test(banner) && /reach levels C, D, E, F — that needs a high reach truck/.test(banner) && !/dock truck/.test(banner), banner.slice(0, 200));
check('Gun sign-on: the warning names the aisle and the levels it was given', /Aisle F03 was given to team 2 for levels C–F/.test(banner), banner.slice(banner.indexOf('Aisle'), banner.indexOf('Aisle') + 70));
await shot(gun, 'gun-signon-shortfall');

// a badge nobody knows, plus somebody rostered to another team
await signon('2', ['E1001', 'E9999', 'E1003']);
banner = await G('#crewBanner');
check('Gun sign-on: an unknown badge is flagged', /Not on the crew list: E9999/.test(banner), banner.slice(banner.indexOf('Not on'), banner.indexOf('Not on') + 80));
check('Gun sign-on: somebody rostered to another team is flagged', /Sam Ortiz \(E1003\) is on team 1 today, not team 2/.test(banner), banner.slice(banner.indexOf('Sam'), banner.indexOf('Sam') + 70));
check('Gun sign-on: with the right person present the shortfall clears', !/Check your equipment/.test(banner), banner.slice(0, 60));
// signing off clears the crew so the next shift scans their own badges
await gun.click('#btnSignoff'); await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(300);
check('Gun: signing off clears the crew and the team number', (await gun.$$('#employeeChips button')).length === 0 && (await gun.inputValue('#fTeam')) === '');
await shot(gun, 'gun-signon-warnings');

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} roster checks passed`);
await browser.close();
if (results.some((r) => r === false || r.ok === false)) process.exitCode = 1;
