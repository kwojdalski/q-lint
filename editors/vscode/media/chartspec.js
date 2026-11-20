// What a q-lint chart draws: the columns it plots, its data, and the
// Chart.js configuration, from a `grid.ts` Grid.
//
// The result panel (result.js) and the notebook chart renderer
// (chartrenderer.js) both draw with it, so a chart picks the same columns
// and labels the same axes in either. Nothing here touches the DOM or
// Chart.js itself: the theme arrives as values, read by the caller, and
// test/grid.test.js runs it under node. In a page it sets `qlintChart` on
// the global object.
(function (root) {
  "use strict";

  /// Bins a histogram starts with.
  const BINS = 20;

  /// The columns a chart can plot: the numeric ones, and for every kind but
  /// a histogram not the first, which is the x axis.
  function chartable(grid, kind) {
    const out = [];
    grid.columns.forEach(function (c, i) {
      if (c.numeric && (kind === "histogram" || i > 0)) {
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
    const width = (hi - lo) / n;
    const edges = [];
    for (let i = 0; i <= n; i++) {
      edges.push(i === n ? hi : lo + i * width);
    }
    const counts = series.map(function (values) {
      const count = new Array(n).fill(0);
      values.forEach(function (v) {
        if (v !== null && isFinite(v)) {
          count[width === 0 ? 0 : Math.min(n - 1, Math.floor((v - lo) / width))] += 1;
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
  /// 2000.01.01, as grid.ts sends it - in q's notation, to the second.
  function temporalLabel(type, v) {
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
  function short(v) {
    return Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(3) : String(+v.toPrecision(6));
  }

  /// What a chart of `kind` over `rows` of the grid draws, before colours:
  /// {type, labels?, datasets: [{label, data}], note?}. `columns` are the
  /// y columns, as chartable() gives them; `bins` is for a histogram.
  function chartData(grid, rows, kind, columns, bins) {
    if (columns.length === 0) {
      return { type: "bar", datasets: [], note: "No numeric column to chart" + (kind === "histogram" ? "." : " against the first.") };
    }
    const values = function (c) {
      return rows.map(function (r) { return grid.values[c][r]; });
    };
    const name = function (c) { return grid.columns[c].name; };
    if (kind === "histogram") {
      const h = histogram(columns.map(values), bins);
      const labels = h.edges.slice(1).map(function (e, i) { return short(h.edges[i]) + " - " + short(e); });
      return {
        type: "bar",
        labels: labels,
        datasets: columns.map(function (c, i) { return { label: name(c), column: c, data: h.counts[i] }; }),
      };
    }
    if (kind === "scatter") {
      const xs = grid.values[0];
      return {
        type: "scatter",
        datasets: columns.map(function (c) {
          const data = [];
          rows.forEach(function (r, i) {
            const x = xs ? xs[r] : i;
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
      labels: rows.map(function (r) { return grid.cells[0][r]; }),
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
  /// it when given.
  function chartConfig(grid, rows, kind, data, look, title) {
    const x = grid.columns[0];
    const translucent = function (colour) { return /^#[0-9a-f]{6}$/i.test(colour) ? colour + "99" : colour; };
    return {
      type: data.type,
      data: {
        labels: data.labels,
        datasets: data.datasets.map(function (d, i) {
          const colour = look.colours[i % look.colours.length];
          return Object.assign({}, d, {
            borderColor: colour,
            backgroundColor: kind === "line" ? colour : translucent(colour),
            pointRadius: kind === "line" ? (rows.length > 200 ? 0 : 2) : 3,
            borderWidth: kind === "bar" || kind === "histogram" ? 0 : 1.5,
            spanGaps: false,
          });
        }),
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: kind === "scatter" ? "nearest" : "index", intersect: false },
        scales: {
          x: {
            title: { display: kind !== "histogram", text: kind === "scatter" && !grid.values[0] ? "row" : x.name },
            type: kind === "scatter" ? "linear" : "category",
            // A month, date, minute or second is a whole number: a tick
            // between two would repeat one's label, or name no month.
            ticks: kind === "scatter" && x.temporal
              ? Object.assign({ callback: function (v) { return temporalLabel(x.type, v); } }, WHOLE.indexOf(x.type) >= 0 ? { precision: 0 } : {})
              : { autoSkip: true, maxRotation: 0 },
          },
          y: { title: { display: kind === "histogram", text: "count" } },
        },
        plugins: {
          title: { display: Boolean(title), text: title || "" },
          tooltip: kind === "scatter"
            ? { callbacks: { label: function (ctx) { const r = ctx.raw.row; return ctx.dataset.label + ": " + grid.cells[0][r] + ", " + grid.cells[ctx.dataset.column][r]; } } }
            : {},
        },
      },
    };
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
    summary: summary,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  } else {
    root.qlintChart = helpers;
  }
})(typeof self !== "undefined" ? self : this);
