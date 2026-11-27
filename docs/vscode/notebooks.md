# q notebooks

Reference for the q-lint VS Code extension's `.qnb` notebooks: cell
directives, the file format, running from a shell, and git. The
[extension README](../../editors/vscode/README.md#notebooks) has the
summary.

## At a glance

A `.qnb` file is a notebook of q and Markdown cells, run on the active
connection. **New q Notebook** creates one.

- Directives on a cell's first lines: `/ @grid`, `/ @chart line` (with
  `/ @title` and `/ @height`), `/ @process <label>` and `/ @parameters`.
  **Set Notebook Row Limit** caps what a grid or chart shows.
- `{{q: expr}}` in Markdown shows a live value. The **Notebook Variables**
  view lists the process's globals.
- **Restart Notebook Process and Run All** restarts a process q-lint
  started and runs every cell.
- **Run Notebook with Parameters** writes a run to a new `.qnb`, HTML or
  Jupyter file. `out/qnbrun.js` does the same from a shell.
- **Export Notebook as HTML**, **Export Notebook as Jupyter Notebook**,
  **Export Notebook as q Script** and
  **Import Jupyter Notebook as q Notebook**.
- **Compare Notebook Cells...** diffs cells without their outputs.
  **Clear Notebook Outputs in File** and
  **Set Up Git to Strip Notebook Outputs...** keep outputs out of commits.

## Running cells

Cells run on the active connection, one at a time, in order; a run of
several stops at the first that fails. A cell is split into statements as a
query is and defines nothing on the process but what its code defines.
Interrupting a cell works like **Abort Current Query**. Cells are not
linted.

## Cell directives

A cell's first lines can be directives. They are q comments, so the cell
runs the same as a script. An unknown directive fails the cell and lists the
known ones. A qDoc line (`/ @param`, `/ @eg` ...) ends the directives.

| directive | effect |
|---|---|
| `/ @console` | The default: the result as the process formats it, at `q-lint.output.consoleSize`. |
| `/ @grid` | A table as an HTML table, at most `q-lint.notebook.rowLimit` rows (first or last, by `q-lint.notebook.rowLimitFrom`). |
| `/ @chart line` | A chart: `line`, `bar`, `scatter` or `histogram`, drawn as the result panel's Chart mode draws it. |
| `/ @title <text>` | A title above the chart. |
| `/ @height <px>` | The chart's height, 100 to 2000 (300 by default). |
| `/ @process <label>` | Connect to that process before the cell runs; later cells run there too. A guarded process asks first. |
| `/ @parameters` | The notebook's parameters, one `name:value` per line (papermill's convention). |

**Set Notebook Row Limit** sets the two row-limit settings. The limit is a
setting, not part of the file.

## Live values in Markdown

`{{q: expr}}` in a Markdown cell shows `expr`'s value, read when the code
cell above it runs:

```markdown
Total {{q: sum t`px}} over {{q: count t}} trades.
```

Values are kept in the cell's metadata and saved with the notebook; the
source is unchanged. Inside a code span or code block it is plain text.

## Run with parameters

**Run Notebook with Parameters** asks for each parameter of the
`/ @parameters` cell, runs every cell, and writes the result to a new file:
`.qnb`, `.html` or `.ipynb` by extension. The values go in a marked cell
after the parameters cell.

The same run works from a shell, with Node.js, using the script the
extension ships (`~/.vscode/extensions/wojdalski.q-lint-<version>/out/qnbrun.js`):

```sh
node out/qnbrun.js report.qnb --process localhost:5001 \
  -p date 2024.01.02 -p syms '`EURUSD`GBPUSD' -o report-0102.html
```

- Each value is q text: a string is `-p name '"text"'`.
- `--process` is `host:port`, or a label from `--processes FILE` (a list as
  **Export Processes** writes it).
- Passwords come from `QLINT_Q_PASSWORD` (for `--process`) or
  `QLINT_Q_PASSWORD_<LABEL>` (for a listed process), never from arguments.
- `--direct` sends plain strings to a `host:port` that refuses a lambda.
- A process tagged `prod`, `prd` or `production` is refused unless
  `--allow-production` is given.
- `--row-limit`, `--rows-from` and `--console-size` replace the settings.
- Exit code 0: every cell ran; 1: a cell failed (the file is written up to
  it); 2: usage or file error. `--help` lists every option.

## Export and import

- **Export Notebook as HTML**: one self-contained page with no script.
  Markdown is rendered; outputs show as text.
- **Export Notebook as Jupyter Notebook**: nbformat 4.4 with a q kernel spec.
- **Import Jupyter Notebook as q Notebook**: writes a `.qnb`. Cells marked q
  (or unmarked) become q; a `%%q` cell (PyKX's magic) becomes q without the
  magic line; other languages are kept.
- **Export Notebook as q Script**: the code cells as a loadable `.q` file,
  Markdown cells as block comments.

## File format

A `.qnb` file is JSON, format 1:

```json
{
 "qnb": 1,
 "cells": [
  {"kind": "markdown", "source": ["# Prices"]},
  {"kind": "code", "source": ["/ @grid", "select from t"],
   "execution": {"order": 1, "success": true, "start": 1700000000000, "end": 1700000000012},
   "outputs": [{"items": [{"mime": "text/html", "text": "<table>...</table>"},
                          {"mime": "text/plain", "text": "..."}]}]}
 ]
}
```

- `qnb` is the format version. A newer version than the extension reads is
  refused.
- `source` is the cell's lines. A code cell is q unless it has a `language`.
- Outputs are saved. An item is `text` when it is UTF-8, `base64` otherwise.
  A chart's output is an `application/vnd.q-lint.chart+json` item plus the
  table as `text/plain` for other readers.
- `execution` holds the run number, outcome, and start and end in
  milliseconds since the epoch.
- Empty fields are left out. Unknown fields, at any level, are kept and
  saved back, so saving an unchanged notebook writes the same file.
- A file that is not a notebook does not open and is left as it was. An
  empty file is a new notebook.

## Notebooks in git

**Compare Notebook Cells...** (notebook toolbar, a `.qnb` file's menu, or a
changed `.qnb` in Source Control) diffs the cells against `HEAD` or another
notebook, ignoring outputs, run numbers and metadata.

To get the same text in `git diff` and `git log -p`, use the shipped
`qnbgit.js` as a textconv:

```sh
git config diff.qnb.textconv "node ~/.vscode/extensions/wojdalski.q-lint-<version>/out/qnbgit.js --text"
echo '*.qnb diff=qnb' >> .gitattributes
```

To keep outputs out of commits, as nbstripout does for Jupyter:

- **Clear Notebook Outputs in File** removes outputs, run numbers, times and
  live values from one or more `.qnb` files.
- **Set Up Git to Strip Notebook Outputs...** installs `qnbgit.js --strip`
  as a git clean filter for `*.qnb`. It asks whether the attributes line
  goes in `.git/info/attributes` (this clone) or `.gitattributes`
  (committed), shows what it will write - a copy of the script in
  `.git/q-lint/`, `filter.qnb-strip.clean` in the local git config, and the
  attributes line - and writes only on **Write**. It never changes an
  existing `filter.qnb-strip.clean` and writes no hook. The filter needs
  `node` on `PATH`. To undo it, remove the attributes line and run
  `git config --unset filter.qnb-strip.clean`.
