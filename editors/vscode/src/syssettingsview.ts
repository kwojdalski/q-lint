// The System Settings view (#1043): the connected process's `\c`, `\s`,
// `\P`, `\T`, `\g`, `\o`, `\z` and `\w`, each with what it does, read
// when Refresh is pressed with one read-only lambda (`syssettings.ts`)
// through `borrowWhenFree`, as the Process Explorer reads.
//
// Edit Setting, on a row, asks for the new value, checks it, and sends it
// through `Live.runOnActive` as `\x value`: the read-only guard reads that
// as a system command and asks first on a guarded process; any other is
// asked here, once, with the note on what the setting does. Off
// (q-lint.processes.systemSettings.enable), the view is gone, its commands
// refuse and nothing is sent.
import { commands, window, workspace, type ExtensionContext } from "vscode";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { PROCESS_TOOL_COMMANDS, toolOff, toolOn } from "./processtools";
import { READ_SETTINGS, SET_SETTING, SYSTEM_SETTINGS, memoryText, readSettings, settingCommand, valueProblem } from "./syssettings";
import { ToolTree, type ToolNode } from "./toolstree";
import { plainMessage } from "./history";

export const SYSTEM_SETTINGS_VIEW = "q-lint.systemSettings";

const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "systemSettings");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function say(text: string): string {
  void window.showInformationMessage(plainMessage(text));
  return text;
}

/// The rows: one for each setting, its value and what it does.
export function settingRows(values: Map<string, string>): ToolNode[] {
  return SYSTEM_SETTINGS.map((s) => {
    const value = values.get(s.key) ?? "";
    return {
      label: `\\${s.key}  ${s.name}`,
      description: s.key === "w" ? memoryText(value) : value,
      tooltip: `${s.note}${s.readOnly === true ? "" : `\nEdit Setting takes ${s.accepts}.`}`,
      icon: "settings-gear",
      contextValue: s.readOnly === true ? "systemSetting.readOnly" : "systemSetting",
      data: { key: s.key, value },
    };
  });
}

export function registerSystemSettings(
  context: ExtensionContext,
  live: Live,
): { refresh: () => Promise<Map<string, string> | string>; edit: (arg?: unknown, value?: string) => Promise<string>; tree: () => ToolTree } {
  const tree = new ToolTree(context, SYSTEM_SETTINGS_VIEW, "systemSettings");
  let shownFor: string | undefined;
  const refresh = async (): Promise<Map<string, string> | string> => {
    if (!on()) {
      return say(toolOff("systemSettings"));
    }
    if (live.activeLabel() === undefined) {
      tree.show([], "Not connected: connect to a process, then Refresh.");
      return "not connected";
    }
    let got: { value: { process: string; values: Map<string, string> } } | undefined;
    try {
      got = await borrowWhenFree(live, async (connection, process) => ({ process: process.label, values: readSettings(await connection.call(READ_SETTINGS, 0)) }));
    } catch (error) {
      tree.show([], message(error));
      return message(error);
    }
    if (got === undefined) {
      tree.show(tree.roots, "The process is busy with a query: Refresh again once it ends.");
      return "busy";
    }
    shownFor = got.value.process;
    tree.show(settingRows(got.value.values), `${got.value.process}, read at ${new Date().toLocaleTimeString()}.`);
    return got.value.values;
  };
  const edit = async (arg?: unknown, given?: string): Promise<string> => {
    if (!on()) {
      return say(toolOff("systemSettings"));
    }
    const data = (arg as ToolNode | undefined)?.data as { key?: string; value?: string } | undefined;
    const key =
      data?.key ??
      (typeof arg === "string" ? arg : (await window.showQuickPick(SYSTEM_SETTINGS.filter((s) => s.readOnly !== true).map((s) => ({ label: s.key, description: s.name, detail: s.note })), { title: "Edit which system setting?" }))?.label);
    const setting = SYSTEM_SETTINGS.find((s) => s.key === key);
    if (setting === undefined || setting.readOnly === true) {
      return key === undefined ? "nothing picked" : say(`q-lint: \\${key} is not a setting this view edits.`);
    }
    const process = live.activeProcess();
    if (process === undefined) {
      return say("q-lint: not connected to a q process.");
    }
    if (data !== undefined && shownFor !== undefined && shownFor !== process.label) {
      return say(`q-lint: the settings shown are ${shownFor}'s, and ${process.label} is connected now; Refresh first.`);
    }
    const value =
      given ??
      (await window.showInputBox({
        title: `\\${setting.key} (${setting.name}) on ${process.label}`,
        prompt: `${setting.note} Takes ${setting.accepts}.`,
        value: data?.value ?? "",
        validateInput: (v) => valueProblem(setting.key, v),
      }));
    if (value === undefined) {
      return "no value";
    }
    const problem = valueProblem(setting.key, value);
    if (problem !== undefined) {
      return say(`q-lint: ${problem}.`);
    }
    const code = settingCommand(setting.key, value);
    // A guarded process is asked by the guard, with its own warning; any
    // other is asked here, so no edit goes unconfirmed and none twice.
    if (live.guardRefuses(code, [process]) === undefined) {
      const yes = "Set";
      const picked = await Promise.resolve(
        window.showWarningMessage(plainMessage(`Set ${code} on ${process.label}?`), { modal: true, detail: setting.note }, yes),
      ).catch(() => undefined);
      if (picked !== yes) {
        return "not confirmed";
      }
    }
    let ran: { process: string; value: unknown } | undefined;
    try {
      // Only on the process the input box and the question named (#1291).
      ran = await live.runOnActive(code, (connection) => connection.call(SET_SETTING, setting.key, code.slice(setting.key.length + 2)), "ask", process.label);
    } catch (error) {
      return say(`q-lint: \\${setting.key} was not set: ${message(error)}`);
    }
    if (ran === undefined) {
      return "nothing was run";
    }
    void window.showInformationMessage(plainMessage(`q-lint: \\${setting.key} on ${ran.process} is now ${String(ran.value)}.`));
    if (tree.open) {
      await refresh();
    }
    return String(ran.value);
  };
  context.subscriptions.push(
    commands.registerCommand(PROCESS_TOOL_COMMANDS.refreshSystemSettings, refresh),
    commands.registerCommand(PROCESS_TOOL_COMMANDS.editSystemSetting, (arg?: unknown, value?: unknown) => edit(arg, typeof value === "string" ? value : undefined)),
  );
  return { refresh, edit, tree: () => tree };
}
