// The q processes a user can connect to, as data: what one is, how a list of
// them is read from a file, and how the Processes view groups them. Nothing
// here talks to a process or to VS Code, so all of it is tested with node.

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
  // One colon is a port or a scheme; an IPv6 address has two or more.
  if (h.split(":").length === 2) {
    return "A host only: the port is asked for next.";
  }
  return /[\s/\\]/.test(h) ? "A host has no spaces or slashes." : undefined;
}

/// `host:port` as it is shown, an IPv6 host in brackets so the port is not
/// read as part of it.
export function address(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
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
/// already seen is skipped, so an import cannot hold two of one name.
export function parseProcesses(json: unknown): { processes: Process[]; problems: string[] } {
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
    const bad = portProblem(port);
    if (bad !== undefined) {
      problems.push(`${where} (${label}): ${bad}`);
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
      ...(typeof e.user === "string" && e.user !== "" ? { user: e.user } : {}),
      tags,
      ...(e.tls === true ? { tls: true } : {}),
    });
  });
  return { processes, problems };
}

/// The processes a process file lists, as `parseProcesses` reads them. A
/// byte order mark, which Windows editors write, is skipped. Throws a
/// SyntaxError when the text is not JSON.
export function readProcessFile(text: string): { processes: Process[]; problems: string[] } {
  return parseProcesses(JSON.parse(text.replace(/^\uFEFF/, "")));
}

/// `processes` merged with `incoming`: an incoming process replaces the one
/// of its label, and the rest are added after.
export function merge(processes: Process[], incoming: Process[]): Process[] {
  const byLabel = new Map(incoming.map((p) => [p.label, p]));
  const kept = processes.map((p) => byLabel.get(p.label) ?? p);
  const known = new Set(processes.map((p) => p.label));
  return [...kept, ...incoming.filter((p) => !known.has(p.label))];
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
/// ThemeColor id. Keys are lower-cased, as tags are; an entry whose value is
/// not a colour id is dropped, so a typo leaves the built-in colour.
export function tagColours(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [tag, colour] of Object.entries(value as Record<string, unknown>)) {
    const key = tag.trim().toLowerCase();
    if (key !== "" && typeof colour === "string" && COLOUR_ID.test(colour.trim())) {
      // Defined, not assigned: `out.__proto__ = ...` would set nothing.
      Object.defineProperty(out, key, { value: colour.trim(), enumerable: true, writable: true, configurable: true });
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
/// positive whole numbers.
export function consoleSize(text: string): [number, number] | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2 || !parts.every((p) => /^\d+$/.test(p))) {
    return undefined;
  }
  const [h, w] = parts.map(Number);
  return h > 0 && w > 0 ? [h, w] : undefined;
}
