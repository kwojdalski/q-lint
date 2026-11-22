// The switches for the process inspection and editor helpers (#1042-#1051):
// each has its own `enable` setting. Free of any `vscode` import, so node
// tests it. A feature turned off has its commands hidden (package.json's
// `when`) and refusing, its views, decorations and listeners disposed, and
// sends nothing to any process.
//
// All are on by default: each reads or sends only when its command is run
// (or its view's Refresh is pressed), and inline results draw what a Run
// Line the user ran already answered.

export const PROCESS_TOOL_SETTINGS = {
  tickerplantSubscribers: { key: "tickerplant.subscribers.enable", fallback: true, name: "The tickerplant subscribers view" },
} as const;

export type ProcessTool = keyof typeof PROCESS_TOOL_SETTINGS;

/// The features' commands, here so a test without `vscode` can list them.
export const PROCESS_TOOL_COMMANDS = {
  refreshSubscribers: "q-lint.refreshTickerplantSubscribers",
} as const;

/// Whether `feature` is on, read with `get` as the other settings are read.
/// Anything but a boolean is the default.
export function toolOn(get: <T>(key: string, fallback: T) => T, feature: ProcessTool): boolean {
  const { key, fallback } = PROCESS_TOOL_SETTINGS[feature];
  const value = get<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
}

/// What a command of a feature turned off says.
export function toolOff(feature: ProcessTool): string {
  const { key, name } = PROCESS_TOOL_SETTINGS[feature];
  return `q-lint: ${name} is turned off. Set q-lint.${key} to true to turn it on.`;
}

/// `n` bytes as a person reads them.
export function bytesText(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/// A list a q answer gave, whatever one element made of it: an atom for a
/// list of one, a string for a list of one string.
export function listOf<T>(v: unknown, is: (x: unknown) => x is T): T[] | undefined {
  if (Array.isArray(v)) {
    return v.every(is) ? (v as T[]) : undefined;
  }
  return is(v) ? [v] : undefined;
}

/// Code to send as a string argument, as written. The IPC client sends a
/// string starting with a backtick as a symbol, and one of one character as
/// a char atom; a leading space keeps it a string, and changes nothing for
/// `value` or `system`.
export function asCode(code: string): string {
  return ` ${code}`;
}

export const isString = (x: unknown): x is string => typeof x === "string";
export const isNumber = (x: unknown): x is number => typeof x === "number";
export const isBoolean = (x: unknown): x is boolean => typeof x === "boolean";
