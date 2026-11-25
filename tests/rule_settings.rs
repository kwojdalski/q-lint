//! `[severity]` and `[rules.<CODE>]` in a configuration: how a finding is
//! reported in every output format (#1176), and the thresholds and word
//! lists a few rules read (#1177).

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
fn without_options_the_built_in_thresholds_and_words_apply() {
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
fn qs006_max_lines_moves_the_threshold() {
    let dir = project("[rules.QS006]\nmax-lines = 4\n");
    let found = findings(dir.path());
    let qs006: Vec<_> = found.iter().filter(|f| f.0 == "QS006").collect();
    assert_eq!(qs006.len(), 1, "{found:?}");
    assert!(qs006[0].2.contains("over 4"), "{found:?}");
    let dir = project("[rules.QS006]\nmax-lines = 5\n");
    assert!(!codes(dir.path()).contains(&"QS006".to_string()));
}

#[test]
fn ql001_markers_replace_the_words_reported() {
    let dir = project("[rules.QL001]\nmarkers = [\"NOTE\"]\n");
    let found: Vec<_> = findings(dir.path())
        .into_iter()
        .filter(|f| f.0 == "QL001")
        .collect();
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].2.contains("`NOTE`"), "{found:?}");
}

#[test]
fn qx002_name_pattern_replaces_the_names_read_as_credentials() {
    let dir = project("[lint.rules.QX002]\nname-pattern = \"cred$\"\n");
    let found: Vec<_> = findings(dir.path())
        .into_iter()
        .filter(|f| f.0 == "QX002")
        .collect();
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].2.contains("`dbcred`"), "{found:?}");
}

#[test]
fn an_unknown_option_or_a_wrong_value_is_a_configuration_error() {
    for (config, said) in [
        (
            "[rules.QS006]\nmax-line = 4\n",
            "unknown option `max-line`; QS006 reads max-lines",
        ),
        ("[rules.QF001]\nx = 1\n", "QF001 has no options"),
        ("[rules.QS006]\nmax-lines = 0\n", "an integer of at least 1"),
        ("[rules.QS006]\nmax-lines = \"9\"\n", "must be an integer"),
        ("[rules.QL001]\nmarkers = []\n", "nonempty list of words"),
        (
            "[rules.QL001]\nmarkers = [\"TO DO\"]\n",
            "nonempty list of words",
        ),
        ("[rules.QX002]\nname-pattern = \"(\"\n", "name-pattern"),
        ("rules = 1\n", "rules must be a table"),
    ] {
        let dir = project(config);
        let (status, _, err) = run(dir.path(), &[]);
        assert_eq!(status, Some(2), "{config}: {err}");
        assert!(err.contains(said), "{config}: {err}");
    }
}

#[test]
fn a_severity_changes_how_a_finding_is_reported_in_every_format() {
    // `info` and `information` are one level, reported as qls and the LSP
    // spell it, `information` (#2122).
    for spelt in ["information", "info"] {
        let dir = project(&format!(
            "[severity]\nQ = \"hint\"\nQX = \"{spelt}\"\nQL001 = \"error\"\n"
        ));
        let found = findings(dir.path());
        let level = |code: &str| found.iter().find(|f| f.0 == code).unwrap().1.clone();
        assert_eq!(
            (level("QL001"), level("QX002")),
            ("error".into(), "information".into()),
            "{spelt}"
        );
        let (_, text, _) = run(dir.path(), &[]);
        assert!(text.contains(": information: QX002"), "{spelt}: {text}");
    }
    let dir = project("[severity]\nQ = \"hint\"\nQX = \"information\"\nQL001 = \"error\"\n");

    let (status, text, _) = run(dir.path(), &[]);
    assert_eq!(status, Some(1), "an error still fails the run");
    assert!(text.contains(": error: QL001"), "{text}");

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

#[test]
fn an_extending_file_overrides_severities_and_options_one_by_one() {
    let dir = project(
        "extend = \"base.toml\"\n[severity]\nQL001 = \"hint\"\n[rules.QS006]\nmax-lines = 4\n",
    );
    fs::write(
        dir.path().join("base.toml"),
        "[severity]\nQL001 = \"error\"\nQX002 = \"error\"\n\
         [rules.QS006]\nmax-lines = 99\n[rules.QL001]\nmarkers = [\"NOTE\"]\n",
    )
    .unwrap();
    let found = findings(dir.path());
    let level = |code: &str| {
        found
            .iter()
            .find(|f| f.0 == code)
            .unwrap_or_else(|| panic!("{code} in {found:?}"))
            .1
            .clone()
    };
    assert_eq!(level("QL001"), "hint");
    assert_eq!(level("QX002"), "error");
    assert_eq!(level("QS006"), "warning");
    assert!(
        found.iter().any(|f| f.0 == "QL001" && f.2.contains("NOTE")),
        "{found:?}"
    );
}
