//! Configuration is found the way Ruff finds its own: the nearest
//! `.qlinter.toml`, `qlinter.toml` or `pyproject.toml` with `[tool.qlinter]`,
//! searching up from each file - so a repository's root settings govern every
//! file under it, wherever qlinter is run from.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// Two findings: QS001 (styleq) on `my_var`, QF016 (style) on the unused `b`.
const SOURCE: &str = "my_var:1;f:{[a;b] a}\n";

struct Repo(tempfile::TempDir);

impl Repo {
    fn new() -> Self {
        Repo(tempfile::tempdir().unwrap())
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.0.path().join(rel)
    }
    fn write(&self, rel: &str, text: &str) -> &Self {
        let path = self.path(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
        self
    }
    /// Run qlinter from `cwd` (relative to the repo) on `args`, and return
    /// the codes it reports, sorted.
    fn codes(&self, cwd: &str, args: &[&str]) -> Vec<String> {
        let out = run(&self.path(cwd), args);
        assert!(
            matches!(out.status.code(), Some(0 | 1)),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let mut codes: Vec<String> = found
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["code"].as_str().unwrap().to_string())
            .collect();
        codes.sort();
        codes
    }
}

fn run(cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(cwd)
        // No user-level configuration leaks in from the machine running this.
        .env("XDG_CONFIG_HOME", cwd.join("no-such-config-home"))
        .args(["--format", "json"])
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn the_repository_root_configuration_governs_a_file_deep_below_it() {
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"style\"\n")
        .write("src/lib/a.q", SOURCE);
    // From the root, from the file's own directory, and from outside the
    // repository altogether: the file's position decides, not the cwd.
    assert_eq!(repo.codes(".", &["src/lib/a.q"]), ["QF016"]);
    assert_eq!(repo.codes("src/lib", &["a.q"]), ["QF016"]);
    let outside = tempfile::tempdir().unwrap();
    let file = repo.path("src/lib/a.q");
    let out = run(outside.path(), &[file.to_str().unwrap()]);
    let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(found.as_array().unwrap().len(), 1, "{found}");
}

#[test]
fn the_nearest_configuration_wins_over_one_further_up() {
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"general\"\n")
        .write("pkg/qlinter.toml", "profile = \"styleq\"\n")
        .write("a.q", SOURCE)
        .write("pkg/b.q", SOURCE);
    assert_eq!(repo.codes(".", &["a.q"]), Vec::<String>::new());
    assert_eq!(repo.codes(".", &["pkg/b.q"]), ["QF016", "QS001"]);
}

#[test]
fn in_one_directory_dot_qlinter_then_qlinter_then_pyproject() {
    let repo = Repo::new();
    repo.write("a.q", SOURCE)
        .write("pyproject.toml", "[tool.qlinter]\nprofile = \"styleq\"\n");
    assert_eq!(repo.codes(".", &["a.q"]), ["QF016", "QS001"]);
    repo.write("qlinter.toml", "profile = \"style\"\n");
    assert_eq!(repo.codes(".", &["a.q"]), ["QF016"]);
    repo.write(".qlinter.toml", "profile = \"general\"\n");
    assert_eq!(repo.codes(".", &["a.q"]), Vec::<String>::new());
}

#[test]
fn a_pyproject_without_the_table_is_passed_over() {
    // A Python package inside the repository has its own pyproject.toml; it
    // must not hide the repository's settings.
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"style\"\n")
        .write("py/pyproject.toml", "[project]\nname = \"x\"\n")
        .write("py/a.q", SOURCE);
    assert_eq!(repo.codes(".", &["py/a.q"]), ["QF016"]);
}

#[test]
fn the_old_tool_q_lint_table_is_still_read_but_not_beside_the_new_one() {
    let repo = Repo::new();
    repo.write("pyproject.toml", "[tool.q-lint]\nignore = [\"QS001\"]\n")
        .write("a.q", SOURCE);
    assert_eq!(repo.codes(".", &["a.q"]), ["QF016"]);
    repo.write(
        "pyproject.toml",
        "[tool.q-lint]\nignore = [\"QS001\"]\n[tool.qlinter]\nignore = [\"QF016\"]\n",
    );
    let out = run(&repo.path("."), &["a.q"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("keep one"));
}

#[test]
fn select_and_ignore_resolve_by_specificity_as_in_ruff() {
    let repo = Repo::new();
    repo.write("a.q", SOURCE);
    // A prefix selects a family; a longer ignore takes one back out.
    repo.write(
        "qlinter.toml",
        "[lint]\nselect = [\"QF\", \"QS\"]\nignore = [\"QS001\"]\n",
    );
    assert_eq!(repo.codes(".", &["a.q"]), ["QF016"]);
    // A family ignored, one of it put back: the code is more specific.
    repo.write(
        "qlinter.toml",
        "profile = \"styleq\"\n[lint]\nignore = [\"QS\"]\nextend-select = [\"QS001\"]\n",
    );
    assert_eq!(repo.codes(".", &["a.q"]), ["QF016", "QS001"]);
    // extend-select reaches past the profile.
    repo.write(
        "qlinter.toml",
        "profile = \"general\"\nextend-select = [\"QS001\"]\n",
    );
    assert_eq!(repo.codes(".", &["a.q"]), ["QS001"]);
}

#[test]
fn a_key_both_at_the_top_and_under_lint_is_refused() {
    let repo = Repo::new();
    repo.write("a.q", SOURCE).write(
        "qlinter.toml",
        "ignore = [\"QS001\"]\n[lint]\nignore = [\"QF016\"]\n",
    );
    let out = run(&repo.path("."), &["a.q"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("both at the top and under [lint]"));
}

#[test]
fn per_file_ignores_apply_to_the_paths_they_name() {
    let repo = Repo::new();
    repo.write(
        "qlinter.toml",
        "profile = \"styleq\"\n[lint.per-file-ignores]\n\"tests/*\" = [\"QS\"]\n",
    )
    .write("tests/t.q", SOURCE)
    .write("src/s.q", SOURCE);
    assert_eq!(repo.codes(".", &["tests/t.q"]), ["QF016"]);
    assert_eq!(repo.codes(".", &["src/s.q"]), ["QF016", "QS001"]);
}

#[test]
fn exclude_patterns_are_relative_to_the_configuration_and_a_bare_name_matches_anywhere() {
    let repo = Repo::new();
    repo.write(
        "qlinter.toml",
        "profile = \"style\"\nexclude = [\"vendor/*\"]\nextend-exclude = [\"generated\"]\n",
    )
    .write("vendor/v.q", SOURCE)
    .write("lib/generated/g.q", SOURCE)
    .write("lib/l.q", SOURCE);
    // Run from inside lib: the root's patterns still apply, rooted at the root.
    let out = run(&repo.path("lib"), &[".."]);
    let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let paths: Vec<_> = found
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().replace('\\', "/"))
        .collect();
    assert_eq!(paths.len(), 1, "{paths:?}");
    assert!(paths[0].ends_with("lib/l.q"), "{paths:?}");
}

/// The files a run from the repository root reports on, relative to it.
fn linted(repo: &Repo, args: &[&str]) -> Vec<String> {
    linted_from(repo, ".", args)
}

/// The files a run from `cwd` reports on, relative to the repository root.
fn linted_from(repo: &Repo, cwd: &str, args: &[&str]) -> Vec<String> {
    let out = run(&repo.path(cwd), args);
    let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let root = repo.path(".").canonicalize().unwrap();
    let mut paths: Vec<String> = found
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let path = Path::new(f["path"].as_str().unwrap());
            let path = path.strip_prefix(&root).unwrap_or(path);
            path.display().to_string().replace('\\', "/")
        })
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

#[test]
fn a_dot_slash_or_absolute_exclude_is_anchored_at_its_root() {
    // Ruff joins each pattern to its root: `./gen` and `/abs/root/gen` both
    // name the root's `gen`, and neither reaches `lib/gen` the way a bare
    // `gen` does.
    let repo = Repo::new();
    repo.write("gen/g.q", SOURCE)
        .write("lib/gen/l.q", SOURCE)
        .write("m.q", SOURCE);
    let root = repo.path(".").canonicalize().unwrap();
    let absolute = root.join("gen").display().to_string();
    let glob = root.join("g*").display().to_string();
    // Not resolved through symlinks: on macOS a temporary directory is under
    // /var, which is a link to /private/var.
    let unresolved = repo.path("gen").display().to_string();
    for pattern in ["./gen", "./gen/", &absolute, &glob, &unresolved] {
        assert_eq!(
            linted(&repo, &["--isolated", "--exclude", pattern, "."]),
            ["lib/gen/l.q", "m.q"],
            "--exclude {pattern}"
        );
        repo.write(
            "qlinter.toml",
            &format!("exclude = [{}]\n", toml::Value::from(pattern)),
        );
        assert_eq!(
            linted(&repo, &["."]),
            ["lib/gen/l.q", "m.q"],
            "exclude = [{pattern:?}]"
        );
        fs::remove_file(repo.path("qlinter.toml")).unwrap();
    }
    assert_eq!(
        linted(&repo, &["--isolated", "--exclude", "gen", "."]),
        ["m.q"]
    );
}

#[test]
fn a_pattern_with_a_trailing_slash_is_anchored_at_its_root() {
    // #117. As in Ruff, any `/` in a pattern - a trailing one included -
    // anchors it at the configuration's directory: `lib/` names the root's
    // `lib` and not `tests/lib`. Only a name with no `/` matches at any depth.
    let repo = Repo::new();
    repo.write(
        "qlinter.toml",
        "profile = \"style\"\nexclude = [\"lib/\"]\n",
    )
    .write("lib/a.q", SOURCE)
    .write("tests/lib/b.q", SOURCE);
    assert_eq!(linted(&repo, &["."]), ["tests/lib/b.q"]);
    assert_eq!(linted(&repo, &["tests/"]), ["tests/lib/b.q"]);
    assert_eq!(
        linted(&repo, &["--isolated", "--exclude", "lib/", "."]),
        ["tests/lib/b.q"]
    );
    // A bare name, or `**/` written out, still matches at any depth.
    assert!(linted(&repo, &["--isolated", "--exclude", "lib", "."]).is_empty());
    assert!(linted(&repo, &["--isolated", "--exclude", "**/lib", "."]).is_empty());
    // --exclude is rooted at the directory qlinter runs in, whatever path is
    // linted: from tests/, `lib/` names tests/lib and `../lib` the root's.
    let from_tests =
        |pattern: &str| linted_from(&repo, "tests", &["--isolated", "--exclude", pattern, ".."]);
    assert_eq!(from_tests("lib/"), ["lib/a.q"]);
    assert_eq!(from_tests("../lib"), ["tests/lib/b.q"]);
    // per-file-ignores keys are read by the same rule.
    repo.write(
        "qlinter.toml",
        "profile = \"style\"\n[lint]\nper-file-ignores = { \"lib/\" = [\"QF016\"] }\n",
    );
    assert!(repo.codes(".", &["lib/a.q"]).is_empty());
    assert_eq!(repo.codes(".", &["tests/lib/b.q"]), ["QF016"]);
}

#[test]
fn extend_inherits_and_the_extending_file_wins() {
    let repo = Repo::new();
    repo.write(
        "base.toml",
        "profile = \"styleq\"\n[lint]\nignore = [\"QF016\"]\n",
    )
    .write("pkg/qlinter.toml", "extend = \"../base.toml\"\n")
    .write("pkg/a.q", SOURCE);
    assert_eq!(repo.codes(".", &["pkg/a.q"]), ["QS001"]);
    repo.write(
        "pkg/qlinter.toml",
        "extend = \"../base.toml\"\nprofile = \"general\"\nextend-select = [\"QF016\"]\n",
    );
    assert_eq!(repo.codes(".", &["pkg/a.q"]), ["QF016"]);
}

#[test]
fn an_extending_files_exclude_and_per_file_ignores_replace_the_bases() {
    // Ruff, the same layout: the child's `exclude` replaces the base's, so
    // gen/ is linted again; `extend-exclude` adds to it; and the child's
    // per-file-ignores replace the base's too.
    let repo = Repo::new();
    repo.write(
        "base.toml",
        "profile = \"styleq\"\nexclude = [\"gen\"]\nextend-exclude = [\"old\"]\n\
         per-file-ignores = { \"m.q\" = [\"QS001\"] }\n",
    )
    .write(
        "proj/qlinter.toml",
        "extend = \"../base.toml\"\nexclude = [\"other\"]\nextend-exclude = [\"tmp\"]\n\
         per-file-ignores = { \"m.q\" = [\"QF016\"] }\n",
    )
    .write("proj/gen/x.q", SOURCE)
    .write("proj/other/x.q", SOURCE)
    .write("proj/old/x.q", SOURCE)
    .write("proj/tmp/x.q", SOURCE)
    .write("proj/m.q", SOURCE);
    assert_eq!(linted(&repo, &["proj"]), ["proj/gen/x.q", "proj/m.q"]);
    assert_eq!(repo.codes(".", &["proj/m.q"]), ["QS001"]);
    // A child that sets neither inherits both.
    repo.write("proj/qlinter.toml", "extend = \"../base.toml\"\n");
    assert_eq!(
        linted(&repo, &["proj"]),
        ["proj/m.q", "proj/other/x.q", "proj/tmp/x.q"]
    );
    assert_eq!(repo.codes(".", &["proj/m.q"]), ["QF016"]);
}

#[test]
fn the_command_line_wins_over_the_file() {
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"general\"\n")
        .write("a.q", SOURCE);
    assert_eq!(repo.codes(".", &["a.q"]), Vec::<String>::new());
    assert_eq!(
        repo.codes(".", &["--profile", "styleq", "a.q"]),
        ["QF016", "QS001"]
    );
    assert_eq!(
        repo.codes(".", &["--extend-select", "QS001", "a.q"]),
        ["QS001"]
    );
    assert_eq!(
        repo.codes(".", &["--select", "QF,QS", "--ignore", "QS", "a.q"]),
        ["QF016"]
    );
}

#[test]
fn isolated_and_config_replace_the_search() {
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"general\"\n")
        .write("other.toml", "profile = \"style\"\n")
        .write("a.q", SOURCE);
    // --isolated: the defaults, which for the command line is uqf.
    assert_eq!(repo.codes(".", &["--isolated", "a.q"]), ["QF016", "QS001"]);
    assert_eq!(
        repo.codes(".", &["--config", "other.toml", "a.q"]),
        ["QF016"]
    );
}

#[test]
fn a_config_flags_patterns_are_rooted_at_the_current_directory() {
    // Ruff: a file passed with --config has its relative paths resolved
    // against the current directory, not the file's own.
    let repo = Repo::new();
    repo.write(
        "cfg/shared.toml",
        "profile = \"style\"\nexclude = [\"./src\"]\n\
         [lint]\nper-file-ignores = { \"tests/*\" = [\"QF016\"] }\n",
    )
    .write("proj/src/s.q", SOURCE)
    .write("proj/tests/t.q", SOURCE)
    .write("proj/lib/l.q", SOURCE);
    let out = run(&repo.path("proj"), &["--config", "../cfg/shared.toml", "."]);
    let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let paths: Vec<_> = found
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().replace('\\', "/"))
        .collect();
    assert_eq!(paths.len(), 1, "{paths:?}");
    assert!(paths[0].ends_with("lib/l.q"), "{paths:?}");
}

#[test]
fn a_per_file_ignore_starting_with_a_bang_applies_to_every_other_file() {
    let repo = Repo::new();
    repo.write(
        "qlinter.toml",
        "profile = \"style\"\n[lint.per-file-ignores]\n\"!tests/*\" = [\"QF016\"]\n",
    )
    .write("tests/t.q", SOURCE)
    .write("src/s.q", SOURCE);
    assert_eq!(repo.codes(".", &["tests/t.q"]), ["QF016"]);
    assert!(repo.codes(".", &["src/s.q"]).is_empty());
}

#[test]
fn deselecting_qe001_leaves_the_other_rules_running() {
    // q 5: `b:(1` fails to parse with '( and `a:1==2` with '=. Ignoring the
    // first must not hide the second.
    let repo = Repo::new();
    repo.write("a.q", "a:1==2\nb:(1\n");
    assert_eq!(repo.codes(".", &["--isolated", "a.q"]), ["QE001"]);
    assert_eq!(
        repo.codes(".", &["--isolated", "--ignore", "QE001", "a.q"]),
        ["QE004"]
    );
    repo.write(
        "qlinter.toml",
        "profile = \"general\"\nper-file-ignores = { \"a.q\" = [\"QE001\"] }\n",
    );
    assert_eq!(repo.codes(".", &["a.q"]), ["QE004"]);
}

#[test]
fn a_selector_that_names_no_rule_is_refused() {
    let repo = Repo::new();
    repo.write("a.q", SOURCE)
        .write("qlinter.toml", "[lint]\nselect = [\"QZ\"]\n");
    let out = run(&repo.path("."), &["a.q"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("QZ is not a diagnostic code"));
}

#[test]
fn show_settings_names_the_file_in_force() {
    let repo = Repo::new();
    repo.write(
        "qlinter.toml",
        "profile = \"style\"\n[lint]\nignore = [\"QF\"]\n",
    )
    .write("src/a.q", SOURCE);
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(repo.path("."))
        .env("XDG_CONFIG_HOME", repo.path("none"))
        .args(["--show-settings", "src/a.q"])
        .output()
        .unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("qlinter.toml"), "{text}");
    assert!(text.contains("profile: style"), "{text}");
    assert!(!text.contains("QF016"), "{text}");
    assert!(text.contains("QE004"), "{text}");
}

#[test]
fn a_user_level_configuration_applies_where_no_project_has_one() {
    let repo = Repo::new();
    repo.write("home/qlinter/qlinter.toml", "profile = \"general\"\n")
        .write("work/a.q", SOURCE);
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(repo.path("work"))
        .env("XDG_CONFIG_HOME", repo.path("home"))
        .args(["--format", "json", "a.q"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "[]");
}

#[test]
fn a_user_level_configurations_patterns_are_rooted_at_the_current_directory() {
    // Ruff resolves a user configuration's paths against the directory it
    // runs in, not against ~/.config/ruff, where no project lives.
    let repo = Repo::new();
    repo.write(
        "xdg/qlinter/qlinter.toml",
        "profile = \"style\"\nextend-exclude = [\"tests/skip.q\"]\n\
         per-file-ignores = { \"tests/quiet.q\" = [\"QF016\"] }\n",
    )
    .write("uc/tests/skip.q", SOURCE)
    .write("uc/tests/quiet.q", SOURCE)
    .write("uc/tests/kept.q", SOURCE);
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(repo.path("uc"))
        .env("XDG_CONFIG_HOME", repo.path("xdg"))
        .args(["--format", "json", "."])
        .output()
        .unwrap();
    let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let paths: Vec<_> = found
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().replace('\\', "/"))
        .collect();
    assert_eq!(paths.len(), 1, "{paths:?}");
    assert!(paths[0].ends_with("tests/kept.q"), "{paths:?}");
}

#[cfg(unix)]
#[test]
fn an_unreadable_file_is_an_input_failure_and_the_rest_are_still_linted() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    repo.write("unr/x.q", "a:1\n").write("unr/y.q", SOURCE);
    // Readable, the run is an ordinary one: findings, exit 1.
    let out = run(&repo.path("."), &["--isolated", "unr"]);
    assert_eq!(out.status.code(), Some(1));
    fs::set_permissions(repo.path("unr/x.q"), fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(repo.path("unr/x.q")).is_ok() {
        return; // root reads it anyway; there is nothing to test
    }
    // Without the `--format json` `run` adds, which neither takes.
    let plain = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(repo.path("."))
            .args(args)
            .output()
            .unwrap()
    };
    for (args, out) in [
        ("lint", run(&repo.path("."), &["--isolated", "unr"])),
        ("diff", plain(&["--isolated", "--diff", "unr"])),
        ("graph", plain(&["analyze", "graph", "unr"])),
    ] {
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{args}: {stderr}");
        assert!(
            stderr.contains("x.q") && stderr.contains("skipped"),
            "{stderr}"
        );
    }
    let out = run(&repo.path("."), &["--isolated", "unr"]);
    let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(!found.as_array().unwrap().is_empty(), "y.q is still linted");
}

#[test]
fn a_closed_pipe_ends_the_run_quietly() {
    // `qlinter src | head -1`: the reader goes away, and the next write is
    // EPIPE. Ruff, following ripgrep, exits 0 there; `println!` panicked.
    // Far more output than a pipe buffers, so some write must fail.
    let repo = Repo::new();
    repo.write("a.q", &SOURCE.repeat(500));
    for args in [
        &["--isolated", "a.q"][..],
        &["--rules"],
        &["analyze", "graph", "."],
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(repo.path("."))
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        drop(child.stdout.take());
        let out = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(!stderr.contains("panicked"), "{args:?}: {stderr}");
        assert_eq!(out.status.code(), Some(0), "{args:?}: {stderr}");
    }
    // Read to the end, the same run is an ordinary one.
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(repo.path("."))
        .args(["--isolated", "a.q"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("1000 finding(s)"));
}

#[test]
fn a_lambda_another_file_defines_is_called_not_applied_to_a_literal() {
    // QB010: inside a lambda, `shift -1` meets whatever shift holds when it
    // is called, and another file linted with this one defines it as a
    // lambda, so it may be a call. At the top level the read follows this
    // file's own `shift:3` whatever was loaded first: q 5 loading lib.q then
    // app.q raises 'domain there (#148).
    let repo = Repo::new();
    repo.write("lib.q", "shift:{x+1}\n")
        .write("app.q", "shift:3\nr:shift -1\n")
        .write("late.q", "shift:3\ng:{shift -1}\n");
    let general = |files: &[&str]| {
        let mut args = vec!["--isolated", "--profile", "general"];
        args.extend(files);
        repo.codes(".", &args)
    };
    assert_eq!(general(&["lib.q", "app.q"]), ["QB010"]);
    assert_eq!(general(&["app.q"]), ["QB010"]);
    assert_eq!(general(&["lib.q", "late.q"]), Vec::<String>::new());
}

#[test]
fn an_excluded_file_named_explicitly_is_linted_unless_force_exclude() {
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"style\"\nexclude = [\"sub\"]\n")
        .write("sub/x.q", SOURCE);
    // As in Ruff: exclusion is for what a walk discovers.
    assert_eq!(repo.codes(".", &["sub/x.q"]), ["QF016"]);
    assert_eq!(repo.codes(".", &["."]), Vec::<String>::new());
    assert_eq!(
        repo.codes(".", &["--force-exclude", "sub/x.q"]),
        Vec::<String>::new()
    );
}

#[cfg(unix)]
#[test]
fn a_symlink_is_governed_excluded_and_reported_where_it_is() {
    // The link lives in proj/tests; its target lives outside the project.
    // Resolving it first lost the link's place and name, so proj's
    // configuration, its per-file-ignores and every exclude passed it by,
    // and the finding was reported against the target (#263).
    let repo = Repo::new();
    repo.write("elsewhere/x.q", SOURCE)
        .write(
            "proj/qlinter.toml",
            "profile = \"style\"\n[lint.per-file-ignores]\n\"tests/*\" = [\"QF016\"]\n",
        )
        .write("proj/ok.q", "h:1\n");
    fs::create_dir_all(repo.path("proj/tests")).unwrap();
    std::os::unix::fs::symlink("../../elsewhere/x.q", repo.path("proj/tests/link.q")).unwrap();
    assert_eq!(repo.codes("proj", &["tests"]), Vec::<String>::new());
    assert_eq!(
        linted_from(&repo, "proj", &["--isolated", "."]),
        ["proj/tests/link.q"]
    );
    for exclude in ["link.q", "tests/link.q"] {
        assert_eq!(
            linted_from(&repo, "proj", &["--isolated", ".", "--exclude", exclude]),
            Vec::<String>::new(),
            "{exclude}"
        );
    }
}

#[test]
fn a_path_that_does_not_exist_is_reported_and_the_rest_are_still_linted() {
    // One stale path in a pre-commit or CI file list used to end the run
    // before anything was linted (#265).
    let repo = Repo::new();
    repo.write("ok.q", SOURCE);
    for args in [
        &["--isolated", "--profile", "style", "ok.q", "missing.q"][..],
        &["analyze", "graph", "ok.q", "missing.q"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(repo.path("."))
            .args(args)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{args:?}: {stderr}");
        assert!(
            stderr.contains("missing.q") && stderr.contains("skipped"),
            "{stderr}"
        );
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("ok.q"),
            "{args:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_directory_the_walk_cannot_read_is_reported_and_the_rest_are_still_linted() {
    // One unreadable subdirectory used to end the walk, and with it the
    // lint and the graph of the whole tree (#266). Excluded, it is never
    // read and is no failure at all.
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    repo.write("src/a.q", SOURCE).write("locked/b.q", "g:1\n");
    fs::set_permissions(repo.path("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let readable = fs::read_dir(repo.path("locked")).is_ok();
    let status = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(repo.path("."))
            .args(args)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        (
            out.status.code(),
            stderr,
            String::from_utf8_lossy(&out.stdout).into_owned(),
        )
    };
    let results = [
        status(&["--isolated", "--profile", "style", "."]),
        status(&["analyze", "graph", "."]),
    ];
    let excluded = status(&[
        "--isolated",
        "--profile",
        "style",
        ".",
        "--exclude",
        "locked",
    ]);
    fs::set_permissions(repo.path("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    if readable {
        return; // root reads it anyway; there is nothing to test
    }
    for (code, stderr, stdout) in results {
        assert_eq!(code, Some(2), "{stderr}");
        assert!(
            stderr.contains("locked") && stderr.contains("skipped"),
            "{stderr}"
        );
        assert!(stdout.contains("a.q"), "{stdout}");
    }
    assert_eq!(excluded.0, Some(1), "{}", excluded.1);
}

#[test]
fn build_and_tool_directories_are_excludes_default_which_a_configuration_replaces() {
    // The list was hard-coded in the walk, so `exclude = []` changed nothing
    // and a tree of q under `build/` was "No .q files found" (#267). As in
    // Ruff it is now `exclude`'s default.
    let repo = Repo::new();
    repo.write("src/build/gen.q", SOURCE)
        .write("src/target/t.q", SOURCE)
        .write("src/a.q", SOURCE);
    assert_eq!(linted(&repo, &["--isolated", "src"]), ["src/a.q"]);
    // A directory named outright is not inside one the walk skips.
    assert_eq!(
        linted(&repo, &["--isolated", "src/build"]),
        ["src/build/gen.q"]
    );
    repo.write("qlinter.toml", "extend-exclude = [\"a.q\"]\n");
    assert_eq!(linted(&repo, &["src"]), Vec::<String>::new());
    repo.write("qlinter.toml", "exclude = []\n");
    assert_eq!(
        linted(&repo, &["src"]),
        ["src/a.q", "src/build/gen.q", "src/target/t.q"]
    );
}

#[test]
fn show_settings_lists_only_rules_the_backend_can_report() {
    // QF006 runs only as a Python hook and QLS001 only from qls, yet both
    // were listed - and counted - as turned on for the builtin backend
    // (#274).
    let repo = Repo::new();
    repo.write("a.q", SOURCE);
    let rules = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(repo.path("."))
            .args(["--isolated", "--show-settings"])
            .args(args)
            .arg("a.q")
            .output()
            .unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        let line = text.lines().find(|l| l.starts_with("rules (")).unwrap();
        line.split_once(": ").map_or(vec![], |(_, codes)| {
            codes
                .split_whitespace()
                .map(String::from)
                .collect::<Vec<_>>()
        })
    };
    let builtin = rules(&[]);
    assert!(builtin.contains(&"QE004".to_string()), "{builtin:?}");
    assert!(
        !builtin.iter().any(|c| c == "QF006" || c == "QLS001"),
        "{builtin:?}"
    );
    assert_eq!(rules(&["--select", "QF006"]), Vec::<String>::new());
    assert_eq!(rules(&["--backend", "qls"]), ["QLS001"]);
    assert!(rules(&["--backend", "all"]).contains(&"QLS001".to_string()));
}
