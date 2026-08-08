require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// --- REQUIRED ENV VARS ---
// DATABASE_URL - provided automatically by Render when you attach a Postgres instance
// JWT_SECRET   - set this yourself in Render's environment variable settings.
//                Everyone's login tokens are only as safe as this secret.
if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL env var. Attach a Render Postgres instance and set it.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
if (JWT_SECRET === 'dev-only-insecure-secret-change-me') {
  console.warn('WARNING: JWT_SECRET is not set. Set a real secret in your environment variables.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html at "/"

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      full_name TEXT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT DEFAULT 'Pillbox 1',
      api_key TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS medicines (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      compartment TEXT NOT NULL,
      threshold INTEGER DEFAULT 5,
      pills_full INTEGER DEFAULT 30,
      pills_left INTEGER DEFAULT 30,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      time TEXT NOT NULL,
      dosage TEXT NOT NULL,
      timing TEXT DEFAULT 'After Food',
      comments TEXT DEFAULT '',
      days TEXT DEFAULT 'daily'
    );

    CREATE TABLE IF NOT EXISTS dose_logs (
      id SERIAL PRIMARY KEY,
      schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      taken INTEGER DEFAULT 0,
      taken_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      item TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Schema ready.');
}

// --- AUTH MIDDLEWARE ---

// For dashboard calls: verifies a JWT and attaches req.accountId
function requireAuth(req, res, next) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.accountId = decoded.accountId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// For ESP32 calls: verifies x-api-key against the devices table and
// attaches req.accountId (looked up fresh every request, so it always
// reflects the current owner of that key).
async function requireDeviceKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' });
  try {
    const result = await pool.query('SELECT account_id FROM devices WHERE api_key = $1', [key]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    req.accountId = result.rows[0].account_id;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// --- AUTH ROUTES ---

app.post('/api/auth/register', async (req, res) => {
  const { fullName, username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const existing = await pool.query('SELECT id FROM accounts WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'That username is already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const accountResult = await pool.query(
      `INSERT INTO accounts (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [fullName || username, username, passwordHash]
    );
    const accountId = accountResult.rows[0].id;

    // Every account gets its own permanent API key for its pillbox,
    // generated once here and never touched again unless the user
    // explicitly asks to rotate it.
    const apiKey = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO devices (account_id, name, api_key) VALUES ($1, $2, $3)`,
      [accountId, 'Pillbox 1', apiKey]
    );

    const token = jwt.sign({ accountId }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, apiKey, fullName: fullName || username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const account = result.rows[0];
    const match = await bcrypt.compare(password, account.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign({ accountId: account.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, fullName: account.full_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET this account's permanent device API key (for display/ESP32 setup).
// Protected by JWT now instead of being public, since the dashboard has a
// real login before it needs this.
app.get('/api/device-key', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT api_key, name FROM devices WHERE account_id = $1 ORDER BY id LIMIT 1',
      [req.accountId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No device registered for this account' });
    }
    res.json({ apiKey: result.rows[0].api_key, deviceName: result.rows[0].name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DASHBOARD API (JWT-protected, scoped to req.accountId) ---

app.get('/api/medicines', requireAuth, async (req, res) => {
  try {
    const medResult = await pool.query(
      `SELECT id, name, compartment, threshold,
              pills_full AS "pillsFull", pills_left AS "pillsLeft",
              created_at AS "createdAt"
       FROM medicines WHERE account_id = $1`,
      [req.accountId]
    );
    const medicines = medResult.rows;
    const medIds = medicines.map(m => m.id);

    let schedules = [];
    if (medIds.length) {
      const schedResult = await pool.query(
        `SELECT id, medicine_id AS "medicineId", time, dosage, timing, comments, days
         FROM schedules WHERE medicine_id = ANY($1)`,
        [medIds]
      );
      schedules = schedResult.rows;
    }

    const result = medicines.map(m => {
      const medSchedules = schedules
        .filter(s => s.medicineId === m.id)
        .map(s => {
          let days = s.days;
          try { days = JSON.parse(s.days); } catch (e) {}
          return { id: s.id, time: s.time, dosage: s.dosage, timing: s.timing || 'After Food', comments: s.comments || '', days };
        });
      return { ...m, schedule: medSchedules };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/medicines', requireAuth, async (req, res) => {
  try {
    const { name, compartment, threshold, pillsFull, pillsLeft, schedule } = req.body;

    const medResult = await pool.query(
      `INSERT INTO medicines (account_id, name, compartment, threshold, pills_full, pills_left)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.accountId, name, compartment, threshold || 5, pillsFull || 30, pillsLeft || 30]
    );
    const medId = medResult.rows[0].id;

    if (schedule && schedule.length) {
      for (const s of schedule) {
        const daysVal = Array.isArray(s.days) ? JSON.stringify(s.days) : (s.days || 'daily');
        await pool.query(
          `INSERT INTO schedules (medicine_id, time, dosage, timing, comments, days)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [medId, s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal]
        );
      }
    }

    await pool.query(
      `INSERT INTO activity_logs (account_id, item, action) VALUES ($1, $2, $3)`,
      [req.accountId, name, `Added to compartment ${compartment}`]
    );

    res.status(201).json({ id: medId, message: 'Medicine created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/medicines/:id', requireAuth, async (req, res) => {
  try {
    const medId = req.params.id;
    const { name, compartment, threshold, pillsFull, pillsLeft, schedule } = req.body;

    const owned = await pool.query(
      'SELECT id FROM medicines WHERE id = $1 AND account_id = $2',
      [medId, req.accountId]
    );
    if (owned.rows.length === 0) return res.status(404).json({ error: 'Medicine not found' });

    await pool.query(
      `UPDATE medicines SET name = $1, compartment = $2, threshold = $3, pills_full = $4, pills_left = $5 WHERE id = $6`,
      [name, compartment, threshold, pillsFull, pillsLeft, medId]
    );

    const existingResult = await pool.query('SELECT id FROM schedules WHERE medicine_id = $1', [medId]);
    const existingIds = existingResult.rows.map(r => r.id);
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
          const inserted = await pool.query(
            `INSERT INTO schedules (medicine_id, time, dosage, timing, comments, days)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [medId, s.time, s.dosage, s.timing || 'After Food', s.comments || '', daysVal]
          );
          keepIds.push(inserted.rows[0].id);
        }
      }
    }

    const toDelete = existingIds.filter(id => !keepIds.includes(id));
    if (toDelete.length) {
      await pool.query('DELETE FROM schedules WHERE id = ANY($1)', [toDelete]);
    }

    await pool.query(
      `INSERT INTO activity_logs (account_id, item, action) VALUES ($1, $2, $3)`,
      [req.accountId, name, 'Updated medicine configuration']
    );
    res.json({ message: 'Medicine updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/medicines/:id/schedule/:scheduleId', requireAuth, async (req, res) => {
  try {
    const { id, scheduleId } = req.params;
    const owned = await pool.query('SELECT id FROM medicines WHERE id = $1 AND account_id = $2', [id, req.accountId]);
    if (owned.rows.length === 0) return res.status(404).json({ error: 'Medicine not found' });

    await pool.query('DELETE FROM schedules WHERE id = $1 AND medicine_id = $2', [scheduleId, id]);
    res.json({ message: 'Schedule entry deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/medicines/:id', requireAuth, async (req, res) => {
  try {
    const medId = req.params.id;
    const owned = await pool.query('SELECT name FROM medicines WHERE id = $1 AND account_id = $2', [medId, req.accountId]);
    if (owned.rows.length === 0) return res.status(404).json({ error: 'Medicine not found' });
    const medName = owned.rows[0].name;

    await pool.query('DELETE FROM medicines WHERE id = $1', [medId]);
    await pool.query(
      `INSERT INTO activity_logs (account_id, item, action) VALUES ($1, $2, $3)`,
      [req.accountId, medName, 'Deleted medicine from system']
    );
    res.json({ message: 'Medicine deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/doses/activity', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, item, action, created_at AS "createdAt"
       FROM activity_logs WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.accountId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restock/:id', requireAuth, async (req, res) => {
  try {
    const medId = req.params.id;
    const { qty } = req.body;
    const owned = await pool.query('SELECT name FROM medicines WHERE id = $1 AND account_id = $2', [medId, req.accountId]);
    if (owned.rows.length === 0) return res.status(404).json({ error: 'Medicine not found' });

    await pool.query('UPDATE medicines SET pills_left = $1 WHERE id = $2', [qty, medId]);
    await pool.query(
      `INSERT INTO activity_logs (account_id, item, action) VALUES ($1, $2, $3)`,
      [req.accountId, owned.rows[0].name, `Restocked to ${qty} pills`]
    );
    res.json({ message: 'Compartment restocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DEVICE-FACING API (x-api-key protected, scoped by that key's account) ---

const GRACE_MINUTES = 30;
function timeToMinutes(t) {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
}

app.get('/api/doses/today', requireDeviceKey, async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const todayDow = now.getDay();

    const result = await pool.query(
      `SELECT s.id as "scheduleId", s.time, s.dosage, s.timing, s.comments, s.days,
              m.id as "medicineId", m.name as "medicineName", m.compartment,
              COALESCE(dl.taken, 0) as taken
       FROM schedules s
       JOIN medicines m ON s.medicine_id = m.id
       LEFT JOIN dose_logs dl ON dl.schedule_id = s.id AND dl.date = $1
       WHERE m.account_id = $2`,
      [todayStr, req.accountId]
    );

    const out = result.rows
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

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doses/:scheduleId/taken', requireDeviceKey, async (req, res) => {
  try {
    const scheduleId = req.params.scheduleId;
    const todayStr = new Date().toISOString().split('T')[0];

    const schedResult = await pool.query(
      `SELECT s.id, s.medicine_id FROM schedules s
       JOIN medicines m ON s.medicine_id = m.id
       WHERE s.id = $1 AND m.account_id = $2`,
      [scheduleId, req.accountId]
    );
    if (schedResult.rows.length === 0) return res.status(404).json({ error: 'Schedule not found' });
    const medId = schedResult.rows[0].medicine_id;

    await pool.query(
      `INSERT INTO dose_logs (schedule_id, medicine_id, date, taken, taken_at) VALUES ($1, $2, $3, 1, NOW())`,
      [scheduleId, medId, todayStr]
    );
    await pool.query('UPDATE medicines SET pills_left = GREATEST(0, pills_left - 1) WHERE id = $1', [medId]);

    const medName = await pool.query('SELECT name FROM medicines WHERE id = $1', [medId]);
    await pool.query(
      `INSERT INTO activity_logs (account_id, item, action) VALUES ($1, $2, 'Dose dispensed')`,
      [req.accountId, medName.rows[0].name]
    );

    res.json({ message: 'Dose marked as taken' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MediTracker API Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });