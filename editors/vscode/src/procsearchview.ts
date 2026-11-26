// Find in Processes (#1046): search the function definitions - and, when
// asked, the variable names - of every process with a tag, and show the
// hits as a tree: process, then function, then each line. A line opens the
// function's live source, read again from that process, at that line, in a
// `q-lint-found:` document VS Code never lets one type into. Each process
// is searched over a connection of its own (`Live.callSeparate`), closed
// after, with one fixed read-only lambda (`procsearch.ts`), at most
// `AT_ONCE` at a time. Off (q-lint.processes.findInProcesses.enable), the
// view is gone, the commands refuse and nothing is sent.
import {
  EventEmitter,
  type CancellationToken,
  ProgressLocation,
  Range,
  Selection,
  TextEditorRevealType,
  Uri,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type TextDocumentContentProvider,
} from "vscode";
import type { Row } from "./discovery";
import { FUNCTION_TEXTS, readTexts } from "./fndiff";
import { callApart } from "./fndiffview";
import { readAdmin } from "./admin";
import { effectiveTimeout, timeoutSource } from "./processtimeout";
import { readControls } from "./querycontrols";
import type { Live } from "./live";
import type { Process } from "./processes";
import { SEARCH, SEARCH_LIMIT, groupHits, patternProblem, readFound, type Found } from "./procsearch";
import { PROCESS_TOOL_COMMANDS, toolOff, toolOn } from "./processtools";
import { AT_ONCE, allTags, tagged } from "./tagquery";
import { ToolTree, type ToolNode } from "./toolstree";
import { iconsEscaped, plainMessage } from "./history";
import { shownError } from "./tunnel";

export const FIND_VIEW = "q-lint.findInProcesses";
export const FOUND_SCHEME = "q-lint-found";

const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "findInProcesses");
// ssh's words for a tunnel that did not open are shown, not kept (#1721).
const message = shownError;

function say(text: string): string {
  void window.showInformationMessage(plainMessage(text));
  return text;
}

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

export type Outcome = { process: string; found: Found } | { process: string; error: string };

/// The search on `process` over a connection of its own, given up - the
/// connection dropped - after `seconds` (0: never) or when `token` is
/// cancelled: a process that never answers holds no other's hits (#2161).
function searchOne(live: Live, process: Process, args: unknown[], seconds: number, source: string, token: CancellationToken): Promise<unknown> {
  const cancelled = "cancelled before it answered";
  if (token.isCancellationRequested) {
    return Promise.reject(new Error(cancelled));
  }
  let giveUp: (why: string) => void = () => undefined;
  // Cancelled while it connects, too: then the connection is closed once
  // it opens, before its connect script runs, and nothing is sent (#2554).
  let over = false;
  const ended = new Promise<never>((_, reject) => (giveUp = (why) => ((over = true), reject(new Error(why)))));
  const timer = seconds > 0 ? setTimeout(() => giveUp(`did not answer within ${seconds} s (${source})`), seconds * 1000) : undefined;
  const listening = token.onCancellationRequested(() => giveUp(cancelled));
  const searched = live.callSeparate(
    process,
    (connection) => {
      if (over) {
        connection.abort();
        return ended;
      }
      void ended.catch(() => connection.abort());
      return Promise.race([connection.call(SEARCH, ...args), ended]);
    },
    () => over,
  );
  void searched.catch(() => undefined);
  return Promise.race([searched, ended]).finally(() => {
    clearTimeout(timer);
    listening.dispose();
  });
}

interface Place {
  process: string;
  name: string;
  line: number;
}

/// The tree: each process, its hits by name, each line.
export function foundTree(outcomes: Outcome[], text: string): ToolNode[] {
  return outcomes.map((o): ToolNode => {
    if ("error" in o) {
      return { label: o.process, description: `failed: ${o.error}`, icon: "error", tooltip: o.error };
    }
    const groups = groupHits(o.found.hits);
    return {
      label: o.process,
      description: `${o.found.hits.length}${o.found.more ? "+" : ""} hit${o.found.hits.length === 1 ? "" : "s"} in ${o.found.scanned} function${o.found.scanned === 1 ? "" : "s"}`,
      icon: "server",
      children:
        groups.length === 0
          ? [{ label: `no match for "${text}"`, icon: "circle-slash" }]
          : groups.map((g): ToolNode => {
              if (g.kind === "variable") {
                return { label: g.name, description: "variable", icon: "symbol-variable" };
              }
              const at = (line: number): Place => ({ process: o.process, name: g.name, line });
              return {
                label: g.name,
                description: `${g.hits.length} line${g.hits.length === 1 ? "" : "s"}`,
                icon: "symbol-function",
                command: { title: "Open Source", command: PROCESS_TOOL_COMMANDS.openFoundSource, arguments: [at(g.hits[0].line)] },
                children: g.hits.map((h) => ({
                  label: h.text.trim(),
                  description: `line ${h.line}`,
                  icon: "search",
                  command: { title: "Open Source", command: PROCESS_TOOL_COMMANDS.openFoundSource, arguments: [at(h.line)] },
                })),
              };
            }),
    };
  });
}

export function registerFindInProcesses(
  context: ExtensionContext,
  live: Live,
): {
  find: (tag?: Row | string, text?: string, variables?: boolean) => Promise<Outcome[] | string>;
  open: (place?: unknown) => Promise<string>;
  tree: () => ToolTree;
} {
  const tree = new ToolTree(context, FIND_VIEW, "findInProcesses");
  const documents = new Map<string, string>();
  const changed = new EventEmitter<Uri>();
  const provider: TextDocumentContentProvider = {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => documents.get(uri.toString()) ?? "/ not read; open it again from Find in Processes.\n",
  };
  /// The processes the last search ran on, by label, to open a hit from.
  let searched = new Map<string, Process>();

  const find = async (arg?: Row | string, given?: string, variables?: boolean): Promise<Outcome[] | string> => {
    if (!on()) {
      return say(toolOff("findInProcesses"));
    }
    const saved = live.processes();
    const discovered = live.discovery.discovered();
    let tag = typeof arg === "string" ? arg : arg?.kind === "tag" ? arg.tag : undefined;
    if (tag === undefined) {
      const tags = allTags(saved, discovered);
      if (tags.length === 0) {
        return say("q-lint: no q process carries a tag. Tag Process tags one.");
      }
      tag = (
        await window.showQuickPick(
          tags.map((t) => ({ label: iconsEscaped(t.tag), description: `${t.count} process${t.count === 1 ? "" : "es"}`, tag: t.tag })),
          { title: "Find in Processes: search every process with which tag?" },
        )
      )?.tag;
    }
    if (tag === undefined) {
      return "no tag";
    }
    const processes = tagged(saved, discovered, tag);
    if (processes.length === 0) {
      return say(`q-lint: no q process is tagged ${tag}.`);
    }
    const text =
      given ??
      (await window.showInputBox({ title: `Find in the ${processes.length} process${processes.length === 1 ? "" : "es"} tagged ${tag}`, prompt: "Text to find in function definitions; A to Z match in either case, other letters only as written.", validateInput: patternProblem }));
    if (text === undefined) {
      return "no text";
    }
    const problem = patternProblem(text);
    if (problem !== undefined) {
      return say(`q-lint: ${problem}.`);
    }
    const withVariables =
      variables ??
      (
        await window.showQuickPick(
          [
            { label: "Function definitions", vars: false },
            { label: "Function definitions and variable names", vars: true },
          ],
          { title: `Find "${text}" in` },
        )
      )?.vars;
    if (withVariables === undefined) {
      return "nothing picked";
    }
    // Turned off at the tag pick, the text box or this one: nothing is sent (#2005).
    if (!on()) {
      return say(toolOff("findInProcesses"));
    }
    // Each within q-lint.query.timeout, or its own (#2161).
    const configuration = workspace.getConfiguration("q-lint");
    const get = <T>(key: string, fallback: T): T => configuration.get(key, fallback);
    const own = readAdmin(get).processTimeout;
    const global = readControls(get).timeout;
    const outcomes = await window.withProgress(
      { location: ProgressLocation.Notification, title: `q-lint: finding "${text}" in ${processes.length} process${processes.length === 1 ? "" : "es"} tagged ${tag}`, cancellable: true },
      (_progress, token) =>
        eachLimited(processes, AT_ONCE, async (process): Promise<Outcome> => {
          try {
            const seconds = effectiveTimeout(process, global, own);
            return { process: process.label, found: readFound(await searchOne(live, process, [text, withVariables, SEARCH_LIMIT], seconds, timeoutSource(process, own), token)) };
          } catch (error) {
            return { process: process.label, error: message(error) };
          }
        }),
    );
    if (!on()) {
      return say(toolOff("findInProcesses"));
    }
    searched = new Map(processes.map((p) => [p.label, p]));
    const hits = outcomes.reduce((n, o) => n + ("found" in o ? o.found.hits.length : 0), 0);
    tree.show(foundTree(outcomes, text), `"${text}" in tag ${tag}: ${hits} hit${hits === 1 ? "" : "s"}.`);
    await tree.reveal();
    return outcomes;
  };

  const open = async (arg?: unknown): Promise<string> => {
    if (!on()) {
      return say(toolOff("findInProcesses"));
    }
    const place = arg as Place | undefined;
    const process = place === undefined ? undefined : searched.get(place.process);
    if (place === undefined || process === undefined) {
      return "nothing to open";
    }
    let text: string | undefined;
    try {
      text = readTexts(await callApart(live, process, FUNCTION_TEXTS, place.name)).texts.get(place.name);
    } catch (error) {
      return say(`q-lint: could not read ${place.name} from ${place.process}: ${message(error)}`);
    }
    if (text === undefined) {
      return say(`q-lint: ${place.name} is no longer a function on ${place.process}.`);
    }
    const uri = Uri.from({ scheme: FOUND_SCHEME, path: `/${place.process}/${place.name}.q`, query: place.process });
    documents.set(uri.toString(), text.endsWith("\n") ? text : `${text}\n`);
    changed.fire(uri);
    const editor = await window.showTextDocument(await workspace.openTextDocument(uri), { preview: true });
    const line = Math.max(0, place.line - 1);
    editor.selection = new Selection(line, 0, line, 0);
    editor.revealRange(new Range(line, 0, line, 0), TextEditorRevealType.InCenterIfOutsideViewport);
    return text;
  };

  context.subscriptions.push(
    changed,
    workspace.registerTextDocumentContentProvider(FOUND_SCHEME, provider),
    workspace.onDidCloseTextDocument((d) => void (d.uri.scheme === FOUND_SCHEME && documents.delete(d.uri.toString()))),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.findInProcesses, (tag?: Row | string, text?: unknown, variables?: unknown) =>
      find(tag, typeof text === "string" ? text : undefined, typeof variables === "boolean" ? variables : undefined),
    ),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.openFoundSource, open),
  );
  return { find, open, tree: () => tree };
}
