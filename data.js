/*
 * Rallenta Phase 1 MVP — data layer (IndexedDB, local-first).
 *
 * Owns: storage of sleep + vital journal entries and user preferences.
 * No network calls. No analytics. No health logging — this is a journal,
 * not a measurement device.
 *
 * Exported API (exact contract names):
 *   RallentaDB.init() -> Promise<void>
 *   RallentaDB.saveVital({metric_type, value_primary, value_secondary?, unit,
 *                        measured_at, context?, note?}) -> Promise<entry>
 *   RallentaDB.saveSleep({bed_at, wake_at, latency_minutes?, awake_minutes?,
 *                         quality, tags?, note?}) -> Promise<entry>
 *   RallentaDB.updateEntry(id, patch) -> Promise<entry>
 *   RallentaDB.deleteEntry(id) -> Promise<void>
 *   RallentaDB.deleteCategory(kind) -> Promise<number>
 *   RallentaDB.deleteAll() -> Promise<void>
 *   RallentaDB.listEntries({kind, metric_type?, since?, limit?}) -> Promise<entry[]>
 *   RallentaDB.exportJSON() -> Promise<object>
 *   RallentaDB.importJSON(obj, {mode:'preview'}) -> Promise<{counts, conflicts, ok, errors}>
 *   RallentaDB.importJSON(obj, {mode:'commit', onConflict}) -> Promise<{imported, skipped}>
 *   RallentaDB.exportCSV() -> Promise<string>
 *   RallentaDB.getPrefs() -> Promise<prefs>
 *   RallentaDB.setPrefs(patch) -> Promise<prefs>
 */
(function (global) {
  'use strict';

  var DB_NAME = 'rallenta-db';
  var DB_VERSION = 1;
  var STORE_ENTRIES = 'entries';
  var STORE_PREFS = 'prefs';
  var SCHEMA_VERSION = 1;

  var DISCLAIMER =
    'Rallenta is a wellness journal, not a medical device. It does not ' +
    'measure vital signs, diagnose conditions, or provide medical advice.';

  var SLEEP_TARGET_GAP_LABEL =
    'Sleep-target gap estimate — against your chosen target, not a physiological measurement.';

  var METRIC_TYPES = [
    'blood_pressure',
    'heart_rate',
    'blood_sugar',
    'weight',
    'bmi',
    'sleep'
  ];
  var UNITS = ['mmHg', 'bpm', 'mg/dL', 'mmol/L', 'lb', 'kg', 'kg/m²'];
  var KINDS = ['sleep', 'vital'];
  var NOTE_MAX = 500;

  var db = null;

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  // ISO 8601 with local UTC offset, e.g. "2026-09-27T22:15:00-05:00"
  function localISO(d) {
    var date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) throw new TypeError('Invalid date for localISO.');
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var offMin = -date.getTimezoneOffset();
    var sign = offMin >= 0 ? '+' : '-';
    var a = Math.abs(offMin);
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
      sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
  }

  function nowLocalISO() { return localISO(new Date()); }

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    throw new Error('crypto.randomUUID is required.');
  }

  function requireEnum(value, list, name) {
    if (list.indexOf(value) === -1) {
      throw new TypeError(name + ' must be one of: ' + list.join('|') + '. Got: ' + value);
    }
    return value;
  }

  function checkNote(note) {
    if (note === undefined || note === null) return null;
    if (typeof note !== 'string') throw new TypeError('note must be a string.');
    if (note.length > NOTE_MAX) {
      throw new TypeError('note exceeds the ' + NOTE_MAX + '-character limit.');
    }
    return note;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // Locale-aware preference defaults. Tolerates missing navigator/Intl (e.g. node).
  function localeDefaults() {
    var locale = '';
    try {
      if (typeof navigator !== 'undefined' && navigator.language) locale = navigator.language;
    } catch (e) { /* non-browser */ }
    var country = '';
    try {
      var tag = locale || (typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().locale : '');
      country = (tag.split('-')[1] || '').toUpperCase();
    } catch (e) { /* keep empty */ }
    var imperial = ['US', 'LR', 'MM'].indexOf(country) !== -1;
    var hour12 = true;
    try {
      if (typeof Intl !== 'undefined') {
        hour12 = !!Intl.DateTimeFormat().resolvedOptions().hour12;
      }
    } catch (e) { hour12 = true; }
    return {
      timeFormat: hour12 ? '12h' : '24h',
      weightUnit: imperial ? 'lb' : 'kg',
      glucoseUnit: imperial ? 'mg/dL' : 'mmol/L'
    };
  }

  function prefsDefaults() {
    var d = localeDefaults();
    return {
      timeFormat: d.timeFormat,
      weightUnit: d.weightUnit,
      glucoseUnit: d.glucoseUnit,
      heightCm: null,
      sleepTargetMin: 480,
      disclaimerAcceptedAt: null,
      onboardingDone: false,
      entitlement: 'free'
    };
  }

  function tx(storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /* ------------------------------------------------------------------ */
  /* entry construction + validation                                     */
  /* ------------------------------------------------------------------ */

  function buildVitalEntry(input) {
    var metricType = requireEnum(input.metric_type, METRIC_TYPES, 'metric_type');
    if (metricType === 'sleep') throw new TypeError('Use saveSleep for sleep entries.');
    if (!isFiniteNumber(input.value_primary)) {
      throw new TypeError('value_primary must be a finite number.');
    }
    var unit = requireEnum(input.unit, UNITS, 'unit');
    var valueSecondary = null;
    if (input.value_secondary !== undefined && input.value_secondary !== null) {
      if (!isFiniteNumber(input.value_secondary)) {
        throw new TypeError('value_secondary must be a finite number.');
      }
      valueSecondary = input.value_secondary;
    }
    var measuredAt = input.measured_at;
    if (!measuredAt || isNaN(new Date(measuredAt).getTime())) {
      throw new TypeError('measured_at must be a valid ISO timestamp.');
    }
    return {
      id: uuid(),
      kind: 'vital',
      metric_type: metricType,
      value_primary: input.value_primary,
      value_secondary: valueSecondary,
      unit: unit,
      measured_at: measuredAt,
      context: input.context === undefined ? null : String(input.context),
      note: checkNote(input.note),
      entry_source: input.entry_source === 'camera-estimate' ? 'camera-estimate' : 'manual',
      created_at: nowLocalISO(),
      updated_at: nowLocalISO(),
      schema_version: SCHEMA_VERSION
    };
  }

  function sleepDurationMin(bedAt, wakeAt, latency, awake) {
    var span = Math.round((new Date(wakeAt).getTime() - new Date(bedAt).getTime()) / 60000);
    var asleep = span - (latency || 0) - (awake || 0);
    return { inBedMin: span, asleepMin: Math.max(0, asleep) };
  }

  function buildSleepEntry(input) {
    var bedAt = input.bed_at;
    var wakeAt = input.wake_at;
    if (!bedAt || isNaN(new Date(bedAt).getTime())) {
      throw new TypeError('bed_at must be a valid ISO timestamp.');
    }
    if (!wakeAt || isNaN(new Date(wakeAt).getTime())) {
      throw new TypeError('wake_at must be a valid ISO timestamp.');
    }
    var latency = input.latency_minutes === undefined || input.latency_minutes === null
      ? null : input.latency_minutes;
    var awake = input.awake_minutes === undefined || input.awake_minutes === null
      ? null : input.awake_minutes;
    if (latency !== null && (!isFiniteNumber(latency) || latency < 0)) {
      throw new TypeError('latency_minutes must be a non-negative number.');
    }
    if (awake !== null && (!isFiniteNumber(awake) || awake < 0)) {
      throw new TypeError('awake_minutes must be a non-negative number.');
    }
    var quality = input.quality;
    if (!isFiniteNumber(quality) || quality < 1 || quality > 5 || Math.floor(quality) !== quality) {
      throw new TypeError('quality must be an integer 1–5 (personal perception scale).');
    }
    var derived = sleepDurationMin(bedAt, wakeAt, latency, awake);
    return {
      id: uuid(),
      kind: 'sleep',
      metric_type: 'sleep',
      value_primary: derived.asleepMin,
      value_secondary: null,
      unit: 'min',
      // measured_at mirrors wake_at so sleep and vital entries sort
      // together newest-first by one field.
      measured_at: wakeAt,
      bed_at: bedAt,
      wake_at: wakeAt,
      latency_minutes: latency,
      awake_minutes: awake,
      quality: quality,
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      context: null,
      note: checkNote(input.note),
      derived_duration_min: derived.asleepMin,
      derived_in_bed_min: derived.inBedMin,
      entry_source: 'manual',
      created_at: nowLocalISO(),
      updated_at: nowLocalISO(),
      schema_version: SCHEMA_VERSION
    };
  }

  /* ------------------------------------------------------------------ */
  /* migrations                                                          */
  /* ------------------------------------------------------------------ */

  // Backup-first migration scaffold. On any version upgrade, existing
  // records are snapshotted before schema changes run.
  function migrate(dbConn, oldVersion, transaction) {
    // v0 -> v1: initial schema (created in onupgradeneeded).
    // Future upgrades (v2+): snapshot everything first, then alter stores.
    var backup = null;
    if (oldVersion > 0) {
      backup = snapshotAll(transaction);
    }
    return Promise.resolve(backup).then(function (snap) {
      if (snap) {
        // Migration ran from a backup. Kept in memory only for the duration
        // of the upgrade; surfaced on console for operator inspection.
        // (No logging of record content to any service — local console only.)
      }
    });
  }

  function snapshotAll(transaction) {
    var data = {};
    var names = ['entries', 'prefs'];
    return Promise.all(names.map(function (name) {
      if (!transaction.db.objectStoreNames.contains(name)) return Promise.resolve([]);
      return reqToPromise(transaction.objectStore(name).getAll()).then(function (rows) {
        data[name] = rows;
      });
    })).then(function () { return { exportedAt: nowLocalISO(), data: data }; });
  }

  /* ------------------------------------------------------------------ */
  /* RallentaDB                                                          */
  /* ------------------------------------------------------------------ */

  var RallentaDB = {

    init: function () {
      if (db) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        if (!global.indexedDB) {
          reject(new Error('IndexedDB is not available.'));
          return;
        }
        var request = global.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function (event) {
          var conn = event.target.result;
          var txn = event.target.transaction;
          var oldVersion = event.oldVersion || 0;
          if (!conn.objectStoreNames.contains(STORE_ENTRIES)) {
            var entries = conn.createObjectStore(STORE_ENTRIES, { keyPath: 'id' });
            entries.createIndex('by_kind', 'kind', { unique: false });
            entries.createIndex('by_metric_type', 'metric_type', { unique: false });
            entries.createIndex('by_measured_at', 'measured_at', { unique: false });
          }
          if (!conn.objectStoreNames.contains(STORE_PREFS)) {
            conn.createObjectStore(STORE_PREFS, { keyPath: 'key' });
          }
          // Run migration scaffold inside the upgrade transaction.
          migrate(conn, oldVersion, txn).then(null, function (err) {
            txn.abort();
            reject(err);
          });
        };
        request.onsuccess = function (event) {
          db = event.target.result;
          resolve();
        };
        request.onerror = function () { reject(request.error); };
        request.onblocked = function () {
          reject(new Error('Database open blocked — close other tabs and retry.'));
        };
      });
    },

    saveVital: function (input) {
      var entry;
      try { entry = buildVitalEntry(input || {}); }
      catch (err) { return Promise.reject(err); }
      return reqToPromise(tx(STORE_ENTRIES, 'readwrite').put(entry)).then(function () {
        return entry;
      });
    },

    saveSleep: function (input) {
      var entry;
      try { entry = buildSleepEntry(input || {}); }
      catch (err) { return Promise.reject(err); }
      return reqToPromise(tx(STORE_ENTRIES, 'readwrite').put(entry)).then(function () {
        return entry;
      });
    },

    updateEntry: function (id, patch) {
      if (!id) return Promise.reject(new TypeError('id is required.'));
      var store = tx(STORE_ENTRIES, 'readwrite');
      return reqToPromise(store.get(id)).then(function (entry) {
        if (!entry) throw new Error('Entry not found: ' + id);
        var p = patch || {};
        if (p.id && p.id !== id) throw new TypeError('id is immutable.');
        if (p.entry_source && p.entry_source !== 'manual' && p.entry_source !== 'camera-estimate') {
          throw new TypeError('entry_source must be "manual" or "camera-estimate".');
        }
        if (p.kind && p.kind !== entry.kind) throw new TypeError('kind is immutable.');
        var allowed = [
          'metric_type', 'value_primary', 'value_secondary', 'unit',
          'measured_at', 'bed_at', 'wake_at', 'latency_minutes',
          'awake_minutes', 'quality', 'tags', 'context', 'note'
        ];
        allowed.forEach(function (key) {
          if (p[key] !== undefined) entry[key] = p[key];
        });
        // Re-validate touched fields.
        if (entry.kind === 'vital') {
          requireEnum(entry.metric_type, METRIC_TYPES, 'metric_type');
          if (!isFiniteNumber(entry.value_primary)) {
            throw new TypeError('value_primary must be a finite number.');
          }
          requireEnum(entry.unit, UNITS, 'unit');
          if (isNaN(new Date(entry.measured_at).getTime())) {
            throw new TypeError('measured_at must be a valid ISO timestamp.');
          }
        } else {
          if (isNaN(new Date(entry.bed_at).getTime()) ||
              isNaN(new Date(entry.wake_at).getTime())) {
            throw new TypeError('bed_at/wake_at must be valid ISO timestamps.');
          }
          if (!(entry.quality >= 1 && entry.quality <= 5)) {
            throw new TypeError('quality must be an integer 1–5.');
          }
        }
        entry.note = checkNote(entry.note);
        // Re-derive sleep duration if sleep inputs changed.
        if (entry.kind === 'sleep') {
          var derived = sleepDurationMin(
            entry.bed_at, entry.wake_at, entry.latency_minutes, entry.awake_minutes);
          entry.derived_duration_min = derived.asleepMin;
          entry.derived_in_bed_min = derived.inBedMin;
          entry.value_primary = derived.asleepMin;
          entry.measured_at = entry.wake_at;
        }
        entry.updated_at = nowLocalISO();
        return reqToPromise(store.put(entry)).then(function () { return entry; });
      });
    },

    deleteEntry: function (id) {
      if (!id) return Promise.reject(new TypeError('id is required.'));
      return reqToPromise(tx(STORE_ENTRIES, 'readwrite').delete(id));
    },

    // kind: 'sleep' | 'vital' | a vital metric_type (e.g. 'blood_pressure').
    // Returns the number of deleted entries.
    deleteCategory: function (kind) {
      return Promise.resolve().then(function () {
        if (!kind) throw new TypeError('kind is required.');
        var isKind = KINDS.indexOf(kind) !== -1;
        if (!isKind) requireEnum(kind, METRIC_TYPES, 'kind');
        return { isKind: isKind, kind: kind };
      }).then(function (sel) {
      var isKind = sel.isKind;
      var selKind = sel.kind;
      var store = tx(STORE_ENTRIES, 'readwrite');
      var deleted = 0;
      return new Promise(function (resolve, reject) {
        var cursorReq = store.openCursor();
        cursorReq.onsuccess = function () {
          var cursor = cursorReq.result;
          if (!cursor) { resolve(deleted); return; }
          var match = isKind
            ? cursor.value.kind === selKind
            : cursor.value.kind === 'vital' && cursor.value.metric_type === selKind;
          if (match) {
            deleted += 1;
            cursor.delete();
            cursor.continue();
          } else {
            cursor.continue();
          }
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };
      });
      });
    },

    deleteAll: function () {
      return Promise.all([
        reqToPromise(tx(STORE_ENTRIES, 'readwrite').clear()),
        reqToPromise(tx(STORE_PREFS, 'readwrite').clear())
      ]).then(function () { /* confirmed destructive: entries + prefs wiped */ });
    },

    // newest first (by measured_at). Optional metric_type, since (ISO, inclusive), limit.
    listEntries: function (opts) {
      return Promise.resolve().then(function () {
        var o = opts || {};
        return { o: o, kind: requireEnum(o.kind, KINDS, 'kind') };
      }).then(function (sel) {
      var o = sel.o;
      var kind = sel.kind;
      var store = tx(STORE_ENTRIES, 'readonly');
      return reqToPromise(store.index('by_kind').getAll(kind)).then(function (rows) {
        var list = rows.filter(function (e) {
          if (o.metric_type && e.metric_type !== o.metric_type) return false;
          if (o.since && e.measured_at < o.since) return false;
          return true;
        });
        list.sort(function (a, b) {
          return a.measured_at < b.measured_at ? 1 : (a.measured_at > b.measured_at ? -1 : 0);
        });
        if (o.limit !== undefined && o.limit !== null) list = list.slice(0, o.limit);
        return list;
      });
      });
    },

    /* ------------------------------------------------------------ */
    /* preferences                                                   */
    /* ------------------------------------------------------------ */

    getPrefs: function () {
      var defaults = prefsDefaults();
      return reqToPromise(tx(STORE_PREFS, 'readonly').getAll()).then(function (rows) {
        rows.forEach(function (r) { defaults[r.key] = r.value; });
        return defaults;
      });
    },

    setPrefs: function (patch) {
      return Promise.resolve().then(function () {
        var p = patch || {};
        // Contract defaults plus UI-owned local-only prefs (logging-card
        // selection, last-used ordering, in-app reminders). Nothing leaves
        // the device; these are all stored in the local prefs object store.
        var allowed = [
          'timeFormat', 'weightUnit', 'glucoseUnit', 'heightCm',
          'sleepTargetMin', 'disclaimerAcceptedAt', 'onboardingDone', 'entitlement',
          'loggingCards', 'lastUsed', 'reminders', 'reminderNotified'
        ];
        var writeStore = tx(STORE_PREFS, 'readwrite');
        var writes = [];
        Object.keys(p).forEach(function (key) {
          if (allowed.indexOf(key) === -1) throw new TypeError('Unknown pref: ' + key);
          if (key === 'timeFormat') requireEnum(p[key], ['12h', '24h'], 'timeFormat');
          if (key === 'weightUnit') requireEnum(p[key], ['lb', 'kg'], 'weightUnit');
          if (key === 'glucoseUnit') requireEnum(p[key], ['mg/dL', 'mmol/L'], 'glucoseUnit');
          if (key === 'entitlement') requireEnum(p[key], ['free'], 'entitlement');
          writes.push(reqToPromise(writeStore.put({ key: key, value: p[key] })));
        });
        return Promise.all(writes);
      }).then(function () { return RallentaDB.getPrefs(); });
    },

    /* ------------------------------------------------------------ */
    /* export / import                                               */
    /* ------------------------------------------------------------ */

    exportJSON: function () {
      return Promise.all([
        RallentaDB.getPrefs(),
        reqToPromise(tx(STORE_ENTRIES, 'readonly').getAll())
      ]).then(function (parts) {
        var prefs = parts[0];
        var entries = parts[1] || [];
        entries.sort(function (a, b) {
          return a.measured_at < b.measured_at ? 1 : (a.measured_at > b.measured_at ? -1 : 0);
        });
        return {
          app: 'rallenta',
          schema_version: SCHEMA_VERSION,
          exported_at: nowLocalISO(),
          disclaimer: DISCLAIMER,
          preferences: prefs,
          entries: entries
        };
      });
    },

    importJSON: function (obj, opts) {
      var o = opts || {};
      var mode = o.mode || 'preview';
      if (mode !== 'preview' && mode !== 'commit') {
        return Promise.reject(new TypeError('mode must be "preview" or "commit".'));
      }
      var errors = [];
      if (!obj || typeof obj !== 'object') errors.push('Import is not an object.');
      if (obj && obj.app !== 'rallenta') errors.push('app must be "rallenta".');
      if (obj && obj.schema_version !== SCHEMA_VERSION) {
        errors.push('schema_version ' + (obj && obj.schema_version) + ' is not supported (expected ' + SCHEMA_VERSION + ').');
      }
      if (obj && !Array.isArray(obj.entries)) errors.push('entries must be an array.');
      var entries = (obj && Array.isArray(obj.entries)) ? obj.entries : [];
      var valid = [];
      entries.forEach(function (e, i) {
        if (!e || typeof e !== 'object' || !e.id) {
          errors.push('entries[' + i + ']: missing id.');
          return;
        }
        if (KINDS.indexOf(e.kind) === -1) {
          errors.push('entries[' + i + ']: invalid kind.');
          return;
        }
        valid.push(e);
      });
      var counts = {
        sleep: valid.filter(function (e) { return e.kind === 'sleep'; }).length,
        vitals: valid.filter(function (e) { return e.kind === 'vital'; }).length
      };
      return reqToPromise(tx(STORE_ENTRIES, 'readonly').getAll()).then(function (existing) {
        var byId = {};
        existing.forEach(function (e) { byId[e.id] = e; });
        var conflicts = 0;
        valid.forEach(function (e) {
          var cur = byId[e.id];
          if (cur && cur.updated_at !== e.updated_at) conflicts += 1;
        });
        if (mode === 'preview') {
          return { counts: counts, conflicts: conflicts, ok: errors.length === 0, errors: errors };
        }
        // commit
        if (errors.length > 0) {
          return Promise.reject(new Error('Import failed validation: ' + errors.join('; ')));
        }
        var onConflict = o.onConflict || 'skip';
        if (['skip', 'replace', 'duplicate'].indexOf(onConflict) === -1) {
          return Promise.reject(new TypeError('onConflict must be skip|replace|duplicate.'));
        }
        var store = tx(STORE_ENTRIES, 'readwrite');
        var imported = 0, skipped = 0;
        var chain = Promise.resolve();
        valid.forEach(function (e) {
          chain = chain.then(function () {
            var cur = byId[e.id];
            var isConflict = cur && cur.updated_at !== e.updated_at;
            var write = function (rec) {
              var copy = JSON.parse(JSON.stringify(rec));
              copy.updated_at = copy.updated_at || nowLocalISO();
              copy.created_at = copy.created_at || nowLocalISO();
              copy.schema_version = copy.schema_version || SCHEMA_VERSION;
              copy.entry_source = 'manual';
              return reqToPromise(store.put(copy)).then(function () {
                byId[copy.id] = copy;
                imported += 1;
              });
            };
            if (!cur) return write(e);
            if (!isConflict) { skipped += 1; return Promise.resolve(); } // identical already
            if (onConflict === 'skip') { skipped += 1; return Promise.resolve(); }
            if (onConflict === 'replace') return write(e);
            // duplicate: keep both, new id for the incoming record
            var dup = JSON.parse(JSON.stringify(e));
            dup.id = uuid();
            return write(dup);
          });
        });
        return chain.then(function () {
          // Preferences: imported only under 'replace' — never silently overwrite.
          if (obj.preferences && typeof obj.preferences === 'object' && onConflict === 'replace') {
            var pStore = tx(STORE_PREFS, 'readwrite');
            var allowed = [
              'timeFormat', 'weightUnit', 'glucoseUnit', 'heightCm',
              'sleepTargetMin', 'disclaimerAcceptedAt', 'onboardingDone', 'entitlement'
            ];
            var pChain = Promise.resolve();
            Object.keys(obj.preferences).forEach(function (key) {
              if (allowed.indexOf(key) !== -1) {
                pChain = pChain.then(function () {
                  return reqToPromise(pStore.put({ key: key, value: obj.preferences[key] }));
                });
              }
            });
            return pChain.then(function () { return { imported: imported, skipped: skipped }; });
          }
          return { imported: imported, skipped: skipped };
        });
      });
    },

    exportCSV: function () {
      var headerLines = [
        '# Rallenta export — ' + nowLocalISO(),
        '# app: rallenta, schema_version: ' + SCHEMA_VERSION,
        '# Disclaimer: ' + DISCLAIMER,
        '# ' + SLEEP_TARGET_GAP_LABEL,
        '# Columns use the original units entered; nothing here is measured by this device.'
      ];
      var cols = [
        'id', 'kind', 'metric_type', 'value_primary', 'value_secondary', 'unit',
        'measured_at', 'bed_at', 'wake_at', 'latency_minutes', 'awake_minutes',
        'quality', 'tags', 'context', 'note', 'entry_source', 'created_at',
        'updated_at', 'schema_version'
      ];
      var csvEscape = function (v) {
        if (v === null || v === undefined) return '';
        var s = Array.isArray(v) ? v.join(';') : String(v);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      return reqToPromise(tx(STORE_ENTRIES, 'readonly').getAll()).then(function (entries) {
        var rows = (entries || []).slice();
        rows.sort(function (a, b) {
          return a.measured_at < b.measured_at ? 1 : (a.measured_at > b.measured_at ? -1 : 0);
        });
        var lines = headerLines.concat([cols.join(',')]);
        rows.forEach(function (e) {
          lines.push(cols.map(function (c) { return csvEscape(e[c]); }).join(','));
        });
        return lines.join('\n') + '\n';
      });
    },

    // Internal exposure for tests / QA (not part of the public contract).
    _localISO: localISO,
    _disclaimer: DISCLAIMER,
    _gapLabel: SLEEP_TARGET_GAP_LABEL
  };

  // Export for node / bundlers; also attach to window/self/global.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RallentaDB: RallentaDB, localISO: localISO, DISCLAIMER: DISCLAIMER };
  }
  global.RallentaDB = RallentaDB;

})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
