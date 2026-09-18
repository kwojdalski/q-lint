# Rule cases

One case per `=== ` header. The header names the codes the case must raise,
or `clean` for source that must raise nothing:

    === QF001 | a builtin used as a parameter
    f:{[count] count+1}

    === clean | a name that merely resembles one is fine
    f:{[cnt] cnt+1}

Several codes are written `QF001 QF010`. A case raising a code it did not
name fails just as loudly as one missing a code it did: the negatives are the
point, since a linter nobody trusts is one that cried wolf.

`profile: general`, `profile: style`, `profile: styleq` or `profile: uqf` in the
header chooses
the rule set. Cases run under `style` unless they say otherwise, since that is
where most rules live; `general` is the right choice for a case that exists to
show the default staying quiet.

Every rule has a case here except three, each for a reason: `QE005` needs a
byte-order mark, which only exists at the start of a file and cannot sit in a
case body - it has `examples/byte-order-mark.q` and a unit test instead;
`QF006` is raised by a Python hook this build does not run; and `QLS001` comes
from an external server.

`tests/cases.rs` runs every file here. Add cases by editing these files; no
Rust changes are needed.
