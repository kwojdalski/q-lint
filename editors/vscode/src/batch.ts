// A Windows batch wrapper - `q-lint.serverPath` naming a `qlinter.cmd`
// (#1610). Node refuses to start a `.cmd` or `.bat` without a shell (EINVAL
// since 18.20.2/20.12.2), so one is started through cmd.exe, the command and
// each argument quoted: a Windows path holds no `"`, so quoting is enough.

/// Whether `command` is a `.cmd` or `.bat` file on Windows.
export function isBatch(command: string, platform: string = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command.trim());
}

/// `command` and `args` as a shell is given them: as they are, unless
/// `command` is a batch file, which is then run through the shell with the
/// command and every argument quoted.
export function launchable(
  command: string,
  args: string[],
  platform: string = process.platform,
): { command: string; args: string[]; shell: boolean } {
  if (!isBatch(command, platform)) {
    return { command, args, shell: false };
  }
  const quote = (s: string): string => `"${s.replace(/"/g, "")}"`;
  return { command: quote(command), args: args.map(quote), shell: true };
}
