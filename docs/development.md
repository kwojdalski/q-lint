# Development

## Checks

```sh
cargo test                                            # unit, CLI, LSP and corpus suites
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo build --release                                 # the checks below need it
cargo test --release --test never_panic -- --ignored  # no panic on any mutated q in the tree
uv run --with pytest --with pyyaml pytest tests       # black-box CLI and packaging checks
python3 scripts/check_invariance.py target/release/qlinter examples tests/corpus tests/cases
                                                      # findings unmoved by CRLF, position, comments
```

`Q_LINT_TEST_QLS=qls` before the pytest run adds the qls backend's checks.
With q on `PATH`, `tests/test_intrinsic_runtime.py` runs curated fixture
expressions in a separate q process and compares q's failures with the
linter's findings. It is a development oracle; linting never runs input.

The LSP suite drives the real binary over real protocol framing, since wire
framing and a process that does not exit only show up in a real process.

## The examples

The taxonomy contains 145 codes. `examples/showcase.q` marks each expected
diagnostic with `expect-next`, and `tests/showcase.rs` checks the exact code
and line of each under every profile, including silence in its clean
section. With the three companion examples - `syntax-error.q`,
`byte-order-mark.q` and `query-injection.q`, each holding a rule that would
hide or stop the others - it covers all 143 rules available in this build;
QF006 and QLS001 are excluded, as this binary never reports them.

`tests/corpus/` and `tests/cases/` pin shapes known to be hard; their
READMEs give the format. A new rule should also be diffed over a corpus of
public q nobody here wrote; `CLAUDE.md` has the commands.

## The VS Code extension

```sh
cargo build --release
cd editors/vscode && npm install && npm run compile
mkdir -p server && install -m 755 ../../target/release/qlinter server/qlinter
npx --yes @vscode/vsce package --out q-lint.vsix
code --install-extension q-lint.vsix
```

Or press <kbd>F5</kbd> in `editors/vscode` for an Extension Development
Host. `server/` is not committed: a package carries the binary built from
the tree it is packaged from.

## Builds and releases

`scripts/dist.py` builds and installs, and puts every artifact in
`dist/vX.Y.Z/` (ignored by git); a build of anything but a clean checkout of
the tag goes to `dist/vX.Y.Z-dev/`.

```sh
python3 scripts/dist.py build              # this machine's archive and vsix
python3 scripts/dist.py build --wheel      # plus the Python wheel (needs uv)
python3 scripts/dist.py download 0.40.0    # a release, checked against its SHA256SUMS
python3 scripts/dist.py install            # build, then install the CLI and the extension
python3 scripts/dist.py install 0.40.0     # install a release
```

`install` puts `qlinter` in `~/.local/bin` (`--bin-dir` to change it) and
the extension into VS Code. `build` does not cross-compile; the release
workflow builds every platform.

A release is a tag. `python3 scripts/dist.py bump X.Y.Z` sets the version in
`Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `uv.lock` and the extension's
`package.json` and `package-lock.json`; commit, tag `vX.Y.Z` and push.
