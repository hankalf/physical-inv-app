# Reports and exports — every download on Reports and Adjustments

**Role:** Inventory control, count supervisors, anyone who reports on a count  **Login profile:** your own login, with *Downloads* for the files  **Pages:** Dashboard → Adjustments, Dashboard → Reports (the same tabs are under Inventory Control)  **Functions:** what each export button downloads, its file, and every column on it

Every button on the **Adjustments** and **Reports** tabs that gives you a file, what is in it,
and when to use which. Every export is of the count picked at the top of the page — pick the
count first.

## Contents

- [1 — In one minute](#1--in-one-minute)
- [2 — Before you export](#2--before-you-export)
- [3 — Adjustments: Positive and negative — Download this list (CSV)](#3--adjustments-positive-and-negative--download-this-list-csv)
- [4 — Adjustments: the ERP worksheet (CSV)](#4--adjustments-the-erp-worksheet-csv)
- [5 — Adjustments: ERP upload, an aisle at a time (Excel)](#5--adjustments-erp-upload-an-aisle-at-a-time-excel)
- [6 — Adjustments: Adjustments CSV](#6--adjustments-adjustments-csv)
- [7 — Reports: Fix list CSV and Labels only (CSV)](#7--reports-fix-list-csv-and-labels-only-csv)
- [8 — Reports: Filed as the count goes, and the Final report](#8--reports-filed-as-the-count-goes-and-the-final-report)
- [9 — Reports: Export everything (Excel)](#9--reports-export-everything-excel)
- [10 — Reports: Pallet report CSV](#10--reports-pallet-report-csv)
- [11 — Reports: Raw counts CSV](#11--reports-raw-counts-csv)
- [12 — Reports: Exceptions CSV](#12--reports-exceptions-csv)
- [13 — Reports: Uncounted bins CSV](#13--reports-uncounted-bins-csv)
- [14 — Reports: Count sheets (printable)](#14--reports-count-sheets-printable)
- [15 — Which export for which job](#15--which-export-for-which-job)
- [16 — When something is not right](#16--when-something-is-not-right)

## 1 — In one minute

| Tab | Button | You get | For |
|---|---|---|---|
| Adjustments | **Download this list (CSV)** | The positive or negative lines on screen | Reading or sharing one side |
| Adjustments | **Download the ERP worksheet (CSV)** | Every adjustment, with an *In ERP* column to fill in | Keying the whole count into the ERP, then marking it |
| Adjustments | **⬇ Excel** on an aisle's row | Every pallet in that aisle, with an *Uploaded to ERP* column | Keying the ERP an aisle at a time |
| Adjustments | **Adjustments CSV** | The approval record: who approved or rejected each line, and why | The audit trail for approvals |
| Reports | **Fix list CSV** / **Labels only (CSV)** | Labels to replace, damage, blocked bins / just the labels | The walk-round with a label printer |
| Reports | **Final report** and the filed files | Each aisle's numbers as it was finished; every sheet at the end | The record that survives on its own |
| Reports | **Export everything (Excel)** | One workbook, every table, in plain words | The auditor, the manager, the shared drive |
| Reports | **Pallet report CSV** | One row per pallet: report, counts, bins, lot, status, ERP mark | Working the differences in Excel |
| Reports | **Raw counts CSV** | Every scan line, as recorded | A reconciliation, or checking one line |
| Reports | **Exceptions CSV** | Only the flagged scan lines | What needs a second look |
| Reports | **Uncounted bins CSV** | Bins with no count at all | What is left to do |
| Reports | **Open a printable sheet** | A paper count sheet | Counting without a scanner |

## 2 — Before you export

- **The count at the top of the page** is the one exported. A file name carries its number
  (`pallets-session-12.csv`) or its name (`Q3-wall-to-wall-aisle-F01-for-ERP-2026-10-20.xlsx`).
- **The pallet report's filters do not change the files.** *Hide matching pallets*, *Status*,
  *Aisle / bin* and the rest narrow what you read on screen; the CSVs and the workbook always have
  every row.
- **CSV or Excel.** A CSV opens in Excel and is the shape the ERP and other systems read; its
  headings are short column names (`counted_qty`). *Export everything* and the aisle sheets are
  Excel workbooks for people: plain headings, *Yes* / *No*, times on the warehouse's clock.
- **The count that stands.** Where a bin was counted again, the latest count is the one in the
  *Counted* figures — a 2nd count stands over the 1st, a 3rd over both. The earlier counts are kept
  in their own columns.
- **A count still running** exports what is in so far. An aisle still being counted says so.
- **Downloads** must be on your login for the file buttons; without it they are greyed out.

## 3 — Adjustments: Positive and negative — Download this list (CSV)

**Dashboard → Adjustments → Positive and negative.** Pick **Positive**, **Negative** or **All**
(the two tiles at the top pick a side too), then **Download this list (CSV)**.

It downloads exactly the lines on screen, with *Hide lines already in the ERP* applied if it is
ticked: `adjustments-positive-session-12.csv`, `-negative-` or `-all-`.

| Column | What it is |
|---|---|
| Pallet | The pallet ID |
| Item | The SKU |
| Bin | Where it was counted (or where the report put it, if it was not found) |
| Why | *More than the report*, *Less than the report*, *Not found*, *Not on the report — found on the floor*, *Counted twice* |
| System qty | What the inventory report said |
| Counted qty | The count that stands |
| Adjustment | Counted less the report: + is stock to add, − stock to take off |
| Approval | *approved*, *rejected*, *waiting*, or blank when the count needs no approvals |
| In ERP | *yes* once the line is marked as keyed into the ERP |

## 4 — Adjustments: the ERP worksheet (CSV)

**Dashboard → Adjustments → Positive and negative → Download the ERP worksheet (CSV).** Every
positive and negative line on the count, whatever side is on screen: `erp-worksheet-session-12.csv`.

| Column | What it is |
|---|---|
| Side | *Positive* or *Negative* |
| Pallet, System, Item, Bin | The line, and which system it belongs to |
| Why | As in section 3 |
| Report quantity, Counted quantity, Adjustment | The report, the count that stands, the difference |
| Approval | *approved* / *rejected* / *waiting*, or *not required* |
| In ERP | *yes* when it is marked as keyed in — **this is the column you fill in** |
| Entered by, Entered at | Who marked it, and when |
| Changed since entered | *was 12* — counted again after it went into the ERP; the ERP has the old number |

**Bring it back:** write *yes* (or *x*, a date, your initials) in **In ERP** for every line you keyed,
then **Upload the worksheet back…** on the same card. Those lines are marked as in the ERP; *no*
takes a mark off; a blank leaves a line as it was. Only the *In ERP* column is read — a quantity
changes only by being counted.

## 5 — Adjustments: ERP upload, an aisle at a time (Excel)

**Dashboard → Adjustments → ERP upload, an aisle at a time.** A row for every aisle — its lines,
how many are uploaded, and whether it is still being counted. **⬇ Excel** on a row downloads that
aisle: `Q3-wall-to-wall-aisle-F01-for-ERP-2026-10-20.xlsx`.

The workbook has two sheets. **Aisle F01** — every pallet in the aisle, the matches included:

| Column | What it is |
|---|---|
| Aisle, Bin, Pallet, System, Item, Description, Lot | The line |
| Report bin, Report quantity | What the inventory report said |
| Counted quantity | The count that stands |
| Adjustment | The difference; 0 for a match |
| Result | *Matches*, *Quantity differs*, *In a different bin*, *Not found*, *Not on the report*… |
| Count | *1st*, *2nd* or *3rd* — which count the figure is |
| Uploaded to ERP | **Fill this in** as you key each line |
| Uploaded by, Uploaded at | Who marked it, and when |
| Changed since uploaded | *was 12* — counted again after it went in |

**How to use** — the same instructions, inside the file.

**Bring it back:** **⬆ Upload a filled-in sheet…** on the card. The lines on the sheet with *yes*
are marked as uploaded, and the aisle's row counts them. *No* takes a mark off; a blank leaves a
line as it was.

## 6 — Adjustments: Adjustments CSV

**Dashboard → Adjustments → Adjustments → Adjustments CSV** — the approval record, when the count
asks for approvals: `adjustments-session-12.csv`.

| Column | What it is |
|---|---|
| pallet_id, sku, location | The line |
| kind | What kind of difference: a quantity, *MISSING*, *NOT IN MASTER*, *COUNTED TWICE* |
| expected_qty, counted_qty, variance_qty | The report, the count, the difference |
| status | *pending*, *approved*, *rejected*, *auto* (under the thresholds) |
| reason, note | The reason picked when it was approved or rejected, and any note |
| decided_by, decided_at | Who decided, and when |
| in_erp, entered_by, entered_at | Whether it is marked as in the ERP, by whom, when |

## 7 — Reports: Fix list CSV and Labels only (CSV)

**Dashboard → Reports → Fix list.** **Fix list CSV** is everything reported from the floor:
`fix-list-session-12.csv`.

| Column | What it is |
|---|---|
| Kind | *Label to replace*, *Damage*, *Blocked bin*, *Other* |
| What | Pallet, bin, racking, product… |
| Bin, Aisle, Pallet | Where |
| Problem, Note | What is wrong, in the counter's words |
| Reported by team, Scanner, Reported | Who, on which gun, when |
| Confirmed | For a label: whether the bin or pallet was scanned or typed to confirm it |
| Status | *Open* or *Fixed* |
| Fixed by, Fixed at, Outcome | Who fixed it, when, and what was done |

**Labels only (CSV)** is the label printer's list: `labels-to-replace-session-12.csv` — *what*
(pallet or bin label), *location_code*, *aisle*, *pallet_id*, *issue* (*typed in*, *nothing
readable*), *sku*, *description*, *qty*, *team*, *device_id*, *comments*, *scanned_at*.

## 8 — Reports: Filed as the count goes, and the Final report

**Dashboard → Reports → Filed as the count goes.** Each aisle a team hands back as complete is
filed at once, as plain CSV files, so a count that stops halfway already has every finished aisle
written down. The table lists each filing with a download link for each file:

- **An aisle's filing** — *count-lines*, *pallets*, *bins*, *bins-not-counted*, *second-counts* and
  *fix-list*, each for that aisle alone, and a *README.txt* saying what it is.
- **Final report** — once every bin has a count and no second count is open, the button files every
  sheet of *Export everything* (section 9) the same way. Until then it is greyed out, and the line
  beside it says why: *Not yet: 120 bins still to count, 3 second counts still open.*

## 9 — Reports: Export everything (Excel)

**Dashboard → Reports → Pallet report → Export everything (Excel).** One workbook with every table
the app keeps for the count, in plain words: `Q3-wall-to-wall-2026-10-20.xlsx`.

| Sheet | What is on it |
|---|---|
| **Summary** | The count, its type and status; started, ended, time on the clock, downtime, counting time, pace; bins on the list / counted / left; pallets on the report and found; empty bins; lines; flagged lines; teams; scanners; positive and negative adjustments in pallets and units, and the net; the time zone; who exported it and when |
| **Count lines** | Every scan: when, team, clock-in numbers, scanner, aisle, bin, pallet, system, quantity, empty bin, item, description, lot, best before, 2nd / 3rd count, not on report, bin not on list, outside the team's aisle, counted twice, pallet and rack label state, second label of, flag / reason, comments, voided, when it reached the server |
| **Pallets** | The pallet report: pallet, system, item, description, variant, entry no., result, report and counted quantity, difference, report bin, found in, times counted, teams, report and counted lot, best before, second label, last scanned, comments |
| **Adjustments** | Side, pallet, system, item, bin, why, report and counted quantity, adjustment, approval, approval reason, approved by, in ERP, entered by, entered at |
| **Not on the report** | Pallets the report does not have — sold or shipped in the system, found on the floor: where found, quantity, lot, teams, approval, ERP state, and a blank **Investigation** column |
| **Bins** | Every bin: zone, aisle, level, description, counted, recorded empty, lines, last counted |
| **Bins not counted** | Bins with no line at all |
| **Teams** | Each team: shift, started, last activity, time on the count, downtime, counting time, lines, lines and bins an hour, state |
| **Downtime** | Each quiet spell on the count: from, to, minutes |
| **Sign-ons** | Who signed on, when, on which scanner, and when they signed off |
| **SOS** | Every SOS: who, what, where, who answered, the outcome |
| **Stopped scanning** | Every stopped-scanning alert, and how it was cleared |
| **Second counts** | Every second and third count: bin, pallet, round, why, raised by, first counted by, team, state, when, done by |
| **Counts side by side** | Every bin counted again, a row a pallet: the report, the 1st, 2nd and 3rd counts with their teams, the final count and which number stands |
| **Fix list** | As section 7 |
| **Log** | Everything anybody did on the count: when, who, what, detail |

## 10 — Reports: Pallet report CSV

**Dashboard → Reports → Pallet report → Pallet report CSV** — the whole pallet report, every row
whatever the filters show: `pallets-session-12.csv`.

| Column | What it is |
|---|---|
| pallet_id, source, sku, description, variant, uom, entry_no | The pallet, its system, and the report's details |
| expected_qty, counted_qty, variance_qty | The report, the count that stands, the difference |
| expected_location, found_location | The report's bin, and the bin(s) it was counted in |
| times_counted, teams, comments, last_scan | How often, by whom, what they wrote, when |
| status | `MATCH`, `QTY VARIANCE`, `WRONG BIN`, `MISSING`, `NOT IN MASTER`, `COUNTED TWICE`, `SECOND LABEL`, `NOT COUNTED` |
| recounted, first_count_qty, second_pass_qty, open_recounts | Counted again (1/0), the 1st and 2nd counts, and any second count still open |
| expected_lot, found_lot, lot_status, expiry, expiry_status | The lot on the report and the one counted, and whether the date has passed or is close |
| alias_of, also_tagged | Second labels, from counts taken that way |
| erp_uploaded, erp_by, erp_at, erp_changed | Marked as in the ERP, by whom, when, and 1 if it has moved since |

On screen, the same report reads **Pallet ID, System, SKU, Description, Expected, 1st count, 2nd
count, Counted, Expected bin, Found in** (only when it differs), **Lot, Expiry, Team, Comments,
Status, ERP upload**.

## 11 — Reports: Raw counts CSV

**Dashboard → Reports → Pallet report → Raw counts CSV** — every scan line exactly as it was
recorded, voided ones included: `counts-session-12.csv`.

| Column | What it is |
|---|---|
| id | The line's number |
| pallet_id, qty, location_code, aisle | What was scanned, how many, where |
| sku, description, lot, expiry | From the report, and the lot and date scanned |
| alias_of | A tag saved as a second label (counts taken that way) |
| comments | What the counter wrote, or the note on a pallet with more than one label |
| team, employees, device_id | Who and on which scanner |
| unknown_pallet, unknown_location, off_assignment, duplicate_pallet, empty_bin | 1 when the line was: not on the report, a bin not on the list, outside the team's aisle, counted twice, an empty bin |
| label_issue, bin_label_issue | *typed*, *none*, *assumed* — a label that would not scan |
| pass, recount_id | 1, 2 or 3 — first, second or third count — and which second count it was for |
| override_reason | The reason picked when the gun warned |
| voided | 1 when the line was voided |
| scanned_at, received_at | When it was scanned, and when it reached the server |

## 12 — Reports: Exceptions CSV

**Dashboard → Reports → Pallet report → Exceptions CSV** — the same columns as the raw counts, only
the lines that were flagged: a pallet not on the report, a bin not on the list, outside the team's
aisle, counted twice, a reason picked on a warning, or a label that would not scan:
`exceptions-session-12.csv`.

## 13 — Reports: Uncounted bins CSV

**Dashboard → Reports → Pallet report → Uncounted bins CSV** — every bin on the list with no count
at all: *aisle*, *code* (the bin), *zone*. `uncounted-bins-session-12.csv`. An empty bin recorded as
*EMPTY* is counted, so it is not on it.

## 14 — Reports: Count sheets (printable)

**Dashboard → Reports → Count sheets.** Not a download: **Open a printable sheet** opens a page to
print, for counting on paper.

- **Aisle** and **Levels** narrow it (*F01*, *A-C*); blank is the whole site.
- **Only bins with no count yet** leaves out what is already counted.
- **Show what the system expects** adds a *System says* column; left off, the sheet is blind, so it
  is a count and not a copy.

Columns: **Bin**, **Lvl**, **Pos**, **Face** (front or back), *System says* if asked, **Pallet ID**,
**Qty**, **Notes** — the last three to fill in by hand.

## 15 — Which export for which job

| The job | The export |
|---|---|
| Key the adjustments into the ERP | The aisle sheets (section 5), or the ERP worksheet (section 4) — and upload it back to mark the lines |
| Show a manager or auditor the whole count | **Export everything** |
| Work the differences in Excel | **Pallet report CSV** |
| Find the pallets sold in the system but found on the floor | *Not on the report* in **Export everything** |
| Prove who approved what | **Adjustments CSV** |
| See every scan, or check one line | **Raw counts CSV** |
| What still needs a look | **Exceptions CSV**, **Uncounted bins CSV** |
| The label printer's walk-round | **Labels only (CSV)** |
| The record if anything goes wrong | **Filed as the count goes**, and the **Final report** |

## 16 — When something is not right

| You see | What it means | What to do |
|---|---|---|
| A download button is greyed out | Your login does not have *Downloads* | Ask an admin |
| The CSV has more rows than the screen | The screen is filtered; the file never is | As meant — filter in Excel |
| Accents or dashes look wrong in a CSV | The file was opened as plain text | Open it in Excel, or import it as UTF-8 |
| *Changed since entered / uploaded* on a line | It was counted again after it went into the ERP | Key the new number, then mark it again |
| **Final report** is greyed out | A bin has no count, or a second count is open | It says which; finish them first |
| An aisle sheet says the aisle is still being counted | Lines there may still change | Wait for the aisle, or key it knowing it may move |
| A pallet's comment from its first count is not on the report | The report shows the count that stands | The comment is still in **Raw counts CSV** and the *Count lines* sheet |
