// The database commands (#1022-#1028, #1031) in the editor. Each reads
// the connected process with a fixed lambda that defines nothing, through
// the one connection queries use - waiting a moment for a query, never
// interrupting one, as the Process Explorer reads - and opens what it made
// in a new, unsaved editor: nothing is written into the workspace unless
// you save it.
//
// The one that changes a process is the HDB column manager: its script
// opens for review first, a modal asks before it runs, and it is sent
// through `Live.runOnActive` with the read-only guard set to refuse, so a
// guarded process is never changed by it, whatever is answered. The chart
// command writes only the file the save dialog names.
//
// Each has its own switch (`dbfeatures.ts`): off, its command is hidden and
// refuses, and sends nothing.
import { Uri, window, workspace, type ExtensionContext } from "vscode";
import { commands } from "vscode";
import { ATTRIBUTE_ROWS, ATTRIBUTE_SAMPLE, adviceReport, advise, filterCounts, readAttributeSample } from "./attradvice";
import { CHART_KINDS, chartFromGrid, gridFromFile, type ChartKind } from "./chartfile";
import { CAST_TYPES, COLUMN_DIRS, RUN_SCRIPT, columnScript, columnsOf, opProblem, opText, readColumnDirs, readRun, type ColumnOp } from "./colmanager";
import { DB_COMMANDS, dbOff, dbOn, type DbFeature } from "./dbfeatures";
import { DOCUMENT, DOCUMENT_LIMIT, docHtml, docMarkdown, readDoc, workspaceDocs } from "./dbdoc";
import { modulePathOf } from "./definitions";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { migrationScript, sameSchema, schemaDiff } from "./migrate";
import { CHECK_PARTITIONS, PARTITION_CHECK, partitionReport, readPartitions } from "./partcheck";
import type { Process } from "./processes";
import { parseSaved, SAVED_QUERIES_KEY } from "./savedqueries";
import { statements } from "./statements";
import { SYM_INSPECT, SYM_PARTITIONS, readSym, symReport } from "./syminspect";
import { TABLE_INFO, readTableInfo, type TableInfo } from "./tableinfo";
import { loadTypes, rangeOf, symbolPool, testDataCsv, testDataQ, type TestDataOptions } from "./testdata";
import { plainMessage } from "./history";
import { shownError } from "./tunnel";

const settings = <T>(key: string, fallback: T): T => workspace.getConfiguration("q-lint").get(key, fallback);
const on = (feature: DbFeature): boolean => dbOn(settings, feature);

function say(message: string): string {
  void window.showInformationMessage(plainMessage(message));
  return message;
}

/// What a command was given as its table: an explorer row, or a name.
type TableArg = { name?: unknown; kind?: unknown } | string | undefined;
const nameOf = (arg: TableArg): string | undefined =>
  typeof arg === "string" ? arg : arg !== null && typeof arg === "object" && typeof arg.name === "string" && (arg.kind === undefined || arg.kind === "table") ? arg.name : undefined;

/// The tables of the root and how they are held, read in one call.
export const TABLES = "{[x] t:tables`.;(string t;string{@[{p:.Q.qp get x;$[1b~p;`partitioned;0b~p;`splayed;`memory]};x;`memory]}each t)}";

/// Columns a meta is read for at most.
const META_COLUMNS = 10_000;

/// An editor of `content`, new and unsaved.
async function openDocument(content: string, language: string): Promise<void> {
  const document = await workspace.openTextDocument({ content, language });
  await window.showTextDocument(document, { preview: false });
}

/// Run a read-only lambda on the connected process. Undefined, having said
/// why, when not connected, still busy, or the read failed.
async function read(live: Live, lambda: string, ...args: unknown[]): Promise<{ process: Process; value: unknown } | undefined> {
  if (live.activeLabel() === undefined) {
    say("q-lint: connect to a q process first.");
    return undefined;
  }
  try {
    const got = await borrowWhenFree(live, async (connection, process) => ({ process, value: await connection.call(lambda, ...args) }));
    if (got === undefined) {
      say(`q-lint: ${live.activeLabel() ?? "the process"} is busy with a query; try again when it is done.`);
      return undefined;
    }
    return got.value;
  } catch (error) {
    say(`q-lint: could not read ${live.activeLabel() ?? "the process"}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/// The table a command acts on: the one given, or one picked from the
/// process's tables (`only` keeps those held so).
async function pickTable(live: Live, arg: TableArg, title: string, only?: string[]): Promise<string | undefined> {
  const given = nameOf(arg);
  if (given !== undefined) return given;
  const got = await read(live, TABLES, 0);
  if (got === undefined) return undefined;
  const [names, kinds] = (Array.isArray(got.value) ? got.value : [[], []]) as [unknown, unknown];
  const ns = Array.isArray(names) ? names.map(String) : typeof names === "string" ? [names] : [];
  const ks = Array.isArray(kinds) ? kinds.map(String) : typeof kinds === "string" ? [kinds] : [];
  const items = ns.map((label, i) => ({ label, description: ks[i] ?? "" })).filter((x) => only === undefined || only.includes(x.description));
  if (items.length === 0) {
    say(`q-lint: ${got.process.label} has no ${only ? `${only.join(" or ")} ` : ""}table.`);
    return undefined;
  }
  return (await window.showQuickPick(items, { title }))?.label;
}

async function tableInfo(live: Live, table: string): Promise<{ process: Process; info: TableInfo } | undefined> {
  const got = await read(live, TABLE_INFO, table, META_COLUMNS);
  if (got === undefined) return undefined;
  try {
    return { process: got.process, info: readTableInfo(got.value) };
  } catch (error) {
    say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/// What the commands did, for tests.
export interface DbToolsState {
  /// The last script the column manager showed, and what running it said.
  lastScript?: string;
  lastRun?: string;
}

export function registerDbTools(context: ExtensionContext, live: Live): { state: DbToolsState; registered: () => string[] } {
  const state: DbToolsState = {};
  const off = (feature: DbFeature) => !on(feature) && say(dbOff(feature));

  /// HDB column manager (#1022).
  const manageColumn = async (arg?: TableArg, given?: ColumnOp): Promise<string> => {
    if (off("columnManager")) return dbOff("columnManager");
    const table = await pickTable(live, arg, "Change a column of which table on disk?", ["partitioned", "splayed"]);
    if (table === undefined) return "no table";
    if (off("columnManager")) return dbOff("columnManager");
    const got = await tableInfo(live, table);
    if (got === undefined) return "not read";
    const { process, info } = got;
    if (info.kind !== "partitioned" && info.kind !== "splayed") {
      return say(`q-lint: ${table} is a table in memory; the column manager changes tables on disk.`);
    }
    const field = info.kind === "partitioned" ? (info.columns[0]?.name ?? "") : "";
    // Every directory's .d, not only the newest partition's meta (#2138).
    const dirs = await read(live, COLUMN_DIRS, table);
    if (dirs === undefined) return "not read";
    const { columns, everywhere } = columnsOf(info.columns.map((c) => c.name), readColumnDirs(dirs.value));
    const op = given ?? (await askOp(columns.filter((c) => c !== field)));
    if (op === undefined) return "cancelled";
    if (off("columnManager")) return dbOff("columnManager");
    const problem = opProblem(op, columns, field, everywhere, Object.fromEntries(info.columns.map((c) => [c.name, c.type])));
    if (problem !== undefined) return say(`q-lint: ${problem}.`);
    const script = columnScript(table, op, process.label);
    // A guarded process is refused before anything is shown to run.
    const refused = live.guardRefuses(script, [process]);
    if (refused !== undefined) {
      return say(`q-lint: the column manager does not change ${process.label}, which the read-only guard guards (q-lint.processes.readOnlyGuard.tags). Nothing was shown or sent.`);
    }
    state.lastScript = script;
    await openDocument(script, "q");
    const run = "Run";
    const answer = await window.showWarningMessage(
      plainMessage(`Run the column manager on ${process.label}: ${opText(op)} in ${table}?`),
      { modal: true, detail: `It changes every ${info.kind === "partitioned" ? "partition of the table" : "file of the table"} on disk, then loads the database again. The script is open for review; edits to it are not what runs.` },
      run,
    );
    if (answer !== run) return "not run";
    if (off("columnManager")) return dbOff("columnManager");
    try {
      // The active process can have changed while Run was asked (#1081):
      // the script runs only on the process the modal named.
      const ran = await live.runOnActive(script, (connection) => connection.call(RUN_SCRIPT, statements(script)), "refuse", process.label, undefined, true);
      if (ran === undefined) return "not run";
      const outcome = readRun(ran.value);
      state.lastRun = outcome.ok ? outcome.text : outcome.error;
      return outcome.ok ? say(`q-lint: ${ran.process}: ${outcome.text}.`) : say(`q-lint: the column manager stopped on ${ran.process}: ${outcome.error}`);
    } catch (error) {
      return say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /// Database documenter (#1023).
  const document = async (format?: unknown): Promise<string> => {
    if (off("documenter")) return dbOff("documenter");
    const as = format === "markdown" || format === "html" ? format : (await window.showQuickPick(["Markdown", "HTML"], { title: "Document the process as" }))?.toLowerCase();
    if (as === undefined) return "cancelled";
    // Turned off while its pick was open, it sends nothing (#2420).
    if (off("documenter")) return dbOff("documenter");
    const got = await read(live, DOCUMENT, DOCUMENT_LIMIT);
    if (got === undefined) return "not read";
    // No workspace: the functions go undocumented.
    const files = await Promise.resolve(workspace.findFiles("**/*.q", "**/node_modules/**", 2000)).catch(() => []);
    const docs = await workspaceDocs(
      files,
      async (uri) => new TextDecoder().decode(await workspace.fs.readFile(uri)),
      (uri) => modulePathOf(uri.fsPath, workspace.asRelativePath?.(uri, false)),
    );
    try {
      const doc = readDoc(got.value);
      const at = new Date().toISOString().replace("T", " ").slice(0, 16);
      const text = as === "html" ? docHtml(doc, got.process.label, at, docs) : docMarkdown(doc, got.process.label, at, docs);
      await openDocument(text, as);
      return text;
    } catch (error) {
      return say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /// Partition consistency check (#1024).
  const checkPartitions = async (depth?: unknown): Promise<string> => {
    if (off("partitionCheck")) return dbOff("partitionCheck");
    let deep: boolean;
    if (depth === "quick" || depth === "full") {
      deep = depth === "full";
    } else {
      const full = "Full check";
      const picked = await window.showQuickPick(
        [
          { label: "Quick check", detail: "Directories, .d files, column files and their types, row counts: no column data is read." },
          { label: full, detail: "Also reads every symbol column, for an index past the end of its sym file." },
        ],
        { title: "Check the partitions" },
      );
      if (picked === undefined) return "cancelled";
      deep = picked.label === full;
    }
    if (off("partitionCheck")) return dbOff("partitionCheck");
    const got = await read(live, PARTITION_CHECK, CHECK_PARTITIONS, deep);
    if (got === undefined) return "not read";
    try {
      const text = partitionReport(readPartitions(got.value), got.process.label, deep);
      await openDocument(text, "markdown");
      return text;
    } catch (error) {
      return say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /// Sym file inspector (#1025).
  const inspectSym = async (): Promise<string> => {
    if (off("symInspector")) return dbOff("symInspector");
    const got = await read(live, SYM_INSPECT, SYM_PARTITIONS);
    if (got === undefined) return "not read";
    try {
      const warn = settings<unknown>("hdbBrowser.symInspector.warnAbove", 1_000_000);
      const text = symReport(readSym(got.value), got.process.label, typeof warn === "number" && warn >= 0 ? warn : 1_000_000);
      await openDocument(text, "markdown");
      return text;
    } catch (error) {
      return say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /// Attribute advisor (#1026).
  const adviseAttributes = async (arg?: TableArg): Promise<string> => {
    if (off("attributeAdvisor")) return dbOff("attributeAdvisor");
    const table = await pickTable(live, arg, "Advise attributes for which table?");
    if (table === undefined) return "no table";
    if (off("attributeAdvisor")) return dbOff("attributeAdvisor");
    const got = await read(live, ATTRIBUTE_SAMPLE, table, ATTRIBUTE_ROWS);
    if (got === undefined) return "not read";
    try {
      const sample = readAttributeSample(got.value);
      const queries = [...parseSaved(context.workspaceState.get<unknown>(SAVED_QUERIES_KEY, [])).map((q) => q.code), ...live.history().map((h) => h.code)];
      const advice = advise(sample, filterCounts(queries, table, sample.columns.map((c) => c.name)));
      const text = adviceReport(table, got.process.label, sample, advice, queries.length);
      await openDocument(text, "markdown");
      return text;
    } catch (error) {
      return say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /// Schema migration (#1027). `target`: a table name on the same process,
  /// for tests and keybindings.
  const migrate = async (arg?: TableArg, target?: unknown): Promise<string> => {
    if (off("schemaMigration")) return dbOff("schemaMigration");
    const table = await pickTable(live, arg, "Migrate which table?");
    if (table === undefined) return "no table";
    if (off("schemaMigration")) return dbOff("schemaMigration");
    const from = await tableInfo(live, table);
    if (from === undefined) return "not read";
    let to: { info: TableInfo; where: string } | undefined;
    if (typeof target === "string") {
      const got = await tableInfo(live, target);
      if (got !== undefined) to = { info: got.info, where: `${target} on ${got.process.label}` };
    } else {
      const here = `A table on ${from.process.label}`;
      const there = "A table on another process";
      const which = await window.showQuickPick([here, there], { title: `Migrate ${table} to the schema of` });
      if (which === undefined) return "cancelled";
      if (off("schemaMigration")) return dbOff("schemaMigration");
      if (which === here) {
        const name = await pickTable(live, undefined, `Migrate ${table} to the schema of which table?`);
        if (name === undefined) return "cancelled";
        if (off("schemaMigration")) return dbOff("schemaMigration");
        const got = await tableInfo(live, name);
        if (got !== undefined) to = { info: got.info, where: `${name} on ${got.process.label}` };
      } else {
        const process = await live.pick(undefined, `Read the other table's schema from which process?`);
        if (process === undefined) return "cancelled";
        const name = await window.showInputBox({ title: `Migrate ${table} to the schema of which table on ${process.label}?`, value: table, validateInput: (v) => (/^\.?[A-Za-z][\w.]*$/.test(v.trim()) ? undefined : "A table's name") });
        if (name === undefined) return "cancelled";
        if (off("schemaMigration")) return dbOff("schemaMigration");
        try {
          const info = readTableInfo(await live.callSeparate(process, (connection) => connection.call(TABLE_INFO, name.trim(), META_COLUMNS)));
          to = { info, where: `${name.trim()} on ${process.label}` };
        } catch (error) {
          return say(`q-lint: could not read ${name.trim()} on ${process.label}: ${shownError(error)}`);
        }
      }
    }
    if (to === undefined) return "not read";
    if (off("schemaMigration")) return dbOff("schemaMigration");
    const script = migrationScript(table, from.info, `${table} on ${from.process.label}`, to.info, to.where, from.process.label);
    await openDocument(script, "q");
    if (sameSchema(schemaDiff(from.info, to.info))) say(`q-lint: ${table} already has the schema of ${to.where}.`);
    return script;
  };

  /// Test data generator (#1028). `given`: the options, for tests.
  const testData = async (arg?: TableArg, given?: Partial<TestDataOptions> & { format?: "q" | "csv" }): Promise<string> => {
    if (off("testData")) return dbOff("testData");
    const table = await pickTable(live, arg, "Generate test data shaped as which table?");
    if (table === undefined) return "no table";
    if (off("testData")) return dbOff("testData");
    const got = await tableInfo(live, table);
    if (got === undefined) return "not read";
    const options = given !== undefined ? fillOptions(got.info, given) : await askTestData(got.info);
    if (options === undefined) return "cancelled";
    const format = given?.format ?? (await window.showQuickPick(["q code", "CSV"], { title: "Make the rows as" }))?.toLowerCase();
    if (format === undefined) return "cancelled";
    if (off("testData")) return dbOff("testData");
    const short = table.replace(/^.*\./, "");
    const text = format === "csv" ? testDataCsv(got.info, options) : testDataQ(got.info, short, options);
    await openDocument(text, format === "csv" ? "csv" : "q");
    if (format === "csv") say(`q-lint: load it back with ("${loadTypes(got.info)}";enlist",")0:\`:file.csv`);
    return text;
  };

  /// Chart from a CSV or JSON file (#1031), as the command line draws one.
  const renderChart = async (file?: unknown, kind?: unknown, out?: unknown): Promise<string> => {
    if (off("chartCli")) return dbOff("chartCli");
    const input = file instanceof Uri ? file : typeof file === "string" ? Uri.file(file) : (await window.showOpenDialog({ canSelectMany: false, filters: { "Tables": ["csv", "json", "tsv"] }, title: "Chart which file?" }))?.[0];
    if (input === undefined) return "cancelled";
    const k = typeof kind === "string" && CHART_KINDS.includes(kind as ChartKind) ? kind : await window.showQuickPick([...CHART_KINDS], { title: "Draw it as" });
    if (k === undefined) return "cancelled";
    let svg: string;
    try {
      const text = new TextDecoder().decode(await workspace.fs.readFile(input));
      svg = chartFromGrid(gridFromFile(input.fsPath, text), { kind: k as ChartKind, title: input.fsPath.replace(/^.*[\\/]/, "") });
    } catch (error) {
      return say(`q-lint: could not chart ${input.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const target =
      out instanceof Uri ? out : typeof out === "string" ? Uri.file(out) : await window.showSaveDialog({ defaultUri: Uri.file(input.fsPath.replace(/\.[^./\\]*$/, "") + ".svg"), filters: { SVG: ["svg"] }, title: "Save the chart as" });
    if (target === undefined) return "cancelled";
    try {
      await workspace.fs.writeFile(target, new TextEncoder().encode(svg));
    } catch (error) {
      return say(`q-lint: could not write ${target.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    say(`q-lint: wrote ${target.fsPath}.`);
    return svg;
  };

  const registered: string[] = [];
  const register = (name: string, run: (...args: never[]) => unknown) => {
    registered.push(name);
    context.subscriptions.push(commands.registerCommand(name, run as (...args: unknown[]) => unknown));
  };
  register(DB_COMMANDS.manageColumn, (arg?: TableArg, op?: ColumnOp) => manageColumn(arg, op));
  register(DB_COMMANDS.document, (format?: unknown) => document(format));
  register(DB_COMMANDS.checkPartitions, (depth?: unknown) => checkPartitions(depth));
  register(DB_COMMANDS.inspectSym, () => inspectSym());
  register(DB_COMMANDS.adviseAttributes, (arg?: TableArg) => adviseAttributes(arg));
  register(DB_COMMANDS.migrateSchema, (arg?: TableArg, target?: unknown) => migrate(arg, target));
  register(DB_COMMANDS.testData, (arg?: TableArg, options?: Partial<TestDataOptions> & { format?: "q" | "csv" }) => testData(arg, options));
  register(DB_COMMANDS.renderChart, (file?: unknown, kind?: unknown, out?: unknown) => renderChart(file, kind, out));
  return { state, registered: () => registered };
}

/// Ask what to do to which column. Undefined on Escape.
async function askOp(columns: string[]): Promise<ColumnOp | undefined> {
  const what = await window.showQuickPick(
    [
      { label: "Add a column", op: "add" },
      { label: "Delete a column", op: "delete" },
      { label: "Rename a column", op: "rename" },
      { label: "Cast a column", op: "cast" },
      { label: "Set or remove an attribute", op: "attr" },
    ],
    { title: "Change the table's columns" },
  );
  if (what === undefined) return undefined;
  if (what.op === "add") {
    const column = await window.showInputBox({ title: "The new column's name" });
    if (column === undefined) return undefined;
    const value = await window.showInputBox({ title: `The value ${column} takes in every row`, value: "0n", prompt: "One q value: 0n, 0, 0b, `, `sym (enumerated against sym), \"\" or 0Np." });
    return value === undefined ? undefined : { op: "add", column: column.trim(), value: value.trim() };
  }
  const column = await window.showQuickPick(columns, { title: "Which column?" });
  if (column === undefined) return undefined;
  switch (what.op) {
    case "delete":
      return { op: "delete", column };
    case "rename": {
      const to = await window.showInputBox({ title: `Rename ${column} to`, value: column });
      return to === undefined ? undefined : { op: "rename", column, to: to.trim() };
    }
    case "cast": {
      const type = await window.showQuickPick(CAST_TYPES.split(""), { title: `Cast ${column} to which type?` });
      return type === undefined ? undefined : { op: "cast", column, type };
    }
    default: {
      const attr = await window.showQuickPick(["s", "u", "p", "g", "none"], { title: `Which attribute on ${column}?` });
      return attr === undefined ? undefined : { op: "attr", column, attr: attr === "none" ? "" : (attr as "s" | "u" | "p" | "g") };
    }
  }
}

function fillOptions(info: TableInfo, given: Partial<TestDataOptions>): TestDataOptions {
  return {
    rows: given.rows ?? 1000,
    symbols: given.symbols ?? ["A", "B", "C"],
    low: given.low ?? 0,
    high: given.high ?? 100,
    sorted: given.sorted ?? info.columns.find((c) => "pzntv".includes(c.type) && c.type !== "")?.name,
    seed: given.seed ?? 42,
  };
}

/// Ask for the rows, the symbols, the range and the sorted column.
async function askTestData(info: TableInfo): Promise<TestDataOptions | undefined> {
  const rows = await window.showInputBox({ title: "How many rows?", value: "1000", validateInput: (v) => (/^\d+$/.test(v.trim()) && +v > 0 && +v <= 10_000_000 ? undefined : "A number of rows, 1 to 10,000,000") });
  if (rows === undefined) return undefined;
  const pool = await window.showInputBox({ title: "The symbols a symbol column takes", value: "AAPL MSFT IBM", prompt: "Names, or a number n for sym1 to symn.", validateInput: (v) => (symbolPool(v) ? undefined : "Names separated by spaces, or a number") });
  if (pool === undefined) return undefined;
  const range = await window.showInputBox({ title: "The range numbers are drawn from", value: "0 100", validateInput: (v) => (rangeOf(v) ? undefined : "Two numbers, low and high: 0 100") });
  if (range === undefined) return undefined;
  const none = "(none)";
  const fallback = fillOptions(info, {}).sorted;
  const sorted = await window.showQuickPick([...(fallback ? [fallback] : []), ...info.columns.map((c) => c.name).filter((c) => c !== fallback), none], { title: "Keep which column in ascending order?" });
  if (sorted === undefined) return undefined;
  const [low, high] = rangeOf(range)!;
  return { rows: Number(rows), symbols: symbolPool(pool)!, low, high, sorted: sorted === none ? undefined : sorted, seed: 42 };
}
