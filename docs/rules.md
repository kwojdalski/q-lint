# Rules

All 87 rules, generated from `src/taxonomy.json` - the same data
`qlinter --rules` and `qlinter --explain <CODE>` print from. Regenerate with
`python3 scripts/rules_doc.py > docs/rules.md`; a test fails when this is stale.

## Where the rules come from

Three sources, and the profile a rule lands in says which.

**q itself.** Every rule in the `general` set reports something the interpreter
refuses. Each was settled by running the construct through q rather than by
reading the reference, and [docs/design.md](design.md) explains why that is
the line the default holds.

**Other linters' hazards, translated.** [docs/ruff-applicability.md](ruff-applicability.md)
reads ruff's 969 rules by the hazard each encodes rather than by its Python
mechanism, and lists which survive the translation. Most of the `style` set
came from that survey, and each was checked against q before it was written.

**Published q style guidance.** [qbists/style](https://github.com/qbists/style)
is Stevan Apter's "Remarks on Style" adapted to q; the
[FINOS q coding guidelines](https://github.com/finos/kdb/blob/main/enterprise-best-practices/q-coding-guidelines.md)
and its [qdoc](https://github.com/finos/kdb/tree/main/qdoc) convention are the
enterprise counterpart. The `styleq` set quotes the sentence each rule comes
from, and `.claude/skills/q-style/SKILL.md` records which guidance was measured
against real q and refused, with the numbers.

## Profiles

| profile | reports |
|---|---|
| `general` | only what q refuses to run |
| `style` | `general`, plus q that runs and is wrong |
| `styleq` | `style`, plus the published style-guide conventions |
| `uqf` | everything - the default |

The default is the broadest. This binary reports all it can see; a consumer
that wants fewer findings narrows in its own configuration.

## Syntax - source q cannot read at all

| code | name | summary | on in |
|---|---|---|---|
| `QE001` | syntax-delimiter | Unbalanced delimiter or unterminated string | every profile |
| `QE002` | invalid-string-escape | Invalid q string escape | every profile |
| `QE003` | unterminated-block-comment | Block comment opened but never closed | `style` and above |
| `QE004` | foreign-operator | Operator from another language; q has no ==, !=, && or \|\| | every profile |
| `QE005` | byte-order-mark | File starts with a BOM, which q refuses to load | every profile |

## Names - parameters, locals, globals and what they shadow

| code | name | summary | on in |
|---|---|---|---|
| `QF001` | reserved-parameter | Builtin name used as a parameter | `style` and above |
| `QF002` | underscore-parameter | `_` is the drop operator, not a parameter name | `style` and above |
| `QF003` | reserved-local | Assignment to a builtin in a lambda | every profile |
| `QF004` | reserved-definition | Namespace definition shadows a builtin | every profile |
| `QF005` | nested-local-reference | Nested lambda expects an outer local | every profile |
| `QF006` | reserved-name-in-embedded-q | Builtin column name in embedded q | a Python hook |
| `QF007` | not-a-parameter-list | Brackets after { are body text, not parameters | every profile |
| `QF008` | duplicate-parameter | Parameter declared more than once | `style` and above |
| `QF009` | empty-parameter-slot | Empty slot in a parameter list is still a parameter | `style` and above |
| `QF010` | implicit-argument-with-signature | x, y or z used where parameters are declared | every profile |
| `QF012` | reserved-root-assignment | Root-level assignment to a reserved name | `style` and above |
| `QF013` | reserved-table-column | Builtin name as a table-literal column | every profile |
| `QF014` | local-read-before-assign | Name read before the assignment that makes it local | every profile |
| `QF015` | foreign-keyword | Keyword from another language resolves as an undefined global | every profile |
| `QF016` | unused-parameter | Declared parameter the body never reads | `style` and above |
| `QF017` | unused-local | Local assigned and never read | `style` and above |

## Application - how many arguments a thing takes and how it is called

| code | name | summary | on in |
|---|---|---|---|
| `QA001` | parameter-limit | Lambda declares more than eight parameters | every profile |
| `QA002` | literal-lambda-rank | Too many arguments for a literal lambda | every profile |
| `QA003` | multiparam-under-at | Unary protected apply receives a multi-argument function | `style` and above |
| `QA004` | dot-empty-list | Empty-list application to a niladic function | every profile |
| `QA005` | each-on-binary | each supplies one argument to a binary function | `style` and above |
| `QA006` | cond-two-slots | Two-slot conditional has no else branch and errors at runtime | every profile |
| `QA007` | cond-even-slots | Even-slot $[ ... ] has no else branch and returns null | `style` and above |
| `QA008` | parenthesised-call | f(a;b) passes one list to a lambda of rank 2 or more | `style` and above |
| `QA009` | dot-apply-scalar | Dot apply given a scalar where an argument list is required | every profile |
| `QA010` | builtin-excess-arguments | Excess arguments in a complete builtin call | every profile |
| `QA011` | cond-non-atom-condition | $[ ... ] condition must be an atom; a vector or symbol is a type error | every profile |
| `QA012` | named-lambda-rank | More arguments than the named lambda takes | every profile |

## Types and shapes - literals that cannot be what the operator needs

| code | name | summary | on in |
|---|---|---|---|
| `QT001` | literal-dictionary-length | Literal dictionary key/value lengths differ | every profile |
| `QT002` | literal-argument-type | Symbol passed to a visible numeric function | every profile |
| `QT003` | symbol-arithmetic | Arithmetic on a symbol literal errors at runtime | every profile |
| `QT004` | cast-by-name-on-string | Symbol-named cast on a string converts char codes, not text | `style` and above |
| `QT005` | single-row-table | Table literal of scalars needs enlist and errors 'rank | every profile |
| `QT006` | vector-length-mismatch | Infix on two literal vectors of different lengths | every profile |
| `QT007` | string-function-on-symbol | ss or ssr given a symbol literal is a runtime type error | every profile |
| `QT008` | literal-til-type | til called with a float or numeric vector | every profile |
| `QT009` | literal-where-type | where called with counts other than booleans or longs | every profile |
| `QT010` | symbol-numeric-aggregate | Numeric aggregate or scan applied to a symbol literal | every profile |
| `QT011` | sort-literal-atom | Sorting applied to a literal atom instead of a list | every profile |
| `QT012` | distinct-literal-atom | distinct applied to a literal atom instead of a list | every profile |
| `QT013` | flip-flat-numeric | flip applied to a numeric atom or flat vector | every profile |
| `QT014` | literal-rotate-count | rotate count is not an integer atom | every profile |
| `QT015` | symbol-comparison | Symbol compared with a number or string is a runtime type error | every profile |
| `QT016` | symbol-math-argument | Numeric math applied to a symbol literal | every profile |
| `QT017` | literal-moving-window | Moving-window size is not an integer atom | every profile |
| `QT018` | literal-statistical-length | Literal inputs to cor, cov, wavg or wsum have incompatible lengths | every profile |
| `QT019` | literal-within-bounds | within bounds are not a two-item list | every profile |
| `QT020` | table-column-length | Table literal columns of different lengths | every profile |
| `QT021` | empty-search-pattern | ss or ssr with an empty pattern is a length error | every profile |

## Correctness - q that runs and does the wrong thing

| code | name | summary | on in |
|---|---|---|---|
| `QB001` | self-comparison | qSQL filter compares a name to itself | `style` and above |
| `QB002` | interior-like-wildcard | Unsupported interior wildcard in like | every profile |
| `QB003` | unparenthesised-sv | Concatenation is consumed by sv | `style` and above |
| `QB004` | overlong-throw | Thrown message risks truncation | `style` and above |
| `QB005` | match-in-where | Match in a qSQL filter compares whole vectors, not rows | `style` and above |
| `QB006` | comparison-with-logic | Unparenthesised comparison mixed with and/or reads right-to-left | `style` and above |
| `QB007` | like-symbol-pattern | like with a symbol pattern is a runtime type error | every profile |
| `QB008` | vector-equality-filter | Column equality against a vector literal in a filter | `style` and above |
| `QB009` | unaggregated-under-by | Bare column under by silently takes the last row per group | `style` and above |
| `QB010` | apply-not-subtract | Name, space, negative literal applies the name rather than subtracting | every profile |
| `QB011` | control-as-value | if, while or do assigned as a value is always null | `style` and above |
| `QB012` | trailing-semicolon-body | Lambda ends in ; so its last expression is discarded | `style` and above |
| `QB013` | type-compared-to-symbol | type returns a short; comparing it to a symbol is a type error | every profile |
| `QB014` | slash-division | / after a value is the over adverb, not division | `style` and above |
| `QB015` | string-equality-filter | Equality against a string literal in a filter errors at runtime | every profile |
| `QB016` | delete-columns-and-rows | delete cannot take both columns and a where phrase | every profile |
| `QB017` | self-assignment | A name assigned to itself | `style` and above |
| `QB018` | constant-comparison | Two literals compared, so the answer never varies | `style` and above |

## Domain - literal arguments outside what a builtin accepts

| code | name | summary | on in |
|---|---|---|---|
| `QD001` | negative-til | til called with a negative literal count | every profile |
| `QD002` | negative-where | where called with negative literal repetition counts | every profile |

## Policy - one repository's conventions

| code | name | summary | on in |
|---|---|---|---|
| `QP001` | bare-slash-block | Bare slash opens a block comment | `uqf` |
| `QP002` | datetime-type | Legacy datetime precision | `uqf` |
| `QP003` | wall-clock-temporal | Wall-clock timestamp where the convention is UTC | `uqf` |
| `QP005` | mixed-infix-precedence | Unparenthesised * or % mixed with + or - relies on right-to-left order | `uqf` |

## Style guide - conventions from published q guidance

| code | name | summary | on in |
|---|---|---|---|
| `QS001` | underscore-in-name | Name contains `_`, which is also the drop operator | `styleq` and above |
| `QS002` | dot-in-name | Name has an interior dot but is not a namespace | `styleq` and above |
| `QS003` | name-l | `l` as a name reads as `1` | `styleq` and above |
| `QS004` | redundant-parentheses | A single token wrapped in parentheses | `styleq` and above |
| `QS006` | lambda-length | Lambda longer than twenty five lines | `styleq` and above |
| `QS007` | documented-parameter-absent | `@param` names a parameter the lambda does not take | `styleq` and above |
| `QS008` | implicit-name-out-of-position | `x`, `y` or `z` declared in a position q would not give it | `styleq` and above |
| `QS009` | implicit-name-as-local | `x`, `y` or `z` used as a local beside named parameters | `styleq` and above |

## External - findings relayed from another tool

| code | name | summary | on in |
|---|---|---|---|
| `QLS001` | qls/diagnostic | Diagnostic from the external qls server | the qls backend |

