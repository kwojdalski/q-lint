// Running a q notebook without an editor (#947), and what a cell sends and
// shows, which the notebook kernel (`notebook.ts`) shares. Free of any
// `vscode` import: Run Notebook with Parameters drives it through `Live`,
// and `node out/qnbrun.js` from a shell through connections of its own.
//
// Parameters are papermill's: the code cell headed `/ @parameters` holds the
// notebook's defaults, and a run given values puts a cell assigning them
// right after it - at the top when there is no such cell - so they win. The
// cell is marked in its metadata (`INJECTED_KEY`), and a later run replaces
// it rather than adding another. A value is q text: `-p date 2024.01.02`,
// `-p sym '`EURUSD'`, `-p name '"abc"'`.
//
// A run numbers its cells from 1, stops at the first that fails, and clears
// the outputs of the cells it did not reach, so nothing stale passes for
// this run's. Markdown cells' live values are read as the kernel reads them.
// A cell in a language other than q is left as it is.
import * as fs from "node:fs";
import * as path from "node:path";
import { isProduction } from "./agent";
import { cellOutputs, chartCellOutputs, DATA, readCellData, type OutputPart } from "./celldata";
import { cellDirective, type CellMode } from "./celldirectives";
import { LIVE, LIVE_KEY, liveExpressions, markdownAfter, readLiveValues, type LiveValue } from "./livemarkdown";
import type { RowLimitFrom } from "./liveconfig";
import { address, readProcessFile, type Process } from "./processes";
import { QConnection } from "./qclient";
import { parseQnb, serializeQnb, type Qnb, type QnbCell, type QnbOutput } from "./qnb";
import { ERROR_MIME, toHtml, toIpynb } from "./qnbconvert";
import { statements } from "./statements";

/// What marks the cell a run put its parameters in.
export const INJECTED_KEY = "q-lint.injectedParameters";

export interface RunSettings {
  consoleSize: [number, number];
  /// The signed row count `liveconfig.ts`'s `rowsArgument` makes.
  rows: number;
  rowLimitFrom: RowLimitFrom;
}

/// Run a cell's statements `cut` on `connection` as its `mode` asks:
/// whether it succeeded, and its outputs.
export async function cellAnswer(connection: QConnection, mode: CellMode, cut: string[], settings: RunSettings): Promise<[boolean, OutputPart[]]> {
  if (mode.mode === "chart") {
    const answer = await connection.queryGrid(cut, settings.consoleSize, settings.rows);
    return [answer.ok, chartCellOutputs(mode, answer, settings.rowLimitFrom)];
  }
  const answer = mode.mode === "console"
    ? await connection.query(cut, settings.consoleSize)
    : readCellData(await connection.call(DATA, cut, settings.rows, settings.consoleSize));
  return [answer.ok, cellOutputs(mode, answer, settings.rowLimitFrom)];
}

/// What the read-only guard reads for a code cell `source` run with the
/// Markdown cells `markdown` after it: the source and every live value's
/// expression, since all of them are sent (#1088), each read on its own as
/// each is sent: joined, a `\` or `/` line would hide what came after (#1442).
export function guardedText(source: string, markdown: string[]): string[] {
  return [source, ...new Set(markdown.flatMap(liveExpressions))];
}

/// The live values of the Markdown `sources`, each cell's by expression,
/// read on `connection` in one call; empty when they have none.
export async function liveValues(connection: QConnection, sources: string[]): Promise<Record<string, LiveValue>[]> {
  const exprs = [...new Set(sources.flatMap(liveExpressions))];
  if (exprs.length === 0) {
    return sources.map(() => ({}));
  }
  const all = readLiveValues(exprs, await connection.call(LIVE, exprs));
  return sources.map((s) => Object.fromEntries(liveExpressions(s).map((e) => [e, all[e]])));
}

/// An output as the file keeps it: an error as VS Code writes one.
export function outputOf(part: OutputPart): QnbOutput {
  return part.kind === "error"
    ? { items: [{ mime: ERROR_MIME, text: JSON.stringify({ name: part.name, message: part.message, stack: part.stack }) }] }
    : { items: part.items.map((i) => ({ mime: i.mime, text: i.text })) };
}

const isQ = (cell: Pick<QnbCell, "kind" | "language">): boolean => cell.kind === "code" && (cell.language === undefined || cell.language === "q");

/// The index of the notebook's parameters cell, by `/ @parameters`, or -1.
export function parametersCell(cells: readonly Pick<QnbCell, "kind" | "source" | "language">[]): number {
  return cells.findIndex((c) => {
    if (!isQ(c)) {
      return false;
    }
    const d = cellDirective(c.source);
    return !("problem" in d) && d.parameters === true;
  });
}

const NAME = /^\.?[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

/// The parameters a parameters cell assigns, in order, by name: each line
/// `name:value`, a trailing `;` and comment left off. Other lines are not
/// parameters, and the lines are q's statements: one in a block comment or
/// a string, or a statement of more than one line, is none (#1470).
export function parametersOf(source: string): { name: string; value: string }[] {
  const found: { name: string; value: string }[] = [];
  for (const line of statements(source).filter((s) => !s.includes("\n"))) {
    const m = /^(\.?[a-zA-Z][\w.]*)\s*:\s*(.*)$/.exec(line);
    if (m === null) {
      continue;
    }
    const value = withoutComment(m[2]).trim().replace(/;$/, "").trimEnd().replace(/;$/, "");
    if (NAME.test(m[1]) && value !== "" && !value.startsWith(":")) {
      found.push({ name: m[1], value });
    }
  }
  return found;
}

/// `text` up to its comment, a `/` after a blank outside a string (#1118):
/// `"/data /hdb"` is a value, not a value and a comment.
function withoutComment(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (quoted && text[i] === "\\") {
      i++;
    } else if (text[i] === '"') {
      quoted = !quoted;
    } else if (!quoted && text[i] === "/" && i > 0 && /\s/.test(text[i - 1])) {
      return text.slice(0, i);
    }
  }
  return text;
}

/// Why `overrides` cannot be put in a cell, or undefined: a name must be a
/// q name and a value one line of q.
export function parameterProblem(overrides: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(overrides)) {
    if (!NAME.test(name)) {
      return `"${name}" is not a q name, so it cannot be a parameter.`;
    }
    if (/[\r\n]/.test(value) || value.trim() === "") {
      return `The value of ${name} must be one line of q, and is ${value.trim() === "" ? "empty" : "more than one"}.`;
    }
  }
  return undefined;
}

/// `cells` with the cell of `overrides` after the parameters cell, in place
/// of any an earlier run put there. No overrides, no cell.
export function injectParameters(cells: QnbCell[], overrides: Record<string, string>): QnbCell[] {
  const kept = cells.filter((c) => c.metadata?.[INJECTED_KEY] !== true);
  const names = Object.keys(overrides);
  if (names.length === 0) {
    return kept;
  }
  const at = parametersCell(kept) + 1;
  const cell: QnbCell = {
    kind: "code",
    source: ["/ Parameters given to this run.", ...names.map((n) => `${n}:${overrides[n].trim()};`)].join("\n"),
    metadata: { [INJECTED_KEY]: true },
  };
  return [...kept.slice(0, at), cell, ...kept.slice(at)];
}

/// Where a run sends a cell: `use` on the process `label` names, or on the
/// run's own when it is undefined. Throws, with why, when it cannot.
export interface Executor {
  on<T>(label: string | undefined, code: string | readonly string[], use: (connection: QConnection) => Promise<T>): Promise<T>;
}

export interface RunResult {
  qnb: Qnb;
  /// How many code cells ran, and the first that failed: its number from 1
  /// among all cells, and why.
  ran: number;
  failed?: { cell: number; message: string };
}

/// Run the notebook `qnb`'s q cells in order on `executor`, with its
/// parameters `overrides`; the notebook with this run's outputs.
/// `progress` hears each cell as it starts; `cancelled` is asked before
/// each, and stops the run; `liveValues: false` reads no Markdown values.
export async function runNotebook(
  qnb: Qnb,
  executor: Executor,
  settings: RunSettings,
  overrides: Record<string, string> = {},
  hooks: { progress?: (cell: number, of: number) => void; cancelled?: () => boolean; liveValues?: boolean } = {},
): Promise<RunResult> {
  const problem = parameterProblem(overrides);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  const cells = injectParameters(qnb.cells, overrides).map((c) => ({ ...c }));
  let order = 0;
  let failed: RunResult["failed"];
  const stop = (i: number, message: string): void => {
    failed ??= { cell: i + 1, message };
  };
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!isQ(cell)) {
      continue;
    }
    if (failed !== undefined || hooks.cancelled?.() === true) {
      if (failed === undefined) {
        stop(i, "the run was cancelled");
      }
      // Not reached: what it showed was another run's.
      delete cell.outputs;
      delete cell.execution;
      continue;
    }
    hooks.progress?.(i + 1, cells.length);
    const start = Date.now();
    order++;
    const finish = (success: boolean, parts: OutputPart[]): void => {
      cell.outputs = parts.map(outputOf);
      cell.execution = { order, success, start, end: Date.now() };
    };
    const directive = cellDirective(cell.source);
    if ("problem" in directive) {
      finish(false, [{ kind: "error", name: "cell directive", message: directive.problem, stack: "" }]);
      stop(i, directive.problem);
      continue;
    }
    const cut = statements(cell.source);
    const after = hooks.liveValues === false ? [] : markdownAfter(cells, i).filter((j) => cells[j].kind === "markdown");
    try {
      const [ok, parts, values] = await executor.on(directive.process, guardedText(cell.source, after.map((j) => cells[j].source)), async (connection) => {
        const [ok, parts] = cut.length === 0 ? [true, []] : await cellAnswer(connection, directive, cut, settings);
        const values = ok ? await liveValues(connection, after.map((j) => cells[j].source)) : [];
        return [ok, parts, values] as const;
      });
      finish(ok, parts);
      values.forEach((v, k) => {
        const j = after[k];
        const { [LIVE_KEY]: _old, ...rest } = cells[j].metadata ?? {};
        cells[j] = { ...cells[j], metadata: Object.keys(v).length > 0 ? { ...rest, [LIVE_KEY]: v } : rest };
      });
      if (!ok) {
        const error = parts.find((p) => p.kind === "error");
        stop(i, error?.kind === "error" ? error.message : "the cell failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish(false, [{ kind: "error", name: "q-lint", message, stack: "" }]);
      stop(i, message);
    }
  }
  return { qnb: { ...qnb, cells }, ran: order, ...(failed !== undefined ? { failed } : {}) };
}

/// A run's notebook as the file `target` names it: HTML, Jupyter or `.qnb`.
export function writeAs(qnb: Qnb, target: string, name: string): string {
  if (/\.html?$/i.test(target)) {
    return toHtml(qnb, name);
  }
  if (/\.ipynb$/i.test(target)) {
    return toIpynb(qnb);
  }
  return serializeQnb(qnb);
}

// --- the command line

export const USAGE = `Run a q notebook (.qnb) against a q process and write it with its outputs.

usage: node qnbrun.js NOTEBOOK.qnb --process HOST:PORT|LABEL [options]

  -o, --output FILE        where to write the run: .qnb, .html or .ipynb
                           (default: NOTEBOOK.out.qnb beside the notebook)
  --process HOST:PORT      the process cells run on unless they say
                           \`/ @process <label>\`; or a label in --processes
  -p, --param NAME VALUE   a parameter, as q text; repeat for more
  --processes FILE         a process list, as q-lint: Export Process List
                           writes it, for labels
  --user USER              the user for --process HOST:PORT
  --tls                    connect to --process HOST:PORT with TLS
  --allow-production       run on a process tagged prod, prd or production
  --row-limit N            rows a @grid or @chart cell is sent (default
                           1000; 0: every row)
  --rows-from first|last   which rows of a larger table (default first)
  --console-size H W       the console size values are written at (25 200)

A password is read from the environment, never from an argument:
QLINT_Q_PASSWORD, or QLINT_Q_PASSWORD_<LABEL> for a listed process (its
label in capitals, anything but a letter or digit as _).

Exits 0 when every cell ran, 1 when one failed or could not be sent (the
notebook is written, run up to it), 2 for a usage error or a file that
cannot be read or written.`;

export interface CliOptions {
  notebook: string;
  output: string;
  process: string;
  params: Record<string, string>;
  processes?: string;
  user?: string;
  tls: boolean;
  allowProduction: boolean;
  rowLimit: number;
  rowsFrom: RowLimitFrom;
  consoleSize: [number, number];
}

/// The command line's options, or why they are not.
export function parseArgs(argv: string[]): CliOptions | { error: string } | { help: true } {
  const params: Record<string, string> = {};
  const positional: string[] = [];
  let output: string | undefined;
  let proc: string | undefined;
  let processes: string | undefined;
  let user: string | undefined;
  let tls = false;
  let allowProduction = false;
  let rowLimit = 1000;
  let rowsFrom: RowLimitFrom = "first";
  let consoleSize: [number, number] = [25, 200];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      if (i + 1 >= argv.length) {
        throw new Error(`${a} needs a value`);
      }
      return argv[++i];
    };
    try {
      if (a === "-h" || a === "--help") {
        return { help: true };
      } else if (a === "-o" || a === "--output") {
        output = next();
      } else if (a === "--process") {
        proc = next();
      } else if (a === "-p" || a === "--param") {
        const name = next();
        params[name] = next();
      } else if (a === "--processes") {
        processes = next();
      } else if (a === "--user") {
        user = next();
      } else if (a === "--tls") {
        tls = true;
      } else if (a === "--allow-production") {
        allowProduction = true;
      } else if (a === "--row-limit") {
        const n = next();
        if (!/^\d+$/.test(n)) {
          return { error: "--row-limit takes a whole number" };
        }
        rowLimit = Number(n);
      } else if (a === "--rows-from") {
        const f = next();
        if (f !== "first" && f !== "last") {
          return { error: "--rows-from takes first or last" };
        }
        rowsFrom = f;
      } else if (a === "--console-size") {
        const [h, w] = [next(), next()];
        if (!/^\d+$/.test(h) || !/^\d+$/.test(w) || Number(h) < 1 || Number(w) < 1) {
          return { error: "--console-size takes two whole numbers, its height and width" };
        }
        consoleSize = [Number(h), Number(w)];
      } else if (a.startsWith("-")) {
        return { error: `unknown option ${a}` };
      } else {
        positional.push(a);
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (positional.length !== 1) {
    return { error: positional.length === 0 ? "no notebook given" : `one notebook at a time, and was given ${positional.length}` };
  }
  if (proc === undefined) {
    return { error: "--process is needed: the process the notebook runs on" };
  }
  const problem = parameterProblem(params);
  if (problem !== undefined) {
    return { error: problem };
  }
  const notebook = positional[0];
  return {
    notebook,
    output: output ?? notebook.replace(/(\.qnb)?$/i, ".out.qnb"),
    process: proc,
    params,
    ...(processes !== undefined ? { processes } : {}),
    ...(user !== undefined ? { user } : {}),
    tls,
    allowProduction,
    rowLimit,
    rowsFrom,
    consoleSize,
  };
}

/// The environment variable a listed process's password is read from.
export const passwordVariable = (label: string): string => `QLINT_Q_PASSWORD_${label.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/// The process `name` names: `host:port`, or a label in `listed`. A listed
/// process reached through an SSH tunnel or set up by a connect script is
/// refused: the command line opens neither, and dialling its host and
/// port straight would reach another process (#1401). A `host:port` takes
/// the tags of every listed process at that address, so a production one
/// is still one by its address (#1450).
export function cliProcess(name: string, listed: Process[], user?: string, tls = false): Process | { error: string } {
  const found = listed.find((p) => p.label === name);
  if (found !== undefined) {
    const needs = [found.ssh !== undefined ? "an SSH tunnel (ssh)" : "", found.init !== undefined || found.initFile !== undefined ? "a connect script (init, initFile)" : ""].filter((x) => x !== "");
    return needs.length === 0
      ? found
      : { error: `${found.label} needs ${needs.join(" and ")}, which qnbrun does not run: run the notebook in the editor, or name the process by HOST:PORT` };
  }
  const m = /^(.+):(\d{1,5})$/.exec(name);
  if (m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 65535) {
    const host = m[1].replace(/^\[(.*)\]$/, "$1");
    const port = Number(m[2]);
    const tags = [...new Set(listed.filter((p) => p.host.toLowerCase() === host.toLowerCase() && p.port === port).flatMap((p) => p.tags))];
    return { label: name, host, port, tags, ...(user !== undefined ? { user } : {}), ...(tls ? { tls: true } : {}) };
  }
  return {
    error: listed.length === 0
      ? `"${name}" is neither HOST:PORT nor a label: pass --processes with a process list to name processes by label`
      : `no process is labelled "${name}" in the process list. The labels are: ${listed.map((p) => p.label).join(", ")}`,
  };
}

/// Run the command line `argv`, writing to `out` and `err`; the exit code.
export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  err: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): Promise<number> {
  const options = parseArgs(argv);
  if ("help" in options) {
    err(USAGE);
    return 0;
  }
  if ("error" in options) {
    err(`qnbrun: ${options.error}\n\n${USAGE}`);
    return 2;
  }
  let qnb: Qnb;
  let listed: Process[] = [];
  try {
    qnb = parseQnb(fs.readFileSync(options.notebook, "utf8"));
    if (options.processes !== undefined) {
      const read = readProcessFile(fs.readFileSync(options.processes, "utf8"));
      read.problems.forEach((p) => err(`qnbrun: ${options.processes}: ${p}`));
      listed = read.processes;
    }
  } catch (error) {
    err(`qnbrun: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const connections = new Map<string, Promise<QConnection>>();
  const open = (label: string | undefined): Promise<QConnection> => {
    const name = label ?? options.process;
    let connection = connections.get(name);
    if (connection === undefined) {
      connection = (async () => {
        const target = cliProcess(name, listed, label === undefined ? options.user : undefined, label === undefined && options.tls);
        if ("error" in target) {
          throw new Error(target.error);
        }
        if (isProduction(target) && !options.allowProduction) {
          throw new Error(`${target.label} is a production process (tagged ${target.tags.join(", ")}); pass --allow-production to run the notebook there`);
        }
        const password = target.user ? (env[passwordVariable(target.label)] ?? env.QLINT_Q_PASSWORD ?? "") : undefined;
        return QConnection.open({
          host: target.host,
          port: target.port,
          ...(target.user ? { user: target.user, password } : {}),
          ...(target.tls ? { tls: true } : {}),
        }).catch((error: unknown) => {
          throw new Error(`could not connect to ${target.label} (${address(target.host, target.port)}): ${error instanceof Error ? error.message : String(error)}`);
        });
      })();
      connections.set(name, connection);
    }
    return connection;
  };
  const rows = (options.rowLimit === 0 ? Infinity : options.rowLimit) * (options.rowsFrom === "last" ? -1 : 1);
  let result: RunResult;
  try {
    result = await runNotebook(
      qnb,
      { on: async (label, _code, use) => use(await open(label)) },
      { consoleSize: options.consoleSize, rows, rowLimitFrom: options.rowsFrom },
      options.params,
      { progress: (cell, of) => err(`qnbrun: cell ${cell} of ${of}`) },
    );
  } finally {
    for (const c of connections.values()) {
      await c.then((x) => x.close(), () => {});
    }
  }
  try {
    fs.writeFileSync(options.output, writeAs(result.qnb, options.output, path.basename(options.notebook)));
  } catch (error) {
    err(`qnbrun: could not write ${options.output}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (result.failed !== undefined) {
    err(`qnbrun: cell ${result.failed.cell} failed: ${result.failed.message}. Wrote ${options.output}.`);
    return 1;
  }
  err(`qnbrun: ran ${result.ran} cells. Wrote ${options.output}.`);
  return 0;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
