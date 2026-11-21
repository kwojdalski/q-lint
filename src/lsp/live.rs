//! What a client asks before it talks to a q process: the tests the
//! workspace defines (`q-lint/tests`), the global a position names
//! (`q-lint/globalAt`), and the globals a document reads that no workspace
//! file defines (`q-lint/unresolvedNames`).
//!
//! The server still runs nothing and connects to nothing. These answer from
//! the source, as navigation does, and the client - which has the process -
//! runs the tests, reads the value, or asks which of the names the process
//! defines. Each is answered only to a client that asks for it, and the
//! VS Code extension asks only while the feature's setting is on.
use super::annotate::runnables;
use super::navigate::{Sources, range};
use super::{Lines, file_key, path_of};
use q_lint_rs::{Name, mentions, name_at};
use serde_json::{Value, json};

/// The three, under `experimental` by the names they are asked by.
pub(super) fn announce(capabilities: &mut Value) {
    for method in ["q-lint/tests", "q-lint/globalAt", "q-lint/unresolvedNames"] {
        capabilities["experimental"][method] = json!(true);
    }
}

pub(super) fn answer(method: &str, params: &Value, sources: &Sources) -> Value {
    match method {
        "q-lint/tests" => tests(params, sources),
        "q-lint/globalAt" => global_at(params, sources),
        "q-lint/unresolvedNames" => unresolved(params, sources),
        _ => Value::Null,
    }
}

/// `q-lint/tests`: each test function a statement at column 0 defines -
/// the ones a **Run test** lens is drawn over - in the document
/// `textDocument` names, or with none in every indexed file. Per file, its
/// `uri` and each test's `name` as written, `range`, the `code` that defines
/// it under its `\d`, and the `call` that runs it.
fn tests(params: &Value, sources: &Sources) -> Value {
    let keys: Vec<String> = match params["textDocument"]["uri"].as_str() {
        Some(uri) => vec![file_key(&path_of(uri))],
        None => sources.keys().into_iter().map(str::to_string).collect(),
    };
    let mut files = vec![];
    for key in keys {
        let Some((uri, text)) = sources.text(&key) else {
            continue;
        };
        let lines = Lines::new(&text);
        let tests: Vec<Value> = runnables(&text)
            .into_iter()
            .filter_map(|run| {
                let call = run.test?;
                Some(json!({
                    "name": &text[run.at..run.at + run.len],
                    "range": range(&lines, run.at, run.len),
                    "code": run.code,
                    "call": call,
                }))
            })
            .collect();
        if !tests.is_empty() {
            files.push(json!({"uri": uri, "tests": tests}));
        }
    }
    json!(files)
}

/// `q-lint/globalAt`: the global at `position` - `{names, range}`, each name
/// q may resolve it to - or null on a local, a word of q's, or nothing.
fn global_at(params: &Value, sources: &Sources) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return Value::Null;
    };
    let Some(Name::Global { at, len, .. }) = name_at(cursor.text, cursor.offset) else {
        return Value::Null;
    };
    let mut names: Vec<String> = sources.targets(&cursor, at).into_iter().collect();
    names.sort();
    if names.is_empty() {
        return Value::Null;
    }
    json!({"names": names, "range": range(&Lines::new(cursor.text), at, len)})
}

/// `q-lint/unresolvedNames`: each global the document reads that no indexed
/// file defines - by each name q may resolve it to, where it is written -
/// for a client to ask a process about. Not a word of q's, not a name in a
/// one-letter namespace (`.z.pc`, `.Q.dd`), which are q's own, not one in a
/// qSQL phrase but the table's, and not one in a system command.
fn unresolved(params: &Value, sources: &Sources) -> Value {
    let Some((uri, text)) = sources.document(params) else {
        return json!([]);
    };
    let key = file_key(&path_of(uri));
    let placement = sources.placement(&key);
    let lines = Lines::new(text);
    let all = mentions(text);
    let clauses = q_lint_rs::query_clauses(text, &all.iter().map(|m| m.at).collect::<Vec<_>>());
    let mut out = vec![];
    for (m, clause) in all.into_iter().zip(clauses) {
        // A name in a query's phrase may be a column of its table, which
        // only the table says; the table after `from` is a global.
        if m.definition.is_some() || clause.is_some_and(|c| c != "from") {
            continue;
        }
        let written = &text[m.at..m.at + m.len];
        if q_lint_rs::is_reserved(written) || q_lint_rs::builtin(written).is_some() {
            continue;
        }
        let names = sources.names(text, &m, &placement);
        let qs = |name: &str| {
            let mut parts = name.split('.');
            name.starts_with('.') && parts.nth(1).is_some_and(|ns| ns.len() == 1)
        };
        if names.is_empty()
            || names
                .iter()
                .any(|name| qs(name) || sources.idx.ws.defines(name))
        {
            continue;
        }
        out.push(json!({
            "names": names,
            "written": written,
            "range": range(&lines, m.at, m.len),
        }));
    }
    json!(out)
}
