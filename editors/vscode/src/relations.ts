// How the workspace's q files relate, as the editor shows it: what the
// server's `q-lint/graph` and `q-lint/affectedTests` answer, turned into the
// rows of a tree and the lines of a list, and which files changed, asked of
// git. Free of any `vscode` import, like `settings.ts`, so all of it can be
// tested with plain node; `relate.ts` is the part that needs an editor.
//
// The server draws the graph and follows it. It does not know which files
// changed, because it starts no process and so cannot ask git - that is done
// here, on the client, and the answer is sent with the request.
import { isAbsolute, join, relative, sep, win32 } from "node:path";

/// What `package.json` contributes for this, by the names `relate.ts`
/// registers them under. A test holds the two together: a command declared
/// and never registered is a palette entry that fails when chosen.
export const VIEW = "q-lint.dependencies";
export const COMMANDS = {
  show: "q-lint.showDependencies",
  refresh: "q-lint.refreshDependencies",
  affectedTests: "q-lint.listAffectedTests",
};
/// The context key the view is shown under: set while the running server
/// announces `q-lint/graph`.
export const AVAILABLE = "q-lint.hasGraph";

/// The server's own requests, and where it announces them: by the method's
/// name, under `experimental` in its capabilities.
export const GRAPH = "q-lint/graph";
export const AFFECTED_TESTS = "q-lint/affectedTests";

/// Whether the server that answered `initialize` has `method`. An older one
/// does not announce it, and neither does one with `q-lint.graph.enable`
/// off - asking either would be answered with an error or with nothing.
export function announces(capabilities: unknown, method: string): boolean {
  const experimental = (capabilities as { experimental?: unknown } | undefined)?.experimental;
  return typeof experimental === "object" && experimental !== null
    ? (experimental as Record<string, unknown>)[method] === true
    : false;
}

/// What `q-lint/graph` answers for one document. `dynamic` lines count from
/// 1, as `qlinter analyze graph --detail` prints them.
export interface Graph {
  uri: string;
  dependencies: string[];
  dependents: string[];
  ambiguous: Record<string, string[]>;
  dynamic: { line: number; kind: string }[];
}

/// What `q-lint/affectedTests` answers: each test with the changed files it
/// reaches, by their place in `changed`, and the changed q files the index
/// does not hold. A test that changed has its own place there as `self`.
export interface AffectedTests {
  tests: { uri: string; reaches: number[]; self?: number }[];
  changed: string[];
  unindexed: string[];
  /// Test files not in `tests` that load by a path computed at run time.
  dynamic: string[];
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/// The answer as a `Graph`, or undefined for anything else - `null` for a
/// document the server does not index, and whatever a different server
/// might say to a method it does not know.
export function asGraph(answer: unknown): Graph | undefined {
  const g = answer as Partial<Graph> | null | undefined;
  if (!g || typeof g !== "object" || !isStrings(g.dependencies) || !isStrings(g.dependents)) {
    return undefined;
  }
  const ambiguous: Record<string, string[]> = {};
  for (const [name, files] of Object.entries(g.ambiguous ?? {})) {
    if (isStrings(files)) {
      ambiguous[name] = files;
    }
  }
  const dynamic = (Array.isArray(g.dynamic) ? g.dynamic : []).filter(
    (d) => d && typeof d.line === "number" && typeof d.kind === "string",
  );
  return {
    uri: typeof g.uri === "string" ? g.uri : "",
    dependencies: g.dependencies,
    dependents: g.dependents,
    ambiguous,
    dynamic,
  };
}

export function asAffectedTests(answer: unknown): AffectedTests | undefined {
  const a = answer as Partial<AffectedTests> | null | undefined;
  if (!a || typeof a !== "object" || !Array.isArray(a.tests) || !isStrings(a.changed)) {
    return undefined;
  }
  const tests = a.tests
    .filter(
      (t) =>
        t &&
        typeof t.uri === "string" &&
        Array.isArray(t.reaches) &&
        t.reaches.every((i) => Number.isInteger(i)),
    )
    .map((t) => ({
      uri: t.uri,
      reaches: t.reaches,
      ...(Number.isInteger(t.self) ? { self: t.self } : {}),
    }));
  return {
    tests,
    changed: a.changed,
    unindexed: isStrings(a.unindexed) ? a.unindexed : [],
    // An older server sends none.
    dynamic: isStrings(a.dynamic) ? a.dynamic : [],
  };
}

/// One row of the dependencies view. A row with a `uri` opens that file when
/// it is chosen, at `line` (from 1) when it has one.
export interface Row {
  label: string;
  description?: string;
  tooltip?: string;
  uri?: string;
  line?: number;
  children?: Row[];
}

function count(n: number, one: string, many: string): string {
  return n === 0 ? "none" : `${n} ${n === 1 ? one : many}`;
}

/// What a `dynamic` entry's kind means, in a reader's words. The kinds are
/// the server's (`Dynamic` in `src/lib.rs`); one this does not know is shown
/// as it came.
const DYNAMIC: Record<string, string> = {
  value: "value of a string",
  get: "get of a computed name",
  eval: "eval of a parse tree",
  sv: "a name built from parts",
  set: "set into a computed name",
  load: "a script loaded by a computed path",
};

/// The rows of the view for `graph`: the files the document depends on, the
/// files depending on it, and - only when there are any - the lines where it
/// reaches a name the graph cannot follow. `name` is how a file is shown,
/// which is the editor's to decide.
export function rows(graph: Graph, name: (uri: string) => string): Row[] {
  // A dependency that is one of several files defining the same name: the
  // edge is to each of them, since which definition wins is load order.
  const shared = new Map<string, string[]>();
  for (const [global, files] of Object.entries(graph.ambiguous)) {
    for (const file of files) {
      shared.set(file, [...(shared.get(file) ?? []), global]);
    }
  }
  const file = (uri: string): Row => {
    const row: Row = { label: name(uri), uri };
    const globals = shared.get(uri);
    if (globals) {
      row.description = `also defined elsewhere: ${globals.join(", ")}`;
      row.tooltip =
        `More than one file defines ${globals.join(", ")}. Which definition is ` +
        "used depends on the order the files are loaded in, which the source does not say.";
    }
    return row;
  };
  const group = (label: string, files: string[], tooltip: string): Row => ({
    label,
    description: count(files.length, "file", "files"),
    tooltip,
    children: files.map(file),
  });
  const out = [
    group("Depends on", graph.dependencies, "The files this one loads or reads a name from."),
    group(
      "Depended on by",
      graph.dependents,
      "The files that load this one or read a name it defines.",
    ),
  ];
  if (graph.dynamic.length > 0) {
    out.push({
      label: "Reached at run time",
      description: count(graph.dynamic.length, "place", "places"),
      tooltip:
        "Where this file reaches a name or a script by a value computed when it runs. " +
        "The graph cannot follow those, so the file may depend on more than is listed.",
      children: graph.dynamic.map((d) => ({
        label: `line ${d.line}`,
        description: DYNAMIC[d.kind] ?? d.kind,
        uri: graph.uri,
        line: d.line,
      })),
    });
  }
  return out;
}

/// One line of the affected-tests list: a test file, and the changed files
/// it reaches.
export interface Pick {
  label: string;
  description: string;
  uri: string;
}

/// How many changed files a line names before it says "and n more".
const NAMED = 3;

export function picks(result: AffectedTests, name: (uri: string) => string): Pick[] {
  const reaching = result.tests.map((test) => {
    // Which of the changed files is the test itself is the server's to say:
    // a test's `uri` is the server's spelling where the editor has not
    // opened the file, and `changed` is this client's, which differ as text
    // on a drive letter or through a link. A server from before it said so
    // is taken at the spelling.
    const own = test.self ?? test.reaches.find((i) => result.changed[i] === test.uri);
    const reached = test.reaches
      .filter((i) => i !== own)
      .map((i) => result.changed[i])
      .filter((uri): uri is string => typeof uri === "string")
      .map(name);
    const changed = own !== undefined;
    const named = reached.slice(0, NAMED).join(", ");
    const more = reached.length > NAMED ? ` and ${reached.length - NAMED} more` : "";
    const reaches = reached.length > 0 ? `reaches ${named}${more}` : "";
    return {
      label: name(test.uri),
      description: [changed ? "changed" : "", reaches].filter(Boolean).join("; "),
      uri: test.uri,
    };
  });
  // After them, the tests no edge places: listed, since one left out costs
  // a regression.
  const computed = result.dynamic.map((uri) => ({
    label: name(uri),
    description: "loads by a path computed at run time: may be affected",
    uri,
  }));
  return [...reaching, ...computed];
}

/// One sentence over the list: how many tests reach how many changed q
/// files, and - since a list that looked complete would mislead - how many
/// changed q files the server could not follow, with why, and how many test
/// files load by a path computed at run time, which no list can place.
export function summary(result: AffectedTests): string {
  const tests = count(result.tests.length, "test file reaches", "test files reach");
  const changed = count(result.changed.length, "changed q file", "changed q files");
  const head =
    result.tests.length === 0
      ? `No test file reaches the ${changed}.`
      : `${tests} the ${changed}.`;
  const n = result.unindexed.length;
  const gap =
    n === 0
      ? ""
      : ` ${n} changed q ${n === 1 ? "file is" : "files are"} not in the index` +
        ` (deleted or excluded): what depended on ${n === 1 ? "it" : "them"} is not listed.`;
  const d = result.dynamic.length;
  const computed =
    d === 0
      ? ""
      : ` ${d} more test ${d === 1 ? "file loads" : "files load"} by a path computed at run` +
        ` time and may be affected too.`;
  return (result.changed.length === 0 ? "No indexed q file changed." : head) + gap + computed;
}

/// The names in the output of a git command run with `-z`: separated by NUL,
/// and so never quoted, whatever a file is called.
export function names(output: string): string[] {
  return output.split("\0").filter((name) => name !== "");
}

/// Runs git with `args` in `cwd` and resolves to what it printed. The
/// extension's runs the `git` binary without a shell; a test's runs nothing.
export type Git = (args: string[], cwd: string) => Promise<string>;

/// What is asked of git, in `folder`: the files that differ from HEAD,
/// staged or not, and the files it does not track and is not told to
/// ignore. Both relative to `folder` and limited to it, which is all the
/// server indexes; `--` ends the revisions, so nothing in the tree can be
/// read as one. A renamed file is listed under both names: what read the
/// old one is affected too, and the server says it cannot follow a file
/// that is gone, where leaving the old name out would say nothing.
export const CHANGED = [
  ["diff", "--name-only", "--no-renames", "--relative", "-z", "HEAD", "--"],
  ["ls-files", "--others", "--exclude-standard", "-z"],
];

/// The files under `folder` changed against git HEAD, as absolute paths,
/// each once. Rejects with git's own error where `folder` is in no
/// repository, the repository has no commit yet, or there is no git.
export async function changedFiles(git: Git, folder: string): Promise<string[]> {
  const listed = await Promise.all(CHANGED.map((args) => git(args, folder)));
  return [...new Set(listed.flatMap(names))].map((name) => join(folder, name));
}

/// Of the unsaved files `dirty`, those in one of `folders`: the folders git
/// said what changed in. One elsewhere - a scratch file opened from outside
/// the workspace - differs from no HEAD, and the server, which indexes the
/// workspace, would call it a changed file it cannot follow.
export function unsavedIn(dirty: string[], folders: string[]): string[] {
  return dirty.filter((file) =>
    folders.some((folder) => {
      const rel = relative(folder, file);
      // `..scratch.q` is a name in the folder, not a step out of it (#1101).
      return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    }),
  );
}

/// The file `binary` is run as. Anything but a bare name on Windows is
/// itself: a path names its file, and elsewhere a bare name is looked up on
/// `PATH` and nowhere else. On Windows a bare name is looked for in the
/// directory the program is started in before `PATH` - and that directory is
/// the workspace folder, so a `git.exe` checked in there would be what ran.
/// There the name is found here instead, in the absolute directories of
/// `path` and with the two extensions a bare name is tried with; undefined
/// where none of them holds it.
export function onPath(
  binary: string,
  path: string | undefined,
  exists: (file: string) => boolean,
  platform: string = process.platform,
): string | undefined {
  if (platform !== "win32" || /[\\/]/.test(binary)) {
    return binary;
  }
  const endings = win32.extname(binary) === "" ? [".com", ".exe"] : [""];
  for (const entry of (path ?? "").split(";")) {
    // An entry may be quoted, as libuv reads it too.
    const dir = entry.replace(/"/g, "");
    // An entry that is not absolute is read against the directory the
    // program starts in, which is the one being kept out.
    if (!win32.isAbsolute(dir)) {
      continue;
    }
    for (const ending of endings) {
      const file = win32.join(dir, binary + ending);
      if (exists(file)) {
        return file;
      }
    }
  }
  return undefined;
}

/// Whether a path is one the server reads: a `.q` file.
export function isQ(path: string): boolean {
  return path.toLowerCase().endsWith(".q");
}

/// The git to run: VS Code's own `git.path` where the user set one - a path,
/// or a list of which the first is taken - and `git` from `PATH` otherwise.
export function gitBinary(setting: unknown): string {
  const first: unknown = Array.isArray(setting) ? setting[0] : setting;
  return typeof first === "string" && first.trim() !== "" ? first.trim() : "git";
}
