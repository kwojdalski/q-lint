//! Help while a line is read or written - hover, signature help and
//! completion - first as the library reads one file and the catalogue of
//! q's own names, then as the language server answers an editor.
use q_lint_rs::{
    Applied, BUILTINS, BuiltinKind, Call, Profile, applied, builtin, call_at, comment_above,
    completing, glyph_at, lint, mentions, word_at,
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{Receiver, channel},
    time::Duration,
};

/// Where `context` starts in `source`, `skip` bytes in.
fn at(source: &str, context: &str, skip: usize) -> usize {
    source.find(context).expect("the context is in the source") + skip
}

// ---------------------------------------------------------------------------
// The catalogue.

/// The characters q's operators and iterators are written in.
const GLYPHS: &str = "+-*%&|^=<>~!#_$?@.,:'/\\";

fn is_glyph(name: &str) -> bool {
    name.chars().all(|c| GLYPHS.contains(c))
}

#[test]
fn every_reserved_word_is_in_the_catalogue_once_and_nothing_else_bare_is() {
    let reserved: Vec<String> = serde_json::from_str(include_str!("../src/reserved.json")).unwrap();
    let bare: Vec<&str> = BUILTINS
        .iter()
        .map(|b| b.name.as_str())
        .filter(|name| name.starts_with(|c: char| c.is_ascii_alphabetic()))
        .collect();
    let mut expected: Vec<&str> = reserved.iter().map(String::as_str).collect();
    expected.sort_unstable();
    // In order, so a word is found by eye and a second entry stands out.
    assert_eq!(bare, expected);
    // Then the qualified names, in order, then the glyphs.
    let rest: Vec<&str> = BUILTINS
        .iter()
        .map(|b| b.name.as_str())
        .skip(bare.len())
        .collect();
    let split = rest.iter().position(|name| is_glyph(name)).unwrap();
    let (dotted, glyphs) = rest.split_at(split);
    let qualified = regex::Regex::new(r"^\.[A-Za-z]\.[A-Za-z][A-Za-z0-9]*$").unwrap();
    assert!(
        dotted.iter().all(|name| qualified.is_match(name)),
        "{dotted:?}"
    );
    assert!(
        dotted.windows(2).all(|pair| pair[0] < pair[1]),
        "{dotted:?}"
    );
    for namespace in [".Q.", ".h.", ".j.", ".z."] {
        assert!(
            dotted.iter().any(|name| name.starts_with(namespace)),
            "{namespace}"
        );
    }
    assert!(glyphs.iter().all(|name| is_glyph(name)), "{glyphs:?}");
    let mut once = glyphs.to_vec();
    once.sort_unstable();
    once.dedup();
    assert_eq!(once.len(), glyphs.len(), "{glyphs:?}");
}

#[test]
fn each_entry_says_how_it_is_written_and_what_it_gives_in_a_line_or_two() {
    for b in BUILTINS.iter() {
        let name = &b.name;
        assert!(b.syntax.contains(name.as_str()), "{name}: {}", b.syntax);
        assert!(
            b.summary.ends_with('.') || b.summary.ends_with(']'),
            "{name}: {}",
            b.summary
        );
        assert!(!b.summary.contains('\n'), "{name}");
        assert!(
            (20..=220).contains(&b.summary.len()),
            "{name}: {}",
            b.summary
        );
        for param in &b.params {
            assert!(b.syntax.contains(param.as_str()), "{name}: {param}");
        }
        match b.kind {
            BuiltinKind::Function | BuiltinKind::Control => {}
            // Written as it is assigned.
            BuiltinKind::Callback => assert!(
                b.syntax.starts_with(&format!("{name}:{{[")),
                "{name}: {}",
                b.syntax
            ),
            BuiltinKind::Query | BuiltinKind::Constant | BuiltinKind::Variable => {
                assert!(b.params.is_empty(), "{name} takes no arguments")
            }
            BuiltinKind::Operator => assert_eq!(b.params, ["x", "y"], "{name}"),
            BuiltinKind::Iterator => assert!(b.params.contains(&"f".to_string()), "{name}"),
        }
        // A glyph is an operator or an iterator, and nothing else is.
        assert_eq!(
            is_glyph(name),
            matches!(b.kind, BuiltinKind::Operator | BuiltinKind::Iterator),
            "{name}"
        );
        if let Some(page) = &b.page {
            assert!(
                page.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{name}: {page}"
            );
        }
        // A namespace's names are on its own page.
        for (namespace, page) in [
            (".Q.", "dotq"),
            (".h.", "doth"),
            (".j.", "dotj"),
            (".z.", "dotz"),
        ] {
            if name.starts_with(namespace) {
                assert_eq!(b.page.as_deref(), Some(page), "{name}");
            }
        }
    }
    let mut names: Vec<&str> = BUILTINS.iter().map(|b| b.name.as_str()).collect();
    names.sort_unstable();
    let count = names.len();
    names.dedup();
    assert_eq!(names.len(), count, "a name is in the catalogue twice");
    assert_eq!(builtin("no_such_word").map(|b| &b.name), None);
    assert_eq!(builtin("til").unwrap().params, ["x"]);
}

#[test]
fn the_catalogue_and_the_arity_rule_agree_on_how_many_arguments_a_word_takes() {
    let draws = |call: &str| {
        lint(call, "t.q", Profile::General)
            .iter()
            .any(|f| f.code == "QA010")
    };
    // The rule is awake: it knows these two.
    assert!(draws("r:md5[a;b]\n") && draws("r:ssr[a;b;c;d]\n"));
    for b in BUILTINS
        .iter()
        .filter(|b| b.kind == BuiltinKind::Function && !b.params.is_empty())
    {
        let arguments: Vec<String> = (0..b.params.len()).map(|n| format!("a{n}")).collect();
        let call = format!("r:{}[{}]\n", b.name, arguments.join(";"));
        assert!(!draws(&call), "QA010 refuses {call}");
    }
}

// ---------------------------------------------------------------------------
// One file, as the library reads it.

/// What each definition in `source` takes, by the name defined.
fn parameters(source: &str) -> Vec<(String, Vec<String>)> {
    mentions(source)
        .into_iter()
        .filter_map(|m| Some((m.name, m.definition.filter(|d| d.function)?.params)))
        .collect()
}

fn takes(name: &str, params: &[&str]) -> (String, Vec<String>) {
    (
        name.to_string(),
        params.iter().map(|p| p.to_string()).collect(),
    )
}

#[test]
fn a_function_takes_what_its_signature_names_or_what_its_body_reads() {
    let source = "add:{[a;b] a+b}\nnone:{[] 1}\nconstant:{1}\none:{x*2}\n\
                  third:{x+z}\nouter:{[a] {x+y}[a]}\npair:{[(a;b);c] a}\n";
    assert_eq!(
        parameters(source),
        [
            takes("add", &["a", "b"]),
            takes("none", &[]),
            takes("constant", &[]),
            takes("one", &["x"]),
            // q counts up to the last one read: `{x+z}` takes three.
            takes("third", &["x", "y", "z"]),
            // The inner lambda's x and y are its own.
            takes("outer", &["a"]),
            takes("pair", &["(a;b)", "c"]),
        ]
    );
}

#[test]
fn a_projection_takes_the_slots_it_leaves_open() {
    let source = "turn:{[g;n] g+n}[;7]\ninc:{[a;b] a+b}[1]\nmid:{[a;b;c] b}[1;;3]\nnext1:{x+y} 1\n";
    assert_eq!(
        parameters(source),
        [
            takes("turn", &["g"]),
            takes("inc", &["b"]),
            takes("mid", &["b"]),
            takes("next1", &["y"]),
        ]
    );
}

/// The comment above the definition of `name` in `source`.
fn above(source: &str, name: &str) -> String {
    let start = mentions(source)
        .into_iter()
        .find(|m| m.name == name && m.definition.is_some())
        .and_then(|m| m.definition)
        .expect("the name is defined")
        .start;
    comment_above(source, start)
}

#[test]
fn the_comment_above_a_definition_is_the_lines_touching_it() {
    let source = "/ A licence.\n\n/ Adds two numbers.\n//  a: the first\nadd:{[a;b] a+b}\n\
                  limit:10 / the most\nnext_one:2\n/ apart\n\nlone:1\n";
    // Without the markers and one space; the rest of the indentation stays.
    assert_eq!(above(source, "add"), "Adds two numbers.\n a: the first");
    // A trailing comment belongs to its own line, and a blank line parts.
    assert_eq!(above(source, "next_one"), "");
    assert_eq!(above(source, "lone"), "");
    assert_eq!(above("f:1\n", "f"), "");
}

#[test]
fn a_block_comment_ending_above_a_definition_describes_it() {
    let source = "a:1\n/\nReads the feed.\n  Twice.\n\\\n/ and once more\nfeed:{x}\n";
    assert_eq!(
        above(source, "feed"),
        "Reads the feed.\n  Twice.\nand once more"
    );
    // A line of a string that starts with `/` is no comment.
    let source = "s:\"a\n / b\"\nf:{x}\n";
    assert_eq!(above(source, "f"), "");
}

/// The call the end of `source` is in, as the name called and the argument.
fn call(source: &str) -> Option<(&str, usize)> {
    call_at(source, source.len())
        .map(|Call { at, len, argument }| (&source[at..at + len], argument))
}

#[test]
fn a_call_is_the_innermost_open_bracket_after_a_name() {
    assert_eq!(call("x:.lib.add["), Some((".lib.add", 0)));
    assert_eq!(call("x:.lib.add[1;"), Some((".lib.add", 1)));
    // What is closed is one argument, whatever it holds.
    assert_eq!(call("x:f[a;g[1;2];"), Some(("f", 2)));
    assert_eq!(call("x:f[a;g[1;"), Some(("g", 1)));
    // A list is still the argument it is in.
    assert_eq!(call("x:f[a;(b;c"), Some(("f", 1)));
    // A `;` in a string or a comment separates nothing.
    assert_eq!(call("ssr[\"a;b\";"), Some(("ssr", 1)));
    assert_eq!(call("f[1; / one; two\n  "), Some(("f", 1)));
    // And in the comment itself nothing is being called.
    assert_eq!(call("f[1; / one; two"), None);
    assert_eq!(call("f[1;\n  / g["), None);
    // Over lines, while they are indented.
    assert_eq!(call("x:f[1;\n  2;"), Some(("f", 2)));
    assert_eq!(call("if[a;b;c;"), Some(("if", 3)));
}

#[test]
fn nothing_is_called_outside_brackets_or_by_what_is_not_a_name() {
    assert_eq!(call("f[1;2]"), None);
    assert_eq!(call("x:1+"), None);
    // A lambda's body is being written, not the argument around it.
    assert_eq!(call("f:{g[1;{x+"), None);
    // A new statement closes whatever the one before left open.
    assert_eq!(call("x:f[1;\nb:2;"), None);
    // An operator's bracket form, a lambda in place and an index of a
    // literal have no name.
    assert_eq!(call("$[a;"), None);
    assert_eq!(call("{x+y}[1;"), None);
    assert_eq!(call("(1 2 3)["), None);
    assert_eq!(call("x:`sym["), None);
    assert_eq!(call(""), None);
}

#[test]
fn a_space_before_the_bracket_still_calls_the_name() {
    // q 5 reads `f [1;2;3]` as `f[1;2;3]`, after a tab too, at the top
    // level, in an assignment and in a lambda.
    assert_eq!(call("x:f [1;"), Some(("f", 1)));
    assert_eq!(call("x:f\t[1;2;"), Some(("f", 2)));
    assert_eq!(call("g:{.lib.add  [x;"), Some((".lib.add", 1)));
    assert_eq!(call("r:in [a;"), Some(("in", 1)));
    // What is before the space is still to be a name.
    assert_eq!(call("x:`sym ["), None);
    assert_eq!(call("x:1 2 ["), None);
    assert_eq!(call("x:(a) [1;"), None);
}

#[test]
fn a_call_goes_on_inside_a_string_left_open() {
    // A `;`, a bracket or a brace in the string is part of it.
    assert_eq!(call("x:ssr[\"ab;"), Some(("ssr", 0)));
    assert_eq!(call("x:ssr[1;\"a[b;{"), Some(("ssr", 1)));
    assert_eq!(call("x:ssr[1;\"a\\\"b;"), Some(("ssr", 1)));
    // Over an indented line; a line at column 0 ends the statement, string
    // and all, as it does in q.
    assert_eq!(call("x:ssr[1;\"ab\n  c;d"), Some(("ssr", 1)));
    assert_eq!(call("x:ssr[1;\"ab\nc"), None);
}

/// What the assignment of `name` in `source` assigns, as the name it reads
/// and the slots it gives.
fn assigns<'a>(source: &'a str, name: &str) -> Option<(&'a str, Option<Vec<bool>>)> {
    let end = source.find(name).unwrap() + name.len();
    applied(source, end).map(|Applied { at, len, given }| (&source[at..at + len], given))
}

#[test]
fn an_assignment_of_a_name_or_a_projection_says_what_it_applies() {
    assert_eq!(assigns("al:add\n", "al"), Some(("add", None)));
    assert_eq!(
        assigns(".zz.pr:.zz.add[;2;]\n", ".zz.pr"),
        Some((".zz.add", Some(vec![false, true, false])))
    );
    assert_eq!(
        assigns("f:{g::h [1]; 2}", "g"),
        Some(("h", Some(vec![true])))
    );
    assert_eq!(assigns("al:ssr / the same\n", "al"), Some(("ssr", None)));
    // A string fills its slot, though the code view blanks it.
    assert_eq!(
        assigns("sub:ssr[;\"a;b\";]\n", "sub"),
        Some(("ssr", Some(vec![false, true, false])))
    );
    for (source, name) in [
        ("x:add+1\n", "x"),
        ("x:add 1\n", "x"),
        ("x:y:add\n", "x"),
        ("x:`add\n", "x"),
        ("x:1\n", "x"),
        ("x:{x}\n", "x"),
        ("x:add[1]+1\n", "x"),
    ] {
        assert_eq!(assigns(source, name), None, "{source}");
    }
}

/// The glyph at `skip` bytes into `context` in `source`.
fn glyph<'a>(source: &'a str, context: &str, skip: usize) -> Option<&'a str> {
    glyph_at(source, at(source, context, skip)).map(|(at, len)| &source[at..at + len])
}

#[test]
fn a_glyph_is_one_outside_names_numbers_strings_and_comments() {
    let source = "r:a+/:b; s:x<=y; t:2_ys; u:f':[v]; w:x . y\n";
    assert_eq!(glyph(source, "+/:", 0), Some("+"));
    assert_eq!(glyph(source, "/:", 0), Some("/:"));
    assert_eq!(glyph(source, "/:", 1), Some("/:"));
    assert_eq!(glyph(source, "<=", 1), Some("<="));
    assert_eq!(glyph(source, "_ys", 0), Some("_"));
    assert_eq!(glyph(source, "':", 0), Some("':"));
    assert_eq!(glyph(source, " . ", 1), Some("."));
    assert_eq!(glyph(source, "r:", 1), Some(":"));
    let source = "a:x_y; b:.z.p; c:1.5; d:x -1; e:x-1; f:\"+\" / +\ng:`a.b; h:10 0:t\n\\l x.q\n";
    for (context, skip) in [
        ("x_y", 1),
        (".z.p", 0),
        (".z.p", 2),
        ("1.5", 1),
        ("-1;", 0),
        ("\"+\"", 1),
        ("/ +", 2),
        ("`a.b", 2),
        ("0:t", 1),
        ("x.q", 1),
    ] {
        assert_eq!(glyph(source, context, skip), None, "{context}");
    }
    assert_eq!(glyph(source, "x-1", 1), Some("-"));
}

#[test]
fn a_word_is_any_name_in_code_keywords_included() {
    assert_eq!(word_at("n:count 1 2", 4), Some((2, 5)));
    assert_eq!(word_at("n:count 1 2", 7), Some((2, 5)));
    assert_eq!(word_at("select from t", 0), Some((0, 6)));
    assert_eq!(word_at(".z.p+1", 2), Some((0, 4)));
    for (source, offset) in [
        ("a:\"count\"", 5),
        ("/ count", 4),
        ("x:`count", 5),
        ("\\l count", 5),
        ("a: 1", 2),
    ] {
        assert_eq!(word_at(source, offset), None, "{source}");
    }
}

/// What is being typed at the end of `source`: the text so far, the locals
/// in reach and the context.
fn typing(source: &str) -> Option<(&str, Vec<String>, String)> {
    completing(source, source.len()).map(|c| (&source[c.start..], c.locals, c.namespace))
}

#[test]
fn what_is_being_typed_is_a_name_with_the_locals_and_context_around_it() {
    let (typed, locals, namespace) = typing("f:{[abc;d] loc:1; lo").unwrap();
    assert_eq!((typed, namespace.as_str()), ("lo", ""));
    assert_eq!(locals, ["abc", "d", "loc"]);
    // A lambda without a signature has x, y and z.
    let (typed, locals, namespace) = typing("\\d .ns\ng:1\nh:{x+").unwrap();
    assert_eq!((typed, namespace.as_str()), ("", ".ns"));
    assert_eq!(locals, ["x", "y", "z"]);
    // Outside a lambda there are none, and a qualified name is one word.
    assert_eq!(typing("x:.z."), Some((".z.", vec![], String::new())));
    assert_eq!(typing("q)fo"), Some(("fo", vec![], String::new())));
    assert_eq!(typing(""), Some(("", vec![], String::new())));
    // After a string that has closed, code again.
    assert_eq!(typing("a:\"s\" co"), Some(("co", vec![], String::new())));
}

#[test]
fn no_name_is_being_typed_in_a_string_a_comment_a_symbol_a_number_or_a_command() {
    for source in [
        "a:\"str",
        "a:\"one\ntwo",
        "a:1 / com",
        "/ whole line",
        "/\nblock\nfo",
        "\\l fi",
        "x:`sy",
        "x:`a`b.c",
        "x:12",
        "x:1.5e",
        "k)fo",
    ] {
        assert_eq!(typing(source), None, "{source}");
    }
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

/// What an editor that draws markdown declares, as far as help reads it.
fn client() -> Value {
    json!({"textDocument": {
        "hover": {"contentFormat": ["markdown", "plaintext"]},
        "signatureHelp": {"signatureInformation": {
            "documentationFormat": ["markdown", "plaintext"],
            "parameterInformation": {"labelOffsetSupport": true},
        }},
        "completion": {"completionItem": {"documentationFormat": ["markdown", "plaintext"]}},
    }})
}

/// And one that shows text as it comes.
fn plain() -> Value {
    json!({"textDocument": {}})
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

const LIB: &str = "\\d .lib\n/ Adds two numbers.\n/  a: the *first*\nadd:{[a;b] a+b}\n\n\
                   limit:10\n\\d .\n/\nScales.\n\\\nroot_fn:{x*y}\n";
const MAIN: &str = "\\l lib.q\ntotal:.lib.add[1;2]\n\
                    calc:{[n] m:n+.lib.limit; root_fn[m;til 3]}\n";
const COMPLETING: &str = r#"{"completion": {"enable": true}}"#;

/// A server over `lib.q` and `main.q`, with `main.q` open as `text`.
fn serving(dir: &Path, text: &str, client: Value, options: Value) -> (Server, String) {
    let (mut server, _) = Server::over(dir, &[("lib.q", LIB), ("main.q", text)], client, options);
    let uri = server.open(dir, "main.q", text);
    (server, uri)
}

#[test]
fn help_is_announced_and_completion_only_when_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let (_, reply) = Server::over(dir.path(), &[], client(), Value::Null);
    let capabilities = &reply["result"]["capabilities"];
    assert_eq!(capabilities["hoverProvider"], true);
    assert_eq!(
        capabilities["signatureHelpProvider"],
        json!({"triggerCharacters": ["["], "retriggerCharacters": [";"]})
    );
    // An editor told a server completes stops offering the buffer's words.
    assert_eq!(capabilities["completionProvider"], Value::Null);

    let options = json!({"help": {"enable": false}, "completion": {"enable": true}});
    let (_, reply) = Server::over(dir.path(), &[], client(), options);
    let capabilities = &reply["result"]["capabilities"];
    assert_eq!(capabilities["hoverProvider"], Value::Null);
    assert_eq!(capabilities["signatureHelpProvider"], Value::Null);
    assert_eq!(
        capabilities["completionProvider"],
        json!({"triggerCharacters": ["."]})
    );
}

#[test]
fn what_is_turned_off_answers_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, uri) = serving(
        dir.path(),
        MAIN,
        client(),
        json!({"help": {"enable": false}}),
    );
    for method in [
        "textDocument/hover",
        "textDocument/signatureHelp",
        // Off unless asked for.
        "textDocument/completion",
    ] {
        let reply = server.ask(method, &uri, MAIN, ".lib.add[1;", 12, Value::Null);
        assert_eq!(reply["result"], Value::Null, "{method}");
        assert_eq!(reply["error"], Value::Null, "{method}");
    }
}

#[test]
fn a_bad_help_option_is_reported_and_its_default_kept() {
    let dir = tempfile::tempdir().unwrap();
    let options = json!({"help": true, "completion": {"enable": "yes"}});
    let (_, reply) = Server::over(dir.path(), &[], client(), options);
    let capabilities = &reply["result"]["capabilities"];
    assert_eq!(capabilities["hoverProvider"], true);
    assert_eq!(capabilities["completionProvider"], Value::Null);
}

#[test]
fn hovering_a_function_shows_its_parameters_its_comment_and_its_file() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, uri) = serving(dir.path(), MAIN, plain(), Value::Null);
    let reply = server.ask(
        "textDocument/hover",
        &uri,
        MAIN,
        ".lib.add[1",
        5,
        Value::Null,
    );
    let hover = &reply["result"];
    assert_eq!(
        hover["contents"],
        json!({"kind": "plaintext",
               "value": ".lib.add[a;b]\n\nAdds two numbers.\n a: the *first*\n\nlib.q"})
    );
    assert_eq!(span(&hover["range"]), (1, 6, 14));
    // An implicit signature is what the body reads, and a block comment
    // counts as the comment above.
    let reply = server.ask(
        "textDocument/hover",
        &uri,
        MAIN,
        "root_fn[m",
        0,
        Value::Null,
    );
    assert_eq!(
        reply["result"]["contents"]["value"],
        "root_fn[x;y]\n\nScales.\n\nlib.q"
    );
}

#[test]
fn a_comment_is_shown_as_written_by_a_client_that_draws_markdown() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, uri) = serving(dir.path(), MAIN, client(), Value::Null);
    let reply = server.ask(
        "textDocument/hover",
        &uri,
        MAIN,
        ".lib.add[1",
        5,
        Value::Null,
    );
    assert_eq!(
        reply["result"]["contents"],
        json!({"kind": "markdown",
               "value": "```q\n.lib.add[a;b]\n```\n\nAdds two numbers\\.  \n\u{a0}a\\: the \\*first\\*\n\n*lib\\.q*"})
    );
}

#[test]
fn hovering_a_variable_shows_the_line_that_assigns_it() {
    let dir = tempfile::tempdir().unwrap();
    let (mut server, uri) = serving(dir.path(), MAIN, plain(), Value::Null);
    let reply = server.ask(
        "textDocument/hover",
        &uri,
        MAIN,
        ".lib.limit",
        1,
        Value::Null,
    );
    assert_eq!(reply["result"]["contents"]["value"], "limit:10\n\nlib.q");
    // The open buffer's own, read as the editor has it.
    let reply = server.ask("textDocument/hover", &uri, MAIN, "total:", 0, Value::Null);
    assert_eq!(
        reply["result"]["contents"]["value"],
        "total:.lib.add[1;2]\n\nmain.q"
    );
}

#[test]
fn hovering_a_word_of_q_shows_its_catalogue_entry() {
    let dir = tempfile::tempdir().unwrap();
    let text = "n:til 3\nt:select from ([] a:1 2)\nnow:.z.p\n";
    let (mut server, uri) = serving(dir.path(), text, client(), Value::Null);
    let reply = server.ask("textDocument/hover", &uri, text, "til 3", 1, Value::Null);
    assert_eq!(
        reply["result"]["contents"]["value"],
        "```q\ntil x\n```\n\nThe first x natural numbers\\: 0 up to x\\-1\\.\n\n\
         [Reference](https://code.kx.com/q/ref/til/)"
    );
    assert_eq!(span(&reply["result"]["range"]), (0, 2, 5));
    let reply = server.ask("textDocument/hover", &uri, text, "select", 0, Value::Null);
    let value = reply["result"]["contents"]["value"].as_str().unwrap();
    assert!(
        value.starts_with("```q\nselect ... by ... from t where ...\n```"),
        "{value}"
    );
    let reply = server.ask("textDocument/hover", &uri, text, ".z.p", 3, Value::Null);
    let value = reply["result"]["contents"]["value"].as_str().unwrap();
    assert!(value.contains("The current UTC time"), "{value}");
    assert!(
        value.ends_with("(https://code.kx.com/q/ref/dotz/)"),
        "{value}"
    );
}

#[test]
fn nothing_is_shown_for_a_local_a_string_a_comment_or_an_unknown_name() {
    let dir = tempfile::tempdir().unwrap();
    let text = "count_of:{[til] til+1}\ns:\"til\" / til\nu:unknown_name 1\n";
    let (mut server, uri) = serving(dir.path(), text, client(), Value::Null);
    for (context, skip) in [
        // A parameter named as a keyword is the parameter.
        ("til+1", 1),
        ("\"til\"", 2),
        ("/ til", 3),
        ("unknown_name", 2),
    ] {
        let reply = server.ask("textDocument/hover", &uri, text, context, skip, Value::Null);
        assert_eq!(reply["result"], Value::Null, "{context}");
    }
}

#[test]
fn a_name_several_files_define_shows_each_definition_its_own_first() {
    let dir = tempfile::tempdir().unwrap();
    let text = "\\l a.q\nhandler:{[msg] msg}\nr:handler 1\n";
    let (mut server, _) = Server::over(
        dir.path(),
        &[
            ("a.q", "/ The first.\nhandler:{[a;b] a}\n"),
            ("main.q", text),
        ],
        plain(),
        Value::Null,
    );
    let uri = server.open(dir.path(), "main.q", text);
    let reply = server.ask(
        "textDocument/hover",
        &uri,
        text,
        "handler 1",
        0,
        Value::Null,
    );
    assert_eq!(
        reply["result"]["contents"]["value"],
        "handler[msg]\n\nmain.q\n\nhandler[a;b]\n\nThe first.\n\na.q"
    );
    // And signature help lists both, on the first that takes the argument
    // being written.
    let typed = "\\l a.q\nhandler:{[msg] msg}\nr:handler[1;";
    let uri = server.open(dir.path(), "main.q", typed);
    let reply = server.ask(
        "textDocument/signatureHelp",
        &uri,
        typed,
        "r:handler[1;",
        12,
        Value::Null,
    );
    let help = &reply["result"];
    let labels: Vec<&str> = help["signatures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["handler[msg]", "handler[a;b]"]);
    assert_eq!(
        (&help["activeSignature"], &help["activeParameter"]),
        (&json!(1), &json!(1))
    );
}

#[test]
fn a_file_defining_a_name_itself_is_not_shown_an_unrelated_files_definition() {
    let dir = tempfile::tempdir().unwrap();
    let text = "handler:{[msg] msg}\nr:handler 1\n";
    let other = "r:handler 2\n";
    let (mut server, _) = Server::over(
        dir.path(),
        &[
            ("a.q", "handler:{[a;b] a}\n"),
            ("main.q", text),
            ("other.q", other),
        ],
        plain(),
        Value::Null,
    );
    let uri = server.open(dir.path(), "main.q", text);
    let reply = server.ask(
        "textDocument/hover",
        &uri,
        text,
        "handler 1",
        0,
        Value::Null,
    );
    assert_eq!(
        reply["result"]["contents"]["value"],
        "handler[msg]\n\nmain.q"
    );
    // A file that defines it nowhere is shown every definition.
    let uri = server.open(dir.path(), "other.q", other);
    let reply = server.ask(
        "textDocument/hover",
        &uri,
        other,
        "handler 2",
        0,
        Value::Null,
    );
    assert_eq!(
        reply["result"]["contents"]["value"],
        "handler[a;b]\n\na.q\n\nhandler[msg]\n\nmain.q"
    );
}

#[test]
fn the_path_of_a_load_is_shown_as_the_file_it_loads() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("lib")).unwrap();
    std::fs::write(dir.path().join("lib/util.q"), "u:1\n").unwrap();
    let text = "\\l lib/util.q\nsystem \"l lib/util.q\"\n\\l lib/missing.q\n";
    let (mut server, uri) = serving(dir.path(), text, plain(), Value::Null);
    for (context, skip) in [("\\l lib", 4), ("\"l lib", 3)] {
        let reply = server.ask("textDocument/hover", &uri, text, context, skip, Value::Null);
        assert_eq!(
            reply["result"]["contents"]["value"], "lib/util.q",
            "{context}"
        );
    }
    let reply = server.ask("textDocument/hover", &uri, text, "missing", 0, Value::Null);
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

#[test]
fn signature_help_names_the_parameter_being_written() {
    let dir = tempfile::tempdir().unwrap();
    // A line being typed: its bracket is still open.
    let text = "\\l lib.q\ntotal:.lib.add[1;";
    let (mut server, uri) = serving(dir.path(), text, client(), Value::Null);
    let reply = server.ask(
        "textDocument/signatureHelp",
        &uri,
        text,
        ".lib.add[1;",
        11,
        Value::Null,
    );
    assert_eq!(
        reply["result"],
        json!({
            "signatures": [{
                "label": ".lib.add[a;b]",
                "parameters": [{"label": [9, 10]}, {"label": [11, 12]}],
                "activeParameter": 1,
                "documentation": {"kind": "markdown",
                                  "value": "Adds two numbers\\.  \n\u{a0}a\\: the \\*first\\*"},
            }],
            "activeSignature": 0,
            "activeParameter": 1,
        })
    );
    let reply = server.ask(
        "textDocument/signatureHelp",
        &uri,
        text,
        ".lib.add[1;",
        9,
        Value::Null,
    );
    assert_eq!(reply["result"]["activeParameter"], 0);
    // Outside the brackets there is no call.
    let reply = server.ask(
        "textDocument/signatureHelp",
        &uri,
        text,
        "total:",
        3,
        Value::Null,
    );
    assert_eq!(reply["result"], Value::Null);
}

#[test]
fn signature_help_for_a_word_of_q_comes_from_the_catalogue() {
    let dir = tempfile::tempdir().unwrap();
    let text = "r:ssr[\"a;b\";\"a\";\nif[r~\"x\";a:1;b:2;c:3\n";
    let (mut server, uri) = serving(dir.path(), text, plain(), Value::Null);
    let reply = server.ask(
        "textDocument/signatureHelp",
        &uri,
        text,
        "\"a\";",
        4,
        Value::Null,
    );
    let help = &reply["result"];
    assert_eq!(help["signatures"][0]["label"], "ssr[x;y;z]");
    // Without label offsets, a parameter is named by its text; without
    // markdown, the documentation is a string.
    assert_eq!(
        help["signatures"][0]["parameters"],
        json!([{"label": "x"}, {"label": "y"}, {"label": "z"}])
    );
    assert!(help["signatures"][0]["documentation"].is_string());
    assert_eq!(help["activeParameter"], 2);
    // `if` takes any number of expressions: past the second, still the last.
    let reply = server.ask(
        "textDocument/signatureHelp",
        &uri,
        text,
        "c:3",
        0,
        Value::Null,
    );
    let help = &reply["result"];
    assert_eq!(help["signatures"][0]["label"], "if[test;e1;...]");
    assert_eq!(help["activeParameter"], 2);
}

#[test]
fn signature_help_is_silent_for_a_local_and_for_an_unknown_name() {
    let dir = tempfile::tempdir().unwrap();
    let text = "apply:{[add;v] add[v;\nr:nobody[1;\n";
    let (mut server, uri) = serving(dir.path(), text, client(), Value::Null);
    for (context, skip) in [("add[v;", 6), ("nobody[1;", 9)] {
        let reply = server.ask(
            "textDocument/signatureHelp",
            &uri,
            text,
            context,
            skip,
            Value::Null,
        );
        assert_eq!(reply["result"], Value::Null, "{context}");
        assert_eq!(reply["error"], Value::Null, "{context}");
    }
}

/// The labels a completion reply offers, in the order the server ranks them.
fn offered(reply: &Value) -> Vec<&str> {
    let mut items: Vec<(&str, &str)> = reply["result"]["items"]
        .as_array()
        .unwrap_or_else(|| panic!("a completion list, not {reply}"))
        .iter()
        .map(|item| {
            (
                item["sortText"].as_str().unwrap(),
                item["label"].as_str().unwrap(),
            )
        })
        .collect();
    items.sort_unstable();
    items.into_iter().map(|(_, label)| label).collect()
}

fn completing_options() -> Value {
    serde_json::from_str(COMPLETING).unwrap()
}

#[test]
fn completion_offers_locals_then_the_workspace_then_q() {
    let dir = tempfile::tempdir().unwrap();
    let text = "\\l lib.q\nlimit_here:3\ncalc:{[lines;n] li";
    let (mut server, uri) = serving(dir.path(), text, client(), completing_options());
    let reply = server.ask(
        "textDocument/completion",
        &uri,
        text,
        "] li",
        4,
        Value::Null,
    );
    assert_eq!(reply["result"]["isIncomplete"], false);
    let offered = offered(&reply);
    // The parameter, the root's global, q's words with those letters in
    // order, and last the qualified names.
    assert_eq!(offered[..2], ["lines", "limit_here"]);
    let like = offered.iter().position(|l| *l == "like").unwrap();
    let qualified = offered.iter().position(|l| *l == ".lib.limit").unwrap();
    assert!(1 < like && like < qualified, "{offered:?}");
    assert!(
        !offered.contains(&"n") && !offered.contains(&"calc"),
        "{offered:?}"
    );
    // What is typed is replaced, and a word of q says what it is.
    let items = reply["result"]["items"].as_array().unwrap();
    let item = |label: &str| items.iter().find(|i| i["label"] == label).unwrap();
    assert_eq!(
        item("lines")["textEdit"],
        json!({"range": {"start": {"line": 2, "character": 16},
                         "end": {"line": 2, "character": 18}},
               "newText": "lines"})
    );
    assert_eq!(
        (&item("lines")["kind"], &item("limit_here")["kind"]),
        (&json!(6), &json!(6))
    );
    assert_eq!(item("like")["detail"], "x like y");
    assert_eq!(item("like")["documentation"]["kind"], "markdown");
}

#[test]
fn completion_after_a_dot_continues_the_qualified_name() {
    let dir = tempfile::tempdir().unwrap();
    let text = "\\l lib.q\nr:.lib.";
    let (mut server, uri) = serving(dir.path(), text, plain(), completing_options());
    let reply = server.ask(
        "textDocument/completion",
        &uri,
        text,
        "r:.lib.",
        7,
        Value::Null,
    );
    assert_eq!(offered(&reply), [".lib.add", ".lib.limit"]);
    let items = reply["result"]["items"].as_array().unwrap();
    // A function and a variable, and the whole name replaced.
    assert_eq!(
        (&items[0]["kind"], &items[1]["kind"]),
        (&json!(3), &json!(6))
    );
    assert_eq!(items[0]["textEdit"]["range"]["start"]["character"], 2);

    let text = "now:.z.p";
    let uri = server.open(dir.path(), "main.q", text);
    let reply = server.ask(
        "textDocument/completion",
        &uri,
        text,
        ".z.p",
        4,
        Value::Null,
    );
    let offered = offered(&reply);
    assert!(
        offered.contains(&".z.p") && offered.contains(&".z.pg"),
        "{offered:?}"
    );
    assert!(offered.iter().all(|l| l.starts_with(".z.")), "{offered:?}");
    // A string, when the client asked for no markdown.
    let items = reply["result"]["items"].as_array().unwrap();
    assert!(items[0]["documentation"].is_string());
}

#[test]
fn completion_spells_a_name_as_the_context_in_force_reads_it() {
    let dir = tempfile::tempdir().unwrap();
    let text = "\\l lib.q\nroot_here:1\n\\d .lib\nr:";
    let (mut server, uri) = serving(dir.path(), text, client(), completing_options());
    let reply = server.ask("textDocument/completion", &uri, text, "r:", 2, Value::Null);
    let offered = offered(&reply);
    // Under `\d .lib`, its names need no prefix - and the root's are out
    // of reach by their bare names.
    assert_eq!(offered[..2], ["add", "limit"]);
    assert!(
        !offered.contains(&"root_here") && !offered.contains(&"root_fn"),
        "{offered:?}"
    );
    assert!(
        offered.contains(&".lib.add") && offered.contains(&"count"),
        "{offered:?}"
    );
}

#[test]
fn completion_offers_nothing_where_no_name_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let text = "s:\"li\nc:1 / li\nx:`li\n";
    let (mut server, uri) = serving(dir.path(), text, client(), completing_options());
    for (context, skip) in [("\"li", 3), ("/ li", 4), ("`li", 3)] {
        let reply = server.ask(
            "textDocument/completion",
            &uri,
            text,
            context,
            skip,
            Value::Null,
        );
        assert_eq!(
            reply["result"],
            json!({"isIncomplete": false, "items": []}),
            "{context}"
        );
    }
}

/// A workspace of a function of three, a projection and aliases of it.
const ZZ: &str = "/ Adds three numbers.\n.zz.add:{[a;b;c] a+b+c}\n.zz.pr:.zz.add[;2;]\n\
                  .zz.al:.zz.add\n/ Projected twice.\n.zz.ch:.zz.pr[1]\n.zz.loop:.zz.back\n\
                  .zz.back:.zz.loop\nsub:ssr[;\"a\";]\n";

/// Signature help at the end of `typed`, written after `ZZ` in `zz.q`.
fn zz_help(client: Value, typed: &str) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let text = format!("{ZZ}{typed}");
    let (mut server, _) = Server::over(dir.path(), &[("zz.q", &text)], client, Value::Null);
    let uri = server.open(dir.path(), "zz.q", &text);
    let reply = server.ask(
        "textDocument/signatureHelp",
        &uri,
        &text,
        typed,
        typed.len(),
        Value::Null,
    );
    reply["result"].clone()
}

fn labelled(help: &Value) -> (String, Value) {
    (
        help["signatures"][help["activeSignature"].as_u64().unwrap() as usize]["label"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        help["activeParameter"].clone(),
    )
}

#[test]
fn signature_help_for_a_projection_shows_the_slots_it_leaves_open() {
    let help = zz_help(plain(), "r:.zz.pr[1;");
    assert_eq!(labelled(&help), (".zz.pr[a;c]".to_string(), json!(1)));
    // With no comment of its own, what it projects says what it does.
    assert_eq!(
        help["signatures"][0]["documentation"],
        "Adds three numbers."
    );
    // A projection of a projection, with its own comment.
    let help = zz_help(plain(), "r:.zz.ch[");
    assert_eq!(labelled(&help), (".zz.ch[c]".to_string(), json!(0)));
    assert_eq!(help["signatures"][0]["documentation"], "Projected twice.");
    // And of a word of q.
    let help = zz_help(plain(), "r:sub[s;");
    assert_eq!(labelled(&help), ("sub[x;z]".to_string(), json!(1)));
}

#[test]
fn signature_help_for_an_alias_is_the_function_it_names() {
    let help = zz_help(plain(), "r:.zz.al[1;2;");
    assert_eq!(labelled(&help), (".zz.al[a;b;c]".to_string(), json!(2)));
    // Two aliases of each other lead nowhere, and say nothing.
    assert_eq!(zz_help(plain(), "r:.zz.loop[1;"), Value::Null);
}

#[test]
fn signature_help_reads_a_call_with_a_space_before_its_bracket() {
    let help = zz_help(plain(), "r:.zz.add [1;");
    assert_eq!(labelled(&help), (".zz.add[a;b;c]".to_string(), json!(1)));
}

#[test]
fn signature_help_goes_on_inside_a_string_left_open() {
    let help = zz_help(plain(), "r:.zz.add[1;\"a;b[");
    assert_eq!(labelled(&help), (".zz.add[a;b;c]".to_string(), json!(1)));
}

#[test]
fn signature_help_past_the_last_parameter_says_there_are_too_many() {
    // An index past the last parameter, which highlights none, to a client
    // that does not take null for that.
    let help = zz_help(plain(), "r:.zz.add[1;2;3;");
    assert_eq!(labelled(&help), (".zz.add[a;b;c]".to_string(), json!(3)));
    assert_eq!(help["signatures"][0]["activeParameter"], 3);
    let said = help["signatures"][0]["documentation"].as_str().unwrap();
    assert!(
        said.starts_with("Too many arguments: .zz.add takes 3 arguments.\n"),
        "{said}"
    );
    // Null to one that does.
    let mut client = client();
    client["textDocument"]["signatureHelp"]["signatureInformation"]["noActiveParameterSupport"] =
        json!(true);
    let help = zz_help(client, "r:.zz.add[1;2;3;4;");
    assert_eq!(help["activeParameter"], Value::Null);
    assert_eq!(help["signatures"][0]["activeParameter"], Value::Null);
    // The last parameter is no overflow, and an open list of expressions
    // never has one.
    let help = zz_help(plain(), "r:.zz.add[1;2;");
    assert_eq!(help["activeParameter"], 2);
    assert!(
        !help["signatures"][0]["documentation"]
            .as_str()
            .unwrap()
            .contains("Too many")
    );
    let help = zz_help(plain(), "if[a;b;c;d;");
    assert_eq!(help["activeParameter"], 2);
}

#[test]
fn hovering_a_glyph_shows_its_catalogue_entry() {
    let dir = tempfile::tempdir().unwrap();
    let text = "r:a+/:b\ns:2_ys\nt:x<=y\n";
    let (mut server, uri) = serving(dir.path(), text, plain(), Value::Null);
    let hover = |server: &mut Server, context: &str, skip: usize| {
        server.ask("textDocument/hover", &uri, text, context, skip, Value::Null)["result"].clone()
    };
    // On the glyph right after a name, the glyph is meant.
    let reply = hover(&mut server, "+/:", 0);
    let value = reply["contents"]["value"].as_str().unwrap();
    assert!(value.starts_with("x+y\n\nx plus y"), "{value}");
    assert!(value.ends_with("https://code.kx.com/q/ref/add/"), "{value}");
    assert_eq!(span(&reply["range"]), (0, 3, 4));
    let reply = hover(&mut server, "/:", 1);
    assert!(
        reply["contents"]["value"]
            .as_str()
            .unwrap()
            .starts_with("x f/: y\n\nEach right")
    );
    assert_eq!(span(&reply["range"]), (0, 4, 6));
    assert!(
        hover(&mut server, "_ys", 0)["contents"]["value"]
            .as_str()
            .unwrap()
            .starts_with("x _ y")
    );
    assert_eq!(span(&hover(&mut server, "<=", 0)["range"]), (2, 3, 5));
}
