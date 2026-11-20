//! Help while a line is read or written: hover, signature help, and - when
//! asked for - completion.
//!
//! WHAT IS SHOWN
//!
//! For a name the workspace defines: the parameters its definition spells
//! and the comment directly above it, read from the file that defines it
//! when the request is made, as navigation reads them. For a name q defines:
//! its entry in the catalogue the binary carries (`builtins.json`). Nothing
//! is evaluated, so no type and no value is ever shown - only what the
//! source says, which is also why a local gets no hover: all there is to
//! say about one is on the screen already.
//!
//! WHY COMPLETION IS OFF UNLESS ASKED FOR
//!
//! An editor told that a server completes stops offering the words of the
//! open buffers, and what is offered here is narrower than that: the names
//! the workspace index holds, a lambda's locals, and the catalogue. Columns
//! of a table, keys of a dictionary and anything built at run time are not
//! among them. So it is the user's trade to make (`completion.enable`).
use super::navigate::{Cursor, Sources, range};
use super::{Lines, file_key, utf16_len};
use q_lint_rs::{
    BUILTINS, Builtin, BuiltinKind, Name, builtin, call_at, comment_above, completing, mentions,
    name_at, word_at,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

/// Where the reference describes a builtin, by its page.
const REFERENCE: &str = "https://code.kx.com/q/ref/";
/// How many definitions of one name a hover describes. A name assigned in
/// more files than that is a convention, and the list no help.
const MAX_DEFINITIONS: usize = 5;
/// How much of a statement's first line a hover quotes.
const MAX_LINE: usize = 120;
/// How many items one completion reply carries. Past that the reply says it
/// is incomplete, and the client asks again as the name grows.
const MAX_ITEMS: usize = 1000;
/// LSP's `CompletionItemKind`s, of the ones every client draws.
const FUNCTION: u8 = 3;
const VARIABLE: u8 = 6;
const KEYWORD: u8 = 14;

/// What the client said it can draw. Markdown is sent only where it is
/// asked for: a client that shows the text as it comes would show the
/// markers.
#[derive(Clone, Copy, Default)]
pub(super) struct Client {
    hover_markdown: bool,
    signature_markdown: bool,
    /// A parameter named as a span of its signature's label, and not as a
    /// string to find there - which finds the first `x` of `x in x`.
    label_offsets: bool,
    completion_markdown: bool,
}

impl Client {
    pub(super) fn read(params: &Value) -> Self {
        let at = |pointer: &str| params.pointer(&format!("/capabilities/textDocument/{pointer}"));
        let markdown = |pointer: &str| {
            at(pointer)
                .and_then(Value::as_array)
                .is_some_and(|formats| formats.iter().any(|format| format == "markdown"))
        };
        Client {
            hover_markdown: markdown("hover/contentFormat"),
            signature_markdown: markdown("signatureHelp/signatureInformation/documentationFormat"),
            label_offsets: at(
                "signatureHelp/signatureInformation/parameterInformation/labelOffsetSupport",
            )
            .and_then(Value::as_bool)
            .unwrap_or(false),
            completion_markdown: markdown("completion/completionItem/documentationFormat"),
        }
    }
}

/// What the server adds to its capabilities for the requests answered here.
/// Signature help opens at a `[` and follows the `;`s; completion, when it
/// is on, also opens at the `.` of a qualified name, which is no part of a
/// word to most editors.
pub(super) fn announce(capabilities: &mut Value, help: bool, completion: bool) {
    if help {
        capabilities["hoverProvider"] = json!(true);
        capabilities["signatureHelpProvider"] =
            json!({"triggerCharacters": ["["], "retriggerCharacters": [";"]});
    }
    if completion {
        capabilities["completionProvider"] = json!({"triggerCharacters": ["."]});
    }
}

pub(super) fn answer(method: &str, params: &Value, sources: &Sources, client: Client) -> Value {
    match method {
        "textDocument/hover" => hover(params, sources, client),
        "textDocument/signatureHelp" => signature_help(params, sources, client),
        "textDocument/completion" => completion(params, sources, client),
        _ => Value::Null,
    }
}

/// One assignment of a global, as a hover and a signature describe it.
struct Defined {
    name: String,
    /// What a caller passes, when what is assigned is a lambda.
    params: Option<Vec<String>>,
    comment: String,
    /// The first line of the statement.
    line: String,
    file: String,
}

impl Defined {
    fn label(&self) -> Option<String> {
        self.params
            .as_ref()
            .map(|params| format!("{}[{}]", self.name, params.join(";")))
    }
}

/// Each place a file writes one of `names`, read as `Sources::definitions`
/// reads them and in its order, best first for a reader in the file `from`,
/// up to `MAX_DEFINITIONS`.
fn defined(sources: &Sources, names: &HashSet<String>, from: &str) -> Vec<Defined> {
    let mut out = vec![];
    for key in sources.definers(names, from) {
        let file = &sources.idx.files[key];
        let Some((_, text)) = sources.text(key) else {
            continue;
        };
        for m in &mentions(&text) {
            let Some(definition) = &m.definition else {
                continue;
            };
            let mut answers = sources.names(&text, m, &file.placement);
            answers.retain(|name| names.contains(name));
            answers.sort_unstable();
            let Some(name) = answers.into_iter().next() else {
                continue;
            };
            if out.len() == MAX_DEFINITIONS {
                return out;
            }
            let statement = text[definition.start..definition.end]
                .lines()
                .next()
                .unwrap_or_default()
                .trim_end();
            let line = match statement.char_indices().nth(MAX_LINE) {
                Some((cut, _)) => format!("{} ...", &statement[..cut]),
                None => statement.to_string(),
            };
            out.push(Defined {
                name,
                params: definition.function.then(|| definition.params.clone()),
                comment: comment_above(&text, definition.start),
                line,
                file: shown(sources, key),
            });
        }
    }
    out
}

/// A file as a hover names it: under the workspace folder that holds it,
/// or by its name alone.
fn shown(sources: &Sources, key: &str) -> String {
    let path = std::path::Path::new(key);
    sources
        .idx
        .roots
        .iter()
        .find_map(|root| path.strip_prefix(file_key(root)).ok())
        .or_else(|| path.file_name().map(std::path::Path::new))
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Text that is not markdown, as markdown that draws it as written: every
/// mark escaped, each line break kept, and indentation held by spaces that
/// do not collapse. A comment is full of `*`, `_` and `` ` ``, and is not
/// asking to be formatted by them.
fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    for (n, line) in text.lines().enumerate() {
        if n > 0 {
            out.push_str("  \n");
        }
        let body = line.trim_start_matches(' ');
        out.extend(std::iter::repeat_n('\u{a0}', line.len() - body.len()));
        for c in body.chars() {
            if c.is_ascii_punctuation() {
                out.push('\\');
            }
            out.push(c);
        }
    }
    out
}

/// q in a fenced block, behind a fence longer than any run of backticks in
/// it: three empty symbols in a row are q, and would close a fence of three.
fn fenced(code: &str) -> String {
    let (mut longest, mut run) = (0, 0);
    for c in code.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat((longest + 1).max(3));
    format!("{fence}q\n{code}\n{fence}")
}

/// The parts of one description, as markdown or as plain text: what is
/// written, then what is said about it, then where it is from.
fn described(
    code: &str,
    said: &str,
    from: Option<(&str, Option<String>)>,
    markdown: bool,
) -> String {
    let mut parts = vec![];
    parts.push(if markdown {
        fenced(code)
    } else {
        code.to_string()
    });
    if !said.is_empty() {
        parts.push(if markdown {
            escaped(said)
        } else {
            said.to_string()
        });
    }
    match from {
        Some((label, Some(link))) if markdown => {
            parts.push(format!("[{}]({link})", escaped(label)))
        }
        Some((_, Some(link))) => parts.push(link),
        Some((label, None)) if markdown => parts.push(format!("*{}*", escaped(label))),
        Some((label, None)) => parts.push(label.to_string()),
        None => {}
    }
    parts.join("\n\n")
}

fn builtin_described(builtin: &Builtin, markdown: bool) -> String {
    let link = builtin
        .page
        .as_ref()
        .map(|page| format!("{REFERENCE}{page}/"));
    described(
        &builtin.syntax,
        &builtin.summary,
        link.map(|link| ("Reference", Some(link))),
        markdown,
    )
}

/// `textDocument/hover`: for a global, each definition the workspace has of
/// it - a function as its name and parameters, anything else as the line
/// that assigns it - with the comment above, the best first; for a name q
/// defines, its catalogue entry; for the path of a load, the file it loads.
/// Nothing for a local, and nothing for a name nobody defines.
fn hover(params: &Value, sources: &Sources, client: Client) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return Value::Null;
    };
    let markdown = client.hover_markdown;
    if let Some((at, len, files)) = sources.load_under(&cursor) {
        return loaded(sources, &cursor, at, len, &files, markdown);
    }
    let builtin_at = |at: usize, len: usize| {
        builtin(&cursor.text[at..at + len]).map(|b| builtin_described(b, markdown))
    };
    let (at, len, sections) = match name_at(cursor.text, cursor.offset) {
        Some(Name::Local(_)) => return Value::Null,
        Some(Name::Global { at, len, .. }) => {
            let sections: Vec<String> =
                defined(sources, &sources.targets(&cursor, at), &cursor.key)
                    .iter()
                    .map(|d| {
                        let code = d.label().unwrap_or_else(|| d.line.clone());
                        described(&code, &d.comment, Some((&d.file, None)), markdown)
                    })
                    .collect();
            if sections.is_empty() {
                (at, len, builtin_at(at, len).into_iter().collect())
            } else {
                (at, len, sections)
            }
        }
        // A keyword is no name to `name_at`, and is one here.
        None => match word_at(cursor.text, cursor.offset) {
            Some((at, len)) => (at, len, builtin_at(at, len).into_iter().collect()),
            None => return Value::Null,
        },
    };
    if sections.is_empty() {
        return Value::Null;
    }
    let lines = Lines::new(cursor.text);
    json!({
        "contents": {
            "kind": if markdown { "markdown" } else { "plaintext" },
            "value": sections.join(if markdown { "\n\n---\n\n" } else { "\n\n" }),
        },
        "range": range(&lines, at, len),
    })
}

/// The hover on the path of a load: the file it loads, under the workspace
/// folder that holds it - or the scripts, for a directory. Nothing for a
/// load that leads nowhere.
fn loaded(
    sources: &Sources,
    cursor: &Cursor,
    at: usize,
    len: usize,
    files: &[String],
    markdown: bool,
) -> Value {
    if files.is_empty() {
        return Value::Null;
    }
    let shown: Vec<String> = files
        .iter()
        .map(|file| {
            let file = shown(sources, file);
            if markdown { escaped(&file) } else { file }
        })
        .collect();
    json!({
        "contents": {
            "kind": if markdown { "markdown" } else { "plaintext" },
            "value": shown.join(if markdown { "  \n" } else { "\n" }),
        },
        "range": range(&Lines::new(cursor.text), at, len),
    })
}

/// One way to call a name: how it is written, what it takes, and what is
/// said about it.
struct Signature {
    name: String,
    params: Vec<String>,
    said: String,
    /// The last parameter stands for any number more, as in `if[test;e1;...]`.
    open: bool,
}

/// The signatures of the name called at `at..at + len` of the cursor's
/// document: the workspace's functions of that name, one for each list of
/// parameters, or q's own.
fn signatures(sources: &Sources, cursor: &Cursor, at: usize, len: usize) -> Vec<Signature> {
    let mut found: Vec<Signature> = vec![];
    match name_at(cursor.text, at) {
        // What a local holds is whatever was assigned to it last.
        Some(Name::Local(_)) => return found,
        Some(Name::Global { at, .. }) => {
            for d in defined(sources, &sources.targets(cursor, at), &cursor.key) {
                let Some(params) = d.params else { continue };
                if !found.iter().any(|s| s.name == d.name && s.params == params) {
                    found.push(Signature {
                        name: d.name,
                        params,
                        said: d.comment,
                        open: false,
                    });
                }
            }
        }
        None => {}
    }
    if found.is_empty()
        && let Some(b) = builtin(&cursor.text[at..at + len])
        && matches!(b.kind, BuiltinKind::Function | BuiltinKind::Control)
        && !b.params.is_empty()
    {
        found.push(Signature {
            name: b.name.clone(),
            params: b.params.clone(),
            said: b.summary.clone(),
            open: b.kind == BuiltinKind::Control,
        });
    }
    found
}

/// `textDocument/signatureHelp`: the parameters of the name whose brackets
/// the cursor is in, and which of them is being written - counted by the
/// `;`s before the cursor. Nothing for what is not called by a name: a
/// lambda written in place, or an operator's bracket form.
fn signature_help(params: &Value, sources: &Sources, client: Client) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return Value::Null;
    };
    let Some(call) = call_at(cursor.text, cursor.offset) else {
        return Value::Null;
    };
    let found = signatures(sources, &cursor, call.at, call.len);
    if found.is_empty() {
        return Value::Null;
    }
    // The first that takes as many arguments as are written, when the name
    // has several definitions.
    let active = found
        .iter()
        .position(|s| s.open || call.argument < s.params.len())
        .unwrap_or(0);
    let parameter = |s: &Signature| {
        if s.open {
            call.argument.min(s.params.len() - 1)
        } else {
            call.argument
        }
    };
    let listed: Vec<Value> = found
        .iter()
        .map(|s| {
            let mut label = format!("{}[", s.name);
            let mut parameters = vec![];
            for (n, param) in s.params.iter().enumerate() {
                if n > 0 {
                    label.push(';');
                }
                let start = utf16_len(&label);
                label.push_str(param);
                parameters.push(if client.label_offsets {
                    json!({"label": [start, utf16_len(&label)]})
                } else {
                    json!({"label": param})
                });
            }
            label.push(']');
            let mut signature = json!({
                "label": label,
                "parameters": parameters,
                "activeParameter": parameter(s),
            });
            if !s.said.is_empty() {
                signature["documentation"] = documentation(&s.said, client.signature_markdown);
            }
            signature
        })
        .collect();
    json!({
        "signatures": listed,
        "activeSignature": active,
        "activeParameter": parameter(&found[active]),
    })
}

fn documentation(said: &str, markdown: bool) -> Value {
    if markdown {
        json!({"kind": "markdown", "value": escaped(said)})
    } else {
        json!(said)
    }
}

/// Whether the letters of `typed` are in `name` in that order, in either
/// case: the loosest match an editor makes, so nothing it would show is
/// kept from it.
fn fuzzy(typed: &str, name: &str) -> bool {
    let mut name = name.chars().map(|c| c.to_ascii_lowercase());
    typed
        .chars()
        .all(|c| name.any(|n| n == c.to_ascii_lowercase()))
}

/// `textDocument/completion`: the names that can be written at the cursor -
/// the locals of the lambda it is in, the workspace's globals as they are
/// spelled from here, and q's own - narrowed by what is typed so far. In
/// that order, since the nearer a name is defined the likelier it is meant.
/// After a dot, only names that continue the qualified name being written.
fn completion(params: &Value, sources: &Sources, client: Client) -> Value {
    let nothing = json!({"isIncomplete": false, "items": []});
    let Some(cursor) = sources.cursor(params) else {
        return nothing;
    };
    let Some(typing) = completing(cursor.text, cursor.offset) else {
        return nothing;
    };
    let typed = &cursor.text[typing.start..cursor.offset];
    let stem = typed.rfind('.').map_or("", |dot| &typed[..=dot]);
    let lines = Lines::new(cursor.text);
    let span = json!({"start": lines.json(typing.start), "end": lines.json(cursor.offset)});
    // By (group, spelling), so the first to claim a spelling keeps it.
    let mut items: BTreeMap<String, (u8, Value)> = BTreeMap::new();
    let mut offer = |group: u8, spelling: &str, kind: u8, builtin: Option<&Builtin>| {
        if !spelling.starts_with(stem) || !fuzzy(typed, spelling) {
            return;
        }
        let known = items.get(spelling).map(|(group, _)| *group);
        if known.is_some_and(|known| known <= group) {
            return;
        }
        let mut item = json!({
            "label": spelling,
            "kind": kind,
            "sortText": format!("{group}{spelling}"),
            "filterText": spelling,
            "textEdit": {"range": span, "newText": spelling},
        });
        if let Some(builtin) = builtin {
            item["detail"] = json!(builtin.syntax);
            item["documentation"] = documentation(&builtin.summary, client.completion_markdown);
        }
        items.insert(spelling.to_string(), (group, item));
    };
    if stem.is_empty() {
        for local in &typing.locals {
            offer(0, local, VARIABLE, None);
        }
    }
    // Where a name written without a leading dot lands: under the `\d` in
    // force, or - before the file's first - wherever its loaders put it.
    let placement = sources.placement(&cursor.key);
    let (contexts, root): (Vec<&str>, bool) = if typing.namespace.is_empty() {
        (
            placement.contexts.iter().map(String::as_str).collect(),
            placement.root,
        )
    } else {
        (vec![typing.namespace.as_str()], false)
    };
    for (name, lambda) in sources.idx.ws.names() {
        let kind = if lambda { FUNCTION } else { VARIABLE };
        if !name.starts_with('.') {
            if root {
                offer(1, name, kind, None);
            }
            continue;
        }
        for context in &contexts {
            if let Some(relative) = name
                .strip_prefix(context)
                .and_then(|rest| rest.strip_prefix('.'))
            {
                offer(1, relative, kind, None);
            }
        }
        offer(3, name, kind, None);
    }
    for b in BUILTINS.iter() {
        let kind = match b.kind {
            BuiltinKind::Function | BuiltinKind::Callback => FUNCTION,
            BuiltinKind::Control | BuiltinKind::Query => KEYWORD,
            BuiltinKind::Constant | BuiltinKind::Variable => VARIABLE,
        };
        let group = if b.name.starts_with('.') { 3 } else { 2 };
        offer(group, &b.name, kind, Some(b));
    }
    let mut ranked: Vec<(u8, String, Value)> = items
        .into_iter()
        .map(|(spelling, (group, item))| (group, spelling, item))
        .collect();
    ranked.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    let incomplete = ranked.len() > MAX_ITEMS;
    ranked.truncate(MAX_ITEMS);
    json!({
        "isIncomplete": incomplete,
        "items": ranked.into_iter().map(|(_, _, item)| item).collect::<Vec<_>>(),
    })
}
