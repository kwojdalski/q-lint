// The language-model tool (#886): what an agent's query is answered with,
// which process it runs on, and what the user is asked before it runs. Free
// of any `vscode` import, so a test can drive it; `agenttool.ts` is the VS
// Code around it.
//
// The query is sent with `grid.ts`'s lambda, as a grid-mode query is, so
// nothing is defined on the process and a tabular value arrives as its first
// rows and their q text. The answer is JSON, and a JSON number is a double:
// a long above 2^53 would lose its last digits and a timestamp its
// nanoseconds, so those are q's own text.
import { findDiscovered, qualified, type Discovered, type Row } from "./discovery";
import { cellText, typeName, type GridAnswer, type GridPayload } from "./grid";
import { tagColour, type Process } from "./processes";
import type { QConnection } from "./qclient";
import { statements } from "./statements";

export const AGENT = {
  tool: "q-lint_runQuery",
  copyLabel: "q-lint.copyAgentLabel",
} as const;

/// The most rows a tabular result gives an agent.
export const ROW_LIMIT = 200;

/// What the tool is called with, as `package.json`'s `inputSchema` declares it.
export interface AgentInput {
  query: string;
  process?: string;
}

export type Cell = string | number | boolean | null;

export type AgentResult =
  | {
      columns: string[];
      /// Each column's q type, as `typeName` writes it.
      types: string[];
      /// How many of the leading columns are keys, when there are any.
      keyColumns?: number;
      /// The rows the whole result has.
      rowCount: number;
      data: Cell[][];
      truncated?: true;
    }
  | { output: string }
  | { error: string; trace?: string };

export interface AgentSettings {
  /// Seconds an agent's query may run before it is aborted; 0: no limit.
  queryTimeout: number;
}

/// The agent settings, read as `readLive` reads the query ones.
export function readAgent(get: <T>(key: string, fallback: T) => T): AgentSettings {
  const timeout = get("agent.queryTimeout", 30);
  return { queryTimeout: typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 0 ? timeout : 30 };
}

/// A real as the shortest decimal that reads back as the same float32. The
/// codec widens a real's four bytes to the nearest double, so 1.1e arrives as
/// 1.100000023841858 - a number q neither holds nor prints.
function real(x: number): number {
  for (let digits = 1; digits < 9; digits++) {
    const n = Number(x.toPrecision(digits));
    if (Math.fround(n) === x) {
      return n;
    }
  }
  return x;
}

/// One cell as a JSON value: a boolean, a number where a double holds it
/// exactly, null for a null, and q's text for the rest - a temporal, a
/// symbol, a guid, a nested value, an infinity, a long past 2^53.
export function jsonCell(type: number, text: string, raw: unknown): Cell {
  if (raw === null) {
    return null;
  }
  if (raw === Infinity || raw === -Infinity) {
    return cellText(type, text, raw, -1);
  }
  switch (type) {
    case 1:
      return text === "1";
    case 5:
    case 6:
    case 7: {
      const n = Number(text);
      return text !== "" && Number.isSafeInteger(n) ? n : text;
    }
    case 8:
      return typeof raw === "number" ? real(raw) : text;
    case 9:
      return typeof raw === "number" ? raw : text;
    default:
      return text;
  }
}

/// The rows of `grid`, each a list of JSON values.
function rows(grid: GridPayload): Cell[][] {
  const count = grid.cells[0]?.length ?? 0;
  return [...Array(count).keys()].map((r) =>
    grid.cells.map((column, i) => jsonCell(grid.types[i], column[r], grid.raw[i][r])),
  );
}

/// What the agent is given for `answer`: the rows of a tabular value, the
/// process's text of any other, or the error. A tabular value the process
/// could not cut (`gridError`) is given as its text.
export function shape(answer: GridAnswer): AgentResult {
  if (!answer.ok) {
    return { error: answer.error, ...(answer.trace.trim() !== "" ? { trace: answer.trace.replace(/\n+$/, "") } : {}) };
  }
  const grid = answer.grid;
  if (grid === undefined) {
    return { output: answer.text.join("\n") };
  }
  const data = rows(grid);
  return {
    columns: grid.names,
    types: grid.types.map(typeName),
    ...(grid.keys > 0 ? { keyColumns: grid.keys } : {}),
    rowCount: grid.count,
    data,
    ...(grid.count > data.length ? { truncated: true as const } : {}),
  };
}

/// Run the agent's `code` on `connection` and shape what comes back; the
/// text of a value that is not tabular is cut at the console `size`.
export async function runAgentQuery(connection: QConnection, code: string, size: [number, number]): Promise<AgentResult> {
  return shape(await connection.queryGrid(statements(code), size, ROW_LIMIT));
}

/// Every label a query can name: the saved processes, then the discovered
/// ones as `server/label`.
export function knownLabels(saved: Process[], discovered: Discovered[]): string[] {
  return [
    ...saved.map((p) => p.label),
    ...discovered.flatMap(({ server, state }) => state.processes.map((p) => qualified(server.label, p.label))),
  ];
}

function listed(saved: Process[], discovered: Discovered[]): string {
  const labels = knownLabels(saved, discovered);
  return labels.length === 0 ? "No q process is saved in q-lint yet." : `The labels are: ${labels.join(", ")}.`;
}

/// The process `label` names: a saved one before a discovered one, as
/// Connect reads a label. An error listing the labels when none is.
export function resolveProcess(label: string, saved: Process[], discovered: Discovered[]): { process: Process } | { error: string } {
  const process = saved.find((p) => p.label === label) ?? findDiscovered(discovered, label);
  return process !== undefined ? { process } : { error: `No q process is labelled "${label}". ${listed(saved, discovered)}` };
}

/// The error for a query that names no process when none is connected.
export function notConnected(saved: Process[], discovered: Discovered[]): string {
  return `No q process is connected. Ask the user to connect to one in q-lint, or pass its label as "process". ${listed(saved, discovered)}`;
}

/// The label Copy Label for Agent Query copies for a Processes view row: a
/// discovered process's qualified, as a query names it.
export function rowLabel(row: Row | undefined): string | undefined {
  if (row?.kind === "process") {
    return row.process.label;
  }
  if (row?.kind === "discovered") {
    return qualified(row.server, row.process.label);
  }
  return undefined;
}

/// Tagged prod, prd or production.
export function isProduction(process: Process): boolean {
  // By the tag, not its colour: a user may recolour prod in
  // q-lint.processes.tagColors, and that must not quiet the warning.
  return process.tags.some((tag) => tagColour(tag) === "red");
}

/// `code` fenced as q, with a fence longer than any run of backticks in it.
function fenced(code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}q\n${code}\n${fence}`;
}

const escaped = (text: string): string => text.replace(/([\\`*_[\]<>])/g, "\\$1");

/// What the user is asked before an agent's query runs on `target`: its
/// title, and its body as Markdown. `connects` when q-lint connects to the
/// process first, in place of the active connection `replaces`.
export function confirmation(
  code: string,
  target: Process,
  how: { connects: boolean; replaces?: string } = { connects: false },
): { title: string; message: string } {
  const label = escaped(target.label);
  const warning = isProduction(target)
    ? [
        `**Warning: ${label} is a production process** (tagged ${escaped(target.tags.join(", "))}). ` +
          "The agent's query runs there as written, and can change or delete data, or keep the process busy. " +
          "Read it before you continue.",
      ]
    : [];
  const address = escaped(`${target.host}:${target.port}`);
  const where = !how.connects
    ? `on **${label}** (${address}), the active connection`
    : how.replaces === undefined
      ? `on **${label}** (${address}), connecting to it first`
      : `on **${label}** (${address}), connecting to it in place of ${escaped(how.replaces)}`;
  return {
    title: `Run a q query on ${target.label}?`,
    message: [...warning, `An agent asks to run this query ${where}:`, fenced(code)].join("\n\n"),
  };
}
