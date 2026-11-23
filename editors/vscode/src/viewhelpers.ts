// `.qlint.view` and `.qlint.plot` in the editor (#960): the command that
// defines them on the connected process, the definition on connect while
// q-lint.view.defineOnConnect is on (off by default), and the listener that
// opens what a call sends in the result grid or as a chart. Off
// (q-lint.view.enable), the listener is removed - a call on the process
// then only gives its value back - and nothing is defined.
import { commands, window, workspace, type Disposable, type ExtensionContext } from "vscode";
import { INTERACTIVE_COMMANDS, readInteractive, turnedOff } from "./interactiveconfig";
import type { Live } from "./live";
import { readLive } from "./liveconfig";
import { readViewMessage, viewDefinition, type ViewKind } from "./qview";
import { statements } from "./statements";
import { plainMessage } from "./history";

const settings = () => readInteractive((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback));
const VIEW_OFF = turnedOff(".qlint.view and .qlint.plot", "q-lint.view.enable");

export function registerViewHelpers(
  context: ExtensionContext,
  live: Live,
): {
  listening: () => boolean;
  /// What calls have opened, newest last.
  shown: () => { kind: ViewKind; process: string; rows: number }[];
  define: (quiet?: boolean) => Promise<boolean>;
} {
  let listener: Disposable | undefined;
  const shown: { kind: ViewKind; process: string; rows: number }[] = [];

  const sync = (): void => {
    const on = settings().view;
    if (on && listener === undefined) {
      listener = live.onAsyncMessage((message, process) => {
        const read = readViewMessage(message);
        if (read === undefined) {
          return;
        }
        const { kind, answer } = read;
        const name = `.qlint.${kind}`;
        if (!answer.ok) {
          void window.showWarningMessage(plainMessage(`q-lint: ${name} on ${process.label} failed: '${answer.error}`));
        } else if (answer.gridError !== undefined) {
          void window.showWarningMessage(plainMessage(`q-lint: ${name} on ${process.label} could not shape the value: '${answer.gridError}`));
        } else if (answer.grid === undefined) {
          void window.showInformationMessage(
            plainMessage(`q-lint: ${name} on ${process.label} was given an atom, a string or a function, which has no rows to show: ${answer.text.join(" ").slice(0, 200)}`),
          );
        } else {
          shown.push({ kind, process: process.label, rows: answer.grid.count });
          live.showGrid(process.label, name, answer.grid, 0, kind === "plot" ? "chart" : "grid");
        }
      });
    } else if (!on && listener !== undefined) {
      listener.dispose();
      listener = undefined;
    }
  };

  /// Define the two on the connected process (connecting first if none is),
  /// through the read-only guard: asked, or with `quiet` (on connect)
  /// refused outright on a guarded process. True when they were defined.
  const define = async (quiet = false): Promise<boolean> => {
    if (!settings().view) {
      if (!quiet) {
        void window.showInformationMessage(VIEW_OFF);
      }
      return false;
    }
    const configuration = workspace.getConfiguration("q-lint");
    const { consoleSize, gridLimit } = readLive((key, fallback) => configuration.get(key, fallback));
    const code = viewDefinition(consoleSize, gridLimit);
    try {
      const ran = await live.runOnActive(code, (connection) => connection.query(statements(code), consoleSize), quiet ? "refuse" : "ask");
      if (ran === undefined) {
        return false;
      }
      if (!ran.value.ok) {
        void window.showErrorMessage(plainMessage(`q-lint: could not define .qlint.view and .qlint.plot on ${ran.process}: '${ran.value.error}`));
        return false;
      }
      if (!quiet) {
        void window.showInformationMessage(plainMessage(`q-lint: .qlint.view and .qlint.plot are defined on ${ran.process}: \`.qlint.view t\` opens t in the grid, \`.qlint.plot t\` as a chart.`));
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void window.showInformationMessage(plainMessage(`q-lint: .qlint.view and .qlint.plot were not defined: ${message}`));
      return false;
    }
  };

  sync();
  context.subscriptions.push(
    commands.registerCommand(INTERACTIVE_COMMANDS.defineView, () => define()),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("q-lint.view")) {
        sync();
      }
    }),
    live.onDidChange((what) => {
      const s = settings();
      if (what === "connected" && s.view && s.defineViewOnConnect) {
        void define(true);
      }
    }),
    { dispose: () => listener?.dispose() },
  );
  return { listening: () => listener !== undefined, shown: () => [...shown], define };
}
