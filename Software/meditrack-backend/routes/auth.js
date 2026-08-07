// routes/auth.js
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { readDB, writeDB, nextId, nowIso } = require('../db/store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, patientId: user.patientId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
}

// POST /api/auth/register  { patientName, username, password }
router.post('/register', (req, res) => {
  const { patientName, username, password } = req.body || {};
  if (!patientName || !username || !password) {
    return res.status(400).json({ error: 'patientName, username, and password are required.' });
  }

  const data = readDB();
  if (data.users.some((u) => u.username === username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const patient = { id: nextId(data, 'patients'), name: patientName, createdAt: nowIso() };
  data.patients.push(patient);

  const user = {
    id: nextId(data, 'users'), patientId: patient.id, username,
    passwordHash: bcrypt.hashSync(password, 10), createdAt: nowIso()
  };
  data.users.push(user);
  writeDB(data);

  res.status(201).json({ token: signToken(user), user: { id: user.id, username: user.username, patientId: user.patientId } });
});

// POST /api/auth/login  { username, password }
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }

  const data = readDB();
  const user = data.users.find((u) => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  res.json({ token: signToken(user), user: { id: user.id, username: user.username, patientId: user.patientId } });
});

// POST /api/auth/caregivers  { username, password } -> add a caregiver to YOUR patient
router.post('/caregivers', requireAuth, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }

  const data = readDB();
  if (data.users.some((u) => u.username === username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const user = {
    id: nextId(data, 'users'), patientId: req.user.patientId, username,
    passwordHash: bcrypt.hashSync(password, 10), createdAt: nowIso()
  };
  data.users.push(user);
  writeDB(data);

  res.status(201).json({ id: user.id, username: user.username, patientId: user.patientId });
});

// GET /api/auth/caregivers -> everyone sharing this patient's schedule
router.get('/caregivers', requireAuth, (req, res) => {
  const data = readDB();
  const rows = data.users
    .filter((u) => u.patientId === req.user.patientId)
    .map((u) => ({ id: u.id, username: u.username, createdAt: u.createdAt }));
  res.json(rows);
});

// POST /api/auth/devices  { name } -> provision a new ESP32 device key for YOUR patient.
// The key is only ever shown here, at creation — flash it into the sketch immediately.
router.post('/devices', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required.' });

  const data = readDB();
  const device = {
    id: nextId(data, 'devices'), patientId: req.user.patientId, name: name.trim(),
    apiKey: crypto.randomBytes(16).toString('hex'), createdAt: nowIso()
  };
  data.devices.push(device);
  writeDB(data);

  res.status(201).json(device); // full key returned once, on creation only
});

// GET /api/auth/devices -> list devices for this patient, key masked
router.get('/devices', requireAuth, (req, res) => {
  const data = readDB();
  const rows = data.devices
    .filter((d) => d.patientId === req.user.patientId)
    .map((d) => ({ id: d.id, name: d.name, apiKeyLast4: d.apiKey.slice(-4), createdAt: d.createdAt }));
  res.json(rows);
});

// DELETE /api/auth/devices/:id -> revoke a device key (e.g. if a board is lost/replaced)
router.delete('/devices/:id', requireAuth, (req, res) => {
  const data = readDB();
  const device = data.devices.find((d) => d.id === +req.params.id && d.patientId === req.user.patientId);
  if (!device) return res.status(404).json({ error: 'Device not found.' });

  data.devices = data.devices.filter((d) => d.id !== device.id);
  writeDB(data);
  res.status(204).send();
});

module.exports = router;
