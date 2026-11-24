// Restart Notebook Process and Run All (#1000), as Jupyter's Restart & Run
// All: the process the notebook's cells ran on is started afresh and every
// q cell runs on it, in order, from 1.
//
// Only a process q-lint started (the launcher, #954) is restarted, and only
// once the user says so: it is stopped and started again from its launch
// definition, and q-lint connects to it. Any other process q-lint cannot
// restart and does not try; the user is asked to restart it, and may run
// every cell on it as it is. The cells run through the notebook's kernel,
// so the read-only guard and a cell's `/ @process` hold as on any run.
import { NotebookCellKind, Uri, commands, window, workspace, type ExtensionContext, type NotebookDocument } from "vscode";
import type { Launcher } from "./launcherview";
import type { Live } from "./live";
import { requireFeature } from "./notebook";
import { NOTEBOOK } from "./qnb";
import { plainMessage } from "./history";

export interface NotebookRuns {
  processOf: (notebook: NotebookDocument) => string | undefined;
  /// Whether VS Code lets a cell of the notebook run: its kernel is selected.
  canRun: (notebook: NotebookDocument) => boolean;
  runAll: (notebook: NotebookDocument) => Promise<void>;
}

/// What Restart Notebook Process and Run All did, for tests.
export type RestartOutcome = "restarted" | "ran" | "declined" | "refused";

export class NotebookRestart {
  /// The last run's outcome and process, for tests.
  last: { outcome: RestartOutcome; process?: string } | undefined;

  constructor(
    context: ExtensionContext,
    private readonly live: Live,
    private readonly launcher: Pick<Launcher, "restart">,
    private readonly runs: NotebookRuns,
  ) {
    context.subscriptions.push(commands.registerCommand(NOTEBOOK.restartRunAll, (notebook?: Uri) => this.run(notebook)));
  }

  /// Ask `message` in a modal dialog, with `detail` under it: whether the
  /// user chose `button`. A method, so a run without dialogs - the e2e
  /// harness - can answer in their place.
  async ask(message: string, detail: string, button: string): Promise<boolean> {
    return (await window.showWarningMessage(plainMessage(message), { modal: true, detail }, button)) === button;
  }

  private done(outcome: RestartOutcome, process?: string): void {
    this.last = { outcome, process };
  }

  /// Whether the q cells of `notebook` can run, saying why not when they
  /// cannot: VS Code runs no cell of a notebook with no kernel selected, as
  /// one no cell of was run in this workspace yet. Found out before the
  /// process is stopped, not after (#1994).
  private runnable(notebook: NotebookDocument, cells: number): boolean {
    if (cells === 0 || this.runs.canRun(notebook)) {
      return true;
    }
    void window.showInformationMessage(
      "q-lint: nothing was restarted or run: VS Code has no kernel selected for this notebook, so its cells cannot run. Run a cell, or choose q (active connection) with Select Kernel, then try again.",
    );
    return false;
  }

  /// Run all of `notebook`'s q cells: whether they were run. A run VS Code
  /// refuses is said, after `what` was done before it, not thrown.
  private async runAll(notebook: NotebookDocument, what: string): Promise<boolean> {
    try {
      await this.runs.runAll(notebook);
      return true;
    } catch (e) {
      void window.showErrorMessage(plainMessage(`q-lint: ${what}: ${e instanceof Error ? e.message : String(e)}`));
      return false;
    }
  }

  /// Restart the process of `notebook` - the active q notebook when not
  /// given - when q-lint started it and the user agrees, then run all its
  /// q cells.
  async run(given?: Uri): Promise<void> {
    if (!requireFeature("restartRunAll")) {
      return this.done("refused");
    }
    const active = window.activeNotebookEditor?.notebook;
    const notebook = given instanceof Uri
      ? workspace.notebookDocuments.find((n) => n.uri.toString() === given.toString())
      : active?.notebookType === NOTEBOOK.type ? active : undefined;
    if (notebook === undefined) {
      void window.showInformationMessage("q-lint: open a q notebook to restart its process and run all its cells.");
      return this.done("refused");
    }
    const label = this.runs.processOf(notebook) ?? this.live.activeLabel();
    if (label === undefined) {
      void window.showInformationMessage("q-lint: the notebook has no process yet: connect to one, or run a cell, first.");
      return this.done("refused");
    }
    if (this.live.isBusy()) {
      void window.showInformationMessage(plainMessage(`q-lint: a query is still running on ${this.live.activeLabel()}. q-lint: Abort Current Query stops waiting for it.`));
      return this.done("refused", label);
    }
    const cells = notebook.getCells().filter((c) => c.kind === NotebookCellKind.Code && c.document.languageId === "q").length;
    if (!this.runnable(notebook, cells)) {
      return this.done("refused", label);
    }
    if (this.live.launched(label)) {
      const go = "Restart and Run All";
      const confirmed = await this.ask(
        `Restart ${label} and run all ${cells} q cells of the notebook?`,
        `q-lint started ${label}. It is stopped, so everything defined on it is lost, started again from its launch definition, and the cells run on it in order from 1, stopping at the first that fails.`,
        go,
      );
      if (!confirmed) {
        return this.done("declined", label);
      }
      // Turned off at the question: nothing is stopped or run (#1453).
      if (!requireFeature("restartRunAll") || !this.runnable(notebook, cells)) {
        return this.done("refused", label);
      }
      const problem = await this.launcher.restart(label);
      if (problem !== undefined) {
        void window.showErrorMessage(plainMessage(`q-lint: could not restart ${label}: ${problem}`));
        return this.done("refused", label);
      }
      if (!(await this.live.connectTo(label))) {
        return this.done("refused", label);
      }
      return this.done((await this.runAll(notebook, `${label} was restarted, but no cell ran`)) ? "restarted" : "refused", label);
    }
    const go = "Run All Without Restart";
    const confirmed = await this.ask(
      `${label} was not started by q-lint, so q-lint cannot restart it.`,
      `Restart ${label} yourself, then run all; or run all ${cells} q cells on it now, as it is, keeping what is defined there. A process q-lint starts from its launch definition (Start Process, in the Processes view) can be restarted from here.`,
      go,
    );
    if (!confirmed) {
      return this.done("declined", label);
    }
    if (!requireFeature("restartRunAll") || !this.runnable(notebook, cells)) {
      return this.done("refused", label);
    }
    // The cells go where they last ran, not wherever the connection is now.
    if (this.live.activeLabel() !== label && !(await this.live.connectTo(label))) {
      return this.done("refused", label);
    }
    return this.done((await this.runAll(notebook, `no cell ran on ${label}`)) ? "ran" : "refused", label);
  }
}
