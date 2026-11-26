// The Data Wrangler (#961), grid cell edits (#964), data files opened in the
// grid (#962) and the CSV load wizard (#963): the VS Code around
// `wrangle.ts` and `datafile.ts`.
//
// Each has its own setting and does nothing on its own: every one starts
// from a command. A wrangle step reruns the result's query with the steps
// nested over it, on the process it came from - a read, asked about first
// on a production process as a drill-down query is. A cell edit and a load
// statement change a process, so each is shown before it is sent, sent only
// on the user's word, and read by the read-only guard (#918) as any query:
// all of them go through `Live.run`. Opening a data file reads it: by its
// path when the process runs on this machine, or from its text, sent with
// the query, when it does not and the file is small.
import { hostname } from "node:os";
import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Uri, commands, window, workspace, type ExtensionContext } from "vscode";
import {
  DATA_FILES,
  INLINE_BYTES,
  LOAD_TYPES,
  SAMPLE_BYTES,
  csvLoad,
  dataKind,
  fileSource,
  isLocalHost,
  loadExpression,
  readDataFiles,
  sampleText,
  tableName,
  type Sample,
} from "./datafile";
import { gatewayParts, gatewayStatement } from "./gateway";
import type { GridPayload } from "./grid";
import { RESULT_VIEW, readResultView, type ResultFeature } from "./liveconfig";
import type { Live } from "./live";
import { plainName } from "./qliteral";
import {
  CAST_TYPES,
  cellLiteral,
  columnProblem,
  editStatement,
  filterOps,
  guessTable,
  stepText,
  stringColumn,
  wrangleBase,
  wrangleQuery,
  wrangleScript,
  wrangleShape,
  type FilterOp,
  type Step,
} from "./wrangle";
import { iconsEscaped, plainMessage } from "./history";
import { staleMenu } from "./resultpanel";
import { statements } from "./statements";

/// Wrangles kept, to go on from the result of one.
const WRANGLES = 50;

interface Wrangle {
  base: string;
  steps: Step[];
  process: string;
  /// On a TorQ gateway, the server types the base ran on: the base is the
  /// query inside its `.gw.syncexec`, and each step goes there too (#2436).
  serverTypes?: string[];
}

/// What a column's context menu, or a cell's, passes its command.
interface Context {
  column?: unknown;
  row?: unknown;
  run?: unknown;
}

const TYPE_NAMES: Record<number, string> = {
  0: "list", 1: "boolean", 2: "guid", 4: "byte", 5: "short", 6: "int", 7: "long", 8: "real", 9: "float", 10: "char", 11: "symbol",
  12: "timestamp", 13: "month", 14: "date", 15: "datetime", 16: "timespan", 17: "minute", 18: "second", 19: "time",
};

const typeName = (t: number): string => TYPE_NAMES[t] ?? (t >= 20 && t <= 76 ? "enumeration" : `type ${t}`);

function config<T>(read: (get: <V>(key: string, fallback: V) => V) => T): T {
  const configuration = workspace.getConfiguration("q-lint");
  return read((key, fallback) => configuration.get(key, fallback));
}

async function openQ(content: string): Promise<void> {
  const document = await workspace.openTextDocument({ language: "q", content });
  await window.showTextDocument(document);
}

export class ResultTools {
  /// By the code each wrangle ran and its process: its steps.
  private readonly wrangles = new Map<string, Wrangle>();

  constructor(context: ExtensionContext, private readonly live: Live) {
    context.subscriptions.push(
      commands.registerCommand(RESULT_VIEW.wrangle, () => this.on("wrangler") && this.wrangle()),
      commands.registerCommand(RESULT_VIEW.wrangleColumn, (at?: Context) => this.on("wrangler") && this.wrangle(typeof at?.column === "number" ? at.column : undefined)),
      commands.registerCommand(RESULT_VIEW.editCell, (at?: Context) => this.on("editCells") && this.editCell(at?.column, at?.row, at?.run)),
      commands.registerCommand(DATA_FILES.open, (uri?: Uri) => this.dataOn("open") && this.openDataFile(uri)),
      commands.registerCommand(DATA_FILES.wizard, (uri?: Uri) => this.dataOn("loadWizard") && this.loadWizard(uri)),
    );
  }

  /// Whether result feature `feature` is on; when it is not, say so.
  private on(feature: ResultFeature): boolean {
    if (config(readResultView).enable[feature]) {
      return true;
    }
    void window.showInformationMessage(plainMessage(`q-lint: this result panel feature is turned off. Turn it on with the setting q-lint.results.${feature}.enable.`));
    return false;
  }

  private dataOn(feature: "open" | "loadWizard"): boolean {
    if (config(readDataFiles)[feature]) {
      return true;
    }
    void window.showInformationMessage(plainMessage(`q-lint: ${feature === "open" ? "Open Data File in Grid" : "the CSV load wizard"} is turned off. Turn it on with the setting q-lint.dataFiles.${feature}.enable.`));
    return false;
  }

  // --- the Data Wrangler (#961)

  /// The wrangle the result on show belongs to, or a new one from it.
  private wrangleOf(shown: { process: string; code: string; payload: GridPayload }): Wrangle | string {
    const kept = this.wrangles.get(`${shown.process}\0${shown.code}`);
    if (kept !== undefined) {
      return kept;
    }
    const shape = wrangleShape(shown.payload);
    if (shape !== undefined) {
      return shape;
    }
    // A gateway's result was sent as a `.gw.syncexec` call: its steps are
    // built over the query inside, sent to the same servers (#2436).
    const parts = gatewayParts(shown.code);
    const base = parts?.query ?? shown.code;
    const problem = wrangleBase(base);
    return problem !== undefined ? problem : { base, steps: [], process: shown.process, ...(parts !== undefined ? { serverTypes: parts.types } : {}) };
  }

  /// Pick a step and apply it, or undo, show or drop the steps so far.
  /// `column`: the column whose header was right-clicked.
  private async wrangle(column?: number): Promise<void> {
    const shown = this.live.resultOnShow();
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no result yet. Run a query in grid mode first, then wrangle its result.");
      return;
    }
    const wrangle = this.wrangleOf(shown);
    if (typeof wrangle === "string") {
      void window.showInformationMessage(plainMessage(`q-lint: the result on show cannot be wrangled: ${wrangle}. Wrangle a result of a single expression, such as select from t.`));
      return;
    }
    const payload = shown.payload;
    const name = column === undefined ? undefined : payload.names[column];
    type Action = Step["kind"] | "undo" | "show" | "reset";
    const actions: { label: string; detail?: string; action: Action }[] = [
      { label: "$(filter) Filter rows...", action: "filter" },
      { label: "$(list-ordered) Sort...", action: "sort" },
      { label: "$(edit) Rename column...", action: "rename" },
      { label: "$(symbol-type-parameter) Cast column...", action: "cast" },
      { label: "$(trash) Drop column", action: "drop" },
      ...(wrangle.steps.length > 0
        ? [
            { label: "$(discard) Undo last step", detail: stepText(wrangle.steps[wrangle.steps.length - 1]), action: "undo" as const },
            { label: "$(code) Show steps as q", detail: wrangle.steps.map(stepText).join("; "), action: "show" as const },
            { label: "$(clear-all) Start over", detail: "Run the query the steps started from", action: "reset" as const },
          ]
        : []),
    ];
    const picked = await window.showQuickPick(actions, {
      title: `q-lint: wrangle ${name === undefined ? "the result" : `column ${name}`} on ${shown.process}${wrangle.steps.length > 0 ? ` (${wrangle.steps.length} step${wrangle.steps.length === 1 ? "" : "s"} so far)` : ""}`,
    });
    if (picked === undefined) {
      return;
    }
    if (picked.action === "show") {
      const script = wrangleScript(wrangle.base, wrangle.steps, wrangle.process);
      await openQ(wrangle.serverTypes !== undefined ? `/ @servertypes ${wrangle.serverTypes.join(" ")}\n${script}` : script);
      return;
    }
    if (picked.action === "undo" || picked.action === "reset") {
      await this.apply({ ...wrangle, steps: picked.action === "undo" ? wrangle.steps.slice(0, -1) : [] });
      return;
    }
    const at = column ?? (await this.pickColumn(payload, picked.label.replace(/^\$\([^)]*\) /, "").replace(/\.\.\.$/, "")));
    if (at === undefined) {
      return;
    }
    const problem = columnProblem(payload.names[at]);
    if (problem !== undefined) {
      void window.showWarningMessage(plainMessage(`q-lint: ${problem}.`));
      return;
    }
    const step = await this.askStep(picked.action, payload, at);
    if (step !== undefined) {
      await this.apply({ ...wrangle, steps: [...wrangle.steps, step] });
    }
  }

  private async pickColumn(payload: GridPayload, what: string): Promise<number | undefined> {
    const picked = await window.showQuickPick(
      payload.names.map((n, i) => ({ label: iconsEscaped(n), description: typeName(payload.types[i]) + (i < payload.keys ? " · key" : ""), at: i })),
      { title: `q-lint: ${what}: which column?` },
    );
    return picked?.at;
  }

  /// Ask for what step `kind` on column `at` needs.
  private async askStep(kind: Step["kind"], payload: GridPayload, at: number): Promise<Step | undefined> {
    const column = payload.names[at];
    switch (kind) {
      case "filter": {
        const strings = stringColumn(payload, at);
        const op = await window.showQuickPick(
          filterOps(strings).map((o) => ({ label: o, description: o === "like" ? "a pattern, \"AB*\"" : o === "in" ? "a list, `a`b" : undefined })),
          { title: `q-lint: keep the rows where ${column} ...` },
        );
        if (op === undefined) {
          return undefined;
        }
        if (op.label === "null" || op.label === "not null") {
          return { kind, column, op: op.label as FilterOp, value: "", strings };
        }
        const value = await window.showInputBox({
          title: `q-lint: keep the rows where ${column} ${op.label} ...`,
          prompt: "A q expression",
          value: (payload.cells[at]?.length ?? 0) > 0 ? cellLiteral(payload, at, 0) : "",
          validateInput: (v) => (v.trim() === "" ? "Give a q value" : undefined),
        });
        return value === undefined ? undefined : { kind, column, op: op.label as FilterOp, value, strings };
      }
      case "sort": {
        const way = await window.showQuickPick(
          [
            { label: "Ascending", descending: false },
            { label: "Descending", descending: true },
          ],
          { title: `q-lint: sort by ${column}` },
        );
        return way === undefined ? undefined : { kind, column, descending: way.descending };
      }
      case "rename": {
        const to = await window.showInputBox({
          title: `q-lint: rename ${column} to`,
          value: column,
          validateInput: (v) =>
            !plainName(v.trim()) ? "A plain q name that is not a reserved word" : v.trim() !== column && payload.names.includes(v.trim()) ? `The result has a column ${v.trim()} already` : undefined,
        });
        return to === undefined || to.trim() === column ? undefined : { kind, column, to: to.trim() };
      }
      case "cast": {
        const strings = stringColumn(payload, at);
        const to = await window.showQuickPick(
          CAST_TYPES.map((t) => ({ label: t.name, description: t.letter === "*" ? "string" : `"${strings ? t.letter.toUpperCase() : t.letter}"$`, letter: t.letter })),
          { title: `q-lint: ${strings ? "parse" : "cast"} ${column} (${typeName(payload.types[at])}) to` },
        );
        return to === undefined ? undefined : { kind, column, to: to.letter, type: payload.types[at], ...(strings ? { strings } : {}) };
      }
      case "drop":
        return { kind, column };
    }
  }

  /// Run the steps over the query they start from, on its process, in the
  /// grid, and keep them for the next step.
  private async apply(wrangle: Wrangle): Promise<void> {
    const code = wrangle.steps.length === 0 ? wrangle.base : wrangleQuery(wrangle.base, wrangle.steps);
    // Kept under the code its result carries: on a gateway, as sent.
    const key = `${wrangle.process}\0${wrangle.serverTypes !== undefined ? gatewayStatement(statements(code), wrangle.serverTypes) : code}`;
    this.wrangles.delete(key);
    if (wrangle.steps.length > 0) {
      this.wrangles.set(key, wrangle);
      if (this.wrangles.size > WRANGLES) {
        this.wrangles.delete(this.wrangles.keys().next().value as string);
      }
    }
    await this.live.runOnProcess(code, wrangle.process, { what: "wrangle query", mode: "grid", ...(wrangle.serverTypes !== undefined ? { serverTypes: wrangle.serverTypes } : {}) });
  }

  /// The steps of the wrangle a result's code belongs to, for tests.
  wrangleSteps(process: string, code: string): Step[] | undefined {
    return this.wrangles.get(`${process}\0${code}`)?.steps;
  }

  // --- cell edits (#964)

  /// Write the update that sets a cell of the result on show, show it, and
  /// send it on the user's word.
  private async editCell(column: unknown, row: unknown, menuRun?: unknown): Promise<void> {
    const shown = this.live.resultOnShow();
    // The row right-clicked, not one of a result shown since (#2076).
    if (shown !== undefined && staleMenu(menuRun, shown.run)) {
      return;
    }
    if (shown === undefined || typeof column !== "number" || typeof row !== "number" || shown.payload.names[column] === undefined) {
      void window.showInformationMessage("q-lint: right-click a cell of the result grid and choose Edit Cell to change it on its process.");
      return;
    }
    const { payload, process } = shown;
    const name = payload.names[column];
    const table = await window.showInputBox({
      title: `q-lint: edit ${name} on ${process}: the table to update`,
      prompt: "The table the result came from, updated in place",
      value: guessTable(gatewayParts(shown.code)?.query ?? shown.code) ?? "",
      validateInput: (v) => (/^\.?[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/.test(v.trim()) ? undefined : "A table's name, such as trade or .ns.trade"),
    });
    if (table === undefined) {
      return;
    }
    const value = await window.showInputBox({
      title: `q-lint: the new value of ${name} in ${table.trim()}`,
      prompt: "A q expression",
      value: cellLiteral(payload, column, row),
      validateInput: (v) => (v.trim() === "" ? "Give a q value" : undefined),
    });
    if (value === undefined) {
      return;
    }
    const edit = editStatement(payload, column, row, table.trim(), value);
    if ("error" in edit) {
      void window.showWarningMessage(plainMessage(`q-lint: the cell cannot be edited: ${edit.error}.`));
      return;
    }
    const run = "Run";
    const editor = "Open in Editor";
    const answer = await window.showWarningMessage(
      plainMessage(`Update ${table.trim()} on ${process}?`),
      {
        modal: true,
        detail: `${edit.code}\n\nEvery row of ${table.trim()} whose ${edit.matchedBy.join(", ")} ${edit.matchedBy.length === 1 ? "is" : "are"} as in this one is changed. Nothing is sent unless you choose Run.`,
      },
      run,
      editor,
    );
    if (answer === editor) {
      await openQ(`/ An edit of ${name} on ${process}, written by q-lint: review it, then run it.\n${edit.code}\n`);
    } else if (answer === run) {
      // On a gateway, to the servers the result came from (#2437).
      const types = gatewayParts(shown.code)?.types;
      await this.live.runOnProcess(edit.code, process, { what: "cell edit", askProduction: false, ...(types !== undefined ? { serverTypes: types } : {}) });
    }
  }

  // --- data files (#962) and the load wizard (#963)

  private async pickFile(title: string, extensions: string[]): Promise<Uri | undefined> {
    const picked = await window.showOpenDialog({ title, canSelectMany: false, filters: { "Data files": extensions } });
    return picked?.[0];
  }

  /// A file's first SAMPLE_BYTES as text, its size, and whether it is longer.
  private async head(path: string): Promise<{ text: string; size: number; cut: boolean }> {
    const size = (await stat(path)).size;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size, SAMPLE_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { text: buffer.subarray(0, bytesRead).toString("utf8"), size, cut: size > bytesRead };
    } finally {
      await handle.close();
    }
  }

  /// Load a CSV, TSV or JSON file through q and show it in the grid.
  private async openDataFile(uri?: Uri): Promise<void> {
    const file = uri instanceof Uri ? uri : await this.pickFile("q-lint: open a data file in the grid", ["csv", "tsv", "tab", "psv", "txt", "json"]);
    if (file === undefined) {
      return;
    }
    const kind = dataKind(file.fsPath);
    if (kind === undefined) {
      void window.showInformationMessage(plainMessage(`q-lint: ${basename(file.fsPath)} is not a CSV, TSV or JSON file, the formats Open Data File in Grid reads.`));
      return;
    }
    let process = this.live.activeProcess();
    if (process === undefined && (await this.live.connectTo())) {
      process = this.live.activeProcess();
    }
    if (process === undefined) {
      return;
    }
    let head;
    try {
      head = await this.head(file.fsPath);
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not read ${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const local = process.ssh === undefined && isLocalHost(process.host, hostname());
    if (!local && head.size > INLINE_BYTES) {
      void window.showWarningMessage(
        plainMessage(`q-lint: ${process.label} runs on ${process.host}, so it cannot read ${basename(file.fsPath)} by its path, and the file is too large (${head.size.toLocaleString("en-US")} bytes, over ${INLINE_BYTES.toLocaleString("en-US")}) to send. Open it with a process on this machine.`),
      );
      return;
    }
    const text = local ? undefined : await readFile(file.fsPath, "utf8");
    const sample = kind.kind === "csv" ? sampleText(head.text, kind.delimiter, head.cut) : { types: [], delimiter: "" };
    if (kind.kind === "csv" && sample.types.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: ${basename(file.fsPath)} has no header line to name its columns.`));
      return;
    }
    await this.live.run(loadExpression(kind.kind, file.fsPath, local, sample, text), undefined, undefined, "grid");
  }

  /// Guess a CSV's column types, let the user change them, and write the
  /// statement that loads it; shown in an editor and run on the user's word.
  private async loadWizard(uri?: Uri): Promise<void> {
    const file = uri instanceof Uri ? uri : await this.pickFile("q-lint: load a CSV file into q", ["csv", "tsv", "tab", "psv", "txt"]);
    if (file === undefined) {
      return;
    }
    const kind = dataKind(file.fsPath);
    if (kind?.kind !== "csv") {
      void window.showInformationMessage(plainMessage(`q-lint: ${basename(file.fsPath)} is not a delimited text file (CSV, TSV, PSV or TXT).`));
      return;
    }
    let head;
    try {
      head = await this.head(file.fsPath);
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not read ${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let sample: Sample = sampleText(head.text, kind.delimiter, head.cut);
    const text = head.text;
    const cut = head.cut;
    const types = await this.chooseTypes(basename(file.fsPath), (d) => (sample = sampleText(text, d, cut)), () => sample);
    if (types === undefined) {
      return;
    }
    const name = await window.showInputBox({
      title: "q-lint: load the file as",
      prompt: "The global the table is assigned to",
      value: tableName(file.fsPath),
      validateInput: (v) => (/^\.?[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/.test(v.trim()) ? undefined : "A q name, such as trades or .data.trades"),
    });
    if (name === undefined) {
      return;
    }
    const statement = `${name.trim()}:${csvLoad(types, sample.delimiter, fileSource(file.fsPath, sample.bom))}`;
    await openQ(
      [
        `/ Load ${basename(file.fsPath)} as ${name.trim()}, written by q-lint's CSV load wizard.`,
        "/ The process reads the file by this path: it must run on this machine, or the path be changed to one it can read.",
        statement,
        "",
      ].join("\n"),
    );
    const process = this.live.activeLabel();
    const run = "Run";
    const answer = await window.showWarningMessage(
      plainMessage(process === undefined ? "Run this load statement on a q process?" : `Run this load statement on ${process}?`),
      { modal: true, detail: `${statement}\n\nIt assigns ${name.trim()} on the process. Nothing is sent unless you choose Run.` },
      run,
    );
    if (answer === run) {
      // On the process the question named, even if another became active
      // while it was open (#1293).
      await (process === undefined ? this.live.run(statement) : this.live.runOnProcess(statement, process, { what: "load statement" }));
    }
  }

  /// The wizard's page: each column with its guessed type, to change, until
  /// Done. Undefined when the user pressed Escape.
  private async chooseTypes(file: string, resample: (delimiter: string) => void, now: () => Sample): Promise<string[] | undefined> {
    let types = [...now().types];
    const named = (d: string) => (d === "\t" ? "tab" : d === "," ? "comma" : d === "|" ? "pipe" : d === ";" ? "semicolon" : JSON.stringify(d));
    for (;;) {
      const sample = now();
      const items = [
        { label: "$(check) Done", description: `("${types.join("")}";enlist ...)0:`, detail: "Write the load statement", at: -1 },
        { label: "$(split-horizontal) Delimiter", description: named(sample.delimiter), detail: "Change it, and guess the types again", at: -2 },
        ...sample.names.map((n, i) => ({
          label: n === "" ? `(column ${i + 1})` : n,
          description: `${types[i] === " " ? "skipped" : `${types[i]} ${LOAD_TYPES.find((t) => t.letter === types[i])?.name ?? ""}`}`,
          detail: `e.g. ${sample.rows.slice(0, 4).map((r) => r[i]).join(", ") || "(no rows)"}`,
          at: i,
        })),
      ];
      const picked = await window.showQuickPick(items, { title: `q-lint: load ${file}: pick a column to change its type, then Done`, matchOnDetail: true });
      if (picked === undefined) {
        return undefined;
      }
      if (picked.at === -1) {
        if (types.every((t) => t === " ")) {
          void window.showInformationMessage("q-lint: every column is skipped; keep at least one.");
          continue;
        }
        return types;
      }
      if (picked.at === -2) {
        const d = await window.showQuickPick(
          [",", "\t", "|", ";"].map((x) => ({ label: named(x), d: x })),
          { title: "q-lint: the file's delimiter" },
        );
        if (d !== undefined) {
          resample(d.d);
          types = [...now().types];
        }
        continue;
      }
      const t = await window.showQuickPick(
        LOAD_TYPES.map((x) => ({ label: x.letter === " " ? "(space)" : x.letter, description: x.name + (x.letter === types[picked.at] ? " · now" : ""), letter: x.letter })),
        { title: `q-lint: the type of ${picked.label}` },
      );
      if (t !== undefined) {
        types[picked.at] = t.letter;
      }
    }
  }
}
