// The whole VS Code integration: launch `qlinter --lsp` and let the protocol
// do the rest.
//
// Everything a reader might expect here - reading files, parsing output,
// building diagnostics, deciding when to re-lint - lives in the server, which
// is why this stays about thirty lines. The same server serves Neovim, Helix
// and Zed with a comparable amount of their own configuration; nothing in this
// file is knowledge those editors would have to reimplement.
import { commands, workspace, window, type ExtensionContext } from "vscode";
import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

/// The server this extension was packaged with, if it was packaged with one.
///
/// A platform-specific build carries the matching `qlinter` in `server/`, so
/// the extension works with nothing installed and nothing configured - which
/// is the whole point, since the commonest failure by far was a binary that
/// was never on PATH. The platform-neutral build carries none, and falls back
/// to the setting. An explicit `q-lint.serverPath` always wins: someone who
/// named a binary meant that one.
function bundledServer(context: ExtensionContext): string | undefined {
  const name = process.platform === "win32" ? "qlinter.exe" : "qlinter";
  const path = join(context.extensionPath, "server", name);
  if (!existsSync(path)) {
    return undefined;
  }
  // A .vsix is a zip, and the unix executable bit does not reliably survive
  // the round trip. Restoring it here is cheaper than the support thread that
  // starts with EACCES.
  if (process.platform !== "win32" && !(statSync(path).mode & 0o111)) {
    try {
      chmodSync(path, 0o755);
    } catch {
      // Fall through: the spawn below will report it better than we can.
    }
  }
  return path;
}

export async function activate(context: ExtensionContext): Promise<void> {
  const settings = workspace.getConfiguration("q-lint");
  const configured = settings.get<string>("serverPath", "").trim();
  const profile = settings.get<string>("profile", "general");

  // In order of preference, and the fallback matters: packaging the extension
  // from a clone on Linux picks up the darwin-arm64 binary checked in for
  // local macOS builds, and preferring a server that cannot execute would be
  // worse than not bundling one at all. If the bundled one will not start,
  // PATH still gets its turn before the user sees an error.
  const candidates = configured
    ? [configured]
    : [bundledServer(context), "qlinter"].filter((c): c is string => !!c);

  const args = ["--lsp", "--profile", profile];
  const options: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "q" }],
    // The output channel the server's own trace goes to, so a user debugging
    // the integration has one place to look.
    outputChannelName: "q-lint",
  };

  let started: unknown;
  for (const command of candidates) {
    const server: ServerOptions = {
      // One entry, used for both: this server has no separate debug mode, and
      // giving it a fabricated one would mean a second thing to keep in step.
      //
      // No `transport` field. stdio is already the default for an executable,
      // and naming it explicitly makes the client append `--stdio` to argv -
      // a flag qlinter does not accept, so it exits 2 before the handshake.
      run: { command, args },
      debug: { command, args },
    };
    client = new LanguageClient("q-lint", "q-lint", server, options);
    try {
      await client.start();
      started = undefined;
      // Which server answered, and where it came from. The rules live in the
      // binary, so a diagnostic that looks wrong is often a diagnostic from a
      // server older than the one the user thinks they installed - and until
      // this line there was no way to tell from inside the editor.
      const version = client.initializeResult?.serverInfo?.version ?? "unknown version";
      client.outputChannel.appendLine(`q-lint ${version} from ${command}`);
      break;
    } catch (error) {
      started = error;
      await client.stop().catch(() => {});
      client = undefined;
    }
  }

  {
    const error = started;
    const command = candidates.join('", "');
    if (client === undefined) {
      // Name every binary that was tried. "Couldn't start the server" sends
      // someone to the logs; saying what was attempted, and that none of them
      // ran, tells them what to fix.
      window.showErrorMessage(
        `q-lint: could not start "${command}". No server for ${process.platform}-` +
          `${process.arch} would run: install a release archive from ` +
          `github.com/kwojdalski/q-lint/releases and set q-lint.serverPath to the qlinter ` +
          `binary, or put it on PATH. ${error}`,
      );
    }
  }
  // Replacing the binary does not restart the server, and a window reload is
  // a blunt way to pick up a new one. This is the small way.
  context.subscriptions.push(
    commands.registerCommand("q-lint.restartServer", async () => {
      await client?.stop().catch(() => {});
      client = undefined;
      await activate(context);
    }),
  );
  context.subscriptions.push({ dispose: () => void client?.stop() });
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
