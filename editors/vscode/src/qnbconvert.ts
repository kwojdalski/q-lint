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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };

/// The character an entity names (`lt`, `#60`, `#x3c`), if it names one.
function entity(name: string): string | undefined {
  if (!name.startsWith("#")) {
    return ENTITIES[name];
  }
  const code = /^#[xX]/.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

/// A GFM table row's cells: split on the pipes not escaped, the outer ones
/// dropped, an escaped pipe a pipe.
function tableCells(line: string): string[] {
  const row = line.trim().replace(/^\|/, "").replace(/(^|[^\\])\|$/, "$1");
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/// Markdown's inline text as HTML: code spans as they are, live values as
/// `liveHtml` writes them, everything escaped. A paragraph or an item is
/// read whole, as `liveQueries` reads it, so a `{{q: }}` over two lines is
/// one value under the key the run kept it by (#2149); a line's trailing
/// blanks go, and with `breaks` two spaces or a backslash at a line's end
/// is a `<br>` (#1945).
function inline(text: string, values: Record<string, LiveValue>, breaks = false): string {
  const held: string[] = [];
  // What each held piece is as plain text, for a link's target: a URL is
  // text, and none of the page's HTML (#1942).
  const plain: string[] = [];
  const hold = (html: string, text = ""): string => {
    plain.push(text);
    return `\u0000${held.push(html) - 1}\u0000`;
  };
  let s = "";
  let from = 0;
  for (const span of inlineSpans(text)) {
    // A tag is shown as written, as the page shows no HTML of the notebook's.
    const html = span.kind === "code" ? `<code>${escapeHtml(span.expr.trim())}</code>` : span.kind === "html" ? escapeHtml(span.expr) : liveHtml(span.expr, values[span.expr]);
    s += text.slice(from, span.start) + hold(html, text.slice(span.start, span.end));
    from = span.end;
  }
  s += text.slice(from);
  if (breaks) {
    s = s.replace(/(?<!\\)((?:\\\\)*)\\\n/g, (_m, pairs: string) => `${pairs}${hold("<br>")}\n`).replace(/[ \t]* {2}\n/g, () => `${hold("<br>")}\n`);
  }
  s = s.replace(/[ \t]+\n/g, "\n");
  // A backslash escapes any ASCII punctuation (CommonMark 2.4, #1310).
  s = escapeHtml(
    s
      .replace(/\\([!-/:-@[-`{-~])/g, (_m, c: string) => hold(escapeHtml(c), c))
      // The entities a result's table is written with (#1309).
      .replace(/&(amp|lt|gt|quot|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g, (m, e: string) => hold(escapeHtml(entity(e) ?? m), entity(e) ?? m))
      // Any other named one as it is, which the page shows as its
      // character, or as written when HTML has no such name (#1552).
      .replace(/&[A-Za-z][A-Za-z0-9]{1,31};/g, (m) => hold(m, m)),
  );
  // `href` is escaped already: read it back to the URL written, or it is
  // escaped twice (`'` as `&amp;#39;`, #1476). What was held in it - an
  // entity, an escaped character, a `{{q: }}` - goes back as the text it
  // stands for, before the URL is checked and escaped (#1942).
  const unescaped = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" } as Record<string, string>;
  const url = (href: string): string =>
    href.replace(/&(amp|lt|gt|quot|#39);/g, (e) => unescaped[e]).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => plain[Number(i)] ?? "");
  /// A target a page may follow: `safeHref`'s, and with no blank in it,
  /// which a held piece may bring: a destination with a blank is no link.
  const followed = (href: string): string | undefined => (/\s/.test(url(href).trim()) ? undefined : safeHref(url(href)));
  // A title after the target, in either quote or in brackets: the tip
  // the notebook shows, and text as the URL is (#1944).
  const TITLE = String.raw`(?:\s+(?:&quot;(.*?)&quot;|&#39;(.*?)&#39;|\(([^()]*)\)))?`;
  const titled = (...titles: (string | undefined)[]): string => {
    const title = titles.find((t) => t !== undefined);
    return title === undefined ? "" : ` title="${escapeHtml(url(title))}"`;
  };
  // An image: one in the page as a data: URL is shown, as Send to
  // Notebook's chart is; another is a link to it, or its alt text (#1555).
  s = s.replace(new RegExp(String.raw`!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)${TITLE}\)`, "g"), (m, alt: string, src: string, a?: string, b?: string, c?: string) => {
    if (/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(src)) {
      return hold(`<img alt="${alt.replace(/\u0000\d+\u0000/g, "")}" src="${src}"${titled(a, b, c)}>`);
    }
    const target = followed(src);
    // Its alt text alone, or with a title all of it as written.
    return target === undefined ? (titled(a, b, c) === "" ? alt : m) : `${hold(`<a href="${escapeHtml(target)}"${titled(a, b, c)}>`)}${alt}${hold("</a>")}`;
  });
  // A URL may hold balanced parentheses, as Wikipedia's do (#1554).
  s = s.replace(new RegExp(String.raw`\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)${TITLE}\)`, "g"), (m, label: string, href: string, a?: string, b?: string, c?: string) => {
    // The tags are held, so the emphasis below finds no `_` in the URL (#1105).
    const target = followed(href);
    return target === undefined ? m : `${hold(`<a href="${escapeHtml(target)}"${titled(a, b, c)}>`)}${label}${hold("</a>")}`;
  });
  // A run of three first, so its tags nest (#1550). An underscore run
  // inside a word is text (#1556), as `_` is below.
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*|(^|[^\w])___(?=\S)([\s\S]*?\S)___(?!\w)/g, (_m, a: string | undefined, before: string, b: string) =>
    a !== undefined ? `<em><strong>${a}</strong></em>` : `${before}<em><strong>${b}</strong></em>`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*|(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, (_m, a: string | undefined, before: string, b: string) =>
    a !== undefined ? `<strong>${a}</strong>` : `${before}<strong>${b}</strong>`);
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
  // An item: its text, the column that text starts at, and the lines
  // written under it from that column on - a list of its own (#1943).
  let list: { tag: "ul" | "ol"; start: number; items: { text: string; column: number; under: string[] }[] } | undefined;
  // Whether the last line not indented was a list item's.
  let listed = false;
  const flush = (): void => {
    if (paragraph.length > 0) {
      // A line's end is a space, as the notebook shows it: a break only
      // after two spaces or a backslash not itself escaped (#1945).
      out.push(`<p>${inline(paragraph.join("\n").trimEnd(), values, true)}</p>`);
      paragraph = [];
    }
    if (list !== undefined) {
      const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
      const item = (i: { text: string; under: string[] }): string =>
        `<li>${inline(i.text, values)}${i.under.length > 0 ? markdownHtml(i.under.join("\n"), values) : ""}</li>`;
      out.push(`<${list.tag}${start}>${list.items.map(item).join("")}</${list.tag}>`);
      list = undefined;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A list under the last item: a line indented to the item's text that
    // starts an item, and what follows it there. It is that item's own
    // Markdown, as a quote's lines are the quote's (#1943).
    const last = list?.items[list.items.length - 1];
    const indent = (/^[ \t]*/.exec(line) as RegExpExecArray)[0].replace(/\t/g, "    ");
    if (last !== undefined && line.trim() !== "" && indent.length >= last.column) {
      const under = indent.slice(last.column) + line.trimStart();
      if (last.under.length > 0 || /^ {0,3}([-*+]|\d{1,9}[.)])(?:\s|$)/.test(under)) {
        last.under.push(under);
        continue;
      }
    }
    // A backtick fence's info string holds no backtick: "```a``` b" is a
    // line of text with a code span in it, not a fence (#1307).
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      flush();
      // Closed only by a bare run of the same character, at least as long:
      // a "```q" inside is code (#1308).
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const code: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) {
        code.push(lines[i]);
      }
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    // An indented code block, where `liveExpressions` reads one: not under
    // a paragraph line or a list item (#1553). Blank lines inside it are
    // its; those after it are not.
    if (/^(?: {4}|\t)/.test(line) && line.trim() !== "" && paragraph.length === 0 && !listed) {
      flush();
      const code: string[] = [];
      for (; i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || lines[i].trim() === ""); i++) {
        code.push(lines[i].replace(/^(?: {4}|\t)/, ""));
      }
      while (code[code.length - 1].trim() === "") {
        code.pop();
      }
      i--;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() !== "" && !/^(?: {4}|\t)/.test(line)) {
      listed = /^ {0,3}([-*+]|\d{1,9}[.)])(?:\s|$)/.test(line);
    }
    // A GFM table: a header row, a delimiter row of as many cells, then
    // rows up to a blank line (#1309).
    const delimiter = i + 1 < lines.length ? tableCells(lines[i + 1]) : [];
    if (
      line.includes("|") &&
      /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "") &&
      tableCells(line).length === delimiter.length
    ) {
      flush();
      const align = delimiter.map((d) => (d.endsWith(":") ? (d.startsWith(":") ? "center" : "right") : d.startsWith(":") ? "left" : ""));
      const cell = (tag: string, text: string, at: number): string =>
        `<${tag}${align[at] ? ` style="text-align:${align[at]}"` : ""}>${inline(text, values)}</${tag}>`;
      const head = tableCells(line).map((c, at) => cell("th", c, at));
      const body: string[] = [];
      for (i += 2; i < lines.length && lines[i].trim() !== "" && !/^ {0,3}(`{3,}|~{3,}|#{1,6}\s|>)/.test(lines[i]); i++) {
        const cells = tableCells(lines[i]);
        body.push(`<tr>${align.map((_a, at) => cell("td", cells[at] ?? "", at)).join("")}</tr>`);
      }
      i--;
      out.push(`<table><thead><tr>${head.join("")}</tr></thead>${body.length > 0 ? `<tbody>${body.join("")}</tbody>` : ""}</table>`);
      continue;
    }
    // A closing run of `#` only after a space: `# Using C#` keeps its `#`
    // (CommonMark, #1237).
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*$/.exec(line);
    const item = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (line.trim() === "") {
      flush();
    } else if (paragraph.length > 0 && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      // A setext heading: the paragraph above a line of = or - (#1551).
      const level = line.trim()[0] === "=" ? 1 : 2;
      out.push(`<h${level}>${inline(paragraph.join("\n").trimEnd(), values)}</h${level}>`);
      paragraph = [];
    } else if (heading !== null) {
      flush();
      const text = heading[2].replace(/(^|\s+)#+$/, "");
      out.push(`<h${heading[1].length}>${inline(text, values)}</h${heading[1].length}>`);
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
    } else if (item !== null && (paragraph.length === 0 || (item[2].trim() !== "" && /^([-*+]|0*1[.)])$/.test(item[1])))) {
      // Only a bullet or a "1." with text interrupts a paragraph: "in
      // 2024. it ran" goes on with it (CommonMark 5.2, #1311).
      if (paragraph.length > 0) {
        flush();
      }
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (list !== undefined && list.tag !== tag) {
        flush();
      }
      list ??= { tag, start: tag === "ol" ? parseInt(item[1], 10) : 1, items: [] };
      list.items.push({ text: item[2], column: line.length - item[2].length, under: [] });
    } else if (list !== undefined && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1].text += `\n${line.trim()}`;
    } else {
      if (list !== undefined) {
        flush();
      }
      paragraph.push(line.trimStart());
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
  "table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid var(--line);padding:4px 8px}",
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
  // An output read from a Jupyter notebook is of the type it had there
  // (#1946). Of those made here, the last one of a cell that ran is its
  // value, as Jupyter numbers one.
  const type = output.extra?.output_type;
  return type === "execute_result" || (type !== "display_data" && last && order !== undefined)
    ? { output_type: "execute_result", execution_count: order ?? null, data, metadata: output.metadata ?? {} }
    : { output_type: "display_data", data, metadata: output.metadata ?? {} };
}

/// The kernel and language a q notebook is written with, when it names none.
const Q_KERNEL = { display_name: "q (kdb+)", language: "q", name: "qpk" };
const Q_LANGUAGE = { name: "q", file_extension: ".q", mimetype: "text/x-q" };

/// The language of the kernel a Jupyter notebook's `metadata` names. A
/// kernelspec's `language` is optional (#2382): with none, its `name` says
/// it - `python3`, `ir`, `julia-1.10` - and only a q kernel's, or none, is q.
function kernelLanguage(meta: Json): string {
  const spec = isObject(meta.kernelspec) ? meta.kernelspec : undefined;
  const named = (isObject(meta.language_info) ? meta.language_info.name : undefined) ?? spec?.language;
  if (named !== undefined) {
    return String(named).toLowerCase();
  }
  const kernel = typeof spec?.name === "string" ? spec.name.toLowerCase() : "";
  if (kernel === "" || /^(qpk|q|kdb|kdbx?|jupyterq)$/.test(kernel)) {
    return "q";
  }
  return kernel === "ir" ? "r" : /^python/.test(kernel) ? "python" : kernel.replace(/[-_]?\d[\d.]*$/, "") || kernel;
}

/// The notebook as an nbformat 4 Jupyter notebook, as JSON text: 4.5, with
/// the cells' ids, when every cell has the id `fromIpynb` kept.
export function toIpynb(qnb: Qnb): string {
  const meta = qnb.metadata ?? {};
  // A kernel the notebook names is kept (#1548): on another language's, a q
  // cell goes back with the `%%q` magic `fromIpynb` took off.
  const language = kernelLanguage(meta);
  const magic = language !== "q";
  const ids = qnb.cells.length > 0 && qnb.cells.every((c) => typeof c.extra?.id === "string");
  const cells = qnb.cells.map((cell): Json => {
    const json = convertCell(cell, magic, language);
    return ids ? { id: cell.extra?.id, ...json } : json;
  });
  const notebook = {
    cells,
    // q's only when the notebook names no language at all: a `language_info`
    // of its own is never replaced (#2381).
    metadata: { ...meta, ...(meta.kernelspec === undefined && meta.language_info === undefined ? { kernelspec: Q_KERNEL, language_info: Q_LANGUAGE } : {}) },
    nbformat: 4,
    nbformat_minor: ids ? 5 : 4,
  };
  return JSON.stringify(notebook, null, 1) + "\n";
}

/// One cell as Jupyter writes it; `magic`: a q cell takes `%%q`. `notebook`
/// is the language of the notebook's kernel.
function convertCell(cell: QnbCell, magic: boolean, notebook: string): Json {
  // The attachments `fromIpynb` kept, which `![x](attachment:a.png)` in
  // the cell's text names (#1234).
  const attachments = cell.extra?.attachments !== undefined ? { attachments: cell.extra.attachments } : {};
  if (cell.kind === "markdown") {
    return { cell_type: "markdown", metadata: cell.metadata ?? {}, source: jupyterLines(cell.source), ...attachments };
  }
  const language = cell.language ?? "q";
  // A Jupyter raw cell, which `fromIpynb` reads as a code cell in `raw`,
  // goes back as one (#1107).
  if (language === "raw") {
    return { cell_type: "raw", metadata: cell.metadata ?? {}, source: jupyterLines(cell.source), ...attachments };
  }
  const metadata: Json = { ...(cell.metadata ?? {}) };
  // Tagged as VS Code tags one: only a cell in another language than the
  // notebook's, or a round trip rewrites every cell (#1947).
  if (language !== "q" && language !== notebook) {
    metadata.vscode = { ...(isObject(metadata.vscode) ? metadata.vscode : {}), languageId: language };
  }
  const order = cell.execution?.order;
  const outputs = cell.outputs ?? [];
  const options = /^\/ %%q ([^\r\n]*)(\r?\n|$)/.exec(cell.source);
  const source = !magic || language !== "q" ? cell.source : options !== null ? `%%q ${options[1]}\n${cell.source.slice(options[0].length)}` : `%%q\n${cell.source}`;
  return {
    cell_type: "code",
    execution_count: order ?? null,
    metadata,
    outputs: outputs.map((o, i) => outputToJupyter(o, order, i === outputs.length - 1)),
    source: jupyterLines(source),
  };
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
        // A JSON mime's value is the JSON itself, an array or a string too
        // (#1545): never Jupyter's lines of text.
        if (isJsonMime(mime)) {
          return { mime, text: JSON.stringify(value) };
        }
        const text = joined(value);
        // Jupyter keeps an image's bytes as base64 text.
        return mime.startsWith("image/") && mime !== "image/svg+xml" ? { mime, base64: text.replace(/\s/g, "") } : { mime, text };
      });
      // Which of the two it is goes with it, for `toIpynb` (#1946).
      const kept = { extra: { output_type: raw.output_type } };
      return items.length === 0 ? undefined : { items, ...(isObject(raw.metadata) && Object.keys(raw.metadata).length > 0 ? { metadata: raw.metadata } : {}), ...kept };
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
  const notebookLanguage = kernelLanguage(meta);
  const cells = json.cells.map((cell, i): QnbCell => {
    if (!isObject(cell)) {
      throw new IpynbError(`cell ${i + 1} is not an object`);
    }
    const source = joined(cell.source);
    const metadata = isObject(cell.metadata) ? { ...cell.metadata } : {};
    const fields = { ...(typeof cell.id === "string" ? { id: cell.id } : {}), ...(cell.attachments !== undefined ? { attachments: cell.attachments } : {}) };
    const extra = Object.keys(fields).length > 0 ? { extra: fields } : {};
    const kept = Object.keys(metadata).length > 0 ? { metadata } : {};
    if (cell.cell_type === "markdown") {
      return { kind: "markdown", source, ...kept, ...extra };
    }
    if (cell.cell_type === "raw") {
      return { kind: "code", source, language: "raw", ...kept, ...extra };
    }
    const vscode = isObject(metadata.vscode) ? metadata.vscode : undefined;
    let language = typeof vscode?.languageId === "string" ? vscode.languageId.toLowerCase() : notebookLanguage;
    let code = source;
    // `%%q --host h --port 5000` too (#1267): its options, which name where
    // PyKX ran the cell, stay in view as the cell's first line, a q comment.
    const magic = /^%%q(?:[ \t]+([^\r\n]*?))?[ \t]*(\r?\n|$)/.exec(source);
    if (magic !== null) {
      language = "q";
      code = (magic[1] ? `/ %%q ${magic[1]}\n` : "") + source.slice(magic[0].length);
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
      ...extra,
    };
  });
  // The notebook's metadata is kept (#1548), less the q kernel `toIpynb`
  // writes for a notebook that names none.
  const { kernelspec: _k, language_info: _l, ...rest } = meta;
  const own = JSON.stringify(spec) === JSON.stringify(Q_KERNEL) && JSON.stringify(info) === JSON.stringify(Q_LANGUAGE) ? rest : meta;
  return { cells, ...(Object.keys(own).length > 0 ? { metadata: own } : {}) };
}

