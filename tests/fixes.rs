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
/// argument, and in a qSQL phrase `from` is.
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
            "r5:update w:f[1] from t\n",
        )
    );
    // `from` ends the expression in the qSQL line, so the bracket closes
    // before it (q 5: the two parse alike).
    let findings: serde_json::Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert!(
        findings
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["code"] != "QP006"),
        "{findings}"
    );
}

/// Inside a qSQL phrase the argument ends where the phrase's own grammar
/// ends it: a top-level comma separates columns (or `where` constraints),
/// and `by` and `from` close the list. Parse trees checked in q 5:
/// `select s:g v,m:avg v by k from t` is `select s:g[v],m:avg v by k from t`,
/// and `select v:g c where e from t` is `g[c where e]`: before `from`, `where`
/// is the function (#771).
/// Before #111 the multi-line form became `.ns.f[v,m:avg v\n by k from t]`,
/// which does not load. After `from` the table is one whole expression -
/// `select from g v,w` reads `g[v,w]` - so a call there is left alone.
#[test]
fn a_call_in_a_query_is_bracketed_up_to_the_column_it_belongs_to() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("query.q");
    let original = concat!(
        "\\d .ns\n",
        "f:{[x] sum x}\n",
        "g:{[t]\n",
        "    a:select n:count i,\n",
        "        s:.ns.f v,m:avg v\n",
        "        by k from t;\n",
        "    a}\n",
        "h:{[t] select from t where 0<.ns.f v,w>0}\n",
        "j:{[t] select from 0#.ns.f t,t}\n",
        "k:{[t] select v:.ns.f c where e from t}\n",
        "\\d .\n",
    );
    fs::write(&path, original).unwrap();
    let applied = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args([
            "--fix",
            "--isolated",
            "--profile",
            "uqf",
            "--format",
            "json",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        concat!(
            "\\d .ns\n",
            "f:{[x] sum x}\n",
            "g:{[t]\n",
            "    a:select n:count i,\n",
            "        s:.ns.f[v],m:avg v\n",
            "        by k from t;\n",
            "    a}\n",
            "h:{[t] select from t where 0<.ns.f[v],w>0}\n",
            "j:{[t] select from 0#.ns.f t,t}\n",
            "k:{[t] select v:.ns.f[c where e] from t}\n",
            "\\d .\n",
        )
    );
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

/// A multi-byte character before a call in a query: the clause scan walks
/// bytes, and once sliced the code inside `é` and panicked (#352).
#[test]
fn a_query_fix_after_a_multibyte_character_does_not_panic() {
    use q_lint_rs::{Profile, fixes_for, lint};
    let source = "g:{x}\nt:([]a:1 2)\nr:select c:`\u{e9}, d:g a from t\n";
    let findings = lint(source, "probe.q", Profile::Uqf);
    let fixes = fixes_for(findings.iter().filter(|f| f.code == "QP006"), source);
    assert_eq!(fixes.len(), 1, "{findings:?}");
    assert_eq!(fixes[0].replacement, "g[a]");
}

/// A fix whose start follows a multi-byte character inside the token before
/// it - the BOM QE005 exists for, or `é` in a symbol: `ends_in_number` stepped
/// one byte past that character and sliced inside it (#398).
#[test]
fn a_fix_after_a_multibyte_token_does_not_panic() {
    use q_lint_rs::{Profile, fixes_for, lint};
    for (profile, source) in [
        (Profile::Uqf, "\u{feff}r:{x} each 1 2\n"),
        (Profile::General, "\u{feff}a==b\n"),
        (Profile::Uqf, "\u{feff}r:til 5.0\n"),
        (Profile::Uqf, "r:`caf\u{e9}==`b\n"),
    ] {
        let findings = lint(source, "probe.q", profile);
        assert!(!fixes_for(&findings, source).is_empty(), "{source:?}");
    }
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

    // Under --fix and --diff the file is still linted and its findings
    // still decide the exit code; only the rewrite is withheld.
    let fix = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--fix", "--format", "json"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&fix.stderr).contains("not fixed"));
    assert_eq!(fix.status.code(), Some(1), "{fix:?}");
    let after: serde_json::Value = serde_json::from_slice(&fix.stdout).unwrap();
    assert!(
        after
            .as_array()
            .unwrap()
            .iter()
            .any(|finding| finding["code"] == "QE004"),
        "{after}"
    );
    assert_eq!(fs::read(&path).unwrap(), original);

    let diff = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .arg("--diff")
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(diff.status.code(), Some(1), "{diff:?}");
    assert!(String::from_utf8_lossy(&diff.stderr).contains("not shown"));
    assert_eq!(fs::read(&path).unwrap(), original);
}

/// Each rewrite, and whether `--fix` may apply it unattended. The batch-safe
/// ones were checked in q 5 to leave the program's value alone, or to replace
/// code that could only fail; the others change behaviour or guess at
/// intent, so the editor offers them and a person accepts or not.
/// A file whose brackets or strings do not close is never rewritten, even
/// with QE001 deselected: after the open `"` q reads `t:f 2` as string, and
/// bracketing it would write into that string (#775, the CLI side of #422).
#[test]
fn a_file_whose_structure_does_not_close_is_not_fixed() {
    let directory = tempfile::tempdir().unwrap();
    for (name, original) in [
        ("string.q", "f:{x+1}\nr:f \"a\nt:f 2\n"),
        ("paren.q", "f:{x+1}\ns:(1;2\nt:f 2\n"),
    ] {
        let path = directory.path().join(name);
        fs::write(&path, original).unwrap();
        for flag in ["--diff", "--fix"] {
            let run = Command::new(env!("CARGO_BIN_EXE_qlinter"))
                .args(["--isolated", "--select", "QP006", flag])
                .arg(&path)
                .output()
                .unwrap();
            if flag == "--diff" {
                assert!(run.stdout.is_empty(), "{name}: {run:?}");
            }
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                original,
                "{name} {flag}"
            );
        }
    }
}

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
        // A path symbol takes its `/`: cut there, `/c` is refused (#768).
        ("QB007", "a like `:b/c", "a like \":b/c\"", true),
        // One character in quotes is a char atom, still 'type (#564).
        ("QB007", "r:s like `a", "r:s like enlist\"a\"", true),
        ("QT007", "r:ss[`abc;\"b\"]", "r:ss[\"abc\";\"b\"]", false),
        ("QB012", "f:{[x] x+1;}", "f:{[x] x+1}", false),
        ("QB010", "a:1;b:a -1", "a:1;b:a - 1", false),
        ("QR001", "r:reverse asc 3 1 2", "r:desc 3 1 2", false),
        ("QR002", "r:{x} each 1 2 3", "r:1 2 3", false),
        ("QR002", "r:count {x} each y", "r:count y", false),
        ("QR002", "r:{x}' y", "r:y", false),
        ("QR002", "a:1 2 3;r:a{x} each 0 2", "a:1 2 3;r:a 0 2", false),
        ("QR002", "b:0 2;r:0 1 2{x} each b", "b:0 2;r:0 1 2 b", false),
        // A `-` left against the number would make it a negative literal
        // and the subtraction an application (#207).
        ("QR002", "r:a -{x} each 1 2", "r:a - 1 2", false),
        ("QR002", "r:a -{x} each .5", "r:a - .5", false),
        (
            "QR003",
            "r:distinct asc distinct 3 1 1",
            "r:asc distinct 3 1 1",
            true,
        ),
        ("QS004", "a:1;r:(a)+1", "a:1;r:a+1", true),
        ("QS004", "a:1;r:(a)b", "a:1;r:a b", true),
        ("QS004", "a:1;r:a (b)", "a:1;r:a b", true),
        ("QS004", "a:1;r:\"ab\"(1)", "a:1;r:\"ab\" 1", true),
        // A symbol ending in `:` or `/` would take the name in (#776).
        ("QS004", "`:db/(t)", "`:db/ t", true),
        ("QS004", "`:(k)", "`: k", true),
        ("QS004", "`a:(k)", "`a: k", true),
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
            false,
        ),
        ("QP005", "r:2*3+4", "r:2*(3+4)", true),
        ("QP005", "a:1;r:a*a*a+1", "a:1;r:a*a*(a+1)", true),
        ("QP005", "a:1;r:a+a*a-1", "a:1;r:a+(a*a-1)", true),
        // Before a semicolon, in a lambda and in a bracket (#511).
        ("QP005", "h:2*3+4;", "h:2*(3+4);", true),
        ("QP005", "g:{[a;b] a*b+1}", "g:{[a;b] a*(b+1)}", true),
        ("QP005", "k:(2*3+4)", "k:(2*(3+4))", true),
        (
            "QB008",
            "t:([]s:`a`b`c);r:select from t where s=`a`b",
            "t:([]s:`a`b`c);r:select from t where s in `a`b",
            false,
        ),
        (
            "QB008",
            "t:([]a:1 2 3;s:`a`b`c);r:select from t where a>1,s=`a`b",
            "t:([]a:1 2 3;s:`a`b`c);r:select from t where a>1,s in `a`b",
            false,
        ),
        (
            "QA008",
            "f:{[a;b] a+b};r:f(1;2)",
            "f:{[a;b] a+b};r:f[1;2]",
            false,
        ),
        ("QT004", "r:`int$\"12\"", "r:\"I\"$\"12\"", false),
        ("QT032", "r:`symbol$\"ab\"", "r:`$\"ab\"", false),
        (
            "QT032",
            "r:`guid$\"0a369037-75d3-b24d-6721-5a1d44d4bed5\"",
            "r:\"G\"$\"0a369037-75d3-b24d-6721-5a1d44d4bed5\"",
            false,
        ),
        ("QB020", "f:{[x] :x; x+1}", "f:{[x] :x}", false),
        ("QF017", "f:{[x] a:x+1; x}", "f:{[x] x+1; x}", false),
        ("QF017", "f:{[a] r:a -m:1; r}", "f:{[a] r:a - 1; r}", false),
        // A negative literal left against a signature stays one (#563).
        ("QF017", "f:{[x]r:-1;x}", "f:{[x] -1;x}", false),
        ("QP003", "r:.z.P", "r:.z.p", false),
        // The clock named is the clock fixed, on the line it is on (#206).
        ("QP003", "a:(.z.D;.z.P)", "a:(.z.d;.z.P)", false),
        ("QP003", "f:{x}\n  .z.P", "f:{x}\n  .z.p", false),
        // Not `.z.z`, the datetime QP002 reports in the same profile (#519).
        ("QP003", "a:.z.Z", "a:.z.p", false),
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
        // A string ends no operand: it is not the gap a blank would be (#210).
        (
            "QB006",
            "r:select from t where a=f \"x\" and b=0",
            "r:select from t where (a=f \"x\") and b=0",
            false,
        ),
        (
            "QB006",
            "s:select from t where a=\"x\" and b=0",
            "s:select from t where (a=\"x\") and b=0",
            false,
        ),
        // Nor does a bracket argument, or a derived function (#405).
        (
            "QB006",
            "r:select from t where a=f[b;b] and b=0",
            "r:select from t where (a=f[b;b]) and b=0",
            false,
        ),
        (
            "QB006",
            "r:select from t where a=f'[b;b] and b=0",
            "r:select from t where (a=f'[b;b]) and b=0",
            false,
        ),
        (
            "QB006",
            "r:select from t where a=(+/)[b] and b=0",
            "r:select from t where (a=(+/)[b]) and b=0",
            false,
        ),
        // The argument ends at `from` after a drop too (#340).
        (
            "QP006",
            "g:{x+1};r:1_select c:g a from t",
            "g:{x+1};r:1_select c:g[a] from t",
            true,
        ),
        // A line at the left margin that starts with a string is a new
        // statement, even though `code` blanks its quote to a space (#399).
        ("QP006", "f:{x}\nr:f 1\n\"s\"", "f:{x}\nr:f[1]\n\"s\"", true),
        (
            "QP006",
            "f:{x}\nr:f 1\n/ c\n\"s\"",
            "f:{x}\nr:f[1]\n/ c\n\"s\"",
            true,
        ),
        ("QP005", "r:a*b+c\n\"s\"", "r:a*(b+c)\n\"s\"", true),
        ("QR004", "r:{x+1} each 1 2 3", "r:1 2 3+1", false),
        ("QR004", "r:{2-x} each a,b", "r:2-a,b", false),
        ("QR004", "r:{x%2} each a,b", "r:(a,b)%2", false),
        ("QR004", "r:count {x*2} each b", "r:count b*2", false),
        ("QR004", "f:{a{x+1} each b}", "f:{a b+1}", false),
        ("QR004", "r:{x - 1} each b", "r:b-1", false),
        ("QR004", "s:a -{1+x} each 2 3", "s:a - 1+2 3", false),
        // In a query the argument ends where the column does (#350).
        (
            "QR004",
            "r:select c:{x+1} each a, d:b from t",
            "r:select c:a+1, d:b from t",
            false,
        ),
        (
            "QR004",
            "r:select c:{x+1} each a by b from t",
            "r:select c:a+1 by b from t",
            false,
        ),
        (
            "QR004",
            "r:select from t where b>{2*x} each a",
            "r:select from t where b>2*a",
            false,
        ),
        ("QR004", "t:a -{x*2} each 3 4", "t:a - 3 4*2", false),
        ("QL002", "a:1\n/ old:{x+1}\nb:2", "a:1\nb:2", false),
        // The indentation goes with it, or `b:2` would continue `a:1` (#205).
        ("QL002", "a:1\n  / f:{x}\nb:2", "a:1\nb:2", false),
        (
            "QB005",
            "t:([]a:1 2);r:select from t where a~1",
            "t:([]a:1 2);r:select from t where a=1",
            false,
        ),
        ("QF010", "f:{[a] x+1}", "f:{[a] a+1}", false),
        ("QA004", "f:{1};r:f . ()", "f:{1};r:f[]", true),
        // Only the `. ()` reported changes - not the string argument before
        // it, nor the `. (),1` that applies to a list (#208).
        (
            "QA004",
            "f:{1}\nr:(!).(\"S=;\"); s:f . ()\nt:g . (),1; u:f . ()",
            "f:{1}\nr:(!).(\"S=;\"); s:f[]\nt:g . (),1; u:f . ()",
            true,
        ),
        ("QT008", "r:til 5.0", "r:til 5", true),
        ("QT008", "r:til 3f", "r:til 3", true),
        // One digit in quotes is a char atom, which is 'stype too (#565).
        ("QT025", "f:{'5}", "f:{'enlist\"5\"}", true),
        ("QT025", "f:{'12}", "f:{'\"12\"}", true),
        ("QT025", "f:{'12:00}", "f:{'\"12:00\"}", true),
        ("QT025", "f:{'1e-3}", "f:{'\"1e-3\"}", true),
        (
            "QF005",
            "f:{[a] {a+x} each 1 2}",
            "f:{[a] {[x;a] a+x}[;a] each 1 2}",
            false,
        ),
        (
            "QF005",
            "f:{[a] {[x;y] a+y}'[1 2;3 4]}",
            "f:{[a] {[x;y;a] a+y}[;;a]'[1 2;3 4]}",
            false,
        ),
        (
            "QF005",
            "f:{[a] {a+y}'[1 2;3 4]}",
            "f:{[a] {[x;y;a] a+y}[;;a]'[1 2;3 4]}",
            false,
        ),
        (
            "QF005",
            "f:{[a] g:{ [b] a+b}; g 1}",
            "f:{[a] g:{[b;a] a+b}[;a]; g 1}",
            false,
        ),
        (
            "QF005",
            "f:{[a] g:{a}; g 1}",
            "f:{[a] g:{[x;a] a}[;a]; g 1}",
            false,
        ),
        (
            "QF005",
            "f:{a:2; {a+x} each 1 2}",
            "f:{a:2; {[x;a] a+x}[;a] each 1 2}",
            false,
        ),
        // A column in a query is no argument: q 5 gives the lambda one (#777).
        (
            "QF005",
            "f:{[a] {a+x+exec sum y from t} each 1 2}",
            "f:{[a] {[x;a] a+x+exec sum y from t}[;a] each 1 2}",
            false,
        ),
        ("QA007", "f:{[c] $[c;1;2;]}", "f:{[c] $[c;1;2]}", false),
        ("QA006", "f:{[c] $[c=1;1]}", "f:{[c] if[c=1;1]}", false),
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
        // A comment after it keeps its blank: `;/` is over (#403).
        ("QB017", "a:1\nx:1;a:a / note", "a:1\nx:1; / note", false),
        ("QB017", "a:1\nx:1;a:a; / note", "a:1\nx:1; / note", false),
        // An operand, not a statement: only the assignment goes, and the
        // value it held stays where it was read (q 5: both give 3).
        ("QB017", "f:{[x;b] r:x+b:b;r}", "f:{[x;b] r:x+b;r}", false),
        ("QB017", "b:1;c:b:b;c", "b:1;c:b;c", false),
        ("QB017", "f:{[b] b:b; b}", "f:{[b] b}", false),
        // The last statement is the lambda's value, so the name stays (#213).
        ("QB017", "f:{[a] a:a}", "f:{[a] a}", false),
        ("QB017", "f:{[a]\n  a:a\n  }", "f:{[a]\n  a\n  }", false),
        ("QP002", "r:`datetime$x", "r:`timestamp$x", false),
        ("QP002", "r:2026.01.01T12:00", "r:2026.01.01D12:00", false),
        (
            "QP002",
            "s:\"15h$\";y:`datetime$z",
            "s:\"15h$\";y:`timestamp$z",
            false,
        ),
        ("QP002", "r:\"z\"$x", "r:\"p\"$x", false),
        // The datetime fixed, and the symbol on the same line left (#409).
        (
            "QP002",
            "s:`2020.01.01T10;t:2020.01.01T10",
            "s:`2020.01.01T10;t:2020.01.01D10",
            false,
        ),
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
        ("QS004", "r:(2)\n  -1"),            // the vector 2 -1 across the line (#773)
        ("QS004", "l:1 2;r:l (1)\n  2"),     // and l 1 2 (#773)
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
        ("QA006", "r:`int$[a=1;b]"),         // `if` would fuse onto `int
        ("QA006", "r:x$[a=1;b]"),            // and onto a name
        ("QF010", "f:{[a;b] x+a}"),          // which parameter?
        ("QF010", "f:{[`s] x+1}"),           // a literal pattern binds no name (#379)
        ("QF010", "f:{[1] x}"),              // nor does a number (#379)
        ("QF010", "f:{[(a;b)] x}"),          // and a list pattern is no one name (#379)
        ("QT008", "r:til 2.5"),              // no long it spells
        ("QT008", "r:til 2e-1"),             // `til 2-1` (#389)
        ("QT008", "r:til 2e+1"),             // nor `til 2+1` (#389)
        ("QF020", "t:([]ab:1 2;ac:3 4);r:select a from t"), // two equally close
        ("QA007", "f:{[c] $[c;1;2;3]}"),     // no empty slot
        ("QP002", "t:.z.z / old: 15h$x"),    // the cast is in a comment
        ("QP002", "t:.z.Z;s:\"0Nz\""),       // and the null in a string
        (
            "QF005",
            "f:{[k] g:{[a;b;c;d;e;f;g;h] k+h}; g[1;2;3;4;5;6;7;8]}",
        ), // a ninth parameter is 'params
        // A local passed in before it holds a value is 'a (#769)
        ("QF005", "h:{a:{a+1};a}"),
        ("QF005", "k:{[b] r:{a+x} each b; a:2; r}"),
        // A bracket argument would become a key-column header (#406)
        ("QR004", "a:1 2 3;r:{x*2}'[a]"),
        ("QR004", "a:1 2 3;r:{x*2} each[a]"),
        // A symbol applied to () is a projection, which `[]` would call (#408)
        ("QA004", "f:{42};r:`f . ()"),
        // A comment holding a `}` would go with the code (#410)
        ("QB020", "f:{[x] :x; x / keep this comment }\n  }"),
        // `return` before a comment returns nothing: `:/` is over (#404)
        ("QF015", "f:{[x] a:1;\n  return / done\n  }"),
        // `:[x]` and `:'[x]` return a projection of `:`, not x (#770).
        ("QF015", "f:{return[x]}"),
        ("QF015", "f:{return'[x]}"),
    ] {
        for finding in lint(source, "probe.q", Profile::Uqf)
            .iter()
            .filter(|f| f.code == code)
        {
            assert!(fix_for(finding, source).is_none(), "{code} fixed {source}");
        }
    }
}

/// A fix that deletes a token from between two numeric literals would leave
/// them one vector literal: q 5 gives `10 30` for `10 20 30 {x} each 0 2`
/// and for `{r:10 20 30 a:0 2; r}[]`, and `20 30` for
/// `10 20 30 {x+1} each 0 1`, where the rewrites read `10 20 30 0 2` and
/// `10 20 30 0 1+1` (#374, #375).
#[test]
fn no_fix_that_fuses_two_numeric_literals() {
    use q_lint_rs::{Profile, fix_for, lint};
    for (code, source) in [
        ("QR002", "r:10 20 30 {x} each 0 2"),
        ("QR002", "r:0 1 2{x} each 1"),
        ("QR002", "r:0 1 2 {x} each -1"),
        ("QF017", "f:{r:10 20 30 a:0 2; r}"),
        // An indented line goes on with the one before it (#774).
        ("QF017", "g:{r:10 20 30\n  m:0 2; r}"),
        ("QR004", "g:10 20 30 {x+1} each 0 1"),
    ] {
        let found: Vec<_> = lint(source, "probe.q", Profile::Uqf)
            .into_iter()
            .filter(|f| f.code == code)
            .collect();
        assert!(!found.is_empty(), "{code} not reported on {source}");
        for finding in &found {
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
    assert!(
        safe.ends_with(
            "@@ -1,4 +1,4 @@\n a:1\n / old:{x+1}\n-b:a==1\n+b:a=1\n r:reverse asc 3 1 2\n\
             \\ No newline at end of file\n"
        ),
        "{safe}"
    );

    let all = run(&["--diff", "--unsafe-fixes"]);
    assert!(
        all.ends_with(
            "@@ -1,4 +1,3 @@\n a:1\n-/ old:{x+1}\n-b:a==1\n+b:a=1\n-r:reverse asc 3 1 2\n\
             \\ No newline at end of file\n+r:desc 3 1 2\n\\ No newline at end of file\n"
        ),
        "{all}"
    );

    run(&["--fix", "--unsafe-fixes"]);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "a:1\nb:a=1\nr:desc 3 1 2"
    );
}

/// `--diff` names each file relative to the current directory, as Ruff does,
/// so the patch it prints applies with `patch -p1` and `git apply` - and
/// applied, it gives what `--fix` writes. An absolute path behind `a/` was
/// `a//abs/path`, which patch asked about and git refused.
#[test]
fn a_diff_names_files_relative_to_the_current_directory_and_applies() {
    let directory = tempfile::tempdir().unwrap();
    // Two fixes far enough apart for two hunks, each with its context, and
    // the second not at the end of the file - the case `git apply` refuses
    // without context.
    let source = "f:{[x] $[x;true;false]}\nb:2\nc:3\nd:4\ne:5\ng:6\nh:7\ni:8\na:1==1\nj:9\n";
    let run = |flags: &[&str], file: &std::path::Path| {
        Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(directory.path())
            .arg("--isolated")
            .args(flags)
            .arg(file)
            .output()
            .unwrap()
    };
    fs::create_dir_all(directory.path().join("sub")).unwrap();
    let path = directory.path().join("sub/fx.q");
    fs::write(&path, source).unwrap();
    // Named relatively or absolutely, the header is the same.
    let diff = String::from_utf8(run(&["--diff"], &path).stdout).unwrap();
    let relative = run(&["--diff"], std::path::Path::new("sub/fx.q")).stdout;
    assert_eq!(diff, String::from_utf8(relative).unwrap());
    assert!(diff.contains("@@ -1,4 +1,4 @@\n"), "{diff}");
    assert!(
        diff.contains("@@ -6,5 +6,5 @@\n g:6\n h:7\n i:8\n"),
        "{diff}"
    );
    assert!(
        diff.starts_with("--- a/sub/fx.q\n+++ b/sub/fx.q\n"),
        "{diff}"
    );
    run(&["--fix"], &path);
    let fixed = fs::read_to_string(&path).unwrap();
    assert_ne!(fixed, source);
    fs::write(directory.path().join("fx.diff"), &diff).unwrap();
    for tool in [
        &["patch", "-p1", "-i", "fx.diff"][..],
        &["git", "apply", "fx.diff"],
    ] {
        // windows-latest's patch is Strawberry Perl's 2.5.9, which fails its
        // own assertion in patch.c on any input; git apply still runs there.
        if cfg!(windows) && tool[0] == "patch" {
            continue;
        }
        fs::write(&path, source).unwrap();
        let Ok(out) = Command::new(tool[0])
            .current_dir(directory.path())
            .args(&tool[1..])
            .output()
        else {
            continue; // not installed here
        };
        assert!(
            out.status.success(),
            "{tool:?}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        // git on windows-latest writes with core.autocrlf, so the applied
        // file has CRLF where --fix kept the source's LF.
        let applied = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
        assert_eq!(applied, fixed, "{tool:?}");
    }
    // A name given for stdin is printed as given.
    let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(directory.path())
        .args(["--isolated", "--diff", "--stdin-filename", "sub/in.q", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(source.as_bytes())
        .unwrap();
    let out = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
    assert!(out.starts_with("--- a/sub/in.q\n+++ b/sub/in.q\n"), "{out}");
}

/// A fix edits code. Where a finding points into a string or a comment, a
/// rule matched text it should not have; the fix must not compound it. The
/// reported case: QB015 read the `=` of the string `"="` as an operator, and
/// its fix rewrote the string as `" like "`.
#[test]
fn no_fix_edits_inside_a_string() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("strings.q");
    let source = "f:{[t] select from t where a in `x, b like \"=\" , c<>\"ab\"}\n\
                  g:{[s] ssr[s;\"=\";\" \"]}\n";
    fs::write(&path, source).unwrap();
    for flags in [&["--fix"][..], &["--fix", "--unsafe-fixes"][..]] {
        Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(["--profile", "uqf"])
            .args(flags)
            .arg(&path)
            .output()
            .unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.contains("like \"=\""), "{after}");
        assert!(after.contains("ssr[s;\"=\";\" \"]"), "{after}");
    }
}

/// `--fix` repeats until nothing applies, as Ruff does. QF005's fix passes
/// one enclosing local in per pass, so a lambda reading two needed a second
/// run - and after the first, q 5 still threw 'q. `--diff` shows the result
/// of the whole run.
#[test]
fn fixes_repeat_until_nothing_applies() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("two.q");
    fs::write(&path, "f10:{p:1;q:2;{p+q+x}[3]}\n").unwrap();
    let run = |flags: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(["--profile", "style", "--unsafe-fixes", "--ignore", "QF017"])
            .args(flags)
            .arg(&path)
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap()
    };
    let diff = run(&["--diff"]);
    assert!(
        diff.contains("+f10:{p:1;q:2;{[x;p;q] p+q+x}[;;q][;p][3]}"),
        "{diff}"
    );
    run(&["--fix"]);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "f10:{p:1;q:2;{[x;p;q] p+q+x}[;;q][;p][3]}\n"
    );
}

/// QF005's rewrite puts the local after `x`, `y` and `z`, so it is not a
/// new QS008 finding in the profiles that carry that rule (#772).
#[test]
fn qf005_fix_raises_no_qs008() {
    use q_lint_rs::{Profile, fix_for, lint};
    let source = "f:{[a] {a+x} each 1 2}";
    for profile in [Profile::StyleQ, Profile::Uqf] {
        let finding = lint(source, "probe.q", profile)
            .into_iter()
            .find(|f| f.code == "QF005")
            .expect("QF005");
        let fix = fix_for(&finding, source).expect("a fix");
        let fixed = format!(
            "{}{}{}",
            &source[..fix.start],
            fix.replacement,
            &source[fix.end..]
        );
        let after: Vec<_> = lint(&fixed, "probe.q", profile)
            .into_iter()
            .filter(|f| f.code == "QS008")
            .collect();
        assert!(after.is_empty(), "{fixed}: {after:?}");
    }
}

/// Two fixes that touch are applied in one pass, each against the source
/// as it was. QS004 unwrapped both of `(x)(y)` and left the name `xy`, which
/// q 5 throws as undefined where the original indexes `x` by `y`.
#[test]
fn touching_fixes_keep_their_tokens_apart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("adjacent.q");
    // And two numbers stay two tokens: q 5 `(1.5)(2)` is 'type, and `1.5 2`
    // would be a vector (#516).
    fs::write(
        &path,
        "x:10 20 30;y:2\nr:(x)(y)\nf:{(-1)(x)}\na:(1.5)(2)\nb:(2) (3)\n",
    )
    .unwrap();
    Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--profile", "styleq", "--fix"])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "x:10 20 30;y:2\nr:x y\nf:{-1 x}\na:1.5(2)\nb:2 (3)\n"
    );
}

/// QP002 and QP003 point at the value they name, not at the statement it
/// sits in - where an editor underlines and where the fix edits (#206).
#[test]
fn policy_findings_sit_on_the_token_they_name() {
    use q_lint_rs::{Profile, lint};
    let source = "a:(.z.D;.z.P)\nf:{x}\n  .z.P\ntotalTime:.z.T\nb:1;c:-0Nz\n";
    let at: Vec<_> = lint(source, "probe.q", Profile::Uqf)
        .into_iter()
        .filter(|f| f.code.starts_with("QP00"))
        .map(|f| (f.code, f.line, f.column.unwrap()))
        .collect();
    let want: Vec<(String, usize, usize)> = vec![
        ("QP003".into(), 1, 4),
        ("QP003".into(), 1, 9),
        ("QP003".into(), 3, 3),
        ("QP003".into(), 4, 11),
        ("QP002".into(), 5, 7),
    ];
    for w in &want {
        assert!(at.contains(w), "{w:?} not in {at:?}");
    }
}

#[cfg(unix)]
#[test]
fn a_file_that_cannot_be_written_is_reported_and_the_rest_are_still_fixed() {
    // One read-only file used to end the run on the spot: the files after it
    // were neither fixed nor linted, and nothing was reported (#264).
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = |name: &str| directory.path().join(name);
    fs::write(path("a.q"), "f:{[x] x==1}\n").unwrap();
    fs::write(path("b.q"), "f:{[x] x==1}\n").unwrap();
    fs::write(path("c.q"), "g:{[x;y] x}\n").unwrap();
    fs::set_permissions(path("a.q"), fs::Permissions::from_mode(0o444)).unwrap();
    if fs::OpenOptions::new().write(true).open(path("a.q")).is_ok() {
        return; // root writes it anyway; there is nothing to test
    }
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(directory.path())
        .args([
            "--isolated",
            "--profile",
            "style",
            "--fix",
            "--format",
            "json",
        ])
        .args(["a.q", "b.q", "c.q"])
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(
        stderr.contains("a.q") && stderr.contains("not fixed"),
        "{stderr}"
    );
    assert_eq!(fs::read_to_string(path("a.q")).unwrap(), "f:{[x] x==1}\n");
    assert_eq!(fs::read_to_string(path("b.q")).unwrap(), "f:{[x] x=1}\n");
    let findings: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let mut reported: Vec<_> = findings
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let file = std::path::Path::new(f["path"].as_str().unwrap());
            format!(
                "{} {}",
                file.file_name().unwrap().to_string_lossy(),
                f["code"].as_str().unwrap()
            )
        })
        .collect();
    reported.sort();
    assert_eq!(reported, ["a.q QE004", "c.q QF016"], "{findings}");
}

/// A name with a space ends its header in a TAB, as git and diffutils write
/// it: without one, patch cut `my file.q` at the space and found no file
/// (#271).
#[test]
fn a_diff_of_a_file_whose_name_has_a_space_applies() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("my file.q");
    let source = "f:{[x] x==1}\n";
    fs::write(&path, source).unwrap();
    let diff = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(directory.path())
        .args(["--isolated", "--diff", "my file.q"])
        .output()
        .unwrap();
    let diff = String::from_utf8(diff.stdout).unwrap();
    assert!(
        diff.starts_with("--- a/my file.q\t\n+++ b/my file.q\t\n"),
        "{diff:?}"
    );
    fs::write(directory.path().join("fx.diff"), &diff).unwrap();
    for tool in [
        &["patch", "-p1", "-i", "fx.diff"][..],
        &["git", "apply", "fx.diff"],
    ] {
        if cfg!(windows) && tool[0] == "patch" {
            continue; // see a_diff_names_files_relative_to_the_current_directory_and_applies
        }
        fs::write(&path, source).unwrap();
        let Ok(out) = Command::new(tool[0])
            .current_dir(directory.path())
            .args(&tool[1..])
            .stdin(std::process::Stdio::null())
            .output()
        else {
            continue; // not installed here
        };
        assert!(
            out.status.success(),
            "{tool:?}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let applied = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
        assert_eq!(applied, "f:{[x] x=1}\n", "{tool:?}");
    }
}

/// Each invalid byte is one character, a truncated multi-byte sequence too:
/// `E2 82` was read as one, and every finding after it on the line was a
/// column early (#273).
#[test]
fn a_truncated_utf8_sequence_keeps_the_columns_after_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("lossy.q");
    fs::write(
        &path,
        b"s:\"\xe2\x82\"; f:{[x] x==1}\nt:\"\xe9\xe0\"; g:{[x] x==1}\n",
    )
    .unwrap();
    let lint = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--isolated", "--format", "json"])
        .arg(&path)
        .output()
        .unwrap();
    let findings: serde_json::Value = serde_json::from_slice(&lint.stdout).unwrap();
    let mut at: Vec<_> = findings
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["code"] == "QE004")
        .map(|f| (f["line"].as_u64().unwrap(), f["column"].as_u64().unwrap()))
        .collect();
    at.sort();
    assert_eq!(at, [(1, 17), (2, 17)], "{findings}");
}

/// A line a nested or multi-pass fix leaves alone is context in `--diff`,
/// as `diff -u` prints it, not a line removed and written back (#518, #671).
#[test]
fn diff_keeps_untouched_lines_inside_a_change_as_context() {
    let directory = tempfile::tempdir().unwrap();
    for (name, source, expected) in [
        (
            "nested.q",
            "f:{x}\nc:f f 1\nd:4\ne:5\nh:f 2\n",
            "@@ -1,5 +1,5 @@\n f:{x}\n-c:f f 1\n+c:f[f[1]]\n d:4\n e:5\n-h:f 2\n+h:f[2]\n",
        ),
        (
            "passes.q",
            "hs:{x}\nsq:{x}\nf:{(sq hs x)}\nmid:1\ng:{(sq hs x)}\n",
            "@@ -1,5 +1,5 @@\n hs:{x}\n sq:{x}\n-f:{(sq hs x)}\n+f:{(sq[hs[x]])}\n mid:1\n\
             -g:{(sq hs x)}\n+g:{(sq[hs[x]])}\n",
        ),
    ] {
        let path = directory.path().join(name);
        fs::write(&path, source).unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args([
                "--isolated",
                "--profile",
                "uqf",
                "--select",
                "QP006",
                "--diff",
            ])
            .arg(&path)
            .output()
            .unwrap();
        let patch = String::from_utf8(out.stdout).unwrap();
        let hunks = &patch[patch.find("@@").unwrap()..];
        assert_eq!(hunks, expected, "{name}");
    }
}
