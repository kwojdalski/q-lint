# Regression corpus

Idiomatic q that must stay quiet, and a snapshot of exactly what the linter
says about it. `tests/corpus.rs` fails when a change moves any finding here.

The fixtures in `tests/cases/` say what a rule *should* report. They cannot
say what it should stay silent on, because a rule's author writes both and
only thinks of the shapes already in mind. A false positive is almost always
found in somebody else's q, not in a fixture.

So the files here are not chosen to exercise rules. Each is built around a
shape that is easy to report wrongly, because it reads like a mistake and is
not:

| shape | why a rule reaches for it |
|---|---|
| a file ending inside `\d .u` | it looks like a namespace left open, but q restores the caller's context when the load finishes |
| `sel:{$[`~y;x;select from x where sym in y]}` | a `~` on a line that also contains a `select`, but in a conditional rather than the filter |
| `select by sym from t` | an empty select phrase, which is the documented way to ask for the last row of each group |
| `` `long$x-`long$y `` | a symbol next to arithmetic, where the symbol names a cast |
| `` `abs`cor`like`mins `` | the word `like` preceded by a backtick, so an element of a list rather than the operator |
| `` $[0i=`int$period;...] `` | a number, `=`, and a symbol, where the symbol is again a cast |
| `` `time in 0!select ... `` | a symbol, `in`, and a number, where the number unkeys a table |
| a usage string spanning indented lines | q continues a line when the next is indented, so a string may be long and full of things that read as code |

Adding to this file is the cheapest thing to do when a false positive is
reported: put the shape here, re-snapshot, and it cannot come back.

Run `cargo test --test corpus -- --ignored` to rewrite `expected.txt` after a
deliberate change.
