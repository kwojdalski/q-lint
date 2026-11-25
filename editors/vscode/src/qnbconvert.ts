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
import { markdownBlocks } from "./markdownblocks";
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

/// Markdown's inline text as HTML: code spans as they are, live values as
/// `liveHtml` writes them, everything escaped. A paragraph or an item is
/// read whole, as `liveQueries` reads it, so a `{{q: }}` over two lines is
/// one value under the key the run kept it by (#2149); a line's trailing
/// and a later line's leading blanks go, and with `breaks` two spaces or a backslash at a line's end
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
  // And a later line's leading ones, as markdown-it's `newline` rule drops them.
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
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
    return target === undefined ? (titled(a, b, c) === "" ? alt : m) : hold(`<a href="${escapeHtml(target)}"${titled(a, b, c)}>${emphasis(alt, held)}</a>`);
  });
  // A URL may hold balanced parentheses, as Wikipedia's do (#1554).
  s = s.replace(new RegExp(String.raw`\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)${TITLE}\)`, "g"), (m, label: string, href: string, a?: string, b?: string, c?: string) => {
    // The link is held whole, so the emphasis below finds no `_` in the URL
    // (#1105), and pairs no delimiter of its label with one outside it, as
    // markdown-it reads a label on its own.
    const target = followed(href);
    return target === undefined ? m : hold(`<a href="${escapeHtml(target)}"${titled(a, b, c)}>${emphasis(label, held)}</a>`);
  });
  // What is held may hold more: a link's label.
  const restore = (text: string): string => text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => restore(held[Number(i)]));
  return restore(emphasis(s, held));
}

/// What a character next to a delimiter run is, for whether the run opens
/// or closes: a held piece stands for its markup - punctuation, as a
/// backtick, a bracket, a `<` or an `&` is - or for a line's end, a `<br>`.
function around(c: string | undefined, held: string | undefined): "space" | "punct" | "other" {
  if (c === undefined || held === "<br>" || /\s/u.test(c)) {
    return "space";
  }
  return held !== undefined || /[!-/:-@[-`{-~]|\p{P}|\p{S}/u.test(c) ? "punct" : "other";
}

/// Markdown's emphasis in `s`, inline text escaped with its pieces held: the
/// runs of `*` and `_` paired as markdown-it pairs them - by whether a run
/// can open or close (CommonMark 6.2's flanking rules: `**Rows:**42` is text,
/// #2401), `_` never inside a word (#1556) while `*` may be (`foo*bar*`,
/// #2392), the rule of three, and each closer with the nearest opener it may
/// take, so tags always nest (#1550, #2391) and a run with nothing between
/// is text (`***`, #2390). Two delimiters paired inside two more are
/// `<strong>`.
function emphasis(s: string, held: string[]): string {
  // The text as units: a character, or a held piece whole.
  const units = s.match(/\u0000\d+\u0000|[^]/gu) ?? [];
  const heldOf = (u: string | undefined): string | undefined => (u !== undefined && u.startsWith("\u0000") && u.length > 1 ? held[Number(u.slice(1, -1))] : undefined);
  const kind = (u: string | undefined): "space" | "punct" | "other" => around(u === undefined ? undefined : u[u.length - 1], heldOf(u));
  type Delimiter = { at: number; marker: string; length: number; open: boolean; close: boolean; end: number };
  const delimiters: Delimiter[] = [];
  for (let i = 0; i < units.length; ) {
    const marker = units[i];
    if (marker !== "*" && marker !== "_") {
      i++;
      continue;
    }
    let j = i;
    while (units[j] === marker) {
      j++;
    }
    const last = kind(units[i - 1]);
    const next = kind(units[j]);
    const left = next !== "space" && (next !== "punct" || last !== "other");
    const right = last !== "space" && (last !== "punct" || next !== "other");
    const open = left && (marker === "*" || !right || last === "punct");
    const close = right && (marker === "*" || !left || next === "punct");
    for (let k = i; k < j; k++) {
      delimiters.push({ at: k, marker, length: j - i, open, close, end: -1 });
    }
    i = j;
  }
  // markdown-it's `balance_pairs`: each closer takes the nearest opener of
  // its marker it may, skipping what is paired already.
  const bottom: Record<string, number[]> = {};
  const jumps: number[] = [];
  let header = 0;
  let lastAt = -2;
  for (let c = 0; c < delimiters.length; c++) {
    const closer = delimiters[c];
    jumps.push(0);
    if (delimiters[header].marker !== closer.marker || lastAt !== closer.at - 1) {
      header = c;
    }
    lastAt = closer.at;
    if (!closer.close) {
      continue;
    }
    bottom[closer.marker] ??= [-1, -1, -1, -1, -1, -1];
    const slot = (closer.open ? 3 : 0) + (closer.length % 3);
    let o = header - jumps[header] - 1;
    let lowest = o;
    for (; o > bottom[closer.marker][slot]; o -= jumps[o] + 1) {
      const opener = delimiters[o];
      if (opener.marker !== closer.marker || !opener.open || opener.end >= 0) {
        continue;
      }
      const odd = (opener.close || closer.open) && (opener.length + closer.length) % 3 === 0 && (opener.length % 3 !== 0 || closer.length % 3 !== 0);
      if (!odd) {
        const lastJump = o > 0 && !delimiters[o - 1].open ? jumps[o - 1] + 1 : 0;
        jumps[c] = c - o + lastJump;
        jumps[o] = lastJump;
        closer.open = false;
        opener.end = c;
        opener.close = false;
        lowest = -1;
        lastAt = -2;
        break;
      }
    }
    if (lowest !== -1) {
      bottom[closer.marker][slot] = lowest;
    }
  }
  // Each pair as its tags, two adjacent ones inside two more as one strong.
  const out = [...units];
  for (let i = delimiters.length - 1; i >= 0; i--) {
    const start = delimiters[i];
    if (start.end === -1) {
      continue;
    }
    const end = delimiters[start.end];
    const strong =
      i > 0 &&
      delimiters[i - 1].end === start.end + 1 &&
      delimiters[i - 1].marker === start.marker &&
      delimiters[i - 1].at === start.at - 1 &&
      delimiters[start.end + 1].at === end.at + 1;
    const tag = strong ? "strong" : "em";
    out[start.at] = `<${tag}>`;
    out[end.at] = `</${tag}>`;
    if (strong) {
      out[delimiters[i - 1].at] = "";
      out[delimiters[start.end + 1].at] = "";
      i--;
    }
  }
  return out.join("");
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

/// A Markdown cell as HTML, its live values from `values`: its blocks as
/// the notebook's renderer reads them (`markdownBlocks`, #2393) - a list
/// item, a quote and what is in them as Markdown of their own, a list
/// ended where a new one starts - and each one's inline text by `inline`.
/// An HTML block is shown as written, as a tag is.
export function markdownHtml(source: string, values: Record<string, LiveValue> = {}): string {
  const out: string[] = [];
  let line = "";
  let open = 0;
  for (const block of markdownBlocks(source)) {
    open += block.kind === "open" ? 1 : block.kind === "close" ? -1 : 0;
    switch (block.kind) {
      case "open":
        line += block.tag === "ol" && block.start !== undefined && block.start !== 1 ? `<ol start="${block.start}">` : `<${block.tag}>`;
        break;
      case "close":
        line += `</${block.tag}>`;
        break;
      // A line's end is a space, as the notebook shows it: a break only
      // after two spaces or a backslash not itself escaped (#1945, #2399).
      case "paragraph":
        line += block.hidden ? inline(block.text, values, true) : `<p>${inline(block.text, values, true)}</p>`;
        break;
      case "heading":
        line += `<h${block.depth}>${inline(block.text, values, true)}</h${block.depth}>`;
        break;
      case "code":
        line += `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        break;
      case "hr":
        line += "<hr>";
        break;
      case "html":
        line += `<p>${escapeHtml(block.text)}</p>`;
        break;
      case "table": {
        const cell = (tag: string, text: string, at: number): string =>
          `<${tag}${block.aligns[at] ? ` style="text-align:${block.aligns[at]}"` : ""}>${inline(text, values)}</${tag}>`;
        const head = block.head.map((c, at) => cell("th", c, at));
        const body = block.rows.map((row) => `<tr>${block.aligns.map((_a, at) => cell("td", row[at] ?? "", at)).join("")}</tr>`);
        line += `<table><thead><tr>${head.join("")}</tr></thead>${body.length > 0 ? `<tbody>${body.join("")}</tbody>` : ""}</table>`;
        break;
      }
    }
    // A block at the cell's top is a line of its own.
    if (open === 0) {
      out.push(line);
      line = "";
    }
  }
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

