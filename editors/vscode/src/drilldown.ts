// Drill-down queries (#927): a template from `q-lint.results.drilldownTemplates`
// with a grid cell's values put in. `{{value}}` is the cell as a q literal
// (`qliteral.ts`), `{{column}}` its column's name as a symbol, and
// `{{row.name}}` the literal of column `name` in the same row - so
// `select from trade where sym={{value}}, date={{row.date}}` asks for the
// trades behind a row of a summary. Nothing else in the template changes.
import type { DrilldownTemplate } from "./liveconfig";
import type { GridPayload } from "./grid";
import { atomLiteral, rawColumn, symbolLiteral } from "./qliteral";

const PLACEHOLDER = /\{\{\s*(value|column|row\.([^}]*?))\s*\}\}/g;

/// The literal of the cell at `column`, `row` of the payload, or why it has
/// none it can be written as.
function literalAt(payload: GridPayload, column: number, row: number): { literal: string } | { error: string } {
  const raw = rawColumn(payload, column);
  const atom = atomLiteral(payload.types[column], payload.cells[column][row] ?? "", raw === undefined ? undefined : raw[row]);
  if (atom.cut) {
    return { error: `the cell in ${payload.names[column]} was cut at 200 characters or at the process's \\c width, so its value is not known here` };
  }
  return { literal: atom.literal };
}

/// The templates offered for a cell of the column `name`.
export function templatesFor(templates: DrilldownTemplate[], name: string): DrilldownTemplate[] {
  return templates.filter((t) => t.columns.length === 0 || t.columns.includes(name));
}

/// `query` with the cell at `column`, `row` put in, or why it could not be.
export function fillDrilldown(query: string, payload: GridPayload, column: number, row: number): { code: string } | { error: string } {
  if (column < 0 || column >= payload.names.length || row < 0 || row >= (payload.cells[column]?.length ?? 0)) {
    return { error: "the cell is not in the result on show" };
  }
  let error: string | undefined;
  const code = query.replace(PLACEHOLDER, (whole: string, what: string, name: string | undefined) => {
    if (what === "column") {
      return symbolLiteral(payload.names[column]);
    }
    const at = what === "value" ? column : payload.names.indexOf((name ?? "").trim());
    if (at < 0) {
      error ??= `the result has no column ${(name ?? "").trim()} for ${whole}`;
      return whole;
    }
    const cell = literalAt(payload, at, row);
    if ("error" in cell) {
      error ??= cell.error;
      return whole;
    }
    return cell.literal;
  });
  return error !== undefined ? { error } : { code };
}
