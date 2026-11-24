// A Windows batch wrapper - `q-lint.serverPath` naming a `qlinter.cmd`
// (#1610). Node refuses to start a `.cmd` or `.bat` without a shell (EINVAL
// since 18.20.2/20.12.2), so one is started through cmd.exe, the command and
// each argument quoted: a Windows path holds no `"`, so quoting is enough.
// cmd reads `%NAME%` inside quotes too, and has no escape for it there, so a
// word with a `%` is refused (#1835), as launcher.ts and terminal.ts do.

/// Whether `command` is a `.cmd` or `.bat` file on Windows.
export function isBatch(command: string, platform: string = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command.trim());
}

/// `command` and `args` as a shell is given them: as they are, unless
/// `command` is a batch file, which is then run through the shell with the
/// command and every argument quoted. Throws for a word with a `%` (or a
/// line break) then: cmd would expand `%OS%` in `C:\src\100%OS%rates`, and
/// the wrong folder would be linted, or a baseline written elsewhere.
export function launchable(
  command: string,
  args: string[],
  platform: string = process.platform,
): { command: string; args: string[]; shell: boolean } {
  if (!isBatch(command, platform)) {
    return { command, args, shell: false };
  }
  const bad = [command, ...args].find((w) => /[%\r\n]/.test(w));
  if (bad !== undefined) {
    throw new Error(`cmd cannot pass ${JSON.stringify(bad)} to ${command} as written: it reads a % in it itself. Name qlinter.exe in q-lint.serverPath, or use a path without a %`);
  }
  const quote = (s: string): string => `"${s.replace(/"/g, "")}"`;
  return { command: quote(command), args: args.map(quote), shell: true };
}
