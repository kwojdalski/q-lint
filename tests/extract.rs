//! Extract Function (`q_lint_rs::extract`): what it writes for a selection,
//! and what it refuses to rewrite because the result would mean something
//! else.
//!
//! Every accepted case names an expression to evaluate after loading the
//! file, and with `QLINT_EXTRACT_OUT=<dir>` set each case is written there
//! as `<n>.before.q`, `<n>.after.q` and `<n>.check`, so a q can load both
//! sides and compare (`scratchpad/features/feat-i/extract_check.q`): the
//! cases were run that way on KDB-X and PeachQ.
use q_lint_rs::{extract, fresh_name};

/// The source with `selected` (its first occurrence, or the `nth` one)
/// extracted as `fresh_name`'s pick, or the refusal.
fn apply_nth(source: &str, selected: &str, nth: usize) -> Result<String, String> {
    let from = source
        .match_indices(selected)
        .nth(nth)
        .unwrap_or_else(|| panic!("{selected:?} not in {source:?}"))
        .0;
    let found = extract(source, from, from + selected.len())?;
    let name = fresh_name(source, "extracted");
    let mut out = source.to_string();
    out.replace_range(found.start..found.end, &found.call(&name));
    out.insert_str(found.insert_at, &found.definition(&name));
    Ok(out)
}

fn apply(source: &str, selected: &str) -> Result<String, String> {
    apply_nth(source, selected, 0)
}

/// `(source, selection, expected result, check)` for every rewrite made.
const ACCEPTED: &[(&str, &str, &str, &str)] = &[
    (
        "g:{[a;b] a+b*2}\n",
        "b*2",
        "extracted:{[b] b*2}\ng:{[a;b] a+extracted[b]}\n",
        "g[1;2]",
    ),
    (
        "g:{x+y*z}\n",
        "y*z",
        "extracted:{[y;z] y*z}\ng:{x+extracted[y;z]}\n",
        "g[1;2;3]",
    ),
    (
        "g:{[a;b] (a+b)*a}\n",
        "(a+b)",
        "extracted:{[a;b] (a+b)}\ng:{[a;b] extracted[a;b]*a}\n",
        "g[2;3]",
    ),
    (
        "g:{[a] t:a*2; t+count til t}\n",
        "count til t",
        "extracted:{[t] count til t}\ng:{[a] t:a*2; t+extracted[t]}\n",
        "g 4",
    ),
    (
        "g:{[a] a+sum {x*x} each til a}\n",
        "sum {x*x} each til a",
        "extracted:{[a] sum {x*x} each til a}\ng:{[a] a+extracted[a]}\n",
        "g 5",
    ),
    (
        "r:1+2*3\n",
        "2*3",
        "extracted:{[] 2*3}\nr:1+extracted[]\n",
        "r",
    ),
    (
        "\\d .ns\ng:{[a] a*10+a}\n\\d .\n",
        "10+a",
        "\\d .ns\nextracted:{[a] 10+a}\ng:{[a] a*extracted[a]}\n\\d .\n",
        ".ns.g 2",
    ),
    (
        "k:100\ng:{[a] a+k}\n",
        "a+k",
        "k:100\nextracted:{[a] a+k}\ng:{[a] extracted[a]}\n",
        "g 1",
    ),
    (
        "g:{[a;b]\n  r:a+\n    b*2;\n  r}\n",
        "a+\n    b*2",
        "extracted:{[a;b] a+\n    b*2}\ng:{[a;b]\n  r:extracted[a;b];\n  r}\n",
        "g[1;5]",
    ),
    (
        "g:{[a] a,/:1 2}\n",
        "a,/:1 2",
        "extracted:{[a] a,/:1 2}\ng:{[a] extracted[a]}\n",
        "g 7 8",
    ),
    (
        "g:{[a] a,\"x;y\"}\n",
        "a,\"x;y\"",
        "extracted:{[a] a,\"x;y\"}\ng:{[a] extracted[a]}\n",
        "g \"ab\"",
    ),
    (
        "g:{[t;n] select from t where x>n}\n",
        "select from t where x>n",
        "extracted:{[t;n] select from t where x>n}\ng:{[t;n] extracted[t;n]}\n",
        "g[([] x:1 2 3);1]",
    ),
    (
        "g:{[d] d[`a]+1}\n",
        "d[`a]",
        "extracted:{[d] d[`a]}\ng:{[d] extracted[d]+1}\n",
        "g `a`b!10 20",
    ),
    ("g:{[a] f:{x*2}; f a}\n", "a", "", ""),
    (
        "extracted:3\ng:{[a] a*a+1}\n",
        "a+1",
        "extracted:3\nextracted2:{[a] a+1}\ng:{[a] a*extracted2[a]}\n",
        "g[4]+extracted",
    ),
    (
        "g:{[a] a+`s$string a}\n",
        "`s$string a",
        "extracted:{[a] `s$string a}\ng:{[a] a+extracted[a]}\n",
        "@[g;1;{x}]",
    ),
    (
        "g:{[a;b] $[a>b;a-b;b-a]}\n",
        "b-a",
        "extracted:{[a;b] b-a}\ng:{[a;b] $[a>b;a-b;extracted[a;b]]}\n",
        "(g[1;5];g[5;1])",
    ),
    (
        "g:{[a] 1 2 3+a}\n",
        "1 2 3",
        "extracted:{[] 1 2 3}\ng:{[a] extracted[]+a}\n",
        "g 10",
    ),
    (
        "g:{[a] (::)~a}\n",
        "(::)~a",
        "extracted:{[a] (::)~a}\ng:{[a] extracted[a]}\n",
        "(g[::];g 1)",
    ),
    // Called with brackets, an infix keyword is a value (#1303).
    (
        "g:{[a;b] b+mod[a;3]}\n",
        "mod[a;3]",
        "extracted:{[a] mod[a;3]}\ng:{[a;b] b+extracted[a]}\n",
        "g[7;1]",
    ),
    (
        "g:{[a] 1+each[neg;a]}\n",
        "each[neg;a]",
        "extracted:{[a] each[neg;a]}\ng:{[a] 1+extracted[a]}\n",
        "g 1 2",
    ),
    // `$[` is the conditional, a value wherever it stands (#2780).
    (
        "g:{[a] b:a*2; $[b>1;b;0]}\n",
        "$[b>1;b;0]",
        "extracted:{[b] $[b>1;b;0]}\ng:{[a] b:a*2; extracted[b]}\n",
        "g 3",
    ),
    (
        "g:{[a] 1+$[a>1;a;0]*2}\n",
        "$[a>1;a;0]",
        "extracted:{[a] $[a>1;a;0]}\ng:{[a] 1+extracted[a]*2}\n",
        "g 3",
    ),
    // A column's name assigns nothing: a table literal's, a query's (#2780).
    (
        "g:{[a] ([] c:a)}\n",
        "([] c:a)",
        "extracted:{[a] ([] c:a)}\ng:{[a] extracted[a]}\n",
        "g 1 2",
    ),
    (
        "g:{[a] ([k:a] c:a; d:2*a)}\n",
        "([k:a] c:a; d:2*a)",
        "extracted:{[a] ([k:a] c:a; d:2*a)}\ng:{[a] extracted[a]}\n",
        "g 1 2",
    ),
    (
        "g:{[a] select c:a from ([]b:1 2)}\n",
        "select c:a from ([]b:1 2)",
        "extracted:{[a] select c:a from ([]b:1 2)}\ng:{[a] extracted[a]}\n",
        "g 3 4",
    ),
    (
        "g:{[a] select[1] c:a, d:b by e:b from ([]b:1 2)}\n",
        "select[1] c:a, d:b by e:b from ([]b:1 2)",
        "extracted:{[a] select[1] c:a, d:b by e:b from ([]b:1 2)}\ng:{[a] extracted[a]}\n",
        "g 3 4",
    ),
    (
        "g:{[a] 0!update c:a from ([]b:1 2)}\n",
        "update c:a from ([]b:1 2)",
        "extracted:{[a] update c:a from ([]b:1 2)}\ng:{[a] 0!extracted[a]}\n",
        "g 3 4",
    ),
    // The call stays a token of its own after a name, a symbol or the `.`
    // of an apply that the selection stood right after (#2791).
    (
        "g:{sum x}\nh:{[a;b] g(a;b)}\n",
        "(a;b)",
        "g:{sum x}\nextracted:{[a;b] (a;b)}\nh:{[a;b] g extracted[a;b]}\n",
        "h[1;2]",
    ),
    (
        "g:{x+y}\nh:{[a;b] g .(a;b)}\n",
        "(a;b)",
        "g:{x+y}\nextracted:{[a;b] (a;b)}\nh:{[a;b] g . extracted[a;b]}\n",
        "h[1;2]",
    ),
    (
        "h:{[a] a+count\"abc\"}\n",
        "\"abc\"",
        "extracted:{[] \"abc\"}\nh:{[a] a+count extracted[]}\n",
        "h 1",
    ),
    (
        "h:{[a] `x`y(a;0)}\n",
        "(a;0)",
        "extracted:{[a] (a;0)}\nh:{[a] `x`y extracted[a]}\n",
        "h 1",
    ),
    (
        "h:{[a] neg$[a>1;a;0]}\n",
        "$[a>1;a;0]",
        "extracted:{[a] $[a>1;a;0]}\nh:{[a] neg extracted[a]}\n",
        "h 3",
    ),
    (
        "h:{[a] 10 20 30(a;0)}\n",
        "(a;0)",
        "extracted:{[a] (a;0)}\nh:{[a] 10 20 30 extracted[a]}\n",
        "h 2",
    ),
    // A glyph or a blank after the selection that assigns nothing (#2792).
    (
        "g:{[t] t[`x] , 1}\n",
        "t[`x]",
        "extracted:{[t] t[`x]}\ng:{[t] extracted[t] , 1}\n",
        "g `x`y!1 2",
    ),
];

#[test]
fn each_selection_becomes_a_lambda_of_the_locals_it_reads() {
    let out = std::env::var("QLINT_EXTRACT_OUT").ok();
    for (n, (source, selected, expected, check)) in ACCEPTED.iter().enumerate() {
        let got = apply(source, selected);
        if expected.is_empty() {
            // A single local is no expression worth a lambda.
            assert!(got.is_err(), "{source:?} / {selected:?}: {got:?}");
            continue;
        }
        let got = got.unwrap_or_else(|e| panic!("{source:?} / {selected:?}: {e}"));
        assert_eq!(got, *expected, "{source:?} / {selected:?}");
        if let Some(dir) = &out {
            std::fs::write(format!("{dir}/{n}.before.q"), source).unwrap();
            std::fs::write(format!("{dir}/{n}.after.q"), &got).unwrap();
            std::fs::write(format!("{dir}/{n}.check"), check).unwrap();
        }
    }
}

#[test]
fn a_selection_that_is_no_value_of_its_expression_is_refused() {
    for (source, selected, why) in [
        ("g:{[x;y;z] x+y*z}\n", "x+y", "not a value"),
        ("g:{[a] b:a+1; b}\n", "b:a+1", "assigns"),
        ("g:{[a] a+1; :a}\n", ":a", "returns"),
        ("g:{[a] $[a;.z.s a-1;0]}\n", ".z.s a-1", ".z.s"),
        ("g:{[t] select a+b from t}\n", "a+b", "qSQL"),
        ("g:{[ab] ab+1}\n", "b+1", "inside a name"),
        ("g:{[x] x -1}\n", "1", "negative"),
        ("g:{[a] a+1 2 3}\n", "2 3", "list of numbers"),
        ("g:{[a] a+1 2 3}\n", "a+1 2", "list of numbers"),
        ("g:{[a] a+1; a+2}\n", "a+1; a+2", "more than one"),
        ("g:{[a;b] (a+b)*2}\n", "(a+b", "does not close"),
        ("g:{[a;b] a+b}\n", "+b", "operator"),
        ("g:{[a;f] f'[a]}\n", "f", "signature"),
        ("g:{[d;e] d[`a]:e; d}\n", "d[`a]", "assigned"),
        ("g:{[a] count a+1}\n", "count a", "not a value"),
        ("g:{[a] a,`x`y}\n", "`y", "symbol"),
        // KDB-X refuses {[b] mod b} and {[b] in b} (#1303).
        ("g:{[a;b] a mod b}\n", "mod b", "infix"),
        ("g:{[a;b] a xexp b}\n", "xexp b", "infix"),
        ("g:{[a;b] a in b}\n", "in b", "infix"),
        // KDB-X refuses {[b] each b} (#1304); each[neg;a] is a value.
        ("g:{[a] neg each a}\n", "each a", "iterator"),
        ("g:{[a;b] a over b}\n", "over b", "iterator"),
        ("g:{[a;b] a prior b}\n", "prior b", "iterator"),
        // KDB-X: d:`extracted[a] is a symbol indexed, s (#1302).
        ("g:{[x] `abc,x}\n", "abc,x", "symbol"),
        ("g:{[x] x,`.ns.v}\n", ".ns.v", "symbol"),
        ("g:{[a] a,\"xyz\"}\n", "yz", "string"),
        ("\\d .ns\n", "d .ns", "system command"),
        // `2 {x*2}/l` is `{x*2}/[2;l]`: 2 is an argument of the adverb.
        ("g:{[l] 2 {x*2}/l}\n", "{x*2}/l", "adverb"),
        ("g:{[n] n f/0}\n", "f/0", "adverb"),
        ("g:{[a;b] a {x,y}'b}\n", "{x,y}'b", "adverb"),
        ("g:{[l] count {x+y}/l}\n", "{x+y}/l", "adverb"),
        // A column's name assigns nothing, but what a column holds may
        // (#2780).
        ("g:{[a] ([] c:(b:a))}\n", "([] c:(b:a))", "assigns"),
        ("g:{[a] ([] c:a; b:a):1}\n", "([] c:a; b:a)", "assigned"),
        (
            "g:{[a] select c:a, d:(e:a) from ([]b:1 2)}\n",
            "select c:a, d:(e:a) from ([]b:1 2)",
            "assigns",
        ),
        (
            "g:{[a;t] select c:a from t where b>d:1}\n",
            "select c:a from t where b>d:1",
            "assigns",
        ),
        ("g:{[a] $[a;b:1;2]}\n", "$[a;b:1;2]", "assigns"),
        ("g:{[a] `select c:a}\n", "`select c:a", "assigns"),
        (
            "g:{[a;b;c;d;e;f;h;i] a+b+c+d+e+f+h+i}\n",
            "a+b+c+d+e+f+h+i",
            "",
        ),
    ] {
        match apply(source, selected) {
            Ok(got) if why.is_empty() => {
                // Eight is q's limit, and allowed.
                assert!(got.starts_with("extracted:{[a;b;c;d;e;f;h;i]"), "{got}");
            }
            Ok(got) => panic!("{source:?} / {selected:?} rewritten: {got:?}"),
            Err(e) => assert!(e.contains(why), "{source:?} / {selected:?}: {e}"),
        }
    }
    let e = apply_nth("g:{[a;f] f'[a]}\n", "f", 1).unwrap_err();
    assert!(e.contains("modified or assigned"), "{e}");
    let e = apply_nth("g:{[d] d[`a]:1; d}\n", "d", 1).unwrap_err();
    assert!(e.contains("assigned"), "{e}");
    // An assignment through an operator, or after a blank (#2792).
    for (source, selected, nth) in [
        ("g:{[t] t[`x],:1; t}\n", "t[`x]", 0),
        ("g:{[t] t[`x]+:1; t}\n", "t[`x]", 0),
        ("g:{[t] t[`x] :5; t}\n", "t[`x]", 0),
        ("g:{[t] t[`x] ,:5; t}\n", "t[`x]", 0),
        ("g:{[t] t[`x] ::5; t}\n", "t[`x]", 0),
        ("g:{v[0] :9; v}\n", "v[0]", 0),
        ("g:{[t] t[`x],:1; t}\n", "t", 1),
        ("g:{[t] t [`x] -:1; t}\n", "t", 1),
        ("g:{[a;b] b:2; b _:1; a}\n", "b", 2),
        ("g:{[a;b] b:2; b -:1; a}\n", "b", 2),
    ] {
        let e = apply_nth(source, selected, nth).unwrap_err();
        assert!(e.contains("assigned"), "{source:?} / {selected:?}: {e}");
    }
    let nine = "g:{[a;b;c;d;e;f;h;i] k:1; a+b+c+d+e+f+h+i+k}\n";
    let e = apply(nine, "a+b+c+d+e+f+h+i+k").unwrap_err();
    assert!(e.contains("at most 8"), "{e}");
}

#[test]
fn the_definition_goes_above_the_statement_under_its_own_context() {
    // Mid-file, after other statements and a comment.
    let source = "/ lib\na:1\n\\d .x\nh:{[p]\n  p*p+1}\n\\d .\n";
    let got = apply(source, "p*p+1").unwrap();
    assert_eq!(
        got,
        "/ lib\na:1\n\\d .x\nextracted:{[p] p*p+1}\nh:{[p]\n  extracted[p]}\n\\d .\n"
    );
    // The second occurrence: inside the second function.
    let source = "f:{[a] a+1}\ng:{[a] a+1}\n";
    let got = apply_nth(source, "a+1", 1).unwrap();
    assert_eq!(
        got,
        "f:{[a] a+1}\nextracted:{[a] a+1}\ng:{[a] extracted[a]}\n"
    );
}

/// The new definition ends its line as the file ends its own: a CRLF file
/// is left with no bare LF (#2794).
#[test]
fn the_definition_ends_its_line_as_the_file_does() {
    let got = apply("a:1\r\nf:{[a;b] 1+a*b}\r\n", "a*b").unwrap();
    assert_eq!(
        got,
        "a:1\r\nextracted:{[a;b] a*b}\r\nf:{[a;b] 1+extracted[a;b]}\r\n"
    );
    let got = apply("a:1\nf:{[a;b] 1+a*b}\n", "a*b").unwrap();
    assert_eq!(
        got,
        "a:1\nextracted:{[a;b] a*b}\nf:{[a;b] 1+extracted[a;b]}\n"
    );
}
