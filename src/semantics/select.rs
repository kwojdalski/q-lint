//! What Expand Selection grows through from a position: the token, then
//! each bracket around it from the inside out - the `;`-separated item the
//! position is in, the bracket's contents, the bracket itself and, for a
//! call, the name it is applied to - then the top-level statement.
//!
//! All of it from the masked view the rules read, so a bracket in a string
//! or a comment encloses nothing. A file whose brackets do not all close
//! gets the token and the statement only: with one unmatched there is no
//! saying which of the others pair.

/// The ranges around `offset`, innermost first, each strictly holding the
/// one before it.
pub(crate) fn ranges(
    code: &str,
    raw: &str,
    string_starts: &[usize],
    balanced: bool,
    offset: usize,
) -> Vec<(usize, usize)> {
    let offset = offset.min(code.len());
    let strings: Vec<(usize, usize)> = string_starts
        .iter()
        .map(|&start| (start, string_end(raw, start)))
        .collect();
    let trim = Trim {
        code,
        raw,
        strings: &strings,
    };
    let mut found = vec![];
    found.extend(token(code, raw, &strings, offset));
    if balanced {
        for (open, close) in enclosing(code, raw, offset) {
            let inner = (open + 1, close);
            found.extend(item(&trim, inner, offset));
            found.push(trim.span(inner));
            found.push((open, close + 1));
            if code.as_bytes()[open] == b'[' {
                let head = code[..open]
                    .bytes()
                    .rev()
                    .take_while(|b| b.is_ascii_alphanumeric() || b"._".contains(b))
                    .count();
                found.push((open - head, close + 1));
            }
        }
    }
    let statement = statement(code, offset);
    found.extend(item(&trim, statement, offset));
    found.push(trim.span(statement));
    // Strictly growing: one that does not hold the last, or is the last
    // again, is passed over.
    let mut out: Vec<(usize, usize)> = vec![];
    for (start, end) in found {
        if start > end || start > offset || end < offset {
            continue;
        }
        if out
            .last()
            .is_none_or(|&(s, e)| start <= s && e <= end && (start, end) != (s, e))
        {
            out.push((start, end));
        }
    }
    out
}

/// The string literal `offset` is in, or the name or number at it.
fn token(
    code: &str,
    raw: &str,
    strings: &[(usize, usize)],
    offset: usize,
) -> Option<(usize, usize)> {
    if let Some(&string) = in_string(strings, offset) {
        return Some(string);
    }
    if let Some(literal) = temporal(code, offset) {
        return Some(literal);
    }
    if let Some((start, len)) = super::help::word_at(code, raw, offset) {
        return Some((start, start + len));
    }
    let word = |b: &u8| b.is_ascii_alphanumeric() || b"._".contains(b);
    let b = code.as_bytes();
    let start = offset - b[..offset].iter().rev().take_while(|b| word(b)).count();
    let end = offset + b[offset..].iter().take_while(|b| word(b)).count();
    (start < end).then_some((start, end))
}

/// The time or timestamp literal at `offset`, as q lexes it: `12:30`,
/// `0D12:00:00.5`, `2020.01.01T10:00:00.000` are one token each, which the
/// word rule would split at each `:` (#2052). A number starts where no name
/// goes on, and runs over digits, `.`, `:` and the type letters; only a
/// literal with a `:` in it is one the word rule gets wrong.
fn temporal(code: &str, offset: usize) -> Option<(usize, usize)> {
    let line = code[..offset].rfind('\n').map_or(0, |i| i + 1);
    let end = code[offset..].find('\n').map_or(code.len(), |i| offset + i);
    re!(r"(?:^|[^A-Za-z0-9_.])(\d[0-9A-Za-z.:]*)")
        .captures_iter(&code[line..end])
        .filter_map(|c| c.get(1))
        .map(|m| {
            (
                line + m.start(),
                line + m.as_str().trim_end_matches(':').len() + m.start(),
            )
        })
        .find(|&(start, end)| start <= offset && offset <= end)
        .filter(|&(start, end)| code[start..end].contains(':'))
}

/// The string literal `at` is in, from its opening quote to just past its
/// closing one.
fn in_string(strings: &[(usize, usize)], at: usize) -> Option<&(usize, usize)> {
    let i = strings.partition_point(|&(start, _)| start <= at);
    strings[..i].last().filter(|&&(_, end)| at < end)
}

/// Just past the quote that closes the string opening at `start`.
fn string_end(raw: &str, start: usize) -> usize {
    let b = raw.as_bytes();
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
    }
    b.len()
}

/// Each bracket pair `offset` is inside or on, innermost first, as the
/// offsets of its opener and its closer. A system command's line holds no q.
fn enclosing(code: &str, raw: &str, offset: usize) -> Vec<(usize, usize)> {
    let mut stack = vec![];
    let mut pairs = vec![];
    let mut at = 0;
    for line in code.split_inclusive('\n') {
        if !crate::system_command(&raw[at..at + line.len()]) {
            for (i, c) in line.bytes().enumerate() {
                if b"([{".contains(&c) {
                    stack.push(at + i);
                } else if b")]}".contains(&c)
                    && let Some(open) = stack.pop()
                    && open < offset
                    && offset <= at + i
                {
                    pairs.push((open, at + i));
                }
            }
        }
        at += line.len();
    }
    pairs.sort_by_key(|&(open, _)| std::cmp::Reverse(open));
    pairs
}

/// The `;`-separated item of `span` that `offset` is in, trimmed - the
/// bracket's own `;`s only, not those of a bracket inside it.
fn item(trim: &Trim, (start, end): (usize, usize), offset: usize) -> Option<(usize, usize)> {
    let b = trim.code.as_bytes();
    let (mut depth, mut from) = (0i32, start);
    for (i, &c) in b.iter().enumerate().take(end).skip(start) {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth == 0 => {
                if offset <= i {
                    return Some(trim.span((from, i)));
                }
                from = i + 1;
            }
            _ => {}
        }
    }
    (from > start).then(|| trim.span((from, end)))
}

/// What a range leaves off at either end: blanks, and comments - what the
/// masked view blanks that is not in a string, which it blanks too.
struct Trim<'a> {
    code: &'a str,
    raw: &'a str,
    strings: &'a [(usize, usize)],
}

impl Trim<'_> {
    fn gap(&self, i: usize) -> bool {
        self.raw.as_bytes()[i].is_ascii_whitespace()
            || self.code.as_bytes()[i] == b' ' && in_string(self.strings, i).is_none()
    }

    fn span(&self, (mut start, mut end): (usize, usize)) -> (usize, usize) {
        while start < end && self.gap(start) {
            start += 1;
        }
        while end > start && self.gap(end - 1) {
            end -= 1;
        }
        (start, end)
    }
}

/// The statement `offset` is in: from the line at column 0 that starts it
/// to the next such line. A line blank in the view - a comment - neither
/// starts nor ends one.
fn statement(code: &str, offset: usize) -> (usize, usize) {
    let starts = |line: &str| !line.starts_with([' ', '\t']) && !line.trim().is_empty();
    let mut start = 0;
    let mut end = code.len();
    let mut at = 0;
    for line in code.split_inclusive('\n') {
        if starts(line) {
            if at <= offset {
                start = at;
            } else {
                end = at;
                break;
            }
        }
        at += line.len();
    }
    (start, end)
}

#[cfg(test)]
mod tests {
    fn spans<'a>(source: &'a str, at: &str) -> Vec<&'a str> {
        let offset = source.find(at).unwrap();
        crate::selection_ranges(source, offset)
            .into_iter()
            .map(|(start, end)| &source[start..end])
            .collect()
    }

    #[test]
    fn a_string_is_one_token_and_its_brackets_enclose_nothing() {
        let source = "f[\"a(b\";2] / (c)\n";
        assert_eq!(
            spans(source, "b"),
            ["\"a(b\"", "\"a(b\";2", "[\"a(b\";2]", "f[\"a(b\";2]"]
        );
    }

    #[test]
    fn a_lambda_body_grows_a_statement_at_a_time() {
        let source = "f:{[x]\n  a:x+1;\n  b:a*2;\n  b}\ng:1\n";
        assert_eq!(
            spans(source, "a*2"),
            [
                "a",
                "b:a*2",
                "[x]\n  a:x+1;\n  b:a*2;\n  b",
                "{[x]\n  a:x+1;\n  b:a*2;\n  b}",
                "f:{[x]\n  a:x+1;\n  b:a*2;\n  b}",
            ]
        );
    }

    #[test]
    fn a_time_or_timestamp_literal_is_one_token() {
        // #2052. q lexes each of these as one atom: KDB-X 5 `type 12:30` is
        // -17h, `type 0D12:00:00.5` -16h, `type 10:00:00.123` -19h.
        assert_eq!(spans("x:12:30\n", "30"), ["12:30", "x:12:30"]);
        assert_eq!(spans("x:12:30\n", "12"), ["12:30", "x:12:30"]);
        assert_eq!(
            spans("x:0D12:00:00.5\n", "00.5"),
            ["0D12:00:00.5", "x:0D12:00:00.5"]
        );
        assert_eq!(
            spans("x:2020.01.01T10:00:00.000\n", "T10"),
            ["2020.01.01T10:00:00.000", "x:2020.01.01T10:00:00.000"]
        );
        assert_eq!(
            spans("f[10:00:00.123;1]\n", "123"),
            [
                "10:00:00.123",
                "10:00:00.123;1",
                "[10:00:00.123;1]",
                "f[10:00:00.123;1]"
            ]
        );
        // A name with digits in it, and a plain number, are as before.
        assert_eq!(spans("a1:2\n", "1:"), ["a1", "a1:2"]);
        assert_eq!(spans("x:1.5\n", "5"), ["1.5", "x:1.5"]);
    }

    #[test]
    fn unclosed_brackets_leave_the_token_and_the_statement() {
        let source = "f:{[x] g[x;(1;2]}\n";
        assert_eq!(spans(source, "1;"), ["1", "f:{[x] g[x;(1;2]}"]);
    }
}
