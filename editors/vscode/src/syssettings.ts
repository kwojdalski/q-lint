// The system settings view (#1043), as data: the process's `\c`, `\s`,
// `\P`, `\T`, `\g`, `\o`, `\z` and `\w`, each with a note on what it does
// and, for an edit, what a new value may be. Free of any `vscode` import,
// so node tests it; `syssettingsview.ts` shows them.
//
// `READ_SETTINGS` only reads: each command without an argument. `SET_SETTING`
// runs one command with the value the view checked against `valueProblem`
// - digits, a sign, `0N` and spaces only, so nothing else can reach
// `system` - and answers the setting as it now reads. It is sent only after
// the user confirmed, and through the read-only guard as `\x value`, which
// the guard reads as a system command that changes the process.

export interface SystemSetting {
  key: string;
  name: string;
  note: string;
  /// What an edit may be, as a person reads it.
  accepts: string;
  pattern: RegExp;
  /// Shown, never edited.
  readOnly?: boolean;
}

export const SYSTEM_SETTINGS: SystemSetting[] = [
  { key: "c", name: "console size", note: "Rows and columns of the console's display (`\\c 25 80`); results wider or longer are cut with `..`.", accepts: "two whole numbers, rows then columns, as 25 80", pattern: /^\d+ \d+$/ },
  { key: "s", name: "secondary threads", note: "Threads `peach` and `.Q.fc` use; it can be set no higher than the `-s` the process started with.", accepts: "a whole number, 0 or more", pattern: /^\d+$/ },
  { key: "P", name: "float precision", note: "Significant digits a float is shown with; 0 is the most (17).", accepts: "a whole number from 0 to 17", pattern: /^(?:\d|1[0-7])$/ },
  { key: "T", name: "query timeout", note: "Seconds a client query may run before it is stopped with 'stop; 0 is no limit.", accepts: "a whole number of seconds, 0 for none", pattern: /^\d+$/ },
  { key: "g", name: "garbage collection", note: "0: deferred, memory is returned at `.Q.gc[]` or when the limit is reached; 1: immediate, freed memory goes back to the system at once.", accepts: "0 or 1", pattern: /^[01]$/ },
  { key: "o", name: "UTC offset", note: "Hours from UTC that `.z.T`, `.z.D` and `.z.P`'s local siblings use; 0N is the machine's own time zone.", accepts: "a whole number of hours, -23 to 23, or 0N", pattern: /^(?:-?(?:\d|1\d|2[0-3])|0N)$/ },
  { key: "z", name: "date format", note: "How a date string such as 01/02/2026 is parsed: 0 is month first (mm/dd/yyyy), 1 is day first (dd/mm/yyyy).", accepts: "0 or 1", pattern: /^[01]$/ },
  { key: "w", name: "memory", note: "Bytes used, heap, peak heap, the workspace limit (`-w`; 0 is none), mapped and physical. Read only here: kdb+ changes the limit only for a process started with -w, and PeachQ not at all.", accepts: "", pattern: /^$/, readOnly: true },
];

export const READ_SETTINGS = [
  "{[x]",
  " k:\"csPTgozw\";",
  " v:{r:@[system;x;{(`err;x)}];$[(2=count r)&`err~first r;\"'\",last r;10h=type r;r;\" \" sv {$[null x;\"0N\";string x]} each (),r]} each enlist each k;",
  " (k;v)}",
].join("\n");

export const SET_SETTING = [
  "{[k;v]",
  " k:(),k;v:(),v;",
  " if[not k in enlist each \"csPTgoz\";'\"not a setting this view edits\"];",
  " if[not all v in \"0123456789 -N\";'\"not a value this view sends\"];",
  " system k,\" \",v;",
  " r:system k; $[10h=type r;r;\" \" sv {$[null x;\"0N\";string x]} each (),r]}",
].join("\n");

/// Why `value` cannot be given to the setting `key`, or undefined.
export function valueProblem(key: string, value: string): string | undefined {
  const setting = SYSTEM_SETTINGS.find((s) => s.key === key);
  if (setting === undefined || setting.readOnly === true) {
    return `\\${key} is not a setting this view edits`;
  }
  return setting.pattern.test(value.trim().replace(/\s+/g, " ")) ? undefined : `\\${key} takes ${setting.accepts}`;
}

/// The code the read-only guard reads for an edit, and the user is shown.
export function settingCommand(key: string, value: string): string {
  return `\\${key} ${value.trim().replace(/\s+/g, " ")}`;
}

/// What `READ_SETTINGS` answered: each key's value as text, an error as
/// `'message`. Throws when it is not that shape.
export function readSettings(raw: unknown): Map<string, string> {
  const p = raw as unknown[];
  if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || !Array.isArray(p[1]) || p[1].length !== p[0].length || !p[1].every((v) => typeof v === "string")) {
    throw new Error(`the process answered something other than its settings: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const values = p[1] as string[];
  return new Map([...(p[0] as string)].map((k, i) => [k, values[i]]));
}

/// `\w`'s six numbers, named; the value as it came otherwise.
export function memoryText(value: string): string {
  const n = value.split(" ").map(Number);
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) {
    return value;
  }
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
  return `used ${mb(n[0])}, heap ${mb(n[1])}, peak ${mb(n[2])}, limit ${n[3] === 0 ? "none" : mb(n[3])}`;
}

