// `.env` files for q (#976), as data: the settings, the file read with
// the env file's rules, and what may be said about it. No `vscode` import,
// so node tests it; `qenvironment.ts` reads the file for a workspace
// folder and hands the variables to terminals, launched processes and
// tasks.
//
// A `.env` file often holds secrets - a password a process reads, a token
// - so nothing here returns a value for display: a line it cannot read is
// named by its number alone, and the variables by their names.
import { parseEnv } from "./terminal";

export interface EnvSettings {
  enabled: boolean;
  /// The file, relative to the workspace folder unless absolute; `~` is
  /// the home directory.
  file: string;
}

/// `q-lint.env.enable` and `q-lint.env.file`, read as `readTerminal` reads
/// the terminal ones.
export function readEnvSettings(get: <T>(key: string, fallback: T) => T): EnvSettings {
  const file = get<unknown>("env.file", ".env");
  return {
    enabled: get<unknown>("env.enable", true) !== false,
    file: typeof file === "string" && file.trim() !== "" ? file.trim() : ".env",
  };
}

/// The variables of a `.env` file, by the env file's rules (`terminal.ts`'s
/// `parseEnv`), and the numbers of the lines it could not read - not their
/// text, which may be a secret with a typo in it.
export function readDotenv(text: string): { env: Record<string, string>; badLines: number[] } {
  const { env, problems } = parseEnv(text);
  const badLines = problems.map((p) => Number(/^line (\d+):/.exec(p)?.[1] ?? 0)).filter((n) => n > 0);
  return { env, badLines };
}

/// `names` as a message lists them: the first `most`, then how many more.
export function namesText(names: string[], most = 5): string {
  if (names.length === 0) {
    return "no variables";
  }
  const shown = names.slice(0, most).join(", ");
  return names.length > most ? `${shown} and ${names.length - most} more` : shown;
}

/// The variables a q started directly - a launched process, a task - gets
/// on top of the extension's own environment: the binary's layout's, then
/// the `.env` file's, then its own definition's, each winning over the one
/// before.
export function mergeEnv(...layers: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...layers) as Record<string, string>;
}

/// The variables q reads as it starts, which a shell's startup file often
/// exports.
const Q_NAMES = ["QHOME", "QLIC", "QINIT"];

/// What a q terminal is given, split by where it goes: `shown` on the
/// command line that starts q (the layout's and `q-lint.terminal.envPath`'s,
/// the latter winning), and `hidden` in the terminal's environment (the
/// `.env` file's), so its values never appear on screen. A name the `.env`
/// file sets is left off the command line, where it would win over it. The
/// shell's startup file runs after the environment is set, and its export
/// of QHOME would win over the `.env` file's, as it does not for a launched
/// q (#1684): so a q variable the `.env` sets is also kept under a name of
/// its own, which `refs` maps it to, for the command line to set it from.
export function terminalEnv(
  layout: Record<string, string>,
  envPath: Record<string, string>,
  dotenv: Record<string, string>,
): { shown: Record<string, string>; hidden: Record<string, string>; refs: Record<string, string> } {
  const shown: Record<string, string> = {};
  for (const [name, value] of Object.entries(layout)) {
    if (!(name in dotenv)) {
      shown[name] = value;
    }
  }
  Object.assign(shown, envPath);
  const hidden = { ...dotenv };
  const refs: Record<string, string> = {};
  for (const name of Q_NAMES) {
    if (name in dotenv && !(name in shown)) {
      refs[name] = `QLINT_DOTENV_${name}`;
      hidden[refs[name]] = dotenv[name];
    }
  }
  return { shown, hidden, refs };
}
