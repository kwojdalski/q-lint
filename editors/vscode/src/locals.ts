// Locals at the error (#985), as data: which functions of a failed query's
// backtrace can be looked into, and the document that shows what was
// captured. Free of any `vscode` import, so node tests it; `localsview.ts`
// runs the capture, with `instrument.ts`'s locals text.
import { parseBacktrace } from "./backtrace";
import type { BodyStatement } from "./instrument";

export const CAPTURE_LOCALS = "q-lint.captureLocals";

/// The functions a backtrace names, innermost first, each once, with where
/// the frame says it is. A frame whose code after `name:` is no lambda - the
/// failed query's own `res:f 1`, a caller's `r:.Q.trp[...]` - names what
/// was assigned, not a function (#2412). A lambda's is `{`, or nothing when
/// q prints it from its second line.
export function namedFrames(trace: string): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = [];
  for (const frame of parseBacktrace(trace)) {
    const after = frame.name === undefined ? "" : (frame.code[0] ?? "").replace(/^[^:]*:/, "").trim();
    if (after !== "" && !after.startsWith("{")) {
      continue;
    }
    if (frame.name !== undefined && !out.some((f) => f.name === frame.name)) {
      out.push({ name: frame.name, where: frame.file === undefined ? "" : `${frame.file}:${frame.line}` });
    }
  }
  return out;
}

export interface Capture {
  args: Record<string, string>;
  locals: Record<string, string>;
  /// The statement it was on, from 0; undefined when it was never called.
  at: number | undefined;
}

const texts = (v: unknown): Record<string, string> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return {};
  }
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, Array.isArray(x) ? x.join("") : String(x)]));
};

/// What RESTORE answered for the locals capture.
export function readCapture(d: unknown): Capture {
  const r = (d ?? {}) as { args?: unknown; locals?: unknown; at?: unknown };
  // 0N, not yet on a statement, arrives as null.
  const at = r.at === null || r.at === undefined ? NaN : Number(r.at);
  return { args: texts(r.args), locals: texts(r.locals), at: Number.isInteger(at) && at >= 0 ? at : undefined };
}

/// The text shown: what the call was given, which statement it was on, and
/// each local as last assigned.
export function localsDocument(input: {
  name: string;
  process: string;
  code: string;
  /// The function's text, and its statements, as instrumented.
  text: string;
  statements: BodyStatement[];
  capture: Capture;
  /// The error the query signalled when run again, or undefined if it ran.
  error: string | undefined;
}): string {
  const { name, process, code, text, statements, capture, error } = input;
  const lines = [`/ ${name} on ${process}, captured by running the failed query again:`, ...code.split("\n").map((l) => `/   ${l}`)];
  if (capture.at === undefined && Object.keys(capture.args).length === 0) {
    lines.push(`/ ${name} was not called${error === undefined ? "" : ` before it signalled '${error}`}.`);
    return `${lines.join("\n")}\n`;
  }
  const statement = capture.at === undefined ? undefined : statements[capture.at];
  const shown = statement === undefined ? "" : `: ${text.slice(statement.start, statement.end).replace(/\s*\n\s*/g, " ")}`;
  lines.push(
    error === undefined
      ? `/ it ran without an error this time; this is its last call, which ended at statement ${(capture.at ?? 0) + 1} of ${statements.length}${shown}`
      : `/ it signalled '${error}; ${name} was at statement ${(capture.at ?? 0) + 1} of ${statements.length}${shown}`,
  );
  lines.push("", "/ arguments");
  const entries = (record: Record<string, string>): string[] => Object.entries(record).map(([k, v]) => `${k}: ${v}`);
  lines.push(...(Object.keys(capture.args).length === 0 ? ["/ (none)"] : entries(capture.args)));
  lines.push("", "/ locals, as a statement at the top of the body last assigned each");
  lines.push(...(Object.keys(capture.locals).length === 0 ? ["/ (none assigned yet)"] : entries(capture.locals)));
  return `${lines.join("\n")}\n`;
}
