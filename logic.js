/*
 * Rallenta Phase 1 MVP — derived-calculation layer.
 *
 * Pure functions only: no storage, no network, no analytics.
 * All outputs are mechanical/descriptive. Nothing here is medical advice
 * and no wording may imply diagnosis, health status, or causation.
 *
 * Exported API (exact contract names):
 *   RallentaLogic.plausible(metric_type, values, unit) -> {ok, message?}
 *   RallentaLogic.convert(value, fromUnit, toUnit) -> {value, unit}
 *   RallentaLogic.deriveSleep(entry) -> {inBedMin, asleepMin, assumptions}
 *   RallentaLogic.targetGap(asleepMin, targetMin) -> number
 *   RallentaLogic.sleepDebt(sleepEntries, targetMin, days) -> {totalGapMin, days}
 *   RallentaLogic.describeStats(values) -> {n, avg, median, min, max}
 */
(function (global) {
  'use strict';

  var PLAUSIBILITY_PROMPT =
    'That value is outside the range usually accepted by this field. ' +
    'Check the number and unit, or save it as entered.';

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function inRange(v, lo, hi) {
    return isFiniteNumber(v) && v >= lo && v <= hi;
  }

  var RallentaLogic = {

    // Mechanical plausibility bounds only. A failing check is never a
    // health judgment — the UI offers "Check again" / "Save as entered".
    plausible: function (metricType, values, unit) {
      var v = values || {};
      var fail = function () { return { ok: false, message: PLAUSIBILITY_PROMPT }; };
      switch (metricType) {
        case 'blood_pressure':
          if (!inRange(v.value_primary, 70, 300)) return fail();
          if (!inRange(v.value_secondary, 30, 200)) return fail();
          if (!(v.value_primary > v.value_secondary)) return fail();
          return { ok: true };
        case 'heart_rate':
          if (!inRange(v.value_primary, 25, 250)) return fail();
          return { ok: true };
        case 'blood_sugar':
          if (unit === 'mg/dL') {
            if (!inRange(v.value_primary, 20, 600)) return fail();
          } else if (unit === 'mmol/L') {
            if (!inRange(v.value_primary, 1.1, 33.3)) return fail();
          } else {
            return { ok: false, message: 'Blood sugar unit must be mg/dL or mmol/L.' };
          }
          return { ok: true };
        case 'weight':
          if (unit === 'lb') {
            if (!inRange(v.value_primary, 50, 1500)) return fail();
          } else if (unit === 'kg') {
            if (!inRange(v.value_primary, 22, 680)) return fail();
          } else {
            return { ok: false, message: 'Weight unit must be lb or kg.' };
          }
          return { ok: true };
        case 'bmi':
          if (!inRange(v.value_primary, 10, 100)) return fail();
          return { ok: true };
        case 'sleep': {
          // values: {spanMin} or {bed_at, wake_at}; span must be 0–24h.
          var spanMin = v.spanMin;
          if (spanMin === undefined && v.bed_at && v.wake_at) {
            spanMin = Math.round(
              (new Date(v.wake_at).getTime() - new Date(v.bed_at).getTime()) / 60000);
          }
          if (!isFiniteNumber(spanMin)) {
            return { ok: false, message: 'Sleep span could not be determined from bed/wake times.' };
          }
          if (spanMin < 0 || spanMin > 24 * 60) return fail();
          return { ok: true };
        }
        default:
          return { ok: false, message: 'Unknown metric_type: ' + metricType };
      }
    },

    // Unit conversion for comparison/display. Returns {value, unit}.
    // Never mutates its inputs; never silent — callers must show both values.
    convert: function (value, fromUnit, toUnit) {
      if (!isFiniteNumber(value)) throw new TypeError('value must be a finite number.');
      if (fromUnit === toUnit) return { value: value, unit: toUnit };
      var round = function (x, dp) {
        var f = Math.pow(10, dp);
        return Math.round(x * f) / f;
      };
      if (fromUnit === 'mg/dL' && toUnit === 'mmol/L') {
        return { value: round(value / 18, 1), unit: toUnit };
      }
      if (fromUnit === 'mmol/L' && toUnit === 'mg/dL') {
        return { value: round(value * 18, 0), unit: toUnit };
      }
      if (fromUnit === 'lb' && toUnit === 'kg') {
        return { value: round(value / 2.20462, 2), unit: toUnit };
      }
      if (fromUnit === 'kg' && toUnit === 'lb') {
        return { value: round(value * 2.20462, 2), unit: toUnit };
      }
      throw new TypeError('Unsupported conversion: ' + fromUnit + ' -> ' + toUnit);
    },

    // Estimated asleep duration from a sleep entry.
    // asleep = wake − bed − latency − awake, floored at zero.
    deriveSleep: function (entry) {
      var e = entry || {};
      var bed = new Date(e.bed_at).getTime();
      var wake = new Date(e.wake_at).getTime();
      if (isNaN(bed) || isNaN(wake)) throw new TypeError('bed_at/wake_at must be valid timestamps.');
      var inBedMin = Math.round((wake - bed) / 60000);
      var latency = isFiniteNumber(e.latency_minutes) ? e.latency_minutes : 0;
      var awake = isFiniteNumber(e.awake_minutes) ? e.awake_minutes : 0;
      var asleepMin = Math.max(0, inBedMin - latency - awake);
      var assumptions = [
        'Time between bed_at and wake_at is treated as time in bed (' + inBedMin + ' min).',
        'Latency (' + latency + ' min) and awake-after-onset (' + awake + ' min) are subtracted; result floored at 0.'
      ];
      if (e.latency_minutes === null || e.latency_minutes === undefined) {
        assumptions.push('Latency was not logged; assumed 0.');
      }
      if (e.awake_minutes === null || e.awake_minutes === undefined) {
        assumptions.push('Awake-after-onset was not logged; assumed 0.');
      }
      if (inBedMin < 0) {
        assumptions.push('Wake time is earlier than bed time — check that the dates are correct.');
      }
      if (e.quality !== undefined && e.quality !== null) {
        assumptions.push('Quality ' + e.quality + '/5 is your personal perception, not a measurement.');
      }
      assumptions.push('This is an estimate from your logged times, not a physiological measurement.');
      return { inBedMin: inBedMin, asleepMin: asleepMin, assumptions: assumptions };
    },

    // Daily target gap: how much a night fell short of the user's chosen
    // sleep target. Never negative.
    targetGap: function (asleepMin, targetMin) {
      if (!isFiniteNumber(asleepMin) || !isFiniteNumber(targetMin)) {
        throw new TypeError('asleepMin and targetMin must be finite numbers.');
      }
      return Math.max(0, targetMin - asleepMin);
    },

    // Rolling sleep-target gap estimate over the last `days` days
    // (ending today, local time). Extra sleep does NOT erase prior gaps:
    // totalGapMin is the sum of per-day gaps only.
    // Returns {totalGapMin, days:[{date:'YYYY-MM-DD', gapMin|null}]}.
    sleepDebt: function (sleepEntries, targetMin, days) {
      if (!isFiniteNumber(targetMin) || targetMin < 0) {
        throw new TypeError('targetMin must be a non-negative finite number.');
      }
      if (!(days === 7 || days === 14) && !isFiniteNumber(days)) {
        throw new TypeError('days must be a finite number (7 or 14 in MVP).');
      }
      var dateKey = function (d) {
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      };
      // Latest entry per calendar date wins (deterministic tie-break by id).
      var byDate = {};
      (sleepEntries || []).forEach(function (e) {
        if (!e || !e.wake_at) return;
        var d = new Date(e.wake_at);
        if (isNaN(d.getTime())) return;
        var key = dateKey(d);
        var asleep = isFiniteNumber(e.derived_duration_min)
          ? e.derived_duration_min
          : RallentaLogic.deriveSleep(e).asleepMin;
        var prev = byDate[key];
        if (!prev || e.wake_at > prev.wake_at ||
            (e.wake_at === prev.wake_at && String(e.id) > String(prev.id))) {
          byDate[key] = { wake_at: e.wake_at, id: e.id, asleepMin: asleep };
        }
      });
      var out = [];
      var total = 0;
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      for (var i = days - 1; i >= 0; i--) {
        var d = new Date(today.getTime() - i * 86400000);
        var key = dateKey(d);
        var rec = byDate[key];
        if (rec) {
          var gap = RallentaLogic.targetGap(rec.asleepMin, targetMin);
          out.push({ date: key, gapMin: gap });
          total += gap;
        } else {
          out.push({ date: key, gapMin: null });
        }
      }
      return { totalGapMin: total, days: out };
    },

    // Descriptive statistics over a number array. Empty -> nulls, not zeros.
    describeStats: function (values) {
      var nums = (values || []).filter(isFiniteNumber);
      var n = nums.length;
      if (n === 0) return { n: 0, avg: null, median: null, min: null, max: null };
      var sorted = nums.slice().sort(function (a, b) { return a - b; });
      var sum = nums.reduce(function (a, b) { return a + b; }, 0);
      var median = n % 2 === 1
        ? sorted[(n - 1) / 2]
        : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      return {
        n: n,
        avg: sum / n,
        median: median,
        min: sorted[0],
        max: sorted[n - 1]
      };
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RallentaLogic: RallentaLogic };
  }
  global.RallentaLogic = RallentaLogic;

})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
