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
    sync::mpsc::{Receiver, RecvTimeoutError, channel},
    time::Duration,
};

struct Server {
    child: Child,
    stdin: ChildStdin,
    /// The server's messages, read off its stdout by a thread of their own,
    /// so a wait for one can give up: a reply that never comes fails the
    /// test instead of hanging it, and CI with it.
    messages: Receiver<Value>,
}

/// How long a test waits for the server's next message.
const WAIT: Duration = Duration::from_secs(30);

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
    /// A test that failed while the server still ran leaves no process
    /// behind.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    fn start() -> Self {
        Self::start_in(std::env::current_dir().unwrap().as_path(), &[])
    }

    /// The server started in `dir`, where it looks for `[tool.q-lint]`, with
    /// extra arguments after the usual ones.
    fn start_in(dir: &std::path::Path, extra: &[&str]) -> Self {
        let mut args = vec!["--lsp", "--profile", "uqf"];
        args.extend(extra);
        Self::spawn(dir, &args)
    }

    /// The server started in `dir` with exactly `args`, and no user-level
    /// configuration from the machine running the tests.
    fn spawn(dir: &std::path::Path, args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(dir)
            .env("XDG_CONFIG_HOME", dir.join("no-such-config-home"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn qlinter --lsp");
        let stdin = child.stdin.take().unwrap();
        let messages = read_messages(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            messages,
        }
    }

    fn send(&mut self, value: Value) {
        let body = serde_json::to_vec(&value).unwrap();
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.stdin.write_all(&body).unwrap();
        self.stdin.flush().unwrap();
    }

    /// Bytes exactly as given, framing and all, for messages a well-behaved
    /// client would never send.
    fn raw(&mut self, bytes: &[u8]) {
        self.stdin.write_all(bytes).unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self) -> Value {
        match self.messages.recv_timeout(WAIT) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => {
                panic!("no message from the server in {} s", WAIT.as_secs())
            }
            Err(RecvTimeoutError::Disconnected) => {
                panic!("server closed stdout while a reply was expected")
            }
        }
    }

    /// Read until a message `wanted` accepts arrives, past whatever the
    /// server sends first - other documents linted again, say.
    fn until(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        (0..10)
            .map(|_| self.receive())
            .find(|m| wanted(m))
            .expect("the message arrived")
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
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":client_capabilities()}}),
        );
        let reply = self.receive();
        self.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
        reply
    }

    fn open(&mut self, uri: &str, text: &str) {
        self.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
            "params":{"textDocument":{"uri":uri,"languageId":"q","version":1,"text":text}}}));
    }

    fn code_actions(&mut self, uri: &str, diagnostics: &[Value]) -> Vec<Value> {
        self.send(
            json!({"jsonrpc":"2.0","id":20,"method":"textDocument/codeAction",
            "params":{"textDocument":{"uri":uri},"range":diagnostics[0]["range"],
                      "context":{"diagnostics":diagnostics}}}),
        );
        let reply = self.receive();
        assert_eq!(reply["id"], 20);
        reply["result"].as_array().cloned().unwrap()
    }

    /// The code actions of the kinds in `only`, asked for as an editor asks
    /// on save or from its Source Action menu: for the whole document, with
    /// no diagnostics.
    fn code_actions_only(&mut self, uri: &str, only: &[&str]) -> Vec<Value> {
        self.send(
            json!({"jsonrpc":"2.0","id":21,"method":"textDocument/codeAction",
            "params":{"textDocument":{"uri":uri},
                      "range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},
                      "context":{"diagnostics":[],"only":only}}}),
        );
        let reply = self.until(|m| m["id"] == 21);
        reply["result"].as_array().cloned().unwrap()
    }

    fn shutdown_and_exit(&mut self) -> i32 {
        self.send(json!({"jsonrpc":"2.0","id":99,"method":"shutdown"}));
        let reply = self.receive();
        assert_eq!(reply["id"], 99, "shutdown must be answered");
        self.send(json!({"jsonrpc":"2.0","method":"exit"}));
        self.child.wait().unwrap().code().unwrap_or(-1)
    }
}

/// What a server that offers quick fixes says it offers: the kinds, so an
/// editor knows there is a `source.fixAll` to ask for on save.
fn code_action_provider() -> Value {
    json!({"codeActionKinds": ["quickfix", "source.fixAll.q-lint"]})
}

/// What VS Code declares, as far as this server reads it: Quick Fixes come
/// back as `CodeAction` literals only to a client that says it takes them.
fn client_capabilities() -> Value {
    json!({"textDocument": {"codeAction": {"codeActionLiteralSupport":
        {"codeActionKind": {"valueSet": ["quickfix"]}}}}})
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
    // `save` present, or a client that follows LSP 3.17 never sends
    // didSave, and linting on save never lints.
    assert_eq!(
        reply["result"]["capabilities"]["textDocumentSync"],
        json!({"openClose": true, "change": 1, "save": {"includeText": false}})
    );
    assert_eq!(
        reply["result"]["capabilities"]["codeActionProvider"],
        code_action_provider()
    );
    assert_eq!(reply["result"]["serverInfo"]["name"], "q-lint");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn quick_fixes_go_only_to_a_client_that_takes_code_action_literals() {
    // LSP 3.17: without `codeActionLiteralSupport` a client can take only
    // Commands, and a fix here is an edit. So the provider is not announced,
    // and a request made anyway gets no literal back.
    let mut server = Server::start();
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}));
    let reply = server.receive();
    assert!(
        reply["result"]["capabilities"]
            .get("codeActionProvider")
            .is_none(),
        "{reply}"
    );
    server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    let uri = "file:///tmp/literals.q";
    server.open(uri, "a:1==1\n");
    let diagnostics = server.diagnostics_for(uri);
    assert_eq!(server.code_actions(uri, &diagnostics), Vec::<Value>::new());
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn quick_fixes_replace_foreign_operators_at_exact_utf16_positions() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/fixes.q";
    // The emoji is two UTF-16 code units. An edit based on byte or Unicode
    // scalar offsets would replace the wrong characters in this line.
    server.open(uri, "\"😀\"; a:1==1; b:1!=2; c:1&&2\n");
    let diagnostics = server.diagnostics_for(uri);
    let operators: Vec<Value> = diagnostics
        .iter()
        .filter(|d| d["code"] == "QE004")
        .cloned()
        .collect();
    assert_eq!(operators.len(), 3, "{diagnostics:?}");
    let equality_diagnostic = operators
        .iter()
        .find(|d| d["range"]["start"]["character"] == 9)
        .unwrap();
    assert_eq!(
        equality_diagnostic["range"],
        json!({"start":{"line":0,"character":9},"end":{"line":0,"character":11}})
    );
    assert_eq!(
        server
            .code_actions(uri, std::slice::from_ref(equality_diagnostic))
            .len(),
        1
    );
    let actions = server.code_actions(uri, &operators);
    assert_eq!(actions.len(), 3, "{actions:?}");
    let equality = actions
        .iter()
        .find(|a| a["edit"]["changes"][uri][0]["newText"] == "=")
        .unwrap();
    let inequality = actions
        .iter()
        .find(|a| a["edit"]["changes"][uri][0]["newText"] == "<>")
        .unwrap();
    let conjunction = actions
        .iter()
        .find(|a| a["edit"]["changes"][uri][0]["newText"] == "&")
        .unwrap();
    assert_eq!(equality["kind"], "quickfix");
    assert_eq!(
        equality["edit"]["changes"][uri][0]["range"],
        json!({"start":{"line":0,"character":9},"end":{"line":0,"character":11}})
    );
    assert_eq!(
        inequality["edit"]["changes"][uri][0]["range"],
        json!({"start":{"line":0,"character":17},"end":{"line":0,"character":19}})
    );
    assert_eq!(
        conjunction["edit"]["changes"][uri][0]["range"],
        json!({"start":{"line":0,"character":25},"end":{"line":0,"character":27}})
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn logical_operator_fixes_clear_the_diagnostics_after_use() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/logical-fixes.q";
    server.open(uri, "a:1b; b:0b; r:a&&b; s:a||b\n");
    let diagnostics = server.diagnostics_for(uri);
    let operators: Vec<Value> = diagnostics
        .iter()
        .filter(|d| d["code"] == "QE004")
        .cloned()
        .collect();
    assert_eq!(operators.len(), 2, "{diagnostics:?}");
    let actions = server.code_actions(uri, &operators);
    assert_eq!(actions.len(), 2, "{actions:?}");
    assert_eq!(
        actions
            .iter()
            .map(|a| a["edit"]["changes"][uri][0]["newText"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>(),
        std::collections::HashSet::from(["&", "|"])
    );
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":2},
                  "contentChanges":[{"text":"a:1b; b:0b; r:a&b; s:a|b\n"}]}}));
    assert!(server.diagnostics_for(uri).is_empty());
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn quick_fixes_ignore_stale_and_non_fixable_diagnostics() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/stale-fix.q";
    server.open(uri, "a:1==1\n");
    let old = server.diagnostics_for(uri);
    assert_eq!(server.code_actions(uri, &old).len(), 1);
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":2},
                  "contentChanges":[{"text":"a:1=1\nmissing;\n"}]}}));
    let current = server.diagnostics_for(uri);
    assert!(server.code_actions(uri, &old).is_empty());
    assert!(server.code_actions(uri, &current).is_empty());
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn quick_fixes_convert_assignment_operators() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/assignment-fixes.q";
    server.open(uri, "a:1; a+=2; a-=1; a*=3\n");
    let diagnostics = server.diagnostics_for(uri);
    let operators: Vec<Value> = diagnostics
        .iter()
        .filter(|d| d["code"] == "QE004")
        .cloned()
        .collect();
    assert_eq!(operators.len(), 3, "{diagnostics:?}");
    let actions = server.code_actions(uri, &operators);
    assert_eq!(actions.len(), 3, "{actions:?}");
    for (character, replacement) in [(6, "+:"), (12, "-:"), (18, "*:")] {
        let action = actions
            .iter()
            .find(|a| a["edit"]["changes"][uri][0]["newText"] == replacement)
            .unwrap();
        assert_eq!(
            action["edit"]["changes"][uri][0]["range"],
            json!({"start":{"line":0,"character":character},
                   "end":{"line":0,"character":character+2}})
        );
    }
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn quick_fix_removes_only_the_leading_bom() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/bom-fix.q";
    server.open(uri, "\u{feff}a:1\n");
    let diagnostics = server.diagnostics_for(uri);
    let bom = diagnostics.iter().find(|d| d["code"] == "QE005").unwrap();
    assert_eq!(
        bom["range"],
        json!({"start":{"line":0,"character":0},"end":{"line":0,"character":1}})
    );
    let actions = server.code_actions(uri, std::slice::from_ref(bom));
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["title"], "Remove byte-order mark");
    assert_eq!(actions[0]["edit"]["changes"][uri][0]["newText"], "");
    assert_eq!(actions[0]["edit"]["changes"][uri][0]["range"], bom["range"]);
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":2},
                  "contentChanges":[{"text":"a:1\n"}]}}));
    assert!(server.diagnostics_for(uri).is_empty());
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
    assert_eq!(diagnostics[0]["severity"], 1);
    // Zero-based, unlike the finding's own 1-based line.
    assert_eq!(diagnostics[0]["range"]["start"]["line"], 0);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_noqa_comment_suppresses_the_diagnostic() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/noqa.q";
    server.open(uri, "f:{[desc] 1+1} / noqa: QF001\ng:{[desc] 1+1}\n");
    let diagnostics = server.diagnostics_for(uri);
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics[0]["code"], "QF001");
    assert_eq!(diagnostics[0]["range"]["start"]["line"], 1);
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
fn a_percent_before_a_multibyte_character_does_not_stop_the_server() {
    // `%€` starts no escape. Reading the two characters after the `%` as a
    // str slice split the `€` and the server panicked with exit 101.
    for uri in [
        "file:///tmp/50%\u{20ac}off.q",
        "file:///tmp/x%+1.q",
        "file:///tmp/end%4.q",
    ] {
        let mut server = Server::start();
        server.initialize();
        server.open(uri, RESERVED_PARAM);
        let diagnostics = server.diagnostics_for(uri);
        assert_eq!(diagnostics.len(), 1, "{uri} is still linted");
        assert_eq!(server.shutdown_and_exit(), 0, "{uri}");
    }
}

#[test]
fn a_namespace_definition_does_not_hide_an_undefined_root_read() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/root-value.q";
    let source = "\\d .dasd\nbbb:2;\n\\d .\nbb;\n";
    server.open(uri, source);
    let diagnostics = server.diagnostics_for(uri);
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics[0]["code"], "QF018");
    assert_eq!(
        diagnostics[0]["range"],
        json!({
            "start":{"line":3,"character":0}, "end":{"line":3,"character":2}
        })
    );

    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":2},
                  "contentChanges":[{"text":source.replace("\\d .\n", "\\d .\nbb:2;\n")}]}}));
    assert!(server.diagnostics_for(uri).is_empty());
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn semantic_tokens_colour_calls_and_parameters_at_utf16_positions() {
    // The `f` inside the string is text, not a call, and the emoji before the
    // real call is two UTF-16 units: a server counting bytes or characters
    // would put the token somewhere else on the line.
    let mut server = Server::start();
    let reply = server.initialize();
    let legend = &reply["result"]["capabilities"]["semanticTokensProvider"]["legend"];
    assert_eq!(legend["tokenTypes"], json!(["function", "parameter"]));
    let uri = "file:///tmp/tokens.q";
    server.open(uri, "f:{[a] a+1}\nr:\"f\u{1F600}\";g:f[1]\n");
    server.diagnostics_for(uri);
    server.send(
        json!({"jsonrpc":"2.0","id":30,"method":"textDocument/semanticTokens/full",
        "params":{"textDocument":{"uri":uri}}}),
    );
    let reply = server.receive();
    assert_eq!(reply["id"], 30);
    // `a` read at line 0 col 7 (parameter); `f` called at line 1 col 10.
    assert_eq!(
        reply["result"]["data"],
        json!([0, 7, 1, 1, 0, 1, 10, 1, 0, 0])
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_lone_carriage_return_is_a_line_break_to_the_client() {
    // LSP ends a line at `\n`, `\r\n` and a lone `\r`; q only at `\n`. The
    // `\r` inside the comment puts every position after it one client line
    // lower than q's count - diagnostics, code actions and tokens alike -
    // while `\r\n` stays one break.
    for (text, line) in [
        ("a:1 / note\rmore\nc:1==1\nf:{[a] a+1}\n", 2),
        ("a:1 / note\r\nc:1==1\r\nf:{[a] a+1}\r\n", 1),
    ] {
        // A server each: a second open document would be republished too.
        let mut server = Server::start();
        server.initialize();
        let uri = format!("file:///tmp/cr{line}.q");
        server.open(&uri, text);
        let diagnostics = server.diagnostics_for(&uri);
        let equality: Vec<Value> = diagnostics
            .iter()
            .filter(|d| d["code"] == "QE004")
            .cloned()
            .collect();
        let range = json!({"start":{"line":line,"character":3},"end":{"line":line,"character":5}});
        assert_eq!(equality.len(), 1, "{diagnostics:?}");
        assert_eq!(equality[0]["range"], range, "{text:?}");
        let actions = server.code_actions(&uri, &equality);
        assert_eq!(actions.len(), 1, "{actions:?}");
        assert_eq!(actions[0]["edit"]["changes"][&uri][0]["range"], range);
        server.send(
            json!({"jsonrpc":"2.0","id":31,"method":"textDocument/semanticTokens/full",
            "params":{"textDocument":{"uri":uri}}}),
        );
        let reply = server.receive();
        // `a` read at col 7 of the lambda's line.
        assert_eq!(reply["result"]["data"], json!([line + 1, 7, 1, 1, 0]));
        assert_eq!(server.shutdown_and_exit(), 0);
    }
}

#[test]
fn semantic_tokens_on_a_half_typed_lambda_keep_the_server_alive() {
    // Two unclosed lambdas once panicked in the scope pass and killed the
    // server; an editor reaches that state just by typing `f:{g:{`.
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/typing.q";
    server.open(uri, "f:{g:{");
    server.diagnostics_for(uri);
    server.send(
        json!({"jsonrpc":"2.0","id":31,"method":"textDocument/semanticTokens/full",
        "params":{"textDocument":{"uri":uri}}}),
    );
    let reply = server.receive();
    assert_eq!(reply["id"], 31);
    assert!(reply["result"]["data"].is_array());
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
fn a_malformed_message_is_answered_and_the_server_carries_on() {
    // Each frame is delimited correctly, so the stream is still in step:
    // JSON-RPC 2.0 answers it with an error whose id is null, and the next
    // message is read as usual.
    let mut server = Server::start();
    server.initialize();
    let invalid_utf8 = b"{\"jsonrpc\":\"2.0\",\"method\":\"x\",\"params\":\"\xff\xfe\"}";
    let mut frame = format!("Content-Length: {}\r\n\r\n", invalid_utf8.len()).into_bytes();
    frame.extend_from_slice(invalid_utf8);
    for (bytes, code) in [
        (b"Content-Length: 5\r\n\r\n{bad}".to_vec(), -32700),
        (b"Content-Length: 2\r\n\r\n[]".to_vec(), -32600),
        (frame, -32700),
        (b"X-Foo\r\nContent-Length: 2\r\n\r\n{}".to_vec(), -32700),
    ] {
        server.raw(&bytes);
        let reply = server.receive();
        assert_eq!(reply["id"], Value::Null, "{reply}");
        assert_eq!(reply["error"]["code"], code, "{reply}");
    }
    let uri = "file:///tmp/after_malformed.q";
    server.open(uri, RESERVED_PARAM);
    assert!(!server.diagnostics_for(uri).is_empty());
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn before_initialize_requests_are_refused_and_notifications_dropped() {
    // LSP 3.17, Initialize Request: -32002 for a request, nothing for a
    // notification. The didOpen must not be linted, so the first message
    // back after initialize is initialize's own reply.
    let mut server = Server::start();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"textDocument/formatting",
        "params":{"textDocument":{"uri":"file:///tmp/a.q"},"options":{"tabSize":2,"insertSpaces":true}}}));
    let reply = server.receive();
    assert_eq!(reply["id"], 3);
    assert_eq!(reply["error"]["code"], -32002);
    server.open("file:///tmp/early.q", RESERVED_PARAM);
    let reply = server.initialize();
    assert_eq!(reply["id"], 1, "{reply}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_second_initialize_is_an_invalid_request_and_changes_nothing() {
    // The first ignores QE; a second that sent no options
    // was answered and left that narrowing under its own defaults (#547).
    let mut server = Server::start();
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "capabilities":client_capabilities(),
        "initializationOptions":{"lint":{"ignore":["QE"]},"format":{"enable":false}}}}),
    );
    server.receive();
    server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"initialize",
        "params":{"capabilities":client_capabilities()}}));
    let reply = server.receive();
    assert_eq!(reply["id"], 2);
    assert_eq!(reply["error"]["code"], -32600, "{reply}");
    // The first initialize's options still hold.
    let uri = "file:///tmp/second.q";
    server.open(uri, "a:1==1\n");
    assert_eq!(server.diagnostics_for(uri), Vec::<Value>::new());
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_request_whose_id_is_an_object_or_array_is_an_invalid_request() {
    // JSON-RPC 2.0 §4; the shutdown it names is not performed (#548).
    let mut server = Server::start();
    server.initialize();
    for id in [json!({"a": 1}), json!([1])] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":"shutdown"}));
        let reply = server.receive();
        assert_eq!(reply["id"], Value::Null, "{reply}");
        assert_eq!(reply["error"]["code"], -32600, "{reply}");
    }
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_second_shutdown_is_an_invalid_request() {
    // LSP 3.17, Shutdown Request: requests after it error with
    // InvalidRequest, and `shutdown` is a request like any other.
    let mut server = Server::start();
    server.initialize();
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"shutdown"}));
    assert_eq!(server.receive()["result"], Value::Null);
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"shutdown"}));
    let reply = server.receive();
    assert_eq!(reply["id"], 3);
    assert_eq!(reply["error"]["code"], -32600, "{reply}");
    server.send(json!({"jsonrpc":"2.0","method":"exit"}));
    assert_eq!(server.child.wait().unwrap().code(), Some(0));
}

#[test]
fn a_response_is_not_answered_and_a_bad_method_is_an_invalid_request() {
    // JSON-RPC 2.0 §5: a response is never replied to. §5.1: a method that is
    // not a string makes an Invalid Request, -32600, not MethodNotFound.
    let mut server = Server::start();
    server.initialize();
    server.send(json!({"jsonrpc":"2.0","id":"x","result":{"applied":true}}));
    server.send(json!({"jsonrpc":"2.0","id":6,"error":{"code":-1,"message":"m"}}));
    server.send(json!({"jsonrpc":"2.0","id":5,"method":42}));
    let reply = server.receive();
    assert_eq!(reply["id"], 5, "the responses were answered: {reply}");
    assert_eq!(reply["error"]["code"], -32600, "{reply}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_document_over_the_size_limit_is_skipped_and_the_server_carries_on() {
    // The cap stops an unbounded allocation; Content-Length still says where
    // the next message starts, so nothing else need be lost.
    let mut server = Server::start();
    server.initialize();
    let big = "a:1\n".repeat(17 << 18);
    server.open("file:///tmp/big.q", &big);
    let reply = server.receive();
    assert_eq!(reply["id"], Value::Null, "{reply}");
    assert_eq!(reply["error"]["code"], -32600, "{reply}");
    let uri = "file:///tmp/after_big.q";
    server.open(uri, RESERVED_PARAM);
    assert!(!server.diagnostics_for(uri).is_empty());
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
fn flags_the_server_would_ignore_are_refused() {
    // The server never runs qls and never reads stdin as a document, so
    // `--backend all` in an editor's server arguments would show no qls
    // diagnostics and say nothing (#544).
    for flag in [
        "--backend=qls",
        "--backend=all",
        "--qls-executable=qls",
        "--qls-timeout=5",
        "--stdin-filename=a.q",
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(["--lsp", flag])
            .stdin(Stdio::null())
            .output()
            .expect("run");
        assert_eq!(output.status.code(), Some(2), "{flag}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("cannot be used with"), "{flag}: {stderr}");
    }
}

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
        ("file:///tmp/a.k", 0),           // k, not q
        ("output:q-console", 0),          // a REPL transcript
        ("untitled:Untitled-1", 0),       // an unsaved scratch
        ("untitled:/tmp/new.q", 0),       // an unsaved scratch with a q name (#545)
        ("fugitive:///r/.git//0/a.q", 0), // an old revision, not a file on disk
        ("file:///tmp/a.txt", 0),         // not q at all
        ("file:///tmp/a.q", 1),           // q
        ("file:///tmp/A.Q", 1),           // q, shouted
        ("file:///tmp/my%20dir/b.q", 1),  // q, with an escaped space
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

/// A Quick Fix for QP006 has to replace the whole application. The
/// diagnostic underlines only the name, so an edit taking its range would
/// leave `f[x] x` behind - which is why the range comes from the fix.
#[test]
fn a_buffer_that_is_not_a_file_defines_nothing_for_the_others() {
    // An old revision open in another scheme is not the workspace (#545).
    let dir = tempfile::tempdir().unwrap();
    let mut server = start_with_workspace(dir.path());
    let old = "fugitive:///r/.git//0/def.q";
    server.open(old, "helper:{x+1}\n");
    server.diagnostics_for(old);
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "f:{y:helper; y}\n");
    let found = codes_of(&server.diagnostics_for(&app));
    assert!(found.contains(&"QF018".to_string()), "{found:?}");
    // app.q's `f` is new to the index, so the other buffer is linted again.
    server.diagnostics_for(old);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn the_bracket_quick_fix_covers_the_whole_application() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/calls.q";
    server.open(uri, "f:{x+1}\nr:f 3+4\n");
    let diagnostics = server.diagnostics_for(uri);
    let juxtaposed: Vec<Value> = diagnostics
        .iter()
        .filter(|d| d["code"] == "QP006")
        .cloned()
        .collect();
    assert_eq!(juxtaposed.len(), 1, "{diagnostics:?}");
    // The underline is the name alone.
    assert_eq!(
        juxtaposed[0]["range"],
        json!({"start":{"line":1,"character":2},"end":{"line":1,"character":3}})
    );
    let actions = server.code_actions(uri, &juxtaposed);
    assert_eq!(actions.len(), 1, "{actions:?}");
    assert_eq!(actions[0]["kind"], "quickfix");
    assert_eq!(actions[0]["title"], "Call `f` with brackets");
    assert_eq!(actions[0]["edit"]["changes"][uri][0]["newText"], "f[3+4]");
    // The edit is `f 3+4`, every character of it.
    assert_eq!(
        actions[0]["edit"]["changes"][uri][0]["range"],
        json!({"start":{"line":1,"character":2},"end":{"line":1,"character":7}})
    );
}

#[test]
fn the_server_reads_the_projects_ignore() {
    // What an editor shows has to match what `qlinter` prints, or the
    // setting is half a fix.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("pyproject.toml"),
        "[tool.q-lint]\nignore = [\"QS001\"]\n",
    )
    .unwrap();
    let mut server = Server::start_in(dir.path(), &[]);
    server.initialize();
    // The configuration governs the files beneath it, as Ruff's does, so the
    // document lives in the project.
    let uri = file_uri(&dir.path().join("ignored.q"));
    server.open(&uri, "my_var:1;f:{[desc] desc}");
    let diagnostics = server.diagnostics_for(&uri);
    let codes: Vec<_> = diagnostics.iter().map(|d| d["code"].clone()).collect();
    assert_eq!(codes, ["QF001"], "{diagnostics:?}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn the_server_takes_the_ignore_flag_too() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start_in(dir.path(), &["--ignore", "QF001"]);
    server.initialize();
    server.open("file:///tmp/flagged.q", "f:{[desc] desc}");
    assert!(server.diagnostics_for("file:///tmp/flagged.q").is_empty());
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_config_the_server_cannot_read_does_not_stop_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("pyproject.toml"),
        "[tool.q-lint]\nignore = [\"QS999\"]\n",
    )
    .unwrap();
    let mut server = Server::start_in(dir.path(), &[]);
    server.initialize();
    server.open("file:///tmp/still.q", "f:{[desc] desc}");
    assert_eq!(server.diagnostics_for("file:///tmp/still.q").len(), 1);
    assert_eq!(server.shutdown_and_exit(), 0);
}

/// A path as the URI an editor sends: `file:///C:/...` on Windows, where the
/// path does not start at a root, and `file:///tmp/...` elsewhere.
fn file_uri(path: &std::path::Path) -> String {
    let path = path.display().to_string().replace('\\', "/");
    if path.starts_with('/') {
        format!("file://{path}")
    } else {
        format!("file:///{path}")
    }
}

/// Initialize with a workspace folder, as an editor that opened `dir` does.
fn start_with_workspace(dir: &std::path::Path) -> Server {
    let mut server = Server::start();
    let uri = file_uri(dir);
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"capabilities":client_capabilities(),"workspaceFolders":[{"uri":uri,"name":"ws"}]}}));
    server.receive();
    server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    server
}

fn codes_of(diagnostics: &[Value]) -> Vec<String> {
    diagnostics
        .iter()
        .map(|d| d["code"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_name_another_workspace_file_defines_is_not_undefined() {
    // lib.q is on disk and never opened; the server reads it at startup.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("lib.q"), "cfg:5\nhelper:{x+1}\n").unwrap();
    let mut server = start_with_workspace(dir.path());
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "n:cfg\nr:helper[2]\n");
    let found = codes_of(&server.diagnostics_for(&app));
    assert!(!found.contains(&"QF018".to_string()), "{found:?}");
    // And the other file's function is coloured as one at its call site.
    server.send(
        json!({"jsonrpc":"2.0","id":40,"method":"textDocument/semanticTokens/full",
        "params":{"textDocument":{"uri":app}}}),
    );
    let reply = server.receive();
    // `helper` on line 1 at column 2, length 6, type 0 (function).
    assert_eq!(reply["result"]["data"], json!([1, 2, 6, 0, 0]));
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_script_loaded_under_a_context_defines_there_and_not_at_the_root() {
    // q 5 runs main.q's `\d .a` / `\l b.q`: b.q's `ff:42` is `.a.ff`, which
    // c.q's `\d .a` lambda reads, and there is no root `ff`, so d.q's
    // `h:{ff}` throws 'ff. The editor answers as `qlinter .` does (#525).
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("main.q"), "\\d .a\n\\l b.q\n\\d .\n").unwrap();
    std::fs::write(dir.path().join("b.q"), "ff:42\n").unwrap();
    let mut server = start_with_workspace(dir.path());
    let c = file_uri(&dir.path().join("c.q"));
    server.open(&c, "\\d .a\ng:{ff}\n\\d .\n");
    let found = codes_of(&server.diagnostics_for(&c));
    assert!(!found.contains(&"QF018".to_string()), "{found:?}");
    let d = file_uri(&dir.path().join("d.q"));
    server.open(&d, "h:{ff}\n");
    let found = codes_of(&server.diagnostics_for(&d));
    assert!(found.contains(&"QF018".to_string()), "{found:?}");
    // Load b.q at the root instead, in the open main.q buffer: `ff` is the
    // root's again, and d.q is linted again without being touched.
    let main = file_uri(&dir.path().join("main.q"));
    server.open(&main, "\\l b.q\n");
    server.diagnostics_for(&main);
    let found = codes_of(&server.diagnostics_for(&d));
    assert!(!found.contains(&"QF018".to_string()), "{found:?}");
    // c.q, linted again too, may arrive after d.q.
    server.send(json!({"jsonrpc":"2.0","id":99,"method":"shutdown"}));
    server.until(|m| m["id"] == 99);
    server.send(json!({"jsonrpc":"2.0","method":"exit"}));
}

#[test]
fn editing_one_files_definitions_relints_the_others() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = start_with_workspace(dir.path());
    let lib = file_uri(&dir.path().join("lib.q"));
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&lib, "cfg:5\n");
    server.diagnostics_for(&lib);
    server.open(&app, "n:cfg\n");
    assert!(!codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    // Rename the definition in the open lib.q buffer: app.q's read of cfg is
    // now undefined, and the server says so without app.q being touched.
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":lib,"version":2},"contentChanges":[{"text":"config:5\n"}]}}));
    server.diagnostics_for(&lib);
    assert!(codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_file_changed_outside_the_editor_is_read_again() {
    let dir = tempfile::tempdir().unwrap();
    let lib_path = dir.path().join("lib.q");
    std::fs::write(&lib_path, "other:1\n").unwrap();
    let mut server = start_with_workspace(dir.path());
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "n:cfg\n");
    assert!(codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    // A pull brings cfg in; the editor's watcher reports the change.
    std::fs::write(&lib_path, "cfg:5\n").unwrap();
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles",
        "params":{"changes":[{"uri":file_uri(&lib_path),"type":2}]}}),
    );
    assert!(!codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn excluding_a_folder_in_the_configuration_drops_it_from_the_index() {
    // The index was read once, under the old `exclude`; a fresh server and
    // the CLI read the new one, and so must this server (#541).
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("vendor")).unwrap();
    std::fs::write(dir.path().join("vendor/def.q"), "helper:{x+1}\n").unwrap();
    let mut server = start_with_workspace(dir.path());
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "f:{y:helper; y}\n");
    assert!(!codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    let config = dir.path().join("qlinter.toml");
    std::fs::write(&config, "extend-exclude = [\"vendor\"]\n").unwrap();
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles",
        "params":{"changes":[{"uri":file_uri(&config),"type":1}]}}),
    );
    let found = codes_of(&server.diagnostics_for(&app));
    assert!(found.contains(&"QF018".to_string()), "{found:?}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[cfg(unix)]
#[test]
fn a_symlinked_q_file_is_indexed_as_the_cli_walk_lints_it() {
    // `qlinter .` follows a symlink to a file; the index skipped it, and
    // reported a name it defines as undefined (#542).
    let dir = tempfile::tempdir().unwrap();
    let shared = tempfile::tempdir().unwrap();
    std::fs::write(shared.path().join("def.q"), "helper:{x+1}\n").unwrap();
    std::os::unix::fs::symlink(shared.path().join("def.q"), dir.path().join("def.q")).unwrap();
    let mut server = start_with_workspace(dir.path());
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "f:{y:helper; y}\n");
    let found = codes_of(&server.diagnostics_for(&app));
    assert!(!found.contains(&"QF018".to_string()), "{found:?}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn deleting_a_folder_forgets_every_definition_under_it() {
    // A watcher reports a deleted folder as one event for the folder (#543).
    let dir = tempfile::tempdir().unwrap();
    let sub = dir.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    std::fs::write(sub.join("def.q"), "helper:{x+1}\n").unwrap();
    let mut server = start_with_workspace(dir.path());
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "f:{y:helper; y}\n");
    assert!(!codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    std::fs::remove_dir_all(&sub).unwrap();
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles",
        "params":{"changes":[{"uri":file_uri(&sub),"type":3}]}}),
    );
    let found = codes_of(&server.diagnostics_for(&app));
    assert!(found.contains(&"QF018".to_string()), "{found:?}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_document_takes_the_profile_of_the_qlinter_toml_above_it() {
    // An editor starts the server with no --profile when the user has not set
    // one, so the repository's configuration decides; and the server finds
    // it from the document, not from the directory it was started in.
    let repo = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::write(repo.path().join("qlinter.toml"), "profile = \"styleq\"\n").unwrap();
    std::fs::create_dir_all(repo.path().join("src")).unwrap();
    let uri = file_uri(&repo.path().join("src/a.q"));
    let mut server = Server::spawn(elsewhere.path(), &["--lsp"]);
    server.initialize();
    server.open(&uri, "my_var:1;f:{[desc] desc}");
    assert_eq!(codes_of(&server.diagnostics_for(&uri)), ["QF001", "QS001"]);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn without_a_configuration_or_a_flag_the_server_uses_style() {
    let dir = tempfile::tempdir().unwrap();
    let uri = file_uri(&dir.path().join("a.q"));
    let mut server = Server::spawn(dir.path(), &["--lsp"]);
    server.initialize();
    server.open(&uri, "my_var:1;f:{[desc] desc}");
    assert_eq!(codes_of(&server.diagnostics_for(&uri)), ["QF001"]);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn editing_the_configuration_relints_the_open_documents() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("qlinter.toml");
    std::fs::write(&config, "profile = \"style\"\n").unwrap();
    let uri = file_uri(&dir.path().join("a.q"));
    let mut server = Server::spawn(dir.path(), &["--lsp"]);
    server.initialize();
    server.open(&uri, "my_var:1;f:{[desc] desc}");
    assert_eq!(codes_of(&server.diagnostics_for(&uri)), ["QF001"]);
    std::fs::write(&config, "profile = \"style\"\n[lint]\nignore = [\"QF\"]\n").unwrap();
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles",
        "params":{"changes":[{"uri":file_uri(&config),"type":2}]}}),
    );
    assert_eq!(
        codes_of(&server.diagnostics_for(&uri)),
        Vec::<String>::new()
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn editing_a_base_the_configuration_extends_relints_the_open_documents() {
    // A base reached through `extend` can be called anything; the CLI reads
    // it fresh each run, and the editor must re-read it too (#419).
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("base.toml");
    std::fs::write(&base, "profile = \"style\"\n").unwrap();
    std::fs::write(dir.path().join(".qlinter.toml"), "extend = \"base.toml\"\n").unwrap();
    let uri = file_uri(&dir.path().join("a.q"));
    let mut server = Server::spawn(dir.path(), &["--lsp"]);
    server.initialize();
    server.open(&uri, "my_var:1;f:{[desc] desc}");
    assert_eq!(codes_of(&server.diagnostics_for(&uri)), ["QF001"]);
    std::fs::write(&base, "profile = \"style\"\n[lint]\nignore = [\"QF\"]\n").unwrap();
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles",
        "params":{"changes":[{"uri":file_uri(&base),"type":2}]}}),
    );
    assert_eq!(
        codes_of(&server.diagnostics_for(&uri)),
        Vec::<String>::new()
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn the_server_asks_to_watch_the_configuration_outside_the_workspace() {
    // A base the folder's configuration extends from above it, and the
    // user-level file, are outside every workspace pattern; the server asks
    // for them itself, so their edits reach it in any editor (#554).
    let top = tempfile::tempdir().unwrap();
    // The real path, which is what the server reports: /private/var for
    // /var on macOS, and the long name for `RUNNER~1` on Windows - less
    // Windows' verbatim `\\?\`, which no editor's URI carries.
    let top_path = top.path().canonicalize().unwrap();
    let top_path = std::path::PathBuf::from(
        top_path
            .to_string_lossy()
            .strip_prefix(r"\\?\")
            .map_or_else(|| top_path.to_string_lossy().into_owned(), str::to_string),
    );
    let ws = top_path.join("ws");
    std::fs::create_dir(&ws).unwrap();
    std::fs::write(top_path.join("base.toml"), "profile = \"style\"\n").unwrap();
    std::fs::write(ws.join(".qlinter.toml"), "extend = \"../base.toml\"\n").unwrap();
    // Started above the folder, so the user-level file the tests point at
    // is outside it too.
    let mut server = Server::spawn(&top_path, &["--lsp"]);
    let mut capabilities = client_capabilities();
    capabilities["workspace"] = json!({"didChangeWatchedFiles":
        {"dynamicRegistration": true, "relativePatternSupport": true}});
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "capabilities":capabilities,"workspaceFolders":[{"uri":file_uri(&ws),"name":"ws"}]}}),
    );
    server.receive();
    server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    let uri = file_uri(&ws.join("a.q"));
    server.open(&uri, "a:1\n");
    // The base is read for the document, after a first registration made
    // without it; the diagnostics come between the two.
    server.diagnostics_for(&uri);
    let wants = |m: &Value, base: &std::path::Path, pattern: &str| {
        m["method"] == "client/registerCapability"
            && m["params"]["registrations"][0]["registerOptions"]["watchers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w["globPattern"] == json!({"baseUri": file_uri(base), "pattern": pattern}))
    };
    let registration = server.until(|m| wants(m, &top_path, "base.toml"));
    let user = top_path.join("no-such-config-home/qlinter");
    assert!(
        wants(&registration, &user, "qlinter.toml"),
        "{registration}"
    );
    let watchers = &registration["params"]["registrations"][0]["registerOptions"]["watchers"];
    assert_eq!(watchers[0], json!({"globPattern": "**/*.q"}));
    // And the registration it replaces is withdrawn.
    let withdrawn = server.until(|m| m["method"] == "client/unregisterCapability");
    assert_eq!(
        withdrawn["params"]["unregisterations"][0]["method"],
        "workspace/didChangeWatchedFiles"
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_localhost_file_uri_finds_the_project_configuration() {
    // RFC 8089: file://localhost/p is file:///p. The authority was read as
    // the first directory, so no configuration was found (#425).
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".qlinter.toml"),
        "[lint]\nignore = [\"QE004\"]\n",
    )
    .unwrap();
    let plain = file_uri(&dir.path().join("a.q"));
    let local = plain.replacen("file://", "file://localhost", 1);
    assert!(local.starts_with("file://localhost/"), "{local}");
    // RFC 8089's form with no authority, and a scheme in capitals (#546).
    let bare = plain.replacen("file://", "file:", 1);
    let shouted = plain.replacen("file:", "FILE:", 1);
    let mut server = Server::spawn(dir.path(), &["--lsp"]);
    server.initialize();
    for uri in [&plain, &local, &bare, &shouted] {
        server.open(uri, "a:1==2\n");
        assert_eq!(
            codes_of(&server.diagnostics_for(uri)),
            Vec::<String>::new(),
            "{uri}"
        );
    }
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn every_rule_with_a_fix_offers_it_in_the_editor() {
    // Not only the three the server first knew: a fix `--fix` applies, and
    // one only a person should accept, are both offered here.
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/more-fixes.q";
    server.open(
        uri,
        "r:select from t where s like `a*\nr2:reverse asc 3 1 2\n",
    );
    let diagnostics = server.diagnostics_for(uri);
    let mut titles = vec![];
    for d in diagnostics
        .iter()
        .filter(|d| d["code"] == "QB007" || d["code"] == "QR001")
    {
        for action in server.code_actions(uri, std::slice::from_ref(d)) {
            titles.push(action["title"].as_str().unwrap().to_string());
        }
    }
    titles.sort();
    assert_eq!(
        titles,
        [
            "Replace `reverse asc` with `desc`",
            "Write the pattern as the string \"a*\""
        ],
        "{diagnostics:?}"
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

impl Server {
    fn format(&mut self, uri: &str) -> Value {
        self.send(
            json!({"jsonrpc":"2.0","id":30,"method":"textDocument/formatting",
            "params":{"textDocument":{"uri":uri},
                      "options":{"tabSize":4,"insertSpaces":true}}}),
        );
        // Opening a document that defines names relints the others, so their
        // diagnostics can still be on the wire ahead of the reply.
        let mut reply = self.receive();
        while reply["method"] == "textDocument/publishDiagnostics" {
            reply = self.receive();
        }
        assert_eq!(reply["id"], 30);
        assert!(reply.get("error").is_none(), "{reply}");
        reply
    }

    fn change(&mut self, uri: &str, version: i64, text: &str) {
        self.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
            "params":{"textDocument":{"uri":uri,"version":version},
                      "contentChanges":[{"text":text}]}}));
    }
}

/// `text` with LSP `edits` applied: positions are lines split at `\n` and
/// characters counted in UTF-16 code units, as the protocol counts them.
fn apply_edits(text: &str, edits: &[Value]) -> String {
    let offset = |position: &Value| {
        let line = position["line"].as_u64().unwrap() as usize;
        let character = position["character"].as_u64().unwrap() as usize;
        let start: usize = text.split_inclusive('\n').take(line).map(str::len).sum();
        let mut units = 0;
        for (i, c) in text[start..].char_indices() {
            if units == character {
                return start + i;
            }
            units += c.len_utf16();
        }
        text.len()
    };
    let mut spans: Vec<(usize, usize, &str)> = edits
        .iter()
        .map(|e| {
            (
                offset(&e["range"]["start"]),
                offset(&e["range"]["end"]),
                e["newText"].as_str().unwrap(),
            )
        })
        .collect();
    spans.sort();
    let mut out = text.to_string();
    for (start, end, new) in spans.into_iter().rev() {
        out.replace_range(start..end, new);
    }
    out
}

/// "Format document" applies what `qlinter --fix` would: here `==` and `!=`,
/// on a line whose emoji is two UTF-16 code units, so a range counted in
/// bytes or characters would land on the wrong text. Formatting the result
/// again finds nothing more to do.
#[test]
fn formatting_applies_the_safe_fixes_and_is_idempotent() {
    let mut server = Server::start();
    let reply = server.initialize();
    assert_eq!(
        reply["result"]["capabilities"]["documentFormattingProvider"],
        true
    );
    let uri = "file:///tmp/format.q";
    let before = "/ \u{1F600}\na:1==1; b:1!=2\nc:3\n";
    server.open(uri, before);
    server.diagnostics_for(uri);
    let edits = server.format(uri)["result"].as_array().cloned().unwrap();
    assert_eq!(edits.len(), 1, "{edits:?}");
    // One edit, from the first byte that changed to the last.
    assert_eq!(
        edits[0]["range"],
        json!({"start":{"line":1,"character":4},"end":{"line":1,"character":13}})
    );
    let after = apply_edits(before, &edits);
    assert_eq!(after, "/ \u{1F600}\na:1=1; b:1<>2\nc:3\n");

    server.change(uri, 2, &after);
    server.diagnostics_for(uri);
    assert_eq!(server.format(uri)["result"], json!([]));
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn formatting_leaves_an_unbalanced_document_alone_with_qe001_deselected() {
    // Deselecting QE001 hides the finding; it does not make the brackets
    // close, and the fixes would read line 2 as inside `f` (#422).
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start_in(dir.path(), &["--ignore", "QE001"]);
    server.initialize();
    let uri = "file:///tmp/unbalanced-format.q";
    server.open(uri, "f:{x==1\ng:{y!=2}\n");
    server.diagnostics_for(uri);
    assert_eq!(server.format(uri)["result"], json!([]));
    assert_eq!(server.shutdown_and_exit(), 0);
}

/// `&&` has a fix, but one only a person should accept: formatting leaves it,
/// even from a server started with `--unsafe-fixes`.
#[test]
fn formatting_never_applies_an_unsafe_fix() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start_in(dir.path(), &[]);
    server.initialize();
    let uri = "file:///tmp/unsafe-format.q";
    server.open(uri, "a:1b; b:0b; r:a&&b; s:a||b\n");
    let diagnostics = server.diagnostics_for(uri);
    assert_eq!(
        codes_of(&diagnostics),
        ["QE004", "QE004"],
        "{diagnostics:?}"
    );
    // The fixes exist - they are offered as Quick Fixes - but not here.
    assert_eq!(server.code_actions(uri, &diagnostics).len(), 2);
    assert_eq!(server.format(uri)["result"], json!([]));
    assert_eq!(server.shutdown_and_exit(), 0);
}

/// A buffer whose structure is broken reports only that, so there is nothing
/// to format: the answer is an empty list, not an error. The same for a
/// document the server was never given, and one that is not q.
#[test]
fn formatting_a_broken_or_unknown_buffer_returns_no_edits() {
    let mut server = Server::start();
    server.initialize();
    for (uri, text) in [
        ("file:///tmp/unclosed.q", "f:{[x] x==1\n"),
        ("file:///tmp/string.q", "a:1==1; s:\"abc\n"),
        ("file:///tmp/stray.q", "a:1==1]\n"),
        ("file:///tmp/not-q.k", "a:1==1\n"),
    ] {
        server.open(uri, text);
        server.diagnostics_for(uri);
        assert_eq!(server.format(uri)["result"], json!([]), "{uri}");
    }
    assert_eq!(
        server.format("file:///tmp/never-opened.q")["result"],
        json!([])
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

/// The server started in `dir` with `args`, initialized with `options` as a
/// client's `initializationOptions` and, when given, one workspace folder.
/// The initialize reply comes back with it.
fn start_with_options(
    dir: &std::path::Path,
    args: &[&str],
    options: Value,
    workspace: Option<&std::path::Path>,
) -> (Server, Value) {
    let mut server = Server::spawn(dir, args);
    let mut params =
        json!({"capabilities":client_capabilities(), "initializationOptions": options});
    if let Some(ws) = workspace {
        params["workspaceFolders"] = json!([{"uri": file_uri(ws), "name": "ws"}]);
    }
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":params}));
    let reply = server.receive();
    server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    (server, reply)
}

/// A source with a style finding (QF001, `desc` as a parameter) and one only
/// `styleq` and `uqf` report (QS001, an underscore in a name).
const TWO_FAMILIES: &str = "my_var:1;f:{[desc] desc}";

#[test]
fn an_editor_select_narrows_what_the_configuration_reports() {
    let dir = tempfile::tempdir().unwrap();
    let uri = file_uri(&dir.path().join("a.q"));
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp", "--profile", "uqf"],
        json!({"lint": {"select": ["QF"]}}),
        None,
    );
    server.open(&uri, TWO_FAMILIES);
    assert_eq!(codes_of(&server.diagnostics_for(&uri)), ["QF001"]);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn an_editor_select_cannot_widen_the_configuration() {
    // `style` does not report QS001, and selecting it in the editor does not
    // turn it on: the repository's configuration is the ceiling.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("qlinter.toml"), "profile = \"style\"\n").unwrap();
    let uri = file_uri(&dir.path().join("a.q"));
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp"],
        json!({"lint": {"select": ["QS001", "QF001"]}}),
        None,
    );
    server.open(&uri, TWO_FAMILIES);
    assert_eq!(codes_of(&server.diagnostics_for(&uri)), ["QF001"]);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn an_editor_ignore_drops_a_rule_the_configuration_selects() {
    let dir = tempfile::tempdir().unwrap();
    let uri = file_uri(&dir.path().join("a.q"));
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp", "--profile", "uqf"],
        json!({"lint": {"ignore": ["QF001"]}}),
        None,
    );
    server.open(&uri, TWO_FAMILIES);
    let found = codes_of(&server.diagnostics_for(&uri));
    assert!(!found.contains(&"QF001".to_string()), "{found:?}");
    assert!(found.contains(&"QS001".to_string()), "{found:?}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn an_editor_ignore_of_qe001_shows_nothing_the_cli_would_not() {
    // The CLI reports only QE001 for an unbalanced file. Hiding that in the
    // editor must not expose the findings the bracket gate held back (#414).
    let dir = tempfile::tempdir().unwrap();
    let uri = file_uri(&dir.path().join("a.q"));
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp", "--profile", "style"],
        json!({"lint": {"ignore": ["QE001"]}}),
        None,
    );
    server.open(&uri, "a:1==2\nb:(1\n");
    assert_eq!(
        codes_of(&server.diagnostics_for(&uri)),
        Vec::<String>::new()
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn an_unreadable_setting_is_reported_and_the_rest_still_apply() {
    let dir = tempfile::tempdir().unwrap();
    let uri = file_uri(&dir.path().join("a.q"));
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp", "--profile", "uqf"],
        json!({"lint": {"ignore": ["QZ999", "QS"]}, "format": {"enable": "no"}}),
        None,
    );
    let mut warnings = vec![];
    for _ in 0..2 {
        let message = server.receive();
        assert_eq!(message["method"], "window/showMessage", "{message}");
        assert_eq!(message["params"]["type"], 2);
        warnings.push(message["params"]["message"].as_str().unwrap().to_string());
    }
    assert!(warnings.iter().any(|w| w.contains("QZ999")), "{warnings:?}");
    assert!(
        warnings.iter().any(|w| w.contains("/format/enable")),
        "{warnings:?}"
    );
    server.open(&uri, TWO_FAMILIES);
    assert_eq!(codes_of(&server.diagnostics_for(&uri)), ["QF001"]);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn unsafe_quick_fixes_are_offered_only_while_enabled() {
    // `&&` has an editor-only fix, `==` a batch-safe one.
    let text = "a:1b; b:0b; r:a&&b; c:1==1\n";
    let dir = tempfile::tempdir().unwrap();
    for (enabled, expected) in [
        (None, vec!["QE004", "QE004"]),
        (Some(true), vec!["QE004", "QE004"]),
        (Some(false), vec!["QE004"]),
    ] {
        let options = enabled.map_or(json!(null), |e| json!({"fixes": {"unsafe": e}}));
        let (mut server, _) =
            start_with_options(dir.path(), &["--lsp", "--profile", "uqf"], options, None);
        let uri = "file:///tmp/unsafe-setting.q";
        server.open(uri, text);
        let diagnostics = server.diagnostics_for(uri);
        let mut fixed = vec![];
        for d in &diagnostics {
            if !server.code_actions(uri, std::slice::from_ref(d)).is_empty() {
                fixed.push(d["code"].as_str().unwrap().to_string());
            }
        }
        // Two QE004 findings, `&&` and `==`; with unsafe fixes off only `==`
        // keeps its fix.
        assert_eq!(fixed, expected, "unsafe = {enabled:?}: {diagnostics:?}");
        assert_eq!(server.shutdown_and_exit(), 0);
    }
}

#[test]
fn formatting_and_semantic_tokens_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, reply) = start_with_options(
        dir.path(),
        &["--lsp"],
        json!({"format": {"enable": false}, "semanticTokens": {"enable": false}}),
        None,
    );
    let capabilities = &reply["result"]["capabilities"];
    assert!(
        capabilities.get("documentFormattingProvider").is_none(),
        "{capabilities}"
    );
    assert!(
        capabilities.get("semanticTokensProvider").is_none(),
        "{capabilities}"
    );
    assert_eq!(capabilities["codeActionProvider"], code_action_provider());
    // A client that asks anyway gets nothing to apply.
    let uri = "file:///tmp/no-format.q";
    server.open(uri, "a:1==1\n");
    server.diagnostics_for(uri);
    assert_eq!(server.format(uri)["result"], json!([]));
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn with_run_on_save_a_change_is_linted_only_when_saved() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp"],
        json!({"lint": {"run": "onSave"}}),
        None,
    );
    let uri = "file:///tmp/on-save.q";
    server.open(uri, "a:1\n");
    assert!(server.diagnostics_for(uri).is_empty());
    server.change(uri, 2, RESERVED_PARAM);
    // Nothing is published for the change: the next message is the reply to
    // this request.
    server.send(
        json!({"jsonrpc":"2.0","id":41,"method":"textDocument/semanticTokens/full",
        "params":{"textDocument":{"uri":uri}}}),
    );
    assert_eq!(server.receive()["id"], 41);
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didSave",
        "params":{"textDocument":{"uri":uri}}}));
    assert_eq!(codes_of(&server.diagnostics_for(uri)), ["QF001"]);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn with_run_on_save_another_files_save_does_not_lint_an_unsaved_buffer() {
    // Saving b.q changes what the workspace defines, so the other open
    // documents are linted again - but not a.q's unsaved text (#550).
    let dir = tempfile::tempdir().unwrap();
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp"],
        json!({"lint": {"run": "onSave"}}),
        None,
    );
    let a = "file:///tmp/on-save-a.q";
    let b = "file:///tmp/on-save-b.q";
    server.open(a, "a:1\n");
    assert!(server.diagnostics_for(a).is_empty());
    server.change(a, 2, RESERVED_PARAM);
    server.open(b, "x:1\n");
    assert!(server.diagnostics_for(b).is_empty());
    server.change(b, 2, "y:1\n");
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didSave",
        "params":{"textDocument":{"uri":b}}}));
    assert!(server.diagnostics_for(b).is_empty());
    // Nothing for a.q: the next message is the reply to this request.
    server.send(
        json!({"jsonrpc":"2.0","id":41,"method":"textDocument/semanticTokens/full",
        "params":{"textDocument":{"uri":a}}}),
    );
    let next = server.receive();
    assert_eq!(next["id"], 41, "{next}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_severity_setting_overrides_by_the_longest_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp", "--profile", "uqf"],
        json!({"lint": {"severity": {"QF": "hint", "QS001": "error"}}}),
        None,
    );
    let uri = "file:///tmp/severity.q";
    server.open(uri, TWO_FAMILIES);
    let diagnostics = server.diagnostics_for(uri);
    let by_code = |code: &str| {
        diagnostics
            .iter()
            .find(|d| d["code"] == code)
            .unwrap_or_else(|| panic!("{code} in {diagnostics:?}"))["severity"]
            .clone()
    };
    assert_eq!(by_code("QF001"), 4);
    assert_eq!(by_code("QS001"), 1);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn the_workspace_index_can_be_turned_off_or_narrowed() {
    // vendor/lib.q defines cfg. Indexed, app.q's read of it is defined; with
    // the index off, or vendor/ excluded from it, it is not.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("vendor")).unwrap();
    std::fs::write(dir.path().join("vendor/lib.q"), "cfg:5\n").unwrap();
    let app = file_uri(&dir.path().join("app.q"));
    for (options, undefined) in [
        (json!({}), false),
        (json!({"workspaceIndex": {"exclude": ["other/**"]}}), false),
        (json!({"workspaceIndex": {"enable": false}}), true),
        (json!({"workspaceIndex": {"exclude": ["vendor/**"]}}), true),
        (json!({"workspaceIndex": {"exclude": ["vendor"]}}), true),
    ] {
        let (mut server, _) = start_with_options(
            dir.path(),
            &["--lsp", "--profile", "uqf"],
            options.clone(),
            Some(dir.path()),
        );
        server.open(&app, "n:cfg\n");
        let found = codes_of(&server.diagnostics_for(&app));
        assert_eq!(
            found.contains(&"QF018".to_string()),
            undefined,
            "{options}: {found:?}"
        );
        assert_eq!(server.shutdown_and_exit(), 0);
    }
}

#[test]
fn the_workspace_index_reads_the_directories_the_cli_walk_reads() {
    // `qlinter .` skips build/ and what `exclude` names, and walks a
    // dot-directory; the index used a list of its own (#420).
    let dir = tempfile::tempdir().unwrap();
    for (file, text) in [
        ("build/defs.q", "inbuild:5\n"),
        ("gen/defs.q", "ingen:5\n"),
        (".hidden/defs.q", "inhidden:5\n"),
        ("venv/defs.q", "invenv:5\n"),
    ] {
        let path = dir.path().join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    std::fs::write(
        dir.path().join("qlinter.toml"),
        "profile = \"uqf\"\nextend-exclude = [\"gen\"]\n",
    )
    .unwrap();
    let app = file_uri(&dir.path().join("app.q"));
    let (mut server, _) = start_with_options(dir.path(), &["--lsp"], json!({}), Some(dir.path()));
    let undefined = |server: &mut Server, name: &str| {
        server.open(&app, &format!("n:{name}\n"));
        codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string())
    };
    assert!(undefined(&mut server, "inbuild"));
    assert!(undefined(&mut server, "ingen"));
    assert!(!undefined(&mut server, "inhidden"));
    assert!(!undefined(&mut server, "invenv"));
    // A file changed on disk is held to the same: build/ stays out.
    let late = dir.path().join("build/late.q");
    std::fs::write(&late, "late:5\n").unwrap();
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles",
        "params":{"changes":[{"uri":file_uri(&late),"type":1}]}}),
    );
    assert!(undefined(&mut server, "late"));
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn neither_a_watched_change_nor_a_close_indexes_what_the_settings_leave_out() {
    // With the index off or vendor/ excluded, a change on disk to vendor/lib.q
    // must not put its `cfg` in the index, nor may closing a file keep what
    // it defined: app.q's read of cfg stays undefined either way.
    let has_qf018 = |server: &mut Server, app: &str| {
        server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
            "params":{"textDocument":{"uri":app,"version":2},"contentChanges":[{"text":"n:cfg\n"}]}}));
        codes_of(&server.diagnostics_for(app)).contains(&"QF018".to_string())
    };
    for options in [
        json!({"workspaceIndex": {"enable": false}}),
        json!({"workspaceIndex": {"exclude": ["vendor/**"]}}),
        // A pattern naming the directory itself, which the scan never
        // enters; a watched change read its file back in (#795).
        json!({"workspaceIndex": {"exclude": ["vendor"]}}),
    ] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("vendor")).unwrap();
        let lib = dir.path().join("vendor/lib.q");
        let app = file_uri(&dir.path().join("app.q"));
        let (mut server, _) = start_with_options(
            dir.path(),
            &["--lsp", "--profile", "uqf"],
            options.clone(),
            Some(dir.path()),
        );
        server.open(&app, "n:cfg\n");
        assert!(codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
        std::fs::write(&lib, "cfg:5\n").unwrap();
        server.send(
            json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles",
            "params":{"changes":[{"uri":file_uri(&lib),"type":1}]}}),
        );
        assert!(
            has_qf018(&mut server, &app),
            "{options}: after the watched change"
        );
        server.open(&file_uri(&lib), "cfg:5\n");
        server.diagnostics_for(&file_uri(&lib));
        // Open, lib.q's buffer does define cfg, and app.q is linted again.
        assert!(!codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
        server.send(json!({"jsonrpc":"2.0","method":"textDocument/didClose",
            "params":{"textDocument":{"uri":file_uri(&lib)}}}));
        server.diagnostics_for(&app);
        server.diagnostics_for(&file_uri(&lib));
        assert!(has_qf018(&mut server, &app), "{options}: after the close");
        assert_eq!(server.shutdown_and_exit(), 0);
    }
}

#[test]
fn editing_the_file_named_by_config_relints_the_open_documents() {
    // `--config` can name a file anything; a change to it has to be heard as
    // a configuration change all the same, not read as a stray file.
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("lint.toml");
    std::fs::write(&config, "select = [\"QE004\", \"QR001\"]\n").unwrap();
    let (mut server, _) = start_with_options(
        dir.path(),
        &["--lsp", "--config", config.to_str().unwrap()],
        json!({}),
        Some(dir.path()),
    );
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "a==b\nr:reverse asc 1 2\n");
    let mut found = codes_of(&server.diagnostics_for(&app));
    found.sort();
    assert_eq!(found, ["QE004", "QR001"]);
    std::fs::write(&config, "select = [\"QE004\"]\n").unwrap();
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles",
        "params":{"changes":[{"uri":file_uri(&config),"type":2}]}}),
    );
    assert_eq!(codes_of(&server.diagnostics_for(&app)), ["QE004"]);
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_rule_that_panics_costs_one_answer_not_the_server() {
    // Two inputs that panicked in rules (a char boundary inside `é`), one
    // through the diagnostics and one through formatting. Whether or not
    // those rules are fixed by now, the server must answer the request,
    // keep serving other documents, and exit cleanly.
    let mut server = Server::start();
    server.initialize();
    let lint_panic = "file:///tmp/panic_lint.q";
    server.open(lint_panic, "r:select from t where \u{e9}if\n");
    server.diagnostics_for(lint_panic);
    let format_panic = "file:///tmp/panic_format.q";
    server.open(format_panic, "\u{e9}==like b/+=`a  \n");
    server.diagnostics_for(format_panic);
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"textDocument/formatting",
        "params":{"textDocument":{"uri":format_panic},"options":{"tabSize":2,"insertSpaces":true}}}));
    // Opening the second file re-lints the first, so its diagnostics may
    // come before the reply.
    let reply = server.until(|m| m["id"] == 2);
    assert!(
        reply.get("result").is_some() || reply["error"]["code"] == -32603,
        "{reply}"
    );
    let ok = "file:///tmp/after_panic.q";
    server.open(ok, "a==b\n");
    assert!(!server.diagnostics_for(ok).is_empty());
    // The other documents are linted again after it, in no fixed order.
    server.send(json!({"jsonrpc":"2.0","id":99,"method":"shutdown"}));
    server.until(|m| m["id"] == 99);
    server.send(json!({"jsonrpc":"2.0","method":"exit"}));
    assert_eq!(server.child.wait().unwrap().code(), Some(0));
}

#[test]
fn another_files_new_function_asks_the_client_to_refresh_its_colours() {
    // app.q calls helper before any file defines it, so it is not coloured
    // as a function. lib.q's arrival changes that; the client re-asks for
    // tokens only when told to, with workspace/semanticTokens/refresh.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start_in(dir.path(), &[]);
    let mut capabilities = client_capabilities();
    capabilities["workspace"] = json!({"semanticTokens": {"refreshSupport": true}});
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "capabilities": capabilities,
        "workspaceFolders":[{"uri":file_uri(dir.path()),"name":"ws"}]}}),
    );
    server.receive();
    server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    let tokens = |server: &mut Server, uri: &str| {
        server.send(
            json!({"jsonrpc":"2.0","id":30,"method":"textDocument/semanticTokens/full",
            "params":{"textDocument":{"uri":uri}}}),
        );
        server.until(|m| m["id"] == 30)["result"]["data"].clone()
    };
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "r:helper[2]\n");
    server.until(|m| m["method"] == "workspace/semanticTokens/refresh");
    assert_eq!(tokens(&mut server, &app), json!([]));
    let lib = file_uri(&dir.path().join("lib.q"));
    server.open(&lib, "helper:{x+1}\n");
    let refresh = server.until(|m| m["method"] == "workspace/semanticTokens/refresh");
    // Answered as a client would; the server must not answer the answer.
    server.send(json!({"jsonrpc":"2.0","id":refresh["id"],"result":null}));
    assert_eq!(tokens(&mut server, &app), json!([0, 2, 6, 0, 0]));
    server.send(json!({"jsonrpc":"2.0","id":99,"method":"shutdown"}));
    server.until(|m| m["id"] == 99);
    server.send(json!({"jsonrpc":"2.0","method":"exit"}));
    assert_eq!(server.child.wait().unwrap().code(), Some(0));
}

#[cfg(unix)]
#[test]
fn a_document_opened_by_another_spelling_of_its_path_is_one_file() {
    // The folder is opened through a symlink and the document by its real
    // path. Keyed by both spellings, the file's own `a` was "defined
    // elsewhere" and q 5's 'type went unreported (#528).
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    std::fs::create_dir(&real).unwrap();
    std::fs::write(real.join("real.q"), "a:1\nf:{a 0}\n").unwrap();
    std::os::unix::fs::symlink(&real, dir.path().join("link")).unwrap();
    let mut server = start_with_workspace(&dir.path().join("link"));
    let uri = file_uri(&real.canonicalize().unwrap().join("real.q"));
    server.open(&uri, "a:1\nf:{a 0}\n");
    let found = codes_of(&server.diagnostics_for(&uri));
    assert!(found.contains(&"QT022".to_string()), "{found:?}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_client_that_waits_for_registration_is_asked_to_watch_files() {
    // Neovim and Helix send didChangeWatchedFiles only for watchers a server
    // registers; with none registered, an edited qlinter.toml was never
    // heard until a restart (#792).
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start_in(dir.path(), &[]);
    let mut capabilities = client_capabilities();
    capabilities["workspace"] = json!({"didChangeWatchedFiles": {"dynamicRegistration": true}});
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "capabilities": capabilities,
        "workspaceFolders":[{"uri":file_uri(dir.path()),"name":"ws"}]}}),
    );
    server.receive();
    server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    let request = server.until(|m| m["method"] == "client/registerCapability");
    let registration = &request["params"]["registrations"][0];
    assert_eq!(registration["method"], "workspace/didChangeWatchedFiles");
    let globs: Vec<&str> = registration["registerOptions"]["watchers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["globPattern"].as_str().unwrap())
        .collect();
    assert!(globs.contains(&"**/*.q"), "{globs:?}");
    // Every configuration by any name, `extend`ed bases included (#554).
    assert!(globs.contains(&"**/*.toml"), "{globs:?}");
    server.send(json!({"jsonrpc":"2.0","id":request["id"],"result":null}));
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn the_workspace_index_reads_a_file_however_large() {
    // The CLI indexes a 5 MB file like any other; the server skipped one over
    // 4 MiB, so a name only it defines was undefined in the editor alone (#794).
    let dir = tempfile::tempdir().unwrap();
    let mut big = String::from("helper:{[a] a+1}\n");
    big.push_str(&"/ padding padding padding padding padding padding\n".repeat(100_000));
    assert!(big.len() > 4 << 20);
    std::fs::write(dir.path().join("big.q"), big).unwrap();
    let mut server = start_with_workspace(dir.path());
    let app = file_uri(&dir.path().join("app.q"));
    server.open(&app, "f:{[a] r:helper; r}\n");
    let found = codes_of(&server.diagnostics_for(&app));
    assert!(!found.contains(&"QF018".to_string()), "{found:?}");
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_workspace_folder_added_later_is_indexed_and_a_removed_one_forgotten() {
    // B is added to the workspace after start, as a multi-root workspace
    // does; what it defines must count, as it does for `qlinter A B` (#797).
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("A"), dir.path().join("B"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(b.join("lib.q"), "helper:{[a] a+1}\n").unwrap();
    let (mut server, reply) = start_with_options(
        dir.path(),
        &["--lsp", "--profile", "uqf"],
        json!({}),
        Some(&a),
    );
    assert_eq!(
        reply["result"]["capabilities"]["workspace"]["workspaceFolders"]["changeNotifications"],
        true
    );
    let app = file_uri(&a.join("b.q"));
    server.open(&app, "f:{[a] r:helper; r}\n");
    assert!(codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    let folder = json!([{"uri": file_uri(&b), "name": "B"}]);
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWorkspaceFolders",
        "params":{"event":{"added":folder,"removed":[]}}}),
    );
    assert!(!codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    server.send(
        json!({"jsonrpc":"2.0","method":"workspace/didChangeWorkspaceFolders",
        "params":{"event":{"added":[],"removed":folder}}}),
    );
    assert!(codes_of(&server.diagnostics_for(&app)).contains(&"QF018".to_string()));
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_flag_the_server_never_reads_is_refused() {
    // Each was accepted and silently ignored: `--stdin-filename` with stdin
    // the protocol stream, `--force-exclude` and `--unsafe-fixes` with no
    // effect on what the editor shows (#798).
    for flag in [
        &["--stdin-filename", "x.q"][..],
        &["--format", "json"],
        &["--color", "always"],
        &["--force-exclude"],
        &["--unsafe-fixes"],
        &["--qls-executable", "foo"],
        &["--qls-timeout", "5"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .arg("--lsp")
            .args(flag)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{flag:?}: {stderr}");
        assert!(stderr.contains("--lsp"), "{flag:?}: {stderr}");
    }
}

#[test]
fn a_document_method_without_a_uri_is_refused_or_dropped() {
    // Read as `uri: ""`, a didOpen published diagnostics for an invalid
    // DocumentUri and a request was answered as a success (#799).
    let mut server = Server::start();
    server.initialize();
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
        "params":{"textDocument":{"languageId":"q","version":1,"text":"a==b\n"}}}));
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":[1]}));
    for (id, method, params) in [
        (2, "textDocument/formatting", Value::Null),
        (3, "textDocument/codeAction", json!(5)),
        (4, "textDocument/semanticTokens/full", json!({})),
    ] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        // The first message back is this reply: neither didOpen published.
        let reply = server.receive();
        assert_eq!(reply["id"], id, "{reply}");
        assert_eq!(reply["error"]["code"], -32602, "{reply}");
    }
    assert_eq!(server.shutdown_and_exit(), 0);
}

#[test]
fn a_section_or_options_that_are_not_an_object_are_reported() {
    // `"lint": "QS001"` read as no setting at all, with no message, and so
    // did options that were a list (#805).
    for (options, wanted) in [
        (json!({"lint": "QS001"}), "/lint must be an object"),
        (
            json!({"workspaceIndex": false}),
            "/workspaceIndex must be an object",
        ),
        (json!([1]), "initializationOptions must be an object"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (mut server, _) = start_with_options(
            dir.path(),
            &["--lsp", "--profile", "uqf"],
            options.clone(),
            None,
        );
        let message = server.receive();
        assert_eq!(
            message["method"], "window/showMessage",
            "{options}: {message}"
        );
        let text = message["params"]["message"].as_str().unwrap();
        assert!(text.contains(wanted), "{options}: {text}");
        assert_eq!(server.shutdown_and_exit(), 0);
    }
}

/// Where a rule's code leads when it is clicked in the Problems panel: that
/// rule's row in the reference. Every diagnostic a rule makes carries it.
#[test]
fn a_diagnostic_links_its_code_to_the_rule_reference() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/href.q";
    server.open(uri, "f:{[desc] 1==1}\n");
    let diagnostics = server.diagnostics_for(uri);
    assert_eq!(
        codes_of(&diagnostics),
        ["QE004", "QF001"],
        "{diagnostics:?}"
    );
    for d in &diagnostics {
        let code = d["code"].as_str().unwrap();
        assert_eq!(
            d["codeDescription"],
            json!({"href": format!(
                "https://github.com/kwojdalski/q-lint/blob/master/docs/rules.md#{}",
                code.to_lowercase()
            )}),
            "{d}"
        );
    }
    assert_eq!(server.shutdown_and_exit(), 0);
}

/// `source.fixAll.q-lint` is Format Document's edit as a code action, for an
/// editor where something else formats q: it is what
/// `editor.codeActionsOnSave` asks for, by that kind or one above it.
#[test]
fn fix_all_is_the_formatting_edit_for_a_client_that_asks_by_kind() {
    let mut server = Server::start();
    server.initialize();
    let uri = "file:///tmp/fix-all.q";
    // `&&` has a fix only a person should accept: not part of this.
    let before = "/ \u{1F600}\na:1==1; b:1!=2\nc:a&&b\n";
    server.open(uri, before);
    let diagnostics = server.diagnostics_for(uri);
    let edits = server.format(uri)["result"].clone();
    assert_eq!(edits.as_array().unwrap().len(), 1, "{edits}");
    for only in [
        vec!["source"],
        vec!["source.fixAll"],
        vec!["source.fixAll.q-lint"],
        vec!["refactor", "source.fixAll"],
    ] {
        let actions = server.code_actions_only(uri, &only);
        assert_eq!(actions.len(), 1, "{only:?}: {actions:?}");
        assert_eq!(actions[0]["kind"], "source.fixAll.q-lint");
        assert_eq!(actions[0]["title"], "Apply every safe q-lint fix");
        assert_eq!(actions[0]["edit"]["changes"][uri], edits, "{only:?}");
        assert!(actions[0].get("isPreferred").is_none());
    }
    // A kind beside it, one below it, and one that only starts the same.
    for only in [
        vec![],
        vec!["refactor"],
        vec!["source.organizeImports"],
        vec!["source.fixAll.eslint"],
        vec!["source.fixAll.q-lint.more"],
        vec!["source.fixAllOrNothing"],
        vec!["sourcery"],
    ] {
        assert_eq!(
            server.code_actions_only(uri, &only),
            Vec::<Value>::new(),
            "{only:?}"
        );
    }
    // The lightbulb's request names no kind, and gets the quick fixes alone;
    // one that names them gets them too, and still no fix-all.
    let lightbulb = server.code_actions(uri, &diagnostics);
    assert!(!lightbulb.is_empty());
    assert!(
        lightbulb.iter().all(|a| a["kind"] == "quickfix"),
        "{lightbulb:?}"
    );
    server.send(
        json!({"jsonrpc":"2.0","id":22,"method":"textDocument/codeAction",
        "params":{"textDocument":{"uri":uri},"range":diagnostics[0]["range"],
                  "context":{"diagnostics":diagnostics,"only":["quickfix"]}}}),
    );
    assert_eq!(server.until(|m| m["id"] == 22)["result"], json!(lightbulb));

    // Applied, it leaves nothing for itself or for formatting to do.
    let after = apply_edits(before, edits.as_array().unwrap());
    assert_eq!(after, "/ \u{1F600}\na:1=1; b:1<>2\nc:a&&b\n");
    server.change(uri, 2, &after);
    server.diagnostics_for(uri);
    assert_eq!(
        server.code_actions_only(uri, &["source.fixAll"]),
        Vec::<Value>::new()
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

/// No fix-all where there is no edit: a buffer whose structure is broken, one
/// that is not q, and one the server was never given.
#[test]
fn fix_all_is_not_offered_for_a_broken_or_unknown_buffer() {
    let mut server = Server::start();
    server.initialize();
    for (uri, text) in [
        ("file:///tmp/fix-all-unclosed.q", "f:{[x] x==1\n"),
        ("file:///tmp/fix-all-string.q", "a:1==1; s:\"abc\n"),
        ("file:///tmp/fix-all-not-q.k", "a:1==1\n"),
    ] {
        server.open(uri, text);
        server.diagnostics_for(uri);
        assert_eq!(
            server.code_actions_only(uri, &["source.fixAll"]),
            Vec::<Value>::new(),
            "{uri}"
        );
    }
    assert_eq!(
        server.code_actions_only("file:///tmp/fix-all-never-opened.q", &["source.fixAll"]),
        Vec::<Value>::new()
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}

/// `format.enable: false` says this server is not the formatter. Fix-all
/// runs only where a person listed it, so it is still there to list.
#[test]
fn fix_all_does_not_depend_on_the_formatter_being_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, reply) = start_with_options(
        dir.path(),
        &["--lsp", "--profile", "uqf"],
        json!({"format": {"enable": false}}),
        None,
    );
    assert_eq!(
        reply["result"]["capabilities"]["codeActionProvider"],
        code_action_provider()
    );
    let uri = "file:///tmp/fix-all-no-format.q";
    let before = "a:1==1\n";
    server.open(uri, before);
    server.diagnostics_for(uri);
    assert_eq!(server.format(uri)["result"], json!([]));
    let actions = server.code_actions_only(uri, &["source.fixAll.q-lint"]);
    assert_eq!(actions.len(), 1, "{actions:?}");
    assert_eq!(
        apply_edits(
            before,
            actions[0]["edit"]["changes"][uri].as_array().unwrap()
        ),
        "a:1=1\n"
    );
    assert_eq!(server.shutdown_and_exit(), 0);
}
