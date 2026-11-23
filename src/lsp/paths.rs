//! The paths a load names, as files move and as one is typed: the `\l`
//! lines a rename leaves pointing nowhere, rewritten before it happens
//! (workspace/willRenameFiles), and the directories and scripts that can
//! follow `\l ` (completion).
//!
//! Both read names and nothing more: which files and directories exist,
//! never what is in them, and the loads as the source spells them. A load
//! is resolved as q resolves it, and as the dependency graph does (see
//! `graph::loaded`): against the directory q is started in - here the first
//! workspace folder - then the loading file's directory and each above it.
use super::navigate::{Cursor, Sources};
use super::{Lines, file_key};
use q_lint_rs::load_paths;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};

/// LSP's `CompletionItemKind`s for a path.
const FILE: u8 = 17;
const FOLDER: u8 = 19;
/// How many entries one path completion lists.
const MAX_ITEMS: usize = 500;

/// What the server adds to its capabilities: the renames it wants to hear of
/// before they happen - a q or k script, and any folder, which may hold one.
/// And, for path completion, a `/` to open the next directory on - a
/// completion provider of its own when name completion is off.
pub(super) fn announce(capabilities: &mut Value, rename_loads: bool, load_paths: bool) {
    if load_paths {
        let provider = &mut capabilities["completionProvider"];
        if provider.is_null() {
            *provider = json!({"triggerCharacters": []});
        }
        if let Some(triggers) = provider["triggerCharacters"].as_array_mut() {
            triggers.push(json!("/"));
        }
    }
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
        // The renames are of real paths: one written through a symlink
        // (`/tmp` for `/private/tmp`) is followed to its file, and the
        // part of it that still leads there is kept as written (#1219).
        let written = lexical(written);
        let target = moved(&written, renames)
            .or_else(|| moved(Path::new(&file_key(&written.to_string_lossy())), renames))?;
        let spelled = written
            .ancestors()
            .find_map(|dir| {
                let rest = target.strip_prefix(file_key(&dir.to_string_lossy())).ok()?;
                Some(dir.join(rest))
            })
            .unwrap_or(target);
        return Some(spelled.to_string_lossy().replace('\\', "/"));
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

/// The path being typed after `\l ` at the cursor: where the part after the
/// last `/` starts, and that last directory part, `lib/` of `\l lib/ut`.
/// Nothing anywhere but the path of a `\l` line, or once a blank follows it.
fn typing_load(text: &str, offset: usize) -> Option<(usize, &str)> {
    let line_start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
    let typed = text[line_start..offset].strip_prefix("\\l ")?;
    let typed = typed.trim_start_matches(' ');
    if typed.contains(char::is_whitespace) {
        return None;
    }
    let name_start = typed.rfind('/').map_or(0, |i| i + 1);
    Some((offset - typed.len() + name_start, &typed[..name_start]))
}

/// `textDocument/completion` on a `\l` line: the directories, and the `.q`
/// and `.k` scripts, under the part already typed - read from the loading
/// file's directory and from the workspace folder, which are where q looks
/// first. A hidden entry only once a `.` is typed. `None` off a `\l` line,
/// so the caller answers as it would have.
pub(super) fn completion(cursor: &Cursor, sources: &Sources) -> Option<Value> {
    let (start, dir_part) = typing_load(cursor.text, cursor.offset)?;
    let typed = &cursor.text[start..cursor.offset];
    let from = Path::new(&cursor.key);
    let mut bases: Vec<PathBuf> = vec![];
    if Path::new(dir_part).is_absolute() {
        bases.push(PathBuf::new());
    } else {
        bases.extend(from.parent().map(Path::to_path_buf));
        bases.extend(root(sources));
    }
    let lines = Lines::new(cursor.text);
    let span = json!({"start": lines.json(start), "end": lines.json(cursor.offset)});
    // By label, so a directory both bases hold is listed once.
    let mut items: HashMap<String, Value> = HashMap::new();
    for base in bases {
        let Ok(entries) = std::fs::read_dir(base.join(dir_part)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && !typed.starts_with('.') {
                continue;
            }
            if name.contains(char::is_whitespace) {
                continue;
            }
            let is_dir = entry.path().is_dir();
            let script = Path::new(&name)
                .extension()
                .is_some_and(|e| e == "q" || e == "k");
            if !is_dir && !script {
                continue;
            }
            let label = if is_dir { format!("{name}/") } else { name };
            let item = json!({
                "label": label,
                "kind": if is_dir { FOLDER } else { FILE },
                // Folders first, as a file picker lists them.
                "sortText": format!("{}{label}", if is_dir { 0 } else { 1 }),
                "filterText": label,
                "textEdit": {"range": span, "newText": label},
            });
            items.entry(label).or_insert(item);
        }
    }
    let mut items: Vec<Value> = items.into_values().collect();
    items.sort_by(|a, b| a["sortText"].as_str().cmp(&b["sortText"].as_str()));
    let incomplete = items.len() > MAX_ITEMS;
    items.truncate(MAX_ITEMS);
    Some(json!({"isIncomplete": incomplete, "items": items}))
}
