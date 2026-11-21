// Drift detection (#933) and hot reload on save (#934): the VS Code around
// `definitions.ts`.
//
// Check Drift Against Process reads the functions the workspace's q files
// define, asks the connected process what it holds for each name - reading
// only - and lists those that differ, are not defined there, or are not a
// lambda there; one picked opens a diff of the two texts, or the file.
//
// Hot reload, once turned on, remembers each q file's definitions when it is
// opened, and on save sends the ones the save changed to the file's process
// with Redefine's lambda, through Redefine's confirmation (`askRedefine`,
// with its production warning). Only to the connected process, and only to
// the file's bound one when it has a binding; only a function the process
// holds as the file had it before the edit - anything else is listed as not
// sent, so a process that has drifted is never overwritten. Every save that
// sends asks, until the user picks Reload on Every Save for the file and
// process - never offered for a process tagged prod. Both are off by
// default, and turned off they register nothing and send nothing.
import { readFile } from "node:fs/promises";
import {
  EventEmitter,
  ProgressLocation,
  Range,
  Selection,
  TextEditorRevealType,
  Uri,
  commands,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
  type TextDocument,
  type TextDocumentContentProvider,
} from "vscode";
import { ASSIST_SETTINGS, assistOff, readAssist, type AssistFeature } from "./assistconfig";
import { isProduction } from "./agent";
import {
  DRIFT,
  DRIFT_BATCH,
  DRIFT_COMMANDS,
  changedSince,
  definitions,
  driftDocument,
  driftRows,
  driftSummary,
  lastByName,
  namesList,
  readDrift,
  reloadPlan,
  type Definition,
  type DriftRow,
  type ProcessState,
} from "./definitions";
import { REDEFINE } from "./funcsource";
import { askRedefine } from "./funcsourceview";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";

export const DRIFT_SCHEME = "q-lint-drift";
/// Files and definitions a drift check reads at most.
export const DRIFT_FILES = 5000;
export const DRIFT_DEFINITIONS = 20000;
const RELOAD = "Reload";
const ALWAYS = "Reload on Every Save";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function setting(feature: AssistFeature): boolean {
  const configuration = workspace.getConfiguration("q-lint");
  return readAssist((key, fallback) => configuration.get(key, fallback))[feature];
}

/// What one hot reload did, for tests and the message.
export interface Reloaded {
  file: string;
  process?: string;
  sent: string[];
  already: string[];
  skipped: { name: string; why: string }[];
  failed: { name: string; why: string }[];
  /// Why nothing was sent, when nothing was.
  reason?: string;
}

export class Drift implements TextDocumentContentProvider {
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidChange = this.changed.event;
  private readonly texts = new Map<string, string>();
  /// Each open q file's definitions as last sent or opened, by URI.
  private readonly baselines = new Map<string, Map<string, Definition>>();
  /// `uri|process` the user said to reload on every save, this session.
  private readonly always = new Set<string>();
  private listeners: Disposable[] = [];
  /// The last hot reload, for tests, and the names a confirmation is open for.
  last: Reloaded | undefined;
  private asking: string | undefined;

  constructor(context: ExtensionContext, private readonly live: Live) {
    context.subscriptions.push(
      this.changed,
      workspace.registerTextDocumentContentProvider(DRIFT_SCHEME, this),
      commands.registerCommand(DRIFT_COMMANDS.check, () => {
        if (!setting("drift")) {
          void window.showInformationMessage(assistOff("drift"));
          return undefined;
        }
        return this.check();
      }),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`q-lint.${ASSIST_SETTINGS.hotReload.key}`)) {
          this.listen();
        }
      }),
      { dispose: () => this.unlisten() },
    );
    this.listen();
  }

  provideTextDocumentContent(uri: Uri): string {
    return this.texts.get(uri.toString()) ?? "/ not read: run q-lint: Check Drift Against Process again.\n";
  }

  /// Register hot reload's listeners while its setting is on; dispose them,
  /// and forget what they knew, while it is off.
  private listen(): void {
    const on = setting("hotReload");
    if (!on) {
      this.unlisten();
      return;
    }
    if (this.listeners.length > 0) {
      return;
    }
    this.listeners = [
      workspace.onDidOpenTextDocument((document) => void this.remember(document)),
      workspace.onDidCloseTextDocument((document) => this.baselines.delete(document.uri.toString())),
      workspace.onDidSaveTextDocument((document) => void this.reload(document)),
    ];
    for (const document of workspace.textDocuments ?? []) {
      void this.remember(document);
    }
  }

  private unlisten(): void {
    for (const l of this.listeners) {
      l.dispose();
    }
    this.listeners = [];
    this.baselines.clear();
    this.always.clear();
  }

  /// Whether hot reload is listening, and the files it remembers.
  hotReloadState(): { listening: boolean; files: string[]; asking?: string; last?: Reloaded } {
    return {
      listening: this.listeners.length > 0,
      files: [...this.baselines.keys()],
      ...(this.asking !== undefined ? { asking: this.asking } : {}),
      ...(this.last !== undefined ? { last: this.last } : {}),
    };
  }

  /// Remember a q file's definitions as saved: from disk when it has unsaved
  /// edits, which a save would be the first to send.
  private async remember(document: TextDocument): Promise<void> {
    if (document.languageId !== "q" || document.uri.scheme !== "file") {
      return;
    }
    let text = document.getText();
    if (document.isDirty) {
      try {
        text = await readFile(document.uri.fsPath, "utf8");
      } catch {
        // A file not on disk yet: its first save defines the baseline.
        return;
      }
    }
    this.baselines.set(document.uri.toString(), lastByName(definitions(text)));
  }

  private name(document: TextDocument): string {
    return workspace.asRelativePath?.(document.uri) ?? document.uri.fsPath;
  }

  /// Hot reload `document`, just saved. What it did, or undefined when it
  /// was not a q file or hot reload is off.
  async reload(document: TextDocument): Promise<Reloaded | undefined> {
    if (document.languageId !== "q" || document.uri.scheme !== "file" || !setting("hotReload")) {
      return undefined;
    }
    const key = document.uri.toString();
    const before = this.baselines.get(key);
    const now = definitions(document.getText());
    const file = this.name(document);
    const done = (out: Reloaded): Reloaded => ((this.last = out), out);
    if (before === undefined) {
      // Not known when it was opened: its first save is the baseline.
      this.baselines.set(key, lastByName(now));
      return done({ file, sent: [], already: [], skipped: [], failed: [], reason: "first seen on this save" });
    }
    const changed = changedSince([...before.values()], now);
    const keep = (names: Set<string>): void => {
      const next = new Map(before);
      const changedNames = new Set(changed.map((c) => c.def.name));
      for (const d of lastByName(now).values()) {
        if (!changedNames.has(d.name) || names.has(d.name)) {
          next.set(d.name, d);
        }
      }
      this.baselines.set(key, next);
    };
    if (changed.length === 0) {
      keep(new Set());
      return done({ file, sent: [], already: [], skipped: [], failed: [], reason: "no definition changed" });
    }
    const names = changed.map((c) => c.def.name);
    const process = this.live.activeProcess();
    const bound = this.live.fileBinding(document.uri);
    if (process === undefined) {
      window.setStatusBarMessage(`q-lint: not connected; ${namesList(names)} not reloaded`, 5000);
      return done({ file, sent: [], already: [], skipped: [], failed: [], reason: "not connected" });
    }
    if (bound !== undefined && bound !== process.label) {
      void window.showInformationMessage(
        `q-lint: ${file} is bound to ${bound}, and the connection is to ${process.label}; ${namesList(names)} not reloaded.`,
      );
      return done({ file, process: process.label, sent: [], already: [], skipped: [], failed: [], reason: `bound to ${bound}` });
    }
    let states: Map<string, ProcessState>;
    try {
      const got = await borrowWhenFree(this.live, async (connection) => readDrift(await connection.call(DRIFT, names.join(" "))));
      if (got === undefined) {
        void window.showInformationMessage(`q-lint: ${process.label} is busy with a query; ${namesList(names)} not reloaded.`);
        return done({ file, process: process.label, sent: [], already: [], skipped: [], failed: [], reason: "busy" });
      }
      states = got.value;
    } catch (error) {
      void window.showErrorMessage(`q-lint: hot reload could not read ${namesList(names)} from ${process.label}: ${message(error)}`);
      return done({ file, process: process.label, sent: [], already: [], skipped: [], failed: [], reason: message(error) });
    }
    const plan = reloadPlan(changed, states);
    const out: Reloaded = { file, process: process.label, sent: [], already: plan.already, skipped: plan.skipped, failed: [] };
    const asking = `${process.label}|${key}`;
    if (plan.send.length > 0) {
      const sending = namesList(plan.send.map((s) => s.name));
      const production = isProduction(process);
      const also = `Saved in ${file}.${production ? " A production process is asked about on every save." : ""}`;
      if (production || !this.always.has(asking)) {
        this.asking = sending;
        const picked = await askRedefine(sending, process, production ? [RELOAD] : [RELOAD, ALWAYS], also).finally(() => (this.asking = undefined));
        if (picked !== RELOAD && picked !== ALWAYS) {
          out.reason = "not confirmed";
          keep(new Set(plan.already));
          this.report(out);
          return done(out);
        }
        if (picked === ALWAYS) {
          this.always.add(asking);
        }
      }
      for (const s of plan.send) {
        try {
          const got = await borrowWhenFree(this.live, (connection) => connection.call(REDEFINE, s.name, s.held, s.text));
          if (got === undefined) {
            out.failed.push({ name: s.name, why: `${process.label} is busy with a query` });
          } else {
            out.sent.push(s.name);
          }
        } catch (error) {
          out.failed.push({ name: s.name, why: message(error) });
        }
      }
    }
    keep(new Set([...out.sent, ...out.already]));
    this.report(out);
    return done(out);
  }

  private report(out: Reloaded): void {
    const notSent = [...out.skipped, ...out.failed].map((s) => `${s.name} (${s.why})`);
    if (out.sent.length > 0) {
      void window.showInformationMessage(`q-lint: reloaded ${namesList(out.sent)} on ${out.process} from ${out.file}.`);
    }
    if (notSent.length > 0) {
      void window.showWarningMessage(`q-lint: hot reload did not send ${notSent.join("; ")} to ${out.process}.`);
    }
  }

  /// The workspace's q files and the definitions in each: an open file's
  /// text as the editor has it, any other's from disk.
  private async workspaceDefinitions(): Promise<{ file: string; uri: Uri; def: Definition }[]> {
    const files = await workspace.findFiles("**/*.q", "**/node_modules/**", DRIFT_FILES);
    const open = new Map((workspace.textDocuments ?? []).map((d) => [d.uri.toString(), d]));
    const out: { file: string; uri: Uri; def: Definition }[] = [];
    for (const uri of files) {
      let text: string;
      try {
        text = open.get(uri.toString())?.getText() ?? (await readFile(uri.fsPath, "utf8"));
      } catch {
        continue;
      }
      const file = workspace.asRelativePath?.(uri) ?? uri.fsPath;
      for (const def of definitions(text)) {
        out.push({ file, uri, def });
      }
      if (out.length >= DRIFT_DEFINITIONS) {
        break;
      }
    }
    return out.slice(0, DRIFT_DEFINITIONS);
  }

  /// Check Drift Against Process. The rows, or undefined when nothing was read.
  async check(): Promise<DriftRow[] | undefined> {
    const process = this.live.activeProcess();
    if (process === undefined) {
      void window.showInformationMessage("q-lint: connect to a q process to compare the workspace's functions with it.");
      return undefined;
    }
    const read = await window.withProgress(
      { location: ProgressLocation.Notification, title: `q-lint: comparing the workspace's functions with ${process.label}` },
      async () => {
        const defs = await this.workspaceDefinitions();
        if (defs.length === 0) {
          return { defs, states: new Map<string, ProcessState>() };
        }
        const names = [...new Set(defs.map((d) => d.def.name))];
        const states = new Map<string, ProcessState>();
        for (let i = 0; i < names.length; i += DRIFT_BATCH) {
          const batch = names.slice(i, i + DRIFT_BATCH);
          const got = await borrowWhenFree(this.live, async (connection) => readDrift(await connection.call(DRIFT, batch.join(" "))));
          if (got === undefined) {
            return undefined;
          }
          for (const [k, v] of got.value) {
            states.set(k, v);
          }
        }
        return { defs, states };
      },
    ).then(
      (r) => r,
      (error: unknown) => {
        void window.showErrorMessage(`q-lint: could not compare with ${process.label}: ${message(error)}`);
        return null;
      },
    );
    if (read === null) {
      return undefined;
    }
    if (read === undefined) {
      void window.showInformationMessage(`q-lint: ${process.label} is busy with a query; try again when it is done.`);
      return undefined;
    }
    if (read.defs.length === 0) {
      void window.showInformationMessage("q-lint: no q file in the workspace defines a function.");
      return [];
    }
    const rows = driftRows(read.defs, read.states);
    const summary = driftSummary(rows, process.label);
    const drifted = rows.map((row, i) => ({ row, uri: read.defs[i].uri })).filter(({ row }) => row.status !== "same");
    if (drifted.length === 0) {
      void window.showInformationMessage(`q-lint: ${summary}`);
      return rows;
    }
    const what = { differs: "differs on the process", missing: "not defined on the process", other: "not a lambda on the process" };
    const picked = await window.showQuickPick(
      drifted.map(({ row, uri }) => ({
        label: row.name,
        description: what[row.status as keyof typeof what],
        detail: `${row.file}:${row.line + 1}`,
        row,
        uri,
      })),
      { title: summary, matchOnDescription: true, matchOnDetail: true },
    );
    if (picked !== undefined) {
      await this.show(picked.row, picked.uri, process.label);
    }
    return rows;
  }

  /// A row picked: the diff of the process's text and the workspace's, or
  /// the file at the definition when the process holds no lambda.
  private async show(row: DriftRow, uri: Uri, process: string): Promise<void> {
    if (row.status === "differs") {
      const left = Uri.from({ scheme: DRIFT_SCHEME, path: `/${row.name}.q`, query: `process=${process}` });
      const right = Uri.from({ scheme: DRIFT_SCHEME, path: `/${row.name}.q`, query: `file=${row.file}:${row.line + 1}` });
      this.texts.set(left.toString(), driftDocument(row.name, `on ${process}`, row.processText));
      this.texts.set(right.toString(), driftDocument(row.name, `in ${row.file}:${row.line + 1}`, row.text));
      this.changed.fire(left);
      this.changed.fire(right);
      await commands.executeCommand("vscode.diff", left, right, `${row.name}: ${process} ↔ ${row.file}`);
      return;
    }
    const document = await workspace.openTextDocument(uri);
    const editor = await window.showTextDocument(document);
    const at = new Selection(row.line, 0, row.line, 0);
    editor.selection = at;
    editor.revealRange(new Range(row.line, 0, row.line, 0), TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
