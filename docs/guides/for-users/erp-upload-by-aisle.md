# The ERP upload, an aisle at a time — how it works

**Role:** Inventory control  **Login profile:** your own login  **Pages:** Dashboard → Adjustments  **Functions:** downloading an aisle for the ERP, marking lines as uploaded

A count goes into the ERP aisle by aisle, as the aisles are finished. For each aisle you
download an Excel sheet, put its lines into the ERP, write *yes* against each line as it goes
in, and upload the sheet back — so the app knows what is in the ERP, nothing is keyed twice, and
nothing is missed.

## Contents

- [1 — In one minute](#1--in-one-minute)
- [2 — Pick an aisle that is ready](#2--pick-an-aisle-that-is-ready)
- [3 — Download the aisle](#3--download-the-aisle)
- [4 — Put it into the ERP and fill in the sheet](#4--put-it-into-the-erp-and-fill-in-the-sheet)
- [5 — Upload the sheet back](#5--upload-the-sheet-back)
- [6 — A line counted again after it went in](#6--a-line-counted-again-after-it-went-in)
- [7 — When something is not right](#7--when-something-is-not-right)

## 1 — In one minute

1. **Dashboard → Adjustments → ERP upload, an aisle at a time.** Pick the count at the top.
2. Pick an aisle whose **second and third counts are finished**.
3. **⬇ Excel** on the aisle: every pallet in it, with an **Uploaded to ERP** column.
4. Put the lines into the ERP. Write **yes** in *Uploaded to ERP* as each goes in.
5. **⬆ Upload a filled-in sheet…** — those lines are marked as in the ERP.
6. Next aisle. **Only aisles not fully uploaded** shows what is left.

The sheet only marks lines. **It never changes a count.**

## 2 — Pick an aisle that is ready

The card has a row for every aisle on the count:

![](../../images/guide-erp-aisles-before.png)

*Every aisle: how much is counted, how much differs, how much is in the ERP, and what is still being counted.*

| Column | What it is |
|---|---|
| Pallets, Counted | The pallets in the aisle, and how many have been counted |
| Differences | How many differ from the report |
| Uploaded to ERP | *not yet*, *12 of 40* or *all in the ERP* — and *N changed since* (section 6) |
| Still being counted | Open **2nd/3rd counts** and **bins not counted** — or *done* |

**Start an aisle once "Still being counted" is clear.** A second or third count can still change
its numbers.

## 3 — Download the aisle

Press **⬇ Excel** on the aisle's row. The workbook is named for the count and the aisle; its
first sheet is the aisle:

![](../../images/guide-export-erp-aisle.png)

*An aisle's sheet, part way through: the lines already in the ERP have yes in Uploaded to ERP (green here).*

| Column | What it is |
|---|---|
| Bin, Pallet, Item, Lot… | The line |
| Report quantity | What the inventory report said |
| Counted quantity | What the count found — the **latest** count (a 2nd or 3rd count stands over the 1st). Blank when the pallet was not found |
| Adjustment | Counted less report: what the ERP has to move. 0 on a match |
| Result, Count | *Matches*, *Quantity differs*, *Not found*…; and whether the number is the 1st, 2nd or 3rd count |
| **Uploaded to ERP** | **The one column you fill in** |
| Uploaded by, Uploaded at | Filled in by the app for lines already marked |
| Changed since uploaded | *was 36*: counted again after it went into the ERP |

Every pallet in the aisle is on the sheet, matches included.

## 4 — Put it into the ERP and fill in the sheet

Work down the sheet. As each line goes into the ERP, write in its **Uploaded to ERP** cell:

| Write | Means |
|---|---|
| **yes** — or **x**, **✓**, a date, your initials | In the ERP |
| **no** | Take the mark off |
| *(blank)* | Leave it as it is |
| **again** — or **updated**, **re-entered** | Counted again after it went in, and put right in the ERP since (section 6) |

Change nothing else on the sheet. Save it — Excel format is fine. You can upload part of an aisle
and finish it later: the next download shows what is already marked.

## 5 — Upload the sheet back

1. **⬆ Upload a filled-in sheet…** and pick the file.
2. The message says how many lines were marked, how many taken off, how many were already marked,
   and how many were left blank.
3. The aisle's row moves on — *28 of 40*, then *all in the ERP*.

![](../../images/guide-erp-aisles-after.png)

*After the upload: the aisle reads all in the ERP.*

**Only aisles not fully uploaded** hides the aisles that are done.

## 6 — A line counted again after it went in

If a second or third count lands after a line went into the ERP, the ERP holds the old number. The
app shows it: **N changed since** on the aisle's row, and **was …** in *Changed since uploaded* on
the sheet.

1. Download the aisle again and find the lines with *Changed since uploaded*.
2. Correct them in the ERP to the new **Counted quantity** / **Adjustment**.
3. Write **again** in their *Uploaded to ERP* cell and upload. They are no longer *changed*.

A plain *yes* on a line that is already marked does not clear *changed* — on purpose, so an old
sheet uploaded twice cannot hide a change.

## 7 — When something is not right

| You see | What it means | What to do |
|---|---|---|
| *the file has no "In ERP" or "Uploaded to ERP" column* | Not the app's sheet, or the column was renamed or deleted | Download the aisle again and fill in that column |
| *Not on this count, ignored: …* | The sheet is from another count | Check the count picked at the top |
| An aisle stays at *12 of 40* | Only those lines had *yes* | Fill in the rest and upload again |
| **N changed since** | Counted again after it went in | Section 6 |
| *Still being counted* will not clear | A second or third count is open, or a bin was never counted | Ask the floor supervisor to finish the aisle |
| The card is not on your dashboard | Your login does not have it | Ask an admin |
