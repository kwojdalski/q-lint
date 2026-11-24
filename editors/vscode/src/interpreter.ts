// The q interpreter picker's data (#974): where q binaries are found on
// this machine, the variables a binary's own layout needs, and what a
// version probe printed. No `vscode` import and every file system read
// through `Files`, so node tests it on fake directories;
// `interpreterview.ts` is the status bar item and the picker.
//
// A binary is found in four places, in this order: KDB-X's install
// (`~/.kx/bin/q`), a kdb+ `QHOME` (`$QHOME/<arch>/q`, and `~/q` when
// `QHOME` is unset), each folder of `PATH`, and a workspace folder - its
// root or its `bin/` - where a PeachQ-style build keeps its `q`. One file
// reached twice (`~/.kx/bin` on `PATH`) is listed once, under the first.
import * as path from "node:path";

/// The file system reads discovery makes: the only ones it makes.
export interface Files {
  /// Whether `file` is a file this user may run.
  executable(file: string): boolean;
  /// Whether `file` exists, file or folder.
  exists(file: string): boolean;
  /// `file` with its links resolved; `file` itself when that fails.
  real(file: string): string;
}

export type Source = "kdbx" | "qhome" | "path" | "workspace";

export interface Interpreter {
  /// The binary, as found.
  path: string;
  source: Source;
  /// What the picker shows next to the path: where it was found.
  detail: string;
}

/// kdb+'s per-platform folders under `QHOME`, the 64-bit ones first.
export const ARCH_DIRS = ["m64arm", "m64", "l64arm", "l64", "w64", "s64", "v64", "m32", "l32", "w32", "s32", "v32"];

export interface Where {
  env: Record<string, string | undefined>;
  home: string;
  platform: string;
  /// The workspace folders, as paths.
  folders: string[];
}

/// Every q binary found, without running one.
export function discover(where: Where, files: Files): Interpreter[] {
  const exe = where.platform === "win32" ? ["q.exe"] : ["q"];
  const found: Interpreter[] = [];
  const seen = new Set<string>();
  const add = (file: string, source: Source, detail: string): void => {
    if (!files.executable(file)) {
      return;
    }
    const real = files.real(file);
    if (seen.has(real)) {
      return;
    }
    seen.add(real);
    found.push({ path: file, source, detail });
  };
  const join = where.platform === "win32" ? path.win32.join : path.posix.join;
  const kx = join(where.home, ".kx");
  for (const name of exe) {
    add(join(kx, "bin", name), "kdbx", "KDB-X (~/.kx)");
  }
  const qhome = where.env.QHOME?.trim();
  const homes = qhome ? [qhome] : [join(where.home, "q")];
  for (const home of homes) {
    const label = qhome ? `QHOME (${home})` : "kdb+ (~/q)";
    for (const name of exe) {
      // A KDB-X install named by QHOME keeps its binary in bin/.
      add(join(home, "bin", name), "qhome", label);
      for (const arch of ARCH_DIRS) {
        add(join(home, arch, name), "qhome", label);
      }
    }
  }
  const separator = where.platform === "win32" ? ";" : ":";
  for (const entry of (where.env.PATH ?? where.env.Path ?? "").split(separator)) {
    // A Windows entry may be quoted, as libuv reads it too (#1681).
    const dir = where.platform === "win32" ? entry.replace(/"/g, "") : entry;
    if (dir.trim() === "") {
      continue;
    }
    for (const name of [...exe, ...(where.platform === "win32" ? ["peachq.exe"] : ["peachq"])]) {
      add(join(dir, name), "path", "on PATH");
    }
  }
  for (const folder of where.folders) {
    for (const name of [...exe, ...(where.platform === "win32" ? ["peachq.exe"] : ["peachq"])]) {
      add(join(folder, name), "workspace", `workspace folder ${path.basename(folder)}`);
      add(join(folder, "bin", name), "workspace", `workspace folder ${path.basename(folder)}`);
    }
  }
  return found;
}

/// The variables `binary` needs from where it lies, so that picking one
/// does not leave it reading another install's files through a `QHOME` your
/// shell set for a different q. A kdb+ binary in `<home>/<arch>/` with
/// `<home>/q.k` gets `QHOME=<home>`; a KDB-X one in `<home>/bin/` with
/// `<home>/q/` and a licence in `<home>` gets `QHOME=<home>/q` and
/// `QLIC=<home>`, as KX's installer lays it out. Anything else: none, and q
/// reads what the environment says.
export function layoutEnv(binary: string, files: Files): Record<string, string> {
  // A Windows path by drive letter or on a UNC share (\\server\share).
  const p = /^([A-Za-z]:[\\/]|\\\\)/.test(binary) ? path.win32 : path.posix;
  if (!p.isAbsolute(binary)) {
    return {};
  }
  const dir = p.dirname(binary);
  const home = p.dirname(dir);
  const parent = p.basename(dir);
  if (ARCH_DIRS.includes(parent) && files.exists(p.join(home, "q.k"))) {
    return { QHOME: home };
  }
  if (parent === "bin" && files.exists(p.join(home, "q")) && LICENCE_FILES.some((f) => files.exists(p.join(home, f)))) {
    return { QHOME: p.join(home, "q"), QLIC: home };
  }
  return {};
}

/// The licence files q reads, the one it prefers first: `kc.lic` wins over
/// `k4.lic` when both are there, as KX documents.
export const LICENCE_FILES = ["kc.lic", "k4.lic", "kx.lic"];

/// The licence file `binary` reads with `env`: in `QLIC`, else `QHOME`,
/// else `~/q`, and for a KDB-X binary in `<home>/bin/` also `<home>`.
/// Only located: its contents are not read here or anywhere.
export function licenceFile(binary: string, env: Record<string, string | undefined>, home: string, files: Files): string | undefined {
  const dirs: string[] = [];
  if (env.QLIC?.trim()) {
    dirs.push(env.QLIC.trim());
  }
  if (env.QHOME?.trim()) {
    dirs.push(env.QHOME.trim());
  }
  if (path.isAbsolute(binary) && path.basename(path.dirname(binary)) === "bin") {
    dirs.push(path.dirname(path.dirname(binary)));
  }
  dirs.push(path.join(home, "q"));
  for (const dir of dirs) {
    for (const name of LICENCE_FILES) {
      const file = path.join(dir, name);
      if (files.exists(file)) {
        return file;
      }
    }
  }
  return undefined;
}

/// What the probe sends to the binary's stdin: its version, release date
/// and platform, and the licence's expiry date - `.z.l`'s second item, as
/// code.kx.com documents `.z.l` - or nothing where `.z.l` is empty. Then it
/// exits. Nothing else of `.z.l` (the banner text names the licensee) is
/// printed.
export const PROBE = '-1 "QLINTVER|",(string .z.K),"|",(string .z.k),"|",(string .z.o),"|",$[1<count .z.l;.z.l 1;""];exit 0\n';

export interface Probe {
  /// `.z.K`, as q prints it: `4.1`, `5`.
  major: string;
  /// `.z.k`: `2024.10.16`.
  release: string;
  /// `.z.o`: `m64`.
  os: string;
  /// The licence's expiry date, `yyyy.mm.dd`, when q told it.
  expiry?: string;
}

const DATE = /^\d{4}\.\d{2}\.\d{2}$/;

/// The probe's answer in `output`, or undefined when q did not print one -
/// it failed to start, or found no licence.
export function readProbe(output: string): Probe | undefined {
  const line = output.split(/\r?\n/).find((l) => l.startsWith("QLINTVER|"));
  if (line === undefined) {
    return undefined;
  }
  const [, major, release, os, expiry] = line.trimEnd().split("|");
  if (!major || !release) {
    return undefined;
  }
  return { major, release, os: os ?? "", ...(expiry && DATE.test(expiry) && validDate(expiry) ? { expiry } : {}) };
}

/// Whether `yyyy.mm.dd` names a day of the calendar.
function validDate(text: string): boolean {
  const [y, m, d] = text.split(".").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/// What the status bar says for `probe`: `q 4.1 2024.10.16`.
export function versionText(probe: Probe): string {
  return `q ${probe.major} ${probe.release}`;
}

/// Whole days from `today` to `expiry` (`yyyy.mm.dd`), negative once past;
/// undefined for anything that is not a date.
export function daysLeft(expiry: string, today: Date): number | undefined {
  if (!DATE.test(expiry) || !validDate(expiry)) {
    return undefined;
  }
  const [y, m, d] = expiry.split(".").map(Number);
  const end = Date.UTC(y, m - 1, d);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((end - start) / 86_400_000);
}

/// The warning for `days` left, or undefined when it is more than `within`.
export function expiryWarning(binary: string, expiry: string, days: number, within: number): string | undefined {
  if (days > within) {
    return undefined;
  }
  if (days < 0) {
    return `q-lint: the q licence used by ${binary} expired on ${expiry}.`;
  }
  if (days === 0) {
    return `q-lint: the q licence used by ${binary} expires today (${expiry}).`;
  }
  return `q-lint: the q licence used by ${binary} expires on ${expiry}, in ${days} day${days === 1 ? "" : "s"}.`;
}

export const INTERPRETER_COMMANDS = {
  select: "q-lint.selectInterpreter",
  checkLicence: "q-lint.checkLicence",
} as const;

/// `q-lint.interpreter.enable`, `q-lint.licence.expiryWarning.enable` and
/// `q-lint.licence.warningDays` (0 to 365).
export function readInterpreter(get: <T>(key: string, fallback: T) => T): { enabled: boolean; licence: boolean; warningDays: number } {
  const days = get<unknown>("licence.warningDays", 30);
  return {
    enabled: get<unknown>("interpreter.enable", true) !== false,
    licence: get<unknown>("licence.expiryWarning.enable", true) !== false,
    warningDays: typeof days === "number" && Number.isFinite(days) ? Math.max(0, Math.min(365, Math.floor(days))) : 30,
  };
}
