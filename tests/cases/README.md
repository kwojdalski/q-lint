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

`profile: general`, `profile: style` or `profile: uqf` in the header chooses
the rule set. Cases run under `style` unless they say otherwise, since that is
where most rules live; `general` is the right choice for a case that exists to
show the default staying quiet.

`tests/cases.rs` runs every file here. Add cases by editing these files; no
Rust changes are needed.
