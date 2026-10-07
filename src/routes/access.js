/* Who may do what.
 *
 * An admin may do everything. A supervisor may do everything a supervisor
 * could before, unless an admin has given the login a list - then it is the
 * list and nothing else. Settings, Advanced included, is for admins only
 * whatever the list says. The server decides; the pages only follow. */

export const ACCESS = [
  // the pages
  ['dashboard', 'Dashboard', 'page'],
  ['full', 'Full Counts', 'page'],
  ['cycle', 'Cycle counts', 'page'],
  ['front', 'Front bins', 'page'],
  ['missing', 'Not in Location', 'page'],
  ['teams', 'Teams & crew', 'page'],
  ['testing', 'Testing Suite', 'page'],
  // the things a page can do that not everyone should
  ['approve', 'Approve adjustments', 'function'],
  ['messages', 'Message the floor', 'function'],
  ['alerts', 'Answer an SOS, quiet a stopped-scanning alert', 'function'],
  ['assign', 'Queue aisles, raise second counts, the board note', 'function'],
  ['export', 'Downloads and printouts', 'function'],
];
/* The tabs on each page. A page key grants the whole page; a tab key grants
   that tab alone. Settings has no entry here: it stays for admins. */
export const TABS = {
  dashboard: [['progress', 'Progress'], ['map', 'Map'], ['teams', 'Team plan'], ['alerts', 'Alerts'], ['second', 'Second counts'], ['adjust', 'Adjustments'], ['reports', 'Reports']],
  cycle: [['today', 'Today'], ['open', 'Still open'], ['coverage', 'Coverage'], ['setup', 'Program & data']],
  teams: [['crew', 'Crew & teams'], ['rules', 'Equipment rules']],
  front: [['moves', 'Pallets to move back'], ['desk', 'Move desk'], ['bins', 'Front-placed bins']],
};
export const TAB_KEYS = Object.entries(TABS).flatMap(([page, subs]) => subs.map(([sub]) => `${page}.${sub}`));
export const ACCESS_KEYS = [...ACCESS.map(([k]) => k), ...TAB_KEYS];
export const PAGE_KEY = { '/admin': 'dashboard', '/cycle': 'cycle', '/front': 'front', '/missing': 'missing', '/teams': 'teams', '/testing': 'testing', '/settings': 'admin' };

/** A stored list, or null for "everything a supervisor can". */
export function parseAccess(raw) {
  if (raw == null || raw === '') return null;
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((k) => ACCESS_KEYS.includes(k)) : null; } catch { return null; }
}

/** What an admin sent, checked. undefined keeps what is there; null clears it. */
export function cleanAccess(list) {
  if (list === undefined) return undefined;
  if (list === null) return null;
  if (!Array.isArray(list)) throw Object.assign(new Error('access must be a list of what the login may use'), { status: 400 });
  const bad = list.filter((k) => !ACCESS_KEYS.includes(k));
  if (bad.length) throw Object.assign(new Error(`not a thing a login can be given: ${bad.join(', ')}`), { status: 400 });
  // a whole page makes its tab keys redundant
  const whole = new Set(list.filter((k) => !k.includes('.')));
  return [...new Set(list)].filter((k) => !k.includes('.') || !whole.has(k.split('.')[0]));
}

export const allowed = (who, key) => {
  if (!who) return false;
  if (who.role === 'admin') return true;
  if (key === 'admin') return false;
  if (who.access == null) return true;
  // Full Counts came after the logins did: the whole dashboard carries it with it
  if (key === 'full') return who.access.includes('full') || who.access.includes('dashboard');
  if (key.includes('.')) return who.access.includes(key) || who.access.includes(key.split('.')[0]);   // a tab: the tab, or its whole page
  return who.access.includes(key) || who.access.some((k) => k.startsWith(key + '.'));                 // a page: whole, or any of its tabs
};

/**
 * Which key a request needs. null means any signed-in supervisor. The reads
 * every page shares (the count list, progress, layouts, the search box) are
 * open to anyone signed in; a page's own data and every action are not.
 */
/** The tab a route belongs to, where a route is one tab's. */
function tabOf(p, method) {
  const w = method !== 'GET';
  if (/^\/api\/admin\/sessions\/\d+\//.test(p)) {
    const rest = p.replace(/^\/api\/admin\/sessions\/\d+\//, '');
    if (/^(progress|clocks|notes?)(\/|$)/.test(rest)) return 'dashboard.progress';
    if (/^map$/.test(rest) || rest === 'aisles/apply-layout') return 'dashboard.map';
    if (/^assignments(\/|$)/.test(rest)) return 'dashboard.teams';
    if (/^(alerts|messages)(\/|$)/.test(rest)) return 'dashboard.alerts';
    if (/^recounts(\/|$)/.test(rest) || rest === 'export/recounts.csv') return 'dashboard.second';
    if (/^adjustments(\/|$)/.test(rest) || rest === 'export/adjustments.csv') return 'dashboard.adjust';
    if (/^(pallets|labels|fixlist|lot|uncounted|issues|archives)(\/|$)/.test(rest) || /^export\//.test(rest) || /^print\//.test(rest)) return rest === 'export/coverage.csv' ? 'cycle.coverage' : 'dashboard.reports';
    if (rest === 'cycle/open') return 'cycle.open';
    if (rest === 'cycle/batches' && !w) return 'cycle.today';
    if (/^cycle\//.test(rest)) return w ? 'cycle.setup' : 'cycle.today';
    if (/^moves(\.csv|\/|$)/.test(rest)) return /\/(done|skip)$/.test(rest) ? 'front.desk' : 'front.moves';
  }
  if (p.startsWith('/api/admin/front/')) {
    const sub = p.slice('/api/admin/front/'.length);
    if (sub === 'bins') return 'front.bins';
    if (sub === 'status') return null;
    return 'front.moves';
  }
  if (p === '/api/admin/pallet-system' && !w) return null;     // both desks read it: Front bins and Not in Location
  if (p === '/api/admin/people/equipment') return 'teams.rules';
  if (p.startsWith('/api/admin/people')) return 'teams.crew';
  return null;
}

export function routeNeeds(p, method) {
  const out = [];
  const one = routeNeed(p, method);
  if (one) out.push(one);
  const tab = tabOf(p, method);
  if (tab && one !== 'admin') out.push(tab);
  return out;
}

export function routeNeed(p, method) {
  const w = method !== 'GET';
  // Settings - Advanced included - is admin-only: the site's setup and every change to a count
  if (p === '/api/admin/pallet-system/ticket') return null;      // seeing the system under a desk is every desk's
  if (w && /^\/api\/admin\/(devices|scanner-layout|scanner-prompts|default-session|sos-reasons|teams-webhook|idle-config|logo|pallet-system|erp\/formats|backups|adjustment-reasons|users|login-locks|onedrive)(\/|$)/.test(p)) return 'admin';
  if (w && p === '/api/admin/sessions') return 'admin';
  if (method === 'DELETE' && /^\/api\/admin\/sessions\/\d+$/.test(p)) return 'admin';
  if (w && /^\/api\/admin\/sessions\/\d+\/(master|status|trial|aisles\/block|aisles\/auto-block)$/.test(p)) return 'admin';
  if (/^\/api\/admin\/sessions\/\d+\/erp\//.test(p) || /^\/api\/admin\/(audit|backups)/.test(p)) return 'admin';
  // the functions
  if (/\/adjustments\/decide$/.test(p)) return 'approve';
  if (w && /\/messages(\/\d+)?$/.test(p)) return 'messages';
  if (/\/alerts\/\d+\/(seen|close)$/.test(p) || (w && /\/clocks\/\d+$/.test(p))) return 'alerts';
  if ((w && /\/assignments(\/|$)/.test(p)) || (w && /\/recounts(\/|$)/.test(p)) || /\/aisles\/apply-layout$/.test(p) || (w && /\/notes?(\/\d+)?$/.test(p))) return 'assign';
  // the pages' own data
  if (p.startsWith('/api/admin/practice')) return 'testing';
  if (p.startsWith('/api/admin/people')) return 'teams';
  if (p.startsWith('/api/admin/missing')) return 'missing';
  if (p.startsWith('/api/admin/front/') || /\/moves(\.csv|\/|$)/.test(p)) return 'front';
  if (/\/cycle\//.test(p) || /\/export\/coverage\.csv$/.test(p)) return 'cycle';
  if (/\/export\//.test(p) || /\/print\//.test(p) || /\.csv$/.test(p)) return 'export';
  return null;
}

/* The roles on offer: each is a preset of the list above. Admin is everything,
   Supervisor is everything a supervisor can; the rest are the jobs people
   actually have. Ticking by hand makes a login Custom. */
export const PROFILES = [
  ['admin', 'Admin — everything, Settings included', null],
  ['supervisor', 'Supervisor — everything a supervisor can', null],
  ['inventory', 'Inventory control — the count, adjustments, downloads', ['dashboard', 'full', 'testing', 'approve', 'export']],
  ['floor', 'Count supervisor — runs the floor', ['dashboard', 'full', 'teams', 'testing', 'messages', 'alerts', 'assign', 'export']],
  ['jobs', 'Warehouse jobs — front bins, Not in Location, cycle counts', ['front', 'missing', 'cycle', 'testing', 'export']],
  ['cycle', 'Cycle counter — cycle counts only', ['cycle', 'testing']],
  ['custom', 'Custom — ticked by hand', undefined],
];
const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
/** Which role a login's role and list amount to. */
export function profileOf(role, access) {
  if (role === 'admin') return 'admin';
  if (access == null) return 'supervisor';
  const hit = PROFILES.find(([, , list]) => Array.isArray(list) && sameSet(list, access));
  return hit ? hit[0] : 'custom';
}
/** What picking a role means for the account: its role and its list. */
export function applyProfile(key) {
  const hit = PROFILES.find(([k]) => k === key);
  if (!hit) throw Object.assign(new Error(`not a role on offer: ${key}`), { status: 400 });
  if (key === 'admin') return { role: 'admin', access: null };
  if (key === 'supervisor') return { role: 'supervisor', access: null };
  if (key === 'custom') return { role: 'supervisor' };
  return { role: 'supervisor', access: [...hit[2]] };
}
