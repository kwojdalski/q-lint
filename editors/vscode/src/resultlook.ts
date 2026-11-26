// How a result is dressed, as data: conditional formatting rules (#1013),
// the columns drawn as data bars or sparklines (#1014), the column layout
// (#1015) and the chart preset (#1019). No `vscode` import, so node tests it.
//
// A result tab keeps its own look, and a run of the same code again starts
// from it. A result of a saved query (#912) also keeps it for that query,
// in the workspace's storage beside the list, so running the query again
// draws it the same way: the layout as it changes, the rules as they are
// set, and the chart only when Save Chart with Query is chosen. Every part
// names columns by name, so it outlives the run it was made on.
//
// The rules are evaluated by `media/gridlook.js`, which the result page
// runs; the HTML export requires the same file, so a rule colours the same
// cells in the grid and in the file. The Excel export writes each rule as
// Excel's own conditional formatting instead, so it stays live in the sheet.
import type { GridPayload } from "./grid";

/// Where the looks of saved queries are kept: `workspaceState`, by name.
export const SAVED_LOOKS_KEY = "q-lint.savedQueryLooks";

export type RuleOp = ">" | ">=" | "<" | "<=" | "=" | "<>" | "top" | "bottom" | "contains";
export const RULE_OPS: readonly RuleOp[] = [">", ">=", "<", "<=", "=", "<>", "top", "bottom", "contains"];
/// The comparisons a column that is not numeric can make, on its text.
export const TEXT_OPS: readonly RuleOp[] = ["=", "<>", "contains"];

/// The colours a rule can give, as `media/gridlook.js`'s PALETTE.
export const PALETTE = { red: "#f14c4c", green: "#89d185", blue: "#3794ff", orange: "#d18616", yellow: "#cca700", purple: "#b180d7", grey: "#808080" } as const;
export type PaletteColour = keyof typeof PALETTE;

export interface RuleStyle {
  background?: PaletteColour;
  color?: PaletteColour;
  bold?: boolean;
}

/// One conditional formatting rule: the cells of `column` whose value
/// compares to `value` as `op` asks (top and bottom: the `value` greatest
/// or least) take `style`.
export interface FormatRule {
  column: string;
  op: RuleOp;
  value: number | string;
  style: RuleStyle;
}

/// Frozen leading columns, widths in pixels, hidden columns and the order,
/// each by column name.
export interface ColumnLayout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
  frozen: number;
}

/// A chart as the page draws it, by column name.
export interface ChartPreset {
  kind: string;
  series: string[];
  y2?: string;
  bins?: number;
  /// A colour (`#rrggbb`) for some series.
  colours: Record<string, string>;
  /// The map's size and colour columns.
  size?: string;
  colour?: string;
}

export type CellChart = "bar" | "spark" | "text";

export interface ResultLook {
  rules?: FormatRule[];
  /// A column drawn as a data bar or a sparkline, or as text where it
  /// would be one by default.
  cellCharts?: Record<string, CellChart>;
  layout?: ColumnLayout;
  chart?: ChartPreset;
}

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
const isColour = (x: unknown): x is PaletteColour => typeof x === "string" && Object.prototype.hasOwnProperty.call(PALETTE, x);
const HEX = /^#[0-9a-f]{6}$/i;

/// A rule as stored, or undefined when it is not one.
export function parseRule(x: unknown): FormatRule | undefined {
  if (!isObject(x) || typeof x.column !== "string" || !RULE_OPS.includes(x.op as RuleOp)) {
    return undefined;
  }
  const value = typeof x.value === "number" && Number.isFinite(x.value) ? x.value : typeof x.value === "string" ? x.value : undefined;
  if (value === undefined || ((x.op === "top" || x.op === "bottom") && !(typeof value === "number" && Number.isInteger(value) && value >= 1))) {
    return undefined;
  }
  const s = isObject(x.style) ? x.style : {};
  const style: RuleStyle = {
    ...(isColour(s.background) ? { background: s.background } : {}),
    ...(isColour(s.color) ? { color: s.color } : {}),
    ...(s.bold === true ? { bold: true } : {}),
  };
  if (Object.keys(style).length === 0) {
    return undefined;
  }
  return { column: x.column, op: x.op as RuleOp, value, style };
}

/// `map`'s entry `name` set to `value` as its own: a query or a column can
/// be named `__proto__`, which `map[name] = value` takes for the object's
/// prototype, not a key, so the entry was never stored (#1884).
function put<T>(map: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(map, name, { value, enumerable: true, writable: true, configurable: true });
}

/// The narrowest and widest a column is kept, and the most columns frozen:
/// a layout past them is brought to them, not dropped (#1641).
export const COLUMN_WIDTHS = { min: 24, max: 2000 } as const;
export const MAX_FROZEN = 50;

/// A layout as stored, or undefined when it is not one.
export function parseLayout(x: unknown): ColumnLayout | undefined {
  if (!isObject(x)) {
    return undefined;
  }
  const widths: Record<string, number> = {};
  if (isObject(x.widths)) {
    for (const [name, w] of Object.entries(x.widths)) {
      if (typeof w === "number" && Number.isFinite(w)) {
        put(widths, name, Math.round(Math.min(COLUMN_WIDTHS.max, Math.max(COLUMN_WIDTHS.min, w))));
      }
    }
  }
  const frozen = typeof x.frozen === "number" && Number.isInteger(x.frozen) && x.frozen >= 0 ? Math.min(x.frozen, MAX_FROZEN) : 0;
  return { order: strings(x.order), hidden: strings(x.hidden), widths, frozen };
}

/// A chart preset as stored, or undefined when it is not one.
export function parsePreset(x: unknown): ChartPreset | undefined {
  if (!isObject(x) || typeof x.kind !== "string" || !/^[a-z]+$/.test(x.kind)) {
    return undefined;
  }
  const colours: Record<string, string> = {};
  if (isObject(x.colours)) {
    for (const [name, c] of Object.entries(x.colours)) {
      if (typeof c === "string" && HEX.test(c)) {
        put(colours, name, c);
      }
    }
  }
  return {
    kind: x.kind,
    series: strings(x.series),
    ...(typeof x.y2 === "string" ? { y2: x.y2 } : {}),
    ...(typeof x.bins === "number" && Number.isInteger(x.bins) && x.bins >= 1 && x.bins <= 500 ? { bins: x.bins } : {}),
    colours,
    ...(typeof x.size === "string" ? { size: x.size } : {}),
    ...(typeof x.colour === "string" ? { colour: x.colour } : {}),
  };
}

/// A look as stored, its parts that are not ones dropped.
export function parseLook(x: unknown): ResultLook {
  if (!isObject(x)) {
    return {};
  }
  const out: ResultLook = {};
  const rules = Array.isArray(x.rules) ? x.rules.map(parseRule).filter((r): r is FormatRule => r !== undefined) : [];
  if (rules.length > 0) {
    out.rules = rules;
  }
  if (isObject(x.cellCharts)) {
    const charts: Record<string, CellChart> = {};
    for (const [name, c] of Object.entries(x.cellCharts)) {
      if (c === "bar" || c === "spark" || c === "text") {
        put(charts, name, c);
      }
    }
    if (Object.keys(charts).length > 0) {
      out.cellCharts = charts;
    }
  }
  const layout = parseLayout(x.layout);
  if (layout !== undefined) {
    out.layout = layout;
  }
  const chart = parsePreset(x.chart);
  if (chart !== undefined) {
    out.chart = chart;
  }
  return out;
}

/// The looks of saved queries as stored, by name.
export function parseLooks(stored: unknown): Record<string, ResultLook> {
  const out: Record<string, ResultLook> = {};
  if (isObject(stored)) {
    for (const [name, look] of Object.entries(stored)) {
      const parsed = parseLook(look);
      if (Object.keys(parsed).length > 0) {
        put(out, name, parsed);
      }
    }
  }
  return out;
}

/// The look kept under `name`, or undefined: the looks' own entry, not
/// what every object answers for `constructor` or `toString` (#1884).
export function lookOf(looks: Record<string, ResultLook>, name: string): ResultLook | undefined {
  return Object.prototype.hasOwnProperty.call(looks, name) ? looks[name] : undefined;
}

/// The parts of a look a saved query keeps, by which features are on: the
/// rules (conditional formats), the cell charts, the layout, the chart.
export interface LookParts {
  rules: boolean;
  cellCharts: boolean;
  layout: boolean;
  chart: boolean;
}

/// `look` with only the parts `on` allows.
export function lookParts(look: ResultLook, on: LookParts): ResultLook {
  return {
    ...(on.rules && look.rules ? { rules: look.rules } : {}),
    ...(on.cellCharts && look.cellCharts ? { cellCharts: look.cellCharts } : {}),
    ...(on.layout && look.layout ? { layout: look.layout } : {}),
    ...(on.chart && look.chart ? { chart: look.chart } : {}),
  };
}

/// The looks with `name`'s set to `look`, or dropped when it is empty.
export function withLook(looks: Record<string, ResultLook>, name: string, look: ResultLook): Record<string, ResultLook> {
  const out = { ...looks };
  if (Object.keys(look).length === 0) {
    delete out[name];
  } else {
    put(out, name, look);
  }
  return out;
}

/// The looks after the saved query `from` was renamed `to`.
export function renamedLook(looks: Record<string, ResultLook>, from: string, to: string): Record<string, ResultLook> {
  if (!Object.prototype.hasOwnProperty.call(looks, from)) {
    return looks;
  }
  const out = { ...looks, [to]: looks[from] };
  delete out[from];
  return out;
}

/// The looks without the saved query `name`'s.
export function withoutLook(looks: Record<string, ResultLook>, name: string): Record<string, ResultLook> {
  const out = { ...looks };
  delete out[name];
  return out;
}

/// The look with rule `rule` added after the rules it had.
export function withRule(look: ResultLook, rule: FormatRule): ResultLook {
  return { ...look, rules: [...(look.rules ?? []), rule] };
}

/// The look without the rules on `column`.
export function withoutRules(look: ResultLook, column: string): ResultLook {
  const rules = (look.rules ?? []).filter((r) => r.column !== column);
  const out = { ...look };
  if (rules.length > 0) {
    out.rules = rules;
  } else {
    delete out.rules;
  }
  return out;
}

/// The look with `column` drawn as `chart`, or as it would be by default
/// (`undefined`).
export function withCellChart(look: ResultLook, column: string, chart: CellChart | undefined): ResultLook {
  const charts = { ...(look.cellCharts ?? {}) };
  if (chart === undefined) {
    delete charts[column];
  } else {
    put(charts, column, chart);
  }
  const out = { ...look };
  if (Object.keys(charts).length > 0) {
    out.cellCharts = charts;
  } else {
    delete out.cellCharts;
  }
  return out;
}

/// Why `text` cannot be a rule's value for `op` on a column (numeric or
/// not), or undefined when it can.
export function ruleValueProblem(op: RuleOp, text: string, numeric: boolean): string | undefined {
  const t = text.trim();
  if (op === "top" || op === "bottom") {
    return /^\d+$/.test(t) && Number(t) >= 1 ? undefined : "A count: a whole number from 1.";
  }
  if (numeric && op !== "contains") {
    return t !== "" && Number.isFinite(Number(t)) ? undefined : "A number, such as 100 or -0.5.";
  }
  return t === "" && op === "contains" ? "Some text to find." : undefined;
}

/// A rule's value from the text typed for it.
export function ruleValue(op: RuleOp, text: string, numeric: boolean): number | string {
  const t = text.trim();
  return op === "top" || op === "bottom" || (numeric && op !== "contains") ? Number(t) : text;
}

// --- exports

/// A colour as Excel's ARGB.
const argb = (hex: string): string => `FF${hex.slice(1).toUpperCase()}`;

/// Text as an Excel formula's string literal: the characters XML cannot
/// hold dropped, as the cells drop them, and over 255 characters - the
/// most Excel takes in one literal - literals joined with `&` (#2660).
const formulaText = (text: string): string => {
  const kept = text.replace(NOT_XML, "");
  const parts: string[] = [];
  for (let at = 0; at < kept.length || parts.length === 0; ) {
    let end = Math.min(at + 255, kept.length);
    // A surrogate pair is not split between two literals.
    if (end < kept.length && /[\ud800-\udbff]/.test(kept[end - 1])) {
      end--;
    }
    parts.push(`"${kept.slice(at, end).replace(/"/g, '""')}"`);
    at = end;
  }
  return parts.join("&");
};

/// The characters XML 1.0 cannot hold at all, as xlsx.ts's xmlText drops them.
const NOT_XML = /[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10FFFF}]/gu;

/// A top or bottom N rule's Nth greatest or least value of column `c` over
/// every row `payload` holds, ties included, as the grid's rule ranks them;
/// undefined when the column holds no number.
export function rankEdge(payload: GridPayload, c: number, rule: FormatRule): number | undefined {
  const raw = payload.raw[c];
  const n = Math.floor(Number(rule.value));
  if (raw === undefined || raw.length !== payload.cells[c]?.length || !(n >= 1)) {
    return undefined;
  }
  const values = raw.filter((x) => x !== null && x !== undefined).map((x) => Number(x)).filter((x) => !Number.isNaN(x));
  values.sort((a, b) => (rule.op === "top" ? b - a : a - b));
  return values.length === 0 ? undefined : values[Math.min(n, values.length) - 1];
}

/// The rules as Excel conditional formatting for a sheet whose columns are
/// `names` (their letters from `letter`) and whose rows are 2 to
/// `last`: {dxfs, formatting}, the styles for styles.xml's `<dxfs>` and
/// the `<conditionalFormatting>` elements, after `<sheetData>`. `text`:
/// whether a column's cells are written as Excel text. Each rule matches
/// the cells the grid's does (#1266): a comparison of numbers skips an
/// empty cell, which Excel takes for 0; `=` and `<>` on text are
/// case-sensitive and `contains` is not, with no wildcards, none of them
/// matching an empty cell. A rule on a column the sheet does not have, a
/// comparison of numbers on text, `contains` on numbers (the grid reads
/// their text as shown), a text rule on dates, times and booleans,
/// which Excel holds as numbers, and one on a general list whose strings
/// Excel holds without their quotes (#1411), are left out. `edge`, when
/// given, is a top or bottom N rule's Nth value over every row the grid
/// holds, as the grid ranks them: the rule is written as a comparison with
/// it, not ranked over only the rows written (#1648). `longText`, when
/// given, is whether a numeric column holds a long written as text, as
/// one Excel would round is: its comparisons read that text too (#2459).
export function xlsxRules(
  rules: FormatRule[],
  names: string[],
  numeric: boolean[],
  letter: (i: number) => string,
  last: number,
  text: boolean[] = numeric.map((n) => !n),
  edge?: (rule: FormatRule, column: number) => number | undefined,
  infinite?: (column: number) => { pos: boolean; neg: boolean },
  longText?: (column: number) => boolean,
): { dxfs: string[]; formatting: string[] } {
  const dxfs: string[] = [];
  const formatting: string[] = [];
  if (last < 2) {
    return { dxfs, formatting };
  }
  let priority = rules.length;
  rules.forEach((rule) => {
    const c = names.indexOf(rule.column);
    const unusable = numeric[c] ? rule.op === "contains" || (rule.op !== "top" && rule.op !== "bottom" && !Number.isFinite(Number(rule.value))) : !TEXT_OPS.includes(rule.op) || !text[c];
    if (c < 0 || unusable) {
      priority--;
      return;
    }
    const col = letter(c);
    const first = `${col}2`;
    // The Nth value: an infinity is no number in Excel, which then matches
    // every number, or none.
    const nth = (rule.op === "top" || rule.op === "bottom") && edge !== undefined ? edge(rule, c) : undefined;
    const ranked = (rule.op === "top" || rule.op === "bottom") && edge !== undefined;
    // An infinity is written as the text 0w or -0w (0W, -0W: Excel's = is
    // case-blind), which a comparison of numbers never matches: each one
    // the grid's rule matches is matched by its text (#2090).
    const inf = numeric[c] && infinite !== undefined ? infinite(c) : { pos: false, neg: false };
    const matchesInf = (v: number): boolean =>
      ranked ? (rule.op === "top" ? v >= (nth as number) : v <= (nth as number)) : rule.op === ">" ? v > Number(rule.value) : rule.op === ">=" ? v >= Number(rule.value) : rule.op === "<" ? v < Number(rule.value) : rule.op === "<=" ? v <= Number(rule.value) : rule.op === "<>";
    const infTerms = [...(inf.pos && matchesInf(Infinity) ? [`${first}="0w"`] : []), ...(inf.neg && matchesInf(-Infinity) ? [`${first}="-0w"`] : [])];
    // A long written as text is no number to ISNUMBER: its value is
    // compared too, as the grid compares it, a double (#2459).
    const asText = numeric[c] && longText !== undefined && longText(c);
    const compared = (op: string, x: number): string =>
      asText ? `OR(AND(ISNUMBER(${first}),${first}${op}${x}),AND(ISTEXT(${first}),IFERROR(VALUE(${first})${op}${x},FALSE)))` : `AND(ISNUMBER(${first}),${first}${op}${x})`;
    const withInf = (formula: string | undefined): string | undefined => {
      const terms = [...(formula === undefined ? [] : [formula]), ...infTerms];
      return terms.length === 0 ? undefined : terms.length === 1 ? terms[0] : `OR(${terms.join(",")})`;
    };
    if (ranked && (nth === undefined || (nth === (rule.op === "top" ? Infinity : -Infinity) && infTerms.length === 0))) {
      priority--;
      return;
    }
    const s = rule.style;
    const font = s.color !== undefined || s.bold ? `<font>${s.bold ? "<b/>" : ""}${s.color !== undefined ? `<color rgb="${argb(PALETTE[s.color])}"/>` : ""}</font>` : "";
    const fill = s.background !== undefined ? `<fill><patternFill patternType="solid"><bgColor rgb="${argb(PALETTE[s.background])}"/></patternFill></fill>` : "";
    const dxf = dxfs.length;
    dxfs.push(`<dxf>${font}${fill}</dxf>`);
    const range = `${col}2:${col}${last}`;
    // A later rule wins in the grid: in Excel, a higher priority (lower number).
    const at = ` dxfId="${dxf}" priority="${priority--}"`;
    let cf: string;
    if (ranked && nth !== undefined) {
      // Past an infinite Nth value only the infinities themselves match.
      const formula = withInf(
        Number.isFinite(nth)
          ? compared(rule.op === "top" ? ">=" : "<=", nth)
          : nth === (rule.op === "top" ? Infinity : -Infinity)
            ? undefined
            : asText
              ? `OR(ISNUMBER(${first}),ISNUMBER(VALUE(${first})))`
              : `ISNUMBER(${first})`,
      ) as string;
      cf = `<cfRule type="expression"${at}><formula>${xmlAttr(formula)}</formula></cfRule>`;
    } else if (rule.op === "top" || rule.op === "bottom") {
      cf = `<cfRule type="top10"${at} rank="${Number(rule.value)}"${rule.op === "bottom" ? ' bottom="1"' : ""}/>`;
    } else {
      const want = formulaText(String(rule.value));
      const formula = numeric[c]
        ? (withInf(compared(rule.op, Number(rule.value))) as string)
        : rule.op === "contains"
          ? `AND(LEN(${first})>0,ISNUMBER(FIND(LOWER(${want}),LOWER(${first}))))`
          : `AND(LEN(${first})>0,${rule.op === "=" ? "" : "NOT("}EXACT(${first},${want})${rule.op === "=" ? "" : ")"})`;
      cf = `<cfRule type="expression"${at}><formula>${xmlAttr(formula)}</formula></cfRule>`;
    }
    formatting.push(`<conditionalFormatting sqref="${range}">${cf}</conditionalFormatting>`);
  });
  return { dxfs, formatting };
}

/// Text in XML character data or an attribute, without the characters
/// XML cannot hold (#2660).
export function xmlAttr(text: string): string {
  return text.replace(NOT_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
