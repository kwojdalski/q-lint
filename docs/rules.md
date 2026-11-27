# Rules

All 145 rules, generated from `src/taxonomy.json` - the same data
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
| `general` | only what q refuses to parse or run |
| `style` | `general`, plus q that runs and is wrong |
| `styleq` | `style`, plus the published style-guide conventions |
| `uqf` | every rule a profile turns on - the default |

The default is the broadest. This binary reports all it can see; a consumer
that wants fewer findings narrows in its own configuration.

A rule marked *no profile* is the exception: no profile reports it, `uqf`
included. It is a convention stricter than any profile asks for, and is on
only where `select` or `extend-select` names it - by its code, a prefix of
it, or `ALL`.

## Syntax - source q cannot read at all

| code | name | summary | on in |
|---|---|---|---|
| <a id="qe001"></a>`QE001` | syntax-delimiter | Unbalanced delimiter, more than 100 nested, or unterminated string | every profile |
| <a id="qe002"></a>`QE002` | invalid-string-escape | Invalid q string escape | every profile |
| <a id="qe003"></a>`QE003` | unterminated-block-comment | Block comment opened but never closed | `style` and above |
| <a id="qe004"></a>`QE004` | foreign-operator | Operator from another language; q has no ==, !=, &&, \|\|, **, =>, -> or := | every profile |
| <a id="qe005"></a>`QE005` | byte-order-mark | File starts with a BOM, which q refuses to load | every profile |
| <a id="qe006"></a>`QE006` | impossible-temporal | A date, month or time q refuses to parse: a day that does not exist, a minute past 59, a one-digit field | every profile |
| <a id="qe007"></a>`QE007` | qsql-missing-from | select, exec, update or delete with no from before the statement ends, nothing after its from or its where, or a phrase q refuses: a trailing comma, an empty row limit, a second by, an update with no column | every profile |
| <a id="qe008"></a>`QE008` | monadic-glyph | A glyph applied to one argument; q 5 refuses -x, ,x, #x and the rest - the keyword is neg, enlist, count, not... - and an infix keyword with nothing on its left, in b; KDB-X only: not for an older target-version | every profile |
| <a id="qe009"></a>`QE009` | juxtaposed-derived-function | A derived function applied by juxtaposition: q 5 refuses +/x, count'x and x/y, and an iterator after a blank, x 'y; write (+/)x, +/[x] or sum x; KDB-X only: not for an older target-version | every profile |
| <a id="qe010"></a>`QE010` | malformed-number | A number q 5 cannot parse: 1.5j, 2b, 3i 4j, 1y, 1.2.3, or an integer that overflows its type (2147483648i, 32768h) | every profile |
| <a id="qe011"></a>`QE011` | infix-keyword-each | An infix keyword before each or peach: q 5 refuses cor each x and x within each y; write (cor) each, cor' or cor[x] each; KDB-X only: not for an older target-version | every profile |
| <a id="qe012"></a>`QE012` | non-ascii-character | A character past ASCII outside a string or comment - a no-break space, a curly quote, a byte-order mark mid-file - or an ASCII control character there, which q refuses with 'char | every profile |
| <a id="qe013"></a>`QE013` | table-literal-empty-slot | An empty column slot in a table literal, ([] a:1 2; ) or ([] a:1 2;;b:3 4), which q 5 refuses at parse with '; | every profile |

## Names - parameters, locals, globals and what they shadow

| code | name | summary | on in |
|---|---|---|---|
| <a id="qf001"></a>`QF001` | reserved-parameter | Builtin name used as a parameter | every profile |
| <a id="qf002"></a>`QF002` | underscore-parameter | `_` is the drop operator, not a parameter name: q 5 refuses every call with 'match, or a name starting with it where the lambda is defined | every profile |
| <a id="qf003"></a>`QF003` | reserved-local | Assignment to a builtin in a lambda | every profile |
| <a id="qf004"></a>`QF004` | reserved-definition | Assignment to a builtin outside a lambda, which q refuses | every profile |
| <a id="qf005"></a>`QF005` | nested-local-reference | Nested lambda expects an outer local | every profile |
| <a id="qf006"></a>`QF006` | reserved-name-in-embedded-q | Builtin column name in embedded q | a Python hook |
| <a id="qf007"></a>`QF007` | not-a-parameter-list | Brackets after { that are no parameter list or pattern: q 5 refuses the lambda where it is defined, or with a symbol in a slot every call to it | every profile |
| <a id="qf008"></a>`QF008` | duplicate-parameter | Parameter declared more than once | `style` and above |
| <a id="qf009"></a>`QF009` | empty-parameter-slot | Empty slot in a parameter list is still a parameter | `style` and above |
| <a id="qf010"></a>`QF010` | implicit-argument-with-signature | x, y or z used where parameters are declared | every profile |
| <a id="qf012"></a>`QF012` | reserved-root-assignment | Root-level assignment to `from` or `by`, which q accepts though both are query keywords | `style` and above |
| <a id="qf013"></a>`QF013` | reserved-table-column | Builtin name as a table-literal column | every profile |
| <a id="qf014"></a>`QF014` | local-read-before-assign | Name read before the assignment that makes it local | every profile |
| <a id="qf015"></a>`QF015` | foreign-keyword | Keyword from another language resolves as an undefined global | every profile |
| <a id="qf016"></a>`QF016` | unused-parameter | Declared parameter the body never reads | `style` and above |
| <a id="qf017"></a>`QF017` | unused-local | Local assigned and never read | `style` and above |
| <a id="qf018"></a>`QF018` | possibly-undefined-name | Bare value read has no local or global definition in this file | `style` and above |
| <a id="qf019"></a>`QF019` | read-only-system-name | Assignment to a single-letter .z name, which q refuses with 'domain - but for .z.s in a lambda, the lambda's own | every profile |
| <a id="qf020"></a>`QF020` | unknown-column | A column a table literal does not have, in select, exec, update, a where phrase or xkey, and nothing defines it | every profile |
| <a id="qf021"></a>`QF021` | dotted-local | name.member on a parameter or local reads a global, never the local | every profile |
| <a id="qf022"></a>`QF022` | local-global-assignment | `::` on a parameter or local assigns the local, not a global of that name | `style` and above |
| <a id="qf023"></a>`QF023` | local-shadowed-by-column | A parameter or local read only in qSQL phrases over a table with a column of its name, where the column wins: its value is never read | `style` and above |

## Application - how many arguments a thing takes and how it is called

| code | name | summary | on in |
|---|---|---|---|
| <a id="qa001"></a>`QA001` | parameter-limit | Lambda declares more than eight parameters | every profile |
| <a id="qa002"></a>`QA002` | literal-lambda-rank | Too many arguments for a literal lambda | every profile |
| <a id="qa003"></a>`QA003` | multiparam-under-at | Protected apply of a multi-argument function returns a projection, and the trap never fires | `style` and above |
| <a id="qa004"></a>`QA004` | dot-empty-list | Empty-list application to a niladic function | every profile |
| <a id="qa005"></a>`QA005` | each-on-binary | each supplies one argument to a binary function | `style` and above |
| <a id="qa006"></a>`QA006` | cond-two-slots | Two-slot conditional has no else branch and errors at runtime | every profile |
| <a id="qa007"></a>`QA007` | cond-even-slots | Even-slot $[ ... ] has no else branch and returns null - or 'type, when the last test is a symbol or string | `style` and above |
| <a id="qa008"></a>`QA008` | parenthesised-call | f(a;b) passes one list to a lambda of rank 2 or more | `style` and above |
| <a id="qa009"></a>`QA009` | dot-apply-scalar | Dot apply given a scalar where an argument list is required | every profile |
| <a id="qa010"></a>`QA010` | builtin-excess-arguments | Excess arguments in a complete builtin call | every profile |
| <a id="qa011"></a>`QA011` | cond-non-atom-condition | $[ ... ], if and while tests and the do count must be atoms; a vector or symbol is a type error, and in a later $[ ... ] test a symbol, string or float is | every profile |
| <a id="qa012"></a>`QA012` | named-lambda-rank | More arguments than the named lambda takes | every profile |
| <a id="qa013"></a>`QA013` | multiparam-trap-handler | The error handler of @[f;x;h] or .[f;x;h] is a lambda of rank 2 or more, so an error returns a projection of it instead of running it | `style` and above |

## Types and shapes - literals that cannot be what the operator needs

| code | name | summary | on in |
|---|---|---|---|
| <a id="qt001"></a>`QT001` | literal-dictionary-length | Literal dictionary key/value lengths differ | every profile |
| <a id="qt002"></a>`QT002` | literal-argument-type | Symbol passed to a visible numeric function | every profile |
| <a id="qt003"></a>`QT003` | symbol-arithmetic | Arithmetic on a symbol literal errors at runtime | every profile |
| <a id="qt004"></a>`QT004` | cast-by-name-on-string | Cast named by symbol or lowercase type char on a string converts char codes, not text | `style` and above |
| <a id="qt005"></a>`QT005` | single-row-table | Table literal of scalars needs enlist and errors 'rank | every profile |
| <a id="qt006"></a>`QT006` | vector-length-mismatch | Infix on two vectors of known, different lengths | every profile |
| <a id="qt007"></a>`QT007` | string-function-on-symbol | ss or ssr given a symbol literal is a runtime type error | every profile |
| <a id="qt008"></a>`QT008` | literal-til-type | til called with something other than an integer atom | every profile |
| <a id="qt009"></a>`QT009` | literal-where-type | where called with counts other than booleans, ints or longs | every profile |
| <a id="qt010"></a>`QT010` | symbol-numeric-aggregate | Numeric aggregate or scan applied to a symbol, or to a string where q refuses one | every profile |
| <a id="qt011"></a>`QT011` | sort-literal-atom | Sorting applied to a literal atom instead of a list | every profile |
| <a id="qt012"></a>`QT012` | distinct-literal-atom | distinct applied to a literal atom instead of a list | every profile |
| <a id="qt013"></a>`QT013` | flip-flat-numeric | flip applied to an atom or a flat vector | every profile |
| <a id="qt014"></a>`QT014` | literal-rotate-count | rotate count is not an integer atom, or is null | every profile |
| <a id="qt015"></a>`QT015` | symbol-comparison | Symbol compared with a number or string is a runtime type error | every profile |
| <a id="qt016"></a>`QT016` | symbol-math-argument | Numeric math applied to a symbol literal or to the guid null | every profile |
| <a id="qt017"></a>`QT017` | literal-moving-window | Moving-window size is not an integer atom, or is a null one q refuses | every profile |
| <a id="qt018"></a>`QT018` | literal-statistical-length | Literal inputs to cor, cov, wavg or wsum have incompatible lengths | every profile |
| <a id="qt019"></a>`QT019` | literal-within-bounds | within bounds are not a two-item list | every profile |
| <a id="qt020"></a>`QT020` | table-column-length | Table literal columns of different lengths | every profile |
| <a id="qt021"></a>`QT021` | empty-search-pattern | ss or ssr with an empty pattern is a length error | every profile |
| <a id="qt022"></a>`QT022` | index-into-atom | A name bound to an atom is indexed; an atom has no items, and q raises 'type, or for an integer tries to write to it as a handle | every profile |
| <a id="qt023"></a>`QT023` | char-integer-arithmetic | Integer arithmetic on a char, which q 5 refuses with 'type | every profile |
| <a id="qt024"></a>`QT024` | attribute-literal-fail | An s#, u# or p# attribute applied to a literal it does not describe | every profile |
| <a id="qt025"></a>`QT025` | signal-non-string | A number or a char atom signalled, which q refuses with 'stype | every profile |
| <a id="qt026"></a>`QT026` | join-unkeyed-right | lj, ij or pj with a right table that has no key, which q refuses with 'type | every profile |
| <a id="qt027"></a>`QT027` | insert-value-count | insert or upsert given a different number of values than the table has columns | every profile |
| <a id="qt028"></a>`QT028` | where-assignment | An assignment of a non-boolean literal in a where phrase, where a comparison was meant; q raises 'type | every profile |
| <a id="qt029"></a>`QT029` | hopen-literal | hopen given a float, a negative number, or a symbol without its leading colon | every profile |
| <a id="qt030"></a>`QT030` | cast-unknown-type | A cast to a type character q does not have | every profile |
| <a id="qt031"></a>`QT031` | uppercase-cast-literal | An uppercase cast parses a string; given a number or a symbol it is 'type, and "C"$ refuses only a vector | every profile |
| <a id="qt032"></a>`QT032` | cast-by-name-refused-on-string | `symbol$ or `guid$ on a string, which q 5 refuses with 'type | every profile |
| <a id="qt033"></a>`QT033` | inferred-symbol-comparison | A local that is always a symbol compared with a number, boolean, temporal, char or string, or one that is never a symbol compared with a symbol: 'type | `style` and above |
| <a id="qt034"></a>`QT034` | inferred-mixed-join | Two lists of different types joined with `,`, one of them a typed local: the result is a general list, not a simple one | `style` and above |
| <a id="qt035"></a>`QT035` | inferred-symbol-arithmetic | Arithmetic on a local that is always a symbol: 'type | `style` and above |
| <a id="qt036"></a>`QT036` | null-getenv | null getenv tests each character of a string, giving a vector, which if and $[...] refuse with 'type | `style` and above |

## Correctness - q that runs and does the wrong thing

| code | name | summary | on in |
|---|---|---|---|
| <a id="qb001"></a>`QB001` | self-comparison | qSQL filter compares a name to itself | `style` and above |
| <a id="qb002"></a>`QB002` | interior-like-wildcard | More than one * in a like pattern, other than a leading and trailing pair: 'nyi in q 5 | every profile |
| <a id="qb003"></a>`QB003` | unparenthesised-sv | A string joined after sv string is split into characters before sv runs | `style` and above |
| <a id="qb004"></a>`QB004` | overlong-throw | Thrown message risks truncation | `style` and above |
| <a id="qb005"></a>`QB005` | match-in-where | Match in a qSQL filter compares whole vectors, not rows | `style` and above |
| <a id="qb006"></a>`QB006` | comparison-with-logic | Unparenthesised comparison mixed with and/or reads right-to-left | `style` and above |
| <a id="qb007"></a>`QB007` | like-symbol-pattern | like with a symbol pattern is a type error or, with a glob, a projection instead of a boolean | every profile |
| <a id="qb008"></a>`QB008` | vector-equality-filter | Column compared with a vector literal in a filter, row by row rather than for membership | `style` and above |
| <a id="qb010"></a>`QB010` | apply-not-subtract | An atom, a space and a negative literal applies the atom rather than subtracting, which q refuses | every profile |
| <a id="qb011"></a>`QB011` | control-as-value | if, while or do assigned as a value is always null | `style` and above |
| <a id="qb012"></a>`QB012` | trailing-semicolon-body | Lambda ends in ; so its last expression is discarded | `style` and above |
| <a id="qb013"></a>`QB013` | type-compared-to-symbol | type returns a short; comparing it to a symbol is a type error | every profile |
| <a id="qb014"></a>`QB014` | slash-division | / after a value is the over adverb, not division | `style` and above |
| <a id="qb015"></a>`QB015` | string-equality-filter | Equality against a string literal in a filter is 'length unless the table has as many rows as the string has characters, and 'type on a symbol or string column even then | every profile |
| <a id="qb016"></a>`QB016` | delete-columns-and-rows | delete cannot take both columns and a where phrase | every profile |
| <a id="qb017"></a>`QB017` | self-assignment | A name assigned to itself | `style` and above |
| <a id="qb018"></a>`QB018` | constant-comparison | Two literals compared, so the answer never varies | `style` and above |
| <a id="qb019"></a>`QB019` | duplicate-column | A table literal names a column twice; q renames the second, or keeps a key and a value column of one name, instead of refusing | `style` and above |
| <a id="qb020"></a>`QB020` | unreachable-statement | A statement after a top-level return or signal in a lambda never runs | `style` and above |
| <a id="qb021"></a>`QB021` | select-by-duplicate-name | A select or exec names a result column the same as a by group, which q refuses with 'dup names for cols/groups | every profile |
| <a id="qb022"></a>`QB022` | discarded-update | An update or delete on a table value whose result is discarded changes nothing | `style` and above |
| <a id="qb023"></a>`QB023` | empty-general-list-match | x~() is false for every typed empty list - 0#0, `symbol$() and "" - so it does not test emptiness | `style` and above |
| <a id="qb024"></a>`QB024` | peach-global-write | A lambda applied with peach writes a global, which q refuses with 'noupdate when it runs on secondary threads | `style` and above |
| <a id="qb025"></a>`QB025` | duplicate-conditional-test | A $[...] test written again later in the same conditional: when it holds the earlier branch runs, so the later one never does | `style` and above |
| <a id="qb026"></a>`QB026` | reversed-within-bounds | within given literal bounds high then low, so nothing is within them and it is always false | `style` and above |

## Domain - literal arguments outside what a builtin accepts

| code | name | summary | on in |
|---|---|---|---|
| <a id="qd001"></a>`QD001` | negative-til | til called with a negative, null or long-infinite literal count | every profile |
| <a id="qd002"></a>`QD002` | negative-where | where called with negative literal repetition counts | every profile |

## Security - q that lets its input decide what it runs, or carries secrets

| code | name | summary | on in |
|---|---|---|---|
| <a id="qx001"></a>`QX001` | query-injection | A qSQL query built by joining strings is run by value, so a spliced value can rewrite it | `style` and above |
| <a id="qx002"></a>`QX002` | credential-literal | A password, secret or token written into source as a string literal | `style` and above |

## Simplification - doing by hand what a q primitive already does

| code | name | summary | on in |
|---|---|---|---|
| <a id="qr001"></a>`QR001` | reverse-sort | reverse asc is desc, and reverse desc is asc | `style` and above |
| <a id="qr002"></a>`QR002` | identity-each | {x} each returns its argument unchanged | `style` and above |
| <a id="qr003"></a>`QR003` | distinct-sorted-distinct | distinct asc distinct x is asc distinct x | `style` and above |
| <a id="qr004"></a>`QR004` | atomic-each | each over one arithmetic operation, which is already atomic | `style` and above |

## Performance - q that gives the right answer slower than it has to

| code | name | summary | on in |
|---|---|---|---|
| <a id="qv001"></a>`QV001` | partition-filter-late | A where phrase constrains date, month, year or int after another column: on a partitioned table q reads every partition for the earlier constraint | `style` and above |
| <a id="qv002"></a>`QV002` | atomic-builtin-each | each over an atomic builtin - abs, neg, sqrt, exp, log, floor, ceiling, not, null, signum, reciprocal - which already applies to every item in one call | `style` and above |
| <a id="qv003"></a>`QV003` | append-in-loop | r:r,x or r:raze(r;x) in a do or while body copies r on every pass, so the loop is quadratic; r,:x appends in place | `style` and above |

## Compatibility - q that does not run on the q release a configuration targets

| code | name | summary | on in |
|---|---|---|---|
| <a id="qk001"></a>`QK001` | target-dictionary-literal | A dictionary literal, ([a:1;b:2]), which q reads from 4.1 on: reported only for an older target-version | every profile |
| <a id="qk002"></a>`QK002` | target-pattern-assignment | A pattern assignment, (a;b):x, which q runs from 4.1 on: reported only for an older target-version | every profile |
| <a id="qk003"></a>`QK003` | target-typed-parameter | A typed or filtered lambda parameter, {[x:`j] ...}, which q runs from 4.1 on: reported only for an older target-version | every profile |
| <a id="qk005"></a>`QK005` | target-removed-q-function | .Q.Xf or .Q.Cf, removed in q 4.1: reported only for a target-version of 4.1 or KDB-X | every profile |
| <a id="qk006"></a>`QK006` | target-kdbx-builtin | A builtin only KDB-X has, use`mymod, which an older q lacks: reported only for an older target-version | every profile |

## Leftovers - things left in q that were never meant to ship

| code | name | summary | on in |
|---|---|---|---|
| <a id="ql001"></a>`QL001` | unfinished-marker | TODO, FIXME, XXX or HACK in a comment | `styleq` and above |
| <a id="ql002"></a>`QL002` | commented-out-definition | A lambda definition kept as a comment rather than deleted | `styleq` and above |
| <a id="ql003"></a>`QL003` | unused-noqa | A noqa naming a code nothing on its line reports, so it suppresses nothing | `style` and above |

## Policy - one repository's conventions

| code | name | summary | on in |
|---|---|---|---|
| <a id="qp001"></a>`QP001` | bare-slash-block | Bare slash opens a block comment | `uqf` |
| <a id="qp002"></a>`QP002` | datetime-type | Legacy datetime precision | `uqf` |
| <a id="qp003"></a>`QP003` | wall-clock-temporal | Wall-clock timestamp where the convention is UTC | `uqf` |
| <a id="qp005"></a>`QP005` | mixed-infix-precedence | Unparenthesised * or % with + or - to its right: q performs the + or - first, where school precedence multiplies first | `uqf` |
| <a id="qp006"></a>`QP006` | juxtaposed-application | Function of two or more arguments defined in this file applied without brackets, which passes it one and returns a projection; the fix is left to a person after `from` | `uqf` |
| <a id="qp007"></a>`QP007` | mixed-infix-unparenthesised | Unparenthesised + or - with * or % to its right: q multiplies first and so does school precedence, so QP005 passes it | no profile |
| <a id="qp008"></a>`QP008` | restated-precedence-parentheses | Parentheses round the right operand of + - * % that only restate q's right-to-left order, exactly where QP005's and QP007's fix puts them: the opposite convention, selected only by its own code and refused beside either | no profile |

## Style guide - conventions from published q guidance

| code | name | summary | on in |
|---|---|---|---|
| <a id="qs001"></a>`QS001` | underscore-in-name | Name contains `_`, which is also the drop operator | `styleq` and above |
| <a id="qs002"></a>`QS002` | dot-in-name | Name has an interior dot but is not a namespace | `styleq` and above |
| <a id="qs003"></a>`QS003` | name-l | `l` as a name reads as `1` | `styleq` and above |
| <a id="qs004"></a>`QS004` | redundant-parentheses | A single token wrapped in parentheses | `styleq` and above |
| <a id="qs006"></a>`QS006` | lambda-length | Lambda longer than twenty five lines of code, not counting blank lines and comments | `styleq` and above |
| <a id="qs007"></a>`QS007` | documented-parameter-absent | `@param` names a parameter the lambda does not take | `styleq` and above |
| <a id="qs008"></a>`QS008` | implicit-name-out-of-position | `x`, `y` or `z` declared in a position q would not give it | `styleq` and above |
| <a id="qs009"></a>`QS009` | implicit-name-as-local | `y` or `z` assigned before it is read in a lambda without a parameter list, which makes it an argument the caller has to pass and the body throws away | `styleq` and above |
| <a id="qs010"></a>`QS010` | mixed-naming-convention | Names in one file mix naming conventions: camelCase, PascalCase, snake_case, Hungarian, kebab-case or a function in capitals | `styleq` and above |

## External - findings relayed from another tool

| code | name | summary | on in |
|---|---|---|---|
| <a id="qls001"></a>`QLS001` | qls/diagnostic | Diagnostic from the external qls server | the qls backend |

