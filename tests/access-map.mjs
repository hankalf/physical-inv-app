/*
 * Where the sign-ons come from: every scanner and login written down with its
 * network address, each address looked up once, and a map and list the site
 * admin alone can read. The lookup service is a stand-in this suite runs.
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { signIn } from './helpers.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MOCK = Number(process.env.GEOIP_MOCK_PORT || 3987);
const results = [];
const check = (s, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${d ? ' — ' + d : ''}`); };
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
const hdr = { 'content-type': 'application/json' };
const j = (r) => r.json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- the lookup service, as ipwho.is answers ---------------- */
const asked = [];
const WORLD = {
  '203.0.113.9': { country: 'United States', country_code: 'US', region: 'Virginia', city: 'Front Royal', latitude: 38.918, longitude: -78.194, connection: { isp: 'Shentel' } },
  '198.51.100.7': { country: 'Mexico', country_code: 'MX', region: 'Jalisco', city: 'Guadalajara', latitude: 20.659, longitude: -103.349, connection: { isp: 'Telmex' } },
};
const geo = createServer((req, res) => {
  const ip = decodeURIComponent(req.url.slice(1));
  asked.push(ip);
  res.setHeader('content-type', 'application/json');
  if (ip === '192.0.2.1') { res.writeHead(500); res.end('{"success":false,"message":"boom"}'); return; }
  if (!WORLD[ip]) { res.end(JSON.stringify({ success: false, message: 'Invalid IP address' })); return; }
  res.end(JSON.stringify({ success: true, ip, ...WORLD[ip] }));
});
await new Promise((r) => geo.listen(MOCK, '127.0.0.1', r));

const login = async (body, extra = {}) => j(await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { ...hdr, ...extra }, body: JSON.stringify(body) }));
const SITE = { ...hdr, authorization: 'Bearer ' + (await login({ password: 'changeme' }, { 'x-forwarded-for': '203.0.113.9' })).token };
const post = (p, b = {}, h = SITE) => fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
const get = async (p, h = SITE) => j(await fetch(BASE + p, { headers: h }));

/* another admin logs in from Mexico; a scanner opens its link from the warehouse and signs a team on from the building's own network */
await post('/api/admin/users', { username: 'AM-ADMIN', name: 'Ana Mapa', password: 'map-test-1', mustChange: false, profile: 'admin' });
const OTHER = { ...hdr, authorization: 'Bearer ' + (await login({ username: 'AM-ADMIN', password: 'map-test-1' }, { 'x-forwarded-for': '198.51.100.7, 10.0.0.1', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0' })).token };
const sess = await j(await post('/api/admin/sessions', { name: 'Access map count' }));
const dev = await j(await post('/api/admin/devices', { name: 'MAP-01' }));
const enrolled = await j(await fetch(`${BASE}/api/devices/${dev.uid}`, { method: 'POST', headers: { ...hdr, 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Linux; Android 11; MC93) Chrome/118.0 Mobile Safari/537.36' }, body: '{}' }));
const G = { ...hdr, authorization: 'Device ' + enrolled.token };
await fetch(`${BASE}/api/sessions/${sess.id}/signon`, { method: 'POST', headers: { ...G, 'x-forwarded-for': '192.168.4.20', 'user-agent': 'Mozilla/5.0 (Linux; Android 11; MC93) Chrome/118.0 Mobile Safari/537.36' }, body: JSON.stringify({ team: '7', employees: ['AM1'], deviceId: 'MAP-01' }) });
await wait(800);   // the lookups run after the answers go back

/* ---------------- who may read it ---------------- */
check('Another admin is refused: the map is the site admin\'s alone', (await fetch(`${BASE}/api/admin/access-map`, { headers: OTHER })).status === 403 && (await post('/api/admin/access-map/lookup', {}, OTHER)).status === 403);
let d = await get('/api/admin/access-map?days=7');
const row = (kind, who) => d.rows.find((r) => r.kind === kind && r.who === who);
check('The site admin reads it: the login from Front Royal, with the address, the place and the network', !!row('login', 'DANA-WHITFIELD') && row('login', 'DANA-WHITFIELD').ip === '203.0.113.9' && row('login', 'DANA-WHITFIELD').resolved && row('login', 'DANA-WHITFIELD').place === 'Front Royal, Virginia, United States' && row('login', 'DANA-WHITFIELD').isp === 'Shentel', JSON.stringify(row('login', 'DANA-WHITFIELD')));
check('…the other admin from Guadalajara: the first address in the forwarded chain, and the device read from the browser', row('login', 'AM-ADMIN').ip === '198.51.100.7' && row('login', 'AM-ADMIN').country_code === 'MX' && row('login', 'AM-ADMIN').device === 'Windows · Edge 120' && /Ana Mapa \(admin\)/.test(row('login', 'AM-ADMIN').detail), JSON.stringify(row('login', 'AM-ADMIN')));
const opened = d.rows.find((r) => r.kind === 'scanner' && /opened its link/.test(r.detail));
const signed = d.rows.find((r) => r.kind === 'scanner' && /team 7 signed on/.test(r.detail));
check('The scanner: opening its link from the warehouse address, Android Chrome', !!opened && opened.who === 'MAP-01' && opened.ip === '203.0.113.9' && opened.resolved && opened.device === 'Android · Chrome 118', JSON.stringify(opened));
check('…and signing a team on from the building\'s own network, which has no place in the world', !!signed && signed.ip === '192.168.4.20' && signed.private && !signed.resolved && signed.sessionId === sess.id, JSON.stringify(signed));
check('Each address is looked up once, and a private one never', asked.filter((x) => x === '203.0.113.9').length === 1 && asked.filter((x) => x === '198.51.100.7').length === 1 && !asked.includes('192.168.4.20'), asked.join(','));
check('The places: one row per address with its sign-ons counted and who came from it', d.places.length === 3 && d.places.find((p) => p.ip === '203.0.113.9').scanners === 1 && d.places.find((p) => p.ip === '203.0.113.9').logins === 1 && d.places.find((p) => p.ip === '203.0.113.9').who.sort().join() === 'DANA-WHITFIELD,MAP-01' && d.places.find((p) => p.ip === '203.0.113.9').lat === 38.918, JSON.stringify(d.places.map((p) => [p.ip, p.scanners, p.logins])));
check('…and the sums: sign-ons, addresses, countries, private', d.summary.signons >= 4 && d.summary.addresses === 3 && d.summary.countries === 2 && d.summary.private === 1 && d.summary.pending === 0, JSON.stringify(d.summary));
check('Scanners only, logins only', (await get('/api/admin/access-map?kind=scanner')).rows.every((r) => r.kind === 'scanner') && (await get('/api/admin/access-map?kind=login')).rows.every((r) => r.kind === 'login'));

/* a lookup that fails is kept as failed, and tried again on request */
await login({ password: 'changeme' }, { 'x-forwarded-for': '192.0.2.1' });
await wait(800);
d = await get('/api/admin/access-map');
check('A failed lookup says so, and the address still has its row', d.places.find((p) => p.ip === '192.0.2.1').error && d.summary.failed === 1, JSON.stringify(d.places.find((p) => p.ip === '192.0.2.1')));
WORLD['192.0.2.1'] = { country: 'Canada', country_code: 'CA', region: 'Ontario', city: 'Toronto', latitude: 43.65, longitude: -79.38, connection: { isp: 'Rogers' } };
const n0 = asked.length;
/* a failed lookup waits a day before it is tried again by itself; the button tries it now */
check('Nothing is pending by itself', (await get('/api/admin/access-map')).summary.pending === 0);
await wait(100);
/* the stale-failure rule is a day; the button covers what is pending or failed long enough - so make the failure old */
check('The lookup button answers with the map', (await post('/api/admin/access-map/lookup', {})).status === 200 && (await get('/api/admin/audit?limit=5')).some((x) => x.action === 'looked up sign-on addresses'));
check('…but a lookup that failed a moment ago is not hammered', asked.length === n0, String(asked.length - n0));

/* ---------------- the page ---------------- */
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const other = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
other.on('pageerror', (e) => errors.push(e.message));
await other.goto(`${BASE}/settings#logins`);
await signIn(other, { user: 'AM-ADMIN', password: 'map-test-1' });
await other.waitForSelector('#loginsCard'); await other.waitForTimeout(800);
check('Settings → Logins: another admin does not see the card', await other.$eval('#accessMapCard', (el) => el.hidden));
await other.close();
const site = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
site.on('pageerror', (e) => errors.push(e.message));
await site.route('https://*.tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));   // no internet in the test
await site.goto(`${BASE}/settings#logins`);
await signIn(site);
await site.waitForSelector('#accessMapCard:not([hidden])', { timeout: 8000 });
await site.waitForSelector('#amMap .leaflet-container, #amMap.leaflet-container', { timeout: 8000 }).catch(() => {});
await site.waitForTimeout(1000);
check('The site admin sees the card, with the sums', /sign-ons/.test(clean(await site.textContent('#amSummary'))) && /2 countries/.test(clean(await site.textContent('#amSummary'))), clean(await site.textContent('#amSummary')));
check('…the map, with a circle per address that has a place', (await site.$$('#amMap path.leaflet-interactive')).length === 2, String((await site.$$('#amMap path.leaflet-interactive')).length));
const rows = await site.$$eval('#amTable tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent).join(' ').replace(/\s+/g, ' ').trim()));
check('…and the list: the login from Guadalajara with its network and device, the scanner on the building\'s network', rows.some((r) => /Login AM-ADMIN · Ana Mapa \(admin\) 198\.51\.100\.7 Guadalajara, Jalisco, Mexico Telmex Windows · Edge 120/.test(r)) && rows.some((r) => /Scanner MAP-01 · team 7 signed on 192\.168\.4\.20 the building's own network/.test(r)), rows.slice(0, 3).join(' | '));
await site.selectOption('#fAmKind', 'login'); await site.waitForTimeout(700);
check('Logins only narrows the list', (await site.$$eval('#amTable tbody tr', (trs) => trs.map((tr) => tr.dataset.kind))).every((k) => k === 'login'));
check('The page says the admin\'s own address', clean(await site.textContent('#amSelf')) !== '');
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();
geo.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
