/*
 * The day-one slide deck for the counting crew, in English or Spanish - the
 * same lesson as the training film, as slides a trainer can stand beside.
 *
 * Every picture on a slide is the real scanner app, saved by the film tool
 * (tools/crew-training.mjs) at each step, so the deck and the film never
 * disagree; the Spanish deck carries the Spanish screens. The narration is in
 * the speaker notes, slide by slide, for whoever presents it.
 *
 *   node tools/crew-deck.mjs                 -> docs/training/scanner-training-en.pptx
 *   LANG_FILM=es node tools/crew-deck.mjs    -> docs/training/scanner-training-es.pptx
 *   SHOTS=<dir> reads the pictures from elsewhere (the film's worktree, say).
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const pptxgen = require('pptxgenjs');
const SKILL = process.env.PPTX_SKILL || '/root/.claude/skills/synced/aaf7a9c9-9ed7-4c63-bbd2-57329cfa1463_c516df90-1a86-4d74-b56a-d4a854f39222/pptx';
const { applyTheme } = require(join(SKILL, 'scripts', 'apply_theme.js'));

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..');
const LANG = process.env.LANG_FILM === 'es' ? 'es' : 'en';
const L = (en, es) => (LANG === 'es' ? es : en);
const JOB = 'full';                                     // the deck is the full count's; the films cover each job
const SHOTS = process.env.SHOTS || join(ROOT, 'docs', 'training', 'shots', JOB, LANG);
const OUT = join(ROOT, 'docs', 'training', `scanner-training-${JOB}-${LANG}.pptx`);

/* the pictures, by the name the film gave them (01-signon.png -> signon) */
const files = existsSync(SHOTS) ? readdirSync(SHOTS) : [];
const shot = (name) => { const f = files.find((x) => x === `${name}.png` || /^\d\d-/.test(x) && x.slice(3) === `${name}.png`); if (!f) throw new Error(`no picture for ${name} in ${SHOTS}`); return join(SHOTS, f); };

const THEME = {
  name: 'Full Harvest crew',
  headFontFace: 'Arial', bodyFontFace: 'Calibri',
  colors: { dk1: '0A1018', lt1: 'FFFFFF', dk2: '18293F', lt2: 'D8E3EF', accent1: 'FFC20E', accent2: '3FCF68', accent3: 'FF5A5F', accent4: '4C9DFF', accent5: '8FA2B8', accent6: 'B98A52', hlink: 'FFC20E', folHlink: 'B98A52' },
};
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';            // 13.33 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = L('How to count with the scanner', 'Cómo contar con el escáner');
pres.author = 'Full Harvest Inventory';
pres.lang = LANG === 'es' ? 'es-US' : 'en-US';
const C = pres.SchemeColor;

/* ------------------------------------------------------------ the layouts */
pres.defineSlideMaster({
  title: 'cover', background: { color: THEME.colors.dk1 },
  objects: [
    { placeholder: { options: { name: 'kicker', type: 'body', x: 0.9, y: 2.0, w: 11.5, h: 0.5, fontSize: 16, bold: true, color: C.accent1, charSpacing: 4, margin: 0 }, text: '' } },
    { placeholder: { options: { name: 'title', type: 'title', x: 0.9, y: 2.5, w: 11.5, h: 1.8, fontSize: 54, bold: true, color: C.background1, margin: 0, valign: 'top', align: 'left' }, text: '' } },
    { placeholder: { options: { name: 'body', type: 'body', x: 0.9, y: 4.5, w: 10.5, h: 1.6, fontSize: 24, color: C.background2, margin: 0, valign: 'top' }, text: '' } },
  ],
});
pres.defineSlideMaster({
  title: 'part', background: { color: THEME.colors.dk2 },
  objects: [
    { placeholder: { options: { name: 'kicker', type: 'body', x: 0.9, y: 2.4, w: 11.5, h: 0.5, fontSize: 18, bold: true, color: C.accent1, charSpacing: 4, margin: 0 }, text: '' } },
    { placeholder: { options: { name: 'title', type: 'title', x: 0.9, y: 2.95, w: 11.5, h: 1.4, fontSize: 48, bold: true, color: C.background1, margin: 0, valign: 'top', align: 'left' }, text: '' } },
    { placeholder: { options: { name: 'body', type: 'body', x: 0.9, y: 4.4, w: 10.5, h: 1.2, fontSize: 24, color: C.background2, margin: 0, valign: 'top' }, text: '' } },
  ],
});
pres.defineSlideMaster({
  title: 'content', background: { color: THEME.colors.dk1 },
  objects: [
    { placeholder: { options: { name: 'kicker', type: 'body', x: 0.6, y: 0.35, w: 8, h: 0.35, fontSize: 12, bold: true, color: C.accent1, charSpacing: 3, margin: 0 }, text: '' } },
    { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 0.7, w: 8.4, h: 1.05, fontSize: 32, bold: true, color: C.background1, margin: 0, valign: 'top', align: 'left' }, text: '' } },
    { text: { text: L('Full Harvest Inventory · Day 1 · the counting crew', 'Full Harvest Inventory · Día 1 · equipo de conteo'), options: { x: 0.6, y: 7.0, w: 9, h: 0.3, fontSize: 10, color: C.accent5, margin: 0 } } },
  ],
  slideNumber: { x: 12.3, y: 7.0, w: 0.6, h: 0.3, fontSize: 10, color: THEME.colors.accent5 },
});

/* ------------------------------------------------------------ the pieces */
const PHONE = 392 / 690;                                   // the saved pictures' shape
let section = '';
const notesOf = [];
function content({ kicker, title, lines = [], tip, shots = [], labels = [], notes = '', plain = false }) {
  const s = pres.addSlide({ masterName: 'content', sectionTitle: section });
  s.addText(kicker || section, { placeholder: 'kicker' });
  s.addText(title, { placeholder: 'title' });
  /* the pictures: phones on the right, up to three, the labels under the words */
  const n = shots.length;
  const wide = n >= 3;                                     // three screens: the words above, the screens along the bottom
  const ph = n <= 1 ? 6.0 : n === 2 ? 5.4 : 3.9;
  const pw = ph * PHONE;
  const gap = wide ? 0.6 : 0.25;
  const right = 12.75;
  const totalW = n * pw + (n - 1) * gap;
  const x0 = wide ? (13.33 - totalW) / 2 : right - totalW;
  shots.forEach((name, i) => s.addImage({ path: shot(name), x: x0 + i * (pw + gap), y: wide ? 3.0 : n <= 1 ? 0.95 : 1.25, w: pw, h: ph, objectName: `screen ${name}` }));
  const textW = wide ? 12.1 : Math.max(4.6, x0 - 0.6 - 0.4);
  /* the words: big, few, one idea a line */
  const runs = [];
  lines.forEach((ln, i) => {
    const parts = typeof ln === 'string' ? [ln] : ln;
    parts.forEach((p) => runs.push(typeof p === 'string' ? { text: p, options: { bullet: parts === lines[i] && lines.length > 1 ? { indent: 18 } : false } } : { text: p.text, options: { bold: !!p.bold, color: p.color || undefined } }));
    runs[runs.length - 1].options.breakLine = i < lines.length - 1;
  });
  // bullets for a list, plain paragraphs for one line
  const items = lines.map((ln, i) => {
    const parts = (typeof ln === 'string' ? [ln] : ln).map((p) => (typeof p === 'string' ? { text: p, options: {} } : { text: p.text, options: { bold: !!p.bold, color: p.color } }));
    /* pptxgenjs starts a new paragraph at any run carrying a bullet - unless the box has an align, when it
       splits only where the align changes - and takes the paragraph's settings from its last run. So the box
       is aligned, and every run of a line carries the same bullet; the last one ends the line. */
    for (const q of parts) q.options = { ...q.options, bullet: lines.length > 1 && !plain ? { indent: 18 } : false, paraSpaceAfter: plain ? 14 : 10 };
    parts[parts.length - 1].options.breakLine = i < lines.length - 1;
    return parts;
  }).flat();
  s.addText(items, { x: 0.6, y: 1.85, w: textW, h: wide ? 1.1 : labels.length ? 2.9 : 4.6, fontSize: wide ? 18 : 22, color: C.background2, valign: 'top', align: 'left', margin: 0, isTextBox: true, objectName: 'what to do' });
  /* the labels being scanned, under the words */
  const ly = 4.95;
  let lx = 0.6;
  for (const name of labels) {
    const sizes = { 'label-pallet': [3.1, 1.3], 'label-rack': [3.1, 1.36], 'label-badge': [1.6, 1.5], 'label-team': [1.6, 1.85] };
    const [w, h] = sizes[name] || [2.6, 1.3];
    s.addImage({ path: shot(name), x: lx, y: ly, w, h, objectName: name, rounding: false });
    lx += w + 0.3;
  }
  if (tip) {
    s.addShape(pres.ShapeType.roundRect, { x: 0.6, y: 6.25, w: Math.min(textW, 7.2), h: 0.55, fill: { color: THEME.colors.dk2 }, line: { color: THEME.colors.accent1, width: 1 }, rectRadius: 0.12, objectName: 'tip box' });
    s.addText(tip, { x: 0.78, y: 6.25, w: Math.min(textW, 7.2) - 0.3, h: 0.55, fontSize: 16, bold: true, color: C.accent1, valign: 'middle', margin: 0, isTextBox: true, objectName: 'tip' });
  }
  if (notes) s.addNotes(notes);
  return s;
}
function part(n, title, blurb) {
  section = `${L('Part', 'Parte')} ${n} · ${title}`;
  pres.addSection({ title: section });
  const s = pres.addSlide({ masterName: 'part', sectionTitle: section });
  s.addText(`${L('Part', 'Parte')} ${n}`, { placeholder: 'kicker' });
  s.addText(title, { placeholder: 'title' });
  s.addText(blurb, { placeholder: 'body' });
  s.addNotes(blurb);
}

/* ================================================================ the deck */
section = L('Start', 'Inicio');
pres.addSection({ title: section });
{
  const s = pres.addSlide({ masterName: 'cover', sectionTitle: section });
  s.addText(L('Day 1 · Counting crew', 'Día 1 · Equipo de conteo'), { placeholder: 'kicker' });
  s.addText(L('How to count with the scanner', 'Cómo contar con el escáner'), { placeholder: 'title' });
  s.addText(L('Scan the rack. Scan the pallet. Type what is there.\nThat is the whole job — these slides show every step.', 'Escanea el rack. Escanea la tarima. Escribe lo que hay.\nEse es todo el trabajo — estas láminas muestran cada paso.'), { placeholder: 'body' });
  s.addNotes(L('Welcome. Today you learn the scanner. The job is three steps, over and over: scan the rack label, scan the pallet label, type how many cases are really there. Everything else is the scanner helping you when something is unusual. The film shows the same steps slowly; these slides are the same lesson to keep.', 'Bienvenidos. Hoy aprenden el escáner. El trabajo son tres pasos, una y otra vez: escanear la etiqueta del rack, escanear la etiqueta de la tarima, escribir cuántas cajas hay de verdad. Todo lo demás es el escáner ayudándote cuando algo es diferente. El video muestra los mismos pasos despacio; estas láminas son la misma lección para conservar.'));
}

{
  /* the agenda: seven parts, then the wall */
  const s = pres.addSlide({ masterName: 'content', sectionTitle: section });
  s.addText(L('Today', 'Hoy'), { placeholder: 'kicker' });
  s.addText(L('How today goes', 'Cómo va el día de hoy'), { placeholder: 'title' });
  const parts = [
    [L('1 · Before you start', '1 · Antes de empezar'), L('the scanner, your language', 'el escáner, tu idioma')],
    [L('2 · Signing on', '2 · Iniciar sesión'), L('team card, badges, your aisle', 'tarjeta del equipo, gafetes, tu pasillo')],
    [L('3 · Counting a pallet', '3 · Contar una tarima'), L('rack · pallet · quantity', 'rack · tarima · cantidad')],
    [L('4 · When a bin is different', '4 · Cuando la ubicación es diferente'), L('several pallets, an empty spot', 'varias tarimas, un lugar vacío')],
    [L('5 · Labels', '5 · Etiquetas'), L('two labels, one that will not scan, a pallet nobody expected', 'dos etiquetas, una que no escanea, una tarima que nadie esperaba')],
    [L('6 · Help and fixes', '6 · Ayuda y correcciones'), L('mistakes, messages, no Wi-Fi, SOS', 'errores, mensajes, sin Wi-Fi, SOS')],
    [L('7 · Second counts, and finishing', '7 · Segundos conteos, y terminar'), L('counting again, handing the aisle back', 'volver a contar, entregar el pasillo')],
  ];
  parts.forEach(([a, b], i) => {
    const y = 1.85 + i * 0.62;
    s.addShape(pres.ShapeType.ellipse, { x: 0.6, y: y + 0.06, w: 0.42, h: 0.42, fill: { color: THEME.colors.accent1 }, line: { color: THEME.colors.accent1, width: 0 }, objectName: `step ${i + 1}` });
    s.addText(String(i + 1), { x: 0.6, y: y + 0.06, w: 0.42, h: 0.42, fontSize: 14, bold: true, color: C.text1, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: `step ${i + 1} number` });
    s.addText([{ text: a.replace(/^\d · /, ''), options: { bold: true, color: C.background1 } }, { text: '  ' + b, options: { color: C.accent5 } }], { x: 1.2, y, w: 7.2, h: 0.54, fontSize: 18, valign: 'middle', margin: 0, isTextBox: true, objectName: `part ${i + 1}` });
  });
  s.addShape(pres.ShapeType.roundRect, { x: 8.8, y: 1.85, w: 3.95, h: 4.3, fill: { color: THEME.colors.dk2 }, line: { color: THEME.colors.accent1, width: 1 }, rectRadius: 0.15, objectName: 'then box' });
  s.addText([
    { text: L('Then, with scanners in hand', 'Después, con el escáner en la mano'), options: { bold: true, color: C.accent1, breakLine: true, paraSpaceAfter: 8 } },
    { text: L('The film first, ten minutes.', 'Primero el video, diez minutos.'), options: { breakLine: true, bullet: { indent: 14 } } },
    { text: L('These slides, stopping at every yellow tip.', 'Estas láminas, parando en cada consejo amarillo.'), options: { breakLine: true, bullet: { indent: 14 } } },
    { text: L('The wall: a real count on printed labels, team by team.', 'La pared: un conteo real en etiquetas impresas, equipo por equipo.'), options: { breakLine: true, bullet: { indent: 14 } } },
    { text: L('Your pocket card to keep.', 'Tu tarjeta de bolsillo para conservar.'), options: { bullet: { indent: 14 } } },
  ], { x: 9.0, y: 2.0, w: 3.6, h: 4.0, fontSize: 15, color: C.background2, valign: 'top', margin: 0, isTextBox: true, objectName: 'then' });
  s.addNotes(L('Seven short parts, then everybody counts the wall with a real scanner. Questions at any time.', 'Siete partes cortas, y luego todos cuentan la pared con un escáner real. Preguntas en cualquier momento.'));
}

part(1, L('Before you start', 'Antes de empezar'), L('The scanner, its buttons, and your language.', 'El escáner, sus botones y tu idioma.'));
content({
  title: L('This is your scanner', 'Este es tu escáner'),
  lines: [
    [{ text: L('The trigger', 'El gatillo'), bold: true }, L(' reads a barcode. Wait for the beep.', ' lee un código de barras. Espera el bip.')],
    [{ text: L('The number keys', 'Las teclas'), bold: true }, L(' type a quantity, then Enter.', ' escriben una cantidad, luego Enter.')],
    [{ text: L('The screen', 'La pantalla'), bold: true }, L(' asks one thing at a time, in big letters. Read the top, do what it says.', ' pide una cosa a la vez, con letras grandes. Lee arriba y haz lo que dice.')],
  ],
  tip: L('Rack · Pallet · Quantity — over and over', 'Rack · Tarima · Cantidad — una y otra vez'),
  shots: ['signon'],
  notes: L('Hold up a scanner. Show the trigger, the number keys and the screen. The screen in the middle of every slide is the real app.', 'Muestra un escáner. Señala el gatillo, las teclas y la pantalla. La pantalla en el centro de cada lámina es la app real.'),
});
content({
  title: L('English or Spanish', 'Inglés o español'),
  lines: [
    [L('The ', 'El botón '), { text: 'Español', bold: true }, L(' button at the top right switches the whole screen to Spanish.', ' arriba a la derecha cambia toda la pantalla a español.')],
    L('It stays that way on this scanner until somebody switches it back.', 'Se queda así en este escáner hasta que alguien lo cambie otra vez.'),
    L('The office always reads English, whichever you use.', 'La oficina siempre lee en inglés, uses el que uses.'),
  ],
  shots: [LANG === 'es' && files.some((f) => f.endsWith('signon-es.png')) ? 'signon-es' : 'signon'],
  notes: L('Tap Español once; tap English to go back. Nothing else changes.', 'Toca Español una vez; toca English para regresar. Nada más cambia.'),
});

part(2, L('Signing on', 'Iniciar sesión'), L('Your team card, your badges, and your aisle.', 'Tu tarjeta de equipo, tus gafetes y tu pasillo.'));
content({
  title: L('The team card, then every badge', 'La tarjeta del equipo, luego cada gafete'),
  lines: [
    [{ text: L('1 · ', '1 · '), bold: true }, L('Scan the team’s QR card into ', 'Escanea la tarjeta QR del equipo en '), { text: L('Team number', 'Número de equipo'), bold: true }, L('. No typing.', '. Sin escribir.')],
    [{ text: '2 · ', bold: true }, L('Everybody on the crew scans their ', 'Cada persona del equipo escanea su '), { text: L('badge', 'gafete'), bold: true }, L('. Each name shows on the screen.', '. Cada nombre aparece en la pantalla.')],
    [{ text: '3 · ', bold: true }, L('Tap ', 'Toca '), { text: L('Sign on & load list', 'Entrar y cargar la lista'), bold: true }, L('. The scanner downloads the count and keeps working with no Wi-Fi.', '. El escáner descarga el conteo y sigue trabajando sin Wi-Fi.')],
  ],
  labels: ['label-team', 'label-badge'],
  shots: ['signon-filled'],
  notes: L('Each team has a printed card with a QR code. Scan it where it says Team number. Then each person scans their own badge. Tap a number on the screen to remove it if it is wrong. Then Sign on.', 'Cada equipo tiene una tarjeta impresa con un código QR. Escanéala donde dice Número de equipo. Luego cada persona escanea su propio gafete. Toca un número en la pantalla para quitarlo si está mal. Luego Entrar.'),
});
content({
  title: L('Your aisle', 'Tu pasillo'),
  lines: [
    L('The scanner gives your team its aisle and the levels you count.', 'El escáner le da a tu equipo su pasillo y los niveles que cuentan.'),
    L('Only your team works this aisle right now.', 'Solo tu equipo trabaja este pasillo ahora.'),
    [L('When you are at the aisle, tap ', 'Cuando estén en el pasillo, toquen '), { text: L('Start counting', 'Empezar a contar'), bold: true }, '.'],
  ],
  tip: L('Aisle F01 · levels A–C', 'Pasillo F01 · niveles A–C'),
  shots: ['your-aisle'],
  notes: L('The aisle is chosen by the office. You never pick one. If the screen says the aisle is still being counted by another team, wait: it starts by itself when the racking is free.', 'El pasillo lo escoge la oficina. Tú nunca eliges uno. Si la pantalla dice que otro equipo sigue en el pasillo, espera: empieza solo cuando el rack esté libre.'),
});

part(3, L('Counting a pallet', 'Contar una tarima'), L('Three steps, over and over: the rack, the pallet, the quantity.', 'Tres pasos, una y otra vez: el rack, la tarima, la cantidad.'));
content({
  title: L('Where to go next', 'A dónde ir'),
  lines: [
    [L('The box at the top says ', 'El cuadro de arriba dice '), { text: L('Next bin', 'Siguiente ubicación'), bold: true }, L(' — the spot to go to.', ' — el lugar a donde ir.')],
    L('It walks you down the aisle in order, so nothing is missed.', 'Te lleva por el pasillo en orden, para que no se pierda nada.'),
    L('Follow it. Do not jump around the aisle.', 'Síguelo. No brinques de un lado a otro del pasillo.'),
  ],
  shots: ['next-bin'],
  notes: L('Point at the Next bin box. Explain the code: F01 is the aisle, A the level, 001 the position.', 'Señala el cuadro Siguiente ubicación. Explica el código: F01 es el pasillo, A el nivel, 001 la posición.'),
});
content({
  kicker: `${section} · ${L('Step 1', 'Paso 1')}`,
  title: L('1 · Scan the rack label', '1 · Escanea la etiqueta del rack'),
  lines: [
    L('Point the scanner at the yellow rack label under the pallet. Pull the trigger. Wait for the beep.', 'Apunta el escáner a la etiqueta amarilla del rack debajo de la tarima. Aprieta el gatillo. Espera el bip.'),
    L('That tells the system where you are. The scanner checks it is in your aisle and on your levels.', 'Así el sistema sabe dónde estás. El escáner revisa que sea de tu pasillo y tus niveles.'),
  ],
  labels: ['label-rack'],
  shots: ['rack-scanned'],
  notes: L('Show a rack label. It is on the beam under the pallet. Scan the one for the spot you are counting, not the one next to it.', 'Muestra una etiqueta de rack. Está en la viga debajo de la tarima. Escanea la del lugar que estás contando, no la de al lado.'),
});
content({
  kicker: `${section} · ${L('Step 2', 'Paso 2')}`,
  title: L('2 · Scan the pallet label', '2 · Escanea la etiqueta de la tarima'),
  lines: [
    L('Now the barcode on the pallet label. Wait for the beep.', 'Ahora el código de barras de la etiqueta de la tarima. Espera el bip.'),
    [L('The scanner shows the pallet number. It does ', 'El escáner muestra el número de tarima. '), { text: L('not', 'No'), bold: true }, L(' tell you how many should be there.', ' te dice cuántas cajas debería haber.')],
  ],
  tip: L('A blind count: you count what is in front of you', 'Un conteo a ciegas: cuentas lo que tienes enfrente'),
  labels: ['label-pallet'],
  shots: ['pallet-scanned'],
  notes: L('Show a real pallet label. The barcode is what the scanner reads. The scanner says Pallet F01-001 and nothing about what is on it: that is on purpose.', 'Muestra una etiqueta real de tarima. El código de barras es lo que lee el escáner. El escáner dice Tarima F01-001 y nada de lo que lleva: es a propósito.'),
});
content({
  kicker: `${section} · ${L('Step 3', 'Paso 3')}`,
  title: L('3 · Count, then type the quantity', '3 · Cuenta y escribe la cantidad'),
  lines: [
    [L('Count the cases that are ', 'Cuenta las cajas que '), { text: L('really there', 'de verdad están ahí'), bold: true }, '.'],
    L('Type the number on the number keys, then press Enter.', 'Escribe el número con las teclas y oprime Enter.'),
    [{ text: L('Never', 'Nunca'), bold: true }, L(' type what you think it should be. A big number may need typing twice.', ' escribas lo que crees que debería ser. Un número grande puede pedirse dos veces.')],
  ],
  shots: ['quantity'],
  notes: L('This is the step that matters. If the pallet says 48 and you count 45, type 45. The office works out the rest.', 'Este es el paso que importa. Si la tarima dice 48 y cuentas 45, escribe 45. La oficina resuelve el resto.'),
});
content({
  kicker: `${section} · ${L('Step 4', 'Paso 4')}`,
  title: L('4 · A comment, if there is one', '4 · Un comentario, si hay'),
  lines: [
    L('The scanner offers quick reasons — damaged, partial, and so on. Tap one if it fits.', 'El escáner ofrece razones rápidas — dañada, incompleta, etc. Toca una si aplica.'),
    [L('Nothing to say? Tap ', '¿Nada que decir? Toca '), { text: L('Skip', 'Saltar'), bold: true }, L('. On count day it also moves on by itself.', '. El día del conteo también sigue solo.')],
    L('The pallet is saved. The scanner sends it to the office by itself.', 'La tarima queda guardada. El escáner la manda a la oficina solo.'),
  ],
  tip: L('Saved — now the next pallet, the same three steps', 'Guardado — ahora la siguiente tarima, los mismos tres pasos'),
  shots: ['comments'],
  notes: L('Most pallets need no comment. Do not stop to type notes; tap a reason only when something is wrong with the pallet.', 'La mayoría de las tarimas no necesitan comentario. No te detengas a escribir notas; toca una razón solo cuando algo está mal con la tarima.'),
});
content({
  title: L('The wrong label? It tells you', '¿Etiqueta equivocada? Te avisa'),
  lines: [
    L('If you scan the pallet label when it asks for the rack, the scanner says so and records nothing.', 'Si escaneas la etiqueta de la tarima cuando pide el rack, el escáner te avisa y no guarda nada.'),
    L('Just scan the right one.', 'Solo escanea la correcta.'),
  ],
  shots: ['wrong-label'],
  notes: L('Nothing bad happens from a wrong scan. Read the message and scan the right label.', 'No pasa nada malo por un escaneo equivocado. Lee el mensaje y escanea la etiqueta correcta.'),
});

part(4, L('When a bin is different', 'Cuando la ubicación es diferente'), L('Several pallets in one spot, and an empty spot.', 'Varias tarimas en un lugar, y un lugar vacío.'));
content({
  title: L('More than one pallet in a spot', 'Más de una tarima en un lugar'),
  lines: [
    [L('After the first pallet the box turns orange: ', 'Después de la primera tarima el cuadro se pone naranja: '), { text: L('Still in this bin', 'Sigues en esta ubicación'), bold: true }, L(', with a count — 1 of 3.', ', con un contador — 1 de 3.')],
    L('Count every pallet in the spot before you move on. Same three steps for each.', 'Cuenta cada tarima del lugar antes de seguir. Los mismos tres pasos para cada una.'),
    [L('The scanner expects more but there are none? Tap ', '¿El escáner espera más pero no hay? Toca '), { text: L('Nothing more here →', 'No hay más aquí →'), bold: true }, '.'],
  ],
  tip: L('Never leave a spot half counted', 'Nunca dejes un lugar a medias'),
  shots: ['still-in-bin'],
  notes: L('A spot with three pallets is normal in the freezer. The orange box keeps you there until every pallet is counted.', 'Un lugar con tres tarimas es normal en el congelador. El cuadro naranja te mantiene ahí hasta contar cada tarima.'),
});
content({
  title: L('An empty spot', 'Un lugar vacío'),
  lines: [
    L('Nothing in the spot? That counts too. Scan the rack label as usual.', '¿No hay nada en el lugar? Eso también cuenta. Escanea la etiqueta del rack como siempre.'),
    [L('Then tap ', 'Luego toca '), { text: L('Bin is EMPTY', 'Ubicación VACÍA'), bold: true }, L(', and ', ' y '), { text: L('Yes — it is empty', 'Sí — está vacía'), bold: true }, '.'],
    L('Now the office knows it was checked and is empty.', 'Así la oficina sabe que se revisó y está vacío.'),
  ],
  labels: ['label-rack'],
  shots: ['empty-button'],
  notes: L('An empty spot that is not recorded looks like a spot nobody reached. Always record it.', 'Un lugar vacío que no se registra parece un lugar al que nadie llegó. Regístralo siempre.'),
});

part(5, L('Labels', 'Etiquetas'), L('Two labels on one pallet, a label that will not scan, and a pallet nobody expected.', 'Dos etiquetas en una tarima, una etiqueta que no escanea, y una tarima que nadie esperaba.'));
content({
  title: L('A pallet with two labels', 'Una tarima con dos etiquetas'),
  lines: [
    [L('Scan the rack as usual · tap ', 'Escanea el rack como siempre · toca '), { text: L('This pallet has more than one label', 'Esta tarima tiene más de una etiqueta'), bold: true }, L(' · label 1 and its cases · label 2 and its cases · ', ' · etiqueta 1 y sus cajas · etiqueta 2 y sus cajas · '), { text: L('Done', 'Listo'), bold: true }],
  ],
  shots: ['multi-label-button', 'multi-label-2', 'multi-label-done'],
  notes: L('Some pallets carry two loads, each with its own label. Each label gets its own quantity. The rack is scanned once, before the button.', 'Algunas tarimas llevan dos cargas, cada una con su etiqueta. Cada etiqueta lleva su propia cantidad. El rack se escanea una vez, antes del botón.'),
});
content({
  title: L('Saw the second label too late?', '¿Viste la segunda etiqueta tarde?'),
  lines: [
    L('Already counted the pallet and then spotted another label?', '¿Ya contaste la tarima y luego viste otra etiqueta?'),
    [L('Tap ', 'Toca '), { text: L('Another label on the pallet just counted', 'Otra etiqueta en la tarima recién contada'), bold: true }, '.'],
    [L('Scan it, type its cases, then ', 'Escanéala, escribe sus cajas y luego '), { text: L('Done', 'Listo'), bold: true }, '.'],
  ],
  shots: ['same-label-button'],
  notes: L('The scanner keeps the same spot, so you do not scan the rack again.', 'El escáner conserva el mismo lugar, así que no escaneas el rack otra vez.'),
});
content({
  title: L('A label that will not scan', 'Una etiqueta que no escanea'),
  lines: [
    [L('Ice, a rip, a faded label. ', 'Hielo, rota, borrosa. '), { text: L('Never skip the pallet.', 'Nunca te saltes la tarima.'), bold: true }],
    [L('Tap ', 'Toca '), { text: L('Label will not scan', 'La etiqueta no escanea'), bold: true }, L('. Can you read the number? Tap ', '. ¿Puedes leer el número? Toca '), { text: L('I can read it — let me type it', 'La puedo leer — la escribo'), bold: true }, L(' and type it.', ' y escríbelo.')],
    L('The office gets a list of labels to replace. You keep counting.', 'La oficina recibe una lista de etiquetas para cambiar. Tú sigues contando.'),
  ],
  tip: L('The pallet still gets counted', 'La tarima sí se cuenta'),
  shots: ['no-scan'],
  notes: L('If nothing on the label can be read, tap Nothing readable on it: the pallet is still counted, under its spot.', 'Si no se puede leer nada en la etiqueta, toca No se puede leer nada: la tarima se cuenta igual, en su lugar.'),
});
content({
  title: L('A pallet nobody expected', 'Una tarima que nadie esperaba'),
  lines: [
    [L('A pallet that is not on the list? The scanner asks ', '¿Una tarima que no está en la lista? El escáner pregunta '), { text: L('Count it anyway?', '¿Contarla de todos modos?'), bold: true }],
    [L('Tap ', 'Toca '), { text: L('YES', 'SÍ'), bold: true }, L(' and count it like any other. Wrong barcode? Tap ', ' y cuéntala como cualquier otra. ¿Código equivocado? Toca '), { text: 'NO', bold: true }, '.'],
    [L('If the scanner ever asks ', 'Si alguna vez el escáner pregunta '), { text: L('why', 'por qué'), bold: true }, L(', pick a reason and tap ', ', escoge una razón y toca '), { text: L('Accept and continue', 'Aceptar y seguir'), bold: true }, '.'],
  ],
  tip: L('Not sure? Ask your lead', '¿No estás seguro? Pregunta a tu líder'),
  shots: ['not-on-list'],
  notes: L('Found stock is never lost: the office sees it and adds it to the system.', 'La mercancía encontrada no se pierde: la oficina la ve y la agrega al sistema.'),
});

part(6, L('Help and fixes', 'Ayuda y correcciones'), L('Mistakes, messages, no Wi-Fi, problems, and the SOS button.', 'Errores, mensajes, sin Wi-Fi, problemas y el botón SOS.'));
content({
  title: L('Made a mistake?', '¿Te equivocaste?'),
  lines: [
    [L('Before finishing the pallet: ', 'Antes de terminar la tarima: '), { text: L('Back', 'Atrás'), bold: true }, L(' goes back one step.', ' regresa un paso.')],
    [L('Already saved: tap ', 'Ya guardada: toca '), { text: L('History', 'Historial'), bold: true }, L(' — your team’s lines in the last 20 bins. ', ' — las líneas de tu equipo en las últimas 20 ubicaciones. '), { text: L('Void this line', 'Anular esta línea'), bold: true }, L(' takes a wrong one out and sends you back to that bin.', ' quita una mal hecha y te regresa a esa ubicación.')],
  ],
  shots: ['history'],
  notes: L('Void only your own wrong line. The office keeps a record that it was voided.', 'Anula solo tu propia línea equivocada. La oficina guarda el registro de que se anuló.'),
});
content({
  title: L('A message from the office', 'Un mensaje de la oficina'),
  lines: [
    L('Your lead can send a message to your scanner. It buzzes and stays on the screen.', 'Tu líder puede mandar un mensaje a tu escáner. Vibra y se queda en la pantalla.'),
    [L('Read it, then tap ', 'Léelo y toca '), { text: L('Got it', 'Entendido'), bold: true }, L(' — the office sees that you read it.', ' — la oficina ve que lo leíste.')],
  ],
  shots: ['message'],
  notes: L('A red message is urgent. Nothing is blocked: you can keep scanning under it.', 'Un mensaje rojo es urgente. Nada se bloquea: puedes seguir escaneando debajo.'),
});
content({
  title: L('No Wi-Fi? Keep counting', '¿Sin Wi-Fi? Sigue contando'),
  lines: [
    [L('In the freezer the Wi-Fi can drop. The top of the screen says ', 'En el congelador el Wi-Fi se puede caer. Arriba dice '), { text: L('OFFLINE', 'SIN SEÑAL'), bold: true }, '.'],
    [{ text: L('Keep counting.', 'Sigue contando.'), bold: true }, L(' Everything is saved on the scanner.', ' Todo se guarda en el escáner.')],
    L('When the signal is back, the lines go to the office on their own. Nothing to type again.', 'Cuando regresa la señal, las líneas se van a la oficina solas. No hay que escribir nada otra vez.'),
  ],
  tip: L('Nothing is lost', 'No se pierde nada'),
  shots: ['offline'],
  notes: L('The number next to OFFLINE is how many lines are waiting. They send by themselves.', 'El número junto a SIN SEÑAL es cuántas líneas esperan. Se mandan solas.'),
});
content({
  title: L('Something wrong with the spot', 'Algo está mal en el lugar'),
  lines: [
    L('Damaged pallet, broken rack, a spot blocked by a truck?', '¿Tarima dañada, rack roto, un lugar bloqueado por un montacargas?'),
    [L('Tap ', 'Toca '), { text: L('Report a problem', 'Reportar un problema'), bold: true }, L(', pick what it is, and scan to confirm.', ', escoge qué es y escanea para confirmar.')],
    [L('It goes on the office’s fix list. It is ', 'Va a la lista de arreglos de la oficina. '), { text: L('not', 'No'), bold: true }, L(' an emergency.', ' es una emergencia.')],
  ],
  shots: ['report-problem'],
  notes: L('Use Report a problem for things that need fixing later. Use SOS for help now.', 'Usa Reportar un problema para cosas que se arreglan después. Usa SOS para ayuda ya.'),
});
content({
  title: L('SOS — when you need help now', 'SOS — cuando necesitas ayuda ya'),
  lines: [
    L('Hurt, stuck, equipment broken, or you need a supervisor.', 'Alguien lastimado, atrapado, equipo roto, o necesitas un supervisor.'),
    [L('Tap the red ', 'Toca el botón rojo '), { text: L('SOS — I need help', 'SOS — necesito ayuda'), bold: true }, L(' and pick what is wrong.', ' y escoge qué pasa.')],
    L('The office sees your team, your aisle and your last spot right away. When a supervisor picks it up, your scanner says who has seen it.', 'La oficina ve tu equipo, tu pasillo y tu último lugar de inmediato. Cuando un supervisor lo atiende, tu escáner dice quién lo vio.'),
  ],
  tip: L('No signal? It says it was NOT sent — go and find someone', '¿Sin señal? Dice que NO se mandó — ve a buscar a alguien'),
  shots: ['sos-list', 'sos-seen'],
  notes: L('Use it for real emergencies. The office gets a loud alert.', 'Úsalo para emergencias de verdad. La oficina recibe una alerta fuerte.'),
});

part(7, L('Second counts, and finishing', 'Segundos conteos, y terminar'), L('Counting a spot again, handing the aisle back, and signing off.', 'Volver a contar un lugar, entregar el pasillo y salir.'));
content({
  title: L('Second counts', 'Segundos conteos'),
  lines: [
    L('Sometimes the office needs a spot counted again, by a different team.', 'A veces la oficina necesita contar un lugar otra vez, por otro equipo.'),
    [L('When there are some for you, ', 'Cuando hay para ti, '), { text: L('My aisle', 'Mi pasillo'), bold: true }, L(' shows ', ' muestra '), { text: L('Start second counts', 'Empezar segundos conteos'), bold: true }, '.'],
    [L('Go to the spot and count everything in it — rack, pallet, quantity. Then tap ', 'Ve al lugar y cuenta todo — rack, tarima, cantidad. Luego toca '), { text: L('Bin done — nothing more here', 'Ubicación terminada — no hay más aquí'), bold: true }, '.'],
  ],
  tip: L('You are not told the first count', 'No te dicen el primer conteo'),
  shots: ['second-counts-offered', 'second-count'],
  notes: L('A second count is blind too. Count what is there.', 'Un segundo conteo también es a ciegas. Cuenta lo que hay.'),
});
content({
  title: L('Finishing the aisle, and signing off', 'Terminar el pasillo, y salir'),
  lines: [
    [L('When every spot on your levels is counted, ', 'Cuando cada lugar de tus niveles está contado, '), { text: L('tell your supervisor', 'avisa a tu supervisor'), bold: true }, L('. They mark the aisle done in the office — no button on the scanner — and your next aisle appears on ', '. Él marca el pasillo terminado en la oficina — sin botón en el escáner — y tu siguiente pasillo aparece en '), { text: L('My aisle', 'Mi pasillo'), bold: true }, L(' by itself.', ' solo.')],
    [L('Break or home? Tap ', '¿Descanso o a casa? Toca '), { text: L('Sign off this scanner', 'Salir de este escáner'), bold: true }, L(' and put the scanner on its charger.', ' y pon el escáner en su cargador.')],
  ],
  shots: ['aisle-complete', 'next-aisle'],
  notes: L('The next crew signs on with their own card and badges.', 'El siguiente equipo entra con su tarjeta y gafetes.'),
});

section = L('The rules', 'Las reglas');
pres.addSection({ title: section });
{
  /* do and don't, side by side */
  const s = pres.addSlide({ masterName: 'content', sectionTitle: section });
  s.addText(section, { placeholder: 'kicker' });
  s.addText(L('Do · Don’t', 'Sí · No'), { placeholder: 'title' });
  const col = (x, head, color, items, name) => {
    s.addShape(pres.ShapeType.roundRect, { x, y: 1.85, w: 5.9, h: 4.75, fill: { color: THEME.colors.dk2 }, line: { color, width: 1.5 }, rectRadius: 0.15, objectName: `${name} box` });
    s.addText(head, { x: x + 0.3, y: 2.0, w: 5.3, h: 0.5, fontSize: 22, bold: true, color, margin: 0, isTextBox: true, objectName: `${name} head` });
    s.addText(items.map((t, i) => ({ text: t, options: { bullet: { indent: 16 }, paraSpaceAfter: 9, breakLine: i < items.length - 1 } })), { x: x + 0.3, y: 2.6, w: 5.3, h: 3.9, fontSize: 16, color: C.background2, valign: 'top', margin: 0, isTextBox: true, objectName: `${name} list` });
  };
  col(0.6, L('✓ Do', '✓ Sí'), THEME.colors.accent2, [
    L('Read the top line of the screen before you scan', 'Lee la línea de arriba antes de escanear'),
    L('Scan the rack label of the spot you are in, every time', 'Escanea la etiqueta del rack del lugar donde estás, cada vez'),
    L('Count the cases; type that number', 'Cuenta las cajas; escribe ese número'),
    L('Record empty spots: Bin is EMPTY', 'Registra los lugares vacíos: Ubicación VACÍA'),
    L('Finish every pallet in a spot before moving on', 'Termina cada tarima del lugar antes de seguir'),
    L('Tell your supervisor when the aisle is done', 'Avisa a tu supervisor cuando el pasillo esté terminado'),
  ], 'do');
  col(6.85, L('✗ Don’t', '✗ No'), THEME.colors.accent3, [
    L('Type what the label says the pallet should hold', 'Escribas lo que la etiqueta dice que debería haber'),
    L('Skip a pallet because the label is torn or iced', 'Te saltes una tarima porque la etiqueta está rota o con hielo'),
    L('Scan the rack label next door because it is closer', 'Escanees la etiqueta del rack de al lado porque está más cerca'),
    L('Jump around the aisle — follow Next bin', 'Brinques por el pasillo — sigue Siguiente ubicación'),
    L('Stop counting when the Wi-Fi drops', 'Dejes de contar cuando se cae el Wi-Fi'),
    L('Guess. Ask your lead, or press SOS', 'Adivines. Pregunta a tu líder, o toca SOS'),
  ], 'dont');
  s.addNotes(L('Go down both columns. Every line on the right is a mistake we have seen on a count day.', 'Recorre las dos columnas. Cada línea de la derecha es un error que hemos visto en un día de conteo.'));
}
content({
  title: L('Now you: the wall', 'Ahora tú: la pared'),
  lines: [
    L('Eighteen spots on paper, two short aisles — a real count in the app, on stock that is not real.', 'Dieciocho lugares en papel, dos pasillos cortos — un conteo real en la app, con mercancía que no es real.'),
    [L('Sign on with the ', 'Entra con la '), { text: L('team card', 'tarjeta del equipo'), bold: true }, L(' and each ', ' y cada '), { text: L('badge', 'gafete'), bold: true }, L(' from the table. Count your aisle, spot by spot.', ' de la mesa. Cuenta tu pasillo, lugar por lugar.')],
    L('Everything from these slides is on the wall somewhere. The office screen is on the TV.', 'Todo lo de estas láminas está en la pared en algún lugar. La pantalla de la oficina está en la TV.'),
  ],
  tip: L('Read the top line out loud before you scan', 'Lee la línea de arriba en voz alta antes de escanear'),
  labels: ['label-rack', 'label-pallet'],
  shots: ['next-bin'],
  notes: L('The wall is the training count from the Testing Suite. One person scans at each spot; the rest watch the Dashboard. The run sheet is the guide Run the training day.', 'La pared es el conteo de entrenamiento del Testing Suite. Una persona escanea en cada lugar; los demás miran el Dashboard. La hoja de ruta es la guía Run the training day.'),
});
content({
  title: L('The five rules', 'Las cinco reglas'),
  plain: true,
  lines: [
    [{ text: L('Count what is really there.', 'Cuenta lo que de verdad hay.'), bold: true }, L(' Never what it should be.', ' Nunca lo que debería ser.')],
    [{ text: L('Never skip a pallet.', 'Nunca te saltes una tarima.'), bold: true }, L(' No label? Label will not scan.', ' ¿Sin etiqueta? La etiqueta no escanea.')],
    [{ text: L('Follow Next bin.', 'Sigue Siguiente ubicación.'), bold: true }, L(' Every spot, in order, empty ones too.', ' Cada lugar, en orden, los vacíos también.')],
    [{ text: L('No Wi-Fi? Keep counting.', '¿Sin Wi-Fi? Sigue contando.'), bold: true }],
    [{ text: L('Not sure? Ask your lead.', '¿Dudas? Pregunta a tu líder.'), bold: true }, L(' Help now? SOS.', ' ¿Ayuda ya? SOS.')],
  ],
  shots: ['next-bin'],
  notes: L('Read the five rules out loud. Then hand out the scanners and start the practice at the desk.', 'Lee las cinco reglas en voz alta. Luego reparte los escáneres y empieza la práctica en la mesa.'),
});
{
  const s = pres.addSlide({ masterName: 'content', sectionTitle: section });
  s.addText(section, { placeholder: 'kicker' });
  s.addText(L('The buttons, on one page', 'Los botones, en una página'), { placeholder: 'title' });
  const rows = [
    [L('Bin is EMPTY', 'Ubicación VACÍA'), L('Nothing in the spot: after the rack, tap it, then Yes', 'No hay nada en el lugar: después del rack, tócalo y luego Sí')],
    [L('Nothing more here →', 'No hay más aquí →'), L('The scanner expects more pallets, there are none', 'El escáner espera más tarimas, no hay')],
    [L('This pallet has more than one label', 'Esta tarima tiene más de una etiqueta'), L('After the rack: each label with its cases, then Done', 'Después del rack: cada etiqueta con sus cajas, luego Listo')],
    [L('Another label on the pallet just counted', 'Otra etiqueta en la tarima recién contada'), L('A second label seen after saving', 'Una segunda etiqueta vista después de guardar')],
    [L('Label will not scan', 'La etiqueta no escanea'), L('Type what is printed, or count it without a label', 'Escribe lo impreso, o cuéntala sin etiqueta')],
    [L('Back / Keyboard', 'Atrás / Teclado'), L('One step back / type by hand', 'Un paso atrás / escribir a mano')],
    [L('History → Void this line', 'Historial → Anular esta línea'), L('Take a wrong line out', 'Quitar una línea mal hecha')],
    [L('Report a problem', 'Reportar un problema'), L('Damage or a blocked spot. Not an emergency', 'Daño o un lugar bloqueado. No es emergencia')],
    [L('SOS — I need help', 'SOS — necesito ayuda'), L('An emergency. The office comes', 'Una emergencia. La oficina viene')],
    [L('Refresh, on My aisle', 'Actualizar, en Mi pasillo'), L('Your next aisle, once the supervisor marks this one done', 'Tu siguiente pasillo, cuando el supervisor marque este terminado')],
    [L('Start second counts', 'Empezar segundos conteos'), L('Spots to count again, on My aisle', 'Lugares para volver a contar, en Mi pasillo')],
    [L('Sign off this scanner', 'Salir de este escáner'), L('Break or end of shift. Charger', 'Descanso o fin de turno. Cargador')],
  ];
  s.addTable(rows.map(([b, w]) => [{ text: b, options: { bold: true, color: THEME.colors.accent1 } }, { text: w, options: { color: THEME.colors.lt2 } }]), {
    x: 0.6, y: 1.85, w: 12.1, colW: [4.6, 7.5], fontSize: 14, fontFace: '+mn-lt', color: THEME.colors.lt2, fill: { color: THEME.colors.dk2 }, border: { type: 'solid', color: THEME.colors.dk1, pt: 1 }, rowH: 0.38, margin: 0.06, objectName: 'the buttons',
  });
  s.addNotes(L('Print this slide for the break room.', 'Imprime esta lámina para el comedor.'));
}
{
  const s = pres.addSlide({ masterName: 'cover', sectionTitle: section });
  s.addText(L('That is the job', 'Ese es el trabajo'), { placeholder: 'kicker' });
  s.addText(L('Rack · Pallet · Quantity', 'Rack · Tarima · Cantidad'), { placeholder: 'title' });
  s.addText(L('Count what is really there. Never skip a pallet.\nNot sure? Ask your lead — or press SOS if you need help now.', 'Cuenta lo que de verdad hay. Nunca te saltes una tarima.\n¿Dudas? Pregunta a tu líder — o toca SOS si necesitas ayuda ya.'), { placeholder: 'body' });
  s.addNotes(L('Questions, then the practice at the desk with the test book.', 'Preguntas, y luego la práctica en la mesa con el libro de prueba.'));
}

await pres.writeFile({ fileName: OUT });
await applyTheme(OUT, THEME);
console.log(`${OUT} written`);
