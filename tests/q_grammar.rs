//! `editors/vscode/syntaxes/q.tmLanguage.json` is generated from
//! `src/reserved.json`. This fails when a builtin is added there and the
//! grammar is not regenerated, so the editor never colours a different set of
//! names from the one the rules treat as reserved.
use std::process::Command;

#[test]
fn the_vscode_grammar_matches_the_reserved_names() {
    let root = env!("CARGO_MANIFEST_DIR");
    let out = Command::new("python3")
        .arg(format!("{root}/scripts/q_grammar.py"))
        .output()
        .expect("python3 scripts/q_grammar.py");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let generated = String::from_utf8(out.stdout).unwrap();
    let committed =
        std::fs::read_to_string(format!("{root}/editors/vscode/syntaxes/q.tmLanguage.json"))
            .unwrap_or_default();
    let norm = |s: &str| s.replace("\r\n", "\n").trim().to_string();
    assert_eq!(
        norm(&committed),
        norm(&generated),
        "\nthe VS Code grammar is stale. Regenerate it:\n  python3 scripts/q_grammar.py > editors/vscode/syntaxes/q.tmLanguage.json\n"
    );
}
