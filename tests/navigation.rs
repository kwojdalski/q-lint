//! Navigation: the outline, workspace symbols, go to definition, find
//! references, highlights and renaming a local - first as the library reads
//! one file, then as the language server answers an editor over a workspace.
use q_lint_rs::{Name, mentions, name_at, rename, rename_target};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{Receiver, channel},
    time::Duration,
};

/// Each global `source` mentions: the text at the mention, the name it
/// resolves to, and `w` for a write or `r` for a read.
fn seen(source: &str) -> Vec<(&str, String, char)> {
    mentions(source)
        .iter()
        .map(|m| {
            let kind = if m.definition.is_some() { 'w' } else { 'r' };
            (&source[m.at..m.at + m.len], m.name.clone(), kind)
        })
        .collect()
}

/// Where `context` starts in `source`, `skip` bytes in: the cursor on one
/// name of a line too short to count columns in by eye.
fn at(source: &str, context: &str, skip: usize) -> usize {
    source.find(context).expect("the context is in the source") + skip
}

#[test]
fn a_global_is_named_as_q_resolves_it_under_the_context_in_force() {
    let source = "g:1\nf:{[a] a+g}\n\\d .ns\nh:{f[x]+g}\n.other.v:h 2\n";
    assert_eq!(
        seen(source),
        [
            ("g", "g".to_string(), 'w'),
            ("f", "f".into(), 'w'),
            ("g", "g".into(), 'r'),
            ("h", ".ns.h".into(), 'w'),
            ("f", ".ns.f".into(), 'r'),
            ("g", ".ns.g".into(), 'r'),
            (".other.v", ".other.v".into(), 'w'),
            ("h", ".ns.h".into(), 'r'),
        ]
    );
    // Before the first `\d` a bare name is in whichever context the file is
    // loaded in; after it, the file has said.
    let implicit: Vec<bool> = mentions(source).iter().map(|m| m.implicit).collect();
    assert_eq!(
        implicit,
        [true, true, true, false, false, false, false, false]
    );
}

#[test]
fn a_string_a_comment_and_a_system_command_mention_nothing() {
    let source = "s:\"f in a string\"\n/ f in a comment\n\\l f.q\nt:1 / f again\n";
    assert_eq!(
        seen(source),
        [("s", "s".to_string(), 'w'), ("t", "t".into(), 'w')]
    );
}

#[test]
fn a_column_and_a_builtin_are_no_global() {
    // `a:` and `b:` in a table literal and `total:` in a query are written
    // as assignments and assign nothing; `count` and `til` are q's own.
    let source = "t:([] a:til 3; b:3#0)\nn:count select total:sum a from t\n";
    assert_eq!(
        seen(source),
        [
            ("t", "t".to_string(), 'w'),
            ("n", "n".into(), 'w'),
            ("a", "a".into(), 'r'),
            ("t", "t".into(), 'r'),
        ]
    );
}

#[test]
fn every_way_of_writing_a_global_is_a_definition_at_its_name() {
    let source = "`tab set ([] a:1 2)\n@[`.;`amended;:;5]\n.cfg[`key]:1\n\
                  init:{`.app.state set x; counter::0}\n";
    let writes: Vec<(&str, String)> = seen(source)
        .into_iter()
        .filter(|(_, _, kind)| *kind == 'w')
        .map(|(text, name, _)| (text, name))
        .collect();
    assert_eq!(
        writes,
        [
            ("tab", "tab".to_string()),
            ("amended", "amended".into()),
            ("key", ".cfg.key".into()),
            ("init", "init".into()),
            (".app.state", ".app.state".into()),
            ("counter", "counter".into()),
        ]
    );
}

#[test]
fn a_definition_carries_its_kind_its_signature_and_its_statement() {
    let source = "limit:10\nadd:{[a;b]\n  a+b}\nneg1:{neg x}\n";
    let all = mentions(source);
    let defined: Vec<_> = all
        .iter()
        .filter_map(|m| Some((m.name.as_str(), m.definition.as_ref()?)))
        .map(|(name, d)| (name, d.function, d.detail.as_str(), &source[d.start..d.end]))
        .collect();
    assert_eq!(
        defined,
        [
            ("limit", false, "", "limit:10"),
            ("add", true, "[a;b]", "add:{[a;b]\n  a+b}"),
            // An implicit signature is not written, so there is none to show.
            ("neg1", true, "", "neg1:{neg x}"),
        ]
    );
}

/// The local at `offset`: each place it is named, as text offsets, with the
/// index of the one declaring it.
fn local(source: &str, offset: usize) -> (Vec<usize>, Option<usize>) {
    match name_at(source, offset) {
        Some(Name::Local(local)) => (local.places.iter().map(|p| p.at).collect(), local.declared),
        other => panic!("a local was expected, not {other:?}"),
    }
}

#[test]
fn a_local_is_every_place_its_own_lambda_names_it() {
    let source = "f:{[a;b] c:a+b; {[a] a*2} c*a}\n";
    // The parameter, its two reads - and not the inner lambda's own `a`.
    assert_eq!(
        local(source, at(source, "[a;b]", 1)),
        (vec![4, 11, 28], Some(0))
    );
    assert_eq!(
        local(source, at(source, "{[a] a*2}", 2)),
        (vec![18, 21], Some(0))
    );
    // A local is declared where it is first assigned.
    assert_eq!(local(source, at(source, "c*a", 0)), (vec![9, 26], Some(0)));
    // The cursor just after a name is still on it.
    assert_eq!(local(source, at(source, "c:a+b", 1)).0, vec![9, 26]);
}

#[test]
fn a_multiple_assignment_declares_each_name_it_binds() {
    let source = "f:{[d] (p;q):d; p+q}\n";
    let Some(Name::Local(p)) = name_at(source, at(source, "p+q", 0)) else {
        panic!("p is a local");
    };
    assert_eq!(p.declared, Some(0));
    assert!(p.places[0].write && !p.places[1].write);
}

#[test]
fn a_name_outside_any_lambda_is_a_global_and_whitespace_is_nothing() {
    let source = "g:1\nf:{g+1}\n";
    assert_eq!(
        name_at(source, at(source, "g+1", 0)),
        Some(Name::Global {
            at: 7,
            len: 1,
            names: vec![("g".into(), true)]
        })
    );
    assert_eq!(name_at("a:1\n\n  \nb:2\n", 5), None);
    // q's own words are not names to go to.
    assert_eq!(name_at("n:count 1 2\n", 4), None);
}

#[test]
fn renaming_a_local_rewrites_each_place_and_nothing_else() {
    let source = "a:1\nf:{[a;b] c:a+b; {[a] a*2} c*a}\n";
    let edits = rename(source, at(source, "c*a", 2), "left").unwrap();
    assert_eq!(edits, [(8, 1), (15, 1), (32, 1)]);
    assert_eq!(rename_target(source, at(source, "c*a", 2)), Ok((32, 1)));
}

/// Why renaming the name at `context`+`skip` to `new` is refused.
fn refusal(source: &str, context: &str, skip: usize, new: &str) -> String {
    rename(source, at(source, context, skip), new).expect_err("the rename is refused")
}

#[test]
fn a_global_is_never_renamed() {
    let source = "g:1\nf:{[a] a+g}\n";
    for offset in [0, at(source, "a+g", 2)] {
        let why = rename(source, offset, "h").unwrap_err();
        assert!(why.contains("parameters and locals only"), "{why}");
        assert_eq!(rename_target(source, offset), Err(why));
    }
}

#[test]
fn an_implicit_parameter_is_not_renamed() {
    let why = refusal("f:{x+1}\n", "x+1", 0, "v");
    assert!(why.contains("implicit parameter"), "{why}");
}

#[test]
fn a_local_read_in_a_query_is_not_renamed_since_it_may_be_a_column() {
    let source = "f:{[t;lim] select from t where size>lim}\n";
    let why = refusal(source, "[t;lim]", 3, "cap");
    assert!(why.contains("qSQL"), "{why}");
    // The table after `from` is no column.
    assert_eq!(
        rename(source, at(source, "[t;lim]", 1), "tbl")
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn a_new_name_has_to_be_one_the_lambda_can_take() {
    let source = "f:{[a;b] c:a+b; g c}\n";
    assert!(refusal(source, "[a;b]", 1, "1a").contains("not a name"));
    assert!(refusal(source, "[a;b]", 1, "a.b").contains("not a name"));
    assert!(refusal(source, "[a;b]", 1, "count").contains("builtin"));
    // Another local, and a global the lambda reads, which the new name
    // would hide.
    assert!(refusal(source, "[a;b]", 1, "b").contains("already uses"));
    assert!(refusal(source, "[a;b]", 1, "c").contains("already uses"));
    assert!(refusal(source, "[a;b]", 1, "g").contains("already uses"));
    // To its own name is no change, and no refusal.
    assert_eq!(
        rename(source, at(source, "[a;b]", 1), "a").unwrap().len(),
        2
    );
    // A local called x in a lambda without a signature is an argument.
    let why = refusal("f:{a:1; a+2}\n", "a:1", 0, "x");
    assert!(why.contains("implicit parameter"), "{why}");
}

// ---------------------------------------------------------------------------
// The language server, driven as an editor drives it.

struct Server {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    next_id: u64,
}

/// Every framed message on `stdout`, until it closes.
fn read_messages(stdout: ChildStdout) -> Receiver<Value> {
    let (sender, messages) = channel();
    std::thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        loop {
            let mut length = 0;
            loop {
                let mut line = String::new();
                if stdout.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.strip_prefix("Content-Length: ") {
                    length = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            if stdout.read_exact(&mut body).is_err()
                || sender.send(serde_json::from_slice(&body).unwrap()).is_err()
            {
                return;
            }
        }
    });
    messages
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn file_uri(path: &Path) -> String {
    let path = path.display().to_string().replace('\\', "/");
    if path.starts_with('/') {
        format!("file://{path}")
    } else {
        format!("file:///{path}")
    }
}

/// What an editor declares, as far as navigation reads it.
fn client() -> Value {
    json!({"textDocument": {
        "documentSymbol": {"hierarchicalDocumentSymbolSupport": true},
        "rename": {"prepareSupport": true},
    }})
}

impl Server {
    /// A server over the workspace `dir`, holding `files`, with what the
    /// client declares and the options it sends.
    fn over(dir: &Path, files: &[(&str, &str)], client: Value, options: Value) -> (Self, Value) {
        for (name, text) in files {
            std::fs::write(dir.join(name), text).unwrap();
        }
        let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(dir)
            .env("XDG_CONFIG_HOME", dir.join("no-such-config-home"))
            .args(["--lsp"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn qlinter --lsp");
        let stdin = child.stdin.take().unwrap();
        let messages = read_messages(child.stdout.take().unwrap());
        let mut server = Server {
            child,
            stdin,
            messages,
            next_id: 1,
        };
        let reply = server.request(
            "initialize",
            json!({"capabilities": client, "initializationOptions": options,
                   "workspaceFolders": [{"uri": file_uri(dir), "name": "ws"}]}),
        );
        server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
        (server, reply)
    }

    fn start(dir: &Path, files: &[(&str, &str)]) -> Self {
        Self::over(dir, files, client(), Value::Null).0
    }

    fn send(&mut self, value: Value) {
        let body = serde_json::to_vec(&value).unwrap();
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.stdin.write_all(&body).unwrap();
        self.stdin.flush().unwrap();
    }

    /// The reply to a request, past the diagnostics pushed meanwhile.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        loop {
            let message = self
                .messages
                .recv_timeout(Duration::from_secs(30))
                .expect("the server answers");
            if message["id"] == id {
                return message;
            }
        }
    }

    fn open(&mut self, dir: &Path, name: &str, text: &str) -> String {
        let uri = file_uri(&dir.join(name));
        self.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
            "params":{"textDocument":{"uri":uri,"languageId":"q","version":1,"text":text}}}));
        uri
    }

    /// A request about the name at `context`+`skip` in the open document
    /// `uri`, whose text is `text`.
    fn ask(
        &mut self,
        method: &str,
        uri: &str,
        text: &str,
        context: &str,
        skip: usize,
        extra: Value,
    ) -> Value {
        let offset = at(text, context, skip);
        let line = text[..offset].matches('\n').count();
        let character = text[..offset]
            .rsplit('\n')
            .next()
            .unwrap()
            .encode_utf16()
            .count();
        let mut params = json!({"textDocument": {"uri": uri},
                                "position": {"line": line, "character": character}});
        for (key, value) in extra.as_object().into_iter().flatten() {
            params[key] = value.clone();
        }
        self.request(method, params)
    }
}

/// A range as `(line, start character, end character)`; no name spans lines.
fn span(range: &Value) -> (u64, u64, u64) {
    (
        range["start"]["line"].as_u64().unwrap(),
        range["start"]["character"].as_u64().unwrap(),
        range["end"]["character"].as_u64().unwrap(),
    )
}

/// Locations as `(file name, line, start, end)`, in order.
fn places(result: &Value) -> Vec<(String, u64, u64, u64)> {
    let mut out: Vec<_> = result
        .as_array()
        .unwrap_or_else(|| panic!("a list of locations, not {result}"))
        .iter()
        .map(|l| {
            let uri = l["uri"].as_str().unwrap();
            let (line, start, end) = span(&l["range"]);
            (
                uri.rsplit('/').next().unwrap().to_string(),
                line,
                start,
                end,
            )
        })
        .collect();
    out.sort();
    out
}

fn place(file: &str, line: u64, start: u64, end: u64) -> (String, u64, u64, u64) {
    (file.to_string(), line, start, end)
}

const LIB: &str = "\\d .lib\nadd:{[a;b] a+b}\nlimit:10\n\\d .\nroot_fn:{[v] v*2}\n";
const MAIN: &str = "\\l lib.q\ntotal:.lib.add[1;2]\ncalc:{[n] m:n+.lib.limit; root_fn m}\n\
                    \\d .lib\ntwice:{add[x;x]}\n";

#[test]
fn navigation_is_announced_and_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let (_, reply) = Server::over(dir.path(), &[], client(), Value::Null);
    let capabilities = &reply["result"]["capabilities"];
    for provider in [
        "documentSymbolProvider",
        "workspaceSymbolProvider",
        "definitionProvider",
        "referencesProvider",
        "documentHighlightProvider",
    ] {
        assert_eq!(capabilities[provider], true, "{provider}");
    }
    assert_eq!(
        capabilities["renameProvider"],
        json!({"prepareProvider": true})
    );
    // The options form is only for a client that prepares a rename.
    let (_, reply) = Server::over(dir.path(), &[], json!({}), Value::Null);
    assert_eq!(reply["result"]["capabilities"]["renameProvider"], true);

    // Off, nothing is announced - and a client that asks anyway is told
    // there is nothing, not that the method does not exist.
    let options = json!({"navigation": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", LIB)], client(), options);
    let capabilities = &reply["result"]["capabilities"];
    assert!(
        capabilities["definitionProvider"].is_null(),
        "{capabilities}"
    );
    assert!(capabilities["renameProvider"].is_null(), "{capabilities}");
    let uri = server.open(dir.path(), "main.q", MAIN);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        ".lib.add",
        5,
        json!({}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

#[test]
fn a_definition_is_found_in_another_file_under_the_context_it_is_written_in() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let lib_add = [place("lib.q", 1, 0, 3)];
    // Qualified, and bare under the `\d .lib` main.q switches to.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        ".lib.add",
        5,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), lib_add);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        "add[x;x]",
        0,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), lib_add);
    // lib.q is back at the root by the time it defines root_fn.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        "root_fn m",
        3,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("lib.q", 4, 0, 7)]);
    // The file was never opened: its location is the one a client can open.
    let found = reply["result"][0]["uri"].as_str().unwrap();
    assert!(
        found.starts_with("file://") && found.ends_with("/lib.q"),
        "{found}"
    );
}

#[test]
fn a_local_goes_to_its_declaration_and_an_unknown_name_nowhere() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        "root_fn m",
        8,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("main.q", 2, 10, 11)]);
    let reply = server.ask("textDocument/definition", &uri, MAIN, "m:n+", 2, json!({}));
    assert_eq!(places(&reply["result"]), [place("main.q", 2, 7, 8)]);
    // A name nothing defines, and a place that is no name at all.
    let text = "f:{missing x}\n\n";
    let uri = server.open(dir.path(), "other.q", text);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "missing",
        2,
        json!({}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
    let reply = server.request(
        "textDocument/definition",
        json!({"textDocument": {"uri": uri}, "position": {"line": 1, "character": 0}}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

#[test]
fn an_open_buffer_is_read_as_the_editor_has_it_not_as_the_disk_does() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    // Unsaved: a comment above pushes the definition a line down.
    server.open(dir.path(), "lib.q", &format!("/ moved\n{LIB}"));
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        ".lib.add",
        5,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("lib.q", 2, 0, 3)]);
}

#[test]
fn a_file_loaded_under_a_context_defines_its_names_there() {
    let dir = tempfile::tempdir().unwrap();
    let part = "helper:{x+1}\nuse:{helper x}\n";
    let files = [("loader.q", "\\d .a\n\\l part.q\n"), ("part.q", part)];
    let mut server = Server::start(dir.path(), &files);
    let text = "r:.a.helper 3\n";
    let uri = server.open(dir.path(), "user.q", text);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        ".a.helper",
        4,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("part.q", 0, 0, 6)]);
    // And part.q's own bare read of it is a reference to the same name.
    let reply = server.ask(
        "textDocument/references",
        &uri,
        text,
        ".a.helper",
        4,
        json!({}),
    );
    assert_eq!(
        places(&reply["result"]),
        [
            place("part.q", 0, 0, 6),
            place("part.q", 1, 5, 11),
            place("user.q", 0, 2, 11)
        ]
    );
}

#[test]
fn a_name_only_its_namespace_or_dot_q_defines_goes_there() {
    let dir = tempfile::tempdir().unwrap();
    let files = [("cfg.q", ".cfg:`n`m!1 2\n"), ("q.q", ".q.answer:{42}\n")];
    let mut server = Server::start(dir.path(), &files);
    let text = "v:.cfg.n\n\\d .u\nf:{answer[]}\n";
    let uri = server.open(dir.path(), "user.q", text);
    // `.cfg` is assigned whole, which is where `.cfg.n` comes from.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        ".cfg.n",
        5,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("cfg.q", 0, 0, 4)]);
    // q looks in `.q` from every context for a name nothing else defines.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "answer",
        0,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("q.q", 0, 0, 9)]);
    let reply = server.ask(
        "textDocument/references",
        &uri,
        text,
        "answer",
        0,
        json!({}),
    );
    assert_eq!(
        places(&reply["result"]),
        [place("q.q", 0, 0, 9), place("user.q", 2, 3, 9)]
    );
}

#[test]
fn references_are_every_file_that_names_it_with_or_without_the_declaration() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let reads = [place("main.q", 1, 6, 14), place("main.q", 4, 7, 10)];
    let reply = server.ask(
        "textDocument/references",
        &uri,
        MAIN,
        ".lib.add",
        5,
        json!({}),
    );
    let mut all = vec![place("lib.q", 1, 0, 3)];
    all.extend(reads.clone());
    assert_eq!(places(&reply["result"]), all);
    let context = json!({"context": {"includeDeclaration": false}});
    let reply = server.ask(
        "textDocument/references",
        &uri,
        MAIN,
        ".lib.add",
        5,
        context.clone(),
    );
    assert_eq!(places(&reply["result"]), reads);

    // A local's are in its own lambda, and its declaration is the one place
    // left out.
    let reply = server.ask("textDocument/references", &uri, MAIN, "m:n+", 0, json!({}));
    assert_eq!(
        places(&reply["result"]),
        [place("main.q", 2, 10, 11), place("main.q", 2, 34, 35)]
    );
    let reply = server.ask("textDocument/references", &uri, MAIN, "m:n+", 0, context);
    assert_eq!(places(&reply["result"]), [place("main.q", 2, 34, 35)]);
}

#[test]
fn highlights_mark_a_write_apart_from_a_read() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "n:0\nbump:{n::n+1; t:x; t+:1; t}\n";
    let uri = server.open(dir.path(), "a.q", text);
    let marks = |reply: &Value| -> Vec<((u64, u64, u64), u64)> {
        reply["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| (span(&h["range"]), h["kind"].as_u64().unwrap()))
            .collect()
    };
    // LSP's DocumentHighlightKind: 2 is a read, 3 a write.
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        text,
        "n::n",
        0,
        json!({}),
    );
    assert_eq!(
        marks(&reply),
        [((0, 0, 1), 3), ((1, 6, 7), 3), ((1, 9, 10), 2)]
    );
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        text,
        "t:x",
        0,
        json!({}),
    );
    assert_eq!(
        marks(&reply),
        [((1, 14, 15), 3), ((1, 19, 20), 3), ((1, 25, 26), 2)]
    );
}

#[test]
fn the_outline_lists_what_the_document_assigns() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "lib.q", LIB);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    let symbols = reply["result"].as_array().unwrap();
    let outline: Vec<_> = symbols
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap(),
                s["kind"].as_u64().unwrap(),
                s["detail"].as_str().unwrap(),
                span(&s["range"]),
                span(&s["selectionRange"]),
            )
        })
        .collect();
    // LSP's SymbolKind: 12 is a function, 13 a variable.
    assert_eq!(
        outline,
        [
            (".lib.add", 12, "[a;b]", (1, 0, 15), (1, 0, 3)),
            (".lib.limit", 13, "", (2, 0, 8), (2, 0, 5)),
            ("root_fn", 12, "[v]", (4, 0, 17), (4, 0, 7)),
        ]
    );

    // A name assigned again is one line, where it is first assigned - and
    // each assignment is still a definition to go to.
    let text = "state:0\nreset:{state::0}\nstate:1\n";
    let uri = server.open(dir.path(), "state.q", text);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    let names: Vec<_> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["name"].as_str().unwrap(), span(&s["selectionRange"])))
        .collect();
    assert_eq!(names, [("state", (0, 0, 5)), ("reset", (1, 0, 5))]);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "state::0",
        0,
        json!({}),
    );
    assert_eq!(
        places(&reply["result"]),
        [
            place("state.q", 0, 0, 5),
            place("state.q", 1, 7, 12),
            place("state.q", 2, 0, 5)
        ]
    );

    // A client that does not take the nested form gets the flat one.
    let dir = tempfile::tempdir().unwrap();
    let (mut server, _) = Server::over(dir.path(), &[], json!({}), Value::Null);
    let uri = server.open(dir.path(), "lib.q", LIB);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    let flat = reply["result"].as_array().unwrap();
    assert_eq!(flat.len(), 3);
    assert_eq!(flat[0]["name"], ".lib.add");
    assert_eq!(flat[0]["location"]["uri"], uri);
    assert_eq!(span(&flat[0]["location"]["range"]), (1, 0, 3));
}

#[test]
fn workspace_symbols_match_a_query_whatever_its_case() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB), ("main.q", MAIN)]);
    let names = |reply: &Value| -> Vec<(String, u64)> {
        let mut names: Vec<_> = reply["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    s["name"].as_str().unwrap().to_string(),
                    s["kind"].as_u64().unwrap(),
                )
            })
            .collect();
        names.sort();
        names
    };
    let reply = server.request("workspace/symbol", json!({"query": "LIB.A"}));
    assert_eq!(names(&reply), [(".lib.add".to_string(), 12)]);
    assert_eq!(
        places(&json!([reply["result"][0]["location"]])),
        [place("lib.q", 1, 0, 3)]
    );
    let reply = server.request("workspace/symbol", json!({"query": "t"}));
    assert_eq!(
        names(&reply),
        [
            (".lib.limit".to_string(), 13),
            (".lib.twice".into(), 12),
            ("root_fn".into(), 12),
            ("total".into(), 13),
        ]
    );
    // An empty query is every symbol.
    let reply = server.request("workspace/symbol", json!({"query": ""}));
    assert_eq!(names(&reply).len(), 6);
}

#[test]
fn a_local_is_renamed_in_its_own_document_and_a_global_refused_with_the_reason() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let reply = server.ask(
        "textDocument/prepareRename",
        &uri,
        MAIN,
        "m:n+",
        0,
        json!({}),
    );
    assert_eq!(span(&reply["result"]["range"]), (2, 10, 11));
    assert_eq!(reply["result"]["placeholder"], "m");
    let new = json!({"newName": "sum_"});
    let reply = server.ask("textDocument/rename", &uri, MAIN, "m:n+", 0, new.clone());
    let edits = reply["result"]["changes"][&uri].as_array().unwrap();
    let spans: Vec<_> = edits.iter().map(|e| span(&e["range"])).collect();
    assert_eq!(spans, [(2, 10, 11), (2, 34, 35)]);
    assert!(edits.iter().all(|e| e["newText"] == "sum_"));
    assert_eq!(reply["result"]["changes"].as_object().unwrap().len(), 1);

    // LSP 3.17's RequestFailed, with why - which an editor shows.
    for method in ["textDocument/prepareRename", "textDocument/rename"] {
        let reply = server.ask(method, &uri, MAIN, "root_fn m", 0, new.clone());
        assert_eq!(reply["error"]["code"], -32803, "{reply}");
        let message = reply["error"]["message"].as_str().unwrap();
        assert!(message.contains("parameters and locals only"), "{message}");
    }
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        MAIN,
        "m:n+",
        0,
        json!({"newName": "n"}),
    );
    assert_eq!(reply["error"]["code"], -32803, "{reply}");
}

#[test]
fn a_position_is_counted_in_utf16_units_as_a_client_counts_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    // `é` is one UTF-16 unit and two bytes; the emoji two units and four.
    let text = "f:{[v] s:\"é😀\"; s,v}\r\ng:{f x}\r\n";
    let uri = server.open(dir.path(), "a.q", text);
    let reply = server.request(
        "textDocument/references",
        json!({"textDocument": {"uri": uri}, "position": {"line": 0, "character": 18}}),
    );
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 4, 5), place("a.q", 0, 18, 19)]
    );
    // A position past the end of its line, or of the document, is its end.
    let reply = server.request(
        "textDocument/definition",
        json!({"textDocument": {"uri": uri}, "position": {"line": 1, "character": 99}}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
    let reply = server.request(
        "textDocument/definition",
        json!({"textDocument": {"uri": uri}, "position": {"line": 99, "character": 0}}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

#[test]
fn a_request_with_no_document_is_refused_and_one_for_an_unknown_document_empty() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let reply = server.request(
        "textDocument/definition",
        json!({"position": {"line": 0, "character": 0}}),
    );
    assert_eq!(reply["error"]["code"], -32602, "{reply}");
    // Never opened, and a buffer that is no `.q` file on disk.
    let unknown = file_uri(&dir.path().join("unopened.q"));
    let position = json!({"line": 0, "character": 0});
    let reply = server.request(
        "textDocument/references",
        json!({"textDocument": {"uri": unknown}, "position": position}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
        "params":{"textDocument":{"uri":"untitled:Untitled-1","languageId":"q","version":1,"text":"f:{x}\n"}}}));
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": "untitled:Untitled-1"}}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
}
