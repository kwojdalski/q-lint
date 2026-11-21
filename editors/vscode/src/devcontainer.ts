// The q dev container template (#977), as data: the files **Add q Dev
// Container Configuration** offers to write, and which of them it may.
// No `vscode` import, so node tests it; `devcontainerview.ts` shows them
// and writes only on the user's word, and never over a file.
//
// The container is a plain Ubuntu one with this extension in it. KDB-X is
// installed into `~/.kx` after it is created, by KX's own installer as
// code.kx.com's KDB-X install page gives it: a download with your token
// from the KX Developer Center and your base64 licence. Both are secrets,
// so the template names them and never holds them: in Codespaces they are
// Codespaces secrets, which the container is given as variables; in a local
// container the script, run by hand in its terminal, asks for them without
// echoing them. Without them the container still starts, and the script
// says what to do.

export const DEVCONTAINER_COMMAND = "q-lint.addDevContainer";

export interface TemplateFile {
  /// Relative to the workspace folder, with `/`.
  path: string;
  content: string;
}

const INSTALL_PAGE = "https://code.kx.com/get_started/kdb-x-install.html";

const devcontainer = {
  name: "q (KDB-X)",
  image: "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  // Codespaces asks for these when a codespace is created.
  secrets: {
    KX_DOWNLOAD_TOKEN: {
      description: "Your KDB-X download token: the bearer token in the install command the KX Developer Center gives you.",
      documentationUrl: INSTALL_PAGE,
    },
    KDB_LICENSE_B64: {
      description: "Your KDB-X licence, base64-encoded (kc.lic): the --b64lic value of that install command.",
      documentationUrl: INSTALL_PAGE,
    },
  },
  postCreateCommand: "bash .devcontainer/install-kdbx.sh",
  customizations: {
    vscode: {
      extensions: ["wojdalski.q-lint"],
      settings: { "q-lint.terminal.qBinary": "~/.kx/bin/q" },
    },
  },
};

const install = `#!/usr/bin/env bash
# Install KDB-X into ~/.kx with KX's installer, as ${INSTALL_PAGE}
# gives it. Run once when the dev container is created; run it again by hand
# in the container's terminal, where it asks for what is not set. It never
# prints them.
#
#   KX_DOWNLOAD_TOKEN   the bearer token in the KX Developer Center's install command
#   KDB_LICENSE_B64     your kc.lic, base64-encoded (its --b64lic value)
#   KDB_LICENSE_K4B64   or, for a commercial k4.lic, that one base64-encoded
set -euo pipefail

if [ -x "$HOME/.kx/bin/q" ]; then
  echo "KDB-X is already installed in ~/.kx."
  exit 0
fi
# Run by hand in a terminal, ask for what is missing, without echoing it.
if [ -t 0 ] && [ -z "\${KX_DOWNLOAD_TOKEN:-}" ]; then
  read -rsp "KX download token: " KX_DOWNLOAD_TOKEN && echo
fi
if [ -t 0 ] && [ -z "\${KDB_LICENSE_B64:-}" ] && [ -z "\${KDB_LICENSE_K4B64:-}" ]; then
  read -rsp "Base64 licence (kc.lic): " KDB_LICENSE_B64 && echo
fi
if [ -z "\${KX_DOWNLOAD_TOKEN:-}" ] || { [ -z "\${KDB_LICENSE_B64:-}" ] && [ -z "\${KDB_LICENSE_K4B64:-}" ]; }; then
  echo "KDB-X was not installed: KX_DOWNLOAD_TOKEN and KDB_LICENSE_B64 (or KDB_LICENSE_K4B64) are not set."
  echo "In Codespaces, add them as Codespaces secrets for this repository; in a local container, run this in its terminal and it asks for them."
  echo "Then run: bash .devcontainer/install-kdbx.sh"
  echo "See ${INSTALL_PAGE}"
  exit 0
fi
if ! command -v curl >/dev/null || ! command -v unzip >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y curl unzip
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -sSLO --fail-with-body --oauth2-bearer "$KX_DOWNLOAD_TOKEN" \\
  https://portal.dl.kx.com/assets/raw/kdb-x/install_kdb/~latest~/install_kdb.sh
if [ -n "\${KDB_LICENSE_K4B64:-}" ]; then
  bash install_kdb.sh --k4b64lic "$KDB_LICENSE_K4B64"
else
  bash install_kdb.sh --b64lic "$KDB_LICENSE_B64"
fi
"$HOME/.kx/bin/q" -q <<'Q'
-1 "KDB-X ",(string .z.K)," ",(string .z.k)," installed";
exit 0
Q
`;

/// The template's files.
export function templateFiles(): TemplateFile[] {
  return [
    { path: ".devcontainer/devcontainer.json", content: `${JSON.stringify(devcontainer, null, 2)}\n` },
    { path: ".devcontainer/install-kdbx.sh", content: install },
  ];
}

/// The files of `files` to write, and those left because `exists` says
/// they are already there: nothing is ever written over.
export function plan(files: TemplateFile[], exists: (relative: string) => boolean): { write: TemplateFile[]; skip: string[] } {
  const write: TemplateFile[] = [];
  const skip: string[] = [];
  for (const file of files) {
    if (exists(file.path)) {
      skip.push(file.path);
    } else {
      write.push(file);
    }
  }
  return { write, skip };
}

/// The preview shown before anything is written: each file to write in
/// full, and each one left as it is.
export function previewText(folder: string, files: { write: TemplateFile[]; skip: string[] }): string {
  const lines = [`# q dev container for ${folder}`, "", "Nothing is written until you choose **Write** in the dialog.", ""];
  for (const skipped of files.skip) {
    lines.push(`- \`${skipped}\` is already there and is left as it is.`);
  }
  if (files.skip.length > 0) {
    lines.push("");
  }
  for (const file of files.write) {
    const fence = file.content.includes("```") ? "````" : "```";
    lines.push(`## ${file.path}`, "", `${fence}${file.path.endsWith(".json") ? "json" : "bash"}`, file.content.trimEnd(), fence, "");
  }
  return lines.join("\n");
}

/// `q-lint.devContainer.enable`.
export function readDevContainer(get: <T>(key: string, fallback: T) => T): { enabled: boolean } {
  return { enabled: get<unknown>("devContainer.enable", true) !== false };
}
