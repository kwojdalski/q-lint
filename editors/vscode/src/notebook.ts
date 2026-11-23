// q notebooks (`.qnb`): the file, the kernel that runs their cells, and
// Export Notebook.
//
// The file's format and the script an export writes are `qnb.ts`'s; how a
// cell asks for its output, `celldirectives.ts`'s; what a `@grid` or
// `@chart` cell asks the process for and the outputs a cell shows,
// `celldata.ts`'s; drawing a chart, the renderer `media/chartrenderer.js`'s,
// which says here what it drew. A cell is cut into statements as a query is
// (`statements.ts`) and runs on the extension's active connection through
// `Live`, so a notebook and the editor's queries share one process, one
// status bar and one Abort - unless a cell says `/ @process <label>`, which
// connects to that process first, as a file bound to one does (#950).
//
// A Markdown cell's `{{q: expr}}` values are read on the process after the
// code cell above it runs (`livemarkdown.ts`, #949). Export as HTML or
// Jupyter, and Import Jupyter Notebook, are `qnbconvert.ts`'s formats
// (#948).
import {
  NotebookCellData,
  NotebookCellKind,
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookData,
  NotebookEdit,
  ConfigurationTarget,
  EventEmitter,
  WorkspaceEdit,
  Uri,
  commands,
  notebooks,
  window,
  workspace,
  type CancellationToken,
  type ExtensionContext,
  type NotebookCell,
  type NotebookCellExecution,
  type NotebookController,
  type NotebookDocument,
  type NotebookSerializer,
} from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { isProduction, resolveProcess } from "./agent";
import { type OutputPart } from "./celldata";
import { cellDirective } from "./celldirectives";
import { LIVE_KEY, liveExpressions, markdownAfter, type LiveValue } from "./livemarkdown";
import { cellAnswer, guardedText, liveValues } from "./qnbrun";
import { fromIpynb, toHtml, toIpynb } from "./qnbconvert";
import { address } from "./processes";
import {
  readLive,
  readNotebook,
  rowLimitLabel,
  rowsArgument,
  RESULTS,
  ROW_LIMIT_CHOICES,
  ROW_LIMIT_FROM,
  type RowLimitFrom,
} from "./liveconfig";
import type { Live } from "./live";
import { decodeItem, encodeItem, exportScript, NOTEBOOK, parseQnb, serializeQnb, type Qnb, type QnbCell, type QnbOutput } from "./qnb";
import { statements } from "./statements";

/// Where the fields of a file, a cell or an output this extension does not
/// know ride in VS Code's metadata between an open and a save; never written
/// as metadata. An output's holds its items' too.
const EXTRA = "q-lint.unknownFields";
/// Where a cell's run's unknown fields ride, with the run they belong to:
/// a run of the cell since does not get them.
const RUN_EXTRA = "q-lint.unknownRunFields";

type Json = Record<string, unknown>;

/// `metadata` with `extra` added under `EXTRA`, or undefined when both are empty.
function stash(metadata: Record<string, unknown> | undefined, extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return extra === undefined ? metadata : { ...metadata, [EXTRA]: extra };
}

/// VS Code's metadata split back into the file's `metadata` and `extra`.
function unstash(metadata: { [key: string]: unknown } | undefined): { metadata?: Record<string, unknown>; extra?: Record<string, unknown> } {
  if (metadata === undefined) {
    return {};
  }
  const { [EXTRA]: extra, [RUN_EXTRA]: _run, ...rest } = metadata;
  return { metadata: rest, ...(typeof extra === "object" && extra !== null ? { extra: extra as Record<string, unknown> } : {}) };
}

const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/// An output's metadata with its own and its items' unknown fields added.
function stashOutput(output: QnbOutput): Json | undefined {
  const items = output.items.map((i) => i.extra ?? null);
  if (output.extra === undefined && items.every((i) => i === null)) {
    return output.metadata;
  }
  return { ...output.metadata, [EXTRA]: { ...(output.extra !== undefined ? { output: output.extra } : {}), items } };
}

/// An output as the file keeps it, its unknown fields taken back out of its
/// metadata.
function unstashOutput(output: NotebookCellOutput): QnbOutput {
  const { [EXTRA]: stashed, ...metadata } = output.metadata ?? {};
  const extra = isJson(stashed) ? stashed : {};
  const items = Array.isArray(extra.items) ? extra.items : [];
  return {
    items: output.items.map((i, k) => {
      const item = encodeItem(i.mime, i.data);
      return isJson(items[k]) ? { ...item, extra: items[k] as Json } : item;
    }),
    ...(output.metadata !== undefined ? { metadata } : {}),
    ...(isJson(extra.output) ? { extra: extra.output } : {}),
  };
}

class QnbSerializer implements NotebookSerializer {
  deserializeNotebook(content: Uint8Array, _token: CancellationToken): NotebookData {
    // A file that is not a notebook throws here, and the editor says why
    // instead of opening an empty notebook a save would write over it.
    const qnb = parseQnb(Buffer.from(content).toString("utf8"));
    const data = new NotebookData(
      qnb.cells.map((cell) => {
        const code = cell.kind === "code";
        const item = new NotebookCellData(
          code ? NotebookCellKind.Code : NotebookCellKind.Markup,
          cell.source,
          code ? (cell.language ?? "q") : "markdown",
        );
        if (cell.outputs !== undefined) {
          item.outputs = cell.outputs.map(
            (o) => new NotebookCellOutput(o.items.map((i) => new NotebookCellOutputItem(decodeItem(i), i.mime)), stashOutput(o)),
          );
        }
        if (cell.execution !== undefined) {
          const { order, success, start, end } = cell.execution;
          item.executionSummary = {
            executionOrder: order,
            success,
            timing: start !== undefined && end !== undefined ? { startTime: start, endTime: end } : undefined,
          };
        }
        let metadata = stash(cell.metadata, cell.extra);
        // A start without an end, or an end alone, which VS Code's timing
        // cannot hold, rides with the run's unknown fields.
        const lone = cell.execution === undefined || (cell.execution.start === undefined) === (cell.execution.end === undefined)
          ? undefined
          : cell.execution.start !== undefined ? { start: cell.execution.start } : { end: cell.execution.end };
        if (cell.execution?.extra !== undefined || lone !== undefined) {
          const { order, start, extra } = cell.execution ?? {};
          metadata = { ...metadata, [RUN_EXTRA]: { order, start: lone === undefined ? start : undefined, extra, lone } };
        }
        if (metadata !== undefined) {
          item.metadata = metadata;
        }
        return item;
      }),
    );
    const metadata = stash(qnb.metadata, qnb.extra);
    if (metadata !== undefined) {
      data.metadata = metadata;
    }
    return data;
  }

  serializeNotebook(data: NotebookData, _token: CancellationToken): Uint8Array {
    const cells = data.cells.map((cell): QnbCell => {
      const code = cell.kind === NotebookCellKind.Code;
      const summary = cell.executionSummary;
      // The run's unknown fields, while the run is still the one they came with.
      const run = cell.metadata?.[RUN_EXTRA];
      const same = isJson(run) && run.order === summary?.executionOrder && run.start === summary?.timing?.startTime;
      const runExtra = same && isJson(run.extra) ? { extra: run.extra } : {};
      const lone = same && isJson(run.lone) && summary?.timing === undefined ? (run.lone as { start?: number; end?: number }) : {};
      return {
        kind: code ? "code" : "markdown",
        source: cell.value,
        ...(code && cell.languageId !== "q" ? { language: cell.languageId } : {}),
        ...(code && cell.outputs !== undefined
          ? {
              outputs: cell.outputs.map(unstashOutput),
            }
          : {}),
        ...(code && summary !== undefined
          ? {
              execution: {
                order: summary.executionOrder,
                success: summary.success,
                start: summary.timing?.startTime ?? lone.start,
                end: summary.timing?.endTime ?? lone.end,
                ...runExtra,
              },
            }
          : {}),
        ...unstash(cell.metadata),
      };
    });
    return Buffer.from(serializeQnb({ cells, ...unstash(data.metadata) }), "utf8");
  }
}

const toOutput = (part: OutputPart): NotebookCellOutput =>
  part.kind === "error"
    ? new NotebookCellOutput([NotebookCellOutputItem.error({ name: part.name, message: part.message, stack: part.stack })])
    : new NotebookCellOutput(part.items.map((i) => NotebookCellOutputItem.text(i.text, i.mime)));

const notice = (text: string): NotebookCellOutput => new NotebookCellOutput([NotebookCellOutputItem.stderr(text)]);

/// The notebook features a setting turns on and off, each
/// `q-lint.notebook.<feature>.enable`, and what each is called when it says
/// it is off. Read when used, so a change needs no reload.
export const FEATURES = {
  variables: "The Notebook Variables view",
  parameters: "Run Notebook with Parameters",
  export: "Notebook export to HTML and Jupyter, and Jupyter import,",
  liveValues: "Live values in Markdown cells",
  processDirective: "The / @process cell directive",
  diff: "Compare Notebook Cells",
  stripOutputs: "Clearing notebook outputs and the git filter that strips them",
  restartRunAll: "Restart Notebook Process and Run All",
} as const;
export type Feature = keyof typeof FEATURES;

export const featureSetting = (feature: Feature): string => `q-lint.notebook.${feature}.enable`;

export function featureOn(feature: Feature): boolean {
  return workspace.getConfiguration("q-lint").get<boolean>(`notebook.${feature}.enable`, true) !== false;
}

/// What a command or a directive of a feature that is off says.
export const featureOff = (feature: Feature): string =>
  `${FEATURES[feature]} is turned off: set ${featureSetting(feature)} to true to turn it on.`;

/// Whether `feature` is on; when it is not, says so.
export function requireFeature(feature: Feature): boolean {
  if (featureOn(feature)) {
    return true;
  }
  void window.showInformationMessage(`q-lint: ${featureOff(feature)}`);
  return false;
}

/// Make the process `label` names the active connection, for a cell that
/// says `/ @process <label>`: a saved process or a discovered one, its
/// password from secret storage or asked for as Connect asks. Connecting to
/// a production process is confirmed first. Why it could not, or undefined
/// once it is the active connection.
export async function switchProcess(live: Live, label: string): Promise<string | undefined> {
  if (live.activeLabel() === label) {
    return undefined;
  }
  const found = resolveProcess(label, live.processes(), live.discovery.discovered());
  if ("error" in found) {
    return found.error;
  }
  const { process } = found;
  if (live.activeLabel() === process.label) {
    return undefined;
  }
  if (live.isBusy()) {
    return `Not run: a query is still running on ${live.activeLabel()}, and this cell runs on ${process.label}. q-lint: Abort Current Query stops waiting for it.`;
  }
  if (isProduction(process)) {
    const go = "Connect and Run";
    const answer = await window.showWarningMessage(
      `${process.label} is a production process (tagged ${process.tags.join(", ")}). Connect to it and run the cell there?`,
      { modal: true, detail: `The cell says / @process ${label}. It runs on ${address(process.host, process.port)} as written, and later cells run there too.` },
      go,
    );
    if (answer !== go) {
      return `Not run: connecting to the production process ${process.label} was not confirmed.`;
    }
  }
  return (await live.connectTo(process.label)) ? undefined : `Not run: could not connect to ${process.label} (${address(process.host, process.port)}).`;
}

/// Runs code cells on the active connection: one at a time, in the order
/// asked, each numbered and timed.
class QnbKernel {
  private readonly controller: NotebookController;
  /// Each notebook's last run number: a notebook is numbered on its own.
  private readonly orders = new WeakMap<NotebookDocument, number>();
  /// The cells asked for so far, run one after another.
  private queue: Promise<void> = Promise.resolve();
  /// The process each notebook's cells last ran on, by its label.
  private readonly where = new WeakMap<NotebookDocument, string>();
  private readonly ran = new EventEmitter<NotebookDocument>();
  /// Fired when a cell has run on a process: what the variables view
  /// refreshes on.
  readonly onDidRun = this.ran.event;

  constructor(private readonly live: Live) {
    this.controller = notebooks.createNotebookController(NOTEBOOK.controller, NOTEBOOK.type, "q (active connection)");
    this.controller.description = "q-lint: runs cells on the connected q process";
    this.controller.supportedLanguages = ["q"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
  }

  dispose(): void {
    this.controller.dispose();
    this.ran.dispose();
  }

  /// The label of the process `notebook`'s cells last ran on.
  processOf(notebook: NotebookDocument): string | undefined {
    return this.where.get(notebook);
  }

  /// Run every q code cell of `notebook` in order, as Run All does, but as
  /// a fresh run (#1000): numbered from 1, and a cell not reached loses its
  /// old output, so nothing stale passes for this run's.
  runAll(notebook: NotebookDocument): Promise<void> {
    const cells = notebook.getCells().filter((c) => c.kind === NotebookCellKind.Code && c.document.languageId === "q");
    return this.execute(cells, notebook, true);
  }

  private execute(cells: NotebookCell[], notebook: NotebookDocument, fresh = false): Promise<void> {
    // Created now, so the cells show as waiting while those before them run.
    const executions = cells.map((cell) => this.controller.createNotebookCellExecution(cell));
    // Numbering goes on from what the notebook shows, as it was saved.
    let order = fresh ? 0 : this.orders.get(notebook) ?? 0;
    for (const cell of fresh ? [] : notebook.getCells()) {
      order = Math.max(order, cell.executionSummary?.executionOrder ?? 0);
    }
    this.orders.set(notebook, order);
    // A cell not yet begun ends as not run: at once when it is interrupted
    // while it waits, rather than once the cells before it are done.
    const begun = new Set<NotebookCellExecution>();
    const skip = (execution: NotebookCellExecution): void => {
      if (!begun.has(execution)) {
        begun.add(execution);
        execution.start();
        if (fresh) {
          void execution.clearOutput();
        }
        execution.end(undefined);
      }
    };
    const waits = executions.map((execution) => execution.token.onCancellationRequested(() => skip(execution)));
    const run = this.queue.then(async () => {
      let go = true;
      for (const execution of executions) {
        if (!go || execution.token.isCancellationRequested) {
          // Not run: an earlier cell failed or was interrupted.
          skip(execution);
          continue;
        }
        if (begun.has(execution)) {
          continue;
        }
        begun.add(execution);
        go = await this.runCell(execution);
      }
    }).finally(() => waits.forEach((w) => w.dispose()));
    this.queue = run.catch(() => {});
    return run;
  }

  /// Run one cell; whether the cells after it should run.
  private async runCell(execution: NotebookCellExecution): Promise<boolean> {
    const source = execution.cell.document.getText();
    const order = (this.orders.get(execution.cell.notebook) ?? 0) + 1;
    this.orders.set(execution.cell.notebook, order);
    execution.executionOrder = order;
    execution.start(Date.now());
    await execution.clearOutput();
    const finish = async (success: boolean, outputs: NotebookCellOutput[]): Promise<boolean> => {
      if (outputs.length > 0) {
        await execution.replaceOutput(outputs);
      }
      execution.end(success, Date.now());
      return success;
    };
    const directive = cellDirective(source);
    if ("problem" in directive) {
      return finish(false, [toOutput({ kind: "error", name: "cell directive", message: directive.problem, stack: "" })]);
    }
    const off = directive.process !== undefined && !featureOn("processDirective")
      ? "processDirective"
      : directive.parameters === true && !featureOn("parameters") ? "parameters" : undefined;
    if (off !== undefined) {
      return finish(false, [toOutput({ kind: "error", name: "cell directive", message: featureOff(off), stack: "" })]);
    }
    const cut = statements(source);
    if (cut.length === 0) {
      return finish(true, []);
    }
    if (directive.process !== undefined) {
      const problem = await switchProcess(this.live, directive.process);
      if (problem !== undefined) {
        return finish(false, [problem.startsWith("Not run") ? notice(problem) : toOutput({ kind: "error", name: "@process", message: problem, stack: "" })]);
      }
    }
    // The Markdown cells after this one with live values, read once it has run.
    const notebook = execution.cell.notebook;
    const all = notebook.getCells();
    const kinds = all.map((c) => ({ kind: c.kind === NotebookCellKind.Code ? ("code" as const) : ("markdown" as const) }));
    const markdown = !featureOn("liveValues") ? [] : markdownAfter(kinds, execution.cell.index ?? all.indexOf(execution.cell)).filter(
      (j) => kinds[j].kind === "markdown" && liveExpressions(all[j].document.getText()).length > 0,
    );
    const configuration = workspace.getConfiguration("q-lint");
    const { consoleSize } = readLive((key, fallback) => configuration.get(key, fallback));
    const limit = readNotebook((key, fallback) => configuration.get(key, fallback));
    const settings = { consoleSize, rows: rowsArgument(limit), rowLimitFrom: limit.rowLimitFrom };
    let running = false;
    const listener = execution.token.onCancellationRequested(() => {
      // As Abort Current Query: stop waiting, and reconnect once the process
      // is free.
      if (running) {
        void this.live.abort();
      }
    });
    try {
      // The guard reads the live values' expressions too: they are sent.
      const result = await this.live.runOnActive(guardedText(source, markdown.map((j) => all[j].document.getText())), async (connection): Promise<[boolean, OutputPart[], Record<string, LiveValue>[]] | undefined> => {
        if (execution.token.isCancellationRequested) {
          // Interrupted while connecting, before anything was sent.
          return undefined;
        }
        running = true;
        const [ok, parts] = await cellAnswer(connection, directive, cut, settings);
        // A value that cannot be read leaves the cell's output as it is.
        const values = ok && markdown.length > 0
          ? await liveValues(connection, markdown.map((j) => all[j].document.getText())).catch(() => [])
          : [];
        return [ok, parts, values];
      });
      if (result === undefined) {
        return finish(false, [notice("Not run: no q process is connected, or a query is still running on it.")]);
      }
      if (result.value === undefined) {
        return finish(false, [notice("Interrupted: the cell was not run.")]);
      }
      this.where.set(notebook, result.process);
      const [ok, parts, values] = result.value;
      if (values.length > 0) {
        await keepLiveValues(notebook, markdown.map((j) => all[j]), values);
      }
      const done = await finish(ok, parts.map(toOutput));
      this.ran.fire(notebook);
      return done;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (execution.token.isCancellationRequested) {
        return finish(false, [notice(`Interrupted: q-lint stopped waiting for the cell. The process may still be running it; q-lint reconnects once it is free.`)]);
      }
      return finish(false, [toOutput({ kind: "error", name: "q-lint", message, stack: "" })]);
    } finally {
      listener.dispose();
    }
  }
}

/// Keep each of `values` in the metadata of the Markdown cell at the same
/// place in `cells`, where the renderer reads it; the source is not
/// changed. Each goes where its cell is now, which a move during the run
/// can have changed (#1091); a cell since deleted gets none.
async function keepLiveValues(notebook: NotebookDocument, cells: NotebookCell[], values: Record<string, LiveValue>[]): Promise<void> {
  const edits = cells.flatMap((cell, k) => {
    if (cell.index < 0 || notebook.cellAt(cell.index) !== cell) {
      return [];
    }
    const { [LIVE_KEY]: _old, ...rest } = cell.metadata ?? {};
    return [NotebookEdit.updateCellMetadata(cell.index, { ...rest, [LIVE_KEY]: values[k] })];
  });
  if (edits.length === 0) {
    return;
  }
  const edit = new WorkspaceEdit();
  edit.set(notebook.uri, edits);
  await workspace.applyEdit(edit);
}

/// The notebook at `uri` as the file keeps it, outputs and all: the open
/// document, unsaved edits and all, or the file.
export async function qnbOf(uri: Uri): Promise<Qnb> {
  const open = workspace.notebookDocuments.find((n) => n.uri.toString() === uri.toString());
  if (open === undefined) {
    return parseQnb(Buffer.from(await workspace.fs.readFile(uri)).toString("utf8"));
  }
  // Written as a save writes it, and read back.
  const data = {
    cells: open.getCells().map((cell) => ({
      kind: cell.kind,
      value: cell.document.getText(),
      languageId: cell.document.languageId,
      outputs: [...(cell.outputs ?? [])],
      executionSummary: cell.executionSummary,
      metadata: cell.metadata,
    })),
    metadata: open.metadata,
  } as unknown as NotebookData;
  return parseQnb(Buffer.from(new QnbSerializer().serializeNotebook(data, undefined as unknown as CancellationToken)).toString("utf8"));
}

/// The cells of the notebook at `uri`: the open document's, unsaved edits and
/// all, or the file's.
async function cellsOf(uri: Uri): Promise<QnbCell[]> {
  const open = workspace.notebookDocuments.find((n) => n.uri.toString() === uri.toString());
  if (open !== undefined) {
    return open.getCells().map((cell) => ({
      kind: cell.kind === NotebookCellKind.Code ? "code" : "markdown",
      source: cell.document.getText(),
      language: cell.kind === NotebookCellKind.Code ? cell.document.languageId : undefined,
    }));
  }
  return parseQnb(Buffer.from(await workspace.fs.readFile(uri)).toString("utf8")).cells;
}

/// Where Export Notebook offers to write `notebook`'s script: beside it, or,
/// for an untitled notebook (New q Notebook's), in the first workspace
/// folder - a save dialog cannot browse `untitled:`, and nothing can be
/// written there.
function scriptBeside(notebook: Uri, extension = ".q"): Uri {
  const name = path.posix.basename(notebook.path).replace(/\.qnb$/i, extension);
  if (notebook.scheme !== "untitled") {
    return notebook.with({ path: notebook.path.replace(/\.qnb$/i, extension) });
  }
  const folder = workspace.workspaceFolders?.[0]?.uri ?? Uri.file(os.homedir());
  return Uri.joinPath(folder, name);
}

/// What Export Notebook writes, by format: the file's extension, the save
/// dialog's title and filter, and the file's text.
type ExportFormat = "q" | "html" | "ipynb";
const EXPORTS: Record<ExportFormat, { extension: string; title: string; filter: Record<string, string[]> }> = {
  q: { extension: ".q", title: "Export the notebook as a q script", filter: { "q script": ["q"] } },
  html: { extension: ".html", title: "Export the notebook as HTML", filter: { HTML: ["html", "htm"] } },
  ipynb: { extension: ".ipynb", title: "Export the notebook as a Jupyter notebook", filter: { "Jupyter notebook": ["ipynb"] } },
};

/// Write the notebook at `source` - the active one when not given - as a q
/// script, an HTML page or a Jupyter notebook, to `target` or where the
/// user picks.
async function exportNotebook(source?: Uri, target?: Uri, format: ExportFormat = "q"): Promise<void> {
  // A q notebook by its type, or a file by its extension in any case: VS
  // Code opens `A.QNB` as one too.
  const active = window.activeNotebookEditor?.notebook;
  const from = source instanceof Uri ? source : active?.notebookType === NOTEBOOK.type ? active.uri : undefined;
  if (from === undefined || (from !== active?.uri && !/\.qnb$/i.test(from.path))) {
    void window.showInformationMessage("q-lint: open a q notebook (.qnb) to export it.");
    return;
  }
  let text: string;
  try {
    const name = path.posix.basename(from.path);
    text = format === "q"
      ? exportScript(await cellsOf(from), name)
      : format === "html"
        ? toHtml(await qnbOf(from), name)
        : toIpynb(await qnbOf(from));
  } catch (error) {
    void window.showErrorMessage(`q-lint: could not read ${from.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const to =
    target instanceof Uri
      ? target
      : await window.showSaveDialog({
          title: EXPORTS[format].title,
          defaultUri: scriptBeside(from, EXPORTS[format].extension),
          filters: EXPORTS[format].filter,
        });
  if (to === undefined) {
    return;
  }
  try {
    await workspace.fs.writeFile(to, Buffer.from(text, "utf8"));
  } catch (error) {
    void window.showErrorMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!(target instanceof Uri)) {
    void window.showInformationMessage(`q-lint: exported the notebook to ${to.fsPath}.`);
  }
}

/// Read the Jupyter notebook at `source` - picked when not given - as a q
/// notebook, write it to `target` or where the user picks (beside it, as
/// `.qnb`), and open it when the user picked.
async function importIpynb(source?: Uri, target?: Uri): Promise<void> {
  const active = window.activeNotebookEditor?.notebook;
  let from = source instanceof Uri ? source : active !== undefined && /\.ipynb$/i.test(active.uri.path) ? active.uri : undefined;
  if (from === undefined) {
    const picked = await window.showOpenDialog({ title: "Import a Jupyter notebook as a q notebook", filters: { "Jupyter notebook": ["ipynb"] }, canSelectMany: false });
    if (picked === undefined || picked.length === 0) {
      return;
    }
    from = picked[0];
  }
  let qnb: Qnb;
  try {
    qnb = fromIpynb(Buffer.from(await workspace.fs.readFile(from)).toString("utf8"));
  } catch (error) {
    void window.showErrorMessage(`q-lint: could not import ${from.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const to =
    target instanceof Uri
      ? target
      : await window.showSaveDialog({
          title: "Save the imported notebook as a q notebook",
          defaultUri: from.with({ path: from.path.replace(/\.ipynb$/i, "") + ".qnb" }),
          filters: { "q notebook": ["qnb"] },
        });
  if (to === undefined) {
    return;
  }
  try {
    await workspace.fs.writeFile(to, Buffer.from(serializeQnb(qnb), "utf8"));
  } catch (error) {
    void window.showErrorMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!(target instanceof Uri)) {
    await window.showNotebookDocument(await workspace.openNotebookDocument(to));
  }
}

/// Set `q-lint.notebook.rowLimit` and `rowLimitFrom`: to `limit` and `from`
/// when given (0 or "all": every row), and otherwise from a quick pick each.
/// Each is set where it is set already, so a workspace's choice is not
/// shadowed.
async function setRowLimit(limit?: number | "all", from?: string): Promise<void> {
  const configuration = workspace.getConfiguration("q-lint");
  const current = readNotebook((key, fallback) => configuration.get(key, fallback));
  let chosen = limit === "all" ? 0 : ROW_LIMIT_CHOICES.find((n) => n === limit);
  if (chosen === undefined) {
    const picked = await window.showQuickPick(
      ROW_LIMIT_CHOICES.map((n) => ({
        label: rowLimitLabel(n),
        description: n === current.rowLimit ? "current" : undefined,
        limit: n,
      })),
      { title: "q-lint: rows a notebook's @grid and @chart cells show" },
    );
    if (picked === undefined) {
      return;
    }
    chosen = picked.limit;
  }
  let side = ROW_LIMIT_FROM.find((f) => f === from);
  if (side === undefined && chosen !== 0) {
    const picked = await window.showQuickPick(
      ROW_LIMIT_FROM.map((f) => ({
        label: f === "first" ? "First rows" : "Last rows",
        description: f === current.rowLimitFrom ? "current" : undefined,
        detail: `The ${f} ${rowLimitLabel(chosen as number)} of a larger table`,
        from: f,
      })),
      { title: "q-lint: which rows of a larger table" },
    );
    if (picked === undefined) {
      return;
    }
    side = picked.from;
  }
  const set = async (key: string, value: unknown): Promise<void> => {
    const where = configuration.inspect(key);
    const target = where?.workspaceValue !== undefined ? ConfigurationTarget.Workspace : ConfigurationTarget.Global;
    await configuration.update(key, value, target);
  };
  await set("notebook.rowLimit", chosen);
  if (side !== undefined) {
    await set("notebook.rowLimitFrom", side satisfies RowLimitFrom);
  }
}

/// What the chart renderer drew for one output, as it reported it: for
/// tests, through the API `activate` returns.
export interface RenderedChart {
  /// The output item's id.
  id: string;
  kind: string;
  title?: string;
  datasets: { label: string; points: number }[];
  /// Shown instead of a chart, when there was nothing to plot.
  note?: string;
  /// The canvas's size, and how many of its pixels were drawn on.
  width?: number;
  height?: number;
  painted?: number;
}

/// How many outputs' charts are remembered: the latest drawn.
const CHARTS_KEPT = 100;

/// A live value the Markdown renderer showed: for tests, through the API
/// `activate` returns.
export interface RenderedLiveValue {
  expr: string;
  value: LiveValue | null;
}

/// How many live values shown are remembered: the latest.
const LIVE_KEPT = 100;

export function registerNotebooks(
  context: ExtensionContext,
  live: Live,
): {
  charts: () => RenderedChart[];
  liveValues: () => RenderedLiveValue[];
  processOf: (notebook: NotebookDocument) => string | undefined;
  onDidRun: QnbKernel["onDidRun"];
  runAll: (notebook: NotebookDocument) => Promise<void>;
} {
  // By output, the last drawing of each, in the order last drawn.
  const drawn = new Map<string, RenderedChart>();
  const shown: RenderedLiveValue[] = [];
  const messaging = notebooks.createRendererMessaging(NOTEBOOK.renderer);
  const liveMessaging = notebooks.createRendererMessaging(NOTEBOOK.liveRenderer);
  const kernel = new QnbKernel(live);
  context.subscriptions.push(
    workspace.registerNotebookSerializer(NOTEBOOK.type, new QnbSerializer()),
    kernel,
    commands.registerCommand(NOTEBOOK.exportCommand, (source?: Uri, target?: Uri) => exportNotebook(source, target)),
    commands.registerCommand(NOTEBOOK.exportHtmlCommand, (source?: Uri, target?: Uri) => requireFeature("export") ? exportNotebook(source, target, "html") : undefined),
    commands.registerCommand(NOTEBOOK.exportIpynbCommand, (source?: Uri, target?: Uri) => requireFeature("export") ? exportNotebook(source, target, "ipynb") : undefined),
    commands.registerCommand(NOTEBOOK.importIpynbCommand, (source?: Uri, target?: Uri) => requireFeature("export") ? importIpynb(source, target) : undefined),
    liveMessaging.onDidReceiveMessage(({ message }: { message: { type?: string; expr?: unknown; value?: LiveValue | null } }) => {
      if (message.type === "live" && typeof message.expr === "string") {
        shown.push({ expr: message.expr, value: message.value ?? null });
        shown.splice(0, Math.max(0, shown.length - LIVE_KEPT));
      }
    }),
    commands.registerCommand(RESULTS.setRowLimit, (limit?: number | "all", from?: string) => setRowLimit(limit, from)),
    messaging.onDidReceiveMessage(({ message }: { message: { type?: string; id?: string; chart?: Omit<RenderedChart, "id"> } }) => {
      if (message.type === "rendered" && typeof message.id === "string" && message.chart !== undefined) {
        drawn.delete(message.id);
        drawn.set(message.id, { id: message.id, ...message.chart });
        if (drawn.size > CHARTS_KEPT) {
          drawn.delete(drawn.keys().next().value as string);
        }
      }
    }),
  );
  return {
    charts: () => [...drawn.values()],
    liveValues: () => [...shown],
    processOf: (notebook) => kernel.processOf(notebook),
    onDidRun: kernel.onDidRun,
    runAll: (notebook) => kernel.runAll(notebook),
  };
}
