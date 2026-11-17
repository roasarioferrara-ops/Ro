'use strict';

/* Gemeinsame Hilfen für Kundenseite und Inhaberbereich. */

const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Element bauen. Text wird immer als Text eingefügt (kein HTML) – sicher gegen Einschleusen. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Wie replaceChildren, lässt aber leere Einträge (null/false) weg. */
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}

function icon(name) {
  const paths = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M6 6l12 12M18 6L6 18',
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    plus: 'M12 5v14M5 12h14',
    phone: 'M6.6 10.8a15 15 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11.4 11.4 0 003.6.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1z',
    calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
    download: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14',
  };
  const filled = name === 'phone';
  return s(
    'svg',
    { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none' },
    s('path', {
      d: paths[name],
      stroke: 'currentColor',
      'stroke-width': filled ? 1.6 : 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })
  );
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* keine JSON-Antwort */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Verbindungsproblem. Bitte versuchen Sie es noch einmal.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function parseDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoWeekday(date) {
  const wd = parseDate(date).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** "Dienstag, 18. November 2026" */
function fmtDateLong(date, withYear = true) {
  const d = parseDate(date);
  const base = `${WEEKDAYS_LONG[isoWeekday(date) - 1]}, ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${base} ${d.getUTCFullYear()}` : base;
}

/** "Di, 18.11." */
function fmtDateShort(date) {
  const d = parseDate(date);
  return `${WEEKDAYS_SHORT[isoWeekday(date) - 1]}, ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
}

/** "18.11.2026" */
function fmtDateNumeric(date) {
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}

const euroFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euroFormatRound = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});
const numberFormat = new Intl.NumberFormat('de-DE');

function euro(cents, round = false) {
  if (cents === null || cents === undefined) return '–';
  const v = cents / 100;
  return round && Number.isInteger(v) ? euroFormatRound.format(v) : euroFormat.format(v);
}

/** Preis für Eingabefelder: 2550 → "25,50", 2500 → "25" */
function euroInput(cents) {
  if (cents === null || cents === undefined) return '';
  const v = cents / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',');
}

function addDaysIso(date, days) {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let toastTimer;
function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* privates Fenster o. ä. – egal */
  }
}
