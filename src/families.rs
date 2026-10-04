//! Rule families taken from `docs/ruff-applicability.md`: hazards other
//! linters check for, translated to q and kept only where they survived a
//! run over a corpus of public q. Every rule here is `style` - q runs all of
//! it - so each has to earn its place by being right, not by being an error.
use crate::{Finding, argument_end, argument_start, boundary, matching, slots};

pub fn check(path: &str, source: &str, code: &str, comments: &str) -> Vec<Finding> {
    let mut out = vec![];
    query_injection(path, source, code, comments, &mut out);
    credentials(path, source, code, comments, &mut out);
    simplifications(path, source, code, &mut out);
    leftovers(path, source, comments, &mut out);
    duplicate_columns(path, source, code, &mut out);
    unreachable(path, source, code, &mut out);
    out
}

/// The argument of `name` at `after` - bracketed or juxtaposed - as an offset
/// range into the source, or None when there is none to read.
fn argument(code: &str, comments: &str, source: &str, after: usize) -> Option<(usize, usize)> {
    let rest = &code[after..];
    let open = after + (rest.len() - rest.trim_start_matches([' ', '\t']).len());
    if code[open..].starts_with('[') {
        let close = matching(code, open, b'[', b']')?;
        return Some((open + 1, close - 1));
    }
    let start = argument_start(source, comments, after)?;
    Some((start, argument_end(code, comments, source, start)?))
}

/// QX001. `value "select from t where sym=`",s` is how q gets injected: q has
/// no parameterised query, so a query is built by joining strings and run by
/// `value`, and whatever the joined value says is run with it. Verified: a
/// function doing exactly that, given `"a;secret:42;0"`, defines `secret` in
/// the process. A functional select takes the same value as data.
///
/// Only a query that is visibly built: the argument joins (`,` at its top
/// level) a string that names a qSQL statement with something that is not a
/// string literal. `value "select from t"` is a constant, and `value x` says
/// nothing about where `x` came from.
fn query_injection(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    for m in re!(r"\b(?:value|eval)\b").find_iter(code) {
        if !boundary(code, m.start()) {
            continue;
        }
        let Some((start, end)) = argument(code, comments, source, m.end()) else {
            continue;
        };
        let (text, masked) = (&comments[start..end], &code[start..end]);
        // Joined at the top level of the argument, with a name in the join:
        // the masked view has the strings blanked, so any name left in it is
        // a value flowing into the query.
        let mut depth = 0i32;
        let joined = masked.bytes().any(|b| {
            match b {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                _ => {}
            }
            b == b',' && depth == 0
        });
        // A name outside any `$[...]`: a conditional that only chooses
        // between string constants - KX's tick clog.q builds handler source
        // that way - splices in no data, whatever its condition reads.
        let mut unconditional = masked.as_bytes().to_vec();
        for (at, _) in masked.match_indices("$[") {
            if let Some(close) = matching(masked, at + 1, b'[', b']') {
                unconditional[at..close].fill(b' ');
            }
        }
        let spliced = unconditional.iter().any(u8::is_ascii_alphabetic);
        // The query text itself has to be one of the joined pieces, not a
        // branch of a conditional: there it is one of several constants.
        let mut top = text.as_bytes().to_vec();
        for (at, _) in masked.match_indices("$[") {
            if let Some(close) = matching(masked, at + 1, b'[', b']') {
                top[at..close].fill(b' ');
            }
        }
        let top = String::from_utf8_lossy(&top);
        let query = re!(r#""[^"]*\b(?:select|exec|update|delete)\b[^"]*""#).is_match(&top);
        if query && joined && spliced {
            out.push(Finding::at(
                path,
                source,
                m.start(),
                "QX001",
                "This query is built by joining strings and run by `value`, so a value \
                 spliced into it can rewrite it; a functional select (`?[t;c;b;a]`) takes \
                 the value as data"
                    .into(),
            ));
        }
    }
}

/// QX002. A password, secret or token written into source as a string
/// literal. The name has to say it holds one, and the value has to be a
/// non-empty literal: `passwordPrompt:"Enter password"` names a message, and
/// `password:getenv`PASS` reads one from where it belongs.
fn credentials(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    let secret = re!(r"(?i)(?:password|passwd|pwd|secret|token|api_?key|credentials?)$");
    let message = re!(
        r"(?i)prompt|msg|message|label|text|field|name|hint|key[s]?name|file|path|url|env|var|col"
    );
    for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*::?\s*\x22").captures_iter(comments) {
        let name = m.get(1).unwrap();
        // The assignment has to be code - the quote is blank there - and the
        // name the whole of one.
        if code.get(name.range()) != Some(name.as_str()) || !boundary(code, name.start()) {
            continue;
        }
        let last = name.as_str().rsplit('.').next().unwrap_or("");
        if !secret.is_match(last) || message.is_match(last) {
            continue;
        }
        let quote = m.get(0).unwrap().end() - 1;
        let value = re!(r#"^"((?:\\.|[^"\\])*)""#)
            .captures(&comments[quote..])
            .map(|c| c.get(1).unwrap().as_str());
        if value.is_some_and(|v| !v.trim().is_empty()) {
            out.push(Finding::at(
                path,
                source,
                name.start(),
                "QX002",
                format!(
                    "`{}` is assigned a string literal: a credential in source is in every \
                     copy of it; read it from the environment or a file at startup",
                    name.as_str()
                ),
            ));
        }
    }
}

/// #10: doing by hand what a q primitive does. Only rewrites q confirmed give
/// the same result on every input tried - nulls, symbols, strings, a
/// dictionary, a table, an atom, the empty list. Others the survey proposed
/// were dropped because they do not: `first asc x` is not `min x` once there
/// is a null (asc puts it first, min skips it), and `{x+y}/` is not `sum`,
/// which skips nulls too.
fn simplifications(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    let mut add = |at: usize, code_: &str, detail: String| {
        out.push(Finding::at(path, source, at, code_, detail));
    };
    // QR001: `reverse asc x` is `desc x`, and `reverse desc x` is `asc x`.
    for m in re!(r"\breverse\s+(asc|desc)\b").captures_iter(code) {
        let whole = m.get(0).unwrap();
        if boundary(code, whole.start()) {
            let other = if &m[1] == "asc" { "desc" } else { "asc" };
            add(
                whole.start(),
                "QR001",
                format!("`reverse {}` is `{other}`, in one pass", &m[1]),
            );
        }
    }
    // QR002: an identity lambda under each gives back what it was given.
    for m in re!(r"\{\s*x\s*\}\s*(?:each\b|'(?:[^:]|$))").find_iter(code) {
        add(
            m.start(),
            "QR002",
            "`{x} each` returns its argument unchanged".into(),
        );
    }
    // QR003: sorting the distinct items keeps them distinct.
    for m in re!(r"\bdistinct\s+asc\s+distinct\b").find_iter(code) {
        if boundary(code, m.start()) {
            add(
                m.start(),
                "QR003",
                "`distinct asc distinct x` is `asc distinct x`: sorting adds no duplicates".into(),
            );
        }
    }
    // QR004: arithmetic is atomic, so a lambda that does one operation with a
    // number needs no each - `{x+1} each x` is `1+x`, run on the whole list
    // at once. Only the visibly atomic shape: one of + - * % between x and a
    // numeric literal.
    for m in re!(
        r"\{\s*(?:x\s*[-+*%]\s*-?\d[A-Za-z0-9.]*|-?\d[A-Za-z0-9.]*\s*[-+*%]\s*x)\s*\}\s*(?:each\b|'(?:[^:]|$))"
    )
    .find_iter(code)
    {
        add(
            m.start(),
            "QR004",
            "Arithmetic is atomic: this applies to the whole list without `each`, and \
             faster"
                .into(),
        );
    }
}

/// #11: things left in q that were never meant to ship. Both are taste rather
/// than defects, so both are `styleq` - off in the default.
///
/// A third was tried and dropped: `0N!` mid-expression inside a lambda. On
/// the corpus six of its seven findings were progress output written on
/// purpose - a downloader printing its URL, a loader printing its file.
fn leftovers(path: &str, source: &str, comments: &str, out: &mut Vec<Finding>) {
    // A comment is blank in both masked views; a string is blank only in
    // `code`. So a byte blank in `comments` but not in the source is comment.
    let in_comment = |at: usize| comments.as_bytes()[at] == b' ' && source.as_bytes()[at] != b' ';
    // QL001: a marker saying the work is unfinished.
    for m in re!(r"\b(TODO|FIXME|XXX|HACK)\b").find_iter(source) {
        if in_comment(m.start()) {
            out.push(Finding::at(
                path,
                source,
                m.start(),
                "QL001",
                format!("`{}` marks unfinished work", m.as_str()),
            ));
        }
    }
    // QL002: a whole comment line that is a lambda definition - code kept
    // as a comment rather than deleted, which version control already keeps.
    for m in
        re!(r"(?m)^[ \t]*/+[ \t]*(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]*:[ \t]*\{").captures_iter(source)
    {
        let name = m.get(1).unwrap();
        if in_comment(name.start()) {
            out.push(Finding::at(
                path,
                source,
                m.get(0).unwrap().start(),
                "QL002",
                format!(
                    "`{}` is a lambda definition kept as a comment",
                    name.as_str()
                ),
            ));
        }
    }
}

/// QB019. A table literal naming one column twice. q 5 does not refuse it: it
/// renames the second, so `([]a:1 2;a:3 4)` has columns `a` and `a1`, and
/// code reading `a` gets the first without a word.
fn duplicate_columns(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for open in code.match_indices("(").map(|(i, _)| i) {
        let rest = code[open + 1..].trim_start();
        if !rest.starts_with('[') {
            continue;
        }
        let Some(close) = matching(code, open, b'(', b')') else {
            continue;
        };
        let inner = &code[open + 1..close - 1];
        let bracket = inner.len() - inner.trim_start().len();
        let Some(key_close) = matching(inner, bracket, b'[', b']') else {
            continue;
        };
        // Nothing after the brackets is a dictionary, where a repeated key is
        // allowed and kept.
        if inner[key_close..].trim().is_empty() {
            continue;
        }
        let mut seen: Vec<&str> = vec![];
        for part in slots(&inner[bracket + 1..key_close - 1])
            .into_iter()
            .chain(slots(&inner[key_close..]))
        {
            let Some((name, _)) = part.split_once(':') else {
                continue;
            };
            let name = name.trim();
            if !re!(r"^[A-Za-z][A-Za-z0-9_]*$").is_match(name) {
                continue;
            }
            if seen.contains(&name) {
                out.push(Finding::at(
                    path,
                    source,
                    open,
                    "QB019",
                    format!("Column `{name}` is named twice: q keeps both and renames the second, so `{name}` reads the first"),
                ));
                break;
            }
            seen.push(name);
        }
    }
}

/// QB020. A statement after a return or a signal at a lambda's top level can
/// never run: `{:1;2}` returns 1 and the 2 is dead. Only the top level - a
/// `:x` inside `if[...]` or `$[...]` is a branch, and what follows it runs.
fn unreachable(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for (brace, _) in code.match_indices('{') {
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let sig = crate::signature(code, source, brace);
        let body_start = sig.body;
        let body = &code[body_start..end - 1];
        let (mut depth, mut start) = (0i32, 0usize);
        let mut statements = vec![];
        for (i, b) in body.bytes().enumerate() {
            match b {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                b';' if depth == 0 => {
                    statements.push((start, i));
                    start = i + 1;
                }
                _ => {}
            }
        }
        statements.push((start, body.len()));
        let exits = |text: &str| {
            let t = text.trim_start();
            (t.starts_with(':') && !t.starts_with("::"))
                || (t.starts_with('\'') && !t.starts_with("':"))
        };
        if let Some(i) = statements.iter().position(|&(a, b)| exits(&body[a..b]))
            && let Some(&(a, _)) = statements[i + 1..]
                .iter()
                .find(|&&(a, b)| !body[a..b].trim().is_empty())
        {
            let at = body_start + a + (body[a..].len() - body[a..].trim_start().len());
            out.push(Finding::at(
                    path,
                    source,
                    at,
                    "QB020",
                    "This statement follows a return or signal at the lambda's top level, so it never runs".into(),
                ));
        }
    }
}
