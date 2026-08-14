# MediTrack — Smart Pillbox

**Team Pill-Pal** · GIRLATHON 4.0 · Track: Hardware · Topic: FemTech and Healthcare Innovation

**🔗 Live demo:** [meditrack-6m2m.onrender.com](https://meditrack-6m2m.onrender.com/)

> Traditional pillboxes and even most "smart" ones rely on visual cues —
> labels, screens, blinking lights. MediTrack is built the other way around:
> a physical pillbox that opens the *correct compartment at the correct
> time* on its own, confirms the pill was actually taken with a weight
> sensor, and guides the user to the right compartment with vibration —
> so a visually impaired or elderly user never has to read anything to
> take their medicine correctly.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
  - [Software (Dashboard + API)](#software-dashboard--api)
  - [Hardware (Pillbox)](#hardware-pillbox)
- [API Reference](#api-reference)
- [Screenshots & Demo](#screenshots--demo)
- [Roadmap](#roadmap)
- [Team](#team)
- [License](#license)

---

## Overview

MediTrack has two halves that talk to each other:

1. **The pillbox (hardware)** — an RTC-timed, servo-driven compartment
   wheel that physically opens the right slot at the right time, with a
   vibration motor to guide the user by touch and a weight sensor to
   confirm the dose was removed. A microcontroller running **WiFiManager**
   handles first-time WiFi setup via a captive portal ("MediTrack-Setup"),
   so no hardcoded WiFi credentials are needed in the firmware.
2. **The dashboard (software)** — a web app for the patient/caregiver to
   configure medicines and schedules, see what's due right now, confirm or
   review doses, and get low-pill refill alerts. This is what's deployed
   at the live demo link above.

The two sides are connected over WiFi: the pillbox syncs its schedule from
the backend and reports dispensing/weight-sensor events back to it, so the
web dashboard always reflects what the physical device has actually done.

## Features

- 📅 **Schedule management** — add medicines, map them to physical
  compartments, and set multiple dose times per day (daily or specific
  weekdays).
- ⏱ **Live dose tracking** — each scheduled dose shows as upcoming, due,
  missed, or taken, computed against the current time.
- 🔔 **Missed-dose visibility** — a dedicated view for anything not taken
  in its scheduled window, so a caregiver can follow up.
- 🧴 **Refill alerts** — compartments below a configurable pill-count
  threshold surface on a Restock page.
- 📋 **Compartment/activity log** — manual notes (refills, maintenance,
  observations) alongside an automatic log of dispense events.
- 📶 **Captive-portal WiFi setup** on the hardware side, so the pillbox can
  be configured for a new network without re-flashing firmware.

## Tech Stack

**Frontend**
- HTML5 / CSS3 / vanilla JavaScript (no framework — single-page dashboard)
- Google Fonts (Quicksand, Nunito)

**Backend**
- Node.js + Express (REST API)
- JSON-file persistence (`db.json`), written atomically to avoid data loss
  on crash or redeploy
- CORS for local dev

**Hardware**
- Microcontroller with WiFi (ESP32/ESP8266-class) running **WiFiManager**
  for network provisioning
- RTC module (real-time clock) for schedule timing
- Servo motor(s) driving the compartment-select mechanism
- Prototype enclosure: cardboard + card-stock compartment wheel (proof of
  concept housing, ahead of a 3D-printed/molded enclosure)
- A `python_bridge` component connecting the microcontroller to the
  backend/local dev environment during development and testing (serial
  ↔ HTTP bridging) — see [Hardware](#hardware-pillbox) below

**Deployment**
- **Render** — the backend (and the dashboard it serves) is deployed as a
  Render Web Service: [meditrack-6m2m.onrender.com](https://meditrack-6m2m.onrender.com/)

## Getting Started

### Software (Dashboard + API)

**Prerequisites:** Node.js 18+ and npm.

```bash
git clone https://github.com/<your-org>/MediTrack.git
cd MediTrack/Software/meditracker-backend
npm install
npm start
```

The server starts on `http://localhost:4000` (or `4000`/`3001` depending on
which backend variant is in the repo — check the `PORT` in `server.js`) and
serves the dashboard from the same URL, so there's nothing separate to run
for the frontend.

> **Windows / PowerShell users:** if `npm install` fails with a
> `running scripts is disabled on this system` error, PowerShell is
> blocking script execution by default. Either run the commands from
> **Command Prompt** instead, or allow scripts for the current session with:
> ```powershell
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
> ```

**Data persistence:** all medicines, schedules, and dose history are stored
in `db.json` next to `server.js`. It's created automatically (empty) on
first run and is never overwritten on restart — only read and atomically
updated — so nothing added through the dashboard is lost between deploys.

**Deploying your own copy to Render:**
1. Push this repo to GitHub.
2. In Render, create a **Web Service** pointed at the repo, with:
   - Build command: `npm install`
   - Start command: `npm start`
3. Attach a **Render Disk** and mount it where `db.json` lives — Render's
   default filesystem is ephemeral between deploys, so without a disk any
   data added after deploying would be lost the next time the service
   redeploys.
4. Once live, update the pillbox firmware / `python_bridge` config to point
   at your Render URL instead of `localhost`.

### Hardware (Pillbox)

**Components used in the current prototype:**
- Microcontroller (WiFi-capable), breadboard, jumper wires
- 1× micro servo (compartment rotation)
- RTC module
- Vibration motor
- Weight sensor
- Cardboard/card-stock compartment wheel and housing (prototype enclosure)

**First-time setup:**
1. Power on the pillbox. On first boot (or after a WiFi reset), it starts a
   WiFi access point named **`MediTrack-Setup`**.
2. From a phone or laptop, connect to that access point.
3. A captive portal (WiFiManager) should open automatically, or navigate to
   `192.168.4.1` manually — this is the same screen shown in the setup
   screenshots in this repo.
4. Tap **Configure WiFi**, select your home/venue network, enter the
   password, and save. The device will reboot and connect to that network.
5. Once connected, the device syncs its schedule from the backend
   (`API_BASE` configured in firmware) and begins operating on its own.

**`python_bridge`:** during development, this script mediates between the
microcontroller (over serial) and the backend API (over HTTP) — useful for
bench-testing dispense/weight-sensor logic without needing full WiFi
round-trips. See that folder's own instructions for exact usage once
finalized.

## API Reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/medicines` | List all medicines with their schedules |
| `POST` | `/api/medicines` | Add a medicine + schedule |
| `PUT` | `/api/medicines/:id` | Update a medicine / reconcile its schedule |
| `DELETE` | `/api/medicines/:id` | Remove a medicine |
| `GET` | `/api/doses/today` | Today's doses with computed status (upcoming/due/missed/taken) |
| `POST` | `/api/doses/:scheduleId/taken` | Mark a dose as dispensed |
| `GET` | `/api/doses/activity` | Recent activity log |
| `POST` | `/api/restock/:id` | Update a compartment's pill count after a refill |

## Screenshots & Demo

- Prototype compartment wheel + servo + breadboard wiring (bench test)
- WiFiManager captive portal (`MediTrack-Setup`) for network provisioning

- Dashboard codebase running in the dev environment

## Roadmap

- [x] Dashboard UI (Overview, Track, Manage, Restock, Missed, History)
- [x] Persistent backend (Express + JSON file)
- [x] Deployed to Render
- [x] Persistent disk on Render for `db.json` (prevents data loss on redeploy)
- [x] Firmware ↔ backend sync over WiFi in the field (beyond bench testing)
- [ ] Move from cardboard prototype to a 3D-printed/molded enclosure
- [ ] Camera module for refill/prescription verification (per original
      abstract)
- [ ] Caregiver notifications (push/SMS) for missed doses

## Team

**Pill-Pal**
- K. Ananya Ramesh
- Megha Baiju
- Sivani Balagopal
