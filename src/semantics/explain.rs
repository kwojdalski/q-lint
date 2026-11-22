//! A qSQL query, or a functional form of one, said in words: what it reads,
//! which rows it keeps, how it groups them and what it returns. The words
//! come from the query's text and nothing else - the same text always gives
//! the same words, and nothing runs - so a column is named as it is
//! written, and an expression this has no words for is quoted as code.
//!
//! What it says about q is what q does, checked in KDB-X and PeachQ: each
//! where constraint is tested only on the rows the ones before it kept; a
//! by clause gives a keyed table, one row per group; `select by` with no
//! columns keeps the last row of each group; `update` and `delete` return a
//! changed copy of a table named by value and change a table named by
//! symbol (`` `t ``) in place; `exec` returns a list, or a dictionary of
//! them, rather than a table.
use super::functional::{Node, infix_text, tree};
use super::layout;

/// The words for the query or functional form around byte `at`, as
/// Markdown; `None` outside one.
pub(crate) fn explain_at(code: &str, comments: &str, source: &str, at: usize) -> Option<String> {
    if let Some(parts) = layout::parts_at(code, comments, source, at) {
        return Some(explain(&parts));
    }
    // A functional form, through its qSQL spelling.
    let Ok(conv) = super::functional::to_qsql_at(code, source, at)? else {
        return None;
    };
    let text = format!("{}\n", conv.text);
    let v = crate::views(&text);
    let parts = layout::parts_at(&v.code, &v.comments, &text, 0)?;
    Some(format!(
        "The functional form of `{}`.\n\n{}",
        conv.text.replace('`', "\\`"),
        explain(&parts)
    ))
}

/// `text` as inline code.
fn code(text: &str) -> String {
    let text = text.trim();
    if text.contains('`') {
        format!("`` {text} ``")
    } else {
        format!("`{text}`")
    }
}

/// An expression in words, or quoted as code where this has none for it.
fn said(text: &str) -> String {
    tree(text).map_or_else(|_| code(text), |n| words(&n))
}

fn words(n: &Node) -> String {
    let quoted = || infix_text(n).map_or_else(|_| "an expression".to_string(), |t| code(&t));
    match n {
        Node::Apply(f, args) => {
            let Node::Verb(v) = &**f else {
                return quoted();
            };
            match (v.as_str(), &args[..]) {
                ("count", [Node::Name(i)]) if i == "i" => "the number of rows".into(),
                (m, [x]) => match monad(m) {
                    Some(phrase) => format!("{phrase} {}", words(x)),
                    None => quoted(),
                },
                ("fby", [Node::List(fc), g]) if fc.len() == 2 => format!(
                    "{} {} within each group of {}",
                    monad_name(&fc[0]).unwrap_or_else(|| "the result of a function on".into()),
                    words(&fc[1]),
                    words(g)
                ),
                ("wavg", [w, x]) => format!("the average of {} weighted by {}", words(x), words(w)),
                ("wsum", [w, x]) => format!("the sum of {} weighted by {}", words(x), words(w)),
                ("xbar", [b, x]) => {
                    format!("{} rounded down to a multiple of {}", words(x), words(b))
                }
                ("each", [Node::Verb(m), x]) if monad(m).is_some() => {
                    format!("{} each item of {}", monad(m).unwrap_or_default(), words(x))
                }
                (d, [x, y]) => match dyad(d) {
                    Some(phrase) => format!("{} {phrase} {}", words(x), words(y)),
                    None => quoted(),
                },
                _ => quoted(),
            }
        }
        _ => quoted(),
    }
}

fn monad_name(n: &Node) -> Option<String> {
    match n {
        Node::Verb(v) => monad(v).map(str::to_string),
        _ => None,
    }
}

/// Words for a monad, before its argument.
fn monad(v: &str) -> Option<&'static str> {
    Some(match v {
        "count" => "the number of",
        "sum" => "the sum of",
        "avg" => "the average of",
        "max" => "the largest of",
        "min" => "the smallest of",
        "first" => "the first of",
        "last" => "the last of",
        "med" => "the median of",
        "dev" => "the standard deviation of",
        "var" => "the variance of",
        "distinct" => "the distinct values of",
        "sums" => "the running sum of",
        "deltas" => "the differences between successive items of",
        "neg" => "minus",
        "abs" => "the absolute value of",
        "sqrt" => "the square root of",
        "not" => "not",
        "null" => "whether this is null:",
        "string" => "the text of",
        "upper" => "the upper case of",
        "lower" => "the lower case of",
        _ => return None,
    })
}

/// Words for a dyad, between its arguments.
fn dyad(v: &str) -> Option<&'static str> {
    Some(match v {
        ">" => "is greater than",
        "<" => "is less than",
        ">=" => "is at least",
        "<=" => "is at most",
        "=" => "equals",
        "<>" => "differs from",
        "~" => "matches",
        "in" => "is one of",
        "within" => "is between the two ends of, inclusive,",
        "like" => "matches the pattern",
        "+" => "plus",
        "-" => "minus",
        "*" => "times",
        "%" => "divided by",
        "and" | "&" => "and also",
        "or" | "|" => "or else",
        "mod" => "modulo",
        "div" => "divided, rounding down, by",
        _ => return None,
    })
}

/// A column item: its name, where it has one, and its expression.
fn column(item: &str) -> String {
    let b = item.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    if i > 0
        && b[0].is_ascii_alphabetic()
        && b.get(i) == Some(&b':')
        && !matches!(b.get(i + 1), Some(b':' | b'/' | b'\\' | b'\''))
    {
        let expr = item[i + 1..].trim();
        return format!("{}: {}", code(&item[..i]), said(expr));
    }
    said(item)
}

fn list(items: &[String], each: fn(&str) -> String) -> String {
    let parts: Vec<String> = items.iter().map(|i| each(i)).collect();
    match parts.len() {
        0 => String::new(),
        1 => parts[0].clone(),
        _ => format!(
            "{} and {}",
            parts[..parts.len() - 1].join(", "),
            parts[parts.len() - 1]
        ),
    }
}

fn explain(p: &layout::Parts) -> String {
    let clause = |w: &str| {
        p.clauses
            .iter()
            .find(|(c, _)| *c == w)
            .map(|(_, i)| i.clone())
            .unwrap_or_default()
    };
    let from = clause("from").first().cloned().unwrap_or_default();
    let wheres = clause("where");
    let by = clause("by");
    let mut head = p.head.clone();
    let mut distinct = false;
    if let Some(first) = head.first_mut()
        && p.lead == "select"
        && let Some(rest) = first.strip_prefix("distinct")
        && (rest.is_empty() || rest.starts_with(' '))
    {
        distinct = true;
        *first = rest.trim().to_string();
        if first.is_empty() {
            head.remove(0);
        }
    }
    let in_place = from.trim_start().starts_with('`');
    let mut lines = vec![];
    lines.push(match p.lead {
        "update" | "delete" if in_place => {
            format!("**In words.** Changes the table {} in place.", code(&from))
        }
        "update" | "delete" => format!(
            "**In words.** Reads {} and returns a changed copy of it; {} itself is left as it was.",
            code(&from),
            code(&from)
        ),
        _ => format!("**In words.** Reads {}.", code(&from)),
    });
    let mut steps = vec![];
    if !wheres.is_empty() {
        let mut said_wheres: Vec<String> = wheres.iter().map(|w| said(w)).collect();
        let first = said_wheres.remove(0);
        let mut s = format!("Keeps the rows where {first}");
        for w in said_wheres {
            s.push_str(&format!("; then, of those, the rows where {w}"));
        }
        s.push('.');
        if wheres.len() > 1 {
            s.push_str(" Each condition is tested only on the rows the ones before it kept.");
        }
        steps.push(s);
    }
    match p.lead {
        "select" => {
            if !by.is_empty() {
                steps.push(format!(
                    "Groups the rows by {}: the result is a keyed table, one row for each group.",
                    list(&by, column)
                ));
            }
            steps.push(match (head.is_empty(), by.is_empty()) {
                (true, true) => "Returns every column.".to_string(),
                (true, false) => "Returns the last row of each group.".to_string(),
                (false, true) => format!("Returns {}.", list(&head, column)),
                (false, false) => format!("Returns, for each group, {}.", list(&head, column)),
            });
            if distinct {
                steps.push("Leaves out rows that repeat one already returned.".into());
            }
        }
        "exec" => {
            if !by.is_empty() {
                steps.push(format!(
                    "Groups the rows by {}: the result is a dictionary from each group.",
                    list(&by, column)
                ));
            }
            steps.push(if head.len() == 1 && !head[0].contains(':') {
                format!("Returns {} as a list, not a table.", column(&head[0]))
            } else {
                format!(
                    "Returns {} as a dictionary of lists, not a table.",
                    list(&head, column)
                )
            });
        }
        "update" => {
            if !by.is_empty() {
                steps.push(format!(
                    "Works out each value within its group of {}.",
                    list(&by, column)
                ));
            }
            let rows = if wheres.is_empty() {
                "on every row"
            } else {
                "on those rows; every other row keeps its values"
            };
            steps.push(format!(
                "Sets {} {rows}. A column that does not exist yet is added.",
                list(&head, column)
            ));
        }
        "delete" => {
            steps.push(if head.is_empty() {
                "Removes those rows.".to_string()
            } else {
                format!("Removes the columns {}.", list(&head, code))
            });
        }
        _ => {}
    }
    for (n, s) in steps.iter().enumerate() {
        lines.push(format!("{}. {s}", n + 1));
    }
    lines.join("\n")
}
