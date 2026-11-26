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
  // The sort chosen, kept in the page's state: the panel does not keep its
  // page while hidden, and shown again it reloads (#2080).
  const kept = vscode.getState() || {};
  let sortBy = ["fn", "calls", "total", "self", "mean", "max"].indexOf(kept.sortBy) >= 0 ? kept.sortBy : "total";
  let descending = typeof kept.descending === "boolean" ? kept.descending : true;

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

  // linetimings.ts durationText, kept identical (profile.test.js runs both):
  // the unit picked as rounded, so 999.9 µs is 1.00 ms (#1437).
  function duration(ns) {
    const us = (ns / 1e3).toFixed(ns < 1e4 ? 1 : 0);
    if (ns < 1e6 && Number(us) < 1000) {
      return us + " µs";
    }
    const ms = (ns / 1e6).toFixed(ns < 1e7 ? 2 : ns < 1e8 ? 1 : 0);
    if (ns < 6e10 && Number(ms) < 60000) {
      return ms + " ms";
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
      p.functions + " function" + (p.functions === 1 ? "" : "s") + " of " + p.namespace + " timed",
      p.calls + " call" + (p.calls === 1 ? "" : "s") + " in " + duration(p.total),
    ];
    if (p.recorded < p.calls) {
      parts.push("the first " + p.recorded + " recorded");
    }
    return parts.join(", ") + ".";
  }

  // What became of the functions after the run: all put back, but for the
  // ones the run itself defined anew, which are as it left them (#2980).
  function putBack(p) {
    if (p.kept.length === 0) {
      return "Every function was put back as it was.";
    }
    const one = p.kept.length === 1;
    return (
      "The run itself defined " + p.kept.join(", ") + " anew: " + (one ? "it is" : "they are") + " as the run left " + (one ? "it" : "them") +
      ". Every other function was put back as it was."
    );
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
      // A button in the header, so the keyboard reaches it and a screen
      // reader hears the order (#1252); focus stays on it as it re-renders.
      const th = element("th", col.key === sortBy ? "sorted" : "");
      th.setAttribute("aria-sort", col.key !== sortBy ? "none" : descending ? "descending" : "ascending");
      const button = element("button", "sort", col.label + (col.key === sortBy ? (descending ? " ▼" : " ▲") : ""));
      button.type = "button";
      button.title = "Sort by " + col.label;
      button.addEventListener("click", function () {
        if (sortBy === col.key) {
          descending = !descending;
        } else {
          sortBy = col.key;
          descending = col.key !== "fn";
        }
        vscode.setState({ sortBy: sortBy, descending: descending });
        render();
        const again = document.querySelector('th button[data-key="' + col.key + '"]');
        if (again) {
          again.focus();
        }
      });
      button.setAttribute("data-key", col.key);
      th.appendChild(button);
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
          duration(p.overheadTotal) + " in all; a function's time includes it for each call it makes. " + putBack(p),
      ),
    );
    if (p.untimed.length > 0) {
      header.appendChild(
        element("div", "note", "Not timed, their text being one the timing cannot be written into: " + p.untimed.join(", ") + ". Their time is counted in their callers'."),
      );
    }
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
