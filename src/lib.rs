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
mod intrinsics;
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
                    | "QE004"
                    | "QF014"
                    | "QF015"
                    | "QA009"
                    | "QT004"
                    | "QT005"
                    | "QT006"
                    | "QT007"
                    | "QB013"
                    | "QB014"
                    | "QB015"
                    | "QB016"
                    | "QA010"
                    | "QT008"
                    | "QT009"
                    | "QT010"
                    | "QT011"
                    | "QT012"
                    | "QT013"
                    | "QT014"
                    | "QT016"
                    | "QT017"
                    | "QT018"
                    | "QT019"
                    | "QD001"
                    | "QD002"
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
impl Finding {
    /// A finding at byte offset `at` of `source`, with its line and column.
    /// The column is what an editor wants: 1-based, in UTF-16 units, and at
    /// the first non-blank character when `at` is the start of a line - a
    /// rule that reports a line reports the statement on it, not the
    /// indentation before it.
    pub fn at(path: &str, source: &str, at: usize, code: &str, detail: String) -> Self {
        let at = at + source[at..].len() - source[at..].trim_start_matches([' ', '\t']).len();
        let start = source[..at].rfind('\n').map_or(0, |p| p + 1);
        let mut f = Self::new(path, line_at(source, at), code, detail);
        f.column = Some(source[start..at].encode_utf16().count() + 1);
        f
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
/// A filter phrase with parenthesised groups blanked out. The questions the
/// filter rules ask - which operators sit beside which - are about the
/// top level only, and `(a=1) and b=0` is correct q that must stay quiet.
pub(crate) fn flat_filter(phrase: &str) -> String {
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
/// Whether a top-level statement mixes `*`/`%` with a binary `+`/`-` - the
/// pair whose right-to-left order readers most often get wrong. A `-` is
/// binary only when it does not introduce a token: `a -b` applies `a` to
/// `-b`, while `a-b`, `a- b` and `a - b` are subtraction. Braces and `;`
/// start fresh statements rather than nesting, so a lambda body on one line
/// is still checked.
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
    let make = |at, detail| Finding::at(path, source, at, "QE001", detail);
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

/// Which rules a run is asking for.
///
/// The default answers only one question - would q refuse this? - because
/// that is the answer a linter can give without arguing about taste. A rule
/// that fires on source q accepts and runs is describing a habit, not a
/// defect, and lives a profile up.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Profile {
    /// Only what q rejects: a parse error, or an error the moment it runs.
    General,
    /// Adds the constructs q accepts but almost nobody means - a parameter
    /// that shadows a builtin, a filter comparing a column to itself.
    Style,
    /// Adds the conventions published q style guidance states as rules.
    StyleQ,
    /// Adds another repository's own conventions on top of StyleQ.
    Uqf,
}
impl Profile {
    /// Whether a rule of this scope runs under this profile. Public because
    /// the showcase test asks the same question the linter does, rather than
    /// keeping its own copy of the answer.
    pub fn allows_scope(self, scope: &str) -> bool {
        self.allows(scope)
    }
    fn allows(self, scope: &str) -> bool {
        match scope {
            "builtin" => true,
            "style" => self != Profile::General,
            "styleq" => matches!(self, Profile::StyleQ | Profile::Uqf),
            "uqf" => self == Profile::Uqf,
            // qls and python-hook findings arrive from elsewhere; this is not
            // the place that decides whether they ran.
            _ => true,
        }
    }
}

pub fn lint(source: &str, path: &str, profile: Profile) -> Vec<Finding> {
    let uqf = profile == Profile::Uqf;
    let v = views(source);
    if let Some(f) = structure(path, source, &v) {
        return vec![f];
    }
    let code = &v.code;
    // A UTF-8 BOM is not something q tolerates: it reports 'char on the first
    // line and loads nothing. Reported and then carried on past, because the
    // author still wants to know what else is wrong with a file they are
    // about to find unloadable.
    let mut out = semantics::check(path, code, source);
    if source.starts_with('\u{feff}') {
        out.push(Finding::at(
            path,
            source,
            0,
            "QE005",
            "Byte-order mark: q reports 'char on the first line and will not load the file".into(),
        ));
    }
    out.extend(intrinsics::check(path, source, code, &v.comments));
    if let Some(at) = v.open_block {
        out.push(Finding::at(
            path,
            source,
            at,
            "QE003",
            "This bare slash opens a block comment that no later backslash \
             closes, so the rest of the file is comment"
                .into(),
        ));
    }
    let mut add =
        |at: usize, id: &str, detail: String| out.push(Finding::at(path, source, at, id, detail));
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
        // From qbists/style, on default arguments:
        //
        //   "Be consistent in your use of `x`, `y`, and `z` to mean the first,
        //    second, and third arguments to a function. If you don't use the
        //    default pattern provided by q, avoid using these letters as local
        //    variables, or as arguments occupying other positions in the
        //    argument list."
        //
        // `{[t;x] ...}` makes `x` the second argument, and every q reader
        // arrives expecting it to be the first.
        for (i, slot) in sig.slots.iter().enumerate() {
            if let Some(expected) = ["x", "y", "z"].iter().position(|n| n == slot)
                && expected != i
            {
                add(
                    at,
                    "QS008",
                    format!(
                        "`{slot}` is parameter {} here; q gives that name to argument {}",
                        i + 1,
                        expected + 1
                    ),
                );
            }
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
            let rest = code[end..].trim_start();
            if rest.starts_with('[')
                && !re!(r"\n\S").is_match(&code[end..code.len() - rest.len() + 1])
            {
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
        let parts = slots(&code[dollar + 2..close - 1]);
        // `$` takes an atom. A vector condition is 'type every time, and it is
        // reached for by people expecting it to vectorise - `?[...]` is the
        // form that does. A symbol or a string is 'type for the same reason.
        // Verified: `$[101b;1;2]`, `$[1 2 3;1;2]`, `$[`a;1;2]` and `$["";1;2]`
        // all raise, while `$[1b;1;2]` and `$[1;1;2]` return 1.
        if let Some(cond) = parts.first().map(|c| c.trim())
            && (re!(r"^`[A-Za-z][A-Za-z0-9_.]*$").is_match(cond)
                || re!(r#"^"[^"]*"$"#).is_match(cond)
                || re!(r"^[01]{2,}b$").is_match(cond)
                || re!(r"^-?\d[\w.]*(?:\s+-?\d[\w.]*)+$").is_match(cond))
        {
            add(
                dollar,
                "QA011",
                format!(
                    "`$[{cond};...]` is 'type: the condition must be an atom, and `?[...]` is the vector conditional"
                ),
            );
        }
        let n = parts.len();
        if n == 2 {
            add(
                dollar,
                "QA006",
                "Two-slot $[ ... ] is no conditional q defines; it errors 'type at runtime".into(),
            );
        } else if n >= 4 && n.is_multiple_of(2) {
            // `$[c1;a;c2;b]` pairs every slot off as test-and-result and has
            // nothing left for the else: when no test holds it returns `::`,
            // silently. Verified: `$[0b;1;0b;2]` is `::`, `$[0b;1;0b;2;3]` is 3.
            add(
                dollar,
                "QA007",
                format!(
                    "{n}-slot $[ ... ] has no else branch: when no condition holds it \
                     returns null, not an error"
                ),
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
        // `` `long$x `` is a cast, and the symbol names the type rather than
        // being an operand: `` `long$x-`long$y `` is subtraction of two longs,
        // which q is perfectly happy to evaluate.
        if code[m.end()..].starts_with('$') {
            continue;
        }
        add(
            at,
            "QT003",
            "Arithmetic on a symbol literal is a 'type error at runtime".into(),
        );
    }
    // A symbol compares with a symbol and nothing else. Against a number or a
    // string it is 'type, and both spellings appear in real mistakes:
    // `1=`a` and `"abc"=`abc`. Verified that the neighbours are fine - `1="a"`
    // is 0b because a char compares by its code, `` `a=`b `` is 0b, and `~`
    // never raises - so only a symbol facing a non-symbol is reported.
    {
        let sym = r"`[A-Za-z][A-Za-z0-9_.]*";
        let other = r#"-?\d[\w.]*|"[^"]*""#;
        let op = r"(?:<=|>=|<>|<|>|=|\bin\b)";
        // A string literal is blanks by the time `code` is built, so the
        // string half of this has to read `source`. The operator still has to
        // be present in `code` at the same offset, which is what proves the
        // match is code rather than the inside of a comment.
        for (pattern, view) in [
            (format!(r"({sym})\s*{op}\s*({other})"), code.as_str()),
            (format!(r"({other})\s*{op}\s*({sym})"), code.as_str()),
            (format!(r#"("[^"]*")\s*{op}\s*({sym})"#), source),
            (format!(r#"({sym})\s*{op}\s*("[^"]*")"#), source),
        ] {
            for m in regex::Regex::new(&pattern).unwrap().captures_iter(view) {
                let at = m.get(0).unwrap().start();
                if !boundary(view, at) {
                    continue;
                }
                if !std::ptr::eq(view, code.as_str())
                    && code[at..m.get(0).unwrap().end()] == *m.get(0).unwrap().as_str()
                {
                    // Unmasked in `code` too, so the other patterns saw it.
                    continue;
                }
                if !std::ptr::eq(view, code.as_str()) && !code[at..].starts_with(['`', '"', ' ']) {
                    continue;
                }
                // Both operands have to be whole. A symbol before `$` names a
                // cast - `0i=`int$period` compares two ints - and a number
                // before an operator is the start of something longer, as in
                // `` `time in 0!select ... ``, which unkeys a table and asks
                // about a list of symbols. Either way the match is a prefix
                // of an expression this rule has not understood.
                let end = m.get(0).unwrap().end();
                if view[end..]
                    .starts_with(|c: char| c.is_alphanumeric() || "`$!#@^_.,+-*%~=<>".contains(c))
                {
                    continue;
                }
                add(
                    at,
                    "QT015",
                    format!(
                        "`{}` is 'type: a symbol compares with a symbol, not with a number or a string",
                        m.get(0).unwrap().as_str().trim()
                    ),
                );
            }
        }
    }
    // like's pattern is a string; a symbol literal is the obvious spelling
    // of one and a guaranteed 'type error at runtime.
    for m in re!(r"\blike\s*`").find_iter(code) {
        // A backtick before it makes this the symbol `` `like ``, an element of
        // a list rather than the operator - `` `abs`cor`like`mins `` is data.
        if !boundary(code, m.start()) {
            continue;
        }
        add(
            m.start(),
            "QB007",
            "like needs a string pattern; a symbol literal is a 'type error at runtime".into(),
        );
    }
    // The rank of every lambda this file names, for the two call-shape rules
    // below. An implicit signature's rank is the highest of x, y, z its own
    // body mentions, with nested lambdas blanked so theirs do not count.
    let mut ranks: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*:\s*\{").captures_iter(code) {
        let brace = m.get(0).unwrap().end() - 1;
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let sig = signature(code, source, brace);
        let rank = if sig.named {
            if sig.slots.iter().all(|p| p.is_empty()) {
                0
            } else {
                sig.slots.len()
            }
        } else {
            let mut body = code.as_bytes()[sig.body..end].to_vec();
            let mut depth = 0i32;
            for c in &mut body {
                match *c {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ if depth > 0 => *c = b' ',
                    _ => {}
                }
            }
            let body = String::from_utf8(body).unwrap();
            if re!(r"\bz\b").is_match(&body) {
                3
            } else if re!(r"\by\b").is_match(&body) {
                2
            } else {
                1
            }
        };
        // Only when the name is the lambda, not the result of applying it.
        // `files:{...} each x` and `bids:{...}'[til n]` both assign a list,
        // and treating either as a function of the rank its braces declare
        // makes an ordinary index - `bids[;0]` - look like an over-applied
        // call. So the statement has to end at the closing brace.
        if !code[end..]
            .trim_start_matches([' ', '\t'])
            .starts_with([';', '\n', '\r'])
            && !code[end..].trim_start_matches([' ', '\t']).is_empty()
        {
            continue;
        }
        ranks.insert(m.get(1).unwrap().as_str(), rank);
    }
    // The same arity check as QA002, for a lambda reached by name. `ranks`
    // already knows what each `name:{...}` takes, so a call with more slots
    // than that is 'rank at runtime - the error QA002 reports when the lambda
    // is written out at the call site.
    //
    // Elided slots still count. `f[1;]` looks like a projection and is one
    // only when the slots fit: against a rank-1 `f` it supplies two and is
    // 'rank, which q confirms. `f[]` supplies none and is a projection at any
    // rank. Names defined more than once are dropped rather than guessed at,
    // since the rank at the call site is whichever definition ran last.
    let mut redefined: std::collections::HashSet<&str> = std::collections::HashSet::new();
    {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*:\s*\{").captures_iter(code) {
            let name = m.get(1).unwrap().as_str();
            if !seen.insert(name) {
                redefined.insert(name);
            }
        }
    }
    for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*\[").captures_iter(code) {
        let (whole, name) = (m.get(0).unwrap(), m.get(1).unwrap().as_str());
        if !boundary(code, whole.start()) || redefined.contains(name) {
            continue;
        }
        let Some(&rank) = ranks.get(name) else {
            continue;
        };
        let open = whole.end() - 1;
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let inner = &code[open + 1..close - 1];
        let parts = slots(inner);
        if rank == 0 || inner.trim().is_empty() {
            continue;
        }
        if parts.len() > rank {
            add(
                whole.start(),
                "QA012",
                format!(
                    "{} argument slots applied to `{name}`, which takes {rank}: 'rank at runtime",
                    parts.len()
                ),
            );
        }
    }
    // `f(1;2)` hands `f` the single argument `1 2`; for a lambda of rank 2 or
    // more that is a projection, not a call, and it goes on to produce wrong
    // data downstream. Verified: `f:{x+y}; f(1;2)` is `{x+y}[1 2]`. A rank-1
    // lambda given a list is an ordinary call and stays quiet.
    for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*\(").captures_iter(code) {
        let whole = m.get(0).unwrap();
        let name = m.get(1).unwrap().as_str();
        if !boundary(code, whole.start()) || ranks.get(name).is_none_or(|&r| r < 2) {
            continue;
        }
        let open = whole.end() - 1;
        if let Some(close) = matching(code, open, b'(', b')')
            && slots(&code[open + 1..close - 1]).len() >= 2
        {
            add(
                whole.start(),
                "QA008",
                format!(
                    "`{name}(...)` passes one list argument to a rank-{} lambda, so this is a \
                     projection, not a call; square brackets separate arguments",
                    ranks[name]
                ),
            );
        }
    }
    // `a -1` is `a` applied to `-1`, not `a` minus one: with whitespace before
    // it and none after, the `-` belongs to the literal. Verified: `a:3; a -1`
    // tries to write to file handle 3. A builtin or a lambda this file defines
    // on the left is an intended application (`neg -1`, `f -1`) and is left
    // alone; a numeric literal on the left is a vector (`1 2 -3`) and never
    // matches. Nor does `sizes -1+n`: a literal that continues into an
    // expression is `sizes[n-1]`, indexing said on purpose - only a literal
    // that ends the statement or bracket is the trap.
    for m in
        // `\r` belongs in the trailing class: with `$` in multiline mode the
        // anchor sits before the `\n`, so on a CRLF checkout the carriage
        // return is left between the literal and the anchor and the match is
        // silently lost. Every file git checks out on Windows is CRLF.
        re!(r"(?m)([A-Za-z][A-Za-z0-9_]*)[ \t]+-\d[\w.]*[ \t\r]*(?:[;\])]|$)")
            .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        let name = &m[1];
        if !boundary(code, whole.start())
            || RESERVED.iter().any(|n| n == name)
            || ranks.contains_key(name)
        {
            continue;
        }
        add(
            whole.start(),
            "QB010",
            format!(
                "`{name} -N` applies `{name}` to a negative literal; `{name}-N` or `{name} - N` \
                 is subtraction"
            ),
        );
    }
    // Dot apply wants a list of arguments, and a scalar in that slot is a
    // 'type error - even when the left side is itself a list to index.
    // Verified: `.[{x+y};1]`, `.[f;`a]`, `.[1 2 3;0]` all 'type.
    for m in re!(r"\.\[[^;\[\]]+;\s*(?:-?\d[\w.]*|`[A-Za-z0-9_.]*)\s*[;\]]").find_iter(code) {
        add(
            m.start(),
            "QA009",
            "Dot apply takes a list of arguments; a scalar here is a 'type error at runtime \
             (`enlist` it, or use `@`)"
                .into(),
        );
    }
    // `ss` and `ssr` are string functions and refuse a symbol in either the
    // subject or the pattern slot. `trim`, `lower` and `like` accept symbols
    // and are deliberately not here.
    for m in re!(
        r"\bssr?\s*\[\s*(?:`[A-Za-z0-9_.]*)+\s*[;\]]|\bssr?\s*\[[^;\]]*;\s*(?:`[A-Za-z0-9_.]*)+\s*[;\]]|(?:`[A-Za-z0-9_.]*)+\s+ssr?\b"
    )
    .find_iter(code)
    {
        add(
            m.start(),
            "QT007",
            "ss/ssr work on strings; a symbol literal is a 'type error at runtime".into(),
        );
    }
    // Operators borrowed from other languages. None of these parse: q's
    // equality is `=`, inequality `<>`, and `&&`/`||` are `and`/`or` (or
    // `&`/`|`). `+=` and friends are `+:`.
    for m in re!(r"==|!=|&&|\|\||[+\-*]=").find_iter(code) {
        let (op, meant) = match m.as_str() {
            "==" => ("==", "`=`"),
            "!=" => ("!=", "`<>`"),
            "&&" => ("&&", "`and` (or `&`)"),
            "||" => ("||", "`or` (or `|`)"),
            other => (other, "`+:`-style amend"),
        };
        add(
            m.start(),
            "QE004",
            format!("q has no `{op}`; the spelling here is {meant}"),
        );
    }
    // Keywords from other languages are plain names to q, and undefined ones:
    // `return 1` throws 'return. `null` is absent from this list because it
    // is a q function. A file that declares one of these as a parameter or
    // assigns it anywhere has made it a name, and its uses are left alone.
    let mut declared: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (brace, _) in code.match_indices('{') {
        declared.extend(signature(code, source, brace).slots);
    }
    for m in re!(r"([A-Za-z][A-Za-z0-9_]*)\s*:").captures_iter(code) {
        declared.insert(m.get(1).unwrap().as_str());
    }
    for m in
        re!(r"\b(return|else|elif|elseif|true|false|None|break|continue)\b").captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        let name = &m[1];
        let after = code[whole.end()..].trim_start();
        if !boundary(code, whole.start()) || after.starts_with('.') || declared.contains(name) {
            continue;
        }
        add(
            whole.start(),
            "QF015",
            format!("`{name}` is not a q keyword; it resolves as a global and throws '{name}"),
        );
    }
    // A lambda whose last statement ends in `;` returns `::`, whatever that
    // statement computed. Verified: `{x+1;}[1]` is `::`. It is common, and
    // usually meant, after a side-effecting call - and in q a call by
    // juxtaposition (`f x`, `show x`) has the same shape as any other
    // expression. So the rule is only for a last statement that is a bare
    // name or a chain of simple operands joined by infix operators, with no
    // juxtaposition and no brackets: `x+1`, `r`, `a-b` - shapes that can
    // only be computing a value, and here throw it away.
    for (brace, _) in code.match_indices('{') {
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let sig = signature(code, source, brace);
        let body = &code[sig.body..end - 1];
        let Some(semi) = body.trim_end().strip_suffix(';').map(str::len) else {
            continue;
        };
        let (mut start, mut depth) = (0, 0i32);
        for (i, c) in body[..semi].bytes().enumerate() {
            match c {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                b';' | b'\n' if depth == 0 => start = i + 1,
                _ => {}
            }
        }
        let stmt = body[start..semi].trim();
        let simple = re!(r"^[A-Za-z0-9_.]+(?:\s*(?:<>|<=|>=|[+\-*%=<>&|,#_])\s*[A-Za-z0-9_.]+)*$")
            .is_match(stmt);
        let builtin = RESERVED.iter().any(|n| n == stmt);
        // A string is blank in this view; `f "done"` must not pass for `f`.
        let quoted = v.comments[sig.body + start..sig.body + semi].contains('"');
        if simple && !builtin && !quoted {
            add(
                sig.body + semi,
                "QB012",
                format!(
                    "Lambda ends with `;`, so it returns null and `{stmt}` is computed and \
                     discarded"
                ),
            );
        }
    }
    // `type` returns a short - 7h, not `long - so a symbol on the other side
    // of `=` is a 'type error every time. A bare `type=` is a column named
    // type, which is QF013's business, not this rule's.
    for m in re!(
        r"\btype\s*(?:\[[^\]]*\]|\(?[A-Za-z_][A-Za-z0-9_.]*\)?)\s*(?:=|<>)\s*`[a-z]|`[a-z]+\s*(?:=|<>)\s*type\b"
    )
    .find_iter(code)
    {
        add(
            m.start(),
            "QB013",
            "`type` returns a short (7h, 11h, ...); comparing it to a symbol is a 'type error"
                .into(),
        );
    }
    // Table literals, judged the way q judges them.
    //
    // q checked, per literal shape (`type` of the value; negative is an atom):
    //   `1b` atom, `10b` vector - a boolean literal is an atom only with one
    //   digit; `0x01` atom, `0x0102` vector - a byte literal is an atom only
    //   with exactly two hex digits; `"a"` atom, `"ab"` vector.
    //
    // And per table, what q raises:
    //   `([]a:1;b:2)`         'rank   - every column an atom needs `enlist`
    //   `([]a:1 2;b:3 4 5)`   'length - vector columns of different lengths
    //   `([]a:enlist 1;b:2 3)` 'length - `enlist` makes a one-item vector
    //   `([]a:1;b:2 3)`       fine    - an atom extends to the vector's length
    //   `([k:1]v:2 3)`        'rank   - a keyed table needs vectors both sides
    //   `([k:1 2]v:3)`        'rank   - and on both sides means both
    //   `([]a:"a";b:1)`       'rank   - a char is an atom like any other
    for table in re!(r"\(\s*\[").find_iter(code) {
        let at = table.start();
        let Some(close) = matching(code, at, b'(', b')') else {
            continue;
        };
        let inner = &code[at + 1..close - 1];
        // The key group is `[...]`, the value columns follow it. Whitespace,
        // newlines included, may sit before the bracket.
        let bracket = inner.len() - inner.trim_start().len();
        let Some(key_close) = matching(inner, bracket, b'[', b']') else {
            continue;
        };
        let keys = &inner[bracket + 1..key_close - 1];
        let values = &inner[key_close..];
        // What a column value is, or None when the text does not say.
        #[derive(PartialEq, Clone, Copy)]
        enum Shape {
            Atom,
            Vector(Option<usize>),
        }
        let shape = |v: &str| -> Option<Shape> {
            let v = v.trim();
            // Vectors first. The general numeric-atom pattern would otherwise
            // take `10b` and `0x0102` as atoms, and q says they are not.
            if let Some(rest) = v.strip_prefix("enlist ") {
                return shape_of_enlist(rest);
            }
            if re!(r"^[01]{2,}b$|^0x(?:[0-9a-fA-F]{2}){2,}$|^0x$").is_match(v) {
                let n = if v.ends_with('b') {
                    v.len() - 1
                } else {
                    (v.len() - 2) / 2
                };
                return Some(Shape::Vector(Some(n)));
            }
            if re!(r"^(?:`[A-Za-z0-9_.]*){2,}$").is_match(v) {
                return Some(Shape::Vector(Some(v.matches('`').count())));
            }
            if re!(r"^-?\d[\w.:]*(?:\s+-?\d[\w.:]*)+$").is_match(v) {
                return Some(Shape::Vector(Some(v.split_whitespace().count())));
            }
            if v == "()" {
                return Some(Shape::Vector(Some(0)));
            }
            if re!(r"^[01]b$|^0x[0-9a-fA-F]{2}$|^-?\d[\w.:]*$|^`[A-Za-z0-9_.]*$").is_match(v) {
                return Some(Shape::Atom);
            }
            None
        };
        fn shape_of_enlist(_: &str) -> Option<Shape> {
            Some(Shape::Vector(Some(1)))
        }
        // A string column is blank in this view. Its length is in the source.
        let string_len = |v: &str, offset: usize| -> Option<Shape> {
            let raw = source[at + 1 + offset..at + 1 + offset + v.len()].trim();
            if raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2 {
                let n = raw.len() - 2;
                return Some(if n == 1 {
                    Shape::Atom
                } else {
                    Shape::Vector(Some(n))
                });
            }
            None
        };
        let columns = |group: &str, base: usize| -> Vec<Option<Shape>> {
            let mut out = vec![];
            let mut pos = 0;
            for part in slots(group) {
                let part_start = base + pos;
                pos += part.len() + 1;
                let Some((_, value)) = part.split_once(':') else {
                    if !part.trim().is_empty() {
                        out.push(None);
                    }
                    continue;
                };
                let voff = part_start + part.len() - value.len();
                out.push(shape(value).or_else(|| string_len(value, voff)));
            }
            out
        };
        let key_cols = columns(keys, bracket + 1);
        let val_cols = columns(values, key_close);
        let all = || key_cols.iter().chain(&val_cols);
        if all().count() == 0 {
            continue;
        }
        let known = all().all(|c| c.is_some());
        if !known {
            continue;
        }
        let atoms_only = |cols: &[Option<Shape>]| {
            !cols.is_empty() && cols.iter().all(|c| *c == Some(Shape::Atom))
        };
        // Keyed: both sides have to be vectors. A keyed table is a dictionary
        // of two tables, and either side being a single row is 'rank.
        if !key_cols.is_empty() && (atoms_only(&key_cols) || atoms_only(&val_cols)) {
            add(
                at,
                "QT005",
                "A keyed table literal needs vector columns on both sides of the key; a \
                 single row on either side is a 'rank error"
                    .into(),
            );
            continue;
        }
        if key_cols.is_empty() && atoms_only(&val_cols) {
            add(
                at,
                "QT005",
                "Every column of this table literal is a scalar, which is a 'rank error; a \
                 one-row table needs `enlist`"
                    .into(),
            );
            continue;
        }
        // Vector columns of different lengths. Atoms extend and are ignored.
        let lengths: Vec<usize> = all()
            .filter_map(|c| match c {
                Some(Shape::Vector(Some(n))) => Some(*n),
                _ => None,
            })
            .collect();
        if lengths.len() >= 2 && lengths.iter().any(|&n| n != lengths[0]) {
            add(
                at,
                "QT020",
                format!(
                    "Table literal columns have different lengths ({}), which is a 'length error",
                    lengths
                        .iter()
                        .map(|n| n.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        }
    }
    // `ss` and `ssr` with an empty search pattern. q raises 'length for both:
    // `ss["abc";""]` and `ssr["abc";"";"b"]` checked. The pattern is a string,
    // which is blank in this view, so the check reads the source at the same
    // offsets - a pair of quotes with nothing between them.
    for m in re!(r"\b(ss|ssr)\s*\[").find_iter(code) {
        let open = m.end() - 1;
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[open + 1..close - 1]);
        if parts.len() < 2 {
            continue;
        }
        // The second slot's span in the source.
        let second_start = open + 1 + parts[0].len() + 1;
        let second = source[second_start..second_start + parts[1].len()].trim();
        if second == "\"\"" {
            add(
                m.start(),
                "QT021",
                format!(
                    "`{}` with an empty pattern is a 'length error",
                    code[m.start()..m.end() - 1].trim()
                ),
            );
        }
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
    // Documentation that names a parameter the lambda does not have.
    //
    // The FINOS qdoc convention spells this `@param name description`, and
    // real q uses the tag widely even where it uses a different vocabulary
    // around it. A documented name absent from the signature is unambiguous:
    // the signature changed and the comment did not, or the name is a typo -
    // `folderRoot` above a lambda taking `folderRoots`.
    //
    // Only names that are documented and absent. Parameters with no `@param`
    // are not reported: plenty of q is documented in prose, and demanding a
    // tag per parameter is a different and much larger opinion.
    // Read from the source: `v.comments` blanks comments and keeps strings,
    // so the text of a comment exists only here. A match is a comment rather
    // than code because `code` has it blanked at the same offsets.
    for m in re!(r"(?m)^\s*/+\s*@param\s+([A-Za-z][A-Za-z0-9_]*)").captures_iter(source) {
        let name = m.get(1).unwrap();
        if !code[name.start()..name.end()].trim().is_empty() {
            continue;
        }
        // The signature this comment sits above: the next `{[` in the code
        // view, provided only comments and blank lines lie between.
        let rest = &code[m.get(0).unwrap().end()..];
        let Some(brace) = rest.find('{') else {
            continue;
        };
        // Every whole line between has to be another comment line, so the
        // block is describing the lambda directly beneath it. A blank line
        // separates them, and then the comment is about something else. The
        // last line is exempt: it carries the name being assigned, which is
        // what `readFolder:{[...]` looks like from here.
        // The lambda has to be directly beneath the block. One newline means
        // the next line carries it; more means there are lines in between, and
        // each of those has to be another comment line. A blank line among
        // them separates the two, and then the comment is about something
        // else entirely.
        let between = &source[m.get(0).unwrap().end()..m.get(0).unwrap().end() + brace];
        let mut lines = between.split('\n');
        lines.next(); // the rest of the `@param` line itself
        let mut rest_of_block = lines.collect::<Vec<_>>();
        rest_of_block.pop(); // the line the brace is on, carrying the name
        if rest_of_block
            .iter()
            .any(|l| !l.trim_start().starts_with('/'))
        {
            continue;
        }
        let at = m.get(0).unwrap().end() + brace;
        let sig = signature(code, source, at);
        if !sig.named || sig.slots.is_empty() {
            continue;
        }
        if !sig.slots.contains(&name.as_str()) {
            add(
                name.start(),
                "QS007",
                format!(
                    "`@param {}` names a parameter this lambda does not take; it declares {:?}",
                    name.as_str(),
                    sig.slots
                ),
            );
        }
    }
    // `a:a` assigns a name to itself. There is no q in which that is the
    // intention; it is a typo for a different name or for `a:a+...`, and the
    // reader cannot tell which. The right side has to be the whole of the
    // expression, so `a:a+1` and `a:a where a>0` are left alone.
    // Depth zero only, and matched against the real text. Inside a bracket
    // `([]time:time;...)` names a table column after the variable filling it,
    // which is ordinary q. Blanking brackets instead was worse: it collapses
    // `updmeta[`a]:updmeta[`b]` and `res:(f)res` into something that looks
    // like a name assigned to itself, and neither is.
    let depth: Vec<bool> = {
        let mut out = Vec::with_capacity(code.len());
        let mut open = 0i32;
        // `(` and `[` only. A lambda body is statement context - `{[x] b:b}`
        // is the common place to find this - so braces do not count, and the
        // `[x]` signature opens and closes before the body begins.
        for b in code.bytes() {
            if b")]".contains(&b) {
                open -= 1;
            }
            out.push(open <= 0);
            if b"([".contains(&b) {
                open += 1;
            }
        }
        out
    };
    for m in re!(r"(?m)(\.?[A-Za-z][A-Za-z0-9_.]*)\s*:\s*(\.?[A-Za-z][A-Za-z0-9_.]*)\s*(?:;|$)")
        .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        if depth.get(whole.start()) == Some(&true) && boundary(code, whole.start()) && m[1] == m[2]
        {
            add(
                whole.start(),
                "QB017",
                format!("`{}` is assigned to itself", &m[1]),
            );
        }
    }
    // Two literals compared. The answer is fixed before the program runs, so
    // either the comparison is dead or one side was meant to be a name.
    for m in re!(r"(-?\d[\w.]*|`[A-Za-z][A-Za-z0-9_.]*)\s*(=|<>|<=|>=|<|>)\s*(-?\d[\w.]*|`[A-Za-z][A-Za-z0-9_.]*)")
        .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        // The right operand has to be the whole of one. Saying which
        // characters may not follow is the wrong way round in q, where almost
        // any glyph continues an expression - `0<0^x` fills before comparing
        // and `0<1_x` drops before it, and both look like `0<0` and `0<1` to a
        // pattern. So: the comparison ends here, or it was never one.
        let rest = code[whole.end()..].trim_start_matches([' ', '\t']);
        if !boundary(code, whole.start())
            || !(rest.is_empty() || rest.starts_with([';', ')', ']', '}', '\n', '\r']))
        {
            continue;
        }
        add(
            whole.start(),
            "QB018",
            format!("`{}` compares two literals; the answer is the same every run", whole.as_str().trim()),
        );
    }
    // `if`, `while` and `do` are statements: each returns `::`, so
    // assigning one assigns null. `$[...]` is the expression form.
    for m in re!(r"[A-Za-z0-9_\])]\s*:\s*(if|while|do)\s*\[").captures_iter(code) {
        // The gap may legitimately span lines - an assignment continued onto
        // an indented line is ordinary q, inside a lambda body as much as at
        // the top level. What it may not span is a string: that arrives here
        // as blanks, so `\s*` would otherwise step over twenty-six lines of
        // one and join an assignment to an unrelated `if[` far below. The raw
        // source still has the quote that says which happened.
        //
        // This cannot move into the statement loop below to get the bound for
        // free. That loop folds only at the top level, and the continued
        // assignments this rule is about are usually inside a lambda body,
        // where nothing is folded.
        if source[m.get(0).unwrap().range()].contains('"') {
            continue;
        }
        add(
            m.get(0).unwrap().start(),
            "QB011",
            format!(
                "`{}` is a statement and always returns null; `$[...]` is the conditional \
                     that has a value",
                &m[1]
            ),
        );
    }
    let mut namespace = false;
    let mut depth = 0i32;
    let mut offset = 0;
    // Statements, not lines. q continues a line onto the next when that one
    // begins with whitespace, so `"/" sv string` and an indented `dir,name`
    // below it are one expression - and a rule that reads a line at a time
    // sees two fragments and reports nothing. Verified against q: at column 0
    // the same second line is a separate statement, and an unterminated
    // string on the first line is an error rather than a continuation.
    //
    // Each group is a contiguous byte range, so every `offset + m.start()` in
    // the rules below still lands where it did.
    let statements = {
        let mut out: Vec<(usize, usize)> = vec![];
        let (mut at, mut open) = (0usize, 0i32);
        for (l, raw) in code.split_inclusive('\n').zip(source.split_inclusive('\n')) {
            // Indentation is a fact about the source, not about `code`: a
            // comment is blanked to spaces, so a bare `/` reads as indented
            // there and would fold into the line above it, taking the rule
            // that reports it out of reach. Brackets are counted on `code`,
            // where the ones inside strings and comments are already gone.
            //
            // Only the top level folds. Inside a bracket the newlines are
            // already insignificant to q, and the rules below have always
            // read those lines one at a time - folding a table literal or a
            // lambda body into one unit loses findings inside it.
            let continues = open == 0 && raw.starts_with([' ', '\t']);
            match out.last_mut() {
                Some(last) if continues => last.1 += l.len(),
                _ => out.push((at, at + l.len())),
            }
            for b in l.bytes() {
                match b {
                    b'(' | b'[' | b'{' => open += 1,
                    b')' | b']' | b'}' => open -= 1,
                    _ => {}
                }
            }
            at += l.len();
        }
        out
    };
    for (start, end) in statements {
        let (raw, line, literals) = (
            &source[start..end],
            &code[start..end],
            &v.comments[start..end],
        );
        // The directives and the bare-slash rule are about one physical line,
        // so they read the first of the group rather than the whole of it.
        let first = line.split_inclusive('\n').next().unwrap_or(line);
        let first_raw = raw.split_inclusive('\n').next().unwrap_or(raw);
        let line_depth = depth;
        for c in line.bytes() {
            if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                depth -= 1;
            }
        }
        if uqf && first_raw.trim() == "/" && !v.foreign_offsets.contains(&offset) {
            add(offset, "QP001", "Bare slash opens a block comment".into());
        }
        if first.trim().starts_with("\\d ") {
            namespace = first.trim() != "\\d .";
            // Point at the directive that is still in force at EOF, so the
            // finding names the namespace the file actually ends in.
            offset += line.len();
            continue;
        }
        if first.trim_start().starts_with('\\') {
            offset += line.len();
            continue;
        }
        // More from the same guidelines:
        //
        //   "Do not use unnecessary parentheses - the compiler doesn't need
        //    them, they confuse experienced q coders"
        //
        // Only a parenthesised single token, which is unnecessary whatever the
        // precedence around it. Deciding that in general needs q's precedence,
        // and q's precedence is one rule applied to everything, so "necessary"
        // is a judgement about the reader rather than the parser.
        for m in re!(r"\((\s*(?:\.?[A-Za-z][A-Za-z0-9_.]*|-?\d[\w.]*)\s*)\)").captures_iter(line) {
            let whole = m.get(0).unwrap();
            // `f(x)` is a call, not a parenthesised operand, and `(x)` after a
            // name is how q spells one.
            if line[..whole.start()].ends_with(|c: char| c.is_alphanumeric() || "_.`]".contains(c))
            {
                continue;
            }
            // `1_` is drop applied to 1, not a token: the string it drops from
            // is blanks by the time this runs, so the parentheses look empty.
            // No q number contains an underscore, and a name that does is
            // QS001's business.
            if m[1].contains('_') {
                continue;
            }
            add(
                offset + whole.start(),
                "QS004",
                format!("`{}` wraps a single token in parentheses", whole.as_str()),
            );
        }
        // Names, from the FINOS q coding guidelines:
        //
        //   "**avoid** underscores `_` in names and expressions - `_` is an
        //    operator so names containing it can confuse the reader"
        //
        //   "don't use `.` in names, as this looks like a namespace but its
        //    validity is actually a parser bug ... Do `.myspace.myvar`,
        //    Don't `myspace.myvar`"
        //
        //   "`l` never use letter `l`, looks like number `1` in some fonts"
        //
        // Assignment targets only: a name being read might be someone else's,
        // and there is nothing for the reader of this file to act on.
        if let Some(m) = re!(r"^\s*(\.?[A-Za-z][A-Za-z0-9_.]*)\s*::?(?:[^:=]|$)").captures(line) {
            let target = m.get(1).unwrap();
            let text = target.as_str();
            if text.contains('_') {
                add(
                    offset + target.start(),
                    "QS001",
                    format!("`{text}` contains `_`, which is also the drop operator"),
                );
            }
            // Only at root. Inside `\d .ns` a dotted name is a sub-namespace -
            // `i.helper` there is `.ns.i.helper`, which q creates properly -
            // and the guidance is about the name at root that merely looks
            // like one.
            if !namespace && text.trim_start_matches('.').contains('.') && !text.starts_with('.') {
                add(
                    offset + target.start(),
                    "QS002",
                    format!(
                        "`{text}` has a dot but does not start with one, so it reads as a namespace it is not"
                    ),
                );
            }
            if text == "l" {
                add(
                    offset + target.start(),
                    "QS003",
                    "`l` is hard to tell from `1` in many fonts".into(),
                );
            }
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
        // `/` after a value is the over adverb. `10/2` and `(a+b)/2` are '/
        // parse errors (with a space before it, `/` opens a comment and the
        // rest of the line vanishes - the comment view has already removed
        // that case). Division is `%`.
        if let Some(m) = re!(r"[\d)]/\s*[\d(]").find(line) {
            add(
                offset + m.start(),
                "QB014",
                "`/` is the over adverb, not division; q divides with `%`".into(),
            );
        }
        // `delete` takes columns or a where phrase, never both; q says 'nyi.
        if let Some(m) = re!(
            r"\bdelete\s+[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s+from\s+`?[A-Za-z_][\w.]*\s+where\b"
        )
        .find(line)
        {
            add(
                offset + m.start(),
                "QB016",
                "`delete` cannot name columns and filter rows in one phrase; that is 'nyi at \
                 runtime"
                    .into(),
            );
        }
        // A cast named by symbol converts a string char by char - `long$"123"`
        // is `49 50 51`, and `date$"2024.01.01"` is ten dates - with no error
        // to say so. The uppercase-char cast `"J"$` parses text. `char` and
        // `byte` are legitimate on a string, and `symbol` is a 'type error
        // rather than junk, but is still not the `$"..."` that was meant.
        if let Some(m) = re!(
            r#"`(long|int|short|float|real|boolean|date|time|timestamp|timespan|month|minute|second|datetime|symbol|guid)\s*\$\s*""#
        )
        .captures(literals)
        {
            let name = &m[1];
            let ch = match name {
                "long" => "J", "int" => "I", "short" => "H", "float" => "F", "real" => "E",
                "boolean" => "B", "date" => "D", "time" => "T", "timestamp" => "P",
                "timespan" => "N", "month" => "M", "minute" => "U", "second" => "V",
                "datetime" => "Z", "guid" => "G", _ => "",
            };
            let fix = if name == "symbol" {
                "`$\"...\"".to_string()
            } else {
                format!("\"{ch}\"$\"...\"")
            };
            add(
                offset + m.get(0).unwrap().start(),
                "QT004",
                format!(
                    "`{name}$ on a string casts each character's code, not the text; parsing \
                     text is {fix}"
                ),
            );
        }
        // Equality against a string literal in a filter: on a symbol column
        // it is 'type, on a string column 'length (rows against chars), and
        // when the lengths happen to agree it compares row-wise and returns
        // garbage. A one-char string is a char atom and compares fine
        // against a char column, so only longer literals are the trap.
        if let Some(w) = re!(r"\bwhere\b").find(literals)
            && let Some(m) = re!(r#"(?:=|<>)\s*"((?:[^"\\]|\\.)*)""#).captures(&literals[w.end()..])
        {
            let chars = re!(r"\\.|[^\\]").find_iter(&m[1]).count();
            if chars != 1 {
                add(
                    offset + w.end() + m.get(0).unwrap().start(),
                    "QB015",
                    "Equality against a string in a filter is 'type on a symbol column and \
                     'length on a string column; `like`, `~` or `in` is the comparison meant"
                        .into(),
                );
            }
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
            if let Some(w) = re!(r"\bwhere\b").find(line) {
                let phrase = flat_filter(&line[w.end()..]);
                // `~` matches whole operands, so a filter gets one boolean for
                // the entire table where it wanted one per row: a 'type error
                // against a column, or worse, a single-row result against a
                // scalar. `~/:` and `~\:` supply the row-wise forms and are
                // left alone, which the trailing character class encodes: any
                // next byte that is not those two slash forms is the trap.
                //
                // Only the filter itself is scanned. A `~` elsewhere on the
                // line is a different expression that happens to share it -
                // `sel:{$[`~y;x;select from x where sym in y]}` in KX's own
                // u.q is a conditional, not a filter, and parenthesised parts
                // are already blanked out of `phrase`.
                // `where` is also the unary operator that turns a boolean
                // vector into indices - `first where v~x` is not a filter and
                // has no rows to compare. Only a qSQL statement brings the
                // column semantics this rule is about, so one has to be named
                // to its left before the phrase counts as a filter at all.
                let qsql = re!(r"\b(?:select|exec|update|delete)\b").is_match(&line[..w.start()]);
                for m in re!(r"~[^/\\]").find_iter(&phrase).filter(|_| qsql) {
                    add(
                        offset + w.end() + m.start(),
                        "QB005",
                        "Match (`~`) in a filter compares whole operands, not rows".into(),
                    );
                }
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
                // An empty phrase is not the trap: `select by sym from t` is
                // the documented way to ask for the last row of each group,
                // and it is in every tickerplant and RDB there is. The trap
                // is naming a column and getting its last value silently.
                let plain = !phrase.is_empty()
                    && phrase.split(',').all(|col| {
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
    // One choke point: a rule states its scope in the taxonomy and the profile
    // decides whether that scope is wanted. Filtering here rather than guarding
    // sixty emission sites keeps the two from drifting apart.
    out.retain(|f| {
        RULES
            .iter()
            .find(|r| r.code == f.code)
            .is_none_or(|r| profile.allows(&r.scope))
    });
    out.sort_by(|a, b| {
        (&a.path, a.line, &a.rule, &a.detail).cmp(&(&b.path, b.line, &b.rule, &b.detail))
    });
    out
}
