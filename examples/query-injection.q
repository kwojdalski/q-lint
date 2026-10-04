/ QX001 has a file of its own because its example evaluates a string, and a
/ file that does that can define any name at all - so the linter rightly
/ stops checking names in it, which would silence half of showcase.q.

/ A query built by joining a value into its text, and run by value: passing
/ "a;x:0;0" as s runs x:0 inside the process - checked against q. A
/ functional select, ?[trades;enlist(=;`sym;enlist`$s);0b;()], takes the
/ same value as data.
lookup:{[s] value "select from trades where sym=`",s}
