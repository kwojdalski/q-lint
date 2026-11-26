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
        assert_eq!(loc["artifactLocation"]["uriBaseId"], "%SRCROOT%");
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

/// Text written to a file is never coloured, as the README says: a CI job
/// that passes `--color always` for its log and keeps the report in a file
/// once found escape codes in it (#2763).
#[test]
fn output_file_is_never_coloured() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), TWO).unwrap();
    let (_, plain, _) = run(d, &["--color", "never", "a.q"]);
    let (_, coloured, _) = run(d, &["--color", "always", "a.q"]);
    assert!(coloured.contains('\x1b'), "{coloured}");
    for colour in ["always", "auto", "never"] {
        let (status, out, err) = run(
            d,
            &["--color", colour, "--output-file", "report.txt", "a.q"],
        );
        assert_eq!((status, out.as_str()), (Some(1), ""), "{colour}: {err}");
        let written = fs::read_to_string(d.join("report.txt")).unwrap();
        assert_eq!(written, plain, "{colour}");
    }
}

/// The input an `--output-file` may not be is a file, not a name: a symlink
/// to a source, a hard link to one, another case of its name on a disk that
/// ignores case, and the file `--stdin-filename` lints the buffer as were
/// each written over (#2116). Each is refused, exits 2, and leaves it as it
/// was.
#[test]
fn output_file_is_never_an_input_under_another_name() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), TWO).unwrap();
    let mut targets = vec![];
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("a.q", d.join("link.txt")).unwrap();
        fs::create_dir(d.join("sub")).unwrap();
        std::os::unix::fs::symlink("../a.q", d.join("sub/up.out")).unwrap();
        targets.extend(["link.txt", "sub/up.out"]);
    }
    fs::hard_link(d.join("a.q"), d.join("hard.txt")).unwrap();
    targets.push("hard.txt");
    if d.join("A.Q").exists() {
        targets.push("A.Q");
    }
    for target in targets {
        let (status, _, err) = run(d, &["a.q", "--output-file", target]);
        assert_eq!(status, Some(2), "{target}: {err}");
        assert!(err.contains("one of the files to lint"), "{target}: {err}");
        assert_eq!(fs::read_to_string(d.join("a.q")).unwrap(), TWO, "{target}");
    }
    // The buffer piped as a.q: its file is the one an editor saves it to.
    for target in ["a.q", "hard.txt"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(d)
            .args([
                "--isolated",
                "--stdin-filename",
                "a.q",
                "--output-file",
                target,
            ])
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(TWO.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{target}: {err}");
        assert!(err.contains("one of the files to lint"), "{target}: {err}");
        assert_eq!(fs::read_to_string(d.join("a.q")).unwrap(), TWO, "{target}");
    }
    // A file of its own is still written.
    let (status, _, err) = run(d, &["a.q", "--output-file", "rep.txt"]);
    assert_eq!(status, Some(1), "{err}");
    assert!(
        fs::read_to_string(d.join("rep.txt"))
            .unwrap()
            .contains("QS001")
    );
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

/// An editor, and GitHub's file view, hide a leading BOM and count no column
/// for it, so every report places line 1 as it does: `{` of `f:{[count] 1}`
/// at column 3 and `==` at 16-18, with or without a BOM before them. QE005,
/// the BOM's own, stays at 1:1 (#2097).
#[test]
fn every_report_places_line_one_of_a_bom_file_where_an_editor_shows_it() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let line = "f:{[count] 1};a==b\n";
    fs::write(d.join("plain.q"), line).unwrap();
    fs::write(d.join("bom.q"), format!("\u{feff}{line}")).unwrap();
    let places = |file: &str| -> Vec<(String, u64, u64)> {
        let (_, out, err) = run(d, &["--select", "Q", "--format", "json", file]);
        let found: serde_json::Value =
            serde_json::from_str(&out).unwrap_or_else(|_| panic!("{err}"));
        found
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["code"].as_str().unwrap().to_string(),
                    f["column"].as_u64().unwrap(),
                    f["end_column"].as_u64().unwrap_or(0),
                )
            })
            .collect()
    };
    let plain = places("plain.q");
    let mut bom = places("bom.q");
    assert_eq!(bom.remove(0), ("QE005".to_string(), 1, 2));
    assert_eq!(bom, plain);
    assert!(
        plain.iter().any(|(c, col, _)| c == "QF001" && *col == 3),
        "{plain:?}"
    );
    assert!(plain.contains(&("QE004".to_string(), 16, 18)), "{plain:?}");
    // SARIF, the workflow commands and the text say the same.
    let (_, out, _) = run(d, &["--select", "QE004", "--format", "sarif", "bom.q"]);
    let report: serde_json::Value = serde_json::from_str(&out).unwrap();
    let region = &report["runs"][0]["results"][0]["locations"][0]["physicalLocation"]["region"];
    assert_eq!(
        (region["startColumn"].as_u64(), region["endColumn"].as_u64()),
        (Some(16), Some(18))
    );
    let (_, out, _) = run(d, &["--select", "QE004", "--format", "github", "bom.q"]);
    assert!(out.contains("line=1,col=16,endColumn=18,"), "{out}");
    let (_, out, _) = run(d, &["--select", "QE004", "bom.q"]);
    assert!(out.contains("bom.q:1:16: "), "{out}");
}

/// A file outside the directory qlinter runs in is located by its `file:`
/// URI, and a relative one by `%SRCROOT%`, which the run says is that
/// directory: a bare absolute path is a reference SARIF readers resolve
/// against their own base (#2098). Read back through an RFC 3986 parser,
/// the two name the same file.
#[test]
fn sarif_locates_a_file_outside_the_run_by_its_file_uri() {
    use iri_string::types::{UriAbsoluteStr, UriReferenceStr, UriStr};
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::create_dir_all(d.join("an")).unwrap();
    fs::create_dir_all(d.join("w x")).unwrap();
    fs::write(d.join("w x/c.q"), TWO).unwrap();
    fs::write(d.join("an/b.q"), TWO).unwrap();
    let (_, out, err) = run(&d.join("an"), &["--format", "sarif", "../w x/c.q", "b.q"]);
    let report: serde_json::Value = serde_json::from_str(&out).unwrap_or_else(|_| panic!("{err}"));
    let run0 = &report["runs"][0];
    let base = run0["originalUriBaseIds"]["%SRCROOT%"]["uri"]
        .as_str()
        .unwrap();
    let base = UriAbsoluteStr::new(base).unwrap();
    assert_eq!(base.scheme_str(), "file");
    let mut seen = vec![];
    for r in run0["results"].as_array().unwrap() {
        let loc = &r["locations"][0]["physicalLocation"]["artifactLocation"];
        let reference = UriReferenceStr::new(loc["uri"].as_str().unwrap()).unwrap();
        let file = match loc.get("uriBaseId") {
            Some(id) => {
                assert_eq!(id, "%SRCROOT%");
                reference.resolve_against(base).to_string()
            }
            None => reference.to_string(),
        };
        let file = UriStr::new(&file).unwrap();
        assert_eq!(file.scheme_str(), "file", "{loc}");
        assert!(!file.path_str().contains('?'), "{loc}");
        seen.push(file.path_str().rsplit_once("/").unwrap().1.to_string());
        if loc.get("uriBaseId").is_none() {
            assert!(file.path_str().ends_with("/w%20x/c.q"), "{loc}");
        } else {
            assert!(file.path_str().ends_with("/an/b.q"), "{loc}");
        }
    }
    seen.sort();
    seen.dedup();
    assert_eq!(seen, ["b.q", "c.q"]);
}

/// The text report writes a control character in a file's name as an
/// escape: raw, a newline forged a finding line and an escape sequence
/// reached the terminal (#2659).
#[cfg(unix)]
#[test]
fn the_text_report_escapes_control_characters_in_a_path() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let forged = "evil.q:9:9: error: QE001 [fake] forged finding\nreal.q";
    fs::write(d.join(forged), "f:{[x;y] x==y}\n").unwrap();
    fs::write(d.join("a\x1b[2J\x1b]0;PWNED\x07b.q"), "f:{[x;y] x==y}\n").unwrap();
    let (status, out, err) = run(d, &["--color", "never", "."]);
    assert_eq!(status, Some(1), "{err}");
    assert!(
        out.contains("forged finding\\nreal.q:1:"),
        "the newline is written as an escape: {out}"
    );
    assert!(
        !out.lines().any(|l| l.starts_with("real.q:")),
        "no line of the report starts in the file's name: {out}"
    );
    assert!(out.contains("a\\x1b[2J\\x1b]0;PWNED\\x07b.q:1:"), "{out}");
    assert!(!out.contains(['\x1b', '\x07']), "{out:?}");
}

/// `--rules` and `--explain` describe the rules and lint nothing, so a path
/// or a flag that lints or writes beside one is refused rather than dropped:
/// the run exited 0 having added no `noqa` and written no baseline (#2856).
#[test]
fn rules_and_explain_refuse_what_they_would_ignore() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("bad.q"), "f:{[x;y] x==y}\n").unwrap();
    for args in [
        &["--explain", "QE004", "bad.q"][..],
        &["--rules", "bad.q"],
        &["--rules", "-"],
        &["--explain", "QE004", "--add-noqa", "bad.q"],
        &["--rules", "--write-baseline", "nb.json"],
        &["--explain", "QE004", "--stdin-filename", "x.q"],
        &["--rules", "--statistics"],
        &["--rules", "--explain", "QE004"],
    ] {
        let (status, out, err) = run(d, args);
        assert_eq!(status, Some(2), "{args:?}: {out}{err}");
        assert!(out.is_empty(), "{args:?}: {out}");
        assert!(err.contains("--rules"), "{args:?}: {err}");
    }
    assert_eq!(
        fs::read_to_string(d.join("bad.q")).unwrap(),
        "f:{[x;y] x==y}\n"
    );
    assert!(!d.join("nb.json").exists());
    // Alone, each still prints.
    let (status, out, _) = run(d, &["--explain", "QE004"]);
    assert_eq!(status, Some(0));
    assert!(out.starts_with("QE004 "), "{out}");
    let (status, out, _) = run(d, &["--rules"]);
    assert_eq!(status, Some(0));
    assert!(out.lines().count() > 100, "{out}");
}

/// Off Windows `\` is a character of a file's name, not what separates its
/// directories: `a\b.q` is reported as itself, not as `a/b.q`, a file that
/// is not there for an annotation to land on (#2766). A baseline keeps it
/// too, so a file of each name is told from the other.
#[cfg(unix)]
#[test]
fn a_backslash_in_a_file_name_stays_one_in_every_report() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a\\b.q"), TWO).unwrap();
    let (status, out, err) = run(d, &["--format", "github", "."]);
    assert_eq!(status, Some(1), "{err}");
    assert!(out.starts_with("::warning file=a\\b.q,line=1"), "{out}");
    let (_, out, err) = run(d, &["--format", "sarif", "."]);
    let report: serde_json::Value = serde_json::from_str(&out).unwrap_or_else(|_| panic!("{err}"));
    let loc = &report["runs"][0]["results"][0]["locations"][0]["physicalLocation"];
    assert_eq!(loc["artifactLocation"]["uri"], "a%5Cb.q", "{loc}");
    let (status, _, err) = run(d, &["--write-baseline", "base.json", "."]);
    assert_eq!(status, Some(0), "{err}");
    let written = fs::read_to_string(d.join("base.json")).unwrap();
    assert!(written.contains(r#""path":"a\\b.q""#), "{written}");
}
