// The notebook renderer for a `/ @chart` cell's output: draws the chart its
// `application/vnd.q-lint.chart+json` item describes (celldata.ts writes it).
//
// The editor loads this file as an ES module from the extension's own files.
// It imports the vendored Chart.js and chartspec.js beside it, which take
// their browser-global branch in a module and set `Chart` and `qlintChart`:
// no network, and the columns, axes and colours are the result panel's. The
// colours are the editor's theme, read from its `--vscode-*` variables and
// read again when the theme changes. Each chart drawn is reported to the
// extension, which keeps the last for its API, when it listens.
import "./vendor/chart.umd.min.js";
import "./chartspec.js";

const C = globalThis.qlintChart;
const Chart = globalThis.Chart;
/// Pixels a chart is tall unless its cell says `/ @height`.
const HEIGHT = 300;

const cssVar = (element) => (name, fallback) => getComputedStyle(element).getPropertyValue(name).trim() || fallback;

/// Draw the chart `spec` describes in `element`: {kind, grid, title?,
/// height?, note?}. Returns the Chart.js chart, or null when it drew a
/// note instead, and what it drew.
function draw(spec, element) {
  const grid = spec.grid;
  const rows = [...Array(grid.cells.length === 0 ? 0 : grid.cells[0].length).keys()];
  const data = C.chartData(grid, rows, spec.kind, C.chartable(grid, spec.kind), C.BINS);
  const drawn = C.summary(spec.kind, data);
  element.replaceChildren();
  const font = cssVar(element)("--vscode-font-family", "sans-serif");
  const text = (message) => {
    const p = document.createElement("p");
    p.textContent = message;
    p.style.cssText = `margin:4px 0;opacity:.75;font-family:${font}`;
    element.append(p);
  };
  if (data.note) {
    text(data.note);
    return { chart: null, drawn };
  }
  const box = document.createElement("div");
  box.style.cssText = `position:relative;width:100%;height:${spec.height || HEIGHT}px`;
  const canvas = document.createElement("canvas");
  box.append(canvas);
  element.append(box);
  if (spec.note) {
    text(spec.note);
  }
  const look = C.theme(cssVar(element));
  C.applyTheme(Chart, look);
  const chart = new Chart(canvas, C.chartConfig(grid, rows, spec.kind, data, look, spec.title));
  return { chart, drawn };
}

/// How many of the canvas's pixels are not transparent: more than none
/// means Chart.js drew on it.
function painted(canvas) {
  if (!canvas) {
    return 0;
  }
  const context = canvas.getContext("2d");
  if (!context || canvas.width === 0 || canvas.height === 0) {
    return 0;
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    n += pixels[i] === 0 ? 0 : 1;
  }
  return n;
}

export function activate(context) {
  /// Each output on show: what draws it again, and its chart.
  const shown = new Map();
  const report = (message) => {
    if (context.postMessage) {
      context.postMessage(message);
    }
  };
  const render = (id, spec, element) => {
    shown.get(id)?.chart?.destroy();
    try {
      const { chart, drawn } = draw(spec, element);
      shown.set(id, { chart, again: () => render(id, spec, element) });
      // Once laid out, with the canvas's size and what is on it.
      setTimeout(() => {
        const canvas = chart?.canvas;
        report({
          type: "rendered",
          id,
          chart: { ...drawn, title: spec.title, width: canvas?.width ?? 0, height: canvas?.height ?? 0, painted: painted(canvas) },
        });
      }, 50);
    } catch (error) {
      element.textContent = `q-lint could not draw this chart: ${error instanceof Error ? error.message : String(error)}`;
      report({ type: "failed", id, error: String(error) });
    }
  };
  // The editor marks its theme on the body's class: redraw in the new one.
  new MutationObserver(() => {
    for (const { again } of [...shown.values()]) {
      again();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return {
    renderOutputItem(item, element) {
      render(item.id, item.json(), element);
    },
    disposeOutputItem(id) {
      const ids = id === undefined ? [...shown.keys()] : [id];
      for (const one of ids) {
        shown.get(one)?.chart?.destroy();
        shown.delete(one);
      }
    },
  };
}
