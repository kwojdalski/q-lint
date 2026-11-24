// What a q-lint chart draws: the columns it plots, its data, and the
// Chart.js configuration, from a `grid.ts` Grid.
//
// The result panel (result.js) and the notebook chart renderer
// (chartrenderer.js) both draw with it, so a chart picks the same columns
// and labels the same axes in either. Nothing here touches the DOM or
// Chart.js itself: the theme arrives as values, read by the caller, and
// test/grid.test.js runs it under node. In a page it sets `qlintChart` on
// the global object.
//
// Beyond line, bar, scatter and histogram, the result panel draws an area,
// a step line and candles (#926): open, high, low and close columns found
// by name, or the first four it can plot. Candles are Chart.js's floating
// bars, a thin one from low to high under a wide one from open to close,
// so no financial plugin is needed. A series can go on a second y axis, on
// the right. `chartSvg` draws the same data as SVG, by hand, for a chart
// saved as a vector image.
(function (root) {
  "use strict";

  /// Bins a histogram starts with.
  const BINS = 20;

  /// The pixels a notebook chart is tall: its spec's `height` when it is a
  /// number in `/ @height`'s range (CHART_HEIGHT in celldirectives.ts), else
  /// `fallback`. The spec comes from the notebook file, which can hold
  /// anything: a string height went into the box's cssText whole, adding
  /// declarations that overlaid the page (#1834).
  function chartHeight(height, fallback) {
    const px = typeof height === "number" ? height : NaN;
    return Number.isFinite(px) && px >= 100 && px <= 2000 ? Math.round(px) : fallback;
  }

  /// A grid of one column - a list - is charted against its row numbers:
  /// its column is a series, not the x axis.
  function byRow(grid) {
    return grid.columns.length === 1;
  }

  /// The kinds drawn as a line: an area fills under it, a step holds each
  /// value until the next.
  const LINES = ["line", "area", "step"];

  /// The columns a candle chart draws, [open, high, low, close]: by name
  /// (open/o, high/h, low/l, close/c, any case), or else the first four
  /// columns it can plot, in order. Null when there are not four.
  function ohlcColumns(grid) {
    const can = chartable(grid, "candlestick");
    const names = [["open", "o"], ["high", "h"], ["low", "l"], ["close", "c"]];
    const found = names.map(function (alias) {
      const at = can.filter(function (c) { return alias.indexOf(grid.columns[c].name.toLowerCase()) >= 0; });
      return at.length ? at[0] : -1;
    });
    if (found.every(function (c) { return c >= 0; })) {
      return found;
    }
    return can.length >= 4 ? can.slice(0, 4) : null;
  }

  /// The columns a chart can plot: the numeric ones, and for every kind but
  /// a histogram not the first, which is the x axis, unless it is the only.
  function chartable(grid, kind) {
    const out = [];
    grid.columns.forEach(function (c, i) {
      if (c.numeric && (kind === "histogram" || i > 0 || byRow(grid))) {
        out.push(i);
      }
    });
    return out;
  }

  /// `bins` equal bins over the finite values of every series in `series`,
  /// sharing one range: {edges (bins + 1 of them), counts (one list per
  /// series)}. One value repeated makes one bin.
  function histogram(series, bins) {
    let lo = Infinity;
    let hi = -Infinity;
    series.forEach(function (values) {
      values.forEach(function (v) {
        if (v !== null && isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      });
    });
    if (lo > hi) {
      return { edges: [], counts: series.map(function () { return []; }) };
    }
    const n = lo === hi ? 1 : Math.max(1, Math.floor(bins));
    // A range past the largest double (-1e308 to 1e308) is binned in
    // halves, which cannot overflow; any other the same either way.
    const k = isFinite(hi - lo) ? 1 : 2;
    const width = (hi / k - lo / k) / n;
    const edges = [];
    for (let i = 0; i <= n; i++) {
      edges.push(i === n ? hi : k * (lo / k + i * width));
    }
    const counts = series.map(function (values) {
      const count = new Array(n).fill(0);
      values.forEach(function (v) {
        if (v !== null && isFinite(v)) {
          // A value on an edge (1.2 of 1, 1.05, ...) is in the bin above
          // it, though (1.2 - 1) / 0.05 rounds to 3.9999999999999996.
          count[width === 0 ? 0 : Math.min(n - 1, Math.floor((v / k - lo / k) / width + 1e-9))] += 1;
        }
      });
      return count;
    });
    return { edges: edges, counts: counts };
  }

  const pad = function (n, w) { return String(n).padStart(w || 2, "0"); };

  /// The temporal types q holds as whole units: month, date, minute, second.
  const WHOLE = [13, 14, 17, 18];

  /// How an axis writes a temporal column's value - its own unit since
  /// 2000.01.01, as grid.ts sends it - in q's notation, to the second; with
  /// `step`, the axis's distance between ticks, under a second apart, to
  /// the fraction of a second that tells them apart.
  function temporalLabel(type, v, step) {
    const day = 86400000;
    const stamp = function (ms, sep) {
      const d = new Date(946684800000 + ms);
      return d.getUTCFullYear() + "." + pad(d.getUTCMonth() + 1) + "." + pad(d.getUTCDate()) +
        (sep ? sep + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) : "");
    };
    const clock = function (s) {
      const neg = s < 0 ? "-" : "";
      s = Math.abs(s);
      return neg + pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(Math.floor(s) % 60);
    };
    // Units a second holds: nanoseconds, or milliseconds (a datetime's too).
    const per = { 12: 1e9, 15: 1e3, 16: 1e9, 19: 1e3 }[type];
    if (per && step > 0) {
      const u = type === 15 ? v * day : v;
      const s = type === 15 ? step * day : step;
      let digits = Math.max(0, Math.ceil(-Math.log10(s / per) - 1e-9));
      const max = Math.round(Math.log10(per));
      while (digits > 0 && digits < max && Math.abs(s / (per / Math.pow(10, digits)) - Math.round(s / (per / Math.pow(10, digits)))) > 1e-6) {
        digits += 1;
      }
      digits = Math.min(digits, max);
      if (digits > 0) {
        // The whole seconds, written as before, and the fraction rounded to
        // its digits, carried into the seconds at a whole one.
        const q = per / Math.pow(10, digits);
        const neg = (type === 16 || type === 19) && u < 0;
        const mag = neg ? -u : u;
        const f = ((mag % per) + per) % per;
        let n = Math.round(f / q);
        let whole = Math.round((mag - f) / per);
        if (n * q >= per) {
          n = 0;
          whole += 1;
        }
        const fraction = "." + String(n).padStart(digits, "0");
        if (type === 12 || type === 15) {
          return stamp(whole * 1000, type === 12 ? "D" : "T") + fraction;
        }
        return (neg ? "-" : "") + temporalLabel(type, whole * per) + fraction;
      }
    }
    switch (type) {
      case 12: return stamp(v / 1e6, "D");
      case 13: v = Math.floor(v); return (2000 + Math.floor(v / 12)) + "." + pad(((v % 12) + 12) % 12 + 1);
      case 14: return stamp(v * day);
      case 15: return stamp(v * day, "T");
      case 16: return (v < 0 ? "-" : "") + Math.floor(Math.abs(v) / 864e11) + "D" + clock((Math.abs(v) % 864e11) / 1e9);
      case 17: return clock(v * 60).slice(0, -3);
      case 18: return clock(v);
      case 19: return clock(v / 1000);
      default: return String(v);
    }
  }

  /// A number short enough for an axis or a bin label.
  /// With `step`, the distance to the next label, the digits that tell the
  /// two apart, so bins over a narrow range of prices are not all
  /// "1.08341 - 1.08341".
  function short(v, step) {
    const digits = step > 0 && v !== 0 ? Math.min(15, Math.max(6, Math.ceil(Math.log10(Math.abs(v) / step)) + 2)) : 6;
    return Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(step > 0 ? Math.max(3, digits - 1) : 3) : String(+v.toPrecision(digits));
  }

  /// What a chart of `kind` over `rows` of the grid draws, before colours:
  /// {type, labels?, datasets: [{label, data}], note?}. `columns` are the
  /// y columns, as chartable() gives them; `bins` is for a histogram.
  function chartData(grid, rows, kind, columns, bins) {
    if (columns.length === 0 && kind !== "candlestick") {
      return { type: "bar", datasets: [], note: "No numeric column to chart" + (kind === "histogram" ? "." : " against the first.") };
    }
    const values = function (c) {
      return rows.map(function (r) { return grid.values[c][r]; });
    };
    const name = function (c) { return grid.columns[c].name; };
    if (kind === "histogram") {
      const h = histogram(columns.map(values), bins);
      const step = h.edges.length > 1 ? Math.abs(h.edges[1] - h.edges[0]) : 0;
      const labels = h.edges.slice(1).map(function (e, i) { return short(h.edges[i], step) + " - " + short(e, step); });
      return {
        type: "bar",
        labels: labels,
        datasets: columns.map(function (c, i) { return { label: name(c), column: c, data: h.counts[i] }; }),
      };
    }
    if (kind === "candlestick") {
      const ohlc = ohlcColumns(grid);
      if (!ohlc) {
        return { type: "bar", datasets: [], note: "A candle chart needs open, high, low and close columns: four numeric columns after the first." };
      }
      const v = function (c, r) { return grid.values[c][r]; };
      // A row missing any of the four draws no candle.
      const whole = function (r) { return ohlc.every(function (c) { return v(c, r) !== null; }); };
      const name = function (c) { return grid.columns[c].name; };
      return {
        type: "bar",
        labels: rows.map(function (r) { return byRow(grid) ? String(r) : grid.cells[0][r]; }),
        ohlc: ohlc,
        datasets: [
          { label: name(ohlc[2]) + " - " + name(ohlc[1]), column: ohlc[1], wick: true, data: rows.map(function (r) { return whole(r) ? [v(ohlc[2], r), v(ohlc[1], r)] : null; }) },
          { label: name(ohlc[0]) + " - " + name(ohlc[3]), column: ohlc[3], data: rows.map(function (r) { return whole(r) ? [v(ohlc[0], r), v(ohlc[3], r)] : null; }) },
        ],
      };
    }
    if (kind === "scatter") {
      const xs = byRow(grid) ? null : grid.values[0];
      return {
        type: "scatter",
        datasets: columns.map(function (c) {
          const data = [];
          rows.forEach(function (r) {
            const x = xs ? xs[r] : r;
            const y = grid.values[c][r];
            if (x !== null && y !== null) {
              data.push({ x: x, y: y, row: r });
            }
          });
          return { label: name(c), column: c, data: data };
        }),
      };
    }
    return {
      type: kind === "bar" ? "bar" : "line",
      labels: rows.map(function (r) { return byRow(grid) ? String(r) : grid.cells[0][r]; }),
      datasets: columns.map(function (c) { return { label: name(c), column: c, data: values(c) }; }),
    };
  }

  /// The editor's theme as a chart uses it, read through `cssVar(name,
  /// fallback)`: series colours from `--vscode-charts-*`, text, grid lines
  /// and font.
  function theme(cssVar) {
    return {
      colours: ["blue", "orange", "green", "red", "purple", "yellow"].map(function (c, i) {
        return cssVar("--vscode-charts-" + c, ["#3794ff", "#d18616", "#89d185", "#f14c4c", "#b180d7", "#cca700"][i]);
      }),
      foreground: cssVar("--vscode-foreground", "#ccc"),
      border: cssVar("--vscode-panel-border", "rgba(128,128,128,0.35)"),
      font: cssVar("--vscode-font-family", "sans-serif"),
      // A candle that closed up, and one that closed down.
      up: cssVar("--vscode-charts-green", "#89d185"),
      down: cssVar("--vscode-charts-red", "#f14c4c"),
    };
  }

  /// Point Chart.js's defaults at `look`, a theme(): its text, grid lines
  /// and font are read from there, not from one chart's options.
  function applyTheme(Chart, look) {
    Chart.defaults.color = look.foreground;
    Chart.defaults.borderColor = look.border;
    Chart.defaults.font.family = look.font;
  }

  /// The Chart.js configuration for `data`, a chartData() of `kind` over
  /// `rows` of the grid, coloured from `look`, a theme(), with `title` above
  /// it when given. `options.y2`: the column drawn on a second y axis, on
  /// the right.
  function chartConfig(grid, rows, kind, data, look, title, options) {
    if (kind === "candlestick") {
      return candleConfig(grid, rows, data, look, title);
    }
    const y2 = options && Number.isInteger(options.y2) && kind !== "histogram" ? options.y2 : -1;
    const second = y2 >= 0 && data.datasets.some(function (d) { return d.column === y2; });
    const line = LINES.indexOf(kind) >= 0;
    const x = grid.columns[0];
    // The x axis is the rows' numbers: a list's, or a scatter's whose first
    // column has no values to plot.
    const rowAxis = byRow(grid) || (kind === "scatter" && !grid.values[0]);
    // A long line has no points, only segments - but a value with a null
    // (a gap) on each side has no segment either, and gets a point.
    const isolated = function (ctx) {
      const d = ctx.dataset.data;
      const i = ctx.dataIndex;
      return d[i] !== null && (i === 0 || d[i - 1] === null) && (i === d.length - 1 || d[i + 1] === null) ? 2 : 0;
    };
    const translucent = function (colour) { return /^#[0-9a-f]{6}$/i.test(colour) ? colour + "99" : colour; };
    return {
      type: data.type,
      data: {
        labels: data.labels,
        datasets: data.datasets.map(function (d, i) {
          const colour = look.colours[i % look.colours.length];
          return Object.assign({}, d, {
            borderColor: colour,
            backgroundColor: kind === "line" || kind === "step" ? colour : translucent(colour),
            pointRadius: line ? (rows.length > 200 ? isolated : 2) : 3,
            borderWidth: kind === "bar" || kind === "histogram" ? 0 : 1.5,
            spanGaps: false,
          }, kind === "area" ? { fill: "origin" } : {}, kind === "step" ? { stepped: true } : {}, second && d.column === y2 ? { yAxisID: "y2" } : {});
        }),
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: kind === "scatter" ? "nearest" : "index", intersect: false },
        scales: {
          x: {
            title: { display: kind !== "histogram", text: rowAxis ? "row" : x.name },
            type: kind === "scatter" ? "linear" : "category",
            // A month, date, minute or second is a whole number: a tick
            // between two would repeat one's label, or name no month.
            // So is a row number.
            ticks: kind === "scatter" && rowAxis
              ? { precision: 0 }
              : kind === "scatter" && x.temporal
                ? Object.assign({ callback: function (v, i, ticks) { return temporalLabel(x.type, v, ticks && ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : 0); } }, WHOLE.indexOf(x.type) >= 0 ? { precision: 0 } : {})
                : { autoSkip: true, maxRotation: 0 },
          },
          // And a count.
          y: Object.assign({ title: { display: kind === "histogram" || second, text: kind === "histogram" ? "count" : data.datasets.filter(function (d) { return d.column !== y2; }).map(function (d) { return d.label; }).join(", ") } }, kind === "histogram" ? { ticks: { precision: 0 } } : {}),
          y2: second ? { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: grid.columns[y2].name } } : { display: false },
        },
        plugins: {
          title: { display: Boolean(title), text: title || "" },
          // A point says its cell, as the grid shows it: Chart.js would write
          // the nearest double with three decimals at most.
          tooltip: kind === "scatter"
            ? { callbacks: { label: function (ctx) { const r = ctx.raw.row; return ctx.dataset.label + ": " + (byRow(grid) ? String(r) : grid.cells[0][r]) + ", " + grid.cells[ctx.dataset.column][r]; } } }
            : kind === "histogram"
              ? {}
              : { callbacks: { label: function (ctx) { return ctx.dataset.label + ": " + grid.cells[ctx.dataset.column][rows[ctx.dataIndex]]; } } },
        },
      },
    };
  }

  /// Candles as Chart.js floating bars: each row's wick from low to high,
  /// thin, and its body from open to close, wide, over it; green where it
  /// closed at or above its open, red below. A tooltip gives the four cells.
  function candleConfig(grid, rows, data, look, title) {
    const ohlc = data.ohlc;
    const up = look.up || "#89d185";
    const down = look.down || "#f14c4c";
    const colours = rows.map(function (r) {
      const o = grid.values[ohlc[0]][r];
      const c = grid.values[ohlc[3]][r];
      return o !== null && c !== null && c < o ? down : up;
    });
    return {
      type: "bar",
      data: {
        labels: data.labels,
        datasets: data.datasets.map(function (d) {
          return Object.assign({}, d, {
            backgroundColor: colours,
            borderColor: colours,
            borderWidth: 0,
            grouped: false,
            barPercentage: d.wick ? 0.12 : 0.7,
            categoryPercentage: 1,
            order: d.wick ? 2 : 1,
          });
        }),
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { title: { display: true, text: byRow(grid) ? "row" : grid.columns[0].name }, ticks: { autoSkip: true, maxRotation: 0 } },
          // Prices: the axis spans the candles, not down to zero as bars'.
          y: { beginAtZero: false, title: { display: false } },
        },
        plugins: {
          title: { display: Boolean(title), text: title || "" },
          legend: { display: false },
          tooltip: {
            filter: function (item) { return !item.dataset.wick; },
            callbacks: {
              label: function (ctx) {
                const r = rows[ctx.dataIndex];
                return ["open", "high", "low", "close"].map(function (k, i) { return k + " " + grid.cells[ohlc[i]][r]; }).join("  ");
              },
            },
          },
        },
      },
    };
  }

  /// Text as SVG character data. A control character XML 1.0 forbids (FIX's
  /// SOH separator, say) becomes U+FFFD, or no parser reads the file.
  function xml(text) {
    return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "\uFFFD")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /// About five round steps from `lo` to `hi`: the ticks of an axis.
  /// `whole`: the axis is in whole units (a date's days), so a step is one
  /// at least and every tick a whole one.
  function ticks(lo, hi, whole) {
    // A range within a few ulps of its ends (0.3 and 0.1+0.2) is one value:
    // a step that small would not move `v` on. 50 ms of timestamps, or
    // 1e12 to 1e12+60, is a range.
    if (!(hi - lo > Math.max(Math.abs(lo), Math.abs(hi)) * (64 * Number.EPSILON))) {
      const d = Math.abs(lo) || 1;
      lo -= d / 2;
      hi += d / 2;
    }
    // In fifths, so a range past the largest double (-1e308 to 1e308)
    // cannot overflow.
    const raw = hi / 5 - lo / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const round = [1, 2, 5, 10].map(function (m) { return m * mag; }).filter(function (s) { return s >= raw; })[0];
    const step = whole ? Math.max(1, round) : round;
    // Enough digits to tell one tick from the next, far from zero.
    const digits = Math.min(17, Math.max(12, Math.ceil(Math.log10(Math.max(Math.abs(lo), Math.abs(hi)) / step)) + 2));
    const out = [];
    for (let v = Math.floor(lo / step) * step; out.length < 50 && isFinite(v) && v - step / 2 <= hi; v += step) {
      out.push(+v.toPrecision(digits));
    }
    return out.length > 0 ? { values: out, step: step } : { values: [lo, hi], step: hi - lo };
  }

  /// The chart chartData() describes as an SVG document, drawn here rather
  /// than by Chart.js, so it is vector graphics: axes with round ticks, each
  /// series as a line (filled for an area, stepped for a step), bars,
  /// points or candles, a legend, and `opts.title`. `opts`: {width, height,
  /// background, y2, title}. A null value leaves a gap.
  function chartSvg(grid, rows, kind, data, look, opts) {
    opts = opts || {};
    const W = opts.width || 800;
    const H = opts.height || 450;
    const font = xml(look.font || "sans-serif");
    const fg = look.foreground || "#333";
    const border = look.border || "#ccc";
    const y2 = Number.isInteger(opts.y2) && kind !== "histogram" && kind !== "candlestick" && data.datasets.some(function (d) { return d.column === opts.y2; }) ? opts.y2 : -1;
    const left = 64;
    const right = y2 >= 0 ? 64 : 20;
    const top = opts.title ? 40 : 16;
    const bottom = 64;
    const pw = W - left - right;
    const ph = H - top - bottom;
    const out = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" font-family="' + font + '" font-size="11">',
    ];
    if (opts.background) {
      out.push('<rect width="100%" height="100%" fill="' + xml(opts.background) + '"/>');
    }
    if (opts.title) {
      out.push('<text x="' + W / 2 + '" y="22" text-anchor="middle" font-size="14" fill="' + xml(fg) + '">' + xml(opts.title) + "</text>");
    }
    if (data.note || data.datasets.length === 0) {
      out.push('<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle" fill="' + xml(fg) + '">' + xml(data.note || "Nothing to chart.") + "</text></svg>");
      return out.join("\n");
    }
    // Every value a y axis spans: a candle's and a floating bar's both ends.
    const span = function (sets) {
      let lo = Infinity;
      let hi = -Infinity;
      sets.forEach(function (d) {
        d.data.forEach(function (p) {
          const vs = p === null ? [] : Array.isArray(p) ? p : typeof p === "object" ? [p.y] : [p];
          vs.forEach(function (v) {
            if (v !== null && isFinite(v)) {
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
          });
        });
      });
      if (kind === "bar" || kind === "histogram" || kind === "area") {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      return lo > hi ? { lo: 0, hi: 1 } : { lo: lo, hi: hi };
    };
    const axis = function (sets) {
      const s = span(sets);
      const t = ticks(s.lo, s.hi);
      const lo = Math.min(s.lo, t.values[0]);
      const hi = Math.max(s.hi, t.values[t.values.length - 1]);
      // Halved, so a span past the largest double does not overflow.
      return { ticks: t, y: function (v) { return top + ph - (hi === lo ? ph / 2 : ((v / 2 - lo / 2) / (hi / 2 - lo / 2)) * ph); } };
    };
    const main = axis(data.datasets.filter(function (d) { return d.column !== y2; }));
    const alt = y2 >= 0 ? axis(data.datasets.filter(function (d) { return d.column === y2; })) : null;
    const yOf = function (d) { return d.column === y2 && alt ? alt.y : main.y; };
    // Gridlines and the left axis's labels; the right axis's labels.
    main.ticks.values.forEach(function (v) {
      const y = main.y(v).toFixed(1);
      out.push('<line x1="' + left + '" x2="' + (left + pw) + '" y1="' + y + '" y2="' + y + '" stroke="' + xml(border) + '" stroke-width="0.5"/>');
      out.push('<text x="' + (left - 6) + '" y="' + y + '" dy="0.32em" text-anchor="end" fill="' + xml(fg) + '">' + xml(short(v, main.ticks.step)) + "</text>");
    });
    if (alt) {
      alt.ticks.values.forEach(function (v) {
        out.push('<text x="' + (left + pw + 6) + '" y="' + alt.y(v).toFixed(1) + '" dy="0.32em" fill="' + xml(fg) + '">' + xml(short(v, alt.ticks.step)) + "</text>");
      });
    }
    out.push('<rect x="' + left + '" y="' + top + '" width="' + pw + '" height="' + ph + '" fill="none" stroke="' + xml(border) + '"/>');
    // The x axis: categories (labels) or, for a scatter, numbers.
    let xOf;
    const n = data.labels ? data.labels.length : 0;
    if (kind === "scatter") {
      let lo = Infinity;
      let hi = -Infinity;
      data.datasets.forEach(function (d) { d.data.forEach(function (p) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }); });
      if (lo > hi) {
        lo = 0;
        hi = 1;
      }
      const x0 = grid.columns[0];
      const t = ticks(lo, hi, x0 && x0.temporal && WHOLE.indexOf(x0.type) >= 0);
      const a = Math.min(lo, t.values[0]);
      const b = Math.max(hi, t.values[t.values.length - 1]);
      xOf = function (x) { return left + (b === a ? pw / 2 : ((x / 2 - a / 2) / (b / 2 - a / 2)) * pw); };
      t.values.forEach(function (v) {
        const label = x0 && x0.temporal && grid.columns.length > 1 ? temporalLabel(x0.type, v, t.step) : short(v, t.step);
        out.push('<text x="' + xOf(v).toFixed(1) + '" y="' + (top + ph + 16) + '" text-anchor="middle" fill="' + xml(fg) + '">' + xml(label) + "</text>");
      });
    } else {
      const band = n > 0 ? pw / n : pw;
      xOf = function (i) { return left + band * (i + 0.5); };
      const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 90))));
      for (let i = 0; i < n; i += every) {
        out.push('<text x="' + xOf(i).toFixed(1) + '" y="' + (top + ph + 16) + '" text-anchor="middle" fill="' + xml(fg) + '">' + xml(data.labels[i]) + "</text>");
      }
    }
    const colour = function (i) { return look.colours[i % look.colours.length]; };
    const band = n > 0 ? pw / n : pw;
    if (kind === "candlestick") {
      const ohlc = data.ohlc;
      rows.forEach(function (r, i) {
        const o = grid.values[ohlc[0]][r];
        const h = grid.values[ohlc[1]][r];
        const l = grid.values[ohlc[2]][r];
        const c = grid.values[ohlc[3]][r];
        if ([o, h, l, c].some(function (v) { return v === null; })) {
          return;
        }
        const fill = xml(c < o ? look.down || "#f14c4c" : look.up || "#89d185");
        const x = xOf(i);
        const w = Math.max(1, band * 0.7);
        out.push('<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + main.y(h).toFixed(1) + '" y2="' + main.y(l).toFixed(1) + '" stroke="' + fill + '"/>');
        const yt = main.y(Math.max(o, c));
        out.push('<rect x="' + (x - w / 2).toFixed(1) + '" y="' + yt.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(1, main.y(Math.min(o, c)) - yt).toFixed(1) + '" fill="' + fill + '"/>');
      });
    } else if (kind === "bar" || kind === "histogram") {
      const k = data.datasets.length;
      const w = (band * 0.8) / k;
      data.datasets.forEach(function (d, j) {
        const y = yOf(d);
        d.data.forEach(function (v, i) {
          if (v === null || !isFinite(v)) {
            return;
          }
          const x = left + band * i + band * 0.1 + w * j;
          const a = y(Math.max(v, 0));
          out.push('<rect x="' + x.toFixed(1) + '" y="' + a.toFixed(1) + '" width="' + Math.max(0.5, w).toFixed(1) + '" height="' + Math.max(0, y(Math.min(v, 0)) - a).toFixed(1) + '" fill="' + xml(colour(j)) + '"/>');
        });
      });
    } else if (kind === "scatter") {
      data.datasets.forEach(function (d, j) {
        const y = yOf(d);
        d.data.forEach(function (p) {
          out.push('<circle cx="' + xOf(p.x).toFixed(1) + '" cy="' + y(p.y).toFixed(1) + '" r="2.5" fill="' + xml(colour(j)) + '"/>');
        });
      });
    } else {
      data.datasets.forEach(function (d, j) {
        const y = yOf(d);
        // Runs of values between nulls, each its own path.
        const runs = [];
        let run = [];
        d.data.forEach(function (v, i) {
          if (v === null || !isFinite(v)) {
            if (run.length) {
              runs.push(run);
            }
            run = [];
          } else {
            run.push([xOf(i), y(v)]);
          }
        });
        if (run.length) {
          runs.push(run);
        }
        runs.forEach(function (pts) {
          let path = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
          for (let i = 1; i < pts.length; i++) {
            path += kind === "step" ? " H" + pts[i][0].toFixed(1) + " V" + pts[i][1].toFixed(1) : " L" + pts[i][0].toFixed(1) + " " + pts[i][1].toFixed(1);
          }
          if (kind === "area") {
            const base = y(0).toFixed(1);
            out.push('<path d="' + path + " L" + pts[pts.length - 1][0].toFixed(1) + " " + base + " L" + pts[0][0].toFixed(1) + " " + base + ' Z" fill="' + xml(colour(j)) + '" fill-opacity="0.35" stroke="none"/>');
          }
          out.push('<path d="' + path + '" fill="none" stroke="' + xml(colour(j)) + '" stroke-width="1.5"/>');
          if (pts.length === 1) {
            out.push('<circle cx="' + pts[0][0].toFixed(1) + '" cy="' + pts[0][1].toFixed(1) + '" r="2" fill="' + xml(colour(j)) + '"/>');
          }
        });
      });
    }
    // The x axis's title and the legend, under it.
    const xTitle = kind === "histogram" ? "" : byRow(grid) || (kind === "scatter" && !grid.values[0]) ? "row" : grid.columns[0].name;
    if (xTitle) {
      out.push('<text x="' + (left + pw / 2) + '" y="' + (top + ph + 34) + '" text-anchor="middle" fill="' + xml(fg) + '">' + xml(xTitle) + "</text>");
    }
    if (kind !== "candlestick") {
      let lx = left;
      data.datasets.forEach(function (d, j) {
        const label = d.label + (d.column === y2 ? " (right)" : "");
        out.push('<rect x="' + lx + '" y="' + (H - 16) + '" width="10" height="10" fill="' + xml(colour(j)) + '"/>');
        out.push('<text x="' + (lx + 14) + '" y="' + (H - 7) + '" fill="' + xml(fg) + '">' + xml(label) + "</text>");
        lx += 24 + label.length * 6.5;
      });
    }
    out.push("</svg>");
    return out.join("\n");
  }

  /// What a chart drew, for the extension to read back: its kind, each
  /// series' name and points, and the note shown instead when it drew none.
  function summary(kind, data) {
    const out = {
      kind: kind,
      datasets: data.datasets.map(function (d) { return { label: d.label, points: d.data.length }; }),
    };
    if (data.note) {
      out.note = data.note;
    }
    return out;
  }

  const helpers = {
    BINS: BINS,
    chartable: chartable,
    histogram: histogram,
    temporalLabel: temporalLabel,
    chartData: chartData,
    theme: theme,
    applyTheme: applyTheme,
    chartConfig: chartConfig,
    chartHeight: chartHeight,
    summary: summary,
    ohlcColumns: ohlcColumns,
    chartSvg: chartSvg,
    ticks: ticks,
    WHOLE: WHOLE,
    short: short,
    xml: xml,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  } else {
    root.qlintChart = helpers;
  }
})(typeof self !== "undefined" ? self : this);
