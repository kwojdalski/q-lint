//! Configuration is found the way Ruff finds its own: the nearest
//! `.qlinter.toml`, `qlinter.toml` or `pyproject.toml` with `[tool.qlinter]`,
//! searching up from each file - so a repository's root settings govern every
//! file under it, wherever qlinter is run from.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// Two findings: QS001 (styleq) on `my_var`, QF001 (style) on `desc`.
const SOURCE: &str = "my_var:1;f:{[desc] desc}\n";

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
    assert_eq!(repo.codes(".", &["src/lib/a.q"]), ["QF001"]);
    assert_eq!(repo.codes("src/lib", &["a.q"]), ["QF001"]);
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
    assert_eq!(repo.codes(".", &["pkg/b.q"]), ["QF001", "QS001"]);
}

#[test]
fn in_one_directory_dot_qlinter_then_qlinter_then_pyproject() {
    let repo = Repo::new();
    repo.write("a.q", SOURCE)
        .write("pyproject.toml", "[tool.qlinter]\nprofile = \"styleq\"\n");
    assert_eq!(repo.codes(".", &["a.q"]), ["QF001", "QS001"]);
    repo.write("qlinter.toml", "profile = \"style\"\n");
    assert_eq!(repo.codes(".", &["a.q"]), ["QF001"]);
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
    assert_eq!(repo.codes(".", &["py/a.q"]), ["QF001"]);
}

#[test]
fn the_old_tool_q_lint_table_is_still_read_but_not_beside_the_new_one() {
    let repo = Repo::new();
    repo.write("pyproject.toml", "[tool.q-lint]\nignore = [\"QS001\"]\n")
        .write("a.q", SOURCE);
    assert_eq!(repo.codes(".", &["a.q"]), ["QF001"]);
    repo.write(
        "pyproject.toml",
        "[tool.q-lint]\nignore = [\"QS001\"]\n[tool.qlinter]\nignore = [\"QF001\"]\n",
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
    assert_eq!(repo.codes(".", &["a.q"]), ["QF001"]);
    // A family ignored, one of it put back: the code is more specific.
    repo.write(
        "qlinter.toml",
        "profile = \"styleq\"\n[lint]\nignore = [\"QS\"]\nextend-select = [\"QS001\"]\n",
    );
    assert_eq!(repo.codes(".", &["a.q"]), ["QF001", "QS001"]);
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
        "ignore = [\"QS001\"]\n[lint]\nignore = [\"QF001\"]\n",
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
    assert_eq!(repo.codes(".", &["tests/t.q"]), ["QF001"]);
    assert_eq!(repo.codes(".", &["src/s.q"]), ["QF001", "QS001"]);
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

#[test]
fn extend_inherits_and_the_extending_file_wins() {
    let repo = Repo::new();
    repo.write(
        "base.toml",
        "profile = \"styleq\"\n[lint]\nignore = [\"QF001\"]\n",
    )
    .write("pkg/qlinter.toml", "extend = \"../base.toml\"\n")
    .write("pkg/a.q", SOURCE);
    assert_eq!(repo.codes(".", &["pkg/a.q"]), ["QS001"]);
    repo.write(
        "pkg/qlinter.toml",
        "extend = \"../base.toml\"\nprofile = \"general\"\nextend-select = [\"QF001\"]\n",
    );
    assert_eq!(repo.codes(".", &["pkg/a.q"]), ["QF001"]);
}

#[test]
fn the_command_line_wins_over_the_file() {
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"general\"\n")
        .write("a.q", SOURCE);
    assert_eq!(repo.codes(".", &["a.q"]), Vec::<String>::new());
    assert_eq!(
        repo.codes(".", &["--profile", "styleq", "a.q"]),
        ["QF001", "QS001"]
    );
    assert_eq!(
        repo.codes(".", &["--extend-select", "QS001", "a.q"]),
        ["QS001"]
    );
    assert_eq!(
        repo.codes(".", &["--select", "QF,QS", "--ignore", "QS", "a.q"]),
        ["QF001"]
    );
}

#[test]
fn isolated_and_config_replace_the_search() {
    let repo = Repo::new();
    repo.write("qlinter.toml", "profile = \"general\"\n")
        .write("other.toml", "profile = \"style\"\n")
        .write("a.q", SOURCE);
    // --isolated: the defaults, which for the command line is uqf.
    assert_eq!(repo.codes(".", &["--isolated", "a.q"]), ["QF001", "QS001"]);
    assert_eq!(
        repo.codes(".", &["--config", "other.toml", "a.q"]),
        ["QF001"]
    );
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
    assert!(!text.contains("QF001"), "{text}");
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
