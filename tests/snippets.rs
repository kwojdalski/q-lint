//! The editor snippets (`editors/vscode/snippets/q.json`, and the idioms in
//! `idioms.json` the extension offers while `q-lint.idiomSnippets.enable`
//! is on) are q somebody is
//! about to have in a buffer, so each is held to what the editor will then
//! say about it: expanded with every placeholder at its default, a snippet
//! reports nothing under `uqf`, the broadest profile, and so under any. A
//! template that arrives underlined teaches the wrong form.
//!
//! Checked here rather than in the extension's own tests because this runs
//! wherever `cargo test` does, with no binary to find first.
use q_lint_rs::{Profile, lint};
use std::collections::BTreeMap;

/// A snippet body as VS Code inserts it before anything is typed: `$1`,
/// `${1}` and `${1:default}` become the default the tabstop was first given
/// (nothing, if none), and `\$`, `\}` and `\\` the character escaped. Any
/// other construct - a variable, a choice, a transform - panics: the file
/// uses none, and one added later should be expanded here on purpose.
fn expand(body: &str) -> String {
    let mut defaults = BTreeMap::new();
    // Twice: a tabstop can be mirrored before the place that defaults it.
    render(body, &mut defaults);
    render(body, &mut defaults)
}

fn render(body: &str, defaults: &mut BTreeMap<String, String>) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some(c) = rest.chars().next() {
        if c == '\\' && rest[1..].starts_with(['$', '}', '\\']) {
            out.push_str(&rest[1..2]);
            rest = &rest[2..];
        } else if c == '$' {
            let braced = rest[1..].starts_with('{');
            let digits = &rest[1 + usize::from(braced)..];
            let n = digits.len()
                - digits
                    .trim_start_matches(|d: char| d.is_ascii_digit())
                    .len();
            assert!(
                n > 0,
                "not a tabstop, and not escaped: {rest:?} in {body:?}"
            );
            let index = digits[..n].to_string();
            rest = &digits[n..];
            if braced && let Some(inner) = rest.strip_prefix(':') {
                let end = closing_brace(inner);
                let default = render(&inner[..end], defaults);
                defaults.entry(index.clone()).or_insert(default);
                rest = &inner[end + 1..];
            } else if braced {
                rest = rest
                    .strip_prefix('}')
                    .expect("only `${n}` and `${n:default}`");
            }
            out.push_str(defaults.get(&index).map_or("", String::as_str));
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// Where the `}` that ends a placeholder's default is: the first that is
/// neither escaped nor the end of a placeholder nested inside it.
fn closing_brace(text: &str) -> usize {
    let (mut depth, mut escaped) = (0, false);
    for (i, c) in text.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '{' if text[..i].ends_with('$') => depth += 1,
            '}' if depth == 0 => return i,
            '}' => depth -= 1,
            _ => {}
        }
    }
    panic!("a placeholder that does not close: {text:?}");
}

fn snippets() -> Vec<(String, String)> {
    snippets_in("q.json")
}

fn snippets_in(name: &str) -> Vec<(String, String)> {
    let file = format!(
        "{}/editors/vscode/snippets/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let all: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    all.as_object()
        .unwrap()
        .iter()
        .map(|(name, snippet)| {
            let body = match &snippet["body"] {
                serde_json::Value::String(line) => line.clone(),
                lines => lines
                    .as_array()
                    .unwrap_or_else(|| panic!("{name}: body is a string or a list of them"))
                    .iter()
                    .map(|line| line.as_str().unwrap())
                    .collect::<Vec<_>>()
                    .join("\n"),
            };
            (name.clone(), body)
        })
        .collect()
}

#[test]
fn the_expander_reads_the_snippet_syntax() {
    assert_eq!(expand("a ${1:b} $0"), "a b ");
    assert_eq!(expand("\\$[${1:x};${2:{\\}}]"), "$[x;{}]");
    assert_eq!(expand("x ,\\\\: y"), "x ,\\: y");
    // A mirror takes the default of the tabstop it repeats, wherever that is.
    assert_eq!(expand("$1 ${1:n} ${2:${1}+1}"), "n n n+1");
}

#[test]
fn every_snippet_expands_to_q_the_editor_reports_nothing_on() {
    let all = snippets();
    assert!(all.len() >= 20, "expected the snippet file, found {all:?}");
    let idioms = snippets_in("idioms.json");
    assert!(idioms.len() >= 15, "expected the idioms, found {idioms:?}");
    for (name, body) in all.into_iter().chain(idioms) {
        // A leading tab is one indent: VS Code writes it as the buffer
        // indents, with spaces or with the tab itself. q continues a
        // statement on either.
        for indent in ["  ", "\t"] {
            let mut source = expand(&body).replace('\t', indent);
            source.push('\n');
            let found: Vec<String> = lint(&source, "snippet.q", Profile::Uqf)
                .iter()
                .map(|f| {
                    format!(
                        "{}:{} {} {}",
                        f.line,
                        f.column.unwrap_or(0),
                        f.code,
                        f.detail
                    )
                })
                .collect();
            assert!(
                found.is_empty(),
                "{name} expands to\n{source}which reports {found:#?}"
            );
        }
    }
}
