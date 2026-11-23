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

/// A layout as stored, or undefined when it is not one.
export function parseLayout(x: unknown): ColumnLayout | undefined {
  if (!isObject(x)) {
    return undefined;
  }
  const widths: Record<string, number> = {};
  if (isObject(x.widths)) {
    for (const [name, w] of Object.entries(x.widths)) {
      if (typeof w === "number" && Number.isFinite(w) && w >= 24 && w <= 2000) {
        widths[name] = Math.round(w);
      }
    }
  }
  const frozen = typeof x.frozen === "number" && Number.isInteger(x.frozen) && x.frozen >= 0 && x.frozen <= 50 ? x.frozen : 0;
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
        colours[name] = c;
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
        charts[name] = c;
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
        out[name] = parsed;
      }
    }
  }
  return out;
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
    out[name] = look;
  }
  return out;
}

/// The looks after the saved query `from` was renamed `to`.
export function renamedLook(looks: Record<string, ResultLook>, from: string, to: string): Record<string, ResultLook> {
  if (!(from in looks)) {
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
    charts[column] = chart;
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

/// Text as an Excel formula's string literal.
const formulaText = (text: string): string => `"${text.replace(/"/g, '""')}"`;

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
/// their text as shown) and a text rule on dates, times and booleans,
/// which Excel holds as numbers, are left out.
export function xlsxRules(
  rules: FormatRule[],
  names: string[],
  numeric: boolean[],
  letter: (i: number) => string,
  last: number,
  text: boolean[] = numeric.map((n) => !n),
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
    const s = rule.style;
    const font = s.color !== undefined || s.bold ? `<font>${s.bold ? "<b/>" : ""}${s.color !== undefined ? `<color rgb="${argb(PALETTE[s.color])}"/>` : ""}</font>` : "";
    const fill = s.background !== undefined ? `<fill><patternFill patternType="solid"><bgColor rgb="${argb(PALETTE[s.background])}"/></patternFill></fill>` : "";
    const dxf = dxfs.length;
    dxfs.push(`<dxf>${font}${fill}</dxf>`);
    const col = letter(c);
    const range = `${col}2:${col}${last}`;
    const first = `${col}2`;
    // A later rule wins in the grid: in Excel, a higher priority (lower number).
    const at = ` dxfId="${dxf}" priority="${priority--}"`;
    let cf: string;
    if (rule.op === "top" || rule.op === "bottom") {
      cf = `<cfRule type="top10"${at} rank="${Number(rule.value)}"${rule.op === "bottom" ? ' bottom="1"' : ""}/>`;
    } else {
      const want = formulaText(String(rule.value));
      const formula = numeric[c]
        ? `AND(ISNUMBER(${first}),${first}${rule.op}${Number(rule.value)})`
        : rule.op === "contains"
          ? `AND(LEN(${first})>0,ISNUMBER(FIND(LOWER(${want}),LOWER(${first}))))`
          : `AND(LEN(${first})>0,${rule.op === "=" ? "" : "NOT("}EXACT(${first},${want})${rule.op === "=" ? "" : ")"})`;
      cf = `<cfRule type="expression"${at}><formula>${xmlAttr(formula)}</formula></cfRule>`;
    }
    formatting.push(`<conditionalFormatting sqref="${range}">${cf}</conditionalFormatting>`);
  });
  return { dxfs, formatting };
}

/// Text in XML character data or an attribute.
export function xmlAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
