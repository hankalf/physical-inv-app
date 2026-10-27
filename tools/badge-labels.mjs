/*
 * Badge labels for Avery 5960 / 5160, from a list.
 *
 *   node tools/badge-labels.mjs list.txt out.docx [--per 2]
 *
 * The list is "badge<TAB>name" per line (pasted from Excel), or a CSV of
 * badge,name; a header row is skipped. --per is how many copies of each person
 * go side by side on a row (1-3, default 2).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { badgeLabelsDocx, parseBadgeList } from '../src/util/badge-labels.js';

const [src, out] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^\d$/.test(a));
const perAt = process.argv.indexOf('--per');
const per = perAt > 0 ? Number(process.argv[perAt + 1]) : 2;
if (!src || !out) { console.error('usage: node tools/badge-labels.mjs list.txt out.docx [--per 2]'); process.exit(1); }
const people = parseBadgeList(readFileSync(src, 'utf8'));
writeFileSync(out, badgeLabelsDocx(people, { perPerson: per, title: 'Badge labels — Avery 5960' }));
console.log(`${out} written - ${people.length} people, ${per} labels each, ${Math.ceil(people.length / 10)} sheet${people.length > 10 ? 's' : ''}`);
