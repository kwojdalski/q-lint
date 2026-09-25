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
