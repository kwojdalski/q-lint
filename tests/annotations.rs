//! What the language server draws over a document: parameter names at a
//! call's arguments (inlay hints), Run lenses above definitions, links on
//! load paths - and the qDoc block a code action writes above a function.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{Receiver, channel},
    time::Duration,
};

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

    /// A request about the whole of the open document `uri`.
    fn whole(&mut self, method: &str, uri: &str, extra: Value) -> Value {
        let mut params = json!({"textDocument": {"uri": uri}});
        for (key, value) in extra.as_object().into_iter().flatten() {
            params[key] = value.clone();
        }
        self.request(method, params)
    }
}

/// What VS Code declares, as far as these requests read it.
fn client() -> Value {
    json!({"textDocument": {"codeAction": {"codeActionLiteralSupport":
        {"codeActionKind": {"valueSet": ["quickfix", "refactor"]}}}}})
}

/// A range as `(line, start character, end character)`; no name spans lines.
fn span(range: &Value) -> (u64, u64, u64) {
    (
        range["start"]["line"].as_u64().unwrap(),
        range["start"]["character"].as_u64().unwrap(),
        range["end"]["character"].as_u64().unwrap(),
    )
}

/// The whole of a short document, as an LSP range.
fn everything() -> Value {
    json!({"range": {"start": {"line": 0, "character": 0}, "end": {"line": 99, "character": 0}}})
}

/// Each hint as `(line, character, label)`, in order.
fn hints(reply: &Value) -> Vec<(u64, u64, String)> {
    reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("a list of hints, not {reply}"))
        .iter()
        .map(|h| {
            assert_eq!(h["kind"], 2, "{h}");
            (
                h["position"]["line"].as_u64().unwrap(),
                h["position"]["character"].as_u64().unwrap(),
                h["label"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn hint(line: u64, character: u64, label: &str) -> (u64, u64, String) {
    (line, character, label.to_string())
}

const LIB: &str = "\\d .lib\nadd:{[a;b] a+b}\nscale:{x*y}\n\\d .\n\
                   twice:{[v] 2*v}\ntwice:{[w] 2*w}\nrate:{[px;qty] px*qty}\n";

#[test]
fn a_call_to_a_workspace_function_shows_its_parameter_names() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let main = "\\l lib.q\n\
                t:.lib.add[1;2]\n\
                p:.lib.add[;2]\n\
                u:.lib.scale[3;4]\n\
                v:twice[5]\n\
                w:rate[px;10 20]\n\
                f:{[add] add[1;2]}\n\
                \\d .lib\n\
                s:add [ 1 ; (2;3) ]\n";
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.whole("textDocument/inlayHint", &uri, everything());
    assert_eq!(
        hints(&reply),
        [
            // Qualified, and bare under `\d .lib`, with a space before the
            // bracket and blanks inside it.
            hint(1, 11, "a:"),
            hint(1, 13, "b:"),
            // A projection's empty slot has none.
            hint(2, 12, "b:"),
            // `scale` declares no signature, `twice` two that differ, `rate`'s
            // first argument is its parameter's own name, and the local
            // `add` is no call to `.lib.add`.
            hint(5, 10, "qty:"),
            hint(8, 8, "a:"),
            hint(8, 12, "b:"),
        ],
        "{reply}"
    );
    // A range asks for the calls in it only.
    let reply = server.whole(
        "textDocument/inlayHint",
        &uri,
        json!({"range": {"start": {"line": 5, "character": 0}, "end": {"line": 5, "character": 99}}}),
    );
    assert_eq!(hints(&reply), [hint(5, 10, "qty:")]);
}

#[test]
fn inlay_hints_are_announced_and_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let (_, reply) = Server::over(dir.path(), &[], client(), Value::Null);
    assert_eq!(reply["result"]["capabilities"]["inlayHintProvider"], true);
    // The inferred types (`tests/assist.rs`) are inlay hints too: with
    // them on, parameter names alone off leaves the provider and no name.
    let options = json!({"inlayHints": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", LIB)], client(), options);
    assert_eq!(reply["result"]["capabilities"]["inlayHintProvider"], true);
    let main = "t:.lib.add[1;2]\n";
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.whole("textDocument/inlayHint", &uri, everything());
    assert_eq!(reply["result"], json!([]), "{reply}");
    let options = json!({"inlayHints": {"enable": false}, "inferredTypes": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", LIB)], client(), options);
    assert!(reply["result"]["capabilities"]["inlayHintProvider"].is_null());
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.whole("textDocument/inlayHint", &uri, everything());
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

/// Each lens as `(line, title, the code it runs)`, after checking it runs
/// the client's command on the document.
fn lenses(reply: &Value, uri: &str) -> Vec<(u64, String, String)> {
    reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("a list of lenses, not {reply}"))
        .iter()
        .map(|l| {
            let command = &l["command"];
            assert_eq!(command["command"], "q-lint.runDefinition", "{l}");
            assert_eq!(command["arguments"][1], uri, "{l}");
            (
                span(&l["range"]).0,
                command["title"].as_str().unwrap().to_string(),
                command["arguments"][0].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn lens(line: u64, title: &str, code: &str) -> (u64, String, String) {
    (line, title.to_string(), code.to_string())
}

#[test]
fn a_top_level_function_has_a_run_lens_and_a_test_a_run_test_lens_too() {
    let dir = tempfile::tempdir().unwrap();
    let options = json!({"codeLens": {"enable": true}});
    let (mut server, reply) = Server::over(dir.path(), &[], client(), options);
    assert_eq!(
        reply["result"]["capabilities"]["codeLensProvider"],
        json!({"resolveProvider": false})
    );
    let text = "add:{[a;b]\n  a+b}\nlimit:10\ntest_add:{[] add[1;2]}\n\
                outer:{inner::{x}; 1}\n\\d .qt.math\ntest_mul:{[] 2*3}\nhelp:{x}\n\\d .\n\
                .ns.f:{x}\n";
    let uri = server.open(dir.path(), "suite.q", text);
    let reply = server.whole("textDocument/codeLens", &uri, json!({}));
    assert_eq!(
        lenses(&reply, &uri),
        [
            // The whole statement, its continuation line too.
            lens(0, "Run", "add:{[a;b]\n  a+b}"),
            // Before the file's first `\d`: run and called where it lands.
            lens(3, "Run", "test_add:{[] add[1;2]}"),
            lens(3, "Run test", "test_add:{[] add[1;2]}\ntest_add[]"),
            // A function assigned inside another is no lens of its own.
            lens(4, "Run", "outer:{inner::{x}; 1}"),
            // Under `\d .qt.math`: sent under it, and called by its full name.
            lens(6, "Run", "\\d .qt.math\ntest_mul:{[] 2*3}\n\\d ."),
            lens(
                6,
                "Run test",
                "\\d .qt.math\ntest_mul:{[] 2*3}\n\\d .\n.qt.math.test_mul[]"
            ),
            lens(7, "Run", "\\d .qt.math\nhelp:{x}\n\\d ."),
            lens(9, "Run", ".ns.f:{x}"),
        ],
        "{reply}"
    );
}

#[test]
fn code_lenses_are_off_unless_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, reply) = Server::over(dir.path(), &[], client(), Value::Null);
    assert!(reply["result"]["capabilities"]["codeLensProvider"].is_null());
    let uri = server.open(dir.path(), "a.q", "f:{x}\n");
    let reply = server.whole("textDocument/codeLens", &uri, json!({}));
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

/// Each link as `(line, start, end, the target's path under `dir`)`.
fn links(reply: &Value, dir: &Path) -> Vec<(u64, u64, u64, String)> {
    let roots = [file_uri(&dir.canonicalize().unwrap()), file_uri(dir)];
    reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("a list of links, not {reply}"))
        .iter()
        .map(|l| {
            let (line, start, end) = span(&l["range"]);
            let target = l["target"].as_str().unwrap();
            let file = roots
                .iter()
                .find_map(|root| target.strip_prefix(&format!("{root}/")))
                .unwrap_or(target);
            (line, start, end, file.to_string())
        })
        .collect()
}

#[test]
fn each_load_path_links_to_the_file_it_loads() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib/sub")).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let files = [
        ("lib/util.q", "u:1\n"),
        ("lib/sub/a.q", "a:1\n"),
        ("lib/sub/b.q", "b:1\n"),
        ("app/local.q", "l:1\n"),
    ];
    let mut server = Server::start(dir.path(), &files);
    let text = "\\l lib/util.q\nsystem \"l local.q\"\n.q.x:`:lib/util.q\n\
                \\l lib/sub\n\\l missing.q\ns:\"\\\\l lib/util.q\"\n";
    std::fs::write(dir.path().join("app/main.q"), text).unwrap();
    let uri = server.open(dir.path(), "app/main.q", text);
    let reply = server.whole("textDocument/documentLink", &uri, json!({}));
    assert_eq!(
        links(&reply, dir.path()),
        [
            // Against the workspace folder, and the file's own directory.
            (0, 3, 13, "lib/util.q".to_string()),
            (1, 10, 17, "app/local.q".into()),
            // A file symbol `.Q.l`-style loads read.
            (2, 7, 17, "lib/util.q".into()),
            // A directory loads several, and a missing file nothing; a
            // string is no load.
        ],
        "{reply}"
    );
    let reply = &reply["result"][0];
    assert_eq!(reply["tooltip"], "Open lib/util.q", "{reply}");
}

#[test]
fn document_links_are_announced_and_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let (_, reply) = Server::over(dir.path(), &[], client(), Value::Null);
    assert_eq!(
        reply["result"]["capabilities"]["documentLinkProvider"],
        json!({"resolveProvider": false})
    );
    let options = json!({"documentLinks": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", "a:1\n")], client(), options);
    assert!(reply["result"]["capabilities"]["documentLinkProvider"].is_null());
    let uri = server.open(dir.path(), "main.q", "\\l lib.q\n");
    let reply = server.whole("textDocument/documentLink", &uri, json!({}));
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

/// The code actions offered at `line`:`character` of the open document
/// `uri`, with `only` when given.
fn actions_at(
    server: &mut Server,
    uri: &str,
    line: u64,
    character: u64,
    only: Option<Value>,
) -> Vec<Value> {
    let at = json!({"line": line, "character": character});
    let mut context = json!({"diagnostics": []});
    if let Some(only) = only {
        context["only"] = only;
    }
    let reply = server.whole(
        "textDocument/codeAction",
        uri,
        json!({"range": {"start": at, "end": at}, "context": context}),
    );
    reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("a list of actions, not {reply}"))
        .clone()
}

/// The text of the one qDoc action among `actions`, and its title.
fn qdoc(actions: &[Value], uri: &str) -> Option<(String, String, (u64, u64))> {
    let action = actions.iter().find(|a| a["kind"] == "refactor.rewrite")?;
    let edit = &action["edit"]["changes"][uri][0];
    Some((
        action["title"].as_str().unwrap().to_string(),
        edit["newText"].as_str().unwrap().to_string(),
        (
            edit["range"]["start"]["line"].as_u64().unwrap(),
            edit["range"]["start"]["character"].as_u64().unwrap(),
        ),
    ))
}

#[test]
fn a_qdoc_block_is_written_above_a_function_from_its_parameters() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "\\d .qf.mkt\n/ Folds level columns.\nfold:{[tbl;groups]\n  tbl}\n\
                twice:{2*x}\nlimit:10\n/ @param t the table\n/ @return it\ndone:{[t] t}\n\
                none:{[] 1}\n";
    let uri = server.open(dir.path(), "book.q", text);
    // Anywhere in the statement, its continuation line too: below the
    // description already there, so that stays on top.
    for (line, character) in [(2, 0), (3, 3)] {
        let actions = actions_at(&mut server, &uri, line, character, None);
        assert_eq!(
            qdoc(&actions, &uri),
            Some((
                "Generate qDoc for fold".to_string(),
                "/ @param tbl\n/ @param groups\n/ @return\n".to_string(),
                (2, 0)
            )),
            "{actions:?}"
        );
    }
    // The x a body reads; a signature with none; asked for by kind.
    let actions = actions_at(&mut server, &uri, 4, 2, Some(json!(["refactor"])));
    assert_eq!(qdoc(&actions, &uri).unwrap().1, "/ @param x\n/ @return\n");
    let actions = actions_at(&mut server, &uri, 9, 0, None);
    assert_eq!(qdoc(&actions, &uri).unwrap().1, "/ @return\n");
    // Not on a value, not where a block is already written, and not when
    // only quick fixes are asked for.
    for (line, only) in [(5, None), (8, None), (2, Some(json!(["quickfix"])))] {
        let actions = actions_at(&mut server, &uri, line, 0, only);
        assert_eq!(qdoc(&actions, &uri), None, "{line}: {actions:?}");
    }
}

#[test]
fn generating_qdoc_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    // The qSQL layout and the functional-form rewrite are rewrites too, so
    // they are off here as well.
    let options = json!({"generateQdoc": {"enable": false}, "qsqlLayout": {"enable": false},
        "functionalForm": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[], client(), options);
    assert_eq!(
        reply["result"]["capabilities"]["codeActionProvider"]["codeActionKinds"],
        json!([
            "quickfix",
            "source.fixAll.q-lint",
            "refactor.extract.function",
            "source.organizeImports.q-lint"
        ])
    );
    let uri = server.open(dir.path(), "a.q", "f:{[a] a}\n");
    let actions = actions_at(&mut server, &uri, 0, 0, None);
    assert_eq!(qdoc(&actions, &uri), None, "{actions:?}");
}

/// The actions offered over `start..end` (each `(line, character)`) of the
/// open document `uri`, with `only` when given.
fn actions_over(
    server: &mut Server,
    uri: &str,
    start: (u64, u64),
    end: (u64, u64),
    only: Option<Value>,
) -> Vec<Value> {
    let mut context = json!({"diagnostics": []});
    if let Some(only) = only {
        context["only"] = only;
    }
    let reply = server.whole(
        "textDocument/codeAction",
        uri,
        json!({"range": {"start": {"line": start.0, "character": start.1},
                         "end": {"line": end.0, "character": end.1}},
               "context": context}),
    );
    reply["result"].as_array().cloned().unwrap_or_default()
}

/// The text after applying the Extract Function action among `actions`.
fn extracted(actions: &[Value], uri: &str, text: &str) -> Option<(String, String)> {
    let action = actions
        .iter()
        .find(|a| a["kind"] == "refactor.extract.function" && a["edit"].is_object())?;
    let lines: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let offset = |p: &Value| {
        lines[p["line"].as_u64().unwrap() as usize] + p["character"].as_u64().unwrap() as usize
    };
    let mut edits: Vec<(usize, usize, String)> = action["edit"]["changes"][uri]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                offset(&e["range"]["start"]),
                offset(&e["range"]["end"]),
                e["newText"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    // From the end, so each edit's positions are still the original's.
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = text.to_string();
    for (start, end, new) in edits {
        out.replace_range(start..end, &new);
    }
    Some((action["title"].as_str().unwrap().to_string(), out))
}

#[test]
fn a_selection_is_extracted_into_a_lambda_of_the_locals_it_reads() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "\\d .m\nmid:{[bid;ask;w]\n  w*(bid+ask)%2}\n";
    let uri = server.open(dir.path(), "m.q", text);
    // In the lightbulb's request, and in the Refactor menu's.
    for only in [
        None,
        Some(json!(["refactor"])),
        Some(json!(["refactor.extract"])),
    ] {
        let actions = actions_over(&mut server, &uri, (2, 4), (2, 15), only);
        assert_eq!(
            extracted(&actions, &uri, text),
            Some((
                "Extract function as extracted".to_string(),
                "\\d .m\nextracted:{[bid;ask] (bid+ask)%2}\nmid:{[bid;ask;w]\n  w*extracted[bid;ask]}\n"
                    .to_string()
            )),
            "{actions:?}"
        );
    }
    // A cursor is no selection; quick fixes alone are not refactors.
    let actions = actions_over(&mut server, &uri, (2, 4), (2, 4), None);
    assert!(
        actions
            .iter()
            .all(|a| a["kind"] != "refactor.extract.function"),
        "{actions:?}"
    );
    let actions = actions_over(
        &mut server,
        &uri,
        (2, 4),
        (2, 15),
        Some(json!(["quickfix"])),
    );
    assert_eq!(extracted(&actions, &uri, text), None);
    // `w*(bid` is no value of the expression: nothing in the lightbulb.
    let actions = actions_over(&mut server, &uri, (2, 2), (2, 8), None);
    assert!(
        actions
            .iter()
            .all(|a| a["kind"] != "refactor.extract.function"),
        "{actions:?}"
    );
}

#[test]
fn a_refused_extraction_says_why_to_a_client_that_shows_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut capabilities = client();
    capabilities["textDocument"]["codeAction"]["disabledSupport"] = json!(true);
    let (mut server, _) = Server::over(dir.path(), &[], capabilities, Value::Null);
    let uri = server.open(dir.path(), "a.q", "f:{[x;y;z] x+y*z}\n");
    let actions = actions_over(
        &mut server,
        &uri,
        (0, 11),
        (0, 14),
        Some(json!(["refactor.extract"])),
    );
    let action = actions
        .iter()
        .find(|a| a["kind"] == "refactor.extract.function")
        .unwrap_or_else(|| panic!("{actions:?}"));
    assert!(action["edit"].is_null(), "{action}");
    assert!(
        action["disabled"]["reason"]
            .as_str()
            .unwrap()
            .contains("not a value"),
        "{action}"
    );
    // The lightbulb is not told.
    let actions = actions_over(&mut server, &uri, (0, 11), (0, 14), None);
    assert!(
        actions
            .iter()
            .all(|a| a["kind"] != "refactor.extract.function"),
        "{actions:?}"
    );
}

#[test]
fn extract_function_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let options = json!({"extractFunction": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[], client(), options);
    assert_eq!(
        reply["result"]["capabilities"]["codeActionProvider"]["codeActionKinds"],
        json!([
            "quickfix",
            "source.fixAll.q-lint",
            "refactor.rewrite",
            "source.organizeImports.q-lint"
        ])
    );
    let text = "f:{[a;b] a+b*2}\n";
    let uri = server.open(dir.path(), "a.q", text);
    let actions = actions_over(
        &mut server,
        &uri,
        (0, 11),
        (0, 14),
        Some(json!(["refactor"])),
    );
    assert_eq!(extracted(&actions, &uri, text), None, "{actions:?}");
}

#[test]
fn the_workspace_tests_are_listed_with_the_code_that_runs_them() {
    let dir = tempfile::tempdir().unwrap();
    let suite = "\\d .qt.m\nhelper:{x}\ntest_add:{[] 2~1+1}\ntestQunit:{[] 1b}\n\\d .\n";
    let bare = "test_top:{[] 1b}\nnot_a_test:{[] 0b}\ntestlower:{[] 1b}\n";
    let mut server = Server::start(
        dir.path(),
        &[("suite.q", suite), ("bare.q", bare), ("none.q", "a:1\n")],
    );
    let reply = server.request("q-lint/tests", json!({}));
    let files = reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"));
    type Listed = (String, String, String);
    let listed: Vec<(String, Vec<Listed>)> = files
        .iter()
        .map(|f| {
            let uri = f["uri"].as_str().unwrap();
            let name = uri.rsplit('/').next().unwrap().to_string();
            let tests = f["tests"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| {
                    (
                        t["name"].as_str().unwrap().to_string(),
                        t["code"].as_str().unwrap().to_string(),
                        t["call"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            (name, tests)
        })
        .collect();
    assert_eq!(
        listed,
        vec![
            (
                "bare.q".to_string(),
                vec![(
                    "test_top".into(),
                    "test_top:{[] 1b}".into(),
                    "test_top[]".into()
                )]
            ),
            (
                "suite.q".to_string(),
                vec![
                    (
                        "test_add".into(),
                        "\\d .qt.m\ntest_add:{[] 2~1+1}\n\\d .".into(),
                        ".qt.m.test_add[]".into()
                    ),
                    (
                        "testQunit".into(),
                        "\\d .qt.m\ntestQunit:{[] 1b}\n\\d .".into(),
                        ".qt.m.testQunit[]".into()
                    ),
                ]
            ),
        ]
    );
    // One document's, by its URI; its range is the name.
    let uri = file_uri(&dir.path().join("suite.q"));
    let reply = server.request("q-lint/tests", json!({"textDocument": {"uri": uri}}));
    let tests = &reply["result"][0]["tests"];
    assert_eq!(tests.as_array().unwrap().len(), 2, "{reply}");
    assert_eq!(span(&tests[0]["range"]), (2, 0, 8));
}

#[test]
fn the_global_at_a_position_is_named_as_q_resolves_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "\\d .lib\nrate:10\nf:{[px] px*rate}\n\\d .\ng:{count x}\n";
    let uri = server.open(dir.path(), "lib.q", text);
    let at = |server: &mut Server, line: u64, character: u64| {
        server.whole(
            "q-lint/globalAt",
            &uri,
            json!({"position": {"line": line, "character": character}}),
        )["result"]
            .clone()
    };
    let got = at(&mut server, 2, 12);
    assert_eq!(got["names"], json!([".lib.rate"]), "{got}");
    assert_eq!(span(&got["range"]), (2, 11, 15));
    // A parameter, a word of q's, a blank: nothing to ask a process about.
    assert_eq!(at(&mut server, 2, 9), Value::Null);
    assert_eq!(at(&mut server, 4, 4), Value::Null);
    assert_eq!(at(&mut server, 3, 3), Value::Null);
}

#[test]
fn the_names_no_workspace_file_defines_are_listed_for_the_process() {
    let dir = tempfile::tempdir().unwrap();
    let lib = "\\d .lib\nrate:10\n\\d .\n";
    let mut server = Server::start(dir.path(), &[("lib.q", lib)]);
    let text = "f:{[px] px*.lib.rate+.lib.missing+other}\n\
                g:{select from trade where sym=px, size>limit}\n\
                h:{.z.p+.Q.dd[x;y]+count x}\n";
    let uri = server.open(dir.path(), "main.q", text);
    let reply = server.whole("q-lint/unresolvedNames", &uri, json!({}));
    let got: Vec<(String, (u64, u64, u64))> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            (
                n["written"].as_str().unwrap().to_string(),
                span(&n["range"]),
            )
        })
        .collect();
    // Not `.lib.rate` (lib.q), `f` and `g` (here), the parameter, the
    // columns, q's words or its one-letter namespaces: the table is asked
    // about, the columns are not.
    assert_eq!(
        got,
        vec![
            (".lib.missing".to_string(), (0, 21, 33)),
            ("other".to_string(), (0, 34, 39)),
            ("trade".to_string(), (1, 15, 20)),
        ],
        "{reply}"
    );
}

/// The one qSQL layout action among `actions`: its title and new text.
fn qsql(actions: &[Value], uri: &str) -> Option<(String, String)> {
    let action = actions
        .iter()
        .find(|a| a["title"] == "Lay out qSQL query on aligned lines")?;
    assert_eq!(action["kind"], "refactor.rewrite");
    let edit = &action["edit"]["changes"][uri][0];
    Some((
        edit["newText"].as_str().unwrap().to_string(),
        format!(
            "{}:{}-{}:{}",
            edit["range"]["start"]["line"],
            edit["range"]["start"]["character"],
            edit["range"]["end"]["line"],
            edit["range"]["end"]["character"]
        ),
    ))
}

const QUERY: &str = "a:1\nr:select n:count i by sym from trade where px>1, sz<400\n";

#[test]
fn the_qsql_query_at_the_cursor_is_laid_out_on_aligned_lines() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "q.q", QUERY);
    let laid = Some((
        "select n:count i\n      by sym\n    from trade\n   where px>1, sz<400".to_string(),
        "1:2-1:55".to_string(),
    ));
    // Anywhere in it, asked for by kind or by the lightbulb.
    for (character, only) in [(2, None), (30, None), (40, Some(json!(["refactor"])))] {
        let actions = actions_at(&mut server, &uri, 1, character, only);
        assert_eq!(qsql(&actions, &uri), laid, "{actions:?}");
    }
    // Not outside a query, nor when only quick fixes are asked for.
    for (line, only) in [(0, None), (1, Some(json!(["quickfix"])))] {
        let actions = actions_at(&mut server, &uri, line, 5, only);
        assert_eq!(qsql(&actions, &uri), None, "{line}: {actions:?}");
    }
    // Formatting does not lay it out unless asked to.
    let reply = server.whole(
        "textDocument/formatting",
        &uri,
        json!({"options": {"tabSize": 4, "insertSpaces": true}}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
}

#[test]
fn formatting_lays_out_long_qsql_queries_when_asked_to() {
    let dir = tempfile::tempdir().unwrap();
    let options = json!({"qsqlLayout": {"onFormat": true, "lineLength": 40}});
    let (mut server, _) = Server::over(dir.path(), &[], client(), options);
    // The safe fix (`==` to `=`) and the layout, as one edit.
    let text = "b:1==1\nr:select n:count i by sym from trade where px>1, sz<400\nc:select from t\n";
    let uri = server.open(dir.path(), "f.q", text);
    let opts = json!({"options": {"tabSize": 4, "insertSpaces": true}});
    let reply = server.whole("textDocument/formatting", &uri, opts.clone());
    let edits = reply["result"].as_array().unwrap();
    assert_eq!(edits.len(), 1, "{reply}");
    let edit = &edits[0];
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    assert_eq!(edit["range"]["start"]["line"], 0);
    assert_eq!(edit["range"]["end"]["line"], 1);
    let start = edit["range"]["start"]["character"].as_u64().unwrap() as usize;
    let end = edit["range"]["end"]["character"].as_u64().unwrap() as usize;
    let joined = format!("{}\n{}", lines[0], lines[1]);
    let line0_len = lines[0].len() + 1;
    let new = format!(
        "{}{}{}",
        &joined[..start],
        edit["newText"].as_str().unwrap(),
        &joined[line0_len + end..]
    );
    lines.splice(0..2, [new]);
    assert_eq!(
        lines.join("\n"),
        "b:1=1\nr:select n:count i\n      by sym\n    from trade\n   where px>1, sz<400\nc:select from t"
    );
}

#[test]
fn the_qsql_layout_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let options = json!({"qsqlLayout": {"enable": false, "onFormat": true, "lineLength": 3}});
    let (mut server, _) = Server::over(dir.path(), &[], client(), options);
    let uri = server.open(dir.path(), "q.q", QUERY);
    let actions = actions_at(&mut server, &uri, 1, 5, None);
    assert_eq!(qsql(&actions, &uri), None, "{actions:?}");
    let reply = server.whole(
        "textDocument/formatting",
        &uri,
        json!({"options": {"tabSize": 4, "insertSpaces": true}}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
}

/// The functional-form rewrite among `actions` with `title`: its new text,
/// or its reason where it is offered disabled.
fn rewrite(actions: &[Value], uri: &str, title: &str) -> Option<String> {
    let action = actions.iter().find(|a| a["title"] == title)?;
    assert_eq!(action["kind"], "refactor.rewrite");
    if let Some(reason) = action["disabled"]["reason"].as_str() {
        return Some(format!("disabled: {reason}"));
    }
    Some(
        action["edit"]["changes"][uri][0]["newText"]
            .as_str()
            .unwrap()
            .to_string(),
    )
}

const TO_FUNCTIONAL: &str = "Rewrite qSQL query in functional form";
const TO_QSQL: &str = "Rewrite functional form as qSQL";

#[test]
fn a_qsql_query_and_its_functional_form_rewrite_each_other() {
    let dir = tempfile::tempdir().unwrap();
    let text = "r:select n:count i by sym from t where px>1\ns:?[t;enlist (>;`px;1);0b;()]\nu:select[2] from t\n";
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "q.q", text);
    let actions = actions_at(&mut server, &uri, 0, 5, None);
    assert_eq!(
        rewrite(&actions, &uri, TO_FUNCTIONAL).as_deref(),
        Some("?[t;enlist (>;`px;1);(enlist`sym)!enlist `sym;(enlist`n)!enlist (count;`i)]"),
        "{actions:?}"
    );
    let actions = actions_at(&mut server, &uri, 1, 3, None);
    assert_eq!(
        rewrite(&actions, &uri, TO_QSQL).as_deref(),
        Some("select from t where px>1"),
        "{actions:?}"
    );
    // One that cannot be rewritten is left out of the lightbulb, and shown
    // disabled with the reason to a menu that asks for refactors.
    let actions = actions_at(&mut server, &uri, 2, 5, None);
    assert_eq!(rewrite(&actions, &uri, TO_FUNCTIONAL), None, "{actions:?}");
}

#[test]
fn a_refused_rewrite_says_why_to_a_client_that_shows_it() {
    let dir = tempfile::tempdir().unwrap();
    let client = json!({"textDocument": {"codeAction": {"disabledSupport": true,
        "codeActionLiteralSupport": {"codeActionKind": {"valueSet": ["quickfix", "refactor"]}}}}});
    let (mut server, _) = Server::over(dir.path(), &[], client, Value::Null);
    let uri = server.open(dir.path(), "q.q", "u:select[2] from t\n");
    let actions = actions_at(&mut server, &uri, 0, 5, Some(json!(["refactor"])));
    let got = rewrite(&actions, &uri, TO_FUNCTIONAL).unwrap();
    assert!(
        got.starts_with("disabled: Not rewritten: `select[...]`"),
        "{got}"
    );
}

#[test]
fn the_functional_form_rewrite_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let options = json!({"functionalForm": {"enable": false}});
    let (mut server, _) = Server::over(dir.path(), &[], client(), options);
    let uri = server.open(
        dir.path(),
        "q.q",
        "r:select from t where px>1\ns:?[t;();0b;()]\n",
    );
    for line in [0, 1] {
        let actions = actions_at(&mut server, &uri, line, 3, Some(json!(["refactor"])));
        assert_eq!(rewrite(&actions, &uri, TO_FUNCTIONAL), None, "{actions:?}");
        assert_eq!(rewrite(&actions, &uri, TO_QSQL), None, "{actions:?}");
    }
}

fn hover_text(server: &mut Server, uri: &str, line: u64, character: u64) -> String {
    let reply = server.request(
        "textDocument/hover",
        json!({"textDocument": {"uri": uri}, "position": {"line": line, "character": character}}),
    );
    reply["result"]["contents"]["value"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

#[test]
fn a_hover_on_a_query_says_it_in_words_unless_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let text = "r:select from t where px>1\ns:?[t;();0b;()]\n";
    let client = json!({"textDocument": {"hover": {"contentFormat": ["markdown"]}}});
    let (mut server, _) = Server::over(dir.path(), &[], client.clone(), Value::Null);
    let uri = server.open(dir.path(), "q.q", text);
    let words = hover_text(&mut server, &uri, 0, 4);
    assert!(
        words.contains("Keeps the rows where `px` is greater than `1`."),
        "{words}"
    );
    let words = hover_text(&mut server, &uri, 1, 2);
    assert!(
        words.contains("The functional form of `select from t`."),
        "{words}"
    );
    // Not on a column inside it.
    let words = hover_text(&mut server, &uri, 0, 23);
    assert!(!words.contains("In words"), "{words}");
    let options = json!({"qsqlExplain": {"enable": false}});
    let (mut server, _) = Server::over(dir.path(), &[], client, options);
    let uri = server.open(dir.path(), "q.q", text);
    for (line, character) in [(0, 4), (1, 2)] {
        let words = hover_text(&mut server, &uri, line, character);
        assert!(!words.contains("In words"), "{words}");
    }
}

impl Server {
    /// The codes of the next diagnostics published for `uri`.
    fn codes_for(&mut self, uri: &str) -> Vec<String> {
        loop {
            let message = self
                .messages
                .recv_timeout(Duration::from_secs(30))
                .expect("the server publishes");
            if message["method"] == "textDocument/publishDiagnostics"
                && message["params"]["uri"] == uri
            {
                return message["params"]["diagnostics"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|d| d["code"].as_str().unwrap_or("").to_string())
                    .collect();
            }
        }
    }
}

const TYPED: &str = "f:{s:`a; s+1}\nd:([a:1;b:2])\n";

#[test]
fn the_target_version_and_type_lints_reach_the_editor_unless_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("qlinter.toml"),
        "target-version = \"4.0\"\n",
    )
    .unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "t.q", TYPED);
    let codes = server.codes_for(&uri);
    assert!(codes.contains(&"QT035".to_string()), "{codes:?}");
    assert!(codes.contains(&"QK001".to_string()), "{codes:?}");
    let options = json!({"versionCheck": {"enable": false}, "typeLints": {"enable": false}});
    let (mut server, _) = Server::over(dir.path(), &[], client(), options);
    let uri = server.open(dir.path(), "t.q", TYPED);
    let codes = server.codes_for(&uri);
    assert!(
        !codes.iter().any(|c| c == "QT035" || c.starts_with("QK")),
        "{codes:?}"
    );
}

#[test]
fn a_configured_baseline_hides_its_findings_in_the_editor_unless_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let text = "f:{[desc] desc}\n";
    std::fs::write(dir.path().join("b.q"), text).unwrap();
    let written = std::process::Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .args(["--profile", "style", "--write-baseline", "base.json", "b.q"])
        .output()
        .unwrap();
    assert!(written.status.success(), "{written:?}");
    std::fs::write(
        dir.path().join("qlinter.toml"),
        "baseline = \"base.json\"\n",
    )
    .unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "b.q", text);
    assert_eq!(server.codes_for(&uri), Vec::<String>::new());
    let (mut server, _) = Server::over(
        dir.path(),
        &[],
        client(),
        json!({"baseline": {"enable": false}}),
    );
    let uri = server.open(dir.path(), "b.q", text);
    assert_eq!(server.codes_for(&uri), vec!["QF001".to_string()]);
}

#[test]
fn the_workspace_definitions_and_its_unused_functions_are_listed() {
    let dir = tempfile::tempdir().unwrap();
    let files = [
        (
            "a.q",
            "\\d .util\nused:{x+1}\nunused:{x*2}\ncallback:{x}\nn:5\n\\d .\n.z.ts:{.util.used 1}\n",
        ),
        (
            "b.q",
            ".timer.add[`callback];\ntop:{x}\nr:top 2\nlonely:{x}\nby_string:{x}\nvalue \"by_string 1\";\n",
        ),
        ("test_a.q", "test_thing:{.util.used 2}\n"),
    ];
    let (mut server, reply) = Server::over(dir.path(), &files, client(), Value::Null);
    assert_eq!(
        reply["result"]["capabilities"]["experimental"]["q-lint/deadCode"],
        true
    );
    let reply = server.request("q-lint/definitions", json!({}));
    let got: Vec<(String, String, String)> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                d["namespace"].as_str().unwrap().to_string(),
                d["name"].as_str().unwrap().to_string(),
                d["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let has = |ns: &str, name: &str, kind: &str| {
        got.contains(&(ns.to_string(), name.to_string(), kind.to_string()))
    };
    assert!(has(".util", ".util.used", "function"), "{got:?}");
    assert!(has(".util", ".util.n", "variable"), "{got:?}");
    assert!(has(".", "top", "function"), "{got:?}");
    assert!(has(".z", ".z.ts", "function"), "{got:?}");
    let reply = server.request("q-lint/deadCode", json!({}));
    let mut dead: Vec<String> = reply["result"]["functions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["name"].as_str().unwrap().to_string())
        .collect();
    dead.sort();
    // Not the ones read as code, by a symbol or in a string, nor a .z
    // handler or a test.
    assert_eq!(
        dead,
        vec![".util.unused".to_string(), "lonely".to_string()],
        "{reply}"
    );
    assert!(reply["result"]["dynamic"].as_u64().unwrap() >= 1, "{reply}");
}

#[test]
fn the_tests_reaching_the_functions_a_save_changed_are_listed() {
    let dir = tempfile::tempdir().unwrap();
    let lib = "add:{x+y}\ntwice:{add[x;x]}\nother:{x}\n";
    let files = [
        ("lib.q", lib),
        (
            "test_lib.q",
            "test_twice:{twice 2}\ntest_other:{other 1}\ntest_add:{add[1;2]}\n",
        ),
    ];
    let (mut server, _) = Server::over(dir.path(), &files, client(), Value::Null);
    let edited = "add:{x+y+0}\ntwice:{add[x;x]}\nother:{x}\n";
    let uri = server.open(dir.path(), "lib.q", edited);
    let reply = server.request(
        "q-lint/testsReaching",
        json!({"textDocument": {"uri": uri}, "previous": lib}),
    );
    assert_eq!(reply["result"]["changed"], json!(["add"]), "{reply}");
    let mut names: Vec<&str> = reply["result"]["tests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    names.sort();
    // Through `twice`, and directly; not the test of `other`.
    assert_eq!(names, ["test_add", "test_twice"], "{reply}");
    // Nothing changed, nothing to run.
    let reply = server.request(
        "q-lint/testsReaching",
        json!({"textDocument": {"uri": uri}, "previous": edited}),
    );
    assert_eq!(reply["result"]["tests"], json!([]), "{reply}");
}

/// The edits a `workspace/willRenameFiles` reply makes, as
/// `(file under dir, line, start, end, new text)`, in order.
fn renamed(reply: &Value, dir: &Path) -> Vec<(String, u64, u64, u64, String)> {
    let root = file_uri(dir);
    let mut out = vec![];
    for (uri, edits) in reply["result"]["changes"]
        .as_object()
        .unwrap_or_else(|| panic!("a workspace edit, not {reply}"))
    {
        let file = uri.strip_prefix(&format!("{root}/")).unwrap_or(uri);
        for edit in edits.as_array().unwrap() {
            let (line, start, end) = span(&edit["range"]);
            let text = edit["newText"].as_str().unwrap().to_string();
            out.push((file.to_string(), line, start, end, text));
        }
    }
    out
}

fn rename_params(dir: &Path, moves: &[(&str, &str)]) -> Value {
    let files: Vec<Value> = moves
        .iter()
        .map(|(old, new)| {
            json!({"oldUri": file_uri(&dir.join(old)), "newUri": file_uri(&dir.join(new))})
        })
        .collect();
    json!({"files": files})
}

#[test]
fn renaming_a_file_rewrites_the_loads_that_name_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib")).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let files = [
        ("lib/a.q", "a:1\n"),
        ("lib/other.q", "o:1\n"),
        (
            "main.q",
            "\\l lib/a.q\n\\l lib/other.q\nsystem \"l lib/a.q\"\n",
        ),
        ("lib/near.q", "\\l a.q\n"),
        ("app/up.q", "\\l ../lib/a.q\n"),
    ];
    let options = json!({"renameLoads": {"enable": true}});
    let (mut server, reply) = Server::over(dir.path(), &files, client(), options);
    let operations = &reply["result"]["capabilities"]["workspace"]["fileOperations"];
    assert!(operations["willRename"]["filters"].is_array(), "{reply}");
    let reply = server.request(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib/a.q", "lib/b.q")]),
    );
    assert_eq!(
        renamed(&reply, dir.path()),
        [
            // Each from the base it was written against.
            ("app/up.q".to_string(), 0, 3, 13, "../lib/b.q".to_string()),
            ("lib/near.q".into(), 0, 3, 6, "b.q".into()),
            ("main.q".into(), 0, 3, 10, "lib/b.q".into()),
            ("main.q".into(), 2, 10, 17, "lib/b.q".into()),
        ],
        "{reply}"
    );
}

#[test]
fn renaming_a_folder_rewrites_the_loads_under_it_and_moving_a_loader_its_own() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib/sub")).unwrap();
    let files = [
        ("lib/sub/x.q", "x:1\n"),
        // Inside the folder, and written from it: it moves with its target.
        ("lib/sub/y.q", "\\l x.q\n"),
        ("main.q", "\\l lib/sub/x.q\n\\l lib/sub/y.q\n"),
    ];
    let options = json!({"renameLoads": {"enable": true}});
    let (mut server, _) = Server::over(dir.path(), &files, client(), options);
    let reply = server.request(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib", "src")]),
    );
    assert_eq!(
        renamed(&reply, dir.path()),
        [
            ("main.q".to_string(), 0, 3, 14, "src/sub/x.q".to_string()),
            ("main.q".into(), 1, 3, 14, "src/sub/y.q".into()),
        ],
        "{reply}"
    );
    // A loader moved down a folder: its load from its own directory climbs.
    std::fs::write(dir.path().join("lib/sub/z.q"), "\\l x.q\n").unwrap();
    let reply = server.request(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib/sub/y.q", "lib/y.q")]),
    );
    let edits = renamed(&reply, dir.path());
    assert!(
        edits.contains(&("lib/sub/y.q".to_string(), 0, 3, 6, "sub/x.q".to_string())),
        "{reply}"
    );
    assert!(
        edits.contains(&("main.q".to_string(), 1, 3, 14, "lib/y.q".to_string())),
        "{reply}"
    );
}

#[test]
fn rename_edits_are_not_announced_or_sent_unless_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib")).unwrap();
    let files = [("lib/a.q", "a:1\n"), ("main.q", "\\l lib/a.q\n")];
    let (mut server, reply) = Server::over(dir.path(), &files, client(), Value::Null);
    assert!(
        reply["result"]["capabilities"]["workspace"]["fileOperations"].is_null(),
        "{reply}"
    );
    let reply = server.request(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib/a.q", "lib/b.q")]),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
}
