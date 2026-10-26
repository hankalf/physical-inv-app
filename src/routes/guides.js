import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { markdownToHtml, slug } from '../util/markdown.js';

/*
 * The how-to guides, inside the app.
 *
 * docs/guides/for-users/ are the guides for the people using the app day to
 * day; docs/guides/ are the same jobs for an admin setting the site up, with
 * the Railway and Settings parts in. The User guide page lists them, shows one
 * on the page, offers its PDF, and searches them with everything else. The
 * files are the same ones that print, so the guide in the app and the guide on
 * paper never disagree.
 */

const DOCS = join(new URL('.', import.meta.url).pathname, '..', '..', 'docs');
const FOLDERS = { user: join(DOCS, 'guides', 'for-users'), admin: join(DOCS, 'guides') };
const NAME = /^[a-z0-9-]+$/;
// the order they are listed in: the first full count from scratch, then the count's own work
const ORDER = ['first-full-count', 'second-and-third-counts', 'set-up-second-and-third-counts', 'erp-upload-by-aisle', 'reports-and-exports', 'employees-teams-and-gear', 'live-and-test', 'run-the-training-day'];

const cache = new Map();                      // path -> { mtime, guide }

/** One guide, read from its Markdown: title, who it is for, the lead paragraph, the page, the sections. */
function readGuide(edition, name) {
  const file = join(FOLDERS[edition], `${name}.md`);
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.guide;
  const md = readFileSync(file, 'utf8');
  const title = (/^#\s+(.*)$/m.exec(md) || [, name])[1].trim();
  const role = /^\*\*Role:\*\*\s*(.+?)(?:\s{2,}\*\*|$)/m.exec(md);
  const tocAt = md.indexOf('## Contents');
  const intro = md.slice(md.indexOf('\n', md.indexOf('# ')), tocAt > 0 ? tocAt : undefined)
    .split('\n').filter((l) => l.trim() && !/^\*\*Role:\*\*/.test(l)).join(' ').trim();
  // the page: everything after the title and the role line, contents list included (it links within the page)
  const body = md.slice(md.indexOf('\n', md.indexOf('# '))).replace(/^\*\*Role:\*\*.*$/m, '');
  const html = markdownToHtml(body).replace(/src="(?:\.\.\/)*images\/([a-z0-9-]+\.png)"/g, 'src="/guide-images/$1"');
  const sections = [];
  const parts = md.split(/^## /m).slice(1);
  for (const p of parts) {
    const head = p.slice(0, p.indexOf('\n')).trim();
    if (head === 'Contents') continue;
    // plain words for the search: no pictures, list marks or table rules; a table row reads as "a: b"
    const text = p.slice(p.indexOf('\n')).split('\n').map((l) => l.trim())
      .filter((l) => l && !/^\|?\s*:?-{2,}/.test(l) && !/^!\[/.test(l))
      .map((l) => l.replace(/^[-*]\s+|^\d+\.\s+|^>\s*/, '')
        .replace(/^\|(.*)\|$/, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(': '))
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<br>/g, ' ')
        .replace(/[*`#]/g, ''))
      .join(' ').replace(/\s+/g, ' ').trim();
    sections.push({ id: slug(head), title: head.replace(/^\d+\s*—\s*/, ''), text: text.slice(0, 1600) });
  }
  const guide = {
    edition, name, title, who: role ? role[1].trim() : '',
    blurb: intro.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1'),
    html, sections, pdf: existsSync(join(FOLDERS[edition], `${name}.pdf`)),
  };
  cache.set(file, { mtime, guide });
  return guide;
}

/** Every guide this login may read: the user guides for everyone, the admin ones for an admin. */
export function listGuides({ admin = false } = {}) {
  const out = [];
  for (const edition of admin ? ['user', 'admin'] : ['user']) {
    if (!existsSync(FOLDERS[edition])) continue;
    const rank = (f) => { const i = ORDER.indexOf(f.slice(0, -3)); return i < 0 ? 99 : i; };
    for (const f of readdirSync(FOLDERS[edition]).filter((x) => x.endsWith('.md') && x !== 'README.md').sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      const g = readGuide(edition, f.slice(0, -3));
      if (g) out.push({ edition, name: g.name, title: g.title, who: g.who, blurb: g.blurb, pdf: g.pdf, sections: g.sections });
    }
  }
  return out;
}

export function getGuide(edition, name, { admin = false } = {}) {
  if (!FOLDERS[edition] || !NAME.test(name)) throw Object.assign(new Error('no such guide'), { status: 404 });
  if (edition === 'admin' && !admin) throw Object.assign(new Error('the admin guides are for admins - the guides for users have the same jobs'), { status: 403 });
  const g = readGuide(edition, name);
  if (!g) throw Object.assign(new Error('no such guide'), { status: 404 });
  return g;
}

export function guidePdf(edition, name, opts) {
  const g = getGuide(edition, name, opts);
  const file = join(FOLDERS[edition], `${name}.pdf`);
  if (!existsSync(file)) throw Object.assign(new Error('this guide has no PDF yet'), { status: 404 });
  return { body: readFileSync(file), filename: `${name}${edition === 'admin' ? '-admin' : ''}.pdf`, title: g.title };
}

/** A picture a guide shows: from docs/images, by its plain name only. */
export function guideImage(file) {
  if (!/^[a-z0-9-]+\.png$/.test(file)) return null;
  const p = join(DOCS, 'images', file);
  return existsSync(p) ? readFileSync(p) : null;
}
