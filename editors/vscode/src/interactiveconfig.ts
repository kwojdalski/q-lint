// The commands and switches of running code interactively from a q file:
// cells and the Interactive Window (#956), Smart Send (#957), the cell
// lenses (#958), the q REPL pane (#959) and `.qlint.view`/`.qlint.plot`
// (#960). Each feature has its own `enable`; those that send code on a
// keypress, or define anything on a process by themselves, are off by
// default.

export const INTERACTIVE_COMMANDS = {
  runCell: "q-lint.runCell",
  runAllCells: "q-lint.runAllCells",
  openInteractive: "q-lint.openInteractiveWindow",
  clearInteractive: "q-lint.clearInteractiveWindow",
  runAbove: "q-lint.runCellsAbove",
  runBelow: "q-lint.runCellsBelow",
  smartSend: "q-lint.smartSend",
  openRepl: "q-lint.openReplPane",
  defineView: "q-lint.defineViewHelpers",
} as const;

/// Set while the active q editor has a `/ %%` line: what Ctrl+Enter's
/// Run Cell keybinding waits for.
export const HAS_CELLS = "q-lint.hasCells";

export const SMART_SEND_TARGETS = ["query", "interactiveWindow", "repl", "terminal"] as const;
export type SmartSendTarget = (typeof SMART_SEND_TARGETS)[number];

export interface InteractiveSettings {
  cells: boolean;
  cellLenses: boolean;
  smartSend: boolean;
  smartSendTarget: SmartSendTarget;
  repl: boolean;
  view: boolean;
  defineViewOnConnect: boolean;
}

export function readInteractive(get: <T>(key: string, fallback: T) => T): InteractiveSettings {
  const target = get<unknown>("smartSend.target", "query");
  return {
    cells: get<unknown>("cells.enable", true) !== false,
    cellLenses: get<unknown>("cells.codeLens.enable", true) !== false,
    smartSend: get<unknown>("smartSend.enable", false) === true,
    smartSendTarget: SMART_SEND_TARGETS.find((t) => t === target) ?? "query",
    repl: get<unknown>("repl.enable", true) !== false,
    view: get<unknown>("view.enable", true) !== false,
    defineViewOnConnect: get<unknown>("view.defineOnConnect", false) === true,
  };
}

/// What a command of a feature turned off says, naming its switch.
export function turnedOff(feature: string, key: string): string {
  return `q-lint: ${feature} is turned off. Set ${key} to true to turn it on.`;
}
