A linter for q/kdb+ source that never executes what it reads, which is what
makes it safe to run on every keystroke. Ships as a command-line tool and a
language server, with a VS Code extension over it.

## Which file

**VS Code** — take the `.vsix` for your machine and install it with
`code --install-extension <file>`, or Extensions → ⋯ → Install from VSIX. It
carries the matching server, so there is nothing else to install:

| | |
|---|---|
| `qlinter-VERSION-darwin-arm64.vsix` | macOS, Apple Silicon |
| `qlinter-VERSION-darwin-x64.vsix` | macOS, Intel |
| `qlinter-VERSION-linux-x64.vsix` | Linux x86-64 |
| `qlinter-VERSION-win32-x64.vsix` | Windows x86-64 |
| `qlinter-VERSION.vsix` | anything else - no server inside, needs `qlinter` on `PATH` |

**Command line** — take the archive for your platform (`.tar.gz`, or `.zip` on
Windows) and put `qlinter` on your `PATH`:

```sh
qlinter src/           # lint a tree
qlinter --rules        # the rule catalogue
qlinter --explain QF001
```
