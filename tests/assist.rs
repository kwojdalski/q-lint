//! What the language server adds to editing: a local's inferred type (hover
//! and inlay hints), reference counts above functions, the `\l` a completed
//! name needs, the argument slot the cursor is in, and which of a process's
//! names the workspace defines.
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

/// The whole of a short document, as an LSP range.
fn everything() -> Value {
    json!({"range": {"start": {"line": 0, "character": 0}, "end": {"line": 99, "character": 0}}})
}

/// Literals and the type KDB-X's `type` gives each, as it gave them for
/// `{a:LITERAL; type a}[]` (checked against a running q by
/// `the_inferred_types_are_what_q_gives` when QLINT_TEST_Q names one).
const TYPED: &[(&str, i16)] = &[
    ("1", -7),
    ("-1", -7),
    ("1 2 3", 7),
    ("1 -2", 7),
    ("1j", -7),
    ("1i", -6),
    ("1h", -5),
    ("1e", -8),
    ("1f", -9),
    ("1.5", -9),
    (".5", -9),
    ("1.", -9),
    ("1 2.5", 9),
    ("1 2j", 7),
    ("1 2i", 6),
    ("1 2h", 5),
    ("1 2e", 8),
    ("1.5 2e", 8),
    ("1 2f", 9),
    ("0N", -7),
    ("0n", -9),
    ("0w", -9),
    ("0W", -7),
    ("-0w", -9),
    ("0Ni", -6),
    ("0Nh", -5),
    ("0Ne", -8),
    ("1 0N", 7),
    ("1 0n", 9),
    ("0N 1.5", 9),
    ("0W 1", 7),
    ("1b", -1),
    ("101b", 1),
    ("0x01", -4),
    ("0x0", -4),
    ("0x0102", 4),
    ("\"\"", 10),
    ("\"a\"", -10),
    ("\"ab\"", 10),
    ("\"\\n\"", -10),
    ("\"\\\"\"", -10),
    ("\"\\012\"", -10),
    ("\"a;b\"", 10),
    ("`a", -11),
    ("`", -11),
    ("`a`b", 11),
    ("``", 11),
    ("`:a/b.q", -11),
    ("`a:b/c", -11),
    ("`a`:b/c", 11),
    ("2024.01.01", -14),
    ("2024.02.29", -14),
    ("2024.01.01 2024.01.02", 14),
    ("2024.01", -9),
    ("2024.01m", -13),
    ("2024.01 2024.02m", 13),
    ("2024.01.01D12:00:00.000000000", -12),
    ("2024.01.01D", -12),
    ("0D12:00:00", -16),
    ("1D", -16),
    ("12:00", -17),
    ("12:00 13:00", 17),
    ("12:00:00", -18),
    ("12:00:00.000", -19),
    ("12:00:00.123 13:00:00.000", 19),
    ("{x}", 100),
    ("{[a;b] a+b}", 100),
    ("()", 0),
];

/// Text that is no literal, or one this does not read - nothing is shown.
const UNTYPED: &[&str] = &[
    "1+2",
    "f[1]",
    "{x}[1]",
    "1e10",
    "2e3",
    "1.5i",
    "1 2b",
    "0Nd",
    "2024.02.30",
    "2023.02.29",
    "2024.13.01",
    "12:61",
    "24:00",
    "12:00 12:00:00",
    "0x012",
    "0xg",
    "`a `b",
    // A `/` before any `:` ends the symbol: `a/ is a derived function and
    // `.a/b an error in KDB-X (#1245).
    "`a/",
    "`.a/b",
    "`a`b/",
    "`a`b!1 2",
    "\"ab\" ,\"c\"",
    "\"\\q\"",
    "(1;2)",
    "-",
    "1 - 2",
    "x",
];

#[test]
fn a_literal_is_typed_as_q_types_it_and_anything_else_is_not() {
    for (text, kind) in TYPED {
        assert_eq!(q_lint_rs::literal_type(text), Some(*kind), "{text}");
    }
    for text in UNTYPED {
        assert_eq!(q_lint_rs::literal_type(text), None, "{text}");
    }
}

/// Run `script` on the q that QLINT_TEST_Q names (a command line), and
/// what it printed.
fn run_q(script: &str) -> Option<String> {
    let q = std::env::var("QLINT_TEST_Q").ok()?;
    let mut words = q.split_whitespace();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("types.q");
    std::fs::write(&path, script).unwrap();
    let out = Command::new(words.next()?)
        .args(words)
        .arg(&path)
        .arg("-q")
        .stdin(Stdio::null())
        .output()
        .expect("run q");
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn the_inferred_types_are_what_q_gives() {
    // Each literal assigned to a local in a lambda, as the server reads it.
    let mut script = String::new();
    for (text, _) in TYPED {
        script.push_str(&format!("-1 string type {{a:{text}; a}}[];\n"));
    }
    script.push_str("\\\\\n");
    let Some(out) = run_q(&script) else {
        eprintln!("QLINT_TEST_Q names no q: the table stands as KDB-X gave it");
        return;
    };
    let got: Vec<i16> = out
        .lines()
        .map(|l| l.trim().parse().unwrap_or_else(|_| panic!("{out}")))
        .collect();
    let want: Vec<i16> = TYPED.iter().map(|(_, kind)| *kind).collect();
    assert_eq!(got, want, "{out}");
}

#[test]
fn a_local_is_typed_only_where_every_assignment_settles_it() {
    let text = "f:{[p]\n a:1 2 3;\n b:\"x\";\n c:1+2;\n d:1;\n d:2.5;\n e:`s;\n e:`t;\n g:1;\n g+:1;\n h:12:00 / when\n ;\n i::1;\n (j;k):(1;2);\n l:{x}\n }\n";
    let typed: Vec<(String, i16)> = q_lint_rs::typed_locals(text)
        .into_iter()
        .map(|t| (t.local.name, t.kind))
        .collect();
    assert_eq!(
        typed,
        vec![
            ("a".into(), 7),
            ("b".into(), -10),
            ("e".into(), -11),
            ("h".into(), -17),
            ("l".into(), 100),
        ]
    );
    // A column of a query is no local.
    let query = "f:{select a:1 from t}\n";
    assert!(q_lint_rs::typed_locals(query).is_empty());
}

#[test]
fn a_typed_local_has_a_hint_after_its_value_and_a_hover() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "f:{[p] a:1 2 3; b:a,p; a}\ng:{s:`x`y; s}\n";
    let uri = server.open(dir.path(), "main.q", text);
    let reply = server.whole("textDocument/inlayHint", &uri, everything());
    let types: Vec<(u64, u64, String)> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|h| h["kind"] == 1)
        .map(|h| {
            (
                h["position"]["line"].as_u64().unwrap(),
                h["position"]["character"].as_u64().unwrap(),
                h["label"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        types,
        vec![(0, 14, "long list".into()), (1, 9, "symbol list".into())]
    );
    // The read at the end of f.
    let hover = server.request(
        "textDocument/hover",
        json!({"textDocument": {"uri": uri}, "position": {"line": 0, "character": 23}}),
    );
    let said = hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(
        said.contains("a: long list") && said.contains("7h"),
        "{said}"
    );
    // b is an expression, p a parameter: nothing.
    for character in [16, 4] {
        let hover = server.request(
            "textDocument/hover",
            json!({"textDocument": {"uri": uri}, "position": {"line": 0, "character": character}}),
        );
        assert!(hover["result"].is_null(), "{hover}");
    }
}

#[test]
fn inferred_types_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, reply) = Server::over(
        dir.path(),
        &[],
        client(),
        json!({"inferredTypes": {"enable": false}, "inlayHints": {"enable": false}}),
    );
    assert!(
        reply["result"]["capabilities"]["inlayHintProvider"].is_null(),
        "{reply}"
    );
    let uri = server.open(dir.path(), "main.q", "f:{a:1; a}\n");
    let hover = server.request(
        "textDocument/hover",
        json!({"textDocument": {"uri": uri}, "position": {"line": 0, "character": 8}}),
    );
    assert!(hover["result"].is_null(), "{hover}");
    let hints = server.whole("textDocument/inlayHint", &uri, everything());
    assert!(hints["result"].is_null(), "{hints}");
    // Parameter hints on, types off: no type hint.
    let (mut server, reply) = Server::over(
        dir.path(),
        &[],
        client(),
        json!({"inferredTypes": {"enable": false}}),
    );
    assert_eq!(reply["result"]["capabilities"]["inlayHintProvider"], true);
    let uri = server.open(dir.path(), "main.q", "f:{a:1; a}\n");
    let hints = server.whole("textDocument/inlayHint", &uri, everything());
    assert_eq!(hints["result"], json!([]), "{hints}");
}

const LIB: &str = "\\d .lib\nadd:{[a;b] a+b}\nunused:{x}\n\\d .\ntwice:{[v] 2*v}\n";

/// Each reference lens as `(line, title, arguments)`.
fn reference_lenses(reply: &Value) -> Vec<(u64, String, Value)> {
    reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("lenses, not {reply}"))
        .iter()
        .filter(|l| l["command"]["command"] == "q-lint.showReferences")
        .map(|l| {
            (
                l["range"]["start"]["line"].as_u64().unwrap(),
                l["command"]["title"].as_str().unwrap().to_string(),
                l["command"]["arguments"].clone(),
            )
        })
        .collect()
}

#[test]
fn a_function_has_a_lens_counting_the_places_that_read_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("main.q"),
        "\\l lib.q\nr:.lib.add[1;2]+twice 3\ns:.lib.add[3;4]\n",
    )
    .unwrap();
    let (mut server, _) = Server::over(
        dir.path(),
        &[("lib.q", LIB)],
        client(),
        json!({"referenceLens": {"enable": true}}),
    );
    let uri = server.open(dir.path(), "lib.q", LIB);
    // `add` again in lib.q itself, read once there.
    let reply = server.whole("textDocument/codeLens", &uri, json!({}));
    let found = reference_lenses(&reply);
    let titles: Vec<(u64, &str)> = found.iter().map(|(l, t, _)| (*l, t.as_str())).collect();
    assert_eq!(
        titles,
        vec![(1, "2 references"), (2, "0 references"), (4, "1 reference")]
    );
    assert_eq!(found[0].2, json!([uri, {"line": 1, "character": 0}]));
    // No Run lens unless that is asked for too.
    assert_eq!(reply["result"].as_array().unwrap().len(), 3);
}

#[test]
fn reference_lenses_are_off_unless_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", LIB)], client(), Value::Null);
    assert!(
        reply["result"]["capabilities"]["codeLensProvider"].is_null(),
        "{reply}"
    );
    let uri = server.open(dir.path(), "lib.q", LIB);
    let lenses = server.whole("textDocument/codeLens", &uri, json!({}));
    assert!(lenses["result"].is_null(), "{lenses}");
    // Run lenses on, counts off.
    let (mut server, _) = Server::over(
        dir.path(),
        &[("lib.q", LIB)],
        client(),
        json!({"codeLens": {"enable": true}, "referenceLens": {"enable": false}}),
    );
    let uri = server.open(dir.path(), "lib.q", LIB);
    let lenses = server.whole("textDocument/codeLens", &uri, json!({}));
    assert!(reference_lenses(&lenses).is_empty(), "{lenses}");
    assert!(!lenses["result"].as_array().unwrap().is_empty());
}

/// The completion item for `label` at `(line, character)` of `uri`.
fn completed(server: &mut Server, uri: &str, line: u64, character: u64, label: &str) -> Value {
    let reply = server.request(
        "textDocument/completion",
        json!({"textDocument": {"uri": uri}, "position": {"line": line, "character": character}}),
    );
    reply["result"]["items"]
        .as_array()
        .unwrap_or_else(|| panic!("items, not {reply}"))
        .iter()
        .find(|i| i["label"] == label)
        .cloned()
        .unwrap_or_else(|| panic!("no {label} in {reply}"))
}

fn auto_load() -> Value {
    json!({"completion": {"enable": true}, "autoLoad": {"enable": true}})
}

#[test]
fn a_name_another_file_defines_completes_with_the_load_it_needs() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("lib")).unwrap();
    std::fs::write(dir.path().join("lib/util.q"), "helper:{[v] v+1}\n").unwrap();
    std::fs::write(dir.path().join("lib/more.q"), "\\d .more\nfn:{x}\n").unwrap();
    std::fs::write(dir.path().join("lib/twin1.q"), "dup:{x}\n").unwrap();
    std::fs::write(dir.path().join("lib/twin2.q"), "dup:{y}\n").unwrap();
    let (mut server, _) =
        Server::over(dir.path(), &[("first.q", "one:1\n")], client(), auto_load());
    let text = "/ a header\n\\l first.q\nx:1\nr:help\nq:.more.f\nd:du\no:on";
    let uri = server.open(dir.path(), "main.q", text);
    let item = completed(&mut server, &uri, 3, 6, "helper");
    // After the loads already there, in their order.
    assert_eq!(
        item["additionalTextEdits"],
        json!([{"range": {"start": {"line": 2, "character": 0}, "end": {"line": 2, "character": 0}},
                "newText": "\\l lib/util.q\n"}])
    );
    assert_eq!(item["detail"], "adds \\l lib/util.q");
    // A qualified name, from a file with a `\d`.
    let item = completed(&mut server, &uri, 4, 9, ".more.fn");
    assert_eq!(
        item["additionalTextEdits"][0]["newText"],
        "\\l lib/more.q\n"
    );
    // Two files define it: which to load is not this server's to say.
    let item = completed(&mut server, &uri, 5, 4, "dup");
    assert!(item.get("additionalTextEdits").is_none(), "{item}");
    // A name this file loads already: no second load.
    let item = completed(&mut server, &uri, 6, 4, "one");
    assert!(item.get("additionalTextEdits").is_none(), "{item}");
    // Once the load is written, it is never added twice.
    let loaded = "/ a header\n\\l first.q\n\\l lib/util.q\nx:1\nr:help";
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":2},"contentChanges":[{"text":loaded}]}}));
    let item = completed(&mut server, &uri, 4, 6, "helper");
    assert!(item.get("additionalTextEdits").is_none(), "{item}");
}

#[test]
fn a_load_is_added_at_the_top_when_there_is_none_and_never_below_a_d() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("util.q"), "helper:{[v] v+1}\n").unwrap();
    let (mut server, _) = Server::over(dir.path(), &[], client(), auto_load());
    let uri = server.open(dir.path(), "a.q", "#!/usr/bin/env q\n/ about\nx:help");
    let item = completed(&mut server, &uri, 2, 6, "helper");
    assert_eq!(
        item["additionalTextEdits"][0]["range"]["start"],
        json!({"line": 2, "character": 0})
    );
    // A load after the first `\d` is not followed: the new one goes above.
    let uri = server.open(dir.path(), "b.q", "\\d .ns\n\\l other.q\n\\d .\nx:help");
    let item = completed(&mut server, &uri, 3, 6, "helper");
    assert_eq!(
        item["additionalTextEdits"][0]["range"]["start"],
        json!({"line": 0, "character": 0})
    );
}

#[test]
fn a_sibling_its_loader_brings_in_needs_no_load() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("util.q"), "helper:{[v] v+1}\n").unwrap();
    std::fs::write(dir.path().join("main.q"), "\\l util.q\n\\l job.q\n").unwrap();
    let (mut server, _) = Server::over(dir.path(), &[], client(), auto_load());
    let uri = server.open(dir.path(), "job.q", "r:help");
    let item = completed(&mut server, &uri, 0, 6, "helper");
    assert!(item.get("additionalTextEdits").is_none(), "{item}");
}

#[test]
fn auto_load_is_off_unless_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("util.q"), "helper:{[v] v+1}\n").unwrap();
    let (mut server, _) = Server::over(
        dir.path(),
        &[],
        client(),
        json!({"completion": {"enable": true}}),
    );
    let uri = server.open(dir.path(), "a.q", "x:help");
    let item = completed(&mut server, &uri, 0, 6, "helper");
    assert!(item.get("additionalTextEdits").is_none(), "{item}");
}

fn slot(server: &mut Server, uri: &str, line: u64, character: u64) -> Value {
    server.request(
        "q-lint/argumentSlot",
        json!({"textDocument": {"uri": uri}, "position": {"line": line, "character": character}}),
    )["result"]
        .clone()
}

#[test]
fn the_argument_slot_under_the_cursor_is_named_with_its_parameter() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", LIB)], client(), Value::Null);
    assert_eq!(
        reply["result"]["capabilities"]["experimental"]["q-lint/argumentSlot"],
        true
    );
    let text = "\\l lib.q\nr:.lib.add[1; 20 ]\ns:ssr[\"abc\";\"b\";\"c\"]\nt:.lib.add[;2]\nu:twice[v]\nw:1+2\n";
    let uri = server.open(dir.path(), "main.q", text);
    let at = slot(&mut server, &uri, 1, 15);
    assert_eq!(at["index"], 1);
    assert_eq!(at["callee"], ".lib.add");
    assert_eq!(at["parameter"], "b");
    assert_eq!(
        at["range"],
        json!({"start": {"line": 1, "character": 14}, "end": {"line": 1, "character": 16}})
    );
    // The parameter hint already writes `b:` there.
    assert_eq!(at["hinted"], true);
    // q's own, from the catalogue: no hint draws those.
    let at = slot(&mut server, &uri, 2, 13);
    assert_eq!(at["index"], 1);
    assert!(at["parameter"].is_string(), "{at}");
    assert_eq!(at["hinted"], false);
    // A string argument is its quotes, not a blank.
    assert_eq!(
        at["range"],
        json!({"start": {"line": 2, "character": 12}, "end": {"line": 2, "character": 15}})
    );
    // An empty slot of a projection.
    let at = slot(&mut server, &uri, 3, 11);
    assert_eq!(at["index"], 0);
    assert_eq!(at["parameter"], "a");
    assert_eq!(at["range"]["start"], at["range"]["end"]);
    assert_eq!(at["hinted"], false);
    // An argument spelled as its parameter has no hint.
    let at = slot(&mut server, &uri, 4, 8);
    assert_eq!(at["parameter"], "v");
    assert_eq!(at["hinted"], false);
    // Outside a call.
    assert!(slot(&mut server, &uri, 5, 3).is_null());
}

#[test]
fn defined_says_which_names_the_workspace_defines() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    server.open(dir.path(), "lib.q", LIB);
    let reply = server.request(
        "q-lint/defined",
        json!({"names": [".lib.add", "twice", ".lib.gone", "onproc"]}),
    );
    assert_eq!(reply["result"], json!([true, true, false, false]));
}
