//! `/ noqa: CODE` - a trailing comment that accepts named findings on its
//! own line, and nothing else - and `suppression_for`, the edit that writes
//! one.
use q_lint_rs::{Finding, Profile, file_suppression_for, lint, suppression_for};
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
fn a_suppressed_structure_finding_leaves_the_other_rules_running() {
    // q 5: `b:(1` fails to parse with '(; `a:1==2` with '=. Accepting the
    // first must not accept the whole file.
    let unbalanced = "a:1==2\nb:(1\n";
    assert_eq!(codes(unbalanced), [(2, "QE001".to_string())]);
    let accepted = "a:1==2\nb:(1 / noqa: QE001\n";
    assert!(has(accepted, 1, "QE004"));
    assert!(!codes(accepted).iter().any(|(_, code)| code == "QE001"));
}

#[test]
fn a_suppressed_structure_finding_does_not_hide_the_next_one() {
    // q 5 refuses `b:(2` on its own with '(. Accepting line 1's QE001 must
    // leave line 2's reported (#413).
    let source = "a:(1 / noqa: QE001\nb:(2\n";
    assert_eq!(codes(source), [(2, "QE001".to_string())]);
    let stray = "a:(1 / noqa: QE001\nb:2)\n";
    assert_eq!(codes(stray), [(2, "QE001".to_string())]);
}

#[test]
fn a_noqa_on_a_bom_prefixed_comment_line_is_read() {
    // `<BOM>/ note` is a comment line; its noqa accepted nothing (#427).
    assert!(has("\u{feff}/ note\na:1\n", 1, "QE005"));
    assert!(!has("\u{feff}/ noqa: QE005\na:1\n", 1, "QE005"));
    assert!(!has("\u{feff}a:1 / noqa: QE005\n", 1, "QE005"));
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

/// `//` and `///` comments are comments too - 414 of the corpus's 707 files
/// write them - so a suppression in that style works the same (#186).
#[test]
fn a_noqa_written_with_several_slashes_suppresses_too() {
    for comment in ["//", "///"] {
        let source = format!("f:{{[dt;data] dt}} {comment} noqa: QF016\n");
        assert!(!has(&source, 1, "QF016"), "{source}");
    }
}

/// `source` after the suppression of its finding of `code` on `line`, or
/// `None` where none is offered.
fn suppressed(source: &str, line: usize, code: &str) -> Option<String> {
    let found = lint(source, "t.q", Profile::Uqf);
    let finding = found
        .iter()
        .find(|f| f.line == line && f.code == code)
        .unwrap_or_else(|| {
            panic!(
                "no {code} on line {line} of {source:?}: {:?}",
                codes(source)
            )
        });
    let edit = suppression_for(finding, source)?;
    assert!(!edit.batch_safe, "`--fix` must never accept a finding");
    assert_eq!(edit.title, format!("Suppress {code} on this line"));
    let mut edited = source.to_string();
    edited.replace_range(edit.start..edit.end, &edit.replacement);
    Some(edited)
}

#[test]
fn a_suppression_is_written_after_the_line_or_into_its_directive() {
    for (before, line, code, after) in [
        (
            "f:{[dt;data] dt}\n",
            1,
            "QF016",
            "f:{[dt;data] dt} / noqa: QF016\n",
        ),
        // Trailing blanks go, and a `\r` stays where it was.
        (
            "f:{[dt;data] dt} \t\r\na:1\r\n",
            1,
            "QF016",
            "f:{[dt;data] dt} / noqa: QF016\r\na:1\r\n",
        ),
        (
            "f:{[dt;data] dt}",
            1,
            "QF016",
            "f:{[dt;data] dt} / noqa: QF016",
        ),
        // After a comment, and after a `noqa` that names nothing.
        (
            "f:{[dt;data] dt} / TorQ's\n",
            1,
            "QF016",
            "f:{[dt;data] dt} / TorQ's / noqa: QF016\n",
        ),
        (
            "f:{[dt;data] dt} / noqa\n",
            1,
            "QF016",
            "f:{[dt;data] dt} / noqa / noqa: QF016\n",
        ),
        // Into the directive there, however it is spelled, before its reason.
        (
            "f:{[dt;data] s:1; dt} / noqa: QF016 TorQ calls endofday[dt;data]\n",
            1,
            "QF017",
            "f:{[dt;data] s:1; dt} / noqa: QF016, QF017 TorQ calls endofday[dt;data]\n",
        ),
        (
            "f:{[dt;data] s:1; dt} /// NOQA: QF016\n",
            1,
            "QF017",
            "f:{[dt;data] s:1; dt} /// NOQA: QF016, QF017\n",
        ),
        (
            "f:{[dt;data] s:1; a:1==1; dt} / noqa: QF016 QF017\n",
            1,
            "QE004",
            "f:{[dt;data] s:1; a:1==1; dt} / noqa: QF016 QF017, QE004\n",
        ),
        // A `noqa` in a string is no directive to add to.
        (
            "f:{[dt;data] s:\" / noqa: QF017\"; s,dt}\n",
            1,
            "QF016",
            "f:{[dt;data] s:\" / noqa: QF017\"; s,dt} / noqa: QF016\n",
        ),
        // On the line the finding is reported on, inside a lambda.
        (
            "f:{[dt;data]\n  dt}\n",
            1,
            "QF016",
            "f:{[dt;data] / noqa: QF016\n  dt}\n",
        ),
        // A comment line of its own.
        (
            "/ TODO: say why\na:1\n",
            1,
            "QL001",
            "/ TODO: say why / noqa: QL001\na:1\n",
        ),
        // Behind a byte-order mark, which has a finding of its own.
        ("\u{feff}a:1\n", 1, "QE005", "\u{feff}a:1 / noqa: QE005\n"),
    ] {
        let edited = suppressed(before, line, code);
        assert_eq!(edited.as_deref(), Some(after), "{before:?}");
        assert!(!has(after, line, code), "{after:?}: {:?}", codes(after));
    }
}

#[test]
fn no_suppression_where_a_comment_would_not_be_one() {
    for (source, line, code) in [
        // The line ends inside a string: the text would join it.
        ("a:1==1; s:\"first\n second\"\n", 1, "QE004"),
        // A bare slash stops being one with anything after it.
        ("a:1\n/\n", 2, "QP001"),
        ("a:1\n/\n", 2, "QE003"),
        ("a:1\n/\nnote\n\\\nb:2\n", 2, "QP001"),
        // Inside the block, nothing is code for a comment to trail.
        ("a:1\n/\nTODO in a block\n\\\nb:2\n", 3, "QL001"),
        // A system command's argument runs to the end of its line.
        ("\\l lib.q / TODO drop this\na:1\n", 1, "QL001"),
        // After the line that ends the script, nothing is read.
        ("a:1\n\\\nb:1 / TODO after the end\n", 3, "QL001"),
        // Reported alone; accepting it would report everything behind it.
        ("f:{[x] x==1\n", 1, "QE001"),
        ("a:1==1; s:\"abc\n", 1, "QE001"),
    ] {
        assert_eq!(suppressed(source, line, code), None, "{source:?}");
    }
}

/// Fixtures chosen for the shapes of their lines - strings and comments that
/// hold a `/`, statements over several lines, block comments, system
/// commands - rather than for their rules. Each finding in them either has
/// no suppression or has one that does exactly its job: after the edit, the
/// findings of that code on that line are gone and every other finding is as
/// it was - none lost to a comment that swallowed code, none made by one
/// that was not a comment. (Not every fixture: each edit costs a lint of its
/// case, and all of them is a minute of a debug build.)
#[test]
fn every_suppression_over_the_fixtures_removes_its_finding_and_nothing_else() {
    let key = |f: &Finding| (f.line, f.code.clone(), f.column, f.detail.clone());
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases");
    let (mut offered, mut failures) = (0, vec![]);
    for name in ["syntax", "multiline", "leftovers", "styleq", "application"] {
        let path = std::path::Path::new(dir).join(format!("{name}.cases"));
        let text = fs::read_to_string(&path).unwrap();
        // A case is a `=== ` header line and the source under it.
        for case in text.split("\n=== ") {
            let Some((header, body)) = case.split_once('\n') else {
                continue;
            };
            let source = format!("{}\n", body.trim_matches('\n'));
            let before = lint(&source, "t.q", Profile::Uqf);
            let mut seen = vec![];
            for finding in &before {
                // One comment for a line and a code, however many findings.
                let target = (finding.line, finding.code.as_str());
                if seen.contains(&target) {
                    continue;
                }
                seen.push(target);
                let Some(edit) = suppression_for(finding, &source) else {
                    continue;
                };
                offered += 1;
                let mut edited = source.clone();
                edited.replace_range(edit.start..edit.end, &edit.replacement);
                let after: Vec<_> = lint(&edited, "t.q", Profile::Uqf).iter().map(key).collect();
                let wanted: Vec<_> = before
                    .iter()
                    .filter(|f| (f.line, f.code.as_str()) != target)
                    .map(key)
                    .collect();
                if after != wanted {
                    failures.push(format!(
                        "{}: {header}\n  {} on line {}: {:?}\n  wanted {wanted:?}\n  found  {after:?}",
                        path.display(),
                        finding.code,
                        finding.line,
                        edit.replacement
                    ));
                }
            }
        }
    }
    assert!(offered > 200, "expected a corpus, suppressed {offered}");
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn a_file_directive_suppresses_its_codes_on_every_line() {
    let two = "f:{[dt;data] dt}\ng:{[dt;data] dt}\n";
    assert!(has(two, 1, "QF016") && has(two, 2, "QF016"));
    let accepted = format!("/ qlinter: noqa: QF016\n{two}");
    assert!(!codes(&accepted).iter().any(|(_, c)| c == "QF016"));
    // Anywhere in the file, any case, several codes.
    let below = format!("{two}/  QLinter:NOQA: QS001, QF016 reason\n");
    assert!(!codes(&below).iter().any(|(_, c)| c == "QF016"));
    // Other codes are still reported.
    let other = format!("/ qlinter: noqa: QS001\n{two}");
    assert!(has(&other, 2, "QF016"));
}

#[test]
fn a_file_directive_is_only_a_comment_line_at_the_margin() {
    let two = "f:{[dt;data] dt}\ng:{[dt;data] dt}\n";
    // Indented, trailing, in a string, in a block comment, after the end.
    for wrapped in [
        format!("  / qlinter: noqa: QF016\n{two}"),
        format!("a:1 / qlinter: noqa: QF016\n{two}"),
        format!("s:\"/ qlinter: noqa: QF016\"\n{two}"),
        format!("{two}/\n/ qlinter: noqa: QF016\n\\\n"),
    ] {
        assert!(
            codes(&wrapped).iter().any(|(_, c)| c == "QF016"),
            "{wrapped:?}"
        );
    }
    assert!(has(
        &format!("{two}\\\n/ qlinter: noqa: QF016\n"),
        1,
        "QF016"
    ));
}

fn suppressed_in_file(source: &str, code: &str) -> Option<String> {
    let findings = lint(source, "t.q", Profile::Uqf);
    let finding = findings.iter().find(|f| f.code == code)?;
    let fix = file_suppression_for(finding, source)?;
    assert!(!fix.batch_safe);
    assert_eq!(fix.title, format!("Suppress {code} in this file"));
    let mut out = source.to_string();
    out.replace_range(fix.start..fix.end, &fix.replacement);
    Some(out)
}

#[test]
fn a_file_suppression_writes_a_directive_or_adds_to_it() {
    let two = "f:{[dt;data] dt}\ng:{[dt;data] dt}\n";
    let written = suppressed_in_file(two, "QF016").unwrap();
    assert_eq!(written, format!("/ qlinter: noqa: QF016\n{two}"));
    assert!(!codes(&written).iter().any(|(_, c)| c == "QF016"));
    // Into the directive there, keeping its reason.
    let there = format!("/ qlinter: noqa: QS001 generated\n{two}");
    assert_eq!(
        suppressed_in_file(&there, "QF016").unwrap(),
        format!("/ qlinter: noqa: QS001, QF016 generated\n{two}")
    );
    // After a shebang and a byte-order mark, in the file's line endings.
    assert_eq!(
        suppressed_in_file(&format!("#!/usr/bin/env q\n{two}"), "QF016").unwrap(),
        format!("#!/usr/bin/env q\n/ qlinter: noqa: QF016\n{two}")
    );
    let crlf = two.replace('\n', "\r\n");
    assert_eq!(
        suppressed_in_file(&crlf, "QF016").unwrap(),
        format!("/ qlinter: noqa: QF016\r\n{crlf}")
    );
    // Before a block comment that opens the file, which stays one.
    let block = format!("/\nnotes\n\\\n{two}");
    let written = suppressed_in_file(&block, "QF016").unwrap();
    assert!(
        written.starts_with("/ qlinter: noqa: QF016\n/\n"),
        "{written}"
    );
    assert!(!codes(&written).iter().any(|(_, c)| c == "QF016"));
}

#[test]
fn no_file_suppression_where_the_structure_is_broken() {
    let broken = "f:{[dt;data] dt}\nb:(1\n";
    let findings = lint(broken, "t.q", Profile::Uqf);
    assert!(
        findings
            .iter()
            .all(|f| file_suppression_for(f, broken).is_none())
    );
}

/// `qlinter --isolated --profile uqf` over `path`, with `args` before it.
fn cli(path: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--isolated", "--profile", "uqf"])
        .args(args)
        .arg(path)
        .output()
        .unwrap()
}

#[test]
fn add_noqa_accepts_every_finding_and_a_second_run_changes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("a.q");
    // Two codes on line 2; line 3's noqa is joined, not doubled; a lambda's
    // finding is accepted on the line it is reported on. Line 3's QF016 is
    // stale - QF001 is reported there instead - and its QL003 is accepted
    // like any other finding.
    fs::write(
        &path,
        "my_var:1\nf:{[desc;dt;data] desc+dt}\ng:{[desc;data] 1} / noqa: QF016\nh:{[desc]\n  desc}\n",
    )
    .unwrap();
    assert_eq!(cli(&path, &[]).status.code(), Some(1));
    let added = cli(&path, &["--add-noqa"]);
    assert_eq!(added.status.code(), Some(0), "{added:?}");
    let err = String::from_utf8_lossy(&added.stderr);
    assert!(
        err.contains("added 6 noqa directive(s) in 1 file(s)"),
        "{err}"
    );
    let after = fs::read_to_string(&path).unwrap();
    assert_eq!(
        after,
        "my_var:1 / noqa: QS001\nf:{[desc;dt;data] desc+dt} / noqa: QF001, QF016\n\
         g:{[desc;data] 1} / noqa: QF016, QF001, QL003\nh:{[desc] / noqa: QF001\n  desc}\n"
    );
    let clean = cli(&path, &[]);
    assert_eq!(clean.status.code(), Some(0), "{clean:?}");
    let again = cli(&path, &["--add-noqa"]);
    assert_eq!(again.status.code(), Some(0), "{again:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), after);
}

#[test]
fn add_noqa_leaves_a_line_no_comment_can_follow_and_says_so() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("a.q");
    // The bare `/` that opens a block comment stops opening one with a
    // comment after it, so its QP001 is left, and the run is not clean.
    let source = "/\nnote\n\\\nmy_var:1\n";
    fs::write(&path, source).unwrap();
    let added = cli(&path, &["--add-noqa"]);
    assert_eq!(added.status.code(), Some(1), "{added:?}");
    let err = String::from_utf8_lossy(&added.stderr);
    assert!(err.contains("1 finding(s) left"), "{err}");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "/\nnote\n\\\nmy_var:1 / noqa: QS001\n"
    );
}

#[test]
fn an_unused_noqa_code_is_reported_and_a_used_one_is_not() {
    // QF016 fires on line 1 and not on line 2 (#1170).
    let source = "f:{[a;b] a} / noqa: QF016\ng:{[a] a} / noqa: QF016\n";
    assert!(!has(source, 1, "QL003"));
    assert!(has(source, 2, "QL003"));
    // One finding for a directive, naming every unused code.
    let both = lint(
        "g:{[a] a} / noqa: QF016, QF017 reason\n",
        "t.q",
        Profile::Uqf,
    );
    let unused: Vec<&Finding> = both.iter().filter(|f| f.code == "QL003").collect();
    assert_eq!(unused.len(), 1);
    assert!(
        unused[0]
            .detail
            .starts_with("Unused noqa codes: QF016, QF017;")
    );
    // A QE001 its noqa takes is used, though the early return dropped it.
    assert!(!has("a:(1 / noqa: QE001\nb:2\n", 1, "QL003"));
    // And QL003 named in the directive accepts the directive.
    assert!(!has("g:{[a] a} / noqa: QF016, QL003\n", 1, "QL003"));
}

#[test]
fn a_noqa_code_no_rule_of_this_run_could_report_is_not_reported() {
    // Another tool's code, qls's, and a rule the profile turns off: QS001
    // is styleq's, so under style it did not run, and may fire under styleq.
    let style = |s: &str| lint(s, "t.q", Profile::Style);
    for source in [
        "g:{[a] a} / noqa: QX999\n",
        "g:{[a] a} / noqa: QLS001\n",
        "g:{[a] a} / noqa: QS001\n",
    ] {
        assert!(!style(source).iter().any(|f| f.code == "QL003"), "{source}");
    }
    // Nor a line inside a block comment, or after the end of the script.
    assert!(!has("/\ng:{[a] a} / noqa: QF016\n\\\na:1\n", 2, "QL003"));
    assert!(!has("a:1\n\\\ng:{[a] a} / noqa: QF016\n", 3, "QL003"));
}

#[test]
fn a_noqa_for_a_rule_the_configuration_turns_off_is_kept_while_the_rule_would_fire() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("a.q");
    // Line 1's QF016 fires and is ignored: the noqa is there for a run that
    // turns it back on. Line 2's suppresses nothing in any run.
    fs::write(
        &path,
        "f:{[a;b] a} / noqa: QF016\ng:{[a] a} / noqa: QF016\n",
    )
    .unwrap();
    let out = cli(&path, &["--ignore", "QF016", "--format", "json"]);
    let text = String::from_utf8_lossy(&out.stdout);
    let found: serde_json::Value = serde_json::from_str(&text).unwrap();
    let lines: Vec<u64> = found
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["code"] == "QL003")
        .map(|f| f["line"].as_u64().unwrap())
        .collect();
    assert_eq!(lines, [2], "{text}");
}

/// `source` with QL003's fix on `line` applied, if it has one.
fn unused_fixed(source: &str, line: usize) -> Option<String> {
    let found = lint(source, "t.q", Profile::Uqf);
    let finding = found.iter().find(|f| f.code == "QL003" && f.line == line)?;
    let fix = q_lint_rs::fix_for(finding, source)?;
    assert!(!fix.batch_safe);
    let mut out = source.to_string();
    out.replace_range(fix.start..fix.end, &fix.replacement);
    Some(out)
}

#[test]
fn the_unused_noqa_fix_removes_the_code_or_the_directive() {
    assert_eq!(
        unused_fixed("g:{[a;b] a} / noqa: QF016, QB025, QF017\n", 1).as_deref(),
        Some("g:{[a;b] a} / noqa: QF016\n")
    );
    assert_eq!(
        unused_fixed("g:{[a] a}  / noqa: QF016 a reason\r\n", 1).as_deref(),
        Some("g:{[a] a}\r\n")
    );
    // A note before the directive stays.
    assert_eq!(
        unused_fixed("g:{[a] a} / note / noqa: QF016\n", 1).as_deref(),
        Some("g:{[a] a} / note\n")
    );
    // A comment line alone would be left blank, so it is only reported.
    assert!(has("/ noqa: QF016\na:1\n", 1, "QL003"));
    assert_eq!(unused_fixed("/ noqa: QF016\na:1\n", 1), None);
}
