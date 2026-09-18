/ This file begins with a UTF-8 byte-order mark, which is why it has one of
/ its own: a BOM can only sit at the start of a file, so it cannot be shown
/ on a marked line in showcase.q the way every other rule is.
/ q reports 'char on the first line and loads nothing. Editors on Windows
/ add one by default in several configurations, and the error it produces
/ points at what looks like ordinary code.
f:{[a] a+1}
