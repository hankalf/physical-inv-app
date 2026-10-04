/* Who may do what.
 *
 * An admin may do everything. A supervisor may do everything a supervisor
 * could before, unless an admin has given the login a list - then it is the
 * list and nothing else. Settings, Advanced included, is for admins only
 * whatever the list says. The server decides; the pages only follow. */

export const ACCESS = [
  // the pages
  ['dashboard', 'Dashboard', 'page'],
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
export const ACCESS_KEYS = ACCESS.map(([k]) => k);
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
  return [...new Set(list)];
}

export const allowed = (who, key) => {
  if (!who) return false;
  if (who.role === 'admin') return true;
  if (key === 'admin') return false;
  return who.access == null || who.access.includes(key);
};

/**
 * Which key a request needs. null means any signed-in supervisor. The reads
 * every page shares (the count list, progress, layouts, the search box) are
 * open to anyone signed in; a page's own data and every action are not.
 */
export function routeNeed(p, method) {
  const w = method !== 'GET';
  // Settings - Advanced included - is admin-only: the site's setup and every change to a count
  if (w && /^\/api\/admin\/(devices|scanner-layout|scanner-prompts|default-session|sos-reasons|teams-webhook|idle-config|logo|erp\/formats|backups|adjustment-reasons|users)(\/|$)/.test(p)) return 'admin';
  if (w && p === '/api/admin/sessions') return 'admin';
  if (method === 'DELETE' && /^\/api\/admin\/sessions\/\d+$/.test(p)) return 'admin';
  if (w && /^\/api\/admin\/sessions\/\d+\/(master|status|trial|aisles\/block|aisles\/auto-block)$/.test(p)) return 'admin';
  if (/^\/api\/admin\/sessions\/\d+\/erp\//.test(p) || /^\/api\/admin\/(audit|backups)/.test(p)) return 'admin';
  // the functions
  if (/\/adjustments\/decide$/.test(p)) return 'approve';
  if (w && /\/messages(\/\d+)?$/.test(p)) return 'messages';
  if (/\/alerts\/\d+\/(seen|close)$/.test(p) || (w && /\/clocks\/\d+$/.test(p))) return 'alerts';
  if ((w && /\/assignments(\/|$)/.test(p)) || (w && /\/recounts(\/|$)/.test(p)) || /\/aisles\/apply-layout$/.test(p) || (w && /\/note$/.test(p))) return 'assign';
  // the pages' own data
  if (p.startsWith('/api/admin/practice')) return 'testing';
  if (p.startsWith('/api/admin/people')) return 'teams';
  if (p.startsWith('/api/admin/missing')) return 'missing';
  if (p.startsWith('/api/admin/front/') || /\/moves(\.csv|\/|$)/.test(p)) return 'front';
  if (/\/cycle\//.test(p) || /\/export\/coverage\.csv$/.test(p)) return 'cycle';
  if (/\/export\//.test(p) || /\/print\//.test(p) || /\.csv$/.test(p)) return 'export';
  return null;
}
