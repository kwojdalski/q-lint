//! The reports a run can print besides text and JSON - `--format sarif`,
//! `--format github` and `--statistics` - and where it prints them.
use std::{fs, path::Path, process::Command};

/// The run's exit code, stdout and stderr, in `dir`.
fn run(dir: &Path, args: &[&str]) -> (Option<i32>, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir)
        .arg("--isolated")
        .args(args)
        .output()
        .unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// Two findings in one file under `--profile uqf`: QS001 on line 1 and
/// QF001 on line 2 (with its column).
const TWO: &str = "my_var:1\nf:{[desc] desc}\n";

#[test]
fn sarif_has_the_shape_code_scanning_requires_and_one_result_per_finding() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::create_dir(d.join("src")).unwrap();
    fs::write(d.join("src/a.q"), TWO).unwrap();
    let (status, out, err) = run(d, &["--format", "sarif", "src"]);
    assert_eq!(status, Some(1), "{err}");
    let report: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(report["version"], "2.1.0");
    assert!(report["$schema"].as_str().unwrap().contains("sarif-2.1.0"));
    let runs = report["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    // Required for a run with results; the columns count UTF-16 units.
    assert_eq!(runs[0]["columnKind"], "utf16CodeUnits");
    let driver = &runs[0]["tool"]["driver"];
    assert_eq!(driver["name"], "qlinter");
    let rules = driver["rules"].as_array().unwrap();
    let ids: Vec<&str> = rules.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["QF001", "QS001"]);
    for rule in rules {
        let id = rule["id"].as_str().unwrap();
        assert!(
            !rule["shortDescription"]["text"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            rule["helpUri"],
            format!(
                "https://github.com/kwojdalski/q-lint/blob/master/docs/rules.md#{}",
                id.to_lowercase()
            )
        );
    }
    let results = runs[0]["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "{out}");
    for r in results {
        // Every field a result needs, and a rule index that names its rule.
        let id = r["ruleId"].as_str().unwrap();
        assert_eq!(rules[r["ruleIndex"].as_u64().unwrap() as usize]["id"], id);
        assert!(matches!(r["level"].as_str(), Some("error" | "warning")));
        assert!(!r["message"]["text"].as_str().unwrap().is_empty());
        let loc = &r["locations"][0]["physicalLocation"];
        assert_eq!(loc["artifactLocation"]["uri"], "src/a.q");
        assert!(loc["region"]["startLine"].as_u64().unwrap() >= 1);
        let print = r["partialFingerprints"]["qlinterBaseline/v1"]
            .as_str()
            .unwrap();
        assert!(print.ends_with(":1"), "{print}");
    }
    let qf001 = results.iter().find(|r| r["ruleId"] == "QF001").unwrap();
    let region = &qf001["locations"][0]["physicalLocation"]["region"];
    assert_eq!(region["startLine"], 2);
    assert!(region["startColumn"].as_u64().is_some(), "{region}");

    // A fingerprint is the baseline's key: lines added above leave it as it
    // was, and editing the finding's own line changes it.
    let prints = |out: &str| -> Vec<String> {
        let report: serde_json::Value = serde_json::from_str(out).unwrap();
        report["runs"][0]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                r["partialFingerprints"]["qlinterBaseline/v1"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    };
    let before = prints(&out);
    fs::write(d.join("src/a.q"), format!("/ note\n\n{TWO}")).unwrap();
    assert_eq!(prints(&run(d, &["--format", "sarif", "src"]).1), before);
    fs::write(d.join("src/a.q"), "my_var:2\nf:{[desc] desc}\n").unwrap();
    let edited = prints(&run(d, &["--format", "sarif", "src"]).1);
    assert_ne!(edited[0], before[0]);
    assert_eq!(edited[1], before[1]);
}

#[test]
fn a_clean_sarif_run_still_names_the_tool() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.q"), "a:1\n").unwrap();
    let (status, out, _) = run(dir.path(), &["--format", "sarif", "a.q"]);
    assert_eq!(status, Some(0));
    let report: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(report["runs"][0]["tool"]["driver"]["name"], "qlinter");
    assert_eq!(report["runs"][0]["results"], serde_json::json!([]));
}

#[test]
fn github_prints_one_workflow_command_per_finding() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.q"), TWO).unwrap();
    let (status, out, err) = run(dir.path(), &["--format", "github", "a.q"]);
    assert_eq!(status, Some(1), "{err}");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2, "{out}");
    assert!(lines[0].starts_with("::warning file=a.q,line=1"), "{out}");
    assert!(lines[0].contains(",title=QS001::"), "{out}");
    assert!(
        lines[1].starts_with("::error file=a.q,line=2,col="),
        "{out}"
    );
    assert!(lines[1].contains(",title=QF001::"), "{out}");
}

#[test]
fn statistics_counts_each_rule_across_files_most_first() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    // QS001 three times over two files, QF001 once.
    fs::write(d.join("a.q"), TWO).unwrap();
    fs::write(d.join("b.q"), "my_a:1\nmy_b:2\n").unwrap();
    let (status, out, err) = run(d, &["--statistics", "a.q", "b.q"]);
    assert_eq!(status, Some(1), "{err}");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2, "{out}");
    assert!(lines[0].starts_with("3  QS001 "), "{out}");
    assert!(lines[1].starts_with("1  QF001 "), "{out}");
    assert!(lines[1].len() > "1  QF001  ".len(), "{out}");

    let (status, out, _) = run(d, &["--statistics", "--format", "json", "a.q", "b.q"]);
    assert_eq!(status, Some(1));
    let rows: serde_json::Value = serde_json::from_str(&out).unwrap();
    let rows = rows.as_array().unwrap();
    let counts: Vec<(&str, u64)> = rows
        .iter()
        .map(|r| (r["code"].as_str().unwrap(), r["count"].as_u64().unwrap()))
        .collect();
    assert_eq!(counts, [("QS001", 3), ("QF001", 1)]);
    assert!(!rows[0]["summary"].as_str().unwrap().is_empty());

    let (status, _, err) = run(d, &["--statistics", "--format", "sarif", "a.q"]);
    assert_eq!(status, Some(2));
    assert!(err.contains("--statistics prints text or json"), "{err}");
}

#[test]
fn output_file_takes_the_report_and_leaves_the_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), TWO).unwrap();
    for format in ["text", "json", "sarif", "github"] {
        let (plain_status, plain, _) = run(d, &["--format", format, "a.q"]);
        let (status, out, err) = run(
            d,
            &["--format", format, "--output-file", "report.out", "a.q"],
        );
        assert_eq!(status, plain_status, "{format}: {err}");
        assert_eq!(out, "", "{format}");
        let written = fs::read_to_string(d.join("report.out")).unwrap();
        assert_eq!(written, plain, "{format}");
    }
    // A clean run still writes (an empty report), and exits 0.
    fs::write(d.join("b.q"), "a:1\n").unwrap();
    let (status, out, _) = run(
        d,
        &["--format", "json", "--output-file", "report.out", "b.q"],
    );
    assert_eq!((status, out.as_str()), (Some(0), ""));
    assert_eq!(fs::read_to_string(d.join("report.out")).unwrap(), "[]\n");
    // A file that cannot be written is the run's error.
    let (status, _, err) = run(d, &["--output-file", "no/such/dir/r.out", "b.q"]);
    assert_eq!(status, Some(2));
    assert!(err.contains("no/such/dir/r.out"), "{err}");
}

#[test]
fn output_file_is_never_written_by_a_refused_run_or_over_an_input() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), TWO).unwrap();
    fs::write(d.join("rep.txt"), "precious\n").unwrap();
    // A run refused for its arguments leaves the file as it was.
    let (status, _, _) = run(
        d,
        &[
            "--statistics",
            "--format",
            "sarif",
            "--output-file",
            "rep.txt",
            "a.q",
        ],
    );
    assert_eq!(status, Some(2));
    assert_eq!(fs::read_to_string(d.join("rep.txt")).unwrap(), "precious\n");
    // A file that is also an input is refused, and not truncated.
    let (status, _, err) = run(d, &["a.q", "--output-file", "a.q"]);
    assert_eq!(status, Some(2));
    assert!(err.contains("one of the files to lint"), "{err}");
    assert_eq!(fs::read_to_string(d.join("a.q")).unwrap(), TWO);
}
