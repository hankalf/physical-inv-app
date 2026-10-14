/*
 * The Testing Suite's tips, when the gun asks for the bin first.
 *
 * A site can put the bin before the pallet (Settings → Scanners → the order
 * of the questions). The tips then say "First, the bin", know a line was
 * saved when the gun's questions wrap round, say "Bin done" once a bin's
 * last pallet is in, and never leave the box pointing at a chip hidden under
 * the sticky header.
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hdr = { 'content-type': 'application/json' };
const tok = (await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme' }) })).json()).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const post = async (p, b = {}) => (await fetch(BASE + p, { method: 'POST', headers: A, body: JSON.stringify(b) })).json();

const layout = await post('/api/admin/scanner-layout', { order: ['bin', 'pallet', 'qty', 'lot', 'expiry'] });
check('The site asks for the bin first', layout.order[0] === 'bin', JSON.stringify(layout.order));
await post('/api/admin/practice');
await post('/api/admin/practice/mode', { mode: 'second' });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
ctx.setDefaultTimeout(10000);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/testing`); await page.fill('#fUser', 'DANA-WHITFIELD'); await page.fill('#fPassword', 'changeme'); await page.click('#btnLogin');
await page.waitForSelector('#modeList button'); await wait(2500);
if (!/Hide tips/.test(await page.textContent('#btnTips'))) await page.click('#btnTips');
/* the gun is read through the iframe's document, which never waits on a frame that is reloading */
const gun = (src) => page.evaluate((s) => { const d = document.querySelector('#gunFrame')?.contentDocument; if (!d || !d.body) return null; return (new Function('d', s))(d); }, src);
const gunClick = (sel) => gun(`const b = d.querySelector('${sel}'); if (!b) return false; b.click(); return true;`);
const scan = (text, field) => gun(`return d.defaultView.wedge(${JSON.stringify(text)}, ${field ? JSON.stringify(field) : 'undefined'});`);
const prompt = () => gun(`return (d.querySelector('#prompt') || {}).textContent || '';`);
const tip = async () => clean(await page.textContent('#coachText'));
const waitTip = async (re, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await page.isVisible('#coach') && re.test(await tip())) return true; await wait(200); } return false; };
/* the box on screen, its target lit, visible, and clear of the sticky header */
const placed = async () => page.evaluate(() => {
  const box = document.querySelector('#coach'); const t = document.querySelector('.spot');
  if (!box || box.hidden || !t) return { ok: false, why: !t ? 'no target lit' : 'box hidden' };
  const b = box.getBoundingClientRect(); const r = t.getBoundingClientRect();
  const head = document.querySelector('header')?.getBoundingClientRect().bottom || 0;
  const shown = !!t.offsetParent || !!t.closest('.gun');
  const ok = b.top >= 0 && b.bottom <= innerHeight && r.top >= head && r.bottom <= innerHeight && shown;
  return { ok, why: ok ? '' : `box ${Math.round(b.top)}, target ${Math.round(r.top)} (header ${Math.round(head)})${shown ? '' : ' target invisible'}` };
});
/* a tip about the gun itself sits over the gun column, never in the page's corner */
const overGun = () => page.evaluate(() => {
  const box = document.querySelector('#coach').getBoundingClientRect(); const gun = document.querySelector('#gunFrame').closest('.gun').getBoundingClientRect();
  return { ok: box.left >= gun.left - 2 && box.right <= gun.right + 2 && box.top >= gun.top - 2 && box.top < gun.top + 120, box: [Math.round(box.left), Math.round(box.top)], gun: [Math.round(gun.left), Math.round(gun.top), Math.round(gun.right)] };
});
const step = async (label, re) => {
  const seen = await waitTip(re);
  let p = await placed();
  for (let t = 0; t < 2000 && !p.ok; t += 200) { await wait(200); p = await placed(); }   // a new step scrolls its target into view first
  check(`${label}: the tip says so and hovers over its target`, seen && p.ok, `${(await tip()).slice(0, 90)}${p.ok ? '' : ' · ' + p.why}`);
};

/* ---- second counts, bin first */
await page.click('#modeList button[data-mode="second"]'); await wait(2500);
await step('Sign on: team', /click 99/i);
await page.locator('#teamVals .scan').first().click();
await step('Sign on: badge', /T1001/);
await page.locator('#crewVals .scan').first().click();
await step('Sign on: start', /Sign on/);
await wait(500);                       // the box slides to its place
const og = await overGun();
check('A tip about the gun sits over the gun, not in the corner of the page', og.ok, JSON.stringify(og));
await gunClick('#btnStart'); await wait(1500);
await step('The list', /Start second counts/);
await gunClick('#btnRecounts'); await wait(1000);
check('The gun asks for the bin first', /BIN/i.test(await prompt()), await prompt());
await step('Second count, bin first', /First, the bin — click F03A001/);
await scan('F03A001');
await step('…then the pallet', /Click F34511-111/);
await scan('F34511-111');
await step('…then the quantity', /quantity/i);
await scan('40'); await wait(600);
if (await gun(`const b = d.querySelector('#btnSkip'); return !!b && !b.hidden && !!b.offsetParent;`)) { await step('…comments', /Optional/); await gunClick('#btnSkip'); }
await step('After the last pallet the tip is Bin done, not the bin again', /Everything in F03A001 is counted.*Bin done/);
await gunClick('#btnRecountDone'); await wait(1200);
await step('The next bin starts with its bin again', /First, the bin — click F03A002/);
await scan('F03A002');
await step('…its first pallet', /Click F34512-111/);

/* ---- the cycle count, bin first, straight after: nothing carries over from the second count */
await gunClick('#btnToAssign'); await wait(600); await gunClick('#btnSignoff'); await wait(9500);
await page.click('#modeList button[data-mode="cycle"]'); await wait(3000);
await step('Cycle count: pick it on the gun', /tap Cycle count/);
await gunClick('#btnModeCycle');
await step('Cycle count: badge', /T1001/);
await page.locator('#modePane .scan', { hasText: /^T1001$/ }).first().click();
await step('Cycle count: start', /Sign on/);
await gunClick('#btnStart'); await wait(1500);
await step('Cycle count: the list', /Start counting the list/);
await gunClick('#btnRecounts'); await wait(1000);
await step('Cycle count: bin first', /First, the bin — click F01A001/);
await scan('F01A001');
await step('…then the pallet, not "all counted" left over from the other lesson', /Click F12311-111/);
await scan('F12311-111');
await step('…then the quantity', /quantity/i);
await scan('40'); await wait(600);
if (await gun(`const b = d.querySelector('#btnSkip'); return !!b && !b.hidden && !!b.offsetParent;`)) await gunClick('#btnSkip');
await step('Cycle count: Bin done after the last pallet', /Everything in F01A001 is counted.*Bin done/);

/* ---- the full count, bin first */
await gunClick('#btnToAssign'); await wait(600); await gunClick('#btnSignoff'); await wait(9500);
await page.click('#modeList button[data-mode="full"]'); await wait(2500);
await step('Full count: a gun left on the cycle count is told to tap Full count first', /tap Full count/);
await gunClick('#btnModeFull'); await wait(600);
await step('Full count: team', /Click 99/);
await page.locator('#teamVals .scan').first().click();
await step('Full count: badge', /T1001/);
await page.locator('#crewVals .scan').first().click();
await step('Full count: start', /Sign on/);
await gunClick('#btnStart'); await wait(1500);
await step('Full count: aisle', /Start counting/);
await gunClick('#btnCount'); await wait(800);
await step('Full count: the bin comes first', /First, the bin — click F01A001/);
/* scrolled away from a sheet target: the box docks instead of vanishing, and Show me brings the target back */
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await wait(900);
const docked = await page.$eval('#coach', (b) => ({ docked: b.classList.contains('docked'), go: !document.querySelector('#coachGo').hidden, inView: b.getBoundingClientRect().top >= 0 && b.getBoundingClientRect().bottom <= innerHeight }));
check('Scrolled away from the target, the box docks on screen with Show me', docked.docked && docked.go && docked.inView, JSON.stringify(docked));
await page.click('#coachGo'); await wait(1200);
const back = await placed();
check('Show me brings the target back into view, clear of the header', back.ok, back.why);
await page.locator('#shelves .scan', { hasText: /^F01A001$/ }).first().click();
await step('…then the pallet', /Click F12311-111/);
await page.locator('#shelves .scan', { hasText: /^F12311-111$/ }).first().click();
await step('…then the quantity', /quantity/i);
await page.locator('#shelves tr', { has: page.locator('.scan', { hasText: /^F12311-111$/ }) }).locator('.scan.qty').click(); await wait(600);
if (await gun(`const b = d.querySelector('#btnSkip'); return !!b && !b.hidden && !!b.offsetParent;`)) await gunClick('#btnSkip');
await step('Full count: on to the next bin and pallet', /First, the bin — click F01A002/);
check('No script errors', errors.length === 0, errors.join(' | '));

await post('/api/admin/scanner-layout', { order: ['pallet', 'qty', 'lot', 'expiry', 'bin'] });
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
