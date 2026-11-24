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
    /// URI they went to - which an empty list clears.
    published: HashMap<String, String>,
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
        if sources.open.contains_key(key) {
            self.published.remove(key);
            return Ok(());
        }
        let read = idx.files.contains_key(key).then(|| on_disk(key)).flatten();
        let Some((text, bom)) = read else {
            return self.clear(writer, key);
        };
        let uri = sources.uri(key);
        let mut findings = linted(&uri, &text, &idx.ws, policy);
        // The text is the editor's, which has no BOM in it, so everything
        // is found where the editor shows it. The BOM itself is still the
        // file's, and q still refuses it: QE005 is asked of the file as it
        // is on disk, and reported at its start (#2027).
        if bom && let Ok(findings) = &mut findings {
            let whole = format!("\u{feff}{text}");
            let of_bom = linted(&uri, &whole, &idx.ws, policy).unwrap_or_default();
            findings.splice(0..0, of_bom.into_iter().filter(|f| f.code == "QE005"));
        }
        // Nothing carried over for a file nobody is typing in, and nothing
        // of its text kept once it is linted.
        report(writer, &uri, &text, findings, &mut Kept::new(), opts)?;
        self.published.insert(key.to_string(), uri);
        Ok(())
    }

    /// Clear the diagnostics published for `key`, if any were.
    fn clear(&mut self, writer: &mut impl Write, key: &str) -> Result<(), String> {
        match self.published.remove(key) {
            Some(uri) => send(
                writer,
                json!({"method": "textDocument/publishDiagnostics",
                       "params": {"uri": uri, "diagnostics": []}}),
            ),
            None => Ok(()),
        }
    }

    /// Whether diagnostics were published for `key` as a closed file.
    pub(super) fn published(&self, key: &str) -> bool {
        self.published.contains_key(key)
    }

    pub(super) fn stop(&mut self) {
        self.pending.clear();
        self.queued.clear();
    }
}
