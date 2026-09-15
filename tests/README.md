# Tests

```bash
npm test                 # all three suites against a scratch database
npm test cycle-count     # one suite
```

`run-all.mjs` starts the app on port 3111 with a temporary SQLite file, runs each
suite in a real Chromium against it, and exits non-zero if anything fails. Nothing
touches `data/`.

| Suite | Covers |
|---|---|
| `full-count.mjs` | uploads (CSV and the real `.xlsx`), racking blocks, team plans, the stagger, the whole count flow on two scanners, every validation stop, offline queueing, second counts, the map, reports and exports |
| `cycle-count.mjs` | batch generation and strategies, the last-counted clock, scheduling, coverage, working a batch on the gun |
| `roster.mjs` | crew import, teams, drag and drop, equipment reach rules, assignment enforcement, the sign-on check |

Screenshots land in `tests/screenshots/` (gitignored) — useful when a check fails.

Chromium comes from `$CHROMIUM` or the Playwright path baked into this image.
