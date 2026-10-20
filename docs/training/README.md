# Day-one training for the counting crew

What a counter needs on their first day, in English and in Spanish: a film and a slide deck of the
same lesson, slowly, on the real scanner app.

| File | What it is |
|---|---|
| `scanner-training-en.mp4` | The film, in English: about fifteen minutes, with beeps on each scan |
| `scanner-training-es.mp4` | The same film in Spanish, on the scanner's own Spanish screens |
| `scanner-training-en.pptx` | The slide deck, in English, with the narration in the speaker notes |
| `scanner-training-es.pptx` | The same deck in Spanish |
| `shots/en/`, `shots/es/` | The scanner at every step, and the labels being scanned — the pictures the decks use |

**How the lesson goes.** Seven parts: the scanner and your language; signing on with the team's QR
card and each badge; counting a pallet — the pallet label, the quantity, the rack label, a comment;
when a spot is different — several pallets, an empty spot; labels — two on one pallet, one that will
not scan, a pallet not on the list; help and fixes — a wrong line, a message from the office, no
Wi-Fi, reporting a problem, SOS; second counts, handing the aisle back and signing off. It ends with
five rules and the buttons on one page.

**Showing it.** Play the film on the break-room screen once, then the trainer goes through the deck
with scanners in hand and the practice test book (Settings → Scanners → Barcode test book). The
deck's last-but-one slide, the buttons on one page, prints for the wall.

**Making it again** (after a change to the scanner app):

```
node tools/crew-training.mjs                  # the English film, and the pictures under shots/en
LANG_FILM=es node tools/crew-training.mjs     # the Spanish film and shots/es
node tools/crew-deck.mjs                      # the English deck, from shots/en
LANG_FILM=es node tools/crew-deck.mjs         # the Spanish deck
```

The film drives the real app on the demo warehouse, step by step, and records it; `PACE=1.4` slows
it further, `SHOTS_ONLY=1` takes the pictures without the film. The deck needs `pptxgenjs` on the
`NODE_PATH` (it is not one of the app's dependencies).
