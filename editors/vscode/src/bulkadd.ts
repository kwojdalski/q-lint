// Add Many Processes (#1032), as data: lines pasted into its form read as
// processes, each checked, and the duplicates found. No `vscode` import,
// so node tests it; `bulkaddview.ts` is the form around it.
//
// Two shapes are read:
// - a line per process, `host:port[:label[:tags]]`, an IPv6 host in
//   brackets (`[::1]:5000:local`), tags split as Tag Process splits them;
//   or a q handle, `` `:host:port[:user[:password]] ``, in q's order;
// - CSV with a header row naming its columns: `host` and `port`, and any of
//   `label` (or `name`), `tags` (split at spaces, `;` or `|`), `user` (or
//   `username`, `user name`) and `tls`. A column of another name is not
//   read, and is said not to be.
// A blank line, or one starting `#` or `/`, is skipped. A password column
// is never read: a password is asked for on connect and kept in VS Code's
// secret storage.
import { hostProblem, parseTags, plainHost, portProblem, type Process } from "./processes";

export interface BulkRow {
  /// 1-based line of the text.
  line: number;
  text: string;
  /// The process the line gives, when it gives one.
  process?: Process;
  /// Why it gives none.
  problem?: string;
  /// Its label is already a saved process's, or an earlier line's: it is
  /// not added.
  duplicate?: "saved" | "pasted";
  /// The saved process at the same address, under another label: it is
  /// added, and this says so.
  sameAddressAs?: string;
  /// How the line was read, where it may have meant something else.
  note?: string;
}

/// One CSV line's fields: commas outside double quotes, `""` a quote.
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(field.trim());
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field.trim());
  return out;
}

/// A line's parts: what is before a q handle, the host, the port, and the
/// two fields after them, the last with every colon after it.
const COLONS = /^(`?:)?(\[[^\]]+\]|[^:]*):([^:]*)(?::([^:]*))?(?::(.*))?$/;

/// `host:port[:label[:tags]]` cut into its parts; an IPv6 host is in
/// brackets, as a URL writes one. With `` `: `` or `:` before it the line is
/// a q handle, whose order is q's: `host:port[:user[:password]]`, no host
/// being this machine. Its user is read; its password never is, only said
/// to be there (#3098).
export function colonParts(line: string): { host: string; port: string; label?: string; tags?: string; user?: string; password?: true } | undefined {
  const m = COLONS.exec(line.trim());
  if (m === null || (m[1] === undefined && m[2] === "")) {
    return undefined;
  }
  if (m[1] !== undefined) {
    return { host: m[2] === "" ? "localhost" : m[2], port: m[3], ...((m[4] ?? "").trim() !== "" ? { user: m[4].trim() } : {}), ...((m[5] ?? "") !== "" ? { password: true } : {}) };
  }
  return { host: m[2], port: m[3], ...(m[4] !== undefined ? { label: m[4].trim() } : {}), ...(m[5] !== undefined ? { tags: m[5] } : {}) };
}

const COLUMNS = ["label", "host", "port", "tags", "user", "tls"] as const;
type Column = (typeof COLUMNS)[number];
/// A column that holds a secret: never read, nor shown back.
const SECRET = /^(password|passwd|pwd|pass|secret|token|apikey|api_key|credentials?)$/i;

/// The other names a column is read by, as a spreadsheet's export has
/// them: ignored, `name` and `username` left the process labelled by its
/// address and with no user, the first connect anonymous (#3113).
const ALIASES: Partial<Record<Column, string[]>> = { label: ["name"], user: ["username", "user name"] };

/// The CSV header's columns, when `line` is one: it names `host` and `port`.
/// `unread`: its columns of no name that is read, as it writes them.
function header(line: string): (Partial<Record<Column, number>> & { secret: number[]; unread: string[] }) | undefined {
  const written = csvFields(line);
  // `User Name` and `user_name` are one name.
  const names = written.map((f) => f.toLowerCase().replace(/[\s_]+/g, " "));
  if (!names.includes("host") || !names.includes("port")) {
    return undefined;
  }
  const at: Partial<Record<Column, number>> & { secret: number[]; unread: string[] } = { secret: names.flatMap((n, i) => (SECRET.test(n) ? [i] : [])), unread: [] };
  for (const c of COLUMNS) {
    const i = [c, ...(ALIASES[c] ?? [])].map((n) => names.indexOf(n)).find((n) => n >= 0);
    if (i !== undefined) {
      at[c] = i;
    }
  }
  const read = new Set<number>([...at.secret, ...COLUMNS.flatMap((c) => (at[c] !== undefined ? [at[c]!] : []))]);
  at.unread = written.filter((name, i) => name !== "" && !read.has(i));
  return at;
}

/// The columns of `text`'s CSV header that are not read, as it names them:
/// none when it has no header.
export function columnsNotRead(text: string): string[] {
  const first = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#") && !l.startsWith("/"));
  return (first === undefined ? undefined : header(first))?.unread ?? [];
}

/// What a `tls` cell says, in lower case: yes, and no (an empty one too).
const TLS_YES = ["1", "true", "t", "yes", "y", "on", "tls", "enabled"];
const TLS_NO = ["", "0", "false", "f", "no", "n", "off", "none", "disabled"];

/// A process from its fields, or why there is none.
function processOf(fields: { host: string; port: string; label?: string; tags?: string; user?: string; tls?: string }): Process | string {
  const host = plainHost(fields.host);
  const bad = hostProblem(host) ?? portProblem(fields.port);
  if (bad !== undefined) {
    return bad;
  }
  const port = Number(fields.port.trim());
  const label = fields.label !== undefined && fields.label.trim() !== "" ? fields.label.trim() : `${host.includes(":") ? `[${host}]` : host}:${port}`;
  const user = fields.user?.trim() ?? "";
  // A tls cell says yes or no, in a word known to: `on`, `t`, `tls` and
  // `enabled` were none of the four read as yes, so they were no TLS, and
  // the user and password went in the clear (#3099).
  const tls = fields.tls?.trim().toLowerCase() ?? "";
  if (!TLS_YES.includes(tls) && !TLS_NO.includes(tls)) {
    return `tls is ${JSON.stringify(fields.tls?.trim())}, not yes or no (true, false, 1, 0, on, off), so it was not added rather than connected to without TLS.`;
  }
  return {
    label,
    host,
    port,
    ...(user !== "" ? { user } : {}),
    tags: parseTags(fields.tags ?? ""),
    ...(TLS_YES.includes(tls) ? { tls: true } : {}),
  };
}

/// The rows `text` gives, each checked against the saved `processes` and
/// the lines before it.
export function parseBulk(text: string, processes: Pick<Process, "label" | "host" | "port">[]): BulkRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const saved = new Set(processes.map((p) => p.label));
  const pasted = new Set<string>();
  let csv: ReturnType<typeof header>;
  const rows: BulkRow[] = [];
  lines.forEach((raw, i) => {
    const text = raw.trim();
    if (text === "" || text.startsWith("#") || text.startsWith("/")) {
      return;
    }
    // The first line read may be a CSV header; after it, lines are CSV.
    if (rows.length === 0 && csv === undefined) {
      csv = header(text);
      if (csv !== undefined) {
        return;
      }
    }
    let got: Process | string;
    let shown = text;
    let note: string | undefined;
    if (csv !== undefined) {
      const f = csvFields(text);
      shown = f.map((v, j) => (csv!.secret.includes(j) && v !== "" ? "***" : v)).join(",");
      const at = (c: Column): string | undefined => (csv![c] === undefined ? undefined : f[csv![c]!]);
      got = processOf({ host: at("host") ?? "", port: at("port") ?? "", label: at("label"), tags: at("tags"), user: at("user"), tls: at("tls") });
    } else {
      const parts = colonParts(text);
      got = parts === undefined ? "Not host:port[:label[:tags]]." : processOf(parts);
      if (parts?.password) {
        shown = text.replace(COLONS, (_all, handle: string, host: string, port: string, user: string) => `${handle}${host}:${port}:${user}:***`);
        note = "its password was not read: it is asked for on connect";
      } else if (typeof got !== "string" && parts?.tags !== undefined && got.tags.length > 0) {
        // q's own `host:port:user:password`, pasted without its `:, is this
        // shape too, and was added as fine with the password a tag for all
        // to see: said as it was read, the two can be told apart (#3098).
        note = `labelled ${got.label}, tagged ${got.tags.join(", ")}`;
      }
    }
    const row: BulkRow = { line: i + 1, text: shown };
    if (typeof got === "string") {
      row.problem = got;
    } else {
      row.process = got;
      if (note !== undefined) {
        row.note = note;
      }
      if (saved.has(got.label)) {
        row.duplicate = "saved";
      } else if (pasted.has(got.label)) {
        row.duplicate = "pasted";
      } else {
        // A host name is one host in any case, as qnbrun compares it (#1813).
        const same = processes.find((p) => p.host.toLowerCase() === got.host.toLowerCase() && p.port === got.port);
        if (same !== undefined) {
          row.sameAddressAs = same.label;
        }
      }
      pasted.add(got.label);
    }
    rows.push(row);
  });
  return rows;
}

/// The processes of `rows` that are added: those read, and not duplicates.
export function toAdd(rows: BulkRow[]): Process[] {
  return rows.filter((r) => r.process !== undefined && r.duplicate === undefined).map((r) => r.process!);
}

/// The lines of `text` that `rows` read and did not add - not processes,
/// or duplicates - with a CSV header kept above them, for the form to keep
/// once the rest are added (#2506). Empty when every line was added.
export function leftOver(text: string, rows: BulkRow[]): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const read = new Set(rows.map((r) => r.line));
  const added = new Set(rows.filter((r) => r.process !== undefined && r.duplicate === undefined).map((r) => r.line));
  if (read.size === added.size) {
    return "";
  }
  // A line read that is no row is the CSV header.
  const isHeader = (l: string, i: number): boolean => !read.has(i + 1) && l.trim() !== "" && !l.trim().startsWith("#") && !l.trim().startsWith("/");
  return lines.filter((l, i) => isHeader(l, i) || (read.has(i + 1) && !added.has(i + 1))).join("\n");
}

/// What a row's status column says.
export function rowStatus(row: BulkRow): string {
  if (row.problem !== undefined) {
    return row.problem;
  }
  if (row.duplicate === "saved") {
    return `${row.process!.label} is already in the list: skipped`;
  }
  if (row.duplicate === "pasted") {
    return `${row.process!.label} is on an earlier line: skipped`;
  }
  return ["added", ...(row.note !== undefined ? [row.note] : []), ...(row.sameAddressAs !== undefined ? [`${row.sameAddressAs} is at the same address`] : [])].join("; ");
}

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/// The rows as the form's table, every value escaped; under it the columns
/// `unread` of a CSV header, when there are any.
export function rowsHtml(rows: BulkRow[], unread: string[] = []): string {
  const columns = unread.length > 0 ? `<p class="unread">Column${unread.length === 1 ? "" : "s"} not read: ${escape(unread.join(", "))}.</p>` : "";
  if (rows.length === 0) {
    return `<p class="empty">Nothing to add yet.</p>${columns}`;
  }
  const body = rows
    .map((r) => {
      const p = r.process;
      const kind = r.problem !== undefined ? "bad" : r.duplicate !== undefined ? "dup" : "ok";
      return `<tr class="${kind}"><td>${r.line}</td><td>${escape(p?.label ?? "")}</td><td>${escape(p === undefined ? r.text : `${p.host}:${p.port}`)}</td><td>${escape(p?.tags.join(", ") ?? "")}</td><td>${escape(rowStatus(r))}</td></tr>`;
    })
    .join("");
  const n = toAdd(rows).length;
  return `<table><thead><tr><th>Line</th><th>Label</th><th>Address</th><th>Tags</th><th>Status</th></tr></thead><tbody>${body}</tbody></table><p class="summary">${n} process${n === 1 ? "" : "es"} to add.</p>${columns}`;
}
