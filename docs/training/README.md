# Day-one training for the counting crew

What a counter needs on their first day, in English and in Spanish: a film and a slide deck of the
same lesson, slowly, on the real scanner app.

| File | What it is |
|---|---|
| `scanner-training-full-en.mp4` | The full count, in English: under ten minutes, with beeps on each scan, the scanner offering that job alone |
| `scanner-training-full-es.mp4` | The same film in Spanish, on the scanner's own Spanish screens |
| `scanner-training-cycle-en.mp4` | The cycle count, in English: one person, a list of bins for the day, Bin done after each |
| `scanner-training-cycle-es.mp4` | The same in Spanish |
| `scanner-training-full-en.pptx` | The full count's slide deck, in English, with the narration in the speaker notes |
| `scanner-training-full-es.pptx` | The same deck in Spanish |
| `shots/<job>/<lang>/` | The scanner at every step, and the labels being scanned — the pictures the decks use |

Front2Back and Not in Location films come later.

**How the full-count lesson goes.** Seven parts: the scanner and your language; signing on with the team's QR
card and each badge; counting a pallet in the site's order — the rack label, the pallet label, the quantity, a comment;
when a spot is different — several pallets, an empty spot; labels — two on one pallet, one that will
not scan, a pallet not on the list; help and fixes — a wrong line, a message from the office, no
Wi-Fi, reporting a problem, SOS; second counts, handing the aisle back and signing off. It ends with
five rules and the buttons on one page.

**The cycle-count lesson** is six parts: the scanner and your language; signing on with your badge
alone and the list of bins for today; counting a bin — the rack, the pallet, the quantity, Bin done,
with the wrong bin refused, several pallets in one bin, and an empty bin; labels — one that will not
scan, a pallet not on the list; help and fixes; what is left on the list, and signing off.

**Showing it.** Play the film on the break-room screen once, then the trainer goes through the deck
with scanners in hand and the practice test book (Settings → Scanners → Barcode test book). The
deck's last-but-one slide, the buttons on one page, prints for the wall.

**Making it again** (after a change to the scanner app):

```
node tools/crew-training.mjs                         # the full count, English: the film and shots/full/en
LANG_FILM=es node tools/crew-training.mjs            # the same in Spanish
JOB=cycle node tools/crew-training.mjs               # the cycle count, English (JOB=cycle LANG_FILM=es for Spanish)
node tools/crew-deck.mjs                             # the full count's English deck, from shots/full/en
LANG_FILM=es node tools/crew-deck.mjs                # the Spanish deck
```

The film drives the real app on the demo warehouse, step by step, and records it, with the
scanner set to count the rack first, then the pallet, then the quantity; `PACE=1` slows it, `SHOTS_ONLY=1` takes the pictures without the film. The deck needs `pptxgenjs` on the
`NODE_PATH` (it is not one of the app's dependencies).
