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
import { cellOutputs, chartCellOutputs, DATA, GRID_ROWS, readCellData, type OutputPart } from "./celldata";
import { cellDirective } from "./celldirectives";
import { readLive } from "./liveconfig";
import type { Live } from "./live";
import { decodeItem, encodeItem, exportScript, NOTEBOOK, parseQnb, serializeQnb, type QnbCell } from "./qnb";
import { statements } from "./statements";

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
            (o) => new NotebookCellOutput(o.items.map((i) => new NotebookCellOutputItem(decodeItem(i), i.mime)), o.metadata),
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
        if (cell.metadata !== undefined) {
          item.metadata = cell.metadata;
        }
        return item;
      }),
    );
    if (qnb.metadata !== undefined) {
      data.metadata = qnb.metadata;
    }
    return data;
  }

  serializeNotebook(data: NotebookData, _token: CancellationToken): Uint8Array {
    const cells = data.cells.map((cell): QnbCell => {
      const code = cell.kind === NotebookCellKind.Code;
      const summary = cell.executionSummary;
      return {
        kind: code ? "code" : "markdown",
        source: cell.value,
        ...(code && cell.languageId !== "q" ? { language: cell.languageId } : {}),
        ...(code && cell.outputs !== undefined
          ? {
              outputs: cell.outputs.map((o) => ({
                items: o.items.map((i) => encodeItem(i.mime, i.data)),
                ...(o.metadata !== undefined ? { metadata: o.metadata } : {}),
              })),
            }
          : {}),
        ...(code && summary !== undefined
          ? {
              execution: {
                order: summary.executionOrder,
                success: summary.success,
                start: summary.timing?.startTime,
                end: summary.timing?.endTime,
              },
            }
          : {}),
        ...(cell.metadata !== undefined ? { metadata: cell.metadata } : {}),
      };
    });
    return Buffer.from(serializeQnb({ cells, ...(data.metadata !== undefined ? { metadata: data.metadata } : {}) }), "utf8");
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
  private order = 0;
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
    for (const cell of notebook.getCells()) {
      this.order = Math.max(this.order, cell.executionSummary?.executionOrder ?? 0);
    }
    const run = this.queue.then(async () => {
      let go = true;
      for (const execution of executions) {
        if (!go || execution.token.isCancellationRequested) {
          // Not run: an earlier cell failed or was interrupted.
          execution.start();
          execution.end(undefined);
          continue;
        }
        go = await this.runCell(execution);
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /// Run one cell; whether the cells after it should run.
  private async runCell(execution: NotebookCellExecution): Promise<boolean> {
    const source = execution.cell.document.getText();
    execution.executionOrder = ++this.order;
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
    let running = false;
    const listener = execution.token.onCancellationRequested(() => {
      // As Abort Current Query: stop waiting, and reconnect once the process
      // is free.
      if (running) {
        void this.live.abort();
      }
    });
    try {
      const result = await this.live.runOnActive(source, async (connection): Promise<[boolean, OutputPart[]]> => {
        running = true;
        if (directive.mode === "chart") {
          const answer = await connection.queryGrid(cut, consoleSize, GRID_ROWS);
          return [answer.ok, chartCellOutputs(directive, answer)];
        }
        const answer = directive.mode === "console"
          ? await connection.query(cut, consoleSize)
          : readCellData(await connection.call(DATA, cut, GRID_ROWS, consoleSize));
        return [answer.ok, cellOutputs(directive, answer)];
      });
      if (result === undefined) {
        return finish(false, [notice("Not run: no q process is connected, or a query is still running on it.")]);
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
  await workspace.fs.writeFile(to, Buffer.from(exportScript(cells, path.posix.basename(from.path)), "utf8"));
  if (!(target instanceof Uri)) {
    void window.showInformationMessage(`q-lint: exported the notebook to ${to.fsPath}.`);
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
