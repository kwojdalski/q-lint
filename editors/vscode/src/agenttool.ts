// The language-model tool (#886) and Copy Label for Agent Query: the VS Code
// around `agent.ts`. An agent's query runs on the active connection as a
// notebook cell's does - the status bar shows it, Abort Current Query stops
// it - and goes into Query History marked as the agent's.
import {
  commands,
  env,
  LanguageModelTextPart,
  LanguageModelToolResult,
  lm,
  MarkdownString,
  window,
  workspace,
  type CancellationToken,
  type ExtensionContext,
  type LanguageModelTool,
  type LanguageModelToolInvocationOptions,
  type LanguageModelToolInvocationPrepareOptions,
  type PreparedToolInvocation,
} from "vscode";
import {
  AGENT,
  confirmation,
  notConnected,
  readAgent,
  resolveProcess,
  rowLabel,
  runAgentQuery,
  type AgentInput,
  type AgentResult,
} from "./agent";
import type { Row } from "./discovery";
import type { Live } from "./live";
import { readLive } from "./liveconfig";
import type { Process } from "./processes";
import { statements } from "./statements";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/// A call as `prepareInvocation` and `invoke` both see it: each is handed
/// its own copy of the input.
const callKey = (input: AgentInput): string => JSON.stringify([input.query ?? "", input.process?.trim() ?? ""]);

class RunQueryTool implements LanguageModelTool<AgentInput> {
  /// The process the user was asked to run each prepared call on. The
  /// active connection can change while the question is open, and a call
  /// that names no process runs on whichever is active then.
  private readonly asked = new Map<string, string>();

  constructor(private readonly live: Live) {}

  /// The process `input` names, or the active one; with whether q-lint
  /// connects to it first. An error when there is neither.
  private target(input: AgentInput): { process: Process; connects: boolean } | { error: string } {
    const saved = this.live.processes();
    const discovered = this.live.discovery.discovered();
    const active = this.live.activeLabel();
    const named = input.process?.trim();
    if (named) {
      const found = resolveProcess(named, saved, discovered);
      return "error" in found ? found : { process: found.process, connects: found.process.label !== active };
    }
    const process = this.live.activeProcess();
    return process === undefined ? { error: notConnected(saved, discovered) } : { process, connects: false };
  }

  /// What the user is asked before `input` runs; undefined when it will
  /// not run, and the call answers with why.
  confirm(input: AgentInput): { title: string; message: string; process: string } | undefined {
    const target = this.target(input);
    if ("error" in target) {
      return undefined;
    }
    const active = this.live.activeLabel();
    const asked = confirmation(input.query ?? "", target.process, {
      connects: target.connects,
      ...(target.connects && active !== undefined ? { replaces: active } : {}),
    });
    return { ...asked, process: target.process.label };
  }

  prepareInvocation(options: LanguageModelToolInvocationPrepareOptions<AgentInput>): PreparedToolInvocation {
    const asked = this.confirm(options.input);
    if (asked === undefined) {
      return { invocationMessage: "Running a q query" };
    }
    this.asked.delete(callKey(options.input));
    this.asked.set(callKey(options.input), asked.process);
    // Calls asked about and never run are forgotten, oldest first.
    for (const key of [...this.asked.keys()].slice(0, -20)) {
      this.asked.delete(key);
    }
    return {
      invocationMessage: `Running a q query on ${asked.process}`,
      confirmationMessages: { title: asked.title, message: new MarkdownString(asked.message) },
    };
  }

  async invoke(options: LanguageModelToolInvocationOptions<AgentInput>, token: CancellationToken): Promise<LanguageModelToolResult> {
    const result = await this.run(options.input, token);
    return new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(result))]);
  }

  /// Run the query `input` asks for, and answer with what the agent is given.
  async run(input: AgentInput, token: CancellationToken): Promise<AgentResult> {
    const code = typeof input.query === "string" ? input.query : "";
    if (statements(code).length === 0) {
      return { error: "The query is empty: it is blank or only comments." };
    }
    const target = this.target(input);
    if ("error" in target) {
      return target;
    }
    const { process } = target;
    const shown = this.asked.get(callKey(input));
    this.asked.delete(callKey(input));
    if (shown !== undefined && shown !== process.label) {
      return { error: `Nothing was run: the user was asked to run it on ${shown}, and it would now run on ${process.label}. Ask again.` };
    }
    if (target.connects && !(await this.live.connectTo(process.label))) {
      return { error: `Could not connect to ${process.label} (${process.host}:${process.port}); q-lint showed the user why.` };
    }
    if (token.isCancellationRequested) {
      return { error: "The query was cancelled before it ran." };
    }
    const configuration = workspace.getConfiguration("q-lint");
    const get = <T>(key: string, fallback: T): T => configuration.get(key, fallback);
    const settings = readLive(get);
    const { queryTimeout } = readAgent(get);
    const started = Date.now();
    // Why the query was stopped, if it was: q has no message that cancels a
    // query, so either way it is aborted as Abort Current Query aborts one.
    // One stopped while it still waits for the connection - behind the
    // Process Explorer's read of the process - is never sent.
    let stopped: "timeout" | "cancelled" | undefined;
    let running = false;
    const stop = (why: "timeout" | "cancelled"): void => {
      if (stopped === undefined) {
        stopped = why;
        if (running) {
          void this.live.abort();
        }
      }
    };
    const timer = queryTimeout > 0 ? setTimeout(() => stop("timeout"), queryTimeout * 1000) : undefined;
    const cancelled = token.onCancellationRequested(() => stop("cancelled"));
    let result: AgentResult;
    let outcome: "ok" | "error" | "aborted";
    let label = process.label;
    try {
      const ran = await this.live.runOnActive(code, (connection) => {
        if (stopped !== undefined) {
          throw new Error("not run");
        }
        // The connection can change while the query waits for it.
        const now = this.live.activeLabel();
        if (now !== process.label) {
          throw new Error(`Nothing was run: the active connection moved from ${process.label} to ${now ?? "none"} before the query could start. Ask again.`);
        }
        running = true;
        return runAgentQuery(connection, code, settings.consoleSize);
      });
      if (ran === undefined) {
        return { error: `Nothing was run: a query is still running on ${process.label}, or the connection closed. Try again once it is free.` };
      }
      label = ran.process;
      result = ran.value;
      outcome = "error" in result ? "error" : "ok";
    } catch (error) {
      outcome = stopped !== undefined ? "aborted" : "error";
      result = {
        error:
          stopped !== undefined && !running
            ? stopped === "timeout"
              ? `The query waited longer than ${queryTimeout} s (q-lint.agent.queryTimeout) for ${label} to be free, and was not run.`
              : "The query was cancelled before it ran."
            : stopped === "timeout"
              ? `The query ran longer than ${queryTimeout} s (q-lint.agent.queryTimeout) and was aborted, as Abort Current Query aborts one. ` +
                `${label} may still be running it; q-lint reconnects once it is free.`
              : stopped === "cancelled"
                ? `The query was cancelled and aborted. ${label} may still be running it; q-lint reconnects once it is free.`
                : message(error),
      };
    } finally {
      clearTimeout(timer);
      cancelled.dispose();
    }
    await this.live.record({
      process: label,
      code,
      at: new Date(started).toISOString(),
      millis: Date.now() - started,
      outcome,
      ...("error" in result ? { error: stopped === "timeout" ? "timed out" : stopped === "cancelled" ? "cancelled" : result.error } : {}),
      agent: true,
    });
    return result;
  }
}

/// Copy the label an agent's query names a process by: a view row's, a
/// label given, or the active connection's.
async function copyLabel(live: Live, row?: Row | string): Promise<void> {
  const label = typeof row === "string" ? row : (rowLabel(row) ?? live.activeLabel());
  if (label === undefined) {
    void window.showInformationMessage("q-lint: not connected to a q process. Copy Label for Agent Query copies a process row's label.");
    return;
  }
  await env.clipboard.writeText(label);
  window.setStatusBarMessage(`q-lint: copied "${label}"`, 3000);
}

/// Register the tool and Copy Label for Agent Query. The tool needs VS Code
/// 1.95's `lm.registerTool`; before it, only the command is there. Returns
/// what the tool asks the user before a query, for the read-only API.
export function registerAgentTool(context: ExtensionContext, live: Live): RunQueryTool["confirm"] {
  const tool = new RunQueryTool(live);
  context.subscriptions.push(commands.registerCommand(AGENT.copyLabel, (row?: Row | string) => copyLabel(live, row)));
  if (typeof lm?.registerTool === "function") {
    context.subscriptions.push(lm.registerTool(AGENT.tool, tool));
  }
  return (input) => tool.confirm(input);
}
