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
import { CHART_KINDS, chartFromGrid, gridFromFile, type ChartKind } from "./chartfile";
import { DB_COMMANDS, dbOff, dbOn, type DbFeature } from "./dbfeatures";
import { DOCUMENT, DOCUMENT_LIMIT, docHtml, docMarkdown, qdocs, readDoc } from "./dbdoc";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import type { Process } from "./processes";
import { parseSaved, SAVED_QUERIES_KEY } from "./savedqueries";
import { statements } from "./statements";
import { TABLE_INFO, readTableInfo, type TableInfo } from "./tableinfo";

const settings = <T>(key: string, fallback: T): T => workspace.getConfiguration("q-lint").get(key, fallback);
const on = (feature: DbFeature): boolean => dbOn(settings, feature);

function say(message: string): string {
  void window.showInformationMessage(message);
  return message;
}

/// What a command was given as its table: an explorer row, or a name.
type TableArg = { name?: unknown; kind?: unknown } | string | undefined;
const nameOf = (arg: TableArg): string | undefined =>
  typeof arg === "string" ? arg : arg !== null && typeof arg === "object" && typeof arg.name === "string" && (arg.kind === undefined || arg.kind === "table") ? arg.name : undefined;

/// The tables of the root and how they are held, read in one call.
const TABLES = "{[x] t:tables`.;(string t;string{@[{p:.Q.qp get x;$[1b~p;`partitioned;0b~p;`splayed;`memory]};x;`memory]}each t)}";

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

  /// Database documenter (#1023).
  const document = async (format?: unknown): Promise<string> => {
    if (off("documenter")) return dbOff("documenter");
    const as = format === "markdown" || format === "html" ? format : (await window.showQuickPick(["Markdown", "HTML"], { title: "Document the process as" }))?.toLowerCase();
    if (as === undefined) return "cancelled";
    const got = await read(live, DOCUMENT, DOCUMENT_LIMIT);
    if (got === undefined) return "not read";
    const docs = new Map<string, string>();
    try {
      for (const uri of await workspace.findFiles("**/*.q", "**/node_modules/**", 2000)) {
        const text = new TextDecoder().decode(await workspace.fs.readFile(uri));
        for (const [name, doc] of qdocs(text)) if (!docs.has(name)) docs.set(name, doc);
      }
    } catch {
      // No workspace, or a file that cannot be read: the functions go undocumented.
    }
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
    await workspace.fs.writeFile(target, new TextEncoder().encode(svg));
    say(`q-lint: wrote ${target.fsPath}.`);
    return svg;
  };

  const registered: string[] = [];
  const register = (name: string, run: (...args: never[]) => unknown) => {
    registered.push(name);
    context.subscriptions.push(commands.registerCommand(name, run as (...args: unknown[]) => unknown));
  };
  register(DB_COMMANDS.document, (format?: unknown) => document(format));
  register(DB_COMMANDS.renderChart, (file?: unknown, kind?: unknown, out?: unknown) => renderChart(file, kind, out));
  return { state, registered: () => registered };
}
