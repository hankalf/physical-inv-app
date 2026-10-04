/* What the user guide knows.

   Plain data, kept apart from the page that shows it so a supervisor can read
   and correct it without touching code. Three things live here:

   - journeys: the jobs a new user does, in the order they do them, each step
     with the trouble it tends to run into ("watch") and the questions people
     ask at that point ("ask");
   - errors: what the screen can say, what it means, what to do - the gun's
     messages, the server's refusals and the SOP's troubleshooting table;
   - questions: the general ones that belong to no single step.

   Every "goto" is a page and a sub-tab the sidebar knows; the guide only shows
   the link when this login may open that page. */
(() => {
  'use strict';

  const S = (page, sub, label) => ({ page, sub, label });

  const journeys = [
    {
      key: 'first', title: 'Your first day', who: 'Any new supervisor login',
      blurb: 'Where things are, how to get around, and where to practise before a real count.',
      steps: [
        {
          title: 'Sign in and set your own password',
          do: 'Use the username and starter password an admin gave you. The first sign-in stops at a panel that asks for a real password: pick one you will remember, you will not be asked again on this browser until you log out.',
          where: S('/admin', '', 'Dashboard'),
          watch: [
            { see: '"that username and password do not match"', means: 'The username is typed differently from how it was created, or the starter password has already been changed.', fix: 'Usernames are not case-sensitive, passwords are. Ask an admin to set a new starter password under Settings → Advanced → Supervisor logins.' },
            { see: 'Nothing here for this login', means: 'The login exists but has been given no pages.', fix: 'An admin ticks the pages for it under Settings → Advanced → Supervisor logins, or picks a profile such as Inventory control.' },
          ],
          ask: [
            { q: 'Do I need to sign in on every page?', a: 'No. One sign-in covers every supervisor page in this browser, and it survives a server restart for 30 days of use. Log out to end it.' },
            { q: 'Can two people share a login?', a: 'They can, but the log then cannot say who did what. Every supervisor gets their own login, it takes an admin a minute.' },
          ],
        },
        {
          title: 'Learn the sidebar',
          do: 'The pages sit in four groups: Counting (Dashboard, Full Counts, Cycle counts), Warehouse jobs (Front bins, Not in Location), The site (Teams & crew, Settings) and Learn (Testing Suite, this guide). Click a page and its sections open out under it. You only see the pages your login may open, and the count picker at the top only the kinds of count you may work.',
          where: S('/admin', 'progress', 'Dashboard → Progress'),
          watch: [
            { see: 'A page is missing from my sidebar', means: 'Your login was not given it.', fix: 'That is deliberate, not a fault. Ask an admin if you need it.' },
          ],
          ask: [
            { q: 'Where is the Count session card?', a: 'Under Settings → Getting started. The list of full counts, with Open on the dashboard, Close and Scanners land here, is the Full Counts page.', goto: S('/full', 'counts', 'Full Counts') },
            { q: 'Why is a count missing from the picker?', a: 'The picker shows only the kinds of count your login may work: no Cycle counts page, no cycle counts in the picker; a cycle-counter login sees no full count.' },
            { q: 'What is the office board?', a: 'A read-only page at /board for the office TV: progress, teams, alerts and notes. It needs no login.', goto: S('/board', '', 'Open the board') },
          ],
        },
        {
          title: 'Use the search box when you cannot find something',
          do: 'Type what you would call it into the box at the top of the sidebar: "upload bin list", "keyboard", "approve". The Go to hits take you straight to the card. Pressing / puts the cursor in the box from anywhere.',
          where: S('/admin', '', 'Dashboard'),
          watch: [],
          ask: [
            { q: 'Does the search find pallets and bins too?', a: 'Yes. A pallet id or a bin code shows where it was counted, by which team, and when, on the count you are on.' },
          ],
        },
        {
          title: 'Practise on the Testing Suite before count day',
          do: 'The Testing Suite opens a real scanner screen on a practice count of your own, with a sheet of test data beside it. Click a value to "scan" it. Nothing you do there touches a real count. The "What to practise" card also sets up a cycle count, a pallet move and a Not in Location run.',
          where: S('/testing', '', 'Testing Suite'),
          watch: [
            { see: 'The gun is still starting — give it a second', means: 'The scanner frame has not finished loading.', fix: 'Wait a moment and click again.' },
            { see: 'Nothing on the gun’s screen takes a scan just now', means: 'The gun is on a screen with no scan box, such as a confirmation.', fix: 'Tap through to the next prompt on the gun first, then click the value.' },
          ],
          ask: [
            { q: 'Will my practice count show up on the dashboard for others?', a: 'Not for other supervisors. An admin’s picker lists every count on the site, practice ones included, tagged with whose it is.' },
            { q: 'Can I practise with our own pallets?', a: 'Yes. The Testing Suite takes a file of your own pallets in the site’s inventory report format.', goto: S('/testing', '', 'Testing Suite') },
          ],
        },
      ],
    },
    {
      key: 'site', title: 'Set the site up', who: 'Admin, once',
      blurb: 'Everything a count depends on and that does not change from count to count.',
      steps: [
        {
          title: 'Create a login for each supervisor',
          do: 'Settings → Advanced → Supervisor logins. Give each a username, a starter password and either a profile (Supervisor, Inventory control, Read only) or the pages ticked one by one, down to the tab. Settings and Advanced are admin-only.',
          where: S('/settings', 'advanced', 'Settings → Advanced'),
          watch: [
            { see: '"only an admin can manage accounts"', means: 'Your login is a supervisor, not an admin.', fix: 'Ask an admin. The first admin is the superadmin from the server settings.' },
            { see: 'Can nobody sign in at all?', means: 'The admin logins were deleted or demoted.', fix: 'Set SUPERADMIN_USER to a new username in the server variables and restart. A fresh admin login is made on start.' },
          ],
          ask: [
            { q: 'What can a Read only login do?', a: 'Open the dashboard tabs and reports, nothing that changes a count.' },
            { q: 'How do I stop someone signing in?', a: 'Untick Active on their login. Their open sign-ins end at once.' },
          ],
        },
        {
          title: 'Upload the bin list',
          do: 'Settings → Lists & racking → Bin list. One column of bin codes, in the site’s format (F05A012 is aisle F05, bay A, level 012). Every count starts from this list and the aisles come from it.',
          where: S('/settings', 'lists', 'Settings → Lists & racking'),
          watch: [
            { see: '"no bin list yet - upload one under Settings → Lists & racking first"', means: 'Something was tried that needs bins before any exist on this count.', fix: 'Upload the list, then try again.' },
            { see: 'Bins come out in lower case or with a $ in front', means: 'The export carries a prefix or the wrong case.', fix: 'Nothing to do: a leading $ is stripped and case is ignored when a scan is matched.' },
          ],
          ask: [
            { q: 'Does uploading a new bin list wipe the counts?', a: 'No. Bins already counted keep their lines. New bins are added, bins no longer on the list stay for the record.' },
            { q: 'Where do DOORS and WIP go?', a: 'Any area with bins but no racking is uploaded like any other bin and shows up as its own area, not an aisle.' },
          ],
        },
        {
          title: 'Pair the aisles into racking blocks',
          do: 'Two aisles that share a rack are one block: a team on one side owns both, so nobody counts the back of a pallet from the other side. Settings → Lists & racking → Racking blocks, or let the app pair them by number.',
          where: S('/settings', 'lists', 'Settings → Lists & racking'),
          watch: [
            { see: 'Gun: "Team N is counting aisle X"', means: 'The other team holds the block that aisle belongs to.', fix: 'Wait, or have the other team hand their aisle back first. This is the blocks doing their job.' },
          ],
          ask: [
            { q: 'What happens with no blocks?', a: 'Teams still get aisles; two teams can just end up on the two sides of one rack. The guided setup marks it as wanted, not required.' },
          ],
        },
        {
          title: 'Register the scanners',
          do: 'Settings → Scanner screen. Add a scanner, give it a name, open its link on the device once, then install the app from Chrome’s menu. Each scanner has its own link; a reset link locks the old one out.',
          where: S('/settings', 'gun', 'Settings → Scanner screen'),
          watch: [
            { see: 'Gun: "this scanner is no longer authorised - ask a supervisor for its link"', means: 'Its link was reset or the scanner was removed.', fix: 'Reset link on its row and open the new link on the device.' },
            { see: 'Gun: "this scanner link is not registered - ask a supervisor"', means: 'The device opened a link that was never created here, or the server was reset.', fix: 'Add the scanner again and open the fresh link.' },
            { see: 'A scan does nothing on the handheld', means: 'DataWedge is not sending a suffix.', fix: 'DataWedge → Basic data formatting → send ENTER (or TAB).' },
          ],
          ask: [
            { q: 'Do I have to install it, or can it run in Chrome?', a: 'Install it. In a plain tab the address bar appears on every scan and the keyboard can wander. Chrome menu → Install app, or the button on the sign-on screen.' },
            { q: 'How do I know a gun has the latest version?', a: 'The grey line at the bottom of the sign-on screen says the build and whether the scanner is up to date. With "Update itself after a deploy" on, it reloads between pallets.' },
          ],
        },
        {
          title: 'Print the barcode test book',
          do: 'Settings → Getting started → Barcode book: a printable sheet of bin and pallet codes to try the guns on, with the practice data already in it. Print at 100% on plain paper.',
          where: S('/settings', 'start', 'Settings → Getting started'),
          watch: [
            { see: 'The printed barcodes will not scan', means: 'Printed fit-to-page, or on glossy paper.', fix: 'Print again at 100% on plain white paper; set Per row to 1 for wider bars.' },
            { see: 'A code will not print', means: 'Code 128 carries plain ASCII only.', fix: 'Retype that code with plain letters and numbers, the book says which character it was.' },
          ],
          ask: [],
        },
        {
          title: 'Set the SOS list and the Teams channel',
          do: 'Settings → Advanced → SOS reasons and Teams channel. Counters press SOS on the gun and pick a reason; the alert lands on the dashboard and, if a channel is set, as a card in Teams. Send a test card before count day.',
          where: S('/settings', 'advanced', 'Settings → Advanced'),
          watch: [
            { see: 'An SOS did not reach Teams', means: 'The address is wrong, expired, or Teams was down.', fix: 'The alert is still on the dashboard, its row says what Teams answered. Send a test card. Old Incoming Webhook connectors are being retired: make a Workflows one.' },
            { see: '"the address has to start with http:// or https://"', means: 'The pasted address is not a web address.', fix: 'Copy the whole address from the Teams workflow, it starts with https://.' },
          ],
          ask: [
            { q: 'Does an SOS work with no Teams channel?', a: 'Yes. It always goes to the dashboard Alerts tab and the office board. Teams is an extra.' },
          ],
        },
        {
          title: 'Choose which jobs the scanners offer',
          do: 'Settings → Scanner screen → What the scanners offer → Jobs: the sign-on screen shows exactly what is ticked — Full count, Cycle count, Front2Back, Not in Location. Day to day tick the last three; on count day untick them and tick the full count alone; swap back afterwards. The practice gun always has every job.',
          where: S('/settings', 'gun', 'Settings → Scanner screen'),
          watch: [
            { see: '"leave at least one job on, or the scanners have nothing to do"', means: 'Every job was unticked.', fix: 'Tick at least one.' },
            { see: 'A gun still offers a job you unticked', means: 'It has not been online since.', fix: 'It picks the change up on its next refresh of the sign-on screen.' },
          ],
          ask: [
            { q: 'Does unticking a job stop a gun already signed on to it?', a: 'No. It only changes what the sign-on screen offers next time. A gun mid-job finishes or signs off.' },
            { q: 'A gun offers Front2Back but says nothing is waiting', a: 'The job is ticked and the move list is empty. Build a list under Front bins, or untick the job until there is one.' },
          ],
        },
        {
          title: 'Set up the counting screen and what the scanners offer',
          do: 'Settings → Scanner screen decides what the gun asks: the order of the questions, text size, language, the Keyboard button. What the scanners offer is one section: the jobs, the comments (ask or not, required or not, the wait, the one-tap reasons), the override reasons and the SOS list, with one Save. Changes reach a running gun within about half a minute, between pallets.',
          where: S('/settings', 'gun', 'Settings → Scanner screen'),
          watch: [
            { see: 'A change does not appear on the scanners', means: 'The gun is between pallets or still on the old build.', fix: 'Settings land within half a minute between pallets. A new version needs a reload: tap the green Update ready bar.' },
            { see: 'A keypad covers the screen', means: 'Somebody left the Keyboard button on.', fix: 'Tap Keyboard again. It is off by default and never comes up by itself.' },
          ],
          ask: [
            { q: 'Can counters switch to Spanish themselves?', a: 'Yes, the language button is on the sign-on screen, and the choice stays on that scanner.' },
            { q: 'Can I make comments compulsory?', a: 'Yes. Settings → Scanner screen → What the scanners offer → Comments are required. The counter must tap a reason or type a note; Skip and the countdown go away.' },
            { q: 'I added an override reason and the gun does not show it', a: 'It lands between pallets, within about half a minute. If a gun never takes it, its sign-on screen build line is behind the server: tap the Update ready bar or reopen the app.' },
          ],
        },
      ],
    },
    {
      key: 'count', title: 'Set up a count', who: 'Supervisor or admin, before each physical',
      blurb: 'From an empty count to teams with aisles, with a dry run in between.',
      steps: [
        {
          title: 'Create the count',
          do: 'Full Counts → New count (or Settings → Getting started → Count session). Name it after the date. Full Counts lists every wall-to-wall with how far it got, which one the scanners land on, and a Set-up tab for what the new one still needs. A cycle count has its own page.',
          where: S('/full', 'new', 'Full Counts → New count'),
          watch: [
            { see: '"pick a count first"', means: 'The page has no count selected.', fix: 'Pick one in the picker at the top of the page.' },
            { see: 'The picker shows a count I did not make', means: 'Another supervisor created it, or it is the practice count.', fix: 'Practice counts are yours alone; anything else is real.' },
          ],
          ask: [
            { q: 'Can I run two counts at once?', a: 'Yes, each scanner picks its count at sign-on. Keep it to one real count at a time on count day, or teams sign on to the wrong one.' },
          ],
        },
        {
          title: 'Follow the guided setup',
          do: 'The Guided setup card lists what this count still needs, worked out from the data, not from ticks: bins, the inventory report, scanners, racking blocks, crew, a map drawing, a counting plan. Red is required, amber is wanted.',
          where: S('/settings', 'start', 'Settings → Getting started'),
          watch: [
            { see: 'A step stays red after I did it', means: 'It did it on a different count.', fix: 'Check the picker: the uploads are per count.' },
          ],
          ask: [
            { q: 'What does "wanted" mean?', a: 'Counting works without it, but you lose something: no inventory report means no variances and no second counts, no blocks means two teams can share a rack.' },
          ],
        },
        {
          title: 'Upload the inventory report',
          do: 'Settings → Lists & racking → Inventory report. The site’s own export as it comes: Bin Code, Container No., Item No., Description, Variant Code, Quantity, Unit of Measure Code, Entry No., Lot No., System. Excel or CSV, as is.',
          where: S('/settings', 'lists', 'Settings → Lists & racking'),
          watch: [
            { see: 'The upload summary says some rows were merged', means: 'The same container appeared twice in one bin.', fix: 'Their quantities were added together. Nothing to do unless the total looks wrong.' },
            { see: 'The summary says duplicates were skipped', means: 'The same container appeared in two different bins.', fix: 'The first row stands. Check that pallet in the ERP, it cannot be in two places.' },
            { see: 'The summary counts open bins', means: 'Rows with a bin and no container.', fix: 'Those are empty bins on the report. They are expected and recorded as such.' },
            { see: 'Numbers look wrong after an ERP import', means: 'The report moved on since the upload.', fix: 'Re-upload with Replace what is there, then re-read the pallet report.' },
          ],
          ask: [
            { q: 'Does the column order matter?', a: 'No, the headers do. The site’s names and the common ERP names are both recognised.' },
            { q: 'What about pallets in VA-FR_LOC that are not on the bin list?', a: 'They import and show on the pallet report, but no bin will be guided to them. Counting one anywhere still records it.' },
          ],
        },
        {
          title: 'Set the count’s options',
          do: 'Count session card: pallet check (off, warn, strict), guided bins, comments, the map drawing, and the second-count thresholds: Recount over N units, or over N %, and a cap. Adjustments need approval if the office signs off variances.',
          where: S('/settings', 'start', 'Settings → Getting started'),
          watch: [
            { see: 'The second-count list is enormous', means: 'The thresholds are at 0, so every difference raises one.', fix: 'Set Recount over to 2 to 5 units, a percent, and a cap.' },
            { see: 'The Adjustments tab is empty', means: 'Approvals are off, or nothing differs yet.', fix: 'Turn on Adjustments need approval. An uncounted pallet is not an adjustment until the count is closed.' },
          ],
          ask: [
            { q: 'Warn or strict pallet check?', a: 'Warn tells the counter a pallet is not on the report and lets them count it. Strict refuses it. Use warn for a physical, strict only when the report is trusted.' },
            { q: 'Is a blind count possible?', a: 'Yes. The gun never shows what the report says is in a bin or on a pallet. It only says which bin and which pallet it recognised.' },
          ],
        },
        {
          title: 'Give the teams their aisles',
          do: 'Teams & crew → Counting plan. Add the teams, drop the crew in, and give each team its aisles in order, or press Stagger to spread them so no two teams start side by side. The gun hands out the next aisle itself.',
          where: S('/teams', 'crew', 'Teams & crew'),
          watch: [
            { see: '"that aisle belongs to another team"', means: 'You are moving an aisle a team already holds.', fix: 'Take it off that team first.' },
            { see: 'A team’s clock-in number is refused', means: 'The number is not on the crew list.', fix: 'Add the person under Crew, or tick Count without an assignment on the count if walk-ups are allowed.' },
          ],
          ask: [
            { q: 'What does shift 1 or 2 mean on a team?', a: 'Which shift the team belongs to, so the plan can show who is on. Day, morning, am, first all mean 1; night, pm, second mean 2.' },
            { q: 'Can a team count an aisle nobody gave them?', a: 'Only with Count without an assignment on. Otherwise the gun says who holds it.' },
          ],
        },
        {
          title: 'Run a trial first',
          do: 'Count session → Trial run. Every scan counts for real on the dashboard, nothing can be exported to the ERP, and End the trial wipes it clean, so the real count starts from zero on the same setup.',
          where: S('/settings', 'start', 'Settings → Getting started'),
          watch: [
            { see: '"this count is a trial run - end the trial and count it for real before sending anything to the ERP"', means: 'The ERP export is blocked on a trial.', fix: 'End the trial, then export.' },
          ],
          ask: [
            { q: 'Do the guns know it is a trial?', a: 'Yes, they show a trial band and say when the real count starts.' },
          ],
        },
      ],
    },
    {
      key: 'day', title: 'Counting day', who: 'Supervisor on the dashboard',
      blurb: 'What to watch while the teams scan, and what to do when the gun or a counter asks for you.',
      steps: [
        {
          title: 'Teams sign on',
          do: 'On the gun: pick the count, type the team number, scan each clock-in number, press Sign on & load list. The gun downloads the lists once and then works with or without signal.',
          where: S('/admin', 'teams', 'Dashboard → Team plan'),
          watch: [
            { see: 'Gun: "Offline and no list cached for this session"', means: 'That handheld never downloaded this count.', fix: 'Carry it into Wi-Fi once and sign on again.' },
            { see: 'Gun: "this scanner is not signed in - open its link again"', means: 'The scanner lost its token.', fix: 'Open its link from Settings → Scanner screen again.' },
            { see: 'Gun: "Add at least one clock in number"', means: 'Sign-on was pressed with no crew.', fix: 'Scan a clock-in number first.' },
          ],
          ask: [
            { q: 'Can a counter sign on alone?', a: 'Yes. One clock-in number is a team of one.' },
            { q: 'What if the clock-in badge will not scan?', a: 'Type the number and press Enter.' },
          ],
        },
        {
          title: 'Watch Progress and the Map',
          do: 'Progress shows bins counted, lines, pace and the time left at this pace. The Map colours each aisle as it is counted. Team plan shows where each team is, how long since their last scan, and who has stopped.',
          where: S('/admin', 'progress', 'Dashboard → Progress'),
          watch: [
            { see: 'A team shows stopped scanning', means: 'No line from them for longer than the limit.', fix: 'Message the team from the Team plan, or go and look. A dead spot queues lines and uploads them later, so a quiet gun is not always a stopped team.' },
            { see: 'The map is a schematic, not your drawing', means: 'No rack drawing on this count.', fix: 'Count session → Map drawing.' },
          ],
          ask: [
            { q: 'How often does the dashboard refresh?', a: 'Every few seconds, and only the panes you have open. The board every 15 seconds.' },
            { q: 'Why does the guide stay on one bin?', a: 'The bin holds several pallets. The guide moves on when its tags are counted. Check Show the next bin in the aisle is on.' },
          ],
        },
        {
          title: 'Answer an SOS',
          do: 'Alerts shows every SOS with its reason, team and aisle. Mark it seen so the gun tells the counter help is coming, close it when it is dealt with.',
          where: S('/admin', 'alerts', 'Dashboard → Alerts'),
          watch: [
            { see: 'A counter says they pressed SOS and nothing happened', means: 'The gun had no signal.', fix: 'The gun says "No signal — this has NOT been sent" and sends it the moment it has one. Ten metres usually fixes it.' },
          ],
          ask: [
            { q: 'What reasons can a counter pick?', a: 'The ones under Settings → Advanced → SOS reasons: equipment breakdown, need a supervisor, blocked, damage, someone trapped, and your own.' },
          ],
        },
        {
          title: 'Message a team',
          do: 'Team plan → Message. It shows on the gun between pallets with a Got it button; Read by says which scanners tapped it. A scanner that is offline gets it on its next sync.',
          where: S('/admin', 'teams', 'Dashboard → Team plan'),
          watch: [
            { see: 'A team says they never got a message', means: 'Their gun has not synced since.', fix: 'Look at Read by. An offline gun gets it on its next sync.' },
          ],
          ask: [],
        },
        {
          title: 'Keep an eye on the Fix list',
          do: 'Pallets counted with no readable label, damage reports and blocked bins from the gun land on the Fix list and on Reports → Labels to replace. Send somebody while the team is still nearby.',
          where: S('/admin', 'alerts', 'Dashboard → Alerts'),
          watch: [
            { see: 'A pallet named NO-LABEL-F01A001-1 on the report', means: 'Its label would not scan and nothing on it was readable.', fix: 'It was counted under the bin’s name. Relabel it from the list.' },
            { see: 'A line in a bin called NO-LABEL-BIN-F01-1', means: 'The rack label would not scan and the app had nothing to suggest.', fix: 'The quantity is safe. Relabel the bay, then correct the bin on the line if it matters.' },
          ],
          ask: [],
        },
        {
          title: 'Put the office board on the TV',
          do: 'Open /board on the office screen. No login. Pin it to a count with ?session=12 if more than one is open. Notes typed on the dashboard show there.',
          where: S('/board', '', 'Open the board'),
          watch: [
            { see: 'The note is not on the board', means: 'The board polls every 15 seconds, or it is pinned to another count.', fix: 'Wait a few seconds; check the count in its address.' },
          ],
          ask: [],
        },
      ],
    },
    {
      key: 'finish', title: 'Finish a count', who: 'Supervisor and inventory control',
      blurb: 'Second counts, reports, approvals, the ERP file, closing, and the backup.',
      steps: [
        {
          title: 'Work the second counts',
          do: 'Second counts lists every bin whose count differs from the report by more than the thresholds. The gun hands them to teams nearest first, their own aisles before others. A supervisor can send a bin for recount by hand.',
          where: S('/admin', 'second', 'Dashboard → Second counts'),
          watch: [
            { see: 'No second counts at all', means: 'No inventory report was uploaded, or auto recount is off.', fix: 'Without a report there is nothing to compare. Check the Count session options.' },
            { see: 'The list is enormous', means: 'Thresholds at 0.', fix: 'Set Recount over, or over %, and a cap.' },
          ],
          ask: [
            { q: 'Does the same team recount its own bin?', a: 'Preferably not: the server offers it to another team when one is near; a lone team gets it after its own aisles.' },
          ],
        },
        {
          title: 'Check what was filed, then the final report',
          do: 'Reports → Filed as the count goes: every aisle handed back was written to disk at once as CSV files, one folder per hand-back. Final report files every sheet of Export everything, and is offered only when every bin has a count and no second count is open; the card says what is still missing until then.',
          where: S('/admin', 'reports', 'Dashboard → Reports'),
          watch: [
            { see: 'Final report is greyed out', means: 'Bins are still uncounted, or second counts are open.', fix: 'The line beside it says which. Finish them; it switches on by itself.' },
            { see: 'An aisle handed back is not in the list', means: 'The server could not write the folder.', fix: 'Check the disk on the host; the count itself is unaffected, and Export everything still has the lot.' },
          ],
          ask: [
            { q: 'Where are the filed aisles kept?', a: 'In an exports folder beside the backups on the server’s volume, one folder per count. Download them from the card, and copy the final report off the server with the backup.' },
          ],
        },
        {
          title: 'Read the reports',
          do: 'Reports: the pallet report with filters (status, aisle, lot, text, hide missing), variances by aisle, labels to replace, and the exports. Everything can be read on screen without downloading.',
          where: S('/admin', 'reports', 'Dashboard → Reports'),
          watch: [
            { see: 'Pallets marked NOT IN MASTER', means: 'Counted, but not on the inventory report.', fix: 'Real pallets the report did not know about, or a mistyped id. The adjustments list carries them as additions.' },
            { see: 'Pallets marked MISSING', means: 'On the report, never scanned.', fix: 'Not an adjustment until the count is closed. Tick Hide missing to read the rest.' },
          ],
          ask: [
            { q: 'What does the System column mean?', a: 'Which of the site’s three systems the pallet belongs to, read from the report. The ERP export is split by it.' },
          ],
        },
        {
          title: 'Approve the adjustments',
          do: 'Adjustments shows every difference as a plus or a minus with a reason. Approve, reject, or hold. Approved lines go into the ERP file; held ones are left out and the preview says how many.',
          where: S('/admin', 'adjust', 'Dashboard → Adjustments'),
          watch: [
            { see: 'The ERP file is shorter than the variance list', means: 'Adjustments are waiting for approval.', fix: 'Work the Adjustments tab, then export again.' },
            { see: '"this login may not approve adjustments"', means: 'Your login lacks the approval function.', fix: 'An admin adds Approve adjustments to your login.' },
          ],
          ask: [],
        },
        {
          title: 'Send it to the ERP',
          do: 'Reports → ERP export. The file carries the approved adjustments in the ERP’s format, one file per system if the site uses several. Export everything gives the whole count as a workbook.',
          where: S('/admin', 'reports', 'Dashboard → Reports'),
          watch: [
            { see: 'Export is refused on a trial', means: 'The count is still a trial run.', fix: 'End the trial first.' },
          ],
          ask: [],
        },
        {
          title: 'Close the count, then back it up',
          do: 'Count session → Close. Closed counts stay readable and exportable; guns can no longer scan to them. Settings → ERP & backups makes a database backup. Download it somewhere other than the server, a volume is not a backup.',
          where: S('/settings', 'erp', 'Settings → ERP & backups'),
          watch: [
            { see: '"session is closed"', means: 'A scan or change was tried on a closed count.', fix: 'Reopen it from the Count session card if the work is not finished.' },
          ],
          ask: [
            { q: 'Can I delete a count?', a: 'An admin can, from the Count session card. Take a backup first; it is gone for good.' },
          ],
        },
      ],
    },
    {
      key: 'cycle', title: 'Cycle counts', who: 'Whoever runs the daily programme',
      blurb: 'Small batches every day instead of one big count.',
      steps: [
        {
          title: 'Set the programme up',
          do: 'Cycle counts → Program & data: how many bins a day and how the picker chooses them (longest since counted first). It needs the inventory report with last-counted dates.',
          where: S('/cycle', 'setup', 'Cycle counts → Program & data'),
          watch: [
            { see: 'No batch can be made', means: 'No inventory report on the cycle count.', fix: 'Upload it, the dates come from it.' },
          ],
          ask: [],
        },
        {
          title: 'Count today’s batch',
          do: 'On the gun: Cycle count at the top of the sign-on screen, sign on with a clock-in number alone, Start counting the list. Every pallet in the bin, then Bin done. Several people can be on the same batch.',
          where: S('/cycle', 'today', 'Cycle counts → Today'),
          watch: [
            { see: 'Gun: "Bin done — nothing more here"', means: 'The counter said the bin is finished.', fix: 'Normal. The next bin on the list comes up.' },
          ],
          ask: [
            { q: 'Do cycle counters need a team number?', a: 'No, a clock-in number is enough.' },
          ],
        },
        {
          title: 'Watch coverage and what is still open',
          do: 'Still open shows bins from earlier batches nobody finished. Coverage shows how much of the warehouse has been counted this cycle.',
          where: S('/cycle', 'coverage', 'Cycle counts → Coverage'),
          watch: [],
          ask: [],
        },
      ],
    },
    {
      key: 'front', title: 'Front bins and pallet moves', who: 'Supervisor and the forklift crew',
      blurb: 'Pallets put in front bins that belong further back, and the guided moves to put them right.',
      steps: [
        {
          title: 'Read the front-placed list',
          do: 'Front bins → Front-placed bins lists pallets counted in a front bin whose home is behind it. Build a move list from it, or upload one: pallet, from bin, to an empty bin behind.',
          where: S('/front', 'bins', 'Front bins → Front-placed bins'),
          watch: [],
          ask: [],
        },
        {
          title: 'Move them on the gun: Front2Back',
          do: 'Front2Back at sign-on, with a clock-in number alone. Pick the aisle; the gun shows the office’s desk: the pallet, from → to, and the pallet system framed under it. Move it, book it in that screen, tap Moved — next. Nothing is scanned in the app. Ticks queue offline like counting.',
          where: S('/front', 'moves', 'Front bins → Pallets to move back'),
          watch: [
            { see: 'The gun does not offer Front2Back', means: 'No moves are waiting, or the job is unticked under Settings → Scanner screen → Jobs on the scanners.', fix: 'Build a move list under Front bins; an admin ticks the job back on.' },
            { see: 'A pallet on the desk cannot be moved', means: 'The bin behind is not empty, or the pallet is not there.', fix: 'Leave it with › on the gun; skip it with the reason from Front bins → Pallets to move back.' },
            { see: 'No pallet system under the strip on the gun', means: 'No address set, or the system refuses to be framed.', fix: 'Settings → Advanced → Pallet system. The gun shows the screen, never the address; a system that refuses framing is worked from the office desk’s new-tab link.' },
          ],
          ask: [],
        },
        {
          title: 'Use the move desk',
          do: 'Move desk puts the pallet and the two bins at the top and frames the site’s pallet system below, so the move can be booked there without switching windows. Set the pallet system address under Settings.',
          where: S('/front', 'desk', 'Front bins → Move desk'),
          watch: [
            { see: 'The frame below is empty', means: 'No pallet-system address is set, or that site refuses to be framed.', fix: 'Settings → Advanced → Pallet system. If it refuses framing, the desk gives an Open link instead.' },
          ],
          ask: [],
        },
      ],
    },
    {
      key: 'missing', title: 'Not in Location', who: 'Inventory control',
      blurb: 'Pallets the ERP has lost track of, watched for on every scan.',
      steps: [
        {
          title: 'Upload the list',
          do: 'Not in Location takes the pallets that are not where the ERP says, with the last known location. It is site-wide, not tied to a count.',
          where: S('/missing', '', 'Not in Location'),
          watch: [],
          ask: [],
        },
        {
          title: 'Let the scanners find them: Not in Location on the gun',
          do: 'Any scan of a listed pallet, on any count or move, marks it found with the bin, the team and the time. There is also a job: Not in Location at sign-on with a badge alone, pick the aisle it was last seen in, and the gun shows the pallet, last seen in, what it is, and the pallet system under it; Found — next tells the office. The page has the same find desk at the bottom. Close the ones found another way.',
          where: S('/missing', '', 'Not in Location'),
          watch: [
            { see: 'Gun: "Count it here as normal; the office is told where it turned up."', means: 'The counter scanned a pallet from this list.', fix: 'Nothing: that is the system working.' },
          ],
          ask: [
            { q: 'Does the list carry over to the next count?', a: 'Yes, until a pallet turns up or is closed.' },
          ],
        },
      ],
    },
    {
      key: 'gun', title: 'On the scanner', who: 'Counters, for training',
      blurb: 'The counter’s loop on the handheld, and what each message means.',
      steps: [
        {
          title: 'The loop: pallet, quantity, bin',
          do: 'Scan PALLET ID. Enter QUANTITY, big numbers twice. Scan LOT and type EXPIRY only if the count asks. Scan BIN LOCATION. Comments are optional; leave them and the gun moves on. The gun says which bin is next.',
          where: S('/testing', '', 'Try it in the Testing Suite'),
          watch: [
            { see: 'Gun: "That is a very large quantity. Type it again to accept it"', means: 'The number is out of the ordinary.', fix: 'Type it again if it is right, or the right one.' },
            { see: 'Gun: "F01A001 is a bin, not a pallet" or "P-100 is a pallet label, not a bin"', means: 'The wrong label went into that step.', fix: 'Scan what the prompt asks for; nothing was recorded. For an empty bin tap Bin is EMPTY first.' },
            { see: 'Gun: "That is a bin, not a quantity"', means: 'A label was scanned where the number goes.', fix: 'The quantity is typed, never scanned: type the cases and press Enter.' },
            { see: 'Gun: "That label belongs to another pallet"', means: 'A second label on this pallet is already known under another id.', fix: 'Tell a supervisor; count under the first label.' },
            { see: 'Gun: "That date has passed"', means: 'An expiry in the past.', fix: 'Tell a supervisor; it is recorded.' },
          ],
          ask: [
            { q: 'Why does the gun not show what should be on the pallet?', a: 'It is a blind count. It shows the pallet and the bin it recognised, never the quantity the office expects.' },
          ],
        },
        {
          title: 'Empty bins, and a run of them',
          do: 'Bin is EMPTY: scan the bin. For a run of empties, scan the FIRST empty location and the LAST, untick any that are not empty, confirm.',
          where: S('/testing', '', 'Try it in the Testing Suite'),
          watch: [
            { see: 'Gun: "EMPTY bin — scan its LOCATION"', means: 'The gun is waiting for the rack label.', fix: 'Scan the bin label, not a pallet.' },
          ],
          ask: [],
        },
        {
          title: 'A pallet with no label, or one not on the list',
          do: 'No readable label: Counting it as a pallet with no label; it is named after its bin and the bin goes on the relabel list. Not on the list: the gun asks, Counted - a supervisor will add it to the system.',
          where: S('/testing', '', 'Try it in the Testing Suite'),
          watch: [
            { see: 'Gun: "Can you read the number on it? Type it if you can — it is still that pallet."', means: 'The barcode failed but the number may be printed.', fix: 'Type it. Only when nothing is readable use no label.' },
          ],
          ask: [],
        },
        {
          title: 'Blocked, broken, help',
          do: 'Cannot reach the bins: Bin blocked, come back later, the supervisor sees it. SOS: pick a reason; Enviado / Sent means a supervisor was told.',
          where: S('/testing', '', 'Try it in the Testing Suite'),
          watch: [
            { see: 'Gun: "No signal — this has NOT been sent"', means: 'No connection just now.', fix: 'It sends itself with the next signal. Walk ten metres.' },
          ],
          ask: [],
        },
        {
          title: 'Offline, the keyboard, and rotation',
          do: 'OFFLINE with a number means lines are queued; they upload with signal, never wipe the device. The Keyboard button is for typing a quantity only. The app keeps itself upright; if not, Keep it upright is under Settings → Scanner screen.',
          where: S('/testing', '', 'Try it in the Testing Suite'),
          watch: [
            { see: 'Gun: "Cannot reach the server to check this scanner link. Connect to Wi-Fi and reload."', means: 'First open of a link with no signal.', fix: 'Connect once; after that it works offline.' },
            { see: 'A scan opens the address bar', means: 'The app is running as a page, not installed.', fix: 'Install it from Chrome’s menu; the red Tap here to scan bar puts the focus right meanwhile.' },
            { see: 'Gun keeps saying "update did not take"', means: 'Something is serving stale files.', fix: 'Close the app fully and reopen; if it persists, clear the app’s site data on the device and open its link again.' },
          ],
          ask: [
            { q: 'The gun says OFFLINE. Did we lose the counts?', a: 'No. They are queued on the device and upload themselves. Do not clear the app or reinstall it.' },
          ],
        },
      ],
    },
  ];

  /* the general questions: no single step owns them */
  const questions = [
    { q: 'How many teams and bins can the system take?', a: 'A 20-team, 20,000-bin count was simulated end to end; the dashboard stayed under a second a refresh. Part 8 of the SOP has the figures.' },
    { q: 'Where is the SOP?', a: 'docs/SOP.pdf in the repository, and the same text as docs/SOP.md. This guide follows its steps.' },
    { q: 'Where is the backup kept?', a: 'On the server’s volume under Settings → ERP & backups. Download it after every count; a volume is not a backup.', goto: S('/settings', 'erp', 'Settings → ERP & backups') },
    { q: 'What is the practice count?', a: 'A count of your own the Testing Suite makes, with test data, that nobody else sees.', goto: S('/testing', '', 'Testing Suite') },
    { q: 'How do I change the look?', a: 'The theme and accent picker is at the bottom of the sidebar, and the site logo is under Settings → Advanced.', goto: S('/settings', 'advanced', 'Settings → Advanced') },
    { q: 'How do I rename the app, or change the location under the name?', a: 'Settings → Advanced → Site name. The name and the location change at once on every page, the sign-in screen, the scanners, the board and the installed app. A blank name goes back to Full Harvest Inventory.', goto: S('/settings', 'advanced', 'Settings → Advanced') },
    { q: 'What time zone are the scan times in?', a: 'The server’s. A scanner with a wrong clock is corrected by its own send time, so the times on the dashboard are right either way.' },
    { q: 'Can I export everything?', a: 'Reports → Export everything gives a workbook with every sheet: counts, pallets, teams, adjustments, alerts, the log.', goto: S('/admin', 'reports', 'Dashboard → Reports') },
    { q: 'Who did what?', a: 'The log under Settings → ERP & backups records every change with the login that made it.', goto: S('/settings', 'erp', 'Settings → ERP & backups') },
    { q: 'Why can I not see Settings?', a: 'Settings and Advanced are admin-only. Everything else is per login.' },
  ];

  /* the lookup bank: screen text first, so a pasted message finds its row */
  const errors = [
    { see: 'this scanner is no longer authorised - ask a supervisor for its link', means: 'Its link was reset or the scanner was removed.', fix: 'Settings → Scanner screen → Reset link, open the new link on the device.', goto: S('/settings', 'gun', 'Scanner screen') },
    { see: 'this scanner link is not registered - ask a supervisor', means: 'The device opened a link that was never created here.', fix: 'Add the scanner and open the fresh link.', goto: S('/settings', 'gun', 'Scanner screen') },
    { see: 'this scanner is not signed in - open its link again', means: 'The scanner lost its token.', fix: 'Open its link from Settings → Scanner screen on the device.', goto: S('/settings', 'gun', 'Scanner screen') },
    { see: 'Offline and no list cached for this session', means: 'The handheld never downloaded this count.', fix: 'Carry it into Wi-Fi once and sign on again.' },
    { see: 'No signal — this has NOT been sent', means: 'An SOS or line is waiting for signal.', fix: 'It sends itself the moment there is signal. Walk ten metres.' },
    { see: 'OFFLINE with lines queued', means: 'Normal in a dead spot.', fix: 'Nothing. They upload when the gun has signal. Do not wipe the device.' },
    { see: 'Team N is counting aisle X', means: 'Another team holds that racking block.', fix: 'Wait, or hand the other aisle back first.' },
    { see: 'That bin was taken by another team', means: 'Two teams reached one bin; the server gave it to the first.', fix: 'Move on, the gun shows the next bin.' },
    { see: 'no bin list yet - upload one under Settings → Lists & racking first', means: 'Nothing can be counted on a count with no bins.', fix: 'Upload the bin list.', goto: S('/settings', 'lists', 'Lists & racking') },
    { see: 'pick a count first', means: 'The page has no count selected.', fix: 'Pick one in the picker at the top.' },
    { see: 'session is closed', means: 'The count was closed.', fix: 'Reopen it from the Count session card if work remains.', goto: S('/settings', 'start', 'Count session') },
    { see: 'session not found', means: 'The count was deleted, or the link is to another server.', fix: 'Pick a count from the picker.' },
    { see: 'that aisle belongs to another team', means: 'The aisle is on another team’s plan.', fix: 'Take it off that team first.', goto: S('/teams', 'crew', 'Counting plan') },
    { see: 'that username and password do not match', means: 'Wrong password, or the username is spelt differently.', fix: 'Passwords are case-sensitive. An admin can set a new starter password.' },
    { see: 'only an admin can manage accounts', means: 'Your login is not an admin.', fix: 'Ask an admin.' },
    { see: 'this count is a trial run - end the trial and count it for real before sending anything to the ERP', means: 'ERP export is blocked on a trial.', fix: 'End the trial under Count session.', goto: S('/settings', 'start', 'Count session') },
    { see: 'this login may not approve adjustments', means: 'The login lacks the approval function.', fix: 'An admin adds it under Supervisor logins.' },
    { see: 'the address has to start with http:// or https://', means: 'The Teams or pallet-system address is not a web address.', fix: 'Paste the whole https:// address.' },
    { see: 'pick a layout drawing in the session settings first', means: 'The map has no drawing on this count.', fix: 'Count session → Map drawing.', goto: S('/settings', 'start', 'Count session') },
    { see: 'unauthorized', means: 'The sign-in ended or was never made.', fix: 'Sign in again.' },
    { see: 'Signed out — sign in again', means: 'The server no longer knows this sign-in: a logout elsewhere, or 30 days passed.', fix: 'Sign in again.' },
    { see: 'A scan does nothing', means: 'DataWedge is not sending a suffix.', fix: 'DataWedge → Basic data formatting → send ENTER (or TAB).' },
    { see: 'A keypad covers the screen', means: 'The Keyboard button was left on.', fix: 'Tap Keyboard again.' },
    { see: 'The Adjustments tab is empty', means: 'Approvals are off, or nothing differs from the report yet.', fix: 'Turn on Adjustments need approval under Count session.', goto: S('/settings', 'start', 'Count session') },
    { see: 'The ERP file is shorter than the variance list', means: 'Adjustments are waiting for approval.', fix: 'Work the Adjustments tab, then export again.', goto: S('/admin', 'adjust', 'Adjustments') },
    { see: 'NOT IN MASTER with a name like NO-LABEL-F01A001-1', means: 'A pallet with no readable label, counted under its bin’s name.', fix: 'Relabel it; Reports → Labels to replace has the list.', goto: S('/admin', 'reports', 'Reports') },
    { see: 'A line in a bin called NO-LABEL-BIN-F01-1', means: 'The rack label would not scan and nothing could be suggested.', fix: 'The quantity is safe. Relabel the bay, correct the bin on the line if it matters.' },
    { see: 'The note is not on the board', means: 'The board polls every 15 seconds, or is pinned to another count.', fix: 'Wait; check the count in the board’s address.' },
    { see: 'A change does not appear on the scanners', means: 'The gun is between pallets or on an old build.', fix: 'Settings land within half a minute. A new version: tap Update ready, or close the app fully and reopen.' },
    { see: 'An SOS did not reach Teams', means: 'Channel address wrong, expired, or Teams down.', fix: 'The alert is on the dashboard. Send a test card under Settings → Advanced.', goto: S('/settings', 'advanced', 'Advanced') },
    { see: 'The printed barcodes will not scan', means: 'Printed fit-to-page or on glossy paper.', fix: 'Print at 100% on plain paper; Per row 1 for wider bars.' },
    { see: 'A code in the spreadsheet will not print', means: 'Code 128 takes plain ASCII only.', fix: 'Retype the code with plain letters and numbers.' },
    { see: 'update did not take', means: 'The gun reloaded and is still on the old version.', fix: 'Close the app fully and reopen. If it persists, clear the app’s site data on the device and open its link again.' },
    { see: 'The screen keeps rotating, or reads upside down', means: 'Auto-rotate is on.', fix: 'The app turns itself upright. Check Keep it upright under Scanner screen; install the app to lock one way up.', goto: S('/settings', 'gun', 'Scanner screen') },
    { see: 'A scan opens the address bar and the text goes into it', means: 'The page lost the keyboard, usually because the app is not installed.', fix: 'Install the app. The red Tap here to scan bar puts it right meanwhile.' },
    { see: 'A bar with the web address appears on every scan', means: 'The app runs as a page in Chrome, not installed.', fix: 'Chrome menu → Install app, or Install on this scanner on the sign-on screen.' },
    { see: 'Second-count list is enormous', means: 'Thresholds at 0.', fix: 'Set Recount over, or over %, and a cap.', goto: S('/settings', 'start', 'Count session') },
    { see: 'The map is a schematic, not your drawing', means: 'No rack drawing on this count.', fix: 'Count session → Map drawing.', goto: S('/settings', 'start', 'Count session') },
    { see: 'Can nobody sign in?', means: 'The admin logins were lost.', fix: 'Set SUPERADMIN_USER to a new username in the server variables and restart.' },
    { see: 'Numbers look wrong after an ERP import', means: 'The report moved on.', fix: 'Re-upload with Replace what is there, then re-read the pallet report.', goto: S('/settings', 'lists', 'Lists & racking') },
    { see: 'A scanner’s scan times are hours out', means: 'The handheld’s clock is wrong.', fix: 'Nothing: the server corrects each line by the gun’s own send time. Set the clock when you can.' },
    { see: 'Everyone was signed out of the dashboards', means: 'The server lost its database volume.', fix: 'Sign-ins survive a normal restart. If it happens, check the volume on the host.' },
    { see: 'The gun is still starting — give it a second', means: 'The Testing Suite’s scanner frame is loading.', fix: 'Wait a moment and click again.' },
    { see: 'Nothing on the gun’s screen takes a scan just now', means: 'The gun is on a screen with no scan box.', fix: 'Tap through to the next prompt on the gun first.' },
    { see: 'leave at least one job on, or the scanners have nothing to do', means: 'Every job was unticked under Jobs on the scanners.', fix: 'Tick at least one.', goto: S('/settings', 'gun', 'Scanner screen') },
    { see: 'That is a very large quantity', means: 'The number is out of the ordinary.', fix: 'Type it again to accept it, or type the right one.' },
    { see: 'That label belongs to another pallet', means: 'A second label already known under another id.', fix: 'Tell a supervisor; count under the first label.' },
    { see: 'That date has passed', means: 'An expiry in the past.', fix: 'Tell a supervisor; it is recorded.' },
    { see: 'Count it here as normal; the office is told where it turned up', means: 'A Not in Location pallet was scanned.', fix: 'Nothing: it is marked found.', goto: S('/missing', '', 'Not in Location') },
    { see: 'Add at least one clock in number', means: 'Sign-on with no crew.', fix: 'Scan a clock-in number first.' },
    { see: 'A supervisor needs to upload it before counting', means: 'This count has no bin list.', fix: 'Upload the bin list.', goto: S('/settings', 'lists', 'Lists & racking') },
  ];

  window.GUIDE = { journeys, questions, errors };
})();
