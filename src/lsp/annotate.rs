//! What the server draws over the text of a document: parameter names at the
//! arguments of a call (inlay hints).
//!
//! Read from the source as navigation reads it, and never by running it: a
//! hint names the parameters a function's definition spells.
use super::navigate::Sources;
use super::{Lines, file_key, path_of};
use q_lint_rs::{Mention, bracket_calls, mentions};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// LSP's `InlayHintKind` for a parameter.
const PARAMETER: u8 = 2;

/// What the server adds to its capabilities for the requests answered here.
pub(super) fn announce(capabilities: &mut Value, hints: bool) {
    if hints {
        capabilities["inlayHintProvider"] = json!(true);
    }
}

pub(super) fn answer(method: &str, params: &Value, sources: &Sources) -> Value {
    match method {
        "textDocument/inlayHint" => inlay_hints(params, sources),
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
