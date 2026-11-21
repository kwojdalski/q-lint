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
import { codeMask, lambdas, parameters } from "./paramcache";

export const TEST_STUB_COMMAND = "q-lint.generateTestStub";

export interface Target {
  /// The name with its context: `f`, `.ns.f`.
  name: string;
  params: string[];
}

/// The function whose definition holds 0-based `line` of `text`, when that
/// is a function definition and not itself a test.
export function functionAt(text: string, line: number): Target | undefined {
  const def = definitions(text).find((d) => d.line <= line && line <= d.endLine);
  if (def === undefined) {
    return undefined;
  }
  const short = def.name.split(".").pop() ?? def.name;
  if (/^test/.test(short)) {
    return undefined;
  }
  const mask = codeMask(def.text);
  const lambda = lambdas(def.text, mask)[0];
  return lambda === undefined ? undefined : { name: def.name, params: parameters(def.text, lambda, mask) };
}

export interface Style {
  naming: { kind: "qt"; suite: string } | { kind: "qunit" } | { kind: "plain" };
  qunitAsserts: boolean;
}

/// The style of a test file's text.
export function detectStyle(text: string): Style {
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

/// The stub: a test of `target` named `name`.
export function stubText(target: Target, name: string, style: Style): string {
  const call = `${target.name}[${target.params.join(";")}]`;
  const lines = [`${name}:{[]`];
  if (target.params.length > 0) {
    lines.push(`  ${target.params.map((p) => `${p}:(::);`).join(" ")} / TODO: the arguments`);
  }
  lines.push(`  expected:(::); / TODO: what ${call} should give`);
  lines.push(style.qunitAsserts ? `  .qunit.assertEquals[${call};expected;"${target.name}"]}` : `  ${call}~expected}`);
  return `${lines.join("\n")}\n`;
}

/// Where a new test file for `source` (a path) goes: `tests/test_<name>.q`
/// under the workspace folder when it has a `tests` folder, else beside it.
export function newTestPath(source: string, folder: string | undefined, hasTests: boolean): string {
  const parts = source.split("/");
  const base = (parts.pop() ?? "x.q").replace(/\.q$/, "");
  const name = `test_${base}.q`;
  return folder !== undefined && hasTests ? `${folder.replace(/\/$/, "")}/tests/${name}` : [...parts, name].join("/");
}

/// The test files that may already be `source`'s: `test_<name>.q` or
/// `<name>_test.q`, as glob patterns.
export function testFilePatterns(source: string): string[] {
  const base = (source.split(/[\\/]/).pop() ?? "").replace(/\.q$/, "");
  return [`**/test_${base}.q`, `**/${base}_test.q`];
}
