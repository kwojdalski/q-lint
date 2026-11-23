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

export const DEAD_CODE = "q-lint/deadCode";

/// Which of a space-separated list of names the body of some function in
/// the process names as a word (its last part), other than its own: every namespace but q's own, and
/// `.z`. Reads only. Checked on KDB-X and PeachQ; PeachQ lists no `.z`
/// handler, so a function only a handler calls stays a candidate there.
export const CALLED = [
  "{[nms]",
  " n:\" \" vs(),nms;",
  " fs:raze {[ns] $[ns~`.;system\"f\";` sv' ns,'system\"f \",string ns]} each `.,` sv'`,'(key`) except `q`Q`h`j`o`m;",
  " fs:fs where 100h=type each get each fs;",
  " b:{last value get x} each fs;",
  " w:{[s;l] any {[s;l;i] not any s[(i-1),i+count l] in .Q.an,\"_.\"}[s;l] each ss[s;l]};",
  " n where {[b;fs;w;n] any (fs<>`$n) & w[;last \".\" vs n] each b}[b;fs;w] each n}",
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
        void window.showInformationMessage(languageOff("deadCode"));
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
        const got = await borrowWhenFree(live, async (connection, process) => ({
          process: process.label,
          names: await connection.call(CALLED, names),
        }));
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
