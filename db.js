'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_SETTINGS = {
  salon_name: 'Mein Friseursalon',
  info_text: 'Such dir einfach einen freien Termin aus. Bei Fragen erreichst du mich telefonisch.',
  legal_text: '',
  booking_lead_minutes: '60',
  booking_days_ahead: '60',
  cancel_until_hours: '3',
};

const DEFAULT_SERVICES = [
  ['Haarschnitt', 1000],
  ['Haarschnitt + Bart', 1500],
];

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS services (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      sort        INTEGER NOT NULL DEFAULT 0
    );

    -- Ein freigegebener Termin (Zeitfenster), den Kunden buchen können.
    CREATE TABLE IF NOT EXISTS slots (
      id           INTEGER PRIMARY KEY,
      date         TEXT    NOT NULL,             -- YYYY-MM-DD (Ortszeit Salon)
      time         TEXT    NOT NULL,             -- HH:MM
      duration_min INTEGER NOT NULL DEFAULT 30,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (date, time)
    );

    -- Eine Buchung. Datum/Uhrzeit werden kopiert, damit die Statistik auch dann
    -- stimmt, wenn das Zeitfenster später gelöscht wird oder es ein manueller
    -- Eintrag ohne Zeitfenster ist (z. B. Laufkundschaft).
    CREATE TABLE IF NOT EXISTS appointments (
      id            INTEGER PRIMARY KEY,
      slot_id       INTEGER REFERENCES slots(id) ON DELETE SET NULL,
      date          TEXT    NOT NULL,
      time          TEXT    NOT NULL,
      service_id    INTEGER REFERENCES services(id) ON DELETE SET NULL,
      service_name  TEXT,
      customer_name TEXT    NOT NULL,
      phone         TEXT,
      email         TEXT,
      note          TEXT,
      status        TEXT    NOT NULL DEFAULT 'booked'
                    CHECK (status IN ('booked', 'done', 'cancelled', 'no_show')),
      price_cents   INTEGER,
      token         TEXT UNIQUE,
      source        TEXT    NOT NULL DEFAULT 'online',  -- online | admin | walk_in
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      cancelled_at  TEXT,
      cancelled_by  TEXT
    );

    -- Ein Zeitfenster kann nur eine aktive Buchung haben (verhindert Doppelbuchungen).
    CREATE UNIQUE INDEX IF NOT EXISTS appointments_one_active_per_slot
      ON appointments (slot_id)
      WHERE slot_id IS NOT NULL AND status IN ('booked', 'done', 'no_show');

    CREATE INDEX IF NOT EXISTS appointments_date ON appointments (date, time);
    CREATE INDEX IF NOT EXISTS appointments_status ON appointments (status, date);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT    PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value);

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM services').get();
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'services_seeded'").get();
  if (n === 0 && !seeded) {
    const insert = db.prepare('INSERT INTO services (name, price_cents, sort) VALUES (?, ?, ?)');
    DEFAULT_SERVICES.forEach(([name, price], i) => insert.run(name, price, i));
  }
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('services_seeded', '1')").run();

  return db;
}

module.exports = { openDatabase, DEFAULT_SETTINGS };
