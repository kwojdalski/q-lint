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
/// is one more directory a relative `\l` path is tried against, after the
/// loading file's own directory and its ancestors: q resolves it against
/// the process's directory, which the source does not say.
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
    let position: HashMap<&Path, usize> = files
        .iter()
        .enumerate()
        .map(|(i, (p, _))| (p.as_path(), i))
        .collect();
    let target = |i: usize, load: &str| {
        load_targets(&files[i].0, load, cwd)
            .iter()
            .find_map(|p| position.get(p.as_path()).copied())
    };
    // A script loaded under `\d .a` runs in `.a`, so what it writes at its
    // root is `.a.name` too: q 5, after `\d .a` and `\l b.q` with b.q's
    // `ff:{1}`, has `.a.ff` and no `ff`. Its own `\d` does not leak back
    // out. The root names are kept, since the same script may be loaded or
    // run at the root elsewhere, and one loaded from several contexts
    // defines in each. A load at a loaded script's root runs in the context
    // that script runs in: `\l c.q` at b.q's root, with b.q loaded under
    // `\d .a`, puts c.q's `gg` at `.a.gg` (q 5).
    let mut contexts: Vec<BTreeSet<&str>> = vec![BTreeSet::new(); files.len()];
    let mut pending: Vec<(usize, &str)> = vec![];
    for (i, read) in reads.iter().enumerate() {
        for (load, namespace) in &read.loads {
            if let Some(d) = target(i, load)
                && !namespace.is_empty()
            {
                pending.push((d, namespace));
            }
        }
    }
    while let Some((d, namespace)) = pending.pop() {
        if !contexts[d].insert(namespace) {
            continue;
        }
        for name in reads[d].defines.iter().filter(|n| !n.starts_with('.')) {
            let defs = definers.entry(format!("{namespace}.{name}")).or_default();
            if !defs.contains(&d) {
                defs.push(d);
            }
        }
        for (load, inner) in &reads[d].loads {
            if inner.is_empty()
                && let Some(next) = target(d, load)
            {
                pending.push((next, namespace));
            }
        }
    }
    let mut graph = BTreeMap::new();
    for (i, (path, _)) in files.iter().enumerate() {
        let mut node = Node {
            dynamic: reads[i].dynamic.clone(),
            ..Node::default()
        };
        for name in &reads[i].names {
            let Some((name, defs)) = resolve(name, &definers) else {
                continue;
            };
            let others: Vec<_> = defs.iter().filter(|&&d| d != i).collect();
            if others.is_empty() {
                continue;
            }
            for &&d in &others {
                node.dependencies.insert(files[d].0.clone());
            }
            if defs.len() > 1 {
                node.ambiguous.insert(
                    name.to_string(),
                    defs.iter().map(|&d| files[d].0.clone()).collect(),
                );
            }
        }
        for (load, _) in &reads[i].loads {
            if let Some(d) = target(i, load)
                && d != i
            {
                node.dependencies.insert(files[d].0.clone());
            }
        }
        graph.insert(path.clone(), node);
    }
    graph
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

/// Where `\l load` in the file at `from` might lead, in the order tried: the
/// file's own directory, each directory above it, then `cwd`.
fn load_targets(from: &Path, load: &str, cwd: &Path) -> Vec<PathBuf> {
    let load = Path::new(load);
    if load.is_absolute() {
        return vec![normal(load)];
    }
    from.ancestors()
        .skip(1)
        .chain(std::iter::once(cwd))
        .map(|dir| normal(&dir.join(load)))
        .collect()
}

/// `path` resolved through symlinks when it exists, as the files in the graph
/// were, and lexically otherwise.
fn normal(path: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
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
