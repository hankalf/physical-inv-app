# The whole floor, for a whole count

20 teams, 40 scanners, 20,000 bins, three shifts — played in 6.0 hours of real time on
2026-10-04. Everything went through the same HTTP API the guns and the pages use; nothing
was written into the database behind the app's back. Open **index.html** to scrub or scroll
through the dashboard and the office board as the count went; `timeline.json` has the figures
behind every frame, `summary.json` the whole run, `adjustments.csv` and `aisles.csv` two of the
reports the office would keep.

| | |
|---|---|
| Bins counted | **20,000 of 20,000** (100.0%) |
| Count lines | 22,655 from 40 scanners |
| Pallets on the report seen | 18,591 |
| Pallet report | 17,876 match · 715 quantity or bin variances · 205 missing · 152 not on the report · 0 counted twice |
| Adjustments | 296 approved · 62 rejected · 0 left waiting |
| Second counts | 657 done · 0 open at the end |
| SOS calls | 25 raised, 25 closed by the office |
| Aisle jobs handed back | 71 |
| Requests made | 27,059, **0 failed** |

## What a person felt

| Action | calls | typical | slowest 5% | worst |
|---|---:|---:|---:|---:|
| A count line reaching the server | 20,255 | 9 ms | 747 ms | 3476 ms |
| Signing a scanner on | 120 | 15 ms | 867 ms | 2793 ms |
| A scanner pulling the whole bin list | 120 | 11 ms | 132 ms | 2574 ms |
| A dashboard refresh | 4,524 | 279 ms | 1595 ms | 5160 ms |
| The office board refresh | 1,398 | 350 ms | 1468 ms | 5011 ms |
| Approving and closing from the desk | 642 | 164 ms | 1007 ms | 3346 ms |

Planted in the data, for the count to find: 445 short, 186 over, 205 missing, 151 unlisted, 84 moved, 43 label, 306 expired.
The bin list is the real Front Royal freezer list with more aisles of the same shape (F25 onwards)
to make the twenty thousand.

To play it again: `node tools/sim-floor.mjs` (six hours), or `SIM_HOURS=0.3 SIM_SNAP_MIN=2 node tools/sim-floor.mjs`
for an eighteen-minute rehearsal of the same thing.
