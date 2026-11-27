# Editor setup

Any editor with an LSP client runs the server as `qlinter --lsp`, over stdin
and stdout. What the server answers is in [lsp.md](lsp.md).

## VS Code

Install the extension from its `.vsix` on the
[releases page](https://github.com/kwojdalski/q-lint/releases); it bundles
the server. Its settings, and its q process and notebook features, are in
[its README](../editors/vscode/README.md).

## Other editors

None of these snippets names a profile. The server takes it, and every other
rule setting, from the `qlinter.toml`, `.qlinter.toml` or `pyproject.toml`
above each file, and uses `style` where none says. Add `--profile` only to
override the repository.

Each snippet passes one `initializationOptions` key, `lint.run`, to lint on
save rather than on every change, to show where options go. Leave it out for
the defaults; [lsp.md](lsp.md#initializationoptions) lists the rest. Each was
written against the editor's own documentation as of November 2026.

**Neovim** 0.11 or later, with the built-in `vim.lsp.config`:

```lua
vim.filetype.add({ extension = { q = "q" } })
vim.lsp.config("qlinter", {
  cmd = { "qlinter", "--lsp" },
  filetypes = { "q" },
  root_markers = { "qlinter.toml", ".qlinter.toml", "pyproject.toml", ".git" },
  init_options = { lint = { run = "onSave" } },
})
vim.lsp.enable("qlinter")
```

**Helix**, in `languages.toml` (`config` is sent as `initializationOptions`):

```toml
[language-server.qlinter]
command = "qlinter"
args = ["--lsp"]
config = { lint = { run = "onSave" } }

[[language]]
name = "q"
scope = "source.q"
file-types = ["q"]
roots = ["qlinter.toml", ".qlinter.toml", "pyproject.toml"]
language-servers = ["qlinter"]
```

**Emacs** with **Eglot**, built in since Emacs 29. `q-mode` is the major
mode from MELPA, or any mode of your own for `.q` files:

```elisp
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '(q-mode . ("qlinter" "--lsp"
                           :initializationOptions (:lint (:run "onSave"))))))
```

**Emacs** with **lsp-mode**:

```elisp
(with-eval-after-load 'lsp-mode
  (add-to-list 'lsp-language-id-configuration '(q-mode . "q"))
  (lsp-register-client
   (make-lsp-client :new-connection (lsp-stdio-connection '("qlinter" "--lsp"))
                    :activation-fn (lsp-activate-on "q")
                    :initialization-options '(:lint (:run "onSave"))
                    :server-id 'qlinter)))
```

**Sublime Text**, with the LSP package, in
`Packages/User/LanguageServers.sublime-settings`. `selector` needs a q
syntax package whose base scope is `source.q`:

```json
{
  "qlinter": {
    "enabled": true,
    "command": ["qlinter", "--lsp"],
    "selector": "source.q",
    "initialization_options": {"lint": {"run": "onSave"}}
  }
}
```

**Kakoune**, with kakoune-lsp, in `kakrc` after `eval %sh{kak-lsp}`.
Kakoune has no q filetype, so the first hook gives `.q` files one:

```kak
hook global BufCreate .*\.q %{ set-option buffer filetype q }
hook -group lsp-filetype-q global BufSetOption filetype=q %{
    set-option buffer lsp_servers %{
        [qlinter]
        command = "qlinter"
        args = ["--lsp"]
        root_globs = ["qlinter.toml", ".qlinter.toml", "pyproject.toml", ".git"]
        settings_section = "_"
        [qlinter.settings._]
        lint = { run = "onSave" }
    }
}
```

**Zed** starts a language server only for a language an extension defines,
and no Zed extension defined q when this was written. Once one does, point
its server at `qlinter` in `settings.json`, under the name the extension
gives it:

```json
{
  "lsp": {
    "qlinter": {
      "binary": {"path": "qlinter", "arguments": ["--lsp"]},
      "initialization_options": {"lint": {"run": "onSave"}}
    }
  }
}
```
