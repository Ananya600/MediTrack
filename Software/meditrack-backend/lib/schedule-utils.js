// lib/schedule-utils.js
// Pure functions, no storage dependency — used by every route, and the
// logic here should stay in lockstep with the frontend's own copy of it.

const GRACE_MINUTES = 60; // how long after the scheduled time a dose stays "due" before flipping to "missed"

function todayDate() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function isScheduledToday(days) {
  if (days === 'daily') return true;
  return Array.isArray(days) && days.indexOf(new Date().getDay()) > -1;
}

function daysPerWeek(days) {
  return days === 'daily' ? 7 : (Array.isArray(days) ? days.length : 0);
}

function daysOverlap(a, b) {
  if (a === 'daily' || b === 'daily') return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.some((d) => b.includes(d));
}

// row: { time, taken }  ->  'taken' | 'upcoming' | 'due' | 'missed'
function doseState(row) {
  if (row.taken) return 'taken';
  const due = timeToMinutes(row.time);
  const now = nowMinutes();
  if (now < due) return 'upcoming';
  if (now <= due + GRACE_MINUTES) return 'due';
  return 'missed';
}

module.exports = {
  GRACE_MINUTES,
  todayDate,
  isScheduledToday,
  daysPerWeek,
  daysOverlap,
  doseState
};
