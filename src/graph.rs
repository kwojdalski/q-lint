//! The file-to-file dependency graph of a q tree, read and never run.
//!
//! Built from the same passes the checks use, stopped before any rule:
//! `index` says what each file defines, `references` what each reads. A file
//! depends on another when it reads a name the other defines, or loads it by
//! a literal path. It is not go-to-definition: it is per-file sets of names,
//! the same approximation the workspace already makes for colouring, and
//! where reading cannot know what a name is, the file says so in `dynamic`
//! rather than the graph guessing.
use crate::{Dynamic, FileIndex, References, references};
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
    let paths: Vec<PathBuf> = files.iter().map(|(p, _)| p.clone()).collect();
    let reads: Vec<References> = files
        .iter()
        .map(|(_, source)| references(source, symbols))
        .collect();
    build_from(&paths, &reads.iter().collect::<Vec<_>>(), cwd)
}

/// `build`, for a caller that already holds what each file reads: `reads[i]`
/// is `references` of the file at `paths[i]`. The language server keeps that
/// for every file it indexes - an open buffer's as the editor has it - so
/// the graph it draws is the one this module defines, of the text on screen,
/// without reading the tree again for each request.
pub fn build_from(paths: &[PathBuf], reads: &[&References], cwd: &Path) -> BTreeMap<PathBuf, Node> {
    let mut definers: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, read) in reads.iter().enumerate() {
        for name in &read.defines {
            definers.entry(name.clone()).or_default().push(i);
        }
    }
    let loads: Vec<_> = reads.iter().map(|r| r.loads.as_slice()).collect();
    let tree = Tree::new(paths, cwd);
    let contexts = contexts(&loads, &tree);
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
    for (i, path) in paths.iter().enumerate() {
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
                node.dependencies.insert(paths[d].clone());
            }
            if defs.iter().any(|&d| identity[d] != identity[defs[0]]) {
                node.ambiguous.insert(
                    name.to_string(),
                    defs.iter().map(|&d| paths[d].clone()).collect(),
                );
            }
        }
        for (load, _) in &reads[i].loads {
            for d in targets(i, load) {
                if identity[d] != identity[i] {
                    node.dependencies.insert(paths[d].clone());
                }
            }
        }
        graph.insert(path.clone(), node);
    }
    graph
}

/// The files of a graph, found by any name a load reaches them by.
struct Tree<'a> {
    files: &'a [PathBuf],
    cwd: &'a Path,
    position: HashMap<PathBuf, usize>,
    /// The scripts directly in each directory.
    scripts_in: HashMap<&'a Path, Vec<usize>>,
    /// Each file as the first of `files` that is the same file.
    identity: Vec<usize>,
}

impl<'a> Tree<'a> {
    fn new(files: &'a [PathBuf], cwd: &'a Path) -> Self {
        // A file is keyed by the path it was found at, a symlink by its own
        // name: `\l lib/link.q` is an edge to `lib/link.q`, which q 5 loads
        // (#526). A load reaching it through another name - a symlinked
        // directory, the link's target - finds it by the real path.
        let mut position: HashMap<PathBuf, usize> = files
            .iter()
            .enumerate()
            .map(|(i, p)| (p.clone(), i))
            .collect();
        for (i, p) in files.iter().enumerate() {
            if let Ok(real) = std::fs::canonicalize(p) {
                position.entry(real).or_insert(i);
            }
        }
        // One file under two names is one file: neither name depends on the
        // other, nor makes a name the file defines ambiguous (#527).
        let identity = files
            .iter()
            .map(|p| {
                std::fs::canonicalize(p)
                    .ok()
                    .and_then(|real| position.get(&real).copied())
                    .unwrap_or(position[p])
            })
            .collect();
        // A directory loaded, `\l db`, runs the scripts directly in it (q 5's
        // `.Q.lo`), so it leads to each of them (#533).
        let mut scripts_in: HashMap<&Path, Vec<usize>> = HashMap::new();
        for (i, p) in files.iter().enumerate() {
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
        let candidates = load_targets(&self.files[i], load, self.cwd);
        candidates
            .iter()
            .find_map(|p| {
                self.position
                    .get(p)
                    .or_else(|| self.position.get(&std::fs::canonicalize(p).ok()?))
                    .map(|&d| vec![d])
            })
            // A directory only where q looks, the current one: `\l .`, a
            // database reloading itself, is no load of the scripts beside
            // the file that says it.
            .or_else(|| self.scripts_in.get(candidates.first()?.as_path()).cloned())
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
fn contexts<'r>(loads: &[&'r [(String, String)]], tree: &Tree) -> Vec<BTreeSet<&'r str>> {
    let mut contexts: Vec<BTreeSet<&str>> = vec![BTreeSet::new(); loads.len()];
    let mut pending: Vec<(usize, &str)> = vec![];
    for (i, file) in loads.iter().enumerate() {
        for (load, namespace) in file.iter() {
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
        for (load, inner) in loads[d].iter() {
            if inner.is_empty() {
                for next in tree.targets(d, load) {
                    pending.push((next, namespace));
                }
            }
        }
    }
    contexts
}

/// Whether each file runs at the root: one no other file loads, which is
/// where q starts it, one loaded under `\d .`, and one loaded at the root
/// of a file that runs there. One loaded only under `\d .a` does not: q 5,
/// after `\d .a` / `\l b.q` with b.q's `ff:42`, has `.a.ff` and no `ff`,
/// and a root `h:{ff}` throws 'ff (#525). Files that only load each other
/// in a ring, and are put in no context, keep their root.
fn rooted(loads: &[&[(String, String)]], tree: &Tree, contexts: &[BTreeSet<&str>]) -> Vec<bool> {
    let id = &tree.identity;
    let mut loaded = vec![false; loads.len()];
    let mut pending = vec![];
    for (i, file) in loads.iter().enumerate() {
        for (load, namespace) in file.iter() {
            for d in tree.targets(i, load) {
                if id[d] != id[i] {
                    loaded[id[d]] = true;
                    if namespace == "." {
                        pending.push(id[d]);
                    }
                }
            }
        }
    }
    pending.extend((0..loads.len()).filter(|&i| id[i] == i && !loaded[i]));
    let mut root = vec![false; loads.len()];
    while let Some(d) = pending.pop() {
        if std::mem::replace(&mut root[d], true) {
            continue;
        }
        for (load, inner) in loads[d].iter() {
            if inner.is_empty() {
                pending.extend(tree.targets(d, load).into_iter().map(|t| id[t]));
            }
        }
    }
    (0..loads.len())
        .map(|i| root[id[i]] || contexts[i].is_empty() && contexts[id[i]].is_empty())
        .collect()
}

/// Where one file's root definitions land once the others have loaded it:
/// in each context a load under `\d .a` puts it in, and at the root only
/// when it runs there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
    pub contexts: BTreeSet<String>,
    pub root: bool,
}

impl Default for Placement {
    fn default() -> Self {
        Placement {
            contexts: BTreeSet::new(),
            root: true,
        }
    }
}

impl Placement {
    /// `file`, the index of a script whose root definitions are `implicit`
    /// (its `References::implicit_defines`), with them where q puts them.
    pub fn apply(&self, file: &mut FileIndex, implicit: &[String]) {
        for name in implicit {
            let lambda = file.lambdas.contains(name);
            for ns in &self.contexts {
                let qualified = format!("{ns}.{name}");
                if lambda {
                    file.lambdas.insert(qualified.clone());
                }
                file.defined.insert(qualified);
            }
            if !self.root {
                file.lambdas.remove(name);
                file.defined.remove(name);
            }
        }
    }
}

/// Where each file at `paths`, with `loads` its `References::loads`, puts
/// its root definitions. The workspace index's counterpart of the contexts
/// `build` gives the graph, which keeps every root name instead: an edge
/// too many is a file rebuilt for nothing, a name too many is a read of a
/// name q never creates passed as defined.
pub fn placements(paths: &[PathBuf], loads: &[&[(String, String)]], cwd: &Path) -> Vec<Placement> {
    let tree = Tree::new(paths, cwd);
    let contexts = contexts(loads, &tree);
    let root = rooted(loads, &tree, &contexts);
    contexts
        .into_iter()
        .zip(root)
        .map(|(contexts, root)| Placement {
            contexts: contexts.into_iter().map(String::from).collect(),
            root,
        })
        .collect()
}

/// Each file of `graph` that reaches one of `changed`, with those of
/// `changed` it reaches, by their place in `changed`: a changed file itself,
/// every file depending on it, and every file depending on one of those.
/// This is the question the graph is built for - a change here, so which
/// files may now behave differently - answered along the edges and no
/// further: a file that gets to a changed one only by a name or a path
/// computed at run time has no edge to follow, and says so in its
/// `Node::dynamic` instead. A changed file the graph does not hold is in no
/// answer.
///
/// By place and not by path, since a change to a file most of a tree reads
/// reaches most of the tree, and the answer is that many times `changed`.
pub fn reaching(
    graph: &BTreeMap<PathBuf, Node>,
    changed: &[PathBuf],
) -> BTreeMap<PathBuf, Vec<usize>> {
    let place: HashMap<&Path, usize> = graph
        .keys()
        .enumerate()
        .map(|(i, file)| (file.as_path(), i))
        .collect();
    let mut dependents: Vec<Vec<usize>> = vec![vec![]; graph.len()];
    for (i, node) in graph.values().enumerate() {
        for dependency in &node.dependencies {
            if let Some(&d) = place.get(dependency.as_path()) {
                dependents[d].push(i);
            }
        }
    }
    let mut reached: Vec<Vec<usize>> = vec![vec![]; graph.len()];
    for (c, origin) in changed.iter().enumerate() {
        let Some(&origin) = place.get(origin.as_path()) else {
            continue;
        };
        let mut seen = vec![false; graph.len()];
        seen[origin] = true;
        let mut pending = vec![origin];
        while let Some(file) = pending.pop() {
            reached[file].push(c);
            for &dependent in &dependents[file] {
                if !std::mem::replace(&mut seen[dependent], true) {
                    pending.push(dependent);
                }
            }
        }
    }
    graph
        .keys()
        .zip(reached)
        .filter(|(_, origins)| !origins.is_empty())
        .map(|(file, origins)| (file.clone(), origins))
        .collect()
}

/// Whether `path` is a test, going by the only thing reading has: where the
/// file is and what it is called, q having no test framework of its own to
/// recognise one by. A `.q` file named `test_*.q` or `*_test.q`, or one in
/// a directory named `test` or `tests`, in any case.
///
/// `path` is relative to the tree being read, so that a checkout which
/// itself sits under some `tests` directory is not all tests. It is wide on
/// purpose: a helper beside the tests is counted as one, because for "which
/// tests does this change reach" a file listed that need not have been costs
/// a glance, and a test left out is one nobody runs.
pub fn is_test(path: &Path) -> bool {
    let lower = |part: &std::ffi::OsStr| part.to_string_lossy().to_ascii_lowercase();
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("q"))
    {
        return false;
    }
    let stem = path.file_stem().map(lower).unwrap_or_default();
    stem.starts_with("test_")
        || stem.ends_with("_test")
        || path.parent().is_some_and(|dir| {
            dir.components()
                .any(|c| matches!(lower(c.as_os_str()).as_str(), "test" | "tests"))
        })
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
