// An SSH tunnel to a process (#908): the system `ssh` forwarding a local
// port to the process's host and port, through the jump host the process
// names. No `vscode` import, so node tests it with a stand-in `ssh` on PATH.
//
// ssh runs with BatchMode, so it never asks for a password or a passphrase:
// it authenticates with the user's agent and `~/.ssh/config`, or fails, and
// q-lint stores nothing. The tunnel lives as long as the connection over it.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const TUNNEL_COMMANDS = {
  set: "q-lint.setSshTunnel",
} as const;

/// `q-lint.connection.sshTunnel.enable`: whether a process's tunnel opens,
/// and Set SSH Tunnel is offered.
export function readTunnel(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("connection.sshTunnel.enable", true) !== false };
}

/// How long ssh has to open the forward before it is given up.
export const TUNNEL_TIMEOUT_MS = 20_000;

/// The arguments ssh is run with: no command (`-N`), the forward from
/// `local` - a unix socket's path, or a port on the loopback - to
/// `host:port` as the jump host sees it, and
/// the destination after `--`, so nothing in it is read as an option. A
/// `host:port` or `[v6]:port` destination is given to ssh as `-p`; a bare
/// IPv6 address has no port, its last group is not one (#1068). The user
/// is all before the last `@`, whatever it holds: `a:b@bastion:2222` has the
/// port 2222 too (#3117).
export function sshArgs(destination: string, local: number | string, host: string, port: number): string[] {
  const bracketed = /^(.*@)?\[([^\]@]+)\](?::(\d+))?$/.exec(destination);
  const plain = /^((?:.*@)?[^:@]*):(\d+)$/.exec(destination);
  const m = bracketed ? [destination, `${bracketed[1] ?? ""}${bracketed[2]}`, bracketed[3]] : plain ?? [destination, destination, undefined];
  const target = host.includes(":") ? `[${host}]` : host;
  return [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-L",
    typeof local === "string" ? `${local}:${target}:${port}` : `127.0.0.1:${local}:${target}:${port}`,
    ...(m[2] !== undefined ? ["-p", m[2]] : []),
    "--",
    m[1],
  ];
}

/// A port nothing listens on now, on the loopback.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/// A directory only this user can enter, for the forward's socket (#1823):
/// a loopback port is open to every local user, who can bind it before ssh
/// does, be taken for the tunnel and be sent the q password; nobody else can
/// make or reach a socket in here. Undefined on Windows, whose ssh forwards
/// no unix socket, and for a temporary directory whose path ssh cannot take
/// (a `:` splits the forward).
export function socketDir(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32") {
    return undefined;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlint-ssh-"));
  fs.chmodSync(dir, 0o700);
  if (dir.includes(":") || /\s/.test(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  return dir;
}

/// Whether something accepts a connection on `local`: a socket's path, or a
/// port of the loopback.
function accepts(local: number | string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(typeof local === "string" ? { path: local } : { port: local, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export interface TunnelOptions {
  destination: string;
  host: string;
  port: number;
  /// The ssh program; `ssh` from PATH.
  ssh?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/// A connect through a tunnel that closed before the handshake (#1355), or
/// a tunnel ssh did not open.
/// What ssh printed about it is kept apart from `message`, in `sshSaid`:
/// it can name hosts, so it is for a message shown to the user at once and
/// never for a history, a notebook's output or anything else that is kept.
export class TunnelConnectError extends Error {
  constructor(
    message: string,
    readonly sshSaid: string,
  ) {
    super(message);
  }

  /// The failure with ssh's words after it, for that one message.
  shown(): Error {
    return this.sshSaid === "" ? this : new Error(`${this.message}. ssh said: ${this.sshSaid}`);
  }
}

/// The message of `error` for a message shown at once, never kept: with what
/// ssh said, for a tunnel that did not open (#1721).
export function shownError(error: unknown): string {
  return error instanceof TunnelConnectError ? error.shown().message : error instanceof Error ? error.message : String(error);
}

/// A connect through an open tunnel that closed before the handshake: as
/// likely a refused user as a forward that reached no q.
export class TunnelHandshakeError extends TunnelConnectError {
  /// Whether ssh said the forward's channel did not open (`channel 2: open
  /// failed: connect failed: Connection refused`): nothing was reached, so
  /// no user or password was refused (#3033).
  get reachedNothing(): boolean {
    return /\bopen failed\b/.test(this.sshSaid);
  }
}

export class SshTunnel {
  private closed = false;
  private readonly onExit: ((why: string) => void)[] = [];

  private constructor(
    private readonly child: ChildProcess,
    /// The forward's end: a unix socket's path, or a loopback port on Windows.
    readonly local: number | string,
    private readonly stderr: () => string,
    private readonly dir: string | undefined,
  ) {
    // ssh that never started (no program) has no exit to wait for.
    child.once("error", () => this.removeDir());
    child.once("exit", (code, signal) => {
      this.closed = true;
      this.removeDir();
      const why = this.stderr() || (signal !== null ? `ssh was stopped by ${signal}` : `ssh exited with ${code}`);
      for (const listener of this.onExit.splice(0)) {
        listener(why);
      }
    });
  }

  /// Start ssh and resolve once its forward accepts, or reject with what ssh
  /// said when it exits first, the time runs out, or `signal` aborts: ssh is
  /// then stopped, so nothing is left running behind a failed connect.
  static async open(options: TunnelOptions): Promise<SshTunnel> {
    const dir = socketDir();
    const local = dir !== undefined ? path.join(dir, "s") : await freePort();
    const child = spawn(options.ssh ?? "ssh", sshArgs(options.destination, local, options.host, options.port), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let err = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // The last lines say why; a chatty banner is not kept whole.
      err = (err + chunk).slice(-2000);
    });
    // A line said again is said once: the probe below and the connect after
    // it each make ssh report the same failed forward (#1355).
    const said = (): string =>
      err
        .trim()
        .split(/\r?\n/)
        .filter((l, i, all) => l.trim() !== "" && l !== all[i - 1])
        .slice(-3)
        .join(" ");
    const tunnel = new SshTunnel(child, local, said, dir);
    const timeoutMs = options.timeoutMs ?? TUNNEL_TIMEOUT_MS;
    const started = Date.now();
    let failure: string | undefined;
    // What ssh said as it exited: kept out of the message (#1355).
    let sshSaid: string | undefined;
    child.once("error", (error) => {
      failure = (error as NodeJS.ErrnoException).code === "ENOENT" ? `no ssh program (${options.ssh ?? "ssh"}) on PATH` : error.message;
    });
    tunnel.whenClosed((why) => (sshSaid ??= why));
    for (;;) {
      if (failure !== undefined) {
        tunnel.close();
        throw new Error(`the SSH tunnel through ${options.destination} did not open: ${failure}`);
      }
      if (sshSaid !== undefined) {
        throw new TunnelConnectError(`the SSH tunnel through ${options.destination} did not open`, sshSaid);
      }
      if (options.signal?.aborted) {
        tunnel.close();
        throw new Error(`the SSH tunnel through ${options.destination} was cancelled`);
      }
      if (Date.now() - started > timeoutMs) {
        tunnel.close();
        throw new Error(`the SSH tunnel through ${options.destination} did not open in ${timeoutMs / 1000} s`);
      }
      if (child.exitCode === null && (await accepts(local))) {
        return tunnel;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /// What a connection dials for the forward's end.
  get endpoint(): { path: string } | { host: string; port: number } {
    return typeof this.local === "string" ? { path: this.local } : { host: "127.0.0.1", port: this.local };
  }

  /// The forward's end as a message names it.
  get where(): string {
    return typeof this.local === "string" ? this.local : `127.0.0.1:${this.local}`;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /// The last lines ssh has printed so far.
  get said(): string {
    return this.stderr();
  }

  /// The ssh process's id, for a test to see it stopped.
  get pid(): number | undefined {
    return this.child.pid;
  }

  /// Run `listener` once, with ssh's last words, when ssh exits.
  whenClosed(listener: (why: string) => void): void {
    if (this.closed) {
      listener(this.stderr());
    } else {
      this.onExit.push(listener);
    }
  }

  private removeDir(): void {
    if (this.dir !== undefined) {
      fs.rmSync(this.dir, { recursive: true, force: true });
    }
  }

  /// Stop ssh, which closes the forward.
  close(): void {
    if (!this.closed && this.child.exitCode === null) {
      this.child.kill();
    }
    this.removeDir();
  }
}
