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
//! And what a client asks before it talks to a q process, in `live`, also
//! under `experimental`: `q-lint/tests`, the test functions to run,
//! `q-lint/globalAt`, the global a position names, and
//! `q-lint/unresolvedNames`, the globals a document reads that no workspace
//! file defines, `q-lint/defined`, which of some names the workspace
//! defines, and `q-lint/argumentSlot`, the argument of a call the cursor is
//! in. The client runs and asks; this server reads.
//!
//! Around those: each diagnostic links its code to that rule's row in the
//! reference (`codeDescription`), and one that points at a second place -
//! the first of two names that collide - carries it when asked (`related`);
//! beside its fix, or without one, a finding
//! has a quick fix that accepts it with `/ noqa: CODE` on its line, offered
//! only where the linter would read that comment (`suppression_for`);
//! textDocument/codeAction also answers `source.fixAll.q-lint` with the
//! formatting edit, for `editor.codeActionsOnSave` in an editor where this
//! server is not the formatter, and `source.organizeImports.q-lint` with
//! the `\l` lines of each run sorted, deduped and grouped; a finding can be
//! accepted for its whole file with `/ qlinter: noqa: CODE`;
//! `q-lint/formatChangedLines` formats only the lines a client says changed;
//! and textDocument/foldingRange folds the brackets and block comments that
//! span lines; textDocument/selectionRange, when asked for, grows a
//! selection through the same brackets to the statement (`selection`).
//!
//! A workspace index: every `.q` file under the workspace folders is read at
//! startup - never run - for the global names it defines and reads, and
//! kept current from open buffers, closes, and
//! workspace/didChangeWatchedFiles. With `lint.scope: "workspace"` its files
//! report as the open ones do, linted while the client waits for nothing
//! (`scope`). A name
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
//! One layout is offered, because it needs no parser: a long qSQL query
//! split a clause to a line (`q_lint_rs::qsql_layouts`). It replaces only
//! blanks, before `by`, `from` and the `where` after `from` and after a
//! comma that separates items, and leaves alone any query where a newline
//! there could change what q reads - one with a comment in it, say. It is a
//! code action on the query at the cursor, and joins Format Document only
//! when `qsqlLayout.onFormat` asks it to; never the fix-all action, which
//! is the safe fixes and nothing else.
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
    FileIndex, Finding, Fix, References, TokenKind, Workspace, balanced, broken_statement,
    file_suppression_for, fix_all, fix_lines, fixes_each, folds, functional_to_qsql,
    organise_loads, qsql_layout_at, qsql_layouts, qsql_to_functional, rule_url, semantic_tokens_in,
    suppressions_for, whole_edit,
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
mod inventory;
mod live;
mod navigate;
mod paths;
mod relate;
mod related;
mod scope;
mod selection;

/// Open documents, by URI. The editor is the authority on their contents from
/// didOpen until didClose, so nothing here reads from disk.
type Documents = HashMap<String, String>;

/// Open documents edited since they were last linted, which with
/// `lint.run: "onSave"` is since they were last saved.
type Unsaved = HashSet<String>;

/// Of those, the ones whose edits changed what the workspace defines: the
/// index took them as they were typed, and the other open documents are
/// linted again for them when they are saved.
type Redefined = HashSet<String>;

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
    /// Bumped whenever what the workspace defines changes, or where a file
    /// is loaded, which is what makes the open documents' semantic tokens
    /// stale.
    generation: u64,
    /// Bumped whenever the names some file reads change, which is what
    /// makes a count of references stale.
    reads: u64,
    /// Bumped whenever the parameters some definition declares change, which
    /// is what makes a parameter hint at a call stale though no name is
    /// defined or dropped (#1361). Only counted while `hinted`, when the
    /// client redraws hints on request: it is one more reading of each file.
    signatures: u64,
    hinted: bool,
    /// While set - a client that redraws reference counts on request - each
    /// file's reads are tallied, every one and not just each name, since a
    /// count changes with a read more of a name already read (#2175).
    counted: bool,
    /// What may be read from disk: `.q` files under these folders, less
    /// those `exclude` names - and nothing at all while `enabled` is off,
    /// when only open documents are indexed.
    roots: Vec<String>,
    exclude: Vec<glob::Pattern>,
    enabled: bool,
    /// Each file read from disk by the paths it was read by, as the scan
    /// reached it - a symlink by its own name, not its target's, which is
    /// its key. `qlinter .` lints a link by its name and under the
    /// configuration above it, and so does a workspace-scope lint (#2289).
    /// Each path is kept under `spelling(path)`, so one name reached by two
    /// spellings - the scan's `C:/w\\a.q` and a URI's `C:/w/a.q` on Windows
    /// - is linted and published once, not twice to one URI.
    reached: HashMap<String, std::collections::BTreeMap<String, String>>,
    /// Each workspace folder as the client named it, which is how an answer
    /// names the files under it (`Sources::uri`).
    folders: Vec<Folder>,
    /// The open documents, by key: what `follow` starts from, and whether
    /// one was opened or closed since it last ran.
    opened: HashSet<String>,
    unfollowed: bool,
    /// The files read from disk because an open document loads them, itself
    /// or through another of these, and no workspace folder holds them
    /// (`follow`). Each is `withheld`: found by Go to Definition, hover and
    /// signature help, and defining nothing for the lint, as it defines
    /// nothing for `qlinter .`, which never reads it.
    followed: HashSet<String>,
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
/// And on the files read because an open document loads them from outside
/// every folder (`Index::follow`).
const MAX_FOLLOWED: usize = 1_000;

/// One file in the index: what it defines read alone, what decides where
/// its loaders put that, and the result, which is what `ws` holds.
#[derive(Default)]
struct Indexed {
    own: FileIndex,
    loads: Vec<(String, String)>,
    placement: Placement,
    placed: FileIndex,
    /// What the file reads, for the dependency graph `relate` draws when it
    /// is asked for one. Names and no positions, like the rest - and never
    /// compared, so a read added or dropped relints nothing.
    read: References,
    /// The parameters each definition declares, kept while `Index::hinted`.
    signed: Vec<(String, Vec<String>)>,
    /// Every read of a global, by its name as written and whether it is
    /// implicit, in order - what a reference count counts - kept while
    /// `Index::counted`.
    tally: Vec<(String, bool)>,
    /// An open document the scan would not read - excluded, or under a
    /// directory the walk skips: linted, but what it defines is kept out of
    /// `ws`, so a name only it defines is undefined elsewhere in the editor
    /// as it is in the terminal (#2295).
    withheld: bool,
}

impl Index {
    /// Record what `path` defines. Whether it changed is what tells the
    /// caller other open files need linting again.
    fn set(&mut self, path: &str, text: &str, policy: &Policy) -> bool {
        self.open(path, text, policy) | self.settle()
    }

    /// `put` for an open document, which the scan may have passed by.
    fn open(&mut self, path: &str, text: &str, policy: &Policy) -> bool {
        let withheld = self.withheld(path, policy);
        if is_q_path(path) {
            self.unfollowed |= self.opened.insert(file_key(path));
        }
        self.put(path, text, withheld)
    }

    /// The document at `path` was closed: the disk is the authority on it
    /// again (`reload`), and what only it loaded is no longer followed.
    fn close(&mut self, path: &str, policy: &Policy) -> bool {
        // The files it loaded go when no other document leads to them,
        // whether or not the file itself is one the index still reads.
        self.unfollowed |= self.opened.remove(&file_key(path));
        self.reload(path, policy)
    }

    /// `set`, leaving the placements to the caller's `settle`, so a batch
    /// of files works them out once.
    fn put(&mut self, path: &str, text: &str, withheld: bool) -> bool {
        self.put_keyed(file_key(path), text, withheld)
    }

    /// `put` for the file keyed `path`.
    fn put_keyed(&mut self, path: String, text: &str, withheld: bool) -> bool {
        let own = index(text);
        let read = guarded(|| q_lint_rs::references(text, false)).unwrap_or_default();
        let loads = read.loads.clone();
        let old = self.files.remove(&path);
        self.stale |= old.as_ref().is_none_or(|old| {
            old.loads != loads || old.read.module != read.module || old.read.uses != read.uses
        });
        let tally = if self.counted { tally(text) } else { vec![] };
        if old
            .as_ref()
            .is_none_or(|old| old.read.names != read.names || old.tally != tally)
        {
            self.reads += 1;
        }
        let signed = if self.hinted {
            signatures(text)
        } else {
            vec![]
        };
        if old.as_ref().is_some_and(|old| old.signed != signed) {
            self.signatures += 1;
        }
        let placement = old
            .as_ref()
            .map(|old| old.placement.clone())
            .unwrap_or_default();
        let mut placed = own.clone();
        placement.apply(&mut placed, &read);
        if old.is_none() {
            self.ws.place(Path::new(&path), &placement);
        }
        // What the workspace held of it, and what it holds now: nothing of
        // a withheld one.
        let before = old
            .as_ref()
            .filter(|old| !old.withheld)
            .map(|old| &old.placed);
        let changed = before != (!withheld).then_some(&placed);
        if changed {
            if let Some(old) = old.as_ref().filter(|old| !old.withheld) {
                self.ws.remove(&old.placed);
            }
            if !withheld {
                self.ws.add(&placed);
            }
            self.generation += 1;
        }
        let file = Indexed {
            own,
            loads,
            placement,
            placed,
            read,
            signed,
            tally,
            withheld,
        };
        self.files.insert(path, file);
        changed
    }

    /// Forget `path`, leaving the placements to the caller's `settle`.
    fn forget(&mut self, path: &str) -> bool {
        self.forget_keyed(&file_key(path))
    }

    /// `forget` for the file keyed `key`.
    fn forget_keyed(&mut self, key: &str) -> bool {
        self.reached.remove(key);
        match self.files.remove(key) {
            Some(old) => {
                if !old.withheld {
                    self.ws.remove(&old.placed);
                }
                self.ws.place(Path::new(key), &Placement::default());
                self.generation += 1;
                self.reads += 1;
                self.stale = true;
                true
            }
            None => false,
        }
    }

    /// Work out again where each file's definitions go, when a file's loads
    /// or the set of files changed, and move those that moved - and whether
    /// any file now sits anywhere else. Only a load
    /// under some `\d .a`, or a KDB-X module, which runs in `.m.<module>`,
    /// can put a file anywhere but the root, so without one there is no
    /// graph to build.
    fn settle(&mut self) -> bool {
        // What the open documents load from outside every folder first,
        // since a file read or forgotten there is one more or one fewer to
        // place.
        let generation = self.generation;
        if std::mem::take(&mut self.unfollowed) | self.stale {
            self.follow();
        }
        if !std::mem::take(&mut self.stale) {
            return self.generation != generation;
        }
        let keys: Vec<String> = self.files.keys().cloned().collect();
        let contexts = self
            .files
            .values()
            .any(|f| f.read.module || f.loads.iter().any(|(_, ns)| !ns.is_empty() && ns != "."));
        let placements = if contexts {
            let paths: Vec<std::path::PathBuf> = keys.iter().map(Into::into).collect();
            // A withheld document loads nothing for the others, as it
            // defines nothing for them: `qlinter .` never reads it, so its
            // `\d .a` / `\l lib.q` moves no name of lib.q there (#2825). It
            // is still put where the files that load it say.
            let quiet: HashMap<&String, References> = keys
                .iter()
                .filter(|k| self.files[*k].withheld)
                .map(|k| {
                    let module = self.files[k].read.module;
                    (
                        k,
                        References {
                            module,
                            ..Default::default()
                        },
                    )
                })
                .collect();
            let reads: Vec<_> = keys
                .iter()
                .map(|k| quiet.get(k).unwrap_or(&self.files[k].read))
                .collect();
            let cwds = self.cwds();
            guarded(|| q_lint_rs::graph::placements(&paths, &reads, &cwds))
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
            // Moved, whether or not what it defines moves with it: its reads
            // resolve where it is loaded too, which is what its colours, its
            // parameter hints and the counts of what it reads are drawn
            // from. Only a definition moved counted, and a file that
            // defines nothing kept them stale (#2176).
            changed = true;
            self.ws.place(Path::new(key), &placement);
            let mut placed = file.own.clone();
            placement.apply(&mut placed, &file.read);
            file.placement = placement;
            if placed != file.placed {
                if !file.withheld {
                    self.ws.remove(&file.placed);
                    self.ws.add(&placed);
                }
                file.placed = placed;
            }
        }
        if changed {
            self.generation += 1;
        }
        changed || self.generation != generation
    }

    /// Read each file an open document loads from outside every workspace
    /// folder, and each one those load in turn, and forget the ones no open
    /// document leads to any more. With no folder at all - a single file
    /// opened, as Neovim and Helix open one without a root - or for
    /// `\l ../outside/o.q`, the load's link led to the file and nothing it
    /// defines was known: no definition and no signature (#2964).
    ///
    /// The disk is asked only about the loads of an open document and of a
    /// file read here, and only while the index reads the disk at all. A
    /// file under a folder is the scan's to read, or to pass by.
    fn follow(&mut self) {
        // One the scan has read since, or a document opened since, is no
        // longer here on a load's account.
        let (files, opened) = (&self.files, &self.opened);
        self.followed
            .retain(|key| files.get(key).is_some_and(|f| f.withheld) && !opened.contains(key));
        let mut seen: HashSet<String> = HashSet::new();
        if self.enabled {
            let cwds = self.cwds();
            let roots: Vec<std::path::PathBuf> =
                self.roots.iter().map(|r| file_key(r).into()).collect();
            let mut pending: Vec<String> = self.opened.iter().cloned().collect();
            while let Some(from) = pending.pop() {
                if !seen.insert(from.clone()) {
                    continue;
                }
                let Some(file) = self.files.get(&from) else {
                    continue;
                };
                let loads: Vec<String> = file.loads.iter().map(|(load, _)| load.clone()).collect();
                let cwd = q_lint_rs::graph::start_dir(&cwds, Path::new(&from)).to_path_buf();
                for load in loads {
                    let found = |path: &Path| {
                        let path = path.to_str()?;
                        if self.files.contains_key(path) {
                            return Some(path.to_string());
                        }
                        (is_q_path(path) && Path::new(path).is_file()).then(|| file_key(path))
                    };
                    let targets =
                        q_lint_rs::graph::loaded(Path::new(&from), &load, &cwd, found, |_| vec![]);
                    for key in targets {
                        if !self.files.contains_key(&key) {
                            let outside =
                                !roots.iter().any(|root| Path::new(&key).starts_with(root));
                            if !outside || self.followed.len() >= MAX_FOLLOWED {
                                continue;
                            }
                            let Some((text, _)) = on_disk(&key) else {
                                continue;
                            };
                            self.put_keyed(key.clone(), &text, true);
                            self.followed.insert(key.clone());
                        }
                        if self.followed.contains(&key) {
                            pending.push(key);
                        }
                    }
                }
            }
        }
        let gone: Vec<String> = self
            .followed
            .iter()
            .filter(|key| !seen.contains(*key))
            .cloned()
            .collect();
        for key in gone {
            self.followed.remove(&key);
            self.forget_keyed(&key);
        }
    }

    /// The directories a relative `\l` may be tried against first: each
    /// workspace folder, which is where a q process over this tree is most
    /// likely started, since the source does not say - a file's own folder
    /// for a file in one (`graph::start_dir`, #2045), the current directory
    /// with none. By their real paths, as the files are keyed: a directory
    /// loaded, `\l db`, is found by the files keyed under it, and a folder
    /// opened through a symlink named no such directory (#1366).
    fn cwds(&self) -> Vec<std::path::PathBuf> {
        if self.roots.is_empty() {
            return vec![std::env::current_dir().unwrap_or_default()];
        }
        self.roots
            .iter()
            .map(|root| file_key(root).into())
            .collect()
    }

    /// Forget `path` and, when it was a directory, every file under it but
    /// the open documents, whose buffers still hold their text. A watcher
    /// reports a deleted folder as one event for the folder, not one per
    /// file inside it (#543).
    ///
    /// By the name the event gives it, below the real path of the folder it
    /// was in, which is the key it was read under. `file_key` of the whole
    /// path follows whatever answers to it now, and on a disk that ignores
    /// case lib.q renamed Lib.q still answers to lib.q - as Lib.q, a key
    /// the index does not hold yet, so the old one was never forgotten and
    /// the file was listed twice (#2817). Each is forgotten by its key as
    /// it stands, for the same reason, and a key that is an open document's
    /// by the disk's answer is that document's still.
    fn remove_tree(&mut self, path: &str, docs: &Documents) -> bool {
        let given = Path::new(path);
        let gone = match (given.parent(), given.file_name()) {
            (Some(dir), Some(name)) => Path::new(&file_key(&dir.to_string_lossy())).join(name),
            _ => file_key(path).into(),
        };
        let open: Vec<String> = docs.keys().map(|uri| file_key(&path_of(uri))).collect();
        let under: Vec<String> = self
            .files
            .keys()
            .filter(|k| {
                Path::new(k).starts_with(&gone) && !open.contains(k) && !open.contains(&file_key(k))
            })
            .cloned()
            .collect();
        let mut changed = false;
        for key in under {
            changed |= self.forget_keyed(&key);
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
        match on_disk(path) {
            Some((text, _)) if is_q_path(path) => {
                let key = file_key(path);
                self.reached
                    .entry(key.clone())
                    .or_default()
                    .entry(spelling(path))
                    .or_insert_with(|| path.to_string());
                self.put_keyed(key, &text, false)
            }
            _ => self.forget(path),
        }
    }

    /// The paths the file `key` was read from disk by, or the key itself.
    fn spellings(&self, key: &str) -> Vec<String> {
        match self.reached.get(key) {
            Some(paths) if !paths.is_empty() => paths.values().cloned().collect(),
            _ => vec![key.to_string()],
        }
    }

    /// Whether the scan would have read `path`: index on, under a workspace
    /// folder, in no directory the scan skips, and not excluded.
    fn covers(&self, path: &str, policy: &Policy) -> bool {
        self.enabled && is_q_path(path) && self.reached(path, policy)
    }

    /// Whether `path`, under a workspace folder, is one the configuration
    /// passes by there - `exclude`, or a directory the walk skips - as
    /// `qlinter .` would, whether or not the index is on (#2295). The
    /// editor's own `workspaceIndex.exclude` keeps a closed file out of the
    /// index, not an open one.
    fn withheld(&self, path: &str, policy: &Policy) -> bool {
        let mut under = false;
        for root in &self.roots {
            let root = std::path::Path::new(root);
            if let Some(path) = self.spelled_under(root, path) {
                under = true;
                if !path
                    .ancestors()
                    .take_while(|p| *p != root)
                    .any(|p| skipped(policy, p))
                {
                    return false;
                }
            }
        }
        under && is_q_path(path)
    }

    /// Whether the scan reaches `path` under some workspace folder.
    fn reached(&self, path: &str, policy: &Policy) -> bool {
        self.roots.iter().any(|root| {
            let root = std::path::Path::new(root);
            // The file and each directory above it within the folder,
            // as the scan asks about each before entering it (#795).
            self.spelled_under(root, path).is_some_and(|path| {
                !path
                    .ancestors()
                    .take_while(|p| *p != root)
                    .any(|p| skipped(policy, p) || self.excluded(root, p))
            })
        })
    }

    /// `path` as the scan reaches it under the workspace folder `root`: as
    /// given, when it is spelled under the folder, and otherwise the same
    /// file by its key, below the folder's key - opened in another case, by
    /// its real path under a folder opened through a symlink, or with `C:`
    /// for `c:`. Compared as spelled, a document closed under one spelling
    /// was not covered by a folder given in another, and its definitions
    /// were forgotten until a restart (#2172). The spelling is tried first:
    /// a symlink to a file in the folder is read by the scan (#542), and
    /// its key is where it points.
    fn spelled_under(&self, root: &std::path::Path, path: &str) -> Option<std::path::PathBuf> {
        let given = std::path::Path::new(path);
        if given.starts_with(root) {
            return Some(given.to_path_buf());
        }
        let key = std::path::PathBuf::from(file_key(path));
        let rest = key.strip_prefix(file_key(&root.to_string_lossy())).ok()?;
        Some(if rest.as_os_str().is_empty() {
            root.to_path_buf()
        } else {
            root.join(rest)
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
        self.reached.clear();
        self.ws = Workspace::default();
        self.opened.clear();
        self.followed.clear();
        self.generation += 1;
        if self.enabled {
            self.scan(policy, docs);
        }
        for (uri, text) in docs.iter().filter(|(uri, _)| is_q_uri(uri)) {
            self.open(&path_of(uri), text, policy);
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
        docs: &Documents,
    ) {
        // By the file each names, as the files under them are keyed: a
        // client that spells a folder another way when it removes it - a
        // trailing `/`, a `.` in the path, another case where the disk has
        // none - left it a root, and everything in it indexed (#2962).
        let gone: Vec<String> = removed.iter().map(|r| file_key(r)).collect();
        self.roots.retain(|r| !gone.contains(&file_key(r)));
        self.folders.retain(|f| !gone.contains(&file_key(&f.path)));
        let mut known: Vec<String> = self.roots.iter().map(|r| file_key(r)).collect();
        let added: Vec<String> = added
            .into_iter()
            .filter(|(path, _)| {
                let key = file_key(path);
                let new = !known.contains(&key);
                known.push(key);
                new
            })
            .map(|folder| {
                let path = folder.0.clone();
                self.folders.push(Folder::of(folder));
                path
            })
            .collect();
        // A file no configuration governs is rooted at its own folder.
        policy.set_roots(self.roots.iter().chain(&added));
        let kept: Vec<String> = self.roots.iter().map(|r| file_key(r)).collect();
        for gone in gone {
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
            self.scan(policy, docs);
            self.roots = all;
        }
        self.roots.extend(added);
        self.settle();
    }

    fn scan(&mut self, policy: &Policy, docs: &Documents) {
        self.scan_within(policy, docs, MAX_FILES, MAX_ENTRIES)
    }

    fn scan_within(
        &mut self,
        policy: &Policy,
        docs: &Documents,
        max_files: usize,
        max_entries: usize,
    ) {
        let stack = self.roots.iter().map(|r| (r.into(), r.into())).collect();
        self.walk(policy, docs, stack, max_files, max_entries);
    }

    /// Read every `.q` file under the directory `path`, as the scan would
    /// have: a watcher reports a folder created or moved in as one event for
    /// the folder, not one per file inside it (#1217).
    fn add_tree(&mut self, path: &str, policy: &Policy, docs: &Documents) -> bool {
        let Some((root, dir)) = self.roots.iter().find_map(|root| {
            let root = std::path::PathBuf::from(root);
            let dir = self.spelled_under(&root, path)?;
            Some((root, dir))
        }) else {
            return false;
        };
        if !self.enabled
            || dir
                .ancestors()
                .take_while(|p| *p != root)
                .any(|p| skipped(policy, p) || self.excluded(&root, p))
        {
            return false;
        }
        let changed = self.walk(policy, docs, vec![(root, dir)], MAX_FILES, MAX_ENTRIES);
        changed | self.settle()
    }

    /// Read the `.q` files under each `(folder, directory)` of `stack`, and
    /// whether that changed the index - all but the open documents, whose
    /// text is the client's and never the disk's: a folder created with an
    /// open file in it, by a rename or a checkout, put the disk's text over
    /// the unsaved buffer (#2173).
    fn walk(
        &mut self,
        policy: &Policy,
        docs: &Documents,
        mut stack: Vec<(std::path::PathBuf, std::path::PathBuf)>,
        max_files: usize,
        max_entries: usize,
    ) -> bool {
        let (mut seen, mut visited, mut changed) = (0, 0, false);
        let open: HashSet<String> = docs
            .keys()
            .filter(|uri| is_q_uri(uri))
            .map(|uri| file_key(&path_of(uri)))
            .collect();
        while let Some((root, dir)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                if visited > max_entries {
                    return changed;
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
                    let path = path.to_string_lossy();
                    // Keyed only when something is open: a key costs a
                    // canonicalize, and `read` pays one again.
                    if open.is_empty() || !open.contains(&file_key(&path)) {
                        changed |= self.read(&path);
                    }
                    seen += 1;
                    if seen >= max_files {
                        return changed;
                    }
                }
            }
        }
        changed
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
/// {"lint": {"select": [], "ignore": [], "run": "onType", "severity": {},
///           "scope": "open"},
///  "fixes": {"unsafe": true}, "format": {"enable": true},
///  "semanticTokens": {"enable": true}, "navigation": {"enable": true},
///  "help": {"enable": true}, "completion": {"enable": false},
///  "callHierarchy": {"enable": true}, "graph": {"enable": true},
///  "autoLoad": {"enable": false}, "referenceLens": {"enable": false},
///  "inferredTypes": {"enable": true},
///  "suppressions": {"enable": true}, "organiseLoads": {"enable": true},
///  "performanceLints": {"enable": true}, "formatChangedLines": {"enable": false},
///  "workspaceIndex": {"enable": true, "exclude": []},
///  "qsqlLayout": {"enable": true, "onFormat": false, "lineLength": 80},
///  "functionalForm": {"enable": true}, "qsqlExplain": {"enable": true},
///  "versionCheck": {"enable": true}, "baseline": {"enable": true},
///  "typeLints": {"enable": true}, "selectionRange": {"enable": false},
///  "relatedInformation": {"enable": false}, "crossFileRefresh": {"enable": false},
///  "renameLoads": {"enable": false}, "loadPathCompletion": {"enable": false}}
/// ```
///
/// `lint.select` and `lint.ignore` narrow the selection (see
/// `Policy::narrow`); everything else here is the server's own behaviour,
/// which no configuration file describes.
#[derive(Debug)]
struct Options {
    /// Lint on save rather than on every change. An open buffer's text is
    /// still kept current, and indexed, for code actions, formatting and
    /// navigation: only the lint waits (#2174).
    on_save: bool,
    /// `lint.scope: "workspace"`: publish diagnostics for every file the
    /// index reads, not only the open ones (`scope`).
    workspace_scope: bool,
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
    /// Answer rename and prepareRename, under `navigation`: its own switch,
    /// since a global's rename edits every file that names it.
    rename: bool,
    /// Answer inlay hints: parameter names at a call's arguments.
    inlay_hints: bool,
    /// Answer code lenses: Run above a function's definition. Off unless
    /// asked for, since the lens runs a command only an editor that
    /// registers it has (`q-lint.runDefinition`, the VS Code extension's).
    code_lens: bool,
    /// Answer document links: each load's path, to the file it loads.
    document_links: bool,
    /// Offer the code action that writes a qDoc block above a function.
    generate_qdoc: bool,
    /// Offer Extract Function on a selection.
    extract_function: bool,
    /// Give a completed name another file defines the `\l` that loads it,
    /// when nothing this file loads or is loaded with defines it. Off
    /// unless asked for: accepting the name then writes a line elsewhere in
    /// the file.
    auto_load: bool,
    /// Answer code lenses with the number of references above each
    /// function. Off unless asked for, as Run is: the lens opens them with
    /// the client's command (`q-lint.showReferences`).
    reference_lens: bool,
    /// Show the type a local's assignments settle, on hover and as an
    /// inlay hint (`q_lint_rs::typed_locals`).
    inferred_types: bool,
    /// Offer the Quick Fixes that accept a finding: `/ noqa: CODE` on its
    /// line, and `/ qlinter: noqa: CODE` for its file.
    suppressions: bool,
    /// Answer `source.organizeImports` with the edit that sorts, dedupes and
    /// groups each run of `\l` lines (`organise_loads`).
    organise_loads: bool,
    /// Report the performance rules, QV. Off, they are ignored as
    /// `lint.ignore` would.
    performance_lints: bool,
    /// Answer `q-lint/formatChangedLines`: the safe fixes, for findings on
    /// the lines a client says changed. Off unless asked for, since only a
    /// client that asks git for those lines can use it.
    format_changed_lines: bool,
    /// Offer the code action that lays out the qSQL query at the cursor.
    qsql_layout: bool,
    /// Have Format Document lay out every qSQL query longer than
    /// `qsql_width` too. Off unless asked for: formatting was the safe
    /// fixes alone, and a format on save would start moving lines.
    qsql_on_format: bool,
    /// The line length a laid-out query's parts are fitted to.
    qsql_width: usize,
    /// Offer the code actions that rewrite the qSQL query at the cursor in
    /// its functional form, and a functional form as qSQL.
    functional_form: bool,
    /// Say the qSQL query or functional form under the cursor in words, on
    /// hover over its lead word or its `?`/`!`.
    qsql_explain: bool,
    /// Report the QK rules for a configuration's `target-version`. Off,
    /// they are ignored as `lint.ignore` would.
    version_check: bool,
    /// Pass over the findings in a configuration's `baseline` file. Off,
    /// every finding is shown.
    baseline: bool,
    /// Report the lints from inferred types, QT033-QT035. Off, they are
    /// ignored as `lint.ignore` would.
    type_lints: bool,
    /// Answer textDocument/selectionRange: Expand Selection by the
    /// brackets and statements of q. Off unless asked for, since an editor
    /// told a server answers it stops using its own word-and-bracket guess.
    selection_range: bool,
    /// Give a diagnostic that points at a second place - the first of two
    /// parameters or columns of one name - that place as
    /// `relatedInformation`, when the client takes it. Off unless asked for.
    related_information: bool,
    /// Ask the client to fetch code lenses and inlay hints again when
    /// another file's definitions, or the reads a reference count counts,
    /// change - for a client that can be asked. Off unless asked for.
    cross_file_refresh: bool,
    /// Answer `workspace/willRenameFiles` with the edits that keep each `\l`
    /// naming the file or folder being renamed (`paths`). Off unless asked
    /// for: accepting a rename then edits other files.
    rename_loads: bool,
    /// Complete the directories and scripts after `\l ` (`paths`). Off
    /// unless asked for, as completion is; on alone, only a `\l` line is
    /// answered.
    load_path_completion: bool,
    /// Whether the client shows an action it cannot take with the reason
    /// (`codeAction.disabledSupport`): a capability, not a setting.
    disabled_actions: bool,
    /// A diagnostic severity by code or prefix; the longest that names a
    /// code decides.
    severity: Vec<(String, i64)>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            on_save: false,
            workspace_scope: false,
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
            rename: true,
            inlay_hints: true,
            code_lens: false,
            document_links: true,
            generate_qdoc: true,
            extract_function: true,
            auto_load: false,
            reference_lens: false,
            inferred_types: true,
            suppressions: true,
            organise_loads: true,
            performance_lints: true,
            format_changed_lines: false,
            qsql_layout: true,
            qsql_on_format: false,
            qsql_width: 80,
            functional_form: true,
            qsql_explain: true,
            version_check: true,
            baseline: true,
            type_lints: true,
            selection_range: false,
            related_information: false,
            cross_file_refresh: false,
            rename_loads: false,
            load_path_completion: false,
            disabled_actions: false,
            severity: vec![],
        }
    }
}

impl Options {
    /// The options in `initialize`'s params, and a line for each one that
    /// could not be read. A bad value is reported and its default used: a
    /// server that refused to start over a typo in a setting would give an
    /// editor no diagnostics at all.
    fn read(params: &Value) -> (Self, Vec<Layer>, Vec<String>) {
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
                        "rename",
                        "inlayHints",
                        "codeLens",
                        "documentLinks",
                        "generateQdoc",
                        "extractFunction",
                        "autoLoad",
                        "referenceLens",
                        "inferredTypes",
                        "suppressions",
                        "organiseLoads",
                        "performanceLints",
                        "formatChangedLines",
                        "qsqlLayout",
                        "functionalForm",
                        "qsqlExplain",
                        "versionCheck",
                        "baseline",
                        "typeLints",
                        "selectionRange",
                        "relatedInformation",
                        "crossFileRefresh",
                        "renameLoads",
                        "loadPathCompletion",
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
        options.rename = flag("/rename/enable", true);
        options.inlay_hints = flag("/inlayHints/enable", true);
        options.code_lens = flag("/codeLens/enable", false);
        options.document_links = flag("/documentLinks/enable", true);
        options.generate_qdoc = flag("/generateQdoc/enable", true);
        options.extract_function = flag("/extractFunction/enable", true);
        options.auto_load = flag("/autoLoad/enable", false);
        options.reference_lens = flag("/referenceLens/enable", false);
        options.inferred_types = flag("/inferredTypes/enable", true);
        options.suppressions = flag("/suppressions/enable", true);
        options.organise_loads = flag("/organiseLoads/enable", true);
        options.performance_lints = flag("/performanceLints/enable", true);
        options.format_changed_lines = flag("/formatChangedLines/enable", false);
        options.qsql_layout = flag("/qsqlLayout/enable", true);
        options.qsql_on_format = flag("/qsqlLayout/onFormat", false);
        options.functional_form = flag("/functionalForm/enable", true);
        options.qsql_explain = flag("/qsqlExplain/enable", true);
        options.version_check = flag("/versionCheck/enable", true);
        options.baseline = flag("/baseline/enable", true);
        options.type_lints = flag("/typeLints/enable", true);
        options.selection_range = flag("/selectionRange/enable", false);
        options.cross_file_refresh = flag("/crossFileRefresh/enable", false);
        options.rename_loads = flag("/renameLoads/enable", false);
        options.load_path_completion = flag("/loadPathCompletion/enable", false);
        options.related_information = flag("/relatedInformation/enable", false)
            && params
                .pointer("/capabilities/textDocument/publishDiagnostics/relatedInformation")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        match init.pointer("/qsqlLayout/lineLength") {
            None | Some(Value::Null) => {}
            Some(n) => match n.as_u64().filter(|n| (20..=400).contains(n)) {
                Some(n) => options.qsql_width = n as usize,
                None => problems.push(format!(
                    "/qsqlLayout/lineLength must be a whole number from 20 to 400, not {n}"
                )),
            },
        }
        options.disabled_actions = params
            .pointer("/capabilities/textDocument/codeAction/disabledSupport")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        match init.pointer("/lint/run") {
            None | Some(Value::Null) => {}
            Some(v) if v == "onType" => {}
            Some(v) if v == "onSave" => options.on_save = true,
            Some(other) => problems.push(format!(
                "/lint/run must be \"onType\" or \"onSave\", not {other}"
            )),
        }
        match init.pointer("/lint/scope") {
            None | Some(Value::Null) => {}
            Some(v) if v == "open" => {}
            Some(v) if v == "workspace" => options.workspace_scope = true,
            Some(other) => problems.push(format!(
                "/lint/scope must be \"open\" or \"workspace\", not {other}"
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
        // A rule family a toggle turns off is a layer of its own: in
        // `lint.ignore`, `QK` would lose to a longer `QK001` in `lint.select`,
        // the longest selector deciding, and the toggle would not hold (#2294).
        let mut off = vec![];
        if !options.performance_lints {
            off.push("QV".to_string());
        }
        if !options.version_check {
            off.push("QK".to_string());
        }
        if !options.type_lints {
            off.extend(["QT033", "QT034", "QT035"].map(String::from));
        }
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
        let layers = [
            Layer {
                // An empty list is no selection at all, not a selection of
                // nothing: it is what an editor sends for a setting left alone.
                select: (!select.is_empty()).then_some(select),
                extend_select: vec![],
                ignore,
            },
            Layer {
                select: None,
                extend_select: vec![],
                ignore: off,
            },
        ]
        .into_iter()
        .filter(|layer| layer.select.is_some() || !layer.ignore.is_empty())
        .collect();
        (options, layers, problems)
    }

    /// The severity a client asked for `code`, if it asked for one.
    fn severity_of(&self, code: &str) -> Option<i64> {
        self.severity
            .iter()
            .filter(|(s, _)| crate::config::names(s, code))
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
    let mut redefined = Redefined::new();
    let mut kept = Kept::new();
    let mut idx = Index::default();
    let mut closed = scope::Closed::default();
    let mut opts = Options::default();
    let mut problems: Vec<String> = vec![];
    let mut initialized = false;
    // Whether the client can take a `CodeAction` literal; see `capabilities`.
    let mut code_action_literals = false;
    // Whether the client re-asks for semantic tokens when told to, and the
    // id of the next request the server sends it.
    let mut token_refresh = false;
    // Likewise for code lenses and inlay hints (LSP 3.16 and 3.17).
    let mut lens_refresh = false;
    let mut hint_refresh = false;
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
    // The request being handled, which a panic in its handler still answers.
    let mut handling: Option<Value> = None;
    loop {
        // Every message is handled inside the guard, and so is every lint
        // of a closed file between them: a panic anywhere in it is a bug in
        // qlinter, and costs the message it was handling - answered, when it
        // is a request - not the process and every open document's state
        // (#2108). What was read and changed before it stands.
        let ran: Result<Result<u8, String>, String> = guarded(|| {
            loop {
                handling = None;
                // A configuration that could not be read, and so the defaults
                // in force where it governs, as `qlinter` would refuse it: said
                // where the user looks, once the client is listening (#2291).
                if ready && !shutdown_requested {
                    for told in policy.take_told() {
                        send(
                            writer,
                            json!({"method": "window/showMessage", "params": {"type": 1,
                                   "message": format!("q-lint: {told}")}}),
                        )?;
                    }
                }
                // Everything the client has sent so far, before the oldest of it is
                // handled: what is behind a message can make it moot.
                // And while nothing has, a closed file of the workspace is linted,
                // one at a time, so none of them holds up a message (`scope`).
                if queue.is_empty() {
                    queue.extend(messages.try_iter());
                }
                if queue.is_empty()
                    && !shutdown_requested
                    && let Some(key) = closed.next()
                {
                    closed.lint(writer, &key, &docs, &idx, policy, &opts)?;
                    continue;
                }
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
                    None if message.get("result").is_some() || message.get("error").is_some() => {
                        continue;
                    }
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

                let (generation, reads, signatures) = (idx.generation, idx.reads, idx.signatures);
                handling = id.clone();
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
                        policy.set_roots(&idx.roots);
                        idx.folders = folders.into_iter().map(Folder::of).collect();
                        let layers;
                        (opts, layers, problems) = Options::read(&params);
                        policy.narrow(layers);
                        policy.use_baseline(opts.baseline);
                        code_action_literals = params
                            .pointer(
                                "/capabilities/textDocument/codeAction/codeActionLiteralSupport",
                            )
                            .is_some_and(|v| !v.is_null());
                        token_refresh = params
                            .pointer("/capabilities/workspace/semanticTokens/refreshSupport")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let refreshes = |what: &str| {
                            opts.cross_file_refresh
                                && params
                                    .pointer(&format!(
                                        "/capabilities/workspace/{what}/refreshSupport"
                                    ))
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false)
                        };
                        lens_refresh =
                            refreshes("codeLens") && (opts.code_lens || opts.reference_lens);
                        hint_refresh = refreshes("inlayHint") && opts.inlay_hints;
                        idx.hinted = hint_refresh;
                        idx.counted = lens_refresh && opts.reference_lens;
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
                                opts.rename,
                            );
                        }
                        help_client = help::Client::read(&params);
                        help::announce(&mut result["capabilities"], opts.help, opts.completion);
                        paths::announce(
                            &mut result["capabilities"],
                            opts.rename_loads,
                            opts.load_path_completion,
                        );
                        relate::announce(
                            &mut result["capabilities"],
                            opts.call_hierarchy,
                            opts.graph,
                        );
                        live::announce(&mut result["capabilities"]);
                        inventory::announce(&mut result["capabilities"]);
                        selection::announce(&mut result["capabilities"], opts.selection_range);
                        annotate::announce(
                            &mut result["capabilities"],
                            opts.inlay_hints || opts.inferred_types,
                            opts.code_lens || opts.reference_lens,
                            opts.document_links,
                        );
                        send(writer, json!({"id": id, "result": result}))?;
                        initialized = true;
                    }
                    ("exit", _) => return Ok(if shutdown_requested { 0 } else { 1 }),
                    // A handler that panics, for the test that the guard
                    // around every handler holds.
                    #[cfg(test)]
                    ("q-lint/plantedPanic", _) => panic!("planted"),
                    // LSP 3.17, Initialize Request: before `initialize`, a request is
                    // answered with ServerNotInitialized and a notification dropped,
                    // `exit` excepted.
                    (_, Some(id)) if !initialized => send(
                        writer,
                        json!({"id": id, "error": {"code": SERVER_NOT_INITIALIZED, "message": "server is not initialized"}}),
                    )?,
                    (_, None) if !initialized => {}
                    // After `shutdown` the server waits only for `exit`, handled
                    // above: a notification is dropped (#1218).
                    (_, None) if shutdown_requested => {}
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
                        closed.on = opts.workspace_scope;
                        closed.sync(writer, &idx, &docs, true)?;
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
                        closed.stop();
                        docs.clear();
                        unsaved.clear();
                        redefined.clear();
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
                        | "textDocument/documentLink"
                        | "textDocument/selectionRange"
                        | "q-lint/graph"
                        | "q-lint/globalAt"
                        | "q-lint/unresolvedNames"
                        | "q-lint/argumentSlot"
                        | "q-lint/formatChangedLines",
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
                        redefined.remove(&uri);
                        if is_q_uri(&uri) {
                            closed.opened(writer, &file_key(&path_of(&uri)), &uri)?;
                        }
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
                                // screen, and indexed, so navigation answers from
                                // it; linted when it is saved, and the others too
                                // when what it defines changed (#2174).
                                if !superseded
                                    && is_q_uri(&uri)
                                    && idx.set(&path_of(&uri), text, policy)
                                {
                                    redefined.insert(uri.clone());
                                }
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
                            let others = redefined.remove(&uri);
                            publish(
                                writer,
                                &mut docs,
                                &unsaved,
                                &mut kept,
                                &mut idx,
                                uri.clone(),
                                text,
                                policy,
                                &opts,
                            )?;
                            // Indexed as it was typed, so the save itself changed
                            // nothing the index holds.
                            if others {
                                relint(
                                    writer,
                                    &docs,
                                    &unsaved,
                                    &mut kept,
                                    &idx,
                                    Some(&uri),
                                    policy,
                                    &opts,
                                )?;
                            }
                        }
                        closed.sync(writer, &idx, &docs, false)?;
                    }
                    ("textDocument/didClose", None) => {
                        let uri = uri_of(&params["textDocument"]);
                        docs.remove(&uri);
                        unsaved.remove(&uri);
                        redefined.remove(&uri);
                        kept.remove(&uri);
                        // The buffer is gone, so the disk is the authority again - and
                        // unsaved definitions it held no longer define anything.
                        if idx.close(&path_of(&uri), policy) {
                            relint(
                                writer, &docs, &unsaved, &mut kept, &idx, None, policy, &opts,
                            )?;
                        }
                        // An empty list, not silence: diagnostics are owned by the
                        // server until it says otherwise, so a closed file would keep
                        // its squiggles in the problems panel forever. Unless every
                        // file the index reads reports, when it does as one on disk.
                        let key = file_key(&path_of(&uri));
                        if closed.on && idx.files.contains_key(&key) {
                            closed.lint(writer, &key, &docs, &idx, policy, &opts)?;
                        }
                        // To the URI it was open by, when the file reports
                        // under another (#2172).
                        if !closed.published_to(&key, &uri) {
                            send(
                                writer,
                                json!({"method": "textDocument/publishDiagnostics",
                                       "params": {"uri": uri, "diagnostics": []}}),
                            )?;
                        }
                        closed.sync(writer, &idx, &docs, false)?;
                    }
                    ("textDocument/semanticTokens/full", Some(id)) => {
                        let uri = uri_of(&params["textDocument"]);
                        let data = guarded(|| {
                            docs.get(&uri)
                                .filter(|_| opts.semantic_tokens && is_q_uri(&uri))
                                .map_or_else(Vec::new, |text| {
                                    let placement = idx
                                        .files
                                        .get(&file_key(&path_of(&uri)))
                                        .map(|file| file.placement.clone())
                                        .unwrap_or_default();
                                    encode_tokens(text, &idx.ws, &placement)
                                })
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
                        match guarded(|| code_actions(&params, &docs, &idx.ws, policy, &opts)) {
                            Ok(actions) => send(writer, json!({"id": id, "result": actions}))?,
                            Err(panic) => send(writer, internal_error(id, &panic))?,
                        }
                    }
                    ("q-lint/formatChangedLines", Some(id)) => {
                        let edits = if opts.format_changed_lines {
                            guarded(|| format_changed_lines(&params, &docs, &idx.ws, policy))
                        } else {
                            Ok(vec![])
                        };
                        match edits {
                            Ok(edits) => send(writer, json!({"id": id, "result": edits}))?,
                            Err(panic) => send(writer, internal_error(id, &panic))?,
                        }
                    }
                    ("textDocument/formatting", Some(id)) => {
                        let edits = if opts.format {
                            let layout = (opts.qsql_layout && opts.qsql_on_format)
                                .then_some(opts.qsql_width);
                            guarded(|| format(&params, &docs, &idx.ws, policy, layout))
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
                            let renaming = method.ends_with("ename");
                            if !opts.navigation || (renaming && !opts.rename) {
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
                    ("workspace/willRenameFiles", Some(id)) => {
                        // Asked of a server that did not announce it, answered with
                        // no edit rather than refused.
                        let answer = guarded(|| {
                            if !opts.rename_loads {
                                return (Value::Null, None);
                            }
                            paths::will_rename(&params, &navigate::Sources::new(&docs, &idx))
                        });
                        match answer {
                            Ok((result, told)) => {
                                // The loads the new name cannot be written in: the
                                // rename goes ahead whatever is answered, so the
                                // user is told which lines it leaves behind.
                                if let Some(message) = told {
                                    send(
                                        writer,
                                        json!({"method": "window/showMessage",
                                               "params": {"type": 2, "message": message}}),
                                    )?;
                                }
                                send(writer, json!({"id": id, "result": result}))?
                            }
                            Err(panic) => send(writer, internal_error(id, &panic))?,
                        }
                    }
                    ("textDocument/selectionRange", Some(id)) => {
                        // Asked of a server that did not announce it, answered with
                        // nothing rather than refused.
                        let answer = guarded(|| {
                            if !opts.selection_range {
                                return Value::Null;
                            }
                            selection::answer(&params, &navigate::Sources::new(&docs, &idx))
                        });
                        match answer {
                            Ok(result) => send(writer, json!({"id": id, "result": result}))?,
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
                        "textDocument/hover"
                        | "textDocument/signatureHelp"
                        | "textDocument/completion",
                        Some(id),
                    ) => {
                        // Asked of a server that did not announce it, a request is
                        // answered with nothing rather than refused.
                        let on = match method.as_str() {
                            "textDocument/completion" => {
                                opts.completion || opts.load_path_completion
                            }
                            _ => opts.help,
                        };
                        let answer = guarded(|| {
                            if !on {
                                return Value::Null;
                            }
                            let sources = navigate::Sources::new(&docs, &idx);
                            if method == "textDocument/completion" && opts.load_path_completion {
                                let path = sources
                                    .cursor(&params)
                                    .and_then(|cursor| paths::completion(&cursor, &sources));
                                if let Some(items) = path {
                                    return items;
                                }
                            }
                            // A `/` is announced as a trigger for the next directory
                            // of a load and is q's `over` everywhere else: a request
                            // the character itself raised, off a load path, is for
                            // no list of names (#2021).
                            let slash = params["context"]["triggerKind"] == 2
                                && params["context"]["triggerCharacter"] == "/";
                            if method == "textDocument/completion" && (!opts.completion || slash) {
                                return Value::Null;
                            }
                            let more = help::More {
                                inferred_types: opts.inferred_types,
                                auto_load: opts.auto_load,
                                qsql_explain: opts.qsql_explain,
                            };
                            help::answer(&method, &params, &sources, help_client, more)
                        });
                        match answer {
                            Ok(result) => send(writer, json!({"id": id, "result": result}))?,
                            Err(panic) => send(writer, internal_error(id, &panic))?,
                        }
                    }
                    (
                        "textDocument/inlayHint"
                        | "textDocument/codeLens"
                        | "textDocument/documentLink",
                        Some(id),
                    ) => {
                        // Asked of a server that did not announce it, a request is
                        // answered with nothing rather than refused.
                        let shown = annotate::Shown {
                            parameter_hints: opts.inlay_hints,
                            type_hints: opts.inferred_types,
                            run_lenses: opts.code_lens,
                            reference_lenses: opts.reference_lens,
                        };
                        let on = match method.as_str() {
                            "textDocument/codeLens" => opts.code_lens || opts.reference_lens,
                            "textDocument/documentLink" => opts.document_links,
                            _ => opts.inlay_hints || opts.inferred_types,
                        };
                        let answer = guarded(|| {
                            if !on {
                                return Value::Null;
                            }
                            let sources = navigate::Sources::new(&docs, &idx);
                            annotate::answer(&method, &params, &sources, shown)
                        });
                        match answer {
                            Ok(result) => send(writer, json!({"id": id, "result": result}))?,
                            Err(panic) => send(writer, internal_error(id, &panic))?,
                        }
                    }
                    (
                        "q-lint/tests"
                        | "q-lint/globalAt"
                        | "q-lint/unresolvedNames"
                        | "q-lint/argumentSlot"
                        | "q-lint/defined",
                        Some(id),
                    ) => {
                        let answer = guarded(|| {
                            let sources = navigate::Sources::new(&docs, &idx);
                            live::answer(&method, &params, &sources, opts.inlay_hints)
                        });
                        match answer {
                            Ok(result) => send(writer, json!({"id": id, "result": result}))?,
                            Err(panic) => send(writer, internal_error(id, &panic))?,
                        }
                    }
                    (
                        "q-lint/definitions" | "q-lint/deadCode" | "q-lint/testsReaching",
                        Some(id),
                    ) => {
                        let answer = guarded(|| {
                            let sources = navigate::Sources::new(&docs, &idx);
                            inventory::answer(&method, &params, &sources)
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
                            relate::answer(
                                &method,
                                &params,
                                &sources,
                                opts.call_hierarchy,
                                opts.graph,
                            )
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
                        let mut seen = HashSet::new();
                        for change in params["changes"].as_array().into_iter().flatten() {
                            let uri = uri_of(change);
                            let deleted = change["type"].as_i64() == Some(3);
                            // A client sends an event once for each pattern its
                            // path matches, and a q file's matches two (`watchers`).
                            if !seen.insert((uri.clone(), change["type"].as_i64())) {
                                continue;
                            }
                            // A configuration file changed: every file it governs may
                            // now report differently, so forget them all and relint.
                            let path = path_of(&uri);
                            if is_config_path(&path) || policy.read_from(Path::new(&path)) {
                                policy.reset();
                                config_changed = true;
                                continue;
                            }
                            if docs.contains_key(&uri) || is_open(&docs, &path) {
                                continue;
                            }
                            // A directory, not entered through a symlink, as the
                            // scan does not.
                            let folder = std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
                            // The pattern that matches a folder matches every other
                            // path too (`watchers`): a file that is no q says
                            // nothing here. One that is gone may have been a folder.
                            if !folder && !deleted && !is_q_path(&path) {
                                continue;
                            }
                            // A folder's one event is the only word of a
                            // configuration that came with it, too.
                            changed |= (folder || deleted) && policy.forget_under(Path::new(&path));
                            if !folder && is_q_path(&path) {
                                closed.touch(file_key(&path));
                            }
                            changed |= if deleted {
                                idx.remove_tree(&path, &docs)
                            } else if folder {
                                idx.add_tree(&path, policy, &docs)
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
                        closed.sync(writer, &idx, &docs, config_changed)?;
                    }
                    // A folder added to or removed from a multi-root workspace (#797).
                    ("workspace/didChangeWorkspaceFolders", None) => {
                        let folders = |key: &str| {
                            workspace_folders(&json!({"workspaceFolders": params["event"][key]}))
                        };
                        let removed = folders("removed").into_iter().map(|(path, _)| path);
                        idx.change_roots(folders("added"), removed.collect(), policy, &docs);
                        // An open buffer still wins over what a folder held.
                        for (uri, text) in docs.iter().filter(|(uri, _)| is_q_uri(uri)) {
                            idx.open(&path_of(uri), text, policy);
                        }
                        idx.settle();
                        if idx.generation != generation {
                            relint(
                                writer, &docs, &unsaved, &mut kept, &idx, None, policy, &opts,
                            )?;
                        }
                        closed.sync(writer, &idx, &docs, false)?;
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
                // Handled, and answered when it was a request.
                handling = None;
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
                // And what is drawn over the text: a parameter name at a call comes
                // from the definition another file holds, and a reference count
                // from the reads of every file. Only once the client is ready.
                let defined = idx.generation != generation;
                if ready && !shutdown_requested {
                    let counted = opts.reference_lens && idx.reads != reads;
                    for (asked, method) in [
                        (
                            lens_refresh && (defined || counted),
                            "workspace/codeLens/refresh",
                        ),
                        (
                            hint_refresh && (defined || idx.signatures != signatures),
                            "workspace/inlayHint/refresh",
                        ),
                    ] {
                        if asked {
                            next_request += 1;
                            send(
                                writer,
                                json!({"id": format!("qlinter-{next_request}"), "method": method}),
                            )?;
                        }
                    }
                }
            }
        });
        match ran {
            Ok(ended) => return ended,
            Err(panic) => {
                eprintln!("qlinter: a panic was caught and the server carries on: {panic}");
                if let Some(id) = handling.take() {
                    send(writer, internal_error(id, &panic))?;
                }
            }
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
        let mut kinds = vec![QUICK_FIX, FIX_ALL];
        if opts.generate_qdoc || opts.qsql_layout || opts.functional_form {
            kinds.push(REWRITE);
        }
        if opts.extract_function {
            kinds.push(EXTRACT);
        }
        if opts.organise_loads {
            kinds.push(ORGANISE);
        }
        capabilities["codeActionProvider"] = json!({ "codeActionKinds": kinds });
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
fn encode_tokens(source: &str, ws: &Workspace, placement: &Placement) -> Vec<u32> {
    let mut data = vec![];
    let (mut prev_line, mut prev_start) = (0usize, 0usize);
    let lines = Lines::new(source);
    for (at, len, kind) in semantic_tokens_in(source, ws, placement) {
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

/// The parameters each definition in `text` declares in a signature, which
/// is what an inlay hint at a call of it shows (`annotate::declarations`).
fn signatures(text: &str) -> Vec<(String, Vec<String>)> {
    guarded(|| q_lint_rs::mentions(text))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            let d = m.definition?;
            (d.function && !d.detail.is_empty()).then_some((m.name, d.params))
        })
        .collect()
}

/// The reply to a request whose handler panicked: JSON-RPC 2.0 §5.1's
/// `-32603 Internal error`, rather than no reply, which a client cannot tell
/// from a hung server.
/// Every read of a global in `text`, as `Indexed::tally` keeps them - and
/// every symbol, tick and all, since a count takes one that may be a name
/// for a read of it (#2679).
fn tally(text: &str) -> Vec<(String, bool)> {
    guarded(|| {
        let symbols = text.match_indices('`').map(|(tick, _)| {
            let rest = &text[tick + 1..];
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || "_.:/".contains(c)))
                .unwrap_or(rest.len());
            (text[tick..tick + 1 + end].to_string(), false)
        });
        q_lint_rs::mentions(text)
            .into_iter()
            .filter(|m| m.definition.is_none())
            .map(|m| (m.name, m.implicit))
            .chain(symbols)
            .collect()
    })
    .unwrap_or_default()
}

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
///
/// And every path created or deleted, which is how a folder is heard of. An
/// editor has ONE event for a folder renamed, moved or deleted on disk -
/// for the folder, none for the files in it - and sends it only if the
/// folder's path matches a pattern registered here. A glob cannot say "a
/// directory", and a folder's name is any name, so the pattern is every
/// path: with only the two above, `mv lib core` reached the server as
/// nothing, and it answered from `lib` until restarted (#2028). Not a
/// change (`kind` is create and delete, LSP `WatchKind` 1 and 4): a folder
/// is not changed, and every write to every file in the workspace is what
/// that would send. What it does send besides folders - any other file
/// created or deleted - the handler drops on its name.
///
/// And, for a client that takes a pattern rooted elsewhere, the files and
/// directories outside the workspace that the settings came from or were
/// searched for in - a configuration above the folder, an `extend`ed base
/// beside it, the user-level file - which no workspace pattern reaches and
/// whose change the server otherwise never heard of (#554).
///
/// A file the settings came from that is neither `.q` nor `.toml` - a
/// baseline, a `--config` by another name - is watched by its own pattern.
/// Inside the workspace a client without relative patterns takes it as a
/// glob relative to the folder: with none, a baseline rewritten in place
/// matched no watcher, a change being no create or delete, and its old
/// findings stayed hidden until a restart (#2111).
fn watchers(roots: &[String], policy: &Policy, relative: bool) -> Vec<Value> {
    let mut out = vec![
        json!({"globPattern": "**/*.q"}),
        json!({"globPattern": "**/*.toml"}),
        json!({"globPattern": "**/*", "kind": 5}),
    ];
    let roots: Vec<std::path::PathBuf> = roots.iter().map(|r| file_key(r).into()).collect();
    // Both sides as keys: a real path is verbatim on Windows, and
    // `C:\a` does not start with `\\?\C:\a` (#554).
    let key = |p: &std::path::Path| std::path::PathBuf::from(file_key(&p.to_string_lossy()));
    let outside = |p: &std::path::Path| !roots.iter().any(|r| key(p).starts_with(r));
    let (files, dirs) = policy.watched();
    let toml = |p: &std::path::Path| p.extension().is_some_and(|e| e == "toml");
    if !relative {
        let mut globs: Vec<String> = files
            .iter()
            .filter(|f| !toml(f))
            .filter_map(|f| {
                let f = key(f);
                let root = roots.iter().find(|r| f.starts_with(r))?;
                let within = f
                    .strip_prefix(root)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/");
                Some(glob_literal(&within))
            })
            .collect();
        globs.sort();
        globs.dedup();
        out.extend(globs.into_iter().map(|g| json!({"globPattern": g})));
        return out;
    }
    let names = format!("{{{}}}", FILES.join(","));
    for dir in dirs.iter().filter(|d| outside(d)) {
        out.push(json!({"globPattern": {"baseUri": path_uri(dir), "pattern": names}}));
    }
    // `--config` names a file by any name, which `**/*.toml` may not match.
    for file in files.iter().filter(|f| outside(f) || !toml(f)) {
        if let (Some(dir), Some(name)) = (file.parent(), file.file_name()) {
            out.push(json!({"globPattern":
                {"baseUri": path_uri(dir), "pattern": name.to_string_lossy()}}));
        }
    }
    out
}

/// `text` as a glob that matches it alone: each character a glob reads as
/// syntax put in brackets, where it stands for itself.
fn glob_literal(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '*' | '?' | '[' | ']' | '{' | '}' => format!("[{c}]"),
            c => c.to_string(),
        })
        .collect()
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
    /// The URI for the file keyed `key` as read from disk by `path`: by
    /// the folder that path is spelled under and the rest of it, as the
    /// client named the folder - a symlink by its own name (#2289). The
    /// key's own URI when `path` is the key, or under no folder as spelled.
    fn spelled_uri(&self, path: &str, key: &str) -> String {
        let spelled = Path::new(path);
        if path == key {
            return self.uri(key);
        }
        let below = self
            .idx
            .folders
            .iter()
            .filter_map(|folder| {
                Some((folder, spelled.strip_prefix(Path::new(&folder.path)).ok()?))
            })
            .min_by_key(|(_, rest)| rest.components().count());
        let Some((folder, rest)) = below else {
            return self.uri(key);
        };
        let mut uri = folder.uri.trim_end_matches('/').to_string();
        for part in rest.components() {
            uri.push('/');
            escape(&mut uri, &part.as_os_str().to_string_lossy());
        }
        uri
    }

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
/// The kind of the action that writes a qDoc block above a function.
const REWRITE: &str = "refactor.rewrite";
/// The kind of Extract Function.
const EXTRACT: &str = "refactor.extract.function";
/// The kind of the action that organises a file's `\l` lines: what VS Code's
/// Organize Imports and `editor.codeActionsOnSave` ask for as
/// `source.organizeImports`.
const ORGANISE: &str = "source.organizeImports.q-lint";

/// Whether a kind the client asks for (`context.only`) takes in `kind`. Kinds
/// are hierarchical, a dot at a time: `source` and `source.fixAll` each ask
/// for `source.fixAll.q-lint`, and `source.fixAllOrNothing` does not.
fn asks_for(only: &str, kind: &str) -> bool {
    kind.strip_prefix(only)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
}

/// The code actions for a request: the quick fixes for the diagnostics it
/// carries, the qDoc block for the function the range is in, and - only
/// when asked for by kind - the fix-all action.
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
    opts: &Options,
) -> Vec<Value> {
    let unsafe_fixes = opts.unsafe_fixes;
    let only: Option<Vec<&str>> = params["context"]["only"]
        .as_array()
        .map(|only| only.iter().filter_map(Value::as_str).collect());
    let mut actions = vec![];
    if only.as_ref().is_none_or(|only| {
        only.iter()
            .any(|kind| *kind == QUICK_FIX || kind.starts_with("quickfix."))
    }) {
        actions.extend(quick_fixes(
            params,
            docs,
            ws,
            policy,
            unsafe_fixes,
            opts.suppressions,
        ));
    }
    if opts.generate_qdoc
        && only
            .as_ref()
            .is_none_or(|only| only.iter().any(|kind| asks_for(kind, REWRITE)))
    {
        actions.extend(qdoc_action(params, docs));
    }
    // Unasked for by kind, only over a selection with no diagnostic to fix:
    // a request about a diagnostic is about that diagnostic's range.
    let about_diagnostics = params["context"]["diagnostics"]
        .as_array()
        .is_some_and(|d| !d.is_empty());
    // The same for the qSQL layout: a query with a finding in it is fixed
    // first, and the Refactor menu asks by kind.
    if opts.qsql_layout
        && match &only {
            None => !about_diagnostics,
            Some(only) => only.iter().any(|kind| asks_for(kind, REWRITE)),
        }
    {
        actions.extend(qsql_action(params, docs, opts.qsql_width));
    }
    if opts.functional_form
        && match &only {
            None => !about_diagnostics,
            Some(only) => only.iter().any(|kind| asks_for(kind, REWRITE)),
        }
    {
        let why = opts.disabled_actions && only.is_some();
        actions.extend(functional_actions(params, docs, why));
    }
    if opts.extract_function
        && match &only {
            None => !about_diagnostics,
            Some(only) => only.iter().any(|kind| asks_for(kind, EXTRACT)),
        }
    {
        // The reason it is refused only to a menu that asked for refactors
        // by name: the lightbulb asks as the cursor moves.
        let why = opts.disabled_actions && only.is_some();
        actions.extend(extract_action(params, docs, ws, why));
    }
    if only
        .as_ref()
        .is_some_and(|only| only.iter().any(|kind| asks_for(kind, FIX_ALL)))
    {
        actions.extend(fix_all_action(params, docs, ws, policy));
    }
    // Only by kind, as the fix-all: it reorders, and is asked for by name.
    if opts.organise_loads
        && only
            .as_ref()
            .is_some_and(|only| only.iter().any(|kind| asks_for(kind, ORGANISE)))
    {
        actions.extend(organise_action(params, docs));
    }
    actions
}

/// The `\l` lines of an open q document sorted, deduped and grouped
/// (`organise_loads`), as one action of kind `source.organizeImports.q-lint`;
/// none when nothing would change.
fn organise_action(params: &Value, docs: &Documents) -> Option<Value> {
    let uri = uri_of(&params["textDocument"]);
    let source = docs.get(&uri).filter(|_| is_q_uri(&uri))?;
    let fix = organise_loads(source)?;
    let lines = Lines::new(source);
    let mut changes = serde_json::Map::new();
    changes.insert(
        uri.clone(),
        json!([{
            "range": {"start": lines.json(fix.start), "end": lines.json(fix.end)},
            "newText": fix.replacement,
        }]),
    );
    Some(json!({
        "title": fix.title,
        "kind": ORGANISE,
        "edit": {"changes": changes},
    }))
}

/// The edits for `q-lint/formatChangedLines`: what Format Document makes,
/// for only the findings on `params.lines` - pairs of 0-based first and
/// last lines, inclusive - which the client works out from git, as this
/// server starts no process. None for no lines at all, and in every case
/// `format` gives none.
fn format_changed_lines(
    params: &Value,
    docs: &Documents,
    ws: &Workspace,
    policy: &Policy,
) -> Vec<Value> {
    let uri = uri_of(&params["textDocument"]);
    let path = path_of(&uri);
    let Some(source) = docs
        .get(&uri)
        .filter(|source| is_q_uri(&uri) && balanced(source))
    else {
        return vec![];
    };
    let lines: Vec<(usize, usize)> = params["lines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|pair| {
            let first = pair.get(0)?.as_u64()? as usize;
            let last = pair.get(1)?.as_u64()? as usize;
            (first <= last).then_some((first + 1, last + 1))
        })
        .collect();
    if lines.is_empty() {
        return vec![];
    }
    let Ok(fixed) = fix_lines(source, &lines, |text| policy.lint(text, &path, ws)) else {
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

/// The fixes for the diagnostics a request carries, and after them, for each
/// of those diagnostics, the edit that accepts it instead: `/ noqa: CODE` on
/// its line. That one is offered wherever such a comment would be read as
/// one (`suppression_for` refuses where it would not), fix or no fix, and
/// never as the preferred action: the fix is what the finding asks for, and
/// silencing it is a decision nobody should make with a keystroke meant for
/// something else. Once for a line and a code, however many of the
/// diagnostics are that code on that line: one comment accepts them all, and
/// the action says so by listing them.
///
/// Last, once a code, the edit that accepts it in the whole file: the code
/// added to the file's `/ qlinter: noqa:` line, or that line written at the
/// top (`file_suppression_for`). Neither is offered with `suppressions` off.
fn quick_fixes(
    params: &Value,
    docs: &Documents,
    ws: &Workspace,
    policy: &Policy,
    unsafe_fixes: bool,
    suppress: bool,
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
    // The client's diagnostics by where they start, so each finding is
    // compared with those at its own position, first first: a scan of them
    // all for each finding was quadratic on a whole-file selection (#2337).
    // One whose start is not a pair of numbers is compared with every one.
    let mut by_start: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
    let mut elsewhere: Vec<usize> = vec![];
    for (i, d) in context.iter().enumerate() {
        let start = &d["range"]["start"];
        match (start["line"].as_u64(), start["character"].as_u64()) {
            (Some(line), Some(character)) => by_start.entry((line, character)).or_default().push(i),
            _ => elsewhere.push(i),
        }
    }
    let asked_about: Vec<(Finding, &Value)> = policy
        .lint(source, &path, ws)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|finding| {
            let current = diagnostic(&finding, &lines);
            let start = &current["range"]["start"];
            let key = (start["line"].as_u64()?, start["character"].as_u64()?);
            let at = by_start.get(&key).map_or(&[][..], Vec::as_slice);
            let client_diagnostic = at
                .iter()
                .chain(&elsewhere)
                .copied()
                .filter(|&i| {
                    let d = &context[i];
                    d["code"] == current["code"]
                        && d["range"]["start"] == current["range"]["start"]
                        && d["message"] == current["message"]
                })
                .min()
                .map(|i| &context[i])?;
            Some((finding, client_diagnostic))
        })
        .collect();
    // For them all at once: a selection of the whole of a long file asks
    // about every finding in it, and each would mask the file again.
    let accepted = if suppress {
        suppressions_for(asked_about.iter().map(|(finding, _)| finding), source)
    } else {
        asked_about.iter().map(|_| None).collect()
    };
    let fixes = fixes_each(asked_about.iter().map(|(finding, _)| finding), source);
    // Where each suppression edit is in `suppressions`, by the edit: a scan
    // of them all for each was quadratic in a selection's findings.
    let mut suppression_at: HashMap<String, usize> = HashMap::new();
    let mut in_file: Vec<(String, Option<Value>)> = vec![];
    for (((finding, client_diagnostic), suppression), fix) in
        asked_about.iter().zip(accepted).zip(fixes)
    {
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
        actions.extend(fix.filter(|f| f.batch_safe || unsafe_fixes).map(action));
        if let Some(suppression) = suppression.map(action) {
            match suppression_at.entry(suppression["edit"].to_string()) {
                std::collections::hash_map::Entry::Occupied(at) => {
                    suppressions[*at.get()]["diagnostics"]
                        .as_array_mut()
                        .expect("made above")
                        .push((*client_diagnostic).clone())
                }
                std::collections::hash_map::Entry::Vacant(at) => {
                    at.insert(suppressions.len());
                    suppressions.push(suppression);
                }
            }
        }
        // One edit a code, and each asked for once: it masks the file.
        if suppress {
            match in_file.iter_mut().find(|(code, _)| *code == finding.code) {
                Some((_, Some(same))) => same["diagnostics"]
                    .as_array_mut()
                    .expect("made above")
                    .push((*client_diagnostic).clone()),
                Some((_, None)) => {}
                None => in_file.push((
                    finding.code.clone(),
                    file_suppression_for(finding, source).map(action),
                )),
            }
        }
    }
    actions.extend(suppressions);
    actions.extend(in_file.into_iter().filter_map(|(_, action)| action));
    actions
}

/// A qDoc block for the function whose definition the request's range
/// starts in - a statement at column 0 assigning a lambda - written above
/// it in the form the uqf tree documents its functions: a `/ @param` line
/// for each parameter a caller passes (the signature's, or the `x`, `y`
/// and `z` its body reads) and a `/ @return` line, each for the
/// description to be typed after. Inserted directly above the definition,
/// so a description already there stays on top; none when the comment
/// above already has an `@param` or `@return`.
fn qdoc_action(params: &Value, docs: &Documents) -> Option<Value> {
    let uri = uri_of(&params["textDocument"]);
    let source = docs.get(&uri).filter(|_| is_q_uri(&uri))?;
    let lines = Lines::new(source);
    let start = &params["range"]["start"];
    let cursor = lines.offset(
        start["line"].as_u64()? as usize,
        start["character"].as_u64()? as usize,
    );
    let all = q_lint_rs::mentions(source);
    let (m, definition) = all.iter().find_map(|m| {
        let d = m.definition.as_ref()?;
        (d.function
            && m.at == d.start
            && starts_statement(source, m.at)
            && (d.start..=d.end).contains(&cursor))
        .then_some((m, d))
    })?;
    let above = q_lint_rs::comment_above(source, definition.start);
    if above.contains("@param") || above.contains("@return") {
        return None;
    }
    // A file written with CRLF gets CRLF (#2795).
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    // The names each slot binds: `` x:`j `` is x, and the pattern `(a;b)` a
    // and b, as QS007 reads the block back (#2778). An empty slot, the
    // second of `{[a;] a}`, has no name to document (#2779).
    let mut block: String = definition
        .params
        .iter()
        .flat_map(|param| q_lint_rs::slot_names(param))
        .map(|name| format!("/ @param {name}{newline}"))
        .collect();
    block.push_str("/ @return");
    block.push_str(newline);
    let at = lines.json(m.at);
    let mut changes = serde_json::Map::new();
    // Above the line, which `q)` prompts may start (#3003).
    let line = json!({"line": at["line"], "character": 0});
    changes.insert(
        uri.clone(),
        json!([{"range": {"start": line, "end": line}, "newText": block}]),
    );
    Some(json!({
        "title": format!("Generate qDoc for {}", &source[m.at..m.at + m.len]),
        "kind": REWRITE,
        "edit": {"changes": changes},
    }))
}

/// The qSQL query the request's range starts in, laid out on aligned lines:
/// a clause per line, and a part's items one per line where they do not
/// fit in `width` (`q_lint_rs::qsql_layout_at`). None outside a query, in
/// one laid out so already, and in one a new line could change.
fn qsql_action(params: &Value, docs: &Documents, width: usize) -> Option<Value> {
    let uri = uri_of(&params["textDocument"]);
    let source = docs.get(&uri).filter(|_| is_q_uri(&uri))?;
    let lines = Lines::new(source);
    let start = &params["range"]["start"];
    let cursor = lines.offset(
        start["line"].as_u64()? as usize,
        start["character"].as_u64()? as usize,
    );
    let l = qsql_layout_at(source, cursor, width)?;
    let mut changes = serde_json::Map::new();
    changes.insert(
        uri.clone(),
        json!([{"range": {"start": lines.json(l.start), "end": lines.json(l.end)},
                "newText": l.text}]),
    );
    Some(json!({
        "title": "Lay out qSQL query on aligned lines",
        "kind": REWRITE,
        "edit": {"changes": changes},
    }))
}

/// The qSQL query at the cursor rewritten in its functional form, and the
/// functional form at the cursor rewritten as qSQL
/// (`q_lint_rs::qsql_to_functional`, `functional_to_qsql`). Where one is
/// there but cannot be rewritten, nothing - or with `why` the action
/// disabled with the reason.
fn functional_actions(params: &Value, docs: &Documents, why: bool) -> Vec<Value> {
    let uri = uri_of(&params["textDocument"]);
    let Some(source) = docs.get(&uri).filter(|_| is_q_uri(&uri)) else {
        return vec![];
    };
    let lines = Lines::new(source);
    let start = &params["range"]["start"];
    let (Some(line), Some(character)) = (start["line"].as_u64(), start["character"].as_u64())
    else {
        return vec![];
    };
    let cursor = lines.offset(line as usize, character as usize);
    let mut out = vec![];
    for (title, answer) in [
        (
            "Rewrite qSQL query in functional form",
            qsql_to_functional(source, cursor),
        ),
        (
            "Rewrite functional form as qSQL",
            functional_to_qsql(source, cursor),
        ),
    ] {
        match answer {
            Some(Ok(c)) => {
                let mut changes = serde_json::Map::new();
                changes.insert(
                    uri.clone(),
                    json!([{"range": {"start": lines.json(c.start), "end": lines.json(c.end)},
                            "newText": c.text}]),
                );
                out.push(json!({"title": title, "kind": REWRITE, "edit": {"changes": changes}}));
            }
            Some(Err(reason)) if why => out.push(json!({
                "title": title,
                "kind": REWRITE,
                "disabled": {"reason": format!("Not rewritten: {reason}.")},
            })),
            _ => {}
        }
    }
    out
}

/// Extract Function over the request's range: the selection made a lambda
/// of the locals it reads, defined above the top-level statement it is in
/// (`q_lint_rs::extract`), and the selection a call to it. Nothing for an
/// empty selection; for one it refuses, nothing, or with `why` the action
/// disabled with the reason.
fn extract_action(params: &Value, docs: &Documents, ws: &Workspace, why: bool) -> Option<Value> {
    let uri = uri_of(&params["textDocument"]);
    let source = docs.get(&uri).filter(|_| is_q_uri(&uri))?;
    let lines = Lines::new(source);
    let at = |p: &Value| {
        Some(lines.offset(
            p["line"].as_u64()? as usize,
            p["character"].as_u64()? as usize,
        ))
    };
    let (from, to) = (at(&params["range"]["start"])?, at(&params["range"]["end"])?);
    if from == to {
        return None;
    }
    let title = "Extract function";
    match q_lint_rs::extract(source, from, to) {
        Ok(found) => {
            // A name another file defines is in use as well, under whatever
            // namespace: this file may load that one, or be loaded by it,
            // into the context the new definition is made in (#2793).
            let taken = |name: &str| ws.names().any(|(n, _)| n.rsplit('.').next() == Some(name));
            let name = q_lint_rs::fresh_name_but(source, "extracted", taken);
            let insert = lines.json(found.insert_at);
            let mut changes = serde_json::Map::new();
            // Both edits are in the original's positions, as LSP has them;
            // the definition goes above, so the two never overlap.
            changes.insert(
                uri.clone(),
                json!([
                    {"range": {"start": insert, "end": insert}, "newText": found.definition(&name)},
                    {"range": {"start": lines.json(found.start), "end": lines.json(found.end)},
                     "newText": found.call(&name)},
                ]),
            );
            Some(json!({
                "title": format!("{title} as {name}"),
                "kind": EXTRACT,
                "edit": {"changes": changes},
            }))
        }
        Err(reason) if why => Some(json!({
            "title": title,
            "kind": EXTRACT,
            "disabled": {"reason": reason},
        })),
        Err(_) => None,
    }
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
    let edits = format(params, docs, ws, policy, None);
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
/// open buffer, under the same policy as its diagnostics - and with `layout`
/// (`qsqlLayout.onFormat`'s line length), every qSQL query longer than that
/// laid out after them. At most one edit,
/// from the first byte that changed to the last, and none at all when nothing
/// would - a document that is not open or not q, a broken structure, a
/// configuration that cannot be read, or nothing to fix.
fn format(
    params: &Value,
    docs: &Documents,
    ws: &Workspace,
    policy: &Policy,
    layout: Option<usize>,
) -> Vec<Value> {
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
    let mut text = fixed.text;
    if let Some(width) = layout {
        for l in qsql_layouts(&text, width).into_iter().rev() {
            text.replace_range(l.start..l.end, &l.text);
        }
    }
    let Some(edit) = whole_edit(source, &text) else {
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
    let changed = is_q_uri(&uri) && idx.set(&path, &text, policy);
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
            recarry(uri, text, kept, &idx.ws, policy, opts);
            diagnose(writer, uri, text, kept, &idx.ws, policy, opts)?;
        }
    }
    Ok(())
}

/// What `uri` carries over a statement being typed in `text`, linted again
/// against the workspace `ws` as it is now - or dropped, when that lint
/// fails. The last version that closed reported against the workspace as
/// it was then, and another file's change can make a finding of it false,
/// or one true that it did not report: a QF015 on `true` stayed after
/// another file defined `true`, until the bracket being typed closed
/// (#2177). A document whose text is the version kept is linted whole
/// anyway, and kept from that.
fn recarry(
    uri: &str,
    text: &str,
    kept: &mut Kept,
    ws: &Workspace,
    policy: &Policy,
    opts: &Options,
) {
    if kept.get(uri).is_none_or(|good| good.text == text) {
        return;
    }
    let Some(Good { text: good, .. }) = kept.remove(uri) else {
        return;
    };
    // That version closes, so `diagnostics_of` keeps what it reports again.
    let _ = linted(uri, &good, ws, policy)
        .and_then(|findings| guarded(|| diagnostics_of(uri, &good, &findings, kept, opts)));
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
    let findings = linted(uri, text, ws, policy);
    report(writer, uri, text, findings, kept, opts)
}

/// What the rules find in `text`, the document `uri`, or the panic of the
/// rule that failed on it.
///
/// An editor reads a file's BOM as its encoding and sends, or holds, the
/// text after it; the BOM is still the file's, and q still refuses it. So
/// when the file on disk starts with one and `text` does not, QE005 is
/// asked of the text with the BOM put back, and reported first, at its
/// start - open or closed alike, as the CLI reports the file (#2027,
/// #2110).
fn linted(uri: &str, text: &str, ws: &Workspace, policy: &Policy) -> Result<Vec<Finding>, String> {
    let path = path_of(uri);
    // Only q source. A client may open anything - a `.k` file, a console
    // buffer, an untitled scratch, a `.txt` - and hand it to whichever server
    // claims the language. The rules here describe q and say nothing true
    // about k or about a REPL transcript, so a document that is not a `.q`
    // file on disk gets an empty diagnostic list: that clears anything stale without
    // asserting something about a file this linter cannot read.
    if !is_q_uri(uri) {
        return Ok(vec![]);
    }
    // Lenient, so this cannot fail: a configuration it cannot read is
    // reported once on stderr and the defaults govern its files.
    let mut findings = guarded(|| policy.lint(text, &path, ws).unwrap_or_default());
    if let Ok(found) = &mut findings
        && !q_lint_rs::as_an_editor_holds(text).1
        && !found.iter().any(|f| f.code == "QE005")
        && starts_with_bom(&path)
    {
        let whole = format!("\u{feff}{text}");
        let of_bom = guarded(|| policy.lint(&whole, &path, ws).unwrap_or_default());
        let of_bom = of_bom.unwrap_or_default().into_iter();
        found.splice(0..0, of_bom.filter(|f| f.code == "QE005"));
    }
    findings
}

/// Whether the file `path` on disk starts with a BOM, as
/// `as_an_editor_holds` reads one - the test `on_disk` and the CLI use -
/// from the file's first three bytes alone: asked at every lint of an open
/// document.
fn starts_with_bom(path: &str) -> bool {
    use std::io::Read;
    let mut head = [0u8; 3];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut head))
        .is_ok_and(|()| q_lint_rs::as_an_editor_holds(&String::from_utf8_lossy(&head)).1)
}

/// Push `findings`, what the rules found in the `text` of `uri`, as its
/// diagnostics.
///
/// Turning them into diagnostics - positions, related places, what is
/// carried over a broken statement - is guarded as the lint is: a panic
/// there is a bug in qlinter, and costs this document its diagnostics, not
/// the server every open document's state (#2108).
fn report(
    writer: &mut impl Write,
    uri: &str,
    text: &str,
    findings: Result<Vec<Finding>, String>,
    kept: &mut Kept,
    opts: &Options,
) -> Result<(), String> {
    let diagnostics =
        findings.and_then(|findings| guarded(|| diagnostics_of(uri, text, &findings, kept, opts)));
    // A rule that panicked leaves nothing true to report, so the document
    // gets one diagnostic saying so, at its start, until an edit gets past it.
    let diagnostics = diagnostics.unwrap_or_else(|panic| {
        vec![json!({
            "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}},
            "severity": 1,
            "source": "q-lint",
            "message": format!(
                "qlinter failed on this document and reports nothing else for it: {panic}. \
                 This is a bug in qlinter."
            ),
        })]
    });
    send(
        writer,
        json!({"method": "textDocument/publishDiagnostics",
               "params": {"uri": uri, "diagnostics": diagnostics}}),
    )
}

/// `findings` in the `text` of `uri` as its diagnostics, with what `kept`
/// carries over while a statement does not close.
fn diagnostics_of(
    uri: &str,
    text: &str,
    findings: &[Finding],
    kept: &mut Kept,
    opts: &Options,
) -> Vec<Value> {
    let lines = Lines::new(text);
    let view = std::cell::OnceCell::new();
    let mut diagnostics: Vec<Value> = findings
        .iter()
        .map(|f| {
            let mut d = diagnostic(f, &lines);
            if let Some(level) = opts.severity_of(&f.code) {
                d["severity"] = json!(level);
            }
            if opts.related_information
                && let Some(column) = f.column
            {
                let at = lines.q_offset(f.line.saturating_sub(1), column.saturating_sub(1));
                let places = related::related(f, text, &view, &lines, at, uri);
                if !places.is_empty() {
                    d["relatedInformation"] = json!(places);
                }
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
        if matches!(findings, [only] if only.code == "QE001") {
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
                    // The places it points at move with it, or go.
                    if let Some(places) = d.get_mut("relatedInformation") {
                        let moved: Vec<Value> = places
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|place| {
                                let range = &place["location"]["range"];
                                let (start, end) = carry.lines(
                                    range["start"]["line"].as_u64()? as usize,
                                    range["end"]["line"].as_u64()? as usize,
                                )?;
                                let mut place = place.clone();
                                place["location"]["range"]["start"]["line"] = json!(start);
                                place["location"]["range"]["end"]["line"] = json!(end);
                                Some(place)
                            })
                            .collect();
                        *places = json!(moved);
                    }
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
    diagnostics
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

/// Whether the name at byte `at` starts a statement of its own: at column
/// 0, or right after the `q)` prompts its line starts with. q runs
/// `q)h:{x}` and `q)q)h:{x}` as `h:{x}`, so each is a definition to run, to
/// count the references of and to document like one at column 0 (#3003). A
/// run with another language in it, `k)q)h:{x}`, is not q's to run.
fn starts_statement(text: &str, at: usize) -> bool {
    let line = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let lead = &text.as_bytes()[line..at];
    lead.len().is_multiple_of(2) && lead.chunks(2).all(|prompt| prompt == b"q)")
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
    /// Marks along the text, made the first time a column is converted:
    /// a character boundary at least every `MARK` bytes, with the UTF-16
    /// units before it. A conversion walks from the mark before it, not
    /// from its line's start, which on one long line - generated or
    /// minified q - made each finding cost the line's length (#2114).
    marks: std::cell::OnceCell<Vec<(usize, usize)>>,
}

/// The most bytes a conversion walks past its mark.
const MARK: usize = 64;

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
            marks: std::cell::OnceCell::new(),
        }
    }

    fn marks(&self) -> &[(usize, usize)] {
        self.marks.get_or_init(|| {
            let mut marks = vec![(0, 0)];
            let (mut last, mut units) = (0, 0);
            for (i, c) in self.source.char_indices() {
                if i - last >= MARK {
                    marks.push((i, units));
                    last = i;
                }
                units += c.len_utf16();
            }
            marks
        })
    }

    /// The UTF-16 units of the text before `byte`, a character boundary.
    fn units_before(&self, byte: usize) -> usize {
        let marks = self.marks();
        let (at, units) = marks[marks.partition_point(|&(b, _)| b <= byte) - 1];
        units + utf16_len(&self.source[at..byte])
    }

    /// The first character boundary from `start` to `end` with `column`
    /// UTF-16 units between it and `start`, or `end` when there is none.
    fn column_in(&self, start: usize, end: usize, column: usize) -> usize {
        let target = self.units_before(start) + column;
        let marks = self.marks();
        // The last mark short of the target, or `start` when that is later.
        let k = marks.partition_point(|&(_, u)| u < target);
        let (mut at, mut units) = match k.checked_sub(1).map(|k| marks[k]) {
            Some((b, u)) if b > start => (b, u),
            _ => (start, target - column),
        };
        while units < target && at < end {
            let c = self.source[at..]
                .chars()
                .next()
                .expect("a character before the end");
            units += c.len_utf16();
            at += c.len_utf8();
        }
        at.min(end)
    }

    /// A byte offset as the line and UTF-16 character a client addresses it
    /// by. An offset inside a character is that character's start: a caller
    /// that steps one byte back from an end lands there whenever the text
    /// ends in one that is not ASCII (#2108).
    fn position(&self, byte: usize) -> (usize, usize) {
        let mut byte = byte.min(self.source.len());
        while !self.source.is_char_boundary(byte) {
            byte -= 1;
        }
        let line = self.starts.partition_point(|&s| s <= byte) - 1;
        let start = self.starts[line];
        // A short way in is walked; a long one is counted from the marks.
        if byte - start <= MARK {
            return (line, utf16_len(&self.source[start..byte]));
        }
        (line, self.units_before(byte) - self.units_before(start))
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
        // The line ends before its line ending: `\n`, `\r\n` or a lone `\r`.
        let end = self
            .starts
            .get(line + 1)
            .map_or(self.source.len(), |&next| {
                next - 1 - usize::from(self.source[..next].ends_with("\r\n"))
            });
        self.column_in(start, end, character)
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
        self.column_in(start, start + self.q_line(line).len(), column)
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
        // The line of the statement's last character, which starts before
        // its end by that character's width, not by one byte.
        let last_char = new[broken.start..broken.end]
            .char_indices()
            .next_back()
            .map_or(broken.start, |(i, _)| broken.start + i);
        let last = after.position(last_char).0;
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

/// What tells two paths that name a file by the same name apart from two
/// that name it by different ones (a symlink and its target): `path` with
/// `.` dropped and its separators made one - on Windows a backslash and `/` both
/// are, and the walk joins with one while a URI gives the other - and, on
/// Windows, without case, which its filesystem ignores (#2289).
fn spelling(path: &str) -> String {
    let normal: std::path::PathBuf = Path::new(path).components().collect();
    let normal = normal.to_string_lossy().into_owned();
    if cfg!(windows) {
        normal.replace('\\', "/").to_lowercase()
    } else {
        normal
    }
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
    // The host, when the URI names one but this machine: a file on a
    // network share, which Windows names `\\host\share\...` and VS Code
    // `file://host/share/...`. Dropped, the share was read as a folder
    // `/host/share` on the current drive (#2112).
    let mut host = "";
    let rest = match rest.strip_prefix("//") {
        // Strip the empty authority: file:///a/b has a host of "", so the
        // path begins at the third slash. RFC 8089 makes `localhost` the
        // same host, and file://localhost/a/b the same file (#425).
        Some(rest) => {
            let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
                host = authority;
            }
            path.strip_prefix('/').unwrap_or(path)
        }
        // RFC 8089's form with no authority at all: file:/a/b (#546).
        None => rest.strip_prefix('/')?,
    };
    let decoded = decode(rest);
    // A share's path is `//host/...`, which Windows reads as `\\host\...`
    // and `path_uri` gives back as the URI it came from.
    Some(if !host.is_empty() {
        format!("//{}/{decoded}", decode(host))
    } else if re_drive(&decoded) {
        // A Windows path is a drive letter, not a root: VS Code sends
        // `file:///c%3A/Users/...`, and `/c:/Users/...` is no path at all.
        decoded
    } else {
        format!("/{decoded}")
    })
}

/// `text` with its percent-escapes decoded.
fn decode(text: &str) -> String {
    // Percent-escapes decode to bytes, and the bytes are UTF-8: `%C3%A9` is
    // one `é`. Pushing each byte as a char read it as two Latin-1 ones, and
    // a workspace under a folder with a non-ASCII name lost every path.
    let mut bytes = Vec::with_capacity(text.len());
    let raw = text.as_bytes();
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
    String::from_utf8_lossy(&bytes).into_owned()
}

fn re_drive(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// The text of the file `path` on disk as an editor holds it once open, and
/// whether a BOM came before it. An editor reads a BOM as the file's
/// encoding, not as a character of line 0: the text it sends when the file
/// is opened, and applies an edit to when it is not, starts after it. Read
/// with the BOM in it, every place on line 0 of a closed file was one
/// character to the right of where the editor has it, and a rename from
/// another file cut the name there in two (#2027). Every read of a
/// workspace file comes through here, so the index, the places and the
/// diagnostics of a closed file agree with each other and with the editor.
fn on_disk(path: &str) -> Option<(String, bool)> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let (text, bom) = q_lint_rs::as_an_editor_holds(&text);
    Some((text.to_string(), bom))
}

/// Whether the file `path` is an open document, under whatever spelling of
/// its path it was opened by: its buffer, not the disk, is what the index
/// holds of it (#2172).
fn is_open(docs: &Documents, path: &str) -> bool {
    let key = file_key(path);
    docs.keys()
        .any(|uri| is_q_uri(uri) && file_key(&path_of(uri)) == key)
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

    /// One file read twice by one name, spelled two ways, is one path to
    /// lint it by: on Windows the scan joins `\\` onto a folder a URI spells
    /// with `/`, and a closed file was linted, and published to its URI,
    /// once per spelling - an extra notification where a client waited for
    /// the reply to shutdown, and two answers to one change (#2289).
    #[test]
    fn one_file_read_by_two_spellings_of_its_name_is_linted_by_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.q"), "a:1\n").unwrap();
        let mut idx = Index::default();
        let plain = root.join("a.q").to_string_lossy().into_owned();
        let dotted = root.join(".").join("a.q").to_string_lossy().into_owned();
        // A verbatim `\\?\` path, which a canonical one is on Windows,
        // keeps its `.`: there the separators and the case differ instead.
        let mut spelled = vec![plain.clone()];
        if !cfg!(windows) {
            spelled.push(dotted);
        }
        if cfg!(windows) {
            spelled.push(plain.replace('\\', "/"));
            spelled.push(plain.to_uppercase());
        }
        for path in &spelled {
            idx.read(path);
        }
        assert_eq!(idx.spellings(&file_key(&plain)), [plain]);
    }

    #[test]
    fn a_spelling_drops_dots_and_on_windows_separators_and_case() {
        assert_eq!(spelling("/w/./a.q"), spelling("/w/a.q"));
        assert_ne!(spelling("/w/link.q"), spelling("/w/t.q"));
        if cfg!(windows) {
            assert_eq!(spelling(r"C:\w\a.q"), spelling("c:/w/a.q"));
            assert_eq!(spelling(r"//?/C:/w\a.q"), spelling("//?/C:/w/a.q"));
        } else {
            // A backslash is part of a name here.
            assert_ne!(spelling(r"/w/b\a.q"), spelling("/w/b/a.q"));
        }
    }

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
        // A share keeps its host, and gives its URI back (#2112).
        assert_eq!(
            path_of("file://server/share/proj/a.q"),
            "//server/share/proj/a.q"
        );
        assert_eq!(
            path_of("file://Ser%20ver/sh%20are/a.q"),
            "//Ser ver/sh are/a.q"
        );
        for uri in ["file://host/share/c", "file://host/a%20b/c.q"] {
            assert_eq!(path_uri(p(&path_of(uri))), uri);
        }
        assert_eq!(path_of("file://host"), "//host/");
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
    fn an_offset_inside_a_character_is_that_characters_position() {
        // `é` is bytes 6..8: byte 7 is inside it, where slicing panicked.
        let source = "s:\"caf\u{e9}";
        let lines = Lines::new(source);
        assert_eq!(lines.position(7), (0, 6));
        assert_eq!(lines.position(8), (0, 7));
        // And the statement that does not close ends on its last line.
        let carry = Carry::new("a:1\n", source).expect("a broken statement");
        assert_eq!(carry.broken, 0..1);
    }

    #[test]
    fn findings_on_one_long_line_convert_in_linear_time() {
        // 40,000 findings on one 600 KB line, generated or minified q. Each
        // position was found by scanning from the start of its line: 10 s
        // to publish 24,000 in a release build, and every code action as
        // long (#2114). The `é` at the start keeps every column one UTF-16
        // unit short of its byte, so no ASCII shortcut passes this.
        let unit = "{[x] y:1; x};";
        let source = format!("\u{e9}a:({})\n", unit.repeat(40_000));
        let lines = Lines::new(&source);
        let started = std::time::Instant::now();
        for k in 0..40_000 {
            // Columns count UTF-16 units from 1: `é` is one, two bytes.
            let column = 4 + k * unit.len();
            let mut f = Finding::new("x.q", 1, "QF017", "detail".into());
            f.column = Some(column + 1);
            f.end_column = Some(column + 2);
            let d = diagnostic(&f, &lines);
            assert_eq!(d["range"]["start"], json!({"line": 0, "character": column}));
            let byte = lines.q_offset(0, column);
            assert_eq!(byte, column + 1);
            assert_eq!(&source[byte..byte + 1], "{");
            assert_eq!(lines.position(byte), (0, column));
            assert_eq!(lines.offset(0, column), byte);
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn positions_from_the_marks_are_the_ones_a_walk_from_the_line_start_gives() {
        // The marks are a shortcut (#2114): over texts with long lines, every
        // kind of line ending and characters of one to four bytes, each
        // conversion must answer what walking the line from its start does.
        let pieces = [
            "a",
            "bc ",
            "\u{e9}",
            "\u{20ac}",
            "\u{1f600}",
            "\n",
            "\r\n",
            "\r",
            "{[x] x}",
        ];
        let mut seed: u64 = 7;
        let mut next = |n: usize| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as usize % n
        };
        for _ in 0..200 {
            let text: String = (0..next(400))
                .map(|_| pieces[next(pieces.len() - 3) + usize::from(next(20) == 0) * 3])
                .collect();
            let lines = Lines::new(&text);
            let walk = |start: usize, end: usize, column: usize| {
                let mut units = 0;
                for (i, c) in text[start..end].char_indices() {
                    if units >= column {
                        return start + i;
                    }
                    units += c.len_utf16();
                }
                end
            };
            for byte in (0..=text.len()).filter(|&b| text.is_char_boundary(b)) {
                let line = lines.starts.partition_point(|&s| s <= byte) - 1;
                let start = lines.starts[line];
                assert_eq!(lines.position(byte), (line, utf16_len(&text[start..byte])));
            }
            for line in 0..lines.q_starts.len() {
                let start = lines.q_starts[line];
                let end = start + lines.q_line(line).len();
                for column in 0..utf16_len(&text[start..end]) + 3 {
                    assert_eq!(lines.q_offset(line, column), walk(start, end, column));
                }
            }
            for line in 0..lines.starts.len() {
                let start = lines.starts[line];
                let rest = &text[start..];
                let end = start + rest.find(['\n', '\r']).unwrap_or(rest.len());
                for column in 0..utf16_len(&text[start..end]) + 3 {
                    assert_eq!(
                        lines.offset(line, column),
                        walk(start, end, column),
                        "{text:?}"
                    );
                }
            }
        }
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
        let data = encode_tokens(source, &Workspace::default(), &Placement::default());
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
    fn a_panic_in_a_handler_is_answered_and_the_server_carries_on() {
        // Outside a guard, a panic in any handler ended the process and
        // every open document's state with it (#2108). Now the request it
        // was handling is answered with an internal error, a notification
        // that panics is dropped, and the next request is answered.
        let frame = |m: Value| {
            let body = m.to_string();
            format!("Content-Length: {}\r\n\r\n{body}", body.len())
        };
        let input: String = [
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "q-lint/plantedPanic"}),
            json!({"jsonrpc": "2.0", "method": "q-lint/plantedPanic"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "shutdown"}),
            json!({"jsonrpc": "2.0", "method": "exit"}),
        ]
        .into_iter()
        .map(frame)
        .collect();
        let policy = Policy::new(
            crate::config::Overrides {
                profile: None,
                default_profile: "style",
                layer: Layer::default(),
                exclude: vec![],
                config: None,
                isolated: true,
                target: None,
                baseline: None,
                no_baseline: false,
            },
            true,
        );
        let mut out = vec![];
        let code = serve(std::io::Cursor::new(input.into_bytes()), &mut out, &policy);
        assert_eq!(code, Ok(0));
        let out = String::from_utf8(out).unwrap();
        let replies: Vec<Value> = out
            .split("Content-Length: ")
            .filter_map(|frame| frame.split_once("\r\n\r\n"))
            .map(|(_, body)| serde_json::from_str(body).unwrap())
            .filter(|m: &Value| m.get("method").is_none())
            .collect();
        assert_eq!(replies.len(), 3, "{out}");
        assert_eq!(replies[1]["id"], 2);
        assert_eq!(replies[1]["error"]["code"], INTERNAL_ERROR);
        assert_eq!(
            replies[1]["error"]["message"],
            "qlinter failed on this document: planted"
        );
        assert_eq!(
            (&replies[2]["id"], &replies[2]["result"]),
            (&json!(3), &Value::Null)
        );
    }

    #[test]
    fn code_actions_for_a_whole_file_are_linear_in_its_findings() {
        // Select All asks for the code actions of every diagnostic at once.
        // Each finding was matched against every diagnostic the client sent,
        // and each masked the file again for its suppression and its fix:
        // 22 s for 8000 stale noqa comments (#2335, #2337).
        let policy = Policy::new(
            crate::config::Overrides {
                profile: None,
                default_profile: "style",
                layer: Layer::default(),
                exclude: vec![],
                config: None,
                isolated: true,
                target: None,
                baseline: None,
                no_baseline: false,
            },
            true,
        );
        let uri = "file:///t/a.q".to_string();
        let ws = Workspace::default();
        let time = |n: usize| {
            let source: String = (0..n).map(|i| format!("v{i}:1 / noqa: QS001\n")).collect();
            let lines = Lines::new(&source);
            let found = policy.lint(&source, "/t/a.q", &ws).unwrap();
            assert_eq!(found.len(), n);
            let diagnostics: Vec<Value> = found.iter().map(|f| diagnostic(f, &lines)).collect();
            let params = json!({
                "textDocument": {"uri": uri},
                "range": {"start": {"line": 0, "character": 0},
                          "end": {"line": n, "character": 0}},
                "context": {"diagnostics": diagnostics},
            });
            let mut docs = Documents::new();
            docs.insert(uri.clone(), source);
            let ask = || quick_fixes(&params, &docs, &ws, &policy, true, true);
            assert_eq!(ask().len(), 2 * n + 1);
            (0..3)
                .map(|_| {
                    let started = std::time::Instant::now();
                    std::hint::black_box(ask());
                    started.elapsed()
                })
                .min()
                .unwrap()
        };
        time(250); // warm the allocator and the regex caches
        let (small, large) = (time(250), time(2000));
        // Quadratic is 64 times; linear is 8. 16 still fails a quadratic
        // walk by four times.
        assert!(
            large < small * 16,
            "250 findings took {small:?} and 2000 {large:?}"
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
                target: None,
                baseline: None,
                no_baseline: false,
            },
            true,
        );
        let scanned = |max_entries| {
            let mut idx = Index {
                roots: vec![dir.path().to_string_lossy().into_owned()],
                enabled: true,
                ..Index::default()
            };
            idx.scan_within(&policy, &Documents::new(), MAX_FILES, max_entries);
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

    /// The README's `initializationOptions` block, as JSON.
    fn readme_options() -> Value {
        // A Windows checkout may have turned the README's line ends to CRLF.
        let readme = include_str!("../README.md").replace("\r\n", "\n");
        let section = readme
            .split("### Editor options: `initializationOptions`")
            .nth(1)
            .expect("README lost its initializationOptions section");
        let block = section
            .split("```json\n")
            .nth(1)
            .and_then(|rest| rest.split("\n```").next())
            .expect("README lost its initializationOptions block");
        serde_json::from_str(block).expect("the README's block is JSON")
    }

    /// Each leaf of `v` - a value that is not an object, or an empty one -
    /// by its JSON pointer.
    fn leaves(v: &Value, at: String, out: &mut Vec<(String, Value)>) {
        match v {
            Value::Object(map) if !map.is_empty() => {
                for (k, v) in map {
                    leaves(v, format!("{at}/{k}"), out);
                }
            }
            _ => out.push((at, v.clone())),
        }
    }

    fn read_options(init: Value) -> (String, Vec<String>) {
        // The client capability `relatedInformation.enable` also needs.
        let params = json!({"initializationOptions": init, "capabilities": {"textDocument":
            {"publishDiagnostics": {"relatedInformation": true}}}});
        let (options, layer, problems) = Options::read(&params);
        (format!("{options:?} {layer:?}"), problems)
    }

    #[test]
    fn the_readme_initialization_options_are_the_servers_defaults() {
        let readme = readme_options();
        let (defaults, problems) = read_options(Value::Null);
        assert!(problems.is_empty(), "{problems:?}");
        let (documented, problems) = read_options(readme.clone());
        assert!(problems.is_empty(), "the README's block: {problems:?}");
        assert_eq!(
            documented, defaults,
            "the README's block is not the defaults"
        );
        assert_eq!(
            format!("{:?}", Options::default()),
            format!("{:?}", Options::read(&json!({})).0)
        );

        // Each key in it is one the server reads: a value other than the one
        // documented changes what it does.
        let mut found = vec![];
        leaves(&readme, String::new(), &mut found);
        for (pointer, value) in &found {
            let other = match value {
                Value::Bool(b) => json!(!b),
                Value::Number(_) => json!(81),
                Value::String(s) if s == "onType" => json!("onSave"),
                Value::String(s) if s == "open" => json!("workspace"),
                Value::Array(_) if pointer.ends_with("exclude") => json!(["build/**"]),
                Value::Array(_) => json!(["QS001"]),
                Value::Object(_) => json!({"QS001": "hint"}),
                other => panic!("{pointer}: no other value to try for {other}"),
            };
            let mut changed = readme.clone();
            *changed.pointer_mut(pointer).unwrap() = other.clone();
            let (read, problems) = read_options(changed);
            assert!(problems.is_empty(), "{pointer} = {other}: {problems:?}");
            assert_ne!(read, defaults, "{pointer} = {other} changed nothing");
        }

        // And each key the server reads is in it. The pointers are read
        // from this file's source, where `Options::read` names them.
        let source = include_str!("lsp.rs").replace("\r\n", "\n");
        let body = &source[source.find("fn read(params: &Value)").unwrap()..];
        let body = &body[..body.find("\n    }\n").unwrap()];
        let mut read: Vec<String> = ["flag(\"", "init.pointer(\"", "strings(\""]
            .iter()
            .flat_map(|call| body.match_indices(call).map(move |(at, _)| at + call.len()))
            .map(|at| body[at..at + body[at..].find('"').unwrap()].to_string())
            .collect();
        read.sort();
        read.dedup();
        let mut documented: Vec<String> = found.into_iter().map(|(p, _)| p).collect();
        documented.sort();
        assert_eq!(documented, read);
    }
}
