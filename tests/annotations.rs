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
    let options = json!({"inlayHints": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", LIB)], client(), options);
    assert!(reply["result"]["capabilities"]["inlayHintProvider"].is_null());
    let main = "t:.lib.add[1;2]\n";
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.whole("textDocument/inlayHint", &uri, everything());
    assert_eq!(reply["result"], Value::Null, "{reply}");
}
