// routes/medicines.js
const express = require('express');
const { readDB, writeDB, nextId, nowIso } = require('../db/store');
const { requireAuth } = require('../middleware/auth');
const { daysOverlap } = require('../lib/schedule-utils');

const router = express.Router();
router.use(requireAuth);

function withSchedule(data, medicine) {
  const schedule = data.scheduleTimes
    .filter((s) => s.medicineId === medicine.id)
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((s) => ({ id: s.id, time: s.time, dosage: s.dosage, days: s.days }));
  return { ...medicine, schedule };
}

function validateMedicinePayload(body) {
  const { name, compartment, pillsFull, pillsLeft, threshold, schedule } = body;

  if (!name || !String(name).trim()) return 'name is required.';
  if (!compartment || !String(compartment).trim()) return 'compartment is required.';
  if (!(Number(pillsFull) > 0)) return 'pillsFull must be greater than 0.';
  if (Number(pillsLeft) < 0 || Number(pillsLeft) > Number(pillsFull)) return 'pillsLeft must be between 0 and pillsFull.';
  if (Number(threshold) < 0 || Number(threshold) > Number(pillsFull)) return 'threshold must be between 0 and pillsFull.';
  if (!Array.isArray(schedule) || schedule.length === 0) return 'At least one scheduled time is required.';

  for (const s of schedule) {
    if (!s.time) return 'Every scheduled dose needs a time.';
    if (!s.dosage || !String(s.dosage).trim()) return 'Every scheduled dose needs a dosage amount.';
    const days = s.days === 'daily' ? 'daily' : s.days;
    if (days !== 'daily' && (!Array.isArray(days) || days.length === 0)) return 'Choose "daily" or at least one weekday for every scheduled dose.';
    if (Array.isArray(days) && days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Weekday values must be integers 0 (Sun) through 6 (Sat).';
  }
  for (let i = 0; i < schedule.length; i++) {
    for (let j = i + 1; j < schedule.length; j++) {
      if (schedule[i].time === schedule[j].time && daysOverlap(schedule[i].days, schedule[j].days)) {
        return 'Two scheduled doses share the same time on an overlapping day.';
      }
    }
  }
  return null;
}

// GET /api/medicines
router.get('/', (req, res) => {
  const data = readDB();
  res.json(data.medicines.map((m) => withSchedule(data, m)));
});

// GET /api/medicines/:id
router.get('/:id', (req, res) => {
  const data = readDB();
  const med = data.medicines.find((m) => m.id === +req.params.id);
  if (!med) return res.status(404).json({ error: 'Medicine not found.' });
  res.json(withSchedule(data, med));
});

// POST /api/medicines
router.post('/', (req, res) => {
  const err = validateMedicinePayload(req.body || {});
  if (err) return res.status(400).json({ error: err });

  const { name, compartment, pillsFull, pillsLeft, threshold, schedule } = req.body;
  const data = readDB();

  const medicine = {
    id: nextId(data, 'medicines'), name: name.trim(), compartment: compartment.trim(),
    pillsFull: Number(pillsFull), pillsLeft: Number(pillsLeft), threshold: Number(threshold), createdAt: nowIso()
  };
  data.medicines.push(medicine);

  schedule.forEach((s) => {
    data.scheduleTimes.push({ id: nextId(data, 'scheduleTimes'), medicineId: medicine.id, time: s.time, dosage: s.dosage.trim(), days: s.days, createdAt: nowIso() });
  });

  data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: medicine.id, scheduleId: null, itemName: medicine.name, action: 'added', qty: 0, by: req.user.username, createdAt: nowIso() });

  writeDB(data);
  res.status(201).json(withSchedule(data, medicine));
});

// PUT /api/medicines/:id
router.put('/:id', (req, res) => {
  const data = readDB();
  const med = data.medicines.find((m) => m.id === +req.params.id);
  if (!med) return res.status(404).json({ error: 'Medicine not found.' });

  const err = validateMedicinePayload(req.body || {});
  if (err) return res.status(400).json({ error: err });

  const { name, compartment, pillsFull, pillsLeft, threshold, schedule } = req.body;
  const correctionDiff = Number(pillsLeft) - med.pillsLeft;

  med.name = name.trim();
  med.compartment = compartment.trim();
  med.pillsFull = Number(pillsFull);
  med.pillsLeft = Number(pillsLeft);
  med.threshold = Number(threshold);

  if (correctionDiff !== 0) {
    data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: med.id, scheduleId: null, itemName: med.name, action: 'corrected', qty: correctionDiff, by: req.user.username, createdAt: nowIso() });
  }

  data.scheduleTimes = data.scheduleTimes.filter((s) => s.medicineId !== med.id);
  schedule.forEach((s) => {
    data.scheduleTimes.push({ id: nextId(data, 'scheduleTimes'), medicineId: med.id, time: s.time, dosage: s.dosage.trim(), days: s.days, createdAt: nowIso() });
  });

  data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: med.id, scheduleId: null, itemName: med.name, action: 'schedule_updated', qty: 0, by: req.user.username, createdAt: nowIso() });

  writeDB(data);
  res.json(withSchedule(data, med));
});

// DELETE /api/medicines/:id — history is kept (itemName is baked into each log row)
router.delete('/:id', (req, res) => {
  const data = readDB();
  const med = data.medicines.find((m) => m.id === +req.params.id);
  if (!med) return res.status(404).json({ error: 'Medicine not found.' });

  data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: null, scheduleId: null, itemName: med.name, action: 'removed', qty: 0, by: req.user.username, createdAt: nowIso() });

  const scheduleIds = data.scheduleTimes.filter((s) => s.medicineId === med.id).map((s) => s.id);
  data.scheduleTimes = data.scheduleTimes.filter((s) => s.medicineId !== med.id);
  data.doseStatus = data.doseStatus.filter((ds) => !scheduleIds.includes(ds.scheduleId));
  data.medicines = data.medicines.filter((m) => m.id !== med.id);

  writeDB(data);
  res.status(204).send();
});

module.exports = router;
