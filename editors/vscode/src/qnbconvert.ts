// A q notebook as another file (#948): a self-contained HTML page, a Jupyter
// notebook (`.ipynb`), and a Jupyter notebook read back as a q notebook.
// Free of any `vscode` import, so a test - and the headless runner
// `qnbrun.ts` - can use it.
//
// HTML: one file with its style inline and no script. Every piece of text
// from the notebook - Markdown, code, outputs, live values - is escaped; an
// output's `text/html`, which a notebook from anywhere could fill with
// script, is not copied in: its `text/plain` view is shown instead, as is a
// chart's. Markdown is the common part of CommonMark - headings, paragraphs,
// lists, quotes, code, emphasis, links to http, https and mailto - written
// here rather than taken from a library.
//
// ipynb: nbformat 4.4. A q cell is a code cell; a cell in another language
// says so in `metadata.vscode.languageId`, as VS Code's own Jupyter support
// writes it. Outputs keep their mime types; an error is Jupyter's error
// output. Read back, a code cell is q when the cell or the notebook says q
// - or says nothing - and keeps its language otherwise; a `%%q` cell of a
// Python notebook (PyKX's magic) is q, without the magic line.
import { escapeHtml } from "./celldata";
import { inlineSpans, storedValues, type LiveValue } from "./livemarkdown";
import type { Qnb, QnbCell, QnbItem, QnbOutput } from "./qnb";

/// VS Code's mime types for an error and for the two streams.
export const ERROR_MIME = "application/vnd.code.notebook.error";
export const STDERR_MIME = "application/vnd.code.notebook.stderr";
export const STDOUT_MIME = "application/vnd.code.notebook.stdout";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const itemText = (item: QnbItem): string => item.text ?? Buffer.from(item.base64 ?? "", "base64").toString("utf8");

// --- HTML

/// A link's target, when it is one a page may follow.
const safeHref = (href: string): string | undefined => (/^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined);

/// One line of Markdown's inline text as HTML: code spans as they are,
/// live values as `liveHtml` writes them, everything escaped.
function inline(text: string, values: Record<string, LiveValue>): string {
  const held: string[] = [];
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;
  let s = "";
  let from = 0;
  for (const span of inlineSpans(text)) {
    s += text.slice(from, span.start) + hold(span.kind === "code" ? `<code>${escapeHtml(span.expr.trim())}</code>` : liveHtml(span.expr, values[span.expr]));
    from = span.end;
  }
  s = escapeHtml((s + text.slice(from)).replace(/\\([\\`*_{}[\]()#+\-.!])/g, (_m, c: string) => hold(escapeHtml(c))));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
    // `href` is escaped already: `&amp;` reads back as `&` in an attribute.
    // The tags are held, so the emphasis below finds no `_` in the URL (#1105).
    const target = safeHref(href.replace(/&amp;/g, "&"));
    return target === undefined ? m : `${hold(`<a href="${escapeHtml(target)}">`)}${label}${hold("</a>")}`;
  });
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  s = s.replace(/(^|[^\w*])([*_])(?=\S)([^*_]*?\S)\2(?!\w)/g, "$1<em>$3</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]);
}

/// A live value as HTML, or the expression as written when it has none.
export function liveHtml(expr: string, value: LiveValue | undefined): string {
  const title = `q: ${escapeHtml(expr)}`;
  if (value !== undefined && "text" in value) {
    return `<span class="live" title="${title}">${escapeHtml(value.text)}</span>`;
  }
  if (value !== undefined && "error" in value) {
    return `<span class="live error" title="${title}">'${escapeHtml(value.error)}</span>`;
  }
  return `<code>{{q: ${escapeHtml(expr)}}}</code>`;
}

/// A Markdown cell as HTML, its live values from `values`.
export function markdownHtml(source: string, values: Record<string, LiveValue> = {}): string {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  const flush = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map((l) => inline(l, values)).join("<br>\n")}</p>`);
      paragraph = [];
    }
    if (list !== undefined) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, values)}</li>`).join("")}</${list.tag}>`);
      list = undefined;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (fence !== null) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) {
        code.push(lines[i]);
      }
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const item = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (line.trim() === "") {
      flush();
    } else if (heading !== null) {
      flush();
      out.push(`<h${heading[1].length}>${inline(heading[2], values)}</h${heading[1].length}>`);
    } else if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
    } else if (/^ {0,3}>/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^ {0,3}>/.test(lines[i]); i++) {
        quote.push(lines[i].replace(/^ {0,3}> ?/, ""));
      }
      i--;
      out.push(`<blockquote>${markdownHtml(quote.join("\n"), values)}</blockquote>`);
    } else if (item !== null) {
      if (paragraph.length > 0) {
        flush();
      }
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (list !== undefined && list.tag !== tag) {
        flush();
      }
      list ??= { tag, items: [] };
      list.items.push(item[2]);
    } else if (list !== undefined && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list !== undefined) {
        flush();
      }
      paragraph.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

/// An output as HTML: what it shows as text, escaped.
function outputHtml(output: QnbOutput): string {
  const by = (mime: string): QnbItem | undefined => output.items.find((i) => i.mime === mime);
  const error = by(ERROR_MIME);
  if (error !== undefined) {
    let parsed: Json = {};
    try {
      const json: unknown = JSON.parse(itemText(error));
      parsed = isObject(json) ? json : {};
    } catch {
      parsed = { message: itemText(error) };
    }
    const stack = typeof parsed.stack === "string" && parsed.stack !== "" ? parsed.stack : String(parsed.message ?? "");
    return `<pre class="out error">${escapeHtml(stack)}</pre>`;
  }
  const stderr = by(STDERR_MIME);
  if (stderr !== undefined) {
    return `<pre class="out stderr">${escapeHtml(itemText(stderr))}</pre>`;
  }
  const image = output.items.find((i) => /^image\/(png|jpeg|gif)$/.test(i.mime) && i.base64 !== undefined);
  if (image !== undefined && /^[A-Za-z0-9+/=\s]*$/.test(image.base64 ?? "")) {
    return `<img class="out" alt="" src="data:${image.mime};base64,${(image.base64 ?? "").replace(/\s/g, "")}">`;
  }
  const text = by("text/plain") ?? by(STDOUT_MIME) ?? output.items.find((i) => i.mime.startsWith("text/") && i.mime !== "text/html");
  if (text !== undefined) {
    return `<pre class="out">${escapeHtml(itemText(text))}</pre>`;
  }
  return `<pre class="out note">${escapeHtml(`(an output of ${output.items.map((i) => i.mime).join(", ")}, not shown here)`)}</pre>`;
}

const PAGE_STYLE = [
  ":root{color-scheme:light dark;--fg:#1f2328;--bg:#ffffff;--muted:#59636e;--code:#f6f8fa;--line:#d1d9e0;--err:#cf222e}",
  "@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--code:#151b23;--line:#3d444d;--err:#ff7b72}}",
  "body{margin:0 auto;max-width:960px;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}",
  "pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}",
  "pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:8px 12px;overflow-x:auto;white-space:pre}",
  ".cell{margin:16px 0}.code pre.src{border-left:3px solid #2f81f7}",
  ".order{color:var(--muted);font:12px ui-monospace,monospace;margin-bottom:2px}",
  "pre.out{background:none;border-style:dashed}pre.error,.live.error{color:var(--err)}pre.stderr{color:var(--muted)}",
  ".live{font-family:ui-monospace,monospace;font-weight:600}img.out{max-width:100%}",
  "blockquote{border-left:3px solid var(--line);margin:0;padding-left:12px;color:var(--muted)}",
].join("\n");

/// The notebook as one HTML page: its cells in order, code with what it
/// last showed, Markdown rendered with its live values. `title` names the
/// page.
export function toHtml(qnb: Qnb, title: string): string {
  const cells = qnb.cells.map((cell) => {
    if (cell.kind === "markdown") {
      return `<section class="cell markdown">${markdownHtml(cell.source, storedValues(cell.metadata))}</section>`;
    }
    const order = cell.execution?.order;
    const language = cell.language ?? "q";
    const head = `<div class="order">${escapeHtml(`${language === "q" ? "" : `${language} `}[${order ?? " "}]`)}</div>`;
    const outputs = (cell.outputs ?? []).map(outputHtml).join("\n");
    return `<section class="cell code">${head}<pre class="src"><code>${escapeHtml(cell.source)}</code></pre>${outputs}</section>`;
  });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // No script runs, nothing is fetched: images are the notebook's own.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    ...cells,
    `<footer class="order">${escapeHtml(`Exported by q-lint from ${title}.`)}</footer>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// --- ipynb

/// A string as Jupyter's list of lines, each but the last ending in "\n".
const jupyterLines = (text: string): string[] => {
  const parts = text.split(/(?<=\n)/);
  return parts.length === 1 && parts[0] === "" ? [] : parts;
};
const joined = (v: unknown): string => (Array.isArray(v) ? v.map(String).join("") : typeof v === "string" ? v : "");

/// The mime types Jupyter keeps as JSON rather than as text.
const isJsonMime = (mime: string): boolean => /^application\/(.+\+)?json$/.test(mime);

function outputToJupyter(output: QnbOutput, order: number | undefined, last: boolean): Json {
  const error = output.items.find((i) => i.mime === ERROR_MIME);
  if (error !== undefined) {
    let e: Json = {};
    try {
      const json: unknown = JSON.parse(itemText(error));
      e = isObject(json) ? json : {};
    } catch {
      e = { message: itemText(error) };
    }
    const stack = typeof e.stack === "string" && e.stack !== "" ? e.stack : String(e.message ?? "");
    return { output_type: "error", ename: String(e.name ?? "error"), evalue: String(e.message ?? ""), traceback: stack.split("\n") };
  }
  const stream = output.items.find((i) => i.mime === STDERR_MIME || i.mime === STDOUT_MIME);
  if (stream !== undefined && output.items.length === 1) {
    return { output_type: "stream", name: stream.mime === STDERR_MIME ? "stderr" : "stdout", text: jupyterLines(itemText(stream)) };
  }
  const data: Json = {};
  for (const item of output.items) {
    if (item.base64 !== undefined) {
      data[item.mime] = item.base64;
    } else if (isJsonMime(item.mime)) {
      try {
        data[item.mime] = JSON.parse(item.text ?? "");
      } catch {
        data[item.mime] = jupyterLines(item.text ?? "");
      }
    } else {
      data[item.mime] = jupyterLines(item.text ?? "");
    }
  }
  // The last output of a cell that ran is its value, as Jupyter numbers one.
  return last && order !== undefined
    ? { output_type: "execute_result", execution_count: order, data, metadata: output.metadata ?? {} }
    : { output_type: "display_data", data, metadata: output.metadata ?? {} };
}

/// The notebook as an nbformat 4.4 Jupyter notebook, as JSON text.
export function toIpynb(qnb: Qnb): string {
  const cells = qnb.cells.map((cell): Json => {
    if (cell.kind === "markdown") {
      return { cell_type: "markdown", metadata: cell.metadata ?? {}, source: jupyterLines(cell.source) };
    }
    const language = cell.language ?? "q";
    const metadata: Json = { ...(cell.metadata ?? {}) };
    if (language !== "q") {
      metadata.vscode = { ...(isObject(metadata.vscode) ? metadata.vscode : {}), languageId: language };
    }
    const order = cell.execution?.order;
    const outputs = cell.outputs ?? [];
    return {
      cell_type: "code",
      execution_count: order ?? null,
      metadata,
      outputs: outputs.map((o, i) => outputToJupyter(o, order, i === outputs.length - 1)),
      source: jupyterLines(cell.source),
    };
  });
  const notebook = {
    cells,
    metadata: {
      ...(qnb.metadata ?? {}),
      kernelspec: { display_name: "q (kdb+)", language: "q", name: "qpk" },
      language_info: { name: "q", file_extension: ".q", mimetype: "text/x-q" },
    },
    nbformat: 4,
    nbformat_minor: 4,
  };
  return JSON.stringify(notebook, null, 1) + "\n";
}

export class IpynbError extends Error {}

/// Jupyter's traceback lines, without the terminal colours IPython puts in.
const plainTrace = (v: unknown): string => (Array.isArray(v) ? v.map(String).join("\n") : "").replace(/\u001b\[[0-9;]*m/g, "");

function outputFromJupyter(raw: unknown): QnbOutput | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  switch (raw.output_type) {
    case "stream":
      return { items: [{ mime: raw.name === "stderr" ? STDERR_MIME : STDOUT_MIME, text: joined(raw.text) }] };
    case "error": {
      const name = String(raw.ename ?? "error");
      const message = String(raw.evalue ?? "");
      return { items: [{ mime: ERROR_MIME, text: JSON.stringify({ name, message, stack: plainTrace(raw.traceback) }) }] };
    }
    case "execute_result":
    case "display_data": {
      const data = isObject(raw.data) ? raw.data : {};
      const items = Object.entries(data).map(([mime, value]): QnbItem => {
        if (isJsonMime(mime) && typeof value !== "string" && !Array.isArray(value)) {
          return { mime, text: JSON.stringify(value) };
        }
        const text = joined(value);
        // Jupyter keeps an image's bytes as base64 text.
        return mime.startsWith("image/") && mime !== "image/svg+xml" ? { mime, base64: text.replace(/\s/g, "") } : { mime, text };
      });
      return items.length === 0 ? undefined : { items, ...(isObject(raw.metadata) && Object.keys(raw.metadata).length > 0 ? { metadata: raw.metadata } : {}) };
    }
    default:
      return undefined;
  }
}

/// A Jupyter notebook's JSON text as a q notebook. Throws an `IpynbError`
/// saying what is wrong when it is not one.
export function fromIpynb(raw: string): Qnb {
  let json: unknown;
  try {
    json = JSON.parse(raw.startsWith("﻿") ? raw.slice(1) : raw);
  } catch (error) {
    throw new IpynbError(`not a Jupyter notebook: the file is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isObject(json) || !Array.isArray(json.cells)) {
    throw new IpynbError('not a Jupyter notebook: expected a JSON object with "cells" (nbformat 4)');
  }
  if (typeof json.nbformat === "number" && json.nbformat < 4) {
    throw new IpynbError(`this is nbformat ${json.nbformat}; q-lint reads nbformat 4. Jupyter's \`jupyter nbconvert --to notebook\` upgrades it.`);
  }
  const meta = isObject(json.metadata) ? json.metadata : {};
  const info = isObject(meta.language_info) ? meta.language_info : {};
  const spec = isObject(meta.kernelspec) ? meta.kernelspec : {};
  const notebookLanguage = String(info.name ?? spec.language ?? "q").toLowerCase();
  const cells = json.cells.map((cell, i): QnbCell => {
    if (!isObject(cell)) {
      throw new IpynbError(`cell ${i + 1} is not an object`);
    }
    const source = joined(cell.source);
    const metadata = isObject(cell.metadata) ? { ...cell.metadata } : {};
    const extra = cell.attachments !== undefined ? { extra: { attachments: cell.attachments } } : {};
    const kept = Object.keys(metadata).length > 0 ? { metadata } : {};
    if (cell.cell_type === "markdown") {
      return { kind: "markdown", source, ...kept, ...extra };
    }
    if (cell.cell_type === "raw") {
      return { kind: "code", source, language: "raw", ...kept };
    }
    const vscode = isObject(metadata.vscode) ? metadata.vscode : undefined;
    let language = typeof vscode?.languageId === "string" ? vscode.languageId.toLowerCase() : notebookLanguage;
    let code = source;
    const magic = /^%%q[ \t]*(\r?\n|$)/.exec(source);
    if (magic !== null) {
      language = "q";
      code = source.slice(magic[0].length);
    }
    if (vscode !== undefined) {
      const { languageId: _id, ...rest } = vscode;
      if (Object.keys(rest).length > 0) {
        metadata.vscode = rest;
      } else {
        delete metadata.vscode;
      }
    }
    const outputs = (Array.isArray(cell.outputs) ? cell.outputs : []).map(outputFromJupyter).filter((o): o is QnbOutput => o !== undefined);
    const order = typeof cell.execution_count === "number" ? cell.execution_count : undefined;
    return {
      kind: "code",
      source: code,
      ...(language === "q" ? {} : { language }),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(order !== undefined ? { execution: { order } } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });
  return { cells };
}

