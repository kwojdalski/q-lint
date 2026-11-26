// Code run from a cell (#956, #958), Smart Send (#957) or the q REPL pane
// (#959), for a pane that shows the answer itself: on the process the file
// is bound to, through `Live.runOnActive` - so the read-only guard (#918)
// asks before code that would change a guarded process, and Abort Current
// Query stops waiting - and recorded in Query History as a query is.
import { window, workspace, type Uri } from "vscode";
import { fileServerTypes } from "./gateway";
import { Stopped, type Live } from "./live";
import { readLive } from "./liveconfig";
import { render, type Answer } from "./query";
import { inContext, statements } from "./statements";
import { plainMessage } from "./history";
import { UNLIMITED, UNLIMITED_READ_ONLY, limits, readUnlimited, runUnwrapped } from "./querycontrols";

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

/// Run `written`, its placeholders filled in, and answer what it gave;
/// undefined, having said why, when it was not run: nothing in it to run,
/// a placeholder's box escaped, no process, a query still running, or the
/// guard's question declined. `uri`: the file it is from, whose
/// bound process it goes to. `context`: the `\d` the text before it left,
/// which it runs in (#2286).
export async function runText(live: Live, written: string, uri?: Uri, context = "."): Promise<Ran | undefined> {
  if (statements(written).length === 0) {
    return undefined;
  }
  // Its `{{placeholders}}` asked for, as Run Query asks for them (#2364).
  const code = await live.filledIn(written);
  if (code === undefined) {
    return undefined;
  }
  const cut = statements(code);
  if (!(await live.toFileBinding(uri))) {
    return undefined;
  }
  // The server types its file names on a `/ @servertypes` line, which Run
  // Query sends the same code to (#3063).
  const file = uri === undefined ? undefined : (workspace.textDocuments ?? []).find((d) => d.uri.toString() === uri.toString());
  const named = file === undefined ? undefined : fileServerTypes(file.getText());
  const configuration = workspace.getConfiguration("q-lint");
  // Toggle Unlimited Query holds here as for Run Query (#2362).
  const unlimited = live.isUnlimited();
  const { consoleSize } = limits(readLive((key, fallback) => configuration.get(key, fallback)), unlimited);
  const started = Date.now();
  let ran: { process: string; value: Answer } | undefined;
  // The process it is sent to, read as it is sent: a query that fails has
  // closed the connection, and `activeLabel` names none then (#1872).
  let sentTo = live.activeLabel();
  try {
    ran = await live.runOnActive(code, (connection) => {
      sentTo = live.activeLabel() ?? sentTo;
      // Through a TorQ gateway's .gw.syncexec, as Run sends it (#2356).
      const sent = live.gatewayed(inContext(cut, context), named);
      // Direct evaluation (#2470), or a gateway call (#2584): each
      // statement as a plain string. Unlimited as Run Query is (#2362).
      return connection.isDirect || sent.plain
        ? runUnwrapped(connection, sent.cut, { size: consoleSize, limit: 0, unlimited, grid: false })
        : unlimited
          ? connection.trapped(UNLIMITED, UNLIMITED_READ_ONLY, readUnlimited, sent.cut, consoleSize)
          : connection.query(sent.cut, consoleSize);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Not run:")) {
      void window.showInformationMessage(plainMessage(`q-lint: ${message}`));
      return undefined;
    }
    const process = sentTo ?? "the process";
    // Aborted or timed out is kept as that, as a query from the editor is.
    const outcome = error instanceof Stopped ? error.outcome : "error";
    const said = outcome === "aborted" ? "aborted" : message;
    const answer: Answer = { ok: false, error: said, trace: "" };
    await live.record({ process, code, at: new Date(started).toISOString(), millis: Date.now() - started, outcome, error: said });
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
