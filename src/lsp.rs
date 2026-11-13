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
//! It also fixes the thing a CLI cannot do well: linting a buffer that has
//! never been saved. `didChange` carries the text, so what is checked is what
//! is on screen rather than what is on disk.
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
//! WHAT IT IMPLEMENTS, AND WHAT IT DELIBERATELY DOES NOT
//!
//! initialize/initialized, didOpen/didChange/didSave/didClose, shutdown/exit,
//! diagnostics pushed with textDocument/publishDiagnostics, quick fixes
//! requested with textDocument/codeAction, document formatting with
//! textDocument/formatting, and semantic tokens - the colour of a function at
//! the places it is called, and of a parameter where its body reads it - with
//! textDocument/semanticTokens/full.
//!
//! A workspace index: every `.q` file under the workspace folders is read at
//! startup - never run - for the global names it defines, and kept current
//! from open buffers, closes, and workspace/didChangeWatchedFiles. A name
//! another file defines is not undefined here, a name two files assign is not
//! tracked by value, and another file's function is coloured as one.
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
//! Not here: completion, hover, go-to-definition. Those need a resolver and a
//! symbol table this crate does not have - it reads source text without
//! executing it, which is the property that makes it safe to run on every
//! keystroke. Claiming those capabilities and answering emptily is worse than
//! not claiming them: an editor that is told a server provides completion
//! stops offering its own word-based fallback. Formatting does not share the
//! problem: its answer comes from rules that read text, and when there is
//! nothing to fix, an empty answer is the true one.
use crate::config::{Layer, Policy, selector};
use crate::jsonrpc::{INVALID_REQUEST, receive, send};
use q_lint_rs::{
    FileIndex, Finding, TokenKind, Workspace, fix_all, fix_for, index, semantic_tokens_in,
    whole_edit,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, Write},
};

/// Full document sync (`TextDocumentSyncKind.Full`): every change carries the
/// whole buffer. Incremental sync would save bytes on a large file and cost a
/// patch-application routine whose bugs present as "the linter is looking at
/// text that is not on screen". At these file sizes the bytes are not worth it.
const SYNC_FULL: i64 = 1;

const METHOD_NOT_FOUND: i64 = -32601;
const SERVER_NOT_INITIALIZED: i64 = -32002;

/// Open documents, by URI. The editor is the authority on their contents from
/// didOpen until didClose, so nothing here reads from disk.
type Documents = HashMap<String, String>;

/// What every `.q` file in the workspace defines, so a name another file
/// defines is not undefined in this one and another file's function is
/// coloured as one. Files are read, never run - the property this server
/// exists to keep.
///
/// The editor's buffer wins over the disk for an open file; a closed one is
/// read back from disk, and a file changed outside the editor arrives as a
/// `workspace/didChangeWatchedFiles` notification.
#[derive(Default)]
struct Index {
    files: HashMap<String, FileIndex>,
    ws: Workspace,
}

/// Directories a workspace scan does not enter: version control, build
/// output and dependency trees hold no q the user is writing.
const SKIPPED: [&str; 5] = ["node_modules", "target", "__pycache__", "venv", "dist"];
/// A bound on the scan, so a workspace opened at `/` cannot stall the server.
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 4 << 20;

impl Index {
    /// Record what `path` defines. Whether it changed is what tells the
    /// caller other open files need linting again.
    fn set(&mut self, path: &str, file: FileIndex) -> bool {
        let path = &file_key(path);
        if self.files.get(path) == Some(&file) {
            return false;
        }
        if let Some(old) = self.files.remove(path) {
            self.ws.remove(&old);
        }
        self.ws.add(&file);
        self.files.insert(path.to_string(), file);
        true
    }

    fn remove(&mut self, path: &str) -> bool {
        match self.files.remove(&file_key(path)) {
            Some(old) => {
                self.ws.remove(&old);
                true
            }
            None => false,
        }
    }

    /// Read `path` from disk, or forget it when it is gone or unreadable.
    fn reload(&mut self, path: &str) -> bool {
        match std::fs::read(path) {
            Ok(bytes) if is_q_path(path) => self.set(path, index(&String::from_utf8_lossy(&bytes))),
            _ => self.remove(path),
        }
    }

    /// Every `.q` file under the workspace folders, less those `exclude`
    /// names. A pattern is matched against the path relative to the folder it
    /// is under, with `/` between components, as VS Code's globs are; a
    /// directory it names is not entered at all.
    fn scan(&mut self, roots: &[String], exclude: &[glob::Pattern]) {
        let mut stack: Vec<(std::path::PathBuf, std::path::PathBuf)> =
            roots.iter().map(|r| (r.into(), r.into())).collect();
        let excluded = |root: &std::path::Path, path: &std::path::Path| {
            let Ok(relative) = path.strip_prefix(root) else {
                return false;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            let options = glob::MatchOptions {
                require_literal_separator: true,
                ..Default::default()
            };
            exclude.iter().any(|p| p.matches_with(&relative, options))
        };
        let mut seen = 0;
        while let Some((root, dir)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if excluded(&root, &path) {
                    continue;
                }
                if kind.is_dir() {
                    if !name.starts_with('.') && !SKIPPED.contains(&name.as_str()) {
                        stack.push((root.clone(), path));
                    }
                } else if kind.is_file()
                    && is_q_path(&name)
                    && entry.metadata().is_ok_and(|m| m.len() <= MAX_BYTES)
                {
                    self.reload(&path.to_string_lossy());
                    seen += 1;
                    if seen >= MAX_FILES {
                        return;
                    }
                }
            }
        }
    }
}

/// The folders an `initialize` request names, as filesystem paths: its
/// `workspaceFolders`, or the older single `rootUri`.
fn workspace_roots(params: &Value) -> Vec<String> {
    let mut roots: Vec<String> = params["workspaceFolders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["uri"].as_str())
        .filter(|u| u.starts_with("file://"))
        .map(path_of)
        .collect();
    if roots.is_empty()
        && let Some(root) = params["rootUri"]
            .as_str()
            .filter(|u| u.starts_with("file://"))
    {
        roots.push(path_of(root));
    }
    roots
}

/// What a client asked for in `initializationOptions`. Every field defaults
/// to what the server did before there were any, so a client that sends
/// nothing - every editor but VS Code, unless configured - sees no change:
///
/// ```json
/// {"lint": {"select": [], "ignore": [], "run": "onType", "severity": {}},
///  "fixes": {"unsafe": true}, "format": {"enable": true},
///  "semanticTokens": {"enable": true},
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

pub fn serve(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    policy: &Policy,
) -> Result<u8, String> {
    let mut docs: Documents = HashMap::new();
    let mut idx = Index::default();
    let mut roots: Vec<String> = vec![];
    let mut opts = Options::default();
    let mut problems: Vec<String> = vec![];
    let mut initialized = false;
    let mut shutdown_requested = false;
    loop {
        let message = match receive(reader)? {
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
        let method = message["method"].as_str().unwrap_or("").to_string();
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        match (method.as_str(), id) {
            ("initialize", Some(id)) => {
                roots = workspace_roots(&params);
                let layer;
                (opts, layer, problems) = Options::read(&params);
                if layer.select.is_some() || !layer.ignore.is_empty() {
                    policy.narrow(layer);
                }
                send(writer, json!({"id": id, "result": capabilities(&opts)}))?;
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
                if opts.index {
                    idx.scan(&roots, &opts.index_exclude);
                }
                for (uri, text) in &docs {
                    idx.set(&path_of(uri), index(text));
                }
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
                send(writer, json!({"id": id, "result": Value::Null}))?;
            }

            ("textDocument/didOpen", None) => {
                let uri = uri_of(&params["textDocument"]);
                let text = params["textDocument"]["text"].as_str().unwrap_or("");
                publish(
                    writer,
                    &mut docs,
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
                        docs.insert(uri, text.to_string());
                    } else {
                        publish(
                            writer,
                            &mut docs,
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
                    publish(writer, &mut docs, &mut idx, uri, text, policy, &opts)?;
                }
            }
            ("textDocument/didClose", None) => {
                let uri = uri_of(&params["textDocument"]);
                docs.remove(&uri);
                // The buffer is gone, so the disk is the authority again - and
                // unsaved definitions it held no longer define anything.
                if idx.reload(&path_of(&uri)) {
                    relint(writer, &docs, &idx, None, policy, &opts)?;
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
                let data = docs
                    .get(&uri)
                    .filter(|_| opts.semantic_tokens && is_q_path(&path_of(&uri)))
                    .map_or_else(Vec::new, |text| encode_tokens(text, &idx.ws));
                send(writer, json!({"id": id, "result": {"data": data}}))?;
            }
            ("textDocument/codeAction", Some(id)) => {
                let actions = code_actions(&params, &docs, &idx.ws, policy, opts.unsafe_fixes);
                send(writer, json!({"id": id, "result": actions}))?;
            }
            ("textDocument/formatting", Some(id)) => {
                let edits = if opts.format {
                    format(&params, &docs, &idx.ws, policy)
                } else {
                    vec![]
                };
                send(writer, json!({"id": id, "result": edits}))?;
            }

            // A `.q` file created, changed or deleted outside the editor - a
            // pull, a checkout, another tool. An open file's buffer still wins.
            ("workspace/didChangeWatchedFiles", None) => {
                let mut changed = false;
                for change in params["changes"].as_array().into_iter().flatten() {
                    let uri = uri_of(change);
                    // A configuration file changed: every file it governs may
                    // now report differently, so forget them all and relint.
                    if is_config_path(&path_of(&uri)) {
                        policy.reset();
                        changed = true;
                        continue;
                    }
                    if docs.contains_key(&uri) {
                        continue;
                    }
                    let path = path_of(&uri);
                    changed |= if change["type"].as_i64() == Some(3) {
                        idx.remove(&path)
                    } else {
                        idx.reload(&path)
                    };
                }
                if changed {
                    relint(writer, &docs, &idx, None, policy, &opts)?;
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
    }
}

/// What the server offers. Formatting and semantic tokens a client turned
/// off are not announced at all, so the editor uses another provider - its
/// own grammar's colours, another formatter - rather than an empty answer.
fn capabilities(opts: &Options) -> Value {
    let mut capabilities = json!({
        "textDocumentSync": SYNC_FULL,
        "codeActionProvider": true,
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
    std::path::Path::new(path).file_name().is_some_and(|n| {
        ["qlinter.toml", ".qlinter.toml", "pyproject.toml"].contains(&&*n.to_string_lossy())
    })
}

fn code_actions(
    params: &Value,
    docs: &Documents,
    ws: &Workspace,
    policy: &Policy,
    unsafe_fixes: bool,
) -> Vec<Value> {
    if let Some(only) = params["context"]["only"].as_array()
        && !only.iter().any(|kind| {
            kind.as_str()
                .is_some_and(|kind| kind == "quickfix" || kind.starts_with("quickfix."))
        })
    {
        return vec![];
    }
    let uri = uri_of(&params["textDocument"]);
    let Some(source) = docs.get(&uri) else {
        return vec![];
    };
    let path = path_of(&uri);
    if !std::path::Path::new(&path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("q"))
    {
        return vec![];
    }
    let Some(context) = params["context"]["diagnostics"].as_array() else {
        return vec![];
    };
    let mut actions = vec![];
    // Every finding that has a fix, the editor-only ones included unless the
    // client turned them off: here a person sees each edit and accepts it or
    // not.
    for finding in policy.lint(source, &path, ws).unwrap_or_default() {
        let current = diagnostic(&finding, source);
        let Some(client_diagnostic) = context.iter().find(|d| {
            d["code"] == current["code"]
                && d["range"]["start"] == current["range"]["start"]
                && d["message"] == current["message"]
        }) else {
            continue;
        };
        let Some(fix) = fix_for(&finding, source).filter(|f| f.batch_safe || unsafe_fixes) else {
            continue;
        };
        // The edit's range comes from the fix, not from the diagnostic. The
        // two coincide for an operator swapped in place, but `f x` becomes
        // `f[x]` by replacing the whole application while the diagnostic
        // underlines only the name.
        let lines = Lines::new(source);
        let range = json!({
            "start": lines.json(fix.start),
            "end": lines.json(fix.end),
        });
        let mut changes = serde_json::Map::new();
        changes.insert(
            uri.clone(),
            json!([{"range": range, "newText": fix.replacement}]),
        );
        actions.push(json!({
            "title": fix.title,
            "kind": "quickfix",
            "diagnostics": [client_diagnostic],
            "edit": {"changes": changes},
        }));
    }
    actions
}

/// The edits "Format document" makes: the safe fixes `--fix` applies, to the
/// open buffer, under the same policy as its diagnostics. At most one edit,
/// from the first byte that changed to the last, and none at all when nothing
/// would - a document that is not open or not q, a broken structure, a
/// configuration that cannot be read, or nothing to fix.
fn format(params: &Value, docs: &Documents, ws: &Workspace, policy: &Policy) -> Vec<Value> {
    let uri = uri_of(&params["textDocument"]);
    let path = path_of(&uri);
    let Some(source) = docs.get(&uri).filter(|_| is_q_path(&path)) else {
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
fn publish(
    writer: &mut impl Write,
    docs: &mut Documents,
    idx: &mut Index,
    uri: String,
    text: String,
    policy: &Policy,
    opts: &Options,
) -> Result<(), String> {
    let path = path_of(&uri);
    let changed = is_q_path(&path) && idx.set(&path, index(&text));
    docs.insert(uri.clone(), text);
    diagnose(writer, &uri, &docs[&uri], &idx.ws, policy, opts)?;
    if changed {
        relint(writer, docs, idx, Some(&uri), policy, opts)?;
    }
    Ok(())
}

/// Lint every open document but `except` again.
fn relint(
    writer: &mut impl Write,
    docs: &Documents,
    idx: &Index,
    except: Option<&str>,
    policy: &Policy,
    opts: &Options,
) -> Result<(), String> {
    for (uri, text) in docs {
        if Some(uri.as_str()) != except {
            diagnose(writer, uri, text, &idx.ws, policy, opts)?;
        }
    }
    Ok(())
}

/// Lint one document and push its diagnostics.
fn diagnose(
    writer: &mut impl Write,
    uri: &str,
    text: &str,
    ws: &Workspace,
    policy: &Policy,
    opts: &Options,
) -> Result<(), String> {
    let path = path_of(uri);
    // Only q source. A client may open anything - a `.k` file, a console
    // buffer, an untitled scratch, a `.txt` - and hand it to whichever server
    // claims the language. The rules here describe q and say nothing true
    // about k or about a REPL transcript, so a document that is not a `.q`
    // file gets an empty diagnostic list: that clears anything stale without
    // asserting something about a file this linter cannot read.
    let findings = if is_q_path(&path) {
        // Lenient, so this cannot fail: a configuration it cannot read is
        // reported once on stderr and the defaults govern its files.
        policy.lint(text, &path, ws).unwrap_or_default()
    } else {
        vec![]
    };
    let diagnostics: Vec<Value> = findings
        .iter()
        .map(|f| {
            let mut d = diagnostic(f, text);
            if let Some(level) = opts.severity_of(&f.code) {
                d["severity"] = json!(level);
            }
            d
        })
        .collect();
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
fn diagnostic(f: &Finding, source: &str) -> Value {
    let line = f.line.saturating_sub(1);
    let end_line = f.end_line.map_or(line, |l| l.saturating_sub(1));
    // No column means the rule found a line, not a span. Underlining from the
    // first non-blank character to the end of the line is what a reader means
    // by "this line": starting at 0 would decorate the indentation, and an
    // empty range would show nothing at all in some clients.
    let start = match f.column {
        Some(c) => q_offset(source, line, c.saturating_sub(1)),
        None => {
            let text = q_line(source, line);
            q_offset(source, line, 0) + text.len() - text.trim_start().len()
        }
    };
    let end = match f.end_column {
        Some(c) => q_offset(source, end_line, c.saturating_sub(1)),
        None => q_offset(source, end_line, 0) + q_line(source, end_line).len(),
    };
    let lines = Lines::new(source);
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
/// none of them is a line high after a stray carriage return. Nothing comes
/// the other way: documents are synced whole, and a code action's
/// diagnostics are matched against ranges made here.
struct Lines<'a> {
    source: &'a str,
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    fn new(source: &'a str) -> Self {
        let bytes = source.as_bytes();
        let mut starts = vec![0];
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' || b == b'\r' && bytes.get(i + 1) != Some(&b'\n') {
                starts.push(i + 1);
            }
        }
        Lines { source, starts }
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
}

/// The text of a 0-based line as q counts lines - ended by `\n` alone - less
/// its line ending.
fn q_line(source: &str, line: usize) -> &str {
    let text = source.split('\n').nth(line).unwrap_or("");
    text.strip_suffix('\r').unwrap_or(text)
}

/// The byte offset of a finding's position: the 0-based `line` as q counts
/// lines, and `column` UTF-16 code units into it, which is how a finding
/// measures one. A column past the line's end is its end.
fn q_offset(source: &str, line: usize, column: usize) -> usize {
    let start = if line == 0 {
        0
    } else {
        match source.match_indices('\n').nth(line - 1) {
            Some((at, _)) => at + 1,
            None => return source.len(),
        }
    };
    let text = q_line(source, line);
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units >= column {
            return start + i;
        }
        units += c.len_utf16();
    }
    start + text.len()
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// A `file:` URI as a filesystem path.
///
/// Hand-rolled rather than pulling in a URL crate: the only scheme an editor
/// sends for a document on disk is `file:`, and the only transformation that
/// matters is percent-decoding - without it every path containing a space
/// arrives as `%20` and the filename-based rules see a file that does not
/// exist. A URI that is not `file:` (an untitled buffer, say) is handed
/// through unchanged, so it still gets linted and simply has no useful path.
fn path_of(uri: &str) -> String {
    let Some(rest) = uri.strip_prefix("file://") else {
        return uri.to_string();
    };
    // Strip the empty authority: file:///a/b has a host of "", so the path
    // begins at the third slash.
    let rest = rest.strip_prefix('/').unwrap_or(rest);
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
    if re_drive(&decoded) {
        decoded
    } else {
        format!("/{decoded}")
    }
}

fn re_drive(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// One spelling per file, for the index: the editor's URI and the folder scan
/// reach the same file as `c:/a/b.q` and `C:\a\b.q` on Windows, and two keys
/// for one file would count its own definitions as another file's.
fn file_key(path: &str) -> String {
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
        assert_eq!(path_of("untitled:Untitled-1"), "untitled:Untitled-1");
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
        let d = diagnostic(&f, source);
        assert_eq!(d["range"]["start"]["line"], 0);
        assert_eq!(d["range"]["end"]["character"], utf16_len("a:1 / \u{1F600}"));
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
            .map(|f| diagnostic(f, source))
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
    fn severity_names_map_to_the_protocols_numbers() {
        assert_eq!(severity("error"), 1);
        assert_eq!(severity("warning"), 2);
        assert_eq!(severity("anything else"), 2);
    }
}
