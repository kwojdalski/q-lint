//! `organise_loads`: each run of `\l` lines sorted, deduped and grouped, as
//! isort does imports - and everything it must leave alone.
use q_lint_rs::organise_loads;

fn organised(source: &str) -> Option<String> {
    let fix = organise_loads(source)?;
    assert!(!fix.batch_safe, "`--fix` must never reorder loads");
    assert_eq!(fix.title, "Organise loads");
    let mut out = source.to_string();
    out.replace_range(fix.start..fix.end, &fix.replacement);
    Some(out)
}

#[test]
fn a_run_is_deduped_sorted_and_grouped() {
    let source = "a:1\n\\l src/b.q\n\\l /opt/q/z.q\n\\l lib/A.q\n\\l src/b.q\n\\l ~/c.q\nf:{x}\n";
    assert_eq!(
        organised(source).unwrap(),
        "a:1\n\\l /opt/q/z.q\n\\l ~/c.q\n\n\\l lib/A.q\n\\l src/b.q\nf:{x}\n"
    );
}

#[test]
fn organising_twice_changes_nothing_the_second_time() {
    let once = organised("\\l b.q\n\\l /a.q\n\\l a.q\n").unwrap();
    assert_eq!(once, "\\l /a.q\n\n\\l a.q\n\\l b.q\n");
    assert!(organised(&once).is_none());
}

#[test]
fn nothing_to_do_is_no_edit() {
    assert!(organised("\\l a.q\n\\l b.q\n").is_none());
    assert!(organised("a:1\n").is_none());
}

#[test]
fn runs_are_kept_apart_and_line_endings_kept() {
    // A blank line, a comment or a statement ends a run.
    assert_eq!(
        organised("\\l d.q\n\\l c.q\n\n\\l b.q\n\\l a.q\n").unwrap(),
        "\\l c.q\n\\l d.q\n\n\\l a.q\n\\l b.q\n"
    );
    assert_eq!(
        organised("\\l b.q\r\n\\l a.q\r\nx:1\r\n").unwrap(),
        "\\l a.q\r\n\\l b.q\r\nx:1\r\n"
    );
    // The last line of a file without a newline.
    assert_eq!(organised("\\l b.q\n\\l a.q").unwrap(), "\\l a.q\n\\l b.q");
}

#[test]
fn a_run_loading_anything_but_a_q_or_k_file_is_left_alone() {
    // `\l db` loads a database and changes directory: the loads after it
    // are relative to it.
    assert!(organised("\\l db\n\\l b.q\n\\l a.q\n").is_none());
    assert!(organised("\\l b.q\n\\l a.csv\n").is_none());
    // Another run in the file is still organised.
    assert_eq!(
        organised("\\l db\n\\l b.q\nx:1\n\\l d.k\n\\l c.q\n").unwrap(),
        "\\l db\n\\l b.q\nx:1\n\\l c.q\n\\l d.k\n"
    );
}

#[test]
fn loads_q_does_not_read_are_left_alone() {
    // In a block comment, after the end of the script, and in a file whose
    // brackets do not close.
    assert!(organised("/\n\\l b.q\n\\l a.q\n\\\n").is_none());
    assert!(organised("\\\n\\l b.q\n\\l a.q\n").is_none());
    assert!(organised("f:{\n\\l b.q\n\\l a.q\n").is_none());
    // Not a load: `system "l ..."` and an indented line.
    assert!(organised("system \"l b.q\"\nsystem \"l a.q\"\n").is_none());
}
