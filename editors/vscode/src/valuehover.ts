// The live value hover's data (#940): the value a global has on the
// connected process, size-limited, as the hover shows it. Free of any
// `vscode` import, so a test can drive it; `valuehoverview.ts` registers
// the hover.
//
// `VALUE_PREVIEW` is sent as one lambda with the names q may resolve the
// global to (space-separated: a one-character string reaches q as a char)
// and the most characters to send back; it defines nothing. The first name
// the process defines is read: by `key` of its namespace, so nothing is
// evaluated to find it. A view is named and not evaluated, and a
// partitioned table is not printed, since either could cost the process
// far more than a hover is worth. Anything else is printed as the console
// prints it (`.Q.s`, so within the console's rows and columns), cut at the
// limit, never inside a UTF-8 character (#2071).
//
// A keyed table is type 99 as a dictionary is, so the answer says which.
//
//   `found`name`type`keyed`count`text!(1b;name;type;keyed;count;.Q.s, cut)  or  `found`name`view!(1b;name;1b)  or  (,`found)!,0b

import { UTF8_CUT } from "./qtext";

export const VALUE_PREVIEW = [
  "{[ns;lim]",
  " ns:`$\" \" vs (),ns; lim:\"j\"$lim;",
  " has:{[n] s:` vs n; @[{[s;n] $[1=count s;n in key `.;(last s) in key ` sv -1_s]}[s];n;0b]};",
  " n:first ns where has each ns;",
  " if[null n;:enlist[`found]!enlist 0b];",
  " if[n in views[];:`found`name`view!(1b;n;1b)];",
  " v:get n; qp:$[`qp in key `.Q;@[.Q.qp;v;0b];0b];",
  ` \`found\`name\`type\`keyed\`count\`text!(1b;n;type v;$[99h=type v;98h=type key v;0b];@[count;v;0N];$[1b~qp;\"\";${UTF8_CUT}[lim;.Q.s v]])}`,
].join("\n");

/// The most characters of a value the process sends back.
export const PREVIEW_LIMIT = 2000;

export type Preview =
  | { found: false }
  | { found: true; name: string; view: true }
  | { found: true; name: string; view?: false; type: number; keyed?: true; count?: number; text: string };

const long = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof (v as { toNumber?: unknown } | null)?.toNumber === "function" ? (v as { toNumber: () => number }).toNumber() : undefined;
  return n === undefined || !Number.isFinite(n) || n <= Number.MIN_SAFE_INTEGER ? undefined : n;
};

const text = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.join("") : v === undefined || v === null ? "" : String(v));

/// What `VALUE_PREVIEW` answered. Throws when it is not its answer.
export function readPreview(raw: unknown): Preview {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.found !== "boolean") {
    throw new Error(`the process answered something other than a value: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  if (!r.found) {
    return { found: false };
  }
  const name = text(r.name);
  if (r.view === true) {
    return { found: true, name, view: true };
  }
  const count = long(r.count);
  return { found: true, name, type: long(r.type) ?? 0, ...(r.keyed === true ? { keyed: true } : {}), ...(count !== undefined ? { count } : {}), text: text(r.text) };
}

/// The names to send, as `VALUE_PREVIEW` takes them.
export function previewNames(names: string[]): string {
  return names.filter((n) => /^\.?[A-Za-z][A-Za-z0-9_.]*$/.test(n)).join(" ");
}

/// `s` with what Markdown would read escaped.
const escaped = (s: string): string => s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");

/// `code` fenced, with a fence longer than any run of backticks in it.
function fenced(code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}q\n${code}\n${fence}`;
}

/// What a q type is called, for the hover's heading.
function kind(type: number, partitioned: boolean, keyed: boolean): string {
  if (type === 98) {
    return partitioned ? "partitioned table" : "table";
  }
  if (type === 99) {
    return keyed ? "keyed table" : "dictionary";
  }
  if (type === 100) {
    return "lambda";
  }
  if (type > 100) {
    return "function";
  }
  return type < 0 ? `atom, type ${type}h` : type === 0 ? "list" : `vector, type ${type}h`;
}

/// The hover's Markdown for `preview`, read from `process`; undefined when
/// the process does not define the name.
export function previewMarkdown(preview: Preview, process: string, limit = PREVIEW_LIMIT): string | undefined {
  if (!preview.found) {
    return undefined;
  }
  const head = `**${escaped(preview.name)}** on ${escaped(process)}`;
  if (preview.view === true) {
    return `${head}: a view, not evaluated here.`;
  }
  const partitioned = preview.type === 98 && preview.text === "";
  const keyed = preview.keyed === true;
  const count = preview.count !== undefined && preview.type >= 0 && preview.type < 100 ? `, ${preview.count.toLocaleString("en")} ${preview.type === 98 || keyed ? "rows" : "items"}` : "";
  const parts = [`${head}: ${kind(preview.type, partitioned, keyed)}${count}`];
  if (partitioned) {
    parts.push("Partitioned: not read.");
  } else {
    const shown = preview.text.replace(/\n$/, "");
    parts.push(fenced(shown));
    if (preview.text.length >= limit) {
      parts.push(`The first ${limit.toLocaleString("en")} characters.`);
    }
  }
  return parts.join("\n\n");
}
