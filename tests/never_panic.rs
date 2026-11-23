//! No input makes qlinter panic. Every q source in this tree - the examples,
//! the corpus fixtures and each case body - is mutated the way a half-typed
//! edit leaves it (a token deleted, duplicated or swapped, the text cut
//! short, a bracket, quote or comment marker dropped in), and each variant
//! is put through the library's entry points and through the language
//! server as an editor drives it. An editor lints on every keystroke, so
//! every one of these states is one a user will reach.
//!
//! The mutations are drawn from a fixed seed, so a failure names a variant
//! that fails again on the next run. `cargo test` runs a sample sized for a
//! debug build; the full sweep is `#[ignore]`d and CI runs it in release:
//!
//! ```sh
//! cargo test --release --test never_panic -- --ignored
//! ```
use q_lint_rs::{
    Workspace, applied, argument_slots, balanced, bracket_calls, broken_statement, call_at,
    comment_above, completing, explain_qsql, extract, file_suppression_for, fix_all, fixes_for,
    folds, functional_to_qsql, glyph_at, index, lint_every_rule, load_at, load_paths, mentions,
    name_at, qsql_layout_at, qsql_layouts, qsql_to_functional, references, rename, rename_target,
    selection_ranges, semantic_tokens, suppression_for, typed_locals, word_at,
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    process::{Child, Command, Stdio},
    sync::mpsc::{Receiver, channel},
    time::Duration,
};

/// The lines in each window a long file is cut into.
const WINDOW: usize = 40;

/// Each q source in the tree, by a name a failure can point at: a whole
/// file, a window of one, or a case body.
fn sources() -> Vec<(String, String)> {
    let root = env!("CARGO_MANIFEST_DIR");
    let mut found = vec![];
    for dir in ["examples", "tests/corpus"] {
        let mut paths: Vec<_> = std::fs::read_dir(format!("{root}/{dir}"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "q"))
            .collect();
        paths.sort();
        for path in paths {
            let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
            let name = format!("{dir}/{}", path.file_name().unwrap().to_string_lossy());
            // A long file in windows of lines too: a debug build lints the
            // 1,000-line showcase in about a second, and a mutation's effect
            // is mostly local, so most of the sweep mutates the windows.
            let lines: Vec<&str> = text.split_inclusive('\n').collect();
            for (k, window) in lines.chunks(WINDOW).enumerate() {
                let first = k * WINDOW + 1;
                let last = first + window.len() - 1;
                found.push((format!("{name}:{first}-{last}"), window.concat()));
            }
            if lines.len() > WINDOW {
                found.push((name, text));
            }
        }
    }
    let mut cases: Vec<_> = std::fs::read_dir(format!("{root}/tests/cases"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "cases"))
        .collect();
    cases.sort();
    for path in cases {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let mut body: Option<(usize, String)> = None;
        for (i, line) in std::fs::read_to_string(&path).unwrap().lines().enumerate() {
            if line.starts_with("=== ") {
                if let Some((at, text)) = body.take() {
                    found.push((format!("tests/cases/{name}:{at}"), text));
                }
                body = Some((i + 1, String::new()));
            } else if let Some((_, text)) = body.as_mut() {
                text.push_str(line);
                text.push('\n');
            }
        }
        if let Some((at, text)) = body {
            found.push((format!("tests/cases/{name}:{at}"), text));
        }
    }
    found
}

/// splitmix64: small, and the same sequence on every platform.
struct Rng(u64);

impl Rng {
    fn seeded(name: &str) -> Self {
        // FNV-1a of the name, so each source has its own stream and adding
        // a case moves no other source's mutations.
        Self(name.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
            (h ^ b as u64).wrapping_mul(0x100_0000_01b3)
        }))
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

/// Byte ranges of `text`'s tokens: a run of name or number characters, a run
/// of blanks, or any other single character.
fn tokens(text: &str) -> Vec<(usize, usize)> {
    let word = |c: char| c.is_alphanumeric() || c == '_' || c == '.';
    let mut out: Vec<(usize, usize)> = vec![];
    let mut chars = text.char_indices().peekable();
    while let Some((start, c)) = chars.next() {
        let mut end = start + c.len_utf8();
        let same: Option<fn(char) -> bool> = if word(c) {
            Some(|c| c.is_alphanumeric() || c == '_' || c == '.')
        } else if c == ' ' || c == '\t' {
            Some(|c| c == ' ' || c == '\t')
        } else {
            None
        };
        if let Some(same) = same {
            while let Some(&(at, d)) = chars.peek() {
                if !same(d) {
                    break;
                }
                end = at + d.len_utf8();
                chars.next();
            }
        }
        out.push((start, end));
    }
    out
}

/// What a half-made edit drops in. A line holding only `/` opens a block
/// comment and one holding only `\` ends the script, so both are here.
const INSERTS: &[&str] = &[
    "[", "]", "(", ")", "{", "}", "\"", "`", ";", ":", "'", "/", "\\", "\n", "\n/\n", "\n\\\n",
    "-", "0N", "`:", " /", "$[", "select ", " from ", " where ", "\r\n",
];

/// The `n` mutants of `text` its seed gives.
fn mutants(name: &str, text: &str, n: usize) -> Vec<String> {
    let toks = tokens(text);
    let boundaries: Vec<usize> = text
        .char_indices()
        .map(|(i, _)| i)
        .chain([text.len()])
        .collect();
    let mut rng = Rng::seeded(name);
    let mut out = Vec::with_capacity(n);
    for k in 0..n {
        let mut s = text.to_string();
        // Cycle the operators, so even a sample of one per source tries each
        // across the tree.
        match (k + rng.below(5)) % 5 {
            0 if !toks.is_empty() => {
                let (a, b) = toks[rng.below(toks.len())];
                s.replace_range(a..b, "");
            }
            1 if !toks.is_empty() => {
                let (a, b) = toks[rng.below(toks.len())];
                s.insert_str(b, &text[a..b]);
            }
            2 if toks.len() > 1 => {
                let i = rng.below(toks.len() - 1);
                let ((a, b), (c, d)) = (toks[i], toks[i + 1]);
                s = format!("{}{}{}{}", &text[..a], &text[c..d], &text[a..b], &text[d..]);
            }
            3 => s.truncate(boundaries[rng.below(boundaries.len())]),
            _ => {
                let at = boundaries[rng.below(boundaries.len())];
                s.insert_str(at, INSERTS[rng.below(INSERTS.len())]);
            }
        }
        out.push(s);
    }
    out
}

/// Every library entry point an editor or the CLI reaches, over `src`.
fn exercise(src: &str) {
    let ws = Workspace::default();
    // `false` lints on although the brackets do not balance, as a client
    // that suppresses QE001 asks for: every rule then reads broken structure.
    let findings = lint_every_rule(src, "m.q", &ws, true);
    lint_every_rule(src, "m.q", &ws, false);
    fixes_for(&findings, src);
    for f in findings.iter().take(8) {
        suppression_for(f, src);
        file_suppression_for(f, src);
    }
    // The fixes `--fix` and Format Document apply, to a fixed point; the
    // rest are offered one at a time, which `fixes_for` above covers. The
    // first pass lints `src` again, so it is handed the findings already made.
    let mut first = Some(findings);
    let _ = fix_all(src, false, |s| {
        Ok::<_, ()>(
            first
                .take()
                .unwrap_or_else(|| lint_every_rule(s, "m.q", &ws, true)),
        )
    });
    semantic_tokens(src);
    folds(src);
    index(src);
    references(src, true);
    mentions(src);
    balanced(src);
    broken_statement(src);
    qsql_layouts(src, 80);
    typed_locals(src);
    bracket_calls(src);
    argument_slots(src);
    load_paths(src);
    // Positions at both ends, the middle and a few spread between, on
    // character boundaries, as a cursor can only be.
    let bounds: Vec<usize> = src
        .char_indices()
        .map(|(i, _)| i)
        .chain([src.len()])
        .collect();
    let picks: Vec<usize> = (0..=6)
        .map(|k| bounds[(bounds.len() - 1) * k / 6])
        .collect();
    for &at in &picks {
        name_at(src, at);
        word_at(src, at);
        call_at(src, at);
        completing(src, at);
        selection_ranges(src, at);
        glyph_at(src, at);
        load_at(src, at);
        explain_qsql(src, at);
        qsql_to_functional(src, at);
        functional_to_qsql(src, at);
        let _ = rename_target(src, at);
        let _ = rename(src, at, "zz");
        applied(src, at);
        comment_above(src, at);
        qsql_layout_at(src, at, 40);
    }
    for pair in picks.windows(2) {
        let _ = extract(src, pair[0], pair[1]);
    }
}

/// Each variant `check` panics on, with the panic's message.
fn survey(variants: &[(String, String)], check: impl Fn(&str) + Sync) -> Vec<String> {
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get());
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let check = &check;
                // Interleaved, so the slow variants of one long file are not
                // all one thread's.
                scope.spawn(move || {
                    let mut failed = vec![];
                    for (name, text) in variants.iter().skip(t).step_by(threads) {
                        if let Err(payload) = catch_unwind(AssertUnwindSafe(|| check(text))) {
                            let message = payload
                                .downcast_ref::<&str>()
                                .map(|s| s.to_string())
                                .or_else(|| payload.downcast_ref::<String>().cloned())
                                .unwrap_or_default();
                            failed.push(format!("{name}: {message}\n    source: {text:?}"));
                        }
                    }
                    failed
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect()
    })
}

/// Every source's mutants - `per_case` for a case body, `per_window` for a
/// window of a long file or a short file whole, and `per_file` for a long
/// file whole - named by source and number.
fn variants(per_case: usize, per_window: usize, per_file: usize) -> Vec<(String, String)> {
    let mut out = vec![];
    for (name, text) in sources() {
        let n = if name.starts_with("tests/cases/") {
            per_case
        } else if name.contains(".q:") {
            per_window
        } else {
            per_file
        };
        for (k, m) in mutants(&name, &text, n).into_iter().enumerate() {
            out.push((format!("{name} #{k}"), m));
        }
    }
    out
}

fn assert_none_panic(variants: &[(String, String)]) {
    let failed = survey(variants, exercise);
    assert!(
        failed.is_empty(),
        "{} of {} variants panicked:\n{}",
        failed.len(),
        variants.len(),
        failed.join("\n")
    );
}

#[test]
fn mutated_sources_lint_without_panicking() {
    // Every third case, to keep a debug build near half a minute on four
    // cores; the ignored sweep below takes every case, many times over.
    let variants: Vec<_> = variants(1, 4, 0)
        .into_iter()
        .enumerate()
        .filter(|(i, (name, _))| !name.starts_with("tests/cases/") || i % 3 == 0)
        .map(|(_, v)| v)
        .collect();
    assert!(variants.len() > 700, "found {} variants", variants.len());
    assert_none_panic(&variants);
}

/// The full sweep, too slow for a debug build: CI runs it in release.
#[test]
#[ignore]
fn every_mutation_lints_without_panicking() {
    assert_none_panic(&variants(12, 100, 10));
}

/// Sources the sweep once found a panic on, each kept as it was found.
const FOUND: &[(&str, &str)] = &[
    // QB008 (`=` against a vector literal in a filter) read the `where` phrase from the whole
    // statement and its bracket groups from the line alone.
    (
        "tests/cases/correctness.cases:225 #12",
        "r(:select from t where a=1 2 3?b\ns:select from t where a=0 1 2 b\nu:select from t where a=`x`y`z?s\nv:select from t where a=1 2 3[0]\nw:select from t where s=`x`y`z[1], a>0\n\n",
    ),
    (
        "examples/showcase.q:401-440 #162",
        "\n/ QF020: quotes has no size column, and nothing in this file defines one, so\n/ q raises 'size. The column it does have selects fine.\nquotes:([]px:1 2)\n/ expect-next: QF020\nsized:select size from quotes\npriced:select px fr$[om quotes\n/ The where phrase and xasc name columns too.\n/ expect-next: QF020\nbigones:select from quotes where size>100\n/ expect-next: QF020\nbysize:`size xasc quotes\n\n/ QT026: lj joins on the right table's key, so an unkeyed one is 'type.\n/ expect-next: QT026\njoined:quotes lj ([]px:1 2;venue:`a`b)\njoinedk:quotes lj ([px:1 2]venue:`a`b)\n\n/ QT027: insert takes one value per column, and quotes has one.\n/ expect-next: QT027\n`quotes insert (1;2)\n/ QT005: keyed is no different.\n/ expect-next: QT005\none2: ([k:1] v:2)\n\n/ QT006: two literal vectors under an infix must agree in length.\n/ expect-next: QT006\nbad3: 1 2 3+4 5\n\n/ QT006: symbol vectors under `=` likewise - two against three.\n/ expect-next: QT006\nbad4: `a`b=`a`b`c\n\n/ QT007: `ssr` is a string function and a symbol is a 'type error. `trim`\n/ and `lower` accept symbols, and stay quiet.\n/ expect-next: QT007\nsub: ssr[`abc;\"a\";\"b\"]\n\n/ QT007: infix `ss` with a symbol on the left.\n/ expect-next: QT007\n",
    ),
    // QB011 (a control statement assigned) took the text between an `if[`'s `]`
    // and the `)` before it.
    (
        "tests/cases/correctness.cases:386 #16",
        "a:(if[1b;2)]\nb::if[1b;2]\n\n",
    ),
];

#[test]
fn what_the_sweep_found_stays_fixed() {
    let variants: Vec<_> = FOUND
        .iter()
        .map(|(name, text)| (name.to_string(), text.to_string()))
        .collect();
    assert_none_panic(&variants);
}

#[test]
fn the_mutations_are_the_same_on_every_run() {
    let text = "f:{[a;b] select x from t where a>b}\n";
    assert_eq!(mutants("s", text, 20), mutants("s", text, 20));
    assert_ne!(mutants("s", text, 20), mutants("t", text, 20));
    // Every operator is used, and none leaves a broken character behind.
    let made = mutants("s", "a:\"\u{e9}\u{1F600}\" / x\n", 200);
    assert!(made.iter().any(|m| m.len() < 10));
    assert!(made.iter().any(|m| m.len() > 16));
}

#[test]
fn a_planted_panic_is_caught_and_named() {
    let variants = vec![
        ("fine".to_string(), "a:1\n".to_string()),
        ("planted".to_string(), "a:1;BOOM\n".to_string()),
    ];
    let failed = survey(&variants, |s| {
        exercise(s);
        if s.contains("BOOM") {
            panic!("rule broke on {}", s.len());
        }
    });
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert!(
        failed[0].starts_with("planted: rule broke on 9"),
        "{failed:?}"
    );
}

/// A server's messages, framed as LSP frames them, until it closes stdout.
fn read_messages(stdout: impl Read + Send + 'static) -> Receiver<Value> {
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

/// Whether a server message reports a panic it caught: an internal error
/// in reply to a request, or the diagnostic a document gets when its lint
/// panicked.
fn reports_a_panic(message: &Value) -> bool {
    message["error"]["code"] == -32603
        || message["params"]["diagnostics"]
            .as_array()
            .is_some_and(|d| {
                d.iter().any(|d| {
                    d["message"]
                        .as_str()
                        .is_some_and(|m| m.starts_with("qlinter failed on this document"))
                })
            })
}

#[test]
fn a_caught_panic_is_recognised_in_what_the_server_sends() {
    assert!(reports_a_panic(
        &json!({"id": 3, "error": {"code": -32603, "message": "x"}})
    ));
    assert!(reports_a_panic(
        &json!({"method": "textDocument/publishDiagnostics",
        "params": {"uri": "file:///m.q", "diagnostics": [{"message":
        "qlinter failed on this document and reports nothing else for it: boom"}]}})
    ));
    assert!(!reports_a_panic(&json!({"id": 3, "result": null})));
    assert!(!reports_a_panic(
        &json!({"method": "textDocument/publishDiagnostics",
        "params": {"uri": "file:///m.q", "diagnostics": [{"message": "QF001"}]}})
    ));
}

/// An LSP position: the line and its UTF-16 offset.
fn position(text: &str, at: usize) -> Value {
    let before = &text[..at];
    let line = before.matches('\n').count();
    let start = before.rfind('\n').map_or(0, |i| i + 1);
    let character: usize = before[start..].chars().map(char::len_utf16).sum();
    json!({"line": line, "character": character})
}

/// The requests an editor sends for an open document, at `at`.
fn requests(uri: &str, text: &str, at: usize) -> Vec<(&'static str, Value)> {
    let doc = json!({"uri": uri});
    let pos = position(text, at);
    let whole = json!({"start": {"line": 0, "character": 0}, "end": position(text, text.len())});
    let lines = text.matches('\n').count() + 1;
    vec![
        (
            "textDocument/hover",
            json!({"textDocument": doc, "position": pos}),
        ),
        (
            "textDocument/signatureHelp",
            json!({"textDocument": doc, "position": pos}),
        ),
        (
            "textDocument/completion",
            json!({"textDocument": doc, "position": pos}),
        ),
        (
            "textDocument/definition",
            json!({"textDocument": doc, "position": pos}),
        ),
        (
            "textDocument/references",
            json!({"textDocument": doc, "position": pos,
            "context": {"includeDeclaration": true}}),
        ),
        (
            "textDocument/documentHighlight",
            json!({"textDocument": doc, "position": pos}),
        ),
        (
            "textDocument/prepareRename",
            json!({"textDocument": doc, "position": pos}),
        ),
        (
            "textDocument/rename",
            json!({"textDocument": doc, "position": pos, "newName": "zz"}),
        ),
        (
            "textDocument/prepareCallHierarchy",
            json!({"textDocument": doc, "position": pos}),
        ),
        (
            "textDocument/selectionRange",
            json!({"textDocument": doc, "positions": [pos]}),
        ),
        ("textDocument/documentSymbol", json!({"textDocument": doc})),
        ("textDocument/foldingRange", json!({"textDocument": doc})),
        (
            "textDocument/semanticTokens/full",
            json!({"textDocument": doc}),
        ),
        ("textDocument/documentLink", json!({"textDocument": doc})),
        ("textDocument/codeLens", json!({"textDocument": doc})),
        (
            "textDocument/inlayHint",
            json!({"textDocument": doc, "range": whole}),
        ),
        (
            "textDocument/formatting",
            json!({"textDocument": doc,
            "options": {"tabSize": 2, "insertSpaces": true}}),
        ),
        (
            "textDocument/codeAction",
            json!({"textDocument": doc, "range": whole,
            "context": {"diagnostics": []}}),
        ),
        (
            "textDocument/codeAction",
            json!({"textDocument": doc,
            "range": {"start": pos, "end": pos}, "context": {"diagnostics": []}}),
        ),
        (
            "q-lint/formatChangedLines",
            json!({"textDocument": doc,
            "lines": [[0, lines]]}),
        ),
    ]
}

/// A server that is waited for however the session ends, so a failure
/// leaves no process behind.
struct Reaped(Child);

impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// `variants` opened in one server, each asked every request an editor
/// sends; what the server reported as a caught panic, or that it died.
fn serve_variants(variants: &[(String, String)]) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Reaped(
        Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(dir.path())
            .env("XDG_CONFIG_HOME", dir.path().join("no-such-config-home"))
            .args(["--lsp", "--profile", "uqf"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn qlinter --lsp"),
    );
    let mut stdin = child.0.stdin.take().unwrap();
    let messages = read_messages(child.0.stdout.take().unwrap());
    let mut send = |value: Value| {
        let body = serde_json::to_vec(&value).unwrap();
        write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        stdin.write_all(&body).unwrap();
        stdin.flush().unwrap();
    };
    let wait = Duration::from_secs(60);
    let mut failed = vec![];
    let mut id = 0;
    // Every feature on, the ones that start off included, so each handler
    // is reached.
    let on = json!({"enable": true});
    send(
        json!({"jsonrpc": "2.0", "id": id, "method": "initialize", "params": {
        "capabilities": {"textDocument": {"codeAction": {"codeActionLiteralSupport": {
            "codeActionKind": {"valueSet": ["quickfix", "refactor", "source"]}}},
            "documentSymbol": {"hierarchicalDocumentSymbolSupport": true}}},
        "initializationOptions": {"completion": on, "codeLens": on, "referenceLens": on,
            "selectionRange": on, "relatedInformation": on, "formatChangedLines": on,
            "autoLoad": on, "qsqlLayout": {"enable": true, "onFormat": true, "lineLength": 40}}}}),
    );
    let awaiting = |id: u64, failed: &mut Vec<String>, name: &str, uri: Option<&str>| {
        // Read until the reply to `id`, and the document's diagnostics when
        // `uri` is given, noting any panic the server reports on the way.
        let mut replied = false;
        let mut diagnosed = uri.is_none();
        while !(replied && diagnosed) {
            let Ok(message) = messages.recv_timeout(wait) else {
                failed.push(format!("{name}: the server stopped answering"));
                return false;
            };
            if reports_a_panic(&message) {
                failed.push(format!("{name}: {message}"));
            }
            replied |= message["id"] == id && message.get("method").is_none();
            diagnosed |= message["method"] == "textDocument/publishDiagnostics"
                && message["params"]["uri"].as_str() == uri;
        }
        true
    };
    if !awaiting(id, &mut failed, "initialize", None) {
        return failed;
    }
    send(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}));
    for (n, (name, text)) in variants.iter().enumerate() {
        let uri = format!("file:///mutant{n}.q");
        send(
            json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "q", "version": 1, "text": text}}}),
        );
        let at = text
            .char_indices()
            .map(|(i, _)| i)
            .nth(text.chars().count() / 2)
            .unwrap_or(text.len());
        for (method, params) in requests(&uri, text, at) {
            id += 1;
            send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        }
        let alive = awaiting(id, &mut failed, name, Some(&uri));
        send(json!({"jsonrpc": "2.0", "method": "textDocument/didClose",
            "params": {"textDocument": {"uri": uri}}}));
        if !alive {
            return failed;
        }
    }
    id += 1;
    send(json!({"jsonrpc": "2.0", "id": id, "method": "shutdown"}));
    awaiting(id, &mut failed, "shutdown", None);
    send(json!({"jsonrpc": "2.0", "method": "exit"}));
    let _ = child.0.wait();
    failed
}

fn assert_none_panic_in_the_server(variants: &[(String, String)]) {
    let failed = serve_variants(variants);
    assert!(
        failed.is_empty(),
        "the server panicked on {} of {} variants:\n{}",
        failed.len(),
        variants.len(),
        failed.join("\n")
    );
}

#[test]
fn mutated_sources_serve_without_panicking() {
    // A slice of the variants: a whole file's mutants, and every hundredth
    // case's, so each source kind is covered without the full set's time.
    let all = variants(1, 2, 0);
    let sample: Vec<_> = all
        .into_iter()
        .enumerate()
        .filter(|(i, (name, _))| !name.starts_with("tests/cases/") || i % 100 == 0)
        .map(|(_, v)| v)
        .collect();
    assert_none_panic_in_the_server(&sample);
}

#[test]
#[ignore]
fn every_mutation_serves_without_panicking() {
    assert_none_panic_in_the_server(&variants(2, 20, 2));
}
