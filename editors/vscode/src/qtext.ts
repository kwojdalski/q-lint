// A value as text, whole whatever the process's `\c` (#1866, #1870).
// KDB-X cuts `-3!`, `.Q.s1`, `.Q.s` and the data inside `string` of a
// projection at the console's width - 80 characters unless `\c` was set -
// and ends each cut piece `..`: a reader that asked for 200 or 2000
// characters got 79, and two values that differ past the cut read alike.
// Free of any `vscode` import; held on KDB-X by qtext_q.test.js.
//
// Both are lambdas embedded in the lambdas that need them. They define
// nothing and only read `\c`: setting it wider for the call, as
// SNAPSHOT_RUN does, would leave the user's console changed if the call
// were cut short.
//
// `FULL_TEXT[n;x]` is `-3!x`. A text `-3!` did not cut is returned as it
// is, so most values cost one call. One it may have cut - it is at least
// the width long and holds `..` - is written again from its parts with
// `string`, which cuts no atom: a vector by its type's rule (`1 2 3i`,
// `` `a`b ``, `0x0102`, `0N 0Np`), a list, a dictionary, a table and an
// enumeration from their items, a lambda from its source, a projection, a
// composition and a derived function from what `value` gives. An elided
// argument of a projection is told from a `::` by what `{x;y}[it;0]` is:
// a projection. `n` bounds the work, not the result: at most `n` items of
// a vector and about `n` characters of a list are written, with `..` where
// more were left out, and the caller cuts the text to its own limit.
// Anything else (a foreign, a mapped list), and anything that signals, is
// as `-3!` gave it.
export const FULL_TEXT = [
  "{[n;x]",
  " r:-3!x;",
  " if[not(r like\"*..*\")&(count r)>=-1+last system\"c\";:r];",
  " .[{[f;r;n;x]",
  "   t:type x;c:count x;",
  "   if[t<0;:1_f[n;enlist x]];",
  "   a:$[t>99h;\"\";null a:attr x;\"\";\"`\",string[a],\"#\"];",
  "   if[t=0h;if[0=c;:r];o:();i:0;m:0;",
  "    while[(i<c)&m<n;o,:enlist f[n-m;x i];m+:1+count last o;i+:1];",
  "    :$[1=c;\",\",first o;\"(\",(\";\"sv o,$[i<c;enlist\"..\";()]),\")\"]];",
  "   if[t within 1 19h;if[0=c;:$[t=10h;\"\\\"\\\"\";a,\"`\",string[key x],\"$()\"]];x:n sublist x;s:string x;",
  "    :a,$[1=c;\",\";\"\"],$[t=1h;raze[s],\"b\";t=4h;\"0x\",raze s;t=10h;\"\\\"\",raze[{1_-1_-3!x}each x],\"\\\"\";t=11h;raze\"`\",/:s;t=2h;\" \"sv s;",
  "     [s:?[null x;count[x]#enlist$[t=9h;\"0n\";\"0N\"];s];",
  "      (\" \"sv s),$[t=9h;$[all raze[s]in\"0123456789-\";\"f\";\"\"];",
  "       t in 12 14 15 16 17 18 19h;$[all s in(\"0N\";\"0W\";\"-0W\";\"0w\";\"-0w\");\"p dznuvt\"t-12;\"\"];((),\"hi e    m\"t-5)except\" \"]]],$[c>n;\"..\";\"\"]];",
  "   if[t within 20 76h;:a,\"`\",string[key x],\"$\",$[0=c;\"()\";f[n;value x]]];",
  "   if[t=98h;:a,\"+\",f[n;flip x]];",
  "   if[t=99h;k:key x;",
  "    :a,$[(type[k]within 20 98h)|(2>count k)&type[k]within 1 19h;\"(\",f[n;k],\")\";f[n;k]],\"!\",f[n;value x]];",
  "   if[t=100h;:last value x];",
  "   if[t=104h;v:value x;",
  "    :f[n;first v],\"[\",(\";\"sv{[f;n;v;i]$[104h=type{x;y}[v i;0];\"\";f[n;v i]]}[f;n;v]each 1_til count v),\"]\"];",
  "   if[t=105h;:raze f[n]each value x];",
  "   if[t within 106 111h;:f[n;value x],(enlist\"'\";enlist\"/\";enlist\"\\\\\";\"':\";\"/:\";\"\\\\:\")t-106];",
  "   r};(.z.s;r;n;x);{[r;e]r}[r]]}",
].join("\n");

/// `UTF8_CUT[n;s]` is `n sublist s` for a string of UTF-8 bytes, less a
/// character it would cut inside: the codec reads such a tail as U+FFFD
/// (#2071).
export const UTF8_CUT =
  '{[n;s]if[n>=count s;:s];s:n#s;b:"i"$"x"$(0|count[s]-4)_s;i:last where not b within 128 191;$[null i;s;($[b[i]>=240;4;b[i]>=224;3;b[i]>=192;2;1])>(count b)-i;(i-count b)_s;s]}';

/// `ESCAPE_CUT[n;s]` is `UTF8_CUT[n;s]` for the text of `-3!`, less an
/// escape it would cut inside: `"\346\2` (#2071).
export const ESCAPE_CUT = `{[n;s]c:count s;s:${UTF8_CUT}[n;s];if[c=count s;:s];o:0|count[s]-3;p:o+last where"\\\\"=o _s;if[null p;:s];if[not all((1+p)_s)in"01234567";:s];r:p-last -1,where not"\\\\"=p#s;$[r mod 2;p#s;s]}`;

/// The items of a vector, and about the characters of a list, that a
/// function's text is written to: a projection may hold a table of any size.
export const TEXT_LIMIT = 100000;

// `LAID_OUT[FULL_TEXT;n;x]` is `.Q.s x` up to `n` characters, for every
// row rather than the console's 25: a table under its header, a dictionary
// and a keyed table as `key| value`, a general list one item a line, and
// anything else on one line. A simple column or key is written with
// `string`, as `.Q.s` writes it, and every other cell by `FULL_TEXT` - so
// an item of a list keeps the `(1;`a)` or `1 2f` that `.Q.s` drops, and a
// matrix is not aligned. A value it cannot lay out is on one line. Facing
// a table, the other side of a dictionary gets a blank line and a rule as
// wide as its first item, as `.Q.t0` gives it (#2070).
export const LAID_OUT = [
  "{[F;n;x]",
  " if[(::)~x;:\"\"];",
  " n sublist .[{[F;n;x]",
  "   C:{[F;v]$[type[v]within 1 19h;string v;type[v]within 20 76h;string value v;F each v]}F:F n;",
  "   T:{[C;x]h:string cols x;b:C each value flip x;w:(count each h)|{max 0,count each x}each b;",
  "    (l;count[l:\" \"sv w$'h]#\"-\"),$[count x;\" \"sv'flip w$/:'b;()]}C;",
  "   t:type x;x:$[t in 0 98 99h;(1+n div 2)sublist x;x];",
  "   ` sv$[t=98h;T x;t=0h;$[count x;F each x;enlist F x];t<>99h;enlist F x;",
  "    [p:98h=type each(k:key x;v:value x);",
  "     R:{[p;s]$[p;((count first s)#'\" -\"),s;s]};l:$[p 0;T k;R[p 1]C k];j:$[p 1;T v;R[p 0]C v];",
  "     ((max 0,count each l)$/:l),'\"| \",/:j]]};(F;n;x);{[F;n;x;e]F[n;x],\"\\n\"}[F;n;x]]}",
].join("\n");
