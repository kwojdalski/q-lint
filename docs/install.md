# Installing qlinter

## Pre-built binaries

Binaries for Linux x86-64, macOS (Apple Silicon and Intel) and Windows
x86-64 are on the [releases page](https://github.com/kwojdalski/q-lint/releases),
with a `SHA256SUMS`. Each archive holds the `qlinter` executable; put it on
`PATH`.

## With cargo

With Rust 1.88 or later:

```sh
cargo install --git https://github.com/kwojdalski/q-lint --tag v0.41.0 --locked
```

From a checkout:

```sh
cargo install --path . --locked     # or: cargo build --release
```

## With Python

The Python distribution `q-lint-rs` wraps the same executable, so a virtual
environment gets `qlinter` with no Rust on the target machine. In a
checkout, `uv sync` builds it and `uv run qlinter src/` runs it.

## The VS Code extension

The extension is a `.vsix` on the same releases page, one per platform with
the matching `qlinter` bundled, plus a platform-neutral one that uses the
`qlinter` on `PATH`. See [editors.md](editors.md).
