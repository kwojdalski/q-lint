// Instrumenting the functions a process holds, for a run the user started:
// line coverage of q tests (#979) and the locals at an error (#985). Free
// of any `vscode` import, so node tests it.
//
// A function is instrumented by sending its own text back with statements
// put in front of (or after) its body's statements, defined in the context
// it was defined in, exactly as Redefine does. Only a function the process
// holds with the text it is told it holds is replaced, and what it held is
// kept under `.qlint.<ns>.saved`; RESTORE puts each back - unless it was
// redefined meanwhile, which is left as it is - and deletes `.qlint.<ns>`.
// `.qlint` stays, empty when nothing else of q-lint's is left in it: q has
// no call that removes a context (#1871). INSTALL starts with nothing of
// `.qlint.<ns>` there: the caller restores first, so a run that was
// interrupted is put right before another starts.
//
// Coverage puts `.qlint.cov.d[k]+:1;` in front of each statement of a
// function's own body; the locals capture keeps the call's arguments as the
// parameter cache (#892) does, which statement it is on, and each local as
// a statement at the top of the body assigns it.
import type { Live } from "./live";
import { codeMask, lambdas, parameters, type Lambda } from "./paramcache";
import type { Process } from "./processes";
import { FULL_TEXT } from "./qtext";

/// One statement of a lambda's own body: offsets of its first code
/// character and just past its last, in the text the lambda was read from.
export interface BodyStatement {
  start: number;
  end: number;
}

/// The statements of `lambda`'s own body, split at its top-level `;`, in
/// order; empty ones (a trailing `;`, a comment) left out. A nested lambda,
/// bracket or parenthesis is part of the statement it is in.
export function bodyStatements(text: string, lambda: Lambda, mask: boolean[] = codeMask(text)): BodyStatement[] {
  const out: BodyStatement[] = [];
  let depth = 0;
  let start = -1;
  let end = -1;
  const close = (): void => {
    if (start >= 0) {
      out.push({ start, end });
    }
    start = -1;
    end = -1;
  };
  for (let i = lambda.bodyStart; i < lambda.close; i++) {
    if (!mask[i]) {
      // A string literal is not code to the mask but is part of its
      // statement: its opening quote is the first non-code character after
      // code, where a comment's first is `/` or `\`.
      if (text[i] === '"' && (i === 0 || mask[i - 1])) {
        if (start < 0) {
          start = i;
        }
        let j = i + 1;
        while (j < lambda.close && text[j] !== '"') {
          j += text[j] === "\\" ? 2 : 1;
        }
        end = Math.min(j + 1, lambda.close);
        i = end - 1;
      }
      continue;
    }
    const c = text[i];
    if (depth === 0 && c === ";") {
      close();
      continue;
    }
    if ("([{".includes(c)) {
      depth++;
    } else if (")]}".includes(c)) {
      depth--;
    }
    if (!/\s/.test(c)) {
      if (start < 0) {
        start = i;
      }
      end = i + 1;
    }
  }
  close();
  return out;
}

/// A position in a file: 0-based line and character.
export interface Pos {
  line: number;
  character: number;
}

/// Where `offset` of a lambda's text is in its file, when the text starts at
/// `at`.
export function positionIn(text: string, offset: number, at: Pos): Pos {
  const before = text.slice(0, offset);
  const nl = before.lastIndexOf("\n");
  if (nl < 0) {
    return { line: at.line, character: at.character + offset };
  }
  return { line: at.line + before.split("\n").length - 1, character: offset - nl - 1 };
}

/// `text` with each insertion put in at its offset.
function inserted(text: string, at: { offset: number; text: string }[]): string {
  let out = text;
  // From the end, and of two at one offset the later first, so the earlier
  // ends up in front.
  const order = at.map((a, i) => ({ ...a, i })).sort((a, b) => b.offset - a.offset || b.i - a.i);
  for (const { offset, text: add } of order) {
    out = out.slice(0, offset) + add + out.slice(offset);
  }
  return out;
}

/// The outer lambda of a definition's text (`{` to `}`), or undefined when
/// the text is not one lambda.
function outer(text: string, mask: boolean[]): Lambda | undefined {
  const all = lambdas(text, mask);
  return all.length === 1 && all[0].open === 0 && all[0].close === text.length - 1 ? all[0] : undefined;
}

/// A function instrumented for coverage: its new text, and where each probe
/// counts, as statements of the original text.
export interface Covered {
  text: string;
  statements: BodyStatement[];
}

/// `text` (a lambda, `{` to `}`) with `.qlint.cov.d[k]+:1;` in front of each
/// of its body's statements, `k` counting from `first`. Undefined when it is
/// not one lambda or has no statement.
export function coverageText(text: string, first: number): Covered | undefined {
  const mask = codeMask(text);
  const lambda = outer(text, mask);
  if (lambda === undefined) {
    return undefined;
  }
  const statements = bodyStatements(text, lambda, mask);
  if (statements.length === 0) {
    return undefined;
  }
  return {
    text: inserted(
      text,
      statements.map((s, k) => ({ offset: s.start, text: `.qlint.cov.d[${first + k}]+:1;` })),
    ),
    statements,
  };
}

const LOCAL = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*[-+*%&|^=<>$,#_~!?@]?:(?!:)/;

/// A function instrumented to capture its locals: its new text, its
/// parameters, and its statements.
export interface Captured {
  text: string;
  params: string[];
  statements: BodyStatement[];
}

/// `text` (a lambda) made to keep, each time it is called, its arguments in
/// `.qlint.err.d.args`, the index of the statement it is on in
/// `.qlint.err.d.at`, and each local a statement assigns at the top of its
/// body (`a:`, `a+:`, `a[i]:`) in `.qlint.err.d.locals` once that statement
/// has run. The last statement is left as it is, so the value is unchanged.
export function localsText(text: string): Captured | undefined {
  const mask = codeMask(text);
  const lambda = outer(text, mask);
  if (lambda === undefined) {
    return undefined;
  }
  const params = parameters(text, lambda, mask);
  const statements = bodyStatements(text, lambda, mask);
  const args =
    params.length === 0 ? "(`$())!()" : params.length === 1 ? `(enlist\`${params[0]})!enlist ${params[0]}` : `${params.map((p) => "`" + p).join("")}!(${params.join(";")})`;
  const at: { offset: number; text: string }[] = [
    { offset: lambda.bodyStart, text: `.qlint.err.d.args:${args};.qlint.err.d.locals:(\`$())!();.qlint.err.d.at:0N;` },
  ];
  statements.forEach((s, k) => {
    at.push({ offset: s.start, text: `.qlint.err.d.at:${k};` });
    const local = LOCAL.exec(text.slice(s.start, s.end));
    if (local !== null && k < statements.length - 1) {
      at.push({ offset: s.end, text: `;.qlint.err.d.locals[\`${local[1]}]:${local[1]}` });
    }
  });
  return { text: inserted(text, at), params, statements };
}

/// An expression, sent as it is, that puts back what `INSTALL` replaced
/// under `.qlint.<ns>`, and deletes it; the locals capture's values come
/// back as `-3!` text:
///
///   `kept`d!(names left as they were, being redefined since; what was captured, or ::)
export function restoreExpression(ns: "cov" | "err"): string {
  const n = `.qlint.${ns}`;
  return [
    "{[]",
    ` if[not\`${ns} in key\`.qlint;:\`kept\`d!(\`$();::)];`,
    ` s:@[get;\`${n}.saved;()!()];i:@[get;\`${n}.inst;()!()];d:@[get;\`${n}.d;{::}];`,
    // The locals go back as text, as the console prints each on one line,
    // but to 2000 characters whatever its width (#1870).
    ...(ns === "err" ? [` d:@[{@[x;\`args\`locals;{{2000 sublist ${FULL_TEXT}[2000;x]}each x}]};d;{::}];`] : []),
    " kept:{[nm;old;new]$[new~@[get;nm;{::}];[nm set old;0b];1b]}'[key s;value s;i key s];",
    ` .qlint:(enlist\`${ns})_.qlint;`,
    " `kept`d!((`$()),key[s] where kept;d)}[]",
  ].join("\n");
}

/// Replaces each of `nms` (strings) whose text on the process is `was` with
/// `src`, defined in its own context, keeping what it held. `d` is how many
/// probes coverage counts (`.qlint.cov.d`, longs); the locals capture starts
/// `.qlint.err.d` empty. Answers, for each name, `ok`, `missing`,
/// `changed` or the error defining it gave; when none is `ok`,
/// `.qlint.<ns>` is deleted again.
export function installLambda(ns: "cov" | "err"): string {
  const n = `.qlint.${ns}`;
  return [
    "{[nms;was;src;d]",
    ` ${n}.saved:(\`$())!();${n}.inst:(\`$())!();`,
    ns === "cov" ? ' .qlint.cov.d:("j"$d)#0j;' : " .qlint.err.d:`args`locals`at!((`$())!();(`$())!();0N);",
    " r:{[nm;w;s]",
    "  nm:`$nm;old:@[get;nm;{::}];",
    "  if[not 100h=type old;:\"missing\"];",
    "  if[not w~last value old;:\"changed\"];",
    "  c:first(value old)3;o:system\"d\";",
    "  system\"d \",$[null c;\".\";\".\",string c];",
    "  r:@[{(1b;value x)};s;{(0b;x)}];",
    "  system\"d \",string o;",
    "  if[not first r;:last r];",
    "  if[not 100h=type last r;:\"not a lambda\"];",
    `  ${n}.saved[nm]:old;${n}.inst[nm]:last r;`,
    "  nm set last r;\"ok\"}'[{(),x}each(),nms;{(),x}each(),was;{(),x}each(),src];",
    // Nothing replaced: nothing is kept for a restore the caller has no
    // reason to send (#1893).
    ` if[0=count ${n}.saved;.qlint:(enlist\`${ns})_.qlint];`,
    " r}",
  ].join("\n");
}

/// What `RESTORE` answered.
export interface Restored {
  /// Names not put back: redefined while instrumented.
  kept: string[];
  d: unknown;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

export function readRestored(raw: unknown): Restored {
  const r = raw as { kept?: unknown; d?: unknown } | null;
  if (r === null || typeof r !== "object" || !("kept" in r)) {
    throw new Error(`the process answered something other than a restore: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  return { kept: list(r.kept).map(String), d: r.d };
}

/// What `INSTALL` answered, a status for each name.
export function readInstalled(raw: unknown, count: number): string[] {
  const out = list(raw).map((s) => (Array.isArray(s) ? s.join("") : String(s)));
  if (out.length !== count) {
    throw new Error(`the process answered ${out.length} statuses for ${count} functions`);
  }
  return out;
}

/// How long a restore over a connection of its own waits for the process,
/// in ms: it is tried at the end of a run whose own restore could not be
/// sent, often because the process is busy, and the run does not wait on
/// that for long.
export const RESTORE_WAIT = 10_000;

/// Whether `message` is `Live.runOnActive`'s for the read-only guard's
/// question declined: the user said not to send it, so no other way is tried.
export const guardDeclined = (message: string): boolean => /was not confirmed\.?$/.test(message);

/// Put back what a run left instrumented on `process` - the one INSTALL
/// went to, whichever is active now - over a connection of its own, closed
/// after: the run's own restore could not be sent (another process became
/// active, the query timed out, the connection closed). The read-only
/// guard is asked about it as it is about the run's own. Throws why
/// nothing was put back, within `wait` ms.
export async function restoreApart(
  live: Pick<Live, "guardAllows" | "openSeparate">,
  process: Process,
  ns: "cov" | "err",
  what: string,
  wait = RESTORE_WAIT,
): Promise<Restored> {
  const restore = restoreExpression(ns);
  if (!(await live.guardAllows(restore, [process], what))) {
    throw new Error(`changing the read-only process ${process.label} was not confirmed`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${process.label} did not answer within ${wait / 1000} s`)), wait);
  });
  const opening = live.openSeparate(process);
  try {
    const connection = await Promise.race([opening, late]);
    return readRestored(await Promise.race([connection.call(restore), late]));
  } finally {
    clearTimeout(timer);
    // Closed whether it answered or not: a connection a busy process
    // accepts only later sends nothing then, into some other run.
    void opening.then(
      (connection) => connection.abort(),
      () => undefined,
    );
  }
}

/// What the user is told when the functions a run instrumented could not
/// be put back: which they are, by name, where, why, and what puts them
/// back (`next`, "coverage run"). `names` are those INSTALL was sent.
export function leftInstrumented(names: readonly string[], process: string, why: string, next: string, most = 10): string {
  const shown = names.slice(0, most).join(", ") + (names.length > most ? ` and ${names.length - most} more` : "");
  const they = names.length === 1 ? "it" : "them";
  return `q-lint: ${shown} may still be instrumented on ${process}: ${names.length === 1 ? "it" : "they"} could not be put back (${why.replace(/\.$/, "")}). The next ${next} on ${process} puts ${they} back first.`;
}
