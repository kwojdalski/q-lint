// Generate a test stub (#982), as data: the function under the cursor, the
// style of the test file it goes in, and the stub. Free of any `vscode`
// import, so node tests it; `teststubview.ts` offers the code action and
// writes the file.
//
// The style is read from the test file the stub goes in, or another of the
// workspace's when it is new:
// - `.qt` suites (`.qt.<suite>.test_x:{[] ...}`, as uqf's are): the stub
//   joins the first suite the file defines;
// - qUnit (`testName` functions, `.qunit.assert...`): `testName`, under
//   whatever `\d` the file ends in;
// - otherwise `test_name`, as the **Run test** lens finds it.
// The body asserts with `.qunit.assertEquals` where the file already does,
// and otherwise answers `actual~expected`, which the Test Explorer reads as
// passed or failed. Its arguments and the expected value are `(::)`, marked
// to be filled in: the stub fails until they are.
import { definitions } from "./definitions";
import { globLiteral } from "./globliteral";
import { argumentNames, codeMask, lambdas } from "./paramcache";
import { blockDepth, contextAfter, scriptCode, statements, trimBlanks } from "./statements";

export const TEST_STUB_COMMAND = "q-lint.generateTestStub";

export interface Target {
  /// The name with its context: `f`, `.ns.f`.
  name: string;
  params: string[];
}

/// The function whose definition holds 0-based `line` of `text`, when that
/// is a function definition and not itself a test. `path`, the file's in
/// its workspace, names a KDB-X module's function in its context (#2917).
export function functionAt(text: string, line: number, path?: string): Target | undefined {
  const def = definitions(text, path).find((d) => d.line <= line && line <= d.endLine);
  if (def === undefined) {
    return undefined;
  }
  // A test, by the conventions' names - `test_x`, qUnit's `testX` - and not
  // a function whose name merely starts so: testable, tester (#2411).
  const short = def.name.split(".").pop() ?? def.name;
  if (/^test(?:_|[A-Z]|$)/.test(short)) {
    return undefined;
  }
  const mask = codeMask(def.text);
  const lambda = lambdas(def.text, mask)[0];
  // One argument per slot q takes, a pattern's named `arg1`...: KDB-X's
  // `{[(u;v);w] u+v+w}` takes two, and `{[n:{x>0}] n}` one, `n` (#2332).
  return lambda === undefined ? undefined : { name: def.name, params: argumentNames(def.text, lambda, mask) };
}

export interface Style {
  naming: { kind: "qt"; suite: string } | { kind: "qunit" } | { kind: "plain" };
  qunitAsserts: boolean;
}

/// The style of a test file's text: of the statements q runs of it, so a
/// test commented out, in a block comment or after the script's end, sets
/// none (#2909).
export function detectStyle(file: string): Style {
  const text = statements(scriptCode(file)).join("\n");
  const qunitAsserts = /\.qunit\.assert/.test(text);
  const qt = /^(\.qt(?:\.[A-Za-z][A-Za-z0-9_]*)+)\.test_[A-Za-z0-9_]*\s*:/m.exec(text);
  if (qt !== null) {
    return { naming: { kind: "qt", suite: qt[1] }, qunitAsserts };
  }
  if (qunitAsserts || /^test[A-Z][A-Za-z0-9_]*\s*:\s*\{/m.test(text)) {
    return { naming: { kind: "qunit" }, qunitAsserts };
  }
  return { naming: { kind: "plain" }, qunitAsserts };
}

/// The test's name for `target` in `style`, not one of `taken`'s.
export function testName(target: Target, style: Style, taken: string): string {
  const short = target.name.split(".").pop() ?? target.name;
  const base =
    style.naming.kind === "qt"
      ? `${style.naming.suite}.test_${short}`
      : style.naming.kind === "qunit"
        ? `test${short[0].toUpperCase()}${short.slice(1)}`
        : `test_${short}`;
  const used = (name: string): boolean => new RegExp(`^${name.replace(/\./g, "\\.")}\\s*:`, "m").test(taken);
  let name = base;
  for (let n = 2; used(name); n++) {
    name = `${base}${n}`;
  }
  return name;
}

/// The stub: a test of `target` named `name`. The expected value's local
/// is named apart from the arguments: one named `expected` is not
/// overwritten by it (#1601).
///
/// `context` is the `\d` the stub is appended under: under one that is not
/// the root, a root function is called as `` `.[`f] ``, since a lambda's
/// globals resolve in the context it is defined in (#1599). So is one a
/// parameter of its own is named after (`scale:{[scale;v] ...}`): the
/// argument's local would be what the bare name called (#2004).
export function stubText(target: Target, name: string, style: Style, context = "."): string {
  const callee =
    (context !== "." || target.params.includes(target.name)) && !target.name.startsWith(".") ? `\`.[\`${target.name}]` : target.name;
  const call = `${callee}[${target.params.join(";")}]`;
  let expected = "expected";
  while (target.params.includes(expected)) {
    expected += "_";
  }
  const lines = [`${name}:{[]`];
  if (target.params.length > 0) {
    lines.push(`  ${target.params.map((p) => `${p}:(::);`).join(" ")} / TODO: the arguments`);
  }
  lines.push(`  ${expected}:(::); / TODO: what ${call} should give`);
  lines.push(style.qunitAsserts ? `  .qunit.assertEquals[${call};${expected};"${target.name}"]}` : `  ${call}~${expected}}`);
  return `${lines.join("\n")}\n`;
}

/// The context a script's text ends in: its last `\d .ns`, or `.`. As q
/// runs it, so a `\d` in a block comment or after the script's end is none,
/// and a `system "d .ns"` is one (#2909).
export function endContext(text: string): string {
  return contextAfter(scriptCode(text));
}

/// The 0-based line of `text`, a test file's, from which q reads none of
/// it: the `\` alone that ends the script, or the `/` alone that opens a
/// block comment nothing closes. A test added there, at the file's end, is
/// never defined, so it goes before that line (#2908). Undefined when q
/// reads the text to its end.
export function unreadFrom(text: string): number | undefined {
  let depth = 0;
  let opened = 0;
  for (const [i, raw] of text.split("\n").entries()) {
    const line = trimBlanks(raw);
    if (depth === 0 && line === "\\") {
      return i;
    }
    opened = depth === 0 ? i : opened;
    depth = blockDepth(depth, line);
  }
  return depth > 0 ? opened : undefined;
}

/// Where a new test file for `source` (a path) goes: `tests/test_<name>.q`
/// under the workspace folder when it has a `tests` folder, else beside it.
/// Either separator is one: an `fsPath` on Windows uses `\` (#1094).
export function newTestPath(source: string, folder: string | undefined, hasTests: boolean): string {
  const cut = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  const base = (source.slice(cut + 1) || "x.q").replace(/\.q$/, "");
  const name = `test_${base}.q`;
  if (folder !== undefined && hasTests) {
    const sep = folder.includes("\\") ? "\\" : "/";
    return `${folder.replace(/[\\/]$/, "")}${sep}tests${sep}${name}`;
  }
  return `${source.slice(0, cut + 1)}${name}`;
}

/// The test files that may already be `source`'s: `test_<name>.q` or
/// `<name>_test.q`, as glob patterns, the name matched as written.
export function testFilePatterns(source: string): string[] {
  const base = globLiteral((source.split(/[\\/]/).pop() ?? "").replace(/\.q$/, ""));
  return [`**/test_${base}.q`, `**/${base}_test.q`];
}
