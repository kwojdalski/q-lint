// Two more language-model tools (#951), beside Run q Query (`agenttool.ts`):
// List q Tables, the tables and one table's schema on the connected process,
// and Lint q Code, qlinter's findings on q code. The VS Code around
// `assist.ts`.
//
// List q Tables sends no code a model wrote: it reads with the explorer's
// own lambdas (`GATHER`, `TABLE_INFO`), on the connected process only, and
// shares the query connection as the explorer does - it never interrupts a
// query. A table it is asked for must be a plain q name the process lists
// as a table (`tables`, which evaluates no view): never a file handle, a
// view or an expression, all of which `get` would read or run (#1612). The
// user is asked before a table's schema is read, as before a query. Lint q Code runs the qlinter binary the language server runs, on
// the code given as standard input; it touches no process. Each tool has its
// own setting: turned off, it is unregistered, and a call already on its way
// is answered that it is off.
import { spawn } from "node:child_process";
import {
  LanguageModelTextPart,
  LanguageModelToolResult,
  lm,
  MarkdownString,
  workspace,
  type CancellationToken,
  type Disposable,
  type ExtensionContext,
  type LanguageModelTool,
  type LanguageModelToolInvocationOptions,
  type LanguageModelToolInvocationPrepareOptions,
  type PreparedToolInvocation,
} from "vscode";
import { notConnected } from "./agent";
import { lintArgs, readLint, schemaOf, tablesOf, type LintFinding } from "./assist";
import { ASSIST_SETTINGS, assistOff, readAssist, type AssistFeature } from "./assistconfig";
import { GATHER, LIMITS, readExplorer, readGathered } from "./explorer";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { TABLE_INFO, readTableInfo } from "./tableinfo";

export const ASSIST_TOOLS = {
  tables: "q-lint_listTables",
  lint: "q-lint_lint",
} as const;

/// Columns of one table's schema answered at most.
const SCHEMA_COLUMNS = 200;
/// Findings Lint q Code answers at most (#1628).
const FINDINGS_LIMIT = 200;

/// A table's name as q code names it - `t` or `.ns.t` - and nothing else:
/// no handle, no backtick, no expression (#1612).
export const isTableName = (name: string): boolean => /^\.?[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/.test(name);

/// TABLE_INFO, run only on a name the process lists as a table in its
/// namespace: `tables` reads `\a`, which evaluates no view.
export const LISTED_TABLE_INFO = [
  "{[nm;lim]",
  " p:@[` vs;@[`$;nm;`];`$()];",
  " if[not(last p)in@[tables;$[1=count p;`.;` sv -1_p];`$()];'\"not a table\"];",
  ` f:${TABLE_INFO.replace(/\n/g, "\n  ")};`,
  " f[nm;lim]}",
].join("\n");
/// Seconds qlinter may take, and the most code it is given.
const LINT_TIMEOUT = 20;
const LINT_LIMIT = 1_000_000;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function setting(feature: AssistFeature): boolean {
  const configuration = workspace.getConfiguration("q-lint");
  return readAssist((key, fallback) => configuration.get(key, fallback))[feature];
}

const answer = (value: unknown): LanguageModelToolResult => new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(value))]);

export interface TablesInput {
  table?: string;
  process?: string;
}

export class ListTablesTool implements LanguageModelTool<TablesInput> {
  /// The process the user was asked to read each table on, or null when
  /// nothing was connected and they were asked nothing.
  private readonly asked = new Map<string, string | null>();

  constructor(private readonly live: Live) {}

  prepareInvocation(options?: LanguageModelToolInvocationPrepareOptions<TablesInput>): PreparedToolInvocation {
    const active = this.live.activeLabel();
    const table: unknown = options?.input?.table;
    if (typeof table !== "string" || !isTableName(table.trim())) {
      return { invocationMessage: `Reading the tables of ${active ?? "the q process"}` };
    }
    const name = table.trim();
    this.asked.delete(name);
    this.asked.set(name, active ?? null);
    if (active === undefined) {
      return { invocationMessage: `Reading the schema of ${name}` };
    }
    // Tables asked about and never read are forgotten, oldest first.
    for (const key of [...this.asked.keys()].slice(0, -20)) {
      this.asked.delete(key);
    }
    return {
      invocationMessage: `Reading the schema of ${name} on ${active}`,
      confirmationMessages: {
        title: `Read a table's schema on ${active}`,
        message: new MarkdownString(`Read the columns, types and row count of the table \`${name}\` on **${active}**? Only a table the process lists is read.`),
      },
    };
  }

  async invoke(options: LanguageModelToolInvocationOptions<TablesInput>): Promise<LanguageModelToolResult> {
    return answer(await this.run(options.input));
  }

  /// The tables of the connected process, or one table's schema.
  async run(input: TablesInput): Promise<unknown> {
    if (!setting("schemaTool")) {
      return { error: assistOff("schemaTool").replace(/^q-lint: /, "") };
    }
    const active = this.live.activeLabel();
    if (active === undefined) {
      return { error: notConnected(this.live.processes(), this.live.discovery.discovered()) };
    }
    const named: unknown = input.process;
    const table: unknown = input.table;
    if (named !== undefined && named !== active) {
      return {
        error: `List q Tables reads the connected process, ${active}, only. To read ${JSON.stringify(named)}, connect to it first: Run q Query with "process" connects.`,
      };
    }
    if (table !== undefined && (typeof table !== "string" || !isTableName(table.trim()))) {
      return { error: `"table" must be a table's name, a string, as q code names it: t or .ns.t.` };
    }
    if (typeof table === "string") {
      const shown = this.asked.get(table.trim());
      this.asked.delete(table.trim());
      if (shown === null) {
        return { error: `Nothing was read: when the call was made no q process was connected, so the user was not asked to read ${table.trim()} on ${active}. Ask again.` };
      }
      if (shown !== undefined && shown !== active) {
        return { error: `Nothing was read: the user was asked to read ${table.trim()} on ${shown}, and the connected process is now ${active}. Ask again.` };
      }
    }
    try {
      const got =
        table === undefined
          ? await borrowWhenFree(this.live, async (connection, process) => {
              const configuration = workspace.getConfiguration("q-lint");
              const { excludedNamespaces } = readExplorer((key, fallback) => configuration.get(key, fallback));
              const gathered = readGathered(await connection.call(GATHER, excludedNamespaces.join(" "), LIMITS));
              const { tables, more } = tablesOf(gathered);
              return {
                process: process.label,
                tables,
                ...(more > 0 ? { moreTables: more } : {}),
                ...(gathered.more > 0 ? { namespacesNotRead: gathered.more } : {}),
              };
            })
          : await borrowWhenFree(this.live, async (connection, process) => {
              const name = (table as string).trim();
              return { process: process.label, ...schemaOf(name, readTableInfo(await connection.call(LISTED_TABLE_INFO, name, SCHEMA_COLUMNS))) };
            });
      return got === undefined ? { error: `${active} is busy with a query. Try again once it is done.` } : got.value;
    } catch (error) {
      return { error: message(error) };
    }
  }
}

export interface LintInput {
  code: string;
  /// The file the code is linted as, for which configuration applies.
  file?: string;
}

/// Run `command` with `args`, `input` as standard input; its output and
/// exit status. Rejects when it cannot be run or takes over `seconds`.
export function runWith(command: string, args: string[], input: string, cwd: string | undefined, seconds: number, token?: CancellationToken): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`qlinter took longer than ${seconds} s`));
    }, seconds * 1000);
    const cancelled = token?.onCancellationRequested(() => child.kill());
    // Decoded across chunks: a character split at a chunk's end stays whole (#1380).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      cancelled?.dispose();
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      cancelled?.dispose();
      resolve({ status, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export class LintTool implements LanguageModelTool<LintInput> {
  /// `servers`: the qlinter binaries to try, in order, as the language
  /// server is started.
  constructor(private readonly servers: () => string[]) {}

  prepareInvocation(): PreparedToolInvocation {
    return { invocationMessage: "Linting q code with qlinter" };
  }

  async invoke(options: LanguageModelToolInvocationOptions<LintInput>, token: CancellationToken): Promise<LanguageModelToolResult> {
    return answer(await this.run(options.input, token));
  }

  async run(input: LintInput, token?: CancellationToken): Promise<{ findings: LintFinding[]; count: number } | { error: string }> {
    if (!setting("lintTool")) {
      return { error: assistOff("lintTool").replace(/^q-lint: /, "") };
    }
    if (typeof input.code !== "string") {
      return { error: `"code" must be q code, a string, not ${JSON.stringify(input.code ?? null)}.` };
    }
    if (input.code.length > LINT_LIMIT) {
      return { error: `The code is longer than ${LINT_LIMIT} characters.` };
    }
    const file = typeof input.file === "string" && /^[\w./-]+\.q$/.test(input.file) && !input.file.includes("..") ? input.file : "snippet.q";
    const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
    let last = "no qlinter binary to run";
    for (const command of this.servers()) {
      // A cancelled lint stops: the next binary is not tried (#1381).
      if (token?.isCancellationRequested) {
        return { error: "Linting was cancelled." };
      }
      try {
        const ran = await runWith(command, lintArgs(file), input.code, cwd, LINT_TIMEOUT, token);
        if (token?.isCancellationRequested) {
          return { error: "Linting was cancelled." };
        }
        // 0: no findings; 1: findings; anything else: qlinter failed.
        if (ran.status !== 0 && ran.status !== 1) {
          last = `qlinter exited with ${ran.status}: ${ran.stderr.trim().slice(0, 500)}`;
          continue;
        }
        const findings = readLint(ran.stdout);
        return { findings, count: findings.length };
      } catch (error) {
        last = message(error);
      }
    }
    if (token?.isCancellationRequested) {
      return { error: "Linting was cancelled." };
    }
    return { error: `Could not lint: ${last}.` };
  }
}

/// Register each tool while its setting is on, and unregister it when it is
/// turned off. Needs VS Code 1.95's `lm.registerTool`; before it, nothing.
export function registerAssistTools(context: ExtensionContext, live: Live, servers: () => string[]): { tables: ListTablesTool; lint: LintTool; registered: () => string[] } {
  const tables = new ListTablesTool(live);
  const lint = new LintTool(servers);
  const registered = new Map<string, Disposable>();
  const sync = (): void => {
    if (typeof lm?.registerTool !== "function") {
      return;
    }
    for (const [feature, id, tool] of [
      ["schemaTool", ASSIST_TOOLS.tables, tables],
      ["lintTool", ASSIST_TOOLS.lint, lint],
    ] as const) {
      const on = setting(feature);
      const had = registered.get(id);
      if (on && had === undefined) {
        registered.set(id, lm.registerTool(id, tool as LanguageModelTool<unknown>));
      } else if (!on && had !== undefined) {
        had.dispose();
        registered.delete(id);
      }
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`q-lint.${ASSIST_SETTINGS.schemaTool.key}`) ||
        event.affectsConfiguration(`q-lint.${ASSIST_SETTINGS.lintTool.key}`)
      ) {
        sync();
      }
    }),
    {
      dispose: () => {
        for (const d of registered.values()) {
          d.dispose();
        }
        registered.clear();
      },
    },
  );
  return { tables, lint, registered: () => [...registered.keys()] };
}
