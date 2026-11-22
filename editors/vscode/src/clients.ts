// The Connected Clients view (#1040), as data: the q that reads the
// connected process's open handles in one call, and the rows it gives. No
// `vscode` import, so node tests it; `adminviews.ts` is the view.
//
// `.z.W` gives each handle and what is queued on it (a byte count in kdb+
// 4, a list of message sizes before it, so it is summed). `-38!` says what
// kind of socket it is - TCP or a Unix socket, TLS, a WebSocket - where the
// interpreter has it. q keeps no address or user for a handle other than
// the caller's own, so those come only from TorQ's `.clients.clients`,
// when the process records them. The handles include those the process
// opened itself. Every read is trapped; nothing is kept on the process.

export const CLIENTS = [
  "{[]",
  " h:key .z.W;",
  " n:{$[0h>type x;x;sum x]}each value .z.W;",
  ' k:{@[{d:-38!x;$[99h=type d;(("tcp";"unix")"u"=d`f),$[d`z;" TLS";""],$["w"=d`p;" websocket";""];""]};x;""]}each h;',
  " c:@[{0!get x};`.clients.clients;()];",
  ' u:$[.Q.qt c;{$[null x;"";string x]}each(exec w!u from c)h;count[h]#enlist""];',
  ' ip:$[.Q.qt c;{$[null x;"";string x]}each(exec w!ipa from c)h;count[h]#enlist""];',
  " `handle`queued`self`kind`user`host`tracked!(\"f\"$h;\"f\"$n;h=.z.w;k;u;ip;.Q.qt c)}",
].join("\n");

export interface ClientRow {
  handle: number;
  queued: number;
  /// The handle this extension's own connection came in on.
  self: boolean;
  kind: string;
  user: string;
  host: string;
}

const list = <T>(v: unknown, f: (x: unknown) => T): T[] => (Array.isArray(v) ? v.map(f) : v === undefined || v === null ? [] : [f(v)]);

/// The rows `CLIENTS` answered, and whether the process records its
/// clients (TorQ). Throws when the answer is not one.
export function readClients(raw: unknown): { rows: ClientRow[]; tracked: boolean } {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || !("handle" in r)) {
    throw new Error("the process did not answer with its handles");
  }
  const handles = list(r.handle, Number);
  const queued = list(r.queued, Number);
  const self = list(r.self, (x) => x === true);
  const text = (v: unknown): string[] => (typeof v === "string" ? [v] : list(v, (x) => (x === null || x === undefined ? "" : String(x))));
  const kind = text(r.kind);
  const user = text(r.user);
  const host = text(r.host);
  return {
    rows: handles.map((handle, i) => ({ handle, queued: queued[i] ?? 0, self: self[i] ?? false, kind: kind[i] ?? "", user: user[i] ?? "", host: host[i] ?? "" })),
    tracked: r.tracked === true,
  };
}

/// A row's description: its kind, who and where, and what is queued.
export function clientDescription(row: ClientRow): string {
  const who = row.user !== "" || row.host !== "" ? `${row.user}${row.user !== "" && row.host !== "" ? "@" : ""}${row.host}` : "";
  return [row.kind, who, row.queued > 0 ? `${row.queued} B queued` : "", row.self ? "this connection" : ""].filter((s) => s !== "").join(" · ");
}

/// The q that closes `handle`.
export function closeCode(handle: number): string {
  return `hclose ${Math.trunc(handle)}i`;
}
