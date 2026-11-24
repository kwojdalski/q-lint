// A process started from here ends when the extension host does, even when
// it is killed and nothing is disposed (#1676). No `vscode` import, so node
// tests it.
import { spawn, type ChildProcess } from "node:child_process";

/// The watchdog: it holds a pipe from the extension host, which the system
/// closes when the host ends however it ends, and then ends the process
/// group it was given - SIGTERM, then SIGKILL. It leaves on its own once
/// that group is gone.
const WATCHDOG = `const g = Number(process.argv[1]);
const gone = () => { try { process.kill(-g, 0); return false; } catch { return true; } };
const end = () => { try { process.kill(-g, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-g, "SIGKILL"); } catch {} process.exit(0); }, 3000); };
process.stdin.on("end", end).on("error", end).resume();
setInterval(() => gone() && process.exit(0), 2000);`;

/// Tie `child`, which leads a process group of its own (spawned detached),
/// to this process: when this one ends without stopping it, its group is
/// ended. Nothing on Windows, which has no process groups to end. The
/// watchdog, or undefined.
export function lifeline(child: ChildProcess, platform: string = process.platform): ChildProcess | undefined {
  if (platform === "win32" || child.pid === undefined) {
    return undefined;
  }
  try {
    const watchdog = spawn(process.execPath, ["-e", WATCHDOG, String(child.pid)], {
      // In VS Code, execPath is Electron's: this runs it as node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    watchdog.on("error", () => {});
    watchdog.unref();
    (watchdog.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    return watchdog;
  } catch {
    return undefined;
  }
}

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

/// Whether anything is left in the process group `child` leads: a wrapper
/// that has exited may have left its q running in it (#1744). False on
/// Windows, which has no groups.
export function groupAlive(child: ChildProcess, platform: string = process.platform): boolean {
  if (platform === "win32" || child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
