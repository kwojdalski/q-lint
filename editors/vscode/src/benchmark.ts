// The benchmark (#1048), as data: one or two expressions timed with
// `\ts:N`, repeated K times, on the active process, and the time and space
// each run took summed up for a table and a chart. Free of any `vscode`
// import, so node tests it; `benchmarkview.ts` sends it and shows it.
//
// `BENCHMARK` runs `system "ts:N e"` K times for each expression, in turn,
// and answers each run's milliseconds and bytes. The expressions are the
// user's own and run as written, so the read-only guard reads them as
// `\ts:N e` lines - its rules read the expression `\ts` times.
import { bytesText } from "./processtools";

export const BENCHMARK = [
  "{[exprs;n;k]",
  " {[n;k;e] r:{[n;e;i] system \"ts:\",string[n],\" \",e}[n;e] each til k; (\"f\"$r[;0];\"f\"$r[;1])}[`long$n;`long$k] each exprs}",
].join("\n");

export const DEFAULT_RUNS = { n: 100, k: 5 };

/// Why `expression` cannot be benchmarked, or undefined.
export function expressionProblem(expression: string): string | undefined {
  const e = expression.trim();
  if (e === "") {
    return "there is no expression to benchmark";
  }
  if (e.includes("\n")) {
    return "the benchmark times one expression on one line";
  }
  if (e.startsWith("\\")) {
    return "the benchmark times a q expression, not a system command";
  }
  return undefined;
}

/// `N K`, as typed: runs per `\ts` and repeats. Undefined when it is not.
export function readRuns(text: string): { n: number; k: number } | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  if (m === null) {
    return undefined;
  }
  const n = Number(m[1]);
  const k = Number(m[2]);
  return n >= 1 && n <= 1_000_000 && k >= 1 && k <= 100 ? { n, k } : undefined;
}

/// The code the read-only guard reads, and the history shows.
export function guardCode(expressions: string[], n: number): string {
  return expressions.map((e) => `\\ts:${n} ${e.trim()}`).join("\n");
}

export interface Timing {
  expression: string;
  /// ms of each repeat, each for N runs.
  times: number[];
  /// bytes of each repeat.
  spaces: number[];
}

export interface Summary {
  expression: string;
  /// ms per run (a repeat's time over N).
  min: number;
  median: number;
  mean: number;
  max: number;
  /// bytes, the most a repeat used.
  space: number;
  /// mean against the first expression's; 1 for the first.
  /// Its mean over the first's; null when the first measured 0 ms (#1116).
  ratio: number | null;
}

/// What `BENCHMARK` answered for `expressions`. Throws when it is not that.
export function readTimings(raw: unknown, expressions: string[]): Timing[] {
  const bad = (): never => {
    throw new Error(`the process answered something other than timings: ${JSON.stringify(raw)?.slice(0, 200)}`);
  };
  const nums = (v: unknown): number[] => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : typeof v === "number" ? [v] : bad());
  if (!Array.isArray(raw) || raw.length !== expressions.length) {
    return bad();
  }
  return raw.map((r, i) => {
    if (!Array.isArray(r) || r.length !== 2) {
      return bad();
    }
    return { expression: expressions[i], times: nums(r[0]), spaces: nums(r[1]) };
  });
}

/// Each expression's line of the table, per run of N.
export function summarise(timings: Timing[], n: number): Summary[] {
  const rows = timings.map((t) => {
    const per = t.times.map((ms) => ms / n).sort((a, b) => a - b);
    const mid = per.length % 2 === 1 ? per[(per.length - 1) / 2] : (per[per.length / 2 - 1] + per[per.length / 2]) / 2;
    return {
      expression: t.expression,
      min: per[0] ?? 0,
      median: mid ?? 0,
      mean: per.reduce((a, b) => a + b, 0) / Math.max(1, per.length),
      max: per[per.length - 1] ?? 0,
      space: Math.max(0, ...t.spaces),
      ratio: 1,
    };
  });
  const base = rows[0]?.mean ?? 0;
  return rows.map((r, i) => ({ ...r, ratio: i === 0 ? 1 : base > 0 ? r.mean / base : null }));
}

/// A time in ms as a person reads it.
export function msText(ms: number): string {
  return ms >= 1 ? `${ms.toFixed(ms >= 100 ? 0 : 2)} ms` : `${(ms * 1000).toFixed(ms * 1000 >= 100 ? 0 : 2)} µs`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const COLOURS = ["#3b82f6", "#f59e0b"];

/// The page: the table, and a chart of each expression's time per run (the
/// bar its mean, the line from its min to its max) and of its space. Every
/// expression goes in as escaped text; the page has no script.
export function benchmarkHtml(summary: Summary[], process: string, n: number, k: number, nonce: string): string {
  const width = 520;
  const label = 0;
  const bar = 26;
  const gap = 18;
  const chart = (title: string, value: (s: Summary) => number, range: (s: Summary) => [number, number] | undefined, text: (s: Summary) => string): string => {
    const top = Math.max(...summary.map((s) => range(s)?.[1] ?? value(s)), Number.MIN_VALUE);
    const scale = (v: number) => label + ((width - label - 120) * v) / top;
    const height = summary.length * (bar + gap) + 24;
    const rows = summary
      .map((s, i) => {
        const y = 24 + i * (bar + gap);
        const r = range(s);
        const whisker = r === undefined ? "" : `<line x1="${scale(r[0]).toFixed(1)}" x2="${scale(r[1]).toFixed(1)}" y1="${y + bar / 2}" y2="${y + bar / 2}" class="whisker"/>`;
        return `<rect x="${label}" y="${y}" width="${Math.max(1, scale(value(s)) - label).toFixed(1)}" height="${bar}" fill="${COLOURS[i % COLOURS.length]}"><title>${escapeHtml(s.expression)}</title></rect>${whisker}<text x="${(scale(r?.[1] ?? value(s)) + 6).toFixed(1)}" y="${y + bar / 2 + 4}">${escapeHtml(text(s))}</text>`;
      })
      .join("");
    return `<h2>${escapeHtml(title)}</h2><svg role="img" aria-label="${escapeHtml(title)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rows}</svg>`;
  };
  const table = [
    "<table><thead><tr><th></th><th>expression</th><th>min</th><th>median</th><th>mean</th><th>max</th><th>space</th><th>vs first</th></tr></thead><tbody>",
    ...summary.map(
      (s, i) =>
        `<tr><td><span class="key k${i % COLOURS.length}"></span></td><td><code>${escapeHtml(s.expression)}</code></td><td>${msText(s.min)}</td><td>${msText(s.median)}</td><td>${msText(s.mean)}</td><td>${msText(s.max)}</td><td>${escapeHtml(bytesText(s.space))}</td><td>${i === 0 ? "" : s.ratio === null ? "-" : `${s.ratio.toFixed(2)}x`}</td></tr>`,
    ),
    "</tbody></table>",
  ].join("");
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<style nonce="${nonce}">`,
    "body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0 16px}",
    "table{border-collapse:collapse;margin:8px 0}th,td{padding:3px 10px;text-align:right;border-bottom:1px solid var(--vscode-panel-border)}",
    "td:nth-child(2),th:nth-child(2){text-align:left}.key{display:inline-block;width:10px;height:10px}",
    ...COLOURS.map((c, i) => `.k${i}{background:${c}}`),
    "svg text{fill:var(--vscode-foreground);font-size:12px}.whisker{stroke:var(--vscode-foreground);stroke-width:2}",
    "h2{font-size:1em;margin:16px 0 4px}.note{opacity:.8}",
    "</style>",
    "<title>q-lint: benchmark</title></head><body>",
    `<p class="note">${escapeHtml(process)}: each expression run ${n} time${n === 1 ? "" : "s"} by <code>\\ts:${n}</code>, repeated ${k} time${k === 1 ? "" : "s"}; times are per run.</p>`,
    table,
    chart("Time per run (bar: mean; line: min to max)", (s) => s.mean, (s) => [s.min, s.max], (s) => msText(s.mean)),
    chart("Space (most a repeat used)", (s) => s.space, () => undefined, (s) => bytesText(s.space)),
    "</body></html>",
  ].join("\n");
}
