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
//   `username`);
// - or a line: the password when the process has a user, else
//   `user:password` (split at the first colon), else the password alone.
import { exec } from "node:child_process";

export const CREDENTIAL_TIMEOUT_MS = 30_000;

export interface Credentials {
  user?: string;
  password: string;
}

/// The credentials `output` gives, or why it gives none. `user` is the
/// process's own, which a line does not override.
export function parseCredentials(output: string, user?: string): Credentials | { problem: string } {
  const text = output.replace(/^﻿/, "").trim();
  if (text === "") {
    return { problem: "it printed nothing" };
  }
  if (text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { problem: "it printed something that starts like JSON but is not" };
    }
    const j = json as Record<string, unknown>;
    const password = typeof j.password === "string" ? j.password : typeof j.token === "string" ? j.token : undefined;
    if (password === undefined) {
      return { problem: "its JSON has no password or token string" };
    }
    const named = typeof j.user === "string" ? j.user : typeof j.username === "string" ? j.username : user;
    return { ...(named !== undefined && named !== "" ? { user: named } : {}), password };
  }
  const line = text.split(/\r?\n/)[0];
  if (user !== undefined && user !== "") {
    return { user, password: line };
  }
  const colon = line.indexOf(":");
  return colon > 0 ? { user: line.slice(0, colon), password: line.slice(colon + 1) } : { password: line };
}

/// Run `command` in a shell and give what it printed; reject with how it
/// ended - its exit code, a signal, the timeout - never with its output,
/// which may hold the secret.
export function runCredentialCommand(
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? CREDENTIAL_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error === null) {
          resolve(String(stdout));
          return;
        }
        const e = error as Error & { code?: number | string; signal?: string | null; killed?: boolean };
        reject(
          new Error(
            e.killed && e.signal !== null && e.signal !== undefined
              ? `the credential command did not finish in ${(options.timeoutMs ?? CREDENTIAL_TIMEOUT_MS) / 1000} s`
              : e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "the credential command printed more than 64 KB"
                : typeof e.code === "number"
                  ? `the credential command failed with exit code ${e.code}`
                  : `the credential command could not run${e.signal ? ` (${e.signal})` : ""}`,
          ),
        );
      },
    );
  });
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
