// Queries across processes: Query a Tag (#906), the VS Code around
// `tagquery.ts`. Each process is queried over a connection of its own
// (`Live.runApart`), so the active connection is left as it was, and each
// query lands in Query History under its process.
import { ProgressLocation, commands, window, workspace, type ExtensionContext } from "vscode";
import type { Row } from "./discovery";
import type { GridPayload } from "./grid";
import { iconsEscaped } from "./history";
import type { Live } from "./live";
import type { Process } from "./processes";
import { statements } from "./statements";
import { AT_ONCE, TAG_QUERY, allTags, mergeOutcomes, readTagQuery, tagged, type Outcome } from "./tagquery";

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
    void window.showInformationMessage(`q-lint: ${feature} is turned off. Set ${key} to true to turn it on.`);
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

  constructor(
    context: ExtensionContext,
    private readonly live: Live,
  ) {
    context.subscriptions.push(
      commands.registerCommand(TAG_QUERY.command, (tag?: Row | string, code?: string) => this.queryTag(tag, code)),
    );
  }

  state(): { tag?: { tag: string; payload: GridPayload } } {
    return { ...(this.lastTag !== undefined ? { tag: this.lastTag } : {}) };
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
            try {
              outcome = stop.signal.aborted ? { process: process.label, error: "cancelled" } : { process: process.label, answer: await this.live.runApart(process, code, stop.signal) };
            } catch (error) {
              outcome = { process: process.label, error: message(error) };
            }
            progress.report({ message: `${++done} of ${processes.length}`, increment: 100 / processes.length });
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
      void window.showInformationMessage(`q-lint: no q process is tagged ${tag}.`);
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
