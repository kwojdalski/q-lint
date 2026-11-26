// The Interactive Window (#956) and the q REPL pane (#959): runs and their
// answers, redrawn from what the extension posts, and in the REPL an input
// box. Every text is set with textContent, never as HTML. What Enter does,
// what Tab offers and what the history search finds are the extension's
// answers (`repl.ts`); the page only asks and draws.
(function () {
  const vscode = acquireVsCodeApi();
  const withInput = document.body.dataset.input === "yes";
  const header = document.createElement("header");
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = withInput
    ? "Enter runs a complete statement; Shift+Enter adds a line. Up and Down: history. Ctrl+R: search it. Tab: complete."
    : "Cells run here: Run Cell, Run Above, Run Below.";
  const clear = document.createElement("button");
  clear.textContent = "Clear";
  clear.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
  header.append(hint, clear);
  const main = document.createElement("main");
  document.body.append(header, main);
  const sections = new Map();
  // The polite live region a finished run is announced in (#1188), in the
  // page only while q-lint.results.announce.enable is on.
  let live;

  function setAnnounce(on) {
    if (on && live === undefined) {
      live = document.createElement("div");
      live.className = "sr-only";
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      live.setAttribute("aria-atomic", "true");
      document.body.append(live);
    } else if (!on && live !== undefined) {
      live.remove();
      live = undefined;
    }
  }

  /// Say a run that has just finished: its error's first line, or how many
  /// lines it answered, and how long it took.
  function announce(entry) {
    if (live === undefined || entry.ok === undefined) {
      return;
    }
    const took = entry.millis === undefined ? "" : ` in ${entry.millis} ms`;
    const n = entry.lines.length;
    live.textContent = entry.ok
      ? `${n} line${n === 1 ? "" : "s"}${took}`
      : `Error${took}: ${entry.lines.find((l) => l.trim() !== "") ?? "no message"}`;
  }

  function draw(entry) {
    let section = sections.get(entry.id);
    if (section === undefined) {
      section = document.createElement("section");
      section.className = "entry";
      sections.set(entry.id, section);
      main.append(section);
    }
    section.replaceChildren();
    const head = document.createElement("div");
    head.className = "head";
    if (entry.title) {
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = entry.title;
      head.append(title);
    }
    const about = document.createElement("span");
    about.textContent = [entry.process, entry.millis === undefined ? undefined : `${entry.millis} ms`].filter((x) => x !== undefined).join(" - ");
    head.append(about);
    const code = document.createElement("pre");
    code.className = "code";
    code.textContent = entry.code
      .split("\n")
      .map((line, i) => (i === 0 ? "q)" : "  ") + line)
      .join("\n");
    section.append(head, code);
    if (entry.ok === undefined) {
      const running = document.createElement("div");
      running.className = "running";
      running.textContent = "running...";
      section.append(running);
    } else if (entry.lines.length > 0) {
      const out = document.createElement("pre");
      out.className = entry.ok ? "out" : "error";
      out.textContent = entry.lines.join("\n");
      section.append(out);
    }
    main.scrollTop = main.scrollHeight;
  }

  function clearAll() {
    sections.clear();
    main.replaceChildren();
  }

  // --- the REPL's input
  let input;
  let searchLine;
  let list;
  let history = [];
  let pointer = -1;
  let draft = "";
  let search;
  let offered;
  // What Tab asked about: an answer is for that text and caret only.
  let asked;

  function setValue(text) {
    input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
  }

  function closeList() {
    offered = undefined;
    list.replaceChildren();
    list.hidden = true;
  }

  function accept(item) {
    const { start, caret } = offered;
    input.value = input.value.slice(0, start) + item.label + input.value.slice(caret);
    input.selectionStart = input.selectionEnd = start + item.label.length;
    closeList();
  }

  function showList(m) {
    offered = { start: m.start, caret: m.caret, items: m.items, selected: 0 };
    list.replaceChildren();
    for (const [i, item] of m.items.entries()) {
      const li = document.createElement("li");
      li.textContent = item.label;
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = item.detail;
      li.append(detail);
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        accept(item);
      });
      list.append(li);
    }
    list.hidden = false;
    select(0);
  }

  function select(i) {
    offered.selected = (i + offered.items.length) % offered.items.length;
    for (const [j, li] of [...list.children].entries()) {
      li.className = j === offered.selected ? "selected" : "";
    }
    list.children[offered.selected]?.scrollIntoView({ block: "nearest" });
  }

  function showSearch() {
    searchLine.textContent = search === undefined ? "" : `reverse search: ${search.query}${search.index < 0 && search.query !== "" ? " (no match)" : ""}`;
  }

  function onKey(event) {
    // An input method's own key while it composes: the Enter that takes a
    // candidate is not a line to run (#1923).
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (offered !== undefined) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        select(offered.selected + (event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        accept(offered.items[offered.selected]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeList();
        return;
      }
      closeList();
    }
    if (event.ctrlKey && event.key === "r") {
      event.preventDefault();
      search = search === undefined ? { query: "", index: -1 } : search;
      if (search.query !== "") {
        vscode.postMessage({ type: "search", query: search.query, from: search.index + 1 });
      }
      showSearch();
      return;
    }
    if (search !== undefined) {
      if (event.key === "Escape") {
        event.preventDefault();
        search = undefined;
        showSearch();
        return;
      }
      if (event.key === "Backspace" || (event.key.length === 1 && !event.ctrlKey && !event.metaKey)) {
        event.preventDefault();
        search.query = event.key === "Backspace" ? search.query.slice(0, -1) : search.query + event.key;
        vscode.postMessage({ type: "search", query: search.query, from: 0 });
        showSearch();
        return;
      }
      // Any other key keeps what was found, to edit or run.
      search = undefined;
      showSearch();
    }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      asked = { text: input.value, caret: input.selectionStart };
      vscode.postMessage({ type: "complete", text: asked.text, caret: asked.caret });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      vscode.postMessage({ type: "enter", code: input.value });
      return;
    }
    const before = input.value.slice(0, input.selectionStart);
    const after = input.value.slice(input.selectionEnd);
    if (event.key === "ArrowUp" && !before.includes("\n") && pointer + 1 < history.length) {
      event.preventDefault();
      if (pointer === -1) {
        draft = input.value;
      }
      pointer++;
      setValue(history[pointer]);
      return;
    }
    if (event.key === "ArrowDown" && !after.includes("\n") && pointer >= 0) {
      event.preventDefault();
      pointer--;
      setValue(pointer === -1 ? draft : history[pointer]);
    }
  }

  if (withInput) {
    const footer = document.createElement("footer");
    list = document.createElement("ul");
    list.className = "completions";
    list.hidden = true;
    searchLine = document.createElement("div");
    searchLine.className = "search";
    input = document.createElement("textarea");
    input.rows = 2;
    input.spellcheck = false;
    input.setAttribute("aria-label", "q input");
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", () => offered !== undefined && closeList());
    footer.append(list, searchLine, input);
    document.body.append(footer);
    input.focus();
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || typeof m.type !== "string") {
      return;
    }
    if (m.type === "announce") {
      setAnnounce(m.on === true);
    } else if (m.type === "all") {
      setAnnounce(m.announce === true);
      clearAll();
      for (const entry of m.entries) draw(entry);
      if (Array.isArray(m.history)) history = m.history;
    } else if (m.type === "add" || m.type === "update") {
      draw(m.entry);
      if (m.type === "update") {
        announce(m.entry);
      }
    } else if (m.type === "remove") {
      sections.get(m.id)?.remove();
      sections.delete(m.id);
    } else if (m.type === "clear") {
      clearAll();
    } else if (!withInput) {
      return;
    } else if (m.type === "newline") {
      const at = input.selectionStart;
      input.value = input.value.slice(0, at) + "\n" + input.value.slice(input.selectionEnd);
      input.selectionStart = input.selectionEnd = at + 1;
    } else if (m.type === "accepted") {
      history = Array.isArray(m.history) ? m.history : history;
      pointer = -1;
      draft = "";
      // Only the line it sent: what was typed since Enter stays (#2498).
      if (typeof m.code !== "string" || input.value === m.code) {
        setValue("");
      }
    } else if (m.type === "history") {
      // A run from the editor: what is typed here stays (#1922), and a
      // walk through the history stays on the entry it shows.
      history = Array.isArray(m.history) ? m.history : history;
      if (pointer >= 0) pointer = history.indexOf(input.value);
    } else if (m.type === "found" && search !== undefined) {
      search.index = m.index;
      // The walk through the history goes on from the entry found, as
      // readline's does (#2497); the draft is what was typed before it.
      if (m.index >= 0) {
        if (pointer === -1) draft = input.value;
        pointer = m.index;
        setValue(m.code);
      }
      showSearch();
    } else if (m.type === "completions") {
      // The answer is slow (a process, the workspace): the input may have run or changed since.
      const current = asked !== undefined && input.value === asked.text && input.selectionStart === asked.caret;
      asked = undefined;
      if (!current) {
        // Nothing: the places in the answer are not this text's.
      } else if (m.items.length === 1) {
        offered = { start: m.start, caret: m.caret, items: m.items, selected: 0 };
        accept(m.items[0]);
      } else if (m.items.length > 1) {
        showList(m);
      }
    } else if (m.type === "focus") {
      input.focus();
    }
  });
  vscode.postMessage({ type: "ready" });
})();
