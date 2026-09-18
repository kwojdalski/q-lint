use crate::{Finding, boundary, matching, signature};
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
/// The names a multiple assignment `(a;b):...` binds, with where it starts.
fn multi_assignments(text: &str) -> impl Iterator<Item = (usize, &str)> {
    re!(r"\(([A-Za-z0-9_;\s]+)\)\s*:[^:]")
        .captures_iter(text)
        .flat_map(|m| {
            let at = m.get(0).unwrap().start();
            m.get(1)
                .unwrap()
                .as_str()
                .split(';')
                .map(str::trim)
                .filter(|n| !n.is_empty() && n.starts_with(|c: char| c.is_ascii_alphabetic()))
                .map(move |n| (at, n))
                .collect::<Vec<_>>()
        })
}
/// Whether q runs the expression at `read` before the one at `assign`, both
/// offsets into one lambda body. Statements run top to bottom, and the slots
/// of `if`, `while`, `do` and `$[...]` left to right; everything else -
/// the arguments of a call, the items of a list, the two sides of an infix -
/// runs right to left. So two positions are ordered by their text only when
/// the nearest bracket enclosing both is a control bracket or the body
/// itself. `f[c-1; c:count x]` and `g[c] h[c:1]` both assign before they
/// read; `if[c; c:1]` and `r:c; c:1` do not.
fn runs_before(text: &str, read: usize, assign: usize) -> bool {
    let path = |pos: usize| {
        let (mut seq, mut stack): (usize, Vec<(usize, usize, bool)>) = (0, vec![]);
        for (i, &c) in text.as_bytes()[..pos].iter().enumerate() {
            match c {
                b'[' | b'(' | b'{' => {
                    let control = c == b'['
                        && re!(r"(?:^|[^A-Za-z0-9_.])(?:if|while|do)\s*$|\$\s*$")
                            .is_match(&text[..i]);
                    stack.push((i, 0, control));
                }
                b']' | b')' | b'}' => {
                    stack.pop();
                }
                b';' => match stack.last_mut() {
                    Some(top) => top.1 += 1,
                    None => seq += 1,
                },
                b'\n' if stack.is_empty() => seq += 1,
                _ => {}
            }
        }
        (seq, stack)
    };
    let (read_seq, read_path) = path(read);
    let (assign_seq, assign_path) = path(assign);
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
        re!(r"\b(?:select|exec|update|delete)\b").find(std::str::from_utf8(&out[i..]).unwrap_or(""))
    {
        let start = i + m.start();
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
fn shape(s: &str) -> Option<usize> {
    let s = s.trim();
    if re!(r"\n\S").is_match(s) {
        return None;
    }
    if s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len()) {
        // `(1;2;3)` is a three-item list, however its items are shaped, and
        // `(1 2 3)` is the same vector as without the parentheses. Only a
        // top-level `;` makes a list; so count those.
        let inner = &s[1..s.len() - 1];
        let items = crate::slots(inner);
        if items.len() > 1 {
            return Some(items.len());
        }
        return shape(inner);
    }
    if let Some(rest) = s.strip_prefix("enlist ") {
        return shape(rest).map(|_| 1);
    }
    // A byte vector: `0x` and an even run of hex digits, two per item. With
    // exactly two it is an atom, which `Shape` reports as a one-item vector
    // the way a lone number is - the length check treats both alike.
    if let Some(hex) = s.strip_prefix("0x")
        && !hex.is_empty()
        && hex.len() % 2 == 0
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Some(hex.len() / 2);
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
            } else if b == b'\n' && depth == 0 && !code[end + 1..].starts_with([' ', '\t', '\n']) {
                // An unindented next line starts a new top-level expression.
                // Indented continuations (including masked comments) still
                // belong to this literal, even when they start after `!`.
                break;
            }
            end += 1;
        }
        if let (Some(keys), Some(values)) = (shape(&m[1]), shape(&code[start.end()..end]))
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
    // `` `a`b=`a`b`c `` alike. `,` joins anything and is not in the set. A
    // `-` with space before and none after is a negative literal rather than
    // the operator (`1 2 3 -1 2` is one five-vector), and is skipped.
    // An operand is a symbol vector, a numeric vector, a byte vector with at
    // least two items, or a parenthesised list. `shape` decides the length of
    // each; this pattern only has to find them.
    for m in re!(
        r"(?P<l>(?:`[A-Za-z0-9_.]*){2,}|-?\d[\w.]*(?:\s+-?\d[\w.]*)+|0x(?:[0-9a-fA-F]{2}){2,}|\([^()]*;[^()]*\))\s*(?P<op><>|<=|>=|[+*%&|=<>-])\s*(?P<r>(?:`[A-Za-z0-9_.]*){2,}|-?\d[\w.]*(?:\s+-?\d[\w.]*)+|0x(?:[0-9a-fA-F]{2}){2,}|\([^()]*;[^()]*\))"
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
    // Dynamic evaluation is where the global-name checks stop being
    // reliable: `\l`, `eval`, `system "l ..."` and `value` on a string can
    // all define globals this file never spells out, and QF005, QF010 and
    // QT002 would report a name as undefined that is not. That limit is
    // worth a finding of its own, so a reader knows the silence after it is
    // a skipped analysis, not a clean one. It is only those checks that are
    // skipped: the local-scope rule QF014 does not depend on what globals
    // exist, and runs regardless. Nor is every `value` dynamic - `value d`
    // reads a dictionary and `value f` decomposes a lambda; only a string
    // in the statement makes it evaluation. And `` `name set v `` defines
    // a name the file does spell out: it counts as an assignment below
    // rather than as a reason to stop.
    let mut dynamic = re!(r"(?m)^\\l\b")
        .find(code)
        .map(|m| (m.start(), "\\l".to_string()));
    if dynamic.is_none() {
        dynamic = re!(r"\b(?:eval|value|system)\b")
            .find_iter(code)
            .filter(|m| boundary(code, m.start()))
            .find(|m| {
                let rest = &raw[m.end()..];
                let statement = &rest[..rest.find([';', '\n']).unwrap_or(rest.len())];
                match m.as_str() {
                    "eval" => true,
                    "value" => statement.contains('"'),
                    _ => re!(r#"^\s*"[ld]\b"#).is_match(statement),
                }
            })
            .map(|m| (m.start(), m.as_str().to_string()));
    }
    // The file using `value` or `eval` still turns the undefined-global checks
    // off - it just is not a finding. Nothing is wrong with the line, and a
    // warning on every file that builds a query dynamically buries the ones
    // that mean something. What the linter did not check belongs in a report
    // about the run, not in the margin next to working code.
    let dynamic = dynamic.is_some();
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
            direct[child.start - scope.body..child.end + 1 - scope.body].fill(b' ');
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
        locals.extend(multi_assignments(&direct).map(|(_, n)| n.to_string()));
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
    for m in re!(r"`(\.?[A-Za-z][A-Za-z0-9_.]*)\s+set\b").captures_iter(code) {
        let whole = m.get(0).unwrap();
        globals
            .entry(qualify(&m[1], ns_at(whole.start())))
            .or_default()
            .push(whole.end());
    }
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
            .filter(|s| s.params.len() == 1)
            && let Some(m)=re!(r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*[+*%\-]\s*-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[bhijef]?\s*;?\s*$").captures(&scope.direct)
                && scope.params.contains(&m[1]) {numeric.insert(name.clone());}
    }
    for call in re!(r"(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\[\s*`[A-Za-z][A-Za-z0-9_.]*\s*\]").captures_iter(code) {
        if dynamic {break;}
        let at=call.get(0).unwrap().start();let name=&call[1];if !boundary(code,at){continue;}
        if scope_at(&scopes,at).is_some_and(|s|scopes[s].locals.contains(name)){continue;}
        if numeric.contains(&qualify(name,ns_at(at))) {out.push(Finding::at(path, raw, at,"QT002",format!("Symbol literal passed to numeric function {name}")));}
    }
    // An assignment anywhere in a lambda body makes the name local for the
    // whole body, including the statements above it - so a read that q runs
    // before the first assignment finds an unset local, never the global,
    // and throws the name. Verified: `{r:cfg; cfg:1; r}[]` is 'cfg,
    // `{if[a;a:1]}[]` is 'a. What "before" means is `runs_before`'s
    // business: within one statement q evaluates right to left, so
    // `x#a where (a:...)` assigns first and is fine. A column in a table
    // literal is not an assignment, and column names inside a query resolve
    // to the table first, so both are out of scope here.
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
        let mut first: HashMap<&str, usize> = HashMap::new();
        for a in assignment.captures_iter(&direct) {
            let m = a.get(0).unwrap();
            if boundary(&direct, m.start()) && a.get(2).is_none() && !a[1].contains('.') {
                let name = a.get(1).unwrap().as_str();
                first.entry(name).or_insert(m.start());
            }
        }
        for (at, name) in multi_assignments(&direct) {
            let entry = first.entry(name).or_insert(at);
            *entry = (*entry).min(at);
        }
        let mut seen = HashSet::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&direct) {
            let name = m.as_str();
            let after = direct[m.end()..].trim_start();
            let Some(&assigned) = first.get(name) else {
                continue;
            };
            if m.start() >= assigned
                || scope.params.contains(name)
                || !boundary(&direct, m.start())
                || after.starts_with(':')
                || after.starts_with('.')
                || !runs_before(&direct, m.start(), assigned)
                || !seen.insert(name)
            {
                continue;
            }
            out.push(Finding::at(
                path,
                raw,
                scope.body + m.start(),
                "QF014",
                format!(
                    "`{name}` is read here but assigned in a later statement, which makes it \
                     local throughout: this read finds an unset local and throws '{name}"
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
        // does not count as one either.
        let body = re!(r"`[A-Za-z0-9_./:]*")
            .replace_all(&code[scope.body..scope.end], |m: &regex::Captures| {
                " ".repeat(m[0].len())
            });
        let mut mentioned: HashSet<&str> = HashSet::new();
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&body) {
            if boundary(&body, m.start()) && !body[m.end()..].starts_with('.') {
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
                out.push(Finding::at(
                    path,
                    raw,
                    scope.start,
                    "QF016",
                    format!("Parameter `{param}` is never read; the caller still has to pass it"),
                ));
            }
        }
    }
    // The other half of the same guidance: "avoid using these letters as local
    // variables" when the parameters are named. `{[a;b] x:a+b; ...}` works,
    // but `x` in a q body means the first argument to every reader who has not
    // yet looked at the signature.
    for scope in &scopes {
        if !scope.named || scope.params.iter().any(|p| matches!(&**p, "x" | "y" | "z")) {
            continue;
        }
        let statements = statement_view(&scope.direct);
        for a in assignment.captures_iter(&statements) {
            let whole = a.get(0).unwrap();
            if !boundary(&statements, whole.start()) || a.get(2).is_some() {
                continue;
            }
            if matches!(&a[1], "x" | "y" | "z") {
                out.push(Finding::at(
                    path,
                    raw,
                    scope.body + whole.start(),
                    "QS009",
                    format!(
                        "`{}` is a local here, but in a q body it reads as an implicit argument",
                        &a[1]
                    ),
                ));
            }
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
    for scope in &scopes {
        let lines = code[scope.start..scope.end].matches('\n').count() + 1;
        if lines > 25 {
            out.push(Finding::at(
                path,
                raw,
                scope.start,
                "QS006",
                format!("This lambda is {lines} lines; over twenty five is hard to hold in mind"),
            ));
        }
    }
    // A local assigned and never read, and a parameter the body reassigns.
    //
    // `direct` is the body with nested lambdas blanked, which is what these
    // want: a name assigned in this lambda and read only by an inner one is
    // not read at all, because q will not let the inner one see it.
    for scope in &scopes {
        let direct = re!(r"`[A-Za-z0-9_./:]*")
            .replace_all(&scope.direct, |m: &regex::Captures| " ".repeat(m[0].len()));
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
        let mut read: HashSet<&str> = HashSet::new();
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
            if !read.contains(*name) && !re!(r"(?i)^(?:unused|ignored?|dummy)").is_match(name) {
                out.push(Finding::at(
                    path,
                    raw,
                    scope.body + at,
                    "QF017",
                    format!("Local `{name}` is assigned and never read"),
                ));
            }
        }
    }
    // A declared signature takes the implicit arguments out of scope: `x` in
    // `{[a] x+1}` is not an argument, it is a global, and q throws 'x when
    // there is none. Only a name this file never assigns globally is reported,
    // since the global may legitimately live in another file.
    for scope in &scopes {
        if dynamic
            || !scope.named
            || re!(r"\b(?:select|exec|update|delete)\b").is_match(&scope.direct)
        {
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
        if dynamic
            || scope.parent.is_none()
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
            out.push(Finding::at(
                path,
                raw,
                scope.body + m.start(),
                "QF005",
                format!("Nested lambda references enclosing local '{name}' without a parameter"),
            ));
        }
    }
    out
}
