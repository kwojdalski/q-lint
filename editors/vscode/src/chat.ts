// The @q chat participant (#952): explains q code or a q error in VS Code's
// chat, with what the language server and the connected process say about
// it. The VS Code around `assist.ts`.
//
// `@q <code>`, or `@q` with q code selected, explains the code: the prompt
// carries the language server's hovers on its names and its findings in the
// selection, and what the process holds for each name (`DESCRIBE`, which
// reads only). `@q /error` explains the last failed query in Query History,
// or the error typed after it. The model is the one the user picked in the
// chat, through `vscode.lm`: no key, no service of q-lint's own. It may call
// q-lint's tools - Run q Query among them, which VS Code asks the user to
// confirm, and which runs as every agent query runs - and nothing else here
// sends code to a process. Turned off (`q-lint.chat.participant.enable`),
// the participant is disposed, and a request already in the chat is
// answered that it is off.
import {
  LanguageModelChatMessage,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  Range,
  Uri,
  chat,
  commands,
  languages,
  lm,
  window,
  workspace,
  type CancellationToken,
  type ChatRequest,
  type ChatResponseStream,
  type ChatResult,
  type Disposable,
  type ExtensionContext,
  type LanguageModelChat,
  type LanguageModelChatTool,
  type TextDocument,
} from "vscode";
import { DESCRIBE, codeOffset, errorPrompt, explainPrompt, findingsIn, namesIn, readDescribed, type Described } from "./assist";
import { ASSIST_SETTINGS, assistOff, readAssist } from "./assistconfig";
import { charKinds } from "./explorer";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";

export const CHAT = { participant: "q-lint.q" } as const;
/// Rounds of tool calls a request makes at most, and hovers it reads.
const ROUNDS = 5;
const HOVERS = 8;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function on(): boolean {
  const configuration = workspace.getConfiguration("q-lint");
  return readAssist((key, fallback) => configuration.get(key, fallback)).chat;
}

/// The text of a hover's contents.
function hoverText(contents: unknown[]): string {
  return contents
    .map((c) => (typeof c === "string" ? c : typeof (c as { value?: unknown })?.value === "string" ? (c as { value: string }).value : ""))
    .filter((s) => s.trim() !== "")
    .join("\n")
    .trim();
}

export class QParticipant {
  constructor(private readonly live: Live) {}

  /// What the process holds for `names`; none when nothing is connected or
  /// it stays busy for a second, or when `expect` names a process other
  /// than the active one (#1377).
  private async describe(names: string[], expect?: string): Promise<Described[]> {
    if (names.length === 0 || this.live.activeLabel() === undefined) {
      return [];
    }
    try {
      const got = await borrowWhenFree(this.live, async (connection) => readDescribed(await connection.call(DESCRIBE, names.join(" "))), 1000, expect);
      return got?.value ?? [];
    } catch {
      return [];
    }
  }

  /// The language server's hovers on `names` in `document`'s `range`, and
  /// its findings there.
  private async fromServer(document: TextDocument, range: Range, names: string[]): Promise<{ hovers: { name: string; text: string }[]; diagnostics: string[] }> {
    const text = document.getText(range);
    const start = document.offsetAt(range.start);
    const hovers: { name: string; text: string }[] = [];
    const kinds = charKinds(text);
    for (const name of names.slice(0, HOVERS)) {
      const at = codeOffset(text, kinds, name);
      if (at < 0) {
        continue;
      }
      try {
        const found = (await commands.executeCommand<{ contents: unknown[] }[]>("vscode.executeHoverProvider", document.uri, document.positionAt(start + at))) ?? [];
        const said = found.map((h) => hoverText(h.contents ?? [])).filter((s) => s !== "").join("\n");
        if (said !== "") {
          hovers.push({ name, text: said });
        }
      } catch {
        // No server: the prompt goes without its hovers.
      }
    }
    return { hovers, diagnostics: findingsIn(languages.getDiagnostics?.(document.uri) ?? [], range) };
  }

  /// The prompt for `request`, or why there is none.
  async prompt(request: Pick<ChatRequest, "prompt" | "command">, stream?: Pick<ChatResponseStream, "progress">): Promise<{ prompt: string } | { refusal: string }> {
    const process = this.live.activeLabel();
    if (request.command === "error") {
      const typed = request.prompt.trim();
      const history = this.live.history();
      const entry = typed === "" ? history.find((h) => h.outcome === "error" && h.error !== undefined) : history.find((h) => h.error !== undefined && h.error.replace(/^'/, "") === typed.replace(/^'/, ""));
      if (typed === "" && entry === undefined) {
        return { refusal: "No query in Query History failed. Type the error after `/error`: `@q /error 'type`." };
      }
      const error = typed !== "" ? typed : (entry?.error as string);
      const code = entry?.code;
      stream?.progress(process === undefined ? "Explaining the error" : `Reading the names in the code from ${process}`);
      // Described on the process the query failed on, or not at all.
      const described = code === undefined ? [] : await this.describe(namesIn(code, charKinds(code)), entry?.process);
      return { prompt: errorPrompt({ error, ...(code !== undefined ? { code } : {}), ...(entry !== undefined ? { process: entry.process } : process !== undefined ? { process } : {}), described }, "") };
    }
    const editor = window.activeTextEditor;
    const selected = editor !== undefined && editor.document.languageId === "q" && !editor.selection.isEmpty ? editor : undefined;
    const typed = request.prompt.trim();
    const expression = typed !== "" ? typed : (selected?.document.getText(selected.selection) ?? "");
    if (expression.trim() === "") {
      return { refusal: "Select q code in an editor, or type it after `@q`: `@q 3#til 10`." };
    }
    const names = namesIn(expression, charKinds(expression));
    stream?.progress(process === undefined ? "Reading what the language server says" : `Reading the names in the code from ${process}`);
    // The server's hovers need the code in a file: the selection, when it is
    // what is explained.
    const server = typed === "" && selected !== undefined ? await this.fromServer(selected.document, selected.selection, names) : { hovers: [], diagnostics: [] };
    // Read from the process the prompt names, or not at all (#1621).
    const described = process === undefined ? [] : await this.describe(names, process);
    return { prompt: explainPrompt({ expression, ...(process !== undefined ? { process } : {}), ...server, described }, typed === "" ? "" : typed) };
  }

  async handle(request: ChatRequest, _context: unknown, stream: ChatResponseStream, token: CancellationToken): Promise<ChatResult> {
    if (!on()) {
      stream.markdown(assistOff("chat"));
      return { metadata: { refused: "off" } };
    }
    const asked = await this.prompt(request, stream);
    if ("refusal" in asked) {
      stream.markdown(asked.refusal);
      return { metadata: { refused: "nothing to explain" } };
    }
    const model: LanguageModelChat | undefined = request.model ?? (await lm.selectChatModels())[0];
    if (model === undefined) {
      stream.markdown("No language model is available. Sign in to an extension that provides one, such as GitHub Copilot.");
      return { metadata: { refused: "no model" } };
    }
    try {
      await converse(model, asked.prompt, stream, token, request.toolInvocationToken);
    } catch (error) {
      stream.markdown(`\n\nThe language model could not answer: ${message(error)}`);
      return { metadata: { command: request.command, error: message(error) } };
    }
    return { metadata: { command: request.command } };
  }
}

/// q-lint's own tools, which the model may call.
function qlintTools(): LanguageModelChatTool[] {
  const all = (lm as { tools?: readonly { name: string; description: string; inputSchema?: object }[] }).tools ?? [];
  return all.filter((t) => t.name.startsWith("q-lint_")).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/// Send `prompt` to `model` and stream its answer to `stream`, running the
/// tools it calls through `lm.invokeTool` - VS Code asks the user first
/// where a tool asks for it - for at most `ROUNDS` rounds.
export async function converse(
  model: LanguageModelChat,
  prompt: string,
  stream: Pick<ChatResponseStream, "markdown">,
  token: CancellationToken,
  toolInvocationToken?: ChatRequest["toolInvocationToken"],
): Promise<void> {
  const messages = [LanguageModelChatMessage.User(prompt)];
  const tools = typeof lm.invokeTool === "function" ? qlintTools() : [];
  for (let round = 0; round < ROUNDS; round++) {
    // The last round offers no tools: a call made in it would run with its
    // result never sent back (#1615).
    const last = round === ROUNDS - 1;
    // Turned off mid-request: nothing more is sent (#1632).
    if (round > 0 && !on()) {
      stream.markdown(`\n\n${assistOff("chat")}`);
      return;
    }
    const response = await model.sendRequest(messages, tools.length > 0 && !last ? { tools } : {}, token);
    const calls: LanguageModelToolCallPart[] = [];
    const said: LanguageModelTextPart[] = [];
    if (response.stream !== undefined) {
      for await (const part of response.stream) {
        if (part instanceof LanguageModelTextPart) {
          stream.markdown(part.value);
          said.push(part);
        } else if (part instanceof LanguageModelToolCallPart) {
          calls.push(part);
        }
      }
    } else {
      for await (const text of response.text) {
        stream.markdown(text);
      }
    }
    if (calls.length === 0 || token.isCancellationRequested) {
      return;
    }
    if (last) {
      stream.markdown(`\n\nStopped after ${ROUNDS} rounds of tool calls; the last round's were not run. Ask again to go on.`);
      return;
    }
    messages.push(LanguageModelChatMessage.Assistant([...said, ...calls]));
    for (const call of calls) {
      if (!on()) {
        stream.markdown(`\n\n${assistOff("chat")}`);
        return;
      }
      let content: unknown[];
      try {
        const result = await lm.invokeTool(call.name, { input: call.input, toolInvocationToken }, token);
        content = result.content;
      } catch (error) {
        content = [new LanguageModelTextPart(JSON.stringify({ error: message(error) }))];
      }
      messages.push(LanguageModelChatMessage.User([new LanguageModelToolResultPart(call.callId, content)]));
    }
  }
}

/// Register @q while `q-lint.chat.participant.enable` is on. Needs VS Code's
/// chat API; without it, nothing. Returns the participant, for tests.
export function registerChat(context: ExtensionContext, live: Live): { participant: QParticipant; registered: () => boolean } {
  const participant = new QParticipant(live);
  let registered: Disposable | undefined;
  const sync = (): void => {
    if (typeof chat?.createChatParticipant !== "function") {
      return;
    }
    if (on() && registered === undefined) {
      const p = chat.createChatParticipant(CHAT.participant, (request, ctx, stream, token) => participant.handle(request, ctx, stream, token));
      p.iconPath = Uri.joinPath(context.extensionUri, "icon.png");
      registered = p;
    } else if (!on() && registered !== undefined) {
      registered.dispose();
      registered = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`q-lint.${ASSIST_SETTINGS.chat.key}`)) {
        sync();
      }
    }),
    { dispose: () => registered?.dispose() },
  );
  return { participant, registered: () => registered !== undefined };
}
