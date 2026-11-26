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
        "f:{x+y}\n",
        "lg:{-1 x,y;}\n",
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
            "f:{x+y}\n",
            "lg:{-1 x,y;}\n",
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
        "f:{[x;y] x+y}\n",
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
            "f:{[x;y] x+y}\n",
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
    let source = "g:{x+y}\nt:([]a:1 2)\nr:select c:`\u{e9}, d:g a from t\n";
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

/// QF001's rename walked the lambda byte by byte and sliced the text at each:
/// inside any character past ASCII - an `é`, a pasted no-break space - which
/// ended `--fix` and `--diff` in exit 101, on the very file QE012 says to
/// fix (#2863).
#[test]
fn a_rename_in_a_lambda_holding_a_multibyte_character_does_not_panic() {
    use q_lint_rs::{Profile, fixes_for, lint};
    for (source, renamed) in [
        ("f:{[aj]\u{e9} aj}\n", "{[ajArg]\u{e9} ajArg}"),
        ("f:{[aj] aj\u{a0}}\n", "{[ajArg] ajArg\u{a0}}"),
        ("f:{[aj] aj,\u{2019}aj}\n", "{[ajArg] ajArg,\u{2019}ajArg}"),
    ] {
        let findings = lint(source, "probe.q", Profile::General);
        let fixes = fixes_for(findings.iter().filter(|f| f.code == "QF001"), source);
        assert_eq!(fixes.len(), 1, "{findings:?}");
        assert_eq!(fixes[0].replacement, renamed, "{source:?}");
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
        ("string.q", "f:{x+y}\nr:f \"a\nt:f 2\n"),
        ("paren.q", "f:{x+y}\ns:(1;2\nt:f 2\n"),
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

/// Each rule's rewrite: the code, a source, what its fix leaves, and
/// whether `--fix` applies it unattended. The README's two lists of fixes
/// are checked against it, and it against the rules that have a fix.
const FIX_CASES: &[(&str, &str, &str, bool)] = &[
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
    ("QT007", "r:`a ss \"a\"", "r:(enlist\"a\") ss \"a\"", false),
    ("QB012", "f:{[x] x+1;}", "f:{[x] x+1}", false),
    ("QB010", "a:1;b:a -1", "a:1;b:a - 1", false),
    ("QR001", "r:reverse asc 3 1 2", "r:desc 3 1 2", false),
    ("QR001", "r:reverse desc 3 1 2", "r:asc 3 1 2", false),
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
        false,
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
    // In a qSQL phrase the operand ends where the column does (#847).
    (
        "QP005",
        "r:select mid:0.5*bid+ask from q",
        "r:select mid:0.5*(bid+ask) from q",
        true,
    ),
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
    ("QT004", "r:\"j\"$\"12\"", "r:\"J\"$\"12\"", false),
    (
        "QT004",
        "r:\"d\"$ \"2024.01.01\"",
        "r:\"D\"$ \"2024.01.01\"",
        false,
    ),
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
    // `ltime` of the UTC clock goes whole (#2722).
    ("QP003", "a:`date$ltime .z.p", "a:`date$.z.p", false),
    ("QP003", "a:ltime[.z.p]", "a:.z.p", false),
    // The clock, not the symbol that spells it (#2721).
    ("QP003", "a:(`.z.P;.z.P)", "a:(`.z.P;.z.p)", false),
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
        "g:{x+y};r:1_select c:g a from t",
        "g:{x+y};r:1_select c:g[a] from t",
        true,
    ),
    // A line at the left margin that starts with a string is a new
    // statement, even though `code` blanks its quote to a space (#399).
    (
        "QP006",
        "f:{x+y}\nr:f 1\n\"s\"",
        "f:{x+y}\nr:f[1]\n\"s\"",
        true,
    ),
    (
        "QP006",
        "f:{x+y}\nr:f 1\n/ c\n\"s\"",
        "f:{x+y}\nr:f[1]\n/ c\n\"s\"",
        true,
    ),
    ("QP005", "r:a*b+c\n\"s\"", "r:a*(b+c)\n\"s\"", true),
    ("QV002", "r:abs each x", "r:abs x", false),
    ("QV002", "r:sqrt  each x", "r:sqrt x", false),
    ("QV002", "r:not'[b]", "r:not[b]", false),
    ("QV002", "f:{[x] neg each x}", "f:{[x] neg x}", false),
    (
        "QV003",
        "f:{r:(); do[n; r:r,til 10]; r}",
        "f:{r:(); do[n; r,:til 10]; r}",
        false,
    ),
    (
        "QV003",
        "f:{r:(); do[n; r: r ,1]; r}",
        "f:{r:(); do[n; r,:1]; r}",
        false,
    ),
    // A parameter is a local whatever is assigned, and outside a lambda
    // both spellings write the global (#2798).
    (
        "QV003",
        "f:{[r] do[2; r:r,3]; r}",
        "f:{[r] do[2; r,:3]; r}",
        false,
    ),
    ("QV003", "r:1 2\ndo[3; r:r,4]", "r:1 2\ndo[3; r,:4]", false),
    // A symbol runs on over `:` and `/`: the word in a file handle is no
    // use of the parameter (#2799).
    (
        "QF001",
        "f:{[count] (count;`:count;`:dir/count)}",
        "f:{[countArg] (countArg;`:count;`:dir/count)}",
        false,
    ),
    (
        "QF001",
        "g:{[type] (type;`:db/type;`a:type;`type)}",
        "g:{[typeArg] (typeArg;`:db/type;`a:type;`type)}",
        false,
    ),
    ("QR004", "r:{x+1} each 1 2 3", "r:1 2 3+1", false),
    ("QR004", "r:{2-x} each a,b", "r:2-a,b", false),
    ("QR004", "r:{x%2} each a,b", "r:(a,b)%2", false),
    ("QR004", "r:count {x*2} each b", "r:count b*2", false),
    ("QR004", "f:{a{x+1} each b}", "f:{a b+1}", false),
    ("QR004", "r:{x - 1} each b", "r:b-1", false),
    // An exponent with a sign, a number that starts with its point (#2937).
    ("QR004", "r:{x*1e-3} each b", "r:b*1e-3", false),
    ("QR004", "r:{.5-x} each a,b", "r:.5-a,b", false),
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
        "f:{[a] {[unused;y;a] a+y}[;;a]'[1 2;3 4]}",
        false,
    ),
    // An argument the lambda does not read is named for that, where `x`
    // and `y` would be parameters QF016 reports (#2797).
    (
        "QF005",
        "f:{[a] {a+z} . (1;2;3)}",
        "f:{[a] {[unused1;unused2;z;a] a+z}[;;;a] . (1;2;3)}",
        false,
    ),
    (
        "QF005",
        "f:{[a] {x+a+z}[1;2;3]}",
        "f:{[a] {[x;unused;z;a] x+a+z}[;;;a][1;2;3]}",
        false,
    ),
    // `{[] b}` takes one argument: `{[;b]` would hold the empty slot QF009
    // reports, and `{[b] b}[b]` is the call and no projection (#2797).
    (
        "QF005",
        "f:{[b] g:{[] b}; g[]}",
        "f:{[b] g:{[unused;b] b}[;b]; g[]}",
        false,
    ),
    // `.z.s` in a lambda nested deeper is that lambda (#2796).
    (
        "QF005",
        "f:{[a] {$[x>0;a+{.z.s x} x-1;0]} 3}",
        "f:{[a] {[x;a] $[x>0;a+{.z.s x} x-1;0]}[;a] 3}",
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
        "f:{[a] g:{[unused;a] a}[;a]; g 1}",
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
    ("QA006", "f:{[c] $[c=1;1];c}", "f:{[c] if[c=1;1];c}", false),
    ("QA006", "$[1=1;show 1]", "if[1=1;show 1]", false),
    (
        "QA006",
        "f:{[c] if[c;$[c=1;1]];c}",
        "f:{[c] if[c;if[c=1;1]];c}",
        false,
    ),
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
    // A cast before a temporal literal or the clock: the same instant.
    ("QP002", "r:`datetime$.z.p", "r:`timestamp$.z.p", false),
    (
        "QP002",
        "t:([]a:`datetime$())",
        "t:([]a:`timestamp$())",
        false,
    ),
    ("QP002", "r:2026.01.01T12:00", "r:2026.01.01D12:00", false),
    // The `z` goes with the `T`, or the literal is a datetime still (#2743).
    (
        "QP002",
        "r:2024.01.01T12:00:00.000z",
        "r:2024.01.01D12:00:00.000",
        false,
    ),
    (
        "QP002",
        "r:2024.01.01D12:00:00.000z",
        "r:2024.01.01D12:00:00.000",
        false,
    ),
    // The type in parentheses, and as the first argument of `$` (#2720).
    ("QP002", "r:(15h)$2024.01.01", "r:(12h)$2024.01.01", false),
    ("QP002", "r:(`datetime)$.z.p", "r:(`timestamp)$.z.p", false),
    (
        "QP002",
        "r:$[\"z\";2024.01.01]",
        "r:$[\"p\";2024.01.01]",
        false,
    ),
    (
        "QP002",
        "r:$[`datetime;2024.01.01D12]",
        "r:$[`timestamp;2024.01.01D12]",
        false,
    ),
    // The null in lower case is the same null (#2719).
    ("QP002", "r:0nz", "r:0np", false),
    ("QP002", "r:-0wz", "r:-0wp", false),
    (
        "QP002",
        "s:\"15h$\";y:15h$2020.01.01",
        "s:\"15h$\";y:12h$2020.01.01",
        false,
    ),
    (
        "QP002",
        "r:\"z\"$ 2020.01.01T10:00",
        "r:\"p\"$ 2020.01.01T10:00",
        false,
    ),
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
    // The blanks go with it, or q 5 skips the first line (#663).
    ("QE005", "\u{feff} r:1\n", "r:1\n", true),
    ("QE005", "\u{feff}r:1\n", "r:1\n", true),
    (
        "QF020",
        "t:([]price:1 2);r:select prce from t",
        "t:([]price:1 2);r:select price from t",
        false,
    ),
    // Each glyph's keyword: on KDB-X `(g:)x` and the keyword parse alike.
    ("QE008", "r:-x", "r:neg x", true),
    ("QE008", "r:#x", "r:count x", true),
    ("QE008", "r:,x", "r:enlist x", true),
    ("QE008", "r:~x", "r:not x", true),
    ("QE008", "r:_x", "r:floor x", true),
    ("QE008", "r:%x", "r:reciprocal x", true),
    ("QE008", "r:!x", "r:key x", true),
    ("QE008", "r:$x", "r:string x", true),
    ("QE008", "r:&x", "r:where x", true),
    ("QE008", "r:|x", "r:reverse x", true),
    ("QE008", "r:^x", "r:null x", true),
    ("QE008", "r:@x", "r:type x", true),
    ("QE008", "r:?x", "r:distinct x", true),
    ("QE008", "r:*x", "r:first x", true),
    ("QE008", "r:+x", "r:flip x", true),
    ("QE008", "r:.(x)", "r:value (x)", true),
    ("QE008", "r:#:x", "r:count x", true),
    ("QE008", "r:,-1", "r:enlist -1", true),
    ("QE008", "r:*$[a;b;c]", "r:first $[a;b;c]", true),
    ("QE008", "f:{[a]-x}", "f:{[a] neg x}", true),
    ("QE008", "r:- x", "r:neg x", true),
    // The derived function in parentheses: on KDB-X `(+/)x+y` parses as
    // `+/[x+y]`, which is what q 4 applied it to.
    ("QE009", "f:{+/x}", "f:{(+/)x}", true),
    ("QE009", "f:{x/y}", "f:{(x/)y}", true),
    ("QE009", "f:{count'x}", "f:{(count')x}", true),
    ("QE009", "f:{sum/:x}", "f:{(sum/:)x}", true),
    ("QE009", "f:{+/'x}", "f:{(+/')x}", true),
    ("QE009", "f:{.:'x}", "f:{(.:')x}", true),
    ("QE009", "f:{-':x}", "f:{(-':)x}", true),
    ("QE009", "f:{.foo.f/x}", "f:{(.foo.f/)x}", true),
    ("QE009", "f:{+/x+y}", "f:{(+/)x+y}", true),
    // Each keyword in parentheses: on KDB-X `(cor) each x` is
    // `each[cor;x]`, as `count each x` is.
    ("QE011", "r:cor each x", "r:(cor) each x", true),
    ("QE011", "r:1+mavg peach x", "r:1+(mavg) peach x", true),
    ("QE011", "r:within over x", "r:(within) over x", true),
    ("QE011", "r:xexp scan x", "r:(xexp) scan x", true),
    ("QE011", "r:mod prior x", "r:(mod) prior x", true),
    ("QE011", "f:{[x] cor each x}", "f:{[x] (cor) each x}", true),
    // 'type before, a connection after: only in the editor.
    (
        "QT029",
        "h:hopen `localhost:5000",
        "h:hopen `:localhost:5000",
        false,
    ),
    ("QT029", "h:hopen[`db:5000]", "h:hopen[`:db:5000]", false),
    // A symbol that runs on over `/` takes the colon too (#2886).
    (
        "QT029",
        "h:hopen `unix://5000",
        "h:hopen `:unix://5000",
        false,
    ),
    // Each look-alike becomes its ASCII; the one in the string stays.
    ("QE012", "r:1\u{a0}2", "r:1 2", true),
    (
        "QE012",
        "r:\"\u{a0}\";s:1\u{a0}+2",
        "r:\"\u{a0}\";s:1 +2",
        true,
    ),
    ("QE012", "r:\u{2013}1", "r:-1", true),
    ("QE012", "r:1\u{2014}2", "r:1-2", true),
    ("QE012", "r:\u{2212}1", "r:-1", true),
    ("QE012", "r:f\u{2018}x", "r:f'x", true),
    ("QE012", "r:f\u{2019}x", "r:f'x", true),
    ("QE012", "s:\u{201c}hi\u{201d}", "s:\"hi\"", true),
    ("QE004", "a:1==1", "a:1=1", true),
    ("QE004", "c:1&&2", "c:1&2", false),
    ("QP007", "r:2+3*4", "r:2+(3*4)", true),
    ("QP008", "r:2*(3+4)", "r:2*3+4", true),
    // A suppression nothing needs: only in the editor.
    ("QL003", "a:1 / noqa: QE004", "a:1", false),
];

#[test]
fn each_fix_rewrites_to_the_right_text_and_says_whether_it_is_batch_safe() {
    use q_lint_rs::{Profile, fix_for, lint};
    for &(code, source, expected, safe) in FIX_CASES {
        // QP007 and QP008 are in no profile, and QL003 is about the others.
        let finding = lint(source, "probe.q", Profile::Uqf)
            .into_iter()
            .chain(selected(source, &[code]))
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
        ("QS004", "r:(2)\n  -1"),            // the vector 2 -1 across the line (#773)
        ("QS004", "l:1 2;r:l (1)\n  2"),     // and l 1 2 (#773)
        ("QR002", "g:{x} each"),             // a function, with nothing to return
        ("QR002", "r:count {x}' b"),         // `{x}'` infix, `count` its left argument
        ("QT007", "r:ss[`a`b;\"b\"]"),       // a symbol vector is not one string
        ("QF015", "f:{[x] a:return x}"),     // `return` mid-expression
        ("QF015", "f:{[x] if[x;break]; x}"), // no q spelling for break
        ("QB015", "t:([]s:`ab);r:select from t where s=\"a*\""), // a pattern
        ("QB015", "t:([]s:`ab);r:select from t where \"ab\"=s"), // like reads its pattern on the right (#639)
        ("QB020", "f:{[x] :x;\n  x+1}"),                         // across lines
        ("QP005", "tanh:1f-2f%1f+exp 2f*"),                      // a composition
        ("QR004", "r:count {x+1}' b"),                           // `{x+1}'` infix
        ("QA006", "r:`int$[a=1;b]"),                             // `if` would fuse onto `int
        ("QA006", "r:x$[a=1;b]"),                                // and onto a name
        // `if` has no value: these would still fail, or be `::` (#781)
        ("QA006", "a:1+$[1=1;2]"),
        ("QA006", "d:enlist $[1=1;2]"),
        ("QA006", "f:{[c] $[c=1;1]}"), // a lambda's last statement is its value
        ("QA006", "f:{[c] if[$[c=1;1b];2];c}"), // the test of an `if`
        ("QF010", "f:{[a;b] x+a}"),    // which parameter?
        ("QF010", "f:{[`s] x+1}"),     // a literal pattern binds no name (#379)
        ("QF010", "f:{[1] x}"),        // nor does a number (#379)
        ("QF010", "f:{[(a;b)] x}"),    // and a list pattern is no one name (#379)
        ("QT008", "r:til 2.5"),        // no long it spells
        ("QT008", "r:til 2e-1"),       // `til 2-1` (#389)
        ("QT008", "r:til 2e+1"),       // nor `til 2+1` (#389)
        ("QT025", "f:{'10 20}"),       // only the first item would be quoted (#1200)
        ("QT025", "f:{'1 2}"),
        ("QF020", "t:([]ab:1 2;ac:3 4);r:select a from t"), // two equally close
        ("QA007", "f:{[c] $[c;1;2;3]}"),                    // no empty slot
        ("QP002", "t:.z.z / old: 15h$x"),                   // the cast is in a comment
        ("QP002", "t:.z.Z;s:\"0Nz\""),                      // and the null in a string
        // A number cast counts days to datetime, nanoseconds to timestamp,
        // and a name may hold one (#2254).
        ("QP002", "r:`datetime$1"),
        ("QP002", "r:`datetime$x"),
        ("QP002", "r:\"z\"$-923892.12"),
        ("QP002", "r:15h$x"),
        ("QP002", "r:(15h)$x"), // nor with the type in parentheses (#2720)
        ("QP002", "r:$[`datetime;x]"),
        ("QP002", "r:(-15h)$\"2024.01.01T00:00\""), // a parse reads no timestamp from that text
        (
            "QF005",
            "f:{[k] g:{[a;b;c;d;e;f;g;h] k+h}; g[1;2;3;4;5;6;7;8]}",
        ), // a ninth parameter is 'params
        // A local passed in before it holds a value is 'a (#769)
        ("QF005", "h:{a:{a+1};a}"),
        ("QF005", "k:{[b] r:{a+x} each b; a:2; r}"),
        ("QF005", "f:{[a] {[c:a] c}}"), // a pattern, not a body to pass it into (#637)
        // `.z.s` would be the lambda with one more parameter, and its call a
        // projection (#2796)
        ("QF005", "f:{[a] {$[x>0;a+.z.s x-1;0]} 3}"),
        ("QF005", "f:{[a] {[n] $[n>0;a+.z.s[n-1];0]} 3}"),
        // The body has `unused` for something else (#2797)
        ("QF005", "f:{[a] g:{a+unused}; g 1}"),
        // A bracket argument would become a key-column header (#406)
        ("QR004", "a:1 2 3;r:{x*2}'[a]"),
        ("QR004", "a:1 2 3;r:{x*2} each[a]"),
        // Each over apply and each in brackets are reported, not rewritten.
        ("QR004", "a:1 2 3;r:{x*2}@'a"),
        ("QR004", "a:1 2 3;r:each[{x*2};a]"),
        ("QR002", "a:1 2 3;r:{x}@'a"),
        ("QR002", "a:1 2 3;r:each[{x};a]"),
        ("QV002", "a:1 2 3;r:abs@'a"),
        ("QV002", "a:1 2 3;r:each[abs;a]"),
        // `{x -.5}` indexes x, and has no arithmetic to lift.
        ("QR004", "r:{x -.5} each b"),
        // A symbol applied to () is a projection, which `[]` would call (#408)
        ("QA004", "f:{42};r:`f . ()"),
        // A comment holding a `}` would go with the code (#410)
        ("QB020", "f:{[x] :x; x / keep this comment }\n  }"),
        // `return` before a comment returns nothing: `:/` is over (#404)
        ("QF015", "f:{[x] a:1;\n  return / done\n  }"),
        // `:[x]` and `:'[x]` return a projection of `:`, not x (#770).
        ("QF015", "f:{return[x]}"),
        ("QF015", "f:{return'[x]}"),
        // Hopen or a grade, by the argument: no one keyword (q 5: (<:)5 is hopen).
        ("QE008", "r:<x"),
        ("QE008", "r:>x"),
        ("QE008", "f:{[a]-1 2}"),       // a literal, or neg of the vector
        ("QE008", "r:.%name%.summary"), // a template placeholder
        ("QE008", "r:a%.%b"),
        ("QE009", "f:{+/-x}"),        // `(+/)-x` is minus
        ("QE009", "f:{+/@[f;x;g]}"),  // a glyph applied with brackets
        ("QE009", "f:{{x+y}/x}"),     // a lambda operand
        ("QE009", "f:{(1;/x)}"),      // no derived function at all
        ("QE009", "f:{#'x}"),         // `(#')x` is a projection on KDB-X
        ("QE009", "f:{,/:x}"),        // so is `(,/:)x`
        ("QE009", "f:{,\\:x}"),       // and `(,\:)x`
        ("QE009", "f:{,/:'x}"),       // and `(,/:')x`
        ("QE011", "r:f over each x"), // `(f over) each`, the author's to place
        ("QE011", "r:+ each x"),      // `(+) each x` is a projection on KDB-X (#2251)
        ("QE011", "r:# each x"),      // and QE008 has the token's fix, `count each x`
        ("QE011", "r:x + each y"),
        ("QE011", "r:x in each y"), // `x (in) each y` is 'type, and `in'` a guess (#2259)
        ("QE011", "r:\"ab\" in each y"),
        ("QT029", "h:hopen 1.5"), // no handle it spells
        ("QT029", "h:hopen -1"),
        ("QT029", "h:hopen `"),
        ("QT029", "h:hopen `a`b"), // nor a vector with a colon (#2887)
        ("QT029", "h:hopen 0N"),
        ("QE012", "s:\u{201c}hi"),            // no close on the line
        ("QE012", "s:\u{201c}C:\\d\u{201d}"), // a backslash would be an escape
        ("QE012", "a:`\u{e9}"),               // no ASCII it stands for
        // An atom appended in place is 'type, where `r:r,x` lists (#2253).
        ("QV003", "f:{[n] r:0; i:0; while[i<n; r:r,i; i+:1]; r}"),
        ("QV003", "f:{[s] r:`; do[2; r:r,s]; r}"),
        ("QV003", "r:\"a\"\ndo[3; r:r,\"b\"]"),
        // `r:r,x` is all that makes `r` a local: `r,:x` would amend the
        // global `r` (#2798)
        ("QV003", "r:1 2\nf:{do[2; r:r,x]; r}"),
        ("QV003", "r:1 2\ng:{[x] do[1; r:r,x]; count r}"),
        ("QV003", "f:{g:{r:()}; do[2; r:r,x]; r}"), // assigned in another lambda
        ("QV003", "f:{s:`r:1; do[2; r:r,x]; r}"),   // and in a symbol
    ] {
        for finding in lint(source, "probe.q", Profile::Uqf)
            .iter()
            .filter(|f| f.code == code)
        {
            assert!(fix_for(finding, source).is_none(), "{code} fixed {source}");
        }
    }
}

/// `--fix` over the shapes of #2214-#2239, in every profile. What q 5 runs
/// comes back byte for byte - a minute before a glyph (`a:12:?10` is
/// `12:00?10`, and once became the refused `a:12:distinct 10`), a symbol
/// before an iterator or an I/O verb, a keyword with a point in a name, a
/// fraction with an `s` - and what it refuses becomes, where a fix applies,
/// a line it parses. Each row was checked with `parse` on KDB-X q 5 on both
/// sides.
#[test]
fn fix_leaves_what_q_runs_and_repairs_only_what_it_refuses() {
    use q_lint_rs::{Profile, fix_all, lint};
    let runs = [
        "a:12:?10",
        "a:12:30:?10",
        "a:12:#10",
        "a:25:@00:00.000",
        "a:x`a/b",
        "a:1`a/b",
        "a:x`a'b",
        "a:`b: 2:x",
        "a:`b: 0:x",
        "a:3.0s",
        "a:1 2.0s",
        "exec.fill:{x}\nb:exec.fill 1",
        "f:{[name.] 1}",
        "a:x in '\"a\"",
        "a:x '[y]",
        "a:(::)1",
        "a:x.,y",
        "a:select from -1#t",
    ];
    let repaired = [
        ("a:\"s\".,x", "a:\"s\". enlist x"),
        ("a:().!()", "a:(). key ()"),
        ("a:x[0].-y", "a:x[0]. neg y"),
        ("a:select from !t", "a:select from key t"),
        ("a:select from- t", "a:select from neg t"),
    ];
    for profile in [Profile::General, Profile::Style, Profile::Uqf] {
        let fix = |source: &str| {
            fix_all(source, false, |text| {
                Ok::<_, ()>(lint(text, "probe.q", profile))
            })
            .unwrap()
            .text
        };
        for source in runs {
            assert_eq!(fix(source), source, "{profile:?}");
        }
        for (source, fixed) in repaired {
            assert_eq!(fix(source), fixed, "{profile:?}");
        }
    }
    // Nothing q refuses for want of a left operand is given a meaning: `..a`
    // is a name typed with a point too many, not `value .a`, and
    // `update a from\ t` has no operand to put in parentheses.
    for source in [
        "a:..a",
        "a:update a from\\ t",
        "a:in b",
        "a:(::1)",
        "a:<>0",
        "a:(+-)",
    ] {
        for finding in lint(source, "probe.q", Profile::Uqf) {
            assert!(q_lint_rs::fix_for(&finding, source).is_none(), "{source}");
        }
    }
}

/// The findings of `codes` alone, with every rule run: QP007 is in no
/// profile, so a profile cannot be asked for it.
#[cfg(test)]
fn selected(source: &str, codes: &[&str]) -> Vec<q_lint_rs::Finding> {
    q_lint_rs::lint_every_rule(source, "probe.q", &q_lint_rs::Workspace::default(), true)
        .into_iter()
        .filter(|f| codes.contains(&f.code.as_str()))
        .collect()
}

/// What `--fix` leaves of `source` with `codes` selected.
#[cfg(test)]
fn fixed_selecting(source: &str, codes: &[&str]) -> String {
    q_lint_rs::fix_all(source, false, |text| Ok::<_, ()>(selected(text, codes)))
        .unwrap()
        .text
}

/// QP005 and QP007 share one fix - parentheses round the right operand of
/// the operator before a change of family, where q groups already - and it
/// reaches a mix wherever its operand has an end: any line of a statement,
/// a qSQL phrase, beside a dotted name that ends in a qSQL word (#846,
/// #847). Each row is a source, then what is left of it with QP005 selected,
/// with QP007, and with both. Every changed row was parsed in KDB-X before
/// and after, and the trees were the same.
#[test]
fn the_precedence_fix_reaches_every_line_of_a_statement_and_every_phrase() {
    let cases = [
        (
            "mid:0.5*bid+ask",
            "mid:0.5*(bid+ask)",
            "mid:0.5*bid+ask",
            "mid:0.5*(bid+ask)",
        ),
        (
            "stamp:start+step*til n",
            "stamp:start+step*til n",
            "stamp:start+(step*til n)",
            "stamp:start+(step*til n)",
        ),
        (
            "d:s*1+0.0005*-1+2*r",
            "d:s*(1+(0.0005*(-1+2*r)))",
            "d:s*1+0.0005*-1+2*r",
            "d:s*(1+(0.0005*(-1+(2*r))))",
        ),
        (
            "ts:t0+0D00:00:01*til n",
            "ts:t0+0D00:00:01*til n",
            "ts:t0+(0D00:00:01*til n)",
            "ts:t0+(0D00:00:01*til n)",
        ),
        (
            "f:{[a;b]\n  c:a*b+1;\n  d:a+b*2;\n  c+d}",
            "f:{[a;b]\n  c:a*(b+1);\n  d:a+b*2;\n  c+d}",
            "f:{[a;b]\n  c:a*b+1;\n  d:a+(b*2);\n  c+d}",
            "f:{[a;b]\n  c:a*(b+1);\n  d:a+(b*2);\n  c+d}",
        ),
        (
            "t:([] a:1 2 3;\n  b:2*x+1;\n  c:x+y*2)",
            "t:([] a:1 2 3;\n  b:2*(x+1);\n  c:x+y*2)",
            "t:([] a:1 2 3;\n  b:2*x+1;\n  c:x+(y*2))",
            "t:([] a:1 2 3;\n  b:2*(x+1);\n  c:x+(y*2))",
        ),
        (
            "r:select mid:0.5*bid+ask, spread:ask-bid from q",
            "r:select mid:0.5*(bid+ask), spread:ask-bid from q",
            "r:select mid:0.5*bid+ask, spread:ask-bid from q",
            "r:select mid:0.5*(bid+ask), spread:ask-bid from q",
        ),
        (
            "r:select a:x+y*z, b by c*d+e from t where f*g+h, i",
            "r:select a:x+y*z, b by c*(d+e) from t where f*(g+h), i",
            "r:select a:x+(y*z), b by c*d+e from t where f*g+h, i",
            "r:select a:x+(y*z), b by c*(d+e) from t where f*(g+h), i",
        ),
        (
            "x:.a.from+0D01*1+til 5",
            "x:.a.from+(0D01*(1+til 5))",
            "x:.a.from+0D01*1+til 5",
            "x:.a.from+(0D01*(1+til 5))",
        ),
        (
            "v:.a.by+0D01*1+til 5",
            "v:.a.by+(0D01*(1+til 5))",
            "v:.a.by+0D01*1+til 5",
            "v:.a.by+(0D01*(1+til 5))",
        ),
        (
            "r:select a from t,u*v+w where b",
            "r:select a from t,u*(v+w) where b",
            "r:select a from t,u*v+w where b",
            "r:select a from t,u*(v+w) where b",
        ),
        (
            "r:select a*b+(c,d), e from t",
            "r:select a*(b+(c,d)), e from t",
            "r:select a*b+(c,d), e from t",
            "r:select a*(b+(c,d)), e from t",
        ),
        (
            "r:select from t where a*b+c>0, d",
            "r:select from t where a*(b+c>0), d",
            "r:select from t where a*b+c>0, d",
            "r:select from t where a*(b+c>0), d",
        ),
        (
            "r:a*b+\n  c",
            "r:a*(b+\n  c)",
            "r:a*b+\n  c",
            "r:a*(b+\n  c)",
        ),
        (
            "r:a*b+c / note",
            "r:a*(b+c) / note",
            "r:a*b+c / note",
            "r:a*(b+c) / note",
        ),
        (
            "\"s\",string 2*3+4",
            "\"s\",string 2*(3+4)",
            "\"s\",string 2*3+4",
            "\"s\",string 2*(3+4)",
        ),
        (
            "r:f[2*3+4;1]",
            "r:f[2*(3+4);1]",
            "r:f[2*3+4;1]",
            "r:f[2*(3+4);1]",
        ),
        (
            "k:(2*3+4;5+6*7)",
            "k:(2*(3+4);5+6*7)",
            "k:(2*3+4;5+(6*7))",
            "k:(2*(3+4);5+(6*7))",
        ),
        ("r:a+b*c-d", "r:a+(b*(c-d))", "r:a+b*c-d", "r:a+(b*(c-d))"),
        ("r:a*/:b+c", "r:a*/:(b+c)", "r:a*/:b+c", "r:a*/:(b+c)"),
        (
            "r:a*b+exec c from t where d, e",
            "r:a*(b+exec c from t where d, e)",
            "r:a*b+exec c from t where d, e",
            "r:a*(b+exec c from t where d, e)",
        ),
        (
            "s:select a*b from t where c+d*e",
            "s:select a*b from t where c+d*e",
            "s:select a*b from t where c+(d*e)",
            "s:select a*b from t where c+(d*e)",
        ),
        (
            "u:update v:a%b-c by s from t",
            "u:update v:a%(b-c) by s from t",
            "u:update v:a%b-c by s from t",
            "u:update v:a%(b-c) by s from t",
        ),
        (
            "g:{[t] select a:b*c+d,\n    e:f+g*h\n    from t}",
            "g:{[t] select a:b*(c+d),\n    e:f+g*h\n    from t}",
            "g:{[t] select a:b*c+d,\n    e:f+(g*h)\n    from t}",
            "g:{[t] select a:b*(c+d),\n    e:f+(g*h)\n    from t}",
        ),
    ];
    for (source, trap, routine, both) in cases {
        for (codes, expected) in [
            (&["QP005"][..], trap),
            (&["QP007"][..], routine),
            (&["QP005", "QP007"][..], both),
        ] {
            let once = fixed_selecting(source, codes);
            assert_eq!(once, expected, "{codes:?} on {source}");
            // Nothing the rule reports is left, and a second run has nothing
            // to do: `--fix` twice is `--fix` once.
            assert!(
                selected(&once, codes).is_empty(),
                "{codes:?} left in {once}"
            );
            assert_eq!(fixed_selecting(&once, codes), once, "{codes:?} twice");
        }
    }
}

/// Where the right operand's end cannot be told there is no fix, the text
/// is left as it was, and the finding stays for a person to read.
#[test]
fn the_precedence_fix_is_refused_where_the_operand_has_no_end() {
    for (code, source) in [
        // A right side that ends in an operator, or in `::`, is a composition.
        ("QP005", "tanh:1f-2f%1f+exp 2f*"),
        ("QP005", "r:a*b+neg::"),
        ("QP007", "r:a+b*neg::"),
        // `*[b;c]` applies in brackets: in parentheses it is a table header.
        ("QP005", "r:a*[b;c]+d"),
        // A template that opens in the phrase of another, with no
        // parentheses of its own, takes the commas after it into its table:
        // q 5 reads this as one constraint, not two.
        ("QP005", "r:select from t where a*b+exec c from u, d"),
        ("QP007", "r:select from t where a+b*exec c from u, d"),
        // A qSQL word where no phrase expects one.
        ("QP005", "r:select from t where a*b+c from, d"),
    ] {
        let found = selected(source, &[code]);
        assert_eq!(found.len(), 1, "{code} on {source}: {found:?}");
        assert!(
            q_lint_rs::fix_for(&found[0], source).is_none(),
            "{code} fixed {source}"
        );
        assert_eq!(fixed_selecting(source, &["QP005", "QP007"]), source);
    }
}

/// Each message names the two operators of the run it is about and says
/// which of them q performs first - the one fact the two rules differ in.
#[test]
fn each_precedence_message_says_which_operation_q_performs_first() {
    let detail = |source: &str| -> Vec<(String, String)> {
        selected(source, &["QP005", "QP007"])
            .into_iter()
            .map(|f| (f.code, f.detail))
            .collect()
    };
    assert_eq!(
        detail("mid:0.5*bid+ask"),
        [(
            "QP005".to_string(),
            "`*` with `+` to its right and no parentheses: q evaluates right-to-left and \
             performs the `+` first, where school precedence performs the `*` first"
                .to_string()
        )]
    );
    assert_eq!(
        detail("r:a-b%c"),
        [(
            "QP007".to_string(),
            "`-` with `%` to its right and no parentheses: q evaluates right-to-left and \
             performs the `%` first, as school precedence does"
                .to_string()
        )]
    );
    // The operators named are the trap's: the `%` and the `-` after it, not
    // the `+` before.
    assert_eq!(
        detail("r:a+b%c-d"),
        [(
            "QP005".to_string(),
            "`%` with `-` to its right and no parentheses: q evaluates right-to-left and \
             performs the `-` first, where school precedence performs the `%` first"
                .to_string()
        )]
    );
}

/// F, the forward fix: what `--fix` leaves with QP005 and QP007 selected.
#[cfg(test)]
fn forward(source: &str) -> String {
    fixed_selecting(source, &["QP005", "QP007"])
}

/// R, the reverse fix: what `--fix` leaves with QP008 selected.
#[cfg(test)]
fn reverse(source: &str) -> String {
    fixed_selecting(source, &["QP008"])
}

/// The round trip QP008 promises, on one source: R(F(x)) is R(x) and
/// F(R(x)) is F(x), each fix is idempotent, and R takes out parentheses and
/// nothing else - the same text with every pair dropped, and never a pair
/// F would not have written (#848).
#[cfg(test)]
fn assert_round_trip(x: &str) {
    let (f, r) = (forward(x), reverse(x));
    assert_eq!(reverse(&f), r, "R(F(x)) on {x}");
    assert_eq!(forward(&r), f, "F(R(x)) on {x}");
    assert_eq!(forward(&f), f, "F twice on {x}");
    assert_eq!(reverse(&r), r, "R twice on {x}");
    assert!(selected(&r, &["QP008"]).is_empty(), "QP008 left in {r}");
    let bare = |t: &str| t.replace(['(', ')'], "");
    assert_eq!(bare(&r), bare(x), "R changed more than parentheses in {x}");
    assert!(
        r.matches('(').count() <= x.matches('(').count(),
        "R added a pair to {x}"
    );
}

/// QP008 is QP005's and QP007's fix read backwards: each row is a source,
/// then F(x) - the forward fix with both selected - and R(x), the reverse.
/// Every row R changes was parsed in KDB-X before and after, and the trees
/// were the same.
#[test]
fn the_reverse_fix_undoes_the_forward_fix_byte_for_byte() {
    let cases = [
        ("mid:0.5*(bid+ask)", "mid:0.5*(bid+ask)", "mid:0.5*bid+ask"),
        ("mid:0.5*bid+ask", "mid:0.5*(bid+ask)", "mid:0.5*bid+ask"),
        (
            "stamp:start+(step*til n)",
            "stamp:start+(step*til n)",
            "stamp:start+step*til n",
        ),
        (
            "d:s*1+0.0005*-1+2*r",
            "d:s*(1+(0.0005*(-1+(2*r))))",
            "d:s*1+0.0005*-1+2*r",
        ),
        (
            "d:s*(1+0.0005*-1+2*r)",
            "d:s*(1+(0.0005*(-1+(2*r))))",
            "d:s*1+0.0005*-1+2*r",
        ),
        (
            "f:{[a;b]\n  c:a*(b+1);\n  d:a+b*2;\n  c+d}",
            "f:{[a;b]\n  c:a*(b+1);\n  d:a+(b*2);\n  c+d}",
            "f:{[a;b]\n  c:a*b+1;\n  d:a+b*2;\n  c+d}",
        ),
        (
            "r:select a:x+(y*z), b by c*(d+e) from t where f*(g+h), i",
            "r:select a:x+(y*z), b by c*(d+e) from t where f*(g+h), i",
            "r:select a:x+y*z, b by c*d+e from t where f*g+h, i",
        ),
        (
            "x:.a.from+(0D01*(1+til 5))",
            "x:.a.from+(0D01*(1+til 5))",
            "x:.a.from+0D01*1+til 5",
        ),
        (
            "r:select a*(b+(c,d)), e from t",
            "r:select a*(b+(c,d)), e from t",
            "r:select a*b+(c,d), e from t",
        ),
        ("r:a*(b+\n  c)", "r:a*(b+\n  c)", "r:a*b+\n  c"),
        ("r:a*(b+c) / note", "r:a*(b+c) / note", "r:a*b+c / note"),
        ("r:f[2*(3+4);1]", "r:f[2*(3+4);1]", "r:f[2*3+4;1]"),
        (
            "k:(2*(3+4);5+6*7)",
            "k:(2*(3+4);5+(6*7))",
            "k:(2*3+4;5+6*7)",
        ),
        ("r:a*/:(b+c)", "r:a*/:(b+c)", "r:a*/:b+c"),
        ("r:a* (b+c)", "r:a* (b+c)", "r:a* b+c"),
        ("r:a -(b*c)", "r:a -(b*c)", "r:a -b*c"),
        ("r:a*(-1+b)", "r:a*(-1+b)", "r:a*-1+b"),
        (
            "r:t+($[p;-1;1]*12:00)",
            "r:t+($[p;-1;1]*12:00)",
            "r:t+$[p;-1;1]*12:00",
        ),
        ("r:a+(@[f;x]*2)", "r:a+(@[f;x]*2)", "r:a+@[f;x]*2"),
        ("r:a*(-[b;c]+d)", "r:a*(-[b;c]+d)", "r:a*-[b;c]+d"),
        (
            "r:a*(b+exec c from t where d, e)",
            "r:a*(b+exec c from t where d, e)",
            "r:a*b+exec c from t where d, e",
        ),
        (
            "g:{[t] select a:b*(c+d),\n    e:f+(g*h)\n    from t}",
            "g:{[t] select a:b*(c+d),\n    e:f+(g*h)\n    from t}",
            "g:{[t] select a:b*c+d,\n    e:f+g*h\n    from t}",
        ),
        // A pair F would not write stays, and F adds its own beside it.
        ("r:a*(b*c+d)", "r:a*(b*(c+d))", "r:a*(b*c+d)"),
        ("r:a+b*(c+d)", "r:a+(b*(c+d))", "r:a+b*c+d"),
    ];
    for (x, f, r) in cases {
        assert_eq!(forward(x), f, "F on {x}");
        assert_eq!(reverse(x), r, "R on {x}");
        assert_round_trip(x);
    }
}

/// Parentheses that change the parse, or that the forward fix would not
/// have written, are never reported: QP008 reads only the pairs it can give
/// back (#848).
#[test]
fn the_reverse_rule_reports_no_pair_the_forward_fix_would_not_write() {
    for source in [
        // Regrouped: q would read the line differently without them.
        "r:(0.5*bid)+ask",
        "r:(a*b)+c",
        "r:a*(b+c)*d",
        "r:a*(b+c)[0]",
        // The same family on both sides, or no operator inside.
        "r:a+(b+c)",
        "r:a*(b*c)",
        "r:a*(b)",
        "r:a*(f x)",
        // Not the right operand of an infix operator.
        "r:f[(a*b);c]",
        "r:(a;b+c*d)",
        "r:g (a+b*c)",
        "r:a,(b*c)",
        "r:a*(b+c;d)",
        // A token would fuse: `-1` becomes a literal, `c` and `from` a name.
        "r:a -(1+b)",
        "r:a -(.5*b)",
        "r:2 -(1*b)",
        "q:select m:a*(b+c)from t",
        // What it holds starts with an operator, or an adverb.
        "r:a*(-b+c)",
        "r:a+('[f;g]*2)",
        // A run of the other family that does not open what it holds.
        "r:a*(b,c+d)",
        // Without the pair the operand would run on: a template opening in
        // another's phrase, or a newline the statement does not continue.
        "r:select from t where a*(b+exec c from u), d",
        "r:a*(b+\nc)",
        // A blank or a comment inside: the forward fix writes neither.
        "r:a*( b+c)",
        "r:a*(b+c )",
        "r:a*(b+c / note\n  )",
        // In a string or a comment.
        "s:\"a*(b+c)\"",
        "r:1 / a*(b+c)",
    ] {
        let found = selected(source, &["QP008"]);
        assert!(found.is_empty(), "QP008 on {source}: {found:?}");
        assert_eq!(reverse(source), source);
    }
}

/// The round trip over expressions nobody wrote by hand: every operator
/// pattern over a few operand kinds, each with no parentheses, with the
/// forward fix's, and with pairs placed at random - some the fix's, most
/// not - in the contexts the forward fix reaches (#848).
#[test]
fn the_round_trip_holds_over_generated_infix_expressions() {
    let operands = ["a", "1", "2.5", "f x", "b c", "-1", "til n", "x`y"];
    let ops = ['+', '-', '*', '%'];
    let contexts = [
        ("r:", ""),
        ("r:f[", ";1]"),
        ("g:{[a;b] c:", "; c}"),
        ("s:select m:", ", n by k from t"),
        ("s:select from t where ", ", k"),
        ("r:(", ";0)"),
    ];
    // A small linear congruential generator: the cases are the same on
    // every run, and no dependency is added for them.
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = |n: usize| {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) as usize % n
    };
    const ROUNDS: usize = 40;
    let mut checked = 0;
    for _ in 0..ROUNDS {
        let len = 2 + next(4);
        let tokens: Vec<String> = (0..len)
            .map(|_| operands[next(operands.len())].to_string())
            .collect();
        let chosen: Vec<char> = (1..len).map(|_| ops[next(ops.len())]).collect();
        // A pair from operand i to the end, for each i a coin says.
        let mut text = tokens[0].clone();
        let mut closes = 0;
        for (i, op) in chosen.iter().enumerate() {
            text.push(*op);
            if next(3) == 0 {
                text.push('(');
                closes += 1;
            }
            text.push_str(&tokens[i + 1]);
        }
        text.push_str(&")".repeat(closes));
        let (head, tail) = contexts[next(contexts.len())];
        let x = format!("{head}{text}{tail}");
        assert_round_trip(&x);
        // And from the bare line, and from the fully parenthesised one.
        assert_round_trip(&format!("{head}{}{tail}", text.replace(['(', ')'], "")));
        assert_round_trip(&forward(&x));
        checked += 1;
    }
    assert_eq!(checked, ROUNDS);
}

/// `--fix` twice writes what `--fix` once did, and a finding it leaves is
/// counted on standard error as one it has no fix for, so that "still
/// reported" is not read as "run it again" (#847).
#[test]
fn fix_says_how_many_findings_it_has_no_fix_for() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mix.q");
    let source = "mid:0.5*bid+ask\nstamp:start+step*til n\ntanh:1f-2f%1f+exp 2f*\n";
    fs::write(&path, source).unwrap();
    let fix = |select: &str| {
        let output = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(["--isolated", "--select", select, "--fix"])
            .arg(&path)
            .output()
            .unwrap();
        (
            String::from_utf8(output.stderr).unwrap(),
            fs::read_to_string(&path).unwrap(),
        )
    };
    let left = "qlinter: 1 finding(s) left have no fix: --fix again would not change them\n";
    let once = "mid:0.5*(bid+ask)\nstamp:start+(step*til n)\ntanh:1f-2f%1f+exp 2f*\n";
    assert_eq!(
        fix("QP005,QP007"),
        (
            format!("qlinter: fixed 2 finding(s) in 1 file(s)\n{left}"),
            once.to_string()
        )
    );
    assert_eq!(
        fix("QP005,QP007"),
        (
            format!("qlinter: fixed 0 finding(s) in 0 file(s)\n{left}"),
            once.to_string()
        )
    );
    // Nothing is said where nothing is left, or where what is left has a fix
    // the run was not asked to apply - except to say which flag applies it.
    fs::write(&path, "mid:0.5*bid+ask\nc:1&&2\n").unwrap();
    assert_eq!(fix("QP005").0, "qlinter: fixed 1 finding(s) in 1 file(s)\n");
    assert_eq!(
        fix("QE004").0,
        "qlinter: fixed 0 finding(s) in 0 file(s)\n\
         qlinter: 1 finding(s) left have a fix that only --unsafe-fixes applies\n"
    );
    // A file whose brackets do not close is never rewritten, so nothing in
    // it has a fix, whatever the rule.
    fs::write(&path, "f:{[x]\nmid:0.5*bid+ask\n").unwrap();
    assert_eq!(
        fix("QP005"),
        (
            format!("qlinter: fixed 0 finding(s) in 0 file(s)\n{left}"),
            "f:{[x]\nmid:0.5*bid+ask\n".to_string()
        )
    );
}

/// A file that is not UTF-8 is never rewritten, so what `--fix` and
/// `--add-noqa` leave in it is for that reason, not for having no fix or
/// being on a line no comment can follow: both QE004s here have a fix, and
/// QF016's line takes a comment (#2121).
#[test]
fn what_a_file_that_is_not_utf8_leaves_is_put_down_to_its_encoding() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("nonutf.q");
    let original = b"a:1==2\nb:\"caf\xe9\"\nc:x==y\nf:{[x;y] x}\n".to_vec();
    fs::write(&path, &original).unwrap();
    let run = |flag: &str| {
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .args(["--isolated", "--select", "QE004,QF016", flag])
            .arg(&path)
            .output()
            .unwrap();
        (out.status.code(), String::from_utf8(out.stderr).unwrap())
    };
    let (status, err) = run("--fix");
    assert_eq!(status, Some(1), "{err}");
    assert!(
        err.contains(
            "qlinter: 3 finding(s) left are in files that are not valid UTF-8, which --fix never rewrites"
        ),
        "{err}"
    );
    assert!(!err.contains("have no fix"), "{err}");
    let (status, err) = run("--add-noqa");
    assert_eq!(status, Some(1), "{err}");
    assert!(
        err.contains(
            "qlinter: 3 finding(s) left are in files that are not valid UTF-8, which --add-noqa never rewrites"
        ),
        "{err}"
    );
    assert!(!err.contains("no comment can follow"), "{err}");
    assert_eq!(fs::read(&path).unwrap(), original);
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

/// Nor does it write a parameter the linter's own rules then report: an
/// empty slot (QF009) for `{[] b}`, or an `x` and `y` never read (QF016)
/// before the `z` that is (#2797).
#[test]
fn qf005_fix_writes_no_parameter_another_rule_reports() {
    use q_lint_rs::{Profile, fix_for, lint};
    for source in [
        "f:{[b] g:{[] b}; g[]}",
        "f:{[a] {a+z} . (1;2;3)}",
        "f:{[a] {a+y}'[1 2;3 4]}",
        "f:{[a] g:{a}; g 1}",
    ] {
        for profile in [Profile::Style, Profile::StyleQ, Profile::Uqf] {
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
            let after = lint(&fixed, "probe.q", profile);
            assert!(after.is_empty(), "{fixed}: {after:?}");
        }
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
            "f:{x,y}\nc:f f 1\nd:4\ne:5\nh:f 2\n",
            "@@ -1,5 +1,5 @@\n f:{x,y}\n-c:f f 1\n+c:f[f[1]]\n d:4\n e:5\n-h:f 2\n+h:f[2]\n",
        ),
        (
            "passes.q",
            "hs:{x,y}\nsq:{x,y}\nf:{(sq hs x)}\nmid:1\ng:{(sq hs x)}\n",
            "@@ -1,5 +1,5 @@\n hs:{x,y}\n sq:{x,y}\n-f:{(sq hs x)}\n+f:{(sq[hs[x]])}\n mid:1\n\
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

/// What `r` holds once `script` has run on the q that QLINT_TEST_Q names (a
/// command line): `.Q.s1 r`, or `'` and the error q signalled. Each script
/// runs in a q of its own, so no global one leaves can stand in for a name
/// another forgot. `None` where no q is named, as in CI.
fn on_q(script: &str) -> Option<String> {
    let q = std::env::var("QLINT_TEST_Q").ok()?;
    let mut words = q.split_whitespace();
    let dir = tempfile::tempdir().unwrap();
    let case = dir.path().join("case.q");
    fs::write(&case, script).unwrap();
    let driver = dir.path().join("driver.q");
    fs::write(
        &driver,
        format!(
            "-1 .[{{system \"l \",x; .Q.s1 r}};enlist {:?};{{\"'\",x}}];\nexit 0\n",
            case.display().to_string()
        ),
    )
    .unwrap();
    let out = Command::new(words.next()?)
        .args(words)
        .arg(&driver)
        .arg("-q")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("run q");
    Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// `on_q` over each script, or `None` - said once - where no q is named.
fn values_on_q(scripts: &[String]) -> Option<Vec<String>> {
    let values: Option<Vec<String>> = scripts.iter().map(|s| on_q(s)).collect();
    if values.is_none() {
        eprintln!("QLINT_TEST_Q names no q: the values stand as KDB-X gave them");
    }
    values
}

/// What `--fix` leaves of `source` with `codes` selected, and with the
/// editor-only fixes too where `unsafe_fixes`.
fn fixed_with(source: &str, codes: &[&str], unsafe_fixes: bool) -> String {
    q_lint_rs::fix_all(source, unsafe_fixes, |text| {
        Ok::<_, ()>(selected(text, codes))
    })
    .unwrap()
    .text
}

/// QE008 and QE011 both report the glyph of `r:# each x`, which q 5
/// refuses. Only QE008 rewrites it - to `count each x`, what q 4 made of
/// it. QE011's `(#) each x` was the other edit for the same token, and on
/// KDB-X it is `#'[x]`: a projection, where a list was meant (#2251).
#[test]
fn a_glyph_before_each_gets_one_fix_and_it_keeps_the_monadic_reading() {
    for (source, fixed) in [
        ("r:# each x", "r:count each x"),
        ("r:- each x", "r:neg each x"),
        ("r:, each x", "r:enlist each x"),
    ] {
        for unsafe_fixes in [false, true] {
            assert_eq!(fixed_with(source, &["QE008", "QE011"], unsafe_fixes), fixed);
            assert_eq!(fixed_with(source, &["QE011"], unsafe_fixes), source);
        }
        let token: Vec<_> = selected(source, &["QE008", "QE011"])
            .iter()
            .filter_map(|f| q_lint_rs::fix_for(f, source))
            .collect();
        assert_eq!(token.len(), 1, "{source}");
    }
    let scripts = [
        "x:(1 2;3);r:count each x",
        "x:(1 2;3);r:(#) each x",
        "x:1 2 3;r:neg each x",
    ]
    .map(String::from);
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    assert_eq!(values, ["2 1", "#'[(1 2;3)]", "-1 -2 -3"]);
}

/// One statement, one fix, however it is laid out. An indented line goes
/// on with the line above, so `s:x` over `  in each y` has `x` on the left
/// as `s:x in each y` does, after a comment line or a no-break space too -
/// and plain `--fix` once rewrote those two as having nothing there (#2252).
#[test]
fn the_same_statement_gets_the_same_fix_however_it_is_laid_out() {
    let layouts = |one: &str, word: &str| {
        let (head, tail) = one.split_once(word).unwrap();
        [
            one.to_string(),
            format!("{}\n  {word}{tail}", head.trim_end()),
            format!("{} / note\n\n  / more\n  {word}{tail}", head.trim_end()),
            format!("{}\u{a0}{word}{tail}", head.trim_end()),
        ]
    };
    for (one, word) in [
        ("s:x in each y", "in"),
        ("t:{[x;y] x mod each y}", "mod"),
        ("u:\"ab\" in each y", "in"),
    ] {
        for source in layouts(one, word) {
            // Nothing for plain `--fix`, which QE012 would only make a space.
            assert_eq!(fixed_with(&source, &["QE011"], false), source, "{source:?}");
        }
    }
    for (one, word, fixed) in [
        ("r:cor each x", "cor", "(cor)"),
        ("f:{[x] mod prior x}", "mod", "(mod)"),
    ] {
        let mut fixes = vec![];
        for source in layouts(one, word) {
            let after = fixed_with(&source, &["QE011"], false);
            assert_eq!(after, source.replacen(word, fixed, 1), "{source:?}");
            fixes.push(after);
        }
        // `(mod) prior x` is `x mod' prev x` on KDB-X, on every layout.
        if one.starts_with("f:") {
            let scripts = fixes[..3]
                .iter()
                .map(|f| format!("{f}\nr:f 10 4 7\n"))
                .collect::<Vec<_>>();
            if let Some(values) = values_on_q(&scripts) {
                assert_eq!(values, ["0N 4 3"; 3]);
            }
        }
    }
}

/// With an operand on the left there is no QE011 fix, not even in the
/// editor: `x (in) each y` applies x to a list of projections, 'type for
/// any data, and which of `x in' y` and `in[x] each y` was meant the
/// message offers and the author picks (#2259).
#[test]
fn an_infix_keyword_with_a_left_operand_before_each_is_not_rewritten() {
    for source in ["a:x in each y", "a:x mod each y", "a:x\n  in each y"] {
        for unsafe_fixes in [false, true] {
            assert_eq!(fixed_with(source, &["QE011"], unsafe_fixes), source);
        }
    }
    let scripts = [
        "x:1 2;y:(1 3;2 4);r:x (in) each y",
        "x:7;y:3 4;r:x (mod) each y",
        "x:1 2;y:(1 3;2 4);r:x in' y",
    ]
    .map(String::from);
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    assert_eq!(values, ["'type", "'type", "11b"]);
}

/// QV003's `r,:x` appends in place, and refuses what `r:r,x` lists: an atom
/// to append to, or an item of another type. Where `r` was last an atom
/// literal there is no fix; elsewhere it stays in the editor, its title
/// saying so (#2253).
#[test]
fn append_in_place_is_offered_only_where_it_can_succeed() {
    let source = "f:{[n] r:(); i:0; while[i<n; r:r,i; i+:1]; r}";
    let finding = selected(source, &["QV003"]).remove(0);
    let fix = q_lint_rs::fix_for(&finding, source).unwrap();
    assert!(
        !fix.batch_safe && fix.title.contains("'type"),
        "{}",
        fix.title
    );
    let scripts = [
        "f:{[n] r:0; i:0; while[i<n; r:r,i; i+:1]; r};r:f 3",
        "f:{[n] r:0; i:0; while[i<n; r,:i; i+:1]; r};r:f 3",
        "f:{[n] r:(); i:0; while[i<n; r:r,i; i+:1]; r};r:f 3",
        "f:{[n] r:(); i:0; while[i<n; r,:i; i+:1]; r};r:f 3",
        "r:(); r,:1; r,:1.5",
    ]
    .map(String::from);
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    assert_eq!(values, ["0 0 1 2", "'type", "0 1 2", "0 1 2", "'type"]);
}

/// QP002 changes the type, never the instant: a cast is swapped only before
/// a date, datetime or timestamp literal or the clock, where q 5 gives the
/// same time both ways. Before a number it is not - one day as a datetime,
/// one nanosecond as a timestamp - and there is no fix (#2254).
#[test]
fn a_datetime_cast_fix_keeps_the_instant() {
    let operands = ["2020.01.01", "2020.01.01T10:00:00.123", "2020.01.01D10:00"];
    for operand in operands {
        let source = format!("r:`datetime${operand}");
        let fixed = fixed_with(&source, &["QP002"], true);
        // The datetime literal is QP002's too, and becomes a timestamp.
        assert_eq!(fixed, format!("r:`timestamp${}", operand.replace('T', "D")));
    }
    for source in [
        "r:`datetime$1",
        "r:`datetime$2.5",
        "r:`datetime$x",
        "r:15h$1",
    ] {
        assert_eq!(fixed_with(source, &["QP002"], true), source);
    }
    let mut scripts: Vec<String> = operands
        .iter()
        .map(|o| format!("r:(`timestamp$`datetime${o})=`timestamp${o}"))
        .collect();
    scripts.push("r:(`timestamp$`datetime$1)=`timestamp$1".into());
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    assert_eq!(values, ["1b", "1b", "1b", "0b"]);
}

/// `asc` marks what it sorted and `reverse desc` does not, so that rewrite
/// changes what `attr` says of a list and of a table's first column: it is
/// offered in the editor with a title that says so. `desc` for `reverse asc`
/// has nothing to say - neither marks anything (#2800).
#[test]
fn asc_for_reverse_desc_says_the_result_is_marked_sorted() {
    let title = |source: &str| {
        let finding = selected(source, &["QR001"]).remove(0);
        let fix = q_lint_rs::fix_for(&finding, source).unwrap();
        assert!(!fix.batch_safe, "{source}");
        fix.title.to_string()
    };
    assert!(
        title("r:reverse desc 3 1 2").contains("marks the result as sorted"),
        "{}",
        title("r:reverse desc 3 1 2")
    );
    assert_eq!(
        title("r:reverse asc 3 1 2"),
        "Replace `reverse asc` with `desc`"
    );
    let scripts = [
        "r:attr reverse desc 3 1 2 1",
        "r:attr asc 3 1 2 1",
        "r:(attr reverse asc 3 1 2 1;attr desc 3 1 2 1)",
        "r:(reverse desc 3 1 2 1)~asc 3 1 2 1",
        "r:(attr first flip reverse desc t;attr first flip asc t:([]a:3 1 2))",
    ]
    .map(String::from);
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    assert_eq!(values, ["`", "`s", "``", "1b", "``s"]);
}

/// `asc scan x` iterates `asc` to convergence, so `reverse` reverses the
/// iterations, and `desc scan x` is another list: nothing to rewrite, as
/// after `each` (#2255).
#[test]
fn a_sort_under_scan_or_prior_is_not_rewritten() {
    for source in [
        "x:3 1 2;r:reverse asc scan x",
        "x:3 1 2;r:reverse asc prior x",
        "x:3 1 2;r:reverse desc over x",
    ] {
        assert_eq!(fixed_with(source, &["QR001"], true), source);
    }
    let scripts = ["r:reverse asc scan 3 1 2", "r:desc scan 3 1 2"].map(String::from);
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    assert_eq!(values, ["(`s#1 2 3;3 1 2)", "(3 1 2;3 2 1)"]);
}

/// QB006 groups the comparisons an `and` or `or` swallows, and a symbol or
/// a dotted name that spells the word is no keyword: the parenthesis once
/// closed inside it, `(s=`)and and b=0`, which q 5 cannot parse (#2256).
#[test]
fn a_where_phrase_fix_leaves_a_symbol_spelling_and_whole() {
    let cases = [
        ("s=`and and b=0", "(s=`and) and b=0"),
        ("s=`x.and and b=0", "(s=`x.and) and b=0"),
        ("s=x.and and b=0", "(s=x.and) and b=0"),
        ("s=`or or b=0", "(s=`or) or b=0"),
        ("s=`a`and and b=0", "(s=`a`and) and b=0"),
    ];
    let mut scripts = vec![];
    for (phrase, fixed) in cases {
        let source = format!("r:select from t where {phrase}");
        let after = fixed_with(&source, &["QB006"], true);
        assert_eq!(after, format!("r:select from t where {fixed}"));
        scripts.push(format!(
            "x.and:`and;t:([]s:`and`or`x.and`a;b:0 0 0 1);\n{after}\nr:count r"
        ));
    }
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    // The last compares with two symbols, 'length as it was before (QB008).
    assert_eq!(values, ["1", "1", "1", "3", "'length"]);
}

/// QP006 brackets `f x` only where `f` is applied: q 5 parses `f dsave x`
/// and `f setenv x` as the infix call, which `f[dsave x]` is not - and
/// does not parse at all - while `f aj x` and `f find x` are `f` applied,
/// so their brackets keep q's parse tree (#2257).
#[test]
fn juxtaposition_is_bracketed_only_before_a_word_q_applies() {
    let fix = |source: &str| {
        q_lint_rs::fix_all(source, false, |text| {
            Ok::<_, ()>(q_lint_rs::lint(text, "probe.q", q_lint_rs::Profile::Uqf))
        })
        .unwrap()
        .text
    };
    let mut scripts = vec![];
    for (source, fixed) in [
        ("r:f dsave 1 2", "r:f dsave 1 2"),
        ("r:f setenv 1 2", "r:f setenv 1 2"),
        ("r:f aj 1 2", "r:f[aj 1 2]"),
        ("r:f aj0 1 2", "r:f[aj0 1 2]"),
        ("r:f ej 1 2", "r:f[ej 1 2]"),
    ] {
        let defined = |s: &str| format!("f:{{[a;b] a+b}}\n{s}");
        assert_eq!(fix(&defined(source)), defined(fixed), "{source}");
        if source != fixed {
            scripts.push(format!("r:(parse {source:?})~parse {fixed:?}"));
        }
    }
    scripts.push("r:@[parse;\"f[dsave 1 2]\";{`refused}]".into());
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    assert_eq!(values, ["1b", "1b", "1b", "`refused"]);
}

/// QT007 spells a symbol given to ss or ssr as a string, and one character
/// as a one-item string: in quotes alone it is a char atom, which q 5
/// refuses as it does the symbol. Before an infix `ss` it takes
/// parentheses, or `enlist` would take the whole call (#2258).
#[test]
fn a_one_character_symbol_given_to_ss_becomes_a_string_ss_takes() {
    let mut scripts = vec![];
    for (source, fixed) in [
        ("r:`a ss \"a\"", "r:(enlist\"a\") ss \"a\""),
        ("r:ss[`a;\"a\"]", "r:ss[enlist\"a\";\"a\"]"),
        ("r:ssr[`a;\"a\";\"b\"]", "r:ssr[enlist\"a\";\"a\";\"b\"]"),
        ("r:ss[\"abc\";`b]", "r:ss[\"abc\";enlist\"b\"]"),
        ("r:`ab ss \"a\"", "r:\"ab\" ss \"a\""),
    ] {
        assert_eq!(fixed_with(source, &["QT007"], true), fixed);
        scripts.push(fixed.to_string());
    }
    let Some(values) = values_on_q(&scripts) else {
        return;
    };
    assert_eq!(values, [",0", ",0", ",\"b\"", ",1", ",0"]);
}

/// The rules a fix exists for: each arm of `fix_with` in src/lib.rs, and
/// QL003, whose fix has a function of its own.
fn rules_with_a_fix() -> std::collections::BTreeSet<String> {
    let lib = include_str!("../src/lib.rs").replace("\r\n", "\n");
    let from = lib.find("\nfn fix_with(").expect("fix_with in src/lib.rs");
    let body = &lib[from..from + lib[from..].find("\n}\n").unwrap()];
    let arm = regex::Regex::new(r#"(?m)^ {8}((?:"Q[A-Z]\d{3}"(?: \| )?)+)(?: if .*)? =>"#).unwrap();
    let code = regex::Regex::new(r"Q[A-Z]\d{3}").unwrap();
    let mut rules: std::collections::BTreeSet<String> = arm
        .captures_iter(body)
        .flat_map(|m| {
            code.find_iter(m.get(1).unwrap().as_str())
                .map(|c| c.as_str().to_string())
                .collect::<Vec<_>>()
        })
        .collect();
    rules.insert("QL003".into());
    rules
}

/// The rule codes the README names in the paragraph that begins `opening`.
fn readme_codes(opening: &str) -> std::collections::BTreeSet<String> {
    let readme = include_str!("../README.md").replace("\r\n", "\n");
    let from = readme
        .find(opening)
        .unwrap_or_else(|| panic!("README lost `{opening}`"));
    let paragraph = &readme[from..from + readme[from..].find("\n\n").unwrap()];
    regex::Regex::new(r"\bQ[A-Z]\d{3}\b")
        .unwrap()
        .find_iter(paragraph)
        .map(|c| c.as_str().to_string())
        .collect()
}

/// The README's two lists of fixes are what `--fix` and the editor do: a
/// rule is in "Batch fixing handles" when a fix of its is batch-safe, and in
/// the editor-only list when one is not - QR003's, once listed as batch,
/// has been editor-only since #1201 (#2260). And every rule with a fix has
/// a row in `FIX_CASES`, so neither list can leave one out unseen.
#[test]
fn the_readme_lists_each_fix_where_fix_applies_it() {
    use std::collections::BTreeSet;
    let rules = rules_with_a_fix();
    let tested: BTreeSet<String> = FIX_CASES.iter().map(|c| c.0.to_string()).collect();
    let untested: Vec<_> = rules.difference(&tested).collect();
    assert!(
        untested.is_empty(),
        "rules with a fix and no FIX_CASES row: {untested:?}"
    );
    let with = |safe: bool| -> BTreeSet<String> {
        FIX_CASES
            .iter()
            .filter(|c| c.3 == safe)
            .map(|c| c.0.to_string())
            .collect()
    };
    assert_eq!(readme_codes("Batch fixing handles"), with(true));
    assert_eq!(readme_codes("Some rewrites change behaviour"), with(false));
}
