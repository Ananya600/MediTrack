// middleware/device-auth.js
//
// The ESP32 doesn't log in like a person — it holds one long-lived API
// key in its flash memory (set once when you flash the sketch) and sends
// it on every request as `x-device-key`. Simpler than JWT for a headless
// board: no login flow to implement in C++, no token refresh to manage.

const { readDB } = require('../db/store');

function requireDevice(req, res, next) {
  const key = req.headers['x-device-key'];
  if (!key) {
    return res.status(401).json({ error: 'Missing x-device-key header.' });
  }

  const data = readDB();
  const device = data.devices.find((d) => d.apiKey === key);
  if (!device) {
    return res.status(401).json({ error: 'Invalid device key.' });
  }

  req.device = device; // { id, patientId, name, apiKey }
  next();
}

module.exports = { requireDevice };
