# Procedures by role

One short SOP per role, each covering only what that login (or that gun) can do, in the order
the job happens. The full manual is `../SOP.md` / `../SOP.pdf`; these are its working parts.

| Role | Login profile | File |
|---|---|---|
| Admin | Admin — everything, Settings included | [admin.md](admin.md) · [PDF](admin.pdf) |
| Supervisor | Supervisor — everything a supervisor can | [supervisor.md](supervisor.md) · [PDF](supervisor.pdf) |
| Inventory controller | Inventory control — the count, adjustments, downloads | [inventory-control.md](inventory-control.md) · [PDF](inventory-control.pdf) |
| Count supervisor | Count supervisor — runs the floor | [count-supervisor.md](count-supervisor.md) · [PDF](count-supervisor.pdf) |
| Warehouse jobs | Warehouse jobs — front bins, Not in Location, cycle counts | [warehouse-jobs.md](warehouse-jobs.md) · [PDF](warehouse-jobs.pdf) |
| Cycle counter | Cycle counter — cycle counts only | [cycle-counter.md](cycle-counter.md) · [PDF](cycle-counter.pdf) |
| Counter | a scanner, no login | [counter.md](counter.md) · [PDF](counter.pdf) |

Rebuild the PDFs with `node tools/sop-pdf.mjs --roles`.
