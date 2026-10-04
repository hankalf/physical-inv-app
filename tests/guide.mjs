/*
 * The user guide.
 *
 * A page for new users that follows the SOP's journeys, says what tends to go
 * wrong at each step, answers a typed question or a pasted screen message,
 * and reads the count in the picker to say what is missing. Every login may
 * open it; it only links to pages that login can open.
 */
import { chromium } from 'playwright-core';
import { signIn, pickSession } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const hdr = { 'content-type': 'application/json' };
const login = async (body) => (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify(body) })).json()).token;
const tok = await login({ username: 'DANA-WHITFIELD', password: 'changeme' });
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = async (p, body = {}) => (await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(body) })).json();

/* ------------------------------------------------------------ the page is served */
const html = await (await fetch(`${BASE}/guide`)).text();
check('/guide serves the guide page', /<title>User guide<\/title>/.test(html));
const content = await (await fetch(`${BASE}/guide-content.js`)).text();
check('The content module ships', content.includes('window.GUIDE'));
const countOf = (re) => (content.match(re) || []).length;
check('…with nine journeys', countOf(/\n    {\n      key: '/g) === 9, String(countOf(/\n    {\n      key: '/g)));
check('…dozens of predicted issues', countOf(/\{ see: /g) >= 80, String(countOf(/\{ see: /g)));
check('…and dozens of questions', countOf(/\{ q: /g) >= 35, String(countOf(/\{ q: /g)));

/* a count with nothing on it, and one set up, to read "right now" from */
const bare = await post('/api/admin/sessions', { name: 'Guide bare' });
const ready = await post('/api/admin/sessions', { name: 'Guide ready' });
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };
await fetch(`${BASE}/api/admin/sessions/${ready.id}/master?kind=bins`, { method: 'POST', headers: csv, body: 'Bin Location\nF01A001\nF01A002\nF02A001\nF02A002\n' });
await fetch(`${BASE}/api/admin/sessions/${ready.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: 'Bin Code,Container No.,Item No.,Description,Variant Code,Quantity,Unit of Measure Code,Entry No.,Lot No.,System\nF01A001,P-1,SKU-1,Mango chunks,,40,CS,1,L1,ERP\n' });
await post('/api/admin/sessions/' + ready.id + '/settings', { autoRecount: true, recountMinQty: 0, recountMinPct: 0, recountCap: 0 });

/* a login with only the dashboard's progress tab */
await post('/api/admin/users', { username: 'GUIDE-READER', name: 'Guide Reader', password: 'read-only-99', mustChange: false, access: ['dashboard.progress'] });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${BASE}/guide`);
await signIn(page, { user: 'DANA-WHITFIELD' });
await page.waitForSelector('#journeys .journey');

/* ------------------------------------------------------------ sidebar and journeys */
check('The sidebar lists the guide under Learn', await page.$eval('#navTabs', (n) => n.textContent.includes('User guide') && n.textContent.includes('Learn')));
check('…and the brand banner spans the panel, edge to edge', await page.evaluate(() => {
  const side = document.querySelector('.side').getBoundingClientRect();
  const b = document.querySelector('.side .brand').getBoundingClientRect();
  return Math.abs(b.left - side.left) < 2 && Math.abs(b.right - side.right) < 2 && b.top <= side.top + 1;
}));
const journeys = await page.$$eval('#journeys .journey .t', (ns) => ns.map((n) => n.textContent));
check('Nine journeys, first day first', journeys.length === 9 && journeys[0] === 'Your first day', journeys.join(' | '));
const firstSteps = await page.$$eval('#steps .step h3', (ns) => ns.map((n) => n.textContent));
check('The first journey opens with its steps', firstSteps.length === 4 && /Sign in/.test(firstSteps[0]), firstSteps.join(' | '));
check('A step carries what goes wrong and what people ask', await page.$eval('#steps .step', (s) => s.querySelectorAll('.issue').length >= 1 && s.querySelectorAll('.askq').length >= 1));
check('…and a link to the page it is about', await page.$eval('#steps .step a.go', (a) => /Dashboard/.test(a.textContent)));

await page.click('#journeys .journey[data-key="count"]');
await page.waitForTimeout(200);
const countSteps = await page.$$eval('#steps .step h3', (ns) => ns.map((n) => n.textContent));
check('Picking "Set up a count" shows its six steps', countSteps.length === 6 && /inventory report/.test(countSteps.join(' ')), countSteps.join(' | '));
check('…with the site’s report columns named', await page.$eval('#steps', (n) => n.textContent.includes('Container No.') && n.textContent.includes('Unit of Measure Code')));

/* ticks stay in the browser */
await page.click('#steps .step:first-child .tick input');
await page.waitForTimeout(150);
check('Ticking a step marks it done and counts on the journey', await page.$eval('#steps .step:first-child', (s) => s.classList.contains('done')) && await page.$eval('#journeys .journey.on .p', (n) => /1 of 6/.test(n.textContent)));
await page.reload();
await page.waitForSelector('#journeys .journey');
await page.waitForTimeout(300);
check('…and the tick is still there after a reload, on the same journey', await page.$eval('#journeys .journey.on', (n) => n.dataset.key === 'count' && /1 of 6/.test(n.textContent)));

/* ------------------------------------------------------------ asking */
const askFor = async (q) => {
  await page.fill('#askInput', '');
  await page.fill('#askInput', q);
  await page.waitForTimeout(150);
  return page.$$eval('#answers .answer', (ns) => ns.map((n) => ({ q: n.querySelector('.q').textContent, kind: n.dataset.kind, from: n.querySelector('.from').textContent })));
};
let hits = await askFor('the gun says offline did we lose the counts');
check('A worried question finds the offline answer first', hits.length && /OFFLINE|lose the counts/i.test(hits[0].q), hits.map((h) => h.q).join(' | '));
hits = await askFor('this scanner is no longer authorised - ask a supervisor for its link');
check('A pasted server message finds its own row', hits.length && hits[0].q.includes('this scanner is no longer authorised - ask a supervisor for its link') && hits[0].kind === 'issue', hits.map((h) => h.q).join(' | '));
hits = await askFor('how do I approve adjustments');
check('"approve adjustments" lands on the approvals step', hits.some((h) => /Approve the adjustments|Adjustments tab/.test(h.q)), hits.map((h) => h.q).join(' | '));
hits = await askFor('second count list is huge');
check('"second count list is huge" explains the thresholds', hits.some((h) => /enormous|thresholds/i.test(h.q)), hits.map((h) => h.q).join(' | '));
hits = await askFor('wifi');
check('"wifi" reads as signal and finds the no-signal rows first', hits.length >= 2 && /signal/i.test(hits[0].q) && /signal|offline/i.test(hits[1].q), hits.map((h) => h.q).join(' | '));
hits = await askFor('zzqx plumbus');
check('Nonsense gets a plain "nothing matches"', !hits.length && await page.$eval('#answers', (n) => /Nothing in the guide matches/.test(n.textContent)));
await page.fill('#askInput', 'which bin is next');
await page.waitForTimeout(150);
await page.click('#answers .answer a.go:not([href^="/board"])');
await page.waitForTimeout(400);
check('An answer’s link opens that page', !/\/guide/.test(page.url()), page.url());
await page.goto(`${BASE}/guide`);
await page.waitForSelector('#journeys .journey');

/* ------------------------------------------------------------ right now */
await pickSession(page, bare.id);
await page.waitForSelector('#nowList .check');
let checks = await page.$$eval('#nowList .check', (ns) => ns.map((n) => n.className.replace('check ', '') + ':' + n.querySelector('.t').textContent));
check('An empty count: the bin list and the counting plan are flagged as missing', checks.some((c) => /bad:Upload the bin list/.test(c)) && checks.some((c) => /bad:Queue the aisles/.test(c)), checks.join(' | '));
check('…the inventory report as wanted, not required', checks.some((c) => /warn:Upload the inventory report/.test(c)), checks.join(' | '));
check('…and the questions people ask about the bin list are offered', await page.$eval('#nowAsk', (n) => /wipe the counts|DOORS and WIP/.test(n.textContent)));

await pickSession(page, ready.id);
await page.waitForTimeout(500);
checks = await page.$$eval('#nowList .check', (ns) => ns.map((n) => n.className.replace('check ', '') + ':' + n.querySelector('.t').textContent));
check('A count with lists: the bin list is no longer flagged', !checks.some((c) => /Upload the bin list/.test(c)), checks.join(' | '));
check('…but 0/0/0 thresholds with auto recount on are', checks.some((c) => /warn:Second-count thresholds are all 0/.test(c)), checks.join(' | '));
check('…and the heading names the count', await page.$eval('#nowWhich', (n) => /Guide ready/.test(n.textContent)));

/* ------------------------------------------------------------ a limited login */
await page.evaluate(() => window.appApi.logout());
await page.waitForSelector('#scrLogin.active');
await page.goto(`${BASE}/guide`);
await signIn(page, { user: 'GUIDE-READER', password: 'read-only-99' });
await page.waitForSelector('#journeys .journey');
check('A progress-only login can still open the guide', /\/guide/.test(page.url()) && await page.$eval('#navTabs', (n) => n.textContent.includes('User guide') && !n.textContent.includes('Settings')));
await page.click('#journeys .journey[data-key="site"]');
await page.waitForTimeout(200);
check('…and its links to Settings are replaced by "ask an admin"', await page.$eval('#steps', (n) => n.querySelectorAll('.noway').length >= 5 && ![...n.querySelectorAll('a.go')].some((a) => a.getAttribute('href').startsWith('/settings'))));
await page.click('#journeys .journey[data-key="first"]');
await page.waitForTimeout(200);
check('…while the dashboard link it may open stays a link', await page.$eval('#steps', (n) => [...n.querySelectorAll('a.go')].some((a) => a.getAttribute('href').startsWith('/admin'))));
await pickSession(page, bare.id);
await page.waitForSelector('#nowList .check');
check('"Right now" still works for it, from what it may read', await page.$$eval('#nowList .check', (ns) => ns.length >= 1));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
