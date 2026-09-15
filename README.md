# Physical Inventory Counting

A warehouse physical-inventory app for Zebra Android handhelds (MC9300 / TC-series),
counting at **pallet level**. Each scanner asks four questions, one per screen:

1. **Pallet ID / container #** — checked against the uploaded pallet list; shows what
   the system says is on it so the counter can confirm the right pallet
2. **Quantity**
3. **Bin location** — checked against the uploaded bin list
4. **Comments** — optional, with one-tap quick notes

Questions 1–3 are required. Teams sign on with a team number and their employee IDs;
every scanner has a unique ID stamped on every line. A supervisor can upload a counting
plan that sends each team to its aisles in order, with **racking-conflict blocking**
so two teams are never in aisles that back onto each other.

Runs from one Docker image either on Railway or on a PC inside the warehouse. No
third-party runtime dependencies: Node 22's built-in HTTP server and `node:sqlite`.

---

## Offline-first

Warehouse Wi-Fi has dead spots. So at sign-on the handheld downloads the session's bin
list and pallet list into IndexedDB:

* every scan is validated **on the device** — instant, and it works with no signal;
* count lines are written locally first and pushed whenever a connection exists;
* each line carries a device-generated id, so a retry after a dropped connection can
  never double-count;
* pallets counted by *other* scanners are pulled down during each sync, so a duplicate
  is caught even when the second scanner is offline at the time;
* the header shows `online` / `OFFLINE` and how many lines are still queued.

Aisle hand-offs (marking an aisle complete) need a connection, since the next aisle is
released by the server.

---

## Running it

### Locally

```bash
npm start                 # http://localhost:3000
```

### On a PC in the warehouse

```bash
ADMIN_PASSWORD='pick-something' docker compose up -d
```

Handhelds then point at `http://<that-pc-lan-ip>:3000/`. Give the PC a static IP or a
DHCP reservation so the URL never changes.

### On Railway

Deploy from this repo — `railway.json` builds the Dockerfile. Then:

1. Add a **volume mounted at `/data`** (Service → Settings → Volumes). Without it the
   app starts with a warning and counts are lost on redeploy.
2. Set `ADMIN_PASSWORD`.

Scanners need internet access for this option, not just warehouse Wi-Fi.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_PASSWORD` | `changeme` | Supervisor dashboard password — **set this** |
| `DB_PATH` | `./data/inventory.db` | SQLite file (falls back to `./data` if unwritable) |
| `MAX_UPLOAD_MB` | `64` | Upload size cap |
| `BACKUP_DIR` | `<DB_PATH>/../backups` | Where daily backups are written |
| `BACKUP_KEEP` | `14` | How many backups to keep |
| `SCANNER_AUTH` | `required` | `off` lets any client post counts — closed networks only |
| `SHARED_PASSWORD_LOGIN` | `on` | `off` refuses `ADMIN_PASSWORD` — but only once an admin login exists (see below) |
| `SUPERADMIN_USER` | — | Username of an admin login to create at startup, e.g. `SITEADMIN`. Unset, nothing is seeded |
| `SUPERADMIN_NAME` | the username | The name shown for it, e.g. `Site Administrator` |
| `SUPERADMIN_PASSWORD` | `ADMIN_PASSWORD` | Its password, if you want it different from the shared one |
| `SITE_TIMEZONE` | `America/New_York` | The warehouse's clock — dates a cycle batch is due, and the hour a schedule fires |

---

## The supervisor side

A sidebar down the left picks the section; sub-tabs across the top pick the screen. One
sign-in covers all of them.

| Section | Sub-tabs |
|---|---|
| **Dashboard** (`/admin`) | Progress · Map · Team plan · Second counts · Reports |
| **Cycle counts** (`/cycle`) | Today · Still open · Coverage · Program & data |
| **Teams & crew** (`/teams`) | Crew & teams · Equipment rules |
| **Settings** (`/settings`) | Logins · Scanners · Lists & racking · ERP & backups |

Two splits, both deliberate. **Running a count** is the Dashboard; **setting one up** is
Settings — anything you configure once and then leave alone. And within a section, one
screen does one job, so nobody scrolls past four cards to reach the one they came for.
The open sub-tab is in the URL, so `/admin#map` is a link you can send someone.

The supervisor pages have their own stylesheet (`admin.css`) — they live on an office
monitor, while the handheld's `styles.css` is tuned for a gloved thumb in a freezer.

## The office board — `/board`

A read-only progress screen for the office wall: the percentage counted, bins and aisles
done, a row per team showing which aisle they are in and how long since their last scan,
and a tile per aisle. It **needs no sign-in** — nobody is going to sign a TV in every
morning — so it carries progress and nothing else: no pallet IDs, no clock in numbers, no
exports, no controls. It refreshes every 15 seconds, fits a 1080p screen without
scrolling, and if the server goes away it keeps the last numbers up and says it is not
updating rather than blanking the wall.

It follows the newest open full count on its own. `?session=<id>` pins it to one, and
`?every=<seconds>` changes how often it polls.

If your server is reachable from outside the building, put the board behind the same VPN
or proxy as everything else — it is open by design.

## Cycle counts — `/cycle`

Its own page, on the same sign-in: create the program, upload the bin list
once and the inventory report whenever it changes, watch coverage, generate today's bins
and see what is still open. Details under *Cycle counting* below.

## Teams & crew — `/teams`

A separate page for the roster, on the same sign-in.

**Upload the crew list** (CSV or Excel): `Badge` (required), `Name`, `Department`,
`Equipment`. Equipment can be a list — `Scissor lift; High reach` — and common spellings
(*forklift*, *reach truck*, *pallet jack*, *walkie*) are understood; anything unrecognised
is reported rather than silently dropped. People can also be added one at a time.

**Teams** are created here and people are **dragged** between the crew list and a team
card (every card also has a menu, for a tablet). Each card shows the equipment the team
has between them and the levels that reaches.

**What each level needs** is the rule table, and it is enforced. At Front Royal:

| Level | Needs, between the team |
|---|---|
| A | on foot |
| B–C | dock truck **and** scissor lift |
| C–F | high reach **and** scissor lift |

So a team with a scissor lift alone reaches level A only; add a dock truck and they reach
A–C; a high reach and a scissor lift reach A and C–F. Level C is reachable either way.
Assigning a team levels it cannot reach is refused in the dashboard, naming what is
missing — a supervisor can still insist, and is asked to confirm. The rules are editable
on the page, so a new machine or a changed policy does not need a deploy.

## Two kinds of session

| | **Full count** | **Cycle count** |
|---|---|---|
| Scope | wall-to-wall | a batch of bins per day or week |
| Teams get | whole aisles, by level | a generated list of bins |
| Lives | for one count | for the year — re-upload the report whenever |

## Setting up a count

Step 1 is on the **Dashboard**; steps 2 and 3 are under **Settings**, which acts on the
session picked at the top of that page.

### 1. Create a session — Dashboard

The session picker lives in the **header**, because which count you are looking at is
context for the whole page, not a field in one card. Its menu carries a row per count with
the type (full or cycle), whether it is open or closed, how far along it is and when it was
last scanned — a name alone stops telling two counts apart once a site has a few.

**Start a new count** takes the bin list and the inventory report with it, so a new count
arrives with something to validate against. Both are optional at that moment; whatever is
missing shows up under **Settings → Getting started**.

### Getting started — Settings

A checklist for a count that is not running yet, worked out from the database rather than
from a box somebody ticked, so it cannot claim something is done that is not. Each step
says what it is, **why it matters**, what is there now, and has a button that takes you to
the place that does it.

A full count wants: bin list, inventory report, scanners, rack drawing, racking blocks,
crew and teams, and a team plan. A cycle count wants a different set, ending in its first
batch. Steps are marked **needed to start**, **recommended** or **optional**, and the card
says how many things are still blocking anyone from scanning.

Per-session settings:

| Setting | Options |
|---|---|
| Pallet ID check | **Validate, allow override with reason** (default) · Validate, no overrides · Accept any ID (duplicates still blocked) |
| Guided by aisle plan | on / off |
| Ask for comments | on / off (drops question 4) |
| Scanners start here | every gun lands on this count at sign-on — they can still pick another |
| Recount thresholds | how big a quantity difference has to be before somebody walks back — units, percentage, and a cap on how many stay open |

### 2. Upload the lists — Settings

Columns are matched by name, so most ERP exports work unchanged.

| File | Columns it looks for | What it is |
|---|---|---|
| **Bin list** | location/bin, zone, aisle, description | The validation list for question 3. Also defines the aisles. |
| **Pallet list** | pallet id/container/LPN, sku, description, uom, qty, location | The validation list for question 1, plus what is on each pallet and where the system thinks it is. |
| **Counting plan** | team, aisle, levels | One row per aisle, in the order each team should count, with the levels that team covers (blank = all). Optional — aisles can also be queued in the dashboard. |

Without an `Aisle` column, the aisle is read from the bin code. Two shapes are understood:

| Bin code | Aisle | Bay | Level |
|---|---|---|---|
| `A03-12-1` (separated) | `A03` | `12` | `1` |
| `F01A001` (zone, aisle, level, bin) | `F01` | `001` | `A` |

Add the column if your codes don't follow either. Wherever an aisle is typed — a
counting plan, the assignment box — `1`, `01` and `F01` all mean the same row.

Sample files are in `sample-data/`, and each upload type has a downloadable template
with its columns explained on the page. Excel files (`.xlsx`) upload as-is — the
first sheet is converted in the browser.

**Front Royal:** the full ERP bin list ships in the app — **Load Front Royal bin list**
in the Settings upload card loads all 13,734 bins: racks `F01`–`F24` and `A01`–`A04`, and the
non-rack bins grouped as `WIP`, `AREAS` and `SYSTEM` (which holds `NIL`, the
not-in-location bin). Those are *areas*: their bins validate and count like any other,
but they are not aisles — they don't appear with the racking blocks and can't be
assigned to a team. Staging lanes and dock doors (`STAGING`, `DOORS`) are counted
manually and are left out of the import; the layout file's `excluded` list controls that. Odd positions are the Front face of a double-deep
rack, even positions the Back; the map shows both.

### 3. Pair aisles that share racking — Settings

In **Settings → Aisles & racking blocks**, click **Auto-pair aisles** to group them in twos
(A01+A02, A03+A04, …), or type a block name on any row. Set *Skip first* to 1 if the
first aisle has a wall behind it. Only one team can be active in a block at a time.

### 4. Assign teams — aisle and levels, on the Dashboard

Queue aisles per team in counting order, each with the **levels** that team's equipment
covers: `A-C` for a crew on foot, `D-F` for the one with the lift, `A-F` for every
level. Levels are required — a plan row without them is skipped.
Two teams can work the same aisle on different levels at the same time. The first aisle
for each team starts immediately if its block is free on those levels. When a team marks an aisle complete, its next aisle
starts automatically — unless another team holds that block on overlapping levels, in which case it waits
and the handheld shows *"Waiting: team 1 is still in aisle A03, which shares racking
with A04"*. Trying to force-start a conflicting aisle from the dashboard is refused
with the same message.

### 5. Put the map on the real floor plan — Dashboard

The **Map** tab draws every bay as a cell coloured by how much of it has a
count, and rings each aisle in the colour of its state — grey not started, purple queued
to a team, blue a team is in it, amber part counted, green handed back as complete. Each
ring carries a label in the gutter: the aisle code, its zone and how far along it is.

**Click an aisle** and a panel opens under the map: bins counted against bins total, a
breakdown by level A–F, which team is on it and which racking block it shares, and two
buttons — print a count sheet for just that aisle, or jump to Team plan with the aisle
already filled in. Escape or **Close** puts it away. Each cell is one **bay** — 4 pallet positions per level, odd in front (001, 003) and even
directly behind them (002, 004) — drawn as two cells, the Front face on the aisle side and
the Back face behind it. Pick a level (A–F) above the map to see one level alone — useful when two crews
share an aisle on different levels. Hovering a cell names the aisle, the face, the
position numbers and levels in it, and lists which bins are counted and which are still
open. With no drawing chosen it lays aisles out schematically. Pick a **Map drawing**
in the session settings and it draws the same cells over the actual rack layout, in
the positions the racking really has, with team badges on the aisles they're in.

A drawing is a pair of files in `public/layouts/`: `<name>.png` (the floor plan) and
`<name>.json` (the pixel box of every aisle on it, keyed by aisle number, plus the
racking pairs). `front-royal` — Frazier drawing D-22P9170-L001 rev A — ships in the
repo (rows `F01`–`F24` and the ambient racks `A01`–`A04` by the dry warehouse, positions
left to right from 001, each bay split into its Front and Back face); **Pair from drawing** in the aisles card applies its back-to-back pairs as the
racking blocks. To move an aisle, edit its box in the JSON; to add a site, add a pair
of files.

### 6. Cycle counting

In a **cycle count** session the manager uploads a fresh inventory report whenever they
want current quantities (tick *Replace existing*), then generates a batch: how many bins,
how to pick them, and optionally a zone, aisle or level to stay inside.

Bins are picked by how long they have gone without a count. That date starts from the
**Last Phys. Invt. Date** column in your ERP export and moves forward as lines land, so a
batch never re-picks what was counted yesterday and the oldest corners come up first.
*Preview* shows what would be picked without generating anything. The other strategies are
*never counted* and *random sample*.

Tick **Generate automatically** for a standing schedule — 40 bins every weekday from 6am,
or a weekly batch on a chosen day. The server checks every 15 minutes and creates at most
one scheduled batch per day, so a restart or a missed window cannot double up.

The card shows coverage: what share of bins have been counted in the last 90 days, how many
have never been counted, the oldest count on record, and progress per batch. **Coverage CSV**
lists every bin oldest-first.

On the gun a cycle session has no aisle plan — the batch *is* the job. The counter sees
"40 bins", each task naming the bin and where it is; they scan every pallet in it (or mark
it empty) and move to the next. A cycle-count line is a first count, so anything that
disagrees with the report raises a second count exactly as in a full count.

### Walking the aisle

Once a team is in an aisle the gun names the **next bin** — `F01A001`, then `F01A002`,
then `F01A003` — with where it is (level, position, front or back) and how far along the
aisle they are. Nobody has to keep their own place down a 650-bin run. Counting out of
order is still fine: the guide just points at the next one still open. It appears only on a
guided count with an aisle assigned, since otherwise there is no aisle to walk.

### What the scanners offer — Settings

The one-tap reasons a counter picks instead of typing: the **comments** chips on the last
step, and the **override reasons** for accepting a pallet ID that is not on the list. Both
are editable, because the reasons a site needs are the site's own — "Blocked by a trailer"
means something at one warehouse and nothing at another. Changes reach a scanner at its
next sign-on.

The comments step also **moves itself on**. Comments are optional and a counter with both
hands full is not going to tap Skip on every pallet, so the step counts down — five seconds
by default — and goes to the next bin. Typing or tapping a reason stops the clock, because
somebody is clearly still writing. Set the wait to 0 and it waits for the counter instead.

### 7. Second counts

The pallet list *is* the inventory report, and the app compares every first count against
it as it lands. When a line disagrees — quantity differs, pallet in an unexpected bin, not
on the report, counted twice — a **second count** of that bin is raised automatically; when
an aisle is handed back, expected pallets nobody saw raise one too. A supervisor can also
request one by bin or pallet ID, from the form or the **Recount** button on a pallet-report
row, and **Raise from all variances now** sweeps the whole report. *Auto second counts* can
be switched off per session.

Rules: the team that did the first count is never offered the second; the counter is told
the bin and the reason type but not the numbers (the second count is blind); and lines from
a second count replace the first for that bin in the report, which shows both figures
("1st count 30, counted 48") and marks the row *2nd count*.

On the gun, second counts appear on the assignment screen ("5 bins to go back to"). Each
one shows the bin, where it is, and the reason; the counter scans every pallet in that bin
(or marks it empty) and taps **Bin done**. Completions queue offline like everything else.

### 8. Watch, then export — Dashboard, and Settings for the ERP file

Progress by team (scanner, employees, active aisle, last scan), by aisle, and a pallet
report with these statuses:

| Status | Meaning |
|---|---|
| `MATCH` | Found once, in the expected bin, expected quantity |
| `QTY VARIANCE` | Found in the right bin, quantity differs |
| `WRONG BIN` | Found in a bin other than the system location |
| `COUNTED TWICE` | The same pallet ID was counted more than once |
| `MISSING` | On the pallet list, never counted |
| `NOT IN MASTER` | Counted, but not on the pallet list |

Exports: pallet report, raw counts (every line with team, employees, scanner,
flags, comments), exceptions only, and uncounted bins.

---

### 9. Register the scanners — Settings

The **Scanner setup** card lists every handheld. Add one by name (`SCANNER-05`) and it gets
a unique link, `https://<server>/?d=<id>`. On the device, open that link in Chrome once —
scan the QR rather than typing it — then menu → **Add to Home screen**. From then on the
app knows which scanner it is, Settings shows when it was last seen and which team had it,
and removing it here stops the link.

**Print setup cards** gives you one card per scanner on a sheet, each with its own QR, the
address underneath and the three steps. Cut them up and tape one to each cradle: setting a
gun up is then "scan this", not typing a URL on a keypad in a freezer. A card is a key —
if one goes missing, **Reset link** and print a new one.

A scanner with no link can still type an ID on first run; it is marked "not registered".

## Counter — `/` on the handheld

**First run:** if the scanner was opened from its registered link, nothing to do. Otherwise
it asks for an ID.

**Sign-on:** choose what you are doing — **Full count** or **Cycle count** (the choice only
appears when both are running) — pick the one you want, enter the team number, scan or type
each **clock in number** (Enter after each), tap **Sign on & load list**.

The clock in numbers are checked against the crew list, and the assignment screen says what it found:
who signed on, what they have between them and how high it reaches. It calls out a badge
that is not on the crew list, anybody rostered to a different team today, and — in red —
a crew that cannot reach the levels of their work — the aisle they were given in a full
count, or the bins on their list in a cycle count — naming the machine they are short of. None of it blocks counting; it is there so a shift-change shuffle is caught at
6am rather than at the variance report. Signing off clears the crew, so the next shift
scans their own numbers in.

**Assignment screen** (guided sessions): shows the team's aisle, a grid of its bins
coloured as they get a count, and what comes next. **Aisle complete** hands the aisle
back and pulls the next one.

**Counting:** Pallet → Qty → Bin → Comments, then straight back to Pallet.
After the bin scan the gun says where that bin is — *Level A · Position 009 · FRONT* —
with Front/Back from the position number (odd = Front, even = Back, set in the layout).

**Empty bins count too.** Every bin gets a line, empty or not: on the pallet prompt tap
**Bin is EMPTY — scan the bin**, scan the location, done. The bin turns green on the map and
the progress percentage can reach 100%. Empty lines never appear as pallets in the report.

What the app refuses or flags:

* **Pallet already counted** — anywhere, by anyone: error tone, and a reason is required
  to record it again. Reported as `COUNTED TWICE`.
* **Pallet not on the list** — depends on the session setting (override / hard block /
  accept). Reported as `NOT IN MASTER`.
* **Bin not on the list** — reason required.
* **Bin outside the team's aisle, or on a level the team wasn't given** — reason required,
  flagged `off_assignment`.
* **Pallet in a different bin than the system expects** — accepted, but shown on screen
  and reported as `WRONG BIN`.
* **Junk in the quantity field** — refused, never counted as zero.
* **Quantities of 1000+** — must be entered twice.

**History** lists the last 50 lines from that scanner; any can be voided. Voided lines
drop out of totals but stay in the raw export.

---

## Zebra DataWedge setup (one-time, per device)

The app reads scans as keystrokes, so the scanner must be in keyboard-wedge mode with
an Enter suffix:

1. Open **DataWedge** → the profile associated with Chrome (or create one and associate
   the browser).
2. **Keystroke output**: enabled.
3. **Basic data formatting** → **Send ENTER key**: enabled. *(Without this the app never
   sees the end of a scan.)*
4. **Barcode input** → enable the symbologies your labels use.

Then in Chrome on the device, open the server URL and **Add to Home screen** — it
launches full-screen and the app shell is cached so it starts with no signal.

---

## API

Handheld (every call carries `Authorization: Device <token>`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions` | Open sessions |
| `POST` | `/api/devices/:uid` | Trade a scanner's link for its token (the only call without one) |
| `GET` | `/api/sessions/:id/master?have=<v>` | Bin + pallet lists; `have` skips an unchanged download |
| `POST` | `/api/sessions/:id/signon` | Record who is on which scanner; returns the team's assignment |
| `GET` | `/api/sessions/:id/team-status?team=` | Current aisle, bins, queue, or who the team is waiting on |
| `POST` | `/api/sessions/:id/assignments/:aid/complete` | Team finishes an aisle |
| `GET` | `/api/sessions/:id/counted-pallets?since=` | Pallets counted so far, for cross-device duplicate checks |
| `GET` | `/api/sessions/:id/recounts?team=` | Second counts a team may do |
| `POST` | `/api/sessions/:id/recounts/:rid/take` · `/done` | Take / finish one |
| `POST` | `/api/sessions/:id/counts` | Batch upload; idempotent on `clientId` |
| `POST` | `/api/sessions/:id/void` | Void a line |

Supervisor (`Authorization: Bearer <token>` from `POST /api/admin/login`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/audit` · `/audit/export.csv` | Who changed what |
| `GET`/`POST` | `/api/admin/backups` · `/backups/:name` | List, take, download a backup |
| `GET`/`POST` | `/api/admin/erp/formats` | ERP layouts |
| `GET` | `/api/admin/sessions/:id/erp/:format.csv` | The file for the ERP |
| `GET` | `/api/admin/sessions/:id/print/count-sheet` | Printable count sheet |
| `GET` | `/api/admin/people` | Roster: employees, teams, equipment rules |
| `POST` | `/api/admin/people/employees` · `/import` | Add or update one · import a list |
| `POST`/`DELETE` | `/api/admin/people/teams` · `/teams/:id` | Create / delete a team |
| `POST` | `/api/admin/people/assign` | Move someone onto a team |
| `POST` | `/api/admin/people/equipment` | Save the equipment and level rules |
| `GET` | `/api/admin/me` | Who am I, and does this site still take the shared password |
| `POST` | `/api/admin/me/password` | Change your own password |
| `GET`/`POST` | `/api/admin/users` | List / create supervisor logins (admins only) |
| `POST`/`DELETE` | `/api/admin/users/:username` | Change role, name, password, active · remove |
| `GET`/`POST` | `/api/admin/devices` | List / register scanners |
| `POST` | `/api/admin/devices/:uid/reset` | New link, old token dead |
| `POST`/`DELETE` | `/api/admin/devices/:uid` | Rename / remove a scanner |
| `GET`/`POST` | `/api/admin/sessions` | List / create (`mode: full \| cycle`) |
| `GET`/`POST` | `/api/admin/sessions/:id/cycle/batches` | List / generate cycle batches |
| `POST` | `/api/admin/sessions/:id/cycle/preview` | What a batch would pick |
| `POST` | `/api/admin/sessions/:id/cycle/schedule` | Daily/weekly auto-generation |
| `POST` | `/api/admin/sessions/:id/settings` | Pallet check mode, guided, comments |
| `POST` | `/api/admin/sessions/:id/master?kind=bins\|pallets\|plan&replace=` | Upload a list |
| `POST` | `/api/admin/sessions/:id/status` | Open / close |
| `GET` | `/api/admin/sessions/:id/progress` | Live progress |
| `GET` | `/api/admin/sessions/:id/aisles` | Aisles, blocks, who holds what |
| `POST` | `/api/admin/sessions/:id/aisles/block` | Set an aisle's block |
| `POST` | `/api/admin/sessions/:id/aisles/auto-block` | Pair aisles |
| `GET`/`POST` | `/api/admin/sessions/:id/assignments` | List / queue aisles for a team |
| `POST`/`DELETE` | `/api/admin/sessions/:id/assignments/:aid` | Start, complete, release, remove |
| `GET`/`POST` | `/api/admin/sessions/:id/recounts` | List / request second counts |
| `POST` | `/api/admin/sessions/:id/recounts/generate` | Raise from every current variance |
| `POST`/`DELETE` | `/api/admin/sessions/:id/recounts/:rid` | Assign, finish, reopen, remove |
| `GET` | `/api/admin/sessions/:id/pallets?only=exceptions` | Pallet report |
| `GET` | `/api/admin/sessions/:id/uncounted` | Bins with no count |
| `GET` | `/api/admin/sessions/:id/export/{pallets,counts,exceptions,uncounted,recounts,coverage}.csv` | Exports |

---

## Housekeeping

**Who changed what.** Sign-in asks for a name, and every change a supervisor makes is
recorded — sessions, uploads, assignments (including an override of the equipment check),
second counts, cycle batches, scanners, the crew list, exports and printed sheets. The log
is on the dashboard and exports as CSV.

**Backups.** A copy of the database is taken automatically once a day and kept for
`BACKUP_KEEP` days (14), plus a **Back up now** button. Each one is a consistent snapshot
taken with `VACUUM INTO`, downloadable from the dashboard — download one if you want a copy
somewhere other than this machine, because a volume is not a backup.

**Count sheets.** Paper, for a dead battery or an auditor: choose aisles and levels, get a
printable sheet with one row per bin, pre-printed with level, position and face, and blank
boxes for the pallet and the count. Blind by default. Optionally only bins with no count yet.

**Sending it back to the ERP.** Three layouts ship — *pallet lines*, *adjustments* (only
what differs, with a signed adjustment), and *bin lines* (every line with who counted it).
Column names and the shape of a row are configuration, so a site can add its own layout
through `POST /api/admin/erp/formats` and export it immediately, without a deploy.

## Security

**Scanners sign in.** Every handheld endpoint requires a token, so a stray request cannot
inject count lines. A scanner's link (`/?d=<uid>`) is its enrolment secret: opening it once
trades it for a long random token the scanner keeps and sends on every call. The server
stamps each count with the scanner that token proves — a payload claiming to be some other
scanner is ignored.

Treat a link like a key. **Reset link** issues a new one and kills the old token
immediately; **Remove** stops the scanner entirely. Settings shows when each scanner
signed in and flags a link used more than once — normal after a scanner is wiped, worth a
look otherwise. A scanner that gets cut off mid-count says so plainly and keeps its queued
lines until it is authorised again.

`SCANNER_AUTH=off` disables this, for a closed network where anyone who can reach the
server is already trusted. The app warns at startup when it is off.

**Supervisors** each get their own login, under **Settings → Supervisor logins**. There are
two roles: an **admin** can manage logins, a **supervisor** can do everything else. Every
change is recorded in the audit log against the person who made it, and passwords are
stored scrypt-hashed, never in the clear.

The **shared password** (`ADMIN_PASSWORD`) is how you get in before any account exists, and
how you get back in when everyone has forgotten theirs. Its use is logged as exactly that.
The sign-in box takes either: type your username, or — if the site is still on the shared
password — just your name, which is what the log then records. An existing username always
needs that account's own password, so the shared password can never open somebody else's
account.

### The superadmin

Set `SUPERADMIN_USER` and the app puts a real admin login in the database the first time
it starts, so nobody has to bootstrap through the shared password:

```
SUPERADMIN_USER     = SITEADMIN
SUPERADMIN_NAME     = Site Administrator
SUPERADMIN_PASSWORD = <a real password>      # optional; defaults to ADMIN_PASSWORD
```

Its password comes from the environment and is **never a literal in this repo**. A password
committed here would be readable by anyone who can read the repo, could not be rotated
without a redeploy, and would stay in the history for good.

**Create only.** If the account is already there, startup leaves it completely alone. So a
password you change in the app survives every restart, and a restart is never a way to put
a known password back onto a live account — once you have changed it, the environment
variable no longer opens it. Seeding it is recorded in the audit log.

It refuses to create the account if the password would be `changeme`, if the username is
malformed, or if the password is under 8 characters — and in every one of those cases it
says so at startup and the app still comes up. A failed seed leaves you with no admin, so
the shared password is held open (below) rather than locking you out.

### Switching the shared password off

With a superadmin seeded, set both at once and you are done — the account exists on the
first boot, so `off` takes effect immediately.

Without one, in this order:

1. Set `ADMIN_PASSWORD` to something real. A fresh deployment warns at startup while it is
   still `changeme`.
2. Sign in with it and add yourself an **admin** login under **Settings → Logins**.
3. Sign in as that login and check it works.
4. Set `SHARED_PASSWORD_LOGIN=off`.

Get that order wrong and it does not matter: **`off` is ignored while there is no admin
account.** Off with nobody to sign in as is not a locked door, it is a bricked deployment —
nobody can sign in, and nobody can create the account that would fix it, without a
redeploy. So the switch waits, says so at startup and in the Settings card, and takes
effect by itself the moment an admin login exists. No redeploy, no restart.

The same guard works the other way: the last admin account cannot be deleted or demoted,
so the door cannot be sealed from the inside either. And if it ever comes to it, putting
`SHARED_PASSWORD_LOGIN` back to `on` always lets you in.

Tokens are in-memory, so a restart signs supervisors out. If the app is exposed publicly,
still put it behind a VPN or an authenticating proxy.

**Managing logins.** Add one with a username, full name, password and role. An admin can
reset somebody's password, switch their role, deactivate them (which keeps their history in
the log but stops the login working) or remove them. The last admin account cannot be
demoted or deleted — there is always someone who can let people back in.

---

## Not built yet

* `.xlsx` upload (save as CSV for now)
* live ERP/WMS integration (v1 is CSV in, CSV out)
* multi-warehouse support in one instance
