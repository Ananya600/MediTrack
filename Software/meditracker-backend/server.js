const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html at "/"

const dbFilePath = path.join(__dirname, 'meditracker.db');

async function startServer() {
  const SQL = await initSqlJs();
  let db;

  // Load existing database file if present, otherwise create a new one
  if (fs.existsSync(dbFilePath)) {
    const fileBuffer = fs.readFileSync(dbFilePath);
    db = new SQL.Database(fileBuffer);
    console.log('Loaded existing database from meditracker.db');
  } else {
    db = new SQL.Database();
    console.log('Created new SQLite database');
  }

  // Save database back to disk on every write
  function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFilePath, buffer);
  }

  // Create tables automatically (including timing and comments)
  db.run(`
    CREATE TABLE IF NOT EXISTS medicines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      compartment TEXT NOT NULL,
      threshold INTEGER DEFAULT 5,
      pillsFull INTEGER DEFAULT 30,
      pillsLeft INTEGER DEFAULT 30,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medicine_id INTEGER,
      time TEXT NOT NULL,
      dosage TEXT NOT NULL,
      timing TEXT DEFAULT 'After Food',
      comments TEXT DEFAULT '',
      days TEXT DEFAULT 'daily',
      FOREIGN KEY(medicine_id) REFERENCES medicines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dose_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER,
      medicine_id INTEGER,
      date TEXT NOT NULL,
      taken INTEGER DEFAULT 0,
      takenAt DATETIME,
      FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL DEFAULT '',
      item TEXT NOT NULL,
      action TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fullName TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      apiKey TEXT NOT NULL UNIQUE,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Safe migration check for existing databases that might lack newer columns
  try {
    db.run(`ALTER TABLE schedules ADD COLUMN timing TEXT DEFAULT 'After Food'`);
  } catch (e) { /* Column likely already exists */ }
  try {
    db.run(`ALTER TABLE schedules ADD COLUMN comments TEXT DEFAULT ''`);
  } catch (e) { /* Column likely already exists */ }
  try {
    db.run(`ALTER TABLE medicines ADD COLUMN username TEXT NOT NULL DEFAULT ''`);
  } catch (e) { /* Column likely already exists */ }
  try {
    db.run(`ALTER TABLE activity_logs ADD COLUMN username TEXT NOT NULL DEFAULT ''`);
  } catch (e) { /* Column likely already exists */ }

  // One-time backfill: medicines/activity created before accounts existed
  // got stamped with username = '' by the migration above, which makes
  // them invisible to every route now that everything is ownership-scoped.
  // Assign that orphaned data to sivani. Safe to leave in permanently —
  // once there's nothing left with username = '', these are no-ops.
  const sivaniCheck = db.prepare(`SELECT id FROM accounts WHERE username = ?`);
  sivaniCheck.bind(['sivani']);
  if (sivaniCheck.step()) {
    db.run(`UPDATE medicines SET username = 'sivani' WHERE username = ''`);
    db.run(`UPDATE activity_logs SET username = 'sivani' WHERE username = ''`);
  }
  sivaniCheck.free();

  saveDatabase();

  // --- ACCOUNTS: real login, backed by this same database file — no
  // separate auth service, no cloud DB. Each account gets its own
  // permanent apiKey at creation time, so it never changes on a redeploy
  // the way the single shared device key could if its row ever got lost.
  //
  // These two routes are intentionally public (same reasoning /device-key
  // used to have): you can't send a key you don't have yet. Everything
  // else, including /api/device-key now, requires one.
  app.post('/api/auth/register', (req, res) => {
    try {
      const { fullName, username, password } = req.body || {};
      if (!fullName || !String(fullName).trim()) return res.status(400).json({ error: 'Full name is required.' });
      if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
      if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

      const existing = db.prepare('SELECT id FROM accounts WHERE username = ?');
      existing.bind([username.trim()]);
      const taken = existing.step();
      existing.free();
      if (taken) return res.status(409).json({ error: 'That username is already taken.' });

      const passwordHash = bcrypt.hashSync(password, 10);
      const accountApiKey = crypto.randomBytes(16).toString('hex');

      db.run(
        `INSERT INTO accounts (fullName, username, passwordHash, apiKey) VALUES (?, ?, ?, ?)`,
        [fullName.trim(), username.trim(), passwordHash, accountApiKey]
      );
      const idRes = db.exec('SELECT last_insert_rowid() as id');
      const accountId = idRes[0].values[0][0];
      saveDatabase();

      res.status(201).json({
        apiKey: accountApiKey,
        user: { id: accountId, fullName: fullName.trim(), username: username.trim() }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

      const stmt = db.prepare('SELECT * FROM accounts WHERE username = ?');
      stmt.bind([username.trim()]);
      if (!stmt.step()) {
        stmt.free();
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
      const account = stmt.getAsObject();
      stmt.free();

      if (!bcrypt.compareSync(password, account.passwordHash)) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      res.json({
        apiKey: account.apiKey,
        user: { id: account.id, fullName: account.fullName, username: account.username }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Everything below this line requires a valid key. There's no separate
  // shared device key any more — each account's own permanent apiKey IS
  // its ESP32 key too, so a pillbox and its dashboard always resolve to
  // the same account and only ever see that account's data.
  function requireApiKey(req, res, next) {
    const key = req.header('x-api-key');
    if (!key) return res.status(401).json({ error: 'Missing or invalid API key' });

    const stmt = db.prepare('SELECT id, username, fullName FROM accounts WHERE apiKey = ?');
    stmt.bind([key]);
    if (!stmt.step()) {
      stmt.free();
      return res.status(401).json({ error: 'Missing or invalid API key' });
    }
    req.account = stmt.getAsObject();
    stmt.free();
    next();
  }
  app.use('/api', requireApiKey);

  // Echoes back whichever account the request's key belongs to — the
  // dashboard uses this to show the same key on the Device Setup page
  // that the ESP32 should be paired with.
  app.get('/api/device-key', (req, res) => {
    res.json({ apiKey: req.header('x-api-key'), deviceName: req.account.fullName + "'s Pillbox" });
  });

  // --- API ENDPOINTS ---

  // GET: Fetch all medicines with schedules (including timing and comments)
  // — scoped to the logged-in account, never another account's data.
  app.get('/api/medicines', (req, res) => {
    try {
      const medStmt = db.prepare("SELECT * FROM medicines WHERE username = ?");
      medStmt.bind([req.account.username]);
      const medicines = [];
      while (medStmt.step()) medicines.push(medStmt.getAsObject());
      medStmt.free();

      const medIds = medicines.map(m => m.id);
      const schedules = [];
      if (medIds.length) {
        const placeholders = medIds.map(() => '?').join(',');
        const schedStmt = db.prepare(`SELECT * FROM schedules WHERE medicine_id IN (${placeholders})`);
        schedStmt.bind(medIds);
        while (schedStmt.step()) schedules.push(schedStmt.getAsObject());
        schedStmt.free();
      }

      const result = medicines.map(m => {
        const medSchedules = schedules
          .filter(s => s.medicine_id === m.id)
          .map(s => {
            let days = s.days;
            try { days = JSON.parse(s.days); } catch(e){}
            return { 
              id: s.id, 
              time: s.time, 
              dosage: s.dosage, 
              timing: s.timing || 'After Food', 
              comments: s.comments || '', 
              days 
            };
          });
        return { ...m, schedule: medSchedules };
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: Add new medicine (with schedule timing and comments)
  app.post('/api/medicines', (req, res) => {
    try {
      const { name, compartment, threshold, pillsFull, pillsLeft, schedule } = req.body;

      db.run(
        `INSERT INTO medicines (username, name, compartment, threshold, pillsFull, pillsLeft) VALUES (?, ?, ?, ?, ?, ?)`,
        [req.account.username, name, compartment, threshold || 5, pillsFull || 30, pillsLeft || 30]
      );

      const resId = db.exec("SELECT last_insert_rowid() as id");
      const medId = resId[0].values[0][0];

      if (schedule && schedule.length) {
        schedule.forEach(s => {
          const daysVal = Array.isArray(s.days) ? JSON.stringify(s.days) : (s.days || 'daily');
          db.run(
            `INSERT INTO schedules (medicine_id, time, dosage, timing, comments, days) VALUES (?, ?, ?, ?, ?, ?)`,
            [medId, s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal]
          );
        });
      }

      db.run(`INSERT INTO activity_logs (username, item, action) VALUES (?, ?, ?)`, [req.account.username, name, `Added to compartment ${compartment}`]);
      saveDatabase();

      res.status(201).json({ id: medId, message: 'Medicine created successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: Update medicine and cleanly sync schedules (with timing and comments)
  app.put('/api/medicines/:id', (req, res) => {
    try {
      const medId = req.params.id;
      const { name, compartment, threshold, pillsFull, pillsLeft, schedule } = req.body;

      const ownerCheck = db.prepare('SELECT id FROM medicines WHERE id = ? AND username = ?');
      ownerCheck.bind([medId, req.account.username]);
      const owns = ownerCheck.step();
      ownerCheck.free();
      if (!owns) return res.status(404).json({ error: 'Medicine not found' });

      db.run(
        `UPDATE medicines SET name = ?, compartment = ?, threshold = ?, pillsFull = ?, pillsLeft = ? WHERE id = ? AND username = ?`,
        [name, compartment, threshold, pillsFull, pillsLeft, medId, req.account.username]
      );

      // Reconcile schedules instead of wiping and recreating them: a row
      // whose submitted id matches an existing row for this medicine is
      // updated in place, so today's dose_logs (taken/missed status) stay
      // attached to it. Rows with no id, or an id that doesn't match, are
      // inserted fresh. Any existing row not present in the submitted list
      // is removed.
      const existingStmt = db.prepare(`SELECT id FROM schedules WHERE medicine_id = ?`);
      existingStmt.bind([medId]);
      const existingIds = [];
      while (existingStmt.step()) existingIds.push(existingStmt.getAsObject().id);
      existingStmt.free();

      const keepIds = [];
      if (schedule && schedule.length) {
        schedule.forEach(s => {
          const daysVal = Array.isArray(s.days) ? JSON.stringify(s.days) : (s.days || 'daily');
          const matchesExisting = s.id && existingIds.includes(Number(s.id));

          if (matchesExisting) {
            db.run(
              `UPDATE schedules SET time = ?, dosage = ?, timing = ?, comments = ?, days = ? WHERE id = ? AND medicine_id = ?`,
              [s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal, s.id, medId]
            );
            keepIds.push(Number(s.id));
          } else {
            db.run(
              `INSERT INTO schedules (medicine_id, time, dosage, timing, comments, days) VALUES (?, ?, ?, ?, ?, ?)`,
              [medId, s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal]
            );
            const idRes = db.exec("SELECT last_insert_rowid() as id");
            keepIds.push(idRes[0].values[0][0]);
          }
        });
      }

      existingIds
        .filter(id => !keepIds.includes(id))
        .forEach(id => db.run(`DELETE FROM schedules WHERE id = ?`, [id]));

      db.run(`INSERT INTO activity_logs (username, item, action) VALUES (?, ?, ?)`, [req.account.username, name, 'Updated medicine configuration']);
      saveDatabase();
      res.json({ message: 'Medicine updated successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE: Delete a specific schedule item — only if the parent medicine
  // belongs to this account.
  app.delete('/api/medicines/:id/schedule/:scheduleId', (req, res) => {
    try {
      const { id, scheduleId } = req.params;
      const ownerCheck = db.prepare('SELECT id FROM medicines WHERE id = ? AND username = ?');
      ownerCheck.bind([id, req.account.username]);
      const owns = ownerCheck.step();
      ownerCheck.free();
      if (!owns) return res.status(404).json({ error: 'Medicine not found' });

      db.run(`DELETE FROM schedules WHERE id = ? AND medicine_id = ?`, [scheduleId, id]);
      saveDatabase();
      res.json({ message: 'Schedule entry deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE: Delete medicine entirely — only this account's own
  app.delete('/api/medicines/:id', (req, res) => {
    try {
      const medId = req.params.id;

      const stmt = db.prepare(`SELECT name FROM medicines WHERE id = ? AND username = ?`);
      stmt.bind([medId, req.account.username]);
      if (!stmt.step()) {
        stmt.free();
        return res.status(404).json({ error: 'Medicine not found' });
      }
      const medName = stmt.getAsObject().name;
      stmt.free();

      db.run(`DELETE FROM medicines WHERE id = ? AND username = ?`, [medId, req.account.username]);
      db.run(`INSERT INTO activity_logs (username, item, action) VALUES (?, ?, ?)`, [req.account.username, medName, 'Deleted medicine from system']);
      
      saveDatabase();
      res.json({ message: 'Medicine deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: Fetch today's doses (includes timing and comments context)
  // Filters to schedules actually due today (daily, or matching day-of-week),
  // and gives a "due" grace window before flipping a dose to "missed".
  const GRACE_MINUTES = 30;
  function timeToMinutes(t) {
    const [h, m] = String(t || '00:00').split(':').map(Number);
    return h * 60 + (m || 0);
  }

  app.get('/api/doses/today', (req, res) => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const todayDow = now.getDay(); // 0=Sun..6=Sat, matches the frontend's day chips

      const stmt = db.prepare(`
        SELECT s.id as scheduleId, s.time, s.dosage, s.timing, s.comments, s.days, m.id as medicineId, m.name as medicineName, m.compartment,
               COALESCE(dl.taken, 0) as taken
        FROM schedules s
        JOIN medicines m ON s.medicine_id = m.id
        LEFT JOIN dose_logs dl ON dl.schedule_id = s.id AND dl.date = ?
        WHERE m.username = ?
      `);
      stmt.bind([todayStr, req.account.username]);

      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();

      const result = rows
        .filter(r => {
          let days = r.days;
          try { days = JSON.parse(r.days); } catch (e) { /* leave as-is, e.g. 'daily' */ }
          if (days === 'daily' || !days) return true;
          return Array.isArray(days) && days.includes(todayDow);
        })
        .map(r => {
          const taken = Boolean(r.taken);
          let state = 'upcoming';
          if (!taken) {
            const due = timeToMinutes(r.time);
            if (nowMinutes >= due && nowMinutes <= due + GRACE_MINUTES) state = 'due';
            else if (nowMinutes > due + GRACE_MINUTES) state = 'missed';
          }
          const { days, ...rest } = r;
          return { ...rest, state: taken ? 'taken' : state, taken };
        });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: Mark dose taken
  app.post('/api/doses/:scheduleId/taken', (req, res) => {
    try {
      const scheduleId = req.params.scheduleId;
      const todayStr = new Date().toISOString().split('T')[0];

      const stmt = db.prepare(`
        SELECT s.medicine_id FROM schedules s
        JOIN medicines m ON s.medicine_id = m.id
        WHERE s.id = ? AND m.username = ?
      `);
      stmt.bind([scheduleId, req.account.username]);

      if (!stmt.step()) {
        stmt.free();
        return res.status(404).json({ error: 'Schedule not found' });
      }
      
      const medId = stmt.getAsObject().medicine_id;
      stmt.free();

      db.run(
        `INSERT INTO dose_logs (schedule_id, medicine_id, date, taken, takenAt) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`,
        [scheduleId, medId, todayStr]
      );

      db.run(`UPDATE medicines SET pillsLeft = MAX(0, pillsLeft - 1) WHERE id = ?`, [medId]);
      db.run(`INSERT INTO activity_logs (username, item, action) VALUES (?, (SELECT name FROM medicines WHERE id = ?), 'Dose dispensed')`, [req.account.username, medId]);

      saveDatabase();
      res.json({ message: 'Dose marked as taken' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: Restock
  app.post('/api/restock/:id', (req, res) => {
    try {
      const medId = req.params.id;
      const { qty } = req.body;

      const ownerCheck = db.prepare('SELECT id FROM medicines WHERE id = ? AND username = ?');
      ownerCheck.bind([medId, req.account.username]);
      const owns = ownerCheck.step();
      ownerCheck.free();
      if (!owns) return res.status(404).json({ error: 'Medicine not found' });

      db.run(`UPDATE medicines SET pillsLeft = ? WHERE id = ? AND username = ?`, [qty, medId, req.account.username]);
      db.run(`INSERT INTO activity_logs (username, item, action) VALUES (?, (SELECT name FROM medicines WHERE id = ?), ?)`, [req.account.username, medId, `Restocked to ${qty} pills`]);

      saveDatabase();
      res.json({ message: 'Compartment restocked' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: Fetch activity logs
  app.get('/api/doses/activity', (req, res) => {
    try {
      const stmt = db.prepare(`SELECT * FROM activity_logs WHERE username = ? ORDER BY createdAt DESC LIMIT 10`);
      stmt.bind([req.account.username]);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`MediTracker API Server running on http://localhost:${PORT}`);
  });
}

startServer();