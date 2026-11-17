'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDatabase } = require('./db');
const { createMailerFromEnv, bookingConfirmation } = require('./mail');
const L = require('./lib');

const SESSION_DAYS = 30;
// Status, bei denen ein Zeitfenster als belegt gilt.
const ACTIVE = "('booked', 'done', 'no_show')";
const STATUSES = ['booked', 'done', 'cancelled', 'no_show'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function createApp({
  db,
  adminPassword,
  timeZone = 'Europe/Berlin',
  clock = () => Date.now(),
  trustProxy = 1,
  sendMail = null, // Funktion zum Verschicken von E-Mails (siehe mail.js) oder null
  publicUrl = null, // Adresse der Webseite, z. B. https://termine.mein-salon.de – für Links in E-Mails
}) {
  if (!adminPassword) throw new Error('adminPassword fehlt');
  const passwordHash = sha256(adminPassword);
  // E-Mails nur mit fester Adresse der Webseite, damit Links darin nie von einer Anfrage abhängen.
  const siteUrl = publicUrl ? String(publicUrl).replace(/\/+$/, '') : null;
  const mailEnabled = Boolean(sendMail && siteUrl);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  const bookingLimiter = L.createRateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });
  const loginLimiter = L.createRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  const globalLoginLimiter = L.createRateLimiter({ limit: 60, windowMs: 15 * 60 * 1000 });

  // ---------- Hilfen ----------

  const nowStamp = (offsetMinutes = 0) => L.localStamp(timeZone, offsetMinutes, clock());
  const today = () => L.localParts(timeZone, new Date(clock())).date;

  function settings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  function publicServices() {
    return db
      .prepare('SELECT id, name, price_cents AS price FROM services WHERE active = 1 ORDER BY sort, id')
      .all();
  }

  function serviceById(id) {
    if (id === undefined || id === null || id === '') return null;
    const row = db.prepare('SELECT id, name, price_cents, active FROM services WHERE id = ?').get(toInt(id, -1));
    return row || fail(400, 'Diese Leistung gibt es nicht.');
  }

  function appointmentById(id) {
    return (
      db.prepare('SELECT * FROM appointments WHERE id = ?').get(toInt(id, -1)) ||
      fail(404, 'Termin nicht gefunden.')
    );
  }

  const appointmentSelect = `
    SELECT a.id, a.date, a.time, s.duration_min AS duration, a.service_id AS serviceId,
           a.service_name AS serviceName, a.customer_name AS customerName, a.phone, a.email,
           a.note, a.status, a.price_cents AS price, a.source, a.created_at AS createdAt,
           a.completed_at AS completedAt, a.slot_id AS slotId
    FROM appointments a LEFT JOIN slots s ON s.id = a.slot_id`;

  function appointmentView(id) {
    return db.prepare(`${appointmentSelect} WHERE a.id = ?`).get(id);
  }

  function readCustomer(body, { requirePhone }) {
    const name = L.cleanText(body.name, 80);
    const phone = L.cleanText(body.phone, 30);
    const email = L.cleanText(body.email, 200);
    const note = L.cleanText(body.note, 500);
    if (name.length < 2) fail(400, 'Bitte gib einen Namen ein.');
    if (requirePhone && !phone) fail(400, 'Bitte gib eine Telefonnummer ein.');
    if (phone && !L.isPlausiblePhone(phone)) fail(400, 'Die Telefonnummer sieht nicht richtig aus.');
    if (email && !L.isPlausibleEmail(email)) fail(400, 'Die E-Mail-Adresse sieht nicht richtig aus.');
    return { name, phone: phone || null, email: email || null, note: note || null };
  }

  function insertAppointment(fields) {
    const token = crypto.randomBytes(18).toString('base64url');
    try {
      const info = db
        .prepare(
          `INSERT INTO appointments
             (slot_id, date, time, service_id, service_name, customer_name, phone, email, note,
              status, price_cents, token, source, completed_at)
           VALUES (@slotId, @date, @time, @serviceId, @serviceName, @name, @phone, @email, @note,
                   @status, @price, @token, @source, @completedAt)`
        )
        .run({ price: null, completedAt: null, status: 'booked', ...fields, token });
      return { id: info.lastInsertRowid, token };
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) fail(409, 'Dieser Termin ist leider schon vergeben.');
      throw err;
    }
  }

  function freeSlot(slotId) {
    return db
      .prepare(
        `SELECT s.* FROM slots s WHERE s.id = ? AND NOT EXISTS
           (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${ACTIVE})`
      )
      .get(toInt(slotId, -1));
  }

  // ---------- Grundeinstellungen ----------

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
        "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '50kb' }));

  // ---------- Öffentlich: Kunden ----------

  app.get('/api/info', (req, res) => {
    const s = settings();
    res.json({
      salonName: s.salon_name,
      infoText: s.info_text,
      legalText: s.legal_text,
      cancelUntilHours: toInt(s.cancel_until_hours, 3),
      emailConfirmation: mailEnabled,
      services: publicServices(),
    });
  });

  app.get('/api/slots', (req, res) => {
    const s = settings();
    const cutoff = nowStamp(toInt(s.booking_lead_minutes, 60));
    const lastDate = L.addDays(today(), toInt(s.booking_days_ahead, 60));
    const slots = db
      .prepare(
        `SELECT s.id, s.date, s.time, s.duration_min AS duration FROM slots s
         WHERE (s.date || ' ' || s.time) > ? AND s.date <= ?
           AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${ACTIVE})
         ORDER BY s.date, s.time`
      )
      .all(cutoff, lastDate);
    res.json({ slots });
  });

  app.post('/api/bookings', (req, res) => {
    const body = req.body || {};
    if (body.website) fail(400, 'Ungültige Anfrage.'); // Honeypot gegen Spam-Bots
    if (body.consent !== true) fail(400, 'Bitte stimm der Speicherung deiner Angaben zu.');
    const customer = readCustomer(body, { requirePhone: true });

    const services = publicServices();
    let service = null;
    if (services.length > 0) {
      service = services.find((x) => x.id === toInt(body.serviceId, -1));
      if (!service) fail(400, 'Bitte wähl eine Leistung aus.');
    }

    if (!bookingLimiter(req.ip, clock())) fail(429, 'Zu viele Buchungen. Bitte ruf kurz an.');

    const s = settings();
    const result = db.transaction(() => {
      const slot = freeSlot(body.slotId);
      if (!slot) fail(409, 'Dieser Termin ist leider schon vergeben. Bitte wähl einen anderen.');
      const start = `${slot.date} ${slot.time}`;
      const tooLate = start <= nowStamp(toInt(s.booking_lead_minutes, 60));
      const tooEarly = slot.date > L.addDays(today(), toInt(s.booking_days_ahead, 60));
      if (tooLate || tooEarly) fail(409, 'Dieser Termin kann nicht mehr online gebucht werden.');
      const created = insertAppointment({
        slotId: slot.id,
        date: slot.date,
        time: slot.time,
        serviceId: service ? service.id : null,
        serviceName: service ? service.name : null,
        ...customer,
        source: 'online',
      });
      return { ...created, slot };
    })();

    const willMail = mailEnabled && Boolean(customer.email);
    res.status(201).json({
      token: result.token,
      date: result.slot.date,
      time: result.slot.time,
      duration: result.slot.duration_min,
      serviceName: service ? service.name : null,
      confirmationEmail: willMail,
    });

    if (willMail) {
      // Erst nach der Antwort verschicken: Ein Fehler beim Versand ändert nichts an der Buchung.
      const message = bookingConfirmation({
        salonName: s.salon_name,
        customerName: customer.name,
        email: customer.email,
        token: result.token,
        date: result.slot.date,
        time: result.slot.time,
        duration: result.slot.duration_min,
        serviceName: service ? service.name : null,
        price: service ? service.price : null,
        manageUrl: `${siteUrl}/termin/${result.token}`,
      });
      Promise.resolve()
        .then(() => sendMail(message))
        .catch((err) => console.error('Bestätigung per E-Mail fehlgeschlagen:', err.message));
    }
  });

  function bookingByToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{10,64}$/.test(token)) fail(404, 'Termin nicht gefunden.');
    return (
      db
        .prepare(
          `SELECT a.*, s.duration_min FROM appointments a LEFT JOIN slots s ON s.id = a.slot_id WHERE a.token = ?`
        )
        .get(token) || fail(404, 'Termin nicht gefunden.')
    );
  }

  function canCustomerCancel(appt) {
    const hours = toInt(settings().cancel_until_hours, 3);
    return appt.status === 'booked' && `${appt.date} ${appt.time}` > nowStamp(hours * 60);
  }

  app.get('/api/bookings/:token', (req, res) => {
    const a = bookingByToken(req.params.token);
    res.json({
      date: a.date,
      time: a.time,
      duration: a.duration_min,
      serviceName: a.service_name,
      customerName: a.customer_name,
      status: a.status,
      canCancel: canCustomerCancel(a),
    });
  });

  app.post('/api/bookings/:token/cancel', (req, res) => {
    const a = bookingByToken(req.params.token);
    if (a.status === 'cancelled') return res.json({ ok: true, status: 'cancelled' });
    if (!canCustomerCancel(a)) fail(409, 'Dieser Termin kann online nicht mehr abgesagt werden. Bitte ruf kurz an.');
    db.prepare(
      "UPDATE appointments SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = 'customer' WHERE id = ?"
    ).run(a.id);
    res.json({ ok: true, status: 'cancelled' });
  });

  // ---------- Anmeldung für den Inhaber ----------

  function sessionFromRequest(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    const hash = sha256(token).toString('hex');
    const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash);
    if (!row || row.expires_at < clock()) return null;
    return hash;
  }

  function cookieFlags(req) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  app.post('/api/admin/login', (req, res) => {
    if (!loginLimiter(req.ip, clock()) || !globalLoginLimiter('all', clock())) {
      fail(429, 'Zu viele Versuche. Bitte warte ein paar Minuten.');
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!crypto.timingSafeEqual(sha256(password), passwordHash)) fail(401, 'Falsches Passwort.');

    const token = crypto.randomBytes(32).toString('base64url');
    const expires = clock() + SESSION_DAYS * 24 * 3600 * 1000;
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(clock());
    db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(
      sha256(token).toString('hex'),
      expires
    );
    res.set('Set-Cookie', `sid=${token}; Max-Age=${SESSION_DAYS * 24 * 3600}; ${cookieFlags(req)}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    const hash = sessionFromRequest(req);
    if (hash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    res.set('Set-Cookie', `sid=; Max-Age=0; ${cookieFlags(req)}`);
    res.json({ ok: true });
  });

  app.use('/api/admin', (req, res, next) => {
    if (!sessionFromRequest(req)) fail(401, 'Bitte melde dich an.');
    next();
  });

  // ---------- Inhaber: Überblick ----------

  app.get('/api/admin/me', (req, res) => {
    res.json({ ok: true, now: nowStamp(), today: today() });
  });

  // ---------- Inhaber: Zeitfenster freigeben ----------

  app.get('/api/admin/slots', (req, res) => {
    const from = L.isDate(req.query.from) ? req.query.from : today();
    const to = L.isDate(req.query.to) ? req.query.to : L.addDays(from, 41);
    const slots = db
      .prepare(
        `SELECT s.id, s.date, s.time, s.duration_min AS duration,
                a.id AS appointmentId, a.customer_name AS customerName, a.status, a.service_name AS serviceName
         FROM slots s
         LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${ACTIVE}
         WHERE s.date BETWEEN ? AND ?
         ORDER BY s.date, s.time`
      )
      .all(from, to);
    res.json({ from, to, slots });
  });

  /**
   * Legt ein einzelnes Zeitfenster an ({ date, time, duration })
   * oder eine Serie ({ fromDate, toDate, weekdays, startTime, endTime, duration }).
   * Mit preview: true wird nur gezählt, nichts gespeichert.
   * Zeitfenster, die sich mit vorhandenen überschneiden oder in der Vergangenheit liegen, werden übersprungen.
   */
  app.post('/api/admin/slots', (req, res) => {
    const b = req.body || {};
    const duration = toInt(b.duration, 30);
    if (duration < 5 || duration > 480) fail(400, 'Die Dauer muss zwischen 5 und 480 Minuten liegen.');

    const candidates = [];
    if (b.date !== undefined) {
      if (!L.isDate(b.date) || !L.isTime(b.time)) fail(400, 'Bitte Datum und Uhrzeit angeben.');
      candidates.push({ date: b.date, time: b.time });
    } else {
      const { fromDate, toDate, startTime, endTime } = b;
      if (!L.isDate(fromDate) || !L.isDate(toDate)) fail(400, 'Bitte Start- und Enddatum angeben.');
      if (toDate < fromDate) fail(400, 'Das Enddatum liegt vor dem Startdatum.');
      if (!L.isTime(startTime) || !L.isTime(endTime)) fail(400, 'Bitte Uhrzeit von/bis angeben.');
      const weekdays = Array.isArray(b.weekdays) ? b.weekdays.map(Number).filter((d) => d >= 1 && d <= 7) : [];
      if (weekdays.length === 0) fail(400, 'Bitte mindestens einen Wochentag auswählen.');
      const startMin = L.toMinutes(startTime);
      const endMin = L.toMinutes(endTime);
      if (endMin - startMin < duration) fail(400, 'Zwischen "von" und "bis" passt kein Termin dieser Dauer.');
      let day = fromDate;
      for (let i = 0; i <= 366 && day <= toDate; i += 1, day = L.addDays(day, 1)) {
        if (!weekdays.includes(L.weekday(day))) continue;
        for (let m = startMin; m + duration <= endMin; m += duration) {
          candidates.push({ date: day, time: L.fromMinutes(m) });
        }
      }
      if (day <= toDate) fail(400, 'Bitte höchstens ein Jahr auf einmal freigeben.');
    }
    if (candidates.length > 3000) fail(400, 'Das sind zu viele Termine auf einmal.');

    const now = nowStamp();
    const existingByDate = new Map();
    const existingFor = (date) => {
      if (!existingByDate.has(date)) {
        const rows = db.prepare('SELECT time, duration_min FROM slots WHERE date = ?').all(date);
        existingByDate.set(
          date,
          rows.map((r) => [L.toMinutes(r.time), L.toMinutes(r.time) + r.duration_min])
        );
      }
      return existingByDate.get(date);
    };

    const toCreate = [];
    let skippedPast = 0;
    let skippedOverlap = 0;
    for (const c of candidates) {
      if (`${c.date} ${c.time}` <= now) {
        skippedPast += 1;
        continue;
      }
      const start = L.toMinutes(c.time);
      const end = start + duration;
      const ranges = existingFor(c.date);
      if (end > 24 * 60 || ranges.some(([s, e]) => start < e && s < end)) {
        skippedOverlap += 1;
        continue;
      }
      ranges.push([start, end]);
      toCreate.push(c);
    }

    if (!b.preview) {
      const insert = db.prepare('INSERT INTO slots (date, time, duration_min) VALUES (?, ?, ?)');
      db.transaction(() => {
        for (const c of toCreate) insert.run(c.date, c.time, duration);
      })();
    }
    res.status(b.preview ? 200 : 201).json({
      created: toCreate.length,
      skippedPast,
      skippedOverlap,
      preview: Boolean(b.preview),
    });
  });

  app.delete('/api/admin/slots/:id', (req, res) => {
    const slot = db.prepare('SELECT id FROM slots WHERE id = ?').get(toInt(req.params.id, -1));
    if (!slot) fail(404, 'Zeitfenster nicht gefunden.');
    if (!freeSlot(slot.id)) fail(409, 'Dieser Termin ist gebucht. Sage zuerst die Buchung ab.');
    db.prepare('DELETE FROM slots WHERE id = ?').run(slot.id);
    res.json({ ok: true });
  });

  /** Alle freien Zeitfenster zwischen from und to (einschließlich) löschen. */
  app.post('/api/admin/slots/delete-free', (req, res) => {
    const { from, to } = req.body || {};
    if (!L.isDate(from) || !L.isDate(to)) fail(400, 'Bitte Datum angeben.');
    const info = db
      .prepare(
        `DELETE FROM slots WHERE date BETWEEN ? AND ? AND NOT EXISTS
           (SELECT 1 FROM appointments a WHERE a.slot_id = slots.id AND a.status IN ${ACTIVE})`
      )
      .run(from, to);
    res.json({ deleted: info.changes });
  });

  /** Inhaber trägt einen Kunden in ein freies Zeitfenster ein (z. B. nach einem Anruf). */
  app.post('/api/admin/slots/:id/book', (req, res) => {
    const b = req.body || {};
    const customer = readCustomer(b, { requirePhone: false });
    const service = serviceById(b.serviceId);
    const id = db.transaction(() => {
      const slot = freeSlot(req.params.id);
      if (!slot) fail(409, 'Dieser Termin ist schon vergeben.');
      return insertAppointment({
        slotId: slot.id,
        date: slot.date,
        time: slot.time,
        serviceId: service ? service.id : null,
        serviceName: service ? service.name : null,
        ...customer,
        source: 'admin',
      }).id;
    })();
    res.status(201).json(appointmentView(id));
  });

  // ---------- Inhaber: Buchungen ----------

  app.get('/api/admin/appointments', (req, res) => {
    const where = [];
    const params = [];
    const statuses = String(req.query.status || '')
      .split(',')
      .filter((x) => STATUSES.includes(x));
    if (statuses.length) {
      where.push(`a.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (L.isMonth(req.query.month)) {
      where.push('substr(a.date, 1, 7) = ?');
      params.push(req.query.month);
    }
    const sql = `${appointmentSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY a.date, a.time LIMIT 2000`;
    res.json({ now: nowStamp(), appointments: db.prepare(sql).all(...params) });
  });

  /** Laufkundschaft oder nachträglicher Eintrag – direkt als erledigt. */
  app.post('/api/admin/appointments', (req, res) => {
    const b = req.body || {};
    if (!L.isDate(b.date) || !L.isTime(b.time)) fail(400, 'Bitte Datum und Uhrzeit angeben.');
    const customer = readCustomer({ ...b, name: b.name || 'Laufkundschaft' }, { requirePhone: false });
    const service = serviceById(b.serviceId);
    const price = b.price === undefined || b.price === '' ? service?.price_cents ?? null : L.parseEuro(b.price);
    if (price === null) fail(400, 'Bitte einen gültigen Preis angeben.');
    const { id } = insertAppointment({
      slotId: null,
      date: b.date,
      time: b.time,
      serviceId: service ? service.id : null,
      serviceName: service ? service.name : null,
      ...customer,
      status: 'done',
      price,
      source: 'walk_in',
      completedAt: new Date(clock()).toISOString(),
    });
    res.status(201).json(appointmentView(id));
  });

  app.post('/api/admin/appointments/:id/complete', (req, res) => {
    const a = appointmentById(req.params.id);
    if (a.status === 'cancelled') fail(409, 'Abgesagte Termine können nicht abgeschlossen werden.');
    const b = req.body || {};
    let { service_id: serviceId, service_name: serviceName } = a;
    if (b.serviceId !== undefined) {
      const service = serviceById(b.serviceId);
      serviceId = service ? service.id : null;
      serviceName = service ? service.name : null;
    }
    let price = L.parseEuro(b.price);
    if (b.price === undefined || b.price === '') {
      const svc = serviceId ? db.prepare('SELECT price_cents FROM services WHERE id = ?').get(serviceId) : null;
      price = svc ? svc.price_cents : null;
    }
    if (price === null) fail(400, 'Bitte einen gültigen Preis angeben.');
    db.prepare(
      `UPDATE appointments SET status = 'done', price_cents = ?, service_id = ?, service_name = ?,
         completed_at = COALESCE(completed_at, ?) WHERE id = ?`
    ).run(price, serviceId, serviceName, new Date(clock()).toISOString(), a.id);
    res.json(appointmentView(a.id));
  });

  function setStatus(id, from, to, extraSql = '') {
    const a = appointmentById(id);
    if (!from.includes(a.status)) fail(409, 'Das geht bei diesem Termin nicht.');
    try {
      db.prepare(`UPDATE appointments SET status = ?${extraSql} WHERE id = ?`).run(to, a.id);
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        fail(409, 'Das Zeitfenster ist inzwischen anders vergeben.');
      }
      throw err;
    }
    return appointmentView(a.id);
  }

  app.post('/api/admin/appointments/:id/no-show', (req, res) => {
    res.json(setStatus(req.params.id, ['booked', 'done'], 'no_show', ', price_cents = NULL, completed_at = NULL'));
  });

  app.post('/api/admin/appointments/:id/cancel', (req, res) => {
    res.json(
      setStatus(
        req.params.id,
        ['booked'],
        'cancelled',
        ", cancelled_at = datetime('now'), cancelled_by = 'salon'"
      )
    );
  });

  /** Rückgängig machen: zurück auf "gebucht". */
  app.post('/api/admin/appointments/:id/reopen', (req, res) => {
    const a = appointmentById(req.params.id);
    if (a.source === 'walk_in') fail(409, 'Manuelle Einträge kannst du löschen statt zurückzusetzen.');
    res.json(
      setStatus(
        req.params.id,
        ['done', 'no_show', 'cancelled'],
        'booked',
        ', price_cents = NULL, completed_at = NULL, cancelled_at = NULL, cancelled_by = NULL'
      )
    );
  });

  app.delete('/api/admin/appointments/:id', (req, res) => {
    const a = appointmentById(req.params.id);
    db.prepare('DELETE FROM appointments WHERE id = ?').run(a.id);
    res.json({ ok: true });
  });

  // ---------- Inhaber: Statistik ----------

  app.get('/api/admin/stats', (req, res) => {
    const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : today().slice(0, 4);
    const monthRows = db
      .prepare(
        `SELECT CAST(substr(date, 6, 2) AS INTEGER) AS month, COUNT(*) AS count,
                COALESCE(SUM(price_cents), 0) AS revenue
         FROM appointments WHERE status = 'done' AND substr(date, 1, 4) = ?
         GROUP BY month`
      )
      .all(year);
    const months = Array.from({ length: 12 }, (_, i) => {
      const r = monthRows.find((x) => x.month === i + 1);
      return { month: i + 1, count: r ? r.count : 0, revenue: r ? r.revenue : 0 };
    });
    const total = months.reduce((t, m) => ({ count: t.count + m.count, revenue: t.revenue + m.revenue }), {
      count: 0,
      revenue: 0,
    });
    const otherStatus = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM appointments
         WHERE substr(date, 1, 4) = ? AND status IN ('no_show', 'cancelled') GROUP BY status`
      )
      .all(year);
    const byService = db
      .prepare(
        `SELECT COALESCE(service_name, 'Ohne Leistung') AS name, COUNT(*) AS count,
                COALESCE(SUM(price_cents), 0) AS revenue
         FROM appointments WHERE status = 'done' AND substr(date, 1, 4) = ?
         GROUP BY name ORDER BY revenue DESC, count DESC`
      )
      .all(year);
    const years = db
      .prepare(
        `SELECT substr(date, 1, 4) AS year, COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS revenue
         FROM appointments WHERE status = 'done' GROUP BY year ORDER BY year DESC`
      )
      .all();
    const openToClose = db
      .prepare(`SELECT COUNT(*) AS n FROM appointments WHERE status = 'booked' AND (date || ' ' || time) < ?`)
      .get(nowStamp()).n;

    res.json({
      year: Number(year),
      today: today(),
      months,
      total,
      noShows: otherStatus.find((x) => x.status === 'no_show')?.n || 0,
      cancelled: otherStatus.find((x) => x.status === 'cancelled')?.n || 0,
      byService,
      years: years.map((y) => ({ ...y, year: Number(y.year) })),
      openToClose,
    });
  });

  /** CSV-Export der erledigten Termine eines Jahres (z. B. für die Buchhaltung). */
  app.get('/api/admin/export.csv', (req, res) => {
    const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : today().slice(0, 4);
    const rows = db
      .prepare(
        `SELECT date, time, customer_name, service_name, price_cents FROM appointments
         WHERE status = 'done' AND substr(date, 1, 4) = ? ORDER BY date, time`
      )
      .all(year);
    const esc = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keine Formeln in Excel
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [['Datum', 'Uhrzeit', 'Kunde', 'Leistung', 'Betrag (EUR)'].join(';')];
    for (const r of rows) {
      const [y, m, d] = r.date.split('-');
      const euro = ((r.price_cents || 0) / 100).toFixed(2).replace('.', ',');
      lines.push([`${d}.${m}.${y}`, r.time, r.customer_name, r.service_name, euro].map(esc).join(';'));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="termine-${year}.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  // ---------- Inhaber: Leistungen & Einstellungen ----------

  app.get('/api/admin/services', (req, res) => {
    const services = db
      .prepare('SELECT id, name, price_cents AS price, active FROM services ORDER BY sort, id')
      .all()
      .map((s) => ({ ...s, active: Boolean(s.active) }));
    res.json({ services });
  });

  function readService(b) {
    const name = L.cleanText(b.name, 60);
    if (!name) fail(400, 'Bitte einen Namen angeben.');
    const price = L.parseEuro(b.price);
    if (price === null) fail(400, 'Bitte einen gültigen Preis angeben.');
    return { name, price };
  }

  app.post('/api/admin/services', (req, res) => {
    const { name, price } = readService(req.body || {});
    const { m } = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM services').get();
    const info = db.prepare('INSERT INTO services (name, price_cents, sort) VALUES (?, ?, ?)').run(name, price, m);
    res.status(201).json({ id: info.lastInsertRowid });
  });

  app.put('/api/admin/services/:id', (req, res) => {
    const b = req.body || {};
    const service = serviceById(req.params.id) || fail(404, 'Leistung nicht gefunden.');
    const { name, price } = readService(b);
    const active = b.active === undefined ? service.active : b.active ? 1 : 0;
    db.prepare('UPDATE services SET name = ?, price_cents = ?, active = ? WHERE id = ?').run(
      name,
      price,
      active,
      service.id
    );
    res.json({ ok: true });
  });

  app.delete('/api/admin/services/:id', (req, res) => {
    const service = serviceById(req.params.id) || fail(404, 'Leistung nicht gefunden.');
    db.prepare('DELETE FROM services WHERE id = ?').run(service.id);
    res.json({ ok: true });
  });

  const SETTING_FIELDS = {
    salonName: { key: 'salon_name', max: 80 },
    infoText: { key: 'info_text', max: 1000 },
    legalText: { key: 'legal_text', max: 8000 },
    bookingLeadMinutes: { key: 'booking_lead_minutes', min: 0, maxNum: 7 * 24 * 60 },
    bookingDaysAhead: { key: 'booking_days_ahead', min: 1, maxNum: 365 },
    cancelUntilHours: { key: 'cancel_until_hours', min: 0, maxNum: 14 * 24 },
  };

  app.get('/api/admin/settings', (req, res) => {
    const s = settings();
    const out = {};
    for (const [field, def] of Object.entries(SETTING_FIELDS)) {
      out[field] = def.maxNum ? toInt(s[def.key], 0) : s[def.key];
    }
    res.json(out);
  });

  app.put('/api/admin/settings', (req, res) => {
    const b = req.body || {};
    const updates = [];
    for (const [field, def] of Object.entries(SETTING_FIELDS)) {
      if (b[field] === undefined) continue;
      if (def.maxNum) {
        const n = toInt(b[field], NaN);
        if (!Number.isFinite(n) || n < def.min || n > def.maxNum) fail(400, `Ungültiger Wert für ${field}.`);
        updates.push([def.key, String(n)]);
      } else {
        const text = typeof b[field] === 'string' ? b[field].trim().slice(0, def.max) : '';
        if (field === 'salonName' && !text) fail(400, 'Bitte einen Namen für den Salon angeben.');
        updates.push([def.key, text]);
      }
    }
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    db.transaction(() => updates.forEach(([k, v]) => upsert.run(k, v)))();
    res.json({ ok: true });
  });

  // ---------- Seiten ----------

  const pub = path.join(__dirname, 'public');
  app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));
  app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(pub, 'admin.html')));
  app.get('/termin/:token', (req, res) => res.sendFile(path.join(pub, 'index.html')));
  app.use(express.static(pub, { index: 'index.html', maxAge: '1h' }));

  // ---------- Fehler ----------

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Ungültige Anfrage.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Da ist etwas schiefgelaufen. Bitte versuch es noch einmal.' });
  });

  return app;
}

if (require.main === module) {
  const isProd = process.env.NODE_ENV === 'production';
  let adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    if (isProd) {
      console.error('Bitte ADMIN_PASSWORD setzen (siehe README).');
      process.exit(1);
    }
    adminPassword = 'admin';
    console.warn('⚠  Kein ADMIN_PASSWORD gesetzt – zum Testen gilt das Passwort "admin".');
  }
  const db = openDatabase(process.env.DB_PATH || path.join(__dirname, 'data', 'salon.db'));
  const trustProxy = process.env.TRUST_PROXY === undefined ? 1 : toInt(process.env.TRUST_PROXY, 0);
  const publicUrl = process.env.PUBLIC_URL || null;
  const sendMail = createMailerFromEnv(process.env);
  if (sendMail && !publicUrl) {
    console.warn('⚠  SMTP ist eingerichtet, aber PUBLIC_URL fehlt – es werden keine Bestätigungen verschickt.');
  } else if (sendMail) {
    sendMail
      .verify()
      .then(() => console.log('E-Mail-Versand bereit.'))
      .catch((err) => console.error('⚠  E-Mail-Versand klappt nicht:', err.message));
  }
  const app = createApp({
    db,
    adminPassword,
    timeZone: process.env.TIMEZONE || 'Europe/Berlin',
    trustProxy,
    sendMail,
    publicUrl,
  });
  const port = toInt(process.env.PORT, 3000);
  app.listen(port, () => {
    console.log(`Buchungsseite:  http://localhost:${port}/`);
    console.log(`Dein Bereich:   http://localhost:${port}/admin`);
  });
}

module.exports = { createApp };
