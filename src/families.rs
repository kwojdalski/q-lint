//! Rule families taken from `docs/ruff-applicability.md`: hazards other
//! linters check for, translated to q and kept only where they survived a
//! run over a corpus of public q. Every rule here is `style` - q runs all of
//! it - so each has to earn its place by being right, not by being an error.
use crate::{Finding, argument_end, argument_start, boundary, matching, slots};

pub fn check(
    path: &str,
    source: &str,
    code: &str,
    comments: &str,
    foreign: &[usize],
) -> Vec<Finding> {
    let mut out = vec![];
    query_injection(path, source, code, comments, &mut out);
    credentials(path, source, code, comments, &mut out);
    simplifications(path, source, code, &mut out);
    leftovers(path, source, comments, foreign, &mut out);
    duplicate_columns(path, source, code, &mut out);
    select_by_duplicate(path, source, code, &mut out);
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
    // `get` of a string evaluates it as `value` does (q 5), and a string sent
    // over a handle - `h "select ...",x` - is evaluated by the remote
    // process's `.z.pg`, which is `value` by default. A name applied to a
    // query string is taken for a handle unless it is one of q's own.
    let handles: Vec<usize> =
        re!(r#"\b([A-Za-z][A-Za-z0-9_.]*)[ \t]+"(?:select|exec|update|delete)\b"#)
            .captures_iter(comments)
            .filter(|c| {
                let name = c.get(1).unwrap();
                code[name.start()..].starts_with(name.as_str())
                    && !crate::RESERVED.iter().any(|n| n == name.as_str())
            })
            .map(|c| c.get(1).unwrap().start())
            .collect();
    let calls = re!(r"\b(?:value|eval|get)\b")
        .find_iter(code)
        .map(|m| (m.start(), m.end()))
        .chain(handles.iter().map(|&at| {
            let end = at + code[at..].find([' ', '\t']).unwrap();
            (at, end)
        }));
    for (m_start, m_end) in calls {
        let m = Span {
            start: m_start,
            end: m_end,
        };
        // A system command line keeps its strings in every view, so its
        // commas would read as joins: `\t do[10;db "select a,b from t"]`.
        let line = code[..m.start()].rfind('\n').map_or(0, |p| p + 1);
        if !boundary(code, m.start()) || code[line..].starts_with('\\') {
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
                format!(
                    "This query is built by joining strings and run by `{}`, so a value \
                     spliced into it can rewrite it; a functional select (`?[t;c;b;a]`) takes \
                     the value as data",
                    match &code[m.start()..m.end()] {
                        f @ ("value" | "eval" | "get") => f.to_string(),
                        h => format!("{h}` over a handle and evaluated by the remote `.z.pg"),
                    }
                ),
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
        let value = re!(r#"^"((?:\\.|[^"\\])*)""#).captures(&comments[quote..]);
        // The literal has to be the whole value: in `token:"," vs x` and
        // `token:"Bearer ",x` it is a delimiter and a prefix, and the token
        // is computed.
        let whole = value
            .as_ref()
            .is_some_and(|c| crate::operand_ends(comments, quote + c.get(0).unwrap().end()));
        let value = value.map(|c| c.get(1).unwrap().as_str());
        if whole && value.is_some_and(|v| !v.trim().is_empty()) {
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
fn leftovers(path: &str, source: &str, comments: &str, foreign: &[usize], out: &mut Vec<Finding>) {
    // A comment is blank in both masked views; a string is blank only in
    // `code`. So a byte blank in `comments` but not in the source is comment.
    // A `p)` line and its indented continuation are blank in both too, and
    // are another language's: a `#TODO` in embedded Python is not q's.
    let in_comment = |at: usize| {
        let line = source[..at].rfind('\n').map_or(0, |n| n + 1);
        comments.as_bytes()[at] == b' ' && source.as_bytes()[at] != b' ' && !foreign.contains(&line)
    };
    // QL001: a marker saying the work is unfinished.
    for m in re!(r"\b(TODO|FIXME|XXX|HACK)\b").find_iter(source) {
        // `.kdb.XXX` or `` `XXX `` is a placeholder name, not a marker.
        let named = source[..m.start()].ends_with(['.', '`']);
        if in_comment(m.start()) && !named {
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
    // The same in a select or update list, where q 5 renames as well:
    // `select a,a from t` has columns a and a1, and so do `select max a,min a`
    // and `select a,max a`, each item named as `column_name` says. A select's
    // by list is renamed the same way - `select a by b,b` groups by b and b1 -
    // where update's by names no column and is left alone.
    for q in re!(r"\b(?:select|update)\b").find_iter(code) {
        if !crate::boundary(code, q.start()) || in_string(code, q.start()) {
            continue;
        }
        let rest = &code[q.end()..];
        let Some(stop) = re!(r"\b(?:by|from)\b").find(rest) else {
            continue;
        };
        let mut lists = vec![&rest[..stop.start()]];
        if stop.as_str() == "by"
            && q.as_str() == "select"
            && let Some(from) = re!(r"\bfrom\b").find(&rest[stop.end()..])
        {
            lists.push(&rest[stop.end()..stop.end() + from.start()]);
        }
        for list in lists {
            // A newline, a `;` outside brackets or the end of a lambda ends
            // the statement before the list does.
            if list.contains('\n') || !braces_close(list) || items_at_depth_zero(list, b';') {
                continue;
            }
            let mut seen: Vec<&str> = vec![];
            for name in items(list).into_iter().filter_map(column_name) {
                if seen.contains(&name) {
                    out.push(Finding::at(
                        path,
                        source,
                        q.start(),
                        "QB019",
                        format!("Column `{name}` is named twice: q keeps both and renames the second, so `{name}` reads the first"),
                    ));
                    break;
                }
                seen.push(name);
            }
        }
    }
}

/// The items of a select or by list: split at commas outside brackets, so
/// `select f[a,b],c` and `by xbar[2;a]` keep theirs whole.
fn items(list: &str) -> Vec<&str> {
    let mut items = vec![];
    let (mut depth, mut start) = (0i32, 0);
    for (i, b) in list.bytes().enumerate() {
        match b {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b',' if depth == 0 => {
                items.push(&list[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    items.push(&list[start..]);
    items
}

/// Whether `at` sits inside a string on its line. The masked view blanks
/// most strings, but not on a `\t` line, where `\t f "select min(p) ..."`
/// carries SQL that is not q.
fn in_string(code: &str, at: usize) -> bool {
    let line = code[..at].rfind('\n').map_or(0, |n| n + 1);
    let mut inside = false;
    let b = code.as_bytes();
    let mut i = line;
    while i < at {
        match b[i] {
            b'\\' if inside => i += 1,
            b'"' => inside = !inside,
            _ => {}
        }
        i += 1;
    }
    inside
}

/// Whether every `{` in `text` closes inside it, and no `}` closes one
/// opened before it: `{x} a` does, `a}` and `{a` do not.
fn braces_close(text: &str) -> bool {
    let mut depth = 0i32;
    for b in text.bytes() {
        match b {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return false;
        }
    }
    depth == 0
}

/// Whether `byte` occurs in `text` outside every bracket.
fn items_at_depth_zero(text: &str, byte: u8) -> bool {
    let mut depth = 0i32;
    text.bytes().any(|b| {
        match b {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            _ => {}
        }
        b == byte && depth == 0
    })
}

/// The column name q 5 gives a select or by item: its `name:`, or else the
/// name q derives from the expression, or None where that is not known.
///
/// Measured in q 5 with `cols select E from t`, and followed only that far:
/// - a column names itself, and the virtual `i` and any literal are `x`;
/// - `l+r`, `l-r`, `l*r`, `l%r`, `l&r`, `l|r`, `and`, `or` take the name of
///   their left operand, so `a+b` is `a` and `2+a` is `x`;
/// - `= < > <> <= >= ^ # @ ?` and `mod xbar div cross except wavg within in
///   xexp xlog` take the right one: `a=b` is `b`, `a mod 2` is `x`;
/// - a function applied, `max a`, `f a`, `{x} a`, takes its argument's;
/// - `f[a;b]` and `(a;b)` take their last item's: `g[1;a]` is `a`.
///
/// Anything else - an adverb, an unmeasured operator, a qualified name -
/// is None, and the rules reading this stay silent rather than guess.
fn column_name(item: &str) -> Option<&str> {
    let item = item.trim();
    if let Some(m) = re!(r"^([A-Za-z][A-Za-z0-9_]*)\s*:[^:]").captures(item) {
        return Some(m.get(1).unwrap().as_str());
    }
    expression_name(&tokens(item)?)
}

/// One token of a select item, for `column_name`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Tok<'a> {
    Name(&'a str),
    Lit,
    Op(&'a str),
    /// The inside of `(...)`.
    Group(&'a str),
    /// The inside of `[...]`.
    Args(&'a str),
    Lambda,
}

/// Operators that name their result after the left operand, and those that
/// name it after the right: both lists are q 5's, measured, and nothing
/// outside them is named.
const LEFT_NAMED: &[&str] = &["+", "-", "*", "%", "&", "|", "and", "or"];
const RIGHT_NAMED: &[&str] = &[
    "=", "<", ">", "<>", "<=", ">=", "^", "#", "@", "?", "mod", "xbar", "div", "cross", "except",
    "wavg", "within", "in", "xexp", "xlog",
];

fn tokens(s: &str) -> Option<Vec<Tok<'_>>> {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    let mut number_end = None;
    let digit = |at: usize| at < b.len() && b[at].is_ascii_digit();
    while i < b.len() {
        let c = b[i];
        let prev = s[..i].chars().next_back();
        let noun_before = prev.is_some_and(|p| p.is_alphanumeric() || ")]}\"_.`".contains(p));
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'"' {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
            i = (i + 1).min(b.len());
            out.push(Tok::Lit);
        } else if c == b'`' {
            while i < b.len() && b[i] == b'`' {
                i += 1;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b"_.:/".contains(&b[i])) {
                    i += 1;
                }
            }
            out.push(Tok::Lit);
        } else if digit(i)
            || (c == b'.' && digit(i + 1))
            || (c == b'-'
                && !noun_before
                && (digit(i + 1) || (b.get(i + 1) == Some(&b'.') && digit(i + 2))))
        {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b"._:".contains(&b[i])) {
                i += 1;
            }
            // `1 2` is one vector literal, not one number applied to another.
            if number_end != Some(s[..start].trim_end().len()) {
                out.push(Tok::Lit);
            }
            number_end = Some(i);
        } else if c.is_ascii_alphabetic()
            || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_alphabetic))
        {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b"_.".contains(&b[i])) {
                i += 1;
            }
            out.push(Tok::Name(&s[start..i]));
        } else if let Some((open, close)) = match c {
            b'(' => Some((b'(', b')')),
            b'[' => Some((b'[', b']')),
            b'{' => Some((b'{', b'}')),
            _ => None,
        } {
            let end = matching(s, i, open, close)?;
            let inner = &s[i + 1..end - 1];
            out.push(match c {
                b'(' => Tok::Group(inner),
                b'[' => Tok::Args(inner),
                _ => Tok::Lambda,
            });
            i = end;
        } else if b")]}".contains(&c) {
            return None;
        } else {
            let two = s.get(i..i + 2);
            let len = if matches!(two, Some("<>" | "<=" | ">=")) {
                2
            } else {
                1
            };
            out.push(Tok::Op(&s[i..i + len]));
            i += len;
        }
    }
    Some(out)
}

fn reserved(name: &str) -> bool {
    crate::RESERVED.iter().any(|r| r == name)
}

/// The name of an expression read right to left, as `column_name` explains.
fn expression_name<'a>(toks: &[Tok<'a>]) -> Option<&'a str> {
    // A term: something followed by at most one bracket list.
    let (&first, rest) = toks.split_first()?;
    let (args, rest) = match rest.split_first() {
        Some((&Tok::Args(a), rest)) => (Some(a), rest),
        _ => (None, rest),
    };
    if matches!(rest.first(), Some(Tok::Args(_))) {
        return None;
    }
    let term = || -> Option<&'a str> {
        match (first, args) {
            (Tok::Lambda, Some(a)) => last_slot_name(a),
            (Tok::Name(n), Some(a)) if !n.contains('.') => last_slot_name(a),
            (_, Some(_)) => None,
            (Tok::Name(n), None) => match n {
                _ if n.contains('.') || reserved(n) => None,
                "i" => Some("x"),
                _ => Some(n),
            },
            (Tok::Lit, None) => Some("x"),
            (Tok::Group(g), None) => last_slot_name(g),
            _ => None,
        }
    };
    let Some(&next) = rest.first() else {
        return term();
    };
    let op = match next {
        Tok::Op(o) => Some(o),
        Tok::Name(n) if LEFT_NAMED.contains(&n) || RIGHT_NAMED.contains(&n) => Some(n),
        _ => None,
    };
    if let Some(op) = op {
        let right = &rest[1..];
        if right.is_empty() {
            return None;
        }
        // The right side must read too, or the left may not be an operand.
        let named = expression_name(right);
        return if LEFT_NAMED.contains(&op) {
            named.and(term())
        } else if RIGHT_NAMED.contains(&op) {
            named
        } else {
            None
        };
    }
    // Application: a function, builtin or not, or a lambda, given what
    // follows it. A literal or a bracketed call applied to more is not read,
    // nor a column before an unmeasured builtin, `a bin b`.
    match (first, args) {
        (Tok::Name(n), None) if !n.contains('.') => {
            if !reserved(n) && matches!(next, Tok::Name(m) if reserved(m)) {
                return None;
            }
            expression_name(rest)
        }
        (Tok::Lambda, None) => expression_name(rest),
        _ => None,
    }
}

/// The name of the last `;`-slot of a bracket or parenthesis: `g[1;a]` and
/// `(1;a)` are both `a`.
fn last_slot_name(inner: &str) -> Option<&str> {
    let last = slots(inner).pop()?;
    if last.trim().is_empty() {
        return None;
    }
    expression_name(&tokens(last)?)
}

/// QB021. A select naming a result column the same as one of its by groups.
/// q 5 refuses it with 'dup names for cols/groups: `select a by a from t`,
/// `select max a by a from t` and `select a:b by a from t` all fail, where
/// `select m:max a by a from t` runs. exec and update with the same lists
/// run, so only select is read.
fn select_by_duplicate(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for q in re!(r"\bselect\b").find_iter(code) {
        if !crate::boundary(code, q.start()) || in_string(code, q.start()) {
            continue;
        }
        let rest = &code[q.end()..];
        let Some(by) = re!(r"\b(?:by|from)\b").find(rest) else {
            continue;
        };
        let Some(from) = re!(r"\bfrom\b").find(&rest[by.end()..]) else {
            continue;
        };
        if by.as_str() != "by" {
            continue;
        }
        let (list, groups) = (
            &rest[..by.start()],
            &rest[by.end()..by.end() + from.start()],
        );
        // A `;` outside brackets, a newline, or the end of a lambda ends the
        // statement before these lists do; `xbar[2;a]` and `{x} a` keep
        // their own.
        let both = format!("{list}{groups}");
        if both.contains('\n') || !braces_close(&both) || items_at_depth_zero(&both, b';') {
            continue;
        }
        let groups: Vec<_> = items(groups).into_iter().filter_map(column_name).collect();
        if let Some(name) = items(list)
            .into_iter()
            .filter_map(column_name)
            .find(|n| groups.contains(n))
        {
            out.push(Finding::at(
                path,
                source,
                q.start(),
                "QB021",
                format!(
                    "`{name}` names both a result column and a by group: q 5 refuses the select \
                     with 'dup names for cols/groups {name}; name the column, `m:max {name}`"
                ),
            ));
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
        // `'[f;g]` - or `' [f;g]` - is a composition, not a signal: q 5
        // `{'[neg;abs]; 2}[]` is 2.
        let exits = |text: &str| {
            let t = text.trim_start();
            (t.starts_with(':') && !t.starts_with("::"))
                || (t.starts_with('\'')
                    && !t.starts_with("':")
                    && !t[1..].trim_start().starts_with('['))
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

/// A start and end, standing in for a regex match where a rule gathers
/// positions from more than one pattern.
struct Span {
    start: usize,
    end: usize,
}
impl Span {
    fn start(&self) -> usize {
        self.start
    }
    fn end(&self) -> usize {
        self.end
    }
}

#[cfg(test)]
mod tests {
    use super::column_name;

    /// Each pair measured in q 5 with `cols select E from t`, t:([]a:1 2;b:3 4)
    /// and f:{x}, g:{x+y}.
    #[test]
    fn column_names_follow_q5() {
        let measured = [
            ("a+b", "a"),
            ("a-b", "a"),
            ("a*b", "a"),
            ("a%b", "a"),
            ("a&b", "a"),
            ("a|b", "a"),
            ("a and b", "a"),
            ("a or b", "a"),
            ("2+a", "x"),
            ("1+a", "x"),
            ("a=b", "b"),
            ("a<b", "b"),
            ("a>b", "b"),
            ("a<>b", "b"),
            ("a^b", "b"),
            ("a#b", "b"),
            ("a@b", "b"),
            ("a?b", "b"),
            ("a<=b", "b"),
            ("a>=b", "b"),
            ("a mod b", "b"),
            ("a xbar b", "b"),
            ("a div b", "b"),
            ("a cross b", "b"),
            ("a except b", "b"),
            ("a wavg b", "b"),
            ("a xlog b", "b"),
            ("a mod 2", "x"),
            ("a<2", "x"),
            ("a=2", "x"),
            ("a within 1 2", "x"),
            ("a in 1 2", "x"),
            ("a xexp 2", "x"),
            ("max a", "a"),
            ("f a", "a"),
            ("f[a]", "a"),
            ("{x} a", "a"),
            ("g[a;1]", "x"),
            ("sum 1+a", "x"),
            ("g[1;a]", "a"),
            ("(a;b)", "b"),
            ("(a)", "a"),
            ("max a+b", "a"),
            ("b+max a", "b"),
            ("f[a]+b", "a"),
            ("(a+b)*2", "a"),
            ("a+b*2", "a"),
            ("2*a+b", "x"),
            ("a b", "b"),
            ("a - 1", "a"),
            ("a-1", "a"),
            ("b xbar a", "a"),
            ("b>a", "a"),
            ("i", "x"),
            ("a+1 2", "a"),
            ("a+(b)", "a"),
            ("neg a", "a"),
            ("1 2", "x"),
            ("f[a]+f[b]", "a"),
            ("g[b;a]", "a"),
            ("{x+y}[a;b]", "b"),
            ("(a;1)", "x"),
            ("(1;a)", "a"),
            ("a=b+1", "b"),
            ("a+b=1", "a"),
            ("max[a]", "a"),
            ("f[a]=b", "b"),
            ("a+f b", "a"),
            ("max a mod b", "b"),
            ("a mod max b", "b"),
            ("count i", "x"),
            ("m:max a", "m"),
        ];
        for (expr, name) in measured {
            assert_eq!(column_name(expr), Some(name), "{expr}");
        }
        // Unmeasured, or adverbs: no name rather than a guess.
        for expr in [
            "f each a", "a+/b", "a$b", "a!b", "a like b", ".z.p", "a bin b", "-a",
        ] {
            assert_eq!(column_name(expr), None, "{expr}");
        }
    }
}
