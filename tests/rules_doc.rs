//! `docs/rules.md` is generated from the taxonomy. This fails when someone
//! adds a rule and does not regenerate it, which is the only way a generated
//! document stays honest.
use std::process::Command;

#[test]
fn the_rules_document_matches_the_taxonomy() {
    let root = env!("CARGO_MANIFEST_DIR");
    let out = Command::new("python3")
        .arg(format!("{root}/scripts/rules_doc.py"))
        .output()
        .expect("python3 scripts/rules_doc.py");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let generated = String::from_utf8(out.stdout).unwrap();
    let committed = std::fs::read_to_string(format!("{root}/docs/rules.md")).unwrap_or_default();
    let norm = |s: &str| s.replace("\r\n", "\n").trim().to_string();
    assert_eq!(
        norm(&committed),
        norm(&generated),
        "\ndocs/rules.md is stale. Regenerate it:\n  python3 scripts/rules_doc.py > docs/rules.md\n"
    );
}

/// A diagnostic's code links to its rule's row (`rule_url`), which is there
/// only as long as the generator writes an anchor of that name on it. Every
/// rule has exactly one, on its own row, and no code that is not a rule has
/// a link at all.
#[test]
fn every_rule_has_the_anchor_its_diagnostics_link_to() {
    let root = env!("CARGO_MANIFEST_DIR");
    let document = std::fs::read_to_string(format!("{root}/docs/rules.md")).unwrap();
    assert!(q_lint_rs::RULES.len() > 100, "{}", q_lint_rs::RULES.len());
    for rule in q_lint_rs::RULES.iter() {
        let code = rule.code.as_str();
        let url = q_lint_rs::rule_url(code).unwrap_or_else(|| panic!("{code} has no link"));
        let (page, anchor) = url.split_once('#').unwrap();
        assert_eq!(
            page,
            "https://github.com/kwojdalski/q-lint/blob/master/docs/rules.md"
        );
        // Lower case, which GitHub folds an anchor's name to.
        assert_eq!(anchor, code.to_lowercase());
        let row = format!("| <a id=\"{anchor}\"></a>`{code}` |");
        assert_eq!(
            document.matches(&row).count(),
            1,
            "docs/rules.md has no row for {code} that starts {row:?}"
        );
        assert_eq!(
            document.matches(&format!("id=\"{anchor}\"")).count(),
            1,
            "{anchor} is the anchor of more than one place"
        );
    }
    assert_eq!(q_lint_rs::rule_url("QZ999"), None);
    assert_eq!(q_lint_rs::rule_url(""), None);
}
