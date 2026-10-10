//! Narrow contracts for explicit calls with complete, known literal arguments.
//! Unknown expressions and projections are left alone; no input is evaluated.
use crate::{Finding, argument_end, boundary, matching, slots};

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Integer,
    Float,
    Symbol,
    Bool,
    /// A string literal: a char atom with one character, a vector otherwise.
    Char,
    /// `0x` and hex digits, two per item; an atom with exactly two.
    Byte,
}
struct Literal {
    kind: Kind,
    vector: bool,
    len: usize,
    negative: bool,
    short_integer: bool,
}
fn literal(s: &str) -> Option<Literal> {
    let s = s.trim();
    if s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len()) {
        return literal(&s[1..s.len() - 1]);
    }
    if let Some(rest) = s.strip_prefix("enlist ") {
        let mut value = literal(rest)?;
        if value.vector {
            return None;
        } // Nested lists are not flat literals.
        value.vector = true;
        value.len = 1;
        return Some(value);
    }
    if re!(r"^(?:`[A-Za-z][A-Za-z0-9_.]*)+$").is_match(s) {
        return Some(Literal {
            kind: Kind::Symbol,
            vector: s.bytes().filter(|&b| b == b'`').count() > 1,
            len: s.bytes().filter(|&b| b == b'`').count(),
            negative: false,
            short_integer: false,
        });
    }
    // Read from `comments`, where a string is still text. Its length counts
    // an escape as the one character it stands for.
    if let Some(body) = re!(r#"^"((?:\\[0-7]{3}|\\.|[^"\\])*)"$"#).captures(s) {
        let len = re!(r"\\[0-7]{3}|\\.|[^\\]").find_iter(&body[1]).count();
        return Some(Literal {
            kind: Kind::Char,
            vector: len != 1,
            len,
            negative: false,
            short_integer: false,
        });
    }
    if let Some(hex) = s.strip_prefix("0x")
        && hex.len() % 2 == 0
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Some(Literal {
            kind: Kind::Byte,
            vector: hex.len() != 2,
            len: hex.len() / 2,
            negative: false,
            short_integer: false,
        });
    }
    if re!(r"^[01]+b$").is_match(s) {
        return Some(Literal {
            kind: Kind::Bool,
            vector: s.len() > 2,
            len: s.len() - 1,
            negative: false,
            short_integer: false,
        });
    }
    if re!(r"^-?\d+(?:\s+-?\d+)*[hij]?$").is_match(s) {
        // Values outside the host integer range stay unknown, not truncated.
        let numbers = s
            .trim_end_matches(['h', 'i', 'j'])
            .split_whitespace()
            .map(str::parse::<i64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        return Some(Literal {
            kind: Kind::Integer,
            vector: numbers.len() > 1,
            len: numbers.len(),
            negative: numbers.iter().any(|&v| v < 0),
            short_integer: s.ends_with(['h', 'i']),
        });
    }
    let float = re!(
        r"^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:\s+-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)*[ef]?$"
    );
    if float.is_match(s) && (s.contains(['.', 'e', 'E']) || s.ends_with('f')) {
        return Some(Literal {
            kind: Kind::Float,
            vector: s.split_whitespace().count() > 1,
            len: s.split_whitespace().count(),
            negative: false,
            short_integer: false,
        });
    }
    None
}

/// A call to one of the checked builtins: where it starts, which builtin,
/// and its argument text - the same shape whether it was written `til[1.5]`
/// or `til 1.5`, so the rules below never learn which spelling they saw.
struct Call<'a> {
    at: usize,
    name: &'a str,
    args: Vec<&'a str>,
}

const BUILTINS: &str = r"til|where|sum|prd|avg|med|dev|var|sums|prds|deltas|ratios|asc|desc|iasc|idesc|distinct|flip|rotate|count|first|last|enlist|reverse|abs|neg|sqrt|log|exp|sin|cos|tan|acos|asin|atan|reciprocal|mavg|msum|mcount|mdev|mmin|mmax|cor|cov|wavg|wsum|within|string|key|value|type|not|null|min|max|floor|ceiling|signum|group|cols|keys|meta|fills|next|upper|lower|trim|ltrim|rtrim|show|hcount|hclose|hopen|get|inv|attr|parse|eval|system|any|all|sdev|svar|avgs|maxs|mins";

/// Every complete call to a checked builtin, in either spelling.
///
/// q writes a unary call two ways and they are the same call: `til[1.5]` and
/// `til 1.5` both raise 'type. Real q uses the second about 150 times as
/// often as the first, so a rule that only reads brackets checks the spelling
/// nobody writes.
///
/// Arguments are split in the masked view and then read from `comments`,
/// which keeps strings whole: a `;` inside a string is not a separator.
fn calls<'a>(code: &'a str, comments: &'a str, raw: &'a str) -> Vec<Call<'a>> {
    let mut out = vec![];
    // Bracket form: `name[a;b]`.
    for call in re!(&format!(r"\b({BUILTINS})\s*\[")).captures_iter(code) {
        let at = call.get(0).unwrap().start();
        if !boundary(code, at) || re!(r"\n\S").is_match(call.get(0).unwrap().as_str()) {
            continue;
        }
        let open = call.get(0).unwrap().end() - 1;
        let Some(end) = matching(code, open, b'[', b']') else {
            continue;
        };
        let mut arg_start = open + 1;
        let args: Vec<_> = slots(&code[open + 1..end - 1])
            .into_iter()
            .map(|slot| {
                let raw = &comments[arg_start..arg_start + slot.len()];
                arg_start += slot.len() + 1;
                raw
            })
            .collect();
        // Omitted slots are projections rather than complete applications.
        if args.iter().any(|arg| arg.trim().is_empty()) {
            continue;
        }
        out.push(Call {
            at,
            name: call.get(1).unwrap().as_str(),
            args,
        });
    }
    // Juxtaposed form: `name arg`, one argument, running to the end of the
    // expression. Only a literal argument is worth collecting - the rules can
    // say nothing about a name - so the argument is taken as far as the
    // literal extends: digits, dots, a type suffix, backtick symbols, spaces
    // between vector items, or one quoted string.
    //
    // Matched in `comments`, not `code`: a string is blanks in `code`, so
    // `til "3"` would never be seen there. A comment is blank in both, and
    // `code` still has to hold the builtin's own name at that offset, which
    // proves the match is not the inside of a string.
    for call in re!(&format!(
        r#"\b({BUILTINS})[ \t]+((?:-?\d[A-Za-z0-9.:]*(?:[ \t]+-?\d[A-Za-z0-9.:]*)*)|(?:`[A-Za-z0-9_.]*)+|"(?:\\.|[^"\\])*")"#
    ))
    .captures_iter(comments)
    {
        let whole = call.get(0).unwrap();
        let name = call.get(1).unwrap();
        if !boundary(code, whole.start()) || code.get(name.range()) != Some(name.as_str()) {
            continue;
        }
        // The literal has to be the whole argument. `til 1.5 * x` is not a
        // call on 1.5 - q reads right to left - and `sum 1 2 3,x` is a call
        // on a join. Anything that continues the expression disqualifies it.
        let rest = code[whole.end()..].trim_start_matches([' ', '\t']);
        if !(rest.is_empty() || rest.starts_with([';', ')', ']', '}', '\n', '\r', '/'])) {
            continue;
        }
        let arg = call.get(2).unwrap();
        out.push(Call {
            at: whole.start(),
            name: call.get(1).unwrap().as_str(),
            args: vec![&comments[arg.start()..arg.end()]],
        });
    }
    // Applied with `@`: `til@2.5` and `@[til;2.5]` are the call `til 2.5`,
    // and 'type alike (q 5). Two slots only - `@[til;2.5;{x}]` is a protected
    // call whose handler catches the error. A dyadic builtin under `@` is a
    // projection, which the argument count in `check` already passes over.
    const LITERAL: &str = r#"(?:-?\d[A-Za-z0-9.:]*(?:[ \t]+-?\d[A-Za-z0-9.:]*)*)|(?:`[A-Za-z0-9_.]*)+|"(?:\\.|[^"\\])*""#;
    for (pattern, name_group, arg_group) in [
        (format!(r"\b({BUILTINS})[ \t]*@[ \t]*({LITERAL})"), 1, 2),
        (
            format!(r"@\[[ \t]*({BUILTINS})[ \t]*;[ \t]*({LITERAL})[ \t]*\]"),
            1,
            2,
        ),
    ] {
        for call in regex::Regex::new(&pattern).unwrap().captures_iter(comments) {
            let whole = call.get(0).unwrap();
            let name = call.get(name_group).unwrap();
            if !boundary(code, whole.start()) || code.get(name.range()) != Some(name.as_str()) {
                continue;
            }
            let rest = code[whole.end()..].trim_start_matches([' ', '\t']);
            if !(rest.is_empty() || rest.starts_with([';', ')', ']', '}', '\n', '\r'])) {
                continue;
            }
            let arg = call.get(arg_group).unwrap();
            out.push(Call {
                at: whole.start(),
                name: name.as_str(),
                args: vec![&comments[arg.start()..arg.end()]],
            });
        }
    }
    // Infix form: `left name right`, the way the dyadic builtins are almost
    // always written - `2 mavg x`, `x within 1 2`. The left operand is the
    // noun just before the name: q confirms `a 2 mavg x` is `a[2 mavg x]`,
    // so a name before the literal does not change which value it is. When
    // that noun is not a literal it is passed as unknown, since `within`
    // only needs its right operand to be one. The right operand runs to the
    // end of the expression, as a juxtaposed argument does.
    for m in re!(r"\b(rotate|mavg|msum|mcount|mdev|mmin|mmax|cor|cov|wavg|wsum|within)\b")
        .find_iter(comments)
    {
        if !boundary(code, m.start()) || code.get(m.range()) != Some(m.as_str()) {
            continue;
        }
        let before = comments[..m.start()].trim_end_matches([' ', '\t']);
        // Something has to be on the left, or this is the prefix form.
        if before.len() == m.start()
            || !before.ends_with(|c: char| c.is_alphanumeric() || "_.`\")]}".contains(c))
        {
            continue;
        }
        let rest = &comments[m.end()..];
        let from = m.end() + (rest.len() - rest.trim_start_matches([' ', '\t']).len());
        if from == m.end() || comments[from..].starts_with(['[', ';', '\n', '\r', ')', ']', '}']) {
            continue;
        }
        let Some(end) = argument_end(code, comments, raw, from) else {
            continue;
        };
        // The leftmost match that reaches the name is not always the
        // operand: in `r2:3.5 rotate x` it starts at the `2` of `r2`, since
        // a time literal lets `:` inside one. So the search moves right past
        // any candidate that does not start on a token boundary.
        let mut left = "";
        let mut from_at = 0;
        while let Some(l) = re!(
            r#"(?:-?\d[A-Za-z0-9.:]*(?:[ \t]+-?\d[A-Za-z0-9.:]*)*|(?:`[A-Za-z0-9_.]*)+|"(?:\\.|[^"\\])*"|\([^()]*\))$"#
        )
        .find_at(before, from_at)
        {
            if boundary(code, l.start()) {
                left = l.as_str();
                break;
            }
            from_at = l.start() + 1;
        }
        let start = before.len() - left.len();
        out.push(Call {
            at: if left.is_empty() { m.start() } else { start },
            name: m.as_str(),
            args: vec![left, &comments[from..end]],
        });
    }
    out
}

pub fn check(path: &str, source: &str, code: &str, comments: &str) -> Vec<Finding> {
    let mut out = vec![];
    for Call { at, name, args } in calls(code, comments, source) {
        let args = &args;
        let arity = match name {
            "rotate" | "mavg" | "msum" | "mcount" | "mdev" | "mmin" | "mmax" | "cor" | "cov"
            | "wavg" | "wsum" | "within" => 2,
            _ => 1,
        };
        let report = |out: &mut Vec<Finding>, id, detail| {
            out.push(Finding::at(path, source, at, id, detail))
        };
        let max_arity = match name {
            "enlist" => usize::MAX,
            "sums" | "prds" | "deltas" | "ratios" => 2,
            _ => arity,
        };
        if args.len() > max_arity {
            report(
                &mut out,
                "QA010",
                format!(
                    "{name} accepts at most {max_arity} argument(s), but this complete call supplies {}",
                    args.len()
                ),
            );
            continue;
        }
        if args.len() != arity {
            continue;
        }
        if name == "within" {
            if let Some(bounds) = literal(args[1])
                && (!bounds.vector || bounds.len != 2)
            {
                report(
                    &mut out,
                    "QT019",
                    "within needs a two-item list of bounds".into(),
                );
            }
            continue;
        }
        if matches!(name, "cor" | "cov" | "wavg" | "wsum") {
            if let (Some(left), Some(right)) = (literal(args[0]), literal(args[1]))
                && left.kind != Kind::Symbol
                && right.kind != Kind::Symbol
                && (matches!(name, "cor" | "cov") || (left.vector && right.vector))
                && left.len != right.len
            {
                report(
                    &mut out,
                    "QT018",
                    format!(
                        "{name} receives literal inputs of lengths {} and {}",
                        left.len, right.len
                    ),
                );
            }
            continue;
        }
        let Some(value) = literal(args[0]) else {
            continue;
        };
        let rule = match name {
            "sqrt" | "log" | "exp" | "abs" | "neg" | "sin" | "cos" | "tan" | "acos" | "asin"
            | "atan" | "reciprocal"
                if value.kind == Kind::Symbol =>
            {
                Some(("QT016", "Numeric math cannot operate on a symbol literal"))
            }
            "mavg" | "msum" | "mcount" | "mdev" | "mmin" | "mmax"
                if value.vector
                    || matches!(value.kind, Kind::Float | Kind::Symbol | Kind::Char) =>
            {
                Some(("QT017", "Moving-window size must be an integer atom"))
            }

            // A symbol atom runs - `til` is `key` there and lists a
            // namespace - and so does a byte atom. Any vector, a string of
            // any length and a float are 'type.
            "til" if value.vector || matches!(value.kind, Kind::Float | Kind::Char) => {
                Some(("QT008", "til needs an integer atom, not this literal"))
            }
            "til" if value.kind == Kind::Integer && value.negative => {
                Some(("QD001", "til cannot generate a negative number of indices"))
            }
            // `where ""` is the one string q accepts: there is nothing in it.
            "where"
                if matches!(value.kind, Kind::Float | Kind::Symbol | Kind::Byte)
                    || (value.kind == Kind::Char && value.len > 0)
                    || value.short_integer =>
            {
                Some(("QT009", "where requires boolean or long counts"))
            }
            "where" if value.negative => Some((
                "QD002",
                "where cannot repeat an index a negative number of times",
            )),
            // These four take a symbol atom - `max `a` is `a - and any
            // string, but not a symbol vector: `max `a`b` is 'type (q 5).
            "max" | "min" | "maxs" | "mins" if value.kind == Kind::Symbol && value.vector => {
                Some((
                    "QT010",
                    "This numeric aggregate or scan rejects this literal",
                ))
            }
            "sum" | "prd" | "avg" | "med" | "dev" | "var" | "sums" | "prds" | "deltas"
            | "ratios"
                if (value.kind == Kind::Symbol
                    && (value.vector || matches!(name, "avg" | "med" | "dev" | "var")))
                    // A string is numeric to `sum`, `avg` and `ratios`, and
                    // not to these four.
                    || (value.kind == Kind::Char
                        && value.vector
                        && matches!(name, "prd" | "sums" | "prds" | "deltas")) =>
            {
                Some((
                    "QT010",
                    "This numeric aggregate or scan rejects this literal",
                ))
            }
            "asc" | "desc" | "iasc" | "idesc" if !value.vector => Some((
                "QT011",
                "Sorting requires a list rather than a literal atom",
            )),
            "distinct" if !value.vector => Some((
                "QT012",
                "distinct requires a list rather than a literal atom",
            )),
            "flip" if value.kind != Kind::Symbol => {
                Some(("QT013", "flip cannot transpose an atom or a flat vector"))
            }
            "rotate"
                if value.vector
                    || matches!(value.kind, Kind::Float | Kind::Symbol | Kind::Char) =>
            {
                Some(("QT014", "rotate requires an integer atom for its count"))
            }
            _ => None,
        };
        if let Some((id, detail)) = rule {
            report(&mut out, id, format!("{name}: {detail}"));
        }
    }
    out
}
