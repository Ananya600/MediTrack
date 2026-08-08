// routes/auth.js
// No registration, no caregivers — one account, set once by `npm run seed`
// from .env. This route file is intentionally small.

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { readDB, writeDB, nextId, nowIso } = require('../db/store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login  { username, password }
//
// Intentionally not a real credential check. This is a single-household
// device with no sensitive accounts behind it, so the login screen exists
// for "who's using the box right now" (so activity logs read like "taken
// by Alex" instead of a generic username) rather than as a security
// boundary. Any non-empty username/password is accepted; the only real
// requirement is that `npm run seed` has been run at least once, since
// that's what makes this a configured system at all.
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required.' });

  const data = readDB();
  if (!data.account) {
    return res.status(500).json({ error: 'No account has been set up yet — run `npm run seed` on the backend.' });
  }

  const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
  res.json({ token, user: { username } });
});

// POST /api/auth/devices  { name } -> provision a new ESP32 device key.
// Shown in full only here, at creation — flash it into the sketch immediately.
router.post('/devices', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required.' });

  const data = readDB();
  const device = { id: nextId(data, 'devices'), name: name.trim(), apiKey: crypto.randomBytes(16).toString('hex'), createdAt: nowIso() };
  data.devices.push(device);
  writeDB(data);

  res.status(201).json(device);
});

// GET /api/auth/devices -> list devices, key masked
router.get('/devices', requireAuth, (req, res) => {
  const data = readDB();
  res.json(data.devices.map((d) => ({ id: d.id, name: d.name, apiKeyLast4: d.apiKey.slice(-4), createdAt: d.createdAt })));
});

// DELETE /api/auth/devices/:id -> revoke a device key
router.delete('/devices/:id', requireAuth, (req, res) => {
  const data = readDB();
  const device = data.devices.find((d) => d.id === +req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found.' });

  data.devices = data.devices.filter((d) => d.id !== device.id);
  writeDB(data);
  res.status(204).send();
});

module.exports = router;
