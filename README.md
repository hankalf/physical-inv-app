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

---

## Supervisor — `/admin.html`

### 1. Create a session

Per-session settings:

| Setting | Options |
|---|---|
| Pallet ID check | **Validate, allow override with reason** (default) · Validate, no overrides · Accept any ID (duplicates still blocked) |
| Guided by aisle plan | on / off |
| Ask for comments | on / off (drops question 4) |

### 2. Upload the lists

Columns are matched by name, so most ERP exports work unchanged.

| File | Columns it looks for | What it is |
|---|---|---|
| **Bin list** | location/bin, zone, aisle, description | The validation list for question 3. Also defines the aisles. |
| **Pallet list** | pallet id/container/LPN, sku, description, uom, qty, location | The validation list for question 1, plus what is on each pallet and where the system thinks it is. |
| **Counting plan** | team, aisle | One row per aisle, in the order each team should count. Optional — aisles can also be queued in the dashboard. |

Without an `Aisle` column, the aisle is read from the bin code. Two shapes are understood:

| Bin code | Aisle | Bay | Level |
|---|---|---|---|
| `A03-12-1` (separated) | `A03` | `12` | `1` |
| `F01A001` (zone, aisle, level, bin) | `F01` | `001` | `A` |

Add the column if your codes don't follow either. Wherever an aisle is typed — a
counting plan, the assignment box — `1`, `01` and `F01` all mean the same row.

Sample files are in `sample-data/`, and each upload type has a downloadable template
with its columns explained in the dashboard. Excel files (`.xlsx`) upload as-is — the
first sheet is converted in the browser.

**Front Royal:** the full ERP bin list ships in the app — **Load Front Royal bin list**
in the upload card loads all 13,734 bins: racks `F01`–`F24` and `A01`–`A04`, and the
non-rack bins grouped into aisles `DOORS`, `STAGING`, `WIP`, `AREAS` and `SYSTEM` (which
holds `NIL`, the not-in-location bin). Odd positions are the Front face of a double-deep
rack, even positions the Back; the map shows both.

### 3. Pair aisles that share racking

In **Aisles & racking blocks**, click **Auto-pair aisles** to group them in twos
(A01+A02, A03+A04, …), or type a block name on any row. Set *Skip first* to 1 if the
first aisle has a wall behind it. Only one team can be active in a block at a time.

### 4. Assign teams

Queue aisles per team in counting order. The first aisle for each team starts
immediately if its block is free. When a team marks an aisle complete, its next aisle
starts automatically — unless another team holds that block, in which case it waits
and the handheld shows *"Waiting: team 1 is still in aisle A03, which shares racking
with A04"*. Trying to force-start a conflicting aisle from the dashboard is refused
with the same message.

### 5. Put the map on the real floor plan

The **Warehouse map** card draws every bay as a cell coloured by how much of it has a
count. With no drawing chosen it lays aisles out schematically. Pick a **Map drawing**
in the session settings and it draws the same cells over the actual rack layout, in
the positions the racking really has, with team badges on the aisles they're in.

A drawing is a pair of files in `public/layouts/`: `<name>.png` (the floor plan) and
`<name>.json` (the pixel box of every aisle on it, keyed by aisle number, plus the
racking pairs). `front-royal` — Frazier drawing D-22P9170-L001 rev A — ships in the
repo (rows `F01`–`F24` and the ambient racks `A01`–`A04` by the dry warehouse, positions
left to right from 001, each bay split into its Front and Back face); **Pair from drawing** in the aisles card applies its back-to-back pairs as the
racking blocks. To move an aisle, edit its box in the JSON; to add a site, add a pair
of files.

### 6. Watch, then export

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

### 7. Register the scanners

The **Scanners** card lists every handheld. Add one by name (`SCANNER-05`) and it gets a
unique link, `https://<server>/?d=<id>`. On the device, open that link in Chrome once —
scan the QR from the dashboard into the address bar rather than typing it — then menu →
**Add to Home screen**. From then on the app knows which scanner it is, the dashboard
shows when it was last seen and which team had it, and removing it here stops the link.

A scanner with no link can still type an ID on first run; it is marked "not registered".

## Counter — `/` on the handheld

**First run:** if the scanner was opened from its registered link, nothing to do. Otherwise
it asks for an ID.

**Sign-on:** pick the session, enter the team number, scan or type each employee's badge
(Enter after each), tap **Sign on & load list**.

**Assignment screen** (guided sessions): shows the team's aisle, a grid of its bins
coloured as they get a count, and what comes next. **Aisle complete** hands the aisle
back and pulls the next one.

**Counting:** Pallet → Qty → Bin → Comments, then straight back to Pallet.

What the app refuses or flags:

* **Pallet already counted** — anywhere, by anyone: error tone, and a reason is required
  to record it again. Reported as `COUNTED TWICE`.
* **Pallet not on the list** — depends on the session setting (override / hard block /
  accept). Reported as `NOT IN MASTER`.
* **Bin not on the list** — reason required.
* **Bin outside the team's aisle** — reason required, flagged `off_assignment`.
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

Handheld (no auth — the team and scanner ID identify the counter):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions` | Open sessions |
| `GET` | `/api/devices/:uid` | Which scanner a registered link belongs to |
| `GET` | `/api/sessions/:id/master?have=<v>` | Bin + pallet lists; `have` skips an unchanged download |
| `POST` | `/api/sessions/:id/signon` | Record who is on which scanner; returns the team's assignment |
| `GET` | `/api/sessions/:id/team-status?team=` | Current aisle, bins, queue, or who the team is waiting on |
| `POST` | `/api/sessions/:id/assignments/:aid/complete` | Team finishes an aisle |
| `GET` | `/api/sessions/:id/counted-pallets?since=` | Pallets counted so far, for cross-device duplicate checks |
| `POST` | `/api/sessions/:id/counts` | Batch upload; idempotent on `clientId` |
| `POST` | `/api/sessions/:id/void` | Void a line |

Supervisor (`Authorization: Bearer <token>` from `POST /api/admin/login`):

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/api/admin/devices` | List / register scanners |
| `POST`/`DELETE` | `/api/admin/devices/:uid` | Rename / remove a scanner |
| `GET`/`POST` | `/api/admin/sessions` | List / create |
| `POST` | `/api/admin/sessions/:id/settings` | Pallet check mode, guided, comments |
| `POST` | `/api/admin/sessions/:id/master?kind=bins\|pallets\|plan&replace=` | Upload a list |
| `POST` | `/api/admin/sessions/:id/status` | Open / close |
| `GET` | `/api/admin/sessions/:id/progress` | Live progress |
| `GET` | `/api/admin/sessions/:id/aisles` | Aisles, blocks, who holds what |
| `POST` | `/api/admin/sessions/:id/aisles/block` | Set an aisle's block |
| `POST` | `/api/admin/sessions/:id/aisles/auto-block` | Pair aisles |
| `GET`/`POST` | `/api/admin/sessions/:id/assignments` | List / queue aisles for a team |
| `POST`/`DELETE` | `/api/admin/sessions/:id/assignments/:aid` | Start, complete, release, remove |
| `GET` | `/api/admin/sessions/:id/pallets?only=exceptions` | Pallet report |
| `GET` | `/api/admin/sessions/:id/uncounted` | Bins with no count |
| `GET` | `/api/admin/sessions/:id/export/{pallets,counts,exceptions,uncounted}.csv` | Exports |

---

## Security

Sized for a private warehouse network, not the open internet: one shared supervisor
password, and handheld endpoints open to anyone who can reach the server. If it is
exposed publicly, put it behind a VPN or an authenticating proxy, and set a real
`ADMIN_PASSWORD`. Admin tokens are in-memory, so a restart signs supervisors out.

---

## Not built yet

* recount pass (re-sending flagged pallets to a team as a second count)
* `.xlsx` upload (save as CSV for now)
* live ERP/WMS integration (v1 is CSV in, CSV out)
* multi-warehouse support in one instance
