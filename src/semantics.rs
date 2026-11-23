use crate::{Finding, blank, boundary, matching, operand_ends, signature};
use std::collections::{HashMap, HashSet};
use std::ops::Range;

pub(crate) mod explain;
pub(crate) mod extract;
pub(crate) mod functional;
pub(crate) mod help;
pub(crate) mod infer;
pub(crate) mod layout;
pub(crate) mod navigate;
pub(crate) mod select;
pub(crate) mod typelint;
pub(crate) mod version;

struct Scope {
    start: usize,
    end: usize,
    body: usize,
    named: bool,
    parent: Option<usize>,
    namespace: String,
    params: HashSet<String>,
    locals: HashSet<String>,
    direct: String,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Convention {
    Camel,
    Pascal,
    Snake,
    Hungarian,
    Mixed,
}
impl Convention {
    fn label(self) -> &'static str {
        match self {
            Convention::Camel => "camelCase",
            Convention::Pascal => "PascalCase",
            Convention::Snake => "snake_case",
            Convention::Hungarian => "Hungarian notation",
            Convention::Mixed => "mixed",
        }
    }
}
/// How a name joins its words, judged on its last dotted segment, since a
/// namespace is usually someone else's. A single word joins nothing, and an
/// all-capitals name is a constant, so both answer `None`.
///
/// Hungarian notation is decided later, from the whole file: a type prefix
/// cannot be told from the first word of a camelCase name one name at a time.
fn convention(name: &str) -> Option<Convention> {
    let word = name.rsplit('.').next().unwrap_or(name);
    // A test framework's hook prefix is the framework's spelling, not the
    // author's: qunit finds its hooks as `setUp*`, `tearDown*`,
    // `beforeNamespace*` and `afterNamespace*`, so `setUp_fresh` cannot be
    // renamed, and only what follows the prefix says how the author names.
    let word = re!(r"^(?:setUp|tearDown|beforeNamespace|afterNamespace|beforeEach|afterEach|beforeAll|afterAll)_?")
        .find(word)
        .map_or(word, |m| &word[m.end()..]);
    let hump = word
        .as_bytes()
        .windows(2)
        .any(|w| w[0].is_ascii_lowercase() && w[1].is_ascii_uppercase());
    let joined = word.trim_matches('_').contains('_');
    let lower_first = word.starts_with(|c: char| c.is_ascii_lowercase());
    match (hump, joined) {
        (true, true) => Some(Convention::Mixed),
        (true, false) if lower_first => Some(Convention::Camel),
        (true, false) => Some(Convention::Pascal),
        (false, true) if !word.bytes().any(|b| b.is_ascii_uppercase()) => Some(Convention::Snake),
        _ => None,
    }
}
// Builtins q accepts infix. `f in x` and `f mod 2` put `f` on the left
// of an operator rather than calling it, and `f each x` applies the
// adverb to `f` instead of applying `f`. Brackets around what follows
// would change the line, not respell it. The `f` joins too: q 5
// `a:2.5; a ljf 2` is 'rank, as `a ij 2` is, not an index (#621).
pub(crate) const INFIX: &[&str] = &[
    "aj", "aj0", "and", "asof", "bin", "binr", "cor", "cov", "cross", "cut", "div", "each",
    "except", "ej", "find", "ij", "in", "insert", "inter", "like", "lj", "lsq", "mmu", "mod", "or",
    "over", "peach", "pj", "prior", "rotate", "scan", "set", "ss", "sublist", "sv", "uj", "union",
    "upsert", "vs", "wavg", "within", "wsum", "xasc", "xbar", "xcol", "xcols", "xdesc", "xexp",
    "xgroup", "xkey", "xlog", "xprev", "xrank", "ema", "fby", "mavg", "mcount", "mdev", "mmax",
    "mmin", "msum", "scov", "ijf", "ljf", "ujf",
];
fn qualify(name: &str, ns: &str) -> String {
    if name.starts_with('.') {
        name.into()
    } else {
        format!("{ns}.{name}")
    }
}
/// The name q resolves `name` to under `ns`, exactly: `.ns.name` inside a
/// context, and the name itself at the root. `qualify` keys a root `g` as
/// `.g`, and the checks lean on that; this keeps the two apart, as q 5
/// does: after `.h2:7`, `value "h2"` is 'h2, and after `h3:5`,
/// `value ".h3"` is '.h3.
fn resolved(name: &str, ns: &str) -> String {
    if ns.is_empty() {
        name.into()
    } else {
        qualify(name, ns)
    }
}
/// The names a multiple assignment `(a;b):...` binds, with where it starts.
/// The target is a q 5 pattern, so it nests and takes a dictionary:
/// `(c;(a;b)):t` binds all three and `([k;v]):d` binds k and v, while
/// `([k:p]):d` binds only p (q 5: `([k:p]):`k`v!5 6` sets p to 5).
pub(crate) fn multi_assignments(text: &str) -> impl Iterator<Item = (usize, &str)> {
    pattern_assignments(text)
        .filter(|&(_, _, global)| !global)
        .map(|(at, name, _)| (at, name))
}
/// The globals a multiple assignment binds wherever it is written: each name
/// of `(a;b)::v`, which in a lambda assigns the globals (q 5
/// `init:{(n;m)::(1 2 3;4)}; init[]; n 0` is 1), and a dotted name in any
/// target, which no lambda has as a local (q 5 `(.ns.n;.ns.m):(1 2 3;4)`).
pub(crate) fn global_multi_assignments(text: &str) -> impl Iterator<Item = (usize, &str)> {
    pattern_assignments(text)
        .filter(|&(_, _, global)| global)
        .map(|(at, name, _)| (at, name))
}
/// Each name a pattern assignment binds, with where it starts and whether
/// it is a global wherever it is written.
fn pattern_assignments(text: &str) -> impl Iterator<Item = (usize, &str, bool)> {
    let bytes = text.as_bytes();
    re!(r"\)\s*(::?)[^:]")
        .captures_iter(text)
        .filter_map(move |c| {
            let m = c.get(0).unwrap();
            let double = c[1].len() == 2;
            // Back to the `(` that opens the target. A filter can hold any
            // function - `(a:neg;b):p`, `(a:{x*2};b):p` and `(a:`$;b):p`
            // bind a and b (q 5, #668) - so what is between is left to
            // `is_pattern`.
            let mut depth = 0usize;
            let mut at = m.start();
            loop {
                match bytes[at] {
                    b')' => depth += 1,
                    b'(' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                at = at.checked_sub(1)?;
            }
            let target = &text[at..=m.start()];
            crate::is_pattern(target, false).then(|| {
                crate::pattern_names(target)
                    .into_iter()
                    .map(move |n| (at, n, double || n.contains('.')))
            })
        })
        .flatten()
}
/// Whether a `set`, `insert` or `upsert` whose target is the symbol written
/// at `tick`, with `rest` between it and the keyword, names what it writes:
/// a bare symbol, `` `n set ``, or one alone in parentheses, `` (`e) set 5 ``
/// (#363). A symbol that only ends a parenthesised expression writes what
/// that evaluates to: `` (` sv ns,`run) set f `` defines `.app.run` and
/// `` (st`pending) upsert p `` writes into `st`, never a root `run` or
/// `pending` (#860).
pub(crate) fn literal_target(code: &str, tick: usize, rest: &str) -> bool {
    !rest.contains(')') || code[..tick].trim_end().ends_with('(')
}
/// The names each `set'` writes from a literal list of symbols, with where
/// it starts: `` `a`b set' v ``, `` (`a`b) set' v ``, `` (`a;`b) set' v ``
/// and `set'[`a`b;v]` (q 5: each sets a and b). Only with each: q 5
/// `` `p`q set 1 2 `` defines neither name.
pub(crate) fn each_set_targets(code: &str) -> Vec<(std::ops::Range<usize>, Vec<&str>)> {
    let list = re!(
        r"((?:`\.?[A-Za-z][A-Za-z0-9_.]*){2,})\s*(?:\)\s*)?set'|\(((?:\s*`\.?[A-Za-z][A-Za-z0-9_.]*\s*;)+\s*`\.?[A-Za-z][A-Za-z0-9_.]*\s*)\)\s*set'|\bset'\s*\[\s*((?:`\.?[A-Za-z][A-Za-z0-9_.]*)+|\((?:\s*`\.?[A-Za-z][A-Za-z0-9_.]*\s*;?)+\))\s*;"
    );
    list.captures_iter(code)
        .filter(|m| {
            m.get(1).is_none_or(|names| {
                literal_target(
                    code,
                    names.start(),
                    &code[names.end()..m.get(0).unwrap().end()],
                )
            })
        })
        .map(|m| {
            let names = m.get(1).or(m.get(2)).or(m.get(3)).unwrap().as_str();
            let names = names
                .split(['`', ';', '(', ')', ' ', '\t', '\n', '\r'])
                .skip(1)
                .filter(|n| !n.is_empty())
                .collect();
            (m.get(0).unwrap().range(), names)
        })
        .collect()
}
/// Whether q runs the expression at `read` before the one at `assign`, both
/// offsets into one lambda body. Statements run top to bottom, and the slots
/// of `if`, `while`, `do` and `$[...]` left to right; everything else -
/// the arguments of a call, the items of a list, the two sides of an infix -
/// runs right to left. So two positions are ordered by their text only when
/// the nearest bracket enclosing both is a control bracket or the body
/// itself. `f[c-1; c:count x]` and `g[c] h[c:1]` both assign before they
/// read; `if[c; c:1]` and `r:c; c:1` do not.
fn runs_before(text: &str, stops: &[usize], read: usize, assign: usize) -> bool {
    let (read_seq, read_path) = eval_path(text, stops, read);
    let (assign_seq, assign_path) = eval_path(text, stops, assign);
    if read_seq != assign_seq {
        return read_seq < assign_seq;
    }
    for (r, a) in read_path.iter().zip(&assign_path) {
        if r.0 != a.0 {
            return false;
        }
        if r.1 != a.1 {
            return r.2 && r.1 < a.1;
        }
    }
    false
}
/// Whether a read written after an assignment in the same statement still
/// runs first, because it is not in the value the assignment computes. Where
/// the two part ways, a read in a later slot of a call or a list runs first
/// (`g[a:1;a]`, `(a:1;a)`), and so does a read to the right of the bracket
/// holding the assignment (`(a:1)+a`, `f[a:1] a`); a control bracket runs its
/// slots left to right (`$[a:1;a;0]`). A read at the assignment's own level,
/// to its right, is in its value, which is `in_value`'s case. Verified in
/// q 5: the first four are refused at definition with 'a, `$[a:1;a;0]` is not.
fn runs_first_after(text: &str, stops: &[usize], read: usize, assign: usize) -> bool {
    let (read_seq, read_path) = eval_path(text, stops, read);
    let (assign_seq, assign_path) = eval_path(text, stops, assign);
    if read <= assign || read_seq != assign_seq {
        return false;
    }
    for (r, a) in read_path.iter().zip(&assign_path) {
        if r.0 != a.0 {
            return true;
        }
        if r.1 != a.1 {
            return !r.2;
        }
    }
    assign_path.len() > read_path.len()
}
/// The offset of each `;` that ends a statement of a lambda body, with no
/// bracket open around it: `eval_path` starts from the last one before the
/// position it is asked about, not from the body's start, which made a
/// long body quadratic in its reads (#708).
fn statement_stops(text: &str) -> Vec<usize> {
    let mut depth = 0usize;
    let mut stops = vec![];
    for (i, &c) in text.as_bytes().iter().enumerate() {
        match c {
            b'[' | b'(' | b'{' => depth += 1,
            b']' | b')' | b'}' => depth = depth.saturating_sub(1),
            b';' if depth == 0 => stops.push(i),
            _ => {}
        }
    }
    stops
}
/// Where `pos` sits in the order a lambda body runs in: the statement it is
/// in, and each bracket open around it, as the bracket's offset, the slot
/// within it, and whether it is a control bracket. `stops` is the body's
/// `statement_stops`.
fn eval_path(text: &str, stops: &[usize], pos: usize) -> (usize, Vec<(usize, usize, bool)>) {
    let mut seq = stops.partition_point(|&stop| stop < pos);
    let from = if seq == 0 { 0 } else { stops[seq - 1] + 1 };
    let mut stack: Vec<(usize, usize, bool)> = vec![];
    for (i, &c) in text.as_bytes()[..pos].iter().enumerate().skip(from) {
        match c {
            b'[' | b'(' | b'{' => {
                // A bracket that follows nothing it could index is a block,
                // which runs left to right like a control bracket. Verified
                // in q 5: `{$[1b;[a:1;a];0]}[]` and `{(a:1;[a:2;a])}` run,
                // while `{g [a:1;a]}` and `{x:[a:1;a]}` are 'a. So does
                // one that opens the body: `{[p] [a:1;a+p]}[5]` is 6.
                let before = text[..i].trim_end();
                let keyword = ["if", "while", "do"].iter().any(|k| {
                    before.strip_suffix(k).is_some_and(|rest| {
                        !rest.ends_with(|c: char| c.is_ascii_alphanumeric() || "_.".contains(c))
                    })
                });
                let control = c == b'['
                    && (keyword || before.is_empty() || before.ends_with(['$', ';', '[', '(']));
                stack.push((i, 0, control));
            }
            b']' | b')' | b'}' => {
                stack.pop();
            }
            b';' => match stack.last_mut() {
                Some(top) => top.1 += 1,
                None => seq += 1,
            },
            // No newline arm: inside a lambda an indented line continues
            // the expression above it, so only `;` ends a statement.
            // Verified: `{r:a\n  +a:5; r}[]` is 10, and `{r:3\n  r}[]`
            // is 'r - `3 r`, one expression.
            _ => {}
        }
    }
    (seq, stack)
}
/// A lambda body as the local-scope checks read it: symbols blanked, and each
/// qSQL query blanked over its own extent, from the keyword to the `;` or
/// bracket that ends its statement. Inside a query a name may be a column,
/// and `update c:1 from t` names one with an assignment's syntax, so neither
/// is a local or a read of one. Only a keyword at a word boundary starts a
/// query: `` `delete`` is a symbol and `.ns.update` a name. With `tables`, a
/// table literal `([...]...)` goes too, whose columns are written the same way.
pub(crate) fn local_view(direct: &str, tables: bool) -> String {
    let symbols = re!(r"`[A-Za-z0-9_./:]*")
        .replace_all(direct, |m: &regex::Captures| " ".repeat(m[0].len()))
        .into_owned();
    let mut out = symbols.clone().into_bytes();
    // No `\b` before the keyword: `_` is a word character to the regex, and
    // `1_update e:d e from t` is a drop of an update (#301). `boundary` is
    // what tells that from the name `x_update`.
    for m in re!(r"(?:select|exec|update|delete)\b").find_iter(&symbols) {
        if !boundary(&symbols, m.start()) || out[m.start()] == b' ' {
            continue;
        }
        let mut depth = 0i32;
        let end = symbols.as_bytes()[m.end()..]
            .iter()
            .position(|&b| {
                match b {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => depth -= 1,
                    _ => {}
                }
                depth < 0 || (b == b';' && depth == 0)
            })
            .map_or(out.len(), |p| m.end() + p);
        for b in &mut out[m.start()..end] {
            if !matches!(*b, b'\n' | b'\r') {
                *b = b' ';
            }
        }
    }
    if tables {
        let text = String::from_utf8(out.clone()).unwrap_or_default();
        for (at, _) in text.match_indices("([") {
            if let Some(close) = matching(&text, at, b'(', b')')
                && !destructures(&text[close..])
            {
                out[at..close].fill(b' ');
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}
/// Whether `rest`, the text after a `(...)` group, assigns to it: the group
/// is then a pattern being destructured, `([k;v]):d`, not a table literal.
fn destructures(rest: &str) -> bool {
    re!(r"^\s*:([^:]|$)").is_match(rest)
}
/// `local_view(direct, tables)` with each query's from-clause put back. The
/// table a query reads is ordinary q, run in the lambda's scope before the
/// query, so an assignment there sets a local: q 5 runs
/// `{[p;c] k:exec c from meta d:p; d:(c inter k) xasc d}`, where the second
/// statement reads the `d` the first one set. Only an outermost query's
/// clause, and only one holding no query of its own, whose names could be
/// columns again; table literals in it stay blank.
fn with_from_clauses(direct: &str, tables: bool) -> String {
    let keyword = re!(r"(?:select|exec|update|delete)\b");
    let mut out = local_view(direct, tables).into_bytes();
    // The same text with no query blanked, to copy a clause back from.
    let unblanked = keyword.replace_all(direct, |m: &regex::Captures| " ".repeat(m[0].len()));
    let plain = local_view(&unblanked, tables);
    let symbols = re!(r"`[A-Za-z0-9_./:]*")
        .replace_all(direct, |m: &regex::Captures| " ".repeat(m[0].len()))
        .into_owned();
    let mut covered = 0;
    for m in keyword.find_iter(&symbols) {
        if m.start() < covered || !boundary(&symbols, m.start()) {
            continue;
        }
        let (mut depth, mut from, mut clause_end) = (0i32, None, None);
        let mut end = symbols.len();
        for (i, b) in symbols.bytes().enumerate().skip(m.end()) {
            match b {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                _ => {}
            }
            if depth < 0 || (b == b';' && depth == 0) {
                end = i;
                break;
            }
            if depth == 0 && boundary(&symbols, i) {
                if from.is_none() && re!(r"^from\b").is_match(&symbols[i..]) {
                    from = Some(i + 4);
                } else if from.is_some()
                    && clause_end.is_none()
                    && re!(r"^where\b").is_match(&symbols[i..])
                {
                    clause_end = Some(i);
                }
            }
        }
        covered = end;
        if let Some(from) = from {
            let to = clause_end.unwrap_or(end);
            if !keyword.is_match(&symbols[from..to]) {
                out[from..to].copy_from_slice(&plain.as_bytes()[from..to]);
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}
/// Whether the text after a `name::` is a value it assigns: not a third
/// colon, and not the end of an expression - `f g::` composes with the
/// identity and assigns nothing.
fn assigns_value(rest: &str) -> bool {
    let rest = rest.trim_start_matches([' ', '\t']);
    !rest.is_empty() && !rest.starts_with([':', ';', ')', ']', '}', '\n', '\r'])
}
/// The innermost scope containing `at`.
///
/// Scopes are pushed as their `{` is met, so they are ordered by `start` and
/// nested by containment. The last one to open before `at` either contains it
/// or has already closed - and if it has closed, anything still open around
/// `at` opened earlier and is one of its ancestors. So: find that scope by
/// bisection, then follow parents. A scan instead is linear per call and
/// quadratic over a file, which a few thousand lambdas make felt.
/// A lambda body with everything that names a column blanked out.
///
/// q writes a column name the way it writes an assignment, so `([sym:`s$()]…)`
/// and `update time:.z.p from t` both look like locals being set. Bracketed
/// groups go first, then any qSQL phrase through to the end of its statement.
/// What is left is the assignments the lambda actually makes.
fn statement_view(direct: &str) -> String {
    let mut out = crate::flat_filter(direct).into_bytes();
    let mut i = 0;
    while let Some(m) =
        re!(r"(?:select|exec|update|delete)\b").find(std::str::from_utf8(&out[i..]).unwrap_or(""))
    {
        let start = i + m.start();
        // `1_update` is a query, `x_update` a name: `local_view`'s test (#301).
        if !boundary(std::str::from_utf8(&out).unwrap_or(""), start) {
            i += m.end();
            continue;
        }
        let end = out[start..]
            .iter()
            .position(|&b| b == b';')
            .map_or(out.len(), |p| start + p);
        for b in &mut out[start..end] {
            if !matches!(*b, b'\n' | b'\r') {
                *b = b' ';
            }
        }
        i = end;
        if i >= out.len() {
            break;
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

fn scope_at(scopes: &[Scope], at: usize) -> Option<usize> {
    let mut i = scopes.partition_point(|s| s.start < at).checked_sub(1)?;
    loop {
        if at < scopes[i].end {
            return Some(i);
        }
        i = scopes[i].parent?;
    }
}

/// Script expressions end at an outer semicolon or an unindented next line.
/// Keep bracketed bodies and indented continuations together so a name on a
/// continuation line is not mistaken for a standalone global read.
fn top_level_statements<'a>(code: &'a str, raw: &str) -> Vec<(usize, &'a str)> {
    let mut statements = vec![];
    let (mut start, mut at, mut depth) = (0, 0, 0);
    for line in code.split_inclusive('\n') {
        if depth == 0 && !raw[at..].starts_with([' ', '\t']) {
            statements.push((start, &code[start..at]));
            start = at;
        }
        if depth == 0 && crate::system_command(&raw[at..]) {
            at += line.len();
            start = at;
            continue;
        }
        // A `\t` line's statement is the expression after the command (#312).
        if depth == 0 && start == at {
            start += crate::timed_prefix(&raw[at..]);
        }
        for (i, b) in line.bytes().enumerate() {
            match b {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                b';' if depth == 0 => {
                    statements.push((start, &code[start..at + i]));
                    start = at + i + 1;
                }
                _ => {}
            }
        }
        at += line.len();
    }
    statements.push((start, &code[start..]));
    statements
}

/// A glyph applied with brackets to two whole slots, `+[l;r]`, is the infix
/// `l+r`, and fails the same way: q 5 `+[1;`a]` and `=[1;`a]` are 'type,
/// `+[1 2 3;4 5]` and `![`a`b;1 2 3]` 'length. Only literal slots are read,
/// so this is QT003, QT015, QT006, QT023 and QT001 for the bracket spelling -
/// the length first, since q 5 checks it first (`+[`a`b;1 2 3]` is 'length).
/// The same call spelled `(+)[l;r]`, `+'[l;r]` or with a word operator,
/// `mod[l;r]`, fails alike (q 5, #604).
fn glyph_brackets(path: &str, raw: &str, code: &str, out: &mut Vec<Finding>) {
    let symbol = |s: &str| re!(r"^(?:`\.?[A-Za-z][A-Za-z0-9_.:]*)+$").is_match(s);
    let number =
        |s: &str| re!(r"^-?\.?\d[A-Za-z0-9.:]*(?:[ \t]+-?\.?\d[A-Za-z0-9.:]*)*$").is_match(s);
    for m in re!(
        r"\((?P<p><=|>=|<>|[+\-*%&|=<>^!])\)\[|(?P<g><=|>=|<>|[+\-*%&|=<>^!])(?P<e>')?\[|\b(?P<w>and|or|mod|div|xexp|xlog)(?P<we>')?\["
    )
    .captures_iter(code)
    {
        let glyph = m.name("p").or(m.name("g")).or(m.name("w")).unwrap();
        let whole = m.get(0).unwrap();
        if m.name("w").is_some() && (!boundary(code, whole.start()) || code[..whole.start()].ends_with('`')) {
            continue;
        }
        let open = whole.end() - 1;
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = crate::slots(&code[open + 1..close - 1]);
        let [l, r] = parts[..] else {
            continue;
        };
        // Strings are blank in `code`: whether a slot is empty, and a
        // string's kind, are read from the source at the same offsets.
        let (raw_l, raw_r) = (
            raw[open + 1..open + 1 + l.len()].trim(),
            raw[open + 2 + l.len()..close - 1].trim(),
        );
        let (l, r) = (l.trim(), r.trim());
        if raw_l.is_empty() || raw_r.is_empty() || re!(r"\n\S").is_match(&code[open..close]) {
            continue;
        }
        let g = glyph.as_str();
        let text = &raw[whole.start()..close];
        let arithmetic = ["+", "-", "*", "%", "&", "|", "and", "or", "mod", "div", "xexp", "xlog"];
        let char_refused = matches!(g, "+" | "-" | "*")
            && match (arithmetic_kind(raw_l), arithmetic_kind(raw_r)) {
                (Some(a), Some(b)) => {
                    let refused = if g == "-" {
                        a == Arithmetic::Char
                    } else {
                        a == Arithmetic::Char || b == Arithmetic::Char
                    };
                    refused && a != Arithmetic::Float && b != Arithmetic::Float
                }
                _ => false,
            };
        let (code, detail) = match (shape(l), shape(r)) {
            (Some(k), Some(v)) if g == "!" && k >= 2 && k != v => (
                "QT001",
                format!("Literal dictionary has {k} keys and {v} values"),
            ),
            (Some(a), Some(b)) if g != "!" && a >= 2 && b >= 2 && a != b => (
                "QT006",
                format!("`{g}` pairs a {a}-vector with a {b}-vector; that is a 'length error"),
            ),
            _ if arithmetic.contains(&g) && (symbol(l) || symbol(r)) => (
                "QT003",
                "Arithmetic on a symbol literal is a 'type error at runtime".into(),
            ),
            _ if ["=", "<", ">", "<=", ">=", "<>"].contains(&g)
                && ((symbol(l) && number(r)) || (number(l) && symbol(r))) =>
            {
                (
                    "QT015",
                    format!(
                        "`{text}` is 'type: a symbol compares with a symbol, not with a number or a string"
                    ),
                )
            }
            _ if char_refused => (
                "QT023",
                format!("`{text}` is 'type: q 5 does no integer arithmetic on a char"),
            ),
            _ => continue,
        };
        out.push(Finding::at(path, raw, whole.start(), code, detail));
    }
}

fn shape(s: &str) -> Option<usize> {
    let s = s.trim();
    if re!(r"\n\S").is_match(s) {
        return None;
    }
    // `(1;2;3)` is a three-item list, however its items are shaped, and
    // `(1 2 3)` is the same vector as without the parentheses. Only a
    // top-level `;` makes a list; so count those. A loop, so that deep
    // nesting cannot overflow the stack, and only as deep as q parses (#703).
    let mut s = s;
    for depth in 0.. {
        if !(s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len())) {
            break;
        }
        if depth == crate::MAX_NESTING {
            return None;
        }
        let inner = &s[1..s.len() - 1];
        // A table literal's `;` separate columns, and its length is its
        // rows: q 5 builds `([]a:1 2 3;b:4 5 6)!(1;2;3)` (#667).
        if inner.trim_start().starts_with('[') {
            return None;
        }
        let items = crate::slots(inner);
        if items.len() > 1 {
            return Some(items.len());
        }
        s = inner.trim();
    }
    if let Some(rest) = s.strip_prefix("enlist ") {
        return shape(rest).map(|_| 1);
    }
    // A byte vector: `0x` and a run of hex digits, two per item, an odd
    // first one padded (q 5: `0x012` is `0x0012`, and `0x` the empty byte
    // vector). With one or two digits it is an atom, which `Shape` reports
    // as a one-item vector the way a lone number is - the length check
    // treats both alike.
    if let Some(hex) = s.strip_prefix("0x")
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Some(hex.len().div_ceil(2));
    }
    // A boolean vector is one token, a digit per item: `10b` is two.
    if re!(r"^[01]+b$").is_match(s) {
        return Some(s.len() - 1);
    }
    // An empty symbol is an item too: `` `x`y` `` is three.
    if re!(r"^(?:`(?:[A-Za-z][A-Za-z0-9_.]*)?)+$").is_match(s) {
        return Some(s.bytes().filter(|&b| b == b'`').count());
    }
    // Numbers, a null or an infinity among them: `0N 0N` is two items and
    // `0W 1` two, as q 5's 'length on `` `a`b`c!0N 0N `` and `0W 1+1 2 3` shows.
    // A type suffix ends the run: q 5 parses `1 2h` as one vector, but `1h 2`
    // does not parse and `1 0b` is the atom `1` applied to `0b` (#496).
    if re!(r"^(?:-?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|0[nNwW])\s+)*-?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[hijef]?|0[nNwW][a-z]?)$")
        .is_match(s)
    {
        return Some(s.split_whitespace().count());
    }
    // Temporal items, digits joined by `.`, `:`, `D` or `T`: `2024.01.01`,
    // `2024.01m`, `12:30`, `0D00:01`, `2024.01.01D12:00`.
    if re!(r"^(?:-?\d+(?:[.:DT]\d*)+[a-z]?(?:\s+|$))+$").is_match(s) {
        return Some(s.split_whitespace().count());
    }
    None
}

/// The items in a string literal, read from the view that keeps strings: a
/// byte each, an escape one item - `"a\"c"` and `"\101bc"` are three.
fn string_items(s: &str) -> Option<usize> {
    let inner = s.trim().strip_prefix('"')?.strip_suffix('"')?.as_bytes();
    let (mut i, mut n) = (0, 0);
    while i < inner.len() {
        i += match inner[i] {
            b'"' => return None,
            b'\\'
                if inner[i + 1..].len() >= 3
                    && inner[i + 1..i + 4].iter().all(u8::is_ascii_digit) =>
            {
                4
            }
            b'\\' if i + 1 < inner.len() => 2,
            b'\\' => return None,
            _ => 1,
        };
        n += 1;
    }
    Some(n)
}
/// The context a top-level line switches to, if it switches: `""` for the
/// root. `code_line` and `raw_line` are the same line in the two views.
///
/// Either spelling switches, and q 5 agrees on both: after `system "d .b"`
/// and `k:{1}`, `key `.b` is ``k, and `\d .c  / note` opens `.c` as `\d .c`
/// does. The `system` form is read only with a literal argument - a computed
/// one, `system "d ",x`, names a context no reading can know, and the
/// context in force is left as it was rather than guessed.
pub(crate) fn opens(code_line: &str, raw_line: &str) -> Option<String> {
    // q reads `q)\d .foo` as `\d .foo`; `views` has blanked the prompt (#315).
    let code_line = if raw_line.starts_with("q)") {
        &code_line[2..]
    } else {
        code_line
    };
    let ns = if let Some(m) =
        re!(r"^\\d[ \t]+(\.[\w.]*)(?:[ \t]+/.*)?[ \t\r]*\n?$").captures(code_line)
    {
        m.get(1)
    } else if re!(r"^system\b").is_match(code_line) {
        re!(r#"^system[ \t]*"d[ \t]+(\.[\w.]*)[ \t]*""#)
            .captures(raw_line)?
            .get(1)
    } else {
        None
    };
    Some(ns?.as_str().trim_end_matches('.').into())
}
/// The namespace in force from each offset on, as `scopes` reads it.
pub(crate) fn contexts(code: &str, raw: &str) -> Vec<(usize, String)> {
    scopes(code, raw).1
}
/// Every lambda in the file, with what it binds, and the namespace in force
/// at each line. Shared by the checks and by the editor's semantic tokens,
/// which have to agree about what a name in a body refers to.
fn scopes(code: &str, raw: &str) -> (Vec<Scope>, Vec<(usize, String)>) {
    let assignment = re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*:(:)?");
    let mut scopes: Vec<Scope> = vec![];
    let mut stack: Vec<usize> = vec![];
    // Braces past q's own limit open no scope of their own: q refuses the
    // file (#717), and each scope keeps a copy of its body, so a nest of n
    // lambdas cost n^2 bytes - 4 GB for a 128 KB file (#704). Their text
    // stays in the deepest scope's body.
    let mut beyond = 0usize;
    let mut namespace = String::new();
    let mut namespaces = vec![];
    let mut offset = 0;
    for line in code.split_inclusive('\n') {
        if stack.is_empty()
            && let Some(ns) = opens(line, &raw[offset..offset + line.len()])
        {
            namespace = ns;
        }
        namespaces.push((offset, namespace.clone()));
        // A later statement on the line switches too, from where it ends:
        // q 5 ends `system "d .ns";system "d .";lim:1` at the root, `lim`
        // and all (#767).
        if stack.is_empty() {
            let raw_line = &raw[offset..offset + line.len()];
            for m in re!(r#";[ \t]*system[ \t]*"d[ \t]+(\.[\w.]*)[ \t]*""#).captures_iter(raw_line)
            {
                let at = m.get(0).unwrap().start();
                let depth = line[..at].bytes().fold(0i32, |d, b| match b {
                    b'(' | b'[' | b'{' => d + 1,
                    b')' | b']' | b'}' => d - 1,
                    _ => d,
                });
                if depth == 0 && line[at..].starts_with(';') {
                    namespace = m[1].trim_end_matches('.').into();
                    namespaces.push((offset + m.get(0).unwrap().end(), namespace.clone()));
                }
            }
        }
        // `\t` and `\ts` run their argument as q, lambdas and all (#312).
        if crate::system_command(&raw[offset..]) {
            offset += line.len();
            continue;
        }
        for (i, b) in line.bytes().enumerate() {
            let at = offset + i;
            if b == b'{' && stack.len() >= crate::DEPTH {
                beyond += 1;
            } else if b == b'}' && beyond > 0 {
                beyond -= 1;
            } else if b == b'{' {
                let sig = signature(code, raw, at);
                // When the brackets are not a parameter list q binds the
                // implicit arguments instead, and so must the scope here.
                let params = if sig.named {
                    sig.slots
                        .iter()
                        .flat_map(|p| crate::pattern_names(p))
                        .map(str::to_string)
                        .collect()
                } else {
                    ["x", "y", "z"].into_iter().map(str::to_string).collect()
                };
                let (named, body) = (sig.named, sig.body);
                scopes.push(Scope {
                    start: at,
                    end: code.len(),
                    body,
                    named,
                    parent: stack.last().copied(),
                    namespace: namespace.clone(),
                    params,
                    locals: HashSet::new(),
                    direct: String::new(),
                });
                stack.push(scopes.len() - 1);
            } else if b == b'}'
                && let Some(s) = stack.pop()
            {
                scopes[s].end = at;
            }
        }
        offset += line.len();
    }
    // A typed slot left open swallows the closing brace, `{[a:}]`, and the
    // body is then found past the lambda's end (#732). q refuses it and
    // QE001 reports it; the scope is only kept from slicing backwards.
    for scope in &mut scopes {
        scope.body = scope.body.min(scope.end);
    }
    // Children by parent, in one pass. Asking every scope about every scope is
    // quadratic in the number of lambdas, which a file of a few thousand
    // reaches on every keystroke.
    let mut children: Vec<Vec<usize>> = vec![vec![]; scopes.len()];
    for (i, scope) in scopes.iter().enumerate() {
        if let Some(parent) = scope.parent {
            children[parent].push(i);
        }
    }
    for i in 0..scopes.len() {
        let scope = &scopes[i];
        let mut direct = code.as_bytes()[scope.body..scope.end].to_vec();
        for &c in &children[i] {
            let child = &scopes[c];
            // An unclosed lambda runs to the end of the file, and so does an
            // unclosed one around it: `f:{g:{` is two scopes ending at the
            // same byte, and the child's closing brace is not there to blank.
            // The checks never see such a file - QE001 stops them - but the
            // editor's semantic tokens are asked for mid-keystroke.
            // A lambda in a typed slot, `{[a:{x+1}] a}`, sits before the
            // body (#437).
            let end = (child.end + 1).min(scope.end).max(scope.body);
            direct[child.start.max(scope.body) - scope.body..end - scope.body].fill(b' ');
        }
        let direct = String::from_utf8(direct).unwrap();
        // A column is not a local: after `t:([]c:1 2)` or `update c:1 from t`,
        // `c` is still the global. Verified in q 5, with `c:10`:
        // `{t:([]c:1 2); {c+1}[]}[]` is 11, and `{[a] t:([]x:1 2); x}[1]` is 'x.
        let view = local_view(&direct, true);
        let mut locals = scope.params.clone();
        for a in assignment.captures_iter(&view) {
            if boundary(&view, a.get(0).unwrap().start())
                && a.get(2).is_none()
                && !a[1].contains('.')
            {
                locals.insert(a[1].into());
            }
        }
        locals.extend(multi_assignments(&view).map(|(_, n)| n.to_string()));
        scopes[i].direct = direct;
        scopes[i].locals = locals;
    }
    (scopes, namespaces)
}
/// What a name in the source means, for an editor's semantic tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    /// A call site, or any other read, of a lambda this file assigns.
    Function,
    /// A declared parameter read inside the body that declares it.
    Parameter,
}

/// Names the editor can colour by meaning rather than by shape: the uses of
/// functions this file defines, and of parameters inside their own body.
/// Byte offset and byte length into the source, in order.
///
/// The same limits as the checks. A function defined in another file, or by
/// `\l`, is not known here; and q has no closures, so a name read in a nested
/// lambda is that lambda's own, never the parameter of the one around it.
pub fn tokens(code: &str, raw: &str, ws: &crate::Workspace) -> Vec<(usize, usize, TokenKind)> {
    let (scopes, namespaces) = scopes(code, raw);
    let ns_at = |at: usize| {
        namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1
        .as_str()
    };
    let name = re!(r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*");
    // A global is a function when every assignment to it is a lambda that
    // the statement ends with - `f:{...} each x` assigns a list, as QA012's
    // rank table already knows - or a projection of one, as `index` decides:
    // q 5's `p:{[a;b] a+b}[1;]` is type 104h and `p 2` is 3 (#367). The
    // writes are `global_writes`', which a table column or a qSQL alias is
    // not: after `t:([] f:1 2)`, q 5's `f` is still the lambda (#365).
    let lambda: HashMap<String, bool> =
        global_writes(code, raw, &scopes, &namespaces, resolved, true)
            .into_iter()
            .map(|(key, at)| (key, at.iter().all(|&at| assigns_lambda(code, raw, at))))
            .collect();
    // In a qSQL phrase a name is a column whenever the table has one by
    // that name - q 5's `select f from t` is the column even where `f` is a
    // lambda - and only the table says which, so none is coloured (#552).
    let outside_queries = crate::outside_query_phrases(code);
    let mut out = vec![];
    for m in name.find_iter(code) {
        if !boundary(code, m.start()) || outside_queries.as_bytes()[m.start()] == b' ' {
            continue;
        }
        // A system command's argument is no q: `\l f/a.q` names a file,
        // whatever lambda `f` is (#553).
        let line = code[..m.start()].rfind('\n').map_or(0, |p| p + 1);
        if crate::system_command(&raw[line..]) {
            continue;
        }
        // The assignment itself is the grammar's to colour, as a definition.
        if code[m.end()..]
            .trim_start_matches([' ', '\t'])
            .starts_with(':')
        {
            continue;
        }
        // A local or parameter of the same name hides the global.
        if let Some(s) = scope_at(&scopes, m.start())
            && scopes[s].locals.contains(m.as_str())
        {
            continue;
        }
        // Keyed as q resolves it: a root `f` is not `.f` (#1243).
        let name = resolved(m.as_str(), ns_at(m.start()));
        // This file's own assignment decides; failing one, another file's
        // lambda of that name is the function a call here reaches - that
        // name and no other: q 5 does not fall back from `\d .ns` to a root
        // `f`, and `m:f 2` there is 'f (#366).
        let function = match lambda.get(&name) {
            Some(&is_lambda) => is_lambda,
            None => ws.is_lambda(&name),
        };
        if function {
            out.push((m.start(), m.len(), TokenKind::Function));
        }
    }
    for scope in scopes.iter().filter(|s| s.named) {
        let direct = &scope.direct;
        // A column is no parameter: KDB-X's `{[n] select n from t}` and
        // `{[a] update a:a+1 from t}` read t's columns, and `([]a:1 2)`
        // names one (#1242).
        let view = crate::table_columns_blanked(&crate::outside_query_phrases(direct));
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(direct) {
            if boundary(direct, m.start())
                && view.as_bytes()[m.start()] != b' '
                && !direct[m.end()..].starts_with('.')
                && scope.params.contains(m.as_str())
            {
                out.push((scope.body + m.start(), m.len(), TokenKind::Parameter));
            }
        }
    }
    out.sort_by_key(|t| t.0);
    out.dedup_by_key(|t| t.0);
    out
}

/// Whether the symbol `name`, handed to `get`, `value` or `set` at `at`, is
/// resolved in a namespace the source does not say. A name in a lambda's
/// text is fixed when the lambda is defined, but a symbol is looked up when
/// it runs, in the `\d` current at the call: after `\d .a`, `p:{get `k}`,
/// `\d .`, q 5's `.a.p[]` reads the root `k`, not `.a.k`. A lambda written
/// at the root is taken to be called there too.
fn call_time(scopes: &[Scope], at: usize, name: &str) -> bool {
    !name.starts_with('.') && scope_at(scopes, at).is_some_and(|s| !scopes[s].namespace.is_empty())
}

/// Global names, each with where its assignments' values start.
type Writes = HashMap<String, Vec<usize>>;
/// Every name this file assigns at global scope, qualified by the namespace
/// in force, with where each assignment's value starts. `call_time_sets`
/// credits a `` `n set `` inside a `\d` lambda both to the namespace it is
/// written in and to the root, where a call most likely lands it (q 5:
/// `\d .ns`, `init:{`lim set 100}`, `\d .`, then `.ns.init[]` sets the root
/// `lim`, #765) - generous, and right for the checks, which only ask whether
/// a name has a definition; the graph says it cannot know instead.
fn global_writes(
    code: &str,
    raw: &str,
    scopes: &[Scope],
    namespaces: &[(usize, String)],
    qualify: fn(&str, &str) -> String,
    call_time_sets: bool,
) -> HashMap<String, Vec<usize>> {
    let assignment = re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*:(:)?");
    let ns_at = |at: usize| {
        namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1
        .as_str()
    };
    // Where a symbol written at `at` is set: the namespace in force, and for
    // one resolved at call time the root too - or nowhere, without
    // `call_time_sets`.
    let set_targets = |name: &str, at: usize| -> Vec<String> {
        if !call_time(scopes, at, name) {
            vec![qualify(name, ns_at(at))]
        } else if call_time_sets {
            vec![qualify(name, ns_at(at)), qualify(name, "")]
        } else {
            vec![]
        }
    };
    // Column names are written the way assignments are, and assign nothing:
    // `([k:()] handle:())` and `select a:x from t` define no global `handle`
    // or `a`. TorQ has a table column named handle in two files, and read as
    // globals those hid a real undefined-name finding in a third. So table
    // and dictionary literals, and qSQL phrases to the end of their
    // statement, are blanked before the search; offsets stay where they were.
    let mut view = code.as_bytes().to_vec();
    for (open, _) in code.match_indices('(') {
        if code[open + 1..].trim_start().starts_with('[')
            && let Some(close) = matching(code, open, b'(', b')')
            && !destructures(&code[close..])
        {
            blank(&mut view[open + 1..close - 1]);
        }
    }
    // A keyword inside a range already blanked ends no later than it, so it
    // is passed over: `select from select from t` scanned to the statement's
    // end once per keyword (#709).
    let mut blanked = 0;
    for m in re!(r"\b(?:select|exec|update|delete)\b").find_iter(code) {
        // The keyword, not the end of a dotted name: `clust.kmeans.update:{...}`
        // defines a function KX ml calls, and `\b` alone would blank it.
        if m.start() < blanked || !boundary(code, m.start()) {
            continue;
        }
        let (mut at, mut depth) = (m.start(), 0i32);
        let bytes = code.as_bytes();
        while at < bytes.len() {
            match bytes[at] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                b';' if depth == 0 => break,
                b'\n' if depth == 0 && !code[at + 1..].starts_with([' ', '\t']) => break,
                _ => {}
            }
            at += 1;
        }
        blank(&mut view[m.start()..at]);
        blanked = at;
    }
    let code = std::str::from_utf8(&view).unwrap_or(code);
    let mut globals: HashMap<String, Vec<usize>> = HashMap::new();
    for a in assignment.captures_iter(code) {
        let m = a.get(0).unwrap();
        if !boundary(code, m.start()) {
            continue;
        }
        // `::` assigns a parameter or local where the lambda has one: q 5
        // `g:{[b] b::7; b}; g 1` is 7 and leaves no global `b`.
        let local =
            || scope_at(scopes, m.start()).is_some_and(|s| scopes[s].locals.contains(&a[1]));
        // A `::` with nothing after it composes, `f[1] count::`, and assigns
        // nothing - unless it is the whole line: q 5 defines `a` for a line
        // `a::`, and reads it for `x:1;a::`, `{a::}` and `d:a::` (#764).
        // Read in `raw`: `code` here has strings and qSQL blanked, and
        // `LAST::""` and `t::update a:1 from t` assign.
        let after = &raw[m.end()..];
        let mut value = after.trim_start_matches([' ', '\t', '\r']);
        if value.starts_with('/') && value.len() < after.len() {
            value = value.find('\n').map_or("", |i| &value[i..]);
        }
        let continued = value.starts_with('\n') && value[1..].starts_with([' ', '\t']);
        if a.get(2).is_some()
            && (value.is_empty() || value.starts_with([';', '\n', ')', ']', '}']))
            && !continued
            && !((m.start() == 0 || raw[..m.start()].ends_with('\n'))
                && (value.is_empty() || value.starts_with('\n')))
        {
            continue;
        }
        if scope_at(scopes, m.start()).is_none()
            || (a.get(2).is_some() && !local())
            || a[1].contains('.')
        {
            globals
                .entry(qualify(&a[1], ns_at(m.start())))
                .or_default()
                .push(m.end());
        }
    }
    // An operator assignment, `a,:1` or `a+:1`, writes the name too. Inside a
    // lambda it does not make the name local: q 5 gives 5 for
    // `a:5; {r:a; a+:1; r}[]`, and `{c,:1; c}` writes the global `c` - so
    // only a name the lambda has no plain `name:` local of is a global write.
    // `/:` and `\:` are adverbs, `_` and `.` continue a name, and `::` is a
    // view or a global assignment, which the pass above holds.
    for a in re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*[-+*%&|^=<>,#~!?@$]:")
        .captures_iter(code)
    {
        let m = a.get(0).unwrap();
        if !boundary(code, m.start()) || code[m.end()..].starts_with(':') {
            continue;
        }
        let local = scope_at(scopes, m.start()).is_some_and(|s| scopes[s].locals.contains(&a[1]));
        if !local {
            globals
                .entry(qualify(&a[1], ns_at(m.start())))
                .or_default()
                .push(m.end());
        }
    }
    // `` `n set ``, and `` `t insert `` and `` `t upsert ``, which create the
    // table when there is none (q 5: `` `t insert ([]a:1 2) `` then `t`).
    // The target may be parenthesised: q 5 `` (`e) set 5 `` defines `e` (#363),
    // but `` (` sv ns,`run) set f `` defines no `run` (#860).
    for m in re!(r"`(\.?[A-Za-z][A-Za-z0-9_.]*)(?:\s+|\s*\)\s*)(?:set|insert|upsert)\b|\b(?:set|insert|upsert)\s*\[\s*`(\.?[A-Za-z][A-Za-z0-9_.]*)")
        .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        let name = m.get(1).or(m.get(2)).unwrap();
        if !literal_target(code, name.start() - 1, &code[name.end()..whole.end()]) {
            continue;
        }
        for target in set_targets(name.as_str(), whole.start()) {
            globals.entry(target).or_default().push(whole.end());
        }
    }
    // `` load `:k `` defines the global its path ends in (#470).
    for m in re!(LOAD).captures_iter(code) {
        let whole = m.get(0).unwrap();
        if !boundary(code, whole.start()) {
            continue;
        }
        for target in set_targets(&m[1], whole.start()) {
            globals.entry(target).or_default().push(whole.end());
        }
    }
    // So does `\l` of a table's directory or file: q 5's `.Q.lo` sets the
    // last part of the path, and `\l data/trades` defines `trades` (#534).
    // Not a script, `\l x.q`, whose name defines nothing.
    for (at, rest) in load_lines(code, raw) {
        if let Some(m) =
            re!(r"^[ \t]+(?:\S*/)?([A-Za-z][A-Za-z0-9_]*)/?[ \t\r]*\n?$").captures(rest)
        {
            globals
                .entry(qualify(&m[1], ns_at(at)))
                .or_default()
                .push(at + rest.len());
        }
    }
    // Each of a symbol list, `` `p`q set'1 2 ``, parenthesised too (#464).
    for (whole, names) in each_set_targets(code) {
        for name in names {
            for target in set_targets(name, whole.start) {
                globals.entry(target).or_default().push(whole.end);
            }
        }
    }
    // A functional amend that creates the global it names: `@[`.;`n;:;v]`
    // through its context, always that context whatever `\d` is in force,
    // and `.[`n;();:;v]` over the whole value. q 5 runs `@[`.;`foo;:;1]`
    // and `.[`bar;();:;2]` with neither defined, then reads both (#362).
    // Through a context with any function, and by `.` with the names
    // enlisted, it writes the name as `named_values` takes it: q 5
    // `@[`.;`v;,;4]` makes `v:1 2 3` four items (#758).
    for m in re!(
        r"[@.]\s*\[\s*`(\.(?:[A-Za-z][A-Za-z0-9_.]*)?)\s*;\s*(?:enlist\b\s*|\(\s*)*((?:`[A-Za-z][A-Za-z0-9_]*)+)\s*\)?\s*;"
    )
    .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        for name in m[2].split('`').skip(1) {
            let name = match &m[1] {
                "." => qualify(name, ""),
                ctx => format!("{ctx}.{name}"),
            };
            globals.entry(name).or_default().push(whole.end());
        }
    }
    for m in re!(r"\.\s*\[\s*`(\.?[A-Za-z][A-Za-z0-9_.]*)\s*;\s*\(\s*\)\s*;").captures_iter(code) {
        let whole = m.get(0).unwrap();
        if code[..whole.start()]
            .ends_with(|c: char| c.is_ascii_alphanumeric() || "_.)]}".contains(c))
        {
            continue;
        }
        for target in set_targets(&m[1], whole.start()) {
            globals.entry(target).or_default().push(whole.end());
        }
    }
    // A member of a namespace assigned by a literal index: q 5
    // `.cfg[`a]:1 2 3` defines `.cfg.a`.
    for m in re!(r"(\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\[\s*((?:`[A-Za-z][A-Za-z0-9_]*)+)\s*\]\s*:")
        .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        if !boundary(code, whole.start()) || code[whole.end()..].starts_with(':') {
            continue;
        }
        for name in m[2].split('`').skip(1) {
            globals
                .entry(format!("{}.{name}", &m[1]))
                .or_default()
                .push(whole.end());
        }
    }
    for (at, name) in multi_assignments(code)
        .filter(|&(at, _)| scope_at(scopes, at).is_none())
        .chain(global_multi_assignments(code))
    {
        let close = matching(code, at, b'(', b')').unwrap_or(at);
        let colon = close + code[close..].find(':').unwrap() + 1;
        let end = colon + usize::from(code[colon..].starts_with(':'));
        globals
            .entry(qualify(name, ns_at(at)))
            .or_default()
            .push(end);
    }
    globals
}

/// What one file defines for the files around it: its global names, and
/// which of them it assigns a lambda. Read, never run - the same passes the
/// checks use, stopped before any rule.
/// Each `\l` line, with where it starts and what follows the `\l` in the
/// code view. `q)\l b.q` loads as `\l b.q` does (q 5), though `views` has
/// blanked the prompt (#536).
fn load_lines<'a>(code: &'a str, raw: &'a str) -> impl Iterator<Item = (usize, &'a str)> {
    let mut offset = 0;
    code.split_inclusive('\n').filter_map(move |line| {
        let at = offset;
        offset += line.len();
        let prompt = if raw[at..].starts_with("q)") { 2 } else { 0 };
        line[prompt..].strip_prefix("\\l").map(|rest| (at, rest))
    })
}

/// The global each `k)` line assigns at its start, `k)lim:100`, under the
/// `\d` in force: k assigns q's globals, though both views blank the line.
fn k_writes(raw: &str, namespaces: &[(usize, String)]) -> Vec<String> {
    re!(r"(?m)^k\)\s*(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*:")
        .captures_iter(raw)
        .map(|m| {
            let at = m.get(0).unwrap().start();
            let ns = &namespaces[namespaces
                .partition_point(|(p, _)| *p <= at)
                .saturating_sub(1)]
            .1;
            resolved(&m[1], ns)
        })
        .collect()
}

pub fn index(code: &str, raw: &str) -> crate::FileIndex {
    let (scopes, namespaces) = scopes(code, raw);
    let mut globals = global_writes(code, raw, &scopes, &namespaces, resolved, true);
    for name in k_writes(raw, &namespaces) {
        globals.entry(name).or_default();
    }
    // A table changed in place is written too, as the file's own checks
    // take it: with b.q's `update c:0 from `t` loaded, a.q's
    // `f:{select c from t}` runs (q 5, #756), and after `` `a xkey `k ``
    // there, `x lj k` joins (#757).
    for m in re!(IN_PLACE).captures_iter(code) {
        let at = m.get(0).unwrap().start();
        let ns = &namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1;
        globals.entry(resolved(&m[1], ns)).or_default();
    }
    let lambdas = globals
        .iter()
        .filter(|(_, at)| at.iter().any(|&a| assigns_lambda(code, raw, a)))
        .map(|(name, _)| name.clone())
        .collect();
    crate::FileIndex {
        defined: globals.into_keys().collect(),
        lambdas,
    }
}

/// Where the file first switches context. Before it the file runs in the
/// context it is loaded in, which the file does not say.
fn first_switch(code: &str, raw: &str) -> usize {
    let mut offset = 0;
    code.split_inclusive('\n')
        .find_map(|line| {
            let at = offset;
            offset += line.len();
            opens(line, &raw[at..at + line.len()]).map(|_| at)
        })
        .unwrap_or(code.len())
}

/// The global names a file reads, the scripts it loads by a literal path, and
/// the places reading it cannot see through. The other half of `index`, for
/// the dependency graph: read, never run, with the same scopes and the same
/// `\d` contexts the checks use, stopped before any rule.
///
/// A name, read or defined, is kept as the one name q resolves it to: `f`
/// inside `\d .a` is `.a.f` and nothing else. q 5 does not fall back to the
/// root: after `f:{42}`, `\d .a`, `g:{f[]}`, calling `.a.g[]` is 'f. Which
/// file defines it is the graph's question, since the answer is in other
/// files.
/// `code` with its system commands blanked. `\d .a` and `\l x.q` are not
/// expressions: `.a` there is a context being opened, not a read. Offsets
/// stay where they were.
fn commands_blanked(code: &str, raw: &str) -> String {
    let mut view = code.as_bytes().to_vec();
    let mut offset = 0;
    for line in code.split_inclusive('\n') {
        if crate::system_command(&raw[offset..]) {
            blank(&mut view[offset..offset + line.len()]);
        } else {
            // `\t`'s argument is an expression; only the command is not (#312).
            blank(&mut view[offset..offset + crate::timed_prefix(&raw[offset..])]);
        }
        offset += line.len();
    }
    String::from_utf8(view).unwrap_or_default()
}

pub fn references(code: &str, raw: &str, symbols: bool) -> crate::References {
    let (scopes, namespaces) = scopes(code, raw);
    let first_switch = first_switch(code, raw);
    let ns_at = |at: usize| {
        namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1
        .as_str()
    };
    let view = commands_blanked(code, raw);
    // A symbol literal names nothing it reads, and runs on past where a name
    // would stop: over `:` anywhere, and over `/` after `` `: ``. Verified
    // with parse in q 5: "`a:b" and "`:hdb/sym" are each one symbol. Left in,
    // `` `:hdb/sym `` would read `hdb` and `sym`.
    let mut unsymbolled = view.as_bytes().to_vec();
    for m in re!(r"`(?::[A-Za-z0-9_.:/]*|[A-Za-z0-9_.:]*)").find_iter(&view) {
        blank(&mut unsymbolled[m.range()]);
    }
    let unsymbolled = String::from_utf8(unsymbolled).unwrap_or_default();
    let mut names: HashSet<String> = HashSet::new();
    let mut relative: HashSet<crate::Relative> = HashSet::new();
    let mut read = |name: &str, at: usize| {
        let key = resolved(name, ns_at(at));
        if !name.starts_with('.') {
            relative.insert(crate::Relative {
                name: name.into(),
                resolved: key.clone(),
                implicit: at < first_switch,
            });
        }
        names.insert(key);
    };
    let name = re!(r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*");
    for m in name.find_iter(&unsymbolled) {
        if !boundary(&unsymbolled, m.start()) {
            continue;
        }
        // An assignment, `f:` or `f::`, is the definition `index` reads.
        if view[m.end()..]
            .trim_start_matches([' ', '\t'])
            .starts_with(':')
        {
            continue;
        }
        if !m.as_str().contains('.')
            && scope_at(&scopes, m.start()).is_some_and(|s| scopes[s].locals.contains(m.as_str()))
        {
            continue;
        }
        read(m.as_str(), m.start());
    }
    // A symbol handed straight to `get` or `value` names the global it reads
    // as plainly as writing the name would - unless it is resolved at call
    // time, in a `\d` the source does not say; then, and for a `set` into
    // one, the place is listed as dynamic.
    let mut call_time_access = vec![];
    // Bracketed or parenthesised too: q 5 `(get[`cfg];value[`cfg];get (`cfg))`
    // is 5 5 5 after `cfg:5` (#537).
    for m in re!(
        r"\b(get|value)\s*(?:([\[(])\s*)?`(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)"
    )
    .captures_iter(&view)
    {
        let whole = m.get(0).unwrap();
        if !boundary(&view, whole.start()) {
            continue;
        }
        let mut rest = view[whole.end()..].trim_start_matches([' ', '\t']);
        match m.get(2).map(|o| o.as_str()) {
            // `get[`a]` is the whole call, whatever follows it.
            Some("[") if rest.starts_with(']') => rest = "",
            Some("(") if rest.starts_with(')') => {
                rest = rest[1..].trim_start_matches([' ', '\t']);
            }
            Some(_) => continue,
            None => {}
        }
        // `value `c _ x` is value of what the drop returns, not of `c`.
        if !(rest.is_empty() || rest.starts_with([';', ']', ')', '}', '\n', '\r'])) {
            continue;
        }
        if call_time(&scopes, whole.start(), &m[3]) {
            let kind = if &m[1] == "get" { "get" } else { "value" };
            call_time_access.push((whole.start(), kind));
        } else {
            read(&m[3], whole.start());
        }
    }
    call_time_access.extend(value_of_symbols(&view, &scopes, &ns_at));
    for m in re!(r"`(\.?[A-Za-z][A-Za-z0-9_.]*)(?:\s+|\s*\)\s*)set\b|\bset\s*\[\s*`(\.?[A-Za-z][A-Za-z0-9_.]*)")
        .captures_iter(&view)
    {
        let whole = m.get(0).unwrap();
        if call_time(
            &scopes,
            whole.start(),
            m.get(1).or(m.get(2)).unwrap().as_str(),
        ) {
            call_time_access.push((whole.start(), "set"));
        }
    }
    // `--symbols`: a symbol literal naming a qualified global, `` `.ns.f ``,
    // the way a callback is registered. An unqualified symbol is far more
    // often a column than a function, and is left alone.
    if symbols {
        for m in re!(r"`(\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)").captures_iter(&view)
        {
            names.insert(m[1].to_string());
        }
    }
    let mut names: Vec<_> = names.into_iter().collect();
    names.sort();
    let mut relative: Vec<_> = relative.into_iter().collect();
    relative.sort();
    let writes = global_writes(code, raw, &scopes, &namespaces, resolved, false);
    let mut implicit_defines: Vec<_> = writes
        .iter()
        .filter(|(name, at)| !name.starts_with('.') && at.iter().any(|&a| a < first_switch))
        .map(|(name, _)| name.clone())
        .collect();
    implicit_defines.sort();
    let mut defines: Vec<_> = writes
        .into_keys()
        .chain(k_writes(raw, &namespaces))
        .collect();
    defines.sort();
    defines.dedup();
    let mut moved = vec![];
    crate::References {
        names,
        relative,
        defines,
        implicit_defines,
        loads: loads(
            code,
            raw,
            &view,
            |at| {
                if scope_at(&scopes, at).is_some() || at < first_switch {
                    String::new()
                } else if ns_at(at).is_empty() {
                    ".".into()
                } else {
                    ns_at(at).to_string()
                }
            },
            &mut moved,
        ),
        dynamic: dynamic(raw, &view, &call_time_access, &moved),
    }
}

/// `value` of a symbol the source does not spell out: `value nm` reads the
/// global `nm` names, as `get nm` does - q 5 (KDB-X, `.z.K` 5,
/// `.z.k` 2026.07.23) has `get~value` 1b, both `.:` (#142). But `value` of a
/// dictionary is its values, `value flip t` its columns, `value group x` its
/// indices, and reading cannot tell them apart by `value` alone: listing
/// every `value nm`, as `get nm` is, marked 387 places over the corpus,
/// nearly all dictionaries (#170). So a place is listed only where the
/// source shows the argument is a symbol atom:
///
/// - one built on the spot, `` value `$x `` or `value .Q.dd[...]`;
/// - a name, alone as the argument, that its scope assigns and assigns
///   nothing but a symbol atom, `` `x ``, `` `$... `` or `.Q.dd`. A local is
///   read in its own lambda; a name a lambda does not bind is a global, read
///   from the assignments at the top level of the same `\d`. A parameter
///   could hold anything, and is passed over; so is a name assigned a list,
///   `` `a`b ``, a dictionary, `` `a`b!1 2 ``, or a file, `` `:f ``, anywhere
///   in its scope.
///
/// `` value ` sv ... `` is already listed as `sv`.
fn value_of_symbols<'n>(
    view: &str,
    scopes: &[Scope],
    ns_at: &dyn Fn(usize) -> &'n str,
) -> Vec<(usize, &'static str)> {
    // A symbol atom: `` `$ ``, `.Q.dd`, or `` `name `` ending the expression.
    let symbol = |text: &str| {
        let text = text.trim_start_matches([' ', '\t']);
        text.starts_with("`$")
            || re!(r"^\.Q\.dd\b").is_match(text)
            || re!(r"^`[A-Za-z.][A-Za-z0-9_.]*[ \t]*(?:$|[;\])}\r\n])").is_match(text)
    };
    let assignment = re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*:(:)?");
    // Every assignment's name, with its scope, its namespace and whether it
    // assigns a symbol.
    type Write<'n> = (Option<usize>, &'n str, bool);
    let mut assigned: HashMap<&str, Vec<Write<'n>>> = HashMap::new();
    for a in assignment.captures_iter(view) {
        let whole = a.get(0).unwrap();
        if !boundary(view, whole.start()) {
            continue;
        }
        let after = &view[whole.end()..];
        // `nm::x` inside a lambda assigns the global.
        let scope = if a.get(2).is_some() {
            None
        } else {
            scope_at(scopes, whole.start())
        };
        assigned
            .entry(a.get(1).unwrap().as_str())
            .or_default()
            .push((scope, ns_at(whole.start()), symbol(after)));
    }
    let mut found = vec![];
    for m in re!(r"\bvalue\b").find_iter(view) {
        if !boundary(view, m.start()) {
            continue;
        }
        let after = view[m.end()..].trim_start_matches([' ', '\t']);
        if after.starts_with("`$") || re!(r"^\.Q\.dd\b").is_match(after) {
            found.push((m.start(), "value"));
            continue;
        }
        let (bracket, after) = match after.strip_prefix('[') {
            Some(inner) => (true, inner.trim_start_matches([' ', '\t'])),
            None => (false, after),
        };
        let Some(arg) = re!(r"^[A-Za-z][A-Za-z0-9_]*").find(after) else {
            continue;
        };
        let rest = after[arg.end()..].trim_start_matches([' ', '\t']);
        let ends = if bracket {
            rest.starts_with(']')
        } else {
            rest.is_empty() || rest.starts_with([';', ']', ')', '}', '\r', '\n'])
        };
        if !ends {
            continue;
        }
        let name = arg.as_str();
        let scope = scope_at(scopes, m.start());
        let local = scope.filter(|&s| scopes[s].locals.contains(name));
        if local.is_some_and(|s| scopes[s].params.contains(name)) {
            continue;
        }
        let namespace = ns_at(m.start());
        let writes: Vec<bool> = assigned
            .get(name)
            .into_iter()
            .flatten()
            .filter(|(s, ns, _)| *s == local && (local.is_some() || *ns == namespace))
            .map(|&(_, _, sym)| sym)
            .collect();
        if !writes.is_empty() && writes.iter().all(|&sym| sym) {
            found.push((m.start(), "value"));
        }
    }
    found
}

/// Scripts loaded by a literal path: `\l x.q`, `system "l x.q"`, and a file
/// symbol naming a script, `` `:lib/x.q ``, whatever it is handed to - a
/// project's own loader, `` loadfile`:code/x.q ``, is as plain a load as
/// `\l` and no reading can know its name. Where the path leads is the
/// graph's question: q resolves it against the process's directory, which
/// the source does not name.
///
/// Each comes with the `\d` in force where it is loaded, since the script
/// runs there: after `\d .a`, `\l b.q` with b.q's `ff:{1}`, q 5 has `.a.ff`
/// and no `ff`. Inside a lambda the load runs wherever the lambda is called,
/// taken to be the root.
///
/// A relative path loaded after the script changes directory, `\cd lib` or
/// `system "cd lib"`, is read from a directory the text does not settle: q 5
/// loads lib/x.q for `\cd lib` then `\l x.q` (#763). Its offset goes in
/// `moved` instead, for `dynamic` to list.
fn loads(
    code: &str,
    raw: &str,
    view: &str,
    namespace_at: impl Fn(usize) -> String,
    moved: &mut Vec<usize>,
) -> Vec<(String, String)> {
    let cd = changes_directory(raw, view);
    let mut loads = vec![];
    for (at, path, symbol) in load_sites(code, raw, view) {
        let path = &raw[path];
        if !symbol && at > cd && !path.starts_with('/') {
            moved.push(at);
        } else {
            loads.push((path.to_string(), namespace_at(at)));
        }
    }
    loads.sort();
    loads.dedup();
    loads
}

/// Where the script first changes directory, `\cd lib` or `system "cd lib"`,
/// or past the end when it never does.
fn changes_directory(raw: &str, view: &str) -> usize {
    raw.split_inclusive('\n')
        .scan(0, |offset, line| {
            let at = *offset;
            *offset += line.len();
            Some((at, line))
        })
        .find(|(_, line)| re!(r"^\\cd[ \t]+\S").is_match(line))
        .map(|(at, _)| at)
        .into_iter()
        .chain(
            re!(r#"\bsystem\s*(?:\[\s*|@\s*)?"cd\s+\S"#)
                .find_iter(raw)
                .map(|m| m.start())
                .filter(|&at| view[at..].starts_with("system")),
        )
        .min()
        .unwrap_or(usize::MAX)
}

/// Each literal load `loads` reads: where its statement starts, the bytes of
/// its path, and whether it is a file symbol, which no `\cd` moves.
fn load_sites(code: &str, raw: &str, view: &str) -> Vec<(usize, Range<usize>, bool)> {
    let mut sites = vec![];
    for (at, rest) in load_lines(code, raw) {
        if let Some(m) = re!(r"^\s+(\S+)").captures(rest) {
            let from = rest.as_ptr() as usize - code.as_ptr() as usize;
            let path = m.get(1).unwrap().range();
            sites.push((at, from + path.start..from + path.end, false));
        }
    }
    // Applied with brackets or `@`, or trapped, it loads as well: q 5 loads
    // lib.q for `system["l lib.q"]`, `system@"l lib.q"` and
    // `@[system;"l lib.q";{-1 x}]` (#762).
    for m in re!(r#"(?:\bsystem\s*(?:\[\s*|@\s*)?|@\[\s*system\s*;\s*)"l\s+([^"\s]+)\s*""#)
        .captures_iter(raw)
    {
        let at = m.get(0).unwrap().start();
        // Not the head of a path joined at run time, `system "l dir/",x`,
        // which is a dynamic load, not one of `dir/`.
        let joined = raw[m.get(0).unwrap().end()..]
            .trim_start_matches([' ', '\t'])
            .starts_with(',');
        if view[at..].starts_with(&raw[at..at + 2]) && !joined {
            sites.push((at, m.get(1).unwrap().range(), false));
        }
    }
    // The symbol runs on over `:` and `/`, so `.q` must end it: `` `:x.qd ``
    // and `` `:x.q/y `` name something else.
    for m in re!(r"`:([A-Za-z0-9_./]*\.q)(?:[^A-Za-z0-9_.:/]|$)").captures_iter(view) {
        sites.push((m.get(0).unwrap().start(), m.get(1).unwrap().range(), true));
    }
    sites
}

/// The bytes of each path `references` counts as a load, which a
/// navigation request on one follows to the file it names.
pub fn load_paths(code: &str, raw: &str) -> Vec<Range<usize>> {
    let view = commands_blanked(code, raw);
    let cd = changes_directory(raw, &view);
    load_sites(code, raw, &view)
        .into_iter()
        .filter(|(at, path, symbol)| *symbol || *at <= cd || raw[path.clone()].starts_with('/'))
        .map(|(_, path, _)| path)
        .collect()
}

/// The places a name is reached by a value computed at run time, which no
/// amount of reading resolves: `value "..."`, `get` of anything but a
/// literal, a name built with `` ` sv ``, `set` into a computed name, and a
/// load whose path is concatenated. `view` is the code view with system
/// commands blanked; `raw` says whether a blank was a string. `call_time`
/// holds the literal symbols `call_time` says are resolved where the lambda
/// is called, and the `value`s of a symbol `value_of_symbols` finds, both
/// found by the caller.
fn dynamic(
    raw: &str,
    view: &str,
    call_time: &[(usize, &'static str)],
    moved: &[usize],
) -> Vec<crate::Dynamic> {
    let mut found = vec![];
    let mut push = |at: usize, kind: &'static str| {
        let line = raw.as_bytes()[..at].iter().filter(|&&b| b == b'\n').count() + 1;
        found.push(crate::Dynamic { line, kind });
    };
    for &(at, kind) in call_time {
        push(at, kind);
    }
    for &at in moved {
        push(at, "load");
    }
    let next = |at: usize| view[at..].trim_start_matches([' ', '\t']);
    // Bracketed or parenthesised too: q 5 `value("e5")` is e5 (#538).
    for m in re!(r"\bvalue\b").find_iter(view) {
        if boundary(view, m.start()) && re!(r#"^[ \t]*(?:[\[(][ \t]*)?""#).is_match(&raw[m.end()..])
        {
            push(m.start(), "value");
        }
    }
    // `eval` and `reval` run a parse tree, whose names reading cannot see:
    // q 5 `eval parse "e5+1"` reads e5 (#538).
    for m in re!(r"\br?eval\b").find_iter(view) {
        if boundary(view, m.start()) {
            push(m.start(), "eval");
        }
    }
    // A symbol literal after `get`, bracketed or not, is a read the names
    // already hold (#537), and `` `:path `` or `hsym` reads a file, not a
    // global.
    for m in re!(r"\bget\b").find_iter(view) {
        let after = next(m.end());
        let after = after
            .strip_prefix(['[', '('])
            .map_or(after, |a| a.trim_start_matches([' ', '\t']));
        if boundary(view, m.start())
            && !after.starts_with(['`', ':'])
            && !re!(r"^hsym\b").is_match(after)
        {
            push(m.start(), "get");
        }
    }
    // `` ` sv `` joins parts into a name - or, before `` `: ``, into a path.
    for m in re!(r"`[ \t]+sv\b").find_iter(view) {
        if !next(m.end()).starts_with("`:") {
            push(m.start(), "sv");
        }
    }
    // A literal target is a definition `index` already holds, and `hsym`
    // or `` `: `` a file; anything else is a name computed at run time.
    for m in re!(r"\bset\b").find_iter(view) {
        if !boundary(view, m.start()) || next(m.end()).starts_with(':') {
            continue;
        }
        let target = if let Some(args) = next(m.end()).strip_prefix('[') {
            args.split([';', ']']).next().unwrap_or("").trim()
        } else {
            let before = view[..m.start()].trim_end_matches([' ', '\t']);
            if before.ends_with(')') {
                let close = before.len();
                (0..close)
                    .rev()
                    .filter(|&i| before.as_bytes()[i] == b'(')
                    .find(|&o| matching(before, o, b'(', b')') == Some(close))
                    .map_or("", |o| &before[o..close])
            } else {
                re!(r"[`A-Za-z0-9_.:/]*$")
                    .find(before)
                    .map_or("", |t| t.as_str())
            }
        };
        // A symbol list too, for `` `a`b set' 1 2 ``, which q 5 runs as two
        // literal definitions (#364).
        let literal = re!(r"^\(?\s*(?:`[A-Za-z0-9_.:/]*)+\s*\)?$").is_match(target);
        if !literal && !target.contains("hsym") && !target.contains("`:") {
            push(m.start(), "set");
        }
    }
    for m in
        re!(r#"(?:\bsystem\s*(?:\[\s*|@\s*)?|@\[\s*system\s*;\s*)"l\s[^"]*"\s*,"#).find_iter(raw)
    {
        if view[m.start()..].starts_with(&raw[m.start()..m.start() + 2]) {
            push(m.start(), "load");
        }
    }
    found.sort_by_key(|d| (d.line, d.kind));
    found.dedup();
    found
}

/// Whether the file writes globals its text does not name, so that nothing
/// it assigns by name can be taken as known: a `\l`, `eval`, a `system`
/// command that loads a script or changes `\d` - but a literal
/// `system "d .a"` starting its line, which is read as `\d .a` is - `value` or `get` of a
/// string, a `set` into a computed name and an assignment on a `k)` line.
/// `code` has strings and comments blank, `comments` only comments, and
/// `raw` is the source.
///
/// Not every `value` is evaluation - `value d` reads a dictionary and
/// `value f` decomposes a lambda - so `value` counts only with a string in
/// its statement, read from a file (`value each read0 f`), or held in a name
/// the file binds to a string (q 5: `s:"a:1 2 3"; value s; a 0` is 1). A
/// `system` command counts when it visibly loads or changes context,
/// however it is applied: `system ("l ",f)`, `system c` after `c:"l f"`,
/// `system["l f"]`, `system@"l f"` and `@[system;"l f";h]` all load.
pub(crate) fn opaque(code: &str, comments: &str, raw: &str) -> bool {
    !unnamed_writes(code, comments, raw).is_empty()
}

/// What kind of write `unnamed_writes` found.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Unnamed {
    /// `system "d ..."`, which moves later definitions to a context rather
    /// than defining anything itself.
    Context,
    /// Code the file runs without spelling it out - a load, `eval`, `value`
    /// or `get` of a string - which may define anything, functions included.
    Evaluation,
    /// A value put into a name the text does not say: a `set` into a computed
    /// name, an upsert into `` `. ``, an assignment on a `k)` line.
    Overwrite,
}

/// Where `opaque` finds each write it cannot name, and of what kind.
pub(crate) fn unnamed_writes(code: &str, comments: &str, raw: &str) -> Vec<(usize, Unnamed)> {
    let mut found: Vec<(usize, Unnamed)> = load_lines(code, raw)
        .filter(|(_, rest)| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
        .map(|(at, _)| (at, Unnamed::Evaluation))
        .collect();
    // A `k)` line is blank in both views, as another language's, but k
    // assigns q's globals: q 5 `a:1`, `k)a:1 2 3`, then `a 0` is 1.
    found.extend(
        re!(r"(?m)^k\)[^\n]*:")
            .find_iter(raw)
            .map(|m| (m.start(), Unnamed::Overwrite)),
    );
    // A name bound to a string literal and nothing else: `s:"a:1 2 3"`, not
    // `s:" " sv parts`, which starts with one (BuaBook's cargs.q values a
    // dictionary built so).
    let strings: HashMap<&str, &str> =
        re!(r#"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*::?\s*"((?:[^"\\]|\\.)*)"\s*(?:[;)\]}\n]|$)"#)
            .captures_iter(comments)
            .filter(|m| boundary(comments, m.get(0).unwrap().start()))
            .map(|m| (m.get(1).unwrap().as_str(), m.get(2).unwrap().as_str()))
            .collect();
    for m in re!(r"\b(?:eval|value|get|system)\b").find_iter(code) {
        if !boundary(code, m.start()) {
            continue;
        }
        // Strings kept, comments blanked: a quote in a comment after
        // `value d` is not a string to evaluate (#258).
        let rest = &comments[m.end()..];
        // The argument, past what only hands it on: an opening bracket, `@`,
        // the slots of a trap, and `each`, `enlist` and `raze`. Not past a
        // closing one or an each: in `(get'') " -> " vs/:x` the string is
        // not what `get` is given.
        let skip = re!(r"^(?:[\s\[(@;]|\b(?:each|peach|enlist|raze)\b)*");
        let arg = |text: &'_ str| text[skip.find(text).map_or(0, |p| p.end())..].to_string();
        let statement = &rest[..rest.find([';', '\n']).unwrap_or(rest.len())];
        // The string literal the argument is, or the name holding one.
        let literal = |a: &str| -> Option<String> {
            if let Some(text) = a.strip_prefix('"') {
                return Some(text.to_string());
            }
            let n = re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*").find(a)?;
            strings.get(n.as_str()).map(|s| s.to_string())
        };
        let name = |a: &str| {
            re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*")
                .find(a)
                .is_some_and(|n| n.as_str() == "read0" || strings.contains_key(n.as_str()))
        };
        let write = match m.as_str() {
            "eval" => Some(Unnamed::Evaluation),
            // A shell command built at run time is the usual `system` with
            // no literal after it - `system$[WIN;"del ";"rm "],f`, `@[system;
            // cmd;h]` - so only a command that visibly starts with `l` or `d`
            // counts: written so, or held in a name bound to such a literal.
            "system" => literal(&arg(rest)).and_then(|command| {
                // A literal `system "d .a"` starting its line switches as
                // `\d .a` does, and `opens` reads it so: q 5 runs it, then
                // `f:{x+1}`, `g:{f[`a]}`, and `.a.g[]` is 'type (#535).
                let start = code[..m.start()].rfind('\n').map_or(0, |i| i + 1);
                let end = code[m.start()..]
                    .find('\n')
                    .map_or(code.len(), |i| m.start() + i);
                if re!(r"^d\b").is_match(&command)
                    && start == m.start()
                    && opens(&code[start..end], &raw[start..end]).is_some()
                {
                    None
                } else if re!(r"^d\b").is_match(&command) {
                    Some(Unnamed::Context)
                } else {
                    re!(r"^l\b")
                        .is_match(&command)
                        .then_some(Unnamed::Evaluation)
                }
            }),
            "value" => {
                (statement.contains('"') || name(&arg(statement))).then_some(Unnamed::Evaluation)
            }
            // `get` of a string whole, written so or bound to a name: not
            // one built by joining, `get[".ns.",n,".predict"]`, which names
            // a function to read; nor a system command but `\l` and `\d`
            // (`get"\w"` reads memory stats).
            _ => {
                let a = arg(statement);
                let whole = re!(r#"^"((?:[^"\\]|\\.)*)"\s*(?:[;)\]}]|$)"#)
                    .captures(&a)
                    .is_some_and(|c| !c[1].starts_with('\\') || re!(r"^\\[ld]\b").is_match(&c[1]));
                (whole || name(&a)).then_some(Unnamed::Evaluation)
            }
        };
        if let Some(kind) = write {
            found.push((m.start(), kind));
        }
    }
    // An upsert into the root context adds or replaces globals by the
    // dictionary's keys: q 5 `a:1; `. upsert enlist[`a]!enlist 1 2 3; a 0`
    // is 1.
    found.extend(
        re!(r"`\.(?:\s+|\s*\)\s*)upsert\b|\bupsert\s*\[\s*`\.\s*;")
            .find_iter(code)
            .map(|m| (m.start(), Unnamed::Overwrite)),
    );
    // A `set` into a name computed at run time - a name holding a symbol, a
    // lambda's parameter, a cast: q 5 `n:`a; a:1; n set 1 2 3; a 0` is 1.
    // Not into a literal symbol, which names what it writes, nor into a file
    // path, which writes no global.
    for m in re!(r"\bset\b'?").find_iter(code) {
        if !boundary(code, m.start()) {
            continue;
        }
        let after = code[m.end()..].trim_start();
        let target = if let Some(args) = after.strip_prefix('[') {
            let open = code.len() - args.len() - 1;
            let close = matching(code, open, b'[', b']').map_or(code.len(), |c| c - 1);
            let inner = &code[open + 1..close];
            crate::slots(inner).first().map_or("", |s| s.trim())
        } else {
            let before = code[..m.start()].trim_end();
            match before.as_bytes().last() {
                Some(&close @ (b')' | b']')) => {
                    let open = if close == b')' { b'(' } else { b'[' };
                    let mut depth = 0i32;
                    let mut at = before.len();
                    while at > 0 {
                        at -= 1;
                        match before.as_bytes()[at] {
                            c if c == close => depth += 1,
                            c if c == open => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                    }
                    // An indexed name, `.Q.dd[d;`t]`, is one noun with its brackets.
                    let name = before[..at]
                        .trim_end_matches(|c: char| c.is_ascii_alphanumeric() || "_.".contains(c));
                    &before[if close == b']' { name.len() } else { at }..]
                }
                _ => {
                    let word = before.trim_end_matches(|c: char| {
                        c.is_ascii_alphanumeric() || "_.`:/".contains(c)
                    });
                    &before[word.len()..]
                }
            }
        };
        let literal = re!(r"^\(?\s*(?:`[A-Za-z0-9_.:/]*\s*;?\s*)+\)?$").is_match(target);
        let file = target.contains("`:") || target.contains("hsym") || target.starts_with(".Q.");
        if !literal && !file {
            found.push((m.start(), Unnamed::Overwrite));
        }
    }
    found
}

pub fn check(
    path: &str,
    code: &str,
    raw: &str,
    comments: &str,
    ws: &crate::Workspace,
) -> Vec<Finding> {
    let mut out = vec![];
    // Keys: symbols, as before, and the other literal lists q takes - a
    // numeric or byte vector, or a parenthesised list. Not a numeric atom:
    // `1!t` keys a table and `0!t` unkeys one, which is not a dictionary.
    // A boolean vector and a string are key lists too: q 5 `101b!3 4` and
    // `"ab"!3 4 5` are 'length (#610). Read in `comments`, where a string is
    // still text; anything else has to be code there, and so does the `!`.
    for m in re!(
        r#"((?:`[A-Za-z][A-Za-z0-9_.]*)+|-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)+|[01]{2,}b|0x(?:[0-9a-fA-F]{2}){2,}|"(?:[^"\\\n]|\\.)*"|\([^()]*;[^()]*\)|\(\s*(?:`[A-Za-z][A-Za-z0-9_.]*){2,}\s*\))\s*!"#
    )
    .captures_iter(comments)
    {
        let start = m.get(0).unwrap();
        let quoted = m[1].starts_with('"');
        let key_in_code = if quoted {
            // An opening quote: not straight after a string's text, which
            // would make it a closing one.
            let at = start.start();
            code[m.get(1).unwrap().range()].trim().is_empty()
                && !(at > 0
                    && code.as_bytes()[at - 1] == b' '
                    && !comments.as_bytes()[at - 1].is_ascii_whitespace())
        } else {
            code.get(m.get(1).unwrap().range()) == Some(&m[1])
        };
        if !key_in_code || code.as_bytes()[start.end() - 1] != b'!' || !boundary(code, start.start()) {
            continue;
        }
        // One symbol on the left is an enumeration, not a dictionary:
        // `` `sym!0 1 2 `` indexes the list named sym.
        if m[1].starts_with('`') && m[1].matches('`').count() == 1 {
            continue;
        }
        let mut end = start.end();
        let mut depth = 0;
        for b in code[end..].bytes() {
            if b")]}".contains(&b) {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            } else if b"([{ ".contains(&b) && b != b' ' {
                depth += 1;
            } else if b == b';' && depth == 0 {
                break;
            } else if b == b'\n' && depth == 0 && !comments[end + 1..].starts_with([' ', '\t', '\n'])
            {
                // An unindented next line starts a new top-level expression.
                // Indented continuations (including masked comments) still
                // belong to this literal, even when they start after `!`.
                // Read in `comments`: in `code` a column-0 string is blanks,
                // and looks indented (#743).
                break;
            }
            end += 1;
        }
        // A string value is blank in `code`; its items are in `comments`.
        let value = &code[start.end()..end];
        // A symbol atom is spread over every key, as no other atom is: q 5
        // builds `` `a`b!`c `` and `` 1 2!` ``, and `1 2!3` is 'length.
        // Parentheses only group it: `` `a`b!(`c) `` is `` `a`b!`c`c `` (#591).
        if re!(r"^\s*(?:\(\s*)*`[A-Za-z0-9_.:/]*\s*(?:\)\s*)*$").is_match(value) {
            continue;
        }
        let values = shape(value).or_else(|| {
            value
                .trim()
                .is_empty()
                .then(|| string_items(&comments[start.end()..end]))?
        });
        // One char is an atom, which no dictionary takes as keys: q 5
        // `"a"!1 2` is 'type, not a count mismatch.
        let keys = if quoted {
            string_items(&m[1]).filter(|&n| n != 1)
        } else {
            shape(&m[1])
        };
        if let (Some(keys), Some(values)) = (keys, values)
            && keys != values
        {
            out.push(Finding::at(
                path,
                raw,
                start.start(),
                "QT001",
                format!("Literal dictionary has {keys} keys and {values} values"),
            ));
        }
    }
    // Two literal vectors either side of an infix that pairs elements must
    // agree in length, or the line is a 'length error - `1 2 3+4 5` and
    // `` `a`b=`a`b`c `` alike. `,` joins anything and is not in the set, but
    // each-both pairs items whatever it derives from: q 5 `1 2 3,'4 5` and
    // `1 2 3+'4 5` are 'length. A `-` with space before and none after is a negative literal rather than
    // the operator (`1 2 3 -1 2` is one five-vector), and is skipped.
    // An operand is a symbol vector, a numeric vector, a byte vector with at
    // least two items, or a parenthesised list or vector. `shape` decides the length of
    // each; this pattern only has to find them.
    for m in re!(concat!(
        r#"(?P<l>(?:`[A-Za-z0-9_.]*){2,}|-?\d(?:[A-Za-z0-9.]*[eE][+-])?[A-Za-z0-9.]*(?:(?:[ \t]+|[ \t]*\r?\n[ \t]+)-?\d(?:[A-Za-z0-9.]*[eE][+-])?[A-Za-z0-9.]*)+|0x(?:[0-9a-fA-F]{2}){2,}|\([^()]*\)|"(?:[^"\\\n]|\\.)*")"#,
        blank!(),
        r"*(?P<op>(?:<>|<=|>=|[+*%&|=<>^-]|\b(?:and|or|mod|div|xexp|xlog)\b)'?|,')",
        blank!(),
        r#"*(?P<r>(?:`[A-Za-z0-9_.]*){2,}|-?\d(?:[A-Za-z0-9.]*[eE][+-])?[A-Za-z0-9.]*(?:(?:[ \t]+|[ \t]*\r?\n[ \t]+)-?\d(?:[A-Za-z0-9.]*[eE][+-])?[A-Za-z0-9.]*)+|0x(?:[0-9a-fA-F]{2}){2,}|\([^()]*\)|"(?:[^"\\\n]|\\.)*")"#
    ))
    .captures_iter(comments)
    {
        let whole = m.get(0).unwrap();
        let op = m.name("op").unwrap();
        // Read in `comments`, where a string is still text: an operand is
        // code, or a whole string literal - blank in `code`, and not opened
        // by the closing quote of another - whose items `string_items` counts.
        // One character is an atom, which pairs with anything: `"a"="cd"`.
        let measure = |g: regex::Match| -> Option<usize> {
            let at = g.start();
            if g.as_str().starts_with('"') {
                let inside = at > 0
                    && code.as_bytes()[at - 1] == b' '
                    && !comments.as_bytes()[at - 1].is_ascii_whitespace();
                if inside || !code[g.range()].trim().is_empty() {
                    return None;
                }
                string_items(g.as_str()).filter(|&n| n != 1)
            } else if code.as_bytes()[at] == comments.as_bytes()[at] {
                // At least two items: a parenthesised operand may group an
                // atom, `(1)`, which pairs with anything (q 5: `(1 2 3)+(4 5)`
                // is 'length, `(1)+4 5` runs; #603).
                shape(&code[g.range()]).filter(|&n| n >= 2)
            } else {
                None
            }
        };
        let negative = op.as_str() == "-"
            && code[..op.start()].ends_with(char::is_whitespace)
            && !code[op.end()..].starts_with(char::is_whitespace);
        // `9e-08` is one float in scientific notation, not `9e` minus `08`.
        // The operand pattern prefers to swallow the exponent, but where the
        // rest of the line offers no other infix it will back off and leave
        // the sign looking like one. A digit either side of an `e` says it is
        // not.
        let exponent = matches!(op.as_str(), "-" | "+")
            && code[..op.start()].ends_with(['e', 'E'])
            && code[..op.start() - 1].ends_with(|c: char| c.is_ascii_digit() || c == '.')
            && code[op.end()..].starts_with(|c: char| c.is_ascii_digit());
        // The right operand is everything to the right of the operator, so it
        // has to end here for its length to be the one counted: `4 5,6` is
        // three items, not two. Same test as QB018's.
        if negative || exponent || !boundary(code, whole.start()) || !operand_ends(code, comments, whole.end())
        {
            continue;
        }
        // `` `dd`del`div`dfn `` is one symbol vector, not `div` between two:
        // a word operator written straight after a backtick is a symbol.
        if code.get(op.range()) != Some(op.as_str())
            || op.as_str().starts_with(char::is_alphabetic) && code[..op.start()].ends_with('`')
        {
            continue;
        }
        if let (Some(l), Some(r)) = (measure(m.name("l").unwrap()), measure(m.name("r").unwrap()))
            && l != r
        {
            out.push(Finding::at(
                path,
                raw,
                whole.start(),
                "QT006",
                format!(
                    "`{}` pairs a {l}-vector with a {r}-vector; that is a 'length error",
                    op.as_str()
                ),
            ));
        }
    }
    glyph_brackets(path, raw, code, &mut out);
    // Dynamic evaluation is where the global-name checks stop being
    // reliable: a file that writes globals it never spells out may define
    // any name, and QF005, QF010 and QT002 would report one as undefined
    // that is not. It is only those checks that are skipped: the local-scope
    // rule QF014 does not depend on what globals exist, and runs regardless.
    // Nor is it a finding: nothing is wrong with the line, and a warning on
    // every file that builds a query dynamically buries the ones that mean
    // something. `` `name set v `` defines a name the file does spell out:
    // it counts as an assignment below rather than as a reason to stop.
    let unnamed = unnamed_writes(code, comments, raw);
    let dynamic = !unnamed.is_empty();
    // QP006 is a convention about how the file calls a function it defines
    // by a literal lambda, not a claim about a value, so only code the file
    // runs without spelling out - which may define that function anew -
    // stands it down. A `set` into a computed name, typically a lambda
    // installing one name it is handed, leaves the file's own definitions
    // as they read.
    let evaluates = unnamed.iter().any(|&(_, kind)| kind != Unnamed::Overwrite);
    // QF010 and QF005 are claims about scope - the author meant an argument
    // or an enclosing local, and q reads a global - so a `set` into a name the
    // text does not say stands them down only for a name the file binds the
    // target to: after `n:`x; n set 5`, `{[b] b+x}` reads the `x` it meant
    // (q 5: 6). A target the file never binds, a parameter as in
    // `{[cb;f] cb set f}`, is not taken to name a local's or an argument's
    // name: q 5 `{[cb] {[a] string cb}[1]; cb set 2}` is still 'cb (#837).
    let set_into: HashSet<&str> = if evaluates {
        HashSet::new()
    } else {
        let bound: HashMap<&str, &str> =
            re!(r"(?m)(?:^|[;\s(\[{])([A-Za-z][A-Za-z0-9_]*)\s*:\s*`([A-Za-z][A-Za-z0-9_]*)\b")
                .captures_iter(code)
                .map(|c| (c.get(1).unwrap().as_str(), c.get(2).unwrap().as_str()))
                .collect();
        re!(r"([A-Za-z][A-Za-z0-9_]*)\s+set\b")
            .captures_iter(code)
            .filter(|c| boundary(code, c.get(1).unwrap().start()))
            .filter_map(|c| bound.get(c.get(1).unwrap().as_str()).copied())
            .collect()
    };
    let assignment = re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*:(:)?");
    let (scopes, namespaces) = scopes(code, raw);
    let ns_at = |at| {
        namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1
        .as_str()
    };
    let globals = global_writes(code, raw, &scopes, &namespaces, qualify, true);
    // The same writes keyed as q resolves them, root `x` apart from `.x`:
    // a name read in a `\d .ns` lambda is `.ns.x` and nothing else - q 5
    // has no root fallback. After `x:1`, `\d .ns`, `f:{[a] a+x}`, calling
    // `.ns.f 1` is 'x.
    let exact = global_writes(code, raw, &scopes, &namespaces, resolved, true);
    // What this file defines itself; the workspace answers for the rest,
    // keyed the same way (#359).
    let own: HashSet<String> = exact.keys().cloned().collect();
    let elsewhere = |name: &str| ws.defined_elsewhere(name, &own);
    // Scopes by the offset they start at. Looking one up by scanning is linear
    // per global and quadratic over a file whose globals are mostly lambdas,
    // which is what a q library is.
    let scope_starting_at: HashMap<usize, usize> = scopes
        .iter()
        .enumerate()
        .map(|(i, s)| (s.start, i))
        .collect();
    let mut numeric = HashSet::new();
    for (name, assignments) in &globals {
        if assignments.len() != 1 {
            continue;
        }
        let start = code.len() - code[assignments[0]..].trim_start().len();
        if let Some(scope) = scope_starting_at
            .get(&start)
            .map(|&i| &scopes[i])
            .filter(|s| s.params.len() == 1 || !s.named)
            && let Some(m)=re!(r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*[+*%\-]\s*-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[bhijef]?\s*;?\s*$").captures(&scope.direct)
                // An implicit signature is rank 1 only when the body reads
                // `x` alone: `{x+1}[`a]` is 'type, `{y+1}[`a]` a projection.
                && if scope.named { scope.params.contains(&m[1]) } else { &m[1] == "x" } {numeric.insert(name.clone());}
    }
    // Called in brackets, with `@`, or by juxtaposition - `f[`a]`, `f@`a` and
    // `f `a` are all 'type in q 5 (#495). The last two only when the symbol
    // is the whole argument: `f `a!1` adds to a dictionary's values.
    for call in re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(?:\s*\[\s*`\.?[A-Za-z][A-Za-z0-9_.:]*\s*\]|(\s*@\s*|[ \t]+)`\.?[A-Za-z][A-Za-z0-9_.:]*)").captures_iter(code) {
        if dynamic {break;}
        let at=call.get(0).unwrap().start();let name=&call[1];if !boundary(code,at){continue;}
        if call.get(2).is_some() && !operand_ends(code, comments, call.get(0).unwrap().end()) {continue;}
        if scope_at(&scopes,at).is_some_and(|s|scopes[s].locals.contains(name)){continue;}
        // A lambda runs once every file is loaded, and meets whichever `f`
        // another file assigned last: q 5 runs b.q's `g:{f[`a]}` to `a after
        // a.q's `f:{x}` (#522).
        if scope_at(&scopes,at).is_some()&&elsewhere(&resolved(name,ns_at(at))){continue;}
        if numeric.contains(&qualify(name,ns_at(at))) {out.push(Finding::at(path, raw, at,"QT002",format!("Symbol literal passed to numeric function {name}")));}
    }
    // An assignment anywhere in a lambda body makes the name local for the
    // whole body, including the statements above it - so a read that q runs
    // before the first assignment is of an unset local, never the global,
    // and q refuses the lambda at definition. Verified: `{r:cfg; cfg:1; r}`
    // and `{if[a;a:1]}` are 'cfg and 'a before they are called. What "before"
    // means is `runs_before`'s and `runs_first_after`'s business: within one
    // statement q evaluates right to left, so `x#a where (a:...)` assigns
    // first and is fine, and `(a:1)+a` reads first and is not. A column in a table
    // literal is not an assignment, and column names inside a query resolve
    // to the table first, so both are blanked here - the query only over its
    // own extent, since the rest of the lambda is ordinary q: q 5 refuses
    // `{b:a;a:1;select from ([]c:1)}` with 'a.
    for scope in &scopes {
        // A bracket that opens the body and is not a parameter list, as in
        // `{[a:1] a}`, is a malformed signature, which is QF007's to report.
        if !scope.named && scope.direct.trim_start().starts_with('[') {
            continue;
        }
        let direct = with_from_clauses(&scope.direct, true);
        let stops = statement_stops(&direct);
        let mut first: HashMap<&str, usize> = HashMap::new();
        let mut every: HashMap<&str, Vec<usize>> = HashMap::new();
        for a in assignment.captures_iter(&direct) {
            let m = a.get(0).unwrap();
            if boundary(&direct, m.start()) && a.get(2).is_none() && !a[1].contains('.') {
                let name = a.get(1).unwrap().as_str();
                first.entry(name).or_insert(m.start());
                every.entry(name).or_default().push(m.start());
            }
        }
        for (at, name) in multi_assignments(&direct) {
            let entry = first.entry(name).or_insert(at);
            *entry = (*entry).min(at);
            every.entry(name).or_default().push(at);
        }
        let mut seen = HashSet::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&direct) {
            let name = m.as_str();
            let after = direct[m.end()..].trim_start();
            let Some(&assigned) = first.get(name) else {
                continue;
            };
            // A read to the right of the assignment, in the expression it
            // assigns, runs first too: q 5 `{a:a+1}[]` is 'a. The walk stops
            // at a `;` or at a bracket that closes around the assignment -
            // not at a line break, which inside a lambda is whitespace (#191).
            let in_value = m.start() > assigned
                && direct[assigned..].starts_with(name)
                && {
                    let mut depth = 0i32;
                    direct[assigned..m.start()].bytes().all(|b| {
                        match b {
                            b'(' | b'[' | b'{' => depth += 1,
                            b')' | b']' | b'}' => depth -= 1,
                            _ => {}
                        }
                        depth >= 0 && !(b == b';' && depth == 0)
                    })
                }
                && {
                    // Unless the statement assigns the name again, which may
                    // run first: `a:a*a:sin x`, `k:2_@[k;..;k:...]` and
                    // `c:f$[0<count c:g x;c;0]` are fine. So is one right of
                    // the bracket that closes around the first: `(b:b&x)|b:x>0`
                    // runs `b:x>0` first (#302). The walk ends at a `;` of the
                    // outermost level it has reached that ends a statement or
                    // a slot of a control bracket, since a later slot of one,
                    // `$[c;(a:a+1);a:2]`, runs after. A later slot of a call
                    // or a list runs first: q 5 `{h[d:d+1;d:1]}[]` is 3 and
                    // `{(b:b+1;b:1)}[]` is 2 1 (#669).
                    let rest = &direct[assigned..];
                    let (mut depth, mut floor) = (0i32, 0i32);
                    let mut end = rest.len();
                    for (i, b) in rest.bytes().enumerate() {
                        match b {
                            b'(' | b'[' | b'{' => depth += 1,
                            b')' | b']' | b'}' => depth -= 1,
                            _ => {}
                        }
                        floor = floor.min(depth);
                        if b == b';'
                            && depth <= floor
                            && !eval_path(&direct, &stops, assigned + i)
                                .1
                                .last()
                                .is_some_and(|&(_, _, control)| !control)
                        {
                            end = i;
                            break;
                        }
                    }
                    !assignment.captures_iter(&rest[..end]).any(|a| {
                        let at = a.get(0).unwrap().start();
                        at > 0 && &a[1] == name && a.get(2).is_none() && boundary(rest, at)
                    })
                };
            // Written after the assignment, outside its value, and still run
            // first: q 5 refuses `{(a:1)+a}` and `{g[a:1;a]}` with 'a. Only
            // when it runs before every assignment of the name: in KX's
            // taq/daily.q, `(t;..t:max b..;t;..t:min a..)` reads the third
            // slot after the fourth has set `t`.
            let later = m.start() >= assigned
                && !in_value
                && every[name].iter().all(|&p| {
                    if p < m.start() {
                        runs_first_after(&direct, &stops, m.start(), p)
                    } else {
                        runs_before(&direct, &stops, m.start(), p)
                    }
                });
            if (m.start() >= assigned && !in_value && !later)
                || scope.params.contains(name)
                || !boundary(&direct, m.start())
                || after.starts_with(':')
                // A dotted name, not dot-apply: `g . p` reads `g` (#251).
                || direct[m.end()..].starts_with('.')
                || (!in_value && !later && !runs_before(&direct, &stops, m.start(), assigned))
                || !seen.insert(name)
            {
                continue;
            }
            // q settles which names are local when it reads the lambda, so it
            // refuses the definition, not the call: as a script line, q 5
            // stops at `f:{r:b; b:2; r}` with 'b.
            let why = if in_value {
                "is read in the value being assigned to it, which makes it local, and the \
                 value runs first"
            } else if later {
                "is read to the right of where it is assigned, outside the value, and q runs \
                 the right first, so it is an unset local here"
            } else {
                "is read here but assigned in a later statement, which makes it local \
                 throughout"
            };
            out.push(Finding::at(
                path,
                raw,
                scope.body + m.start(),
                "QF014",
                format!("`{name}` {why}: q refuses the lambda where it is defined, with '{name}"),
            ));
        }
    }
    // `t.c` inside a lambda is the global named `t.c`, never column c of a
    // parameter or local `t`: q 5 `{[t] t.c}[([]c:1 2)]` is 't.c, while at
    // the top level `t.c` works. A query is left alone, where `sym.name`
    // can be a foreign key's column - but only the query: q 5 refuses
    // `{[d] t:select from ([]a:1 2);d.a}[1]` with 'd.a.
    //
    // A local counts only once it has been assigned: before that the author
    // cannot have meant it, and the dotted name is a namespace's. KX's
    // ml/clust/dbscan.q reads `clust.i.df` in a lambda that sets a local
    // `clust` further down, and q 5 runs it, finding `.ml.clust.i.df`.
    for scope in &scopes {
        let direct = local_view(&scope.direct, false);
        let tables = local_view(&scope.direct, true);
        let set_before = |name: &str, at: usize| {
            assignment.captures_iter(&tables).any(|a| {
                let m = a.get(0).unwrap();
                m.start() < at
                    && &a[1] == name
                    && a.get(2).is_none()
                    && boundary(&tables, m.start())
            }) || multi_assignments(&tables).any(|(p, n)| p < at && n == name)
        };
        let dotted = re!(r"([A-Za-z][A-Za-z0-9_]*)\.[A-Za-z][A-Za-z0-9_.]*");
        // A name the lambda already reads as a namespace, through a dotted
        // global the file defines: its other dotted reads are that
        // namespace's too, which the file may fill at run time. KX's
        // ax/graphics.q reads `scale.colour.gradient`, defined, beside
        // `scale.ty.default.with.i_type`, which a helper `set`s (#670).
        let namespaces: HashSet<&str> = dotted
            .find_iter(&direct)
            .filter(|m| {
                boundary(&direct, m.start())
                    && exact.contains_key(&resolved(m.as_str(), &scope.namespace))
            })
            .map(|m| &m.as_str()[..m.as_str().find('.').unwrap()])
            .collect();
        for m in dotted.find_iter(&direct) {
            let whole = m.as_str();
            let name = &whole[..whole.find('.').unwrap()];
            if !boundary(&direct, m.start())
                || namespaces.contains(name)
                || !(scope.params.contains(name)
                    || (scope.locals.contains(name) && set_before(name, m.start())))
                // A global of that name, as q resolves it in the lambda's
                // context: under `\d .ns`, `t.c` is `.ns.t.c` (#368).
                || exact.contains_key(&resolved(whole, &scope.namespace))
            {
                continue;
            }
            out.push(Finding::at(
                path,
                raw,
                scope.body + m.start(),
                "QF021",
                format!(
                    "`{whole}` in a lambda is the global of that name, not `{name}` here: \
                     q raises '{whole} (index with `{name}[{}]` instead)",
                    whole[name.len() + 1..]
                        .split('.')
                        .map(|k| format!("`{k}"))
                        .collect::<Vec<_>>()
                        .join(";")
                ),
            ));
        }
    }
    // `a::v` in a lambda that binds `a` - as a parameter or with `a:`
    // anywhere in its body - sets that local, not a global: q 5
    // `{[a] a::5; a}[1]` is 5 and leaves no global `a`, as do `{b:1; b::2}`
    // and `{(b;c):1 2; b::5}`. A name the lambda does not bind is the global
    // write it looks like. Queries are blanked, where `a:` names a column.
    // With nothing after it, `a::` is no assignment but `a` composed with
    // the identity: q 5 `{[d] r:d::; r}[3]` is 3, and KX's ml writes
    // `model transform::` for a composition.
    for scope in &scopes {
        let view = local_view(&scope.direct, true);
        for m in re!(r"([A-Za-z][A-Za-z0-9_]*)[ \t]*::").captures_iter(&view) {
            let (whole, name) = (m.get(0).unwrap(), &m[1]);
            if !boundary(&view, whole.start())
                || !assigns_value(&view[whole.end()..])
                || !scope.locals.contains(name)
            {
                continue;
            }
            let what = if scope.params.contains(name) {
                "a parameter"
            } else {
                "a local"
            };
            out.push(Finding::at(
                path,
                raw,
                scope.body + whole.start(),
                "QF022",
                format!(
                    "`{name}` is {what} of this lambda, so `{name}::` assigns the local, not \
                     a global `{name}`: write the global with `set` and a symbol"
                ),
            ));
        }
    }
    // A lambda applied with peach runs on secondary threads under `-s`,
    // where a global write is refused: q 5 with `-s 2` gives 'noupdate for
    // `{g::1;x} peach 1 2`, `` {`g set 1;x} peach 1 2 `` and
    // `{.ns.g::1;x} peach 1 2`, and runs `{b:0;b::1;b+x} peach 1 2`. Only a
    // lambda written out as peach's left operand, and only its own body: a
    // nested lambda may never be called. A file symbol, `` `:f set t ``,
    // writes no global.
    for scope in &scopes {
        let after = code.get(scope.end + 1..).unwrap_or("");
        let next = after.trim_start_matches([' ', '\t']);
        if code.as_bytes().get(scope.end) != Some(&b'}')
            || !re!(r"^peach(?:[^A-Za-z0-9_.]|$)").is_match(next)
        {
            continue;
        }
        let view = local_view(&scope.direct, false);
        // A dotted name is global with one colon too: q 5 with `-s 2`
        // refuses `{.ns.a:x} peach 1 2` alike (#1204).
        let assigned = re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]*(::?)")
            .captures_iter(&view)
            .find(|m| {
                let whole = m.get(0).unwrap();
                (&m[2] == "::" || m[1].starts_with('.'))
                    && boundary(&view, whole.start())
                    && assigns_value(&view[whole.end()..])
                    && !scope.locals.contains(&m[1])
            })
            .map(|m| (m.get(0).unwrap().start(), m[1].to_string()));
        let set = re!(r"`(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]+set(?:[^A-Za-z0-9_.]|$)")
            .captures_iter(&scope.direct)
            .find(|m| crate::boundary(&scope.direct, m.get(0).unwrap().start()))
            .map(|m| (m.get(0).unwrap().start(), m[1].to_string()));
        let first = match (assigned, set) {
            (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
            (a, b) => a.or(b),
        };
        if let Some((at, name)) = first {
            out.push(Finding::at(
                path,
                raw,
                scope.body + at,
                "QB024",
                format!(
                    "This lambda is applied with peach and writes the global `{name}`: on \
                     secondary threads (q -s) q refuses that with 'noupdate; return the value \
                     and assign it after peach"
                ),
            ));
        }
    }
    // A parameter the body never mentions. The caller is still required to
    // pass it, so this is usually a call site that changed and a signature
    // that did not.
    //
    // The whole body counts, nested lambdas included. q will not let an inner
    // lambda see an outer local - that is QF005 - but a parameter named there
    // was meant to be used, and reporting it twice helps nobody.
    for scope in &scopes {
        if !scope.named {
            continue;
        }
        // Lambdas q calls itself take the arguments q passes, used or not.
        // `.z.pg`, `.z.ps`, `.z.ws` and the tickerplant's `upd` are the
        // common ones, and every process defines some of them.
        let before = &code[..scope.start];
        if re!(r"(?:\.z\.[a-z]{1,2}|\bupd|\.u\.upd)\s*:\s*$").is_match(before.trim_end_matches(' '))
        {
            continue;
        }
        // Names the body mentions, with symbols blanked first so `` `a `` does
        // not count as a use of `a`, and dotted names left whole so `.ns.a`
        // does not count as one either. Nor does an assignment target:
        // `{[a;b] a:0; b}` throws the caller's `a` away unread (#262).
        let body = re!(r"`[A-Za-z0-9_./:]*")
            .replace_all(&code[scope.body..scope.end], |m: &regex::Captures| {
                " ".repeat(m[0].len())
            });
        let mut mentioned: HashSet<&str> = parse_tree_names(&code[scope.body..scope.end]);
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&body) {
            if boundary(&body, m.start())
                && !body[m.end()..].starts_with('.')
                // `f dtf::` with nothing after reads `dtf` (q 5 parses
                // `dtf::;` as `(::;`dtf)`), as psaris/funq's ml.q does.
                && !re!(r"^[ \t]*:(?::[ \t]*[^ \t;\])}\n]|[^:]|$)").is_match(&body[m.end()..])
            {
                mentioned.insert(m.as_str());
            }
        }
        // A lambda that reads none of its parameters is conforming to a
        // signature someone else chose - a callback, a test the harness calls,
        // an adapter. Those are not drift and there is nothing to remove. A
        // lambda that reads some but not others is the one that changed.
        let named: Vec<&String> = scope.params.iter().filter(|p| !p.is_empty()).collect();
        let used = named
            .iter()
            .filter(|p| mentioned.contains(p.as_str()))
            .count();
        if used == 0 {
            continue;
        }
        for param in named {
            // A name that says it is not used is the author saying so. q has
            // no `_` to spare for this - that is the drop operator - so the
            // convention is the word itself.
            if re!(r"(?i)^(?:unused|ignored?|dummy)").is_match(param) {
                continue;
            }
            if !mentioned.contains(param.as_str()) {
                // On the parameter itself, spanning exactly its name, so an
                // editor can fade the name rather than the whole signature.
                let signature = &code[scope.start..scope.body];
                let at = re!(r"[A-Za-z][A-Za-z0-9_]*")
                    .find_iter(signature)
                    .find(|m| m.as_str() == param.as_str())
                    .map_or(scope.start, |m| scope.start + m.start());
                let mut finding = Finding::at(
                    path,
                    raw,
                    at,
                    "QF016",
                    format!("Parameter `{param}` is never read; the caller still has to pass it"),
                );
                if at != scope.start {
                    finding.end_column = finding.column.map(|c| c + param.len());
                }
                out.push(finding);
            }
        }
    }
    // `y` or `z` assigned in a lambda with no parameter list. q counts the
    // implicit arguments by the highest of the three the body names, and an
    // assignment names it too: in q 5 `g:{z:x+1; z}` takes three arguments,
    // so `g 1` is a projection, and whatever the caller passes as `z` is
    // thrown away unread. With a parameter list the letters are ordinary
    // locals - `{[a;b] z:a+b; z*2}[1;2]` is 6 and `value` lists only `a`
    // and `b` - and rebinding `x` keeps the rank, so neither is reported.
    // An assignment that follows a read of the same name rebinds an argument
    // the body uses, `{y:y+1; x+y}`, which is not this.
    for scope in &scopes {
        if scope.named {
            continue;
        }
        let statements = statement_view(&scope.direct);
        let direct = re!(r"`[A-Za-z0-9_./:]*")
            .replace_all(&scope.direct, |m: &regex::Captures| " ".repeat(m[0].len()));
        let reads = |text: &str, name: &str| {
            text.match_indices(name).any(|(i, _)| {
                boundary(text, i)
                    && !text[i + 1..]
                        .starts_with(|c: char| c.is_ascii_alphanumeric() || "_.".contains(c))
                    && !re!(r"^[ \t]*:(?:[^:]|$)").is_match(&text[i + 1..])
            })
        };
        let mut seen = HashSet::new();
        for a in assignment.captures_iter(&statements) {
            let whole = a.get(0).unwrap();
            let name = a.get(1).unwrap().as_str();
            if !boundary(&statements, whole.start())
                || a.get(2).is_some()
                || !matches!(name, "y" | "z")
                || !seen.insert(name)
            {
                continue;
            }
            // `y[k]:v` amends the argument in place, which reads it: the
            // brackets are blank in `statements` but not in the body.
            if direct[whole.start() + name.len()..]
                .trim_start_matches([' ', '\t'])
                .starts_with('[')
            {
                continue;
            }
            // Read first: before the assignment, or on its right, which q
            // evaluates before it stores - up to the `;` or bracket that
            // ends the statement.
            let (mut end, mut depth, bytes) = (whole.end(), 0i32, direct.as_bytes());
            while end < bytes.len() {
                match bytes[end] {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' if depth == 0 => break,
                    b')' | b']' | b'}' => depth -= 1,
                    b';' if depth == 0 => break,
                    _ => {}
                }
                end += 1;
            }
            if reads(&direct[..whole.start()], name) || reads(&direct[whole.end()..end], name) {
                continue;
            }
            let rank = crate::lambda_rank(code, raw, scope.start, scope.end);
            out.push(Finding::at(
                path,
                raw,
                scope.body + whole.start(),
                "QS009",
                format!(
                    "`{name}` is assigned before it is read, so q counts it as an argument: \
                     this lambda takes {rank}, and the caller's `{name}` is thrown away"
                ),
            ));
        }
    }
    // From the FINOS q coding guidelines:
    //
    //   "A function over ten lines is suspect. A function over twenty five
    //    lines is certifiable."
    //
    // The second threshold, not the first: over ten is 11% of the lambdas in
    // real q and over twenty five is 2%, and a rule that fires on a tenth of
    // everything is one nobody leaves on.
    //
    // Lines of code only, read in `comments`, which blanks a comment and
    // keeps a string: a blank line or a comment is not something to hold in
    // mind, and a lambda of fourteen statements with a dozen lines of doc
    // comment between them is not long. A line inside a multi-line string
    // is code. A nested lambda's lines count toward the one around it: they
    // are read as part of it, inline, and moving a nested lambda out to a
    // name of its own is exactly the shortening this rule asks for.
    // `[rules.QS006] max-lines` moves the threshold.
    let max_lines = crate::options::current().max_lines;
    for scope in &scopes {
        let lines = comments[scope.start..(scope.end + 1).min(comments.len())]
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count();
        if lines > max_lines {
            let limit = if max_lines == 25 {
                "twenty five".to_string()
            } else {
                max_lines.to_string()
            };
            out.push(Finding::at(
                path,
                raw,
                scope.start,
                "QS006",
                format!(
                    "This lambda is {lines} lines of code; over {limit} is hard to hold in mind"
                ),
            ));
        }
    }
    // A local assigned and never read, and a parameter the body reassigns.
    //
    // `direct` is the body with nested lambdas blanked, which is what these
    // want: a name assigned in this lambda and read only by an inner one is
    // not read at all, because q will not let the inner one see it.
    // Names each lambda's inner lambdas read without binding them, gathered
    // once by walking up from every scope: per scope, that is its depth.
    let mut inner_reads: Vec<HashSet<&str>> = vec![HashSet::new(); scopes.len()];
    for s in &scopes {
        let free: Vec<&str> = re!(r"[A-Za-z][A-Za-z0-9_]*")
            .find_iter(&s.direct)
            .filter(|m| {
                boundary(&s.direct, m.start())
                    && !s.locals.contains(m.as_str())
                    && !s.params.contains(m.as_str())
            })
            .map(|m| m.as_str())
            .collect();
        let mut p = s.parent;
        while let Some(i) = p {
            inner_reads[i].extend(free.iter().copied());
            p = scopes[i].parent;
        }
    }
    for (si, scope) in scopes.iter().enumerate() {
        let direct = re!(r"`[A-Za-z0-9_./:]*")
            .replace_all(&scope.direct, |m: &regex::Captures| " ".repeat(m[0].len()));
        // A name an inner lambda reads is QF005's finding, and its fix passes
        // the local in - so it is not unused, and removing it would leave
        // that fix reading nothing.
        let nested = &inner_reads[si];
        // Two views, because the two halves of this rule want different ones.
        // Assignments are looked for with bracketed groups blanked, since
        // `([sym:`symbol$()] qty:...)` names table columns with the syntax an
        // assignment uses, as do `update x:...` and friends, and none of them
        // makes a local. Reads are looked for in the whole body, because a
        // local assigned at the top of a lambda is very often read inside a
        // bracket - and blanking those was worse than not blanking at all.
        let statements = statement_view(&direct);
        // Assignment targets, and every other mention of a name.
        let mut assigned: HashMap<&str, usize> = HashMap::new();
        for a in assignment.captures_iter(&statements) {
            let whole = a.get(0).unwrap();
            if boundary(&statements, whole.start()) && a.get(2).is_none() && !a[1].contains('.') {
                assigned
                    .entry(a.get(1).unwrap().as_str())
                    .or_insert(whole.start());
            }
        }
        if assigned.is_empty() {
            continue;
        }
        let mut read: HashSet<&str> = parse_tree_names(&scope.direct);
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&direct) {
            if !boundary(&direct, m.start()) || direct[m.end()..].starts_with('.') {
                continue;
            }
            // A name followed by `:` is being written, not read. `::` is a
            // global write and `~:` and friends are not assignments at all.
            let after = direct[m.end()..].trim_start_matches([' ', '\t']);
            if after.starts_with(':') && !after.starts_with("::") {
                continue;
            }
            read.insert(m.as_str());
        }
        for (name, at) in &assigned {
            // A parameter rebound to a narrowed version of itself is ordinary
            // q - `x:sel[x] w 1` is KX's own u.q - so unlike the language this
            // rule was borrowed from, that is not a finding here.
            if scope.params.contains(*name) {
                continue;
            }
            if !read.contains(*name)
                && !nested.contains(*name)
                && !re!(r"(?i)^(?:unused|ignored?|dummy)").is_match(name)
            {
                let mut finding = Finding::at(
                    path,
                    raw,
                    scope.body + at,
                    "QF017",
                    format!("Local `{name}` is assigned and never read"),
                );
                finding.end_column = finding.column.map(|c| c + name.len());
                out.push(finding);
            }
        }
    }
    // A declared signature takes the implicit arguments out of scope: `x` in
    // `{[a] x+1}` is not an argument, it is a global, and q throws 'x when
    // there is none. Only a name this file never assigns globally is reported,
    // since the global may legitimately live in another file.
    // A query's own extent is left out, where `x` may be a column; the rest
    // of the lambda is not: q 5 `{[a] r:select from t; x}[1]` is 'x.
    for scope in &scopes {
        if evaluates || !scope.named {
            continue;
        }
        let direct = local_view(&scope.direct, false);
        let mut seen = HashSet::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&direct) {
            let name = m.as_str();
            // A name written before `:` is being set, not read: the column
            // `x` in `([]x:a)` included, which the locals leave out.
            if !matches!(name, "x" | "y" | "z")
                || !boundary(&direct, m.start())
                || direct[m.end()..].starts_with('.')
                || direct[m.end()..]
                    .trim_start_matches([' ', '\t'])
                    .starts_with(':')
                || scope.locals.contains(name)
                || set_into.contains(name)
                || !seen.insert(name)
            {
                continue;
            }
            // This file's globals only, not the workspace's: the name is one
            // the lambda's own signature or an enclosing lambda gives, so the
            // author meant that - and a global of the same name in another
            // file makes the read silently wrong, not right. In a monorepo it
            // is often an unrelated program's.
            if exact.contains_key(&resolved(name, &scope.namespace)) {
                continue;
            }
            out.push(Finding::at(
                path,
                raw,
                scope.body + m.start(),
                "QF010",
                format!(
                    "'{name}' is not an argument here: the lambda declares its parameters, so \
                     q resolves '{name}' as a global"
                ),
            ));
        }
    }
    for scope in &scopes {
        if evaluates || scope.parent.is_none() {
            continue;
        }
        // Walked per name rather than collected per scope: collecting copies
        // every enclosing lambda's locals into every nested one, which is
        // quadratic in nesting depth (#185).
        let outer = |name: &str| {
            let mut parent = scope.parent;
            while let Some(p) = parent {
                if scopes[p].locals.contains(name) {
                    return true;
                }
                parent = scopes[p].parent;
            }
            false
        };
        // A query's from clause is ordinary q, not a column: the nested
        // lambda in `{tab:t; {select from tab}[]}` reads `tab` (#349).
        let direct = with_from_clauses(&scope.direct, false);
        let mut seen = HashSet::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&direct) {
            let name = m.as_str();
            if !boundary(&direct, m.start())
                || direct[m.end()..].starts_with('.')
                || direct[m.end()..]
                    .trim_start_matches([' ', '\t'])
                    .starts_with(':')
                || scope.locals.contains(name)
                || !outer(name)
                || set_into.contains(name)
                || !seen.insert(name)
            {
                continue;
            }
            // This file's globals only, not the workspace's: the name is one
            // the lambda's own signature or an enclosing lambda gives, so the
            // author meant that - and a global of the same name in another
            // file makes the read silently wrong, not right. In a monorepo it
            // is often an unrelated program's.
            if exact.contains_key(&resolved(name, &scope.namespace)) {
                continue;
            }
            out.push(Finding::at(
                path,
                raw,
                scope.body + m.start(),
                "QF005",
                format!("Nested lambda references enclosing local '{name}' without a parameter"),
            ));
        }
        // A transformation pattern runs in the nested lambda too, so a name
        // it applies is read there: q 5 `{[a] {[c:a] c}}[1] 2` is 'a (#637).
        // Every name in a slot but those it binds, a symbol, and a table
        // pattern's keys.
        let sig = signature(code, raw, scope.start);
        if !sig.named {
            continue;
        }
        for slot in sig.slots {
            let bound = crate::pattern_names(slot);
            let at = slot.as_ptr() as usize - code.as_ptr() as usize;
            for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(slot) {
                let name = m.as_str();
                if !boundary(slot, m.start())
                    || slot[..m.start()].ends_with('`')
                    || slot[m.end()..].starts_with('.')
                    || slot[m.end()..].trim_start().starts_with(':')
                    || bound.contains(&name)
                    || !outer(name)
                    || set_into.contains(name)
                    || !seen.insert(name)
                    || exact.contains_key(&resolved(name, &scope.namespace))
                {
                    continue;
                }
                out.push(Finding::at(
                    path,
                    raw,
                    at + m.start(),
                    "QF005",
                    format!(
                        "Nested lambda's parameter pattern applies enclosing local '{name}', \
                         which it cannot see"
                    ),
                ));
            }
        }
    }
    // One file, one naming convention. The FINOS guidelines ask for functions
    // "in lower case or camelCase", and the qbists essays for names chosen
    // consistently; neither picks between `tradeCount` and `trade_count`, but
    // a file that uses both makes the reader guess which spelling each name
    // has. ALL-CAPS is left alone: the same guidelines give capitals to
    // constants, so `MAXROWS` beside `tradeCount` is the convention, not a
    // departure from it.
    //
    // Names this file chooses: parameters, locals and root assignments. A
    // name being read may be another library's, and a qSQL column may be a
    // schema's, so neither says anything about this author's habit.
    let mut chosen: Vec<(usize, &str)> = vec![];
    for scope in scopes.iter().filter(|s| s.named) {
        let header = &code[scope.start..scope.body];
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(header) {
            if scope.params.contains(m.as_str()) {
                chosen.push((scope.start + m.start(), m.as_str()));
            }
        }
    }
    // Each lambda body and each root line, as the statements it holds, with
    // the offset it starts at.
    let mut views: Vec<(usize, String, bool)> = scopes
        .iter()
        .map(|scope| (scope.body, statement_view(&scope.direct), false))
        .collect();
    // The root, one statement at a time: `statement_view` blanks a qSQL
    // phrase to the next `;`, and at root a statement ends at a newline the
    // next line does not continue. An indented line continues it, so a
    // column on one is the query's: `r:select` + `  total_qty:sum qty by sym
    // from t` (#694). Indentation is read from the source, where a comment
    // line is not blank.
    let mut root = code.as_bytes().to_vec();
    for scope in scopes.iter().filter(|s| s.parent.is_none()) {
        blank(&mut root[scope.start..=scope.end.min(code.len() - 1)]);
    }
    let root = crate::flat_filter(std::str::from_utf8(&root).unwrap_or_default());
    let mut statements: Vec<(usize, usize)> = vec![];
    let mut offset = 0;
    for (line, source_line) in root.split_inclusive('\n').zip(raw.split_inclusive('\n')) {
        match statements.last_mut() {
            Some(last) if line.trim().is_empty() || source_line.starts_with([' ', '\t']) => {
                last.1 += line.len()
            }
            _ => statements.push((offset, offset + line.len())),
        }
        offset += line.len();
    }
    for (start, end) in statements {
        views.push((start, statement_view(&root[start..end]), true));
    }
    for (start, statements, at_root) in &views {
        for a in assignment.captures_iter(statements) {
            let whole = a.get(0).unwrap();
            if boundary(statements, whole.start())
                && (*at_root || (a.get(2).is_none() && !a[1].contains('.')))
            {
                let at = start + whole.start();
                chosen.push((at, &code[at..at + a[1].len()]));
            }
        }
        // kebab-case is not a spelling q has: `trade-count:5` assigns
        // `count` and subtracts it from `trade`. Only at the start of a
        // statement, where nobody writes a subtraction whose right side is
        // an assignment on purpose.
        for m in
            re!(r"(?m)(?:^|;)[ \t]*([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9_]*)+)[ \t]*:[^:]")
                .captures_iter(statements)
        {
            let name = m.get(1).unwrap();
            out.push(Finding::at(
                path,
                raw,
                start + name.start(),
                "QS010",
                format!(
                    "`{}` is not a kebab-case name: q reads `-` as subtraction and assigns only `{}`",
                    name.as_str(),
                    name.as_str().rsplit('-').next().unwrap_or_default()
                ),
            ));
        }
    }
    chosen.sort();
    let mut seen = HashSet::new();
    chosen.retain(|&(_, name)| seen.insert(name));
    let mut firsts: Vec<(usize, &str, Convention, bool)> = vec![];
    for &(at, name) in &chosen {
        // `{...}LOADFMTS` applies the lambda and assigns what it returns.
        let lambda = re!(r"^\s*::?")
            .find(&code[at + name.len()..])
            .is_some_and(|m| assigns_lambda(code, raw, at + name.len() + m.end()));
        let word = name.rsplit('.').next().unwrap_or(name);
        // Capitals are the guidelines' spelling for a constant, so a function
        // spelled that way has borrowed the other convention.
        if lambda
            && word.len() > 1
            && word.bytes().any(|b| b.is_ascii_alphabetic())
            && !word.bytes().any(|b| b.is_ascii_lowercase())
        {
            out.push(Finding::at(
                path,
                raw,
                at,
                "QS010",
                format!("`{name}` is a function spelled in capitals, which are for constants"),
            ));
            continue;
        }
        let Some(convention) = convention(name) else {
            continue;
        };
        if convention == Convention::Mixed {
            out.push(Finding::at(
                path,
                raw,
                at,
                "QS010",
                format!("`{name}` joins words with both `_` and camelCase"),
            ));
            continue;
        }
        // A type prefix only on data: `symEncode:{...}` is a verb phrase.
        let hungarian = convention == Convention::Camel
            && !lambda
            && re!(r"^(?:str|sym|tbl|tab|dict|lst|list|int|lng|flt|dbl|bool|vec|arr)[A-Z0-9]")
                .is_match(word);
        let convention = if hungarian {
            Convention::Hungarian
        } else {
            convention
        };
        firsts.push((at, name, convention, lambda));
    }
    // The file's own habit is whichever convention it uses most; on a tie,
    // whichever it used first.
    let usual_of = |firsts: &[(usize, &str, Convention, bool)]| {
        let count = |c| firsts.iter().filter(|f| f.2 == c).count();
        firsts
            .iter()
            .max_by(|a, b| count(a.2).cmp(&count(b.2)).then(b.0.cmp(&a.0)))
            .map(|f| (f.2, count(f.2)))
    };
    // Hungarian notation is the habit only where it plainly is one: at least
    // three prefixed names, and more than any other spelling. Anywhere else
    // `dictKeys` and `symList` are ordinary camelCase words, since a type
    // prefix cannot be told from a first word that happens to name a type.
    if !matches!(usual_of(&firsts), Some((Convention::Hungarian, n)) if n >= 3) {
        for f in &mut firsts {
            if f.2 == Convention::Hungarian {
                f.2 = Convention::Camel;
            }
        }
    }
    // PascalCase for functions and camelCase for data is a convention of its
    // own - KX's Kafka and Bloomberg interfaces write `SessionStarted:{...}`
    // beside `serverIp:...` - so where every PascalCase name is a function,
    // the two spellings are telling kinds apart, not disagreeing.
    let split = firsts.iter().any(|f| f.2 == Convention::Pascal)
        && firsts
            .iter()
            .filter(|f| f.2 == Convention::Pascal)
            .all(|f| f.3);
    if let Some((usual, n)) = usual_of(&firsts) {
        for &(at, name, found, lambda) in firsts.iter().filter(|f| f.2 != usual) {
            // Functions carry no type prefix even in Hungarian code.
            if usual == Convention::Hungarian && found == Convention::Camel && lambda {
                continue;
            }
            let kinds = [usual, found];
            if split
                && kinds.contains(&Convention::Pascal)
                && kinds.contains(&Convention::Camel)
                && (found == Convention::Pascal) == lambda
            {
                continue;
            }
            out.push(Finding::at(
                path,
                raw,
                at,
                "QS010",
                format!(
                    "`{name}` is {}, but {n} other names in this file are {}",
                    found.label(),
                    usual.label()
                ),
            ));
        }
        // With data in camelCase outnumbering everything, the functions are
        // still one family among themselves: a camelCase one among PascalCase
        // ones is the departure.
        if split && usual == Convention::Camel {
            let functions = |c| firsts.iter().filter(move |f| f.3 && f.2 == c);
            let (pascal, camel) = (
                functions(Convention::Pascal).count(),
                functions(Convention::Camel).count(),
            );
            let (odd, usual, n) = if pascal > camel {
                (Convention::Camel, Convention::Pascal, pascal)
            } else {
                (Convention::Pascal, Convention::Camel, camel)
            };
            for &(at, name, ..) in functions(odd).filter(|_| pascal > 0 && camel > 0) {
                out.push(Finding::at(
                    path,
                    raw,
                    at,
                    "QS010",
                    format!(
                        "`{name}` is {}, but {n} other functions in this file are {}",
                        odd.label(),
                        usual.label()
                    ),
                ));
            }
        }
    }
    // A bare value read, including `aa:bb`, can expose a misspelled global.
    // This is deliberately a warning outside the general profile: another
    // file may supply the name. Loads/dynamic evaluation and qualified names
    // remain unresolved, as do calls and qSQL, where a name has other roles.
    if !dynamic {
        let mut seen = HashSet::new();
        let function_statements = scopes.iter().enumerate().flat_map(|(index, scope)| {
            crate::slots(&scope.direct)
                .into_iter()
                .scan(scope.body, move |offset, statement| {
                    let start = *offset;
                    *offset += statement.len() + 1;
                    Some((Some(index), start, statement))
                })
        });
        let statements = top_level_statements(code, raw)
            .into_iter()
            .map(|(start, statement)| (None, start, statement))
            .chain(function_statements);
        for (index, start, statement) in statements {
            let Some(m) =
                re!(r"^\s*(?:[A-Za-z][A-Za-z0-9_]*\s*:{1,2}\s*)?([A-Za-z][A-Za-z0-9_]*)\s*$")
                    .captures(statement)
            else {
                continue;
            };
            let value = m.get(1).unwrap();
            let name = value.as_str();
            let scope = index.map(|i| &scopes[i]);
            let namespace =
                scope.map_or_else(|| ns_at(start + value.start()), |s| s.namespace.as_str());
            let global = qualify(name, namespace);
            if comments[start..start + statement.len()].contains(['"', '{'])
                    || scope.is_some_and(|s| s.locals.contains(name))
                    || crate::RESERVED.iter().any(|builtin| builtin == name)
                    // Keyed exactly: `.cfg:1` defines no root `cfg` (q 5: 'cfg).
                    // A lambda runs once the file has loaded, but a top-level
                    // read runs as it loads: q 5 refuses `r:limit` above
                    // `limit:100` with 'limit (#369).
                    || exact.get(&resolved(name, namespace)).is_some_and(|at| {
                        scope.is_some()
                            || at.iter().any(|&at| at < start + value.start())
                            // `a:a` is QB017's, which says more.
                            || statement.trim_start().strip_prefix(name).is_some_and(|rest| {
                                rest.trim_start().starts_with(':')
                            })
                    })
                    // Or a namespace holding it, written as a whole before:
                    // q 5 reads `port` as 5010 under `\d .cfg` after
                    // `.cfg:(``port)!(::;5010)` (#766), as `elsewhere` does
                    // for another file's.
                    || {
                        let full = resolved(name, namespace);
                        full.match_indices('.')
                            .filter(|&(i, _)| i > 0)
                            .filter_map(|(i, _)| exact.get(&full[..i]))
                            .any(|at| scope.is_some() || at.iter().any(|&at| at < start + value.start()))
                    }
                    // q searches `.q` from every context: after `.q.k:1`,
                    // q 5 reads a bare `k` as 1, inside `\d .ns` too (#357).
                    || exact.contains_key(&format!(".q.{name}"))
                    || elsewhere(&format!(".q.{name}"))
                    // Exactly too: another file's `.cfg` is not a root
                    // `cfg`, and q 5 does not fall back from `\d .ns` to
                    // the root (#359).
                    || elsewhere(&resolved(name, namespace))
                    // QF010 and QF005 already explain these more precisely.
                    || (scope.is_some() && matches!(name, "x" | "y" | "z"))
                    || std::iter::successors(scope.and_then(|s| s.parent), |&p| scopes[p].parent)
                        .any(|p| scopes[p].locals.contains(name))
                    || !seen.insert((index, global))
            {
                continue;
            }
            let mut finding = Finding::at(
                path,
                raw,
                start + value.start(),
                "QF018",
                format!(
                    "Possibly undefined name `{name}`: no local or global definition found in this file; \
                         verify it is supplied before this expression runs"
                ),
            );
            finding.end_column = finding.column.map(|c| c + name.len());
            out.push(finding);
        }
    }
    // Writing a function beside its argument - `f x` where `f[x]` would do -
    // is valid q, and for a function of one argument it is the whole call
    // either way: `count x` and `nsq 3` gain nothing from brackets. For a
    // function of two or more it is a hazard, because juxtaposition passes
    // exactly one argument, everything to its right: after `add:{[a;b] a+b}`,
    // `add 1 2` is `add[1 2]`, a projection where the author meant 3, and q
    // says nothing. So only a name this file assigns a lambda of rank two or
    // more is reported - juxtaposition after anything else is indexing, where
    // brackets would be saying something different about the code.
    if !evaluates {
        // What `name` holds where it is used at `at`. A name can be
        // assigned more than once - qbists's aoc 02.q makes `d2` a function
        // and later a dictionary, and `d2 inp` after that is indexing - so it
        // is the assignment in force that decides: at root the last one
        // above the use, and inside a lambda, which runs once the file has
        // loaded, the file's last. Only root assignments count, for that and
        // for whether the file defines the name at all: one inside a lambda
        // happens if and when the lambda runs, and is usually a test stub
        // standing in for a function another file defines (#110).
        // It answers with the rank that lambda still takes, `None` when the
        // name holds no lambda there.
        let held_rank = |name: &str, at: usize, in_lambda: bool| {
            let assignments = globals.get(name)?;
            // `sqrt enorm2::` composes - psaris's funq defines `enorm` so - and
            // the `::` with nothing after it assigns nothing.
            let mut root: Vec<usize> = assignments
                .iter()
                .copied()
                .filter(|&a| scope_at(&scopes, a).is_none())
                .filter(|&a| {
                    let value = code[a..].trim_start_matches([' ', '\t']);
                    !(value.is_empty() || value.starts_with([';', '\n', '\r', ')', ']', '}']))
                })
                .collect();
            root.sort_unstable();
            let live = if in_lambda {
                root.last()
            } else {
                root.iter().rev().find(|&&a| a < at)
            };
            match live {
                Some(&a) => assigned_rank(code, raw, a),
                None => root
                    .iter()
                    .filter_map(|&a| assigned_rank(code, raw, a))
                    .max(),
            }
        };
        // Two passes, because the two views disagree about what an argument
        // looks like. Most arguments are visible in the masked code; a string
        // literal is not, since `code` blanks it whole - `lg "text"` has only
        // spaces after the name there - so that one is found in the raw
        // source and checked back against the views: the name has to be live
        // code, and the quote has to be blank in both views, which is what
        // distinguishes a masked string from a comment.
        let named = re!(
            "(\\.?[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*)[ \\t]+([`\"(A-Za-z0-9]|\\.[A-Za-z])"
        );
        // Each query's phrases, from the keyword to `from` and through a
        // `where`, with the table it reads.
        let queries: Vec<(usize, usize, &str)> = re!(
            r"\b(?:select|exec|update|delete)\b[^\n;]*?\bfrom\s+(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\b(?:\s+where\b[^\n;]*)?"
        )
        .captures_iter(code)
        .map(|m| {
            let whole = m.get(0).unwrap();
            (whole.start(), whole.end(), m.get(1).unwrap().as_str())
        })
        .collect();
        // The query around `at`, by binary search: the matches are in order
        // and do not overlap, and asking each of them for every candidate was
        // quadratic in a chain of queries (#709).
        let query_at = |at: usize| {
            let i = queries.partition_point(|&(lo, _, _)| lo <= at);
            queries[..i].last().filter(|&&(_, hi, _)| at < hi)
        };
        // The columns of the table literal `table` holds where it is read at
        // `at`, by the same assignment-in-force rule as `held_rank`.
        let columns_of = |table: &str, at: usize, in_lambda: bool| -> Option<Vec<String>> {
            let mut root: Vec<usize> = globals
                .get(table)?
                .iter()
                .copied()
                .filter(|&a| scope_at(&scopes, a).is_none())
                .collect();
            root.sort_unstable();
            let &start = if in_lambda {
                root.last()
            } else {
                root.iter().rev().find(|&&a| a < at)
            }?;
            let (mut end, mut depth, bytes) = (start, 0i32, code.as_bytes());
            while end < bytes.len() {
                match bytes[end] {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' if depth == 0 => break,
                    b')' | b']' | b'}' => depth -= 1,
                    b';' if depth == 0 => break,
                    b'\n' if depth == 0 && !code[end + 1..].starts_with([' ', '\t']) => break,
                    _ => {}
                }
                end += 1;
            }
            match held(&code[start..end], &raw[start..end]) {
                Some(Held::Table(columns, _)) => Some(columns),
                _ => None,
            }
        };
        // Overlapping: in `select g s` or `in g 1` the keyword's match takes
        // the `g`, so each search resumes at the argument rather than past
        // it (#780).
        let mut candidates: Vec<(usize, &str)> = Vec::new();
        let mut from = 0;
        while let Some(m) = named.captures_at(code, from) {
            let name = m.get(1).unwrap();
            candidates.push((name.start(), name.as_str()));
            from = m.get(2).unwrap().start();
        }
        for m in named.captures_iter(raw).filter(|m| &m[2] == "\"") {
            let name = m.get(1).unwrap();
            let quote = m.get(2).unwrap().start();
            if code.get(name.start()..name.end()) == Some(name.as_str())
                && code.as_bytes()[quote] == b' '
                && comments.as_bytes()[quote] == b'"'
            {
                candidates.push((name.start(), name.as_str()));
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        // Symbols blanked, for the iterator test: the `/` of `` f `:db/t ``
        // is part of the path, not over.
        let unsymbolled = crate::unsymbolled(code);
        // The line each candidate is on, read on from the last one rather
        // than searched back for from each: a long line of them was
        // quadratic (#709).
        let (mut seen, mut line_start) = (0, 0);
        let stops = crate::argument_stops(code, comments, raw);
        // And the first iterator at each position's own depth, nested groups
        // skipped, for the same reason: the test below read every argument
        // through to its end.
        let iterators = {
            let b = unsymbolled.as_bytes();
            let mut close = vec![usize::MAX; b.len()];
            let mut open = vec![];
            for (i, &c) in b.iter().enumerate() {
                match c {
                    b'(' | b'[' | b'{' => open.push(i),
                    b')' | b']' | b'}' => {
                        if let Some(o) = open.pop() {
                            close[o] = i + 1;
                        }
                    }
                    _ => {}
                }
            }
            let mut first = vec![usize::MAX; b.len() + 1];
            for i in (0..b.len()).rev() {
                first[i] = match b[i] {
                    b'(' | b'[' | b'{' if close[i] == usize::MAX => usize::MAX,
                    b'(' | b'[' | b'{' => first[close[i]],
                    b'/' | b'\\' | b'\'' => i,
                    _ => first[i + 1],
                };
            }
            first
        };
        for (at, bare) in candidates {
            if !boundary(code, at) {
                continue;
            }
            // Inside a symbol, which runs on over `:` - the `f` of the hsym
            // `` `:f 0: x `` or of `` `a:f 1 `` is part of that one token, not
            // a name after an assignment (#400).
            if unsymbolled.as_bytes()[at] != code.as_bytes()[at] {
                continue;
            }
            // A system command is a directive, not an expression: the name
            // after `\d` is not an argument and `\l` was ruled out above.
            if at < seen {
                (seen, line_start) = (0, 0);
            }
            if let Some(i) = code[seen..at].rfind('\n') {
                line_start = seen + i + 1;
            }
            seen = at;
            if code[line_start..].trim_start().starts_with('\\') {
                continue;
            }
            // Head position only. `x f y` is infix, so a name is reported
            // only where it opens the expression it belongs to - after a
            // separator or an operator, or alone at the left margin. A qSQL
            // keyword opens its phrase, and an infix keyword's right operand
            // is an expression of its own: q 5 reads `select g s from t` and
            // `s in g 1` as calls of `g` (#780). So does a unary keyword's
            // argument, which runs to the end of the expression exactly as
            // an operator's right operand does: `not g a b` is `not g[a b]`,
            // the same as `0=g a b` is `0=g[a b]`.
            let before = code[..at].trim_end();
            // Only the word that ends it and the byte before that: the
            // pattern is anchored at the end, and run over all of `before`
            // it read the file up to each candidate.
            let word = before
                .trim_end_matches(|c: char| c.is_ascii_alphanumeric() || "_.`".contains(c))
                .len();
            let tail = before[..word]
                .char_indices()
                .next_back()
                .map_or(0, |(i, _)| i);
            let keyword = re!(r"(?:^|[^A-Za-z0-9_.`])([a-z][a-z0-9]*)$")
                .captures(&before[tail..])
                .is_some_and(|m| {
                    let word = &m[1];
                    // `by`, `from` and `where` open a phrase only inside a
                    // query; outside one `where` is a unary like `not`.
                    matches!(word, "select" | "exec" | "update")
                        || matches!(word, "by" | "from" | "where") && query_at(at).is_some()
                        || INFIX.contains(&word)
                        || crate::builtin(word).is_some_and(|b| {
                            b.kind == crate::BuiltinKind::Function && b.params.len() == 1
                        })
                });
            let head = match before.chars().next_back() {
                None => true,
                Some(c) => ";([{:,+-*%&|<>=~!^#$?@".contains(c) || at == line_start || keyword,
            };
            if !head {
                continue;
            }
            let Some(argument) = crate::argument_start(raw, comments, at + bare.len()) else {
                continue;
            };
            // Two shapes where the name is an operand, not a function being
            // applied - parse trees checked in q. A top-level iterator makes
            // it the iterator's left argument: `stop f[d]/x` is
            // `f[d]/[stop;x]`, the while form of over, and `stop[f[d]/x]`
            // does not even parse. And a right side that is itself a function
            // - ending in an operator, an iterator or `::` - composes:
            // `enorm2 (-)::` and `sse X@\:` are new functions, not calls.
            if let Some(end) = crate::argument_end_from(&stops, comments, raw, argument) {
                let text = &code[argument..end];
                let iterated = iterators[argument] < end;
                let composed = text
                    .trim_end()
                    .ends_with(|c: char| "+-*%&|^=<>~,#_!?@.$:'/\\".contains(c));
                if iterated || composed {
                    continue;
                }
            }
            // An infix keyword, or the I/O verb `0:`, `1:` or `2:`, makes the
            // name its left operand: q 5 parses `fmt 0: x` as
            // `(0:;`fmt;`x)`, and even `f 0:00` as `(0:;`f;0)` (#508). A
            // qSQL keyword ends the phrase: `select g from t` names a column.
            if re!(r"^[A-Za-z][A-Za-z0-9_]*")
                .find(&code[argument..])
                .is_some_and(|w| {
                    INFIX.contains(&w.as_str()) || matches!(w.as_str(), "from" | "by" | "where")
                })
                || re!(r"^[012]:").is_match(&code[argument..])
            {
                continue;
            }
            // A local of the same name is a different function, or not a
            // function at all; either way this file's global says nothing
            // about it.
            let scope = scope_at(&scopes, at);
            if std::iter::successors(scope, |&i| scopes[i].parent)
                .any(|i| scopes[i].locals.contains(bare))
            {
                continue;
            }
            // The name in the namespace it is read in, and nowhere else: q 5
            // has no root fallback, so after `f:{x+1}`, `\d .a`, `h:{f 1}`,
            // `.a.h[]` is 'f.
            let namespace = scope.map_or_else(|| ns_at(at), |i| scopes[i].namespace.as_str());
            let Some(rank) = held_rank(&qualify(bare, namespace), at, scope.is_some()) else {
                continue;
            };
            if rank < 2 {
                continue;
            }
            // In a query the table's columns come first: with a column `f`,
            // `update g:f 0 from t` indexes the column (q 5).
            if query_at(at).is_some_and(|&(_, _, table)| {
                columns_of(&qualify(table, namespace), at, scope.is_some())
                    .is_some_and(|columns| columns.iter().any(|c| c == bare))
            }) {
                continue;
            }
            let mut finding = Finding::at(
                path,
                raw,
                at,
                "QP006",
                format!(
                    "`{bare}` takes {rank} arguments but is applied without brackets, which \
                     passes it one; write `{bare}[...]`{}",
                    // The fix declines the table after `from`, which runs on
                    // to `where`: where the brackets close is a person's call.
                    if crate::query_clause(code, at) == Some("from") {
                        " (after `from`, where they close is left to you)"
                    } else {
                        ""
                    }
                ),
            );
            finding.end_column = finding.column.map(|c| c + bare.chars().count());
            out.push(finding);
        }
    }
    out.extend(named_values(
        path,
        code,
        raw,
        comments,
        (&scopes, &namespaces, &exact),
        dynamic,
        (&|name: &str| elsewhere(name), &|name: &str| {
            elsewhere(name) && ws.is_lambda(name)
        }),
    ));
    out
}

/// `` load `:path/name `` or `rload`, infix or bracketed: the name it defines.
/// Its users check `boundary`, as `\b` matches after a dot: `.my.load` and
/// `.Q.load` are not q's `load` (#699).
const LOAD: &str = r"\br?load\s*\[?\s*`:?(?:[^\s;\]\[()`]*/)?([A-Za-z][A-Za-z0-9_]*)\b";

/// A table changed in place by name: `update c:1 from `t`, `![`t;...]`,
/// `.[`t;...]`, `@[`t;...]`, `` `a xkey `t `` and its neighbours, in the
/// bracket form too, and `` 1!`t ``. The name is the capture. Only a
/// positive count, starting an expression, keys in place: `` 1 2!`a`b `` is
/// a dictionary, and `` 0!`k `` takes keys away (#588).
const IN_PLACE: &str = r"(?:\bfrom\s*|[!.@]\s*\[\s*|\b(?:xkey|xasc|xdesc|xcols|xcol)\s*(?:\[[^;\[\]]*;\s*)?|(?m:^|[;:(\[{])[ \t]*[1-9]\d*\s*!\s*)`(\.?[A-Za-z][A-Za-z0-9_.]*)";

/// What a global holds, when the file assigns it once, at the top level, to
/// a literal. Anything else - assigned twice, amended, `set`, assigned to an
/// expression - is unknown, and the rules below say nothing about it.
#[derive(Clone, PartialEq, Debug)]
enum Held {
    /// A number, boolean, char, byte or temporal atom. Not a symbol: indexing
    /// a symbol atom looks up the variable it names, which is not an error.
    Atom,
    Vector(usize),
    /// A table literal's columns, keys first, and whether it has a key.
    Table(Vec<String>, bool),
}

/// A value's text, in two views at the same offsets, without the
/// parentheses that only group it. `(5)` is the atom 5 and `(1 2 3)` the
/// vector: without a top-level `;`, parentheses only group (q 5: `n:(5);
/// n+1 2` is `6 7`). Unwrapped in a loop, not by recursion, which tens of
/// thousands of levels would overflow, and only as deep as q parses (#703).
fn ungrouped<'a>(code: &'a str, raw: &'a str) -> Option<(&'a str, &'a str)> {
    let (mut code, mut raw) = (code.trim(), raw.trim());
    let mut depth = 0;
    while code.starts_with('(')
        && !code[1..].trim_start().starts_with('[')
        && matching(code, 0, b'(', b')') == Some(code.len())
        && crate::slots(&code[1..code.len() - 1]).len() == 1
    {
        depth += 1;
        if depth > crate::MAX_NESTING {
            return None;
        }
        (code, raw) = (code[1..code.len() - 1].trim(), raw[1..raw.len() - 1].trim());
    }
    Some((code, raw))
}

/// The value text of a top-level `name:...`, judged as a literal.
fn held(code: &str, raw: &str) -> Option<Held> {
    let (code, raw) = ungrouped(code, raw)?;
    if code.starts_with('(') && matching(code, 0, b'(', b')') == Some(code.len()) {
        let inner = code[1..code.len() - 1].trim_start();
        if inner.starts_with('[') {
            let close = matching(inner, 0, b'[', b']')?;
            // `([a:1;b:2])` with nothing after the brackets is a dictionary.
            if inner[close..].trim().is_empty() {
                return None;
            }
            let keyed = !inner[1..close - 1].trim().is_empty();
            let mut columns = vec![];
            for part in crate::slots(&inner[1..close - 1])
                .into_iter()
                .chain(crate::slots(&inner[close..]))
            {
                let name = part.split(':').next().unwrap_or("").trim();
                if name.is_empty() {
                    continue;
                }
                if !re!(r"^[A-Za-z][A-Za-z0-9_]*$").is_match(name) {
                    return None;
                }
                columns.push(name.to_string());
            }
            return Some(Held::Table(columns, keyed));
        }
    }
    // A string is blank in `code`; its length is in the source.
    if let Some(body) = re!(r#"^"((?:\\[0-7]{3}|\\.|[^"\\])*)"$"#).captures(raw) {
        let n = crate::q_bytes(&body[1]).len();
        return Some(if n == 1 { Held::Atom } else { Held::Vector(n) });
    }
    // q's own temporal and float atoms: `.z.p`, `.z.d`, `.z.K` and the rest
    // are 'type indexed or applied (q 5). Not `.z.a` and `.z.i`, integers q
    // takes as handles, nor the symbols `.z.f`, `.z.h`, `.z.o` and `.z.u`.
    if crate::Z_ATOMS.contains(&code) {
        return Some(Held::Atom);
    }
    if re!(r"^(?:-?\.?\d[A-Za-z0-9.:]*|0x[0-9a-fA-F]{2})$").is_match(code)
        // `0x` is the empty byte vector and `0x012` the two bytes `0x0012`
        // (q 5): only one or two hex digits make an atom.
        && !re!(r"^[01]{2,}b$|^0x(?:[0-9a-fA-F]{3,})?$").is_match(code)
    {
        return Some(Held::Atom);
    }
    match shape(code)? {
        // One item is an atom unless enlisted: a symbol atom pairs with a
        // vector of any length (q 5: `s:`x; s=`a`b`x` is `001b`).
        1 if !code.starts_with("enlist") => None,
        n => Some(Held::Vector(n)),
    }
}

/// Whether `name`, read at `at`, is a local of the lambda around it that
/// certainly holds an atom there: every write to it in that body is a plain
/// `name:` of an atom literal, and one of them sits outside every bracket
/// and ends before `at`, so it has run by the time the read does.
///
/// A parameter is never known, whatever it is rebound to: `{[t] t -1}` may
/// be given a list or a function. Nor is a local written only under a
/// condition - q 5 `{[c] if[c; m:5]; m -1}[0b]` reads the unset local as
/// `()`, and indexing that is `()`, no error. Nor is a read in a qSQL
/// statement, where a column of the same name wins: q 5
/// `{t:([]m:1 2 3); m:5; select from t where m=m -1}[]` runs.
fn local_atom(scopes: &[Scope], code: &str, comments: &str, name: &str, at: usize) -> bool {
    let Some(s) = scope_at(scopes, at) else {
        return false;
    };
    let scope = &scopes[s];
    if at < scope.body || scope.params.contains(name) || !scope.locals.contains(name) {
        return false;
    }
    let rel = at - scope.body;
    let direct = scope.direct.as_bytes();
    // Depth-zero statement starts, so the read's own statement is known.
    let mut depth = 0i32;
    let mut statement = 0;
    for (i, &b) in direct[..rel].iter().enumerate() {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth == 0 => statement = i + 1,
            _ => {}
        }
    }
    if re!(r"\b(?:select|exec|update|delete)\b").is_match(&scope.direct[statement..rel]) {
        return false;
    }
    let view = local_view(&scope.direct, true);
    if multi_assignments(&view).any(|(_, n)| n == name) {
        return false;
    }
    let mut dominated = false;
    for w in re!(r"([A-Za-z][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*[-+*%,&|^#_!~=<>$?@.]?::?")
        .captures_iter(&view)
    {
        let whole = w.get(0).unwrap();
        if &w[1] != name || !boundary(&view, whole.start()) {
            continue;
        }
        // `name:` and nothing else: not `name::`, `name+:` or `name[i]:`.
        let Some(plain) =
            re!(r"^[A-Za-z][A-Za-z0-9_]*\s*:([^:]|$)").captures(&view[whole.start()..])
        else {
            return false;
        };
        let start = whole.start() + plain.get(1).unwrap().start();
        let bytes = view.as_bytes();
        let (mut end, mut depth) = (start, 0i32);
        while end < bytes.len() {
            match bytes[end] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1
                }
                b';' if depth == 0 => break,
                _ => {}
            }
            end += 1;
        }
        let (a, b) = (scope.body + start, scope.body + end);
        if held(&code[a..b], &comments[a..b]) != Some(Held::Atom) {
            return false;
        }
        let outside = view.as_bytes()[..whole.start()]
            .iter()
            .fold(0i32, |d, &c| match c {
                b'(' | b'[' | b'{' => d + 1,
                b')' | b']' | b'}' => d - 1,
                _ => d,
            })
            == 0;
        dominated |= outside && end <= rel;
    }
    dominated
}

/// The rules that need to know what a name holds: indexing an atom, two
/// vectors of different lengths paired by an operator, and a select of a
/// column the table does not have. Each one only for a name `held` knows.
/// A question asked of a name.
type Test<'a> = &'a dyn Fn(&str) -> bool;
fn named_values(
    path: &str,
    code: &str,
    raw: &str,
    comments: &str,
    // The scopes, the `\d` namespace in force from each offset on, and the
    // file's global definitions keyed as q resolves them.
    (scopes, namespaces, globals): (&[Scope], &[(usize, String)], &Writes),
    dynamic: bool,
    // Whether another file assigns the name, and whether it assigns it a
    // lambda.
    (elsewhere, foreign_lambda): (Test, Test),
) -> Vec<Finding> {
    let mut out = vec![];
    // A name as q resolves it at `at`, under the `\d` in force there: after
    // `\d .ns`, `a:1` defines `.ns.a`, and a root `a` read after `\d .` is
    // another variable (#190).
    let key = |name: &str, at: usize| -> String {
        let ns = &namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1;
        resolved(name, ns)
    };
    let name_re = r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*";
    // Every place a name is written: `a:`, `a::`, `a+:`, `a[i]:`, `a set`,
    // and `(a;b):`. A name written anywhere but its one plain top-level
    // assignment is not known.
    let mut writes: HashMap<&str, Vec<usize>> = HashMap::new();
    // The same, keyed as q resolves each name where it is written.
    let mut exact: HashMap<String, Vec<usize>> = HashMap::new();
    // A table literal's columns and a dictionary literal's keys, `([]n:1 2)`
    // and `([h:2.5])`, name no variable: each `name:` directly in one is
    // skipped (#469). Only a name that opens a column does: `m:` in
    // `([]a:m:1 2)` assigns the global (#575).
    let literals: Vec<(usize, usize, usize)> = re!(r"\(\s*\[")
        .find_iter(code)
        .filter_map(|m| {
            let header = m.end() - 1;
            Some((
                m.start(),
                matching(code, header, b'[', b']')?,
                matching(code, m.start(), b'(', b')')?,
            ))
        })
        .collect();
    // The bracket depth before each offset, so a name's depth inside a
    // literal is a difference rather than a count over the literal up to it,
    // which made a wide literal quadratic (#711).
    let depth: Vec<i32> = if literals.is_empty() {
        vec![]
    } else {
        std::iter::once(0)
            .chain(code.bytes().scan(0i32, |d, c| {
                match c {
                    b'(' | b'[' | b'{' => *d += 1,
                    b')' | b']' | b'}' => *d -= 1,
                    _ => {}
                }
                Some(*d)
            }))
            .collect()
    };
    let in_literal = |at: usize| {
        literals.iter().any(|&(open, header, close)| {
            open < at && at < close && {
                let depth = depth[at] - depth[open + 1];
                (depth == 0 || (depth == 1 && at < header))
                    && matches!(
                        code[..at].trim_end().as_bytes().last(),
                        Some(b'[' | b']' | b';')
                    )
            }
        })
    };
    for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*(?:\[[^\]]*\])?\s*[-+*%,&|^#_!~=<>$?@.]?::?")
        .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        if !boundary(code, whole.start())
            || code[whole.end()..].starts_with(['/', '\\', '\''])
            || in_literal(whole.start())
        {
            continue;
        }
        writes.entry(m.get(1).unwrap().as_str()).or_default().push(whole.start());
        // A namespace indexed by literal symbols writes just those members:
        // `.cfg[`a]:v` is `.cfg.a`, and leaves `.cfg.b` alone.
        let name = key(m.get(1).unwrap().as_str(), whole.start());
        let members = re!(r"^\.[^\[]*\[\s*((?:`[A-Za-z][A-Za-z0-9_]*)+)\s*\]")
            .captures(whole.as_str())
            .filter(|_| name.starts_with('.'));
        match members {
            Some(c) => {
                for member in c[1].split('`').skip(1) {
                    exact
                        .entry(format!("{name}.{member}"))
                        .or_default()
                        .push(whole.start());
                }
            }
            None => exact.entry(name).or_default().push(whole.start()),
        }
    }
    for m in re!(r"`(\.?[A-Za-z][A-Za-z0-9_.]*)(?:\s+|\s*\)\s*)set\b|\bset\s*\[\s*`(\.?[A-Za-z][A-Za-z0-9_.]*)")
        .captures_iter(code)
    {
        // Infix and bracket form alike: q 5 `a:1;set[`a;2 3];a 0` is 2.
        let name = m.get(1).or(m.get(2)).unwrap().as_str();
        writes.entry(name).or_default().extend([0, 0]);
        exact
            .entry(key(name, m.get(0).unwrap().start()))
            .or_default()
            .extend([0, 0]);
    }
    // `` load `:k `` and `rload` restore the global named by the path's last
    // part: q 5 `` k:([]a:`long$()); load `:k `` redefines `k` (#470).
    for m in re!(LOAD).captures_iter(code) {
        if !boundary(code, m.get(0).unwrap().start()) {
            continue;
        }
        let name = m.get(1).unwrap().as_str();
        writes.entry(name).or_default().extend([0, 0]);
        exact
            .entry(key(name, m.get(0).unwrap().start()))
            .or_default()
            .extend([0, 0]);
    }
    // Each of a symbol list: q 5 `a:2.5; `a`b set' (1 2;3 4); a 0` is 1
    // (#360), parenthesised or not (#464).
    for (whole, names) in each_set_targets(code) {
        for name in names {
            writes.entry(name).or_default().extend([0, 0]);
            exact
                .entry(key(name, whole.start))
                .or_default()
                .extend([0, 0]);
        }
    }
    for (at, name) in multi_assignments(code).chain(global_multi_assignments(code)) {
        writes.entry(name).or_default().extend([0, 0]);
        exact.entry(key(name, at)).or_default().extend([0, 0]);
    }
    // A table changed in place by name: `update c:1 from `t` adds a column,
    // as do `![`t;...]`, `.[`t;...]` and `@[`t;...]`, without an assignment
    // to say so. So does `` `a xkey `t ``, which keys it (q 5: `t lj k`
    // after `` `a xkey `k `` joins), and its neighbours (#353), in the
    // bracket form too, and `` 1!`k `` (q 5: `xkey[`a;`k]` and `` 1!`k ``
    // return `` `k `` and key it) (#466).
    for m in re!(IN_PLACE).captures_iter(code) {
        let name = m.get(1).unwrap().as_str();
        writes.entry(name).or_default().extend([0, 0]);
        exact
            .entry(key(name, m.get(0).unwrap().start()))
            .or_default()
            .extend([0, 0]);
    }
    // A global amended by name in a context: `@[`.;`c;:;v]` writes the root
    // `c`, `@[`.ns;`c;..]` writes `.ns.c`, whatever `\d` is in force (q 5:
    // `c:2.5; @[`.;`c;:;1 2]; c 0` is 1) (#361). So does `.`, and either
    // with the names enlisted: q 5 `.[`.;enlist`a;:;1 2]` and
    // `.[`.;(enlist`a);:;1 2]` write `a` (#463).
    for m in re!(r"[@.]\s*\[\s*`(\.(?:[A-Za-z][A-Za-z0-9_.]*)?)\s*;\s*(?:enlist\b\s*|\(\s*)*((?:`[A-Za-z][A-Za-z0-9_]*)+)")
        .captures_iter(code)
    {
        for name in m[2].split('`').skip(1) {
            let name = match &m[1] {
                "." => name.to_string(),
                ctx => format!("{ctx}.{name}"),
            };
            exact.entry(name).or_default().extend([0, 0]);
        }
    }
    // A global appended to by name: `` `a upsert 4 `` makes `a:1 2 3` four
    // items (q 5). A table keeps its columns, so QT026 and QT027 still read
    // it; any other value is no longer known.
    let upserted: HashSet<String> = re!(
        r"`(\.?[A-Za-z][A-Za-z0-9_.]*)(?:\s+|\s*\)\s*)upsert\b|\bupsert\s*\[\s*`(\.?[A-Za-z][A-Za-z0-9_.]*)"
    )
    .captures_iter(code)
    .filter_map(|m| {
        let name = m.get(1).or(m.get(2)).unwrap();
        let whole = m.get(0).unwrap();
        literal_target(code, name.start() - 1, &code[name.end()..whole.end()])
            .then(|| key(name.as_str(), whole.start()))
    })
    .collect();
    let mut known: HashMap<&str, (usize, Held)> = HashMap::new();
    let mut kinds: HashMap<&str, Arithmetic> = HashMap::new();
    // Names bound to an integer atom, which q applies as a file handle rather
    // than indexing: see QT022 below.
    let mut handles: HashSet<&str> = HashSet::new();
    // A file that evaluates strings can define anything, so nothing is known
    // by name there; the literal-only checks below still hold.
    // Nor is a member of a namespace or dictionary written as a whole:
    // `.cfg:d`, `` `.cfg set d ``, `.cfg,:d`, `` `.cfg upsert d `` and
    // `.cfg[`a]:v` all replace or add members (q 5: `.cfg.a:1`, then any of
    // them giving `a` the value 1 2 3, and `.cfg.a 0` is 1).
    let whole = |name: &str| {
        name.match_indices('.')
            .filter(|&(i, _)| i > 0)
            .any(|(i, _)| exact.contains_key(&name[..i]) || upserted.contains(&name[..i]))
    };
    for (name, at) in exact.iter().filter(|_| !dynamic) {
        let name = name.as_str();
        // One write, or later ones that only index into it at the top level:
        // `a:2.5` + `a[0]:9` leaves `a` an atom, and the indexed assignment
        // is itself the 'type QT022 reports below (q 5, #607).
        let Some((&at, rest)) = at.split_first() else {
            continue;
        };
        let indexes = |&r: &usize| {
            r > at
                && scope_at(scopes, r).is_none()
                && code[r..]
                    .strip_prefix(name)
                    .is_some_and(|after| after.trim_start().starts_with('['))
        };
        if !rest.iter().all(indexes) {
            continue;
        }
        if whole(name) {
            continue;
        }
        if scope_at(scopes, at).is_some() || !boundary(code, at) {
            continue;
        }
        let Some(m) = re!(r"^(\.?[A-Za-z][A-Za-z0-9_.]*)\s*:([^:]|$)").captures(&code[at..]) else {
            continue;
        };
        let start = at + m.get(2).unwrap().start();
        // The value runs to the end of the statement: a top-level `;`, or a
        // newline the next line does not continue.
        let mut end = start;
        let mut depth = 0i32;
        let bytes = code.as_bytes();
        while end < bytes.len() {
            match bytes[end] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1
                }
                b';' if depth == 0 => break,
                b'\n' if depth == 0 && !code[end + 1..].starts_with([' ', '\t']) => break,
                _ => {}
            }
            end += 1;
        }
        if let Some(value) = held(&code[start..end], &comments[start..end])
            // An indexed write into anything but an atom may change it:
            // `d[`c]:3` adds a key.
            && (rest.is_empty() || value == Held::Atom)
        {
            // Read as `held` reads it, inside any grouping parentheses:
            // `out:(1)` is a handle and `a:("abc")` a string (#693).
            let text = ungrouped(&code[start..end], &comments[start..end]).map_or("", |v| v.1);
            // `0N` and `0W` are integers too: uqf's tick.q starts a log
            // handle as `0N` and sets it with hopen later. Not a short: q 5
            // `h:1h; h "hi"` is 'type, where `2i "hi"` writes (#477).
            if re!(r"^\s*-?(?:\d+|0[NW])[ij]?\s*$").is_match(text) {
                handles.insert(name);
            }
            known.insert(name, (end, value));
            if let Some(kind) = arithmetic_kind(text) {
                kinds.insert(name, kind);
            }
        }
    }
    known.retain(|name, (_, value)| matches!(value, Held::Table(..)) || !upserted.contains(*name));
    kinds.retain(|name, _| known.contains_key(name));
    // A read sees the global only after it is assigned, at the top level, and
    // only where no local of the same name hides it. Where another file of
    // the workspace assigns the name too, a lambda body may run after either
    // assignment, which load order decides and the text cannot say; but a
    // top-level read after this file's own assignment meets that one,
    // whatever was loaded before (q 5: `g:{x}` loaded, then `g:2.5` + `g 0`,
    // is 'type) - unless the file calls, in between, a lambda another file
    // defines, which may assign the name: q 5 runs `b:1 2`, `init[]`, `a+b`
    // to 2 4 6 once lib.q's `init:{b::1 2 3}` is loaded (#523).
    // Inside a qSQL phrase a column of the table wins over the global of the
    // same name, and the text cannot say which columns the table has (#465).
    let foreign_calls: Vec<usize> = re!(r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*")
        .find_iter(code)
        .filter(|m| boundary(code, m.start()) && foreign_lambda(&key(m.as_str(), m.start())))
        .map(|m| m.start())
        .collect();
    let called_between = |from: usize, to: usize| {
        let i = foreign_calls.partition_point(|&c| c < from);
        foreign_calls.get(i).is_some_and(|&c| c < to)
    };
    let phrases = qsql_phrases(code);
    // The first phrase, in `qsql_phrases`' order, around each offset: asking
    // the list for every name read was quadratic in a file of queries
    // (#709). Each phrase claims the offsets no earlier one has, skipping
    // claimed runs through `next`.
    let owner: Vec<u32> = {
        let n = code.len();
        let mut owner = vec![u32::MAX; n];
        let mut next: Vec<usize> = (0..=n).collect();
        fn find(next: &mut [usize], mut i: usize) -> usize {
            while next[i] != i {
                next[i] = next[next[i]];
                i = next[i];
            }
            i
        }
        for (index, &(a, b, _)) in phrases.iter().enumerate() {
            let b = b.min(n);
            let mut i = find(&mut next, a.min(n));
            while i < b {
                owner[i] = index as u32;
                next[i] = i + 1;
                i = find(&mut next, i + 1);
            }
        }
        owner
    };
    let global = |name: &str, at: usize| -> Option<&Held> {
        let (assigned, value) = known.get(key(name, at).as_str())?;
        match scope_at(scopes, at) {
            Some(s) if scopes[s].locals.contains(name) => None,
            Some(_) if elsewhere(&key(name, at)) => None,
            None if at < *assigned => None,
            None if elsewhere(&key(name, at)) && called_between(*assigned, at) => None,
            _ => Some(value),
        }
    };
    // In a phrase, a name is a column unless the table is a known literal
    // without that column, and nothing renames into it by symbol (`` `t ``
    // in an `update ... from `t` may add one): q 5 `px:2.5; t:([]a:1 2);
    // select p0:px 0 from t` is 'type (#576).
    // Every name a symbol spells, gathered once: searching the file for each
    // read in a phrase made a long where phrase quadratic (#707).
    let symbols: HashSet<&str> = re!(r"`(\.?[A-Za-z][A-Za-z0-9_.]*)")
        .captures_iter(code)
        .map(|c| c.get(1).unwrap().as_str())
        .collect();
    let visible = |name: &str, at: usize| -> Option<&Held> {
        if let Some(&(a, b, table)) = owner
            .get(at)
            .filter(|&&i| i != u32::MAX)
            .map(|&i| &phrases[i as usize])
        {
            let columns = table
                .filter(|&(t, e)| !symbols.contains(&code[t..e]))
                .and_then(|(t, e)| match global(&code[t..e], t) {
                    Some(Held::Table(columns, _)) => Some(columns),
                    _ => None,
                });
            // Only once the table is known: read for every name in a phrase,
            // a long where phrase was quadratic (#707).
            let assigned_here = || {
                re!(r"([A-Za-z][A-Za-z0-9_]*)\s*:")
                    .captures_iter(&code[a..b.min(code.len())])
                    .any(|c| &c[1] == name)
            };
            match columns {
                Some(columns)
                    if name != "i" && !columns.iter().any(|c| c == name) && !assigned_here() => {}
                _ => return None,
            }
        }
        global(name, at)
    };
    // Indexing an atom. Verified: 1, 1b, 1.5, "x" and 2020.01.01 bound to a
    // name and then indexed - `a[0]`, `a[]`, `a[0]:5` - are all 'type.
    // Bracketed, `f[0]`, with `@` or `.`, or juxtaposed, `f 0`: the same
    // indexing (q 5: `a:2.5;a@0` is 'type). Juxtaposed
    // only before something that is an argument - a literal, a bracket, a
    // name that is not an infix builtin (`f mod 2` is not indexing `f`) -
    // and not before a negative literal, which is QB010's. The argument may
    // start the indented line that continues the statement, past blank and
    // comment lines (`blank!`): q 5 `s:b` over `  0` is 'type (#687).
    // Iterated too, `a'[0 1]` and `a each 0 1`, and with nothing between the
    // name and a symbol or parenthesis, `` a`b `` and `a(0)` (q 5: 'type).
    // `@[a;0]` and `.[a;enlist 0]` are read after this loop (#608).
    let indexed = re!(concat!(
        r#"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)(?:\[|'[ \t]*\[|[`(]|[ \t]*@[ \t]*[0-9"`(A-Za-z]|[ \t]+\.[ \t]+[0-9"`(A-Za-z]|"#,
        blank!(),
        r#"+([0-9"`(]|\.?[A-Za-z][A-Za-z0-9_]*))"#
    ));
    // From each name on, not match after match: in `show a 0` the match
    // `show a` would hide `a 0` (q 5: 'type) (#471).
    // Over `comments`, where a string keeps its quotes: `k "hi"` and
    // `k@"hi"` index an atom with a string (q 5: 'type) (#472). The name
    // itself must be code, not inside a string.
    let mut at = 0;
    while let Some(m) = indexed.captures_at(comments, at) {
        let name = m.get(1).unwrap();
        at = name.end();
        if code.get(name.range()) != Some(name.as_str()) {
            continue;
        }
        // Nor before a qSQL word, which ends the column list or the clause:
        // `update time:t0 from t` fills the column from the atom (q 5, #114).
        if m.get(2).is_some_and(|next| {
            (INFIX.contains(&next.as_str()) && next.as_str() != "each")
                || matches!(next.as_str(), "by" | "from" | "where")
        }) {
            continue;
        }
        if !boundary(code, name.start())
            || visible(name.as_str(), name.start()) != Some(&Held::Atom)
        {
            continue;
        }
        // An integer is applied as a file handle. Given a string it may well
        // write - `out:1; out["hi\n"]` prints - but given a number or nothing
        // it cannot: 'type on an open handle, and on one that is not q 5
        // tries the write and fails - `a:5; a[0]` is 'Cannot write to handle
        // 5. OS reports: Bad file descriptor (#507). A name or anything else might be a string.
        if handles.contains(key(name.as_str(), name.start()).as_str()) {
            // `a@0` and `a . enlist 0` apply it the same way (q 5).
            let after = &raw[crate::past_blanks(code, name.end())..];
            let after = after
                .strip_prefix(['@', '.'])
                .map_or(after, |a| a.trim_start_matches([' ', '\t']));
            let argument = match after.strip_prefix('[') {
                Some(inside) => inside.trim_start_matches([' ', '\t']),
                None => after,
            };
            let numeric = re!(r"^(?:-?\d|\])").is_match(argument);
            if numeric {
                out.push(Finding::at(
                    path,
                    raw,
                    name.start(),
                    "QT022",
                    format!(
                        "`{}` holds an integer, which q applies as a file handle; a handle \
                         takes a string, so this is 'type - or, if the handle is not open, \
                         'Cannot write to handle",
                        name.as_str()
                    ),
                ));
            }
            continue;
        }
        out.push(Finding::at(
            path,
            raw,
            name.start(),
            "QT022",
            format!(
                "`{}` is an atom here, and an atom has no items to index: 'type",
                name.as_str()
            ),
        ));
    }
    for m in re!(r"[@.][ \t]*\[[ \t]*(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)[ \t]*;")
        .captures_iter(code)
    {
        let name = m.get(1).unwrap();
        let open = m.get(0).unwrap().start() + code[m.get(0).unwrap().start()..].find('[').unwrap();
        // Two slots: a third is a protected call's handler, which catches
        // the error, and four amend.
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        if crate::slots(&code[open + 1..close - 1]).len() != 2
            || !boundary(code, m.get(0).unwrap().start())
            || visible(name.as_str(), name.start()) != Some(&Held::Atom)
            || handles.contains(key(name.as_str(), name.start()).as_str())
        {
            continue;
        }
        out.push(Finding::at(
            path,
            raw,
            name.start(),
            "QT022",
            format!(
                "`{}` is an atom here, and an atom has no items to index: 'type",
                name.as_str()
            ),
        ));
    }
    // QB010 for a name bound to an atom: `a -1` applies it to `-1` rather
    // than subtracting, and an atom cannot be applied - q 5 `a:3; a -1` is
    // 'domain, `a:1.5; a -1` and `w:.z.p; w -0D00:01` are 'type. A name that
    // may hold a list is left alone: `a:1 2 3; a -1` indexes, and is 0N.
    // The literal has to end the statement or bracket, as in `lib.rs`, or
    // the lambda: q 5 `a:2.5; f:{a -1}; f[]` is 'type (#473).
    // The literal may start the indented line that continues the statement:
    // q 5 `r:a` over `  -1` is 'domain too (#687).
    for m in re!(concat!(
        r"(?m)(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)",
        blank!(),
        r"+(-\d[A-Za-z0-9.:]*)[ \t\r]*(?:[;\])}]|$)"
    ))
    .captures_iter(code)
    {
        let name = m.get(1).unwrap();
        if !boundary(code, name.start())
            || visible(name.as_str(), name.start()) != Some(&Held::Atom)
        {
            continue;
        }
        out.push(Finding::at(
            path,
            raw,
            name.start(),
            "QB010",
            crate::apply_not_subtract(name.as_str(), &m[2]),
        ));
    }
    // And for a local bound to an atom earlier in the same lambda body: q 5
    // `{[] m:1.5; m -1}[]` and `{[] s:.z.p; s -0D00:00:01}[]` are 'type
    // like their top-level forms. A lambda's closing brace ends the literal too.
    // `local_atom` says when the text is sure.
    for m in re!(concat!(
        r"(?m)(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)",
        blank!(),
        r"+(-\d[A-Za-z0-9.:]*)[ \t\r]*(?:[;\])}]|$)"
    ))
    .captures_iter(code)
    {
        let name = m.get(1).unwrap();
        if !boundary(code, name.start())
            || !local_atom(scopes, code, comments, name.as_str(), name.start())
        {
            continue;
        }
        out.push(Finding::at(
            path,
            raw,
            name.start(),
            "QB010",
            crate::apply_not_subtract(name.as_str(), &m[2]),
        ));
    }
    // Two vectors of known, different lengths under an operator that pairs
    // items - QT006 for a name rather than a literal. `,` and `~` take any
    // lengths and are not in the set.
    let vector = r"-?\d(?:[A-Za-z0-9.]*[eE][+-])?[A-Za-z0-9.]*(?:(?:[ \t]+|[ \t]*\r?\n[ \t]+)-?\d(?:[A-Za-z0-9.]*[eE][+-])?[A-Za-z0-9.]*)+|(?:`[A-Za-z0-9_.]*){2,}|\([^()]*;[^()]*\)";
    // The statement's blanks around the operator: `bump:v+` and then a
    // column-0 `1 2` are two statements (#742).
    let pair = regex::Regex::new(&format!(
        concat!(
            r"(?P<l>{name_re}|{vector})",
            blank!(),
            r"*(?P<op><>|<=|>=|[+*%&|=<>^-]|\b(?:and|or|mod|div|xexp|xlog)\b)",
            blank!(),
            r"*(?P<r>{name_re}|{vector})"
        ),
        name_re = name_re,
        vector = vector
    ))
    .unwrap();
    let length = |text: &str, at: usize| -> Option<usize> {
        if re!(r"^\.?[A-Za-z]").is_match(text) {
            match visible(text, at)? {
                Held::Vector(n) => Some(*n),
                _ => None,
            }
        } else {
            shape(text)
        }
    };
    let mut at = 0;
    while let Some(m) = pair.captures_at(code, at) {
        let (l, op, r) = (
            m.name("l").unwrap(),
            m.name("op").unwrap(),
            m.name("r").unwrap(),
        );
        at = l.end();
        let named = [l, r].iter().any(|x| {
            x.as_str()
                .starts_with(|c: char| c.is_alphabetic() || c == '.')
        });
        // Only a digit makes `-` part of a literal: q 5 parses `a -b` as
        // `(-;`a;`b)`, a subtraction (#476).
        let negative = op.as_str() == "-"
            && code[..op.start()].ends_with(char::is_whitespace)
            && re!(r"^\.?\d").is_match(&code[op.end()..]);
        if !named
            || negative
            || !boundary(code, l.start())
            || !operand_ends(code, comments, r.end())
        {
            continue;
        }
        if let (Some(a), Some(b)) = (length(l.as_str(), l.start()), length(r.as_str(), r.start()))
            && a != b
        {
            out.push(Finding::at(
                path,
                raw,
                l.start(),
                "QT006",
                format!(
                    "`{}` pairs {} items with {}; that is a 'length error",
                    op.as_str(),
                    a,
                    b
                ),
            ));
        }
    }
    // Integer arithmetic on a char. On q 5, the reference this linter is
    // checked against, `+` and `*` refuse a char beside anything integral -
    // another char, a long, an int, a boolean, a byte - and `-` refuses a
    // char on its left; a float or a temporal operand is fine, `%` always
    // is, and so is a char on the right of `-`. Checked exhaustively over
    // those operand kinds. An older note in this repository had `"a"*3` as
    // 291, on a version it did not record.
    // Booleans and bytes before plain integers, or `1b` matches as `1`.
    let operand = r#""(?:\\.|[^"\\])*"|[01]+b|0x[0-9a-fA-F]+|(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[ \t]+)*-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?e\b|-?0[NW][hij]?\b|-?\d+[hij]?(?:[ \t]+-?\d+[hij]?)*|\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*"#;
    // The statement's blanks around the operator: `inc:x+` and then a
    // column-0 `"done"` are two statements (#741).
    let infix = regex::Regex::new(&format!(
        concat!(
            r"(?P<l>{operand})",
            blank!(),
            r"*(?P<op>[-+*])",
            blank!(),
            r"*(?P<r>{operand})"
        ),
        operand = operand
    ))
    .unwrap();
    let kind_of = |text: &str, at: usize| -> Option<Arithmetic> {
        // `.5e` is a number, `.ns.a` a name (#587).
        if text.starts_with(char::is_alphabetic) || re!(r"^\.[A-Za-z]").is_match(text) {
            visible(text, at)?;
            kinds.get(key(text, at).as_str()).copied()
        } else {
            arithmetic_kind(text)
        }
    };
    let mut at = 0;
    while let Some(m) = infix.captures_at(comments, at) {
        let (l, op, r) = (
            m.name("l").unwrap(),
            m.name("op").unwrap(),
            m.name("r").unwrap(),
        );
        at = l.end();
        // The operator has to be code - not inside a string or a comment -
        // and the right operand the whole of one. Only a digit makes `-`
        // part of a literal: q 5 parses `c -n` as `(-;`c;`n)` (#485).
        let negative = op.as_str() == "-"
            && comments[..op.start()].ends_with(char::is_whitespace)
            && re!(r"^\.?\d").is_match(&comments[op.end()..]);
        // Nor the digits after a temporal literal's `:` - the `00` of
        // `12:00` - which q 5 adds to a char: `12:00+"a"` is 13:37 (#468).
        // A real's `e` before a signed digit is a float's exponent: `1e+5`
        // and `1e-5` are 100000f and 0.00001.
        let exponent = |x: &regex::Match| {
            x.as_str().ends_with('e') && re!(r"^[+-]\d").is_match(&comments[x.end()..])
        };
        if exponent(&l) || exponent(&r) {
            continue;
        }
        // Digits that end a name are no time: `r21:1*"a"` and `x2:2+"a"`
        // assign, and are 'type (#497), while `2024.01.01D12:00+"a"` is not.
        let named = |end: usize| {
            let start = comments[..end]
                .trim_end_matches(|c: char| c.is_ascii_alphanumeric() || "_.".contains(c))
                .len();
            comments[start..].starts_with(|c: char| c.is_alphabetic() || c == '.')
        };
        let temporal = l.as_str().starts_with(|c: char| c.is_ascii_digit())
            && comments[..l.start()].ends_with(':')
            && comments[..l.start() - 1].ends_with(|c: char| c.is_ascii_digit())
            && !named(l.start() - 1);
        if code.get(op.range()) != Some(op.as_str())
            || negative
            || temporal
            || !boundary(comments, l.start())
            || !operand_ends(code, comments, r.end())
        {
            continue;
        }
        let (Some(a), Some(b)) = (
            kind_of(l.as_str(), l.start()),
            kind_of(r.as_str(), r.start()),
        ) else {
            continue;
        };
        let refused = match op.as_str() {
            "-" => a == Arithmetic::Char,
            _ => a == Arithmetic::Char || b == Arithmetic::Char,
        };
        if refused && a != Arithmetic::Float && b != Arithmetic::Float {
            out.push(Finding::at(
                path,
                raw,
                l.start(),
                "QT023",
                format!(
                    "`{}{}{}` is 'type: q 5 does no integer arithmetic on a char",
                    l.as_str(),
                    op.as_str(),
                    r.as_str()
                ),
            ));
        }
    }
    // A select or exec naming a column the table literal does not have. q
    // looks for a column, then a variable, and raises the name when neither
    // exists - `select b from ([]a:1 2)` is 'b. So only a name nothing in
    // this file defines: a global or local of that name changes the error
    // or removes it. `i` is the virtual row index. A global, that is: a
    // column alias, another table's column or another lambda's local defines
    // nothing here - q 5 `k:([]a:1 2); f:{b:1; b}; select b from k` is 'b.
    let is_free = |name: &str, at: usize, columns: &[String]| {
        re!(r"^[A-Za-z][A-Za-z0-9_]*$").is_match(name)
            && name != "i"
            && !columns.iter().any(|c| c == name)
            && !globals.contains_key(&key(name, at))
            && !elsewhere(&key(name, at))
            // Nor one defined in `.q`, which every context reads: q 5 runs
            // `.q.bb:10 20` then `select bb from ([]a:1 2)` (#524).
            && !globals.contains_key(&format!(".q.{name}"))
            && !elsewhere(&format!(".q.{name}"))
            && !crate::RESERVED.iter().any(|n| n == name)
            && !scope_at(scopes, at).is_some_and(|s| scopes[s].locals.contains(name))
    };
    let mut column = |at: usize, name: &str, table: &str, columns: &[String]| {
        out.push(Finding::at(
            path,
            raw,
            at,
            "QF020",
            format!(
                "`{name}` is not a column of `{table}` ({}), and nothing in this file defines it: '{name}",
                columns.join(", ")
            ),
        ));
    };
    // No `\b` before the keyword: `1_select` is a drop of a select (#351),
    // and `boundary` tells that from the name `x_select`. An indented line
    // continues the column list, and in a lambda a newline is whitespace (#336).
    for m in re!(r"(?:select|exec|update)\b((?:[^\n;]|\n[ \t])*?)\bfrom\s+(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\b")
    .captures_iter(code)
    {
        if !boundary(code, m.get(0).unwrap().start()) {
            continue;
        }
        let table = m.get(2).unwrap();
        // The name has to be the whole from clause: `from t lj k`, `from t,'u`
        // and `from t uj u` bring in columns `t` does not have (#348).
        if !operand_ends(code, comments, table.end()) {
            continue;
        }
        let Some(Held::Table(columns, _)) = visible(table.as_str(), table.start()) else {
            continue;
        };
        let phrase = m.get(1).unwrap();
        // Items are separated by `,`, and `by` starts the grouping list,
        // whose columns are looked up the same way.
        // Only at the top level: a `,` inside a lambda or a call is the
        // item's own, and so are the names it binds - `x` in
        // `{"<p>",x,"</p>"} each header` is the lambda's argument (#297).
        let mut depth = 0i32;
        let top: Vec<bool> = phrase
            .as_str()
            .bytes()
            .map(|c| {
                match c {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => depth -= 1,
                    _ => {}
                }
                depth == 0
            })
            .collect();
        // A `from` inside a bracket is a nested query's, and the table it
        // names is not this list's: `select a, n:(exec count i from u) from t`
        // (#342). The where pass reads such a query in its own right.
        if depth != 0 {
            continue;
        }
        // A row limit, `select[2]` or `select[2;>a]`, is not an item.
        let limit = phrase.as_str().trim_start().starts_with('[')
            .then(|| {
                let open = phrase.start() + phrase.as_str().len() - phrase.as_str().trim_start().len();
                matching(code, open, b'[', b']')
            })
            .flatten()
            .unwrap_or(phrase.start());
        let mut cuts = vec![limit];
        for sep in re!(r",|\bby\b").find_iter(phrase.as_str()) {
            if !top[sep.start()] {
                continue;
            }
            cuts.push(phrase.start() + sep.start());
            cuts.push(phrase.start() + sep.end());
        }
        cuts.push(phrase.end());
        for pair in cuts.chunks(2) {
            let (offset, part) = (pair[0], &code[pair[0]..pair[1]]);
            let item = part.trim();
            let lead = part.len() - part.trim_start().len();
            let (bare, skip) = match item.split_once(':') {
                Some((alias, value)) if re!(r"^[A-Za-z][A-Za-z0-9_]*$").is_match(alias.trim()) => (
                    value.trim(),
                    item.len() - item.split_once(':').unwrap().1.trim_start().len(),
                ),
                _ => (item, 0),
            };
            // Every name in the item, not only a bare one: q 5 raises 'c on
            // `select max c from t` and `select c+1 from t` alike (#493). A
            // lambda's names are its own, and a symbol names nothing.
            let base = offset + lead + skip;
            let mut flat = bare.as_bytes().to_vec();
            let mut lambda = 0i32;
            for (i, &c) in bare.as_bytes().iter().enumerate() {
                if c == b'{' {
                    lambda += 1;
                }
                if lambda > 0 {
                    flat[i] = b' ';
                }
                if c == b'}' {
                    lambda -= 1;
                }
            }
            for sym in re!(r"`[A-Za-z0-9_./:]*").find_iter(bare) {
                flat[sym.range()].fill(b' ');
            }
            let flat = String::from_utf8_lossy(&flat).into_owned();
            for name in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&flat) {
                let at = base + name.start();
                if boundary(code, at)
                    && !flat[name.end()..].starts_with('.')
                    && is_free(name.as_str(), phrase.start(), columns)
                {
                    column(at, name.as_str(), table.as_str(), columns);
                }
            }
        }
    }
    // The where phrase, in any of the four: `select from t where c>0` is 'c
    // when t has no c and nothing defines one. Names inside a lambda in the
    // phrase are that lambda's own and are left alone, and so are a nested
    // query's, which are its table's (#259). The phrase ends at a bracket it
    // did not open: `(select from t where a>1),select ...` (#260), or a `;`
    // outside every bracket.
    let mut from = 0;
    while let Some(m) = re!(r"(?:select|exec|update|delete)\b[^\n;]*?\bfrom\s+(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s+where\b")
        .captures_at(code, from)
    {
        if !boundary(code, m.get(0).unwrap().start()) {
            from = m.get(0).unwrap().start() + 1;
            continue;
        }
        // The rest of the line, read only as far as the phrase goes: a copy
        // or a capture of the whole line for each phrase on it was quadratic
        // in a line of many statements (#1205).
        let start = m.get(0).unwrap().end();
        let line_end = code[start..].find('\n').map_or(code.len(), |p| start + p);
        let phrase = &code[start..line_end];
        let mut flat = Vec::new();
        let (mut depth, mut lambda, mut nested) = (0i32, 0i32, None);
        let mut end = phrase.len();
        for (i, &c) in phrase.as_bytes().iter().enumerate() {
            flat.push(c);
            match c {
                b'(' | b'[' => depth += 1,
                b'{' => lambda += 1,
                b'}' => {
                    lambda -= 1;
                    flat[i] = b' ';
                }
                // A `;` ends the statement only outside brackets: `where a
                // within (1;c)` reads `c` too (#494).
                b')' | b']' | b';' if depth == 0 && lambda == 0 => {
                    flat.pop();
                    end = i;
                    break;
                }
                b')' | b']' => depth -= 1,
                _ => {}
            }
            if nested.is_some_and(|d| depth < d) {
                nested = None;
            }
            if nested.is_none()
                && phrase
                    .get(i..)
                    .is_some_and(|rest| re!(r"^(?:select|exec|update|delete)\b").is_match(rest))
                && boundary(code, start + i)
            {
                nested = Some(depth);
            }
            if lambda > 0 || nested.is_some() {
                flat[i] = b' ';
            }
        }
        flat.truncate(end);
        // A symbol names no column, and runs on through `:` and `/`:
        // `` `:db/quote `` and `` `a:zz `` are one symbol each (#341).
        for sym in re!(r"`[A-Za-z0-9_./:]*").find_iter(&phrase[..end]) {
            flat[sym.range()].fill(b' ');
        }
        from = start + end.max(1);
        let flat = String::from_utf8_lossy(&flat).into_owned();
        let table = m.get(1).unwrap();
        let Some(Held::Table(columns, _)) = visible(table.as_str(), table.start()) else {
            continue;
        };
        for name in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&flat) {
            let at = start + name.start();
            if boundary(code, at) && !flat[name.end()..].starts_with('.') && is_free(name.as_str(), at, columns) {
                column(at, name.as_str(), table.as_str(), columns);
            }
        }
    }
    // `` `c xkey t `` and its neighbours name columns by symbol, so a
    // missing one is the error whatever the file defines.
    for m in re!(r"((?:`[A-Za-z][A-Za-z0-9_]*)+)\s+(?:xkey|xasc|xdesc|xcols)\s+(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)").captures_iter(code) {
        let table = m.get(2).unwrap();
        if !operand_ends(code, comments, table.end()) {
            continue;
        }
        let Some(Held::Table(columns, _)) = visible(table.as_str(), table.start()) else {
            continue;
        };
        let symbols = m.get(1).unwrap();
        let mut at = symbols.start();
        for sym in symbols.as_str().split('`').skip(1) {
            if !columns.iter().any(|c| c == sym) {
                column(at + 1, sym, table.as_str(), columns);
            }
            at += sym.len() + 1;
        }
    }
    // QF023. In a qSQL phrase a column of the table wins over a local of the
    // same name: q 5 `{[sym] select from ([]sym:`a`b) where sym=sym}` gives
    // both rows for any argument, `sym=sym` comparing the column with itself.
    // Reported only where the local is never read anywhere else in its
    // lambda - every read is a phrase over a table known to have that column
    // - so its value is lost, not just unused once: `{[px] t:([]px:px);
    // select px from t}` reads the parameter to build the table, and means
    // the column after. The table is a table literal written after `from`,
    // or a name this file holds one in; a where phrase reads its statement's.
    let mut phrase_columns: Vec<Option<Vec<String>>> = Vec::with_capacity(phrases.len());
    for (i, &(a, b, table)) in phrases.iter().enumerate() {
        let columns = if code[a..].starts_with("where") {
            i.checked_sub(1).and_then(|j| phrase_columns[j].clone())
        } else if let Some((t, e)) = table {
            match global(&code[t..e], t) {
                Some(Held::Table(columns, _)) => Some(columns.clone()),
                _ => None,
            }
        } else if code.get(b..).is_some_and(|rest| rest.starts_with("from")) {
            let open = crate::past_blanks(code, b + 4);
            (code.as_bytes().get(open) == Some(&b'('))
                .then(|| matching(code, open, b'(', b')'))
                .flatten()
                .filter(|&close| operand_ends(code, comments, close))
                .and_then(|close| match held(&code[open..close], &raw[open..close]) {
                    Some(Held::Table(columns, _)) => Some(columns),
                    _ => None,
                })
        } else {
            None
        };
        phrase_columns.push(columns);
    }
    for scope in scopes {
        let mut reads: HashMap<&str, (usize, bool)> = HashMap::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&scope.direct) {
            let at = scope.body + m.start();
            let name = m.as_str();
            let rest = scope.direct[m.end()..].trim_start_matches([' ', '\t']);
            if name == "i"
                || !scope.locals.contains(name)
                || (!scope.named && matches!(name, "x" | "y" | "z"))
                || !boundary(code, at)
                || rest.starts_with([':', '.'])
            {
                continue;
            }
            let shadowed = owner
                .get(at)
                .filter(|&&p| p != u32::MAX)
                .and_then(|&p| phrase_columns[p as usize].as_ref())
                .is_some_and(|columns| columns.iter().any(|c| c == name));
            let entry = reads.entry(name).or_insert((at, true));
            entry.1 &= shadowed;
        }
        let mut lost: Vec<(usize, &str)> = reads
            .into_iter()
            .filter(|(_, (_, shadowed))| *shadowed)
            .map(|(name, (at, _))| (at, name))
            .collect();
        lost.sort();
        for (at, name) in lost {
            let what = if scope.params.contains(name) {
                "parameter"
            } else {
                "local"
            };
            out.push(Finding::at(
                path,
                raw,
                at,
                "QF023",
                format!(
                    "`{name}` is a column of the table this query reads, and in a qSQL phrase \
                     the column wins, so the {what} `{name}` is never read in this lambda: \
                     rename one of them"
                ),
            ));
        }
    }
    // QT026. lj, ij and pj join on the right table's key, so an unkeyed right
    // table is 'type - checked for all three; uj takes any and is not here.
    // ljf and ijf too, and the bracket form `lj[t;s]` (q 5: 'type). The
    // keyword or the right table may be parenthesised, `(lj)[t;s]` and
    // `t lj (s)` (q 5: 'type, #618). Not the last segment of a dotted
    // name: `.t.lj[k;a;b]` is a function of the file's own (#666).
    // Applied infix, the right table is in the same statement: `join:t lj`
    // and then a column-0 `([]z:1 2)` are two (#742).
    for m in re!(concat!(
        r"(?:\b(ljf|ijf|lj|ij|pj)|\((ljf|ijf|lj|ij|pj)\))(?:",
        blank!(),
        r"+|\s*\[[^;\[\]]*;\s*)(\(\s*\[|\(\s*(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\)|\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)"
    ))
    .captures_iter(code)
    .filter(|m| !code[..m.get(0).unwrap().start()].ends_with('.'))
    {
        let keyword = m.get(1).or(m.get(2)).unwrap();
        let whole = m.get(3).unwrap();
        let unkeyed = if let Some(right) = m.get(4) {
            operand_ends(code, comments, whole.end())
                && matches!(
                    visible(right.as_str(), right.start()),
                    Some(Held::Table(_, false))
                )
        } else if whole.as_str().starts_with('(') {
            let right = whole;
            let open = right.start();
            matching(code, open, b'(', b')').is_some_and(|close| {
                operand_ends(code, comments, close)
                    && code[open + 1..].trim_start().starts_with("[]")
            })
        } else {
            let right = whole;
            operand_ends(code, comments, right.end())
                && matches!(
                    visible(right.as_str(), right.start()),
                    Some(Held::Table(_, false))
                )
        };
        if unkeyed {
            out.push(Finding::at(
                path,
                raw,
                m.get(0).unwrap().start(),
                "QT026",
                format!(
                    "`{}` joins on the right table's key, and this one has none: 'type; key it with `xkey`",
                    keyword.as_str()
                ),
            ));
        }
    }
    // QT027. insert and upsert take one value per column, keys included:
    // `` `t insert (5;6;7) `` into a two-column table is 'length. q 5 says
    // the same of the bracket form, `insert[`t;(1;2;3)]`, of upsert on the
    // table itself, `t upsert (1;2;3)`, and of a simple vector row,
    // `` `t insert 1 2 3 ``, whose items are the values.
    let name = r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*";
    let row = r"\(|-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)+";
    // Infix, the row is in the same statement: `add:`t insert` and then a
    // column-0 `(1;2;3)` are two statements (#743).
    let forms = regex::Regex::new(&format!(
        concat!(
            r"`(?P<a>{name})",
            blank!(),
            r"+(?P<op1>insert|upsert)",
            blank!(),
            r"*(?P<r1>{row})|(?:^|[^A-Za-z0-9_.`])(?P<b>{name})",
            blank!(),
            r"+(?P<op2>upsert)",
            blank!(),
            r"*(?P<r2>{row})|\b(?P<op3>insert|upsert)\s*\[\s*`(?P<c>{name})\s*;\s*(?P<r3>{row})"
        ),
        name = name,
        row = row
    ))
    .unwrap();
    let dictionary = re!(r"^\(?\s*(?:`[A-Za-z][A-Za-z0-9_.]*)+\s*\)?\s*!");
    let dictionaries: HashSet<&str> = re!(
        r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*:\s*\(?\s*(?:`[A-Za-z][A-Za-z0-9_.]*)+\s*\)?\s*!"
    )
    .captures_iter(code)
    .filter(|m| boundary(code, m.get(0).unwrap().start()))
    .map(|m| m.get(1).unwrap().as_str())
    .collect();
    for m in forms.captures_iter(code) {
        let table = m.name("a").or(m.name("b")).or(m.name("c")).unwrap();
        let op = m
            .name("op1")
            .or(m.name("op2"))
            .or(m.name("op3"))
            .unwrap()
            .as_str();
        let r = m.name("r1").or(m.name("r2")).or(m.name("r3")).unwrap();
        let mut rows = vec![];
        let (values, end) = if r.as_str() == "(" {
            let Some(close) = matching(code, r.start(), b'(', b')') else {
                continue;
            };
            // A table literal is a table, matched by column name, not a row
            // of values: q 5 runs `` `t upsert ([]a:7 8;b:9 10) `` on a
            // three-column `t` (#467).
            if code[r.start() + 1..close].trim_start().starts_with('[') {
                continue;
            }
            let slots = crate::slots(&code[r.start() + 1..close - 1]);
            // Nor is a list of dictionaries, which is a table too: q 5 runs
            // `` `t insert (`a`b`c!(1;`x;1f);`a`b`c!(2;`y;2f)) ``, and the
            // same with each dictionary bound to a name first (#752).
            if slots.iter().any(|slot| {
                let slot = slot.trim();
                dictionary.is_match(slot) || dictionaries.contains(slot)
            }) {
                continue;
            }
            // upsert also takes a list of rows: q 5 runs
            // `t upsert ((1;`a);(3;`b);(5;`c))` on a two-column t, and
            // `s upsert (1 2;3 4;5 6)`, where insert raises 'length. Read
            // that only when every slot is a row - a list in parentheses or a
            // vector literal - since a mix such as `(1 2;3;4)` runs with the
            // atoms extended; a row whose count is not the columns' is still
            // 'length.
            if op == "upsert" {
                let row = |slot: &str| -> Option<usize> {
                    let slot = slot.trim();
                    if slot.starts_with('(') && matching(slot, 0, b'(', b')') == Some(slot.len()) {
                        let n = crate::slots(&slot[1..slot.len() - 1]).len();
                        return (n > 1).then_some(n);
                    }
                    // A vector's items may run on across a line break into
                    // an indented line: `(1` over `  2;3;4)` is `(1 2;3;4)`
                    // (#684).
                    re!(concat!(
                        r"^(?:-?\d[A-Za-z0-9.]*(?:",
                        blank!(),
                        r"+-?\d[A-Za-z0-9.]*)+|(?:`[A-Za-z0-9_.]*){2,})$"
                    ))
                    .is_match(slot)
                    .then(|| {
                        if slot.starts_with('`') {
                            slot.matches('`').count()
                        } else {
                            slot.split_whitespace().count()
                        }
                    })
                };
                let read: Vec<_> = slots.iter().map(|s| row(s)).collect();
                if read.iter().any(Option::is_some) {
                    if read.iter().any(Option::is_none) {
                        continue;
                    }
                    rows = read.into_iter().flatten().collect();
                }
            }
            (slots.len(), close)
        } else {
            (r.as_str().split_whitespace().count(), r.end())
        };
        // The row ends the call: a bracket form closes after it.
        let ends = if m.name("op3").is_some() {
            code[end..].trim_start().starts_with(']')
        } else {
            operand_ends(code, comments, end)
        };
        if !ends {
            continue;
        }
        let Some(Held::Table(columns, _)) = visible(table.as_str(), table.start()) else {
            continue;
        };
        let message = if rows.is_empty() {
            (values > 1 && values != columns.len()).then(|| format!("{values} values"))
        } else {
            rows.iter()
                .find(|&&n| n != columns.len())
                .map(|n| format!("A row of {n} values"))
        };
        if let Some(message) = message {
            out.push(Finding::at(
                path,
                raw,
                // The backtick, the table, or the bracket form's keyword.
                match (m.name("a"), m.name("op3")) {
                    (Some(t), _) => t.start() - 1,
                    (_, Some(o)) => o.start(),
                    _ => table.start(),
                },
                "QT027",
                format!(
                    "{message} for the {} columns of `{}`: '{op}' raises 'length",
                    columns.len(),
                    table.as_str(),
                ),
            ));
        }
    }
    out
}

/// A qSQL phrase's span, and the span of the table named after its `from`.
type Phrase = (usize, usize, Option<(usize, usize)>);

/// The spans of `code` where a qSQL statement reads its table's columns:
/// from `select`, `exec`, `update` or `delete` to its `from`, and from its
/// `where` to the end of the statement. The table after `from` is an
/// ordinary expression, and is left out. q 5 `px:2.5; select p0:px 0 from t`
/// indexes the column `px`, not the atom. Each span carries where the name
/// after `from` spans, when the table is written as a plain name.
fn qsql_phrases(code: &str) -> Vec<Phrase> {
    let bytes = code.as_bytes();
    let keywords: Vec<regex::Match> = re!(r"\b(?:select|exec|update|delete)\b")
        .find_iter(code)
        .filter(|m| boundary(code, m.start()))
        .collect();
    // Each keyword's statement end and every `where` at its level, read from
    // the last keyword back. A scan past its `from` that meets a later
    // keyword at its own level ends where that one's does and finds the same
    // `where`s, so it takes them rather than scanning on: `select from select
    // from ... t` was quadratic (#709).
    let mut read: HashMap<usize, (usize, Vec<usize>)> = HashMap::new();
    let mut phrases: Vec<Vec<Phrase>> = vec![];
    for m in keywords.iter().rev() {
        let (mut i, mut depth, mut from) = (m.end(), 0i32, None);
        let mut wheres = vec![];
        let mut own: Vec<Phrase> = vec![];
        while i < bytes.len() {
            if depth == 0
                && from.is_some()
                && let Some((end, later)) = read.get(&i)
            {
                for &w in later {
                    wheres.push(w);
                    let table = own.last().and_then(|p| p.2);
                    own.push((w, usize::MAX, table));
                    from = Some(w);
                }
                i = *end;
                break;
            }
            match bytes[i] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1
                }
                b';' if depth == 0 => break,
                b'\n' if depth == 0 && !code[i + 1..].starts_with([' ', '\t', '\r', '\n']) => break,
                b'f' | b'w' if depth == 0 && boundary(code, i) => {
                    let rest = &code[i..];
                    let word = |w: &str| {
                        rest.starts_with(w)
                            && !rest[w.len()..]
                                .starts_with(|c: char| c.is_alphanumeric() || c == '_')
                    };
                    if word("where") {
                        wheres.push(i);
                    }
                    if from.is_none() && word("from") {
                        let table = crate::past_blanks(code, i + 4);
                        let table = re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*")
                            .find(&code[table..])
                            .filter(|t| {
                                let rest = code[table + t.end()..].trim_start_matches([' ', '\t']);
                                rest.is_empty()
                                    || rest.starts_with([';', ')', ']', '}', '\n', '\r'])
                                    || rest.starts_with("where")
                            })
                            .map(|t| (table, table + t.end()));
                        own.push((m.start(), i, table));
                        from = Some(i);
                    } else if from.is_some() && word("where") {
                        from = Some(i);
                        let table = own.last().and_then(|p| p.2);
                        own.push((i, usize::MAX, table));
                    }
                }
                _ => {}
            }
            i += 1;
        }
        match (from, own.last_mut()) {
            // No `from`: not a statement this can read, so all of it.
            (None, _) => own.push((m.start(), i, None)),
            (Some(_), Some(last)) if last.1 == usize::MAX => last.1 = i,
            _ => {}
        }
        read.insert(m.start(), (i, wheres));
        phrases.push(own);
    }
    phrases.into_iter().rev().flatten().collect()
}

/// Where a where phrase compares a char column of a table literal with a
/// string exactly as long: the offset of each such operator. q 5 compares
/// row by row and runs it - `t:([]c:"ab";v:1 2); select from t where c="ab"`
/// keeps both rows (#754). Only a table this file assigns once, at column 0,
/// with no `\d` in the file and no symbol naming it: `` `t upsert ``, `` `t
/// insert `` and the rest change its rows.
pub(crate) fn char_column_comparisons(code: &str, comments: &str) -> Vec<usize> {
    let mut out = vec![];
    if re!(r#"(?m)^\\d\b|system\s*"d\b"#).is_match(comments) {
        return out;
    }
    // A table's char columns, with the patterns that compare each, depend
    // only on its name: worked out once per name, not once per where phrase,
    // which rescanned the file for each and was quadratic in them (#1206).
    let mut known: HashMap<&str, Vec<(regex::Regex, usize, usize, usize)>> = HashMap::new();
    for (start, end, table) in qsql_phrases(code) {
        let Some((t, e)) = table else {
            continue;
        };
        if !code[start..].starts_with("where") {
            continue;
        }
        let name = &code[t..e];
        let patterns = known
            .entry(name)
            .or_insert_with(|| char_column_patterns(code, comments, name));
        let end = end.min(code.len());
        for (pattern, op, chars, n) in patterns.iter() {
            for m in pattern.captures_iter(&comments[start..end]) {
                let (op, chars) = (m.get(*op).unwrap(), m.get(*chars).unwrap());
                if crate::q_bytes(chars.as_str()).len() == *n {
                    out.push(start + op.start());
                }
            }
        }
    }
    out
}

/// For `char_column_comparisons`: the patterns that compare a char column of
/// the table `name` with a string, each with the group of its operator, the
/// group of its string and the column's width. Empty where the file does not
/// assign `name` a table literal exactly once, or nothing of it compares.
fn char_column_patterns(
    code: &str,
    comments: &str,
    name: &str,
) -> Vec<(regex::Regex, usize, usize, usize)> {
    let mut out = vec![];
    let whole = |m: &regex::Match| {
        !code[..m.start()].ends_with(|c: char| c.is_alphanumeric() || "_.".contains(c))
            && !code[m.end()..].starts_with(|c: char| c.is_alphanumeric() || "_.".contains(c))
    };
    let uses: Vec<regex::Match> = regex::Regex::new(&regex::escape(name))
        .unwrap()
        .find_iter(code)
        .filter(whole)
        .collect();
    let writes: Vec<&regex::Match> = uses
        .iter()
        .filter(|m| {
            code[..m.start()].ends_with('`')
                || re!(r"^\s*(?:[,\[]|:(?:[^:]|$))").is_match(&code[m.end()..])
        })
        .collect();
    let [only] = writes[..] else {
        return out;
    };
    if only.start() != 0 && !code[..only.start()].ends_with('\n') {
        return out;
    }
    let value = crate::past_blanks(code, only.end() + 1);
    let Some(inner) = re!(r"^\(\s*\[\s*\]").find(&code[value..]) else {
        return out;
    };
    let Some(close) = matching(code, value, b'(', b')') else {
        return out;
    };
    let body = value + inner.end();
    let mut at = body;
    for part in crate::slots(&code[body..close - 1]) {
        if let Some(colon) = part.find(':') {
            let column = part[..colon].trim();
            let text = comments[at + colon + 1..at + part.len()].trim();
            if let Some(chars) = re!(r#"^"((?:\\[0-7]{3}|\\.|[^"\\])*)"$"#).captures(text) {
                let n = crate::q_bytes(&chars[1]).len();
                let column = regex::escape(column);
                let string = r#""((?:\\[0-7]{3}|\\.|[^"\\])*)""#;
                for (pattern, op, chars) in [
                    (format!(r"\b{column}[ \t]*(=|<>)[ \t]*{string}"), 1, 2),
                    (format!(r"{string}[ \t]*(=|<>)[ \t]*{column}\b"), 2, 1),
                ] {
                    out.push((regex::Regex::new(&pattern).unwrap(), op, chars, n));
                }
            }
        }
        at += part.len() + 1;
    }
    out
}

/// What an operand is, for the char-arithmetic rule. `Float` stands for
/// anything a char may meet under `+`, `-` and `*` on q 5.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Arithmetic {
    Char,
    Integral,
    Float,
}

/// The arithmetic kind of a literal's source text, or None for anything that
/// is not plainly one.
fn arithmetic_kind(text: &str) -> Option<Arithmetic> {
    let text = text.trim();
    if re!(r#"^"(?:\\.|[^"\\])*"$"#).is_match(text) {
        Some(Arithmetic::Char)
    } else if re!(r"^(?:-?\d+[hij]?(?:\s+-?\d+[hij]?)*|-?0[NW][hij]?|[01]+b|0x[0-9a-fA-F]+)$").is_match(text) {
        // A long null or infinity is a long: q 5 `"a"+0N` and `"a"*0W` are
        // 'type, where `"a"+0n` is 0n (#609).
        Some(Arithmetic::Integral)
    } else if re!(r"^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s+)*-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?e$").is_match(text) {
        // A real refuses a char as an integer does, under all three: q 5
        // `"a"+1e`, `1e*"a"` and `"a"-1.5e` are 'type, `1e -"a"` is -96e (#474),
        // and so are a vector and an exponent: `"a"*1 2e`, `"a"+1e3e` (#587).
        Some(Arithmetic::Integral)
    } else if re!(r"^-?(?:\d+\.\d*|\.\d+|\d+[ef]|\d+(?:\.\d*)?e[+-]?\d+)(?:\s+-?(?:\d+\.?\d*(?:e[+-]?\d+)?[ef]?))*$|^\d{4}\.\d{2}")
        .is_match(text)
    {
        Some(Arithmetic::Float)
    } else {
        None
    }
}

/// Names a body reads through a parse tree. In a functional query a symbol
/// is a name: `?[t;();0b;(enlist`x)!enlist (+;`a;`u)]` reads the local `u`,
/// and q confirms the local wins over a global of the same name. So where a
/// body builds one, each plain symbol in it may be a read, and the
/// unused-name rules must not call it unread. A tree given to `eval` is not
/// one: it resolves its symbols as globals, even for a query - q 5's
/// `{[a] n:5; eval (+;`n;a)}` is 'n with no global `n`, and with `n:100`
/// gives 101, never reading the local (#370).
fn parse_tree_names(body: &str) -> HashSet<&str> {
    if !re!(r"[?!]\s*\[").is_match(body) {
        return HashSet::new();
    }
    re!(r"`([A-Za-z][A-Za-z0-9_]*)")
        .captures_iter(body)
        .filter(|m| !body[m.get(0).unwrap().end()..].starts_with(['.', ':']))
        .map(|m| m.get(1).unwrap().as_str())
        .collect()
}

/// Whether the value assigned at `at` is a lambda, rather than what applying
/// one returns. `f:{...}` defines a function; `t:{x!...} (),y` - TorQ's
/// chainedtp.q - applies one on the spot and assigns the result, a
/// dictionary there, and calling that a function made `t k` a "call".
fn assigns_lambda(code: &str, raw: &str, at: usize) -> bool {
    assigned_rank(code, raw, at).is_some()
}

/// How many arguments the lambda assigned at `at` still takes, or `None`
/// when the value is not a function. A projection takes what its open slots
/// and missing trailing arguments leave: `{[a;b;c] ...}[;1]` takes two.
fn assigned_rank(code: &str, raw: &str, at: usize) -> Option<usize> {
    let rest = code[at..].trim_start();
    let brace = code.len() - rest.len();
    let ends = |from: usize| {
        let after = code[from..].trim_start_matches([' ', '\t']);
        after.is_empty() || after.starts_with([';', '\n', '\r', ')', ']', '}'])
    };
    if !rest.starts_with('{') {
        return None;
    }
    let end = matching(code, brace, b'{', b'}')?;
    let rank = || crate::lambda_rank(code, raw, brace, end - 1);
    if ends(end) {
        return Some(rank());
    }
    // A projection is still a function: qbists's klondike writes
    // `turn:{[g;n] ...}[;TURN]`, one argument fixed and one slot
    // left open, and `turn g` is a call. So is one given fewer
    // arguments than it takes: q 5's `{[a;b] a+b}[1]` is 104h (#551).
    if code[end..].starts_with('[') {
        let close = matching(code, end, b'[', b']')?;
        let slots = crate::slots(&code[end + 1..close - 1]);
        let open = slots.iter().filter(|slot| slot.trim().is_empty()).count();
        let missing = rank().saturating_sub(slots.len());
        return (open + missing > 0 && ends(close)).then_some(open + missing);
    }
    // And juxtaposition gives exactly one argument, everything to its
    // right: `{x+y} 1` and `{x+y} 1+2` are 104h in q 5. Only after a
    // literal, since a name there may be an infix keyword - `{x+y}
    // each l` applies `each`, not the lambda.
    let rank = rank();
    (code[end..].starts_with([' ', '\t'])
        && code[end..]
            .trim_start_matches([' ', '\t'])
            .starts_with(|c: char| c.is_ascii_digit() || "\"`(".contains(c))
        && rank >= 2)
        .then(|| rank - 1)
}
