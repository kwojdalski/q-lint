# qlinter in CI

qlinter exits 1 when it reports a finding that is an error or a warning, 0
when it reports none - nothing at all, or only findings a `[severity]` table
made `information` or `hint` - and 2 when it cannot run (an unreadable
configuration, a missing baseline). A CI step that runs it fails on the first
error or warning, so on a tree that has findings today, start from a
[baseline](#adopting-on-a-tree-with-findings).

Pin a release everywhere: rules are added in every release, and a CI run
that takes "the latest" fails one morning on code nobody touched.

## GitHub Actions

The action in this repository downloads the release `version` names,
checks it against the release's `SHA256SUMS`, puts it on `PATH` and lints.
It runs on Linux and Windows x86-64 and on macOS, Intel or Apple Silicon,
and needs neither Rust nor a build.

### Annotations

The default `format`, `github`, prints each finding as a workflow command,
which a run shows as an annotation on the line it is about - in the job
log and, for a pull request, on the diff:

```yaml
name: q lint
on: [push, pull_request]
jobs:
  qlinter:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kwojdalski/q-lint@v0.34.0
        with:
          version: 0.34.0
          paths: src tests
          args: --profile style
```

`paths` is space-separated and defaults to `.`; `args` takes any other
option. The step fails when there are findings.

### Code scanning (SARIF)

`--format sarif` writes SARIF 2.1.0, which GitHub code scanning reads:
findings then appear in the repository's Security tab and on pull requests,
and each keeps its identity when lines are added above it, since its
fingerprint is its file, code and line text, not its line number. Write the report to a file and
upload it whether or not the lint step failed:

```yaml
name: q code scanning
on: [push, pull_request]
jobs:
  qlinter:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: kwojdalski/q-lint@v0.34.0
        continue-on-error: true
        with:
          version: 0.34.0
          format: sarif
          args: --output-file qlinter.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: qlinter.sarif
          category: qlinter
```

Paths in the report are relative to the directory qlinter runs in, which
for the action is the checkout's root, as code scanning wants.

### Without the action

The action is a download and one command. On a runner that already has
qlinter on `PATH`, run it directly:

```yaml
- run: qlinter --format github src
```

## GitLab CI

qlinter writes no GitLab Code Quality report, so this job fails on a
finding and keeps the JSON report ([its fields](output.md)) as an artifact:

```yaml
qlinter:
  image: debian:bookworm-slim
  variables:
    QLINTER_VERSION: "0.34.0"
  before_script:
    - apt-get update -qq && apt-get install -y -qq curl ca-certificates > /dev/null
    - name="qlinter-v${QLINTER_VERSION}-x86_64-unknown-linux-gnu"
    - base="https://github.com/kwojdalski/q-lint/releases/download/v${QLINTER_VERSION}"
    - curl -fsSLO "${base}/${name}.tar.gz" && curl -fsSLO "${base}/SHA256SUMS"
    - grep "  ${name}.tar.gz$" SHA256SUMS | sha256sum -c -
    - tar xzf "${name}.tar.gz" && export PATH="$PWD/${name}:$PATH"
  script:
    - qlinter --format json --output-file qlinter.json src || true
    - qlinter src
  artifacts:
    when: always
    paths: [qlinter.json]
```

The second run prints the findings as text in the job log and sets the
job's exit code; the first only writes the report.

## pre-commit

The hooks lint the `.q` files a commit changes. `qlinter` builds the linter
at `rev` with cargo, so it needs Rust; `qlinter-system` runs the `qlinter`
already on `PATH`:

```yaml
repos:
  - repo: https://github.com/kwojdalski/q-lint
    rev: v0.34.0
    hooks:
      - id: qlinter-system
        args: [--profile, style]
```

Both pass `--force-exclude`, so the configuration's `exclude` holds for the
files pre-commit names one by one.

## Adopting on a tree with findings

A baseline records every finding the tree has today, so CI fails only on
new ones. Write it once and commit it:

```sh
qlinter --write-baseline qlinter-baseline.json src
```

and name it in the configuration, so every run under it - CI, pre-commit,
the editor - uses it without a flag:

```toml
# qlinter.toml
baseline = "qlinter-baseline.json"
```

From then on

```sh
qlinter src
```

reports only what the baseline does not hold, says on standard error how
many it passed over, and exits 0 when nothing is new. A finding is matched on its file, code and the text of its line, so
lines added above it leave it matched and an edit to its own line makes it
new: code that is touched gets linted. Writing the baseline again after a
cleanup shrinks it; `--write-baseline` reads no baseline, so it always
records everything.

The other way in marks each finding where it is, with a `/ noqa: CODE` on
its line - visible in the code and reviewed with it, where a baseline is one
file nobody reads:

```sh
qlinter --add-noqa src
```
