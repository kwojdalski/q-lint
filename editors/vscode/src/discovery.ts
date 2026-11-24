// Discovery servers, as data: a URL that answers with a JSON list of q
// processes, how one is fetched and read, and how the Processes view shows
// what each one listed. Nothing here imports `vscode`, so all of it is tested
// with node - the fetch against a local HTTP server.
import { grouped, markdownText, parseProcesses, passwordKey, type Process } from "./processes";

export interface DiscoveryServer {
  /// Unique among the discovery servers; names its group in the view and
  /// prefixes its processes' labels when one is connected to.
  label: string;
  url: string;
}

/// What a server last answered. Its processes are kept only here, in memory:
/// they are never written to disk.
export interface ServerState {
  processes: Process[];
  /// What `parseProcesses` said about the entries it skipped.
  problems: string[];
  /// Why the last fetch failed; its processes are then the empty list.
  error?: string;
  loading: boolean;
  /// When the last fetch finished, as `Date.now()`.
  fetchedAt?: number;
  /// Set by Remove Processes: the periodic refresh leaves the server alone
  /// until it is reloaded.
  removed: boolean;
}

export const EMPTY_STATE: ServerState = { processes: [], problems: [], loading: false, removed: false };

/// The longest a fetch waits for the whole answer, and the most it reads.
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/// The most redirects a fetch follows; the auth header only to its origin.
const MAX_REDIRECTS = 20;

/// The `server` of a process from the workspace's shared list (#955), as a
/// discovery server's name is: its label once connected is `.qlint/label`.
export const SHARED_SOURCE = ".qlint";

/// Why `label` cannot name a discovery server, or undefined when it can.
/// A `/` would make a qualified label (`server/process`) ambiguous.
export function serverLabelProblem(label: string, taken: Set<string>): string | undefined {
  const l = label.trim();
  return l === ""
    ? "A label is needed."
    : l.includes("/")
      ? "A discovery server's label cannot hold a /."
      : taken.has(l)
        ? "That label is taken."
        : l === SHARED_SOURCE
          ? "That label names the workspace's shared process list."
          : undefined;
}

/// Why `url` is not one a discovery server can have, or undefined when it is.
/// A user or password in it is refused: fetch sends no such request, and
/// the URL is kept and shown in the clear, unlike the auth header.
export function urlProblem(url: string): string | undefined {
  return schemeProblem(url) ?? (hasCredentials(new URL(url.trim())) ? "Put a user and password in the auth header, not the URL." : undefined);
}

/// Why `url` is not an http or https URL, or undefined when it is.
function schemeProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "Not a URL.";
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : "The URL must be http or https.";
}

const hasCredentials = (url: URL): boolean => url.username !== "" || url.password !== "";
const CREDENTIALS = "its URL holds a user or password: put them in the auth header";

/// The discovery servers a stored JSON value lists; anything that is not one
/// is dropped, and a label seen before is skipped.
export function parseServers(json: unknown): DiscoveryServer[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const seen = new Set<string>();
  const servers: DiscoveryServer[] = [];
  for (const entry of json) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { label, url } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof url !== "string") {
      continue;
    }
    // One with a user or password in its URL is kept, so it can be edited.
    if (serverLabelProblem(label, seen) !== undefined || schemeProblem(url) !== undefined) {
      continue;
    }
    seen.add(label.trim());
    servers.push({ label: label.trim(), url: url.trim() });
  }
  return servers;
}

/// The stored list `json` with the server labelled as the workspace's shared
/// list is - `.qlint`, a label taken up to 0.28 - given another, and that
/// label; undefined when it holds none. Read as it stood, the server was
/// dropped unsaid, and the next save wrote the list without it (#1889).
export function relabelledServers(json: unknown): { servers: unknown[]; to: string } | undefined {
  const shared = (entry: unknown): boolean =>
    typeof entry === "object" && entry !== null && typeof (entry as { label?: unknown }).label === "string" && (entry as { label: string }).label.trim() === SHARED_SOURCE;
  const at = Array.isArray(json) ? json.findIndex(shared) : -1;
  if (!Array.isArray(json) || at < 0) {
    return undefined;
  }
  const taken = new Set(parseServers(json).map((s) => s.label));
  let to = `${SHARED_SOURCE} server`;
  for (let n = 2; taken.has(to); n++) {
    to = `${SHARED_SOURCE} server ${n}`;
  }
  // A second of the label was skipped as a repeat by every version.
  return { servers: json.filter((e, i) => i === at || !shared(e)).map((e) => (shared(e) ? { ...(e as object), label: to } : e)), to };
}

/// The header the stored secret is sent as: `Name: value` names its own
/// header, and anything else is the value of `Authorization` - `Bearer
/// <token>`, `Basic <base64>`. Undefined when there is no secret.
export function authHeader(secret: string | undefined): [string, string] | undefined {
  const s = (secret ?? "").trim();
  if (s === "") {
    return undefined;
  }
  const named = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s+(.+)$/.exec(s);
  return named ? [named[1], named[2]] : ["Authorization", s];
}

/// How a discovered process is named once connected to - in the status bar,
/// the query history and `connectProcess`'s argument - so that it cannot be
/// taken for a saved process of the same label.
export function qualified(server: string, label: string): string {
  return `${server}/${label}`;
}

export interface FetchOptions {
  /// The stored secret, as `authHeader` reads it.
  secret?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/// The processes `url` lists, and what was wrong with the entries it skipped.
/// The answer must be a 2xx, `application/json` (UTF-8, or the charset it
/// names), at most `maxBytes` long and all in within `timeoutMs`; a list
/// of processes or `{processes: [...]}`.
/// Throws an Error saying, in a few words, what went wrong otherwise.
export async function fetchProcesses(url: string, options: FetchOptions = {}): Promise<{ processes: Process[]; problems: string[] }> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const header = authHeader(options.secret);
  // Refused here, since fetch's own errors spell out the URL or the header
  // value, password or secret and all.
  if (hasCredentials(new URL(url))) {
    throw new Error(CREDENTIALS);
  }
  if (header !== undefined && !/^[\t\x20-\x7e\x80-\xff]*$/.test(header[1])) {
    throw new Error("its auth header holds a character HTTP cannot send");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = (): Error => new Error(`no answer within ${timeoutMs / 1000} s`);
  try {
    // Redirects are followed here rather than by fetch, which strips only
    // `Authorization` on the way to another origin: a secret sent under its
    // own name (`X-Api-Key: ...`) would go to wherever the server pointed.
    let response: Response;
    let at = url;
    let send = header;
    for (let hops = 0; ; hops++) {
      try {
        response = await fetch(at, {
          headers: { Accept: "application/json", ...(send ? { [send[0]]: send[1] } : {}) },
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw timedOut();
        }
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
        throw new Error(`could not reach it: ${cause}`);
      }
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null) {
        break;
      }
      await response.body?.cancel().catch(() => {});
      if (hops === MAX_REDIRECTS) {
        throw new Error(`it redirected more than ${MAX_REDIRECTS} times`);
      }
      const next = new URL(location, at);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error(`it redirected to ${next.protocol} URL`);
      }
      if (hasCredentials(next)) {
        throw new Error(`it redirected to a URL that holds a user or password`);
      }
      if (next.origin !== new URL(at).origin) {
        send = undefined;
      }
      at = next.href;
    }
    const refuse = async (why: string): Promise<never> => {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      throw new Error(why);
    };
    if (!response.ok) {
      await refuse(`it answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const type = contentType.split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      await refuse(`it answered ${type === "" ? "with no content type" : type}, not application/json`);
    }
    const tooBig = `its answer is over ${maxBytes} bytes`;
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      await refuse(tooBig);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          await refuse(tooBig);
        }
        chunks.push(chunk);
      }
    } catch (error) {
      throw controller.signal.aborted && !(error instanceof Error && error.message === tooBig) ? timedOut() : error;
    }
    let json: unknown;
    try {
      json = JSON.parse(decode(Buffer.concat(chunks), contentType));
    } catch (error) {
      throw new Error(`its answer is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseProcesses(json);
  } finally {
    clearTimeout(timer);
  }
}

/// `bytes` as text in the charset `contentType` names, UTF-8 when it names
/// none or one TextDecoder does not know; a byte order mark is dropped.
function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/// A row of the Processes view: the saved processes' tag groups and rows, the
/// Discovery Servers group, a server, a process it listed, and a note under a
/// server - why its fetch failed, an entry it skipped, or that it is loading.
export type Row =
  | { kind: "tag"; tag: string; processes: Process[] }
  | { kind: "process"; process: Process }
  | { kind: "servers" }
  | { kind: "server"; server: DiscoveryServer; state: ServerState }
  | { kind: "discovered"; server: string; process: Process }
  /// The workspace's shared process list (#955), its processes under it as
  /// `discovered` rows of the server `SHARED_SOURCE`.
  | { kind: "shared"; file: string; state: ServerState }
  | { kind: "note"; level: "error" | "warning" | "info"; text: string };

export interface Discovered {
  server: DiscoveryServer;
  state: ServerState;
}

/// The most skipped entries shown under a server; the rest are counted.
const PROBLEMS_SHOWN = 10;

/// The children of `row` in the Processes view, or its top level when `row`
/// is undefined: the saved processes grouped by tag as `grouped` groups them,
/// the untagged ones at the top level, then a Discovery Servers group when
/// there is a server. Under a server, its notes come first, then its
/// processes by label.
export function children(saved: Process[], discovered: Discovered[], row?: Row, shared?: Discovered): Row[] {
  if (row === undefined) {
    return [
      ...grouped(saved).flatMap((group): Row[] =>
        group.tag === ""
          ? group.processes.map((process): Row => ({ kind: "process", process }))
          : [{ kind: "tag", tag: group.tag, processes: group.processes }],
      ),
      ...(shared !== undefined ? [{ kind: "shared", file: shared.server.url, state: shared.state } as const] : []),
      ...(discovered.length > 0 ? [{ kind: "servers" } as const] : []),
    ];
  }
  switch (row.kind) {
    case "shared":
      return serverChildren({ label: SHARED_SOURCE, url: row.file }, row.state);
    case "tag":
      return row.processes.map((process) => ({ kind: "process", process }));
    case "servers":
      return [...discovered]
        .sort((a, b) => a.server.label.localeCompare(b.server.label))
        .map(({ server, state }) => ({ kind: "server", server, state }));
    case "server":
      return serverChildren(row.server, row.state);
    default:
      return [];
  }
}

function serverChildren(server: DiscoveryServer, state: ServerState): Row[] {
  const note = (level: "error" | "warning" | "info", text: string): Row => ({ kind: "note", level, text });
  if (state.error !== undefined) {
    return [note("error", `Could not load: ${state.error}.`)];
  }
  if (state.removed) {
    return [note("info", "Processes removed. Reload to list them again.")];
  }
  if (state.fetchedAt === undefined) {
    return [note("info", state.loading ? "Loading..." : "Not loaded yet. Reload to list its processes.")];
  }
  const problems = state.problems.slice(0, PROBLEMS_SHOWN).map((p) => note("warning", `Skipped: ${p}`));
  const more = state.problems.length - PROBLEMS_SHOWN;
  return [
    ...problems,
    ...(more > 0 ? [note("warning", `Skipped ${more} more.`)] : []),
    ...(state.processes.length === 0 && state.problems.length === 0 ? [note("info", "It lists no processes.")] : []),
    ...[...state.processes]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((process): Row => ({ kind: "discovered", server: server.label, process })),
  ];
}

/// A server row's tooltip, as Markdown: its label and URL as written, and
/// `fetched`, when it was last fetched, as the caller words it.
export function serverTooltip(server: DiscoveryServer, fetched?: string): string {
  return [`**${markdownText(server.label)}**`, markdownText(server.url), ...(fetched === undefined ? [] : [`last fetched ${fetched}`])].join("\n\n");
}

/// What a server's row says beside its label.
export function serverDescription(state: ServerState): string {
  if (state.loading) {
    return "loading";
  }
  if (state.error !== undefined) {
    return "failed";
  }
  if (state.removed || state.fetchedAt === undefined) {
    return "";
  }
  const n = state.processes.length;
  return `${n} process${n === 1 ? "" : "es"}`;
}

/// The discovered process `name` names, with its label qualified and its
/// server: either
/// `server/label`, or a bare label only one server lists. Undefined when it
/// names none, or a bare label several servers list.
export function findDiscovered(discovered: Discovered[], name: string): Process | undefined {
  const all = discovered.flatMap(({ server, state }) =>
    state.processes.map((process) => ({ server: server.label, process })),
  );
  const exact = all.find(({ server, process }) => qualified(server, process.label) === name);
  const bare = all.filter(({ process }) => process.label === name);
  const hit = exact ?? (bare.length === 1 ? bare[0] : undefined);
  return hit && { ...hit.process, label: qualified(hit.server, hit.process.label), server: hit.server };
}

/// The processes Download Processes adds to the saved list: those whose label
/// no saved process has, under their own label. The rest are skipped, never
/// replaced: a saved process is the user's, and a server's list should not
/// overwrite it.
export function toDownload(saved: Process[], listed: Process[]): { added: Process[]; skipped: string[] } {
  const taken = new Set(saved.map((p) => p.label));
  return {
    added: listed.filter((p) => !taken.has(p.label)),
    skipped: listed.filter((p) => taken.has(p.label)).map((p) => p.label),
  };
}

/// The passwords Download Processes copies, as [from, to] secret keys and
/// the label saved under: each downloaded process with a user takes the one
/// given when it was connected to from `server`, which a saved process
/// would otherwise never be asked for.
export function downloadedPasswords(server: string, added: Process[]): [string, string, string][] {
  return added
    .filter((p) => p.user !== undefined)
    .map((p) => [passwordKey({ label: qualified(server, p.label), server }), passwordKey({ label: p.label }), p.label]);
}
