// Credential commands (#1034): a process can name a command, run at each
// connect, whose output gives the user and password - or a token, sent as
// the password - for a Kerberos ticket, a vault or a token service. What it
// prints is used for that one handshake and kept nowhere: not in secret
// storage, settings, globalState or a log, and an error says how the
// command ended, never what it printed. No `vscode` import, so node tests
// it; `live.ts` runs it when it connects.
//
// What the command prints, on stdout:
// - a JSON object with `password` (or `token`), and optionally `user` (or
//   `username`), alone or the one entry of a JSON list;
// - or a JSON string, read as the line it holds;
// - or a line: the password when the process has a user, else
//   `user:password` (split at the first colon), else the password alone.
import { spawn } from "node:child_process";
import { signalGroup } from "./lifeline";

export const CREDENTIAL_TIMEOUT_MS = 30_000;

export interface Credentials {
  user?: string;
  password: string;
}

/// The credentials `output` gives, or why it gives none. `user` is the
/// process's own, which a line does not override.
export function parseCredentials(output: string, user?: string): Credentials | { problem: string } {
  const printed = output.replace(/^\uFEFF/, "");
  const text = printed.trim();
  if (text === "") {
    return { problem: "it printed nothing" };
  }
  // A JSON object opens with `{` and a key (or `}`); a password line may
  // open with `{` alone (`{s3cret}`) and is read as a line (#1376).
  const object = /^\{\s*["}]/.test(text);
  // A list or a quoted string is JSON too, when it reads as JSON: a tool's
  // `[{"user":..,"password":..}]` was a line, cut at its first colon into a
  // user `[{"user"` and the rest for a password, and `"s3cret"` a password
  // with its quotes (#3118).
  if (object || /^[["]/.test(text)) {
    let json: unknown;
    let read = true;
    try {
      json = JSON.parse(text);
    } catch {
      if (object) {
        return { problem: "it printed something that starts like JSON but is not" };
      }
      read = false;
    }
    if (typeof json === "string") {
      return json === "" ? { problem: "its JSON is an empty string" } : ofLine(json, user);
    }
    if (Array.isArray(json)) {
      const one: unknown = json[0];
      if (json.length !== 1 || typeof one !== "object" || one === null || Array.isArray(one)) {
        // How many, never what: an entry may hold the secret.
        return { problem: json.length === 1 ? "its JSON is a list whose one entry is not an object" : `its JSON is a list of ${json.length} entries, where one object with a password or token is expected` };
      }
      json = one;
    }
    if (read) {
      const j = json as Record<string, unknown>;
      const password = typeof j.password === "string" ? j.password : typeof j.token === "string" ? j.token : undefined;
      if (password === undefined) {
        return { problem: "its JSON has no password or token string" };
      }
      // An empty name is no name (a vault template's unset field), as null is.
      const given = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
      const named = given(j.user) ?? given(j.username) ?? user;
      return { ...(named !== undefined && named !== "" ? { user: named } : {}), password };
    }
  }
  // The line as printed, less only its line ending: spaces and tabs at
  // either end of a password are part of it (#1358). Blank lines before
  // it are skipped, as they always were.
  return ofLine(printed.split(/\r?\n/).find((l) => l.trim() !== "") ?? text, user);
}

/// The credentials a `line` is: the password of the process's `user`, else
/// `user:password`, else the password alone.
function ofLine(line: string, user: string | undefined): Credentials {
  if (user !== undefined && user !== "") {
    return { user, password: line };
  }
  const colon = line.indexOf(":");
  const named = line.slice(0, colon).trim();
  return colon > 0 && named !== "" ? { user: named, password: line.slice(colon + 1) } : { password: line };
}

/// Run `command` in a shell and give what it printed; reject with how it
/// ended - its exit code, a signal, the timeout, `signal` aborting - never
/// with its output, which may hold the secret. It leads a process group of
/// its own, ended whole at the timeout or the abort: a shell's `sleep` or
/// prompt is not left running behind it (#2127).
export function runCredentialCommand(
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const limit = options.timeoutMs ?? CREDENTIAL_TIMEOUT_MS;
    if (options.signal?.aborted) {
      reject(new Error("the credential command was cancelled"));
      return;
    }
    // exec cannot start a group of its own, so the shell is spawned.
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      // cmd.exe looks for a bare name (`vault`) in the folder it runs in
      // before PATH; this turns that off (#1537).
      env: { ...process.env, ...(process.platform === "win32" ? { NoDefaultCurrentDirectoryInExePath: "1" } : {}), ...options.env },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const out: Buffer[] = [];
    let size = 0;
    let ended: string | undefined;
    const end = (why: string): void => {
      if (ended === undefined) {
        ended = why;
        signalGroup(child, "SIGKILL");
      }
    };
    const timer = setTimeout(() => end(`the credential command did not finish in ${limit / 1000} s`), limit);
    const cancelled = (): void => end("the credential command was cancelled");
    options.signal?.addEventListener("abort", cancelled, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        end("the credential command printed more than 64 KB");
      } else {
        out.push(chunk);
      }
    });
    let settled = false;
    const settle = (error: Error | undefined, code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancelled);
      if (ended !== undefined) {
        reject(new Error(ended));
      } else if (error !== undefined) {
        reject(new Error("the credential command could not run"));
      } else if (code === 0) {
        resolve(Buffer.concat(out).toString("utf8"));
      } else {
        reject(new Error(code !== null ? `the credential command failed with exit code ${code}` : `the credential command could not run${signal ? ` (${signal})` : ""}`));
      }
    };
    child.once("error", (error) => settle(error, null, null));
    // On exit, not close: what it left behind may hold its stdout open
    // (#2191). Its group is ended then - nothing it started outlives it -
    // and what it wrote, already in the pipe, is read to the pipe's close.
    // A leftover that left the group still holds the pipe, so the read is
    // given a moment and no more.
    child.once("exit", (code, signal) => {
      if (ended !== undefined || code !== 0) {
        settle(undefined, code, signal);
        if (ended === undefined) {
          signalGroup(child, "SIGKILL");
        }
        return;
      }
      signalGroup(child, "SIGKILL");
      const stdout = child.stdout;
      if (stdout === null || stdout.closed) {
        settle(undefined, code, signal);
        return;
      }
      const grace = setTimeout(() => {
        settle(undefined, code, signal);
        stdout.destroy();
      }, 500);
      stdout.once("close", () => {
        clearTimeout(grace);
        settle(undefined, code, signal);
      });
    });
  });
}

/// Where a credential command runs: the workspace folder only when it is
/// trusted, else the home directory. A saved process is every window's, and
/// a relative command (`./creds.sh`) run in a folder not trusted is that
/// repository's (#1537).
export function credentialCwd(trusted: boolean, folder: string | undefined, home: string): string {
  return trusted && folder !== undefined ? folder : home;
}

/// The variables a credential command is given, so one script serves many
/// processes: the label, host, port and user. Never a password.
export function credentialEnv(process: { label: string; host: string; port: number; user?: string }): Record<string, string> {
  return {
    QLINT_PROCESS_LABEL: process.label,
    QLINT_PROCESS_HOST: process.host,
    QLINT_PROCESS_PORT: String(process.port),
    ...(process.user !== undefined ? { QLINT_PROCESS_USER: process.user } : {}),
  };
}
