---
name: bugfinder
description: Hunt for logic bugs in the q linter - findings that are wrong, silent, misplaced, or claim something q does not do. Traces a construct from source through masking, the rules and the scope pass to see what the linter actually reports, and checks that against q itself. Use when the user suspects the tool is giving a wrong answer rather than crashing, or asks for a bug sweep. Adapted from the masters_thesis bugfinder; the categories are a linter's, not a trading model's.
---

# Bug Finder

You are debugging a linter for q. Its whole contract is that it reads source
without running it and says what q would say. A bug here is any gap between
those two: a finding on code q accepts, silence on code q refuses, a finding
on the wrong line, a message asserting an error q does not raise, or an answer
that changes with something irrelevant - line endings, a comment, a string.

The tool that settles every question is q itself. `q` is on this machine. Do
not reason about what q does when you can run it.

## Commands

```
Commands: ok — acknowledge and fix | s/skip — skip this entry | done — finish review
```

## Bug Categories

Scan for these, in order of severity.

### 1. False positive
A finding on working q. The worst kind: it teaches the user to ignore the
tool. Sources of these in this codebase, each seen before:
- a pattern matching a *prefix* of a longer expression (`0i=`int$x` read as
  `0i=`int`; `` `time in 0!t `` read as `` `time in 0 ``)
- masking making a string indistinguishable from whitespace, so `\s*` walks
  through twenty lines of one and joins two unrelated expressions
- q's continuation rule: an indented line continues the one above, a bare `/`
  is a block comment only at column 0
- a literal shape misjudged: `10b` is a two-item vector, `0x0102` likewise,
  `"a"` is an atom
- column names read as locals: `([]a:1)`, `update x:... from t` and `select
  y:... from t` all use assignment syntax and none of them assigns
- a name whose meaning depends on `\d` - `i.helper` inside `\d .ns` is a
  legitimate sub-namespace
- reserved words that are not: the list comes from `.Q.res` and ``key `.q``,
  and anything hand-added is suspect

### 2. False negative
Silence on code q refuses. Check the taxonomy's claim against the rule's
actual reach: a rule for "arithmetic on a symbol literal" that only sees `+`
and not `-`, a rule that handles `f[1;2]` but not `f[1] 2`, a rule that
handles one line and not a statement continued onto the next.

### 3. Wrong position
The right finding at the wrong line or column. Offsets are byte offsets into
a masked view that must keep the source's length exactly; a BOM, a multi-byte
character, a CRLF, or a rule that computes `offset + m.start()` against the
wrong base all move a finding. Columns are UTF-16 units for the LSP.

### 4. Wrong claim
A message or taxonomy summary naming an error q does not raise. `$[1b;2]` is
'type, not 'nyi. `sym~`EUR` in a filter raises nothing and returns an empty
table. Every error name in a message is a claim; check the ones that look
doubtful against `@[value; "..."; {x}]`.

### 5. Answer depends on something irrelevant
Same q, different findings, because of: CRLF versus LF, a comment on the line,
a string on the line, the profile (a `builtin` rule that fires only under
`style`), file position (a rule that only works at top level), or the file
having been analysed before in the same process (state carried across files).

### 6. Structural
The pipeline itself: `views()` producing a `code` whose length differs from
`source`; `matching()` miscounting through a string with an escaped quote;
`signature()` and `semantics` disagreeing about whether `{[...]` is a
parameter list; `scope_at` returning the wrong scope at a boundary; a finding
emitted for a code not in the taxonomy (`Finding::new` panics on that).

## Steps

1. Output the commands reference above immediately.

2. Check existing issues first, so nothing is filed twice:

   ```
   gh issue list --label bugfinder --state all --limit 100 --json number,title,body,state
   gh issue list --state open --limit 100 --json number,title
   ```

   For each, note the file, the rule code, and the root cause. A finding that
   matches an existing issue's rule and cause is a duplicate whatever its
   wording.

3. Read the code that matters, in this order:
   - `src/lib.rs` - `views`, `structure`, `matching`, `slots`, `signature`,
     `flat_filter`, then the rule loops in `lint`
   - `src/semantics.rs` - scopes, `statement_view`, the QF rules
   - `src/intrinsics.rs` - the literal-call checks
   - `src/lsp.rs` - position conversion
   - `src/taxonomy.json` - every summary is a claim

   Trace a construct through, not just the rule that names it: what does
   `views` do to it, which loop sees it, what offset does the finding get.

4. For every suspicion, build the smallest q file that shows it and run both:

   ```
   ./target/release/qlinter --profile uqf --format json probe.q
   q probe.q -q      # with the construct wrapped in @[value;...;{x}]
   ```

   A finding without both outputs is a suspicion, not a finding.

5. For each finding, record:
   - category and severity
   - file and line of the *rule*, and the probe that shows it
   - what the linter reports, verbatim
   - what q does, verbatim
   - a fix, concrete enough to apply

6. Filter against the existing issues from step 2. Same rule, same root cause
   is the same issue; drop those.

7. Rank: category 1 first, then 2, 4, 3, 5, 6. Within a category, by how
   common the triggering shape is in real q - `scripts/corpus_diff.py` and
   the corpus on this machine answer that.

8. Print the summary table:

```
BUG REPORT (N new findings, M duplicates filtered out)
 # | Cat | Severity | Bug                                          | Rule / file
---|-----|----------|----------------------------------------------|------------------
 1 |  1  | HIGH     | QB018 fires on `0<0^x`, fill reads as compare | lib.rs:1290
```

9. Say: "Found N new bugs (M duplicates filtered). Starting review - reply ok
   to acknowledge and fix, s to skip, done to stop."

## GitHub Issues

For every finding in the table, one issue:

```
gh label create bugfinder --color "#d93f0b" --description "Logic bug found by the bugfinder skill" 2>/dev/null || true
gh issue create --label bugfinder --title "<rule>: <what is wrong>" --body "$(cat <<'EOF'
**Rule:** <code> in <file:line>
**Category:** <number and label>
**Severity:** <HIGH / MEDIUM / LOW>

**Probe:**
```q
<the smallest q that shows it>
```

**The linter reports:** <verbatim>
**q does:** <verbatim, from @[value;...;{x}]>

**Fix:** <concrete>
EOF
)"
```

One issue per finding. Print the URLs afterwards.

## Interactive Review

Work through the ranked list one at a time: show the rule with context, the
probe, both outputs, the fix. Wait for `ok`, `s`, `done`, or an instruction.

On `ok`: apply the fix, add the probe as a case in `tests/cases/` (positive
and the negative that bounds it), run `cargo test`, and run
`scripts/corpus_diff.py` against the previous binary before moving on. A fix
that moves other findings on the corpus is not finished.

## Finishing

On `done` or the end of the list: one commit per fix, `Fix: <rule>: <what>`.
Close each fixed issue with the commit hash. Report counts, and say which
findings were skipped and why.

## Important

- A finding without a q probe and a linter probe is not a finding.
- Do not flag style, missing tests, or design - those have other owners.
- Do not flag a rule for being in the wrong profile; that is a policy call.
- Every finding names a line in `src/`. Read the file again if you cannot.
- No emojis.
