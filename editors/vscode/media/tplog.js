// The tickerplant log panel (#1029): the log's messages by number, filtered
// by table and time of day and paged; the one picked shown in full, stepped
// through with Previous and Next; and a range replayed into the local q.
// The extension (`tplogview.ts`) reads the log in a q of its own; this only
// lays it out. Every value goes in as text.
(function () {
  "use strict";
  if (typeof acquireVsCodeApi !== "function") {
    return;
  }
  const vscode = acquireVsCodeApi();
  let log;
  let page = { offset: 0, size: 200, total: 0, rows: [] };
  let picked;

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
  function labelled(text, input) {
    const l = element("label", "", text + " ");
    l.appendChild(input);
    return l;
  }
  function input(placeholder, size) {
    const i = element("input");
    i.placeholder = placeholder;
    i.size = size;
    return i;
  }
  function button(text, title, run) {
    const b = element("button", "", text);
    b.title = title;
    b.addEventListener("click", run);
    return b;
  }

  const summary = element("p", "summary");
  const table = element("select");
  const from = input("HH:MM", 9);
  const to = input("HH:MM", 9);
  const list = element("table", "messages");
  const pager = element("p", "note");
  const detail = element("pre", "detail");
  const replayFrom = input("from", 6);
  const replayTo = input("to", 6);
  const status = element("p", "status");

  const filter = (offset) => vscode.postMessage({ type: "page", table: table.value, from: from.value, to: to.value, offset: offset });
  const pick = (index) => {
    picked = index;
    vscode.postMessage({ type: "show", index: index });
    if (replayFrom.value === "") {
      replayFrom.value = String(index);
    }
    replayTo.value = String(index);
    drawRows();
  };

  const filters = element("div", "row");
  filters.appendChild(labelled("Table", table));
  filters.appendChild(labelled("From", from));
  filters.appendChild(labelled("to", to));
  filters.appendChild(button("Filter", "List the messages of this table in this time of day", () => filter(0)));
  filters.appendChild(button("◀ Page", "The page before", () => filter(Math.max(0, page.offset - page.size))));
  filters.appendChild(button("Page ▶", "The page after", () => page.offset + page.size < page.total && filter(page.offset + page.size)));
  const steps = element("div", "row");
  steps.appendChild(button("◀ Previous", "The message before the one shown", () => picked !== undefined && picked > 0 && pick(picked - 1)));
  steps.appendChild(button("Next ▶", "The message after the one shown", () => log && picked !== undefined && picked < log.count - 1 && pick(picked + 1)));
  const replay = element("div", "row");
  replay.appendChild(labelled("Replay messages", replayFrom));
  replay.appendChild(labelled("to", replayTo));
  replay.appendChild(button("Load Schema…", "Load a q file - the tickerplant's schema and upd - into the local q first", () => vscode.postMessage({ type: "schema" })));
  replay.appendChild(button("Replay", "Run these messages in the local q, after asking", () => vscode.postMessage({ type: "replay", from: Number(replayFrom.value), to: Number(replayTo.value) })));

  [summary, filters, list, pager, steps, detail, replay, status].forEach((e) => document.body.appendChild(e));

  function drawRows() {
    list.textContent = "";
    const head = element("tr");
    ["#", "function", "table", "rows", "first time"].forEach((h) => head.appendChild(element("th", "", h)));
    list.appendChild(head);
    page.rows.forEach((r) => {
      const tr = element("tr", r.index === picked ? "picked" : "");
      [String(r.index), r.fn, r.table, String(r.rows), r.time].forEach((c) => tr.appendChild(element("td", "", c)));
      tr.addEventListener("click", () => pick(r.index));
      list.appendChild(tr);
    });
    pager.textContent = page.total === 0 ? "No message matches." : "Messages " + (page.offset + 1) + " to " + Math.min(page.total, page.offset + page.rows.length) + " of " + page.total + " matching.";
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "log") {
      // Another log: nothing of the last one stays picked or typed.
      log = m.log;
      page = { offset: 0, size: page.size, total: 0, rows: [] };
      picked = undefined;
      [from, to, replayFrom, replayTo].forEach((i) => (i.value = ""));
      detail.textContent = "";
      status.textContent = "";
      drawRows();
      summary.textContent =
        m.log.file + ": " + m.log.count + " messages" + (m.log.complete ? "" : ", read to the last whole one: " + (m.log.size - m.log.bytes) + " bytes at the end are cut short") + ". Read in a local q on port " + m.port + ".";
      table.textContent = "";
      [""].concat(m.log.tables).forEach((t) => {
        const o = element("option", "", t === "" ? "(every table)" : t);
        o.value = t;
        table.appendChild(o);
      });
    } else if (m.type === "page") {
      page = m;
      drawRows();
    } else if (m.type === "message") {
      detail.textContent = "Message " + m.index + "\n" + m.text;
    } else if (m.type === "status") {
      status.textContent = m.text;
      status.className = m.failed ? "status failed" : "status";
    }
  });
  vscode.postMessage({ type: "ready" });
})();
