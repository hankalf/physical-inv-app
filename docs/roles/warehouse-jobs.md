# SOP — Warehouse Jobs

**Role:** Warehouse jobs (front bins, moves, Not in Location, the cycle programme)  **Login profile:** *Warehouse jobs — front bins, Not in Location, cycle counts*  **Pages:** Front bins, Not in Location, Cycle counts, Testing Suite, User guide  **Functions:** Downloads and printouts

This procedure is for the day-to-day warehouse jobs the app carries between the big counts:
putting front pallets back where they belong, finding the pallets the system has lost, and
running the daily cycle count. It covers the office page for each and the matching job on the
scanner. The physical count itself is the count supervisor's and inventory control's.

## Contents

- [1 — The three jobs, and where they live](#1--the-three-jobs-and-where-they-live)
- [2 — Front bins: the list and the move list](#2--front-bins-the-list-and-the-move-list)
- [3 — Moving pallets: the desk, on the page and on the gun](#3--moving-pallets-the-desk-on-the-page-and-on-the-gun)
- [4 — Not in Location: the list](#4--not-in-location-the-list)
- [5 — Finding pallets: the desk, on the page and on the gun](#5--finding-pallets-the-desk-on-the-page-and-on-the-gun)
- [6 — The cycle programme, day to day](#6--the-cycle-programme-day-to-day)
- [7 — The pallet system under the desks](#7--the-pallet-system-under-the-desks)
- [8 — When something goes wrong](#8--when-something-goes-wrong)

## 1 — The three jobs, and where they live

| Job | Office page | On the scanner, at sign-on | Needs |
|---|---|---|---|
| Put front pallets back | **Front bins** | **Front2Back** | a move list, built or uploaded |
| Find the system's lost pallets | **Not in Location** | **Not in Location** | pallets on the list |
| Count a few bins a day | **Cycle counts** | **Cycle count** | the year's cycle session with a batch |

All three scanner jobs are **one person with a gun**: scan your clock-in number, no team
number, no count to pick. An admin can switch any of them off for the scanners under
*Settings → Scanners → Jobs on the scanners*; during a wall-to-wall they usually are.

## 2 — Front bins: the list and the move list

**Front bins → Front-placed bins** lists the bins on the aisle face of the racking, filtered
by zone, aisle or level, with a download. Which face a bin is on comes from the bin list's
description or the site drawing.

**Front bins → Pallets to move back** is the move list: every pallet the report puts in a
front bin with an **empty bin behind it**. Two ways to fill it:

- **Build** it from the newest count's report: the app pairs each front pallet with the empty
  bin behind, and leaves alone any front pallet with something behind it;
- **Upload** one: *Pallet, From bin, To bin*. A bin not on the count is refused, naming the
  row.

The list shows each move's state (open, moved, skipped with its reason), the summary by
aisle, and downloads as a CSV. A move that is done updates the report, so the next count
expects the pallet where it now is.

## 3 — Moving pallets: the desk, on the page and on the gun

The same desk in both places: the pallet, the bin it is in, the bin it goes to, **‹ ›** through
the list, and the **pallet system** framed underneath so the move is booked there and ticked
off here.

**On the page** (*Front bins → Move desk*): for whoever works from the pallet system rather
than the floor. **Mark moved** when it is booked; **Skip** with a reason. The frame is the size
of a Zebra's screen; **Full width** opens it out and the choice is kept on that computer.

**On the gun** (*Front2Back* at sign-on, badge only):

1. **Pick the aisle**; each shows how many pallets are waiting.
2. The desk opens on the first pallet: the pallet, **from** and **to**, **‹ ›** through the
   aisle, and the pallet system framed underneath. The gun shows the system's screen, never
   its address.
   Nothing is scanned in the app: the move is booked, and scanned, in that screen.
3. Move it, book it, tap **Moved — next**. When the aisle is finished the gun says so and goes
   back to the aisle list; **Aisles** goes back any time.
4. A pallet that cannot be moved is left with **›**; skip it from *Front bins → Pallets to move
   back* with the reason.
5. Ticks made in a dead spot queue on the gun and upload with signal.

A pallet on the **Not in Location** list that is scanned while moving is marked found on the
spot.

## 4 — Not in Location: the list

**Not in Location** is the site's list of pallets that are not where the ERP says. It is not
tied to a count; it carries over until a pallet turns up or is closed.

- **Upload** a list (CSV or Excel: *Pallet, Item, Description, Qty, Lot, Last known location,
  Note*) or **Add** one by hand. A re-upload keeps what it already knew and updates the rest.
- The app watches: **the moment any scanner scans one of these pallets**, on any count or
  move, it is marked **found** with the bin, the team or badge, the scanner and the time, and
  the counter is told on the gun.
- **Found in…** marks one found by hand; **Close** writes one off with what happened
  (written off, shipped, never existed); **Back on the list** reopens either.
- The **Missing / Found / Closed / All** views, the search box and **Download (CSV)** read
  the list; the summary tiles count it.

## 5 — Finding pallets: the desk, on the page and on the gun

**On the page** (*Not in Location → Find desk*, at the bottom): the next missing pallet, what
it is and where it was last seen, **‹ ›** through the list, the pallet system framed under it.
Type the bin and press **Found** when it turns up; **Close** writes one off. **Full width**
opens the frame out.

**On the gun** (*Not in Location* at sign-on, badge only), offered while the list has anything
on it:

1. **Pick the aisle** the pallets were last seen in; pallets with no known location are their
   own group.
2. The desk opens on the first pallet: the id, *last seen in* its bin, the description, item
   and quantity, **‹ ›** through the aisle, and the pallet system framed under it. Nothing is
   scanned in the app; the pallet is booked in that screen.
3. Found it: tap **Found — next**. The office is told at once: badge, scanner, time; the bin it
   is booked into is in the pallet system. **›** leaves one; **Aisles** goes back.
4. A find with no signal is kept on the gun and sent with the next signal.

## 6 — The cycle programme, day to day

**Cycle counts** runs on one session for the year. Each day:

1. **Today**: choose how many bins, which (*longest since counted*, *never counted*, a *random
   sample*), and optionally a zone, aisle, levels or face. **Preview**, then **Generate**. A
   schedule can do this for you each day or week.
2. Counters sign on to the gun with **Cycle count** and their badge alone, **Start counting
   the list**, count every pallet in each bin and press **Bin done — nothing more here**.
   Several people can share a batch; nobody is offered a bin somebody else has taken.
3. **Still open** shows bins from earlier batches nobody finished.
4. **Coverage** shows how much of the warehouse has been counted this period and what has
   not been touched, with **Coverage CSV** for the auditors.
5. **Front-placed bins** on the same page can be sent to the scanners as a batch of their
   own with **Count these — make a batch**.

Each batch is *the* count for its bins: variances, second counts and adjustments work as
on a full count, on the cycle session, for inventory control to read.

## 7 — The pallet system under the desks

Both desks frame the web address an admin sets under *Settings → Integrations → Pallet system*.
The office desks show the address and an **Open the pallet system in a new tab** link for a
system that refuses to be shown inside another page; the scanners never show the address or a
link, only the screen. With no address set the desks say so
and the strip still works. Scanners pick the address up when they are next online.

## 8 — When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| The gun does not offer Front2Back | No moves are waiting, or the job is unticked under Settings → Scanners → Jobs on the scanners | Build a move list; an admin ticks the job back on |
| The gun does not offer Not in Location | Nothing on the list, or the job is unticked | Add to the list; an admin ticks the job back on |
| A pallet on the gun's desk cannot be moved | The bin behind is not empty, or the pallet is not there | Leave it with ›; skip it with the reason from Front bins |
| No pallet system under the strip | No address set (the gun says so), or the system refuses to be framed | Settings → Integrations → Pallet system (admin). A system that refuses framing cannot appear on the gun; work it from the office desk's new-tab link |
| A move was done but the list still shows it open | The gun had no signal | It uploads with the next signal; Refresh on the gun pushes it |
| A found pallet is still on the list | Same | Same; the gun's Refresh sends it |
| Upload refused: *row N: bin is not on this count* | The move list names a bin the newest bin list does not have | Fix the row, or upload the bin list first |
| No batch can be made | No inventory report on the cycle session | An admin uploads it; the dates come from it |
| You do not know what a message means | — | Paste it into **User guide → Ask the guide** |
