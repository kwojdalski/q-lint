// The environment a q this extension starts locally is given: the
// variables the binary's layout needs (#974) and a workspace's `.env` file
// (#976). The terminals, the process launcher and the q tasks all ask here,
// so they agree. The rules are `interpreter.ts`'s and `qenv.ts`'s.
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Uri, window, workspace } from "vscode";
import { layoutEnv, readInterpreter, type Files } from "./interpreter";
import { namesText, readDotenv, readEnvSettings } from "./qenv";
import { expandHome } from "./terminal";
import { plainMessage } from "./history";

/// The machine's file system, as discovery reads it.
export const nodeFiles: Files = {
  executable: (file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
  exists: (file) => existsSync(file),
  real: (file) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  },
};

const settings = (from?: Uri) => {
  const configuration = workspace.getConfiguration("q-lint", from);
  return <T>(key: string, fallback: T): T => configuration.get(key, fallback);
};

/// The variables `binary`'s layout needs, while the interpreter picker is
/// on; none while it is off, as before it.
export function layoutEnvFor(binary: string, from?: Uri): Record<string, string> {
  return readInterpreter(settings(from)).enabled ? layoutEnv(expandHome(binary, os.homedir()), nodeFiles) : {};
}

/// The `.env` file `from`'s workspace folder names, if the feature is on
/// and it can be read. A missing file is no file - most folders have none -
/// and anything else wrong with it is said without a single value of it.
/// None in a workspace that is not trusted (#1164): its variables
/// (`LD_PRELOAD`, `QINIT`) can choose what a q started from it runs.
export async function dotenvFor(from?: Uri): Promise<Record<string, string>> {
  const read = readEnvSettings(settings(from));
  if (!read.enabled || workspace.isTrusted === false) {
    return {};
  }
  const folder = (from && workspace.getWorkspaceFolder(from)) ?? workspace.workspaceFolders?.[0];
  const file = expandHome(read.file, os.homedir());
  const base = folder?.uri.fsPath;
  if (!path.isAbsolute(file) && typeof base !== "string") {
    return {};
  }
  const full = path.resolve(typeof base === "string" ? base : "", file);
  let text: string;
  try {
    text = Buffer.from(await workspace.fs.readFile(Uri.file(full))).toString("utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "FileNotFound" && code !== "ENOENT" && existsSync(full)) {
      void window.showWarningMessage(plainMessage(`q-lint: could not read the .env file ${full}; none of it was used.`));
    }
    return {};
  }
  const { env, badLines } = readDotenv(text);
  if (badLines.length > 0) {
    void window.showWarningMessage(
      plainMessage(`q-lint: skipped line${badLines.length === 1 ? "" : "s"} ${badLines.slice(0, 10).join(", ")} of ${full}: not NAME=value. ` +
        `Used ${namesText(Object.keys(env))}.`),
    );
  }
  return env;
}
