// middleware/device-auth.js
// The ESP32 holds one long-lived API key rather than logging in. No
// patient/account scoping needed on the device side — there's only ever
// one set of medicine data in this system.

const { readDB } = require('../db/store');

function requireDevice(req, res, next) {
  const key = req.headers['x-device-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-device-key header.' });

  const data = readDB();
  const device = data.devices.find((d) => d.apiKey === key);
  if (!device) return res.status(401).json({ error: 'Invalid device key.' });

  req.device = device; // { id, name, apiKey }
  next();
}

module.exports = { requireDevice };
