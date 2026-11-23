//! `required-version` in a configuration: the qlinter releases it runs
//! under, and a clear refusal under any other.
use std::{fs, process::Command};

fn run(config: &str) -> (Option<i32>, String) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(".qlinter.toml"), config).unwrap();
    fs::write(dir.path().join("a.q"), "a:1\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .arg("a.q")
        .output()
        .unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

const OURS: &str = env!("CARGO_PKG_VERSION");

#[test]
fn a_matching_version_runs() {
    assert_eq!(run(&format!("required-version = \"{OURS}\"\n")).0, Some(0));
    assert_eq!(
        run(&format!("required-version = \">={OURS}\"\n")).0,
        Some(0)
    );
}

#[test]
fn another_version_is_refused_naming_both() {
    let (status, err) = run("required-version = \">=0.1, <0.2\"\n");
    assert_eq!(status, Some(2), "{err}");
    assert!(err.contains(">=0.1, <0.2"), "{err}");
    assert!(err.contains(OURS), "{err}");
}

#[test]
fn a_spec_that_is_not_one_is_a_configuration_error() {
    for spec in ["\"latest\"", "\">=\"", "033"] {
        let (status, err) = run(&format!("required-version = {spec}\n"));
        assert_eq!(status, Some(2), "{spec}: {err}");
        assert!(err.contains("required-version"), "{spec}: {err}");
    }
}
