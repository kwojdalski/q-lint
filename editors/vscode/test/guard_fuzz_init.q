/ The sandbox guard_fuzz_q.test.js runs expressions on, from its own directory:
/ its state, and .hz.check, which names what changed since it was loaded.
\T 1
`:db/s/ set .Q.en[`:db] ([] c:`p`q; n:1 2);
`:f.q 0: enlist "zz:1";
`:g.txt 0: enlist "hello";
`:tp.log set (); .hz.h:hopen`:tp.log; .hz.h enlist(`upd;`a;77); hclose .hz.h;
a:1; b:2 3 4; s:"str"; t:([] a:1 2 3; b:`x`y`z); kt:([k:1 2] v:10 20);
.ns.f:{x+1}; .ns.v:42; .ns.d:`p`q!1 2;
e:([] s:`sym$`p`q; v:1 2);
d:`a`b!1 2;
sp:get `:db/s;
v:`a; upd:{[x;y] a::y};
.hz.files:{$[11h=type k:key x; (enlist[x]!enlist`dir),raze .z.s each ` sv/: x,/:k; enlist[x]!enlist`$raze string md5 "c"$read1 x]};
/ A value without its attributes: KDB-X sets s# on a sorted column a query reads.
.hz.plain:{@[{$[.Q.qt x;@[0!x;cols 0!x;`#];`#x]};x;{[x;e]x}[x]]};
.hz.val:{@[{`$raze string md5 "c"$-8!.hz.plain x};x;{`$"err:",x}]};
.hz.snap:{
  ns:(`$".",/:string (key `) except `hz),`.;
  r:raze {[n] dd:get n; k:(key dd) except `; ($[n~`.;k;` sv/: n,/:k])!.hz.val each dd k} each ns;
  r,:(`$"\\",/:("d";"cd";"t";"c";"P";"e";"g";"o";"z";"W";"T";"p";"S";"s"))!`$raze each string system each ("d";"cd";"t";"c";"P";"e";"g";"o";"z";"W";"T";"p";"S";"s");
  r,:(`$"file:",/:string key f)!value f:.hz.files`:.;
  r};
.hz.base:.hz.snap[];
.hz.run:{@[{value x; "ok"};x;{"err:",x}]};
.hz.check:{n:.hz.snap[]; k:distinct key[.hz.base],key n; c:k where not .hz.base[k]~'n[k]; " " sv string c};
