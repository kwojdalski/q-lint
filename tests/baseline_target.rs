//! Three things a run can be told that change which findings it reports:
//! a lint baseline (`--write-baseline`, `--baseline`, `baseline = ...`), a
//! target q release (`--target-version`, `target-version = ...`, the QK
//! rules), and - always on in `style` - the lints from inferred types
//! (QT033-QT035).
use std::{fs, path::Path, process::Command};

fn run(dir: &Path, args: &[&str]) -> (Option<i32>, Vec<(String, usize)>, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir)
        .args(args)
        .args(["--format", "json"])
        .output()
        .unwrap();
    let findings: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let found = findings
        .as_array()
        .map(|a| {
            a.iter()
                .map(|f| {
                    (
                        f["code"].as_str().unwrap().to_string(),
                        f["line"].as_u64().unwrap() as usize,
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    (
        out.status.code(),
        found,
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

const OLD: &str = "my_var:1\nf:{[desc] desc}\n";

#[test]
fn a_baseline_hides_todays_findings_and_shows_new_ones() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), OLD).unwrap();
    let (status, found, err) = run(d, &["--write-baseline", "base.json", "a.q"]);
    assert_eq!((status, found.len()), (Some(0), 0), "{err}");
    assert!(err.contains("wrote 2 finding(s) in 1 file(s)"), "{err}");
    let written = fs::read_to_string(d.join("base.json")).unwrap();
    assert!(written.starts_with("{\"qlinter-baseline\": 1"), "{written}");
    assert!(written.contains("\"path\":\"a.q\""), "{written}");
    // Nothing new: nothing reported, and a clean exit.
    let (status, found, err) = run(d, &["--baseline", "base.json", "a.q"]);
    assert_eq!((status, found), (Some(0), vec![]), "{err}");
    assert!(
        err.contains("2 finding(s) in the baseline not shown"),
        "{err}"
    );
    // Lines moved down and a new finding added: only the new one, at its
    // own line, even with the old ones now at other lines.
    fs::write(d.join("a.q"), format!("/ a comment\n\nother_var:2\n{OLD}")).unwrap();
    let (status, found, _) = run(d, &["--baseline", "base.json", "a.q"]);
    assert_eq!((status, found), (Some(1), vec![("QS001".to_string(), 3)]));
    // One more of the same finding on a line of the same text is new too.
    fs::write(d.join("a.q"), format!("{OLD}my_var:1\n")).unwrap();
    let (_, found, _) = run(d, &["--baseline", "base.json", "a.q"]);
    assert_eq!(found, vec![("QS001".to_string(), 3)]);
    // A configuration names it for every run under it.
    fs::write(d.join("a.q"), OLD).unwrap();
    fs::write(d.join("qlinter.toml"), "baseline = \"base.json\"\n").unwrap();
    let (status, found, _) = run(d, &["a.q"]);
    assert_eq!((status, found), (Some(0), vec![]));
    // Writing a baseline reads none, so it holds every finding.
    let (_, _, err) = run(d, &["--write-baseline", "base2.json", "a.q"]);
    assert!(err.contains("wrote 2 finding(s)"), "{err}");
}

#[test]
fn a_baseline_names_a_file_outside_its_directory_through_dot_dot() {
    // So it matches in another checkout, not only at today's absolute path.
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().join("one");
    fs::create_dir_all(d.join("sub")).unwrap();
    fs::write(d.join("a.q"), OLD).unwrap();
    let (_, _, err) = run(
        &d,
        &["--isolated", "--write-baseline", "sub/bl.json", "a.q"],
    );
    let written = fs::read_to_string(d.join("sub/bl.json")).unwrap();
    assert!(written.contains("\"path\":\"../a.q\""), "{written}{err}");
    let moved = dir.path().join("two");
    fs::rename(&d, &moved).unwrap();
    let (status, found, err) = run(&moved, &["--isolated", "--baseline", "sub/bl.json", "a.q"]);
    assert_eq!((status, found), (Some(0), vec![]), "{err}");
}

#[test]
fn a_missing_or_broken_baseline_is_an_error_not_silence() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), OLD).unwrap();
    let (status, _, err) = run(d, &["--baseline", "nope.json", "a.q"]);
    assert_eq!(status, Some(2), "{err}");
    // The OS words the missing file its own way (Windows: "cannot find the file").
    assert!(err.contains("nope.json: "), "{err}");
    fs::write(d.join("bad.json"), "{\"findings\": []}").unwrap();
    let (status, _, err) = run(d, &["--baseline", "bad.json", "a.q"]);
    assert_eq!(status, Some(2), "{err}");
    assert!(err.contains("not a qlinter baseline"), "{err}");
}

const NEW_Q: &str = "d:([a:1;b:2])\ng:{(a;b):x; a+b}\nh:{[x:`j] x}\nr:-30!(::)\ns:.Q.Xf\nk:([sym:`a`b] px:1 2)\nt:([] px:1 2)\nm:use`mymod\n";

/// `--write-baseline` writes a file, and a file the run reads is never it:
/// `--write-baseline o.q` with the tree linted, or `o.q` named as both, once
/// replaced the source with JSON and exited 0 (#2115). A name that looks like
/// q source is refused too, read or not, and a refused run writes nothing.
#[test]
fn a_baseline_is_never_written_over_q_source() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("o.q"), OLD).unwrap();
    for args in [
        &["--write-baseline", "o.q"][..],
        &["--write-baseline", "o.q", "o.q"],
        &["--write-baseline", "./o.q", "."],
    ] {
        let (status, _, err) = run(d, args);
        assert_eq!(status, Some(2), "{args:?}: {err}");
        assert!(err.contains("one of the files to lint"), "{args:?}: {err}");
        assert_eq!(fs::read_to_string(d.join("o.q")).unwrap(), OLD, "{args:?}");
    }
    for name in ["new.q", "new.K", "new.qnb"] {
        let (status, _, err) = run(d, &["--write-baseline", name, "o.q"]);
        assert_eq!(status, Some(2), "{name}: {err}");
        assert!(err.contains("a baseline is JSON"), "{name}: {err}");
        assert!(!d.join(name).exists(), "{name}");
    }
}

/// A run that cannot read one of its inputs writes no baseline: one without
/// that file's findings would replace the good one, and they would all come
/// back as new once the file reads again (#2180).
#[test]
fn a_run_with_an_unread_input_keeps_the_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), OLD).unwrap();
    fs::write(d.join("b.q"), OLD).unwrap();
    let (status, _, err) = run(d, &["--write-baseline", "base.json", "a.q", "b.q"]);
    assert_eq!(status, Some(0), "{err}");
    let good = fs::read_to_string(d.join("base.json")).unwrap();
    let (status, _, err) = run(d, &["--write-baseline", "base.json", "a.q", "gone.q"]);
    assert_eq!(status, Some(2), "{err}");
    assert!(err.contains("no baseline written"), "{err}");
    assert_eq!(fs::read_to_string(d.join("base.json")).unwrap(), good);
    let (status, _, err) = run(d, &["--write-baseline", "new.json", "a.q", "gone.q"]);
    assert_eq!(status, Some(2), "{err}");
    assert!(!d.join("new.json").exists());
    // A file there but unreadable, where permissions can say so (not root).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(d.join("b.q"), fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(d.join("b.q")).is_err() {
            let (status, _, err) = run(d, &["--write-baseline", "base.json", "."]);
            assert_eq!(status, Some(2), "{err}");
            assert!(err.contains("no baseline written"), "{err}");
            assert_eq!(fs::read_to_string(d.join("base.json")).unwrap(), good);
        }
        fs::set_permissions(d.join("b.q"), fs::Permissions::from_mode(0o644)).unwrap();
    }
}

fn qk(found: &[(String, usize)]) -> Vec<(String, usize)> {
    found
        .iter()
        .filter(|(c, _)| c.starts_with("QK"))
        .cloned()
        .collect()
}

#[test]
fn the_target_version_reports_what_does_not_run_there() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), NEW_Q).unwrap();
    let pair = |c: &str, l: usize| (c.to_string(), l);
    // No target: nothing.
    let (_, found, _) = run(d, &["--isolated", "a.q"]);
    assert_eq!(qk(&found), vec![]);
    let (_, found, _) = run(d, &["--isolated", "--target-version", "3.6", "a.q"]);
    assert_eq!(
        qk(&found),
        vec![
            pair("QK001", 1),
            pair("QK002", 2),
            pair("QK003", 3),
            pair("QK006", 8)
        ]
    );
    let (_, found, _) = run(d, &["--isolated", "--target-version", "4.0", "a.q"]);
    assert_eq!(
        qk(&found),
        vec![
            pair("QK001", 1),
            pair("QK002", 2),
            pair("QK003", 3),
            pair("QK006", 8)
        ]
    );
    // 4.1 runs the new syntax, and has no .Q.Xf, nor KDB-X's use.
    let (_, found, _) = run(d, &["--isolated", "--target-version", "4.1", "a.q"]);
    assert_eq!(qk(&found), vec![pair("QK005", 5), pair("QK006", 8)]);
    let (_, found, _) = run(d, &["--isolated", "--target-version", "kdbx", "a.q"]);
    assert_eq!(qk(&found), vec![pair("QK005", 5)]);
    // A configuration sets it per folder, and the flag wins.
    fs::create_dir(d.join("old")).unwrap();
    fs::write(d.join("old/a.q"), "r:-30!(::)\n").unwrap();
    fs::write(d.join("old/qlinter.toml"), "target-version = \"3.6\"\n").unwrap();
    let (_, found, _) = run(d, &["old/a.q"]);
    assert_eq!(qk(&found), vec![]);
    fs::write(d.join("old/qlinter.toml"), "target-version = \"4.1\"\n").unwrap();
    let (_, found, _) = run(d, &["--target-version", "3.6", "a.q"]);
    assert_eq!(qk(&found).len(), 4);
    fs::write(d.join("old/qlinter.toml"), "target-version = \"3.5\"\n").unwrap();
    let (status, _, err) = run(d, &["old/a.q"]);
    assert_eq!(status, Some(2));
    assert!(
        err.contains("target-version must be one of 3.6, 4.0, 4.1, kdbx"),
        "{err}"
    );
}

/// A QK rule that no target can see is one `--rules` lists as on and that
/// never reports: QK004 was one, for `-30!`, which every target has (#2091).
#[test]
fn every_qk_rule_listed_is_reported_for_some_target() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(d.join("a.q"), NEW_Q).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .arg("--rules")
        .output()
        .unwrap();
    let listed: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.starts_with("QK"))
        .map(|l| l[..5].to_string())
        .collect();
    let mut seen = std::collections::BTreeSet::new();
    for target in ["3.6", "4.0", "4.1", "kdbx"] {
        let (_, found, _) = run(d, &["--isolated", "--target-version", target, "a.q"]);
        seen.extend(qk(&found).into_iter().map(|(c, _)| c));
        // `-30!` (line 4) runs on every one of them.
        assert!(!found.iter().any(|(_, l)| *l == 4), "{target}: {found:?}");
    }
    assert_eq!(seen.into_iter().collect::<Vec<_>>(), listed);
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--explain", "QK004"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}

/// A symbol naming `.Q.Cf` is data, not a use of the function: each line
/// up to `p:` runs on KDB-X (q 5), the description table of SpencerFX's
/// namespaceQ.q among them (#2117). What follows is each a form KDB-X
/// refuses with '.Q.Cf: the name, or its symbol read as the global - by
/// `get` or `value`, first in `@[` or `.[`, or applied.
#[test]
fn a_symbol_naming_a_removed_function_is_reported_only_where_it_is_read() {
    let data = [
        "names:`.Q.Cf`.Q.Xf",
        "d:(`.Q.Cf;\"create empty nested char file\")",
        "r:`.Q.Cf in key `.Q",
        "e:`.Q.Cf~`a",
        "j:`.Q.Cf,`a",
        "f:{`.Q.Cf}",
        "h:`a`.Q.Cf",
        "p:`:.Q.Cf",
    ];
    let read = [
        "a1:.Q.Cf",
        "a2:get `.Q.Cf",
        "a3:value `.Q.Cf",
        "a4:get`.Q.Cf",
        "a5:value[`.Q.Cf]",
        "a6:`.Q.Cf 1",
        "a7:`.Q.Cf[1]",
        "a8:@[`.Q.Cf;1]",
        "a9:.[`.Q.Xf;enlist 1]",
        "b1:`.Q.Cf . enlist 1",
        "b2:`.Q.Cf @ 1",
        "b3:`.Q.Cf x",
        "b4:`.Q.Cf\"a\"",
        "b5:`.Q.Cf .z.p",
        "b6:`.Q.Cf -1",
        "b7:`.Q.Cf each 1 2",
        "b8:`.Q.Cf/[1;2]",
        "b9:`.Q.Cf `a",
    ];
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let text: String = data.iter().chain(&read).map(|l| format!("{l}\n")).collect();
    fs::write(d.join("a.q"), text).unwrap();
    let want: Vec<_> = (data.len() + 1..=data.len() + read.len())
        .map(|l| ("QK005".to_string(), l))
        .collect();
    for target in ["4.1", "kdbx"] {
        let (_, found, err) = run(d, &["--isolated", "--target-version", target, "a.q"]);
        assert_eq!(qk(&found), want, "{target}: {err}");
    }
}

#[test]
fn a_typed_local_is_judged_as_its_literal_would_be() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let text = "f:{s:`a; n:1 2; v:`x`y; c:\"ab\";\n r1:s=\"a\";\n r2:s+1;\n r3:1-s;\n r4:n,v;\n r5:v,`z;\n r6:s=`b;\n r7:n,3 4;\n r8:s -1;\n r9:c=`ab;\n r10:x+y;\n r1}\ng:{[s] s+1}\n";
    fs::write(d.join("a.q"), text).unwrap();
    let (_, found, _) = run(d, &["--isolated", "--select", "QT033,QT034,QT035", "a.q"]);
    let pair = |c: &str, l: usize| (c.to_string(), l);
    assert_eq!(
        found,
        vec![
            pair("QT033", 2),
            pair("QT035", 3),
            pair("QT035", 4),
            pair("QT034", 5),
            pair("QT033", 10),
        ]
    );
    // q counts a string in bytes: `"é"` is a string, so joining it to
    // longs is the mixed join `"ab"` gives (#2063).
    fs::write(
        d.join("b.q"),
        "f:{c:\"\u{e9}\"; c,1 2}\ng:{c:\"ab\"; c,1 2}\nh:{c:\"e\"; c,1 2}\n",
    )
    .unwrap();
    let (_, found, _) = run(d, &["--isolated", "--select", "QT034", "b.q"]);
    assert_eq!(found, vec![pair("QT034", 1), pair("QT034", 2)]);
    // In the style profile, not in general.
    let (_, found, _) = run(d, &["--isolated", "--profile", "general", "a.q"]);
    assert!(
        found.iter().all(|(c, _)| !c.starts_with("QT03")),
        "{found:?}"
    );
}

/// What each finding of a run over `text` says, for the type lints, whose
/// message quotes the source and names the error.
fn type_lint_details(text: &str) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.q"), text).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .args(["--isolated", "--select", "QT033,QT034,QT035", "a.q"])
        .args(["--format", "json"])
        .output()
        .unwrap();
    let findings: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    findings
        .as_array()
        .map(|a| {
            a.iter()
                .map(|f| f["detail"].as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// The operand QT035 quotes is the whole of it, past the `;`, `)` or `]`
/// of a bracket it opens itself, and never part of one (#2879).
#[test]
fn a_type_lint_quotes_the_whole_right_operand() {
    let quoted = |text: &str| -> Vec<String> {
        type_lint_details(text)
            .iter()
            .map(|d| d.split('`').nth(1).unwrap().to_string())
            .collect()
    };
    assert_eq!(quoted("f:{[g] s:`a; s+g[1;2]}\n"), ["s+g[1;2]"]);
    assert_eq!(quoted("f:{s:`a; s*count(1;2)}\n"), ["s*count(1;2)"]);
    assert_eq!(quoted("f:{s:`a; (s+{x;1};2)}\n"), ["s+{x;1}"]);
    assert_eq!(quoted("f:{s:`a; (s+1;2)}\n"), ["s+1"]);
    // One that runs on over the next line is quoted up to its operator.
    assert_eq!(quoted("f:{s:`a; s+(1;\n  2)}\n"), ["s+"]);
}

#[test]
fn the_type_lints_are_what_q_does() {
    // Each line the rules report, run: every one is 'type (or, for the join,
    // a general list) on the q that QLINT_TEST_Q names.
    let Ok(q) = std::env::var("QLINT_TEST_Q") else {
        eprintln!("QLINT_TEST_Q names no q: the claims stand as KDB-X and PeachQ gave them");
        return;
    };
    let script = "-1 @[{x[];\"ran\"};{s:`a; s=\"a\"};{x}];\n-1 @[{x[];\"ran\"};{s:`a; s+1};{x}];\n-1 @[{x[];\"ran\"};{s:`a; 1-s};{x}];\n-1 @[{x[];\"ran\"};{c:\"ab\"; c=`ab};{x}];\n-1 string type {n:1 2; v:`x`y; n,v}[];\n\\\\\n";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.q");
    fs::write(&path, script).unwrap();
    let mut words = q.split_whitespace();
    let out = Command::new(words.next().unwrap())
        .args(words)
        .arg(&path)
        .arg("-q")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        text.lines().collect::<Vec<_>>(),
        ["type", "type", "type", "type", "0"],
        "{text}"
    );
}

/// QE008, QE009 and QE011 say q refuses the line, which holds from KDB-X on:
/// it refuses `-x` ('-), `+/1 2 3` ('/) and `count'(1 2;3)` ('), and q 4
/// ran each (this project's notes at each rule's fix). So a q 4 target
/// hears nothing of them, and KDB-X or no target does (#2324).
#[test]
fn a_refusal_only_kdbx_makes_is_not_reported_for_an_older_target() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(
        d.join("a.q"),
        "f:{-x}\ng:{+/x}\nh:{cor each x}\nc:{count'x}\n",
    )
    .unwrap();
    let qe = |found: &[(String, usize)]| -> Vec<(String, usize)> {
        found
            .iter()
            .filter(|(c, _)| matches!(c.as_str(), "QE008" | "QE009" | "QE011"))
            .cloned()
            .collect()
    };
    let pair = |c: &str, l: usize| (c.to_string(), l);
    let all = vec![
        pair("QE008", 1),
        pair("QE009", 2),
        pair("QE011", 3),
        pair("QE009", 4),
    ];
    for target in [None, Some("kdbx")] {
        let mut args = vec!["--isolated", "--profile", "general", "a.q"];
        args.extend(target.iter().flat_map(|t| ["--target-version", *t]));
        let (_, found, err) = run(d, &args);
        assert_eq!(qe(&found), all, "{target:?}: {err}");
    }
    for target in ["3.6", "4.0", "4.1"] {
        let args = [
            "--isolated",
            "--profile",
            "general",
            "--target-version",
            target,
            "a.q",
        ];
        let (_, found, err) = run(d, &args);
        assert_eq!(qe(&found), vec![], "{target}: {err}");
    }
}

/// KDB-X's `use` is no builtin of an older q: QK006 reports it read as the
/// module loader, and a file binding the name itself - KDB-X refuses
/// `{[use] use+1}[2]` ('nyi) and `use:1` ('assign) - is reported for KDB-X
/// alone, where it is refused (#2325).
#[test]
fn a_builtin_only_kdbx_has_is_a_free_name_for_an_older_target() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    fs::write(
        d.join("binds.q"),
        "f:{[use] use+1}\nuse:5\ng:{use:x; use}\n",
    )
    .unwrap();
    fs::write(d.join("loads.q"), "m:use`mymod\nn:use[`other]\nk:.my.use\n").unwrap();
    let codes = |found: &[(String, usize)]| -> Vec<(String, usize)> {
        found
            .iter()
            .filter(|(c, _)| c.starts_with("QK") || c.starts_with("QF"))
            .cloned()
            .collect()
    };
    let pair = |c: &str, l: usize| (c.to_string(), l);
    for target in ["3.6", "4.0", "4.1"] {
        let args = [
            "--isolated",
            "--select",
            "QK,QF",
            "--target-version",
            target,
        ];
        let (_, found, err) = run(d, &[&args[..], &["binds.q"]].concat());
        assert_eq!(codes(&found), vec![], "{target}: {err}");
        let (_, found, err) = run(d, &[&args[..], &["loads.q"]].concat());
        assert_eq!(
            codes(&found),
            vec![pair("QK006", 1), pair("QK006", 2)],
            "{target}: {err}"
        );
    }
    let args = [
        "--isolated",
        "--select",
        "QK,QF",
        "--target-version",
        "kdbx",
    ];
    let (_, found, err) = run(d, &[&args[..], &["binds.q"]].concat());
    assert_eq!(
        codes(&found),
        vec![pair("QF001", 1), pair("QF004", 2), pair("QF003", 3)],
        "{err}"
    );
    let (_, found, err) = run(d, &[&args[..], &["loads.q"]].concat());
    assert_eq!(codes(&found), vec![], "{err}");
}

/// The QK rules read KDB-X's patterns as `semantics::pattern_targets` and
/// `signature` do. Each line runs on KDB-X (q 5): `r:(a;b):1 2` sets r to
/// 1 2, `(a;b)::3 4` and `{(a;b)::x}` the globals, `(k!v):d` k to the keys,
/// `([a;b])::d` the globals a and b; `{ [x:`j] x}[1f]` is 'type and
/// `{[k!v] (k;v)}` binds both. Each is 4.1's, a pattern assignment or a
/// typed or pattern parameter (#2326, #2327), and the dictionary patterns in
/// them are no dictionary literal (#2328).
#[test]
fn every_pattern_kdbx_reads_is_one_for_an_older_target() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let lines = [
        "r:(a;b):1 2",
        "(a2;b2)::3 4",
        "{(a4;b4)::x}5 6",
        "r5:count (a5;b5):7 8",
        "(k1!v1):`a`b!1 2",
        "([g1;g2])::`g1`g2!1 2",
        "h:{ [x:`j] x}",
        "h2:{ [(p;q)] p+q}",
        "f1:{[k!v] (k;v)}",
        "f4:{[([k:v])] v}",
        "f2:{[`T!([t]);c] (t;c)}",
        "f5:{[1;b] b}",
        // Not one: a name applied in a slot binds nothing, a parenthesised
        // name is no list, and a dictionary literal is QK001's.
        "f6:{[f x] 1}",
        "(z):1",
        "dl:([a:1;b:2])",
    ];
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    fs::write(d.join("a.q"), text).unwrap();
    let (_, found, err) = run(
        d,
        &[
            "--isolated",
            "--select",
            "QK",
            "--target-version",
            "4.0",
            "a.q",
        ],
    );
    let pair = |c: &str, l: usize| (c.to_string(), l);
    assert_eq!(
        qk(&found),
        vec![
            pair("QK002", 1),
            pair("QK002", 2),
            pair("QK002", 3),
            pair("QK002", 4),
            pair("QK002", 5),
            pair("QK002", 6),
            pair("QK003", 7),
            pair("QK003", 8),
            pair("QK003", 9),
            pair("QK003", 10),
            pair("QK003", 11),
            pair("QK003", 12),
            pair("QK001", 15),
        ],
        "{err}"
    );
}
