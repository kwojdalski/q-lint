// The q task provider (#978): **run current file** and one **test** task
// per test runner script, under Terminal > Run Task > q, and `q` tasks
// written in tasks.json. Each runs `q-lint.terminal.qBinary` on its script
// with nothing on its input, so q exits when the script ends - 0 if it
// loaded, 1 at its first error - and the `$q` problem matcher puts that
// error, with its file and line, in Problems. The variables are those a q
// terminal gets (`qenvironment.ts`), given to q directly, so none shows.
// Registered only while q-lint.tasks.enable is on.
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CustomExecution,
  EventEmitter,
  RelativePattern,
  Task,
  TaskGroup,
  TaskScope,
  tasks,
  workspace,
  type Disposable,
  type ExtensionContext,
  type Pseudoterminal,
  type TaskDefinition,
  type WorkspaceFolder,
} from "vscode";
import { readTerminal } from "./liveconfig";
import { mergeEnv } from "./qenv";
import { onPath } from "./relations";
import { dotenvFor, layoutEnvFor } from "./qenvironment";
import { EXCLUDE, TASK_TYPE, TEST_RUNNERS, detectedTasks, readTaskDefinition, readTasks, taskPaths, terminalText, type QTaskDefinition } from "./tasks";
import { expandHome, qBinaryFrom } from "./terminal";

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const on = (): boolean => readTasks((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).enabled;

/// A pseudoterminal that runs q on `definition`'s script in `folder`.
function runner(definition: QTaskDefinition, folder: WorkspaceFolder | undefined): Pseudoterminal {
  const write = new EventEmitter<string>();
  const close = new EventEmitter<number>();
  let child: ChildProcess | undefined;
  let closed = false;
  return {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: () => {
      void (async () => {
        const configuration = workspace.getConfiguration("q-lint", folder?.uri);
        const first = workspace.workspaceFolders?.[0]?.uri.fsPath;
        // A relative q is the task's folder's, else the first folder's, as a
        // terminal's is - not under a workspace task's script directory (#1840).
        const qBinary = readTerminal((key, fallback) => configuration.get(key, fallback)).qBinary;
        const binary = qBinaryFrom(qBinary, folder?.uri.fsPath ?? first, os.homedir()) ?? expandHome(qBinary, os.homedir());
        const paths = taskPaths(expandHome(definition.script, os.homedir()), folder?.uri.fsPath, first);
        if (paths === undefined) {
          write.fire(terminalText(`the script ${definition.script} is relative, and there is no workspace folder to find it in\n`));
          close.fire(1);
          return;
        }
        const { cwd, script } = paths;
        const env = mergeEnv(layoutEnvFor(binary, folder?.uri), await dotenvFor(folder?.uri));
        // Closed while the variables were read: q is not started (#1085).
        if (closed) {
          return;
        }
        const args = [script, ...(definition.args ?? [])];
        write.fire(terminalText(`> ${[binary, ...args].join(" ")}\n`));
        // A bare name is looked up on PATH here: on Windows, spawn with a
        // cwd would run a q.exe the folder holds first (#1605).
        const command = onPath(binary, env.PATH ?? process.env.PATH, isFile);
        if (command === undefined) {
          write.fire(terminalText(`could not start ${binary}: it is not on PATH\n`));
          close.fire(1);
          return;
        }
        try {
          child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        } catch (error) {
          write.fire(terminalText(`could not start ${binary}: ${error instanceof Error ? error.message : String(error)}\n`));
          close.fire(1);
          return;
        }
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (text: string) => write.fire(terminalText(text)));
        child.stderr?.on("data", (text: string) => write.fire(terminalText(text)));
        child.once("error", (error) => {
          write.fire(terminalText(`could not start ${binary}: ${error.message}\n`));
          close.fire(1);
        });
        child.once("close", (code) => close.fire(code ?? 1));
      })();
    },
    close: () => {
      closed = true;
      child?.kill();
    },
  };
}

/// The task for `definition`, named `label`, in `folder`.
export function qTask(definition: QTaskDefinition, label: string, folder: WorkspaceFolder | undefined, test = false): Task {
  const task = new Task(
    definition as TaskDefinition,
    folder ?? TaskScope.Workspace,
    label,
    TASK_TYPE,
    // Called with the definition's variables (`${file}`) resolved.
    new CustomExecution(async (resolved) => runner(readTaskDefinition(resolved) ?? definition, folder)),
    ["$q"],
  );
  if (test) {
    task.group = TaskGroup.Test;
  }
  return task;
}

/// The tasks detected in the workspace's folders.
export async function provideQTasks(): Promise<Task[]> {
  if (!on()) {
    return [];
  }
  const found: Task[] = [];
  const folders = workspace.workspaceFolders ?? [];
  for (const folder of folders.length > 0 ? folders : [undefined]) {
    const runners =
      folder === undefined
        ? []
        : (await workspace.findFiles(new RelativePattern(folder, TEST_RUNNERS), EXCLUDE, 50)).map((uri) => path.relative(folder.uri.fsPath, uri.fsPath));
    for (const d of detectedTasks(runners)) {
      found.push(qTask(d.definition, d.label, folder, d.test));
    }
  }
  return found;
}

/// Register the provider while q-lint.tasks.enable is on.
export function registerTasks(context: ExtensionContext): { registered: () => boolean } {
  let provider: Disposable | undefined;
  const sync = (): void => {
    if (on() && provider === undefined) {
      provider = tasks.registerTaskProvider(TASK_TYPE, {
        provideTasks: () => provideQTasks(),
        resolveTask: (task) => {
          const definition = readTaskDefinition(task.definition);
          if (!on() || definition === undefined) {
            return undefined;
          }
          const folder = typeof task.scope === "object" ? (task.scope as WorkspaceFolder) : undefined;
          return qTask(definition, task.name, folder);
        },
      });
    } else if (!on() && provider !== undefined) {
      provider.dispose();
      provider = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.tasks") && sync()),
    { dispose: () => provider?.dispose() },
  );
  return { registered: () => provider !== undefined };
}
