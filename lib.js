'use strict';

// Kleine Hilfsfunktionen: Zeit (in der Zeitzone des Salons), Prüfungen, Geld.

function localParts(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/** "YYYY-MM-DD HH:MM" in der Salon-Zeitzone, optional um Minuten verschoben. */
function localStamp(timeZone, offsetMinutes = 0, now = Date.now()) {
  const p = localParts(timeZone, new Date(now + offsetMinutes * 60000));
  return `${p.date} ${p.time}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function isDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function isTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

function isMonth(s) {
  return typeof s === 'string' && MONTH_RE.test(s);
}

function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** ISO-Wochentag: 1 = Montag … 7 = Sonntag */
function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

const WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** "Dienstag, 24. November 2026" */
function fmtDateLong(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS_LONG[weekday(date) - 1]}, ${d}. ${MONTHS[m - 1]} ${y}`;
}

/** "Di, 24.11." */
function fmtDateShort(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS_SHORT[weekday(date) - 1]}, ${d}.${m}.`;
}

/** 1000 → "10 €", 1050 → "10,50 €" */
function fmtEuro(cents) {
  const v = cents / 100;
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
  }).format(v);
}

/** Text säubern und kürzen. Gibt '' zurück, wenn nichts Brauchbares kommt. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

/** "25", "25,50", "25.5", 25 → Cent. Ungültig → null */
function parseEuro(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value < 100000 ? Math.round(value * 100) : null;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

function isPlausiblePhone(s) {
  return /^[0-9+()\/\-\s.]{6,30}$/.test(s) && (s.match(/\d/g) || []).length >= 6;
}

// Keine Kommas, Klammern o. Ä., damit nie mehrere Empfänger daraus werden.
function isPlausibleEmail(s) {
  return /^[^\s@,;:<>()[\]\\"]{1,64}@[^\s@,;:<>()[\]\\"]{1,190}\.[^\s@,;:<>()[\]\\".]{2,}$/.test(s);
}

// ---------- Echte IP-Adresse der Besucher hinter dem Hoster ----------

const net = require('node:net');

// Private Netze (interne Proxys des Hosters) und Cloudflare (sitzt z. B. bei Render vor jeder App).
// Cloudflare-Adressen: https://www.cloudflare.com/ips/
const KNOWN_PROXY_NETS = [
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16',
  'fc00::/7', 'fe80::/10', '::1/128',
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];
const knownProxies = new net.BlockList();
for (const cidr of KNOWN_PROXY_NETS) {
  const [address, prefix] = cidr.split('/');
  knownProxies.addSubnet(address, Number(prefix), address.includes(':') ? 'ipv6' : 'ipv4');
}

function isKnownProxy(address) {
  const addr = String(address).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (net.isIPv4(addr)) return knownProxies.check(addr, 'ipv4');
  if (net.isIPv6(addr)) return knownProxies.check(addr, 'ipv6');
  return false;
}

/**
 * Für Express' "trust proxy": Wem glauben wir die Angabe X-Forwarded-For?
 * - immer dem direkten Absender (dem Proxy des Hosters),
 * - dahinter genau einem weiteren Proxy, aber nur, wenn er aus einem privaten Netz oder von Cloudflare kommt.
 * So wird bei Render (Cloudflare → Render → App) und bei Hostern mit einem Proxy die echte Adresse
 * erkannt, und niemand kann sich mit einer selbst geschickten Angabe eine andere Adresse geben.
 */
function trustHostingProxies(address, hop) {
  return hop === 0 || (hop === 1 && isKnownProxy(address));
}

/** Sehr einfache Begrenzung von Anfragen pro Schlüssel (z. B. IP-Adresse). */
function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return true;
  };
}

module.exports = {
  localParts,
  localStamp,
  isDate,
  isTime,
  isMonth,
  toMinutes,
  fromMinutes,
  addDays,
  weekday,
  fmtDateLong,
  fmtDateShort,
  fmtEuro,
  cleanText,
  parseEuro,
  isPlausiblePhone,
  isPlausibleEmail,
  createRateLimiter,
  isKnownProxy,
  trustHostingProxies,
};
