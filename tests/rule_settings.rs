//! `[severity]` in a configuration: how a finding is reported in every
//! output format (#1176).

use std::{fs, path::Path, process::Command};

/// A lambda of five lines of code, a TODO and a NOTE in a comment, and two
/// string literals whose names may read as credentials.
const SOURCE: &str = "f:{[a]\n  b:a+1;\n  c:b+1;\n  d:c+1;\n  d}\n/ TODO later, NOTE here\n\
                      apiPassword:\"hunter2\"\ndbcred:\"s3cret\"\n";

fn project(config: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.q"), SOURCE).unwrap();
    fs::write(
        dir.path().join(".qlinter.toml"),
        format!("select = [\"QS006\", \"QL001\", \"QX002\"]\n{config}"),
    )
    .unwrap();
    dir
}

fn run(dir: &Path, args: &[&str]) -> (Option<i32>, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir)
        .args(args)
        .arg("a.q")
        .output()
        .unwrap();
    (
        out.status.code(),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    )
}

/// Each finding's code, severity and message, in the JSON report.
fn findings(dir: &Path) -> Vec<(String, String, String)> {
    let (_, out, err) = run(dir, &["--format", "json"]);
    let found: serde_json::Value =
        serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out} {err}"));
    found
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["code"].as_str().unwrap().into(),
                f["severity"].as_str().unwrap().into(),
                f["detail"].as_str().unwrap().into(),
            )
        })
        .collect()
}

fn codes(dir: &Path) -> Vec<String> {
    findings(dir).into_iter().map(|f| f.0).collect()
}

#[test]
fn without_a_severity_each_rule_reports_as_its_own() {
    let dir = project("");
    let found = findings(dir.path());
    assert_eq!(
        found.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(),
        ["QL001", "QX002"]
    );
    assert!(found[0].2.contains("TODO"), "{found:?}");
    assert!(found[1].2.contains("apiPassword"), "{found:?}");
    assert!(found.iter().all(|f| f.1 == "warning"));
}

#[test]
fn a_severity_changes_how_a_finding_is_reported_in_every_format() {
    let dir = project("[severity]\nQ = \"hint\"\nQX = \"information\"\nQL001 = \"error\"\n");
    let found = findings(dir.path());
    let level = |code: &str| found.iter().find(|f| f.0 == code).unwrap().1.clone();
    assert_eq!(
        (level("QL001"), level("QX002")),
        ("error".into(), "info".into())
    );

    let (status, text, _) = run(dir.path(), &[]);
    assert_eq!(status, Some(1), "an error still fails the run");
    assert!(text.contains(": error: QL001"), "{text}");
    assert!(text.contains(": info: QX002"), "{text}");

    let (_, github, _) = run(dir.path(), &["--format", "github"]);
    assert!(github.contains("::error file=a.q,line=6"), "{github}");
    assert!(github.contains("::notice file=a.q,line=7"), "{github}");

    let (_, sarif, _) = run(dir.path(), &["--format", "sarif"]);
    let sarif: serde_json::Value = serde_json::from_str(&sarif).unwrap();
    let levels: Vec<_> = sarif["runs"][0]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["ruleId"].as_str().unwrap().to_string(),
                r["level"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        levels,
        [
            ("QL001".to_string(), "error".to_string()),
            ("QX002".to_string(), "note".to_string())
        ]
    );
}

#[test]
fn only_an_error_or_a_warning_fails_the_run() {
    let dir = project("[severity]\nALL = \"hint\"\n");
    let (status, text, _) = run(dir.path(), &[]);
    assert_eq!(status, Some(0), "{text}");
    assert!(text.contains("2 finding(s)"), "{text}");
}

#[test]
fn a_severity_must_name_a_rule_and_a_level() {
    for (config, said) in [
        ("[severity]\nQS006 = \"fatal\"\n", "must be error, warning"),
        ("[severity]\nQZ = \"hint\"\n", "is not a diagnostic code"),
        ("severity = \"hint\"\n", "severity must be a table"),
    ] {
        let dir = project(config);
        let (status, _, err) = run(dir.path(), &[]);
        assert_eq!(status, Some(2), "{config}: {err}");
        assert!(err.contains(said), "{config}: {err}");
    }
}
