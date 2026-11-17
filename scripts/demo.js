'use strict';

// Startet die App mit Beispieldaten (eigene Datenbank data/demo.db), damit man alles ausprobieren kann.
// Aufruf: npm run demo   → Passwort für "Mein Bereich": demo

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../db');
const { createApp } = require('../server');
const L = require('../lib');

const dbPath = path.join(__dirname, '..', 'data', 'demo.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
const db = openDatabase(dbPath);
const timeZone = 'Europe/Berlin';
const today = L.localParts(timeZone).date;
const now = L.localStamp(timeZone);

let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

db.prepare("UPDATE settings SET value = 'Salon Schnittpunkt' WHERE key = 'salon_name'").run();
db.prepare("UPDATE settings SET value = ? WHERE key = 'info_text'").run(
  'Musterstraße 12 · 12345 Musterstadt\nTelefon 0123 456789'
);

const services = db.prepare('SELECT id, name, price_cents FROM services').all();
const names = ['Anna K.', 'Ben S.', 'Clara M.', 'David R.', 'Emma W.', 'Felix B.', 'Greta H.', 'Jonas L.', 'Lena F.', 'Mia P.', 'Noah T.', 'Paul Z.'];
const insertSlot = db.prepare('INSERT OR IGNORE INTO slots (date, time, duration_min) VALUES (?, ?, 30)');
const slotId = (date, time) => db.prepare('SELECT id FROM slots WHERE date = ? AND time = ?').get(date, time).id;
const insertAppt = db.prepare(`INSERT INTO appointments
  (slot_id, date, time, service_id, service_name, customer_name, phone, status, price_cents, token, source, completed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?)`);
let tokenN = 0;

// Vergangene, erledigte Termine seit Jahresbeginn (und etwas Vorjahr)
const year = Number(today.slice(0, 4));
for (let d = `${year - 1}-09-01`; d < today; d = L.addDays(d, 1)) {
  const wd = L.weekday(d);
  if (wd === 1 || wd === 7) continue;
  const n = Math.floor(rand() * 5) + (d.slice(5, 7) === '12' ? 4 : 2);
  const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'].sort(() => rand() - 0.5).slice(0, n);
  for (const t of times) {
    insertSlot.run(d, t);
    const svc = pick(services);
    const noShow = rand() < 0.04;
    const tip = rand() < 0.3 ? 200 : 0;
    insertAppt.run(slotId(d, t), d, t, svc.id, svc.name, pick(names), '0170 1234567',
      noShow ? 'no_show' : 'done', noShow ? null : svc.price_cents + tip, `demo${tokenN++}`, noShow ? null : `${d}T18:00:00Z`);
  }
}

// Freie Termine für die nächsten 4 Wochen (Di–Sa, 9–18 Uhr) und einige Buchungen
for (let d = today; d <= L.addDays(today, 27); d = L.addDays(d, 1)) {
  const wd = L.weekday(d);
  if (wd === 1 || wd === 7) continue;
  for (let m = 9 * 60; m + 30 <= 18 * 60; m += 30) {
    const t = L.fromMinutes(m);
    if (`${d} ${t}` <= now) continue;
    insertSlot.run(d, t);
    if (d <= L.addDays(today, 6) && rand() < 0.35) {
      const svc = pick(services);
      insertAppt.run(slotId(d, t), d, t, svc.id, svc.name, pick(names), '0170 1234567', 'booked', null, `demo${tokenN++}`, null);
    }
  }
}
// Zwei Termine von heute früh, die noch abgeschlossen werden müssen
for (const t of ['08:00', '08:30']) {
  if (`${today} ${t}` < now) {
    insertSlot.run(today, t);
    const svc = pick(services);
    insertAppt.run(slotId(today, t), today, t, svc.id, svc.name, pick(names), '0170 1234567', 'booked', null, `demo${tokenN++}`, null);
  }
}

const app = createApp({ db, adminPassword: 'demo', timeZone });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Demo läuft: http://localhost:${port}/  ·  Mein Bereich: http://localhost:${port}/admin  (Passwort: demo)`);
});
