// routes/reports.js
const express = require('express');
const { readDB } = require('../db/store');
const { requireAuth } = require('../middleware/auth');
const { todayDate, isScheduledToday, daysPerWeek, doseState } = require('../lib/schedule-utils');

const router = express.Router();
router.use(requireAuth);

function adherenceByMedicine(data, patientId, days = 7) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const meds = data.medicines.filter((m) => m.patientId === patientId);

  return meds.map((m) => {
    const logs = data.doseLogs.filter((l) => l.medicineId === m.id && l.createdAt >= cutoff);
    const taken = logs.filter((l) => l.action === 'taken').length;
    const missed = logs.filter((l) => l.action === 'missed').length;
    const total = taken + missed;
    const adherence = total === 0 ? 100 : Math.round((taken / total) * 100);
    return { id: m.id, name: m.name, adherence };
  });
}

function todaysStates(data, patientId) {
  const date = todayDate();
  const medIds = new Set(data.medicines.filter((m) => m.patientId === patientId).map((m) => m.id));
  return data.scheduleTimes
    .filter((s) => medIds.has(s.medicineId) && isScheduledToday(s.days))
    .map((s) => {
      const status = data.doseStatus.find((ds) => ds.scheduleId === s.id && ds.date === date);
      return doseState({ time: s.time, taken: !!(status && status.taken) });
    });
}

// GET /api/reports/adherence?days=7
router.get('/adherence', (req, res) => {
  const days = Math.min(Math.max(+req.query.days || 7, 1), 90);
  const data = readDB();
  res.json(adherenceByMedicine(data, req.user.patientId, days));
});

// GET /api/reports/overview
router.get('/overview', (req, res) => {
  const data = readDB();
  const patientId = req.user.patientId;

  const totalMedicines = data.medicines.filter((m) => m.patientId === patientId).length;

  const states = todaysStates(data, patientId);
  const takenToday = states.filter((s) => s === 'taken').length;
  const pendingToday = states.filter((s) => s === 'upcoming' || s === 'due').length;
  const missedToday = states.filter((s) => s === 'missed').length;

  const weekCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const weekLogs = data.doseLogs.filter((l) => l.patientId === patientId && l.createdAt >= weekCutoff);
  const dosesThisWeek = weekLogs.filter((l) => l.action === 'taken').length;
  const missedThisWeek = weekLogs.filter((l) => l.action === 'missed').length;

  const needRestock = data.medicines.filter((m) => m.patientId === patientId && m.pillsLeft <= m.threshold).length;

  const medIds = new Set(data.medicines.filter((m) => m.patientId === patientId).map((m) => m.id));
  const expectedDosesPerWeek = data.scheduleTimes
    .filter((s) => medIds.has(s.medicineId))
    .reduce((sum, s) => sum + daysPerWeek(s.days), 0);

  const perMedicine = adherenceByMedicine(data, patientId, 7);
  const avgAdherence = perMedicine.length
    ? Math.round(perMedicine.reduce((s, m) => s + m.adherence, 0) / perMedicine.length)
    : 100;

  res.json({
    totalMedicines, takenToday, pendingToday, missedToday,
    dosesThisWeek, missedThisWeek, expectedDosesPerWeek, needRestock,
    avgAdherence, perMedicineAdherence: perMedicine
  });
});

module.exports = router;
