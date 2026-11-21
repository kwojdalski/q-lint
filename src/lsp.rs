//! The language server: `qlinter --lsp`, speaking LSP over stdin/stdout.
//!
//! WHY A SERVER AND NOT A VS CODE EXTENSION THAT SHELLS OUT
//!
//! Both work, and shelling out is less code. A server is worth the difference
//! because the protocol is the portable part: one binary serves VS Code,
//! Neovim, Helix, Zed and anything else that speaks LSP, and the editor plugin
//! shrinks to "launch this process". An extension that parses `--format json`
//! is a VS Code-only asset that every other editor would have to rewrite.
//!
//! It also fixes the thing a CLI cannot do well: linting edits that have not
//! been saved. `didChange` carries the text, so what is checked is what is on
//! screen rather than what is on disk. (A buffer that is not a `.q` file at
//! all - an untitled scratch - is not linted; see `diagnose`.)
//!
//! SYNCHRONOUS, SINGLE-THREADED, AND NO ASYNC RUNTIME
//!
//! tower-lsp is the usual answer and brings tokio with it. This server only
//! lints and offers code actions; `lint` is measured in single-digit
//! milliseconds on a whole file, so there is no operation long
//! enough to be worth yielding for. A request loop that reads, dispatches and
//! replies in order is the whole design, and it keeps this crate's dependency
//! tree exactly as it was.
//!
//! One thread more than that: a reader, which only takes messages off stdin
//! as they come (`read_ahead`). A large file is still tens of milliseconds a
//! lint, and a person types faster than that, so while one change is linted
//! the next ones wait - and with the reader, the loop can see them waiting.
//! A change with a later change to the same document behind it is taken but
//! not linted, so a burst of keystrokes is linted once, at its last; and a
//! request with a `$/cancelRequest` for it behind it is answered
//! RequestCancelled without being run (`superseded`, `cancelled`). What is
//! running is never interrupted: no answer here takes long enough for that
//! to be worth a second thread touching the documents.
//!
//! WHAT IT IMPLEMENTS, AND WHAT IT DELIBERATELY DOES NOT
//!
//! initialize/initialized, didOpen/didChange/didSave/didClose, shutdown/exit,
//! diagnostics pushed with textDocument/publishDiagnostics, quick fixes
//! requested with textDocument/codeAction, document formatting with
//! textDocument/formatting, and semantic tokens - the colour of a function at
//! the places it is called, and of a parameter where its body reads it - with
//! textDocument/semanticTokens/full. And navigation, in `navigate`: the
//! outline (textDocument/documentSymbol), workspace/symbol, go to definition,
//! find references, textDocument/documentHighlight, and a rename of a
//! lambda's own parameters and locals - never of a global. And help, in
//! `help`: textDocument/hover, textDocument/signatureHelp and - only when
//! the client's options ask for it - textDocument/completion, from the
//! source and the catalogue of q's own words.
//! And how files and functions relate, in `relate`: the call hierarchy
//! (textDocument/prepareCallHierarchy, callHierarchy/incomingCalls and
//! outgoingCalls), and two requests of this server's own, announced under
//! `experimental` - `q-lint/graph`, a document's dependencies and dependents
//! as `qlinter analyze graph` has them, and `q-lint/affectedTests`, the test
//! files reaching the files a client says changed. Which files changed is
//! git's to say and the client's to ask: this server starts no process.
//!
//! Around those: each diagnostic links its code to that rule's row in the
//! reference (`codeDescription`); beside its fix, or without one, a finding
//! has a quick fix that accepts it with `/ noqa: CODE` on its line, offered
//! only where the linter would read that comment (`suppression_for`);
//! textDocument/codeAction also answers `source.fixAll.q-lint` with the
//! formatting edit, for `editor.codeActionsOnSave` in an editor where this
//! server is not the formatter; and textDocument/foldingRange folds the
//! brackets and block comments that span lines.
//!
//! A workspace index: every `.q` file under the workspace folders is read at
//! startup - never run - for the global names it defines and reads, and
//! kept current from open buffers, closes, and
//! workspace/didChangeWatchedFiles. A name
//! another file defines is not undefined here, a name two files assign is not
//! tracked by value, and another file's function is coloured as one.
//! The server registers the watchers itself (`watchers`), for a client that
//! takes dynamic registration, so no editor has to know which files matter.
//!
//! FORMATTING IS THE SAFE AUTOFIXES, NOT A LAYOUT ENGINE
//!
//! "Format document" applies exactly what `qlinter --fix` applies by default:
//! the batch-safe fixes, through the same loop (`fix_all`) and the same
//! policy as the diagnostics, until none applies. Never the editor-only ones
//! `--unsafe-fixes` adds - those a person accepts one at a time as Quick
//! Fixes. There is no whitespace or layout formatter here, and none is
//! implied: q's layout carries meaning (an unindented line ends a statement,
//! a `/` alone opens a comment block), and re-laying it out would need the
//! parser this crate does not have. A buffer with nothing to fix, or one
//! whose structure is broken - an unclosed bracket or string reports only
//! that, so no other fix is offered - gets no edits, not an error. The reply
//! is one edit spanning what changed, so formatting twice changes nothing
//! the second time. Range formatting is not offered: one fix can leave
//! another to make outside the range, and a selection's half of a pass is
//! not something `--fix` ever produces.
//!
//! FOLDING IS THE BRACKETS THAT SPAN LINES, AND REPLACES THE EDITOR'S OWN
//!
//! A lambda, a parenthesised list, a bracketed block and a block comment
//! fold, each from the line it opens on to the line it closes on, found in
//! the masked text so that a bracket in a string or a comment folds nothing
//! (`folds`). That is all of it: a statement continued over indented lines
//! with no bracket open is not a range here. An editor told a server folds
//! stops folding by indentation, so this is a trade and not only a gain -
//! exact ranges where the brackets are, for none where they are not - and
//! one a person can decline (`editor.foldingStrategy: "indentation"`). A
//! buffer whose brackets do not close has no ranges of its own rather than
//! wrong ones: it keeps those of the last version that closed on the lines
//! that have not changed since, outside the statement that does not close
//! (`Carry`), as its diagnostics do.
//!
//! EDITOR SETTINGS ARRIVE AS initializationOptions, AND ONLY NARROW
//!
//! An editor's settings reach the server once, in `initialize` (see
//! `Options`); a client that wants new ones restarts the server, which is
//! what the VS Code extension does. Rule selection there can only turn rules
//! off: the repository's configuration is what CI reads, and an editor that
//! could widen it would show findings nobody else sees. The flags the server
//! was started with - `--profile`, `--select` and the rest - are the
//! command line's, and keep their meaning.
//!
//! Not here: what a name holds. This crate reads source text without
//! executing it, the property that makes it safe to run on every keystroke.
//! So a hover shows where a name is defined and what its definition says,
//! never its value, and completion offers no table's columns. That is why
//! completion is announced only when asked for: an editor that is told a
//! server completes stops offering its own word-based fallback, which does
//! know the column typed three lines up (see `help`).
//! Formatting does not share the problem: its answer comes from rules that
//! read text, and when there is nothing to fix, an empty answer is the true
//! one. Nor does navigation: where a name is written and where it is read is
//! in the text, under the same `\d` resolution the checks use, and what it
//! cannot see - a name reached through a string or from another process - is
//! why it renames nothing but a lambda's locals. The call hierarchy is the
//! same reading, grouped by the definition a name is written in, and its
//! limit is the same one: a call is a function's name in a body, so a name
//! handed on as a value is listed and a call through a string is not.
use crate::config::{FILES, Layer, Policy, selector};
use crate::jsonrpc::{INVALID_REQUEST, Malformed, receive, send};
use q_lint_rs::graph::Placement;
use q_lint_rs::{
    FileIndex, Finding, Fix, References, TokenKind, Workspace, balanced, broken_statement, fix_all,
    fix_for, folds, rule_url, semantic_tokens_in, suppressions_for, whole_edit,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, Write},
    path::Path,
    sync::mpsc::{Receiver, channel},
};

/// Full document sync (`TextDocumentSyncKind.Full`): every change carries the
/// whole buffer. Incremental sync would save bytes on a large file and cost a
/// patch-application routine whose bugs present as "the linter is looking at
/// text that is not on screen". At these file sizes the bytes are not worth it.
const SYNC_FULL: i64 = 1;

const METHOD_NOT_FOUND: i64 = -32601;
const INTERNAL_ERROR: i64 = -32603;
const INVALID_PARAMS: i64 = -32602;
const SERVER_NOT_INITIALIZED: i64 = -32002;
/// LSP 3.17's `RequestFailed`: a well-formed request the server will not
/// carry out, with the reason as its message - a rename it refuses.
const REQUEST_FAILED: i64 = -32803;
/// LSP 3.17's `RequestCancelled`: the reply to a request the client
/// cancelled before it was run.
const REQUEST_CANCELLED: i64 = -32800;

mod annotate;
mod help;
mod navigate;
mod relate;

/// Open documents, by URI. The editor is the authority on their contents from
/// didOpen until didClose, so nothing here reads from disk.
type Documents = HashMap<String, String>;

/// Open documents edited since they were last linted, which with
/// `lint.run: "onSave"` is since they were last saved.
type Unsaved = HashSet<String>;

/// What each open document reported the last time its brackets and strings
/// all closed, and the text it reported that on - carried over, where the
/// lines are unchanged, while a statement in it is being typed (`Carry`).
struct Good {
    text: String,
    diagnostics: Vec<Value>,
}

type Kept = HashMap<String, Good>;

/// What every `.q` file in the workspace defines, so a name another file
/// defines is not undefined in this one and another file's function is
/// coloured as one. Files are read, never run - the property this server
/// exists to keep.
///
/// The editor's buffer wins over the disk for an open file; a closed one is
/// read back from disk, and a file changed outside the editor arrives as a
/// `workspace/didChangeWatchedFiles` notification.
///
/// A script loaded under `\d .a` defines in `.a`, and not at the root, as
/// the CLI has it (#525): each file's definitions go into `ws` where the
/// others' loads put them. Where that is changes only with a file's loads or
/// the set of files, so an edit that touches neither costs no more than
/// before.
#[derive(Default)]
struct Index {
    files: HashMap<String, Indexed>,
    ws: Workspace,
    /// A file's loads, or the set of files, changed since the placements
    /// were last worked out.
    stale: bool,
    /// Bumped whenever what the workspace defines changes, which is what
    /// makes the open documents' semantic tokens stale.
    generation: u64,
    /// What may be read from disk: `.q` files under these folders, less
    /// those `exclude` names - and nothing at all while `enabled` is off,
    /// when only open documents are indexed.
    roots: Vec<String>,
    exclude: Vec<glob::Pattern>,
    enabled: bool,
    /// Each workspace folder as the client named it, which is how an answer
    /// names the files under it (`Sources::uri`).
    folders: Vec<Folder>,
}

/// A workspace folder: the path it was given as, which is what a removal
/// names, its key, which is what the files under it are keyed below, and the
/// URI the client sent, which is what a file under it is named back by.
struct Folder {
    path: String,
    key: std::path::PathBuf,
    uri: String,
}

impl Folder {
    fn of((path, uri): (String, String)) -> Self {
        Folder {
            key: file_key(&path).into(),
            path,
            uri,
        }
    }
}

/// Bounds on the scan, so a workspace opened at `/` cannot stall the server:
/// the `.q` files read, and every directory entry visited on the way, since
/// a tree of anything else costs as much to walk (#793). There is no bound on
/// a file's size: the CLI reads a large file too, and an index that skipped
/// it reported names only it defines as undefined in the editor alone (#794).
const MAX_FILES: usize = 20_000;
const MAX_ENTRIES: usize = 500_000;

/// One file in the index: what it defines read alone, what decides where
/// its loaders put that, and the result, which is what `ws` holds.
#[derive(Default)]
struct Indexed {
    own: FileIndex,
    loads: Vec<(String, String)>,
    implicit: Vec<String>,
    placement: Placement,
    placed: FileIndex,
    /// What the file reads, for the dependency graph `relate` draws when it
    /// is asked for one. Names and no positions, like the rest - and never
    /// compared, so a read added or dropped relints nothing.
    read: References,
}

impl Index {
    /// Record what `path` defines. Whether it changed is what tells the
    /// caller other open files need linting again.
    fn set(&mut self, path: &str, text: &str) -> bool {
        self.put(path, text) | self.settle()
    }

    /// `set`, leaving the placements to the caller's `settle`, so a batch
    /// of files works them out once.
    fn put(&mut self, path: &str, text: &str) -> bool {
        let path = file_key(path);
        let own = index(text);
        let read = guarded(|| q_lint_rs::references(text, false)).unwrap_or_default();
        let (loads, implicit) = (read.loads.clone(), read.implicit_defines.clone());
        let old = self.files.remove(&path);
        self.stale |= old.as_ref().is_none_or(|old| old.loads != loads);
        let placement = old
            .as_ref()
            .map(|old| old.placement.clone())
            .unwrap_or_default();
        let mut placed = own.clone();
        placement.apply(&mut placed, &implicit);
        let changed = old.as_ref().is_none_or(|old| old.placed != placed);
        if changed {
            if let Some(old) = &old {
                self.ws.remove(&old.placed);
            }
            self.ws.add(&placed);
            self.generation += 1;
        }
        let file = Indexed {
            own,
            loads,
            implicit,
            placement,
            placed,
            read,
        };
        self.files.insert(path, file);
        changed
    }

    /// Forget `path`, leaving the placements to the caller's `settle`.
    fn forget(&mut self, path: &str) -> bool {
        match self.files.remove(&file_key(path)) {
            Some(old) => {
                self.ws.remove(&old.placed);
                self.generation += 1;
                self.stale = true;
                true
            }
            None => false,
        }
    }

    /// Work out again where each file's definitions go, when a file's loads
    /// or the set of files changed, and move those that moved. Only a load
    /// under some `\d .a` can put a file anywhere but the root, so without
    /// one there is no graph to build.
    fn settle(&mut self) -> bool {
        if !std::mem::take(&mut self.stale) {
            return false;
        }
        let keys: Vec<String> = self.files.keys().cloned().collect();
        let contexts = self
            .files
            .values()
            .any(|f| f.loads.iter().any(|(_, ns)| !ns.is_empty() && ns != "."));
        let placements = if contexts {
            let paths: Vec<std::path::PathBuf> = keys.iter().map(Into::into).collect();
            let loads: Vec<_> = keys
                .iter()
                .map(|k| self.files[k].loads.as_slice())
                .collect();
            let cwd = self.cwd();
            guarded(|| q_lint_rs::graph::placements(&paths, &loads, &cwd))
                .unwrap_or_else(|_| vec![Placement::default(); keys.len()])
        } else {
            vec![Placement::default(); keys.len()]
        };
        let mut changed = false;
        for (key, placement) in keys.iter().zip(placements) {
            let file = self.files.get_mut(key).expect("a key just read");
            if file.placement == placement {
                continue;
            }
            let mut placed = file.own.clone();
            placement.apply(&mut placed, &file.implicit);
            file.placement = placement;
            if placed != file.placed {
                self.ws.remove(&file.placed);
                self.ws.add(&placed);
                file.placed = placed;
                changed = true;
            }
        }
        if changed {
            self.generation += 1;
        }
        changed
    }

    /// The directory a relative `\l` is tried against first: the first
    /// workspace folder, which is where a q process over this tree is most
    /// likely started, since the source does not say.
    fn cwd(&self) -> std::path::PathBuf {
        self.roots
            .first()
            .map_or_else(|| std::env::current_dir().unwrap_or_default(), Into::into)
    }

    /// Forget `path` and, when it was a directory, every file under it but
    /// the open documents, whose buffers still hold their text. A watcher
    /// reports a deleted folder as one event for the folder, not one per
    /// file inside it (#543).
    fn remove_tree(&mut self, path: &str, docs: &Documents) -> bool {
        let gone = std::path::PathBuf::from(file_key(path));
        let open: Vec<String> = docs.keys().map(|uri| file_key(&path_of(uri))).collect();
        let under: Vec<String> = self
            .files
            .keys()
            .filter(|k| std::path::Path::new(k).starts_with(&gone) && !open.contains(k))
            .cloned()
            .collect();
        let mut changed = false;
        for key in under {
            changed |= self.forget(&key);
        }
        changed | self.settle()
    }

    /// Read `path` from disk when the index covers it, and forget it when it
    /// does not, is gone, or is unreadable. A closed document and a file
    /// changed on disk both come here, so neither can put back what the
    /// settings left out of the scan.
    fn reload(&mut self, path: &str, policy: &Policy) -> bool {
        let changed = if self.covers(path, policy) {
            self.read(path)
        } else {
            self.forget(path)
        };
        changed | self.settle()
    }

    fn read(&mut self, path: &str) -> bool {
        match std::fs::read(path) {
            Ok(bytes) if is_q_path(path) => self.put(path, &String::from_utf8_lossy(&bytes)),
            _ => self.forget(path),
        }
    }

    /// Whether the scan would have read `path`: index on, under a workspace
    /// folder, in no directory the scan skips, and not excluded.
    fn covers(&self, path: &str, policy: &Policy) -> bool {
        let path = std::path::Path::new(path);
        self.enabled
            && is_q_path(&path.to_string_lossy())
            && self.roots.iter().any(|root| {
                let root = std::path::Path::new(root);
                // The file and each directory above it within the folder,
                // as the scan asks about each before entering it (#795).
                path.starts_with(root)
                    && !path
                        .ancestors()
                        .take_while(|p| *p != root)
                        .any(|p| skipped(policy, p) || self.excluded(root, p))
            })
    }

    /// A pattern is matched against the path relative to the folder it is
    /// under, with `/` between components, as VS Code's globs are.
    fn excluded(&self, root: &std::path::Path, path: &std::path::Path) -> bool {
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let options = glob::MatchOptions {
            require_literal_separator: true,
            ..Default::default()
        };
        self.exclude
            .iter()
            .any(|p| p.matches_with(&relative, options))
    }

    /// Forget everything and read it all again: the workspace from disk,
    /// then the open documents over it, whose buffers win.
    fn rebuild(&mut self, policy: &Policy, docs: &Documents) {
        self.files.clear();
        self.ws = Workspace::default();
        self.generation += 1;
        if self.enabled {
            self.scan(policy);
        }
        for (uri, text) in docs.iter().filter(|(uri, _)| is_q_uri(uri)) {
            self.put(&path_of(uri), text);
        }
        self.settle();
    }

    /// Every `.q` file under the workspace folders, less those `exclude`
    /// names; a directory it names is not entered at all.
    /// Workspace folders the client added and removed after `initialize`:
    /// the added ones scanned, and what only the removed ones held forgotten.
    fn change_roots(
        &mut self,
        added: Vec<(String, String)>,
        removed: Vec<String>,
        policy: &Policy,
    ) {
        self.roots.retain(|r| !removed.contains(r));
        self.folders.retain(|f| !removed.contains(&f.path));
        let added: Vec<String> = added
            .into_iter()
            .filter(|(path, _)| !self.roots.contains(path))
            .map(|folder| {
                let path = folder.0.clone();
                self.folders.push(Folder::of(folder));
                path
            })
            .collect();
        let kept: Vec<String> = self.roots.iter().map(|r| file_key(r)).collect();
        for gone in removed.iter().map(|r| file_key(r)) {
            let under = |key: &str, root: &str| std::path::Path::new(key).starts_with(root);
            let stale: Vec<String> = self
                .files
                .keys()
                .filter(|key| under(key, &gone) && !kept.iter().any(|k| under(key, k)))
                .cloned()
                .collect();
            for key in stale {
                self.forget(&key);
            }
        }
        if self.enabled && !added.is_empty() {
            let all = std::mem::replace(&mut self.roots, added.clone());
            self.scan(policy);
            self.roots = all;
        }
        self.roots.extend(added);
        self.settle();
    }

    fn scan(&mut self, policy: &Policy) {
        self.scan_within(policy, MAX_FILES, MAX_ENTRIES)
    }

    fn scan_within(&mut self, policy: &Policy, max_files: usize, max_entries: usize) {
        let mut stack: Vec<(std::path::PathBuf, std::path::PathBuf)> =
            self.roots.iter().map(|r| (r.into(), r.into())).collect();
        let (mut seen, mut visited) = (0, 0);
        while let Some((root, dir)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                if visited > max_entries {
                    return;
                }
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                // Anything but a directory or a `.q` file is passed by before
                // the settings are asked about it: finding them costs a
                // canonicalize, and a tree of other files paid it per entry.
                // A symlink to a file is read, as the CLI's walk lints it
                // (#542); one to a directory is not entered, as there.
                let is_q = is_q_path(&entry.file_name().to_string_lossy())
                    && (kind.is_file()
                        || kind.is_symlink()
                            && std::fs::metadata(entry.path()).is_ok_and(|m| m.is_file()));
                if !kind.is_dir() && !is_q {
                    continue;
                }
                let path = entry.path();
                if self.excluded(&root, &path) || skipped(policy, &path) {
                    continue;
                }
                if kind.is_dir() {
                    stack.push((root.clone(), path));
                } else {
                    self.read(&path.to_string_lossy());
                    seen += 1;
                    if seen >= max_files {
                        return;
                    }
                }
            }
        }
    }
}

/// Whether the CLI's walk passes `path` by: what the configuration's
/// `exclude` names, by default the usual tool and build directories. The
/// index reads what `qlinter .` would, so the editor's undefined names are
/// the terminal's (#420).
fn skipped(policy: &Policy, path: &std::path::Path) -> bool {
    policy.excluded(path).unwrap_or(false)
}

/// The folders an `initialize` request names, each as a filesystem path and
/// as the URI it was sent as: its `workspaceFolders`, or the older single
/// `rootUri`.
fn workspace_folders(params: &Value) -> Vec<(String, String)> {
    let folder = |uri: &str| file_path(uri).map(|path| (path, uri.to_string()));
    let mut folders: Vec<(String, String)> = params["workspaceFolders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["uri"].as_str())
        .filter_map(folder)
        .collect();
    if folders.is_empty()
        && let Some(root) = params["rootUri"].as_str().and_then(folder)
    {
        folders.push(root);
    }
    folders
}

/// What a client asked for in `initializationOptions`. Every field defaults
/// to what the server did before there were any, so a client that sends
/// nothing - every editor but VS Code, unless configured - sees no change:
///
/// ```json
/// {"lint": {"select": [], "ignore": [], "run": "onType", "severity": {}},
///  "fixes": {"unsafe": true}, "format": {"enable": true},
///  "semanticTokens": {"enable": true}, "navigation": {"enable": true},
///  "help": {"enable": true}, "completion": {"enable": false},
///  "callHierarchy": {"enable": true}, "graph": {"enable": true},
///  "workspaceIndex": {"enable": true, "exclude": []}}
/// ```
///
/// `lint.select` and `lint.ignore` narrow the selection (see
/// `Policy::narrow`); everything else here is the server's own behaviour,
/// which no configuration file describes.
struct Options {
    /// Lint on save rather than on every change. An open buffer's text is
    /// still kept current, for code actions and formatting.
    on_save: bool,
    /// Offer the editor-only fixes as Quick Fixes, not just the batch-safe
    /// ones `--fix` applies.
    unsafe_fixes: bool,
    format: bool,
    semantic_tokens: bool,
    /// Read the workspace's `.q` files at startup. Off, only open documents
    /// are indexed.
    index: bool,
    index_exclude: Vec<glob::Pattern>,
    /// Answer the navigation requests. Off for someone whose other q
    /// extension answers them already, and would otherwise list each
    /// definition twice.
    navigation: bool,
    /// Answer hover and signature help.
    help: bool,
    /// Answer completion. Off unless asked for: an editor told a server
    /// completes stops offering the words of the open buffers, and the
    /// names offered here - the workspace's, a lambda's locals and q's own -
    /// leave out the columns and keys those words include.
    completion: bool,
    /// Answer the call hierarchy requests. Its own switch, since an editor
    /// asks every server that announces the capability and shows one answer.
    call_hierarchy: bool,
    /// Answer `q-lint/graph` and `q-lint/affectedTests`, the file-to-file
    /// dependency graph `qlinter analyze graph` prints.
    graph: bool,
    /// Answer inlay hints: parameter names at a call's arguments.
    inlay_hints: bool,
    /// Answer code lenses: Run above a function's definition. Off unless
    /// asked for, since the lens runs a command only an editor that
    /// registers it has (`q-lint.runDefinition`, the VS Code extension's).
    code_lens: bool,
    /// A diagnostic severity by code or prefix; the longest that names a
    /// code decides.
    severity: Vec<(String, i64)>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            on_save: false,
            unsafe_fixes: true,
            format: true,
            semantic_tokens: true,
            index: true,
            index_exclude: vec![],
            navigation: true,
            help: true,
            completion: false,
            call_hierarchy: true,
            graph: true,
            inlay_hints: true,
            code_lens: false,
            severity: vec![],
        }
    }
}

impl Options {
    /// The options in `initialize`'s params, and a line for each one that
    /// could not be read. A bad value is reported and its default used: a
    /// server that refused to start over a typo in a setting would give an
    /// editor no diagnostics at all.
    fn read(params: &Value) -> (Self, Layer, Vec<String>) {
        let init = &params["initializationOptions"];
        let mut options = Options::default();
        let mut problems = vec![];
        // A pointer through a string, a flag or a list finds nothing, which
        // reads as unset: `"lint": "QS001"` was silently every rule (#805).
        match init {
            Value::Null => {}
            Value::Object(sections) => {
                for (key, value) in sections {
                    if [
                        "lint",
                        "fixes",
                        "format",
                        "semanticTokens",
                        "workspaceIndex",
                        "navigation",
                        "help",
                        "completion",
                        "callHierarchy",
                        "graph",
                        "inlayHints",
                        "codeLens",
                    ]
                    .contains(&key.as_str())
                        && !value.is_object()
                        && !value.is_null()
                    {
                        problems.push(format!("/{key} must be an object, not {value}"));
                    }
                }
            }
            other => problems.push(format!(
                "initializationOptions must be an object, not {other}"
            )),
        }
        let mut flag = |pointer: &str, default: bool| match init.pointer(pointer) {
            None | Some(Value::Null) => default,
            Some(Value::Bool(b)) => *b,
            Some(other) => {
                problems.push(format!("{pointer} must be true or false, not {other}"));
                default
            }
        };
        options.unsafe_fixes = flag("/fixes/unsafe", true);
        options.format = flag("/format/enable", true);
        options.semantic_tokens = flag("/semanticTokens/enable", true);
        options.index = flag("/workspaceIndex/enable", true);
        options.navigation = flag("/navigation/enable", true);
        options.help = flag("/help/enable", true);
        options.completion = flag("/completion/enable", false);
        options.call_hierarchy = flag("/callHierarchy/enable", true);
        options.graph = flag("/graph/enable", true);
        options.inlay_hints = flag("/inlayHints/enable", true);
        options.code_lens = flag("/codeLens/enable", false);
        match init.pointer("/lint/run") {
            None | Some(Value::Null) => {}
            Some(v) if v == "onType" => {}
            Some(v) if v == "onSave" => options.on_save = true,
            Some(other) => problems.push(format!(
                "/lint/run must be \"onType\" or \"onSave\", not {other}"
            )),
        }
        let mut strings = |pointer: &str| -> Vec<String> {
            match init.pointer(pointer) {
                None | Some(Value::Null) => vec![],
                Some(Value::Array(items)) => items
                    .iter()
                    .filter_map(|item| match item.as_str() {
                        Some(s) => Some(s.to_string()),
                        None => {
                            problems.push(format!("{pointer} must list strings, not {item}"));
                            None
                        }
                    })
                    .collect(),
                Some(other) => {
                    problems.push(format!("{pointer} must be a list, not {other}"));
                    vec![]
                }
            }
        };
        let select = strings("/lint/select");
        let ignore = strings("/lint/ignore");
        let exclude = strings("/workspaceIndex/exclude");
        // A code that names no rule is reported and dropped: kept, a typo in
        // `select` would silently select nothing.
        let mut codes = |key: &str, list: Vec<String>| -> Vec<String> {
            list.iter()
                .filter_map(|s| selector(key, s).map_err(|e| problems.push(e)).ok())
                .collect()
        };
        let select = codes("/lint/select", select);
        let ignore = codes("/lint/ignore", ignore);
        for text in exclude {
            match crate::config::pattern(&text) {
                Ok(p) => options.index_exclude.push(p),
                Err(e) => problems.push(format!("/workspaceIndex/exclude: {e}")),
            }
        }
        match init.pointer("/lint/severity") {
            None | Some(Value::Null) => {}
            Some(Value::Object(map)) => {
                for (code, level) in map {
                    let level = match level.as_str() {
                        Some("error") => 1,
                        Some("warning") => 2,
                        Some("information") => 3,
                        Some("hint") => 4,
                        _ => {
                            problems.push(format!(
                                "/lint/severity/{code} must be error, warning, information \
                                 or hint, not {level}"
                            ));
                            continue;
                        }
                    };
                    match selector("/lint/severity", code) {
                        Ok(code) => options.severity.push((code, level)),
                        Err(e) => problems.push(e),
                    }
                }
            }
            Some(other) => problems.push(format!(
                "/lint/severity must map codes to severities, not {other}"
            )),
        }
        let layer = Layer {
            // An empty list is no selection at all, not a selection of
            // nothing: it is what an editor sends for a setting left alone.
            select: (!select.is_empty()).then_some(select),
            extend_select: vec![],
            ignore,
        };
        (options, layer, problems)
    }

    /// The severity a client asked for `code`, if it asked for one.
    fn severity_of(&self, code: &str) -> Option<i64> {
        self.severity
            .iter()
            .filter(|(s, _)| s == "ALL" || code.starts_with(s.as_str()))
            .max_by_key(|(s, _)| if s == "ALL" { 0 } else { s.len() })
            .map(|&(_, level)| level)
    }
}

/// What `read_ahead` hands the loop: `receive`'s answer for each message.
type Incoming = Result<Option<Result<Value, Malformed>>, String>;

/// Every message on `reader`, read as it arrives by a thread of its own,
/// up to the end of the stream or the first error that loses the framing,
/// which is handed on and ends it.
///
/// Detached: the loop returns on `exit` while the client may still hold
/// stdin open, and the process ends with the thread blocked in a read.
fn read_ahead(mut reader: impl BufRead + Send + 'static) -> Receiver<Incoming> {
    let (sender, messages) = channel();
    std::thread::spawn(move || {
        loop {
            let next = receive(&mut reader);
            let more = matches!(next, Ok(Some(_)));
            if sender.send(next).is_err() || !more {
                return;
            }
        }
    });
    messages
}

/// Whether a queued message is a `didChange` of the document `uri`.
fn is_change_to(incoming: &Incoming, uri: &str) -> bool {
    matches!(incoming, Ok(Some(Ok(m)))
        if m["method"] == "textDocument/didChange" && m.get("id").is_none()
            && m["params"]["textDocument"]["uri"] == uri)
}

/// Whether a queued message is a `$/cancelRequest` of the request `id`.
fn cancels(incoming: &Incoming, id: &Value) -> bool {
    matches!(incoming, Ok(Some(Ok(m)))
        if m["method"] == "$/cancelRequest" && m.get("id").is_none() && m["params"]["id"] == *id)
}

pub fn serve(
    reader: impl BufRead + Send + 'static,
    writer: &mut impl Write,
    policy: &Policy,
) -> Result<u8, String> {
    let messages = read_ahead(reader);
    // What has arrived and is not yet handled, oldest first.
    let mut queue: VecDeque<Incoming> = VecDeque::new();
    let mut docs: Documents = HashMap::new();
    let mut unsaved = Unsaved::new();
    let mut kept = Kept::new();
    let mut idx = Index::default();
    let mut opts = Options::default();
    let mut problems: Vec<String> = vec![];
    let mut initialized = false;
    // Whether the client can take a `CodeAction` literal; see `capabilities`.
    let mut code_action_literals = false;
    // Whether the client re-asks for semantic tokens when told to, and the
    // id of the next request the server sends it.
    let mut token_refresh = false;
    // Whether the client takes the outline as `DocumentSymbol`s, and asks
    // before a rename what would be renamed.
    let mut nested_symbols = false;
    let mut help_client = help::Client::default();
    let mut next_request: u64 = 0;
    // Whether the client takes file watchers the server registers - Neovim
    // and Helix send didChangeWatchedFiles only for those (#792) - and ones
    // rooted outside the workspace; the watchers registered, once the client
    // is ready for them.
    let mut watch_registration = false;
    let mut relative_patterns = false;
    let mut ready = false;
    let mut watching: Vec<Value> = vec![];
    let mut watch_id: Option<String> = None;
    let mut shutdown_requested = false;
    loop {
        // Everything the client has sent so far, before the oldest of it is
        // handled: what is behind a message can make it moot.
        if queue.is_empty() {
            match messages.recv() {
                Ok(next) => queue.push_back(next),
                // The reader handed on how the stream ended and stopped; the
                // loop has already returned on it.
                Err(_) => return Ok(if shutdown_requested { 0 } else { 1 }),
            }
        }
        queue.extend(messages.try_iter());
        let next = queue.pop_front().expect("a message, just queued");
        let message = match next? {
            Some(Ok(message)) => message,
            // Answered, with the `id: null` JSON-RPC 2.0 §5 requires when the
            // id could not be read, and the server carries on: the framing
            // is intact, and exiting would drop every open document over one
            // bad message.
            Some(Err(malformed)) => {
                eprintln!("qlinter: {}", malformed.message);
                send(
                    writer,
                    json!({"id": Value::Null, "error": {"code": malformed.code, "message": malformed.message}}),
                )?;
                continue;
            }
            // The stream closed without `exit`. Editors are supposed to send
            // it; when one dies instead, leaving cleanly is the friendlier
            // behaviour and matches what rust-analyzer does.
            None => return Ok(if shutdown_requested { 0 } else { 1 }),
        };
        let id = message.get("id").cloned();
        let method = match message.get("method") {
            Some(Value::String(method)) => method.clone(),
            // A response, to a request of the server's own. JSON-RPC 2.0 §5:
            // a response is never answered - an error sent back would carry
            // the id of one of the client's own requests.
            None if message.get("result").is_some() || message.get("error").is_some() => continue,
            // Not a valid Request object (JSON-RPC 2.0 §5.1): -32600, not
            // MethodNotFound, and with the id when there is one to read.
            _ => {
                send(
                    writer,
                    json!({"id": id.unwrap_or(Value::Null), "error": {"code": INVALID_REQUEST,
                           "message": "a request's method must be a string"}}),
                )?;
                continue;
            }
        };
        // JSON-RPC 2.0 §4: an id is a string, a number or null. Any other is
        // not a Request, and the reply cannot carry it back (#548).
        if id
            .as_ref()
            .is_some_and(|id| !(id.is_string() || id.is_number() || id.is_null()))
        {
            send(
                writer,
                json!({"id": Value::Null, "error": {"code": INVALID_REQUEST,
                       "message": "a request's id must be a string, a number or null"}}),
            )?;
            continue;
        }
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        // LSP 3.17, Cancellation Support: a request cancelled is still
        // answered, and RequestCancelled says it was not run. Only one still
        // waiting can be; one already answered had its cancel come too late,
        // and the notification is dropped like any other unknown one.
        // `initialize` and `shutdown` are carried out whatever follows them:
        // either, left undone, leaves the session in no state at all.
        if let Some(id) = &id
            && initialized
            && method != "shutdown"
            && queue.iter().any(|later| cancels(later, id))
        {
            send(
                writer,
                json!({"id": id, "error": {"code": REQUEST_CANCELLED,
                       "message": "cancelled before it was run"}}),
            )?;
            continue;
        }
        // A change with another change to the same document already behind
        // it: its text is taken, so whatever comes between is answered on
        // it, and it is not linted, since its diagnostics would be replaced
        // before a person could read them. The last change of a burst is.
        // A request is not dropped in the same way when its document has
        // changed behind it: LSP 3.17 says a server should NOT answer
        // ContentModified for a change still in its queue, as an answer on
        // the older text can still be of use, and it is the client's to
        // cancel one that is not.
        let superseded = method == "textDocument/didChange"
            && id.is_none()
            && queue.iter().any(|later| {
                is_change_to(later, params["textDocument"]["uri"].as_str().unwrap_or(""))
            });

        let generation = idx.generation;
        match (method.as_str(), id) {
            // LSP 3.17: "The initialize request may only be sent once." A
            // second is refused and changes nothing - answered, its options
            // were installed over a narrowing it could not undo (#547).
            ("initialize", Some(id)) if initialized => send(
                writer,
                json!({"id": id, "error": {"code": INVALID_REQUEST,
                       "message": "initialize may only be sent once"}}),
            )?,
            ("initialize", Some(id)) => {
                let folders = workspace_folders(&params);
                idx.roots = folders.iter().map(|(path, _)| path.clone()).collect();
                idx.folders = folders.into_iter().map(Folder::of).collect();
                let layer;
                (opts, layer, problems) = Options::read(&params);
                if layer.select.is_some() || !layer.ignore.is_empty() {
                    policy.narrow(layer);
                }
                code_action_literals = params
                    .pointer("/capabilities/textDocument/codeAction/codeActionLiteralSupport")
                    .is_some_and(|v| !v.is_null());
                token_refresh = params
                    .pointer("/capabilities/workspace/semanticTokens/refreshSupport")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let watched = |key: &str| {
                    params
                        .pointer(&format!(
                            "/capabilities/workspace/didChangeWatchedFiles/{key}"
                        ))
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                };
                watch_registration = watched("dynamicRegistration");
                relative_patterns = watched("relativePatternSupport");
                let client = |pointer: &str| {
                    params
                        .pointer(&format!("/capabilities/textDocument/{pointer}"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                };
                nested_symbols = client("documentSymbol/hierarchicalDocumentSymbolSupport");
                let mut result = capabilities(&opts, code_action_literals);
                if opts.navigation {
                    navigate::announce(
                        &mut result["capabilities"],
                        client("rename/prepareSupport"),
                    );
                }
                help_client = help::Client::read(&params);
                help::announce(&mut result["capabilities"], opts.help, opts.completion);
                relate::announce(&mut result["capabilities"], opts.call_hierarchy, opts.graph);
                annotate::announce(
                    &mut result["capabilities"],
                    opts.inlay_hints,
                    opts.code_lens,
                );
                send(writer, json!({"id": id, "result": result}))?;
                initialized = true;
            }
            ("exit", _) => return Ok(if shutdown_requested { 0 } else { 1 }),
            // LSP 3.17, Initialize Request: before `initialize`, a request is
            // answered with ServerNotInitialized and a notification dropped,
            // `exit` excepted.
            (_, Some(id)) if !initialized => send(
                writer,
                json!({"id": id, "error": {"code": SERVER_NOT_INITIALIZED, "message": "server is not initialized"}}),
            )?,
            (_, None) if !initialized => {}
            // Indexed once the client is ready rather than inside initialize,
            // so a large workspace does not hold up the handshake.
            ("initialized", None) => {
                // Told once the client is listening: a setting that could not
                // be read is otherwise a default nobody knows is in force.
                for problem in problems.drain(..) {
                    eprintln!("qlinter: initializationOptions: {problem}");
                    send(
                        writer,
                        json!({"method": "window/showMessage", "params": {"type": 2,
                               "message": format!("q-lint: ignoring a setting: {problem}")}}),
                    )?;
                }
                idx.enabled = opts.index;
                idx.exclude = opts.index_exclude.clone();
                idx.rebuild(policy, &docs);
                ready = true;
            }
            // A request after shutdown is the one protocol error worth
            // answering rather than ignoring: the client is confused and
            // should be told, not left waiting for a reply that never comes.
            // A second `shutdown` included (LSP 3.17, Shutdown Request).
            (_, Some(id)) if shutdown_requested => send(
                writer,
                json!({"id": id, "error": {"code": INVALID_REQUEST, "message": "server is shut down"}}),
            )?,
            ("shutdown", Some(id)) => {
                shutdown_requested = true;
                docs.clear();
                unsaved.clear();
                kept.clear();
                send(writer, json!({"id": id, "result": Value::Null}))?;
            }

            // A document method with no document to act on (#799): a request
            // answered with JSON-RPC 2.0's Invalid params, not an empty
            // result that says there is nothing to fix; a notification
            // dropped, rather than diagnostics published for `uri: ""`.
            (
                "textDocument/didOpen"
                | "textDocument/didChange"
                | "textDocument/didSave"
                | "textDocument/didClose"
                | "textDocument/semanticTokens/full"
                | "textDocument/codeAction"
                | "textDocument/formatting"
                | "textDocument/documentSymbol"
                | "textDocument/definition"
                | "textDocument/references"
                | "textDocument/documentHighlight"
                | "textDocument/prepareRename"
                | "textDocument/rename"
                | "textDocument/foldingRange"
                | "textDocument/hover"
                | "textDocument/signatureHelp"
                | "textDocument/completion"
                | "textDocument/prepareCallHierarchy"
                | "textDocument/inlayHint"
                | "textDocument/codeLens"
                | "q-lint/graph",
                id,
            ) if !params["textDocument"]["uri"].is_string() => {
                let message = format!("{method}: params.textDocument.uri must be a string");
                match id {
                    Some(id) => send(
                        writer,
                        json!({"id": id, "error": {"code": INVALID_PARAMS, "message": message}}),
                    )?,
                    None => eprintln!("qlinter: {message}"),
                }
            }
            ("textDocument/didOpen", None) => {
                let uri = uri_of(&params["textDocument"]);
                let text = params["textDocument"]["text"].as_str().unwrap_or("");
                unsaved.remove(&uri);
                publish(
                    writer,
                    &mut docs,
                    &unsaved,
                    &mut kept,
                    &mut idx,
                    uri,
                    text.to_string(),
                    policy,
                    &opts,
                )?;
            }
            ("textDocument/didChange", None) => {
                let uri = uri_of(&params["textDocument"]);
                // Full sync, so the LAST change holds the whole buffer. Taking
                // the first would silently lint a stale document whenever a
                // client batched two edits into one notification.
                if let Some(text) = params["contentChanges"]
                    .as_array()
                    .and_then(|c| c.last())
                    .and_then(|c| c["text"].as_str())
                {
                    if opts.on_save {
                        // Kept, so a Quick Fix or a format reads what is on
                        // screen; linted, and indexed, when it is saved.
                        docs.insert(uri.clone(), text.to_string());
                        unsaved.insert(uri);
                    } else if superseded {
                        // Indexed with the change that is linted, which
                        // compares what the document defines with what it
                        // did before the burst.
                        docs.insert(uri, text.to_string());
                    } else {
                        publish(
                            writer,
                            &mut docs,
                            &unsaved,
                            &mut kept,
                            &mut idx,
                            uri,
                            text.to_string(),
                            policy,
                            &opts,
                        )?;
                    }
                }
            }
            ("textDocument/didSave", None) => {
                // `text` is present only when the client registered for it.
                // Falling back to what we already hold keeps a save from
                // clearing the diagnostics of a document we know the text of.
                let uri = uri_of(&params["textDocument"]);
                let text = params["text"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| docs.get(&uri).cloned());
                if let Some(text) = text {
                    unsaved.remove(&uri);
                    publish(
                        writer, &mut docs, &unsaved, &mut kept, &mut idx, uri, text, policy, &opts,
                    )?;
                }
            }
            ("textDocument/didClose", None) => {
                let uri = uri_of(&params["textDocument"]);
                docs.remove(&uri);
                unsaved.remove(&uri);
                kept.remove(&uri);
                // The buffer is gone, so the disk is the authority again - and
                // unsaved definitions it held no longer define anything.
                if idx.reload(&path_of(&uri), policy) {
                    relint(
                        writer, &docs, &unsaved, &mut kept, &idx, None, policy, &opts,
                    )?;
                }
                // An empty list, not silence: diagnostics are owned by the
                // server until it says otherwise, so a closed file would keep
                // its squiggles in the problems panel forever.
                send(
                    writer,
                    json!({"method": "textDocument/publishDiagnostics",
                           "params": {"uri": uri, "diagnostics": []}}),
                )?;
            }
            ("textDocument/semanticTokens/full", Some(id)) => {
                let uri = uri_of(&params["textDocument"]);
                let data = guarded(|| {
                    docs.get(&uri)
                        .filter(|_| opts.semantic_tokens && is_q_uri(&uri))
                        .map_or_else(Vec::new, |text| encode_tokens(text, &idx.ws))
                });
                match data {
                    Ok(data) => send(writer, json!({"id": id, "result": {"data": data}}))?,
                    Err(panic) => send(writer, internal_error(id, &panic))?,
                }
            }
            ("textDocument/codeAction", Some(id)) if !code_action_literals => {
                send(writer, json!({"id": id, "result": []}))?
            }
            ("textDocument/codeAction", Some(id)) => {
                match guarded(|| code_actions(&params, &docs, &idx.ws, policy, opts.unsafe_fixes)) {
                    Ok(actions) => send(writer, json!({"id": id, "result": actions}))?,
                    Err(panic) => send(writer, internal_error(id, &panic))?,
                }
            }
            ("textDocument/formatting", Some(id)) => {
                let edits = if opts.format {
                    guarded(|| format(&params, &docs, &idx.ws, policy))
                } else {
                    Ok(vec![])
                };
                match edits {
                    Ok(edits) => send(writer, json!({"id": id, "result": edits}))?,
                    Err(panic) => send(writer, internal_error(id, &panic))?,
                }
            }
            (
                "textDocument/documentSymbol"
                | "textDocument/definition"
                | "textDocument/references"
                | "textDocument/documentHighlight"
                | "textDocument/prepareRename"
                | "textDocument/rename"
                | "workspace/symbol",
                Some(id),
            ) => {
                let answer = guarded(|| {
                    if !opts.navigation {
                        return Ok(Value::Null);
                    }
                    let sources = navigate::Sources::new(&docs, &idx);
                    navigate::answer(&method, &params, &sources, nested_symbols)
                });
                match answer {
                    Ok(Ok(result)) => send(writer, json!({"id": id, "result": result}))?,
                    Ok(Err(refusal)) => send(
                        writer,
                        json!({"id": id, "error": {"code": REQUEST_FAILED, "message": refusal}}),
                    )?,
                    Err(panic) => send(writer, internal_error(id, &panic))?,
                }
            }
            ("textDocument/foldingRange", Some(id)) => {
                match guarded(|| folding_ranges(&params, &docs, &kept)) {
                    Ok(ranges) => send(writer, json!({"id": id, "result": ranges}))?,
                    Err(panic) => send(writer, internal_error(id, &panic))?,
                }
            }
            (
                "textDocument/hover" | "textDocument/signatureHelp" | "textDocument/completion",
                Some(id),
            ) => {
                // Asked of a server that did not announce it, a request is
                // answered with nothing rather than refused.
                let on = match method.as_str() {
                    "textDocument/completion" => opts.completion,
                    _ => opts.help,
                };
                let answer = guarded(|| {
                    if !on {
                        return Value::Null;
                    }
                    let sources = navigate::Sources::new(&docs, &idx);
                    help::answer(&method, &params, &sources, help_client)
                });
                match answer {
                    Ok(result) => send(writer, json!({"id": id, "result": result}))?,
                    Err(panic) => send(writer, internal_error(id, &panic))?,
                }
            }
            ("textDocument/inlayHint" | "textDocument/codeLens", Some(id)) => {
                // Asked of a server that did not announce it, a request is
                // answered with nothing rather than refused.
                let on = match method.as_str() {
                    "textDocument/codeLens" => opts.code_lens,
                    _ => opts.inlay_hints,
                };
                let answer = guarded(|| {
                    if !on {
                        return Value::Null;
                    }
                    let sources = navigate::Sources::new(&docs, &idx);
                    annotate::answer(&method, &params, &sources)
                });
                match answer {
                    Ok(result) => send(writer, json!({"id": id, "result": result}))?,
                    Err(panic) => send(writer, internal_error(id, &panic))?,
                }
            }
            (
                "textDocument/prepareCallHierarchy"
                | "callHierarchy/incomingCalls"
                | "callHierarchy/outgoingCalls"
                | "q-lint/graph"
                | "q-lint/affectedTests",
                Some(id),
            ) => {
                let answer = guarded(|| {
                    let sources = navigate::Sources::new(&docs, &idx);
                    relate::answer(&method, &params, &sources, opts.call_hierarchy, opts.graph)
                });
                match answer {
                    Ok(result) => send(writer, json!({"id": id, "result": result}))?,
                    Err(panic) => send(writer, internal_error(id, &panic))?,
                }
            }

            // A `.q` file created, changed or deleted outside the editor - a
            // pull, a checkout, another tool. An open file's buffer still wins.
            ("workspace/didChangeWatchedFiles", None) => {
                let mut changed = false;
                let mut config_changed = false;
                for change in params["changes"].as_array().into_iter().flatten() {
                    let uri = uri_of(change);
                    // A configuration file changed: every file it governs may
                    // now report differently, so forget them all and relint.
                    let path = path_of(&uri);
                    if is_config_path(&path) || policy.read_from(Path::new(&path)) {
                        policy.reset();
                        config_changed = true;
                        continue;
                    }
                    if docs.contains_key(&uri) {
                        continue;
                    }
                    changed |= if change["type"].as_i64() == Some(3) {
                        idx.remove_tree(&path, &docs)
                    } else {
                        idx.reload(&path, policy)
                    };
                }
                // And its `exclude` decides which files the index reads, so
                // the index is read again as a fresh server would (#541).
                if config_changed {
                    idx.rebuild(policy, &docs);
                    // What a broken document carries over was reported under
                    // the old settings.
                    kept.clear();
                }
                if changed || config_changed {
                    relint(
                        writer, &docs, &unsaved, &mut kept, &idx, None, policy, &opts,
                    )?;
                }
            }
            // A folder added to or removed from a multi-root workspace (#797).
            ("workspace/didChangeWorkspaceFolders", None) => {
                let folders = |key: &str| {
                    workspace_folders(&json!({"workspaceFolders": params["event"][key]}))
                };
                let removed = folders("removed").into_iter().map(|(path, _)| path);
                idx.change_roots(folders("added"), removed.collect(), policy);
                // An open buffer still wins over what a folder held.
                for (uri, text) in docs.iter().filter(|(uri, _)| is_q_uri(uri)) {
                    idx.put(&path_of(uri), text);
                }
                idx.settle();
                if idx.generation != generation {
                    relint(
                        writer, &docs, &unsaved, &mut kept, &idx, None, policy, &opts,
                    )?;
                }
            }
            // Every other REQUEST gets an error, because a client waiting on a
            // reply that never arrives looks like a hung server.
            (_, Some(id)) => send(
                writer,
                json!({"id": id, "error": {"code": METHOD_NOT_FOUND, "message": format!("unsupported method: {method}")}}),
            )?,
            // Every other NOTIFICATION is ignored, which the protocol requires.
            (_, None) => {}
        }
        // Another file's definitions changed, so a name in an open document
        // may now be a function, or no longer one. Its diagnostics were
        // pushed again; its colours a client fetches only when it changes,
        // or when asked to (LSP 3.17, workspace/semanticTokens/refresh). The
        // client's reply is a response, and dropped as one.
        // What the settings were read from changes as documents open and
        // configurations change, so the watchers follow it (LSP 3.17,
        // client/registerCapability). A changed set replaces the old one.
        if ready && watch_registration && !shutdown_requested {
            let want = watchers(&idx.roots, policy, relative_patterns);
            if want != watching {
                next_request += 1;
                let id = format!("qlinter-watch-{next_request}");
                send(
                    writer,
                    json!({"id": format!("qlinter-{next_request}"),
                           "method": "client/registerCapability",
                           "params": {"registrations": [{"id": id,
                                      "method": "workspace/didChangeWatchedFiles",
                                      "registerOptions": {"watchers": want}}]}}),
                )?;
                if let Some(old) = watch_id.replace(id) {
                    next_request += 1;
                    send(
                        writer,
                        json!({"id": format!("qlinter-{next_request}"),
                               "method": "client/unregisterCapability",
                               "params": {"unregisterations": [{"id": old,
                                          "method": "workspace/didChangeWatchedFiles"}]}}),
                    )?;
                }
                watching = want;
            }
        }
        if idx.generation != generation
            && token_refresh
            && opts.semantic_tokens
            && !shutdown_requested
        {
            next_request += 1;
            send(
                writer,
                json!({"id": format!("qlinter-{next_request}"), "method": "workspace/semanticTokens/refresh"}),
            )?;
        }
    }
}

/// What the server offers. Formatting and semantic tokens a client turned
/// off are not announced at all, so the editor uses another provider - its
/// own grammar's colours, another formatter - rather than an empty answer.
///
/// Quick fixes likewise, for a client that did not declare
/// `codeActionLiteralSupport`: LSP 3.17 lets the server return only
/// `Command`s to it, and a fix here is an edit, not a command the server
/// could run. Such a client still has every safe fix through formatting.
fn capabilities(opts: &Options, code_action_literals: bool) -> Value {
    let mut capabilities = json!({
        // The options form, not the bare kind: only it can carry `save`, and
        // LSP 3.17 has a client send `didSave` only when `save` is present -
        // which `lint.run: "onSave"` depends on.
        "textDocumentSync": {
            "openClose": true,
            "change": SYNC_FULL,
            "save": {"includeText": false},
        },
    });
    if code_action_literals {
        // The kinds, not a bare `true`: an editor asks for `source.fixAll`
        // actions on save only of a server that says it has some.
        capabilities["codeActionProvider"] = json!({"codeActionKinds": [QUICK_FIX, FIX_ALL]});
    }
    capabilities["foldingRangeProvider"] = json!(true);
    capabilities["workspace"] = json!({
        "workspaceFolders": {"supported": true, "changeNotifications": true},
    });
    if opts.format {
        capabilities["documentFormattingProvider"] = json!(true);
    }
    if opts.semantic_tokens {
        capabilities["semanticTokensProvider"] = json!({
            "legend": {"tokenTypes": TOKEN_TYPES, "tokenModifiers": []},
            "full": true,
        });
    }
    json!({
        "capabilities": capabilities,
        "serverInfo": {"name": "q-lint", "version": env!("CARGO_PKG_VERSION")},
    })
}

/// The legend, in the order `encode_tokens` numbers them. Both are standard
/// LSP token types, so every theme already has a colour for them.
const TOKEN_TYPES: [&str; 2] = ["function", "parameter"];

/// Semantic tokens in the protocol's packed form: five integers per token -
/// line delta, start delta (from the previous token when on the same line),
/// length, type and modifiers - with positions in UTF-16 code units.
fn encode_tokens(source: &str, ws: &Workspace) -> Vec<u32> {
    let mut data = vec![];
    let (mut prev_line, mut prev_start) = (0usize, 0usize);
    let lines = Lines::new(source);
    for (at, len, kind) in semantic_tokens_in(source, ws) {
        let (line, start) = lines.position(at);
        let delta_start = if line == prev_line {
            start - prev_start
        } else {
            start
        };
        let kind = match kind {
            TokenKind::Function => 0,
            TokenKind::Parameter => 1,
        };
        data.extend([
            (line - prev_line) as u32,
            delta_start as u32,
            utf16_len(&source[at..at + len]) as u32,
            kind,
            0,
        ]);
        (prev_line, prev_start) = (line, start);
    }
    data
}

/// Run `f`, and turn a panic in it into an error naming the panic.
///
/// The rules run on every keystroke of half-typed text, and a panic in one
/// of them is a bug in that rule, not in the document. Contained here, it
/// costs one answer about one document; uncontained, it ended the process and
/// every open document's state with it. The panic hook still prints it, with
/// its location, on stderr.
fn guarded<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(|payload| {
        payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic with no message".into())
    })
}

/// What `text` defines, or nothing when reading it panics.
fn index(text: &str) -> FileIndex {
    guarded(|| q_lint_rs::index(text)).unwrap_or_default()
}

/// The reply to a request whose handler panicked: JSON-RPC 2.0 §5.1's
/// `-32603 Internal error`, rather than no reply, which a client cannot tell
/// from a hung server.
fn internal_error(id: Value, panic: &str) -> Value {
    json!({"id": id, "error": {"code": INTERNAL_ERROR,
           "message": format!("qlinter failed on this document: {panic}")}})
}

fn is_q_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("q"))
}

fn uri_of(text_document: &Value) -> String {
    text_document["uri"].as_str().unwrap_or("").to_string()
}

/// Offer only replacements whose meaning is unambiguous, and verify each
/// client-supplied diagnostic against the current unsaved buffer. A pending
/// code-action request can otherwise apply an old fix after another edit.
/// A file whose change can change what any document reports.
fn is_config_path(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .is_some_and(|n| FILES.contains(&&*n.to_string_lossy()))
}

/// What the server asks a client to watch for it: the workspace's `.q`
/// files, and every `.toml` in it, since a base is `extend`ed by any name.
/// And, for a client that takes a pattern rooted elsewhere, the files and
/// directories outside the workspace that the settings came from or were
/// searched for in - a configuration above the folder, an `extend`ed base
/// beside it, the user-level file - which no workspace pattern reaches and
/// whose change the server otherwise never heard of (#554).
fn watchers(roots: &[String], policy: &Policy, relative: bool) -> Vec<Value> {
    let mut out = vec![
        json!({"globPattern": "**/*.q"}),
        json!({"globPattern": "**/*.toml"}),
    ];
    if !relative {
        return out;
    }
    let roots: Vec<std::path::PathBuf> = roots.iter().map(|r| file_key(r).into()).collect();
    // Both sides as keys: a real path is verbatim on Windows, and
    // `C:\a` does not start with `\\?\C:\a` (#554).
    let outside = |p: &std::path::Path| {
        let p = std::path::PathBuf::from(file_key(&p.to_string_lossy()));
        !roots.iter().any(|r| p.starts_with(r))
    };
    let (files, dirs) = policy.watched();
    let names = format!("{{{}}}", FILES.join(","));
    for dir in dirs.iter().filter(|d| outside(d)) {
        out.push(json!({"globPattern": {"baseUri": path_uri(dir), "pattern": names}}));
    }
    // `--config` names a file by any name, which `**/*.toml` may not match.
    let toml = |p: &std::path::Path| p.extension().is_some_and(|e| e == "toml");
    for file in files.iter().filter(|f| outside(f) || !toml(f)) {
        if let (Some(dir), Some(name)) = (file.parent(), file.file_name()) {
            out.push(json!({"globPattern":
                {"baseUri": path_uri(dir), "pattern": name.to_string_lossy()}}));
        }
    }
    out
}

/// A filesystem path as a `file:` URI, `path_of` undone.
///
/// A real path on Windows is verbatim - `\\?\C:\a`, `\\?\UNC\host\share` -
/// and an editor knows that file as `file:///C:/a` and `file://host/share`:
/// spelled through, it named no folder a client could watch.
fn path_uri(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    let text = match text.strip_prefix(r"\\?\UNC\") {
        Some(unc) => format!(r"\\{unc}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_string(),
    };
    let text = text.replace('\\', "/");
    let mut uri = String::from(if text.starts_with("//") {
        "file:"
    } else if text.starts_with('/') {
        "file://"
    } else {
        "file:///"
    });
    escape(&mut uri, &text);
    uri
}

/// `text` onto a URI, each byte a URI cannot hold as itself escaped.
fn escape(uri: &mut String, text: &str) {
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
}

/// The URI an answer names an indexed file by - a location, a call, a file
/// in the graph or among the tests a change reaches. Every one of them comes
/// here, so a file is named one way whatever the request.
///
/// The file is keyed by its real path (`file_key`), and the client knows it
/// by the spelling it used: a workspace opened as `/tmp/ws`, where `/tmp` is
/// a link to `/private/tmp`, has its files keyed `/private/tmp/ws/...`, and a
/// URI made from the key named a file the editor then opened a second time,
/// and that it showed as an absolute path rather than one in its folder
/// (#850). So: an open document by the URI it was opened with; a file under
/// a workspace folder by that folder's URI as the client sent it and the
/// path below it - the innermost folder, when one holds another; and only a
/// file in no folder by its real path.
impl navigate::Sources<'_> {
    fn uri(&self, key: &str) -> String {
        if let Some(uri) = self.open.get(key) {
            return uri.to_string();
        }
        let path = Path::new(key);
        let below = self
            .idx
            .folders
            .iter()
            .filter_map(|folder| Some((folder, path.strip_prefix(&folder.key).ok()?)))
            .min_by_key(|(_, rest)| rest.components().count());
        let Some((folder, rest)) = below else {
            return path_uri(path);
        };
        let mut uri = folder.uri.trim_end_matches('/').to_string();
        for part in rest.components() {
            uri.push('/');
            escape(&mut uri, &part.as_os_str().to_string_lossy());
        }
        uri
    }
}

/// The kind of a fix for one diagnostic, and of the one action that applies
/// every safe fix to the document. The second is named for this server, as
/// `source.fixAll.eslint` is for its: a person lists it under
/// `editor.codeActionsOnSave` to have exactly these fixes run on save.
const QUICK_FIX: &str = "quickfix";
const FIX_ALL: &str = "source.fixAll.q-lint";

/// Whether a kind the client asks for (`context.only`) takes in `kind`. Kinds
/// are hierarchical, a dot at a time: `source` and `source.fixAll` each ask
/// for `source.fixAll.q-lint`, and `source.fixAllOrNothing` does not.
fn asks_for(only: &str, kind: &str) -> bool {
    kind.strip_prefix(only)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
}

/// The code actions for a request: the quick fixes for the diagnostics it
/// carries, and - only when asked for by kind - the fix-all action.
///
/// WITHOUT `context.only`, QUICK FIXES AND NOTHING ELSE. That request is the
/// lightbulb's, made as the cursor moves, about the diagnostics at one range.
/// A fix-all there is about neither: it would run every fix over the document
/// on each of those requests, to offer what VS Code leaves out of that menu
/// anyway (a `source` action is shown under Source Action, which asks by
/// kind), and what a client that does show everything already has as Format
/// Document - the same edit. So it is returned to a client that names it,
/// `source.fixAll` or `source` in `only`, which is what
/// `editor.codeActionsOnSave` and the Source Action menu both do.
fn code_actions(
    params: &Value,
    docs: &Documents,
    ws: &Workspace,
    policy: &Policy,
    unsafe_fixes: bool,
) -> Vec<Value> {
    let only: Option<Vec<&str>> = params["context"]["only"]
        .as_array()
        .map(|only| only.iter().filter_map(Value::as_str).collect());
    let mut actions = vec![];
    if only.as_ref().is_none_or(|only| {
        only.iter()
            .any(|kind| *kind == QUICK_FIX || kind.starts_with("quickfix."))
    }) {
        actions.extend(quick_fixes(params, docs, ws, policy, unsafe_fixes));
    }
    if only
        .as_ref()
        .is_some_and(|only| only.iter().any(|kind| asks_for(kind, FIX_ALL)))
    {
        actions.extend(fix_all_action(params, docs, ws, policy));
    }
    actions
}

/// The fixes for the diagnostics a request carries, and after them, for each
/// of those diagnostics, the edit that accepts it instead: `/ noqa: CODE` on
/// its line. That one is offered wherever such a comment would be read as
/// one (`suppression_for` refuses where it would not), fix or no fix, and
/// never as the preferred action: the fix is what the finding asks for, and
/// silencing it is a decision nobody should make with a keystroke meant for
/// something else. Once for a line and a code, however many of the
/// diagnostics are that code on that line: one comment accepts them all, and
/// the action says so by listing them.
fn quick_fixes(
    params: &Value,
    docs: &Documents,
    ws: &Workspace,
    policy: &Policy,
    unsafe_fixes: bool,
) -> Vec<Value> {
    let uri = uri_of(&params["textDocument"]);
    let Some(source) = docs.get(&uri) else {
        return vec![];
    };
    if !is_q_uri(&uri) {
        return vec![];
    }
    let path = path_of(&uri);
    let Some(context) = params["context"]["diagnostics"].as_array() else {
        return vec![];
    };
    let mut actions = vec![];
    let mut suppressions: Vec<Value> = vec![];
    // Every finding that has a fix, the editor-only ones included unless the
    // client turned them off: here a person sees each edit and accepts it or
    // not.
    let lines = Lines::new(source);
    let asked_about: Vec<(Finding, &Value)> = policy
        .lint(source, &path, ws)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|finding| {
            let current = diagnostic(&finding, &lines);
            let client_diagnostic = context.iter().find(|d| {
                d["code"] == current["code"]
                    && d["range"]["start"] == current["range"]["start"]
                    && d["message"] == current["message"]
            })?;
            Some((finding, client_diagnostic))
        })
        .collect();
    // For them all at once: a selection of the whole of a long file asks
    // about every finding in it, and each would mask the file again.
    let accepted = suppressions_for(asked_about.iter().map(|(finding, _)| finding), source);
    for ((finding, client_diagnostic), suppression) in asked_about.iter().zip(accepted) {
        // The edit's range comes from the fix, not from the diagnostic. The
        // two coincide for an operator swapped in place, but `f x` becomes
        // `f[x]` by replacing the whole application while the diagnostic
        // underlines only the name.
        let action = |fix: Fix| {
            let range = json!({
                "start": lines.json(fix.start),
                "end": lines.json(fix.end),
            });
            let mut changes = serde_json::Map::new();
            changes.insert(
                uri.clone(),
                json!([{"range": range, "newText": fix.replacement}]),
            );
            json!({
                "title": fix.title,
                "kind": QUICK_FIX,
                "diagnostics": [client_diagnostic],
                "edit": {"changes": changes},
            })
        };
        actions.extend(
            fix_for(finding, source)
                .filter(|f| f.batch_safe || unsafe_fixes)
                .map(action),
        );
        if let Some(suppression) = suppression.map(action) {
            match suppressions
                .iter_mut()
                .find(|s| s["edit"] == suppression["edit"])
            {
                Some(same) => same["diagnostics"]
                    .as_array_mut()
                    .expect("made above")
                    .push((*client_diagnostic).clone()),
                None => suppressions.push(suppression),
            }
        }
    }
    actions.extend(suppressions);
    actions
}

/// Every safe fix at once, as one action of kind `source.fixAll.q-lint`: the
/// edit Format Document makes, for an editor where something else formats q
/// or nothing does. `format` computes it, so the two cannot differ - and
/// there is no action, as there are no edits, for a buffer with nothing to
/// fix, one whose brackets or strings do not close, or one that is not open
/// or not q. Not subject to `format.enable`: that setting says whether this
/// server is a formatter, and this action runs only where a person named it.
fn fix_all_action(
    params: &Value,
    docs: &Documents,
    ws: &Workspace,
    policy: &Policy,
) -> Option<Value> {
    let edits = format(params, docs, ws, policy);
    if edits.is_empty() {
        return None;
    }
    let mut changes = serde_json::Map::new();
    changes.insert(uri_of(&params["textDocument"]), json!(edits));
    Some(json!({
        "title": "Apply every safe q-lint fix",
        "kind": FIX_ALL,
        "edit": {"changes": changes},
    }))
}

/// What there is to fold in an open q document, as the lines a client
/// counts: `folds`' pairs, less any that start and end on one line, and one
/// to a line - the widest, since the rest on that line could only be folded
/// with it, and VS Code drops all but the first it is given. A document that
/// is not open or not q has none: an empty list. One whose brackets do not
/// close has the last good version's that `Carry` keeps, and none when it
/// has never closed since it was opened.
fn folding_ranges(params: &Value, docs: &Documents, kept: &Kept) -> Vec<Value> {
    let uri = uri_of(&params["textDocument"]);
    let Some(source) = docs.get(&uri).filter(|_| is_q_uri(&uri)) else {
        return vec![];
    };
    if balanced(source) {
        return folds_in(source);
    }
    // Brackets that do not close have no folds of their own; those of the
    // last version that closed stand where their lines do (`Carry`).
    let Some((good, carry)) = kept
        .get(&uri)
        .and_then(|good| Some((good, Carry::new(&good.text, source)?)))
    else {
        return vec![];
    };
    folds_in(&good.text)
        .into_iter()
        .filter_map(|mut range| {
            let start = range["startLine"].as_u64()? as usize;
            let end = range["endLine"].as_u64()? as usize;
            let (start, end) = carry.lines(start, end)?;
            range["startLine"] = json!(start);
            range["endLine"] = json!(end);
            Some(range)
        })
        .collect()
}

/// `source`'s folds as ranges of lines, one to a line.
fn folds_in(source: &str) -> Vec<Value> {
    let lines = Lines::new(source);
    let mut ranges: Vec<Value> = vec![];
    let mut last_start = None;
    // In source order, so of two that start on a line the outer comes first.
    for fold in folds(source) {
        let (start, end) = (lines.position(fold.start).0, lines.position(fold.end).0);
        if start >= end || last_start == Some(start) {
            continue;
        }
        last_start = Some(start);
        let mut range = json!({"startLine": start, "endLine": end});
        if fold.comment {
            range["kind"] = json!("comment");
        }
        ranges.push(range);
    }
    ranges
}

/// The edits "Format document" makes: the safe fixes `--fix` applies, to the
/// open buffer, under the same policy as its diagnostics. At most one edit,
/// from the first byte that changed to the last, and none at all when nothing
/// would - a document that is not open or not q, a broken structure, a
/// configuration that cannot be read, or nothing to fix.
fn format(params: &Value, docs: &Documents, ws: &Workspace, policy: &Policy) -> Vec<Value> {
    let uri = uri_of(&params["textDocument"]);
    let path = path_of(&uri);
    // A document whose brackets or strings do not close gets no edits, even
    // with QE001 deselected: the fixes would read its structure wrong (#422).
    let Some(source) = docs
        .get(&uri)
        .filter(|source| is_q_uri(&uri) && balanced(source))
    else {
        return vec![];
    };
    // `false`: formatting never applies an editor-only fix, whatever flags
    // the server was started with.
    let Ok(fixed) = fix_all(source, false, |text| policy.lint(text, &path, ws)) else {
        return vec![];
    };
    let Some(edit) = whole_edit(source, &fixed.text) else {
        return vec![];
    };
    let lines = Lines::new(source);
    vec![json!({
        "range": {"start": lines.json(edit.start), "end": lines.json(edit.end)},
        "newText": edit.replacement,
    })]
}

/// Take a document's new text: index it, lint it, push its diagnostics - and
/// when what it defines changed, lint the other open documents again, since a
/// name it now defines (or no longer does) can change their findings.
#[allow(clippy::too_many_arguments)]
fn publish(
    writer: &mut impl Write,
    docs: &mut Documents,
    unsaved: &Unsaved,
    kept: &mut Kept,
    idx: &mut Index,
    uri: String,
    text: String,
    policy: &Policy,
    opts: &Options,
) -> Result<(), String> {
    let path = path_of(&uri);
    let changed = is_q_uri(&uri) && idx.set(&path, &text);
    docs.insert(uri.clone(), text);
    diagnose(writer, &uri, &docs[&uri], kept, &idx.ws, policy, opts)?;
    if changed {
        relint(writer, docs, unsaved, kept, idx, Some(&uri), policy, opts)?;
    }
    Ok(())
}

/// Lint every open document but `except` again - and but those `unsaved`:
/// with `lint.run: "onSave"` a buffer is linted only when saved, and another
/// file's change does not lint its unsaved text either (#550).
#[allow(clippy::too_many_arguments)]
fn relint(
    writer: &mut impl Write,
    docs: &Documents,
    unsaved: &Unsaved,
    kept: &mut Kept,
    idx: &Index,
    except: Option<&str>,
    policy: &Policy,
    opts: &Options,
) -> Result<(), String> {
    for (uri, text) in docs {
        if Some(uri.as_str()) != except && !unsaved.contains(uri) {
            diagnose(writer, uri, text, kept, &idx.ws, policy, opts)?;
        }
    }
    Ok(())
}

/// Lint one document and push its diagnostics.
fn diagnose(
    writer: &mut impl Write,
    uri: &str,
    text: &str,
    kept: &mut Kept,
    ws: &Workspace,
    policy: &Policy,
    opts: &Options,
) -> Result<(), String> {
    let path = path_of(uri);
    // Only q source. A client may open anything - a `.k` file, a console
    // buffer, an untitled scratch, a `.txt` - and hand it to whichever server
    // claims the language. The rules here describe q and say nothing true
    // about k or about a REPL transcript, so a document that is not a `.q`
    // file on disk gets an empty diagnostic list: that clears anything stale without
    // asserting something about a file this linter cannot read.
    let findings = if is_q_uri(uri) {
        // Lenient, so this cannot fail: a configuration it cannot read is
        // reported once on stderr and the defaults govern its files.
        guarded(|| policy.lint(text, &path, ws).unwrap_or_default())
    } else {
        Ok(vec![])
    };
    // A rule that panicked leaves nothing true to report, so the document
    // gets one diagnostic saying so, at its start, until an edit gets past it.
    let findings = match findings {
        Ok(findings) => findings,
        Err(panic) => {
            let failed = json!({
                "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}},
                "severity": 1,
                "source": "q-lint",
                "message": format!(
                    "qlinter failed on this document and reports nothing else for it: {panic}. \
                     This is a bug in qlinter."
                ),
            });
            return send(
                writer,
                json!({"method": "textDocument/publishDiagnostics",
                       "params": {"uri": uri, "diagnostics": [failed]}}),
            );
        }
    };
    let lines = Lines::new(text);
    let mut diagnostics: Vec<Value> = findings
        .iter()
        .map(|f| {
            let mut d = diagnostic(f, &lines);
            if let Some(level) = opts.severity_of(&f.code) {
                d["severity"] = json!(level);
            }
            d
        })
        .collect();
    // A file whose structure is broken reports that alone (`lint_selecting`),
    // which while a call or a string is being typed is every keystroke: the
    // rest of the Problems panel went blank and came back as the bracket
    // closed. So the rest is carried over from the last version that did
    // close, where it still stands (`Carry`) - and a version that closes is
    // the next one to carry from.
    if is_q_uri(uri) {
        if matches!(findings.as_slice(), [only] if only.code == "QE001") {
            if let Some(good) = kept.get(uri)
                && let Some(carry) = Carry::new(&good.text, text)
            {
                diagnostics.extend(good.diagnostics.iter().filter_map(|d| {
                    let (start, end) = (&d["range"]["start"]["line"], &d["range"]["end"]["line"]);
                    let (start, end) =
                        carry.lines(start.as_u64()? as usize, end.as_u64()? as usize)?;
                    let mut d = d.clone();
                    d["range"]["start"]["line"] = json!(start);
                    d["range"]["end"]["line"] = json!(end);
                    Some(d)
                }));
            }
        } else if balanced(text) {
            let good = Good {
                text: text.to_string(),
                diagnostics: diagnostics.clone(),
            };
            kept.insert(uri.to_string(), good);
        }
    }
    send(
        writer,
        json!({"method": "textDocument/publishDiagnostics",
               "params": {"uri": uri, "diagnostics": diagnostics}}),
    )
}

/// One finding as an LSP diagnostic.
///
/// The two coordinate systems differ in both ways they can: findings are
/// 1-based and LSP is 0-based, and LSP counts UTF-16 code units rather than
/// characters or bytes. Getting the second wrong is invisible in ASCII source
/// and misplaces every marker after the first non-ASCII character in a
/// comment, which is exactly the kind of bug that ships.
///
/// And they count lines differently. A finding's line is q's, which ends a
/// line only at `\n`; an LSP client also ends one at a lone `\r`. So a
/// finding is turned back into the byte offset it names, and that offset
/// into the client's line and character.
///
/// `lines` is built once per document, not once per finding: rebuilding it
/// here made a file with many findings quadratic to publish (#540).
fn diagnostic(f: &Finding, lines: &Lines) -> Value {
    let line = f.line.saturating_sub(1);
    let end_line = f.end_line.map_or(line, |l| l.saturating_sub(1));
    // No column means the rule found a line, not a span. Underlining from the
    // first non-blank character to the end of the line is what a reader means
    // by "this line": starting at 0 would decorate the indentation, and an
    // empty range would show nothing at all in some clients.
    let start = match f.column {
        Some(c) => lines.q_offset(line, c.saturating_sub(1)),
        None => {
            let text = lines.q_line(line);
            lines.q_offset(line, 0) + text.len() - text.trim_start().len()
        }
    };
    let end = match f.end_column {
        Some(c) => lines.q_offset(end_line, c.saturating_sub(1)),
        None => lines.q_offset(end_line, 0) + lines.q_line(end_line).len(),
    };
    let mut d = json!({
        "range": {
            "start": lines.json(start),
            "end": lines.json(end.max(start)),
        },
        "severity": severity(&f.severity),
        "code": f.code,
        "source": f.source,
        "message": f.detail,
    });
    // `Unnecessary` is what makes an editor fade a name, the way unused
    // Python is faded. Only where the finding spans exactly the name: on a
    // line-wide range it would fade the code around it too.
    if matches!(f.code.as_str(), "QF016" | "QF017") && f.end_column.is_some() {
        d["tags"] = json!([DIAGNOSTIC_TAG_UNNECESSARY]);
    }
    // What makes the code a link in a Problems panel: the rule's row in the
    // generated rules document, which says what `--explain` would.
    if let Some(href) = rule_url(&f.code) {
        d["codeDescription"] = json!({"href": href});
    }
    d
}

const DIAGNOSTIC_TAG_UNNECESSARY: i64 = 1;

fn severity(name: &str) -> i64 {
    match name {
        "error" => 1,
        "information" | "info" => 3,
        "hint" => 4,
        _ => 2,
    }
}

/// Where each line starts, as an LSP client counts lines: the protocol ends
/// one at `\n`, at `\r\n`, and at a lone `\r`. Every position this server
/// sends - diagnostics, code actions, semantic tokens - goes through it, so
/// none of them is a line high after a stray carriage return. A code
/// action's diagnostics are matched against ranges made here, and the one
/// position a client sends - where the cursor is, for navigation - comes
/// back through `offset`.
struct Lines<'a> {
    source: &'a str,
    starts: Vec<usize>,
    /// Where each line starts as q counts them - ended by `\n` alone - which
    /// is how a finding names its line.
    q_starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    fn new(source: &'a str) -> Self {
        let bytes = source.as_bytes();
        let mut starts = vec![0];
        let mut q_starts = vec![0];
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' || b == b'\r' && bytes.get(i + 1) != Some(&b'\n') {
                starts.push(i + 1);
            }
            if b == b'\n' {
                q_starts.push(i + 1);
            }
        }
        Lines {
            source,
            starts,
            q_starts,
        }
    }

    /// A byte offset as the line and UTF-16 character a client addresses it
    /// by.
    fn position(&self, byte: usize) -> (usize, usize) {
        let byte = byte.min(self.source.len());
        let line = self.starts.partition_point(|&s| s <= byte) - 1;
        (line, utf16_len(&self.source[self.starts[line]..byte]))
    }

    fn json(&self, byte: usize) -> Value {
        let (line, character) = self.position(byte);
        json!({"line": line, "character": character})
    }

    /// The byte offset of a position a client sends: the 0-based `line` as
    /// LSP counts lines, and `character` UTF-16 code units into it. A
    /// character past the line's end is its end, and a line past the last
    /// the end of the text (LSP 3.17, "Position").
    fn offset(&self, line: usize, character: usize) -> usize {
        let Some(&start) = self.starts.get(line) else {
            return self.source.len();
        };
        let rest = &self.source[start..];
        let text = &rest[..rest.find(['\n', '\r']).unwrap_or(rest.len())];
        let mut units = 0;
        for (i, c) in text.char_indices() {
            if units >= character {
                return start + i;
            }
            units += c.len_utf16();
        }
        start + text.len()
    }

    /// Each line as a client counts them, with its line ending.
    fn texts(&self) -> Vec<&'a str> {
        let ends = self
            .starts
            .iter()
            .skip(1)
            .copied()
            .chain([self.source.len()]);
        self.starts
            .iter()
            .zip(ends)
            .map(|(&start, end)| &self.source[start..end])
            .collect()
    }

    /// The text of a 0-based line as q counts lines, less its line ending.
    fn q_line(&self, line: usize) -> &'a str {
        let Some(&start) = self.q_starts.get(line) else {
            return "";
        };
        let end = self
            .q_starts
            .get(line + 1)
            .map_or(self.source.len(), |&next| next - 1);
        let text = &self.source[start..end];
        text.strip_suffix('\r').unwrap_or(text)
    }

    /// The byte offset of a finding's position: the 0-based `line` as q
    /// counts lines, and `column` UTF-16 code units into it, which is how a
    /// finding measures one. A column past the line's end is its end.
    fn q_offset(&self, line: usize, column: usize) -> usize {
        let Some(&start) = self.q_starts.get(line) else {
            return self.source.len();
        };
        let text = self.q_line(line);
        let mut units = 0;
        for (i, c) in text.char_indices() {
            if units >= column {
                return start + i;
            }
            units += c.len_utf16();
        }
        start + text.len()
    }
}

/// Which lines of a document's last good text still stand in its text now,
/// a statement of which does not close, and where they are.
///
/// WHY CARRY OVER, AND NOT LINT WHAT STILL PARSES
///
/// Linting the statements around the broken one would need that statement
/// cut out, and every rule after it would then read a file in which what it
/// defines is gone - a name it assigns undefined further down, a load it
/// makes not made. Those are findings at true positions saying false things.
/// The last good results said true things about lines that have not changed
/// since, and are wrong only where an edit has reached, which the text says.
///
/// So a line is carried when it is unchanged - in the run of lines both
/// texts start with or the run both end with, shifted by the lines added or
/// removed between - and it is not in the statement that does not close
/// (`broken_statement`), whose results nothing can vouch for. A diagnostic or
/// a fold is carried only when every line it spans is, so none lands on a
/// line other than its own. The trade is staleness: a finding an unchanged
/// line owes to the statement being typed - a name it defined - waits for
/// the statement to close before it goes.
struct Carry {
    /// The lines both texts start with.
    head: usize,
    /// Where the lines both texts end with begin, in the old text and now.
    old_tail: usize,
    new_tail: usize,
    /// The lines of the statement that does not close, now.
    broken: std::ops::Range<usize>,
}

impl Carry {
    /// `None` when `new` has no broken statement, and nothing to carry
    /// over for.
    fn new(old: &str, new: &str) -> Option<Self> {
        let broken = broken_statement(new)?;
        let (before, after) = (Lines::new(old), Lines::new(new));
        let (a, b) = (before.texts(), after.texts());
        let head = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
        let tail = a[head..]
            .iter()
            .rev()
            .zip(b[head..].iter().rev())
            .take_while(|(x, y)| x == y)
            .count();
        let first = after.position(broken.start).0;
        let last = after.position(broken.end.max(broken.start + 1) - 1).0;
        Some(Carry {
            head,
            old_tail: a.len() - tail,
            new_tail: b.len() - tail,
            broken: first..last + 1,
        })
    }

    /// Where the old lines `first` to `last` are now, when every one of them
    /// is unchanged and none is in the broken statement.
    fn lines(&self, first: usize, last: usize) -> Option<(usize, usize)> {
        let (first, last) = if last < self.head {
            (first, last)
        } else if first >= self.old_tail {
            let shift = |line: usize| line - self.old_tail + self.new_tail;
            (shift(first), shift(last))
        } else {
            return None;
        };
        (last < self.broken.start || first >= self.broken.end).then_some((first, last))
    }
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// A URI as a filesystem path: `file_path`'s, or the URI unchanged when it
/// is not `file:` - a key for an untitled buffer, never a file to read.
fn path_of(uri: &str) -> String {
    file_path(uri).unwrap_or_else(|| uri.to_string())
}

/// Whether `uri` is a `.q` file on disk, the only document linted, indexed
/// or coloured. An untitled buffer, or an old revision another scheme names
/// (`fugitive:`, `git:`), is not one whatever its name ends in (#545).
fn is_q_uri(uri: &str) -> bool {
    file_path(uri).is_some_and(|path| is_q_path(&path))
}

/// A `file:` URI as a filesystem path, and `None` for any other scheme.
///
/// Hand-rolled rather than pulling in a URL crate: the only scheme an editor
/// sends for a document on disk is `file:`, and the only transformation that
/// matters is percent-decoding - without it every path containing a space
/// arrives as `%20` and the filename-based rules see a file that does not
/// exist.
fn file_path(uri: &str) -> Option<String> {
    // A scheme is case-insensitive (RFC 3986 3.1): `FILE:` is `file:`.
    let rest = &uri[uri
        .get(..5)
        .filter(|s| s.eq_ignore_ascii_case("file:"))?
        .len()..];
    let rest = match rest.strip_prefix("//") {
        // Strip the empty authority: file:///a/b has a host of "", so the
        // path begins at the third slash. RFC 8089 makes `localhost` the
        // same host, and file://localhost/a/b the same file (#425).
        Some(rest) => match rest.get(..10) {
            Some(host) if host.eq_ignore_ascii_case("localhost/") => &rest[10..],
            _ => rest.strip_prefix('/').unwrap_or(rest),
        },
        // RFC 8089's form with no authority at all: file:/a/b (#546).
        None => rest.strip_prefix('/')?,
    };
    // Percent-escapes decode to bytes, and the bytes are UTF-8: `%C3%A9` is
    // one `é`. Pushing each byte as a char read it as two Latin-1 ones, and
    // a workspace under a folder with a non-ASCII name lost every path.
    let mut bytes = Vec::with_capacity(rest.len());
    let raw = rest.as_bytes();
    let mut i = 0;
    // An escape is `%` and two hex digits, read as bytes: slicing the str
    // there panicked when a multi-byte character followed the `%`, and a
    // `%` that starts no escape is kept as it is.
    let hex = |b: u8| (b as char).to_digit(16);
    while i < raw.len() {
        if raw[i] == b'%'
            && let (Some(hi), Some(lo)) = (
                raw.get(i + 1).copied().and_then(hex),
                raw.get(i + 2).copied().and_then(hex),
            )
        {
            bytes.push((hi * 16 + lo) as u8);
            i += 3;
            continue;
        }
        bytes.push(raw[i]);
        i += 1;
    }
    let decoded = String::from_utf8_lossy(&bytes).into_owned();
    // A Windows path is a drive letter, not a root: VS Code sends
    // `file:///c%3A/Users/...`, and `/c:/Users/...` is no path at all.
    Some(if re_drive(&decoded) {
        decoded
    } else {
        format!("/{decoded}")
    })
}

fn re_drive(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// One spelling per file, for the index: the editor's URI and the folder scan
/// reach the same file as `c:/a/b.q` and `C:\a\b.q` on Windows, through a
/// symlinked folder (`/tmp` and `/private/tmp`), or in another case on a
/// case-insensitive disk, and two keys for one file would count its own
/// definitions as another file's (#528). The real path where the file
/// exists, or the real path of the nearest folder above it that does - a
/// deleted file, or one in a deleted folder, is still forgotten under the
/// key it was read under. A key is itself a path that gives itself back:
/// on Windows it is `\\?\C:\...`, which a fallback that only looked one
/// folder up turned into `//?/C:/...` once the folder was gone (#543).
fn file_key(path: &str) -> String {
    let given = std::path::Path::new(path);
    if let Some(real) = given.ancestors().find_map(|dir| {
        let real = std::fs::canonicalize(dir).ok()?;
        // `join("")` would add a trailing separator.
        Some(match given.strip_prefix(dir).ok()? {
            rest if rest.as_os_str().is_empty() => real,
            rest => real.join(rest),
        })
    }) {
        return real.to_string_lossy().into_owned();
    }
    // Only on Windows is a backslash a separator; elsewhere it can be part of
    // a file name.
    let path = if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.to_string()
    };
    if re_drive(&path) {
        let mut chars = path.chars();
        let drive = chars.next().unwrap().to_ascii_lowercase();
        format!("{drive}{}", chars.as_str())
    } else {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_escapes_decode_and_other_schemes_pass_through() {
        assert_eq!(path_of("file:///tmp/a%20b/c.q"), "/tmp/a b/c.q");
        assert_eq!(path_of("file:///tmp/plain.q"), "/tmp/plain.q");
        assert_eq!(path_of("file://localhost/tmp/plain.q"), "/tmp/plain.q");
        assert_eq!(path_of("file://LOCALHOST/c%3A/a.q"), "c:/a.q");
        assert_eq!(path_of("untitled:Untitled-1"), "untitled:Untitled-1");
        // A real path on Windows is verbatim; its URI is the editor's.
        let p = std::path::Path::new;
        assert_eq!(path_uri(p(r"\\?\C:\a b\c")), "file:///C:/a%20b/c");
        assert_eq!(path_uri(p(r"\\?\UNC\host\share\c")), "file://host/share/c");
        assert_eq!(path_uri(p("/tmp/a b")), "file:///tmp/a%20b");
        // No authority, and the scheme in any case, are the same file (#546).
        assert_eq!(path_of("file:/tmp/plain.q"), "/tmp/plain.q");
        assert_eq!(path_of("FILE:///tmp/plain.q"), "/tmp/plain.q");
        assert_eq!(path_of("File:/c%3A/a.q"), "c:/a.q");
        assert_eq!(file_path("file:tmp/a.q"), None);
        // Escapes are UTF-8 bytes, not one character each.
        assert_eq!(path_of("file:///Users/Jos%C3%A9/a.q"), "/Users/José/a.q");
        // A Windows drive is not under a root.
        assert_eq!(path_of("file:///c%3A/Users/a.q"), "c:/Users/a.q");
        assert_eq!(path_of("file:///C:/Users/a.q"), "C:/Users/a.q");
        // A `%` that starts no escape is kept, even before a multi-byte
        // character, a sign, or the end of the URI.
        assert_eq!(
            path_of("file:///tmp/50%\u{20ac}off.q"),
            "/tmp/50%\u{20ac}off.q"
        );
        assert_eq!(path_of("file:///tmp/x%+1.q"), "/tmp/x%+1.q");
        assert_eq!(path_of("file:///tmp/a%4"), "/tmp/a%4");
        assert_eq!(path_of("file:///tmp/a%41"), "/tmp/aA");
        // And on Windows the scan's spelling of the same file is the same key.
        if cfg!(windows) {
            assert_eq!(
                file_key("C:\\Users\\a.q"),
                file_key(&path_of("file:///c%3A/Users/a.q"))
            );
        }
    }

    #[test]
    fn positions_are_zero_based_and_counted_in_utf16() {
        // A line whose comment holds a character outside the BMP: one q char,
        // two UTF-16 code units. A marker that counted characters would stop
        // one unit short of the line end.
        let source = "a:1 / \u{1F600}\n";
        let f = Finding::new("x.q", 1, "QP001", "detail".into());
        let d = diagnostic(&f, &Lines::new(source));
        assert_eq!(d["range"]["start"]["line"], 0);
        assert_eq!(d["range"]["end"]["character"], utf16_len("a:1 / \u{1F600}"));
    }

    #[test]
    fn a_finding_per_line_converts_in_linear_time() {
        // One finding on each of 20,000 lines. Rebuilding the line table and
        // rescanning from the start for every finding took minutes here, and
        // 30 s per keystroke in an editor (#540); once per document it is
        // milliseconds.
        let source = "a:1==1\n".repeat(20_000);
        let lines = Lines::new(&source);
        let started = std::time::Instant::now();
        for line in 1..=20_000 {
            let mut f = Finding::new("x.q", line, "QE004", "detail".into());
            f.column = Some(4);
            f.end_column = Some(6);
            let d = diagnostic(&f, &lines);
            assert_eq!(d["range"]["start"]["line"], line - 1);
            assert_eq!(d["range"]["start"]["character"], 3);
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn unused_names_are_tagged_unnecessary_over_exactly_the_name() {
        let source = "f:{[a;b] r:1; a}\n";
        let found = q_lint_rs::lint_in(
            source,
            "x.q",
            q_lint_rs::Profile::Style,
            &Workspace::default(),
        );
        let tagged: Vec<Value> = found
            .iter()
            .map(|f| diagnostic(f, &Lines::new(source)))
            .filter(|d| d["tags"] == json!([DIAGNOSTIC_TAG_UNNECESSARY]))
            .collect();
        let mut spans: Vec<(&str, u64, u64)> = tagged
            .iter()
            .map(|d| {
                (
                    d["code"].as_str().unwrap(),
                    d["range"]["start"]["character"].as_u64().unwrap(),
                    d["range"]["end"]["character"].as_u64().unwrap(),
                )
            })
            .collect();
        spans.sort();
        // `b` is the unused parameter at column 6, `r` the unused local at 9.
        assert_eq!(spans, vec![("QF016", 6, 7), ("QF017", 9, 10)]);
    }

    #[test]
    fn semantic_tokens_mark_calls_and_parameter_reads() {
        // f is called on line 1 and its parameter a read in its body; the
        // local r that shadows nothing is left to the grammar. Line 2 calls f
        // inside a lambda whose own parameter is also named f, so that read
        // is the parameter, not the function.
        let source = "f:{[a] a+1}\nr:f[1]\ng:{[f;b] f+b}\n";
        let data = encode_tokens(source, &Workspace::default());
        let tokens: Vec<&[u32]> = data.chunks(5).collect();
        assert_eq!(
            tokens,
            vec![
                &[0, 7, 1, 1, 0][..], // a, line 0 col 7
                &[1, 2, 1, 0, 0][..], // f, line 1 col 2: the call
                &[1, 9, 1, 1, 0][..], // f, line 2 col 9: g's parameter
                &[0, 2, 1, 1, 0][..], // b, col 11
            ]
        );
    }

    #[test]
    fn a_panic_is_contained_and_named() {
        assert_eq!(guarded(|| 1), Ok(1));
        assert_eq!(
            guarded(|| -> i32 { panic!("rule {} broke", 7) }),
            Err("rule 7 broke".into())
        );
        assert_eq!(
            guarded(|| -> i32 { panic!("static") }),
            Err("static".into())
        );
    }

    #[test]
    fn the_scan_stops_after_its_bound_on_entries_of_any_kind() {
        // The root holds 50 other files and a directory whose `.q` file the
        // scan reaches only after them; bounded at 10 entries, it never
        // does. Counted in `.q` files alone, a tree of anything else was
        // walked to the end (#793).
        let dir = tempfile::tempdir().unwrap();
        for i in 0..50 {
            std::fs::write(dir.path().join(format!("{i}.txt")), "").unwrap();
        }
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/a.q"), "cfg:1\n").unwrap();
        let policy = Policy::new(
            crate::config::Overrides {
                profile: None,
                default_profile: "style",
                layer: Layer::default(),
                exclude: vec![],
                config: None,
                isolated: true,
            },
            true,
        );
        let scanned = |max_entries| {
            let mut idx = Index {
                roots: vec![dir.path().to_string_lossy().into_owned()],
                enabled: true,
                ..Index::default()
            };
            idx.scan_within(&policy, MAX_FILES, max_entries);
            idx.files.len()
        };
        assert_eq!(scanned(10), 0);
        assert_eq!(scanned(MAX_ENTRIES), 1);
    }

    #[test]
    fn severity_names_map_to_the_protocols_numbers() {
        assert_eq!(severity("error"), 1);
        assert_eq!(severity("warning"), 2);
        assert_eq!(severity("anything else"), 2);
    }
}
