// The q idiom snippets (#944): joins (aj, wj, lj, ...), a bucketed select,
// the `.z` handlers and a TorQ process skeleton, from `snippets/idioms.json`.
// Free of any `vscode` import, so a test can drive it; `idiomsview.ts`
// offers them.
//
// They are not in package.json's `snippets`, which VS Code reads with no way
// to turn a file off: q-lint.idiomSnippets.enable has to, so a completion
// provider offers them while it is on. The file is in the snippet format
// package.json's are, and the same test lints every body (`tests/snippets.rs`).

export interface Idiom {
  name: string;
  prefix: string;
  body: string;
  description: string;
}

/// The idioms in the snippet file's text; one that is not well formed is
/// left out.
export function readIdioms(text: string): Idiom[] {
  const all = JSON.parse(text) as Record<string, { prefix?: unknown; body?: unknown; description?: unknown }>;
  const out: Idiom[] = [];
  for (const [name, snippet] of Object.entries(all)) {
    const body = Array.isArray(snippet.body) && snippet.body.every((l) => typeof l === "string") ? snippet.body.join("\n") : snippet.body;
    const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
    if (typeof body !== "string" || typeof snippet.description !== "string") {
      continue;
    }
    for (const prefix of prefixes) {
      if (typeof prefix === "string" && prefix !== "") {
        out.push({ name, prefix, body, description: snippet.description });
      }
    }
  }
  return out;
}

/// Where the word being typed at `character` of `line` starts: the word
/// before the cursor, a `.` in it included, so `.z.p` is replaced whole. A
/// name starts at no digit or `_`: after a drop written without spaces
/// (`-1_tra`, `0x00_x`) it is `tra`, past the number and its `_` (#1992).
export function wordStart(line: string, character: number): number {
  const m = /[.A-Za-z0-9_]*$/.exec(line.slice(0, character));
  const word = (m?.[0] ?? "").replace(/^(?:(?:\.?\d[A-Za-z0-9.]*)?_+)+/, "");
  return character - word.length;
}

/// A snippet body as it reads once inserted with its defaults, for the
/// completion list's preview: `${1:x}` is x, `$1` nothing, and `\$`, `\}` and
/// `\\` the character escaped.
export function preview(body: string): string {
  let out = body;
  for (let i = 0; i < 4; i++) {
    out = out.replace(/\$\{\d+:([^${}]*)\}/g, "$1");
  }
  return out.replace(/\$\{\d+\}|\$\d+/g, "").replace(/\\([$}\\])/g, "$1");
}
