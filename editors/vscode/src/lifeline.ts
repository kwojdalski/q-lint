// Signals to what Start Process started. No `vscode` import, so node tests
// it.
import type { ChildProcess } from "node:child_process";

/// Send `signal` to `child`'s process group, which it leads when spawned
/// detached: a wrapper script's q gets it too, not just the script (#1672).
/// To the child alone where there are no groups, or the group is gone.
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals, platform: string = process.platform): void {
  if (platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // No such group: the child alone.
    }
  }
  child.kill(signal);
}
