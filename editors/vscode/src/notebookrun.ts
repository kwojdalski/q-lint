// Run Notebook with Parameters (#947): the notebook run from start to end
// without its editor, its parameters cell's values changed, and written
// with this run's outputs to a new file - a `.qnb`, an HTML page or a
// Jupyter notebook. The run is `qnbrun.ts`'s, the same the shell's
// `node out/qnbrun.js` makes; here its cells go to the active connection
// through `Live`, as the notebook kernel's do, and a `/ @process` cell
// connects as it does in the kernel.
import { ProgressLocation, Uri, window, workspace } from "vscode";
import * as path from "node:path";
import type { Live } from "./live";
import { readLive, readNotebook, rowsArgument } from "./liveconfig";
import { featureOff, featureOn, qnbOf, requireFeature, scriptBeside, switchProcess } from "./notebook";
import { NOTEBOOK, type Qnb } from "./qnb";
import { parametersCell, parametersOf, runNotebook, writeAs, type RunResult } from "./qnbrun";
import { plainMessage } from "./history";

/// Ask for each parameter's value, the notebook's own offered: those
/// changed, by name, or undefined when the user pressed Escape.
async function askParameters(qnb: Qnb): Promise<Record<string, string> | undefined> {
  const at = parametersCell(qnb.cells);
  if (at < 0) {
    return {};
  }
  const params = parametersOf(qnb.cells[at].source);
  const changed: Record<string, string> = {};
  for (const [i, { name, value }] of params.entries()) {
    const given = await window.showInputBox({
      title: `q-lint: parameter ${i + 1} of ${params.length}: ${name}`,
      value,
      prompt: `q text. The notebook's value is ${value}.`,
      validateInput: (v) => (v.trim() === "" ? "A value is needed: Escape cancels the run." : /[\r\n]/.test(v) ? "One line of q." : undefined),
    });
    if (given === undefined) {
      return undefined;
    }
    if (given.trim() !== value) {
      changed[name] = given.trim();
    }
  }
  return changed;
}

/// Run the notebook at `source` - the active one when not given - with
/// `overrides` (asked for when not given), and write it to `target` (or
/// where the user picks). What the run did, or undefined when it did not
/// start.
export async function runWithParameters(live: Live, source?: Uri, target?: Uri, overrides?: Record<string, string>): Promise<RunResult | undefined> {
  if (!requireFeature("parameters")) {
    return undefined;
  }
  const active = window.activeNotebookEditor?.notebook;
  const from = source instanceof Uri ? source : active?.notebookType === NOTEBOOK.type ? active.uri : undefined;
  if (from === undefined) {
    void window.showInformationMessage("q-lint: open a q notebook (.qnb) to run it with parameters.");
    return undefined;
  }
  let qnb: Qnb;
  try {
    qnb = await qnbOf(from);
  } catch (error) {
    void window.showErrorMessage(plainMessage(`q-lint: could not read ${from.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
    return undefined;
  }
  const given = overrides ?? (await askParameters(qnb));
  if (given === undefined) {
    return undefined;
  }
  const name = path.posix.basename(from.path);
  const to =
    target instanceof Uri
      ? target
      : await window.showSaveDialog({
          title: "Write the run's notebook, with its outputs, to",
          // On disk, for an untitled notebook too (#1549).
          defaultUri: scriptBeside(from, "-run.qnb"),
          filters: { "q notebook": ["qnb"], HTML: ["html"], "Jupyter notebook": ["ipynb"] },
        });
  if (to === undefined) {
    return undefined;
  }
  const configuration = workspace.getConfiguration("q-lint");
  const get = <T>(key: string, fallback: T): T => configuration.get(key, fallback);
  const limit = readNotebook(get);
  const settings = { consoleSize: readLive(get).consoleSize, rows: rowsArgument(limit), rowLimitFrom: limit.rowLimitFrom };
  let result: RunResult;
  try {
    result = await window.withProgress(
      { location: ProgressLocation.Notification, title: `q-lint: running ${name}`, cancellable: true },
      async (progress, token) => {
        // As the kernel's interrupt: Cancel stops the query of the cell
        // running, not only the cells after it (#1564).
        let running = false;
        const stop = token.onCancellationRequested(() => {
          if (running) {
            void live.abort();
          }
        });
        try {
          return await runNotebook(
            qnb,
            {
              on: async (label, code, use) => {
                if (label !== undefined) {
                  if (!featureOn("processDirective")) {
                    throw new Error(featureOff("processDirective"));
                  }
                  const problem = await switchProcess(live, label);
                  if (problem !== undefined) {
                    throw new Error(problem);
                  }
                }
                const ran = await live.runOnActive(code, async (connection) => {
                  running = true;
                  try {
                    return await use(connection);
                  } finally {
                    running = false;
                  }
                });
                if (ran === undefined) {
                  throw new Error("Not run: no q process is connected, or a query is still running on it.");
                }
                return ran.value;
              },
            },
            settings,
            given,
            { progress: (cell, of) => progress.report({ message: `cell ${cell} of ${of}` }), cancelled: () => token.isCancellationRequested, liveValues: featureOn("liveValues") },
          );
        } finally {
          stop.dispose();
        }
      },
    );
  } catch (error) {
    void window.showErrorMessage(plainMessage(`q-lint: could not run ${name}: ${error instanceof Error ? error.message : String(error)}`));
    return undefined;
  }
  try {
    await workspace.fs.writeFile(to, Buffer.from(writeAs(result.qnb, to.path, name), "utf8"));
  } catch (error) {
    void window.showErrorMessage(plainMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
    return result;
  }
  if (!(target instanceof Uri)) {
    const said = result.failed === undefined
      ? `q-lint: ran ${result.ran} cells of ${name}; wrote ${to.fsPath}.`
      : `q-lint: cell ${result.failed.cell} of ${name} failed (${result.failed.message}); wrote the run up to it to ${to.fsPath}.`;
    const open = "Open";
    const answer = await (result.failed === undefined ? window.showInformationMessage(plainMessage(said), open) : window.showWarningMessage(plainMessage(said), open));
    if (answer === open) {
      if (/\.qnb$/i.test(to.path)) {
        await window.showNotebookDocument(await workspace.openNotebookDocument(to));
      } else {
        await window.showTextDocument(to);
      }
    }
  }
  return result;
}
