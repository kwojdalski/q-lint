// The q processes a user can connect to, as data: what one is, how a list of
// them is read from a file, and how the Processes view groups them. Nothing
// here talks to a process or to VS Code, so all of it is tested with node.

import { isIPv6 } from "net";

export interface Process {
  /// Unique among the processes; what the view and the status bar show.
  label: string;
  host: string;
  port: number;
  /// Sent in the handshake with the password, which is never stored here:
  /// it lives in VS Code's secret storage, keyed by the label.
  user?: string;
  tags: string[];
  tls?: boolean;
  /// The discovery server that listed it, for a discovered process, whose
  /// label is then `server/label`. Never saved or read from a file.
  server?: string;
  /// q code run on every connect, before any query (#916); or `initFile`,
  /// a q file read and run so. Never taken from a discovery server.
  init?: string;
  initFile?: string;
  /// An SSH destination (`bastion`, `me@bastion`, `me@bastion:2222`) the
  /// process is reached through, by a tunnel the system `ssh` opens (#908).
  /// Read only where a connect script is.
  ssh?: string;
  /// Set for a TorQ gateway: the server types a query goes to through
  /// `.gw.syncexec` unless a file or the query names others (#909).
  gateway?: string[];
  /// How the process is started on this machine (#954). Read only where a
  /// connect script is: it runs a program.
  launch?: Launch;
  /// A command run at each connect whose output gives the user and password
  /// or token (#1034): its output is used for that connect only, never
  /// stored. Read only where a connect script is: it runs a program.
  credentialCommand?: string;
  /// Seconds a query on it may run before its connection is dropped (#1036),
  /// over `q-lint.query.timeout`.
  timeout?: number;
  /// How code is evaluated there (#2470): `wrapped`, in q-lint's lambda, or
  /// `direct`, as plain strings, for a process that refuses a lambda (TorQ
  /// with permissions on). Unset, `q-lint.query.unwrapped` decides.
  evaluation?: Evaluation;
}

export type Evaluation = "wrapped" | "direct";

/// A local process's start: `command` (default `q-lint.terminal.qBinary`)
/// with `script`, `-p <port>` and `args`, in `cwd` with `env` added.
export interface Launch {
  command?: string;
  script?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/// Where a process's password is kept in secret storage. A discovered
/// process's is apart from any saved one's, since a saved label may be
/// `desk/rdb` too: one process's password is never sent to the other.
export function passwordKey(process: Pick<Process, "label" | "server">): string {
  return process.server === undefined ? `q-lint.password.${process.label}` : `q-lint.discoveredPassword.${process.label}`;
}

/// Where a password of a process from the workspace's shared list is kept:
/// by the folder whose list names it and where the list says it is, not by
/// its label alone. Another repository's list can name its own `rdb` at
/// another host, and was given this one's password for it (#1824).
export function sharedPasswordKey(process: Pick<Process, "label" | "host" | "port" | "user" | "tls" | "ssh">, folder: string): string {
  return `q-lint.sharedPassword.${process.label} ${sharedScope(process, folder)}`;
}

/// The folder and the address, user, TLS and tunnel of a shared-list
/// process, as one string: what its password and scratch buffer are kept by.
export function sharedScope(process: Pick<Process, "host" | "port" | "user" | "tls" | "ssh">, folder: string): string {
  return JSON.stringify([folder, process.host, process.port, process.user ?? "", process.tls === true, process.ssh ?? ""]);
}

/// Why `port` is not a port, or undefined when it is one.
export function portProblem(port: string): string | undefined {
  if (!/^\d+$/.test(port.trim())) {
    return "A port is a whole number.";
  }
  const n = Number(port);
  return n >= 1 && n <= 65535 ? undefined : "A port is between 1 and 65535.";
}

/// `host` as it is connected to: an IPv6 address written in brackets, as a
/// URL writes one (`[::1]`), without them.
export function plainHost(host: string): string {
  const h = host.trim();
  return /^\[[^\]]*:[^\]]*\]$/.test(h) ? h.slice(1, -1) : h;
}

/// Why `host` is not a host, or undefined when it is: a name or an address,
/// with no port, scheme, space or slash.
export function hostProblem(host: string): string | undefined {
  const h = plainHost(host);
  if (h === "") {
    return "A host is needed.";
  }
  // A colon is a port or a scheme unless the whole is an IPv6 address:
  // `[::1]:5000` and `host:5000:rdb` have two and are neither.
  if (h.includes(":") && !isIPv6(h)) {
    return "A host only: the port is asked for next.";
  }
  if (/[\s/\\]/.test(h)) {
    return "A host has no spaces or slashes.";
  }
  // Else a name: `[rdb]`, `me@rdb`, `rdb#1` or `rdb,hdb` was saved, then
  // failed on every connect (#1781).
  return isIPv6(h) || /^[A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_])?\.?$/.test(h)
    ? undefined
    : "A host is a name of letters, digits, '.', '-' and '_', or an IP address.";
}

/// `host:port` as it is shown, an IPv6 host in brackets so the port is not
/// read as part of it.
export function address(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/// `text` as Markdown that shows it as written: every character Markdown
/// could read as syntax is escaped.
export function markdownText(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|~<>&]/g, (c) => `\\${c}`);
}

/// A process row's tooltip, as Markdown: its label, address, user and tags
/// as written. `from` is the discovery server that listed it.
export function processTooltip(process: Process, from?: string): string {
  return [
    `**${markdownText(process.label)}**`,
    `${markdownText(address(process.host, process.port))}${process.tls ? " (TLS)" : ""}`,
    // One saved before a host was checked (#1881).
    ...(hostProblem(process.host) !== undefined ? [`not a host (${markdownText(hostProblem(process.host)!)}): Edit Process changes it`] : []),
    process.user ? `user ${markdownText(process.user)}` : "no user",
    process.tags.length ? `tags: ${markdownText(process.tags.join(", "))}` : "no tags",
    ...(process.init !== undefined ? ["runs q code on connect"] : []),
    ...(process.initFile !== undefined ? [`runs ${markdownText(process.initFile)} on connect`] : []),
    ...(process.ssh !== undefined ? [`through an SSH tunnel via ${markdownText(process.ssh)}`] : []),
    ...(process.gateway !== undefined ? [`TorQ gateway: ${markdownText(process.gateway.join(", "))}`] : []),
    ...(process.launch !== undefined ? ["has a launch definition"] : []),
    ...(process.credentialCommand !== undefined ? ["gets its credentials from a command at connect"] : []),
    ...(process.timeout !== undefined ? [`queries time out after ${process.timeout} s`] : []),
    ...(process.evaluation === "direct"
      ? ["evaluation: direct - code is sent as plain strings: no backtrace, no reval"]
      : process.evaluation === "wrapped"
        ? ["evaluation: wrapped, whatever q-lint.query.unwrapped says"]
        : []),
    ...(from === undefined ? [] : [`listed by ${markdownText(from)}, connected to as ${markdownText(`${from}/${process.label}`)}`]),
  ].join("\n\n");
}

/// Tags as written in an input box: comma or space separated, lower case,
/// each once.
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t !== ""),
    ),
  ];
}

/// The processes a JSON value describes, and what was wrong with the rest.
/// Accepts a list of processes, or an object holding one under `processes`.
/// An entry is kept only when it has a label, a host and a port; a label
/// already seen is skipped, so an import cannot hold two of one name. A
/// connect script (`init` code or an `initFile`) is read only when `scripts`
/// asks: a list from a discovery server never runs code on a process.
/// `stored`: the list is the one saved here, which versions before 0.37
/// wrote with a host unchecked. Such an entry is kept as it is, to be shown
/// and edited: skipped, the next save wrote the list without it (#1881).
export function parseProcesses(json: unknown, scripts = false, stored = false): { processes: Process[]; problems: string[] } {
  const list = Array.isArray(json)
    ? json
    : typeof json === "object" && json !== null && Array.isArray((json as { processes?: unknown }).processes)
      ? (json as { processes: unknown[] }).processes
      : undefined;
  if (list === undefined) {
    return { processes: [], problems: ["Expected a list of processes, or an object with a `processes` list."] };
  }
  const processes: Process[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const where = `Entry ${i + 1}`;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${where} is not an object.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === "string" ? e.label.trim() : "";
    const host = typeof e.host === "string" ? plainHost(e.host) : "";
    const port = typeof e.port === "number" ? String(e.port) : typeof e.port === "string" ? e.port : "";
    if (label === "") {
      problems.push(`${where} has no label.`);
      return;
    }
    if (host === "") {
      problems.push(`${where} (${label}) has no host.`);
      return;
    }
    const bad = (stored ? undefined : hostProblem(host)) ?? portProblem(port);
    if (bad !== undefined) {
      problems.push(`${where} (${label}): ${bad}`);
      return;
    }
    // "true", 1 or "yes" read as no TLS sent the handshake's password in
    // cleartext to a process meant to be reached over TLS (#2520).
    if (e.tls !== undefined && typeof e.tls !== "boolean") {
      problems.push(`${where} (${label}): tls is ${JSON.stringify(e.tls)}, not true or false, so it was skipped rather than connected to without TLS.`);
      return;
    }
    if (seen.has(label)) {
      problems.push(`${where} (${label}) repeats a label, and was skipped.`);
      return;
    }
    seen.add(label);
    const tags = Array.isArray(e.tags)
      ? parseTags(e.tags.filter((t): t is string => typeof t === "string").join(","))
      : typeof e.tags === "string"
        ? parseTags(e.tags)
        : [];
    processes.push({
      label,
      host,
      port: Number(port),
      // Trimmed, as Add Process trims it: a space would go in the handshake (#1782).
      ...(typeof e.user === "string" && e.user.trim() !== "" ? { user: e.user.trim() } : {}),
      tags,
      ...(e.tls === true ? { tls: true } : {}),
      ...(scripts && typeof e.init === "string" && e.init.trim() !== "" ? { init: e.init } : {}),
      ...(scripts && typeof e.initFile === "string" && e.initFile.trim() !== "" && !(typeof e.init === "string" && e.init.trim() !== "")
        ? { initFile: e.initFile.trim() }
        : {}),
      ...extrasOf(e, scripts),
    });
    if (scripts && typeof e.init === "string" && e.init.trim() !== "" && typeof e.initFile === "string" && e.initFile.trim() !== "") {
      problems.push(`${where} (${label}) has both init and initFile: its init code was kept.`);
    }
  });
  return { processes, problems };
}

/// An SSH destination as written, or undefined when it is none. A leading
/// `-` would be read by ssh as an option, and a space as two arguments.
export function sshDestination(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const d = value.trim();
  return d !== "" && !d.startsWith("-") && !/[\s'"`$;|&<>\\]/.test(d) ? d : undefined;
}

/// What a command was handed as server types: a string or a list, or
/// undefined for anything else - the editor's Uri a context menu hands in
/// is none, and the user is asked (#1522).
export function givenServerTypes(value: unknown): string | string[] | undefined {
  return typeof value === "string" || Array.isArray(value) ? value : undefined;
}

/// Server types as written: a list, or a string split as tags are, each a
/// q name (`rdb`, `hdb`, `my_rdb`), lower case not forced.
export function serverTypes(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : typeof value === "string" ? value.split(/[\s,`]+/) : [];
  const types = [...new Set(items.map((t) => t.trim().replace(/^`/, "")).filter((t) => /^[A-Za-z][A-Za-z0-9_.]*$/.test(t)))];
  return types.length > 0 ? types : undefined;
}

/// An argument or a variable's value as written: a string as it is, a
/// finite number or a boolean as JSON writes it. `["-p", 5010]` was read as
/// a bare `-p`, and q started with its port disabled (#2521). Undefined for
/// anything else.
export function argText(value: unknown): string | undefined {
  return typeof value === "string" ? value : (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" ? String(value) : undefined;
}

/// A launch definition as written, or undefined when it is none: every field
/// is optional, but the object must be one.
export function launchOf(value: unknown): Launch | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const text = (x: unknown): string | undefined => (typeof x === "string" && x.trim() !== "" ? x.trim() : undefined);
  const args = Array.isArray(v.args) ? v.args.map(argText).filter((a) => a !== undefined) : typeof v.args === "string" ? splitArgs(v.args) : [];
  const env: Record<string, string> = {};
  if (typeof v.env === "object" && v.env !== null && !Array.isArray(v.env)) {
    for (const [k, x] of Object.entries(v.env as Record<string, unknown>)) {
      const value = argText(x);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && value !== undefined) {
        Object.defineProperty(env, k, { value, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  const launch: Launch = {
    ...(text(v.command) !== undefined ? { command: text(v.command) } : {}),
    ...(text(v.script) !== undefined ? { script: text(v.script) } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(text(v.cwd) !== undefined ? { cwd: text(v.cwd) } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  return launch;
}

/// Arguments as typed in one box: split at spaces, a pair of double quotes
/// keeping what is between them together, as a shell does: anywhere in a
/// word (`-name="a b"` is `-name=a b`, #1695), and taken off. A quote with
/// no pair is kept as it is.
export function splitArgs(text: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (word !== undefined) {
        words.push(word);
        word = undefined;
      }
    } else if (c === '"' && text.indexOf('"', i + 1) !== -1) {
      const end = text.indexOf('"', i + 1);
      word = (word ?? "") + text.slice(i + 1, end);
      i = end;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined) {
    words.push(word);
  }
  return words;
}

/// A credential command as written (#1034), or undefined when it is none.
export function credentialCommandOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0") ? value.trim() : undefined;
}

/// A per-process query timeout as written (#1036): positive seconds, at
/// most a day, as `q-lint.query.timeout` is.
export function timeoutOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, 86_400) : undefined;
}

/// A process's evaluation as written (#2470): `direct` or `wrapped`, any
/// case, or undefined for anything else - which follows the setting.
export function evaluationOf(value: unknown): Evaluation | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "direct" || v === "wrapped" ? v : undefined;
}

type Extras = Pick<Process, "ssh" | "gateway" | "launch" | "credentialCommand" | "timeout" | "evaluation">;

/// The SSH destination, gateway server types, launch definition, credential
/// command, timeout and evaluation of a process entry. `trusted`: from a
/// source whose code may run (the saved list, an import, a trusted
/// workspace), which alone may name an SSH host or a program to run.
function extrasOf(e: Record<string, unknown>, trusted: boolean): Extras {
  const ssh = trusted ? sshDestination(e.ssh) : undefined;
  const gateway = serverTypes(e.gateway);
  const launch = trusted ? launchOf(e.launch) : undefined;
  const credentialCommand = trusted ? credentialCommandOf(e.credentialCommand) : undefined;
  const timeout = timeoutOf(e.timeout);
  const evaluation = evaluationOf(e.evaluation);
  return {
    ...(ssh !== undefined ? { ssh } : {}),
    ...(gateway !== undefined ? { gateway } : {}),
    ...(launch !== undefined ? { launch } : {}),
    ...(credentialCommand !== undefined ? { credentialCommand } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(evaluation !== undefined ? { evaluation } : {}),
  };
}

/// `process` with the SSH destination, gateway, launch definition,
/// credential command, timeout and evaluation of `from`: Edit Process asks
/// for none of them, and keeps them.
export function withExtras<P extends Process>(process: P, from: Extras): P {
  const { ssh: _s, gateway: _g, launch: _l, credentialCommand: _c, timeout: _t, evaluation: _e, ...rest } = process;
  void _s;
  void _g;
  void _l;
  void _c;
  void _t;
  void _e;
  return {
    ...rest,
    ...(from.ssh !== undefined ? { ssh: from.ssh } : {}),
    ...(from.gateway !== undefined ? { gateway: from.gateway } : {}),
    ...(from.launch !== undefined ? { launch: from.launch } : {}),
    ...(from.credentialCommand !== undefined ? { credentialCommand: from.credentialCommand } : {}),
    ...(from.timeout !== undefined ? { timeout: from.timeout } : {}),
    ...(from.evaluation !== undefined ? { evaluation: from.evaluation } : {}),
  } as P;
}

/// The process a connection opened to `opened` is to once the saved process
/// of its label is saved as `saved` (#1988): it takes the timeout, read at
/// each query, and - while `saved` is still where the connection was opened
/// to - the credential command, read at each connect made for it. A command
/// saved for another host, port, user, TLS or tunnel is for that one, and is
/// not run for this connection; its address stays its own either way.
export function resaved<P extends Process>(opened: P, saved: Process): P {
  const moved = passwordsToForget([opened], [saved]).length > 0;
  return withExtras(opened, { ...opened, timeout: saved.timeout, evaluation: saved.evaluation, ...(moved ? {} : { credentialCommand: saved.credentialCommand }) });
}

/// The processes a process file lists, as `parseProcesses` reads them, with
/// their connect scripts. A byte order mark, which Windows editors write, is
/// skipped. Throws a SyntaxError when the text is not JSON.
export function readProcessFile(text: string): { processes: Process[]; problems: string[] } {
  return parseProcesses(JSON.parse(text.replace(/^\uFEFF/, "")), true);
}

/// `next` with what `old`, the process it takes the place of, holds and it
/// does not name: a connect script, gateway server types, a launch
/// definition, a credential command, a timeout, an evaluation.
function withUnnamed(next: Process, old: Process): Process {
  const scripted = next.init !== undefined || next.initFile !== undefined;
  return {
    ...next,
    ...(!scripted && old.init !== undefined ? { init: old.init } : {}),
    ...(!scripted && old.initFile !== undefined ? { initFile: old.initFile } : {}),
    ...(next.gateway === undefined && old.gateway !== undefined ? { gateway: old.gateway } : {}),
    ...(next.launch === undefined && old.launch !== undefined ? { launch: old.launch } : {}),
    ...(next.credentialCommand === undefined && old.credentialCommand !== undefined ? { credentialCommand: old.credentialCommand } : {}),
    ...(next.timeout === undefined && old.timeout !== undefined ? { timeout: old.timeout } : {}),
    ...(next.evaluation === undefined && old.evaluation !== undefined ? { evaluation: old.evaluation } : {}),
  };
}

/// `processes` merged with `incoming`: an incoming process takes the place
/// of the one of its label, and the rest are added after. What the old one
/// holds that the incoming one does not name it keeps, as Edit Process keeps
/// it: a list naming a process by its address only took away its connect
/// script, launch definition, credential command, timeout and gateway types,
/// unasked (#3093). Its TLS, SSH tunnel and tags are the import's to ask of.
export function merge(processes: Process[], incoming: Process[]): Process[] {
  const byLabel = new Map(incoming.map((p) => [p.label, p]));
  const kept = processes.map((p) => {
    const next = byLabel.get(p.label);
    return next === undefined ? p : withUnnamed(next, p);
  });
  const known = new Set(processes.map((p) => p.label));
  return [...kept, ...incoming.filter((p) => !known.has(p.label))];
}

/// The labels of the processes `merge` replaces with one at another host,
/// port or user, or reached another way - TLS or an SSH tunnel added or
/// taken away (#1269): their stored password was given for the old one, and
/// is not to be sent to the new.
export function passwordsToForget(processes: Process[], incoming: Process[]): string[] {
  const byLabel = new Map(incoming.map((p) => [p.label, p]));
  return processes
    .filter((p) => {
      const next = byLabel.get(p.label);
      return (
        next !== undefined &&
        (next.host !== p.host || next.port !== p.port || next.user !== p.user || (next.tls === true) !== (p.tls === true) || next.ssh !== p.ssh)
      );
    })
    .map((p) => p.label);
}

/// Whether `process` comes to be evaluated directly where `old` was not, on
/// a process the read-only guard covers: that turns off the guard's `reval`
/// backstop there (#2496).
function madeDirect(process: Process, old: Process, guardTags: string[]): boolean {
  const guarded = [...old.tags, ...process.tags].some((t) => guardTags.includes(t.trim().toLowerCase()));
  return guarded && process.evaluation === "direct" && old.evaluation !== "direct";
}

/// What of `was`, as a connection to it was made, differs from `now`, its
/// label as saved, of what `passwordsToForget` compares - its address, user,
/// TLS or SSH tunnel - as a clause: "its SSH tunnel was set to bastion"
/// (#2372). Empty when nothing does.
export function editedSince(was: Process, now: Process): string {
  const changes: string[] = [];
  if (now.host !== was.host || now.port !== was.port) changes.push(`it was edited to ${address(now.host, now.port)}`);
  if (now.user !== was.user) changes.push(now.user ? `its user was changed to ${now.user}` : "its user was cleared");
  if ((now.tls === true) !== (was.tls === true)) changes.push(`its TLS was turned ${now.tls === true ? "on" : "off"}`);
  if (now.ssh !== was.ssh) changes.push(now.ssh ? `its SSH tunnel was set to ${now.ssh}` : "its SSH tunnel was cleared");
  return changes.length > 1 ? `${changes.slice(0, -1).join(", ")} and ${changes.at(-1)}` : (changes[0] ?? "");
}

/// The processes in `incoming` that take away what protects the one of
/// their label in `before`: its TLS, its SSH tunnel, a tag of `guardTags`
/// (the read-only guard's), or on a guarded one the reval backstop, by
/// making it `"evaluation": "direct"`. An import asks before taking them,
/// since a list written elsewhere drops them silently (#1269).
export function protectionsRemoved(before: Process[], incoming: Process[], guardTags: string[]): { label: string; what: string[] }[] {
  const had = new Map(before.map((p) => [p.label, p]));
  return incoming
    .map((p) => {
      const old = had.get(p.label);
      const what: string[] = [];
      if (old !== undefined && madeDirect(p, old, guardTags)) {
        what.push('reval backstop ("evaluation": "direct")');
      }
      if (old?.tls === true && p.tls !== true) {
        what.push("TLS");
      }
      if (old?.ssh !== undefined && p.ssh === undefined) {
        what.push("SSH tunnel");
      }
      const kept = new Set(p.tags.map((t) => t.trim().toLowerCase()));
      const tags = (old?.tags ?? []).filter((t) => guardTags.includes(t.trim().toLowerCase()) && !kept.has(t.trim().toLowerCase()));
      if (tags.length > 0) {
        what.push(`tag ${tags.join(", ")}`);
      }
      return { label: p.label, what };
    })
    .filter(({ what }) => what.length > 0);
}

/// `process` with the TLS, SSH tunnel and guarded tags `old` has and it
/// does not, and on a guarded process `old`'s evaluation where it would be
/// made direct: an import taken without removing them.
export function withProtections<P extends Process>(process: P, old: Process | undefined, guardTags: string[]): P {
  if (old === undefined) {
    return process;
  }
  const kept = new Set(process.tags.map((t) => t.trim().toLowerCase()));
  const tags = old.tags.filter((t) => guardTags.includes(t.trim().toLowerCase()) && !kept.has(t.trim().toLowerCase()));
  const { evaluation: _e, ...rest } = process;
  void _e;
  const evaluated = madeDirect(process, old, guardTags) ? ({ ...rest, ...(old.evaluation !== undefined ? { evaluation: old.evaluation } : {}) } as P) : process;
  return {
    ...evaluated,
    ...(old.tls === true ? { tls: true } : {}),
    ...(process.ssh === undefined && old.ssh !== undefined ? { ssh: old.ssh } : {}),
    tags: [...process.tags, ...tags],
  };
}

/// The view's top level: a group per tag, sorted, each holding its processes
/// by label, then the untagged processes. A process with two tags is under
/// both.
export function grouped(processes: Process[]): { tag: string; processes: Process[] }[] {
  const byLabel = (a: Process, b: Process): number => a.label.localeCompare(b.label);
  const tags = [...new Set(processes.flatMap((p) => p.tags))].sort();
  return [
    ...tags.map((tag) => ({ tag, processes: processes.filter((p) => p.tags.includes(tag)).sort(byLabel) })),
    ...(processes.some((p) => p.tags.length === 0)
      ? [{ tag: "", processes: processes.filter((p) => p.tags.length === 0).sort(byLabel) }]
      : []),
  ];
}

/// The colour a tag is shown in: production red, user acceptance blue,
/// development green. Undefined for any other tag.
export function tagColour(tag: string): "red" | "blue" | "green" | undefined {
  switch (tag.toLowerCase()) {
    case "prod":
    case "prd":
    case "production":
      return "red";
    case "uat":
      return "blue";
    case "dev":
    case "development":
      return "green";
    default:
      return undefined;
  }
}

/// The ThemeColor ids a tag can be given from **Edit Tag Color**: the chart
/// colours every theme defines, the most cautious first. A process with
/// tags of two colours takes the one earlier here.
export const TAG_COLOURS = [
  "charts.red",
  "charts.orange",
  "charts.yellow",
  "charts.blue",
  "charts.purple",
  "charts.green",
] as const;

const BUILT_IN = { red: "charts.red", blue: "charts.blue", green: "charts.green" } as const;

/// A ThemeColor id as `contributes.colors` spells one: dotted words.
const COLOUR_ID = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*$/;

/// `q-lint.processes.tagColors` as written: an object from tag to
/// ThemeColor id. Keys are split and lower-cased as tags are (`parseTags`),
/// so `live desk` colours both words (#2526); an entry whose value is not a
/// colour id is dropped, so a typo leaves the built-in colour.
export function tagColours(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [tag, colour] of Object.entries(value as Record<string, unknown>)) {
    if (typeof colour === "string" && COLOUR_ID.test(colour.trim())) {
      for (const key of parseTags(tag)) {
        // Defined, not assigned: `out.__proto__ = ...` would set nothing.
        Object.defineProperty(out, key, { value: colour.trim(), enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return out;
}

/// The ThemeColor id a tag is shown in: the setting's, else the built-in
/// (`tagColour`), else none.
export function tagThemeColour(tag: string, overrides: Record<string, string>): string | undefined {
  // Own keys only: a tag named `constructor` is not Object's.
  const key = tag.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(overrides, key)) {
    return overrides[key];
  }
  const builtIn = tagColour(tag);
  return builtIn === undefined ? undefined : BUILT_IN[builtIn];
}

/// The ThemeColor id a process is shown in: of its tags' colours, the one
/// earliest in `TAG_COLOURS`, then the first tag's of any other colour.
export function processThemeColour(process: Process, overrides: Record<string, string>): string | undefined {
  const colours = process.tags.map((t) => tagThemeColour(t, overrides)).filter((c): c is string => c !== undefined);
  return TAG_COLOURS.find((c) => colours.includes(c)) ?? colours[0];
}

/// `overrides` with `tag` given `colour`, or with its entry removed when
/// `colour` is undefined (back to the built-in colour, or none). Keys
/// stay sorted, so the settings file reads in order.
export function withTagColour(
  overrides: Record<string, string>,
  tag: string,
  colour: string | undefined,
): Record<string, string> {
  const key = tag.toLowerCase();
  const entries = Object.entries(overrides).filter(([t]) => t !== key);
  if (colour !== undefined) {
    entries.push([key, colour]);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

/// Where **Edit Tag Color** writes: the workspace settings when they
/// already set `q-lint.processes.tagColors` (a user-level write would be
/// hidden by them), else the user settings, since the process list itself
/// is kept per user and not per workspace.
export function tagColourTarget(inspected: { workspaceValue?: unknown } | undefined): "workspace" | "user" {
  return inspected?.workspaceValue !== undefined ? "workspace" : "user";
}

/// The TLS choices for Add and Edit Process, the current one first so that
/// Enter keeps it. A new process (`current` undefined) starts on No.
export function tlsChoices(
  current: boolean | undefined,
): { label: string; tls: boolean; detail: string; description?: string }[] {
  const no = { label: "No", tls: false, detail: "Plain TCP, as q listens by default" };
  const yes = { label: "Yes", tls: true, detail: "TLS: the process was started with -E 1 or -E 2" };
  const [first, second] = current ? [yes, no] : [no, yes];
  return [current === undefined ? first : { ...first, description: "current" }, second];
}

/// `"50 160"` as console height and width, or undefined when it is not two
/// positive whole numbers - or not a string, as a hand-written setting may be.
export function consoleSize(text: unknown): [number, number] | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2 || !parts.every((p) => /^\d+$/.test(p))) {
    return undefined;
  }
  const [h, w] = parts.map(Number);
  return h > 0 && w > 0 ? [h, w] : undefined;
}

/// A process renamed (`to` its new label) or deleted (`to` null), logged
/// in every window's state with a number one past the last: dashboard
/// tiles and scheduled exports are each workspace's, named by label, and
/// one not open at the time follows when it next opens (#1749).
export interface Relabel {
  n: number;
  from: string;
  to: string | null;
}

/// The relabels a stored value holds, skipping anything else.
export function parseRelabels(value: unknown): Relabel[] {
  return Array.isArray(value)
    ? value.filter((r): r is Relabel => typeof r === "object" && r !== null && Number.isInteger(r.n) && typeof r.from === "string" && (typeof r.to === "string" || r.to === null))
    : [];
}

/// `log` with `from` relabelled `to` after it: its last `keep` entries.
export function withRelabel(log: Relabel[], from: string, to: string | undefined, keep = 100): Relabel[] {
  const n = (log.length > 0 ? log[log.length - 1].n : 0) + 1;
  return [...log, { n, from, to: to ?? null }].slice(-keep);
}

/// The relabels a workspace that applied those to `applied` has still to
/// apply, in order.
export function relabelsAfter(log: Relabel[], applied: number): Relabel[] {
  return log.filter((r) => r.n > applied);
}
