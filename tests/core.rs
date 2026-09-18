use q_lint_rs::{Profile, lint};
#[test]
fn mutation_classes_and_valid_boundaries() {
    for (source, code) in [
        ("f:{[] `a`b!1 2 3}", "QT001"),
        ("f:{[r] r+1};f[`bad]", "QT002"),
        ("f:{[a] g:{[b] a+b};g[1]}", "QF005"),
        ("{[a;b]a+b}[1;2;3]", "QA002"),
    ] {
        assert!(
            lint(source, "t.q", Profile::Style)
                .iter()
                .any(|f| f.code == code)
        );
    }
    for source in [
        "f:{[k;v] k!v}",
        "f:{[r] r+1};f[2]",
        "f:{[a] g:{[a;b] a+b};g[a;1]}",
        "{[a;b]a+b}[1;]",
    ] {
        assert!(lint(source, "t.q", Profile::Style).is_empty());
    }
}
#[test]
fn utf16_ranges_and_literal_masking() {
    let f = lint("s:\"😀\";f:{]", "t.q", Profile::Style);
    assert_eq!(f[0].column, Some(11));
    assert_eq!(f[0].code, "QE001");
    assert!(lint("s:\"{[desc]} / hi\"; / (]", "t.q", Profile::Style).is_empty());
}
#[test]
fn arbitrary_text_does_not_panic() {
    let chars = [
        'a', '1', 'é', '😀', ' ', '\n', '\r', '\t', '/', '\\', '\"', '\'', ':', ';', '(', ')', '[',
        ']', '{', '}', '`',
    ];
    let mut state = 13u64;
    for _ in 0..2000 {
        let mut s = String::new();
        for _ in 0..80 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            s.push(chars[(state >> 32) as usize % chars.len()]);
        }
        assert!(
            std::panic::catch_unwind(|| lint(&s, "t.q", Profile::Uqf)).is_ok(),
            "Input: {s:?}"
        );
    }
}

#[test]
fn language_prefixes_preserve_following_q_diagnostics() {
    for prefix in ["p)", "k)"] {
        let foreign = format!("{prefix}def f():\n\n    \"\"\"😀 {{[desc] . ()\\q\n    /\n\n");
        assert!(lint(&foreign, "t.q", Profile::Uqf).is_empty());
        let findings = lint(&format!("{foreign}q)f:{{]\n"), "t.q", Profile::Style);
        assert_eq!(
            (&*findings[0].code, findings[0].line, findings[0].column),
            ("QE001", 6, Some(6))
        );
        let findings = lint(
            &format!("{foreign}f:{{[desc] desc}}\n"),
            "t.q",
            Profile::Style,
        );
        assert_eq!((&*findings[0].code, findings[0].line), ("QF001", 6));
    }
    assert!(lint("q)/ bad )\nx:1\n", "t.q", Profile::Style).is_empty());
    assert_eq!(lint("a)x:1\n", "t.q", Profile::Style)[0].code, "QE001");
}

/// The cases here were settled by running each one through a real q 4.x and
/// asking it what the lambda's parameters actually are (`value value`), not by
/// reading the reference manual. q accepts more in a parameter list than one
/// would guess - `.q.z` is a legal parameter name, `{[a;b;] ...}` takes three
/// arguments - and reads the brackets as body text rather than a signature
/// whenever a slot is not a name, which is the trap QF007 exists for.
#[test]
fn parameter_lists_agree_with_q() {
    // q reports the declared names: these are signatures.
    for source in [
        "f:{[a] a+1}",
        "f:{[a;b] a+b}",
        "f:{[] 42}",
        "f:{[a]x+1}",
        "f:{[ a ; b ] a}",
        "f:{[a_b] a_b+1}",
        "f:{[.q.z] 1}",
        "f:{[a;b;c;d;e;f;g;h] a}",
        "f:{x+1}",
    ] {
        let found = lint(source, "t.q", Profile::Style);
        assert!(
            !found.iter().any(|f| f.code == "QF007"),
            "{source:?} is a parameter list to q: {found:?}"
        );
    }
    // q falls back to implicit arguments, or refuses the source outright.
    for source in [
        "f:{[tables[]] x+1}", // 'nyi
        "f:{[a+b] 1}",        // 'nyi
        "f:{[1] x+1}",
        "f:{[`s] x+1}",
        "f:{[a b] a}",
        "f:{[a[0]] a}",
        "f:{[a:1] a}",
        "f:{[\"s\"] 1}", // blank once literals are masked; still not a name
    ] {
        assert!(
            lint(source, "t.q", Profile::Style)
                .iter()
                .any(|f| f.code == "QF007"),
            "{source:?} is not a parameter list to q"
        );
    }
}

#[test]
fn parameter_rules_for_lists_q_does_accept() {
    for (source, code) in [
        ("f:{[_] x+1}", "QF002"), // `_` is the drop operator, never a parameter
        ("f:{[a;a] a}", "QF008"), // rank 2, and applying it projects
        ("f:{[a;b;a] a}", "QF008"),
        ("f:{[a;b;] a}", "QF009"), // q names the third parameter `2`
        ("f:{[;a] a}", "QF009"),
        ("f:{[a] x+1}", "QF010"), // 'x at runtime: x is a global here
        ("f:{[a] z*2}", "QF010"),
    ] {
        assert!(
            lint(source, "t.q", Profile::Style)
                .iter()
                .any(|f| f.code == code),
            "{source:?} should raise {code}"
        );
    }
    // A signature that declares nothing is the one empty slot that is real,
    // and an implicit-argument lambda has no signature to contradict.
    for source in [
        "f:{[] 42}",
        "f:{x+1}",
        "f:{[a] a+1}",
        "f:{[x] x+1}",
        "x:1;f:{[a] x+1}",         // x is a global that exists
        "f:{[t] select x from t}", // x is a column, not an argument
    ] {
        let found = lint(source, "t.q", Profile::Style);
        assert!(
            !found
                .iter()
                .any(|f| matches!(&*f.code, "QF008" | "QF009" | "QF010")),
            "{source:?} should be clean: {found:?}"
        );
    }
}

/// Windows checks files out with CRLF by default, so a rule that is blind to
/// `\r` reports one thing on the maintainer's machine and another on a user's.
/// The showcase is the widest q this repository has, which makes it the best
/// single input to hold both line endings to the same answer.
#[test]
fn line_endings_do_not_change_the_findings() {
    let lf = include_str!("../examples/showcase.q");
    let crlf = lf.replace('\n', "\r\n");
    for profile in [Profile::Style, Profile::Uqf] {
        let a: Vec<_> = lint(lf, "t.q", profile)
            .into_iter()
            .map(|f| (f.line, f.code))
            .collect();
        let b: Vec<_> = lint(&crlf, "t.q", profile)
            .into_iter()
            .map(|f| (f.line, f.code))
            .collect();
        assert_eq!(a, b, "CRLF changed the findings ({profile:?})");
    }
}

/// A BOM is reported without stopping the rest of the analysis: the author of
/// a file q will not load still wants to know what else is wrong with it.
#[test]
fn a_byte_order_mark_is_reported_and_analysis_continues() {
    let plain = "f:{[a] a+`x}\n";
    let with_bom = format!("\u{feff}{plain}");
    let codes = |s: &str| -> Vec<String> {
        lint(s, "t.q", Profile::General)
            .into_iter()
            .map(|f| f.code)
            .collect()
    };
    assert_eq!(codes(plain), ["QT003"]);
    assert_eq!(codes(&with_bom), ["QE005", "QT003"]);
}
