// JSON written as the q value `.j.k` reads it into (#968), for Paste JSON
// as q. Free of any `vscode` import, so node tests it; `jsonview.ts` reads
// the clipboard, and copies a value from the process as JSON with `.j.j`.
//
// `.j.k`'s rules, which test/jsonq_q.test.js holds against both
// interpreters: a number is a float, a string a char list, null the float
// null `0n`, true and false booleans; an object a dictionary from symbols;
// an array of numbers and nulls a float vector, of booleans a boolean
// vector, of objects with the same keys in the same order a table, and any
// other array a general list. A JSON number is read as JavaScript reads it,
// the double nearest, and written so q reads the same double back - but a
// whole number past what a long holds is +/-2^63, as `.j.k` caps it. A key
// an object repeats is kept each time, as `.j.k` keeps it (#2185).
import { plainName, qString, stringLiteral, symbolLiteral } from "./qliteral";
import { floatText } from "./pastetable";
import { statements } from "./statements";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/// Each object's keys and values in the order the text wrote them, a key
/// repeated each time: `Object.keys` puts integer-like ones first and keeps
/// one of each, and `.j.k` keeps the text's order (#1075) and every key.
const ENTRIES = new WeakMap<object, [string, Json][]>();

function entriesOf(o: { [key: string]: Json }): [string, Json][] {
  return ENTRIES.get(o) ?? Object.entries(o);
}

export function keysOf(o: { [key: string]: Json }): string[] {
  return entriesOf(o).map(([k]) => k);
}

/// `text`, which `JSON.parse` has read, read again with each object's keys
/// and values recorded in order.
export function parseOrdered(text: string): Json {
  let at = 0;
  const space = (): void => {
    while (/\s/.test(text[at] ?? "")) {
      at++;
    }
  };
  const read = (): Json => {
    space();
    const c = text[at];
    if (c === "{") {
      at++;
      const o: { [key: string]: Json } = {};
      const entries: [string, Json][] = [];
      space();
      while (text[at] !== "}") {
        const key = read() as string;
        space();
        at++; // the colon
        const v = read();
        entries.push([key, v]);
        Object.defineProperty(o, key, { value: v, enumerable: true, writable: true, configurable: true });
        space();
        if (text[at] === ",") {
          at++;
          space();
        }
      }
      at++;
      ENTRIES.set(o, entries);
      return o;
    }
    if (c === "[") {
      at++;
      const items: Json[] = [];
      space();
      while (text[at] !== "]") {
        items.push(read());
        space();
        if (text[at] === ",") {
          at++;
        }
        space();
      }
      at++;
      return items;
    }
    const token = c === '"' ? /"(?:[^"\\]|\\.)*"/y : /true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    token.lastIndex = at;
    const m = token.exec(text);
    at += m?.[0].length ?? 1;
    // A whole number a long cannot hold: `.j.k` reads it as 0W or -0W would
    // be, +/-2^63 as a float, where JavaScript reads the double nearest.
    if (m !== null && /^-?\d+$/.test(m[0]) && (BigInt(m[0]) >= 2n ** 63n || BigInt(m[0]) <= -(2n ** 63n))) {
      return m[0].startsWith("-") ? -(2 ** 63) : 2 ** 63;
    }
    return JSON.parse(m?.[0] ?? "null") as Json;
  };
  return read();
}

/// A float atom's literal: `0n` for a null, `1f` for a whole number.
function float(x: number | null): string {
  return x === null ? "0n" : x === Infinity ? "0w" : x === -Infinity ? "-0w" : floatText(x);
}

/// Symbols side by side when each is bare, `` `a`b ``; else `` `$("a b";"c") ``.
function symbols(keys: string[]): string {
  if (keys.length === 0) {
    return "`$()";
  }
  const bare = keys.map(symbolLiteral);
  if (bare.every((s) => /^`[A-Za-z0-9_.]*$/.test(s))) {
    return keys.length === 1 ? `enlist ${bare[0]}` : bare.join("");
  }
  return keys.length === 1 ? `enlist \`$${qString(keys[0])}` : `\`$(${keys.map(qString).join(";")})`;
}

/// Whether every item is an object with the keys of the first, in order.
function sameKeys(items: Json[]): items is { [key: string]: Json }[] {
  if (!items.every((i) => i !== null && typeof i === "object" && !Array.isArray(i))) {
    return false;
  }
  const first = keysOf(items[0] as { [key: string]: Json }).join("\u0000");
  return keysOf(items[0] as { [key: string]: Json }).length > 0 && items.every((i) => keysOf(i as { [key: string]: Json }).join("\u0000") === first);
}

/// A list's items as one q list: `enlist x` for one, `(x;y)` for more.
function list(items: string[]): string {
  return items.length === 0 ? "()" : items.length === 1 ? `enlist ${items[0]}` : `(${items.join(";")})`;
}

/// An array as `.j.k` reads it.
function array(items: Json[]): string {
  if (items.length === 0) {
    return "()";
  }
  if (items.every((i) => i === null || typeof i === "number")) {
    const all = items.map((i) => float(i as number | null));
    if (all.length === 1) {
      return `enlist ${all[0]}`;
    }
    const bare = all.map((s) => s.replace(/f$/, ""));
    return bare.some((s) => /[.enw]/.test(s)) ? bare.join(" ") : `${bare.join(" ")}f`;
  }
  if (items.every((i) => typeof i === "boolean")) {
    return items.length === 1 ? `enlist ${items[0] ? 1 : 0}b` : `${items.map((b) => (b ? 1 : 0)).join("")}b`;
  }
  if (sameKeys(items)) {
    const keys = keysOf(items[0]);
    // By place: a key repeated is a column each time.
    const columns = keys.map((_, c) => array(items.map((i) => entriesOf(i)[c][1])));
    if (keys.every(plainName) && new Set(keys).size === keys.length) {
      return `([] ${keys.map((k, c) => `${k}:${columns[c]}`).join("; ")})`;
    }
    return `flip (${symbols(keys)})!${list(columns)}`;
  }
  return list(items.map(value));
}

/// A JSON value as the q expression that gives what `.j.k` gives for it.
export function value(json: Json): string {
  if (json === null) {
    return "0n";
  }
  if (typeof json === "boolean") {
    return json ? "1b" : "0b";
  }
  if (typeof json === "number") {
    return float(json);
  }
  if (typeof json === "string") {
    return qString(json);
  }
  if (Array.isArray(json)) {
    return array(json);
  }
  const entries = entriesOf(json);
  if (entries.length === 0) {
    return "(`symbol$())!()";
  }
  // Parenthesised: `a`b!x;y would read as one expression to the right.
  return `(${symbols(entries.map(([k]) => k))})!${array(entries.map(([, v]) => v)).replace(/^\(\)$/, "()")}`;
}

/// JSON text as q, or why it is not JSON.
export function jsonToQ(text: string): { code: string } | { error: string } {
  const json = text.replace(/^﻿/, "");
  try {
    JSON.parse(json);
  } catch (error) {
    return { error: `the clipboard holds no JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { code: value(parseOrdered(json)) };
}

/// The q that `.j.j`s an expression on a process: its value as JSON text.
/// The expression goes as a string to `value`, so it runs in the root
/// context as typed, its assignments global and `x` no parameter. Several
/// statements go each as its own string, cut as a query's are, and the
/// last one's value is the answer: to `value` a newline is a blank, and
/// `bb:1` over `2 3` would be `bb:1 2 3` (#1969).
export function toJsonQuery(expression: string): string {
  const all = statements(expression);
  return all.length < 2 ? `.j.j value ${stringLiteral(all[0] ?? "")}` : `.j.j last value each (${all.map(qString).join(";")})`;
}
