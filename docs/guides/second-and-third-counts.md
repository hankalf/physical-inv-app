# How to — Second and third counts

**Role:** Supervisors and inventory control  **Login profile:** any login with the Dashboard and *Queue aisles, raise second counts* (Count supervisor, Supervisor, Admin); exports need *Downloads*  **Pages:** Dashboard → Second counts, Settings → Count setup, the scanner  **Functions:** raising, assigning and finishing second and third counts; the side-by-side export

A count is only as good as the numbers nobody checked. A **second count** sends a different team
back to a bin whose first count disagrees with the inventory report. A **third count** settles a
bin when the second count agrees with neither the first count nor the report. This guide covers
setting both up, doing them on the gun, reading the result, and exporting the 1st, 2nd and 3rd
counts side by side.

## Contents

- [1 — In one minute](#1--in-one-minute)
- [2 — Set it up on the count](#2--set-it-up-on-the-count)
- [3 — Where second counts come from](#3--where-second-counts-come-from)
- [4 — On the gun: doing a second or third count](#4--on-the-gun-doing-a-second-or-third-count)
- [5 — How a second count is judged](#5--how-a-second-count-is-judged)
- [6 — Third counts](#6--third-counts)
- [7 — On the dashboard: work them to zero](#7--on-the-dashboard-work-them-to-zero)
- [7a — One team for the second counts, and handing them on](#7a--one-team-for-the-second-counts-and-handing-them-on)
- [8 — Export the 2nd and 3rd counts with the 1st](#8--export-the-2nd-and-3rd-counts-with-the-1st)
- [9 — When something is not right](#9--when-something-is-not-right)

## 1 — In one minute

- A **second count** is a bin a team goes back to because its first count disagreed with the
  inventory report. It is **blind**: the team is told the bin and the kind of problem, never the
  numbers — and it is never the team that did the first count.
- The second count's numbers **replace** the first count for that bin on every report.
- If the second count agrees with **neither** the first count nor the report, nobody knows which is
  right. With **Third count** on, the bin goes back a **third** time, to a team that did neither,
  and the third count stands.
- **Dashboard → Second counts** lists every one; work the list to zero before the count is closed.
- **Export 2nd & 3rd counts with the 1st** puts every bin counted again on one Excel row per pallet:
  report, 1st, 2nd, 3rd, final.

## 2 — Set it up on the count

**Settings → Count setup → Count session → Second counts.** Do this before the count starts.

![](../images/guide-third-count-option.png)

*The Second counts settings on the count.*

| Setting | What it does | Usual |
|---|---|---|
| **Raise them automatically** | A second count is raised the moment a first count disagrees with the report, and when an aisle is handed back with a pallet nobody saw | On |
| **Third count when the second settles nothing** | A bin whose second count agrees with neither the first count nor the report is counted a third time, by a team that did neither | On for a wall-to-wall |
| **Over N units / or over N %** | A quantity difference smaller than both raises no second count. Either one is enough to raise it | 2–5 units, 5–10 % |
| **Cap open** | Stop raising automatic second counts once this many are open | 0 (no cap), or 50–100 on a big count |
| **Send them all to team** … | Every new second count is given to that team — inventory control's, say. A bin the team counted first stays open for any other team | On, with the team number, when one team does the second counts |

Press **Save settings**. A change applies from then on; it does not go back over lines already in.

> **Both thresholds at 0** sends somebody back for a one-unit difference on every pallet. On a
> wall-to-wall that is hundreds of bins; set them before count day.

## 3 — Where second counts come from

1. **Automatically, as counts land** (with *Raise them automatically* on). A pallet raises one when:
   - its **quantity differs** from the report (over the thresholds);
   - it is in a **different bin** from the report's — the bin it was found in comes back, and so does
     the report's own bin once that bin has been counted (*check for a pallet with a duplicate label*);
   - it is **not on the report**;
   - it was **counted in two bins**;
   - its aisle was **handed back** and the pallet was never seen (*expected pallet not found here*).
2. **Raise from all variances now** (Dashboard → Second counts) goes through everything that
   disagrees right now. It leaves alone pallets in aisles nobody has counted yet — mid-count they
   are not missing, just not reached — and says how many it skipped and why.
3. **By hand.** Dashboard → Second counts: type a **Bin** (or a **Pallet ID** — its bin is found for
   you), a **Note** if you like, optionally a **Team**, and press **Request second count**.

A bin has one open second count at a time; asking again says so.

## 4 — On the gun: doing a second or third count

| | | |
|:--:|:--:|:--:|
| ![](../images/guide-gun-recounts-available.png)<br>**My aisle** says *Second counts available*, with how many | ![](../images/guide-gun-third-count.png)<br>**THIRD COUNT · bin …** — the bin and the reason, never the numbers | |

1. Signed on to the full count, the **My aisle** screen shows **Second counts available**. Tap
   **Start second counts**.
2. The gun takes the **nearest** first: the aisle the team is in, then its racking block, then the
   aisles nearest by number. The banner says **SECOND COUNT · bin F04A012** (or **THIRD COUNT**)
   and the reason.
3. Go to that bin and **scan every pallet in it** as normal: pallet, quantity, bin. Count everything
   in the bin, not only the pallet named — the whole bin is counted again.
4. A bin with nothing in it: **Bin is EMPTY**.
5. When the bin is finished, tap **Bin done — nothing more here**. The gun moves to the next one.
6. **My aisle** goes back to the team's own aisle at any time; the second counts wait.

No signal? The lines and the *Bin done* queue on the gun and go when it has signal. The server
judges the bin when they arrive.

## 5 — How a second count is judged

When a bin's second count is in, its numbers **replace the first count** for that bin on every
report. What happens next depends on what the second count agrees with:

| The second count agrees with… | It means | What happens |
|---|---|---|
| **the first count** | The difference is real: two teams found the same thing | Settled. The line goes to **Adjustments** as counted |
| **the report** | The first count was wrong | Settled. The line now matches; nothing to adjust |
| **neither** | Nobody knows which number is right | With **Third count** on, the bin goes back a third time. Without it, the second count stands — raise a third by hand if it matters |

*Agrees* means the same pallets in the bin with the same quantities.

## 6 — Third counts

**Automatic** (with *Third count when the second settles nothing* ticked): when a second count
agrees with neither, a third count of the same bin is raised at once —

- offered only to a team that did **neither** the first nor the second count;
- shown on the gun as **THIRD COUNT · bin …**, counted exactly like a second count;
- its numbers **stand over both** earlier counts on every report.

**By hand**, option or not: on Dashboard → Second counts, a finished second count that has no third
count has a **3rd count** button. It is raised for a third team the same way.

**Giving it to a team.** Type a team in its **Team** box and press Enter. A third count you hand to
a team is theirs — you have made the call. One left open is offered only to a team that did
neither count. With only two teams on the count, hand it to one by name.

![](../images/guide-dashboard-third-count.png)

*Dashboard → Second counts: a third count is marked **3rd count**, with both earlier teams (1st · 2nd), and the **3rd count** column shows what it found. The finished second count above it no longer has a 3rd count button: it has one.*

## 7 — On the dashboard: work them to zero

**Dashboard → Second counts** has every task. The tab shows how many are open from anywhere on the
dashboard. The same tab is under **Inventory Control** in the sidebar, beside Adjustments and
Reports, with an **Overview** in front — how many are still open, and whether the final report
can be filed yet.

| Column | What it is |
|---|---|
| Bin, Pallet | Where to go back to, and the pallet that raised it |
| Reason | Why — *3rd count · …* for a third count |
| Detail | The numbers, for the supervisor only: *expected 40, first count 33* |
| Source | *auto* or *manual* |
| 1st team | Who did the first count (and, on a third count, who did the second) |
| Team | Who has it, or blank for any team allowed. Type a team and press Enter to assign |
| Status | *open*, *taken* (a gun has started it), *done* |
| 1st count, 2nd count, 3rd count | What each count found in the bin |

Buttons on each row: **done** (close it — the bin was in fact counted), **reopen** (back to any
team), **3rd count** (on a finished second count), **✕** (delete).

**Before you close the count:** nothing open. A count closed with open second or third counts has
known-wrong numbers in it, and **Final report** is not offered while one is open.

## 7a — One team for the second counts, and handing them on

When one team does all the second counts — inventory control's, say:

1. **Settings → Count setup → Count session → Second counts**: tick **Send them all to team** and
   type the team number (*90*). **Save settings**.
2. Every new second count is given to that team, and the open ones nobody had yet go to it at once.
   Its guns have them all; the other teams' guns are offered none.
3. The Second counts card says **new second counts go to team 90**.

It stays blind. A bin team 90 counted **first** is never its own second count: that one stays open
for any other team. A **third count** goes to team 90 only if it did neither earlier count.

**When the team is swamped**, use the bar above the table:

| | |
|---|---|
| **Hand open second counts from** | The team that has them (*team 90 — 24 open*), or *any team* |
| **to team** | The team to give them to; blank is back to *any team* |
| **How many** | Blank for all of them, or a number |
| **In aisle** | Only that aisle's |

**Hand them over** moves them, nearest bins first, and says how many moved. A bin a team has
**already started** stays with it. A bin the receiving team **counted first** stays where it is, and
the message names it. The **Team** box on each row still moves one at a time. Every hand-over is in
the log.

**Untick** *Send them all to team* and new second counts are for any team again; the ones already
handed out stay where they are (hand them back to *any team* with the bar if you want).

## 8 — Export the 2nd and 3rd counts with the 1st

**Dashboard → Second counts → ⬇ Export 2nd & 3rd counts with the 1st (Excel).**

1. Leave **Aisle** blank for every aisle, or type one (*F04*) for that aisle alone.
2. Press the button. An Excel workbook downloads: *Summary* and *Side by side*.

![](../images/guide-export-second-third.png)

*The Side by side sheet (some of its columns): every bin counted again, a row a pallet, and which number stands.*

**Side by side** — one row per pallet in each bin that was counted again:

| Column | What it is |
|---|---|
| Aisle, Bin, Pallet, Item, Description | The line |
| Why it was counted again | The reason(s); *Third count: …* for a third |
| Report bin, Report quantity | What the inventory report said |
| 1st count, 1st count team | The first count of that pallet in this bin, and who did it |
| 2nd count, 2nd count team | The same for the second count (blank if not done yet) |
| 3rd count, 3rd count team | The same for the third count |
| Final count, Final count is the | The number that stands, and which count it is |
| Final vs report | The final count less the report |
| Which number stands | *The second count agrees with the first*, *…with the report*, *The third count stands*, or *Waiting for…* |
| State | *Open*, *Being counted* or *Done* |

A 0 in a count column means that count was done and the pallet was not there; a blank means that
count has not been done.

**Summary** — how many bins were counted again, how many had a third count, how many are still
being counted, and how each was settled.

The same sheet is in **Dashboard → Reports → Export everything** as *Counts side by side*. The
pallet report also keeps the earlier counts: *first count qty*, and *second count qty* when a
third count stands.

## 9 — When something is not right

| You see | What it means | What to do |
|---|---|---|
| No second counts at all | No inventory report, or *Raise them automatically* is off | Upload the report (Settings → Count setup); tick it, or press **Raise from all variances now** |
| Hundreds of second counts | The thresholds are at 0 | Set *Over N units / %* and a *Cap* (section 2) |
| A second count agreed with neither, and no third count came | *Third count* is off on this count, or its lines have not reached the server yet | Tick the option, or press **3rd count** on the row |
| A third count nobody can take | Every team on the count did one of the first two counts | Type a team in its **Team** box: a third count you assign is theirs |
| A task sits at *taken* for a long time | A gun started it and never pressed Bin done | Ask the team. **reopen** puts it back for anyone; **done** if the bin was in fact counted |
| The gun says *This second count is for bin …* | The bin scanned is not the one the task is for | Scan the bin in the banner, or tap **Bin done** if it is finished |
| *a third team must do the third count* | That team did the first or the second count | Another team takes it — or a supervisor assigns it by name |
| Final report is not offered | A second or third count is still open | Finish or delete it |

**Practise first.** *Testing Suite → What to practice → Second counts* sets up another crew's
aisle on your own practice count, with bins that come back to your gun and one to raise by hand.
