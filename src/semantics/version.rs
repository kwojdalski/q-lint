//! What does not run on an older (or newer) q: the QK rules, which report
//! only where a configuration names a `target-version` (or `qlinter
//! --target-version`) the construct does not run on.
//!
//! Each rule is one fact about a release, from KX's release notes
//! (code.kx.com/q/releases/ChangesIn3.6, ChangesIn4.0, ChangesIn4.1):
//!
//! | rule  | construct | runs on |
//! |-------|-----------|---------|
//! | QK001 | a dictionary literal, `([a:1;b:2])` | 4.1 and later |
//! | QK002 | a pattern assignment, `(a;b):x`, `([k:v]):d` | 4.1 and later |
//! | QK003 | a typed or filtered parameter, `{[x:`j] ...}`, `{[(a;b)] ...}` | 4.1 and later |
//! | QK005 | `.Q.Xf` or `.Q.Cf` | before 4.1: removed in it |
//!
//! There is no QK004. It reported `-30!`, the deferred response, which q
//! has from 3.6 on; 3.6 is the oldest target there is, so no target could
//! ever see it, and it was withdrawn (#2091).
//!
//! Only the newest side of each fact was run here: KDB-X (q 5) runs every
//! 4.1 construct above and has no `.Q.Xf` or `.Q.Cf`; there is no 3.6, 4.0
//! or 4.1 binary on this machine, so the older side is the release notes'
//! word and is not verified. PeachQ runs the dictionary literal and `(a;b):`
//! but not `([k:v]):` ('nyi) or a filtered parameter ('parse).
use crate::{Finding, matching};

/// A release a file can be checked against, oldest first.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Target {
    V36,
    V40,
    V41,
    KdbX,
}

impl Target {
    /// The names a configuration writes.
    pub const NAMES: [&'static str; 4] = ["3.6", "4.0", "4.1", "kdbx"];

    pub fn parse(text: &str) -> Option<Target> {
        Some(match text.trim().to_ascii_lowercase().as_str() {
            "3.6" => Target::V36,
            "4.0" => Target::V40,
            "4.1" => Target::V41,
            "kdbx" | "kdb-x" | "5" => Target::KdbX,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        Self::NAMES[self as usize]
    }
}

/// When each rule's construct runs: from a release on, or until one.
enum Runs {
    From(Target),
    Before(Target),
}

fn runs(code: &str) -> Option<Runs> {
    Some(match code {
        "QK001" | "QK002" | "QK003" => Runs::From(Target::V41),
        "QK005" => Runs::Before(Target::V41),
        _ => return None,
    })
}

/// Whether a finding of `code` stands for `target`: whether its construct
/// does not run there. Not a QK rule, always.
pub fn reported_for(code: &str, target: Option<Target>) -> bool {
    match (runs(code), target) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(Runs::From(t)), Some(target)) => target < t,
        (Some(Runs::Before(t)), Some(target)) => target >= t,
    }
}

/// Every QK finding in the file, for any target; the caller keeps those
/// `reported_for` its target. One pass over the code view, each bracket's
/// match from the table `lint_rules` installed.
pub(crate) fn check(path: &str, code: &str, source: &str) -> Vec<Finding> {
    let b = code.as_bytes();
    let mut out = vec![];
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'.';
    // The last byte before `at` that is not a blank.
    let before = |at: usize| code[..at].trim_end_matches([' ', '\t']).bytes().last();
    for i in 0..b.len() {
        match b[i] {
            b'(' if b.get(i + 1) == Some(&b'[') => {
                let Some(close) = matching(code, i + 1, b'[', b']').map(|e| e - 1) else {
                    continue;
                };
                let after = code[close + 1..].trim_start_matches([' ', '\t']);
                let inner = code[i + 2..close].trim();
                if after.starts_with(')') && !inner.is_empty() {
                    let end = close + 1 + (code[close + 1..].len() - after.len());
                    if b.get(end + 1) == Some(&b':') && b.get(end + 2) != Some(&b':') {
                        out.push(Finding::at(
                            path,
                            source,
                            i,
                            "QK002",
                            format!(
                                "`{}` is a pattern assignment, which q runs from 4.1 on",
                                first_line(&source[i..=end + 1])
                            ),
                        ));
                    } else {
                        out.push(Finding::at(
                            path,
                            source,
                            i,
                            "QK001",
                            format!(
                                "`{}` is a dictionary literal, which q reads from 4.1 on",
                                first_line(&source[i..=end])
                            ),
                        ));
                    }
                }
            }
            b'(' => {
                let Some(close) = matching(code, i, b'(', b')').map(|e| e - 1) else {
                    continue;
                };
                let statement_start =
                    matches!(before(i), None | Some(b';' | b'{' | b'[' | b'\n' | b'('));
                if statement_start
                    && b.get(close + 1) == Some(&b':')
                    && !matches!(b.get(close + 2), Some(b':'))
                    && code[i + 1..close].contains(';')
                    && depth_one_semicolon(&code[i + 1..close])
                {
                    out.push(Finding::at(
                        path,
                        source,
                        i,
                        "QK002",
                        format!(
                            "`{}` is a pattern assignment, which q runs from 4.1 on",
                            first_line(&source[i..=close + 1])
                        ),
                    ));
                }
            }
            b'{' if b.get(i + 1) == Some(&b'[') => {
                let Some(close) = matching(code, i + 1, b'[', b']').map(|e| e - 1) else {
                    continue;
                };
                let params = &code[i + 2..close];
                if params.contains([':', '(']) {
                    out.push(Finding::at(
                        path,
                        source,
                        i,
                        "QK003",
                        format!(
                            "`{}` types or filters a parameter, which q runs from 4.1 on",
                            first_line(&source[i..=close])
                        ),
                    ));
                }
            }
            b'.' if (code[i..].starts_with(".Q.Xf") || code[i..].starts_with(".Q.Cf"))
                && (i == 0 || !word(b[i - 1]))
                && !b.get(i + 5).is_some_and(|&c| word(c)) =>
            {
                // A file symbol, `` `:.Q.Cf ``, names a file, never the function.
                if (i > 1 && b[i - 1] == b':' && b[i - 2] == b'`')
                    || (i > 0 && b[i - 1] == b'`' && !symbol_reads_function(code, source, i))
                {
                    continue;
                }
                out.push(Finding::at(
                    path,
                    source,
                    i,
                    "QK005",
                    format!("`{}` was removed in q 4.1", &code[i..i + 5]),
                ));
            }
            _ => {}
        }
    }
    out
}

/// Whether the symbol `` `.Q.Cf `` (or `` `.Q.Xf ``) whose name starts at
/// byte `at` of `code` reaches the function, which KDB-X no longer has.
/// A symbol is data: `` `.Q.Cf`.Q.Xf ``, `` (`.Q.Cf;"desc") `` and
/// `` `.Q.Cf in key `.Q `` all run there (#2117). What fails, run on KDB-X,
/// is the symbol read as the global it names: given to `get` or `value`,
/// first in `@[` or `.[`, or applied - to a bracket, a noun after it, `@`,
/// `.` or an adverb (`` `.Q.Cf each 1 2 ``) - each 'the name.
fn symbol_reads_function(code: &str, source: &str, at: usize) -> bool {
    let b = code.as_bytes();
    // The symbol's own text runs on past the name: `.Q.Cf.x` is another one.
    let start = at - 1;
    let end = at + 5;
    let lead = code[..start].trim_end_matches([' ', '\t']);
    let lead_word = lead
        .rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
        .next()
        .unwrap_or("");
    // An item of a symbol vector, `` `a`.Q.Cf ``: the run before it back to
    // a backtick.
    let item = code[..start]
        .trim_end_matches(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ':');
    let in_vector = item.ends_with('`');
    if matches!(lead_word, "get" | "value")
        || ["get[", "value[", "@[", ".["]
            .iter()
            .any(|w| lead.ends_with(w))
    {
        return !in_vector;
    }
    if in_vector || b.get(end) == Some(&b'`') {
        return false;
    }
    match b.get(end) {
        Some(b'[' | b'/' | b'\'') => return true,
        _ if source.as_bytes().get(end) == Some(&b'"') => return true,
        _ => {}
    }
    let gap = code[end..].len() - code[end..].trim_start_matches([' ', '\t']).len();
    if gap == 0 {
        return false;
    }
    let next = &code[end + gap..];
    let src_next = source.as_bytes().get(end + gap).copied();
    match next.bytes().next() {
        None => false,
        Some(b'0'..=b'9' | b'(' | b'[' | b'`' | b'@') => true,
        _ if src_next == Some(b'"') => true,
        Some(b'-') => next[1..]
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_digit() || c == b'.'),
        Some(b'.') => next[1..]
            .bytes()
            .next()
            .is_none_or(|c| c.is_ascii_alphanumeric() || c == b' ' || c == b'\t'),
        Some(c) if c.is_ascii_alphabetic() => {
            let w: String = next
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            matches!(w.as_str(), "each" | "over" | "scan" | "prior" | "peach")
                || !crate::semantics::INFIX.contains(&w.as_str())
        }
        _ => false,
    }
}

/// Whether `inner` has a `;` outside any bracket of its own: `(a;b)`, not
/// `(f[a;b])`.
fn depth_one_semicolon(inner: &str) -> bool {
    let mut depth = 0i32;
    for c in inner.bytes() {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth == 0 => return true,
            _ => {}
        }
    }
    false
}

/// The first line of `text`, with an ellipsis where it goes on.
fn first_line(text: &str) -> String {
    match text.split_once('\n') {
        Some((first, _)) => format!("{} ...", first.trim_end()),
        None => text.to_string(),
    }
}
