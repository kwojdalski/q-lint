//! The README and the pages under `docs/` say what the binary does. Every
//! option `--help` lists is named in the Options section of `docs/cli.md`,
//! so a flag added to the CLI and never documented fails here, and so does
//! one whose documentation was deleted. And every relative link in them
//! reaches a file, and every `#anchor` a heading, so moving a section
//! cannot strand a link to it. (The `initializationOptions` block in
//! `docs/lsp.md` is checked against the server's own defaults by a unit
//! test in `src/lsp.rs`, where they live.)
use std::process::Command;

/// `docs/cli.md` with LF line ends, as a Windows checkout may have made them CRLF.
static CLI: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| include_str!("../docs/cli.md").replace("\r\n", "\n"));

/// `docs/editors.md`, likewise.
static EDITORS: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| include_str!("../docs/editors.md").replace("\r\n", "\n"));

/// The page from the heading `from` to the next heading of the same level.
fn section(page: &'static str, from: &str) -> &'static str {
    let start = page
        .find(&format!("\n{from}\n"))
        .unwrap_or_else(|| panic!("the page lost its `{from}` heading"));
    let level = from.split(' ').next().unwrap();
    let body = &page[start + from.len() + 2..];
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
fn every_cli_option_is_in_the_cli_options_section() {
    let options = section(&CLI, "## Options");
    assert_eq!(
        undocumented(&flags(&["--help"]), options),
        Vec::<String>::new()
    );
}

#[test]
fn every_analyze_graph_option_is_in_its_section() {
    let graph = section(&CLI, "## The dependency graph: `qlinter analyze graph`");
    // `--help` is the Options section's, said once for every command.
    let mut listed = flags(&["analyze", "graph", "--help"]);
    listed.retain(|f| f != "--help");
    assert_eq!(undocumented(&listed, graph), Vec::<String>::new());
}

#[test]
fn a_flag_removed_from_the_options_section_is_caught() {
    let options = section(&CLI, "## Options");
    let help = flags(&["--help"]);
    assert!(help.contains(&"--select".to_string()));
    // `--extend-select` stays, and must not count as `--select`.
    let without = options.replace("`--select`", "").replace("--select ", "");
    assert!(names(&without, "--extend-select"));
    assert_eq!(undocumented(&help, &without), ["--select"]);
}

/// The body of each fenced block in the "Other editors" section of `docs/editors.md`.
fn editor_snippets() -> Vec<String> {
    section(&EDITORS, "## Other editors")
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

/// A page's text with its fenced blocks blanked, so a `](` in code is not
/// taken for a link.
fn prose(text: &str) -> String {
    let mut fenced = false;
    text.lines()
        .map(|line| {
            if line.trim_start().starts_with("```") {
                fenced = !fenced;
                return "";
            }
            if fenced { "" } else { line }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The anchors a page offers: each heading as GitHub spells its id, and
/// each explicit `<a id="...">`.
fn anchors(text: &str) -> std::collections::BTreeSet<String> {
    let mut found = std::collections::BTreeSet::new();
    for line in prose(text).lines() {
        if let Some(heading) = line.strip_prefix('#') {
            let heading = heading.trim_start_matches('#').trim();
            let slug: String = heading
                .to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
                .map(|c| if c == ' ' { '-' } else { c })
                .collect();
            // A repeated heading's id gets -1, -2, ...
            let mut id = slug.clone();
            let mut n = 0;
            while !found.insert(id.clone()) {
                n += 1;
                id = format!("{slug}-{n}");
            }
        }
    }
    let explicit = regex::Regex::new(r#"<a id="([^"]+)""#).unwrap();
    for c in explicit.captures_iter(text) {
        found.insert(c[1].to_string());
    }
    found
}

#[test]
fn every_relative_link_in_the_readme_and_docs_resolves() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut pages = vec![root.join("README.md")];
    for entry in std::fs::read_dir(root.join("docs")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "md") {
            pages.push(path);
        }
    }
    let link = regex::Regex::new(r"\]\(([^)\s]+)\)").unwrap();
    let mut broken = Vec::new();
    for page in &pages {
        let text = std::fs::read_to_string(page).unwrap().replace("\r\n", "\n");
        for c in link.captures_iter(&prose(&text)) {
            let target = &c[1];
            if target.contains("://") || target.starts_with("mailto:") {
                continue;
            }
            let (file, anchor) = target.split_once('#').unwrap_or((target, ""));
            let dest = if file.is_empty() {
                page.clone()
            } else {
                page.parent().unwrap().join(file)
            };
            let name = page.strip_prefix(root).unwrap().display();
            if !dest.exists() {
                broken.push(format!("{name}: {target}: no such file"));
            } else if !anchor.is_empty() && dest.extension().is_some_and(|e| e == "md") {
                let there = std::fs::read_to_string(&dest).unwrap();
                if !anchors(&there).contains(anchor) {
                    broken.push(format!("{name}: {target}: no such heading"));
                }
            }
        }
    }
    assert!(broken.is_empty(), "{broken:#?}");
}

#[test]
fn a_heading_s_anchor_is_spelled_as_github_spells_it() {
    let ids = anchors("# A\n## The dependency graph: `qlinter analyze graph`\n## A\n");
    assert!(
        ids.contains("the-dependency-graph-qlinter-analyze-graph"),
        "{ids:?}"
    );
    assert!(ids.contains("a") && ids.contains("a-1"), "{ids:?}");
}
