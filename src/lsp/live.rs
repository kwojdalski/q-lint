//! What a client asks before it talks to a q process: the tests the
//! workspace defines (`q-lint/tests`), the global a position names
//! (`q-lint/globalAt`), the globals a document reads that no workspace
//! file defines (`q-lint/unresolvedNames`), and which of a process's names
//! the workspace defines (`q-lint/defined`). And one an editor asks as the
//! cursor moves: the argument of a call it is in (`q-lint/argumentSlot`).
//!
//! The server still runs nothing and connects to nothing. These answer from
//! the source, as navigation does, and the client - which has the process -
//! runs the tests, reads the value, or asks which of the names the process
//! defines. Each is answered only to a client that asks for it, and the
//! VS Code extension asks only while the feature's setting is on.
use super::annotate::{self, runnables};
use super::navigate::{Sources, range};
use super::{Lines, file_key, path_of};
use q_lint_rs::{Name, argument_slots, call_at, mentions, name_at};
use serde_json::{Value, json};

/// Each, under `experimental` by the name it is asked by.
pub(super) fn announce(capabilities: &mut Value) {
    for method in [
        "q-lint/tests",
        "q-lint/globalAt",
        "q-lint/unresolvedNames",
        "q-lint/argumentSlot",
        "q-lint/defined",
    ] {
        capabilities["experimental"][method] = json!(true);
    }
}

/// `hints`: whether the server draws parameter names as inlay hints, which
/// an argument slot's answer says of its own slot.
pub(super) fn answer(method: &str, params: &Value, sources: &Sources, hints: bool) -> Value {
    match method {
        "q-lint/tests" => tests(params, sources),
        "q-lint/globalAt" => global_at(params, sources),
        "q-lint/unresolvedNames" => unresolved(params, sources),
        "q-lint/argumentSlot" => argument_slot(params, sources, hints),
        "q-lint/defined" => defined(params, sources),
        _ => Value::Null,
    }
}

/// `q-lint/argumentSlot`: the argument of a bracketed call the cursor is
/// in - `{range, index, callee, parameter, hinted}` - or null outside one.
/// `range` is the argument as written, blanks trimmed (empty for an empty
/// slot); `parameter` the name of the parameter it is passed as, from the
/// function's definition or q's catalogue, or null where neither says or
/// the slot is past the last; `hinted` whether an inlay hint already writes
/// that name before it.
fn argument_slot(params: &Value, sources: &Sources, hints: bool) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return Value::Null;
    };
    let Some(call) = call_at(cursor.text, cursor.offset) else {
        return Value::Null;
    };
    let Some(&(start, len)) = argument_slots(cursor.text)
        .into_iter()
        .find(|c| c.at == call.at)
        .and_then(|c| c.arguments.get(call.argument).copied())
        .as_ref()
    else {
        return Value::Null;
    };
    let lines = Lines::new(cursor.text);
    let parameter = super::help::parameter(sources, &cursor, call.at, call.len, call.argument);
    let hinted = hints
        && len > 0
        && parameter.as_ref().is_some_and(|p| {
            let asked = json!({"textDocument": params["textDocument"],
                               "range": range(&lines, call.at, start + len - call.at)});
            annotate::answer(
                "textDocument/inlayHint",
                &asked,
                sources,
                annotate::Shown {
                    parameter_hints: true,
                    type_hints: false,
                    run_lenses: false,
                    reference_lenses: false,
                },
            )
            .as_array()
            .is_some_and(|found| {
                found
                    .iter()
                    .any(|h| h["position"] == lines.json(start) && h["label"] == format!("{p}:"))
            })
        });
    json!({
        "range": range(&lines, start, len),
        "index": call.argument,
        "callee": &cursor.text[call.at..call.at + call.len],
        "parameter": parameter,
        "hinted": hinted,
    })
}

/// `q-lint/defined`: for each of `names`, whether an indexed file defines
/// it - for a client listing a process's names to leave out the ones the
/// workspace already lists.
fn defined(params: &Value, sources: &Sources) -> Value {
    params["names"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|name| json!(name.as_str().is_some_and(|n| sources.idx.ws.defines(n))))
        .collect()
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
                    "code": format!("{}{}", run.fixtures, run.code),
                    "call": call,
                    "qualified": run.name,
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
/// one-letter namespace (`.z.pc`, `.Q.dd`), which are q's own - but for
/// `.m`, where KDB-X runs a module's own names - not one in a
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
            name.starts_with('.') && parts.nth(1).is_some_and(|ns| ns.len() == 1 && ns != "m")
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
