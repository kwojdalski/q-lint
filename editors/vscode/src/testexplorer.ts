// The Test Explorer integration (#939): q tests in VS Code's Testing view,
// run on a q process the user chose (`testing.ts` has the data and the q).
//
// Two kinds are listed. The functions a Run test lens is drawn over - a
// `test_*` or qUnit `testName` function a statement at column 0 defines,
// `.qt` suites included - come from the language server (`q-lint/tests`),
// which reads them as it reads everything else. k4unit suites are CSV
// files with k4unit's header, read here. A function test is run as its lens
// runs it: its definition sent under its `\d`, then the call; the rest of
// its file is not loaded first. A k4unit row runs after its file's `before`
// rows and before its `after` rows.
//
// **Run** goes to the active connection, or asks which process to connect
// to when there is none; **Run on q Process...** always asks. A process
// tagged prod, prd or production is confirmed first. Nothing is read or sent
// while q-lint.testExplorer.enable is off: the controller is disposed.
//
// Two more, each with its own switch. A failed assertion with two sides - a
// k4unit `a~b` row, a qUnit assertion - shows them as a diff, and **Re-run
// Failed q Tests** runs again those that failed (#980,
// q-lint.testExplorer.failedTests.enable). Snapshot files (`.qsnap`, #981,
// q-lint.snapshotTests.enable) are tests too: the query is run again and its
// result compared with the file's.
import {
  Location,
  Range,
  TestMessage,
  TestRunProfileKind,
  TestRunRequest,
  Uri,
  commands,
  tests,
  window,
  workspace,
  type CancellationToken,
  type ExtensionContext,
  type TestController,
  type TestItem,
  type TestRun,
} from "vscode";
import { isProduction } from "./agent";
import { editorFeatureOff, editorFeatureOn, type EditorFeature, type Server } from "./editorfeatures";
import type { Live } from "./live";
import { readAnswer } from "./query";
import { SNAPSHOT_EXTENSION, SNAPSHOT_RUN, parseSnapshot, sameResult, type Snapshot } from "./snapshot";
import { statements } from "./statements";
import {
  RERUN_FAILED,
  TEST_RUN,
  failureText,
  isK4Test,
  k4Label,
  k4Mode,
  k4Statement,
  parseK4unit,
  readServerTests,
  readTestResult,
  splitMatch,
  testStatements,
  type K4Row,
  type ServerTest,
  type TestMode,
} from "./testing";

export { RERUN_FAILED } from "./testing";
export const TEST_CONTROLLER = "q-lint.tests";
/// The server's request for the tests it reads.
export const TESTS_REQUEST = "q-lint/tests";
/// The most CSV files read for k4unit suites.
const MAX_CSV = 500;

/// What the last run of a test gave.
export interface TestOutcome {
  id: string;
  state: "passed" | "failed" | "errored" | "skipped";
  message?: string;
}

type Entry =
  | { kind: "function"; test: ServerTest }
  | { kind: "k4unit"; rows: K4Row[]; row: K4Row }
  | { kind: "snapshot"; snapshot: Snapshot };

const featureOn = (feature: EditorFeature): boolean =>
  editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), feature);
const on = (): boolean => featureOn("testExplorer");

/// Register the integration while q-lint.testExplorer.enable is on.
/// `server` is the language server while it runs.
export function registerTestExplorer(
  context: ExtensionContext,
  live: Live,
  server: () => Server | undefined,
): {
  serverChanged: () => void;
  discover: () => Promise<void>;
  /// The tests listed, by id, and what the last run of each gave.
  items: () => string[];
  results: () => TestOutcome[];
  /// Run the tests with these ids, as the Run profile does (`ask`: as Run
  /// on q Process... does).
  run: (ids?: string[], ask?: boolean) => Promise<void>;
} {
  let running: QTests | undefined;
  const sync = (): void => {
    if (on() && running === undefined) {
      running = new QTests(live, server);
    } else if (!on() && running !== undefined) {
      running.dispose();
      running = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("q-lint.testExplorer")) {
        sync();
      }
      if (event.affectsConfiguration("q-lint.testExplorer.failedTests") || event.affectsConfiguration("q-lint.snapshotTests")) {
        void running?.discover();
      }
    }),
    { dispose: () => running?.dispose() },
    commands.registerCommand(RERUN_FAILED, async () => {
      if (!on()) {
        void window.showInformationMessage(editorFeatureOff("testExplorer"));
      } else if (!featureOn("failedTests")) {
        void window.showInformationMessage(editorFeatureOff("failedTests"));
      } else if (running !== undefined) {
        await running.rerunFailed();
      }
    }),
  );
  return {
    serverChanged: () => void running?.discover(),
    discover: async () => running?.discover(),
    items: () => running?.ids() ?? [],
    results: () => running?.outcomes ?? [],
    run: async (ids, ask = false) => running?.runIds(ids, ask),
  };
}

class QTests {
  readonly controller: TestController;
  private readonly entries = new WeakMap<TestItem, Entry>();
  private readonly disposables: { dispose(): unknown }[];
  private discovering: Promise<void> | undefined;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /// The outcomes of the last run, in order.
  outcomes: TestOutcome[] = [];

  constructor(
    private readonly live: Live,
    private readonly server: () => Server | undefined,
  ) {
    this.controller = tests.createTestController(TEST_CONTROLLER, "q tests");
    this.controller.resolveHandler = async (item) => {
      if (item === undefined) {
        await this.discover();
      }
    };
    this.controller.refreshHandler = () => this.discover();
    this.controller.createRunProfile("Run", TestRunProfileKind.Run, (request, token) => this.run(request, token, false), true);
    this.controller.createRunProfile("Run on q Process...", TestRunProfileKind.Run, (request, token) => this.run(request, token, true), false);
    const later = (): void => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.discover(), 500);
    };
    const watcher = workspace.createFileSystemWatcher(`**/*.{q,csv,${SNAPSHOT_EXTENSION.slice(1)}}`);
    this.disposables = [
      watcher,
      watcher.onDidCreate(later),
      watcher.onDidDelete(later),
      watcher.onDidChange(later),
      workspace.onDidSaveTextDocument((document) => /\.(q|csv|qsnap)$/i.test(document.uri.fsPath) && later()),
    ];
  }

  /// Run again the tests the last run failed or could not run.
  async rerunFailed(): Promise<void> {
    const failed = this.outcomes.filter((o) => o.state === "failed" || o.state === "errored").map((o) => o.id);
    if (failed.length === 0) {
      void window.showInformationMessage("q-lint: the last q test run failed no test.");
      return;
    }
    await this.runIds(failed, false);
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.controller.dispose();
  }

  /// Read the tests again: one read at a time, and one more after it when
  /// asked meanwhile.
  discover(): Promise<void> {
    if (this.discovering !== undefined) {
      this.again = true;
      return this.discovering;
    }
    this.discovering = this.read().finally(() => {
      this.discovering = undefined;
      if (this.again) {
        this.again = false;
        void this.discover();
      }
    });
    return this.discovering;
  }

  private async read(): Promise<void> {
    const items: TestItem[] = [];
    const server = this.server();
    if (server !== undefined) {
      let files: ReturnType<typeof readServerTests> = [];
      try {
        files = readServerTests(await server.sendRequest(TESTS_REQUEST, {}));
      } catch {
        // A server stopping as it is asked: the next change asks again.
      }
      for (const file of files) {
        const uri = Uri.parse(file.uri);
        const parent = this.controller.createTestItem(file.uri, workspace.asRelativePath(uri), uri);
        for (const test of file.tests) {
          const item = this.controller.createTestItem(`${file.uri}#${test.name}`, test.name, uri);
          item.range = new Range(test.range.start.line, test.range.start.character, test.range.end.line, test.range.end.character);
          this.entries.set(item, { kind: "function", test });
          parent.children.add(item);
        }
        items.push(parent);
      }
    }
    for (const uri of await workspace.findFiles("**/*.csv", "**/node_modules/**", MAX_CSV)) {
      let rows: K4Row[] | undefined;
      try {
        rows = parseK4unit(Buffer.from(await workspace.fs.readFile(uri)).toString("utf8"));
      } catch {
        continue;
      }
      const tested = rows?.filter(isK4Test) ?? [];
      if (rows === undefined || tested.length === 0) {
        continue;
      }
      const id = uri.toString();
      const parent = this.controller.createTestItem(id, workspace.asRelativePath(uri), uri);
      for (const row of tested) {
        const item = this.controller.createTestItem(`${id}#${row.line}`, `${row.action}: ${k4Label(row)}`, uri);
        item.range = new Range(row.line, 0, row.line, 0);
        this.entries.set(item, { kind: "k4unit", rows, row });
        parent.children.add(item);
      }
      items.push(parent);
    }
    if (featureOn("snapshotTests")) {
      for (const uri of await workspace.findFiles(`**/*${SNAPSHOT_EXTENSION}`, "**/node_modules/**", MAX_CSV)) {
        let snapshot: Snapshot | undefined;
        try {
          snapshot = parseSnapshot(Buffer.from(await workspace.fs.readFile(uri)).toString("utf8"));
        } catch {
          continue;
        }
        if (snapshot === undefined) {
          continue;
        }
        const name = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
        const item = this.controller.createTestItem(uri.toString(), `snapshot: ${name.slice(0, -SNAPSHOT_EXTENSION.length)}`, uri);
        item.range = new Range(0, 0, 0, 0);
        this.entries.set(item, { kind: "snapshot", snapshot });
        items.push(item);
      }
    }
    this.controller.items.replace(items);
  }

  /// Every test's id, in order.
  ids(): string[] {
    const out: string[] = [];
    const add = (item: TestItem): void => {
      if (this.entries.has(item)) {
        out.push(item.id);
      }
      item.children.forEach(add);
    };
    this.controller.items.forEach(add);
    return out;
  }

  /// Run the tests with `ids`, or all of them.
  runIds(ids: string[] | undefined, ask: boolean): Promise<void> {
    const found: TestItem[] = [];
    const add = (item: TestItem): void => {
      if (ids === undefined ? this.entries.has(item) : ids.includes(item.id)) {
        found.push(item);
      }
      item.children.forEach(add);
    };
    this.controller.items.forEach(add);
    return this.run(new TestRunRequest(found), { isCancellationRequested: false } as CancellationToken, ask);
  }

  /// The tests a request runs, in the Testing view's order.
  private chosen(request: TestRunRequest): TestItem[] {
    const excluded = new Set(request.exclude ?? []);
    const out: TestItem[] = [];
    const add = (item: TestItem): void => {
      if (excluded.has(item)) {
        return;
      }
      if (this.entries.has(item)) {
        out.push(item);
        return;
      }
      item.children.forEach(add);
    };
    if (request.include !== undefined) {
      request.include.forEach(add);
    } else {
      this.controller.items.forEach(add);
    }
    return out;
  }

  private async run(request: TestRunRequest, token: CancellationToken, ask: boolean): Promise<void> {
    if (!on()) {
      return;
    }
    const chosen = this.chosen(request);
    if (chosen.length === 0) {
      return;
    }
    // Asked for first: the run starts once there is somewhere to run it.
    if (ask || this.live.activeProcess() === undefined) {
      if (!(await this.live.connectTo())) {
        return;
      }
    }
    const process = this.live.activeProcess();
    if (process === undefined) {
      return;
    }
    if (isProduction(process)) {
      const go = "Run Tests";
      const answer = await window.showWarningMessage(
        `${process.label} is a production process (tagged ${process.tags.join(", ")}). Run ${chosen.length} test${chosen.length === 1 ? "" : "s"} there?`,
        { modal: true, detail: "Each test's definition is sent and called there as written, and can change data or keep the process busy." },
        go,
      );
      if (answer !== go) {
        return;
      }
    }
    const run = this.controller.createTestRun(request, `q tests on ${process.label}`);
    this.outcomes = [];
    const outcome = (item: TestItem, state: TestOutcome["state"], message?: string): void => {
      this.outcomes.push({ id: item.id, state, ...(message !== undefined ? { message } : {}) });
    };
    for (const item of chosen) {
      run.enqueued(item);
    }
    // A k4unit file's `before` rows run once, before its first test, and its
    // `after` rows once its last test has run.
    const remaining = new Map<K4Row[], number>();
    for (const item of chosen) {
      const entry = this.entries.get(item);
      if (entry?.kind === "k4unit") {
        remaining.set(entry.rows, (remaining.get(entry.rows) ?? 0) + 1);
      }
    }
    const prepared = new Set<K4Row[]>();
    const send = (statements: string[], mode: TestMode) =>
      this.live.runOnActive(statements.join("\n"), async (connection) => readTestResult(await connection.call(TEST_RUN, statements, mode)));
    try {
      for (const item of chosen) {
        const entry = this.entries.get(item)!;
        if (token.isCancellationRequested) {
          run.skipped(item);
          outcome(item, "skipped");
          continue;
        }
        run.started(item);
        const started = Date.now();
        try {
          let statements: string[];
          let mode: TestMode;
          if (entry.kind === "snapshot") {
            await this.runSnapshot(run, item, entry.snapshot, process.label, started, outcome);
            continue;
          }
          if (entry.kind === "function") {
            statements = testStatements(entry.test);
            mode = "test";
          } else {
            if (!prepared.has(entry.rows)) {
              prepared.add(entry.rows);
              for (const row of entry.rows.filter((r) => r.action === "before")) {
                const done = await send([k4Statement(row)], "run");
                if (done !== undefined && !done.value.passed) {
                  run.appendOutput(`before (line ${row.line + 1}) failed: ${done.value.text}\r\n`);
                }
              }
            }
            statements = [k4Statement(entry.row)];
            mode = k4Mode(entry.row);
            // A true row `a~b` is sent as `(a;b)`, for both sides (#980).
            const sides = mode === "true" && entry.row.lang !== "k" && featureOn("failedTests") ? splitMatch(entry.row.code) : undefined;
            if (sides !== undefined) {
              statements = [`(${sides.left};${sides.right})`];
              mode = "match";
            }
          }
          const done = await send(statements, mode);
          const duration = Date.now() - started;
          if (done === undefined) {
            const text = `Not run: no connection to ${process.label}, or a query is still running there.`;
            run.errored(item, new TestMessage(text));
            outcome(item, "errored", text);
          } else if (done.value.passed) {
            run.passed(item, duration);
            outcome(item, "passed");
          } else {
            const diff = featureOn("failedTests") ? done.value.diff : undefined;
            const message =
              diff !== undefined ? TestMessage.diff(failureText(done.value, mode), diff.expected, diff.actual) : new TestMessage(failureText(done.value, mode));
            if (item.uri !== undefined && item.range !== undefined) {
              message.location = new Location(item.uri, item.range);
            }
            run.failed(item, message, duration);
            outcome(item, "failed", failureText(done.value, mode));
          }
          run.appendOutput(`${item.label}: ${done === undefined ? "not run" : done.value.passed ? "passed" : "failed"} on ${done?.process ?? process.label}\r\n`);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          run.errored(item, new TestMessage(text));
          outcome(item, "errored", text);
        } finally {
          if (entry.kind === "k4unit") {
            const left = (remaining.get(entry.rows) ?? 1) - 1;
            remaining.set(entry.rows, left);
            if (left === 0) {
              for (const row of entry.rows.filter((r) => r.action === "after")) {
                await send([k4Statement(row)], "run").catch(() => undefined);
              }
            }
          }
        }
      }
    } finally {
      run.end();
    }
  }

  /// Run a snapshot: its query again, its result compared with the file's.
  private async runSnapshot(
    run: TestRun,
    item: TestItem,
    snapshot: Snapshot,
    label: string,
    started: number,
    outcome: (item: TestItem, state: TestOutcome["state"], message?: string) => void,
  ): Promise<void> {
    const done = await this.live.runOnActive(snapshot.query, async (connection) =>
      readAnswer(await connection.call(SNAPSHOT_RUN, statements(snapshot.query))),
    );
    const at = item.uri !== undefined ? new Location(item.uri, new Range(0, 0, 0, 0)) : undefined;
    if (done === undefined) {
      const text = `Not run: no connection to ${label}, or a query is still running there.`;
      run.errored(item, new TestMessage(text));
      outcome(item, "errored", text);
    } else if (!done.value.ok) {
      const text = `'${done.value.error}`;
      const message = new TestMessage(text);
      message.location = at;
      run.failed(item, message, Date.now() - started);
      outcome(item, "failed", text);
    } else if (sameResult(done.value.text.join("\n"), snapshot.result)) {
      run.passed(item, Date.now() - started);
      outcome(item, "passed");
    } else {
      const text = "the result differs from the snapshot";
      const message = TestMessage.diff(text, snapshot.result, done.value.text.join("\n"));
      message.location = at;
      run.failed(item, message, Date.now() - started);
      outcome(item, "failed", text);
    }
    run.appendOutput(`${item.label}: ${done === undefined ? "not run" : this.outcomes.at(-1)?.state} on ${done?.process ?? label}\r\n`);
  }
}
