// Locals at the error (#985): **Capture Locals at Last Error** runs the
// last query that failed again, with a function of its backtrace
// instrumented to keep its arguments - as the parameter cache (#892) keeps
// them - the statement it is on, and each local as it is assigned, then puts
// the function back and shows what was kept. It is asked first, as the query
// runs again and can change data again; the function is replaced in the
// same call it is put back in, through the read-only guard (#918). Only the
// command sends anything. While q-lint.localsAtError.enable is off it is
// hidden and refuses.
import { EventEmitter, Uri, commands, window, workspace, type ExtensionContext, type TextDocumentContentProvider } from "vscode";
import { DRIFT, readDrift } from "./definitions";
import { editorFeatureOff, editorFeatureOn } from "./editorfeatures";
import { installLambda, localsText, readInstalled, readRestored, restoreExpression } from "./instrument";
import type { Live } from "./live";
import { CAPTURE_LOCALS, localsDocument, namedFrames, readCapture } from "./locals";
import { RUN, readAnswer } from "./query";
import { statements } from "./statements";
import { plainMessage } from "./history";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "localsAtError");

export const LOCALS_SCHEME = "q-lint-locals";

class Shown implements TextDocumentContentProvider {
  readonly texts = new Map<string, string>();
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidChange = this.changed.event;
  provideTextDocumentContent(uri: Uri): string {
    return this.texts.get(uri.path) ?? "";
  }
  set(uri: Uri, text: string): void {
    this.texts.set(uri.path, text);
    this.changed.fire(uri);
  }
}

export function registerLocalsAtError(
  context: ExtensionContext,
  live: Live,
): { last: () => string | undefined; failure: () => Live["lastFailure"] } {
  const shown = new Shown();
  let last: string | undefined;
  const capture = async (): Promise<void> => {
    if (!on()) {
      void window.showInformationMessage(plainMessage(editorFeatureOff("localsAtError")));
      return;
    }
    const failure = live.lastFailure;
    if (failure === undefined) {
      void window.showInformationMessage("q-lint: no query has failed yet; run the one that fails inside a function first.");
      return;
    }
    if (live.activeLabel() !== failure.process) {
      void window.showInformationMessage(plainMessage(`q-lint: the last failed query ran on ${failure.process}; connect to it again to look into it.`));
      return;
    }
    const frames = namedFrames(failure.trace);
    if (frames.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: the backtrace of '${failure.error} names no function to look into.`));
      return;
    }
    const picked =
      frames.length === 1
        ? frames[0]
        : await window.showQuickPick(
            frames.map((f) => ({ label: f.name, description: f.where, frame: f })),
            { title: "Capture Locals at Last Error", placeHolder: "The function whose arguments and locals to keep (innermost first)" },
          ).then((p) => p?.frame);
    if (picked === undefined) {
      return;
    }
    const again = "Run Again";
    const sure = await window.showWarningMessage(
      plainMessage(`Run the failed query again on ${failure.process}, with ${picked.name} keeping its arguments and locals?`),
      { modal: true, detail: `${failure.code}\n\nIt runs again as written, and can change data again. ${picked.name} is replaced while it runs, and put back after.` },
      again,
    );
    if (sure !== again) {
      return;
    }
    const install = installLambda("err");
    const restore = restoreExpression("err");
    let done;
    try {
      // Only on the process the question named (#1292). The replacing goes
      // first: a failed query ending the script (`\`) or opening a comment
      // (`/`) would hide what came after it from the guard (#1422).
      done = await live.runOnActive(`${install}\n${failure.code}`, async (connection) => {
        readRestored(await connection.call(restore));
        const state = readDrift(await connection.call(DRIFT, picked.name)).get(picked.name);
        if (state?.state !== "lambda") {
          throw new Error(`${picked.name} is not a lambda on the process`);
        }
        const captured = localsText(state.text);
        if (captured === undefined) {
          throw new Error(`${picked.name}'s text could not be read as one lambda`);
        }
        const [status] = readInstalled(await connection.call(install, [picked.name], [state.text], [captured.text], 0), 1);
        if (status !== "ok") {
          await connection.call(restore);
          throw new Error(`${picked.name} could not be instrumented: ${status}`);
        }
        // Put back whatever the run does: RUN traps q's errors, so only the
        // connection failing skips it, and the next capture puts it back.
        const answer = await connection.call(RUN, statements(failure.code), [25, 200]).then(readAnswer, async (error: unknown) => {
          await connection.call(restore).catch(() => undefined);
          throw error;
        });
        const restored = readRestored(await connection.call(restore));
        return { captured, answer, restored, text: state.text };
      }, "ask", failure.process);
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: no locals captured: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (done === undefined) {
      return;
    }
    const { captured, answer, restored, text } = done.value;
    if (restored.kept.length > 0) {
      void window.showWarningMessage(plainMessage(`q-lint: ${restored.kept.join(", ")} was redefined while the query ran, and is left as it is now.`));
    }
    last = localsDocument({
      name: picked.name,
      process: done.process,
      code: failure.code,
      text,
      statements: captured.statements,
      capture: readCapture(restored.d),
      error: answer.ok ? undefined : answer.error,
    });
    const uri = Uri.from({ scheme: LOCALS_SCHEME, path: `/${picked.name.replace(/^\./, "")} locals.q` });
    shown.set(uri, last);
    await window.showTextDocument(await workspace.openTextDocument(uri), { preview: true });
  };
  context.subscriptions.push(workspace.registerTextDocumentContentProvider(LOCALS_SCHEME, shown), commands.registerCommand(CAPTURE_LOCALS, capture));
  return { last: () => last, failure: () => live.lastFailure };
}
