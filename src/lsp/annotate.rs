//! What the server draws over the text of a document: parameter names at the
//! arguments of a call (inlay hints), a Run lens above each function
//! definition (code lenses), and each load's path as a link to the file it
//! loads (document links).
//!
//! Each is read from the source as navigation reads it, and none runs it. A
//! hint names the parameters a function's definition spells, a lens hands
//! the editor the statement to send, and a link goes where Go to Definition
//! on the path goes.
use super::navigate::{Sources, range};
use super::{Lines, file_key, path_of};
use q_lint_rs::{Mention, bracket_calls, completing, load_paths, mentions};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// LSP's `InlayHintKind` for a parameter.
const PARAMETER: u8 = 2;
/// The command a lens runs: the client's, which sends the code it is given
/// to the connected q process as a query from the editor would be sent.
/// Only an editor that registers it is offered lenses (`codeLens.enable`).
const RUN_COMMAND: &str = "q-lint.runDefinition";

/// What the server adds to its capabilities for the requests answered here.
pub(super) fn announce(capabilities: &mut Value, hints: bool, lenses: bool, links: bool) {
    if hints {
        capabilities["inlayHintProvider"] = json!(true);
    }
    if lenses {
        capabilities["codeLensProvider"] = json!({"resolveProvider": false});
    }
    if links {
        capabilities["documentLinkProvider"] = json!({"resolveProvider": false});
    }
}

pub(super) fn answer(method: &str, params: &Value, sources: &Sources) -> Value {
    match method {
        "textDocument/inlayHint" => inlay_hints(params, sources),
        "textDocument/codeLens" => code_lenses(params, sources),
        "textDocument/documentLink" => document_links(params, sources),
        _ => Value::Null,
    }
}

/// `textDocument/inlayHint`: at each argument of a bracketed call to a
/// workspace function in the range, the name of the parameter it is passed
/// as - `f[a:1;b:2]` drawn over `f[1;2]`.
///
/// Only for a function whose every definition declares its parameters in a
/// signature and declares the same ones: `x`, `y` and `z` say nothing a
/// reader does not know, and two definitions that disagree leave which one
/// is called to whatever ran last. Not at an empty slot of a projection,
/// past the last parameter, or at an argument written as the parameter's
/// own name, where the hint would repeat it.
fn inlay_hints(params: &Value, sources: &Sources) -> Value {
    let Some((uri, text)) = sources.document(params) else {
        return json!([]);
    };
    let key = file_key(&path_of(uri));
    let lines = Lines::new(text);
    let offset = |position: &Value| {
        Some(lines.offset(
            position["line"].as_u64()? as usize,
            position["character"].as_u64()? as usize,
        ))
    };
    let from = offset(&params["range"]["start"]).unwrap_or(0);
    let to = offset(&params["range"]["end"]).unwrap_or(text.len());
    let placement = sources.placement(&key);
    let all = mentions(text);
    let mut at: HashMap<usize, Vec<&Mention>> = HashMap::new();
    for m in &all {
        at.entry(m.at).or_default().push(m);
    }
    let mut known: HashMap<Vec<String>, Option<Vec<String>>> = HashMap::new();
    let mut hints = vec![];
    for call in bracket_calls(text) {
        if call.at < from || call.at > to {
            continue;
        }
        // A local's or q's own name is no mention; an indexed assignment,
        // `d[k]:v`, is a write.
        let Some(found) = at.get(&call.at) else {
            continue;
        };
        if found.iter().any(|m| m.definition.is_some()) {
            continue;
        }
        let mut names: Vec<String> = found
            .iter()
            .flat_map(|m| sources.names(text, m, &placement))
            .collect();
        names.sort_unstable();
        names.dedup();
        let declared = known
            .entry(names)
            .or_insert_with_key(|names| declared(sources, names, &key));
        let Some(declared) = declared else {
            continue;
        };
        for (&(start, len), param) in call.arguments.iter().zip(declared.iter()) {
            if len == 0 || text[start..start + len] == **param {
                continue;
            }
            hints.push(json!({
                "position": lines.json(start),
                "label": format!("{param}:"),
                "kind": PARAMETER,
                "paddingRight": true,
            }));
        }
    }
    json!(hints)
}

/// The parameters every definition of the global known by `names` declares
/// in a signature, when there is at least one and they agree.
fn declared(sources: &Sources, names: &[String], from: &str) -> Option<Vec<String>> {
    let wanted: HashSet<String> = names.iter().cloned().collect();
    let mut agreed: Option<Vec<String>> = None;
    for key in sources.definers(&wanted, from) {
        let (_, text) = sources.text(key)?;
        let placement = sources.placement(key);
        for m in &mentions(&text) {
            let Some(definition) = &m.definition else {
                continue;
            };
            if !sources
                .names(&text, m, &placement)
                .iter()
                .any(|name| wanted.contains(name))
            {
                continue;
            }
            if !definition.function || definition.detail.is_empty() {
                return None;
            }
            match &agreed {
                Some(params) if *params != definition.params => return None,
                Some(_) => {}
                None => agreed = Some(definition.params.clone()),
            }
        }
    }
    agreed.filter(|params| !params.is_empty())
}

/// `textDocument/codeLens`: above each function a statement at column 0
/// defines, **Run**, which sends that statement to the connected process -
/// under the `\d` it is written in, and back to the root after - and above a
/// function whose name starts `test_`, **Run test** too, which sends it and
/// then calls it with no argument.
///
/// The code is the lens's argument, as the text is when the lenses are
/// asked for: an editor asks again as the document changes.
fn code_lenses(params: &Value, sources: &Sources) -> Value {
    let Some((uri, text)) = sources.document(params) else {
        return json!([]);
    };
    let lines = Lines::new(text);
    let mut lenses = vec![];
    let mut seen = HashSet::new();
    for m in &mentions(text) {
        let Some(definition) = &m.definition else {
            continue;
        };
        if !definition.function
            || m.at != definition.start
            || !(m.at == 0 || text[..m.at].ends_with('\n'))
            || !seen.insert(m.at)
        {
            continue;
        }
        let spelled = &text[m.at..m.at + m.len];
        let statement = text[definition.start..definition.end].trim_end();
        let context = completing(text, m.at)
            .map(|c| c.namespace)
            .filter(|ns| !ns.is_empty() && ns != ".");
        let code = match &context {
            Some(ns) => format!("\\d {ns}\n{statement}\n\\d ."),
            None => statement.to_string(),
        };
        let at = range(&lines, m.at, m.len);
        let lens = |title: &str, code: String| {
            json!({"range": at, "command": {"title": title, "command": RUN_COMMAND,
                                             "arguments": [code, uri]}})
        };
        lenses.push(lens("Run", code.clone()));
        if spelled
            .rsplit('.')
            .next()
            .unwrap_or(spelled)
            .starts_with("test_")
        {
            // Called by the name it has once defined: a bare one before the
            // file's first `\d` is wherever the process puts it, the root
            // for a query.
            let name = if m.implicit { spelled } else { &m.name };
            lenses.push(lens("Run test", format!("{code}\n{name}[]")));
        }
    }
    json!(lenses)
}

/// `textDocument/documentLink`: the path of each load - `\l path`,
/// `system "l path"` or a file symbol `` `:lib/x.q `` - as a link to the
/// file it loads, followed as Go to Definition follows it: against the
/// workspace folder, then the loading file's own directory and each one
/// above it. No link for a load that reaches no file, or a directory, which
/// loads several.
fn document_links(params: &Value, sources: &Sources) -> Value {
    let Some((uri, text)) = sources.document(params) else {
        return json!([]);
    };
    let key = file_key(&path_of(uri));
    let lines = Lines::new(text);
    load_paths(text)
        .into_iter()
        .filter_map(|(at, len)| {
            let [file] = sources
                .loaded(&key, &text[at..at + len], true)
                .try_into()
                .ok()?;
            Some(json!({
                "range": range(&lines, at, len),
                "target": sources.uri(&file),
                "tooltip": format!("Open {}", super::help::shown(sources, &file)),
            }))
        })
        .collect()
}
