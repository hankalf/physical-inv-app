# SOP — Count Supervisor

**Role:** Count supervisor (runs the floor)  **Login profile:** *Count supervisor — runs the floor*  **Pages:** Dashboard, Teams & crew, Testing Suite, User guide  **Functions:** Message the floor; Answer an SOS, quiet a stopped-scanning alert; Queue aisles, raise second counts, the board note; Downloads and printouts

This procedure is for the supervisor who runs the teams on count day: who gives out the
aisles, watches the pace, answers the gun when it calls, and hands a finished floor to
inventory control. It covers what the *Count supervisor* login can do. Creating the count and
its settings is the admin's or supervisor's procedure; signing off the numbers is inventory
control's.

## Contents

- [1 — The day before](#1--the-day-before)
- [2 — Teams, crew and the counting plan](#2--teams-crew-and-the-counting-plan)
- [3 — Start of shift](#3--start-of-shift)
- [4 — Watching the count](#4--watching-the-count)
- [5 — Answering the gun: SOS, stopped scanning, messages](#5--answering-the-gun-sos-stopped-scanning-messages)
- [6 — The fix list and the floor](#6--the-fix-list-and-the-floor)
- [7 — Second counts](#7--second-counts)
- [8 — Handing over](#8--handing-over)
- [9 — When something goes wrong](#9--when-something-goes-wrong)

## 1 — The day before

1. Open the **Dashboard** and pick the count in the header. If it is not there, it has not
   been created: ask the admin (*Settings → Getting started → Count session*).
2. Check **Settings → Getting started → Guided setup** with the admin, or ask them to: it
   lists what the count still needs, worked out from the data. Red is required, amber is
   wanted. You need at least the **bin list**, the **scanners** and a **counting plan**; the
   **inventory report** is what makes second counts and variances possible; **racking
   blocks** keep two teams off one rack.
3. Walk the scanners: each one opened from its own link once, installed on the home screen,
   charged, and the grey line on its sign-on screen saying it is up to date. A gun that
   says *Offline and no list cached for this session* has never downloaded this count:
   carry it into Wi-Fi and sign on once.
4. Spend twenty minutes on the **Testing Suite** with anyone new: it is the real gun on a
   practice count, with a sheet of things to try. *What to practise* also sets up a cycle
   count, a pallet move and a Not in Location run.
5. Print the **count sheet** for one aisle (Dashboard → Reports) and keep it in the office: it
   is the fallback if a scanner dies.

## 2 — Teams, crew and the counting plan

**Teams & crew → Crew & teams.**

- **Crew**: every counter with their clock-in number, name, department and shift. A gun
  refuses a clock-in number that is not on this list unless the count allows walk-ups. The
  list uploads from a file or is typed; **Employees CSV** downloads it.
- **Teams**: a number, a shift (1 or 2; *day*, *am*, *first* read as 1, *night*, *pm*,
  *second* as 2) and the people on it. Two people with one gun is the usual team; a team of
  one is fine.
- **Equipment rules** (the other tab): which levels need which equipment. A team without a
  reach truck is not given levels D to F; the rules are enforced when aisles are queued.

**The counting plan** (the card on the same page, or Dashboard → Team plan):

1. Give each team its aisles in the order it will count them, with the levels where a team
   only takes part of an aisle (`A-C`). A file with *Team, Aisle, Levels* uploads the whole
   plan at once.
2. **Stagger** spreads the plan so no two teams start side by side on one racking block.
3. Aisles that share a rack are one **block**: a team that holds one side holds both. The gun
   says *Team N is counting aisle X* to anybody else; that is the block working.
4. The gun hands out the **next aisle** by itself when a team hands one back. You do not have
   to be at the desk for a team to keep moving.

## 3 — Start of shift

1. Sign-on, on each gun: pick the count, type the **team number**, scan every **clock-in
   number** on the crew, press **Sign on & load list**. The gun downloads the lists once and
   works with or without signal from then on.
2. Watch **Dashboard → Team plan** fill: each team appears with its scanner, its people and
   its first aisle the moment it signs on. A team that is not there has not signed on.
3. Put the **office board** (`/board`) on the TV. It needs no login and shows progress,
   teams and alerts; pin it to this count with `?session=<id>` if more than one count is
   open. A note typed on the Dashboard shows on it.
4. Say the three rules once: **scan, do not type** (type only when a label will not scan,
   and the gun will ask); **a bin with nothing in it is scanned as EMPTY, never skipped**;
   **SOS is for a stopped team, not a question**.

## 4 — Watching the count

Refresh is automatic; the panes you have open refresh every few seconds.

- **Progress**: bins counted, lines, pace, time left at this pace. Compare the pace to the
  plan at the first hour and the half-way mark; the load test puts twenty teams through
  twenty thousand bins in six hours, so a shift well below that is a floor problem, not an
  app problem.
- **Map**: each aisle coloured as it is counted. Click an aisle for its bins. A map that is a
  schematic rather than the site drawing means no drawing on this count; ask the admin.
- **Team plan**: where each team is, how long since its last scan, which aisles it has
  queued and handed back. **Reassign** moves an aisle; **Hand back** frees one a team has
  left. A team that has stopped shows as such after the idle limit.
- **Alerts**: every SOS and stopped-scanning alert, newest first, with the badge on the tab.
- **Reports → Fix list**: what the floor is finding that somebody has to put right. Walk it
  during the count, while the team is still nearby.

What the gun will not let a team do: count an aisle another team holds (unless the count
allows it), count a bin that is not on the list without flagging it, or post a quantity it
thinks is absurd without typing it twice.

## 5 — Answering the gun: SOS, stopped scanning, messages

**SOS** (Dashboard → Alerts). A counter pressed SOS and picked a reason: equipment breakdown,
need a supervisor, blocked, damage, someone trapped, or one of the site's own. Press **Seen**
first, before you move: the gun tells the counter help is coming. **Close** it when it is
dealt with, with the outcome. With a Teams channel set the same card lands in Teams; without
one the Dashboard and the board are the whole alarm.

A counter who says they pressed SOS and nothing happened had no signal: the gun told them
*No signal — this has NOT been sent* and sends it the moment it has signal. Ten metres
usually fixes it.

**Stopped scanning.** A team with no line for longer than the limit raises an alert. A dead
spot queues lines on the gun and uploads them later, so a quiet gun is not always a stopped
team: **Message** them first, then go and look. **Quiet** the alert with a word on why.

**Messages** (Team plan → Message, or to every team). It shows on the gun between pallets
with a *Got it* button. **Read by** lists which scanners tapped it; a scanner that is offline
gets it on its next sync. Use it for *"hand back F07 and go to F12"* and *"break at 10"*,
not for anything that needs an answer.

## 6 — The fix list and the floor

**Dashboard → Reports → Fix list** is the walk-round list, and it is yours during the count:

- **Labels that would not scan**: a pallet label (the pallet was counted under the bin's
  name, `NO-LABEL-F01A001-1`) or a rack label (every counter after walks up to that bin).
  Rack labels first.
- **Damage**: from the gun's *Report a problem*, with a reason and a note.
- **Blocked bins**: a trailer or a forklift in the way; the team said it would come back.
  Make sure somebody does.

**Fixed** ticks one off with a word on what was done. **Still open** is the list to carry. It
downloads as a CSV, and *Labels only* is the relabel list for whoever carries the printer.

## 7 — Second counts

**Dashboard → Second counts.** A second count is a bin somebody walks back to. They are raised
by the thresholds when a line disagrees with the report, and by you.

- **Request second count** on a bin you want looked at again.
- **Raise from all variances now** goes through everything that disagrees; it skips aisles
  nobody has reached and says how many.
- The gun offers them **nearest first**: the team's own aisle, then its block, then the
  nearest aisles by number, and it prefers to give a bin to a team that did not count it the
  first time. A team taps **Start second counts** on its assignment screen.
- The counter sees the bin and the reason type, never the numbers and never who counted it
  first.

Keep the list moving while teams are still on the floor. Inventory control will not close a
count with open second counts; a list that is hundreds deep means the thresholds are at 0 or
too tight, and the time to say so is the first hour, not the last.

## 8 — Handing over

The floor is finished when:

- every aisle on the plan has been **handed back** (Team plan);
- **Progress** shows every bin with a count, or the bins without one are known and written
  down;
- **Second counts** shows nothing open, or what is open is agreed with inventory control;
- the **Fix list** has been walked, and what is still open is handed to whoever owns it;
- every team has **signed off** on its gun, and the guns are back on charge with signal, so
  nothing is left queued on a device.

Tell inventory control the floor is done. They read the reports, approve the adjustments and
say when the count can be **closed**; closing is a Settings action for the admin or
supervisor. Do not create the next count on top of this one; a closed count stays readable.

## 9 — When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Gun: *this scanner is no longer authorised* | Its link was reset or it was removed | The admin resets its link under Settings → Scanner screen; open the new link on it |
| Gun: *Offline and no list cached for this session* | Never downloaded this count | Into Wi-Fi once, sign on again |
| Gun shows OFFLINE with a number | Lines queued in a dead spot | Nothing. They upload with signal. Never wipe or reinstall |
| Gun: *Team N is counting aisle X* | That racking block is held | Wait, or have the other team hand back |
| A scan does nothing | DataWedge is not sending ENTER | DataWedge → Basic data formatting → send ENTER |
| A keypad covers the screen | The Keyboard button was left on | Tap Keyboard again |
| A team never got a message | Their gun has not synced | *Read by* shows who has; an offline gun gets it next sync |
| The map is a schematic | No rack drawing on this count | Admin: Count session → Map drawing |
| A change to the scanner screen has not reached a gun | It lands between pallets, within about half a minute | Wait for the pallet to finish; a new app version needs the green *Update ready* bar tapped |
| Nobody can sign in to the Dashboard | — | The admin's problem; the guns keep counting offline meanwhile |
| You do not know what a message means | — | Paste it into **User guide → Ask the guide** |
