//! A local's type, from what is assigned to it - and only where reading the
//! source settles it.
//!
//! A type is inferred where every assignment of the local in its lambda is a
//! plain `name:` of a literal (a number or a vector of them, a boolean, a
//! byte, a string, a symbol or several, a date or a time, a lambda, or
//! `()`), and every one of them has the same type. Anything else leaves the
//! local untyped: an expression, even `a:1+2`, since this reads and never
//! runs; a parameter; an amend (`a+:1`, `a[i]:2`); a multiple assignment;
//! two literals of different types; or a literal q would refuse
//! (`2024.02.30`). Showing nothing beats showing a guess.
//!
//! The types are q's own numbers, the ones `type` returns, as KDB-X returns
//! them for the same text: `tests/assist.rs` holds the table, checked
//! against a running q when `QLINT_TEST_Q` names one.
use super::scopes;
use crate::Local;

/// What `type` gives for the literal `text`, when `text` is one literal and
/// nothing more, and this is sure of it.
pub fn literal_type(text: &str) -> Option<i16> {
    let text = text.trim_matches([' ', '\t', '\n', '\r']);
    if text.is_empty() {
        return None;
    }
    // Blanks between the parentheses are still the empty list: `( )`.
    if text
        .strip_prefix('(')
        .and_then(|t| t.strip_suffix(')'))
        .is_some_and(|t| t.trim().is_empty())
    {
        return Some(0);
    }
    if text.starts_with('{') {
        return lambda(text).then_some(100);
    }
    if text.starts_with('"') {
        return string_length(text).map(|n| if n == 1 { -10 } else { 10 });
    }
    if text.starts_with('`') {
        return symbols(text).map(|n| if n == 1 { -11 } else { 11 });
    }
    let tokens: Vec<&str> = text.split_ascii_whitespace().collect();
    // A newline is blank to q inside a lambda; a vector is still one.
    let vector = tokens.len() > 1;
    let atom = |t: i16| if vector { t } else { -t };
    if let [only] = tokens[..]
        && let Some(t) = single(only)
    {
        return Some(t);
    }
    if let Some(t) = temporal_vector(&tokens) {
        return Some(atom(t));
    }
    numbers(&tokens).map(atom)
}

/// How many items the literal `text` holds, when `literal_type` reads it
/// as a list: a simple vector, or `()`, which holds none.
pub(crate) fn literal_count(text: &str) -> Option<usize> {
    let kind = literal_type(text)?;
    let text = text.trim_matches([' ', '\t', '\n', '\r']);
    match kind {
        0 => Some(0),
        10 => string_length(text),
        11 => symbols(text),
        // A boolean or byte vector is one token, an item per digit or pair.
        1 => Some(text.len() - 1),
        4 => Some((text.len() - 2) / 2),
        2..20 => Some(text.split_ascii_whitespace().count()),
        _ => None,
    }
}

/// A brace group that closes at the end of `text`: one lambda, not one
/// applied (`{x}[1]`) or followed by anything. The text is the comments
/// view's, strings kept, so a brace in a string is skipped here.
fn lambda(text: &str) -> bool {
    let mut depth = 0i32;
    let mut string = false;
    let mut escaped = false;
    for (i, c) in text.char_indices() {
        if string {
            match (escaped, c) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1 == text.len();
                }
            }
            _ => {}
        }
    }
    false
}

/// How many characters the string literal `text` holds, as q counts them:
/// in bytes, so `"é"` is two and a string, not a char (KDB-X: `type "é"`
/// is 10h, #2063). `None` unless `text` is one string and nothing more,
/// with only the escapes q reads.
fn string_length(text: &str) -> Option<usize> {
    let body = text.strip_prefix('"')?;
    let mut chars = body.chars();
    let mut n = 0;
    loop {
        match chars.next()? {
            '"' => return chars.as_str().is_empty().then_some(n),
            '\\' => {
                match chars.next()? {
                    'n' | 't' | 'r' | '\\' | '"' => {}
                    '0'..='7' => {
                        let rest: String = chars.clone().take(2).collect();
                        if rest.len() != 2 || !rest.chars().all(|c| ('0'..='7').contains(&c)) {
                            return None;
                        }
                        chars.nth(1);
                    }
                    _ => return None,
                }
                n += 1;
            }
            '\n' | '\r' => return None,
            c => n += c.len_utf8(),
        }
    }
}

/// How many symbols `` `a`b `` writes, when `text` is only backticks and
/// the characters a symbol literal continues with. A `/` continues one only
/// after a `:` in it: KDB-X's `` `:a/b `` is a symbol, `` `a/ `` a derived
/// function and `` `.a/b `` an error (#1245). An underscore straight after
/// the first backtick is drop, not a name's: KDB-X parses `` `_a `` as
/// `` ` _ a `` and raises 'a, though `` `a`_b `` is two symbols.
fn symbols(text: &str) -> Option<usize> {
    if text.starts_with("`_") {
        return None;
    }
    let mut colon = false;
    text.chars()
        .all(|c| {
            match c {
                '`' => colon = false,
                ':' => colon = true,
                '/' => return colon,
                _ => {}
            }
            c == '`' || c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':')
        })
        .then(|| text.matches('`').count())
}

/// The type of a literal that is never part of a vector of spaced items:
/// a boolean or byte run, or a null or infinity with its type letter.
fn single(token: &str) -> Option<i16> {
    if let Some(bits) = token.strip_suffix('b')
        && !bits.is_empty()
        && bits.bytes().all(|b| b == b'0' || b == b'1')
    {
        return Some(if bits.len() == 1 { -1 } else { 1 });
    }
    if let Some(hex) = token.strip_prefix("0x") {
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        return match hex.len() {
            1 | 2 => Some(-4),
            n if n % 2 == 0 => Some(4),
            _ => None,
        };
    }
    if token.len() == 3
        && (token.starts_with("0N") || token.starts_with("0W"))
        && let Some(t) = suffix_type(token.as_bytes()[2])
    {
        return Some(-t);
    }
    None
}

/// The vector type a number's type letter gives.
fn suffix_type(letter: u8) -> Option<i16> {
    match letter {
        b'h' => Some(5),
        b'i' => Some(6),
        b'j' => Some(7),
        b'e' => Some(8),
        b'f' => Some(9),
        _ => None,
    }
}

/// The vector type of numbers written `1 2.5 0N`, with an optional type
/// letter on the last: a float where any is written with a point or is a
/// float null or infinity, a long otherwise.
fn numbers(tokens: &[&str]) -> Option<i16> {
    let (last, rest) = tokens.split_last()?;
    let (last, letter) = match last.as_bytes().last() {
        Some(b)
            if b.is_ascii_alphabetic()
                && !matches!(*last, "0N" | "0n" | "0w" | "0W" | "-0w" | "-0W") =>
        {
            (&last[..last.len() - 1], Some(suffix_type(*b)?))
        }
        _ => (*last, None),
    };
    let mut float = false;
    for token in rest.iter().copied().chain([last]) {
        match token {
            "0N" | "0W" | "-0W" => {}
            "0n" | "0w" | "-0w" => float = true,
            _ => {
                let digits = token.strip_prefix('-').unwrap_or(token);
                let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
                if (whole.is_empty() && fraction.is_empty())
                    || !whole.bytes().all(|b| b.is_ascii_digit())
                    || !fraction.bytes().all(|b| b.is_ascii_digit())
                {
                    return None;
                }
                float |= digits.contains('.');
            }
        }
    }
    match (letter, float) {
        // A point or a float null under an integer's letter is refused.
        (Some(5..=7), true) => None,
        (Some(t), _) => Some(t),
        (None, true) => Some(9),
        (None, false) => Some(7),
    }
}

/// The vector type of a run of dates or times of one kind, each one q
/// accepts.
fn temporal_vector(tokens: &[&str]) -> Option<i16> {
    let (last, rest) = tokens.split_last()?;
    // A month is `2024.01` with an `m` after the last: without it, a float.
    if let Some(month) = last.strip_suffix('m') {
        return rest
            .iter()
            .copied()
            .chain([month])
            .all(is_month)
            .then_some(13);
    }
    let kind = temporal(tokens[0])?;
    tokens
        .iter()
        .all(|t| temporal(t) == Some(kind))
        .then_some(kind)
}

fn digits(text: &str, n: usize) -> Option<u32> {
    (text.len() == n && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

fn is_month(text: &str) -> bool {
    let Some((year, month)) = text.split_once('.') else {
        return false;
    };
    digits(year, 4).is_some() && digits(month, 2).is_some_and(|m| (1..=12).contains(&m))
}

fn is_date(text: &str) -> bool {
    let mut parts = text.split('.');
    let (Some(y), Some(m), Some(d), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let (Some(y), Some(m), Some(d)) = (digits(y, 4), digits(m, 2), digits(d, 2)) else {
        return false;
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

/// `hh:mm`, `hh:mm:ss` or `hh:mm:ss.fff` within a day: the parts, and the
/// digits after the point.
fn clock(text: &str) -> Option<(usize, Option<usize>)> {
    let (clock, fraction) = match text.split_once('.') {
        Some((clock, fraction)) => (clock, Some(fraction)),
        None => (text, None),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    let h = digits(parts.first()?, 2)?;
    if h > 23 || parts.len() > 3 || parts.len() < 2 {
        return None;
    }
    for part in &parts[1..] {
        if digits(part, 2)? > 59 {
            return None;
        }
    }
    let fraction = match fraction {
        Some(f) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => Some(f.len()),
        Some(_) => return None,
        None => None,
    };
    Some((parts.len(), fraction))
}

/// The atom type q gives one date or time literal, negated: 14 for a date,
/// 12 a timestamp, 16 a timespan, 17 a minute, 18 a second, 19 a time.
fn temporal(text: &str) -> Option<i16> {
    if let Some((before, after)) = text.split_once('D') {
        let within = after.is_empty() || clock(after).is_some_and(|(parts, _)| parts >= 2);
        if !within {
            return None;
        }
        if is_date(before) {
            return Some(12);
        }
        return (!before.is_empty() && before.bytes().all(|b| b.is_ascii_digit())).then_some(16);
    }
    if is_date(text) {
        return Some(14);
    }
    match clock(text)? {
        (2, None) => Some(17),
        (3, None) => Some(18),
        (3, Some(3)) => Some(19),
        _ => None,
    }
}

/// A local of one lambda whose type every assignment settles: the local,
/// and the type `type` gives its value.
pub struct Typed {
    pub local: Local,
    pub kind: i16,
    /// Where the value of its first assignment ends, blanks trimmed.
    pub end: usize,
    /// Whether some assignment is `""`, a vector of no items: q joins one
    /// to a list of any type into that list's type, `"",1 2` is 1 2 (7h).
    pub empty: bool,
    /// How many items it holds, where it is a list and every assignment
    /// gives it as many.
    pub count: Option<usize>,
}

/// Each local in `raw` whose type its assignments settle. `code` is the
/// view with strings and comments blank, which says where an assignment's
/// value ends; `comments` the one with only comments blank, whose text is
/// the literal.
pub fn typed_locals(code: &str, raw: &str, comments: &str) -> Vec<Typed> {
    typed_locals_up_to(code, raw, comments, usize::MAX)
}

/// `typed_locals`, passing over a lambda with more than `most` locals:
/// each local costs a read of its lambda, so a rule run over every file
/// bounds it to stay linear in the file's length.
pub fn typed_locals_up_to(code: &str, raw: &str, comments: &str, most: usize) -> Vec<Typed> {
    let (scopes, _) = scopes(code, raw);
    let mut sigs = signatures(code);
    // A pattern assignment's item is no assignment either: in
    // `(a:`f;b):x`, `a:`f` checks the item is a float, and `a` is that
    // float (q 5 `{(a:`f;b):x; a*2}[(1.5;2)]` is 3f, #2331).
    sigs.extend(
        super::pattern_targets(code)
            .into_iter()
            .map(|(open, close, _)| (open + 1, close)),
    );
    sigs.sort_unstable();
    let mut out = vec![];
    for s in 0..scopes.len() {
        if scopes[s].locals.len() > most {
            continue;
        }
        let mut names: Vec<&String> = scopes[s].locals.iter().collect();
        names.sort_unstable();
        for name in names {
            // A parameter - `x`, `y`, `z` included - never settles: its first
            // write is the caller's argument, not a literal. Reading it would
            // cost a pass over its lambda for nothing, and a nest of lambdas
            // pays that pass at every level.
            if scopes[s].params.contains(name.as_str()) {
                continue;
            }
            let local = super::navigate::local_of(code, raw, &scopes, s, name);
            if let Some((kind, end, empty, count)) = settled(code, comments, &local, &sigs) {
                out.push(Typed {
                    local,
                    kind,
                    end,
                    empty,
                    count,
                });
            }
        }
    }
    out.sort_by_key(|t| t.local.places.first().map_or(0, |p| p.at));
    out
}

/// The one type every write of `local` gives it, when each is a plain
/// assignment of a literal, with where the first one's value ends,
/// whether any is `""`, and the one count of items they all have.
fn settled(
    code: &str,
    comments: &str,
    local: &Local,
    sigs: &[(usize, usize)],
) -> Option<(i16, usize, bool, Option<usize>)> {
    let mut found: Option<(i16, usize)> = None;
    let mut empty = false;
    let mut counts: Vec<Option<usize>> = vec![];
    for place in local.places.iter().filter(|p| p.write) {
        // A typed parameter, `{[a:`j] ...}` (q 4.1), is no assignment: `a`
        // is whatever the caller passes, checked to be a long.
        if in_signature(sigs, place.at) {
            return None;
        }
        let value = assigned(code, place.at + place.len)?;
        let text = &comments[value.clone()];
        let t = literal_type(text)?;
        empty |= text.trim() == "\"\"";
        counts.push(literal_count(text));
        match found {
            Some((k, _)) if k != t => return None,
            Some(_) => {}
            None => found = Some((t, value.start + text.trim_end().len())),
        }
    }
    let count = counts
        .first()
        .copied()
        .flatten()
        .filter(|_| counts.windows(2).all(|w| w[0] == w[1]));
    found.map(|(t, end)| (t, end, empty, count))
}

/// Each lambda signature in `code`, `{[...]`, as the bytes between its
/// brackets: one pass, a signature holding no other bracket of its kind.
/// Blanks may stand between the brace and the bracket: q 5 reads
/// `{ [x:`j] x}` as a typed parameter (`{ [x:`j] x}[1f]` is 'type).
fn signatures(code: &str) -> Vec<(usize, usize)> {
    let b = code.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i + 1 < b.len() {
        let gap = if b[i] == b'{' {
            b[i + 1..]
                .iter()
                .take_while(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n'))
                .count()
        } else {
            0
        };
        if b[i] == b'{' && b.get(i + 1 + gap) == Some(&b'[') {
            i += gap;
            let mut depth = 0usize;
            let mut j = i + 1;
            while j < b.len() {
                match b[j] {
                    b'[' => depth += 1,
                    b']' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            out.push((i + 2, j));
            i = j;
        }
        i += 1;
    }
    out
}

/// Whether byte `at` is inside one of `sigs`.
fn in_signature(sigs: &[(usize, usize)], at: usize) -> bool {
    let k = sigs.partition_point(|&(start, _)| start <= at);
    k > 0 && at < sigs[k - 1].1
}

/// What a plain assignment whose name ends at `end` assigns, as a range of
/// the source: from after its `:` up to the `;` or the closing bracket that
/// ends the expression. Nothing when what follows the name is no plain
/// `:` - an amend, `::`, a signature's `;` or a multiple assignment's.
fn assigned(code: &str, end: usize) -> Option<std::ops::Range<usize>> {
    let rest = code.get(end..)?;
    let value = rest.strip_prefix(':')?;
    if value.starts_with(':') {
        return None;
    }
    let start = end + 1;
    let mut depth = 0i32;
    for (i, b) in value.bytes().enumerate() {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth == 0 => return Some(start..start + i),
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth == 0 => return Some(start..start + i),
            _ => {}
        }
    }
    Some(start..code.len())
}
