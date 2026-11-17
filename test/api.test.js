'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../db');
const { createApp } = require('../server');

// Feste Uhr: Dienstag, 17.11.2026, 09:00 Uhr in Berlin
let nowMs = Date.parse('2026-11-17T08:00:00Z');

async function setup() {
  const db = openDatabase(':memory:');
  const app = createApp({ db, adminPassword: 'geheim', clock: () => nowMs, trustProxy: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function call(method, path, body, { auth = true } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* CSV usw. */
    }
    return { status: res.status, data, headers: res.headers };
  }

  async function login() {
    const r = await call('POST', '/api/admin/login', { password: 'geheim' });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
  }

  return { db, server, call, login, close: () => server.close() };
}

const customer = { name: 'Max Muster', phone: '0170 1234567', consent: true };

test('Kunden sehen nur freigegebene, freie Termine und können buchen', async (t) => {
  nowMs = Date.parse('2026-11-17T08:00:00Z');
  const ctx = await setup();
  t.after(ctx.close);

  const info = await ctx.call('GET', '/api/info');
  assert.equal(info.status, 200);
  assert.ok(info.data.services.length > 0);
  const serviceId = info.data.services[0].id;

  // Noch nichts freigegeben
  assert.deepEqual((await ctx.call('GET', '/api/slots')).data.slots, []);

  // Admin-Bereich ist geschützt
  assert.equal((await ctx.call('POST', '/api/admin/slots', { date: '2026-11-18', time: '10:00' })).status, 401);
  assert.equal((await ctx.call('POST', '/api/admin/login', { password: 'falsch' })).status, 401);
  await ctx.login();

  // Serie: Mi + Do, 10–12 Uhr, 30 Minuten → 2 Tage × 4 Termine
  const series = {
    fromDate: '2026-11-18',
    toDate: '2026-11-19',
    weekdays: [3, 4],
    startTime: '10:00',
    endTime: '12:00',
    duration: 30,
  };
  const preview = await ctx.call('POST', '/api/admin/slots', { ...series, preview: true });
  assert.equal(preview.data.created, 8);
  assert.equal((await ctx.call('GET', '/api/admin/slots')).data.slots.length, 0, 'Vorschau speichert nichts');

  const created = await ctx.call('POST', '/api/admin/slots', series);
  assert.equal(created.status, 201);
  assert.equal(created.data.created, 8);

  // Noch einmal → alles überschneidet sich
  const again = await ctx.call('POST', '/api/admin/slots', series);
  assert.equal(again.data.created, 0);
  assert.equal(again.data.skippedOverlap, 8);

  // Überschneidung mit anderer Dauer wird auch erkannt
  const overlap = await ctx.call('POST', '/api/admin/slots', { date: '2026-11-18', time: '10:15', duration: 30 });
  assert.equal(overlap.data.created, 0);

  const { slots } = (await ctx.call('GET', '/api/slots')).data;
  assert.equal(slots.length, 8);
  const slot = slots[0];

  // Prüfungen beim Buchen
  assert.equal((await ctx.call('POST', '/api/bookings', { ...customer, slotId: slot.id, serviceId, consent: false })).status, 400);
  assert.equal((await ctx.call('POST', '/api/bookings', { ...customer, slotId: slot.id, serviceId, phone: '' })).status, 400);
  assert.equal((await ctx.call('POST', '/api/bookings', { ...customer, slotId: slot.id })).status, 400, 'Leistung fehlt');
  assert.equal((await ctx.call('POST', '/api/bookings', { ...customer, slotId: slot.id, serviceId, website: 'spam' })).status, 400);

  const booked = await ctx.call('POST', '/api/bookings', { ...customer, slotId: slot.id, serviceId });
  assert.equal(booked.status, 201);
  assert.ok(booked.data.token);
  assert.equal(booked.data.date, '2026-11-18');
  assert.equal(booked.data.time, '10:00');

  // Doppelt buchen geht nicht
  const twice = await ctx.call('POST', '/api/bookings', { ...customer, name: 'Erika', slotId: slot.id, serviceId });
  assert.equal(twice.status, 409);

  // Gebuchter Termin ist für andere nicht mehr sichtbar, Kundendaten werden nie öffentlich gezeigt
  const after = (await ctx.call('GET', '/api/slots')).data.slots;
  assert.equal(after.length, 7);
  assert.ok(!JSON.stringify(after).includes('Max'));

  // Gebuchte Zeitfenster kann man nicht löschen
  assert.equal((await ctx.call('DELETE', `/api/admin/slots/${slot.id}`)).status, 409);
  assert.equal((await ctx.call('DELETE', `/api/admin/slots/${after[0].id}`)).status, 200);

  // Kunde sieht seinen Termin über den Link und kann absagen
  const view = await ctx.call('GET', `/api/bookings/${booked.data.token}`);
  assert.equal(view.data.status, 'booked');
  assert.equal(view.data.canCancel, true);
  assert.equal((await ctx.call('POST', `/api/bookings/${booked.data.token}/cancel`)).status, 200);
  assert.equal((await ctx.call('GET', '/api/slots')).data.slots.length, 7, 'wieder frei');
  assert.equal((await ctx.call('GET', '/api/bookings/unbekannt-1234567890')).status, 404);
});

test('Erledigte Termine zählen in Monats- und Jahresstatistik', async (t) => {
  nowMs = Date.parse('2026-11-17T08:00:00Z');
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.login();
  const services = (await ctx.call('GET', '/api/info')).data.services;
  const herren = services.find((s) => s.name === 'Herrenhaarschnitt');

  await ctx.call('POST', '/api/admin/slots', { date: '2026-11-17', time: '11:00', duration: 30 });
  await ctx.call('POST', '/api/admin/slots', { date: '2026-11-17', time: '12:00', duration: 30 });
  const slots = (await ctx.call('GET', '/api/slots')).data.slots;
  assert.equal(slots.length, 2);

  const a = await ctx.call('POST', '/api/bookings', { ...customer, slotId: slots[0].id, serviceId: herren.id });
  const b = await ctx.call('POST', '/api/bookings', { ...customer, name: 'Erika', slotId: slots[1].id, serviceId: herren.id });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  // Später am Tag: Termine sind vorbei
  nowMs = Date.parse('2026-11-17T13:00:00Z');
  const open = (await ctx.call('GET', '/api/admin/appointments?status=booked')).data.appointments;
  assert.equal(open.length, 2);
  assert.equal(open[0].phone, '0170 1234567', 'Inhaber sieht Kontaktdaten');
  assert.equal((await ctx.call('GET', '/api/admin/stats?year=2026')).data.openToClose, 2);

  // Termin 1 erledigt mit vorgeschlagenem Preis, Termin 2 nicht erschienen
  const done = await ctx.call('POST', `/api/admin/appointments/${open[0].id}/complete`, {});
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.price, herren.price);
  await ctx.call('POST', `/api/admin/appointments/${open[1].id}/no-show`);

  // Laufkundschaft mit eigenem Preis
  const walk = await ctx.call('POST', '/api/admin/appointments', { date: '2026-11-17', time: '15:00', price: '30,50' });
  assert.equal(walk.status, 201);
  assert.equal(walk.data.price, 3050);
  assert.equal(walk.data.customerName, 'Laufkundschaft');

  // Eintrag aus dem Oktober
  await ctx.call('POST', '/api/admin/appointments', { date: '2026-10-02', time: '09:00', price: 20, name: 'Tom' });

  const st = (await ctx.call('GET', '/api/admin/stats?year=2026')).data;
  assert.equal(st.months[10].count, 2); // November
  assert.equal(st.months[10].revenue, herren.price + 3050);
  assert.equal(st.months[9].count, 1); // Oktober
  assert.equal(st.months[9].revenue, 2000);
  assert.equal(st.total.count, 3);
  assert.equal(st.total.revenue, herren.price + 3050 + 2000);
  assert.equal(st.noShows, 1);
  assert.equal(st.openToClose, 0);
  assert.deepEqual(st.years, [{ year: 2026, count: 3, revenue: herren.price + 5050 }]);

  // Preis nachträglich ändern
  await ctx.call('POST', `/api/admin/appointments/${open[0].id}/complete`, { price: '28' });
  const st2 = (await ctx.call('GET', '/api/admin/stats?year=2026')).data;
  assert.equal(st2.months[10].revenue, 2800 + 3050);

  // Rückgängig → zählt nicht mehr
  await ctx.call('POST', `/api/admin/appointments/${open[0].id}/reopen`);
  const st3 = (await ctx.call('GET', '/api/admin/stats?year=2026')).data;
  assert.equal(st3.months[10].count, 1);

  // Monatsliste
  const month = (await ctx.call('GET', '/api/admin/appointments?month=2026-11&status=done')).data.appointments;
  assert.equal(month.length, 1);

  // CSV-Export
  const csv = await ctx.call('GET', '/api/admin/export.csv?year=2026');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /02\.10\.2026;09:00;Tom;;20,00/);
  assert.match(csv.data, /Laufkundschaft;;30,50/);
});

test('Buchungsregeln: Vorlauf, Absagefrist, Einstellungen', async (t) => {
  nowMs = Date.parse('2026-11-17T08:00:00Z'); // 09:00 Berlin
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.login();

  await ctx.call('PUT', '/api/admin/settings', { salonName: 'Salon Ro', bookingLeadMinutes: 120, cancelUntilHours: 24 });
  assert.equal((await ctx.call('GET', '/api/info')).data.salonName, 'Salon Ro');

  // Vergangenes wird nicht angelegt
  const past = await ctx.call('POST', '/api/admin/slots', { date: '2026-11-17', time: '08:00', duration: 30 });
  assert.equal(past.data.skippedPast, 1);

  await ctx.call('POST', '/api/admin/slots', { date: '2026-11-17', time: '10:00', duration: 30 }); // innerhalb Vorlauf
  await ctx.call('POST', '/api/admin/slots', { date: '2026-11-17', time: '12:00', duration: 30 });
  const slots = (await ctx.call('GET', '/api/slots')).data.slots;
  assert.deepEqual(slots.map((s) => s.time), ['12:00']);

  const services = (await ctx.call('GET', '/api/info')).data.services;
  const booked = await ctx.call('POST', '/api/bookings', { ...customer, slotId: slots[0].id, serviceId: services[0].id });
  assert.equal(booked.status, 201);
  // Absagen nur bis 24 h vorher → heute nicht mehr
  const view = await ctx.call('GET', `/api/bookings/${booked.data.token}`);
  assert.equal(view.data.canCancel, false);
  assert.equal((await ctx.call('POST', `/api/bookings/${booked.data.token}/cancel`)).status, 409);

  // Inhaber kann absagen, danach ist der Termin wieder frei
  const appts = (await ctx.call('GET', '/api/admin/appointments?status=booked')).data.appointments;
  assert.equal((await ctx.call('POST', `/api/admin/appointments/${appts[0].id}/cancel`)).status, 200);
  assert.equal((await ctx.call('GET', '/api/slots')).data.slots.length, 1);

  // Inhaber trägt jemanden selbst ein (ohne Telefon)
  const own = await ctx.call('POST', `/api/admin/slots/${slots[0].id}/book`, { name: 'Oma Hilde' });
  assert.equal(own.status, 201);
  assert.equal((await ctx.call('GET', '/api/slots')).data.slots.length, 0);

  // Leistungen verwalten
  const add = await ctx.call('POST', '/api/admin/services', { name: 'Färben', price: '60' });
  assert.equal(add.status, 201);
  await ctx.call('PUT', `/api/admin/services/${add.data.id}`, { name: 'Färben', price: '65', active: false });
  const pub = (await ctx.call('GET', '/api/info')).data.services;
  assert.ok(!pub.some((s) => s.name === 'Färben'), 'ausgeblendete Leistung ist nicht öffentlich');

  // Ohne Leistungen: Kunden buchen nur einen Termin
  for (const s of (await ctx.call('GET', '/api/admin/services')).data.services) {
    await ctx.call('DELETE', `/api/admin/services/${s.id}`);
  }
  assert.deepEqual((await ctx.call('GET', '/api/info')).data.services, []);
  await ctx.call('POST', '/api/admin/slots', { date: '2026-11-20', time: '09:00', duration: 45 });
  const free = (await ctx.call('GET', '/api/slots')).data.slots;
  const plain = await ctx.call('POST', '/api/bookings', { ...customer, slotId: free[0].id });
  assert.equal(plain.status, 201);
  assert.equal(plain.data.serviceName, null);
  assert.equal(plain.data.duration, 45);

  // Abmelden
  await ctx.call('POST', '/api/admin/logout');
  assert.equal((await ctx.call('GET', '/api/admin/me')).status, 401);
});
