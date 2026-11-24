// Queries across processes: Query a Tag (#906) and Compare Query (#907),
// the VS Code around `tagquery.ts` and `compare.ts`. Each process is
// queried over a connection of its own
// (`Live.runApart`), so the active connection is left as it was, and each
// query lands in Query History under its process.
import { ProgressLocation, commands, window, workspace, type ExtensionContext } from "vscode";
import type { Row } from "./discovery";
import type { GridPayload } from "./grid";
import { iconsEscaped, plainMessage } from "./history";
import { NotSent, type Live } from "./live";
import type { Process } from "./processes";
import { statements } from "./statements";
import { AT_ONCE, TAG_QUERY, allTags, mergeOutcomes, readTagQuery, tagged, type Outcome } from "./tagquery";
import { COMPARE, compareOutcomes, readCompare, type Comparison } from "./compare";
import { CompareView, type RenderedComparison } from "./compareview";
import { readLive } from "./liveconfig";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/// `f` of each of `items`, at most `limit` at a time, in their order.
async function eachLimited<T, R>(items: T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/// Whether a feature's setting is on; when it is off, says so and how to
/// turn it on, for a command invoked anyway.
function featureOn(enabled: boolean, feature: string, key: string): boolean {
  if (!enabled) {
    void window.showInformationMessage(plainMessage(`q-lint: ${feature} is turned off. Set ${key} to true to turn it on.`));
  }
  return enabled;
}

const setting = <T>(read: (get: <V>(key: string, fallback: V) => V) => T): T => {
  const configuration = workspace.getConfiguration("q-lint");
  return read((key, fallback) => configuration.get(key, fallback));
};

export class QueryAcross {
  /// What Query a Tag last showed, for tests through the API.
  private lastTag: { tag: string; payload: GridPayload } | undefined;
  /// What Compare Query last compared.
  private lastComparison: Comparison | undefined;
  private readonly compareView: CompareView;

  constructor(
    context: ExtensionContext,
    private readonly live: Live,
  ) {
    this.compareView = new CompareView(context);
    context.subscriptions.push(
      commands.registerCommand(TAG_QUERY.command, (tag?: Row | string, code?: string) => this.queryTag(tag, code)),
      commands.registerCommand(COMPARE.command, (code?: string, first?: Row | string, second?: Row | string) => this.compare(code, first, second)),
      // Turned off, the side-by-side panel goes, as benchmark's does (#1458).
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.query.compare") && !setting(readCompare).enabled) {
          this.compareView.close();
        }
      }),
    );
  }

  state(): { tag?: { tag: string; payload: GridPayload }; comparison?: Comparison; compared?: RenderedComparison } {
    const rendered = this.compareView.lastRendered();
    return {
      ...(this.lastTag !== undefined ? { tag: this.lastTag } : {}),
      ...(this.lastComparison !== undefined ? { comparison: this.lastComparison } : {}),
      ...(rendered !== undefined ? { compared: rendered } : {}),
    };
  }

  /// Compare Query: run one query on two processes and show the answers
  /// side by side, the cells that differ marked. The code is one given, or
  /// the editor's selection or the statement at the cursor; each process
  /// one given (a label or a Processes row), or one picked.
  async compare(given?: string, first?: Row | string, second?: Row | string): Promise<void> {
    if (!featureOn(setting(readCompare).enabled, "Compare Query", "q-lint.query.compare.enable")) {
      return;
    }
    const code = typeof given === "string" ? given : await this.live.codeFromEditor();
    if (code === undefined) {
      return;
    }
    if (statements(code).length === 0) {
      void window.showInformationMessage("q-lint: the query is empty: it is blank or only comments.");
      return;
    }
    const a = await this.live.choose(first, "Compare Query (1 of 2): run it on which process?");
    if (a === undefined) {
      return;
    }
    const b = await this.live.choose(second, `Compare Query (2 of 2): and compare ${a.label} with which process?`);
    if (b === undefined) {
      return;
    }
    if (a.label === b.label) {
      void window.showInformationMessage(plainMessage(`q-lint: Compare Query compares two processes; ${a.label} was chosen twice.`));
      return;
    }
    if (!(await this.live.guardAllows(code, [a, b]))) {
      return;
    }
    const { outcomes } = await this.runEach([a, b], code, `q-lint: comparing ${a.label} and ${b.label}`);
    // Turned off while it ran: no panel opens after the off closed it.
    if (!setting(readCompare).enabled) {
      return;
    }
    const comparison = compareOutcomes(outcomes[0], outcomes[1], setting(readLive).gridDecimals);
    this.lastComparison = comparison;
    this.compareView.show(comparison, code);
  }

  /// Run `code` on each of `processes` over connections of their own, at
  /// most `AT_ONCE` at a time, with a cancellable notification; each run
  /// is recorded in the history. In the order given.
  private async runEach(processes: Process[], code: string, title: string): Promise<{ outcomes: Outcome[]; millis: number }> {
    const started = Date.now();
    const outcomes = await window.withProgress(
      { location: ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        const stop = new AbortController();
        const cancelled = token.onCancellationRequested(() => stop.abort());
        let done = 0;
        try {
          return await eachLimited(processes, AT_ONCE, async (process): Promise<Outcome> => {
            const at = Date.now();
            let outcome: Outcome;
            // Cancelled before its turn, or while it was still connecting:
            // never sent, so not recorded (#1629, #1926).
            let sent = !stop.signal.aborted;
            try {
              outcome = !sent ? { process: process.label, error: "cancelled" } : { process: process.label, answer: await this.live.runApart(process, code, stop.signal) };
            } catch (error) {
              sent = !(error instanceof NotSent);
              outcome = { process: process.label, error: sent ? message(error) : "cancelled" };
            }
            progress.report({ message: `${++done} of ${processes.length}`, increment: 100 / processes.length });
            if (!sent) {
              return outcome;
            }
            const failed = "error" in outcome ? outcome.error : outcome.answer.ok ? undefined : outcome.answer.error;
            await this.live.record({
              process: process.label,
              code,
              at: new Date(at).toISOString(),
              millis: Date.now() - at,
              outcome: failed === undefined ? "ok" : failed === "cancelled" ? "aborted" : "error",
              ...(failed !== undefined ? { error: failed } : {}),
            });
            return outcome;
          });
        } finally {
          cancelled.dispose();
        }
      },
    );
    return { outcomes, millis: Date.now() - started };
  }

  /// Query a Tag: run one query on every process carrying a tag, and show
  /// the answers as one table with a `process` column first. The tag is a
  /// tag row's, one given, or one picked; the code one given, or the
  /// editor's selection or the statement at the cursor.
  async queryTag(arg?: Row | string, given?: string): Promise<void> {
    if (!featureOn(setting(readTagQuery).enabled, "Query a Tag", "q-lint.query.tagQuery.enable")) {
      return;
    }
    const saved = this.live.processes();
    const discovered = this.live.discovery.discovered();
    let tag = typeof arg === "string" ? arg : arg?.kind === "tag" ? arg.tag : undefined;
    if (tag === undefined) {
      const tags = allTags(saved, discovered);
      if (tags.length === 0) {
        void window.showInformationMessage("q-lint: no q process carries a tag. Tag Process tags one.");
        return;
      }
      const picked = await window.showQuickPick(
        tags.map((t) => ({ label: iconsEscaped(t.tag), description: `${t.count} process${t.count === 1 ? "" : "es"}`, tag: t.tag })),
        { title: "Query a Tag: run the query on every process with which tag?" },
      );
      tag = picked?.tag;
    }
    if (tag === undefined) {
      return;
    }
    const processes = tagged(saved, discovered, tag);
    if (processes.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: no q process is tagged ${tag}.`));
      return;
    }
    const code = typeof given === "string" ? given : await this.live.codeFromEditor();
    if (code === undefined) {
      return;
    }
    if (statements(code).length === 0) {
      void window.showInformationMessage("q-lint: the query is empty: it is blank or only comments.");
      return;
    }
    if (!(await this.live.guardAllows(code, processes))) {
      return;
    }
    const { outcomes, millis } = await this.runEach(processes, code, `q-lint: querying ${processes.length} process${processes.length === 1 ? "" : "es"} tagged ${tag}`);
    const payload = mergeOutcomes(outcomes);
    this.lastTag = { tag, payload };
    this.live.showGrid(`tag ${tag}`, code, payload, millis);
    const failed = outcomes.filter((o) => "error" in o || !o.answer.ok).length;
    window.setStatusBarMessage(
      `q-lint: ${processes.length - failed} of ${processes.length} process${processes.length === 1 ? "" : "es"} tagged ${tag} answered`,
      5000,
    );
  }
}
