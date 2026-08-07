// db/seed.js
// Run with `npm run seed`. Creates a demo patient, two caregiver accounts
// sharing it, one ESP32 device key, and the sample medicines — including
// one with a custom Mon/Wed/Fri schedule to prove day-filtering works.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readDB, writeDB, nextId, nowIso } = require('./store');

function run() {
  const data = readDB();

  let patient = data.patients.find((p) => p.name === 'Demo Patient');
  if (!patient) {
    patient = { id: nextId(data, 'patients'), name: 'Demo Patient', createdAt: nowIso() };
    data.patients.push(patient);
    console.log(`Created patient "Demo Patient" (id ${patient.id})`);
  } else {
    console.log(`Patient "Demo Patient" already exists (id ${patient.id}), reusing it.`);
  }

  function ensureUser(username, password) {
    let user = data.users.find((u) => u.username === username);
    if (user) return user;
    user = {
      id: nextId(data, 'users'),
      patientId: patient.id,
      username,
      passwordHash: bcrypt.hashSync(password, 10),
      createdAt: nowIso()
    };
    data.users.push(user);
    return user;
  }

  const demo = ensureUser('demo', 'demo1234');
  const raj = ensureUser('raj', 'raj12345');
  console.log(`Caregiver accounts ready: demo/demo1234 (id ${demo.id}), raj/raj12345 (id ${raj.id})`);

  let device = data.devices.find((d) => d.patientId === patient.id && d.name === 'Pillbox 1');
  if (!device) {
    device = {
      id: nextId(data, 'devices'),
      patientId: patient.id,
      name: 'Pillbox 1',
      apiKey: crypto.randomBytes(16).toString('hex'),
      createdAt: nowIso()
    };
    data.devices.push(device);
    console.log(`Created device "Pillbox 1" — API key: ${device.apiKey}`);
    console.log('Put this key in the ESP32 sketch as DEVICE_API_KEY.');
  } else {
    console.log(`Device "Pillbox 1" already exists — API key: ${device.apiKey}`);
  }

  if (data.medicines.some((m) => m.patientId === patient.id)) {
    console.log('Medicines already seeded for this patient, skipping.');
    writeDB(data);
    return;
  }

  const meds = [
    { name: 'Metformin', compartment: 'A1', pillsFull: 30, pillsLeft: 6, threshold: 8,
      schedule: [{ time: '08:00', dosage: '500mg', days: 'daily' }] },
    { name: 'Vitamin D3', compartment: 'A2', pillsFull: 30, pillsLeft: 18, threshold: 8,
      schedule: [{ time: '08:00', dosage: '1000 IU', days: 'daily' }] },
    { name: 'Amlodipine', compartment: 'B1', pillsFull: 30, pillsLeft: 3, threshold: 8,
      schedule: [{ time: '08:00', dosage: '2.5mg', days: 'daily' }, { time: '20:00', dosage: '2.5mg', days: 'daily' }] },
    { name: 'Aspirin', compartment: 'B2', pillsFull: 30, pillsLeft: 20, threshold: 8,
      schedule: [{ time: '20:00', dosage: '75mg', days: [1, 3, 5] }] } // Mon/Wed/Fri
  ];

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = nowIso(new Date(Date.now() - 86400000));

  meds.forEach((m) => {
    const medicine = {
      id: nextId(data, 'medicines'),
      patientId: patient.id,
      name: m.name,
      compartment: m.compartment,
      pillsFull: m.pillsFull,
      pillsLeft: m.pillsLeft,
      threshold: m.threshold,
      createdAt: nowIso()
    };
    data.medicines.push(medicine);

    const scheduleIds = m.schedule.map((s) => {
      const sched = {
        id: nextId(data, 'scheduleTimes'),
        medicineId: medicine.id,
        time: s.time,
        dosage: s.dosage,
        days: s.days,
        createdAt: nowIso()
      };
      data.scheduleTimes.push(sched);
      data.doseLogs.push({
        id: nextId(data, 'doseLogs'), patientId: patient.id, medicineId: medicine.id,
        scheduleId: sched.id, itemName: m.name, action: 'taken', qty: 1, by: demo.username,
        createdAt: yesterday
      });
      return sched.id;
    });

    // Only Metformin and Vitamin D3 start "already taken today", so the
    // Track page shows a mix of taken/upcoming/due/missed states.
    if (m.name === 'Metformin' || m.name === 'Vitamin D3') {
      const firstSchedId = scheduleIds[0];
      data.doseStatus.push({
        id: nextId(data, 'doseStatus'), scheduleId: firstSchedId, date: today,
        taken: true, takenByName: demo.username, takenAt: nowIso()
      });
      data.doseLogs.push({
        id: nextId(data, 'doseLogs'), patientId: patient.id, medicineId: medicine.id,
        scheduleId: firstSchedId, itemName: m.name, action: 'taken', qty: 1, by: demo.username,
        createdAt: nowIso()
      });
    }
  });

  writeDB(data);
  console.log(`Seeded ${meds.length} medicines for patient id ${patient.id}.`);
}

run();
