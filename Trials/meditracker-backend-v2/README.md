# MediTracker backend (Pill Box Dashboard)

Matches the frontend that hardcodes `API_BASE = 'http://localhost:4000/api'`
and has no auth headers — so this server runs on port `4000` and doesn't
require a login token. Sign-in in that frontend is cosmetic only (it never
calls an API), so anyone with the page open can use the console; add real
auth later if that matters for your setup.

## Fixes applied to the frontend you shared

1. **Unclosed `<input>` tag** for `editCompartment` — was missing its closing
   `>`, which broke the rest of that form's markup. Fixed in `public/index.html`.
2. **Schedule IDs were dropped on "Save Changes"** — the Manage page's save
   handler rebuilt the schedule array from the DOM without each row's `id`,
   so every save recreated all of that medicine's schedule rows (only the
   single-row modal edit preserved `id`). Fixed in `public/script.js`: it now
   looks up each row's original `id` by position before submitting, so
   "Save Changes" updates existing rows instead of replacing them — meaning
   today's dispensed/missed status for that medicine survives an edit.

## Setup

```bash
cd meditracker-backend-v2
npm install
npm start
```

Open `http://localhost:4000` — that's both the frontend and the API.

## Persistence

Same approach as before: `db.js` only creates a default `db.json` (empty
medicine list) if the file doesn't already exist. Every write goes to a temp
file and gets renamed over `db.json`, so nothing added through the UI is
ever silently overwritten by a restart.

## API

| Method | Path                         | Purpose                                      |
|--------|------------------------------|-----------------------------------------------|
| GET    | `/api/medicines`             | all medicines, each with its `schedule` array |
| POST   | `/api/medicines`             | create a medicine + schedule                  |
| PUT    | `/api/medicines/:id`         | update a medicine, reconcile its schedule     |
| DELETE | `/api/medicines/:id`         | remove a medicine                             |
| GET    | `/api/doses/today`           | today's doses with computed `state`           |
| POST   | `/api/doses/:scheduleId/taken` | mark a dose dispensed today                 |
| GET    | `/api/doses/activity`        | recent activity feed                          |
| POST   | `/api/restock/:id`           | `{qty}` → set the compartment's pill count    |

`state` on a dose is one of `upcoming`, `due`, `missed`, or `taken`,
computed server-side using the server's local clock and a 60-minute grace
window after the scheduled time before a dose flips to `missed`.

## Data file

`db.json` next to `server.js`:

```
meta          — autoincrement counters
medicines     — id, name, compartment, pillsFull, pillsLeft, threshold
scheduleTimes — id, medicineId, time, dosage, timing, comments, days
doseStatus    — per (scheduleId, date) whether it was marked dispensed
activity      — recent log entries (added / dispensed / refilled / etc.)
```

## Note on "Compartment Log" (history) page

That page's entries (`historyLogs`) are still kept in the browser only — the
frontend never sends them to the API. If you want those persisted too
(refills/maintenance notes surviving a refresh), say the word and I'll add a
`/api/history` endpoint and wire the form up to it the same way.
