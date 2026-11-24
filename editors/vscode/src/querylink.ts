// Shareable query links (#1038), as data: a `vscode://` link that names a
// process by its label and holds a query, and what one says when opened.
// No `vscode` import, so node tests it; `querylinkview.ts` copies links and
// opens them. Opening one never runs anything unasked: it shows the query
// and asks before running it.
//
// The link: `<scheme>://wojdalski.q-lint/query?process=<label>&code=<q>`,
// both in base64url: VS Code hands a link's query over decoded, so a `&`
// or `%` in q code would otherwise cut it. The label is only a name:
// whoever opens the link runs the query on their own process of that
// label, with their own password.

export const LINK_PATH = "/query";
/// Longer links are refused: some chat tools and browsers cut them.
export const LINK_MAX = 8000;

/// The link for `code` on the process labelled `label`, or why there is
/// none.
export function queryLink(scheme: string, extensionId: string, label: string | undefined, code: string): { link: string } | { problem: string } {
  if (code.trim() === "") {
    return { problem: "there is no query to link to" };
  }
  const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
  const query = [...(label !== undefined ? [`process=${b64(label)}`] : []), `code=${b64(code)}`].join("&");
  const link = `${scheme}://${extensionId.toLowerCase()}${LINK_PATH}?${query}`;
  return link.length > LINK_MAX ? { problem: `the link would be ${link.length} characters, over ${LINK_MAX}: share the query as a file instead` } : { link };
}

/// The longest query a link's Run prompt shows, whole, in characters and in
/// lines.
export const PROMPT_LIMIT = 2000;
export const PROMPT_LINES = 40;

/// Why the Run prompt cannot show `code` whole, so Run is not offered, or
/// undefined when it can (#1620). Under the length limit, a statement could
/// still sit far below the first line, after blank lines or a run of spaces
/// the dialog wraps, or behind a control, zero-width or bidi character that
/// hides or reorders what is shown (#1828).
export function promptProblem(code: string): string | undefined {
  if (code.length > PROMPT_LIMIT) {
    return `longer than ${PROMPT_LIMIT} characters`;
  }
  if (code.split("\n").length > PROMPT_LINES) {
    return `longer than ${PROMPT_LINES} lines`;
  }
  if (/\n[ \t\r]*\n[ \t\r]*\n[ \t\r]*\n/.test(code) || /[ \t]{40}/.test(code)) {
    return "spread out by blank lines or spaces";
  }
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(code.replace(/\r\n/g, "\n"))) {
    return "holding a control, zero-width or bidi character";
  }
  return undefined;
}

/// What an opened link asks for: its query and process, or why it is not
/// a query link. `path` and `query` are the URI's.
export function readQueryLink(path: string, query: string): { code: string; process?: string } | { problem: string } {
  if (path !== LINK_PATH) {
    return { problem: `q-lint opens no link to ${path}` };
  }
  const params = new Map<string, string>();
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    if (at <= 0) {
      continue;
    }
    const value = part.slice(at + 1);
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) {
      return { problem: "the link is not encoded as q-lint encodes one" };
    }
    params.set(part.slice(0, at), Buffer.from(value, "base64url").toString("utf8"));
  }
  const code = params.get("code");
  if (code === undefined || code.trim() === "") {
    return { problem: "the link holds no query" };
  }
  const process = params.get("process");
  return { code, ...(process !== undefined && process.trim() !== "" ? { process } : {}) };
}
