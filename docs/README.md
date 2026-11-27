# Documentation index

One line per page: what it holds and when to read it.

| page | read it to |
|---|---|
| [install.md](install.md) | install qlinter: binaries, cargo, the Python wheel, the VS Code `.vsix` |
| [getting-started.md](getting-started.md) | see a first run with output, the main options, a sample config, `noqa`, the dependency graph |
| [cli.md](cli.md) | look up a command-line option, the fixes, baselines, the q version check, `analyze graph` |
| [output.md](output.md) | parse `--format json`, `sarif` or `github` output |
| [rules.md](rules.md) | find a rule by code or category, see profiles and where each rule came from (generated from `src/taxonomy.json`) |
| [configuration.md](configuration.md) | set `qlinter.toml` / `[tool.qlinter]` keys, select and ignore rules, severity, excludes, suppression |
| [ci.md](ci.md) | run it in GitHub Actions, GitLab CI or pre-commit, and adopt it on a tree with findings |
| [editors.md](editors.md) | set up the server in VS Code, Neovim, Helix, Emacs, Sublime Text, Kakoune or Zed |
| [lsp.md](lsp.md) | write an LSP client: supported requests, custom requests, `initializationOptions` |
| [design.md](design.md) | understand why there is no parser and what that costs, before adding a rule |
| [ruff-applicability.md](ruff-applicability.md), [ruff-rules.md](ruff-rules.md) | check a proposed rule against what Ruff checks and what ports |
| [development.md](development.md) | run the test suites, package a release, work on the VS Code extension |

The VS Code extension has its own pages, listed from
[its README](../editors/vscode/README.md).
