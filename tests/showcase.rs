//! Check explanatory markers against actual diagnostic locations, including silence.
use q_lint_rs::{Profile, RULES, lint};
use std::collections::BTreeSet;

#[test]
fn showcase_reports_exactly_the_marked_lines_in_every_profile() {
    let source = include_str!("../examples/showcase.q");
    for profile in [
        Profile::General,
        Profile::Style,
        Profile::StyleQ,
        Profile::Uqf,
    ] {
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
    // Three rules cannot be shown on a marked line in the showcase: an
    // unbalanced delimiter stops the file being analysed at all, a BOM only
    // exists at the start of a file, and an injectable query evaluates a
    // string, which stops the name checks for the whole file.
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
        // Its example evaluates a string, which turns off every name-based
        // check in the file it is in.
        (
            "query-injection.q",
            include_str!("../examples/query-injection.q"),
            "QX001",
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
        .filter(|r| !NOT_SHOWN.contains(&r.code.as_str()))
        .map(|r| r.code.clone())
        .collect();
    assert_eq!(shown, available);
}

/// The rules no example can show, because this binary never reports them:
/// QF006 runs in a Python hook, and QLS001 comes only from qls.
const NOT_SHOWN: [&str; 2] = ["QF006", "QLS001"];

/// The README states how many codes the taxonomy holds and how many the
/// examples cover. Counts nobody checks go stale: they said 88 and 86 while
/// the taxonomy held 119 (#428).
#[test]
fn the_readme_rule_counts_match_the_taxonomy() {
    let readme = include_str!("../README.md")
        .replace("\r\n", "\n")
        .replace('\n', " ");
    let count = |before: &str, after: &str| -> usize {
        let start = readme
            .find(before)
            .unwrap_or_else(|| panic!("README lost `{before}`"));
        let rest = &readme[start + before.len()..];
        let end = rest
            .find(after)
            .unwrap_or_else(|| panic!("README lost `{after}`"));
        rest[..end].trim().parse().unwrap()
    };
    assert_eq!(count("The taxonomy contains", "codes."), RULES.len());
    assert_eq!(
        count("covers all", "rules available in this build"),
        RULES.len() - NOT_SHOWN.len()
    );
    let excluded = NOT_SHOWN.join(" and ");
    assert!(
        readme.contains(&format!("{excluded} are excluded")),
        "{excluded}"
    );
}
