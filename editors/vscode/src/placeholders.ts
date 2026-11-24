// Query placeholders (#911), as data: where `{{name}}` stands in code that
// is about to be sent, and the code once each is given a value. No `vscode`
// import, so node tests it; `live.ts` asks for the values.
//
// A placeholder is found only in code q reads: never in a string or a
// comment, where `{{name}}` is text. Its name is a q name (`a`, `.ns.v`,
// `start_date`), and not `x`, `y` or `z`: `{{x}}` is a lambda in a lambda,
// q's own code, and is left alone. A lambda that reads a global as
// `{{a}}` is still taken for one; `q-lint.query.placeholders.enable` turns
// them off.

import { blockDepth } from "./statements";

/// Where `values` are remembered between queries: `globalState`, under this
/// key, as `{ [name]: value }`.
export const PLACEHOLDER_VALUES_KEY = "q-lint.placeholderValues";
/// The most names remembered: the oldest is forgotten first.
export const REMEMBERED_LIMIT = 100;
/// The most text the values remembered hold between them, in characters
/// (#1880): a value is typed or pasted, and of any length.
export const REMEMBERED_CHARS = 100_000;

export interface PlaceholderSettings {
  enabled: boolean;
}

/// The settings read as `readLive` reads the query ones, at each query.
export function readPlaceholders(get: <T>(key: string, fallback: T) => T): PlaceholderSettings {
  return { enabled: get<unknown>("query.placeholders.enable", true) !== false };
}

export interface Placeholder {
  name: string;
  /// Offsets of the `{{` and just past the `}}` in the code.
  start: number;
  end: number;
}

const PLACEHOLDER = /\{\{[ \t]*(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)[ \t]*\}\}/y;
/// q's implicit parameters: `{{x}}` is a lambda returning its argument.
const IMPLICIT = new Set(["x", "y", "z"]);

/// Every placeholder in `code` outside strings and comments, in order.
export function placeholders(code: string): Placeholder[] {
  const found: Placeholder[] = [];
  let inString = false;
  let depth = 0;
  let offset = 0;
  for (const raw of code.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const start = offset;
    offset += raw.length + 1;
    if (!inString) {
      // A line of `/` alone opens a block comment, one of `\` alone closes it.
      if (depth > 0 || line.trimEnd() === "/") {
        depth = blockDepth(depth, line.trimEnd());
        continue;
      }
      if (line.trimEnd() === "\\") {
        // The end of the script: nothing after it is sent (#1471).
        break;
      }
      if (line.startsWith("/")) {
        continue;
      }
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inString) {
        if (c === "\\") {
          i++;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === "/" && (line[i - 1] === " " || line[i - 1] === "\t")) {
        break;
      } else if (c === "{" && line[i + 1] === "{") {
        PLACEHOLDER.lastIndex = i;
        const m = PLACEHOLDER.exec(line);
        if (m !== null && !IMPLICIT.has(m[1])) {
          found.push({ name: m[1], start: start + i, end: start + i + m[0].length });
          i += m[0].length - 1;
        }
      }
    }
  }
  return found;
}

/// The names of `code`'s placeholders, each once, in the order they first
/// stand.
export function placeholderNames(code: string): string[] {
  return [...new Set(placeholders(code).map((p) => p.name))];
}

/// `code` with each placeholder replaced by its value in `values`, as
/// written: a value is q text (`` `AAPL ``, `2024.01.01`, `"a b"`), not
/// quoted here. One with no value is left as it is.
export function substitute(code: string, values: Record<string, string>): string {
  let out = "";
  let at = 0;
  for (const p of placeholders(code)) {
    if (!Object.prototype.hasOwnProperty.call(values, p.name)) {
      continue;
    }
    out += code.slice(at, p.start) + values[p.name];
    at = p.end;
  }
  return out + code.slice(at);
}

/// What `globalState` holds once `given` are remembered over `stored`: the
/// names just given last, so the oldest go first past `REMEMBERED_LIMIT`
/// and past `REMEMBERED_CHARS` between them. A value longer than that by
/// itself is not remembered, and nor is the one given for its name before.
export function remembered(stored: unknown, given: Record<string, string>): Record<string, string> {
  const kept: [string, string][] = [];
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof value === "string" && !Object.prototype.hasOwnProperty.call(given, name)) {
        kept.push([name, value]);
      }
    }
  }
  const fitting = [...kept, ...Object.entries(given)].filter(([, value]) => value.length <= REMEMBERED_CHARS).slice(-REMEMBERED_LIMIT);
  let room = REMEMBERED_CHARS;
  let from = fitting.length;
  while (from > 0 && (room -= fitting[from - 1][1].length) >= 0) {
    from--;
  }
  const all = fitting.slice(from);
  const out: Record<string, string> = {};
  for (const [name, value] of all) {
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/// The value last given for `name`, from what `globalState` holds.
export function lastValue(stored: unknown, name: string): string | undefined {
  if (typeof stored !== "object" || stored === null || !Object.prototype.hasOwnProperty.call(stored, name)) {
    return undefined;
  }
  const value = (stored as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}
