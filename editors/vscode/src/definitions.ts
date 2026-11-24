// The functions a q file defines, as loading it would define them, and how
// they compare with what a process holds: drift detection (#933) and hot
// reload on save (#934). Free of any `vscode` import, so node tests it;
// `driftview.ts` is the VS Code around it.
//
// A definition is a top-level statement `name:{...}` whose lambda is the
// whole of its right-hand side: `f:{x}[1]` (a projection) or `f:g` is not
// one. Statements are cut as `statements.ts` cuts them - as q loads a
// script - and `\d .ns` lines, or `system "d .ns"`, move the context, so
// `f:{}` after `\d .ns` defines `.ns.f`. The lambda's text is the file's,
// `{` to its `}`, blank and comment lines inside it kept, as q keeps them in
// `last value f`.
//
// Texts are compared without trailing blanks on each line: KDB-X drops a
// line's trailing blanks from a lambda's text, and PeachQ keeps them.
//
// Nothing here changes a process. Hot reload sends a changed definition
// with Redefine's lambda (`funcsource.ts`'s REDEFINE), which refuses unless
// the process still holds the exact text it was told it holds, and only
// when that text is what the file had before the edit.
import { charKinds } from "./explorer";
import { blockDepth } from "./statements";

export const DRIFT_COMMANDS = {
  check: "q-lint.checkDrift",
} as const;

export interface Definition {
  /// The name it defines, with its context: `f`, `.ns.f`.
  name: string;
  /// The lambda, `{` to `}`, as the file has it.
  text: string;
  /// 0-based lines of the statement, first and last.
  line: number;
  endLine: number;
}

const NAME = /^(\.?[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*)\s*:\s*\{/;
const CONTEXT = /^\\d\s+(\.[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*|\.)\s*$/;
// `system "d .ns"` with a literal argument switches as `\d .ns` does, as the
// language server reads it (#261); a computed one leaves the context as it was.
const SYSTEM_CONTEXT = /^system\s*"d\s+(\.[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*|\.)\s*"\s*;?\s*(?:\s\/.*)?$/;

/// Where the lambda that opens at `open` in `text` closes, by `charKinds`'
/// code characters; -1 when it does not.
function closing(text: string, kinds: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (kinds[i] !== "c") {
      continue;
    }
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/// The definition `lines` (one statement, from `line`) make in context
/// `ctx`, or undefined when it is not a function definition.
function definitionOf(lines: string[], line: number, ctx: string): Definition | undefined {
  const text = lines.join("\n");
  const m = NAME.exec(text);
  if (m === null) {
    return undefined;
  }
  const open = m[0].length - 1;
  const kinds = charKinds(text);
  const close = closing(text, kinds, open);
  if (close < 0) {
    return undefined;
  }
  // Only blanks, a `;` or a comment may follow the lambda.
  for (let i = close + 1; i < text.length; i++) {
    if (kinds[i] === "c" && !/[\s;]/.test(text[i])) {
      return undefined;
    }
  }
  const short = m[1];
  const name = short.startsWith(".") || ctx === "" ? short : `.${ctx}.${short}`;
  return { name, text: text.slice(open, close + 1), line, endLine: line + lines.length - 1 };
}

/// The functions `source` defines, in order, by the rules q loads a script
/// with: a line starting with a blank continues the statement above, `/`
/// alone opens a block comment that `\` alone closes, and `\` alone outside
/// one ends the script.
export function definitions(source: string): Definition[] {
  const out: Definition[] = [];
  let ctx = "";
  let current: { line: number; lines: string[] } | undefined;
  // Blank and comment lines after the statement's last line: kept only if
  // a continuation line follows, as q keeps them in the lambda's text.
  let pending: string[] = [];
  let depth = 0;
  const end = (): void => {
    if (current !== undefined) {
      const first = current.lines[0];
      const switched = CONTEXT.exec(first.trim()) ?? SYSTEM_CONTEXT.exec(first.trim());
      if (switched !== null && current.lines.length === 1) {
        ctx = switched[1] === "." ? "" : switched[1].slice(1);
      } else {
        const found = definitionOf(current.lines, current.line, ctx);
        if (found !== undefined) {
          out.push(found);
        }
      }
      current = undefined;
    }
    pending = [];
  };
  for (const [i, raw] of source.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    const bare = line.replace(/\s+$/, "");
    if (i === 0 && bare.startsWith("#!")) {
      continue;
    }
    if (depth > 0 || bare === "/") {
      // A block comment does not end the statement around it (#1463). q
      // keeps it in the lambda's text as comment lines: `/` and `\` alone
      // as `/`, any other line with a `/` before it (checked on KDB-X).
      if (current !== undefined) {
        pending.push(bare === "/" || bare === "\\" ? "/" : `/${line}`);
      }
      depth = blockDepth(depth, bare);
      continue;
    }
    if (bare === "\\") {
      break;
    }
    if (bare === "" || (bare.startsWith("/") && current !== undefined)) {
      if (current !== undefined) {
        pending.push(line);
      }
      continue;
    }
    if ((line.startsWith(" ") || line.startsWith("\t")) && current !== undefined) {
      current.lines.push(...pending, line);
      pending = [];
      continue;
    }
    if (bare.startsWith("/")) {
      continue;
    }
    end();
    current = { line: i, lines: [line.trimStart()] };
  }
  end();
  return out;
}

/// A lambda's text as compared: without trailing blanks on any line, nor a
/// carriage return, and a tab starting a line after the first read as the
/// blank q turns it into when it loads the file (checked on KDB-X).
export function normalized(text: string): string {
  return text
    .split("\n")
    .map((l, i) => (i > 0 && l.startsWith("\t") ? ` ${l.slice(1)}` : l).replace(/\s+$/, ""))
    .join("\n");
}

/// The last definition of each name: what loading the file leaves defined.
export function lastByName(defs: Definition[]): Map<string, Definition> {
  return new Map(defs.map((d) => [d.name, d]));
}

/// Asks the process what each of `nms` (one string, names split by
/// spaces) holds: `missing`, a lambda and its text, or `other` - a
/// projection, a builtin, data. Reads only; works on KDB-X and PeachQ.
export const DRIFT = [
  "{[nms]",
  " n:\" \" vs(),nms;",
  " r:{x:@[{(1b;get x)};`$x;{(0b;x)}];$[not first x;(`missing;\"\");100h<>type last x;(`other;\"\");(`lambda;last value last x)]}each n;",
  " `name`state`text!(n;r[;0];r[;1])}",
].join("\n");

/// Names `DRIFT` is asked about in one call.
export const DRIFT_BATCH = 500;

export interface ProcessState {
  state: "missing" | "lambda" | "other";
  /// The lambda's text as the process has it; "" unless `lambda`.
  text: string;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/// What `DRIFT` answered, by name. Throws when it is not that.
export function readDrift(raw: unknown): Map<string, ProcessState> {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || r.name === undefined || r.state === undefined) {
    throw new Error(`the process answered something other than its definitions: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const names = list(r.name).map(String);
  const states = list(r.state).map(String);
  const texts = list(r.text);
  const out = new Map<string, ProcessState>();
  names.forEach((name, i) => {
    const state = states[i] === "lambda" || states[i] === "other" ? states[i] : "missing";
    const text = texts[i];
    out.set(name, { state: state as ProcessState["state"], text: state === "lambda" && typeof text === "string" ? text : "" });
  });
  return out;
}

export type DriftStatus = "same" | "differs" | "missing" | "other";

export interface DriftRow {
  name: string;
  /// Where the workspace defines it: a file (as the caller names it) and line.
  file: string;
  line: number;
  status: DriftStatus;
  /// The workspace's text, and the process's when it holds a lambda.
  text: string;
  processText: string;
}

/// Each workspace definition against what the process holds.
export function driftRows(defs: { file: string; def: Definition }[], states: Map<string, ProcessState>): DriftRow[] {
  return defs.map(({ file, def }) => {
    const held = states.get(def.name) ?? { state: "missing", text: "" };
    const status: DriftStatus =
      held.state !== "lambda" ? held.state : normalized(held.text) === normalized(def.text) ? "same" : "differs";
    return { name: def.name, file, line: def.line, status, text: def.text, processText: held.text };
  });
}

/// How many rows have each status.
export function driftCounts(rows: DriftRow[]): Record<DriftStatus, number> {
  const out: Record<DriftStatus, number> = { same: 0, differs: 0, missing: 0, other: 0 };
  for (const r of rows) {
    out[r.status]++;
  }
  return out;
}

/// One line summing up `rows` for `process`.
export function driftSummary(rows: DriftRow[], process: string): string {
  const c = driftCounts(rows);
  const parts = [
    `${c.differs} differ`,
    `${c.missing} not defined there`,
    ...(c.other > 0 ? [`${c.other} not a lambda there`] : []),
    `${c.same} the same`,
  ];
  return `${rows.length} workspace definitions against ${process}: ${parts.join(", ")}.`;
}

export interface Changed {
  def: Definition;
  /// The text the file had for it before the edit; undefined for a new one.
  was?: string;
}

/// The definitions of `now` that differ from `before`: what a save changed.
export function changedSince(before: Definition[], now: Definition[]): Changed[] {
  const was = lastByName(before);
  const out: Changed[] = [];
  for (const def of lastByName(now).values()) {
    const old = was.get(def.name);
    if (old === undefined) {
      out.push({ def });
    } else if (normalized(old.text) !== normalized(def.text)) {
      out.push({ def, was: old.text });
    }
  }
  return out;
}

export interface ReloadPlan {
  /// Sent with REDEFINE: `held` is the process's exact text, which it
  /// checks is still there.
  send: { name: string; held: string; text: string }[];
  /// Already the new text on the process: nothing to send.
  already: string[];
  skipped: { name: string; why: string }[];
}

/// What hot reload does with each changed definition, given what the
/// process holds: replace a function only while the process holds the
/// text the file had before the edit.
export function reloadPlan(changed: Changed[], states: Map<string, ProcessState>): ReloadPlan {
  const plan: ReloadPlan = { send: [], already: [], skipped: [] };
  for (const { def, was } of changed) {
    const held = states.get(def.name) ?? { state: "missing", text: "" };
    if (held.state === "missing") {
      plan.skipped.push({ name: def.name, why: "not defined on the process; run it to define it" });
    } else if (held.state === "other") {
      plan.skipped.push({ name: def.name, why: "not a lambda on the process" });
    } else if (normalized(held.text) === normalized(def.text)) {
      plan.already.push(def.name);
    } else if (was === undefined) {
      plan.skipped.push({ name: def.name, why: "new in the file, and the process holds another definition" });
    } else if (normalized(held.text) !== normalized(was)) {
      plan.skipped.push({ name: def.name, why: "the process holds a definition other than the file had before the edit" });
    } else {
      plan.send.push({ name: def.name, held: held.text, text: def.text });
    }
  }
  return plan;
}

/// Names as a sentence lists them: `f`, `f and g`, `f, g and h`.
export function namesList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/// The document a side of a drift diff shows: a header comment saying
/// whose text it is, then the text.
export function driftDocument(name: string, whose: string, text: string): string {
  return `/ ${name}: ${whose}\n${text}\n`;
}
