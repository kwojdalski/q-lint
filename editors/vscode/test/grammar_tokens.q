/ For grammar_tokens_q.test.js: q -q <lines> <literals> <rows> <verdicts>.
/ Each line's tokens as -4! splits it, as "<length><class>" items: S string,
/ Y symbol, C comment, X file verb, N a number or temporal value takes, O
/ anything else; nothing for a line -4! refuses. Each literal's verdict: lit
/ (one token of a number or temporal type), no, split (more than one token),
/ or junk (one whose value is the zero date 0000.00.00, a misparse q makes of
/ a clock it cannot read). Only a token that starts with a digit is evaluated,
/ so nothing runs but a literal.
num:{@[{a:abs type value x; $[(a within 1 19)&not a in 10 11h;"N";"O"]};x;"O"]};
lead:{(x[0]in .Q.n)|(x[0]in"-.")&x[1]in .Q.n,"."};
cls:{[t;col]$["\""=first t;"S";"`"=first t;"Y";("/"=first t except " \t")&(col=0)|t[0]in" \t";"C";(2=count t)&(":"=last t)&(first t)in .Q.n;"X";lead t;num t;"O"]};
row:{t:@[-4!;x;{()}]; $[0=count t;"";" " sv {(string count x),y}'[t;cls'[t;sums 0,-1_count each t]]]};
verdict:{t:-4!x; $[1<count t;"split";@[{v:value x; a:type v; $[(a within -9 -1)|a within -19 -12;$["0000."~5#string v;"junk";"lit"];"no"]};x;"no"]]};
(hsym `$.z.x 2) 0: row each read0 hsym `$.z.x 0;
(hsym `$.z.x 3) 0: verdict each read0 hsym `$.z.x 1;
exit 0
