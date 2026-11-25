// What running a file sends, against what q's own loader runs (#2278-#2282):
// each text below is `\l`oaded by a fresh q, and sent by another the way
// Query Entire File sends it - `scriptCode`, cut by `statements`, run by
// the query lambda over IPC - and the two must end holding the same names,
// with the same values and the same lambda texts, in every namespace, and
// both stopped by an error or neither. The texts are the 70 hand-made traps
// of the sixth bug hunt and 320 made from fixed seeds; master before #2278
// differed on 259 of them. Needs a q binary, so it runs only when
// QLINT_TEST_Q names one.
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { QConnection } = require("../out/qclient.js");
const { scriptCode, statements } = require("../out/statements.js");

const Q = process.env.QLINT_TEST_Q;
const skip = Q ? false : "QLINT_TEST_Q names no q binary";

/// Every name in every namespace but q's own, with its value as q shows it:
/// a lambda as its text. Run where the code ran.
const DUMP = `{[x] system "d ."; system "c 2000 2000";
 ns:(key \`) except \`q\`Q\`h\`j\`o\`z\`m\`qlintzz;
 nm:asc distinct (system "v"),(system "f"),raze {[n] k:(key \` sv \`,n) except \`; {\` sv x,y}[\`,n] each k} each ns;
 {string[x]," = ",-3!@[get;x;{"ERR ",x}]} each nm}`;

/// The traps the hunt found, one file each.
const MICRO = [
  ["c01_slash_space", "a:1\n/ \nb:2\n\\\nc:3\n"],
  ["c02_slash_tab", "a:1\n/\t\nb:2\n\\\nc:3\n"],
  ["c03_bs_space", "a:1\n\\ \nb:2\n"],
  ["c04_crlf", "a:1\r\nf:{x+\r\n  y}\r\n/\r\nb:2\r\n\\\r\nc:3\r\n"],
  ["c05_str_unindented", "a:\"x\ny\"\nb:2\n"],
  ["c06_blank_in_fn", "f:{\n\n  x}\ng:1\n"],
  ["c07_sys_cont", "\\d .foo\n  a:1\nb:2\n\\d .\n"],
  ["c08_k", "k)f:{x+\n  y}\ng:f[1;2]\n"],
  ["c09_block_in_stmt", "f:{x+\n/\njunk\n\\\n  y}\ng:f[1;2]\n"],
  ["c10_bs_in_str", "a:\"x\n\\\nb:2\n"],
  ["c11_slash_in_str", "a:\"x\n/y\"\nb:2\n"],
  ["c12_bom", "\ufeffa:1\nb:2\n"],
  ["c13_nbsp", "a:1\n/\u00a0\nb:2\n\\\nc:3\n"],
  ["c14_ff", "a:1\n/\f\nb:2\n\\\nc:3\n"],
  ["c15_indented_bs", "a:1\n  \\\nb:2\n"],
  ["c16_shebang", "#!/usr/bin/q\na:1\n"],
  ["c17_end", "a:1\n\\\n"],
  ["c18_blank_str", "a:(\"x\";\n  \"y\n\n  z\")\nb:1\n"],
  ["c19_blanks_comment", "f:{x+\n\n/ c\n\n  y}\ng:f[1;2]\n"],
  ["c20_lead_indent", "  a:1\nb:2\n"],
  ["c21_cont_assign", "a:1\n  b:2\n"],
  ["c22_cont2", "a:1;\n  b:2\n"],
  ["c23_esc", "a:\"x\\\\\"\n/ c\nb:2\n"],
  ["c24_bs_in_stmt", "f:{x+\n\\\n  y}\nb:1\n"],
  ["c25_trailing", "a:1 /c\nb:\"/\" /x\n"],
  ["c26", "a:1\n/a\\\nb:2\n"],
  ["c27_l", "\\l nonexist.q\nb:2\n"],
  ["c28_exitcmd", "a:1\n\\\\\nb:2\n"],
  ["c29_crlf_end", "a:1\r\n\\\r\nb:2\r\n"],
  ["c30_crlf_block", "a:1\r\n/\r\nb:2\r\n\\\r\nc:3\r\n"],
  ["c31", "a:1\n\n\n"],
  ["c32", "a:\"x\n  /y\"\nb:2\n"],
  ["c33", "f:{[x]\n  x+1 / comment\n  }\ng:f 1\n"],
  ["c34", "\\c 10 20\na:system\"c\"\n"],
  ["c35_tabblank", "a:1\n\t\nb:2\n"],
  ["d01_ff_line", "f:{x+\n\f\n  y}\ng:f[1;2]\n"],
  ["d02_nbsp_line", "f:{x+\n\u00a0\n  y}\ng:f[1;2]\n"],
  ["d03_bs_nbsp", "a:1\n\\\u00a0\nb:2\n"],
  ["d04_vt", "a:1\n/\u000b\nb:2\n\\\nc:3\n"],
  ["d05_cr", "a:1\n/\r\r\nb:2\n\\\nc:3\n"],
  ["d06_mix", "a:1\n/ \t \nb:2\n\\ \t\nc:3\n"],
  ["d07_nbsp_lead", "a:1\n\u00a0b:2\n"],
  ["d08_emsp", "f:{x+\n\u2003\n  y}\ng:f[1;2]\n"],
  ["d09", "a:\"x\n\f\n  y\"\nb:1\n"],
  ["d10_spaceline", "f:{x+\n \n  y}\ng:f[1;2]\n"],
  ["d11", "a:1\r\n\\ \r\nb:2\r\n"],
  ["e01_comment_in_str", "a:(\"x\n/ y\n  z\")\nb:1\n"],
  ["e02_slash_in_str", "a:(\"x\n/\n  z\")\nb:1\n"],
  ["e03_block_in_str", "a:(\"x\n/\nq\n\\\n  z\")\nb:1\n"],
  ["e04", "a:(\"x\n\\\n  z\")\nb:1\n"],
  ["e05", "f:{x+\n\\\n  y}\nb:1\n"],
  ["e06", "a:(\"x\n/ y\n  z/ w\")\nb:1\n"],
  ["f01_trail", "s1:\"ab   \n  cd\"\ns2:\"ab\n   \n  cd\"\ns3:\"ab\n\t\n  cd\"\ns4:\"ab\t\n  cd\"\n"],
  ["f02", "a:1\n/\nx\n  \\\ny:1\n\\\nz:1\n"],
  ["f03", "a:1\n/\n  /\nx\n\\\nz:1\n"],
  ["f04", "a:1\n/ \n/\t\nx\n\\\nw:1\n\\\nz:1\n"],
  ["f05", "a:1\n\\\t\nz:1\n"],
  ["f06", "f:{x+\n/\n  y}\n\\\ng:1\n"],
  ["f07_unclosed", "a:1\n/\nb:2\n"],
  ["f08", "k)a:1\nk)/\nb:2\n"],
  ["f09", "a:1;/ c\nb:2\n"],
  ["f10", "a:1\n\\  junk\nb:2\n"],
  ["g01_ff", "a:1\n\f\nb:2\n"],
  ["g02_nbsp", "a:1\n\u00a0\nb:2\n"],
  ["g03", "a:1\n\u00a0 / note\nb:2\n"],
  ["g04", "f:{x+\n\u00a0 y}\nb:f[1;2]\n"],
  ["h01_cr", "a:1\rb:2\r"],
  ["h02_crcr", "a:1\r\r\nb:2\r\n"],
  ["h03", "f:{x+\r\n  y}\r\r\ng:f[1;2]\n"],
  ["t1", "a:1\nf:{x+\n/ comment\n  y}\n/\nb:2\n/\nc:3\n\\\nd:4\n\\\ne:5\n"],
];

/// A small seeded generator, so the set is the same at every run.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Statements, each a list of lines, with {i} for a number that keeps
/// names apart.
const PIECES = [
  ["v{i}:{i}"],
  ["f{i}:{x+", "  {i}}"],
  ["f{i}:{x+", "\t{i}}"],
  ["f{i}:{[x]", "  y:x*2;", "  y+{i}}"],
  ["fb{i}:{[x]", "  / double it", "  y:x*2;", "", "  y+{i}}"],
  ["fc{i}:{[x]", "  a:x+1;", "/", "  a:a*100;", "\\", "  a}"],
  ["fd{i}:{[x]", "  a:x;", "/", "\tnested", "/", "deeper", "\\", "\\", "", "  a+{i}}"],
  ['s{i}:"ab', '  cd"'],
  ['s{i}:"ab', '\tcd"'],
  ['s{i}:"ab', "", '  cd"'],
  ['s{i}:"ab', "   ", '\t\tcd"'],
  ['sq{i}:"select *', '\tfrom t"'],
  ['s{i}:"a /b" / trailing'],
  ['s{i}:"a\\"b"'],
  ["l{i}:(1;", "  2; / c", "  3)"],
  ["k)k{i}:{x+", "  {i}}"],
  ["k)kk{i}:1+{i}"],
  ["\\d .ns{i}", "w:{i}", "\\d ."],
  ["\\d .cx{i}", "g{i}:{x+{i}}"],
  ["t{i}:([]a:1 2;", "  b:`x`y)"],
  ["c{i}:count select from ([]a:til {i})", " where a>1"],
  ["m{i}:{x", "  -1}"],
  ["d{i}:`a`b!(1;", "/ comment line", "  2)"],
  ["e{i}:1+", "/", "junk", "\\", "  {i}"],
  ["p{i}:{i}", " /not a block"],
  ["r{i}:{i};"],
  ["u{i}:1 2 3", "  ,4"],
  ['z{i}:("a', "", " ", '  b")'],
  ["o{i}:{", "  x}[{i}]"],
  ['h{i}:"/";'],
  ["n{i}:`a /b", "  ,`c"],
  ["w{i}:{i}  ", "\t"],
];

/// Lines put between statements now and then.
const FILL = [[""], ["/ comment"], ["/", "hidden{i}:1", "\\"], ["  "], ["\t"], ["/ c1", "/ c2"], ["/\u00a0"], ["\f"], ["\u00a0"], ["\u2003"], ["\u000b"], ["/ "], ["  lost{i}:1"]];

function generated(seed, n) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const out = [];
  for (let k = 0; k < n; k++) {
    const lines = [];
    if (r() < 0.15) {
      lines.push(pick(["  lead:1", "\tlead:2", "  \\d .lead", "/ c", ""]));
    }
    const count = 2 + Math.floor(r() * 6);
    for (let i = 0; i < count; i++) {
      lines.push(...pick(PIECES).map((l) => l.replaceAll("{i}", String(i))));
      if (r() < 0.35) {
        lines.push(...pick(FILL).map((l) => l.replaceAll("{i}", String(i))));
      }
      if (r() < 0.04) {
        lines.push("\\", `after${i}:1`);
      }
    }
    let text = lines.join("\n") + "\n";
    if (r() < 0.2) {
      text = text.replaceAll("\n", "\r\n");
    }
    out.push([`gen${seed}_${k}`, text]);
  }
  return out;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function stop(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

/// What a fresh q holds after `\l` of `text`, or "exited".
async function loaded(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-load-"));
  try {
    fs.writeFileSync(path.join(dir, "t.q"), text);
    fs.writeFileSync(
      path.join(dir, "run.q"),
      `.qlintzz.e:@[{system "l t.q";0b};::;{1b}];\n(hsym \`$"out.txt") 0: (enlist "error ",-3!.qlintzz.e),${DUMP}[0];\nexit 0\n`,
    );
    const child = spawn(`${Q} run.q -q`, { shell: true, cwd: dir, stdio: ["ignore", "ignore", "ignore"], detached: true });
    const timer = setTimeout(() => stop(child), 15000);
    await new Promise((resolve) => child.on("exit", resolve));
    clearTimeout(timer);
    const out = path.join(dir, "out.txt");
    return fs.existsSync(out) ? fs.readFileSync(out, "utf8").trimEnd() : "exited";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/// What a fresh q holds after `text` is run as Query Entire File runs it,
/// or "exited".
async function sent(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-send-"));
  const port = await freePort();
  const child = spawn(`${Q} -p ${port} -q`, { shell: true, cwd: dir, stdio: ["ignore", "ignore", "ignore"], detached: true });
  try {
    let c;
    for (let i = 0; i < 300 && c === undefined; i++) {
      c = await QConnection.open({ host: "127.0.0.1", port }).catch(() => undefined);
      if (c === undefined) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.ok(c, "q did not start listening");
    const cut = statements(scriptCode(text));
    let error = false;
    try {
      if (cut.length > 0) {
        error = !(await c.query(cut, [25, 200])).ok;
      }
      const lines = await c.call(DUMP, 0);
      c.close();
      return [`error ${error ? 1 : 0}b`, ...(Array.isArray(lines) ? lines : [lines])].join("\n");
    } catch {
      return "exited";
    }
  } finally {
    stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/// Run `work` over `items`, `width` at a time.
async function pool(items, width, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]);
      }
    }),
  );
  return out;
}

async function agree(files) {
  const differ = (await pool(files, 4, async ([name, text]) => {
    const [load, send] = await Promise.all([loaded(text), sent(text)]);
    return load === send ? undefined : { name, text, load, send };
  })).filter((d) => d !== undefined);
  assert.deepStrictEqual(differ, []);
}

test("each trap runs as \\l runs it", { skip }, () => agree(MICRO));

const GENERATED = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) => generated(seed, 40));
for (let k = 0; k < GENERATED.length; k += 50) {
  test(`generated files ${k + 1} to ${k + 50} run as \\l runs them`, { skip }, () => agree(GENERATED.slice(k, k + 50)));
}
