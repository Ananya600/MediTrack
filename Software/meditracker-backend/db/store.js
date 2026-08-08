// db/store.js
//
// One JSON file, one account. This isn't a multi-patient/multi-caregiver
// system — it's a single medicine tracker (one pillbox, one household)
// with one login protecting it. Every collection here is medicine data;
// there's nothing patient- or caregiver-shaped left to model.
//
// Trade-off, stated plainly: every request reads the whole file, mutates
// it in memory, and writes it back synchronously. Fine for one account and
// one device; not a design for many concurrent writers.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'meditrack.json');

const EMPTY_DB = {
  meta: {
    nextId: { devices: 1, medicines: 1, scheduleTimes: 1, doseStatus: 1, doseLogs: 1 }
  },
  account: null,       // { username, passwordHash, createdAt } — exactly one, set by seed
  devices: [],          // { id, name, apiKey, createdAt } — ESP32 pillboxes
  medicines: [],         // { id, name, compartment, pillsFull, pillsLeft, threshold, createdAt }
  scheduleTimes: [],    // { id, medicineId, time, dosage, days, createdAt }  days: 'daily' | [0-6,...]
  doseStatus: [],         // { id, scheduleId, date, taken, takenByName, takenAt }
  doseLogs: []              // { id, medicineId, scheduleId, itemName, action, qty, by, createdAt }
};

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    writeDB(EMPTY_DB);
    return JSON.parse(JSON.stringify(EMPTY_DB));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); // pretty-printed on purpose — meant to be opened and read
}

function nextId(data, collection) {
  const id = data.meta.nextId[collection];
  data.meta.nextId[collection] = id + 1;
  return id;
}

function nowIso(date) {
  // 'YYYY-MM-DD HH:MM:SS' UTC — matters that every timestamp in this file
  // uses this exact shape, since dates are compared as plain strings.
  return (date || new Date()).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { readDB, writeDB, nextId, nowIso, DB_PATH };
