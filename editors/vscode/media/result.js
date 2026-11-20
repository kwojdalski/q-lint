// The q-lint result panel: one query's result as a grid or a chart.
//
// The extension sends a `grid.ts` Grid - each column's cells as text, the
// ranks the process sorted them to, and the numeric columns' values - and
// this script only lays it out. The helpers at the top touch no DOM, and
// test/result.test.js runs them under node; the rest runs in the webview.
(function (root) {
  "use strict";

  /// The rows a grid holds.
  function rowCount(grid) {
    return grid.cells.length === 0 ? 0 : grid.cells[0].length;
  }

  /// The rows to show, in order: those whose cells hold each column's filter
  /// text (ignoring case), sorted by `sort` ({column, descending}) when set.
  /// A column the process ranked sorts by its rank, as q's `xasc` would;
  /// one it could not sort, by its text.
  function visibleRows(grid, filters, sort) {
    const active = [];
    (filters || []).forEach(function (f, c) {
      if (f && c < grid.cells.length) {
        active.push([c, String(f).toLowerCase()]);
      }
    });
    const rows = [];
    for (let r = 0; r < rowCount(grid); r++) {
      if (active.every(function (a) { return grid.cells[a[0]][r].toLowerCase().indexOf(a[1]) >= 0; })) {
        rows.push(r);
      }
    }
    if (sort && sort.column < grid.cells.length) {
      const rank = grid.rank[sort.column];
      const cells = grid.cells[sort.column];
      const up = rank
        ? function (a, b) { return rank[a] - rank[b]; }
        : function (a, b) { return cells[a] < cells[b] ? -1 : cells[a] > cells[b] ? 1 : a - b; };
      rows.sort(sort.descending ? function (a, b) { return up(b, a); } : up);
    }
    return rows;
  }

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
      case 13: return (2000 + Math.floor(v / 12)) + "." + pad(((v % 12) + 12) % 12 + 1);
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

  const helpers = {
    rowCount: rowCount,
    visibleRows: visibleRows,
    chartable: chartable,
    histogram: histogram,
    chartData: chartData,
    temporalLabel: temporalLabel,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  }
  if (typeof acquireVsCodeApi !== "function") {
    return;
  }

  // --- the webview

  const vscode = acquireVsCodeApi();
  /// Pixels a grid row takes: result.css sets the same.
  const ROW = 22;
  const KINDS = ["line", "bar", "scatter", "histogram"];
  const state = Object.assign({ id: 0, view: "grid", sort: null, filters: [], kind: "line", columns: null, bins: 20 }, vscode.getState() || {});
  let result = null;
  let rows = [];
  let chart = null;

  const el = function (tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) {
      e.className = cls;
    }
    if (text !== undefined) {
      e.textContent = text;
    }
    return e;
  };
  const bar = el("header", "bar");
  const gridView = el("main", "grid-view");
  const chartView = el("main", "chart-view");
  document.body.append(bar, gridView, chartView);

  function save() {
    vscode.setState(state);
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function rendered(extra) {
    const grid = result.grid;
    vscode.postMessage({
      type: "rendered",
      rendered: Object.assign({
        view: state.view,
        rows: rows.length,
        held: rowCount(grid),
        total: grid.total,
        columns: grid.columns.map(function (c) { return c.name; }),
        first: rows.length ? grid.cells.map(function (col) { return col[rows[0]]; }) : [],
      }, extra || {}),
    });
  }

  function drawBar() {
    const grid = result.grid;
    bar.replaceChildren();
    const views = el("div", "views");
    ["grid", "chart"].forEach(function (v) {
      const b = el("button", v === state.view ? "on" : "", v === "grid" ? "Grid" : "Chart");
      b.addEventListener("click", function () {
        state.view = v;
        save();
        draw();
      });
      views.append(b);
    });
    const held = rowCount(grid);
    const fmt = function (n) { return n.toLocaleString("en-US"); };
    let count = fmt(held) + " row" + (held === 1 ? "" : "s");
    if (grid.total > held) {
      count = fmt(held) + " of " + fmt(grid.total) + " rows: cut at q-lint.query.gridLimit (" + fmt(result.limit) + ")";
    }
    if (rows.length !== held) {
      count = fmt(rows.length) + " shown, " + count;
    }
    const info = el("span", "info", count);
    const meta = el("span", "meta", result.process + " · " + result.millis + " ms");
    meta.title = result.code;
    const copy = el("button", "", "Copy as CSV");
    copy.title = "The rows shown, in the order shown, as the cells show them";
    copy.addEventListener("click", function () {
      vscode.postMessage({ type: "copy", rows: rows });
    });
    bar.append(views, info, meta, copy);
  }

  // --- grid

  let body = null;
  let scroller = null;

  function drawGrid() {
    const grid = result.grid;
    gridView.replaceChildren();
    scroller = el("div", "scroller");
    const table = el("table");
    const cols = el("colgroup");
    grid.columns.forEach(function (c, i) {
      let width = c.name.length + 2;
      const cells = grid.cells[i];
      for (let r = 0; r < Math.min(cells.length, 500); r++) {
        width = Math.max(width, cells[r].length);
      }
      const col = el("col");
      col.style.width = Math.min(width + 2, 60) + "ch";
      cols.append(col);
    });
    const head = el("thead");
    const names = el("tr");
    const filters = el("tr", "filters");
    grid.columns.forEach(function (c, i) {
      const sorted = state.sort && state.sort.column === i ? (state.sort.descending ? " ▼" : " ▲") : "";
      const th = el("th", (c.key ? "key" : "") + (c.numeric ? " num" : ""), c.name + sorted);
      th.title = c.name + ": " + c.typeName + ". Click to sort.";
      th.addEventListener("click", function () {
        const s = state.sort;
        state.sort = !s || s.column !== i ? { column: i, descending: false } : s.descending ? null : { column: i, descending: true };
        save();
        rows = visibleRows(grid, state.filters, state.sort);
        drawGrid();
        drawBar();
      });
      names.append(th);
      const ft = el("th", c.key ? "key" : "");
      const input = el("input");
      input.type = "search";
      input.placeholder = "filter";
      input.value = state.filters[i] || "";
      input.addEventListener("input", function () {
        state.filters[i] = input.value;
        save();
        rows = visibleRows(grid, state.filters, state.sort);
        scroller.scrollTop = 0;
        paint();
        drawBar();
      });
      ft.append(input);
      filters.append(ft);
    });
    head.append(names, filters);
    body = el("tbody");
    table.append(cols, head, body);
    scroller.append(table);
    gridView.append(scroller);
    scroller.addEventListener("scroll", paint);
    paint();
  }

  /// Draw the rows in view, and spacers for the rest: a grid holds up to
  /// q-lint.query.gridLimit rows, too many to put in the page at once.
  function paint() {
    if (!body || !result) {
      return;
    }
    const grid = result.grid;
    const height = scroller.clientHeight || 600;
    const start = Math.max(0, Math.floor(scroller.scrollTop / ROW) - 20);
    const end = Math.min(rows.length, start + Math.ceil(height / ROW) + 40);
    const spacer = function (n) {
      const tr = el("tr", "spacer");
      const td = el("td");
      td.colSpan = Math.max(1, grid.columns.length);
      td.style.height = n * ROW + "px";
      tr.append(td);
      return tr;
    };
    const out = [];
    if (start > 0) {
      out.push(spacer(start));
    }
    for (let i = start; i < end; i++) {
      const r = rows[i];
      const tr = el("tr");
      grid.columns.forEach(function (c, ci) {
        const text = grid.cells[ci][r];
        const td = el("td", (c.key ? "key" : "") + (c.numeric || c.temporal ? " num" : ""), text);
        td.title = text;
        tr.append(td);
      });
      out.push(tr);
    }
    if (end < rows.length) {
      out.push(spacer(rows.length - end));
    }
    body.replaceChildren.apply(body, out);
  }

  // --- chart

  function palette() {
    return ["blue", "orange", "green", "red", "purple", "yellow"].map(function (c, i) {
      return cssVar("--vscode-charts-" + c, ["#3794ff", "#d18616", "#89d185", "#f14c4c", "#b180d7", "#cca700"][i]);
    });
  }

  function drawChart() {
    const grid = result.grid;
    chartView.replaceChildren();
    if (chart) {
      chart.destroy();
      chart = null;
    }
    const controls = el("div", "controls");
    const kind = el("select");
    KINDS.forEach(function (k) {
      const o = el("option", "", k[0].toUpperCase() + k.slice(1));
      o.value = k;
      o.selected = k === state.kind;
      kind.append(o);
    });
    kind.addEventListener("change", function () {
      state.kind = kind.value;
      save();
      drawChart();
    });
    controls.append(kind);
    const can = chartable(grid, state.kind);
    const picked = state.columns === null ? can : can.filter(function (c) { return state.columns.indexOf(grid.columns[c].name) >= 0; });
    can.forEach(function (c) {
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.checked = picked.indexOf(c) >= 0;
      box.addEventListener("change", function () {
        const names = can.filter(function (x) { return x === c ? box.checked : picked.indexOf(x) >= 0; });
        state.columns = names.map(function (x) { return grid.columns[x].name; });
        save();
        drawChart();
      });
      label.append(box, document.createTextNode(" " + grid.columns[c].name));
      controls.append(label);
    });
    if (state.kind === "histogram") {
      const label = el("label", "", "bins ");
      const bins = el("input");
      bins.type = "number";
      bins.min = "1";
      bins.max = "500";
      bins.value = String(state.bins);
      bins.addEventListener("change", function () {
        state.bins = Math.max(1, Math.min(500, parseInt(bins.value, 10) || 20));
        save();
        drawChart();
      });
      label.append(bins);
      controls.append(label);
    }
    chartView.append(controls);
    const data = chartData(grid, rows, state.kind, picked, state.bins);
    const summary = {
      kind: state.kind,
      datasets: data.datasets.map(function (d) { return { label: d.label, points: d.data.length }; }),
    };
    if (data.note || typeof Chart !== "function") {
      const note = data.note || "The chart library did not load.";
      chartView.append(el("p", "note", note));
      summary.note = note;
      rendered({ chart: summary });
      return;
    }
    const box = el("div", "canvas");
    const canvas = el("canvas");
    box.append(canvas);
    chartView.append(box);
    const colours = palette();
    const fg = cssVar("--vscode-foreground", "#ccc");
    const line = cssVar("--vscode-panel-border", "rgba(128,128,128,0.35)");
    Chart.defaults.color = fg;
    Chart.defaults.borderColor = line;
    Chart.defaults.font.family = cssVar("--vscode-font-family", "sans-serif");
    const x = grid.columns[0];
    const translucent = function (colour) { return /^#[0-9a-f]{6}$/i.test(colour) ? colour + "99" : colour; };
    chart = new Chart(canvas, {
      type: data.type,
      data: {
        labels: data.labels,
        datasets: data.datasets.map(function (d, i) {
          const colour = colours[i % colours.length];
          return Object.assign({}, d, {
            borderColor: colour,
            backgroundColor: state.kind === "line" ? colour : translucent(colour),
            pointRadius: state.kind === "line" ? (rows.length > 200 ? 0 : 2) : 3,
            borderWidth: state.kind === "bar" || state.kind === "histogram" ? 0 : 1.5,
            spanGaps: false,
          });
        }),
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: state.kind === "scatter" ? "nearest" : "index", intersect: false },
        scales: {
          x: {
            title: { display: state.kind !== "histogram", text: state.kind === "scatter" && !grid.values[0] ? "row" : x.name },
            type: state.kind === "scatter" ? "linear" : "category",
            ticks: state.kind === "scatter" && x.temporal
              ? { callback: function (v) { return temporalLabel(x.type, v); } }
              : { autoSkip: true, maxRotation: 0 },
          },
          y: { title: { display: state.kind === "histogram", text: "count" } },
        },
        plugins: {
          tooltip: state.kind === "scatter"
            ? { callbacks: { label: function (ctx) { const r = ctx.raw.row; return ctx.dataset.label + ": " + grid.cells[0][r] + ", " + grid.cells[ctx.dataset.column][r]; } } }
            : {},
        },
      },
    });
    rendered({ chart: summary });
  }

  function draw() {
    if (!result) {
      return;
    }
    drawBar();
    gridView.hidden = state.view !== "grid";
    chartView.hidden = state.view !== "chart";
    if (state.view === "grid") {
      drawGrid();
      rendered();
    } else {
      drawChart();
    }
  }

  window.addEventListener("message", function (event) {
    const m = event.data;
    if (!m || m.type !== "result") {
      return;
    }
    const names = m.grid.columns.map(function (c) { return c.name; }).join("\u0000");
    if (m.id !== state.id) {
      // A new result: the view its mode asks for; the sort, filters and
      // chosen columns only if it has the same columns.
      if (names !== state.names) {
        state.sort = null;
        state.filters = [];
        state.columns = null;
      }
      state.view = m.view;
      state.id = m.id;
      state.names = names;
    }
    result = m;
    rows = visibleRows(m.grid, state.filters, state.sort);
    save();
    draw();
  });
  window.addEventListener("resize", paint);
  vscode.postMessage({ type: "ready" });
})(typeof self !== "undefined" ? self : this);
