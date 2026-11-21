// How a notebook cell asks for its output: comment lines at its top.
//
//   / @console            the result as the process formats it (the default)
//   / @grid               a table as an HTML table
//   / @chart line         a table as a chart: line, bar, scatter or histogram
//   / @title Daily volume a chart's title
//   / @height 400         a chart's height, in pixels
//   / @process rdb        run the cell on the process labelled rdb
//   / @parameters         the cell holds the notebook's parameters: a
//                         headless run with values given puts a cell of
//                         them after it (papermill's convention)
//
// They are q comments, so the cell runs the same in a notebook, a query or
// an exported script. Only the lines before the first that is neither blank
// nor a directive are read; a later `/ @grid` is an ordinary comment, and so
// is a qDoc line (`/ @param`, `/ @return`, ...).

export const CHART_KINDS = ["line", "bar", "scatter", "histogram"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/// The heights `/ @height` takes, in pixels.
export const CHART_HEIGHT = { min: 100, max: 2000 } as const;

export interface ChartMode {
  mode: "chart";
  chart: ChartKind;
  title?: string;
  height?: number;
}

export type CellMode = { mode: "console" } | { mode: "grid" } | ChartMode;

/// What a cell asks for besides its output.
export interface CellOptions {
  /// The label of the process the cell runs on: a saved one's, or a
  /// discovered one's as `server/label`.
  process?: string;
  /// The notebook's parameters cell.
  parameters?: true;
}

export type Directive = (CellMode & CellOptions) | { problem: string };

const DIRECTIVE = /^\/\s*@(\S*)\s*(.*?)\s*$/;

/// The tags of qDoc, q's documentation comments (`/ @param x ...`): the
/// first of them ends the directives, as any other comment does, so a cell
/// holding a documented function runs.
const QDOC = new Set([
  "author", "category", "deprecated", "desc", "doctest", "eg", "example", "fileOverview", "kind",
  "name", "overview", "param", "private", "return", "returns", "see", "since", "subcategory",
  "throws", "todo", "type", "typedef", "version",
]);

/// What the cell's leading directives ask for: the last one wins. A directive
/// this does not know, a chart of no known kind, or a title or height on a
/// cell that draws no chart, is a problem the cell reports instead of
/// running.
export function cellDirective(source: string): Directive {
  let found: CellMode = { mode: "console" };
  let title: string | undefined;
  let height: number | undefined;
  let charted = false;
  const options: CellOptions = {};
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const match = DIRECTIVE.exec(line.trimEnd());
    if (match === null || QDOC.has(match[1])) {
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
      charted = true;
    } else if (name === "title") {
      if (rest === "") {
        return { problem: "`/ @title` takes the chart's title after it." };
      }
      title = rest;
    } else if (name === "height") {
      const px = /^\d+$/.test(rest) ? Number(rest) : NaN;
      if (!(px >= CHART_HEIGHT.min && px <= CHART_HEIGHT.max)) {
        return {
          problem: `\`/ @height\` takes the chart's height in pixels, ${CHART_HEIGHT.min} to ${CHART_HEIGHT.max}${rest === "" ? "" : `, and was given "${rest}"`}.`,
        };
      }
      height = px;
    } else if (name === "process") {
      if (rest === "") {
        return { problem: "`/ @process` takes the label of the process to run the cell on." };
      }
      options.process = rest;
    } else if (name === "parameters") {
      if (rest !== "") {
        return { problem: `\`/ @parameters\` takes nothing after it, and was given "${rest}".` };
      }
      options.parameters = true;
    } else {
      return {
        problem: `\`/ @${name}\` is not a cell directive. They are \`/ @console\`, \`/ @grid\`, \`/ @chart <${CHART_KINDS.join("|")}>\`, \`/ @title <text>\`, \`/ @height <px>\`, \`/ @process <label>\` and \`/ @parameters\`.`,
      };
    }
  }
  if (title === undefined && height === undefined) {
    return { ...found, ...options };
  }
  if (found.mode !== "chart") {
    const which = `\`/ @${title !== undefined ? "title" : "height"}\``;
    return {
      problem: charted
        ? `${which} is for a chart, and this cell's \`/ @${found.mode}\` after its \`/ @chart\` draws none.`
        : `${which} is for a chart, and this cell has no \`/ @chart\`.`,
    };
  }
  return { ...found, ...(title !== undefined ? { title } : {}), ...(height !== undefined ? { height } : {}), ...options };
}
