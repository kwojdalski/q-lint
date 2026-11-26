# Language server

`qlinter --lsp` speaks the Language Server Protocol over stdin and stdout.
This page is for someone writing or configuring a client; [editors.md](editors.md)
has ready-made setups.

The server never runs the code it reads, and never starts a process or
opens a connection. Everything below is answered from the source text and
from the catalogue of q's words in `src/builtins.json`, so it knows no
column, no value and nothing a running process defines. A name built at run
time is not found.

Only `.q` files are linted. Configuration is found per document as on the
command line ([configuration.md](configuration.md)), and `--config`,
`--isolated`, `--profile`, `--select`, `--extend-select` and `--ignore`
apply when given to `--lsp`. `exclude` does not hide the findings of a
document the editor opens; it does decide which closed files the workspace
index reads.

The server answers one message at a time, in order, and reads ahead: a
change with another change to the same document queued behind it is not
linted, so a burst of keystrokes is linted once. A request still queued when
its `$/cancelRequest` arrives is answered `RequestCancelled`.

## Diagnostics and fixes

- `textDocument/publishDiagnostics` on open, change and save
  (`lint.run`). Each diagnostic's `codeDescription` links its rule in
  [rules.md](rules.md). With `relatedInformation.enable`, a duplicate
  parameter or column (QF008, QB019, QB021) points at the first one.
- While a bracket or string is open, a file reports only QE001, at the
  bracket that is not closed. The other diagnostics and folds of the last
  version that parsed are kept on every unchanged line, moved with the edits.
- `textDocument/codeAction` offers each rule's fix as a Quick Fix, unsafe
  ones included unless `fixes.unsafe` is `false`, plus **Suppress CODE on
  this line** and **in this file**, which write a `noqa` comment.
- Code action kinds:
  - `source.fixAll.q-lint`: the edit Format Document makes, for fix-on-save
    where q-lint is not the formatter.
  - `source.organizeImports.q-lint`: **Organise loads**, which removes
    repeated `\l` lines and sorts each run of them. Never a `--fix`, since
    load order is meaning in q.
  - `refactor.rewrite`: **Generate qDoc**, **Lay out qSQL query on aligned
    lines**, and the rewrites between a qSQL query and its functional form.
  - `refactor.extract.function`: **Extract function**, which turns a
    selection q reads as one value into a lambda above the statement and a
    call to it.
- `textDocument/formatting` applies exactly the fixes `qlinter --fix`
  applies, nothing editor-only. It is not a layout formatter. With
  `qsqlLayout.onFormat` it also lays out long qSQL queries.

## Navigation

- `textDocument/documentSymbol`: the outline, each name under its
  namespace (`.qetl.io.read` is `read` under `.qetl.io`), or a flat list for
  a client without hierarchical support.
- `workspace/symbol`: ranked by exact name, then last segment, prefix,
  substring and letters in order; at most 512.
- `textDocument/definition`, `references` and `documentHighlight` (writes
  told from reads). A global is resolved as q resolves it: under the `\d` in
  force, in the context a file is loaded in, and through a namespace
  assigned whole. When several files define a name, the current file's
  definition comes first, then files it loads, then files that load it.
- Go to Definition on `\l path`, `system "l path"` or `` `:lib/x.q `` opens
  the file; `textDocument/documentLink` makes each such path a link.
- `textDocument/rename` and `prepareRename`: a lambda's parameter or local
  within its lambda, or a global across the workspace, changing only the
  name's last part. A rename that reading cannot make safe is refused with
  the reason and the line.
- `textDocument/prepareCallHierarchy` with incoming and outgoing calls:
  the functions a function's statement names and the ones naming it. A
  function passed as a value counts as called.
- `textDocument/foldingRange` and, with `selectionRange.enable`,
  `textDocument/selectionRange`, which grows a selection token, bracket,
  statement.

## Hover, signature help and completion

- Hover on a workspace name shows its signature (declared, or the `x`, `y`,
  `z` its body reads), the comment above its definition and its file. On a
  word or glyph of q it shows the form, a summary and a link to
  code.kx.com. On a qSQL query it says what the query does
  (`qsqlExplain`). On a local whose literal assignments settle its type, it
  gives the type (`inferredTypes`).
- `textDocument/signatureHelp` inside the brackets of a call, following
  aliases and projections.
- `textDocument/inlayHint`: parameter names before the arguments of a call
  to a workspace function, and inferred local types.
- `textDocument/semanticTokens/full`.
- `textDocument/completion` is off by default: an editor told that a server
  completes stops offering the buffer's own words, and this server knows no
  columns. When on, it offers locals, workspace names as the `\d` in force
  reads them, then q's words. `autoLoad` adds the `\l` that loads a name's
  file; `loadPathCompletion` completes paths after `\l `.
- `textDocument/codeLens`: **Run** and **Run test** on top-level functions
  (`codeLens.enable`), and a reference count (`referenceLens.enable`). They
  run the client commands `q-lint.runDefinition` and
  `q-lint.showReferences`, so they are off unless the client registers
  those, as the VS Code extension does.
- With `renameLoads.enable`, `workspace/willRenameFiles` returns the edits
  that keep every `\l` naming the file it named.

## The server's own requests

Announced under `capabilities.experimental`. Each answers from the indexed
files, with open buffers as the editor has them. `U` is a document URI, `R`
a range and `P` a position.

```
q-lint/graph            {"textDocument": {"uri": U}}
                     -> {"uri": U, "dependencies": [uri], "dependents": [uri],
                         "ambiguous": {name: [uri]}, "dynamic": [{"line": 1-based, "kind": K}]}
                        or null for a document that is not an indexed .q file
q-lint/affectedTests    {"changed": [uri]}
                     -> {"tests": [{"uri": uri, "reaches": [index into "changed"],
                                    "self": its own index there, or null}],
                         "changed": [uri], "unindexed": [uri], "dynamic": [uri]}
q-lint/definitions      {}
                     -> [{"name": N, "namespace": ".ns" or ".", "kind": "function" | "variable",
                          "uri": uri, "range": R}]
q-lint/deadCode         {} or {"textDocument": {"uri": U}}
                     -> {"functions": [{"name": N, "uri": uri, "range": R}], "dynamic": count}
q-lint/testsReaching    {"textDocument": {"uri": U}, "previous": "the text before the save"}
                     -> {"changed": [name], "tests": [{"uri": uri, "name": N}]}
q-lint/tests            {} or {"textDocument": {"uri": U}}
                     -> [{"uri": uri, "tests": [{"name": as written, "range": R,
                                                  "code": C, "call": "ns.test_x[]"}]}]
q-lint/globalAt         {"textDocument": {"uri": U}, "position": P}
                     -> {"names": [name q may resolve it to], "range": R}, or null
q-lint/unresolvedNames  {"textDocument": {"uri": U}}
                     -> [{"names": [name], "written": as written, "range": R}]
q-lint/argumentSlot     {"textDocument": {"uri": U}, "position": P}
                     -> {"range": R, "index": n, "callee": as written,
                         "parameter": name or null, "hinted": bool}, or null
q-lint/defined          {"names": [name]}
                     -> [bool]
q-lint/formatChangedLines  {"textDocument": {"uri": U}, "lines": [[first, last], ...]}
                     -> the edits Format Document would make on those 0-based lines
```

- `graph` is the graph `qlinter analyze graph` prints
  ([cli.md](cli.md#the-dependency-graph-qlinter-analyze-graph)), without
  `--symbols`.
- `affectedTests` lists the test files that reach a changed file. The server
  never asks git, so the client sends the changed files. A test file is a
  `.q` file named `test_*` or `*_test`, or under a `test` or `tests`
  directory. `unindexed` holds sent files the index lacks; `dynamic` holds
  test files that load by a computed path. Ask on save or when a view is
  shown, not on every keystroke.
- `deadCode` lists functions nothing reads; a name spelled in any symbol or
  string counts as read. `dynamic` counts computed names, so treat the list
  as candidates.
- `testsReaching` compares the document's top-level functions with
  `previous` and returns the tests that reach a changed one.
- `formatChangedLines` answers `[]` unless `formatChangedLines.enable` is
  on; it is for formatting only what git says changed.

A file under a workspace folder is named by that folder's URI as the client
sent it, so a symlinked path is not opened twice.

## The workspace index

Closed files are read from each workspace folder, up to 20,000 `.q` files or
500,000 directory entries, so a folder opened at `/` cannot stall the
server. It follows the disk through `workspace/didChangeWatchedFiles`,
registering watchers for `**/*.q`, `**/*.toml` and created or deleted paths.
`workspaceIndex.exclude` and the configuration's `exclude` leave files out.
With `lint.scope` set to `workspace`, closed files are linted too, at most
5,000, while no message is waiting.

## `initializationOptions`

Read once from `initialize`; restart the server to change them. Every key is
optional, and these are the defaults:

```json
{"lint": {"select": [], "ignore": [], "run": "onType", "severity": {}, "scope": "open"},
 "fixes": {"unsafe": true}, "format": {"enable": true},
 "semanticTokens": {"enable": true}, "navigation": {"enable": true},
 "help": {"enable": true}, "completion": {"enable": false},
 "callHierarchy": {"enable": true}, "graph": {"enable": true},
 "rename": {"enable": true}, "inlayHints": {"enable": true}, "codeLens": {"enable": false},
 "documentLinks": {"enable": true}, "generateQdoc": {"enable": true},
 "extractFunction": {"enable": true}, "autoLoad": {"enable": false},
 "referenceLens": {"enable": false}, "inferredTypes": {"enable": true},
 "suppressions": {"enable": true},
 "organiseLoads": {"enable": true}, "performanceLints": {"enable": true},
 "formatChangedLines": {"enable": false},
 "qsqlLayout": {"enable": true, "onFormat": false, "lineLength": 80},
 "functionalForm": {"enable": true}, "qsqlExplain": {"enable": true},
 "versionCheck": {"enable": true}, "baseline": {"enable": true},
 "typeLints": {"enable": true}, "selectionRange": {"enable": false},
 "relatedInformation": {"enable": false}, "crossFileRefresh": {"enable": false},
 "renameLoads": {"enable": false}, "loadPathCompletion": {"enable": false},
 "workspaceIndex": {"enable": true, "exclude": []}}
```

| key | effect |
|---|---|
| `lint.select`, `lint.ignore` | codes or prefixes; can only turn rules off, after the configuration |
| `lint.run` | `onType` or `onSave`; navigation still follows the unsaved buffer |
| `lint.severity` | code or prefix to severity, over the configuration's `[severity]` |
| `lint.scope` | `open`, or `workspace` to lint closed files too |
| `fixes.unsafe` | `false` offers only the fixes `--fix` applies |
| `performanceLints`, `versionCheck`, `typeLints` | `false` ignores the QV rules, the QK rules, QT033-QT035 |
| `baseline` | `false` shows every finding, whatever baseline the configuration names |
| `relatedInformation` | add `relatedInformation` to duplicate-name diagnostics |
| `crossFileRefresh` | send `workspace/codeLens/refresh` and `workspace/inlayHint/refresh` when definitions change |
| `qsqlLayout` | the qSQL layout action; `onFormat` runs it on format; `lineLength` |
| `workspaceIndex` | `enable: false` reads no closed file (and refuses global renames); `exclude` holds globs |

Every other key is an `enable` switch for the feature of the same name
above. Set to `false`, its capability or code action kind is not announced;
`completion`, `codeLens`, `referenceLens`, `autoLoad`, `selectionRange`,
`renameLoads`, `loadPathCompletion` and `formatChangedLines` start off.
`help` covers hover and signature help, and `navigation` symbols,
definition, references and highlights, for when another q server answers
those. A value the server cannot read is reported with `window/showMessage`
and its default used.
