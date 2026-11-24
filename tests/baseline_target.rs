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

const NEW_Q: &str = "d:([a:1;b:2])\ng:{(a;b):x; a+b}\nh:{[x:`j] x}\nr:-30!(::)\ns:.Q.Xf\nk:([sym:`a`b] px:1 2)\nt:([] px:1 2)\n";

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
        vec![pair("QK001", 1), pair("QK002", 2), pair("QK003", 3)]
    );
    let (_, found, _) = run(d, &["--isolated", "--target-version", "4.0", "a.q"]);
    assert_eq!(
        qk(&found),
        vec![pair("QK001", 1), pair("QK002", 2), pair("QK003", 3)]
    );
    // 4.1 runs the new syntax, and has no .Q.Xf.
    let (_, found, _) = run(d, &["--isolated", "--target-version", "4.1", "a.q"]);
    assert_eq!(qk(&found), vec![pair("QK005", 5)]);
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
    assert_eq!(qk(&found).len(), 3);
    fs::write(d.join("old/qlinter.toml"), "target-version = \"3.5\"\n").unwrap();
    let (status, _, err) = run(d, &["old/a.q"]);
    assert_eq!(status, Some(2));
    assert!(
        err.contains("target-version must be one of 3.6, 4.0, 4.1, kdbx"),
        "{err}"
    );
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
    // In the style profile, not in general.
    let (_, found, _) = run(d, &["--isolated", "--profile", "general", "a.q"]);
    assert!(
        found.iter().all(|(c, _)| !c.starts_with("QT03")),
        "{found:?}"
    );
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
