# SOP — Inventory Control

**Role:** Inventory controller  **Login profile:** *Inventory control — the count, adjustments, downloads*  **Pages:** Dashboard (every tab), Testing Suite, User guide  **Functions:** Approve adjustments, Downloads and printouts

This procedure is for the person who owns the numbers: who checks a count before it is
trusted, signs off the differences, hands the ERP its file, and keeps the records an auditor
will ask for. It covers only what the *Inventory control* login can reach. Setting the count
up, registering scanners and running the floor are other roles' procedures; where this one
needs something from them it says so.

Everything here is done on the **Dashboard** (`/admin`) with an *Inventory control* login. The
count to work on is picked in the header; every tab, download and export on the page is about
that count.

## Contents

- [1 — What you own, and what you do not](#1--what-you-own-and-what-you-do-not)
- [2 — Before the count: the data going in](#2--before-the-count-the-data-going-in)
- [3 — During the count: reading it as it runs](#3--during-the-count-reading-it-as-it-runs)
- [4 — After the count: the reconciliation](#4--after-the-count-the-reconciliation)
- [5 — Approving the adjustments](#5--approving-the-adjustments)
- [6 — Exporting the data](#6--exporting-the-data)
- [7 — The ERP file](#7--the-erp-file)
- [8 — Cycle counts and coverage](#8--cycle-counts-and-coverage)
- [9 — Records to keep, and for how long](#9--records-to-keep-and-for-how-long)
- [10 — A count-close checklist](#10--a-count-close-checklist)
- [11 — When something looks wrong](#11--when-something-looks-wrong)
- [Appendix — Every file this role can produce](#appendix--every-file-this-role-can-produce)

## 1 — What you own, and what you do not

**You own**

- whether the inventory report the count was compared against was the right one;
- the pallet report: every difference between the system and the floor, and what each one is;
- the adjustments: which differences are real, with a reason code against each;
- the file the ERP receives, and that it posts what was approved and nothing else;
- the records: the workbook, the ERP file, the log, kept where the business keeps them.

**You do not own** (and your login cannot do)

- creating a count, uploading the lists, setting thresholds or approvals on or off: the
  *admin* or *supervisor* does that under Settings. Ask for it; the checklist in section 10
  says what to ask for before the count starts;
- queueing aisles to teams, answering an SOS, messaging the floor: the *count supervisor*;
- closing the count: Settings → Count session, an admin or supervisor. You say when it is
  ready to close; section 10 is the test.

If the sidebar shows a page or a button greyed out, that is the profile, not a fault.

## 2 — Before the count: the data going in

A count compares the floor with a report. If the report is wrong, every variance is wrong.

1. **Pull the inventory report** from each of the site's systems as close to the start of the
   count as the business allows, after the last receipt and shipment that will be in the ERP
   before the freeze. Give the files to the admin or supervisor to upload under *Settings →
   Lists & racking → Inventory report*, one upload per system, naming the system.
2. **Read the upload summary** they get back (ask for a screenshot, or look at Settings with
   them). It says how many pallets loaded, how many rows were **merged** (the same container
   twice in one bin: two ledger entries for one pallet, quantities added), how many were
   **duplicates** (the same container in two bins: the first row stands, the rest are listed
   with both bins), how many **open bins** (a bin with no container: an expected empty) and how
   many **zero or negative quantities**. Duplicates and negatives are yours to look at in the
   ERP before the count, not after.
3. **Check the counts on the Dashboard** once it is uploaded: *Progress* shows pallets on the
   report, and *Reports → Pallet report* with **Hide missing** off lists them all. Pick the
   **System** filter and confirm each system's pallet count against the file you sent.
4. **Agree the thresholds** with whoever sets the count up (*Settings → Count session*):
   - **Recount over N units / or over N %**: a difference smaller than both raises no second
     count. 2 to 5 units and 5 to 10 % is usual; at 0/0 every difference is recounted and the
     list becomes unworkable;
   - **a cap** on second counts;
   - **Adjustments need approval**, and its own threshold under which a difference goes
     through as **AUTO** without a signature. Decide this before the count: switching it on
     afterwards is allowed but means signing everything at once.
5. **Agree the reason codes** (*Settings → ERP & backups → Adjustment reasons*). They are what
   you will pick for every approval and what the ERP file carries. Match them to the ERP's own
   list.
6. **Ask for a trial run** if the team is new. A trial counts for real on the dashboard and is
   wiped by *End the trial*; nothing from it can be exported to the ERP. Practise the close
   on it: sections 4 to 7, end to end.

## 3 — During the count: reading it as it runs

You are not running the floor, but the numbers start to tell you things from the first hour.

- **Progress** (Dashboard → Progress): bins counted, lines, pace and the time left at this
  pace. *Pallets found that are not on the report* climbing fast on one team usually means a
  mis-scanned label format or a pallet type the report does not carry; walk over and look
  before three hundred of them exist.
- **Pallet report → Hide matching pallets** is the live exception list. Early in a count most
  rows are `MISSING` only because nobody has reached the aisle yet; tick **Hide missing** and
  read the rest: `QTY VARIANCE`, `WRONG BIN`, `NOT IN MASTER`, `COUNTED TWICE`.
- **Second counts** (Dashboard → Second counts) shows what the thresholds are raising. If the
  list is hundreds deep after one aisle, the thresholds are too tight: ask for them to be
  raised now, not at the end.
- **Lot / date problems only** on the pallet report catches a wrong lot or an expired date
  even when the quantity agrees. For frozen product these are variances the ERP never sees
  unless you act.
- **Find a lot** answers a recall notice during a count: part of a lot code gives every case
  of it, where it was counted and where the report still expects it.

Do not approve adjustments while teams are still in the aisles the adjustments are in. A second
count can change the number, and a changed number clears its approval.

## 4 — After the count: the reconciliation

When the floor reports every aisle handed back and *Progress* shows every bin with a count:

1. **Second counts to zero.** Dashboard → Second counts must show nothing open. A count
   closed with open second counts has known-wrong numbers in it. You can raise more by hand
   (**Request second count** on a bin) or **Raise from all variances now**: it skips aisles
   nobody has reached and says how many it skipped.
2. **The pallet report, status by status.** Use the **Status** filter and work each list:
   - `QTY VARIANCE`: the real stock differences. Biggest first. Each will become an
     adjustment;
   - `WRONG BIN`: right pallet, right quantity, wrong place. No stock adjustment, but the
     bin on the ERP is wrong and a put-away or transfer is needed; the **Found in** column has
     the bin it is in;
   - `NOT IN MASTER`: pallets on the floor the report did not know. A real pallet (a receipt
     not yet posted, a pallet from another system's report) or a mistyped id. The
     adjustments list carries them as additions; rows named `NO-LABEL-F01A001-1` are pallets
     with no readable label counted under their bin, on the **Fix list** to relabel;
   - `MISSING`: on the report, never found. Until the count is closed these are not
     adjustments. Once it is closed they are, in full;
   - `COUNTED TWICE`: one pallet scanned by two teams, or a second label; the lines say who
     and when. Decide which count stands; the supervisor can void a line.
3. **By system.** With three systems in one warehouse, read the report once per **System**.
   A pallet counted in the wrong system's bin is a `WRONG BIN` to one system and `NOT IN
   MASTER` to the other; the *System* column on the pallet report and the *Summary* sheet's
   per-system found counts show it.
4. **Lot and date.** The report compares lot codes where the count asked for them: *Report
   lot* against *Counted lot*, and *Best before*. A right quantity of the wrong lot is a
   variance for traceability even when the ERP's quantity is right.
5. **Write down what you decided** on anything you are not adjusting (a `COUNTED TWICE` you
   resolved, a `NOT IN MASTER` that was a receipt in transit). The approval note on the
   adjustment is the right place when there is an adjustment; the workbook's **Comments**
   column otherwise.

## 5 — Approving the adjustments

**Dashboard → Adjustments.** Only on a count with *Adjustments need approval* on; with it off
the tab says so and every difference goes to the ERP file as it stands.

The **Positive and negative** tiles at the top are the two numbers the business asks first:
stock to add and stock to take off, in units and pallets, with **Download this list (CSV)**
for either side or both.

Then the list: every pallet that differs, biggest first, with the report quantity, the counted
quantity and what the ERP would move.

1. Read a line against the pallet report and, where it matters, against the floor: a 600-case
   pallet short by 40 is a question for the team that counted it before it is a write-off.
2. Tick the lines you are satisfied with. **Select all shown** takes the screenful.
3. Pick a **reason** from the site's list and add a **note** if the reason does not say
   enough (*"second count agreed; damaged cases removed 3 Oct"*).
4. **Approve selected**, or **Reject selected** when the count is wrong and the system should
   keep its number. A rejected line goes nowhere near the ERP.

What the app guarantees, so you can rely on it:

- **Nothing unsigned reaches the ERP.** The Adjustments layout holds back every pending line;
  the preview says how many it held.
- **Under the threshold is AUTO.** Those go through unsigned and are marked `AUTO` in the
  list and the workbook. If the business wants everything signed, the threshold is 0.
- **Counted again means signed again.** A second count that changes an approved pallet
  clears the approval and the line comes back. A variance a second count removes disappears.
- **Every decision is in the log** with your name, the reason and the time: the answer to
  *"who authorised writing off 400 cases"*.
- **MISSING pallets join the list when the count is closed.** Plan the close so you are at
  the desk when it happens: that is usually the largest batch of the count.

## 6 — Exporting the data

Every download on the Dashboard is a function of your profile (*Downloads and printouts*).
Each file is for a different reader.

**Export everything (Excel)** — Dashboard → Reports. One workbook, every table the app keeps
for this count, in words a person can read. This is the record: the file for the auditor, the
finance team and the shared drive. Its sheets:

| Sheet | What is on it |
|---|---|
| **Summary** | the count, its type and status, bins on the list / counted / left, pallets on the report and found, per-system found counts, empty bins, lines, flagged lines, teams, scanners, positive and negative adjustments in pallets and units, the net, the time zone, who exported it and when |
| **Count lines** | every scan: time, team, clock-in numbers, scanner, aisle, bin, pallet, system, quantity, empty-bin flag, item, description, lot, best before, second-count flag, pallet-not-on-report, bin-not-on-list, outside the team's aisle, counted twice, pallet and rack label state, second-label-of, flag / reason, comments, voided, and when it reached the server |
| **Pallets** | the pallet report: pallet, system, item, description, variant, entry no., result, report and counted quantity, difference, report bin, found in, times counted, teams, report and counted lot, best before, second label, last scanned, comments |
| **Adjustments** | side (positive / negative), pallet, system, item, bin, why, report and counted quantity, adjustment, approval state, approval reason, approved by |
| **Bins** | every bin with zone, aisle, level, description, counted, recorded empty, lines, last counted |
| **Bins not counted** | the bins with no line at all |
| **Teams**, **Sign-ons** | who was on the count, when, for how long, on which scanner |
| **SOS**, **Stopped scanning** | every alert, who answered it, when, the outcome |
| **Second counts** | every recount: bin, pallet, why, who raised it, who counted first, who did it, when |
| **Fix list** | labels to replace, damage, blocked bins, with who reported and who fixed |
| **Log** | every supervisor action on this count |

**The CSVs** — for machines and for your own reconciliation sheet:

- **Pallet report** (Reports): the pallet report as filtered on screen, so a *System* or a
  *Status* filter gives you that slice;
- **Adjustments** (Adjustments → Download this list): positive, negative or all;
- **Second counts** (Second counts → Export CSV);
- **Fix list CSV** and **Labels only (CSV)** (Reports → Fix list): the walk-round lists;
- **Count lines** (`counts.csv`): every raw scan, for anyone who wants to rebuild the count
  from first principles.

**Printouts** — the **count sheet** (paper, per aisle, blind by default) is there for the day a
scanner cannot be used; it prints from the Reports tab.

Name files for the count and the date when you save them (`2026-10-03-Q3-physical-everything.xlsx`).
The ERP file names itself that way already.

## 7 — The ERP file

**Settings → ERP & backups → Send to the ERP.** This card is on the Settings page, which the
*Inventory control* profile does not open. Two ways to work it:

- sit with the admin or supervisor while they produce it, with you reading the preview; or
- ask the admin to give your login the *Settings* page. That makes the login an admin for
  everything else on that page too, so most sites prefer the first.

Either way the procedure is:

1. **Layout.** Pick the layout that matches the ERP. Column names and which rows are
   included are configuration, not something to fix in the file afterwards; a new layout
   is added on the same card. The **Adjustments** layout carries the reason code and the
   approver's name, so the file tells the same story as the log. *Pallet lines* carries one
   row per pallet counted; for Dynamics NAV there is a journal layout with a document number
   per count and day so a re-export cannot post twice.
2. **System.** Where several systems share the warehouse, pick one. The file is named for
   it and holds only that system's pallets. Produce one file per system.
3. **Preview.** Read the first rows. The preview says how many rows the file has and how
   many adjustments it **held back** because nobody has signed for them. If that number is
   not zero, go back to section 5.
4. **Download CSV**, then import it into the ERP. The export is written to the log with the
   layout, the system, the row count and what was held.
5. **Keep the file** with the workbook (section 9). It is the only proof of exactly what was
   handed over.

A **trial run** refuses to export: the message says to end the trial and count for real.
A **closed** count still exports, for as long as it exists.

## 8 — Cycle counts and coverage

If the site runs the cycle-count programme, the inventory controller reads it the same way,
on the **Cycle counts** page (`/cycle`). That page is not in the *Inventory control* profile
by default; ask for the *Coverage* tab at least, or the whole page.

- **Coverage** shows how much of the warehouse has been counted in the period and what has
  not been touched, with **Coverage CSV** for the auditors.
- Each cycle batch is *the* count for its bins: the pallet report, the adjustments and the ERP
  file work exactly as for a full count, on the cycle-count session.
- Keep one cycle-count session for the year. A new session loses the history of when each
  bin was last counted, which is what the picker uses.

## 9 — Records to keep, and for how long

Keep, per count, in the business's document store (not only on the server):

| Record | Where it comes from | Why |
|---|---|---|
| The inventory report(s) uploaded | the files you pulled from the systems | what the count was compared against |
| The upload summaries | screenshot or note from the person who uploaded | merges, duplicates and negatives you accepted |
| Export everything (Excel) | Dashboard → Reports, after the close | the count itself, every sheet |
| The ERP file(s) | Settings → ERP & backups | exactly what the ERP was given |
| The log export | Settings → ERP & backups → Export the log | who did what, incl. every approval |
| A database backup | Settings → ERP & backups → Back up now, downloaded | the whole thing, re-loadable |

Take the workbook **after** the count is closed and the MISSING pallets have been approved,
so it is the final state; take it again if anything is changed later. The app keeps a daily
backup and the last fourteen on its own volume; a volume is not an archive, so download one
after each count. How long to keep them is the business's retention rule for stock records;
the files are small.

## 10 — A count-close checklist

Before you tell the supervisor the count can be closed:

- [ ] Progress shows every bin with a count, or the bins without one are listed and
      accepted (**Bins not counted** sheet)
- [ ] Second counts: nothing open
- [ ] Pallet report read status by status and by system; decisions noted
- [ ] Fix list: labels to replace handed to the floor (a relabel is not a stock movement, but
      the next count depends on it)
- [ ] Adjustments: everything that is going to be approved is approved, with reasons; nothing
      pending except what you intend to reject

After the close:

- [ ] MISSING pallets have joined the Adjustments list; approve or reject them
- [ ] Preview of the ERP file shows **0 held back**, per system
- [ ] ERP file(s) downloaded and imported; import result checked against the file's row count
- [ ] Export everything, the log export and a backup downloaded and filed
- [ ] The ERP's on-hand after posting agrees with the pallet report's counted quantities on a
      sample of the largest adjustments

## 11 — When something looks wrong

| What you see | What it usually means | What to do |
|---|---|---|
| Hundreds of second counts after one aisle | Thresholds at 0, or too tight | Ask for *Recount over*, *or over %* and a cap to be set now |
| The Adjustments tab is empty | Approvals are off for this count, or nothing differs yet | Approvals are a Count session setting; a pallet nobody reached is not an adjustment until the close |
| The ERP file is shorter than the variance list | Pending approvals are held back | The preview says how many; approve or reject them, export again |
| A pallet appears as `NOT IN MASTER` in one system and `MISSING` in another | Counted in a bin the other system owns, or on the wrong system's report | Read the pallet report by **System**; it is one pallet, decide which report it belongs to |
| Many `NOT IN MASTER` rows named `NO-LABEL-…` | Labels that would not scan | They are counted under the bin; relabel from the Fix list; the quantity is safe |
| An approved line came back as pending | A second count changed its number | Read it again and sign again; the old approval is in the log |
| Numbers moved after an ERP re-import | The report was re-uploaded with *Replace what is there* | Re-read the pallet report; the log says who re-uploaded and when |
| A line's time is hours out | That scanner's clock was wrong | Nothing: the server corrected the scan time from the gun's send time; the raw time is in the log |
| You cannot find a button this procedure names | It is on a page your profile does not open | Settings is admin-only; ask, or have the page added to your login |
| You do not know what a message means | — | Paste it into **User guide → Ask the guide** |

## Appendix — Every file this role can produce

| File | Where | Format | Reader |
|---|---|---|---|
| Export everything | Dashboard → Reports | Excel workbook, 14 sheets | auditor, finance, archive |
| Pallet report | Dashboard → Reports | CSV, as filtered | reconciliation |
| Count lines | Dashboard → Reports | CSV, every scan | rebuild / audit |
| Adjustments (positive, negative, all) | Dashboard → Adjustments | CSV | finance sign-off |
| Second counts | Dashboard → Second counts | CSV | floor follow-up |
| Fix list, Labels only | Dashboard → Reports → Fix list | CSV | floor walk-round |
| Count sheet | Dashboard → Reports | printable page | paper fallback |
| Coverage | Cycle counts → Coverage (if given) | CSV | auditors |
| ERP file, per layout and system | Settings → ERP & backups (admin) | CSV in the ERP's columns | the ERP |
| Log | Settings → ERP & backups (admin) | CSV | auditor |
| Database backup | Settings → ERP & backups (admin) | `.db` file | disaster recovery |
