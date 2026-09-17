/ QP004 lives apart from showcase.q because of what it reports: dynamic
/ evaluation is where qlinter stops analysing names, and a line like the
/ one below would suppress QF005, QF010 and QT002 for the whole showcase
/ file. Here alone, the disclosure is the only finding - which is the
/ point: the silence after `value` is a skipped analysis, not a clean one.

/ QP004: `value` evaluates dynamically; name-scope checks were skipped.
v: value "x"
