//! Two inventories of the workspace's definitions, both read from the
//! source and nothing else:
//!
//! - `q-lint/definitions`: every global a workspace file assigns, with its
//!   namespace, kind and where it is first assigned - what a namespace tree
//!   draws.
//! - `q-lint/deadCode`: the functions a workspace file defines that no
//!   workspace file reads. A name is counted as read when any file reads it
//!   as code, and - since q also reaches a function by a name it computes -
//!   when its last part is spelled in any symbol or string literal
//!   (`` `f ``, `value "f[]"`, `.z.ts:`f`), so a callback is not reported.
//!   The `.z` handlers q calls itself, and tests, are never reported. Each
//!   answer says how many places in the workspace reach a name by a value
//!   computed at run time, which no reading can follow.
//!
//! - `q-lint/testsReaching`: the functions a document's save changed -
//!   their statements differ from the text the client last saw - and the
//!   tests that reach one of them through the call graph: a test that
//!   names a function that names a changed one, and so on.
//!
//! Like the rest of the server, none runs anything; the VS Code client
//! asks them only while its view or command is on.
use super::annotate::runnables;
use super::navigate::{Sources, range};
use super::{Lines, file_key, path_of};
use q_lint_rs::{Definition, Mention, mentions};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub(super) fn announce(capabilities: &mut Value) {
    for method in [
        "q-lint/definitions",
        "q-lint/deadCode",
        "q-lint/testsReaching",
    ] {
        capabilities["experimental"][method] = json!(true);
    }
}

pub(super) fn answer(method: &str, params: &Value, sources: &Sources) -> Value {
    match method {
        "q-lint/definitions" => definitions(sources),
        "q-lint/deadCode" => dead_code(params, sources),
        "q-lint/testsReaching" => tests_reaching(params, sources),
        _ => Value::Null,
    }
}

/// The namespace a global name is in: `.a.b` for `.a.b.f`, `.` for a name
/// at the root.
fn namespace(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 && name.starts_with('.') => &name[..i],
        _ => ".",
    }
}

/// `q-lint/definitions`: `[{name, namespace, kind, uri, range}]`, each
/// global once per file that assigns it, at its first assignment there,
/// sorted by namespace and name. `kind` is `function` or `variable`: what
/// the name holds once the file has loaded, as the outline has it - a
/// projection, a derived function and a name holding one are functions, and
/// a lambda assigned over is not (#2809).
fn definitions(sources: &Sources) -> Value {
    let mut out: BTreeMap<(String, String, String), Value> = BTreeMap::new();
    for key in sources.keys() {
        let Some((uri, text)) = sources.text(key) else {
            continue;
        };
        let lines = Lines::new(&text);
        let placement = sources.placement(key);
        let mut seen = HashSet::new();
        for m in &mentions(&text) {
            let Some(d) = &m.definition else {
                continue;
            };
            // As q names it where the file is loaded: `ff:` in a file
            // loaded under `\d .aa` is `.aa.ff` (#2046).
            for name in sources.names(&text, m, &placement) {
                if !seen.insert(name.clone()) {
                    continue;
                }
                out.insert(
                    (namespace(&name).to_string(), name.clone(), uri.clone()),
                    json!({
                        "name": name,
                        "namespace": namespace(&name),
                        "kind": if d.holds_function { "function" } else { "variable" },
                        "uri": uri,
                        "range": range(&lines, m.at, m.len),
                    }),
                );
            }
        }
    }
    json!(out.into_values().collect::<Vec<_>>())
}

/// The words spelled in a file's symbol and string literals: the names a
/// value computed at run time could reach.
fn spelled(text: &str, words: &mut HashSet<String>) {
    let b = text.as_bytes();
    let mut i = 0;
    let mut in_string = false;
    let mut in_symbol = false;
    let mut word = String::new();
    let flush = |word: &mut String, words: &mut HashSet<String>| {
        if !word.is_empty() {
            let w = std::mem::take(word);
            // `.a.b.f` and its last part.
            if let Some(leaf) = w.rsplit('.').next().filter(|l| !l.is_empty()) {
                words.insert(leaf.to_string());
            }
            words.insert(w);
        }
    };
    while i < b.len() {
        let c = b[i];
        if in_string {
            match c {
                b'\\' => i += 1,
                b'"' => {
                    in_string = false;
                    flush(&mut word, words);
                }
                _ if c.is_ascii_alphanumeric() || c == b'_' || c == b'.' => word.push(c as char),
                _ => flush(&mut word, words),
            }
        } else if in_symbol {
            if c.is_ascii_alphanumeric() || c == b'_' || c == b'.' {
                word.push(c as char);
            } else {
                flush(&mut word, words);
                in_symbol = c == b'`';
            }
        } else if c == b'"' {
            in_string = true;
        } else if c == b'`' {
            in_symbol = true;
        }
        i += 1;
    }
    flush(&mut word, words);
}

/// `q-lint/deadCode`: `{functions: [{name, uri, range}], dynamic}` - the
/// functions defined in the workspace (or, given `textDocument`, in that
/// document) that nothing in the workspace reads, sorted by file and line;
/// and how many places reach a name by a computed value.
fn dead_code(params: &Value, sources: &Sources) -> Value {
    let only = params["textDocument"]["uri"]
        .as_str()
        .map(|uri| file_key(&path_of(uri)));
    let mut read: HashSet<String> = HashSet::new();
    let mut words: HashSet<String> = HashSet::new();
    let mut tests: HashSet<String> = HashSet::new();
    let mut defined: Vec<(String, String, String, Value)> = vec![];
    let mut dynamic = 0;
    for key in sources.keys() {
        let Some((uri, text)) = sources.text(key) else {
            continue;
        };
        let lines = Lines::new(&text);
        let placement = sources.placement(key);
        for m in &mentions(&text) {
            // Each name as q has it where the file is loaded (#2046).
            let names = sources.names(&text, m, &placement);
            match &m.definition {
                Some(d) if d.holds_function => {
                    defined.extend(names.into_iter().map(|name| {
                        (
                            key.to_string(),
                            uri.clone(),
                            name,
                            range(&lines, m.at, m.len),
                        )
                    }));
                }
                Some(_) => {}
                None => {
                    read.extend(names);
                    // Written without a dot, it may be read in a context
                    // the file is loaded in, or in `.q`.
                    let spelled = &text[m.at..m.at + m.len];
                    if !spelled.starts_with('.') {
                        read.insert(spelled.to_string());
                    }
                }
            }
        }
        spelled(&text, &mut words);
        for run in runnables(&text, &placement) {
            if run.test.is_some() {
                tests.insert(text[run.at..run.at + run.len].to_string());
            }
        }
        dynamic += q_lint_rs::references(&text, false).dynamic.len();
    }
    let mut seen = HashSet::new();
    let mut out = vec![];
    for (key, uri, name, at) in defined {
        if only.as_ref().is_some_and(|o| *o != key) || !seen.insert((key.clone(), name.clone())) {
            continue;
        }
        let leaf = name.rsplit('.').next().unwrap_or(&name);
        let used = read.contains(&name)
            || read.contains(leaf)
            || words.contains(&name)
            || words.contains(leaf)
            || name.starts_with(".z.")
            || tests.contains(&name)
            || tests.contains(leaf);
        if used {
            continue;
        }
        out.push(json!({"name": name, "uri": uri, "range": at}));
    }
    json!({"functions": out, "dynamic": dynamic})
}

/// The statement of the top-level function `m` defines, when it defines
/// one. A function assigned inside a lambda, `g::{x}`, spans its name alone
/// and is part of the statement around it (#1360); one named further into
/// its statement, the `b` of `a:b:{x}`, has that statement (#2954).
fn top_level(m: &Mention) -> Option<&Definition> {
    m.definition
        .as_ref()
        .filter(|d| d.function && d.start <= m.at && d.end > m.at + m.len)
}

/// Each top-level function a text defines, by name, with its statements in
/// order: every one, since q keeps the last of two (#1359).
/// Named as q has them where the file `key` is loaded (#2046).
fn statements(text: &str, sources: &Sources, key: &str) -> BTreeMap<String, Vec<String>> {
    let placement = sources.placement(key);
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for m in &mentions(text) {
        if let Some(d) = top_level(m) {
            for name in sources.names(text, m, &placement) {
                out.entry(name)
                    .or_default()
                    .push(text[d.start..d.end].trim_end().to_string());
            }
        }
    }
    out
}

/// `q-lint/testsReaching`: given `textDocument` and the `previous` text the
/// client saw of it, `{changed: [names], tests: [{uri, name, qualified}]}` - the
/// functions whose statements differ, are new or are gone, and every test
/// that reaches one of them, the changed tests themselves included.
fn tests_reaching(params: &Value, sources: &Sources) -> Value {
    let Some((uri, now)) = sources.document(params) else {
        return Value::Null;
    };
    let key = file_key(&path_of(uri));
    let previous = params["previous"].as_str().unwrap_or("");
    let (before, after) = (
        statements(previous, sources, &key),
        statements(now, sources, &key),
    );
    // One deleted, or made a value, is in `before` alone, and what called
    // it now fails.
    let changed: Vec<String> = before
        .keys()
        .chain(after.keys())
        .filter(|&name| before.get(name) != after.get(name))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .cloned()
        .collect();
    // Who names whom: each name read inside a top-level definition's
    // statement is an edge from that definition to it, the name as q
    // resolves it where the file is loaded, and as written - a bare read
    // in a lambda is looked up at the root too. Any definition that
    // carries its statement, as for the call hierarchy: `al:f` and
    // `h:f each` run `f` whenever the names they define are called (#2811).
    let mut callers: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let mut tests: Vec<(String, String, Vec<String>, String)> = vec![];
    for key in sources.keys() {
        let Some((uri, text)) = sources.text(key) else {
            continue;
        };
        let placement = sources.placement(key);
        // The statements still open at a mention: one, or each name of
        // `a:b:f`.
        let mut spans: Vec<(usize, Vec<String>)> = vec![];
        let all = mentions(&text);
        for m in &all {
            spans.retain(|(end, _)| m.at < *end);
            match &m.definition {
                Some(d) => {
                    if (d.start, d.end) != (m.at, m.at + m.len) {
                        spans.push((d.end, sources.names(&text, m, &placement)));
                    }
                }
                None => {
                    if spans.is_empty() {
                        continue;
                    }
                    let spelled = text[m.at..m.at + m.len].to_string();
                    let mut callees = sources.names(&text, m, &placement);
                    callees.push(spelled);
                    for callee in callees {
                        let into = callers.entry(callee).or_default();
                        for (_, caller) in &spans {
                            into.extend(caller.iter().cloned());
                        }
                    }
                }
            }
        }
        for run in runnables(&text, &placement) {
            if run.test.is_some() {
                let spelled = text[run.at..run.at + run.len].to_string();
                let resolved = all.iter().find(|m| m.at == run.at).map_or_else(
                    || vec![spelled.clone()],
                    |m| sources.names(&text, m, &placement),
                );
                tests.push((uri.clone(), spelled, resolved, run.name));
            }
        }
    }
    // Everything that reaches a changed function, breadth first; each name
    // once, so a cycle ends.
    let mut reached: HashSet<String> = changed.iter().cloned().collect();
    let mut queue: Vec<String> = changed.clone();
    while let Some(name) = queue.pop() {
        for caller in callers.get(&name).into_iter().flatten() {
            if reached.insert(caller.clone()) {
                queue.push(caller.clone());
            }
        }
    }
    let found: Vec<Value> = tests
        .into_iter()
        .filter(|(_, spelled, resolved, _)| {
            resolved.iter().any(|name| reached.contains(name)) || reached.contains(spelled)
        })
        .map(|(uri, name, _, qualified)| json!({"uri": uri, "name": name, "qualified": qualified}))
        .collect();
    json!({"changed": changed, "tests": found})
}
