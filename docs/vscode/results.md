# Results

The grid, charts and the other ways to look at, act on and export a query result. The [extension README](../../editors/vscode/README.md) has the summary.

In grid or chart mode, results open beside the editor or in the
**q Results** panel (`q-lint.query.resultsLocation`). The process sends at
most `q-lint.query.gridLimit` rows.

- **Grid**: sort, filter, heatmap (**Toggle Result Heatmap**), column
  formats by an upper-case name suffix (`_PCT`, `_BPS`, `_CCY` ...),
  **Add Conditional Format...**, data bars and sparklines, and a column
  layout you can move, hide and freeze. **Load More Result Rows** pages
  through a cut result (off by default: `q-lint.results.paging.enable`).
- **Other views of a result**: **Show Column Statistics**,
  **Show Result as Tree**, **Show Result as Pivot**,
  **Show Result Correlation Matrix** and
  **Compare Result with Previous Run**. Results stay as tabs
  (**Show Result from History**).
- **Charts**: line, bar, scatter, histogram, area, step and candles, a
  second y axis, order-book depth, a map for latitude and longitude, and
  linked panes. **Save Result Chart as Image** (PNG or SVG);
  **Save Result Chart with Query** remembers a chart for a query. Every
  chart is kept in the **q Plots** view (**Save Plot As...**).
- **Act on a result**: **Drill Down from Cell** runs a follow-up query you
  define in `q-lint.results.drilldownTemplates`; **Wrangle Result...**
  filters, sorts, renames and casts, and writes the q; **Edit Cell...**
  writes the `update` for a cell.
- **Export**: **Export Results to CSV**, **Export Results As...** and
  **Copy Results As...** (Excel, Parquet, JSON, Markdown, HTML, q),
  **Send Result to Notebook** and **Append Result to Markdown Report...**.
- **From code**: after **Define .qlint.view and .qlint.plot on Process**,
  `.qlint.view t` opens `t` in the grid and `.qlint.plot t` as a chart.
- **Data files**: **Open Data File in Grid** for a CSV, TSV or JSON file,
  and **Load CSV into q...** to build the load statement.
- **Dashboards**: **Open Dashboard...** shows saved queries as tiles;
  **Add to Dashboard...** adds one.
- **Render Chart from CSV or JSON File...** writes an SVG. The same works
  from a shell with the extension's `out/chartcli.js` (`--help`).

The grid works with a screen reader, and query outcomes are announced.
