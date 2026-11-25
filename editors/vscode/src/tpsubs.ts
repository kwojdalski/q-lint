// The tickerplant subscribers view (#1042), as data: one read-only lambda
// that reads `.u.w`, the subscriptions `u.q` keeps - a dictionary of each
// table to its subscribers, each a handle and the symbols it asked for (`
// for all), or on a TorQ segmented or chained tickerplant pubsub.q's
// `.stpps` tables in its place - with each handle's output queue from `.z.W`, its protocol from
// `-38!` where the process has it, and its host where the process records
// one (TorQ's `.clients.clients`; plain q keeps no host for another handle).
// Free of any `vscode` import, so node tests it; `tpsubsview.ts` shows it.
//
// The lambda only reads: it assigns no global and sends nothing to the
// subscribers. Works on kdb+ (KDB-X) and PeachQ; held there by
// processtools_q.test.js.
import { bytesText, isNumber, isString, listOf } from "./processtools";
import type { ToolNode } from "./toolstree";

export const SUBSCRIBERS = [
  "{[x]",
  // TorQ's segmented and chained tickerplants keep no .u.w: pubsub.q's
  // tables of handles taking all of a table, and of filtered ones (#2585),
  // whose where clauses (enlisted as the table keeps them) and columns are
  // shown as the symbols: `sym in` a list as that list, as .u.w's are.
  " ff:{[f;c] while[(1=count f)&(0h=type first f)&not 100h<type first first f;f:first f]; g:$[1=count f;first f;()];",
  "  w:$[(3=count g)&(`sym~g 1)&(in)~first g;\" \" sv string raze last g;count f;\"where \",\", \" sv -3!'f;\"\"];",
  "  w,$[count c;$[count w;\", \";\"\"],\"columns \",\", \" sv string key c;\"\"]};",
  " if[not `w in key `.u;",
  "  if[not `subrequestall in key `.stpps;'\"not a tickerplant: it has no .u.w\"];",
  "  a:.stpps.subrequestall; a:(key[a] except `)#a; f:0!.stpps.subrequestfiltered;",
  "  w:(key a)!{{(x;`)}each x}each value a;",
  "  w:{[w;t;r]w[t]:$[t in key w;w t;()],enlist r;w}/[w;f`tbl;flip(f`handle;ff'[f`filts;f`columns])]];",
  " if[`w in key `.u;w:.u.w; if[not 99h=type w;'\"not a tickerplant: .u.w is not a dictionary\"]];",
  " qs:.z.W; qs:$[0h=type value qs;sum each value qs;value qs]; qs:(key .z.W)!qs;",
  " cl:@[get;`.clients.clients;{()}];",
  " hc:()!(); if[99h=type cl;cl:@[0!;cl;{()}]];",
  " if[98h=type cl;if[`w in cols cl;n:$[`hostname in cols cl;`hostname;`ipa in cols cl;`ipa;`];if[not null n;hc:(cl`w)!string cl n]]];",
  " pr:{r:@[-38!;x;{()}];$[99h=type r;$[`p in key r;$[\"w\"=first r`p;\"websocket\";enlist \"q\"];\"\"];\"\"]};",
  " t:raze{[t;s](count s)#t}'[key w;value w];",
  " s:raze value w;",
  " h:`int$first each s;",
  " (string t;\"f\"$h;{$[x in key y;(),y x;\"\"]}[;hc] each h;\"f\"$0^qs h;{$[10h=type x;x;(::)~x;\"\";all null x;\"\";\" \" sv string (),x]} each last each s;pr each h)}",
].join("\n");

export interface Subscriber {
  table: string;
  handle: number;
  /// Empty when the process keeps no host for the handle.
  host: string;
  /// Bytes waiting to go out to it.
  queue: number;
  /// Empty for every symbol.
  syms: string;
  /// "q", "websocket", or empty when the process cannot say.
  protocol: string;
}

/// What `SUBSCRIBERS` answered. Throws when it is not that shape.
export function readSubscribers(raw: unknown): Subscriber[] {
  const p = raw as unknown[];
  const bad = (): never => {
    throw new Error(`the process answered something other than the subscribers: ${JSON.stringify(raw)?.slice(0, 200)}`);
  };
  if (!Array.isArray(p) || p.length !== 6) {
    return bad();
  }
  // No subscriber answers empty lists; one answers atoms and strings.
  const handles = listOf(p[1], isNumber) ?? (Array.isArray(p[1]) && p[1].length === 0 ? [] : bad());
  const one = handles.length === 1;
  const strings = (v: unknown): string[] => (one && isString(v) ? [v] : Array.isArray(v) && v.length === 0 ? [] : (listOf(v, isString) ?? bad()));
  const tables = strings(p[0]);
  const hosts = strings(p[2]);
  const queues = listOf(p[3], isNumber) ?? (handles.length === 0 ? [] : bad());
  const syms = strings(p[4]);
  const protocols = strings(p[5]);
  if ([tables, hosts, queues, syms, protocols].some((l) => l.length !== handles.length)) {
    return bad();
  }
  return handles.map((handle, i) => ({ table: tables[i], handle, host: hosts[i], queue: queues[i], syms: syms[i], protocol: protocols[i] }));
}

/// The rows of the view: a table, its subscribers under it.
export function subscriberTree(subscribers: Subscriber[]): ToolNode[] {
  const byTable = new Map<string, Subscriber[]>();
  for (const s of subscribers) {
    byTable.set(s.table, [...(byTable.get(s.table) ?? []), s]);
  }
  return [...byTable.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, subs]) => ({
      label: table,
      description: `${subs.length} subscriber${subs.length === 1 ? "" : "s"}`,
      icon: "table",
      children: subs.map((s) => ({
        label: `handle ${s.handle}`,
        description: [s.host || "host not recorded", `queue ${bytesText(s.queue)}`, s.syms === "" ? "all symbols" : s.syms].join("  ·  "),
        tooltip: [
          `Handle ${s.handle}${s.protocol === "" ? "" : ` (${s.protocol})`}`,
          `Host: ${s.host || "not recorded by the process (TorQ's .clients.clients records it)"}`,
          `Output queue: ${bytesText(s.queue)} (.z.W)`,
          `Symbols: ${s.syms === "" ? "all" : s.syms}`,
        ].join("\n"),
        icon: s.queue > 0 ? "warning" : "plug",
      })),
    }));
}
