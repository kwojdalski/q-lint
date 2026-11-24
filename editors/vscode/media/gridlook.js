// How the result grid dresses a column: formats named by a column's suffix
// (#1012), conditional formatting rules (#1013), sparklines and data bars
// (#1014), a remembered column layout (#1015), and the correlation of the
// numeric columns (#1020).
//
// Nothing here touches the DOM. The result page (result.js) loads it before
// itself, and the extension requires it for the HTML export, so a rule
// colours the same cells in the grid and in the file. test/resultlook.test.js
// runs it under node. In a page it sets `qlintLook` on the global object.
(function (root) {
  "use strict";

  /// The suffixes a column's name can end in, and what each shows. A
  /// number format can end in a digit, the decimals it shows: `_PCT1`.
  const SUFFIXES = {
    PCT: { kind: "pct", digits: 2, label: "a fraction as a percent: 0.0123 shows as 1.23%" },
    BPS: { kind: "bps", digits: 1, label: "a fraction in basis points: 0.0123 shows as 123.0 bp" },
    CCY: { kind: "ccy", digits: 2, label: "an amount: thousands separated, two decimals" },
    NUM: { kind: "num", digits: -1, label: "thousands separated, the decimals as q wrote them" },
    BG: { kind: "bg", label: "the value is a colour: the background of the column it names, or of the row" },
    FG: { kind: "fg", label: "the value is a colour: the text of the column it names, or of the row" },
    CODE: { kind: "code", label: "monospace, as code" },
    BAR: { kind: "bar", label: "a data bar scaled to the column's range" },
  };

  /// The format a column's name asks for, or null: {base, suffix, kind,
  /// digits, label}. `base` is the name without its suffix, which the
  /// header shows. The suffix is matched in any case after the last `_`.
  function columnFormat(name) {
    const m = /^(.*[^_])_([A-Za-z]+?)(\d)?$/.exec(String(name));
    if (!m) {
      return null;
    }
    const known = SUFFIXES[m[2].toUpperCase()];
    if (!known || (m[3] !== undefined && known.digits === undefined)) {
      return null;
    }
    return {
      base: m[1],
      suffix: m[0].slice(m[1].length + 1),
      kind: known.kind,
      digits: m[3] !== undefined ? Number(m[3]) : known.digits,
      label: known.label,
    };
  }

  /// A number's text with its whole part's thousands separated by commas.
  function grouped(text) {
    const m = /^(-?)(\d+)(.*)$/.exec(text);
    return m ? m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + m[3] : text;
  }

  /// A number to `digits` decimals, every digit of its whole part: an
  /// integer from q's text (`text`), which a long past 2^53 is exact in and
  /// its double is not; a float past 1e21 not in exponent form (#1647).
  /// A fractional value's text is never used: q's \P, or the grid's
  /// decimals, may have rounded it to an integer's (#1741).
  function fixed(value, digits, text) {
    const zeros = digits > 0 ? "." + "0".repeat(digits) : "";
    if (Number.isInteger(value) && /^-?\d+$/.test(text)) {
      return text + zeros;
    }
    if (Math.abs(value) >= 1e21) {
      return BigInt(value).toString() + zeros;
    }
    return value.toFixed(digits);
  }

  /// What a cell of a numeric column shows under format `f`: `text`, q's,
  /// for a null or an infinity (`value` null) and for a format that is no
  /// number format.
  function formatNumber(f, value, text) {
    if (!f || value === null || value === undefined || !isFinite(value)) {
      return text;
    }
    switch (f.kind) {
      // Every digit past 1e21 too, not exponent form, as ccy (#1820).
      case "pct":
        return fixed(value * 100, f.digits, "") + "%";
      case "bps":
        return fixed(value * 10000, f.digits, "") + " bp";
      case "ccy":
        return grouped(fixed(value, f.digits, text));
      case "num":
        return f.digits >= 0 ? grouped(fixed(value, f.digits, text)) : grouped(text);
      default:
        return text;
    }
  }

  /// A cell's text as a CSS colour, or null: `#rgb`, `#rgba`, `#rrggbb`,
  /// `#rrggbbaa`, or a colour's name (letters only), so nothing else can
  /// reach a style.
  function cssColour(text) {
    const t = String(text).trim();
    return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) || /^[a-z]{3,20}$/i.test(t) ? t : null;
  }

  /// Each column's format: an array, null where its name asks for none.
  /// A colour column's `target` is the column its base names (by name), or
  /// -1 when no column has that name, and it colours the whole row.
  function columnFormats(grid) {
    return grid.columns.map(function (c) {
      const f = columnFormat(c.name);
      if (!f) {
        return null;
      }
      const numeric = f.kind === "pct" || f.kind === "bps" || f.kind === "ccy" || f.kind === "num" || f.kind === "bar";
      if (numeric && !c.numeric) {
        return null;
      }
      if (f.kind === "bg" || f.kind === "fg") {
        f.target = grid.columns.findIndex(function (o) { return o.name === f.base; });
      }
      return f;
    });
  }

  // --- conditional formatting (#1013)

  /// The comparisons a rule can make; top and bottom take a count.
  const RULE_OPS = [">", ">=", "<", "<=", "=", "<>", "top", "bottom", "contains"];
  /// The ones a column that is not numeric can use, on its text.
  const TEXT_OPS = ["=", "<>", "contains"];
  /// The colours a rule can give, by name: the editor's chart colours.
  const PALETTE = { red: "#f14c4c", green: "#89d185", blue: "#3794ff", orange: "#d18616", yellow: "#cca700", purple: "#b180d7", grey: "#808080" };

  /// The rows of the grid a rule matches, as a Set: those of its column
  /// (the first of that name) whose value compares as it asks. On a numeric
  /// column the comparisons are of numbers, and top or bottom N are the
  /// rows holding the N greatest or least values, ties included; on any
  /// other, `=` and `<>` compare the cell's text and `contains` finds it in
  /// any case. A null matches nothing; an infinity (0w, -0w) compares as
  /// one (#1645). An empty Set for a rule its column cannot take. `shown`,
  /// when given, is what a cell shows (column, row) where a format changes
  /// q's text: `contains` finds either, as a filter does (#1646).
  function ruleRows(grid, rule, shown) {
    const out = new Set();
    const c = grid.columns.findIndex(function (col) { return col.name === rule.column; });
    if (c < 0 || RULE_OPS.indexOf(rule.op) < 0) {
      return out;
    }
    const numeric = grid.columns[c].numeric && grid.values[c];
    const cells = grid.cells[c];
    if (!numeric) {
      if (TEXT_OPS.indexOf(rule.op) < 0) {
        return out;
      }
      const want = String(rule.value);
      const lower = want.toLowerCase();
      cells.forEach(function (text, r) {
        if (text === "") {
          return;
        }
        const hit = rule.op === "=" ? text === want : rule.op === "<>" ? text !== want : text.toLowerCase().indexOf(lower) >= 0;
        if (hit) {
          out.add(r);
        }
      });
      return out;
    }
    // grid.ts writes an infinity's value as null, as a null's: its text
    // tells them apart.
    const values = grid.values[c].map(function (v, r) {
      return v !== null ? v : /^-0[wW]$/.test(cells[r]) ? -Infinity : /^0[wW]$/.test(cells[r]) ? Infinity : null;
    });
    if (rule.op === "contains") {
      const lower = String(rule.value).toLowerCase();
      cells.forEach(function (text, r) {
        if (values[r] !== null && (text.toLowerCase().indexOf(lower) >= 0 || (shown !== undefined && shown(c, r).toLowerCase().indexOf(lower) >= 0))) {
          out.add(r);
        }
      });
      return out;
    }
    if (rule.op === "top" || rule.op === "bottom") {
      const n = Math.floor(Number(rule.value));
      const sorted = values.filter(function (v) { return v !== null; }).sort(function (a, b) { return rule.op === "top" ? b - a : a - b; });
      if (!(n >= 1) || sorted.length === 0) {
        return out;
      }
      const edge = sorted[Math.min(n, sorted.length) - 1];
      values.forEach(function (v, r) {
        if (v !== null && (rule.op === "top" ? v >= edge : v <= edge)) {
          out.add(r);
        }
      });
      return out;
    }
    const x = Number(rule.value);
    if (!isFinite(x)) {
      return out;
    }
    values.forEach(function (v, r) {
      if (v === null) {
        return;
      }
      const hit = rule.op === ">" ? v > x : rule.op === ">=" ? v >= x : rule.op === "<" ? v < x : rule.op === "<=" ? v <= x : rule.op === "=" ? v === x : v !== x;
      if (hit) {
        out.add(r);
      }
    });
    return out;
  }

  /// The style each rule gives the cells it matches, per column: an array
  /// with, for a column a rule names, a Map from row to {background, color,
  /// bold}; null for the others. A later rule's colour wins over an
  /// earlier's on the same cell; bold adds. `shown`: as ruleRows takes it.
  function ruleStyles(grid, rules, shown) {
    const out = grid.columns.map(function () { return null; });
    (rules || []).forEach(function (rule) {
      const c = grid.columns.findIndex(function (col) { return col.name === rule.column; });
      if (c < 0) {
        return;
      }
      const style = rule.style || {};
      const map = out[c] || (out[c] = new Map());
      ruleRows(grid, rule, shown).forEach(function (r) {
        const s = Object.assign({}, map.get(r) || {});
        if (PALETTE[style.background]) {
          s.background = PALETTE[style.background];
        }
        if (PALETTE[style.color]) {
          s.color = PALETTE[style.color];
        }
        if (style.bold) {
          s.bold = true;
        }
        map.set(r, s);
      });
    });
    return out;
  }

  /// A rule in words, for a header's tooltip and a pick: `px > 100: red
  /// background`.
  function ruleText(rule) {
    const s = rule.style || {};
    const looks = [];
    if (s.background) {
      looks.push(s.background + " background");
    }
    if (s.color) {
      looks.push(s.color + " text");
    }
    if (s.bold) {
      looks.push("bold");
    }
    const what = rule.op === "top" || rule.op === "bottom" ? rule.op + " " + rule.value : rule.op + " " + (typeof rule.value === "string" ? JSON.stringify(rule.value) : rule.value);
    return rule.column + " " + what + ": " + (looks.join(", ") || "no style");
  }

  // --- sparklines and data bars (#1014)

  /// A number as q writes it in a vector, or null for a null.
  const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

  /// The numbers of a numeric vector as q's `-3!` writes it - `1 2 3`,
  /// `1.5 0n 2f`, `,4i`, `0N 7` - or null when the text is not one. An
  /// infinity is a null here. A vector cut short - at the process's `\c`
  /// width (`..`) or at 200 characters (`...`) - keeps the numbers before
  /// the last, which may be part of one.
  function parseNumbers(text) {
    let t = String(text).trim();
    if (t === "" || /^`[a-z]+\$\(\)$/.test(t)) {
      return t === "" ? null : [];
    }
    let cut = false;
    if (/\.\.\.?$/.test(t)) {
      t = t.replace(/\.\.\.?$/, "").trim();
      cut = true;
    }
    if (t.charAt(0) === ",") {
      t = t.slice(1);
    }
    const parts = t.split(" ");
    if (cut) {
      // The last number may be part of one.
      parts.pop();
    }
    if (parts.length === 0) {
      return null;
    }
    const last = parts.length - 1;
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i];
      if (i === last && !cut && /[hijef]$/.test(p) && !/^-?0[nNwW]$/.test(p)) {
        p = p.slice(0, -1);
      }
      if (/^-?0[nNwW]$/.test(p)) {
        out.push(null);
      } else if (NUMBER.test(p)) {
        out.push(Number(p));
      } else {
        return null;
      }
    }
    return out;
  }

  /// Whether a column of the grid is a list of numeric vectors: a general
  /// list whose every cell q wrote as one, and at least one with two
  /// numbers. Looks at the first 200 cells.
  function isNumericList(grid, c) {
    if (grid.columns[c].type !== 0) {
      return false;
    }
    const cells = grid.cells[c];
    let two = false;
    for (let r = 0; r < Math.min(cells.length, 200); r++) {
      const v = parseNumbers(cells[r]);
      if (v === null && cells[r] !== "") {
        return false;
      }
      two = two || (v !== null && v.length >= 2);
    }
    return two;
  }

  /// A sparkline of `values` as an SVG data URL for a cell's background:
  /// a line over 100 by 20 units stretched to the cell, broken at a null,
  /// in `colour` (a CSS colour the caller read from the theme). Null when
  /// there is nothing to draw.
  function sparkUrl(values, colour) {
    const finite = values.filter(function (v) { return v !== null && isFinite(v); });
    if (finite.length === 0) {
      return null;
    }
    const lo = Math.min.apply(null, finite);
    const hi = Math.max.apply(null, finite);
    const n = values.length;
    const x = function (i) { return n === 1 ? 50 : (i / (n - 1)) * 100; };
    const y = function (v) { return hi === lo ? 10 : 18 - ((v - lo) / (hi - lo)) * 16; };
    let d = "";
    let pen = false;
    values.forEach(function (v, i) {
      if (v === null || !isFinite(v)) {
        pen = false;
        return;
      }
      d += (pen ? "L" : "M") + x(i).toFixed(2) + " " + y(v).toFixed(2);
      pen = true;
    });
    const dot = finite.length === 1 ? '<circle cx="' + x(values.findIndex(function (v) { return v !== null && isFinite(v); })).toFixed(2) + '" cy="10" r="1.5" fill="' + colour + '"/>' : "";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20" preserveAspectRatio="none"><path d="' + d + '" fill="none" stroke="' + colour + '" stroke-width="1.2" vector-effect="non-scaling-stroke"/>' + dot + "</svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  /// Where each value's data bar starts and ends, as fractions of the cell:
  /// [from, to], measured from zero, which sits at the left unless the
  /// column has values below it. Null for a null, an infinity, and every
  /// row of a column of one value that is zero.
  function barLevels(values) {
    let lo = 0;
    let hi = 0;
    values.forEach(function (v) {
      if (v !== null && isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    });
    if (!(hi > lo)) {
      return values.map(function () { return null; });
    }
    const at = function (v) { return (v - lo) / (hi - lo); };
    const zero = at(0);
    return values.map(function (v) {
      if (v === null || !isFinite(v)) {
        return null;
      }
      const p = at(v);
      return [Math.min(zero, p), Math.max(zero, p)];
    });
  }

  /// A data bar as a cell's background: `colour`, translucent, from `from`
  /// to `to` of its width.
  function barBackground(level, colour) {
    const a = (level[0] * 100).toFixed(1) + "%";
    const b = (level[1] * 100).toFixed(1) + "%";
    const c = "color-mix(in srgb, " + colour + " 45%, transparent)";
    return "linear-gradient(to right, transparent " + a + ", " + c + " " + a + ", " + c + " " + b + ", transparent " + b + ")";
  }

  // --- column layout (#1015)

  /// The columns to draw, by place in the grid, in the layout's order: the
  /// names in `layout.order` first (a name twice in the grid takes its next
  /// column each time), then the rest in the grid's order, leaving out the
  /// names in `layout.hidden` - unless that leaves none, as a new run
  /// of only hidden columns would: then every one is drawn (#1652).
  function displayColumns(grid, layout) {
    const names = grid.columns.map(function (c) { return c.name; });
    const used = names.map(function () { return false; });
    const out = [];
    ((layout && layout.order) || []).forEach(function (name) {
      const i = names.findIndex(function (n, k) { return n === name && !used[k]; });
      if (i >= 0) {
        used[i] = true;
        out.push(i);
      }
    });
    names.forEach(function (_, i) {
      if (!used[i]) {
        out.push(i);
      }
    });
    const hidden = (layout && layout.hidden) || [];
    const shown = out.filter(function (i) { return hidden.indexOf(names[i]) < 0; });
    return shown.length === 0 ? out : shown;
  }

  /// The order of names after moving the column drawn at `from` to `to`
  /// (places among those drawn); the hidden keep their place after them.
  function moveColumn(grid, layout, from, to) {
    const shown = displayColumns(grid, layout);
    const all = displayColumns(grid, { order: layout && layout.order });
    if (from < 0 || from >= shown.length || to < 0 || to >= shown.length || from === to) {
      return all.map(function (i) { return grid.columns[i].name; });
    }
    const moved = shown.slice();
    const [c] = moved.splice(from, 1);
    moved.splice(to, 0, c);
    const rest = all.filter(function (i) { return moved.indexOf(i) < 0; });
    return moved.concat(rest).map(function (i) { return grid.columns[i].name; });
  }

  /// How far from the left each frozen column sits, as CSS: the widths of
  /// the columns drawn before it, each `widths[i]` (a CSS length).
  function frozenOffsets(widths, frozen) {
    const out = [];
    let parts = [];
    for (let k = 0; k < Math.min(frozen, widths.length); k++) {
      out.push(parts.length === 0 ? "0px" : parts.length === 1 ? parts[0] : "calc(" + parts.join(" + ") + ")");
      parts = parts.concat([widths[k]]);
    }
    return out;
  }

  // --- correlation (#1020)

  /// The Pearson correlation of every pair of the grid's numeric columns
  /// over `rows`: {columns (places), names, r, n}. `r[i][j]` uses the rows
  /// where both values are there (nulls and infinities left out), `n[i][j]`
  /// counts them; null where there are fewer than two, or a column does not
  /// vary over them. Keys are left out, as an id is no measure.
  function correlation(grid, rows) {
    const columns = [];
    grid.columns.forEach(function (c, i) {
      if (c.numeric && !c.key && grid.values[i]) {
        columns.push(i);
      }
    });
    const r = columns.map(function () { return columns.map(function () { return null; }); });
    const n = columns.map(function () { return columns.map(function () { return 0; }); });
    for (let a = 0; a < columns.length; a++) {
      for (let b = a; b < columns.length; b++) {
        const xs = grid.values[columns[a]];
        const ys = grid.values[columns[b]];
        let k = 0;
        let sx = 0;
        let sy = 0;
        // Whether either column varies over these rows: the mean of one
        // that does not is off by rounding, which leaves cxx a hair above 0.
        let x0 = null;
        let y0 = null;
        let vx = false;
        let vy = false;
        rows.forEach(function (row) {
          const x = xs[row];
          const y = ys[row];
          if (x !== null && y !== null) {
            if (k === 0) {
              x0 = x;
              y0 = y;
            }
            vx = vx || x !== x0;
            vy = vy || y !== y0;
            k++;
            sx += x;
            sy += y;
          }
        });
        let value = null;
        if (k >= 2) {
          const mx = sx / k;
          const my = sy / k;
          let cxy = 0;
          let cxx = 0;
          let cyy = 0;
          rows.forEach(function (row) {
            const x = xs[row];
            const y = ys[row];
            if (x !== null && y !== null) {
              cxy += (x - mx) * (y - my);
              cxx += (x - mx) * (x - mx);
              cyy += (y - my) * (y - my);
            }
          });
          value = vx && vy && cxx > 0 && cyy > 0 ? Math.max(-1, Math.min(1, cxy / Math.sqrt(cxx * cyy))) : null;
        }
        r[a][b] = r[b][a] = value;
        n[a][b] = n[b][a] = k;
      }
    }
    return { columns: columns, names: columns.map(function (c) { return grid.columns[c].name; }), r: r, n: n };
  }

  /// The pairs of a correlation(), each once, strongest first: {a, b, r, n}
  /// by name; pairs with no correlation last.
  function correlationPairs(corr) {
    const out = [];
    for (let a = 0; a < corr.names.length; a++) {
      for (let b = a + 1; b < corr.names.length; b++) {
        out.push({ a: corr.names[a], b: corr.names[b], r: corr.r[a][b], n: corr.n[a][b] });
      }
    }
    return out.sort(function (x, y) {
      return (y.r === null ? -1 : Math.abs(y.r)) - (x.r === null ? -1 : Math.abs(x.r));
    });
  }

  const helpers = {
    SUFFIXES: SUFFIXES,
    columnFormat: columnFormat,
    columnFormats: columnFormats,
    formatNumber: formatNumber,
    grouped: grouped,
    cssColour: cssColour,
    RULE_OPS: RULE_OPS,
    TEXT_OPS: TEXT_OPS,
    PALETTE: PALETTE,
    ruleRows: ruleRows,
    ruleStyles: ruleStyles,
    ruleText: ruleText,
    parseNumbers: parseNumbers,
    isNumericList: isNumericList,
    sparkUrl: sparkUrl,
    barLevels: barLevels,
    barBackground: barBackground,
    displayColumns: displayColumns,
    moveColumn: moveColumn,
    frozenOffsets: frozenOffsets,
    correlation: correlation,
    correlationPairs: correlationPairs,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  } else {
    root.qlintLook = helpers;
  }
})(typeof self !== "undefined" ? self : this);
