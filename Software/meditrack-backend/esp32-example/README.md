# ESP32 example

A starting point, not a finished pillbox firmware. It proves the network
integration works — WiFi, the device API key, fetching the schedule as
JSON, and reporting a dose taken — and leaves the RTC-driven dispensing
logic (stepper/servo/compartment rotation) for you to fill in, since
that's specific to your hardware build.

## Before you flash anything

Test the API from your laptop first — much faster to debug than round-tripping
through the board:

```bash
# from the meditrack-backend folder, with the server running:
curl http://localhost:4000/api/device/ping -H "x-device-key: YOUR_KEY"
curl http://localhost:4000/api/device/schedule -H "x-device-key: YOUR_KEY"
```

If those don't return clean JSON, nothing on the ESP32 side will work
either — fix it here first.

## Setup

1. Arduino IDE → Boards Manager → install the **esp32** board package (Espressif Systems).
2. Library Manager → install **ArduinoJson** (by Benoit Blanchon, v6.x). `WiFi.h` and `HTTPClient.h` come with the ESP32 board package already.
3. In `meditrack_esp32.ino`, fill in:
   - `WIFI_SSID` / `WIFI_PASSWORD`
   - `SERVER_HOST` — your backend's **LAN IP**, not `localhost` (the ESP32 is a
     separate device on the network). Find it with `ipconfig`/`ifconfig` on
     the machine running the backend. Keep the backend and the ESP32 on the
     same WiFi network for local testing.
   - `DEVICE_KEY` — printed by `npm run seed`, or create a new one:
     ```bash
     curl -X POST http://localhost:4000/api/auth/devices \
       -H "Authorization: Bearer YOUR_CAREGIVER_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"name":"Pillbox 1"}'
     ```
4. Flash it, open the Serial Monitor at 115200 baud. You should see WiFi
   connect, a successful ping, and the schedule entry count.

## What's deliberately left out

- **The actual dispensing logic.** `dispenseDose()` is a stub — wire in
  your stepper (compartment rotation) and servo (release) calls, then call
  `reportTaken(scheduleId)` once the hardware has actually acted, not before.
- **Weekday matching.** The sketch only distinguishes "daily" vs. "not
  daily" as a placeholder. To fully match the backend's Mon/Wed/Fri-style
  custom schedules, parse the `days` array (when it's not the string
  `"daily"`) and compare against the ESP32's RTC weekday the same way
  `lib/schedule-utils.js` does on the server.
- **Missed-dose handling on the device.** If the device is offline past a
  scheduled time, decide what you want it to do (retry on reconnect? flash
  an LED? just let the dashboard show it as missed?) — that's a product
  decision, not a networking one.
