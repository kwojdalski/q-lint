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
