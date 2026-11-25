// The workspace's shared process list (#955): `.qlint/processes.json`,
// committed with the code so a team shares its processes, read and watched
// and listed beside the saved ones. No `vscode` import, so node tests it.
//
// A file in a repository is read by everyone who clones it, so it never
// holds a secret: a password, a secret or a token in an entry is dropped and
// said. What would run something - a connect script, an SSH jump host, a
// launch definition - is read only in a trusted workspace.
import * as path from "node:path";
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
  // An entry reached through a tunnel is not listed untrusted: without its
  // tunnel it would be connected to directly, password and all (#1507).
  const tunnelled = new Set<string>();
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
        if (!trusted && typeof kept.ssh === "string" && kept.ssh.trim() !== "" && typeof kept.label === "string") {
          tunnelled.add(kept.label.trim());
        }
        return kept;
      })
    : json;
  const read = parseProcesses(Array.isArray(list) ? { processes: cleaned } : cleaned, trusted);
  const processes = read.processes.filter((p) => !tunnelled.has(p.label));
  const skipped = read.processes.filter((p) => tunnelled.has(p.label)).map((p) => p.label);
  return {
    processes,
    problems: [
      ...read.problems,
      ...(skipped.length > 0 ? [`${skipped.join(", ")}: reached through an SSH tunnel, which is not read while the workspace is not trusted, so not listed.`] : []),
      ...(secrets.length > 0 ? [`${secrets.join(", ")}: a password or secret was dropped; a shared list holds none.`] : []),
      ...(untrusted > 0 ? [`${untrusted} entr${untrusted === 1 ? "y's" : "ies'"} connect script, SSH tunnel or launch definition was not read: the workspace is not trusted.`] : []),
    ],
    secrets,
  };
}

/// The lists of several workspace folders' files as one (#1841), in folder
/// order. A label more than one folder's list names is qualified with the
/// folder's name in each of them - with its path, should two folders share
/// a name - so no folder keeps the bare label: which one would hang on
/// folder order, and a file bound to it would follow the label to another
/// folder's process when the folders are reordered or one is removed
/// (#2511). And in a folder other than `first`, which a connect
/// script and a launch are otherwise read against, a relative one is made
/// that folder's. Problems are named by folder when there are several.
export function mergeShared(lists: { name: string; path: string; read: SharedList }[], first: string | undefined): SharedList {
  const taken = new Set<string>();
  const own = (file: string, dir: string): string => (path.isAbsolute(file) || file.startsWith("~") ? file : path.join(dir, file));
  const listing = new Map<string, number>();
  for (const { read } of lists) {
    for (const label of new Set(read.processes.map((p) => p.label))) {
      listing.set(label, (listing.get(label) ?? 0) + 1);
    }
  }
  const names = lists.map(({ name }) => name);
  const processes = lists.flatMap(({ name, path: dir, read }) =>
    read.processes.map((p) => {
      const shared = (listing.get(p.label) ?? 0) > 1;
      const label = !shared && !taken.has(p.label) ? p.label : `${p.label} (${names.filter((n) => n === name).length > 1 ? dir : name})`;
      taken.add(label);
      if (dir === first) {
        return { ...p, label };
      }
      return {
        ...p,
        label,
        ...(p.initFile !== undefined ? { initFile: own(p.initFile, dir) } : {}),
        ...(p.launch !== undefined ? { launch: { ...p.launch, cwd: p.launch.cwd !== undefined ? own(p.launch.cwd, dir) : dir } } : {}),
      };
    }),
  );
  const named = lists.length > 1;
  return {
    processes,
    problems: lists.flatMap(({ name, read }) => read.problems.map((problem) => (named ? `${name}: ${problem}` : problem))),
    secrets: lists.flatMap(({ read }) => read.secrets),
  };
}

/// What a warning says of the secrets dropped from the list.
export function secretsWarning(labels: string[]): string {
  return `q-lint: ${SHARED_FILE} holds a password or secret for ${labels.join(", ")}, which was ignored: a list in the repository holds no secrets. q-lint asks for a password on connect and keeps it in VS Code's secret storage. Remove it from the file.`;
}

/// The list's text with `process` in it, in place of an entry of its label
/// or after the rest, written as an export writes one: a saved process holds
/// no password. `text` undefined: a new file. Throws a SyntaxError when the
/// text there is not JSON, and an Error when it is JSON that holds no list
/// to add to - a `processes` that is not a list, or no object at all - so
/// what the file does hold is not written over (#1886). An object with no
/// `processes` gets one, beside its other fields.
export function withShared(text: string | undefined, process: Process): string {
  const json: unknown = text === undefined || text.trim() === "" ? { processes: [] } : JSON.parse(text.replace(/^\uFEFF/, ""));
  const fields = typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  if (!Array.isArray(json) && (fields === undefined || ("processes" in fields && !Array.isArray(fields.processes)))) {
    throw new Error("it holds no list of processes: a list, or an object with a `processes` list, is expected. Nothing was written.");
  }
  const holder: { processes: unknown[] } & Record<string, unknown> = Array.isArray(json) ? { processes: json } : { ...fields, processes: (fields?.processes as unknown[] | undefined) ?? [] };
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
