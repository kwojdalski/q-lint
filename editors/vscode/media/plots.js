// The q Plots view's page (plotsview.ts): the plot on show as an image of
// its SVG, with the query it came from, and buttons to step through the
// plots, save, remove and clear them. Asked for a PNG, it draws the SVG on
// a canvas over the editor's background and sends it back.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  /// refocus.js, loaded before this script: every plot shown redraws the buttons.
  const focus = self.qlintFocus;
  let shown = null;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const svgUrl = (svg) => "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
  const send = (message) => vscode.postMessage(message);

  function draw(m) {
    shown = m.plot || null;
    document.body.replaceChildren();
    if (!shown) {
      document.body.append(el("p", "empty", "No plots yet. Every chart the result panel draws is kept here."));
      return;
    }
    const bar = el("div", "bar");
    const button = (label, title, message, disabled) => {
      const b = el("button", "", label);
      b.title = title;
      b.disabled = !!disabled;
      // Each act names the plot on show here, for the extension to act on that one (#2502).
      b.addEventListener("click", () => send(Object.assign({ plot: shown.key }, message)));
      // At the first or last plot an arrow is disabled: the other one takes its focus.
      focus.name(b, title, { "Previous plot": "Next plot", "Next plot": "Previous plot" }[title]);
      bar.append(b);
    };
    button("←", "Previous plot", { type: "move", by: -1 }, m.index <= 0);
    bar.append(el("span", "count", m.index + 1 + " / " + m.count));
    button("→", "Next plot", { type: "move", by: 1 }, m.index >= m.count - 1);
    button("Save SVG", "Save the plot as SVG", { type: "save", format: "svg" });
    button("Save PNG", "Save the plot as PNG", { type: "save", format: "png" });
    button("Remove", "Forget this plot", { type: "remove" });
    button("Clear", "Forget every plot", { type: "clear" });
    const about = el("div", "about");
    about.append(el("span", "kind", shown.kind), document.createTextNode(" " + shown.process + ", " + new Date(shown.at).toLocaleTimeString()));
    // Cut by code point, never inside a surrogate pair (#1809).
    const chars = Array.from(shown.code);
    const code = el("pre", "code", chars.length > 300 ? chars.slice(0, 300).join("") + "..." : shown.code);
    const img = el("img", "plot");
    img.alt = shown.kind + " chart of " + shown.code;
    img.src = svgUrl(shown.svg);
    document.body.append(bar, about, code, img);
  }

  /// A PNG of `svg`, the plot the save picked, which need not be the one on show.
  function png(key, svg) {
    if (typeof svg !== "string") {
      send({ type: "png", key: key });
      return;
    }
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 800;
      canvas.height = img.naturalHeight || 450;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--vscode-editor-background") || "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      send({ type: "png", key: key, data: canvas.toDataURL("image/png") });
    };
    img.onerror = () => send({ type: "png", key: key });
    img.src = svgUrl(svg);
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "plots") focus.over(() => draw(m));
    else if (m.type === "png") png(m.key, m.svg);
  });
  send({ type: "ready" });
})();
