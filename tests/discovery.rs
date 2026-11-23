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
fn a_bad_selector_or_glob_in_a_configuration_names_the_file() {
    // Every other configuration error names its file; with nested files or
    // an `extend` chain, these two did not (#423).
    for (config, said) in [
        (
            "[lint]\nselect = [\"QZ\"]\n",
            "select: QZ is not a diagnostic code",
        ),
        (
            "exclude = [\"[bad\"]\n",
            "exclude: [bad: Pattern syntax error",
        ),
        (
            "[lint.per-file-ignores]\n\"a.q\" = [\"QZ\"]\n",
            "per-file-ignores: QZ is not",
        ),
        (
            "[lint.per-file-ignores]\n\"[bad\" = [\"QF\"]\n",
            "per-file-ignores: [bad: Pattern",
        ),
    ] {
        let repo = Repo::new();
        repo.write("a.q", SOURCE).write("sub/.qlinter.toml", config);
        repo.write("sub/a.q", SOURCE);
        let out = run(&repo.path("."), &["sub/a.q"]);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{stderr}");
        assert!(
            stderr.contains(&format!(".qlinter.toml: {said}")),
            "{config}: {stderr}"
        );
    }
}

#[test]
fn an_extend_cycle_is_reported_as_a_cycle() {
    // A file extending itself was reported as "more than 16 files deep" (#424).
    for files in [
        &[(".qlinter.toml", "extend = \".qlinter.toml\"\n")][..],
        &[
            (".qlinter.toml", "extend = \"b.toml\"\n"),
            ("b.toml", "extend = \".qlinter.toml\"\n"),
        ][..],
    ] {
        let repo = Repo::new();
        repo.write("a.q", SOURCE);
        for (name, text) in files {
            repo.write(name, text);
        }
        let out = run(&repo.path("."), &["a.q"]);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{stderr}");
        assert!(stderr.contains("`extend` cycle: "), "{stderr}");
        assert!(stderr.trim_end().ends_with(".qlinter.toml"), "{stderr}");
    }
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

#[test]
fn force_exclude_skips_a_file_inside_a_default_excluded_directory() {
    // The walk never enters `build/`; a hook passing `build/x.q` with
    // --force-exclude must skip it too, by path or by --stdin-filename (#415).
    let repo = Repo::new();
    repo.write("build/x.q", SOURCE);
    let style = ["--isolated", "--profile", "style"];
    assert_eq!(repo.codes(".", &style), Vec::<String>::new());
    assert_eq!(
        repo.codes(".", &[&style[..], &["build/x.q"]].concat()),
        ["QF016"]
    );
    let forced = [&style[..], &["--force-exclude", "build/x.q"]].concat();
    assert_eq!(repo.codes(".", &forced), Vec::<String>::new());
    let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(repo.path("."))
        .args([
            "--format",
            "json",
            "--force-exclude",
            "--stdin-filename",
            "build/x.q",
        ])
        .args(style)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    // An excluded file is skipped without reading stdin, so the write may
    // meet a closed pipe: that is the behaviour under test, not a failure.
    let _ = child.stdin.take().unwrap().write_all(SOURCE.as_bytes());
    let out = child.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "[]");
    // A file in a directory of that name above the current one is not.
    assert_eq!(
        repo.codes("build", &[&style[..], &["--force-exclude", "x.q"]].concat()),
        ["QF016"]
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

#[cfg(unix)]
#[test]
fn one_file_under_two_names_is_fixed_once_with_both_names_fixes() {
    // Each name was fixed from the text read before the loop, so the second
    // write clobbered the first and the run reported a tree it had left
    // dirty (#761).
    let repo = Repo::new();
    repo.write("d1/a.q", "f:{x!=y}\ng:{x+y}\nh:{g x}\n")
        .write("d1/.qlinter.toml", "profile=\"uqf\"\nignore=[\"QP006\"]\n")
        .write("d2/.qlinter.toml", "profile=\"uqf\"\nignore=[\"QE004\"]\n");
    std::os::unix::fs::symlink("../d1/a.q", repo.path("d2/l.q")).unwrap();
    assert_eq!(
        repo.codes(".", &["--fix", "d1/a.q", "d2/l.q"]),
        Vec::<String>::new()
    );
    assert_eq!(
        fs::read_to_string(repo.path("d1/a.q")).unwrap(),
        "f:{x<>y}\ng:{x+y}\nh:{g[x]}\n"
    );
    assert_eq!(repo.codes(".", &["d1/a.q", "d2/l.q"]), Vec::<String>::new());
}

#[cfg(unix)]
#[test]
fn one_file_under_two_names_does_not_define_its_names_for_itself() {
    // Indexed once per name, each name found the file's own `a` defined
    // "elsewhere", and q 5's 'type on `f[]` went unreported (#527).
    let repo = Repo::new();
    repo.write("real.q", "a:1\nf:{a 0}\n");
    std::os::unix::fs::symlink("real.q", repo.path("twin.q")).unwrap();
    let general = ["--isolated", "--profile", "general"];
    assert_eq!(
        repo.codes(".", &[&general[..], &["."]].concat()),
        ["QT022", "QT022"]
    );
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(repo.path("."))
        .args(["analyze", "graph", "."])
        .output()
        .unwrap();
    let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(found, serde_json::json!({"real.q": [], "twin.q": []}));
}

#[test]
fn a_script_loaded_under_a_context_defines_in_it_for_the_others() {
    // q 5 runs main.q to 42: b.q, loaded under `\d .a`, defines `.a.ff`,
    // which c.q's `\d .a` lambda reads (#525).
    let repo = Repo::new();
    repo.write("main.q", "\\d .a\n\\l b.q\n\\d .\n\\l c.q\n")
        .write("b.q", "ff:42\n")
        .write("c.q", "\\d .a\ng:{ff}\n\\d .\n");
    let style = ["--isolated", "--profile", "style", "--select", "QF018"];
    assert_eq!(
        repo.codes(".", &[&style[..], &["c.q", "b.q"]].concat()),
        ["QF018"]
    );
    assert_eq!(
        repo.codes(".", &[&style[..], &["."]].concat()),
        Vec::<String>::new()
    );
}

#[test]
fn a_script_loaded_only_under_a_context_defines_nothing_at_the_root() {
    // q 5: after main.q's `\d .a` / `\l b.q`, the root has no `ff`, and
    // d.q's `h:{ff}` throws 'ff (#525).
    let repo = Repo::new();
    repo.write("main.q", "\\d .a\n\\l b.q\n\\d .\n\\l d.q\n")
        .write("b.q", "ff:42\n")
        .write("d.q", "h:{ff}\n");
    let style = ["--isolated", "--profile", "style", "--select", "QF018"];
    assert_eq!(repo.codes(".", &[&style[..], &["."]].concat()), ["QF018"]);
    // Linted without main.q, nothing loads b.q, so it is run at the root.
    assert_eq!(
        repo.codes(".", &[&style[..], &["d.q", "b.q"]].concat()),
        Vec::<String>::new()
    );
    // Loaded at the root as well, from a file run at the root, it defines
    // in both.
    repo.write("e.q", "\\l b.q\n");
    assert_eq!(
        repo.codes(".", &[&style[..], &["."]].concat()),
        Vec::<String>::new()
    );
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

#[test]
fn stdin_that_is_not_utf8_is_linted_as_the_same_file_on_disk_is() {
    // q 5 loads `s:"caf\xe9"` (count 4). The file route lints it lossily;
    // stdin refused it with "stream did not contain valid UTF-8" (#417).
    use std::io::Write;
    let source = b"s:\"caf\xe9\"\na:1==2\n";
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .args(["--isolated", "--format", "json", "--stdin-filename", "a.q"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(source).unwrap();
    let out = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("a.q: not valid UTF-8"), "{stderr}");
    let found: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(found[0]["code"], "QE004");
    assert_eq!(found[0]["line"], 2);
}

#[test]
fn an_empty_exclude_pattern_is_refused_rather_than_excluding_everything() {
    // `exclude = [""]` in a file is refused; `--exclude ''`, as from an
    // unset `$EXTRA`, linted nothing and exited 0 (#418).
    let repo = Repo::new();
    repo.write("a.q", SOURCE);
    for args in [
        &["--isolated", "--exclude", "", "."][..],
        &["--isolated", "--exclude", "  ", "."][..],
        &["analyze", "graph", "--exclude", "", "."][..],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(repo.path("."))
            .args(args)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{args:?}: {stderr}");
        assert!(
            stderr.contains("--exclude: a pattern must not be empty"),
            "{stderr}"
        );
    }
}

#[test]
fn a_stdin_filename_that_is_not_q_is_refused_as_the_file_would_be() {
    // `qlinter kk.k` refuses k source; `--stdin-filename kk.k` linted it as
    // q (#421).
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    for name in ["kk.k", "notes.txt"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(dir.path())
            .args(["--isolated", "--stdin-filename", name])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        // The refusal can come before qlinter reads stdin, so the write may
        // meet a closed pipe: that is the behaviour under test, not a failure.
        let _ = child.stdin.take().unwrap().write_all(b"f:{x==y}\n");
        let out = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{name}: {stderr}");
        assert!(stderr.contains("not a .q file"), "{stderr}");
    }
}

#[test]
fn the_tests_exemption_from_qp002_counts_only_directories_below_the_root() {
    // A `tests` directory below the project root exempts its files, wherever
    // qlinter runs and however the path is spelled (#416); one above the
    // root - a checkout under `~/tests` - exempts nothing, and a code the
    // command line selects reports regardless (#800).
    let repo = Repo::new();
    repo.write("tests/proj/.qlinter.toml", "profile = \"uqf\"\n")
        .write("tests/proj/src/a.q", "x:.z.z\n")
        .write("tests/proj/src/tests.q", "x:.z.z\n")
        .write("tests/proj/tests/a.q", "x:.z.z\n")
        .write("tests/proj/tests/q/a.q", "x:.z.z\n");
    let qp002 = |cwd: &str, args: &[&str]| repo.codes(cwd, args).contains(&"QP002".to_string());
    assert!(qp002("tests/proj", &["src/a.q"]));
    assert!(qp002("tests/proj/src", &["a.q"]));
    assert!(qp002("tests/proj", &["src/tests.q"]));
    assert!(!qp002("tests/proj", &["tests/a.q"]));
    assert!(!qp002("tests/proj/src", &["../tests/q/a.q"]));
    let absolute = repo.path("tests/proj/tests/a.q");
    assert!(!qp002(".", &[absolute.to_str().unwrap()]));
    assert!(qp002("tests/proj", &["--select", "QP002", "tests/a.q"]));
    // With no configuration the root is the current directory.
    repo.write("bare/tests/a.q", "x:.z.z\n");
    assert!(!qp002(
        "bare",
        &["--isolated", "--profile", "uqf", "tests/a.q"]
    ));
    assert!(qp002(
        "bare/tests",
        &["--isolated", "--profile", "uqf", "a.q"]
    ));
}

#[test]
fn the_routine_mix_is_in_no_profile_and_reports_only_where_it_is_selected() {
    // QP007 is the mix school precedence reads as q does: no profile turns
    // it on, a selector that names it does - its code, a prefix, or `ALL` -
    // and it passes over a `tests` directory as QP005 does, unless the
    // command line names it (#847).
    let repo = Repo::new();
    let source = "mid:0.5*bid+ask\nstamp:start+step*til n\n";
    repo.write("plain/src/a.q", source)
        .write("chosen/qlinter.toml", "extend-select = [\"QP007\"]\n")
        .write("chosen/src/a.q", source)
        .write("chosen/tests/a.q", source);
    let mixes = |cwd: &str, args: &[&str]| -> Vec<String> {
        let mut codes = repo.codes(cwd, args);
        codes.retain(|c| c == "QP005" || c == "QP007");
        codes
    };
    assert_eq!(mixes("plain", &["--profile", "uqf", "src/a.q"]), ["QP005"]);
    for selector in ["QP007", "QP", "ALL"] {
        assert_eq!(
            mixes("plain", &["--extend-select", selector, "src/a.q"]),
            ["QP005", "QP007"],
            "{selector}"
        );
    }
    assert_eq!(mixes("plain", &["--select", "QP007", "src/a.q"]), ["QP007"]);
    assert_eq!(
        mixes(
            "plain",
            &["--extend-select", "QP007", "--ignore", "QP007", "src/a.q"]
        ),
        ["QP005"]
    );
    // From the configuration file, and the tests exemption with it.
    assert_eq!(mixes("chosen", &["src/a.q"]), ["QP005", "QP007"]);
    assert_eq!(mixes("chosen", &["tests/a.q"]), Vec::<String>::new());
    assert_eq!(
        mixes("chosen", &["--select", "QP007", "tests/a.q"]),
        ["QP007"]
    );
    assert_eq!(
        mixes("chosen", &["--extend-select", "QP005", "tests/a.q"]),
        ["QP005"]
    );
}

#[test]
fn the_reverse_convention_is_selected_only_by_its_code_and_refused_beside_the_forward_one() {
    // QP008 removes the parentheses QP005 and QP007 add. A prefix or `ALL`
    // would turn both sides on, so only its own code selects it; and where
    // it and either forward rule would both report on a file, the run is
    // refused before anything is reported or rewritten (#848).
    let repo = Repo::new();
    let source = "mid:0.5*(bid+ask)\nstamp:start+step*til n\nw:a*b+c\n";
    repo.write("plain/src/a.q", source)
        .write("plain/tests/a.q", source)
        .write("chosen/qlinter.toml", "extend-select = [\"QP008\"]\n")
        .write("chosen/src/a.q", source)
        .write(
            "settled/qlinter.toml",
            "extend-select = [\"QP008\"]\nignore = [\"QP005\"]\n",
        )
        .write("settled/src/a.q", source);
    let mixes = |cwd: &str, args: &[&str]| -> Vec<String> {
        let mut codes = repo.codes(cwd, args);
        codes.retain(|c| c.starts_with("QP00") && c.as_str() >= "QP005");
        codes
    };
    let refusal = |cwd: &str, args: &[&str]| -> String {
        let out = run(&repo.path(cwd), args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        String::from_utf8(out.stderr).unwrap()
    };
    for selector in ["QP", "QP00", "ALL"] {
        assert_eq!(
            mixes("plain", &["--select", selector, "src/a.q"]),
            ["QP005", "QP007"],
            "{selector}"
        );
    }
    assert_eq!(mixes("plain", &["--select", "QP008", "src/a.q"]), ["QP008"]);
    // Under `uqf` QP005 is on, so naming QP008 alone is the pairing.
    let message = refusal("plain", &["--extend-select", "QP008", "src/a.q"]);
    assert!(
        message.contains("QP008 (restated-precedence-parentheses) and QP005 (mixed-infix-precedence) are opposite conventions"),
        "{message}"
    );
    assert!(
        refusal("plain", &["--select", "QP008,QP007", "src/a.q"]).contains("and QP007"),
        "QP007"
    );
    refusal("chosen", &["src/a.q"]);
    refusal("chosen", &["--fix", "src/a.q"]);
    assert_eq!(
        fs::read_to_string(repo.path("chosen/src/a.q")).unwrap(),
        source
    );
    // Settled by ignoring the forward rule, or by the tests exemption that
    // takes QP005 off a test file.
    assert_eq!(
        mixes(
            "plain",
            &["--extend-select", "QP008", "--ignore", "QP005", "src/a.q"]
        ),
        ["QP008"]
    );
    assert_eq!(
        mixes("plain", &["--extend-select", "QP008", "tests/a.q"]),
        ["QP008"]
    );
    assert_eq!(mixes("settled", &["src/a.q"]), ["QP008"]);
}

#[test]
fn force_exclude_reads_default_directories_from_the_project_root_not_the_cwd() {
    // Run from inside build/, or beside it, the file is still in build/
    // below the configuration's root: the walk of the project skips it, so
    // --force-exclude does too. Measured from the cwd, it was linted (#801).
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"style\"\n")
        .write("build/x.q", SOURCE)
        .write("src/a.q", SOURCE);
    assert_eq!(
        repo.codes(".", &["--force-exclude", "build/x.q"]),
        Vec::<String>::new()
    );
    assert_eq!(
        repo.codes("build", &["--force-exclude", "x.q"]),
        Vec::<String>::new()
    );
    assert_eq!(
        repo.codes("src", &["--force-exclude", "../build/x.q"]),
        Vec::<String>::new()
    );
    // A `build` above the root is not one the walk would skip.
    let outer = Repo::new();
    outer
        .write("build/proj/qlinter.toml", "profile = \"style\"\n")
        .write("build/proj/a.q", SOURCE);
    assert_eq!(
        outer.codes(".", &["--force-exclude", "build/proj/a.q"]),
        ["QF016"]
    );
}

#[test]
fn force_exclude_applies_a_name_pattern_to_a_file_outside_its_root() {
    // `--exclude gen` is rooted at the cwd, here/; a walk of ../other skips
    // other/gen, so naming the file with --force-exclude skips it too. Only
    // the file's own name was asked, and it was linted (#802).
    let repo = Repo::new();
    repo.write("other/gen/f.q", SOURCE).write("here/.keep", "");
    let args = ["--isolated", "--profile", "style", "--exclude", "gen"];
    assert_eq!(
        repo.codes("here", &[&args[..], &["../other"]].concat()),
        Vec::<String>::new()
    );
    let forced = [&args[..], &["--force-exclude", "../other/gen/f.q"]].concat();
    assert_eq!(repo.codes("here", &forced), Vec::<String>::new());
    let unforced = [&args[..], &["../other/gen/f.q"]].concat();
    assert_eq!(repo.codes("here", &unforced), ["QF016"]);
}

#[test]
fn an_exclude_naming_the_whole_tree_is_refused_like_an_empty_one() {
    // `--exclude "$UNSET/"` is `/`, and `./` names the root: both linted
    // nothing and exited 0, while `.` excluded nothing at all (#803).
    let repo = Repo::new();
    repo.write("src/a.q", SOURCE).write("sub/.keep", "");
    for (cwd, pattern) in [
        (".", "/"),
        (".", "./"),
        (".", "."),
        ("sub", ".."),
        (".", " ./ "),
    ] {
        for args in [
            &["--isolated", "--exclude", pattern, "."][..],
            &["analyze", "graph", "--exclude", pattern, "."][..],
        ] {
            let out = run(&repo.path(cwd), args);
            let stderr = String::from_utf8_lossy(&out.stderr);
            assert_eq!(out.status.code(), Some(2), "{args:?}: {stderr}");
            assert!(stderr.contains("whole tree"), "{args:?}: {stderr}");
        }
    }
    repo.write("qlinter.toml", "exclude = [\"./\"]\n");
    let out = run(&repo.path("."), &["."]);
    assert_eq!(out.status.code(), Some(2));
    // A per-file-ignore for the whole tree is meaningful, and `.` now
    // means what `./` does there.
    repo.write(
        "qlinter.toml",
        "profile = \"style\"\n[lint]\nper-file-ignores = {\".\" = [\"QF016\"]}\n",
    );
    assert_eq!(repo.codes(".", &["src/a.q"]), Vec::<String>::new());
    // A directory in the tree is still a pattern like any other.
    assert_eq!(
        repo.codes(
            ".",
            &["--isolated", "--profile", "style", "--exclude", "src", "."]
        ),
        Vec::<String>::new()
    );
}

#[test]
fn show_settings_describes_the_stdin_filename_and_refuses_fix() {
    // It described the cwd instead of the buffer's path, and a --fix beside
    // it exited 0 having fixed nothing (#806).
    let repo = Repo::new();
    repo.write(
        ".qlinter.toml",
        "profile = \"style\"\n[lint]\nper-file-ignores = {\"tests/*\" = [\"QE\"]}\n",
    )
    .write("a.q", "g:{c==d}\n");
    let out = run(
        &repo.path("."),
        &["--show-settings", "--stdin-filename", "tests/x.q"],
    );
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(out.status.code(), Some(0), "{text}");
    // Windows prints the path with its own separator.
    assert!(text.replace('\\', "/").contains("tests/x.q"), "{text}");
    assert!(!text.contains("QE004"), "{text}");
    // Ruff's form, with the buffer named `-`, describes the same file (#1198).
    let out = run(
        &repo.path("."),
        &["--show-settings", "--stdin-filename", "tests/x.q", "-"],
    );
    let dash = String::from_utf8(out.stdout).unwrap();
    assert_eq!(out.status.code(), Some(0), "{dash}");
    assert_eq!(dash, text);
    for flag in ["--fix", "--diff"] {
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(repo.path("."))
            .args(["--show-settings", flag, "a.q"])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{flag}: {stderr}");
        assert!(stderr.contains("--show-settings"), "{flag}: {stderr}");
    }
    assert_eq!(fs::read_to_string(repo.path("a.q")).unwrap(), "g:{c==d}\n");
}
