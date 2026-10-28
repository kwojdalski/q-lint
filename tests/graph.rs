//! `qlinter analyze graph`: which files a q file depends on, read from the
//! names it uses and the scripts it loads, and never by running anything.

use q_lint_rs::graph::{Node, build};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// The graph of in-memory files, keyed and valued by their bare names. The
/// paths are under a directory that does not exist, so nothing is read.
fn graph(files: &[(&str, &str)], symbols: bool) -> BTreeMap<String, Node> {
    let root = Path::new("/no-such-root");
    let sources: Vec<(PathBuf, String)> = files
        .iter()
        .map(|(name, text)| (root.join(name), text.to_string()))
        .collect();
    build(&sources, symbols, root)
        .into_iter()
        .map(|(p, node)| (p.strip_prefix(root).unwrap().display().to_string(), node))
        .collect()
}

fn deps(g: &BTreeMap<String, Node>, file: &str) -> Vec<String> {
    g[file]
        .dependencies
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect()
}

fn kinds(g: &BTreeMap<String, Node>, file: &str) -> Vec<(usize, &'static str)> {
    g[file].dynamic.iter().map(|d| (d.line, d.kind)).collect()
}

#[test]
fn a_qualified_reference_is_an_edge_to_its_definer() {
    let g = graph(
        &[("lib.q", ".lib.f:{x+1}\n"), ("app.q", "g:{.lib.f x}\n")],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["lib.q"]);
    assert!(deps(&g, "lib.q").is_empty());
}

#[test]
fn a_bare_name_inside_a_context_is_qualified_by_it() {
    let g = graph(
        &[
            ("lib.q", "\\d .lib\nf:{x+1}\n"),
            ("app.q", "\\d .lib\ng:{f x}\n"),
            // The same bare name at the root means `f`, which nobody defines.
            ("root.q", "h:{f x}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["lib.q"]);
    assert!(deps(&g, "root.q").is_empty());
}

#[test]
fn a_bare_name_inside_a_context_does_not_fall_back_to_the_root() {
    // q 5: after `f:{42}`, `\d .a`, `g:{f[]}`, calling `.a.g[]` is 'f.
    let g = graph(
        &[
            ("util.q", "helper:{x}\n"),
            ("app.q", "\\d .app\ng:{helper x}\n"),
            // At the root the same read is the root's own name.
            ("root.q", "g:{helper x}\n"),
        ],
        false,
    );
    assert!(deps(&g, "app.q").is_empty());
    assert_eq!(deps(&g, "root.q"), ["util.q"]);
}

#[test]
fn a_root_name_is_not_the_dotted_name_of_the_same_spelling() {
    // q 5: after `.h2:7`, `value "h2"` is 'h2; after `h3:5`, `value ".h3"`
    // is '.h3. Each read reaches only the file defining its own spelling.
    let g = graph(
        &[
            ("dot.q", ".g:7\n"),
            ("bare.q", "g:1\n"),
            ("bare_read.q", "r:g+1\n"),
            ("dot_read.q", "r:.g+1\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "bare_read.q"), ["bare.q"]);
    assert!(g["bare_read.q"].ambiguous.is_empty());
    assert_eq!(deps(&g, "dot_read.q"), ["dot.q"]);
}

#[test]
fn system_d_and_a_commented_backslash_d_open_a_context() {
    // q 5: after `system "d .b"` and `k:{1}`, `key `.b` is ``k; after
    // `\d .c  / note` and `m:1`, `key `.c` is ``m.
    let g = graph(
        &[
            ("sys.q", "system \"d .b\"\nk:{1}\nsystem \"d .\"\n"),
            ("note.q", "\\d .c  / note\nm:1\n\\d .\n"),
            ("root.q", "k:{2}\nm:2\n"),
            ("app.q", "r:{.b.k[] + .c.m}\n"),
            ("bare.q", "r:{k[] + m}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["note.q", "sys.q"]);
    assert_eq!(deps(&g, "bare.q"), ["root.q"]);
}

#[test]
fn a_nested_context_qualifies_with_its_whole_path() {
    let g = graph(
        &[
            ("lib.q", "\\d .a.b\nf:{x}\n"),
            ("near.q", "\\d .a.b\ng:{f x}\n"),
            // `.a` is not `.a.b`: `f` there is `.a.f`.
            ("far.q", "\\d .a\ng:{f x}\n"),
            ("full.q", "g:{.a.b.f x}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "near.q"), ["lib.q"]);
    assert!(deps(&g, "far.q").is_empty());
    assert_eq!(deps(&g, "full.q"), ["lib.q"]);
}

#[test]
fn a_locals_name_is_not_a_read_of_the_global() {
    let g = graph(
        &[("lib.q", "f:{x}\n"), ("app.q", "g:{[f] f+1}\nh:{f:2; f}\n")],
        false,
    );
    assert!(deps(&g, "app.q").is_empty());
}

#[test]
fn a_file_path_or_symbol_reads_none_of_the_names_inside_it() {
    // q 5 reads each as one symbol: `:` runs on anywhere, `/` after `` `: ``.
    let g = graph(
        &[
            ("lib.q", "trade:1\nsym:`a\nhdb:2\nb:3\n"),
            (
                "app.q",
                "r:`:trade.csv\ns:get `:hdb/sym\nhdel `:hdb/2024.01.01/trade/\nt:`a:b\n",
            ),
            // A symbol handed to `get` still names the global it reads.
            ("get.q", "r:get `trade\n"),
        ],
        false,
    );
    assert!(deps(&g, "app.q").is_empty());
    assert_eq!(deps(&g, "get.q"), ["lib.q"]);
}

#[test]
fn a_key_of_a_defined_dictionary_reaches_its_definer() {
    let g = graph(
        &[
            ("cfg.q", ".cfg.opts:`port`host!(1;`h)\n"),
            ("app.q", "p:{.cfg.opts.port}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["cfg.q"]);
}

#[test]
fn a_name_several_files_define_is_an_edge_to_each_and_listed() {
    let g = graph(
        &[
            ("one.q", "init:{1}\n"),
            ("two.q", "init:{2}\n"),
            ("app.q", "go:{init[]}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["one.q", "two.q"]);
    let definers: Vec<_> = g["app.q"].ambiguous["init"]
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(definers, ["one.q", "two.q"]);
    // One definer and no doubt: nothing is listed.
    assert!(g["one.q"].ambiguous.is_empty());
}

#[test]
fn a_file_that_defines_a_name_itself_still_depends_on_another_definer() {
    let g = graph(
        &[
            ("one.q", "init:{1}\ngo:{init[]}\n"),
            ("two.q", "init:{2}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "one.q"), ["two.q"]);
    assert_eq!(g["one.q"].ambiguous["init"].len(), 2);
}

#[test]
fn dynamic_access_is_listed_and_not_guessed() {
    let source = "\
a:{value \"1+1\"}
b:{get x}
c:{(` sv `a`b) set 1}
d:{y set 1}
e:{system \"l \",x}
";
    let g = graph(&[("dyn.q", source)], false);
    assert_eq!(
        kinds(&g, "dyn.q"),
        [
            (1, "value"),
            (2, "get"),
            (3, "set"),
            (3, "sv"),
            (4, "set"),
            (5, "load")
        ]
    );
}

#[test]
fn literal_targets_and_file_access_are_not_dynamic() {
    let source = "\
`.a.b set 1
set[`.a.c;2]
(`:data/t) set t
(hsym `t) set t
x:get `:data/t
y:get hsym `t
z:get `.a.b
w:` sv `:dir`file
v:value d
u:{value \"1\"}
";
    let g = graph(&[("static.q", source)], false);
    // Only the string handed to `value` is out of reach.
    assert_eq!(kinds(&g, "static.q"), [(10, "value")]);
}

#[test]
fn a_symbol_handed_to_get_is_a_read() {
    let g = graph(
        &[("lib.q", ".lib.x:1\n"), ("app.q", "f:{get `.lib.x}\n")],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["lib.q"]);
}

#[test]
fn symbol_literals_count_only_with_symbols() {
    let files = [
        ("lib.q", ".lib.cb:{x}\n"),
        ("app.q", ".reg.add[`.lib.cb]\n"),
    ];
    assert!(deps(&graph(&files, false), "app.q").is_empty());
    assert_eq!(deps(&graph(&files, true), "app.q"), ["lib.q"]);
}

#[test]
fn a_name_in_a_string_or_comment_is_not_a_read() {
    let g = graph(
        &[
            ("lib.q", ".lib.f:{x}\n"),
            ("app.q", "/ calls .lib.f\ng:{\"see .lib.f\"} / .lib.f\n"),
        ],
        false,
    );
    assert!(deps(&g, "app.q").is_empty());
}

#[test]
fn a_literal_load_is_an_edge() {
    let g = graph(
        &[
            ("src/util.q", "k:1\n"),
            ("src/app.q", "\\l util.q\n"),
            // Resolved against a directory above the file, as q run from the
            // repository's root would.
            ("src/deep/app.q", "system \"l src/util.q\"\n"),
            ("src/none.q", "\\l missing.q\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "src/app.q"), ["util.q"]);
    assert_eq!(deps(&g, "src/deep/app.q"), ["util.q"]);
    assert!(deps(&g, "src/none.q").is_empty());
}

#[test]
fn a_file_symbol_naming_a_script_is_a_load_whatever_takes_it() {
    let g = graph(
        &[
            ("src/util.q", "k:1\n"),
            // A project's own loader, the way automl writes it.
            ("src/deep/app.q", "loadfile`:src/util.q\n"),
            // Not a script, in a string, in a comment, or not ending at `.q`.
            (
                "src/other.q",
                "r:`:src/util.qd\ns:\"`:src/util.q\"\nt:1 / `:src/util.q\nu:`:src/util.q/x\n",
            ),
        ],
        false,
    );
    assert_eq!(deps(&g, "src/deep/app.q"), ["util.q"]);
    assert!(deps(&g, "src/other.q").is_empty());
}

// The command line.

fn qlinter(cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(cwd)
        .env("XDG_CONFIG_HOME", cwd.join("no-such-config-home"))
        .args(args)
        .output()
        .unwrap()
}

fn tree() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (rel, text) in [
        ("src/lib/a.q", "\\d .a\nf:{x+1}\n\\d .\ninit:{1}\n"),
        ("src/lib/b.q", "init:{2}\n.b.g:{.a.f x}\n"),
        (
            "src/app.q",
            "\\l src/lib/c.q\n\\d .a\nr:{f[x]+.b.g x}\n\\d .\ns:{init[]}\nt:{get x}\nreg:`.b.g\n",
        ),
        ("src/lib/c.q", "k:1\n"),
        ("README.md", "not q\n"),
    ] {
        let path = dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    dir
}

fn stdout(out: &std::process::Output) -> String {
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout.clone()).unwrap()
}

#[test]
fn the_graph_prints_files_and_their_dependencies() {
    let dir = tree();
    let out = stdout(&qlinter(dir.path(), &["analyze", "graph", "src"]));
    assert_eq!(
        out,
        r#"{
  "src/app.q": [
    "src/lib/a.q",
    "src/lib/b.q",
    "src/lib/c.q"
  ],
  "src/lib/a.q": [],
  "src/lib/b.q": [
    "src/lib/a.q"
  ],
  "src/lib/c.q": []
}
"#
    );
}

#[test]
fn the_graph_prints_dependents_with_detail() {
    let dir = tree();
    let out = stdout(&qlinter(
        dir.path(),
        &[
            "analyze",
            "graph",
            "--direction",
            "dependents",
            "--detail",
            "--symbols",
            "src",
        ],
    ));
    let found: serde_json::Value = serde_json::from_str(&out).unwrap();
    let expected = serde_json::json!({
        "src/app.q": {"dependents": [], "ambiguous": {"init": ["src/lib/a.q", "src/lib/b.q"]},
                      "dynamic": [{"line": 6, "kind": "get"}]},
        // A file that defines `init` but never reads it has no doubt to list.
        "src/lib/a.q": {"dependents": ["src/app.q", "src/lib/b.q"], "ambiguous": {}, "dynamic": []},
        "src/lib/b.q": {"dependents": ["src/app.q"], "ambiguous": {}, "dynamic": []},
        "src/lib/c.q": {"dependents": ["src/app.q"], "ambiguous": {}, "dynamic": []},
    });
    assert_eq!(found, expected);
}

#[test]
fn paths_are_relative_to_the_current_directory() {
    let dir = tree();
    let out = stdout(&qlinter(
        &dir.path().join("src/lib"),
        &["analyze", "graph", "c.q", "../app.q"],
    ));
    let found: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(found, serde_json::json!({"../app.q": ["c.q"], "c.q": []}));
}

#[test]
fn exclude_leaves_files_out_of_the_graph() {
    let dir = tree();
    let out = stdout(&qlinter(
        dir.path(),
        &["analyze", "graph", "--exclude", "src/lib/c.q", "src"],
    ));
    let found: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(found.get("src/lib/c.q").is_none());
    assert_eq!(
        found["src/app.q"],
        serde_json::json!(["src/lib/a.q", "src/lib/b.q"])
    );
}

#[test]
fn linting_paths_explain_and_lsp_are_unchanged_by_the_subcommand() {
    let dir = tree();
    // A path is still linted, flags before or after it.
    let out = qlinter(dir.path(), &["--format", "json", "src/lib/c.q"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "[]");
    let out = qlinter(dir.path(), &["src/lib/c.q", "--format", "json"]);
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "[]");
    // A directory named like the subcommand is linted when spelled as a path.
    fs::create_dir(dir.path().join("analyze")).unwrap();
    fs::write(dir.path().join("analyze/x.q"), "k:1\n").unwrap();
    let out = qlinter(dir.path(), &["--format", "json", "./analyze"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "[]");
    // `help` is still a path, not a subcommand.
    let out = qlinter(dir.path(), &["help"]);
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("Path does not exist: help"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    // --explain still answers.
    let out = qlinter(dir.path(), &["--explain", "QF005"]);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("QF005 "));
    // --lsp still refuses paths beside it, as before.
    let out = qlinter(dir.path(), &["--lsp", "src"]);
    assert_eq!(out.status.code(), Some(2));
    // A lint flag after the subcommand is refused, not ignored.
    let out = qlinter(dir.path(), &["analyze", "graph", "--fix", "src"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--fix"));
}

#[test]
fn the_language_server_still_starts_and_exits() {
    use std::io::Write;
    let dir = tree();
    let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .arg("--lsp")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let send = |stdin: &mut std::process::ChildStdin, body: &str| {
        write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    };
    let stdin = child.stdin.as_mut().unwrap();
    send(
        stdin,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#,
    );
    send(stdin, r#"{"jsonrpc":"2.0","id":2,"method":"shutdown"}"#);
    send(stdin, r#"{"jsonrpc":"2.0","method":"exit"}"#);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("capabilities"));
}
