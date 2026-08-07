# MediTrack Backend

REST API for the MediTrack medication dashboard **and** the ESP32 pillbox.
Node.js + Express, plain-JSON file storage, JWT auth for caregivers and a
simple API key for the device.

## Setup

```bash
cd meditrack-backend
npm install
cp .env.example .env      # edit JWT_SECRET if you like
npm run seed                # demo patient, 2 caregivers, 1 device key, 4 medicines
npm start                   # http://localhost:4000
```

Demo logins (same patient, so both see and edit the same schedule):
- `demo` / `demo1234`
- `raj` / `raj12345`

The seed script also prints an ESP32 **device API key** — copy it into
`esp32-example/meditrack_esp32.ino` as `DEVICE_KEY`.

## Storage: one JSON file, on purpose

There's no database server and no SQL — `db/meditrack.json` is the entire
database, written as plain, pretty-printed JSON (`db/store.js` handles
reading/writing it). Open the file directly any time you want to see
exactly what's stored; that's the whole point, especially useful when
you're debugging the ESP32 side and want to confirm what the server
actually has without going through another layer.

**Trade-off, stated plainly:** every request reads the whole file and
writes it back synchronously. That's not safe under heavy concurrent
writes, but for a handful of caregivers plus one ESP32 device, it's more
than enough — and it means nothing extra to install or explain in a viva.

## Data model

- **patients** — the person taking medication.
- **users** — caregiver accounts. One account = one patient (someone
  caring for two patients gets two accounts, by design). No role/tier —
  every caregiver linked to a patient has full access; actions are
  attributed by username instead.
- **devices** — ESP32 pillboxes. Each has a long-lived `apiKey`, shown in
  full only once, at creation.
- **medicines** — name, compartment, pill counts, refill threshold.
- **scheduleTimes** — one row per scheduled dose. `days` is either the
  string `"daily"` or a JSON array of weekday numbers (`0`=Sun..`6`=Sat),
  e.g. `[1,3,5]` for Mon/Wed/Fri.
- **doseStatus** — one row per schedule per calendar day: taken or not,
  by whom (a caregiver's username, or a device's name), when.
- **doseLogs** — permanent history (`taken` / `missed` / `refilled` /
  `corrected` / `added` / `removed` / `schedule_updated`). `itemName` and
  `patientId` are stored directly on each row, so history survives even
  after a medicine is deleted.

Dose state (`upcoming` / `due` / `taken` / `missed`) is **computed live**
by `lib/schedule-utils.js`, not stored — a dose is `due` for 60 minutes
after its scheduled time, then flips to `missed` if still unmarked.

## Endpoints

### Dashboard (caregivers — `Authorization: Bearer <token>`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | `{patientName, username, password}` — new patient + first caregiver |
| POST | `/api/auth/login` | `{username, password}` — get a JWT |
| POST | `/api/auth/caregivers` | `{username, password}` — add another caregiver to *your* patient |
| GET | `/api/auth/caregivers` | List everyone sharing this patient's schedule |
| POST | `/api/auth/devices` | `{name}` — provision a new ESP32 key (shown once) |
| GET | `/api/auth/devices` | List devices (key masked to last 4 chars) |
| DELETE | `/api/auth/devices/:id` | Revoke a device key |
| GET / POST | `/api/medicines` | List / create medicines (nested `schedule` array) |
| PUT / DELETE | `/api/medicines/:id` | Full update or delete |
| GET | `/api/doses/today` | Today's active schedule rows, with live state |
| POST | `/api/doses/:scheduleId/taken` | Mark a dose taken (409 if already marked) |
| GET | `/api/doses/activity?limit=10` | Recent activity, each entry attributed |
| GET | `/api/reports/overview` | Stat cards |
| GET | `/api/reports/adherence?days=7` | Per-medicine adherence % |
| GET | `/api/restock` | Medicines at/below threshold |
| POST | `/api/restock/:id` | `{qty}` — record a refill |

### Device (ESP32 — `x-device-key: <key>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/device/ping` | Confirms WiFi + key work — test this first |
| GET | `/api/device/schedule` | Full schedule snapshot (not just today's) |
| POST | `/api/device/doses/:scheduleId/taken` | Report a dispensed dose |

## How the ESP32 fits in

See `esp32-example/` for a working sketch and its own README. Short
version: the device authenticates with an API key (not a login flow —
awkward on a headless board), fetches the *entire* schedule once and
periodically thereafter (so it keeps dispensing correctly through a WiFi
drop instead of needing the server reachable at the exact moment a dose is
due), and calls `taken` right after it physically dispenses. Whatever it
reports shows up in the dashboard's activity feed exactly like a
caregiver's own actions, just attributed to the device's name instead of
a username.

The `days` field is passed through unchanged — `"daily"` or e.g. `[1,3,5]`
— so the device can apply the exact same weekday rule the dashboard and
`lib/schedule-utils.js` use, rather than a separate copy of that logic
living only on the server.

## Not included yet (natural next steps)

- Automatic `missed` log entries — the API computes `missed` live for
  display, but doesn't write a `doseLogs` row for it, so adherence % only
  reflects doses actually marked taken. A daily sweep job would close this.
- The actual dispensing logic (stepper/servo/compartment rotation) and
  weekday matching on the ESP32 itself — left as a stub in the example
  sketch, since it's specific to your hardware build.
- The I²S mic + Gemini voice assistant piece.
- Role-gating (e.g. read-only caregivers) — every caregiver on a patient is
  currently fully trusted, by design.
