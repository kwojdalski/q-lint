/ The shape of KX's own u.q, which several rules reported wrongly. It opens a
/ namespace and never closes it, and its `sel` uses `~` in a conditional on a
/ line that also contains a select.
\d .u

init:{w::(,/)(::)each w}

del:{w[x]_:(w[x;;0]?y)}

sel:{$[`~y;x;select from x where sym in y]}

pub:{[t;x]
  {[t;x;w]
    if[count x:sel[x] w 1;
      (neg first w)(`upd;t;x)];
   }[t;x] each w t;
  }

add:{$[(count w x)>i:w[x;;0]?.z.w;
    .[`.u.w;(x;i;1);union;y];
    w[x],:enlist(.z.w;y)];
  (x;$[99=type v:value x;sel[v]y;0#v])}

sub:{if[x~`;:sub[;y]each t];if[not x in t;'x];del[x].z.w;add[x;y]}

end:{(neg union/[w[;;0]])@\:(`.u.end;x)}
