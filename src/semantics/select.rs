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
    if let Some((start, len)) = super::help::word_at(code, raw, offset) {
        return Some((start, start + len));
    }
    let word = |b: &u8| b.is_ascii_alphanumeric() || b"._".contains(b);
    let b = code.as_bytes();
    let start = offset - b[..offset].iter().rev().take_while(|b| word(b)).count();
    let end = offset + b[offset..].iter().take_while(|b| word(b)).count();
    (start < end).then_some((start, end))
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
    fn unclosed_brackets_leave_the_token_and_the_statement() {
        let source = "f:{[x] g[x;(1;2]}\n";
        assert_eq!(spans(source, "1;"), ["1", "f:{[x] g[x;(1;2]}"]);
    }
}
