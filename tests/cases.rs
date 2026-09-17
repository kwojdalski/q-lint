//! Runs the fixture cases in `tests/cases/`.
//!
//! The cases are data rather than Rust so that adding one costs a line in a
//! text file, and so that the negative cases - source that must stay silent -
//! sit next to the positives they are the counterweight to. See
//! `tests/cases/README.md` for the format.
use q_lint_rs::lint;
use std::collections::BTreeSet;
use std::fmt::Write as _;

struct Case {
    file: String,
    line: usize,
    title: String,
    expected: BTreeSet<String>,
    profile_uqf: bool,
    source: String,
}

fn parse(file: &str, text: &str) -> Vec<Case> {
    let mut cases: Vec<Case> = vec![];
    for (i, line) in text.lines().enumerate() {
        if let Some(header) = line.strip_prefix("=== ") {
            let (codes, title) = header.split_once('|').unwrap_or((header, ""));
            let mut expected = BTreeSet::new();
            let mut profile_uqf = false;
            let mut tokens = codes.split_whitespace().peekable();
            while let Some(token) = tokens.next() {
                match token {
                    "clean" => {}
                    "profile:" => profile_uqf = tokens.next() == Some("uqf"),
                    code => {
                        expected.insert(code.to_string());
                    }
                }
            }
            cases.push(Case {
                file: file.into(),
                line: i + 1,
                title: title.trim().into(),
                expected,
                profile_uqf,
                source: String::new(),
            });
        } else if let Some(case) = cases.last_mut() {
            case.source.push_str(line);
            case.source.push('\n');
        }
    }
    for case in &mut cases {
        case.source = case.source.trim_matches('\n').to_string();
        case.source.push('\n');
    }
    cases
}

#[test]
fn every_case_says_what_it_means() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases");
    let mut cases = vec![];
    for entry in std::fs::read_dir(dir).expect("tests/cases") {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "cases") {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            cases.extend(parse(&name, &std::fs::read_to_string(&path).unwrap()));
        }
    }
    assert!(cases.len() > 50, "expected a corpus, found {}", cases.len());

    let mut failures = String::new();
    for case in &cases {
        let found: BTreeSet<String> = lint(&case.source, "t.q", case.profile_uqf)
            .into_iter()
            .map(|f| f.code.to_string())
            .collect();
        // Both directions: a missed code is a hole, an extra one is noise, and
        // a linter is only as useful as the second of those is rare.
        let missing: Vec<_> = case.expected.difference(&found).collect();
        let unexpected: Vec<_> = found.difference(&case.expected).collect();
        if !missing.is_empty() || !unexpected.is_empty() {
            let _ = write!(
                failures,
                "\n{}:{} {}\n  source:   {}\n  expected: {:?}\n  found:    {:?}\n",
                case.file,
                case.line,
                case.title,
                case.source.trim_end().replace('\n', "\\n"),
                case.expected,
                found
            );
        }
    }
    assert!(failures.is_empty(), "{} cases:{failures}", cases.len());
}
