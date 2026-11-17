//! The file-to-file dependency graph of a q tree, read and never run.
//!
//! Built from the same passes the checks use, stopped before any rule:
//! `index` says what each file defines, `references` what each reads. A file
//! depends on another when it reads a name the other defines, or loads it by
//! a literal path. It is not go-to-definition: it is per-file sets of names,
//! the same approximation the workspace already makes for colouring, and
//! where reading cannot know what a name is, the file says so in `dynamic`
//! rather than the graph guessing.
use crate::{Dynamic, references};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

/// One file's place in the graph.
#[derive(Default, Debug, PartialEq, Eq)]
pub struct Node {
    /// The files this one reads a name from or loads.
    pub dependencies: BTreeSet<PathBuf>,
    /// Each name this file reads that more than one file defines, with every
    /// file defining it. The graph has an edge to each of the others, since
    /// which definition wins is load order, and load order is not in the
    /// source.
    pub ambiguous: BTreeMap<String, BTreeSet<PathBuf>>,
    /// Where this file reaches a name the graph cannot see. A caller that
    /// wants to be safe treats such a file as depending on everything.
    pub dynamic: Vec<Dynamic>,
}

/// The graph of `files`, each an absolute path and its source. `symbols`
/// counts a qualified symbol literal as a read of the name it spells. `cwd`
/// is the first directory a relative `\l` path is tried against, before the
/// loading file's own directory and its ancestors: q resolves it against
/// the process's directory and nowhere else, and the source does not say
/// which directory that is.
pub fn build(files: &[(PathBuf, String)], symbols: bool, cwd: &Path) -> BTreeMap<PathBuf, Node> {
    let mut definers: HashMap<String, Vec<usize>> = HashMap::new();
    let mut reads = Vec::with_capacity(files.len());
    for (i, (_, source)) in files.iter().enumerate() {
        let read = references(source, symbols);
        for name in &read.defines {
            definers.entry(name.clone()).or_default().push(i);
        }
        reads.push(read);
    }
    let tree = Tree::new(files, cwd);
    let contexts = contexts(&reads, &tree);
    for (d, namespaces) in contexts.iter().enumerate() {
        for namespace in namespaces {
            for name in &reads[d].implicit_defines {
                let defs = definers.entry(format!("{namespace}.{name}")).or_default();
                if !defs.contains(&d) {
                    defs.push(d);
                }
            }
        }
    }
    let identity = &tree.identity;
    let targets = |i: usize, load: &str| tree.targets(i, load);
    let mut graph = BTreeMap::new();
    for (i, (path, _)) in files.iter().enumerate() {
        let mut node = Node {
            dynamic: reads[i].dynamic.clone(),
            ..Node::default()
        };
        // A name written without a dot that nobody defines is looked for in
        // `.q`, which q searches from every context: after
        // `.q.answer:{42}`, q 5's `answer[]` is 42 at the root (#358) and
        // in a `\d .a` lambda (#530).
        let mut in_q: HashMap<String, String> = reads[i]
            .relative
            .iter()
            .filter(|r| !r.name.contains('.'))
            .map(|r| (r.resolved.clone(), format!(".q.{}", r.name)))
            .collect();
        // Read before the file's own first `\d`, a bare name is resolved in
        // each context the file is loaded in as well: with b.q loaded under
        // `\d .a`, its `g:{helper[]}` reads `.a.helper` (q 5, #531).
        let mut names = reads[i].names.clone();
        for namespace in &contexts[i] {
            for r in reads[i].relative.iter().filter(|r| r.implicit) {
                let name = format!("{namespace}.{}", r.name);
                if !r.name.contains('.') {
                    in_q.insert(name.clone(), format!(".q.{}", r.name));
                }
                names.push(name);
            }
        }
        for name in &names {
            let Some((name, defs)) = resolve(name, &definers).or_else(|| {
                in_q.get(name)
                    .and_then(|q| definers.get_key_value(q))
                    .map(|(k, d)| (k.as_str(), d.as_slice()))
            }) else {
                continue;
            };
            let others: Vec<_> = defs
                .iter()
                .filter(|&&d| identity[d] != identity[i])
                .collect();
            if others.is_empty() {
                continue;
            }
            for &&d in &others {
                node.dependencies.insert(files[d].0.clone());
            }
            if defs.iter().any(|&d| identity[d] != identity[defs[0]]) {
                node.ambiguous.insert(
                    name.to_string(),
                    defs.iter().map(|&d| files[d].0.clone()).collect(),
                );
            }
        }
        for (load, _) in &reads[i].loads {
            for d in targets(i, load) {
                if identity[d] != identity[i] {
                    node.dependencies.insert(files[d].0.clone());
                }
            }
        }
        graph.insert(path.clone(), node);
    }
    graph
}

/// The files of a graph, found by any name a load reaches them by.
struct Tree<'a> {
    files: &'a [(PathBuf, String)],
    cwd: &'a Path,
    position: HashMap<PathBuf, usize>,
    /// The scripts directly in each directory.
    scripts_in: HashMap<&'a Path, Vec<usize>>,
    /// Each file as the first of `files` that is the same file.
    identity: Vec<usize>,
}

impl<'a> Tree<'a> {
    fn new(files: &'a [(PathBuf, String)], cwd: &'a Path) -> Self {
        // A file is keyed by the path it was found at, a symlink by its own
        // name: `\l lib/link.q` is an edge to `lib/link.q`, which q 5 loads
        // (#526). A load reaching it through another name - a symlinked
        // directory, the link's target - finds it by the real path.
        let mut position: HashMap<PathBuf, usize> = files
            .iter()
            .enumerate()
            .map(|(i, (p, _))| (p.clone(), i))
            .collect();
        for (i, (p, _)) in files.iter().enumerate() {
            if let Ok(real) = std::fs::canonicalize(p) {
                position.entry(real).or_insert(i);
            }
        }
        // One file under two names is one file: neither name depends on the
        // other, nor makes a name the file defines ambiguous (#527).
        let identity = files
            .iter()
            .map(|(p, _)| {
                std::fs::canonicalize(p)
                    .ok()
                    .and_then(|real| position.get(&real).copied())
                    .unwrap_or(position[p])
            })
            .collect();
        // A directory loaded, `\l db`, runs the scripts directly in it (q 5's
        // `.Q.lo`), so it leads to each of them (#533).
        let mut scripts_in: HashMap<&Path, Vec<usize>> = HashMap::new();
        for (i, (p, _)) in files.iter().enumerate() {
            if let Some(dir) = p.parent() {
                scripts_in.entry(dir).or_default().push(i);
            }
        }
        Tree {
            files,
            cwd,
            position,
            scripts_in,
            identity,
        }
    }

    /// The files `\l load` in file `i` leads to.
    fn targets(&self, i: usize, load: &str) -> Vec<usize> {
        let candidates = load_targets(&self.files[i].0, load, self.cwd);
        candidates
            .iter()
            .find_map(|p| {
                self.position
                    .get(p)
                    .or_else(|| self.position.get(&std::fs::canonicalize(p).ok()?))
                    .map(|&d| vec![d])
            })
            .or_else(|| {
                candidates
                    .iter()
                    .find_map(|p| self.scripts_in.get(p.as_path()).cloned())
            })
            .unwrap_or_default()
    }
}

/// The contexts each file is loaded in by another, `.a` for a `\l` under
/// `\d .a`. A script loaded under `\d .a` runs in `.a`, so what it writes at
/// its root is `.a.name` too: q 5, after `\d .a` and `\l b.q` with b.q's
/// `ff:{1}`, has `.a.ff` and no `ff`. Its own `\d` does not leak back out.
/// A load at a loaded script's root runs in the context that script runs
/// in: `\l c.q` at b.q's root, with b.q loaded under `\d .a`, puts c.q's
/// `gg` at `.a.gg` (q 5). Only before the script's own first `\d`: after
/// its `\d .`, `yy:2` is the root's `yy` and no `.a.yy` (q 5, #532).
fn contexts<'r>(reads: &'r [crate::References], tree: &Tree) -> Vec<BTreeSet<&'r str>> {
    let mut contexts: Vec<BTreeSet<&str>> = vec![BTreeSet::new(); reads.len()];
    let mut pending: Vec<(usize, &str)> = vec![];
    for (i, read) in reads.iter().enumerate() {
        for (load, namespace) in &read.loads {
            if !namespace.is_empty() && namespace != "." {
                for d in tree.targets(i, load) {
                    pending.push((d, namespace));
                }
            }
        }
    }
    while let Some((d, namespace)) = pending.pop() {
        if !contexts[d].insert(namespace) {
            continue;
        }
        for (load, inner) in &reads[d].loads {
            if inner.is_empty() {
                for next in tree.targets(d, load) {
                    pending.push((next, namespace));
                }
            }
        }
    }
    contexts
}

/// What each of `files` defines in the contexts the others load it in:
/// `(name, .a.name)` for b.q's `name` when b.q is loaded under `\d .a`. The
/// root names are kept, since the same script may be loaded or run at the
/// root elsewhere, and one loaded from several contexts defines in each.
pub fn loaded_definitions(files: &[(PathBuf, String)], cwd: &Path) -> Vec<Vec<(String, String)>> {
    let reads: Vec<_> = files
        .iter()
        .map(|(_, source)| references(source, false))
        .collect();
    let tree = Tree::new(files, cwd);
    contexts(&reads, &tree)
        .iter()
        .zip(&reads)
        .map(|(namespaces, read)| {
            namespaces
                .iter()
                .flat_map(|ns| {
                    read.implicit_defines
                        .iter()
                        .map(move |name| (name.clone(), format!("{ns}.{name}")))
                })
                .collect()
        })
        .collect()
}

/// The definers of `name`. A name no file defines is tried without its last
/// segment, so `.ns.cfg.port` reaches the file defining the dictionary
/// `.ns.cfg`.
fn resolve<'a>(
    mut name: &'a str,
    definers: &'a HashMap<String, Vec<usize>>,
) -> Option<(&'a str, &'a [usize])> {
    loop {
        if let Some(defs) = definers.get(name) {
            return Some((name, defs));
        }
        match name.rfind('.') {
            Some(at) if at > 0 => name = &name[..at],
            _ => return None,
        }
    }
}

/// Where `\l load` in the file at `from` might lead, in the order tried:
/// `cwd`, then the file's own directory and each directory above it. q 5
/// run from a directory holding `b.q` and `sub/b.q` loads the first for
/// `sub/a.q`'s `\l b.q` (#529).
fn load_targets(from: &Path, load: &str, cwd: &Path) -> Vec<PathBuf> {
    let load = Path::new(load);
    if load.is_absolute() {
        return vec![lexical(load)];
    }
    std::iter::once(cwd)
        .chain(from.ancestors().skip(1))
        .map(|dir| lexical(&dir.join(load)))
        .collect()
}

/// `path` with its `.` and `..` resolved by reading it, not the disk.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            _ => out.push(c),
        }
    }
    out
}
