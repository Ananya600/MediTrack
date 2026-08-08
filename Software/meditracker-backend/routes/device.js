// routes/device.js
//
// This is the ESP32's entire interface to the system. Three endpoints:
// ping (confirm the key works), schedule (pull everything it needs to run
// standalone), and taken (report a dispensed dose back). Since there's
// only one account's worth of medicine data now, there's no scoping to
// think about here at all — the device just gets everything.

const express = require('express');
const { readDB, writeDB, nextId, nowIso } = require('../db/store');
const { requireDevice } = require('../middleware/device-auth');
const { todayDate } = require('../lib/schedule-utils');

const router = express.Router();
router.use(requireDevice);

// GET /api/device/ping
router.get('/ping', (req, res) => {
  res.json({ status: 'ok', deviceName: req.device.name });
});

// GET /api/device/schedule — full snapshot, not just today's, so the
// device can run off its own RTC between refreshes.
router.get('/schedule', (req, res) => {
  const data = readDB();
  const medById = Object.fromEntries(data.medicines.map((m) => [m.id, m]));

  const rows = data.scheduleTimes
    .filter((s) => medById[s.medicineId])
    .map((s) => {
      const med = medById[s.medicineId];
      return {
        scheduleId: s.id, medicineId: med.id, medicineName: med.name, compartment: med.compartment,
        time: s.time, dosage: s.dosage, days: s.days, pillsLeft: med.pillsLeft, threshold: med.threshold
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time));

  res.json(rows);
});

// POST /api/device/doses/:scheduleId/taken
router.post('/doses/:scheduleId/taken', (req, res) => {
  const data = readDB();
  const sched = data.scheduleTimes.find((s) => s.id === +req.params.scheduleId);
  const med = sched && data.medicines.find((m) => m.id === sched.medicineId);
  if (!sched || !med) return res.status(404).json({ error: 'Scheduled dose not found.' });

  const date = todayDate();
  let status = data.doseStatus.find((ds) => ds.scheduleId === sched.id && ds.date === date);
  if (status && status.taken) return res.status(409).json({ error: 'Already marked taken today.' });

  const nowStamp = nowIso();
  if (status) {
    status.taken = true; status.takenByName = req.device.name; status.takenAt = nowStamp;
  } else {
    status = { id: nextId(data, 'doseStatus'), scheduleId: sched.id, date, taken: true, takenByName: req.device.name, takenAt: nowStamp };
    data.doseStatus.push(status);
  }

  med.pillsLeft = Math.max(med.pillsLeft - 1, 0);
  data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: med.id, scheduleId: sched.id, itemName: med.name, action: 'taken', qty: 1, by: req.device.name, createdAt: nowStamp });

  writeDB(data);
  res.json({ scheduleId: sched.id, pillsLeft: med.pillsLeft, takenAt: nowStamp });
});

module.exports = router;
