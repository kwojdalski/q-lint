use q_lint_rs::{Profile, lint};

#[test]
fn continued_calls_preserve_diagnostic_positions_and_ignore_comments() {
    for (code, call) in [
        ("QT016", "sqrt[\n / symbol argument\n `bad\n ]"),
        ("QT017", "mavg[\n 1.5;\n / values\n 1 2 3\n ]"),
        ("QT018", "cor[\n 1 2;\n 3 4 5\n ]"),
        ("QT019", "within[\n 1;\n 1 2 3\n ]"),
        ("QT014", "rotate[\n 1.5;\n \";]é\"\n ]"),
        ("QA010", "sum[\n \";]é\";\n 1\n ]"),
    ] {
        // The string before the call makes UTF-16 columns differ from bytes.
        let source = format!("f:{{[]\n \"é\"; {call}\n }}\n");
        for source in [source.clone(), source.replace('\n', "\r\n")] {
            let findings = lint(&source, "fixture.q", Profile::General);
            assert_eq!(findings.len(), 1, "{source}: {findings:?}");
            let f = &findings[0];
            assert_eq!(
                (&*f.code, f.line, f.column, &*f.severity),
                (code, 2, Some(7), "error")
            );
        }
    }
}
