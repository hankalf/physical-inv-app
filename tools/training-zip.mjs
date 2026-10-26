/*
 * One zip of every piece of training material, to hand to whoever runs the
 * training: the four films, the two decks, the classroom prints, the trainer's
 * run sheet and the training README.
 *
 *   node tools/training-zip.mjs [out.zip]     -> docs/training/training-material.zip
 *
 * Run tools/training-prints.mjs first if docs/training/print is missing or stale.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const T = join(ROOT, 'docs', 'training');
const OUT = process.argv[2] || join(T, 'training-material.zip');

const FILES = [
  ['1 Films/scanner-training-full-en.mp4', join(T, 'scanner-training-full-en.mp4')],
  ['1 Films/scanner-training-full-es.mp4', join(T, 'scanner-training-full-es.mp4')],
  ['1 Films/scanner-training-cycle-en.mp4', join(T, 'scanner-training-cycle-en.mp4')],
  ['1 Films/scanner-training-cycle-es.mp4', join(T, 'scanner-training-cycle-es.mp4')],
  ['2 Slides/scanner-training-full-en.pptx', join(T, 'scanner-training-full-en.pptx')],
  ['2 Slides/scanner-training-full-es.pptx', join(T, 'scanner-training-full-es.pptx')],
  ['3 The wall/training-wall-labels-big.pdf', join(T, 'print', 'training-wall-labels-big.pdf')],
  ['3 The wall/training-wall-labels-small.pdf', join(T, 'print', 'training-wall-labels-small.pdf')],
  ['3 The wall/training-wall-trainers-key.pdf', join(T, 'print', 'training-wall-trainers-key.pdf')],
  ['4 Pocket cards/scanner-pocket-card-en.pdf', join(T, 'print', 'scanner-pocket-card-en.pdf')],
  ['4 Pocket cards/scanner-pocket-card-es.pdf', join(T, 'print', 'scanner-pocket-card-es.pdf')],
  ['5 Trainer/run-the-training-day.pdf', join(ROOT, 'docs', 'guides', 'run-the-training-day.pdf')],
  ['5 Trainer/run-the-training-day.md', join(ROOT, 'docs', 'guides', 'run-the-training-day.md')],
  ['5 Trainer/set-up-second-and-third-counts.pdf', join(ROOT, 'docs', 'guides', 'set-up-second-and-third-counts.pdf')],
  ['5 Trainer/second-and-third-counts.pdf', join(ROOT, 'docs', 'guides', 'second-and-third-counts.pdf')],
  ['README.md', join(T, 'README.md')],
];
const missing = FILES.filter(([, src]) => !existsSync(src)).map(([, src]) => src.replace(ROOT + '/', ''));
if (missing.length) { console.error('missing:\n  ' + missing.join('\n  ') + '\n(run the film, deck and training-prints tools first)'); process.exit(1); }

const stage = mkdtempSync(join(tmpdir(), 'training-zip-'));
const top = join(stage, 'training-material');
for (const [rel, src] of FILES) { mkdirSync(join(top, rel, '..'), { recursive: true }); copyFileSync(src, join(top, rel)); }
writeFileSync(join(top, 'START HERE.txt'), [
  'Full Harvest Inventory - training material',
  '',
  '1 Films         The scanner lesson as a film, 1080p, about ten minutes. Play the full-count film in the room\'s language first.',
  '2 Slides        The same lesson as slides, English and Spanish, narration in the speaker notes. Slide "The buttons, on one page" prints for the break room.',
  '3 The wall      Print "training-wall-labels-big.pdf" one label per page and hang it in the order the trainer\'s key gives. Real scanners read these.',
  '4 Pocket cards  Four to a page, one per person, English and Spanish. Cut along the lines.',
  '5 Trainer       The run sheet: the day before, the session minute by minute, every spot on the wall. Plus the second-count guides.',
  '',
  'The wall counts into the app\'s training count: Testing Suite -> Classroom training -> Set up the training count (an admin, the day before).',
  'Reset for the next class between groups; Remove the training count before count day.',
  '',
].join('\n'));
rmSync(OUT, { force: true });
const z = spawnSync('zip', ['-r', '-X', '-q', OUT, 'training-material'], { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
if (z.status !== 0) { console.error('zip failed'); process.exit(1); }
console.log(`${OUT} written - ${(statSync(OUT).size / 1048576).toFixed(1)} MB, ${FILES.length + 1} files`);
