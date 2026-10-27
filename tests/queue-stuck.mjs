/*
 * "1 count still on this scanner" only for a line that can still send.
 *
 * A line voided before it sent, or one for a count that has been deleted, is
 * never going anywhere: it must not hold the queue up or nag the crew. A line
 * whose count was closed before it sent is a real count - it keeps trying, the
 * gun says that reopening the count lets it in, and it sends once it is open.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

const bins = Array.from({ length: 6 }, (_, i) => `Q01A${String(i + 1).padStart(3, '0')}`);
const S = (await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'Queue count' }) }))).id;
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location,Zone,Aisle\n' + bins.map((b) => `${b},Dry,Q01`).join('\n') + '\n' });
await fetch(`${BASE}/api/admin/sessions/${S}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Pallet ID,SKU,Description,Qty,Location\n' + bins.map((b, i) => `QP-${i + 1},SKU-${i + 1},Item ${i + 1},${10 + i},${b}`).join('\n') + '\n' });
await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ order: ['bin', 'pallet', 'qty'] }) });
await fetch(`${BASE}/api/admin/sessions/${S}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: true, askComments: false, autoRecount: false }) });
await fetch(`${BASE}/api/admin/sessions/${S}/assignments`, { method: 'POST', headers: A, body: JSON.stringify({ team: '7', aisles: 'Q01', levels: 'A-F', force: true }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'QUEUE-01' }) }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 400, height: 780 } });
const errors = [];
const gun = await ctx.newPage();
gun.on('pageerror', (e) => errors.push('gun: ' + e.message));
gun.on('dialog', (d) => d.accept());
const scan = async (v) => {
  await gun.waitForSelector('#scrScan.active #fScan', { timeout: 5000 });
  await gun.fill('#fScan', v); await gun.press('#fScan', 'Enter');
  await gun.waitForFunction(() => document.getElementById('fScan').value === '', null, { timeout: 5000 }).catch(() => {});
  await gun.waitForTimeout(260);
};
const countBin = async (i) => { await scan(bins[i]); await scan(`QP-${i + 1}`); await scan(String(10 + i)); };
const offline = async () => { await ctx.setOffline(true); await gun.evaluate(() => window.dispatchEvent(new Event('offline'))); };
const online = async () => { await ctx.setOffline(false); await gun.evaluate(() => window.dispatchEvent(new Event('online'))); await gun.waitForTimeout(1500); };
/* the lines on this gun, straight from its store */
const lines = () => gun.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('invcount');
  req.onsuccess = () => { const all = req.result.transaction('lines', 'readonly').objectStore('lines').getAll(); all.onsuccess = () => resolve(all.result); all.onerror = () => resolve([]); };
}));
/* a shift in a freezer: every unsent line twenty minutes old, so the gun would nag about it */
const age = () => gun.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('invcount');
  req.onsuccess = () => {
    const os = req.result.transaction('lines', 'readwrite').objectStore('lines');
    const all = os.getAll();
    all.onsuccess = () => { for (const l of all.result) if (!l.synced) os.put({ ...l, ts: new Date(Date.now() - 20 * 60000).toISOString() }); resolve(); };
  };
}));
const chip = () => gun.$eval('#chipQueue', (el) => (el.hidden ? '' : el.textContent));
const bar = () => gun.$eval('#queueBar', (el) => (el.hidden ? '' : el.textContent.replace(/\s+/g, ' ').trim()));
const look = async () => { await gun.evaluate(() => window.dispatchEvent(new Event('online'))); await gun.waitForTimeout(1500); };

await gun.goto(`${BASE}/?d=${dev.uid}`);
await gun.waitForSelector('#scrSignon.active'); await gun.waitForTimeout(500);
await gun.selectOption('#fSession', String(S));
await gun.fill('#fTeam', '7');
await gun.fill('#fEmployee', 'E7001'); await gun.press('#fEmployee', 'Enter');
await gun.click('#btnStart'); await gun.waitForSelector('#scrAssign.active'); await gun.waitForTimeout(500);
await gun.click('#btnCount'); await gun.waitForSelector('#scrScan.active'); await gun.waitForTimeout(300);

/* 1 - counted with no signal, voided before it ever sent */
await offline();
await countBin(0);
check('A line counted with no signal waits on the gun', /1 queued/.test(await chip()), await chip());
await gun.click('#btnHistory'); await gun.waitForSelector('#scrHistory.active'); await gun.waitForTimeout(300);
await gun.locator('#historyList .item', { hasText: 'Q01A001' }).locator('button').click(); await gun.waitForTimeout(700);
await age();
await online();
check('Voided before it sent: nothing is waiting any more', !(await chip()), await chip());
check('…and the gun does not say a count is still on it', !(await bar()), await bar());
const office1 = (await j(await fetch(`${BASE}/api/admin/sessions/${S}/pallets?limit=50`, { headers: A }))).rows.find((r) => r.pallet_id === 'QP-1');
check('…and the office never got the voided line', office1 && !Number(office1.counted_qty ?? office1.counted ?? 0), JSON.stringify(office1 && { status: office1.status, counted: office1.counted_qty ?? office1.counted }));

/* 2 - counted with no signal; the count is closed before it sends */
if (!(await gun.isVisible('#scrScan.active'))) { await gun.click('#btnBack').catch(() => {}); await gun.waitForTimeout(300); }
await offline();
await countBin(1);
await age();
await fetch(`${BASE}/api/admin/sessions/${S}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'closed' }) });
await online();
await gun.waitForFunction(() => /was closed/.test(document.getElementById('queueBar').textContent) && !document.getElementById('queueBar').hidden, null, { timeout: 30000 }).catch(() => {});
check('Its count closed before it sent: the gun still holds it', /1 queued/.test(await chip()), await chip());
check('…and says which count, and that reopening it lets the line in', new RegExp(`Count #${S} was closed before it sent\\. A supervisor reopens that count`).test(await bar()), await bar());
check('…the line marked with why', (await lines()).some((l) => l.palletId === 'QP-2' && l.held === 'closed' && !l.synced));
await fetch(`${BASE}/api/admin/sessions/${S}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'open' }) });
await look();
await gun.waitForFunction(() => document.getElementById('queueBar').hidden, null, { timeout: 30000 }).catch(() => {});
check('Reopened: the line sends by itself and the warning goes', !(await bar()) && !(await chip()), `${await bar()} ${await chip()}`);
const office2 = (await j(await fetch(`${BASE}/api/admin/sessions/${S}/pallets?limit=50`, { headers: A }))).rows.find((r) => r.pallet_id === 'QP-2');
check('…and the office has it', office2 && Number(office2.counted_qty ?? office2.counted ?? office2.qty) === 11, JSON.stringify(office2 && { status: office2.status, counted: office2.counted_qty ?? office2.counted }));
check('…no longer marked', (await lines()).some((l) => l.palletId === 'QP-2' && l.synced === 1 && !l.held));

/* 3 - a line for a count that has since been deleted (a training count removed) */
const gone = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'Thrown away' }) }));
await fetch(`${BASE}/api/admin/sessions/${gone.id}/status`, { method: 'POST', headers: A, body: JSON.stringify({ status: 'closed' }) });
const del = await fetch(`${BASE}/api/admin/sessions/${gone.id}`, { method: 'DELETE', headers: A, body: JSON.stringify({ confirmName: 'Thrown away' }) });
check('A count with nothing in it, closed, is deleted', del.ok, `${del.status} ${del.ok ? '' : (await del.text()).slice(0, 120)}`);
await gun.evaluate((sid) => new Promise((resolve) => {
  const req = indexedDB.open('invcount');
  req.onsuccess = () => {
    const t = req.result.transaction('lines', 'readwrite');
    t.objectStore('lines').put({ clientId: 'orphan-1', sessionId: sid, palletId: 'QP-9', qty: 3, location: 'Q01A006', team: '7', employees: ['E7001'], deviceId: 'QUEUE-01', aisle: 'Q01', pass: 1, ts: new Date(Date.now() - 30 * 60000).toISOString(), synced: 0, voidedLocal: false });
    t.oncomplete = () => resolve();
  };
}), gone.id);
await look();
await gun.waitForFunction(() => document.getElementById('chipQueue').hidden, null, { timeout: 30000 }).catch(() => {});
check('Its count deleted: the line stops holding the queue up', !(await chip()) && !(await bar()), `${await chip()} ${await bar()}`);
const orphan = (await lines()).find((l) => l.clientId === 'orphan-1');
check('…kept on the gun, marked with why', orphan && orphan.held === 'removed' && !orphan.synced, JSON.stringify(orphan && { held: orphan.held, synced: orphan.synced, sessionId: orphan.sessionId, gone: gone.id }));

/* the same warning in Spanish */
await gun.evaluate(() => window.i18n && window.i18n.set('es'));
const es = await gun.evaluate((n) => window.i18n.t(`Count #${n} was closed before it sent. A supervisor reopens that count for a minute and it sends by itself.`), S);
check('The closed-count warning reads in Spanish', new RegExp(`^El conteo #${S} se cerró antes de enviarlo\\. Un supervisor vuelve a abrir ese conteo un minuto y se envía solo\\.$`).test(es), es);

check('No page errors', !errors.length, errors.join(' | '));
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
