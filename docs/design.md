# How this works, and why it is not a parser

A reader who has written a linter before will expect to find a parser here,
producing a syntax tree that rules walk. There isn't one, and that is a
decision rather than an omission. This is what the tool does instead, and what
it costs.

## The pipeline

Source goes through four stages. Each is in `src/lib.rs` unless said
otherwise.

**1. Views (`views`).** One pass produces `code`: the source with every string
literal and comment overwritten by spaces, **in place**. The result has the
same length and the same byte offsets as the source, so a position found in
one view names the same character in the other. The same pass records where a
string was left unterminated, where `k)` and `p)` prefixes embed another
language, and where a block comment was opened.

Everything downstream reads `code`, which is why no rule has to know what a
comment looks like or worry about a `}` inside a string. The cost is that a
rule which genuinely needs the text back - to tell an empty parameter slot
from a string literal, say - has to consult the raw source at the same offsets
and explicitly say so.

**2. Structure (`structure`).** Bracket and quote balance. An unbalanced file
returns a single finding and stops: with delimiters wrong, every later rule is
reading text that does not mean what it appears to, and reporting on it
produces noise rather than help.

**3. Rules (`lint`).** Two kinds. Some scan the whole file for a pattern.
Others run in a loop over *statements* - q continues a line onto the next when
that one begins with whitespace, so the loop folds indented lines into the one
above, at the top level only. Inside a bracket q already ignores newlines, and
those rules have always read such lines one at a time.

**4. Scope (`semantics::check`).** The part that needs more than a pattern:
which lambda a name is in, whether it is a parameter, a local, or a global,
and which namespace a `\d` directive has in force. It builds a flat list of
scopes, each with the byte range of its body, its parameters and the names
assigned inside it, and answers questions like "is this name a local of an
enclosing lambda that q will not let the inner one see".

A profile then filters what is reported, by the scope each rule declares in
`src/taxonomy.json`. Filtering happens once, on the way out, rather than at
every emission site.

## Why not a syntax tree

The no-execution guarantee is **not** the reason. A parser does not run what
it reads either. Four things are.

**q has no grammar to implement.** There is no published formal grammar, and
the language resists one. Glyphs are overloaded by arity and by operand type:
`$` is cast, conditional, and pad; `?` is find, roll, and vector conditional;
`.` is apply, namespace separator, and part of a literal. Adverbs modify verbs
into new verbs. qSQL is a sublanguage inside the expression grammar, with its
own scoping of column names. `k)` and `p)` prefixes embed a different language
entirely, mid-file. A parser for all of that is a large and permanent
commitment, and a wrong one is worse than none, because its errors are
invisible - a mis-parse silently changes what every rule sees.

**The input is usually incomplete.** This runs on every keystroke in an
editor, where most of what it sees is half-typed. A parser's response to
invalid input is to fail, and a linter that reports nothing while you are
typing is a linter that reports nothing when you need it. Masking and matching
degrade instead: a rule whose pattern no longer fits stays quiet, and the
others keep working.

**Most rules do not need a tree.** They ask local questions - is this name a
q builtin, is that bracket group a parameter list, does this filter compare a
column to itself. A tree would answer them, but so does the text, and the text
needs no grammar to be right about.

**The rules that do need structure take it locally.** `matching` walks
delimiters from a position, respecting strings, to find the group that closes
one. `slots` splits a bracket group on top-level `;`. `signature` decides
whether `{[...]` is a parameter list at all - q reads those brackets as a
signature only when every slot is a name, and as the start of the body
otherwise, which changes the lambda's rank without changing how it looks.
`flat_filter` blanks parenthesised subexpressions so a rule can ask what is
left at the top level of a `where` phrase. `semantics` tracks scopes.

That is the real shape of this design: not "regex instead of parsing", but
parse exactly as much as a rule needs, at the point it needs it, and nothing
else. The general-purpose tree is what is missing, not the structure.

## What it costs

**Patterns match prefixes.** The commonest way a rule here goes wrong is
matching part of a larger expression and reporting on the part. `` 0i=`int$x ``
looks like a number compared to a symbol until the `$` that makes it a cast;
`` `time in 0!t `` looks like a symbol compared to a number until the `!` that
unkeys a table. Every rule that matches operands has to check that what
follows does not continue them. A tree would not have this failure mode.

**Masking loses information.** A blanked string is indistinguishable from
whitespace, so a `\s*` in a pattern will happily step across twenty-six lines
of one and join two expressions that have nothing to do with each other. A
rule that spans whitespace has to bound itself, or check the raw source for
the quote that explains the blanks.

**The statement model approximates.** Folding on indentation matches what q
does at the top level. Inside brackets it deliberately does not fold, which is
right for the rules as written but is not what q's grammar says.

These are not incidental bugs to be fixed one day; they are the standing cost
of the approach, and they are why the verification in `CLAUDE.md` asks for a
corpus diff before a rule ships. A tree would trade them for a different cost -
a parser to keep correct against a language with no specification - and the
judgement here is that the second bill is larger and falls due forever.

## Where structure is worth adding

Some open work does want more than the text: knowing the rank of a *named*
lambda to tell whether a call passes too many arguments, or the length of a
named vector. That is a symbol table, not a full tree, and it can be built the
way `semantics` builds scopes - narrowly, for the rules that ask.

The line to hold is the one in `CLAUDE.md`: anything requiring the source to
be evaluated is a change to the premise, not a feature.
