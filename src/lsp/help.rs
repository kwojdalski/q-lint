//! Help while a line is read or written: hover, signature help, and - when
//! asked for - completion.
//!
//! WHAT IS SHOWN
//!
//! For a name the workspace defines: the parameters its definition spells
//! and the comment directly above it, read from the file that defines it
//! when the request is made, as navigation reads them. For a name q defines:
//! its entry in the catalogue the binary carries (`builtins.json`). Nothing
//! is evaluated, so no value is ever shown - only what the source says. A
//! local gets a hover only when its assignments settle its type, which the
//! source alone then says (`q_lint_rs::typed_locals`).
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
    BUILTINS, Builtin, BuiltinKind, Name, applied, builtin, call_at, comment_above, completing,
    glyph_at, mentions, name_at, word_at,
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
/// How many names one alias may lead through to a function: `a:b`, `b:c`,
/// `c:{...}` is three. A cycle, `a:b` and `b:a`, ends here too.
const MAX_ALIASES: usize = 4;
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
    /// `null` understood as no active parameter (LSP 3.18).
    no_active_parameter: bool,
    completion_markdown: bool,
    /// A completion's edit given both ways, to insert at the cursor and to
    /// replace the name it is in, for the editor to choose between.
    insert_replace: bool,
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
            no_active_parameter: at("signatureHelp/signatureInformation/noActiveParameterSupport")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            completion_markdown: markdown("completion/completionItem/documentationFormat"),
            insert_replace: at("completion/completionItem/insertReplaceSupport")
                .and_then(Value::as_bool)
                .unwrap_or(false),
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

/// What the settings add to help: a local's inferred type on hover, and the
/// load a completed name needs.
#[derive(Clone, Copy, Default)]
pub(super) struct More {
    pub(super) inferred_types: bool,
    pub(super) auto_load: bool,
    /// Add the query in words on hover over a qSQL lead word or the `?`/`!`
    /// of a functional form (`q_lint_rs::explain_qsql`).
    pub(super) qsql_explain: bool,
}

pub(super) fn answer(
    method: &str,
    params: &Value,
    sources: &Sources,
    client: Client,
    more: More,
) -> Value {
    match method {
        "textDocument/hover" => hover(params, sources, client, more),
        "textDocument/signatureHelp" => signature_help(params, sources, client),
        "textDocument/completion" => completion(params, sources, client, more),
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
    /// What is assigned, when it is no lambda but another name - by the
    /// names that one answers to and as it is spelled - or a projection of
    /// one, by which of its slots are given.
    of: Option<(HashSet<String>, String, Option<Vec<bool>>)>,
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
        let all = mentions(&text);
        for m in &all {
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
            let of = (!definition.function)
                .then(|| applied(&text, m.at + m.len))
                .flatten()
                .map(|a| {
                    let names = all
                        .iter()
                        .filter(|read| read.at == a.at && read.definition.is_none())
                        .flat_map(|read| sources.names(&text, read, &file.placement))
                        .collect();
                    (names, text[a.at..a.at + a.len].to_string(), a.given)
                });
            out.push(Defined {
                name,
                params: definition.function.then(|| definition.params.clone()),
                comment: comment_above(&text, definition.start),
                line,
                file: shown(sources, key),
                of,
            });
        }
    }
    out
}

/// A file as a hover names it: under the workspace folder that holds it,
/// or by its name alone.
pub(super) fn shown(sources: &Sources, key: &str) -> String {
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

/// Whether `before`, the source up to a `!`, ends in a negative integer
/// written as one: `-3`, `(-3)` or `neg[3]`. Not `x-3`, where the `-`
/// subtracts and `3!` is what follows it.
fn negative_integer_before(before: &str) -> bool {
    let line = before
        .rsplit('\n')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '\t']);
    let integer = |s: &str| {
        let s = s.strip_suffix(['h', 'i', 'j']).unwrap_or(s);
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
    };
    let operand_end =
        |s: &str| s.ends_with(|c: char| c.is_alphanumeric() || "_.`\")]}".contains(c));
    if let Some(inner) = line
        .strip_suffix(')')
        .and_then(|s| s.rfind('(').map(|i| s[i + 1..].trim()))
    {
        return inner.strip_prefix('-').is_some_and(integer);
    }
    if let Some((head, inner)) = line
        .strip_suffix(']')
        .and_then(|s| s.rfind('[').map(|i| (&s[..i], s[i + 1..].trim())))
    {
        return integer(inner)
            && head
                .trim_end_matches([' ', '\t'])
                .strip_suffix("neg")
                .is_some_and(|h| !operand_end(h));
    }
    let number = line.strip_suffix(['h', 'i', 'j']).unwrap_or(line);
    let sign = number.trim_end_matches(|c: char| c.is_ascii_digit());
    sign.len() < number.len() && sign.strip_suffix('-').is_some_and(|h| !operand_end(h))
}

/// `textDocument/hover`: for a global, each definition the workspace has of
/// it - a function as its name and parameters, anything else as the line
/// that assigns it - with the comment above, the best first; for a name q
/// defines, its catalogue entry; for the path of a load, the file it loads.
/// For a local, the type its assignments settle, when they settle one
/// (`More::inferred_types`); nothing for a name nobody defines.
fn hover(params: &Value, sources: &Sources, client: Client, more: More) -> Value {
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
    // With a negative integer on its left, `!` is an internal function -
    // `-3!x` the string form, `-11!` a log replayed - and neither Dict nor
    // Key, which is all the catalogue says of it: nothing beats a wrong
    // entry (#2248).
    if let Some((at, 1)) = glyph_at(cursor.text, cursor.offset)
        && &cursor.text[at..at + 1] == "!"
        && negative_integer_before(&cursor.text[..at])
    {
        return Value::Null;
    }
    // A glyph is no name, and is described where the cursor is on it - also
    // right after a name, which `name_at` would answer for.
    let glyph = glyph_at(cursor.text, cursor.offset)
        .and_then(|(at, len)| Some((at, len, builtin_at(at, len)?)));
    let (at, len, sections) = if let Some((at, len, section)) = glyph {
        (at, len, vec![section])
    } else {
        match name_at(cursor.text, cursor.offset) {
            Some(Name::Local(local)) => {
                return if more.inferred_types {
                    local_type(&cursor, &local, markdown)
                } else {
                    Value::Null
                };
            }
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
        }
    };
    let mut sections = sections;
    if more.qsql_explain && explains(cursor.text, at, len) {
        sections.extend(q_lint_rs::explain_qsql(cursor.text, at));
    }
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

/// The hover on a local whose assignments settle its type: the type, as
/// q's `type` names it. Not at a place in a qSQL phrase, where the name may
/// be a column of the table.
/// Whether the word or glyph at `at` leads a query the hover says in words:
/// `select`, `exec`, `update` or `delete`, or the `?` or `!` before a `[`.
fn explains(text: &str, at: usize, len: usize) -> bool {
    let word = &text[at..at + len];
    ["select", "exec", "update", "delete"].contains(&word)
        || (matches!(word, "?" | "!") && text[at + len..].starts_with('['))
}

fn local_type(cursor: &Cursor, local: &q_lint_rs::Local, markdown: bool) -> Value {
    let Some(place) = local
        .places
        .iter()
        .find(|p| p.at <= cursor.offset && cursor.offset <= p.at + p.len)
        .filter(|p| !p.column)
    else {
        return Value::Null;
    };
    let Some(typed) = q_lint_rs::typed_locals(cursor.text)
        .into_iter()
        .find(|t| t.local.places.iter().any(|p| p.at == place.at))
    else {
        return Value::Null;
    };
    let name = super::annotate::type_name(typed.kind);
    let value = if markdown {
        format!(
            "{}\n\n{name}, type `{}h`: every assignment of it in this lambda is one.",
            fenced(&format!("{}: {name}", local.name)),
            typed.kind
        )
    } else {
        format!(
            "{}: {name}\n\n{name}, type {}h: every assignment of it in this lambda is one.",
            local.name, typed.kind
        )
    };
    json!({
        "contents": {"kind": if markdown { "markdown" } else { "plaintext" }, "value": value},
        "range": range(&Lines::new(cursor.text), place.at, place.len),
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
    let found = match name_at(cursor.text, at) {
        // What a local holds is whatever was assigned to it last.
        Some(Name::Local(_)) => return vec![],
        Some(Name::Global { at, .. }) => called(
            sources,
            &sources.targets(cursor, at),
            &cursor.key,
            MAX_ALIASES,
        ),
        None => vec![],
    };
    if found.is_empty() {
        return builtin_signature(&cursor.text[at..at + len])
            .into_iter()
            .collect();
    }
    found
}

/// The name of the parameter argument `index` of the call to the name at
/// `at..at + len` is passed as: in the first signature that has that many,
/// or the last of one that takes any number more. None where no signature
/// is known or every one is shorter.
pub(super) fn parameter(
    sources: &Sources,
    cursor: &Cursor,
    at: usize,
    len: usize,
    index: usize,
) -> Option<String> {
    signatures(sources, cursor, at, len)
        .into_iter()
        .find_map(|s| match s.params.get(index) {
            Some(p) => Some(p.clone()),
            None if s.open => s.params.last().cloned(),
            None => None,
        })
}

/// q's own signature for `name`, when it is called with arguments.
fn builtin_signature(name: &str) -> Option<Signature> {
    let b = builtin(name)?;
    (matches!(b.kind, BuiltinKind::Function | BuiltinKind::Control) && !b.params.is_empty()).then(
        || Signature {
            name: b.name.clone(),
            params: b.params.clone(),
            said: b.summary.clone(),
            // `enlist[x;y;...]` takes any number, as the control words do.
            open: b.kind == BuiltinKind::Control || b.params.last().is_some_and(|p| p == "..."),
        },
    )
}

/// The ways to call the global known by `names`: each lambda assigned to
/// it, and through each name or projection assigned to it, up to `depth`
/// names deep, what that leads to - a projection taking the parameters it
/// leaves open, `pr:add[;2;]` taking `add`'s first and third.
fn called(sources: &Sources, names: &HashSet<String>, from: &str, depth: usize) -> Vec<Signature> {
    let mut found: Vec<Signature> = vec![];
    for d in defined(sources, names, from) {
        let mut ways = vec![];
        if let Some(params) = d.params {
            ways.push(Signature {
                name: d.name,
                params,
                said: d.comment,
                open: false,
            });
        } else if let Some((targets, spelled, given)) = d.of.filter(|_| depth > 0) {
            let mut under = called(sources, &targets, from, depth - 1);
            if under.is_empty() {
                under.extend(builtin_signature(&spelled));
            }
            for s in under {
                let params = match &given {
                    None => s.params,
                    // An open list of expressions has no slots to count.
                    Some(_) if s.open => continue,
                    Some(given) => match projected(s.params, given) {
                        Some(params) => params,
                        None => continue,
                    },
                };
                ways.push(Signature {
                    name: d.name.clone(),
                    params,
                    said: if d.comment.is_empty() {
                        s.said
                    } else {
                        d.comment.clone()
                    },
                    open: s.open && given.is_none(),
                });
            }
        }
        for way in ways {
            if !found
                .iter()
                .any(|s| s.name == way.name && s.params == way.params)
            {
                found.push(way);
            }
        }
    }
    found
}

/// The parameters a projection leaves open: each one no slot of `given`
/// fills, past the slots written too. `None` when it is no projection -
/// every parameter given, which is a call, or more slots than parameters,
/// which q refuses. `f[]` is `f[::]`, its first slot given.
fn projected(params: Vec<String>, given: &[bool]) -> Option<Vec<String>> {
    if given.len() > params.len() {
        return None;
    }
    let given = if given == [false] { &[true][..] } else { given };
    let open: Vec<String> = params
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !given.get(*i).copied().unwrap_or(false))
        .map(|(_, param)| param)
        .collect();
    (!open.is_empty()).then_some(open)
}

/// `textDocument/signatureHelp`: the parameters of the name whose brackets
/// the cursor is in, and which of them is being written - counted by the
/// `;`s before the cursor. Nothing for what is not called by a name: a
/// lambda written in place, or an operator's bracket form.
///
/// Past the last parameter no parameter is being written, and the
/// signature says the call has too many arguments. Its active parameter is
/// `null` to a client that reads that as none; to any other it is the index
/// past the last, which the clients that highlight one draw as none - where
/// leaving it out would mean the first.
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
    let over = |s: &Signature| !s.open && call.argument >= s.params.len();
    let parameter = |s: &Signature| {
        if s.open {
            json!(call.argument.min(s.params.len() - 1))
        } else if !over(s) {
            json!(call.argument)
        } else if client.no_active_parameter {
            Value::Null
        } else {
            json!(s.params.len())
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
            let said = if over(s) {
                let takes = match s.params.len() {
                    1 => "1 argument".to_string(),
                    n => format!("{n} arguments"),
                };
                format!("Too many arguments: {} takes {takes}.\n{}", s.name, s.said)
            } else {
                s.said.clone()
            };
            if !said.trim().is_empty() {
                signature["documentation"] =
                    documentation(said.trim_end(), client.signature_markdown);
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
fn completion(params: &Value, sources: &Sources, client: Client, more: More) -> Value {
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
    // The rest of the name the cursor is in, which an editor set to replace
    // takes with what is typed: accepting `fooBaz` at `fo|oBa` left
    // `fooBazoBa` (#2678). Only for a client that reads both ranges.
    let rest = cursor.text[cursor.offset..]
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.'))
        .count();
    let rest = cursor.text[cursor.offset..cursor.offset + rest]
        .trim_end_matches('.')
        .len();
    let whole = json!({"start": lines.json(typing.start),
                       "end": lines.json(cursor.offset + rest)});
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
            "textEdit": if client.insert_replace {
                json!({"insert": span, "replace": whole, "newText": spelling})
            } else {
                json!({"range": span, "newText": spelling})
            },
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
            // A glyph is no name, and completes none.
            BuiltinKind::Operator | BuiltinKind::Iterator => continue,
        };
        let group = if b.name.starts_with('.') { 3 } else { 2 };
        offer(group, &b.name, kind, Some(b));
    }
    if more.auto_load {
        let loads = Loads::new(sources, &cursor);
        for (spelling, (group, item)) in items.iter_mut() {
            if *group == 1 || *group == 3 {
                loads.offer(sources, &cursor, &contexts, root, spelling, item);
            }
        }
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

/// The loads a completion in one file may add (`More::auto_load`): which
/// files already reach it, and where a new `\l` line goes.
struct Loads {
    /// The files whose definitions this file can already see: itself, each
    /// file it loads, directly or through another, and each file loaded by
    /// a file that loads it - a sibling its loader brings in.
    seen: HashSet<String>,
    /// Each name the workspace defines, by the files that define it.
    definers: std::collections::HashMap<String, Vec<String>>,
    /// Where the new line goes, as a byte offset of the document, and
    /// whether it needs a newline before it - after the last line that
    /// already ends the file without one.
    at: Option<(usize, bool)>,
}

impl Loads {
    fn new(sources: &Sources, cursor: &Cursor) -> Self {
        let mut edges = std::collections::HashMap::new();
        let mut seen = sources.reached(&cursor.key, &mut edges);
        seen.insert(cursor.key.clone());
        for key in sources.keys() {
            if key != cursor.key && sources.reached(key, &mut edges).contains(&cursor.key) {
                seen.insert(key.to_string());
                seen.extend(sources.reached(key, &mut edges));
            }
        }
        let mut definers: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        // What each file defines where the new load would run it, which is
        // where this file runs before its first `\d`, and not where its
        // loaders have put it: lib.q's `fancy`, loaded elsewhere under
        // `\d .a`, is `.a.fancy` there and `fancy` after a load here (#2820).
        let placement = sources.placement(&cursor.key);
        for key in sources.keys() {
            let file = &sources.idx.files[key];
            let mut loaded = file.own.clone();
            placement.apply(&mut loaded, &file.read);
            for name in loaded.defined {
                definers.entry(name).or_default().push(key.to_string());
            }
        }
        Loads {
            seen,
            definers,
            at: load_line(cursor.text, cursor.offset),
        }
    }

    /// Give `item`, the completion of `spelling`, the edit that loads the
    /// one file defining it, when nothing this file can see defines it, and
    /// say so in its detail. Nothing when several files define it, since
    /// which to load is the reader's call, or when no path written from
    /// here reaches the file.
    fn offer(
        &self,
        sources: &Sources,
        cursor: &Cursor,
        contexts: &[&str],
        root: bool,
        spelling: &str,
        item: &mut Value,
    ) {
        let Some(at) = self.at else {
            return;
        };
        // The names the spelling may be, as it would resolve from here.
        let mut names: Vec<String> = vec![];
        if spelling.starts_with('.') {
            names.push(spelling.to_string());
        } else {
            names.extend(contexts.iter().map(|c| format!("{c}.{spelling}")));
            if root {
                names.push(spelling.to_string());
            }
        }
        let mut files: Vec<&String> = names
            .iter()
            .filter_map(|n| self.definers.get(n))
            .flatten()
            .collect();
        files.sort_unstable();
        files.dedup();
        if files.is_empty() || files.iter().any(|f| self.seen.contains(*f)) {
            return;
        }
        let [file] = files[..] else {
            return;
        };
        let Some(path) = load_path(sources, &cursor.key, file) else {
            return;
        };
        let lines = Lines::new(cursor.text);
        let (offset, newline) = at;
        // The document's own line end.
        let eol = if cursor.text.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let text = if newline {
            format!("{eol}\\l {path}")
        } else {
            format!("\\l {path}{eol}")
        };
        item["additionalTextEdits"] = json!([{
            "range": {"start": lines.json(offset), "end": lines.json(offset)},
            "newText": text,
        }]);
        item["detail"] = json!(format!("adds \\l {path}"));
    }
}

/// How the file `from` names `file` in a `\l` that loads it: by its path
/// under the workspace folder `from` is in (the first, for a file in none),
/// which is where a process over the tree is most likely started, or else by
/// its path from `from`'s own directory:
/// whichever the dependency graph follows to that file. Nothing for a path
/// with a blank in it, which `\l` would cut.
fn load_path(sources: &Sources, from: &str, file: &str) -> Option<String> {
    let file_path = std::path::Path::new(file);
    let mut candidates = vec![];
    let roots = sources.idx.cwds();
    let root = q_lint_rs::graph::start_dir(&roots, std::path::Path::new(from));
    if let Ok(under) = file_path.strip_prefix(root) {
        candidates.push(under.to_path_buf());
    }
    if let Some(dir) = std::path::Path::new(from).parent()
        && let Ok(under) = file_path.strip_prefix(dir)
    {
        candidates.push(under.to_path_buf());
    }
    candidates.into_iter().find_map(|path| {
        let path = path.to_str()?.replace('\\', "/");
        (!path.is_empty()
            && !path.contains(char::is_whitespace)
            && sources.loaded(from, &path, false) == [file.to_string()])
        .then_some(path)
    })
}

/// Where a load added for a completion at `offset` of `text` goes: after
/// the last `\l` line before both the cursor's line and the file's first
/// `\d`, so the loads already there keep their order and the new one is
/// read in the root context before the line that needs it; with none, at
/// the start, past a leading `#!` line and comment block. As a byte offset,
/// and whether the line before ends the file with no newline. Nothing when
/// that place is not before the cursor's line. A context opened any other
/// way - `system "d .x"`, `q)\d .x`, `k)\d .x` - ends the search as `\d .x`
/// does (#2670).
fn load_line(text: &str, offset: usize) -> Option<(usize, bool)> {
    let cursor_line = text[..offset.min(text.len())]
        .rfind('\n')
        .map_or(0, |i| i + 1);
    // Read with comments blanked: a `\l` in a block comment loads nothing,
    // and a block comment, all of it, is part of the header (#1208).
    let code = q_lint_rs::code_view(text);
    let contexts = q_lint_rs::contexts(text);
    let mut after_header = 0;
    let mut header = true;
    let mut last_load: Option<usize> = None;
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let end = start + line.len();
        if start >= cursor_line {
            break;
        }
        let commented = line.trim_end();
        let trimmed = code[start..end].trim_end();
        let switched = contexts
            .iter()
            .any(|(at, ns)| (start..end).contains(at) && !ns.is_empty());
        if trimmed.starts_with("\\d") || switched {
            break;
        }
        if header
            && (commented.starts_with('/')
                || commented.starts_with("#!")
                || trimmed.trim().is_empty())
        {
            if !commented.is_empty() {
                after_header = end;
            }
        } else {
            header = false;
        }
        if trimmed.starts_with("\\l ") {
            last_load = Some(end);
        }
        start = end;
    }
    let at = last_load.unwrap_or(after_header);
    if at > cursor_line {
        return None;
    }
    let newline = at > 0 && !text[..at].ends_with('\n');
    Some((at, newline))
}
