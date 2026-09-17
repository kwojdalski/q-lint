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

`profile: uqf` in the header runs that case under `--profile uqf` instead of
the default rule set.

`tests/cases.rs` runs every file here. Add cases by editing these files; no
Rust changes are needed.
