//! How files and functions relate: the dependency graph a file is in, the
//! tests a change reaches, and the call hierarchy - first as the library
//! answers, then as the language server answers an editor over a workspace.
use q_lint_rs::graph::{build, build_from, is_test, reaching};
use q_lint_rs::references;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{Receiver, channel},
    time::Duration,
};

#[test]
fn a_test_is_told_by_its_name_or_by_a_directory_of_tests() {
    for path in [
        "test_book.q",
        "src/book_test.q",
        "tests/book.q",
        "tests/lib/support.q",
        "pkg/test/run.q",
        "Tests/Book.Q",
        "TEST_book.q",
    ] {
        assert!(is_test(Path::new(path)), "{path}");
    }
    for path in [
        "book.q",
        "src/book.q",
        // A word that holds `test`, and a test that is not a q file.
        "contest.q",
        "latest/book.q",
        "attestation_tests_old/book.q",
        "tests/README.md",
        "tests/test_book.py",
        "test_book",
    ] {
        assert!(!is_test(Path::new(path)), "{path}");
    }
}

/// In-memory files under a directory that does not exist, so nothing is
/// read from disk.
fn sources(files: &[(&str, &str)]) -> (PathBuf, Vec<(PathBuf, String)>) {
    let root = PathBuf::from("/no-such-root");
    let files = files
        .iter()
        .map(|(name, text)| (root.join(name), text.to_string()))
        .collect();
    (root, files)
}

#[test]
fn a_graph_from_what_each_file_reads_is_the_graph_from_the_sources() {
    let (root, files) = sources(&[
        ("lib.q", "\\d .lib\nf:{x+1}\n"),
        ("app.q", "\\l lib.q\ng:{.lib.f x}\nh:{value x}\n"),
        ("dup.q", ".lib.f:{x}\n"),
    ]);
    let paths: Vec<PathBuf> = files.iter().map(|(path, _)| path.clone()).collect();
    let reads: Vec<_> = files
        .iter()
        .map(|(_, text)| references(text, false))
        .collect();
    let from_reads = build_from(&paths, &reads.iter().collect::<Vec<_>>(), &root);
    assert_eq!(from_reads, build(&files, false, &root));
    assert_eq!(from_reads[&root.join("app.q")].dependencies.len(), 2);
}

#[test]
fn the_files_reaching_a_change_are_its_dependents_all_the_way_up() {
    let (root, files) = sources(&[
        ("lib.q", ".lib.f:{x+1}\n"),
        ("app.q", ".app.g:{.lib.f x}\n"),
        ("tests/test_app.q", "t:{.app.g 1}\n"),
        ("other.q", ".other.h:{x}\n"),
        // Two files that need each other do not go round for ever.
        ("ping.q", ".ping.f:{.pong.f x}\n"),
        ("pong.q", ".pong.f:{.ping.f x}\n"),
    ]);
    let graph = build(&files, false, &root);
    let reach = |changed: &[&str]| -> Vec<(String, Vec<String>)> {
        let name = |path: &PathBuf| path.strip_prefix(&root).unwrap().display().to_string();
        let changed: Vec<PathBuf> = changed.iter().map(|c| root.join(c)).collect();
        reaching(&graph, &changed)
            .iter()
            .map(|(file, origins)| {
                let origins = origins.iter().map(|&c| name(&changed[c])).collect();
                (name(file), origins)
            })
            .collect()
    };
    let all = |files: &[&str], origin: &str| -> Vec<(String, Vec<String>)> {
        files
            .iter()
            .map(|file| (file.to_string(), vec![origin.to_string()]))
            .collect()
    };
    // The change itself, what reads it, and what reads that.
    assert_eq!(
        reach(&["lib.q"]),
        all(&["app.q", "lib.q", "tests/test_app.q"], "lib.q")
    );
    assert_eq!(reach(&["other.q"]), all(&["other.q"], "other.q"));
    assert_eq!(reach(&["ping.q"]), all(&["ping.q", "pong.q"], "ping.q"));
    // A file reached from two changes names both, in the order they were
    // given; one the graph does not hold is in no answer.
    assert_eq!(
        reach(&["lib.q", "gone.q", "app.q"]),
        [
            (
                "app.q".to_string(),
                vec!["lib.q".to_string(), "app.q".into()]
            ),
            ("lib.q".into(), vec!["lib.q".into()]),
            (
                "tests/test_app.q".into(),
                vec!["lib.q".into(), "app.q".into()]
            ),
        ]
    );
    assert!(reach(&[]).is_empty());
}

// ---------------------------------------------------------------------------
// The language server, driven as an editor drives it.

struct Server {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    next_id: u64,
    /// The workspace folder, by the last part of its path: what a URI is cut
    /// at to name a file as the tests write it.
    folder: String,
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
    /// A server over the workspace `dir`, holding `files`, with the options
    /// the client sends.
    fn over(dir: &Path, files: &[(&str, &str)], options: Value) -> (Self, Value) {
        for (name, text) in files {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
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
            folder: format!("/{}/", dir.file_name().unwrap().to_string_lossy()),
        };
        let reply = server.request(
            "initialize",
            json!({"capabilities": {}, "initializationOptions": options,
                   "workspaceFolders": [{"uri": file_uri(dir), "name": "ws"}]}),
        );
        server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
        (server, reply)
    }

    fn start(dir: &Path, files: &[(&str, &str)]) -> Self {
        Self::over(dir, files, Value::Null).0
    }

    fn send(&mut self, value: Value) {
        let body = serde_json::to_vec(&value).unwrap();
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.stdin.write_all(&body).unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        self.messages
            .recv_timeout(Duration::from_secs(30))
            .expect("the server answers")
    }

    /// The reply to a request, past the diagnostics pushed meanwhile.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        loop {
            let message = self.receive();
            if message["id"] == id {
                return message;
            }
        }
    }

    /// The result of a request that is answered and not refused.
    fn result(&mut self, method: &str, params: Value) -> Value {
        let reply = self.request(method, params);
        assert!(reply["error"].is_null(), "{method}: {reply}");
        reply["result"].clone()
    }

    fn open(&mut self, dir: &Path, name: &str, text: &str) -> String {
        let uri = file_uri(&dir.join(name));
        self.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
            "params":{"textDocument":{"uri":uri,"languageId":"q","version":1,"text":text}}}));
        uri
    }

    fn change(&mut self, uri: &str, text: &str) {
        self.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
            "params":{"textDocument":{"uri":uri,"version":2},
                      "contentChanges":[{"text":text}]}}));
    }

    /// A file as the tests name it: its path below the workspace folder.
    fn name(&self, uri: &Value) -> String {
        let uri = uri.as_str().unwrap_or_else(|| panic!("a URI, not {uri}"));
        let at = uri.find(&self.folder).expect("a file in the workspace");
        uri[at + self.folder.len()..].to_string()
    }

    fn names(&self, uris: &Value) -> Vec<String> {
        uris.as_array()
            .unwrap_or_else(|| panic!("a list of URIs, not {uris}"))
            .iter()
            .map(|uri| self.name(uri))
            .collect()
    }

    /// `q-lint/graph` for the document `uri`.
    fn graph(&mut self, uri: &str) -> Value {
        self.result("q-lint/graph", json!({"textDocument": {"uri": uri}}))
    }

    /// `q-lint/affectedTests` for the changed files: each test with the
    /// changes it reaches, and the files the index does not hold.
    fn affected(&mut self, dir: &Path, changed: &[&str]) -> (Vec<Affected>, Vec<String>) {
        let changed: Vec<String> = changed.iter().map(|c| file_uri(&dir.join(c))).collect();
        let result = self.result("q-lint/affectedTests", json!({"changed": changed}));
        let tests = result["tests"]
            .as_array()
            .unwrap_or_else(|| panic!("a list of tests, not {result}"))
            .iter()
            .map(|test| {
                let reaches = test["reaches"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|place| self.name(&result["changed"][place.as_u64().unwrap() as usize]))
                    .collect();
                (self.name(&test["uri"]), reaches)
            })
            .collect();
        (tests, self.names(&result["unindexed"]))
    }

    /// `textDocument/prepareCallHierarchy` at `context`+`skip` in the open
    /// document `uri`, whose text is `text`.
    fn prepare(&mut self, uri: &str, text: &str, context: &str, skip: usize) -> Value {
        let offset = text.find(context).expect("the context is in the source") + skip;
        let line = text[..offset].matches('\n').count();
        let character = text[..offset]
            .rsplit('\n')
            .next()
            .unwrap()
            .encode_utf16()
            .count();
        self.result(
            "textDocument/prepareCallHierarchy",
            json!({"textDocument": {"uri": uri},
                   "position": {"line": line, "character": character}}),
        )
    }

    /// The one item prepared there.
    fn item(&mut self, uri: &str, text: &str, context: &str, skip: usize) -> Value {
        let items = self.prepare(uri, text, context, skip);
        assert_eq!(items.as_array().map(Vec::len), Some(1), "{items}");
        items[0].clone()
    }

    /// The calls into (`incomingCalls`) or out of (`outgoingCalls`) `item`,
    /// each as the other end and the places it is named.
    fn calls(&mut self, direction: &str, item: &Value) -> Vec<(Value, Call)> {
        let end = if direction == "incomingCalls" {
            "from"
        } else {
            "to"
        };
        let result = self.result(&format!("callHierarchy/{direction}"), json!({"item": item}));
        result
            .as_array()
            .unwrap_or_else(|| panic!("a list of calls, not {result}"))
            .iter()
            .map(|call| {
                let other = &call[end];
                let places = call["fromRanges"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(span)
                    .collect();
                let summary = (
                    other["name"].as_str().unwrap().to_string(),
                    other["kind"].as_u64().unwrap(),
                    self.name(&other["uri"]),
                    places,
                );
                (other.clone(), summary)
            })
            .collect()
    }

    fn summaries(&mut self, direction: &str, item: &Value) -> Vec<Call> {
        let calls = self.calls(direction, item);
        calls.into_iter().map(|(_, summary)| summary).collect()
    }
}

/// A test, and the changed files it reaches.
type Affected = (String, Vec<String>);

/// One end of a call: its name, `SymbolKind`, file, and each place the call
/// is written as `(line, start character, end character)`.
type Call = (String, u64, String, Vec<(u64, u64, u64)>);

fn call(name: &str, kind: u64, file: &str, places: &[(u64, u64, u64)]) -> Call {
    (name.to_string(), kind, file.to_string(), places.to_vec())
}

/// A range as `(line, start character, end character)`; no name spans lines.
fn span(range: &Value) -> (u64, u64, u64) {
    (
        range["start"]["line"].as_u64().unwrap(),
        range["start"]["character"].as_u64().unwrap(),
        range["end"]["character"].as_u64().unwrap(),
    )
}

/// LSP's `SymbolKind`s.
const FILE: u64 = 1;
const FUNCTION: u64 = 12;
const VARIABLE: u64 = 13;

const LIB: &str = "\\d .lib\nadd:{[a;b] a+b}\nlimit:10\n\\d .\nroot_fn:{[v] v*2}\n";
const MAIN: &str = "\\l lib.q\ntotal:.lib.add[1;2]\n\
                    calc:{[n] m:n+.lib.limit; root_fn root_fn m}\n\
                    handlers:(calc;root_fn)\ncalc 3\n";
const TEST_MAIN: &str = "\\l main.q\ntest_calc:{calc[1]~22}\n";
const OTHER: &str = ".other.h:{x}\n";
const TEST_OTHER: &str = "test_h:{.other.h 1}\n";

/// A workspace of a library, a script over it, a file apart, and a test of
/// each of the last two.
const WORKSPACE: [(&str, &str); 5] = [
    ("lib.q", LIB),
    ("main.q", MAIN),
    ("other.q", OTHER),
    ("tests/test_main.q", TEST_MAIN),
    ("tests/test_other.q", TEST_OTHER),
];

#[test]
fn the_relations_are_announced_and_each_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, reply) = Server::over(dir.path(), &WORKSPACE, Value::Null);
    let capabilities = &reply["result"]["capabilities"];
    assert_eq!(capabilities["callHierarchyProvider"], true);
    assert_eq!(
        capabilities["experimental"],
        json!({"q-lint/graph": true, "q-lint/affectedTests": true})
    );
    let uri = server.open(dir.path(), "main.q", MAIN);
    assert!(server.graph(&uri).is_object());
    assert!(server.prepare(&uri, MAIN, "calc:", 0).is_array());
    drop(server);

    // Off, a section is not announced - and a client that asks anyway is
    // told there is nothing, not that the method does not exist. The other
    // section goes on answering.
    let options = json!({"graph": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[], options);
    let capabilities = &reply["result"]["capabilities"];
    assert!(capabilities["experimental"].is_null(), "{capabilities}");
    assert_eq!(capabilities["callHierarchyProvider"], true);
    let uri = server.open(dir.path(), "main.q", MAIN);
    assert_eq!(server.graph(&uri), Value::Null);
    let changed = json!({"changed": [uri]});
    assert_eq!(server.result("q-lint/affectedTests", changed), Value::Null);
    assert!(server.prepare(&uri, MAIN, "calc:", 0).is_array());
    drop(server);

    let options = json!({"callHierarchy": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[], options);
    let capabilities = &reply["result"]["capabilities"];
    assert!(
        capabilities["callHierarchyProvider"].is_null(),
        "{capabilities}"
    );
    assert_eq!(capabilities["experimental"]["q-lint/graph"], true);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let item = json!({"name": "calc", "kind": FUNCTION, "uri": uri,
        "range": {"start": {"line": 2, "character": 0}, "end": {"line": 2, "character": 4}},
        "selectionRange": {"start": {"line": 2, "character": 0}, "end": {"line": 2, "character": 4}}});
    assert_eq!(server.prepare(&uri, MAIN, "calc:", 0), Value::Null);
    for method in ["callHierarchy/incomingCalls", "callHierarchy/outgoingCalls"] {
        assert_eq!(server.result(method, json!({"item": item})), Value::Null);
    }
    assert!(server.graph(&uri).is_object());
}

#[test]
fn a_section_that_is_not_an_object_is_reported() {
    for (options, wanted) in [
        (json!({"graph": false}), "/graph must be an object"),
        (
            json!({"callHierarchy": "off"}),
            "/callHierarchy must be an object",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (mut server, _) = Server::over(dir.path(), &[], options.clone());
        let message = server.receive();
        assert_eq!(
            message["method"], "window/showMessage",
            "{options}: {message}"
        );
        let text = message["params"]["message"].as_str().unwrap();
        assert!(text.contains(wanted), "{options}: {text}");
    }
}

#[test]
fn a_request_that_names_no_document_is_refused_and_one_with_nothing_to_say_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    for method in ["q-lint/graph", "textDocument/prepareCallHierarchy"] {
        for params in [json!({}), Value::Null, json!([1])] {
            let reply = server.request(method, params);
            assert_eq!(reply["error"]["code"], -32602, "{method}: {reply}");
        }
    }
    // Nothing changed, and nothing that can be read as a change.
    for params in [json!({}), Value::Null, json!({"changed": "main.q"})] {
        assert_eq!(
            server.result("q-lint/affectedTests", params),
            json!({"tests": [], "changed": [], "unindexed": []})
        );
    }
    // No item, and an item that points nowhere.
    for method in ["callHierarchy/incomingCalls", "callHierarchy/outgoingCalls"] {
        for params in [
            json!({}),
            Value::Null,
            json!({"item": {"uri": 5}}),
            json!({"item": {"uri": "untitled:Untitled-1"}}),
        ] {
            assert_eq!(server.result(method, params), Value::Null, "{method}");
        }
    }
}

#[test]
fn a_file_has_the_files_it_depends_on_and_those_depending_on_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let graph = server.graph(&uri);
    // The document is named as the client named it.
    assert_eq!(graph["uri"], uri.as_str());
    assert_eq!(server.names(&graph["dependencies"]), ["lib.q"]);
    assert_eq!(server.names(&graph["dependents"]), ["tests/test_main.q"]);
    assert_eq!(graph["ambiguous"], json!({}));
    assert_eq!(graph["dynamic"], json!([]));

    // A file the editor has not opened is in the graph all the same, and
    // can be asked about.
    let lib = server.graph(&file_uri(&dir.path().join("lib.q")));
    assert!(server.names(&lib["dependencies"]).is_empty());
    assert_eq!(server.names(&lib["dependents"]), ["main.q"]);
    // An open document is named by the URI the client opened it with.
    assert_eq!(lib["dependents"][0], uri.as_str());
}

#[test]
fn the_graph_is_of_the_buffer_as_the_editor_has_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let graph = server.graph(&uri);
    assert_eq!(server.names(&graph["dependencies"]), ["lib.q"]);
    // Typed and not saved: the library is no longer read, another file is.
    server.change(&uri, "calc:{[n] .other.h n}\n");
    let graph = server.graph(&uri);
    assert_eq!(server.names(&graph["dependencies"]), ["other.q"]);
    let lib = server.graph(&file_uri(&dir.path().join("lib.q")));
    assert!(server.names(&lib["dependents"]).is_empty(), "{lib}");
}

#[test]
fn a_name_two_files_define_and_a_name_computed_at_run_time_come_with_the_graph() {
    let dir = tempfile::tempdir().unwrap();
    let files = [
        ("one.q", ".cfg.port:5000\n"),
        ("two.q", ".cfg.port:6000\n"),
        (
            "app.q",
            "start:{.cfg.port+x}\n\nrun:{value \"start \",string x}\n",
        ),
    ];
    let mut server = Server::start(dir.path(), &files);
    let graph = server.graph(&file_uri(&dir.path().join("app.q")));
    assert_eq!(server.names(&graph["dependencies"]), ["one.q", "two.q"]);
    let ambiguous = graph["ambiguous"].as_object().unwrap();
    assert_eq!(ambiguous.keys().collect::<Vec<_>>(), [".cfg.port"]);
    assert_eq!(server.names(&ambiguous[".cfg.port"]), ["one.q", "two.q"]);
    // The line is numbered from 1, as `qlinter analyze graph --detail` has it.
    assert_eq!(graph["dynamic"], json!([{"line": 3, "kind": "value"}]));
}

#[test]
fn a_document_that_is_not_an_indexed_q_file_has_no_graph() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    for name in ["README.md", "gone.q"] {
        let uri = file_uri(&dir.path().join(name));
        assert_eq!(server.graph(&uri), Value::Null, "{name}");
    }
    assert_eq!(server.graph("untitled:Untitled-1"), Value::Null);
}

#[test]
fn the_tests_a_change_reaches_are_listed_with_the_change_they_reach() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let test = |name: &str, changed: &[&str]| -> (String, Vec<String>) {
        (
            name.to_string(),
            changed.iter().map(|c| c.to_string()).collect(),
        )
    };
    // The test of the script over the library, and not the library or the
    // script, which a change also reaches and which are no tests.
    assert_eq!(
        server.affected(dir.path(), &["lib.q"]).0,
        [test("tests/test_main.q", &["lib.q"])]
    );
    // A changed test is itself to run, and each test names what it reaches.
    assert_eq!(
        server
            .affected(dir.path(), &["other.q", "main.q", "tests/test_main.q"])
            .0,
        [
            test("tests/test_main.q", &["main.q", "tests/test_main.q"]),
            test("tests/test_other.q", &["other.q"]),
        ]
    );
    // A change nothing tests reaches no test, and is no gap in the index.
    server.open(dir.path(), "lonely.q", ".lonely.f:{x}\n");
    assert_eq!(server.affected(dir.path(), &["lonely.q"]), (vec![], vec![]));
    let (tests, unindexed) = server.affected(dir.path(), &[]);
    assert!(tests.is_empty() && unindexed.is_empty());
}

#[test]
fn a_changed_file_is_named_back_by_the_uri_the_client_sent() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    // As an editor on Windows or one that escapes more than it must spells
    // it: the answer repeats that spelling, which is what the client has to
    // recognise, and does not send the server's own.
    let sent = file_uri(&dir.path().join("lib.q")).replace("lib.q", "%6Cib.q");
    let result = server.result("q-lint/affectedTests", json!({"changed": [sent, sent]}));
    assert_eq!(result["tests"].as_array().unwrap().len(), 1, "{result}");
    assert_eq!(result["changed"], json!([sent]));
    assert_eq!(result["tests"][0]["reaches"], json!([0]));
    assert_eq!(result["tests"][0]["self"], Value::Null);
}

#[test]
fn a_changed_test_is_told_its_own_place_among_the_changed_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    // The test is not open, so its `uri` is the server's spelling of the
    // path and the client's is another: `self` says which changed file it
    // is, where comparing the two as text would not.
    let test = file_uri(&dir.path().join("tests/test_main.q")).replace("test_main", "%74est_main");
    let lib = file_uri(&dir.path().join("lib.q"));
    let result = server.result("q-lint/affectedTests", json!({"changed": [lib, test]}));
    assert_eq!(result["changed"], json!([lib, test]));
    let tests = result["tests"].as_array().unwrap();
    assert_eq!(tests.len(), 1, "{result}");
    assert_ne!(tests[0]["uri"], json!(test));
    assert_eq!(server.name(&tests[0]["uri"]), "tests/test_main.q");
    assert_eq!(tests[0]["reaches"], json!([0, 1]));
    assert_eq!(tests[0]["self"], json!(1));
}

#[test]
fn a_changed_file_the_index_does_not_hold_is_said_to_be_unindexed() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    // A deleted q file's dependents cannot be followed, so it is named; a
    // file that is not q is nothing this server reads, and is passed over.
    let (tests, unindexed) = server.affected(
        dir.path(),
        &[
            "deleted.q",
            "lib.q",
            "README.md",
            "data/trades.csv",
            "deleted.q",
        ],
    );
    assert_eq!(tests.len(), 1);
    assert_eq!(unindexed, ["deleted.q"]);
}

#[test]
fn a_test_changed_in_the_editor_and_not_saved_reaches_what_the_buffer_reads() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    assert!(server.affected(dir.path(), &["lib.q"]).0.len() == 1);
    let uri = server.open(dir.path(), "tests/test_other.q", TEST_OTHER);
    server.change(&uri, "test_h:{.other.h .lib.add[1;2]}\n");
    let tests: Vec<String> = server
        .affected(dir.path(), &["lib.q"])
        .0
        .into_iter()
        .map(|(test, _)| test)
        .collect();
    assert_eq!(tests, ["tests/test_main.q", "tests/test_other.q"]);
}

#[test]
fn a_hierarchy_is_prepared_on_a_function_wherever_it_is_named() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let uri = server.open(dir.path(), "main.q", MAIN);
    // On a call, the item is the definition - in a file not open here.
    let item = server.item(&uri, MAIN, "root_fn m", 3);
    assert_eq!(item["name"], "root_fn");
    assert_eq!(item["kind"], FUNCTION);
    assert_eq!(item["detail"], "[v]");
    assert_eq!(server.name(&item["uri"]), "lib.q");
    // The statement to show, and the name in it to select.
    assert_eq!(span(&item["range"]), (4, 0, 17));
    assert_eq!(span(&item["selectionRange"]), (4, 0, 7));
    // On the definition itself, and on a name in another context, the same.
    let own = server.item(&uri, MAIN, "calc:", 1);
    assert_eq!(
        (own["name"].as_str(), span(&own["range"])),
        (Some("calc"), (2, 0, 44))
    );
    let add = server.item(&uri, MAIN, ".lib.add", 6);
    assert_eq!(add["name"], ".lib.add");
    assert_eq!(span(&add["selectionRange"]), (1, 0, 3));
}

#[test]
fn nothing_is_prepared_on_a_variable_a_local_or_a_name_nothing_defines() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let text = "calc2:{[n] m:n+.lib.limit; missing m}\n\n";
    let uri = server.open(dir.path(), "extra.q", text);
    for (context, skip) in [
        // A variable, a parameter, a local, a name no file defines, a blank.
        (".lib.limit", 6),
        ("n+", 0),
        ("m}", 0),
        ("missing", 2),
        ("\n\n", 1),
    ] {
        assert_eq!(
            server.prepare(&uri, text, context, skip),
            Value::Null,
            "{context}"
        );
    }
}

#[test]
fn the_callers_of_a_function_are_the_definitions_and_files_that_name_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let root_fn = server.item(&uri, MAIN, "root_fn m", 3);
    assert_eq!(
        server.summaries("incomingCalls", &root_fn),
        [
            // Twice in one function is one caller, named in two places.
            call("calc", FUNCTION, "main.q", &[(2, 26, 33), (2, 34, 41)]),
            // Handed on as a value, which reading cannot tell from a call.
            call("handlers", VARIABLE, "main.q", &[(3, 15, 22)]),
        ]
    );
    // A call outside every definition is the file's own, and a caller in a
    // file the editor has not opened is read from disk.
    let calc = server.item(&uri, MAIN, "calc:", 0);
    assert_eq!(
        server.summaries("incomingCalls", &calc),
        [
            call("handlers", VARIABLE, "main.q", &[(3, 10, 14)]),
            call("main.q", FILE, "main.q", &[(4, 0, 4)]),
            call("test_calc", FUNCTION, "tests/test_main.q", &[(1, 11, 15)]),
        ]
    );
}

#[test]
fn a_caller_is_an_item_whose_own_callers_can_be_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let root_fn = server.item(&uri, MAIN, "root_fn m", 3);
    let callers = server.calls("incomingCalls", &root_fn);
    // `calc`, then who calls `calc`: one level up the tree an editor draws.
    let (calc, _) = &callers[0];
    assert_eq!(calc["detail"], "[n]");
    assert_eq!(span(&calc["selectionRange"]), (2, 0, 4));
    let above: Vec<String> = server
        .summaries("incomingCalls", calc)
        .into_iter()
        .map(|(name, ..)| name)
        .collect();
    assert_eq!(above, ["handlers", "main.q", "test_calc"]);
    // Nothing names a file, so the file's item ends the climb.
    let callers = server.calls("incomingCalls", calc);
    let (file, _) = &callers[1];
    assert_eq!(span(&file["selectionRange"]), (0, 0, 0));
    assert!(server.summaries("incomingCalls", file).is_empty());
}

#[test]
fn the_calls_of_a_function_are_the_workspace_functions_its_statement_names() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let uri = server.open(dir.path(), "main.q", MAIN);
    // The function in another file, each place it is named - and not
    // `.lib.limit`, which is no function, nor q's own `+`.
    let calc = server.item(&uri, MAIN, "calc:", 0);
    assert_eq!(
        server.summaries("outgoingCalls", &calc),
        [call(
            "root_fn",
            FUNCTION,
            "lib.q",
            &[(2, 26, 33), (2, 34, 41)]
        )]
    );
    // A function that calls none answers with none.
    let root_fn = server.item(&uri, MAIN, "root_fn m", 3);
    assert!(server.summaries("outgoingCalls", &root_fn).is_empty());
    // What the file calls as it loads is asked of the file's item.
    let callers = server.calls("incomingCalls", &calc);
    let (file, _) = &callers[1];
    assert_eq!(
        server.summaries("outgoingCalls", file),
        [call("calc", FUNCTION, "main.q", &[(4, 0, 4)])]
    );
    // A variable that holds functions names them, and so leads to them.
    let (handlers, _) = &callers[0];
    assert_eq!(
        server.summaries("outgoingCalls", handlers),
        [
            call("root_fn", FUNCTION, "lib.q", &[(3, 15, 22)]),
            call("calc", FUNCTION, "main.q", &[(3, 10, 14)]),
        ]
    );
}

#[test]
fn a_bare_name_under_a_context_is_the_function_that_context_holds() {
    let dir = tempfile::tempdir().unwrap();
    let app = "\\d .lib\ntwice:{add[x;x]}\n\\d .\nadd:{x}\nuse:{add[x;1]}\n";
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "app.q", app);
    // `add` under `\d .lib` is `.lib.add`; at the root it is the root's.
    let twice = server.item(&uri, app, "twice", 0);
    assert_eq!(twice["name"], ".lib.twice");
    assert_eq!(
        server.summaries("outgoingCalls", &twice),
        [call(".lib.add", FUNCTION, "lib.q", &[(1, 7, 10)])]
    );
    let lib_add = server.item(&uri, app, "add[x;x]", 0);
    assert_eq!(
        server.summaries("incomingCalls", &lib_add),
        [call(".lib.twice", FUNCTION, "app.q", &[(1, 7, 10)])]
    );
    let root_add = server.item(&uri, app, "add[x;1]", 0);
    assert_eq!(server.name(&root_add["uri"]), "app.q");
    assert_eq!(
        server.summaries("incomingCalls", &root_add),
        [call("use", FUNCTION, "app.q", &[(4, 5, 8)])]
    );
}

#[test]
fn a_function_two_files_define_is_prepared_as_both() {
    let dir = tempfile::tempdir().unwrap();
    let files = [("one.q", ".app.run:{1}\n"), ("two.q", ".app.run:{[a] 2}\n")];
    let mut server = Server::start(dir.path(), &files);
    let text = "go:{.app.run[]}\n";
    let uri = server.open(dir.path(), "go.q", text);
    // Which assignment ran last is not something reading says.
    let items = server.prepare(&uri, text, ".app.run", 2);
    let found: Vec<(String, &str)> = items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| (server.name(&item["uri"]), item["detail"].as_str().unwrap()))
        .collect();
    assert_eq!(
        found,
        [("one.q".to_string(), ""), ("two.q".to_string(), "[a]")]
    );
    // Either has the one caller, and the caller calls both.
    for item in items.as_array().unwrap() {
        assert_eq!(
            server.summaries("incomingCalls", item),
            [call("go", FUNCTION, "go.q", &[(0, 4, 12)])]
        );
    }
    let go = server.item(&uri, text, "go:", 0);
    assert_eq!(server.summaries("outgoingCalls", &go).len(), 2);
}

#[test]
fn a_call_by_a_string_is_not_seen_and_a_recursive_one_is() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "fact:{$[x<2;1;x*fact x-1]}\nrun:{value \"fact 5\"}\nby_name:{`fact . enlist x}\n";
    let uri = server.open(dir.path(), "fact.q", text);
    let fact = server.item(&uri, text, "fact:", 0);
    // Only itself: `value "fact 5"` and a call through the symbol name
    // nothing but q can follow.
    assert_eq!(
        server.summaries("incomingCalls", &fact),
        [call("fact", FUNCTION, "fact.q", &[(0, 16, 20)])]
    );
    assert_eq!(
        server.summaries("outgoingCalls", &fact),
        [call("fact", FUNCTION, "fact.q", &[(0, 16, 20)])]
    );
}

#[test]
fn an_item_prepared_before_an_edit_that_removed_it_answers_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let calc = server.item(&uri, MAIN, "calc:", 0);
    assert!(!server.summaries("incomingCalls", &calc).is_empty());
    // The line the item points at now holds no definition: the item is
    // found again in the text as it is, and not believed.
    server.change(&uri, "\\l lib.q\n\n\n\ncalc:{[n] root_fn n}\n");
    for method in ["callHierarchy/incomingCalls", "callHierarchy/outgoingCalls"] {
        assert_eq!(server.result(method, json!({"item": calc})), Value::Null);
    }
    // And one that moved is found where it is now, with the buffer's calls.
    let moved = server.item(&uri, "\\l lib.q\n\n\n\ncalc:{[n] root_fn n}\n", "calc:", 0);
    assert_eq!(
        server.summaries("outgoingCalls", &moved),
        [call("root_fn", FUNCTION, "lib.q", &[(4, 10, 17)])]
    );
}

#[test]
fn an_item_whose_place_now_defines_another_name_answers_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &WORKSPACE);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let calc = server.item(&uri, MAIN, "calc:", 0);
    // Where `calc` was defined, `tidy` is now: the node an editor still
    // shows is `calc`, and `tidy`'s calls are not what it asked for.
    server.change(&uri, &MAIN.replace("calc:{[n] m:n", "tidy:{[n] m:n"));
    for method in ["callHierarchy/incomingCalls", "callHierarchy/outgoingCalls"] {
        assert_eq!(server.result(method, json!({"item": calc})), Value::Null);
    }
}

#[test]
fn a_file_that_calls_is_named_as_it_is_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let files = [("lib.q", LIB), ("my script.q", "\\l lib.q\nroot_fn 1\n")];
    let mut server = Server::start(dir.path(), &files);
    let uri = server.open(dir.path(), "lib.q", LIB);
    let root_fn = server.item(&uri, LIB, "root_fn:", 0);
    // The URI spells the space `%20`; the name an editor shows does not.
    assert_eq!(
        server.summaries("incomingCalls", &root_fn),
        [call("my script.q", FILE, "my%20script.q", &[(1, 0, 7)])]
    );
}

#[test]
fn a_function_assigned_inside_another_has_callers_and_its_calls_are_the_outer_ones() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let text = "init:{hook::{root_fn x}; 1}\nfire:{hook 1}\n";
    let uri = server.open(dir.path(), "hooks.q", text);
    let hook = server.item(&uri, text, "hook 1", 0);
    assert_eq!(span(&hook["selectionRange"]), (0, 6, 10));
    assert_eq!(
        server.summaries("incomingCalls", &hook),
        [call("fire", FUNCTION, "hooks.q", &[(1, 6, 10)])]
    );
    // What it names is in `init`'s statement, and listed there.
    assert!(server.summaries("outgoingCalls", &hook).is_empty());
    let init = server.item(&uri, text, "init:", 0);
    assert_eq!(
        server.summaries("outgoingCalls", &init),
        [call("root_fn", FUNCTION, "lib.q", &[(0, 13, 20)])]
    );
}

/// Every `file:` URI anywhere in `value`.
fn uris_in(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) if s.starts_with("file:") => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| uris_in(v, out)),
        Value::Object(map) => {
            for (key, v) in map {
                // A workspace edit is keyed by the URI it changes.
                if key.starts_with("file:") {
                    out.push(key.clone());
                }
                uris_in(v, out);
            }
        }
        _ => {}
    }
}

#[cfg(unix)]
#[test]
fn a_workspace_opened_through_a_link_is_answered_in_the_links_spelling() {
    // The folder is opened as `link`, a symlink to `real`, as a workspace
    // under `/tmp` is on macOS. The index keys each file by its real path;
    // answers named the files the editor had not opened by that path, which
    // it showed as `/private/tmp/...` and opened a second time (#850).
    let top = tempfile::tempdir().unwrap();
    let real = top.path().join("real");
    std::fs::create_dir(&real).unwrap();
    let link = top.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let mut server = Server::start(&link, &WORKSPACE);
    let main = server.open(&link, "main.q", MAIN);
    let lib = file_uri(&link.join("lib.q"));
    let test_main = file_uri(&link.join("tests/test_main.q"));
    let at = |context: &str, skip: usize| {
        let offset = MAIN.find(context).unwrap() + skip;
        let line = MAIN[..offset].matches('\n').count();
        let character = offset - MAIN[..offset].rfind('\n').map_or(0, |i| i + 1);
        json!({"textDocument": {"uri": main}, "position": {"line": line, "character": character}})
    };
    let mut answers = vec![];
    let definition = server.result("textDocument/definition", at(".lib.add", 6));
    assert_eq!(definition[0]["uri"], json!(lib), "{definition}");
    answers.push(definition);
    let mut references = at("root_fn root_fn", 0);
    references["context"] = json!({"includeDeclaration": true});
    let references = server.result("textDocument/references", references);
    let files: Vec<&Value> = references
        .as_array()
        .unwrap()
        .iter()
        .map(|r| &r["uri"])
        .collect();
    assert!(files.contains(&&json!(lib)), "{references}");
    assert!(files.contains(&&json!(main)), "{references}");
    answers.push(references);
    let symbols = server.result("workspace/symbol", json!({"query": "root_fn"}));
    assert_eq!(symbols[0]["location"]["uri"], json!(lib), "{symbols}");
    answers.push(symbols);
    answers.push(server.result(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": main}}),
    ));
    let item = server.item(&main, MAIN, ".lib.add", 6);
    assert_eq!(item["uri"], json!(lib));
    answers.push(item.clone());
    answers.push(server.result("callHierarchy/incomingCalls", json!({"item": item})));
    let calc = server.item(&main, MAIN, "calc:", 0);
    answers.push(server.result("callHierarchy/outgoingCalls", json!({"item": calc})));
    let root_fn = server.item(&main, MAIN, "root_fn root_fn", 0);
    answers.push(server.result("callHierarchy/incomingCalls", json!({"item": root_fn})));
    let graph = server.graph(&main);
    assert_eq!(graph["dependencies"], json!([lib]), "{graph}");
    assert_eq!(graph["dependents"], json!([test_main]), "{graph}");
    answers.push(graph);
    let affected = server.result("q-lint/affectedTests", json!({"changed": [lib]}));
    assert_eq!(affected["tests"][0]["uri"], json!(test_main), "{affected}");
    assert_eq!(affected["changed"], json!([lib]));
    answers.push(affected);
    let mut rename = at("calc:{[n]", 7);
    rename["newName"] = json!("k");
    answers.push(server.result("textDocument/rename", rename));
    // And nothing in any answer is named by the real path.
    let mut named = vec![];
    answers
        .iter()
        .for_each(|answer| uris_in(answer, &mut named));
    let spelled = file_uri(&link);
    assert!(named.len() > 10, "{named:?}");
    for uri in &named {
        assert!(
            uri.starts_with(&format!("{spelled}/")),
            "{uri} in {answers:?}"
        );
    }
}
