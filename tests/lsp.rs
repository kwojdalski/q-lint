//! The language server driven the way an editor drives it: a real process,
//! real LSP framing on its stdin and stdout.
//!
//! Unit tests over `serve` with in-memory buffers would miss the two things
//! most likely to break an editor integration - the wire framing, and the
//! process not exiting - because both only exist once there is a process.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Server {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(["--lsp", "--profile", "uqf"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn qlinter --lsp");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn send(&mut self, value: Value) {
        let body = serde_json::to_vec(&value).unwrap();
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.stdin.write_all(&body).unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        let mut length = 0;
        loop {
            let mut line = String::new();
            assert!(
                self.stdout.read_line(&mut line).unwrap() > 0,
                "server closed stdout while a reply was expected"
            );
            if line == "\r\n" {
                break;
            }
            if let Some(v) = line.strip_prefix("Content-Length: ") {
                length = v.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        self.stdout.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    /// Read until a publishDiagnostics for this uri arrives.
    fn diagnostics_for(&mut self, uri: &str) -> Vec<Value> {
        for _ in 0..10 {
            let message = self.receive();
            if message["method"] == "textDocument/publishDiagnostics"
                && message["params"]["uri"] == uri
            {
                return message["params"]["diagnostics"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
            }
        }
        panic!("no diagnostics for {uri}");
    }

    fn initialize(&mut self) -> Value {
        self.send(
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}),
        );
        let reply = self.receive();
        self.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
        reply
    }

    fn open(&mut self, uri: &str, text: &str) {
        self.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
            "params":{"textDocument":{"uri":uri,"languageId":"q","version":1,"text":text}}}));
    }

    fn shutdown_and_exit(&mut self) -> i32 {
        self.send(json!({"jsonrpc":"2.0","id":99,"method":"shutdown"}));
        let reply = self.receive();
        assert_eq!(reply["id"], 99, "shutdown must be answered");
        self.send(json!({"jsonrpc":"2.0","method":"exit"}));
        self.child.wait().unwrap().code().unwrap_or(-1)
    }
}

/// `desc` is a q builtin, so this is a reserved-parameter finding (QF001) -
/// the same trap this repository has hit in real code more than once.
const RESERVED_PARAM: &str = "f:{[desc] 1+1}\n";

#[test]
fn initialize_announces_full_document_sync() {
    // An editor reads this to decide what to send on every keystroke. Getting
    // it wrong means either no updates or updates the server cannot apply.
    let mut server = Server::start();
    let reply = server.initialize();
    assert_eq!(reply["result"]["capabilities"]["textDocumentSync"], 1);
    assert_eq!(reply["result"]["serverInfo"]["name"], "q-lint");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn opening_a_document_publishes_its_findings() {
    let mut server = Server::start();
    server.initialize();
    server.open("file:///tmp/probe.q", RESERVED_PARAM);
    let diagnostics = server.diagnostics_for("file:///tmp/probe.q");
    assert_eq!(diagnostics.len(), 1, "one finding: {diagnostics:?}");
    assert_eq!(diagnostics[0]["code"], "QF001");
    assert_eq!(diagnostics[0]["source"], "q-lint");
    assert_eq!(diagnostics[0]["severity"], 2);
    // Zero-based, unlike the finding's own 1-based line.
    assert_eq!(diagnostics[0]["range"]["start"]["line"], 0);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_change_lints_the_buffer_rather_than_the_file_on_disk() {
    // THE REASON THIS IS A SERVER. The URI names a file that does not exist;
    // the text only ever lived in the editor. A CLI over paths cannot do this.
    let mut server = Server::start();
    server.initialize();
    server.open("file:///tmp/never-written.q", "f:{[x] x}\n");
    assert!(
        server
            .diagnostics_for("file:///tmp/never-written.q")
            .is_empty(),
        "clean buffer starts with no findings"
    );
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":"file:///tmp/never-written.q","version":2},
                  "contentChanges":[{"text": RESERVED_PARAM}]}}));
    let diagnostics = server.diagnostics_for("file:///tmp/never-written.q");
    assert_eq!(diagnostics.len(), 1, "the edited text is what gets linted");
    assert_eq!(diagnostics[0]["code"], "QF001");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn the_last_change_wins_when_a_client_batches_edits() {
    // A client may coalesce edits into one notification. Taking the first
    // would lint a buffer the user has already moved past, and the symptom -
    // diagnostics one keystroke stale - is easy to mistake for lag.
    let mut server = Server::start();
    server.initialize();
    server.open("file:///tmp/batched.q", RESERVED_PARAM);
    server.diagnostics_for("file:///tmp/batched.q");
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":"file:///tmp/batched.q","version":2},
                  "contentChanges":[{"text": RESERVED_PARAM},{"text":"f:{[x] x}\n"}]}}));
    assert!(
        server.diagnostics_for("file:///tmp/batched.q").is_empty(),
        "the final text is clean, so the findings clear"
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn closing_a_document_clears_its_diagnostics() {
    // An empty list, not silence: the server owns these until it says
    // otherwise, so a closed file would keep its squiggles in the problems
    // panel for the rest of the session.
    let mut server = Server::start();
    server.initialize();
    server.open("file:///tmp/closing.q", RESERVED_PARAM);
    assert_eq!(server.diagnostics_for("file:///tmp/closing.q").len(), 1);
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didClose",
        "params":{"textDocument":{"uri":"file:///tmp/closing.q"}}}));
    assert!(server.diagnostics_for("file:///tmp/closing.q").is_empty());
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn an_undefined_assignment_value_updates_and_clears_while_typing() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/namespace-value.q";
    server.open(uri, "\\d .example\nf:{[] aa:1; aa}\n\\d .\n");
    assert!(server.diagnostics_for(uri).is_empty());

    let source = "\\d .example\nf:{[] aa:bb; aa}\n\\d .\n";
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":2},
                  "contentChanges":[{"text":source}]}}));
    let diagnostics = server.diagnostics_for(uri);
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics[0]["code"], "QF018");
    assert_eq!(diagnostics[0]["severity"], 2);
    assert_eq!(
        diagnostics[0]["range"],
        json!({
            "start":{"line":1,"character":9}, "end":{"line":1,"character":11}
        })
    );

    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":3},
                  "contentChanges":[{"text":source.replace("f:{", "bb:42\nf:{")}]}}));
    assert!(
        server.diagnostics_for(uri).is_empty(),
        "a namespace global must clear the warning without saving or restarting"
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_percent_encoded_uri_reaches_the_rules_as_a_real_path() {
    // Without decoding, a path with a space arrives as %20 and the
    // filename-based rules see a file that does not exist.
    let mut server = Server::start();
    server.initialize();
    server.open("file:///tmp/a%20folder/probe.q", RESERVED_PARAM);
    let diagnostics = server.diagnostics_for("file:///tmp/a%20folder/probe.q");
    assert_eq!(diagnostics.len(), 1, "the document is still linted");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn an_unsupported_request_is_refused_rather_than_ignored() {
    // A request with no reply looks like a hung server to every client.
    let mut server = Server::start();
    server.initialize();
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"textDocument/completion","params":{}}));
    let reply = server.receive();
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["error"]["code"], -32601);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn exit_without_shutdown_reports_a_nonzero_code() {
    // The protocol's own rule, and the only way a supervisor can tell a
    // clean stop from an editor that died.
    let mut server = Server::start();
    server.initialize();
    server.send(json!({"jsonrpc":"2.0","method":"exit"}));
    assert_eq!(server.child.wait().unwrap().code().unwrap_or(-1), 1);
}

/// The client chooses the argv, not the test.
///
/// `vscode-languageclient` appends `--stdio` to an executable server's
/// arguments, and Neovim, Helix and Zed configurations conventionally include
/// it. A server that rejects an unknown flag exits before the handshake, and
/// the editor shows no diagnostics and no reason. Every test above spawns the
/// binary with argv of its own choosing, so none of them can catch that.
#[test]
fn the_flags_an_lsp_client_adds_are_accepted() {
    for args in [
        vec!["--lsp", "--profile", "general"],
        vec!["--lsp", "--profile", "general", "--stdio"],
        vec!["--lsp", "--stdio", "--profile", "general"],
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn");
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let body = json!({"jsonrpc":"2.0","id":1,"method":"initialize",
                          "params":{"processId":null,"rootUri":null,"capabilities":{}}})
        .to_string();
        write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        stdin.flush().unwrap();
        let mut header = String::new();
        stdout.read_line(&mut header).unwrap();
        assert!(
            header.starts_with("Content-Length:"),
            "no reply to initialize with args {args:?}: {header:?}"
        );
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The version has to be askable from a shell. It is in `serverInfo`, which
/// is no help to anyone holding a binary and wondering which one it is.
#[test]
fn the_binary_reports_its_version() {
    // All three spellings. clap's default short form is `-V`, and `-v` is the
    // one people type first.
    for flag in ["--version", "-V", "-v"] {
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .arg(flag)
            .output()
            .expect("run version flag");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{flag} exited {:?}", out.status);
        assert!(
            text.starts_with("qlinter ")
                && text
                    .trim()
                    .split(' ')
                    .nth(1)
                    .is_some_and(|v| v.contains('.')),
            "{flag}: expected `qlinter <version>`, got {text:?}"
        );
    }
}

/// Colour has to stay out of anything that is not a terminal. Every test here
/// reads stdout through a pipe, which is exactly the case: a stray escape
/// sequence would break `grep`, an editor's problem matcher, and this test.
#[test]
fn colour_appears_only_when_asked_for_and_never_in_a_pipe() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("c.q");
    std::fs::write(&file, "g:{[a] a+`x}\n").unwrap();
    let run = |args: &[&str], no_color: bool| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_qlinter"));
        cmd.args(args).arg(&file);
        if no_color {
            cmd.env("NO_COLOR", "1");
        } else {
            cmd.env_remove("NO_COLOR");
        }
        String::from_utf8(cmd.output().unwrap().stdout).unwrap()
    };
    let esc = |s: &str| s.contains('\x1b');
    // A pipe, which is what this test is: no colour on auto.
    assert!(!esc(&run(&[], false)), "auto coloured a pipe");
    assert!(!esc(&run(&["--color", "never"], false)));
    assert!(
        esc(&run(&["--color", "always"], false)),
        "always did not colour"
    );
    // NO_COLOR wins over auto but not over an explicit always.
    assert!(!esc(&run(&["--color", "auto"], true)));
    assert!(esc(&run(&["--color", "always"], true)));
    // The severity is what gets the colour, and the summary tallies it.
    let coloured = run(&["--color", "always"], false);
    assert!(coloured.contains("\x1b[1;31merror\x1b[0m"), "{coloured:?}");
    assert!(coloured.contains("1 error"), "{coloured:?}");
    // JSON is a data format and never carries an escape, whatever the flag.
    assert!(!esc(&run(
        &["--color", "always", "--format", "json"],
        false
    )));
}

/// The server lints q source and nothing else.
///
/// A client opens what the user opens. Another q extension labels its console
/// buffer `q`, an untitled scratch carries whatever language was last picked,
/// and `.k` is a different language that happens to live beside q. The rules
/// here describe q; run against any of those they assert something untrue.
/// A non-`.q` document gets an empty diagnostic list rather than no reply, so
/// anything stale from a rename is cleared.
#[test]
fn only_q_files_are_linted() {
    for (uri, want) in [
        ("file:///tmp/a.k", 0),          // k, not q
        ("output:q-console", 0),         // a REPL transcript
        ("untitled:Untitled-1", 0),      // an unsaved scratch
        ("file:///tmp/a.txt", 0),        // not q at all
        ("file:///tmp/a.q", 1),          // q
        ("file:///tmp/A.Q", 1),          // q, shouted
        ("file:///tmp/my%20dir/b.q", 1), // q, with an escaped space
    ] {
        let mut server = Server::start();
        server.initialize();
        server.open(uri, "f:{[count] count+1}\n");
        let found = server.diagnostics_for(uri).len();
        assert_eq!(
            found, want,
            "{uri} produced {found} diagnostics, wanted {want}"
        );
        server.shutdown_and_exit();
    }
}
