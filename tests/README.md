# Tests

```bash
npm test                 # every suite, each against its own scratch database
npm test cycle-count     # one suite
```

`run-all.mjs` starts the app on its own port with its own temporary SQLite file for
**each** suite — they create sessions and teams by name and would otherwise collide —
runs the suite in a real Chromium, and exits non-zero if anything fails. Nothing touches
`data/`.

| Suite | Covers |
|---|---|
| `full-count.mjs` | uploads (CSV and the real `.xlsx`), racking blocks, team plans, the stagger, the whole count flow on two scanners, every validation stop, offline queueing, second counts, the map, reports and exports |
| `cycle-count.mjs` | batch generation and strategies, the last-counted clock, scheduling, coverage, working a batch on the gun |
| `roster.mjs` | crew import, teams, drag and drop, equipment reach rules, assignment enforcement, the sign-on check |
| `ops.mjs` | the audit log, backups, ERP layouts and exports, printable count sheets |
| `scanner-auth.mjs` | enrolment, refusing untokened and forged calls, link reset and removal, and what a cut-off scanner does mid-count |
| `settings.mjs` | supervisor logins: accounts, roles, the last-admin guard, deactivation, starter passwords and the first sign-in; the sidebar and sub-tab shell; and that the setup cards live on `/settings` and not the dashboard |
| `setup-guide.mjs` | the header session picker, creating a count with its bin list and inventory report attached, and the Getting started checklist — that it is computed from the database, differs for a cycle count, and links to the place that does each step |
| `superadmin.mjs` | the seeded admin login: that it is created from the environment, is a real admin, is left alone on every later boot so a changed password is never reset, and that bad input never stops the app coming up. Starts its own servers |
| `recount-threshold.mjs` | that a second count is raised for a difference worth walking back for: the unit and percentage thresholds, the cap, and that a pallet in an aisle nobody has counted is not reported missing |
| `scanner-prompts.mjs` | the editable one-tap reasons the gun offers, and the comments step moving itself on — including that typing or tapping a reason stops the clock and the note is kept |
| `lockout.mjs` | turning the shared password off: that it is ignored while no admin exists, bites the moment one does, survives a restart, and can always be switched back on. Starts its own servers, since the thing under test is read at startup |
| `board.mjs` | the office board — what it shows, what it refuses to leak, that it needs no sign-in and survives the server going away — and the printable scanner setup cards |

Most suites flatten the sub-tabs after signing in (`expandSubTabs` in `helpers.mjs`), so
they can assert on a whole page at once: they are about what the pages do, not which tab a
control sits behind. The tab mechanism has its own checks in `settings.mjs` ("Shell: …").

Screenshots land in `tests/screenshots/` (gitignored) — useful when a check fails.

Chromium comes from `$CHROMIUM` or the Playwright path baked into this image.
