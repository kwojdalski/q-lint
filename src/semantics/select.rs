//! What Expand Selection grows through from a position: the token, then
//! each bracket around it from the inside out - the `;`-separated item the
//! position is in, the bracket's contents, the bracket itself and, for a
//! call, what it is applied to - then the top-level statement.
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
    found.extend(symbols(code, &strings, offset));
    if balanced {
        for (open, close) in enclosing(code, raw, offset) {
            let inner = (contents(code, open), close);
            found.extend(item(&trim, inner, offset));
            found.push(trim.span(inner));
            found.push((open, close + 1));
            if code.as_bytes()[open] == b'[' {
                found.push((head(code, open), close + 1));
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

/// Where what a bracket holds starts: just past its opener, and for a lambda
/// or a parenthesis past the `[...]` it opens with too. A lambda's signature
/// is no part of its first statement (#2673), nor a table literal's key
/// columns of its first value column (#2674): the `[...]` is a bracket of
/// its own, and grows as one.
fn contents(code: &str, open: usize) -> usize {
    let b = code.as_bytes();
    let at = open
        + 1
        + b[open + 1..]
            .iter()
            .take_while(|c| c.is_ascii_whitespace())
            .count();
    if b[open] == b'[' || b.get(at) != Some(&b'[') {
        return open + 1;
    }
    let mut depth = 0i32;
    for (i, &c) in b.iter().enumerate().skip(at) {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            return i + 1;
        }
    }
    open + 1
}

/// The opener of the bracket that closes at `close`.
fn opener(code: &str, close: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, &c) in code.as_bytes()[..=close].iter().enumerate().rev() {
        match c {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            return Some(i);
        }
    }
    None
}

/// Where what the `[` at `open` is applied to starts, or `open` where it
/// is applied to nothing. That is a name; a symbol; a lambda or a
/// parenthesis (`{y}[2;3]`); an index of any of these (`x[1][2]`); one of
/// them, or an operator, under adverbs (`f'[..]`, `f/:[..]`, `+/[..]`); or
/// the `$` of `$[c;t;f]` (#2677).
fn head(code: &str, open: usize) -> usize {
    let b = code.as_bytes();
    if b[..open].ends_with(b"$") {
        return open - 1;
    }
    let mut at = open;
    loop {
        if at > 1 && b[at - 1] == b':' && b"'/\\".contains(&b[at - 2]) {
            at -= 2;
        } else if at > 0 && b"'/\\".contains(&b[at - 1]) {
            at -= 1;
        } else {
            break;
        }
    }
    match b[..at].last() {
        Some(b')' | b'}') => opener(code, at - 1).unwrap_or(at),
        Some(b']') => opener(code, at - 1).map_or(at, |index| head(code, index)),
        _ => {
            let name = b[..at]
                .iter()
                .rev()
                .take_while(|c| c.is_ascii_alphanumeric() || b"._".contains(c))
                .count();
            // A symbol is one token with its backtick, and a file
            // handle's `:` too: q's `-4!` reads `` `.p.f `` whole (#2318).
            let before = &b[..at - name];
            if before.ends_with(b"`:") {
                at - name - 2
            } else if before.ends_with(b"`") {
                at - name - 1
            } else if name == 0
                && at < open
                && before
                    .last()
                    .is_some_and(|c| b"+-*%&|^=<>~!#_?@.,".contains(c))
            {
                at - 1
            } else {
                at - name
            }
        }
    }
}

/// The symbol `offset` is in, with its backtick, and the run of symbols
/// that one is in: q reads `` `a `` and `` `:dir/f.q `` as one token each,
/// and `` `a`b `` as one list (#2676).
fn symbols(code: &str, strings: &[(usize, usize)], offset: usize) -> Vec<(usize, usize)> {
    if in_string(strings, offset).is_some() {
        return vec![];
    }
    let line = code[..offset].rfind('\n').map_or(0, |i| i + 1);
    let end = code[offset..].find('\n').map_or(code.len(), |i| offset + i);
    let holds = |m: &regex::Match| line + m.start() <= offset && offset <= line + m.end();
    let Some(run) = re!(r"(?:`(?::[A-Za-z0-9_.:/]*|[A-Za-z0-9_.:]*))+")
        .find_iter(&code[line..end])
        .find(holds)
    else {
        return vec![];
    };
    let at = line + run.start();
    re!(r"`(?::[A-Za-z0-9_.:/]*|[A-Za-z0-9_.:]*)")
        .find_iter(run.as_str())
        .map(|m| (at + m.start(), at + m.end()))
        .find(|&(start, end)| start <= offset && offset <= end)
        .into_iter()
        .chain([(at, line + run.end())])
        .collect()
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
    // A `-` is the number's own where no operand ends before it: `-1` in
    // `s:-1_y` and `a -1`, but `-` and `1` in `a-1`.
    let negative = |at: usize| {
        at > 0
            && b[at - 1] == b'-'
            && (at == 1 || !(b[at - 2].is_ascii_alphanumeric() || b")]}._\"`".contains(&b[at - 2])))
    };
    if let Some((at, stop)) = signed_exponent(code, offset) {
        return Some((at - usize::from(negative(at)), stop));
    }
    let start = offset - b[..offset].iter().rev().take_while(|b| word(b)).count();
    let end = offset + b[offset..].iter().take_while(|b| word(b)).count();
    if start >= end {
        return None;
    }
    // The run is q's tokens: a number never holds `_`, which drops after
    // it - KDB-X's `-4!"s:-1_y"` is `s`, `:`, `-1`, `_`, `y` (#2319) - and
    // a name runs to the end of the run.
    let mut at = start;
    while at < end {
        let number = b[at].is_ascii_digit()
            || b[at] == b'.' && b.get(at + 1).is_some_and(u8::is_ascii_digit);
        let stop = if number {
            crate::number_end(code, at).clamp(at + 1, end)
        } else if b[at] == b'_' {
            at + 1
        } else {
            end
        };
        if offset <= stop || stop == end {
            return Some((at - usize::from(number && negative(at)), stop));
        }
        at = stop;
    }
    Some((start, end))
}

/// The number at `offset` whose exponent carries a sign, as q lexes it:
/// `1e-3` and `1.5e+10` are one float each, which the word rule would end at
/// the sign (#2675). The line's runs of letters, digits, points and signs are
/// read left to right, as `number_end` reads a number from where one starts.
fn signed_exponent(code: &str, offset: usize) -> Option<(usize, usize)> {
    let b = code.as_bytes();
    let part = |c: &u8| c.is_ascii_alphanumeric() || b"._+-".contains(c);
    let mut at = offset - b[..offset].iter().rev().take_while(|c| part(c)).count();
    // Past a backtick the run starts with a symbol's text, not a number.
    let mut name = at > 0 && b[at - 1] == b'`';
    while at <= offset && at < b.len() && part(&b[at]) {
        let digit = b[at].is_ascii_digit()
            || b[at] == b'.' && b.get(at + 1).is_some_and(u8::is_ascii_digit);
        if digit && !name {
            let stop = crate::number_end(code, at);
            if offset <= stop {
                return code[at..stop].contains(['+', '-']).then_some((at, stop));
            }
            at = stop;
        } else if b[at].is_ascii_alphanumeric() || b"._".contains(&b[at]) {
            at += b[at..]
                .iter()
                .take_while(|c| c.is_ascii_alphanumeric() || b"._".contains(c))
                .count();
        } else {
            at += 1;
        }
        name = false;
    }
    None
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
                "a:x+1;\n  b:a*2;\n  b",
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
    fn a_call_through_a_symbol_grows_with_its_backtick() {
        // KDB-X's `-4!` reads `` `.p.f `` and `` `:f `` as one token each
        // (#2318).
        assert_eq!(
            spans("r:`.p.f[1;2]\n", "1;"),
            ["1", "1;2", "[1;2]", "`.p.f[1;2]", "r:`.p.f[1;2]"]
        );
        assert_eq!(
            spans("r:`:f[1]\n", "1]"),
            ["1", "[1]", "`:f[1]", "r:`:f[1]"]
        );
    }

    #[test]
    fn a_number_before_a_drop_is_its_own_token() {
        // KDB-X's `-4!` reads `-1`, `_`, `y` in `s:-1_y`, and `10`, `_`,
        // `string` in `10_string z`; `a-1` is `a`, `-`, `1` (#2319).
        assert_eq!(spans("r:1_y\n", "1"), ["1", "r:1_y"]);
        assert_eq!(spans("s:-1_y\n", "1"), ["-1", "s:-1_y"]);
        assert_eq!(spans("u:10_string z\n", "0"), ["10", "u:10_string z"]);
        assert_eq!(spans("v:a-1_y\n", "1"), ["1", "v:a-1_y"]);
    }

    #[test]
    fn a_lambda_signature_is_no_part_of_its_first_statement() {
        // #2673.
        assert_eq!(
            spans("foo:{[aa;bb] c:aa+bb; c*2}\n", "aa+"),
            [
                "aa",
                "c:aa+bb",
                "c:aa+bb; c*2",
                "{[aa;bb] c:aa+bb; c*2}",
                "foo:{[aa;bb] c:aa+bb; c*2}",
            ]
        );
        assert_eq!(
            spans("foo:{[aa;bb] aa+bb}\n", "aa+"),
            ["aa", "aa+bb", "{[aa;bb] aa+bb}", "foo:{[aa;bb] aa+bb}"]
        );
        // The signature grows as the bracket it is.
        assert_eq!(
            spans("foo:{[aa;bb] aa+bb}\n", "aa;"),
            [
                "aa",
                "aa;bb",
                "[aa;bb]",
                "{[aa;bb] aa+bb}",
                "foo:{[aa;bb] aa+bb}"
            ]
        );
        // A comment under the signature is no part of the body either.
        assert_eq!(
            spans("f:{[a]\n  / note\n  b:a+1}\n", "a+1"),
            [
                "a",
                "b:a+1",
                "{[a]\n  / note\n  b:a+1}",
                "f:{[a]\n  / note\n  b:a+1}"
            ]
        );
        // A lambda with no signature is as before.
        assert_eq!(
            spans("foo:{x+1; x*2}\n", "x+"),
            ["x", "x+1", "x+1; x*2", "{x+1; x*2}", "foo:{x+1; x*2}"]
        );
    }

    #[test]
    fn a_table_literals_key_brackets_are_no_part_of_its_first_column() {
        // #2674.
        assert_eq!(
            spans("r:([] a:1 2; b:3 4)\n", "a:"),
            [
                "a",
                "a:1 2",
                "a:1 2; b:3 4",
                "([] a:1 2; b:3 4)",
                "r:([] a:1 2; b:3 4)"
            ]
        );
        assert_eq!(
            spans("r:([] a:1 2; b:3 4)\n", "b:"),
            [
                "b",
                "b:3 4",
                "a:1 2; b:3 4",
                "([] a:1 2; b:3 4)",
                "r:([] a:1 2; b:3 4)"
            ]
        );
        assert_eq!(
            spans("r:([k:1 2] v:3 4)\n", "v:"),
            ["v", "v:3 4", "([k:1 2] v:3 4)", "r:([k:1 2] v:3 4)"]
        );
        assert_eq!(
            spans("r:([k:1 2] v:3 4)\n", "k:"),
            [
                "k",
                "k:1 2",
                "[k:1 2]",
                "([k:1 2] v:3 4)",
                "r:([k:1 2] v:3 4)"
            ]
        );
    }

    #[test]
    fn a_float_with_a_signed_exponent_is_one_token() {
        // #2675. KDB-X 5's `-4!"r:1e-3*2"` is `r`, `:`, `1e-3`, `*`, `2`.
        for at in ["1e", "e-", "-3", "3*"] {
            assert_eq!(spans("r:1e-3*2\n", at), ["1e-3", "r:1e-3*2"], "{at}");
        }
        assert_eq!(spans("r:1.5e+10\n", "5e"), ["1.5e+10", "r:1.5e+10"]);
        assert_eq!(spans("r:1.5e+10\n", "10"), ["1.5e+10", "r:1.5e+10"]);
        assert_eq!(spans("r:-1e-3\n", "3"), ["-1e-3", "r:-1e-3"]);
        // A name that ends in `e` takes no sign, nor does an upper-case `E`.
        assert_eq!(spans("r:ae-3\n", "3"), ["3", "r:ae-3"]);
        assert_eq!(spans("r:ae-3\n", "ae"), ["ae", "r:ae-3"]);
        assert_eq!(spans("r:1E-3\n", "3"), ["3", "r:1E-3"]);
        assert_eq!(spans("r:`1e-3\n", "3"), ["3", "r:`1e-3"]);
    }

    #[test]
    fn a_symbol_grows_with_its_backtick_and_then_its_list() {
        // #2676. KDB-X 5's `-4!` reads `` `a`b `` and `` `:dir/f.q `` as one
        // token each.
        assert_eq!(spans("r:`a`b\n", "a"), ["a", "`a", "`a`b", "r:`a`b"]);
        assert_eq!(spans("r:`a`b\n", "b"), ["b", "`b", "`a`b", "r:`a`b"]);
        assert_eq!(
            spans("r:`:dir/f.q\n", "dir"),
            ["dir", "`:dir/f.q", "r:`:dir/f.q"]
        );
        assert_eq!(
            spans("r:`.p.f[1;2]\n", "p.f"),
            [".p.f", "`.p.f", "r:`.p.f[1;2]"]
        );
        assert_eq!(
            spans("r:enlist[`a]!enlist 1\n", "a]"),
            ["a", "`a", "[`a]", "enlist[`a]", "r:enlist[`a]!enlist 1"]
        );
        // A backtick in a string starts no symbol.
        assert_eq!(spans("r:\"`a`b\"\n", "a"), ["\"`a`b\"", "r:\"`a`b\""]);
    }

    #[test]
    fn a_call_grows_with_a_head_that_is_not_a_plain_name() {
        // #2677.
        assert_eq!(
            spans("r:{x}[1]+{y}[2;3]\n", "3"),
            ["3", "2;3", "[2;3]", "{y}[2;3]", "r:{x}[1]+{y}[2;3]"]
        );
        assert_eq!(
            spans("r:f'[1 2;3 4]\n", "3 4"),
            [
                "3",
                "3 4",
                "1 2;3 4",
                "[1 2;3 4]",
                "f'[1 2;3 4]",
                "r:f'[1 2;3 4]"
            ]
        );
        assert_eq!(
            spans("r:f/[0;1 2]\n", "0"),
            ["0", "0;1 2", "[0;1 2]", "f/[0;1 2]", "r:f/[0;1 2]"]
        );
        assert_eq!(
            spans("r:a f/:\\:[1;2]\n", "1;"),
            ["1", "1;2", "[1;2]", "f/:\\:[1;2]", "r:a f/:\\:[1;2]"]
        );
        assert_eq!(
            spans("r:1+{x+y}/[0;1 2]\n", "0;"),
            [
                "0",
                "0;1 2",
                "[0;1 2]",
                "{x+y}/[0;1 2]",
                "r:1+{x+y}/[0;1 2]"
            ]
        );
        assert_eq!(
            spans("r:1,+/[0;1 2]\n", "0;"),
            ["0", "0;1 2", "[0;1 2]", "+/[0;1 2]", "r:1,+/[0;1 2]"]
        );
        assert_eq!(
            spans("r:$[a>0;b;c]\n", "b;"),
            ["b", "a>0;b;c", "[a>0;b;c]", "$[a>0;b;c]", "r:$[a>0;b;c]"]
        );
        assert_eq!(
            spans("r:x[1][2]\n", "2"),
            ["2", "[2]", "x[1][2]", "r:x[1][2]"]
        );
        assert_eq!(
            spans("r:(f;g)[0][1 2]\n", "1 2"),
            ["1", "1 2", "[1 2]", "(f;g)[0][1 2]", "r:(f;g)[0][1 2]"]
        );
        // A bracket applied to nothing is as before.
        assert_eq!(spans("r: [1;2]\n", "1;"), ["1", "1;2", "[1;2]", "r: [1;2]"]);
    }

    #[test]
    fn unclosed_brackets_leave_the_token_and_the_statement() {
        let source = "f:{[x] g[x;(1;2]}\n";
        assert_eq!(spans(source, "1;"), ["1", "f:{[x] g[x;(1;2]}"]);
    }
}
