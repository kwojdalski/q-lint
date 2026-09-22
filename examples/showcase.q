/ A smoke test for the q-lint VS Code extension. Every marked line below
/ carries the code it should raise: with the extension installed, each one
/ gets a squiggle in the editor and an entry in the Problems panel. The
/ terminal equivalent is `qlinter examples/showcase.q`.

/ Deliberately not loadable: some of these q itself refuses. That is the
/ point of a linter that never runs what it reads.

/ The invalid string escape is the last marked line, since it coexists
/ with the other findings. The unclosed delimiter lives in syntax-error.q
/ instead: it stops the file being analysed at all and would hide the rest.

/ Coverage: of the 88 rules in the taxonomy, 86 can fire on q source and
/ every one is marked below or in syntax-error.q. The two that cannot are
/ QF006 (python-hook, no raiser in this build) and QLS001 (external qls
/ server, demonstrated in its own section near the end).
/ Comment spacers here are slash-plus-text on purpose: a line that is only
/ a slash opens a q block comment and would swallow the rest of the file,
/ which is exactly what QP001 (uqf profile) is about.

/ QF012: a root-level assignment to a reserved name. q refuses some of
/ these ('assign for `count`, a parse error for `select`) and silently
/ accepts others (`from`, `by`) - the linter treats them alike. This line
/ sits above the \d because inside a namespace the same text is QF004.
/ expect-next: QF012
from:1

/ Everything from here is inside .demo, which is what makes the QF004
/ case below a namespace-level shadow rather than a root-level one. A file
/ may end inside a namespace: q restores the caller's context when the
/ load finishes, which is why KX's own u.q opens `\d .u` and never closes it.
\d .demo

/ ------------------------------------------------------------------- names

/ QF001: `count` is a q builtin, and a parameter of that name shadows it.
/ expect-next: QF001
rows:{[count] count+1}

/ QF001: so is `sin` - the reserved list is q's own (.Q.res plus the .q
/ namespace), not a shortlist of the common ones.
/ expect-next: QF001
wave:{[sin] sin*2}

/ QF002: `_` is the drop operator; q will not take it as a parameter name.
/ expect-next: QF002
drop:{[_] x+1}

/ QF003: assignment to `count` inside the lambda shadows the builtin there.
/ expect-next: QF003
tally:{[x] count:x+1; count}

/ QF004: inside \d .demo this defines .demo.count, shadowing the builtin
/ for everything that follows in the namespace.
/ expect-next: QF004
count:{[t] 42}

/ QF005: a nested lambda cannot see `scale`. q lambdas do not close over
/ enclosing locals, so this throws at runtime, not here.
/ expect-next: QF005
apply:{[scale] f:{[v] v*scale}; f each 1 2 3}

/ QF007: not a parameter list. `tables[]` is a call, so q reads the
/ brackets as the start of the body - and refuses this one outright.
/ expect-next: QF007
broken:{[tables[]] x+1}

/ QF007: accepted by q, and worse for it: the brackets are body text, so
/ this takes the implicit x rather than the `n` it appears to declare.
/ expect-next: QF007
scaled:{[n:1] n*2}

/ QF007: two names without a separator is one bracket expression, not two
/ parameters. The lambda is rank 1, taking x.
/ expect-next: QF007
pair:{[a b] a+b}

/ QF008: q gives this rank 2 and then binds neither; applying it projects.
/ expect-next: QF008
twice:{[a;a] a}

/ QF009: the trailing separator is a third parameter, which q names `2`.
/ The lambda is rank 3, from source that reads as rank 2.
/ expect-next: QF009
three:{[a;b;] a+b}

/ QF013: a table literal whose column is a builtin name. It parses, but in
/ a where phrase q resolves the bare `first` as the function, so the
/ column can be defined and never filtered on.
/ expect-next: QF013
ledger:([] first:1 2 3; qty:4 5 6)

/ QF014: an assignment anywhere in a body makes the name local throughout,
/ so the read of `cfg` on the left finds an unset local, not the global,
/ and throws 'cfg. Within one statement q runs right to left and this does
/ not apply; across statements it does.
/ expect-next: QF014
early:{[x] r:cfg; cfg:1; r}

/ QF014: the slots of `if` run left to right, so the test reads `seen`
/ before the branch assigns it - unlike a call's arguments, which run
/ right to left and would have assigned first.
/ expect-next: QF014
guard:{[x] if[seen; seen:1b]; x}

/ QF015: `return` is not a q keyword. It is an ordinary name, undefined,
/ and applying it throws 'return. `:x` is how a lambda returns early.
/ expect-next: QF015
back:{[x] return x}

/ QF015: `true` and `false` are not q either; booleans are `1b` and `0b`.
/ expect-next: QF015
flag2:{[x] $[x;true;false]}

/ QF010: `x` is not an argument here. Declaring parameters takes the
/ implicit ones out of scope, so q resolves x as a global and throws 'x.
/ expect-next: QF010
offset:{[base] x+base}

/ QF018: assigning a name reads its value; the source still needs a definition.
/ A different file could supply it, so this is a possible undefined-name warning.
/ expect-next: QF018
unresolved:{[] aa:bb; aa}

/ -------------------------------------------------------------- application

/ QA001: q allows eight parameters; this declares nine.
/ expect-next: QA001 QF016
wide:{[a;b;c;d;e;f;g;h;i] a}

/ QF016: a parameter the body never reads. The caller still has to pass
/ it, so this is usually a call site that changed and a signature that did
/ not. A lambda that reads none of its parameters is left alone - that is a
/ callback conforming to a shape someone else chose, not drift.
/ expect-next: QF016
spare:{[used;stale] used+1}

/ QF017: a local assigned and never read. The two views this needs are worth
/ knowing about: assignments are looked for with brackets and qSQL phrases
/ blanked, because `update mid:...` and `([sym:`symbol$()] ...)` name columns
/ with the syntax an assignment uses; reads are looked for in the whole body,
/ because a local is very often read inside a bracket.
/ expect-next: QF017
stale:{[a] tmp:1; a}

/ QB017: a name assigned to itself. There is no q in which that is the
/ intention, and the reader cannot tell which name was meant. Only at bracket
/ depth zero - inside `([]time:time;...)` the same text names a table column
/ after the variable filling it, which is ordinary.
/ expect-next: QB017
echoed:{[a] b:1; b:b; b}

/ QB018: two literals compared. The answer is settled before the program runs,
/ so either the comparison is dead or one side was meant to be a name. The
/ right operand has to be the whole of one: `0<0^x` fills before comparing and
/ `0<1_x` drops before it, and neither is this.
/ expect-next: QB018
fixed:1=2

/ ------------------------------------------------------- styleq profile only
/ .
/ QS001, QS002 and QS003 fire only with q-lint.profile set to styleq. They
/ come from the FINOS q coding guidelines rather than from q's behaviour: all
/ three names below are perfectly good q, and the guidance is about how they
/ read. The underscore one is widely ignored in practice, which is the reason
/ the profile is opt-in.
/ expect-next: QS001
some_name:1

/ QS002 is demonstrated at the foot of this file: it fires only at root, and
/ everything here is inside the namespace opened above.

/ QS003: "never use letter l, looks like number 1 in some fonts." It does.
/ expect-next: QS003
l:3

/ QS004: a single token wrapped in parentheses. "Do not use unnecessary
/ parentheses - the compiler doesn't need them, they confuse experienced q
/ coders." Only a lone token, because deciding "unnecessary" in general needs
/ q's precedence, and q applies one rule to everything.
/ expect-next: QS004
wrapped:(1)+2

/ QS008: "Be consistent in your use of `x`, `y` and `z` to mean the first,
/ second and third arguments." Naming a parameter `x` in any other position
/ means every reader arrives expecting the first argument and finds something
/ else.
/ expect-next: QS008
misplaced:{[t;x] t+x}

/ QS009: the other half of the same guidance - "avoid using these letters as
/ local variables" when the parameters are named. This works; it just reads as
/ an implicit argument to anyone who has not looked at the signature yet.
/ expect-next: QS009
shadowed:{[p;q] x:p+q; x}

/ QS007: documentation naming a parameter the lambda does not take. The
/ signature changed and the comment did not, or the name is a typo. Only names
/ that are documented and absent: a parameter with no `@param` is not
/ reported, since plenty of q is documented in prose and demanding a tag for
/ each parameter is a much larger opinion than this one.
/// Reads a folder. The finding lands on the `@param` line, which is where
/ the name that does not exist is written.
/ expect-next: QS007
//@param folderRoot The root.
readFolder:{[folderRoots] folderRoots}

/ QS006: "A function over ten lines is suspect. A function over twenty five
/ lines is certifiable." The second threshold, not the first: over ten is a
/ tenth of the lambdas in real q, and a rule that fires that often is one
/ nobody leaves on.
/ expect-next: QS006
sprawling:{[a]
  b1:a+1;
  b2:a+2;
  b3:a+3;
  b4:a+4;
  b5:a+5;
  b6:a+6;
  b7:a+7;
  b8:a+8;
  b9:a+9;
  b10:a+10;
  b11:a+11;
  b12:a+12;
  b13:a+13;
  b14:a+14;
  b15:a+15;
  b16:a+16;
  b17:a+17;
  b18:a+18;
  b19:a+19;
  b20:a+20;
  b21:a+21;
  b22:a+22;
  b23:a+23;
  b24:a+24;
  b25:a+25;
  b26:a+26;
  b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8 + b9 + b10 + b11 + b12 + b13 + b14 + b15 + b16 + b17 + b18 + b19 + b20 + b21 + b22 + b23 + b24 + b25 + b26}

/ QA002: three arguments to a lambda that takes two.
/ expect-next: QA002
sum2:{[a;b]a+b}[1;2;3]

/ QA003: protected apply @ is unary; the rank-2 lambda leaves a parameter
/ unbound and the whole expression does nothing useful.
/ expect-next: QA003
guarded: @[{[a;b] a+b};1;2]

/ QA004: applying a niladic function to the empty list.
/ expect-next: QA004
now:{[] .z.p};stamp:now . ()

/ QA005: `each` supplies one argument, so this rank-2 lambda does not run -
/ it returns three projections, which is wrong data, not an error.
/ expect-next: QA005
pairsum:{[a;b]a+b} each 1 2 3

/ QA005: the same trap through a binary builtin rather than a lambda.
/ expect-next: QA005
corrs: cor each 1 2 3

/ QA006: one slot projects, three or more are conditionals - exactly two is
/ the arity $ has no meaning for, and q says 'type only at runtime.
/ expect-next: QA006
halfcond: $[1b;2]

/ QA007: four slots pair off as test-and-result with nothing left for an
/ else. When neither test holds this is `::`, silently. Five slots have an
/ else.
/ expect-next: QA007
pick: $[0b;1;0b;2]

/ QA007: six slots, same shape - three tests, three results, no else.
/ expect-next: QA007
pick2: $[a;1;b;2;c;3]

/ QA008: parentheses do not separate arguments; `addp(1;2)` hands `addp` the
/ single argument `1 2`, and a rank-2 lambda given one argument is a
/ projection, not a result.
/ expect-next: QA008
addp:{[a;b] a+b};both2:addp(1;2)

/ QA008: an implicit signature's rank is read from its body; `y` makes
/ this rank 2, and the parentheses are the same mistake.
/ expect-next: QA008
addi:{x+y};both3:addi(1;2)

/ QA009: dot apply wants a list of arguments, and a scalar is a 'type error.
/ expect-next: QA009
dot: .[{x+y};1]

/ QA009: the trap form `.[f;args;handler]` has the same requirement of
/ its second slot, and a symbol atom fails it too.
/ expect-next: QA009
dot2: .[{x+y};`a;{x}]

/ ---------------------------------------------------------- types and shapes

/ QT001: two keys, three values. The value scan stops at the end of the
/ line, as q reads it, so no trailing semicolon is needed.
/ expect-next: QT001
config:`host`port!8080 443 8081

/ QT002: `add` is visibly numeric, and this hands it a symbol.
/ expect-next: QT002
add:{[r] r+1};total:add[`bad]

/ QT003: symbols take no arithmetic; this is a 'type error at runtime.
/ Chars are different - "a"*3 is 291 - which is why the rule is about
/ symbols and nothing else.
/ expect-next: QT003
badsum: 2+`a

/ QT003: the symbol can be on either side, and vectors are no better.
/ expect-next: QT003
worse: `a*2

/ QT004: a cast named by symbol converts a string char by char - this is
/ `49 50 51`, and nothing says so. `"J"$"123"` parses the text.
/ expect-next: QT004
num: `long$"123"

/ QT004: the date cast on a string is ten dates, one per character, none
/ of them 2024.01.01. `"D"$` parses the text.
/ expect-next: QT004
day: `date$"2024.01.01"

/ QT005: a table literal in which every column is a scalar is a 'rank
/ error; a one-row table needs `enlist`. One vector column would do.
/ expect-next: QT005
one: ([] a:1; b:2)

/ QT020: vector columns of different lengths. `([]a:1 2;b:3 4 5)` is 'length,
/ and so is `([]a:enlist 1;b:2 3)` - `enlist` makes a one-item vector, not an
/ atom that would extend. An atom beside a vector is fine: `([]a:1;b:2 3)`.
/ expect-next: QT020
ragged:([]a:1 2;b:3 4 5)

/ QT021: `ss` or `ssr` with an empty pattern. Both are 'length, checked. The
/ pattern is a string and so is blank in the linter's view; the empty pair of
/ quotes is read from the source.
/ expect-next: QT021
nothing:ss["abc";""]
/ QT005: keyed is no different.
/ expect-next: QT005
one2: ([k:1] v:2)

/ QT006: two literal vectors under an infix must agree in length.
/ expect-next: QT006
bad3: 1 2 3+4 5

/ QT006: symbol vectors under `=` likewise - two against three.
/ expect-next: QT006
bad4: `a`b=`a`b`c

/ QT007: `ssr` is a string function and a symbol is a 'type error. `trim`
/ and `lower` accept symbols, and stay quiet.
/ expect-next: QT007
sub: ssr[`abc;"a";"b"]

/ QT007: infix `ss` with a symbol on the left.
/ expect-next: QT007
sub2: `abc ss "a"

/ --------------------------------------------------------------- correctness

/ QB010: `n -1` is `n` applied to `-1`, not `n` minus one: with a space
/ before the minus and none after, it belongs to the literal. Verified:
/ with n:3 this tries to write to file handle 3.
/ expect-next: QB010
off: n -1

/ QB010: the same inside a condition - `n -1` is `n[-1]` wherever it is.
/ expect-next: QB010
if[n -1; 1]

/ QB011: `if` is a statement that returns `::`, so `flag` is null however
/ the condition goes. `$[...]` is the conditional with a value.
/ expect-next: QB011
flag: if[1b;1]

/ QB011: `while` and `do` are statements too.
/ expect-next: QB011
flag3: while[0b;1]

/ QB012: the trailing semicolon makes this lambda return null; `r` is
/ computed and thrown away. A side-effecting last statement stays quiet.
/ expect-next: QB012
tail2:{[x] r:x+1; r;}

/ QB012: an infix expression at the end is thrown away just the same.
/ expect-next: QB012
tail3:{[x] x+1;}

/ QB013: `type` returns a short, so this comparison is a 'type error, not
/ false. `7h` is what a long reports.
/ expect-next: QB013
islong: type[1]=`long

/ QB013: the symbol on the left is the same comparison.
/ expect-next: QB013
islong2: `long=type 1

/ QB014: `/` after a value is the over adverb, not division, and this is a
/ '/ parse error. Division is `%`.
/ expect-next: QB014
half: 10/2

/ QB014: after a parenthesised value too - `(a+b)/` is over applied to
/ nothing yet, and then to 2.
/ expect-next: QB014
half2: (a+b)/2

/ QB015: equality against a string in a filter: 'type on a symbol column,
/ 'length on a string column, and row-wise garbage if the lengths agree.
/ expect-next: QB015
eur:select from trades where sym="EUR"

/ QB015: the empty string is a zero-length list, and compares no better.
/ expect-next: QB015
blank:select from trades where sym=""

/ QB016: `delete` takes columns or a where phrase, never both: 'nyi.
/ expect-next: QB016
pruned:delete size from trades where size>1


/ QB001: a filter comparing a column to itself keeps every row.
/ expect-next: QB001
stale:select from trades where sym=sym

/ QB005: `~` matches whole operands, so this filter asks one question about
/ the entire table instead of one per row. Here that is no error at all:
/ the column is never identical to one symbol, so the result is an empty
/ table, silently. `~/:` is the row-wise form and stays quiet.
/ expect-next: QB005
matchw:select from trades where sym~`EUR

/ QB006: every infix has the same precedence, so `a=1 and b=0` reads as
/ `a=(1 and b=0)` - the comparison consumes the logic and the rows that
/ come back are quietly the wrong ones. `(a=1) and b=0` stays quiet.
/ expect-next: QB006
both:select from trades where size=1 and side=0

/ QB007: like takes a string pattern; a symbol literal is a 'type error
/ the moment the query runs.
/ expect-next: QB007
glob:select from trades where sym like `EUR*

/ QB008: a column equals one value. Against a vector literal the comparison
/ is positional: with a three-row table this is 'length, and with a two-row
/ one it silently keeps the rows whose position happens to match - `EUR`USD
/ finds both rows and `USD`EUR finds none. `in` is the operator for
/ membership.
/ expect-next: QB008
pair2:select from trades where sym=`EUR`USD

/ QB009: nothing aggregates `price`, so under `by` it takes the last row
/ of each group - not the first, and nothing in the query says which.
/ `select last price by sym` says it out loud and stays quiet.
/ expect-next: QB009
lastpx:select price by sym from trades

/ QB002: q's like does not support an interior wildcard.
/ expect-next: QB002
hits:select from trades where sym like "a*b"

/ QB003: `,` binds tighter, so sv receives one joined string.
/ expect-next: QB003
path:"/" sv string dir,name

/ QB004: a thrown message over 200 literal chars risks truncation.
/ expect-next: QB004
overlong:'"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

/ ------------------------------------------------ literal builtin contracts

/ QA010: q reports rank for this literal call.
/ expect-next: QA010
sum[1;2]

/ QT008: q reports type for this literal call.
/ expect-next: QT008
til[1.5]

/ QT009: q reports type for this literal call.
/ expect-next: QT009
where[1.5 2.5]

/ QT010: q reports type for this literal call.
/ expect-next: QT010
sum[`a`b]

/ QT011: q reports rank for this literal call.
/ expect-next: QT011
asc[1]

/ QT012: q reports type for this literal call.
/ expect-next: QT012
distinct[1]

/ QT013: q reports rank for this literal call.
/ expect-next: QT013
flip[1 2]

/ QT014: q reports type for this literal call.
/ expect-next: QT014
rotate[1.5;1 2]

/ QD001: q reports domain for this literal call.
/ expect-next: QD001
til[-1]

/ QD002: q reports limit for this literal call.
/ expect-next: QD002
where[-1 2]

/ QA011: `$` takes an atom. A vector condition is 'type every time, and the
/ shape is reached for by people expecting it to vectorise - `?[...]` is the
/ conditional that does. A symbol condition is 'type for the same reason.
/ expect-next: QA011
pick:$[101b;`y;`n]

/ QT015: a symbol compares with a symbol. Against a number or a string it is
/ 'type. `1="a"` is not this - a char compares by its code - and `~` never
/ raises, so neither is reported.
/ expect-next: QT015 QB018
same:1=`a

/ QA012: the same arity error as QA002, reached by name. `takesOne` takes one
/ argument and is given two, which is 'rank at runtime. An elided slot still
/ counts - `takesOne[1;]` supplies two and is 'rank as well - while `f[]`
/ supplies none and is a projection at any rank.
takesOne:{[a] a+1}
/ expect-next: QA012
tooMany:takesOne[1;2]

/ ------------------------------------------------ multiline continuations

/ QT005: line breaks do not make scalar columns into lists.
multitable:{[]
 / expect-next: QT005
 (
  [
  ]
  a:1;
  b:2)
 }

/ QA002: the continued argument list still supplies three arguments.
multicall:{[]
 {[a;b] a+b}
 / expect-next: QA002
 [1;
  2;
  3]
 }

/ QT001: the indented values belong to the preceding dictionary expression.
multidict:{[]
 / expect-next: QT001
 `a`b!
  1 2 3
 }

/ QB011: assigning a statement still yields null across a line break.
multinull:{[]
 / expect-next: QB011
 r:
  if[1b;1];
 r
 }

/ ----------------------------------------------------- uqf profile only

/ QP001 and QP002 fire only with q-lint.profile set to uqf. With the
/ default general profile the two marked lines below stay quiet.

/ QP002: the datetime literal is q legacy 15h precision.
/ expect-next: QP002
stamp2: 2024.01.01T09:30:00.000

/ QP003: the wall-clock pair of the UTC temporals the convention wants.
/ expect-next: QP003
wall: .z.P

/ QP005: q evaluates right-to-left, so this is 2*(3+4); parentheses say
/ which order was meant, and their absence is the finding.
/ expect-next: QP005
mixed: 2*3+4

/ QP001: the bare slash on the next line opens a block comment that runs
/ to the bare backslash - legal q, and a hazard the uqf profile calls out.
/ expect-next: QP001
/
anything in here is a comment
\

/ QF001 again: proves the block above closed, and this line still lints.
/ expect-next: QF001
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
/ expect-next: QE004
if[a==1;2]

/ QE004: `!=` is `<>` in q, and `||` is `or`.
/ expect-next: QE004
if[a!=1;2]

/ QE002: backslash-q is not a valid q string escape.
/ expect-next: QE002
bad:"\q"

/ ------------------------------------------------ additional literal contracts

/ QT016: a symbol is not an input to numeric math.
/ expect-next: QT016
sqrt[`a]

/ QT017: moving-window sizes must be integer atoms.
/ expect-next: QT017
mavg[1.5;1 2 3]

/ QT018: both statistical inputs need compatible lengths.
/ expect-next: QT018
cor[1 2;3 4 5]

/ QT019: within takes exactly two bounds.
/ expect-next: QT019
within[1;1 2 3]

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

/ One near-miss per rule, roughly: the shape the rule reports, with the one
/ thing that makes it fine. Each was checked to be silent before it went in.
eightParams:{[a;b;c;d;e;f;g;h] a+b+c+d+e+f+g+h}
unaryUnderAt:@[{[a] a+1};1;{`err}]
eachOverUnary:{x+1} each 1 2 3
threeSlots:$[1b;2;3]
oddSlots:$[0b;1;0b;2;3]
namedCall:takesOne[1]
namedProjection:takesOne[]
symbolLike:select from trades where sym like "EUR*"
rowwiseMatch:select from trades where sym~\:`EUR
membership:select from trades where sym in `EUR`USD
scalarEq:select from trades where size=1
aggregated:select first size by sym from trades
castNotMath:`long$x-`long$y
symList:`abs`cor`like`mins
subtract:n - 1
condValue:r:$[1b;1;2]
typeShort:type[1]=-7h
division:10 % 2
rowBool:([]a:10b;b:1)
rowByte:([]a:0x0102;b:1)
atomBeside:([]a:1;b:2 3)
ssPattern:ss["abc";"a"]
fillContinues:0<0^x
dropContinues:0<1_deltas x
paramUsed:{[used;alsoUsed] used+alsoUsed}
localRead:{[a] tmp:1; a+tmp}
groupedParens:(a+b)*c
unaryCallParens:takesOne(1)
docMatches:{[folderRoots] folderRoots}
xFirst:{[x;y] x+y}
namedLocal:{[p;q] r:p+q; r}

/ QF018 near-misses: a bare read is only suspicious when nothing supplies
/ the name. Each of the four below is supplied - by a global this file
/ defines in the same namespace, by one defined further down (q resolves
/ globals when the function runs, not when it is parsed), by a builtin,
/ and by a local assigned earlier in the same body.
suppliedGlobal:1
readsGlobal:{[] v:suppliedGlobal; v}
readsGlobalDefinedBelow:{[] v:definedBelow; v}
definedBelow:2
readsBuiltin:{[] v:sum; v}
readsLocal:{[] w:1; v:w; v}

/ QS002: a dot that is not a namespace. It fires only at root, so the file
/ returns there first - inside the `\d .demo` above, the same text names a
/ sub-namespace, which q creates properly.
\d .
/ expect-next: QS002
myspace.myvar:2

/ QE003: the bare slash below opens a block comment that nothing closes,
/ so it swallows the rest of the file - the last line is the only place it
/ can live. Under the uqf profile the same line is QP001 as well.
/ expect-next: QE003 QP001
/
