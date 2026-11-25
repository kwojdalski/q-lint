// The dead code report (#1057): **q-lint: Show Dead Code Report** lists the
// functions defined in the workspace that nothing in the workspace reads,
// from the language server (`q-lint/deadCode`), as a Markdown report with a
// link to each definition. The server counts a name read when any file reads
// it as code or spells it in a symbol or string; it never lists a `.z`
// handler or a test.
//
// With q-lint.deadCode.checkProcess on (off by default: it sends a query),
// the candidates are checked against the active process too: one fixed,
// read-only lambda (`CALLED`) asks which of them the body of some function
// the process holds names, borrowing the connection as the Process Explorer
// does, and those are moved to their own section - called by code that is
// not in the workspace. Off (q-lint.deadCode.enable), the command refuses
// and asks nothing.
import { Uri, commands, window, workspace, type ExtensionContext } from "vscode";
import type { Server } from "./editorfeatures";
import { borrowWhenFree } from "./infoview";
import { LANGUAGE_COMMANDS, languageOff, languageOn } from "./languagefeatures";
import type { Live } from "./live";
import { plainMessage } from "./history";

export const DEAD_CODE = "q-lint/deadCode";

/// Which of a space-separated list of names some function in the process
/// other than itself calls or mentions, read from what q parsed as Find
/// Callers reads it (#2535): a lambda's globals (`(value f)3`, resolved in
/// its context, so `helper` in `.util` is `.util.helper`), those of the
/// lambdas nested in it, and a symbol among its tokens that names it
/// (`value`, `@` or `.` by name, #1227). A parameter, a local, a string or a
/// comment that spells the name is none of these. Every namespace but q's
/// own (PeachQ's `.help` among them), KDB-X's SQL `.s` and q-lint's `.qlint`
/// (#2534), and `.z`. A root name that is no namespace (`.cfg:42`) lists nothing (#1370).
/// The functions are the lambdas of every namespace, however deep, and
/// those held in a projection, a composition or an iterator's derived
/// function, or in a list or dictionary of at most 1000 items - a table of
/// handlers (#1901); a view is not read. Reads only. Checked on KDB-X and PeachQ; PeachQ lists no `.z`
/// handler, so a function only a handler calls stays a candidate there.
export const CALLED = [
  "{[nms]",
  " n:\" \" vs(),nms;",
  " lam:{$[100h=t:type x;enlist x;t within 104 111h;raze .z.s each(),value x;$[t in 0 99h;1000>=count x;0b];raze .z.s each $[99h=t;value x;x];()]};",
  " isns:{$[99h=type x;$[11h=type key x;(::)~first x;0b];0b]};",
  " todo:`.,` sv'`,'(key`) except``q`Q`h`j`o`m`s`help`qlint;",
  " fs:`$();b:();",
  " while[count todo;",
  "  ns:first todo;todo:1_todo;",
  "  d:@[get;ns;{()!()}];if[not $[99h=type d;11h=type key d;0b];d:(`$())!()];",
  "  k:(key d)except`;",
  "  if[ns~`.;k:k except views[]];",
  "  kids:$[ns~`.;`$();k where isns each d k];",
  "  todo,:` sv'ns,'kids;k:k except kids;",
  "  l:@[lam;;()]each d k;",
  "  fs,:raze(count each l)#'$[ns~`.;k;` sv'ns,'k];",
  "  b,:raze l];",
  " rs:{[c;x]$[(null c)|\".\"=first string x;x;` sv`,c,x]};",
  " calls:{[rs;f]v:value f;g:v 3;(rs[first g]each(1_g)except`),raze .z.s[rs]each v where 100h=type each v}[rs];",
  " says:{[f]k:@[-4!;last value f;{()}];raze{`$1_\"`\"vs x}each k where\"`\"=first each k};",
  " u:{[calls;says;f]@[calls;f;`$()],@[says;f;`$()]}[calls;says]each b;",
  " n where{[fs;u;n]any(fs<>n)&n in/:u}[fs;u]each`$n}",
].join("\n");

export interface DeadFunction {
  name: string;
  uri: string;
  line: number;
}

/// The server's answer as functions, sorted as it sent them, and the count
/// of places reached by a computed name; undefined for anything else.
export function readDeadCode(answer: unknown): { functions: DeadFunction[]; dynamic: number } | undefined {
  const a = answer as { functions?: unknown; dynamic?: unknown } | null | undefined;
  if (!a || typeof a !== "object" || !Array.isArray(a.functions)) {
    return undefined;
  }
  const functions = a.functions.flatMap((f: { name?: unknown; uri?: unknown; range?: { start?: { line?: unknown } } }) =>
    typeof f?.name === "string" && typeof f.uri === "string" && typeof f.range?.start?.line === "number"
      ? [{ name: f.name, uri: f.uri, line: f.range.start.line }]
      : [],
  );
  return { functions, dynamic: typeof a.dynamic === "number" ? a.dynamic : 0 };
}

/// The report, as Markdown: each function linked to its definition, grouped
/// by file; those the process calls apart.
export function deadCodeReport(
  functions: DeadFunction[],
  dynamic: number,
  relative: (uri: string) => string,
  called?: { process: string; names: Set<string> },
): string {
  const escape = (s: string) => s.replace(/([\\`*_[\]()#<>|])/g, "\\$1");
  const link = (f: DeadFunction) => `- [${escape(f.name)}](${f.uri}#L${f.line + 1}) - line ${f.line + 1}`;
  const unused = functions.filter((f) => !called?.names.has(f.name));
  const lines = ["# q dead code", ""];
  lines.push(
    unused.length === 0
      ? "Every function the workspace defines is read somewhere in it."
      : `${unused.length} function(s) defined in the workspace that nothing in the workspace reads:`,
  );
  let file = "";
  for (const f of unused) {
    if (f.uri !== file) {
      file = f.uri;
      lines.push("", `## ${escape(relative(f.uri))}`, "");
    }
    lines.push(link(f));
  }
  if (called !== undefined) {
    const used = functions.filter((f) => called.names.has(f.name));
    lines.push("", `## Called on ${escape(called.process)}`, "");
    lines.push(
      used.length === 0
        ? "No candidate is named by a function the process holds."
        : "Named by a function the process holds that is not in the workspace:",
    );
    lines.push(...used.map(link));
  }
  lines.push(
    "",
    "_Read from the source: a function reached by a name built at run time is not seen" +
      (dynamic > 0 ? ` - the workspace does that in ${dynamic} place(s)` : "") +
      ", so check each before deleting it._",
  );
  return lines.join("\n") + "\n";
}

export function registerDeadCode(context: ExtensionContext, live: Live, server: () => Server | undefined): void {
  const get = (key: string, fallback: unknown) => workspace.getConfiguration("q-lint").get(key, fallback);
  context.subscriptions.push(
    commands.registerCommand(LANGUAGE_COMMANDS.deadCode, async () => {
      if (!languageOn(get as never, "deadCode")) {
        void window.showInformationMessage(plainMessage(languageOff("deadCode")));
        return undefined;
      }
      const client = server();
      if (client === undefined) {
        void window.showWarningMessage("q-lint: the dead code report needs the language server, which is not running.");
        return undefined;
      }
      const answer = readDeadCode(await client.sendRequest(DEAD_CODE, {}));
      if (answer === undefined) {
        void window.showWarningMessage("q-lint: the language server had no dead code report; it may be older than this extension.");
        return undefined;
      }
      let called: { process: string; names: Set<string> } | undefined;
      if (languageOn(get as never, "deadCodeProcess") && answer.functions.length > 0 && live.activeLabel() !== undefined) {
        const names = answer.functions.map((f) => f.name).join(" ");
        // A process that fails the check leaves the report to the workspace (#1370).
        const got = await borrowWhenFree(live, async (connection, process) => ({
          process: process.label,
          names: await connection.call(CALLED, names),
        })).catch(() => undefined);
        if (got !== undefined && Array.isArray(got.value.names)) {
          called = { process: got.value.process, names: new Set(got.value.names.filter((n): n is string => typeof n === "string")) };
        } else {
          void window.showInformationMessage("q-lint: the active process was busy or did not answer; the report is from the workspace alone.");
        }
      }
      const text = deadCodeReport(answer.functions, answer.dynamic, (uri) => workspace.asRelativePath(Uri.parse(uri)), called);
      const document = await workspace.openTextDocument({ language: "markdown", content: text });
      await window.showTextDocument(document, { preview: true });
      return text;
    }),
  );
}
