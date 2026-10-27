# How-to guides

## For admins

Step-by-step guides for the newer parts of the app, each with its own print-ready PDF beside it.
The full manual is [docs/SOP.md](../SOP.md); the procedure for each job is under [docs/roles](../roles/).

| Guide | For | PDF |
|---|---|---|
| [Your first full count, start to finish](first-full-count.md) | Whoever sets the site up and runs its first wall-to-wall | [PDF](first-full-count.pdf) |
| [Second and third counts](second-and-third-counts.md) | Supervisors, inventory control | [PDF](second-and-third-counts.pdf) |
| [Set up second and third counts](set-up-second-and-third-counts.md) | Admins and inventory control: the report's costs, the thresholds in cases, percent and money, third counts, a dry run | [PDF](set-up-second-and-third-counts.pdf) |
| [The ERP upload, an aisle at a time](erp-upload-by-aisle.md) | Inventory control | [PDF](erp-upload-by-aisle.pdf) |
| [Employees, teams and gear sizes](employees-teams-and-gear.md) | Count supervisors, whoever keeps the crew list | [PDF](employees-teams-and-gear.pdf) |
| [LIVE and TEST: switching, logins and scanners](live-and-test.md) | Admins, anyone using TEST | [PDF](live-and-test.pdf) |
| [Run the training day](run-the-training-day.md) | Trainers and count supervisors: the printed wall, the session minute by minute, every spot's lesson, reset between classes | [PDF](run-the-training-day.pdf) |
| [Run the floor on count day](count-day-for-supervisors.md) | Floor supervisors and leads: what each thing a scanner does looks like in the office, and the button that answers it | [PDF](count-day-for-supervisors.pdf) |

## For users

The same guides without anything about setting the system up — no Railway, no Settings, no access
lists: just how it works for the people using it day to day.

| Guide | For | PDF |
|---|---|---|
| [Your first full count — how it works](for-users/first-full-count.md) | Count supervisors, inventory control and counters new to the app | [PDF](for-users/first-full-count.pdf) |
| [Second and third counts — how they work](for-users/second-and-third-counts.md) | Counters, count supervisors, inventory control | [PDF](for-users/second-and-third-counts.pdf) |
| [The ERP upload, an aisle at a time — how it works](for-users/erp-upload-by-aisle.md) | Inventory control | [PDF](for-users/erp-upload-by-aisle.pdf) |
| [Employees, teams and gear sizes — how it works](for-users/employees-teams-and-gear.md) | Count supervisors, whoever keeps the crew list | [PDF](for-users/employees-teams-and-gear.pdf) |
| [LIVE and TEST — how to switch, and tell them apart](for-users/live-and-test.md) | Anyone using TEST | [PDF](for-users/live-and-test.pdf) |

The pictures are taken by `npm run docs:shots`; the PDFs are made by `npm run docs:guides`.

## On the scanner

One page for each thing on a full count that is not the plain rack label, pallet label, quantity — for everyone counting. Each prints on one sheet; [on-the-scanner.pdf](on-the-scanner/on-the-scanner.pdf) has them all. In the app they are under **User guide → On the scanner**, with each page and the whole set as Word too. Print them with `node tools/scanner-guides-pdf.mjs`.

| Page | PDF |
|---|---|
| [A pallet with two or more labels](on-the-scanner/two-or-more-labels.md) | [PDF](on-the-scanner/two-or-more-labels.pdf) |
| [A pallet label that will not scan](on-the-scanner/label-will-not-scan.md) | [PDF](on-the-scanner/label-will-not-scan.pdf) |
| [A pallet with no label](on-the-scanner/no-label.md) | [PDF](on-the-scanner/no-label.pdf) |
| [A rack label that will not scan](on-the-scanner/bin-label-will-not-scan.md) | [PDF](on-the-scanner/bin-label-will-not-scan.pdf) |
| [Several pallets in one bin](on-the-scanner/several-pallets-in-a-bin.md) | [PDF](on-the-scanner/several-pallets-in-a-bin.pdf) |
| [An empty bin](on-the-scanner/empty-bin.md) | [PDF](on-the-scanner/empty-bin.pdf) |
| [Several empty bins in a row](on-the-scanner/several-empty-bins.md) | [PDF](on-the-scanner/several-empty-bins.pdf) |
| [A pallet that is not on the list](on-the-scanner/pallet-not-on-the-list.md) | [PDF](on-the-scanner/pallet-not-on-the-list.pdf) |
| [A bin that is not on the list](on-the-scanner/bin-not-on-the-list.md) | [PDF](on-the-scanner/bin-not-on-the-list.pdf) |
| [A pallet that was already counted](on-the-scanner/pallet-already-counted.md) | [PDF](on-the-scanner/pallet-already-counted.pdf) |
| [Not your aisle, or not your level](on-the-scanner/not-your-aisle-or-level.md) | [PDF](on-the-scanner/not-your-aisle-or-level.pdf) |
| [A pallet in a different bin from the report](on-the-scanner/pallet-in-the-wrong-bin.md) | [PDF](on-the-scanner/pallet-in-the-wrong-bin.pdf) |
| [The wrong label in the wrong box](on-the-scanner/wrong-label-in-the-wrong-box.md) | [PDF](on-the-scanner/wrong-label-in-the-wrong-box.pdf) |
| [A very large quantity](on-the-scanner/a-big-quantity.md) | [PDF](on-the-scanner/a-big-quantity.pdf) |
| [A lot code or an expiry date](on-the-scanner/lot-and-expiry.md) | [PDF](on-the-scanner/lot-and-expiry.pdf) |
| [A comment on a pallet](on-the-scanner/comments.md) | [PDF](on-the-scanner/comments.pdf) |
| [Fixing a mistake](on-the-scanner/fixing-a-mistake.md) | [PDF](on-the-scanner/fixing-a-mistake.pdf) |
| [No Wi-Fi](on-the-scanner/no-wifi.md) | [PDF](on-the-scanner/no-wifi.pdf) |
| [Reporting a problem](on-the-scanner/report-a-problem.md) | [PDF](on-the-scanner/report-a-problem.pdf) |
| [SOS — when you need help now](on-the-scanner/sos.md) | [PDF](on-the-scanner/sos.pdf) |
| [A message from the office](on-the-scanner/message-from-the-office.md) | [PDF](on-the-scanner/message-from-the-office.pdf) |
| [Second counts](on-the-scanner/second-counts.md) | [PDF](on-the-scanner/second-counts.pdf) |
| [Finishing the aisle, and signing off](on-the-scanner/finishing-the-aisle.md) | [PDF](on-the-scanner/finishing-the-aisle.pdf) |
