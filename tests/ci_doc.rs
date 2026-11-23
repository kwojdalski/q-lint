//! `docs/ci.md`'s commands, run as written. The baseline walkthrough is
//! the part of the guide a reader follows step by step on their own tree, so
//! each `qlinter` line of its shell blocks, and its configuration, is taken
//! from the document itself rather than restated here. The YAML snippets
//! are checked against the action and the hooks by `tests/test_packaging.py`.
use std::{path::Path, process::Command};

const DOC: &str = include_str!("../docs/ci.md");

/// The bodies of the document's fenced blocks in `language`.
fn blocks(language: &str) -> Vec<&'static str> {
    DOC.split(&format!("```{language}\n"))
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
