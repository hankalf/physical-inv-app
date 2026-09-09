# Physical Inventory Counting

A warehouse physical-inventory app for Zebra Android handhelds (MC9300 / TC-series).
The counter answers three prompts — **location → item → quantity** — and each scan is
validated against the master list before it is accepted.

Built to run either in the cloud (Railway) or on a PC inside the warehouse, from the
same image. No third-party runtime dependencies: Node 22's built-in HTTP server and
`node:sqlite` only.

---

## Why it is offline-first

Warehouse Wi-Fi has dead spots — racking, freezers, the far end of a building.
So the handheld downloads the session's master list once at sign-on and keeps it in
IndexedDB:

* every scan is validated **on the device**, with no network round trip (instant, and
  it works with no signal at all);
* counted lines are written to local storage first and pushed to the server whenever a
  connection exists;
* each line carries a device-generated id, so a retry after a dropped connection can
  never double-count;
* the header shows `online` / `OFFLINE` and how many lines are still queued.

A counter can walk into a dead zone, keep counting, and the lines sync when they walk out.

---

## Running it

### Locally (development)

```bash
npm start                 # http://localhost:3000
```

### On a PC in the warehouse (production, on-site)

```bash
ADMIN_PASSWORD='pick-something' docker compose up -d
```

Handhelds then point at `http://<that-pc-lan-ip>:3000/`. Give the PC a static IP or a
DHCP reservation so the URL never changes.

### On Railway (cloud)

Deploy from this repo — `railway.json` builds the Dockerfile. Then:

1. Add a **volume mounted at `/data`** (without it, counts are lost on redeploy).
2. Set `ADMIN_PASSWORD`.

The scanners need internet access for this option, not just warehouse Wi-Fi.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_PASSWORD` | `changeme` | Supervisor dashboard password — **set this** |
| `DB_PATH` | `./data/inventory.db` | SQLite file |
| `MAX_UPLOAD_MB` | `64` | Master-file upload cap |

---

## Using it

### Supervisor — `/admin.html`

1. **Create a session** (e.g. "Q3 wall-to-wall"). Options: blind count, require LPN,
   allow overrides.
2. **Upload the master CSV.** Columns are matched by name, so most ERP exports work
   unchanged — `Location`, `Item Number`, `On Hand Qty`, `location`, `sku`, `qty`,
   `Bin`, `Part Number` and similar spellings all resolve.
3. **Watch progress** — locations counted per zone, lines per counter, exception count.
4. **Export** the raw count CSV and the variance report.

Master file types:

| Type | Columns it looks for | Use it for |
|---|---|---|
| On-hand snapshot | location, sku, qty (+ zone, description, uom, barcode) | The usual ERP export. Seeds locations, items and expected quantities in one go. |
| Locations | location, zone, description | Location list only |
| Items | sku, description, uom, barcode, pack_qty | Item master only |
| Extra barcodes | barcode, sku, pack_qty | UPCs, alternates, case codes |

Several rows for the same location + SKU (lots, serials, pallets) are summed.
Re-uploading the same file overwrites rather than doubling; tick **Replace existing**
to wipe the session's master data first.

A barcode with `pack_qty` greater than 1 is treated as a case code — entering `3`
against a case of 12 records 36.

### Counter — `/` on the handheld

1. Scan or type a badge, pick the session, tap **Load list & start counting**.
2. **Scan LOCATION** → validated against the location list.
3. **Scan ITEM** → validated against every known barcode; the description is shown
   so the counter can confirm the right thing was scanned.
4. **Enter QUANTITY** → typed on the keypad.

Then the app returns to the item prompt with the location held, so counting a whole
bin is scan-item → qty, scan-item → qty. **Change location** moves to the next bin.

Behaviour worth knowing:

* **A scan that is not on the list is rejected** — error tone, red flash, and a reason
  must be chosen before it can be accepted. Every override is flagged in the export.
* **Junk in the quantity field is refused**, never counted as zero.
* **Quantities of 1000 or more must be entered twice.** Adjustable per device via
  `localStorage.largeQtyThreshold`.
* **Already counted here** is shown when a SKU is re-scanned in the same location, with
  the running total, so a counter can tell a genuine second pallet from a double scan.
* **History** lists the last 50 lines from that device, and any of them can be voided.
  Voided lines are excluded from totals but kept in the raw export for the audit trail.
* It is a **blind count** by default: expected quantities are never sent to the handheld.

---

## Zebra DataWedge setup (one-time, per device)

The app reads scans as keystrokes, so the scanner must be in keyboard-wedge mode with
an Enter suffix:

1. Open **DataWedge** → the profile associated with Chrome (or create one and associate
   the browser app).
2. **Keystroke output**: enabled.
3. **Basic data formatting** → **Send ENTER key**: enabled. *(Without this the app never
   sees the end of a scan.)*
4. **Barcode input** → enable the symbologies your labels use (Code 128, Code 39,
   UPC-A/EAN-13, GS1-128 as applicable).
5. Optional: **Intent output** off, **Send TAB key** off.

Then in Chrome on the device, open the server URL and **Add to Home screen** — it
launches full-screen with no address bar, and the app shell is cached so it starts
even with no signal.

---

## The count → variance flow

1. Supervisor creates the session and uploads the on-hand export.
2. Counters sign on; each device downloads the list once.
3. Counting happens (online, offline, or both).
4. Supervisor watches progress and exports the variance report.
5. Variances get recounted — a second count of the same location and SKU adds another
   line, and the report compares the total against expected.
6. Supervisor closes the session; it stops accepting new counts.

Variance statuses: `MATCH`, `VARIANCE` (counted ≠ expected), `MISSING` (expected,
never counted), `FOUND` (counted, not expected — includes override lines).

---

## API

Handheld (no auth — the badge identifies the counter):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions` | Open sessions |
| `GET` | `/api/sessions/:id/master?have=<v>` | Master list; `have` skips an unchanged download |
| `POST` | `/api/sessions/:id/counts` | Batch upload; idempotent on `clientId` |
| `POST` | `/api/sessions/:id/void` | Void a line |
| `GET` | `/api/health` | Health check |

Supervisor (`Authorization: Bearer <token>` from `POST /api/admin/login`):

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/api/admin/sessions` | List / create |
| `POST` | `/api/admin/sessions/:id/master?kind=&replace=` | Upload master CSV |
| `POST` | `/api/admin/sessions/:id/status` | Open / close |
| `GET` | `/api/admin/sessions/:id/progress` | Live progress |
| `GET` | `/api/admin/sessions/:id/variance` | Variance rows |
| `GET` | `/api/admin/sessions/:id/export/counts.csv` | Raw count export |
| `GET` | `/api/admin/sessions/:id/export/variance.csv` | Variance export |

---

## Security

Sized for a private warehouse network, not the open internet: one shared supervisor
password, and handheld endpoints open to anyone who can reach the server. If it is
exposed publicly, put it behind a VPN or an authenticating proxy, and set a real
`ADMIN_PASSWORD`. Admin tokens are in-memory, so a restart signs supervisors out.

---

## Not built yet

Deliberately left out of v1, all straightforward to add:

* recount assignment (a supervisor pushing a variance list back to a specific counter)
* per-counter task assignment by zone
* live ERP/WMS integration (v1 is CSV in, CSV out)
* `.xlsx` upload (save as CSV for now)
* multi-warehouse support in one instance
