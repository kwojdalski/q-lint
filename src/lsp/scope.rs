//! `lint.scope: "workspace"`: diagnostics for every `.q` file the workspace
//! index reads, open or not - the files `qlinter .` would lint, less what
//! `workspaceIndex.exclude` and the configuration's `exclude` skip, since
//! they are the index's files.
//!
//! WHY A QUEUE, AND NOT A PASS AT STARTUP
//!
//! A lint is milliseconds, and a workspace thousands of files: linted in one
//! go, the first keystroke after a folder opened would wait for all of them.
//! So a closed file is linted only when no message is waiting, one at a
//! time (`serve` asks `next` before it blocks), and a client's request
//! waits at most one file's lint. Nothing is kept of a closed file but the
//! URI its diagnostics went to - its text is read from disk when its turn
//! comes, and dropped after - and at most `MAX_LINTED` files are linted.
//!
//! WHEN A CLOSED FILE IS LINTED AGAIN
//!
//! When it changes on disk (`workspace/didChangeWatchedFiles`) or is closed,
//! and every one again when what the workspace defines has changed by a
//! save, a close, a change on disk, a folder added or removed, or a
//! configuration changed - not at every keystroke of an open file, which
//! would start the whole workspace over on each.
use super::{
    Documents, Index, Kept, Options, file_key, linted, navigate::Sources, on_disk, path_of, report,
};
use crate::config::Policy;
use crate::jsonrpc::send;
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;

/// How many closed files are linted. A workspace past it has diagnostics for
/// the first this many in path order, and none for the rest.
const MAX_LINTED: usize = 5_000;

#[derive(Default)]
pub(super) struct Closed {
    pub(super) on: bool,
    /// Files waiting for their lint, by key, each once.
    pending: VecDeque<String>,
    queued: HashSet<String>,
    /// The closed files diagnostics were published for, by key, with the
    /// URIs they went to - which an empty list clears: one for each path the
    /// file was read by, a symlink beside its target being two (#2289).
    published: HashMap<String, Vec<String>>,
    /// What the workspace defined when every file was last queued.
    generation: Option<u64>,
}

impl Closed {
    /// Queue `key` for its lint, ahead of the rest.
    pub(super) fn touch(&mut self, key: String) {
        if self.on && !self.queued.contains(&key) {
            self.queued.insert(key.clone());
            self.pending.push_front(key);
        }
    }

    /// Queue every file the index holds again when what it defines changed
    /// since they were last queued - or when `force`d, by a configuration
    /// that may report differently - and clear what was published for a
    /// file it no longer holds.
    pub(super) fn sync(
        &mut self,
        writer: &mut impl Write,
        idx: &Index,
        docs: &Documents,
        force: bool,
    ) -> Result<(), String> {
        if !self.on || (!force && self.generation == Some(idx.generation)) {
            return Ok(());
        }
        self.generation = Some(idx.generation);
        let open: HashSet<String> = docs.keys().map(|uri| file_key(&path_of(uri))).collect();
        let mut keys: Vec<&String> = idx
            .files
            .keys()
            .filter(|key| !open.contains(*key))
            .collect();
        keys.sort_unstable();
        keys.truncate(MAX_LINTED);
        let wanted: HashSet<&String> = keys.iter().copied().collect();
        let gone: Vec<String> = self
            .published
            .keys()
            .filter(|key| !wanted.contains(key) && !open.contains(*key))
            .cloned()
            .collect();
        for key in gone {
            self.clear(writer, &key)?;
        }
        for key in keys {
            if self.queued.insert(key.clone()) {
                self.pending.push_back(key.clone());
            }
        }
        Ok(())
    }

    /// The next file to lint, when there is one.
    pub(super) fn next(&mut self) -> Option<String> {
        let key = self.pending.pop_front()?;
        self.queued.remove(&key);
        Some(key)
    }

    /// Lint the closed file `key` from disk and publish what it reports, or
    /// clear what it reported when the index no longer holds it. An open
    /// file is passed by: its buffer's diagnostics are the ones that stand.
    pub(super) fn lint(
        &mut self,
        writer: &mut impl Write,
        key: &str,
        docs: &Documents,
        idx: &Index,
        policy: &Policy,
        opts: &Options,
    ) -> Result<(), String> {
        let sources = Sources::new(docs, idx);
        if let Some(uri) = sources.open.get(key) {
            return self.opened(writer, key, uri);
        }
        if !idx.files.contains_key(key) {
            return self.clear(writer, key);
        }
        // Each path the scan read it by, as `qlinter .` lints each name: a
        // symlink under its own name and the configuration above it, not
        // its target's - which may be outside every folder (#2289).
        let mut sent = vec![];
        for path in idx.spellings(key) {
            let Some((text, _)) = on_disk(&path) else {
                continue;
            };
            let uri = sources.spelled_uri(&path, key);
            // Two spellings the client knows by one URI report once.
            if sent.contains(&uri) {
                continue;
            }
            // The text is the editor's, which has no BOM in it, so
            // everything is found where the editor shows it; `linted` still
            // reports the file's BOM (#2027).
            let findings = linted(&uri, &text, &idx.ws, policy);
            // Nothing carried over for a file nobody is typing in, and
            // nothing of its text kept once it is linted.
            report(writer, &uri, &text, findings, &mut Kept::new(), opts)?;
            sent.push(uri);
        }
        // What went to a path it is no longer read by.
        for uri in self.published.remove(key).unwrap_or_default() {
            if !sent.contains(&uri) {
                empty(writer, &uri)?;
            }
        }
        if !sent.is_empty() {
            self.published.insert(key.to_string(), sent);
        }
        Ok(())
    }

    /// Clear the diagnostics published for `key`, if any were.
    fn clear(&mut self, writer: &mut impl Write, key: &str) -> Result<(), String> {
        for uri in self.published.remove(key).unwrap_or_default() {
            empty(writer, &uri)?;
        }
        Ok(())
    }

    /// The file `key` is open as `uri`, whose buffer's diagnostics are the
    /// ones that stand now: what was published for it closed is dropped -
    /// and cleared, when it went to another spelling of its path, which the
    /// buffer's would not replace. Left, a file opened by its real path
    /// under a folder opened through a symlink was listed twice in the
    /// Problems panel, once with what its buffer no longer says (#2172).
    pub(super) fn opened(
        &mut self,
        writer: &mut impl Write,
        key: &str,
        uri: &str,
    ) -> Result<(), String> {
        for to in self.published.remove(key).unwrap_or_default() {
            if to != uri {
                empty(writer, &to)?;
            }
        }
        Ok(())
    }

    /// Whether diagnostics were published to `uri` for `key` as a closed
    /// file.
    pub(super) fn published_to(&self, key: &str, uri: &str) -> bool {
        self.published
            .get(key)
            .is_some_and(|to| to.iter().any(|to| to == uri))
    }

    pub(super) fn stop(&mut self) {
        self.pending.clear();
        self.queued.clear();
    }
}

/// No diagnostics for `uri`, which clears what was published to it.
fn empty(writer: &mut impl Write, uri: &str) -> Result<(), String> {
    send(
        writer,
        json!({"method": "textDocument/publishDiagnostics",
               "params": {"uri": uri, "diagnostics": []}}),
    )
}
