/* Rallenta Phase 1 MVP — UI shell.
 * Load order: data.js, logic.js, charts.js, player.js, app.js
 * Uses: RallentaDB.*, RallentaLogic.*, RallentaCharts.*, RallentaPlayer
 */
'use strict';

/* ---------- constants ---------- */
const VISIBLE_DAYS = 14; // free tier: lists on Today/Trends show the most recent 14 days
const GA4_ID = 'G-DJXTN8EDT4';
const DISCLAIMER = 'Rallenta is a wellness journal, not a medical device. It does not measure vital signs, diagnose conditions, or provide medical advice.';
const PLAUS_COPY = 'That value is outside the range usually accepted by this field. Check the number and unit, or save it as entered.';
const DEBT_LABEL = 'Sleep-target gap estimate — against your chosen target, not a physiological measurement.';
const MANUAL_LABEL = 'Manual entry — not measured by this phone.';
const CHART_BLUE = '#5b9dff';
const CHART_VIOLET = '#a78bfa';

const SLEEP_TAGS = ['Late caffeine', 'Alcohol', 'Exercise', 'Screens before bed', 'Stress', 'Travel', 'Nap', 'Shift work', 'Warm room', 'Noise'];

const VITAL_ORDER = ['blood_pressure', 'heart_rate', 'blood_sugar', 'weight', 'bmi'];
const VITAL_LABELS = {
  blood_pressure: 'Blood pressure',
  heart_rate: 'Heart rate',
  blood_sugar: 'Blood sugar',
  weight: 'Weight',
  bmi: 'BMI'
};
const METRIC_LABEL = { sleep: 'Sleep' };
Object.assign(METRIC_LABEL, VITAL_LABELS);

/* ---------- tiny helpers ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function pad2(n) { return String(n).padStart(2, '0'); }

// ISO 8601 with local offset, e.g. 2026-09-27T22:15:00-05:00
function localISO(d) {
  d = d instanceof Date ? d : new Date(d);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
}
function localDateStr(d) { return localISO(d || new Date()).slice(0, 10); }

function parseLocalISO(s) {
  // Handles "YYYY-MM-DDTHH:MM:SS±HH:MM" and plain local datetime strings.
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date(s);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}
function fmtDur(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h + 'h ' + pad2(m) + 'm';
}
function fmtTime(iso, timeFormat) {
  const d = parseLocalISO(iso);
  if (timeFormat === '24h') return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  let h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + pad2(d.getMinutes()) + ' ' + ap;
}
function fmtDate(iso) {
  const d = parseLocalISO(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(iso, timeFormat) { return fmtDate(iso) + ', ' + fmtTime(iso, timeFormat); }
function dtInputVal(iso) {
  const d = parseLocalISO(iso);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function parseDtInput(v) {
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
}
function entryWhen(e) { return e.measured_at || e.wake_at || e.bed_at || ''; }
function cmpNewest(a, b) { return entryWhen(b).localeCompare(entryWhen(a)); }

/* ---------- analytics (GA4: page_view + app_launch only; no health data) ---------- */
function gaPageView(route) {
  try {
    if (typeof gtag === 'function') gtag('event', 'page_view', { page_path: '#/' + route });
  } catch (e) {}
}
function gaAppLaunch() {
  try {
    if (typeof gtag === 'function') gtag('event', 'app_launch');
  } catch (e) {}
}

/* ---------- toast (with optional 8s undo) ---------- */
let toastTimer = null;
function toast(msg, opts) {
  opts = opts || {};
  const root = $('#toast-root');
  root.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => { opts.onAction(); root.innerHTML = ''; });
    el.appendChild(btn);
  }
  root.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, 8000);
}

/* ---------- modal ---------- */
function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const box = document.createElement('div');
  box.className = 'modal';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = html;
  scrim.appendChild(box);
  root.appendChild(scrim);
  const firstBtn = box.querySelector('button');
  if (firstBtn) firstBtn.focus();
  return { root, box, close() { root.innerHTML = ''; } };
}

/* ---------- prefs ---------- */
let prefs = null;
async function savePrefs(patch) {
  prefs = await RallentaDB.setPrefs(Object.assign({}, prefs || {}, patch));
  return prefs;
}
function timeFormat() { return (prefs && prefs.timeFormat) || '12h'; }
function sleepTargetMin() { return (prefs && prefs.sleepTargetMin) || 480; }
function weightUnit() { return (prefs && prefs.weightUnit) || 'lb'; }
function glucoseUnit() { return (prefs && prefs.glucoseUnit) || 'mg/dL'; }
async function touchLastUsed(key) {
  const lu = Object.assign({}, prefs.lastUsed || {});
  lu[key] = localISO(new Date());
  await savePrefs({ lastUsed: lu });
}

/* ---------- state ---------- */
let player = null;
let editingId = null;      // entry id being edited (null = new)
let pendingSleep = null;   // sleep form data awaiting review
let pendingVital = null;   // vital form data awaiting review
let trendRange = 7;
let trendMetric = 'sleep_duration';

/* ---------- router ---------- */
function currentRoute() {
  const h = location.hash || '';
  return h.replace(/^#\/?/, '');
}
function navigate(route) {
  if (('#/' + route) === location.hash) { render(); return; }
  location.hash = '#/' + route;
}
function markTab(tab) {
  $$('#tabbar a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
function onboardingNeeded() {
  return !prefs || !prefs.disclaimerAcceptedAt || !prefs.onboardingDone;
}

async function render() {
  const raw = currentRoute();
  const parts = raw.split('/').filter(Boolean);
  const name = parts[0] || 'today';
  const app = $('#app');

  if (onboardingNeeded() && name !== 'welcome' && name !== 'setup') {
    navigate('welcome');
    return;
  }
  if (!onboardingNeeded() && (name === 'welcome' || name === 'setup')) {
    navigate('today');
    return;
  }

  gaPageView(raw || 'today');
  app.innerHTML = '<p class="muted">Loading…</p>';
  markTab(name === 'log' || name === 'audio' || name === 'trends' || name === 'settings' ? name : (name === 'today' ? 'today' : ''));

  try {
    if (name === 'welcome') { renderWelcome(app); return; }
    if (name === 'setup') { renderSetup(app); return; }
    if (name === 'today') { await renderToday(app); return; }
    if (name === 'log') {
      if (parts[1] === 'sleep') { renderSleepForm(app); return; }
      if (parts[1] === 'vital' && VITAL_ORDER.includes(parts[2])) { renderVitalForm(app, parts[2]); return; }
      if (parts[1] === 'vital') { app.innerHTML = unknownVitalHtml(); return; }
      renderLogChooser(app); return;
    }
    if (name === 'trends') { await renderTrends(app); return; }
    if (name === 'audio') { await renderAudio(app); return; }
    if (name === 'settings') { await renderSettings(app); return; }
    if (name === 'about') { renderAbout(app); return; }
    app.innerHTML = '<h1>Not found</h1><p class="muted">That screen does not exist.</p><p><a class="btn" href="#/today">Back to Today</a></p>';
  } catch (e) {
    app.innerHTML = '<h1>Something went wrong</h1><p class="muted">Your saved entries are untouched. ' + esc(e.message || e) + '</p><p><a class="btn" href="#/today">Back to Today</a></p>';
  }
  window.scrollTo(0, 0);
}
function unknownVitalHtml() {
  return '<h1>Unknown reading</h1><p class="muted">Choose a reading type below.</p><p><a class="btn" href="#/log">Back to Log</a></p>';
}

/* ---------- #/welcome ---------- */
function renderWelcome(app) {
  app.innerHTML =
    '<h1>Rallenta</h1>' +
    '<p class="tagline" style="font-size:1.1rem;color:var(--accent-2)">Your rest. Your readings. Your device.</p>' +
    '<div class="card"><h2 style="margin-top:0">The promise</h2>' +
    '<p>Log your sleep and everyday body readings, notice your own patterns, and build a calmer wind-down routine — privately, on this device.</p></div>' +
    '<div class="card"><h2 style="margin-top:0">Local-first</h2>' +
    '<p>Everything you enter is saved <strong>on this device only</strong>. No account, no cloud sync, no ads. Export or delete your data any time from Settings.</p></div>' +
    '<div class="disclaimer" role="note">' + esc(DISCLAIMER) + '</div>' +
    '<div class="check-line">' +
    '<input type="checkbox" id="accept" aria-describedby="accept-desc">' +
    '<label for="accept" style="margin:0;font-weight:600" id="accept-desc">I understand Rallenta is a wellness journal, not a medical device. Record my acceptance with today\'s date.</label>' +
    '</div>' +
    '<p><button class="btn-primary" id="accept-btn" disabled>Accept &amp; continue</button></p>';
  const cb = $('#accept'), btn = $('#accept-btn');
  cb.addEventListener('change', () => { btn.disabled = !cb.checked; });
  btn.addEventListener('click', async () => {
    await savePrefs({ disclaimerAcceptedAt: localISO(new Date()) });
    navigate('setup');
  });
}

/* ---------- #/setup ---------- */
function renderSetup(app) {
  const cards = ['sleep'].concat(VITAL_ORDER);
  const sel = (prefs.loggingCards) || {};
  const isOn = (k) => (k in sel) ? !!sel[k] : true;
  app.innerHTML =
    '<h1>Set up Rallenta</h1>' +
    '<p class="muted">You can change all of this later in Settings.</p>' +
    '<div class="card"><h2 style="margin-top:0">Time format</h2>' +
    '<div class="radio-row" role="radiogroup" aria-label="Time format">' +
    radioPill('tf', '12h', '12-hour', timeFormat() === '12h') +
    radioPill('tf', '24h', '24-hour', timeFormat() === '24h') +
    '</div></div>' +
    '<div class="card"><h2 style="margin-top:0">Units</h2>' +
    '<label id="wu-l">Weight unit</label>' +
    '<div class="radio-row" role="radiogroup" aria-labelledby="wu-l">' +
    radioPill('wu', 'lb', 'Pounds (lb)', weightUnit() === 'lb') +
    radioPill('wu', 'kg', 'Kilograms (kg)', weightUnit() === 'kg') +
    '</div>' +
    '<label id="gu-l">Blood sugar unit</label>' +
    '<div class="radio-row" role="radiogroup" aria-labelledby="gu-l">' +
    radioPill('gu', 'mg/dL', 'mg/dL', glucoseUnit() === 'mg/dL') +
    radioPill('gu', 'mmol/L', 'mmol/L', glucoseUnit() === 'mmol/L') +
    '</div>' +
    '<label for="height">Height (optional, used for BMI)</label>' +
    '<input type="number" id="height" inputmode="decimal" min="50" max="250" step="1" placeholder="e.g. 178" value="' + esc(prefs.heightCm || '') + '" aria-label="Height in centimeters, optional">' +
    '<p class="hint">Centimeters. Leave blank if you prefer to enter BMI directly.</p></div>' +
    '<div class="card"><h2 style="margin-top:0">Sleep target</h2>' +
    '<label for="target">Nightly sleep target: <strong id="target-out">' + esc(fmtDur(sleepTargetMin())) + '</strong></label>' +
    '<input type="range" id="target" min="300" max="600" step="30" value="' + sleepTargetMin() + '" aria-label="Sleep target in minutes">' +
    '<p class="hint">Used only to show a gap estimate on Today and Trends.</p></div>' +
    '<div class="card"><h2 style="margin-top:0">Logging cards</h2>' +
    '<p class="hint">Choose which cards appear on the Log screen and the Today quick-log grid.</p>' +
    cards.map((k) => '<div class="check-line"><input type="checkbox" id="card-' + k + '" data-card="' + k + '"' + (isOn(k) ? ' checked' : '') + '><label for="card-' + k + '" style="margin:0">' + esc(METRIC_LABEL[k]) + '</label></div>').join('') +
    '</div>' +
    '<p><button class="btn-primary" id="setup-done">Continue</button></p>';
  const slider = $('#target');
  slider.addEventListener('input', () => { $('#target-out').textContent = fmtDur(+slider.value); });
  $('#setup-done').addEventListener('click', async () => {
    const tf = ($('input[name=tf]:checked') || {}).value || '12h';
    const wu = ($('input[name=wu]:checked') || {}).value || 'lb';
    const gu = ($('input[name=gu]:checked') || {}).value || 'mg/dL';
    const hRaw = $('#height').value.trim();
    const loggingCards = {};
    $$('[data-card]').forEach((c) => { loggingCards[c.dataset.card] = c.checked; });
    await savePrefs({
      timeFormat: tf, weightUnit: wu, glucoseUnit: gu,
      heightCm: hRaw === '' ? null : Math.max(50, Math.min(250, +hRaw || 0)),
      sleepTargetMin: +slider.value,
      loggingCards: loggingCards,
      onboardingDone: true
    });
    navigate('today');
  });
}
function radioPill(name, value, label, checked) {
  return '<label class="radio-pill"><input type="radio" name="' + name + '" value="' + esc(value) + '"' + (checked ? ' checked' : '') + '>' + esc(label) + '</label>';
}

/* ---------- #/today ---------- */
function enabledCards() {
  const sel = prefs.loggingCards || {};
  const all = ['sleep'].concat(VITAL_ORDER);
  return all.filter((k) => (k in sel) ? sel[k] : true);
}

async function renderToday(app) {
  const since = localISO(new Date(Date.now() - VISIBLE_DAYS * 864e5));
  const sleepList = await RallentaDB.listEntries({ kind: 'sleep', since: since, limit: 60 });
  const vitalList = await RallentaDB.listEntries({ kind: 'vital', since: since, limit: 60 });
  const all = sleepList.concat(vitalList).sort(cmpNewest);
  const lastSleep = sleepList[0] || null;

  let sleepCard;
  if (!lastSleep) {
    sleepCard = '<div class="empty"><p><strong>No sleep entries yet.</strong></p><p>Your last night will appear here once you log it — under 30 seconds.</p><p><a class="btn btn-primary" href="#/log/sleep">Log last night\'s sleep</a></p></div>';
  } else {
    const d = RallentaLogic.deriveSleep(lastSleep);
    const gap = RallentaLogic.targetGap(d.asleepMin, sleepTargetMin());
    const gapLine = gap > 0
      ? '<p class="small">' + esc(fmtDur(gap)) + ' under your ' + esc(fmtDur(sleepTargetMin())) + ' target.<br>' + esc(DEBT_LABEL) + '</p>'
      : '<p class="small">Met your ' + esc(fmtDur(sleepTargetMin())) + ' target.<br>' + esc(DEBT_LABEL) + '</p>';
    sleepCard = '<div class="card accent"><div class="spread"><h2 style="margin:0">Last sleep</h2><span class="muted small">' +
      esc(fmtDateTime(lastSleep.wake_at, timeFormat())) + '</span></div>' +
      '<p style="font-size:1.5rem;font-weight:700;margin:.4em 0">' + esc(fmtDur(d.asleepMin)) + '</p>' +
      '<p class="small muted" style="margin-top:0">' + esc(fmtDur(d.inBedMin)) + ' in bed · fell asleep in ~' + esc(String(lastSleep.latency_minutes || 0)) + ' min · awake ~' + esc(String(lastSleep.awake_minutes || 0)) + ' min · quality ' + esc(String(lastSleep.quality)) + '/5</p>' +
      gapLine +
      '<p class="row"><a class="btn" href="#/trends">See trends</a><a class="btn" href="#/log/sleep">Log another night</a></p></div>';
  }

  const recent = all.slice(0, 7);
  const recentHtml = recent.length === 0
    ? '<div class="empty"><p><strong>Nothing logged yet.</strong></p><p>Start with one reading — it takes under 30 seconds.</p><p><a class="btn btn-primary" href="#/log">Log a reading</a></p></div>'
    : '<ul class="entry-list">' + recent.map(entryRow).join('') + '</ul>' +
      '<p class="hint">Showing entries from the last ' + VISIBLE_DAYS + ' days. Older entries stay on this device and can be exported any time.</p>';

  const quick = enabledCards().map((k) => {
    const href = k === 'sleep' ? '#/log/sleep' : '#/log/vital/' + k;
    return '<a class="tile" href="' + href + '"><span class="t-label">' + esc(METRIC_LABEL[k]) + '</span><span class="t-sub">Enter a reading</span></a>';
  }).join('');

  app.innerHTML =
    '<h1>Today</h1>' +
    sleepCard +
    '<h2>Quick log</h2>' +
    '<div class="grid tiles">' + quick + '</div>' +
    '<h2>Recent entries</h2>' +
    '<div class="card">' + recentHtml + '</div>' +
    '<div class="card"><div class="spread"><div><h2 style="margin:0 0 .25em">Wind down</h2><p class="muted small" style="margin:0">Original stereo tracks for your evening routine.</p></div><a class="btn" href="#/audio">Open audio</a></div></div>' +
    '<p class="muted small" style="text-align:center">🔒 Saved on this device — no account, no cloud.</p>';

  bindEntryActions(app);
}

function entryRow(e) {
  const label = e.kind === 'sleep' ? 'Sleep' : (VITAL_LABELS[e.metric_type] || e.metric_type || 'Reading');
  const sub = e.kind === 'sleep' ? describeSleep(e) : describeVital(e);
  const when = fmtDateTime(entryWhen(e), timeFormat());
  return '<li><div class="e-main"><div class="e-title">' + esc(label) + ' — ' + esc(sub) + '</div>' +
    '<div class="e-sub">' + esc(when) + '</div></div>' +
    '<div class="row" style="flex-wrap:nowrap">' +
    '<button class="icon-btn" data-edit="' + esc(e.id) + '" aria-label="Edit ' + esc(label) + ' from ' + esc(when) + '">Edit</button>' +
    '<button class="icon-btn" data-del="' + esc(e.id) + '" aria-label="Delete ' + esc(label) + ' from ' + esc(when) + '">Delete</button>' +
    '</div></li>';
}
function describeSleep(e) {
  try { return fmtDur(RallentaLogic.deriveSleep(e).asleepMin) + ' asleep'; }
  catch (err) { return 'sleep entry'; }
}
function describeVital(e) {
  const u = e.unit || '';
  if (e.metric_type === 'blood_pressure') return e.value_primary + '/' + e.value_secondary + ' ' + u;
  if (e.metric_type === 'bmi') return Number(e.value_primary).toFixed(1) + ' ' + u;
  return e.value_primary + ' ' + u;
}

function bindEntryActions(root) {
  $$('[data-edit]', root).forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.edit;
    const entry = await findEntry(id);
    if (!entry) { toast('Entry not found.'); return; }
    editingId = id;
    if (entry.kind === 'sleep') navigate('log/sleep'); else navigate('log/vital/' + entry.metric_type);
  }));
  $$('[data-del]', root).forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.del;
    const entry = await findEntry(id);
    if (!entry) { toast('Entry not found.'); return; }
    const m = modal('<h2>Delete entry?</h2><p>' + esc(describeEntry(entry)) + '</p>' +
      '<p class="row"><button class="btn-danger" id="m-yes">Delete</button><button id="m-no">Keep</button></p>');
    $('#m-no', m.box).addEventListener('click', m.close);
    $('#m-yes', m.box).addEventListener('click', async () => {
      m.close();
      const snapshot = JSON.parse(JSON.stringify(entry));
      await RallentaDB.deleteEntry(id);
      toast('Deleted.', { actionLabel: 'Undo', onAction: async () => { await restoreEntry(snapshot); render(); } });
      render();
    });
  }));
}
function describeEntry(e) {
  return (e.kind === 'sleep' ? 'Sleep' : (VITAL_LABELS[e.metric_type] || 'Reading')) + ' — ' +
    (e.kind === 'sleep' ? describeSleep(e) : describeVital(e)) + ' · ' + fmtDateTime(entryWhen(e), timeFormat());
}
async function findEntry(id) {
  const sleep = await RallentaDB.listEntries({ kind: 'sleep', limit: 5000 });
  const vitals = await RallentaDB.listEntries({ kind: 'vital', limit: 5000 });
  return sleep.concat(vitals).find((e) => e.id === id) || null;
}
async function restoreEntry(snapshot) {
  if (snapshot.kind === 'sleep') {
    await RallentaDB.saveSleep({
      bed_at: snapshot.bed_at, wake_at: snapshot.wake_at,
      latency_minutes: snapshot.latency_minutes, awake_minutes: snapshot.awake_minutes,
      quality: snapshot.quality, tags: snapshot.tags, note: snapshot.note
    });
  } else {
    await RallentaDB.saveVital({
      metric_type: snapshot.metric_type, value_primary: snapshot.value_primary,
      value_secondary: snapshot.value_secondary, unit: snapshot.unit,
      measured_at: snapshot.measured_at, context: snapshot.context, note: snapshot.note
    });
  }
}

/* ---------- #/log chooser ---------- */
function renderLogChooser(app) {
  const cards = enabledCards();
  const lu = (prefs.lastUsed) || {};
  cards.sort((a, b) => (lu[b] || '').localeCompare(lu[a] || ''));
  const tiles = cards.map((k) => {
    const href = k === 'sleep' ? '#/log/sleep' : '#/log/vital/' + k;
    return '<a class="tile" href="' + href + '"><span class="t-label">' + esc(METRIC_LABEL[k]) + '</span><span class="t-sub">Enter a reading</span></a>';
  }).join('');
  app.innerHTML = '<h1>Log</h1>' +
    '<p class="muted">What would you like to record? Most used first.</p>' +
    '<div class="grid tiles">' + tiles + '</div>' +
    '<p class="hint">Rallenta stores what you enter — it never measures anything through this phone.</p>';
}

/* ---------- #/log/sleep ---------- */
async function renderSleepForm(app) {
  let e = null;
  if (editingId) { e = await findEntry(editingId); if (!e || e.kind !== 'sleep') editingId = null; }
  if (pendingSleep && !editingId) { return renderSleepReview(app, pendingSleep); }

  const now = new Date();
  const bedD = e ? new Date(parseLocalISO(e.bed_at)) : new Date(now.getTime() - 8 * 36e5);
  const wakeD = e ? new Date(parseLocalISO(e.wake_at)) : new Date(now.getTime());
  const dISO = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const tISO = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes());

  const tags = e && e.tags ? e.tags : [];
  const tagsHtml = SLEEP_TAGS.map((t) =>
    '<button type="button" class="chip" data-tag="' + esc(t) + '" aria-pressed="' + (tags.includes(t) ? 'true' : 'false') + '">' + esc(t) + '</button>').join('');

  app.innerHTML =
    '<h1>' + (e ? 'Edit sleep' : 'Log sleep') + '</h1>' +
    '<div class="manual-banner">' + esc(MANUAL_LABEL) + '</div>' +
    '<div class="card"><h2 style="margin-top:0">When</h2>' +
    '<div class="grid" style="grid-template-columns:1fr 1fr">' +
    '<div><label for="bed-d">Bed date</label><input type="date" id="bed-d" value="' + dISO(bedD) + '"></div>' +
    '<div><label for="bed-t">Bed time</label><input type="time" id="bed-t" value="' + tISO(bedD) + '"></div>' +
    '<div><label for="wake-d">Wake date</label><input type="date" id="wake-d" value="' + dISO(wakeD) + '"></div>' +
    '<div><label for="wake-t">Wake time</label><input type="time" id="wake-t" value="' + tISO(wakeD) + '"></div>' +
    '</div>' +
    '<p class="hint">Wake date is after midnight for most nights — the form handles crossing midnight.</p></div>' +
    '<div class="card"><h2 style="margin-top:0">Details</h2>' +
    '<label for="latency">Minutes to fall asleep (optional)</label>' +
    '<input type="number" id="latency" inputmode="numeric" min="0" max="600" step="1" value="' + esc(e && e.latency_minutes != null ? e.latency_minutes : '') + '" aria-label="Minutes to fall asleep">' +
    '<label for="awake">Minutes awake during the night (optional)</label>' +
    '<input type="number" id="awake" inputmode="numeric" min="0" max="600" step="1" value="' + esc(e && e.awake_minutes != null ? e.awake_minutes : '') + '" aria-label="Minutes awake during the night">' +
    '<label id="q-l">Sleep quality (1–5)</label>' +
    '<div class="seg" role="radiogroup" aria-labelledby="q-l" id="quality-seg">' +
    [1, 2, 3, 4, 5].map((q) => '<button type="button" data-q="' + q + '" role="radio" aria-checked="' + ((e && e.quality === q) ? 'true' : 'false') + '" aria-pressed="' + ((e && e.quality === q) ? 'true' : 'false') + '" aria-label="Quality ' + q + ' of 5">' + q + '</button>').join('') +
    '</div></div>' +
    '<div class="card"><h2 style="margin-top:0">Tags <span class="muted small">(optional)</span></h2>' +
    '<div class="chips">' + tagsHtml + '</div></div>' +
    '<div class="card"><label for="note">Note <span class="muted small">(optional)</span></label>' +
    '<textarea id="note" maxlength="500" placeholder="Anything worth remembering about this night.">' + esc(e && e.note ? e.note : '') + '</textarea></div>' +
    '<p class="row"><button class="btn-primary" id="sleep-next">Review</button><a class="btn btn-ghost" href="#/log">Cancel</a></p>';

  let quality = e ? e.quality : 3;
  $$('#quality-seg button', app).forEach((b) => {
    if (+b.dataset.q === quality && !e) { /* default highlight below */ }
    b.addEventListener('click', () => {
      quality = +b.dataset.q;
      $$('#quality-seg button', app).forEach((x) => {
        const on = +x.dataset.q === quality;
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
        x.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    });
  });
  if (!e) { const d3 = $('[data-q="3"]', app); if (d3) d3.setAttribute('aria-pressed', 'true'); if (d3) d3.setAttribute('aria-checked', 'true'); }
  $$('[data-tag]', app).forEach((c) => c.addEventListener('click', () => {
    c.setAttribute('aria-pressed', c.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  }));

  $('#sleep-next').addEventListener('click', () => {
    const bed = parseDtInput($('#bed-d').value + 'T' + $('#bed-t').value);
    const wake = parseDtInput($('#wake-d').value + 'T' + $('#wake-t').value);
    if (!bed || !wake) { toast('Enter both a bed time and a wake time.'); return; }
    if (wake <= bed) { toast('Wake time must be after bed time — for overnight sleep the wake date is usually the next day.'); return; }
    const spanMin = (wake - bed) / 60000;
    const plaus = RallentaLogic.plausible('sleep', { spanMin: spanMin }, 'min');
    const chosenTags = $$('[data-tag][aria-pressed=true]', app).map((c) => c.dataset.tag);
    pendingSleep = {
      bed_at: localISO(bed), wake_at: localISO(wake),
      latency_minutes: $('#latency').value === '' ? null : Math.max(0, +$('#latency').value),
      awake_minutes: $('#awake').value === '' ? null : Math.max(0, +$('#awake').value),
      quality: quality, tags: chosenTags, note: $('#note').value.trim() || null
    };
    if (!plaus.ok) { plausConfirm(plaus.message || PLAUS_COPY, () => renderSleepReview(app, pendingSleep)); return; }
    renderSleepReview(app, pendingSleep);
  });
}

function renderSleepReview(app, s) {
  const d = RallentaLogic.deriveSleep({ bed_at: s.bed_at, wake_at: s.wake_at, latency_minutes: s.latency_minutes, awake_minutes: s.awake_minutes });
  app.innerHTML =
    '<h1>Review sleep entry</h1>' +
    '<div class="card"><dl class="small">' +
    row('In bed', fmtDateTime(s.bed_at, timeFormat()) + ' → ' + fmtDateTime(s.wake_at, timeFormat())) +
    row('Time in bed', fmtDur(d.inBedMin)) +
    row('Estimated asleep', fmtDur(d.asleepMin)) +
    row('Falling asleep', (s.latency_minutes == null ? '—' : s.latency_minutes + ' min')) +
    row('Awake at night', (s.awake_minutes == null ? '—' : s.awake_minutes + ' min')) +
    row('Quality', s.quality + ' / 5') +
    row('Tags', s.tags.length ? esc(s.tags.join(', ')) : '—') +
    row('Note', s.note ? esc(s.note) : '—') +
    '</dl><p class="hint">Asleep time is an estimate: time in bed minus falling-asleep and awake minutes.</p></div>' +
    '<p class="row"><button class="btn-primary" id="sleep-save">' + (editingId ? 'Save changes' : 'Save entry') + '</button><button class="btn-ghost" id="sleep-back">Back to edit</button></p>';
  $('#sleep-back').addEventListener('click', () => { pendingSleep = null; renderSleepForm(app); });
  $('#sleep-save').addEventListener('click', async () => {
    const s2 = pendingSleep; pendingSleep = null;
    let saved;
    if (editingId) { saved = await RallentaDB.updateEntry(editingId, s2); }
    else { saved = await RallentaDB.saveSleep(s2); await touchLastUsed('sleep'); }
    const id = editingId; editingId = null;
    toast('Saved — You logged sleep, ' + fmtDur(RallentaLogic.deriveSleep(saved).asleepMin) + ' asleep (estimate).',
      { actionLabel: 'Undo', onAction: async () => { await RallentaDB.deleteEntry(saved.id); navigate('today'); } });
    navigate('today');
  });
}
function row(k, v) { return '<div class="spread" style="padding:4px 0"><dt class="muted">' + esc(k) + '</dt><dd style="margin:0;text-align:right">' + v + '</dd></div>'; }

/* ---------- #/log/vital/<type> ---------- */
function vitalFieldDefs(type) {
  if (type === 'blood_pressure') return [
    { key: 'systolic', label: 'Systolic', unit: 'mmHg', aria: 'Systolic pressure, millimeters of mercury' },
    { key: 'diastolic', label: 'Diastolic', unit: 'mmHg', aria: 'Diastolic pressure, millimeters of mercury' }
  ];
  if (type === 'heart_rate') return [
    { key: 'hr', label: 'Heart rate', unit: 'bpm', aria: 'Heart rate, beats per minute' }
  ];
  if (type === 'blood_sugar') return [
    { key: 'glucose', label: 'Blood sugar', unit: glucoseUnit(), aria: 'Blood sugar, ' + glucoseUnit(), altUnit: glucoseUnit() === 'mg/dL' ? 'mmol/L' : 'mg/dL' }
  ];
  if (type === 'weight') return [
    { key: 'weight', label: 'Weight', unit: weightUnit(), aria: 'Weight, ' + weightUnit(), altUnit: weightUnit() === 'lb' ? 'kg' : 'lb' }
  ];
  if (type === 'bmi') return [
    { key: 'bmi', label: 'BMI', unit: 'kg/m²', aria: 'Body mass index, kilograms per square meter' }
  ];
  return [];
}
function plausArgsFor(type, vals, unit) {
  // NB: logic.js RallentaLogic.plausible reads value_primary/value_secondary —
  // keep these field names in sync with logic.js.
  if (type === 'blood_pressure') return { metric: 'blood_pressure', values: { value_primary: vals.systolic, value_secondary: vals.diastolic }, unit: 'mmHg' };
  if (type === 'heart_rate') return { metric: 'heart_rate', values: { value_primary: vals.hr }, unit: 'bpm' };
  if (type === 'blood_sugar') return { metric: 'blood_sugar', values: { value_primary: vals.glucose }, unit: unit };
  if (type === 'weight') return { metric: 'weight', values: { value_primary: vals.weight }, unit: unit };
  if (type === 'bmi') return { metric: 'bmi', values: { value_primary: vals.bmi }, unit: 'kg/m²' };
  return null;
}

async function renderVitalForm(app, type) {
  let e = null;
  if (editingId) { e = await findEntry(editingId); if (!e || e.kind !== 'vital' || e.metric_type !== type) editingId = null; }
  if (pendingVital && !editingId && pendingVital.type === type) { return renderVitalReview(app, pendingVital); }
  pendingVital = null;

  const defs = vitalFieldDefs(type);
  const when = e ? dtInputVal(entryWhen(e)) : dtInputVal(localISO(new Date()));
  const valOf = (k) => {
    if (!e) return '';
    if (type === 'blood_pressure') return k === 'systolic' ? e.value_primary : e.value_secondary;
    return e.value_primary;
  };

  let unitToggle = '';
  if (type === 'blood_sugar' || type === 'weight') {
    const d0 = defs[0];
    unitToggle = '<label id="u-l">Unit</label><div class="radio-row" role="radiogroup" aria-labelledby="u-l">' +
      radioPill('vu', d0.unit, d0.unit, true) + radioPill('vu', d0.altUnit, d0.altUnit, false) + '</div>' +
      '<p class="hint" id="converted"></p>';
  }

  let bmiHelper = '';
  if (type === 'bmi' && prefs.heightCm) {
    bmiHelper = '<div class="card"><h2 style="margin-top:0">Compute from weight</h2>' +
      '<p class="hint">Using your saved height of ' + esc(String(prefs.heightCm)) + ' cm.</p>' +
      '<label for="bmi-w">Weight (' + esc(weightUnit()) + ')</label>' +
      '<input type="number" id="bmi-w" inputmode="decimal" min="0" step="0.1" aria-label="Weight in ' + esc(weightUnit()) + ' to compute BMI">' +
      '<p><button class="btn" id="bmi-compute">Compute BMI</button></p></div>';
  } else if (type === 'bmi' && !prefs.heightCm) {
    bmiHelper = '<p class="hint">No height saved — enter the BMI value directly, or add your height in Settings to compute it from weight.</p>';
  }

  const fields = defs.map((d) =>
    '<label for="f-' + d.key + '">' + esc(d.label) + ' <span class="muted">(' + esc(d.unit) + ')</span></label>' +
    '<input type="number" id="f-' + d.key + '" inputmode="decimal" min="0" step="any" value="' + esc(valOf(d.key)) + '" aria-label="' + esc(d.aria) + '">'
  ).join('');

  app.innerHTML =
    '<h1>' + (e ? 'Edit ' : '') + esc(VITAL_LABELS[type]) + '</h1>' +
    '<div class="manual-banner">' + esc(MANUAL_LABEL) + '</div>' +
    '<div class="card">' + fields + unitToggle + '</div>' +
    bmiHelper +
    '<div class="card"><label for="measured">Date &amp; time</label>' +
    '<input type="datetime-local" id="measured" value="' + esc(when) + '" aria-label="Date and time of the reading">' +
    '<label for="note">Note <span class="muted small">(optional)</span></label>' +
    '<textarea id="note" maxlength="500">' + esc(e && e.note ? e.note : '') + '</textarea></div>' +
    '<p class="row"><button class="btn-primary" id="vital-next">Review</button><a class="btn btn-ghost" href="#/log">Cancel</a></p>';

  const unitOf = () => (($('input[name=vu]:checked') || {}).value) || defs[0].unit;
  const convLine = $('#converted');
  const updateConv = () => {
    if (!convLine) return;
    const v = parseFloat($('#f-' + defs[0].key).value);
    const u = unitOf();
    if (!isFinite(v)) { convLine.textContent = ''; return; }
    try {
      const other = u === defs[0].unit ? defs[0].altUnit : defs[0].unit;
      const c = RallentaLogic.convert(v, u, other); // returns {value, unit}
      convLine.textContent = '= ' + (Math.round(c.value * 100) / 100) + ' ' + other + ' (shown alongside; your ' + u + ' entry is what gets saved)';
    } catch (err) { convLine.textContent = ''; }
  };
  if (convLine) {
    $('#f-' + defs[0].key).addEventListener('input', updateConv);
    $$('input[name=vu]').forEach((r) => r.addEventListener('change', updateConv));
    updateConv();
  }
  const bmiW = $('#bmi-w');
  if (bmiW) {
    $('#bmi-compute').addEventListener('click', () => {
      const w = parseFloat(bmiW.value);
      if (!isFinite(w) || w <= 0) { toast('Enter a weight first.'); return; }
      const wKg = weightUnit() === 'lb' ? w / 2.20462 : w;
      const hM = prefs.heightCm / 100;
      const bmi = wKg / (hM * hM);
      $('#f-bmi').value = (Math.round(bmi * 10) / 10).toString();
      toast('BMI computed from your saved height.');
    });
  }

  $('#vital-next').addEventListener('click', () => {
    const vals = {};
    for (const d of defs) {
      const raw = $('#f-' + d.key).value.trim();
      if (raw === '' || !isFinite(+raw)) { toast('Enter a number for ' + d.label + '.'); return; }
      vals[d.key] = +raw;
    }
    // Systolic/diastolic ordering is covered by RallentaLogic.plausible
    // (sys > dia), which returns the exact contract prompt copy.
    const unit = unitOf();
    const pa = plausArgsFor(type, vals, unit);
    const plaus = pa ? RallentaLogic.plausible(pa.metric, pa.values, pa.unit) : { ok: true };
    if (!plaus.ok) { plausConfirm(plaus.message || PLAUS_COPY, () => collectVital()); return; }
    collectVital();
    function collectVital() {
      const measured = parseDtInput($('#measured').value);
      if (!measured) { toast('Enter the date and time of the reading.'); return; }
      pendingVital = {
        type: type, vals: vals, unit: unit,
        measured_at: localISO(measured), note: $('#note').value.trim() || null
      };
      renderVitalReview(app, pendingVital);
    }
  });
}

function plausConfirm(message, onSaveAsEntered) {
  const m = modal('<h2>Check this value</h2><p>' + esc(message) + '</p>' +
    '<p class="row"><button class="btn-ghost" id="pc-again">Check again</button><button class="btn-primary" id="pc-save">Save as entered</button></p>');
  $('#pc-again', m.box).addEventListener('click', m.close);
  $('#pc-save', m.box).addEventListener('click', () => { m.close(); onSaveAsEntered(); });
}

function vitalToEntry(pv) {
  const base = { metric_type: pv.type, unit: pv.unit, measured_at: pv.measured_at, note: pv.note };
  if (pv.type === 'blood_pressure') { base.value_primary = pv.vals.systolic; base.value_secondary = pv.vals.diastolic; }
  else if (pv.type === 'heart_rate') base.value_primary = pv.vals.hr;
  else if (pv.type === 'blood_sugar') base.value_primary = pv.vals.glucose;
  else if (pv.type === 'weight') base.value_primary = pv.vals.weight;
  else if (pv.type === 'bmi') base.value_primary = pv.vals.bmi;
  return base;
}
function vitalSummary(pv) {
  if (pv.type === 'blood_pressure') return pv.vals.systolic + '/' + pv.vals.diastolic + ' ' + pv.unit;
  if (pv.type === 'heart_rate') return pv.vals.hr + ' ' + pv.unit;
  if (pv.type === 'blood_sugar') return pv.vals.glucose + ' ' + pv.unit;
  if (pv.type === 'weight') return pv.vals.weight + ' ' + pv.unit;
  if (pv.type === 'bmi') return pv.vals.bmi + ' ' + pv.unit;
  return '';
}

function renderVitalReview(app, pv) {
  app.innerHTML =
    '<h1>Review ' + esc(VITAL_LABELS[pv.type]) + '</h1>' +
    '<div class="manual-banner">' + esc(MANUAL_LABEL) + '</div>' +
    '<div class="card"><dl class="small">' +
    row('Reading', esc(vitalSummary(pv))) +
    row('Date & time', esc(fmtDateTime(pv.measured_at, timeFormat()))) +
    row('Note', pv.note ? esc(pv.note) : '—') +
    '</dl></div>' +
    '<p class="row"><button class="btn-primary" id="vital-save">' + (editingId ? 'Save changes' : 'Save entry') + '</button><button class="btn-ghost" id="vital-back">Back to edit</button></p>';
  $('#vital-back').addEventListener('click', () => { pendingVital = null; renderVitalForm(app, pv.type); });
  $('#vital-save').addEventListener('click', async () => {
    const pv2 = pendingVital; pendingVital = null;
    const payload = vitalToEntry(pv2);
    let saved;
    if (editingId) { saved = await RallentaDB.updateEntry(editingId, payload); }
    else { saved = await RallentaDB.saveVital(payload); await touchLastUsed(pv2.type); }
    editingId = null;
    const label = VITAL_LABELS[pv2.type];
    toast('Saved — You logged ' + label.toLowerCase() + ', ' + vitalSummary(pv2) + '.',
      { actionLabel: 'Undo', onAction: async () => { await RallentaDB.deleteEntry(saved.id); navigate('today'); } });
    navigate('today');
  });
}

/* ---------- #/trends ---------- */
const TREND_METRICS = [
  { key: 'sleep_duration', label: 'Sleep duration' },
  { key: 'sleep_quality', label: 'Sleep quality' },
  { key: 'blood_pressure', label: 'Blood pressure' },
  { key: 'heart_rate', label: 'Heart rate' },
  { key: 'blood_sugar', label: 'Blood sugar' },
  { key: 'weight', label: 'Weight' },
  { key: 'bmi', label: 'BMI' }
];

async function renderTrends(app) {
  if (!TREND_METRICS.find((m) => m.key === trendMetric)) trendMetric = 'sleep_duration';
  const since = new Date(Date.now() - trendRange * 864e5);

  let entries;
  if (trendMetric === 'sleep_duration' || trendMetric === 'sleep_quality') {
    entries = await RallentaDB.listEntries({ kind: 'sleep', since: localISO(since), limit: 5000 });
    entries = entries.filter((e) => parseLocalISO(e.wake_at || e.bed_at) >= since);
  } else {
    entries = await RallentaDB.listEntries({ kind: 'vital', metric_type: trendMetric, since: localISO(since), limit: 5000 });
    entries = entries.filter((e) => parseLocalISO(entryWhen(e)) >= since);
  }
  entries.sort((a, b) => entryWhen(a).localeCompare(entryWhen(b))); // oldest first for charts

  const isSleep = trendMetric === 'sleep_duration' || trendMetric === 'sleep_quality';
  const color = isSleep ? CHART_VIOLET : CHART_BLUE;
  const points = entries.map((e) => {
    let value, unit, label;
    if (trendMetric === 'sleep_duration') { value = RallentaLogic.deriveSleep(e).asleepMin; unit = 'min'; label = fmtDate(e.wake_at || e.bed_at) + ' · ' + fmtDur(value) + ' asleep'; }
    else if (trendMetric === 'sleep_quality') { value = e.quality; unit = '1–5'; label = fmtDate(e.wake_at || e.bed_at) + ' · quality ' + e.quality + '/5'; }
    else if (trendMetric === 'blood_pressure') { value = e.value_primary; unit = e.unit || 'mmHg'; label = fmtDateTime(entryWhen(e), timeFormat()) + ' · ' + e.value_primary + '/' + e.value_secondary + ' ' + unit; }
    else { value = e.value_primary; unit = e.unit || ''; label = fmtDateTime(entryWhen(e), timeFormat()) + ' · ' + e.value_primary + (unit ? ' ' + unit : ''); }
    return { t: parseLocalISO(entryWhen(e)).getTime(), label: label, value: value };
  });

  const selMetric = TREND_METRICS.map((m) =>
    '<button type="button" class="chip" data-metric="' + m.key + '" aria-pressed="' + (trendMetric === m.key ? 'true' : 'false') + '">' + esc(m.label) + '</button>').join('');
  const selRange = [7, 30, 90].map((r) =>
    '<button type="button" class="chip" data-range="' + r + '" aria-pressed="' + (trendRange === r ? 'true' : 'false') + '">' + r + ' days</button>').join('');

  let body;
  if (points.length < 2) {
    body = '<div class="empty"><p><strong>Not enough records yet.</strong></p><p>Log at least 2 entries in the last ' + trendRange + ' days to see a chart.</p><p><a class="btn btn-primary" href="#/log">Log a reading</a></p></div>';
  } else {
    const stats = RallentaLogic.describeStats(points.map((p) => p.value));
    const unit = points[0].unit;
    body =
      '<div class="stat-grid" role="list" aria-label="Summary statistics">' +
      stat('Average', avgFmt(stats.avg, unit), unit) +
      stat('Median', avgFmt(stats.median, unit), unit) +
      stat('Entries', stats.n, 'count') +
      '</div>' +
      '<div class="chart-wrap"><div id="chart"></div></div>' +
      '<details class="card"><summary>Data table (screen-reader friendly)</summary><div id="chart-table"></div></details>';
  }

  // sleep-target gap estimate
  let debtHtml = '';
  if (isSleep) {
    const allSleep = await RallentaDB.listEntries({ kind: 'sleep', since: localISO(since), limit: 5000 });
    const debt = RallentaLogic.sleepDebt(allSleep, sleepTargetMin(), trendRange);
    const dayRows = debt.days.slice(-14).map((d) =>
      '<div class="spread" style="padding:3px 0"><span class="muted">' + esc(d.date) + '</span><span>' + (d.gapMin == null ? 'no entry' : fmtDur(d.gapMin) + ' under target') + '</span></div>').join('');
    debtHtml = '<div class="card"><h2 style="margin-top:0">Sleep-target gap, last ' + trendRange + ' days</h2>' +
      '<p style="font-size:1.4rem;font-weight:700;margin:.2em 0">' + esc(fmtDur(debt.totalGapMin)) + '</p>' +
      '<p class="hint">' + esc(DEBT_LABEL) + '</p>' + dayRows + '</div>';
  }

  const listRecent = entries.slice(-VISIBLE_DAYS).reverse().map((e) =>
    '<li><div class="e-main"><div class="e-title">' + esc(isSleep ? describeSleep(e) : describeVital(e)) + '</div><div class="e-sub">' + esc(fmtDateTime(entryWhen(e), timeFormat())) + '</div></div></li>').join('');

  app.innerHTML =
    '<h1>Trends</h1>' +
    '<div class="card"><h2 style="margin-top:0">Metric</h2><div class="chips">' + selMetric + '</div>' +
    '<h2>Range</h2><div class="chips">' + selRange + '</div></div>' +
    body + debtHtml +
    '<div class="card"><h2 style="margin-top:0">Recent records</h2>' +
    (listRecent ? '<ul class="entry-list">' + listRecent + '</ul>' : '<p class="muted">No records in this range yet.</p>') +
    '<p class="hint">Free tier: lists show the most recent ' + VISIBLE_DAYS + ' days. Your full history stays on this device and is included in exports.</p></div>';

  $$('[data-metric]', app).forEach((b) => b.addEventListener('click', () => { trendMetric = b.dataset.metric; render(); }));
  $$('[data-range]', app).forEach((b) => b.addEventListener('click', () => { trendRange = +b.dataset.range; render(); }));

  if (points.length >= 2) {
    const unit = points[0].unit;
    try { RallentaCharts.render($('#chart'), { points: points, unit: unit, color: color }); }
    catch (err) { $('#chart').innerHTML = '<p class="muted">Chart unavailable.</p>'; }
    try { RallentaCharts.table($('#chart-table'), { points: points, unit: unit }); }
    catch (err) { $('#chart-table').innerHTML = '<p class="muted">Table unavailable.</p>'; }
  }
}
function stat(k, v, unit) {
  return '<div class="stat" role="listitem"><div class="v">' + esc(String(v)) + '</div><div class="k">' + esc(k) + (unit && unit !== 'count' ? ' · ' + esc(unit) : '') + '</div></div>';
}
function avgFmt(v, unit) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return unit === 'min' ? fmtDur(r) : String(r);
}

/* ---------- #/audio ---------- */
async function renderAudio(app) {
  if (!player) player = new RallentaPlayer();
  const tracks = await player.loadManifest('audio/manifest.json');

  const trackList = tracks.length === 0
    ? '<div class="empty"><p><strong>Audio tracks are still being prepared.</strong></p><p>Check back shortly — your wind-down library will appear here.</p></div>'
    : tracks.map((t, i) =>
      '<div class="track"><div><div class="t-title' + (player.index === i ? ' playing' : '') + '">' + esc(t.title || t.id) + '</div>' +
      '<div class="muted small">' + esc(t.family || 'ambient') + (t.duration_s ? ' · ' + fmtDur(t.duration_s / 60) : '') + '</div></div>' +
      '<button class="btn" data-track="' + i + '" aria-label="' + (player.index === i && player.playing ? 'Pause ' : 'Play ') + esc(t.title || t.id) + '">' +
      (player.index === i && player.playing ? '❚❚' : '▶') + '</button></div>').join('');

  const timerBtns = [0, 15, 30, 45, 60].map((m) =>
    '<button type="button" class="chip" data-timer="' + m + '" aria-pressed="' + (player.timerMin === m ? 'true' : 'false') + '">' +
    (m === 0 ? 'Off' : m + ' min') + '</button>').join('');

  app.innerHTML =
    '<h1>Wind down</h1>' +
    '<p class="muted">Original stereo tracks for your evening routine. They loop seamlessly and never start on their own.</p>' +
    '<div class="card">' + trackList + '</div>' +
    (tracks.length ? (
      '<div class="player" role="region" aria-label="Now playing">' +
      '<div class="spread"><strong id="now-title">' + esc(player.current ? (player.current.title || player.current.id) : 'Nothing playing') + '</strong>' +
      '<span class="muted small" id="timer-state">' + (player.timerMin ? 'Timer: ' + player.timerMin + ' min (fades out over the last 30s)' : 'Timer off') + '</span></div>' +
      '<div class="controls">' +
      '<button class="play-btn" id="pp" aria-label="' + (player.playing ? 'Pause' : 'Play') + '">' + (player.playing ? '❚❚' : '▶') + '</button>' +
      '<input type="range" class="scrub" id="scrub" min="0" max="100" value="0" step="0.1" aria-label="Seek within track">' +
      '</div>' +
      '<div class="time-row"><span id="t-cur">0:00</span><span id="t-dur">0:00</span></div>' +
      '<h3>Sleep timer</h3><div class="chips">' + timerBtns + '</div>' +
      '<p class="hint">The track fades out gently over the final 30 seconds, then stops.</p></div>'
    ) : '');

  if (!tracks.length) return;

  $$('[data-track]', app).forEach((b) => b.addEventListener('click', () => {
    const i = +b.dataset.track;
    if (player.index === i && player.playing) player.pause();
    else player.playTrack(i);
    render();
  }));
  $$('[data-timer]', app).forEach((b) => b.addEventListener('click', () => {
    player.setSleepTimer(+b.dataset.timer);
    render();
  }));
  $('#pp').addEventListener('click', () => { player.toggle(); render(); });

  const scrub = $('#scrub'), cur = $('#t-cur'), dur = $('#t-dur');
  const fmtS = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + pad2(s % 60); };
  player.audio.ontimeupdate = () => {
    if (isFinite(player.audio.duration) && player.audio.duration > 0) {
      scrub.value = (player.audio.currentTime / player.audio.duration) * 100;
      cur.textContent = fmtS(player.audio.currentTime);
      dur.textContent = fmtS(player.audio.duration);
    }
  };
  scrub.addEventListener('change', () => {
    if (isFinite(player.audio.duration)) player.seekTo((scrub.value / 100) * player.audio.duration);
  });
  if (!player._timerdoneBound) {
    player._timerdoneBound = true;
    player.on('timerdone', () => toast('Wind-down timer finished.'));
  }
}

/* ---------- #/settings ---------- */
async function renderSettings(app) {
  const rems = (prefs.reminders) || [];
  const remHtml = rems.length === 0
    ? '<p class="muted">No reminders yet.</p>'
    : '<ul class="entry-list">' + rems.map((r) =>
      '<li><div class="e-main"><div class="e-title">' + esc(remLabel(r)) + '</div><div class="e-sub">' + esc(r.time) + '</div></div>' +
      '<button class="icon-btn" data-remdel="' + esc(r.id) + '" aria-label="Delete reminder at ' + esc(r.time) + '">Delete</button></li>').join('') + '</ul>';

  app.innerHTML =
    '<h1>Settings</h1>' +
    '<div class="card"><h2 style="margin-top:0">Units &amp; target</h2>' +
    '<label id="tf-l">Time format</label><div class="radio-row" role="radiogroup" aria-labelledby="tf-l">' +
    radioPill('tf', '12h', '12-hour', timeFormat() === '12h') + radioPill('tf', '24h', '24-hour', timeFormat() === '24h') + '</div>' +
    '<label id="wu-l">Weight unit</label><div class="radio-row" role="radiogroup" aria-labelledby="wu-l">' +
    radioPill('wu', 'lb', 'Pounds (lb)', weightUnit() === 'lb') + radioPill('wu', 'kg', 'Kilograms (kg)', weightUnit() === 'kg') + '</div>' +
    '<label id="gu-l">Blood sugar unit</label><div class="radio-row" role="radiogroup" aria-labelledby="gu-l">' +
    radioPill('gu', 'mg/dL', 'mg/dL', glucoseUnit() === 'mg/dL') + radioPill('gu', 'mmol/L', 'mmol/L', glucoseUnit() === 'mmol/L') + '</div>' +
    '<label for="height">Height (cm, optional)</label>' +
    '<input type="number" id="height" inputmode="decimal" min="50" max="250" step="1" value="' + esc(prefs.heightCm || '') + '" aria-label="Height in centimeters, optional">' +
    '<label for="target">Sleep target: <strong id="target-out">' + esc(fmtDur(sleepTargetMin())) + '</strong></label>' +
    '<input type="range" id="target" min="300" max="600" step="30" value="' + sleepTargetMin() + '" aria-label="Sleep target in minutes">' +
    '<p><button class="btn-primary" id="save-units">Save preferences</button></p></div>' +
    '<div class="card"><h2 style="margin-top:0">Reminders</h2>' +
    '<p class="hint">Local notifications only — nothing leaves this device. Permission is requested the first time you save a reminder.</p>' +
    remHtml +
    '<div class="grid" style="grid-template-columns:1fr 1fr;margin-top:10px">' +
    '<div><label for="rem-time">Time</label><input type="time" id="rem-time" value="22:00"></div>' +
    '<div><label for="rem-kind">Type</label><select id="rem-kind"><option value="winddown">Wind down</option><option value="morning">Morning log</option><option value="checkin">Check-in</option></select></div></div>' +
    '<p><button class="btn" id="rem-add">Add reminder</button></p></div>' +
    '<div class="card"><h2 style="margin-top:0">Your data</h2>' +
    '<p class="row"><button class="btn" id="exp-json">Export JSON</button><button class="btn" id="exp-csv">Export CSV</button></p>' +
    '<p class="hint">JSON is a full backup (schema, preferences, entries). CSV opens in spreadsheets.</p>' +
    '<label for="import-file">Import JSON backup</label>' +
    '<input type="file" id="import-file" accept="application/json,.json" style="font-size:1rem">' +
    '<div id="import-ui"></div></div>' +
    '<div class="card"><h2 style="margin-top:0">Delete</h2>' +
    '<label for="del-cat">Delete a category</label>' +
    '<div class="row"><select id="del-cat" style="flex:1">' +
    '<option value="sleep">Sleep</option><option value="blood_pressure">Blood pressure</option><option value="heart_rate">Heart rate</option><option value="blood_sugar">Blood sugar</option><option value="weight">Weight</option><option value="bmi">BMI</option>' +
    '</select><button class="btn-danger" id="del-cat-btn">Delete category</button></div>' +
    '<p class="hint">Removes every entry of that type from this device.</p>' +
    '<p><button class="btn-danger" id="del-all">Delete all my data</button></p>' +
    '<p class="hint">Wipes all entries and preferences. This is the one action with no undo.</p></div>' +
    '<div class="card"><h2 style="margin-top:0">About</h2>' +
    '<p><a class="btn" href="#/about">About Rallenta &amp; disclaimer</a></p></div>';

  $('#target').addEventListener('input', () => { $('#target-out').textContent = fmtDur(+$('#target').value); });
  $('#save-units').addEventListener('click', async () => {
    const hRaw = $('#height').value.trim();
    await savePrefs({
      timeFormat: ($('input[name=tf]:checked') || {}).value || '12h',
      weightUnit: ($('input[name=wu]:checked') || {}).value || 'lb',
      glucoseUnit: ($('input[name=gu]:checked') || {}).value || 'mg/dL',
      heightCm: hRaw === '' ? null : Math.max(50, Math.min(250, +hRaw || 0)),
      sleepTargetMin: +$('#target').value
    });
    toast('Preferences saved.');
  });

  $('#rem-add').addEventListener('click', async () => {
    if (!('Notification' in window)) { toast('This browser does not support notifications — the reminder was not added.'); return; }
    if (Notification.permission === 'denied') { toast('Notifications are blocked for this site in your browser settings.'); return; }
    if (Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { toast('Reminder not added — notification permission was not granted.'); return; }
    }
    const rems2 = (prefs.reminders) || [];
    rems2.push({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), time: $('#rem-time').value || '22:00', kind: $('#rem-kind').value });
    await savePrefs({ reminders: rems2 });
    scheduleInAppReminders();
    toast('Reminder added.');
    render();
  });
  $$('[data-remdel]', app).forEach((b) => b.addEventListener('click', async () => {
    await savePrefs({ reminders: (prefs.reminders || []).filter((r) => r.id !== b.dataset.remdel) });
    scheduleInAppReminders();
    render();
  }));

  $('#exp-json').addEventListener('click', async () => {
    const obj = await RallentaDB.exportJSON();
    download('rallenta-backup-' + localDateStr() + '.json', JSON.stringify(obj, null, 2), 'application/json');
  });
  $('#exp-csv').addEventListener('click', async () => {
    const csv = await RallentaDB.exportCSV();
    download('rallenta-export-' + localDateStr() + '.csv', csv, 'text/csv');
  });
  $('#import-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    let obj;
    try { obj = JSON.parse(await f.text()); }
    catch (err) { $('#import-ui').innerHTML = '<p class="muted">That file is not valid JSON.</p>'; return; }
    let preview;
    try { preview = await RallentaDB.importJSON(obj, { mode: 'preview' }); }
    catch (err) { $('#import-ui').innerHTML = '<p class="muted">Could not read that backup: ' + esc(err.message || err) + '</p>'; return; }
    const ui = $('#import-ui');
    ui.innerHTML =
      '<div class="card"><h3>Import preview</h3>' +
      '<p>Sleep entries: ' + preview.counts.sleep + ' · Vital entries: ' + preview.counts.vitals + '</p>' +
      '<p>Conflicts: ' + preview.conflicts + (preview.errors && preview.errors.length ? ' · Issues: ' + esc(preview.errors.join('; ')) : '') + '</p>' +
      (preview.conflicts ? '<label id="cf-l">If an entry already exists</label><div class="radio-row" role="radiogroup" aria-labelledby="cf-l">' +
        radioPill('cf', 'skip', 'Skip', true) + radioPill('cf', 'replace', 'Replace', false) + radioPill('cf', 'duplicate', 'Duplicate', false) + '</div>' : '') +
      '<p class="row"><button class="btn-primary" id="imp-go">Import now</button><button class="btn-ghost" id="imp-cancel">Cancel</button></p></div>';
    $('#imp-cancel').addEventListener('click', () => { ui.innerHTML = ''; $('#import-file').value = ''; });
    $('#imp-go').addEventListener('click', async () => {
      const strat = preview.conflicts ? (($('input[name=cf]:checked') || {}).value || 'skip') : 'skip';
      const res = await RallentaDB.importJSON(obj, { mode: 'commit', onConflict: strat });
      ui.innerHTML = '';
      toast('Import complete: ' + res.imported + ' added, ' + res.skipped + ' skipped.');
      render();
    });
  });

  $('#del-cat-btn').addEventListener('click', async () => {
    const kind = $('#del-cat').value;
    const list = kind === 'sleep'
      ? await RallentaDB.listEntries({ kind: 'sleep', limit: 5000 })
      : await RallentaDB.listEntries({ kind: 'vital', metric_type: kind, limit: 5000 });
    const m = modal('<h2>Delete all ' + esc(METRIC_LABEL[kind] || kind) + ' entries?</h2>' +
      '<p>This removes ' + list.length + ' entr' + (list.length === 1 ? 'y' : 'ies') + ' from this device.</p>' +
      '<p class="row"><button class="btn-danger" id="dc-yes">Delete ' + list.length + '</button><button id="dc-no">Cancel</button></p>');
    $('#dc-no', m.box).addEventListener('click', m.close);
    $('#dc-yes', m.box).addEventListener('click', async () => {
      m.close();
      const snapshot = JSON.parse(JSON.stringify(list));
      const n = await RallentaDB.deleteCategory(kind);
      toast('Deleted ' + n + ' ' + (METRIC_LABEL[kind] || kind) + ' entries.', {
        actionLabel: 'Undo', onAction: async () => { for (const s of snapshot) await restoreEntry(s); render(); }
      });
      render();
    });
  });

  $('#del-all').addEventListener('click', () => {
    const m = modal('<h2>Delete all my data?</h2>' +
      '<p>This wipes <strong>every entry and every preference</strong> from this device. There is no undo.</p>' +
      '<label for="del-confirm">Type DELETE to confirm</label>' +
      '<input type="text" id="del-confirm" autocomplete="off" aria-label="Type DELETE to confirm">' +
      '<p class="row"><button class="btn-danger" id="da-yes" disabled>Delete everything</button><button id="da-no">Cancel</button></p>');
    const inp = $('#del-confirm', m.box), yes = $('#da-yes', m.box);
    inp.addEventListener('input', () => { yes.disabled = inp.value.trim() !== 'DELETE'; });
    $('#da-no', m.box).addEventListener('click', m.close);
    yes.addEventListener('click', async () => {
      await RallentaDB.deleteAll();
      location.hash = '#/welcome';
      location.reload();
    });
  });
}
function remLabel(r) {
  return r.kind === 'winddown' ? 'Wind down' : r.kind === 'morning' ? 'Morning log' : 'Check-in';
}
function download(name, text, type) {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- #/about ---------- */
function renderAbout(app) {
  app.innerHTML =
    '<h1>About Rallenta</h1>' +
    '<div class="card"><h2 style="margin-top:0">Rallenta</h2>' +
    '<p><strong>Your rest. Your readings. Your device.</strong></p>' +
    '<p class="muted">Version 1.0 — Phase 1 MVP. A private, manual-first wellness journal for sleep and everyday body readings, with original wind-down audio.</p></div>' +
    '<div class="disclaimer" role="note">' + esc(DISCLAIMER) + '</div>' +
    '<div class="card"><h2 style="margin-top:0">How your data works</h2>' +
    '<ul><li>Entries live in this browser\'s local storage only.</li>' +
    '<li>No account, no cloud sync, no ads, no trackers on your entries.</li>' +
    '<li>Export a JSON backup or CSV any time from Settings.</li>' +
    '<li>Delete one entry, one category, or everything — your call.</li></ul></div>' +
    '<div class="card"><h2 style="margin-top:0">Plain-language notes</h2>' +
    '<ul><li>You log readings; this app never measures anything through your phone.</li>' +
    '<li>Sleep “asleep” times are estimates from the times you enter.</li>' +
    '<li>Gap and trend summaries are arithmetic on your own entries — not measurements of your body.</li>' +
    '<li>If something worries you, talk with a qualified professional.</li></ul></div>';
}

/* ---------- reminders (local only) ---------- */
const REMINDER_COPY = 'Time for your Rallenta check-in';
let inAppTimers = [];

function notifyRallenta() {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Rallenta', { body: REMINDER_COPY, tag: 'rallenta-reminder' });
    } else {
      toast(REMINDER_COPY);
    }
  } catch (e) { toast(REMINDER_COPY); }
}
function reminderOccurrence(timeStr, baseDate) {
  const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(baseDate);
  d.setHours(+m[1], +m[2], 0, 0);
  return d;
}
async function checkRemindersOnLaunch() {
  try {
    const rems = (prefs && prefs.reminders) || [];
    if (!rems.length) return;
    const today = localDateStr();
    const notified = Object.assign({}, prefs.reminderNotified || {});
    const now = new Date();
    let changed = false;
    for (const r of rems) {
      const occ = reminderOccurrence(r.time, now);
      if (!occ) continue;
      if (occ <= now && notified[r.id] !== today) {
        notifyRallenta(); // covers due and missed — fires once per reminder per day
        notified[r.id] = today;
        changed = true;
      }
    }
    if (changed) await savePrefs({ reminderNotified: notified });
  } catch (e) {}
}
function scheduleInAppReminders() {
  inAppTimers.forEach(clearTimeout);
  inAppTimers = [];
  try {
    const rems = (prefs && prefs.reminders) || [];
    const now = new Date();
    for (const r of rems) {
      let occ = reminderOccurrence(r.time, now);
      if (!occ) continue;
      if (occ <= now) occ = new Date(occ.getTime() + 864e5); // next occurrence tomorrow
      const ms = occ - now;
      if (ms > 0 && ms < 864e5) {
        inAppTimers.push(setTimeout(async () => {
          notifyRallenta();
          const notified = Object.assign({}, prefs.reminderNotified || {});
          notified[r.id] = localDateStr();
          await savePrefs({ reminderNotified: notified });
          scheduleInAppReminders();
        }, ms));
      }
    }
  } catch (e) {}
}

/* ---------- boot ---------- */
async function boot() {
  try {
    await RallentaDB.init();
  } catch (e) {
    $('#app').innerHTML = '<h1>Storage unavailable</h1><p class="muted">Rallenta could not open local storage in this browser (' + esc(e.message || e) + '). Entries cannot be saved here.</p>';
    return;
  }
  prefs = await RallentaDB.getPrefs();
  if (!prefs) prefs = {};
  gaAppLaunch();
  window.addEventListener('hashchange', render);
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) {}
  }
  render();
  checkRemindersOnLaunch();
  scheduleInAppReminders();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleInAppReminders(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
