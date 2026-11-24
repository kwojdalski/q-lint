// The Process Monitor (#932): the connected process's memory (`.Q.w[]`),
// its open handles (`.z.W`), its timers and its `\` settings, read in one
// call and shown as a tree. Free of any `vscode` import, so node tests it;
// `infoview.ts` is the VS Code around it and the HDB browser's.
//
// Every value is read on the process into a string or a float - the IPC
// client reads a long as an object and a timestamp as a Date - and every
// read is trapped, so a setting one interpreter lacks (PeachQ's `\C`) says
// so in its row rather than failing the call. Nothing is kept on the
// process. A handle's queue is a count of bytes in kdb+ 4 and a list of
// message sizes before it, so it is summed. A string (`\cd`) or a name is
// sent as it is, not as `-3!` writes it, which cuts it at the console width. The process's command line
// (`.z.x`) is not read: it can hold a password.
//
// TorQ keeps its timers in `.timer.timer`; when that table is there, its
// first 50 rows are listed too. Works on kdb+ (KDB-X) and PeachQ; held there
// by funcsource_q.test.js.
import { bytes } from "./tableinfo";

export const MONITOR = [
  "{[]",
  " s:{@[{$[10h=type v:system x;v;-3!v]};x;{\"error: \",x}]};",
  " w:.Q.w[];",
  " h:.z.W;",
  " tm:@[get;`.timer.timer;()];",
  " tm:$[.Q.qt tm;50 sublist 0!tm;()];",
  " tc:$[count tm;`id`active`period`nextrun`description inter cols tm;`$()];",
  " `memory`handles`timer`ts`torq`settings`process!(",
  "  `key`value!(string key w;\"f\"$value w);",
  "  `handle`queued`self!(\"f\"$key h;\"f\"${$[0h>type x;x;sum x]}each value h;(key h)=.z.w);",
  "  s\"t\";",
  "  @[{200 sublist -3!.z.ts};::;\"\"];",
  "  $[count tm;{-3!'x}each tc#tm;()];",
  "  `key`value!(`p`t`T`g`W`P`c`C`e`s`o`z`S`d`cd;s each(\"p\";\"t\";\"T\";\"g\";\"W\";\"P\";\"c\";\"C\";\"e\";\"s\";\"o\";\"z\";\"S\";\"d\";\"cd\"));",
  "  `key`value!(`version`release`pid`host`os`script`now;(-3!.z.K;-3!.z.k;-3!.z.i;string .z.h;string .z.o;string .z.f;-3!.z.P)))}",
].join("\n");

export const INFO = {
  monitor: "q-lint.processMonitor",
  refreshMonitor: "q-lint.refreshProcessMonitor",
  hdb: "q-lint.hdbBrowser",
  refreshHdb: "q-lint.refreshHdbBrowser",
} as const;

/// The Monitor's seconds between reads while it is shown; 0 is never. At
/// most an hour, the setting's maximum: setInterval runs one too long for it
/// every millisecond (#1110). Whole seconds, as the setting declares; a
/// hand-written 0.5 is the fastest there is, a second, not never (#1851).
export function readMonitorInterval(get: <T>(key: string, fallback: T) => T): number {
  const seconds = get<unknown>("processMonitor.refreshInterval", 0);
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.max(Math.floor(seconds), 1), 3600) : 0;
}

/// A row of the Process Monitor or the HDB browser.
export interface InfoNode {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  children?: InfoNode[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (s === null ? "" : String(s))) : typeof v === "string" ? [v] : []);
const numbers = (v: unknown): (number | null)[] =>
  Array.isArray(v) ? v.map((n) => (typeof n === "number" && Number.isFinite(n) ? n : null)) : typeof v === "number" ? [v] : [];
const booleans = (v: unknown): boolean[] => (Array.isArray(v) ? v.map((b) => b === true) : typeof v === "boolean" ? [v] : []);

/// What each `\` setting is, as the q reference names it.
const SETTINGS: Record<string, string> = {
  p: "listening port",
  t: "timer interval (ms)",
  T: "client query timeout (s)",
  g: "garbage collection mode",
  W: "week offset",
  P: "display precision",
  c: "console size",
  C: "HTTP display size",
  e: "error trap mode",
  s: "secondary threads",
  o: "UTC offset (hours)",
  z: "date parsing format",
  S: "random seed",
  d: "current namespace",
  cd: "working directory",
};

/// Memory statistics that are a count of bytes, shown in KB/MB/GB; `syms`
/// and `symw` are a count of symbols and their bytes.
const NOT_BYTES = new Set(["syms"]);

/// The Monitor's tree from what `MONITOR` answered. Throws when it is not
/// that.
export function monitorTree(raw: unknown, process: string): InfoNode[] {
  const r = raw as Record<string, Record<string, unknown>> | null;
  if (r === null || typeof r !== "object" || typeof r.memory !== "object" || typeof r.settings !== "object") {
    throw new Error(`the process answered something other than its state: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const pairs = (d: Record<string, unknown> | undefined) => {
    const keys = strings(d?.key);
    const values = d?.value;
    return keys.map((k, i) => [k, Array.isArray(values) ? values[i] : undefined] as const);
  };
  const memory = pairs(r.memory).map(([k, v]): InfoNode => ({
    label: k,
    description: typeof v !== "number" ? "" : NOT_BYTES.has(k) ? v.toLocaleString("en-US") : bytes(v),
    ...(typeof v === "number" ? { tooltip: `${k}: ${v.toLocaleString("en-US")}` } : {}),
  }));
  const handles = r.handles as Record<string, unknown> | undefined;
  const ids = numbers(handles?.handle);
  const queued = numbers(handles?.queued);
  const self = booleans(handles?.self);
  const handleRows = ids.map((h, i): InfoNode => ({
    label: String(h ?? "?"),
    description: `${bytes(queued[i] ?? 0)} queued${self[i] ? " · this connection" : ""}`,
    icon: "plug",
  }));
  const torq = Array.isArray(r.torq) ? (r.torq as unknown as Record<string, unknown>[]) : [];
  const timerRows: InfoNode[] = [
    { label: "\\t", description: String(r.timer ?? ""), tooltip: "The timer interval in milliseconds; 0 is off." },
    { label: ".z.ts", description: typeof r.ts === "string" && r.ts !== "" ? r.ts : "not set" },
    ...torq.map((t): InfoNode => ({
      label: `.timer ${String(t.id ?? "")}`,
      description: [t.active === "1b" ? "active" : t.active === "0b" ? "inactive" : "", t.period ? `every ${String(t.period)}` : "", t.nextrun ? `next ${String(t.nextrun)}` : ""]
        .filter((s) => s !== "")
        .join(" · "),
      tooltip: String(t.description ?? ""),
    })),
  ];
  const settings = pairs(r.settings).map(([k, v]): InfoNode => ({
    label: `\\${k}`,
    description: String(v ?? ""),
    tooltip: SETTINGS[k] ?? k,
  }));
  const about = pairs(r.process).map(([k, v]): InfoNode => ({ label: k, description: String(v ?? "") }));
  const used = pairs(r.memory).find(([k]) => k === "used")?.[1];
  return [
    { label: "Process", description: process, icon: "server-process", children: about },
    { label: "Memory", description: typeof used === "number" ? `${bytes(used)} used` : "", icon: "dashboard", children: memory },
    { label: "Handles", description: String(handleRows.length), icon: "plug", children: handleRows },
    { label: "Timers", description: torq.length > 0 ? `\\t ${String(r.timer ?? "")} · ${torq.length} TorQ` : `\\t ${String(r.timer ?? "")}`, icon: "watch", children: timerRows },
    { label: "Settings", description: String(settings.length), icon: "settings-gear", children: settings },
  ];
}
