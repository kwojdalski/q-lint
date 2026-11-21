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
// status bar and one Abort.
import {
  NotebookCellData,
  NotebookCellKind,
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookData,
  ConfigurationTarget,
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
import * as path from "node:path";
import { cellOutputs, chartCellOutputs, DATA, readCellData, type OutputPart } from "./celldata";
import { cellDirective } from "./celldirectives";
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
import { decodeItem, encodeItem, exportScript, NOTEBOOK, parseQnb, serializeQnb, type QnbCell, type QnbOutput } from "./qnb";
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
        if (cell.execution?.extra !== undefined) {
          const { order, start, extra } = cell.execution;
          metadata = { ...metadata, [RUN_EXTRA]: { order, start, extra } };
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
      const runExtra =
        isJson(run) && isJson(run.extra) && run.order === summary?.executionOrder && run.start === summary?.timing?.startTime
          ? { extra: run.extra }
          : {};
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
                start: summary.timing?.startTime,
                end: summary.timing?.endTime,
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

/// Runs code cells on the active connection: one at a time, in the order
/// asked, each numbered and timed.
class QnbKernel {
  private readonly controller: NotebookController;
  /// Each notebook's last run number: a notebook is numbered on its own.
  private readonly orders = new WeakMap<NotebookDocument, number>();
  /// The cells asked for so far, run one after another.
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly live: Live) {
    this.controller = notebooks.createNotebookController(NOTEBOOK.controller, NOTEBOOK.type, "q (active connection)");
    this.controller.description = "q-lint: runs cells on the connected q process";
    this.controller.supportedLanguages = ["q"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
  }

  dispose(): void {
    this.controller.dispose();
  }

  private execute(cells: NotebookCell[], notebook: NotebookDocument): Promise<void> {
    // Created now, so the cells show as waiting while those before them run.
    const executions = cells.map((cell) => this.controller.createNotebookCellExecution(cell));
    // Numbering goes on from what the notebook shows, as it was saved.
    let order = this.orders.get(notebook) ?? 0;
    for (const cell of notebook.getCells()) {
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
    const cut = statements(source);
    if (cut.length === 0) {
      return finish(true, []);
    }
    const configuration = workspace.getConfiguration("q-lint");
    const { consoleSize } = readLive((key, fallback) => configuration.get(key, fallback));
    const limit = readNotebook((key, fallback) => configuration.get(key, fallback));
    const rows = rowsArgument(limit);
    let running = false;
    const listener = execution.token.onCancellationRequested(() => {
      // As Abort Current Query: stop waiting, and reconnect once the process
      // is free.
      if (running) {
        void this.live.abort();
      }
    });
    try {
      const result = await this.live.runOnActive(source, async (connection): Promise<[boolean, OutputPart[]] | undefined> => {
        if (execution.token.isCancellationRequested) {
          // Interrupted while connecting, before anything was sent.
          return undefined;
        }
        running = true;
        if (directive.mode === "chart") {
          const answer = await connection.queryGrid(cut, consoleSize, rows);
          return [answer.ok, chartCellOutputs(directive, answer, limit.rowLimitFrom)];
        }
        const answer = directive.mode === "console"
          ? await connection.query(cut, consoleSize)
          : readCellData(await connection.call(DATA, cut, rows, consoleSize));
        return [answer.ok, cellOutputs(directive, answer, limit.rowLimitFrom)];
      });
      if (result === undefined) {
        return finish(false, [notice("Not run: no q process is connected, or a query is still running on it.")]);
      }
      if (result.value === undefined) {
        return finish(false, [notice("Interrupted: the cell was not run.")]);
      }
      const [ok, parts] = result.value;
      return finish(ok, parts.map(toOutput));
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

/// Write the notebook at `source` - the active one when not given - as a q
/// script, to `target` or where the user picks.
async function exportNotebook(source?: Uri, target?: Uri): Promise<void> {
  const from = source instanceof Uri ? source : window.activeNotebookEditor?.notebook.uri;
  if (from === undefined || !from.path.endsWith(".qnb")) {
    void window.showInformationMessage("q-lint: open a q notebook (.qnb) to export it.");
    return;
  }
  let cells: QnbCell[];
  try {
    cells = await cellsOf(from);
  } catch (error) {
    void window.showErrorMessage(`q-lint: could not read ${from.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const to =
    target instanceof Uri
      ? target
      : await window.showSaveDialog({
          title: "Export the notebook as a q script",
          defaultUri: from.with({ path: from.path.replace(/\.qnb$/, ".q") }),
          filters: { "q script": ["q"] },
        });
  if (to === undefined) {
    return;
  }
  try {
    await workspace.fs.writeFile(to, Buffer.from(exportScript(cells, path.posix.basename(from.path)), "utf8"));
  } catch (error) {
    void window.showErrorMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!(target instanceof Uri)) {
    void window.showInformationMessage(`q-lint: exported the notebook to ${to.fsPath}.`);
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

export function registerNotebooks(context: ExtensionContext, live: Live): { charts: () => RenderedChart[] } {
  // By output, the last drawing of each, in the order last drawn.
  const drawn = new Map<string, RenderedChart>();
  const messaging = notebooks.createRendererMessaging(NOTEBOOK.renderer);
  context.subscriptions.push(
    workspace.registerNotebookSerializer(NOTEBOOK.type, new QnbSerializer()),
    new QnbKernel(live),
    commands.registerCommand(NOTEBOOK.exportCommand, (source?: Uri, target?: Uri) => exportNotebook(source, target)),
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
  return { charts: () => [...drawn.values()] };
}
