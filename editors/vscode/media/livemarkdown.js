// The Markdown renderer's extension for live values (#949): a `{{q: expr}}`
// in a notebook's Markdown cell shows the value the extension kept for it in
// the cell's metadata (`src/livemarkdown.ts`), escaped, or the expression
// as written when it has none yet. The cell's source is never changed.
//
// The editor loads this as an ES module extending its built-in Markdown
// renderer, which hands each cell's metadata to markdown-it as
// `env.outputItem.metadata`. What it shows is reported to the extension,
// when it listens, for its API.

/// As `src/livemarkdown.ts`'s `LIVE_KEY`.
const LIVE_KEY = "q-lint.liveValues";

/// As `src/livemarkdown.ts`'s `liveKey`: continuation lines start with one
/// space, whatever indent or CR came before them (#1788). A `>` there is
/// q's: a blockquote's markers never reach this text (#1993).
export function liveKey(expr) {
  return expr.replace(/\r?\n[ \t]*/g, "\n ");
}

/// As `src/livemarkdown.ts`'s `scanLive`: the expression from `at`, and the
/// index after its `}}`.
export function scanLive(text, at) {
  if (!text.startsWith("{{q:", at)) {
    return undefined;
  }
  let depth = 0;
  let quoted = false;
  for (let i = at + 4; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") {
        i++;
      } else if (c === '"') {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === "\n" && /^[ \t]*\r?\n/.test(text.slice(i + 1))) {
      return undefined;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      if (depth === 0) {
        if (text[i + 1] !== "}") {
          return undefined;
        }
        const expr = liveKey(text.slice(at + 4, i).trim());
        return expr === "" ? undefined : { expr, end: i + 2 };
      }
      depth--;
    }
  }
  return undefined;
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/// The HTML for `expr` given the cell's kept `values`.
export function liveHtml(expr, values) {
  const value = values && Object.prototype.hasOwnProperty.call(values, expr) ? values[expr] : undefined;
  const title = `q: ${escapeHtml(expr)}`;
  if (value && typeof value.text === "string") {
    return `<span class="qlint-live" title="${title}">${escapeHtml(value.text)}</span>`;
  }
  if (value && typeof value.error === "string") {
    return `<span class="qlint-live qlint-live-error" title="${title}" style="color:var(--vscode-errorForeground)">'${escapeHtml(value.error)}</span>`;
  }
  return `<code title="Runs when the code cell above this one runs">{{q: ${escapeHtml(expr)}}}</code>`;
}

/// Add the inline rule and its renderer to `md`; `seen(expr, value)` hears
/// each one drawn.
export function extend(md, seen = () => {}) {
  md.inline.ruler.before("text", "qlint_live", (state, silent) => {
    const live = scanLive(state.src, state.pos);
    if (live === undefined || live.end > state.posMax) {
      return false;
    }
    if (!silent) {
      const token = state.push("qlint_live", "", 0);
      token.meta = { expr: live.expr };
    }
    state.pos = live.end;
    return true;
  });
  md.renderer.rules.qlint_live = (tokens, idx, _options, env) => {
    const expr = tokens[idx].meta.expr;
    const metadata = env && env.outputItem && env.outputItem.metadata;
    const values = metadata && typeof metadata[LIVE_KEY] === "object" ? metadata[LIVE_KEY] : undefined;
    seen(expr, values && Object.prototype.hasOwnProperty.call(values, expr) ? values[expr] : undefined);
    return liveHtml(expr, values);
  };
}

export async function activate(context) {
  const markdown = await context.getRenderer("vscode.markdown-it-renderer");
  if (!markdown) {
    return;
  }
  markdown.extendMarkdownIt((md) =>
    extend(md, (expr, value) => {
      if (context.postMessage) {
        context.postMessage({ type: "live", expr, value: value ?? null });
      }
    }),
  );
}
