//! Literals q refuses, read without running anything. Each rule here was
//! settled against q 5 shape by shape, including the near-misses it accepts,
//! and each reports in the default profile because q raises on the line.
use crate::{Finding, boundary, operand_ends};

pub fn check(path: &str, source: &str, code: &str, comments: &str) -> Vec<Finding> {
    let mut out = vec![];
    // Symbols blanked: `` `:hdb/2024.02.30 `` is a path, not a date, and
    // `` `s#... `` is read below from the unblanked view on purpose.
    let unsym = re!(r"`[A-Za-z0-9_.:/]*")
        .replace_all(code, |m: &regex::Captures| " ".repeat(m[0].len()))
        .into_owned();
    attributes(path, source, code, &mut out);
    temporals(path, source, &unsym, &mut out);
    missing_from(path, source, code, &unsym, &mut out);
    signals(path, source, code, comments, &mut out);
    where_assignment(path, source, code, &mut out);
    hopen_literal(path, source, code, &mut out);
    cast_character(path, source, code, comments, &mut out);
    monadic_glyph(path, source, code, comments, &mut out);
    juxtaposed_derived(path, source, code, comments, &mut out);
    out
}

/// QT024. An attribute applied to a literal it does not describe. Verified:
/// `` `s#3 1 2 `` is 's-fail, `` `u#1 1 2 `` 'u-fail, `` `p#1 2 1 `` 'u-fail;
/// `` `s#1 1 2 `` (ties) and `` `s#0N 1 2 `` (a null first) are sorted, and
/// symbols sort by byte, `` `B `` before `` `a ``. `` `g# `` never fails.
fn attributes(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for m in re!(
        r"`([spu])#[ \t]*((?:`[A-Za-z0-9_.]*){2,}|-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)+)"
    )
    .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        if !boundary(code, whole.start()) || !operand_ends(code, whole.end()) {
            continue;
        }
        let items = m.get(2).unwrap().as_str();
        // Symbols compare as bytes. Numbers compare as numbers, with q's
        // nulls first; anything that will not parse leaves the rule silent.
        let keys: Option<Vec<Key>> = if items.starts_with('`') {
            Some(
                items
                    .split('`')
                    .skip(1)
                    .map(|s| Key::Text(s.to_string()))
                    .collect(),
            )
        } else {
            items.split_whitespace().map(number).collect()
        };
        let Some(keys) = keys else { continue };
        let attr = &m[1];
        let fails = match attr {
            "s" => keys.windows(2).any(|w| w[0] > w[1]),
            "u" => (0..keys.len()).any(|i| keys[i + 1..].contains(&keys[i])),
            // Parted: every value's run is contiguous.
            _ => (0..keys.len())
                .any(|i| i > 0 && keys[i] != keys[i - 1] && keys[..i - 1].contains(&keys[i])),
        };
        if fails {
            let error = if attr == "s" { "s-fail" } else { "u-fail" };
            let shape = match attr {
                "s" => "is not in ascending order",
                "u" => "has a repeated item",
                _ => "has a value that comes back after another",
            };
            out.push(Finding::at(
                path,
                source,
                whole.start(),
                "QT024",
                format!("`` `{attr}# `` on a literal that {shape}: q raises '{error}"),
            ));
        }
    }
}

#[derive(PartialEq, PartialOrd, Debug)]
enum Key {
    Null,
    Number(f64),
    Text(String),
}

fn number(token: &str) -> Option<Key> {
    if re!(r"^0[Nn][hijef]?$").is_match(token) {
        return Some(Key::Null);
    }
    token
        .trim_end_matches(['h', 'i', 'j', 'e', 'f'])
        .parse::<f64>()
        .ok()
        .map(Key::Number)
}

/// QE006. A date or month that does not exist. q refuses the literal at parse:
/// `2024.02.30` is '2024.02.30 and `2024.13m` is '2024.13; leap years are
/// Gregorian, so 2000.02.29 parses and 1900.02.29 does not.
fn temporals(path: &str, source: &str, unsym: &str, out: &mut Vec<Finding>) {
    for m in re!(r"\b(\d{4})\.(\d{2})(?:\.(\d{2})|m\b)").captures_iter(unsym) {
        let whole = m.get(0).unwrap();
        // The year has to start the token: `1.2024.02.30` is not a date.
        if !unsym[..whole.start()].ends_with(|c: char| !c.is_ascii_alphanumeric() && c != '.')
            && whole.start() != 0
        {
            continue;
        }
        let (year, month): (u32, u32) = (m[1].parse().unwrap(), m[2].parse().unwrap());
        let day: Option<u32> = m.get(3).map(|d| d.as_str().parse().unwrap());
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let days = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if leap => 29,
            2 => 28,
            _ => 0,
        };
        let impossible = days == 0 || day.is_some_and(|d| d == 0 || d > days);
        if impossible {
            out.push(Finding::at(
                path,
                source,
                whole.start(),
                "QE006",
                format!(
                    "`{}` is no {}: q refuses the literal",
                    whole.as_str(),
                    if day.is_some() { "date" } else { "month" }
                ),
            ));
        }
    }
}

/// QE007. A select, exec or update with no `from` before its statement ends:
/// `select a by b t` and `{select x}` are 'from. (`delete` without one is a
/// different error, 'type, and is left out.)
fn missing_from(path: &str, source: &str, code: &str, unsym: &str, out: &mut Vec<Finding>) {
    for m in re!(r"\b(select|exec|update)\b").find_iter(unsym) {
        if !boundary(code, m.start()) {
            continue;
        }
        // The name assigned or passed rather than run: `select:1`, `.q.select`.
        let after = unsym[m.end()..].trim_start_matches([' ', '\t']);
        if after.starts_with(':')
            || after.starts_with(['[', ';', ')', ']', '}'])
            || after.is_empty()
        {
            continue;
        }
        // The statement runs to a `;` at this depth, the bracket that closes
        // around it, or an unindented next line.
        let bytes = unsym.as_bytes();
        let (mut at, mut depth) = (m.end(), 0i32);
        while at < bytes.len() {
            match bytes[at] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                b';' if depth == 0 => break,
                b'\n' if depth == 0 && !unsym[at + 1..].starts_with([' ', '\t']) => break,
                _ => {}
            }
            at += 1;
        }
        if !re!(r"\bfrom\b").is_match(&unsym[m.end()..at]) {
            out.push(Finding::at(
                path,
                source,
                m.start(),
                "QE007",
                format!(
                    "`{}` has no `from` before its statement ends: q raises 'from",
                    m.as_str()
                ),
            ));
        }
    }
}

/// QT025. A signal of something that is not a symbol or a string. Verified:
/// `'1`, `'1.5`, `'0N` and `'(1;2)` are 'stype - and so is `'"x"`, since a
/// one-character string is a char atom, not a string.
fn signals(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    // A signal opens an expression; after an operand the quote is each.
    // Not after `:` - `r:'5` is ((';:);`r;5), each applied to assignment,
    // and `{:'5}` does not parse; neither is a signal (q 5).
    // At any line's start too, or after a newline that only continues the
    // bracket before it: `{[x]` + `  '1}` is a signal (q 5: 'stype).
    for m in re!(r#"(')(-?\d[A-Za-z0-9.]*|"(?:[^"\\]|\\.)")"#).captures_iter(comments) {
        let quote = m.get(1).unwrap();
        let value = m.get(2).unwrap();
        if code.as_bytes()[quote.start()] != b'\'' {
            continue;
        }
        let at = quote.start();
        let line_start = comments[..at].rfind('\n').map_or(0, |p| p + 1);
        let before = comments[..at].trim_end_matches([' ', '\t', '\r', '\n']);
        if !(at == line_start
            || before.is_empty()
            || before.ends_with(['[', '(', ';', '{'])
            || re!(r"\{\s*\[[A-Za-z0-9_; \t]*\]$").is_match(before))
        {
            continue;
        }
        let rest = &code[value.end()..];
        if !rest
            .trim_start_matches([' ', '\t'])
            .starts_with([';', ']', ')', '}', '\n', '\r'])
            && !rest.trim().is_empty()
        {
            continue;
        }
        let what = if value.as_str().starts_with('"') {
            "a one-character string, which is a char atom"
        } else {
            "a number"
        };
        out.push(Finding::at(
            path,
            source,
            quote.start(),
            "QT025",
            format!("Signalling {what}: q signals only a symbol or a string, and raises 'stype"),
        ));
    }
}

/// QT028. An assignment in a where phrase: `select from t where a:1` is
/// 'type. The phrase wants booleans and the `:` was meant to be `=`. Only at
/// the phrase's top level - a lambda or a bracket inside it is its own.
fn where_assignment(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for w in re!(r"\bwhere\b").find_iter(code) {
        // The keyword, not a name ending in it: `registry.delete.where:{...}`.
        if !boundary(code, w.start()) {
            continue;
        }
        if !re!(r"\b(?:select|exec|update|delete)\b")
            .is_match(&code[code[..w.start()].rfind(['\n', ';']).map_or(0, |p| p + 1)..w.start()])
        {
            continue;
        }
        let bytes = code.as_bytes();
        let (mut at, mut depth) = (w.end(), 0i32);
        while at < bytes.len() {
            match bytes[at] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                b';' | b'\n' if depth == 0 => break,
                b':' if depth == 0
                    && code[..at]
                        .trim_end()
                        .ends_with(|c: char| c.is_alphanumeric() || c == '_')
                    && !code[at + 1..].starts_with([':', '/', '\\', '\''])
                    && !code[..at].ends_with([':', '/', '\\', '\'']) =>
                {
                    let name_start = code[..at]
                        .trim_end()
                        .rfind(|c: char| !(c.is_alphanumeric() || c == '_'))
                        .map_or(0, |p| p + 1);
                    // A name starts with a letter and stands alone: `09:35`
                    // and the `D00:00` of a timestamp are literals, and
                    // their colons are part of them.
                    if !code[name_start..].starts_with(|c: char| c.is_ascii_alphabetic())
                        || code[..name_start].ends_with(['.', '`'])
                    {
                        at += 1;
                        continue;
                    }
                    out.push(Finding::at(
                        path,
                        source,
                        name_start,
                        "QT028",
                        "An assignment in a where phrase: q raises 'type - the comparison is `=`"
                            .into(),
                    ));
                    break;
                }
                _ => {}
            }
            at += 1;
        }
    }
}

/// QT029. hopen given a literal that can never be a handle: a float, a
/// negative number, or a symbol without the `:` every handle starts with.
/// `hopen 1.5` and `` hopen `abc `` are 'type and `hopen -1` 'domain;
/// anything else can only fail at run time, if nothing is listening.
fn hopen_literal(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for m in
        // A symbol may hold `:` after its first character - `` `localhost:5000 ``
        // is one symbol - so the colon a handle needs is only the leading one.
        re!(r"\bhopen\s*(?:\[\s*)?(-\d+|\d*\.\d+|\d+\.\d*|`[A-Za-z0-9_.][A-Za-z0-9_.:]*)")
            .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        let value = m.get(1).unwrap();
        if !boundary(code, whole.start()) {
            continue;
        }
        let rest = code[value.end()..].trim_start_matches([' ', '\t']);
        if !(rest.is_empty() || rest.starts_with([';', ')', ']', '}', '\n', '\r'])) {
            continue;
        }
        let (what, error) = if value.as_str().starts_with('`') {
            ("a symbol without the leading `:` a handle needs", "'type")
        } else if value.as_str().contains('.') {
            ("a float", "'type")
        } else {
            ("a negative number", "'domain")
        };
        out.push(Finding::at(
            path,
            source,
            whole.start(),
            "QT029",
            format!("hopen given {what}: q raises {error}"),
        ));
    }
}

/// QT030. A cast to a character that is no type at all. Checked letter by
/// letter against an empty list, a number, a string and a symbol: a k l o q
/// r w y, in either case, are refused whatever the argument. Others are only
/// refused for some arguments - `"s"$()` is an empty symbol list, while
/// `"s"$"abc"` is 'type - and depend on what is cast, so are not here.
fn cast_character(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    for m in re!(r#""([A-Za-z])"\s*\$"#).captures_iter(comments) {
        let whole = m.get(0).unwrap();
        // A string in the source - blank in `code` - and not inside a longer one.
        if code.as_bytes()[whole.start()] != b' ' || comments[..whole.start()].ends_with('\\') {
            continue;
        }
        let c = &m[1];
        if "akloqrwyAKLOQRWY".contains(c) {
            out.push(Finding::at(
                path,
                source,
                whole.start(),
                "QT030",
                format!("`\"{c}\"$` casts to a type q does not have: 'type"),
            ));
        }
    }
}

/// QE008. A glyph applied to one argument by juxtaposition. q 5 has no
/// monadic form for any of them: `-x`, `,x`, `#x`, `~x`, `a:-x` and `1*-x`
/// are each refused by `parse` with the glyph as the error, and a lambda
/// holding one is refused when the script defines it. `-1` is a literal,
/// `(#)x` and `-:` are fine, and after an operand the glyph is dyadic.
fn monadic_glyph(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    let b = comments.as_bytes();
    let mut line_start = 0;
    for (i, &g) in b.iter().enumerate() {
        if i > 0 && b[i - 1] == b'\n' {
            line_start = i;
        }
        // Not in a string or a comment, nor on a system command or `#!` line.
        if !GLYPHS.contains(&g)
            || code.as_bytes()[i] != g
            || b[line_start] == b'\\'
            || comments[line_start..].starts_with("#!")
        {
            continue;
        }
        // What follows has to be an operand: not `:` (`-:`, `,:`), an
        // iterator, a bracket (`@[f;x;g]`, `$[c;a;b]`) or a negative literal.
        let rest = &comments[i + 1..];
        let next = rest.trim_start_matches([' ', '\t']);
        let spaced = next.len() < rest.len();
        let operand = next.starts_with(|c: char| c.is_ascii_alphabetic() || "`(\"".contains(c))
            || (next.starts_with(|c: char| c.is_ascii_digit() || c == '.')
                && (g != b'-' || spaced));
        if !operand {
            continue;
        }
        let before = comments[..i].trim_end_matches([' ', '\t', '\r', '\n']);
        if !opens_expression(comments, i, line_start) {
            continue;
        }
        // The sort in `select[>a]` and `select[2;<a]` is q's own syntax.
        if matches!(g, b'<' | b'>')
            && re!(r"(?:^|[^A-Za-z0-9.])select\s*\[(?:[^\[\];]*;)?$").is_match(before)
        {
            continue;
        }
        let mut finding = Finding::at(
            path,
            source,
            i,
            "QE008",
            format!(
                "`{}` has no monadic form in q 5: q refuses this line with '{}",
                g as char, g as char
            ),
        );
        finding.end_column = finding.column.map(|c| c + 1);
        out.push(finding);
    }
}

const GLYPHS: &[u8] = b"+-*%!#$&|^=<>~,@?";

/// Whether the token at `i` starts an expression, so that whatever it applies
/// to is applied by juxtaposition: the start of a line or statement, after
/// `:`, an opening bracket or a signature, or after another glyph.
fn opens_expression(comments: &str, i: usize, line_start: usize) -> bool {
    // Pairs QE004 already reports, or that are one operator.
    const PAIRS: &[&str] = &[
        "<>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=", "*=", "->", "=>",
    ];
    let before = comments[..i].trim_end_matches([' ', '\t', '\r', '\n']);
    let adjacent = before.len() == i;
    i == line_start
        || before.is_empty()
        || before.ends_with([':', '(', '[', '{', ';'])
        || re!(r"\{\s*\[[A-Za-z0-9_; \t]*\]$").is_match(before)
        || (before
            .bytes()
            .next_back()
            .is_some_and(|p| GLYPHS.contains(&p))
            && !(adjacent && PAIRS.contains(&&comments[i - 1..=i])))
}

/// QE009. A derived function applied by juxtaposition at the start of an
/// expression. q 5 refuses it at parse time - `{+/x}`, `{,/x}`, `{x/y}`,
/// `{count'x}`, `{{x+y}/x}` and `{sum/:x}` are each an error naming the
/// iterator - and a script stops at the lambda holding one. Applied infix
/// (`0+/x`, `x,/:y`), in parentheses (`(,/)x`) or in brackets (`,/[x]`) it is
/// fine, and so is the keyword (`sum x`, `raze x`, `count each x`).
fn juxtaposed_derived(
    path: &str,
    source: &str,
    code: &str,
    comments: &str,
    out: &mut Vec<Finding>,
) {
    // Symbols filled with digits: a path such as `:hdb/2024 is not a name
    // and an iterator, and `` ` sv'x `` still has an operand on the left.
    let view = re!(r"`[A-Za-z0-9_.:/]*")
        .replace_all(comments, |m: &regex::Captures| "0".repeat(m[0].len()));
    let b = view.as_bytes();
    let c = code.as_bytes();
    let mut opens: Vec<usize> = vec![];
    let mut lambda = std::collections::HashMap::new();
    for (i, &ch) in c.iter().enumerate() {
        if ch == b'{' {
            opens.push(i);
        } else if ch == b'}'
            && let Some(o) = opens.pop()
        {
            lambda.insert(i, o);
        }
    }
    for m in re!(r"(?:[-+*%!#$&|^=<>~,@?]|\.?[A-Za-z][A-Za-z0-9_.]*|\})(?:/:|\\:|':|/|\\|')")
        .find_iter(&view)
    {
        let token = m.start();
        let iterator = token + m.as_str().find(['/', '\\', '\'']).unwrap();
        // Both the token and the iterator are code, not string or comment.
        if c[iterator] != b[iterator] || (c[token] != b[token] && b[token] != b'0') {
            continue;
        }
        let start = match b[token] {
            b'}' => match lambda.get(&token) {
                Some(&o) => o,
                None => continue,
            },
            ch if (ch.is_ascii_alphabetic() || ch == b'.') && !boundary(&view, token) => continue,
            _ => token,
        };
        let line_start = view[..start].rfind('\n').map_or(0, |p| p + 1);
        if b[line_start] == b'\\' {
            continue;
        }
        // Applied to an operand right after the iterator: a name, a symbol,
        // a bracketed or quoted value, or a number.
        let next = view[m.end()..].trim_start_matches([' ', '\t']);
        let operand = next
            .starts_with(|ch: char| ch.is_ascii_alphanumeric() || "`(\"".contains(ch))
            || ((next.starts_with('-') || next.starts_with('.'))
                && next[1..].starts_with(|ch: char| ch.is_ascii_digit()));
        if !operand || !opens_expression(&view, start, line_start) {
            continue;
        }
        let iter = &view[iterator..m.end()];
        let mut finding = Finding::at(
            path,
            source,
            iterator,
            "QE009",
            format!(
                "q 5 refuses a derived function applied by juxtaposition ('{}): write it in \
                 parentheses, with brackets, or as the keyword",
                &iter[..1]
            ),
        );
        finding.end_column = finding.column.map(|col| col + iter.len());
        out.push(finding);
    }
}
