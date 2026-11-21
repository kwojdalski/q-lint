// Code run from a cell (#956, #958), Smart Send (#957) or the q REPL pane
// (#959), for a pane that shows the answer itself: on the process the file
// is bound to, through `Live.runOnActive` - so the read-only guard (#918)
// asks before code that would change a guarded process, and Abort Current
// Query stops waiting - and recorded in Query History as a query is.
import { window, workspace, type Uri } from "vscode";
import type { Live } from "./live";
import { readLive } from "./liveconfig";
import { render, type Answer } from "./query";
import { statements } from "./statements";

/// One run, as a pane shows it.
export interface Ran {
  process: string;
  code: string;
  millis: number;
  answer: Answer;
}

/// The lines a pane shows for `ran`: q's text, or the error and its trace,
/// without the header the output channel puts above them.
export function answerLines(ran: Pick<Ran, "process" | "code" | "millis" | "answer">): string[] {
  return render(ran, { includeQuery: false, ignoreNullReturn: false }).slice(1);
}

/// Run `code` and answer what it gave; undefined, having said why, when it
/// was not run: nothing in it to run, no process, a query still running,
/// or the guard's question declined. `uri`: the file it is from, whose
/// bound process it goes to.
export async function runText(live: Live, code: string, uri?: Uri): Promise<Ran | undefined> {
  const cut = statements(code);
  if (cut.length === 0) {
    return undefined;
  }
  const bound = uri === undefined ? undefined : live.fileBinding(uri);
  if (bound !== undefined && bound !== live.activeLabel()) {
    if (live.isBusy()) {
      void window.showInformationMessage(
        `q-lint: a query is still running on ${live.activeLabel()}; this file's code goes to ${bound}. q-lint: Abort Current Query stops waiting for it.`,
      );
      return undefined;
    }
    if (!(await live.connectTo(bound))) {
      return undefined;
    }
  }
  const configuration = workspace.getConfiguration("q-lint");
  const { consoleSize } = readLive((key, fallback) => configuration.get(key, fallback));
  const started = Date.now();
  let ran: { process: string; value: Answer } | undefined;
  try {
    ran = await live.runOnActive(code, (connection) => connection.query(cut, consoleSize));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Not run:")) {
      void window.showInformationMessage(`q-lint: ${message}`);
      return undefined;
    }
    const process = live.activeLabel() ?? "the process";
    const answer: Answer = { ok: false, error: message, trace: "" };
    await live.record({ process, code, at: new Date(started).toISOString(), millis: Date.now() - started, outcome: "error", error: message });
    return { process, code, millis: Date.now() - started, answer };
  }
  if (ran === undefined) {
    return undefined;
  }
  const millis = Date.now() - started;
  const answer = ran.value;
  await live.record({
    process: ran.process,
    code,
    at: new Date(started).toISOString(),
    millis,
    outcome: answer.ok ? "ok" : "error",
    ...(answer.ok ? {} : { error: answer.error }),
  });
  return { process: ran.process, code, millis, answer };
}
