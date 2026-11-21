// Query placeholders (#911), as data: where `{{name}}` stands in code that
// is about to be sent, and the code once each is given a value. No `vscode`
// import, so node tests it; `live.ts` asks for the values.
//
// A placeholder is found only in code q reads: never in a string or a
// comment, where `{{name}}` is text. Its name is a q name (`a`, `.ns.v`,
// `start_date`), and not `x`, `y` or `z`: `{{x}}` is a lambda in a lambda,
// q's own code, and is left alone. A lambda that reads a global as
// `{{a}}` is still taken for one; `q-lint.query.placeholders` turns them off.

/// Where `values` are remembered between queries: `globalState`, under this
/// key, as `{ [name]: value }`.
export const PLACEHOLDER_VALUES_KEY = "q-lint.placeholderValues";
/// The most names remembered: the oldest is forgotten first.
export const REMEMBERED_LIMIT = 100;

export interface PlaceholderSettings {
  enabled: boolean;
}

/// The settings read as `readLive` reads the query ones, at each query.
export function readPlaceholders(get: <T>(key: string, fallback: T) => T): PlaceholderSettings {
  return { enabled: get<unknown>("query.placeholders", true) !== false };
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
  let inBlock = false;
  let offset = 0;
  for (const raw of code.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const start = offset;
    offset += raw.length + 1;
    if (!inString) {
      // A line of `/` alone opens a block comment, one of `\` alone closes it.
      if (inBlock) {
        inBlock = line.trimEnd() !== "\\";
        continue;
      }
      if (line.trimEnd() === "/") {
        inBlock = true;
        continue;
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
/// names just given last, so the oldest go first past `REMEMBERED_LIMIT`.
export function remembered(stored: unknown, given: Record<string, string>): Record<string, string> {
  const kept: [string, string][] = [];
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof value === "string" && !Object.prototype.hasOwnProperty.call(given, name)) {
        kept.push([name, value]);
      }
    }
  }
  const all = [...kept, ...Object.entries(given)].slice(-REMEMBERED_LIMIT);
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
