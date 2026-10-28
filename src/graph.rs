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
        for load in &reads[i].loads {
            if let Some(&d) = load_targets(path, load, cwd)
                .iter()
                .find_map(|p| position.get(p.as_path()))
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
