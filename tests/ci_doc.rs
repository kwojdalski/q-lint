//! `docs/ci.md`'s commands, run as written. The baseline walkthrough is
//! the part of the guide a reader follows step by step on their own tree, so
//! each `qlinter` line of its shell blocks, and its configuration, is taken
//! from the document itself rather than restated here. The YAML snippets
//! are checked against the action and the hooks by `tests/test_packaging.py`.
use std::{path::Path, process::Command};

/// The guide with LF line ends, as a Windows checkout may have made them CRLF.
static DOC: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| include_str!("../docs/ci.md").replace("\r\n", "\n"));

/// The bodies of the document's fenced blocks in `language`.
fn blocks(language: &str) -> Vec<&'static str> {
    let doc: &'static str = &DOC;
    doc.split(&format!("```{language}\n"))
        .skip(1)
        .map(|rest| rest.split("```").next().unwrap())
        .collect()
}

/// `qlinter` with the words of a documented command line, in `dir`.
fn run(dir: &Path, line: &str) -> (i32, String) {
    let mut words = line.split_whitespace();
    assert_eq!(words.next(), Some("qlinter"), "{line}");
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir)
        .env("XDG_CONFIG_HOME", dir.join("no-such-config-home"))
        .args(words)
        .output()
        .unwrap();
    (
        out.status.code().unwrap(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    )
}

fn command(starting: &str) -> &'static str {
    blocks("sh")
        .into_iter()
        .flat_map(str::lines)
        .find(|l| l.starts_with(starting))
        .unwrap_or_else(|| panic!("docs/ci.md lost `{starting}`"))
}

/// The guide opened with "1 when it reports a finding": a gate written from
/// that passes with findings a `[severity]` made `information` or `hint`,
/// which do not fail the run (#2768).
#[test]
fn the_exit_codes_the_guide_opens_with_are_the_ones_a_run_gives() {
    let opening = DOC.split("\n\n").nth(1).unwrap().replace('\n', " ");
    assert!(
        opening.starts_with(
            "qlinter exits 1 when it reports a finding that is an error or a warning, 0 when it \
             reports none - nothing at all, or only findings a `[severity]` table made \
             `information` or `hint` - and 2 when it cannot run"
        ),
        "{opening}"
    );
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("clean.q"), "a:1\n").unwrap();
    std::fs::write(dir.path().join("found.q"), "f:{[count] count+1}\n").unwrap();
    assert_eq!(run(dir.path(), "qlinter clean.q").0, 0);
    assert_eq!(run(dir.path(), "qlinter found.q").0, 1);
    for (severity, exit) in [
        ("error", 1),
        ("warning", 1),
        ("information", 0),
        ("hint", 0),
    ] {
        std::fs::write(
            dir.path().join("qlinter.toml"),
            format!("[severity]\nQF001 = \"{severity}\"\n"),
        )
        .unwrap();
        let (code, printed) = run(dir.path(), "qlinter found.q");
        assert_eq!(code, exit, "{severity}");
        assert!(printed.contains("QF001"), "{severity}: {printed}");
    }
    std::fs::write(
        dir.path().join("qlinter.toml"),
        "baseline = \"none.json\"\n",
    )
    .unwrap();
    assert_eq!(run(dir.path(), "qlinter found.q").0, 2);
}

#[test]
fn the_baseline_walkthrough_keeps_old_findings_out_and_new_ones_in() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src/old.q"), "f:{[count] count+1}\n").unwrap();
    assert_eq!(
        run(root, "qlinter src").0,
        1,
        "the tree has a finding today"
    );

    let write = command("qlinter --write-baseline");
    assert_eq!(run(root, write).0, 0);
    let [config] = blocks("toml")[..] else {
        panic!("docs/ci.md should hold one configuration");
    };
    std::fs::write(root.join("qlinter.toml"), config).unwrap();
    let lint = command("qlinter src");
    let (code, out) = run(root, lint);
    assert_eq!(code, 0, "the old finding is baselined: {out}");
    assert!(out.contains("0 finding(s)"), "{out}");

    std::fs::write(root.join("src/new.q"), "g:{[first] first+1}\n").unwrap();
    let (code, out) = run(root, lint);
    assert_eq!(code, 1);
    assert!(out.contains("new.q") && !out.contains("old.q"), "{out}");
}

#[test]
fn add_noqa_accepts_every_finding_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src/a.q"), "f:{[count] count+1}\n").unwrap();
    assert_eq!(run(root, command("qlinter --add-noqa src")).0, 0);
    let text = std::fs::read_to_string(root.join("src/a.q")).unwrap();
    assert!(text.contains("noqa: QF001"), "{text}");
    assert_eq!(run(root, "qlinter src").0, 0);
}
