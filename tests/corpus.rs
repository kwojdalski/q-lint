//! Holds the linter to what it says about idiomatic q.
//!
//! `tests/cases/` says what a rule should report. It cannot say what a rule
//! should stay *silent* on, because the same person writes the rule and its
//! cases and only thinks of shapes they already had in mind. Every false
//! positive this tool has shipped was found by running it over someone else's
//! q, not by a fixture.
//!
//! So this snapshots the findings on q built from the patterns that were
//! actually reported wrongly. A change that moves any of them fails here,
//! whatever the fixtures say. See `tests/corpus/README.md`.
use q_lint_rs::{Profile, lint};
use std::fmt::Write as _;

fn snapshot() -> String {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/corpus");
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .expect("tests/corpus")
        .filter_map(|e| {
            let p = e.ok()?.path();
            (p.extension()? == "q").then_some(p)
        })
        .collect();
    files.sort();
    let mut out = String::new();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let source = std::fs::read_to_string(&path).unwrap();
        for (label, profile) in [
            ("general", Profile::General),
            ("style", Profile::Style),
            ("styleq", Profile::StyleQ),
            ("uqf", Profile::Uqf),
        ] {
            let found = lint(&source, &name, profile);
            if found.is_empty() {
                let _ = writeln!(out, "{name} {label}: clean");
            } else {
                for f in found {
                    let _ = writeln!(out, "{name} {label}: {}:{} {}", f.line, f.code, f.detail);
                }
            }
        }
    }
    out
}

#[test]
fn idiomatic_q_says_what_it_said_before() {
    let expected_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/corpus/expected.txt");
    // Git hands this file back with CRLF on a Windows checkout while the
    // snapshot is built with LF, so the comparison has to ignore which - the
    // snapshot is about findings, not about how the file was checked out.
    let normalise = |s: &str| s.replace("\r\n", "\n").trim().to_string();
    let expected = normalise(&std::fs::read_to_string(expected_path).unwrap_or_default());
    let actual = normalise(&snapshot());
    assert_eq!(
        actual, expected,
        "\nThe findings on the regression corpus moved.\n\
         If that was the point of the change, rewrite the snapshot with:\n\
           cargo test --test corpus -- --ignored\n"
    );
}

/// Rewrites the snapshot. Ignored so it never runs as part of the suite - a
/// check that fixes itself when it fails is not a check.
#[test]
#[ignore]
fn rewrite_snapshot() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/corpus/expected.txt");
    std::fs::write(path, snapshot()).unwrap();
    eprintln!("wrote {path}");
}
