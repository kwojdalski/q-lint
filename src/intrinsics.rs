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
    /// A date, month, time, timespan, timestamp or datetime, unsuffixed.
    Temporal,
}
struct Literal {
    kind: Kind,
    vector: bool,
    len: usize,
    negative: bool,
    short_integer: bool,
    /// An integer null atom: `0N`, `0Nh`, `0Ni`, `0Nj`.
    integer_null: bool,
}
fn literal(s: &str) -> Option<Literal> {
    let mut s = s.trim();
    // Stripped in a loop, as deep as q parses: one call per level overflows
    // the stack (#703).
    for depth in 0.. {
        if !(s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len())) {
            break;
        }
        if depth == crate::MAX_NESTING {
            return None;
        }
        s = s[1..s.len() - 1].trim();
    }
    // Any blank parts `enlist` from its argument; q 5 reads a tab as a space,
    // and a line break inside the brackets an argument sits in too (#690).
    if let Some(rest) = s
        .strip_prefix("enlist")
        .filter(|r| r.starts_with([' ', '\t', '\r', '\n']))
    {
        let mut value = literal(rest)?;
        if value.vector {
            return None;
        } // Nested lists are not flat literals.
        value.vector = true;
        value.len = 1;
        return Some(value);
    }
    // The null symbol too, a lone backtick: q 5 `asc `` ` `` is 'rank. And a
    // name starting with `.` or holding `:`, `` `.a `` and `` `a:b `` (#600).
    if re!(r"^(?:`(?:\.?[A-Za-z][A-Za-z0-9_.:]*)?)+$").is_match(s) {
        return Some(Literal {
            kind: Kind::Symbol,
            vector: s.bytes().filter(|&b| b == b'`').count() > 1,
            len: s.bytes().filter(|&b| b == b'`').count(),
            negative: false,
            short_integer: false,
            integer_null: false,
        });
    }
    // Read from `comments`, where a string is still text. Its length is
    // q's, in bytes, with an escape the one byte it stands for.
    if let Some(body) = re!(r#"^"((?:\\[0-7]{3}|\\.|[^"\\])*)"$"#).captures(s) {
        let len = crate::q_bytes(&body[1]).len();
        return Some(Literal {
            kind: Kind::Char,
            vector: len != 1,
            len,
            negative: false,
            short_integer: false,
            integer_null: false,
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
            integer_null: false,
        });
    }
    if re!(r"^[01]+b$").is_match(s) {
        return Some(Literal {
            kind: Kind::Bool,
            vector: s.len() > 2,
            len: s.len() - 1,
            negative: false,
            short_integer: false,
            integer_null: false,
        });
    }
    // A null or an infinity atom: the integer ones are integers and the
    // float ones floats (q 5: `asc 0N` and `iasc 0w` are 'rank, `til 0n`
    // 'type, #616). A type letter after `0N` or `0W` gives the real, float
    // or temporal one: `0Ne`, `0Wf`, `0Nd`, `0Wp`, `0Nm` ... `0Nt` (q 5:
    // `asc 0Nd` is 'rank, `til 0Ne` and `distinct 0Nd` 'type, #2243).
    if let Some(m) = re!(r"^(-)?0(?:[NW]([hijefpmdznuvt])?|([nw])[ef]?)$").captures(s) {
        let letter = m.get(2).map_or("", |l| l.as_str());
        return Some(Literal {
            kind: if m.get(3).is_some() || matches!(letter, "e" | "f") {
                Kind::Float
            } else if !letter.is_empty() && "pmdznuvt".contains(letter) {
                Kind::Temporal
            } else {
                Kind::Integer
            },
            vector: false,
            len: 1,
            negative: m.get(1).is_some(),
            short_integer: s.ends_with('h'),
            integer_null: re!(r"^0N[hij]?$").is_match(s),
        });
    }
    // A vector's items may be nulls and infinities, the last one carrying
    // the vector's type: `1 0N`, `0N 1h`, `1 -0W`, `1 0Nh` (q 5: `flip 1 0N`
    // is 'rank, `where 1 0N` 'limit, #2242). The null is the least long,
    // and negative as a count.
    if re!(r"^(?:-?\d+|0N|-?0W)(?:\s+(?:-?\d+|0N|-?0W))*[hij]?$").is_match(s) {
        // Values outside the host integer range stay unknown, not truncated.
        let numbers = s
            .trim_end_matches(['h', 'i', 'j'])
            .split_whitespace()
            .map(|item| match item {
                "0N" => Ok(i64::MIN),
                "0W" => Ok(i64::MAX),
                "-0W" => Ok(-i64::MAX),
                _ => item.parse::<i64>(),
            })
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        return Some(Literal {
            kind: Kind::Integer,
            vector: numbers.len() > 1,
            len: numbers.len(),
            negative: numbers.iter().any(|&v| v < 0),
            short_integer: s.ends_with('h'),
            integer_null: false,
        });
    }
    // `2000.01.01`, `2000.01m`, `12:00`, `12:00:00.123`, `0D01`,
    // `2000.01.01D12:00` and `2000.01.01T12:00`, and vectors of them.
    let temporal = re!(
        r"^(?:\d{4}\.\d\d(?:\.\d\d(?:[DT](?:\d\d(?::\d\d(?::\d\d(?:\.\d*)?)?)?)?)?|m)|\d\d:\d\d(?::\d\d(?:\.\d*)?)?|\d+D(?:\d\d(?::\d\d(?::\d\d(?:\.\d*)?)?)?)?)$"
    );
    // A time vector may end in the letter of its type: `12:00u`,
    // `12:00:00v`, `12:00 13:00t` (#593).
    // A month vector carries its `m` on the last item alone: `2000.01
    // 2000.02m` (q 5: `til` of it is 'type, #2244). Without the `m` the same
    // text is a float vector.
    if let Some(months) = s.strip_suffix('m')
        && re!(r"^\d{4}\.\d\d(?:\s+\d{4}\.\d\d)*$").is_match(months)
    {
        let len = months.split_whitespace().count();
        return Some(Literal {
            kind: Kind::Temporal,
            vector: len > 1,
            len,
            negative: false,
            short_integer: false,
            integer_null: false,
        });
    }
    let unsuffixed = s
        .strip_suffix(['u', 'v', 't'])
        .filter(|t| re!(r"\d\d:\d\d(?::\d\d(?:\.\d*)?)?$").is_match(t))
        .unwrap_or(s);
    let items: Vec<&str> = unsuffixed.split_whitespace().collect();
    if !items.is_empty() && items.iter().all(|item| temporal.is_match(item)) {
        return Some(Literal {
            kind: Kind::Temporal,
            vector: items.len() > 1,
            len: items.len(),
            negative: false,
            short_integer: false,
            integer_null: false,
        });
    }
    // Its items may be nulls and infinities too, which make a vector of
    // integers a float one: `1 0n`, `0w 1`, `1.5 0N`, `1 0Ne` (q 5: `1 2 3
    // cor 1 0n` is 'length, #2242).
    let float = re!(
        r"^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+|E\d+)?|0[nNwW]|-0[wW])(?:\s+(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+|E\d+)?|0[nNwW]|-0[wW]))*[ef]?$"
    );
    if float.is_match(s)
        && (s.contains(['.', 'e', 'E'])
            || s.ends_with('f')
            || s.split_whitespace()
                .any(|item| matches!(item, "0n" | "0w" | "-0w")))
    {
        return Some(Literal {
            kind: Kind::Float,
            vector: s.split_whitespace().count() > 1,
            len: s.split_whitespace().count(),
            negative: false,
            short_integer: false,
            integer_null: false,
        });
    }
    None
}

/// QB026. A literal pair of bounds whose first item is above its second, as
/// the two items written: q 5 `5 within 10 1` is 0b, and so is every value,
/// since `within` asks for low <= x <= high. Only a pair of numbers, or of
/// temporals spelt alike - `2024.01.10 2024.01.01`, `10:00 09:30` - whose
/// fixed-width digits then order as their text does. A null or an
/// infinity, a symbol, or anything not a literal is left alone.
fn reversed_bounds(s: &str) -> Option<(&str, &str)> {
    let mut s = s.trim();
    while s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len()) {
        s = s[1..s.len() - 1].trim();
    }
    let items: Vec<&str> = s.split_whitespace().collect();
    let [low, high] = items[..] else {
        return None;
    };
    let number = re!(r"^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+|E\d+)?$");
    let suffixed = high.strip_suffix(['h', 'i', 'j', 'e', 'f']).unwrap_or(high);
    if number.is_match(low) && number.is_match(suffixed) {
        let (a, b) = (low.parse::<f64>().ok()?, suffixed.parse::<f64>().ok()?);
        return (a > b).then_some((low, high));
    }
    let temporal = re!(
        r"^(?:\d{4}\.\d\d(?:\.\d\d(?:[DT](?:\d\d(?::\d\d(?::\d\d(?:\.\d*)?)?)?)?)?)?|\d\d:\d\d(?::\d\d(?:\.\d*)?)?|\d+D(?:\d\d(?::\d\d(?::\d\d(?:\.\d*)?)?)?)?)$"
    );
    let suffixed = high.strip_suffix(['m', 'u', 'v', 't']).unwrap_or(high);
    let shape = |t: &str| t.replace(|c: char| c.is_ascii_digit(), "9");
    (temporal.is_match(low)
        && temporal.is_match(suffixed)
        && shape(low) == shape(suffixed)
        && low > suffixed)
        .then_some((low, high))
}

/// A call to one of the checked builtins: where it starts, which builtin,
/// and its argument text - the same shape whether it was written `til[1.5]`
/// or `til 1.5`, so the rules below never learn which spelling they saw.
struct Call<'a> {
    at: usize,
    name: &'a str,
    args: Vec<&'a str>,
    /// A bracket call with an elided slot: nothing ran, and only the slot
    /// count is worth reading.
    projection: bool,
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
        // A string is blanks in `code`, so `where "abcd"[1]` looks like
        // `where[1]` there: the gap has to be blank in `comments` too (#824).
        if !comments[call.get(1).unwrap().end()..open].trim().is_empty() {
            continue;
        }
        let Some(end) = matching(code, open, b'[', b']') else {
            continue;
        };
        let read = |open: usize, end: usize| -> Vec<&'a str> {
            let mut arg_start = open + 1;
            slots(&code[open + 1..end - 1])
                .into_iter()
                .map(|slot| {
                    let raw = &comments[arg_start..arg_start + slot.len()];
                    arg_start += slot.len() + 1;
                    raw
                })
                .collect()
        };
        let mut args = read(open, end);
        // A dyadic builtin projected on its first argument and applied to
        // the second straight after: `rotate[2.5][1 2 3]` is the call
        // `rotate[2.5;1 2 3]` (q 5: 'type, #617).
        let name = call.get(1).unwrap().as_str();
        if args.len() == 1
            && re!(r"^(?:rotate|mavg|msum|mcount|mdev|mmin|mmax|cor|cov|wavg|wsum|within)$")
                .is_match(name)
            && code[end..].starts_with('[')
            && let Some(next) = matching(code, end, b'[', b']')
        {
            args.extend(read(end, next));
        }
        // Omitted slots are projections rather than complete applications.
        let projection = args.iter().any(|arg| arg.trim().is_empty());
        out.push(Call {
            at,
            name,
            args,
            projection,
        });
    }
    // Juxtaposed form: `name arg`, one argument, running to the end of the
    // expression. Only a literal argument is worth collecting - the rules can
    // say nothing about a name - so the argument is taken as far as the
    // literal extends: digits, dots, a type suffix, backtick symbols, spaces
    // between vector items, or one quoted string - or one of those in
    // parentheses or after `enlist`, which `literal` reads: `til (2.5)` and
    // `flip enlist 1` are 'type and 'rank as their bracket forms are (#602).
    //
    // Matched in `comments`, not `code`: a string is blanks in `code`, so
    // `til "3"` would never be seen there. A comment is blank in both, and
    // `code` still has to hold the builtin's own name at that offset, which
    // proves the match is not the inside of a string.
    //
    // Between the name and its argument, and between vector items, the gap
    // is the statement's blanks: a line break into an indented line
    // continues it, past any blank or comment lines (#193, #676). q needs
    // no gap at all before a backtick, a quote or a parenthesis: q 5
    // `sum`a`b`, `til"a"` and `til(1.5)` are 'type as their spaced forms are
    // (#2241). Before a digit there has to be one, or the digit is part of
    // the name - `til1` is a name, not `til 1`.
    const GAP: &str = blank!();
    for call in re!(&format!(
        r#"\b({BUILTINS}){GAP}*((?:-?\.?\d(?:e-|e\+\d|[A-Za-z0-9.:])*(?:{GAP}+-?\.?\d(?:e-|e\+\d|[A-Za-z0-9.:])*)*)|(?:`[A-Za-z0-9_.:]*)+|"(?:\\.|[^"\\])*"|\((?:[^()"\n]|"(?:\\.|[^"\\])*")*\)|enlist{GAP}+(?:-?\.?\d[A-Za-z0-9.:]*(?:[ \t]+-?\.?\d[A-Za-z0-9.:]*)*|(?:`[A-Za-z0-9_.:]*)+|"(?:\\.|[^"\\])*"))"#
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
        // A `/` straight after it is not a comment - those are blank in
        // `code` - but an iterator: `asc 3/x` sorts `3/x` (#194).
        if !crate::operand_ends(code, comments, whole.end()) {
            continue;
        }
        // After `from` a `where` opens the query's where phrase, which takes
        // a boolean atom: q 5 runs `select from t where 0b` (#737). Before
        // `from` it is still the function - `select c where e from t`.
        if name.as_str() == "where" && crate::query_clause(code, name.start()) == Some("from") {
            continue;
        }
        let arg = call.get(2).unwrap();
        if arg.start() == name.end() && !arg.as_str().starts_with(['`', '"', '(']) {
            continue;
        }
        out.push(Call {
            at: whole.start(),
            name: call.get(1).unwrap().as_str(),
            args: vec![&comments[arg.start()..arg.end()]],
            projection: false,
        });
    }
    // Applied with `@`: `til@2.5` and `@[til;2.5]` are the call `til 2.5`,
    // and 'type alike (q 5). Two slots only - `@[til;2.5;{x}]` is a protected
    // call whose handler catches the error. A dyadic builtin under `@` is a
    // projection, which the argument count in `check` already passes over.
    const LITERAL: &str = r#"(?:-?\.?\d[A-Za-z0-9.:]*(?:[ \t]+-?\.?\d[A-Za-z0-9.:]*)*)|(?:`[A-Za-z0-9_.:]*)+|"(?:\\.|[^"\\])*""#;
    // So is `.` given a one-item list: `til . enlist 2.5` and
    // `.[til;enlist 2.5]` (q 5: 'type, #617).
    for (pattern, name_group, arg_group) in [
        (format!(r"\b({BUILTINS})[ \t]*@[ \t]*({LITERAL})"), 1, 2),
        (
            format!(r"@\[[ \t]*({BUILTINS})[ \t]*;[ \t]*({LITERAL})[ \t]*\]"),
            1,
            2,
        ),
        (
            format!(r"\b({BUILTINS})[ \t]+\.[ \t]+enlist[ \t]+({LITERAL})"),
            1,
            2,
        ),
        (
            format!(r"\.\[[ \t]*({BUILTINS})[ \t]*;[ \t]*enlist[ \t]+({LITERAL})[ \t]*\]"),
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
            if !crate::operand_ends(code, comments, whole.end()) {
                continue;
            }
            let arg = call.get(arg_group).unwrap();
            out.push(Call {
                at: whole.start(),
                name: name.as_str(),
                args: vec![&comments[arg.start()..arg.end()]],
                projection: false,
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
        let from = crate::past_blanks(comments, m.end());
        if from == m.end() || comments[from..].starts_with(['[', ';', '\n', '\r', ')', ']', '}']) {
            continue;
        }
        let Some(end) = argument_end(code, comments, raw, from) else {
            continue;
        };
        // The leftmost match that reaches the name is not always the
        // operand: in `r2:3.5 rotate x` it starts at the `2` of `r2`, since
        // a time literal lets `:` inside one. So the search moves right past
        // any candidate that does not start on a token boundary. A vector's
        // items run on across the indented line that continues it: `r:1`
        // over `  2 cor 1 2` is `1 2 cor 1 2` (#683).
        let mut left = "";
        let mut from_at = 0;
        while let Some(l) = re!(concat!(
            r#"(?:-?\.?\d[A-Za-z0-9.:]*(?:"#,
            blank!(),
            r#"+-?\.?\d[A-Za-z0-9.:]*)*|(?:`[A-Za-z0-9_.:]*)+|"(?:\\.|[^"\\])*"|\([^()]*\))$"#
        ))
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
            projection: false,
        });
    }
    out
}

/// The most arguments q's function `name` takes, from the catalogue: its
/// parameters, or any number when the last is `...` (`enlist`). None for a
/// name the catalogue has no function for.
fn most_arguments(name: &str) -> Option<usize> {
    let b = crate::builtin(name).filter(|b| b.kind == crate::BuiltinKind::Function)?;
    match b.params.last()?.as_str() {
        "..." => Some(usize::MAX),
        _ => Some(b.params.len()),
    }
}

/// Whether the file assigns `name` anywhere, which makes it a function of
/// the file's own: after `.h.xs:{[a;b] a}`, `.h.xs[1;2]` runs.
fn assigned(code: &str, name: &str) -> bool {
    regex::Regex::new(&format!(r"{}{}*:", regex::escape(name), blank!()))
        .unwrap()
        .find_iter(code)
        .any(|m| boundary(code, m.start()))
}

/// The functions q defines as lambdas, which check an elided slot too many
/// where they are projected: q 5 `til[3;]` and `xasc[a;b;]` are 'rank, while
/// `sum[1;]` and `bin[a;b;]` are projections, refused only when run.
const LAMBDAS: &[&str] = &[
    "til", "med", "asc", "desc", "iasc", "idesc", "signum", "cols", "keys", "meta", "next",
    "upper", "lower", "trim", "ltrim", "rtrim", "show", "parse", "sdev", "svar", "avgs", "rotate",
    "mavg", "msum", "mcount", "mdev", "mmin", "mmax", "xasc", "xdesc", "except", "vs", "sv",
    "xbar", "cross", "cut", "inter", "xkey", "xcols", "xlog", "xgroup", "mod", "uj", "set", "fby",
    "ssr", "aj", "aj0", "ajf", "ajf0", "ej", "wj", "wj1",
];

pub fn check(path: &str, source: &str, code: &str, comments: &str) -> Vec<Finding> {
    let mut out = vec![];
    // A keyword the file redefines in `.q` calls the new definition from
    // there on: after q 5 `.q.ssr:{[a;b;c;d] a}`, `ssr[1;2;3;4]` is 1, and
    // after `.q.til:{x+1}`, `til 1.5` is 2.5 (#440).
    let dotq = crate::dotq_definitions(code, source);
    let redefined = |name: &str, at: usize| dotq.iter().any(|(n, from)| n == name && at > *from);
    // QA010 for every other function in the catalogue, `.Q`, `.h` and
    // `.j` ones included: q 5 refuses one more argument than it takes with
    // 'rank - `ij[a;b;c]`, `ssr[a;b;c;d]`, `.Q.dd[a;b;c]` (#2246). The
    // most it takes is the catalogue's, which `tests/help.rs` holds to q's.
    // A column-0 `[1;2;3]` under `keyjoin:lj` is a statement of its own (#742).
    for m in re!(concat!(
        r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)",
        blank!(),
        r"*\["
    ))
    .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        let name = &m[1];
        let Some(arity) = most_arguments(name) else {
            continue;
        };
        if BUILTINS.split('|').any(|b| b == name)
            || !boundary(code, whole.start())
            || redefined(name, whole.start())
            || (name.starts_with('.') && assigned(code, name))
        {
            continue;
        }
        let open = whole.end() - 1;
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let slots = slots(&code[open + 1..close - 1]);
        let given = slots.len();
        // An elided slot makes a projection, which q refuses where it is
        // made only for a function it defines as a lambda: q 5 `xasc[a;b;]`
        // is 'rank, while `bin[a;b;]` is a projection that fails when run.
        let projection = slots.iter().any(|slot| slot.trim().is_empty());
        if given > arity && (!projection || LAMBDAS.contains(&name)) {
            out.push(Finding::at(
                path,
                source,
                whole.start(),
                "QA010",
                format!(
                    "{name} accepts at most {arity} argument(s), but this call supplies {given}"
                ),
            ));
        }
    }
    for Call {
        at,
        name,
        args,
        projection,
    } in calls(code, comments, source)
    {
        if redefined(name, at) {
            continue;
        }
        let args = &args;
        let arity = match name {
            "rotate" | "mavg" | "msum" | "mcount" | "mdev" | "mmin" | "mmax" | "cor" | "cov"
            | "wavg" | "wsum" | "within" => 2,
            _ => 1,
        };
        let report = |out: &mut Vec<Finding>, id, detail| {
            out.push(Finding::at(path, source, at, id, detail))
        };
        let max_arity = most_arguments(name).unwrap_or(arity);
        // A projection is refused only by a builtin q defines as a lambda,
        // which checks its slots where it is projected: q 5 `til[3;]`,
        // `til[;3]` and `mavg[1;;]` are 'rank, while `sum[1;]` and
        // `count[1;]` are not refused until they run, if then (#631).
        if args.len() > max_arity && (!projection || LAMBDAS.contains(&name)) {
            report(
                &mut out,
                "QA010",
                format!(
                    "{name} accepts at most {max_arity} argument(s), but this {} supplies {}",
                    if projection { "call" } else { "complete call" },
                    args.len()
                ),
            );
            continue;
        }
        if projection || args.len() != arity {
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
            } else if let Some((low, high)) = reversed_bounds(args[1]) {
                report(
                    &mut out,
                    "QB026",
                    format!(
                        "within takes its bounds low then high, and {low} is above {high}, so \
                         nothing is within them and this is always false: swap the two"
                    ),
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
        // Nulls and infinities are no counts: q 5 `til 0N` and `til -0W` are
        // 'domain, of any width, and `til 0W` and `til 0Wj` are 'limit. A
        // narrower infinity is only a large count: `til 0Wh` is 32767 items,
        // and `til 0Wi` asks for 2147483647 longs, which fails or not with
        // the memory at hand ('stop on the machine that measured it).
        if name == "til" {
            let arg = args[0].trim();
            let detail = if re!(r"^(?:0N|-0W)[hij]?$").is_match(arg) {
                Some("til: til of a null or negative infinity is 'domain")
            } else if re!(r"^0Wj?$").is_match(arg) {
                Some("til: til of a long infinity is 'limit")
            } else {
                None
            };
            if let Some(detail) = detail {
                report(&mut out, "QD001", detail.into());
                continue;
            }
        }
        let Some(value) = literal(args[0]) else {
            continue;
        };
        // A temporal atom is no count or window either: q 5 `12:00 rotate x`
        // and `2000.01.01 msum x` are 'type (#605).
        let rule = match name {
            "sqrt" | "log" | "exp" | "abs" | "neg" | "sin" | "cos" | "tan" | "acos" | "asin"
            | "atan" | "reciprocal" | "ceiling" | "signum"
                if value.kind == Kind::Symbol =>
            {
                Some(("QT016", "Numeric math cannot operate on a symbol literal"))
            }
            // A null window too, though `mmin` and `mmax` take one: q 5
            // `0N mavg x` is 'type and `0N mmin x` is x (#2245).
            "mavg" | "msum" | "mcount" | "mdev" if value.integer_null => {
                Some(("QT017", "a null is no moving-window size"))
            }
            "mavg" | "msum" | "mcount" | "mdev" | "mmin" | "mmax"
                if value.vector
                    || matches!(
                        value.kind,
                        Kind::Float | Kind::Symbol | Kind::Char | Kind::Temporal
                    ) =>
            {
                Some(("QT017", "Moving-window size must be an integer atom"))
            }

            // A symbol atom runs - `til` is `key` there and lists a
            // namespace - and so does a byte atom. Any vector, a string of
            // any length, a float and a temporal atom are 'type.
            "til"
                if value.vector
                    || matches!(value.kind, Kind::Float | Kind::Char | Kind::Temporal) =>
            {
                Some(("QT008", "til needs an integer atom, not this literal"))
            }
            "til" if value.kind == Kind::Integer && value.negative => {
                Some(("QD001", "til cannot generate a negative number of indices"))
            }
            // `where ""` and `where 0x` are the string and byte vector q
            // accepts: there is nothing in them (q 5 gives `long$() for each,
            // and `where 0x01` is 'type).
            // q 5 wants a list: `where 2` and `where 1b` are 'type, and so is
            // a short vector, while an int one counts (`where 1 2i` is 0 1 1).
            // A date, month, time or timespan is no count: q 5 `where 12:00
            // 13:00` and `where 0D01 0D02` are 'type (#736).
            "where"
                if matches!(value.kind, Kind::Float | Kind::Symbol | Kind::Temporal)
                    || (matches!(value.kind, Kind::Char | Kind::Byte) && value.len > 0)
                    || (matches!(value.kind, Kind::Integer | Kind::Bool) && !value.vector)
                    || value.short_integer =>
            {
                Some(("QT009", "where requires a boolean, int or long vector"))
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
            // `sdev`, `svar`, `all` and `any` of a symbol, atom or vector,
            // too (q 5: 'type), though each takes a string.
            "sum" | "prd" | "avg" | "med" | "dev" | "var" | "sdev" | "svar" | "all" | "any"
            | "sums" | "prds" | "deltas" | "ratios" | "avgs"
                if (value.kind == Kind::Symbol
                    && (value.vector
                        || matches!(
                            name,
                            "avg" | "med" | "dev" | "var" | "sdev" | "svar" | "all" | "any" | "avgs"
                        )))
                    // A string is numeric to `sum`, `avg` and `ratios`, and
                    // not to these five (q 5: `avgs "ab"` is 'type, #606).
                    || (value.kind == Kind::Char
                        && value.vector
                        && matches!(name, "prd" | "sums" | "prds" | "deltas" | "avgs")) =>
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
            // A symbol too, though it may name a table: q 5 `flip `t` is 'rank.
            "flip" => Some(("QT013", "flip cannot transpose an atom or a flat vector")),
            // Nor is a null a count: q 5 `0N rotate x` is 'domain (#2245).
            "rotate" if value.integer_null => Some(("QT014", "a null is no rotate count")),
            "rotate"
                if value.vector
                    || matches!(
                        value.kind,
                        Kind::Float | Kind::Symbol | Kind::Char | Kind::Temporal
                    ) =>
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
