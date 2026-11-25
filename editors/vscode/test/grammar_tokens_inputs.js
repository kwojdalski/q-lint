// What grammar_tokens.test.js puts to the grammars and the word pattern, and
// grammar_tokens_q.test.js to q: lines shaped like the q corpus, seeded
// random statements built from fragments, and literal shapes generated
// around the edges q draws (the hours after D and T, minutes and seconds
// past 59, an upper-case exponent). Ported from the differential harness of
// the seventh extension bug hunt.

/// Lines as q code writes them, each holding a shape a grammar or the word
/// pattern once read differently from q.
const corpus = [
  "i.dateConvert:{[t] `timestamp$1970.01.01D0+t*1000000}",
  "r:select from t where time within (2024.01.01D0;2024.12.31D0)",
  "removeclienthandle:{[h] update lasttime:2000.01.01D0 from `.clients.clients where handle=h}",
  'typeDefaults:(0b;0Ng;0x0;0h;0;0j;10000e;1000000f;" ";`;0D0;0Nt)',
  "d:n?0D00:00:01;e:2024.01.02D1;f:2024.01.02T1;g:0D1.5p",
  "move:exec time bin'-0D00:01+.z.N from .u.t",
  "if[7h<>offsetType;timeOffset:floor(`long$timeOffset-1970.01.01D00)%1e6]",
  "x:`_a",
  "y:`a`_b`c;z:``_b",
  "`:data/trades.csv 0:.h.tx t",
  "h:hopen `:localhost:5010; h 0:1",
  ".strategy.__hedgeStep:{[x] .tst._runAllStep x.y._z}",
  's:`$"a-b";u:`a:b/c;v:`:a-b',
  "t:([] sym:`a`b; px:1.5 2.25; ts:2024.01.02D10:00:00.123456789 2024.01.02D10:00:01)",
  "n:1E3e*1E3f*1.5E3+1e-3*15E3e",
  "w:12:34+12:34:56+12:34:56.789+123:45+123:45:07+1234:56:07",
  "a:12:60;b:12:34:67;c:123:45:67;d:0D1:23",
  "f:{[a;b] a+b} / adds",
  "g:{x+1} // doubles",
  'msg:"it\'s a \\"quote\\" and a /slash" / comment',
  "r:1_til 5;q:-1_trades;p:2_'x",
  "k:0Nd,0Wp,-0W,0n,0Ni",
  "b:101b;x:0x1f2e",
  "m:2024.01m;d:2024.01.02;z:2024.01.02T12:34:56.789",
  "ts:.z.p;dt:.z.d;tm:.z.t",
  'e:@[value;"1+`a";{x}]',
  "r:a12:3",
  'l:`a`b!(1;"x")',
  "c:count each `a`b`c",
  "j:1 2 3h,4 5 6i,7 8 9j",
  's:"tab\\there\\nnewline\\\\backslash\\377"',
  "q:select max px by sym from t where date=2024.01.02, sym in `AAPL`MSFT",
];

/// `count` statements of fragments picked by a seeded generator, so a run is
/// repeatable.
function fuzz(count, seed) {
  const frags = ['"a"', '"a\\"b"', '"/ x"', "`a", "`a.b", "`:a/b", "`a:b/c", "`", "`_a", "`a`_b", "`a-b", "1", "-1", "1.5", "1e3", "1E3e", "1E3f", ".5", "2024.01.02", "1970.01.01D0", "2024.01.02T1", "0D0", "0D1.5", "0D00:00:01", "12:34", "12:60", "123:45:07", "123:45:67", "0D1:23", "12:34:56.789", "0N", "0w", "1b", "0x1f", "x", "y", ".z.p", ".ns.__f", "x.y._z", "a.b", "f", "sum", "{", "}", "[", "]", "(", ")", ";", ":", "/", "'", "/:", "\\:", " ", " ", " ", " / c", "+", "-", "*", "#", "_", "$", "?", "@", "!", "0:", "1:", "0:.h.tx", "x/"];
  const r = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const out = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    for (let j = 1 + r(8); j > 0; j--) s += frags[r(frags.length)];
    out.push(`r:${s}`);
  }
  return out;
}

const lines = () => [...corpus, ...fuzz(600, 7)];

/// Literal shapes. The type letters are only those q reads one way: after a
/// clock d and z give a date or datetime of a misparse (0000.00.00), and past
/// 99 hours u, n, p and t read the fields their own way, so they are left out.
function literals() {
  const out = [];
  const hours = ["", "0", "1", "12", "123", "1234", "1.5", "12.5", "1."];
  const clocks = ["1:23", "12:3", "12:34", "12:60", "12:59", "123:45", "12:34:5", "12:34:56", "12:34:60", "12:34:56.", "12:34:56.789", "12:34:56.123456789"];
  for (const head of ["2024.01.02D", "2024.01.02T", "0D", "1D", "12D"]) {
    for (const c of [...hours, ...clocks]) for (const s of ["", "n", "p", "t", "u", "v", "e", "f", "j"]) out.push(head + c + s);
  }
  for (const h of ["1", "12", "99", "123", "1234"]) {
    for (const m of [":3", ":34", ":60", ":59"]) for (const sec of ["", ":5", ":56", ":60", ":07.5", ":56."]) for (const s of ["", "v"]) out.push(h + m + sec + s);
  }
  for (const m of ["1", "15", "0", "1.", "1.5", ".5", "01"]) {
    for (const e of ["", "e3", "e-3", "e+3", "E3", "E-3", "E+3"]) for (const s of ["", "e", "f"]) out.push(m + e + s);
  }
  for (const m of ["1", "15", "1.5"]) for (const s of ["j", "h", "i", "n", "p", "t", "u", "v"]) out.push(`${m}E3${s}`, `${m}e3${s}`);
  return [...new Set(out)];
}

module.exports = { lines, literals };
