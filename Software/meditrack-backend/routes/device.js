// routes/device.js
//
// Endpoints the ESP32 actually talks to. Deliberately small and flat —
// three endpoints, no nesting, easy to reason about from C++ and easy to
// test from a browser or curl before you ever touch the board.
//
// Design choice: /schedule returns the FULL schedule (not just today's),
// so the device can compute its own due/missed state locally from its RTC
// and keep dispensing correctly even if WiFi drops. It only needs to talk
// to the server to (a) occasionally refresh the schedule and (b) report a
// dose as taken after it physically dispenses.

const express = require('express');
const { readDB, writeDB, nextId, nowIso } = require('../db/store');
const { requireDevice } = require('../middleware/device-auth');
const { todayDate } = require('../lib/schedule-utils');

const router = express.Router();
router.use(requireDevice);

// GET /api/device/ping — hit this first when wiring up the sketch, to
// confirm WiFi + the API key work before writing any scheduling logic.
router.get('/ping', (req, res) => {
  res.json({ status: 'ok', deviceName: req.device.name, patientId: req.device.patientId });
});

// GET /api/device/schedule — everything the device needs to run
// standalone: one flat array, one object per scheduled dose.
router.get('/schedule', (req, res) => {
  const data = readDB();
  const medicines = data.medicines.filter((m) => m.patientId === req.device.patientId);
  const medById = Object.fromEntries(medicines.map((m) => [m.id, m]));

  const rows = data.scheduleTimes
    .filter((s) => medById[s.medicineId])
    .map((s) => {
      const med = medById[s.medicineId];
      return {
        scheduleId: s.id,
        medicineId: med.id,
        medicineName: med.name,
        compartment: med.compartment,
        time: s.time,
        dosage: s.dosage,
        days: s.days,          // 'daily' or e.g. [1,3,5] — device applies the same weekday rule as the dashboard
        pillsLeft: med.pillsLeft,
        threshold: med.threshold
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time));

  res.json(rows);
});

// POST /api/device/doses/:scheduleId/taken — call this right after the
// device physically dispenses a dose. Same effect as the dashboard's
// "Mark taken" button, just attributed to the device instead of a person.
router.post('/doses/:scheduleId/taken', (req, res) => {
  const data = readDB();
  const sched = data.scheduleTimes.find((s) => s.id === +req.params.scheduleId);
  const med = sched && data.medicines.find((m) => m.id === sched.medicineId && m.patientId === req.device.patientId);
  if (!sched || !med) return res.status(404).json({ error: 'Scheduled dose not found.' });

  const date = todayDate();
  let status = data.doseStatus.find((ds) => ds.scheduleId === sched.id && ds.date === date);
  if (status && status.taken) {
    return res.status(409).json({ error: 'Already marked taken today.' });
  }

  const nowStamp = nowIso();
  if (status) {
    status.taken = true; status.takenByName = req.device.name; status.takenAt = nowStamp;
  } else {
    status = {
      id: nextId(data, 'doseStatus'), scheduleId: sched.id, date,
      taken: true, takenByName: req.device.name, takenAt: nowStamp
    };
    data.doseStatus.push(status);
  }

  med.pillsLeft = Math.max(med.pillsLeft - 1, 0);

  data.doseLogs.push({
    id: nextId(data, 'doseLogs'), patientId: req.device.patientId, medicineId: med.id, scheduleId: sched.id,
    itemName: med.name, action: 'taken', qty: 1, by: req.device.name, createdAt: nowStamp
  });

  writeDB(data);
  res.json({ scheduleId: sched.id, pillsLeft: med.pillsLeft, takenAt: nowStamp });
});

module.exports = router;
