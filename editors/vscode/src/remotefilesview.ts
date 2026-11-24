// The Process Files view (#1044): the q host's directories, read through
// the connected process, and its files opened read-only. Browse Files
// starts it at the process's working directory, or a path typed; each
// directory is read when it is expanded, and a file when it is opened -
// its first `FILE_LIMIT` bytes only - into a `q-lint-remote:` document,
// which VS Code never lets one type into. Every read is a fixed read-only
// lambda (`remotefiles.ts`) through `borrowWhenFree`, as the Process
// Explorer reads. Off (q-lint.processes.fileBrowser.enable), the view is
// gone, its commands refuse and nothing is sent.
import { EventEmitter, Uri, commands, window, workspace, type ExtensionContext, type TextDocumentContentProvider } from "vscode";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { PROCESS_TOOL_COMMANDS, bytesText, toolOff, toolOn } from "./processtools";
import { FILE_LIMIT, LIST_DIRECTORY, LIST_LIMIT, READ_FILE, WORKING_DIRECTORY, fileDocument, joinPath, readFileHead, readListing } from "./remotefiles";
import { ToolTree, type ToolNode } from "./toolstree";
import { plainMessage } from "./history";

export const FILES_VIEW = "q-lint.processFiles";
export const REMOTE_SCHEME = "q-lint-remote";

const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "fileBrowser");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function say(text: string): string {
  void window.showInformationMessage(plainMessage(text));
  return text;
}

interface Place {
  process: string;
  path: string;
}

export function registerFileBrowser(
  context: ExtensionContext,
  live: Live,
): { browse: (path?: string) => Promise<ToolNode[] | string>; open: (arg?: unknown) => Promise<string>; tree: () => ToolTree } {
  const tree = new ToolTree(context, FILES_VIEW, "fileBrowser");
  const documents = new Map<string, string>();
  const changed = new EventEmitter<Uri>();
  const provider: TextDocumentContentProvider = {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => documents.get(uri.toString()) ?? `/ ${uri.path}: not read; open it again from Process Files.\n`,
  };

  /// A read on the connected process, when it is still `process`.
  const read = async <T>(process: string, use: (call: (f: string, ...args: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> => {
    if (!on()) {
      throw new Error(toolOff("fileBrowser"));
    }
    if (live.activeLabel() !== process) {
      throw new Error(`these files are ${process}'s, and it is no longer the connected process: Browse Files again`);
    }
    // Still `process` once a busy connection is free (#1457).
    const got = await borrowWhenFree(live, (connection) => use((f, ...args) => connection.call(f, ...args)), undefined, process);
    if (got === undefined) {
      throw new Error("the process is busy with a query; try again once it ends");
    }
    return got.value;
  };

  const directory = (place: Place, label: string): ToolNode => ({
    label,
    tooltip: `${place.path} on ${place.process}`,
    icon: "folder",
    contextValue: "processDirectory",
    data: place,
    load: async () => {
      const listing = readListing(await read(place.process, (call) => call(LIST_DIRECTORY, place.path, LIST_LIMIT)));
      const rows = listing.entries.map((e): ToolNode => {
        const at = { process: place.process, path: joinPath(place.path, e.name) };
        return e.file
          ? {
              label: e.name,
              description: e.size === -2 ? "unreadable" : bytesText(e.size),
              tooltip: `${at.path} on ${at.process}`,
              icon: "file",
              contextValue: "processFile",
              data: at,
              command: { title: "Open", command: PROCESS_TOOL_COMMANDS.openProcessFile, arguments: [at] },
            }
          : directory(at, e.name);
      });
      if (listing.total > listing.entries.length) {
        rows.push({ label: `${listing.total - listing.entries.length} more not listed`, icon: "ellipsis", tooltip: `Only the first ${LIST_LIMIT} entries of a directory are listed.` });
      }
      return rows.length === 0 ? [{ label: "empty", icon: "circle-slash" }] : rows;
    },
  });

  const browse = async (path?: string): Promise<ToolNode[] | string> => {
    if (!on()) {
      return say(toolOff("fileBrowser"));
    }
    const process = live.activeLabel();
    if (process === undefined) {
      return say("q-lint: not connected to a q process; connect to one to browse its files.");
    }
    let start = path;
    try {
      if (start === undefined) {
        const cwd = await read(process, (call) => call(WORKING_DIRECTORY, 0));
        start = typeof cwd === "string" ? cwd : "/";
      }
      const root = directory({ process, path: start }, start);
      root.children = await root.load!();
      tree.show([root], `${process}: ${start}`);
      await tree.reveal();
      return [root];
    } catch (error) {
      return say(`q-lint: could not list ${start ?? "the working directory"} on ${process}: ${message(error)}`);
    }
  };

  const open = async (arg?: unknown): Promise<string> => {
    if (!on()) {
      return say(toolOff("fileBrowser"));
    }
    const place = ((arg as ToolNode | undefined)?.data ?? arg) as Place | undefined;
    if (place === undefined || typeof place.path !== "string" || typeof place.process !== "string") {
      return "no file";
    }
    let text: string;
    try {
      const head = readFileHead(await read(place.process, (call) => call(READ_FILE, place.path, FILE_LIMIT)));
      text = fileDocument(place.path, place.process, head);
    } catch (error) {
      return say(`q-lint: could not read ${place.path} on ${place.process}: ${message(error)}`);
    }
    const uri = Uri.from({ scheme: REMOTE_SCHEME, path: place.path.startsWith("/") ? place.path : `/${place.path}`, query: place.process });
    documents.set(uri.toString(), text);
    changed.fire(uri);
    await window.showTextDocument(await workspace.openTextDocument(uri), { preview: true });
    return text;
  };

  context.subscriptions.push(
    changed,
    workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, provider),
    workspace.onDidCloseTextDocument((d) => void (d.uri.scheme === REMOTE_SCHEME && documents.delete(d.uri.toString()))),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.browseFiles, async (arg?: unknown) => {
      if (!on()) {
        return say(toolOff("fileBrowser"));
      }
      if (typeof arg === "string") {
        return browse(arg);
      }
      const typed = await window.showInputBox({
        title: "Browse which directory on the q host?",
        prompt: "A path as the host spells it: /data/hdb. Empty: the process's working directory.",
      });
      return typed === undefined ? "no path" : browse(typed.trim() === "" ? undefined : typed.trim());
    }),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.openProcessFile, open),
  );
  return { browse, open, tree: () => tree };
}
