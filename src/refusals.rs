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
    attributes(path, source, code, comments, &mut out);
    temporals(path, source, comments, &unsym, &mut out);
    missing_from(path, source, code, &unsym, &mut out);
    signals(path, source, code, comments, &mut out);
    where_assignment(path, source, code, &mut out);
    hopen_literal(path, source, code, comments, &mut out);
    cast_character(path, source, code, comments, &mut out);
    monadic_glyph(path, source, code, comments, &mut out);
    juxtaposed_derived(path, source, code, comments, &mut out);
    numbers(path, source, code, &unsym, &mut out);
    out
}

/// QT024. An attribute applied to a literal it does not describe. Verified:
/// `` `s#3 1 2 `` is 's-fail, `` `u#1 1 2 `` 'u-fail, `` `p#1 2 1 `` 'u-fail;
/// `` `s#1 1 2 `` (ties) and `` `s#0N 1 2 `` (a null first) are sorted, and
/// symbols sort by byte, `` `B `` before `` `a ``. `` `g# `` never fails.
/// A string is a list of chars and is checked the same way: q 5 `s#"cba"` is
/// 's-fail and `u#"aa"` 'u-fail. It is read from `comments`, where the
/// string is still text.
fn attributes(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    for m in re!(
        r#"`([spu])#[ \t]*((?:`[A-Za-z0-9_.]*){2,}|-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)+|"[^"\\]{2,}")"#
    )
    .captures_iter(comments)
    {
        let whole = m.get(0).unwrap();
        if code.as_bytes()[whole.start()] != b'`'
            || !boundary(code, whole.start())
            || !operand_ends(code, whole.end())
        {
            continue;
        }
        let items = m.get(2).unwrap().as_str();
        // Symbols compare as bytes. Numbers compare as numbers, with q's
        // nulls first; anything that will not parse leaves the rule silent.
        let keys: Option<Vec<Key>> = if let Some(chars) = items.strip_prefix('"') {
            Some(
                chars
                    .trim_end_matches('"')
                    .chars()
                    .map(|c| Key::Text(c.to_string()))
                    .collect(),
            )
        } else if items.starts_with('`') {
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

/// QE006. A date, month or time q refuses at parse. A date or month that does not exist:
/// `2024.02.30` is '2024.02.30 and `2024.13m` is '2024.13; leap years are
/// Gregorian, so 2000.02.29 parses and 1900.02.29 does not.
fn temporals(path: &str, source: &str, comments: &str, unsym: &str, out: &mut Vec<Finding>) {
    // Minutes and seconds stop at 59 wherever they appear - a minute, second,
    // time, timespan or timestamp - while hours run on: q 5 refuses `12:60`,
    // `12:00:60` and `0D00:00:60`, and takes `25:00` and `0D25:00:00`.
    for m in re!(r"(\d{2,}):(\d{2})(?::(\d{2}))?").captures_iter(unsym) {
        let whole = m.get(0).unwrap();
        // Part of a longer token: a date's or number's digits, or a name
        // such as `p60` in `p60:60`, which assigns 60 rather than writing a
        // time. The `D` of `0D00:00:60` and the `T` of a datetime start no name.
        let head = &unsym[..whole.start()];
        let word = head.trim_end_matches(|c: char| c.is_ascii_alphanumeric() || "._".contains(c));
        if head.ends_with(|c: char| c.is_ascii_digit() || c == '.')
            || head[word.len()..].starts_with(|c: char| c.is_ascii_alphabetic() || "._".contains(c))
        {
            continue;
        }
        let field = |i| {
            m.get(i)
                .map_or(0, |f: regex::Match| f.as_str().parse::<u32>().unwrap())
        };
        if field(2) > 59 || field(3) > 59 {
            out.push(Finding::at(
                path,
                source,
                whole.start(),
                "QE006",
                format!(
                    "`{}` is no time: minutes and seconds stop at 59, and q refuses the literal",
                    whole.as_str()
                ),
            ));
        }
    }
    // Minutes and seconds take two digits, and so does an hour: q 5 refuses
    // `12:5`, `12:00:5`, `0D1:30` and `2023.01.01D1:30`, and takes `01:30`,
    // `123:45` and `12:345` (as 12:34). A one-digit hour with nothing on its
    // left is no literal at all - `1:30`, `x:1:30` and `(1:30)` are '1: at
    // parse - while `h 1:30` is the dyadic `1:`, a file write, and is fine.
    let mut refuse = |at: usize, text: &str, why: &str| {
        out.push(Finding::at(
            path,
            source,
            at,
            "QE006",
            format!("`{text}` is no time: {why}"),
        ));
    };
    for m in re!(r"(\d+)[DT](\d):\d|(\d+):(\d+)(?::(\d+))?").captures_iter(unsym) {
        let whole = m.get(0).unwrap();
        let before = &unsym[..whole.start()];
        let line = before.rfind('\n').map_or(0, |p| p + 1);
        if unsym[line..].starts_with('\\') {
            continue;
        }
        let rest = &unsym[whole.end()..];
        let tail = rest.len()
            - rest
                .trim_start_matches(|c: char| c.is_ascii_digit() || c == ':')
                .len();
        if m.get(1).is_some() {
            // `2023.01.01D1:30` matches from the date's last field.
            let start = before
                .trim_end_matches(|c: char| c.is_ascii_digit() || c == '.')
                .len();
            if boundary(unsym, start) {
                refuse(
                    start,
                    &unsym[start..whole.end() + tail],
                    "the hour takes two digits, and q refuses the literal",
                );
            }
            continue;
        }
        // The hour starts the token, or follows the `D` of a timespan or the
        // `D` or `T` of a timestamp or datetime.
        let stamp = before.ends_with(['D', 'T'])
            && before[..before.len() - 1].ends_with(|c: char| c.is_ascii_digit());
        if !stamp && !boundary(unsym, whole.start()) {
            continue;
        }
        let text = &unsym[whole.start()..whole.end() + tail];
        if m[3].len() >= 2 {
            if m[4].len() == 1 || m.get(5).is_some_and(|s| s.as_str().len() == 1) {
                refuse(
                    whole.start(),
                    text,
                    "minutes and seconds take two digits, and q refuses the literal",
                );
            }
        } else if !stamp {
            // Read in `comments`, which keeps symbols and strings: the left
            // operand of `h 1:30` may be either.
            let left = comments[..whole.start()].trim_end();
            if whole.start() == line
                || left.is_empty()
                || left.ends_with(|c: char| ":([;{,+*%&|=<>~#$^!?@".contains(c))
            {
                refuse(
                    whole.start(),
                    text,
                    "the hour takes two digits, and with nothing on its left q refuses \
                     the `:` at parse",
                );
            }
        }
    }
    // A month has two digits: q 5 refuses `2023.1m`.
    for m in re!(r"\b\d{4}\.\dm\b").find_iter(unsym) {
        if unsym[..m.start()].ends_with(|c: char| c.is_ascii_alphanumeric() || c == '.') {
            continue;
        }
        out.push(Finding::at(
            path,
            source,
            m.start(),
            "QE006",
            format!(
                "`{}` is no month: it takes two digits, and q refuses the literal",
                m.as_str()
            ),
        ));
    }
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

/// QE007. A select, exec, update or delete with no `from` before its
/// statement ends, or nothing after it: `select a by b t`, `{select x}`,
/// `delete a` and `select a from` are each 'from at parse time (q 5), and
/// `select from t where` - a where phrase with nothing in it - is ',.
fn missing_from(path: &str, source: &str, code: &str, unsym: &str, out: &mut Vec<Finding>) {
    for m in re!(r"\b(select|exec|update|delete)\b").find_iter(unsym) {
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
        let statement = &unsym[m.end()..at];
        let from = re!(r"\bfrom\b").find_iter(statement).last();
        let detail = match from {
            None => "has no `from` before its statement ends: q raises 'from",
            // Read from `code`, where `` from `t `` still has its table.
            Some(f) if code[m.end() + f.end()..at].trim().is_empty() => {
                "has nothing after its `from`: q raises 'from"
            }
            // A where phrase with nothing in it: q 5 `parse "exec a from t
            // where"` and `parse "select from t where"` are ',.
            Some(f)
                if re!(r"\bwhere\b")
                    .find_iter(&statement[f.end()..])
                    .last()
                    .is_some_and(|w| {
                        code[m.end() + f.end() + w.end()..at].trim().is_empty()
                            && boundary(code, m.end() + f.end() + w.start())
                    }) =>
            {
                "has nothing after its `where`: q raises ',"
            }
            Some(_) => continue,
        };
        out.push(Finding::at(
            path,
            source,
            m.start(),
            "QE007",
            format!("`{}` {detail}", m.as_str()),
        ));
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
    // A list cannot be signalled either: q 5 `'(1;2)`, `'()`, `'(1)` and
    // `` '`a`b `` are each 'stype.
    for m in re!(r#"(')(-?\d[A-Za-z0-9.]*|"(?:[^"\\]|\\.)"|\(\s*\)|\(\s*-?\d[A-Za-z0-9.]*\s*\)|\([^()"]*;[^()]*\)|(?:`[A-Za-z0-9_.]*){2,})"#).captures_iter(comments) {
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
        } else if value.as_str().starts_with('`') || value.as_str().contains(';') || value.as_str().trim_matches(['(', ')', ' ']).is_empty() {
            "a list"
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
        // The qSQL keyword, and its `from` before this `where`: in
        // `exec where m:a>0 from t` the `where` is the function, in a column.
        let head = &code[code[..w.start()].rfind(['\n', ';']).map_or(0, |p| p + 1)..w.start()];
        if !re!(r"\b(?:select|exec|update|delete)\b[\s\S]*\bfrom\b").is_match(head) {
            continue;
        }
        let bytes = code.as_bytes();
        // `depth` counts every bracket, `nested` only those that are not
        // parentheses: an assignment in `(a:1)` is still the phrase's own
        // (q 5: 'type), one in a lambda or a bracket is not.
        let (mut at, mut depth, mut nested) = (w.end(), 0i32, 0i32);
        // Where the current sub-phrase starts. q 5 refuses an assignment
        // only when it is the whole sub-phrase - `where a:1`, `where
        // a=1,b:2`, `where (a:1)` - and runs `where a in b:1 2` and
        // `where (b:1)>0`, where the assignment is an operand.
        let mut sub = w.end();
        while at < bytes.len() {
            if depth == 0 && boundary(code, at) && re!(r"^(?:from|by)\b").is_match(&code[at..]) {
                break;
            }
            match bytes[at] {
                b',' if depth == 0 => sub = at + 1,
                b'(' => depth += 1,
                b'[' | b'{' => {
                    depth += 1;
                    nested += 1;
                }
                b')' | b']' | b'}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                    if bytes[at] != b')' {
                        nested -= 1;
                    }
                }
                b';' | b'\n' if depth == 0 => break,
                b':' if nested == 0
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
                        || !whole_sub_phrase(code, sub, name_start, at)
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

/// Whether the assignment to the name at `name`, its `:` at `colon`, is the
/// whole sub-phrase opened at `sub`: only parentheses before it, and once
/// the parenthesis it sits in closes, only closing ones up to the phrase's
/// next `,` or its end.
fn whole_sub_phrase(code: &str, sub: usize, name: usize, colon: usize) -> bool {
    let lead = &code[sub..name];
    if !lead.trim().chars().all(|c| c == '(') {
        return false;
    }
    let opens = lead.matches('(').count() as i32;
    let mut depth = opens;
    for c in code[colon..].chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            ',' | ';' | '\n' if depth <= 0 => return true,
            c if depth < opens && !c.is_whitespace() => return false,
            _ => {}
        }
    }
    true
}

/// QT029. hopen given a literal that can never be a handle: a float, a
/// negative number, or a symbol without the `:` every handle starts with.
/// `hopen 1.5` and `` hopen `abc `` are 'type and `hopen -1` 'domain;
/// anything else can only fail at run time, if nothing is listening.
fn hopen_literal(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    for m in
        // A symbol may hold `:` after its first character - `` `localhost:5000 ``
        // is one symbol - so the colon a handle needs is only the leading one.
        // A real (`1.5e`, `2e`), the empty symbol and the empty string are
        // 'type too (q 5); the string is read from `comments`.
        re!(r#"\bhopen\s*(?:\[\s*)?(-\d+|\d*\.\d+e?|\d+\.\d*e?|\d+e|`(?:[A-Za-z0-9_.][A-Za-z0-9_.:]*)?|"")"#)
            .captures_iter(comments)
    {
        let whole = m.get(0).unwrap();
        let value = m.get(1).unwrap();
        if !boundary(code, whole.start()) || !code[whole.start()..].starts_with("hopen") {
            continue;
        }
        if !crate::operand_ends(code, value.end()) {
            continue;
        }
        let (what, error) = if value.as_str() == "`" {
            ("the empty symbol", "'type")
        } else if value.as_str() == "\"\"" {
            ("the empty string", "'type")
        } else if value.as_str().starts_with('`') {
            ("a symbol without the leading `:` a handle needs", "'type")
        } else if value.as_str().contains(['.', 'e']) {
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
        // QT031. An uppercase cast parses text, so it takes a string: q 5
        // `"J"$1`, `"J"$1 2`, `"D"$20230101` and `"S"$`a` are each 'type.
        // `"C"$` is the exception for an atom: q 5 hands `1`, `` `a ``,
        // `1.5`, `0x01` and `2024.01.01` back unchanged, and only a vector
        // (`1 2`, `` `a`b ``, `10b`, `0x0102`) is 'type.
        let operand = &comments[whole.end()..];
        let operand = operand.trim_start_matches([' ', '\t']);
        let start = whole.end() + comments[whole.end()..].len() - operand.len();
        if c.chars().all(|c| c.is_ascii_uppercase())
            && !"AKLOQRWY".contains(c)
            && let Some(lit) =
                re!(r"^(?:-?\d[A-Za-z0-9.:]*(?:[ \t]+-?\d[A-Za-z0-9.:]*)*|(?:`[A-Za-z0-9_.:]*)+)")
                    .find(operand)
            && crate::operand_ends(code, start + lit.end())
            && (c != "C" || !atom_literal(lit.as_str()))
        {
            out.push(Finding::at(
                path,
                source,
                whole.start(),
                "QT031",
                format!(
                    "`\"{c}\"$` parses a string, and `{}` is not one: 'type (the lowercase \"{}\"$ casts)",
                    lit.as_str(),
                    c.to_ascii_lowercase()
                ),
            ));
        }
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

/// Whether a literal QT031 matched is one atom: no space, at most one
/// symbol, and not a boolean or byte vector written as one token.
fn atom_literal(lit: &str) -> bool {
    if lit.contains([' ', '\t']) || lit.matches('`').count() > 1 {
        return false;
    }
    if let Some(hex) = lit.strip_prefix("0x") {
        return hex.len() == 2;
    }
    !re!(r"^[01]{2,}b$").is_match(lit)
}

/// QE008. A glyph applied to one argument by juxtaposition. q 5 has no
/// monadic form for any of them: `-x`, `,x`, `#x`, `~x`, `_x`, `a:-x` and `1*-x`
/// are each refused by `parse` with the glyph as the error, and a lambda
/// holding one is refused when the script defines it. The k-style monadic
/// form fares no better: `#:a`, `-:a`, `b:,:a` and `1+#:a` are each refused
/// with the glyph and its colon (`'#:`). `-1` is a literal, `(#)x`, `(#:)a`,
/// `#:[a]` and `f:#:` are fine, and after an operand the glyph is dyadic
/// (`a,:1` and `a-:1` amend in place).
fn monadic_glyph(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    let b = comments.as_bytes();
    let mut line_start = 0;
    for (i, &g) in b.iter().enumerate() {
        if i > 0 && b[i - 1] == b'\n' {
            line_start = i;
        }
        // Not in a string or a comment, nor on a system command or `#!` line.
        // `_` too: `_x`, `_1.5` and `1+_x` are '_ in q 5, while `x _1`,
        // `1 _x` and the `_` inside `x_y` follow an operand.
        if !(GLYPHS.contains(&g) || g == b'_')
            || code.as_bytes()[i] != g
            || b[line_start] == b'\\'
            || comments[line_start..].starts_with("#!")
        {
            continue;
        }
        // What follows has to be an operand: not `:` (`-:`, `,:`), an
        // iterator, a bracket (`@[f;x;g]`, `$[c;a;b]`) or a negative literal.
        let rest = &comments[i + 1..];
        // `#:a`: the k form, a glyph and a colon, applied to an operand
        // written straight after it.
        let colon = rest.starts_with(':')
            && rest[1..].starts_with(|c: char| c.is_ascii_alphanumeric() || "`(\".".contains(c))
            || rest.starts_with(":-") && rest[2..].starts_with(|c: char| c.is_ascii_digit());
        let next = rest.trim_start_matches([' ', '\t']);
        let spaced = next.len() < rest.len();
        let operand = colon
            || next.starts_with(|c: char| c.is_ascii_alphabetic() || "`(\"".contains(c))
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
        let mut finding = Finding::at(path, source, i, "QE008", {
            let glyph = if colon {
                format!("{}:", g as char)
            } else {
                (g as char).to_string()
            };
            format!("`{glyph}` has no monadic form in q 5: q refuses this line with '{glyph}")
        });
        finding.end_column = finding.column.map(|c| c + if colon { 2 } else { 1 });
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
        "<>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=", "*=", "->", "=>", "**", "=<", "<<",
        "|>", ":=", "%%", "++", ">>",
    ];
    let before = comments[..i].trim_end_matches([' ', '\t', '\r', '\n']);
    let adjacent = before.len() == i;
    if adjacent && i > 0 && PAIRS.contains(&&comments[i - 1..=i]) {
        return false;
    }
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

/// The narrow integer type a vector item is parsed as, and the largest
/// magnitude it holds: its own `i` or `h` suffix, or the one after the last
/// item of its vector. q 5 refuses `2147483648i`, `-2147483648i` (that is
/// 0Ni's bit pattern, not a number) and `32768h`, and takes `2147483647i`.
fn narrow(text: &str, last: &str) -> Option<(&'static str, u128)> {
    let suffix = if re!(r"^\d+[hi]$").is_match(text) {
        text
    } else if re!(r"^\d+$").is_match(text) && re!(r"^\d+[hi]$").is_match(last) {
        last
    } else {
        return None;
    };
    Some(if suffix.ends_with('i') {
        ("an int", i32::MAX as u128)
    } else {
        ("a short", i16::MAX as u128)
    })
}

/// QE010. A number q 5 will not parse. Each shape was refused by `parse`,
/// which names the token: an integer type with a fraction (`1.5j`, and
/// `1.5 2j`, where the suffix types every item), a suffix on any item but
/// the last (`3i 4j`, `1e 2`), a boolean digit that is not 0 or 1 (`2b`), a
/// letter that is no type (`1y`, `1d`, `1m`), dots that make no date
/// (`1.2.3`, `2023.1.1`), a long past 9223372036854775807, and an int or
/// short past its own range (`2147483648i`, `32768h`). A boolean
/// vector of atoms is not a vector at all - `1b 0b` parses, as two atoms -
/// and `0N 1`, `3 4i`, `1e5` and `2023.01.01` are fine.
fn numbers(path: &str, source: &str, code: &str, unsym: &str, out: &mut Vec<Finding>) {
    let tokens: Vec<regex::Match> = re!(r"\d[0-9A-Za-z.:]*")
        .find_iter(unsym)
        .filter(|m| boundary(code, m.start()))
        // q's nulls and infinities: 0n, 0w, 0N, 0Wj and the rest.
        .filter(|m| !re!(r"^0[nNwW]").is_match(m.as_str()))
        .filter(|m| {
            let line = unsym[..m.start()].rfind('\n').map_or(0, |p| p + 1);
            !unsym[line..].starts_with('\\')
        })
        .collect();
    let mut report = |at: usize, detail: String| {
        out.push(Finding::at(path, source, at, "QE010", detail));
    };
    let mut i = 0;
    while i < tokens.len() {
        // A run of items separated by spaces only is one vector literal.
        let mut j = i;
        while j + 1 < tokens.len()
            && unsym[tokens[j].end()..tokens[j + 1].start()]
                .bytes()
                .all(|b| b == b' ' || b == b'\t')
            && tokens[j].end() < tokens[j + 1].start()
        {
            j += 1;
        }
        let run = &tokens[i..=j];
        let last = run[run.len() - 1].as_str();
        let mut reported = false;
        for (k, t) in run.iter().enumerate() {
            let text = t.as_str();
            let detail = if re!(r"^\d+\.\d*[hij]$").is_match(text) {
                Some(format!(
                    "`{text}`: an integer type takes no fractional part"
                ))
            } else if re!(r"^\d*[2-9]\d*b$").is_match(text) {
                Some(format!("`{text}`: a boolean is written with 0 and 1 only"))
            } else if re!(r"^\d+[adgklmoqrwyz]$").is_match(text)
                || (re!(r"^\d+x$").is_match(text) && text != "0x")
            {
                Some(format!(
                    "`{text}`: `{}` is not a type suffix",
                    &text[text.len() - 1..]
                ))
            } else if re!(r"^\d+(?:\.\d+){2,}$").is_match(text)
                && !re!(r"^\d{4}\.\d{2}\.\d{2}$").is_match(text)
            {
                Some(format!("`{text}` is not a number or a date (yyyy.mm.dd)"))
            } else if re!(r"^\d{19,}j?$").is_match(text)
                && text
                    .trim_end_matches('j')
                    .parse::<u128>()
                    .is_ok_and(|v| v > i64::MAX as u128)
            {
                Some(format!("`{text}` does not fit in a long"))
            } else if let Some((kind, max)) = narrow(text, last)
                && text
                    .trim_end_matches(['h', 'i'])
                    .parse::<u128>()
                    .is_ok_and(|v| v > max)
            {
                // The suffix types every item, so `1 2 2147483648i` overflows
                // at its last item but one: q 5 refuses each with the number.
                Some(format!("`{text}` does not fit in {kind}"))
            } else if k + 1 < run.len() && re!(r"^\d+(?:\.\d*)?[hijef]$").is_match(text) {
                Some(format!(
                    "`{text}`: a vector literal takes one type suffix, after its last item"
                ))
            } else if k + 1 < run.len()
                && text.contains('.')
                && !text.contains(':')
                && re!(r"^\d+[hij]$").is_match(last)
            {
                Some(format!(
                    "`{text}`: the vector's `{}` suffix makes every item an integer",
                    &last[last.len() - 1..]
                ))
            } else {
                None
            };
            if let Some(detail) = detail
                && !reported
            {
                report(t.start(), format!("{detail}; q refuses to parse it"));
                reported = true;
            }
        }
        i = j + 1;
    }
}
