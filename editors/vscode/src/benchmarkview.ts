// The benchmark (#1048) in the editor: **q-lint: Benchmark Expression**
// times the selection, or the statement at the cursor - and, when a second
// expression is given, that one too - with `\ts:N`, repeated K times, on
// the connected process, and shows a table and a chart of each one's time
// per run and space (`benchmark.ts`). It runs only when the command is run.
//
// The expressions run as written, so they go through `Live.runOnActive`:
// the read-only guard reads them as `\ts:N e` and asks first on a guarded
// process when they would change it. Off (q-lint.query.benchmark.enable),
// the command refuses, the panel closes and nothing is sent.
import { randomBytes } from "node:crypto";
import { ViewColumn, commands, window, workspace, type ExtensionContext, type WebviewPanel } from "vscode";
import { DEFAULT_RUNS, benchmarkHtml, benchmarkLambda, expressionProblem, guardCode, readRuns, readTimings, summarise, type Summary } from "./benchmark";
import type { Live } from "./live";
import { PROCESS_TOOL_COMMANDS, asCode, toolOff, toolOn } from "./processtools";
import { plainMessage } from "./history";

/// What a run turned off before it was sent hands back.
const OFF = Symbol("off");
const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "benchmark");

function say(text: string): string {
  void window.showInformationMessage(plainMessage(text));
  return text;
}

export interface BenchmarkResult {
  process: string;
  n: number;
  k: number;
  summary: Summary[];
}

export function registerBenchmark(
  context: ExtensionContext,
  live: Live,
): { benchmark: (code?: string, second?: string, runs?: string) => Promise<BenchmarkResult | string>; html: () => string | undefined; panelOpen: () => boolean } {
  let panel: WebviewPanel | undefined;
  const close = (): void => {
    panel?.dispose();
    panel = undefined;
  };
  const benchmark = async (given?: string, givenSecond?: string, givenRuns?: string): Promise<BenchmarkResult | string> => {
    if (!on()) {
      return say(toolOff("benchmark"));
    }
    const code = given ?? (await live.codeFromEditor());
    if (code === undefined) {
      return "nothing to run";
    }
    const problem = expressionProblem(code);
    if (problem !== undefined) {
      return say(`q-lint: ${problem}.`);
    }
    const second =
      givenSecond ??
      (await window.showInputBox({
        title: "q-lint: compare with a second expression?",
        prompt: `Benchmark ${code.trim()} against another expression, or leave empty to benchmark it alone.`,
        validateInput: (v) => (v.trim() === "" ? undefined : expressionProblem(v)),
      }));
    if (second === undefined) {
      return "cancelled";
    }
    if (second.trim() !== "" && expressionProblem(second) !== undefined) {
      return say(`q-lint: ${expressionProblem(second)}.`);
    }
    const runsText =
      givenRuns ??
      (await window.showInputBox({
        title: "q-lint: runs per \\ts, and repeats",
        prompt: "N K: each expression runs N times per \\ts:N, and that is repeated K times (N up to 1000000, K up to 100).",
        value: `${DEFAULT_RUNS.n} ${DEFAULT_RUNS.k}`,
        validateInput: (v) => (readRuns(v) === undefined ? "Two whole numbers, N then K, as 100 5." : undefined),
      }));
    if (runsText === undefined) {
      return "cancelled";
    }
    const runs = readRuns(runsText);
    if (runs === undefined) {
      return say("q-lint: runs are two whole numbers, N then K, as 100 5.");
    }
    const expressions = [code.trim(), ...(second.trim() === "" ? [] : [second.trim()])];
    let ran: { process: string; value: unknown } | undefined;
    try {
      // Turned off while it asked: nothing is timed (#1453).
      ran = await live.runOnActive(guardCode(expressions, runs.n), async (connection) => (on() ? connection.guarded(benchmarkLambda, expressions.map(asCode), runs.n, runs.k) : OFF));
    } catch (error) {
      return say(`q-lint: the benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (ran === undefined) {
      return "nothing was run";
    }
    if (ran.value === OFF) {
      return say(toolOff("benchmark"));
    }
    let summary: Summary[];
    try {
      summary = summarise(readTimings(ran.value, expressions), runs.n);
    } catch (error) {
      return say(`q-lint: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!on()) {
      return say(toolOff("benchmark"));
    }
    if (panel === undefined) {
      const created = window.createWebviewPanel("q-lint.benchmark", "q-lint: benchmark", { viewColumn: ViewColumn.Beside, preserveFocus: true }, { enableScripts: false });
      created.onDidDispose(() => {
        if (panel === created) {
          panel = undefined;
        }
      });
      panel = created;
    } else {
      panel.reveal(undefined, true);
    }
    panel.title = `q-lint: benchmark on ${ran.process}`;
    panel.webview.html = benchmarkHtml(summary, ran.process, runs.n, runs.k, randomBytes(16).toString("base64"));
    return { process: ran.process, n: runs.n, k: runs.k, summary };
  };
  context.subscriptions.push(
    commands.registerCommand(PROCESS_TOOL_COMMANDS.benchmark, (code?: unknown, second?: unknown, runs?: unknown) =>
      benchmark(typeof code === "string" ? code : undefined, typeof second === "string" ? second : undefined, typeof runs === "string" ? runs : undefined),
    ),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.query.benchmark") && !on() && close()),
    { dispose: close },
  );
  return { benchmark, html: () => panel?.webview.html, panelOpen: () => panel !== undefined };
}
