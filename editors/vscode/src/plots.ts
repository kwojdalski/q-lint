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
  /// show. The oldest go past the limit.
  add(plot: Plot): void {
    const at = this.plots.findIndex((p) => p.key === plot.key);
    if (at >= 0) {
      this.plots[at] = { ...plot, at: this.plots[at].at };
      this.current = at;
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

  /// Show the plot `by` places on (negative: back), within the history.
  move(by: number): Plot | undefined {
    if (this.plots.length === 0) {
      return undefined;
    }
    this.current = Math.min(this.plots.length - 1, Math.max(0, this.current + by));
    this.fire();
    return this.shown();
  }

  /// Forget the plot on show; the next older one is shown.
  removeShown(): void {
    if (this.current < 0) {
      return;
    }
    this.plots.splice(this.current, 1);
    this.current = Math.min(this.current, this.plots.length - 1);
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
/// would run. A plot that is not is refused.
export function plainSvg(svg: unknown): svg is string {
  return (
    typeof svg === "string" &&
    svg.length < 20_000_000 &&
    svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') &&
    svg.trimEnd().endsWith("</svg>") &&
    !/<script|<foreignObject|\son[a-z]+=|javascript:|href=/i.test(svg)
  );
}

/// A file name for a plot: its kind and when it was drawn.
export function plotFileName(plot: Plot, format: "svg" | "png"): string {
  const stamp = new Date(plot.at).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `q-plot-${plot.kind}-${stamp}.${format}`;
}
