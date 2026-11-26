//! What an editor shows while a line is being read or written: the
//! parameters a function takes and the comment above it, which call the
//! cursor is in, and what is being typed.
//!
//! As in navigation, nothing here resolves a value. A function's parameters
//! are the ones its definition spells, a call is the name written before an
//! open bracket, and a completion is a name the source already holds: all of
//! it read from the text, and none of it from running the script.
use super::{Scope, scope_around, scopes};
use crate::{Applied, BracketCall, Call, Completing, boundary, ends_in_name, matching, signature};

const NAME: &str = r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*";
/// How many lines of comment above a definition are its description. A
/// licence header over a file's first function is not one.
const MAX_COMMENT: usize = 40;

/// The parameters of what is assigned at `brace`, a lambda, as whoever calls
/// the name sees them: the signature's slots as written, or - with no
/// signature - x, y and z as far as the body reads them, which is how q
/// counts them (`{x+z}` takes three, and `{1}` takes `x`). A projection
/// takes what it leaves open: `{[g;n] ...}[;7]` takes `g`, and
/// `{[a;b] a+b}[1]` takes `b`.
pub(super) fn parameters(code: &str, raw: &str, scopes: &[Scope], brace: usize) -> Vec<String> {
    let sig = signature(code, raw, brace);
    let params: Vec<String> = if sig.named {
        match sig.slots.as_slice() {
            // `{[] ...}` names none, though q still takes one argument.
            [only] if only.trim().is_empty() => vec![],
            slots => slots.iter().map(|slot| slot.trim().to_string()).collect(),
        }
    } else {
        // A column name is no read: not in a query's phrases, nor before
        // the `:` of a table literal's column (KDB-X: `{select z from x}`
        // and `{([]z:x)}` take one argument).
        // Scopes are in order of their `{`, as `scope_at` reads them: a
        // search, where a walk of them all for each lambda was quadratic
        // in a file of lambdas (#2348).
        let direct = scopes
            .get(scopes.partition_point(|scope| scope.start < brace))
            .filter(|scope| scope.start == brace)
            .map_or(String::new(), |scope| {
                crate::table_columns_blanked(&super::with_from_clauses(&scope.direct, false))
            });
        let direct = direct.as_str();
        let reads = |name: &str| {
            re!(NAME)
                .find_iter(direct)
                .any(|m| m.as_str() == name && boundary(direct, m.start()))
        };
        // A lambda that reads none of them takes `x` all the same: KDB-X 5
        // gives `(value {1})1` as `,`x`, and `{1}[]` is a call (#2949).
        let taken = if reads("z") {
            3
        } else if reads("y") {
            2
        } else {
            1
        };
        ["x", "y", "z"][..taken]
            .iter()
            .map(|name| name.to_string())
            .collect()
    };
    left_open(code, brace, params)
}

/// Of `params`, the parameters of the lambda at `brace`, the ones what is
/// written after it leaves for a caller: all of them, or what a projection
/// or a first argument put beside it does not fill.
pub(super) fn left_open(code: &str, brace: usize, params: Vec<String>) -> Vec<String> {
    let Some(end) = matching(code, brace, b'{', b'}') else {
        return params;
    };
    if code[end..].starts_with('[') {
        let Some(close) = matching(code, end, b'[', b']') else {
            return params;
        };
        let given = crate::slots(&code[end + 1..close - 1]);
        return params
            .into_iter()
            .enumerate()
            .filter(|(i, _)| given.get(*i).is_none_or(|slot| slot.trim().is_empty()))
            .map(|(_, param)| param)
            .collect();
    }
    // Juxtaposition gives the first argument: `{x+y} 1` takes `y`.
    let after = code[end..].trim_start_matches([' ', '\t']);
    if !(after.is_empty() || after.starts_with([';', '\n', '\r', ')', ']', '}'])) {
        return params.into_iter().skip(1).collect();
    }
    params
}

/// The comment directly above the statement at `at`: the `/` lines over it
/// with no blank line between, and a `/` ... `\` block ending there, without
/// their markers. Empty when the line above is code or blank.
///
/// `comments` is the view that keeps a string and blanks a comment: a line
/// of a string that runs over lines may start with `/` and is no comment.
pub fn comment_above(comments: &str, raw: &str, at: usize) -> String {
    let Some(before) = raw.get(..at) else {
        return String::new();
    };
    let mut end = before.rfind('\n').map_or(0, |p| p + 1);
    let mut lines: Vec<&str> = vec![];
    let mut block = false;
    while end > 0 && lines.len() < MAX_COMMENT {
        let start = raw[..end - 1].rfind('\n').map_or(0, |p| p + 1);
        let text = raw[start..end].trim();
        if block {
            if text == "/" {
                block = false;
            } else {
                lines.push(raw[start..end].trim_end());
            }
        } else if text.is_empty() || !comments[start..end].trim().is_empty() {
            break;
        } else if text == "\\" {
            block = true;
        } else if text != "/" && text.starts_with('/') {
            let said = text.trim_start_matches('/');
            lines.push(said.strip_prefix(' ').unwrap_or(said));
        } else {
            break;
        }
        end = start;
    }
    lines.reverse();
    lines.join("\n").trim_matches('\n').to_string()
}

/// What the assignment of the name ending at `end` assigns, when it is
/// another name or a projection of one and the statement ends there:
/// `al:add`, `pr:add[;2;]`, `g::f[1]`. Anything after it - `add+1`,
/// `add 1`, `x:y:add` - and it is a value this does not read.
pub fn applied(code: &str, raw: &str, end: usize) -> Option<Applied> {
    let blank = |s: &str| s.trim_start_matches([' ', '\t']).len();
    let rest = &code[code.len() - blank(code.get(end..)?)..];
    let rest = rest.strip_prefix("::").or_else(|| rest.strip_prefix(':'))?;
    let at = code.len() - blank(rest);
    let len = re!(&format!("^{NAME}")).find(&code[at..])?.end();
    let mut after = at + len;
    let mut given = None;
    let open = code.len() - blank(&code[after..]);
    if code[open..].starts_with('[') {
        let close = matching(code, open, b'[', b']')?;
        // Cut where the code view says, and read in the source, where a
        // string is not blank.
        let mut start = open + 1;
        given = Some(
            crate::slots(&code[start..close - 1])
                .iter()
                .map(|slot| {
                    let filled = !raw[start..start + slot.len()].trim().is_empty();
                    start += slot.len() + 1;
                    filled
                })
                .collect(),
        );
        after = close;
    }
    if super::argument_follows(code, raw, after) {
        return None;
    }
    let tail = &code[code.len() - blank(&code[after..])..];
    (tail.is_empty() || tail.starts_with([';', '\n', '\r', ')', ']', '}'])).then_some(Applied {
        at,
        len,
        given,
    })
}

/// The glyphs q reads as an operator or an iterator, and of them the ones
/// written as two characters.
const GLYPHS: &[u8] = b"+-*%&|^=<>~!#_$?@.,:'/\\";
const PAIRS: [&str; 7] = ["<=", ">=", "<>", "::", "':", "/:", "\\:"];

/// The glyph at `offset`, as where it starts and how long it is. Not one
/// that is part of something else: the `.` of a name or a number, the `_`
/// of a name, the `-` of a negative number, the `:` of `0:`, or anything
/// in a string, a comment, a symbol or a system command.
pub fn glyph_at(code: &str, raw: &str, offset: usize) -> Option<(usize, usize)> {
    let line = code.get(..offset)?.rfind('\n').map_or(0, |p| p + 1);
    // A timed line's `\t`, `\ts` or `\t:n` is a command too, though what
    // follows it is q: its backslash is no Scan (#2247).
    if crate::system_command(&raw[line..]) || offset < line + crate::timed_prefix(&raw[line..]) {
        return None;
    }
    let code = crate::unsymbolled(code);
    let bytes = code.as_bytes();
    if !bytes.get(offset).is_some_and(|b| GLYPHS.contains(b)) {
        return None;
    }
    let (at, len) = [offset.checked_sub(1), Some(offset)]
        .into_iter()
        .flatten()
        .find(|&start| {
            code.get(start..start + 2)
                .is_some_and(|pair| PAIRS.contains(&pair))
        })
        .map_or((offset, 1), |start| (start, 2));
    let before = bytes[..at].last().copied().unwrap_or(b' ');
    let after = bytes.get(at + len).copied().unwrap_or(b' ');
    let part_of = match &code[at..at + len] {
        "." => after.is_ascii_alphanumeric() || before.is_ascii_alphanumeric(),
        "_" => ends_in_name(&code[..at]),
        // `x-1` subtracts, and `x -1` and `(-1` are a number.
        "-" => {
            after.is_ascii_digit() && !(before.is_ascii_alphanumeric() || b")]}_".contains(&before))
        }
        ":" => before.is_ascii_digit() && !ends_in_name(&code[..at]),
        _ => false,
    };
    (!part_of).then_some((at, len))
}

/// Where the blanks before `at` begin: the spaces and tabs before it, and
/// the line ends before those when `at` is on an indented line, which goes
/// on with the statement of the line above. KDB-X 5 runs `r:f` and then
/// `  [1;2]` as `r:f[1;2]`, over a blank line or a comment's between them
/// too, and at a line end in a lambda (#2966).
fn before_blanks(code: &str, at: usize) -> usize {
    let same = code[..at].trim_end_matches([' ', '\t']).len();
    if same < at && code[..same].ends_with('\n') {
        code[..same].trim_end().len()
    } else {
        same
    }
}

/// Where the blanks after `at` end, as `before_blanks` reads them: on the
/// line, or on an indented line after it.
fn after_blanks(code: &str, at: usize) -> usize {
    let same = code.len() - code[at..].trim_start_matches([' ', '\t']).len();
    let next = code.len() - code[at..].trim_start().len();
    if code[same..].starts_with(['\r', '\n']) && code[..next].ends_with([' ', '\t']) {
        next
    } else {
        same
    }
}

/// The bracketed call the cursor at `offset` is in, when what is called is
/// written as a name: the innermost open `[`, and how many `;` of its own
/// lie between it and the cursor. A space or a tab may part the name from
/// its bracket: q 5 reads `f [1;2;3]` as `f[1;2;3]` wherever it is written,
/// and so may the end of a line whose next is indented. A parenthesis starts the count again,
/// since `f[a;(b;c` is still in the second argument; a brace ends the
/// search, since inside `f[a;{x+` what is being written is a lambda's body.
/// In a comment nothing is being called, whatever brackets are open above.
pub fn call_at(code: &str, comments: &str, raw: &str, offset: usize) -> Option<Call> {
    if commented(comments, raw, offset) {
        return None;
    }
    let bytes = code.as_bytes();
    let (mut depth, mut argument) = (0usize, 0usize);
    let mut i = offset.min(bytes.len());
    while i > 0 {
        i -= 1;
        match bytes[i] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b'(' => argument = 0,
            b'{' => return None,
            b'[' => {
                let end = before_blanks(code, i);
                let mut start = end;
                while start > 0
                    && (bytes[start - 1].is_ascii_alphanumeric()
                        || b"_.".contains(&bytes[start - 1]))
                {
                    start -= 1;
                }
                // The name is as much of that as starts one: the `_` of
                // `2_f[`, `n _f[` and `-1_f[` is Drop, and `f` is called
                // (KDB-X 5: `2_f[til 5;0]` is `2 3 4` for an `f` that gives
                // back its first argument, #2951).
                let start = (start..end).find(|&from| {
                    re!(&format!("^{NAME}$")).is_match(&code[from..end]) && boundary(code, from)
                })?;
                return Some(Call {
                    at: start,
                    len: end - start,
                    argument,
                });
            }
            b';' if depth == 0 => argument += 1,
            // A line at column 0 starts a statement, and no bracket of the
            // one before is open in it. A lone `}` there closes a lambda.
            b'\n' if bytes.get(i + 1).is_some_and(|b| !b" \t\r\n}".contains(b)) => {
                return None;
            }
            _ => {}
        }
    }
    None
}

/// The name at byte `offset`, as where it starts and how long it is -
/// whatever it names, a keyword included, which `name_at` passes over.
/// Nothing in a string, a comment, a symbol or a system command.
pub fn word_at(code: &str, raw: &str, offset: usize) -> Option<(usize, usize)> {
    let line = code.get(..offset)?.rfind('\n').map_or(0, |p| p + 1);
    if crate::system_command(&raw[line..]) {
        return None;
    }
    let unsymbolled = crate::unsymbolled(code);
    re!(NAME)
        .find_iter(&unsymbolled)
        .take_while(|m| m.start() <= offset)
        .find(|m| offset <= m.end() && boundary(&unsymbolled, m.start()))
        .map(|m| (m.start(), m.len()))
}

/// Whether `offset` is in a comment. One runs to the end of its line, so
/// the cursor is in it when the last thing written before it on the line is
/// blank in `comments`, the view that keeps all but comments. So is a line
/// of a block comment and of another language. Not a `q)` prompt, which
/// that view blanks too.
fn commented(comments: &str, raw: &str, offset: usize) -> bool {
    let Some(before) = raw.get(..offset) else {
        return false;
    };
    let line = before.rfind('\n').map_or(0, |p| p + 1);
    let prompt = if before[line..].starts_with("q)") {
        2
    } else {
        0
    };
    before[line + prompt..]
        .rfind(|c: char| !c.is_whitespace())
        .is_some_and(|last| comments.as_bytes()[line + prompt + last] == b' ')
}

/// What is being typed at `offset`, when it is - or may become - a name:
/// where it starts, the locals of the lambda around it, and the `\d` in
/// force. `None` in a string, a comment, a symbol, a number or a system
/// command, where no name is written.
pub fn completing(
    code: &str,
    comments: &str,
    string_starts: &[usize],
    raw: &str,
    offset: usize,
) -> Option<Completing> {
    let before = raw.get(..offset)?;
    let line = before.rfind('\n').map_or(0, |p| p + 1);
    if crate::system_command(&raw[line..]) || commented(comments, raw, offset) {
        return None;
    }
    // A string runs on over lines: the last one opened is closed, or the
    // cursor is in it.
    if let Some(&open) = string_starts.get(
        string_starts
            .partition_point(|&start| start < offset)
            .wrapping_sub(1),
    ) {
        let bytes = raw.as_bytes();
        let (mut i, mut closed) = (open + 1, false);
        while i < offset {
            match bytes[i] {
                b'\\' => i += 1,
                b'"' => {
                    closed = true;
                    break;
                }
                _ => {}
            }
            i += 1;
        }
        if !closed {
            return None;
        }
    }
    let part = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'.';
    let mut start = offset;
    while start > line && part(raw.as_bytes()[start - 1]) {
        start -= 1;
    }
    // Inside a symbol, which runs on over `:` and, once it has one, over
    // `/`: KDB-X 5 reads `` `:lib/ut `` and `` `a.b_c:x/pa `` as one symbol
    // each, and `` `a/pa `` as `/` over a symbol (#2020).
    let in_symbol = raw[line..offset].rfind('`').is_some_and(|tick| {
        let mut colon = false;
        raw[line + tick + 1..offset].bytes().all(|b| {
            colon |= b == b':';
            part(b) || b == b':' || (b == b'/' && colon)
        })
    });
    if raw[start..offset].starts_with(|c: char| c.is_ascii_digit())
        || in_symbol
        || (start < offset && !boundary(code, start))
    {
        return None;
    }
    let (scopes, namespaces) = scopes(code, raw);
    // The lambda around the gap the typing starts at, which a lambda's
    // closing brace right after the cursor does not end; one still open
    // at the end of the file runs to it.
    let mut locals: Vec<String> = scope_around(&scopes, start)
        .map(|s| scopes[s].locals.iter().cloned().collect())
        .unwrap_or_default();
    locals.sort_unstable();
    let namespace = namespaces
        .get(
            namespaces
                .partition_point(|(p, _)| *p <= start)
                .saturating_sub(1),
        )
        .map(|(_, namespace)| namespace.clone())
        .unwrap_or_default();
    Some(Completing {
        start,
        locals,
        namespace,
    })
}

/// Every call written as a name and its brackets, `f[a;b]` or `f [a;b]` -
/// the brackets on an indented line after the name's too - with where each
/// argument starts and how long it is, its blanks trimmed:
/// an empty slot, as in a projection, has no length. Nothing in a string, a
/// comment or a system command, which the code view blanks.
pub fn bracket_calls(code: &str) -> Vec<BracketCall> {
    bracket_calls_in(code, code)
}

/// `bracket_calls`, with each argument trimmed of the blanks around it in
/// `shown` - a view of the same text with more of it kept, such as its
/// strings, so a string argument is its quotes and not a blank.
pub fn bracket_calls_in(code: &str, shown: &str) -> Vec<BracketCall> {
    let mut out = vec![];
    for m in re!(NAME).find_iter(code) {
        if !boundary(code, m.start()) {
            continue;
        }
        let open = after_blanks(code, m.end());
        if code.as_bytes().get(open) != Some(&b'[') {
            continue;
        }
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let inside = &code[open + 1..close - 1];
        let arguments = crate::slots(inside)
            .into_iter()
            .map(|slot| {
                let start = slot.as_ptr() as usize - code.as_ptr() as usize;
                let slot = &shown[start..start + slot.len()];
                let trimmed = slot.trim_start();
                let lead = slot.len() - trimmed.len();
                (start + lead, trimmed.trim_end().len())
            })
            .collect();
        out.push(BracketCall {
            at: m.start(),
            len: m.len(),
            arguments,
        });
    }
    out
}
