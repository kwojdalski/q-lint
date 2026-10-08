//! `[tool.q-lint] ignore` and `--ignore`: findings with a code the project has
//! decided against are not reported, not fixed, and not mistyped silently.

use std::{fs, path::Path, process::Command};

const SOURCE: &str = "my_var:1;f:{[desc] desc}\n";

fn codes(dir: &Path, args: &[&str]) -> (Option<i32>, Vec<String>) {
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir)
        .args(args)
        .args(["--format", "json", "a.q"])
        .output()
        .unwrap();
    let findings: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let codes = findings
        .as_array()
        .map(|a| {
            a.iter()
                .map(|f| f["code"].as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default();
    (out.status.code(), codes)
}

fn project(config: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.q"), SOURCE).unwrap();
    if !config.is_empty() {
        fs::write(dir.path().join("pyproject.toml"), config).unwrap();
    }
    dir
}

#[test]
fn without_an_ignore_both_findings_are_reported() {
    let dir = project("");
    assert_eq!(codes(dir.path(), &[]).1, ["QS001", "QF001"]);
}

#[test]
fn a_configured_ignore_drops_that_code_and_only_that_code() {
    let dir = project("[tool.q-lint]\nignore = [\"QS001\"]\n");
    assert_eq!(codes(dir.path(), &[]), (Some(1), vec!["QF001".to_string()]));
}

#[test]
fn the_flag_ignores_too_and_adds_to_the_configuration() {
    let dir = project("[tool.q-lint]\nignore = [\"QS001\"]\n");
    let (status, found) = codes(dir.path(), &["--ignore", "QF001"]);
    assert_eq!(
        (status, found.len()),
        (Some(0), 0),
        "both ignored, so a clean exit"
    );
}

#[test]
fn an_unknown_code_is_refused_rather_than_ignoring_nothing() {
    for (config, flags) in [
        ("[tool.q-lint]\nignore = [\"QS999\"]\n", vec![]),
        ("", vec!["--ignore", "QX1"]),
    ] {
        let dir = project(config);
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(dir.path())
            .args(&flags)
            .arg("a.q")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2));
        let err = String::from_utf8(out.stderr).unwrap();
        assert!(err.contains("is not a diagnostic code"), "{err}");
    }
}

#[test]
fn an_unknown_key_names_the_keys_that_exist() {
    let dir = project("[tool.q-lint]\nline-length = 88\n");
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .arg("a.q")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(
        String::from_utf8(out.stderr)
            .unwrap()
            .contains("unknown key `line-length`; qlinter reads profile, select")
    );
}

#[test]
fn fix_leaves_an_ignored_rule_alone() {
    let dir = project("[tool.q-lint]\nignore = [\"QE004\"]\n");
    fs::write(dir.path().join("a.q"), "b:1==1\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .args(["--fix", "a.q"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        fs::read_to_string(dir.path().join("a.q")).unwrap(),
        "b:1==1\n"
    );
}
