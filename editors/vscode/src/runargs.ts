// Run File with Arguments (#1005), as data: the argument sets saved for a
// file, kept per workspace (`workspaceState`), newest first, and what one
// becomes - the words after the file on q's command line, which q reads as
// `.z.x`, and the lines typed into q's console once it starts. No `vscode`
// import, so node tests it; `runargsview.ts` asks and runs, through Run
// Code from Terminal's own start (`QTerminals.runFile`).
import { iconsEscaped } from "./history";
import { splitArgs } from "./processes";

export const RUN_ARGS_COMMAND = "q-lint.runFileWithArguments";
export const RUN_ARGS_KEY = "q-lint.runArguments";
/// The most argument sets kept for one file.
export const MAX_SETS = 10;

/// What a run adds to Run Code from Terminal: `args` after the file, and
/// `input` typed into q once it starts.
export interface RunExtra {
  args: string[];
  input: string[];
}

/// One saved set: the arguments as typed, and the console input, a line to
/// each line typed.
export interface ArgSet {
  args: string;
  input: string;
}

/// `q-lint.terminal.runWithArguments.enable`: whether the command is offered.
export function readRunArgs(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("terminal.runWithArguments.enable", true) !== false };
}

export const RUN_ARGS_OFF =
  "q-lint: Run File with Arguments is turned off. Set q-lint.terminal.runWithArguments.enable to true to turn it on.";

function isSet(v: unknown): v is ArgSet {
  const s = v as ArgSet | null;
  return typeof s === "object" && s !== null && typeof s.args === "string" && typeof s.input === "string";
}

/// The sets saved for `file` (a URI as text), newest first; anything that
/// is not a set is dropped.
export function setsFor(stored: unknown, file: string): ArgSet[] {
  if (typeof stored !== "object" || stored === null) {
    return [];
  }
  const sets = (stored as Record<string, unknown>)[file];
  return Array.isArray(sets) ? sets.filter(isSet).slice(0, MAX_SETS) : [];
}

/// Every file's sets as stored, cleaned.
function cleaned(stored: unknown): Record<string, ArgSet[]> {
  const out: Record<string, ArgSet[]> = {};
  if (typeof stored === "object" && stored !== null) {
    for (const file of Object.keys(stored)) {
      const sets = setsFor(stored, file);
      if (sets.length > 0) {
        out[file] = sets;
      }
    }
  }
  return out;
}

const same = (a: ArgSet, b: ArgSet): boolean => a.args === b.args && a.input === b.input;

/// What is stored once `set` is the newest for `file`: moved to the front
/// if it was there already, and the oldest dropped past `MAX_SETS`.
export function withSet(stored: unknown, file: string, set: ArgSet): Record<string, ArgSet[]> {
  const out = cleaned(stored);
  out[file] = [set, ...(out[file] ?? []).filter((s) => !same(s, set))].slice(0, MAX_SETS);
  return out;
}

/// What is stored once `set` is forgotten for `file`.
export function withoutSet(stored: unknown, file: string, set: ArgSet): Record<string, ArgSet[]> {
  const out = cleaned(stored);
  const rest = (out[file] ?? []).filter((s) => !same(s, set));
  if (rest.length > 0) {
    out[file] = rest;
  } else {
    delete out[file];
  }
  return out;
}

/// The console input as lines, as stored (one per line), with blank lines
/// at the end dropped.
export function inputLines(input: string): string[] {
  const lines = input.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines;
}

/// A set given to the command as an argument, as a keybinding gives one:
/// `{"args": "-p 5001", "input": "show 1"}`, `input` optional (a string or
/// a list of lines). Undefined for anything else.
export function givenSet(value: unknown): ArgSet | undefined {
  const v = value as { args?: unknown; input?: unknown } | null;
  if (typeof v !== "object" || v === null || typeof v.args !== "string") {
    return undefined;
  }
  const input = Array.isArray(v.input) ? v.input.filter((l): l is string => typeof l === "string").join("\n") : typeof v.input === "string" ? v.input : "";
  return { args: v.args, input };
}

/// A set as a run takes it.
export function extraOf(set: ArgSet): RunExtra {
  return { args: splitArgs(set.args), input: inputLines(set.input) };
}

/// A set as the quick pick lists it: its arguments as written, a `$(name)`
/// among them not drawn as an icon (#1929).
export function describe(set: ArgSet): { label: string; description: string } {
  const n = inputLines(set.input).length;
  return {
    label: set.args.trim() === "" ? "(no arguments)" : iconsEscaped(set.args),
    description: n === 0 ? "" : `then ${n} line${n === 1 ? "" : "s"} of input`,
  };
}
