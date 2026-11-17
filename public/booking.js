'use strict';

/* Kundenseite: Leistung wählen → Tag & Uhrzeit wählen → Angaben → gebucht. */

const state = {
  info: null,
  slots: [],
  serviceId: null,
  date: null,
  slotId: null,
};

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'meine-termine';

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hasServices() {
  return state.info && state.info.services.length > 0;
}

function selectedService() {
  return hasServices() ? state.info.services.find((x) => x.id === state.serviceId) : null;
}

function selectedSlot() {
  return state.slots.find((x) => x.id === state.slotId) || null;
}

// ---------- Kopf, Leistungen ----------

function renderInfo() {
  const { salonName, infoText, legalText } = state.info;
  document.title = `Termin buchen – ${salonName}`;
  $('salon-name').textContent = salonName;
  $('footer-name').textContent = salonName;
  $('info-text').textContent = infoText || '';
  $('email-hint').hidden = !state.info.emailConfirmation;
  if (legalText) {
    $('legal-text').textContent = legalText;
    $('legal').hidden = false;
  }
  if (!hasServices()) {
    $('step-service').hidden = true;
    document.querySelectorAll('[data-step]').forEach((el, i) => {
      el.textContent = String(i + 1);
    });
  } else {
    $('step-service').hidden = false;
    renderServices();
  }
}

function renderServices() {
  const list = $('services');
  fill(list,
    ...state.info.services.map((svc) =>
      h(
        'button',
        {
          type: 'button',
          class: 'choice',
          role: 'radio',
          'aria-checked': String(svc.id === state.serviceId),
          onclick: () => {
            const first = state.serviceId === null;
            state.serviceId = svc.id;
            renderServices();
            renderDetails();
            if (first && !state.slotId) $('step-time').scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
        h('span', { text: svc.name }),
        h('span', { class: 'price', text: euro(svc.price, true) })
      )
    )
  );
}

// ---------- Tage & Uhrzeiten ----------

async function loadSlots() {
  try {
    const { slots } = await api('/api/slots');
    state.slots = slots;
  } catch (err) {
    $('slots-loading').textContent = err.message;
    return;
  }
  $('slots-loading').hidden = true;
  if (state.slotId && !selectedSlot()) state.slotId = null;
  const dates = [...new Set(state.slots.map((x) => x.date))];
  if (!dates.includes(state.date)) state.date = dates[0] || null;
  $('slots-empty').hidden = dates.length > 0;
  $('slots-ui').hidden = dates.length === 0;
  renderDays(dates);
  renderTimes();
  renderDetails();
}

function renderDays(dates) {
  const counts = {};
  for (const sl of state.slots) counts[sl.date] = (counts[sl.date] || 0) + 1;
  fill($('days'),
    ...dates.map((date) => {
      const d = parseDate(date);
      return h(
        'button',
        {
          type: 'button',
          class: 'day',
          role: 'tab',
          'aria-selected': String(date === state.date),
          'aria-label': `${fmtDateLong(date, false)}, ${counts[date]} frei`,
          onclick: () => {
            state.date = date;
            renderDays(dates);
            renderTimes();
          },
        },
        h('span', { class: 'wd', text: WEEKDAYS_SHORT[isoWeekday(date) - 1] }),
        h('span', { class: 'dd', text: d.getUTCDate() }),
        h('span', { class: 'mm', text: MONTHS_SHORT[d.getUTCMonth()] }),
        h('span', { class: 'free', text: `${counts[date]} frei` })
      );
    })
  );
  const active = $('days').querySelector('[aria-selected="true"]');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderTimes() {
  if (!state.date) return;
  $('day-title').textContent = fmtDateLong(state.date, false);
  const daySlots = state.slots.filter((x) => x.date === state.date);
  fill($('times'),
    ...daySlots.map((sl) =>
      h('button', {
        type: 'button',
        class: 'time',
        'aria-pressed': String(sl.id === state.slotId),
        'aria-label': `${sl.time} Uhr`,
        text: sl.time,
        onclick: () => {
          state.slotId = sl.id;
          renderTimes();
          renderDetails();
          $('step-details').scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      })
    )
  );
}

// ---------- Angaben & Buchung ----------

function renderDetails() {
  const slot = selectedSlot();
  const ready = Boolean(slot) && (!hasServices() || state.serviceId !== null);
  $('step-details').classList.toggle('is-locked', !ready);
  $('form').hidden = !ready;
  $('details-hint').hidden = ready;
  if (!slot) $('details-hint').textContent = 'Bitte wähl zuerst einen Termin.';
  else if (!ready) $('details-hint').textContent = 'Bitte wähl oben noch aus, was gemacht werden soll.';
  if (!ready) return;
  const svc = selectedService();
  fill($('summary'),
    h('span', { class: 'muted small', text: 'Dein Termin' }),
    h('strong', { text: `${fmtDateLong(slot.date, false)}, ${slot.time} Uhr` }),
    svc ? h('span', { text: `${svc.name} · ${euro(svc.price, true)}` }) : null
  );
}

function showFormError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = !message;
  if (message) $('form-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitBooking(event) {
  event.preventDefault();
  showFormError('');
  const name = $('name').value.trim();
  const phone = $('phone').value.trim();
  if (name.length < 2) return showFormError('Bitte gib deinen Namen ein.');
  if (phone.replace(/\D/g, '').length < 6) return showFormError('Bitte gib deine Telefonnummer ein.');
  if (!$('consent').checked) return showFormError('Bitte bestätige, dass deine Angaben gespeichert werden dürfen.');

  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = 'Wird gebucht …';
  try {
    const result = await api('/api/bookings', {
      method: 'POST',
      body: {
        slotId: state.slotId,
        serviceId: state.serviceId,
        name,
        phone,
        email: $('email').value.trim(),
        note: $('note').value.trim(),
        consent: true,
        website: $('website').value,
      },
    });
    rememberBooking(result);
    showConfirmation(result);
  } catch (err) {
    showFormError(err.message);
    if (err.status === 409) {
      state.slotId = null;
      await loadSlots();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Termin verbindlich buchen';
  }
}

function manageUrl(token) {
  return `${location.origin}/termin/${token}`;
}

function icsFile(booking) {
  const start = `${booking.date.replace(/-/g, '')}T${booking.time.replace(':', '')}00`;
  const [hh, mm] = booking.time.split(':').map(Number);
  const endMin = hh * 60 + mm + (booking.duration || 30);
  const end = `${booking.date.replace(/-/g, '')}T${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}${String(endMin % 60).padStart(2, '0')}00`;
  const salon = state.info.salonName.replace(/[,;\\]/g, ' ');
  const what = booking.serviceName ? `${booking.serviceName} – ${salon}` : `Friseurtermin – ${salon}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Friseur-Termine//DE',
    'BEGIN:VEVENT',
    `UID:${booking.token}@friseur-termine`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${what.replace(/[,;\\]/g, ' ')}`,
    `DESCRIPTION:Termin verwalten: ${manageUrl(booking.token)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return new Blob([lines.join('\r\n')], { type: 'text/calendar' });
}

function showConfirmation(result) {
  $('booking').hidden = true;
  $('mine').hidden = true;
  const url = manageUrl(result.token);
  const calendar = h('a', { class: 'btn', download: 'friseurtermin.ics', href: URL.createObjectURL(icsFile(result)) }, icon('calendar'), 'In den Kalender');
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast('Link kopiert');
        } catch {
          toast('Bitte den Link oben markieren und kopieren');
        }
      },
    },
    'Link kopieren'
  );
  fill($('done'),
    h('div', { class: 'tick' }, icon('check')),
    h('h2', { text: 'Danke – dein Termin ist gebucht!' }),
    h('p', { class: 'when', text: `${fmtDateLong(result.date)}, ${result.time} Uhr` }),
    result.serviceName ? h('p', { class: 'muted', text: result.serviceName }) : null,
    result.confirmationEmail
      ? h('p', { class: 'muted small', text: 'Eine Bestätigung ist per E-Mail zu dir unterwegs.' })
      : null,
    h('p', {
      class: 'muted small',
      text: 'Falls du nicht kannst, sag bitte über diesen Link ab. Am besten speicherst du ihn dir:',
    }),
    h('div', { class: 'link-box' }, h('a', { href: url, text: url })),
    h('div', { class: 'actions' }, calendar, copy)
  );
  $('done').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- Eigene Termine (auf diesem Gerät gemerkt) ----------

function rememberBooking(b) {
  const list = storageGet(STORAGE_KEY, []).filter((x) => x && x.token !== b.token);
  list.push({ token: b.token, date: b.date, time: b.time, serviceName: b.serviceName });
  storageSet(STORAGE_KEY, list.slice(-10));
}

async function renderMine() {
  const today = localToday();
  const saved = storageGet(STORAGE_KEY, []).filter((x) => x && x.token && x.date >= today);
  const checked = await Promise.all(
    saved.map(async (x) => {
      try {
        const b = await api(`/api/bookings/${encodeURIComponent(x.token)}`);
        return b.status === 'booked' ? { ...x, ...b } : null;
      } catch (err) {
        return err.status === 404 ? null : x;
      }
    })
  );
  const active = checked.filter(Boolean).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  storageSet(STORAGE_KEY, active.map(({ token, date, time, serviceName }) => ({ token, date, time, serviceName })));
  if (active.length === 0) return;
  fill($('mine-list'),
    ...active.map((b) =>
      h(
        'div',
        { class: 'mine-item' },
        h(
          'div',
          null,
          h('strong', { text: `${fmtDateShort(b.date)} ${b.time} Uhr` }),
          b.serviceName ? h('div', { class: 'muted small', text: b.serviceName }) : null
        ),
        h('a', { class: 'btn btn-sm', href: `/termin/${b.token}`, text: 'Ansehen / absagen' })
      )
    )
  );
  $('mine').hidden = false;
}

// ---------- Termin über Link verwalten ----------

async function renderManage(token) {
  const box = $('manage');
  box.hidden = false;
  $('booking').hidden = true;
  fill(box, h('p', { class: 'empty', text: 'Termin wird geladen …' }));
  let b;
  try {
    b = await api(`/api/bookings/${encodeURIComponent(token)}`);
  } catch (err) {
    fill(box,
      h('h2', { class: 'step-head', text: 'Termin nicht gefunden' }),
      h('p', { class: 'muted', text: 'Bitte prüf den Link oder buch einfach neu.' }),
      newBookingButton()
    );
    return;
  }

  const head = {
    booked: 'Dein Termin',
    cancelled: 'Dieser Termin wurde abgesagt',
    done: 'Danke für deinen Besuch!',
    no_show: 'Dieser Termin ist vorbei',
  }[b.status];

  const parts = [
    h('h2', { class: 'step-head', text: head }),
    h('p', { class: 'when', text: `${fmtDateLong(b.date)}, ${b.time} Uhr` }),
    b.serviceName ? h('p', { class: 'muted', text: b.serviceName }) : null,
  ];
  const err = h('div', { class: 'alert alert-error', role: 'alert', hidden: true });

  if (b.status === 'booked' && b.canCancel) {
    const cancel = h('button', {
      type: 'button',
      class: 'btn btn-danger',
      text: 'Termin absagen',
      onclick: async () => {
        if (!confirm('Möchtest du diesen Termin wirklich absagen?')) return;
        cancel.disabled = true;
        try {
          await api(`/api/bookings/${encodeURIComponent(token)}/cancel`, { method: 'POST' });
          toast('Termin abgesagt');
          renderManage(token);
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
          cancel.disabled = false;
        }
      },
    });
    parts.push(err, h('div', { class: 'actions' }, cancel));
  } else if (b.status === 'booked') {
    parts.push(
      h('p', {
        class: 'alert alert-warn',
        text: 'Online absagen geht so kurzfristig leider nicht mehr. Bitte ruf kurz an.',
      })
    );
  }
  parts.push(newBookingButton());
  fill(box, ...parts);
}

function newBookingButton() {
  return h('p', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '/', text: 'Neuen Termin buchen' }));
}

// ---------- Start ----------

async function init() {
  try {
    state.info = await api('/api/info');
  } catch (err) {
    $('slots-loading').textContent = err.message;
    return;
  }
  renderInfo();
  $('form').addEventListener('submit', submitBooking);

  const match = location.pathname.match(/^\/termin\/([A-Za-z0-9_-]+)$/);
  if (match) {
    renderManage(match[1]);
    return;
  }
  renderMine();
  loadSlots();
}

init();
