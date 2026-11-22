// Import connections from qStudio and from KX's kdb VS Code extension
// (#1033), as data. No `vscode` import, so node tests it;
// `importotherview.ts` asks where to read from. A password is never taken
// from either: it is dropped as it is read, and asked for on connect.
//
// qStudio (TimeStored, Apache-2.0) keeps its server list as XStream XML -
// a `<serverlist>` of `<ServerConfig>` elements whose attributes are
// `name`, `host`, `port`, `username`, `password`, `database`, `jdbcType`
// and `folder` - in Java preferences, node `com/timestored/qstudio`, key
// `CONNECTIONS` (and `CONNECTIONS0`.. when it is long), each value
// `XXX_ENCODED_XXX` and the zlib-deflated XML in base64. On Linux that is
// `~/.java/.userPrefs/com/timestored/qstudio/prefs.xml`; on macOS a plist,
// which `plutil` writes as XML. Its **Copy Server List** writes one line a
// server: `[name@][TYPE#]host:port[:user[:password]]`, a name with `/` in
// it being in a folder. Read here: either text, the XML on its own, or a
// preferences file. Only kdb servers (`KDB`, or no type) are taken.
//
// KX's extension (KxSystems/kx-vscode, Apache-2.0) keeps its connections
// in the user settings: `kdb.servers`, an object of
// `{ serverAlias, serverName (the host), serverPort (a string), tls, auth }`,
// and `kdb.labelsConnectionMap`, a list of `{ labelName, connections: [alias] }`
// - read here as tags. Its **Export Connections** writes
// `{ "connections": { "KDB": [...], "Insights": [...] } }`, a KDB entry
// holding a `username` and `password` when auth was included. Insights
// connections are not q processes, and are not taken. Its user name is
// kept with the password in its secret storage, so `kdb.servers` gives
// none.
import { inflateSync } from "node:zlib";
import { hostProblem, parseTags, plainHost, portProblem, type Process } from "./processes";

export interface Imported {
  processes: Process[];
  /// What was not taken, and why.
  skipped: string[];
}

/// XML text as written, its entities read.
export function xmlUnescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[k] ?? whole;
  });
}

/// The process of `label` at `host:port`, or why there is none.
function processOf(label: string, host: string, port: string, user: string | undefined, tags: string[], tls = false): Process | string {
  const h = plainHost(host);
  const bad = hostProblem(h) ?? portProblem(port);
  if (bad !== undefined) {
    return `${label || host}: ${bad}`;
  }
  return {
    label: label.trim() !== "" ? label.trim() : `${h}:${Number(port)}`,
    host: h,
    port: Number(port),
    ...(user !== undefined && user.trim() !== "" ? { user: user.trim() } : {}),
    tags: parseTags(tags.join(",")),
    ...(tls ? { tls: true } : {}),
  };
}

/// Add `got` to `out`, or why not; a label taken once is skipped after.
function keep(out: Imported, got: Process | string, seen: Set<string>): void {
  if (typeof got === "string") {
    out.skipped.push(got);
  } else if (seen.has(got.label)) {
    out.skipped.push(`${got.label}: repeats a label`);
  } else {
    seen.add(got.label);
    out.processes.push(got);
  }
}

/// A qStudio name's folder as a tag: `desk/rdb` is in folder `desk`.
function folderTags(name: string, folder?: string): string[] {
  const at = name.lastIndexOf("/");
  return [...(folder !== undefined && folder.trim() !== "" ? [folder] : []), ...(at > 0 ? [name.slice(0, at)] : [])].map((f) => f.replace(/[/\s]+/g, "-"));
}

/// qStudio's server list lines, as **Copy Server List** writes them.
export function readQStudioLines(text: string): Imported {
  const out: Imported = { processes: [], skipped: [] };
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    let name = "";
    const at = line.indexOf("@");
    if (at > -1) {
      name = line.slice(0, at).trim();
      line = line.slice(at + 1).trim();
    }
    const parts = line.split(":");
    if (parts.length < 2) {
      out.skipped.push(`${name || line}: no host:port`);
      continue;
    }
    let host = parts[0];
    const slash = host.lastIndexOf("/");
    if (slash > -1) {
      // As qStudio reads it: with no name, the folder is on the host.
      name = `${host}:${parts[1]}`;
      host = host.slice(slash + 1);
    }
    const hash = host.indexOf("#");
    if (hash > -1) {
      const type = host.slice(0, hash).trim();
      host = host.slice(hash + 1).trim();
      if (type.toUpperCase() !== "KDB") {
        out.skipped.push(`${name || host}: a ${type} connection, not kdb`);
        continue;
      }
    }
    // parts[3], the password, is never read.
    keep(out, processOf(name.slice(name.lastIndexOf("/") + 1), host, parts[1].trim(), parts[2], folderTags(name)), seen);
  }
  return out;
}

/// qStudio's `<serverlist>` XML.
export function readQStudioXml(xml: string): Imported {
  const out: Imported = { processes: [], skipped: [] };
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<ServerConfig\b([^>]*)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]] = xmlUnescape(a[3] ?? a[4] ?? "");
    }
    const name = attrs.name ?? "";
    const type = attrs.jdbcType ?? "KDB";
    if (type.toUpperCase() !== "KDB") {
      out.skipped.push(`${name || attrs.host || "a server"}: a ${type} connection, not kdb`);
      continue;
    }
    // `password` is never read.
    keep(out, processOf(name.slice(name.lastIndexOf("/") + 1), attrs.host ?? "", attrs.port ?? "", attrs.username, folderTags(name, attrs.folder)), seen);
  }
  return out;
}

/// The XML a qStudio preferences file holds under `CONNECTIONS`, decoded;
/// undefined when it holds none. Throws why it cannot be read.
export function qStudioPrefsXml(text: string): string | undefined {
  const parts = new Map<string, string>();
  // Java's prefs.xml: <entry key="CONNECTIONS0" value="..."/>.
  for (const m of text.matchAll(/<entry\s+key="(CONNECTIONS\d*)"\s+value="([^"]*)"\s*\/>/g)) {
    if (!parts.has(m[1])) parts.set(m[1], xmlUnescape(m[2]));
  }
  // A plist written as XML: <key>CONNECTIONS0</key><string>...</string>.
  for (const m of text.matchAll(/<key>(CONNECTIONS\d*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    if (!parts.has(m[1])) parts.set(m[1], xmlUnescape(m[2]));
  }
  if (!parts.has("CONNECTIONS")) {
    return undefined;
  }
  let joined = parts.get("CONNECTIONS")!;
  for (let i = 0; parts.has(`CONNECTIONS${i}`); i++) {
    joined += parts.get(`CONNECTIONS${i}`);
  }
  if (joined.startsWith("XXX_I_AM_ENCRYPTED_XXX")) {
    throw new Error("it holds the encrypted list of a qStudio from before 2017; open it in a newer qStudio once, or use its Copy Server List");
  }
  if (!joined.startsWith("XXX_ENCODED_XXX")) {
    return joined;
  }
  return inflateSync(Buffer.from(joined.slice("XXX_ENCODED_XXX".length), "base64")).toString("utf8");
}

/// qStudio's servers from whichever of its forms `text` is.
export function readQStudio(text: string): Imported {
  const prefs = /CONNECTIONS/.test(text) ? qStudioPrefsXml(text) : undefined;
  const xml = prefs ?? text;
  if (/<ServerConfig\b/.test(xml)) {
    return readQStudioXml(xml);
  }
  // Some other XML - a preferences file without qStudio's list - is not
  // read as lines.
  return /^\s*</.test(text) ? { processes: [], skipped: ["it holds no qStudio server list"] } : readQStudioLines(text);
}

/// The tags `kdb.labelsConnectionMap` gives each alias.
function kxLabels(map: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!Array.isArray(map)) {
    return out;
  }
  for (const entry of map) {
    const e = entry as { labelName?: unknown; connections?: unknown } | null;
    if (e === null || typeof e !== "object" || typeof e.labelName !== "string" || !Array.isArray(e.connections)) {
      continue;
    }
    for (const alias of e.connections) {
      if (typeof alias === "string") {
        out.set(alias, [...(out.get(alias) ?? []), e.labelName]);
      }
    }
  }
  return out;
}

/// KX's kdb connections: entries of `kdb.servers` or of an export's
/// `connections.KDB`, with `kdb.labelsConnectionMap`'s labels as tags.
export function readKxServers(servers: unknown, labelMap?: unknown): Imported {
  const out: Imported = { processes: [], skipped: [] };
  const seen = new Set<string>();
  const labels = kxLabels(labelMap);
  const entries = Array.isArray(servers) ? servers : typeof servers === "object" && servers !== null ? Object.values(servers) : [];
  for (const entry of entries) {
    const e = entry as Record<string, unknown> | null;
    if (e === null || typeof e !== "object") {
      continue;
    }
    // A local q KX's extension starts itself has no host of its own here.
    const host = typeof e.serverName === "string" ? e.serverName : "";
    const port = typeof e.serverPort === "number" ? String(e.serverPort) : typeof e.serverPort === "string" ? e.serverPort : "";
    const alias = typeof e.serverAlias === "string" ? e.serverAlias : "";
    // `password` is never read.
    keep(out, processOf(alias, host, port, typeof e.username === "string" ? e.username : undefined, labels.get(alias) ?? [], e.tls === true), seen);
  }
  return out;
}

/// An export file of KX's extension.
export function readKxExport(json: unknown): Imported {
  const c = (json as { connections?: { KDB?: unknown; Insights?: unknown } } | null)?.connections;
  if (c === undefined || c === null || typeof c !== "object") {
    throw new Error("expected KX's export, an object with a `connections` object");
  }
  const read = readKxServers(Array.isArray(c.KDB) ? c.KDB : []);
  const insights = Array.isArray(c.Insights) ? c.Insights.length : 0;
  if (insights > 0) {
    read.skipped.push(`${insights} kdb Insights connection(s): not q processes`);
  }
  return read;
}
