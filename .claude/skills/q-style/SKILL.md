---
name: q-style
description: Published q/kdb+ style guidance and which of it a linter can check. TRIGGER when proposing, writing or narrowing a rule for the styleq profile; when asked what idiomatic q looks like; when deciding whether a construct is a house preference or a community convention. SKIP for rules about what q refuses to run - those come from the interpreter, not from a style guide.
type: skill
---

Two published sources carry q style guidance, and they disagree in tone more
than in substance.

**[qbists/style](https://github.com/qbists/style)** is Stevan Apter's "Remarks
on Style" adapted to q: essays on names, whitespace, line length, conditionals,
de-looping, parentheses. It argues from taste and gives alternatives rather
than rules, and is usually careful to say a choice is a choice.

**[finos/kdb enterprise-best-practices](https://github.com/finos/kdb/blob/main/enterprise-best-practices/q-coding-guidelines.md)**
is the enterprise counterpart, drawn from Jeff Borror's material, Charlie
Skelton's guidelines and the same Apter essays. It states rules, which makes it
the one a linter can act on.

## What is checkable, and what this repository does with it

A rule taken from a style guide is one community's convention, so it belongs in
the `styleq` profile rather than the default - the same argument that keeps
`uqf` behind its own name. `--profile general` answers only "would q refuse
this", and no style guide has anything to say about that.

| guidance | source | checkable |
|---|---|---|
| avoid `_` in names, since it is the drop operator | FINOS | yes, and precisely |
| do not use `.` in a name unless it is a namespace | FINOS | yes - `myspace.myvar` versus `.myspace.myvar` |
| never use `l` as a name; it reads as `1` | FINOS | yes |
| reserve `x`, `y`, `z` for implicit parameters, and do not use them as locals when the parameters are named | FINOS | already **QF010** |
| global constants in capitals, globals capitalised, functions lower or camel case | FINOS | partly - the convention is clear, the intent of a name is not |
| a function over twenty-five lines is certifiable | FINOS | yes |
| q allows eight parameters; use fewer | FINOS | already **QA001** at the hard limit |
| use a blank after `;` separators | FINOS | yes |
| do not put blanks around every operator | FINOS | stated as a preference, and the opposite is also published |
| no unnecessary parentheses | both | hard: "unnecessary" needs q's precedence, and q has one rule for all of it |
| use adverbs rather than loops | both | this is issue #10, from the ruff survey |
| ternary `$[...]` for a value, `if[...]` for a side effect | FINOS | already **QB011** |

## What the corpus said about these

Measured over 1296 files of real q, under `--profile styleq`:

| rule | findings | reading |
|---|---|---|
| QS001 avoid `_` in names | 7573 | the convention is widely ignored; real q names contain underscores everywhere |
| QS002 interior dot at root | 0 | every apparent case was a sub-namespace inside `\d`, which q creates properly |
| QS003 `l` as a name | 45 | rare, and each one genuinely hard to read |

QS001's volume is the reason the profile is opt-in rather than the reason to
drop the rule: someone turning on `styleq` is asking for the guide's opinion,
and the guide's opinion is that those names are hard to read. But a rule at
that volume is a decision the user makes, not one the linter makes for them.

QS002 is worth dwelling on. Read literally, `i.formatBuild:` is a name with an
interior dot. Inside `\d .dfilt` it is `.dfilt.i.formatBuild`, a sub-namespace
q creates correctly, and the guidance is about the name at *root* that only
looks like a namespace. The rule fires at root and nowhere else, and that took
the count from 98 to 0 - which is the right answer, since the corpus contains
no instance of what the guidance actually warns about.

## What not to take from these

The guides contain a great deal that is taste, and taste is where a linter
earns distrust. `qbists/style` shows three spacings of the same function and
declines to pick one. Several FINOS rules are about names meaning the right
thing, which no linter can see.

The test before writing a rule from either guide is the one in `CLAUDE.md`: run
it over a corpus of real q. A convention that the published guide states and
real q ignores is a convention, not a defect, and a rule for it will be turned
off.

## The distinction that matters

These guides describe q written well. `--profile general` is about q that will
not run. They are different questions, and a rule that confuses them makes the
default untrustworthy - which is the one thing this linter cannot afford, since
its whole claim is that it is safe to run on every keystroke.
