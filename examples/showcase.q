/ A smoke test for the q-lint VS Code extension. Every marked line below
/ carries the code it should raise: with the extension installed, each one
/ gets a squiggle in the editor and an entry in the Problems panel. The
/ terminal equivalent is `qlinter examples/showcase.q`.

/ Deliberately not loadable: some of these q itself refuses. That is the
/ point of a linter that never runs what it reads.

/ The invalid string escape is the last marked line, since it coexists
/ with the other findings. The unclosed delimiter lives in syntax-error.q
/ instead: it stops the file being analysed at all and would hide the rest.

/ Coverage: of the 57 rules in the taxonomy, 55 can fire on q source and
/ every one is marked below, in syntax-error.q or in dynamic-eval.q. The
/ two that cannot are QF006 (python-hook, no raiser in this build) and
/ QLS001 (external qls server, demonstrated in its own section near the
/ end). QP004 has its own file because it discloses that this file's
/ name-scope checks were skipped - here they demonstrably were not.
/ Comment spacers here are slash-plus-text on purpose: a line that is only
/ a slash opens a q block comment and would swallow the rest of the file,
/ which is exactly what QP001 (uqf profile) is about.

/ QF012: a root-level assignment to a reserved name. q refuses some of
/ these ('assign for `count`, a parse error for `select`) and silently
/ accepts others (`from`, `by`) - the linter treats them alike. This line
/ sits above the \d because inside a namespace the same text is QF004.
from:1

\d .demo

/ QF011: there is no closing \d . at the end of this file, so it ends
/ inside .demo - the finding sits on the directive still in force at EOF.

/ ------------------------------------------------------------------- names

/ QF001: `count` is a q builtin, and a parameter of that name shadows it.
rows:{[count] count+1}

/ QF001: so is `sin` - the reserved list is q's own (.Q.res plus the .q
/ namespace), not a shortlist of the common ones.
wave:{[sin] sin*2}

/ QF002: `_` is the drop operator; q will not take it as a parameter name.
drop:{[_] x+1}

/ QF003: assignment to `count` inside the lambda shadows the builtin there.
tally:{[x] count:x+1; count}

/ QF004: inside \d .demo this defines .demo.count, shadowing the builtin
/ for everything that follows in the namespace.
count:{[t] 42}

/ QF005: a nested lambda cannot see `scale`. q lambdas do not close over
/ enclosing locals, so this throws at runtime, not here.
apply:{[scale] f:{[v] v*scale}; f each 1 2 3}

/ QF007: not a parameter list. `tables[]` is a call, so q reads the
/ brackets as the start of the body - and refuses this one outright.
broken:{[tables[]] x+1}

/ QF007: accepted by q, and worse for it: the brackets are body text, so
/ this takes the implicit x rather than the `n` it appears to declare.
scaled:{[n:1] n*2}

/ QF007: two names without a separator is one bracket expression, not two
/ parameters. The lambda is rank 1, taking x.
pair:{[a b] a+b}

/ QF008: q gives this rank 2 and then binds neither; applying it projects.
twice:{[a;a] a}

/ QF009: the trailing separator is a third parameter, which q names `2`.
/ The lambda is rank 3, from source that reads as rank 2.
three:{[a;b;] a+b}

/ QF013: a table literal whose column is a builtin name. It parses, but in
/ a where phrase q resolves the bare `first` as the function, so the
/ column can be defined and never filtered on.
ledger:([] first:1 2 3; qty:4 5 6)

/ QF014: an assignment anywhere in a body makes the name local throughout,
/ so the read of `cfg` on the left finds an unset local, not the global,
/ and throws 'cfg. Within one statement q runs right to left and this does
/ not apply; across statements it does.
early:{[x] r:cfg; cfg:1; r}

/ QF015: `return` is not a q keyword. It is an ordinary name, undefined,
/ and applying it throws 'return. `:x` is how a lambda returns early.
back:{[x] return x}

/ QF010: `x` is not an argument here. Declaring parameters takes the
/ implicit ones out of scope, so q resolves x as a global and throws 'x.
offset:{[base] x+base}

/ -------------------------------------------------------------- application

/ QA001: q allows eight parameters; this declares nine.
wide:{[a;b;c;d;e;f;g;h;i] a}

/ QA002: three arguments to a lambda that takes two.
sum2:{[a;b]a+b}[1;2;3]

/ QA003: protected apply @ is unary; the rank-2 lambda leaves a parameter
/ unbound and the whole expression does nothing useful.
guarded: @[{[a;b] a+b};1;2]

/ QA004: applying a niladic function to the empty list.
now:{[] .z.p};stamp:now . ()

/ QA005: `each` supplies one argument, so this rank-2 lambda does not run -
/ it returns three projections, which is wrong data, not an error.
pairsum:{[a;b]a+b} each 1 2 3

/ QA005: the same trap through a binary builtin rather than a lambda.
corrs: cor each 1 2 3

/ QA006: one slot projects, three or more are conditionals - exactly two is
/ the arity $ has no meaning for, and q says 'nyi only at runtime.
halfcond: $[1b;2]

/ QA007: four slots pair off as test-and-result with nothing left for an
/ else. When neither test holds this is `::`, silently. Five slots have an
/ else.
pick: $[0b;1;0b;2]

/ QA008: parentheses do not separate arguments; `addp(1;2)` hands `addp` the
/ single argument `1 2`, and a rank-2 lambda given one argument is a
/ projection, not a result.
addp:{[a;b] a+b};both2:addp(1;2)

/ QA009: dot apply wants a list of arguments, and a scalar is a 'type error.
dot: .[{x+y};1]

/ ---------------------------------------------------------- types and shapes

/ QT001: two keys, three values. The value scan stops at the end of the
/ line, as q reads it, so no trailing semicolon is needed.
config:`host`port!8080 443 8081

/ QT002: `add` is visibly numeric, and this hands it a symbol.
add:{[r] r+1};total:add[`bad]

/ QT003: symbols take no arithmetic; this is a 'type error at runtime.
/ Chars are different - "a"*3 is 291 - which is why the rule is about
/ symbols and nothing else.
badsum: 2+`a

/ QT003: the symbol can be on either side, and vectors are no better.
worse: `a*2

/ QT004: a cast named by symbol converts a string char by char - this is
/ `49 50 51`, and nothing says so. `"J"$"123"` parses the text.
num: `long$"123"

/ QT005: a table literal in which every column is a scalar is a 'rank
/ error; a one-row table needs `enlist`. One vector column would do.
one: ([] a:1; b:2)

/ QT006: two literal vectors under an infix must agree in length.
bad3: 1 2 3+4 5

/ QT007: `ssr` is a string function and a symbol is a 'type error. `trim`
/ and `lower` accept symbols, and stay quiet.
sub: ssr[`abc;"a";"b"]

/ --------------------------------------------------------------- correctness

/ QB010: `n -1` is `n` applied to `-1`, not `n` minus one: with a space
/ before the minus and none after, it belongs to the literal. Verified:
/ with n:3 this tries to write to file handle 3.
off: n -1

/ QB011: `if` is a statement that returns `::`, so `flag` is null however
/ the condition goes. `$[...]` is the conditional with a value.
flag: if[1b;1]

/ QB012: the trailing semicolon makes this lambda return null; `r` is
/ computed and thrown away. A side-effecting last statement stays quiet.
tail2:{[x] r:x+1; r;}

/ QB013: `type` returns a short, so this comparison is a 'type error, not
/ false. `7h` is what a long reports.
islong: type[1]=`long

/ QB014: `/` after a value is the over adverb, not division, and this is a
/ '/ parse error. Division is `%`.
half: 10/2

/ QB015: equality against a string in a filter: 'type on a symbol column,
/ 'length on a string column, and row-wise garbage if the lengths agree.
eur:select from trades where sym="EUR"

/ QB016: `delete` takes columns or a where phrase, never both: 'nyi.
pruned:delete size from trades where size>1


/ QB001: a filter comparing a column to itself keeps every row.
stale:select from trades where sym=sym

/ QB005: `~` matches whole operands, so this filter asks one question about
/ the entire table instead of one per row - a 'type error here, or a
/ single-row result against a scalar, which is worse. `~/:` is the row-wise
/ form and stays quiet.
matchw:select from trades where sym~`EUR

/ QB006: every infix has the same precedence, so `a=1 and b=0` reads as
/ `a=(1 and b=0)` - the comparison consumes the logic and the rows that
/ come back are quietly the wrong ones. `(a=1) and b=0` stays quiet.
both:select from trades where size=1 and side=0

/ QB007: like takes a string pattern; a symbol literal is a 'type error
/ the moment the query runs.
glob:select from trades where sym like `EUR*

/ QB008: a column equals one value. Against a vector literal the filter is
/ a 'length error at runtime; `in` is the operator for membership.
pair2:select from trades where sym=`EUR`USD

/ QB009: nothing aggregates `price`, so under `by` it takes the last row
/ of each group - not the first, and nothing in the query says which.
/ `select last price by sym` says it out loud and stays quiet.
lastpx:select price by sym from trades

/ QB002: q's like does not support an interior wildcard.
hits:select from trades where sym like "a*b"

/ QB003: `,` binds tighter, so sv receives one joined string.
path:"/" sv string dir,name

/ QB004: a thrown message over 200 literal chars risks truncation.
overlong:'"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

/ ----------------------------------------------------- uqf profile only

/ QP001 and QP002 fire only with q-lint.profile set to uqf. With the
/ default general profile the two marked lines below stay quiet.

/ QP002: the datetime literal is q legacy 15h precision.
stamp2: 2024.01.01T09:30:00.000

/ QP003: the wall-clock pair of the UTC temporals the convention wants.
wall: .z.P

/ QP005: q evaluates right-to-left, so this is 2*(3+4); parentheses say
/ which order was meant, and their absence is the finding.
mixed: 2*3+4

/ QP001: the bare slash on the next line opens a block comment that runs
/ to the bare backslash - legal q, and a hazard the uqf profile calls out.
/
anything in here is a comment
\

/ QF001 again: proves the block above closed, and this line still lints.
rows2:{[last] last}

/ ------------------------------------------------------ qls backend only

/ QLS001 is the external qls server's own diagnostic, merged in when the
/ CLI runs with `--backend all` (or `--backend qls`). The extension uses
/ the builtin backend, so nothing here shows in the editor. qls layers
/ its own unused-argument warnings on many of the marked lines above, and
/ this section shows a builtin-clean line that draws one.

/ QLS001: qls flags `a` as defined but never used (unused args must end
/ in underscore to be allowed).
unused:{[a] 1}

/ ------------------------------------------------------------------ syntax

/ QE004: q has no `==`; equality is `=`, and this line does not parse.
if[a==1;2]

/ QE002: backslash-q is not a valid q string escape.
bad:"\q"

/ -------------------------------------------------------------------- clean

/ Nothing in this section should be reported. These are the shapes the
/ rules above are bounded against - if a squiggle appears here, that is a
/ bug.

total2:{[rows] rows+1}
find:{[find] find}
median:{[median] median}
lookup:{[d] d[`key]}
inner:{[a] g:{[a;b] a+b}; g[a;1]}
dotted:{[.q.z] 1}
implicit:{x+y}
declared:{[x] x+1}
none:{[] 42}
joined:"/" sv (string dir),string name
paired:`host`port!(`localhost;5000)
literal:{[a;b]a+b}[1;2]
elided:{[a;b]a+b}[1;]
column:{[t] select x from t}
tail:select from trades where sym like "ab*"

/ QE003: the bare slash below opens a block comment that nothing closes,
/ so it swallows the rest of the file - the last line is the only place it
/ can live. Under the uqf profile the same line is QP001 as well.
/
