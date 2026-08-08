// db/seed.js
// Run with `npm run seed`. Creates the single account (from .env —
// ADMIN_USERNAME/ADMIN_PASSWORD), one ESP32 device key, and sample
// medicines including a custom Mon/Wed/Fri schedule.

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readDB, writeDB, nextId, nowIso } = require('./store');

function run() {
  const data = readDB();

  if (data.account) {
    console.log(`Account "${data.account.username}" already exists, reusing it.`);
  } else {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    data.account = { username, passwordHash: bcrypt.hashSync(password, 10), createdAt: nowIso() };
    console.log(`Created account "${username}" / "${password}" — change this password in production.`);
  }

  let device = data.devices.find((d) => d.name === 'Pillbox 1');
  if (!device) {
    device = { id: nextId(data, 'devices'), name: 'Pillbox 1', apiKey: crypto.randomBytes(16).toString('hex'), createdAt: nowIso() };
    data.devices.push(device);
    console.log(`Created device "Pillbox 1" — API key: ${device.apiKey}`);
    console.log('Put this key in the ESP32 sketch as DEVICE_API_KEY.');
  } else {
    console.log(`Device "Pillbox 1" already exists — API key: ${device.apiKey}`);
  }

  if (data.medicines.length > 0) {
    console.log('Medicines already seeded, skipping.');
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
  const who = data.account.username;

  meds.forEach((m) => {
    const medicine = {
      id: nextId(data, 'medicines'), name: m.name, compartment: m.compartment,
      pillsFull: m.pillsFull, pillsLeft: m.pillsLeft, threshold: m.threshold, createdAt: nowIso()
    };
    data.medicines.push(medicine);

    const scheduleIds = m.schedule.map((s) => {
      const sched = { id: nextId(data, 'scheduleTimes'), medicineId: medicine.id, time: s.time, dosage: s.dosage, days: s.days, createdAt: nowIso() };
      data.scheduleTimes.push(sched);
      data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: medicine.id, scheduleId: sched.id, itemName: m.name, action: 'taken', qty: 1, by: who, createdAt: yesterday });
      return sched.id;
    });

    if (m.name === 'Metformin' || m.name === 'Vitamin D3') {
      const firstSchedId = scheduleIds[0];
      data.doseStatus.push({ id: nextId(data, 'doseStatus'), scheduleId: firstSchedId, date: today, taken: true, takenByName: who, takenAt: nowIso() });
      data.doseLogs.push({ id: nextId(data, 'doseLogs'), medicineId: medicine.id, scheduleId: firstSchedId, itemName: m.name, action: 'taken', qty: 1, by: who, createdAt: nowIso() });
    }
  });

  writeDB(data);
  console.log(`Seeded ${meds.length} medicines.`);
}

run();
