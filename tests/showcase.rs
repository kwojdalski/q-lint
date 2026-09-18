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
    // Two rules cannot be shown on a marked line in the showcase: an
    // unbalanced delimiter stops the file being analysed at all, and a BOM
    // only exists at the start of a file.
    for (name, source, code) in [
        (
            "syntax-error.q",
            include_str!("../examples/syntax-error.q"),
            "QE001",
        ),
        (
            "byte-order-mark.q",
            include_str!("../examples/byte-order-mark.q"),
            "QE005",
        ),
    ] {
        let found: BTreeSet<_> = lint(source, name, Profile::Uqf)
            .into_iter()
            .map(|f| f.code)
            .collect();
        assert_eq!(found, BTreeSet::from([code.to_string()]), "{name}");
        shown.extend(found);
    }
    let available: BTreeSet<_> = RULES
        .iter()
        .filter(|r| !["QF006", "QLS001"].contains(&r.code.as_str()))
        .map(|r| r.code.clone())
        .collect();
    assert_eq!(shown, available);
}
