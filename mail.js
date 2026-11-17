'use strict';

// Bestätigungs-E-Mails an Kunden. Ohne SMTP-Zugangsdaten werden keine E-Mails verschickt.

const L = require('./lib');

/**
 * Baut aus den Umgebungsvariablen eine Funktion zum Verschicken von E-Mails.
 * Gibt null zurück, wenn kein SMTP_HOST gesetzt ist.
 */
function createMailerFromEnv(env = process.env, log = console) {
  if (!env.SMTP_HOST) return null;
  const fromAddress = (env.MAIL_FROM || env.SMTP_USER || '').trim();
  if (!fromAddress || (env.SMTP_USER && !env.SMTP_PASS)) {
    log.warn('⚠  E-Mail-Versand ist aus: SMTP_USER und SMTP_PASS (oder MAIL_FROM) fehlen.');
    return null;
  }
  const nodemailer = require('nodemailer');
  const port = Number.parseInt(env.SMTP_PORT || '465', 10);
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure, // Ohne direkte Verschlüsselung muss STARTTLS klappen, sonst wird nichts gesendet.
    auth: env.SMTP_USER ? { user: env.SMTP_USER.trim(), pass: env.SMTP_PASS } : undefined,
  });

  const send = ({ fromName, ...message }) =>
    transport.sendMail({ from: { name: fromName || '', address: fromAddress }, ...message });
  send.verify = () => transport.verify();
  return send;
}

/** Kalendereintrag (.ics) in Ortszeit, wie auf der Buchungsseite. */
function icsEvent({ token, date, time, duration, title, url, now = new Date() }) {
  const day = date.replace(/-/g, '');
  const end = L.toMinutes(time) + (duration || 30);
  const endTime = L.fromMinutes(Math.min(end, 23 * 60 + 59)).replace(':', '');
  const clean = (s) => s.replace(/[\\;,]/g, ' ').replace(/[\r\n]+/g, ' ');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Friseur-Termine//DE',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${token}@friseur-termine`,
    `DTSTAMP:${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART:${day}T${time.replace(':', '')}00`,
    `DTEND:${day}T${endTime}00`,
    `SUMMARY:${clean(title)}`,
    `DESCRIPTION:Termin ansehen oder absagen: ${url}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Inhalt der Bestätigung nach einer Online-Buchung. */
function bookingConfirmation({ salonName, customerName, email, token, date, time, duration, serviceName, price, manageUrl }) {
  // Zeilenumbrüche usw. aus dem Namen entfernen, damit niemand eigenen Text in die E-Mail schmuggelt.
  const name = customerName.replace(/\s+/g, ' ').trim();
  const service = serviceName ? `${serviceName}${price !== null && price !== undefined ? ` (${L.fmtEuro(price)})` : ''}` : null;
  const text = [
    `Hallo ${name},`,
    '',
    'dein Termin ist gebucht:',
    '',
    `    ${L.fmtDateLong(date)}, ${time} Uhr`,
    ...(service ? [`    ${service}`] : []),
    '',
    'Falls du nicht kannst, sag bitte über diesen Link ab:',
    manageUrl,
    '',
    'Bis bald!',
    salonName,
    '',
  ].join('\n');

  return {
    fromName: salonName,
    to: { name, address: email },
    subject: `Dein Termin am ${L.fmtDateShort(date)} um ${time} Uhr`,
    text,
    attachments: [
      {
        filename: 'termin.ics',
        contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
        content: icsEvent({
          token,
          date,
          time,
          duration,
          title: serviceName ? `${serviceName} – ${salonName}` : `Friseurtermin – ${salonName}`,
          url: manageUrl,
        }),
      },
    ],
  };
}

module.exports = { createMailerFromEnv, bookingConfirmation, icsEvent };
