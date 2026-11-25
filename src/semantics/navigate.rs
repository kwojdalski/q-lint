//! Where a name is written and where it is read, for an editor's navigation:
//! go to definition, find references, the outline, and renaming a local.
//!
//! Nothing here resolves a value. A name is the text q would look up - the
//! one the `\d` in force gives it, or the lambda's own local - found with the
//! scopes and the writes the checks already read, and stopped there: what a
//! name holds when the script runs is still not this crate's to say.
use super::{
    Scope, assigns_lambda, call_time, chained_value, first_switch, global_multi_assignments,
    global_writes, holds_functions, local_view, multi_assignments, resolved, scope_at, scopes,
    top_level_statements,
};
use crate::{Definition, Local, Mention, Name, Place, boundary, pattern_names, signature};
use std::collections::{HashMap, HashSet};

const NAME: &str = r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*";

/// Where `part`, a slice of `whole`, starts in it.
fn offset_in(whole: &str, part: &str) -> usize {
    part.as_ptr() as usize - whole.as_ptr() as usize
}

/// Where the write whose value starts at `value` spells the name it writes,
/// `key`: the nearest spelling before the value, since `global_writes` keeps
/// where each value starts and not where its name is. The spelling is the
/// name's last part and whatever dotted prefix is written with it - `f`
/// under `\d .ns` for `.ns.f`, `` `a `` in `` .cfg[`a]:1 `` for `.cfg.a`.
fn written(code: &str, key: &str, value: usize) -> Option<(usize, usize)> {
    let leaf = key.rsplit('.').next().filter(|leaf| !leaf.is_empty())?;
    let part = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let before = code.get(..value)?;
    let mut end = before.len();
    // The name is beside its value in every form `global_writes` reads, so
    // a few spellings back is past any statement that could hold it.
    for _ in 0..8 {
        let at = before[..end].rfind(leaf)?;
        end = at;
        let stop = at + leaf.len();
        if before[stop..].starts_with(part) || before[..at].ends_with(part) {
            continue;
        }
        // Past the character before the name, which may be more than a
        // byte: a BOM, or a no-break space between statements (#859).
        let start = before[..at]
            .char_indices()
            .rfind(|&(_, c)| !part(c) && c != '.')
            .map_or(0, |(p, c)| p + c.len_utf8());
        let spelt = &before[start..stop];
        let prefix = &key[..key.len().saturating_sub(spelt.len())];
        if spelt == key
            || (key.ends_with(spelt) && prefix.ends_with('.') && !spelt.starts_with('.'))
        {
            return Some((start, spelt.len()));
        }
    }
    None
}

/// Whether what follows a symbol ends the expression it is in, so that the
/// symbol alone is what the word before it takes: in `` value `c _ x `` and
/// `` get `a,`b `` it is not.
fn ends_expression(rest: &str) -> bool {
    let rest = rest.trim_start_matches([' ', '\t']);
    rest.is_empty() || rest.starts_with([';', ']', ')', '}', '\n', '\r'])
}

/// Each symbol the code hands to something that takes a global by its name
/// and nothing else, as where the name starts and how long it is. KDB-X 5,
/// with `tb:([]c:3 1 2)`: `update c:c*2 from `tb`, `delete from `tb where
/// c>1`, `` `c xkey `tb ``, `` `c xasc `tb ``, `xdesc[`c;`tb]`, `` 1!`tb ``,
/// `` 0!`tb ``, `![`tb;();0b;enlist`c]`, `@[`tb;`c;neg]` and `.[`tb;();,;v]`
/// change the table in place and return `` `tb ``; `select from `tb`,
/// `exec c from `tb`, `?[`tb;();0b;()]`, `` get `tb ``, `value[`tb]`,
/// `` cols `tb ``, `` meta `tb `` and `` keys `tb `` read it. `` `a xcol `tb ``
/// and `` `a xcols `tb `` do not: 'rank and 'type.
///
/// Only where the symbol is the whole operand. One of a list, one an
/// operator goes on from, one handed to any other word (`` `tb in tables[] ``,
/// `count `tb`, which is 1) is not here, the text not saying whether it
/// names the global or is only a symbol.
///
/// With each, whether the word changes the table in place - every one above
/// that returns `` `tb ``: `update` and `delete` from it, `xkey`, `xasc`,
/// `xdesc`, `n!`, and the amends and functional update or delete (`@`, `.`,
/// `!`) - and so writes it, where a select, `?` and the words that take a
/// name only read it (#2054).
fn by_name(code: &str) -> Vec<(usize, usize, bool)> {
    const SYMBOL: &str = r"`(\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)";
    let whole = |name: regex::Match| {
        !code[name.end()..].starts_with(|c: char| c.is_ascii_alphanumeric() || "_.:/`".contains(c))
    };
    let mut out = vec![];
    // A table after `from`, to the end of the phrase or its `where`.
    for m in re!(&format!(r"\bfrom\s*{SYMBOL}")).captures_iter(code) {
        let name = m.get(1).unwrap();
        let rest = code[name.end()..].trim_start_matches([' ', '\t']);
        let filtered = rest
            .strip_prefix("where")
            .is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'));
        if boundary(code, m.get(0).unwrap().start())
            && whole(name)
            && (filtered || ends_expression(rest))
        {
            // The phrase the `from` ends: the nearest query word before it.
            let changes = re!(r"\b(select|exec|update|delete)\b")
                .find_iter(&code[..m.get(0).unwrap().start()])
                .last()
                .is_some_and(|word| matches!(word.as_str(), "update" | "delete"));
            out.push((name.start(), name.len(), changes));
        }
    }
    // The first argument of an amend, a functional query or a functional
    // update, which the bracket and the semicolon end.
    for m in re!(&format!(r"[@.!?]\s*\[\s*{SYMBOL}\s*;")).captures_iter(code) {
        let name = m.get(1).unwrap();
        let applied = code[..m.get(0).unwrap().start()]
            .ends_with(|c: char| c.is_ascii_alphanumeric() || "_.)]}`\"".contains(c));
        if !applied && whole(name) {
            let changes = !m.get(0).unwrap().as_str().starts_with('?');
            out.push((name.start(), name.len(), changes));
        }
    }
    // The right of a word that keys or sorts in place, and of `n!`.
    for m in re!(&format!(
        r"(?:\b(?:xkey|xasc|xdesc)\s*(\[[^;\[\]]*;\s*)?|(?m:^|[;:(\[{{])[ \t]*\d+\s*!\s*){SYMBOL}"
    ))
    .captures_iter(code)
    {
        let name = m.get(2).unwrap();
        let rest = &code[name.end()..];
        let ends = match m.get(1) {
            Some(_) => rest.trim_start_matches([' ', '\t']).starts_with(']'),
            None => ends_expression(rest),
        };
        if boundary(code, m.get(0).unwrap().start()) && whole(name) && ends {
            out.push((name.start(), name.len(), true));
        }
    }
    // What a word that takes a name is given, bracketed or parenthesised.
    for m in re!(&format!(
        r"\b(?:get|value|cols|meta|keys)\s*(?:([\[(])\s*)?{SYMBOL}"
    ))
    .captures_iter(code)
    {
        let name = m.get(2).unwrap();
        let rest = code[name.end()..].trim_start_matches([' ', '\t']);
        let ends = match m.get(1).map(|open| open.as_str()) {
            Some("[") => rest.starts_with(']'),
            Some(_) => rest.strip_prefix(')').is_some_and(ends_expression),
            None => ends_expression(rest),
        };
        if boundary(code, m.get(0).unwrap().start()) && whole(name) && ends {
            out.push((name.start(), name.len(), false));
        }
    }
    out
}

/// Where the code hands a global by its name to a word that changes it in
/// place (`by_name`): the start of each such symbol's name.
pub fn changed_by_name(code: &str) -> Vec<usize> {
    by_name(code)
        .into_iter()
        .filter_map(|(at, _, changes)| changes.then_some(at))
        .collect()
}

/// What the `k)` lines of a file name. Both views blank a `k)` line and the
/// indented lines that continue it, as they do any other language's, but k
/// reads and assigns q's globals under the `\d` in force: KDB-X 5 `fk:2`,
/// `k)gk:fk+1`, then gk is 3 (#2019).
pub(super) struct KLines {
    /// Each name that is a global: where, how long, and the lambda it is
    /// directly in.
    pub(super) globals: Vec<(usize, usize, Option<usize>)>,
    /// Each lambda: where its brace opens, and its parameters and locals.
    lambdas: Vec<(usize, HashSet<String>)>,
    /// Each symbol: where its name starts, and the name.
    symbols: Vec<(usize, String)>,
    /// Each of `globals` that is assigned there, by where it is: whether a
    /// lambda is its value, and the span of its statement - the k statement
    /// at the top level, the name alone in a lambda (`k){fk::x}`).
    pub(super) assigned: HashMap<usize, (bool, usize, usize)>,
}

/// The `k)` lines of `raw` read as k, for the names in them.
///
/// k's names are q's without the underscore, which is the drop operator
/// there: KDB-X 5 `k)ab_cc` is `1 _ ab` for `cc:1`. A lambda's parameter, an
/// implicit x, y or z, and a `name:` it assigns are its own, as in q, and a
/// nested lambda reads the global: `k)f:{[fk] fk+1}`, `k){fk:5;fk+1}` and
/// `k){{fk+x}x}` were each run, as was `k)([]fk:1 2)`, a column.
pub(super) fn k_lines(code: &str, raw: &str) -> KLines {
    let mut out = KLines {
        globals: vec![],
        lambdas: vec![],
        symbols: vec![],
        assigned: HashMap::new(),
    };
    if !raw.contains("k)") {
        return out;
    }
    // The text of the k lines with everything else blanked, strings,
    // comments and symbols too, so that offsets are the file's.
    let mut view = vec![b' '; raw.len()];
    let (mut offset, mut k) = (0, false);
    // Where each k statement starts and ends, its lines' trailing blanks
    // and comment left out of the end.
    let mut statements: Vec<(usize, usize)> = vec![];
    let content = |line: &str, offset: usize| {
        let cut = line
            .match_indices('/')
            .find(|&(i, _)| i == 0 || line.as_bytes()[i - 1].is_ascii_whitespace())
            .map_or(line.len(), |(i, _)| i);
        offset + line[..cut].trim_end().len()
    };
    for line in raw.split_inclusive('\n') {
        let end = offset + line.len();
        let blanked = code[offset..end].trim().is_empty();
        // A `k)\d .ns` is a command, its context `opens`' to read, and
        // names nothing; so is one after more prefixes, `k)q)\d .ns` (#2194).
        if line.starts_with("k)") && line[crate::language_prefixes(line)..].starts_with('\\') {
            k = false;
        } else if line.starts_with("k)") && blanked {
            k = true;
            view[offset + 2..end].copy_from_slice(&raw.as_bytes()[offset + 2..end]);
            let lead = line[2..].len() - line[2..].trim_start().len();
            statements.push((offset + 2 + lead, content(line, offset)));
        } else if k && blanked && crate::foreign_continues(line, &raw[end..]) {
            view[offset..end].copy_from_slice(&raw.as_bytes()[offset..end]);
            if let Some(last) = statements.last_mut() {
                last.1 = last.1.max(content(line, offset));
            }
        } else {
            k = false;
        }
        offset = end;
    }
    let name = |c: u8| c.is_ascii_alphanumeric();
    let mut at = 0;
    while at < view.len() {
        match view[at] {
            b'"' => {
                let start = at;
                at += 1;
                while at < view.len() && view[at] != b'"' {
                    at += 1 + usize::from(view[at] == b'\\');
                }
                at = (at + 1).min(view.len());
                view[start..at].fill(b' ');
            }
            b'/' if at == 0 || matches!(view[at - 1], b' ' | b'\t' | b'\n') => {
                while at < view.len() && view[at] != b'\n' {
                    view[at] = b' ';
                    at += 1;
                }
            }
            b'`' => {
                let start = at + 1;
                at = start;
                while at < view.len() && (name(view[at]) || b".:/".contains(&view[at])) {
                    at += 1;
                }
                out.symbols
                    .push((start, String::from_utf8_lossy(&view[start..at]).into()));
                view[start - 1..at].fill(b' ');
            }
            _ => at += 1,
        }
    }
    let Ok(text) = std::str::from_utf8(&view) else {
        return out;
    };
    // Each name with the lambda it is directly in, and what kind of name
    // the text beside it makes it.
    #[derive(PartialEq)]
    enum Kind {
        Read,
        Local,
        Column,
    }
    let mut names = vec![];
    let mut open: Vec<(u8, Option<usize>, bool)> = vec![];
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        let c = bytes[at];
        let lambda = open.iter().rev().find_map(|o| o.1);
        match c {
            b'{' => {
                out.lambdas.push((at, HashSet::new()));
                open.push((c, Some(out.lambdas.len() - 1), false));
                let params = text[at + 1..].trim_start();
                if !params.starts_with('[') {
                    let own = &mut out.lambdas.last_mut().unwrap().1;
                    own.extend(["x", "y", "z"].map(String::from));
                }
            }
            b'(' => open.push((c, None, text[at + 1..].trim_start().starts_with('['))),
            b'[' => {
                // A lambda's parameters, or the key columns of a table.
                let declares =
                    matches!(open.last(), Some((b'{', ..))) && text[..at].trim_end().ends_with('{');
                let table = matches!(open.last(), Some((b'(', _, true)));
                open.push((c, None, declares || table));
            }
            b'}' | b')' | b']' => {
                open.pop();
            }
            _ => {}
        }
        if !(c.is_ascii_alphabetic() || c == b'.') {
            at += 1;
            continue;
        }
        let Some(m) = re!(r"^\.?[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*").find(&text[at..])
        else {
            at += 1;
            continue;
        };
        let start = at;
        at += m.len();
        if start > 0 && (name(bytes[start - 1]) || bytes[start - 1] == b'.') {
            continue;
        }
        let rest = text[at..].trim_start_matches([' ', '\t']);
        let assigned = rest.starts_with(':') && !rest.starts_with("::");
        // What a global's own: `name:` at the top level of a statement,
        // `name::` or a dotted `name:` in a lambda, as q has them.
        let global = if lambda.is_none() {
            assigned && open.is_empty()
        } else {
            rest.starts_with("::") || assigned && m.as_str().contains('.')
        };
        if global {
            let value = rest.trim_start_matches(':').trim_start();
            let span = if lambda.is_none() {
                statements
                    .iter()
                    .rfind(|(s, _)| *s <= start)
                    .copied()
                    .unwrap_or((start, at))
            } else {
                (start, at)
            };
            out.assigned
                .insert(start, (value.starts_with('{'), span.0, span.1.max(at)));
        }
        let kind = match open.last() {
            // In a lambda's `[..]`, a parameter; in a table's, or straight
            // in its parentheses, `name:` is a column.
            Some((b'[', _, true))
                if lambda.is_some_and(|l| {
                    text[out.lambdas[l].0 + 1..start]
                        .trim_start()
                        .starts_with('[')
                        && !text[out.lambdas[l].0..start].contains(']')
                }) =>
            {
                Kind::Local
            }
            Some((b'[', _, true) | (b'(', _, true)) if assigned => Kind::Column,
            _ if assigned && lambda.is_some() && !m.as_str().contains('.') => Kind::Local,
            _ => Kind::Read,
        };
        if kind == Kind::Local
            && let Some(l) = lambda
        {
            out.lambdas[l].1.insert(m.as_str().into());
        }
        names.push((start, m.len(), lambda, kind));
    }
    let reserved: HashSet<&str> = crate::RESERVED.iter().map(String::as_str).collect();
    for (at, len, lambda, kind) in names {
        let word = &text[at..at + len];
        let own = lambda.is_some_and(|l| out.lambdas[l].1.contains(word));
        if kind == Kind::Read && (word.contains('.') || !(own || reserved.contains(word))) {
            out.globals.push((at, len, lambda));
        }
    }
    out
}

/// The names a symbol written at `at` is looked up as when something takes
/// it as a global's name: under the `\d` in force, and at the root too from
/// a lambda written under a `\d`, which looks it up where it is called.
fn symbol_names(scopes: &[Scope], at: usize, name: &str, ns: &str) -> Vec<String> {
    let mut names = vec![resolved(name, ns)];
    if call_time(scopes, at, name) {
        names.push(resolved(name, ""));
    }
    names
}

/// Each symbol that spells `leaf` and no more, `` `leaf ``, alone or one of
/// a list, as the global it would name were it handed to something that
/// takes a name. `mentions` has those it can prove are one (`by_name`, and
/// the writes); the rest are here for whoever must not miss a use - Find
/// References, which lists them, and a rename, which will not go on past
/// one it cannot tell from data (#2018).
pub fn symbols(code: &str, raw: &str, leaf: &str) -> Vec<Mention> {
    let (scopes, namespaces) = scopes(code, raw);
    let first_switch = first_switch(code, raw);
    let mut out = vec![];
    for (tick, _) in code.match_indices('`') {
        let at = tick + 1;
        let rest = &code[at..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || "_.:/".contains(c)))
            .unwrap_or(rest.len());
        let line = code[..at].rfind('\n').map_or(0, |p| p + 1);
        if &rest[..end] != leaf || crate::system_command(&raw[line..]) {
            continue;
        }
        let ns = &namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1;
        for name in symbol_names(&scopes, at, leaf, ns) {
            out.push(Mention {
                name,
                implicit: !leaf.starts_with('.') && at < first_switch,
                at,
                len: leaf.len(),
                definition: None,
            });
        }
    }
    // A symbol on a `k)` line, where nothing is known to take a name.
    for (at, symbol) in k_lines(code, raw).symbols {
        if symbol == leaf {
            let ns = &namespaces[namespaces
                .partition_point(|(p, _)| *p <= at)
                .saturating_sub(1)]
            .1;
            out.push(Mention {
                name: resolved(leaf, ns),
                implicit: !leaf.starts_with('.') && at < first_switch,
                at,
                len: leaf.len(),
                definition: None,
            });
        }
    }
    out
}

/// Every global name in the file, where it is written and where it is read,
/// each as the one name q resolves it to under the `\d` in force - in order.
///
/// A write is one `global_writes` reads, so a table's column and a qSQL
/// alias are not definitions. A read is any other name outside a string, a
/// comment and a system command that no local of its lambda hides - a name
/// in a qSQL phrase included, though the table may have a column of that
/// name: a reference too many is one more line to skip in a list, and one
/// too few is a caller nobody was told about. A qualified symbol,
/// `` `.ns.f ``, is a read of that name, as `references` has it, and so is
/// any symbol in a place that takes a global by name (`by_name`).
pub fn mentions(code: &str, comments: &str, raw: &str) -> Vec<Mention> {
    let (scopes, namespaces) = scopes(code, raw);
    let first_switch = first_switch(code, raw);
    let ns_at = |at: usize| {
        namespaces[namespaces
            .partition_point(|(p, _)| *p <= at)
            .saturating_sub(1)]
        .1
        .as_str()
    };
    let system = |at: usize| {
        let line = code[..at].rfind('\n').map_or(0, |p| p + 1);
        crate::system_command(&raw[line..])
    };
    let statements = top_level_statements(code, raw);
    let mut out = vec![];
    let mut writes = HashSet::new();
    let all = global_writes(code, raw, &scopes, &namespaces, resolved, true);
    let held = holds_functions(code, raw, &all, &scopes, &namespaces);
    for (name, values) in all {
        let holds_function = held.get(&name).copied().unwrap_or(false);
        for value in values {
            let Some((at, len)) = written(code, &name, value) else {
                continue;
            };
            writes.insert(at);
            let function = assigns_lambda(code, raw, value);
            let (detail, params) = if function {
                let value = chained_value(code, value);
                let brace = value + code[value..].len() - code[value..].trim_start().len();
                let sig = signature(code, raw, brace);
                let slots: Vec<&str> = sig.slots.iter().map(|slot| slot.trim()).collect();
                let detail = if sig.named {
                    format!("[{}]", slots.join(";"))
                } else {
                    String::new()
                };
                (detail, super::help::parameters(code, raw, &scopes, brace))
            } else {
                (String::new(), vec![])
            };
            // The whole statement at the top level, lambda and all, which is
            // what an outline folds and selects; inside a lambda, where
            // `g::v` and `` `g set v `` write a global, the name alone.
            let statement = statements
                .get(
                    statements
                        .partition_point(|(start, _)| *start <= at)
                        .wrapping_sub(1),
                )
                .map(|(start, text)| {
                    let lead = text.len() - text.trim_start().len();
                    // Its end in the view that keeps strings: a string the
                    // statement ends in is part of it (#1215).
                    let kept = &comments[*start..start + text.len()];
                    (start + lead, start + kept.trim_end().len())
                })
                .filter(|&(start, end)| {
                    scope_at(&scopes, at).is_none() && start <= at && at + len <= end
                });
            let (start, end) = statement.unwrap_or((at, at + len));
            out.push(Mention {
                implicit: !name.starts_with('.') && value < first_switch,
                name: name.clone(),
                at,
                len,
                definition: Some(Definition {
                    function,
                    holds_function,
                    detail,
                    params,
                    start,
                    end,
                }),
            });
        }
    }
    let reserved: HashSet<&str> = crate::RESERVED.iter().map(String::as_str).collect();
    let unsymbolled = crate::unsymbolled(code);
    for m in re!(NAME).find_iter(&unsymbolled) {
        let word = m.as_str();
        if !boundary(&unsymbolled, m.start()) || writes.contains(&m.start()) || system(m.start()) {
            continue;
        }
        // Written as an assignment and no write: a column, an alias or a
        // key, which names no global.
        if unsymbolled[m.end()..]
            .trim_start_matches([' ', '\t'])
            .starts_with(':')
        {
            continue;
        }
        if !word.contains('.')
            && (reserved.contains(word)
                || scope_at(&scopes, m.start()).is_some_and(|s| scopes[s].locals.contains(word)))
        {
            continue;
        }
        out.push(Mention {
            name: resolved(word, ns_at(m.start())),
            implicit: !word.starts_with('.') && m.start() < first_switch,
            at: m.start(),
            len: m.len(),
            definition: None,
        });
    }
    for m in re!(r"`(\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)").captures_iter(code) {
        let name = m.get(1).unwrap();
        // A symbol runs on past where a name stops: `` `.a.b:c `` is no `.a.b`.
        if writes.contains(&name.start())
            || system(name.start())
            || code[name.end()..]
                .starts_with(|c: char| c.is_ascii_alphanumeric() || "_.:/".contains(c))
        {
            continue;
        }
        out.push(Mention {
            name: name.as_str().into(),
            implicit: false,
            at: name.start(),
            len: name.len(),
            definition: None,
        });
    }
    for (at, len, _) in by_name(code) {
        if writes.contains(&at) || system(at) {
            continue;
        }
        let word = &code[at..at + len];
        for name in symbol_names(&scopes, at, word, ns_at(at)) {
            out.push(Mention {
                name,
                implicit: !word.starts_with('.') && at < first_switch,
                at,
                len,
                definition: None,
            });
        }
    }
    // What a `k)` line reads or assigns, which neither view shows. KDB-X 5
    // runs `k)gk:fk+1` and `gk` is a global like any other (#2047).
    let k = k_lines(code, raw);
    for (at, len, _) in k.globals {
        let word = &raw[at..at + len];
        let name = resolved(word, ns_at(at));
        let holds = held.get(&name).copied();
        out.push(Mention {
            name,
            implicit: !word.starts_with('.') && at < first_switch,
            at,
            len,
            definition: k
                .assigned
                .get(&at)
                .map(|&(function, start, end)| Definition {
                    function,
                    holds_function: holds.unwrap_or(function),
                    detail: String::new(),
                    params: vec![],
                    start,
                    end,
                }),
        });
    }
    out.sort_by(|a, b| (a.at, &a.name).cmp(&(b.at, &b.name)));
    out.dedup_by(|a, b| a.at == b.at && a.name == b.name);
    out
}

/// Each place the lambda `scopes[s]` names its parameter or local `name`:
/// in its signature, and in its own body - never a nested lambda's, which
/// has its own `name` or reads the global, q having no closures.
fn local(code: &str, raw: &str, scopes: &[Scope], s: usize, name: &str) -> Local {
    let scope = &scopes[s];
    let mut places = vec![];
    let mut declared = None;
    if scope.named {
        let sig = signature(code, raw, scope.start);
        for bound in sig.slots.iter().flat_map(|slot| pattern_names(slot)) {
            if bound == name {
                declared.get_or_insert(places.len());
                places.push(Place {
                    at: offset_in(code, bound),
                    len: bound.len(),
                    write: true,
                    column: false,
                });
            }
        }
    }
    let direct = scope.direct.as_str();
    // What a query or a table literal hides: there `name:` is a column or an
    // alias and no local, while a read may be the local or a column of the
    // table - q 5's `{[a] select a from ([] a:1 2)} 7` is the column, and
    // `{[a] select b:a from ([] c:1 2)} 7` the parameter.
    let hidden = local_view(direct, true);
    let phrases = crate::outside_query_phrases(direct);
    // A multiple assignment, `(a;b):v`, writes each name it binds; so does
    // `(a;b)::v` for a name the lambda has as a local, which q writes as
    // `a::v` writes it, not the global: q 5 `{s:`a; (s;n)::(1;2); s+n}[]` is
    // 3 and leaves no global `s` (#2119).
    let bound: HashSet<usize> = multi_assignments(direct)
        .chain(global_multi_assignments(direct).filter(|(_, n)| !n.contains('.')))
        .map(|(_, bound)| offset_in(direct, bound))
        .collect();
    for m in re!(NAME).find_iter(direct) {
        if m.as_str() != name || !boundary(direct, m.start()) {
            continue;
        }
        let after = direct[m.end()..].trim_start_matches([' ', '\t']);
        let assigned = after.starts_with(':');
        if assigned && hidden.as_bytes()[m.start()] == b' ' {
            continue;
        }
        let assigned = assigned || bound.contains(&m.start());
        if assigned && declared.is_none() {
            declared = Some(places.len());
        }
        // An indexed assignment amends the name, `a[0]:2` and `a[0]+:2`
        // (KDB-X), without declaring it.
        let mut amended = after;
        while amended.starts_with('[') {
            let open = direct.len() - amended.len();
            let Some(close) = crate::matching(direct, open, b'[', b']') else {
                break;
            };
            amended = direct[close..].trim_start_matches([' ', '\t']);
        }
        let amends = amended.len() < after.len()
            && (amended.starts_with(':') || re!(r"^[-+*%&|^=<>,#~!?@$]:").is_match(amended));
        places.push(Place {
            at: scope.body + m.start(),
            len: m.len(),
            write: assigned || amends || re!(r"^[-+*%&|^=<>,#~!?@$]:").is_match(after),
            column: phrases.as_bytes()[m.start()] == b' ',
        });
    }
    Local {
        name: name.into(),
        implicit: !scope.named && scope.params.contains(name),
        declared: declared.or(Some(0)).filter(|_| !places.is_empty()),
        places,
    }
}

/// `local`, for the type a local's assignments give it (`infer`).
pub(super) fn local_of(code: &str, raw: &str, scopes: &[Scope], s: usize, name: &str) -> Local {
    local(code, raw, scopes, s, name)
}

/// The lambda around `offset` and the local of it written there, when the
/// name at `offset` is one.
fn local_at<'a>(code: &'a str, scopes: &[Scope], offset: usize) -> Option<(usize, &'a str)> {
    let m = re!(NAME)
        .find_iter(code)
        .take_while(|m| m.start() <= offset)
        .find(|m| offset <= m.end() && boundary(code, m.start()))?;
    let s = scope_at(scopes, m.start())?;
    (!m.as_str().contains('.') && scopes[s].locals.contains(m.as_str())).then_some((s, m.as_str()))
}

/// What the name at byte `offset` refers to: a parameter or local of the
/// lambda around it, or a global by the names q may resolve it to.
pub fn name_at(code: &str, raw: &str, offset: usize) -> Option<Name> {
    let (scopes, _) = scopes(code, raw);
    if let Some((s, name)) = local_at(code, &scopes, offset) {
        let local = local(code, raw, &scopes, s, name);
        // A column of that name, `([] a:1 2)`, is neither the local nor a
        // global.
        return local
            .places
            .iter()
            .any(|p| p.at <= offset && offset <= p.at + p.len)
            .then_some(Name::Local(local));
    }
    // Only where each mention is: a definition's extent is not read, so
    // the view that keeps strings is not needed for it.
    let mentions = mentions(code, code, raw);
    let first = mentions
        .iter()
        .find(|m| m.at <= offset && offset <= m.at + m.len)?;
    Some(Name::Global {
        at: first.at,
        len: first.len,
        // More than one for a `` `n set `` in a lambda under `\d`, which
        // writes where it is called from.
        names: mentions
            .iter()
            .filter(|m| m.at == first.at)
            .map(|m| (m.name.clone(), m.implicit))
            .collect(),
    })
}

/// Why the local at `offset` cannot be renamed, or the local when it can.
///
/// Only a parameter or a local is renamed in one file. A global is named
/// from other files too, so the language server renames one, over every
/// file it indexes (`lsp::navigate`).
fn renamable(code: &str, raw: &str, scopes: &[Scope], offset: usize) -> Result<Local, String> {
    let Some((s, name)) = local_at(code, scopes, offset) else {
        return Err(
            "q-lint renames a lambda's parameters and locals within one file only: a global \
             is renamed across the workspace, by the language server"
                .into(),
        );
    };
    let local = local(code, raw, scopes, s, name);
    if !local
        .places
        .iter()
        .any(|p| p.at <= offset && offset <= p.at + p.len)
    {
        return Err(format!("`{name}` here is a column, not the local"));
    }
    if local.implicit {
        return Err(format!(
            "`{name}` is an implicit parameter: name it in a signature, `{{[{name}] ...}}`, to rename it"
        ));
    }
    if local.places.iter().any(|p| p.column) {
        return Err(format!(
            "`{name}` is read inside a qSQL phrase, where it is a column whenever the table \
             has one of that name - which only the table says"
        ));
    }
    // A table literal names a column it is not told the name of after what
    // it reads: `([] a; b:3 4)` has a column `a`, and renamed it would be
    // `zz` (#1305).
    if local
        .places
        .iter()
        .any(|p| unnamed_table_column(code, p.at))
    {
        return Err(format!(
            "`{name}` is read in a column of a table literal that has no name of its own, which \
             q names after it: write it `{name}:...` first"
        ));
    }
    Ok(local)
}

/// Whether `at` is in a column of a table literal, `([k] c)`, written with
/// no `name:` - which q names after what the column reads.
fn unnamed_table_column(code: &str, at: usize) -> bool {
    let b = code.as_bytes();
    let mut child = at;
    loop {
        // The bracket around `child`, and the last top-level `;` before it.
        let (mut depth, mut semi, mut open) = (0i32, None, None);
        for i in (0..child).rev() {
            match b[i] {
                b')' | b']' | b'}' => depth += 1,
                b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
                b'(' | b'[' | b'{' => {
                    open = Some(i);
                    break;
                }
                b';' if depth == 0 => {
                    semi.get_or_insert(i);
                }
                _ => {}
            }
        }
        let Some(o) = open else { return false };
        let item_start = match b[o] {
            b'{' => return false,
            // The columns after the key list `[...]`.
            b'(' if code[o + 1..].trim_start().starts_with('[') => {
                let key = o + 1 + (code[o + 1..].len() - code[o + 1..].trim_start().len());
                match crate::matching(code, key, b'[', b']') {
                    Some(close) if close <= child => semi.map_or(close, |s| s.max(close)),
                    _ => return false,
                }
            }
            // The key columns.
            b'[' if code[..o].trim_end().ends_with('(') => semi.unwrap_or(o + 1),
            _ => {
                child = o;
                continue;
            }
        };
        let item = code[item_start..].trim_start_matches([';', ' ', '\t', '\r', '\n']);
        return !re!(r"^[A-Za-z][A-Za-z0-9_]*\s*:(?:[^:]|$)").is_match(item);
    }
}

/// The range of the local at `offset`, when it can be renamed.
pub fn rename_target(code: &str, raw: &str, offset: usize) -> Result<(usize, usize), String> {
    let (scopes, _) = scopes(code, raw);
    let local = renamable(code, raw, &scopes, offset)?;
    let place = local
        .places
        .iter()
        .find(|p| p.at <= offset && offset <= p.at + p.len)
        .expect("checked by renamable");
    Ok((place.at, place.len))
}

/// Each place to rewrite so the local at `offset` is called `new` instead,
/// or why not: `new` has to be a name q takes for a local, and one the
/// lambda does not already use - for its own local, or for a global it
/// reads, which the renamed local would hide.
pub fn rename(
    code: &str,
    raw: &str,
    offset: usize,
    new: &str,
) -> Result<Vec<(usize, usize)>, String> {
    let (scopes, _) = scopes(code, raw);
    let local = renamable(code, raw, &scopes, offset)?;
    if !re!(r"^[A-Za-z][A-Za-z0-9_]*$").is_match(new) {
        return Err(format!("`{new}` is not a name q takes for a local"));
    }
    if crate::RESERVED.iter().any(|word| word == new) {
        return Err(format!("`{new}` is a q builtin, which q refuses to assign"));
    }
    let (s, _) = local_at(code, &scopes, offset).expect("checked by renamable");
    let scope = &scopes[s];
    // In a lambda without a signature, a local called x, y or z is an
    // argument: q 5's `{a:1; a+x}` takes one and `{y:1; y+x}` two.
    if !scope.named && matches!(new, "x" | "y" | "z") {
        return Err(format!(
            "`{new}` is an implicit parameter of this lambda, which has no signature"
        ));
    }
    let used = |text: &str| {
        re!(NAME)
            .find_iter(text)
            .any(|m| m.as_str() == new && boundary(text, m.start()))
    };
    if new != local.name && (used(&scope.direct) || used(&code[scope.start..scope.body])) {
        return Err(format!("this lambda already uses the name `{new}`"));
    }
    Ok(local.places.iter().map(|p| (p.at, p.len)).collect())
}

/// The first of `offsets` where a `k)` line names a global or a symbol, where
/// k, not q, reads the name.
pub fn on_k_line(code: &str, raw: &str, offsets: &[usize]) -> Option<usize> {
    let k = k_lines(code, raw);
    offsets.iter().copied().find(|&at| {
        k.globals.iter().any(|&(place, _, _)| place == at)
            || k.symbols.iter().any(|(place, _)| *place == at)
    })
}

/// The first of `offsets` inside a lambda with a parameter or local called
/// `name`, where a global written `name` would read the local instead.
pub fn shadowing(code: &str, raw: &str, name: &str, offsets: &[usize]) -> Option<usize> {
    let (scopes, _) = scopes(code, raw);
    let k = k_lines(code, raw);
    // A k lambda's own names hide a global as q's do.
    let in_k = |at: usize| {
        k.globals.iter().any(|&(place, _, lambda)| {
            place == at && lambda.is_some_and(|l| k.lambdas[l].1.contains(name))
        })
    };
    offsets.iter().copied().find(|&at| {
        scope_at(&scopes, at).is_some_and(|s| scopes[s].locals.contains(name)) || in_k(at)
    })
}
