/ Syntax errors, kept separate from showcase.q: the unclosed delimiter
/ stops the file being analysed at all, and it suppresses every other
/ finding in the same file whichever comes first. The invalid escape
/ (QE002) therefore lives at the end of showcase.q, where it coexists
/ with the rest of the findings.
/ QE001: the bracket never closes.
open:(1;2


2+`a