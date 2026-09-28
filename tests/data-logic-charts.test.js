// Rallenta data/logic/charts test harness (node, fake-indexeddb).
// Run:  npm install fake-indexeddb   (in the dir you run from; the harness
//         requires it at /tmp/node_modules/fake-indexeddb by default — adjust
//         the require path below if installed elsewhere)
//       node tests/data-logic-charts.test.js
// Covers: save/update/delete/list for vitals + sleep, cross-midnight
// derivation, unit-conversion purity, export->import round-trip, import
// conflict preview/counts, commit skip|replace|duplicate, deleteCategory,
// deleteAll, CSV header/comments, plausibility bounds, sleep debt math,
// chart empty-state / gap-breaks / table alternative.
'use strict';
const path = '/tmp/node_modules';
const { indexedDB, IDBKeyRange } = require(path + '/fake-indexeddb');
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

const { RallentaDB, localISO, DISCLAIMER } = require('/home/hatch/workspace/rallenta/data.js');
const { RallentaLogic } = require('/home/hatch/workspace/rallenta/logic.js');
const { RallentaCharts } = require('/home/hatch/workspace/rallenta/charts.js');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function near(a, b, eps) { eps = eps || 1e-9; return Math.abs(a - b) <= eps; }

const iso = (s) => s; // pass through pre-built ISO+offset strings
const daysAgo = (n, hh, mm) => {
  const d = new Date(); d.setDate(d.getDate() - n); d.setHours(hh, mm, 0, 0);
  return localISO(d);
};

(async () => {
  console.log('== data.js ==');
  await RallentaDB.init();
  ok('init', true);

  // prefs defaults
  const prefs0 = await RallentaDB.getPrefs();
  ok('prefs defaults keys', prefs0.sleepTargetMin === 480 && prefs0.entitlement === 'free' &&
    prefs0.disclaimerAcceptedAt === null && prefs0.onboardingDone === false &&
    ['12h','24h'].includes(prefs0.timeFormat) && ['lb','kg'].includes(prefs0.weightUnit));
  const prefs1 = await RallentaDB.setPrefs({ sleepTargetMin: 420, weightUnit: 'kg' });
  ok('setPrefs', prefs1.sleepTargetMin === 420 && prefs1.weightUnit === 'kg');
  await RallentaDB.setPrefs({ sleepTargetMin: 480 });

  // --- vitals: one of each type ---
  const bp = await RallentaDB.saveVital({ metric_type: 'blood_pressure', value_primary: 118,
    value_secondary: 76, unit: 'mmHg', measured_at: daysAgo(0, 8, 5), context: 'Morning', note: 'calm' });
  ok('saveVital BP', bp.kind === 'vital' && bp.entry_source === 'manual' && bp.schema_version === 1 && !!bp.id);
  const hr = await RallentaDB.saveVital({ metric_type: 'heart_rate', value_primary: 62, unit: 'bpm',
    measured_at: daysAgo(0, 8, 6) });
  const glu = await RallentaDB.saveVital({ metric_type: 'blood_sugar', value_primary: 102, unit: 'mg/dL',
    measured_at: daysAgo(1, 7, 30), context: 'Fasting' });
  const wt = await RallentaDB.saveVital({ metric_type: 'weight', value_primary: 198.5, unit: 'lb',
    measured_at: daysAgo(1, 7, 31) });
  const bmi = await RallentaDB.saveVital({ metric_type: 'bmi', value_primary: 27.4, unit: 'kg/m²',
    measured_at: daysAgo(1, 7, 32) });
  ok('saveVital 5 types', [bp, hr, glu, wt, bmi].every(e => e.id && e.created_at && e.updated_at));

  // --- sleep: cross-midnight ---
  const bed = daysAgo(1, 22, 30), wake = daysAgo(0, 6, 30);
  const sl = await RallentaDB.saveSleep({ bed_at: bed, wake_at: wake, latency_minutes: 20,
    awake_minutes: 15, quality: 4, tags: ['no-caffeine'], note: 'felt fine' });
  ok('saveSleep cross-midnight derived', sl.derived_duration_min === 445 && sl.derived_in_bed_min === 480,
    JSON.stringify({d: sl.derived_duration_min, ib: sl.derived_in_bed_min}));
  ok('saveSleep measured_at mirrors wake', sl.measured_at === wake && sl.metric_type === 'sleep' && sl.kind === 'sleep');

  // --- updateEntry: note edit + wake change recompute ---
  const upd1 = await RallentaDB.updateEntry(sl.id, { note: 'edited note' });
  ok('updateEntry note', upd1.note === 'edited note' && upd1.derived_duration_min === 445);
  const wake2 = daysAgo(0, 7, 0);
  const upd2 = await RallentaDB.updateEntry(sl.id, { wake_at: wake2 });
  ok('updateEntry wake recompute', upd2.derived_duration_min === 475 && upd2.measured_at === wake2,
    String(upd2.derived_duration_min));

  // --- listEntries ---
  const vitals = await RallentaDB.listEntries({ kind: 'vital' });
  ok('list vitals newest first', vitals.length === 5 && vitals[0].measured_at >= vitals[4].measured_at);
  const sleeps = await RallentaDB.listEntries({ kind: 'sleep' });
  ok('list sleep', sleeps.length === 1);
  const onlyBP = await RallentaDB.listEntries({ kind: 'vital', metric_type: 'blood_pressure' });
  ok('list metric_type filter', onlyBP.length === 1 && onlyBP[0].id === bp.id);
  const limited = await RallentaDB.listEntries({ kind: 'vital', limit: 2 });
  ok('list limit', limited.length === 2);
  const sinceF = await RallentaDB.listEntries({ kind: 'vital', since: daysAgo(0, 8, 0) });
  ok('list since', sinceF.length === 2, String(sinceF.length));

  // --- deleteEntry ---
  await RallentaDB.deleteEntry(bmi.id);
  const afterDel = await RallentaDB.listEntries({ kind: 'vital' });
  ok('deleteEntry', afterDel.length === 4 && !afterDel.some(e => e.id === bmi.id));

  // --- validation rejections ---
  let rej = 0;
  await RallentaDB.saveVital({ metric_type: 'nope', value_primary: 1, unit: 'bpm', measured_at: daysAgo(0,1,1) }).catch(() => rej++);
  await RallentaDB.saveVital({ metric_type: 'heart_rate', value_primary: 60, unit: 'bpm',
    measured_at: daysAgo(0,1,1), note: 'x'.repeat(501) }).catch(() => rej++);
  await RallentaDB.saveSleep({ bed_at: bed, wake_at: wake, quality: 6 }).catch(() => rej++);
  await RallentaDB.saveSleep({ bed_at: bed, wake_at: wake, quality: 3, latency_minutes: -5 }).catch(() => rej++);
  await RallentaDB.updateEntry('no-such-id', { note: 'x' }).catch(() => rej++);
  await RallentaDB.setPrefs({ weightUnit: 'stone' }).catch(() => rej++);
  ok('validation rejections (6)', rej === 6, String(rej));

  // --- exportJSON ---
  const exp = await RallentaDB.exportJSON();
  ok('exportJSON shape', exp.app === 'rallenta' && exp.schema_version === 1 && !!exp.exported_at &&
    Array.isArray(exp.entries) && exp.preferences.sleepTargetMin === 480);
  ok('exportJSON disclaimer exact', exp.disclaimer ===
    'Rallenta is a wellness journal, not a medical device. It does not measure vital signs, diagnose conditions, or provide medical advice.');

  // --- import preview: identical export -> 0 conflicts, writes nothing ---
  const before = (await RallentaDB.listEntries({ kind: 'vital' })).length +
                 (await RallentaDB.listEntries({ kind: 'sleep' })).length;
  const prev1 = await RallentaDB.importJSON(JSON.parse(JSON.stringify(exp)), { mode: 'preview' });
  const after = (await RallentaDB.listEntries({ kind: 'vital' })).length +
                 (await RallentaDB.listEntries({ kind: 'sleep' })).length;
  ok('import preview identical: 0 conflicts, no writes', prev1.ok && prev1.conflicts === 0 &&
    prev1.counts.vitals === 4 && prev1.counts.sleep === 1 && before === after);
  // create a real conflict: local copy touched, payload carries a clearly stale updated_at
  await RallentaDB.updateEntry(hr.id, { note: 'touched' });
  const staleExp = JSON.parse(JSON.stringify(exp));
  staleExp.entries.forEach(e => { if (e.id === hr.id) e.updated_at = '2020-01-01T00:00:00-05:00'; });
  const prev2 = await RallentaDB.importJSON(staleExp, { mode: 'preview' });
  ok('import preview conflict counted', prev2.conflicts === 1 && prev2.ok, JSON.stringify(prev2.conflicts));
  // invalid import
  const prevBad = await RallentaDB.importJSON({ app: 'nope' }, { mode: 'preview' });
  ok('import preview invalid', !prevBad.ok && prevBad.errors.length > 0);

  // --- import commit: skip keeps local, replace overwrites, duplicate clones ---
  const staleHR = JSON.parse(JSON.stringify(staleExp.entries.find(e => e.id === hr.id)));
  const payload = { app: 'rallenta', schema_version: 1, exported_at: staleExp.exported_at,
    disclaimer: staleExp.disclaimer, preferences: staleExp.preferences, entries: [staleHR] };
  const c1 = await RallentaDB.importJSON(payload, { mode: 'commit', onConflict: 'skip' });
  const hrAfterSkip = (await RallentaDB.listEntries({ kind: 'vital', metric_type: 'heart_rate' }))[0];
  ok('commit skip: never silently overwrites', c1.imported === 0 && c1.skipped === 1 && hrAfterSkip.note === 'touched');
  const c2 = await RallentaDB.importJSON(payload, { mode: 'commit', onConflict: 'replace' });
  const hrAfterRep = (await RallentaDB.listEntries({ kind: 'vital', metric_type: 'heart_rate' }))[0];
  ok('commit replace', c2.imported === 1 && hrAfterRep.note === null && hrAfterRep.updated_at === staleHR.updated_at);
  // make it conflict again, then duplicate must keep both records
  await RallentaDB.updateEntry(hr.id, { note: 'touched again' });
  const c3 = await RallentaDB.importJSON(payload, { mode: 'commit', onConflict: 'duplicate' });
  const hrsNow = await RallentaDB.listEntries({ kind: 'vital', metric_type: 'heart_rate' });
  ok('commit duplicate keeps both', c3.imported === 1 && hrsNow.length === 2 &&
    new Set(hrsNow.map(e => e.id)).size === 2);

  // --- exportCSV ---
  const csv = await RallentaDB.exportCSV();
  const lines = csv.split('\n');
  const comments = lines.filter(l => l.startsWith('#'));
  ok('csv header comments + disclaimer', comments.length >= 4 && comments.some(l => l.includes('wellness journal, not a medical device')));
  ok('csv column header', lines[comments.length].startsWith('id,kind,metric_type,'));
  ok('csv original units preserved', csv.includes('mg/dL') && csv.includes('mmHg') && csv.includes('lb'));
  ok('csv row count matches', lines.filter(l => l && !l.startsWith('#') && !l.startsWith('id,')).length ===
    (await RallentaDB.listEntries({ kind: 'vital' })).length + (await RallentaDB.listEntries({ kind: 'sleep' })).length);

  // --- deleteCategory ---
  const nBP = await RallentaDB.deleteCategory('blood_pressure');
  ok('deleteCategory metric_type', nBP === 1);
  const nSleep = await RallentaDB.deleteCategory('sleep');
  ok('deleteCategory sleep', nSleep === 1 && (await RallentaDB.listEntries({ kind: 'sleep' })).length === 0);
  const nVital = await RallentaDB.deleteCategory('vital');
  ok('deleteCategory vital', nVital === 4 && (await RallentaDB.listEntries({ kind: 'vital' })).length === 0);
  let catRej = false;
  await RallentaDB.deleteCategory('bogus').catch(() => catRej = true);
  ok('deleteCategory invalid rejects', catRej);

  // --- deleteAll wipes entries + prefs ---
  await RallentaDB.saveVital({ metric_type: 'heart_rate', value_primary: 60, unit: 'bpm', measured_at: daysAgo(0, 9, 0) });
  await RallentaDB.setPrefs({ sleepTargetMin: 400 });
  await RallentaDB.deleteAll();
  const vEmpty = await RallentaDB.listEntries({ kind: 'vital' });
  const sEmpty = await RallentaDB.listEntries({ kind: 'sleep' });
  const pReset = await RallentaDB.getPrefs();
  ok('deleteAll wipes', vEmpty.length === 0 && sEmpty.length === 0 && pReset.sleepTargetMin === 480);

  console.log('== logic.js ==');
  ok('plausible BP ok', RallentaLogic.plausible('blood_pressure', { value_primary: 118, value_secondary: 76 }).ok);
  ok('plausible BP sys<dia fails', !RallentaLogic.plausible('blood_pressure', { value_primary: 70, value_secondary: 90 }).ok);
  ok('plausible BP range fails', !RallentaLogic.plausible('blood_pressure', { value_primary: 400, value_secondary: 90 }).ok);
  ok('plausible HR ok/fail', RallentaLogic.plausible('heart_rate', { value_primary: 62 }).ok &&
    !RallentaLogic.plausible('heart_rate', { value_primary: 500 }).ok);
  ok('plausible glucose', RallentaLogic.plausible('blood_sugar', { value_primary: 100 }, 'mg/dL').ok &&
    RallentaLogic.plausible('blood_sugar', { value_primary: 5.5 }, 'mmol/L').ok &&
    !RallentaLogic.plausible('blood_sugar', { value_primary: 50 }, 'mmol/L').ok &&
    !RallentaLogic.plausible('blood_sugar', { value_primary: 1000 }, 'mg/dL').ok);
  ok('plausible weight', RallentaLogic.plausible('weight', { value_primary: 198 }, 'lb').ok &&
    RallentaLogic.plausible('weight', { value_primary: 90 }, 'kg').ok &&
    !RallentaLogic.plausible('weight', { value_primary: 2000 }, 'lb').ok &&
    !RallentaLogic.plausible('weight', { value_primary: 10 }, 'kg').ok);
  ok('plausible bmi', RallentaLogic.plausible('bmi', { value_primary: 27 }).ok &&
    !RallentaLogic.plausible('bmi', { value_primary: 5 }).ok);
  ok('plausible sleep span', RallentaLogic.plausible('sleep', { spanMin: 540 }).ok &&
    !RallentaLogic.plausible('sleep', { spanMin: 1500 }).ok);
  const pFail = RallentaLogic.plausible('heart_rate', { value_primary: 9999 });
  ok('plausible message mechanical (no health words)',
    /check the number/i.test(pFail.message || '') &&
    !/normal|healthy|abnormal|diagnos/i.test(pFail.message || ''));

  const c1u = RallentaLogic.convert(180, 'mg/dL', 'mmol/L');
  ok('convert glucose 180->10', c1u.value === 10 && c1u.unit === 'mmol/L');
  const c2u = RallentaLogic.convert(5.5, 'mmol/L', 'mg/dL');
  ok('convert glucose reverse', c2u.value === 99 && c2u.unit === 'mg/dL');
  const c3u = RallentaLogic.convert(150, 'lb', 'kg');
  ok('convert weight lb->kg', near(c3u.value, 68.04, 0.005) && c3u.unit === 'kg');
  const c4u = RallentaLogic.convert(68.04, 'kg', 'lb');
  ok('convert weight reverse', near(c4u.value, 150, 0.01) && c4u.unit === 'lb');
  const c5u = RallentaLogic.convert(100, 'mg/dL', 'mg/dL');
  ok('convert identity', c5u.value === 100 && c5u.unit === 'mg/dL');
  let cRej = false;
  try { RallentaLogic.convert(1, 'bpm', 'kg'); } catch (e) { cRej = true; }
  ok('convert unsupported throws', cRej);

  const ds = RallentaLogic.deriveSleep({ bed_at: bed, wake_at: wake, latency_minutes: 20, awake_minutes: 15, quality: 4 });
  ok('deriveSleep cross-midnight', ds.inBedMin === 480 && ds.asleepMin === 445 && ds.assumptions.length >= 3);
  const dsFloor = RallentaLogic.deriveSleep({ bed_at: bed, wake_at: wake, latency_minutes: 500, awake_minutes: 60 });
  ok('deriveSleep floor 0', dsFloor.asleepMin === 0);
  const dsNoLog = RallentaLogic.deriveSleep({ bed_at: bed, wake_at: wake });
  ok('deriveSleep missing latency/awake assumptions',
    dsNoLog.asleepMin === 480 && dsNoLog.assumptions.some(a => /assumed 0/.test(a)));
  ok('deriveSleep perception note', ds.assumptions.some(a => /personal perception/.test(a)));

  ok('targetGap shortfall', RallentaLogic.targetGap(445, 480) === 35);
  ok('targetGap oversleep -> 0', RallentaLogic.targetGap(520, 480) === 0);

  // sleepDebt: entries on 0,1,3 days ago; target 480; day-0 short 35, day-1 overslept, day-3 short 60
  const mkSleep = (days, asleep) => ({ id: 't' + days, kind: 'sleep', metric_type: 'sleep',
    wake_at: daysAgo(days, 6, 30), derived_duration_min: asleep });
  const debt = RallentaLogic.sleepDebt([mkSleep(0, 445), mkSleep(1, 520), mkSleep(3, 420)], 480, 7);
  ok('sleepDebt window length', debt.days.length === 7);
  ok('sleepDebt no-entry day null', debt.days.filter(d => d.gapMin === null).length === 4);
  ok('sleepDebt total = sum of gaps only (extra sleep erases nothing)',
    debt.totalGapMin === 35 + 0 + 60, String(debt.totalGapMin));
  ok('sleepDebt latest date is today', debt.days[6].date === localISO(new Date()).slice(0, 10));

  const st = RallentaLogic.describeStats([62, 70, 58, 66]);
  ok('describeStats', st.n === 4 && near(st.avg, 64) && st.median === 64 && st.min === 58 && st.max === 70);
  const st0 = RallentaLogic.describeStats([]);
  ok('describeStats empty', st0.n === 0 && st0.avg === null && st0.median === null);

  console.log('== charts.js ==');
  const el1 = { innerHTML: '' };
  RallentaCharts.render(el1, { points: [{ t: 1, label: 'x', value: 1 }], unit: 'bpm' });
  ok('render empty state (<2 pts)', /Not enough entries/.test(el1.innerHTML) && !/<svg/.test(el1.innerHTML));
  const now = Date.now(), DAY = 86400000;
  const pts = [
    { t: now - 4 * DAY, label: 'Sep 23', value: 60 },
    { t: now - 3 * DAY, label: 'Sep 24', value: 62 },
    { t: now - 1 * DAY, label: 'Sep 26', value: 66 },  // 2-day gap -> line break
    { t: now - 0.0 * DAY, label: 'Sep 27', value: 64 }
  ];
  const el2 = { innerHTML: '' };
  RallentaCharts.render(el2, { points: pts, unit: 'bpm' });
  const svg = el2.innerHTML;
  ok('render svg produced', /<svg/.test(svg) && /role="img"/.test(svg) && /aria-label/.test(svg));
  ok('render gaps = breaks (2 path segments)', (svg.match(/<path /g) || []).length === 2,
    'paths=' + (svg.match(/<path /g) || []).length);
  ok('render dots for each point', (svg.match(/<circle /g) || []).length === 4);
  ok('render unit on axis + tooltips', svg.includes('bpm') && svg.includes('<title>'));
  ok('render neutral colors only', !/red|green|#f00|#0f0|#ff0000|#00ff00/i.test(svg) && svg.includes('#5b9dff'));
  const el3 = { innerHTML: '' };
  RallentaCharts.render(el3, { points: pts.slice(0, 2), unit: 'bpm', color: '#a78bfa' });
  ok('render custom color, no gap', /#a78bfa/.test(el3.innerHTML) && (el3.innerHTML.match(/<path /g) || []).length === 1);
  const el4 = { innerHTML: '' };
  RallentaCharts.table(el4, { points: pts, unit: 'bpm' });
  ok('table structure', /<table/.test(el4.innerHTML) && /<caption>/.test(el4.innerHTML) &&
    (el4.innerHTML.match(/<tr>/g) || []).length === 5 && /scope="col"/.test(el4.innerHTML));
  const el5 = { innerHTML: '' };
  RallentaCharts.table(el5, { points: [], unit: 'bpm' });
  ok('table empty state', /No entries to list/.test(el5.innerHTML));

  // camera-estimate entry_source
  const est = await RallentaDB.saveVital({ metric_type: 'heart_rate', value_primary: 72, unit: 'bpm', measured_at: localISO(new Date()), note: null, entry_source: 'camera-estimate' });
  ok('camera-estimate source saved', est.entry_source === 'camera-estimate');
  const man = await RallentaDB.saveVital({ metric_type: 'heart_rate', value_primary: 70, unit: 'bpm', measured_at: localISO(new Date()), note: null });
  ok('default source stays manual', man.entry_source === 'manual');
  await RallentaDB.deleteEntry(est.id); await RallentaDB.deleteEntry(man.id);

  console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
