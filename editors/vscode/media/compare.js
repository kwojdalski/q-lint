// The Compare Query panel (#907): two processes' answers to one query,
// side by side. What is compared is worked out by the extension
// (`compare.ts`); this only lays it out. Every value goes in as text.
(function () {
  "use strict";
  if (typeof acquireVsCodeApi !== "function") {
    return;
  }
  const vscode = acquireVsCodeApi();

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

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function summary(c) {
    const l = c.left.process;
    const r = c.right.process;
    if (c.same) {
      return l + " and " + r + " gave the same answer.";
    }
    if (c.columns.length === 0) {
      return l + " and " + r + " gave different answers.";
    }
    const parts = [];
    if (c.differing > 0) {
      parts.push(plural(c.differing, "cell differs", "cells differ"));
    }
    if (c.onlyLeft > 0) {
      parts.push(plural(c.onlyLeft, "row", "rows") + " only on " + l);
    }
    if (c.onlyRight > 0) {
      parts.push(plural(c.onlyRight, "row", "rows") + " only on " + r);
    }
    if (parts.length === 0) {
      parts.push("the rows held are the same, the columns or row counts are not");
    }
    return parts.join(", ") + " (rows lined up by " + (c.matchedBy === "key" ? "key" : "place") + ").";
  }

  function textSides(c) {
    const box = element("div", "sides");
    [c.left, c.right].forEach(function (s) {
      const pane = element("div", "side");
      pane.appendChild(element("h2", "", s.process + (s.kind === "error" ? " - failed" : "")));
      pane.appendChild(element("pre", s.kind === "error" ? "error" : c.same ? "" : "changed", s.text || ""));
      box.appendChild(pane);
    });
    return box;
  }

  function table(c) {
    const t = element("table");
    const head = element("thead");
    const top = element("tr");
    const n = c.columns.length;
    const title = function (s) {
      const th = element("th", "process", s.process + (s.total !== undefined ? " (" + plural(s.total, "row", "rows") + ")" : ""));
      th.colSpan = n;
      return th;
    };
    top.appendChild(title(c.left));
    top.appendChild(element("th", "gap"));
    top.appendChild(title(c.right));
    head.appendChild(top);
    const names = element("tr");
    [c.inLeft, null, c.inRight].forEach(function (has) {
      if (has === null) {
        names.appendChild(element("th", "gap"));
        return;
      }
      c.columns.forEach(function (name, i) {
        names.appendChild(element("th", has[i] ? "" : "absent", name));
      });
    });
    head.appendChild(names);
    t.appendChild(head);
    const body = element("tbody");
    let marked = 0;
    c.rows.forEach(function (row) {
      const tr = element("tr");
      const add = function (cells, other) {
        c.columns.forEach(function (_, i) {
          if (cells === undefined) {
            tr.appendChild(element("td", "missing"));
            return;
          }
          const changed = other === undefined ? "only" : row.differs[i] ? "changed" : "";
          if (changed) {
            marked++;
          }
          tr.appendChild(element("td", changed, cells[i]));
        });
      };
      add(row.left, row.right);
      tr.appendChild(element("td", "gap"));
      add(row.right, row.left);
      body.appendChild(tr);
    });
    t.appendChild(body);
    return { table: t, marked: marked };
  }

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (!message || message.type !== "compare") {
      return;
    }
    const c = message.comparison;
    document.body.textContent = "";
    const header = element("header");
    header.appendChild(element("code", "query", message.code));
    const said = summary(c);
    header.appendChild(element("p", c.same ? "summary same" : "summary", said));
    if (c.lined > c.rows.length) {
      header.appendChild(element("p", "note", "Showing the first " + c.rows.length + " of " + c.lined + " rows lined up; the counts are of all of them."));
    }
    document.body.appendChild(header);
    let rows = 0;
    let marked = 0;
    if (c.columns.length === 0) {
      document.body.appendChild(textSides(c));
      marked = c.same ? 0 : 2;
    } else {
      const drawn = table(c);
      const scroll = element("div", "scroll");
      scroll.appendChild(drawn.table);
      document.body.appendChild(scroll);
      rows = c.rows.length;
      marked = drawn.marked;
    }
    vscode.postMessage({ type: "rendered", id: message.id, rendered: { processes: [c.left.process, c.right.process], rows: rows, marked: marked, summary: said } });
  });

  vscode.postMessage({ type: "ready" });
})();
