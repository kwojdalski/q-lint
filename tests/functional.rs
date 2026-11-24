//! qSQL to functional form and back (`q_lint_rs::qsql_to_functional`,
//! `functional_to_qsql`): what each direction writes and what it refuses.
//! When `QLINT_TEST_Q` names a q, every functional form written returns
//! what the qSQL it came from returns (`~`), and so does the qSQL written
//! back. The table was run that way on KDB-X and PeachQ, which agree on
//! every case here; PeachQ refuses one shape KDB-X runs, a where clause
//! that is a bare name (`where flag`), which no case uses.
use q_lint_rs::{functional_to_qsql, qsql_to_functional};
use std::process::{Command, Stdio};

/// The table every case reads, as q.
const TABLE: &str = "t:([]sym:`a`b`a`c`b;px:1 2 3 4 5f;size:10 20 30 40 50;flag:10101b;s:(\"ab\";\"cd\";\"ef\";\"gh\";\"ij\");time:09:30:00 09:31:00 09:32:00 09:33:00 09:34:00);s2:`a`b;";

/// `(qsql, functional)`: each direction writes the other, where the second
/// direction's qSQL is the first's up to spacing and implied names.
const CASES: &[(&str, &str)] = &[
    ("select from t", "?[t;();0b;()]"),
    ("select from t where px>2", "?[t;enlist (>;`px;2);0b;()]"),
    (
        "select from t where px>2, sym=`a",
        "?[t;((>;`px;2);(=;`sym;enlist`a));0b;()]",
    ),
    ("select px from t", "?[t;();0b;(enlist`px)!enlist `px]"),
    ("select px, size from t", "?[t;();0b;`px`size!(`px;`size)]"),
    (
        "select n:count i, total:sum size by sym from t where px>1",
        "?[t;enlist (>;`px;1);(enlist`sym)!enlist `sym;`n`total!((count;`i);(sum;`size))]",
    ),
    (
        "select count i, sum size, px*size, 2*px, size%px from t",
        "?[t;();0b;`x`size`px`x1`size1!((count;`i);(sum;`size);(*;`px;`size);(*;2;`px);(%;`size;`px))]",
    ),
    (
        "select max px - min px by sym from t",
        "?[t;();(enlist`sym)!enlist `sym;(enlist`px)!enlist (max;(-;`px;(min;`px)))]",
    ),
    (
        "select from t where sym in `a`b",
        "?[t;enlist (in;`sym;enlist`a`b);0b;()]",
    ),
    (
        "select from t where sym in s2",
        "?[t;enlist (in;`sym;`s2);0b;()]",
    ),
    (
        "select from t where s like \"a*\"",
        "?[t;enlist (like;`s;\"a*\");0b;()]",
    ),
    (
        "select from t where px=(max;px) fby sym",
        "?[t;enlist (=;`px;(fby;(enlist;max;`px);`sym));0b;()]",
    ),
    (
        "select n:count each s from t",
        "?[t;();0b;(enlist`n)!enlist (each;count;`s)]",
    ),
    (
        "select px by 2 xbar size from t",
        "?[t;();(enlist`size)!enlist (xbar;2;`size);(enlist`px)!enlist `px]",
    ),
    (
        "select from t where px within 2 4",
        "?[t;enlist (within;`px;2 4);0b;()]",
    ),
    (
        "select distinct sym from t",
        "?[t;();1b;(enlist`sym)!enlist `sym]",
    ),
    (
        "select by sym from t",
        "?[t;();(enlist`sym)!enlist `sym;()]",
    ),
    (
        "select from t where not null px, size>15",
        "?[t;((not;(null;`px));(>;`size;15));0b;()]",
    ),
    (
        "select m:neg px from t",
        "?[t;();0b;(enlist`m)!enlist (neg;`px)]",
    ),
    (
        "select v:size wavg px by sym from t",
        "?[t;();(enlist`sym)!enlist `sym;(enlist`v)!enlist (wavg;`size;`px)]",
    ),
    (
        "select from t where time within 09:31:00 09:33:00",
        "?[t;enlist (within;`time;09:31:00 09:33:00);0b;()]",
    ),
    (
        "select p:{x+1} px from t",
        "?[t;();0b;(enlist`p)!enlist ({x+1};`px)]",
    ),
    (
        "select from t where px>-1.5",
        "?[t;enlist (>;`px;-1.5);0b;()]",
    ),
    ("exec px from t", "?[t;();();`px]"),
    ("exec px by sym from t", "?[t;();`sym;`px]"),
    ("exec px, size from t", "?[t;();();`px`size!(`px;`size)]"),
    (
        "exec sum size from t where px>2",
        "?[t;enlist (>;`px;2);();(sum;`size)]",
    ),
    (
        "update px:2*px from t where sym=`a",
        "![t;enlist (=;`sym;enlist`a);0b;(enlist`px)!enlist (*;2;`px)]",
    ),
    (
        "update m:max px by sym from t",
        "![t;();(enlist`sym)!enlist `sym;(enlist`m)!enlist (max;`px)]",
    ),
    // q names a dotted column by its last part (KDB-X: `px`, #1300).
    ("select t.px from t", "?[t;();0b;(enlist`px)!enlist `t.px]"),
    ("delete px, size from t", "![t;();0b;`px`size]"),
    // One column is enlisted: `![t;();0b;`px]` is 'type.
    ("delete px from t", "![t;();0b;enlist`px]"),
    // A one-item list is `enlist px`; `(px)` is the column itself.
    (
        "select e:enlist px from t",
        "?[t;();0b;(enlist`e)!enlist (enlist;`px)]",
    ),
    // A `,` in a column or a constraint is bracketed, or it splits the list.
    (
        "select d:(px,px) from t",
        "?[t;();0b;(enlist`d)!enlist (,;`px;`px)]",
    ),
    (
        "select from t where size in (10,20)",
        "?[t;enlist (in;`size;(,;10;20));0b;()]",
    ),
    (
        "delete from t where px>2",
        "![t;enlist (>;`px;2);0b;`symbol$()]",
    ),
    // A query in parentheses inside another is its own tree, each argument
    // as `parse` holds it: what the functional form takes, enlisted unless
    // `eval` leaves it as it is (#2022). On KDB-X 5,
    // parse "select from t where sym in (exec sym from t where px>3)" is
    // (?;`t;,,(in;`sym;(?;`t;,,(>;`px;3);();,`sym));0b;()), and so on down:
    // each of these was compared there with `parse` of its query, argument
    // by argument as q displays them, as well as by what it returns. They
    // were not run on PeachQ.
    (
        "select from t where sym in (exec sym from t where px>3)",
        "?[t;enlist (in;`sym;(?;`t;enlist enlist (>;`px;3);();enlist `sym));0b;()]",
    ),
    (
        "select from t where px>(exec max px from t where sym=`a, size>10)",
        "?[t;enlist (>;`px;(?;`t;enlist ((=;`sym;enlist`a);(>;`size;10));();enlist (max;`px)));0b;()]",
    ),
    (
        "select from t where px<(count select px, size by sym from t)",
        "?[t;enlist (<;`px;(count;(?;`t;();(enlist`sym)!enlist `sym;`px`size!(`px;`size))));0b;()]",
    ),
    (
        "select from t where px<(count select distinct sym from t)",
        "?[t;enlist (<;`px;(count;(?;`t;();1b;(enlist`sym)!enlist `sym)));0b;()]",
    ),
    (
        "select from t where px<(count exec sum px by sym from t)",
        "?[t;enlist (<;`px;(count;(?;`t;();enlist `sym;enlist (sum;`px))));0b;()]",
    ),
    (
        "select from t where size in (exec size from (delete from t where px>2))",
        "?[t;enlist (in;`size;(?;(!;`t;enlist enlist (>;`px;2);0b;`symbol$());();();enlist `size));0b;()]",
    ),
    (
        "select from t where size in (exec size from (delete px from t))",
        "?[t;enlist (in;`size;(?;(!;`t;();0b;enlist enlist`px);();();enlist `size));0b;()]",
    ),
    (
        "select from t where px in (exec px from (update px:2*px from t where sym=`a))",
        "?[t;enlist (in;`px;(?;(!;`t;enlist enlist (=;`sym;enlist`a);0b;(enlist`px)!enlist (*;2;`px));();();enlist `px));0b;()]",
    ),
    (
        "select from t where sym in (exec a:sym, b:px from t)[`a]",
        "?[t;enlist (in;`sym;((?;`t;();();`a`b!(`sym;`px));enlist`a));0b;()]",
    ),
];

/// qSQL that is not rewritten, and why.
const REFUSED: &[(&str, &str)] = &[
    ("select[2] from t", "takes more arguments"),
    ("select n:count each' s from t", "adverb"),
    ("select a:{x}[;1] px from t", "projection"),
    ("select from t where px>a:2", "assignment"),
    ("select #px from t", "monad"),
    // q refuses it too: `neg px` is the monad.
    ("select m:-px from t", "monad"),
];

#[test]
fn qsql_is_written_in_functional_form() {
    for (qsql, functional) in CASES {
        let source = format!("r:{qsql}\n");
        let got = qsql_to_functional(&source, 3)
            .unwrap_or_else(|| panic!("no query in {qsql}"))
            .unwrap_or_else(|e| panic!("{qsql}: {e}"));
        assert_eq!(got.text, *functional, "{qsql}");
        assert_eq!(&source[got.start..got.end], *qsql);
    }
}

#[test]
fn a_functional_form_is_written_back_as_qsql() {
    for (qsql, functional) in CASES {
        let source = format!("r:{functional}\n");
        let got = functional_to_qsql(&source, 3)
            .unwrap_or_else(|| panic!("no functional form in {functional}"))
            .unwrap_or_else(|e| panic!("{functional}: {e}"));
        // Back again, it is the same functional form.
        let again = qsql_to_functional(&format!("r:{}\n", got.text), 3)
            .unwrap()
            .unwrap_or_else(|e| panic!("{}: {e}", got.text));
        assert_eq!(again.text, *functional, "{qsql} -> {}", got.text);
        assert_eq!(&source[got.start..got.end], *functional);
    }
}

#[test]
fn what_cannot_be_read_is_refused_with_the_reason() {
    for (qsql, why) in REFUSED {
        let source = format!("r:{qsql}\n");
        match qsql_to_functional(&source, 3) {
            Some(Err(e)) => assert!(e.contains(why), "{qsql}: {e}"),
            other => panic!("{qsql}: {other:?}"),
        }
    }
    // Outside a query, there is nothing to rewrite.
    assert_eq!(qsql_to_functional("a:1+2\n", 2), None);
    assert_eq!(functional_to_qsql("a:1+2\n", 2), None);
    // A `?[` of other than four arguments is not a functional select.
    assert_eq!(functional_to_qsql("r:?[1b;2;3]\n", 4), None);
}

#[test]
fn a_functional_form_whose_qsql_q_refuses_is_refused() {
    // KDB-X runs the functional form, but `select sym:first sym by sym
    // from t` is 'dup names for cols/groups (#1301). An update may.
    let source = "r:?[t;();(enlist`sym)!enlist `sym;(enlist`sym)!enlist (first;`sym)]\n";
    match functional_to_qsql(source, 3) {
        Some(Err(e)) => assert!(e.contains("dup names"), "{e}"),
        other => panic!("{other:?}"),
    }
    let source = "r:![t;();(enlist`sym)!enlist `sym;(enlist`sym)!enlist (first;`sym)]\n";
    let got = functional_to_qsql(source, 3).unwrap().unwrap();
    assert_eq!(got.text, "update first sym by sym from t");
}

#[test]
fn a_column_named_with_a_word_of_q_is_not_written_as_qsql() {
    // #2023. A functional form names a column with any symbol; qSQL reads a
    // word of q's own as that word. On KDB-X 5 each form here runs, and its
    // qSQL does not: `select count:px from t` is 'assign, `select
    // select:px from t` 'from, `select px by max:sym from t` 'assign,
    // `update asc:px from t` 'assign; and with a column `count` in the
    // table, `select from u where count>1` is 'type (parse reads `#:`),
    // `select v:count from u` 'rank, `exec sym by count from u` 'length,
    // `delete count from u` 'type, and `exec count from u` returns the
    // function.
    for form in [
        "?[t;();0b;(enlist`count)!enlist `px]",
        "?[t;();0b;(enlist`select)!enlist `px]",
        "?[t;();0b;`a`max!(`px;`size)]",
        "?[t;();(enlist`by)!enlist `sym;(enlist`px)!enlist (max;`px)]",
        "?[t;();(enlist`sym)!enlist `sym;(enlist`xbar)!enlist (max;`px)]",
        "![t;();0b;(enlist`asc)!enlist `px]",
        "?[t;();();`from`b!(`px;`size)]",
        "?[t;enlist (>;`count;1);0b;()]",
        "?[t;();0b;(enlist`v)!enlist `count]",
        "?[t;();0b;`a`b!`px`max]",
        "?[t;();0b;(enlist`v)!enlist (+;`lj;1)]",
        "?[t;();`count;`sym]",
        "?[t;();();`count]",
        "![t;();0b;enlist`count]",
        "![t;();0b;`px`count]",
    ] {
        match functional_to_qsql(&format!("r:{form}\n"), 3) {
            Some(Err(e)) => assert!(e.contains("q's own"), "{form}: {e}"),
            other => panic!("{form}: {other:?}"),
        }
    }
    // A symbol q reads as no name at all is no column either.
    match functional_to_qsql("r:?[t;();0b;(enlist`a:b)!enlist `px]\n", 3) {
        Some(Err(e)) => assert!(e.contains("cannot spell"), "{e}"),
        other => panic!("{other:?}"),
    }
    // `i` and `x` are names like any other: `select i:px from t` runs.
    let got = functional_to_qsql("r:?[t;();0b;`i`x!(`px;`size)]\n", 3)
        .unwrap()
        .unwrap();
    assert_eq!(got.text, "select i:px, x:size from t");
}

#[test]
fn the_cursor_can_be_anywhere_in_the_query() {
    let source = "f:{[x] r:select px from t where px>x; r}\n";
    let at = source.find("where").unwrap() + 2;
    let got = qsql_to_functional(source, at).unwrap().unwrap();
    assert_eq!(got.text, "?[t;enlist (>;`px;`x);0b;(enlist`px)!enlist `px]");
    let source = "r:1+count ?[t;enlist (>;`px;2);0b;()]\n";
    let got = functional_to_qsql(source, source.len() - 5)
        .unwrap()
        .unwrap();
    assert_eq!(got.text, "select from t where px>2");
}

/// Run `script` on the q that QLINT_TEST_Q names, and what it printed.
fn run_q(script: &str) -> Option<String> {
    let q = std::env::var("QLINT_TEST_Q").ok()?;
    let mut words = q.split_whitespace();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("functional.q");
    std::fs::write(&path, script).unwrap();
    let out = Command::new(words.next()?)
        .args(words)
        .arg(&path)
        .arg("-q")
        .stdin(Stdio::null())
        .output()
        .expect("run q");
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// A q string literal of `text`.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

#[test]
fn each_rewrite_returns_what_the_query_it_came_from_returns() {
    let mut script = format!(
        "{TABLE}\nck:{{[a;b] r:@[{{(1b;value x)}};;{{(0b;x)}}]each(a;b); -1 $[all r[;0];$[(r[0;1])~r[1;1];\"same\";\"DIFFERENT \",a];\"ERROR \",a]}};\n"
    );
    for (qsql, functional) in CASES {
        let back = functional_to_qsql(&format!("r:{functional}\n"), 3)
            .unwrap()
            .unwrap()
            .text;
        script.push_str(&format!("ck[{}; {}];\n", quoted(qsql), quoted(functional)));
        script.push_str(&format!("ck[{}; {}];\n", quoted(qsql), quoted(&back)));
    }
    script.push_str("\\\\\n");
    let Some(out) = run_q(&script) else {
        eprintln!("QLINT_TEST_Q names no q: the cases stand as KDB-X ran them");
        if let Ok(path) = std::env::var("QLINT_FUNCTIONAL_SCRIPT") {
            std::fs::write(path, &script).unwrap();
        }
        return;
    };
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2 * CASES.len(), "{out}");
    assert!(lines.iter().all(|l| *l == "same"), "{out}");
}

// The explainer (`q_lint_rs::explain_qsql`): the same words for the same
// text, every claim about q in them checked in KDB-X and PeachQ (see
// `semantics::explain`).

#[test]
fn a_query_is_said_in_words() {
    let source = "r:select n:count i, v:size wavg px by sym from t where px>2, sym in `a`b\n";
    let words = q_lint_rs::explain_qsql(source, 4).unwrap();
    assert_eq!(
        words,
        "**In words.** Reads `t`.\n\
         1. Keeps the rows where `px` is greater than `2`; then, of those, the rows where `sym` is one of `` `a`b ``. Each condition is tested only on the rows the ones before it kept.\n\
         2. Groups the rows by `sym`: the result is a keyed table, one row for each group.\n\
         3. Returns, for each group, `n`: the number of rows and `v`: the average of `px` weighted by `size`."
    );
    let words = q_lint_rs::explain_qsql("update px:0f from `t where sym=`a\n", 1).unwrap();
    assert!(
        words.contains("Changes the table `` `t `` in place."),
        "{words}"
    );
    assert!(
        words.contains("every other row keeps its values"),
        "{words}"
    );
    let words = q_lint_rs::explain_qsql("r:update px:0f from t\n", 3).unwrap();
    assert!(words.contains("returns a changed copy of it"), "{words}");
    let words = q_lint_rs::explain_qsql("r:select by sym from t\n", 3).unwrap();
    assert!(words.contains("the last row of each group"), "{words}");
    let words = q_lint_rs::explain_qsql("r:exec px from t\n", 3).unwrap();
    assert!(words.contains("as a list, not a table"), "{words}");
    let words = q_lint_rs::explain_qsql("r:delete px, size from t\n", 3).unwrap();
    assert!(
        words.contains("Removes the columns `px` and `size`."),
        "{words}"
    );
    let words = q_lint_rs::explain_qsql("r:select from t where px=(max;px) fby sym\n", 3).unwrap();
    assert!(
        words.contains("`px` equals the largest of `px` within each group of `sym`"),
        "{words}"
    );
    // What it has no words for is quoted.
    let words = q_lint_rs::explain_qsql("r:select from t where px>f[a;b]\n", 3).unwrap();
    assert!(words.contains("`px` is greater than `f[a;b]`"), "{words}");
}

#[test]
fn a_functional_form_is_said_in_words_through_its_qsql() {
    let words = q_lint_rs::explain_qsql("r:?[t;enlist (>;`px;2);0b;()]\n", 3).unwrap();
    assert!(
        words.starts_with("The functional form of `select from t where px>2`."),
        "{words}"
    );
    assert!(
        words.contains("Keeps the rows where `px` is greater than `2`."),
        "{words}"
    );
    assert_eq!(q_lint_rs::explain_qsql("a:1+2\n", 2), None);
}
