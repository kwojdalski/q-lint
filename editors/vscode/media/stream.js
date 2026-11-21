// A tickerplant table's live grid (#915): the newest rows first, redrawn
// from what the extension posts. Every cell is set as text, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const header = document.createElement("header");
  const title = document.createElement("strong");
  const status = document.createElement("span");
  status.className = "status";
  const closed = document.createElement("span");
  closed.className = "closed";
  const pause = document.createElement("button");
  pause.textContent = "Pause";
  let paused = false;
  pause.addEventListener("click", () => {
    paused = !paused;
    pause.textContent = paused ? "Resume" : "Pause";
    vscode.postMessage({ type: "pause", paused });
  });
  header.append(title, status, pause, closed);
  const main = document.createElement("main");
  const table = document.createElement("table");
  main.append(table);
  document.body.append(header, main);

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || m.type !== "rows") {
      return;
    }
    title.textContent = `${m.table} on ${m.process}`;
    status.textContent = `${m.rows.length} of ${m.total} rows received (last ${m.limit} kept), updated ${m.at}`;
    closed.textContent = m.closed ? `Stopped: ${m.closed}.` : "";
    const head = document.createElement("thead");
    const tr = document.createElement("tr");
    for (const c of m.columns) {
      const th = document.createElement("th");
      th.textContent = c;
      tr.append(th);
    }
    head.append(tr);
    const body = document.createElement("tbody");
    for (let i = m.rows.length - 1; i >= 0; i--) {
      const row = document.createElement("tr");
      for (const cell of m.rows[i]) {
        const td = document.createElement("td");
        td.textContent = cell;
        row.append(td);
      }
      body.append(row);
    }
    table.replaceChildren(head, body);
  });
  vscode.postMessage({ type: "ready" });
})();
