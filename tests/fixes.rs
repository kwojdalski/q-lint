use std::{fs, process::Command};

#[test]
fn diff_previews_and_fix_writes_only_batch_safe_edits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixes.q");
    let original = "\u{feff}\"😀\"; a:1==1; b:1!=2; c:1&&2; a+=1\r\n";
    fs::write(&path, original).unwrap();

    let preview = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .arg("--diff")
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(preview.status.code(), Some(1));
    let patch = String::from_utf8(preview.stdout).unwrap();
    assert!(patch.contains("@@ -1,1 +1,1 @@"), "{patch}");
    assert!(patch.contains("a:1=1; b:1<>2; c:1&&2; a+:1"), "{patch}");
    assert_eq!(fs::read_to_string(&path).unwrap(), original);

    let applied = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--fix", "--format", "json"])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(applied.status.code(), Some(1));
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "\"😀\"; a:1=1; b:1<>2; c:1&&2; a+:1\r\n"
    );
    let findings: serde_json::Value = serde_json::from_slice(&applied.stdout).unwrap();
    let foreign: Vec<_> = findings
        .as_array()
        .unwrap()
        .iter()
        .filter(|finding| finding["code"] == "QE004")
        .collect();
    assert_eq!(foreign.len(), 1, "{findings}");
    assert!(foreign[0]["detail"].as_str().unwrap().contains("&&"));
}

#[test]
fn fix_exits_cleanly_when_every_finding_was_fixed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("clean.q");
    fs::write(&path, "a:2\nb:a==1\n").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .arg("--fix")
        .arg(&path)
        .output()
        .unwrap();
    assert!(result.status.success(), "{:?}", result);
    assert_eq!(fs::read_to_string(&path).unwrap(), "a:2\nb:a=1\n");
    assert!(
        String::from_utf8(result.stdout)
            .unwrap()
            .contains("0 finding(s)")
    );
}

/// `f x` becomes `f[x]`, and the edit has to take in the whole argument -
/// q evaluates right to left, so everything to the right of the name is it.
/// The shapes that end an expression early are the point of the fixtures:
/// a `;` in a string is not one, a trailing comment is not part of the
/// argument, and a qSQL phrase is not rewritten at all.
#[test]
fn brackets_replace_a_juxtaposed_call_and_nothing_around_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("calls.q");
    let original = concat!(
        "f:{x+1}\n",
        "lg:{-1 x;}\n",
        "r1:f 3+4\n",
        "r2:$[1b;f 2;f 3]\n",
        "r3:f 2  / a trailing comment\n",
        "r4:f \"a;b\"\n",
        "lg \"hello\";\n",
        "t:([] v:1 2)\n",
        "r5:update w:f 1 from t\n",
    );
    std::fs::write(&path, original).unwrap();

    let applied = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--fix", "--profile", "uqf", "--format", "json"])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        concat!(
            "f:{x+1}\n",
            "lg:{-1 x;}\n",
            "r1:f[3+4]\n",
            "r2:$[1b;f[2];f[3]]\n",
            "r3:f[2]  / a trailing comment\n",
            "r4:f[\"a;b\"]\n",
            "lg[\"hello\"];\n",
            "t:([] v:1 2)\n",
            "r5:update w:f 1 from t\n",
        )
    );
    // The qSQL line keeps its finding rather than being rewritten wrongly:
    // `from` ends the expression there, and this tool does not parse.
    let findings: serde_json::Value = serde_json::from_slice(&applied.stdout).unwrap();
    let remaining: Vec<_> = findings
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["code"] == "QP006")
        .collect();
    assert_eq!(remaining.len(), 1, "{findings}");
    assert_eq!(remaining[0]["line"], 9);
}

/// Nothing to rewrite outside the profile that asks for it. The CLI's own
/// default is `uqf`; `general` is the one that answers only "would q refuse
/// this", and juxtaposition is not something q refuses.
#[test]
fn juxtaposition_is_left_alone_outside_the_uqf_profile() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("calls.q");
    let original = "f:{x+1}\nr:f 2\n";
    fs::write(&path, original).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--fix", "--profile", "general"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(result.status.success(), "{result:?}");
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn a_file_that_is_not_utf8_is_linted_but_never_rewritten() {
    // Latin-1, as KX's e/c.q is after its closing backslash. q reads bytes,
    // so the file is q; the linter reads each invalid byte as one character,
    // which keeps the column of everything after it.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("latin.q");
    let original = b"x:1\r\n\xb7 y:1==2\r\n".to_vec();
    fs::write(&path, &original).unwrap();

    let lint = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--format", "json"])
        .arg(&path)
        .output()
        .unwrap();
    let findings: serde_json::Value = serde_json::from_slice(&lint.stdout).unwrap();
    let foreign: Vec<_> = findings
        .as_array()
        .unwrap()
        .iter()
        .filter(|finding| finding["code"] == "QE004")
        .collect();
    assert_eq!(foreign.len(), 1, "{findings}");
    assert_eq!(
        (foreign[0]["line"].as_u64(), foreign[0]["column"].as_u64()),
        (Some(2), Some(6))
    );

    let fix = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .arg("--fix")
        .arg(&path)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&fix.stderr).contains("not valid UTF-8, skipped"));
    assert_eq!(fs::read(&path).unwrap(), original);
}

/// Each rewrite, and whether `--fix` may apply it unattended. The batch-safe
/// ones were checked in q 5 to leave the program's value alone, or to replace
/// code that could only fail; the others change behaviour or guess at
/// intent, so the editor offers them and a person accepts or not.
#[test]
fn each_fix_rewrites_to_the_right_text_and_says_whether_it_is_batch_safe() {
    use q_lint_rs::{Profile, fix_for, lint};
    let cases = [
        (
            "QB007",
            "r:select from t where s like `a*",
            "r:select from t where s like \"a*\"",
            true,
        ),
        (
            "QB007",
            "r:\"abc\" like `abc",
            "r:\"abc\" like \"abc\"",
            true,
        ),
        ("QT007", "r:ss[`abc;\"b\"]", "r:ss[\"abc\";\"b\"]", false),
        ("QB012", "f:{[x] x+1;}", "f:{[x] x+1}", false),
        ("QB010", "a:1;b:a -1", "a:1;b:a - 1", false),
        ("QR001", "r:reverse asc 3 1 2", "r:desc 3 1 2", false),
        ("QR002", "r:{x} each 1 2 3", "r:1 2 3", true),
        ("QR002", "r:count {x} each y", "r:count y", true),
        ("QR002", "r:{x}' y", "r:y", true),
        (
            "QR003",
            "r:distinct asc distinct 3 1 1",
            "r:asc distinct 3 1 1",
            true,
        ),
        ("QS004", "a:1;r:(a)+1", "a:1;r:a+1", true),
        ("QS004", "a:1;r:(a)b", "a:1;r:a b", true),
    ];
    for (code, source, expected, safe) in cases {
        let finding = lint(source, "probe.q", Profile::Uqf)
            .into_iter()
            .find(|f| f.code == code)
            .unwrap_or_else(|| panic!("{code} not reported on {source}"));
        let fix = fix_for(&finding, source).unwrap_or_else(|| panic!("no fix for {source}"));
        let fixed = format!(
            "{}{}{}",
            &source[..fix.start],
            fix.replacement,
            &source[fix.end..]
        );
        assert_eq!(fixed, expected, "{code}");
        assert_eq!(fix.batch_safe, safe, "{code}: {source}");
    }
}

/// Where taking the parentheses or the words away would read differently,
/// there is no fix - the finding stands for a person to look at.
#[test]
fn no_fix_where_the_rewrite_would_change_the_program() {
    use q_lint_rs::{Profile, fix_for, lint};
    for (code, source) in [
        ("QS004", "r:2 (3)"),          // would become the vector 2 3
        ("QS004", "r:(2)3"),           // would become the number 23
        ("QS004", "a:1;r:a -(1)"),     // would become a applied to -1
        ("QR002", "g:{x} each"),       // a function, with nothing to return
        ("QR002", "r:count {x}' b"),   // `{x}'` infix, `count` its left argument
        ("QT007", "r:ss[`a`b;\"b\"]"), // a symbol vector is not one string
    ] {
        for finding in lint(source, "probe.q", Profile::Uqf)
            .iter()
            .filter(|f| f.code == code)
        {
            assert!(fix_for(finding, source).is_none(), "{code} fixed {source}");
        }
    }
}
