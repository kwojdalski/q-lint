//! `/ noqa: CODE` - a trailing comment that accepts named findings on its
//! own line, and nothing else.
use q_lint_rs::{Profile, lint};
use std::{fs, process::Command};

fn codes(source: &str) -> Vec<(usize, String)> {
    lint(source, "t.q", Profile::Uqf)
        .into_iter()
        .map(|f| (f.line, f.code))
        .collect()
}

fn has(source: &str, line: usize, code: &str) -> bool {
    codes(source).contains(&(line, code.to_string()))
}

#[test]
fn a_named_code_is_suppressed_on_its_line_only() {
    let plain = "f:{[dt;data] dt}\n";
    assert!(has(plain, 1, "QF016"));
    assert!(!has("f:{[dt;data] dt} / noqa: QF016\n", 1, "QF016"));
    // Another line keeps its finding.
    let two = "f:{[dt;data] dt} / noqa: QF016\ng:{[dt;data] dt}\n";
    assert!(!has(two, 1, "QF016"));
    assert!(has(two, 2, "QF016"));
}

#[test]
fn a_multi_line_lambda_is_suppressed_where_the_finding_is_reported() {
    // QF016 is reported on the parameter's line.
    assert!(!has("f:{[dt;data] / noqa: QF016\n  dt}\n", 1, "QF016"));
    assert!(has("f:{[dt;data]\n  dt} / noqa: QF016\n", 1, "QF016"));
}

#[test]
fn other_codes_on_the_same_line_are_still_reported() {
    let source = "f:{[dt;data] s:1; dt} / noqa: QF016\n";
    assert!(!has(source, 1, "QF016"));
    assert!(has(source, 1, "QF017"));
}

#[test]
fn several_codes_and_a_reason() {
    let source = "f:{[dt;data] s:1; dt} / noqa: QF016, QF017\n";
    assert!(codes(source).is_empty(), "{:?}", codes(source));
    let spaced = "f:{[dt;data] s:1; dt} / NOQA: QF016 QF017\n";
    assert!(codes(spaced).is_empty(), "{:?}", codes(spaced));
    let reason = "f:{[dt;data] dt} / noqa: QF016 TorQ calls endofday[dt;data]\n";
    assert!(!has(reason, 1, "QF016"));
}

#[test]
fn bare_noqa_suppresses_nothing() {
    assert!(has("f:{[dt;data] dt} / noqa\n", 1, "QF016"));
    assert!(has("f:{[dt;data] dt} / noqa:\n", 1, "QF016"));
    assert!(has("f:{[dt;data] dt} / noqa: QF017\n", 1, "QF016"));
}

#[test]
fn noqa_inside_a_string_is_not_a_comment() {
    assert!(has(
        "f:{[dt;data] s:\" / noqa: QF016\"; s,dt}\n",
        1,
        "QF016"
    ));
    // Without whitespace before it, `/` is over, not a comment.
    assert!(has("f:{[dt;data] dt}/ noqa: QF016\n", 1, "QF016"));
}

#[test]
fn fix_leaves_a_suppressed_finding_alone() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("noqa.q");
    fs::write(&path, "a:2\nb:a==1 / noqa: QE004\nc:a==1\n").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .arg("--fix")
        .arg(&path)
        .output()
        .unwrap();
    assert!(result.status.success(), "{result:?}");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "a:2\nb:a==1 / noqa: QE004\nc:a=1\n"
    );
}

#[test]
fn cli_exit_code_follows_suppression() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("noqa.q");
    fs::write(&path, "f:{[dt;data] dt} / noqa: QF016\n").unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(["--profile", "uqf"])
            .arg(&path)
            .output()
            .unwrap()
    };
    assert_eq!(run().status.code(), Some(0), "{:?}", run());
    fs::write(&path, "f:{[dt;data] dt} / noqa\n").unwrap();
    assert_eq!(run().status.code(), Some(1));
}
