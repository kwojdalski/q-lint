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
    let Ok(conv) = super::functional::bare_qsql_at(code, source, at)? else {
        return None;
    };
    let text = format!("{}\n", conv.text);
    let v = crate::views(&text);
    let parts = layout::parts_at(&v.code, &v.comments, &text, 0)?;
    // A backslash is no escape in a code span (CommonMark): the span is
    // fenced by more backticks than it holds in a row instead (#2065).
    Some(format!(
        "The functional form of {}.\n\n{}",
        self::code(&conv.text),
        explain(&parts)
    ))
}

/// `text` as inline code: fenced by one backtick more than the longest
/// run of them in it, with a blank inside where it holds any, so that a
/// symbol (`` `a ``) or an empty one (``` `` ```) does not end the span.
fn code(text: &str) -> String {
    let text = text.trim();
    let (mut longest, mut run) = (0, 0);
    for c in text.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    if longest == 0 {
        format!("`{text}`")
    } else {
        let fence = "`".repeat(longest + 1);
        format!("{fence} {text} {fence}")
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
                // `&` and `|` are the lesser and the greater of their
                // arguments, item by item; on booleans that is "and" and
                // "or", but on numbers it is one column of minima or maxima
                // (KDB-X: `1 5&3 2` is `1 2`). `and` and `or` are the
                // same functions (#2066).
                ("&" | "and" | "|" | "or", [x, y]) if !(boolean(x) && boolean(y)) => {
                    let which = if matches!(v.as_str(), "&" | "and") {
                        "lesser"
                    } else {
                        "greater"
                    };
                    format!("the {which} of {} and {}", operand(x), operand(y))
                }
                (d, [x, y]) => match dyad(d) {
                    Some(phrase) => format!("{} {phrase} {}", operand(x), operand(y)),
                    None => quoted(),
                },
                _ => quoted(),
            }
        }
        _ => quoted(),
    }
}

/// Whether `n` is sure to be boolean: a comparison, a test, a boolean
/// literal, or `&`/`|` of two of them.
fn boolean(n: &Node) -> bool {
    match n {
        Node::Leaf(l) => l
            .strip_suffix('b')
            .is_some_and(|bits| !bits.is_empty() && bits.bytes().all(|c| c == b'0' || c == b'1')),
        Node::Apply(f, args) => match (&**f, &args[..]) {
            (Node::Verb(v), [_, _])
                if matches!(
                    v.as_str(),
                    ">" | "<" | ">=" | "<=" | "=" | "<>" | "~" | "in" | "within" | "like"
                ) =>
            {
                true
            }
            (Node::Verb(v), [_]) if matches!(v.as_str(), "not" | "null") => true,
            (Node::Verb(v), [x, y]) if matches!(v.as_str(), "&" | "and" | "|" | "or") => {
                boolean(x) && boolean(y)
            }
            _ => false,
        },
        _ => false,
    }
}

/// An argument of a dyad in words, bracketed where it is itself a dyad
/// said in words: q reads right to left, so `a>b and c<d` is
/// `a>(b and c<d)`, and words read left to right would say otherwise.
fn operand(n: &Node) -> String {
    let w = words(n);
    match n {
        Node::Apply(f, args)
            if args.len() == 2 && matches!(&**f, Node::Verb(v) if dyad(v).is_some()) =>
        {
            format!("({w})")
        }
        _ => w,
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

/// The name a column item is written with, `n:e`, and where its
/// expression starts.
fn name(item: &str) -> Option<(&str, &str)> {
    let b = item.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    (i > 0
        && b[0].is_ascii_alphabetic()
        && b.get(i) == Some(&b':')
        && !matches!(b.get(i + 1), Some(b':' | b'/' | b'\\' | b'\'')))
    .then(|| (&item[..i], item[i + 1..].trim()))
}

/// A column item: its name, where it has one, and its expression.
fn column(item: &str) -> String {
    match name(item) {
        Some((n, expr)) => format!("{}: {}", code(n), said(expr)),
        None => said(item),
    }
}

/// The `[...]` a `select` is written with, `select[2] a`: what is inside
/// the brackets and what follows them; `None` without one.
fn bracketed(item: &str) -> Option<(String, String)> {
    let item = item.trim_start();
    if !item.starts_with('[') {
        return None;
    }
    let mut depth = 0usize;
    for (i, c) in item.char_indices() {
        match c {
            '[' | '(' | '{' => depth += 1,
            ']' | ')' | '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return (c == ']')
                        .then(|| (item[1..i].to_string(), item[i + 1..].trim().to_string()));
                }
            }
            _ => {}
        }
    }
    None
}

/// `text` split at `sep` outside brackets and parentheses.
fn split_top(text: &str, sep: u8) -> Vec<String> {
    let mut out = vec![];
    let (mut depth, mut from) = (0usize, 0);
    for (i, b) in text.bytes().enumerate() {
        match b {
            b'[' | b'(' | b'{' => depth += 1,
            b']' | b')' | b'}' => depth = depth.saturating_sub(1),
            _ if b == sep && depth == 0 => {
                out.push(text[from..i].trim().to_string());
                from = i + 1;
            }
            _ => {}
        }
    }
    out.push(text[from..].trim().to_string());
    out.retain(|s| !s.is_empty());
    out
}

/// One item of `select[...]` in words: a sort (`>c`, `<c`), or a limit -
/// `n` rows from the top, `-n` from the bottom, `m n` from row `m` - taken
/// of the result, after any grouping (checked in KDB-X).
fn limited(item: &str) -> String {
    if let Some(c) = item.strip_prefix('>') {
        return format!("Sorts the result by {}, largest first.", said(c));
    }
    if let Some(c) = item.strip_prefix('<') {
        return format!("Sorts the result by {}, smallest first.", said(c));
    }
    let n: Vec<&str> = item.split_whitespace().collect();
    let int = |t: &str| t.parse::<i64>().ok();
    match n[..] {
        [k] => match int(k) {
            Some(k) if k < 0 => format!("Keeps only the last {} rows of the result.", -k),
            Some(k) => format!("Keeps only the first {k} rows of the result."),
            None => format!("Keeps only the rows of the result {} picks.", code(item)),
        },
        [m, k] if int(m).is_some() && int(k).is_some() => {
            format!("Keeps only {k} rows of the result, starting at row {m}.")
        }
        _ => format!("Keeps only the rows of the result {} picks.", code(item)),
    }
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
    let mut limit = vec![];
    if let Some(first) = head.first_mut()
        && p.lead == "select"
        && let Some((inside, rest)) = bracketed(first)
    {
        limit = split_top(&inside, b';');
        *first = rest;
        if first.is_empty() {
            head.remove(0);
        }
    }
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
    // `select[...]` takes a row count, a sort, or a count then a sort; any
    // other order or number of items is 'length on KDB-X (`select[<px;2]`,
    // `select[<px;>size]`, `select[2;3]`), and a query that does not run is
    // not described as one that does (#2067).
    let sort = |l: &String| l.starts_with(['<', '>']);
    let runs = match &limit[..] {
        [] | [_] => true,
        [count, by] => !sort(count) && sort(by),
        _ => false,
    };
    if !runs {
        return format!(
            "**In words.** q refuses this query with 'length: `select[...]` takes a row count, \
             a sort (`<c`, `>c`), or a row count then a sort, as in {}.",
            code("select[2;<px]")
        );
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
            // The sort, written second, is applied before the count.
            steps.extend(limit.iter().rev().map(|l| limited(l)));
        }
        "exec" => {
            // One group unnamed keys the result by its values; a named one,
            // or several, by a table of them (KDB-X: `exec px by s:sym
            // from t` is keyed by a table with the column `s`, #2059).
            if let [one] = &by[..]
                && name(one).is_none()
            {
                steps.push(format!(
                    "Groups the rows by {}: the result is a dictionary from each value of it.",
                    column(one)
                ));
            } else if !by.is_empty() {
                steps.push(format!(
                    "Groups the rows by {}: the result is a dictionary from a table of the groups, one row for each.",
                    list(&by, column)
                ));
            }
            steps.push(if head.is_empty() {
                "Returns the last row, as a dictionary from each column to its value.".to_string()
            } else if head.len() == 1 && !head[0].contains(':') {
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
            steps.push(if head.is_empty() && wheres.is_empty() {
                "Removes every row; the columns stay, in an empty table.".to_string()
            } else if head.is_empty() {
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

#[cfg(test)]
mod tests {
    fn words(source: &str) -> String {
        crate::explain_qsql(source, 3).unwrap()
    }

    // q reads right to left: `a>b and c<d` is `a>(b and c<d)` (KDB-X keeps
    // other rows than `(a>b) and c<d`), so a dyad inside a dyad is bracketed.
    #[test]
    fn a_dyad_inside_a_dyad_is_bracketed_as_q_reads_it() {
        let w = words("r:select from t where a>b and c<d\n");
        assert!(
            w.contains("`a` is greater than (the lesser of `b` and (`c` is less than `d`))"),
            "{w}"
        );
        let w = words("r:select from t where (a>b) and c<d\n");
        assert!(
            w.contains("(`a` is greater than `b`) and also (`c` is less than `d`)"),
            "{w}"
        );
        let w = words("r:select from t where a+1=b\n");
        assert!(w.contains("`a` plus (`1` equals `b`)"), "{w}");
        let w = words("r:select from t where (a+1)=b\n");
        assert!(w.contains("(`a` plus `1`) equals `b`"), "{w}");
        let w = words("r:select from t where px>2\n");
        assert!(w.contains("`px` is greater than `2`."), "{w}");
    }

    // On numbers `&` and `|` are the lesser and the greater, item by
    // item (KDB-X: `select x:px&size from t` is one column of minima); on
    // booleans, and and or (#2066).
    #[test]
    fn and_and_or_on_numbers_are_the_lesser_and_the_greater() {
        let w = words("r:select x:px&size from t\n");
        assert!(w.contains("`x`: the lesser of `px` and `size`"), "{w}");
        let w = words("r:select x:px|size from t\n");
        assert!(w.contains("`x`: the greater of `px` and `size`"), "{w}");
        let w = words("r:select from t where px&size\n");
        assert!(
            w.contains("the rows where the lesser of `px` and `size`"),
            "{w}"
        );
        let w = words("r:select from t where (px>1)|null size\n");
        assert!(
            w.contains("(`px` is greater than `1`) or else whether this is null: `size`"),
            "{w}"
        );
        let w = words("r:select from t where flag&10101b\n");
        assert!(w.contains("the lesser of `flag` and `10101b`"), "{w}");
        let w = words("r:select from t where (px>1)&(size<3)|px=2\n");
        assert!(
            w.contains("(`px` is greater than `1`) and also ((`size` is less than `3`) or else (`px` equals `2`))"),
            "{w}"
        );
    }

    // Checked in KDB-X: `exec from t` is the last row as a dictionary;
    // `select[n]` takes of the result, after a sort in the brackets;
    // `delete from t` with no where removes every row.
    #[test]
    fn exec_with_no_columns_select_with_a_limit_and_delete_with_no_where() {
        let w = words("r:exec from t\n");
        assert!(w.contains("Returns the last row, as a dictionary"), "{w}");
        let w = words("r:select[2] a from t\n");
        assert!(
            w.contains("1. Returns `a`.\n2. Keeps only the first 2 rows"),
            "{w}"
        );
        let w = words("r:select[-3] from t\n");
        assert!(
            w.contains("Keeps only the last 3 rows of the result."),
            "{w}"
        );
        let w = words("r:select[1 2] from t\n");
        assert!(
            w.contains("Keeps only 2 rows of the result, starting at row 1."),
            "{w}"
        );
        let w = words("r:select[2;>a] a from t\n");
        assert!(
            w.contains("2. Sorts the result by `a`, largest first.\n3. Keeps only the first 2"),
            "{w}"
        );
        // One group unnamed keys an exec by its values, a named one by a
        // table (#2059).
        let w = words("r:exec px by sym from t\n");
        assert!(w.contains("a dictionary from each value of it"), "{w}");
        let w = words("r:exec px by sym:sym from t\n");
        assert!(w.contains("a dictionary from a table of the groups"), "{w}");
        let w = crate::explain_qsql("r:?[t;();(enlist`sym)!enlist`sym;`px]\n", 3).unwrap();
        assert!(w.contains("a dictionary from a table of the groups"), "{w}");
        // A backtick in the qSQL of a functional form is fenced, not
        // escaped: a backslash is literal in a code span (#2065).
        let w = crate::explain_qsql("r:![`t;();0b;enlist`px]\n", 3).unwrap();
        assert!(
            w.starts_with("The functional form of `` delete px from `t ``."),
            "{w}"
        );
        let w = crate::explain_qsql("r:?[t;enlist (=;`sym;enlist`a);0b;()]\n", 3).unwrap();
        assert!(
            w.starts_with("The functional form of `` select from t where sym=`a ``."),
            "{w}"
        );
        assert!(!w.contains('\\'), "{w}");
        let w = words("r:select from t where s in ``a\n");
        assert!(w.contains("``` ``a ```"), "{w}");
        // A count then a sort is the only order of two q runs: on KDB-X
        // `select[<px;2] from t`, two sorts and two counts are 'length
        // (#2067).
        for refused in [
            "r:select[<px;2] from t\n",
            "r:select[<px;>size] from t\n",
            "r:select[2;3] from t\n",
            "r:select[2;<px;1] from t\n",
        ] {
            let w = words(refused);
            assert!(w.contains("q refuses this query with 'length"), "{w}");
            assert!(!w.contains("Sorts the result"), "{w}");
        }
        let w = words("r:select[<px] from t\n");
        assert!(
            w.contains("Sorts the result by `px`, smallest first."),
            "{w}"
        );
        let w = words("r:select[1 2;>px] from t\n");
        assert!(
            w.contains("Sorts the result by `px`, largest first.\n3. Keeps only 2 rows"),
            "{w}"
        );
        let w = words("r:delete from t\n");
        assert!(w.contains("Removes every row"), "{w}");
        let w = words("r:delete from t where a>1\n");
        assert!(w.contains("Removes those rows."), "{w}");
    }
}
