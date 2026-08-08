const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

function buildDefaultDb() {
  return {
    meta: { nextId: { medicines: 1, scheduleTimes: 1, doseStatus: 1, activity: 1 } },
    medicines: [],
    scheduleTimes: [],
    doseStatus: [],   // {id, scheduleId, date, taken, takenAt}
    activity: []       // {id, item, action, createdAt}
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DB_PATH)) {
    cache = buildDefaultDb();
    saveSync(cache);
    console.log('[db] No db.json found — created a fresh one with an empty medicine list.');
  } else {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  }
  return cache;
}

function saveSync(data) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

let writeQueue = Promise.resolve();
function persist() {
  writeQueue = writeQueue.then(() => saveSync(cache));
  return writeQueue;
}

function nextId(entity) {
  const db = load();
  const id = db.meta.nextId[entity] || 1;
  db.meta.nextId[entity] = id + 1;
  return id;
}

module.exports = { load, persist, nextId, DB_PATH };
