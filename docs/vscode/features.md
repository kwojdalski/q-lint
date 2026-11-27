# Linting and language features

Everything the q-lint extension does from the source alone: findings, fixes, navigation and editing helpers. None of it runs your code. The [extension README](../../editors/vscode/README.md) has the summary.

## Linting

- **Profiles**: `general` reports only what q refuses; `style` adds likely
  mistakes; `styleq` adds published style guides; `uqf` adds one
  repository's conventions. A repository's `qlinter.toml` (or
  `[tool.qlinter]` in `pyproject.toml`) sets the profile and rules; see the
  [q-lint README](https://github.com/kwojdalski/q-lint#readme). With
  [Even Better TOML](https://marketplace.visualstudio.com/items?itemName=tamasfe.even-better-toml)
  installed, `qlinter.toml` gets completion and validation.
- **Quick Fixes** for over forty rules. The safe ones also run in bulk with
  `qlinter --fix`. **Suppress CODE on this line** and **Suppress CODE in
  this file** write a `noqa` comment instead.
- **Format Document** applies the safe fixes and nothing else; it is not a
  layout formatter. **Format Changed Lines** fixes only lines changed
  against git `HEAD` (on every save with
  `q-lint.formatChangedLines.enable`). **Lay out qSQL query on aligned
  lines** splits a long query, and `q-lint.qsqlLayout.onFormat` makes
  Format Document do it too.
- **Performance lints** (`QV`), **type lints** from inferred types, and a
  **q version check** (`QK`) for a folder's `target-version`.
- **Write Lint Baseline** records today's findings so only new ones show.
- **Show Problems Dashboard**: a folder's findings by rule and folder, and
  their trend over commits (**Problems Dashboard: Lint Earlier Commits**).
- **Show Dead Code Report**: workspace functions nothing reads.

To format q on save, or to apply the safe fixes on save without making
q-lint the formatter, use one of:

```json
"[q]": {"editor.defaultFormatter": "wojdalski.q-lint", "editor.formatOnSave": true}
"[q]": {"editor.codeActionsOnSave": {"source.fixAll.q-lint": "explicit"}}
```

Which rules report, in order: the profile (`q-lint.profile`, else the
configuration's, else `style`), then the configuration's `select` and
`ignore`, then `q-lint.serverArgs`, then `q-lint.lint.select` and
`q-lint.lint.ignore`, which can only narrow. The command line defaults to
`uqf`, so without a `profile` in the configuration the editor shows fewer
findings than CI.

## Navigation

- Outline, **Go to Symbol in Workspace**, **Go to Definition**, **Find All
  References** and **Rename Symbol** for locals and for globals across the
  workspace, read from every `.q` file without running it.
- **Show Call Hierarchy**, reference counts above each function, and `\l`
  paths as links. Renaming or moving a `.q` file rewrites the `\l` lines
  that load it.
- **q Dependencies** (Explorer view): the files the active file depends on
  and those depending on it. **List Affected Tests**: the tests that reach
  what changed against git `HEAD`. **q Namespaces** (Explorer view): every
  definition by namespace.
- Hovers and signature help for workspace functions and q builtins, inlay
  hints for parameter names and inferred local types, and the argument slot
  the cursor is in.
- Completion of locals, workspace names and q's words is off by default
  (`q-lint.completion.enable`), because VS Code then stops offering the
  words already in the file. `\l` paths complete regardless.

## Editing helpers

- Refactors in the lightbulb: **Extract function**, **Generate qDoc**,
  **Rewrite qSQL Query in Functional Form** and
  **Rewrite Functional Form as qSQL**. **Explain qSQL Query** (also on
  hover) says a query in words.
- **Organise Loads** (VS Code's **Organize Imports**) de-duplicates and
  sorts a run of `\l` lines.
- Enter after an open bracket indents the continuation line; dotted names
  (`.ns.f`) count as one word for Ctrl/Cmd+D; **Toggle Line Comment** on a
  blank line writes `/ .`, not a lone `/` that q reads as a block comment.
- Folding of lambdas, lists, brackets and block comments, and
  **Expand Selection** by q's structure. To fold by indentation instead:
  `"[q]": {"editor.foldingStrategy": "indentation"}`.
- Snippets for qSQL, iterators and control flow, and idiom snippets for the
  joins, `.z` handlers and a TorQ process. q fences in Markdown are
  coloured. `.k` and `.quke` files are coloured, not linted.
- **Convert Temporal Value** and a temporal hover;
  **Paste Spreadsheet Data as q Table**, **Paste JSON as q** and
  **Copy Value as JSON**; **Toggle Parameter Cache** (`Ctrl+Shift+'`) keeps
  a lambda's arguments as globals while you debug it.
- Help: **Show Help for q Builtin** (offline pages), runnable examples in
  hovers (**Try Example on Process**), the **q Cheat Sheet** view, and
  **Explain q Error** for the last failed query.
