/ qSQL a linter has to leave alone: the last-row-per-group idiom, casts that
/ look like symbol arithmetic, and a symbol tested against an unkeyed table.
\d .q_lint_corpus

latest:{[t] select by sym from t}

window:{[t;lo;hi] select from t where time within (lo;hi)}

epoch:{[x] floor (`long$x-`long$1970.01.01D00:00)%1e9}

span:{[d] `timestamp$ d + `time$00:00:00.000}

isTimeColumn:{[t] `time in 0!select columns from meta t}

bucket:{[t] select cnt:count i by sym, minute:time.minute from t}

period:{[p] $[0i=`int$p; `none; `some]}

matched:{[t;s] select from t where sym like s}

names:asc `abs`cor`ej`gtime`like`mins`prev`scov`system`wavg

\d .
