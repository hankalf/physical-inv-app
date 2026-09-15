import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (step, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
let shotN = 0;
const shot = async (t, n) => { await t.screenshot({ path: `${S}screenshots/c${String(++shotN).padStart(2, '0')}-${n}.png` }); };

const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const { token } = await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }));
const A = { ...hdr, authorization: 'Bearer ' + token };

// a cycle-count session with the real bin list; some bins carry an ERP last-count date
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: '2026 cycle counts', mode: 'cycle' }) }));
check('Cycle: session created in cycle mode', sess.mode === 'cycle' && sess.guided === 0, `mode=${sess.mode} guided=${sess.guided}`);
let bins = readFileSync(new URL('../public/templates/front-royal-bins.csv', import.meta.url).pathname, 'utf8').split('\n');
// give a quarter of the rack bins an old ERP date, and a handful a recent one
const header = bins[0] + ',Last Phys. Invt. Date';
const rows = bins.slice(1).filter(Boolean).map((line, i) => {
  if (!/^F\d\d[A-F]\d\d\d,/.test(line)) return line + ',';
  if (i % 4 === 0) return line + ',1/15/2026';
  if (i % 97 === 0) return line + `,${new Date().toISOString().slice(0, 10)}`;
  return line + ',';
});
const up = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/csv' }, body: [header, ...rows].join('\n') }));
check('Cycle: bin list imports the ERP Last Phys. Invt. Date column', up.withDates > 3000, `${up.withDates} bins with a date`);
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ layout: 'front-royal' }) });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/csv' }, body: readFileSync(`${S}fixtures/pallets.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'a full count too' }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'CYCLE-01' }) }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const admin = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1.25 });
admin.on('pageerror', (e) => errors.push('admin: ' + e.message));
admin.on('console', (m) => { if (m.type() === 'error' && !/40[19]/.test(m.text())) errors.push('admin: ' + m.text()); });
admin.on('dialog', (d) => d.accept());
await admin.goto(BASE + '/cycle');
await admin.fill('#fPassword', 'changeme'); await admin.click('#btnLogin');
await admin.waitForSelector('#scrMain.active'); await admin.waitForTimeout(400);
await admin.selectOption('#fSessionPick', String(sess.id)); await admin.waitForTimeout(2500);
check('Cycle page: /cycle lists only cycle-count programmes', await admin.title() === 'Cycle Counts' && (await admin.$$eval('#fSessionPick option', (o) => o.length)) === 1);
const stats = clean(await admin.textContent('#cycleStats'));
check('Cycle page: coverage stats from the ERP dates', /Counted within 90 days/.test(stats) && /Never counted/.test(stats) && /Bins\/day to stay covered/.test(stats), stats.slice(0, 160));
check('Cycle page: the site clock is shown', /America\/New_York/.test(clean(await admin.textContent('#clockChip'))), clean(await admin.textContent('#clockChip')));

await admin.fill('#fCycBins', '25'); await admin.click('#btnCycPreview'); await admin.waitForTimeout(700);
const prev = clean(await admin.textContent('#cycleMsg'));
check('Cycle page: preview says what would be picked, without generating', /25 bins would be picked/.test(prev) && /Nothing generated yet/.test(prev), prev.slice(0, 170));
check('Cycle page: the oldest-first strategy picks never-counted bins first', /never counted/.test(prev), prev.slice(prev.indexOf('From'), prev.indexOf('From') + 80));

await admin.click('#btnCycGenerate'); await admin.waitForTimeout(1500);
check('Cycle page: batch generated', /Generated 25 bins/.test(clean(await admin.textContent('#cycleMsg'))), clean(await admin.textContent('#cycleMsg')).slice(0, 90));
const batches = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/cycle/batches`, { headers: A }));
check('Cycle: batch row records the pick rule and progress', batches.batches[0].bins === 25 && batches.batches[0].done === 0 && batches.batches[0].strategy === 'oldest', JSON.stringify({ bins: batches.batches[0].bins, done: batches.batches[0].done }));
await admin.$eval('#generateCard', (el) => el.scrollIntoView()); await admin.waitForTimeout(300);
await shot(await admin.$('#generateCard'), 'admin-cycle');
await shot(await admin.$('#coverageCard'), 'admin-coverage');

// generating again must not re-pick the same bins
await admin.fill('#fCycBins', '10'); await admin.click('#btnCycGenerate'); await admin.waitForTimeout(1200);
const all = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/cycle/batches`, { headers: A }));
const tasks = await j(await fetch(`${BASE}/api/sessions/${sess.id}/recounts?team=7`));
const binSet = new Set(tasks.tasks.map((t) => t.bin));
check('Cycle: a second batch never re-picks a bin already on an open list', tasks.tasks.length === 35 && binSet.size === 35, `${tasks.tasks.length} tasks, ${binSet.size} distinct bins`);
check('Cycle: the gun is told it is a cycle count', tasks.tasks.every((t) => t.kind === 'cycle' && t.reason === 'Cycle count'));

// a counter works the list
const ctx = await browser.newContext({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 2 });
const gun = await ctx.newPage();
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
const T = (sel) => gun.textContent(sel).then(clean);
const scan = async (v) => { await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter'); await gun.waitForTimeout(260); };
await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active');
await gun.waitForTimeout(400);
check('Gun: sign-on offers a choice of full count or cycle count', (await gun.getAttribute('#modePick', 'hidden')) === null, 'both kinds are running');
await gun.click('#btnModeCycle'); await gun.waitForTimeout(300);
check('Gun: choosing Cycle count narrows the list to cycle programmes',
  (await gun.$$eval('#fSession option', (o) => o.map((x) => x.textContent))).every((t) => /cycle/i.test(t)),
  (await gun.$$eval('#fSession option', (o) => o.map((x) => x.textContent))).join(' | '));
await gun.selectOption('#fSession', String(sess.id));
await gun.fill('#fTeam', '7'); await gun.fill('#fEmployee', 'E7001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active', { timeout: 20000 });
check('Gun: a cycle session shows the list instead of an aisle', /Cycle count/.test(await T('#recountCardTitle')) && (await T('#recountCount')) === '35' && (await gun.getAttribute('#btnCount', 'hidden')) !== null, `${await T('#recountCount')} bins`);
await shot(gun, 'gun-cycle-list');
await gun.click('#btnRecounts'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(400);
const banner = await T('#recountBanner');
const firstBin = await gun.getAttribute('#recountBanner', 'data-bin');
check('Gun: task banner says CYCLE COUNT and where the bin is', /^CYCLE COUNT · bin/.test(banner) && /Level [A-F] · Position \d+ · (FRONT|BACK)/.test(banner), banner.slice(0, 110));
await shot(gun, 'gun-cycle-banner');
// an empty bin finishes the task; the next one comes straight up
await gun.click('#btnEmpty'); await scan(firstBin); await gun.waitForTimeout(900);
check('Gun: empty bin completes the task and the next bin comes up', /CYCLE COUNT · bin/.test(await T('#recountBanner')) && (await gun.getAttribute('#recountBanner', 'data-bin')) !== firstBin, `${firstBin} -> ${await gun.getAttribute('#recountBanner', 'data-bin')}`);
// a bin with stock: the line is a first count, not a second
const secondBin = await gun.getAttribute('#recountBanner', 'data-bin');
await scan('PLT01001A'); await scan('40'); await scan(secondBin);
await gun.click('#btnSkip'); await gun.waitForTimeout(300);
await gun.click('#btnRecountDone'); await gun.waitForTimeout(900);
const counts = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/pallets?limit=5`, { headers: A }));
check('Cycle: a cycle-count line is a first count (pass 1), not a second count', counts.rows.every((r) => !r.recounted), JSON.stringify(counts.rows.map((r) => r.recounted)));
const after = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/cycle/batches`, { headers: A }));
check('Cycle: batch progress and coverage move as bins are done', after.batches.reduce((n, b) => n + b.done, 0) === 2 && after.coverage.recent >= 2, `done=${after.batches.reduce((n, b) => n + b.done, 0)} recent=${after.coverage.recent}`);
const cov = await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/coverage.csv`, { headers: A })).text();
check('Cycle: coverage CSV lists every bin oldest-first', cov.split('\n').length > 13000 && /^aisle,bin,level,zone,last_counted/.test(cov), cov.split('\n')[1]);

// the two counted bins must not come back in the next batch
await admin.fill('#fCycBins', '5'); await admin.click('#btnCycGenerate'); await admin.waitForTimeout(1200);
const t2 = await j(await fetch(`${BASE}/api/sessions/${sess.id}/recounts?team=7`));
check('Cycle: bins counted today are not picked again', !t2.tasks.some((t) => t.bin === firstBin || t.bin === secondBin), `${t2.tasks.length} open`);

// schedule
await admin.check('#fCycAuto'); await admin.fill('#fCycSchedBins', '60'); await admin.fill('#fCycHour', '5');
await admin.click('#btnCycSchedule'); await admin.waitForTimeout(900);
check('Cycle page: schedule saved', /60 bins every weekday from 5:00 site time/.test(clean(await admin.textContent('#cycleMsg'))), clean(await admin.textContent('#cycleMsg')));
const run1 = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/cycle/run-schedule`, { method: 'POST', headers: A, body: '{}' }));
const run2 = await j(await fetch(`${BASE}/api/admin/sessions/${sess.id}/cycle/run-schedule`, { method: 'POST', headers: A, body: '{}' }));
const health = await j(await fetch(`${BASE}/api/health`));
check('Cycle: batches are dated by the warehouse clock, not the server\'s', batches.batches[0].due_date === health.siteDate && health.siteTimezone === 'America/New_York', `batch ${batches.batches[0].due_date}, site ${health.siteDate} (${health.siteTimezone}), server ${new Date().toISOString().slice(0, 10)}`);
check('Cycle: the schedule generates once for a due date, never twice', run1.generated.length === 1 && run2.generated.length === 0, `first ${JSON.stringify(run1.generated)} second ${JSON.stringify(run2.generated)}`);

/* the same equipment check, against the levels of the bins on the list */
await fetch(`${BASE}/api/admin/people/employees`, { method: 'POST', headers: A, body: JSON.stringify({ badge: 'C001', name: 'Pat Lowe', dept: 'Freezer', equipment: ['SCISSOR LIFT'] }) });
const t7 = await j(await fetch(`${BASE}/api/sessions/${sess.id}/recounts?team=7`));
const levels = [...new Set(t7.tasks.map((t) => t.bin.replace(/^[A-Z]+\d+/, '')[0]))].sort().join('');
await gun.goto(`${BASE}/?d=${dev.uid}`); await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(400);
for (const chip of await gun.$$('#employeeChips button')) await chip.click();
await gun.click('#btnModeCycle'); await gun.waitForTimeout(200);
await gun.selectOption('#fSession', String(sess.id));
await gun.fill('#fTeam', '7'); await gun.fill('#fEmployee', 'C001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active', { timeout: 20000 }); await gun.waitForTimeout(600);
const crewBanner = clean(await gun.textContent('#crewBanner'));
check('Gun: the equipment check runs on a cycle count too, against the bins on the list',
  /Check your equipment/.test(crewBanner) && /the bins on your list/.test(crewBanner) && /high reach truck|dock truck/.test(crewBanner), crewBanner.slice(0, 190));
await shot(gun, 'gun-cycle-crewcheck');

console.log('\nerrors:', errors.length ? errors : 'none');
console.log(`\n${results.filter(Boolean).length}/${results.length} cycle checks passed`);
await browser.close();
if (results.some((r) => r === false || r.ok === false)) process.exitCode = 1;
