//! How the files and functions of a workspace relate: a file's dependencies
//! and dependents, the tests a change reaches, and the call hierarchy.
//!
//! THE GRAPH IS THE CLI'S
//!
//! `q-lint/graph` and `q-lint/affectedTests` answer from the graph
//! `qlinter analyze graph` prints - `q_lint_rs::graph`, the same edges by the
//! same rules - drawn over what the index holds instead of over the disk, so
//! an open buffer counts as the editor has it. The index keeps what each file
//! reads for this (`Indexed::read`), which is names and no positions; a
//! request builds the graph from those and reads no file.
//!
//! WHO CHANGED WHAT IS THE CLIENT'S TO SAY
//!
//! "The tests a change reaches" needs the changed files, and those are git's
//! to name. This server starts no process, so it does not ask git: the client
//! sends the files, and the server follows the edges back from them.
//!
//! A CALL IS A NAME IN A BODY
//!
//! The call hierarchy is the references list, grouped: each place a file
//! names a function is put under the top-level definition whose statement it
//! is in, and under the file itself when it is in none - a script's own
//! `main[]`, a handler assigned in passing. That is what reading gives, and
//! it is more than calls and less than all of them: a function handed on as
//! a value (`f each x`, `` `handler set f ``) is named and so listed, and one
//! reached through a string or a symbol built at run time is in no list. As
//! with every position here, the files are read when the request is made.
use super::navigate::{FUNCTION, Sources, VARIABLE, range};
use super::{Lines, file_key, is_q_uri, path_of, path_uri};
use q_lint_rs::graph::{self, Node, Placement};
use q_lint_rs::{Mention, Name, References, mentions, name_at};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};

/// LSP's `SymbolKind` for a file: what a reference outside every definition
/// is put under.
const FILE: u8 = 1;

/// What the server adds to its capabilities for the requests answered here.
/// The two that are this server's own go under `experimental`, by the name
/// of the method, which is where LSP 3.17 has a server say what the protocol
/// has no word for - and how a client tells a server that has them from an
/// older one that would refuse the method.
pub(super) fn announce(capabilities: &mut Value, calls: bool, graph: bool) {
    if calls {
        capabilities["callHierarchyProvider"] = json!(true);
    }
    if graph {
        capabilities["experimental"]["q-lint/graph"] = json!(true);
        capabilities["experimental"]["q-lint/affectedTests"] = json!(true);
    }
}

/// The answer to `method`, and `null` for one that is switched off: a client
/// that asks anyway is told there is nothing, as for any document this
/// server does not read.
pub(super) fn answer(
    method: &str,
    params: &Value,
    sources: &Sources,
    calls: bool,
    graph: bool,
) -> Value {
    match method {
        "q-lint/graph" if graph => file_graph(params, sources),
        "q-lint/affectedTests" if graph => affected_tests(params, sources),
        "textDocument/prepareCallHierarchy" if calls => prepare(params, sources),
        "callHierarchy/incomingCalls" if calls => incoming(params, sources),
        "callHierarchy/outgoingCalls" if calls => outgoing(params, sources),
        _ => Value::Null,
    }
}

/// The dependency graph of the indexed files. `--symbols` is the CLI's to
/// ask for; here a symbol literal is not a read, as in its default.
fn graph_of(sources: &Sources) -> BTreeMap<PathBuf, Node> {
    let keys = sources.keys();
    let paths: Vec<PathBuf> = keys.iter().map(PathBuf::from).collect();
    let reads: Vec<&References> = keys
        .iter()
        .map(|key| &sources.idx.files[*key].read)
        .collect();
    graph::build_from(&paths, &reads, &sources.idx.cwd())
}

/// The URI of an indexed file: the one the client opened it by, which a
/// client compares as text, and the path's own for a file it has not opened.
fn uri_of(sources: &Sources, file: &Path) -> String {
    match sources.open.get(&*file.to_string_lossy()) {
        Some(uri) => uri.to_string(),
        None => path_uri(file),
    }
}

/// The indexed file a URI names, as the graph has it.
fn file_of(uri: &str) -> Option<PathBuf> {
    is_q_uri(uri).then(|| file_key(&path_of(uri)).into())
}

/// `q-lint/graph`: the files the document depends on and those depending on
/// it, with what `qlinter analyze graph --detail` adds - each name it reads
/// that more than one file defines, and each line where it reaches a name
/// the graph cannot see, numbered from 1 as the CLI prints them. `null` for
/// a document that is not an indexed `.q` file.
fn file_graph(params: &Value, sources: &Sources) -> Value {
    let Some(uri) = params["textDocument"]["uri"].as_str() else {
        return Value::Null;
    };
    let graph = graph_of(sources);
    let Some((file, node)) = file_of(uri).and_then(|file| graph.get_key_value(&file)) else {
        return Value::Null;
    };
    let uris = |files: &mut dyn Iterator<Item = &PathBuf>| -> Vec<String> {
        files.map(|file| uri_of(sources, file)).collect()
    };
    let ambiguous: BTreeMap<&str, Vec<String>> = node
        .ambiguous
        .iter()
        .map(|(name, files)| (name.as_str(), uris(&mut files.iter())))
        .collect();
    let mut dependents = graph
        .iter()
        .filter(|(_, other)| other.dependencies.contains(file))
        .map(|(other, _)| other);
    json!({
        "uri": uri,
        "dependencies": uris(&mut node.dependencies.iter()),
        "dependents": uris(&mut dependents),
        "ambiguous": ambiguous,
        "dynamic": node.dynamic,
    })
}

/// `q-lint/affectedTests`: the test files that reach one of the `changed`
/// files along the graph - a changed test among them, as reaching itself.
///
/// `changed` in the answer is those of the request's files the index holds,
/// each once and as the client spelled it, which is the spelling it has to
/// recognise; a test's `reaches` names the ones it reaches by their place in
/// that list. By place, since a change to a file most of a workspace reads
/// reaches most of its tests, and each would otherwise repeat every URI.
/// `unindexed` is each `.q` file of the request the index does not hold -
/// deleted, excluded, outside the workspace - whose dependents therefore
/// cannot be followed: a client says so, where a list that looked complete
/// would not. What is not a `.q` file is passed over, a change to it being
/// nothing this server reads.
fn affected_tests(params: &Value, sources: &Sources) -> Value {
    let graph = graph_of(sources);
    let mut changed: Vec<PathBuf> = vec![];
    let mut listed: HashSet<PathBuf> = HashSet::new();
    let mut spelled: Vec<&str> = vec![];
    let mut unindexed: Vec<&str> = vec![];
    let sent = params["changed"].as_array().into_iter().flatten();
    for uri in sent.filter_map(Value::as_str) {
        match file_of(uri) {
            Some(file) if !graph.contains_key(&file) => unindexed.push(uri),
            Some(file) if listed.insert(file.clone()) => {
                changed.push(file);
                spelled.push(uri);
            }
            _ => {}
        }
    }
    unindexed.sort_unstable();
    unindexed.dedup();
    let roots: Vec<PathBuf> = sources
        .idx
        .roots
        .iter()
        .map(|root| file_key(root).into())
        .collect();
    let tests: Vec<Value> = graph::reaching(&graph, &changed)
        .iter()
        .filter(|(file, _)| graph::is_test(&in_workspace(&roots, file)))
        .map(|(file, reaches)| json!({"uri": uri_of(sources, file), "reaches": reaches}))
        .collect();
    json!({"tests": tests, "changed": spelled, "unindexed": unindexed})
}

/// `file` as `graph::is_test` wants it: below the workspace folder it is in,
/// so that a folder checked out under some `tests` directory is not all
/// tests. A file in no folder is judged by its own name.
fn in_workspace(roots: &[PathBuf], file: &Path) -> PathBuf {
    roots
        .iter()
        .filter_map(|root| file.strip_prefix(root).ok())
        .min_by_key(|rest| rest.components().count())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| file.file_name().map(PathBuf::from).unwrap_or_default())
}

/// One indexed file, read for the hierarchy: each place it names a global,
/// and where its loaders put what it writes.
struct Read<'a> {
    uri: String,
    text: Cow<'a, str>,
    mentions: Vec<Mention>,
    placement: Placement,
}

impl<'a> Read<'a> {
    /// The indexed file `key`, when `wanted` of its text - which is how a
    /// file that does not spell a name at all is left unparsed.
    fn of(sources: &Sources<'a>, key: &str, wanted: impl Fn(&str) -> bool) -> Option<Self> {
        if !sources.idx.files.contains_key(key) {
            return None;
        }
        let (uri, text) = sources.text(key)?;
        if !wanted(&text) {
            return None;
        }
        Some(Read {
            mentions: mentions(&text),
            placement: sources.placement(key),
            uri,
            text,
        })
    }

    /// The names a mention answers to, as navigation has them.
    fn names(&self, sources: &Sources, mention: &Mention) -> Vec<String> {
        sources.names(&self.text, mention, &self.placement)
    }

    /// The top-level definition a reference at byte `at` belongs to, by its
    /// place in `mentions`: the one whose statement holds the reference, and
    /// of several written in one statement (`a:b:{f[]}`) the nearest before
    /// it. `None` for a reference in no definition, which is the file's own.
    ///
    /// Only a top-level write carries its statement; one inside a lambda
    /// (`g::v`) spans its name alone and holds nothing, so what a function
    /// assigned there mentions belongs to the definition around it.
    fn home(&self, at: usize) -> Option<usize> {
        self.mentions
            .iter()
            .enumerate()
            .filter(|(_, m)| {
                m.definition.as_ref().is_some_and(|d| {
                    (d.start, d.end) != (m.at, m.at + m.len) && d.start <= at && at < d.end
                })
            })
            .max_by_key(|(_, m)| (m.at <= at, m.at))
            .map(|(i, _)| i)
    }

    /// Each read of a global, with the definition it belongs to.
    fn reads(&self) -> impl Iterator<Item = (&Mention, Option<usize>)> {
        self.mentions
            .iter()
            .filter(|m| m.definition.is_none())
            .map(|m| (m, self.home(m.at)))
    }

    /// The `CallHierarchyItem` of the definition at `mentions[i]`: the
    /// statement as its range and the name as what to select, as the outline
    /// has it. A name written before the file's first `\d` is shown as
    /// written when the file is loaded at the root, and in the context it is
    /// loaded in otherwise.
    fn item(&self, sources: &Sources, lines: &Lines, i: usize) -> Value {
        let m = &self.mentions[i];
        let (function, detail, start, end) = match &m.definition {
            Some(d) => (d.function, d.detail.as_str(), d.start, d.end),
            None => (false, "", m.at, m.at + m.len),
        };
        let names = self.names(sources, m);
        let name = match names.first() {
            Some(first) if !names.contains(&m.name) => first,
            _ => &m.name,
        };
        // The selection has to lie within the range (LSP 3.17).
        let (start, end) = (start.min(m.at), end.max(m.at + m.len));
        json!({
            "name": name,
            "kind": if function { FUNCTION } else { VARIABLE },
            "detail": detail,
            "uri": self.uri,
            "range": range(lines, start, end - start),
            "selectionRange": range(lines, m.at, m.len),
        })
    }

    /// The item standing for the file itself: what is named outside every
    /// definition, and run when the script is loaded.
    fn file_item(&self, lines: &Lines) -> Value {
        let name = self
            .uri
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.uri);
        json!({
            "name": name,
            "kind": FILE,
            "detail": "top level",
            "uri": self.uri,
            "range": range(lines, 0, self.text.len()),
            "selectionRange": range(lines, 0, 0),
        })
    }
}

/// The file an item is in, and the definition it is of - `None` for the item
/// of a file. An item is taken at its word for nothing but where it points:
/// the file is read again and the definition found there, so one prepared
/// before an edit that moved or removed it is no item, and answers `null`.
fn of_item<'a>(sources: &Sources<'a>, item: &Value) -> Option<(Read<'a>, Option<usize>)> {
    let uri = item["uri"].as_str().filter(|uri| is_q_uri(uri))?;
    let read = Read::of(sources, &file_key(&path_of(uri)), |_| true)?;
    if item["kind"] == FILE {
        return Some((read, None));
    }
    let start = &item["selectionRange"]["start"];
    let offset = Lines::new(&read.text).offset(
        start["line"].as_u64()? as usize,
        start["character"].as_u64()? as usize,
    );
    let i = read
        .mentions
        .iter()
        .position(|m| m.at == offset && m.definition.is_some())?;
    Some((read, Some(i)))
}

/// Each place a file assigns a lambda to one of `names`, once a name and
/// file, where it first does, as the outline lists them. Only the files the
/// index has defining one as a function are read. `each` gets the file, its
/// lines, the definition's place in `Read::mentions` and the names it
/// answers to.
fn functions(
    sources: &Sources,
    names: &HashSet<&str>,
    mut each: impl FnMut(&Read, &Lines, usize, &[String]),
) {
    for key in sources.keys() {
        let lambdas = &sources.idx.files[key].placed.lambdas;
        if !names.iter().any(|name| lambdas.contains(*name)) {
            continue;
        }
        let Some(file) = Read::of(sources, key, |_| true) else {
            continue;
        };
        let lines = Lines::new(&file.text);
        let mut listed = HashSet::new();
        for (i, m) in file.mentions.iter().enumerate() {
            if !m.definition.as_ref().is_some_and(|d| d.function) || !listed.insert(&m.name) {
                continue;
            }
            let answers = file.names(sources, m);
            if answers.iter().any(|name| names.contains(name.as_str())) {
                each(&file, &lines, i, &answers);
            }
        }
    }
}

/// `textDocument/prepareCallHierarchy`: the function under the cursor, as
/// each file that assigns the name a lambda - every one, since which
/// assignment ran last is not something reading says. `null` for a local,
/// and for a global no indexed file defines as a function.
fn prepare(params: &Value, sources: &Sources) -> Value {
    let Some(cursor) = sources.cursor(params) else {
        return Value::Null;
    };
    let Some(Name::Global { at, .. }) = name_at(cursor.text, cursor.offset) else {
        return Value::Null;
    };
    let targets = sources.targets(&cursor, at);
    let mut items = vec![];
    functions(
        sources,
        &targets.iter().map(String::as_str).collect(),
        |file, lines, i, _| items.push(file.item(sources, lines, i)),
    );
    if items.is_empty() {
        Value::Null
    } else {
        json!(items)
    }
}

/// `callHierarchy/incomingCalls`: each top-level definition, or file, that
/// names the item's function, with every place it does. Every indexed file
/// spelling the name is read, as for find references. Nothing names a file,
/// so the item of one has no callers.
fn incoming(params: &Value, sources: &Sources) -> Value {
    let Some((read, which)) = of_item(sources, &params["item"]) else {
        return Value::Null;
    };
    let Some(i) = which else {
        return json!([]);
    };
    let names: HashSet<String> = read.names(sources, &read.mentions[i]).into_iter().collect();
    let leaves: HashSet<&str> = names
        .iter()
        .filter_map(|name| name.rsplit('.').next())
        .collect();
    let mut out = vec![];
    for key in sources.keys() {
        let spelled = |text: &str| leaves.iter().any(|leaf| text.contains(leaf));
        let Some(file) = Read::of(sources, key, spelled) else {
            continue;
        };
        let lines = Lines::new(&file.text);
        // In the order the file first names it from each.
        let mut callers: Vec<(Option<usize>, Vec<Value>)> = vec![];
        for (m, home) in file.reads() {
            if !file
                .names(sources, m)
                .iter()
                .any(|name| names.contains(name))
            {
                continue;
            }
            let place = range(&lines, m.at, m.len);
            match callers.iter_mut().find(|(caller, _)| *caller == home) {
                Some((_, places)) => places.push(place),
                None => callers.push((home, vec![place])),
            }
        }
        for (caller, places) in callers {
            let from = match caller {
                Some(i) => file.item(sources, &lines, i),
                None => file.file_item(&lines),
            };
            out.push(json!({"from": from, "fromRanges": places}));
        }
    }
    json!(out)
}

/// `callHierarchy/outgoingCalls`: each workspace function the item's
/// statement names - or, for the item of a file, each one the file names
/// outside every definition - with the places it is named there.
fn outgoing(params: &Value, sources: &Sources) -> Value {
    let Some((read, which)) = of_item(sources, &params["item"]) else {
        return Value::Null;
    };
    let lines = Lines::new(&read.text);
    let named: Vec<(Value, Vec<String>)> = read
        .reads()
        .filter(|(_, home)| *home == which)
        .map(|(m, _)| (range(&lines, m.at, m.len), read.names(sources, m)))
        .collect();
    let wanted: HashSet<&str> = named
        .iter()
        .flat_map(|(_, names)| names.iter().map(String::as_str))
        .collect();
    let mut out = vec![];
    functions(sources, &wanted, |file, target_lines, i, answers| {
        let places: Vec<&Value> = named
            .iter()
            .filter(|(_, names)| names.iter().any(|name| answers.contains(name)))
            .map(|(place, _)| place)
            .collect();
        if !places.is_empty() {
            out.push(json!({"to": file.item(sources, target_lines, i), "fromRanges": places}));
        }
    });
    json!(out)
}
