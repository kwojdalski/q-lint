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
use q_lint_rs::{load_paths, use_paths};
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

/// The workspace folder q is taken to be started in for the file `key`, as
/// a key: the folder that holds it, or the first (`graph::start_dir`).
fn root(sources: &Sources, key: &str) -> Option<PathBuf> {
    let roots: Vec<PathBuf> = sources
        .idx
        .roots
        .iter()
        .map(|r| PathBuf::from(file_key(r)))
        .collect();
    let root = q_lint_rs::graph::start_dir(&roots, Path::new(key));
    (!root.as_os_str().is_empty()).then(|| root.to_path_buf())
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

/// Where the path `written` goes under `renames`, found as written or by
/// its real path - a symlink followed (`/tmp` for `/private/tmp`, #1219),
/// another case on a disk that ignores it (#2050) - and spelled as written
/// as far as it still leads there.
fn moved_as_written(written: &Path, renames: &[(PathBuf, PathBuf)]) -> Option<PathBuf> {
    let target = moved(written, renames).or_else(|| {
        let real = PathBuf::from(file_key(&written.to_string_lossy()));
        let target = moved(&real, renames)?;
        // What follows the renamed part, in the case it was written in,
        // when the real path names the same parts.
        let parts = written.components().count();
        if parts != real.components().count() {
            return Some(target);
        }
        let (old, new) = renames.iter().find(|(old, _)| real.starts_with(old))?;
        let rest: PathBuf = written
            .components()
            .skip(old.components().count())
            .collect();
        Some(if rest.as_os_str().is_empty() {
            new.clone()
        } else {
            new.join(rest)
        })
    })?;
    Some(
        written
            .ancestors()
            .find_map(|dir| {
                let rest = target.strip_prefix(file_key(&dir.to_string_lossy())).ok()?;
                Some(dir.join(rest))
            })
            .unwrap_or(target),
    )
}

/// `workspace/willRenameFiles`: the edits that keep each load naming what
/// it named - a renamed file, or anything under a renamed folder - and the
/// loads of a renamed file that its new place would break. A load keeps
/// the base it was resolved against: one written from the workspace folder
/// stays so, one written from the loading file's directory (or one above
/// it) is written from that directory's new place. A load that reaches
/// nothing on disk, or still reaches the same path, is left alone.
///
/// So is one the new path cannot be written in (`reads_back`): the second
/// value says which, for the user, who is otherwise left with a line q
/// cannot run and nothing to say so (#2026).
pub(super) fn will_rename(params: &Value, sources: &Sources) -> (Value, Option<String>) {
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
        return (Value::Null, None);
    }
    let mut changes: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut left: Vec<String> = vec![];
    let mut unnamed: Vec<String> = vec![];
    for key in sources.keys() {
        let file = &sources.idx.files[key];
        if file.loads.is_empty() && file.read.uses.is_empty() {
            continue;
        }
        let Some((uri, text)) = sources.text(key) else {
            continue;
        };
        let from = Path::new(key);
        let root = root(sources, key);
        let dir = from.parent().unwrap_or(Path::new(""));
        let new_from = moved(from, &renames);
        let new_dir = new_from.as_deref().and_then(Path::parent).unwrap_or(dir);
        let lines = Lines::new(&text);
        for (at, len) in load_paths(&text) {
            let load = &text[at..at + len];
            let Some(edit) = rewritten(load, root.as_deref(), dir, new_dir, &renames) else {
                continue;
            };
            if !reads_back(&text, at, len, &edit) {
                let file = root.as_deref().and_then(|r| from.strip_prefix(r).ok());
                let file = file.unwrap_or(from).to_string_lossy().replace('\\', "/");
                let line = text[..at].matches('\n').count() + 1;
                left.push(format!("{file}:{line} (`{edit}`)"));
                continue;
            }
            changes.entry(uri.clone()).or_default().push(json!({
                "range": super::navigate::range(&lines, at, len),
                "newText": edit,
            }));
        }
        // `` use`mymod `` names mymod.q or mymod/init.q by its path too,
        // from the same directories a load is tried against (#2669).
        for (at, len) in use_paths(&text) {
            let name = &text[at..at + len];
            let edit = match renamed_module(name, root.as_deref(), dir, new_dir, &renames) {
                Some(Ok(edit)) => edit,
                Some(Err(path)) => {
                    let file = root.as_deref().and_then(|r| from.strip_prefix(r).ok());
                    let file = file.unwrap_or(from).to_string_lossy().replace('\\', "/");
                    let line = text[..at].matches('\n').count() + 1;
                    unnamed.push(format!("{file}:{line} (`{path}`)"));
                    continue;
                }
                None => continue,
            };
            changes.entry(uri.clone()).or_default().push(json!({
                "range": super::navigate::range(&lines, at, len),
                "newText": edit,
            }));
        }
    }
    let listed = |mut places: Vec<String>| {
        places.sort();
        let more = places.len().saturating_sub(MAX_TOLD);
        places.truncate(MAX_TOLD);
        let mut places = places.join(", ");
        if more > 0 {
            places.push_str(&format!(" and {more} more"));
        }
        places
    };
    let told_uses = (!unnamed.is_empty()).then(|| {
        let count = match unnamed.len() {
            1 => "1 `use` is".to_string(),
            n => format!("{n} `use`s are"),
        };
        format!(
            "q-lint: {count} left naming the old module, whose new path no module name \
             spells: {}. A module name is letters, digits and `_`, with a `.` for each \
             directory, and names `name.q` or `name/init.q`.",
            listed(unnamed)
        )
    });
    let told = (!left.is_empty()).then(|| {
        left.sort();
        let count = match left.len() {
            1 => "1 load is".to_string(),
            n => format!("{n} loads are"),
        };
        let more = left.len().saturating_sub(MAX_TOLD);
        left.truncate(MAX_TOLD);
        let mut places = left.join(", ");
        if more > 0 {
            places.push_str(&format!(" and {more} more"));
        }
        format!(
            "q-lint: {count} left naming the old path, which q could not read rewritten: \
             {places}. No load holds a blank, and a file symbol holds only letters, digits, \
             `_`, `.` and `/`."
        )
    });
    let told = match (told, told_uses) {
        (Some(loads), Some(uses)) => Some(format!("{loads} {uses}")),
        (loads, uses) => loads.or(uses),
    };
    if changes.is_empty() {
        return (Value::Null, told);
    }
    (json!({"changes": changes}), told)
}

/// The new spelling of the module `name` of a `` use`name ``, written in a
/// file whose directory is `dir` and will be `new_dir`, when the renames
/// move the file it reaches: `mod2` for `mymod` once mymod/ is mod2/, as
/// KDB-X 5 finds `a.b` at `a/b.q` or `a/b/init.q`. `Err` with the new path
/// when no module name spells it. A name relative to its module
/// (`` use`.b ``) moves with it and is left as written.
fn renamed_module(
    name: &str,
    root: Option<&Path>,
    dir: &Path,
    new_dir: &Path,
    renames: &[(PathBuf, PathBuf)],
) -> Option<Result<String, String>> {
    if name.starts_with('.') {
        return None;
    }
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
        let stem = name.split('.').fold(base.clone(), |p, part| p.join(part));
        ["q", "k"]
            .iter()
            .map(|ext| stem.with_extension(ext))
            .chain(["init.q", "init.k"].iter().map(|f| stem.join(f)))
            .find(|p| p.exists())
            .map(|target| ((base, new_base), target))
    })?;
    let new_target = moved_as_written(&target, renames).unwrap_or_else(|| target.clone());
    let (old_base, new_base) = base;
    if new_target == target && new_base == old_base {
        return None;
    }
    let spelled = relative(&new_target, new_base);
    let module = spelled
        .strip_suffix("/init.q")
        .or_else(|| spelled.strip_suffix("/init.k"))
        .or_else(|| spelled.strip_suffix(".q"))
        .or_else(|| spelled.strip_suffix(".k"));
    let part = |p: &str| {
        p.starts_with(|c: char| c.is_ascii_alphabetic())
            && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    match module {
        Some(module) if module.split('/').all(part) => {
            let module = module.replace('/', ".");
            (module != name).then_some(Ok(module))
        }
        _ => Some(Err(spelled)),
    }
}

/// How many loads left as written one message lists.
const MAX_TOLD: usize = 8;

/// Whether the load at `at`, written as `new`, is still a load of `new`: a
/// path is read up to a blank after `\l` and in `system "l ..."`, and a
/// file symbol ends at the first character a symbol cannot hold. KDB-X has
/// no spelling for the rest - `\l my util.q` is 'nyi quoted, escaped or
/// bare - so an edit that fails this would write a line that loads nothing
/// and that no later rename finds again.
fn reads_back(text: &str, at: usize, len: usize, new: &str) -> bool {
    let edited = format!("{}{new}{}", &text[..at], &text[at + len..]);
    load_paths(&edited).contains(&(at, new.len()))
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
        let target = moved_as_written(&written, renames)?;
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
    // On a disk that ignores case, `\l Lib/U.q` loads lib/u.q, and only
    // its real path is among the renames (#2050).
    let new_target = moved_as_written(&target, renames).unwrap_or_else(|| target.clone());
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
        bases.extend(root(sources, &cursor.key));
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
