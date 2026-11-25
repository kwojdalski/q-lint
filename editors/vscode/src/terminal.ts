// The q terminal's pure parts: the command line that starts q, the env file
// loaded into it, and code made into lines its console reads.
//
// q's console reads one line per statement, where a script reads a statement
// and its indented continuation lines. In a script the newline before a
// continuation line is whitespace - `{a:1\n  b:2}` is `{a:1 b:2}`, and fails
// as that does - so the lines of a statement are joined with a space, as long
// as nothing on one of them depends on the end of the line: a trailing
// comment would swallow the rest, so it is cut, and a string that runs onto
// the next line keeps the newline as `\n`.
import * as path from "node:path";
import { statements } from "./statements";

/// Where a q terminal starts: the workspace folder holding `file`, else the
/// file's own directory - a file outside every folder started in the first,
/// and its relative `\l` read another folder's (#1535) - and with no file
/// (the REPL), `first`, the first folder.
export function terminalCwd(own: string | undefined, first: string | undefined, file: string | undefined, dirname: (p: string) => string): string | undefined {
  if (own !== undefined) {
    return own;
  }
  return file !== undefined ? dirname(file) : first;
}

/// How the shell in the terminal reads a command line.
export type Shell = "posix" | "csh" | "fish" | "powershell" | "cmd";

/// The shell a terminal runs, from its path: PowerShell, cmd, csh/tcsh and
/// fish by name, and anything else - bash, zsh, Git Bash on Windows - read
/// as POSIX.
export function shellKind(path: string | undefined): Shell {
  const name = (path ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) {
    return "powershell";
  }
  if (/^cmd(\.exe)?$/.test(name)) {
    return "cmd";
  }
  if (/^t?csh$/.test(name)) {
    return "csh";
  }
  // fish reads \' and \\ inside single quotes as escapes (#1832).
  if (/^fish(\.exe)?$/.test(name)) {
    return "fish";
  }
  return "posix";
}

/// The characters each shell reads as themselves, so a word made only of
/// them is passed as it is. PowerShell reads `,` as an array and `@` as a
/// splat, and on Windows a backslash is a path separator, not an escape.
/// zsh reads a word that starts with `=` as `=name`, the path of a command.
const PLAIN: Record<Shell, RegExp> = {
  posix: /^[A-Za-z0-9_\/.,:@%+-][A-Za-z0-9_\/.,:@%+=-]*$/,
  csh: /^[A-Za-z0-9_\/.,:@%+-][A-Za-z0-9_\/.,:@%+=-]*$/,
  fish: /^[A-Za-z0-9_\/.,:@+-][A-Za-z0-9_\/.,:@%+=-]*$/,
  powershell: /^[A-Za-z0-9_\\/.:+=-]+$/,
  cmd: /^[A-Za-z0-9_\\/.:+=-]+$/,
};

/// `text` in PowerShell's single quotes, where only a quote is special and
/// doubling it escapes it. The typographic quotes count as quotes there.
function powershellLiteral(text: string): string {
  return `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
}

/// `word` as `shell` reads one argument.
export function quote(word: string, shell: Shell): string {
  // PowerShell splits a bare `-x.y` at its dot into `-x` and `.y` (#1677).
  if (PLAIN[shell].test(word) && !(shell === "powershell" && /^-.*\./.test(word))) {
    return word;
  }
  if (shell === "posix") {
    return `'${word.replace(/'/g, `'\\''`)}'`;
  }
  if (shell === "csh") {
    // csh reads `!` as history even in single quotes, unless escaped.
    return `'${word.replace(/'/g, `'\\''`).replace(/!/g, "\\!")}'`;
  }
  if (shell === "fish") {
    // Inside fish's single quotes a backslash escapes a quote or itself.
    return `'${word.replace(/[\\']/g, "\\$&")}'`;
  }
  if (shell === "powershell") {
    return powershellLiteral(word);
  }
  // cmd passes the line to the program, whose C runtime splits it: inside
  // double quotes a quote is escaped with a backslash, and backslashes
  // before a quote - or before the closing one - are doubled. cmd itself
  // reads every quote as one, and `%NAME%` inside quotes too, so
  // `commandLine` refuses a word with either before it gets here.
  return `"${word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/// The line that starts `binary` with `args` in `shell`, with `env` set
/// for it. The variables are on the line rather than in the terminal's
/// environment because the shell's startup files run in between: a
/// `.zshrc` that exports `QHOME` would otherwise win over the env file.
/// PowerShell runs a quoted command only through `&`. cmd has no escape for
/// a `"` or a `%` inside quotes - its `\"` ends the quoted part, so what
/// follows is read as commands, and `%NAME%` is expanded (#1274) - so a
/// word or value with either, or with a line break, is refused there; and
/// PowerShell is refused a word with a `"`, an empty word, and a spaced
/// one ending in a backslash.
/// `refs` sets each of its names from the variable it maps it to, which the
/// terminal's environment holds, so the value is not on the line.
export function commandLine(
  binary: string,
  args: string[],
  shell: Shell,
  env: Record<string, string> = {},
  refs: Record<string, string> = {},
): string | { error: string } {
  if (shell === "cmd") {
    const bad = [binary, ...args, ...Object.entries(env).map(([n, v]) => `${n}=${v}`)].find((w) => /["%\r\n]/.test(w));
    if (bad !== undefined) {
      return { error: `cmd cannot pass ${JSON.stringify(bad)} to q as written: it reads a " or a % in it itself. Start q from a PowerShell or another terminal.` };
    }
  }
  if (shell === "powershell") {
    // Windows PowerShell 5.1 (and pwsh before 7.3) passes a word to a
    // program in double quotes without escaping a " in it, so q's C runtime
    // splits it (#1420); a variable is set by PowerShell itself, unharmed.
    const bad = [binary, ...args].find((w) => w.includes('"'));
    if (bad !== undefined) {
      return { error: `PowerShell cannot pass ${JSON.stringify(bad)} to q as written: Windows PowerShell does not escape the " in it for q. Start q from another terminal, or leave the " out.` };
    }
    // It passes an empty word as nothing, and a spaced one ending in a
    // backslash as "...\", whose \" q reads as a quote (#1682).
    const lost = args.find((w) => w === "" || (/\s/.test(w) && w.endsWith("\\")));
    if (lost !== undefined) {
      return { error: `PowerShell cannot pass ${JSON.stringify(lost)} to q as written: Windows PowerShell passes ${lost === "" ? "an empty argument as none" : "a spaced argument ending in \\ with its last quote escaped"}. Start q from another terminal${lost === "" ? "" : ", or leave the trailing \\ out"}.` };
    }
  }
  const command = quote(binary, shell);
  let line = [command, ...args.map((a) => quote(a, shell))].join(" ");
  if (shell === "powershell" && command !== binary) {
    line = `& ${line}`;
  }
  const names = Object.keys(env);
  const byRef = Object.keys(refs);
  if (names.length === 0 && byRef.length === 0) {
    return line;
  }
  if (shell === "posix") {
    // Set for q alone, as `NAME=value q` sets it.
    return [...byRef.map((n) => `${n}="$${refs[n]}"`), ...names.map((n) => `${n}=${quote(env[n], "posix")}`), line].join(" ");
  }
  if (shell === "csh" || shell === "fish") {
    // csh, and fish before 3.1, have no `NAME=value q`: env sets them for q
    // alone (#1683).
    return ["env", ...byRef.map((n) => `${n}="$${refs[n]}"`), ...names.map((n) => `${n}=${quote(env[n], shell)}`), line].join(" ");
  }
  if (shell === "powershell") {
    // Always quoted: the right of an assignment is an expression, where a
    // bare `/opt/q` is a division.
    return [...byRef.map((n) => `$env:${n}=$env:${refs[n]}`), ...names.map((n) => `$env:${n}=${powershellLiteral(env[n])}`), line].join("; ");
  }
  return [...byRef.map((n) => `set "${n}=%${refs[n]}%"`), ...names.map((n) => `set "${n}=${env[n]}"`), line].join(" && ");
}

/// `file` with a leading `~` read as `home`, as a shell reads it: a q
/// binary or env file setting is quoted for the shell, which would
/// otherwise look for a folder named `~`.
export function expandHome(file: string, home: string): string {
  return file === "~" || /^~[\\/]/.test(file) ? home + file.slice(1) : file;
}

/// `qBinary` as a program to start from any directory: `~` expanded, and a
/// relative path (`./kdb/m64/q`) made whole against `folder`, where the
/// terminals start - started in a temporary or a launch's directory it was
/// another file, or none (#1540). A bare name is left for `PATH`. Undefined
/// for a relative path with no folder to read it from, or whose folder is
/// not `trusted`: the program would be the repository's (#1825).
export function qBinaryFrom(qBinary: string, folder: string | undefined, home: string, trusted = true): string | undefined {
  const file = expandHome(qBinary, home);
  // A drive or UNC path is absolute wherever it is read.
  if (path.isAbsolute(file) || /^([A-Za-z]:[\\/]|\\\\)/.test(file) || !/[\\/]/.test(file)) {
    return file;
  }
  return folder === undefined || !trusted ? undefined : path.resolve(folder, file);
}

/// Why a relative `q-lint.terminal.qBinary` gave no program: no folder to
/// read it from, or a folder that is not trusted (#1825).
export function relativeBinaryProblem(qBinary: string, trusted: boolean): string {
  return trusted
    ? `q-lint.terminal.qBinary ${qBinary} is relative, and there is no workspace folder to read it from`
    : `q-lint.terminal.qBinary ${qBinary} is relative to the workspace folder, which is not trusted: name it by its full path`;
}

/// The variables of an env file - one `NAME=value` a line, `#` comments and
/// blank lines skipped, an `export ` in front allowed, a ` # comment` after
/// a value cut, and a value in matching quotes taken without them - and the
/// lines it could not read.
/// Nothing in a value is expanded: `$HOME` stays `$HOME`.
export function parseEnv(text: string): { env: Record<string, string>; problems: string[] } {
  const env: Record<string, string> = {};
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      return;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match === null) {
      problems.push(`line ${i + 1}: not NAME=value: ${raw}`);
      return;
    }
    const value = match[2].trim();
    // A ` # comment` after the value, or after its closing quote, is not
    // part of it, as dotenv and the shells read it (#1686): a quoted value
    // ends at its first closing quote that only a comment follows, even a
    // comment ending in a quote (#1748).
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(value);
    env[match[1]] = quoted ? quoted[2] : value.replace(/(^|\s+)#.*$/, "");
  });
  return { env, problems };
}

/// `line` without its trailing comment - a `/` after a space or a tab,
/// outside a string - and whether it ends inside a string, given whether it
/// started inside one.
function cut(line: string, inString: boolean): { code: string; inString: boolean } {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === "\\") {
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === "/" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return { code: line.slice(0, i).replace(/\s+$/, ""), inString: false };
    }
  }
  return { code: line, inString };
}

/// `code` with no tab, which q's console reads as completion and drops
/// (#1673): a space outside a string and `\t` inside one, given whether it
/// starts inside one.
function untab(code: string, inString: boolean): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\t") {
      out += inString ? "\\t" : " ";
      continue;
    }
    out += c;
    if (inString && c === "\\") {
      out += code[++i] ?? "";
    } else if (c === '"') {
      inString = !inString;
    }
  }
  return out;
}

/// One statement as one line of q's console. A system command's line
/// (`\d .ns`, `\cd /tmp`) is left as it is - q does not read comments in
/// one - and its continuation lines (`\t {x+` then `  1}[2]`) joined to it
/// as any statement's are: a newline sent would run each line alone (#1674).
/// A `k)` statement's lines are joined with `;`: in k a newline between
/// them ends an expression, inside a lambda too, where in q it is a blank
/// (#2285).
export function replLine(statement: string): string {
  const lines = statement.split("\n");
  const between = statement.startsWith("k)") ? ";" : " ";
  let out = "";
  if (statement.startsWith("\\")) {
    out = lines.shift()!.replace(/\t/g, " ");
  }
  let inString = false;
  for (const line of lines) {
    if (inString) {
      // The newline and the indentation are part of the string.
      const { code, inString: still } = cut(line, true);
      out += `\\n${untab(code, true)}`;
      inString = still;
      continue;
    }
    const { code, inString: opened } = cut(line.trimStart(), false);
    inString = opened;
    if (code === "") {
      // A comment line inside a lambda.
      continue;
    }
    out = out === "" ? untab(code, false) : `${out}${between}${untab(code, false)}`;
  }
  return out;
}

/// The lines q's console is sent to run `code`: its statements, cut by the
/// rules a query uses, one line each.
export function replLines(code: string): string[] {
  return statements(code)
    .map(replLine)
    .filter((line) => line !== "");
}
