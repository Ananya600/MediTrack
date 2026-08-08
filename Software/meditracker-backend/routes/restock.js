// routes/restock.js
const express = require('express');
const { readDB, writeDB, nextId, nowIso } = require('../db/store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/restock
router.get('/', (req, res) => {
  const data = readDB();
  const rows = data.medicines
    .filter((m) => m.pillsLeft <= m.threshold)
    .sort((a, b) => (a.pillsLeft - a.threshold) - (b.pillsLeft - b.threshold));
  res.json(rows);
});

// POST /api/restock/:medicineId  { qty }
router.post('/:medicineId', (req, res) => {
  const data = readDB();
  const med = data.medicines.find((m) => m.id === +req.params.medicineId);
  if (!med) return res.status(404).json({ error: 'Medicine not found.' });

  const qty = Math.max(+((req.body || {}).qty) || (med.pillsFull - med.pillsLeft), 1);
  med.pillsLeft = Math.min(med.pillsLeft + qty, med.pillsFull);

  data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: med.id, scheduleId: null, itemName: med.name, action: 'refilled', qty, by: req.user.username, createdAt: nowIso() });

  writeDB(data);
  res.json(med);
});

module.exports = router;
