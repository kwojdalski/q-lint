// The plots kept for the q Plots view (#970): every chart the result panel
// draws, as the SVG chartspec.js's `chartSvg` makes of it, with the query
// and process it came from. Free of any `vscode` import, so node tests it;
// `plotsview.ts` shows them and `resultpanel.ts` adds to them.
//
// A chart redrawn from the same result as the same kind - a column ticked,
// the page shown again - replaces its plot rather than adding one, so the
// history holds one plot for each result and kind, newest last, at most
// `limit` of them.

/// The q Plots view and its commands (`plotsview.ts`).
export const PLOT_COMMANDS = {
  view: "q-lint.plots",
  show: "q-lint.showPlots",
  previous: "q-lint.previousPlot",
  next: "q-lint.nextPlot",
  save: "q-lint.savePlot",
  remove: "q-lint.removePlot",
  clear: "q-lint.clearPlots",
} as const;

export interface Plot {
  /// The result and kind it was drawn from: `<result id>/<kind>`.
  key: string;
  process: string;
  code: string;
  kind: string;
  svg: string;
  /// When it was first drawn, in ms since the epoch.
  at: number;
}

/// Plots kept: the oldest goes when one more is drawn.
export const PLOT_LIMIT = 50;

export class PlotStore {
  private plots: Plot[] = [];
  private listeners: (() => void)[] = [];
  /// The plot on show in the view, by index; -1 with none.
  current = -1;

  constructor(public limit = PLOT_LIMIT) {}

  list(): readonly Plot[] {
    return this.plots;
  }

  /// Keep `plot`, or replace the one of the same key; it is then the one on
  /// show - a replacement only when its SVG changed: the result page draws
  /// a kept chart again each time it is shown, and that leaves the plot the
  /// user stepped to on show (#2505). The oldest go past the limit.
  add(plot: Plot): void {
    const at = this.plots.findIndex((p) => p.key === plot.key);
    if (at >= 0) {
      const changed = this.plots[at].svg !== plot.svg;
      this.plots[at] = { ...plot, at: this.plots[at].at };
      if (changed) {
        this.current = at;
      }
    } else {
      this.plots.push(plot);
      const over = Math.max(0, this.plots.length - this.limit);
      this.plots = this.plots.slice(over);
      this.current = this.plots.length - 1;
    }
    this.fire();
  }

  /// The plot on show, if any.
  shown(): Plot | undefined {
    return this.plots[this.current];
  }

  /// The plot kept under `key`, if it still is.
  find(key: string): Plot | undefined {
    return this.plots.find((p) => p.key === key);
  }

  /// Show the plot `by` places on (negative: back) from the one on show, or
  /// from the plot `from` names: the one the page showed when it was asked,
  /// which a plot added since has moved off show (#2502). Nothing moves if
  /// that plot is no longer kept.
  move(by: number, from?: string): Plot | undefined {
    const start = from === undefined ? this.current : this.plots.findIndex((p) => p.key === from);
    if (this.plots.length === 0 || start < 0) {
      return undefined;
    }
    this.current = Math.min(this.plots.length - 1, Math.max(0, start + by));
    this.fire();
    return this.shown();
  }

  /// Forget the plot on show; the next older one is shown, or the oldest
  /// left when it was the oldest (#1260).
  removeShown(): void {
    const plot = this.shown();
    if (plot !== undefined) {
      this.remove(plot.key);
    }
  }

  /// Forget the plot kept under `key` (#2502). If it was on show the next
  /// older one is shown, as `removeShown`; else the one on show stays.
  remove(key: string): void {
    const at = this.plots.findIndex((p) => p.key === key);
    if (at < 0) {
      return;
    }
    this.plots.splice(at, 1);
    if (at < this.current || (at === this.current && at > 0)) {
      this.current--;
    }
    this.current = this.plots.length === 0 ? -1 : Math.min(this.current, this.plots.length - 1);
    this.fire();
  }

  clear(): void {
    this.plots = [];
    this.current = -1;
    this.fire();
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  }

  private fire(): void {
    for (const l of [...this.listeners]) {
      l();
    }
  }
}

/// The one store: the result panel adds to it, the view shows it.
export const PLOTS = new PlotStore();

/// Whether `svg` is what chartSvg makes: one svg element and nothing a page
/// would run. A plot that is not is refused. Only the markup is checked: a
/// label's text ("status online=1") is escaped data, not a handler. The
/// tags are read with their quoted values whole, since a value may hold a
/// `>`: `<image x=">" onerror="..."/>` is refused (#1738), and an
/// unclosed quote holds the rest. A handler may have space before its `=`,
/// and `<set>` or `<animate>` may write one: both are refused (#2450).
/// chartSvg names no namespace but the root's, so a prefixed element
/// (`<h:script>`, `<s:foreignObject>`) or a second `xmlns` - which could
/// put an XHTML `<iframe>` in the page - is refused too (#2652).
export function plainSvg(svg: unknown): svg is string {
  return (
    typeof svg === "string" &&
    svg.length < 20_000_000 &&
    svg.startsWith(SVG_ROOT) &&
    svg.trimEnd().endsWith("</svg>") &&
    !/<script|<foreignObject|<set\b|<animate|<iframe|<embed|<object|<\/?[\w.-]+:|xmlns|\son[a-z]+\s*=|javascript:|href\s*=/i.test(
      decodeReferences((svg.match(/<(?:[^>"']|"[^"]*"?|'[^']*'?)*>?/g) ?? []).join("").slice(SVG_ROOT.length)),
    )
  );
}

/// How chartSvg's markup starts: its one namespace.
const SVG_ROOT = '<svg xmlns="http://www.w3.org/2000/svg"';

/// Markup with its character references read, so `jav&#x61;script:` is
/// looked for as the browser reads it (#2450).
function decodeReferences(markup: string): string {
  return markup.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, n: string) => {
    const code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : parseInt(n, 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/// A file name for a plot: its kind and when it was drawn.
export function plotFileName(plot: Plot, format: "svg" | "png"): string {
  const stamp = new Date(plot.at).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `q-plot-${plot.kind}-${stamp}.${format}`;
}
