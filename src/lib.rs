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
            severity: if matches!(code, "QE001" | "QA001" | "QA002" | "QT001" | "QT002") {
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
struct Views {
    comments: String,
    code: String,
    unterminated: Option<usize>,
    foreign_offsets: Vec<usize>,
}
fn views(source: &str) -> Views {
    let bytes = source.as_bytes();
    let mut comments = bytes.to_vec();
    let mut code = bytes.to_vec();
    let (mut string, mut block, mut ended, mut offset) = (None, false, false, 0);
    let mut foreign = false;
    let mut foreign_offsets = Vec::new();
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
            }
        } else if string.is_none() && matches!(stripped, "/" | "\\") {
            block = stripped == "/";
            ended = stripped == "\\";
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
    let mut offset = 0;
    for ((raw, line), literals) in source
        .split_inclusive('\n')
        .zip(code.split_inclusive('\n'))
        .zip(v.comments.split_inclusive('\n'))
    {
        if uqf && raw.trim() == "/" && !v.foreign_offsets.contains(&offset) {
            add(offset, "QP001", "Bare slash opens a block comment".into());
        }
        if line.trim().starts_with("\\d ") {
            namespace = line.trim() != "\\d .";
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
