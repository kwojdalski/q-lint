//! Literals q refuses, read without running anything. Each rule here was
//! settled against q 5 shape by shape, including the near-misses it accepts,
//! and each reports in the default profile because q raises on the line.
use crate::{Finding, boundary, continues_after, operand_ends};

pub fn check(path: &str, source: &str, code: &str, comments: &str) -> Vec<Finding> {
    let mut out = vec![];
    // Symbols blanked: `` `:hdb/2024.02.30 `` is a path, not a date, and
    // `` `s#... `` is read below from the unblanked view on purpose.
    let unsym = re!(r"`[A-Za-z0-9_.:/]*")
        .replace_all(code, |m: &regex::Captures| " ".repeat(m[0].len()))
        .into_owned();
    attributes(path, source, code, comments, &mut out);
    temporals(path, source, comments, &unsym, &mut out);
    missing_from(path, source, code, comments, &unsym, &mut out);
    signals(path, source, code, comments, &mut out);
    where_assignment(path, source, code, &mut out);
    hopen_literal(path, source, code, comments, &mut out);
    cast_character(path, source, code, comments, &mut out);
    monadic_glyph(path, source, code, comments, &mut out);
    juxtaposed_derived(path, source, code, comments, &mut out);
    keyword_each(path, source, &unsym, &mut out);
    numbers(path, source, code, comments, &unsym, &mut out);
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
    // A vector's items may run on across the indented line that continues
    // it: q 5 `w:`s#1` over `  1e-3` is 's-fail (#689).
    for m in re!(concat!(
        r#"`([spu])#[ \t]*((?:`[A-Za-z0-9_.]*){2,}|-?\d(?:[eE][+-]\d|[A-Za-z0-9.])*(?:"#,
        blank!(),
        r#"+-?\d(?:[eE][+-]\d|[A-Za-z0-9.])*)+|"[^"\\]+")"#
    ))
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
        // Symbols compare as bytes, and so do a string's items, which are
        // bytes: `"aé"` is 0x61 0xC3 0xA9 (#228). Numbers compare as numbers,
        // with q's nulls first; anything that will not parse leaves the rule
        // silent.
        let keys: Option<Vec<Key>> = if let Some(chars) = items.strip_prefix('"') {
            Some(
                crate::q_bytes(chars.trim_end_matches('"'))
                    .into_iter()
                    .map(|b| Key::Number(f64::from(b)))
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
        let Some(keys) = keys.filter(|k| k.len() > 1) else {
            continue;
        };
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

/// Whether `at` is in the argument of a system command, which q never parses
/// as q: `\l /data/2024.02.30/t` names a path (#198). Not `\t` or `\ts`,
/// whose argument is an expression q runs.
fn command_argument(source: &str, at: usize) -> bool {
    let line = source[..at].rfind('\n').map_or(0, |p| p + 1);
    crate::system_command(&source[line..])
}

/// How many days q 5 gives `month` of `year`, or 0 where it has no such
/// month. Leap years are Gregorian: 2000.02.29 parses and 1900.02.29 does not.
fn days_in(year: u32, month: u32) -> u32 {
    // Nor any month of year 0: q 5 refuses `0000.01.01` and `0000.01m`.
    if year == 0 {
        return 0;
    }
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    }
}

/// The letter after the last item of the vector literal whose token runs
/// through `end`, if it ends in one: `u` for `23:59:60u` and for
/// `12:00:60 12:00u` alike, since that suffix types every item.
fn vector_suffix(comments: &str, unsym: &str, end: usize) -> Option<char> {
    let token_end = |from: usize| {
        from + unsym[from..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || ".:".contains(c)))
            .unwrap_or(unsym.len() - from)
    };
    let mut at = token_end(end);
    loop {
        let rest = &unsym[at..];
        // Blanks, or a line break into the indented line that continues
        // the vector: `12:00:60` / `  12:00u` is one literal (#682). Read in
        // `comments`, where a symbol starting the next line is still there
        // to say that line is not indented.
        let gap = crate::past_blanks(comments, at) - at;
        if gap == 0 || !rest[gap..].starts_with(|c: char| c.is_ascii_digit()) {
            break;
        }
        at = token_end(at + gap);
    }
    unsym[..at].chars().last().filter(char::is_ascii_alphabetic)
}

/// QE006. A date, month or time q refuses at parse. A date or month that does not exist:
/// `2024.02.30` is '2024.02.30 and `2024.13m` is '2024.13; leap years are
/// Gregorian, so 2000.02.29 parses and 1900.02.29 does not.
fn temporals(path: &str, source: &str, comments: &str, unsym: &str, out: &mut Vec<Finding>) {
    // Minutes and seconds stop at 59 wherever they appear - a minute, second,
    // time, timespan or timestamp - while hours run on: q 5 refuses `12:60`,
    // `12:00:60` and `0D00:00:60`, and takes `25:00` and `0D25:00:00`.
    // Part of a longer token: a date's or number's digits, or a name such as
    // `p60` in `p60:60`, which assigns 60 rather than writing a time. The `D`
    // of `0D00:00:60` and the `T` of a datetime start no name. Such a match
    // is looked past, not skipped whole: in `t12:12:60` the first is
    // `12:12`, and the time is the `12:60` after it.
    // A `c` after the vector makes every item chars, whatever its fields
    // hold: q 5 reads `12:60c`, `2000.13.01c` and `12:5c` as " " (#714).
    let chars = |end: usize| vector_suffix(comments, unsym, end) == Some('c');
    let whole_token = |m: &regex::Captures| {
        let head = &unsym[..m.get(0).unwrap().start()];
        let word = head.trim_end_matches(|c: char| c.is_ascii_alphanumeric() || "._".contains(c));
        !(head.ends_with(|c: char| c.is_ascii_digit() || c == '.')
            || head[word.len()..]
                .starts_with(|c: char| c.is_ascii_alphabetic() || "._".contains(c)))
    };
    for m in crate::captures_where(re!(r"(\d{2,}):(\d{2})(?::(\d{2}))?"), unsym, whole_token) {
        let whole = m.get(0).unwrap();
        if command_argument(source, whole.start()) || chars(whole.end()) {
            continue;
        }
        let field = |i| {
            m.get(i)
                .map_or(0, |f: regex::Match| f.as_str().parse::<u32>().unwrap())
        };
        // A minute's seconds are never read: q 5 takes `23:59:60u` as 23:59,
        // and `12:00:60 12:00u` too, while `23:59:60u 12:00` is a vector of
        // seconds and '23:59:60u.
        let minute = vector_suffix(comments, unsym, whole.end()) == Some('u');
        if field(2) > 59 || (field(3) > 59 && !minute) {
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
    // A time's hour of three digits or more leaves room for three digits of
    // fraction: q 5 refuses `100:00:00.1234`, and takes `10:00:00.1234`,
    // `100:00:00.123` and `100:00:00.1234t`, where a `t`, `u` or `v` after
    // the vector cuts the fraction. (A timespan or timestamp refuses such an
    // hour whatever follows it: `0D100:00:00` is '0D100:00:00.)
    for m in crate::captures_where(re!(r"\d{3,}:\d{2}:\d{2}\.\d{4,}"), unsym, whole_token) {
        let whole = m.get(0).unwrap();
        if command_argument(source, whole.start())
            || unsym[..whole.start()].ends_with(['D', 'T'])
            || matches!(
                vector_suffix(comments, unsym, whole.end()),
                Some('c' | 't' | 'u' | 'v')
            )
        {
            continue;
        }
        out.push(Finding::at(
            path,
            source,
            whole.start(),
            "QE006",
            format!(
                "`{}` is no time: after an hour of three digits it takes three digits of \
                 fraction at most, and q refuses the literal",
                whole.as_str()
            ),
        ));
    }
    // The digit forms too (#232): q 5 reads `1259u` as 12:59 and refuses
    // `1260u`, `120060v` and `126000t`. The minutes are a minute's last two
    // digits, and a second's or time's from three to five digits; from six or
    // seven they are followed by the seconds, and a time of nine digits ends
    // in milliseconds. Other lengths q reads in ways not worth modelling.
    for m in re!(r"\b(\d{3,})([uvt])\b").captures_iter(unsym) {
        let whole = m.get(0).unwrap();
        if command_argument(source, whole.start())
            || unsym[..whole.start()].ends_with('.')
            || unsym[whole.end()..].starts_with('.')
        {
            continue;
        }
        let d = m[1].as_bytes();
        let two = |i: usize| u32::from(d[i] - b'0') * 10 + u32::from(d[i + 1] - b'0');
        let fields = match (&m[2], d.len()) {
            ("u", n) | ("v" | "t", n @ 3..=5) => vec![two(n - 2)],
            ("v" | "t", n @ 6..=7) => vec![two(n - 4), two(n - 2)],
            ("t", 9) => vec![two(2), two(4)],
            _ => vec![],
        };
        if fields.iter().any(|&f| f > 59) {
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
    // A match that starts inside a name is looked past, not skipped whole:
    // in `x10:12:5` the first is `10:12`, and the time is the `12:5` after it.
    let starts_token = |m: &regex::Captures| {
        let at = m.get(0).unwrap().start();
        let before = &unsym[..at];
        m.get(1).is_some()
            || boundary(unsym, at)
            || (before.ends_with(['D', 'T'])
                && before[..before.len() - 1].ends_with(|c: char| c.is_ascii_digit()))
    };
    for m in crate::captures_where(
        re!(r"(\d+)[DT](\d):\d|(\d+):(\d+)(?::(\d+))?"),
        unsym,
        starts_token,
    ) {
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
            if chars(whole.end()) {
                continue;
            }
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
        // Only a one-digit hour with nothing on its left is still refused
        // with a `c`: that is q 5's '1: at parse, before any suffix.
        if m[3].len() >= 2 {
            if !chars(whole.end())
                && (m[4].len() == 1
                    || (m.get(5).is_some_and(|s| s.as_str().len() == 1)
                        && vector_suffix(comments, unsym, whole.end()) != Some('u')))
            {
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
        if unsym[..m.start()].ends_with(|c: char| c.is_ascii_alphanumeric() || c == '.')
            || command_argument(source, m.start())
        {
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
        if command_argument(source, whole.start()) {
            continue;
        }
        // The year has to start the token: `1.2024.02.30` is not a date.
        if !unsym[..whole.start()].ends_with(|c: char| !c.is_ascii_alphanumeric() && c != '.')
            && whole.start() != 0
        {
            continue;
        }
        let (year, month): (u32, u32) = (m[1].parse().unwrap(), m[2].parse().unwrap());
        let day: Option<u32> = m.get(3).map(|d| d.as_str().parse().unwrap());
        let days = days_in(year, month);
        let impossible = days == 0 || day.is_some_and(|d| d == 0 || d > days);
        if impossible && !chars(whole.end()) {
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
fn missing_from(
    path: &str,
    source: &str,
    code: &str,
    comments: &str,
    unsym: &str,
    out: &mut Vec<Finding>,
) {
    // No `\b` before the keyword: `1_select` is a drop of a select (#351).
    for m in re!(r"(select|exec|update|delete)\b").find_iter(unsym) {
        if !boundary(code, m.start()) {
            continue;
        }
        // The name assigned or passed rather than run: `select:1`, `.q.select`.
        // But `select[n]` is q's own row limit, and still wants its `from`:
        // q 5 `parse "select[2] a"` is 'from (#489).
        let after = unsym[m.end()..].trim_start_matches([' ', '\t']);
        if after.starts_with(':')
            || (after.starts_with('[') && m.as_str() != "select")
            || after.starts_with([';', ')', ']', '}'])
            || after.is_empty()
        {
            continue;
        }
        // The statement runs to a `;` at this depth, the bracket that closes
        // around it, or an unindented next line - skipping a blank line, as
        // q does: `r:select a`, an empty line, `  from t` is one query (#559).
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
                b'\n' if depth == 0 && !continues_after(comments, source, at) => break,
                _ => {}
            }
            at += 1;
        }
        // This phrase's own `from` and `where` only: not one inside a
        // bracket, nor one that belongs to a query nested after this one's
        // `from` - `... where b in exec c from u where` leaves the outer
        // where its operand (#200).
        let mut flat = unsym.as_bytes()[m.end()..at].to_vec();
        let mut depth = 0i32;
        for b in &mut flat {
            let c = *b;
            if c == b')' || c == b']' || c == b'}' {
                depth -= 1;
            }
            if depth > 0 {
                *b = b' ';
            }
            if c == b'(' || c == b'[' || c == b'{' {
                depth += 1;
            }
        }
        let flat = String::from_utf8(flat).unwrap_or_default();
        let own = re!(r"\bfrom\b").find(&flat).map_or(flat.len(), |first| {
            re!(r"\b(?:select|exec|update|delete)\b")
                .find_iter(&flat[first.end()..])
                .find(|n| boundary(code, m.end() + first.end() + n.start()))
                .map_or(flat.len(), |n| first.end() + n.start())
        });
        let statement = &flat[..own];
        let from = re!(r"\bfrom\b").find_iter(statement).last();
        let detail = match from {
            None => "has no `from` before its statement ends: q raises 'from",
            // Read from `comments`, where `` from `t `` still has its table
            // and `from "t"` its string (#199).
            Some(f) if comments[m.end() + f.end()..at].trim().is_empty() => {
                "has nothing after its `from`: q raises 'from"
            }
            // A where phrase with nothing in it: q 5 `parse "exec a from t
            // where"` and `parse "select from t where"` are ',.
            Some(f)
                if re!(r"\bwhere\b")
                    .find_iter(&statement[f.end()..])
                    .last()
                    .is_some_and(|w| {
                        comments[m.end() + f.end() + w.end()..at].trim().is_empty()
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
/// `'1`, `'1.5`, `'0N`, `'12:00`, `'1e-3` and `'(1;2)` are 'stype - and so is `'"x"`, since a
/// one-character string is a char atom, not a string.
fn signals(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    // A signal opens an expression; after an operand the quote is each.
    // Not after `:` - `r:'5` is ((';:);`r;5), each applied to assignment,
    // and `{:'5}` does not parse; neither is a signal (q 5).
    // At any line's start too, or after a newline that only continues the
    // bracket before it: `{[x]` + `  '1}` is a signal (q 5: 'stype).
    // A list cannot be signalled either: q 5 `'(1;2)`, `'()`, `'(1)` and
    // `` '`a`b `` are each 'stype.
    // A number runs on over `:` and an exponent's sign: `'12:00`,
    // `'2026.01.01D12:00` and `'1e-3` are each 'stype.
    for m in re!(r#"(')(-?\d(?:[eE][+-]\d|[A-Za-z0-9.:])*|"(?:\\[0-7]{3}|\\.|[^"\\])+"|\(\s*\)|\(\s*-?\d(?:[eE][+-]\d|[A-Za-z0-9.:])*\s*\)|\([^()"]*;[^()]*\)|(?:`[A-Za-z0-9_.]*){2,})"#).captures_iter(comments) {
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
            || after_signature(code, source, before.len()))
        {
            continue;
        }
        // A one-char string is a char atom, counted as q does, in bytes:
        // `"é"` is a two-byte string and `"\012"` one char (#229).
        if value.as_str().starts_with('"')
            && crate::q_bytes(&value.as_str()[1..value.len() - 1]).len() != 1
        {
            continue;
        }
        // Two items headed by a symbol signal that symbol: q 5 `'(`err;"detail")`
        // is 'err and `'(`a;1)` is 'a. Only a second symbol makes the pair a
        // symbol vector, `'(`a;`b)`, and so 'stype again (#739).
        let items: Vec<&str> = code[value.range()]
            .trim_matches(['(', ')'])
            .split(';')
            .map(str::trim)
            .collect();
        let symbol = |s: &str| re!(r"^`[A-Za-z0-9_.:]*$").is_match(s);
        if value.as_str().starts_with('(')
            && items.len() == 2
            && symbol(items[0])
            && !symbol(items[1])
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
        // The statement runs back to a `;` or a line starting at column 0:
        // an indented line continues it, and in a lambda a newline is
        // whitespace (#335).
        let bytes = code.as_bytes();
        let mut from = w.start();
        while from > 0
            && bytes[from - 1] != b';'
            && !(bytes[from - 1] == b'\n' && !bytes[from].is_ascii_whitespace())
        {
            from -= 1;
        }
        let head = &code[from..w.start()];
        if !re!(r"\b(?:select|exec|update|delete)\b[\s\S]*\bfrom\b").is_match(head) {
            continue;
        }
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
                b';' if depth == 0 => break,
                b'\n'
                    if depth == 0
                        && bytes.get(at + 1).is_some_and(|b| !b.is_ascii_whitespace()) =>
                {
                    break;
                }
                b':' if nested == 0
                    && code[..at]
                        .trim_end()
                        .ends_with(|c: char| c.is_alphanumeric() || c == '_')
                    && !code[at + 1..].starts_with([':', '/', '\\', '\''])
                    && !code[..at].ends_with([':', '/', '\\', '\'']) =>
                {
                    // Past the whole of the character before the name, which
                    // may be wider than a byte: a no-break space (#321).
                    let name_start = code[..at]
                        .trim_end()
                        .char_indices()
                        .rfind(|&(_, c)| !(c.is_alphanumeric() || c == '_'))
                        .map_or(0, |(p, c)| p + c.len_utf8());
                    // A name starts with a letter and stands alone: `09:35`
                    // and the `D00:00` of a timestamp are literals, and
                    // their colons are part of them.
                    // Nor is `where` itself one: `where:1` is the phrase
                    // `(:;1)` in q 5, and assigns nothing (#320).
                    if name_start < sub
                        || !code[name_start..].starts_with(|c: char| c.is_ascii_alphabetic())
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
    for m in re!(concat!(r#""([A-Za-z])""#, blank!(), r"*\$")).captures_iter(comments) {
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

/// Whether the `]` ending at `end` closes a lambda's parameter list, so that
/// what follows it opens the body's first expression. Any signature q reads
/// as one: `{[a;b]`, a pattern `{[(a;b)]` or a typed slot `{[a:`j]` (#325).
fn after_signature(code: &str, raw: &str, end: usize) -> bool {
    if !code[..end].ends_with(']') {
        return false;
    }
    let mut depth = 0usize;
    let mut open = None;
    for (i, b) in code.as_bytes()[..end].iter().enumerate().rev() {
        match b {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' => {
                depth -= 1;
                if depth == 0 {
                    open = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let Some(open) = open.filter(|&o| code.as_bytes()[o] == b'[') else {
        return false;
    };
    let head = code[..open].trim_end();
    if !head.ends_with('{') {
        return false;
    }
    let sig = crate::signature(code, raw, head.len() - 1);
    sig.named && sig.body == end
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
        // Not in a string or a comment, nor on a system command.
        // `_` too: `_x`, `_1.5` and `1+_x` are '_ in q 5, while `x _1`,
        // `1 _x` and the `_` inside `x_y` follow an operand.
        // `.` too, where it starts no name or number: q 5 refuses `.(v)`,
        // `. v` and `.:v` with '. - the monadic form is `value` (#571).
        let dot = g == b'.'
            && !b
                .get(i + 1)
                .is_some_and(|&n| n.is_ascii_alphanumeric() || n == b'_' || n == b'.');
        if !(GLYPHS.contains(&g) || g == b'_' || dot)
            || code.as_bytes()[i] != g
            || crate::system_command(&source[line_start..])
        {
            continue;
        }
        // What follows has to be an operand: not `:` (`-:`, `,:`), an
        // iterator, a bracket (`@[f;x;g]`, `$[c;a;b]`) or a negative literal.
        let rest = &comments[i + 1..];
        // `#:a`: the k form, a glyph and a colon, applied to an operand
        // written straight after it.
        let colon = rest.starts_with(':')
            && rest[1..].starts_with(|c: char| c.is_ascii_alphanumeric() || "`(\".{".contains(c))
            || rest.starts_with(":-") && rest[2..].starts_with(|c: char| c.is_ascii_digit());
        let next = continued(rest);
        let spaced = next.len() < rest.len();
        // A `.` before a letter starts a name, not a number: q 5 refuses
        // `-.foo.x` and `-.z.p` with '-, as it does `#.foo.x` (#241).
        // A lambda is a noun, and so is a negative literal: q 5 refuses
        // `#{x}`, `,-1` and `--1` with the first glyph (#438). `- -1` is
        // refused too, but with ' .
        // A glyph applied with brackets is a noun: q 5 refuses `*$[c;a;b]`
        // with '* (#568). Not the second half of one operator, `<=[1;2]`.
        let pair = !spaced
            && matches!(
                (g, next.as_bytes().first()),
                (b'<', Some(b'=' | b'>')) | (b'>', Some(b'='))
            );
        let operand = colon
            || next.starts_with(|c: char| c.is_ascii_alphabetic() || "`(\"{".contains(c))
            || (bracket_form(next) && !pair)
            || (re!(r"^-\.?\d").is_match(next) && !(g == b'-' && spaced))
            || re!(r"^\.[A-Za-z]").is_match(next)
            || (next.starts_with(|c: char| c.is_ascii_digit() || c == '.')
                && (g != b'-' || spaced));
        if !operand {
            continue;
        }
        let before = comments[..i].trim_end_matches([' ', '\t', '\r', '\n']);
        // A `\t` line's expression starts after the command (#310).
        let expression = line_start + crate::timed_prefix(&source[line_start..]);
        if !opens_expression(code, source, comments, i, expression) {
            continue;
        }
        // A symbol ending in `:` or `/` is still an operand: `` `:,srvr ``
        // and `` `:dir/,`f `` join to a file handle (#292). Only a handle
        // holds a `/`; `` `a/ `` is a symbol and an iterator.
        if re!(r"`(?::[A-Za-z0-9_.:/]*|[A-Za-z0-9_.][A-Za-z0-9_.:]*)$")
            .is_match(code[..i].trim_end_matches([' ', '\t']))
        {
            continue;
        }
        // The sort in `select[>a]` and `select[2;<a]` is q's own syntax, and
        // the count before it may hold brackets of its own: `select[til[2];>a]`
        // and `select[(1;2);>a]` (q 5 runs both, #346).
        if matches!(g, b'<' | b'>') && before.ends_with(['[', ';']) {
            let (mut depth, mut slots, mut open) = (0i32, 0, None);
            for (j, c) in before.bytes().enumerate().rev() {
                match c {
                    b')' | b']' | b'}' => depth += 1,
                    b'(' | b'[' | b'{' if depth == 0 => {
                        open = Some(j);
                        break;
                    }
                    b'(' | b'[' | b'{' => depth -= 1,
                    b';' if depth == 0 => slots += 1,
                    _ => {}
                }
            }
            if open.is_some_and(|o| {
                before.as_bytes()[o] == b'['
                    && slots <= 1
                    && re!(r"(?:^|[^A-Za-z0-9.])select\s*$").is_match(&before[..o])
            }) {
                continue;
            }
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

/// Whether `next` opens a glyph applied with brackets, `$[c;a;b]`,
/// `@[v;0;neg]`, `.[f;x]` or `?[t;();()]`: a value, so an operand (#568).
fn bracket_form(next: &str) -> bool {
    let b = next.as_bytes();
    b.len() > 1 && (GLYPHS.contains(&b[0]) || b[0] == b'.' || b[0] == b'_') && b[1] == b'['
}

/// What follows a glyph, past the blanks before it - and past a line break
/// into an indented line, which q reads as the same statement: `a:-` with
/// `  x` below it is `a:- x`. Blank and comment lines between them do not
/// end the statement (#224).
pub(crate) fn continued(rest: &str) -> &str {
    let m = re!(r"^[ \t]*(?:(?:\r?\n[ \t]*)*\r?\n[ \t]+)?")
        .find(rest)
        .map_or(0, |m| m.end());
    &rest[m..]
}

/// Whether the token at `i` starts an expression, so that whatever it applies
/// to is applied by juxtaposition: the start of a line or statement, after
/// `:`, an opening bracket, a signature or a qSQL word, or after another glyph.
fn opens_expression(code: &str, raw: &str, comments: &str, i: usize, line_start: usize) -> bool {
    // Pairs QE004 already reports, or that are one operator.
    const PAIRS: &[&str] = &[
        "<>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=", "*=", "->", "=>", "**", "=<", "<<",
        "|>", ":=", "%%", "++", ">>",
    ];
    let before = comments[..i].trim_end_matches([' ', '\t', '\r', '\n']);
    // `get`, not a slice: the byte before may end a multi-byte character.
    let paired = before.len() == i
        && i.checked_sub(1)
            .and_then(|p| comments.get(p..=i))
            .is_some_and(|pair| PAIRS.contains(&pair));
    if paired {
        return false;
    }
    // After an iterator the next glyph can only be applied monadically:
    // q 5 refuses `x,\-y`, `x,'-y` and `count'-x` with '-, as it does
    // `x,\:-y`, whose iterator ends in the `:` above. Only an iterator written
    // straight after its operand - a `/` after a space opens a comment.
    let iterator = before.ends_with(['/', '\\', '\''])
        && before[..before.len() - 1]
            .bytes()
            .next_back()
            .is_some_and(|p| !p.is_ascii_whitespace());
    // A qSQL word opens an expression too: q 5 refuses `select -a from t`
    // and `select from t where -a<0` with '-. `by` and `where` only inside a
    // query - `where -a` alone is the where function minus a (#355). A `_`
    // written against the word continues it: `exec_rows` is a name.
    let glued = before.len() == i && comments.as_bytes().get(i) == Some(&b'_');
    let qsql = !glued
        && re!(r"(?:select|exec|update|delete|by|where)$")
            .find(before)
            .is_some_and(|m| {
                boundary(comments, m.start())
                    && (!matches!(m.as_str(), "by" | "where")
                        || crate::in_qsql_phrase(comments, m.end()))
            });
    // After an infix keyword q expects its right argument, so a glyph or
    // a derived function there is applied by juxtaposition: q 5 refuses
    // `v vs f/2`, `v in ,2`, `f each -v` and `v cross ,1` (#566). Not a
    // name that only ends in one, `.q.in`, `` `in `` or `vin`.
    // The tail of `before` from its last byte outside `keep`: ASCII only,
    // so the cut falls on a character boundary.
    let tail = |s: &'_ str, keep: &dyn Fn(u8) -> bool| {
        s.len() - s.bytes().rev().take_while(|&b| keep(b)).count()
    };
    let word = &before[tail(before, &|b| b.is_ascii_alphanumeric() || b == b'_')..];
    let infix = !glued
        && crate::semantics::INFIX.contains(&word)
        && !before[..before.len() - word.len()].ends_with(['.', '`'])
        && boundary(comments, before.len() - word.len());
    // `.` and `_` are operators too where they stand apart, and `_` after a
    // number is drop: q 5 refuses `f . ,v`, `v _ -v` and `1_f/v` (#567).
    let operator = before.strip_suffix(['.', '_']).is_some_and(|rest| {
        rest.ends_with([' ', '\t'])
            || before.ends_with('_')
                && rest[tail(rest, &|b| {
                    b.is_ascii_alphanumeric() || b == b'.' || b == b'_'
                })..]
                    .starts_with(|c: char| c.is_ascii_digit())
    });
    i == line_start
        || before.is_empty()
        || iterator
        || qsql
        || infix
        || operator
        || before.ends_with([':', '(', '[', '{', ';'])
        || after_signature(code, raw, before.len())
        || (before
            .bytes()
            .next_back()
            .is_some_and(|p| GLYPHS.contains(&p)))
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
    // Each closer's opener: a lambda's braces, brackets and parentheses in
    // code, and a string's quotes in the view, where the string is text.
    let mut opener = std::collections::HashMap::new();
    let mut stacks: [Vec<usize>; 3] = [vec![], vec![], vec![]];
    let mut quote = None;
    let mut i = 0;
    while i < b.len() {
        match quote {
            Some(_) if b[i] == b'\\' => i += 1,
            Some(o) if b[i] == b'"' => {
                opener.insert(i, o);
                quote = None;
            }
            Some(_) => {}
            None if b[i] == b'"' && c[i] != b'"' => quote = Some(i),
            None => {
                if let Some(k) = b"{[(".iter().position(|&o| o == c[i]) {
                    stacks[k].push(i);
                } else if let Some(k) = b"}])".iter().position(|&o| o == c[i])
                    && let Some(o) = stacks[k].pop()
                {
                    opener.insert(i, o);
                }
            }
        }
        i += 1;
    }
    // A run of iterators - `/`, `':`, or `/'` after `+`, whose operand is
    // the derived `+/` - and q names the last of them: `+/'x` is '.
    for m in re!(r"(?:/:|\\:|':|/|\\|')+").find_iter(&view) {
        let iterator = re!(r"/:|\\:|':|/|\\|'")
            .find_iter(m.as_str())
            .last()
            .map_or(m.start(), |p| m.start() + p.start());
        // The iterator is code, not string or comment.
        if c[m.start()] != b[m.start()] {
            continue;
        }
        let Some(start) = derived_operand(&view, c, &opener, m.start()) else {
            continue;
        };
        let line_start = view[..start].rfind('\n').map_or(0, |p| p + 1);
        if b[line_start] == b'\\' {
            continue;
        }
        // Applied to an operand right after the iterator: a name, a symbol,
        // a bracketed or quoted value, or a number.
        // A `-` before an operand is one too: `+/-x` holds the same derived
        // function as `+/-1`, and q 5 refuses both with '/.
        let next = continued(&view[m.end()..]);
        // A lambda is a noun too: q 5 refuses `+/{x}` with '/ (#569).
        let operand = next
            .starts_with(|ch: char| ch.is_ascii_alphanumeric() || "`(\"{".contains(ch))
            || bracket_form(next)
            || ((next.starts_with('-') || next.starts_with('.'))
                && next[1..].starts_with(|ch: char| ch.is_ascii_digit()))
            // A dotted name, as QE008 reads it: q 5 refuses `+/.foo.v` (#570).
            || re!(r"^\.[A-Za-z]").is_match(next)
            || (next.starts_with('-')
                && next[1..]
                    .starts_with(|ch: char| ch.is_ascii_alphabetic() || "`(\"".contains(ch)));
        if !operand || !opens_expression(code, source, &view, start, line_start) {
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
                // q names the whole iterator: `,/:a` is '/:, `-':a` is ':.
                iter
            ),
        );
        finding.end_column = finding.column.map(|col| col + iter.len());
        out.push(finding);
    }
}

/// Where the operand of an iterator at `at` starts, if it has one: a glyph
/// or its k form (`+/`, `.:'`), a name, a lambda, a string, a number or
/// symbol vector, a parenthesised value, or any of these indexed with
/// brackets (`g[x]'`, `{x}[1]/`). q 5 refuses each applied by juxtaposition.
fn derived_operand(
    view: &str,
    c: &[u8],
    opener: &std::collections::HashMap<usize, usize>,
    at: usize,
) -> Option<usize> {
    let b = view.as_bytes();
    let prev = *b.get(at.checked_sub(1)?)?;
    if GLYPHS.contains(&prev) {
        return Some(at - 1);
    }
    if prev == b':' && at >= 2 && (GLYPHS.contains(&b[at - 2]) || b[at - 2] == b'.') {
        return Some(at - 2);
    }
    let mut q = at;
    while let Some(&ch) = q.checked_sub(1).and_then(|p| b.get(p)) {
        match ch {
            // A signature is not an operand: `{[x]'e}` signals.
            b']' => match opener.get(&(q - 1)) {
                Some(&o) if o == 0 || b[o - 1] != b'{' => {
                    q = o;
                    // A derived function indexed with brackets is one operand
                    // with its own: `g/[0]'y` is each of `g/[0]` (#562).
                    let iterated = view[..q].trim_end_matches(['/', '\\', '\'', ':']).len();
                    if iterated < q && iterated > 0 && !b[iterated - 1].is_ascii_whitespace() {
                        q = iterated;
                        if GLYPHS.contains(&b[q - 1]) {
                            q -= 1;
                            break;
                        }
                    }
                }
                _ => return None,
            },
            // A glyph indexed with brackets is a noun too: `@[;1;-1+]/`.
            ch if GLYPHS.contains(&ch) && b[q] == b'[' => {
                q -= 1;
                break;
            }
            b')' | b'}' | b'"' => {
                q = *opener.get(&(q - 1))?;
                break;
            }
            ch if ch.is_ascii_alphanumeric() || ch == b'.' || ch == b'_' => {
                let token = |end: usize| {
                    let s = view[..end]
                        .rfind(|ch: char| !(ch.is_ascii_alphanumeric() || "._".contains(ch)))
                        .map_or(0, |p| p + 1);
                    (s < end && boundary(view, s)).then_some(s)
                };
                q = token(q)?;
                // After a number `_` is drop, not part of a name: `-2_/:x`
                // and `1_'x` apply the derived `_/:` and `_'` infix.
                if c[q].is_ascii_digit()
                    && let Some(u) = view[q..at].rfind('_')
                {
                    q += u + 1;
                    if q == at {
                        return None;
                    }
                    break;
                }
                // A number vector is one operand: `1 2'y`.
                while c[q].is_ascii_digit() {
                    let gap = view[..q].trim_end_matches([' ', '\t']).len();
                    match token(gap) {
                        Some(s) if gap < q && c[s].is_ascii_digit() => q = s,
                        _ => break,
                    }
                }
                break;
            }
            _ => break,
        }
    }
    (q < at).then_some(q)
}

/// QE011. An infix keyword before `each` or `peach`. q 5 refuses the line
/// at parse whatever stands on its left: `cor each x`, `x mavg each y` and
/// `x in each y` are each an error, while `(cor) each x`, `cor'[x;y]` and
/// `cor[x] each y` parse. The list is every reserved word q 5 refuses there,
/// checked one by one (`each`, `over`, `scan`, `prior` and `peach` are
/// iterators themselves, and the qSQL words have their own rule).
fn keyword_each(path: &str, source: &str, unsym: &str, out: &mut Vec<Finding>) {
    for m in re!(
        r"\b(and|asof|bin|binr|cor|cov|cross|cut|div|dsave|ema|except|fby|ij|ijf|in|insert|inter|like|lj|ljf|lsq|mavg|mcount|mdev|mmax|mmin|mmu|mod|msum|or|pj|rotate|scov|set|setenv|ss|sublist|sv|uj|ujf|union|upsert|vs|wavg|within|wsum|xasc|xbar|xcol|xcols|xdesc|xexp|xgroup|xkey|xlog|xprev|xrank)[ \t]+(each|peach)\b"
    )
    .captures_iter(unsym)
    {
        let word = m.get(1).unwrap();
        let line_start = unsym[..word.start()].rfind('\n').map_or(0, |p| p + 1);
        if !boundary(unsym, word.start())
            || unsym[..word.start()].ends_with('.')
            || crate::system_command(&source[line_start..])
        {
            continue;
        }
        let mut finding = Finding::at(
            path,
            source,
            word.start(),
            "QE011",
            format!(
                "`{w}` is infix, so q 5 refuses `{w} {it}` at parse: write `({w}) {it}`, \
                 `{w}'` or `{w}[x] {it}`",
                w = word.as_str(),
                it = &m[2]
            ),
        );
        finding.end_column = finding.column.map(|c| c + word.len());
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

/// Whether one item makes a whole vector float, so that an integer among
/// them is read as a float too: a fraction (`1.5`, `1.`), a lower-case
/// exponent (`1e3`), `0n` or `0w`, or an `e` or `f` after the last item. q 5
/// takes `1.5 9223372036854775808` and `1E5 2.5`, and refuses
/// `9223372036854775808 0N` and `1E5 2000.01.01` - a date is no fraction.
fn float_vector(run: &[regex::Match]) -> bool {
    let last = run[run.len() - 1].as_str();
    (re!(r"^\d.*[ef]$").is_match(last) && !last.starts_with("0x"))
        || (!re!(r"[hij]$").is_match(last)
            && run.iter().any(|t| {
                re!(r"^(?:\d+\.\d*(?:e[+-]?\d+)?|\d+e[+-]?\d+|0[nw])$").is_match(t.as_str())
            }))
}

/// The temporal shape of a vector item, with a one-letter suffix put aside:
/// a time (`12:00`, `12:00:00`, `12:00:00.123`) or a date (`2000.01.01`).
fn temporal_shape(item: &str) -> Option<&'static str> {
    let bare = item
        .strip_suffix(|c: char| c.is_ascii_alphabetic())
        .unwrap_or(item);
    if re!(r"^\d\d:\d\d(?::\d\d(?:\.\d*)?)?$").is_match(bare) {
        Some("time")
    } else if re!(r"^\d{4}\.\d\d\.\d\d$").is_match(bare) {
        Some("date")
    } else {
        None
    }
}

/// What q 5 refuses in a null or infinity token: a type letter it has no
/// null or infinity for, a suffix on an item but the last, and a negative
/// null. Measured with `parse` over every letter: `0N` takes
/// `c d e f g h i j m n p t u v z` and refuses the rest (`'0Nb`, `'0Nx`);
/// `0W` takes the same but `g` (`'0Wg`, and no guid infinity). `0n` and `0w`
/// read as `0N` and `0W`. `0Ni 1` is '0Ni and `0Nh 0Nh` '0Nh, while `1 0Ni`
/// and `0N 0Nh` parse. `-0N`, of any type but char, is '-0N; `-0W` and `-0n`
/// parse - but `-0n` as the timespan 0D00:00, so with a suffix other than
/// `c`, or before another item, it is '-0n: `-0ne`, `-0nj` and `-0n 1`.
fn null_literal(text: &str, not_last: bool, negative: bool) -> Option<String> {
    let caps = re!(r"^0([nNwW])([A-Za-z])?$").captures(text)?;
    let null = caps[1].eq_ignore_ascii_case("n");
    let letter = caps.get(2).map(|l| l.as_str());
    let takes = if null {
        "cdefghijmnptuvz"
    } else {
        "cdefhijmnptuvz"
    };
    if let Some(l) = letter
        && !takes.contains(l)
    {
        return Some(format!(
            "`{text}`: q has no {} of type `{l}`",
            if null { "null" } else { "infinity" }
        ));
    }
    if letter.is_some() && not_last {
        return Some(format!(
            "`{text}`: a vector literal takes one type suffix, after its last item"
        ));
    }
    if negative && &caps[1] == "N" && letter != Some("c") {
        return Some(format!("`-{text}`: a null has no negative"));
    }
    if negative && &caps[1] == "n" && (not_last || letter.is_some_and(|l| l != "c")) {
        return Some(format!(
            "`-{text}`: `-0n` is the timespan 0D00:00, which takes no suffix and starts no vector"
        ));
    }
    None
}

/// QE010. A number q 5 will not parse. Each shape was refused by `parse`,
/// which names the token: an integer type with a fraction (`1.5j`, and
/// `1.5 2j`, where the suffix types every item), a suffix on any item but
/// the last (`3i 4j`, `1e 2`), a boolean digit that is not 0 or 1 (`2b`), a
/// letter that is no type (`1y`, `1d`, `1m`), dots that make no date
/// (`1.2.3`, `2023.1.1`, `1.5.`), digits after a boolean's `b` (`0b101`), a long past 9223372036854775807, and an int or
/// short past its own range (`2147483648i`, `32768h`). A boolean
/// vector of atoms is not a vector at all - `1b 0b` parses, as two atoms -
/// and `0N 1`, `3 4i`, `1e5` and `2023.01.01` are fine - though `1E5`,
/// with its exponent in upper case, is not.
fn numbers(
    path: &str,
    source: &str,
    code: &str,
    comments: &str,
    unsym: &str,
    out: &mut Vec<Finding>,
) {
    // An exponent's sign is part of its number: `1.5e-3` is one float.
    // A token that starts inside a name - the `1` of `x1:1.5j` - is passed
    // over one character at a time, so the literal after it is still read.
    let tokens: Vec<regex::Match> =
        crate::boundary_captures(re!(r"\d(?:[eE][+-]\d|[0-9A-Za-z.:])*"), unsym, code)
            .into_iter()
            .map(|c| c.get(0).unwrap())
            .filter(|m| !command_argument(source, m.start()))
            .collect();
    let mut report = |at: usize, detail: String| {
        out.push(Finding::at(path, source, at, "QE010", detail));
    };
    let mut i = 0;
    while i < tokens.len() {
        // A run of items separated by blanks only is one vector literal - a
        // line break too, into the indented line that continues it: q 5
        // reads `c:1E5`, `  2.5` as `1E5 2.5` (#681). Read in `comments`,
        // where a symbol or a string at column 0 is not blanks: `1:-1` over
        // `` `:f 0:x ``, or `0:x` over `"\t" 0:x`, is two statements. A minus
        // that starts the next item continues the run: q 5 reads `1 -2` as a
        // vector and refuses `3i -1` as it does `3i 4` (#491).
        let mut j = i;
        while j + 1 < tokens.len()
            && re!(concat!("^", blank!(), "+-?$"))
                .is_match(&comments[tokens[j].end()..tokens[j + 1].start()])
        {
            j += 1;
        }
        let run = &tokens[i..=j];
        let last = run[run.len() - 1].as_str();
        // A `c` after the last item makes the vector a string, and q 5 reads
        // any number before it as chars: `1h 2c` is " 2", and `1.5j 2c`,
        // `1y 2c`, `0Nh 1c` and `-0N 1c` all parse. Only what q refuses as it
        // reads the token is still refused there: a `b` it cannot read as a
        // boolean (`2b 1c`, `0Nb 1c`), a byte (`0x1g 1c`), and an uppercase
        // exponent's sign (`1E-3 1c`).
        let string = last.ends_with('c') && !last.starts_with("0x");
        let mut reported = false;
        for (k, t) in run.iter().enumerate() {
            let text = t.as_str();
            let in_string = string && k + 1 < run.len();
            // `0Ns` and `0Ws` are names to q, not literals: it parses them
            // as `0N` and `0W` and signals '0N or '0W when they are read.
            if !reported && !in_string && re!(r"^0[nNwW]s$").is_match(text) {
                report(
                    t.start(),
                    format!(
                        "`{text}` is no symbol: q 5 reads it as the name `{}`, which is \
                         never defined, and signals '{} - the null symbol is a lone backtick",
                        &text[..2],
                        &text[..2]
                    ),
                );
                reported = true;
                continue;
            }
            // A minus that starts a literal, not one between operands:
            // `x-0N` subtracts, while `-0N`, `a:-0N` and `x -0N` are refused.
            let negative = unsym[..t.start()].ends_with('-')
                && !code[..t.start() - 1]
                    .ends_with(|c: char| c.is_ascii_alphanumeric() || "_.)]}\"`".contains(c));
            // A null or infinity is judged on its own terms: the `w` of `0w`
            // is no type suffix, but the token is no number either.
            let date = |t: &str| re!(r"^\d{4}\.\d\d\.\d\d$").is_match(t);
            let detail = if re!(r"^0[nNwW][A-Za-z]?$").is_match(text) {
                null_literal(text, k + 1 < run.len(), negative)
            } else if re!(r"^0[nNwW][A-Za-z]?[0-9.:]").is_match(text) {
                // Nothing continues a null or infinity: q 5 refuses `0W.5`,
                // `0N1`, `0Ni5` and `0N:1`.
                Some(format!(
                    "`{text}`: nothing but a type letter follows a null or infinity"
                ))
            } else if negative
                && date(text)
                && run[k + 1..]
                    .iter()
                    .all(|t| re!(r"^(?:\d+(?:\.\d*)?|0[NW])$").is_match(t.as_str()))
            {
                // A date takes no minus: q 5 refuses `-2000.01.01`, `x
                // -2000.01.01`, `-2000.01.01 1` and `-2000.01.01 0N`, though
                // not a minus before a vector of dates, a timestamp or a time
                // (`-2000.01.01 2000.01.02`, `-2000.01.01D12:00`, `-12:00`).
                // Before other temporal items it parses or not by rules not
                // worth modelling: `-2000.01.01 12:00` is refused, and
                // `-2000.01.01 0Wn` and `-2000.01.01 2000.01m` are not.
                Some(format!("`-{text}`: a date has no negative"))
            } else if re!(r"^(?:\d+\.?\d*)E(?:[+-]|[A-Za-z]|$)").is_match(text) {
                // An uppercase exponent takes no sign and needs digits: q 5
                // refuses `1E-3`, `1.5E+3`, `2E` and `1Ef`, where `1e-3`,
                // `1.5e+3` and `2e` parse.
                Some(format!(
                    "`{text}`: an uppercase `E` exponent takes digits and no sign; write `e`"
                ))
            } else if re!(r"^\d+E\d+$").is_match(text) && !float_vector(run) {
                // `1E5` on an integer mantissa is a float only where another
                // item makes the vector one: q 5 refuses `1E5`, `1 2E5` and
                // `1E5 2j`, and takes `1E5 2.5`, `1E5 2f` and `1E5f`.
                Some(format!(
                    "`{text}`: an uppercase `E` exponent on an integer makes no number \
                     unless another item makes the vector float; write `e`"
                ))
            } else if re!(r"^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[hij]$").is_match(text)
                && !re!(r"^\d+[hij]$").is_match(text)
            {
                // `1e3j` too: an exponent makes a float, whatever it equals.
                Some(format!(
                    "`{text}`: an integer type takes no fractional part or exponent"
                ))
            } else if re!(r"^\d*[2-9]\d*b$").is_match(text)
                || (re!(r"^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?b$").is_match(text)
                    && !re!(r"^\d+b$").is_match(text))
            {
                Some(format!("`{text}`: a boolean is written with 0 and 1 only"))
            } else if re!(r"^\d+b[0-9A-Za-z]").is_match(text) {
                // Nothing follows a boolean's `b`: q 5 refuses `0b101`, `1b0`
                // and `0b1b` (#490).
                Some(format!(
                    "`{text}`: a boolean vector is written with its digits before the `b`, as `101b`"
                ))
            } else if re!(r"^0x[0-9a-fA-F]*[g-zG-Z][0-9A-Za-z]*$").is_match(text) {
                Some(format!(
                    "`{text}`: a byte literal is written with hex digits only"
                ))
            } else if let Some(d) = re!(r"^(\d{4})(\d\d)(\d\d)[dz]$").captures(text)
                && {
                    let field = |i: usize| d[i].parse::<u32>().unwrap();
                    field(3) == 0 || field(3) > days_in(field(1), field(2))
                }
            {
                // Eight digits and a `d` are a date, yyyymmdd: q 5 reads
                // `20000101d` as 2000.01.01 and refuses `20001301d`, while
                // `1d` and `2000010d` are no date at all. A `z` reads the
                // same eight digits as that date's datetime (#713).
                Some(format!("`{text}` is no date (yyyymmdd)"))
            } else if (re!(r"^\d+[adgklmoqrwyz]$").is_match(text)
                // Nine digits or more and a `z` are a datetime too: q 5
                // reads `202401011z` as 1976.05.31T14:30:11.000 (#713).
                && !re!(r"^\d{8}d$|^\d{8,}z$").is_match(text))
                || (re!(r"^\d+x$").is_match(text) && text != "0x")
            {
                Some(format!(
                    "`{text}`: `{}` is not a type suffix",
                    &text[text.len() - 1..]
                ))
            } else if let Some(m) = re!(r"^(\d{4})\d+\.(\d\d)m$").captures(text)
                && days_in(m[1].parse().unwrap(), m[2].parse().unwrap()) == 0
            {
                // A month's year past four digits is cut to its first four:
                // q 5 reads `20000.01m` as 2000.01m and `12345.01m` as
                // 1234.01m, and refuses `20000.13m`.
                Some(format!("`{text}` is no month"))
            } else if re!(r"^\d+\.\d*[A-Za-z]$").is_match(text)
                && !re!(r"[cefnpt]$|^\d{4}\.\d*m$|^\d{5,}\.\d\dm$").is_match(text)
                // A fraction nine characters long or more and a `z` are a
                // datetime, seconds from 1970: q 5 reads `1234567.5z` as
                // 1970.01.15T06:56:07.500 and refuses `123456.5z` (#811).
                && !(text.len() >= 10 && text.ends_with('z'))
            {
                // After a fraction only a float, real, char or temporal
                // suffix reads: q 5 refuses `1.5d`, `1.5m`, `1.5u`, `1.5v`
                // and `1.5x` - `u` and `v` although `1u` and `1v` parse -
                // and takes `1.5n`, `1.5p`, `1.5t` and the month `2024.01m` (a
                // month's digits, `2023.1m`, are QE006's).
                Some(format!(
                    "`{text}`: `{}` is no type a fraction takes",
                    &text[text.len() - 1..]
                ))
            } else if re!(r"^\d+(?:\.\d*){2,}$").is_match(text)
                && !re!(r"^\d{4}\.\d{2}\.\d{2}$").is_match(text)
            {
                Some(format!("`{text}` is not a number or a date (yyyy.mm.dd)"))
            } else if re!(r"^\d{19,}j?$").is_match(text)
                && !float_vector(run)
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
            } else if k + 1 < run.len()
                && re!(r"^\d[\d.:]*(?:e[+-]?\d+)?[A-Za-z]$").is_match(text)
                && !text.ends_with('b')
                && !text.starts_with("0x")
                && !(text.ends_with(['D', 'T'])
                    && run
                        .iter()
                        .all(|t| t.as_str().contains(&text[text.len() - 1..])))
                && !(temporal_shape(text).is_some()
                    && run
                        .iter()
                        .all(|t| temporal_shape(t.as_str()) == temporal_shape(text)))
            {
                // Any suffix, temporal, char and symbol ones included: q 5
                // refuses `1e 2`, `1n 2`, `1s 2`, `1e3e 1` and `2026.01m
                // 2026.02m`. Not `1b 0`, which parses as an application, nor a
                // byte - and not the `D` that ends a timespan or timestamp
                // among others like it: `0D 0D01` and `1D 2D` parse, `0D 1` is
                // '0D. Nor a time or date among others of its shape, which q
                // reads by that shape: `12:00u 12:30`, `12:00:00x 12:30:00`
                // and `2000.01.01z 2000.01.02` parse, `12:00u 1` is '12:00u.
                Some(format!(
                    "`{text}`: a vector literal takes one type suffix, after its last item"
                ))
            } else if k + 1 < run.len()
                && (text.contains('.') || re!(r"^\d+[eE][+-]?\d+$").is_match(text))
                && !text.contains(':')
                && re!(r"^(?:\d+|0[nNwW])[hij]$").is_match(last)
            {
                Some(format!(
                    "`{text}`: the vector's `{}` suffix makes every item an integer",
                    &last[last.len() - 1..]
                ))
            } else if k + 1 < run.len() && re!(r"^(?:\d[\d.]*|0[nNwW])[dz]$").is_match(last) && {
                let z = last.ends_with('z');
                let day = |t: &str| {
                    let field = |r: std::ops::Range<usize>| t[r].parse::<u32>().unwrap();
                    (1..=days_in(field(0..4), field(4..6))).contains(&field(6..8))
                };
                match text.len() {
                    _ if text.contains('.') => {
                        z && re!(r"^\d+\.\d*$").is_match(text) && text.len() < 9
                    }
                    _ if !re!(r"^\d+$").is_match(text) => false,
                    8 => !day(text),
                    n => n < 8 || !z,
                }
            } {
                // The suffix types every item, and an item that is no date
                // is refused with it: q 5 `parse "1 20000101d"` is '1, as
                // are `1 20000101z` and `20001301 20000101d` (#812).
                Some(format!(
                    "`{text}`: the vector's `{}` suffix makes every item a {}, and this is none",
                    &last[last.len() - 1..],
                    if last.ends_with('z') {
                        "datetime"
                    } else {
                        "date"
                    }
                ))
            } else if re!(r"^\d(?:[0-9.:]*[0-9.])?(?:e[+-]?\d+)?[A-Za-z]{2,}$").is_match(text)
                && !text.starts_with("0x")
            {
                // A word written against a number joins it, and no number
                // ends in two letters (`0:str` is the operator `0:`): q 5 refuses `2mod 3`, `1 2in 3`,
                // `til 2each`, `1.5like` and `2000.01.01in` with the token
                // (#572).
                Some(format!(
                    "`{text}`: letters written against a number are part of it; put a blank \
                     between the number and the word"
                ))
            } else {
                None
            };
            // In a string only what q refuses as it reads the token.
            let detail = detail.filter(|_| {
                !in_string
                    || text.ends_with('b')
                    || text.starts_with("0x")
                    || re!(r"E[+-]").is_match(text)
            });
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
