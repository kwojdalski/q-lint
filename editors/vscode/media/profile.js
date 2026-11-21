// The function profile panel (#987): the functions of one namespace timed
// over one run, as a table sortable by any column and a flame chart of the
// calls. What is shown is worked out by the extension (`profile.ts`); this
// only lays it out. Every name goes in as text.
(function () {
  "use strict";
  if (typeof acquireVsCodeApi !== "function") {
    return;
  }
  const vscode = acquireVsCodeApi();
  let shown;
  let sortBy = "total";
  let descending = true;

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

  function duration(ns) {
    if (ns < 1e6) {
      return (ns / 1e3).toFixed(ns < 1e4 ? 1 : 0) + " µs";
    }
    if (ns < 6e10) {
      return (ns / 1e6).toFixed(ns < 1e7 ? 2 : ns < 1e8 ? 1 : 0) + " ms";
    }
    return (ns / 1e9).toFixed(1) + " s";
  }

  const COLUMNS = [
    { key: "fn", label: "function", text: (s) => s.fn },
    { key: "calls", label: "calls", text: (s) => String(s.calls) },
    { key: "total", label: "total", text: (s) => duration(s.total) },
    { key: "self", label: "self", text: (s) => duration(s.self) },
    { key: "mean", label: "per call", text: (s) => duration(s.mean) },
    { key: "max", label: "longest", text: (s) => duration(s.max) },
  ];

  function summary(p) {
    const parts = [
      p.functions + " function" + (p.functions === 1 ? "" : "s") + " of " + p.namespace + " wrapped",
      p.calls + " call" + (p.calls === 1 ? "" : "s") + " in " + duration(p.total),
    ];
    if (p.recorded < p.calls) {
      parts.push("the first " + p.recorded + " recorded");
    }
    return parts.join(", ") + ".";
  }

  function sorted(stats) {
    const out = stats.slice();
    out.sort(function (a, b) {
      const x = a[sortBy];
      const y = b[sortBy];
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return descending ? -c : c;
    });
    return out;
  }

  function table(p) {
    const t = element("table", "stats");
    const head = element("tr");
    COLUMNS.forEach(function (col) {
      const th = element("th", col.key === sortBy ? "sorted" : "", col.label + (col.key === sortBy ? (descending ? " ▼" : " ▲") : ""));
      th.title = "Sort by " + col.label;
      th.addEventListener("click", function () {
        if (sortBy === col.key) {
          descending = !descending;
        } else {
          sortBy = col.key;
          descending = col.key !== "fn";
        }
        render();
      });
      head.appendChild(th);
    });
    t.appendChild(head);
    sorted(p.stats).forEach(function (s) {
      const tr = element("tr");
      COLUMNS.forEach(function (col) {
        tr.appendChild(element("td", col.key === "fn" ? "name" : "number", col.text(s)));
      });
      t.appendChild(tr);
    });
    return t;
  }

  function flame(p) {
    const box = element("div", "flame");
    const width = p.frames.reduce(function (w, f) {
      return f.depth === 0 ? w + f.duration : w;
    }, 0);
    const depth = p.frames.reduce(function (d, f) {
      return Math.max(d, f.depth + 1);
    }, 0);
    box.style.height = depth * 20 + "px";
    p.frames.forEach(function (f) {
      const frame = element("div", "frame", f.fn);
      frame.style.left = (width === 0 ? 0 : (100 * f.offset) / width) + "%";
      frame.style.width = (width === 0 ? 0 : (100 * f.duration) / width) + "%";
      frame.style.top = f.depth * 20 + "px";
      frame.title = f.fn + ": " + duration(f.duration) + " in " + f.calls + " call" + (f.calls === 1 ? "" : "s");
      box.appendChild(frame);
    });
    return box;
  }

  function render() {
    if (!shown) {
      return;
    }
    const p = shown;
    document.body.textContent = "";
    const header = element("header");
    header.appendChild(element("code", "query", p.code));
    header.appendChild(element("div", "summary" + (p.error ? " failed" : ""), summary(p)));
    if (p.error) {
      header.appendChild(element("div", "note failed", "The run stopped with an error: " + p.error + ". The calls up to it are shown."));
    }
    header.appendChild(
      element(
        "div",
        "note",
        "Timed on " + p.process + " by .z.p. The timing adds about " + duration(p.overheadPerCall) + " a call, measured there, " +
          duration(p.overheadTotal) + " in all; a function's time includes it for each call it makes. Every function was put back as it was.",
      ),
    );
    document.body.appendChild(header);
    document.body.appendChild(element("h2", "", "Functions"));
    if (p.stats.length === 0) {
      document.body.appendChild(element("div", "note", "No function of " + p.namespace + " was called by name."));
    } else {
      document.body.appendChild(table(p));
      document.body.appendChild(element("h2", "", "Calls"));
      document.body.appendChild(flame(p));
    }
    vscode.postMessage({
      type: "rendered",
      id: p.id,
      rendered: { rows: p.stats.length, frames: p.frames.length, sortedBy: sortBy + (descending ? " desc" : " asc"), summary: summary(p) },
    });
  }

  window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "profile") {
      shown = event.data;
      render();
    }
  });
  vscode.postMessage({ type: "ready" });
})();
