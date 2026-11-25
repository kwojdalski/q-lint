// Line timings (#986): each statement of a selection or file run on the
// connected process with its time and memory, as line_profiler gives a
// Python function's lines. Free of any `vscode` import, so node tests it;
// `linetimingsview.ts` draws the decorations.
//
// `LINE_TIMINGS` is sent as one lambda with the statements, so nothing of
// ours is defined on the process: it runs each statement in order as a
// query would - assignments are global, `\d` changes the context for the
// statements after it - and stops at the first that fails. Time is q's own
// clock, `.z.p` before and after; memory is what `\ts` reports allocating.
// A system command (`\l f.q`) is timed with `.z.p` around `system`, and has
// no memory figure. The timing itself costs something: the lambda first runs
// `::` through the same path a hundred times and answers the mean, so the
// overhead per statement is measured on that process, each run - about
// 0.9 µs on KDB-X and 1.8 µs on PeachQ on the machine this was written on.
// `.z.p` advances in microseconds there, so a statement faster than that
// reads 0.

import type { Span } from "./statements";
import { bytes } from "./tableinfo";

/// The lambda: given the statements, it answers the overhead per
/// statement in ns, then for each statement run whether it ran, its time in
/// ns, its memory in bytes (null for a system command or a failure), and
/// the error a failure gave. The list stops at the first failure.
export const LINE_TIMINGS = [
  "{[s]",
  ' run:{[x] $["\\\\"=first x; [t0:.z.p; system 1_x; (1b;.z.p-t0;0N)]; [t0:.z.p; m:system "ts ",x; (1b;.z.p-t0;m 1)]]};',
  ' cal:{[run] t0:.z.p; do[100; run "::"]; (.z.p-t0)%100}[run];',
  " r:(); i:0;",
  " while[i<count s; a:@[run;s i;{(0b;0Nn;x)}]; r,:enlist a; i:$[first a;i+1;count s]];",
  ' (`float$cal; first each r; `float$r[;1]; {$[-7h=type x;`float$x;0n]} each r[;2]; {$[10h=type x;x;""]} each r[;2])}',
].join("\n");

/// A statement of the code timed, and the lines it covers in the document,
/// 0-based and inclusive.
export type { Span } from "./statements";

/// One statement's timing.
export interface Timing extends Span {
  ok: boolean;
  /// Nanoseconds, by `.z.p`.
  ns: number;
  /// Bytes `\ts` reports, or undefined for a system command or a failure.
  bytes?: number;
  error?: string;
}

export interface Timings {
  /// The instrumentation's own cost per statement, ns, measured on the
  /// process this run.
  overheadNs: number;
  /// Each statement run, in order; after a failure, none.
  timings: Timing[];
  /// Statements not run because one before them failed.
  notRun: number;
}

/// The statements of `text`, as `statements` cuts them (q's script rules),
/// each with the lines it covers counted from `firstLine`.
export { statementSpans } from "./statements";

const numbers = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === "number" || n === null);

/// What `LINE_TIMINGS` answered for `spans`. Throws when it is not that
/// shape: the process's `.z.pg` may answer something else.
export function readTimings(raw: unknown, spans: Span[]): Timings {
  const parts = raw as unknown[];
  const bad = (): never => {
    throw new Error(`the process answered something other than line timings: ${JSON.stringify(raw)?.slice(0, 200)}`);
  };
  if (!Array.isArray(parts) || parts.length !== 5 || typeof parts[0] !== "number") {
    return bad();
  }
  // One statement answers atoms where many answer lists.
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
  const ran = list(parts[1]);
  const ns = list(parts[2]);
  const bytes = list(parts[3]);
  const errors = typeof parts[4] === "string" && ran.length === 1 ? [parts[4]] : list(parts[4]);
  if (
    ran.length > spans.length ||
    !ran.every((b) => typeof b === "boolean") ||
    !numbers(ns) ||
    !numbers(bytes) ||
    ns.length !== ran.length ||
    bytes.length !== ran.length ||
    errors.length !== ran.length
  ) {
    return bad();
  }
  const timings = ran.map((ok, i): Timing => {
    const b = bytes[i] as number | null;
    const error = errors[i];
    return {
      ...spans[i],
      ok: ok as boolean,
      ns: typeof ns[i] === "number" && Number.isFinite(ns[i]) ? (ns[i] as number) : 0,
      ...(typeof b === "number" && Number.isFinite(b) ? { bytes: b } : {}),
      ...(!ok ? { error: typeof error === "string" && error !== "" ? error : "failed" } : {}),
    };
  });
  return { overheadNs: parts[0] as number, timings, notRun: spans.length - timings.length };
}

/// A duration for the decoration: µs under a millisecond, ms under a
/// minute, then seconds - as rounded, so 999.9 µs is 1.00 ms (#1437).
export function durationText(ns: number): string {
  const us = (ns / 1e3).toFixed(ns < 1e4 ? 1 : 0);
  if (ns < 1e6 && Number(us) < 1000) {
    return `${us} µs`;
  }
  const ms = (ns / 1e6).toFixed(ns < 1e7 ? 2 : ns < 1e8 ? 1 : 0);
  if (ns < 6e10 && Number(ms) < 60000) {
    return `${ms} ms`;
  }
  return `${(ns / 1e9).toFixed(1)} s`;
}

/// Bytes as the decoration shows them, in powers of 1024: tableinfo's
/// `bytes`, so 10239 B is 10 KB as everywhere else, not 10.0 KB (#1806).
export function bytesText(n: number): string {
  return bytes(n);
}

/// The text drawn after a statement's last line.
export function decorationText(t: Timing): string {
  if (!t.ok) {
    return `  ✗ ${t.error ?? "failed"}`;
  }
  return `  ⏱ ${durationText(t.ns)}${t.bytes === undefined ? "" : ` · ${bytesText(t.bytes)}`}`;
}

/// The run summarised in one line, for a message.
export function summary(result: Timings, process: string): string {
  const total = result.timings.reduce((sum, t) => sum + t.ns, 0);
  const failed = result.timings.find((t) => !t.ok);
  const slowest = result.timings.reduce<Timing | undefined>((max, t) => (max === undefined || t.ns > max.ns ? t : max), undefined);
  return [
    `Timed ${result.timings.length} statement${result.timings.length === 1 ? "" : "s"} on ${process}: ${durationText(total)} in all`,
    slowest !== undefined && result.timings.length > 1 ? `, the slowest on line ${slowest.start + 1} (${durationText(slowest.ns)})` : "",
    `. The timing itself adds about ${durationText(result.overheadNs)} a statement.`,
    failed !== undefined ? ` Line ${failed.start + 1} failed: ${failed.error}; ${result.notRun} after it did not run.` : "",
  ].join("");
}
