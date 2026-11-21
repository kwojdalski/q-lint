// What the `q-lint.*` settings become: the server's command line and its
// `initializationOptions`. Kept apart from `extension.ts`, and free of any
// `vscode` import, so the mapping can be tested with plain node.
//
// Two channels, and which a setting takes is not arbitrary. What the command
// line already means - `--profile`, `--config` - goes there, so the server
// treats it exactly as `qlinter` in a terminal does. What only an editor has a
// use for - narrowing the rules shown, Quick Fixes, formatting, colouring, the
// workspace index - goes in `initializationOptions`, which the server reads in
// `initialize`. Either way the server reads it once: a change restarts it.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/// The documents the language client hands the server: a saved `.q` file, and
/// nothing else. `language: "q"` alone would also match a console buffer or an
/// untitled scratch that some other q extension has labelled `q`, and this
/// linter has nothing true to say about a REPL transcript. Nor about the `k`,
/// `quke` and `q-console` languages this extension colours: k is not q, a
/// qcumber spec is not a script q loads, and the console is q's output. The
/// server applies the same rule, so an editor that is not VS Code is protected
/// too.
export const LINTED = [{ scheme: "file", language: "q", pattern: "**/*.q" }];

/// The part of `WorkspaceConfiguration` this needs, so a test can hand in a
/// plain object.
export interface Settings {
  get<T>(key: string, defaultValue: T): T;
  inspect<T>(key: string):
    | { workspaceFolderValue?: T; workspaceValue?: T; globalValue?: T }
    | undefined;
}

export interface Launch {
  /// `q-lint.enable`: false means no server at all.
  enabled: boolean;
  /// `q-lint.serverPath`, trimmed; empty means "find one".
  serverPath: string;
  args: string[];
  initializationOptions: InitializationOptions;
}

/// The server's `Options`, in the shape `src/lsp.rs` documents.
export interface InitializationOptions {
  lint: {
    select: string[];
    ignore: string[];
    run: "onType" | "onSave";
    severity: Record<string, string>;
  };
  fixes: { unsafe: boolean };
  format: { enable: boolean };
  semanticTokens: { enable: boolean };
  navigation: { enable: boolean };
  help: { enable: boolean };
  completion: { enable: boolean };
  callHierarchy: { enable: boolean };
  graph: { enable: boolean };
  inlayHints: { enable: boolean };
  workspaceIndex: { enable: boolean; exclude: string[] };
}

/// The value the user set, at whichever level they set it, or undefined when
/// they set none. Unlike `get`, this does not fall back to the declared
/// default - which matters where passing the default would override a
/// repository's own configuration.
function explicit<T>(settings: Settings, key: string): T | undefined {
  const i = settings.inspect<T>(key);
  return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
}

/// A string setting, trimmed; empty for one that is not a string, as a
/// hand-written `null` or a number in settings.json is.
function text(settings: Settings, key: string): string {
  const value = settings.get<unknown>(key, "");
  return typeof value === "string" ? value.trim() : "";
}

/// `path` with a leading `~` made the home directory, as a shell would: the
/// server is spawned without one, so `~/bin/qlinter` would name a directory
/// called `~`.
function home(path: string): string {
  return path === "~" || /^~[\\/]/.test(path) ? join(homedir(), path.slice(1)) : path;
}

function strings(settings: Settings, key: string): string[] {
  const value = settings.get<unknown>(key, []);
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
    : [];
}

/// `settings` as a launch. `folder` is the first workspace folder, which a
/// relative `q-lint.configFile` is resolved against.
export function launch(settings: Settings, folder: string | undefined): Launch {
  const args = ["--lsp"];
  // Only a profile the user actually set is passed on. A flag wins over a
  // repository's `qlinter.toml`, so passing the default every time would
  // silently override the project's own `profile`. Left unset, the server
  // reads the repository's configuration, and uses `style` where there is
  // none - the same default this setting declares.
  const profile = explicit<unknown>(settings, "profile");
  if (typeof profile === "string" && profile.trim() !== "") {
    args.push("--profile", profile.trim());
  }
  const setting = home(text(settings, "configFile"));
  const configFile = !setting
    ? undefined
    : isAbsolute(setting) || folder === undefined
      ? setting
      : join(folder, setting);
  if (configFile) {
    args.push("--config", configFile);
  }
  args.push(...strings(settings, "serverArgs"));

  const run = settings.get<string>("lint.run", "onType") === "onSave" ? "onSave" : "onType";
  const severity = settings.get<Record<string, string>>("lint.severity", {});
  return {
    enabled: settings.get<unknown>("enable", true) !== false,
    serverPath: home(text(settings, "serverPath")),
    args,
    initializationOptions: {
      lint: {
        select: strings(settings, "lint.select"),
        ignore: strings(settings, "lint.ignore"),
        run,
        severity: severity && typeof severity === "object" ? { ...severity } : {},
      },
      fixes: { unsafe: settings.get<boolean>("fixes.unsafe", true) },
      format: { enable: settings.get<boolean>("format.enable", true) },
      semanticTokens: { enable: settings.get<boolean>("semanticTokens.enable", true) },
      navigation: { enable: settings.get<boolean>("navigation.enable", true) },
      help: { enable: settings.get<boolean>("help.enable", true) },
      completion: { enable: settings.get<boolean>("completion.enable", false) },
      callHierarchy: { enable: settings.get<boolean>("callHierarchy.enable", true) },
      graph: { enable: settings.get<boolean>("graph.enable", true) },
      inlayHints: { enable: settings.get<boolean>("inlayHints.enable", true) },
      workspaceIndex: {
        enable: settings.get<boolean>("workspaceIndex.enable", true),
        exclude: strings(settings, "workspaceIndex.exclude"),
      },
    },
  };
}

/// The settings a running server cannot take on: all of them but the trace
/// level, which the language client applies to a running one.
const RESTARTING = [
  "enable",
  "serverPath",
  "serverArgs",
  "profile",
  "configFile",
  "lint",
  "fixes",
  "format",
  "semanticTokens",
  "navigation",
  "help",
  "completion",
  "callHierarchy",
  "graph",
  "inlayHints",
  "workspaceIndex",
];

/// Whether a configuration change needs a new server.
export function needsRestart(affects: (section: string) => boolean): boolean {
  return RESTARTING.some((key) => affects(`q-lint.${key}`));
}
