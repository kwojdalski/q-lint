//! The qSQL layout: a long `select`, `exec`, `update` or `delete` split onto
//! lines, one per clause, with the clause words right-aligned under the
//! first and the content after them in one column:
//!
//! ```q
//! r:select n:count i, px:avg px
//!       by sym
//!     from trade
//!    where date=.z.d,
//!          size>100
//! ```
//!
//! What it writes has to be what q reads, and the layout only ever replaces
//! whitespace with other whitespace, at two kinds of place: before a clause
//! word (`by`, `from`, the `where` that follows `from`) and after a comma
//! that separates columns or constraints. A newline and an indent are
//! whitespace inside a statement of a script - q joins an indented line to
//! the one before - so every other byte of the query keeps its neighbours.
//! Where that would not hold, the query is left as it is: one with a
//! comment in it (a `/` after a blank is a comment, wherever the line
//! breaks), a line already broken somewhere other than those places, a
//! second query word at its own depth (`select from t where x in exec ...`),
//! a clause out of order, a statement on a `\t` or `q)` line, and a comma
//! followed by an adverb (`,/`, `,'`, `,\`, `,:`), which is not a separator.
//! Each case in `tests/qsql_layout.rs` was loaded before and after into
//! KDB-X and PeachQ and the two results compared with `~`.
use crate::{boundary, query_clause, query_word};

/// A query's new text: the bytes `start..end` replaced by `text`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Layout {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

pub(crate) const LEADS: [&str; 4] = ["select", "exec", "update", "delete"];

/// A query's parts: the lead word and its text, then each clause word that
/// follows and its text, in order. A part's items are its text split at the
/// commas that separate them, each without the blanks around the split.
struct Query {
    lead: &'static str,
    /// Whether the text after the lead started with a blank.
    lead_gap: bool,
    clauses: Vec<(&'static str, Vec<String>)>,
    head: Vec<String>,
    /// Where the query starts (the lead word) and ends (the last byte of
    /// its last clause).
    start: usize,
    end: usize,
}

/// Every query in `source` whose one-line form would be longer than
/// `width`, laid out; what Format Document adds when asked to. A query
/// that is not longer than `width` is never touched, laid out or not, so
/// formatting twice changes nothing the second time.
pub(crate) fn layouts(code: &str, comments: &str, source: &str, width: usize) -> Vec<Layout> {
    let plain = crate::unsymbolled(code);
    let mut out: Vec<Layout> = vec![];
    for at in leads(&plain) {
        if out.last().is_some_and(|l| at < l.end) {
            continue;
        }
        let Some(query) = parse(&plain, comments, source, at) else {
            continue;
        };
        if one_line(&query, source) <= width {
            continue;
        }
        let text = render(&query, source, width);
        if text != source[query.start..query.end] {
            out.push(Layout {
                start: query.start,
                end: query.end,
                text,
            });
        }
    }
    out
}

/// The query around byte `at`, laid out with each clause on its own line
/// however long it is: the code action's answer. The outermost query that
/// can be laid out, and `None` where none can or the text would not change.
pub(crate) fn layout_at(
    code: &str,
    comments: &str,
    source: &str,
    at: usize,
    width: usize,
) -> Option<Layout> {
    let plain = crate::unsymbolled(code);
    leads(&plain).into_iter().find_map(|lead| {
        let query = parse(&plain, comments, source, lead)?;
        if !(query.start..=query.end).contains(&at) {
            return None;
        }
        let text = render(&query, source, width);
        (text != source[query.start..query.end]).then_some(Layout {
            start: query.start,
            end: query.end,
            text,
        })
    })
}

/// A query's parts as written: the lead word, the items after it, each
/// clause word with its items, and the bytes it spans. What the qSQL
/// conversions (`functional`) and the explainer read.
pub(crate) struct Parts {
    pub lead: &'static str,
    pub head: Vec<String>,
    pub clauses: Vec<(&'static str, Vec<String>)>,
    pub start: usize,
    pub end: usize,
}

/// The outermost query whose span holds byte `at`, split into its parts;
/// `None` outside one, and in one this module would refuse to lay out (a
/// comment in it, a second query word at its own depth, a clause out of
/// order), whose parts it cannot be sure of.
pub(crate) fn parts_at(code: &str, comments: &str, source: &str, at: usize) -> Option<Parts> {
    let plain = crate::unsymbolled(code);
    leads(&plain).into_iter().find_map(|lead| {
        let q = parse(&plain, comments, source, lead)?;
        (q.start..=q.end).contains(&at).then_some(Parts {
            lead: q.lead,
            head: q.head,
            clauses: q.clauses,
            start: q.start,
            end: q.end,
        })
    })
}

/// Where each lead word is, in order, in `plain`: the code with its symbols
/// blanked too, since a word inside a symbol is no query word.
fn leads(plain: &str) -> Vec<usize> {
    (0..plain.len())
        .filter(|&i| boundary(plain, i) && query_word(plain, i).is_some_and(|w| LEADS.contains(&w)))
        .collect()
}

/// The column of byte `at`: the characters before it on its line.
fn column(source: &str, at: usize) -> usize {
    let start = source[..at].rfind('\n').map_or(0, |n| n + 1);
    source[start..at].chars().count()
}

/// Whether the comma at `at` separates two items: not one an adverb
/// follows, which makes it part of a derived function.
fn separator(code: &str, at: usize) -> bool {
    !matches!(
        code.as_bytes().get(at + 1),
        Some(b'/' | b'\\' | b'\'' | b':')
    )
}

/// The query whose lead word is at `at`, or `None` where laying it out
/// could change what it means (see the module comment).
fn parse(plain: &str, comments: &str, source: &str, at: usize) -> Option<Query> {
    let bytes = plain.as_bytes();
    let lead = query_word(plain, at)?;
    // A query in another's phrase at the same depth is the other's to lay
    // out, and that one refuses.
    if query_clause(plain, at).is_some() {
        return None;
    }
    // The statement's first line: a `\t` line runs the rest as q, but its
    // continuation lines are the command's, so none is written.
    let mut line_start = source[..at].rfind('\n').map_or(0, |n| n + 1);
    while line_start > 0 && source[line_start..].starts_with([' ', '\t']) {
        line_start = source[..line_start - 1].rfind('\n').map_or(0, |n| n + 1);
    }
    if source[line_start..].starts_with(['\\']) || source[line_start..].starts_with("q)") {
        return None;
    }
    // The end of the statement at the lead's depth: a `;` there, the
    // bracket that closes around it, or a line at column 0.
    let mut depth = 0usize;
    let mut end = at;
    let mut words: Vec<(usize, &'static str)> = vec![];
    let mut commas: Vec<usize> = vec![];
    while end < bytes.len() {
        match bytes[end] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth == 0 => break,
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth == 0 => break,
            b'\n' => {
                let next = &source[end + 1..];
                let line = next.split('\n').next().unwrap_or("");
                if !line.trim().is_empty() && !next.starts_with([' ', '\t', '\r']) {
                    break;
                }
            }
            b',' if depth == 0 && separator(plain, end) => commas.push(end),
            _ if depth == 0 && end > at && boundary(plain, end) => {
                if let Some(w) = query_word(plain, end) {
                    words.push((end, w));
                    end += w.len();
                    continue;
                }
            }
            _ => {}
        }
        end += 1;
    }
    if depth != 0 {
        return None;
    }
    while end > at && source.as_bytes()[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    // No comment anywhere from the lead to the end of its last line.
    let tail = source[end..].find('\n').map_or(source.len(), |n| end + n);
    if comments[at..tail] != source[at..tail] {
        return None;
    }
    // The clause words: `by` before `from`, one `from`, and the first
    // `where` after it. A `where` before `from` is the function, and so is
    // one inside the where phrase (#771).
    let mut clauses: Vec<(usize, &'static str)> = vec![];
    for (i, w) in words {
        let seen = |k: &str| clauses.iter().any(|(_, c)| *c == k);
        match w {
            "by" if !seen("by") && !seen("from") => clauses.push((i, w)),
            "from" if !seen("from") => clauses.push((i, w)),
            "where" if seen("from") && !seen("where") => clauses.push((i, w)),
            "where" => {}
            _ => return None,
        }
    }
    if !clauses.iter().any(|(_, c)| *c == "from") {
        return None;
    }
    // Each part's items: the text between its word and the next, split at
    // its commas. A newline anywhere but in a blank that is replaced means
    // the line was broken somewhere this does not write, so nothing is.
    let mut bounds: Vec<(usize, usize)> = vec![];
    let mut from = at + lead.len();
    for (i, w) in &clauses {
        bounds.push((from, *i));
        from = i + w.len();
    }
    bounds.push((from, end));
    let mut parts: Vec<Vec<String>> = vec![];
    for (k, (s, e)) in bounds.iter().enumerate() {
        // The from phrase is one expression: a comma there is a join.
        let cuts: Vec<usize> = if clauses
            .get(k.wrapping_sub(1))
            .is_some_and(|(_, w)| *w == "from")
        {
            vec![]
        } else {
            commas
                .iter()
                .copied()
                .filter(|c| (s..e).contains(&c))
                .collect()
        };
        let mut items = vec![];
        let mut item_start = *s;
        for c in cuts.iter().copied().chain([*e]) {
            let raw = &source[item_start..c];
            let body = raw.trim_start();
            // Blanks before a comma stay: only the one after it is a break.
            let body = if c == *e { body.trim_end() } else { body };
            if body.contains('\n') {
                return None;
            }
            items.push(body.to_string());
            item_start = c + 1;
        }
        if items.iter().skip(1).any(String::is_empty) || (items.len() > 1 && items[0].is_empty()) {
            return None;
        }
        parts.push(items);
    }
    let mut parts = parts.into_iter();
    let head = parts.next()?;
    let head = if head.len() == 1 && head[0].is_empty() {
        vec![]
    } else {
        head
    };
    let lead_gap = source[at + lead.len()..].starts_with(|c: char| c.is_whitespace());
    Some(Query {
        lead,
        lead_gap,
        clauses: clauses.iter().map(|(_, w)| *w).zip(parts).collect(),
        head,
        start: at,
        end,
    })
}

/// The query's length written on one line, with the text before it on its
/// first line and after it on its last: what is compared with the width.
fn one_line(q: &Query, source: &str) -> usize {
    let mut n = column(source, q.start) + q.lead.len();
    let items = |items: &[String]| -> usize {
        items.iter().map(|i| i.chars().count()).sum::<usize>() + 2 * items.len().saturating_sub(1)
    };
    if !q.head.is_empty() {
        n += usize::from(q.lead_gap) + items(&q.head);
    }
    for (word, part) in &q.clauses {
        n += 1 + word.len() + 1 + items(part);
    }
    let rest = source[q.end..].split('\n').next().unwrap_or("");
    n + rest.trim_end().chars().count()
}

/// The query laid out: the lead line as it starts, then each clause word
/// on a line of its own, right-aligned under the lead word, and a part's
/// items one per line in its content column when they do not fit in
/// `width` on one.
fn render(q: &Query, source: &str, width: usize) -> String {
    let lead_col = column(source, q.start);
    let edge = lead_col + q.lead.len();
    // A clause word longer than the lead (`where` under `exec`) at column
    // 0 would end the statement: everything moves right instead.
    let least = q
        .clauses
        .iter()
        .map(|(w, _)| edge as isize - w.len() as isize)
        .min()
        .unwrap_or(1);
    let shift = (1 - least).max(0) as usize;
    // A file written with CRLF gets CRLF.
    let nl = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut out = String::from(q.lead);
    let head_col = edge + usize::from(q.lead_gap);
    if !q.head.is_empty() {
        if q.lead_gap {
            out.push(' ');
        }
        out.push_str(&items_text(&q.head, head_col, width, nl));
    }
    for (word, part) in &q.clauses {
        let indent = edge + shift - word.len();
        out.push_str(nl);
        out.push_str(&" ".repeat(indent));
        out.push_str(word);
        if !part.is_empty() && !(part.len() == 1 && part[0].is_empty()) {
            out.push(' ');
            out.push_str(&items_text(part, edge + shift + 1, width, nl));
        }
    }
    out
}

/// A part's items from column `col`: on one line joined by `, ` if that
/// fits in `width`, else one per line, each after the first at `col`.
fn items_text(items: &[String], col: usize, width: usize, nl: &str) -> String {
    let joined = items.join(", ");
    if items.len() < 2 || col + joined.chars().count() <= width {
        return joined;
    }
    items.join(&format!(",{nl}{}", " ".repeat(col)))
}
