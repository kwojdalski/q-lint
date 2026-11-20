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
import { statements } from "./statements";

/// How the shell in the terminal reads a command line.
export type Shell = "posix" | "powershell" | "cmd";

/// The shell a terminal runs, from its path: PowerShell and cmd by name, and
/// anything else - bash, zsh, fish, Git Bash on Windows - read as POSIX.
export function shellKind(path: string | undefined): Shell {
  const name = (path ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) {
    return "powershell";
  }
  if (/^cmd(\.exe)?$/.test(name)) {
    return "cmd";
  }
  return "posix";
}

/// The characters each shell reads as themselves, so a word made only of
/// them is passed as it is. PowerShell reads `,` as an array and `@` as a
/// splat, and on Windows a backslash is a path separator, not an escape.
/// zsh reads a word that starts with `=` as `=name`, the path of a command.
const PLAIN: Record<Shell, RegExp> = {
  posix: /^[A-Za-z0-9_\/.,:@%+-][A-Za-z0-9_\/.,:@%+=-]*$/,
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
  if (PLAIN[shell].test(word)) {
    return word;
  }
  if (shell === "posix") {
    return `'${word.replace(/'/g, `'\\''`)}'`;
  }
  if (shell === "powershell") {
    return powershellLiteral(word);
  }
  // cmd passes the line to the program, whose C runtime splits it: inside
  // double quotes a quote is escaped with a backslash, and backslashes
  // before a quote - or before the closing one - are doubled.
  return `"${word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/// The line that starts `binary` with `args` in `shell`, with `env` set
/// for it. The variables are on the line rather than in the terminal's
/// environment because the shell's startup files run in between: a
/// `.zshrc` that exports `QHOME` would otherwise win over the env file.
/// PowerShell runs a quoted command only through `&`. cmd cannot escape a
/// `%` or a `"` in a value, so those reach q as cmd reads them.
export function commandLine(binary: string, args: string[], shell: Shell, env: Record<string, string> = {}): string {
  const command = quote(binary, shell);
  let line = [command, ...args.map((a) => quote(a, shell))].join(" ");
  if (shell === "powershell" && command !== binary) {
    line = `& ${line}`;
  }
  const names = Object.keys(env);
  if (names.length === 0) {
    return line;
  }
  if (shell === "posix") {
    // Set for q alone, as `NAME=value q` sets it.
    return [...names.map((n) => `${n}=${quote(env[n], "posix")}`), line].join(" ");
  }
  if (shell === "powershell") {
    // Always quoted: the right of an assignment is an expression, where a
    // bare `/opt/q` is a division.
    return [...names.map((n) => `$env:${n}=${powershellLiteral(env[n])}`), line].join("; ");
  }
  return [...names.map((n) => `set "${n}=${env[n]}"`), line].join(" && ");
}

/// The variables of an env file - one `NAME=value` a line, `#` comments and
/// blank lines skipped, an `export ` in front allowed, and a value in
/// matching quotes taken without them - and the lines it could not read.
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
    const quoted = /^(["'])(.*)\1$/.exec(value);
    env[match[1]] = quoted ? quoted[2] : value;
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

/// One statement as one line of q's console. A system command (`\d .ns`,
/// `\cd /tmp`) is left as it is: q does not read comments in one.
export function replLine(statement: string): string {
  if (statement.startsWith("\\")) {
    return statement;
  }
  let out = "";
  let inString = false;
  for (const line of statement.split("\n")) {
    if (inString) {
      // The newline and the indentation are part of the string.
      const { code, inString: still } = cut(line, true);
      out += `\\n${code}`;
      inString = still;
      continue;
    }
    const { code, inString: opened } = cut(line.trimStart(), false);
    inString = opened;
    if (code === "") {
      // A comment line inside a lambda.
      continue;
    }
    out = out === "" ? code : `${out} ${code}`;
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
