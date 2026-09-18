//! Narrow contracts for explicit calls with complete, known literal arguments.
//! Unknown expressions and projections are left alone; no input is evaluated.
use crate::{Finding, boundary, matching, slots};

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Integer,
    Float,
    Symbol,
    Bool,
}
struct Literal {
    kind: Kind,
    vector: bool,
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
        return Some(value);
    }
    if re!(r"^(?:`[A-Za-z][A-Za-z0-9_.]*)+$").is_match(s) {
        return Some(Literal {
            kind: Kind::Symbol,
            vector: s.bytes().filter(|&b| b == b'`').count() > 1,
            negative: false,
            short_integer: false,
        });
    }
    if re!(r"^[01]+b$").is_match(s) {
        return Some(Literal {
            kind: Kind::Bool,
            vector: s.len() > 2,
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
            negative: false,
            short_integer: false,
        });
    }
    None
}

pub fn check(path: &str, source: &str, code: &str, comments: &str) -> Vec<Finding> {
    let mut out = vec![];
    let calls = re!(
        r"\b(til|where|sum|prd|avg|med|dev|var|sums|prds|deltas|ratios|asc|desc|iasc|idesc|distinct|flip|rotate|count|first|last|enlist|reverse|abs|neg)\s*\["
    );
    for call in calls.captures_iter(code) {
        let at = call.get(0).unwrap().start();
        if !boundary(code, at) || re!(r"\n\S").is_match(call.get(0).unwrap().as_str()) {
            continue;
        }
        let name = &call[1];
        let open = call.get(0).unwrap().end() - 1;
        let Some(end) = matching(code, open, b'[', b']') else {
            continue;
        };
        // Do not mistake the surviving numeric part of a mixed list for an atom.
        if comments[open + 1..end - 1].contains('"') {
            continue;
        }
        let args = slots(&code[open + 1..end - 1]);
        // Omitted slots are projections rather than complete applications.
        if args.iter().any(|arg| arg.trim().is_empty()) {
            continue;
        }
        let arity = if name == "rotate" { 2 } else { 1 };
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
        let Some(value) = literal(args[0]) else {
            continue;
        };
        let rule = match name {
            "til" if value.kind == Kind::Float || (value.vector && value.kind != Kind::Symbol) => {
                Some((
                    "QT008",
                    "til needs an integer atom, not this numeric literal",
                ))
            }
            "til" if value.kind == Kind::Integer && value.negative => {
                Some(("QD001", "til cannot generate a negative number of indices"))
            }
            "where" if matches!(value.kind, Kind::Float | Kind::Symbol) || value.short_integer => {
                Some(("QT009", "where requires boolean or long counts"))
            }
            "where" if value.negative => Some((
                "QD002",
                "where cannot repeat an index a negative number of times",
            )),
            "sum" | "prd" | "avg" | "med" | "dev" | "var" | "sums" | "prds" | "deltas"
            | "ratios"
                if value.kind == Kind::Symbol
                    && (value.vector || matches!(name, "avg" | "med" | "dev" | "var")) =>
            {
                Some((
                    "QT010",
                    "This numeric aggregate or scan rejects this symbol literal",
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
            "flip" if value.kind != Kind::Symbol => Some((
                "QT013",
                "flip cannot transpose a numeric atom or flat numeric vector",
            )),
            "rotate" if value.vector || matches!(value.kind, Kind::Float | Kind::Symbol) => {
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
