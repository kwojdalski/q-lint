//! Navigation: the outline, workspace symbols, go to definition, find
//! references, highlights, and renaming a local.
//!
//! WHERE THE POSITIONS COME FROM
//!
//! The index holds names and no positions, and that is kept: what it holds
//! is compared on every keystroke to decide whether the other open files
//! need linting again, and a position moves with every character typed
//! above it. So a request reads the files it needs when it is made - an open
//! buffer as the editor has it, any other file from disk - and the index
//! says which those are: the files that define the name, for a definition.
//! Find references has no such list, since the index does not hold what a
//! file reads, and goes through every indexed file that spells the name at
//! all. That is a read of the workspace for one request a person asked for,
//! and nothing on the path of a keystroke.
//!
//! WHAT IS FOUND, AND WHAT IS NOT
//!
//! A name is matched as the text q would look up, under the `\d` in force
//! and the context the file is loaded in - the resolution the checks and
//! the dependency graph use, and no more than that. A name reached through
//! a string (`value "f[]"`), a symbol built at run time, or another process
//! is in no list here, which is why only a lambda's own parameters and
//! locals can be renamed: every place those are named is inside the lambda.
use super::{Documents, Index, Lines, file_key, is_q_uri, path_of};
use q_lint_rs::graph::Placement;
use q_lint_rs::{Mention, Name, mentions, name_at};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
};

/// LSP's `SymbolKind`s for what a q script defines.
pub(super) const FUNCTION: u8 = 12;
pub(super) const VARIABLE: u8 = 13;
/// LSP's `DocumentHighlightKind`s.
const READ: u8 = 2;
const WRITE: u8 = 3;
/// How many symbols one `workspace/symbol` reply carries. A client filters
/// as the query grows, so the rest are a keystroke away.
const MAX_SYMBOLS: usize = 512;

/// The files a request answers from: the open buffers as the editor has
/// them, and every other indexed file as it is on disk.
pub(super) struct Sources<'a> {
    docs: &'a Documents,
    pub(super) idx: &'a Index,
    /// The open `.q` buffers by their key in the index, each with the URI
    /// the client knows it by - which a location in it has to repeat.
    pub(super) open: HashMap<String, &'a str>,
}

/// Where a request's `position` is: in which document, and at which byte.
pub(super) struct Cursor<'a> {
    uri: &'a str,
    pub(super) key: String,
    pub(super) text: &'a str,
    pub(super) offset: usize,
}

impl<'a> Sources<'a> {
    pub(super) fn new(docs: &'a Documents, idx: &'a Index) -> Self {
        let open = docs
            .keys()
            .filter(|uri| is_q_uri(uri))
            .map(|uri| (file_key(&path_of(uri)), uri.as_str()))
            .collect();
        Sources { docs, idx, open }
    }

    /// The document a request names, when it is an open `.q` file - the only
    /// kind linted, indexed or coloured, and so the only kind navigated.
    fn document(&self, params: &Value) -> Option<(&'a str, &'a str)> {
        let (uri, text) = self
            .docs
            .get_key_value(params["textDocument"]["uri"].as_str()?)?;
        is_q_uri(uri).then_some((uri.as_str(), text.as_str()))
    }

    pub(super) fn cursor(&self, params: &Value) -> Option<Cursor<'a>> {
        let (uri, text) = self.document(params)?;
        let position = &params["position"];
        let offset = Lines::new(text).offset(
            position["line"].as_u64()? as usize,
            position["character"].as_u64()? as usize,
        );
        Some(Cursor {
            uri,
            key: file_key(&path_of(uri)),
            text,
            offset,
        })
    }

    /// The indexed files, in an order that does not change between requests.
    pub(super) fn keys(&self) -> Vec<&'a str> {
        let mut keys: Vec<&str> = self.idx.files.keys().map(String::as_str).collect();
        keys.sort_unstable();
        keys
    }

    /// A file's URI and text: the open buffer's, or the disk's.
    pub(super) fn text(&self, key: &str) -> Option<(String, Cow<'a, str>)> {
        if let Some(uri) = self.open.get(key) {
            return Some((uri.to_string(), Cow::Borrowed(self.docs[*uri].as_str())));
        }
        let bytes = std::fs::read(key).ok()?;
        Some((
            self.uri(key),
            Cow::Owned(String::from_utf8_lossy(&bytes).into_owned()),
        ))
    }

    pub(super) fn placement(&self, key: &str) -> Placement {
        self.idx
            .files
            .get(key)
            .map(|file| file.placement.clone())
            .unwrap_or_default()
    }

    /// The names one mention of a global answers to, in a file placed where
    /// its loaders put it: the name itself, or - written without a dot
    /// before the file's first `\d` - that name in each context the file is
    /// loaded in. A bare read that none of those defines is `.q`'s, when
    /// `.q` has it: q looks there from every context.
    pub(super) fn names(
        &self,
        text: &str,
        mention: &Mention,
        placement: &Placement,
    ) -> Vec<String> {
        let names = placed(&mention.name, mention.implicit, placement);
        let word = &text[mention.at..mention.at + mention.len];
        if mention.definition.is_none()
            && !word.contains('.')
            && !names.iter().any(|name| self.idx.ws.defines(name))
        {
            let in_q = format!(".q.{word}");
            if self.idx.ws.defines(&in_q) {
                return vec![in_q];
            }
        }
        names
    }

    /// The global at byte `at` of the cursor's document, as the names it
    /// answers to.
    pub(super) fn targets(&self, cursor: &Cursor, at: usize) -> HashSet<String> {
        let placement = self.placement(&cursor.key);
        mentions(cursor.text)
            .iter()
            .filter(|m| m.at == at)
            .flat_map(|m| self.names(cursor.text, m, &placement))
            .collect()
    }

    /// Each place a file writes one of `names`, as a location. Only the
    /// files the index has defining one are read.
    fn definitions(&self, names: &HashSet<String>) -> Vec<Value> {
        let mut out = vec![];
        for key in self.keys() {
            let file = &self.idx.files[key];
            if !names.iter().any(|name| file.placed.defined.contains(name)) {
                continue;
            }
            let Some((uri, text)) = self.text(key) else {
                continue;
            };
            let lines = Lines::new(&text);
            for m in mentions(&text).iter().filter(|m| m.definition.is_some()) {
                if self
                    .names(&text, m, &file.placement)
                    .iter()
                    .any(|name| names.contains(name))
                {
                    out.push(location(&uri, &lines, m.at, m.len));
                }
            }
        }
        out
    }

    /// Each place any indexed file names one of `names`, with whether it is
    /// a write.
    fn mentioned(&self, names: &HashSet<String>) -> Vec<(Value, bool)> {
        let leaves: HashSet<&str> = names
            .iter()
            .filter_map(|name| name.rsplit('.').next())
            .collect();
        let mut out = vec![];
        for key in self.keys() {
            let Some((uri, text)) = self.text(key) else {
                continue;
            };
            if !leaves.iter().any(|leaf| text.contains(leaf)) {
                continue;
            }
            let placement = &self.idx.files[key].placement;
            let lines = Lines::new(&text);
            for m in &mentions(&text) {
                if self
                    .names(&text, m, placement)
                    .iter()
                    .any(|name| names.contains(name))
                {
                    out.push((location(&uri, &lines, m.at, m.len), m.definition.is_some()));
                }
            }
        }
        out
    }
}

/// `name` in each place a file's loaders put what it writes without a dot
/// before its first `\d`, as `Placement::apply` has it.
fn placed(name: &str, implicit: bool, placement: &Placement) -> Vec<String> {
    if !implicit {
        return vec![name.into()];
    }
    placement
        .contexts
        .iter()
        .map(|ns| format!("{ns}.{name}"))
        .chain(placement.root.then(|| name.to_string()))
        .collect()
}

pub(super) fn range(lines: &Lines, at: usize, len: usize) -> Value {
    json!({"start": lines.json(at), "end": lines.json(at + len)})
}

fn location(uri: &str, lines: &Lines, at: usize, len: usize) -> Value {
    json!({"uri": uri, "range": range(lines, at, len)})
}

/// What the server adds to its capabilities for the requests answered here.
/// `prepare` when the client asks, before a rename, what would be renamed -
/// the options form of `renameProvider` is for such a client only (LSP 3.17).
pub(super) fn announce(capabilities: &mut Value, prepare: bool) {
    for provider in [
        "documentSymbolProvider",
        "workspaceSymbolProvider",
        "definitionProvider",
        "referencesProvider",
        "documentHighlightProvider",
    ] {
        capabilities[provider] = json!(true);
    }
    capabilities["renameProvider"] = if prepare {
        json!({"prepareProvider": true})
    } else {
        json!(true)
    };
}

/// The answer to the navigation request `method`, or - for a rename - why it
/// is refused.
pub(super) fn answer(
    method: &str,
    params: &Value,
    sources: &Sources,
    nested: bool,
) -> Result<Value, String> {
    Ok(match method {
        "textDocument/documentSymbol" => document_symbols(params, sources, nested),
        "workspace/symbol" => workspace_symbols(params, sources),
        "textDocument/definition" => definition(params, sources),
        "textDocument/references" => references(params, sources),
        "textDocument/documentHighlight" => highlights(params, sources),
        "textDocument/prepareRename" => prepare_rename(params, sources)?,
        "textDocument/rename" => rename(params, sources)?,
        _ => Value::Null,
    })
}

/// `textDocument/definition`: where a local is declared, or each place the
/// workspace assigns a global - every one, since which assignment ran last
/// is not something reading says.
fn definition(params: &Value, sources: &Sources) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return Value::Null;
    };
    let lines = Lines::new(cursor.text);
    match name_at(cursor.text, cursor.offset) {
        None => Value::Null,
        Some(Name::Local(local)) => local
            .declared
            .and_then(|i| local.places.get(i))
            .map_or(Value::Null, |place| {
                json!([location(cursor.uri, &lines, place.at, place.len)])
            }),
        Some(Name::Global { at, .. }) => {
            let targets = sources.targets(&cursor, at);
            let mut found = sources.definitions(&targets);
            if found.is_empty() {
                // Or the namespace holding it, assigned as a whole: after
                // `.cfg:d`, that is where `.cfg.n` comes from.
                let holders = targets
                    .iter()
                    .filter_map(|name| {
                        name.match_indices('.')
                            .filter(|&(i, _)| i > 0)
                            .map(|(i, _)| &name[..i])
                            .rev()
                            .find(|holder| sources.idx.ws.defines(holder))
                    })
                    .map(str::to_string)
                    .collect();
                found = sources.definitions(&holders);
            }
            json!(found)
        }
    }
}

/// `textDocument/references`: each place a local's lambda names it, or each
/// place an indexed file names a global.
fn references(params: &Value, sources: &Sources) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return json!([]);
    };
    let declarations = params["context"]["includeDeclaration"]
        .as_bool()
        .unwrap_or(true);
    let lines = Lines::new(cursor.text);
    match name_at(cursor.text, cursor.offset) {
        None => json!([]),
        Some(Name::Local(local)) => local
            .places
            .iter()
            .enumerate()
            .filter(|(i, _)| declarations || Some(*i) != local.declared)
            .map(|(_, place)| location(cursor.uri, &lines, place.at, place.len))
            .collect(),
        Some(Name::Global { at, .. }) => sources
            .mentioned(&sources.targets(&cursor, at))
            .into_iter()
            .filter(|(_, write)| declarations || !write)
            .map(|(location, _)| location)
            .collect(),
    }
}

/// `textDocument/documentHighlight`: the same name elsewhere in this
/// document, marked as read or written.
fn highlights(params: &Value, sources: &Sources) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return json!([]);
    };
    let lines = Lines::new(cursor.text);
    let highlight = |at: usize, len: usize, write: bool| json!({"range": range(&lines, at, len), "kind": if write { WRITE } else { READ }});
    match name_at(cursor.text, cursor.offset) {
        None => json!([]),
        Some(Name::Local(local)) => local
            .places
            .iter()
            .map(|place| highlight(place.at, place.len, place.write))
            .collect(),
        Some(Name::Global { at, .. }) => {
            let targets = sources.targets(&cursor, at);
            let placement = sources.placement(&cursor.key);
            mentions(cursor.text)
                .iter()
                .filter(|m| {
                    sources
                        .names(cursor.text, m, &placement)
                        .iter()
                        .any(|name| targets.contains(name))
                })
                .map(|m| highlight(m.at, m.len, m.definition.is_some()))
                .collect()
        }
    }
}

/// `textDocument/documentSymbol`: each global the document assigns, in
/// order and once, where it first does - as `DocumentSymbol`s for a client
/// that takes them (`nested`), which carry the statement to fold and select,
/// and as `SymbolInformation`s for one that does not. A later assignment of
/// the same name is a definition to go to, and no second line in an outline.
fn document_symbols(params: &Value, sources: &Sources, nested: bool) -> Value {
    let Some((uri, text)) = sources.document(params) else {
        return json!([]);
    };
    let lines = Lines::new(text);
    let mut listed = HashSet::new();
    mentions(text)
        .iter()
        .filter_map(|m| {
            let definition = m.definition.as_ref()?;
            if !listed.insert(m.name.as_str()) {
                return None;
            }
            let kind = if definition.function {
                FUNCTION
            } else {
                VARIABLE
            };
            Some(if nested {
                // The selection has to lie within the range (LSP 3.17).
                let start = definition.start.min(m.at);
                let end = definition.end.max(m.at + m.len);
                json!({
                    "name": m.name,
                    "detail": definition.detail,
                    "kind": kind,
                    "range": range(&lines, start, end - start),
                    "selectionRange": range(&lines, m.at, m.len),
                })
            } else {
                json!({
                    "name": m.name,
                    "kind": kind,
                    "location": location(uri, &lines, m.at, m.len),
                })
            })
        })
        .collect()
}

/// `workspace/symbol`: the globals the workspace assigns whose name holds
/// the query, whatever its case - and all of them, up to `MAX_SYMBOLS`, for
/// an empty one, each once for every file that assigns it. Only the files the index has defining a match are read.
fn workspace_symbols(params: &Value, sources: &Sources) -> Value {
    let query = params["query"].as_str().unwrap_or_default().to_lowercase();
    let matches = |name: &str| name.to_lowercase().contains(&query);
    let mut out = vec![];
    for key in sources.keys() {
        let file = &sources.idx.files[key];
        if !file.placed.defined.iter().any(|name| matches(name)) {
            continue;
        }
        let Some((uri, text)) = sources.text(key) else {
            continue;
        };
        let lines = Lines::new(&text);
        let mut listed = HashSet::new();
        for m in &mentions(&text) {
            let Some(definition) = &m.definition else {
                continue;
            };
            // Once a file, where it first assigns the name: as the outline.
            if !listed.insert(m.name.as_str()) {
                continue;
            }
            for name in placed(&m.name, m.implicit, &file.placement) {
                if !matches(&name) {
                    continue;
                }
                if out.len() == MAX_SYMBOLS {
                    return json!(out);
                }
                out.push(json!({
                    "name": name,
                    "kind": if definition.function { FUNCTION } else { VARIABLE },
                    "location": location(&uri, &lines, m.at, m.len),
                }));
            }
        }
    }
    json!(out)
}

/// `textDocument/prepareRename`: the range of the local under the cursor,
/// or why nothing there is renamed.
fn prepare_rename(params: &Value, sources: &Sources) -> Result<Value, String> {
    let Some(cursor) = sources.cursor(params) else {
        return Ok(Value::Null);
    };
    let (at, len) = q_lint_rs::rename_target(cursor.text, cursor.offset)?;
    Ok(json!({
        "range": range(&Lines::new(cursor.text), at, len),
        "placeholder": &cursor.text[at..at + len],
    }))
}

/// `textDocument/rename`: the edits that rename the local under the cursor,
/// all of them in its own document, or why it is not renamed.
fn rename(params: &Value, sources: &Sources) -> Result<Value, String> {
    let Some(cursor) = sources.cursor(params) else {
        return Ok(Value::Null);
    };
    let new = params["newName"].as_str().unwrap_or_default();
    let lines = Lines::new(cursor.text);
    let edits: Vec<Value> = q_lint_rs::rename(cursor.text, cursor.offset, new)?
        .into_iter()
        .map(|(at, len)| json!({"range": range(&lines, at, len), "newText": new}))
        .collect();
    Ok(json!({"changes": {(cursor.uri): edits}}))
}
