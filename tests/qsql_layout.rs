//! The qSQL layout (`q_lint_rs::qsql_layouts`, `qsql_layout_at`): what it
//! writes for a long query, and the queries it leaves alone because a new
//! line there could change what q reads.
//!
//! Every laid-out case assigns `r`, and with `QLINT_QSQL_OUT=<dir>` set each
//! is written there as `<n>.before.q` and `<n>.after.q`, so a q can load
//! both and compare the two `r`s with `~` (`scratchpad/features/feat-s/
//! qsql_check.q`): the cases were run that way on KDB-X and PeachQ, over
//! the tables `qsql_check.q` defines.
use q_lint_rs::{qsql_layout_at, qsql_layouts};

/// `source` with every long query laid out at `width`.
fn format(source: &str, width: usize) -> String {
    let mut out = source.to_string();
    for l in qsql_layouts(source, width).iter().rev() {
        out.replace_range(l.start..l.end, &l.text);
    }
    out
}

/// `(source, width, expected)`: laid out by Format Document.
const LAID_OUT: &[(&str, usize, &str)] = &[
    (
        "r:select n:count i, px:avg px by sym from trade where px>1, sz<400\n",
        40,
        "r:select n:count i, px:avg px\n      by sym\n    from trade\n   where px>1, sz<400\n",
    ),
    // Constraints one per line when they do not fit, in the content column.
    (
        "r:select n:count i,px:avg px by sym from trade where px>1,sz<400,sym in `a`b,not null px\n",
        30,
        "r:select n:count i, px:avg px\n      by sym\n    from trade\n   where px>1,\n         sz<400,\n         sym in `a`b,\n         not null px\n",
    ),
    // Columns too, under the first.
    (
        "r:select first_price:first px, last_price:last px, total_size:sum sz from trade\n",
        40,
        "r:select first_price:first px,\n         last_price:last px,\n         total_size:sum sz\n    from trade\n",
    ),
    // exec: `where` is longer than `exec`, so at column 0 it would end the
    // statement; every clause word moves right instead.
    (
        "r:exec px from trade where sym=`a, sz>100, px>0\n",
        20,
        "r:exec px\n  from trade\n where sym=`a,\n       sz>100,\n       px>0\n",
    ),
    (
        "exec px from trade where sym=`a, sz>100, px>0\n",
        20,
        "exec px\n  from trade\n where sym=`a,\n       sz>100,\n       px>0\n",
    ),
    // Inside a lambda, aligned to where `select` is.
    (
        "f:{[s] select n:count i, px:avg px by sym from trade where sym in s}\nr:f`a`b\n",
        40,
        "f:{[s] select n:count i, px:avg px\n           by sym\n         from trade\n        where sym in s}\nr:f`a`b\n",
    ),
    // update and delete.
    (
        "r:update vwap:sz wavg px, n:count i by sym from trade where px>1\n",
        40,
        "r:update vwap:sz wavg px, n:count i\n      by sym\n    from trade\n   where px>1\n",
    ),
    (
        "r:delete from trade where sym=`a, px>2, sz<500, not null px\n",
        30,
        "r:delete\n    from trade\n   where sym=`a,\n         px>2,\n         sz<500,\n         not null px\n",
    ),
    // `select[n]` keeps its brackets; a comma in brackets or parens and a
    // `where` before `from` (the function) are no break; strings untouched.
    (
        "r:select[2] s:sym, w:where px>1 from trade where sym in `a`b, (string sym) like \"a, by from\"\n",
        40,
        "r:select[2] s:sym, w:where px>1\n    from trade\n   where sym in `a`b,\n         (string sym) like \"a, by from\"\n",
    ),
    (
        "r:select w:sum px by g:sum(sz;px)>200 from trade where ((string sym) like \"a*\") or sym=`$\"a, by from\"\n",
        30,
        "r:select w:sum px\n      by g:sum(sz;px)>200\n    from trade\n   where ((string sym) like \"a*\") or sym=`$\"a, by from\"\n",
    ),
    // A query in parens, and the code after it on its line.
    (
        "r:0!(select n:count i by sym from trade where px>1, sz>10); x:1\n",
        30,
        "r:0!(select n:count i\n         by sym\n       from trade\n      where px>1, sz>10); x:1\n",
    ),
    // A negative literal after a comma, and an adverb in a column.
    (
        "r:select a:px*-1, b:sz,-1, c:{x+y}/[sz] from trade where px>-1, sz>-100\n",
        30,
        "r:select a:px*-1,\n         b:sz,\n         -1,\n         c:{x+y}/[sz]\n    from trade\n   where px>-1, sz>-100\n",
    ),
    // A comma an adverb follows is a derived function, not a separator.
    (
        "r:select l:(,/)(sym;sym), m:,'[sym;sym] from trade where px>1, sz>10\n",
        30,
        "r:select l:(,/)(sym;sym),\n         m:,'[sym;sym]\n    from trade\n   where px>1, sz>10\n",
    ),
    // A query laid out already is laid out the same.
    (
        "r:select n:count i, px:avg px\n      by sym\n    from trade\n   where px>1, sz<400\n",
        40,
        "r:select n:count i, px:avg px\n      by sym\n    from trade\n   where px>1, sz<400\n",
    ),
    // CRLF stays CRLF.
    (
        "r:select n:count i by sym from trade where px>1\r\n",
        20,
        "r:select n:count i\r\n      by sym\r\n    from trade\r\n   where px>1\r\n",
    ),
    // Two queries, one short: only the long one changes.
    (
        "a:select from trade\nr:select n:count i by sym from trade where px>1\n",
        30,
        "a:select from trade\nr:select n:count i\n      by sym\n    from trade\n   where px>1\n",
    ),
    // A nested query in the from phrase stays on its line.
    (
        "r:select n:count i by sym from (select from trade where px>1) where sz>10\n",
        40,
        "r:select n:count i\n      by sym\n    from (select from trade where px>1)\n   where sz>10\n",
    ),
    // A symbol that spells a query word is no query word.
    (
        "r:select s:`from`by, n:count i from trade where sym<>`where\n",
        30,
        "r:select s:`from`by, n:count i\n    from trade\n   where sym<>`where\n",
    ),
    // An indented continuation line of a statement.
    (
        "r:{x}\n  select n:count i by sym from trade where px>1\n",
        20,
        "r:{x}\n  select n:count i\n      by sym\n    from trade\n   where px>1\n",
    ),
    // Under a tab, each line starts with the same tab: how wide it is
    // shown is the editor's, and blanks in its place were 3 where the
    // tab is 4 or 8 (#2803).
    (
        "f:{[s]\n\tselect n:count i, px:avg px by sym from trade where sym in s}\nr:f`a`b\n",
        40,
        "f:{[s]\n\tselect n:count i, px:avg px\n\t    by sym\n\t  from trade\n\t where sym in s}\nr:f`a`b\n",
    ),
    (
        "f:{[s]\n\tr:select n:count i,px:avg px from trade where sym in s,px>1,sz<400,not null px;\n\tr}\nr:f`a`b\n",
        30,
        "f:{[s]\n\tr:select n:count i, px:avg px\n\t    from trade\n\t   where sym in s,\n\t         px>1,\n\t         sz<400,\n\t         not null px;\n\tr}\nr:f`a`b\n",
    ),
    // No clause word starts left of the tab: `where` under `exec` moves
    // every clause word right, as at column 0.
    (
        "f:{[s]\n\texec px from trade where sym in s, sz>100, px>0}\nr:f`a`b\n",
        20,
        "f:{[s]\n\texec px\n\t from trade\n\twhere sym in s,\n\t      sz>100,\n\t      px>0}\nr:f`a`b\n",
    ),
    // A character shown two cells wide is two columns, and one past the
    // basic plane is not counted by its bytes or its UTF-16 units.
    (
        "r:(\"\u{1F600}\u{1F600}\";select n:count i, px:avg px by sym from trade where px>1, sz<400)\n",
        40,
        "r:(\"\u{1F600}\u{1F600}\";select n:count i, px:avg px\n              by sym\n            from trade\n           where px>1, sz<400)\n",
    ),
    (
        "r:(\"\u{65E5}\u{672C}\";select n:count i, px:avg px by sym from trade where px>1, sz<400)\n",
        40,
        "r:(\"\u{65E5}\u{672C}\";select n:count i, px:avg px\n              by sym\n            from trade\n           where px>1, sz<400)\n",
    ),
    (
        "r:(\"\u{e9}\";select n:count i, px:avg px by sym from trade where px>1, sz<400)\n",
        40,
        "r:(\"\u{e9}\";select n:count i, px:avg px\n           by sym\n         from trade\n        where px>1, sz<400)\n",
    ),
];

/// Queries left alone at any width.
const LEFT_ALONE: &[&str] = &[
    // A comment in it, at the end of its line or in the middle.
    "r:select n:count i by sym from trade where px>1 / long enough\n",
    "r:select n:count i by sym from trade\n  / note\n  where px>1\n",
    // Broken somewhere this does not break.
    "r:select n:count i by sym from trade where px>\n  1\n",
    // A second query word at the same depth.
    "r:select from trade where sym in exec sym from trade where px>1\n",
    // Out of order: `by` after `from`.
    "r:select n:count i from trade by sym\n",
    // A `\\t` line.
    "\\t select n:count i by sym from trade where px>1, sz>10\n",
    // No `from` (a function named select).
    ".my.select[1;2;3;4;5;6;7;8;9;10;11;12;13;14;15;16;17;18;19;20]\n",
    // Unbalanced brackets.
    "r:select n:count i by sym from (trade where px>1\n",
];

#[test]
fn long_queries_are_laid_out() {
    let out_dir = std::env::var("QLINT_QSQL_OUT").ok();
    for (n, (source, width, expected)) in LAID_OUT.iter().enumerate() {
        let got = format(source, *width);
        assert_eq!(&got, expected, "case {n}: {source:?}");
        // Formatting what was formatted changes nothing.
        assert_eq!(format(&got, *width), got, "case {n} twice");
        if let Some(dir) = &out_dir {
            std::fs::write(format!("{dir}/{n}.before.q"), source).unwrap();
            std::fs::write(format!("{dir}/{n}.after.q"), &got).unwrap();
        }
    }
}

#[test]
fn unsafe_or_short_queries_are_left_alone() {
    for source in LEFT_ALONE {
        assert_eq!(format(source, 10), *source, "{source:?}");
        let at = source.find("select").unwrap_or(0);
        assert!(qsql_layout_at(source, at, 10).is_none(), "{source:?}");
    }
}

#[test]
fn the_action_lays_out_a_short_query_at_the_cursor() {
    let source = "a:1\nr:select n:count i by sym from trade where px>1\n";
    let at = source.find("by").unwrap();
    let l = qsql_layout_at(source, at, 80).expect("a layout");
    let mut out = source.to_string();
    out.replace_range(l.start..l.end, &l.text);
    assert_eq!(
        out,
        "a:1\nr:select n:count i\n      by sym\n    from trade\n   where px>1\n"
    );
    // Outside any query, nothing; and nothing once laid out.
    assert!(qsql_layout_at(source, 1, 80).is_none());
    assert!(qsql_layout_at(&out, out.find("by").unwrap(), 80).is_none());
    // The outermost query around the cursor.
    let nested = "r:select n:count i by sym from (select from trade where px>1) where sz>10\n";
    let l = qsql_layout_at(nested, nested.find("px>1").unwrap(), 80).unwrap();
    assert_eq!(l.start, 2);
}
