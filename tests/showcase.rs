//! Check explanatory markers against actual diagnostic locations, including silence.
use q_lint_rs::{Profile, RULES, lint};
use std::collections::BTreeSet;

#[test]
fn showcase_reports_exactly_the_marked_lines_in_every_profile() {
    let source = include_str!("../examples/showcase.q");
    for profile in [Profile::General, Profile::Style, Profile::Uqf] {
        let mut expected = BTreeSet::new();
        for (i, line) in source.lines().enumerate() {
            if let Some(codes) = line.trim_start().strip_prefix("/ expect-next: ") {
                for code in codes.split_whitespace() {
                    let rule = RULES.iter().find(|r| r.code == code).expect("known marker");
                    if profile.allows_scope(&rule.scope) {
                        expected.insert((i + 2, code.to_string()));
                    }
                }
            }
        }
        let actual: BTreeSet<_> = lint(source, "showcase.q", profile)
            .into_iter()
            .map(|f| (f.line, f.code))
            .collect();
        assert_eq!(actual, expected, "{profile:?}");
    }
}

#[test]
fn examples_cover_all_available_rules() {
    let mut shown: BTreeSet<_> = lint(
        include_str!("../examples/showcase.q"),
        "showcase.q",
        Profile::Uqf,
    )
    .into_iter()
    .map(|f| f.code)
    .collect();
    // An unbalanced delimiter stops the file being analysed at all, so the
    // one rule that reports it needs a file where it is the only finding.
    let found: BTreeSet<_> = lint(
        include_str!("../examples/syntax-error.q"),
        "syntax-error.q",
        Profile::Uqf,
    )
    .into_iter()
    .map(|f| f.code)
    .collect();
    assert_eq!(found, BTreeSet::from(["QE001".to_string()]));
    shown.extend(found);
    let available: BTreeSet<_> = RULES
        .iter()
        .filter(|r| !["QF006", "QLS001"].contains(&r.code.as_str()))
        .map(|r| r.code.clone())
        .collect();
    assert_eq!(shown, available);
}
