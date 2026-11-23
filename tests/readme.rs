//! The README says what the binary does. Every option `--help` lists is
//! named in the README's Options section, so a flag added to the CLI and
//! never documented fails here, and so does one whose documentation was
//! deleted. (The `initializationOptions` block is checked against the
//! server's own defaults by a unit test in `src/lsp.rs`, where they live.)
use std::process::Command;

const README: &str = include_str!("../README.md");

/// The README from the heading `from` to the next heading of the same level.
fn section(from: &str) -> &'static str {
    let start = README
        .find(&format!("\n{from}\n"))
        .unwrap_or_else(|| panic!("README lost its `{from}` heading"));
    let level = from.split(' ').next().unwrap();
    let body = &README[start + from.len() + 2..];
    let end = body.find(&format!("\n{level} ")).unwrap_or(body.len());
    &body[..end]
}

/// Each long option a `--help` lists.
fn flags(args: &[&str]) -> Vec<String> {
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "{args:?}");
    let help = String::from_utf8(out.stdout).unwrap();
    let mut found: Vec<String> = help
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let line = line
                .strip_prefix("-h, ")
                .or_else(|| line.strip_prefix("-v, "))
                .unwrap_or(line);
            let flag = line.strip_prefix("--")?;
            let name: String = flag
                .chars()
                .take_while(|c| c.is_ascii_lowercase() || *c == '-')
                .collect();
            Some(format!("--{name}"))
        })
        .collect();
    found.dedup();
    assert!(found.len() > 3, "no options in {args:?}: {help}");
    found
}

/// Whether `text` names `flag` as itself, not as the start of a longer one
/// (`--fix` inside `--fix-only`) or the end of one (`--select` inside
/// `--extend-select`).
fn names(text: &str, flag: &str) -> bool {
    text.match_indices(flag).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + flag.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
            && !after.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

fn undocumented(flags: &[String], text: &str) -> Vec<String> {
    flags.iter().filter(|f| !names(text, f)).cloned().collect()
}

#[test]
fn every_cli_option_is_in_the_readme_options_section() {
    let options = section("## Options");
    assert_eq!(
        undocumented(&flags(&["--help"]), options),
        Vec::<String>::new()
    );
}

#[test]
fn every_analyze_graph_option_is_in_its_section() {
    let graph = section("### The dependency graph: `qlinter analyze graph`");
    // `--help` is the Options section's, said once for every command.
    let mut listed = flags(&["analyze", "graph", "--help"]);
    listed.retain(|f| f != "--help");
    assert_eq!(undocumented(&listed, graph), Vec::<String>::new());
}

#[test]
fn a_flag_removed_from_the_readme_is_caught() {
    let options = section("## Options");
    let help = flags(&["--help"]);
    assert!(help.contains(&"--select".to_string()));
    // `--extend-select` stays, and must not count as `--select`.
    let without = options.replace("`--select`", "").replace("--select ", "");
    assert!(names(&without, "--extend-select"));
    assert_eq!(undocumented(&help, &without), ["--select"]);
}
