// How a notebook cell asks for its output: comment lines at its top.
//
//   / @console            the result as the process formats it (the default)
//   / @grid               a table as an HTML table
//   / @chart line         a table as a chart: line, bar, scatter or histogram
//
// They are q comments, so the cell runs the same in a notebook, a query or
// an exported script. Only the lines before the first that is neither blank
// nor a directive are read; a later `/ @grid` is an ordinary comment.

export const CHART_KINDS = ["line", "bar", "scatter", "histogram"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export type CellMode = { mode: "console" } | { mode: "grid" } | { mode: "chart"; chart: ChartKind };

export type Directive = CellMode | { problem: string };

const DIRECTIVE = /^\/\s*@(\S*)\s*(.*?)\s*$/;

/// What the cell's leading directives ask for: the last one wins. A directive
/// this does not know, or a chart of no known kind, is a problem the cell
/// reports instead of running.
export function cellDirective(source: string): Directive {
  let found: CellMode = { mode: "console" };
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const match = DIRECTIVE.exec(line.trimEnd());
    if (match === null) {
      break;
    }
    const [, name, rest] = match;
    if (name === "console" || name === "grid") {
      if (rest !== "") {
        return { problem: `\`/ @${name}\` takes nothing after it, and was given "${rest}".` };
      }
      found = { mode: name };
    } else if (name === "chart") {
      const kind = CHART_KINDS.find((k) => k === rest);
      if (kind === undefined) {
        return {
          problem: `\`/ @chart\` takes one of ${CHART_KINDS.join(", ")}${rest === "" ? "" : `, and was given "${rest}"`}.`,
        };
      }
      found = { mode: "chart", chart: kind };
    } else {
      return { problem: `\`/ @${name}\` is not a cell directive. They are \`/ @console\`, \`/ @grid\` and \`/ @chart <${CHART_KINDS.join("|")}>\`.` };
    }
  }
  return found;
}
