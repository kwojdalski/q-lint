//! Where a name is written and where it is read, for an editor's navigation:
//! go to definition, find references, the outline, and renaming a local.
//!
//! Nothing here resolves a value. A name is the text q would look up - the
//! one the `\d` in force gives it, or the lambda's own local - found with the
//! scopes and the writes the checks already read, and stopped there: what a
//! name holds when the script runs is still not this crate's to say.
use super::{
    Scope, assigns_lambda, first_switch, global_writes, local_view, multi_assignments, resolved,
    scope_at, scopes, top_level_statements,
};
use crate::{Definition, Local, Mention, Name, Place, boundary, pattern_names, signature};
use std::collections::HashSet;

const NAME: &str = r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*";

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

/// Every global name in the file, where it is written and where it is read,
/// each as the one name q resolves it to under the `\d` in force - in order.
///
/// A write is one `global_writes` reads, so a table's column and a qSQL
/// alias are not definitions. A read is any other name outside a string, a
/// comment and a system command that no local of its lambda hides - a name
/// in a qSQL phrase included, though the table may have a column of that
/// name: a reference too many is one more line to skip in a list, and one
/// too few is a caller nobody was told about. A qualified symbol,
/// `` `.ns.f ``, is a read of that name, as `references` has it.
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
    for (name, values) in global_writes(code, raw, &scopes, &namespaces, resolved, true) {
        for value in values {
            let Some((at, len)) = written(code, &name, value) else {
                continue;
            };
            writes.insert(at);
            let function = assigns_lambda(code, raw, value);
            let (detail, params) = if function {
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
    for m in re!(r"`(\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)").captures_iter(code) {
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
    // A multiple assignment, `(a;b):v`, writes each name it binds.
    let bound: HashSet<usize> = multi_assignments(direct)
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
    Ok(local)
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

/// The first of `offsets` inside a lambda with a parameter or local called
/// `name`, where a global written `name` would read the local instead.
pub fn shadowing(code: &str, raw: &str, name: &str, offsets: &[usize]) -> Option<usize> {
    let (scopes, _) = scopes(code, raw);
    offsets
        .iter()
        .copied()
        .find(|&at| scope_at(&scopes, at).is_some_and(|s| scopes[s].locals.contains(name)))
}
