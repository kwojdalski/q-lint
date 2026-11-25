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
//! | QK006 | a builtin only KDB-X has, `` use`mymod `` | KDB-X |
//!
//! There is no QK004. It reported `-30!`, the deferred response, which q
//! has from 3.6 on; 3.6 is the oldest target there is, so no target could
//! ever see it, and it was withdrawn (#2091).
//!
//! Only the newest side of each fact was run here: KDB-X (q 5) runs every
//! 4.1 construct above and has no `.Q.Xf` or `.Q.Cf`; there is no 3.6, 4.0
//! or 4.1 binary on this machine, so the older side is the release notes'
//! word and is not verified. PeachQ runs the dictionary literal and `(a;b):`
//! but not `([k:v]):` ('nyi) or a filtered parameter ('parse). QK006's
//! fact is `src/builtins.json`'s: `use` is KDB-X's module loader.
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

thread_local! {
    static TARGET: std::cell::Cell<Option<Target>> = const { std::cell::Cell::new(None) };
}

/// The `target-version` a lint is for, while this is alive: what
/// `kdbx_only` asks. The configuration installs it around each file.
pub struct TargetScope(Option<Target>);

impl TargetScope {
    pub fn install(target: Option<Target>) -> TargetScope {
        TargetScope(TARGET.with(|t| t.replace(target)))
    }
}

impl Drop for TargetScope {
    fn drop(&mut self) {
        TARGET.with(|t| t.set(self.0));
    }
}

/// Whether `word` is a builtin only KDB-X has, its `builtins.json` summary
/// starting `KDB-X:` - `use` - and the lint is for an older target, where
/// it is no builtin at all: an ordinary name the file may bind, and that
/// QK006 reports read as KDB-X's.
pub(crate) fn kdbx_only(word: &str) -> bool {
    TARGET.with(|t| t.get()).is_some_and(|t| t < Target::KdbX) && newer_builtin(word)
}

/// Whether `word` is a builtin only KDB-X has, whatever the target.
fn newer_builtin(word: &str) -> bool {
    crate::builtin(word).is_some_and(|b| b.summary.starts_with("KDB-X:"))
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
        "QK006" => Runs::From(Target::KdbX),
        _ => return None,
    })
}

/// The release from which q refuses what a rule reports, for a rule whose
/// refusal is newer than the oldest target. QE008 (`-x`, `,x`), QE009
/// (`+/x`, `count'x`) and QE011 (`cor each x`) are KDB-X's: q 5 refuses
/// `-x` with '-, `+/1 2 3` with '/ and `count'(1 2;3)` with ' (run here),
/// and q 4 ran each - it read a glyph applied to one argument as its
/// monadic form, applied a derived function to what follows, and with
/// nothing on its left took the keyword as each's function. That side is
/// this project's own notes on the forms (the "q 4 read..." comments at
/// each rule's fix in `lib.rs`), with no q 4 binary to run them on; the
/// shapes those notes are unsure of are left unreported for a q 4 target
/// too, since a refusal there is not known.
fn refused_from(code: &str) -> Option<Target> {
    matches!(code, "QE008" | "QE009" | "QE011").then_some(Target::KdbX)
}

/// Whether a finding of `code` stands for `target`: whether its construct
/// does not run there. A rule q refuses only from some release on reports
/// for that release, a later one, or no target (the reference is q 5).
/// Any other rule that is not a QK rule, always.
pub fn reported_for(code: &str, target: Option<Target>) -> bool {
    if let Some(from) = refused_from(code) {
        return target.is_none_or(|target| target >= from);
    }
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
    kdbx_builtins(path, code, source, &mut out);
    out
}

/// QK006. A builtin only KDB-X has - `use`, whose `builtins.json` summary
/// says so - read as the builtin. An older q has no such word, so for it
/// the name is the file's own: one the file assigns, `use:5`, or binds as
/// a parameter, `{[use] use+1}`, is no use of KDB-X's (KDB-X refuses both,
/// 'assign and 'nyi, which QF004 and QF001 report for it).
fn kdbx_builtins(path: &str, code: &str, source: &str, out: &mut Vec<Finding>) {
    for builtin in crate::BUILTINS.iter().filter(|b| newer_builtin(&b.name)) {
        let word = builtin.name.as_str();
        let found: Vec<usize> = code
            .match_indices(word)
            .map(|(at, _)| at)
            .filter(|&at| {
                crate::boundary(code, at)
                    && !code[..at].ends_with(['.', '`'])
                    && !code[at + word.len()..]
                        .starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '.')
            })
            .collect();
        let bound = found.iter().any(|&at| {
            code[at + word.len()..]
                .trim_start_matches([' ', '\t'])
                .starts_with(':')
                || in_signature(code, at)
        });
        if bound {
            continue;
        }
        for at in found {
            out.push(Finding::at(
                path,
                source,
                at,
                "QK006",
                format!("`{word}` is a builtin only KDB-X has; an older q has no `{word}`"),
            ));
        }
    }
}

/// Whether the word at `at` sits in a lambda's parameter list, `{[a;use]`.
fn in_signature(code: &str, at: usize) -> bool {
    let Some(open) = code[..at].rfind('[') else {
        return false;
    };
    code[..open].trim_end_matches([' ', '\t']).ends_with('{')
        && !code[open..at].contains([']', '{', '}'])
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
