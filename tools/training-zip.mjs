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
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const T = join(ROOT, 'docs', 'training');
const OUT = process.argv[2] || join(T, 'training-material.zip');

/* the decks as PDFs too, when LibreOffice is about (the slides stay the editable original) */
const SOFFICE = process.env.SOFFICE || join(process.env.PPTX_SKILL || '/root/.claude/skills/synced/aaf7a9c9-9ed7-4c63-bbd2-57329cfa1463_c516df90-1a86-4d74-b56a-d4a854f39222/pptx', 'scripts', 'office', 'soffice.py');
const deckPdfs = [];
if (existsSync(SOFFICE)) {
  const tmp = mkdtempSync(join(tmpdir(), 'deck-pdf-'));
  for (const l of ['en', 'es']) {
    const src = join(T, `scanner-training-full-${l}.pptx`);
    if (!existsSync(src)) continue;
    const r = spawnSync('python3', [SOFFICE, '--headless', '--convert-to', 'pdf', '--outdir', tmp, src], { stdio: 'ignore', timeout: 300000 });
    const pdf = join(tmp, `scanner-training-full-${l}.pdf`);
    if (r.status === 0 && existsSync(pdf)) deckPdfs.push([`2 Slides/scanner-training-full-${l}.pdf`, pdf]);
  }
}
const optional = (rel, src) => (existsSync(src) ? [[rel, src]] : []);

const FILES = [
  ['1 Films/scanner-training-full-en.mp4', join(T, 'scanner-training-full-en.mp4')],
  ['1 Films/scanner-training-full-es.mp4', join(T, 'scanner-training-full-es.mp4')],
  ['1 Films/scanner-training-cycle-en.mp4', join(T, 'scanner-training-cycle-en.mp4')],
  ['1 Films/scanner-training-cycle-es.mp4', join(T, 'scanner-training-cycle-es.mp4')],
  ['2 Slides/scanner-training-full-en.pptx', join(T, 'scanner-training-full-en.pptx')],
  ['2 Slides/scanner-training-full-es.pptx', join(T, 'scanner-training-full-es.pptx')],
  ...deckPdfs,
  ['3 The wall/training-wall-labels-big.pdf', join(T, 'print', 'training-wall-labels-big.pdf')],
  ['3 The wall/training-wall-labels-small.pdf', join(T, 'print', 'training-wall-labels-small.pdf')],
  ['3 The wall/training-wall-trainers-key.pdf', join(T, 'print', 'training-wall-trainers-key.pdf')],
  ...optional('3 The wall/training-wall.docx', join(T, 'print', 'training-wall.docx')),
  ['4 Pocket cards/scanner-pocket-card-en.pdf', join(T, 'print', 'scanner-pocket-card-en.pdf')],
  ['4 Pocket cards/scanner-pocket-card-es.pdf', join(T, 'print', 'scanner-pocket-card-es.pdf')],
  ...optional('4 Pocket cards/scanner-pocket-card-en.docx', join(T, 'print', 'scanner-pocket-card-en.docx')),
  ...optional('4 Pocket cards/scanner-pocket-card-es.docx', join(T, 'print', 'scanner-pocket-card-es.docx')),
  // the two-sided cards, team numbers on the back, when training-prints.mjs was given the crew's teams
  ...['en', 'es'].flatMap((l) => [...optional(`4 Pocket cards/scanner-pocket-cards-two-sided-${l}.pdf`, join(T, 'print', `scanner-pocket-cards-two-sided-${l}.pdf`)), ...optional(`4 Pocket cards/scanner-pocket-cards-two-sided-${l}.docx`, join(T, 'print', `scanner-pocket-cards-two-sided-${l}.docx`))]),
  ['5 Trainer/run-the-training-day.pdf', join(ROOT, 'docs', 'guides', 'run-the-training-day.pdf')],
  ['5 Trainer/run-the-training-day.md', join(ROOT, 'docs', 'guides', 'run-the-training-day.md')],
  ...optional('5 Trainer/run-the-training-day.docx', join(T, 'print', 'run-the-training-day.docx')),
  ...optional('5 Trainer/training-roster.pdf', join(T, 'print', 'training-roster.pdf')),
  ...optional('5 Trainer/training-roster.docx', join(T, 'print', 'training-roster.docx')),
  // for each trainee: the check-off the trainer signs, the quiz and its answers, the words in both languages
  ...['en', 'es'].flatMap((l) => ['pdf', 'docx'].flatMap((x) => [
    ...optional(`7 For each trainee/scanner-check-off-${l}.${x}`, join(T, 'print', `scanner-check-off-${l}.${x}`)),
    ...optional(`7 For each trainee/scanner-quiz-${l}.${x}`, join(T, 'print', `scanner-quiz-${l}.${x}`)),
  ])),
  ...optional('7 For each trainee/scanner-words-en-es.pdf', join(T, 'print', 'scanner-words-en-es.pdf')),
  ...optional('7 For each trainee/scanner-words-en-es.docx', join(T, 'print', 'scanner-words-en-es.docx')),
  ['5 Trainer/set-up-second-and-third-counts.pdf', join(ROOT, 'docs', 'guides', 'set-up-second-and-third-counts.pdf')],
  ['5 Trainer/second-and-third-counts.pdf', join(ROOT, 'docs', 'guides', 'second-and-third-counts.pdf')],
  // On the scanner: a page for each thing that is different on a full count
  ['6 On the scanner/on-the-scanner.pdf', join(ROOT, 'docs', 'guides', 'on-the-scanner', 'on-the-scanner.pdf')],
  ...optional('6 On the scanner/on-the-scanner.docx', join(T, 'print', 'on-the-scanner.docx')),
  ...optional('6 On the scanner/en-el-escaner.pdf', join(ROOT, 'docs', 'guides', 'on-the-scanner', 'es', 'en-el-escaner.pdf')),
  ...optional('6 On the scanner/en-el-escaner.docx', join(T, 'print', 'en-el-escaner.docx')),
  ...readdirSync(join(ROOT, 'docs', 'guides', 'on-the-scanner')).filter((f) => f.endsWith('.pdf') && f !== 'on-the-scanner.pdf').sort()
    .map((f) => [`6 On the scanner/one page each/${f}`, join(ROOT, 'docs', 'guides', 'on-the-scanner', f)]),
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
  '2 Slides        The same lesson as slides, English and Spanish, narration in the speaker notes, as PowerPoint to edit and as PDF to show. Slide "The buttons, on one page" prints for the break room.',
  '3 The wall      Print "training-wall-labels-big.pdf" one label per page and hang it in the order the trainer\'s key gives. Real scanners read these.',
  '4 Pocket cards  Four to a page, one per person, English and Spanish. Cut along the lines. The "two-sided" files carry each person\'s team card on the back: print double-sided, flipped on the long edge.',
  '5 Trainer       The run sheet: the day before, the session minute by minute, every spot on the wall. Plus the roster and the second-count guides.',
  '7 For each trainee  A check-off sheet the trainer signs as each person does it on the wall; a ten-question quiz with its answers; the scanner\'s words in English and Spanish. English and Spanish, PDF and Word.',
  '6 On the scanner  One page for each thing on a full count that is not the plain rack, pallet, quantity: two labels, no label, a rack label that will not scan, empty bins and the rest. One booklet (PDF and Word) and each page on its own.',
  '',
  'Every printed piece is here twice: as a PDF to print as it is, and as a Word document (.docx) to edit first. Barcodes in the Word files are pictures.',
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
