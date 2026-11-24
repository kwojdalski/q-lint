// Clickable q backtraces (#983): a frame's `file:line` in the **q-lint:
// query** output (and any output channel, such as a launched process's) and
// in a terminal is a link to the line that failed. A frame with no file but
// a name - a function sent over IPC - links to where the workspace defines
// that name. `backtrace.ts` reads the frames.
//
// The file is the path the process printed when it exists here; otherwise
// the workspace file sharing the most trailing path segments with it, as a
// process on another machine prints its own paths. The target is worked out
// when the link is clicked, not as the output is drawn. Nothing is
// registered while q-lint.backtraceLinks.enable is off.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  DocumentLink,
  Range,
  Uri,
  commands,
  languages,
  window,
  workspace,
  type CancellationToken,
  type DocumentLinkProvider,
  type ExtensionContext,
  type SymbolInformation,
  type TerminalLink,
  type TextDocument,
} from "vscode";
import { bestSuffixMatch, failedAt, headerLink, parseBacktrace, type Frame } from "./backtrace";
import { editorFeatureOn } from "./editorfeatures";
import { globLiteral } from "./globliteral";
import { plainMessage } from "./history";

const on = (): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "backtraceLinks");

/// The file a printed path names here, or undefined when none does.
export async function localFile(path: string): Promise<Uri | undefined> {
  if (isAbsolute(path) && existsSync(path)) {
    return Uri.file(path);
  }
  const base = path.split(/[\\/]/).pop();
  if (base === undefined || base === "") {
    return undefined;
  }
  const found = await workspace.findFiles(`**/${globLiteral(base)}`, "**/node_modules/**", 50);
  const best = bestSuffixMatch(
    path,
    found.map((u) => u.fsPath),
  );
  return best === undefined ? undefined : found.find((u) => u.fsPath === best);
}

async function text(uri: Uri): Promise<string | undefined> {
  try {
    return uri.scheme === "file" ? readFileSync(uri.fsPath, "utf8") : Buffer.from(await workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return undefined;
  }
}

/// Where a frame points: the file and the line that failed in it, or where
/// the workspace defines its name.
export async function frameTarget(frame: Frame): Promise<{ uri: Uri; line: number; character: number } | undefined> {
  if (frame.file !== undefined) {
    const uri = await localFile(frame.file);
    return uri === undefined ? undefined : { uri, ...failedAt(frame, await text(uri)) };
  }
  if (frame.name === undefined) {
    return undefined;
  }
  const symbols = ((await commands.executeCommand("vscode.executeWorkspaceSymbolProvider", frame.name)) ?? []) as SymbolInformation[];
  const name = frame.name;
  const found =
    symbols.find((s) => s.name === name) ??
    symbols.find((s) => s.containerName !== "" && [`${s.containerName}.${s.name}`, `.${s.containerName}.${s.name}`].includes(name));
  return found === undefined ? undefined : { uri: found.location.uri, line: found.location.range.start.line, character: found.location.range.start.character };
}

/// The URI a link opens: the file at the line, as `#L12,5`.
const at = (target: { uri: Uri; line: number; character: number }): Uri => target.uri.with({ fragment: `L${target.line + 1},${target.character + 1}` });

class FrameLink extends DocumentLink {
  constructor(
    range: Range,
    readonly frame: Frame,
  ) {
    super(range);
    this.tooltip = frame.file !== undefined ? "Open the line that failed" : `Open the definition of ${frame.name}`;
  }
}

export class BacktraceLinks implements DocumentLinkProvider<FrameLink> {
  provideDocumentLinks(document: TextDocument): FrameLink[] {
    const links: FrameLink[] = [];
    for (const frame of parseBacktrace(document.getText())) {
      if (frame.span !== undefined) {
        links.push(new FrameLink(new Range(frame.at, frame.span.start, frame.at, frame.span.end), frame));
      } else if (frame.name !== undefined) {
        const line = document.lineAt(frame.at).text;
        const start = line.indexOf(frame.code[0]);
        links.push(new FrameLink(new Range(frame.at, start, frame.at, start + frame.name.length), frame));
      }
    }
    return links;
  }

  async resolveDocumentLink(link: FrameLink, _token?: CancellationToken): Promise<FrameLink> {
    const target = await frameTarget(link.frame);
    if (target !== undefined) {
      link.target = at(target);
    }
    return link;
  }
}

/// Register the links while q-lint.backtraceLinks.enable is on.
export function registerBacktraceLinks(context: ExtensionContext): { registered: () => boolean } {
  let registered: { dispose(): unknown }[] | undefined;
  const sync = (): void => {
    if (on() && registered === undefined) {
      registered = [
        languages.registerDocumentLinkProvider([{ scheme: "output" }, { language: "q-console" }], new BacktraceLinks()),
        window.registerTerminalLinkProvider({
          provideTerminalLinks: (context: { line: string }): (TerminalLink & { file: string; at: number })[] => {
            const link = headerLink(context.line);
            return link === undefined ? [] : [{ startIndex: link.start, length: link.length, tooltip: "Open the line", file: link.file, at: link.line }];
          },
          handleTerminalLink: async (link: TerminalLink & { file: string; at: number }) => {
            const uri = await localFile(link.file);
            if (uri === undefined) {
              void window.showInformationMessage(plainMessage(`q-lint: ${link.file} is not in this workspace.`));
              return;
            }
            await window.showTextDocument(uri, { selection: new Range(link.at - 1, 0, link.at - 1, 0) });
          },
        }),
      ];
    } else if (!on() && registered !== undefined) {
      for (const d of registered) {
        d.dispose();
      }
      registered = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.backtraceLinks") && sync()),
    { dispose: () => registered?.forEach((d) => d.dispose()) },
  );
  return { registered: () => registered !== undefined };
}
