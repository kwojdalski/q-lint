# q-lint for VS Code

Linting, Quick Fixes and syntax colouring for q/kdb+, as you type, from the
[q-lint](https://github.com/kwojdalski/q-lint) language server.

![the q-lint icon](icon.png)

**Why another linter?** I wasn't satisfied with the solutions available for
q, so I decided to build my own, inspired by the best practices of linters
for other languages, such as [Ruff](https://docs.astral.sh/ruff/) for Python.

**Early version.** Open source, built to be good enough for agentic
development, and already catching the most common problems. A finding that
looks wrong is worth an [issue](https://github.com/kwojdalski/q-lint/issues).

**It never executes your code**, which is why it is safe on every keystroke -
and why there is no completion, hover or go-to-definition.

## Features

- **Diagnostics** for what q would refuse, plus likely mistakes and style
  conventions, depending on the profile.
- **Quick Fixes** for 30 rules, among them operators and keywords
  from other languages (`==`, `&&`, `+=`, `true`, `return`), invalid string
  escapes, symbols where q wants strings, `f(a;b)` calls, one-row tables,
  dead code, unused locals and comparisons a where phrase groups wrongly.
  Those that cannot change a working program also run in bulk with
  `qlinter --fix`; `--unsafe-fixes` adds the rest.
- **Syntax colouring** from a TextMate grammar, plus semantic tokens: a
  function is coloured wherever it is called, even when another `.q` file in
  the workspace defines it, and a parameter wherever its body reads it.
  Unused parameters and locals are faded.

## Requirements

None on macOS (Apple Silicon and Intel), Linux x64 or Windows x64: the
matching `qlinter` binary is bundled. Elsewhere, take one from
[releases](https://github.com/kwojdalski/q-lint/releases) and put it on
`PATH` or in `q-lint.serverPath`.

## Settings

| setting | default | |
|---|---|---|
| `q-lint.profile` | `style` | `general`: only what q refuses. `style`: also likely mistakes. `styleq`: also published style guides. `uqf`: also one repository's conventions. |
| `q-lint.serverPath` | empty | Your own binary. Empty uses the bundled one, then `qlinter` on `PATH`; set, it always wins. |
| `q-lint.trace.server` | `off` | Log client-server traffic. |

## Troubleshooting

Open **Output → q-lint**: the first line names the server version and binary,
and the server's errors land there. After replacing the binary, run
**q-lint: Restart Server**. On macOS, apps started from the Dock do not see
your shell's `PATH`, so give `q-lint.serverPath` an absolute path.

`qlinter --rules` lists every rule; `qlinter --explain <CODE>` explains one.

## Development

`server/qlinter` is a checked-in darwin-arm64 build, so a clone packages
without a release build; releases bundle their own per platform. Refresh it
with `cargo build --release && install -m 755 target/release/qlinter
editors/vscode/server/qlinter`. The grammar is generated:
`python3 scripts/q_grammar.py > editors/vscode/syntaxes/q.tmLanguage.json`.
