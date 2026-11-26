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
// Coverage puts `qlintcov:qlintcovh k;` in front of each statement of a
// function's own body, `qlintcovh` being `.qlint.cov.hit`: INSTALL defines
// it to add 1 to `.qlint.cov.d[k]` under a trap, so a caller q refuses a
// global write to (`reval`, a secondary thread of `peach`) still gets the
// function's answer, uncounted (#1894), and to answer `k+1`. Only the first
// probe is given its index as a constant; each after it passes on the local
// the one before set, since the body's own statements run in order. A
// constant a probe would give a function of about 120 statements more than
// q allows ('limit, #2543). The first probe takes `.qlint.cov.hit` only
// while `.qlint.cov` is there, and counts nothing otherwise: a reference to
// the instrumented function, taken during the run by a handler or a timer,
// outlives the restore and keeps answering (#2975). The locals capture keeps the call's arguments as the
// parameter cache (#892) does, which statement it is on, and each local as
// a statement at the top of the body assigns it - in a frame of its own for
// each call that has not returned, so a function that calls itself shows
// the call that failed, not the last one it made (#2969).
import type { Live } from "./live";
import { codeMask, lambdas, ownCode, parameters, type Lambda } from "./paramcache";
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

/// `text` (a lambda, `{` to `}`) with a probe in front of each of its
/// body's statements, counting from `first`. Undefined when it is
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
      statements.map((s, k) => ({ offset: s.start, text: k === 0 ? `qlintcovh:$[\`cov in key\`.qlint;.qlint.cov.hit;{x}];qlintcov:qlintcovh ${first};` : "qlintcov:qlintcovh qlintcov;" })),
    ),
    statements,
  };
}

/// What to insert so that `hook`, a q expression for a function of one
/// argument answering it, is applied to the value `lambda` hands back, where
/// its own text says it hands one back: at each `:value` of its own body -
/// a `:` where an expression starts, at the start of a statement or after
/// a `[`, `(` or `;`, whatever brackets it is nested in, as q reads a return
/// - and at its last statement, or at its end when a `;` follows that
/// (the value is then the generic null). With `signals`, at each `'value`
/// of its own body too. An error q itself signals is not seen: the caller
/// allows for a call that ended unseen. A nested lambda's are its own.
function exits(text: string, lambda: Lambda, mask: boolean[], statements: BodyStatement[], hook: string, signals: boolean): { offset: number; text: string }[] {
  const own = ownCode(lambda, mask);
  const out: { offset: number; text: string }[] = [];
  // The last thing before here that is not blank or a comment: "" at the
  // body's start, `"` for a string, `}` for a nested lambda.
  let before = "";
  for (let i = lambda.bodyStart; i < lambda.close; i++) {
    if (!own(i)) {
      if (mask[i]) {
        before = "}";
      } else if (text[i] === '"' && mask[i - 1]) {
        before = '"';
      }
      continue;
    }
    const c = text[i];
    if (/\s/.test(c)) {
      continue;
    }
    if ((c === ":" || (signals && c === "'")) && (before === "" || before === ";" || before === "[" || before === "(")) {
      let j = i + 1;
      while (j < lambda.close && /\s/.test(text[j])) {
        j++;
      }
      // An expression follows: not the end of one, another `:` (`::`), an
      // adverb or a bracket (`:[a;b]`, `'[f;g]`), nor a comment.
      const follows = j < lambda.close && (own(j) ? !";])}:'/\\[".includes(text[j]) : mask[j] || text[j] === '"');
      if (follows) {
        out.push({ offset: i + 1, text: `${hook}@` });
      }
    }
    before = c;
  }
  const last = statements[statements.length - 1];
  let trailing = last === undefined;
  for (let i = last?.end ?? lambda.close; i < lambda.close && !trailing; i++) {
    trailing = own(i) && text[i] === ";";
  }
  if (last === undefined || trailing) {
    out.push({ offset: lambda.close, text: `${hook}[::]` });
  } else if (text[last.start] !== ":" && text[last.start] !== "'") {
    out.push({ offset: last.start, text: `${hook}@` });
  }
  return out;
}

const LOCAL = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*[-+*%&|^=<>$,#_~!?@]?:(?!:)/;

/// A function instrumented to capture its locals: its new text, its
/// parameters, and its statements.
export interface Captured {
  text: string;
  params: string[];
  statements: BodyStatement[];
}

/// The locals of a call that has assigned none yet: a dictionary whose one
/// entry, under the null symbol, is the generic null. With it the values
/// stay a general list whatever is kept beside it; one started empty takes
/// the type of the first atom kept, and keeping a local of another type
/// then fails with 'type inside the function looked into (#2968). RESTORE
/// leaves the entry out.
const NO_LOCALS = "(enlist`)!enlist(::)";

/// What INSTALL defines for the locals capture. `.qlint.err.s` holds one
/// frame - (arguments; locals; statement) - for each call that has not
/// returned, outermost first, after a first item that keeps the list
/// general. `.qlint.err.in` opens a call's frame and answers what the call
/// keeps things with, `.qlint.err.f` for that frame: given a statement's
/// index it notes the statement, given a local's name and value it keeps
/// the local, and given `::` and the call's value it closes the frame -
/// kept as the last call that returned - and answers the value. A frame
/// above the one written to is of a call that ended unseen (an error
/// trapped on the way, a return the text did not show), and is dropped.
const LOCALS_STATE = [
  " .qlint.err.s:enlist(::);.qlint.err.last:();",
  ` .qlint.err.in:{[a] .qlint.err.s,:enlist(a;${NO_LOCALS};0N);.qlint.err.f[-1+count .qlint.err.s]};`,
  " .qlint.err.f:{[n;w;x] if[n<count .qlint.err.s;$[-7h=type w;[.qlint.err.s:(n+1)#.qlint.err.s;.qlint.err.s[n;2]:w];-11h=type w;[.qlint.err.s:(n+1)#.qlint.err.s;.qlint.err.s[n;1;w]:x];[.qlint.err.last:.qlint.err.s n;.qlint.err.s:n#.qlint.err.s]]];x};",
].join("\n");

/// `text` (a lambda) made to keep, each time it is called, a frame of its
/// own (`LOCALS_STATE`) with its arguments, the index of the statement it
/// is on, and each local a statement assigns at the top of its body (`a:`,
/// `a+:`, `a[i]:`) once that statement has run; the frame is closed where
/// the call hands its value back (`exits`), so the frame left open after
/// an error is the failed call's, whatever calls it made of itself
/// (#2969). The value is unchanged. `qlinterr` is what the call keeps
/// things with - or `{y}`, keeping nothing, when `.qlint.err` is gone: a
/// reference to this copy outlives the capture.
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
  const at: { offset: number; text: string }[] = [{ offset: lambda.bodyStart, text: `qlinterr:$[\`err in key\`.qlint;.qlint.err.in ${args};{y}];` }];
  statements.forEach((s, k) => {
    at.push({ offset: s.start, text: `qlinterr[${k};::];` });
    const local = LOCAL.exec(text.slice(s.start, s.end));
    if (local !== null && k < statements.length - 1) {
      at.push({ offset: s.end, text: `;qlinterr[\`${local[1]};${local[1]}]` });
    }
  });
  at.push(...exits(text, lambda, mask, statements, "qlinterr[::]", false));
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
    ` s:@[get;\`${n}.saved;()!()];i:@[get;\`${n}.inst;()!()];`,
    ns === "cov"
      ? " d:@[get;`.qlint.cov.d;{::}];"
      : // The frame of the innermost call that has not returned - the
        // failed one - or, when every call returned, of the last that did.
        // The locals go back as text, as the console prints each on one
        // line, but to 2000 characters whatever its width (#1870).
        ` d:@[{f:$[1<count x;last x;y];f:$[3=count f;f;((\`$())!();${NO_LOCALS};0N)];\`args\`locals\`at!({{2000 sublist ${FULL_TEXT}[2000;x]}each x}f 0;{{2000 sublist ${FULL_TEXT}[2000;x]}each x}(enlist\`)_f 1;f 2)}[@[get;\`.qlint.err.s;()]];@[get;\`.qlint.err.last;()];{::}];`,
    " kept:{[nm;old;new]$[new~@[get;nm;{::}];[nm set old;0b];1b]}'[key s;value s;i key s];",
    ` .qlint:(enlist\`${ns})_.qlint;`,
    " `kept`d!((`$()),key[s] where kept;d)}[]",
  ].join("\n");
}

/// Replaces each of `nms` (strings) whose text on the process is `was` with
/// `src`, defined in its own context, keeping what it held. `d` is how many
/// probes coverage counts (`.qlint.cov.d`, longs, through `.qlint.cov.hit`);
/// the locals capture starts with no frame (`LOCALS_STATE`). Answers, for each name, `ok`, `missing`,
/// `changed` or the error defining it gave; when none is `ok`,
/// `.qlint.<ns>` is deleted again.
export function installLambda(ns: "cov" | "err"): string {
  const n = `.qlint.${ns}`;
  return [
    "{[nms;was;src;d]",
    ` ${n}.saved:(\`$())!();${n}.inst:(\`$())!();`,
    ns === "cov" ? ' .qlint.cov.d:("j"$d)#0j;.qlint.cov.hit:{@[{.qlint.cov.d[x]+:1};x;{}];x+1};' : LOCALS_STATE,
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
    // Only a restore: sent though the process is now evaluated directly (#2562).
    return readRestored(await Promise.race([connection.callOwn(restore), late]));
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
