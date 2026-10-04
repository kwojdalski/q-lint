# qlinter

A standalone linter for q/kdb+ source, in Rust, plus a language server and a
VS Code client for it.

## The property the whole design rests on

**This tool never executes the source it reads.** That is what makes it safe
to run on every keystroke in an editor, and it is the reason several
capabilities are absent rather than merely unimplemented: completion, hover
and go-to-definition need a resolver and a symbol table, and building one
would mean giving up the guarantee. A change that would require evaluating
input is a change to the premise, not a feature.

## Verify with

```sh
cargo test                                  # unit, CLI, LSP and corpus suites
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

A new rule wants one more thing, because none of the above can catch the way
rules actually go wrong. Build the binary before and after, and diff them over
a body of q nobody here wrote:

```sh
python3 scripts/fetch_corpus.py ~/q-corpus      # once: 707 files of public q, pinned
python3 scripts/corpus_diff.py /tmp/qlinter-before target/release/qlinter ~/q-corpus
```

A diff that moves nothing is only reassuring if the corpus holds the shape
the rule reads - check that it does before taking the silence as a pass.

Two more checks over the same corpus catch what a diff cannot:

```sh
python3 scripts/check_invariance.py target/release/qlinter ~/q-corpus  # CRLF, position, comments
python3 scripts/check_fixes.py target/release/qlinter ~/q-corpus      # every --fix keeps the program
```

The first rewrites each file in ways that leave its meaning alone and wants
the same findings back. The second applies `--fix` and asks q to `parse` both
sides of every rewrite - reading, not running - and compares what they compile
to. Run it whenever a fix or the extent of an argument changes.

A rule that looks obviously right on the cases its author wrote is exactly
the kind that reports hundreds of findings on working q. `tests/corpus/` pins
the shapes already known to be hard; the diff is for the ones nobody has
thought of.

The LSP suite spawns the real binary and drives it over real protocol
framing, because the two things most likely to break an editor integration -
the wire framing and the process not exiting - only exist once there is a
process.

`docs/design.md` explains why there is no parser here and what that costs.
Read it before adding a rule that wants one.
`docs/ruff-applicability.md` is the survey of what a linter for another
language checks and what of it ports, which is where a proposed rule should be
checked against before it is written.

`.claude/skills/torq-developer/` carries the q and TorQ reference this work
leans on - the language's semantics, the framework's namespaces, and the
process conventions real q is written against.

## Where things are

| | |
|---|---|
| `src/lib.rs` | the rule engine; `lint(source, path, uqf)` is the entry point |
| `src/semantics.rs` | the checks that need more than a regex |
| `src/taxonomy.json`, `src/reserved.json` | rule catalogue and q builtin names, embedded at build time |
| `src/lsp.rs` | the language server (`qlinter --lsp`) |
| `src/jsonrpc.rs` | LSP wire framing, shared by the server and the qls client |
| `src/qls.rs` | client for KX's qls, an optional second backend |
| `editors/vscode` | the VS Code extension, ~30 lines over `vscode-languageclient` |

## Two rules worth stating

- **A rule's description lives in `src/taxonomy.json`**, which `--rules` and
  `--explain` print from. Prose that repeats it is a second place to be wrong.
- **A rule belongs in `general` only if q rejects the construct.** The
  default answers one question - would q refuse this? - so a rule fires there
  only when the source fails to parse or fails the moment it runs. A construct
  q accepts and executes is describing a habit, and belongs in `style`.
  `--profile uqf` encodes another repository's conventions on top of that, and
  a rule that only makes sense for one codebase belongs there.

  Which of the three a construct falls into is settled by running it through
  q, not by reading the manual. The reference is q 5 (`.z.K` 5, the `q` on
  this machine); where versions disagree, q 5's answer is the rule's, and
  the rule says so. Char arithmetic is the known case: this repository once
  recorded `"a"*3` as 291, on a version nobody wrote down, and q 5 raises
  'type. Record the version whenever an answer could depend on it. For
  example: `{[count] count+1}` runs perfectly well and is
  `style`, while `{[a] x+1}` throws 'x the moment it is called and is
  `general`.
