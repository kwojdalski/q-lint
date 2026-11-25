// Random q expressions for guard_fuzz_q.test.js, each with its family and
// the parts it was built from: writes reached many indirect ways (a target
// computed, a string built, a writer picked out of .q, a file handle made),
// wrapped in lambdas, traps and adverbs, and common reads. Ported from the
// differential fuzz of the fourth bug hunt; seeded, so a run is repeatable.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let R = rng(1);
const pick = (a) => a[Math.floor(R() * a.length)];
const rev = (s) => [...s].reverse().join("");

// Symbol expressions that evaluate to `name`.
function symForms(name) {
  const f = {
    lit: "`" + name,
    paren: "(`" + name + ")",
    cast: '`$"' + name + '"',
    castcat: name.length > 1 ? '`$"' + name.slice(0, 1) + '","' + name.slice(1) + '"' : '`$"' + name + '",""',
    caststr: "`$string`" + name,
    first: "first`" + name,
    firstenl: "first enlist`" + name,
    idx: "`" + name + "`zz 0",
    idx2: "(`" + name + ";`zz)0",
    at: "`" + name + "`zz@0",
    last: "last`zz`" + name,
    lam: "{`" + name + "}[]",
    dict: "(`k!enlist`" + name + ")`k",
    rev: '`$reverse"' + rev(name) + '"',
    raze: '`$raze("' + name + '")',
    take: "1#`" + name,
    inter: "`" + name + "`zz inter `" + name,
  };
  if (name.startsWith(".")) {
    const parts = name.slice(1).split(".");
    f.sv = "` sv `" + parts.map((p, i) => (i === 0 ? "." + p : p)).join("`");
    f.dd = ".Q.dd[`." + parts[0] + ";`" + parts.slice(1).join(".") + "]";
  }
  return f;
}

// Writers by target: [id, template with T].
const WRITERS = {
  a: [["dotset", ".[T;();:;77]"], ["dotplus", ".[T;();+;1]"], ["dotneg", ".[T;();neg]"], ["set", "(T) set 77"], ["setb", "set[T;77]"], ["atnull", "@[T;::;:;77]"]],
  b: [["atidx", "@[T;0;:;77]"], ["atplus", "@[T;0;+;1]"], ["atneg", "@[T;0;neg]"], ["dotidx", ".[T;enlist 0;:;77]"], ["dotall", ".[T;();:;77]"], ["atjoin", "@[T;::;,;77]"], ["dotjoin", ".[T;();,;77]"]],
  d: [["atkey", "@[T;`a;:;77]"], ["atneg", "@[T;`a;neg]"], ["dotkey", ".[T;enlist`a;:;77]"]],
  t: [
    ["upd", "update a:77 from T"], ["del", "delete from T where a=1"], ["delc", "delete b from T"],
    ["bang", "![T;();0b;(enlist`a)!enlist 77]"], ["bangd", "![T;enlist(=;`a;1);0b;`symbol$()]"],
    ["xdesc", "`a xdesc T"], ["xdescb", "xdesc[`a;T]"], ["xkey", "`b xkey T"], ["xkeyb", "xkey[`b;T]"], ["xdescp", "xdesc[`a] T"],
    ["upsert", "(T) upsert (9;`q)"], ["insert", "(T) insert (9;`q)"], ["atcol", "@[T;`a;:;7 8 9]"], ["atcolneg", "@[T;`a;neg]"],
    ["dotcol", ".[T;(0;`a);:;77]"], ["joinrow", ".[T;();,;([]a:enlist 9;b:enlist`q)]"],
  ],
  kt: [["upsert", "(T) upsert (1;77)"], ["upd", "update v:77 from T"], ["unkey", "() xkey T"], ["dotk", ".[T;(1;`v);:;77]"]],
  sym: [["q", "(T)?`zz"], ["qb", "?[T;`zz]"], ["qe", "(T)?`zz`yy"]],
  e: [["upd", "update v:77 from T"], ["ins", "(T) insert (`sym$`p;9)"]],
  ".ns.v": [["dotset", ".[T;();:;77]"], ["dotplus", ".[T;();+;1]"], ["set", "(T) set 77"]],
};
const TARGETS = Object.keys(WRITERS);

// How T reaches the writer: written in place, or through a lambda.
const ROUTES = {
  place: (w, s) => w.replaceAll("T", s),
  param: (w, s) => { const l = "{" + w.replaceAll("T", "x") + "}"; return pick([l + "[" + s + "]", l + " " + s, l + "@" + s, l + " each enlist " + s, l + "'[enlist " + s + "]", l + " . enlist " + s]); },
  local: (w, s) => "{s:" + s + ";" + w.replaceAll("T", "s") + "}[]",
  localdict: (w, s) => "{s:`k!enlist " + s + ";" + w.replaceAll("T", "s`k") + "}[]",
  locallam: (w, s) => "{f:{" + w.replaceAll("T", "x") + "};f " + s + "}[]",
  named: (w, s) => "{[s]" + w.replaceAll("T", "s") + "}[" + s + "]",
  trap: (w, s) => "@[{" + w.replaceAll("T", "x") + "};" + s + ";::]",
  dottrap: (w, s) => ".[{" + w.replaceAll("T", "x") + "};enlist " + s + ";::]",
};
function routeFix(r, w, s) { return ROUTES[r](w, s); }

// Code strings and ways to build them.
const CODES = [["a:77", "a"], ["b[0]:77", "b"], [".ns.v:77", ".ns.v"], ["`a set 77", "a"], ["delete from `t", "t"], ["a+:1", "a"], ["\\l f.q", "zz"]];
function codeForms(s) {
  const bytes = "0x" + Buffer.from(s).toString("hex");
  const ints = [...Buffer.from(s)].join(" ");
  const f = {
    lit: JSON.stringify(s),
    bytes: '"c"$' + bytes,
    ints: '"c"$' + ints,
    char: "`char$" + ints,
    raze: "raze(" + JSON.stringify(s.slice(0, 2)) + ";" + JSON.stringify(s.slice(2)) + ")",
    cat: JSON.stringify(s.slice(0, 2)) + "," + JSON.stringify(s.slice(2)),
    rev: "reverse" + JSON.stringify(rev(s)),
    drop: "-1_" + JSON.stringify(s + "!"),
    lam: "{x}" + JSON.stringify(s),
    vs: '(" "vs' + JSON.stringify(s.replaceAll(" ", "\u0001") + " q") + ")0",
    idx: JSON.stringify(s) + "[til " + s.length + "]",
    first: "first enlist" + JSON.stringify(s),
    ssr: "ssr[" + JSON.stringify(s.replace(":", "=")) + ';"=";":"]',
    trimmed: "trim" + JSON.stringify(" " + s + " "),
  };
  if (/^[A-Za-z0-9_.:]+$/.test(s) && !s.startsWith(":")) f.symstr = "string`" + s;
  if (/^[A-Za-z0-9_.:]+$/.test(s)) f.symstr2 = 'string`$"' + s + '"';
  delete f.vs;
  return f;
}
const EVALS = [
  "value C", "get C", "eval parse C", "value parse C", "0 C", "0@C", "(0)C", "0 . enlist C", "(value)C", "value@C", "value[C]",
  "@[value;C;::]", ".[value;enlist C;::]", "{value x}C", "value each enlist C", "(value')enlist C", ".Q.trp[value;C;::]",
  "-6!parse C", "eval -5!C", "neg[0]C", "value'[enlist C]", "(value;C)1", "{value x}@C", "value/[C]",
];

// Writer functions obtained some indirect way: [id, expr giving set].
const FNS = {
  set: [["parse", '(parse"set")'], ["m5", '(-5!"set")'], ["qcat", '.q[`$"se","t"]'], ["qrev", '.q[`$reverse"tes"]'], ["qat", '(.q@`$"se","t")'],
    ["qnum", "(.q (key .q) 71)"], ["vq", "((value .q) 71)"], ["getcat", '(get`$"se","t")'], ["valcat", '(value`$".q.se","t")'], ["getq", '((get`.q)`$"se","t")'],
    ["qfirst", "(.q first(key .q) 71)"], ["dot", ".q[`$\"se\",\"t\"]"], ["parsepar", '(parse("set"))'], ["parsevar", '{parse x}"set"']],
};
const FNUSES = [["dot", "F . (`a;77)"], ["br", "F[`a;77]"], ["inf", "`a F 77"], ["proj", "F[`a] 77"], ["trap", ".[F;(`a;77);::]"], ["each", "F'[enlist`a;enlist 77]"]];
const OTHERFN = [
  ["upsert", '(parse"upsert")[`t;(9;`q)]'], ["insert", '(parse"insert")[`t;(9;`q)]'], ["xdesc", '(parse"xdesc")[`a;`t]'], ["hopen", '(parse"hopen")`:o.txt'],
  ["value", '(parse"value")"a:77"'], ["amend", '(parse".")[`a;();:;77]'], ["amend@", '(parse"@")[`b;0;:;77]'], ["enum", '(parse"?")[`sym;`zz]'],
  ["system", '(parse"system")"l f.q"'], ["m5hopen", '(-5!"hopen")`:o.txt'], ["xkeyq", '(.q`$"xk","ey")[`b;`t]'], ["vqx", "((value .q) 104)[`a;`t]"],
  ["valq", '((value .q) 68)"a:77"'], ["getq", '((value .q) 67)"a:77"'], ["sysq", '((value .q) 88)"l f.q"'], ["hopenq", '(.q`$"hop","en")`:o.txt'],
  ["bang", '(parse"!")[`t;();0b;(enlist`a)!enlist 77]'], ["m11", '(parse"-11!")'],
];

// File handle expressions for ./o.txt.
const FH = {
  lit: "`:o.txt", hsym: "hsym`o.txt", hsympar: "hsym(`o.txt)", hsymfirst: "hsym first`o.txt", cast: '`$":o.txt"', castcat: '`$":o",".txt"',
  hsymcast: 'hsym`$"o.txt"', hsymstr: "hsym`$string`o.txt", m1: "-1!`o.txt", sv: "` sv`:.`o.txt", dd: ".Q.dd[`:.;`o.txt]", first: "first`:o.txt",
  idx: "(`:o.txt;`zz)0", catstr: '`$":",string`o.txt', str: '":o.txt"', strcat: '":o",".txt"', hsymidx: "hsym`o.txt`zz 0", m1par: "-1!(`o.txt)",
  hsymlam: "hsym{`o.txt}[]", dotq: ".q.hsym`o.txt", dict: "(`k!enlist`:o.txt)`k", hsymraze: 'hsym`$raze"o.txt"', svcast: '` sv(`:.;`$"o.txt")',
};
const FWRITERS = [
  ["0:", "(F) 0: enlist\"x\""], ["0:b", "0:[F;enlist\"x\"]"], ["1:", "(F) 1: 0x01"], ["hopen", "hopen F"], ["hopenat", "hopen@F"], ["hopentrap", "@[hopen;F;::]"],
  ["hopenpar", "(hopen)F"], ["hopeneach", "hopen each enlist F"], ["hopenlam", "{hopen x}F"], ["neg", "(neg hopen F)\"x\""], ["set", "(F) set 77"],
  ["m19", "-19!(`:g.txt;F;17;2;6)"], ["dot", ".[F;();:;77]"], ["hopenproj", "hopen[F]"], ["hopendot", ".[hopen;enlist F;::]"], ["hopenq", ".q.hopen F"],
];

// Direct name writes.
const DIRECT = [
  "a:77", "a::77", "a+:1", "b[0]:77", ".ns.v:77", "(a;c9):(77;1)", "d[`a]:77", ".z.ts:{}", ".z.pg:{x}", "a :77", "a[]:77", "b[0] :77",
  "(a):77", "d[`a]+:1", ".ns.d[`p]:77", ".ns[`v]:77", "`.[`a]:77", "t[`a]:7 8 9", "a::(77)", "@[`.;`a;:;77]", "a[::]:77", "b[0;]:77",
];

const WRAPS = [
  ["none", (e) => e], ["lam", (e) => "{" + e + "}[]"], ["lam0", (e) => "{[]" + e + "}[]"], ["trap", (e) => "@[{" + e + "};0;::]"],
  ["cond", (e) => "$[1b;" + e + ";0]"], ["if", (e) => "if[1b;" + e + "]"], ["do", (e) => "do[1;" + e + "]"], ["paren", (e) => "(" + e + ")"],
  ["seq", (e) => "::;" + e], ["semi", (e) => e + ";"], ["comment", (e) => e + " / c"], ["qpfx", (e) => "q)" + e], ["each", (e) => "{x;" + e + "} each 0"],
  ["adv", (e) => "{" + e + "}'[0]"], ["over", (e) => "{x;" + e + "}/[0;1]"], ["peach", (e) => "{" + e + "} peach 0"], ["enlist", (e) => "enlist " + e],
  ["dotapp", (e) => "{" + e + "} . enlist 0"], ["atapp", (e) => "{" + e + "}@0"], ["callf", (e) => "{[f]f[]}{" + e + "}"], ["callx", (e) => "{x[]}{" + e + "}"],
  ["str", (e) => '"a:1";' + e], ["count", (e) => 'count"a:77";' + e], ["list", (e) => "(" + e + ";1)"], ["show", (e) => "0N!" + e], ["while", (e) => "{i:0;while[i<1;i+:1;" + e + "]}[]"],
  ["proj", (e) => "{[p;q]" + e + "}[0][1]"], ["scan", (e) => "{x;" + e + "}\\[1;0]"], ["eachr", (e) => "0{" + e + "}/:enlist 1"], ["eachl", (e) => "(enlist 0){" + e + "}\\:1"],
  ["prior", (e) => "{" + e + "}':[enlist 0]"], ["tab", (e) => "\t" + e], ["kpfx", (e) => "k)" + e],
];

// Common read-only code: the guard should not ask.
const READS = [
  "select from t where a>1", "count t", "meta t", "select count i by b from t", "exec a from t", "select from t where b in `x`y", "select[2] from t",
  "select from t where b like \"x*\"", "count select from t", "cols t", "key kt", "2#t", "select max a by b from t", "select from t where a within 1 2",
  "select from t where a=max a", "select from t where i<10", "select c:a*2 from t", "select from t where b=`x", "select from t where a=(max;a) fby b",
  "aj[`a;t;t]", "select from t where not null a", "select from sp", "value\"select from t\"", "0!kt", "`a xkey t", "`a xasc t", "@[t;`a;neg]",
  "show t", "-1 \"x\"", "string t", "\\t select from t", "\\ts count t", "t lj kt", "exec distinct b from t", "select a,b from t", "flip t",
  "select from t where a>1, b=`y", "first t", "last t", "update c:a*2 from t", "delete from t where a=1", "type t", "tables[]", "\\a", "\\v",
  "select sum a from t", "{x+1} each 1 2 3",  "sum a", "a", ".ns.v", "get`t", "value`t", "t[`a]", "t 0", "kt 1", "count each t", "exec a!b from t",
  "select from t where a=1;count t","select from t where b=`x, a>1","select last a by b from t","exec max a from t","select from t where a>avg a","update a:0 from t","select from kt","kt[1]","meta kt","count kt","select from t where b in exec b from t where a>1", "select from e", "e lj kt", "select from t where b=`$\"x\"", ".Q.s t", ".Q.w[]", "sym", "key`.", "\\l", "system\"d\"", "\\d",
  "select by b from t", "?[t;();0b;()]", "?[t;enlist(>;`a;1);0b;()]", "`a`b!1 2", "1 2 3?2", "`p`q?`q",  "{a:1}[]", "{[t] select from t}t",
  "select from t where a in exec a from t", "update a:a+1 from t where b=`x", "ungroup t", "raze t", "t,t", "distinct t", "reverse t", "asc a", "til 10",
  "\\P", "\\c", "system \"c\"", "select count i from t", "count each group t`b", "exec count i by b from t", "select from t where a<>2",
];

function core() {
  const r = R();
  if (r < 0.35) {
    const tgt = pick(TARGETS);
    const [wid, w] = pick(WRITERS[tgt]);
    const forms = symForms(tgt);
    const fid = pick(Object.keys(forms));
    const route = R() < 0.5 ? "place" : pick(Object.keys(ROUTES));
    return { fam: "target", parts: { tgt, wid, fid, route }, e: routeFix(route, w, forms[fid]) };
  }
  if (r < 0.55) {
    const [s] = pick(CODES);
    const forms = codeForms(s);
    const cid = pick(Object.keys(forms));
    const ev = pick(EVALS);
    return { fam: "eval", parts: { s, cid, ev }, e: ev.replaceAll("C", forms[cid]) };
  }
  if (r < 0.65) {
    if (R() < 0.6) {
      const [fid, f] = pick(FNS.set);
      const [uid, u] = pick(FNUSES);
      return { fam: "fn", parts: { fid, uid }, e: u.replaceAll("F", f) };
    }
    const [oid, o] = pick(OTHERFN);
    return { fam: "fn", parts: { oid }, e: o };
  }
  if (r < 0.78) {
    const fid = pick(Object.keys(FH));
    const [wid, w] = pick(FWRITERS);
    return { fam: "file", parts: { fid, wid }, e: w.replaceAll("F", FH[fid]) };
  }
  if (r < 0.85) {
    const d = pick(DIRECT);
    return { fam: "direct", parts: { d }, e: d };
  }
  if (r < 0.92) {
    const cmds = ["l f.q", "cd db", "c 10 10", "P 3", "e 1", "g 1", "W 3", "z 1", "S 7", "t 1000", "T 3", "x .z.pg", "1 o.txt", "_ f.q", "r g.txt h.txt"];
    const bare = [..."abBcCdeEfgoOpPrsSTvwWz_xlhjkmnquiyXAFGHIJKLMNQRUVYZ", "cd", "ts", "1", "2"];
    const c = R() < 0.5 ? pick(cmds) : pick(bare);
    const sp = pick(["", " ", "  ", "\t"]);
    const form = pick(["\\X", "system\"X\"", "system \"X\"", "system[\"X\"]", "value\"\\\\X\"", "k)\\X", "q)\\X", "system each enlist\"X\"", ".q.system\"X\"",
      "\\t \\X", "\\ts \\X", "\\t:1 \\X", "system\"X\" ", "system\"X\";", "(system\"X\")", " \\X", "system \"X\"/c"]);
    const x = form.includes("\\\\X") ? c.replace(/\\/g, "\\\\") + sp : c + sp;
    return { fam: "system", parts: { c, form }, e: form.replace("X", x) };
  }
  if (r < 0.97) {
    const e = pick(READS);
    return { fam: "read", parts: { e }, e };
  }
  // .Q, .h, internal functions with plausible arguments.
  const calls = [".Q.gc[]", ".Q.MAP[]", ".Q.cn sp", ".Q.ld 1", ".Q.fs[{x};`:g.txt]", ".Q.fsn[{x};`:g.txt;10]", ".Q.hdpf", ".Q.dd[`:.;`o.txt]", ".Q.en[`:db;([]c:enlist`zz)]",
    ".Q.v`t", ".Q.qp t", ".Q.par[`:.;2001.01.01;`t]", ".Q.chk`:db", ".Q.gz(6;\"x\")", ".Q.x", ".Q.opt .z.x", ".Q.def[`a`b!1 2] .Q.opt .z.x", ".Q.prf0 0", ".Q.sw",
    "-36!(`:g.txt;\"x\")", "-25!(enlist 0i;\"a:77\")", "-30!(0i;0b;\"x\")", "-38!0i", "-26!0", "-18!\"x\"", "-35!(`:o.txt;\"x\")", "-20!0", "-16!t", "-120!0",
    ".h.ht`t", ".h.br", ".h.HOME", ".h.edsn", ".Q.Xf[\"j\";`:o.txt]", ".Q.dsftg", ".Q.u", ".Q.pv", ".Q.ts[{a::77};enlist 0]", ".Q.trp[{a::77};0;::]",
    ".Q.fps[{x};`:g.txt]", ".Q.fpn[{x};`:g.txt;10]", ".Q.lo[`:db;0;0]", ".Q.ens[`:.;([]c:enlist`zz);`sym]", "s)SELECT * FROM t", "s)INSERT INTO t VALUES(9,'q')",
    "s)DELETE FROM t WHERE a=1", "s)UPDATE t SET a=77", "s)insert into t values(9,'q')", "s)CREATE TABLE zz (a int)", "s)DROP TABLE t",
    "-11!`:g.txt", "-11!(-1;`:g.txt)", "-11!(1;`:g.txt)", "-11!(0;`:g.txt)", "use`zz", ".z.exit", ".z.pg", "\\x .z.pg", "(-1)\"x\"", "1 \"x\"", "2 \"x\"",
  ];
  if (R() < 0.5) {
    const ch = ['"', "\\", "/", " ", ";", "(", ")", "{", "}", "[", "]", "`", "0", ":", "\t", "k)", "s)", "q)", "'", "-", "$", "!", ".", "x"];
    let p = "";
    const n = 1 + Math.floor(R() * 6);
    for (let i = 0; i < n; i++) p += pick(ch);
    const w = pick(["a:77", "`a set 77", ".[`a;();:;77]", "a::77", "b[0]:77", "\\l f.q", "a+:1"]);
    const q = R() < 0.5 ? p + w : w + p;
    return { fam: "tok", parts: { p, w }, e: q };
  }
  const e = pick(calls.concat(["s)Insert Into t Values(9,'q')", "s)insert into t values (9,'q')", "s)INSERT INTO t(a,b) VALUES(9,'q')", "s)DELETE FROM t", "s)UPDATE t SET a=77 WHERE a=1",
    "k)a:77", "k).[`a;();:;77]", "k)@[`b;0;:;77]", "k)b[0]:77", "k)a+:1", "k).\"a:77\"", "k).:\"a:77\"", "k).$`a:77", "k)`:o.txt 1: 0x01", "k)`t insert(9;`q)", "k)`sym?`zz",
    "k)`a xdesc `t", "k)![`t;();0b;(,`a)!,77]", "k)hopen`:o.txt", "k)1:[`:o.txt;0x01]", "k)`:o.txt 0: ,\"x\"", "k)-19!(`:g.txt;`:o.txt;17;2;6)", "k)\\l f.q", "k)a::77",
    "a : 77", "a: 77", "a\t:77", "a :: 77", "b [0]:77", "b[0] : 77", "a+ :1", "a +:1", ".ns.v : 77", "(a) : 77", "(a;c9) : (77;1)"]));
  return { fam: "builtin", parts: { e }, e };
}

function gen() {
  const c = core();
  const wraps = [];
  let e = c.e;
  const n = R() < 0.5 ? 0 : R() < 0.7 ? 1 : 2;
  for (let i = 0; i < n; i++) {
    const [wid, w] = pick(WRAPS);
    wraps.push(wid);
    e = w(e);
  }
  return { ...c, core: c.e, wraps, e };
}
module.exports = { gen, setSeed: (s) => { R = rng(s); }, WRAPS };
