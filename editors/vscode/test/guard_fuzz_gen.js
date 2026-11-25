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

// The families of the fifth bug hunt's independent fuzz (#2264-#2277):
// assignment written as a call, trees evaluated many ways, writers picked
// out of lists, handlers given evaluators, targets computed, iterated
// infix lambdas, k's monadic verbs, strings with script-only lines, and
// the system, internal, .Q/.h, .z, local, amend, writer-function and
// tokenizer families it built them on - each wrapped as that fuzz wrapped.
const chance = (p) => R() < p;
const hunt = (() => {
// ---- writer cores: each changes the sandbox when run ----
  const HANDLERS = ["ts", "pg", "ps", "po", "pc", "pw", "ph", "pp", "ws", "wo", "wc", "exit", "pi", "pd", "zd", "vs", "pm", "ac", "bm", "pq", "e"];
  const SYSW = [
    "t 100", "t 100j", "t 1e2", "t 100;", "t 100 ", "t  100", "t\t100", "t 0100", "t 100i", "t 0x64", "t 1e3", "t 5 6", "t (100)", "t 100/c", "t 100 /c", "t 0", "t 00", "t 1.5", "t 2#100",
    "x .z.pg", "x .z.ph", "x  .z.ph", "p 53729", "p 0", "e 1", "e 2", "g 1", "c 10 10", "c 30 100", "P 3", "S 7", "w 100000000", "w 2", "w 0 ", "w 00", "w 1j", "cd db", "r g.txt i.txt",
    "b", "C 10 10", "T 3", "W 3", "o 1", "z 1", "s 0", "E 1", "1 o1.txt", "2 o2.txt", "_ f.q", "l f.q", "d .zz", "touch zz", "echo x > zz", "a .", "f .", "v .", "u 1", "y 1", "Z 1", "r", "cd .",
    "c 25 80", "P 7", "e 0", "g 0", "T 0", "W 2", "S -314159", "o 0N", "z 0",
  ];
  const SYSFORMS = [
    (c) => "\\" + c, (c) => 'system"' + c + '"', (c) => 'system "' + c + '"', (c) => 'system["' + c + '"]', (c) => '(system)"' + c + '"', (c) => 'system@"' + c + '"',
    (c) => 'system each enlist"' + c + '"', (c) => '.q.system"' + c + '"', (c) => 'system ("' + c + '")', (c) => 'system "' + c.split(" ")[0] + ' ",' + JSON.stringify(c.split(" ").slice(1).join(" ")),
    (c) => '{system x}"' + c + '"', (c) => '@[system;"' + c + '";::]', (c) => 'value"\\\\' + c + '"', (c) => '"' + c + '" system', (c) => "system'[enlist\"" + c + "\"]",
    (c) => '\\t \\' + c, (c) => 'k)\\' + c, (c) => ' \\' + c, (c) => '\t\\' + c, (c) => '\\' + c + '\n', (c) => 'q)\\' + c, (c) => "system\"" + c + "\";", (c) => "system \"" + c + "\" ",
    (c) => '(`$"system") "' + c + '"', (c) => 'system/["' + c + '"]', (c) => 'system peach enlist"' + c + '"', (c) => 'system@/:enlist"' + c + '"', (c) => '\\ts:2 \\' + c,
  ];
  const INTERNAL_ARGS = ["0", "`:g.txt", "\"a:77\"", "(`:o.txt;\"x\")", "`a", "(0i;\"x\")", "0i", "enlist 0", "(`:g.txt;`:o.txt;17;2;6)", "::", "1b", "`:db", "(\"a\";\"b\")", "(`:o.txt;\"pw\")", "(`:g.txt;0)", "(1;`:tp.log)", "-1", "(`a;77)", "`:tp.log", "(`:o.txt;1 2)"];
  const TABLEW = [
    ".Q.dpft[`:db;2001.01.01;`c;`zt]", ".Q.dpfts[`:db;2001.01.01;`c;`zt;`sym]", ".Q.dpt[`:db;2001.01.01;`zt]", ".Q.en[`:db;([]c:enlist`zz)]", ".Q.ens[`:db;([]c:enlist`zz);`sym]",
    ".Q.hdpf[0;`:db;2001.01.01;`c]", ".Q.chk`:db", ".Q.l`:db", ".Q.lo[`:db;0;0]", ".Q.opt`x", ".Q.Xf[\"j\";`:o.txt]", ".h.ht`g", ".Q.bv[]", ".Q.view 2001.01.01", ".Q.L`:db",
    ".Q.enxs[$;`:db;([]c:enlist`zz);`sym]", ".Q.enx[$;`:db;([]c:enlist`zz)]", ".Q.dsftg[(`:db;`zt;`zt);(0;0);`c]",
  ];
  // Ways to reach a .Q/.h writer.
  function qreach(name) {
    const [ns, fn] = [name.slice(0, 2), name.slice(3)];
    return pick([
      name, ns + "[`" + fn + "]", ns + "`" + fn, "(" + ns + ")`" + fn, ns + "@`" + fn, "(get`" + ns + ")`" + fn, "(value`" + ns + ")`" + fn, "get`" + name, "value`" + name,
      "(`" + name + ")", "`" + name, ns + "[`$\"" + fn + "\"]", "(" + ns + " . enlist`" + fn + ")", "(" + ns + "`" + fn + "`zz)0", "first " + ns + "[enlist`" + fn + "]", "(" + ns + "[`" + fn + "])",
      "(" + name + ")", "(::)" + name, "{" + ns + "[x]}`" + fn, "(" + ns + "`" + fn + ")", "{x}" + name, "(" + name + ";::)0", "(`f!enlist " + name + ")`f", "('[" + name + ";::])", "(" + name + "@)", "{" + name + "}[]",
    ]);
  }
  function writerCall() {
    const w = pick(TABLEW);
    const m = /^(\.[Qh]\.[A-Za-z]+)(.*)$/.exec(w);
    const f = qreach(m[1]);
    let args = m[2];
    if (args.startsWith("`") || args.startsWith("[") === false) args = args.startsWith("[") ? args : " " + args.trim();
    if (args.startsWith("[") && chance(0.3)) {
      // apply with . on a list
      const inner = args.slice(1, -1);
      return { core: f + " . (" + inner + (inner.includes(";") ? "" : ";::") + ")", id: "q." + m[1] };
    }
    return { core: f + args, id: "q." + m[1] };
  }
  
  const ASSIGN_TARGETS = ["a", "b", "s", "d", "t", "upd", "v"];
  function assignCore() {
    const h = pick(HANDLERS);
    const val = pick(["{x}", "{0}", "{a::77}", "{[x]}", "17 2 6", "::"]);
    return pick([
      { core: ".z." + h + ":" + val, id: "zassign" },
      { core: ".z." + h + "::" + val, id: "zassign2" },
      { core: "@[`.z;`" + h + ";:;" + val + "]", id: "zamend" },
      { core: "`.z." + h + " set " + val, id: "zset" },
      { core: "(`.z;`" + h + ") set " + val, id: "zset2" },
      { core: ".z[`" + h + "]:" + val, id: "zidx" },
      { core: "\\x .z." + h, id: "zexp" },
      { core: ".z." + h + " :" + val, id: "zsp" },
    ]);
  }
  
  // Lambda-local confusion: an inner lambda assigns `n`, the outer amends it.
  function localCore() {
    const n = pick(["a", "b", "d", "s"]);
    const amend = pick([n + "[0]:77", n + ",:7", n + "+:1", n + "[::]:77", n + "-:1", n + "[`a]:77", n + "[0]+:1", n + " ,:7", n + "@:0", n + "[]:77"]);
    const decoy = pick([
      "{" + n + ":1}[]", "{[]" + n + ":1}", "select " + n + ":a from t", "([]" + n + ":1 2)", "\"" + n + ":1\"", "`" + n + ":1", "exec " + n + ":a from t", "update " + n + ":0 from t",
      "{" + n + "::1}", "{{" + n + ":1}}", "(" + n + ")", "k)" + n + ":1", n + "/ :1", "`" + n + "!1", n + ": :1", "(" + n + ";c9):(1;2)", "if[0b;{" + n + ":1}]", "{[" + n + "]}",
      "([" + n + ":1 2]v:3 4)", "`a`b!(" + n + ":1;2)", "f:{" + n + ":1}", n + "_:1", "\n " + n + ":1", "/ " + n + ":1\n ",
    ]);
    const order = chance(0.5) ? decoy + ";" + amend : amend + ";" + decoy;
    return { core: "{" + order + "}[]", id: "local:" + decoy.replace(new RegExp(n, "g"), "N") + "|" + amend.replace(new RegExp(n, "g"), "N") };
  }
  
  // Amend / update by name through odd structures.
  function amendCore() {
    const a = pick([
      ["@[`b;0;:;77]", "at"], [".[`b;enlist 0;:;77]", "dot"], ["@[`d;`a;+;1]", "atd"], ["update a:77 from `t", "upd"], ["delete from `t", "del"], ["`a xdesc `t", "xd"], ["`b xkey `t", "xk"],
      ["`t upsert (9;`q)", "ups"], ["`t insert (9;`q)", "ins"], ["`sym?`zz", "enum"], ["![`t;();0b;(enlist`a)!enlist 77]", "bang"], ["-11!`:tp.log", "replay"],
      ["`:o.txt 0: enlist\"x\"", "file0"], ["hopen`:o.txt", "hopen"], ["hdel`:g.txt", "hdel"], ["`ZZ setenv\"1\"", "setenv"], ["save`:t", "save"], ["hclose 0", "hclose"],
      ["`:o.txt set 1", "fset"], ["`a set 77", "set"], ["value\"a:77\"", "value"], ["a::77", "gassign"], ["eval(:;`a;77)", "evaltree"], ["exit 0", "exit"],
    ]);
    return { core: a[0], id: "amend:" + a[1] };
  }
  
  // Wrappers that apply / compose / iterate
  const WRAP = [
    ["lam", (e) => "{" + e + "}[]"], ["lamx", (e) => "{[x]" + e + "}0"], ["lamxyz", (e) => "{[x;y;z]" + e + "}[0;0;0]"], ["eachl", (e) => "0{[x;y]" + e + "}\\:enlist 0"], ["eachr", (e) => "0{[x;y]" + e + "}/:enlist 0"],
    ["eachboth", (e) => "{[x;y]" + e + "}'[enlist 0;enlist 0]"], ["eachlr", (e) => "(enlist 0){[x;y]" + e + "}/:\\:enlist 0"], ["prior", (e) => "{[x;y]" + e + "}':[enlist 0]"], ["priorseed", (e) => "{[x;y]" + e + "}':[0;enlist 0]"],
    ["scanseed", (e) => "{[x;y]" + e + "}\\[0;enlist 0]"], ["overseed", (e) => "{[x;y]" + e + "}/[0;enlist 0]"], ["scan1", (e) => "{" + e + ";x}\\[1;0]"], ["over1", (e) => "{" + e + ";x}/[1;0]"],
    ["eacheach", (e) => "{" + e + "}''[enlist enlist 0]"], ["eachpeach", (e) => "{" + e + "} each' enlist enlist 0"], ["dottrap", (e) => ".[{" + e + "};enlist 0;{x}]"], ["attrap", (e) => "@[{" + e + "};0;{x}]"],
    ["handler", (e) => "@[{'x};`boom;{" + e + "}]"], ["dothandler", (e) => ".[{'x};enlist`boom;{" + e + "}]"], ["trphandler", (e) => ".Q.trp[{'x};`boom;{[x;y]" + e + "}]"],
    ["condw", (e) => "$[1b;" + e + ";0]"], ["condr", (e) => "$[0b;0;" + e + "]"], ["cond3", (e) => "$[0b;0;1b;" + e + ";0]"], ["condlam", (e) => "{$[x;" + e + ";0]}1b"], ["if", (e) => "{if[1b;" + e + "]}[]"],
    ["do", (e) => "{do[1;" + e + "]}[]"], ["while", (e) => "{i:0;while[i<1;i+:1;" + e + "]}[]"], ["dotop", (e) => "do[1;" + e + "]"], ["whiletop", (e) => "{n:1;while[n;n-:1;" + e + "]}[]"],
    ["nested", (e) => "{{" + e + "}[]}[]"], ["nestedproj", (e) => "{[f]f[]}[{" + e + "}]"], ["inlinepair", (e) => "({" + e + "};{0})[0][]"], ["listidx", (e) => "({0};{" + e + "})@[1;::]"], ["listidx2", (e) => "(({0};{" + e + "})1)[]"],
    ["dictkey", (e) => "(`r`w!({0};{" + e + "}))[`w][]"], ["dictkey2", (e) => "((`r`w!({0};{" + e + "}))`w)[]"], ["tablefn", (e) => "(([]f:({0};{" + e + "}))`f)[1][]"], ["dictdot", (e) => "(`r`w!({0};{" + e + "})) . (`w;::)"],
    ["compose", (e) => "'[{" + e + "};::][0]"], ["compose2", (e) => "('[::;{" + e + "}])0"], ["proj", (e) => "{[a1;a2]" + e + "}[0][0]"], ["projlater", (e) => "{[a1;a2]" + e + "}[;0] 0"],
    ["each", (e) => "{" + e + "} each enlist 0"], ["peach", (e) => "{" + e + "} peach enlist 0"], ["over", (e) => "{" + e + "}/[0]"], ["applyat", (e) => "{" + e + "}@0"], ["applydot", (e) => "{" + e + "} . enlist 0"],
    ["fnlist", (e) => "{x[1][]}({0};{" + e + "})"], ["fnparam", (e) => "{[f;x]f x}[{" + e + "};0]"], ["fnparam2", (e) => "{x y}[{" + e + "};0]"], ["fnparamdict", (e) => "{x[`w][]}[`w`r!({" + e + "};{0})]"],
    ["semi", (e) => "count t;" + e], ["comment", (e) => e + " /c"], ["ml1", (e) => "count t\n " + e], ["ml2", (e) => "{\n " + e + "\n }[]"], ["mlcomment", (e) => "count t\n/ x\n " + e], ["crlf", (e) => "count t;\r\n " + e],
    ["tab", (e) => "count t;\t" + e], ["paren", (e) => "(" + e + ")"], ["list", (e) => "(0;" + e + ")"], ["enlist", (e) => "enlist " + e], ["show", (e) => "show " + e], ["neg0", (e) => "0N!" + e],
    ["seq0", (e) => "::;" + e], ["kpfx", (e) => "k)" + e], ["qk", (e) => "q)" + e], ["strafter", (e) => e + ";\"x\\\"y\""], ["strbefore", (e) => "\"x\\\"y\";" + e], ["strslash", (e) => "\"a /b\";" + e],
    ["symdots", (e) => "`a.b:c;" + e], ["symcolon", (e) => "`:a:b;" + e], ["unicode", (e) => "\"é\";" + e], ["long", (e) => "count " + "1 ".repeat(3000) + ";" + e], ["exceptions", (e) => "@[{" + e + "};::;::]"],
    ["iterit", (e) => "{" + e + "}/:'[enlist enlist 0]"], ["eachboth2", (e) => "{[x;y]" + e + "}'/:[enlist 0;enlist 0]"], ["nestedapply", (e) => "{x[]}[{y[]}[;{" + e + "}]]"],
  ];
  
  // Odd tokenizer inputs around a plain writer.
  function tokCore() {
    const w = pick(["a:77", "b[0]:77", "`a set 77", "\\t 100", ".z.ts:{}", "value\"a:77\"", "@[`b;0;:;77]", "hopen`:o.txt", "\\l f.q", "a::77"]);
    const pre = pick([
      "count t \\\n", "count t\n\\\n", "count t\n/\n", "count t\n /\n", "count t\n \\\n", "count t /\\\n ", "{x}\n/ c\n ", "\"a\\\\\"/ ", "\"a\\\"/\" ", "1 \"\\\"\" ", "`a/b ", "`a:b ", "`.a.b ",
      "count t\u00a0/ ", "count t\u2028/ ", "count t\f/ ", "count t\v/ ", "count t\r/ ", "count t\u3000/ ", "count t\u0085/ ", "\ufeff", "count \"/\" ", "0x2f ", "\"\\057\" ", "1 2 3 / ", "(\n /\n ", "{\n/\n ",
      "-1\"x\" / y\n", "count t; / c\n", "count t\t/c\n", "count t\r\n", "\"multi\nline\" ", "\"\\\\\\\"\" ", "count t;\\\\\n", "s:\"\\\"/\";", "(\"/\";", "`$\"/ \";", "1b/ ", "0N/ ", "x/ ", "{x}/ ", "count/ ",
      "count t;\\\n", "count t \\c\n", "count t;k)", "count t\n\\d .\n", "count t\n\t", "count t\n\n ", "count t\n\r\n ", "count t\r ", "count t\u00a0", "count t;/", "count t /", "\"a\"\"b\";",
    ]);
    const post = pick(["", "", "", " / trailing", "\n", "\r\n", ";", "\u00a0", " \\", "\n/", "\n\\", "\n \\", "\r"]);
    return { core: pre + w + post, id: "tok:" + JSON.stringify(pre) + JSON.stringify(post), notwrap: true };
  }
  
  function sysCore() {
    const c = pick(SYSW);
    const fi = Math.floor(R() * SYSFORMS.length);
    return { core: SYSFORMS[fi](c), id: "sys:" + c.split(" ")[0] + ":" + fi + ":" + c, notwrap: chance(0.5) };
  }
  
  function internalCore() {
    const n = 1 + Math.floor(R() * 130);
    const arg = pick(INTERNAL_ARGS);
    return { core: pick(["-" + n + "!" + arg, "(-" + n + ")!" + arg, "-" + n + "j!" + arg, "(neg " + n + ")!" + arg]), id: "int:" + n + ":" + arg, notwrap: chance(0.7) };
  }
  
  // Writer-function reached through data structures and iterators.
  function fnCore() {
    const f = pick(["set", ".q.set", "upsert", "insert", "hopen", "value", "hdel", "setenv", "xdesc", "xkey", "exit", "system", "eval", "get", ".Q.en", ".Q.dpft", ".h.ht", "hclose", "save", "load"]);
    const reach = pick([
      f, "(" + f + ")", "(" + f + ";::)0", "(::;" + f + ")1", "(`w`r!(" + f + ";::))`w", "(([]f:(" + f + ";::))`f)0", "{x}" + f, "{x}[" + f + "]", "first(" + f + ";::)", "last(::;" + f + ")",
      "(" + f + ";::)@0", "('[" + f + ";::])", "{[g]g}[" + f + "]", "(enlist " + f + ")0", "(" + f + "@)", "(" + f + ")[;]", "(2#enlist " + f + ")0",
    ]);
    const usage = pick({
      set: ["[`a;77]", " . (`a;77)", "/:[`a`c;77 78]", "'[enlist`a;enlist 77]", "\\:[`a;77]", "@/[`a;77]"], ".q.set": ["[`a;77]"], upsert: ["[`t;(9;`q)]", " . (`t;(9;`q))"], insert: ["[`t;(9;`q)]"], hopen: ["`:o.txt", "[`:o.txt]", " each enlist`:o.txt", "@`:o.txt"],
      value: ["\"a:77\"", "[\"a:77\"]", " each enlist\"a:77\"", "(`a;77)"], hdel: ["`:g.txt", "[`:g.txt]"], setenv: ["[`ZZ;\"1\"]"], xdesc: ["[`a;`t]"], xkey: ["[`b;`t]"], exit: ["0", "[0]"], system: ["\"t 100\"", "[\"t 100\"]"], eval: ["(:;`a;77)"], get: ["\"a:77\""],
      ".Q.en": ["[`:db;([]c:enlist`zz)]"], ".Q.dpft": ["[`:db;2001.01.01;`c;`zt]"], ".h.ht": ["`zt"], hclose: ["0"], save: ["`:t", "[`:t]"], load: ["`:f.q"],
    }[f] ?? ["[`a;77]"]);
    return { core: "(" + reach + ")" + usage, id: "fn:" + f };
  }
  
  // Realistic read-only code people send; asked about = over-asking.
  const READ_CORES = [
    "select from t where a>1", "select count i by b from t", "exec a from t where b=`x", "select max a by b from t", "count each group t`b", "meta t", "tables[]", "key`.", "{x+1} each til 3",
    "{[x;y] x+y}/[0;til 3]", "sum each (1 2;3 4)", "1 2 3 +/: 4 5", "1 2 +\\: 3 4", "deltas til 5", "{x,y}':[til 3]", "{x*2}\\[3;1]", ".[{x+y};1 2;{x}]", "@[{x+1};`a;{0}]", "$[1b;count t;0]",
    "{a:1;b:2;a+b}[]", "{[x] r:x+1; r*2} each til 3", "{d:`a`b!1 2; d`a}[]", "{l:(1;2); l 0}[]", "{s:select from t; count s}[]", "(`a`b!({x+1};{x*2}))[`a] 3", "({x+1};{x*2})[1] 3", "{x[0]} ({1};{2})",
    "{x}[`a]", "value `t", "get `t", "t[`a]", "select from t where b in `x`y", "exec distinct b from t", "update c:a*2 from t", "delete from t where a=1", "`a xasc t", "`b xkey t", "xkey[`b;t]",
    "0N!count t", "-1 \"x\";", "show t", ".Q.s t", ".Q.w[]", ".z.p", "\\t count t", "\\ts select from t", "system\"t\"", "system \"c\"", "\\c", "\\d", "\\P", "\\e", "\\g", "\\p", "\\S", "\\T", "\\W", "\\o", "\\z", "\\s",
    "\\w", "\\cd", "\\b", "\\B", "\\a", "\\v", "\\f", "\\C", "\\E", "system\"p\"", "system \"cd\"", "system\"x\"", "\\x",
    "{x where x>1} til 5", "{select from t where a=x} each 1 2", "raze {select from t where a=x} each 1 2", "{x!y}[`a`b;1 2]", "(til 3)!3#enlist t", "t lj kt", "aj[`a;t;t]", "ej[`a;t;t]", "{[t] count t} t",
    "{count x} peach (t;t)", "{x+y} scan til 4", "{x+y} over til 4", "{x+y} prior til 4", "(+/) til 4", "(+\\) til 4", "max each flip (1 2;3 4)", "{x,'y}[1 2;3 4]", "cols t", "count select from t", "type t",
    "{$[x>1;`big;`small]} each 1 2 3", "{if[x>1;:`big];`small} each 1 2 3", "{r:0;do[x;r+:1];r} 3", "{i:0;while[i<x;i+:1];i} 3", "{r:();r,:x;r} 1", "{d:()!();d[`a]:1;d} []", "{l:til 3;l[0]:9;l}[]",
    "{t:([] a:1 2);update b:a from t}[]", "{x[`a]:1;x}[`a`b!1 2]", "{y[0]:1;y}[0;1 2]", "{[d] d[`a]+:1;d}[`a`b!1 2]", "string `a`b", "`$\"a\"", "\"j\"$\"1\"", "1_ til 3", "-1_ til 3", "(1;`a;\"x\")",
    ".Q.dd[`:db;`s]", "hsym `a", "key `:db", "read0 `:g.txt", "read1 `:g.txt", "hcount `:g.txt", "get `:db/s", "count get `:db/s", "-22!t", "-8!t", "-9!-8!t", ".j.j t", ".j.k \"{}\"", "parse \"a:1\"",
    "md5 \"x\"", "ssr[\"abc\";\"b\";\"x\"]", "\"a b\" vs \"x\"", "\" \" sv (\"a\";\"b\")", "trim \" x \"", "lower \"AB\"", "`a in key `.", "@[t;`a;neg]", "@[d;`a;+;1]", ".[d;enlist`a;:;9]", "@[b;0;:;9]",
    "{x+1}/[3;0]", "{x+1}\\[3;0]", "{x<5}{x+1}/0", "(neg) each 1 2", "({x};{y})[0][1;2]", "{[a;b] a+b}[1;2]", ".[{x+y};(1;2)]", "{x . y}[+;1 2]", "{x @ y}[neg;1]", "neg@1", "neg . enlist 1",
  ];
  function readCore() {
    return { core: pick(READ_CORES), id: "read", read: true };
  }
  
  
  // Parse trees evaluated, reached many ways.
  const TREES = [
    ["(:;`a;77)", "assign"], ["((:);`a;77)", "assignp"], ["(::;`a;77)", "gassign"], ["(+:;`a;1)", "plusassign"], ["(set;`a;77)", "set"], ["((set);`a;77)", "setp"], ["(.q.set;`a;77)", "qset"],
    ["(@;`b;0;:;77)", "at"], ["((@);`b;0;:;77)", "atp"], ["(.;`b;enlist 0;:;77)", "dot"], ["(!;enlist`t;();0b;(enlist`a)!enlist 77)", "bang"], ["(upsert;`t;(9;`q))", "upsert"],
    ["(xdesc;enlist`a;enlist`t)", "xdesc"], ["(hopen;enlist`:o.txt)", "hopen"], ["(system;\"t 100\")", "system"], ["(value;\"a:77\")", "value"], ["({x set 77};enlist`a)", "lambda"],
    ["(setenv;enlist`ZZ;\"1\")", "setenv"], ["(hdel;enlist`:g.txt)", "hdel"], ["(?;enlist`sym;enlist`zz)", "enum"], ["(:;`.z.ts;{})", "zts"], ["(:;`a;(+;1;2))", "assignexpr"],
    ["(+;0;(:;`a;77))", "nested"], ["(count;(:;`a;77))", "nested2"], ["(enlist;(:;`a;77))", "nested3"], ["(eval;enlist(:;`a;77))", "nested4"], ["(-11!;enlist`:tp.log)", "replay"],
    ["((parse\"set\");`a;77)", "parseset"], ["(`set;`a;77)", "symset"], [".[;();:;77]", "proj"], ["(:;`b;(,;`b;7))", "assignb"], ["(.h.ht;enlist`g)", "hht"], ["(.Q.en;enlist`:db;([]c:enlist`zz))", "qen"],
  ];
  const EVALFORMS = [
    (x) => "eval" + x, (x) => "eval " + x, (x) => "(eval)" + x, (x) => "((eval))" + x, (x) => "(((eval)))" + x, (x) => "eval[" + x + "]", (x) => "eval@" + x, (x) => "eval/[" + x + "]", (x) => "(eval/)" + x,
    (x) => "(eval')enlist " + x, (x) => "eval'[enlist " + x + "]", (x) => "eval each enlist " + x, (x) => "eval peach enlist " + x, (x) => "(eval;::)[0]" + x, (x) => "(eval;::)[0][" + x + "]", (x) => "first[(eval;::)]" + x,
    (x) => "{x}[eval]" + x, (x) => "{[f]f}[eval]" + x, (x) => "('[eval;::])" + x, (x) => "'[eval;::]" + x, (x) => "'[::;eval]" + x, (x) => "(-6!)" + x, (x) => "-6!" + x, (x) => "(-6)!" + x, (x) => "-6 !" + x,
    (x) => "value" + x, (x) => "(value)" + x, (x) => "((value))" + x, (x) => "value/[" + x + "]", (x) => "(value/)" + x, (x) => "(value')enlist " + x, (x) => "(value;::)[0]" + x, (x) => "get" + x, (x) => "((get))" + x,
    (x) => ".q.eval" + x, (x) => "(.q.eval)" + x, (x) => ".q[`eval]" + x, (x) => "(.q`eval)" + x, (x) => "eval\[" + x + "]", (x) => "eval/:[enlist " + x + "]", (x) => "eval\:[enlist " + x + "]", (x) => "eval':[enlist " + x + "]",
    (x) => "@[eval;" + x + ";::]", (x) => ".[eval;enlist " + x + ";::]", (x) => ".Q.trp[eval;" + x + ";::]", (x) => "eval . enlist " + x, (x) => "(eval) . enlist " + x, (x) => "0" + x, (x) => "0 " + x, (x) => "(0;::)[0]" + x, (x) => "(0)" + x,
    (x) => "neg[0]" + x, (x) => "{eval x}" + x, (x) => "{x y}[eval;" + x + "]", (x) => "{x y}[eval]" + x, (x) => "(`f!enlist eval)[`f]" + x, (x) => "(`eval)" + x, (x) => "(`.q.eval)" + x, (x) => "eval(::;" + x + ")",
    (x) => "reval" + x, (x) => "(reval)" + x, (x) => "-24!" + x, (x) => "k).:" + x, (x) => "k).(" + x + ")", (x) => "k)(.)" + x,
  ];
  function treeCore() {
    const [tr, tid] = pick(TREES);
    const fi = Math.floor(R() * EVALFORMS.length);
    return { core: EVALFORMS[fi](tr), id: "tree:" + tid + ":" + fi };
  }
  // Assignment written as a function call.
  function colonCore() {
    const op = pick([":", "::", "+:", ",:", "-:", "(:)", "(::)", "(+:)", "(,:)", ": "]);
    const tgt = pick(["a", "b 0", "b[0]", ".ns.v", "d`a", "d[`a]", ".z.ts", "(a;s)", "s", "upd", " a ", "t`a", "b@0"]);
    const val = { ".z.ts": "{}", "(a;s)": "(1;2)", "t`a": "7 8 9" }[tgt] ?? "77";
    return { core: op + "[" + tgt + ";" + val + "]", id: "colon:" + op + ":" + tgt.trim() };
  }
  
  // Strings evaluated whole, holding what only a script treats specially.
  function valstrCore() {
    const w = pick(["a:77", "b[0]:77", "\\\\t 100", "`a set 77", ".z.ts:{}", "@[`b;0;:;77]", "\\\\l f.q", "hopen`:o.txt", "a::77"]);
    const sep = pick(["\\n/\\n", "\\n\\\\\\n", "\\n/ c\\n", "\\n /\\n ", "\\n\\\\ \\n", "\\n/\\n\\\\\\n", "\\r\\n/\\r\\n", "\\n\\t/\\n", "\\n#!x\\n", "\\n/x\\n\\\\\\n", "\\n\\n/\\n\\n", "\\n}\\n"]);
    const pre = pick(["count t", "1", "(1;", "{x}", "", "/c"]);
    const ev = pick(["value \"S\"", "get \"S\"", "eval parse \"S\"", "0 \"S\"", "value[\"S\"]", "{value x}\"S\"", "value each enlist \"S\"", ".gw.syncexec[\"S\";`rdb]", "@[value;\"S\";::]", "(value)\"S\"", "neg[0]\"S\"", "value/[\"S\"]"]);
    const body = pre + sep + w + (pre === "(1;" ? ")" : "");
    return { core: ev.replace("S", body), id: "valstr:" + sep + ":" + ev.split("[")[0].split(" ")[0] };
  }
  
  function kprimCore() {
    const f = pick(["<", "~", ">", "<:", "~:", "(<)", "(~)", "{<x}", "{~x}"]);
    const a = { "<": "`:o.txt", "~": "`:g.txt", ">": "0i" }[f.replace(/[(){}:x]/g, "")] ?? "`:g.txt";
    return { core: "k)" + f + pick([a, " " + a, "(" + a + ")", "-1!`" + a.slice(2), "`$\"" + a.slice(1) + "\""]), id: "kprim:" + f };
  }
  function handlerCore() {
    const h = pick(["value", "get", "{value x}", "(value;::)0", ".h.val", "hopen", "{hopen x}", "0", "eval parse@", "{x set 77}", "system", "{.[`$x;();:;77]}"]);
    const sig = pick(["\"a:77\"", "`:o.txt", "\"t 100\"", "`a"]);
    const f = pick(["@[{'x};S;H]", ".[{'x};enlist S;H]", ".Q.trp[{'x};S;{[e;b](H) e}]", "@[{'x};S;H]", "@[{'x};S;{[e](H) e}]"]);
    return { core: f.replace("S", sig).replace("H", h), id: "handler:" + h };
  }
  function infixCore() {
    const it = pick(["'", "/:", "\\:", "':", "/", "\\"]);
    const body = pick(["{.[x;();:;y]}", "{@[x;0;:;y]}", "{x set y}", "{update a:y from x}", "{x?y}"]);
    const l = { "{x?y}": "`sym", "{update a:y from x}": "`t", "{@[x;0;:;y]}": "`b" }[body] ?? "`a";
    const r = body === "{x?y}" ? "`zz" : "77";
    return { core: l + body + it + r, id: "infix:" + it };
  }
  function pickCore() {
    const w = pick([["@", "[`b;0;:;77]"], [".", "[`b;enlist 0;:;77]"], ["?", "[`sym;`zz]"], ["!", "[-11;`:tp.log]"], ["eval", "(:;`a;77)"], ["{.[x;();:;77]}", "`a"], ["-6!", "(:;`a;77)"], [".h.val", "\"a:77\""]]);
    const reach = pick(["{x}[W]", "(W;::)[0]", "(::;W)1", "(`w`r!(W;::))[`w]", "first(W;::)", "(enlist W)0", "{[f]f}[W]", "((W))", "(W)", "@[{x};W;::]"]);
    return { core: reach.replace("W", w[0]) + w[1], id: "pick:" + w[0] + ":" + reach };
  }
  function computedCore() {
    const src = pick(["{x}`T", "{x}[`T]", "enlist[`T]0", "{y}[0;`T]", ".[{x};enlist`T]", "@[{x};`T;::]", "{`T}[]", "(`T;`zz)0", "`T`zz 0", "first`T", "{x}@`T", "('[{x};::])`T"]);
    const w = pick([["@[S;0;:;77]", "b"], ["update a:77 from S", "t"], ["`a xdesc S", "t"], ["?[S;`zz]", "sym"], ["![S;();0b;(enlist`a)!enlist 77]", "t"], [".[S;();:;77]", "a"], ["(S) upsert (9;`q)", "t"], ["-11!S", ":tp.log"], ["hopen S", ":o.txt"]]);
    return { core: w[0].replace("S", src.replace("T", w[1])), id: "computed:" + src };
  }
  // Each family about as often; a family's id names its parts.
  const CORES = [kprimCore, handlerCore, infixCore, pickCore, computedCore, treeCore, colonCore, valstrCore, sysCore, internalCore, writerCall, assignCore, localCore, amendCore, fnCore, tokCore, readCore];
  return () => {
    const c = pick(CORES)();
    let e = c.core;
    const wraps = [];
    const n = c.notwrap ? (chance(0.7) ? 0 : 1) : chance(0.3) ? 0 : chance(0.6) ? 1 : chance(0.7) ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const [wid, w] = pick(WRAP);
      wraps.push(wid);
      e = w(e);
    }
    const fam = c.read ? "read" : c.id.startsWith("q.") ? "qwriter" : /^z(assign|amend|set|idx|exp|sp)/.test(c.id) ? "zhandler" : c.id.split(":")[0];
    return { fam, parts: { id: c.id }, core: c.core, wraps, e };
  };
})();

function gen() {
  // Half from the families above, half from the fifth hunt's.
  if (R() < 0.5) return hunt();
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
