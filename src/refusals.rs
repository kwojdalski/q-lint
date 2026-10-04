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
    for m in re!(r#"(?:^|[\[(;{:])[ \t]*(')(-?\d[A-Za-z0-9.]*|"(?:[^"\\]|\\.)")"#)
        .captures_iter(comments)
    {
        let quote = m.get(1).unwrap();
        let value = m.get(2).unwrap();
        if code.as_bytes()[quote.start()] != b'\'' {
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
