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

/// The directory a relative `\l` in `file` is tried against first: the
/// deepest of `roots` that holds the file, or the first of them for a file
/// none holds. Each is a directory q may be started in - the CLI's current
/// one, each workspace folder of an editor - and the source does not say
/// which, so a file is taken to run from its own: in a second folder, `\l
/// lib.q` is that folder's lib.q, not the first's (#2045).
pub fn start_dir<'r>(roots: &'r [PathBuf], file: &Path) -> &'r Path {
    roots
        .iter()
        .filter(|root| file.starts_with(root))
        .max_by_key(|root| root.components().count())
        .or(roots.first())
        .map_or(Path::new(""), PathBuf::as_path)
}

/// The graph of `files`, each an absolute path and its source. `symbols`
/// counts a qualified symbol literal as a read of the name it spells.
/// `roots` say the first directory a relative `\l` path is tried against
/// (`start_dir`), before the loading file's own directory and its
/// ancestors: q resolves it against the process's directory and nowhere
/// else, and the source does not say which directory that is.
pub fn build(
    files: &[(PathBuf, String)],
    symbols: bool,
    roots: &[PathBuf],
) -> BTreeMap<PathBuf, Node> {
    let paths: Vec<PathBuf> = files.iter().map(|(p, _)| p.clone()).collect();
    let reads: Vec<References> = files
        .iter()
        .map(|(_, source)| references(source, symbols))
        .collect();
    build_from(&paths, &reads.iter().collect::<Vec<_>>(), roots)
}

/// `build`, for a caller that already holds what each file reads: `reads[i]`
/// is `references` of the file at `paths[i]`. The language server keeps that
/// for every file it indexes - an open buffer's as the editor has it - so
/// the graph it draws is the one this module defines, of the text on screen,
/// without reading the tree again for each request.
pub fn build_from(
    paths: &[PathBuf],
    reads: &[&References],
    roots: &[PathBuf],
) -> BTreeMap<PathBuf, Node> {
    let mut definers: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, read) in reads.iter().enumerate() {
        for name in &read.defines {
            definers.entry(name.clone()).or_default().push(i);
        }
    }
    let loads: Vec<_> = reads.iter().map(|r| r.loads.as_slice()).collect();
    let tree = Tree::new(paths, roots);
    let modules = modules(reads, &tree);
    let contexts = contexts(&loads, &tree, &modules);
    // A module's root names are its own context's, not the root's: no other
    // file reads them there unless it loads the module at its root with `\l`.
    // Nor are a script's that every loader loads under a context: after
    // `\d .a` / `\l lib/b.q`, b.q's `ff:42` is `.a.ff` and q 5 has no `ff`
    // for a root `h:{ff}`, which the lint reports as undefined (#2876).
    let root = rooted(&loads, &tree, &contexts, &modules);
    for (d, read) in reads.iter().enumerate() {
        if !root[d] {
            // But for one the script assigns again after a `\d .`: KDB-X
            // runs b.q's `xx:1` / `\d .` / `xx:2` under `\d .a` to `.a.xx` 1
            // and a root `xx` 2 (#2824).
            let moved = |name: &&String| !read.root_defines.contains(name);
            for name in read.implicit_defines.iter().filter(moved) {
                if let Some(defs) = definers.get_mut(name) {
                    defs.retain(|&x| x != d);
                }
            }
        }
    }
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
    // A namespace nobody assigns whole is made by the files assigning its
    // members, and a read of it reads them all: KDB-X runs `.cfg.port:5010`
    // in one file and `\d .cfg` / `retries:3` in another, and `.cfg` is
    // ``` ``port`retries!(::;5010;3) ``` (#2827).
    let mut members: HashMap<&str, Vec<usize>> = HashMap::new();
    for (name, defs) in &definers {
        for (dot, _) in name.match_indices('.').filter(|&(dot, _)| dot > 0) {
            members.entry(&name[..dot]).or_default().extend(defs);
        }
    }
    for defs in members.values_mut() {
        defs.sort_unstable();
        defs.dedup();
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
        // A module's own bare reads are its context's, and q does not fall
        // back to the root for them.
        if modules.is_module[i] && !root[i] {
            let relative = &reads[i].relative;
            names.retain(|name| {
                !relative.iter().any(|r| r.implicit && r.resolved == *name)
                    || relative.iter().any(|r| !r.implicit && r.resolved == *name)
            });
        }
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
            let Some((name, defs)) = resolve(name, &definers)
                .or_else(|| {
                    in_q.get(name)
                        .and_then(|q| definers.get_key_value(q))
                        .map(|(k, d)| (k.as_str(), d.as_slice()))
                })
                .or_else(|| {
                    members
                        .get_key_value(name.as_str())
                        .map(|(k, d)| (*k, d.as_slice()))
                })
            else {
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
        // A script only measured or read, `` hcount `:b.q ``, is reached
        // too, though nothing puts it in a context (#2805).
        let loads = reads[i].loads.iter().map(|(load, _)| load);
        for load in loads.chain(&reads[i].mentions) {
            for d in targets(i, load) {
                if identity[d] != identity[i] {
                    node.dependencies.insert(paths[d].clone());
                }
            }
        }
        // `` use`mymod `` runs mymod/init.q as `\l` would run a script.
        for &(d, _) in &modules.uses[i] {
            if identity[d] != identity[i] {
                node.dependencies.insert(paths[d].clone());
            }
        }
        graph.insert(path.clone(), node);
    }
    graph
}

/// What tells one file on disk from another, whatever name it is reached
/// by: its device and inode, which a symlink resolves to and a hard link
/// shares, where a hard link's canonical path is its own (#2859). Without
/// those - on Windows, or for a path that names no file - the canonical
/// path, or else the path as given.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum OnDisk {
    Inode(u64, u64),
    Path(PathBuf),
}

/// The file `path` is on disk.
pub fn on_disk(path: &Path) -> OnDisk {
    #[cfg(unix)]
    if let Ok(found) = std::fs::metadata(path) {
        use std::os::unix::fs::MetadataExt;
        return OnDisk::Inode(found.dev(), found.ino());
    }
    OnDisk::Path(std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
}

/// The files of a graph, found by any name a load reaches them by.
struct Tree<'a> {
    files: &'a [PathBuf],
    roots: &'a [PathBuf],
    position: HashMap<PathBuf, usize>,
    /// The scripts directly in each directory.
    scripts_in: HashMap<&'a Path, Vec<usize>>,
    /// Each file as the first of `files` that is the same file.
    identity: Vec<usize>,
}

impl<'a> Tree<'a> {
    fn new(files: &'a [PathBuf], roots: &'a [PathBuf]) -> Self {
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
        // other, nor makes a name the file defines ambiguous (#527). A hard
        // link is such a name, with a real path of its own (#2859).
        let mut first: HashMap<OnDisk, usize> = HashMap::new();
        let identity = files
            .iter()
            .enumerate()
            .map(|(i, p)| *first.entry(on_disk(p)).or_insert(i))
            .collect();
        // A directory loaded, `\l db`, runs the scripts directly in it (q 5's
        // `.Q.lo`), so it leads to each of them (#533).
        let mut scripts_in: HashMap<&Path, Vec<usize>> = HashMap::new();
        for (i, p) in files.iter().enumerate() {
            if let Some(dir) = p.parent().filter(|_| !partition_named(p)) {
                scripts_in.entry(dir).or_default().push(i);
            }
        }
        Tree {
            files,
            roots,
            position,
            scripts_in,
            identity,
        }
    }

    /// The files `\l load` in file `i` leads to.
    fn targets(&self, i: usize, load: &str) -> Vec<usize> {
        loaded(
            &self.files[i],
            load,
            start_dir(self.roots, &self.files[i]),
            |p| self.position.get(p).copied(),
            |dir| self.scripts_in.get(dir).cloned().unwrap_or_default(),
        )
    }
}

/// Whether a directory's load takes the file at `path` for a partition and
/// not a script, by its name: `.Q.lo` runs no entry that starts with a digit,
/// nor `par.txt`. KDB-X's `\l db` with a db/1b.q stops with 'part and never
/// runs it (#2815).
pub fn partition_named(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        name == "par.txt"
            || name
                .as_encoded_bytes()
                .first()
                .is_some_and(u8::is_ascii_digit)
    })
}

/// The files `\l load` in the file at `from` leads to, as the graph follows
/// it: the first place q tries that `file` finds, under the path tried or
/// the real path it names, or else the scripts `scripts_in` finds directly
/// in the directory at the first place - a directory only where q looks, the
/// current one, and never `\l .`, a database reloading itself, which runs
/// no script. Nothing for a load that reaches no file. The language server
/// follows a load line with this too, over the files it indexes.
pub fn loaded<T>(
    from: &Path,
    load: &str,
    cwd: &Path,
    file: impl Fn(&Path) -> Option<T>,
    scripts_in: impl FnOnce(&Path) -> Vec<T>,
) -> Vec<T> {
    // `.Q.lo` runs a directory's scripts unless the load is of `.` itself:
    // KDB-X, started beside b.q, runs it for `\l ./` and `\l ../here` and
    // not for `\l .` (#2814).
    if load == "." {
        return vec![];
    }
    let candidates = load_targets(from, load, cwd);
    candidates
        .iter()
        .find_map(|p| file(p).or_else(|| file(&std::fs::canonicalize(p).ok()?)))
        .map(|d| vec![d])
        .or_else(|| Some(scripts_in(candidates.first()?.as_path())))
        .unwrap_or_default()
}

/// The contexts each file is loaded in by another, `.a` for a `\l` under
/// `\d .a`. A script loaded under `\d .a` runs in `.a`, so what it writes at
/// its root is `.a.name` too: q 5, after `\d .a` and `\l b.q` with b.q's
/// `ff:{1}`, has `.a.ff` and no `ff`. Its own `\d` does not leak back out.
/// A load at a loaded script's root runs in the context that script runs
/// in: `\l c.q` at b.q's root, with b.q loaded under `\d .a`, puts c.q's
/// `gg` at `.a.gg` (q 5). Only before the script's own first `\d`: after
/// its `\d .`, `yy:2` is the root's `yy` and no `.a.yy` (q 5, #532).
///
/// A KDB-X module runs in its own context, `.m.<module>` (`modules`), and
/// what it loads at its root runs there too.
fn contexts(
    loads: &[&[(String, String)]],
    tree: &Tree,
    modules: &Modules,
) -> Vec<BTreeSet<String>> {
    let mut contexts: Vec<BTreeSet<String>> = vec![BTreeSet::new(); loads.len()];
    let mut pending: Vec<(usize, String)> = vec![];
    for (i, file) in loads.iter().enumerate() {
        for (load, namespace) in file.iter() {
            if !namespace.is_empty() && namespace != "." {
                for d in tree.targets(i, load) {
                    pending.push((d, namespace.clone()));
                }
            }
        }
    }
    for (d, namespaces) in modules.namespaces.iter().enumerate() {
        pending.extend(namespaces.iter().map(|ns| (d, ns.clone())));
    }
    while let Some((d, namespace)) = pending.pop() {
        if contexts[d].contains(&namespace) {
            continue;
        }
        for (load, inner) in loads[d].iter() {
            if inner.is_empty() {
                for next in tree.targets(d, load) {
                    pending.push((next, namespace.clone()));
                }
            }
        }
        contexts[d].insert(namespace);
    }
    contexts
}

/// The KDB-X modules of a tree, read as KDB-X 5's `.Q.m` loads them.
struct Modules {
    /// Whether each file is a module: one that assigns `export`
    /// (`References::module`) and that some `use` reaches.
    is_module: Vec<bool>,
    /// The files each file's `` use`name `` reaches, each with the module
    /// name it was reached by.
    uses: Vec<Vec<(usize, String)>>,
    /// The contexts each module runs in: `.m.mymod` for `` use`mymod ``.
    namespaces: Vec<BTreeSet<String>>,
}

/// Each module's context, and the files each `use` reaches. KDB-X 5 finds
/// `` use`a.b `` at `<dir>/a/b.q` or `<dir>/a/b/init.q` (`.k` and the
/// compiled forms too) for each `<dir>` of its search path, `QPATH` then
/// `~/.kx/mod`; the source does not say what that is, so the directories
/// tried are those `\l` tries (`load_targets`). It runs the module in
/// `.m.a.0b` - each name after the first gets a `0`, so `` use`pkg.sub ``
/// leaves `key `.m.pkg` as ``` ``0sub ```. `` use`.b ``, in a module, is
/// relative to it: beside an `init.q`, under a flat `a.q` (KDB-X tries
/// `a.q/b.q`), one directory up for each dot more, and runs in the using
/// module's context with `.0b` added. A file no `use` reaches is a script,
/// whatever it assigns: KDB-X 5 running `q a.q` or `\l a.q` over an
/// `export:{...}` beside `util:{x+1}` leaves `util` at the root and
/// `key `.m` empty (#2668).
fn modules(reads: &[&References], tree: &Tree) -> Modules {
    let is_module: Vec<bool> = reads.iter().map(|r| r.module).collect();
    let mut uses: Vec<Vec<(usize, String)>> = vec![vec![]; reads.len()];
    for (i, read) in reads.iter().enumerate() {
        for name in &read.uses {
            let dots = name.len() - name.trim_start_matches('.').len();
            let parts: Vec<&str> = name[dots..].split('.').collect();
            let bases: Vec<PathBuf> = if dots == 0 {
                load_targets(&tree.files[i], "", start_dir(tree.roots, &tree.files[i]))
            } else if is_module[i] {
                let file = &tree.files[i];
                let mut base = if file.file_stem().is_some_and(|s| s == "init") {
                    file.parent().map(Path::to_path_buf).unwrap_or_default()
                } else {
                    file.clone()
                };
                for _ in 1..dots {
                    base.pop();
                }
                vec![base]
            } else {
                vec![]
            };
            let found = bases.iter().find_map(|base| {
                let stem = parts.iter().fold(base.clone(), |p, part| p.join(part));
                ["q", "k"]
                    .iter()
                    .map(|ext| stem.with_extension(ext))
                    .chain(["init.q", "init.k"].iter().map(|f| stem.join(f)))
                    .find_map(|p| tree.position.get(&lexical(&p)).copied())
            });
            if let Some(d) = found.filter(|&d| is_module[d]) {
                uses[i].push((d, name.clone()));
            }
        }
    }
    let mut namespaces: Vec<BTreeSet<String>> = vec![BTreeSet::new(); reads.len()];
    let mut pending: Vec<(usize, String)> = vec![];
    for used in &uses {
        for (d, name) in used {
            if !name.starts_with('.') {
                let mut parts = name.split('.');
                let first = parts.next().unwrap_or_default();
                let rest: String = parts.map(|p| format!(".0{p}")).collect();
                pending.push((*d, format!(".m.{first}{rest}")));
            }
        }
    }
    while let Some((d, namespace)) = pending.pop() {
        if !namespaces[d].insert(namespace.clone()) {
            continue;
        }
        for (target, name) in &uses[d] {
            let dots = name.len() - name.trim_start_matches('.').len();
            if dots == 0 {
                continue;
            }
            let mut base: Vec<&str> = namespace.split('.').collect();
            for _ in 1..dots {
                if base.len() > 2 {
                    base.pop();
                }
            }
            let rest: String = name[dots..].split('.').map(|p| format!(".0{p}")).collect();
            pending.push((*target, format!("{}{rest}", base.join("."))));
        }
    }
    let is_module = namespaces.iter().map(|ns| !ns.is_empty()).collect();
    Modules {
        is_module,
        uses,
        namespaces,
    }
}

/// Whether each file runs at the root: one no other file loads, which is
/// where q starts it, one loaded under `\d .`, and one loaded at the root
/// of a file that runs there. One loaded only under `\d .a` does not: q 5,
/// after `\d .a` / `\l b.q` with b.q's `ff:42`, has `.a.ff` and no `ff`,
/// and a root `h:{ff}` throws 'ff (#525). Files that only load each other
/// in a ring, and are put in no context, keep their root.
///
/// A KDB-X module runs at the root only when some file `\l`s it there:
/// `use` runs it in a context of its own, and so does no load at all.
fn rooted(
    loads: &[&[(String, String)]],
    tree: &Tree,
    contexts: &[BTreeSet<String>],
    modules: &Modules,
) -> Vec<bool> {
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
    pending.extend((0..loads.len()).filter(|&i| id[i] == i && !loaded[i] && !modules.is_module[i]));
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
    /// `file`, the index of the script `read` is the `References` of, with
    /// its root definitions (`References::implicit_defines`) where q puts
    /// them. One assigned again after a `\d .` stays at the root too: that
    /// write is the root's wherever the script is loaded (#2824).
    pub fn apply(&self, file: &mut FileIndex, read: &References) {
        for name in &read.implicit_defines {
            let lambda = file.lambdas.contains(name);
            for ns in &self.contexts {
                let qualified = format!("{ns}.{name}");
                if lambda {
                    file.lambdas.insert(qualified.clone());
                }
                file.defined.insert(qualified);
            }
            if !self.root && !read.root_defines.contains(name) {
                file.lambdas.remove(name);
                file.defined.remove(name);
            }
        }
    }
}

/// Where each file at `paths`, with `reads` its `References`, puts
/// its root definitions. The workspace index's counterpart of the contexts
/// `build` gives the graph: a name too many is a read of a name q never
/// creates passed as defined.
pub fn placements(paths: &[PathBuf], reads: &[&References], roots: &[PathBuf]) -> Vec<Placement> {
    let loads: Vec<_> = reads.iter().map(|r| r.loads.as_slice()).collect();
    let tree = Tree::new(paths, roots);
    let modules = modules(reads, &tree);
    let contexts = contexts(&loads, &tree, &modules);
    let root = rooted(&loads, &tree, &contexts, &modules);
    contexts
        .into_iter()
        .zip(root)
        .map(|(contexts, root)| Placement { contexts, root })
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
