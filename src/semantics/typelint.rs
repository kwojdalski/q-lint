//! Lints from the types `infer` settles for a lambda's locals: a local every
//! assignment of which is one literal type (`s:`a`, `n:1 2 3`) is that type
//! wherever it is read, so an operator beside it can be judged as an
//! operator beside the literal would be. These are the literal rules QT003,
//! QT015 and a join's, carried to a name:
//!
//! - QT033: a symbol compared (`= < > <= >= <>`) with anything but a
//!   symbol - a number, a boolean, a byte, a temporal, a char or a string.
//!   q raises 'type (KDB-X and PeachQ, for each of those kinds).
//! - QT034: two lists of different types joined with `,` - `1 2,`a`b`,
//!   `n,"xy"` - which q runs, into a general list: the column or vector it
//!   was meant to grow is no longer simple. Not where either side can be
//!   `""`: a list of no items joined to a typed one takes its type, and
//!   `"",1 2` is 1 2 (7h, KDB-X).
//! - QT035: arithmetic (`+ - * %`) with a symbol on either side, which q
//!   refuses with 'type.
//!
//! One side has to be a typed local, the other a literal or another typed
//! local of the same lambda, and each side has to be the whole operand:
//! the right one ends the statement or its bracket, the left one starts
//! after a bracket, a `;`, an assignment or the start of the line. Anything
//! less sure - a column in a query, a parameter, a global, an expression -
//! is left alone, and so is a lambda of more than 64 locals, whose types
//! cost a read of the lambda each. One pass over each typed local's reads.
use super::infer::{Typed, literal_count, literal_type, typed_locals_up_to};
use crate::Finding;
use std::collections::HashMap;

/// What an operand is known to be: its q type, whether it can be `""`,
/// a list of no items, which a join takes the other side's type from, and
/// how many items it holds where it is a list of a known length.
type Operand = (i16, bool, Option<usize>);

/// The most locals a lambda may have for its types to be read here.
const MOST_LOCALS: usize = 64;

const COMPARE: [&str; 6] = ["<=", ">=", "<>", "=", "<", ">"];
const ARITHMETIC: [&str; 4] = ["+", "-", "*", "%"];

pub(crate) fn check(path: &str, code: &str, source: &str, comments: &str) -> Vec<Finding> {
    // Each local costs a read of its lambda: one with more than this many
    // is passed over, so a file of any size lints in linear time.
    let typed = typed_locals_up_to(code, source, comments, MOST_LOCALS);
    if typed.is_empty() {
        return vec![];
    }
    // The type of each typed local's every place, to read the other side,
    // and whether it may be `""`.
    let mut at_place: HashMap<usize, Operand> = HashMap::new();
    for t in &typed {
        for p in &t.local.places {
            at_place.insert(p.at, (t.kind, t.empty, t.count));
        }
    }
    let mut out = vec![];
    for t in &typed {
        for p in t.local.places.iter().filter(|p| !p.write && !p.column) {
            let end = p.at + p.len;
            if let Some((op, other, whole_end)) = right_side(code, comments, end, &at_place) {
                judge(&mut out, path, source, p.at, whole_end, t, op, other, true);
            }
            if let Some((op, other, start)) = left_side(code, comments, p.at, &at_place) {
                judge(&mut out, path, source, start, end, t, op, other, false);
            }
        }
    }
    out.sort_by_key(|f| (f.line, f.column));
    out.dedup_by(|a, b| a.line == b.line && a.column == b.column && a.code == b.code);
    out
}

/// What is said of a local of type `t.kind` next to `op` with `other` on
/// the far side; `local_left` when the local is the left operand.
#[allow(clippy::too_many_arguments)]
fn judge(
    out: &mut Vec<Finding>,
    path: &str,
    source: &str,
    start: usize,
    end: usize,
    t: &Typed,
    op: &str,
    other: Option<Operand>,
    local_left: bool,
) {
    let text = source[start..end].trim();
    let name = &t.local.name;
    let symbol = |k: i16| k.abs() == 11;
    let simple = |k: i16| k != 0 && k.abs() < 20;
    // Two lists of different lengths: q checks the lengths before the
    // types, and the error is 'length - `` `a`b=1 2 3 ``, `` `a`b+1 2 3 ``
    // and `` `a`b+() `` (KDB-X).
    let lengths = match (t.count, other) {
        (Some(mine), Some((_, _, Some(theirs)))) if mine != theirs => Some((mine, theirs)),
        _ => None,
    };
    let (code, detail) = if ARITHMETIC.contains(&op) && symbol(t.kind) {
        // An atom beside the empty list is the empty list, whatever the
        // atom is: `s+()` is `()` for a symbol `s` (KDB-X).
        if t.kind < 0 && other.is_some_and(|(o, ..)| o == 0) {
            return;
        }
        (
            "QT035",
            match lengths {
                Some((mine, theirs)) => format!(
                    "`{text}` is 'length: `{name}` is always {mine} symbols here and the other side holds {theirs}, and q does no arithmetic on a symbol"
                ),
                None => format!(
                    "`{text}` is 'type: `{name}` is always a symbol here, and q does no arithmetic on one"
                ),
            },
        )
    } else if let Some((o, other_empty, _)) = other {
        if COMPARE.contains(&op) && (symbol(t.kind) != symbol(o)) && simple(t.kind) && simple(o) {
            (
                "QT033",
                match lengths {
                    Some((mine, theirs)) => format!(
                        "`{text}` is 'length: `{name}` is always {} of {mine} here and the other side holds {theirs}, and a symbol compares only with a symbol",
                        kind_name(t.kind)
                    ),
                    None => format!(
                        "`{text}` is 'type: a symbol compares only with a symbol, and `{name}` is always {} here",
                        kind_name(t.kind)
                    ),
                },
            )
        } else if op == ","
            && simple(t.kind)
            && simple(o)
            && t.kind > 0
            && o > 0
            && t.kind != o
            // An empty side takes the other's type: `"",1 2` is 1 2 (#2118).
            && !t.empty
            && !other_empty
        {
            let (l, r) = if local_left { (t.kind, o) } else { (o, t.kind) };
            (
                "QT034",
                format!(
                    "`{text}` joins {} with {}: the result is a general list, not a simple one",
                    kind_name(l),
                    kind_name(r)
                ),
            )
        } else {
            return;
        }
    } else {
        return;
    };
    out.push(Finding::at(path, source, start, code, detail));
}

/// The type of the literal `text`, whether it is `""`, which has no items,
/// and how many it has where it is a list.
fn literal(text: &str) -> Option<Operand> {
    literal_type(text).map(|k| (k, text.trim() == "\"\"", literal_count(text)))
}

/// The words for a q type number.
pub(crate) fn kind_name(k: i16) -> String {
    let base = match k.abs() {
        1 => "boolean",
        2 => "guid",
        4 => "byte",
        5 => "short",
        6 => "int",
        7 => "long",
        8 => "real",
        9 => "float",
        10 => "char",
        11 => "symbol",
        12 => "timestamp",
        13 => "month",
        14 => "date",
        15 => "datetime",
        16 => "timespan",
        17 => "minute",
        18 => "second",
        19 => "time",
        _ => "other",
    };
    match (k < 0, k.abs()) {
        (true, _) => format!("a {base}"),
        (false, 10) => "a string".into(),
        (false, _) => format!("a {base} vector"),
    }
}

/// The dyad written after a name ending at `end`, and the type of its right
/// operand when that is one literal or one typed local that ends the
/// statement, and where it ends. The operand is `None` where it is
/// something else, which only the arithmetic rule can still judge.
fn right_side<'a>(
    code: &'a str,
    comments: &str,
    end: usize,
    at_place: &HashMap<usize, Operand>,
) -> Option<(&'a str, Option<Operand>, usize)> {
    let rest = &code[end..];
    let gap = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    let after = &rest[gap..];
    let op = COMPARE
        .iter()
        .chain(ARITHMETIC.iter())
        .chain([","].iter())
        .find(|op| after.starts_with(**op))?;
    let next = after.as_bytes().get(op.len()).copied();
    // An adverb or an assignment makes it another thing: `,'`, `+:`, `,/`.
    if matches!(next, Some(b'\'' | b'/' | b'\\' | b':')) {
        return None;
    }
    // `s -1` is s indexed at -1, not s minus 1.
    if *op == "-" && gap > 0 && next.is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    let from = end + gap + op.len();
    // Nothing on its right is a projection. Strings are blank in the code
    // view, quotes and all, so where the operand starts is read from the
    // comments view, which keeps them.
    let operand = comments[from..].trim_start_matches([' ', '\t']);
    if operand.is_empty() || operand.starts_with([';', ')', ']', '}', '\n', '\r']) {
        return None;
    }
    let start = from + (comments[from..].len() - operand.len());
    let stop = operand_end(code, start);
    let text = comments[start..stop].trim_end();
    let kind = literal(text).or_else(|| {
        let name_end = start + text.len();
        let is_name = text.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
            && text.bytes().next().is_some_and(|c| c.is_ascii_alphabetic());
        is_name
            .then(|| at_place.get(&start).copied())
            .flatten()
            .filter(|_| name_end <= stop)
    });
    // What is quoted stays on one line: of an operand that runs on over
    // the next, only up to the operator.
    let shown = if text.contains('\n') {
        from
    } else {
        start + text.len()
    };
    Some((op, kind, shown))
}

/// Where the operand starting at `start` ends: the `;`, the line break or
/// the closing bracket that ends its expression, past any bracket it opens
/// itself - `g[1;2]` and `count(1;2)` are each one operand.
fn operand_end(code: &str, start: usize) -> usize {
    let mut depth = 0usize;
    for (i, b) in code[start..].bytes().enumerate() {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth == 0 => return start + i,
            b')' | b']' | b'}' => depth -= 1,
            b';' | b'\n' if depth == 0 => return start + i,
            _ => {}
        }
    }
    code.len()
}

/// The dyad written before a name starting at `at`, the type of its left
/// operand when that is one literal or one typed local, and where that
/// operand starts. q reads right to left, so a dyad's left operand is the
/// one noun before it - a name, a symbol or several, a number or a vector
/// of them, a string - whatever is applied to the result further left.
fn left_side(
    code: &str,
    comments: &str,
    at: usize,
    at_place: &HashMap<usize, Operand>,
) -> Option<(&'static str, Option<Operand>, usize)> {
    let before = code[..at].trim_end_matches([' ', '\t']);
    let op = COMPARE
        .iter()
        .chain(ARITHMETIC.iter())
        .chain([","].iter())
        .find(|op| before.ends_with(**op))?;
    let left = before[..before.len() - op.len()].trim_end_matches([' ', '\t']);
    // A string is blank in the code view, quotes and all, so one that ends
    // the left operand is read from the comments view, which keeps it:
    // `"a"=s` and `"ab"+s` are 'type (KDB-X).
    let kept = comments[..before.len() - op.len()].trim_end_matches([' ', '\t']);
    if kept.len() > left.len() && kept.ends_with('"') {
        // Blank in the code view from quote to quote, or it is no one string.
        let start = string_start(kept).filter(|&s| code[s..kept.len()].trim().is_empty())?;
        return Some((op, literal(&kept[start..]), start));
    }
    let b = left.as_bytes();
    let token_char = |i: usize| {
        let c = b[i];
        c.is_ascii_alphanumeric()
            || matches!(c, b'_' | b'.' | b'`')
            // A time's colons: `09:30`.
            || (c == b':' && i > 0 && b[i - 1].is_ascii_digit() && b.get(i + 1).is_some_and(u8::is_ascii_digit))
    };
    // The last token, then - for a number - the numbers before it that make
    // one vector with it.
    let token_start = |end: usize| {
        let mut s = end;
        while s > 0 && token_char(s - 1) {
            s -= 1;
        }
        // An assignment's colon is no time's: `r:1` is the literal `1`.
        if let Some(colon) = left[s..end].rfind(':')
            && !b[s].is_ascii_digit()
        {
            s += colon + 1;
        }
        // A sign that is the number's, not a dyad: after a blank or a bracket.
        if s > 0
            && b[s - 1] == b'-'
            && b.get(s).is_some_and(u8::is_ascii_digit)
            && (s == 1 || matches!(b[s - 2], b' ' | b'\t' | b'(' | b'[' | b';' | b':'))
        {
            s -= 1;
        }
        s
    };
    let mut start = token_start(left.len());
    if start == left.len() {
        return None;
    }
    let numeric = |s: usize| {
        let t = &left[s..];
        t.trim_start_matches('-')
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_digit())
    };
    if numeric(start) {
        while start > 1 && b[start - 1] == b' ' {
            let s = token_start(start - 1);
            if s == start - 1 || !numeric(s) {
                break;
            }
            start = s;
        }
    }
    let text = &left[start..];
    let kind = literal(text).or_else(|| {
        let is_name = text.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
            && text.bytes().next().is_some_and(|c| c.is_ascii_alphabetic());
        is_name.then(|| at_place.get(&start).copied()).flatten()
    });
    Some((op, kind, start))
}

/// Where the string literal that ends `text` starts: the nearest quote
/// before its closing one that no backslash escapes.
fn string_start(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let mut i = b.len().checked_sub(1)?;
    while i > 0 {
        i -= 1;
        if b[i] == b'"' {
            let slashes = b[..i].iter().rev().take_while(|c| **c == b'\\').count();
            if slashes % 2 == 0 {
                return Some(i);
            }
        }
    }
    None
}
