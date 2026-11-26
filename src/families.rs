//! Rule families taken from `docs/ruff-applicability.md`: hazards other
//! linters check for, translated to q and kept only where they survived a
//! run over a corpus of public q. Every rule here is `style` - q runs all of
//! it - so each has to earn its place by being right, not by being an error.
use crate::{Finding, argument_end, argument_start, boundary, matching, slots};

pub fn check(
    path: &str,
    source: &str,
    code: &str,
    comments: &str,
    foreign: &[usize],
) -> Vec<Finding> {
    let mut out = vec![];
    query_injection(path, source, code, comments, &mut out);
    credentials(path, source, code, comments, &mut out);
    simplifications(path, source, code, comments, &mut out);
    leftovers(path, source, comments, foreign, &mut out);
    duplicate_columns(path, source, code, &mut out);
    select_by_duplicate(path, source, code, &mut out);
    unreachable(path, source, code, comments, &mut out);
    discarded_query(path, source, code, &mut out);
    empty_match(path, source, code, comments, &mut out);
    null_getenv(path, source, code, &mut out);
    performance(path, source, code, comments, &mut out);
    out
}

/// The argument of `name` at `after` - bracketed or juxtaposed - as an offset
/// range into the source, or None when there is none to read.
fn argument(code: &str, comments: &str, source: &str, after: usize) -> Option<(usize, usize)> {
    let rest = &code[after..];
    let open = after + (rest.len() - rest.trim_start_matches([' ', '\t']).len());
    if code[open..].starts_with('[') {
        let close = matching(code, open, b'[', b']')?;
        return Some((open + 1, close - 1));
    }
    let start = argument_start(source, comments, after)?;
    Some((start, argument_end(code, comments, source, start)?))
}

/// QX001. `value "select from t where sym=`",s` is how q gets injected: q has
/// no parameterised query, so a query is built by joining strings and run by
/// `value`, and whatever the joined value says is run with it. Verified: a
/// function doing exactly that, given `"a;secret:42;0"`, defines `secret` in
/// the process. A functional select takes the same value as data.
///
/// Only a query that is visibly built: the argument joins (`,` at its top
/// level) a string that names a qSQL statement with something that is not a
/// string literal. `value "select from t"` is a constant, and `value x` says
/// nothing about where `x` came from.
fn query_injection(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    // `get` of a string evaluates it as `value` does (q 5), and a string sent
    // over a handle - `h "select ...",x` - is evaluated by the remote
    // process's `.z.pg`, which is `value` by default. A name applied to a
    // query string is taken for a handle unless it is one of q's own, or a
    // lambda this file defines, with `:` or `::`: `lg "update finished"` logs
    // a line (#345, #654).
    let lambda = |name: &str| {
        regex::Regex::new(&format!(
            r"(?:^|[^A-Za-z0-9_.`]){}[ \t]*::?[ \t]*\{{",
            regex::escape(name)
        ))
        .is_ok_and(|r| r.is_match(code))
    };
    // The handle may be a dotted name, `.conn.h` or the caller's `.z.w`, or
    // the async `neg[h]` and `(neg h)` (#652).
    let handles: Vec<(usize, usize)> = re!(
        r#"(?:(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]+|(neg[ \t]*\[[^\[\]"]*\]|\(neg[ \t]+[^()"]*\))[ \t]*)"(?:select|exec|update|delete)\b"#
    )
    .captures_iter(comments)
    .filter_map(|c| {
        let handle = c.get(1).or(c.get(2)).unwrap();
        let name = c.get(1).is_some();
        (code[handle.start()..].starts_with(handle.as_str())
            && !(name
                && (crate::reserved_word(handle.as_str())
                    || lambda(handle.as_str()))))
        .then_some((handle.start(), handle.end()))
    })
    .collect();
    let calls = re!(r"\b(?:value|eval|get)\b")
        .find_iter(code)
        .map(|m| (m.start(), m.end()))
        .chain(handles);
    for (m_start, m_end) in calls {
        let m = Span {
            start: m_start,
            end: m_end,
        };
        // A system command line keeps its strings in every view, so its
        // commas would read as joins: `\t do[10;db "select a,b from t"]`.
        let line = code[..m.start()].rfind('\n').map_or(0, |p| p + 1);
        if !boundary(code, m.start()) || code[line..].starts_with('\\') {
            continue;
        }
        let Some((mut start, mut end)) = argument(code, comments, source, m.end()) else {
            continue;
        };
        // Parentheses around the whole argument only group it: `value
        // ("select ...",x)` runs the same query (#502).
        loop {
            let s = start + (code[start..end].len() - code[start..end].trim_start().len());
            let e = start + code[start..end].trim_end().len();
            if code.as_bytes().get(s) != Some(&b'(') || matching(code, s, b'(', b')') != Some(e) {
                break;
            }
            (start, end) = (s + 1, e - 1);
        }
        let (text, masked) = (&comments[start..end], &code[start..end]);
        // Joined at the top level of the argument, with a name in the join:
        // the masked view has the strings blanked, so any name left in it is
        // a value flowing into the query.
        let mut depth = 0i32;
        let joined = masked.bytes().any(|b| {
            match b {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                _ => {}
            }
            b == b',' && depth == 0
        });
        // A name outside any `$[...]`, or in one of its branches: a
        // conditional that only chooses between string constants - KX's tick
        // clog.q builds handler source that way - splices in no data,
        // whatever its condition reads, but `$[x;y;"a"]` splices `y` (#653).
        let mut unconditional = masked.as_bytes().to_vec();
        let mut chosen = false;
        for (at, _) in masked.match_indices("$[") {
            if let Some(close) = matching(masked, at + 1, b'[', b']') {
                unconditional[at..close].fill(b' ');
                let parts = slots(&masked[at + 2..close - 1]);
                let last = parts.len() - 1;
                chosen |= parts.iter().enumerate().any(|(i, part)| {
                    (i % 2 == 1 || i == last && last > 0)
                        && part.bytes().any(|b| b.is_ascii_alphabetic())
                });
            }
        }
        let spliced = chosen || unconditional.iter().any(u8::is_ascii_alphabetic);
        // The query text itself has to be one of the joined pieces, not a
        // branch of a conditional: there it is one of several constants.
        let mut top = text.as_bytes().to_vec();
        for (at, _) in masked.match_indices("$[") {
            if let Some(close) = matching(masked, at + 1, b'[', b']') {
                top[at..close].fill(b' ');
            }
        }
        let top = String::from_utf8_lossy(&top);
        let query = re!(r#""[^"]*\b(?:select|exec|update|delete)\b[^"]*""#).is_match(&top);
        if query && joined && spliced {
            out.push(Finding::at(
                path,
                source,
                m.start(),
                "QX001",
                format!(
                    "This query is built by joining strings and run by `{}`, so a value \
                     spliced into it can rewrite it; a functional select (`?[t;c;b;a]`) takes \
                     the value as data",
                    match &code[m.start()..m.end()] {
                        f @ ("value" | "eval" | "get") => f.to_string(),
                        h if re!(r"^\(?neg\b").is_match(h) => {
                            format!("{h}` over a handle and evaluated by the remote `.z.ps")
                        }
                        h => format!("{h}` over a handle and evaluated by the remote `.z.pg"),
                    }
                ),
            ));
        }
    }
}

/// QX002. A password, secret or token written into source as a string
/// literal. The name has to say it holds one, and the value has to be a
/// non-empty literal: `passwordPrompt:"Enter password"` names a message, and
/// `password:getenv`PASS` reads one from where it belongs.
fn credentials(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    let options = crate::options::current();
    let secret = options.name_pattern.as_ref().unwrap_or(re!(
        r"(?i)(?:password|passwd|pwd|secret|token|(?:api|secret|access|private|client)_?key|credentials?)$"
    ));
    // What a name says after its credential word makes it a message or a
    // place, `passwordPrompt`, `tokenUrl` - as a whole word of the name, and
    // only after: `profileToken` holds no `file`, and `envPassword` is a
    // password (#2736).
    let message = re!(
        r"(?i)^(?:prompt|msg|message|label|text|field|name|hint|file|filename|path|url|env|var|col)s?$"
    );
    let described = |rest: &str| {
        let b = rest.as_bytes();
        let mut from = 0;
        for i in 1..=b.len() {
            if i == b.len()
                || b[i] == b'_'
                || b[i].is_ascii_uppercase() && !b[i - 1].is_ascii_uppercase()
            {
                if message.is_match(rest[from..i].trim_matches('_')) {
                    return true;
                }
                from = i;
            }
        }
        false
    };
    for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*::?\s*\x22").captures_iter(comments) {
        let name = m.get(1).unwrap();
        // The assignment has to be code - the quote is blank there - and the
        // name the whole of one.
        if code.get(name.range()) != Some(name.as_str()) || !boundary(code, name.start()) {
            continue;
        }
        let last = name.as_str().rsplit('.').next().unwrap_or("");
        let Some(word) = secret.find_iter(last).last() else {
            continue;
        };
        if described(&last[word.end()..]) {
            continue;
        }
        // A column, not a variable: `update password:"***" from users`
        // redacts one, and `([]token:"ab")` names one (#204).
        if crate::in_qsql_phrase(code, name.start()) || in_table_literal(code, name.start()) {
            continue;
        }
        let quote = m.get(0).unwrap().end() - 1;
        let value = re!(r#"^"((?:\\.|[^"\\])*)""#).captures(&comments[quote..]);
        // The literal has to be the whole value: in `token:"," vs x` and
        // `token:"Bearer ",x` it is a delimiter and a prefix, and the token
        // is computed.
        let whole = value.as_ref().is_some_and(|c| {
            crate::operand_ends(comments, comments, quote + c.get(0).unwrap().end())
        });
        let value = value.map(|c| c.get(1).unwrap().as_str());
        // A secret has letters or digits in it, and is no q word: a lexer's
        // `sepToken:","` and `token:"if"` are syntax (#655).
        let opaque =
            |v: &str| v.bytes().any(|b| b.is_ascii_alphanumeric()) && !crate::reserved_word(v);
        if whole && value.is_some_and(opaque) {
            out.push(Finding::at(
                path,
                source,
                name.start(),
                "QX002",
                format!(
                    "`{}` is assigned a string literal: a credential in source is in every \
                     copy of it; read it from the environment or a file at startup",
                    name.as_str()
                ),
            ));
        }
    }
    // A handle that carries its password, `` `:host:5010:user:password `` -
    // a symbol, or the same text as a string, which `hopen` takes too and a
    // host with a `-` in it needs (q 5: `` `:prod-db:5010:svc:pw `` is no
    // symbol, and `hopen ":localhost:5010:u:p"` dials as the symbol does):
    // after the port, a user and a password that is not empty (#2738).
    let symbols =
        re!(r"`:(?:(?:tcps?://)?[A-Za-z0-9._]*:|unix://)[0-9]+:[A-Za-z0-9._/]+:[A-Za-z0-9._/:]+")
            .find_iter(code)
            .map(|m| m.start());
    let strings = re!(r#"":(?:(?:tcps?://)?[A-Za-z0-9._-]*:|unix://)[0-9]+:[^\s:"]+:[^\s"]+""#)
        .find_iter(comments)
        // The whole of one string: its text is blank in the code view.
        .filter(|m| code[m.start() + 1..m.end() - 1].trim().is_empty())
        .map(|m| m.start());
    let mut handles: Vec<usize> = symbols.chain(strings).collect();
    handles.sort_unstable();
    for at in handles {
        out.push(Finding::at(
            path,
            source,
            at,
            "QX002",
            "This handle carries its password: a credential in source is in every copy of \
             it; read it from the environment or a file at startup"
                .to_string(),
        ));
    }
    // `.z.pw` checking the password it is given against a string literal,
    // `.z.pw:{[u;p] p~"hunter2"}`: its second argument, by the name the
    // lambda gives it, on either side of `~`, `=` or `like` (#2738).
    for m in re!(r"\.z\.pw[ \t]*::?[ \t]*\{").find_iter(code) {
        if !boundary(code, m.start()) {
            continue;
        }
        let brace = m.end() - 1;
        let sig = crate::signature(code, source, brace);
        let given = match sig.slots.get(1) {
            Some(slot) if sig.named => slot.trim(),
            _ if sig.named => continue,
            _ => "y",
        };
        if !crate::is_param_name(given) {
            continue;
        }
        let end = matching(code, brace, b'{', b'}').unwrap_or(code.len());
        let is_given = |text: &str, at: usize| {
            text[at..].starts_with(given)
                && boundary(text, at)
                && !text[at + given.len()..]
                    .starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '.')
        };
        for lit in re!(r#""((?:\\.|[^"\\])*)""#).captures_iter(&comments[sig.body..end]) {
            let (start, stop) = (
                sig.body + lit.get(0).unwrap().start(),
                sig.body + lit.get(0).unwrap().end(),
            );
            let value = lit.get(1).unwrap().as_str();
            if !value.bytes().any(|b| b.is_ascii_alphanumeric()) {
                continue;
            }
            let before = code[sig.body..start].trim_end();
            let left = ["~", "=", "like"]
                .iter()
                .find_map(|op| before.strip_suffix(op))
                .map(str::trim_end)
                .is_some_and(|b| b.len() >= given.len() && is_given(b, b.len() - given.len()));
            let after = code[stop..end].trim_start();
            let right = after
                .strip_prefix(['~', '='])
                .map(str::trim_start)
                .is_some_and(|a| is_given(a, 0));
            if left || right {
                out.push(Finding::at(
                    path,
                    source,
                    start,
                    "QX002",
                    "`.z.pw` checks the password against a string literal: a credential in \
                     source is in every copy of it; read it from the environment or a file at \
                     startup"
                        .to_string(),
                ));
            }
        }
    }
}

/// Whether the keyword that ends at `at` is the operand of an iterator -
/// `asc each x`, `asc'[x]`, `distinct peach x`, `asc@'x`, `asc .'x` - and so
/// applied item by item rather than to the list: `reverse asc each x`
/// reverses the items, and `distinct each x` can make two items equal that
/// the outer `distinct` then removes. `@'` and `.'` are each over apply
/// (#402): q 5 gives `(3 1 2;5 4)` for `distinct asc distinct@'x` and three
/// items for `asc distinct@'x`.
/// The iterator may start the indented line that continues the statement:
/// `reverse asc` over `  .'p` is `reverse asc .'p` (#685). The keyword
/// iterators all count: `asc scan x` is the list of `asc`'s iterations to
/// convergence, so `reverse asc scan 3 1 2` is `` (`s#1 2 3;3 1 2) `` where
/// `desc scan 3 1 2` is `(3 1 2;3 2 1)` (q 5, #2255), and `asc prior x`
/// sorts pairs.
fn iterated(code: &str, at: usize) -> bool {
    let rest = &code[at..];
    rest.starts_with(['\'', '/', '\\'])
        || re!(concat!(
            "^",
            blank!(),
            r"*(?:each|peach|scan|over|prior)\b|^",
            blank!(),
            r"*[@.]['/\\]"
        ))
        .is_match(rest)
}

/// Whether the word that ends at `at` is applied to the rest of its
/// statement, so a rewrite of the word keeps its operand: something follows
/// it, and an application in brackets is not continued by an infix - q 5
/// reads `asc[3 1 2],0` as `(asc[3 1 2]),0`, and a bare `asc` as the
/// function itself (#648, #649, #650).
fn applied_to_rest(source: &str, code: &str, comments: &str, at: usize) -> bool {
    // A string is blank in `code`, and an operand all the same.
    if source[crate::past_blanks(source, at)..].starts_with('"') {
        return true;
    }
    let next = crate::past_blanks(code, at);
    if crate::operand_ends(code, comments, at) || code[next..].starts_with("::") {
        return false;
    }
    !code[next..].starts_with('[')
        || matching(code, next, b'[', b']')
            .is_some_and(|end| crate::operand_ends(code, comments, end))
}

/// Whether `at` names a column of a table literal: the bracket around it,
/// past any `;` between columns, is the `(` of `([...] ...)` or the `[` of
/// its key columns.
fn in_table_literal(code: &str, at: usize) -> bool {
    let b = code.as_bytes();
    let mut depth = 0i32;
    let mut i = at;
    while i > 0 {
        i -= 1;
        match b[i] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b'(' => return code[i + 1..].trim_start().starts_with('['),
            b'[' => return code[..i].trim_end().ends_with('('),
            b'{' => return false,
            _ => {}
        }
    }
    false
}

/// #10: doing by hand what a q primitive does. Only rewrites q confirmed give
/// the same result on every input tried - nulls, symbols, strings, a
/// dictionary, a table, an atom, the empty list. Others the survey proposed
/// were dropped because they do not: `first asc x` is not `min x` once there
/// is a null (asc puts it first, min skips it), and `{x+y}/` is not `sum`,
/// which skips nulls too.
fn simplifications(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    let mut add = |at: usize, code_: &str, detail: String| {
        out.push(Finding::at(path, source, at, code_, detail));
    };
    // QR001: `reverse asc x` is `desc x`, and `reverse desc x` is `asc x` -
    // for a list or a table. Both sorts are stable, so a dictionary or keyed
    // table with tied values gets their keys the other way round: q 5 gives
    // 0b for `(reverse asc d)~desc d` with d:`a`b`c!1 1 2, and the message
    // says so (#2739).
    for m in re!(concat!(r"\breverse", blank!(), r"+(asc|desc)\b")).captures_iter(code) {
        let whole = m.get(0).unwrap();
        if boundary(code, whole.start())
            && !iterated(code, whole.end())
            && applied_to_rest(source, code, comments, whole.end())
        {
            let other = if &m[1] == "asc" { "desc" } else { "asc" };
            add(
                whole.start(),
                "QR001",
                format!(
                    "`reverse {}` is `{other}`, in one pass; on a dictionary or keyed table \
                     the two differ in the order of keys whose values tie",
                    &m[1]
                ),
            );
        }
    }
    // QR002: an identity lambda under each gives back what it was given.
    // The `each` has to be in the same statement: `id:{x}` and then a
    // column-0 `'[neg;abs]` is no each at all (#727).
    for m in re!(concat!(
        r"\{\s*x\s*\}",
        blank!(),
        r"*(?:each\b|'(?:[^:]|$))"
    ))
    .find_iter(code)
    {
        // And applied: `({x}';1)` holds the derived function itself, a
        // general list on KDB-X, not any argument (#1299).
        let mut end = m.end();
        if !m.as_str().ends_with("each") && !m.as_str().ends_with('\'') {
            end -= code[..end].chars().next_back().map_or(0, char::len_utf8);
        }
        if crate::operand_ends(code, comments, end) || code[end..].trim_start().starts_with("::") {
            continue;
        }
        add(
            m.start(),
            "QR002",
            "`{x} each` returns its argument unchanged".into(),
        );
    }
    // QR003: sorting the distinct items keeps them distinct.
    for m in re!(concat!(
        r"\bdistinct",
        blank!(),
        "+asc",
        blank!(),
        r"+distinct\b"
    ))
    .find_iter(code)
    {
        if boundary(code, m.start())
            && !iterated(code, m.end())
            && applied_to_rest(source, code, comments, m.end())
        {
            add(
                m.start(),
                "QR003",
                "`distinct asc distinct x` is `asc distinct x`: sorting adds no duplicates".into(),
            );
        }
    }
    // QR004: arithmetic is atomic, so a lambda that does one operation with a
    // number needs no each - `{x+1} each x` is `1+x`, run on the whole list
    // at once. Only the visibly atomic shape: one of + - * % between x and a
    // numeric literal. `{x -1}` is not one: a `-` after a space and before a
    // digit is a negative literal, so that is x indexed at -1, and q 5 gives
    // `0N 0N` for `{x -1} each (1 2;3 4)` where `(1 2;3 4)-1` is `(0 1;2 3)`.
    for m in re!(concat!(
        r"\{\s*(?:x\s*[-+*%]\s*-?\d[A-Za-z0-9.]*|-?\d[A-Za-z0-9.]*\s*[-+*%]\s*x)\s*\}",
        blank!(),
        r"*(?:each\b|'(?:[^:]|$))"
    ))
    .find_iter(code)
    {
        if re!(r"^\{\s*x\s+-\d").is_match(m.as_str()) {
            continue;
        }
        add(
            m.start(),
            "QR004",
            "Arithmetic is atomic: this applies to the whole list without `each`, and \
             faster"
                .into(),
        );
    }
}

/// #11: things left in q that were never meant to ship. Both are taste rather
/// than defects, so both are `styleq` - off in the default.
///
/// A third was tried and dropped: `0N!` mid-expression inside a lambda. On
/// the corpus six of its seven findings were progress output written on
/// purpose - a downloader printing its URL, a loader printing its file.
fn leftovers(path: &str, source: &str, comments: &str, foreign: &[usize], out: &mut Vec<Finding>) {
    // A comment is blank in both masked views; a string is blank only in
    // `code`. So a byte blank in `comments` but not in the source is comment.
    // A `p)` line and its indented continuation are blank in both too, and
    // are another language's: a `#TODO` in embedded Python is not q's.
    let in_comment = |at: usize| {
        let line = source[..at].rfind('\n').map_or(0, |n| n + 1);
        comments.as_bytes()[at] == b' ' && source.as_bytes()[at] != b' ' && !foreign.contains(&line)
    };
    // QL001: a marker saying the work is unfinished.
    // The words are `[rules.QL001] markers`, TODO, FIXME, XXX and HACK by default.
    let options = crate::options::current();
    for m in options.markers.find_iter(source) {
        // `.kdb.XXX` or `` `XXX `` is a placeholder name, not a marker.
        let named = source[..m.start()].ends_with(['.', '`']);
        if in_comment(m.start()) && !named {
            out.push(Finding::at(
                path,
                source,
                m.start(),
                "QL001",
                format!("`{}` marks unfinished work", m.as_str()),
            ));
        }
    }
    // QL002: a whole comment line that is a lambda definition - code kept
    // as a comment rather than deleted, which version control already keeps.
    for m in
        re!(r"(?m)^[ \t]*/+[ \t]*(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]*:[ \t]*\{").captures_iter(source)
    {
        let name = m.get(1).unwrap();
        // A lambda that closes on the line with words after it - `f:{x[0]+1}
        // as a one-argument declaration.` - is a sentence quoting code, and
        // one whose body is an ellipsis, `{[] ...}`, a documented shape
        // (#517). Code after the brace is still code: `r: {x}each I`.
        let brace = m.get(0).unwrap().end() - 1;
        let line = &source[brace
            ..source[brace..]
                .find('\n')
                .map_or(source.len(), |n| brace + n)];
        let prose = matching(line, 0, b'{', b'}').is_some_and(|c| {
            line[..c].contains("...")
                || re!(r"^[A-Za-z][A-Za-z'-]*(?: [A-Za-z][A-Za-z'-]*){2}")
                    .is_match(line[c..].trim())
        });
        if in_comment(name.start()) && !prose {
            out.push(Finding::at(
                path,
                source,
                m.get(0).unwrap().start(),
                "QL002",
                format!(
                    "`{}` is a lambda definition kept as a comment",
                    name.as_str()
                ),
            ));
        }
    }
}

/// The column names in a table literal's keys or values: `name:`, or a name
/// standing alone - q 5 `([]a;a)` has columns a and a1 (#641).
fn literal_columns(list: &str) -> Vec<&str> {
    slots(list)
        .into_iter()
        .map(|part| part.split_once(':').map_or(part, |(name, _)| name).trim())
        .filter(|name| re!(r"^[A-Za-z][A-Za-z0-9_]*$").is_match(name))
        .collect()
}
/// The first name in `list` that an earlier one already gave. A set: a wide
/// literal compared each name with every one before it (#711).
fn named_twice<'a>(list: &[&'a str]) -> Option<&'a str> {
    let mut seen = std::collections::HashSet::new();
    list.iter().find(|name| !seen.insert(**name)).copied()
}

/// QB019. A table literal naming one column twice. q 5 does not refuse it: it
/// renames the second, so `([]a:1 2;a:3 4)` has columns `a` and `a1`, and
/// code reading `a` gets the first without a word.
fn duplicate_columns(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for open in code.match_indices("(").map(|(i, _)| i) {
        let rest = code[open + 1..].trim_start();
        if !rest.starts_with('[') {
            continue;
        }
        let Some(close) = matching(code, open, b'(', b')') else {
            continue;
        };
        let inner = &code[open + 1..close - 1];
        let bracket = inner.len() - inner.trim_start().len();
        let Some(key_close) = matching(inner, bracket, b'[', b']') else {
            continue;
        };
        // Nothing after the brackets is a dictionary, where a repeated key is
        // allowed and kept.
        if inner[key_close..].trim().is_empty() {
            continue;
        }
        let (keys, values) = (
            literal_columns(&inner[bracket + 1..key_close - 1]),
            literal_columns(&inner[key_close..]),
        );
        // Among the keys or among the values q renames the second; a key and
        // a value column of one name it keeps as they are, both named so:
        // q 5 `cols ([a:1 2]a:3 4)` is `a`a (#640).
        if let Some(name) = named_twice(&keys).or_else(|| named_twice(&values)) {
            out.push(Finding::at(
                path,
                source,
                open,
                "QB019",
                format!("Column `{name}` is named twice: q keeps both and renames the second, so `{name}` reads the first"),
            ));
        } else if let Some(name) = {
            let values: std::collections::HashSet<&str> = values.iter().copied().collect();
            keys.iter().find(|name| values.contains(*name))
        } {
            out.push(Finding::at(
                path,
                source,
                open,
                "QB019",
                format!("Column `{name}` is both a key and a value column: q keeps both under the one name, so `{name}` reads the key"),
            ));
        }
    }
    // The same in a select or update list, where q 5 renames as well:
    // `select a,a from t` has columns a and a1, and so do `select max a,min a`
    // and `select a,max a`, each item named as `column_name` says. A select's
    // by list is renamed the same way - `select a by b,b` groups by b and b1 -
    // where update's by names no column and is left alone. An exec's list
    // names the keys of the dictionary it returns, renamed alike: q 5
    // `key exec a,a from t` is `a`a1 (#2701).
    let mut strings = InString::new(code);
    for q in re!(r"\b(?:select|update|exec)\b").find_iter(code) {
        if !crate::boundary(code, q.start()) || strings.at(q.start()) {
            continue;
        }
        let rest = &code[q.end()..];
        let Some(stop) = top_level_word(rest, re!(r"\b(?:by|from)\b")) else {
            continue;
        };
        let mut lists = vec![&rest[..stop.start()]];
        if stop.as_str() == "by"
            && q.as_str() == "select"
            && let Some(from) = top_level_word(&rest[stop.end()..], re!(r"\bfrom\b"))
        {
            lists.push(&rest[stop.end()..stop.end() + from.start()]);
        }
        for list in lists {
            // A newline, a `;` outside brackets or the end of a lambda ends
            // the statement before the list does.
            if list.contains('\n') || !braces_close(list) || items_at_depth_zero(list, b';') {
                continue;
            }
            let mut seen = std::collections::HashSet::new();
            for name in items(list).into_iter().filter_map(column_name) {
                if !seen.insert(name) {
                    out.push(Finding::at(
                        path,
                        source,
                        q.start(),
                        "QB019",
                        format!("Column `{name}` is named twice: q keeps both and renames the second, so `{name}` reads the first"),
                    ));
                    break;
                }
            }
        }
    }
}

/// The first match of `word` in `text` at its own bracket depth - not one
/// inside a parenthesised subquery, `(exec b by a from u)`, whose by and
/// from are that query's (#203) - and before any bracket closes around
/// `text`'s start, which ends the phrase.
fn top_level_word<'t>(text: &'t str, word: &regex::Regex) -> Option<regex::Match<'t>> {
    let b = text.as_bytes();
    let (mut depth, mut i) = (0i32, 0);
    for m in word.find_iter(text) {
        while i < m.start() {
            match b[i] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                _ => {}
            }
            if depth < 0 {
                return None;
            }
            i += 1;
        }
        if depth == 0 {
            return Some(m);
        }
    }
    None
}

/// The items of a select or by list: split at commas outside brackets, so
/// `select f[a,b],c` and `by xbar[2;a]` keep theirs whole.
fn items(list: &str) -> Vec<&str> {
    let mut items = vec![];
    let (mut depth, mut start) = (0i32, 0);
    for (i, b) in list.bytes().enumerate() {
        match b {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b',' if depth == 0 => {
                items.push(&list[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    items.push(&list[start..]);
    items
}

/// Whether a position sits inside a string on its line. The masked view blanks
/// most strings, but not on a `\t` line, where `\t f "select min(p) ..."`
/// carries SQL that is not q.
/// Asked for positions in increasing order, it reads on from where the last
/// question stopped rather than from the line's start: a long line of qSQL
/// keywords was quadratic (#709).
struct InString<'a> {
    code: &'a str,
    i: usize,
    inside: bool,
}

impl<'a> InString<'a> {
    fn new(code: &'a str) -> Self {
        InString {
            code,
            i: 0,
            inside: false,
        }
    }

    fn at(&mut self, at: usize) -> bool {
        if at < self.i {
            (self.i, self.inside) = (0, false);
        }
        let b = self.code.as_bytes();
        while self.i < at {
            match b[self.i] {
                b'\n' => self.inside = false,
                b'\\' if self.inside => self.i += 1,
                b'"' => self.inside = !self.inside,
                _ => {}
            }
            self.i += 1;
        }
        self.inside
    }
}

/// Whether every `{` in `text` closes inside it, and no `}` closes one
/// opened before it: `{x} a` does, `a}` and `{a` do not.
fn braces_close(text: &str) -> bool {
    let mut depth = 0i32;
    for b in text.bytes() {
        match b {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return false;
        }
    }
    depth == 0
}

/// Whether `byte` occurs in `text` outside every bracket.
fn items_at_depth_zero(text: &str, byte: u8) -> bool {
    let mut depth = 0i32;
    text.bytes().any(|b| {
        match b {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            _ => {}
        }
        b == byte && depth == 0
    })
}

/// The column name q 5 gives a select or by item: its `name:`, or else the
/// name q derives from the expression, or None where that is not known.
///
/// Measured in q 5 with `cols select E from t`, and followed only that far:
/// - a column names itself, and the virtual `i` and any literal are `x`;
/// - `l+r`, `l-r`, `l*r`, `l%r`, `l&r`, `l|r`, `and`, `or` take the name of
///   their left operand, so `a+b` is `a` and `2+a` is `x`;
/// - `= < > <> <= >= ^ # @ ? $ _ !` and `mod xbar div cross except wavg
///   within in xexp xlog bin rotate vs cut xprev union inter wsum` take the
///   right one: `a=b` is `b`, `a mod 2` is `x`, `` `int$a `` is `a`;
/// - `f each a` and `f peach a` take `a`'s;
/// - a function applied, `max a`, `f a`, `{x} a`, takes its argument's;
/// - `f[a;b]` and `(a;b)` take their last item's: `g[1;a]` is `a`.
///
/// Anything else - an adverb, an unmeasured operator, a qualified name -
/// is None, and the rules reading this stay silent rather than guess.
fn column_name(item: &str) -> Option<&str> {
    let item = item.trim();
    if let Some(m) = re!(r"^([A-Za-z][A-Za-z0-9_]*)\s*:[^:]").captures(item) {
        return Some(m.get(1).unwrap().as_str());
    }
    expression_name(&tokens(item)?)
}

/// One token of a select item, for `column_name`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Tok<'a> {
    Name(&'a str),
    Lit,
    Op(&'a str),
    /// The inside of `(...)`.
    Group(&'a str),
    /// The inside of `[...]`.
    Args(&'a str),
    Lambda,
}

/// Operators that name their result after the left operand, and those that
/// name it after the right: both lists are q 5's, measured, and nothing
/// outside them is named.
const LEFT_NAMED: &[&str] = &["+", "-", "*", "%", "&", "|", "and", "or"];
// `$ _ ! bin rotate vs cut xprev union inter wsum`, and a function applied
// with `each` or `peach`, measured on KDB-X (#1203).
const RIGHT_NAMED: &[&str] = &[
    "=", "<", ">", "<>", "<=", ">=", "^", "#", "@", "?", "mod", "xbar", "div", "cross", "except",
    "wavg", "within", "in", "xexp", "xlog", "$", "_", "!", "bin", "rotate", "vs", "cut", "xprev",
    "union", "inter", "wsum", "each", "peach",
];

fn tokens(s: &str) -> Option<Vec<Tok<'_>>> {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    let mut number_end = None;
    let digit = |at: usize| at < b.len() && b[at].is_ascii_digit();
    while i < b.len() {
        let c = b[i];
        let prev = s[..i].chars().next_back();
        let noun_before = prev.is_some_and(|p| p.is_alphanumeric() || ")]}\"_.`".contains(p));
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'"' {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
            i = (i + 1).min(b.len());
            out.push(Tok::Lit);
        } else if c == b'`' {
            while i < b.len() && b[i] == b'`' {
                i += 1;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b"_.:/".contains(&b[i])) {
                    i += 1;
                }
            }
            out.push(Tok::Lit);
        } else if digit(i)
            || (c == b'.' && digit(i + 1))
            || (c == b'-'
                && !noun_before
                && (digit(i + 1) || (b.get(i + 1) == Some(&b'.') && digit(i + 2))))
        {
            let start = i;
            i += 1;
            // No `_`: `1_a` is a drop, not one number (#1203).
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b".:".contains(&b[i])) {
                i += 1;
            }
            // `1 2` is one vector literal, not one number applied to another.
            if number_end != Some(s[..start].trim_end().len()) {
                out.push(Tok::Lit);
            }
            number_end = Some(i);
        } else if c.is_ascii_alphabetic()
            || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_alphabetic))
        {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b"_.".contains(&b[i])) {
                i += 1;
            }
            out.push(Tok::Name(&s[start..i]));
        } else if let Some((open, close)) = match c {
            b'(' => Some((b'(', b')')),
            b'[' => Some((b'[', b']')),
            b'{' => Some((b'{', b'}')),
            _ => None,
        } {
            let end = matching(s, i, open, close)?;
            let inner = &s[i + 1..end - 1];
            out.push(match c {
                b'(' => Tok::Group(inner),
                b'[' => Tok::Args(inner),
                _ => Tok::Lambda,
            });
            i = end;
        } else if b")]}".contains(&c) {
            return None;
        } else {
            let two = s.get(i..i + 2);
            // One character, not one byte: q refuses a non-ASCII one
            // ('char), but the next slice must not start inside it.
            let len = if matches!(two, Some("<>" | "<=" | ">=")) {
                2
            } else {
                s[i..].chars().next().map_or(1, char::len_utf8)
            };
            out.push(Tok::Op(&s[i..i + len]));
            i += len;
        }
    }
    Some(out)
}

fn reserved(name: &str) -> bool {
    crate::reserved_word(name)
}

/// The name of an expression read right to left, as `column_name` explains.
fn expression_name<'a>(toks: &[Tok<'a>]) -> Option<&'a str> {
    // A term: something followed by at most one bracket list.
    let (&first, rest) = toks.split_first()?;
    let (args, rest) = match rest.split_first() {
        Some((&Tok::Args(a), rest)) => (Some(a), rest),
        _ => (None, rest),
    };
    if matches!(rest.first(), Some(Tok::Args(_))) {
        return None;
    }
    let term = || -> Option<&'a str> {
        match (first, args) {
            (Tok::Lambda, Some(a)) => last_slot_name(a),
            (Tok::Name(n), Some(a)) if !n.contains('.') => last_slot_name(a),
            (_, Some(_)) => None,
            (Tok::Name(n), None) => match n {
                _ if n.contains('.') || reserved(n) => None,
                "i" => Some("x"),
                _ => Some(n),
            },
            (Tok::Lit, None) => Some("x"),
            (Tok::Group(g), None) => last_slot_name(g),
            _ => None,
        }
    };
    let Some(&next) = rest.first() else {
        return term();
    };
    let op = match next {
        Tok::Op(o) => Some(o),
        Tok::Name(n) if LEFT_NAMED.contains(&n) || RIGHT_NAMED.contains(&n) => Some(n),
        _ => None,
    };
    if let Some(op) = op {
        let right = &rest[1..];
        if right.is_empty() {
            return None;
        }
        // The right side must read too, or the left may not be an operand.
        let named = expression_name(right);
        return if LEFT_NAMED.contains(&op) {
            named.and(term())
        } else if RIGHT_NAMED.contains(&op) {
            named
        } else {
            None
        };
    }
    // Application: a function, builtin or not, or a lambda, given what
    // follows it. A literal or a bracketed call applied to more is not read,
    // nor a column before an unmeasured builtin, `a bin b`.
    match (first, args) {
        (Tok::Name(n), None) if !n.contains('.') => {
            if !reserved(n) && matches!(next, Tok::Name(m) if reserved(m)) {
                return None;
            }
            expression_name(rest)
        }
        (Tok::Lambda, None) => expression_name(rest),
        _ => None,
    }
}

/// The name of the last `;`-slot of a bracket or parenthesis: `g[1;a]` and
/// `(1;a)` are both `a`.
fn last_slot_name(inner: &str) -> Option<&str> {
    let last = slots(inner).pop()?;
    if last.trim().is_empty() {
        return None;
    }
    expression_name(&tokens(last)?)
}

/// QB021. A select naming a result column the same as one of its by groups.
/// q 5 refuses it with 'dup names for cols/groups: `select a by a from t`,
/// `select max a by a from t` and `select a:b by a from t` all fail, where
/// `select m:max a by a from t` runs. update with the same lists runs. exec
/// names its result only when the list has several items or an alias, and
/// its groups likewise: q 5 runs `exec a by a from t` and `exec c:a by c
/// from t`, and refuses `exec c:a by c:b from t` and `exec a,b by a,c from t`
/// (#354).
fn select_by_duplicate(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    // No `\b` before the keyword: `1_select` is a drop of a select (#351),
    // and `boundary` tells that from the name `x_select`.
    let mut strings = InString::new(code);
    for q in re!(r"(?:select|exec)\b").find_iter(code) {
        if !crate::boundary(code, q.start()) || strings.at(q.start()) {
            continue;
        }
        // A limit or sort is no column: `select[1] a by a from t` and
        // `select[2;>a] ...` name their columns after it (#573).
        let mut rest = &code[q.end()..];
        if q.as_str() == "select" && rest.starts_with('[') {
            let Some(close) = crate::matching(code, q.end(), b'[', b']') else {
                continue;
            };
            rest = &code[close..];
        }
        let Some(by) = top_level_word(rest, re!(r"\b(?:by|from)\b")) else {
            continue;
        };
        let Some(from) = top_level_word(&rest[by.end()..], re!(r"\bfrom\b")) else {
            continue;
        };
        if by.as_str() != "by" {
            continue;
        }
        let (list, groups) = (
            &rest[..by.start()],
            &rest[by.end()..by.end() + from.start()],
        );
        // A `;` outside brackets, a line starting at column 0, or the end of
        // a lambda ends the statement before these lists do; `xbar[2;a]` and
        // `{x} a` keep their own. An indented line continues it, and inside
        // a lambda a newline is whitespace (#333).
        let both = format!("{list}{groups}");
        if re!(r"\n\S").is_match(&both) || !braces_close(&both) || items_at_depth_zero(&both, b';')
        {
            continue;
        }
        let named = |list: &[&str]| {
            list.len() > 1 || re!(r"^\s*[A-Za-z][A-Za-z0-9_]*\s*:[^:]").is_match(list[0])
        };
        let exec = q.as_str() == "exec";
        if exec && !(named(&items(list)) && named(&items(groups))) {
            continue;
        }
        let groups: Vec<_> = items(groups).into_iter().filter_map(column_name).collect();
        if let Some(name) = items(list)
            .into_iter()
            .filter_map(column_name)
            .find(|n| groups.contains(n))
        {
            out.push(Finding::at(
                path,
                source,
                q.start(),
                "QB021",
                format!(
                    "`{name}` names both a result column and a by group: q 5 refuses the {} \
                     with 'dup names for cols/groups {name}; name the column, `m:max {name}`",
                    q.as_str()
                ),
            ));
        }
    }
}

/// QB020. A statement after a return or a signal at a lambda's top level can
/// never run: `{:1;2}` returns 1 and the 2 is dead. Only the top level - a
/// `:x` inside `if[...]` or `$[...]` is a branch, and what follows it runs.
fn unreachable(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    for (brace, _) in code.match_indices('{') {
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let sig = crate::signature(code, source, brace);
        let body_start = sig.body;
        let body = &code[body_start..end - 1];
        // From `slots`, which jumps over nested lambdas rather than reading
        // through them: a nest of lambdas was quadratic (#704).
        let statements: Vec<(usize, usize)> = crate::slots(body)
            .into_iter()
            .map(|s| {
                let a = s.as_ptr() as usize - body.as_ptr() as usize;
                (a, a + s.len())
            })
            .collect();
        // Emptiness read from `comments`, where a string is still there:
        // `{[a] :a; "x"}` has a statement after the return (#216).
        let kept = &comments[body_start..end - 1];
        // `'[f;g]` - or `' [f;g]` - is a composition, not a signal: q 5
        // `{'[neg;abs]; 2}[]` is 2. And `:[a;b]` is the assign verb, not a
        // return: `{a:0; :[a;5]; a}[]` is 5, and with a space 7 (#515). Nor
        // is a glyph with nothing to return or signal, alone or under an
        // iterator: q 5 `{[a] '; a+1} 1`, `{[a] :; a+1} 1` and
        // `{[a] '/; a+1} 1` are each 2 (#624).
        let exits = |(a, b): (usize, usize)| {
            let t = body[a..b].trim_start();
            if !t.starts_with([':', '\'']) {
                return false;
            }
            let operand = kept[b + 1 - t.len()..b].trim_start();
            !operand.is_empty()
                && !operand.starts_with(['/', '\\', '\'', '['])
                && ((t.starts_with(':') && !t.starts_with("::"))
                    || (t.starts_with('\'') && !t.starts_with("':")))
        };
        if let Some(i) = statements.iter().position(|&s| exits(s))
            && let Some(&(a, _)) = statements[i + 1..]
                .iter()
                .find(|&&(a, b)| !kept[a..b].trim().is_empty())
        {
            let at = body_start + a + (kept[a..].len() - kept[a..].trim_start().len());
            out.push(Finding::at(
                    path,
                    source,
                    at,
                    "QB020",
                    "This statement follows a return or signal at the lambda's top level, so it never runs".into(),
                ));
        }
    }
}

/// QB022. An update or delete on a table *value* returns the changed copy
/// and leaves the table alone: q 5 `{update a:a+1 from t;}[]` leaves `t` as
/// it was. Only `` from `t `` changes the table in place. A statement whose
/// value nothing takes - any but a lambda's last - has thrown the change away.
///
/// The operand has to be known to hold a table, because a name holding a
/// symbol amends in place too: q 5 `{[n] update a:a+10 from n;}[`t]`
/// changes `t`. So a parameter is never reported, a local only when each of
/// its assignments in the lambda is a table, and a global only when each of
/// its assignments in the file is - a table literal, a `flip`, a `select`,
/// or an `update` or `delete` from something other than a symbol - and
/// nothing `set`s it.
///
/// A control statement's body never yields a value, so an update there is
/// thrown away too, wherever the statement sits: q 5
/// `{[] if[1b; update a:0 from t]; t}[]` is `t` unchanged (#2686). So is a
/// script's own statement ended by `;`: `update a:0 from t;` (#2687).
fn discarded_query(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    if !re!(r"(?:update|delete)\b").is_match(code) {
        return;
    }
    let mut verdicts: Verdicts = std::collections::HashMap::new();
    for (brace, _) in code.match_indices('{') {
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let sig = crate::signature(code, source, brace);
        if sig.body > end - 1 {
            continue;
        }
        let params: Vec<&str> = if sig.named {
            sig.slots
                .iter()
                .flat_map(|p| crate::pattern_names(p))
                .collect()
        } else {
            vec!["x", "y", "z"]
        };
        let lambda = Some((brace, end, &params[..]));
        let body = &code[sig.body..end - 1];
        let statements = slots(body);
        // The last statement is the lambda's value, and so not discarded.
        for s in &statements[..statements.len() - 1] {
            discarded_statement(path, source, code, s, lambda, &mut verdicts, out);
        }
        for s in &statements {
            for inner in control_bodies(s) {
                discarded_statement(path, source, code, inner, lambda, &mut verdicts, out);
            }
        }
    }
    // A script's statements: one that starts a line outside every lambda and
    // is ended by a `;`. It runs on across indented lines, as q reads it.
    for m in re!(r"(?m)^(?:update|delete)\b").find_iter(code) {
        if crate::enclosing_brace(code, m.start()).is_some() {
            continue;
        }
        let rest = &code[m.start()..];
        let span = re!(r"\n\S").find(rest).map_or(rest, |n| &rest[..n.start()]);
        let parts = slots(span);
        if parts.len() > 1 {
            discarded_statement(path, source, code, parts[0], None, &mut verdicts, out);
        }
    }
}

type Verdicts<'a> = std::collections::HashMap<(Option<usize>, &'a str), bool>;

/// The statements of each `if`, `do` and `while` body in statement `s`, the
/// condition apart, and of those nested in them.
fn control_bodies(s: &str) -> Vec<&str> {
    let t = s.trim_start();
    let Some(head) = re!(r"^(?:if|do|while)[ \t]*\[").find(t) else {
        return vec![];
    };
    let open = head.end() - 1;
    let Some(close) = matching(t, open, b'[', b']') else {
        return vec![];
    };
    let mut out = vec![];
    for slot in slots(&t[open + 1..close - 1]).into_iter().skip(1) {
        out.push(slot);
        out.extend(control_bodies(slot));
    }
    out
}

/// QB022 for one statement `s`, a slice of `code` whose value nothing
/// takes: in a lambda (its brace, end and parameters) or at the file's root.
fn discarded_statement<'a>(
    path: &str,
    source: &str,
    code: &'a str,
    s: &'a str,
    lambda: Option<(usize, usize, &[&str])>,
    verdicts: &mut Verdicts<'a>,
    out: &mut Vec<Finding>,
) {
    let t = s.trim_start();
    let at = t.as_ptr() as usize - code.as_ptr() as usize;
    let Some(kw) = re!(r"^(?:update|delete)\b").find(t) else {
        return;
    };
    let Some(from) = top_level_word(t, re!(r"\bfrom\b")) else {
        return;
    };
    let rest = &t[from.end()..];
    let operand = top_level_word(rest, re!(r"\bwhere\b"))
        .map_or(rest, |w| &rest[..w.start()])
        .trim();
    let name =
        if operand.starts_with("([") && matching(operand, 0, b'(', b')') == Some(operand.len()) {
            None
        } else if re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*$").is_match(operand) && !reserved(operand) {
            Some(operand)
        } else {
            return;
        };
    if let Some(name) = name {
        let mut scope = None;
        if let Some((brace, end, params)) = lambda {
            if params.contains(&name) {
                return;
            }
            let local = !name.contains('.')
                && assignments(code, name, brace..end)
                    .any(|(a, _)| crate::enclosing_brace(code, a) == Some(brace));
            scope = local.then_some((brace, end));
        }
        let table = *verdicts
            .entry((scope.map(|s| s.0), name))
            .or_insert_with(|| holds_table(code, name, scope));
        if !table {
            return;
        }
    }
    let what = name.map_or("a table literal".to_string(), |n| format!("`{n}`"));
    out.push(Finding::at(
        path,
        source,
        at,
        "QB022",
        format!(
            "This {} changes a copy of {what} and the statement's value is discarded, \
             so nothing changes: assign the result, or name the table as a symbol to \
             change it in place",
            kw.as_str()
        ),
    ));
}

/// Each assignment of `name` in masked code `within` a range, `name:` or `name::`, outside a
/// qSQL phrase - where `update name:1 from t` names a column - as the offset
/// of the name and of the value after the colons.
fn assignments<'a>(
    code: &'a str,
    name: &'a str,
    within: std::ops::Range<usize>,
) -> impl Iterator<Item = (usize, usize)> + 'a {
    let start = within.start;
    code[within].match_indices(name).filter_map(move |(at, _)| {
        let at = start + at;
        let after = &code[at + name.len()..];
        let colons = after.trim_start_matches([' ', '\t']);
        let value = colons.strip_prefix(':')?;
        let value = value.strip_prefix(':').unwrap_or(value);
        // `name:` is not `name::` read short, and a name runs on past it.
        if !boundary(code, at)
            || code[..at].ends_with('`')
            || after.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '.')
            || crate::in_qsql_phrase(code, at)
        {
            return None;
        }
        Some((at, code.len() - value.len()))
    })
}

/// Whether every assignment of `name` gives it a table: in the lambda
/// `scope` spans for a local, or at the file's root - or with `::` from
/// anywhere - for a global. None at all, or a `` `name set ``, and it is
/// not known.
fn holds_table(code: &str, name: &str, scope: Option<(usize, usize)>) -> bool {
    let brace = scope.map(|s| s.0);
    let within = scope.map_or(0..code.len(), |(a, b)| a..b);
    if brace.is_none()
        && regex::Regex::new(&format!(r"`{}[ \t]+set\b", regex::escape(name)))
            .is_ok_and(|r| r.is_match(code))
    {
        return false;
    }
    let mut any = false;
    for (at, value) in assignments(code, name, within) {
        let global = code[at + name.len()..value].contains("::");
        let owner = crate::enclosing_brace(code, at);
        if (brace.is_some() && owner != brace) || (brace.is_none() && owner.is_some() && !global) {
            continue;
        }
        any = true;
        let v = code[value..].trim_start_matches([' ', '\t']);
        let table = v.starts_with("([")
            || re!(r"^(?:select|flip)\b").is_match(v)
            || re!(r"^(?:update|delete)\b[^;\n]*?\bfrom[ \t]+[^ \t`]").is_match(v);
        if !table {
            return false;
        }
    }
    any
}

/// QB023. `()` is the empty *general* list, and match compares type as well
/// as items: q 5 `()~0#0`, ``()~`symbol$()`` and `()~""` are each 0b. So
/// `x~()` is true only when `x` is an untyped empty list, and `0=count x`
/// is the test for empty.
///
/// Only where the other side cannot be untyped. `()~key p` is how q asks
/// whether a path exists - `key` of a missing file is `()` - and a name
/// set to `()` as a sentinel is rightly compared with it, so a name or an
/// expression of unknown type is left alone. What is reported is a whole
/// call of `til`, `getenv` or `read1` - always a typed list (`typed_call`) -
/// or a local of the lambda whose every assignment is one of those or a
/// typed literal: a string, `` `$() ``, `` `long$() ``, `"j"$()` or `0#` of
/// an atom. Not `where`: of a dictionary it is the keys, and q 5
/// `()~where ()!()` is 1b (#2684).
fn empty_match(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    let b = code.as_bytes();
    for (at, _) in code.match_indices('~') {
        // `()` read in `comments` too, where a string is still there:
        // `("")~x` is no `()`. Nor is the key list of `()!()`.
        let empty = |open: usize| {
            b.get(open) == Some(&b'(')
                && matching(code, open, b'(', b')').is_some_and(|close| {
                    code[open + 1..close - 1].trim().is_empty()
                        && comments[open + 1..close - 1].trim().is_empty()
                        && !code[close..].trim_start().starts_with('!')
                })
        };
        let left = code[..at].trim_end_matches([' ', '\t']);
        let right_at = past_blanks_inline(code, at + 1);
        // The other side: everything to the right of `()~`, or the one
        // operand to the left of `~()` - a name, or a parenthesised group.
        let (start, operand, operand_at) =
            if left.ends_with(')') && left.len() >= 2 && empty(left.len() - 2) {
                (left.len() - 2, &code[right_at..], right_at)
            } else if empty(right_at) {
                let inner = if left.ends_with(')') {
                    left.bytes()
                        .enumerate()
                        .rev()
                        .scan(0i32, |depth, (i, c)| {
                            *depth += match c {
                                b')' | b']' | b'}' => 1,
                                b'(' | b'[' | b'{' => -1,
                                _ => 0,
                            };
                            Some((i, *depth))
                        })
                        .find(|&(_, d)| d == 0)
                        .map(|(open, _)| open + 1)
                        .filter(|&o| matching(code, o - 1, b'(', b')') == Some(left.len()))
                } else {
                    None
                };
                match inner {
                    Some(o) => (right_at, &code[o..left.len() - 1], o),
                    None => {
                        let Some(name) = re!(r"\.?[A-Za-z][A-Za-z0-9_.]*$").find(left) else {
                            continue;
                        };
                        if !boundary(code, name.start()) {
                            continue;
                        }
                        (right_at, name.as_str(), name.start())
                    }
                }
            } else {
                continue;
            };
        let operand = operand.trim_start();
        let typed = typed_call(operand)
            || re!(r"^[A-Za-z][A-Za-z0-9_]*")
                .find(operand)
                .filter(|n| {
                    let rest = operand[n.end()..].trim_start_matches([' ', '\t']);
                    rest.is_empty() || rest.starts_with([';', ')', ']', '}', '\n', '\r'])
                })
                .is_some_and(|n| typed_local(source, code, comments, operand_at, n.as_str()));
        if !typed {
            continue;
        }
        out.push(Finding::at(
            path,
            source,
            start,
            "QB023",
            "`()` is the empty general list and match compares types, so this is false for \
             a typed empty list - 0#0, `symbol$(), \"\" - and this side is always typed: \
             `0=count x` tests emptiness"
                .into(),
        ));
    }
}

/// Whether `operand` is, as a whole, one call of `til`, `getenv` or `read1`.
/// The first word alone says nothing: q 5 `()~til[x]#y` is 1b for `y` `()`,
/// as is `()~til each ()` (#2685). So a bracket call has to end the
/// expression, and a juxtaposed one has to be given its argument - which
/// then runs to the end, q reading right to left - not an iterator.
fn typed_call(operand: &str) -> bool {
    let Some(name) = re!(r"^(?:til|getenv|read1)\b").find(operand) else {
        return false;
    };
    let rest = &operand[name.end()..];
    let arg = rest.trim_start_matches([' ', '\t']);
    if arg.starts_with('[') {
        let open = operand.len() - arg.len();
        let Some(close) = matching(operand, open, b'[', b']') else {
            return false;
        };
        let after = operand[close..].trim_start_matches([' ', '\t']);
        return after.is_empty() || after.starts_with([';', ')', ']', '}', '\n', '\r']);
    }
    if arg.len() == rest.len() && !arg.starts_with(['(', '"', '`']) {
        return false;
    }
    re!(r#"^(?:-?[0-9.]|[("`]|\.?[A-Za-z])"#).is_match(arg)
        && !re!(r"^(?:each|peach|over|scan|prior)\b").is_match(arg)
}

/// Whether `name`, read at `at`, is a local of the lambda around it whose
/// every assignment there gives it a typed list or atom - never `()`.
fn typed_local(source: &str, code: &str, comments: &str, at: usize, name: &str) -> bool {
    let Some(brace) = crate::enclosing_brace(code, at) else {
        return false;
    };
    let Some(end) = matching(code, brace, b'{', b'}') else {
        return false;
    };
    let sig = crate::signature(code, source, brace);
    let params: Vec<&str> = if sig.named {
        sig.slots
            .iter()
            .flat_map(|p| crate::pattern_names(p))
            .collect()
    } else {
        vec!["x", "y", "z"]
    };
    if params.contains(&name) {
        return false;
    }
    let mut any = false;
    for (a, value) in assignments(code, name, brace..end) {
        if crate::enclosing_brace(code, a) != Some(brace) {
            continue;
        }
        if code[a + name.len()..value].contains("::") {
            return false;
        }
        // The value to the end of its statement, strings kept.
        let text = &comments[value..];
        let stop = text.find([';', '\n', '}']).unwrap_or(text.len());
        let v = text[..stop].trim();
        if !re!(
            r#"^(?:"(?:[^"\\]|\\.)*"|`[a-z]*\$\(\)|"[A-Za-z]"\$\(\)|0#(?:`[A-Za-z0-9_.]*|-?\d[A-Za-z0-9.]*|"(?:[^"\\]|\\.)*"))$"#
        )
        .is_match(v)
            && !typed_call(v)
        {
            return false;
        }
        any = true;
    }
    any
}

/// `at` moved past spaces and tabs.
fn past_blanks_inline(text: &str, at: usize) -> usize {
    at + (text[at..].len() - text[at..].trim_start_matches([' ', '\t']).len())
}

/// QT036. `getenv` gives a string, `""` when the variable is unset, and
/// `null` of a string is a boolean vector, one item a character: q 5
/// `null getenv`UNSET` is `` `boolean$() ``, and `if[null getenv`X;...]` is
/// 'type whether or not X is set. `all null` or `any null` in front reduces
/// it to an atom, and is left alone.
fn null_getenv(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for m in re!(r"null(?:[ \t]+|[ \t]*[\[(][ \t]*)getenv\b").find_iter(code) {
        let before = code[..m.start()].trim_end_matches([' ', '\t']);
        let reduced = ["all", "any"]
            .iter()
            .any(|w| before.ends_with(w) && boundary(code, before.len() - w.len()));
        if !boundary(code, m.start()) || reduced {
            continue;
        }
        out.push(Finding::at(
            path,
            source,
            m.start(),
            "QT036",
            "getenv gives a string, so null tests each character and gives a vector - empty \
             when the variable is unset - which if and $[...] refuse with 'type: \
             `\"\"~getenv x` or `0=count getenv x` tests an unset variable"
                .into(),
        ));
    }
}

/// The columns a kdb+ database is partitioned by: `.Q.pf` is one of these.
const PARTITION_COLUMNS: [&str; 4] = ["date", "month", "year", "int"];

/// The atomic monadic builtins: each applies item by item to a list, a
/// dictionary or a table, so `f each x` gives what `f x` gives - one call
/// per item where one would do. Measured in KDB-X over a million items:
/// `abs each` 63 ms against `abs` under 1 ms, `sqrt each` 52 ms against
/// 0.7 ms, `not each` 124 ms against under 1 ms. Every value matches but
/// the empty list's type: `null each 0#0f` is `()`, `null 0#0f` is
/// `` `boolean$() ``.
const ATOMIC_MONADS: [&str; 11] = [
    "abs",
    "neg",
    "sqrt",
    "exp",
    "log",
    "floor",
    "ceiling",
    "not",
    "null",
    "signum",
    "reciprocal",
];

/// The performance rules, after Ruff's PERF: q that gives the right answer
/// slower than it has to, by a measured margin, and only where the shape
/// says so from the text alone.
fn performance(path: &str, source: &str, code: &str, comments: &str, out: &mut Vec<Finding>) {
    partition_filter_late(path, source, code, comments, out);
    atomic_each(path, source, code, out);
    append_in_loop(path, source, code, out);
}

/// QV001. A where phrase whose first constraint is not on the partition
/// column, with a later one that is. q applies the constraints in order, and
/// only one on the partition column first narrows the partitions it reads:
/// over 20 date partitions of 2M rows, measured in KDB-X, `where
/// date=d, sym=s` took 5 ms and `where sym=s, date=d` 85 ms, every partition
/// read for the sym; `date within` after `size>500` 56 ms against 12 ms.
/// The answers are the same.
///
/// Only when what comes before is a plain comparison of a column with a
/// literal or a name - `sym=`a`, `size>500`, `sym in s`. Moving a constraint
/// past one that aggregates (`price>avg price`) would change the rows it
/// aggregates over, and so the answer.
///
/// Never for `update` or `delete`: q refuses both on a partitioned table
/// (`'par` in KDB-X), so the table they filter is in memory and the order
/// costs nothing the rule claims.
fn partition_filter_late(
    path: &str,
    source: &str,
    code: &str,
    comments: &str,
    out: &mut Vec<Finding>,
) {
    let mut strings = InString::new(code);
    // `select ... from select ... where` finds the inner where from both.
    let mut reported = std::collections::HashSet::new();
    let mut froms = vec![];
    for q in re!(r"(?:select|exec|update|delete)\b").find_iter(code) {
        if !crate::boundary(code, q.start())
            || strings.at(q.start())
            || matches!(q.as_str(), "update" | "delete")
        {
            continue;
        }
        let rest = &code[q.end()..];
        let Some(from) = top_level_word(rest, re!(r"\bfrom\b")) else {
            continue;
        };
        froms.push(q.end() + from.end());
    }
    // Each query's phrase ends where `crate::phrase_end` says, and its where
    // is the first at its own level before then, as `top_level_word` would
    // find it. Both are read for every query in one pass from the end: in
    // `select from select from ... t` each phrase runs on to the statement's
    // end, so reading each in turn was quadratic in the chain (#709).
    let ends = first_at_level(code, &froms, |i| {
        matches!(code.as_bytes()[i], b')' | b']' | b'}' | b';')
    });
    let wheres: std::collections::HashSet<usize> = re!(r"\bwhere\b")
        .find_iter(code)
        .map(|m| m.start())
        .collect();
    let first_wheres = first_at_level(code, &froms, |i| wheres.contains(&i));
    for (&end, &w) in ends.iter().zip(&first_wheres) {
        if w >= end {
            continue;
        }
        let phrase_start = w + "where".len();
        // An unindented line ends the statement before the phrase does.
        let phrase = &code[phrase_start..end];
        let phrase = match re!(r"\n\S").find(phrase) {
            Some(m) => &phrase[..m.start()],
            None => phrase,
        };
        let constraints = items(phrase);
        fn tests_partition(c: &str) -> Option<&str> {
            re!(r"^\s*(date|month|year|int)\s*(?:=|<>|<=|>=|<|>|\bwithin\b|\bin\b)")
                .captures(c)
                .map(|m| m.get(1).unwrap().as_str())
        }
        let Some((late, column)) = constraints
            .iter()
            .enumerate()
            .skip(1)
            .find_map(|(i, c)| tests_partition(c).map(|col| (i, col)))
        else {
            continue;
        };
        let offset = |c: &str| c.as_ptr() as usize - code.as_ptr() as usize;
        let plain = constraints[..late].iter().all(|c| {
            let at = offset(c);
            let kept = &comments[at..at + c.len()];
            !PARTITION_COLUMNS.iter().any(|p| {
                re!(r"[A-Za-z0-9_.]+")
                    .find_iter(c)
                    .any(|m| m.as_str() == *p)
            }) && plain_comparison(kept)
        });
        if !plain || !reported.insert(offset(constraints[late])) {
            continue;
        }
        let first = constraints[0].trim();
        out.push(Finding::at(
            path,
            source,
            offset(constraints[late]),
            "QV001",
            format!(
                "`{column}` is constrained after `{first}`: on a table partitioned by {column} \
                 q applies `{first}` in every partition before it narrows them - put the \
                 `{column}` constraint first"
            ),
        ));
    }
}

/// For each offset of `from`, the first offset at or after it that `hit`
/// accepts at the bracket depth `from` starts at, or `code.len()` when there
/// is none. Nothing after `from` sits shallower than it until a closer at its
/// depth, so this is what reading on from `from` and counting brackets
/// finds - for all of them in two passes over `code`, where reading each in
/// turn is quadratic when they share a long tail.
fn first_at_level(code: &str, from: &[usize], hit: impl Fn(usize) -> bool) -> Vec<usize> {
    let b = code.as_bytes();
    let step = |c: u8| match c {
        b'(' | b'[' | b'{' => 1,
        b')' | b']' | b'}' => -1,
        _ => 0,
    };
    // Not in order: in `select (select a from t) from u` the inner query's
    // `from` comes first. Answered from the last back, as the pass meets them.
    let mut order: Vec<usize> = (0..from.len()).collect();
    order.sort_by_key(|&k| from[k]);
    // The depth before each byte, rebuilt backwards from the depth at the end.
    let mut depth: i32 = b.iter().map(|&c| step(c)).sum();
    let mut next = std::collections::HashMap::new();
    let mut out = vec![code.len(); from.len()];
    for i in (0..b.len()).rev() {
        depth -= step(b[i]);
        if hit(i) {
            next.insert(depth, i);
        }
        while let Some(&k) = order.last().filter(|&&k| from[k] >= i) {
            order.pop();
            if from[k] == i {
                out[k] = next.get(&depth).copied().unwrap_or(code.len());
            }
        }
    }
    out
}

/// Whether a where constraint compares a column with a literal or a name
/// and nothing more: `sym=`a`, `size>500`, `sym in `a`b`, `px within 1 2`,
/// `name like "a*"`.
fn plain_comparison(c: &str) -> bool {
    re!(concat!(
        r"^\s*[A-Za-z][A-Za-z0-9_]*\s*(?:=|<>|<=|>=|<|>|~|\blike\b|\bin\b|\bwithin\b)\s*",
        r#"(?:`[A-Za-z0-9_.:/`]*|"(?:[^"\\]|\\.)*"|-?[0-9][0-9A-Za-z.:]*(?:\s+-?[0-9][0-9A-Za-z.:]*)*"#,
        r"|\.?[A-Za-z][A-Za-z0-9_.]*|\([^()]*\))\s*$"
    ))
    .is_match(c)
}

/// QV002. `abs each x` is `abs x`, one call per item where one call does:
/// see `ATOMIC_MONADS` for what was measured. `count each`, `string each`
/// and the rest that are not atomic are not reported.
fn atomic_each(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    for m in re!(concat!(
        r"\b(abs|neg|sqrt|exp|log|floor|ceiling|not|null|signum|reciprocal)",
        blank!(),
        r"*(?:each\b|'\[)"
    ))
    .captures_iter(code)
    {
        let name = m.get(1).unwrap();
        if !crate::boundary(code, name.start()) {
            continue;
        }
        debug_assert!(ATOMIC_MONADS.contains(&name.as_str()));
        out.push(Finding::at(
            path,
            source,
            name.start(),
            "QV002",
            format!(
                "`{0}` is atomic: `{0} x` applies it to every item in one call, where `each` \
                 makes one call per item",
                name.as_str()
            ),
        ));
    }
}

/// QV003. `r:r,x` or `r:raze(r;x)` in the body of a `do` or `while` copies
/// all of `r` on every pass, so the loop takes time quadratic in its count.
/// Measured in KDB-X, 10, 20 and 40 thousand passes of `r:r,til 10`: 52,
/// 205 and 818 ms, against 2.5, 5.5 and 11 ms for `r,:til 10`, which
/// appends in place, and for `raze f each`.
///
/// Not when the body gives `r` a fresh value before the join (`r:g x;
/// r:r,y`): each pass then joins to that, not to every pass before it. Nor
/// inside a lambda in the body, whose `r` is its own local.
fn append_in_loop(path: &str, source: &str, code: &str, out: &mut Vec<Finding>) {
    let mut strings = InString::new(code);
    // A loop inside a loop has its assignments in both bodies: once each.
    let mut reported = std::collections::HashSet::new();
    for l in re!(r"\b(?:do|while)\s*\[").find_iter(code) {
        if !crate::boundary(code, l.start()) || strings.at(l.start()) {
            continue;
        }
        let open = l.end() - 1;
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let body = &code[open + 1..close - 1];
        // The count or condition comes first, then the body.
        let Some(semi) = first_at_depth_zero(body, b';') else {
            continue;
        };
        let start = open + 1 + semi + 1;
        // Names the body has given a value not joined from themselves.
        let mut fresh = std::collections::HashSet::new();
        let mut lambdas = LambdaDepth::new(code, start);
        for a in
            re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]*:[ \t]*").captures_iter(&code[start..close - 1])
        {
            let name = a.get(1).unwrap();
            let at = start + name.start();
            if !crate::boundary(code, at) || strings.at(at) || lambdas.inside(at) {
                continue;
            }
            // Directly after a `:` is a compound or nested assignment.
            let rhs = &code[start + a.get(0).unwrap().end()..close - 1];
            if !joins_itself(rhs, name.as_str()) {
                fresh.insert(name.as_str());
                continue;
            }
            if !fresh.contains(name.as_str()) && reported.insert(at) {
                out.push(Finding::at(
                    path,
                    source,
                    at,
                    "QV003",
                    format!(
                        "Assigning `{0}` from `{0}` joined to more copies all of `{0}` on every \
                         pass of the loop, so it takes time quadratic in its count: `{0},:` \
                         appends in place",
                        name.as_str()
                    ),
                ));
            }
        }
    }
}

/// Whether an assignment's right side, `rhs`, joins `name` to more: `name,x`
/// or `raze(name;x)`, spaces and tabs allowed between the parts. Not
/// `name,:x`, `name,'x`, `name,/x` or `name,\x`: those are an append in
/// place or an iterator, not a copy.
///
/// Read by hand, where QV003 compiled two regexes for every assignment in
/// a loop body.
fn joins_itself(rhs: &str, name: &str) -> bool {
    fn blanks(s: &str) -> &str {
        s.trim_start_matches([' ', '\t'])
    }
    let joined = rhs.strip_prefix(name).map(blanks).is_some_and(|r| {
        r.strip_prefix(',')
            .and_then(|r| r.chars().next())
            .is_some_and(|c| !matches!(c, ':' | '\'' | '/' | '\\'))
    });
    joined
        || rhs
            .strip_prefix("raze")
            .map(blanks)
            .and_then(|r| r.strip_prefix('(').map(blanks))
            .and_then(|r| r.strip_prefix(name).map(blanks))
            .is_some_and(|r| r.starts_with(';'))
}

/// Whether an offset is inside a lambda that opens after `from`: braces
/// outside strings between the two that do not close again. Asked in order
/// of the offset, it reads on from its last answer, where reading from
/// `from` for each assignment was quadratic in a loop body's length.
struct LambdaDepth<'a> {
    code: &'a str,
    strings: InString<'a>,
    i: usize,
    depth: i32,
}

impl<'a> LambdaDepth<'a> {
    fn new(code: &'a str, from: usize) -> Self {
        LambdaDepth {
            code,
            strings: InString::new(code),
            i: from,
            depth: 0,
        }
    }

    fn inside(&mut self, at: usize) -> bool {
        debug_assert!(at >= self.i, "asked out of order");
        let b = self.code.as_bytes();
        while self.i < at {
            if matches!(b[self.i], b'{' | b'}') && !self.strings.at(self.i) {
                self.depth += if b[self.i] == b'{' { 1 } else { -1 };
            }
            self.i += 1;
        }
        self.depth > 0
    }
}

/// Where `byte` first occurs in `text` outside every bracket.
fn first_at_depth_zero(text: &str, byte: u8) -> Option<usize> {
    let mut depth = 0i32;
    text.bytes().position(|b| {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            _ => {}
        }
        b == byte && depth == 0
    })
}

/// A start and end, standing in for a regex match where a rule gathers
/// positions from more than one pattern.
struct Span {
    start: usize,
    end: usize,
}
impl Span {
    fn start(&self) -> usize {
        self.start
    }
    fn end(&self) -> usize {
        self.end
    }
}

#[cfg(test)]
mod tests {
    use super::column_name;

    /// Each pair measured in q 5 with `cols select E from t`, t:([]a:1 2;b:3 4)
    /// and f:{x}, g:{x+y}.
    #[test]
    fn column_names_follow_q5() {
        let measured = [
            ("a+b", "a"),
            ("a-b", "a"),
            ("a*b", "a"),
            ("a%b", "a"),
            ("a&b", "a"),
            ("a|b", "a"),
            ("a and b", "a"),
            ("a or b", "a"),
            ("2+a", "x"),
            ("1+a", "x"),
            ("a=b", "b"),
            ("a<b", "b"),
            ("a>b", "b"),
            ("a<>b", "b"),
            ("a^b", "b"),
            ("a#b", "b"),
            ("a@b", "b"),
            ("a?b", "b"),
            ("a<=b", "b"),
            ("a>=b", "b"),
            ("a mod b", "b"),
            ("a xbar b", "b"),
            ("a div b", "b"),
            ("a cross b", "b"),
            ("a except b", "b"),
            ("a wavg b", "b"),
            ("a xlog b", "b"),
            ("a mod 2", "x"),
            ("a<2", "x"),
            ("a=2", "x"),
            ("a within 1 2", "x"),
            ("a in 1 2", "x"),
            ("a xexp 2", "x"),
            ("max a", "a"),
            ("f a", "a"),
            ("f[a]", "a"),
            ("{x} a", "a"),
            ("g[a;1]", "x"),
            ("sum 1+a", "x"),
            ("g[1;a]", "a"),
            ("(a;b)", "b"),
            ("(a)", "a"),
            ("max a+b", "a"),
            ("b+max a", "b"),
            ("f[a]+b", "a"),
            ("(a+b)*2", "a"),
            ("a+b*2", "a"),
            ("2*a+b", "x"),
            ("a b", "b"),
            ("a - 1", "a"),
            ("a-1", "a"),
            ("b xbar a", "a"),
            ("b>a", "a"),
            ("i", "x"),
            ("a+1 2", "a"),
            ("a+(b)", "a"),
            ("neg a", "a"),
            ("1 2", "x"),
            ("f[a]+f[b]", "a"),
            ("g[b;a]", "a"),
            ("{x+y}[a;b]", "b"),
            ("(a;1)", "x"),
            ("(1;a)", "a"),
            ("a=b+1", "b"),
            ("a+b=1", "a"),
            ("max[a]", "a"),
            ("f[a]=b", "b"),
            ("a+f b", "a"),
            ("max a mod b", "b"),
            ("a mod max b", "b"),
            ("count i", "x"),
            ("m:max a", "m"),
            // #1203
            ("`int$a", "a"),
            ("b$a", "a"),
            ("1_a", "a"),
            ("b!a", "a"),
            ("b bin a", "a"),
            ("f each a", "a"),
            ("{x} peach a", "a"),
            ("b union a", "a"),
        ];
        for (expr, name) in measured {
            assert_eq!(column_name(expr), Some(name), "{expr}");
        }
        // Unmeasured, or adverbs: no name rather than a guess.
        for expr in ["a+/b", "a like b", ".z.p", "-a"] {
            assert_eq!(column_name(expr), None, "{expr}");
        }
    }
}
