// The workspace's shared process list (#955): `.qlint/processes.json`,
// committed with the code so a team shares its processes, read and watched
// and listed beside the saved ones. No `vscode` import, so node tests it.
//
// A file in a repository is read by everyone who clones it, so it never
// holds a secret: a password, a secret or a token in an entry is dropped and
// said. What would run something - a connect script, an SSH jump host, a
// launch definition - is read only in a trusted workspace.
import { SHARED_SOURCE } from "./discovery";
import { parseProcesses, type Process } from "./processes";

export { SHARED_SOURCE };

export const SHARED_COMMANDS = {
  add: "q-lint.addToSharedProcesses",
} as const;

/// Where the list is, from the workspace folder.
export const SHARED_FILE = ".qlint/processes.json";

/// `q-lint.processes.shared.enable`: whether the list is read and shown.
export function readShared(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("processes.shared.enable", true) !== false };
}

/// The fields a shared entry may not hold, ignoring case.
const SECRET = /^(password|passwd|pwd|pass|secret|token|apikey|api_key|credentials?)$/i;

export interface SharedList {
  processes: Process[];
  /// What was wrong with the entries skipped, and what was dropped.
  problems: string[];
  /// The labels of the entries that held a secret, which was dropped.
  secrets: string[];
}

/// The processes `text` lists, as an import reads a file, with every secret
/// dropped. `trusted`: a trusted workspace, whose list may run code.
/// Throws a SyntaxError when the text is not JSON.
export function readSharedFile(text: string, trusted: boolean): SharedList {
  const json: unknown = JSON.parse(text.replace(/^﻿/, ""));
  const list = Array.isArray(json) ? json : typeof json === "object" && json !== null ? (json as { processes?: unknown }).processes : undefined;
  const secrets: string[] = [];
  let untrusted = 0;
  const cleaned = Array.isArray(list)
    ? list.map((entry, i) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return entry;
        }
        const e = entry as Record<string, unknown>;
        const kept = Object.fromEntries(Object.entries(e).filter(([k]) => !SECRET.test(k)));
        if (Object.keys(kept).length !== Object.keys(e).length) {
          secrets.push(typeof e.label === "string" && e.label.trim() !== "" ? e.label.trim() : `entry ${i + 1}`);
        }
        if (!trusted && ["init", "initFile", "ssh", "launch", "credentialCommand"].some((k) => k in kept)) {
          untrusted++;
        }
        return kept;
      })
    : json;
  const { processes, problems } = parseProcesses(Array.isArray(list) ? { processes: cleaned } : cleaned, trusted);
  return {
    processes,
    problems: [
      ...problems,
      ...(secrets.length > 0 ? [`${secrets.join(", ")}: a password or secret was dropped; a shared list holds none.`] : []),
      ...(untrusted > 0 ? [`${untrusted} entr${untrusted === 1 ? "y's" : "ies'"} connect script, SSH tunnel or launch definition was not read: the workspace is not trusted.`] : []),
    ],
    secrets,
  };
}

/// What a warning says of the secrets dropped from the list.
export function secretsWarning(labels: string[]): string {
  return `q-lint: ${SHARED_FILE} holds a password or secret for ${labels.join(", ")}, which was ignored: a list in the repository holds no secrets. q-lint asks for a password on connect and keeps it in VS Code's secret storage. Remove it from the file.`;
}

/// The list's text with `process` in it, in place of an entry of its label
/// or after the rest, written as an export writes one: a saved process holds
/// no password. `text` undefined: a new file. Throws a SyntaxError when the
/// text there is not JSON.
export function withShared(text: string | undefined, process: Process): string {
  const json: unknown = text === undefined || text.trim() === "" ? { processes: [] } : JSON.parse(text.replace(/^\uFEFF/, ""));
  const holder: { processes: unknown[] } & Record<string, unknown> = Array.isArray(json)
    ? { processes: json }
    : typeof json === "object" && json !== null && Array.isArray((json as { processes?: unknown }).processes)
      ? (json as { processes: unknown[] } & Record<string, unknown>)
      : { processes: [] };
  const { server: _server, ...entry } = process;
  void _server;
  // Trimmed, as the list is read: `"rdb "` is listed as rdb.
  const at = holder.processes.findIndex((e) => {
    const label = typeof e === "object" && e !== null ? (e as { label?: unknown }).label : undefined;
    return typeof label === "string" && label.trim() === process.label;
  });
  if (at >= 0) {
    holder.processes[at] = entry;
  } else {
    holder.processes.push(entry);
  }
  return JSON.stringify(holder, null, 2) + "\n";
}
