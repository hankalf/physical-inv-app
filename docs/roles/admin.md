# SOP — Admin

**Role:** Admin (the site's owner of the app)  **Login profile:** *Admin — everything, Settings included*  **Pages:** every page, Settings included  **Functions:** all

This procedure is for the one or two people who own the app at the site: who set it up, keep
it running, make the logins, and are called when nothing else works. It is the only role that
opens **Settings**. The counting itself, the floor and the numbers are other roles' procedures;
this one is about everything those roles need to be in place.

## Contents

- [1 — What only an admin can do](#1--what-only-an-admin-can-do)
- [2 — Deploying and keeping the server](#2--deploying-and-keeping-the-server)
- [3 — Logins and profiles](#3--logins-and-profiles)
- [4 — The site: name, logo, look, Teams, pallet system](#4--the-site-name-logo-look-teams-pallet-system)
- [5 — Scanners](#5--scanners)
- [6 — Lists, racking and the inventory report](#6--lists-racking-and-the-inventory-report)
- [7 — The count session and its settings](#7--the-count-session-and-its-settings)
- [8 — Count day: what the admin does](#8--count-day-what-the-admin-does)
- [9 — Closing, the ERP file, backups and the log](#9--closing-the-erp-file-backups-and-the-log)
- [10 — A year of housekeeping](#10--a-year-of-housekeeping)
- [11 — When something goes wrong](#11--when-something-goes-wrong)

## 1 — What only an admin can do

Everything on the **Settings** page, which no other profile opens. It has six sections:
**Count setup** (the count-day check, the setup checklist, the count session), **Lists & racking**,
**Scanners**, **Integrations** (ERP file, adjustment reasons, pallet system, Teams), **Backups & log**
(with the OneDrive copy) and **Logins & site**. From there you:

- create, rename and delete **supervisor logins**, choose what each may do, **invite** a new one by
  email, and lift a **sign-in lock**;
- the **site name**, the **logo**, the **Teams channel**, the **pallet system** address;
- register and reset **scanners**; choose which **jobs** the scanners offer;
- upload the **bin list**, pair the **racking blocks**, upload the **inventory report**;
- create the **count session**, set its options and thresholds, run and end a **trial**,
  **close** and **delete** counts;
- the **ERP layouts** and the ERP file; **backups** and the **OneDrive** copy; the **adjustment reasons**; **the log**;
- run the **Ready for count day** check before every wall-to-wall.

A *supervisor* login does everything else. Keep the admin logins to the few who need them: an
admin can delete a count.

## 2 — Deploying and keeping the server

- The app runs from one Docker image on **Railway** (or on a PC in the warehouse with
  `docker compose`). The manual's Step 1 and 2 have the exact steps; the short version:
  attach a **volume**, point `DB_PATH` at it, set `SUPERADMIN_USER`, `SUPERADMIN_NAME` and
  `SUPERADMIN_PASSWORD`, and `SITE_TIMEZONE`.
- The **superadmin** is made from those variables the first time the app starts. If every
  admin login is ever lost, set `SUPERADMIN_USER` to a new name and restart: a fresh admin
  appears.
- A **domain of your own** goes on under Railway → the service → Settings → Networking →
  Custom Domain; a subdomain takes a CNAME, the bare name needs a DNS host with CNAME
  flattening. After the change, re-open each scanner's link on the new address: an
  installed app is tied to the address it came from.
- One instance carries the site: the load test put twenty teams and twenty thousand bins
  through it with the dashboard under a second a refresh. Scale the instance up before
  thinking about more of them; the database is on the instance's volume.
- The **bare address** opens the supervisor sign-in. Scanners open their own links.

## 3 — Logins and profiles

**Settings → Logins & site → Supervisor logins.**

1. **Add a login**: username, full name and, best, their **email** — then **Email the invite**
   sends them a one-time link (good for three days) on which they choose their own password,
   from your own mail, with no password in the message. Without an email, a starter password
   (typed, or generated if left blank) is shown once; the first sign-in makes them replace it.
   **Invite again** makes a new link; the old one stops working.
2. Pick a **profile**, or tick pages and functions by hand:

| Profile | Pages | Functions | For |
|---|---|---|---|
| Admin | everything, Settings included | all | you |
| Supervisor | everything but Settings | all | a senior supervisor |
| Inventory control | Dashboard, Testing Suite | approve adjustments, downloads | the inventory controller |
| Count supervisor | Dashboard, Teams & crew, Testing Suite | message the floor, answer SOS, queue aisles and raise second counts, downloads | whoever runs the floor |
| Warehouse jobs | Front bins, Not in Location, Cycle counts, Testing Suite | downloads | the day-to-day warehouse jobs |
| Cycle counter | Cycle counts, Testing Suite | — | a cycle counter at a desk |
| Custom | ticked by hand, down to a tab | ticked by hand | anything else |

   The **User guide** is open to every login whatever else it has.
3. Each login's **picker** shows only the kinds of count it may work: no *Cycle counts* page,
   no cycle counts in it; a cycle counter sees no full count.
4. Nobody but **the site admin** (the login the site started with) can change the site admin's
   account: another admin cannot reset its password, take its pages or switch it off.
5. A login's **tabs** can be narrower than its pages: *Dashboard → Progress and Reports*
   only, say. The checklist under each login shows every tab.
6. **Untick Active** to stop a login; its sign-ins end at once. **Reset password** gives a
   new starter password. Changing either ends every sign-in that login holds.
7. **Locked out?** Five wrong passwords from one place lock that login there for 15 minutes
   (twenty from one place lock the place). The row shows *locked*; **Unlock** lifts it, and so
   does a password reset.
8. Sign-ins last 30 days from last use and survive a restart. **Log out** ends one, and the next
   person to sign in on that computer starts fresh on the dashboard, not where the last one left off.

Each role has a procedure of its own in `docs/roles/`; hand a new login the right one.

## 4 — The site: name, logo, look, Teams, pallet system

Site name, logo and look under **Settings → Logins & site**; Teams and the pallet system under
**Settings → Integrations**. On a phone, *Add to Home Screen* on any office page installs the
office side as its own app (*FH Office*), with a Menu button in place of the side panel.

- **Site name**: the app's name and the location under it. A change lands at once on every
  sidebar, the sign-in screen, the window titles, the scanner app's header, the office board
  and the installed app's manifest. Blank name = back to *Full Harvest Inventory*.
- **Logo**: PNG, JPEG, WebP, GIF or SVG under about 400 KB; across the top of the sidebar,
  and on the scanners if ticked.
- **Appearance**: themes, accents, text size, density, corners, sidebar width, contrast.
  Per computer, not per login.
- **Microsoft Teams channel**: a Workflows webhook address. SOS and stopped-scanning
  alerts post a card there as well as on the dashboard. **Send a test card** before count
  day; Microsoft is retiring the old *Incoming Webhook* connectors.
- **Pallet system**: the web address of the system the pallets live in. It is framed under the
  move desk on the Front bins page and on the gun's Front2Back screen. A system that
  refuses to be framed gets an *Open in a new tab* link instead.

## 5 — Scanners

**Settings → Scanners.**

- **Scanner setup**: add a scanner by name; open its link (`/?d=…`) on the device once,
  then install the app from Chrome's menu or the button on the sign-on screen. The link
  is a key: **Reset link** issues a new one and kills the old; removing a scanner stops it.
  **Print setup cards** gives one QR card per scanner for the cradles. A link used more than
  once is flagged, which is normal after a wipe and worth a look otherwise.
- **Jobs on the sign-on screen** (in *What the scanners offer*): the scanners show exactly
  what is ticked: full count, cycle count, Front2Back, Not in Location (NIL). Day to day tick
  the last three; on the morning of a wall-to-wall untick them and tick the full count alone;
  swap back after. At least one stays on. The practice gun has its own ticks in the Testing
  Suite's sandbox, all four to start with.
- **Your picker sees everything.** An admin's count picker lists every count on the site,
  other people's practice counts from the Testing Suite included, tagged *practice · NAME*.
- **How the counting screen is put together**: the order of the questions (pallet, quantity,
  lot, expiry, bin, comments), text size, language, the Keyboard button, *Keep it upright*,
  *Update itself after a deploy*, *Show the next bin in the aisle*. The preview is the real
  screen size.
- **What the scanners offer**: one section with one Save: the jobs, the comments (ask or
  not, required or not, the wait before the step moves on, the one-tap reasons), the override
  reasons and the SOS list.
- **DataWedge** on each Zebra sends ENTER (or TAB) after a scan; without it a scan does
  nothing. The manual's DataWedge section has the profile.

Settings reach a running gun within about half a minute, between pallets. A new version of
the app needs a reload: with *Update itself after a deploy* on it does that by itself.

## 6 — Lists, racking and the inventory report

**Settings → Lists & racking.**

1. **Bin list**: one column of bin codes, or the site's own export, uploaded by you — no bin
   list ships with the app, so a new installation starts empty. The aisles come from it.
2. **Aisles & racking blocks**: pair the aisles that share a rack. The guided setup marks
   blocks as wanted; without them two teams can meet on one rack.
3. **Inventory report**: the site's export as it comes, one upload per system, naming the
   **System**. Read the upload summary: merged rows, duplicates, open bins, zero and
   negative quantities. Hand it to inventory control; it is theirs to accept. *Replace what
   is there* re-uploads a fresh report over the old.

Both uploads are per count. The guided setup card says what the count still lacks.

## 7 — The count session and its settings

**Settings → Count setup → Count session.**

- **New count**: from **Full Counts → New count** (a full count) or *Cycle counts → Program*
  (the year's cycle session); the Count session card does both too. **Full Counts** also lists
  every wall-to-wall with its progress, **Scanners land here**, **Close** / **Reopen**, and a
  **Set-up** tab for what a count still needs.
- **Options**: pallet check (*off*, *warn*, *strict*), guided bins, comments, the **map
  drawing**, auto second counts with **Recount over N units / or over N %** and a **cap**,
  **Adjustments need approval** with its own threshold, **Show on the scanners**, and the
  **default** count the guns land on.
- **Trial run**: counts for real on the dashboard, exports nothing to the ERP; **End the
  trial** wipes it so the real count starts from zero on the same setup.
- **Counting plan**: on Teams & crew. The count supervisor usually owns it.
- **Close session** when inventory control says so. **Delete** is separate, needs the count
  closed and its name typed, and takes a backup first.

Agree the thresholds and the approval setting with inventory control before the count
starts. Their procedure says what they will ask for.

## 8 — Count day: what the admin does

**The afternoon before, and first thing:** open **Settings → Count setup → Ready for count day**
and clear every red line, and every amber one you can. It checks the jobs on the scanners (the
full count alone), the scanners, the crew list, the alerts, the backups and the OneDrive copy,
and a default password. Each line's button opens the card that fixes it.

Then, usually little. Be reachable for:

- a scanner that needs its link reset or re-registered;
- a setting that turns out wrong: thresholds at 0 flooding the second-count list, approvals
  that should have been on, a job that should be hidden on the guns;
- a login that needs a function it was not given;
- the Teams channel, if cards stop arriving.

The count supervisor runs the floor; inventory control reads the numbers. Both procedures
say when they will come to you.

## 9 — Closing, the ERP file, backups and the log

**Settings → Integrations** (the ERP file, adjustment reasons) and **Settings → Backups & log**.

- **Send to the ERP**: pick the layout and the system, **Preview**, **Download CSV**. The
  preview says how many adjustments it held back for approval; inventory control reads it
  with you. A trial refuses to export.
- **Adjustment reasons**: the list inventory control picks from when approving; match it to
  the ERP's own codes.
- **ERP layouts**: column names and which rows go in; add a layout rather than editing a
  file afterwards.
- **Filed as the count goes** (Dashboard → Reports) writes every handed-back aisle to an
  `exports` folder beside the backups, and the **final report** every sheet of Export everything
  once the count is whole. Copy that folder off the server with the backup.
- **Back up now** before and after anything large; the app also keeps a daily backup and the
  last fourteen on its volume. A volume is not an archive: connect **Off-site copy: OneDrive**
  once (the steps are on the card) and every backup is copied there too — with each daily
  backup, or every 12, 6, 2 hours or every hour during a count. Without it, **Download** one
  after every count.
- **Export the log** for an auditor: every supervisor action, who and when.

## 10 — A year of housekeeping

- After each count: close it, export everything with inventory control, download a backup.
- Each quarter: review the logins (leavers off, profiles still right), the SOS reasons and
  the adjustment reasons, the Teams channel with a test card.
- Before each wall-to-wall: a trial run with the crew, the bin list refreshed, the scanners
  charged and up to date, *Jobs on the scanners* set to the full count alone.
- The cycle-count session runs all year; do not replace it.
- Keep `docs/SOP.pdf` and the role procedures where the supervisors can find them, and the
  **User guide** in the sidebar is the same text inside the app.

## 11 — When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Nobody can sign in | The admin logins were lost | Set `SUPERADMIN_USER` to a new name in the server variables and restart |
| Everyone was signed out | A normal restart does not do this; a lost database volume does | Check the volume on the host |
| Gun: *this scanner is no longer authorised* | Its link was reset or it was removed | Reset link, open the new link on it |
| Gun: *this scanner link is not registered* | A link that was never created here, or the server was reset | Add the scanner again |
| A scan does nothing on a handheld | DataWedge is not sending ENTER | DataWedge → Basic data formatting → send ENTER |
| An SOS did not reach Teams | Address wrong, expired, or Teams down | The dashboard still has it; send a test card; make a Workflows webhook |
| A pallet system will not show under the move desk | It refuses to be framed | Nothing to fix: the desk offers Open in a new tab |
| The second-count list is enormous | Thresholds at 0 | Count session → Recount over, or over %, and a cap |
| A gun does not offer a job | It is unticked under Jobs on the scanners | Tick it back on |
| The app still shows the old name somewhere | A scanner or the board has not refreshed | They pick it up on their next refresh; an installed icon's name updates on reinstall |
| A count was deleted by mistake | A backup was taken before the delete | Restore it under Backups & log |
| You do not know what a message means | — | Paste it into **User guide → Ask the guide** |
