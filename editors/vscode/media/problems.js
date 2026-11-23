// The problems dashboard (#992): a folder's findings by rule and by folder,
// and their count over commits. What is shown is worked out by the extension
// (`problems.ts`); this only lays it out. Every name goes in as text.
(function () {
  "use strict";
  if (typeof acquireVsCodeApi !== "function") {
    return;
  }
  const vscode = acquireVsCodeApi();
  const SVG = "http://www.w3.org/2000/svg";

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

  function svg(tag, attributes) {
    const e = document.createElementNS(SVG, tag);
    Object.keys(attributes).forEach(function (k) {
      e.setAttribute(k, String(attributes[k]));
    });
    return e;
  }

  function button(label, type) {
    const b = element("button", "", label);
    b.addEventListener("click", function () {
      vscode.postMessage({ type: type });
    });
    return b;
  }

  function table(columns, rows) {
    const t = element("table");
    const head = element("tr");
    columns.forEach(function (c) {
      head.appendChild(element("th", c.number ? "number" : "", c.label));
    });
    t.appendChild(head);
    rows.forEach(function (r) {
      const tr = element("tr");
      columns.forEach(function (c) {
        tr.appendChild(element("td", c.number ? "number" : c.className || "", String(c.value(r))));
      });
      t.appendChild(tr);
    });
    return t;
  }

  function card(label, value, className) {
    const c = element("div", "card " + (className || ""));
    c.appendChild(element("div", "value", String(value)));
    c.appendChild(element("div", "label", label));
    return c;
  }

  function trend(points) {
    const width = 640;
    const height = 160;
    const pad = 28;
    const max = points.reduce(function (m, p) {
      return Math.max(m, p.total);
    }, 1);
    const chart = svg("svg", { viewBox: "0 0 " + width + " " + height, class: "trend", role: "img" });
    // An image hides its dots' titles from a screen reader: it says the trend itself.
    const counts = function (p) {
      return p.total + (p.total === 1 ? " finding and " : " findings and ") + p.errors + (p.errors === 1 ? " error at " : " errors at ") + p.commit.slice(0, 8);
    };
    chart.setAttribute("aria-label", "Findings over " + points.length + (points.length === 1 ? " commit: " : " commits: from " + counts(points[0]) + " to ") + counts(points[points.length - 1]));
    const step = points.length > 1 ? (width - 2 * pad) / (points.length - 1) : 0;
    const x = function (i) {
      return points.length > 1 ? pad + i * step : width / 2;
    };
    const y = function (v) {
      return height - pad - ((height - 2 * pad) * v) / max;
    };
    chart.appendChild(svg("line", { x1: pad, y1: height - pad, x2: width - pad, y2: height - pad, class: "axis" }));
    const label = svg("text", { x: 2, y: y(max) + 4, class: "tick" });
    label.textContent = String(max);
    chart.appendChild(label);
    ["total", "errors"].forEach(function (key) {
      if (points.length > 1) {
        chart.appendChild(
          svg("polyline", {
            points: points
              .map(function (p, i) {
                return x(i) + "," + y(p[key]);
              })
              .join(" "),
            class: "series " + key,
          }),
        );
      }
      points.forEach(function (p, i) {
        const dot = svg("circle", { cx: x(i), cy: y(p[key]), r: 3, class: "dot " + key });
        const title = svg("title", {});
        title.textContent = p.commit.slice(0, 8) + " " + p.date.slice(0, 10) + " " + p.subject + ": " + p.total + " findings, " + p.errors + " errors";
        dot.appendChild(title);
        chart.appendChild(dot);
      });
    });
    return chart;
  }

  function render(v) {
    document.body.textContent = "";
    const header = element("header");
    header.appendChild(element("h1", "", "Problems in " + v.folder));
    header.appendChild(
      element(
        "div",
        "note",
        "qlinter over the folder at " + new Date(v.at).toLocaleString() +
          (v.commit ? ", on commit " + v.commit.slice(0, 8) + (v.clean ? "" : " with q files changed since (not added to the trend)") : ", outside git (no trend)") +
          ".",
      ),
    );
    const actions = element("div", "actions");
    actions.appendChild(button("Refresh", "refresh"));
    if (v.commit) {
      actions.appendChild(button("Lint Earlier Commits...", "history"));
    }
    header.appendChild(actions);
    document.body.appendChild(header);
    const s = v.summary;
    const cards = element("div", "cards");
    cards.appendChild(card("findings", s.total));
    cards.appendChild(card("errors", s.errors, s.errors > 0 ? "errors" : ""));
    cards.appendChild(card("warnings", s.warnings));
    cards.appendChild(card("files", s.files));
    document.body.appendChild(cards);

    document.body.appendChild(element("h2", "", "Trend over commits"));
    if (v.trend.length === 0) {
      document.body.appendChild(element("div", "note", "No commit yet: refresh on a commit with no q file changed, or lint earlier commits."));
    } else {
      document.body.appendChild(trend(v.trend));
      const last = v.trend.slice(-10).reverse();
      document.body.appendChild(
        table(
          [
            { label: "commit", value: (p) => p.commit.slice(0, 8), className: "mono" },
            { label: "date", value: (p) => p.date.slice(0, 10) },
            { label: "subject", value: (p) => p.subject },
            { label: "findings", value: (p) => p.total, number: true },
            { label: "errors", value: (p) => p.errors, number: true },
          ],
          last,
        ),
      );
    }
    const grid = element("div", "grid");
    const rules = element("section");
    rules.appendChild(element("h2", "", "By rule"));
    rules.appendChild(
      s.rules.length === 0
        ? element("div", "note", "No findings.")
        : table(
            [
              { label: "code", value: (r) => r.code, className: "mono" },
              { label: "rule", value: (r) => r.rule },
              { label: "severity", value: (r) => r.severity },
              { label: "findings", value: (r) => r.count, number: true },
              { label: "files", value: (r) => r.files, number: true },
            ],
            s.rules,
          ),
    );
    const folders = element("section");
    folders.appendChild(element("h2", "", "By folder"));
    folders.appendChild(
      s.folders.length === 0
        ? element("div", "note", "No findings.")
        : table(
            [
              { label: "folder", value: (f) => f.folder, className: "mono" },
              { label: "findings", value: (f) => f.count, number: true },
              { label: "errors", value: (f) => f.errors, number: true },
              { label: "files", value: (f) => f.files, number: true },
            ],
            s.folders,
          ),
    );
    grid.appendChild(rules);
    grid.appendChild(folders);
    document.body.appendChild(grid);
    vscode.postMessage({
      type: "rendered",
      id: v.id,
      rendered: { total: s.total, rules: s.rules.length, folders: s.folders.length, points: v.trend.length },
    });
  }

  window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "problems") {
      render(event.data);
    }
  });
  vscode.postMessage({ type: "ready" });
})();
