// db/store.js
//
// The whole database is one JSON file (db/meditrack.json). No SQL, no
// native dependencies to compile — you can open the file directly in an
// editor to see exactly what's in it, which is the whole point: simple to
// read, simple to troubleshoot.
//
// Trade-off, stated plainly: every request reads the whole file, mutates
// it in memory, and writes it back synchronously. That's not safe under
// heavy concurrent writes, but for a handful of caregivers plus one ESP32
// device, it's more than enough, and it means there's no separate database
// process to install, run, or explain in a viva.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'meditrack.json');

const EMPTY_DB = {
  meta: {
    nextId: {
      patients: 1, users: 1, devices: 1, medicines: 1,
      scheduleTimes: 1, doseStatus: 1, doseLogs: 1
    }
  },
  patients: [],       // { id, name, createdAt }
  users: [],          // { id, patientId, username, passwordHash, createdAt }
  devices: [],        // { id, patientId, name, apiKey, createdAt }
  medicines: [],       // { id, patientId, name, compartment, pillsFull, pillsLeft, threshold, createdAt }
  scheduleTimes: [],  // { id, medicineId, time, dosage, days, createdAt }  days: 'daily' | [0-6,...]
  doseStatus: [],      // { id, scheduleId, date, taken, takenByName, takenAt }
  doseLogs: []          // { id, patientId, medicineId, scheduleId, itemName, action, qty, by, createdAt }
};

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    writeDB(EMPTY_DB);
    return JSON.parse(JSON.stringify(EMPTY_DB));
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeDB(data) {
  // Pretty-printed on purpose — this file is meant to be opened and read.
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Returns the next id for a collection and bumps the counter. Caller is
// responsible for calling writeDB(data) afterwards to persist the bump.
function nextId(data, collection) {
  const id = data.meta.nextId[collection];
  data.meta.nextId[collection] = id + 1;
  return id;
}

function nowIso(date) {
  // 'YYYY-MM-DD HH:MM:SS' in UTC — plain and sortable as a string, which
  // matters here since dates are compared as strings throughout.
  return (date || new Date()).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { readDB, writeDB, nextId, nowIso, DB_PATH };
