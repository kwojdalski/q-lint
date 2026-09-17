//! Offline q analysis. Unknown expressions are deliberately left unresolved.
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

macro_rules! re {
    ($pattern:expr) => {{
        static RE: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($pattern).unwrap());
        &*RE
    }};
}
mod semantics;

#[derive(Debug, Deserialize, Serialize)]
pub struct Rule {
    pub code: String,
    pub name: String,
    pub category: String,
    pub summary: String,
    pub scope: String,
}
pub static RULES: LazyLock<Vec<Rule>> =
    LazyLock::new(|| serde_json::from_str(include_str!("taxonomy.json")).unwrap());
static RESERVED: LazyLock<Vec<String>> =
    LazyLock::new(|| serde_json::from_str(include_str!("reserved.json")).unwrap());

#[derive(Debug, Serialize)]
pub struct Finding {
    pub path: String,
    pub line: usize,
    pub rule: String,
    pub detail: String,
    pub why: String,
    pub source: String,
    pub severity: String,
    pub column: Option<usize>,
    pub end_line: Option<usize>,
    pub end_column: Option<usize>,
    pub code: String,
    pub category: String,
}
impl Finding {
    pub fn new(path: &str, line: usize, code: &str, detail: String) -> Self {
        let rule = RULES
            .iter()
            .find(|r| r.code == code)
            .expect("registered rule");
        Self {
            path: path.into(),
            line,
            rule: rule.name.clone(),
            detail,
            why: rule.summary.clone(),
            source: "q-lint".into(),
            severity: if matches!(
                code,
                "QE001"
                    | "QE003"
                    | "QA001"
                    | "QA002"
                    | "QA005"
                    | "QA006"
                    | "QT001"
                    | "QT002"
                    | "QT003"
                    | "QB005"
                    | "QB007"
                    | "QB008"
                    | "QF012"
            ) {
                "error"
            } else {
                "warning"
            }
            .into(),
            column: None,
            end_line: None,
            end_column: None,
            code: rule.code.clone(),
            category: rule.category.clone(),
        }
    }
}
fn line_at(s: &str, at: usize) -> usize {
    s.as_bytes()[..at].iter().filter(|&&b| b == b'\n').count() + 1
}
fn boundary(s: &str, at: usize) -> bool {
    s[..at]
        .chars()
        .next_back()
        .is_none_or(|c| !c.is_alphanumeric() && !"_.`".contains(c))
}
fn blank(b: &mut [u8]) {
    for c in b {
        if !matches!(*c, b'\n' | b'\r') {
            *c = b' ';
        }
    }
}
/// Whether a top-level statement mixes `*`/`%` with a binary `+`/`-` - the
/// pair whose right-to-left order readers most often get wrong. A `-` is
/// binary only when it does not introduce a token: `a -b` is the list
/// `(a; -b)`, while `a-b`, `a- b` and `a - b` are subtraction. Braces and
/// `;` start fresh statements rather than nesting, so a lambda body on one
/// line is still checked.
/// A filter phrase with parenthesised groups blanked out. The questions the
/// filter rules ask - which operators sit beside which - are about the
/// top level only, and `(a=1) and b=0` is correct q that must stay quiet.
fn flat_filter(phrase: &str) -> String {
    let b = phrase.as_bytes();
    let mut flat = b.to_vec();
    let (mut depth, mut i) = (0i32, 0usize);
    while i < b.len() {
        match b[i] {
            b'(' | b'[' => {
                depth += 1;
                flat[i] = b' ';
            }
            b')' | b']' => {
                depth -= 1;
                flat[i] = b' ';
            }
            _ if depth > 0 => flat[i] = b' ',
            _ => {}
        }
        i += 1;
    }
    String::from_utf8(flat).unwrap()
}
fn mixed_infix(line: &str) -> bool {
    let b = line.as_bytes();
    let (mut mul, mut add) = (false, false);
    let (mut depth, mut prev) = (0i32, b'\0');
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'{' | b'}' | b';' => {
                mul = false;
                add = false;
            }
            b',' if depth == 0 => {
                mul = false;
                add = false;
            }
            b'*' | b'%' if depth == 0 => mul = true,
            b'+' | b'-' if depth == 0 => {
                let operand = matches!(
                    prev,
                    b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b')' | b']' | b'.'
                );
                let introduces = c == b'-'
                    && prev == b' '
                    && b.get(i + 1).is_some_and(|&n| !n.is_ascii_whitespace());
                if operand && !introduces {
                    add = true;
                }
            }
            _ => {}
        }
        if !c.is_ascii_whitespace() {
            prev = c;
        }
    }
    mul && add
}
struct Views {
    comments: String,
    code: String,
    unterminated: Option<usize>,
    foreign_offsets: Vec<usize>,
    /// Where a `/`-opened block comment that no later `\` closed began. The
    /// lines after it are blank in both views, so no rule sees them; this is
    /// the only trace that they were swallowed at all.
    open_block: Option<usize>,
}
fn views(source: &str) -> Views {
    let bytes = source.as_bytes();
    let mut comments = bytes.to_vec();
    let mut code = bytes.to_vec();
    let (mut string, mut block, mut ended, mut offset) = (None, false, false, 0);
    let mut foreign = false;
    let mut foreign_offsets = Vec::new();
    let mut open_block = None;
    for line in source.split_inclusive('\n') {
        let end = offset + line.len();
        let stripped = line.trim_end_matches(['\r', '\n', ' ', '\t']);
        if foreign && !(line.starts_with([' ', '\t']) || stripped.is_empty()) {
            foreign = false;
        }
        if !ended && !block && string.is_none() {
            if line.starts_with("p)") || line.starts_with("k)") {
                foreign = true;
            }
            if foreign {
                blank(&mut comments[offset..end]);
                blank(&mut code[offset..end]);
                foreign_offsets.push(offset);
                offset = end;
                continue;
            }
        }
        let prefix = if string.is_none() && line.starts_with("q)") {
            2
        } else {
            0
        };
        if ended || block {
            blank(&mut comments[offset..end]);
            blank(&mut code[offset..end]);
            if block && stripped == "\\" {
                block = false;
                open_block = None;
            }
        } else if string.is_none() && matches!(stripped, "/" | "\\") {
            block = stripped == "/";
            ended = stripped == "\\";
            if block {
                open_block = Some(offset);
            }
            blank(&mut comments[offset..end]);
            blank(&mut code[offset..end]);
        } else if !(string.is_none() && line.starts_with('\\')) {
            blank(&mut comments[offset..offset + prefix]);
            blank(&mut code[offset..offset + prefix]);
            let mut i = offset + prefix;
            while i < end {
                let c = bytes[i];
                if string.is_some() {
                    blank(&mut code[i..i + 1]);
                    if c == b'\\' && i + 1 < end {
                        blank(&mut code[i + 1..i + 2]);
                        i += 2;
                        continue;
                    }
                    if c == b'"' {
                        string = None;
                    }
                } else if c == b'"' {
                    string = Some(i);
                    code[i] = b' ';
                } else if c == b'/'
                    && (i == offset + prefix
                        || source[..i]
                            .chars()
                            .next_back()
                            .is_some_and(char::is_whitespace))
                {
                    blank(&mut comments[i..end]);
                    blank(&mut code[i..end]);
                    break;
                }
                i += 1;
            }
        }
        offset = end;
    }
    Views {
        comments: String::from_utf8(comments).unwrap(),
        code: String::from_utf8(code).unwrap(),
        unterminated: string,
        foreign_offsets,
        open_block,
    }
}
fn matching(s: &str, start: usize, open: u8, close: u8) -> Option<usize> {
    let b = s.as_bytes();
    let (mut i, mut depth) = (start, 0usize);
    while i < b.len() {
        if b[i] == b'"' {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
        } else if b[i] == open {
            depth += 1;
        } else if b[i] == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}
fn slots(s: &str) -> Vec<&str> {
    let (mut start, mut depth) = (0, 0i32);
    let mut out = vec![];
    for (i, b) in s.bytes().enumerate() {
        if b"([{ ".contains(&b) && b != b' ' {
            depth += 1;
        } else if b")]}".contains(&b) {
            depth -= 1;
        } else if b == b';' && depth == 0 {
            out.push(&s[start..i]);
            start = i + 1;
        }
    }
    out.push(&s[start..]);
    out
}
/// A lambda parameter name. `_` is absent deliberately: q reads `{[_] ...}` as
/// a body, not a signature, which is what `named` below is about.
fn is_param_name(s: &str) -> bool {
    re!(r"^\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$").is_match(s)
}

/// What q makes of the `[...]` following a `{`.
///
/// q reads those brackets as a parameter list only when every slot is a name.
/// `{[a+b] ...}`, `{[1] ...}` and `{[_] ...}` are lambdas whose *body* opens
/// with a bracket expression instead, and they take the implicit x, y and z -
/// a different rank, from source that looks like a signature. The rules here
/// and the scope tracking in `semantics` both have to agree with q about
/// which of the two a given `{` is, so they share this.
pub(crate) struct Signature<'a> {
    /// The bracket group, trimmed and split on top-level `;` - empty when
    /// there is no `[` at all.
    pub slots: Vec<&'a str>,
    /// Whether q treats `slots` as parameters rather than as body text.
    pub named: bool,
    /// Where the body starts: after `]` for a signature, after `{` otherwise.
    pub body: usize,
}
/// `code` is the masked view and `raw` the source it was masked from, at the
/// same offsets. Both are needed: a string literal is blank in `code`, and
/// `{["s"] 1}` would otherwise read as the empty parameter list it is not.
pub(crate) fn signature<'a>(code: &'a str, raw: &str, brace: usize) -> Signature<'a> {
    let implicit = |slots| Signature {
        slots,
        named: false,
        body: brace + 1,
    };
    let rest = &code[brace + 1..];
    let bracket = brace + 1 + (rest.len() - rest.trim_start().len());
    if code.as_bytes().get(bracket) != Some(&b'[') {
        return implicit(vec![]);
    }
    let Some(close) = matching(code, bracket, b'[', b']') else {
        return implicit(vec![]);
    };
    let (mut ranges, mut start, mut depth) = (vec![], bracket + 1, 0i32);
    for i in bracket + 1..close - 1 {
        let b = code.as_bytes()[i];
        if b"([{".contains(&b) {
            depth += 1;
        } else if b")]}".contains(&b) {
            depth -= 1;
        } else if b == b';' && depth == 0 {
            ranges.push((start, i));
            start = i + 1;
        }
    }
    ranges.push((start, close - 1));
    let slots: Vec<&str> = ranges.iter().map(|&(a, b)| code[a..b].trim()).collect();
    // An empty slot is still a parameter - q names it by position, so the
    // trailing `;` in `{[a;b;] ...}` is a third argument rather than nothing.
    // "Empty" has to be judged on `raw`, or a masked literal passes for one.
    let names_only = ranges.iter().zip(&slots).all(|(&(a, b), slot)| {
        (slot.is_empty() && raw[a..b].trim().is_empty()) || is_param_name(slot)
    });
    if !names_only {
        return implicit(slots);
    }
    Signature {
        slots,
        named: true,
        body: close,
    }
}
fn structure(path: &str, source: &str, v: &Views) -> Option<Finding> {
    let mut stack = vec![];
    let mut offset = 0;
    let make = |at, detail| {
        let mut f = Finding::new(path, line_at(source, at), "QE001", detail);
        let start = source[..at].rfind('\n').map_or(0, |p| p + 1);
        f.column = Some(source[start..at].encode_utf16().count() + 1);
        f
    };
    for line in v.code.split_inclusive('\n') {
        if !line.starts_with('\\') {
            for (i, c) in line.bytes().enumerate() {
                if let Some(p) = b"([{ ".iter().position(|&a| a == c).filter(|&p| p < 3) {
                    stack.push((b")]}"[p], offset + i));
                } else if b")]}".contains(&c) {
                    match stack.pop() {
                        None => {
                            return Some(make(
                                offset + i,
                                format!("Unexpected closing '{}'", c as char),
                            ));
                        }
                        Some((want, _)) if want != c => {
                            return Some(make(
                                offset + i,
                                format!("Expected '{}', got '{}'", want as char, c as char),
                            ));
                        }
                        _ => {}
                    }
                }
            }
        }
        offset += line.len();
    }
    if let Some(at) = v.unterminated {
        return Some(make(at, "Unterminated string literal".into()));
    }
    stack
        .last()
        .map(|&(c, at)| make(at, format!("Unclosed delimiter; expected '{}'", c as char)))
}

pub fn lint(source: &str, path: &str, uqf: bool) -> Vec<Finding> {
    let v = views(source);
    if let Some(f) = structure(path, source, &v) {
        return vec![f];
    }
    let code = &v.code;
    let mut out = semantics::check(path, code, source);
    if let Some(at) = v.open_block {
        out.push(Finding::new(
            path,
            line_at(code, at),
            "QE003",
            "This bare slash opens a block comment that no later backslash \
             closes, so the rest of the file is comment"
                .into(),
        ));
    }
    let mut add = |at: usize, id: &str, detail: String| {
        out.push(Finding::new(path, line_at(code, at), id, detail))
    };
    for brace in code.match_indices('{').map(|(i, _)| i) {
        let sig = signature(code, source, brace);
        let at = brace;
        if !sig.named {
            // Not a parameter list, so none of the rules below apply to it -
            // and neither does the rank the source appears to declare.
            if !sig.slots.is_empty() {
                let offenders: Vec<&str> = sig
                    .slots
                    .iter()
                    .copied()
                    .filter(|s| !s.is_empty() && !is_param_name(s))
                    .collect();
                // `_` has its own code because it has its own cause: it reads
                // as a name but is the drop operator, so q takes the brackets
                // for body text exactly as it does for any other expression.
                if offenders.contains(&"_") {
                    add(at, "QF002", "`_` as a lambda parameter".into());
                }

                let underscore = offenders.contains(&"_");
                let rest: Vec<&str> = offenders.into_iter().filter(|s| *s != "_").collect();
                // A string literal is blank by the time the rules see it, so
                // there is nothing to quote back - it is still why q refused
                // to read the brackets as a signature.
                let subject = if !rest.is_empty() {
                    format!("{rest:?} is not a parameter name")
                } else if underscore {
                    String::new()
                } else {
                    "A literal is not a parameter name".into()
                };
                if !subject.is_empty() {
                    add(
                        at,
                        "QF007",
                        format!(
                            "{subject}, so q reads these brackets as the start of the body and \
                             the lambda takes x, y and z instead"
                        ),
                    );
                }
            }
            continue;
        }
        let params: Vec<_> = sig.slots.clone();
        let bad: Vec<_> = params
            .iter()
            .filter(|p| RESERVED.iter().any(|n| n == **p))
            .collect();
        if !bad.is_empty() {
            add(at, "QF001", format!("Builtin parameter name(s): {bad:?}"));
        }
        let mut seen = std::collections::HashSet::new();
        let repeated: Vec<&&str> = params
            .iter()
            .filter(|p| !p.is_empty() && !seen.insert(**p))
            .collect();
        if !repeated.is_empty() {
            add(
                at,
                "QF008",
                format!("Parameter {repeated:?} is declared more than once"),
            );
        }
        // `{[] ...}` is the one empty slot that means what it looks like.
        if params.len() > 1 && params.iter().any(|p| p.is_empty()) {
            add(
                at,
                "QF009",
                format!(
                    "An empty slot in the parameter list is still a parameter, so this lambda \
                     takes {} arguments",
                    params.len()
                ),
            );
        }
        if params.len() > 8 {
            add(
                at,
                "QA001",
                format!(
                    "Lambda declares {} parameters; q allows at most 8",
                    params.len()
                ),
            );
        }
        if let Some(end) = matching(code, at, b'{', b'}') {
            let rest = code[end..].trim_start_matches([' ', '\t']);
            if rest.starts_with('[') {
                let open = code.len() - rest.len();
                if let Some(close) = matching(code, open, b'[', b']') {
                    let arity = if params.iter().all(|p| p.is_empty()) {
                        0
                    } else {
                        params.len()
                    };
                    let count = slots(&code[open + 1..close - 1]).len();
                    if arity <= 8 && count > arity.max(1) {
                        add(
                            open,
                            "QA002",
                            format!(
                                "{count} argument slots applied to a {arity}-parameter literal lambda"
                            ),
                        );
                    }
                }
            }
            // `each` supplies one argument, so a rank-2-or-more lambda
            // applied under it does not run: it returns projections, which
            // are silently wrong data rather than an error.
            let arity = if params.iter().all(|p| p.is_empty()) {
                0
            } else {
                params.len()
            };
            let rest = code[end..].trim_start();
            if arity >= 2 && re!(r"\Aeach\b").is_match(rest) {
                add(
                    end,
                    "QA005",
                    format!(
                        "`each` supplies one argument to a {arity}-parameter lambda, so the \
                         results are projections, not values"
                    ),
                );
            }
        }
    }
    for m in re!(r"@\[\s*\{\s*\[([^\]]*)\]").captures_iter(code) {
        let at = m.get(0).unwrap().start();
        let arity = m[1].split(';').filter(|p| !p.trim().is_empty()).count();
        let brace = at + code[at..].find('{').unwrap();
        if let Some(end) = matching(code, brace, b'{', b'}') {
            let rest = code[end..].trim_start();
            let open = code.len() - rest.len();
            let mut supplied = 0;
            if rest.starts_with('[')
                && let Some(close) = matching(code, open, b'[', b']')
            {
                supplied = slots(&code[open + 1..close - 1])
                    .iter()
                    .filter(|s| !s.trim().is_empty())
                    .count();
            }
            if arity.saturating_sub(supplied) >= 2 {
                add(
                    at,
                    "QA003",
                    format!(
                        "Protected unary apply has {} unbound parameters",
                        arity - supplied
                    ),
                );
            }
        }
    }
    // Binary builtins under `each`: verified against q - `cor each 1 2 3`
    // returns `cor[1;] cor[2;] cor[3;]`, not values. `dev` is unary and
    // absent from this list for that reason; additions must be verified
    // against the runtime, not assumed.
    for m in re!(r"\b(cor|cov|wsum|within|mavg|msum|mmax|mmin|mdev|mcount|cross|bin|binr)\s+each\b")
        .captures_iter(code)
    {
        let at = m.get(0).unwrap().start();
        add(
            at,
            "QA005",
            format!(
                "`{}` is binary, so `{} each` yields projections, not values",
                &m[1], &m[1]
            ),
        );
    }
    // `$[c;a]`: one slot is a projection and three or more are conditional
    // expressions, but exactly two is an error q raises only at runtime.
    for (dollar, _) in code.match_indices("$[") {
        let Some(close) = matching(code, dollar + 1, b'[', b']') else {
            continue;
        };
        if slots(&code[dollar + 2..close - 1]).len() == 2 {
            add(
                dollar,
                "QA006",
                "Two-slot $[ ... ] is no conditional q defines; it errors 'nyi' at runtime".into(),
            );
        }
    }
    // Symbols take no arithmetic: `2+`a`, `` `a*2 `` and `2%`b` are all
    // 'type errors, and chars pairing with numbers ("a"*3 is 291) are not,
    // so the rule is a symbol literal next to an infix + - * % and nothing
    // more.
    for m in re!(r"(?:`[A-Za-z][A-Za-z0-9_.]*)+\s*[+\-*%]|[+\-*%]\s*(?:`[A-Za-z][A-Za-z0-9_.]*)+")
        .find_iter(code)
    {
        let at = m.start();
        // `like `a*` is a glob, not a product; QB007 owns that one.
        if code[..at].trim_end().ends_with("like") {
            continue;
        }
        add(
            at,
            "QT003",
            "Arithmetic on a symbol literal is a 'type error at runtime".into(),
        );
    }
    // like's pattern is a string; a symbol literal is the obvious spelling
    // of one and a guaranteed 'type error at runtime.
    for m in re!(r"\blike\s*`").find_iter(code) {
        add(
            m.start(),
            "QB007",
            "like needs a string pattern; a symbol literal is a 'type error at runtime".into(),
        );
    }
    // A table literal's column named for a builtin: `([] first:1 2)` parses,
    // but in a where phrase q resolves the bare name as the function, so
    // `where first>1` is a 'type error and `select first from t` returns
    // something that is not the column. The definition is the only place
    // to say so.
    for (at, _) in code.match_indices("([]") {
        let Some(close) = matching(code, at, b'(', b')') else {
            continue;
        };
        let inner = &code[at + 3..close.saturating_sub(1)];
        let mut pos = at + 3;
        for part in inner.split(';') {
            let trimmed = part.trim_start();
            let lead = part.len() - trimmed.len();
            if let Some(m) = re!(r"^([A-Za-z][A-Za-z0-9_]*)\s*:").captures(trimmed)
                && RESERVED.iter().any(|n| n == &m[1])
            {
                add(
                    pos + lead,
                    "QF013",
                    format!(
                        "Column `{}` is a builtin name: in a filter q resolves the bare name \
                         as the function, and the column is unreachable",
                        &m[1]
                    ),
                );
            }
            pos += part.len() + 1;
        }
    }
    // Match the Python rule's outer-body traversal, including nested assignments.
    for (at, _) in code.match_indices('{') {
        if code[..at].rfind('}') < code[..at].rfind('{') {
            continue;
        }
        if let Some(end) = matching(code, at, b'{', b'}') {
            let mut offset = at;
            for line in code[at..end].split_inclusive('\n') {
                if !re!(r"\b(?:select|exec|update|delete|by)\b").is_match(line) {
                    for a in re!(r"([a-z][a-z0-9_]*)\s*:").captures_iter(line) {
                        let m = a.get(0).unwrap();
                        if boundary(line, m.start())
                            && !line[m.end()..].starts_with(':')
                            && RESERVED.iter().any(|n| n == &a[1])
                        {
                            add(
                                offset + m.start(),
                                "QF003",
                                format!("Local assignment to `{}`", &a[1]),
                            );
                        }
                    }
                }
                offset += line.len();
            }
        }
    }
    let mut namespace = false;
    let mut ns_open: Option<usize> = None;
    let mut depth = 0i32;
    let mut offset = 0;
    for ((raw, line), literals) in source
        .split_inclusive('\n')
        .zip(code.split_inclusive('\n'))
        .zip(v.comments.split_inclusive('\n'))
    {
        let line_depth = depth;
        for c in line.bytes() {
            if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                depth -= 1;
            }
        }
        if uqf && raw.trim() == "/" && !v.foreign_offsets.contains(&offset) {
            add(offset, "QP001", "Bare slash opens a block comment".into());
        }
        if line.trim().starts_with("\\d ") {
            namespace = line.trim() != "\\d .";
            // Point at the directive that is still in force at EOF, so the
            // finding names the namespace the file actually ends in.
            ns_open = namespace.then_some(offset);
            offset += line.len();
            continue;
        }
        if line.trim_start().starts_with('\\') {
            offset += line.len();
            continue;
        }
        if namespace
            && let Some(m) = re!(r"^([a-z][a-zA-Z0-9_]*)\s*:").captures(line)
            && RESERVED.iter().any(|n| n == &m[1])
        {
            add(offset, "QF004", format!("Namespace-level `{}`", &m[1]));
        }
        // The root is where q is inconsistent about reserved names:
        // `count:1` and `where:1` it refuses ('assign), `select:1` it
        // cannot parse, but `from:1` and `by:1` it silently accepts. A
        // lambda body at column 0 must not be mistaken for root scope,
        // hence the brace depth.
        if !namespace
            && line_depth == 0
            && let Some(m) = re!(r"^([a-z][a-zA-Z0-9_]*)\s*:").captures(line)
            && !line[m.get(0).unwrap().end()..].starts_with(':')
            && RESERVED.iter().any(|n| n == &m[1])
        {
            add(
                offset,
                "QF012",
                format!(
                    "Root-level assignment to `{}`: q refuses some reserved names outright and \
                     silently accepts the rest",
                    &m[1]
                ),
            );
        }
        if re!(r"\.\s*\(\s*\)").is_match(line) {
            add(offset, "QA004", "`. ()`".into());
        }
        if re!(r"\b(?:where|select|exec|update|delete)\b").is_match(line) {
            let mut search = 0;
            while let Some(m) =
                re!(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|~)\s*([a-zA-Z_][a-zA-Z0-9_]*)\b")
                    .captures_at(line, search)
            {
                if m[1] == m[3] {
                    add(offset, "QB001", format!("`{}{}{}`", &m[1], &m[2], &m[3]));
                    search = m.get(0).unwrap().end();
                } else {
                    search = m.get(3).unwrap().start();
                }
            }
            // `~` matches whole operands, so a filter gets one boolean for
            // the entire table where it wanted one per row: a 'type error
            // against a column, or worse, a single-row result against a
            // scalar. `~/:` and `~\:` supply the row-wise forms and are
            // left alone, which the trailing character class encodes: any
            // next byte that is not those two slash forms is the trap.
            for m in re!(r"~[^/\\]").find_iter(line) {
                add(
                    offset + m.start(),
                    "QB005",
                    "Match (`~`) in a filter compares whole operands, not rows".into(),
                );
            }
            if let Some(w) = re!(r"\bwhere\b").find(line) {
                let phrase = flat_filter(&line[w.end()..]);
                // q gives every infix the same precedence, so `a=1 and b=0`
                // reads as `a=(1 and b=0)` - the comparison eats the logic,
                // and the rows that come back are quietly the wrong ones.
                // Only a comparison to the LEFT of an and/or is the trap:
                // `x and b=0` is fine, because the comparison is the
                // logical's right operand and nothing is left to consume.
                // Parenthesising either side is the fix, and the blanking
                // in `flat_filter` is what recognises it.
                if let Some(logic) = re!(r"\b(?:and|or)\b").find(&phrase)
                    && re!(r"[<>=]").is_match(&phrase[..logic.start()])
                {
                    add(
                        offset + w.start(),
                        "QB006",
                        "Comparison left of and/or without parentheses: right-to-left \
                         evaluation reads this as `a=(1 and b=0)`, not `(a=1) and b=0`"
                            .into(),
                    );
                }
                // A column equals one value; against a vector literal the
                // phrase is a length error at runtime, and `in` is the
                // operator that was meant.
                if re!(r"(?:=|<>)\s*(?:-?\d[\w.]*\s+-?\d|`[A-Za-z][A-Za-z0-9_.]*`)")
                    .is_match(&phrase)
                {
                    add(
                        offset + w.start(),
                        "QB008",
                        "Equality against a vector literal in a filter is a 'length error at \
                         runtime; `in` is the operator for membership"
                            .into(),
                    );
                }
            }
            // Under `by`, a column nobody aggregates takes the last value
            // of its group - not the first, and nothing says which. The
            // rule is deliberately narrow: only a select phrase that is
            // empty or made of bare (possibly aliased) column names, so
            // `sum px`, `avg[px]` and `.my.agg px` all count as having
            // said the aggregation out loud.
            if let Some(m) = re!(r"\bselect\b(.*?)\bby\b").captures(line) {
                let phrase = m[1].trim();
                let plain = phrase.is_empty()
                    || phrase.split(',').all(|col| {
                        re!(r"^(?:[A-Za-z][A-Za-z0-9_]*\s*:\s*)?[A-Za-z][A-Za-z0-9_]*$")
                            .is_match(col.trim())
                    });
                if plain {
                    add(
                        offset,
                        "QB009",
                        "Bare column under `by` takes the last row of each group; say the \
                         aggregation (`first`, or another) out loud"
                            .into(),
                    );
                }
            }
        }
        if uqf && !path.starts_with("tests/") {
            for regex in [
                re!(r#""z"\s*\$"#),
                re!(r"`datetime\s*\$"),
                re!(r"\b15h\s*\$"),
                re!(r"(?:^|[^\w.])-?0[NW]z\b"),
                re!(r"\b\d{4}\.\d{2}\.\d{2}T\d"),
            ] {
                if regex.is_match(literals) {
                    add(offset, "QP002", "Legacy datetime value or cast".into());
                }
            }
            if let Some(m) = re!(r"\.z\.[PTN]\b").find(literals) {
                let utc: String = m
                    .as_str()
                    .chars()
                    .map(|c| match c {
                        'P' | 'T' | 'N' => c.to_ascii_lowercase(),
                        _ => c,
                    })
                    .collect();
                add(
                    offset,
                    "QP003",
                    format!(
                        "`{}` is the local wall clock; the convention is UTC `{}`",
                        m.as_str(),
                        utc
                    ),
                );
            }
            if mixed_infix(line) {
                add(
                    offset,
                    "QP005",
                    "`*` or `%` mixed with `+` or `-` without parentheses: q evaluates \
                     right-to-left, and the line does not say which order was meant"
                        .into(),
                );
            }
        }
        for m in re!(r#"\blike\s*"([^"]*)""#).captures_iter(literals) {
            let pat = &m[1];
            let core = pat.strip_prefix('*').unwrap_or(pat);
            let core = core.strip_suffix('*').unwrap_or(core);
            if core.contains('*') {
                add(offset, "QB002", format!("like {pat:?}"));
            }
        }
        for m in
            re!(r#"\s*"[^"]*"\s+sv\s+string\s+[A-Za-z_][A-Za-z0-9_.]*\s*,"#).find_iter(literals)
        {
            if !literals[..m.start()].ends_with('(') || m.as_str().starts_with(char::is_whitespace)
            {
                add(offset, "QB003", m.as_str().trim().into());
            }
        }
        let b = literals.as_bytes();
        let (mut i, mut inside) = (0, false);
        while i < b.len() {
            if b[i] == b'"' {
                inside = !inside;
                i += 1;
                continue;
            }
            if !inside || b[i] != b'\\' {
                i += 1;
                continue;
            }
            if b.get(i + 1).is_some_and(|c| b"\\\"nrt".contains(c)) {
                i += 2;
                continue;
            }
            if i + 3 < b.len()
                && b"0123".contains(&b[i + 1])
                && b[i + 1..i + 4].iter().all(|c| b"01234567".contains(c))
            {
                i += 4;
                continue;
            }
            add(
                offset,
                "QE002",
                format!(
                    "Invalid escape {}",
                    String::from_utf8_lossy(&b[i..(i + 2).min(b.len())])
                ),
            );
            i += 2;
        }
        offset += line.len();
    }
    if let Some(at) = ns_open {
        add(
            at,
            "QF011",
            "The file ends inside this namespace; a trailing `\\d .` restores the root".into(),
        );
    }
    let chars: Vec<_> = v.comments.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].1 == '"' {
            i += 1;
            while i < chars.len() && chars[i].1 != '"' {
                i += if chars[i].1 == '\\' { 2 } else { 1 };
            }
        } else if chars[i].1 == '\'' && chars.get(i + 1).is_some_and(|c| c.1 == '"') {
            let (mut j, mut depth, mut length) = (i + 1, 0usize, 0);
            while j < chars.len() {
                let c = chars[j].1;
                if c == '"' {
                    j += 1;
                    while j < chars.len() && chars[j].1 != '"' {
                        if chars[j].1 == '\\' {
                            j += 1;
                        }
                        length += 1;
                        j += 1;
                    }
                } else if "([{ ".contains(c) && c != ' ' {
                    depth += 1;
                } else if ")]}".contains(c) {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                } else if c == ';' && depth == 0 {
                    break;
                }
                j += 1;
            }
            if length > 200 {
                add(
                    chars[i].0,
                    "QB004",
                    format!("Thrown message with {length} chars of literal text"),
                );
            }
        }
        i += 1;
    }
    out.sort_by(|a, b| {
        (&a.path, a.line, &a.rule, &a.detail).cmp(&(&b.path, b.line, &b.rule, &b.detail))
    });
    out
}
