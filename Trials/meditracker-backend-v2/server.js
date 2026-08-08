const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const GRACE_MINUTES = 60; // how long after the scheduled time a dose stays "due" before flipping to "missed"

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- helpers ----------------
function nowStamp() { return new Date().toISOString(); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function timeToMinutes(t) { const [h, m] = String(t || '00:00').split(':').map(Number); return h * 60 + (m || 0); }

function isScheduledToday(sched) {
  if (sched.days === 'daily' || !sched.days) return true;
  const today = new Date().getDay(); // 0=Sun..6=Sat, matches the frontend's day chips
  return Array.isArray(sched.days) && sched.days.includes(today);
}

function scheduleTimesFor(state, medicineId) {
  return state.scheduleTimes.filter((s) => s.medicineId === medicineId);
}

function medicineWithSchedule(state, med) {
  return { ...med, schedule: scheduleTimesFor(state, med.id) };
}

function logActivity(state, item, action) {
  state.activity.unshift({ id: db.nextId('activity'), item, action, createdAt: nowStamp() });
  state.activity = state.activity.slice(0, 100); // keep the file from growing forever
}

// ---------------- medicines ----------------
app.get('/api/medicines', (req, res) => {
  const state = db.load();
  res.json(state.medicines.map((m) => medicineWithSchedule(state, m)));
});

app.post('/api/medicines', (req, res) => {
  const { name, compartment, pillsFull, pillsLeft, threshold, schedule } = req.body || {};
  if (!name || !compartment || !(pillsFull > 0)) {
    return res.status(400).json({ error: 'name, compartment, and pillsFull are required.' });
  }
  const state = db.load();
  const medicine = {
    id: db.nextId('medicines'),
    name: String(name).trim(),
    compartment: String(compartment).trim(),
    pillsFull: Number(pillsFull),
    pillsLeft: Math.min(Number(pillsLeft ?? pillsFull), Number(pillsFull)),
    threshold: Number(threshold ?? 0),
    createdAt: nowStamp()
  };
  state.medicines.push(medicine);

  (Array.isArray(schedule) ? schedule : []).forEach((s) => {
    state.scheduleTimes.push({
      id: db.nextId('scheduleTimes'),
      medicineId: medicine.id,
      time: s.time,
      dosage: s.dosage || '',
      timing: s.timing || 'After Food',
      comments: s.comments || '',
      days: s.days === 'daily' ? 'daily' : Array.isArray(s.days) ? s.days : 'daily'
    });
  });

  logActivity(state, medicine.name, 'added');
  db.persist();
  res.status(201).json(medicineWithSchedule(state, medicine));
});

app.put('/api/medicines/:id', (req, res) => {
  const id = Number(req.params.id);
  const state = db.load();
  const medicine = state.medicines.find((m) => m.id === id);
  if (!medicine) return res.status(404).json({ error: 'Medicine not found.' });

  const { name, compartment, pillsFull, pillsLeft, threshold, schedule } = req.body || {};
  if (!name || !compartment || !(pillsFull > 0)) {
    return res.status(400).json({ error: 'name, compartment, and pillsFull are required.' });
  }

  medicine.name = String(name).trim();
  medicine.compartment = String(compartment).trim();
  medicine.pillsFull = Number(pillsFull);
  if (pillsLeft != null) medicine.pillsLeft = Math.min(Math.max(Number(pillsLeft), 0), medicine.pillsFull);
  medicine.threshold = Number(threshold ?? medicine.threshold);

  // Reconcile schedule rows: rows with a matching numeric id are updated in
  // place (this is what keeps today's dose-taken status intact). Rows with
  // no id, or an id that no longer matches anything, are created fresh.
  // Any existing row not present in the submitted array gets removed, along
  // with its doseStatus history (nothing to attribute it to any more).
  const keepIds = new Set();
  (Array.isArray(schedule) ? schedule : []).forEach((s) => {
    const existing = s.id ? state.scheduleTimes.find((row) => row.id === Number(s.id) && row.medicineId === id) : null;
    if (existing) {
      existing.time = s.time;
      existing.dosage = s.dosage || '';
      existing.timing = s.timing || existing.timing;
      existing.comments = s.comments || '';
      existing.days = s.days === 'daily' ? 'daily' : Array.isArray(s.days) ? s.days : 'daily';
      keepIds.add(existing.id);
      return;
    }
    const created = {
      id: db.nextId('scheduleTimes'),
      medicineId: id,
      time: s.time,
      dosage: s.dosage || '',
      timing: s.timing || 'After Food',
      comments: s.comments || '',
      days: s.days === 'daily' ? 'daily' : Array.isArray(s.days) ? s.days : 'daily'
    };
    state.scheduleTimes.push(created);
    keepIds.add(created.id);
  });
  const removedIds = state.scheduleTimes.filter((row) => row.medicineId === id && !keepIds.has(row.id)).map((r) => r.id);
  state.scheduleTimes = state.scheduleTimes.filter((row) => row.medicineId !== id || keepIds.has(row.id));
  state.doseStatus = state.doseStatus.filter((d) => !removedIds.includes(d.scheduleId));

  logActivity(state, medicine.name, 'schedule updated');
  db.persist();
  res.json(medicineWithSchedule(state, medicine));
});

app.delete('/api/medicines/:id', (req, res) => {
  const id = Number(req.params.id);
  const state = db.load();
  const medicine = state.medicines.find((m) => m.id === id);
  if (!medicine) return res.status(404).json({ error: 'Medicine not found.' });

  const scheduleIds = scheduleTimesFor(state, id).map((s) => s.id);
  state.medicines = state.medicines.filter((m) => m.id !== id);
  state.scheduleTimes = state.scheduleTimes.filter((s) => s.medicineId !== id);
  state.doseStatus = state.doseStatus.filter((d) => !scheduleIds.includes(d.scheduleId));

  logActivity(state, medicine.name, 'removed');
  db.persist();
  res.status(204).end();
});

// ---------------- doses ----------------
app.get('/api/doses/today', (req, res) => {
  const state = db.load();
  const date = todayStr();
  const rows = [];

  state.medicines.forEach((med) => {
    scheduleTimesFor(state, med.id).filter(isScheduledToday).forEach((sched) => {
      const rec = state.doseStatus.find((d) => d.scheduleId === sched.id && d.date === date);
      const taken = !!(rec && rec.taken);
      let doseState = 'upcoming';
      if (!taken) {
        const now = nowMinutes();
        const due = timeToMinutes(sched.time);
        if (now >= due && now <= due + GRACE_MINUTES) doseState = 'due';
        else if (now > due + GRACE_MINUTES) doseState = 'missed';
      }
      rows.push({
        scheduleId: sched.id,
        medicineId: med.id,
        medicineName: med.name,
        dosage: sched.dosage,
        time: sched.time,
        compartment: med.compartment,
        taken,
        state: taken ? 'taken' : doseState
      });
    });
  });

  rows.sort((a, b) => a.time.localeCompare(b.time));
  res.json(rows);
});

app.post('/api/doses/:scheduleId/taken', (req, res) => {
  const scheduleId = Number(req.params.scheduleId);
  const state = db.load();
  const sched = state.scheduleTimes.find((s) => s.id === scheduleId);
  if (!sched) return res.status(404).json({ error: 'Schedule entry not found.' });
  const medicine = state.medicines.find((m) => m.id === sched.medicineId);
  const date = todayStr();

  let record = state.doseStatus.find((d) => d.scheduleId === scheduleId && d.date === date);
  if (record && record.taken) return res.status(409).json({ error: 'Already marked dispensed today.' });
  if (!record) {
    record = { id: db.nextId('doseStatus'), scheduleId, date, taken: false, takenAt: null };
    state.doseStatus.push(record);
  }
  record.taken = true;
  record.takenAt = nowStamp();

  if (medicine) medicine.pillsLeft = Math.max(medicine.pillsLeft - 1, 0);
  logActivity(state, medicine ? medicine.name : 'Unknown', 'dispensed');

  db.persist();
  res.json(record);
});

app.get('/api/doses/activity', (req, res) => {
  const state = db.load();
  res.json(state.activity.slice(0, 30));
});

// ---------------- restock ----------------
// qty here is treated as "pills now in the compartment" (the form defaults
// to full capacity), not an amount to add — matching what the frontend's
// restock input pre-fills.
app.post('/api/restock/:id', (req, res) => {
  const id = Number(req.params.id);
  const { qty } = req.body || {};
  const state = db.load();
  const medicine = state.medicines.find((m) => m.id === id);
  if (!medicine) return res.status(404).json({ error: 'Medicine not found.' });
  if (!(qty >= 0)) return res.status(400).json({ error: 'qty must be a non-negative number.' });

  medicine.pillsLeft = Math.min(Number(qty), medicine.pillsFull);
  logActivity(state, medicine.name, 'refilled');

  db.persist();
  res.json(medicine);
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  db.load();
  console.log(`MediTracker backend running at http://localhost:${PORT}`);
  console.log(`Data file: ${db.DB_PATH}`);
});
