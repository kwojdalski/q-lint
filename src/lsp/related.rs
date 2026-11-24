//! The second place a diagnostic points at, as LSP's `relatedInformation`:
//! the first of two parameters with one name (QF008), the first of two
//! columns with one name (QB019), and the result column a by group repeats
//! (QB021). A finding names the lambda or the query; which names in it
//! collide it says in its message, and where they are is read here from the
//! same text - never run.
use super::Lines;
use q_lint_rs::Finding;
use serde_json::{Value, json};
use std::cell::OnceCell;

/// The related locations for `finding`, which starts at byte `at` of
/// `text`, each a location in `uri` with a message - or none, for a rule
/// that points at one place only. `view` holds `text` with strings and
/// comments blanked once it is first wanted, for all of a document's
/// findings: made again for each, a file with many was quadratic (#2114).
pub(super) fn related(
    finding: &Finding,
    text: &str,
    view: &OnceCell<String>,
    lines: &Lines,
    at: usize,
    uri: &str,
) -> Vec<Value> {
    // Read with strings and comments blanked, so a name or a bracket in
    // one is not taken for code.
    let view = || view.get_or_init(|| q_lint_rs::code_view(text)).as_str();
    let places = match finding.code.as_str() {
        "QF008" => parameters(finding, view(), at),
        "QB019" | "QB021" => columns(finding, view(), at),
        _ => vec![],
    };
    places
        .into_iter()
        .map(|(start, name, message)| {
            json!({
                "location": {"uri": uri, "range": {
                    "start": lines.json(start), "end": lines.json(start + name.len())}},
                "message": message,
            })
        })
        .collect()
}

/// QF008: each repeated name's declarations in the lambda's parameter list,
/// the first and the ones that repeat it.
fn parameters<'a>(finding: &'a Finding, text: &str, at: usize) -> Vec<(usize, &'a str, String)> {
    let rest = &text[at..];
    let Some(open) = rest
        .strip_prefix('{')
        .map(|r| at + 1 + r.len() - r.trim_start().len())
        .filter(|&open| text[open..].starts_with('['))
    else {
        return vec![];
    };
    let Some(close) = closer(text, open) else {
        return vec![];
    };
    // The message lists the names as `["x", "y"]`.
    let names = finding.detail.split('"').skip(1).step_by(2);
    let mut out = vec![];
    for name in names {
        for (i, start) in words(text, open + 1, close, name).into_iter().enumerate() {
            let message = if i == 0 {
                format!("`{name}` is first declared here")
            } else {
                "and declared again here".to_string()
            };
            out.push((start, name, message));
        }
    }
    out
}

/// QB019 and QB021: the first two places the column the message names is
/// named, in the table literal or the query the finding starts at - which
/// is all of the statement before the query's `from`.
fn columns<'a>(finding: &'a Finding, text: &str, at: usize) -> Vec<(usize, &'a str, String)> {
    let Some(name) = finding.detail.split('`').nth(1) else {
        return vec![];
    };
    let end = if text[at..].starts_with('(') {
        closer(text, at).unwrap_or(text.len())
    } else {
        // The line's end or its first ` from`, whichever comes first, read
        // no further: on one long line, reading to its end for each
        // finding was quadratic (#2114).
        let rest = &text.as_bytes()[at..];
        (0..rest.len())
            .find(|&i| rest[i] == b'\n' || rest[i..].starts_with(b" from"))
            .map_or(text.len(), |i| at + i)
    };
    let found = if finding.code == "QB021" {
        by_duplicate(text, at, end, name)
    } else {
        words(text, at, end, name)
    };
    let [first, second, ..] = found.as_slice() else {
        return vec![];
    };
    vec![
        (*first, name, format!("`{name}` is first named here")),
        (*second, name, "and named again here".to_string()),
    ]
}

/// QB021: where the query `text[at..end]` names its result column `name`
/// and where its by list does - the name an item starts with, `name:e` or
/// `name` alone, rather than a `name` an expression reads (`max a`). An
/// unnamed column (`max a`) is named from the expression, so for it the
/// first word is the place.
fn by_duplicate(text: &str, at: usize, end: usize, name: &str) -> Vec<usize> {
    let Some(by) = words(text, at, end, "by")
        .into_iter()
        .find(|&i| depth(&text[at..i]) == 0)
    else {
        return vec![];
    };
    // The list starts after the keyword and any `[n]` after it.
    let mut list = at
        + text[at..]
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(0);
    if text[list..].starts_with('[') {
        list = closer(text, list).map_or(by, |c| c + 1).min(by);
    }
    let named = |from: usize, to: usize, alone: bool| {
        items(text, from, to).into_iter().find(|&i| {
            let Some(rest) = text.get(i..to).and_then(|t| t.strip_prefix(name)) else {
                return false;
            };
            let rest = rest.trim_start_matches([' ', '\t']);
            words(text, i, i + name.len(), name) == [i]
                && ((rest.starts_with(':') && !rest.starts_with("::"))
                    || (alone && rest.is_empty()))
        })
    };
    let first = named(list, by, false).or_else(|| words(text, list, by, name).first().copied());
    let second =
        named(by + 2, end, true).or_else(|| words(text, by + 2, end, name).first().copied());
    first.into_iter().chain(second).collect()
}

/// Where each item of the comma-separated list `text[from..to]` starts,
/// past its blanks: the commas at bracket depth 0 separate them.
fn items(text: &str, from: usize, to: usize) -> Vec<usize> {
    let mut starts = vec![from];
    let mut depth = 0i32;
    for (i, b) in text[from..to].bytes().enumerate() {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => starts.push(from + i + 1),
            _ => {}
        }
    }
    starts
        .into_iter()
        .map(|s| s + text[s..to].len() - text[s..to].trim_start().len())
        .collect()
}

/// How many brackets `text` leaves open.
fn depth(text: &str) -> i32 {
    text.bytes()
        .map(|b| match b {
            b'(' | b'[' | b'{' => 1,
            b')' | b']' | b'}' => -1,
            _ => 0,
        })
        .sum()
}

/// Where `name` stands as a whole word between `from` and `to`: not part of
/// a longer name or a dotted one, nor a symbol.
fn words(text: &str, from: usize, to: usize, name: &str) -> Vec<usize> {
    let part = |b: u8| b.is_ascii_alphanumeric() || b"_.".contains(&b);
    let bytes = text.as_bytes();
    text[from..to]
        .match_indices(name)
        .map(|(i, _)| from + i)
        .filter(|&i| {
            (i == 0 || !part(bytes[i - 1]) && bytes[i - 1] != b'`')
                && bytes.get(i + name.len()).is_none_or(|&b| !part(b))
        })
        .collect()
}

/// The offset of the bracket that closes the one at `open`, counting every
/// kind of bracket as one depth.
fn closer(text: &str, open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, b) in text.bytes().enumerate().skip(open) {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}
