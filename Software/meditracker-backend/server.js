const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

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
      item TEXT NOT NULL,
      action TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Safe migration check for existing databases that might lack timing/comments columns
  try {
    db.run(`ALTER TABLE schedules ADD COLUMN timing TEXT DEFAULT 'After Food'`);
  } catch (e) { /* Column likely already exists */ }
  try {
    db.run(`ALTER TABLE schedules ADD COLUMN comments TEXT DEFAULT ''`);
  } catch (e) { /* Column likely already exists */ }

  saveDatabase();

  // --- API ENDPOINTS ---

  // GET: Fetch all medicines with schedules (including timing and comments)
  app.get('/api/medicines', (req, res) => {
    try {
      const medStmt = db.prepare("SELECT * FROM medicines");
      const medicines = [];
      while (medStmt.step()) medicines.push(medStmt.getAsObject());
      medStmt.free();

      const schedStmt = db.prepare("SELECT * FROM schedules");
      const schedules = [];
      while (schedStmt.step()) schedules.push(schedStmt.getAsObject());
      schedStmt.free();

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
        `INSERT INTO medicines (name, compartment, threshold, pillsFull, pillsLeft) VALUES (?, ?, ?, ?, ?)`,
        [name, compartment, threshold || 5, pillsFull || 30, pillsLeft || 30]
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

      db.run(`INSERT INTO activity_logs (item, action) VALUES (?, ?)`, [name, `Added to compartment ${compartment}`]);
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

      db.run(
        `UPDATE medicines SET name = ?, compartment = ?, threshold = ?, pillsFull = ?, pillsLeft = ? WHERE id = ?`,
        [name, compartment, threshold, pillsFull, pillsLeft, medId]
      );

      // Re-sync schedules cleanly
      db.run(`DELETE FROM schedules WHERE medicine_id = ?`, [medId]);

      if (schedule && schedule.length) {
        schedule.forEach(s => {
          const daysVal = Array.isArray(s.days) ? JSON.stringify(s.days) : (s.days || 'daily');
          db.run(
            `INSERT INTO schedules (medicine_id, time, dosage, timing, comments, days) VALUES (?, ?, ?, ?, ?, ?)`,
            [medId, s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal]
          );
        });
      }

      db.run(`INSERT INTO activity_logs (item, action) VALUES (?, ?)`, [name, 'Updated medicine configuration']);
      saveDatabase();
      res.json({ message: 'Medicine updated successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE: Delete a specific schedule item
  app.delete('/api/medicines/:id/schedule/:scheduleId', (req, res) => {
    try {
      const { id, scheduleId } = req.params;
      db.run(`DELETE FROM schedules WHERE id = ? AND medicine_id = ?`, [scheduleId, id]);
      saveDatabase();
      res.json({ message: 'Schedule entry deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE: Delete medicine entirely
  app.delete('/api/medicines/:id', (req, res) => {
    try {
      const medId = req.params.id;
      
      const stmt = db.prepare(`SELECT name FROM medicines WHERE id = ?`);
      stmt.bind([medId]);
      let medName = 'Medicine';
      if (stmt.step()) {
        medName = stmt.getAsObject().name;
      }
      stmt.free();

      db.run(`DELETE FROM medicines WHERE id = ?`, [medId]);
      db.run(`INSERT INTO activity_logs (item, action) VALUES (?, ?)`, [medName, 'Deleted medicine from system']);
      
      saveDatabase();
      res.json({ message: 'Medicine deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: Fetch today's doses (includes timing and comments context)
  app.get('/api/doses/today', (req, res) => {
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      const currentTime = new Date().toTimeString().slice(0, 5);

      const stmt = db.prepare(`
        SELECT s.id as scheduleId, s.time, s.dosage, s.timing, s.comments, m.id as medicineId, m.name as medicineName, m.compartment,
               COALESCE(dl.taken, 0) as taken
        FROM schedules s
        JOIN medicines m ON s.medicine_id = m.id
        LEFT JOIN dose_logs dl ON dl.schedule_id = s.id AND dl.date = ?
      `);
      stmt.bind([todayStr]);

      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();

      const result = rows.map(r => {
        let state = 'upcoming';
        if (r.taken) state = 'taken';
        else if (r.time < currentTime) state = 'missed';
        else state = 'due';

        return { ...r, state, taken: Boolean(r.taken) };
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

      const stmt = db.prepare(`SELECT medicine_id FROM schedules WHERE id = ?`);
      stmt.bind([scheduleId]);
      
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
      db.run(`INSERT INTO activity_logs (item, action) VALUES ((SELECT name FROM medicines WHERE id = ?), 'Dose dispensed')`, [medId]);

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

      db.run(`UPDATE medicines SET pillsLeft = ? WHERE id = ?`, [qty, medId]);
      db.run(`INSERT INTO activity_logs (item, action) VALUES ((SELECT name FROM medicines WHERE id = ?), ?)`, [medId, `Restocked to ${qty} pills`]);

      saveDatabase();
      res.json({ message: 'Compartment restocked' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET: Fetch activity logs
  app.get('/api/doses/activity', (req, res) => {
    try {
      const stmt = db.prepare(`SELECT * FROM activity_logs ORDER BY createdAt DESC LIMIT 10`);
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