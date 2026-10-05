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
//! requested with textDocument/codeAction, and semantic tokens - the colour
//! of a function at the places it is called, and of a parameter where its
//! body reads it - with textDocument/semanticTokens/full.
//!
//! A workspace index: every `.q` file under the workspace folders is read at
//! startup - never run - for the global names it defines, and kept current
//! from open buffers, closes, and workspace/didChangeWatchedFiles. A name
//! another file defines is not undefined here, a name two files assign is not
//! tracked by value, and another file's function is coloured as one.
//!
//! Not here: completion, hover, go-to-definition, formatting. Those need a
//! resolver and a symbol table this crate does not have - it reads source text
//! without executing it, which is the property that makes it safe to run on
//! every keystroke. Claiming those capabilities and answering emptily is worse
//! than not claiming them: an editor that is told a server provides completion
//! stops offering its own word-based fallback.
use crate::jsonrpc::{receive, send};
use q_lint_rs::{
    FileIndex, Finding, Profile, TokenKind, Workspace, fix_for, index, lint_in, semantic_tokens_in,
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
const INVALID_REQUEST: i64 = -32600;

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
        match self.files.remove(path) {
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

    /// Every `.q` file under the workspace folders.
    fn scan(&mut self, roots: &[String]) {
        let mut stack: Vec<std::path::PathBuf> = roots.iter().map(Into::into).collect();
        let mut seen = 0;
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() {
                    if !name.starts_with('.') && !SKIPPED.contains(&name.as_str()) {
                        stack.push(path);
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

pub fn serve(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    profile: Profile,
    ignore: &[String],
) -> Result<u8, String> {
    let mut docs: Documents = HashMap::new();
    let mut idx = Index::default();
    let mut roots: Vec<String> = vec![];
    let mut shutdown_requested = false;
    loop {
        let Some(message) = receive(reader)? else {
            // The stream closed without `exit`. Editors are supposed to send
            // it; when one dies instead, leaving cleanly is the friendlier
            // behaviour and matches what rust-analyzer does.
            return Ok(if shutdown_requested { 0 } else { 1 });
        };
        let method = message["method"].as_str().unwrap_or("").to_string();
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        match (method.as_str(), id) {
            ("initialize", Some(id)) => {
                roots = workspace_roots(&params);
                send(writer, json!({"id": id, "result": capabilities()}))?;
            }
            // Indexed once the client is ready rather than inside initialize,
            // so a large workspace does not hold up the handshake.
            ("initialized", None) => {
                idx.scan(&roots);
                for (uri, text) in &docs {
                    idx.set(&path_of(uri), index(text));
                }
            }
            ("shutdown", Some(id)) => {
                shutdown_requested = true;
                docs.clear();
                send(writer, json!({"id": id, "result": Value::Null}))?;
            }
            ("exit", _) => return Ok(if shutdown_requested { 0 } else { 1 }),

            // A request after shutdown is the one protocol error worth
            // answering rather than ignoring: the client is confused and
            // should be told, not left waiting for a reply that never comes.
            (_, Some(id)) if shutdown_requested => send(
                writer,
                json!({"id": id, "error": {"code": INVALID_REQUEST, "message": "server is shut down"}}),
            )?,

            ("textDocument/didOpen", None) => {
                let uri = uri_of(&params["textDocument"]);
                let text = params["textDocument"]["text"].as_str().unwrap_or("");
                publish(
                    writer,
                    &mut docs,
                    &mut idx,
                    uri,
                    text.to_string(),
                    profile,
                    ignore,
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
                    publish(
                        writer,
                        &mut docs,
                        &mut idx,
                        uri,
                        text.to_string(),
                        profile,
                        ignore,
                    )?;
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
                    publish(writer, &mut docs, &mut idx, uri, text, profile, ignore)?;
                }
            }
            ("textDocument/didClose", None) => {
                let uri = uri_of(&params["textDocument"]);
                docs.remove(&uri);
                // The buffer is gone, so the disk is the authority again - and
                // unsaved definitions it held no longer define anything.
                if idx.reload(&path_of(&uri)) {
                    relint(writer, &docs, &idx, None, profile, ignore)?;
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
                    .filter(|_| is_q_path(&path_of(&uri)))
                    .map_or_else(Vec::new, |text| encode_tokens(text, &idx.ws));
                send(writer, json!({"id": id, "result": {"data": data}}))?;
            }
            ("textDocument/codeAction", Some(id)) => {
                let actions = code_actions(&params, &docs, &idx.ws, profile, ignore);
                send(writer, json!({"id": id, "result": actions}))?;
            }

            // A `.q` file created, changed or deleted outside the editor - a
            // pull, a checkout, another tool. An open file's buffer still wins.
            ("workspace/didChangeWatchedFiles", None) => {
                let mut changed = false;
                for change in params["changes"].as_array().into_iter().flatten() {
                    let uri = uri_of(change);
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
                    relint(writer, &docs, &idx, None, profile, ignore)?;
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

fn capabilities() -> Value {
    json!({
        "capabilities": {
            "textDocumentSync": SYNC_FULL,
            "codeActionProvider": true,
            "semanticTokensProvider": {
                "legend": {"tokenTypes": TOKEN_TYPES, "tokenModifiers": []},
                "full": true,
            },
        },
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
    for (at, len, kind) in semantic_tokens_in(source, ws) {
        let line = source[..at].matches('\n').count();
        let line_start = source[..at].rfind('\n').map_or(0, |p| p + 1);
        let start = utf16_len(&source[line_start..at]);
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
fn code_actions(
    params: &Value,
    docs: &Documents,
    ws: &Workspace,
    profile: Profile,
    ignore: &[String],
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
    for finding in lint_in(source, &path, profile, ws)
        .into_iter()
        .filter(|f| matches!(f.code.as_str(), "QE004" | "QE005" | "QP006"))
        .filter(|f| !ignore.contains(&f.code))
    {
        let current = diagnostic(&finding, source);
        let Some(client_diagnostic) = context.iter().find(|d| {
            d["code"] == current["code"]
                && d["range"]["start"] == current["range"]["start"]
                && d["message"] == current["message"]
        }) else {
            continue;
        };
        let Some(fix) = fix_for(&finding, source) else {
            continue;
        };
        // The edit's range comes from the fix, not from the diagnostic. The
        // two coincide for an operator swapped in place, but `f x` becomes
        // `f[x]` by replacing the whole application while the diagnostic
        // underlines only the name.
        let range = json!({
            "start": position_at(source, fix.start),
            "end": position_at(source, fix.end),
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

/// Take a document's new text: index it, lint it, push its diagnostics - and
/// when what it defines changed, lint the other open documents again, since a
/// name it now defines (or no longer does) can change their findings.
fn publish(
    writer: &mut impl Write,
    docs: &mut Documents,
    idx: &mut Index,
    uri: String,
    text: String,
    profile: Profile,
    ignore: &[String],
) -> Result<(), String> {
    let path = path_of(&uri);
    let changed = is_q_path(&path) && idx.set(&path, index(&text));
    docs.insert(uri.clone(), text);
    diagnose(writer, &uri, &docs[&uri], &idx.ws, profile, ignore)?;
    if changed {
        relint(writer, docs, idx, Some(&uri), profile, ignore)?;
    }
    Ok(())
}

/// Lint every open document but `except` again.
fn relint(
    writer: &mut impl Write,
    docs: &Documents,
    idx: &Index,
    except: Option<&str>,
    profile: Profile,
    ignore: &[String],
) -> Result<(), String> {
    for (uri, text) in docs {
        if Some(uri.as_str()) != except {
            diagnose(writer, uri, text, &idx.ws, profile, ignore)?;
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
    profile: Profile,
    ignore: &[String],
) -> Result<(), String> {
    let path = path_of(uri);
    // Only q source. A client may open anything - a `.k` file, a console
    // buffer, an untitled scratch, a `.txt` - and hand it to whichever server
    // claims the language. The rules here describe q and say nothing true
    // about k or about a REPL transcript, so a document that is not a `.q`
    // file gets an empty diagnostic list: that clears anything stale without
    // asserting something about a file this linter cannot read.
    let findings = if is_q_path(&path) {
        let mut found = lint_in(text, &path, profile, ws);
        found.retain(|f| !ignore.contains(&f.code));
        found
    } else {
        vec![]
    };
    let diagnostics: Vec<Value> = findings.iter().map(|f| diagnostic(f, text)).collect();
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
fn diagnostic(f: &Finding, source: &str) -> Value {
    let line = f.line.saturating_sub(1);
    let end_line = f.end_line.map_or(line, |l| l.saturating_sub(1));
    let start_char = f.column.map_or(0, |c| c.saturating_sub(1));
    // No column means the rule found a line, not a span. Underlining from the
    // first non-blank character to the end of the line is what a reader means
    // by "this line": starting at 0 would decorate the indentation, and an
    // empty range would show nothing at all in some clients.
    let end_char = match f.end_column {
        Some(c) => c.saturating_sub(1),
        None => utf16_len(line_text(source, end_line)),
    };
    let start_char = if f.column.is_none() {
        indent_utf16(line_text(source, line))
    } else {
        start_char
    };
    let mut d = json!({
        "range": {
            "start": {"line": line, "character": start_char},
            "end": {"line": end_line, "character": end_char.max(start_char)},
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

/// A byte offset as the line and UTF-16 character an editor addresses it by.
fn position_at(source: &str, byte: usize) -> Value {
    let before = &source[..byte.min(source.len())];
    let line = before.matches('\n').count();
    let start = before.rfind('\n').map_or(0, |at| at + 1);
    json!({"line": line, "character": utf16_len(&before[start..])})
}

fn line_text(source: &str, line: usize) -> &str {
    source.lines().nth(line).unwrap_or("")
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn indent_utf16(text: &str) -> usize {
    utf16_len(&text[..text.len() - text.trim_start().len()])
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
    let rest = rest.strip_prefix('/').map_or(rest, |r| r);
    let mut out = String::with_capacity(rest.len() + 1);
    out.push('/');
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&rest[i + 1..i + 3], 16)
        {
            out.push(byte as char);
            i += 3;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_escapes_decode_and_other_schemes_pass_through() {
        assert_eq!(path_of("file:///tmp/a%20b/c.q"), "/tmp/a b/c.q");
        assert_eq!(path_of("file:///tmp/plain.q"), "/tmp/plain.q");
        assert_eq!(path_of("untitled:Untitled-1"), "untitled:Untitled-1");
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
        let found = lint_in(source, "x.q", Profile::Style, &Workspace::default());
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
