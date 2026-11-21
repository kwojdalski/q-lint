// The q tasks and the `$q` problem matcher (#978), as data: what is
// detected, how a task definition is read, and the matcher's patterns -
// which `package.json` contributes and a test holds equal to these. No
// `vscode` import, so node tests it against what q prints;
// `taskprovider.ts` is the provider.
//
// q, given a script and no terminal for its input, runs the script and
// exits: 0 when it loaded, 1 at the first error, which it prints to stderr
// as the error, then one line per frame, the innermost first:
//
//   KDB-X:   '2026.11.21T19:31:44.874 type
//              [2]  /w/e_type.q:3: c:a+`x
//                                     ^
//   PeachQ:  'type
//              [1]  /w/e_type.q:3: c:a+`x
//
// The matcher reads the error and the frame under it: the message, and the
// file and line of the innermost frame - in a `\l`'d script, the loaded
// file. A frame of code typed at the console has no file and is not matched.

export const TASK_TYPE = "q" as const;

/// Where a test runner script is looked for: the names test suites are
/// usually started by, anywhere in the workspace.
export const TEST_RUNNERS = "**/{run_tests,runtests,run_all_tests,run_test,test_runner,testrunner}.q";
export const EXCLUDE = "**/{node_modules,.git}/**";

/// The problem matcher's two lines, as `package.json` declares them.
export const MATCHER = {
  name: "q",
  owner: "q-lint",
  source: "q",
  error: "^'(?:\\d{4}\\.\\d{2}\\.\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+ )?(.+?)\\r?$",
  frame: "^\\s+\\[\\d+\\]\\s+(.+?):(\\d+):(?: .*)?\\r?$",
} as const;

export interface QTaskDefinition {
  type: typeof TASK_TYPE;
  /// The script, relative to the workspace folder, or `${file}`.
  script: string;
  args?: string[];
}

/// `raw` as a q task definition, or undefined when it is not one.
export function readTaskDefinition(raw: unknown): QTaskDefinition | undefined {
  const d = raw as { type?: unknown; script?: unknown; args?: unknown } | null;
  if (d === null || typeof d !== "object" || d.type !== TASK_TYPE || typeof d.script !== "string" || d.script.trim() === "") {
    return undefined;
  }
  const args = Array.isArray(d.args) ? d.args.filter((a): a is string => typeof a === "string") : undefined;
  return { type: TASK_TYPE, script: d.script.trim(), ...(args !== undefined && args.length > 0 ? { args } : {}) };
}

export interface Detected {
  label: string;
  definition: QTaskDefinition;
  test: boolean;
}

/// The tasks offered for a folder whose test runner scripts are `runners`
/// (relative paths): one that runs the current file, and one per runner.
export function detectedTasks(runners: string[]): Detected[] {
  const sorted = [...new Set(runners.map((r) => r.replace(/\\/g, "/")))].sort();
  return [
    { label: "run current file", definition: { type: TASK_TYPE, script: "${file}" }, test: false },
    ...sorted.map((r): Detected => ({ label: `test ${r}`, definition: { type: TASK_TYPE, script: r }, test: true })),
  ];
}

export interface Problem {
  file: string;
  line: number;
  message: string;
}

/// What the matcher finds in `output`, read as VS Code reads a two-line
/// matcher: an error line and, on the next line, a frame.
export function matchProblems(output: string): Problem[] {
  const error = new RegExp(MATCHER.error);
  const frame = new RegExp(MATCHER.frame);
  const lines = output.split("\n");
  const found: Problem[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const e = error.exec(lines[i]);
    const f = e && frame.exec(lines[i + 1]);
    if (e && f) {
      found.push({ file: f[1], line: Number(f[2]), message: e[1] });
      i++;
    }
  }
  return found;
}

/// Output for a terminal: each newline a carriage return and a newline.
export function terminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/// `q-lint.tasks.enable`.
export function readTasks(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("tasks.enable", true) !== false };
}
