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
    const host = typeof e.host === "string" ? e.host.trim() : "";
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

/// The colour a process is shown in: its first coloured tag's, the most
/// cautious first.
export function processColour(process: Process): "red" | "blue" | "green" | undefined {
  const colours = process.tags.map(tagColour);
  return (["red", "blue", "green"] as const).find((c) => colours.includes(c));
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
