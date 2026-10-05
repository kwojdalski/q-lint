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
        ("QE002", "p:\"C:\\data\"", "p:\"C:\\\\data\"", true),
        (
            "QF015",
            "f:{[x] if[x;:true]; x}",
            "f:{[x] if[x;:1b]; x}",
            true,
        ),
        ("QF015", "r:(1b;false)", "r:(1b;0b)", true),
        ("QF015", "r:None", "r:(::)", true),
        ("QF015", "f:{[x] return x+1}", "f:{[x] :x+1}", true),
        ("QF015", "f:{[x] a:x; return a}", "f:{[x] a:x; :a}", true),
        (
            "QT005",
            "t:([]a:1;b:`x)",
            "t:([]a:enlist 1;b:enlist `x)",
            true,
        ),
        (
            "QB015",
            "t:([]s:`ab`cd);r:select from t where s=\"ab\"",
            "t:([]s:`ab`cd);r:select from t where s like \"ab\"",
            true,
        ),
        ("QP005", "r:2*3+4", "r:2*(3+4)", true),
        ("QP005", "a:1;r:a*a*a+1", "a:1;r:a*a*(a+1)", true),
        ("QP005", "a:1;r:a+a*a-1", "a:1;r:a+(a*a-1)", true),
        (
            "QB008",
            "t:([]s:`a`b`c);r:select from t where s=`a`b",
            "t:([]s:`a`b`c);r:select from t where s in `a`b",
            false,
        ),
        (
            "QA008",
            "f:{[a;b] a+b};r:f(1;2)",
            "f:{[a;b] a+b};r:f[1;2]",
            false,
        ),
        ("QT004", "r:`int$\"12\"", "r:\"I\"$\"12\"", false),
        ("QB020", "f:{[x] :x; x+1}", "f:{[x] :x}", false),
        ("QF017", "f:{[x] a:x+1; x}", "f:{[x] x+1; x}", false),
        ("QP003", "r:.z.P", "r:.z.p", false),
        (
            "QB006",
            "t:([]a:1 2;b:3 4);r:select from t where a=1 and b=3",
            "t:([]a:1 2;b:3 4);r:select from t where (a=1) and b=3",
            false,
        ),
        (
            "QB006",
            "t:([]a:1 2;b:3 4);r:select from t where a>1 or b<=4, a<3;",
            "t:([]a:1 2;b:3 4);r:select from t where (a>1) or b<=4, a<3;",
            false,
        ),
        ("QR004", "r:{x+1} each 1 2 3", "r:1 2 3+1", false),
        ("QR004", "r:{2-x} each a,b", "r:2-a,b", false),
        ("QR004", "r:{x%2} each a,b", "r:(a,b)%2", false),
        ("QR004", "r:count {x*2} each b", "r:count b*2", false),
        ("QL002", "a:1\n/ old:{x+1}\nb:2", "a:1\nb:2", false),
        (
            "QB005",
            "t:([]a:1 2);r:select from t where a~1",
            "t:([]a:1 2);r:select from t where a=1",
            false,
        ),
        ("QF010", "f:{[a] x+1}", "f:{[a] a+1}", false),
        ("QA004", "f:{1};r:f . ()", "f:{1};r:f[]", true),
        ("QT008", "r:til 5.0", "r:til 5", true),
        ("QT008", "r:til 3f", "r:til 3", true),
        ("QT025", "f:{'5}", "f:{'\"5\"}", true),
        (
            "QF005",
            "f:{[a] {a+x} each 1 2}",
            "f:{[a] {[a;x] a+x}[a] each 1 2}",
            false,
        ),
        (
            "QF005",
            "f:{[a] {[x;y] a+y}'[1 2;3 4]}",
            "f:{[a] {[a;x;y] a+y}[a]'[1 2;3 4]}",
            false,
        ),
        (
            "QF005",
            "f:{[a] {a+y}'[1 2;3 4]}",
            "f:{[a] {[a;x;y] a+y}[a]'[1 2;3 4]}",
            false,
        ),
        (
            "QF005",
            "f:{[a] g:{a}; g 1}",
            "f:{[a] g:{[a;x] a}[a]; g 1}",
            false,
        ),
        ("QA007", "f:{[c] $[c;1;2;]}", "f:{[c] $[c;1;2]}", false),
        ("QA006", "f:{[c] $[c;1]}", "f:{[c] if[c;1]}", false),
        (
            "QT028",
            "t:([]a:1 2);r:select from t where a:1",
            "t:([]a:1 2);r:select from t where a=1",
            true,
        ),
        ("QT014", "r:2.0 rotate 1 2 3", "r:2 rotate 1 2 3", true),
        ("QT017", "r:3f mavg 1 2 3", "r:3 mavg 1 2 3", true),
        ("QB014", "r:10/2", "r:10%2", false),
        ("QB017", "a:1\na:a\nb:2", "a:1\nb:2", false),
        ("QB017", "a:1;a:a;b:2", "a:1;b:2", false),
        ("QP002", "r:`datetime$x", "r:`timestamp$x", false),
        ("QP002", "r:2026.01.01T12:00", "r:2026.01.01D12:00", false),
        (
            "QF001",
            "f:{[count] count+{count x}[count]}",
            "f:{[countArg] countArg+{count x}[countArg]}",
            false,
        ),
        (
            "QF020",
            "t:([]price:1 2);r:select prce from t",
            "t:([]price:1 2);r:select price from t",
            false,
        ),
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
        ("QS004", "r:2 (3)"),                // would become the vector 2 3
        ("QS004", "r:(2)3"),                 // would become the number 23
        ("QS004", "a:1;r:a -(1)"),           // would become a applied to -1
        ("QR002", "g:{x} each"),             // a function, with nothing to return
        ("QR002", "r:count {x}' b"),         // `{x}'` infix, `count` its left argument
        ("QT007", "r:ss[`a`b;\"b\"]"),       // a symbol vector is not one string
        ("QF015", "f:{[x] a:return x}"),     // `return` mid-expression
        ("QF015", "f:{[x] if[x;break]; x}"), // no q spelling for break
        ("QB015", "t:([]s:`ab);r:select from t where s=\"a*\""), // a pattern
        ("QB020", "f:{[x] :x;\n  x+1}"),     // across lines
        ("QP005", "r:select mid:0.5*bid+ask from q"), // qSQL columns
        ("QP005", "tanh:1f-2f%1f+exp 2f*"),  // a composition
        ("QR004", "r:count {x+1}' b"),       // `{x+1}'` infix
        ("QF010", "f:{[a;b] x+a}"),          // which parameter?
        ("QT008", "r:til 2.5"),              // no long it spells
        ("QF020", "t:([]ab:1 2;ac:3 4);r:select a from t"), // two equally close
        ("QA007", "f:{[c] $[c;1;2;3]}"),     // no empty slot
    ] {
        for finding in lint(source, "probe.q", Profile::Uqf)
            .iter()
            .filter(|f| f.code == code)
        {
            assert!(fix_for(finding, source).is_none(), "{code} fixed {source}");
        }
    }
}

/// `--unsafe-fixes` adds the editor-only fixes to `--diff` and `--fix`, and
/// `--diff` stays a patch that applies when a fix removes a whole line: the
/// hunks are built from the edits, not by pairing lines, and a last line
/// without a newline is marked the way `patch` expects.
#[test]
fn unsafe_fixes_and_a_diff_that_survives_a_removed_line() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("lines.q");
    fs::write(&path, "a:1\n/ old:{x+1}\nb:a==1\nr:reverse asc 3 1 2").unwrap();
    let run = |flags: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(["--profile", "styleq"])
            .args(flags)
            .arg(&path)
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap()
    };
    let safe = run(&["--diff"]);
    assert!(safe.contains("@@ -3,1 +3,1 @@\n-b:a==1\n+b:a=1"), "{safe}");
    assert!(!safe.contains("old:"), "{safe}");

    let all = run(&["--diff", "--unsafe-fixes"]);
    assert!(all.contains("@@ -2,1 +1,0 @@\n-/ old:{x+1}\n"), "{all}");
    assert!(all.contains("@@ -3,1 +2,1 @@\n-b:a==1\n+b:a=1"), "{all}");
    assert!(
        all.contains(
            "@@ -4,1 +3,1 @@\n-r:reverse asc 3 1 2\n\\ No newline at end of file\n+r:desc 3 1 2\n\\ No newline at end of file"
        ),
        "{all}"
    );

    run(&["--fix", "--unsafe-fixes"]);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "a:1\nb:a=1\nr:desc 3 1 2"
    );
}
