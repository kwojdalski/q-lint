//! The second place a diagnostic points at, as LSP's `relatedInformation`:
//! the first of two parameters with one name (QF008), the first of two
//! columns with one name (QB019), and the result column a by group repeats
//! (QB021). A finding names the lambda or the query; which names in it
//! collide it says in its message, and where they are is read here from the
//! same text - never run.
use super::Lines;
use q_lint_rs::Finding;
use serde_json::{Value, json};

/// The related locations for `finding`, which starts at byte `at` of
/// `text`, each a location in `uri` with a message - or none, for a rule
/// that points at one place only.
pub(super) fn related(
    finding: &Finding,
    text: &str,
    lines: &Lines,
    at: usize,
    uri: &str,
) -> Vec<Value> {
    let places = match finding.code.as_str() {
        "QF008" => parameters(finding, text, at),
        "QB019" | "QB021" => columns(finding, text, at),
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
        let line = text[at..].find('\n').map_or(text.len(), |n| at + n);
        text[at..line].find(" from").map_or(line, |n| at + n)
    };
    let found = words(text, at, end, name);
    let [first, second, ..] = found.as_slice() else {
        return vec![];
    };
    vec![
        (*first, name, format!("`{name}` is first named here")),
        (*second, name, "and named again here".to_string()),
    ]
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
