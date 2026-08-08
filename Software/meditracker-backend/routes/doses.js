// routes/doses.js
const express = require('express');
const { readDB, writeDB, nextId, nowIso } = require('../db/store');
const { requireAuth } = require('../middleware/auth');
const { todayDate, isScheduledToday, doseState } = require('../lib/schedule-utils');

const router = express.Router();
router.use(requireAuth);

function todaysRows(data) {
  const date = todayDate();
  const medById = Object.fromEntries(data.medicines.map((m) => [m.id, m]));

  return data.scheduleTimes
    .filter((s) => medById[s.medicineId] && isScheduledToday(s.days))
    .map((s) => {
      const status = data.doseStatus.find((ds) => ds.scheduleId === s.id && ds.date === date);
      const med = medById[s.medicineId];
      return {
        scheduleId: s.id, medicineId: med.id, medicineName: med.name,
        dosage: s.dosage, time: s.time, days: s.days, compartment: med.compartment,
        taken: !!(status && status.taken), takenBy: status ? status.takenByName : null, takenAt: status ? status.takenAt : null
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

// GET /api/doses/today
router.get('/today', (req, res) => {
  const data = readDB();
  res.json(todaysRows(data).map((r) => ({ ...r, state: doseState(r) })));
});

// POST /api/doses/:scheduleId/taken
router.post('/:scheduleId/taken', (req, res) => {
  const data = readDB();
  const sched = data.scheduleTimes.find((s) => s.id === +req.params.scheduleId);
  const med = sched && data.medicines.find((m) => m.id === sched.medicineId);
  if (!sched || !med) return res.status(404).json({ error: 'Scheduled dose not found.' });

  const date = todayDate();
  let status = data.doseStatus.find((ds) => ds.scheduleId === sched.id && ds.date === date);
  if (status && status.taken) return res.status(409).json({ error: 'Already marked taken today.' });

  const nowStamp = nowIso();
  if (status) {
    status.taken = true; status.takenByName = req.user.username; status.takenAt = nowStamp;
  } else {
    status = { id: nextId(data, 'doseStatus'), scheduleId: sched.id, date, taken: true, takenByName: req.user.username, takenAt: nowStamp };
    data.doseStatus.push(status);
  }

  med.pillsLeft = Math.max(med.pillsLeft - 1, 0);
  data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: med.id, scheduleId: sched.id, itemName: med.name, action: 'taken', qty: 1, by: req.user.username, createdAt: nowStamp });

  writeDB(data);
  res.json({ scheduleId: sched.id, medicineId: med.id, state: 'taken', takenBy: req.user.username, takenAt: nowStamp });
});

// GET /api/doses/activity?limit=10
router.get('/activity', (req, res) => {
  const limit = Math.min(Math.max(+req.query.limit || 10, 1), 50);
  const data = readDB();
  const rows = data.doseLogs
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id))
    .slice(0, limit)
    .map((l) => ({ id: l.id, item: l.itemName, action: l.action, qty: l.qty, by: l.by, createdAt: l.createdAt }));
  res.json(rows);
});

module.exports = router;
