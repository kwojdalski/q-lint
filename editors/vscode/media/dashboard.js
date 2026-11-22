// A dashboard of saved queries (#1030): a grid of tiles, each a saved query
// shown as a table or a chart, with its own Refresh, interval and view. What
// a tile shows is worked out by the extension (`dashboardview.ts`); this only
// lays it out and reports what was clicked. Every name and cell goes in as
// text; a chart is an SVG image.
(function () {
  "use strict";
  if (typeof acquireVsCodeApi !== "function") {
    return;
  }
  const vscode = acquireVsCodeApi();
  const tiles = new Map();

  function element(tag, className, text) {
    const e = document.createElement(tag);
    if (className) {
      e.className = className;
    }
    if (text !== undefined) {
      e.textContent = text;
    }
    return e;
  }

  function button(text, title, message) {
    const b = element("button", "", text);
    b.title = title;
    b.addEventListener("click", () => vscode.postMessage(message));
    return b;
  }

  function select(options, value, label, onChange) {
    const s = element("select");
    s.title = label;
    options.forEach((o) => {
      const opt = element("option", "", o.text);
      opt.value = String(o.value);
      opt.selected = String(o.value) === String(value);
      s.appendChild(opt);
    });
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  const every = (s) => (s === 0 ? "refresh off" : s < 60 ? "every " + s + " s" : "every " + s / 60 + " min");
  const svgUrl = (svg) => "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));

  function layout(m) {
    document.body.textContent = "";
    tiles.clear();
    const head = element("header");
    head.appendChild(element("h1", "", m.name));
    head.appendChild(button("Add Tile", "Add a saved query to this dashboard", { type: "add" }));
    head.appendChild(button("Refresh All", "Run every tile now", { type: "refresh-all" }));
    head.appendChild(
      select([1, 2, 3, 4].map((n) => ({ value: n, text: n + (n === 1 ? " column" : " columns") })), m.columns, "Tiles a row", (v) =>
        vscode.postMessage({ type: "columns", columns: Number(v) }),
      ),
    );
    document.body.appendChild(head);
    if (m.tiles.length === 0) {
      document.body.appendChild(element("p", "note", "No tiles yet. Add Tile, or Add to Dashboard on a saved query, puts one here."));
      return;
    }
    const grid = element("main", "grid");
    grid.style.gridTemplateColumns = "repeat(" + m.columns + ", minmax(0, 1fr))";
    m.tiles.forEach((t, i) => {
      const tile = element("section", "tile");
      const bar = element("div", "bar");
      bar.appendChild(element("span", "title", t.query));
      bar.appendChild(element("span", "process", t.process));
      const status = element("span", "status", "");
      bar.appendChild(status);
      const tools = element("span", "tools");
      tools.appendChild(button("Refresh", "Run it now", { type: "refresh", id: t.id }));
      tools.appendChild(select(m.intervals.map((s) => ({ value: s, text: every(s) })), t.refresh, "Refresh interval", (v) => vscode.postMessage({ type: "refresh-interval", id: t.id, seconds: Number(v) })));
      tools.appendChild(select(m.views.map((v) => ({ value: v, text: v })), t.view, "Show as", (v) => vscode.postMessage({ type: "view", id: t.id, view: v })));
      if (i > 0) {
        tools.appendChild(button("◀", "Move it earlier", { type: "move", id: t.id, by: -1 }));
      }
      if (i < m.tiles.length - 1) {
        tools.appendChild(button("▶", "Move it later", { type: "move", id: t.id, by: 1 }));
      }
      tools.appendChild(button("✕", "Remove it from the dashboard", { type: "remove", id: t.id }));
      bar.appendChild(tools);
      tile.appendChild(bar);
      const body = element("div", "body");
      body.appendChild(element("p", "note", "Not run yet."));
      tile.appendChild(body);
      grid.appendChild(tile);
      tiles.set(t.id, { body: body, status: status });
    });
    document.body.appendChild(grid);
  }

  function show(id, content, at) {
    const t = tiles.get(id);
    if (!t) {
      return;
    }
    t.body.textContent = "";
    t.status.textContent = at ? "at " + at : "";
    if (content.kind === "error") {
      t.body.appendChild(element("pre", "failed", content.text));
    } else if (content.kind === "text") {
      t.body.appendChild(element("pre", "", content.text));
    } else if (content.kind === "chart") {
      const img = element("img", "chart");
      img.alt = "chart";
      img.src = svgUrl(content.svg);
      t.body.appendChild(img);
      t.body.appendChild(element("p", "note", content.total + " rows"));
    } else {
      const table = element("table");
      const head = element("tr");
      content.columns.forEach((c) => head.appendChild(element("th", "", c)));
      table.appendChild(head);
      content.rows.forEach((r) => {
        const tr = element("tr");
        r.forEach((c) => tr.appendChild(element("td", "", c)));
        table.appendChild(tr);
      });
      t.body.appendChild(table);
      if (content.total > content.rows.length) {
        t.body.appendChild(element("p", "note", "First " + content.rows.length + " of " + content.total + " rows."));
      }
    }
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "layout") {
      layout(m);
    } else if (m.type === "tile") {
      show(m.id, m.content, m.at);
    } else if (m.type === "running") {
      const t = tiles.get(m.id);
      if (t) {
        t.status.textContent = "running…";
      }
    }
  });
  vscode.postMessage({ type: "ready" });
})();
