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
