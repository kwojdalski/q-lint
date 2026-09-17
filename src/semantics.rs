use crate::{Finding, boundary, line_at, matching, signature};
use std::collections::{HashMap, HashSet};

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
fn qualify(name: &str, ns: &str) -> String {
    if name.starts_with('.') {
        name.into()
    } else {
        format!("{ns}.{name}")
    }
}
fn scope_at(scopes: &[Scope], at: usize) -> Option<usize> {
    scopes.iter().rposition(|s| s.start < at && at < s.end)
}
fn shape(s: &str) -> Option<usize> {
    let s = s.trim();
    if re!(r"\n\S").is_match(s) {
        return None;
    }
    if s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len()) {
        return shape(&s[1..s.len() - 1]);
    }
    if let Some(rest) = s.strip_prefix("enlist ") {
        return shape(rest).map(|_| 1);
    }
    if re!(r"^(?:`[A-Za-z][A-Za-z0-9_.]*)+$").is_match(s) {
        return Some(s.bytes().filter(|&b| b == b'`').count());
    }
    if re!(r"^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[bhijef]?(?:\s+-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[bhijef]?)*$").is_match(s) {return Some(s.split_whitespace().count());}
    None
}
pub fn check(path: &str, code: &str, raw: &str) -> Vec<Finding> {
    let mut out = vec![];
    for m in re!(r"((?:`[A-Za-z][A-Za-z0-9_.]*)+)\s*!").captures_iter(code) {
        let start = m.get(0).unwrap();
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
            } else if b == b'\n' && depth == 0 {
                // A dictionary's value stops at the end of its line, as q
                // reads it; scanning further would take the next statement's
                // tokens for a continuation of the vector and hide the very
                // length mismatch the rule exists to catch.
                break;
            }
            end += 1;
        }
        if let (Some(keys), Some(values)) = (shape(&m[1]), shape(&code[start.end()..end]))
            && keys != values
        {
            out.push(Finding::new(
                path,
                line_at(code, start.start()),
                "QT001",
                format!("Literal dictionary has {keys} keys and {values} values"),
            ));
        }
    }
    // Two literal vectors either side of an infix that pairs elements must
    // agree in length, or the line is a 'length error - `1 2 3+4 5` and
    // `` `a`b=`a`b`c `` alike. `,` joins anything and is not in the set. A
    // `-` with space before and none after is a negative literal rather than
    // the operator (`1 2 3 -1 2` is one five-vector), and is skipped.
    for m in re!(
        r"(?P<l>(?:`[A-Za-z0-9_.]*){2,}|-?\d[\w.]*(?:\s+-?\d[\w.]*)+)\s*(?P<op><>|<=|>=|[+*%&|=<>-])\s*(?P<r>(?:`[A-Za-z0-9_.]*){2,}|-?\d[\w.]*(?:\s+-?\d[\w.]*)+)"
    )
    .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        let op = m.name("op").unwrap();
        let negative = op.as_str() == "-"
            && code[..op.start()].ends_with(char::is_whitespace)
            && !code[op.end()..].starts_with(char::is_whitespace);
        if negative
            || !boundary(code, whole.start())
            || code[whole.end()..].starts_with(|c: char| c.is_alphanumeric() || "_.`".contains(c))
        {
            continue;
        }
        if let (Some(l), Some(r)) = (shape(&m["l"]), shape(&m["r"]))
            && l != r
        {
            out.push(Finding::new(
                path,
                line_at(code, whole.start()),
                "QT006",
                format!(
                    "`{}` pairs a {l}-vector with a {r}-vector; that is a 'length error",
                    op.as_str()
                ),
            ));
        }
    }
    // Dynamic evaluation is where this file stops being analysable: the
    // scope checks below would need to resolve names that only exist at
    // runtime. That limit is worth a finding of its own, so a reader knows
    // the silence after it is a skipped analysis, not a clean one.
    let dynamic = re!(r"(?m)^\\l\b")
        .find(code)
        .map(|m| (m.start(), "\\l".into()))
        .or_else(|| {
            re!(r"\b(?:set|value|eval|system)\b")
                .find_iter(code)
                .find(|m| boundary(code, m.start()))
                .map(|m| (m.start(), m.as_str().to_string()))
        });
    if let Some((at, what)) = dynamic {
        out.push(Finding::new(
            path,
            line_at(code, at),
            "QP004",
            format!("`{what}` evaluates dynamically; name-scope checks were skipped for this file"),
        ));
        return out;
    }
    let assignment = re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*:(:)?");
    let mut scopes: Vec<Scope> = vec![];
    let mut stack: Vec<usize> = vec![];
    let mut namespace = String::new();
    let mut namespaces = vec![];
    let mut offset = 0;
    for line in code.split_inclusive('\n') {
        if stack.is_empty()
            && let Some(m) = re!(r"^\\d\s+(\.[\w.]*)\s*$").captures(line)
        {
            namespace = m[1].trim_end_matches('.').into();
        }
        namespaces.push((offset, namespace.clone()));
        if line.starts_with('\\') {
            offset += line.len();
            continue;
        }
        for (i, b) in line.bytes().enumerate() {
            let at = offset + i;
            if b == b'{' {
                let sig = signature(code, raw, at);
                // When the brackets are not a parameter list q binds the
                // implicit arguments instead, and so must the scope here.
                let params = if sig.named {
                    sig.slots
                        .iter()
                        .filter(|p| !p.is_empty())
                        .map(|p| (*p).to_string())
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
    for i in 0..scopes.len() {
        let scope = &scopes[i];
        let mut direct = code.as_bytes()[scope.body..scope.end].to_vec();
        for child in &scopes {
            if child.parent == Some(i) {
                direct[child.start - scope.body..child.end + 1 - scope.body].fill(b' ');
            }
        }
        let direct = String::from_utf8(direct).unwrap();
        let mut locals = scope.params.clone();
        for a in assignment.captures_iter(&direct) {
            if boundary(&direct, a.get(0).unwrap().start())
                && a.get(2).is_none()
                && !a[1].contains('.')
            {
                locals.insert(a[1].into());
            }
        }
        scopes[i].direct = direct;
        scopes[i].locals = locals;
    }
    let ns_at = |at| {
        namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1
        .as_str()
    };
    let mut globals: HashMap<String, Vec<usize>> = HashMap::new();
    for a in assignment.captures_iter(code) {
        let m = a.get(0).unwrap();
        if !boundary(code, m.start()) {
            continue;
        }
        if scope_at(&scopes, m.start()).is_none() || a.get(2).is_some() || a[1].contains('.') {
            globals
                .entry(qualify(&a[1], ns_at(m.start())))
                .or_default()
                .push(m.end());
        }
    }
    let mut numeric = HashSet::new();
    for (name, assignments) in &globals {
        if assignments.len() != 1 {
            continue;
        }
        let start = code.len() - code[assignments[0]..].trim_start().len();
        if let Some(scope) = scopes
            .iter()
            .find(|s| s.start == start && s.params.len() == 1)
            && let Some(m)=re!(r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*[+*%\-]\s*-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[bhijef]?\s*;?\s*$").captures(&scope.direct)
                && scope.params.contains(&m[1]) {numeric.insert(name.clone());}
    }
    for call in re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\[\s*`[A-Za-z][A-Za-z0-9_.]*\s*\]").captures_iter(code) {
        let at=call.get(0).unwrap().start();let name=&call[1];if !boundary(code,at){continue;}
        if scope_at(&scopes,at).is_some_and(|s|scopes[s].locals.contains(name)){continue;}
        if numeric.contains(&qualify(name,ns_at(at))) {out.push(Finding::new(path,line_at(code,at),"QT002",format!("Symbol literal passed to numeric function {name}")));}
    }
    // An assignment anywhere in a lambda body makes the name local for the
    // whole body, including the statements above it - so a read in an
    // earlier statement finds an unset local, never the global, and q throws
    // the name. Verified: `{r:cfg; cfg:1; r}[]` is 'cfg, `{if[a;a:1]}[]` is
    // 'a. Within one statement q evaluates right to left, so `x#a where
    // (a:...)` assigns before it reads and is fine: only a read in a strictly
    // earlier statement counts, where "statement" is what a `;` at body level
    // separates - or one inside `if`, `while`, `do` or `$`, whose slots run
    // left to right. A column in a table literal is not an assignment, and
    // column names inside a query resolve to the table first, so both are
    // out of scope here.
    for scope in &scopes {
        if re!(r"\b(?:select|exec|update|delete)\b").is_match(&scope.direct) {
            continue;
        }
        let direct = re!(r"`[A-Za-z0-9_./:]*")
            .replace_all(&scope.direct, |m: &regex::Captures| " ".repeat(m[0].len()))
            .into_owned();
        let mut direct = direct.into_bytes();
        let text = String::from_utf8(direct.clone()).unwrap();
        for (at, _) in text.match_indices("([") {
            if let Some(close) = matching(&text, at, b'(', b')') {
                direct[at..close].fill(b' ');
            }
        }
        let direct = String::from_utf8(direct).unwrap();
        // The statement each byte belongs to.
        let mut statement = vec![0usize; direct.len() + 1];
        let (mut seq, mut control) = (0usize, vec![]);
        let bytes = direct.as_bytes();
        for (i, &c) in bytes.iter().enumerate() {
            statement[i] = seq;
            match c {
                b'[' => {
                    let head = direct[..i].trim_end();
                    control.push(
                        head.ends_with("if")
                            || head.ends_with("while")
                            || head.ends_with("do")
                            || head.ends_with('$'),
                    );
                }
                b'(' | b'{' => control.push(false),
                b')' | b']' | b'}' => {
                    control.pop();
                }
                b';' | b'\n' if control.last().is_none_or(|&c| c) => seq += 1,
                _ => {}
            }
        }
        let mut first: HashMap<&str, usize> = HashMap::new();
        for a in assignment.captures_iter(&direct) {
            let m = a.get(0).unwrap();
            if boundary(&direct, m.start()) && a.get(2).is_none() && !a[1].contains('.') {
                let name = a.get(1).unwrap().as_str();
                first.entry(name).or_insert(m.start());
            }
        }
        let mut seen = HashSet::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&direct) {
            let name = m.as_str();
            let after = direct[m.end()..].trim_start();
            let Some(&assigned) = first.get(name) else {
                continue;
            };
            if statement[m.start()] >= statement[assigned]
                || scope.params.contains(name)
                || !boundary(&direct, m.start())
                || after.starts_with(':')
                || after.starts_with('.')
                || !seen.insert(name)
            {
                continue;
            }
            out.push(Finding::new(
                path,
                line_at(code, scope.body + m.start()),
                "QF014",
                format!(
                    "`{name}` is read here but assigned in a later statement, which makes it \
                     local throughout: this read finds an unset local and throws '{name}"
                ),
            ));
        }
    }
    // A declared signature takes the implicit arguments out of scope: `x` in
    // `{[a] x+1}` is not an argument, it is a global, and q throws 'x when
    // there is none. Only a name this file never assigns globally is reported,
    // since the global may legitimately live in another file.
    for scope in &scopes {
        if !scope.named || re!(r"\b(?:select|exec|update|delete)\b").is_match(&scope.direct) {
            continue;
        }
        let direct = re!(r"`[A-Za-z0-9_./:]*")
            .replace_all(&scope.direct, |m: &regex::Captures| " ".repeat(m[0].len()));
        let mut seen = HashSet::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&direct) {
            let name = m.as_str();
            if !matches!(name, "x" | "y" | "z")
                || !boundary(&direct, m.start())
                || direct[m.end()..].starts_with('.')
                || scope.locals.contains(name)
                || !seen.insert(name)
            {
                continue;
            }
            if globals.contains_key(&qualify(name, &scope.namespace))
                || globals.contains_key(&format!(".{name}"))
            {
                continue;
            }
            out.push(Finding::new(
                path,
                line_at(code, scope.body + m.start()),
                "QF010",
                format!(
                    "'{name}' is not an argument here: the lambda declares its parameters, so \
                     q resolves '{name}' as a global"
                ),
            ));
        }
    }
    for scope in &scopes {
        if scope.parent.is_none()
            || re!(r"\b(?:select|exec|update|delete)\b").is_match(&scope.direct)
        {
            continue;
        }
        let mut outer = HashSet::new();
        let mut parent = scope.parent;
        while let Some(p) = parent {
            outer.extend(scopes[p].locals.iter().cloned());
            parent = scopes[p].parent;
        }
        let direct = re!(r"`[A-Za-z0-9_./:]*")
            .replace_all(&scope.direct, |m: &regex::Captures| " ".repeat(m[0].len()));
        let mut seen = HashSet::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&direct) {
            let name = m.as_str();
            if !boundary(&direct, m.start())
                || direct[m.end()..].starts_with('.')
                || !outer.contains(name)
                || scope.locals.contains(name)
                || !seen.insert(name)
            {
                continue;
            }
            if globals.contains_key(&qualify(name, &scope.namespace))
                || globals.contains_key(&format!(".{name}"))
            {
                continue;
            }
            out.push(Finding::new(
                path,
                line_at(code, scope.body + m.start()),
                "QF005",
                format!("Nested lambda references enclosing local '{name}' without a parameter"),
            ));
        }
    }
    out
}
