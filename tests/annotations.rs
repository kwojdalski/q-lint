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
        self.told(method, params).0
    }

    /// The reply to a request, and each `window/showMessage` sent before it.
    fn told(&mut self, method: &str, params: Value) -> (Value, Vec<String>) {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        let mut shown = vec![];
        loop {
            let message = self
                .messages
                .recv_timeout(Duration::from_secs(30))
                .expect("the server answers");
            if message["id"] == id {
                return (message, shown);
            }
            if message["method"] == "window/showMessage" {
                shown.push(message["params"]["message"].as_str().unwrap().to_string());
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
fn a_string_argument_is_hinted_where_it_starts() {
    // #2025: the arguments were found in the code view, where a string is
    // blank - so one that is only a string had no hint, and one that starts
    // with a string had its hint after the closing quote.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let main = "cc:{[sym;px] px}\n\
                n:cc[\"a\";2]\n\
                p:cc[ \"ab\",string 1;2]\n\
                m:cc[1;\"x;y]\"]\n\
                e:cc[\"\";2]\n\
                c:cc[1; / the price\n  2]\n";
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.whole("textDocument/inlayHint", &uri, everything());
    assert_eq!(
        hints(&reply),
        [
            hint(1, 5, "sym:"),
            hint(1, 9, "px:"),
            hint(2, 6, "sym:"),
            hint(2, 20, "px:"),
            // A `;` or a `]` in a string ends no argument.
            hint(3, 5, "sym:"),
            hint(3, 7, "px:"),
            hint(4, 5, "sym:"),
            hint(4, 8, "px:"),
            // A comment is no part of the argument after it.
            hint(5, 5, "sym:"),
            hint(6, 2, "px:"),
        ],
        "{reply}"
    );
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

/// Hints and lenses over a file of N definitions, each calling the one
/// before, take time in proportion to it: each read the whole file again
/// for every definition, 63 s at 5,000 (#1216).
#[test]
fn hints_and_lenses_over_many_definitions_take_linear_time() {
    // The ratio of two sizes, not a bound, as for the speed tests in
    // tests/core.rs: a fixed bound measures the runner.
    let time = |n: usize| {
        let text: String = (0..n)
            .map(|i| format!("f{i}:{{[a;b] a+f{}[b;a]}}\n", i.max(1) - 1))
            .collect();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("chain.q"), &text).unwrap();
        let options = json!({"codeLens": {"enable": true}, "referenceLens": {"enable": true}});
        let (mut server, _) = Server::over(dir.path(), &[], client(), options);
        let uri = server.open(dir.path(), "chain.q", &text);
        let range = json!({"range": {"start": {"line": 0, "character": 0},
                                     "end": {"line": n, "character": 0}}});
        let mut ask = || {
            let started = std::time::Instant::now();
            let hints = server.whole("textDocument/inlayHint", &uri, range.clone());
            let lenses = server.whole("textDocument/codeLens", &uri, json!({}));
            let tests = server.request("q-lint/tests", json!({}));
            let elapsed = started.elapsed();
            assert_eq!(hints["result"].as_array().unwrap().len(), 2 * n);
            assert!(lenses["result"].as_array().unwrap().len() >= n);
            assert!(tests["result"].is_array(), "{tests}");
            elapsed
        };
        // The first answer waits behind the lint of the opened file: not
        // what is measured. The answers are not cached, so each is the work.
        ask();
        (0..3).map(|_| ask()).min().unwrap()
    };
    let (small, large) = (time(250), time(2000));
    eprintln!("250 definitions took {small:?} and 2000 {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 8.2 here (75 ms and
    // 615 ms). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "250 definitions took {small:?} and 2000 {large:?}"
    );
}

/// Reference lenses over one name defined many times and read as often:
/// each read added one to every definition of the name, n^2 increments for
/// lenses that all show the same total (#2349).
#[test]
fn reference_lenses_over_one_name_defined_many_times_take_linear_time() {
    let time = |n: usize| {
        let text: String = (0..n)
            .map(|i| format!("f:{{[a;b] a+b+{i}}};\nr{i}:f[1;2];\n"))
            .collect();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("same.q"), &text).unwrap();
        let options = json!({"codeLens": {"enable": true}, "referenceLens": {"enable": true}});
        let (mut server, _) = Server::over(dir.path(), &[], client(), options);
        let uri = server.open(dir.path(), "same.q", &text);
        let mut ask = || {
            let started = std::time::Instant::now();
            let lenses = server.whole("textDocument/codeLens", &uri, json!({}));
            let elapsed = started.elapsed();
            let lenses = lenses["result"].as_array().unwrap().clone();
            let counted = format!("{n} references");
            assert!(
                lenses
                    .iter()
                    .any(|l| l["command"]["title"] == counted.as_str()),
                "{lenses:?}"
            );
            elapsed
        };
        // The first answer waits behind the lint of the opened file.
        ask();
        (0..3).map(|_| ask()).min().unwrap()
    };
    let (small, large) = (time(2000), time(16000));
    eprintln!("2000 definitions took {small:?} and 16000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "2000 definitions took {small:?} and 16000 {large:?}"
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

/// A load after a language prefix is a load: KDB-X 5 runs b.q for
/// `k)\l b.q`, `q)k)\l b.q` and `K)\l b.q`, and none of them was linked
/// (#2994).
#[test]
fn a_load_after_a_language_prefix_links_to_its_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("b.q", "b:1\n")]);
    let text = "k)\\l b.q\nq)k)\\l b.q\nq)\\l b.q\nK)\\l b.q\r\nk)a:1\n\
                /\nk)\\l b.q\n\\\nk)s:\"\\l b.q\"\n";
    std::fs::write(dir.path().join("main.q"), text).unwrap();
    let uri = server.open(dir.path(), "main.q", text);
    let reply = server.whole("textDocument/documentLink", &uri, json!({}));
    assert_eq!(
        links(&reply, dir.path()),
        [
            (0, 5, 8, "b.q".to_string()),
            (1, 7, 10, "b.q".into()),
            (2, 5, 8, "b.q".into()),
            (3, 5, 8, "b.q".into()),
            // Not the one in the block comment, nor a k string.
        ],
        "{reply}"
    );
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

/// An empty slot has no name: no `/ @param ` line with nothing after it,
/// and no hint that is a colon alone (#2779).
#[test]
fn an_empty_parameter_slot_is_neither_documented_nor_hinted() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "a.q", "f:{[a;] a}\nr:f[1;2]\n");
    let actions = actions_at(&mut server, &uri, 0, 0, None);
    assert_eq!(qdoc(&actions, &uri).unwrap().1, "/ @param a\n/ @return\n");
    let reply = server.whole("textDocument/inlayHint", &uri, everything());
    assert_eq!(hints(&reply), [hint(1, 4, "a:")], "{reply}");
}

/// A typed slot is the name it binds, and a pattern the names in it: the
/// type is no part of what is documented or hinted (#2778).
#[test]
fn a_typed_parameter_is_documented_and_hinted_by_its_name() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "f:{[x:`j;y:`J] x+y}\ng:{[(a;b):`j;c] a+b+c}\nr:f[1;2 3]\ns:g[1 2;3]\nt:f[x;4]\n";
    let uri = server.open(dir.path(), "a.q", text);
    let actions = actions_at(&mut server, &uri, 0, 0, None);
    assert_eq!(
        qdoc(&actions, &uri).unwrap().1,
        "/ @param x\n/ @param y\n/ @return\n"
    );
    let actions = actions_at(&mut server, &uri, 1, 0, None);
    assert_eq!(
        qdoc(&actions, &uri).unwrap().1,
        "/ @param a\n/ @param b\n/ @param c\n/ @return\n"
    );
    let reply = server.whole("textDocument/inlayHint", &uri, everything());
    assert_eq!(
        hints(&reply),
        [
            hint(2, 4, "x:"),
            hint(2, 6, "y:"),
            hint(3, 4, "(a;b):"),
            hint(3, 8, "c:"),
            // An argument that is the parameter's own name needs none.
            hint(4, 6, "y:"),
        ],
        "{reply}"
    );
}

/// The block's lines end as the file's own do: a CRLF file is left with no
/// bare LF (#2795).
#[test]
fn a_qdoc_block_ends_its_lines_as_the_file_does() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "a.q", "a:1\r\nf:{[a;b] a+b}\r\ng:2\r\n");
    let actions = actions_at(&mut server, &uri, 1, 0, None);
    assert_eq!(
        qdoc(&actions, &uri),
        Some((
            "Generate qDoc for f".to_string(),
            "/ @param a\r\n/ @param b\r\n/ @return\r\n".to_string(),
            (1, 0)
        )),
        "{actions:?}"
    );
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

/// The new lambda's name is one no file of the workspace defines: a file
/// this one loads defining `extracted` would have it replaced for every
/// caller (#2793).
#[test]
fn an_extracted_lambda_takes_no_name_another_file_defines() {
    let dir = tempfile::tempdir().unwrap();
    let files = [("lib.q", "extracted:{x*100}\n\\d .u\nextracted2:{x}\n")];
    let mut server = Server::start(dir.path(), &files);
    let text = "\\l lib.q\nf:{[a;b] 1+a*b}\n";
    let uri = server.open(dir.path(), "main.q", text);
    let actions = actions_over(&mut server, &uri, (1, 11), (1, 14), None);
    assert_eq!(
        extracted(&actions, &uri, text),
        Some((
            "Extract function as extracted3".to_string(),
            "\\l lib.q\nextracted3:{[a;b] a*b}\nf:{[a;b] 1+extracted3[a;b]}\n".to_string()
        )),
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

/// A file loaded only under `\d .lib`, and a KDB-X module, define their
/// bare names in that context, and their bodies read them there: Run and
/// Run test define and call them where the index has them, not as root
/// copies nothing reads (#2671).
#[test]
fn a_function_of_a_file_placed_in_a_context_is_run_there() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib")).unwrap();
    std::fs::create_dir_all(dir.path().join("mymod")).unwrap();
    let files = [
        ("main.q", "\\d .lib\n\\l lib/u.q\n\\d .\nm:use`mymod\n"),
        ("lib/u.q", "test_f:{1b}\n"),
        ("mymod/init.q", "helper:{x+1}\nf:{helper x}\nexport:([f])\n"),
    ];
    let options = json!({"codeLens": {"enable": true}});
    let (mut server, _) = Server::over(dir.path(), &files, client(), options);
    let uri = server.open(dir.path(), "lib/u.q", files[1].1);
    let reply = server.whole("textDocument/codeLens", &uri, json!({}));
    assert_eq!(
        lenses(&reply, &uri),
        [
            lens(0, "Run", "\\d .lib\ntest_f:{1b}\n\\d ."),
            lens(0, "Run test", "\\d .lib\ntest_f:{1b}\n\\d .\n.lib.test_f[]"),
        ]
    );
    let reply = server.request("q-lint/tests", json!({"textDocument": {"uri": uri}}));
    let test = &reply["result"][0]["tests"][0];
    assert_eq!(test["call"], ".lib.test_f[]", "{reply}");
    assert_eq!(test["qualified"], ".lib.test_f", "{reply}");
    let uri = server.open(dir.path(), "mymod/init.q", files[2].1);
    let reply = server.whole("textDocument/codeLens", &uri, json!({}));
    assert_eq!(
        lenses(&reply, &uri),
        [
            lens(0, "Run", "\\d .m.mymod\nhelper:{x+1}\n\\d ."),
            lens(1, "Run", "\\d .m.mymod\nf:{helper x}\n\\d ."),
        ]
    );
}

/// A file that uses qUnit has every `test*` of a namespace run, as
/// `.qunit.runNsTests` does (#1591).
#[test]
fn qunit_tests_are_listed_as_qunit_finds_them() {
    let dir = tempfile::tempdir().unwrap();
    let suite = "\\d .testCalc\ntestfoo:{[] .qunit.assertEquals[1;1;\"one\"]}\ntest1:{[] 1b}\n\
                 helper:{x}\n\\d .\n";
    let mut server = Server::start(
        dir.path(),
        &[("suite.q", suite), ("bare.q", "testlower:{[] 1b}\n")],
    );
    let reply = server.request("q-lint/tests", json!({}));
    let files = reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"));
    assert_eq!(files.len(), 1, "{reply}");
    let calls: Vec<&str> = files[0]["tests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["call"].as_str().unwrap())
        .collect();
    assert_eq!(calls, [".testCalc.testfoo[]", ".testCalc.test1[]"]);
}

/// A qUnit test runs inside the `beforeNamespace*`, `setUp*`, `tearDown*`
/// and `afterNamespace*` its namespace defines, as `.qunit.runTest` runs it
/// (#1590): they are sent with it and called around it.
#[test]
fn a_qunit_test_runs_inside_its_namespace_fixtures() {
    let dir = tempfile::tempdir().unwrap();
    let suite = "\\d .testCalc\nsetUp:{[] `.testCalc.t set ([] a:1 2 3)}\n\
                 testfoo:{[] .qunit.assertEquals[count t;3;\"rows\"]}\n\
                 tearDown:{[] delete t from `.testCalc}\n\\d .other\ntestfoo:{[] 1b}\n\\d .\n";
    let mut server = Server::start(dir.path(), &[("suite.q", suite)]);
    let reply = server.request("q-lint/tests", json!({}));
    let tests = reply["result"][0]["tests"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"));
    assert_eq!(
        tests[0]["code"],
        "\\d .testCalc\nsetUp:{[] `.testCalc.t set ([] a:1 2 3)}\n\\d .\n\
         \\d .testCalc\ntearDown:{[] delete t from `.testCalc}\n\\d .\n\
         \\d .testCalc\ntestfoo:{[] .qunit.assertEquals[count t;3;\"rows\"]}\n\\d ."
    );
    assert_eq!(
        tests[0]["call"],
        "{[] .testCalc.setUp[]; r:@[{(1b;x[])};.testCalc.testfoo;{(0b;x)}]; .testCalc.tearDown[]; $[r 0;r 1;'r 1]}[]"
    );
    // A namespace without fixtures: the test alone.
    assert_eq!(tests[1]["code"], "\\d .other\ntestfoo:{[] 1b}\n\\d .");
    assert_eq!(tests[1]["call"], ".other.testfoo[]");
}

/// A qUnit test is timed as `.qunit.runTest` times it, and fails over what
/// its namespace's `qunitConfig` allows it (#2103): the config is sent with
/// it, and read where it runs.
#[test]
fn a_qunit_test_fails_over_its_qunit_config_max_time_or_mem() {
    let dir = tempfile::tempdir().unwrap();
    let suite = "\\d .mytest\nqunitConfig:``testSlow!(::;`maxTime`maxMem!(5;0Wj))\n\
                 testSlow:{do[3000000;sqrt 2.0];.qunit.assertTrue[1b;\"slow\"]}\n\\d .\n";
    let mut server = Server::start(dir.path(), &[("suite.q", suite)]);
    let reply = server.request("q-lint/tests", json!({}));
    let tests = reply["result"][0]["tests"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"));
    assert_eq!(tests.len(), 1, "{reply}");
    assert_eq!(
        tests[0]["code"],
        "\\d .mytest\nqunitConfig:``testSlow!(::;`maxTime`maxMem!(5;0Wj))\n\\d .\n\
         \\d .mytest\ntestSlow:{do[3000000;sqrt 2.0];.qunit.assertTrue[1b;\"slow\"]}\n\\d ."
    );
    assert_eq!(
        tests[0]["call"],
        "{[] t:.Q.ts[{@[{(1b;x[])};x;{(0b;x)}]};enlist .mytest.testSlow]; r:t 1; \
         c:@[{.[`.mytest;`qunitConfig`testSlow]};::;``!``]; \
         c:(`maxTime`maxMem!0W 0W),$[99h~type c;c;()!()]; \
         if[r[0]&any t[0]>c`maxTime`maxMem;r:(0b;\"exceeded max config time/mem\")]; \
         $[r 0;r 1;'r 1]}[]"
    );
}

/// A namespace's `parameters*` runs each of its tests once for each value
/// it gives, `.ns.parameter` set to it, as `.qunit.runNsTests` does
/// (#2104): it, `beforeParameters*` and `afterParameters*` are sent with
/// the test, and the first failure is the test's.
#[test]
fn a_qunit_test_runs_once_for_each_of_its_namespace_parameters() {
    let dir = tempfile::tempdir().unwrap();
    let suite = "\\d .mytest\nbeforeParameters:{`.mytest.n set 0}\nparameters:{1 2 3}\n\
                 setUp:{`.mytest.n set n+1}\n\
                 testParam:{.qunit.assertTrue[parameter in 1 2 3;\"param\"]}\n\\d .\n";
    let mut server = Server::start(dir.path(), &[("suite.q", suite)]);
    let reply = server.request("q-lint/tests", json!({}));
    let tests = reply["result"][0]["tests"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"));
    assert_eq!(tests.len(), 1, "{reply}");
    assert_eq!(
        tests[0]["code"],
        "\\d .mytest\nbeforeParameters:{`.mytest.n set 0}\n\\d .\n\
         \\d .mytest\nparameters:{1 2 3}\n\\d .\n\
         \\d .mytest\nsetUp:{`.mytest.n set n+1}\n\\d .\n\
         \\d .mytest\ntestParam:{.qunit.assertTrue[parameter in 1 2 3;\"param\"]}\n\\d ."
    );
    assert_eq!(
        tests[0]["call"],
        "{[] .mytest.beforeParameters[]; p:@[{x[]};.mytest.parameters;()]; i:0; f:(1b;::); \
         do[max 1,count p; @[`.mytest;`parameter;:;p i]; .mytest.setUp[]; \
         r:@[{(1b;x[])};.mytest.testParam;{(0b;x)}]; if[f 0;f:r]; i+:1]; \
         $[f 0;f 1;'f 1]}[]"
    );
}

/// Outside a file that uses qUnit, a `setUp*` or `tearDown*` is the
/// file's own: never sent with a test or called around it (#1743).
#[test]
fn fixtures_wrap_a_test_only_in_a_file_that_uses_qunit() {
    let dir = tempfile::tempdir().unwrap();
    let plain = "\\d .db\ntearDownConnections:{[] hclose each .db.handles}\n\
                 setUpCache:{[] 1b}\ntestQuery:{[] 1b}\n\\d .\n";
    let mut server = Server::start(dir.path(), &[("plain.q", plain)]);
    let reply = server.request("q-lint/tests", json!({}));
    let tests = reply["result"][0]["tests"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"));
    assert_eq!(tests[0]["code"], "\\d .db\ntestQuery:{[] 1b}\n\\d .");
    assert_eq!(tests[0]["call"], ".db.testQuery[]");
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

/// What `q-lint/unresolvedNames` lists for the open document `uri`: each
/// name as written, and its line and character.
fn unresolved(server: &mut Server, uri: &str) -> Vec<(String, u64, u64)> {
    let reply = server.whole("q-lint/unresolvedNames", uri, json!({}));
    reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("a list of names, not {reply}"))
        .iter()
        .map(|n| {
            let (line, start, _) = span(&n["range"]);
            (n["written"].as_str().unwrap().to_string(), line, start)
        })
        .collect()
}

#[test]
fn a_module_reading_a_root_name_it_cannot_see_is_listed() {
    // KDB-X 5: `util:{x*10}; m:use`mymod; m.h 2` is 'util - a module's bare
    // name is `.m.mymod.util`, one of the workspace's and not of q's (#2667).
    let dir = tempfile::tempdir().unwrap();
    let main = "util:{x*10}\nm:use`mymod\nr:m.h 2\n";
    let mut server = Server::start(dir.path(), &[("main.q", main)]);
    let module = "helper:{x+1}\nf:{helper x}\nh:{util x}\nexport:([f;h])\n";
    let uri = server.open(dir.path(), "mymod/init.q", module);
    assert_eq!(unresolved(&mut server, &uri), [("util".to_string(), 2, 3)]);
}

#[test]
fn a_name_read_through_one_the_workspace_defines_is_not_listed() {
    // QF018 and the graph try a name without its last part; so does this
    // (#2807). `.nope.x` is read through nothing a file assigns.
    let dir = tempfile::tempdir().unwrap();
    let lib = ".cfg:`port`host!(1;2)\nt:([]c:1 2)\n.ns.d:`a`b!1 2\n";
    let mut server = Server::start(dir.path(), &[("lib.q", lib)]);
    let text = "r2:.cfg.port\nr3:t.c\nr8:.ns.d.a\nr9:.nope.x\n";
    let uri = server.open(dir.path(), "doc.q", text);
    assert_eq!(
        unresolved(&mut server, &uri),
        [(".nope.x".to_string(), 3, 3)]
    );
}

#[test]
fn a_bare_read_in_a_script_loaded_only_under_a_context_is_listed() {
    // KDB-X: `\l main.q` is 'helper at b.q's first line, for under `\d .a`
    // the name is `.a.helper` and q falls back to no root (#2818).
    let dir = tempfile::tempdir().unwrap();
    let files = [
        ("util.q", "helper:{x}\n"),
        ("main.q", "\\l util.q\n\\d .a\n\\l b.q\n"),
        ("b.q", "r:helper\n"),
    ];
    let mut server = Server::start(dir.path(), &files);
    let uri = server.open(dir.path(), "b.q", "r:helper\n");
    assert_eq!(
        unresolved(&mut server, &uri),
        [("helper".to_string(), 0, 2)]
    );
}

#[test]
fn a_column_in_parentheses_or_brackets_of_a_query_is_not_listed() {
    // KDB-X runs each of these over the columns `a` and `b` (#2822). The
    // list on the last line is in no query, and a lambda's names are its own.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "t:([]a:1 2;b:3 4)\n\
                r1:select from t where a=(max;a) fby b\n\
                r2:select from t where (a>1),b>2\n\
                r3:select from t where b in (a;b)\n\
                r4:select x:(a;b) from t\n\
                r5:select from t where a within (1;b)\n\
                r6:select[>a] from t\n\
                r7:select[2;<b] a from t\n\
                r8:select from t where a in (exec a from u where (b>3))\n\
                r9:select from t where (a>1),{x>lim} each b\n\
                r10:(a;b)\n";
    let uri = server.open(dir.path(), "doc.q", text);
    assert_eq!(
        unresolved(&mut server, &uri),
        [
            ("u".to_string(), 8, 41),
            ("lim".to_string(), 9, 32),
            ("a".to_string(), 10, 5),
            ("b".to_string(), 10, 7),
        ]
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

/// What a name holds once the file has loaded is what it is listed as, as
/// the outline has it: KDB-X types `p:add[1]` and `ce:count each` 104h and
/// `al:add` 100h, and `f` is 3 after `f:{x}` and `f:3` - no function, and
/// no dead one (#2809).
#[test]
fn a_definition_is_listed_as_what_the_name_holds_once_loaded() {
    let dir = tempfile::tempdir().unwrap();
    let lib = "add:{x+y}\np:add[1]\nce:count each\nal:add\nf:{x}\nf:3\nr:p[2],al[1;2]\n";
    let (mut server, _) = Server::over(dir.path(), &[("lib.q", lib)], client(), Value::Null);
    let reply = server.request("q-lint/definitions", json!({}));
    let got: Vec<(&str, &str)> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["name"].as_str().unwrap(), d["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(
        got,
        [
            ("add", "function"),
            ("al", "function"),
            ("ce", "function"),
            ("f", "variable"),
            ("p", "function"),
            ("r", "variable"),
        ]
    );
    let reply = server.request("q-lint/deadCode", json!({}));
    let dead: Vec<&str> = reply["result"]["functions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["name"].as_str().unwrap())
        .collect();
    assert_eq!(dead, ["ce"], "{reply}");
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

/// Two tests of one name in two namespaces of a file are told apart by the
/// name q gives each, in the list and in the tests a save reaches (#1592).
#[test]
fn a_test_carries_the_name_q_defines_it_by() {
    let dir = tempfile::tempdir().unwrap();
    let suite = "\\d .a\ntest_x:{[] f 1}\n\\d .b\ntest_x:{[] 0b}\n\\d .\nf:{x}\n";
    let (mut server, _) = Server::over(dir.path(), &[("t.q", suite)], client(), Value::Null);
    let reply = server.request("q-lint/tests", json!({}));
    let qualified: Vec<&str> = reply["result"][0]["tests"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"))
        .iter()
        .map(|t| t["qualified"].as_str().unwrap())
        .collect();
    assert_eq!(qualified, [".a.test_x", ".b.test_x"]);
    let uri = server.open(dir.path(), "t.q", &suite.replace("f:{x}", "f:{x+1}"));
    let reply = server.request(
        "q-lint/testsReaching",
        json!({"textDocument": {"uri": uri}, "previous": suite}),
    );
    assert_eq!(
        reply["result"]["tests"],
        json!([{"uri": uri, "name": "test_x", "qualified": ".a.test_x"}]),
        "{reply}"
    );
}

#[test]
fn the_inventories_name_a_function_where_its_file_is_loaded() {
    // #2046. q 5 loads b.q's `ff:{1}` under `\d .aa` as `.aa.ff`, which
    // main.q calls and test_x's test reaches; test_y's bare `ff` is a root
    // ff nothing defines.
    let dir = tempfile::tempdir().unwrap();
    let files = [
        ("main.q", "\\d .aa\n\\l b.q\n\\d .\nshow .aa.ff[]\n"),
        ("b.q", "ff:{1}\n"),
        ("test_x.q", "\\l main.q\ntest_ff:{.aa.ff[]~1}\n"),
        ("test_y.q", "\\l main.q\ntest_gg:{ff[]~1}\n"),
    ];
    let (mut server, _) = Server::over(dir.path(), &files, client(), Value::Null);
    let reply = server.request("q-lint/definitions", json!({}));
    let ff: Vec<(&str, &str)> = reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"))
        .iter()
        .filter(|d| d["uri"].as_str().unwrap().ends_with("/b.q"))
        .map(|d| {
            (
                d["name"].as_str().unwrap(),
                d["namespace"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(ff, [(".aa.ff", ".aa")], "{reply}");
    let reply = server.request("q-lint/deadCode", json!({}));
    let dead: Vec<&str> = reply["result"]["functions"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"))
        .iter()
        .map(|d| d["name"].as_str().unwrap())
        .collect();
    assert!(
        !dead.contains(&".aa.ff") && !dead.contains(&"ff"),
        "{reply}"
    );
    let (changed, tests) = reaching(&mut server, dir.path(), "b.q", "ff:{2}\n", "ff:{1}\n");
    assert_eq!(
        (changed, tests),
        (json!([".aa.ff"]), vec!["test_ff".into()])
    );
}

/// `q-lint/testsReaching` for `name`, saved as `now` over `previous`: the
/// changed names and the tests reached, sorted.
fn reaching(
    server: &mut Server,
    dir: &Path,
    name: &str,
    previous: &str,
    now: &str,
) -> (Value, Vec<String>) {
    let uri = server.open(dir, name, now);
    let reply = server.request(
        "q-lint/testsReaching",
        json!({"textDocument": {"uri": uri}, "previous": previous}),
    );
    let mut tests: Vec<String> = reply["result"]["tests"]
        .as_array()
        .unwrap_or_else(|| panic!("a list of tests, not {reply}"))
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    tests.sort();
    (reply["result"]["changed"].clone(), tests)
}

#[test]
fn a_function_gone_or_redefined_later_reaches_its_tests() {
    // Only the first statement of each name in the saved text was compared,
    // so a function deleted, made a value, or changed in a later definition
    // of two - the one q keeps - ran no test (#1359).
    let dir = tempfile::tempdir().unwrap();
    let gone = "gone:{x}\nuse_gone:{gone x}\n";
    let value = "value_now:{x}\nuse_value:{value_now x}\n";
    let twice = "twice:{x}\ntwice:{x+1}\nuse_twice:{twice x}\n";
    let files = [
        ("gone.q", gone),
        ("value.q", value),
        ("twice.q", twice),
        (
            "test_lib.q",
            "test_gone:{use_gone 1}\ntest_value:{use_value 1}\ntest_twice:{use_twice 1}\n",
        ),
    ];
    let (mut server, _) = Server::over(dir.path(), &files, client(), Value::Null);
    let d = dir.path();
    let (changed, tests) = reaching(&mut server, d, "gone.q", gone, "use_gone:{gone x}\n");
    assert_eq!(
        (changed, tests),
        (json!(["gone"]), vec!["test_gone".into()])
    );
    let now = "value_now:1\nuse_value:{value_now x}\n";
    let (changed, tests) = reaching(&mut server, d, "value.q", value, now);
    assert_eq!(
        (changed, tests),
        (json!(["value_now"]), vec!["test_value".into()])
    );
    let now = "twice:{x}\ntwice:{x+2}\nuse_twice:{twice x}\n";
    let (changed, tests) = reaching(&mut server, d, "twice.q", twice, now);
    assert_eq!(
        (changed, tests),
        (json!(["twice"]), vec!["test_twice".into()])
    );
    // Two definitions unchanged are no change.
    let (changed, tests) = reaching(&mut server, d, "twice.q", now, now);
    assert_eq!((changed, tests), (json!([]), vec![]));
}

#[test]
fn a_function_assigned_inside_another_ends_no_statement() {
    // `g::{x}` inside `f` was taken for the next top-level function, so the
    // `helper` read after it was nobody's and `test_f` was not reached
    // (#1360).
    let dir = tempfile::tempdir().unwrap();
    let lib = "helper:{x}\nf:{g::{x}; helper x}\n";
    let files = [("lib.q", lib), ("test_lib.q", "test_f:{f 1}\n")];
    let (mut server, _) = Server::over(dir.path(), &files, client(), Value::Null);
    let now = "helper:{x+1}\nf:{g::{x}; helper x}\n";
    let (changed, tests) = reaching(&mut server, dir.path(), "lib.q", lib, now);
    assert_eq!((changed, tests), (json!(["helper"]), vec!["test_f".into()]));
    // The function assigned inside is part of `f`'s statement, not one of
    // its own.
    let (changed, _) = reaching(
        &mut server,
        dir.path(),
        "lib.q",
        "helper:{x+1}\nf:{g::{y}; helper x}\n",
        now,
    );
    assert_eq!(changed, json!(["f"]));
}

/// A name that holds a function without being a lambda calls it all the
/// same: `al:f`, `h:f each` and both names of `a:b:f` run the changed `f`,
/// so the tests calling them are reached beside the ones calling a
/// projection or `f` itself (#2811).
#[test]
fn a_test_reaches_a_changed_function_through_a_name_that_is_no_lambda() {
    let dir = tempfile::tempdir().unwrap();
    let lib = "f:{x+1}\nal:f\np:{[a;b] f a+b}[1]\nh:f each\na:b:f\nother:{x}\no:other\n";
    let tests = "test_alias:{al 1}\ntest_proj:{p 1}\ntest_each:{h 1 2}\ntest_direct:{f 1}\n\
                 test_a:{a 1}\ntest_b:{b 1}\ntest_other:{o 1}\n";
    let files = [("lib.q", lib), ("test_lib.q", tests)];
    let (mut server, _) = Server::over(dir.path(), &files, client(), Value::Null);
    let now = lib.replace("x+1", "x+2");
    let (changed, tests) = reaching(&mut server, dir.path(), "lib.q", lib, &now);
    assert_eq!(changed, json!(["f"]));
    assert_eq!(
        tests,
        [
            "test_a",
            "test_alias",
            "test_b",
            "test_direct",
            "test_each",
            "test_proj"
        ]
    );
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
fn each_workspace_folder_is_the_root_of_its_own_relative_loads() {
    // #2045. Folders A and B each hold main.q (`\l lib.q`) and lib.q. A q
    // started in B loads B's lib.q, so B's main.q leads there, and renaming
    // one folder's lib.q rewrites that folder's load alone.
    let dir = tempfile::tempdir().unwrap();
    for folder in ["A", "B"] {
        std::fs::create_dir_all(dir.path().join(folder)).unwrap();
        std::fs::write(dir.path().join(folder).join("main.q"), "\\l lib.q\n").unwrap();
        std::fs::write(dir.path().join(folder).join("lib.q"), "ff:{1}\n").unwrap();
    }
    let options = json!({"renameLoads": {"enable": true}});
    let (mut server, _) = Server::over(&dir.path().join("A"), &[], client(), options);
    let b = file_uri(&dir.path().join("B"));
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWorkspaceFolders",
        "params":{"event":{"added":[{"uri":b,"name":"B"}],"removed":[]}}}),
    );
    let main = file_uri(&dir.path().join("B/main.q"));
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
        "params":{"textDocument":{"uri":main,"languageId":"q","version":1,"text":"\\l lib.q\n"}}}));
    let reply = server.request(
        "textDocument/definition",
        json!({"textDocument":{"uri":main},"position":{"line":0,"character":4}}),
    );
    let targets: Vec<&str> = reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"))
        .iter()
        .map(|l| l["uri"].as_str().unwrap())
        .collect();
    assert_eq!(targets, [file_uri(&dir.path().join("B/lib.q"))], "{reply}");
    for folder in ["A", "B"] {
        let (old, new) = (format!("{folder}/lib.q"), format!("{folder}/util.q"));
        let reply = server.request(
            "workspace/willRenameFiles",
            rename_params(dir.path(), &[(&old, &new)]),
        );
        assert_eq!(
            renamed(&reply, dir.path()),
            [(format!("{folder}/main.q"), 0, 3, 8, "util.q".to_string())],
            "{reply}"
        );
    }
}

#[test]
fn a_load_spelled_in_another_case_is_rewritten_on_a_disk_that_ignores_case() {
    // #2050. Where the disk ignores case, q loads lib/u.q for `\l Lib/U.q`,
    // so renaming lib/u.q, or the folder, moves what that load reaches.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib")).unwrap();
    std::fs::write(dir.path().join("lib/u.q"), "u:1\n").unwrap();
    if !dir.path().join("LIB/U.Q").exists() {
        return;
    }
    let files = [("main.q", "\\l Lib/U.q\n\\l LIB/u.q\n")];
    let options = json!({"renameLoads": {"enable": true}});
    let (mut server, _) = Server::over(dir.path(), &files, client(), options);
    let reply = server.request(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib/u.q", "lib/w.q")]),
    );
    // The part that still leads there keeps the case it was written in.
    assert_eq!(
        renamed(&reply, dir.path()),
        [
            ("main.q".to_string(), 0, 3, 10, "Lib/w.q".to_string()),
            ("main.q".into(), 1, 3, 10, "LIB/w.q".into()),
        ],
        "{reply}"
    );
    let reply = server.request(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib", "core")]),
    );
    assert_eq!(
        renamed(&reply, dir.path()),
        [
            ("main.q".to_string(), 0, 3, 10, "core/U.q".to_string()),
            ("main.q".into(), 1, 3, 10, "core/u.q".into()),
        ],
        "{reply}"
    );
}

/// KDB-X 5 finds `` use`a.b `` at `a/b.q` or `a/b/init.q`, so a module's
/// name is its path as much as a load's is (#2669).
#[test]
fn renaming_a_modules_file_or_folder_rewrites_the_uses_that_name_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("mymod")).unwrap();
    std::fs::create_dir_all(dir.path().join("pkg")).unwrap();
    let files = [
        ("mymod/init.q", "f:{x}\nexport:([f])\n"),
        ("flat.q", "g:{x}\nexport:([g])\n"),
        ("pkg/sub.q", "h:{x}\nexport:([h])\n"),
        (
            "main.q",
            "m:use`mymod\n\\l mymod/init.q\nk:use`flat\np:use`pkg.sub\n",
        ),
    ];
    let options = json!({"renameLoads": {"enable": true}});
    let (mut server, _) = Server::over(dir.path(), &files, client(), options);
    let mut edits = |moves: &[(&str, &str)]| {
        let reply = server.request(
            "workspace/willRenameFiles",
            rename_params(dir.path(), moves),
        );
        let mut edits = renamed(&reply, dir.path());
        edits.sort();
        edits
    };
    assert_eq!(
        edits(&[("mymod", "mod2")]),
        [
            ("main.q".to_string(), 0, 6, 11, "mod2".to_string()),
            ("main.q".into(), 1, 3, 15, "mod2/init.q".into()),
        ]
    );
    assert_eq!(
        edits(&[("flat.q", "flat2.q")]),
        [("main.q".to_string(), 2, 6, 10, "flat2".to_string())]
    );
    // A directory is a dot of the name.
    assert_eq!(
        edits(&[("flat.q", "lib/flat.q")]),
        [("main.q".to_string(), 2, 6, 10, "lib.flat".to_string())]
    );
    assert_eq!(
        edits(&[("pkg", "pk2")]),
        [("main.q".to_string(), 3, 6, 13, "pk2.sub".to_string())]
    );
    // pkg/sub/init.q is `pkg.sub` still, and no module name spells
    // my-flat.q: the user is told which `use` the rename leaves behind.
    let reply = server.request(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("pkg/sub.q", "pkg/sub/init.q")]),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
    let (reply, shown) = server.told(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("flat.q", "my-flat.q")]),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert!(shown[0].contains("main.q:3 (`my-flat.q`)"), "{}", shown[0]);
}

/// An absolute load written through a symlink (`/tmp` for `/private/tmp`)
/// is followed to the file renamed, and keeps its spelling (#1219).
#[cfg(unix)]
#[test]
fn an_absolute_load_through_a_symlink_is_rewritten_as_written() {
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let alias = elsewhere.path().join("alias");
    std::os::unix::fs::symlink(dir.path(), &alias).unwrap();
    std::fs::create_dir_all(dir.path().join("lib")).unwrap();
    let load = format!("{}/lib/a.q", alias.display());
    let main = format!("\\l {load}\n");
    let files = [("lib/a.q", "a:1\n"), ("main.q", main.as_str())];
    let options = json!({"renameLoads": {"enable": true}});
    let (mut server, _) = Server::over(dir.path(), &files, client(), options);
    let reply = server.request(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib/a.q", "lib/b.q")]),
    );
    let edits = renamed(&reply, dir.path());
    assert_eq!(edits.len(), 1, "{reply}");
    assert_eq!(
        edits[0].4,
        format!("{}/lib/b.q", alias.display()),
        "{reply}"
    );
}

/// A new name the load could not be written with is not written (#2026):
/// KDB-X 5 answers `\l lib/my util.q` and `system "l lib/my util.q"` with
/// 'nyi - quoted, or with the blank escaped, too - so no form of a load
/// reaches a path with a blank in it, and `` `:lib/my-util.q `` is the
/// symbol `` `:lib/my `` less `util.q`. Checked by loading a real file of
/// each name on a q started for it.
#[test]
fn a_load_is_not_rewritten_into_one_q_cannot_read() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib")).unwrap();
    let files = [
        ("lib/util.q", "u:1\n"),
        (
            "main.q",
            "\\l lib/util.q\nsystem \"l lib/util.q\"\np:`:lib/util.q\n",
        ),
        ("lib/near.q", "\\l util.q\n"),
    ];
    let options = json!({"renameLoads": {"enable": true}});
    let (mut server, _) = Server::over(dir.path(), &files, client(), options);
    // A blank: no load can hold it, so none is edited, and the user is told
    // which lines still name the old path.
    let (reply, shown) = server.told(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib/util.q", "lib/my util.q")]),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
    assert_eq!(shown.len(), 1, "{shown:?}");
    for part in [
        "lib/my util.q",
        "my util.q",
        "lib/near.q:1",
        "main.q:1",
        "main.q:2",
        "main.q:3",
    ] {
        assert!(shown[0].contains(part), "{part} in {}", shown[0]);
    }
    // A `-`: a path after `\l` or in a string holds one, a symbol does not.
    let (reply, shown) = server.told(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib/util.q", "lib/my-util.q")]),
    );
    assert_eq!(
        renamed(&reply, dir.path()),
        [
            ("lib/near.q".to_string(), 0, 3, 9, "my-util.q".to_string()),
            ("main.q".into(), 0, 3, 13, "lib/my-util.q".into()),
            ("main.q".into(), 1, 10, 20, "lib/my-util.q".into()),
        ],
        "{reply}"
    );
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert!(shown[0].contains("main.q:3"), "{}", shown[0]);
    assert!(!shown[0].contains("main.q:1"), "{}", shown[0]);
    // A name every form can hold: all three, and nothing to say.
    let (reply, shown) = server.told(
        "workspace/willRenameFiles",
        rename_params(dir.path(), &[("lib/util.q", "lib/util2.q")]),
    );
    assert_eq!(renamed(&reply, dir.path()).len(), 4, "{reply}");
    assert!(shown.is_empty(), "{shown:?}");
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

/// The labels of a completion reply, in order.
fn labels(reply: &Value) -> Vec<String> {
    reply["result"]["items"]
        .as_array()
        .unwrap_or_else(|| panic!("a completion list, not {reply}"))
        .iter()
        .map(|item| item["label"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn after_a_load_the_directories_and_scripts_complete() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib/deep")).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    std::fs::create_dir_all(dir.path().join(".git")).unwrap();
    let files = [
        ("lib/util.q", "u:1\n"),
        ("lib/core.k", "c:1\n"),
        ("lib/notes.txt", "\n"),
        ("app/local.q", "l:1\n"),
    ];
    let options = json!({"loadPathCompletion": {"enable": true}});
    let (mut server, reply) = Server::over(dir.path(), &files, client(), options);
    assert_eq!(
        reply["result"]["capabilities"]["completionProvider"]["triggerCharacters"],
        json!(["/"]),
        "{reply}"
    );
    let text = "\\l li\n\\l lib/\n\\l \nx:1\n";
    let uri = server.open(dir.path(), "app/main.q", text);
    let at =
        |line: u64, character: u64| json!({"position": {"line": line, "character": character}});
    let reply = server.whole("textDocument/completion", &uri, at(0, 5));
    // The workspace folder's, and the file's own directory's; the client
    // narrows by what is typed.
    let found = labels(&reply);
    assert!(found.contains(&"lib/".to_string()), "{reply}");
    assert!(found.contains(&"local.q".to_string()), "{reply}");
    assert!(!found.iter().any(|l| l.starts_with('.')), "{reply}");
    let item = &reply["result"]["items"][found.iter().position(|l| l == "lib/").unwrap()];
    assert_eq!(item["kind"], 19, "{item}");
    assert_eq!(span(&item["textEdit"]["range"]), (0, 3, 5), "{item}");
    // Inside lib/: its folder first, then its scripts, and nothing else.
    let reply = server.whole("textDocument/completion", &uri, at(1, 7));
    assert_eq!(labels(&reply), ["deep/", "core.k", "util.q"], "{reply}");
    let item = &reply["result"]["items"][2];
    assert_eq!(span(&item["textEdit"]["range"]), (1, 7, 7), "{item}");
    // Off a load line, with name completion off, nothing.
    let reply = server.whole("textDocument/completion", &uri, at(3, 1));
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

#[test]
fn a_slash_opens_the_list_on_a_load_path_and_nowhere_else() {
    // #2021: `/` is a trigger character for the next directory of a load,
    // and q's commonest adverb everywhere else. A request the `/` itself
    // triggered, off a load path, was answered with every name there is:
    // typing `r:+/` opened a list of hundreds with nothing typed.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib")).unwrap();
    let options = json!({"completion": {"enable": true}, "loadPathCompletion": {"enable": true}});
    let (mut server, _) = Server::over(dir.path(), &[("lib/util.q", "u:1\n")], client(), options);
    let text = "v:1 2 3\nr:+/\ns:(v%/)\n\\l lib/\nt:v\n";
    let uri = server.open(dir.path(), "main.q", text);
    let typed = |line: u64, character: u64, context: Value| json!({"position": {"line": line, "character": character}, "context": context});
    let slash = json!({"triggerKind": 2, "triggerCharacter": "/"});
    for (line, character) in [(1, 4), (2, 6)] {
        let reply = server.whole(
            "textDocument/completion",
            &uri,
            typed(line, character, slash.clone()),
        );
        assert_eq!(reply["result"], Value::Null, "{line}: {reply}");
    }
    // On a load it lists the directory.
    let reply = server.whole("textDocument/completion", &uri, typed(3, 7, slash));
    assert_eq!(labels(&reply), ["util.q"], "{reply}");
    // Asked for there (Ctrl+Space), or triggered by a dot, names complete
    // as they did.
    let reply = server.whole(
        "textDocument/completion",
        &uri,
        typed(1, 4, json!({"triggerKind": 1})),
    );
    assert!(labels(&reply).contains(&"v".to_string()), "{reply}");
    let reply = server.whole(
        "textDocument/completion",
        &uri,
        typed(4, 3, json!({"triggerKind": 2, "triggerCharacter": "."})),
    );
    assert!(reply["result"]["items"].is_array(), "{reply}");
}

#[test]
fn load_path_completion_is_off_unless_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("lib")).unwrap();
    let (mut server, reply) =
        Server::over(dir.path(), &[("lib/a.q", "a:1\n")], client(), Value::Null);
    assert!(reply["result"]["capabilities"]["completionProvider"].is_null());
    let uri = server.open(dir.path(), "main.q", "\\l li\n");
    let reply = server.whole(
        "textDocument/completion",
        &uri,
        json!({"position": {"line": 0, "character": 5}}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
    // With name completion on too, `/` joins its trigger characters.
    let options = json!({"completion": {"enable": true}, "loadPathCompletion": {"enable": true}});
    let (_, reply) = Server::over(dir.path(), &[], client(), options);
    assert_eq!(
        reply["result"]["capabilities"]["completionProvider"]["triggerCharacters"],
        json!([".", "/"]),
        "{reply}"
    );
}
