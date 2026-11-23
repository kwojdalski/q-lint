//! The README says what the binary does. Every option `--help` lists is
//! named in the README's Options section, so a flag added to the CLI and
//! never documented fails here, and so does one whose documentation was
//! deleted. (The `initializationOptions` block is checked against the
//! server's own defaults by a unit test in `src/lsp.rs`, where they live.)
use std::process::Command;

/// The README with LF line ends, as a Windows checkout may have made them CRLF.
static README: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| include_str!("../README.md").replace("\r\n", "\n"));

/// The README from the heading `from` to the next heading of the same level.
fn section(from: &str) -> &'static str {
    let readme: &'static str = &README;
    let start = readme
        .find(&format!("\n{from}\n"))
        .unwrap_or_else(|| panic!("README lost its `{from}` heading"));
    let level = from.split(' ').next().unwrap();
    let body = &readme[start + from.len() + 2..];
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

/// The body of each fenced block in the README's "Other editors" section.
fn editor_snippets() -> Vec<String> {
    section("### Other editors")
        .split("```")
        .skip(1)
        .step_by(2)
        .map(|block| {
            block
                .split_once('\n')
                .map_or("", |(_, body)| body)
                .to_string()
        })
        .collect()
}

#[test]
fn every_editor_snippet_runs_the_server_with_no_profile() {
    let snippets = editor_snippets();
    // Neovim, Helix, Eglot, lsp-mode, Sublime, Kakoune and Zed.
    assert_eq!(snippets.len(), 7, "{snippets:#?}");
    for snippet in &snippets {
        let words: Vec<String> = snippet
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
            .map(str::to_string)
            .collect();
        // The command is `qlinter`, its one argument `--lsp`: a profile in
        // the editor would override every repository's own.
        assert!(words.iter().any(|w| w == "qlinter"), "{snippet}");
        assert!(words.iter().any(|w| w == "--lsp"), "{snippet}");
        assert!(!snippet.contains("--profile"), "{snippet}");
        assert!(!snippet.contains("--stdio"), "{snippet}");
        // And the one option each passes is one the server reads.
        assert!(snippet.contains("onSave"), "{snippet}");
    }
}

#[test]
fn the_server_command_line_in_the_snippets_is_accepted() {
    // What every snippet runs, started and shut down as an editor would:
    // a flag the server refuses would stop it before `initialize`.
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .args(["--lsp"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for body in [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"initializationOptions":{"lint":{"run":"onSave"}}}}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"shutdown"}"#,
        r#"{"jsonrpc":"2.0","method":"exit"}"#,
    ] {
        write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains(r#""capabilities""#), "{stdout}");
    assert!(stdout.contains(r#""id":2"#), "{stdout}");
}
