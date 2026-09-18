# Regression corpus

Idiomatic q that must stay quiet, and a snapshot of exactly what the linter
says about it. `tests/corpus.rs` fails when a change moves any finding here.

The fixtures in `tests/cases/` say what a rule *should* report. They cannot
say what it should stay silent on, because a rule's author writes both and
only thinks of the shapes they already had in mind. Every false positive this
tool has shipped was caught by a third party's q rather than by a fixture.

So these files are not invented. Each pattern here is one that a rule in this
repository once reported wrongly, taken from the q on a developer machine:

| pattern | what reported it |
|---|---|
| a file ending inside `\d .u` | QF011, on 648 files, before it was withdrawn |
| `sel:{$[`~y;x;select from x where sym in y]}` | QB005, matching a `~` outside the filter |
| `select by sym from t` | QB009, on the last-row-per-group idiom |
| `` `long$x-`long$y `` | QT003, reading a cast as symbol arithmetic |
| `` `abs`cor`like`mins `` | QB007, reading a list element as the operator |
| `` $[0i=`int$period;...] `` | QT015, matching a prefix of a cast |
| `` `time in 0!select ... `` | QT015 again, on a table being unkeyed |
| a usage string spanning 26 indented lines | QB011, stepping over it to an unrelated `if[` |

Adding to this file is the cheapest thing to do after a false positive is
reported: put the shape here, re-snapshot, and it can never come back.

Run `cargo test --test corpus -- --ignored` to rewrite `expected.txt` after a
deliberate change.
