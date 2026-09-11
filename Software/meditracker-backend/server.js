require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html at "/"

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to your environment variables (.env locally, Render dashboard in production).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required by Neon/Render-hosted Postgres
});

async function startServer() {
  // Create tables automatically (including timing and comments)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS medicines (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      compartment TEXT NOT NULL,
      threshold INTEGER DEFAULT 5,
      "pillsFull" INTEGER DEFAULT 30,
      "pillsLeft" INTEGER DEFAULT 30,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      medicine_id INTEGER REFERENCES medicines(id) ON DELETE CASCADE,
      time TEXT NOT NULL,
      dosage TEXT NOT NULL,
      timing TEXT DEFAULT 'After Food',
      comments TEXT DEFAULT '',
      days TEXT DEFAULT 'daily'
    );

    CREATE TABLE IF NOT EXISTS dose_logs (
      id SERIAL PRIMARY KEY,
      schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE,
      medicine_id INTEGER,
      date TEXT NOT NULL,
      taken INTEGER DEFAULT 0,
      "takenAt" TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      item TEXT NOT NULL,
      action TEXT NOT NULL,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      "fullName" TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      "passwordHash" TEXT NOT NULL,
      "apiKey" TEXT NOT NULL UNIQUE,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Physical hardware note: there is exactly ONE stepper+servo door that
    -- rotates to whichever compartment needs it, so only one compartment
    -- can ever be open at a time per account's pillbox. This is the lock.
    CREATE TABLE IF NOT EXISTS door_status (
      username TEXT PRIMARY KEY,
      busy BOOLEAN NOT NULL DEFAULT false,
      compartment TEXT,
      reason TEXT,
      "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Queue of WEB-initiated (manual) open/close requests the ESP32 polls
    -- for and physically executes.
    CREATE TABLE IF NOT EXISTS door_commands (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      compartment TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe migration for databases that might lack newer columns.
  await pool.query(`
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS timing TEXT DEFAULT 'After Food';
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS comments TEXT DEFAULT '';
    ALTER TABLE medicines ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '';
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '';
  `);

  // Backfill orphaned data to default user if present
  const sivaniCheck = await pool.query(`SELECT id FROM accounts WHERE username = $1`, ['sivani']);
  if (sivaniCheck.rows.length) {
    await pool.query(`UPDATE medicines SET username = 'sivani' WHERE username = ''`);
    await pool.query(`UPDATE activity_logs SET username = 'sivani' WHERE username = ''`);
  }

  // --- ACCOUNTS & AUTHENTICATION ---

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { fullName, username, password } = req.body || {};
      if (!fullName || !String(fullName).trim()) return res.status(400).json({ error: 'Full name is required.' });
      if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
      if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

      const existing = await pool.query('SELECT id FROM accounts WHERE username = $1', [username.trim()]);
      if (existing.rows.length) return res.status(409).json({ error: 'That username is already taken.' });

      const passwordHash = bcrypt.hashSync(password, 10);
      const accountApiKey = crypto.randomBytes(16).toString('hex');

      const insertRes = await pool.query(
        `INSERT INTO accounts ("fullName", username, "passwordHash", "apiKey") VALUES ($1, $2, $3, $4) RETURNING id`,
        [fullName.trim(), username.trim(), passwordHash, accountApiKey]
      );
      const accountId = insertRes.rows[0].id;

      res.status(201).json({
        apiKey: accountApiKey,
        user: { id: accountId, fullName: fullName.trim(), username: username.trim() }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

      const result = await pool.query('SELECT * FROM accounts WHERE username = $1', [username.trim()]);
      if (!result.rows.length) return res.status(401).json({ error: 'Invalid username or password.' });
      const account = result.rows[0];

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

  async function requireApiKey(req, res, next) {
    try {
      const key = req.header('x-api-key');
      if (!key) return res.status(401).json({ error: 'Missing or invalid API key' });

      const result = await pool.query('SELECT id, username, "fullName" FROM accounts WHERE "apiKey" = $1', [key]);
      if (!result.rows.length) return res.status(401).json({ error: 'Missing or invalid API key' });

      req.account = result.rows[0];
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
  app.use('/api', requireApiKey);

  app.get('/api/device-key', (req, res) => {
    res.json({ apiKey: req.header('x-api-key'), deviceName: req.account.fullName + "'s Pillbox" });
  });

  // --- API ENDPOINTS ---

  app.get('/api/medicines', async (req, res) => {
    try {
      const medResult = await pool.query('SELECT * FROM medicines WHERE username = $1', [req.account.username]);
      const medicines = medResult.rows;

      const medIds = medicines.map(m => m.id);
      let schedules = [];
      if (medIds.length) {
        const schedResult = await pool.query(
          `SELECT * FROM schedules WHERE medicine_id = ANY($1::int[])`,
          [medIds]
        );
        schedules = schedResult.rows;
      }

      const result = medicines.map(m => {
        const medSchedules = schedules
          .filter(s => s.medicine_id === m.id)
          .map(s => {
            let days = s.days;
            try { days = JSON.parse(s.days); } catch (e) {}
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

  // Helper function to check door status and automatically auto-expire stuck locks (> 3 mins)
  async function getDoorStatus(username) {
    const result = await pool.query('SELECT * FROM door_status WHERE username = $1', [username]);
    if (!result.rows.length) {
      return { username, busy: false, compartment: null, reason: null };
    }

    const status = result.rows[0];

    // Auto-expire lock if it has been busy for more than 180 seconds (3 mins) without an explicit release
    if (status.busy && (new Date() - new Date(status.updatedAt) > 180000)) {
      await pool.query(
        `UPDATE door_status SET busy = false, compartment = NULL, reason = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE username = $1`,
        [username]
      );
      await pool.query(
        `UPDATE door_commands SET status = 'cancelled' WHERE username = $1 AND status = 'pending'`,
        [username]
      );
      return { username, busy: false, compartment: null, reason: null };
    }

    return status;
  }

  app.post('/api/medicines', async (req, res) => {
    try {
      const { name, compartment, threshold, pillsFull, pillsLeft, schedule } = req.body;

      const insertRes = await pool.query(
        `INSERT INTO medicines (username, name, compartment, threshold, "pillsFull", "pillsLeft") VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.account.username, name, compartment, threshold || 5, pillsFull || 30, pillsLeft || 30]
      );
      const medId = insertRes.rows[0].id;

      if (schedule && schedule.length) {
        for (const s of schedule) {
          const daysVal = Array.isArray(s.days) ? JSON.stringify(s.days) : (s.days || 'daily');
          await pool.query(
            `INSERT INTO schedules (medicine_id, time, dosage, timing, comments, days) VALUES ($1, $2, $3, $4, $5, $6)`,
            [medId, s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal]
          );
        }
      }

      let doorOpened = false;
      let doorBusyMessage = null;
      const status = await getDoorStatus(req.account.username);
      if (!status.busy) {
        await pool.query(
          `INSERT INTO door_status (username, busy, compartment, reason, "updatedAt") VALUES ($1, true, $2, 'manual', CURRENT_TIMESTAMP)
           ON CONFLICT (username) DO UPDATE SET busy = true, compartment = $2, reason = 'manual', "updatedAt" = CURRENT_TIMESTAMP`,
          [req.account.username, compartment]
        );
        await pool.query(
          `INSERT INTO door_commands (username, compartment, action) VALUES ($1, $2, 'open')`,
          [req.account.username, compartment]
        );
        doorOpened = true;
      } else {
        doorBusyMessage = `Compartment ${status.compartment} is currently open/in use, so ${compartment} couldn't open automatically. Open it manually from this medicine's page once the other one is closed.`;
      }

      await pool.query(
        `INSERT INTO activity_logs (username, item, action) VALUES ($1, $2, $3)`,
        [req.account.username, name, `Added to compartment ${compartment}`]
      );

      res.status(201).json({ id: medId, message: 'Medicine created successfully', doorOpened, doorBusyMessage });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/medicines/:id', async (req, res) => {
    try {
      const medId = req.params.id;
      const { name, compartment, threshold, pillsFull, pillsLeft, schedule } = req.body;

      const ownerCheck = await pool.query('SELECT id FROM medicines WHERE id = $1 AND username = $2', [medId, req.account.username]);
      if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Medicine not found' });

      await pool.query(
        `UPDATE medicines SET name = $1, compartment = $2, threshold = $3, "pillsFull" = $4, "pillsLeft" = $5 WHERE id = $6 AND username = $7`,
        [name, compartment, threshold, pillsFull, pillsLeft, medId, req.account.username]
      );

      const existingRes = await pool.query(`SELECT id FROM schedules WHERE medicine_id = $1`, [medId]);
      const existingIds = existingRes.rows.map(r => r.id);

      const keepIds = [];
      if (schedule && schedule.length) {
        for (const s of schedule) {
          const daysVal = Array.isArray(s.days) ? JSON.stringify(s.days) : (s.days || 'daily');
          const matchesExisting = s.id && existingIds.includes(Number(s.id));

          if (matchesExisting) {
            await pool.query(
              `UPDATE schedules SET time = $1, dosage = $2, timing = $3, comments = $4, days = $5 WHERE id = $6 AND medicine_id = $7`,
              [s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal, s.id, medId]
            );
            keepIds.push(Number(s.id));
          } else {
            const idRes = await pool.query(
              `INSERT INTO schedules (medicine_id, time, dosage, timing, comments, days) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [medId, s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal]
            );
            keepIds.push(idRes.rows[0].id);
          }
        }
      }

      const idsToDelete = existingIds.filter(id => !keepIds.includes(id));
      for (const id of idsToDelete) {
        await pool.query(`DELETE FROM schedules WHERE id = $1`, [id]);
      }

      await pool.query(
        `INSERT INTO activity_logs (username, item, action) VALUES ($1, $2, $3)`,
        [req.account.username, name, 'Updated medicine configuration']
      );
      res.json({ message: 'Medicine updated successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/medicines/:id/schedule/:scheduleId', async (req, res) => {
    try {
      const { id, scheduleId } = req.params;
      const ownerCheck = await pool.query('SELECT id FROM medicines WHERE id = $1 AND username = $2', [id, req.account.username]);
      if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Medicine not found' });

      await pool.query(`DELETE FROM schedules WHERE id = $1 AND medicine_id = $2`, [scheduleId, id]);
      res.json({ message: 'Schedule entry deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/medicines/:id', async (req, res) => {
    try {
      const medId = req.params.id;

      const findRes = await pool.query(`SELECT name FROM medicines WHERE id = $1 AND username = $2`, [medId, req.account.username]);
      if (!findRes.rows.length) return res.status(404).json({ error: 'Medicine not found' });
      const medName = findRes.rows[0].name;

      await pool.query(`DELETE FROM medicines WHERE id = $1 AND username = $2`, [medId, req.account.username]);
      await pool.query(
        `INSERT INTO activity_logs (username, item, action) VALUES ($1, $2, $3)`,
        [req.account.username, medName, 'Deleted medicine from system']
      );

      res.json({ message: 'Medicine deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const GRACE_MINUTES = 30;
  function timeToMinutes(t) {
    const [h, m] = String(t || '00:00').split(':').map(Number);
    return h * 60 + (m || 0);
  }

  app.get('/api/doses/today', async (req, res) => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const todayDow = now.getDay();

      const result = await pool.query(
        `
        SELECT s.id as "scheduleId", s.time, s.dosage, s.timing, s.comments, s.days,
               m.id as "medicineId", m.name as "medicineName", m.compartment,
               COALESCE(dl.taken, 0) as taken
        FROM schedules s
        JOIN medicines m ON s.medicine_id = m.id
        LEFT JOIN dose_logs dl ON dl.schedule_id = s.id AND dl.date = $1
        WHERE m.username = $2
        `,
        [todayStr, req.account.username]
      );

      const resultRows = result.rows
        .filter(r => {
          let days = r.days;
          try { days = JSON.parse(r.days); } catch (e) {}
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

      res.json(resultRows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/doses/:scheduleId/taken', async (req, res) => {
    try {
      const scheduleId = req.params.scheduleId;
      const todayStr = new Date().toISOString().split('T')[0];

      const result = await pool.query(
        `
        SELECT s.medicine_id, m.compartment FROM schedules s
        JOIN medicines m ON s.medicine_id = m.id
        WHERE s.id = $1 AND m.username = $2
        `,
        [scheduleId, req.account.username]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Schedule not found' });
      const { medicine_id: medId } = result.rows[0];

      await pool.query(
        `INSERT INTO dose_logs (schedule_id, medicine_id, date, taken, "takenAt") VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)`,
        [scheduleId, medId, todayStr]
      );

      await pool.query(`UPDATE medicines SET "pillsLeft" = GREATEST(0, "pillsLeft" - 1) WHERE id = $1`, [medId]);
      await pool.query(
        `INSERT INTO activity_logs (username, item, action) VALUES ($1, (SELECT name FROM medicines WHERE id = $2), 'Dose dispensed')`,
        [req.account.username, medId]
      );

      // Force release door lock and clear pending commands
      await pool.query(
        `UPDATE door_status SET busy = false, compartment = NULL, reason = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE username = $1`,
        [req.account.username]
      );
      await pool.query(
        `UPDATE door_commands SET status = 'cancelled' WHERE username = $1 AND status = 'pending'`,
        [req.account.username]
      );

      res.json({ message: 'Dose marked as taken and door lock released' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/restock/:id', async (req, res) => {
    try {
      const medId = req.params.id;
      const { qty } = req.body;

      const ownerCheck = await pool.query('SELECT id FROM medicines WHERE id = $1 AND username = $2', [medId, req.account.username]);
      if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Medicine not found' });

      await pool.query(`UPDATE medicines SET "pillsLeft" = $1 WHERE id = $2 AND username = $3`, [qty, medId, req.account.username]);
      await pool.query(
        `INSERT INTO activity_logs (username, item, action) VALUES ($1, (SELECT name FROM medicines WHERE id = $2), $3)`,
        [req.account.username, medId, `Restocked to ${qty} pills`]
      );

      res.json({ message: 'Compartment restocked' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- COMPARTMENT DOOR CONTROL ---

  app.get('/api/compartments/status', async (req, res) => {
    try {
      const status = await getDoorStatus(req.account.username);
      res.json({ busy: !!status.busy, compartment: status.compartment, reason: status.reason });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compartments/:compartment/open', async (req, res) => {
    try {
      const compartment = req.params.compartment;
      const status = await getDoorStatus(req.account.username);
      if (status.busy) {
        const message = status.reason === 'auto_dispense'
          ? `A dose is currently being dispensed from compartment ${status.compartment}. Please wait for it to finish, then try again.`
          : `Compartment ${status.compartment} is currently open. Please close it before opening another compartment.`;
        return res.status(409).json({ error: message });
      }

      await pool.query(
        `INSERT INTO door_status (username, busy, compartment, reason, "updatedAt") VALUES ($1, true, $2, 'manual', CURRENT_TIMESTAMP)
         ON CONFLICT (username) DO UPDATE SET busy = true, compartment = $2, reason = 'manual', "updatedAt" = CURRENT_TIMESTAMP`,
        [req.account.username, compartment]
      );
      await pool.query(
        `INSERT INTO door_commands (username, compartment, action) VALUES ($1, $2, 'open')`,
        [req.account.username, compartment]
      );

      res.json({ message: `Open command sent for compartment ${compartment}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compartments/:compartment/close', async (req, res) => {
    try {
      const compartment = req.params.compartment;
      const status = await getDoorStatus(req.account.username);
      if (!status.busy || status.compartment !== compartment) {
        return res.status(409).json({ error: `Compartment ${compartment} is not currently open.` });
      }

      await pool.query(
        `INSERT INTO door_commands (username, compartment, action) VALUES ($1, $2, 'close')`,
        [req.account.username, compartment]
      );

      res.json({ message: `Close command sent for compartment ${compartment}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/compartments/pending-command', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, compartment, action FROM door_commands WHERE username = $1 AND status = 'pending' ORDER BY id ASC LIMIT 1`,
        [req.account.username]
      );
      res.json(result.rows[0] || null);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compartments/commands/:id/ack', async (req, res) => {
    try {
      const commandId = req.params.id;
      const { success } = req.body || {};

      const cmdResult = await pool.query(
        `SELECT * FROM door_commands WHERE id = $1 AND username = $2`,
        [commandId, req.account.username]
      );
      if (!cmdResult.rows.length) return res.status(404).json({ error: 'Command not found' });
      const command = cmdResult.rows[0];

      await pool.query(`UPDATE door_commands SET status = 'done' WHERE id = $1`, [commandId]);

      const action = String(command.action).trim().toLowerCase();

      if (action === 'close' || (action === 'open' && success === false)) {
        await pool.query(
          `UPDATE door_status SET busy = false, compartment = NULL, reason = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE username = $1`,
          [req.account.username]
        );
        await pool.query(
          `UPDATE door_commands SET status = 'cancelled' WHERE username = $1 AND status = 'pending'`,
          [req.account.username]
        );
      }

      res.json({ message: 'Acknowledged' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compartments/:compartment/auto-open', async (req, res) => {
    try {
      const compartment = req.params.compartment;
      const status = await getDoorStatus(req.account.username);
      if (status.busy) {
        return res.status(409).json({ 
          error: `Compartment ${status.compartment} is currently in use.`,
          compartment: status.compartment,
          reason: status.reason,
          lockedAt: status.updatedAt
         });
      }

      await pool.query(
        `INSERT INTO door_status (username, busy, compartment, reason, "updatedAt") VALUES ($1, true, $2, 'auto_dispense', CURRENT_TIMESTAMP)
         ON CONFLICT (username) DO UPDATE SET busy = true, compartment = $2, reason = 'auto_dispense', "updatedAt" = CURRENT_TIMESTAMP`,
        [req.account.username, compartment]
      );

      res.json({ message: 'Lock acquired' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compartments/:compartment/auto-close', async (req, res) => {
    try {
      await pool.query(
        `UPDATE door_status SET busy = false, compartment = NULL, reason = NULL, "updatedAt" = CURRENT_TIMESTAMP
         WHERE username = $1`,
        [req.account.username]
      );
      await pool.query(
        `UPDATE door_commands SET status = 'cancelled' WHERE username = $1 AND status = 'pending'`,
        [req.account.username]
      );

      res.json({ message: 'Lock released' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/doses/missed-history', async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT gs.day::date AS date, s.id AS "scheduleId", s.time, s.dosage, s.days,
               m.name AS "medicineName", m.compartment,
               COALESCE(dl.taken, 0) AS taken
        FROM generate_series((CURRENT_DATE - INTERVAL '30 days')::date, CURRENT_DATE::date, INTERVAL '1 day') AS gs(day)
        JOIN schedules s ON true
        JOIN medicines m ON s.medicine_id = m.id
        LEFT JOIN dose_logs dl ON dl.schedule_id = s.id AND dl.date = gs.day::text
        WHERE m.username = $1
        ORDER BY gs.day DESC, s.time ASC
        `,
        [req.account.username]
      );

      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      const missed = result.rows
        .filter(r => {
          if (r.taken) return false;

          let days = r.days;
          try { days = JSON.parse(r.days); } catch (e) {}
          const dow = r.date.getUTCDay();
          const appliesThatDay = (days === 'daily' || !days) || (Array.isArray(days) && days.includes(dow));
          if (!appliesThatDay) return false;

          const dateStr = r.date.toISOString().split('T')[0];
          if (dateStr < todayStr) return true;
          if (dateStr === todayStr) return nowMinutes > timeToMinutes(r.time) + GRACE_MINUTES;
          return false;
        })
        .map(r => ({
          date: r.date.toISOString().split('T')[0],
          scheduleId: r.scheduleId,
          time: r.time,
          dosage: r.dosage,
          medicineName: r.medicineName,
          compartment: r.compartment
        }));

      res.json(missed);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/doses/activity', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM activity_logs WHERE username = $1 ORDER BY "createdAt" DESC LIMIT 10`,
        [req.account.username]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`MediTracker API Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
