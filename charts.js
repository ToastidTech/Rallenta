/*
 * Rallenta Phase 1 MVP — chart layer.
 *
 * Accessible, dependency-free SVG line/dot charts + an HTML table
 * alternative for screen readers. Neutral colors only (blue/violet);
 * never red/green, never health-graded. No network, no analytics.
 *
 * Exported API (exact contract names):
 *   RallentaCharts.render(el, {points, unit, color})  // el.innerHTML is set
 *   RallentaCharts.table(el, {points, unit})
 *
 * points: [{t: ms epoch, label: display string, value: number}]
 * Gaps render as line breaks — values are never interpolated.
 */
(function (global) {
  'use strict';

  var DEFAULT_COLOR = '#5b9dff';
  var DOT_COLOR = '#a78bfa';
  var W = 640;
  var H = 260;
  var PAD = { l: 56, r: 16, t: 16, b: 40 };

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // Split sorted points into segments; a line break is drawn wherever the
  // gap between consecutive points exceeds 1.5x the smallest interval
  // (the typical logging cadence) — missing data is never interpolated.
  function segmentPoints(pts) {
    if (pts.length < 2) return [pts.slice()];
    var minDelta = Infinity;
    for (var i = 1; i < pts.length; i++) {
      var d = pts[i].t - pts[i - 1].t;
      if (d > 0 && d < minDelta) minDelta = d;
    }
    if (!isFinite(minDelta)) minDelta = 0;
    var threshold = Math.max(minDelta * 1.5, minDelta + 1);
    var segments = [[pts[0]]];
    for (var j = 1; j < pts.length; j++) {
      if (pts[j].t - pts[j - 1].t > threshold) segments.push([]);
      segments[segments.length - 1].push(pts[j]);
    }
    return segments;
  }

  function niceTicks(min, max, count) {
    if (!(isNum(min) && isNum(max)) || min === max) {
      min = isNum(min) ? min - 1 : 0;
      max = isNum(max) ? max + 1 : 1;
    }
    var span = max - min;
    var step = span / Math.max(count, 1);
    var mag = Math.pow(10, Math.floor(Math.log10(step)));
    var norm = step / mag;
    var nice = norm >= 5 ? 5 : (norm >= 2 ? 2 : 1);
    step = nice * mag;
    var ticks = [];
    for (var v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
      ticks.push(Math.round(v * 1e9) / 1e9);
    }
    if (ticks.length === 0) ticks = [min, max];
    return { ticks: ticks, min: min, max: max };
  }

  function fmtValue(v) {
    return Math.round(v * 100) / 100;
  }

  var RallentaCharts = {

    render: function (el, opts) {
      var o = opts || {};
      var unit = o.unit || '';
      var color = o.color || DEFAULT_COLOR;
      var raw = Array.isArray(o.points) ? o.points : [];
      var pts = raw
        .filter(function (p) { return p && isNum(p.t) && isNum(p.value); })
        .sort(function (a, b) { return a.t - b.t; });

      if (pts.length < 2) {
        el.innerHTML =
          '<p class="chart-empty" role="status">Not enough entries yet to draw a trend. ' +
          'Log at least two entries to see a chart.</p>';
        return;
      }

      var values = pts.map(function (p) { return p.value; });
      var vMin = Math.min.apply(null, values);
      var vMax = Math.max.apply(null, values);
      var tMin = pts[0].t;
      var tMax = pts[pts.length - 1].t;

      var y = niceTicks(vMin, vMax, 4);
      var x0 = PAD.l, x1 = W - PAD.r, y0 = PAD.t, y1 = H - PAD.b;
      var xSpan = (tMax - tMin) || 1;
      var ySpan = (y.max - y.min) || 1;
      var X = function (t) { return x0 + ((t - tMin) / xSpan) * (x1 - x0); };
      var Y = function (v) { return y1 - ((v - y.min) / ySpan) * (y1 - y0); };

      var svg = [];
      var ariaLabel = pts.length + ' logged entries' + (unit ? ', unit ' + unit : '') +
        ', from ' + pts[0].label + ' to ' + pts[pts.length - 1].label + '.';
      svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(ariaLabel) + '" ' +
        'preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">');
      svg.push('<title>' + esc(ariaLabel) + '</title>');

      // Y gridlines + unit-labeled axis
      y.ticks.forEach(function (t) {
        var yy = Y(t);
        svg.push('<line x1="' + x0 + '" y1="' + yy + '" x2="' + x1 + '" y2="' + yy + '" ' +
          'stroke="rgba(255,255,255,0.12)" stroke-width="1"/>');
        svg.push('<text x="' + (x0 - 8) + '" y="' + (yy + 4) + '" text-anchor="end" ' +
          'font-size="12" fill="#9aa3b2">' + esc(fmtValue(t)) + '</text>');
      });
      svg.push('<text x="14" y="' + (y0 + 10) + '" font-size="12" fill="#9aa3b2" ' +
        'transform="rotate(-90 14 ' + (y0 + 10) + ')" text-anchor="middle" dominant-baseline="middle">' +
        esc(unit) + '</text>');

      // X ticks: first, middle, last labels
      var xIdx = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
      xIdx.forEach(function (i) {
        var p = pts[i];
        svg.push('<text x="' + X(p.t) + '" y="' + (y1 + 22) + '" text-anchor="middle" ' +
          'font-size="12" fill="#9aa3b2">' + esc(p.label || '') + '</text>');
      });

      // Segments: line breaks at gaps (no interpolation).
      var segments = segmentPoints(pts);
      segments.forEach(function (seg) {
        if (seg.length > 1) {
          var d = seg.map(function (p, i) {
            return (i === 0 ? 'M' : 'L') + X(p.t).toFixed(1) + ' ' + Y(p.value).toFixed(1);
          }).join(' ');
          svg.push('<path d="' + d + '" fill="none" stroke="' + esc(color) + '" stroke-width="2.5" ' +
            'stroke-linejoin="round" stroke-linecap="round"/>');
        }
      });
      // Dots at every point (traceable to an entry), with native tooltips.
      pts.forEach(function (p) {
        var tip = (p.label || '') + ': ' + fmtValue(p.value) + (unit ? ' ' + unit : '');
        svg.push('<circle cx="' + X(p.t).toFixed(1) + '" cy="' + Y(p.value).toFixed(1) + '" r="4.5" ' +
          'fill="' + esc(DOT_COLOR) + '" stroke="#0b0e1a" stroke-width="1.5"><title>' + esc(tip) + '</title></circle>');
      });

      svg.push('</svg>');
      el.innerHTML = svg.join('\n');
    },

    table: function (el, opts) {
      var o = opts || {};
      var unit = o.unit || '';
      var raw = Array.isArray(o.points) ? o.points : [];
      var pts = raw
        .filter(function (p) { return p && isNum(p.t) && isNum(p.value); })
        .sort(function (a, b) { return a.t - b.t; });

      if (pts.length === 0) {
        el.innerHTML =
          '<p class="chart-empty" role="status">No entries to list yet.</p>';
        return;
      }

      var rows = pts.map(function (p) {
        return '<tr><td>' + esc(p.label || new Date(p.t).toLocaleString()) + '</td>' +
          '<td>' + esc(fmtValue(p.value)) + (unit ? ' ' + esc(unit) : '') + '</td></tr>';
      }).join('\n');
      el.innerHTML =
        '<table class="chart-table">' +
        '<caption>' + pts.length + ' logged entries' + (unit ? ' (' + esc(unit) + ')' : '') + '</caption>' +
        '<thead><tr><th scope="col">Time</th><th scope="col">Value</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RallentaCharts: RallentaCharts };
  }
  global.RallentaCharts = RallentaCharts;

})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
