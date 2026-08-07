// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const medicineRoutes = require('./routes/medicines');
const doseRoutes = require('./routes/doses');
const reportRoutes = require('./routes/reports');
const restockRoutes = require('./routes/restock');
const deviceRoutes = require('./routes/device');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/medicines', medicineRoutes);
app.use('/api/doses', doseRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/restock', restockRoutes);
app.use('/api/device', deviceRoutes); // ESP32 talks only to this prefix

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`MediTrack backend running on http://localhost:${PORT}`);
});
