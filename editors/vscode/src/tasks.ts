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
//
// An error inside a q keyword, a `.Q` function or evaluated text has frames
// of q's own first, which name no file, and the script's only under them:
//
//   KDB-X:   '2026.11.24T17:28:12.188 type
//              [3]  (.q.til)
//
//              [2]  /w/e.q:1: r:til "a"
//
// A matcher's patterns are one line each, and only its last may repeat, so
// none reads past those frames. A q task writes the error line again above
// the first frame that names a file (`matchable`), where the two lines are
// read as any other error's (#2001).

import * as path from "node:path";

export const TASK_TYPE = "q" as const;

/// Where a task runs `script` (its `~` expanded): in `folder`, the task's
/// workspace folder, with the script resolved against it; for a task of the
/// workspace (a `.code-workspace` file), which has none, the script resolved
/// against `first`, the first workspace folder, run in its own directory
/// (#1414). Undefined: a relative script with no folder to resolve it in.
export function taskPaths(script: string, folder: string | undefined, first: string | undefined): { cwd: string; script: string } | undefined {
  if (folder !== undefined) {
    return { cwd: folder, script: path.resolve(folder, script) };
  }
  if (!path.isAbsolute(script) && first === undefined) {
    return undefined;
  }
  const resolved = path.resolve(first ?? "", script);
  return { cwd: path.dirname(resolved), script: resolved };
}

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

/// A frame that names no file, or the line under a frame: its caret, or
/// nothing under a keyword's.
const BETWEEN = /^\s+\[\d+\]\s|^\s*\^?\s*$/;

/// What q prints to stderr, as the matcher can read it: `push` gives the
/// text to write for the text that arrived, and `end` what is left at the
/// close. All of it is q's, in its order and as it arrives; an error whose
/// first frames name no file has its line written again above the first
/// frame that does (#2001). Only the start of a line that may be that frame
/// waits for its end.
export function matchable(): { push(text: string): string; end(): string } {
  const isError = new RegExp(MATCHER.error);
  const isFrame = new RegExp(MATCHER.frame);
  // The last error line, while no frame under it has named a file, and
  // whether a frame has come between.
  let error: string | undefined;
  let between = false;
  // The start of the line being read.
  let start = "";
  const line = (whole: string): string => {
    const text = whole.slice(0, -1);
    if (error !== undefined) {
      if (isFrame.test(text)) {
        const again = between ? error : "";
        error = undefined;
        return again + whole;
      }
      if (BETWEEN.test(text)) {
        between = true;
        return whole;
      }
      error = undefined;
    }
    if (isError.test(text)) {
      error = whole;
      between = false;
    }
    return whole;
  };
  return {
    push: (text) => {
      let out = "";
      for (const piece of text.split(/(?<=\n)/)) {
        const written = error === undefined ? start : "";
        if (piece.endsWith("\n")) {
          out += line(start + piece).slice(written.length);
          start = "";
        } else {
          out += error === undefined ? piece : "";
          start += piece;
        }
      }
      return out;
    },
    end: () => {
      const left = error === undefined ? "" : start;
      error = undefined;
      start = "";
      return left;
    },
  };
}

/// Output for a terminal: each newline a carriage return and a newline.
export function terminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/// `q-lint.tasks.enable`.
export function readTasks(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("tasks.enable", true) !== false };
}
