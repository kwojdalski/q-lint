//! The paths a load names, as files move: the `\l` lines a rename leaves
//! pointing nowhere, rewritten before it happens (workspace/willRenameFiles).
//!
//! It reads names and nothing more: which files and directories exist,
//! never what is in them, and the loads as the source spells them. A load
//! is resolved as q resolves it, and as the dependency graph does (see
//! `graph::loaded`): against the directory q is started in - here the first
//! workspace folder - then the loading file's directory and each above it.
use super::navigate::Sources;
use super::{Lines, file_key};
use q_lint_rs::load_paths;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// What the server adds to its capabilities: the renames it wants to hear of
/// before they happen - a q or k script, and any folder, which may hold one.
pub(super) fn announce(capabilities: &mut Value, rename_loads: bool) {
    if rename_loads {
        capabilities["workspace"]["fileOperations"] = json!({"willRename": {"filters": [
            {"scheme": "file", "pattern": {"glob": "**/*.{q,k}", "matches": "file"}},
            {"scheme": "file", "pattern": {"glob": "**", "matches": "folder"}},
        ]}});
    }
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

/// `to` as a path written from the directory `from`, with `..` where it has
/// to climb; both absolute.
fn relative(to: &Path, from: &Path) -> String {
    let to: Vec<Component> = to.components().collect();
    let from: Vec<Component> = from.components().collect();
    let common = to.iter().zip(&from).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); from.len() - common];
    parts.extend(
        to[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

/// The workspace folder q is taken to be started in, as a key.
fn root(sources: &Sources) -> Option<PathBuf> {
    sources
        .idx
        .roots
        .first()
        .map(|r| PathBuf::from(file_key(r)))
}

/// Where a renamed path goes: each `(old, new)` names a file or a folder,
/// and a path under a folder moves with it.
fn moved(path: &Path, renames: &[(PathBuf, PathBuf)]) -> Option<PathBuf> {
    renames.iter().find_map(|(old, new)| {
        let rest = path.strip_prefix(old).ok()?;
        Some(if rest.as_os_str().is_empty() {
            new.clone()
        } else {
            new.join(rest)
        })
    })
}

/// `workspace/willRenameFiles`: the edits that keep each load naming what
/// it named - a renamed file, or anything under a renamed folder - and the
/// loads of a renamed file that its new place would break. A load keeps
/// the base it was resolved against: one written from the workspace folder
/// stays so, one written from the loading file's directory (or one above
/// it) is written from that directory's new place. A load that reaches
/// nothing on disk, or still reaches the same path, is left alone.
pub(super) fn will_rename(params: &Value, sources: &Sources) -> Value {
    let renames: Vec<(PathBuf, PathBuf)> = params["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let old = super::file_path(f["oldUri"].as_str()?)?;
            let new = super::file_path(f["newUri"].as_str()?)?;
            Some((PathBuf::from(file_key(&old)), PathBuf::from(file_key(&new))))
        })
        .collect();
    if renames.is_empty() {
        return Value::Null;
    }
    let root = root(sources);
    let mut changes: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for key in sources.keys() {
        if sources.idx.files[key].loads.is_empty() {
            continue;
        }
        let Some((uri, text)) = sources.text(key) else {
            continue;
        };
        let from = Path::new(key);
        let dir = from.parent().unwrap_or(Path::new(""));
        let new_from = moved(from, &renames);
        let new_dir = new_from.as_deref().and_then(Path::parent).unwrap_or(dir);
        let lines = Lines::new(&text);
        for (at, len) in load_paths(&text) {
            let load = &text[at..at + len];
            let Some(edit) = rewritten(load, root.as_deref(), dir, new_dir, &renames) else {
                continue;
            };
            changes.entry(uri.clone()).or_default().push(json!({
                "range": super::navigate::range(&lines, at, len),
                "newText": edit,
            }));
        }
    }
    if changes.is_empty() {
        return Value::Null;
    }
    json!({"changes": changes})
}

/// The new spelling of `load`, written in a file whose directory is `dir`
/// and will be `new_dir`, when the renames move what it reaches or move the
/// base it is written from.
fn rewritten(
    load: &str,
    root: Option<&Path>,
    dir: &Path,
    new_dir: &Path,
    renames: &[(PathBuf, PathBuf)],
) -> Option<String> {
    if load.is_empty() || load.contains(char::is_whitespace) {
        return None;
    }
    let written = Path::new(load);
    if written.is_absolute() {
        let target = moved(&lexical(written), renames)?;
        return Some(target.to_string_lossy().replace('\\', "/"));
    }
    // The bases in the order q tries them, each with where it will be.
    let mut bases: Vec<(PathBuf, PathBuf)> = vec![];
    if let Some(root) = root {
        bases.push((root.to_path_buf(), root.to_path_buf()));
    }
    let mut new_ancestors = new_dir.ancestors();
    for base in dir.ancestors() {
        let new_base = new_ancestors.next().unwrap_or(base);
        bases.push((base.to_path_buf(), new_base.to_path_buf()));
    }
    let (base, target) = bases.iter().find_map(|(base, new_base)| {
        let target = lexical(&base.join(written));
        target.exists().then_some(((base, new_base), target))
    })?;
    let new_target = moved(&target, renames).unwrap_or_else(|| target.clone());
    let (old_base, new_base) = base;
    if new_target == target && new_base == old_base {
        return None;
    }
    let spelled = relative(&new_target, new_base);
    // A path that spelled itself with `./` keeps it.
    let spelled = match load.strip_prefix("./") {
        Some(_) if !spelled.starts_with("..") => format!("./{spelled}"),
        _ => spelled,
    };
    (spelled != load && !spelled.is_empty()).then_some(spelled)
}
