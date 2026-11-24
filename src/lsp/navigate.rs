//! Navigation: the outline, workspace symbols, go to definition, find
//! references, highlights, and renaming a local or a global.
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
//! is in no list here. Every place a lambda's own parameter or local is
//! named is inside the lambda, so renaming one is complete; renaming a
//! global changes every use the text proves is one - a symbol too, where q
//! takes a global by name - and is refused where a use cannot be told from
//! something else: a symbol of the name anywhere else, a dotted read in a
//! qSQL phrase. It leaves a name built in a string or another process as it
//! was.
use super::{Documents, Index, Lines, file_key, is_q_uri, path_of};
use q_lint_rs::graph::{self, Placement};
use q_lint_rs::{Mention, Name, load_at, mentions, name_at, symbol_mentions};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    path::Path,
};

/// LSP's `SymbolKind`s for what a q script defines.
const NAMESPACE: u8 = 3;
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
    pub(super) fn document(&self, params: &Value) -> Option<(&'a str, &'a str)> {
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

    /// A file's URI and text: the open buffer's, or the disk's as an editor
    /// would hold it (`on_disk`).
    pub(super) fn text(&self, key: &str) -> Option<(String, Cow<'a, str>)> {
        if let Some(uri) = self.open.get(key) {
            return Some((uri.to_string(), Cow::Borrowed(self.docs[*uri].as_str())));
        }
        let (text, _) = super::on_disk(key)?;
        Some((self.uri(key), Cow::Owned(text)))
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

    /// How much of a mention, from its start, spells one of `targets`: the
    /// whole of it, or - for a dotted name that goes through the target -
    /// the part before the rest, `ta` of `ta.c` for a table `ta` and `.cfg`
    /// of `.cfg.port` for a `.cfg` assigned whole. q reads both through the
    /// global: KDB-X 5 `ta:([]c:1 2 3)`, then `sum ta.c` is 6 (#2017).
    /// `Some(0)` where the name goes through the target and the text spells
    /// none of it, the `\d` in force supplying it.
    pub(super) fn spelt(
        &self,
        text: &str,
        mention: &Mention,
        placement: &Placement,
        targets: &HashSet<String>,
    ) -> Option<usize> {
        let names = self.names(text, mention, placement);
        if names.iter().any(|name| targets.contains(name)) {
            return Some(mention.len);
        }
        names.iter().find_map(|name| {
            let (dot, _) = name
                .match_indices('.')
                .rfind(|&(dot, _)| dot > 0 && targets.contains(&name[..dot]))?;
            let part = mention.len.saturating_sub(name.len() - dot);
            let dotted = text.as_bytes().get(mention.at + part) == Some(&b'.');
            Some(if dotted { part } else { 0 })
        })
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

    /// The global at byte `at` of the cursor's document, as `targets` has
    /// it, with how much of the mention spells it - or, for a dotted read
    /// no file defines, the global it reads through, `ta` of `ta.c` for a
    /// table `ta`, and that part. q reads the column of the global: KDB-X 5
    /// `ta:([]c:1 2 3)`, then `sum ta.c` is 6 (#2017, #2048). Go to
    /// Definition goes there too.
    pub(super) fn global_at(&self, cursor: &Cursor, at: usize) -> (HashSet<String>, usize) {
        let all = mentions(cursor.text);
        let Some(m) = all.iter().find(|m| m.at == at) else {
            return (HashSet::new(), 0);
        };
        let targets = self.targets(cursor, at);
        if targets.iter().any(|name| self.idx.ws.defines(name)) {
            return (targets, m.len);
        }
        let holders: Vec<(String, usize)> = targets
            .iter()
            .filter_map(|name| {
                let (dot, _) = name
                    .match_indices('.')
                    .filter(|&(dot, _)| dot > 0)
                    .rfind(|&(dot, _)| self.idx.ws.defines(&name[..dot]))?;
                Some((
                    name[..dot].to_string(),
                    m.len.checked_sub(name.len() - dot)?,
                ))
            })
            .filter(|&(_, part)| part > 0 && cursor.text.as_bytes()[at + part] == b'.')
            .collect();
        match holders.first() {
            Some(&(_, part)) if holders.iter().all(|(_, p)| *p == part) => {
                (holders.into_iter().map(|(name, _)| name).collect(), part)
            }
            _ => (targets, m.len),
        }
    }

    /// The files the index has defining one of `names`, best first for a
    /// reader in the file `from` - see `ranked`.
    pub(super) fn definers(&self, names: &HashSet<String>, from: &str) -> Vec<&'a str> {
        let definers = self
            .keys()
            .into_iter()
            .filter(|key| {
                let defined = &self.idx.files[*key].placed.defined;
                names.iter().any(|name| defined.contains(name))
            })
            .collect();
        self.ranked(definers, from)
    }

    /// `definers` in the order a reader in `from` wants them: `from` itself,
    /// then each file it loads, directly or through another, then each file
    /// that loads it, then the rest - each group in the order of `keys`.
    ///
    /// Where `from` assigns the name itself, the rest are left out. A file
    /// that neither loads `from` nor is loaded by it, by any chain of loads
    /// the source spells, is another program that happens to use the name -
    /// eight scripts each with their own `opts:.Q.opt .z.x` - and its
    /// assignment is not one this file can see. One connected by a load
    /// stays, ranked: it may run in the same process, and which assignment
    /// ran last is not something reading says. Where `from` does not assign
    /// the name, nothing is left out, since the name has to come from
    /// somewhere and a loader outside the workspace may be what joins them.
    fn ranked(&self, definers: Vec<&'a str>, from: &str) -> Vec<&'a str> {
        if definers.len() < 2 {
            return definers;
        }
        let mut edges = HashMap::new();
        let loaded = self.reached(from, &mut edges);
        let mut rank: Vec<(u8, &str)> = definers
            .into_iter()
            .map(|key| {
                let rank = if key == from {
                    0
                } else if loaded.contains(key) {
                    1
                } else if self.reached(key, &mut edges).contains(from) {
                    2
                } else {
                    3
                };
                (rank, key)
            })
            .collect();
        rank.sort_by_key(|(rank, _)| *rank);
        let own = rank.first().is_some_and(|(rank, _)| *rank == 0);
        rank.into_iter()
            .filter(|(rank, _)| !own || *rank < 3)
            .map(|(_, key)| key)
            .collect()
    }

    /// Each indexed file `from` loads, directly or through another, by its
    /// key. `edges` keeps where each file's loads lead, so one request
    /// follows a file's loads once however many files it asks about.
    pub(super) fn reached(
        &self,
        from: &str,
        edges: &mut HashMap<String, Vec<String>>,
    ) -> HashSet<String> {
        let mut seen = HashSet::new();
        let mut pending = vec![from.to_string()];
        while let Some(file) = pending.pop() {
            if !edges.contains_key(&file) {
                let next = self.idx.files.get(&file).map_or_else(Vec::new, |f| {
                    f.loads
                        .iter()
                        .flat_map(|(load, _)| self.loaded(&file, load, false))
                        .collect()
                });
                edges.insert(file.clone(), next);
            }
            for next in &edges[&file] {
                if seen.insert(next.clone()) {
                    pending.push(next.clone());
                }
            }
        }
        seen
    }

    /// The files `\l load` in the file `from` leads to, as the dependency
    /// graph follows it: by their key in the index, or - with `disk` - by
    /// their path, for a file the index does not hold and the disk does.
    pub(super) fn loaded(&self, from: &str, load: &str, disk: bool) -> Vec<String> {
        let indexed = |path: &Path| {
            let path = path.to_str()?;
            if self.idx.files.contains_key(path) {
                Some(path.to_string())
            } else {
                (disk && Path::new(path).is_file()).then(|| file_key(path))
            }
        };
        let scripts_in = |dir: &Path| {
            let dir = file_key(&dir.to_string_lossy());
            self.keys()
                .into_iter()
                .filter(|key| Path::new(key).parent() == Some(Path::new(&dir)))
                .map(str::to_string)
                .collect()
        };
        let cwds = self.idx.cwds();
        let cwd = graph::start_dir(&cwds, Path::new(from));
        graph::loaded(Path::new(from), load, cwd, indexed, scripts_in)
    }

    /// The path of the load under the cursor, as its start and length, with
    /// the files it leads to - none when it leads nowhere. Nothing when the
    /// cursor is on no load.
    pub(super) fn load_under(&self, cursor: &Cursor) -> Option<(usize, usize, Vec<String>)> {
        let (at, len) = load_at(cursor.text, cursor.offset)?;
        let files = self.loaded(&cursor.key, &cursor.text[at..at + len], true);
        Some((at, len, files))
    }

    /// Each place a file writes one of `names`, as a location, best first
    /// for a reader in the file `from`. Only the files the index has
    /// defining one are read.
    fn definitions(&self, names: &HashSet<String>, from: &str) -> Vec<Value> {
        let mut out = vec![];
        for key in self.definers(names, from) {
            let file = &self.idx.files[key];
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
            let all = mentions(&text);
            let mut found = vec![];
            for m in &all {
                // A name the `\d` in force puts under the global spells
                // none of it, and is no place to list.
                if let Some(part) = self.spelt(&text, m, placement, names)
                    && part > 0
                {
                    found.push((m.at, part, m.definition.is_some()));
                }
            }
            // And a symbol that may be the name, where nothing says it is
            // data: `` `t in tables[] `` (#2018). One line too many to skip.
            let known: HashSet<usize> = all.iter().map(|m| m.at).collect();
            for leaf in &leaves {
                for m in symbol_mentions(&text, leaf) {
                    if !known.contains(&m.at)
                        && self
                            .names(&text, &m, placement)
                            .iter()
                            .any(|name| names.contains(name))
                    {
                        found.push((m.at, m.len, false));
                    }
                }
            }
            found.sort_unstable();
            found.dedup_by_key(|place| place.0);
            out.extend(
                found
                    .into_iter()
                    .map(|(at, len, write)| (location(&uri, &lines, at, len), write)),
            );
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
pub(super) fn announce(capabilities: &mut Value, prepare: bool, rename: bool) {
    for provider in [
        "documentSymbolProvider",
        "workspaceSymbolProvider",
        "definitionProvider",
        "referencesProvider",
        "documentHighlightProvider",
    ] {
        capabilities[provider] = json!(true);
    }
    if !rename {
        return;
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
/// workspace assigns a global - every one connected to this file, since
/// which assignment ran last is not something reading says, and this file's
/// own first (`Sources::ranked`). On the path of a load, the file it loads.
fn definition(params: &Value, sources: &Sources) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return Value::Null;
    };
    // The path of a load goes to the file it loads, at its start.
    if let Some((_, _, files)) = sources.load_under(&cursor) {
        return files
            .iter()
            .map(|file| json!({"uri": sources.uri(file), "range": range(&Lines::new(""), 0, 0)}))
            .collect();
    }
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
            let mut found = sources.definitions(&targets, &cursor.key);
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
                found = sources.definitions(&holders, &cursor.key);
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
            .mentioned(&sources.global_at(&cursor, at).0)
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
            let (targets, _) = sources.global_at(&cursor, at);
            let placement = sources.placement(&cursor.key);
            let code = q_lint_rs::code_view(cursor.text);
            mentions(cursor.text)
                .iter()
                .filter_map(|m| {
                    let part = sources
                        .spelt(cursor.text, m, &placement, &targets)
                        .filter(|&part| part > 0)?;
                    let write =
                        m.definition.is_some() || q_lint_rs::amended_at(&code, m.at + m.len);
                    Some(highlight(m.at, part, write))
                })
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
    let all = mentions(text);
    let defined: Vec<(&Mention, bool, usize, usize)> = all
        .iter()
        .filter_map(|m| {
            let definition = m.definition.as_ref()?;
            if !listed.insert(m.name.as_str()) {
                return None;
            }
            // The selection has to lie within the range (LSP 3.17).
            let start = definition.start.min(m.at);
            let end = definition.end.max(m.at + m.len);
            Some((m, definition.function, start, end))
        })
        .collect();
    if !nested {
        return defined
            .iter()
            .map(|(m, function, ..)| {
                json!({
                    "name": m.name,
                    "kind": if *function { FUNCTION } else { VARIABLE },
                    "location": location(uri, &lines, m.at, m.len),
                })
            })
            .collect();
    }
    outline(&defined, &lines)
}

/// The namespace `name` is in, the whole of it before its last dot: `.a.b`
/// for `.a.b.c`, and none for `c` or `.c`.
fn namespace(name: &str) -> Option<&str> {
    name.rfind('.')
        .filter(|&dot| dot > 0)
        .map(|dot| &name[..dot])
}

/// The nested outline: each name under the namespace it is in, the whole of
/// it before its last dot - `.qetl.io.read` as `read` under `.qetl.io` - and
/// a name with no namespace at the top.
///
/// A namespace is a node for each place it is written: the names a run of
/// statements puts in it, one after another with nothing else between
/// them. One node for all of it would span from its first name to its last
/// and so take in every other name written between - `.bb.g` inside `.aa`
/// in `.aa.f:{x}`, `.bb.g:{x}`, `.aa.h:{x}` - and a range is what an editor
/// reads to say which symbol a position is in: the first that holds it, so
/// breadcrumbs named `.aa` for a cursor in `.bb.g` (#2029). A name set
/// inside a statement (`f:{.bb.g::x}`) is written there and not between two
/// statements, so it neither ends a run nor is joined by what follows.
///
/// One level, and not one for every dot. A file mostly writes into one or
/// two contexts, all under one project prefix: nesting `.qetl.io` under
/// `.qetl` puts the whole file under a single node with a single child,
/// and grouping at the first level only, under `.qetl`, does the same. A
/// group per context the file writes into is what `\d` names, and what an
/// outline of a large file is scanned by. A namespace the file also assigns
/// whole, `.cfg:()!()` beside `.cfg.port:5010`, is that assignment, with the
/// names in it as its children.
fn outline(defined: &[(&Mention, bool, usize, usize)], lines: &Lines) -> Value {
    let used: HashSet<&str> = defined
        .iter()
        .filter_map(|(m, ..)| namespace(&m.name))
        .collect();
    /// A namespace in the outline: its name, its own assignment, and the
    /// names in it, each by its place in `defined`.
    struct Group<'m> {
        name: &'m str,
        own: Option<usize>,
        children: Vec<usize>,
    }
    let mut groups: Vec<Group> = vec![];
    // In the order written. `Err` is a group, by its place in `groups`.
    let mut top: Vec<Result<usize, usize>> = vec![];
    // The group the last statement wrote into, and where that statement
    // ends: a name assigned before there is assigned inside it.
    let mut run: Option<usize> = None;
    let mut reach = 0;
    for (i, &(m, _, start, end)) in defined.iter().enumerate() {
        let inside = start < reach;
        let named = match namespace(&m.name) {
            _ if used.contains(m.name.as_str()) => Some((m.name.as_str(), true)),
            Some(ns) => Some((ns, false)),
            None => None,
        };
        // The group it joins: the run's, or for a name inside a statement
        // the one the name before it there began.
        let joined = named.and_then(|(name, _)| {
            let beside = match top.last() {
                Some(&Err(g)) if inside => Some(g),
                _ => None,
            };
            let same = |g: &usize| groups[*g].name == name;
            run.filter(same).or(beside.filter(same))
        });
        let g = match (named, joined) {
            (None, _) => {
                top.push(Ok(i));
                None
            }
            (Some(_), Some(g)) => Some(g),
            (Some((name, _)), None) => {
                groups.push(Group {
                    name,
                    own: None,
                    children: vec![],
                });
                top.push(Err(groups.len() - 1));
                Some(groups.len() - 1)
            }
        };
        match (g, named) {
            (Some(g), Some((_, true))) => groups[g].own = Some(i),
            (Some(g), _) => groups[g].children.push(i),
            (None, _) => {}
        }
        if !inside {
            run = g;
            reach = end;
        }
    }
    let symbol = |i: usize, name: &str| {
        let (m, function, start, end) = defined[i];
        json!({
            "name": name,
            "detail": m.definition.as_ref().map_or("", |d| d.detail.as_str()),
            "kind": if function { FUNCTION } else { VARIABLE },
            "range": range(lines, start, end - start),
            "selectionRange": range(lines, m.at, m.len),
        })
    };
    top.into_iter()
        .map(|entry| match entry {
            Ok(i) => symbol(i, &defined[i].0.name),
            Err(g) => {
                let group = &groups[g];
                let members = group.own.iter().chain(&group.children);
                let start = members.clone().map(|&i| defined[i].2).min().unwrap_or(0);
                let end = members.map(|&i| defined[i].3).max().unwrap_or(0);
                let children: Vec<Value> = group
                    .children
                    .iter()
                    .map(|&i| {
                        let name = &defined[i].0.name;
                        symbol(i, &name[group.name.len() + 1..])
                    })
                    .collect();
                let mut node = match group.own {
                    Some(own) => symbol(own, group.name),
                    None => {
                        let first = defined[group.children[0]].0;
                        json!({
                            "name": group.name,
                            "kind": NAMESPACE,
                            "selectionRange": range(lines, first.at, first.len),
                        })
                    }
                };
                node["range"] = range(lines, start, end - start);
                node["children"] = json!(children);
                node
            }
        })
        .collect()
}

/// How well `name`, lower-cased, answers a `workspace/symbol` query, by its
/// `words` lower-cased - lower is better, `None` not at all. 0 when it is
/// the query, 1 when its last segment is (`.u.st` for `st`), 2 when it or
/// its last segment starts with it, 3 when it holds it - every word of it,
/// for a query of several (`bounded fail`) - and 4 when it holds its letters
/// in order, as an editor filters (`qior` for `.qetl.io.read`).
fn matched(name: &str, words: &[&str]) -> Option<u8> {
    let [query] = words else {
        return words.iter().all(|word| name.contains(word)).then_some(3);
    };
    let leaf = name.rsplit('.').next().unwrap_or(name);
    if name == *query {
        Some(0)
    } else if leaf == *query {
        Some(1)
    } else if name.starts_with(query) || leaf.starts_with(query) {
        Some(2)
    } else if name.contains(query) {
        Some(3)
    } else {
        let mut letters = name.chars();
        query.chars().all(|c| letters.any(|n| n == c)).then_some(4)
    }
}

/// `workspace/symbol`: the globals the workspace assigns that answer the
/// query, whatever its case, each once for every file that assigns it -
/// ranked by `matched`, and only then cut to `MAX_SYMBOLS`, so an exact name
/// is never lost among longer ones that hold it. The ranking is over the
/// index's names; only the files holding a name that makes the cut are
/// read, for its position. Within a rank they go by file, then name: by
/// length instead, the shortest 512 of thousands of matches are spread over
/// hundreds of files, and reading those made the request several times
/// slower for an order the client sorts again by its own score anyway.
fn workspace_symbols(params: &Value, sources: &Sources) -> Value {
    let query = params["query"].as_str().unwrap_or_default().to_lowercase();
    let words: Vec<&str> = query.split_whitespace().collect();
    let mut ranked: Vec<(u8, &str, &str)> = vec![];
    for key in sources.keys() {
        for name in &sources.idx.files[key].placed.defined {
            if let Some(rank) = matched(&name.to_lowercase(), &words) {
                ranked.push((rank, key, name));
            }
        }
    }
    ranked.sort_unstable();
    // Each file read once.
    let mut read: HashMap<&str, Symbols> = HashMap::new();
    let mut out = vec![];
    let mut rest = ranked.as_mut_slice();
    while out.len() < MAX_SYMBOLS && !rest.is_empty() {
        let rank = rest[0].0;
        let (tier, after) = rest.split_at_mut(rest.partition_point(|c| c.0 == rank));
        rest = after;
        // A file read for a better rank first: the names it holds cost no
        // further read.
        tier.sort_by_key(|(_, key, _)| !read.contains_key(key));
        let mut wanted = HashSet::new();
        let unread = tier
            .iter()
            .take(MAX_SYMBOLS - out.len())
            .map(|(_, key, _)| *key)
            .filter(|key| !read.contains_key(key) && wanted.insert(*key));
        read.extend(assigned_in(sources, unread.collect()));
        for &(_, key, name) in tier.iter() {
            if !symbol(sources, &mut read, &mut out, key, name) {
                break;
            }
        }
    }
    json!(out)
}

/// Add the symbol `name` the file `key` assigns to `out`, reading the file
/// into `read` if it is not there yet - or nothing, for a name the index
/// has from a write that is no mention, which has no position to give.
/// Whether `out` has room for more.
fn symbol<'k>(
    sources: &Sources,
    read: &mut HashMap<&'k str, Symbols>,
    out: &mut Vec<Value>,
    key: &'k str,
    name: &str,
) -> bool {
    let found = read.entry(key).or_insert_with(|| assigned(sources, key));
    if let Some((location, kind)) = found.get(name) {
        out.push(json!({"name": name, "kind": kind, "location": location}));
    }
    out.len() < MAX_SYMBOLS
}

/// `assigned` of each of `keys`, the files read side by side: a short query
/// ranks names from a hundred files and more to the top, and reading them
/// one after another made the request twice as slow as the unranked one,
/// which stopped at the first files it came to.
fn assigned_in<'k>(sources: &Sources, keys: Vec<&'k str>) -> Vec<(&'k str, Symbols)> {
    let threads = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(8)
        .min(keys.len());
    if threads < 2 {
        return keys
            .into_iter()
            .map(|key| (key, assigned(sources, key)))
            .collect();
    }
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|first| {
                let keys = &keys;
                scope.spawn(move || {
                    keys.iter()
                        .skip(first)
                        .step_by(threads)
                        .map(|key| (*key, assigned(sources, key)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
            .collect()
    })
}

/// The globals one file assigns, each as the location where it first does
/// and its kind.
type Symbols = HashMap<String, (Value, u8)>;

/// The globals the file `key` assigns, where each first is - as the outline
/// has it.
fn assigned(sources: &Sources, key: &str) -> Symbols {
    let mut found = HashMap::new();
    let Some((uri, text)) = sources.text(key) else {
        return found;
    };
    let placement = &sources.idx.files[key].placement;
    let lines = Lines::new(&text);
    for m in &mentions(&text) {
        let Some(definition) = &m.definition else {
            continue;
        };
        for placed in placed(&m.name, m.implicit, placement) {
            found.entry(placed).or_insert_with(|| {
                let kind = if definition.function {
                    FUNCTION
                } else {
                    VARIABLE
                };
                (location(&uri, &lines, m.at, m.len), kind)
            });
        }
    }
    found
}

/// `textDocument/prepareRename`: the range of the name under the cursor -
/// a local, or the last part of a global as it is written there - or why
/// nothing there is renamed.
fn prepare_rename(params: &Value, sources: &Sources) -> Result<Value, String> {
    let Some(cursor) = sources.cursor(params) else {
        return Ok(Value::Null);
    };
    let (at, len) = match name_at(cursor.text, cursor.offset) {
        Some(Name::Global { at, .. }) => {
            let (_, len) = renamable_global(sources, &cursor, at)?;
            let leaf = leaf(&cursor.text[at..at + len]);
            (at + len - leaf.len(), leaf.len())
        }
        _ => q_lint_rs::rename_target(cursor.text, cursor.offset)?,
    };
    Ok(json!({
        "range": range(&Lines::new(cursor.text), at, len),
        "placeholder": &cursor.text[at..at + len],
    }))
}

/// `textDocument/rename`: the edits that rename the local under the cursor,
/// all of them in its own document, or the global under it, in every file
/// that names it - or why it is not renamed.
fn rename(params: &Value, sources: &Sources) -> Result<Value, String> {
    let Some(cursor) = sources.cursor(params) else {
        return Ok(Value::Null);
    };
    let new = params["newName"].as_str().unwrap_or_default();
    if let Some(Name::Global { at, .. }) = name_at(cursor.text, cursor.offset) {
        return rename_global(sources, &cursor, at, new);
    }
    let lines = Lines::new(cursor.text);
    let edits: Vec<Value> = q_lint_rs::rename(cursor.text, cursor.offset, new)?
        .into_iter()
        .map(|(at, len)| json!({"range": range(&lines, at, len), "newText": new}))
        .collect();
    Ok(json!({"changes": {(cursor.uri): edits}}))
}

/// The last part of a name as written: `f` of `.ns.f`, and of `f`.
fn leaf(spelled: &str) -> &str {
    spelled.rsplit('.').next().unwrap_or(spelled)
}

/// `name` with its last part `new`: `.ns.g` for `.ns.f`.
fn releafed(name: &str, new: &str) -> String {
    match name.rfind('.') {
        Some(dot) => format!("{}{new}", &name[..=dot]),
        None => new.to_string(),
    }
}

/// The names the global at `at` of the cursor's document answers to, when
/// the workspace can rename it: a name some indexed file assigns, and none
/// in a namespace q keeps for itself.
///
/// What a rename rewrites is each place an indexed file names the global,
/// under the `\d` in force and the context the file is loaded in - a symbol
/// too, where q takes a global by name. A name reached through a string
/// (`value "f[]"`), another process or a file outside the workspace is not
/// among them, and keeps the old name.
fn renamable_global(
    sources: &Sources,
    cursor: &Cursor,
    at: usize,
) -> Result<(HashSet<String>, usize), String> {
    let (targets, len) = sources.global_at(cursor, at);
    let mut sorted: Vec<&String> = targets.iter().collect();
    sorted.sort_unstable();
    let Some(shown) = sorted.first() else {
        return Err("nothing here is a name q-lint can rename".into());
    };
    // q keeps every one-letter namespace for itself: `.z.pg` is a callback,
    // `.q.f` a word of the language.
    if let Some(name) = sorted.iter().find(|name| {
        name.len() > 2 && name.starts_with('.') && name.as_bytes().get(2) == Some(&b'.')
    }) {
        return Err(format!(
            "`{name}` is in `{}`, a namespace q keeps for itself, where a name means what q \
             gives it",
            &name[..2]
        ));
    }
    if sources.definers(&targets, &cursor.key).is_empty() {
        return Err(format!(
            "no file in the workspace assigns `{shown}`: it is q's own, or defined where \
             q-lint cannot read, so the places it is named cannot all be found"
        ));
    }
    Ok((targets, len))
}

/// The edits that rename the global written at `at` of the cursor's
/// document to `new` - its last part only, as `g` or as the whole
/// name with the same namespace written before it (`.ns.g` for `.ns.f`) -
/// in every indexed file that names it.
///
/// Refused when `new` is no name q takes, a word q reserves, a name the
/// workspace already assigns, or a parameter or local of a lambda that
/// reads the global without its namespace, which would then read the local.
fn rename_global(
    sources: &Sources,
    cursor: &Cursor,
    at: usize,
    new: &str,
) -> Result<Value, String> {
    let (targets, len) = renamable_global(sources, cursor, at)?;
    let spelled = &cursor.text[at..at + len];
    let old = leaf(spelled);
    let written = &spelled[..spelled.len() - old.len()];
    // The namespace may be the one the name resolves to and not one written
    // there: `add` under `\d .lib` is `.lib.add`, and `.lib.plus` names the
    // same namespace (#2049).
    let resolved = targets.iter().find_map(|name| {
        let namespace = name.strip_suffix(old).filter(|ns| ns.ends_with('.'))?;
        new.strip_prefix(namespace)
    });
    let new = match new.strip_prefix(written) {
        Some(rest) if !written.is_empty() => rest,
        _ if let Some(rest) = resolved => rest,
        _ if new.contains('.') => {
            return Err(format!(
                "q-lint renames the last part of a name only: `{spelled}` can become \
                 `{written}{old}2`, and not a name in another namespace"
            ));
        }
        _ => new,
    };
    if !re_name(new) {
        return Err(format!("`{new}` is not a name q takes"));
    }
    if q_lint_rs::builtin(new).is_some() || q_lint_rs::is_reserved(new) {
        return Err(format!("`{new}` is a q builtin, which q refuses to assign"));
    }
    if new == old {
        return Ok(json!({"changes": {}}));
    }
    let targets = in_every_context(sources, targets, old);
    let mut renamed: Vec<String> = targets.iter().map(|name| releafed(name, new)).collect();
    renamed.sort_unstable();
    if let Some(taken) = renamed.iter().find(|name| sources.idx.ws.defines(name)) {
        return Err(format!("`{taken}` is already assigned in the workspace"));
    }
    let mut changes = serde_json::Map::new();
    for key in sources.keys() {
        let Some((uri, text)) = sources.text(key) else {
            continue;
        };
        if !text.contains(old) {
            continue;
        }
        let placement = &sources.idx.files[key].placement;
        let lines = Lines::new(&text);
        let mut edits = vec![];
        let mut bare = vec![];
        let mut columns = vec![];
        let mut done = HashSet::new();
        let mut edited = vec![];
        let all = mentions(&text);
        for m in &all {
            if done.contains(&m.at) {
                continue;
            }
            // The part that spells the global: all of the mention, or what
            // comes before the rest of a dotted read through it, `ta` of
            // `ta.c` (#2017).
            let Some(part) = sources.spelt(&text, m, placement, &targets) else {
                continue;
            };
            done.insert(m.at);
            edited.push(m.at);
            let spelling = &text[m.at..m.at + part];
            let place = || {
                let (line, _) = lines.position(m.at);
                format!("{}:{}", Path::new(key).display(), line + 1)
            };
            if leaf(spelling) != old {
                return Err(format!(
                    "`{}` at {} names it without ending in `{old}`, which a rename \
                     cannot follow",
                    &text[m.at..m.at + m.len],
                    place()
                ));
            }
            // A symbol where q takes a global by name. Read in a lambda
            // written under a `\d` it is looked up where the lambda is
            // called, there or at the root: with both defined, which one it
            // names is not in the text (#2018).
            let symbol = text[..m.at].ends_with('`');
            if symbol
                && m.definition.is_none()
                && let Some(other) = all
                    .iter()
                    .filter(|other| other.at == m.at)
                    .flat_map(|other| sources.names(&text, other, placement))
                    .find(|name| !targets.contains(name) && sources.idx.ws.defines(name))
            {
                return Err(format!(
                    "`` `{spelling} `` at {} is looked up where its lambda is called, and \
                     `{other}` is defined too: which of the two it names is not in the text",
                    place()
                ));
            }
            if !spelling.contains('.') && !symbol {
                columns.push(m.at);
                // Dot notation reads a global whatever the lambda's locals
                // are: KDB-X 5 `{[ta] ta.c}[5]` is the global's column.
                if part == m.len {
                    bare.push(m.at);
                }
            }
            edits.push(
                json!({"range": range(&lines, m.at + part - old.len(), old.len()),
                              "newText": new}),
            );
        }
        // A symbol that would be this global were it taken for a name, in a
        // place where nothing says it is: `` `t in tables[] ``, one of a
        // list, an argument of a function. Leaving it would rename some
        // uses and not others, so the rename is refused instead (#2018).
        let known: HashSet<usize> = all.iter().map(|m| m.at).collect();
        if let Some(m) = symbol_mentions(&text, old).iter().find(|m| {
            !known.contains(&m.at)
                && sources
                    .names(&text, m, placement)
                    .iter()
                    .any(|name| targets.contains(name))
        }) {
            let (line, _) = lines.position(m.at);
            return Err(format!(
                "the symbol `` `{old} `` at {}:{} may name it or be only a symbol, which the \
                 text does not say: a rename that left it would change some uses and not others",
                Path::new(key).display(),
                line + 1
            ));
        }
        // A bare name in a qSQL phrase is a column whenever the table has
        // one of that name, which only the table says; the table after
        // `from` is a global (#1207). So is the head of `ta.c` there: the
        // column `ta` followed through its foreign key, when there is one.
        let clauses = q_lint_rs::query_clauses(&text, &columns);
        if let Some((&at, _)) = columns
            .iter()
            .zip(&clauses)
            .find(|(_, clause)| clause.is_some_and(|c| c != "from"))
        {
            let (line, _) = lines.position(at);
            return Err(format!(
                "`{old}` is read inside a qSQL phrase at {}:{}, where it is a column whenever \
                 the table has one of that name - which only the table says",
                Path::new(key).display(),
                line + 1
            ));
        }
        // k reads `_` as its drop, no part of a name: KDB-X 5 refuses
        // `k)gk:f_k+1` with 'k, where `k)gk:fk+1` read the global (#2044).
        // No spelling of the new name is one k reads as it.
        if new.contains('_')
            && let Some(at) = q_lint_rs::on_k_line(&text, &edited)
        {
            let (line, _) = lines.position(at);
            return Err(format!(
                "`{new}` has a `_`, which the `k)` line at {}:{} would read as k's drop, \
                 no part of a name",
                Path::new(key).display(),
                line + 1
            ));
        }
        if let Some(hidden) = q_lint_rs::shadowing(&text, new, &bare) {
            let (line, _) = lines.position(hidden);
            return Err(format!(
                "`{new}` is a parameter or local of the lambda at {}:{}, which would hide the \
                 renamed global there",
                Path::new(key).display(),
                line + 1
            ));
        }
        if !edits.is_empty() {
            changes.insert(uri, json!(edits));
        }
    }
    Ok(json!({"changes": changes}))
}

/// `targets` with every other name a rewritten mention answers to: a file
/// loaded under two `\d` contexts defines `.aa.ff` and `.bb.ff` with one
/// `ff:`, so renaming that text renames both, and each use of either has to
/// follow. KDB-X 5 runs `\d .aa`, `\l b.q`, `\d .bb`, `\l b.q` with b.q's
/// `ff:{1}`, and `.bb.ff[]` is 1 (#2043). Followed until nothing is added, a
/// mention through the head of a dotted read (`ta` of `ta.c`) included.
fn in_every_context(sources: &Sources, mut targets: HashSet<String>, old: &str) -> HashSet<String> {
    let texts: Vec<_> = sources
        .keys()
        .into_iter()
        .filter_map(|key| {
            let (_, text) = sources.text(key)?;
            text.contains(old).then_some((key, text))
        })
        .collect();
    loop {
        let mut added = vec![];
        for (key, text) in &texts {
            let placement = &sources.idx.files[*key].placement;
            for m in mentions(text) {
                let names = sources.names(text, &m, placement);
                // How much of each name is after the part a rename rewrites.
                let rest = names.iter().find_map(|name| {
                    if targets.contains(name) {
                        return Some(0);
                    }
                    name.match_indices('.')
                        .rfind(|&(dot, _)| dot > 0 && targets.contains(&name[..dot]))
                        .map(|(dot, _)| name.len() - dot)
                });
                let Some(rest) = rest else {
                    continue;
                };
                added.extend(
                    names
                        .iter()
                        .filter(|name| name.len() > rest)
                        .map(|name| name[..name.len() - rest].to_string())
                        .filter(|name| !targets.contains(name)),
                );
            }
        }
        if added.is_empty() {
            return targets;
        }
        targets.extend(added);
    }
}

/// Whether `name` is one q takes for a name, with no dot in it.
fn re_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
