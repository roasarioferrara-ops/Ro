'use strict';

/* Inhaberbereich: Termine, Freigeben, Erledigt, Statistik, Einstellungen. */

const $ = (id) => document.getElementById(id);
const DURATIONS = [15, 20, 30, 40, 45, 60, 75, 90, 120];
const TABS = ['termine', 'freigeben', 'erledigt', 'statistik', 'einstellungen'];

const state = {
  now: '',
  today: '',
  tab: 'termine',
  services: [],
  slotsFrom: null,
  doneMonth: null,
  doneStatus: 'done',
  statsYear: null,
  chartMode: 'revenue',
  stats: null,
};

// ---------- Anmeldung ----------

async function adminApi(path, options) {
  try {
    return await api(path, options);
  } catch (err) {
    if (err.status === 401) showLogin();
    throw err;
  }
}

function showLogin() {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('password').focus();
}

async function login(event) {
  event.preventDefault();
  $('login-error').hidden = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    await start();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
}

async function logout() {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

// ---------- Allgemein ----------

function dayLabel(date) {
  if (date === state.today) return `Heute · ${fmtDateLong(date, false)}`;
  if (date === addDaysIso(state.today, 1)) return `Morgen · ${fmtDateLong(date, false)}`;
  return fmtDateLong(date, date.slice(0, 4) !== state.today.slice(0, 4));
}

function groupBy(items, key) {
  const map = new Map();
  for (const it of items) {
    const k = it[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

function durationOptions(select, selected = 30) {
  fill(select,
    ...DURATIONS.map((m) => h('option', { value: m, selected: m === selected, text: `${m} Minuten` }))
  );
}

function serviceSelect(id, selectedId, { allowNone = true } = {}) {
  const options = state.services.filter((x) => x.active || x.id === selectedId);
  return h(
    'select',
    { id },
    allowNone ? h('option', { value: '', text: '– keine Angabe –' }) : null,
    ...options.map((x) =>
      h('option', { value: x.id, selected: x.id === selectedId, text: `${x.name} (${euro(x.price, true)})` })
    )
  );
}

function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
}

/**
 * Einfacher Dialog. body: Elemente, onSubmit: async () => void (Fehler werden angezeigt).
 * extra: zusätzliche Knöpfe links (z. B. Löschen).
 */
function openDialog({ title, sub, body = [], submitLabel = 'Speichern', onSubmit, extra = [] }) {
  const dialog = $('dialog');
  const form = $('dialog-form');
  const error = h('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit', value: 'ok', text: submitLabel });
  fill(form,
    h('h3', { text: title }),
    sub ? h('p', { class: 'sub', text: sub }) : null,
    error,
    ...body,
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { class: 'btn', type: 'button', text: 'Abbrechen', onclick: () => dialog.close() }),
      submit
    ),
    extra.length ? h('div', { class: 'dialog-extra' }, ...extra) : null
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      await onSubmit();
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  };
  dialog.showModal();
  const first = form.querySelector('input, select, textarea');
  if (first) first.focus();
  return { dialog, error };
}

function setIcon(id, name) {
  $(id).replaceChildren(icon(name));
}

// ---------- Tabs ----------

function showTab(tab) {
  if (!TABS.includes(tab)) tab = 'termine';
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((el) => {
    el.setAttribute('aria-selected', String(el.dataset.tab === tab));
    if (el.dataset.tab === tab) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  document.querySelectorAll('[data-panel]').forEach((el) => {
    el.hidden = el.dataset.panel !== tab;
  });
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  refresh();
}

function refresh() {
  const loaders = {
    termine: loadUpcoming,
    freigeben: () => {
      loadSlots();
      updateSeriesPreview();
    },
    erledigt: loadDone,
    statistik: loadStats,
    einstellungen: loadSettings,
  };
  loaders[state.tab]();
}

// ---------- Termine (anstehend) ----------

function appointmentCard(a, { overdue }) {
  const svc = a.serviceName ? h('span', { class: 'pill pill-accent', text: a.serviceName }) : null;
  const source = a.source === 'admin' ? h('span', { class: 'pill', text: 'von dir eingetragen' }) : null;
  const btns = h(
    'div',
    { class: 'btns' },
    h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => completeDialog(a) }, icon('check'), 'Erledigt'),
    h('button', { class: 'btn btn-sm', type: 'button', text: 'Nicht erschienen', onclick: () => noShow(a) }),
    overdue ? null : h('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Absagen', onclick: () => cancelAppt(a) })
  );
  return h(
    'article',
    { class: `appt${overdue ? ' is-overdue' : ''}` },
    h('div', { class: 't', text: a.time }),
    h('div', { class: 'who' }, a.customerName, ' ', svc, ' ', source),
    h(
      'div',
      { class: 'meta' },
      overdue ? h('span', { text: fmtDateShort(a.date) }) : null,
      a.phone ? h('a', { href: `tel:${a.phone.replace(/[^\d+]/g, '')}` }, a.phone) : null,
      a.email ? h('a', { href: `mailto:${a.email}` }, a.email) : null,
      a.duration ? h('span', { text: `${a.duration} Min.` }) : null
    ),
    a.note ? h('div', { class: 'note', text: a.note }) : null,
    btns
  );
}

async function loadUpcoming() {
  const { now, appointments } = await adminApi('/api/admin/appointments?status=booked');
  state.now = now;
  const overdue = appointments.filter((a) => `${a.date} ${a.time}` <= now);
  const upcoming = appointments.filter((a) => `${a.date} ${a.time}` > now);
  updateBadge(overdue.length);

  $('overdue-box').hidden = overdue.length === 0;
  if (overdue.length) {
    $('overdue-text').textContent =
      overdue.length === 1
        ? 'Dieser Termin ist vorbei. War der Kunde da? Dann auf „Erledigt“ tippen – sonst fehlt er in der Statistik.'
        : `Diese ${overdue.length} Termine sind vorbei. Waren die Kunden da? Dann auf „Erledigt“ tippen – sonst fehlen sie in der Statistik.`;
    fill($('overdue-list'), ...overdue.map((a) => appointmentCard(a, { overdue: true })));
  }

  if (upcoming.length === 0) {
    fill($('upcoming'),
      h(
        'div',
        { class: 'card empty' },
        h('p', { text: 'Gerade sind keine Termine gebucht.' }),
        h('p', { class: 'small' }, 'Unter ', h('a', { href: '#freigeben', text: 'Freigeben' }), ' kannst du neue Termine für deine Kunden freischalten.')
      )
    );
    return;
  }
  const groups = groupBy(upcoming, 'date');
  fill($('upcoming'),
    ...[...groups].map(([date, list]) =>
      h(
        'div',
        { class: 'day-group' },
        h('div', { class: 'day-label' }, h('span', { text: dayLabel(date) }), h('span', { class: 'muted', text: `${list.length} ${list.length === 1 ? 'Termin' : 'Termine'}` })),
        ...list.map((a) => appointmentCard(a, { overdue: false }))
      )
    )
  );
}

function updateBadge(n) {
  $('badge-open').textContent = String(n);
  $('badge-open').hidden = n === 0;
  $('badge-open').setAttribute('aria-label', `${n} offen`);
}

function completeDialog(a, extra = []) {
  const select = serviceSelect('c-service', a.serviceId);
  const service = state.services.find((x) => x.id === a.serviceId);
  const price = h('input', {
    type: 'text',
    id: 'c-price',
    inputmode: 'decimal',
    value: a.price !== null && a.price !== undefined ? euroInput(a.price) : euroInput(service ? service.price : null),
    placeholder: 'z. B. 25 oder 25,50',
    required: true,
  });
  select.addEventListener('change', () => {
    const svc = state.services.find((x) => String(x.id) === select.value);
    if (svc) price.value = euroInput(svc.price);
  });
  openDialog({
    extra,
    title: a.status === 'done' ? 'Eintrag ändern' : a.status === 'no_show' ? 'War doch da?' : 'Termin abschließen',
    sub: `${a.customerName} · ${fmtDateShort(a.date)} ${a.time} Uhr`,
    body: [field('Leistung', select), field('Bezahlt (€)', price, 'Inklusive Trinkgeld, wenn du möchtest.')],
    submitLabel: a.status === 'done' ? 'Speichern' : 'Erledigt',
    onSubmit: async () => {
      await adminApi(`/api/admin/appointments/${a.id}/complete`, {
        method: 'POST',
        body: { price: price.value, serviceId: select.value === '' ? null : Number(select.value) },
      });
      toast(a.status === 'done' ? 'Gespeichert' : 'Erledigt – zählt jetzt in der Statistik');
      refresh();
    },
  });
  price.select();
}

async function noShow(a) {
  if (!confirm(`${a.customerName} ist nicht erschienen?`)) return;
  await adminApi(`/api/admin/appointments/${a.id}/no-show`, { method: 'POST' });
  toast('Als „nicht erschienen“ markiert');
  refresh();
}

async function cancelAppt(a) {
  if (!confirm(`Termin von ${a.customerName} am ${fmtDateShort(a.date)} um ${a.time} Uhr absagen?\nDer Termin wird wieder frei. Bitte sag dem Kunden Bescheid.`)) return;
  await adminApi(`/api/admin/appointments/${a.id}/cancel`, { method: 'POST' });
  toast('Abgesagt – der Termin ist wieder frei');
  refresh();
}

// ---------- Freigeben ----------

function setupSeriesForm() {
  const labels = WEEKDAYS_SHORT.map((wd, i) =>
    h(
      'label',
      { title: WEEKDAYS_LONG[i] },
      h('input', { type: 'checkbox', value: i + 1, checked: i < 5, 'aria-label': WEEKDAYS_LONG[i] }),
      h('span', { text: wd })
    )
  );
  fill($('s-weekdays'), ...labels);
  durationOptions($('s-duration'));
  durationOptions($('o-duration'));
  $('s-from').value = state.today;
  $('s-to').value = addDaysIso(state.today, 27);
  $('o-date').value = state.today;
  $('series-form').addEventListener('input', debounce(updateSeriesPreview, 250));
  $('series-form').addEventListener('submit', submitSeries);
  $('single-form').addEventListener('submit', submitSingle);
}

function seriesBody() {
  return {
    fromDate: $('s-from').value,
    toDate: $('s-to').value,
    weekdays: [...$('s-weekdays').querySelectorAll('input:checked')].map((x) => Number(x.value)),
    startTime: $('s-start').value,
    endTime: $('s-end').value,
    duration: Number($('s-duration').value),
  };
}

function describeResult(r, preview) {
  if (r.created === 0) {
    return r.skippedOverlap > 0
      ? 'Diese Termine sind schon alle freigegeben.'
      : 'Mit diesen Angaben entsteht kein Termin.';
  }
  const verb = preview ? 'Es werden' : 'Es wurden';
  let text = `${verb} ${numberFormat.format(r.created)} ${r.created === 1 ? 'Termin' : 'Termine'} freigegeben.`;
  if (r.skippedOverlap) text += ` ${r.skippedOverlap} ${preview ? 'werden' : 'wurden'} übersprungen, weil dort schon etwas freigegeben ist.`;
  return text;
}

let previewSeq = 0;
async function updateSeriesPreview() {
  const seq = ++previewSeq;
  try {
    const r = await adminApi('/api/admin/slots', { method: 'POST', body: { ...seriesBody(), preview: true } });
    if (seq === previewSeq) $('s-preview').textContent = describeResult(r, true);
  } catch (err) {
    if (seq === previewSeq) $('s-preview').textContent = err.message;
  }
}

async function submitSeries(event) {
  event.preventDefault();
  try {
    const r = await adminApi('/api/admin/slots', { method: 'POST', body: seriesBody() });
    toast(describeResult(r, false));
    updateSeriesPreview();
    loadSlots();
  } catch (err) {
    toast(err.message);
  }
}

async function submitSingle(event) {
  event.preventDefault();
  try {
    const r = await adminApi('/api/admin/slots', {
      method: 'POST',
      body: { date: $('o-date').value, time: $('o-time').value, duration: Number($('o-duration').value) },
    });
    if (r.created) toast('Termin freigegeben');
    else if (r.skippedPast) toast('Dieser Zeitpunkt liegt in der Vergangenheit.');
    else toast('Zu dieser Zeit ist schon ein Termin freigegeben.');
    loadSlots();
    updateSeriesPreview();
  } catch (err) {
    toast(err.message);
  }
}

const SLOT_RANGE_DAYS = 14;

async function loadSlots() {
  if (!state.slotsFrom) state.slotsFrom = state.today;
  const from = state.slotsFrom;
  const to = addDaysIso(from, SLOT_RANGE_DAYS - 1);
  $('slots-range').textContent = `${fmtDateShort(from)} bis ${fmtDateShort(to)}`;
  const { slots } = await adminApi(`/api/admin/slots?from=${from}&to=${to}`);
  if (slots.length === 0) {
    fill($('slots-list'),
      h('p', { class: 'empty', text: 'In diesem Zeitraum hast du noch keine Termine freigegeben.' })
    );
    return;
  }
  const groups = groupBy(slots, 'date');
  fill($('slots-list'),
    ...[...groups].map(([date, list]) => {
      const free = list.filter((x) => !x.appointmentId);
      const booked = list.length - free.length;
      return h(
        'div',
        { class: 'day-group' },
        h(
          'div',
          { class: 'day-label' },
          h('span', null, dayLabel(date), ' ', h('span', { class: 'muted', text: `· ${free.length} frei, ${booked} gebucht` })),
          free.length
            ? h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', text: 'Freie löschen', onclick: () => deleteFreeDay(date, free.length) })
            : null
        ),
        h('div', { class: 'slot-chips' }, ...list.map(slotChip))
      );
    })
  );
}

function slotChip(sl) {
  if (sl.appointmentId) {
    const label = sl.status === 'done' ? '✓ ' : sl.status === 'no_show' ? '✗ ' : '';
    return h('span', { class: 'chip is-booked', title: sl.serviceName || '' }, h('span', { class: 't', text: sl.time }), `${label}${sl.customerName}`);
  }
  return h('button', {
    type: 'button',
    class: 'chip is-free',
    text: sl.time,
    'aria-label': `${sl.time} Uhr, frei – eintragen oder löschen`,
    onclick: () => bookForCustomer(sl),
  });
}

async function deleteSlot(sl) {
  try {
    await adminApi(`/api/admin/slots/${sl.id}`, { method: 'DELETE' });
    $('dialog').close();
    toast(`${sl.time} Uhr gelöscht`);
    loadSlots();
    updateSeriesPreview();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteFreeDay(date, n) {
  if (!confirm(`Alle ${n} freien Termine am ${fmtDateLong(date, false)} löschen?\nGebuchte Termine bleiben bestehen.`)) return;
  const r = await adminApi('/api/admin/slots/delete-free', { method: 'POST', body: { from: date, to: date } });
  toast(`${r.deleted} freie Termine gelöscht`);
  loadSlots();
  updateSeriesPreview();
}

function bookForCustomer(sl) {
  const name = h('input', { type: 'text', maxlength: 80, autocomplete: 'off', required: true });
  const phone = h('input', { type: 'tel', maxlength: 30, autocomplete: 'off' });
  const select = serviceSelect('b-service', null);
  const note = h('textarea', { maxlength: 500 });
  openDialog({
    title: `${fmtDateShort(sl.date)} · ${sl.time} Uhr`,
    sub: 'Dieser Termin ist frei. Du kannst jemanden eintragen (z. B. nach einem Anruf) oder den Termin löschen.',
    extra: [h('button', { class: 'btn btn-danger', type: 'button', text: 'Termin löschen', onclick: () => deleteSlot(sl) })],
    body: [field('Name', name), field('Telefon (freiwillig)', phone), field('Leistung', select), field('Notiz (freiwillig)', note)],
    submitLabel: 'Eintragen',
    onSubmit: async () => {
      await adminApi(`/api/admin/slots/${sl.id}/book`, {
        method: 'POST',
        body: {
          name: name.value,
          phone: phone.value,
          note: note.value,
          serviceId: select.value === '' ? null : Number(select.value),
        },
      });
      toast('Eingetragen');
      loadSlots();
    },
  });
}

// ---------- Erledigt ----------

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

async function loadDone() {
  if (!state.doneMonth) state.doneMonth = state.today.slice(0, 7);
  $('done-month').textContent = monthLabel(state.doneMonth);
  $('done-next').disabled = state.doneMonth >= state.today.slice(0, 7);
  document.querySelectorAll('#done-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === state.doneStatus)));

  const { appointments } = await adminApi(`/api/admin/appointments?month=${state.doneMonth}&status=done,no_show,cancelled`);
  const done = appointments.filter((a) => a.status === 'done');
  const revenue = done.reduce((t, a) => t + (a.price || 0), 0);
  const noShows = appointments.filter((a) => a.status === 'no_show').length;
  fill($('done-tiles'),
    tile('Haarschnitte', numberFormat.format(done.length)),
    tile('Umsatz', euro(revenue)),
    tile('Ø pro Termin', done.length ? euro(Math.round(revenue / done.length)) : '–'),
    tile('Nicht erschienen', numberFormat.format(noShows))
  );

  const list = appointments.filter((a) => a.status === state.doneStatus).reverse();
  if (list.length === 0) {
    const msg = {
      done: 'In diesem Monat ist noch nichts als erledigt markiert.',
      no_show: 'Niemand ist unentschuldigt weggeblieben.',
      cancelled: 'Keine Absagen in diesem Monat.',
    }[state.doneStatus];
    fill($('done-list'), h('div', { class: 'card empty', text: msg }));
    return;
  }
  const rows = list.map((a) =>
    h(
      'div',
      { class: 'list-row' },
      h(
        'div',
        null,
        h('div', { class: 'primary' }, a.customerName, ' ', a.source === 'walk_in' ? h('span', { class: 'pill', text: 'ohne Termin' }) : null),
        h('div', { class: 'secondary', text: [`${fmtDateShort(a.date)} ${a.time} Uhr`, a.serviceName].filter(Boolean).join(' · ') })
      ),
      h('div', { class: 'amount', text: a.status === 'done' ? euro(a.price) : '' }),
      h('button', { class: 'btn btn-sm', type: 'button', text: 'Ändern', 'aria-label': `${a.customerName} ändern`, onclick: () => editPastDialog(a) })
    )
  );
  const total =
    state.doneStatus === 'done'
      ? h('div', { class: 'list-total' }, h('span', { text: `${done.length} erledigt` }), h('span', { class: 'num', text: euro(revenue) }))
      : null;
  fill($('done-list'), h('div', { class: 'list' }, ...rows, total));
}

function tile(label, value, detail, hero = false) {
  return h(
    'div',
    { class: `tile${hero ? ' is-hero' : ''}` },
    h('div', { class: 'tl', text: label }),
    h('div', { class: 'tv', text: value }),
    detail ? h('div', { class: 'td', text: detail }) : null
  );
}

/** Bearbeiten eines vergangenen Eintrags (erledigt, nicht erschienen oder abgesagt). */
function editPastDialog(a) {
  const extra = [];
  if (a.source !== 'walk_in') {
    extra.push(h('button', { class: 'btn btn-sm', type: 'button', text: 'Zurück auf „gebucht“', onclick: () => reopen(a) }));
  }
  extra.push(h('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Eintrag löschen', onclick: () => deleteAppt(a) }));
  if (a.status === 'cancelled') {
    openDialog({
      title: 'Abgesagter Termin',
      sub: `${a.customerName} · ${fmtDateShort(a.date)} ${a.time} Uhr`,
      body: [h('p', { class: 'muted small', text: 'Dieser Termin wurde abgesagt und zählt nicht in der Statistik.' })],
      submitLabel: 'Schließen',
      onSubmit: async () => {},
      extra,
    });
    return;
  }
  completeDialog(a, extra);
}

async function reopen(a) {
  if (!confirm('Wieder auf „gebucht“ setzen? Er zählt dann nicht mehr in der Statistik.')) return;
  try {
    await adminApi(`/api/admin/appointments/${a.id}/reopen`, { method: 'POST' });
    $('dialog').close();
    toast('Zurückgesetzt – steht wieder unter „Termine“');
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteAppt(a) {
  if (!confirm(`Eintrag von ${a.customerName} endgültig löschen?`)) return;
  await adminApi(`/api/admin/appointments/${a.id}`, { method: 'DELETE' });
  $('dialog').close();
  toast('Gelöscht');
  refresh();
}

function walkInDialog() {
  const now = new Date();
  const date = h('input', { type: 'date', value: state.today, max: state.today, required: true });
  const time = h('input', {
    type: 'time',
    value: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes() - (now.getMinutes() % 5)).padStart(2, '0')}`,
    required: true,
  });
  const name = h('input', { type: 'text', maxlength: 80, placeholder: 'Laufkundschaft' });
  const select = serviceSelect('w-service', state.services.find((x) => x.active)?.id ?? null);
  const price = h('input', { type: 'text', inputmode: 'decimal', required: true, placeholder: 'z. B. 25' });
  const syncPrice = () => {
    const svc = state.services.find((x) => String(x.id) === select.value);
    if (svc) price.value = euroInput(svc.price);
  };
  select.addEventListener('change', syncPrice);
  syncPrice();
  openDialog({
    title: 'Eintrag hinzufügen',
    sub: 'Für Kunden ohne Online-Termin – zählt sofort in der Statistik.',
    body: [h('div', { class: 'row' }, field('Datum', date), field('Uhrzeit', time)), field('Name (freiwillig)', name), field('Leistung', select), field('Bezahlt (€)', price)],
    submitLabel: 'Hinzufügen',
    onSubmit: async () => {
      await adminApi('/api/admin/appointments', {
        method: 'POST',
        body: {
          date: date.value,
          time: time.value,
          name: name.value,
          serviceId: select.value === '' ? null : Number(select.value),
          price: price.value,
        },
      });
      toast('Hinzugefügt');
      state.doneMonth = date.value.slice(0, 7);
      state.doneStatus = 'done';
      refresh();
    },
  });
}

// ---------- Statistik ----------

async function loadStats() {
  if (!state.statsYear) state.statsYear = Number(state.today.slice(0, 4));
  const st = await adminApi(`/api/admin/stats?year=${state.statsYear}`);
  state.stats = st;
  const year = st.year;
  const currentYear = Number(st.today.slice(0, 4));
  const currentMonth = Number(st.today.slice(5, 7));
  $('stats-year').textContent = String(year);
  $('year-next').disabled = year >= currentYear;
  $('export-link').href = `/api/admin/export.csv?year=${year}`;
  $('export-link').setAttribute('download', `termine-${year}.csv`);

  $('stats-open').hidden = st.openToClose === 0;
  fill($('stats-open'),
    `${st.openToClose} ${st.openToClose === 1 ? 'vergangener Termin ist' : 'vergangene Termine sind'} noch nicht abgeschlossen und ${st.openToClose === 1 ? 'fehlt' : 'fehlen'} hier. `,
    h('a', { href: '#termine', text: 'Jetzt abschließen' })
  );

  const whole = (cents) => euroFormatRound.format(Math.round(cents / 100));
  const hero = tile(`Umsatz ${year}`, euro(st.total.revenue, true), `${numberFormat.format(st.total.count)} erledigte Termine`, true);
  const tiles = [];
  if (year === currentYear) {
    const m = st.months[currentMonth - 1];
    tiles.push(tile(`Im ${MONTHS[currentMonth - 1]}`, whole(m.revenue), `${numberFormat.format(m.count)} Termine`));
  } else {
    const best = st.months.reduce((b, m) => (m.revenue > b.revenue ? m : b), st.months[0]);
    tiles.push(tile('Bester Monat', best.revenue ? MONTHS[best.month - 1] : '–', best.revenue ? euro(best.revenue) : ''));
  }
  const activeMonths = year === currentYear ? currentMonth : 12;
  tiles.push(
    tile('Ø pro Termin', st.total.count ? euro(Math.round(st.total.revenue / st.total.count)) : '–'),
    tile('Ø pro Monat', whole(st.total.revenue / activeMonths), `${numberFormat.format(Math.round((st.total.count / activeMonths) * 10) / 10)} Termine`),
    tile('Nicht erschienen', numberFormat.format(st.noShows), `${numberFormat.format(st.cancelled)} abgesagt`)
  );
  fill($('stats-tiles'), hero, h('div', { class: 'tiles' }, ...tiles));

  renderChart();

  // Monatstabelle
  fill($('months-table'),
    h('thead', null, h('tr', null, h('th', { text: 'Monat' }), h('th', { class: 'r', text: 'Termine' }), h('th', { class: 'r', text: 'Umsatz' }))),
    h(
      'tbody',
      null,
      ...st.months.map((m) =>
        h(
          'tr',
          { class: year === currentYear && m.month === currentMonth ? 'is-current' : '' },
          h('td', { text: MONTHS[m.month - 1] }),
          h('td', { class: 'r', text: numberFormat.format(m.count) }),
          h('td', { class: 'r', text: euro(m.revenue) })
        )
      )
    ),
    h('tfoot', null, h('tr', null, h('td', { text: 'Gesamt' }), h('td', { class: 'r', text: numberFormat.format(st.total.count) }), h('td', { class: 'r', text: euro(st.total.revenue) })))
  );

  $('services-sub').textContent = `Was ${year} gemacht wurde`;
  fill($('services-table'),
    h('thead', null, h('tr', null, h('th', { text: 'Leistung' }), h('th', { class: 'r', text: 'Anzahl' }), h('th', { class: 'r', text: 'Umsatz' }))),
    h(
      'tbody',
      null,
      ...(st.byService.length
        ? st.byService.map((x) =>
            h('tr', null, h('td', { text: x.name }), h('td', { class: 'r', text: numberFormat.format(x.count) }), h('td', { class: 'r', text: euro(x.revenue) }))
          )
        : [h('tr', null, h('td', { colspan: 3, class: 'muted', text: 'Noch keine Daten' }))])
    )
  );

  fill($('years-table'),
    h('thead', null, h('tr', null, h('th', { text: 'Jahr' }), h('th', { class: 'r', text: 'Termine' }), h('th', { class: 'r', text: 'Umsatz' }))),
    h(
      'tbody',
      null,
      ...(st.years.length
        ? st.years.map((y) =>
            h(
              'tr',
              { class: y.year === year ? 'is-current' : '' },
              h('td', { text: String(y.year) }),
              h('td', { class: 'r', text: numberFormat.format(y.count) }),
              h('td', { class: 'r', text: euro(y.revenue) })
            )
          )
        : [h('tr', null, h('td', { colspan: 3, class: 'muted', text: 'Noch keine Daten' }))])
    )
  );
}

function niceStep(max, targetTicks = 4) {
  const raw = max / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function renderChart() {
  const st = state.stats;
  if (!st) return;
  const mode = state.chartMode;
  document.querySelectorAll('#chart-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('chart-title').textContent = mode === 'revenue' ? 'Umsatz pro Monat' : 'Erledigte Termine pro Monat';
  $('chart-sub').textContent = String(st.year);

  const el = $('chart');
  const width = Math.max(280, el.clientWidth || 600);
  const height = 240;
  const value = (m) => (mode === 'revenue' ? m.revenue / 100 : m.count);
  const fmt = (v) => (mode === 'revenue' ? euroFormatRound.format(v) : numberFormat.format(v));
  const values = st.months.map(value);
  const max = Math.max(...values);
  const step = max > 0 ? niceStep(max) : mode === 'revenue' ? 250 : 5;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);

  const margin = { top: 22, right: 4, bottom: 26, left: mode === 'revenue' ? 62 : 34 };
  const iw = width - margin.left - margin.right;
  const ih = height - margin.top - margin.bottom;
  const band = iw / 12;
  const barW = Math.min(24, band * 0.62);
  const y = (v) => margin.top + ih - (v / top) * ih;
  const narrow = band < 34;

  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': `${$('chart-title').textContent} ${st.year}` });
  const grid = s('g', { class: 'grid' });
  const axis = s('g', { class: 'axis' });
  for (const t of ticks) {
    const ty = Math.round(y(t)) + 0.5;
    grid.append(s('line', { x1: margin.left, x2: width - margin.right, y1: ty, y2: ty }));
    axis.append(s('text', { x: margin.left - 8, y: ty + 4, 'text-anchor': 'end', text: fmt(t) }));
  }
  st.months.forEach((m, i) => {
    const cx = margin.left + band * i + band / 2;
    axis.append(s('text', { x: cx, y: height - 6, 'text-anchor': 'middle', text: narrow ? MONTHS[i][0] : MONTHS_SHORT[i] }));
  });
  svg.append(grid, axis);

  const bars = s('g');
  const hits = s('g');
  const maxIndex = max > 0 ? values.indexOf(max) : -1;
  const tip = h('div', { class: 'chart-tip', hidden: true });
  st.months.forEach((m, i) => {
    const v = values[i];
    const cx = margin.left + band * i + band / 2;
    const x0 = cx - barW / 2;
    const yTop = y(v);
    const base = margin.top + ih;
    const hgt = base - yTop;
    if (v > 0) {
      const r = Math.min(4, hgt, barW / 2);
      bars.append(
        s('path', {
          class: 'bar',
          d: `M${x0},${base} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${base} Z`,
        })
      );
    }
    if (i === maxIndex) {
      bars.append(s('text', { class: 'cap', x: cx, y: yTop - 6, 'text-anchor': 'middle', text: fmt(v) }));
    }
    const label = `${MONTHS[i]}: ${numberFormat.format(m.count)} ${m.count === 1 ? 'Termin' : 'Termine'}, ${euro(m.revenue)}`;
    const showTip = () => {
      fill(tip, h('strong', { text: `${MONTHS[i]} ${st.year}` }), `${numberFormat.format(m.count)} ${m.count === 1 ? 'Termin' : 'Termine'} · ${euro(m.revenue)}`);
      tip.hidden = false;
      const scale = el.clientWidth / width || 1;
      tip.style.left = `${Math.min(Math.max(cx * scale, 70), el.clientWidth - 70)}px`;
      tip.style.top = `${Math.min(yTop, base - 4) * scale}px`;
    };
    hits.append(
      s('rect', {
        class: 'hit',
        x: margin.left + band * i,
        y: margin.top,
        width: band,
        height: ih,
        rx: 6,
        tabindex: 0,
        'aria-label': label,
        onmouseenter: showTip,
        onfocus: showTip,
        onmouseleave: () => {
          tip.hidden = true;
        },
        onblur: () => {
          tip.hidden = true;
        },
      })
    );
  });
  svg.append(hits, bars);
  bars.setAttribute('pointer-events', 'none');
  fill(el, svg, tip);
}

// ---------- Einstellungen ----------

async function loadServices() {
  const { services } = await adminApi('/api/admin/services');
  state.services = services;
}

async function loadSettings() {
  const [settings] = await Promise.all([adminApi('/api/admin/settings'), loadServices()]);
  $('st-name').value = settings.salonName || '';
  $('st-info').value = settings.infoText || '';
  $('st-legal').value = settings.legalText || '';
  $('st-lead').value = settings.bookingLeadMinutes;
  $('st-ahead').value = settings.bookingDaysAhead;
  $('st-cancel').value = settings.cancelUntilHours;
  $('brand-name').textContent = settings.salonName;
  renderServicesAdmin();
}

function renderServicesAdmin() {
  if (state.services.length === 0) {
    fill($('services-admin'), h('p', { class: 'muted small', text: 'Noch keine Leistungen. Ohne Leistungen wählen Kunden nur einen Termin.' }));
    return;
  }
  fill($('services-admin'),
    ...state.services.map((svc) => {
      const name = h('input', { type: 'text', value: svc.name, maxlength: 60, 'aria-label': 'Name' });
      const price = h('input', { type: 'text', value: euroInput(svc.price), inputmode: 'decimal', 'aria-label': 'Preis in Euro' });
      const save = async (patch = {}) => {
        try {
          await adminApi(`/api/admin/services/${svc.id}`, { method: 'PUT', body: { name: name.value, price: price.value, active: svc.active, ...patch } });
          toast('Gespeichert');
          await loadServices();
          renderServicesAdmin();
        } catch (err) {
          toast(err.message);
        }
      };
      name.addEventListener('change', () => save());
      price.addEventListener('change', () => save());
      return h(
        'div',
        { class: `service-row${svc.active ? '' : ' is-inactive'}` },
        name,
        price,
        h(
          'div',
          { class: 'ctrl' },
          h('button', {
            class: 'btn btn-sm',
            type: 'button',
            text: svc.active ? 'Ausblenden' : 'Einblenden',
            title: svc.active ? 'Kunden sehen diese Leistung nicht mehr' : 'Kunden sehen diese Leistung wieder',
            onclick: () => save({ active: !svc.active }),
          }),
          h('button', {
            class: 'btn btn-sm btn-danger',
            type: 'button',
            'aria-label': `${svc.name} löschen`,
            title: 'Löschen',
            onclick: async () => {
              if (!confirm(`„${svc.name}“ löschen? Bisherige Termine behalten den Namen.`)) return;
              await adminApi(`/api/admin/services/${svc.id}`, { method: 'DELETE' });
              await loadServices();
              renderServicesAdmin();
            },
          }, icon('x'))
        )
      );
    })
  );
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await adminApi('/api/admin/settings', {
      method: 'PUT',
      body: {
        salonName: $('st-name').value,
        infoText: $('st-info').value,
        legalText: $('st-legal').value,
        bookingLeadMinutes: Number($('st-lead').value),
        bookingDaysAhead: Number($('st-ahead').value),
        cancelUntilHours: Number($('st-cancel').value),
      },
    });
    $('brand-name').textContent = $('st-name').value;
    toast('Gespeichert');
  } catch (err) {
    toast(err.message);
  }
}

async function addService(event) {
  event.preventDefault();
  try {
    await adminApi('/api/admin/services', { method: 'POST', body: { name: $('sv-name').value, price: $('sv-price').value } });
    $('sv-name').value = '';
    $('sv-price').value = '';
    await loadServices();
    renderServicesAdmin();
    toast('Leistung hinzugefügt');
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Start ----------

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  document.querySelectorAll('.tab').forEach((el) => el.addEventListener('click', () => showTab(el.dataset.tab)));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  $('logout').addEventListener('click', logout);

  setupSeriesForm();
  setIcon('slots-prev', 'left');
  setIcon('slots-next', 'right');
  $('slots-prev').addEventListener('click', () => {
    state.slotsFrom = addDaysIso(state.slotsFrom, -SLOT_RANGE_DAYS);
    loadSlots();
  });
  $('slots-next').addEventListener('click', () => {
    state.slotsFrom = addDaysIso(state.slotsFrom, SLOT_RANGE_DAYS);
    loadSlots();
  });

  setIcon('done-prev', 'left');
  setIcon('done-next', 'right');
  $('done-prev').addEventListener('click', () => {
    state.doneMonth = shiftMonth(state.doneMonth, -1);
    loadDone();
  });
  $('done-next').addEventListener('click', () => {
    state.doneMonth = shiftMonth(state.doneMonth, 1);
    loadDone();
  });
  $('done-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.doneStatus = b.dataset.status;
    loadDone();
  });
  $('add-walkin').addEventListener('click', walkInDialog);

  setIcon('year-prev', 'left');
  setIcon('year-next', 'right');
  $('year-prev').addEventListener('click', () => {
    state.statsYear -= 1;
    loadStats();
  });
  $('year-next').addEventListener('click', () => {
    state.statsYear += 1;
    loadStats();
  });
  $('chart-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.chartMode = b.dataset.mode;
    renderChart();
  });
  window.addEventListener('resize', debounce(() => state.tab === 'statistik' && renderChart(), 150));

  $('settings-form').addEventListener('submit', saveSettings);
  $('service-add').addEventListener('submit', addService);
}

async function start() {
  let me;
  try {
    me = await api('/api/admin/me');
  } catch (err) {
    if (err.status === 401) return showLogin();
    toast(err.message);
    return;
  }
  state.now = me.now;
  state.today = me.today;
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  const [info] = await Promise.all([api('/api/info'), loadServices()]);
  $('brand-name').textContent = info.salonName;
  document.title = `Mein Bereich – ${info.salonName}`;
  wireOnce();
  showTab(location.hash.slice(1) || 'termine');
  // Badge auch außerhalb des Termine-Tabs aktuell halten
  if (state.tab !== 'termine') {
    adminApi('/api/admin/appointments?status=booked')
      .then(({ now, appointments }) => updateBadge(appointments.filter((a) => `${a.date} ${a.time}` <= now).length))
      .catch(() => {});
  }
}

$('login-form').addEventListener('submit', login);
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.status !== 401) toast(e.reason.message || 'Fehler');
});
start();
