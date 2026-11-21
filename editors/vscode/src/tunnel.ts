// An SSH tunnel to a process (#908): the system `ssh` forwarding a local
// port to the process's host and port, through the jump host the process
// names. No `vscode` import, so node tests it with a stand-in `ssh` on PATH.
//
// ssh runs with BatchMode, so it never asks for a password or a passphrase:
// it authenticates with the user's agent and `~/.ssh/config`, or fails, and
// q-lint stores nothing. The tunnel lives as long as the connection over it.
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";

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
/// `localPort` on the loopback to `host:port` as the jump host sees it, and
/// the destination after `--`, so nothing in it is read as an option. A
/// `host:port` destination is given to ssh as `-p`.
export function sshArgs(destination: string, localPort: number, host: string, port: number): string[] {
  const m = /^(.*?)(?::(\d+))?$/.exec(destination)!;
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
    `127.0.0.1:${localPort}:${target}:${port}`,
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

/// Whether something accepts a connection on `port` of the loopback.
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
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

export class SshTunnel {
  private closed = false;
  private readonly onExit: ((why: string) => void)[] = [];

  private constructor(
    private readonly child: ChildProcess,
    readonly localPort: number,
    private readonly stderr: () => string,
  ) {
    child.once("exit", (code, signal) => {
      this.closed = true;
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
    const localPort = await freePort();
    const child = spawn(options.ssh ?? "ssh", sshArgs(options.destination, localPort, options.host, options.port), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let err = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // The last lines say why; a chatty banner is not kept whole.
      err = (err + chunk).slice(-2000);
    });
    const said = (): string => err.trim().split(/\r?\n/).filter((l) => l.trim() !== "").slice(-3).join(" ");
    const tunnel = new SshTunnel(child, localPort, said);
    const timeoutMs = options.timeoutMs ?? TUNNEL_TIMEOUT_MS;
    const started = Date.now();
    let failure: string | undefined;
    child.once("error", (error) => {
      failure = (error as NodeJS.ErrnoException).code === "ENOENT" ? `no ssh program (${options.ssh ?? "ssh"}) on PATH` : error.message;
    });
    tunnel.whenClosed((why) => (failure ??= why));
    for (;;) {
      if (failure !== undefined) {
        tunnel.close();
        throw new Error(`the SSH tunnel through ${options.destination} did not open: ${failure}`);
      }
      if (options.signal?.aborted) {
        tunnel.close();
        throw new Error(`the SSH tunnel through ${options.destination} was cancelled`);
      }
      if (Date.now() - started > timeoutMs) {
        tunnel.close();
        throw new Error(`the SSH tunnel through ${options.destination} did not open in ${timeoutMs / 1000} s`);
      }
      if (child.exitCode === null && (await accepts(localPort))) {
        return tunnel;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  get isOpen(): boolean {
    return !this.closed;
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

  /// Stop ssh, which closes the forward.
  close(): void {
    if (!this.closed && this.child.exitCode === null) {
      this.child.kill();
    }
  }
}
