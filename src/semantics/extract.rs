//! Extract Function: a selected expression made a lambda of its own, with
//! the parameters and locals of the lambda around it that it reads as its
//! parameters, and the selection a call to it.
//!
//! The rewrite has to mean what the code meant, and q's grammar settles
//! when it does. q reads an expression right to left, so the rest of an
//! expression from any noun to its end - before a `;`, a closing bracket or
//! the end of the statement - is one value: `y*z` in `x+y*z`, `count t` in
//! `n:count t`. So is a single term anywhere: a name, a literal, a bracketed
//! group, each with its indexes, `(a+b)` in `(a+b)*c`. Anything else is
//! refused rather than rewritten: `x+y` in `x+y*z` is no value of that
//! expression at all. So is a selection that assigns (a local assigned in
//! the new lambda would be its own), returns (`:x` would return from it),
//! names `.z.s` (which would be it), or sits inside a qSQL phrase (where a
//! name is a column of a table the new lambda has not got).
//!
//! The new lambda is defined directly above the top-level statement the
//! selection is in, so it is defined under the same `\d`, and before the
//! code that calls it runs. q has no closures, so a nested lambda inside the
//! selection reads nothing from around it, and passes nothing in.
use super::{Scope, scope_at, scopes, top_level_statements};
use crate::{boundary, query_clause};

const NAME: &str = r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*";

/// What Extract Function writes: the trimmed selection `start..end`, which
/// becomes the call, `params` (in the order the lambda around introduces
/// them) and `body`, the new lambda's text after its signature, and
/// `insert_at`, the start of the line the new definition goes above.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Extraction {
    pub start: usize,
    pub end: usize,
    pub params: Vec<String>,
    pub body: String,
    pub insert_at: usize,
}

impl Extraction {
    /// The new lambda's definition, as `name`, and the line break after it.
    pub fn definition(&self, name: &str) -> String {
        format!("{name}:{{[{}] {}}}\n", self.params.join(";"), self.body)
    }

    /// The call that takes the selection's place.
    pub fn call(&self, name: &str) -> String {
        format!("{name}[{}]", self.params.join(";"))
    }
}

/// `base`, or `base` and the first number that makes it, that `source`
/// spells nowhere as a word: a name for the new lambda that neither hides
/// nor is hidden by one already there.
pub fn fresh_name(source: &str, base: &str) -> String {
    let used = |name: &str| {
        re!(r"[A-Za-z0-9_]+")
            .find_iter(source)
            .any(|m| m.as_str() == name)
    };
    let mut name = base.to_string();
    let mut n = 1;
    while used(&name) || crate::is_reserved(&name) {
        n += 1;
        name = format!("{base}{n}");
    }
    name
}

/// q's limit on a lambda's parameters.
const MAX_PARAMS: usize = 8;

/// The extraction of `from..to` of the source, or why it would change what
/// the code means. `code` and `comments` are the views with strings and
/// comments blanked, and comments alone; `raw` the source.
pub fn extract(
    code: &str,
    comments: &str,
    raw: &str,
    from: usize,
    to: usize,
) -> Result<Extraction, String> {
    let (from, to) = (from.min(to), from.max(to).min(raw.len()));
    if !raw.is_char_boundary(from) || !raw.is_char_boundary(to) {
        return Err("the selection does not start and end between characters".into());
    }
    // Trimmed to what is code or a string: blanks, and a comment at either
    // end.
    let selected = &comments[from..to];
    let lead = selected.len() - selected.trim_start().len();
    let trail = selected.len() - selected.trim_end().len();
    if lead + trail >= selected.len() {
        return Err("select an expression to extract".into());
    }
    let (start, end) = (from + lead, to - trail);
    let in_string = |at: usize| code.as_bytes()[at] == b' ' && comments.as_bytes()[at] != b' ';
    let line_of = |at: usize| code[..at].rfind('\n').map_or(0, |p| p + 1);
    if crate::system_command(&raw[line_of(start)..]) {
        return Err("a system command is not an expression".into());
    }
    let text = &code[start..end];
    // Brackets that close inside it, a statement, an assignment, a return.
    let mut depth = 0i32;
    let mut nested = 0i32;
    for (i, b) in text.bytes().enumerate() {
        match b {
            b'(' | b'[' | b'{' => {
                depth += 1;
                if b == b'{' || nested > 0 {
                    nested += 1;
                }
            }
            b')' | b']' | b'}' => {
                depth -= 1;
                if nested > 0 {
                    nested -= 1;
                }
                if depth < 0 {
                    return Err("the selection closes a bracket it does not open".into());
                }
            }
            b';' if depth == 0 => {
                return Err("the selection holds more than one expression".into());
            }
            b':' if nested == 0 && !allowed_colon(text, i) => {
                return Err(
                    "the selection assigns or returns, which the new lambda would do for itself"
                        .into(),
                );
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err("the selection opens a bracket it does not close".into());
    }
    // Only a whole string is a term: one that starts or ends in it was cut.
    let opens = !in_string(start)
        || (raw[start..].starts_with('"') && (start == 0 || !in_string(start - 1)));
    let closes =
        !in_string(end - 1) || (raw[..end].ends_with('"') && (end == raw.len() || !in_string(end)));
    if !opens || !closes {
        return Err("the selection starts or ends inside a string".into());
    }
    if re!(r"\.z\.s\b").is_match(text) {
        return Err(
            "the selection names .z.s, which in the new lambda would be that lambda".into(),
        );
    }
    // Where it starts: a noun, between tokens.
    let first = raw[start..].chars().next().unwrap_or(' ');
    let noun_start = first.is_ascii_alphanumeric()
        || "`\"({".contains(first)
        || (first == '.' && raw[start + 1..].starts_with(|c: char| c.is_ascii_alphanumeric()));
    if !noun_start {
        return Err("the selection starts with an operator: select a whole expression".into());
    }
    let before = raw[..start].chars().next_back();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let cut = before.is_some_and(|c| word(c) && (word(first) || first == '.'))
        || (before == Some('.') && word(first))
        || (first == '`' && before.is_some_and(|c| word(c) || ".`:".contains(c)))
        // `` `a `` is one symbol: `` d:`extracted[a] `` indexes another (#1302).
        || (before == Some('`') && (word(first) || first == '.'));
    if cut {
        return Err("the selection starts inside a name, a number or a symbol".into());
    }
    // A vector literal is one token: `2 3` of `1 2 3` is no value of it.
    let numeric = first.is_ascii_digit()
        || (first == '.' && raw[start + 1..].starts_with(|c: char| c.is_ascii_digit()));
    if numeric
        && raw[..start]
            .trim_end_matches([' ', '\t'])
            .ends_with(|c: char| c.is_ascii_digit())
    {
        return Err("the selection starts inside a list of numbers".into());
    }
    // `x -1` is x applied to -1, and `x -f[]` x minus it.
    if before == Some('-') && numeric {
        return Err("the selection starts inside a negative number".into());
    }
    let after = raw[end..].chars().next();
    let last = raw[..end].chars().next_back().unwrap_or(' ');
    let next = raw[end..].trim_start_matches([' ', '\t']);
    if after.is_some_and(word)
        || (after == Some('.') && raw[end + 1..].starts_with(|c: char| c.is_ascii_alphanumeric()))
        || (after == Some('`') && (word(last) || last == '`'))
    {
        return Err("the selection ends inside a name, a number or a symbol".into());
    }
    let numbers_end =
        last.is_ascii_digit() && !re!(r"[A-Za-z_][A-Za-z0-9_]*$").is_match(&code[start..end]);
    if numbers_end
        && (next.starts_with(|c: char| c.is_ascii_digit()) || re!(r"^-[0-9.]").is_match(next))
        && next.len() < raw.len() - end
    {
        return Err("the selection ends inside a list of numbers".into());
    }
    // An adverb on it, or an assignment to it.
    if matches!(after, Some('\'' | '/' | '\\' | ':')) {
        return Err("the selection is modified or assigned by what follows it".into());
    }
    let (scopes, _) = scopes(code, raw);
    // A lambda starting where the selection does is in it, not around it.
    let around = scope_at(&scopes, start);
    if around.is_some_and(|s| start < scopes[s].body) {
        return Err("the selection is in a lambda's signature".into());
    }
    if query_clause(code, start).is_some() {
        return Err(
            "the selection is inside a qSQL phrase, where a name may be a column of the table"
                .into(),
        );
    }
    // `2 f/l` is `f/[2;l]`: with a value on its left, a term the selection
    // starts with that an adverb modifies takes that value as an argument.
    let adverbed = term_end(code, raw, comments, start, end)
        .is_some_and(|i| code[i..end].starts_with(['\'', '/', '\\']));
    let value_before = raw[..start]
        .trim_end_matches([' ', '\t'])
        .ends_with(|c: char| word(c) || ")]}\"`".contains(c));
    if adverbed && value_before {
        return Err(
            "the selection starts with a term an adverb modifies, which takes the value on its \
             left as an argument"
                .into(),
        );
    }
    let ends_expression = ends_expression(code, raw, end);
    if !ends_expression && !single_term(code, raw, comments, start, end) {
        return Err(
            "the selection is not a value of the expression it is in: q reads right to left, \
             so select a whole term or everything to the end of the expression"
                .into(),
        );
    }
    if !ends_expression && indexed_assignment(code, end) {
        return Err("the selection is assigned at an index by what follows it".into());
    }
    if around.is_none() && !text.contains(|c: char| !c.is_whitespace()) {
        return Err("select an expression to extract".into());
    }
    let params = match around {
        Some(s) => reads(code, &scopes, s, start, end),
        None => vec![],
    };
    if params.len() > MAX_PARAMS {
        return Err(format!(
            "the selection reads {} locals, and a lambda takes at most {MAX_PARAMS} parameters",
            params.len()
        ));
    }
    if params.len() == 1 && raw[start..end] == params[0] {
        return Err("the selection is a single local".into());
    }
    let statements = top_level_statements(code, raw);
    let statement = statements
        .iter()
        .filter(|(at, text)| *at <= start && start <= at + text.len())
        .map(|(at, text)| at + (text.len() - text.trim_start().len()))
        .next_back()
        .unwrap_or(start);
    Ok(Extraction {
        start,
        end,
        params,
        body: raw[start..end].to_string(),
        insert_at: line_of(statement.min(start)),
    })
}

/// Whether the `:` at `i` of `text` is part of an adverb (`\:`, `/:`, `':`)
/// or the identity `::` written as a value, `(::)` or `f[::]`.
fn allowed_colon(text: &str, i: usize) -> bool {
    let b = text.as_bytes();
    if i > 0 && matches!(b[i - 1], b'\\' | b'/' | b'\'') {
        return true;
    }
    let pair = if b.get(i + 1) == Some(&b':') {
        Some(i)
    } else if i > 0 && b[i - 1] == b':' {
        Some(i - 1)
    } else {
        None
    };
    pair.is_some_and(|p| {
        let left = text[..p].trim_end_matches([' ', '\t']);
        let right = text[p + 2..].trim_start_matches([' ', '\t']);
        (left.is_empty() || left.ends_with(['(', '[', ';']))
            && (right.is_empty() || right.starts_with([')', ']', ';']))
    })
}

/// Whether the expression the selection ending at `end` is in ends there:
/// at a `;`, a closing bracket, or the end of the statement.
fn ends_expression(code: &str, raw: &str, end: usize) -> bool {
    let b = code.as_bytes();
    let mut i = end;
    while i < b.len() {
        match b[i] {
            b' ' | b'\t' | b'\r' => i += 1,
            b'\n' => {
                // A line at column 0 starts another statement.
                if !raw[i + 1..].starts_with([' ', '\t']) {
                    return true;
                }
                i += 1;
            }
            b';' | b')' | b']' | b'}' => return true,
            _ => return false,
        }
    }
    true
}

/// Whether `start..end` is one term: a name, a literal - a number or a run
/// of them, a string, a symbol or a run of them - a bracketed group or a
/// lambda, with any indexes after it.
fn single_term(code: &str, raw: &str, comments: &str, start: usize, end: usize) -> bool {
    term_end(code, raw, comments, start, end).is_some_and(|i| code[i..end].trim().is_empty())
}

/// Where the term starting at `start` ends, with its indexes, within
/// `start..end`; `None` where none starts there.
fn term_end(code: &str, raw: &str, comments: &str, start: usize, end: usize) -> Option<usize> {
    let b = raw.as_bytes();
    let in_string = |at: usize| code.as_bytes()[at] == b' ' && comments.as_bytes()[at] != b' ';
    let close = |open: usize| -> Option<usize> {
        let mut depth = 0;
        for (i, &c) in code.as_bytes()[open..end].iter().enumerate() {
            match c {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(open + i + 1);
                    }
                }
                _ => {}
            }
        }
        None
    };
    let mut i = start;
    let numeric = |c: u8| c.is_ascii_alphanumeric() || c == b'.' || c == b':';
    match b[i] {
        b'(' | b'{' => i = close(i)?,
        b'"' => {
            while i < end && (in_string(i) || b[i] == b'"') {
                i += 1;
            }
        }
        b'`' => {
            while i < end
                && (b[i] == b'`' || b[i].is_ascii_alphanumeric() || b"_.:/".contains(&b[i]))
            {
                i += 1;
            }
        }
        c if c.is_ascii_digit() || c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit) => {
            // A vector literal runs on over blanks between numbers.
            loop {
                while i < end && numeric(b[i]) {
                    i += 1;
                }
                let next = raw[i..end].trim_start_matches([' ', '\t']);
                let gap = end - i - next.len();
                if gap > 0
                    && next.starts_with(|c: char| c.is_ascii_digit() || c == '-')
                    && next[usize::from(next.starts_with('-'))..]
                        .starts_with(|c: char| c.is_ascii_digit())
                {
                    i += gap + usize::from(next.starts_with('-'));
                } else {
                    break;
                }
            }
        }
        _ => i += re!(&format!("^{NAME}")).find(&code[i..end])?.end(),
    }
    // Its indexes: `f[x]`, `t[`a][0]`.
    loop {
        let rest = &code[i..end];
        let skipped = rest.len() - rest.trim_start_matches([' ', '\t']).len();
        if code[i + skipped..end].starts_with('[') {
            i = close(i + skipped)?;
        } else {
            break;
        }
    }
    Some(i)
}

/// Whether what follows `end` is `[...]:`, which assigns at an index of the
/// selection.
fn indexed_assignment(code: &str, end: usize) -> bool {
    let rest = code[end..].trim_start_matches([' ', '\t']);
    if !rest.starts_with('[') {
        return false;
    }
    let mut depth = 0;
    for (i, c) in rest.bytes().enumerate() {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    let tail = rest[i + 1..].trim_start_matches([' ', '\t']);
                    return tail.starts_with(':') || tail.starts_with('[');
                }
            }
            _ => {}
        }
    }
    false
}

/// The parameters and locals of the lambda `scopes[s]` that `start..end`
/// reads: never inside a nested lambda,
/// which has its own.
fn reads(code: &str, scopes: &[Scope], s: usize, start: usize, end: usize) -> Vec<String> {
    let unsymbolled = crate::unsymbolled(code);
    let scope = &scopes[s];
    let mut out: Vec<String> = vec![];
    for m in re!(NAME).find_iter(&unsymbolled[start..end]) {
        let at = start + m.start();
        let word = m.as_str();
        if word.contains('.') || !boundary(&unsymbolled, at) || scope_at(scopes, at) != Some(s) {
            continue;
        }
        if (scope.locals.contains(word) || scope.params.contains(word))
            && !out.iter().any(|w| w == word)
        {
            out.push(word.to_string());
        }
    }
    // In the order the lambda around introduces them: its signature's, then
    // its locals'.
    let first = |word: &str| {
        re!(NAME)
            .find_iter(&unsymbolled[scope.start..scope.end.min(unsymbolled.len())])
            .find(|m| m.as_str() == word && boundary(&unsymbolled, scope.start + m.start()))
            .map_or(usize::MAX, |m| m.start())
    };
    out.sort_by_key(|word| first(word));
    out
}
