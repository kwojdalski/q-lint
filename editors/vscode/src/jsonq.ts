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
// the double nearest, and written so q reads the same double back.
import { plainName, qString, stringLiteral, symbolLiteral } from "./qliteral";
import { floatText } from "./pastetable";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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
  const first = Object.keys(items[0] as object).join("\u0000");
  return Object.keys(items[0] as object).length > 0 && items.every((i) => Object.keys(i as object).join("\u0000") === first);
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
    const keys = Object.keys(items[0]);
    const columns = keys.map((k) => array(items.map((i) => i[k])));
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
  const keys = Object.keys(json);
  if (keys.length === 0) {
    return "(`symbol$())!()";
  }
  // Parenthesised: `a`b!x;y would read as one expression to the right.
  return `(${symbols(keys)})!${array(keys.map((k) => json[k])).replace(/^\(\)$/, "()")}`;
}

/// JSON text as q, or why it is not JSON. A key repeated in an object keeps
/// its last value, as JavaScript reads it.
export function jsonToQ(text: string): { code: string } | { error: string } {
  let parsed: Json;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, "")) as Json;
  } catch (error) {
    return { error: `the clipboard holds no JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { code: value(parsed) };
}

/// The q that `.j.j`s an expression on a process: its value as JSON text.
/// The expression goes as a string to `value`, so it runs in the root
/// context as typed, its assignments global and `x` no parameter.
export function toJsonQuery(expression: string): string {
  return `.j.j value ${stringLiteral(expression)}`;
}
