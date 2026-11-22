// The q-lint result panel: one query's result as a grid or a chart.
//
// The extension sends a `grid.ts` Grid - each column's cells as text, the
// ranks the process sorted them to, and the numeric columns' values - and
// this script only lays it out. What a chart draws is chartspec.js's, loaded
// before this script, which the notebook's chart renderer draws with too.
// The helpers at the top touch no DOM, and test/grid.test.js runs them
// under node; the rest runs in the webview.
//
// How a column is dressed - a format its name asks for, conditional
// formatting rules, data bars and sparklines, the column layout - is
// gridlook.js's, and the depth, map and linked charts are chartmore.js's,
// both loaded before this script (#1012-#1021). Their look comes from the
// extension with the result (`look`), which keeps it per result tab and per
// saved query; a layout changed here is sent back to it.
(function (root) {
  "use strict";

  /// The rows a grid holds.
  function rowCount(grid) {
    return grid.cells.length === 0 ? 0 : grid.cells[0].length;
  }

  /// The rows to show, in order: those whose cells hold each column's filter
  /// text (ignoring case), sorted by `sort` ({column, descending}) when set.
  /// A column the process ranked sorts by its rank, as q's `xasc` or
  /// `xdesc` would, equal values kept in their order either way; one it
  /// could not sort, by its text.
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
        : function (a, b) { return cells[a] < cells[b] ? -1 : cells[a] > cells[b] ? 1 : 0; };
      rows.sort(function (a, b) { return (sort.descending ? up(b, a) : up(a, b)) || a - b; });
    }
    return rows;
  }

  /// The columns a chart draws, of those it `can`: the ones ticked
  /// (`chosen`, their places, as the page saves them), or every one before
  /// any is ticked. {columns, note?}: the note when none is ticked.
  function chartColumns(can, chosen) {
    if (!Array.isArray(chosen) || !chosen.every(Number.isInteger)) {
      return { columns: can };
    }
    const columns = can.filter(function (c) { return chosen.indexOf(c) >= 0; });
    return columns.length === 0 && can.length > 0 ? { columns: columns, note: "No column is ticked: tick one above to chart it." } : { columns: columns };
  }

  /// The bins a histogram's field asks for: 1 to 500, `fallback` when it
  /// holds no number. 0 is a number: the fewest bins, not the default.
  function binsFrom(text, fallback) {
    const n = parseInt(text, 10);
    return Number.isNaN(n) ? fallback : Math.max(1, Math.min(500, n));
  }

  /// Pixels a grid row takes: result.css sets the same.
  const ROW = 22;
  /// The tallest the rows may be laid out: under the 33,554,432 px Chromium
  /// lets an element be, and Firefox's 17,895,697.
  const MAX_HEIGHT = 15000000;

  /// The rows to draw for a scroll position, and the spacers above and
  /// below them, in pixels: {start, end, before, after}. Row for row while
  /// they fit in MAX_HEIGHT; past that, the scrollbar's range is spread
  /// over the rows, so the last is still reached.
  function span(scrollTop, height, count) {
    const visible = Math.ceil(height / ROW);
    if (count * ROW <= MAX_HEIGHT) {
      const start = Math.max(0, Math.floor(scrollTop / ROW) - 20);
      const end = Math.min(count, start + visible + 40);
      return { start: start, end: end, before: start * ROW, after: (count - end) * ROW };
    }
    const range = Math.max(1, MAX_HEIGHT - height);
    const at = Math.max(0, Math.min(1, scrollTop / range));
    const first = Math.round(at * Math.max(0, count - visible));
    const start = Math.max(0, first - 20);
    const end = Math.min(count, first + visible + 20);
    // The first row in view sits at the top of the view; at the bottom,
    // the last row ends where the rows do.
    const before = Math.max(0, Math.min(scrollTop - (first - start) * ROW, MAX_HEIGHT - (end - start) * ROW));
    return { start: start, end: end, before: before, after: Math.max(0, MAX_HEIGHT - before - (end - start) * ROW) };
  }

  const NULL_GUID = "00000000-0000-0000-0000-000000000000";

  /// Whether a cell shows a null: blank, as grid.ts writes every null but
  /// a guid's and a char's.
  function isNull(type, text) {
    return text === "" || (type === 2 && text === NULL_GUID) || (type === 10 && text === " ");
  }

  /// A mean as the statistics show it: twelve significant digits at most.
  function meanText(x) {
    return String(Number(x.toPrecision(12)));
  }

  /// Each column's statistics over `rows`, the rows shown: {name, type,
  /// count, nulls, distinct, min, max, mean}. Distinct counts a null as
  /// one value, as q's `count distinct` does. Min and max are by the
  /// process's order (the ranks), nulls left out, as the cells show them;
  /// blank where q could not sort the column. Mean is of a numeric
  /// column's values, nulls and infinities left out.
  function columnStats(grid, rows) {
    return grid.columns.map(function (c, i) {
      const cells = grid.cells[i];
      const rank = grid.rank[i];
      const values = c.numeric ? grid.values[i] : null;
      const seen = new Set();
      let nulls = 0;
      let lo = -1;
      let hi = -1;
      let sum = 0;
      let n = 0;
      rows.forEach(function (r) {
        const text = cells[r];
        seen.add(rank ? rank[r] : text);
        if (isNull(c.type, text)) {
          nulls++;
          return;
        }
        if (rank) {
          if (lo < 0 || rank[r] < rank[lo]) {
            lo = r;
          }
          if (hi < 0 || rank[r] > rank[hi]) {
            hi = r;
          }
        }
        if (values && values[r] !== null) {
          sum += values[r];
          n++;
        }
      });
      return {
        name: c.name,
        type: c.typeName,
        count: rows.length,
        nulls: nulls,
        distinct: seen.size,
        min: lo < 0 ? "" : cells[lo],
        max: hi < 0 ? "" : cells[hi],
        mean: n > 0 ? meanText(sum / n) : "",
      };
    });
  }

  /// Where each value sits for a heatmap: from 0 (the least) to 1 (the
  /// greatest), or - a column with values either side of zero - from -1 to
  /// 1 by its distance from zero, so the sign shows. Null for a null or an
  /// infinity, and for every row when the column holds one value.
  function heatLevels(values) {
    if (!values) {
      return null;
    }
    let lo = Infinity;
    let hi = -Infinity;
    values.forEach(function (v) {
      if (v !== null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    });
    if (!(lo < hi)) {
      return null;
    }
    if (lo < 0 && hi > 0) {
      const most = Math.max(-lo, hi);
      return values.map(function (v) { return v === null ? null : v / most; });
    }
    return values.map(function (v) { return v === null ? null : (v - lo) / (hi - lo); });
  }

  /// A heatmap level as a cell's background: the theme's blue, or its red
  /// for a level below zero, stronger the further from zero.
  function heatColour(level) {
    const colour = level < 0 ? "var(--vscode-charts-red, #f14c4c)" : "var(--vscode-charts-blue, #3794ff)";
    return "color-mix(in srgb, " + colour + " " + Math.round(6 + Math.abs(level) * 50) + "%, transparent)";
  }

  /// A diff (resultdiff.ts) as lookups: the previous text of each changed
  /// cell by "column:row", and the added rows and columns.
  function diffMarks(diff) {
    const changed = new Map();
    diff.changes.forEach(function (c) { changed.set(c[0] + ":" + c[1], c[2]); });
    return { changed: changed, rows: new Set(diff.addedRows), columns: new Set(diff.addedColumns) };
  }

  /// q's names of the types a tree node can have.
  const TYPE_NAMES = { 1: "boolean", 2: "guid", 4: "byte", 5: "short", 6: "int", 7: "long", 8: "real", 9: "float", 10: "char", 11: "symbol", 12: "timestamp", 13: "month", 14: "date", 15: "datetime", 16: "timespan", 17: "minute", 18: "second", 19: "time" };

  /// What a tree node says of itself after its key: a leaf's text, and
  /// what a node with children holds.
  function treeText(node) {
    const n = node.count.toLocaleString("en-US");
    if (node.type === 0) {
      return "list of " + n;
    }
    if (node.type === 99) {
      return node.text || "dictionary of " + n;
    }
    if (node.type === 98) {
      return "table of " + n + " row" + (node.count === 1 ? "" : "s");
    }
    if (node.type > 0 && node.type < 20 && node.type !== 10 && node.text === "") {
      return TYPE_NAMES[node.type] + " list of " + n;
    }
    if (node.type >= 20 && node.type <= 76 && node.text === "") {
      return "enum list of " + n;
    }
    return node.text;
  }

  /// Whether a node can be opened: it has children, or had some not sent.
  function treeOpens(node) {
    return node.children.length > 0 || (node.text === "" && node.count > 0 && node.type >= 0 && node.type < 98);
  }

  const AGGREGATIONS = ["count", "sum", "avg", "min", "max"];

  /// A pivot of `rows` (#925): one row per distinct value of column
  /// `spec.row`, one column per distinct value of `spec.column` (-1: one
  /// column), each cell `spec.agg` of column `spec.value` over the rows
  /// with both. `count` counts the non-null values (every row, with
  /// `spec.value` -1); the others take a numeric column's values, nulls and
  /// infinities left out. Values are ordered as q sorts them (the ranks),
  /// or by text where q could not. At most `maxColumns` column values; the
  /// note says how many more there were. {rows: [text], columns: [text],
  /// cells: [[text]], note?}.
  function pivot(grid, rows, spec, maxColumns) {
    const most = maxColumns || 100;
    const agg = AGGREGATIONS.indexOf(spec.agg) >= 0 ? spec.agg : "count";
    const valueColumn = spec.value >= 0 && spec.value < grid.columns.length ? spec.value : -1;
    const numbers = valueColumn >= 0 && grid.columns[valueColumn].numeric ? grid.values[valueColumn] : null;
    if (agg !== "count" && !numbers) {
      return { rows: [], columns: [], cells: [], note: "Choose a numeric column to take the " + agg + " of, or count." };
    }
    const keys = function (c) {
      if (c < 0 || c >= grid.columns.length) {
        return { of: function () { return ""; }, order: [""] };
      }
      const cells = grid.cells[c];
      const rank = grid.rank[c];
      const first = new Map();
      rows.forEach(function (r) {
        if (!first.has(cells[r])) {
          first.set(cells[r], r);
        }
      });
      const order = Array.from(first.keys());
      order.sort(function (a, b) {
        if (rank) {
          return rank[first.get(a)] - rank[first.get(b)];
        }
        return a < b ? -1 : a > b ? 1 : 0;
      });
      return { of: function (r) { return cells[r]; }, order: order };
    };
    const across = keys(spec.row);
    const down = keys(spec.column);
    const shown = down.order.slice(0, most);
    const at = new Map();
    shown.forEach(function (k, i) { at.set(k, i); });
    const acc = new Map();
    rows.forEach(function (r) {
      const j = at.get(down.of(r));
      if (j === undefined) {
        return;
      }
      const k = across.of(r);
      if (!acc.has(k)) {
        acc.set(k, shown.map(function () { return { n: 0, sum: 0, min: Infinity, max: -Infinity }; }));
      }
      const a = acc.get(k)[j];
      if (agg === "count") {
        if (valueColumn < 0 || !isNull(grid.columns[valueColumn].type, grid.cells[valueColumn][r])) {
          a.n++;
        }
        return;
      }
      const v = numbers[r];
      if (v !== null) {
        a.n++;
        a.sum += v;
        a.min = Math.min(a.min, v);
        a.max = Math.max(a.max, v);
      }
    });
    const text = function (a) {
      if (agg === "count") {
        return String(a.n);
      }
      if (a.n === 0) {
        return "";
      }
      return meanText(agg === "sum" ? a.sum : agg === "avg" ? a.sum / a.n : agg === "min" ? a.min : a.max);
    };
    const out = { rows: across.order, columns: spec.column >= 0 ? shown : [agg], cells: across.order.map(function (k) { return (acc.get(k) || shown.map(function () { return { n: 0, sum: 0, min: Infinity, max: -Infinity }; })).map(text); }) };
    if (down.order.length > shown.length) {
      out.note = "The first " + shown.length + " of " + down.order.length + " values of " + grid.columns[spec.column].name + " are shown as columns.";
    }
    return out;
  }

  /// The pivot a result starts with: rows by its first column that is not
  /// numeric (or its first), and the sum of its first numeric column
  /// other than that, or a count.
  function defaultPivot(grid) {
    let row = grid.columns.findIndex(function (c) { return !c.numeric; });
    row = row < 0 ? 0 : row;
    const value = grid.columns.findIndex(function (c, i) { return c.numeric && i !== row; });
    return { row: row, column: -1, value: value, agg: value >= 0 ? "sum" : "count" };
  }

  const helpers = {
    rowCount: rowCount,
    pivot: pivot,
    defaultPivot: defaultPivot,
    AGGREGATIONS: AGGREGATIONS,
    visibleRows: visibleRows,
    chartColumns: chartColumns,
    binsFrom: binsFrom,
    span: span,
    columnStats: columnStats,
    heatLevels: heatLevels,
    heatColour: heatColour,
    diffMarks: diffMarks,
    treeText: treeText,
    treeOpens: treeOpens,
    MAX_HEIGHT: MAX_HEIGHT,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  }
  if (typeof acquireVsCodeApi !== "function") {
    return;
  }

  // --- the webview

  const vscode = acquireVsCodeApi();
  const C = root.qlintChart;
  const LOOK = root.qlintLook;
  const MORE = root.qlintChartMore;
  const WORLD = root.qlintWorld;
  const BASE_KINDS = ["line", "bar", "scatter", "histogram"];
  /// The kinds q-lint.results.charts.enable adds.
  const MORE_KINDS = ["area", "step", "candlestick"];
  /// What a kind is called in the chart's menu, where it is not its name.
  const KIND_NAMES = { candlestick: "Candlestick", depth: "Depth (order book)", map: "Map", linked: "Linked panes" };
  const VIEWS = { grid: "Grid", chart: "Chart", stats: "Stats", tree: "Tree", pivot: "Pivot", corr: "Correlation" };
  const state = Object.assign(
    { id: 0, view: "grid", sort: null, filters: [], kind: "line", columns: null, bins: C.BINS, top: 0, compare: false, open: [""], saved: {}, control: null, pivot: null, y2: -1, colours: {}, mapSize: -1, mapColour: -1, zoom: null },
    vscode.getState() || {},
  );
  let result = null;
  let rows = [];
  let chart = null;
  /// The result's diff as lookups, and each column's heatmap levels.
  let marks = null;
  let heat = [];
  /// More rows were asked for, and have not come yet.
  let moreAsked = false;
  /// What the chart last drew: its data and theme, for an image of it.
  let drawnChart = null;
  /// The linked panes' charts, while they are drawn.
  let panes = [];
  /// What paint() last dressed, for rendered(): cells formatted, styled by
  /// a rule, drawn as a data bar or a sparkline.
  let dress = null;

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
  const tabs = el("nav", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Results");
  tabs.hidden = true;
  const bar = el("header", "bar");
  const gridView = el("main", "grid-view");
  const chartView = el("main", "chart-view");
  const statsView = el("main", "stats-view");
  const treeView = el("main", "tree-view");
  const pivotView = el("main", "pivot-view");
  const corrView = el("main", "corr-view");
  document.body.append(tabs, bar, gridView, chartView, statsView, treeView, pivotView, corrView);
  // Until a result arrives: what fills the page, as a view's welcome would.
  gridView.append(el("p", "note", "No result yet. Run a query in grid or chart mode (q-lint: Switch Query Mode) to show it here."));

  function save() {
    vscode.setState(state);
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function rendered(extra) {
    const grid = result.grid;
    const more = {};
    const kept = result.history || [];
    if (kept.length > 0) {
      more.history = { count: kept.length, index: kept.map(function (h) { return h.id; }).indexOf(result.id) };
    }
    if (comparing()) {
      const d = result.diff;
      more.diff = { changed: d.changed, added: d.addedRows.length, removed: d.removed.count, matchedBy: d.matchedBy };
    }
    if (state.view === "grid" && dressing && dress) {
      more.dressed = {
        headers: dressing.display.map(function (i) { return headerText(grid, i); }),
        formatted: dress.formatted,
        ruled: dress.ruled,
        bars: dress.bars,
        sparks: dress.sparks,
        frozen: dressing.frozen,
      };
    }
    if (state.view === "grid" && result.heatmap) {
      more.heat = heat.reduce(function (n, levels) {
        return n + (levels ? rows.filter(function (r) { return levels[r] !== null; }).length : 0);
      }, 0);
    }
    extra = Object.assign(more, extra || {});
    vscode.postMessage({
      type: "rendered",
      id: result.id,
      // The rows shown, in order: what Export Results to CSV writes.
      rows: rows,
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

  /// Whether a feature the extension can turn off (q-lint.results.*.enable)
  /// is on: a result sent without `features` has them all.
  function feature(name) {
    return !result.features || result.features[name] !== false;
  }

  /// Whether the page offers view `v` for the result on show.
  function offered(v) {
    if (v === "corr") {
      return feature("correlation") && LOOK.correlation(result.grid, []).columns.length >= 2;
    }
    return v === "tree" ? !!result.tree : v === "stats" ? feature("statistics") : v === "pivot" ? feature("pivot") : true;
  }

  /// The chart kinds offered: the extra ones only while charts are on; a
  /// depth chart for an order book and a map for positions only while they
  /// are on and the columns fit; linked panes while they are on.
  function kinds() {
    let out = feature("charts") ? BASE_KINDS.concat(MORE_KINDS) : BASE_KINDS;
    if (feature("depthChart") && MORE.depthColumns(result.grid)) {
      out = out.concat(["depth"]);
    }
    if (feature("mapChart") && MORE.mapColumns(result.grid)) {
      out = out.concat(["map"]);
    }
    if (feature("linkedCharts")) {
      out = out.concat(["linked"]);
    }
    return out;
  }

  /// The result's look, its parts for the features on: {rules, cellCharts,
  /// layout, chart}.
  function look() {
    return result.look || {};
  }

  /// The column layout in force: none while the feature is off.
  function layout() {
    return feature("columnLayout") && look().layout ? look().layout : { order: [], hidden: [], widths: {}, frozen: 0 };
  }

  /// Change the layout: kept with the result here, and sent to the
  /// extension, which keeps it for the result tab and its saved query.
  function setLayout(next) {
    result.look = Object.assign({}, look(), { layout: Object.assign({ order: [], hidden: [], widths: {}, frozen: 0 }, next) });
    vscode.postMessage({ type: "look", id: result.id, layout: result.look.layout });
  }

  /// Whether Compare with Previous Run is on, for a result that has one.
  function comparing() {
    return state.compare && !!result.diff;
  }

  /// The results kept, as tabs: choosing one asks the extension for it.
  function drawTabs() {
    const kept = result.history || [];
    tabs.hidden = kept.length < 2;
    tabs.replaceChildren();
    kept.forEach(function (h, i) {
      const on = h.id === result.id;
      const tab = el("button", "tab" + (on ? " on" : ""), (i + 1) + ". " + h.code);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.title = h.code + "\n" + h.process + " · " + new Date(h.at).toLocaleTimeString() + " · " + h.rows.toLocaleString("en-US") + " row(s)";
      tab.addEventListener("click", function () {
        if (!on) {
          vscode.postMessage({ type: "select", id: result.id, pick: h.id });
        }
      });
      tabs.append(tab);
    });
  }

  function drawBar() {
    const grid = result.grid;
    bar.replaceChildren();
    const views = el("div", "views");
    Object.keys(VIEWS).filter(offered).forEach(function (v) {
      const b = el("button", v === state.view ? "on" : "", VIEWS[v]);
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
      count = result.more
        ? fmt(held) + " of " + fmt(grid.total) + " rows: more as the grid scrolls"
        : fmt(held) + " of " + fmt(grid.total) + " rows: cut at q-lint.query.gridLimit (" + fmt(result.limit) + ")";
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
      vscode.postMessage({ type: "copy", id: result.id, rows: rows });
    });
    const exporter = el("button", "", "Export to CSV");
    exporter.title = "Save the rows shown, in the order shown, to a CSV file";
    exporter.addEventListener("click", function () {
      vscode.postMessage({ type: "export", id: result.id, rows: rows });
    });
    const extras = [];
    if (result.more) {
      const more = el("button", "", "Load more");
      more.title = "Fetch the next " + fmt(result.limit) + " rows from the process, which holds the result";
      more.addEventListener("click", function () {
        moreAsked = true;
        vscode.postMessage({ type: "more", id: result.id });
      });
      extras.push(more);
    }
    if (result.diff) {
      const compare = el("button", state.compare ? "on" : "", "Compare");
      compare.title = "Mark what changed since the previous run of this query, on " + result.diff.process + " at " + new Date(result.diff.at).toLocaleTimeString();
      compare.setAttribute("aria-pressed", state.compare ? "true" : "false");
      compare.addEventListener("click", function () {
        state.compare = !state.compare;
        save();
        draw();
      });
      extras.push(compare);
    }
    if (state.view === "grid" && feature("heatmap")) {
      const heatmap = el("button", result.heatmap ? "on" : "", "Heatmap");
      heatmap.title = "Colour numeric columns by value (q-lint.query.gridHeatmap)";
      heatmap.setAttribute("aria-pressed", result.heatmap ? "true" : "false");
      heatmap.addEventListener("click", function () {
        vscode.postMessage({ type: "heatmap", id: result.id });
      });
      extras.push(heatmap);
    }
    const hidden = layout().hidden.filter(function (name) { return grid.columns.some(function (c) { return c.name === name; }); });
    if (state.view === "grid" && hidden.length > 0) {
      const show = el("button", "", hidden.length + " hidden");
      show.title = "Show the hidden columns: " + hidden.join(", ");
      show.addEventListener("click", function () {
        setLayout(Object.assign({}, layout(), { hidden: [] }));
        draw();
      });
      extras.push(show);
    }
    const tail = [meta, copy, exporter];
    if (feature("sendResult")) {
      const send = el("button", "", "Send to...");
      send.title = "Insert the rows shown, and the chart if you like, into a q notebook, or append them to a Markdown report";
      send.addEventListener("click", function () {
        vscode.postMessage({ type: "send", id: result.id, rows: rows });
      });
      tail.push(send);
    }
    if (feature("export")) {
      const as = el("button", "", "Export as...");
      as.title = "Save the rows shown as Excel, Parquet, JSON, Markdown, q or HTML";
      as.addEventListener("click", function () {
        vscode.postMessage({ type: "exportAs", id: result.id, rows: rows });
      });
      tail.push(as);
    }
    bar.append.apply(bar, [views, info].concat(extras, tail));
    if (comparing()) {
      const d = result.diff;
      const parts = [d.changed + " changed", d.addedRows.length + " added", d.removed.count + " removed"];
      if (d.addedColumns.length) {
        parts.push("new column" + (d.addedColumns.length === 1 ? " " : "s ") + d.addedColumns.map(function (c) { return grid.columns[c].name; }).join(", "));
      }
      if (d.removedColumns.length) {
        parts.push("no longer " + d.removedColumns.join(", "));
      }
      const line = el("span", "diff-summary", "Since " + d.process + " at " + new Date(d.at).toLocaleTimeString() + " (rows by " + d.matchedBy + "): " + parts.join(", "));
      bar.append(line);
    }
  }

  // --- grid

  let body = null;
  let scroller = null;
  /// What paint() last drew: the rows (that list) and their span.
  let painted = null;
  /// The column headers drawn, by place.
  let headers = [];

  /// How the grid dresses the result on show (#1012-#1015): the columns
  /// drawn, in order; each column's format, rule styles and cell chart; the
  /// colour columns; the frozen columns and how far from the left each sits.
  let dressing = null;
  /// A header being dragged to another place, by its place among those
  /// drawn; a column being resized; a resize just ended, whose click on the
  /// header is no sort.
  let dragFrom = null;
  let resizing = null;
  let resized = false;

  function dressGrid() {
    const grid = result.grid;
    const lay = layout();
    const display = feature("columnLayout") ? LOOK.displayColumns(grid, lay) : grid.columns.map(function (_, i) { return i; });
    const formats = feature("columnFormats") ? LOOK.columnFormats(grid) : grid.columns.map(function () { return null; });
    const rules = feature("conditionalFormats") ? LOOK.ruleStyles(grid, look().rules || []) : grid.columns.map(function () { return null; });
    const charts = look().cellCharts || {};
    const cells = grid.columns.map(function (c, i) {
      const f = formats[i];
      if ((feature("cellCharts") && c.numeric && charts[c.name] === "bar") || (f && f.kind === "bar")) {
        return { kind: "bar", levels: LOOK.barLevels(grid.values[i]) };
      }
      if (feature("cellCharts") && charts[c.name] !== "text" && LOOK.isNumericList(grid, i)) {
        return { kind: "spark" };
      }
      return null;
    });
    const paints = [];
    formats.forEach(function (f, i) {
      if (f && (f.kind === "bg" || f.kind === "fg")) {
        paints.push({ from: i, target: f.target, kind: f.kind });
      }
    });
    dressing = {
      display: display,
      formats: formats,
      rules: rules,
      cells: cells,
      paints: paints,
      frozen: feature("columnLayout") ? Math.min(lay.frozen || 0, display.length) : 0,
      lefts: [],
      colour: cssVar("--vscode-charts-blue", "#3794ff"),
    };
  }

  /// What column `i`'s header shows: its name without the suffix of its
  /// format, unless that names another column (a `px_BG` beside `px`).
  function headerText(grid, i) {
    const f = dressing.formats[i];
    return f && !grid.columns.some(function (c, j) { return j !== i && c.name === f.base; }) ? f.base : grid.columns[i].name;
  }

  /// What a column header's menu knows of its column, for the commands it
  /// offers: a numeric column takes a data bar, a list of numbers a
  /// sparkline.
  function columnKind(grid, i) {
    return grid.columns[i].numeric ? "numeric" : LOOK.isNumericList(grid, i) ? "list" : "other";
  }

  function drawGrid() {
    const grid = result.grid;
    dressGrid();
    const d = dressing;
    const lay = layout();
    gridView.replaceChildren();
    scroller = el("div", "scroller");
    const table = el("table");
    const cols = el("colgroup");
    const widths = [];
    const colEls = [];
    d.display.forEach(function (i) {
      const c = grid.columns[i];
      let css;
      if (feature("columnLayout") && lay.widths && lay.widths[c.name]) {
        css = lay.widths[c.name] + "px";
      } else {
        let width = headerText(grid, i).length + 2;
        const cells = grid.cells[i];
        for (let r = 0; r < Math.min(cells.length, 500); r++) {
          width = Math.max(width, cells[r].length);
        }
        css = Math.min(width + 2, 60) + "ch";
      }
      widths.push(css);
      const col = el("col");
      col.style.width = css;
      colEls.push(col);
      cols.append(col);
    });
    d.lefts = LOOK.frozenOffsets(widths, d.frozen);
    const head = el("thead");
    const names = el("tr");
    const filters = el("tr", "filters");
    headers = [];
    // A header's right-click menu: the Data Wrangler (#961), conditional
    // formats (#1013), data bars and sparklines (#1014), the layout (#1015).
    const menu = feature("wrangler") || feature("conditionalFormats") || feature("cellCharts") || feature("columnLayout");
    const ruleTexts = feature("conditionalFormats") ? (look().rules || []).map(function (rule) { return [rule.column, LOOK.ruleText(rule)]; }) : [];
    d.display.forEach(function (i, k) {
      const c = grid.columns[i];
      const f = d.formats[i];
      const sorted = state.sort && state.sort.column === i ? (state.sort.descending ? " ▼" : " ▲") : "";
      const frozen = k < d.frozen;
      const th = el("th", (c.key ? "key" : "") + (c.numeric ? " num" : "") + (frozen ? " frozen" : ""), headerText(grid, i) + sorted);
      const said = ruleTexts.filter(function (t) { return t[0] === c.name; }).map(function (t) { return t[1]; });
      th.title = c.name + ": " + c.typeName + "." + (f ? " Shown as " + f.label + " (_" + f.suffix + ")." : "") + (said.length ? "\n" + said.join("\n") : "") + "\nClick to sort.";
      if (frozen) {
        th.style.left = d.lefts[k];
      }
      // A keyboard sorts it too: Tab to it, then Enter or Space.
      th.tabIndex = 0;
      th.setAttribute("aria-sort", sorted === "" ? "none" : state.sort.descending ? "descending" : "ascending");
      const sort = function () {
        const s = state.sort;
        state.sort = !s || s.column !== i ? { column: i, descending: false } : s.descending ? null : { column: i, descending: true };
        state.top = 0;
        save();
        rows = visibleRows(grid, state.filters, state.sort);
        drawGrid();
        drawBar();
        rendered();
      };
      th.addEventListener("click", function () {
        if (resized) {
          resized = false;
          return;
        }
        sort();
      });
      if (menu) {
        th.setAttribute("data-vscode-context", JSON.stringify({ webviewSection: "column", column: i, columnKind: columnKind(grid, i), preventDefaultContextMenuItems: false }));
      }
      if (feature("columnLayout")) {
        // Drag a header to move its column; drag its right edge to resize it.
        th.draggable = true;
        th.addEventListener("dragstart", function (event) {
          dragFrom = k;
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", c.name);
          }
        });
        th.addEventListener("dragover", function (event) {
          if (dragFrom !== null) {
            event.preventDefault();
          }
        });
        th.addEventListener("drop", function (event) {
          event.preventDefault();
          const from = dragFrom;
          dragFrom = null;
          if (from === null || from === k) {
            return;
          }
          setLayout(Object.assign({}, lay, { order: LOOK.moveColumn(grid, lay, from, k) }));
          drawGrid();
          rendered();
        });
        th.addEventListener("dragend", function () { dragFrom = null; });
        const handle = el("span", "resize");
        handle.title = "Drag to resize the column";
        handle.addEventListener("mousedown", function (event) {
          event.preventDefault();
          if (event.stopPropagation) {
            event.stopPropagation();
          }
          const from = th.offsetWidth || 80;
          resizing = { col: colEls[k], name: c.name, start: event.clientX, from: from, width: from };
        });
        th.addEventListener("mousedown", function () { resized = false; });
        th.append(handle);
      }
      headers.push(th);
      th.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          sort();
          // The header was drawn again: the focus stays on it.
          headers[k].focus();
        }
      });
      names.append(th);
      const ft = el("th", (c.key ? "key" : "") + (frozen ? " frozen" : ""));
      if (frozen) {
        ft.style.left = d.lefts[k];
      }
      const input = el("input");
      input.type = "search";
      input.placeholder = "filter";
      input.value = state.filters[i] || "";
      input.addEventListener("input", function () {
        state.filters[i] = input.value;
        state.top = 0;
        save();
        rows = visibleRows(grid, state.filters, state.sort);
        scroller.scrollTop = 0;
        paint();
        drawBar();
        rendered();
      });
      ft.append(input);
      filters.append(ft);
    });
    head.append(names, filters);
    body = el("tbody");
    if (feature("drilldown")) {
      body.addEventListener("dblclick", function (event) {
        const td = event.target && event.target.closest ? event.target.closest("td[data-r]") : event.target;
        const r = td && td.getAttribute ? td.getAttribute("data-r") : null;
        if (r !== null) {
          vscode.postMessage({ type: "drill", id: result.id, column: Number(td.getAttribute("data-c")), row: Number(r) });
        }
      });
    }
    painted = null;
    table.append(cols, head, body);
    scroller.append(table);
    gridView.append(scroller);
    if (comparing() && result.diff.removed.count > 0) {
      gridView.append(removedRows(result.diff.removed));
    }
    scroller.addEventListener("scroll", function () {
      // Kept, so a page reloaded - hidden and shown again - is back here.
      state.top = scroller.scrollTop;
      save();
      paint();
    });
    paint();
    if (state.top > 0) {
      scroller.scrollTop = state.top;
      paint();
    }
  }

  /// A resized column follows the mouse, and its width is kept once let go.
  window.addEventListener("mousemove", function (event) {
    if (resizing) {
      resizing.width = Math.max(24, resizing.from + event.clientX - resizing.start);
      resizing.col.style.width = resizing.width + "px";
    }
  });
  window.addEventListener("mouseup", function () {
    if (!resizing || !result) {
      return;
    }
    const widths = Object.assign({}, layout().widths);
    widths[resizing.name] = Math.round(resizing.width);
    resizing = null;
    resized = true;
    setLayout(Object.assign({}, layout(), { widths: widths }));
    drawGrid();
    rendered();
  });

  /// The rows the previous run had and this one has not, below the grid.
  function removedRows(removed) {
    const box = el("details", "removed");
    const n = removed.count;
    box.append(el("summary", "", n.toLocaleString("en-US") + " row" + (n === 1 ? "" : "s") + " removed since the previous run" + (removed.rows.length < n ? " (the first " + removed.rows.length + " shown)" : "")));
    const table = el("table");
    const head = el("tr");
    removed.columns.forEach(function (name) { head.append(el("th", "", name)); });
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    removed.rows.forEach(function (row) {
      const tr = el("tr");
      row.forEach(function (text) {
        const td = el("td", "", text);
        td.title = text;
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    box.append(table);
    return box;
  }

  // --- statistics

  function drawStats() {
    const grid = result.grid;
    statsView.replaceChildren();
    const stats = columnStats(grid, rows);
    const held = rowCount(grid);
    let note = "Over the " + rows.length.toLocaleString("en-US") + " row" + (rows.length === 1 ? "" : "s") + " shown";
    if (rows.length !== held) {
      note += " (the grid's filters apply)";
    }
    if (grid.total > held) {
      note += "; the result had " + grid.total.toLocaleString("en-US") + ", cut at q-lint.query.gridLimit";
    }
    statsView.append(el("p", "note", note + "."));
    const scroll = el("div", "scroller");
    const table = el("table", "stats");
    const head = el("tr");
    ["column", "type", "count", "nulls", "distinct", "min", "max", "mean"].forEach(function (h, i) {
      head.append(el("th", i >= 2 && i <= 4 ? "num" : "", h));
    });
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    stats.forEach(function (st, i) {
      const tr = el("tr");
      const num = grid.columns[i].numeric || grid.columns[i].temporal ? " num" : "";
      [[st.name, grid.columns[i].key ? "key" : ""], [st.type, ""], [String(st.count), "num"], [String(st.nulls), "num"], [String(st.distinct), "num"], [st.min, num], [st.max, num], [st.mean, "num"]].forEach(function (cell) {
        const td = el("td", cell[1], cell[0]);
        td.title = cell[0];
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    scroll.append(table);
    statsView.append(scroll);
    rendered({ stats: stats });
  }

  // --- tree

  /// Draw the result's tree: each node a line, its children drawn only once
  /// it is opened. What is open is kept by path, the children's places.
  function drawTree() {
    treeView.replaceChildren();
    const labels = [];
    let drawn = 0;
    const open = new Set(state.open);
    const toggle = function (path) {
      const at = state.open.indexOf(path);
      if (at >= 0) {
        state.open.splice(at, 1);
      } else {
        state.open.push(path);
      }
      save();
      drawTree();
    };
    const line = function (node, path, depth) {
      const li = el("li");
      li.setAttribute("role", "treeitem");
      const opens = treeOpens(node);
      const isOpen = opens && open.has(path);
      const row = el("div", "node");
      row.style.paddingLeft = depth * 16 + "px";
      if (opens) {
        li.setAttribute("aria-expanded", isOpen ? "true" : "false");
        const twist = el("button", "twist", isOpen ? "\u25be" : "\u25b8");
        twist.title = isOpen ? "Close" : "Open";
        twist.setAttribute("aria-label", (isOpen ? "Close " : "Open ") + (node.key || "the result"));
        twist.addEventListener("click", function () { toggle(path); });
        row.append(twist);
      } else {
        row.append(el("span", "twist"));
      }
      const text = treeText(node);
      if (node.key !== "" || depth > 0) {
        row.append(el("span", "tree-key", node.key), el("span", "tree-sep", ": "));
      }
      const value = el("span", "tree-value" + (node.text === "" ? " tree-kind" : ""), text);
      value.title = text;
      row.append(value);
      li.append(row);
      drawn++;
      if (labels.length < 50) {
        labels.push((path === "" ? "" : path + " ") + (node.key ? node.key + ": " : "") + text);
      }
      if (isOpen) {
        const ul = el("ul");
        ul.setAttribute("role", "group");
        node.children.forEach(function (child, i) {
          ul.append(line(child, path === "" ? String(i) : path + "/" + i, depth + 1));
        });
        const missing = node.count - node.children.length;
        if (missing > 0) {
          const more = el("li", "tree-more");
          more.style.paddingLeft = (depth + 1) * 16 + 18 + "px";
          more.textContent = (node.children.length ? missing.toLocaleString("en-US") + " more" : node.count.toLocaleString("en-US") + " item" + (node.count === 1 ? "" : "s")) + " not sent: the tree is cut at 2,000 nodes";
          ul.append(more);
        }
        li.append(ul);
      }
      return li;
    };
    const tree = el("ul", "tree");
    tree.setAttribute("role", "tree");
    tree.append(line(result.tree, "", 0));
    const scroll = el("div", "scroller");
    scroll.append(tree);
    treeView.append(scroll);
    rendered({ tree: { drawn: drawn, open: state.open.length, labels: labels } });
  }

  /// A rule's colour as a cell's background: translucent, so the text reads.
  function tint(colour) {
    return "color-mix(in srgb, " + colour + " 45%, transparent)";
  }

  /// Draw the rows in view, and spacers for the rest: a grid holds up to
  /// q-lint.query.gridLimit rows, too many to put in the page at once.
  function paint() {
    if (!body || !result) {
      return;
    }
    const grid = result.grid;
    const d = dressing;
    const at = span(scroller.scrollTop, scroller.clientHeight || 600, rows.length);
    const start = at.start;
    const end = at.end;
    // The same rows over the same spacers: leave them be, so a selection
    // made in them, to copy, is not lost to a scroll.
    if (painted && painted.rows === rows && painted.start === start && painted.end === end && painted.before === at.before && painted.after === at.after) {
      return;
    }
    painted = { rows: rows, start: start, end: end, before: at.before, after: at.after };
    const spacer = function (px) {
      const tr = el("tr", "spacer");
      const td = el("td");
      td.colSpan = Math.max(1, d.display.length);
      td.style.height = px + "px";
      tr.append(td);
      return tr;
    };
    const out = [];
    const drill = feature("drilldown");
    // A cell's menu offers Edit Cell (#964) as well as Drill Down.
    const cellMenu = drill || feature("editCells");
    const counts = { formatted: 0, ruled: 0, bars: 0, sparks: 0 };
    if (at.before > 0) {
      out.push(spacer(at.before));
    }
    for (let i = start; i < end; i++) {
      const r = rows[i];
      const tr = el("tr");
      const added = marks && marks.rows.has(r);
      if (added) {
        tr.className = "added";
      }
      // The colours a _BG or _FG column gives this row: its target
      // column's cell, or every cell (-1).
      const painting = {};
      d.paints.forEach(function (p) {
        const colour = LOOK.cssColour(grid.cells[p.from][r]);
        if (colour) {
          const to = painting[p.target] || (painting[p.target] = {});
          to[p.kind] = colour;
          if (p.target >= 0) {
            const own = painting[p.from] || (painting[p.from] = {});
            own[p.kind] = colour;
          }
        }
      });
      d.display.forEach(function (ci, k) {
        const c = grid.columns[ci];
        const raw = grid.cells[ci][r];
        const f = d.formats[ci];
        let text = raw;
        if (f && c.numeric) {
          text = LOOK.formatNumber(f, grid.values[ci][r], raw);
          if (text !== raw) {
            counts.formatted++;
          }
        }
        let cls = (c.key ? "key" : "") + (c.numeric || c.temporal ? " num" : "") + (f && f.kind === "code" ? " code" : "") + (k < d.frozen ? " frozen" : "");
        const was = marks && !added ? marks.changed.get(ci + ":" + r) : undefined;
        if (was !== undefined) {
          cls += " changed";
        } else if (marks && marks.columns.has(ci)) {
          cls += " added";
        }
        const td = el("td", cls, text);
        td.title = was !== undefined ? raw + "\nwas: " + (was === "" ? "(null)" : was) : raw;
        if (k < d.frozen) {
          td.style.left = d.lefts[k];
        }
        if (cellMenu) {
          // Double-click, or right-click for the editor's menu, to drill down
          // or to edit the cell.
          td.setAttribute("data-c", ci);
          td.setAttribute("data-r", r);
          td.setAttribute("data-vscode-context", JSON.stringify({ webviewSection: "cell", column: ci, row: r, preventDefaultContextMenuItems: false }));
        }
        // A cell the diff marks keeps the diff's colour; then a rule's, a
        // colour column's, and the heatmap's.
        const marked = was !== undefined || added;
        let filled = false;
        const rule = d.rules[ci] ? d.rules[ci].get(r) : undefined;
        if (rule) {
          counts.ruled++;
          if (rule.background && !marked) {
            td.style.backgroundColor = tint(rule.background);
            filled = true;
          }
          if (rule.color) {
            td.style.color = rule.color;
          }
          if (rule.bold) {
            td.style.fontWeight = "bold";
          }
        }
        const given = painting[ci] || painting[-1];
        if (given) {
          if (given.bg && !filled && !marked) {
            td.style.backgroundColor = given.bg;
            filled = true;
          }
          if (given.fg && !(rule && rule.color)) {
            td.style.color = given.fg;
          }
        }
        const chart = d.cells[ci];
        if (chart && chart.kind === "bar") {
          const level = chart.levels[r];
          if (level) {
            td.style.backgroundImage = LOOK.barBackground(level, d.colour);
            counts.bars++;
          }
        } else if (chart && chart.kind === "spark") {
          const values = LOOK.parseNumbers(raw);
          const url = values ? LOOK.sparkUrl(values, d.colour) : null;
          if (url) {
            td.style.backgroundImage = url;
            td.style.backgroundSize = "100% 100%";
            td.style.backgroundRepeat = "no-repeat";
            td.textContent = "";
            td.className += " spark";
            counts.sparks++;
          }
        }
        const level = heat[ci] && !marked && !filled ? heat[ci][r] : null;
        if (level !== null && level !== undefined) {
          td.style.backgroundColor = heatColour(level);
        }
        tr.append(td);
      });
      out.push(tr);
    }
    if (at.after > 0) {
      out.push(spacer(at.after));
    }
    body.replaceChildren.apply(body, out);
    dress = counts;
    // Near the end of the rows held: ask the process for the next page.
    if (result.more && !moreAsked && rows.length > 0 && end >= rows.length - 10) {
      moreAsked = true;
      vscode.postMessage({ type: "more", id: result.id });
    }
  }

  // --- pivot

  function drawPivot() {
    const grid = result.grid;
    pivotView.replaceChildren();
    if (!state.pivot) {
      state.pivot = defaultPivot(grid);
    }
    const spec = state.pivot;
    const controls = el("div", "controls");
    const choose = function (label, key, options) {
      const box = el("label", "", label + " ");
      const select = el("select");
      options.forEach(function (o) {
        const opt = el("option", "", o[1]);
        opt.value = String(o[0]);
        opt.selected = String(o[0]) === String(spec[key]);
        select.append(opt);
      });
      select.addEventListener("change", function () {
        spec[key] = key === "agg" ? select.value : Number(select.value);
        save();
        drawPivot();
      });
      box.append(select);
      controls.append(box);
    };
    const named = grid.columns.map(function (c, i) { return [i, c.name]; });
    choose("rows", "row", named);
    choose("columns", "column", [[-1, "(none)"]].concat(named));
    choose("values", "value", [[-1, "(rows)"]].concat(named));
    choose("as", "agg", AGGREGATIONS.map(function (a) { return [a, a]; }));
    const p = pivot(grid, rows, spec);
    const copy = el("button", "", "Copy Pivot");
    copy.title = "The pivot as CSV";
    const head = [grid.columns[spec.row] ? grid.columns[spec.row].name : ""].concat(p.columns);
    const csv = function (t) { return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    copy.addEventListener("click", function () {
      const lines = [head.map(csv).join(",")].concat(p.rows.map(function (k, i) { return [k].concat(p.cells[i]).map(csv).join(","); }));
      vscode.postMessage({ type: "copyText", id: result.id, text: lines.join("\n") + "\n" });
    });
    controls.append(copy);
    pivotView.append(controls);
    let note = "Over the " + rows.length.toLocaleString("en-US") + " row" + (rows.length === 1 ? "" : "s") + " shown";
    if (grid.total > rowCount(grid)) {
      note += " of the result's " + grid.total.toLocaleString("en-US");
    }
    pivotView.append(el("p", "note", note + "." + (p.note ? " " + p.note : "")));
    const scroll = el("div", "scroller");
    const table = el("table", "pivot");
    const tr = el("tr");
    head.forEach(function (h, i) { tr.append(el("th", i === 0 ? "key" : "num", h)); });
    const thead = el("thead");
    thead.append(tr);
    const tbody = el("tbody");
    p.rows.forEach(function (k, i) {
      const line = el("tr");
      const key = el("td", "key", k);
      key.title = k;
      line.append(key);
      p.cells[i].forEach(function (v) { line.append(el("td", "num", v)); });
      tbody.append(line);
    });
    table.append(thead, tbody);
    scroll.append(table);
    pivotView.append(scroll);
    rendered({ pivot: { rows: p.rows.length, columns: head, first: p.rows.length ? [p.rows[0]].concat(p.cells[0]) : [], note: p.note } });
  }

  // --- chart

  /// The colours the chart draws its datasets in: the theme's, in turn, or
  /// the one chosen for a series' column (#1019).
  function seriesColours(grid, datasets, theme) {
    return datasets.map(function (d, i) {
      const name = d.column !== undefined && grid.columns[d.column] ? grid.columns[d.column].name : null;
      return (feature("chartPresets") && name && state.colours[name]) || theme.colours[i % theme.colours.length];
    });
  }

  /// The chart drawn, as a preset a saved query keeps (#1019): its kind,
  /// series, right axis, bins, colours and map columns, by name.
  function currentPreset(picked) {
    const grid = result.grid;
    const name = function (c) { return c >= 0 && grid.columns[c] ? grid.columns[c].name : undefined; };
    // A depth chart and a map find their own columns.
    const series = state.kind === "depth" || state.kind === "map" ? [] : picked.map(name);
    const colours = {};
    series.forEach(function (n) {
      if (state.colours[n]) {
        colours[n] = state.colours[n];
      }
    });
    const out = { kind: state.kind, series: series, bins: state.bins, colours: colours };
    if (picked.indexOf(state.y2) >= 0) {
      out.y2 = name(state.y2);
    }
    if (state.kind === "map") {
      if (name(state.mapSize)) {
        out.size = name(state.mapSize);
      }
      if (name(state.mapColour)) {
        out.colour = name(state.mapColour);
      }
    }
    return out;
  }

  /// Draw a preset kept with a saved query: the chart view, its kind and
  /// series by name.
  function applyPreset(grid, preset) {
    const at = function (n) { return grid.columns.findIndex(function (c) { return c.name === n; }); };
    state.view = "chart";
    state.kind = preset.kind;
    state.columns = (preset.series || []).map(at).filter(function (i) { return i >= 0; });
    state.y2 = preset.y2 ? at(preset.y2) : -1;
    if (preset.bins) {
      state.bins = preset.bins;
    }
    state.colours = Object.assign({}, preset.colours || {});
    state.mapSize = preset.size ? at(preset.size) : -1;
    state.mapColour = preset.colour ? at(preset.colour) : -1;
  }

  /// The chart drawn as SVG: chartmore.js's for its kinds, chartspec.js's
  /// for the rest.
  function svgOf(drawn, opts) {
    if (drawn.kind === "depth") {
      return MORE.depthSvg(drawn.data, drawn.look, opts);
    }
    if (drawn.kind === "map") {
      return MORE.mapSvg(drawn.data, drawn.look, opts, WORLD);
    }
    if (drawn.kind === "linked") {
      return MORE.linkedSvg(result.grid, drawn.data, drawn.look, drawn.colours, Object.assign({ range: state.zoom }, opts));
    }
    return C.chartSvg(result.grid, rows, drawn.kind, drawn.data, Object.assign({}, drawn.look, { colours: drawn.colours }), Object.assign({ y2: drawn.y2 }, opts));
  }

  function destroyCharts() {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    panes.forEach(function (p) { p.destroy(); });
    panes = [];
  }

  function drawChart() {
    const grid = result.grid;
    chartView.replaceChildren();
    destroyCharts();
    const theme = C.theme(cssVar);
    const controls = el("div", "controls");
    const kind = el("select");
    const KINDS = kinds();
    if (KINDS.indexOf(state.kind) < 0) {
      state.kind = "line";
    }
    KINDS.forEach(function (k) {
      const o = el("option", "", KIND_NAMES[k] || k[0].toUpperCase() + k.slice(1));
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
    // A depth chart and a map find their columns by name.
    const own = state.kind === "depth" || state.kind === "map";
    const can = C.chartable(grid, state.kind === "linked" ? "line" : state.kind);
    const chosen = chartColumns(can, state.columns);
    const picked = chosen.columns;
    // A candle chart's columns are its open, high, low and close.
    (state.kind === "candlestick" || own ? [] : can).forEach(function (c, i) {
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.checked = picked.indexOf(c) >= 0;
      box.addEventListener("change", function () {
        // By place: a keyed table's key and value columns can share a name.
        state.columns = can.filter(function (x) { return x === c ? box.checked : picked.indexOf(x) >= 0; });
        save();
        drawChart();
      });
      label.append(box, document.createTextNode(" " + grid.columns[c].name));
      if (feature("chartPresets") && box.checked) {
        // A series' own colour, kept with a chart preset.
        const name = grid.columns[c].name;
        const colour = el("input", "swatch");
        colour.type = "color";
        colour.title = "The colour of " + name;
        colour.value = state.colours[name] || (/^#[0-9a-f]{6}$/i.test(theme.colours[picked.indexOf(c) % theme.colours.length]) ? theme.colours[picked.indexOf(c) % theme.colours.length] : "#3794ff");
        colour.addEventListener("change", function () {
          state.colours[name] = colour.value;
          save();
          drawChart();
        });
        label.append(colour);
      }
      controls.append(label);
    });
    if (state.kind === "map") {
      const cols = MORE.mapColumns(grid);
      const choose = function (title, key, test) {
        const label = el("label", "", title + " ");
        const select = el("select");
        [[-1, "(none)"]].concat(grid.columns.map(function (c, i) { return [i, c.name]; }).filter(function (o) { return o[0] !== cols.lat && o[0] !== cols.lon && test(grid.columns[o[0]]); })).forEach(function (o) {
          const opt = el("option", "", o[1]);
          opt.value = String(o[0]);
          opt.selected = o[0] === state[key];
          select.append(opt);
        });
        select.addEventListener("change", function () {
          state[key] = Number(select.value);
          save();
          drawChart();
        });
        label.append(select);
        controls.append(label);
      };
      choose("size", "mapSize", function (c) { return c.numeric; });
      choose("colour", "mapColour", function () { return true; });
    }
    if (state.kind === "histogram") {
      const label = el("label", "", "bins ");
      const bins = el("input");
      bins.type = "number";
      bins.min = "1";
      bins.max = "500";
      bins.value = String(state.bins);
      bins.addEventListener("change", function () {
        state.bins = binsFrom(bins.value, C.BINS);
        save();
        drawChart();
      });
      label.append(bins);
      controls.append(label);
    }
    const second = feature("charts") && ["histogram", "candlestick", "depth", "map", "linked"].indexOf(state.kind) < 0 && picked.length >= 2;
    if (second) {
      const label = el("label", "", "right axis ");
      const y2 = el("select");
      [[-1, "(none)"]].concat(picked.map(function (c) { return [c, grid.columns[c].name]; })).forEach(function (o) {
        const opt = el("option", "", o[1]);
        opt.value = String(o[0]);
        opt.selected = o[0] === state.y2;
        y2.append(opt);
      });
      y2.addEventListener("change", function () {
        state.y2 = Number(y2.value);
        save();
        drawChart();
      });
      label.append(y2);
      controls.append(label);
    }
    if (feature("charts")) {
      ["png", "svg"].forEach(function (format) {
        const b = el("button", "", "Save " + format.toUpperCase());
        b.title = "Save the chart as a " + format.toUpperCase() + " file";
        b.addEventListener("click", function () { sendImage(format); });
        controls.append(b);
      });
    }
    if (feature("chartPresets")) {
      const keep = el("button", "", "Save with Query");
      keep.title = result.saved
        ? "Keep this chart with the saved query " + result.saved + ", to draw again when it runs"
        : "Save this result's query to Saved Queries with this chart, to draw again when it runs";
      keep.addEventListener("click", function () {
        vscode.postMessage({ type: "chartPreset", id: result.id, preset: currentPreset(picked) });
      });
      controls.append(keep);
    }
    chartView.append(controls);
    let data;
    let summary;
    const y2 = second && picked.indexOf(state.y2) >= 0 ? state.y2 : -1;
    if (state.kind === "depth") {
      data = MORE.depthData(grid, rows);
      summary = C.summary("depth", data);
      summary.datasets = data.datasets.map(function (d) { return { label: d.label, points: d.levels }; });
      if (data.mid !== undefined) {
        summary.mid = data.mid;
        summary.spread = data.spread;
      }
    } else if (state.kind === "map") {
      data = MORE.mapData(grid, rows, { size: state.mapSize, colour: state.mapColour }, theme);
      summary = C.summary("map", data);
      summary.dropped = data.dropped || 0;
      if (data.dropped) {
        chartView.append(el("p", "note", data.dropped.toLocaleString("en-US") + " row" + (data.dropped === 1 ? "" : "s") + " with no latitude and longitude on the map left out."));
      }
    } else if (state.kind === "linked") {
      data = chosen.note ? { x: -1, panes: [], note: chosen.note } : MORE.linkedData(grid, rows, picked);
      summary = { kind: "linked", datasets: data.panes.map(function (p) { return { label: p.label, points: p.data.length }; }) };
      if (data.note) {
        summary.note = data.note;
      }
    } else {
      data = chosen.note && state.kind !== "candlestick" ? { type: "bar", datasets: [], note: chosen.note } : C.chartData(grid, rows, state.kind, picked, state.bins);
      summary = C.summary(state.kind, data);
      if (y2 >= 0) {
        summary.y2 = grid.columns[y2].name;
      }
    }
    const preset = feature("chartPresets") ? currentPreset(picked) : undefined;
    drawnChart = null;
    if (data.note || typeof Chart !== "function") {
      const note = data.note || "The chart library did not load.";
      chartView.append(el("p", "note", note));
      summary.note = note;
      rendered({ chart: summary, preset: preset });
      return;
    }
    C.applyTheme(Chart, theme);
    if (state.kind === "linked") {
      drawLinked(data, theme, summary, preset);
      return;
    }
    const box = el("div", "canvas" + (state.kind === "map" ? " map" : ""));
    const canvas = el("canvas");
    box.append(canvas);
    chartView.append(box);
    let colours = theme.colours;
    let config;
    if (state.kind === "depth") {
      config = MORE.depthConfig(data, theme);
    } else if (state.kind === "map") {
      config = MORE.mapConfig(grid, data, theme, WORLD);
    } else {
      config = C.chartConfig(grid, rows, state.kind, data, theme, undefined, { y2: y2 });
      if (state.kind !== "candlestick") {
        colours = seriesColours(grid, data.datasets, theme);
        config.data.datasets.forEach(function (d, i) {
          if (colours[i] !== theme.colours[i % theme.colours.length]) {
            d.borderColor = colours[i];
            d.backgroundColor = state.kind === "line" || state.kind === "step" ? colours[i] : colours[i] + "99";
          }
        });
      }
    }
    chart = new Chart(canvas, config);
    drawnChart = { kind: state.kind, data: data, look: theme, colours: colours, y2: y2, canvas: canvas };
    plotted();
    rendered({ chart: summary, preset: preset });
  }

  /// Keep the chart drawn in the q Plots view (#970), as the SVG Save SVG
  /// writes.
  function plotted() {
    if (!feature("plots") || !drawnChart) {
      return;
    }
    const canvas = drawnChart.canvas;
    vscode.postMessage({
      type: "plotted",
      id: result.id,
      format: state.kind,
      // At least 640 by 360: a plot drawn in a narrow panel is still one
      // to read, and to save.
      data: svgOf(drawnChart, {
        width: Math.max(640, Math.round(canvas.clientWidth || 800)),
        height: Math.max(360, Math.round(canvas.clientHeight || 450)),
        background: cssVar("--vscode-editor-background", "#ffffff"),
      }),
    });
  }

  /// Linked panes (#1018): one chart per series, stacked on one x axis. A
  /// crosshair follows the mouse over any of them and the line above reads
  /// every series where it is; a drag zooms all of them to its range, and a
  /// double-click goes back to the whole.
  function drawLinked(data, theme, summary, preset) {
    const grid = result.grid;
    const colours = seriesColours(grid, data.panes, theme);
    const view = { range: state.zoom, cursor: null, drag: null };
    const hint = "Move over a pane to read every series; drag to zoom, double-click to show all.";
    const readoutEl = el("div", "readout", hint);
    const box = el("div", "linked");
    chartView.append(readoutEl, box);
    let read = null;
    const canvases = [];
    const report = function () {
      rendered({ chart: summary, preset: preset, linked: { panes: data.panes.map(function (p) { return p.label; }), range: state.zoom, readout: read } });
    };
    const redraw = function () { panes.forEach(function (p) { p.draw(); }); };
    const show = function (x) {
      read = x === null ? null : MORE.readout(grid, data, x);
      readoutEl.textContent = read ? read.x + "   " + read.values.map(function (v) { return v.label + " " + v.text; }).join("  ·  ") : hint;
    };
    const full = function () {
      if (view.range) {
        return view.range.max - view.range.min;
      }
      let lo = Infinity;
      let hi = -Infinity;
      data.panes.forEach(function (p) { p.data.forEach(function (pt) { lo = Math.min(lo, pt.x); hi = Math.max(hi, pt.x); }); });
      return hi - lo;
    };
    const zoom = function (range) {
      state.zoom = range;
      view.range = range;
      save();
      panes.forEach(function (p) {
        p.options.scales.x.min = range ? range.min : undefined;
        p.options.scales.x.max = range ? range.max : undefined;
        p.update("none");
      });
      report();
    };
    data.panes.forEach(function (p, k) {
      const holder = el("div", "pane");
      const canvas = el("canvas");
      holder.append(canvas);
      box.append(holder);
      canvases.push(canvas);
      const pane = new Chart(canvas, MORE.linkedConfig(grid, data, p, colours[k], theme, view, k === data.panes.length - 1));
      panes.push(pane);
      const xAt = function (event) {
        const v = pane.scales && pane.scales.x ? pane.scales.x.getValueForPixel(event.offsetX) : null;
        return typeof v === "number" && isFinite(v) ? v : null;
      };
      canvas.addEventListener("mousemove", function (event) {
        const x = xAt(event);
        view.cursor = x;
        if (view.drag && x !== null) {
          view.drag.to = x;
        }
        show(x);
        redraw();
      });
      canvas.addEventListener("mouseleave", function () {
        view.cursor = null;
        show(null);
        redraw();
      });
      canvas.addEventListener("mousedown", function (event) {
        const x = xAt(event);
        view.drag = x === null ? null : { from: x, to: x };
      });
      canvas.addEventListener("mouseup", function (event) {
        const drag = view.drag;
        view.drag = null;
        if (!drag) {
          return;
        }
        const x = xAt(event);
        const range = MORE.zoomRange(drag.from, x === null ? drag.to : x, full());
        if (range) {
          zoom(range);
        } else {
          redraw();
          report();
        }
      });
      canvas.addEventListener("dblclick", function () { zoom(null); });
    });
    drawnChart = { kind: "linked", data: data, look: theme, colours: colours, y2: -1, canvas: canvases[0] || null, canvases: canvases };
    if (drawnChart.canvas) {
      plotted();
    }
    report();
  }

  /// Send the chart drawn as `format` to the extension to save: a PNG of
  /// the canvas (linked panes stacked) on the editor's background, or the
  /// SVG of the same data. An empty image when no chart is drawn. `key`:
  /// the command's request it answers.
  function sendImage(format, key) {
    let data = "";
    if (drawnChart && drawnChart.canvas) {
      const background = cssVar("--vscode-editor-background", "#ffffff");
      const canvases = drawnChart.canvases && drawnChart.canvases.length ? drawnChart.canvases : [drawnChart.canvas];
      const canvas = drawnChart.canvas;
      if (format === "png") {
        const out = document.createElement("canvas");
        out.width = Math.max.apply(null, canvases.map(function (c) { return c.width || 0; }));
        out.height = canvases.reduce(function (h, c) { return h + (c.height || 0); }, 0);
        const ctx = out.getContext("2d");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, out.width, out.height);
        let y = 0;
        canvases.forEach(function (c) {
          ctx.drawImage(c, 0, y);
          y += c.height || 0;
        });
        data = out.toDataURL("image/png");
      } else {
        data = svgOf(drawnChart, {
          width: Math.round(canvas.clientWidth || 800),
          height: Math.round(canvases.reduce(function (h, c) { return h + (c.clientHeight || 0); }, 0) || 450),
          background: background,
        });
      }
    }
    vscode.postMessage({ type: "image", id: result.id, format: format, data: data, key: key });
  }

  // --- correlation (#1020)

  function drawCorr() {
    const grid = result.grid;
    corrView.replaceChildren();
    const corr = LOOK.correlation(grid, rows);
    const fixed = function (r) { return r === null ? "" : r.toFixed(3); };
    const controls = el("div", "controls");
    const copy = el("button", "", "Copy Matrix");
    copy.title = "The correlation matrix as CSV";
    const csv = function (t) { return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    copy.addEventListener("click", function () {
      const lines = [[""].concat(corr.names).map(csv).join(",")].concat(corr.names.map(function (n, i) { return [n].concat(corr.r[i].map(function (r) { return r === null ? "" : String(r); })).map(csv).join(","); }));
      vscode.postMessage({ type: "copyText", id: result.id, text: lines.join("\n") + "\n" });
    });
    controls.append(copy);
    corrView.append(controls);
    corrView.append(el("p", "note", "Pearson correlation of the numeric columns over the " + rows.length.toLocaleString("en-US") + " row" + (rows.length === 1 ? "" : "s") + " shown; each pair over the rows where both are not null. Key columns are left out."));
    const scroll = el("div", "scroller");
    const matrix = el("table", "corr");
    const head = el("tr");
    head.append(el("th", "key", ""));
    corr.names.forEach(function (n) { head.append(el("th", "num", n)); });
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    corr.names.forEach(function (n, i) {
      const tr = el("tr");
      tr.append(el("td", "key", n));
      corr.r[i].forEach(function (r, j) {
        const td = el("td", "num", fixed(r));
        td.title = n + " and " + corr.names[j] + ": " + (r === null ? "no correlation (too few rows, or a column that does not vary)" : fixed(r)) + " over " + corr.n[i][j] + " row" + (corr.n[i][j] === 1 ? "" : "s");
        if (r !== null) {
          td.style.backgroundColor = heatColour(r);
        }
        tr.append(td);
      });
      tbody.append(tr);
    });
    matrix.append(thead, tbody);
    const pairs = el("table", "corr-pairs");
    const ph = el("tr");
    ["column", "with", "correlation", "rows"].forEach(function (h, i) { ph.append(el("th", i >= 2 ? "num" : "", h)); });
    const pthead = el("thead");
    pthead.append(ph);
    const pbody = el("tbody");
    LOOK.correlationPairs(corr).forEach(function (p) {
      const tr = el("tr");
      [[p.a, ""], [p.b, ""], [fixed(p.r), "num"], [String(p.n), "num"]].forEach(function (cell) { tr.append(el("td", cell[1], cell[0])); });
      pbody.append(tr);
    });
    pairs.append(pthead, pbody);
    scroll.append(matrix, el("h4", "", "Pairs, strongest first"), pairs);
    corrView.append(scroll);
    rendered({ corr: { names: corr.names, r: corr.r } });
  }

  function draw() {
    if (!result) {
      return;
    }
    if (!VIEWS[state.view] || !offered(state.view)) {
      state.view = "grid";
    }
    marks = comparing() ? diffMarks(result.diff) : null;
    drawTabs();
    drawBar();
    gridView.hidden = state.view !== "grid";
    chartView.hidden = state.view !== "chart";
    statsView.hidden = state.view !== "stats";
    treeView.hidden = state.view !== "tree";
    pivotView.hidden = state.view !== "pivot";
    corrView.hidden = state.view !== "corr";
    if (state.view !== "chart") {
      destroyCharts();
    }
    if (state.view === "grid") {
      drawGrid();
      rendered();
    } else if (state.view === "stats") {
      drawStats();
    } else if (state.view === "tree") {
      drawTree();
    } else if (state.view === "pivot") {
      drawPivot();
    } else if (state.view === "corr") {
      drawCorr();
    } else {
      drawChart();
    }
  }

  /// What is kept of a result's page when another is chosen from the tabs.
  const PER_RESULT = ["view", "sort", "filters", "columns", "top", "open", "names", "pivot", "y2", "colours", "mapSize", "mapColour", "zoom"];

  window.addEventListener("message", function (event) {
    const m = event.data;
    if (!m || m.type !== "result") {
      return;
    }
    const names = m.grid.columns.map(function (c) { return c.name; }).join("\u0000");
    const kept = (m.history || []).map(function (h) { return h.id; });
    if (m.id !== state.id) {
      // The page of the result left, to go back to from its tab.
      const mine = {};
      PER_RESULT.forEach(function (k) { mine[k] = state[k]; });
      state.saved[state.id] = mine;
      const back = state.saved[m.id];
      if (back) {
        // A result chosen again from the tabs: as it was left.
        Object.assign(state, back);
      } else {
        // A new result: the view its mode asks for; the sort, filters and
        // chosen columns only if it has the same columns.
        if (names !== state.names) {
          state.sort = null;
          state.filters = [];
          state.columns = null;
        }
        if (names !== state.names) {
          state.pivot = null;
          state.y2 = -1;
          state.colours = {};
          state.mapSize = -1;
          state.mapColour = -1;
          state.zoom = null;
          // An order book is drawn as its depth (#1016) when its columns fit.
          if ((!m.features || m.features.depthChart !== false) && MORE.depthColumns(m.grid)) {
            state.kind = "depth";
          }
        }
        state.view = m.view;
        state.top = 0;
        state.open = [""];
        state.names = names;
        // A saved query's chart, kept with it (#1019), is drawn again.
        if (m.look && m.look.chart && (!m.features || m.features.chartPresets !== false)) {
          applyPreset(m.grid, m.look.chart);
        }
      }
      state.id = m.id;
    }
    Object.keys(state.saved).forEach(function (id) {
      if (kept.indexOf(id) < 0 || id === m.id) {
        delete state.saved[id];
      }
    });
    // A command's request, once: Show Column Statistics, Show as Tree,
    // Compare with Previous Run, Show as Pivot, Save Result Chart.
    let image = null;
    if (m.control && m.control.key !== state.control) {
      state.control = m.control.key;
      if (m.control.action === "image") {
        state.view = "chart";
        image = m.control;
      } else if (m.control.action === "view") {
        state.view = m.control.view;
      } else if (m.control.action === "compare") {
        state.compare = true;
        state.view = "grid";
      }
    }
    heat = m.heatmap
      ? m.grid.columns.map(function (c, i) { return c.numeric && !c.key ? heatLevels(m.grid.values[i]) : null; })
      : [];
    result = m;
    moreAsked = false;
    rows = visibleRows(m.grid, state.filters, state.sort);
    save();
    draw();
    if (image) {
      sendImage(image.format, image.key);
    }
  });
  window.addEventListener("resize", paint);
  // The editor marks a new theme on the body's class, and the chart's
  // colours are read from the theme when it is drawn: draw it again.
  new MutationObserver(function () {
    if (result && state.view === "chart") {
      drawChart();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  vscode.postMessage({ type: "ready" });
})(typeof self !== "undefined" ? self : this);
