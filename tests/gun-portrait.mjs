/*
 * The gun stays upright.
 *
 * These are portrait handhelds held one-handed at a rack face, and a screen
 * that flips to landscape halfway down an aisle is unusable - the prompt goes
 * small, the keypad covers it and a counter has to stop and turn the gun.
 *
 * A browser tab cannot lock the screen: the orientation API only answers an app
 * that owns the screen, which means installed or full screen, so on the guns
 * running straight from Chrome the lock is refused every time and nothing used
 * to happen. So the app turns itself back instead - a quarter turn the other
 * way from however the device turned, purely visual, with every scan, tap and
 * countdown carrying on as before.
 *
 * Playwright cannot rotate a phone, so these fake what the device reports:
 * screen.orientation.angle is what the app reads, and the viewport is the
 * landscape screen the device has given the page.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const S = new URL('.', import.meta.url).pathname;
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const tok = (await j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: hdr, body: JSON.stringify({ password: 'changeme', name: 'Dana' }) }))).token;
const A = { ...hdr, authorization: 'Bearer ' + tok };
const csv = { authorization: 'Bearer ' + tok, 'content-type': 'text/csv' };

/* ---------------- the setting ---------------- */
const def = await j(await fetch(`${BASE}/api/admin/scanner-layout`, { headers: A }));
check('It ships holding the gun upright', def.portrait === true && def.isDefault === true, String(def.portrait));
const off = await j(await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ portrait: false, textSize: 'large' }) }));
check('A site that wants the device to decide can turn it off', off.portrait === false, String(off.portrait));
const back = await j(await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ portrait: true }) }));
check('...and turn it back on, without losing the rest of the screen settings',
  back.portrait === true && back.textSize === 'large', `${back.portrait}, ${back.textSize}`);

/* An installed app is held upright by the manifest, and "portrait" alone is
   both ways up - a gun flipped end over end would be held upside down. */
const manifest = await j(await fetch(`${BASE}/manifest.webmanifest`));
check('The installed app asks for one way up, not either way up', manifest.orientation === 'portrait-primary', manifest.orientation);

/* ---------------- the count these scanners are on ---------------- */
const sess = await j(await fetch(`${BASE}/api/admin/sessions`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'upright test' }) }));
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=bins`, { method: 'POST', headers: csv, body: readFileSync(`${S}../public/templates/front-royal-bins.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/master?kind=pallets`, { method: 'POST', headers: csv, body: readFileSync(`${S}fixtures/pallets.csv`, 'utf8') });
await fetch(`${BASE}/api/admin/sessions/${sess.id}/settings`, { method: 'POST', headers: A, body: JSON.stringify({ guided: false, askComments: false }) });
const dev = await j(await fetch(`${BASE}/api/admin/devices`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'UPRIGHT-01' }) }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];

/**
 * A handheld reporting itself turned by `angle`, on the screen the device hands
 * a page once it has turned - short and wide.
 */
async function handheld({ angle = 0, width = 640, height = 360, touch = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 2 });
  /* The device's own screen, pinned: Playwright moves the emulated screen with
     the window, and the whole point of the keyboard case is that a real handheld
     does not. */
  await ctx.addInitScript(`
    Object.defineProperty(screen.orientation, 'angle', { get: () => ${angle}, configurable: true });
    Object.defineProperty(screen, 'width', { get: () => ${width}, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => ${height}, configurable: true });
  `);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/?d=${dev.uid}`);
  await page.waitForSelector('#scrSignon.active');
  await page.waitForTimeout(700);
  return page;
}

const bodyClass = (p) => p.$eval('body', (b) => b.className);
/** Where the page has actually landed on the screen, after any turning. */
const bodyBox = (p) => p.evaluate(() => {
  const r = document.body.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
});
const fills = (box, w, h) => Math.abs(box.x) <= 1 && Math.abs(box.y) <= 1 && Math.abs(box.w - w) <= 1 && Math.abs(box.h - h) <= 1;

/* ---------------- turned left ---------------- */
{
  const p = await handheld({ angle: 90 });
  const cls = await bodyClass(p);
  check('A handheld that has turned left is turned back the other way',
    /\bupright\b/.test(cls) && /\bturn-ccw\b/.test(cls), cls);
  const box = await bodyBox(p);
  check('...and the turned page lands square on the screen, not half off it',
    fills(box, 640, 360), JSON.stringify(box));
  check('...so it is laid out portrait: taller than it is wide',
    await p.evaluate(() => document.body.offsetHeight > document.body.offsetWidth),
    await p.evaluate(() => `${document.body.offsetWidth}x${document.body.offsetHeight}`));
  check('...and the sideways "hold it upright" nag is gone, because it is not sideways any more',
    !(await p.evaluate(() => getComputedStyle(document.body, '::before').content.includes('upright'))));
  await p.context().close();
}

/* ---------------- turned right ---------------- */
{
  const p = await handheld({ angle: 270 });
  const cls = await bodyClass(p);
  check('A handheld that has turned right is turned back the other way again',
    /\bupright\b/.test(cls) && /\bturn-cw\b/.test(cls), cls);
  check('...and that one lands square on the screen too', fills(await bodyBox(p), 640, 360), JSON.stringify(await bodyBox(p)));
  await p.context().close();
}

/* ---------------- end over end ---------------- */
{
  /* The one the first cut of this missed: flipped end over end, a handheld
     reports a half turn and hands the page a screen that is still tall. Nothing
     about the shape of it says anything is wrong - and the counter is reading
     the whole app upside down. */
  const p = await handheld({ angle: 180, width: 360, height: 640 });
  const cls = await bodyClass(p);
  check('A handheld turned end over end is turned back the right way up',
    /\bupright\b/.test(cls) && /\bturn-180\b/.test(cls), cls);
  check('...and it still fills the screen, the same way up as the device',
    fills(await bodyBox(p), 360, 640), JSON.stringify(await bodyBox(p)));
  await p.context().close();
}

/* ---------------- a device that never says which way it turned ---------------- */
{
  /* Not every handheld updates the orientation angle. Some just hand the page a
     screen wider than it is tall and say nothing, and waiting for an angle that
     never comes means waiting all shift. */
  const p = await handheld({ angle: 0, width: 640, height: 360 });
  check('A gun that has plainly gone sideways is turned back even when it never says so',
    /\bupright\b/.test(await bodyClass(p)), await bodyClass(p));
  check('...and lands square on the screen like any other turn', fills(await bodyBox(p), 640, 360), JSON.stringify(await bodyBox(p)));
  await p.context().close();
}

/* ---------------- already upright ---------------- */
{
  const p = await handheld({ angle: 0, width: 360, height: 640 });
  check('A gun held the way it is meant to be is left alone', !/\bupright\b/.test(await bodyClass(p)), await bodyClass(p));
  check('...and the sign-on screen says what this handheld is doing, for a gun that still reads sideways',
    /Screen 360.640, window 360.640, device turned 0. - upright already/.test(clean(await p.textContent('#screenInfo'))), clean(await p.textContent('#screenInfo')));
  await p.context().close();
}

/* ---------------- the keyboard is not a rotation ---------------- */
{
  /* Typing a clock-in number opens the on-screen keyboard, which takes half the
     window with it. For a moment the window is wider than it is tall - and a
     rule that reads the window rather than the screen turns the whole app
     sideways while somebody is mid-number. The screen never moved. */
  const p = await handheld({ angle: 0, width: 360, height: 640 });
  await p.setViewportSize({ width: 360, height: 300 });   // keyboard up: window now wider than tall
  await p.waitForTimeout(300);
  check('A keyboard opening is not a rotation — the app stays as it is',
    !/\bupright\b/.test(await bodyClass(p)), await bodyClass(p));
  check('...and the screen line says so: the screen is still tall, only the window shrank',
    /Screen 360.640, window 360.300/.test(clean(await p.textContent('#screenInfo'))), clean(await p.textContent('#screenInfo')));
  await p.setViewportSize({ width: 360, height: 640 });
  await p.waitForTimeout(300);
  check('...and it is still not turned once the keyboard goes away', !/\bupright\b/.test(await bodyClass(p)), await bodyClass(p));
  await p.context().close();
}

/* ---------------- a supervisor on a laptop ---------------- */
{
  const p = await handheld({ angle: 90, width: 1280, height: 800, touch: false });
  check('A wide screen is never turned - a supervisor opened it that way on purpose',
    !/\bupright\b/.test(await bodyClass(p)), await bodyClass(p));
  await p.context().close();
}

/* ---------------- counting, sideways ---------------- */
{
  const p = await handheld({ angle: 90 });
  await p.selectOption('#fSession', String(sess.id));
  await p.fill('#fTeam', '1'); await p.fill('#fEmployee', 'E1001');
  await p.click('#btnStart');
  await p.waitForTimeout(2500);
  if (await p.$('#scrAssign.active')) await p.click('#btnCount');
  await p.waitForSelector('#scrScan.active', { timeout: 90000 });
  await p.waitForTimeout(500);
  check('Signed on and counting, it is still upright', /\bupright\b/.test(await bodyClass(p)), await bodyClass(p));
  const box = await p.$eval('#fScan', (f) => { const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  check('...and the box a counter scans into is on the screen, whole',
    box.x >= -1 && box.y >= -1 && box.x + box.w <= 641 && box.y + box.h <= 361, JSON.stringify(box));

  /* Turning the page is a picture, not a different app: a scan still walks the
     questions and still commits a line. */
  const pallets = readFileSync(`${S}fixtures/pallets.csv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const p1 = pallets.find((c) => /^F0/.test(c[5] || ''));
  const scan = async (v) => { await p.fill('#fScan', v); await p.press('#fScan', 'Enter'); await p.waitForTimeout(450); };
  await scan(p1[0]);
  check('...a scan still moves to the next question while turned', /QUANTITY/.test(await p.textContent('#prompt')), clean(await p.textContent('#prompt')));
  await scan(String(p1[4]));
  await scan(p1[5]);
  await p.waitForTimeout(1800);
  const stored = (await (await fetch(`${BASE}/api/admin/sessions/${sess.id}/export/counts.csv`, { headers: A })).text()).trim().split('\n');
  check('...and the line lands on the server exactly as it would held upright',
    stored.length === 2 && stored[1].includes(p1[0]) && stored[1].includes(p1[5]), stored[1]?.slice(0, 70));
  await p.context().close();
}

/* ---------------- a site that turned it off ---------------- */
{
  await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ portrait: false }) });
  const p = await handheld({ angle: 90 });
  await p.selectOption('#fSession', String(sess.id));
  await p.fill('#fTeam', '1'); await p.fill('#fEmployee', 'E1001');
  await p.click('#btnStart');
  await p.waitForTimeout(2500);
  if (await p.$('#scrAssign.active')) await p.click('#btnCount');
  await p.waitForSelector('#scrScan.active', { timeout: 90000 });
  await p.waitForTimeout(500);
  check('With "keep it upright" off, the gun is left however the device turned it',
    !/\bupright\b/.test(await bodyClass(p)), await bodyClass(p));
  check('...and then it says which way up it wants to be, rather than leaving a counter to guess',
    await p.evaluate(() => getComputedStyle(document.body, '::before').content.includes('upright')),
    await p.evaluate(() => getComputedStyle(document.body, '::before').content));
  await p.context().close();
  await fetch(`${BASE}/api/admin/scanner-layout`, { method: 'POST', headers: A, body: JSON.stringify({ portrait: true }) });
}

check('No script errors on the handheld', errors.length === 0, errors.join(' | '));
await browser.close();

console.log(`\n${results.filter(Boolean).length}/${results.length} portrait checks passed`);
if (results.some((r) => r === false)) process.exitCode = 1;
