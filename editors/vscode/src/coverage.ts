// Line coverage of q tests (#979), as data: which of the workspace's
// functions to instrument, and the counts read back as coverage by file.
// Free of any `vscode` import, so node tests it; `testexplorer.ts` runs the
// Coverage profile around a test run.
//
// A function is instrumented only when the process holds it with the text
// a workspace file defines it with (compared as drift detection compares,
// without trailing blanks): one changed since it was loaded, or never
// loaded, is left alone, since its lines would not be the file's. A name
// two files define is instrumented from the first whose text matches. Each
// statement of a function's own body is one counted statement, from its
// first character to its last; a nested lambda counts as part of the
// statement it is in.
import { definitions, normalized, type ProcessState } from "./definitions";
import { coverageText, positionIn, type Pos } from "./instrument";

export interface SourceFile {
  /// The file's URI, as a string.
  uri: string;
  text: string;
}

/// One counted statement: where it is, and the function it is in.
export interface Probe {
  uri: string;
  start: Pos;
  end: Pos;
  name: string;
}

export interface CoveragePlan {
  /// What INSTALL is sent: names, the text the process holds, the
  /// instrumented text.
  names: string[];
  was: string[];
  src: string[];
  /// Probe `k` counts into `.qlint.cov.d[k]`.
  probes: Probe[];
  /// Functions left alone, and why.
  skipped: { name: string; why: "missing" | "changed" }[];
}

/// The names each file defines, in order, each once.
export function definedNames(files: SourceFile[]): string[] {
  return [...new Set(files.flatMap((f) => definitions(f.text).map((d) => d.name)))];
}

/// What to instrument, given what the process holds of each name.
export function coveragePlan(files: SourceFile[], states: Map<string, ProcessState>): CoveragePlan {
  const plan: CoveragePlan = { names: [], was: [], src: [], probes: [], skipped: [] };
  const seen = new Set<string>();
  const skipped = new Map<string, "missing" | "changed">();
  for (const file of files) {
    const lines = file.text.split("\n");
    for (const def of definitions(file.text)) {
      if (seen.has(def.name)) {
        continue;
      }
      const state = states.get(def.name);
      if (state === undefined || state.state !== "lambda") {
        skipped.set(def.name, "missing");
        continue;
      }
      if (normalized(state.text) !== normalized(def.text)) {
        skipped.set(def.name, "changed");
        continue;
      }
      const covered = coverageText(def.text, plan.probes.length);
      if (covered === undefined) {
        continue;
      }
      seen.add(def.name);
      skipped.delete(def.name);
      const at = { line: def.line, character: Math.max(0, (lines[def.line] ?? "").indexOf("{")) };
      plan.names.push(def.name);
      plan.was.push(state.text);
      plan.src.push(covered.text);
      for (const s of covered.statements) {
        plan.probes.push({ uri: file.uri, start: positionIn(def.text, s.start, at), end: positionIn(def.text, s.end, at), name: def.name });
      }
    }
  }
  plan.skipped = [...skipped].map(([name, why]) => ({ name, why }));
  return plan;
}

export interface CountedStatement {
  start: Pos;
  end: Pos;
  count: number;
}

/// The counts read back, by file: only the functions `installed` names
/// (those INSTALL answered `ok` for), in the order of the files.
export function coverageByFile(plan: CoveragePlan, counts: unknown, installed: Set<string>): Map<string, CountedStatement[]> {
  const list = Array.isArray(counts) ? counts.map(Number) : [];
  const out = new Map<string, CountedStatement[]>();
  plan.probes.forEach((probe, k) => {
    if (!installed.has(probe.name)) {
      return;
    }
    const count = Number.isFinite(list[k]) ? list[k] : 0;
    const file = out.get(probe.uri) ?? [];
    file.push({ start: probe.start, end: probe.end, count });
    out.set(probe.uri, file);
  });
  return out;
}

/// One line saying what was covered: statements run of those counted.
export function coverageSummary(byFile: Map<string, CountedStatement[]>, functions: number): string {
  const all = [...byFile.values()].flat();
  const run = all.filter((s) => s.count > 0).length;
  const share = all.length === 0 ? 0 : Math.round((1000 * run) / all.length) / 10;
  return `Coverage: ${run} of ${all.length} statements run (${share}%) in ${functions} function${functions === 1 ? "" : "s"} across ${byFile.size} file${byFile.size === 1 ? "" : "s"}.`;
}
