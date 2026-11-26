use q_lint_rs::{Profile, Workspace, broken_statement, lint, lint_selecting};

/// The best of three runs of `run`, for the speed tests below that compare a
/// small input with a large one. They assert the ratio of the two, not a
/// duration: a duration measures the runner, and CI's are several times
/// slower than a Mac. One preempted run on a shared runner is enough to break
/// a ratio, so each side takes its fastest of three.
fn best_of_three<T>(run: impl Fn() -> T) -> std::time::Duration {
    (0..3)
        .map(|_| {
            let started = std::time::Instant::now();
            std::hint::black_box(run());
            started.elapsed()
        })
        .min()
        .unwrap()
}
#[test]
fn mutation_classes_and_valid_boundaries() {
    for (source, code) in [
        ("f:{[] `a`b!1 2 3}", "QT001"),
        ("f:{[r] r+1};f[`bad]", "QT002"),
        ("f:{[a] g:{[b] a+b};g[1]}", "QF005"),
        ("{[a;b]a+b}[1;2;3]", "QA002"),
    ] {
        assert!(
            lint(source, "t.q", Profile::Style)
                .iter()
                .any(|f| f.code == code)
        );
    }
    for source in [
        "f:{[k;v] k!v}",
        "f:{[r] r+1};f[2]",
        "f:{[a] g:{[a;b] a+b};g[a;1]}",
        "{[a;b]a+b}[1;]",
    ] {
        assert!(lint(source, "t.q", Profile::Style).is_empty());
    }
}
#[test]
fn utf16_ranges_and_literal_masking() {
    let f = lint("s:\"😀\";f:{]", "t.q", Profile::Style);
    assert_eq!(f[0].column, Some(11));
    assert_eq!(f[0].code, "QE001");
    assert!(lint("s:\"{[desc]} / hi\"; / (]", "t.q", Profile::Style).is_empty());
}
#[test]
fn a_blanked_column_0_line_is_named_as_the_one_that_starts_a_statement() {
    // `views` blanks a whole `k)` line, but it is still the line q 5 refuses
    // the open brace at (#307).
    let f = lint("f:{[a]\nk)1\n  a+1}", "t.q", Profile::General);
    assert_eq!(f.len(), 1);
    assert!(f[0].detail.contains("before line 2"), "{}", f[0].detail);
}
#[test]
fn a_bracket_left_open_inside_another_is_reported_where_it_opens() {
    // q 5 refuses both with the closer it meets ('} and ']), which names no
    // line. A closer some bracket further out wants closes that one, so the
    // bracket it passes was never closed, and is named where it opens - the
    // call being typed, not the end of the lambda lines below (#866). A
    // closer nothing open wants is the mistake itself, and is named there.
    let f = lint("g:{[x]\n  a:f[1;\n  x}\n", "t.q", Profile::General);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!((f[0].line, f[0].column), (2, Some(6)));
    assert_eq!(
        f[0].detail,
        "Unclosed delimiter; expected ']' before the '}' on line 3"
    );
    let f = lint("g:{[x]\n  a:(1;2];\n  x}\n", "t.q", Profile::General);
    assert_eq!((f[0].line, f[0].column), (2, Some(9)));
    assert_eq!(f[0].detail, "Expected ')', got ']'");
    // The innermost of those passed, and the outer one closed: accepting
    // the finding leaves nothing more of that statement to report.
    let source = "g:{[x] (a; f[1; / noqa: QE001\n  }\nh:{[y] y}\n";
    assert!(
        !lint(source, "t.q", Profile::General)
            .iter()
            .any(|f| f.code == "QE001")
    );
    let f = lint("g:{[x] (a; f[1; }\n", "t.q", Profile::General);
    assert_eq!(f[0].column, Some(13));
}
#[test]
fn the_broken_statement_runs_from_the_line_that_starts_it_to_the_next() {
    let source = "a:1\ng:{[x]\n  f[1;\n  x}\n/ a note\nh:2\n";
    let span = broken_statement(source).unwrap();
    assert_eq!(&source[span], "g:{[x]\n  f[1;\n  x}\n/ a note\n");
    // A string nothing closes ends at the next line at column 0, and with
    // none, at the end of the file.
    let source = "a:1\ns:\"abc\n  def\nt:2\n";
    assert_eq!(
        &source[broken_statement(source).unwrap()],
        "s:\"abc\n  def\n"
    );
    let source = "a:1\nf:{[x]\n  x";
    assert_eq!(&source[broken_statement(source).unwrap()], "f:{[x]\n  x");
    assert_eq!(broken_statement("a:1\nf:{x}\n"), None);
}
#[test]
fn a_multi_byte_blank_before_an_assigned_name_does_not_panic() {
    // A no-break space pasted from a web page: q 5 refuses it with 'char,
    // and QT028 once sliced into the middle of it (#321), QT021 between
    // `ss` and its bracket (#731).
    for source in [
        "select from t where\u{a0}f:1",
        "select from t where a=1,\u{a0}b:2",
        "r:ss\u{a0}[\"abc\";\"b\"]",
        "r:ss\u{3000}[\"abc\";\"b\"]",
        "r:ss\u{2028}[\"abc\";\"b\"]",
    ] {
        lint(source, "t.q", Profile::General);
    }
}
#[test]
fn a_no_break_space_before_a_tables_colon_does_not_panic() {
    // `only_end + 1` was the middle of the two-byte space, where
    // `past_blanks` sliced: exit 101 and every other file's findings lost
    // (#2864). The second is the fuzz case it was minimised from.
    for source in [
        "t\u{a0}:([] a:1 2 3)\nr:select from t where a>1\n",
        "t\u{a0}:([])select from t where",
        "t\u{3000}:([] c:\"ab\")\nr:select from t where c=\"a\"\n",
    ] {
        let found = lint(source, "t.q", Profile::General);
        assert!(found.iter().any(|f| f.code == "QE012"), "{source:?}");
    }
}
#[test]
fn a_typed_slot_that_swallows_the_closing_brace_does_not_panic() {
    // A brace auto-closed after `{[a:` is typed: q 5 refuses it with '} (#732).
    let f = lint("f:{[a:}]", "t.q", Profile::General);
    assert!(f.iter().any(|f| f.code == "QE001"), "{f:?}");
}
#[test]
fn arbitrary_text_does_not_panic() {
    let chars = [
        'a', '1', 'é', '😀', ' ', '\n', '\r', '\t', '/', '\\', '\"', '\'', ':', ';', '(', ')', '[',
        ']', '{', '}', '`',
    ];
    let mut state = 13u64;
    for _ in 0..2000 {
        let mut s = String::new();
        for _ in 0..80 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            s.push(chars[(state >> 32) as usize % chars.len()]);
        }
        assert!(
            std::panic::catch_unwind(|| lint(&s, "t.q", Profile::Uqf)).is_ok(),
            "Input: {s:?}"
        );
    }
}

#[test]
fn language_prefixes_preserve_following_q_diagnostics() {
    for prefix in ["p)", "k)"] {
        let foreign = format!("{prefix}def f():\n\n    \"\"\"😀 {{[desc] . ()\\q\n    /\n\n");
        assert!(lint(&foreign, "t.q", Profile::Uqf).is_empty());
        let findings = lint(&format!("{foreign}q)f:{{]\n"), "t.q", Profile::Style);
        assert_eq!(
            (&*findings[0].code, findings[0].line, findings[0].column),
            ("QE001", 6, Some(6))
        );
        let findings = lint(
            &format!("{foreign}f:{{[desc] desc}}\n"),
            "t.q",
            Profile::Style,
        );
        assert_eq!((&*findings[0].code, findings[0].line), ("QF001", 6));
    }
    assert!(lint("q)/ bad )\nx:1\n", "t.q", Profile::Style).is_empty());
    // Any `x)` line is handed to `.x.e`, which may be defined in another
    // file - fusionx's tests define `.t.e` in the harness that loads them.
    // Without one q raises '.a.e, a missing definition rather than an
    // unbalanced delimiter, so the line is another language's, not q's.
    assert!(lint("a)x:1\n", "t.q", Profile::Style).is_empty());
}

#[test]
fn a_bare_slash_after_a_foreign_line_opens_a_block_comment() {
    // #2042. q 5 hands `t)c`, `/`, `  zz`, `\`, `show 1` to `.t.e` as `c`
    // alone: the bare `/` opens a block comment, the `\` closes it, and q
    // runs on. Read as part of the foreign statement, the `\` ended the
    // script and the unclosed paren after it went unreported.
    for prefix in ["p)", "k)"] {
        let text = format!("fk:1\n{prefix}gk:2\n/\n zz\n\\\nshow fk\nx:(1;2\n");
        let findings = lint(&text, "t.q", Profile::Style);
        assert!(
            findings.iter().any(|f| f.code == "QE001" && f.line == 7),
            "{prefix}: {findings:?}"
        );
    }
    // A `/ note` line is still carried over, as q carries it.
    assert!(lint("k)gk:2\n/ note\n  (\n", "t.q", Profile::Style).is_empty());
}

/// The cases here were settled by running each one through a real q 4.x and
/// asking it what the lambda's parameters actually are (`value value`), not by
/// reading the reference manual. q accepts more in a parameter list than one
/// would guess - `.q.z` is a legal parameter name, `{[a;b;] ...}` takes three
/// arguments - and reads the brackets as body text rather than a signature
/// whenever a slot is neither a name nor, in q 5, a pattern, which is the
/// trap QF007 exists for. q 5 has no such reading: what is no name or
/// pattern there it refuses where the lambda is defined.
#[test]
fn parameter_lists_agree_with_q() {
    // q reports the declared names: these are signatures.
    for source in [
        "f:{[a] a+1}",
        "f:{[a;b] a+b}",
        "f:{[] 42}",
        "f:{[a]x+1}",
        "f:{[ a ; b ] a}",
        "f:{[a_b] a_b+1}",
        "f:{[.q.z] 1}",
        "f:{[a;b;c;d;e;f;g;h] a}",
        "f:{x+1}",
        // q 5 patterns bind as parameters, and a literal fails only a call
        // that does not match it (#298): `{[1] 5} 1` is 5.
        "f:{[1] x+1}",
        "f:{[`s] x+1}",
        "f:{[1;2] x}",
        "f:{[a;1] x}",
        "f:{[\"s\"] 1}",
        "f:{[(a;b);c] a+b+c}",
        "f:{[([k;v])] k+v}",
        "f:{[([]a;b:c)] a}",
        // A typed slot takes any function or type after the colon (#437).
        "f:{[a:1] a}",
        "f:{[a:neg;b] a}",
        "f:{[a:{x+1};b] a}",
        // A name applied is one parameter binding no name (q 5, #484).
        "f:{[a b] a}",
        "f:{[f x] 1}",
        "f:{[a[0]] a}",
        "f:{[(a b)] 1}",
    ] {
        let found = lint(source, "t.q", Profile::Style);
        assert!(
            !found.iter().any(|f| f.code == "QF007"),
            "{source:?} is a parameter list to q: {found:?}"
        );
    }
    // q 5 refuses the source - and the message says how.
    for (source, claim) in [
        ("f:{[tables[]] x+1}", "'nyi"),
        ("f:{[a+b] 1}", "'nyi"),
        ("f:{[a-b] x}", "'nyi"),
        ("f:{[count x] 1}", "'nyi"),
        ("f:{[1 a] 1}", "'nyi"),
        ("f:{[a'] 1}", "'nyi"),
    ] {
        let found = lint(source, "t.q", Profile::Style);
        assert!(
            found
                .iter()
                .any(|f| f.code == "QF007" && f.detail.contains(claim)),
            "{source:?} is not a parameter list to q, and q says {claim}: {found:?}"
        );
    }
}

#[test]
fn parameter_rules_for_lists_q_does_accept() {
    for (source, code) in [
        ("f:{[_] x+1}", "QF002"), // `_` is the drop operator, never a parameter
        ("f:{[a;a] a}", "QF008"), // rank 2, and applying it projects
        ("f:{[a;b;a] a}", "QF008"),
        ("f:{[a;b;] a}", "QF009"), // q names the third parameter `2`
        ("f:{[;a] a}", "QF009"),
        ("f:{[a] x+1}", "QF010"), // 'x at runtime: x is a global here
        ("f:{[a] z*2}", "QF010"),
    ] {
        assert!(
            lint(source, "t.q", Profile::Style)
                .iter()
                .any(|f| f.code == code),
            "{source:?} should raise {code}"
        );
    }
    // A signature that declares nothing is the one empty slot that is real,
    // and an implicit-argument lambda has no signature to contradict.
    for source in [
        "f:{[] 42}",
        "f:{x+1}",
        "f:{[a] a+1}",
        "f:{[x] x+1}",
        "x:1;f:{[a] x+1}",         // x is a global that exists
        "f:{[t] select x from t}", // x is a column, not an argument
    ] {
        let found = lint(source, "t.q", Profile::Style);
        assert!(
            !found
                .iter()
                .any(|f| matches!(&*f.code, "QF008" | "QF009" | "QF010")),
            "{source:?} should be clean: {found:?}"
        );
    }
}

/// QF008 names each repeated parameter as the other rules name a name, not
/// as a Rust list (#2694).
#[test]
fn a_repeated_parameter_is_named_in_backticks() {
    let found = lint("f:{[a;b;a;b] a+b}", "t.q", Profile::Style);
    let f = found.iter().find(|f| f.code == "QF008").unwrap();
    assert_eq!(f.detail, "Parameter `a`, `b` is declared more than once");
}

/// QF016 says nothing of a slot q refuses with '_, which QF002 reports: the
/// name inside it is not a parameter (#2695).
#[test]
fn an_underscore_slot_is_no_unread_parameter() {
    let found = lint("f:{[ _a;b] b}", "t.q", Profile::Style);
    assert!(found.iter().any(|f| f.code == "QF002"), "{found:?}");
    assert!(!found.iter().any(|f| f.code == "QF016"), "{found:?}");
}

/// Windows checks files out with CRLF by default, so a rule that is blind to
/// `\r` reports one thing on the maintainer's machine and another on a user's.
/// The showcase is the widest q this repository has, which makes it the best
/// single input to hold both line endings to the same answer.
#[test]
fn line_endings_do_not_change_the_findings() {
    let lf = include_str!("../examples/showcase.q");
    let crlf = lf.replace('\n', "\r\n");
    for profile in [Profile::Style, Profile::Uqf] {
        let a: Vec<_> = lint(lf, "t.q", profile)
            .into_iter()
            .map(|f| (f.line, f.code))
            .collect();
        let b: Vec<_> = lint(&crlf, "t.q", profile)
            .into_iter()
            .map(|f| (f.line, f.code))
            .collect();
        assert_eq!(a, b, "CRLF changed the findings ({profile:?})");
    }
}

/// A BOM is reported without stopping the rest of the analysis: the author of
/// a file q will not load still wants to know what else is wrong with it.
#[test]
fn a_byte_order_mark_is_reported_and_analysis_continues() {
    let plain = "f:{[a] a+`x}\n";
    let with_bom = format!("\u{feff}{plain}");
    let codes = |s: &str| -> Vec<String> {
        lint(s, "t.q", Profile::General)
            .into_iter()
            .map(|f| f.code)
            .collect()
    };
    assert_eq!(codes(plain), ["QT003"]);
    assert_eq!(codes(&with_bom), ["QE005", "QT003"]);
}

/// Lint time should follow the size of the file, not its square.
///
/// The work per lambda was once linear in the number of lambdas - three
/// separate scans over every scope - so a file of a few thousand cost seconds
/// on every keystroke. This does not assert a duration, which would be a
/// flaky test on shared hardware; it asserts the shape, by requiring that
/// four times the input costs well under sixteen times the time.
#[test]
fn scope_analysis_does_not_scale_quadratically() {
    let build = |n: usize| {
        (0..n)
            .map(|i| format!("f{i}:{{[a;b] a+b}}\n"))
            .collect::<String>()
    };
    // The best of five runs: a single run on a shared CI runner is tens of
    // milliseconds, where one preemption is enough to push the ratio past the
    // threshold (6.5x and 8.2x on the v0.14.12 release run, 3x locally).
    let time = |source: &str| {
        (0..5)
            .map(|_| {
                let start = std::time::Instant::now();
                std::hint::black_box(lint(source, "t.q", Profile::Uqf));
                start.elapsed().as_secs_f64()
            })
            .fold(f64::INFINITY, f64::min)
    };
    // Four times the input. Measured on the scan-per-scope version this was
    // 10.5x, and on the indexed one 2.7x, so the threshold sits between with
    // room on both sides rather than being a stopwatch on shared hardware.
    let (small, large) = (build(4_000), build(16_000));
    time(&small); // warm the allocator and the regex caches
    let (a, b) = (time(&small), time(&large));
    assert!(
        b < a * 6.0,
        "4x the lambdas cost {:.1}x the time ({a:.4}s -> {b:.4}s); \
         that is the quadratic shape coming back",
        b / a
    );
}

/// The functions `semantic_tokens` colours in `text`, as the names it spans.
fn functions(text: &str) -> Vec<&str> {
    q_lint_rs::semantic_tokens(text)
        .into_iter()
        .filter(|t| t.2 == q_lint_rs::TokenKind::Function)
        .map(|(at, len, _)| &text[at..at + len])
        .collect()
}

#[test]
fn a_column_named_like_a_function_does_not_uncolour_it() {
    // q 5: after `t:([] f:1 2)` or a qSQL alias `f:`, `f 1` is still 2 and
    // `type f` 100h - a column assigns nothing (#365).
    assert_eq!(functions("f:{x+1}\nr:f 1\nt:([] f:1 2)\n"), ["f"]);
    assert_eq!(
        functions("f:{x+1}\nr:f 1\nu:select f:2*a from ([]a:1 2)\n"),
        ["f"]
    );
}

#[test]
fn a_name_in_a_query_phrase_is_not_coloured() {
    // q 5: after `t:([] f:1 2)`, `select f from t` and `exec f from t` read
    // the column, not the lambda `f` (#552). The table is still read.
    assert!(functions("f:{x}\nt:([] f:1 2)\nselect f from t\n").is_empty());
    assert!(functions("f:{x}\nt:([] f:1 2)\nr:exec f from t where f>1\n").is_empty());
    assert_eq!(functions("f:{x}\nr:select from f 1\n"), ["f"]);
}

/// The parameters `semantic_tokens` colours in `text`, by where they start.
fn parameters(text: &str) -> Vec<usize> {
    q_lint_rs::semantic_tokens(text)
        .into_iter()
        .filter(|t| t.2 == q_lint_rs::TokenKind::Parameter)
        .map(|(at, _, _)| at)
        .collect()
}

#[test]
fn a_column_named_like_a_parameter_is_not_coloured_as_one() {
    // KDB-X: in `{[a] update a:a+1 from t}` and `{[n] select n from t}` the
    // names are t's columns, and `([]a:1 2)` names a column (#1242).
    assert!(parameters("f:{[a] ([]a:1 2)}\n").is_empty());
    assert!(parameters("f:{[a] update a:1 from t}\n").is_empty());
    assert!(parameters("f:{[n] select n from t}\n").is_empty());
    // The column's value, and the table a query reads, are the parameter.
    assert_eq!(parameters("f:{[a] ([]b:a)}\n"), [12]);
    assert_eq!(parameters("f:{[t] select from t}\n"), [19]);
}

#[test]
fn a_root_name_and_a_dotted_name_are_not_the_same_function() {
    // KDB-X: after `f:{x}`, `.f` is undefined, and after `.g:{x+1}`, `g 1`
    // is 'g (#1243).
    assert!(functions("f:{x}\nh:{.f}\n").is_empty());
    assert!(functions(".g:{x+1}\nr:g 1\n").is_empty());
    assert_eq!(functions("f:{x}\nh:{f 1}\n"), ["f"]);
    assert_eq!(functions(".g:{x+1}\nr:.g 1\n"), [".g"]);
}

#[test]
fn a_system_commands_argument_is_not_coloured() {
    // `\l f/a.q` loads a file under the directory `f` (#553); `\t` and
    // `\ts` run theirs as q.
    assert!(functions("f:{x}\n\\l f/a.q\n").is_empty());
    assert!(functions("f:{x}\nq)\\l f/a.q\n").is_empty());
    assert_eq!(functions("f:{x}\n\\t f 1\n"), ["f"]);
}

#[test]
fn a_projection_is_coloured_as_a_function() {
    // q 5: `p:{[a;b] a+b}[1;]` is type 104h, and `p 2` is 3 (#367).
    assert_eq!(functions("p:{[a;b] a+b}[1;]\nr:p 2\n"), ["p"]);
    // So is one given fewer arguments than it takes, in brackets or by
    // juxtaposition: q 5 types each of these 104h (#551).
    assert_eq!(functions("p:{[a;b] a+b}[1]\nr:p 2\n"), ["p"]);
    assert_eq!(functions("q:{[a;b;c] a+b+c}[1;2]\nr:q 3\n"), ["q"]);
    assert_eq!(functions("r:{x+y} 1\nw:r 2\n"), ["r"]);
    assert_eq!(functions("r:{x+y} \"ab\"\nw:r 2\n"), ["r"]);
    // Given all of them, or one to a lambda of one, it is applied: q 5's
    // `{x} 1` is -7h.
    assert!(functions("p:{[a;b] a+b}[1;2]\nr:p 2\n").is_empty());
    assert!(functions("v:{x} 1\nr:v 2\n").is_empty());
    // `each` is applied, not given to the lambda.
    assert!(functions("v:{x+y} each 1\nr:v 2\n").is_empty());
}

#[test]
fn a_lambda_applied_to_empty_brackets_is_not_a_function() {
    // KDB-X: `{[] 42}[]`, `{[a] 7}[]` and `{x}[]` apply the lambda, and the
    // name holds what it returns: -7h, -7h and `::` (#2309). A lambda that
    // takes two is projected: `{x+y}[]` is 104h.
    assert!(functions("c:{[] 42}[]\nd:{[a] 7}[]\ne:{x}[]\nr:(c;d;e)\n").is_empty());
    assert_eq!(functions("h:{x+y}[]\nr:h 1\n"), ["h"]);
}

#[test]
fn a_name_is_coloured_by_the_value_q_holds_it_as() {
    // KDB-X: `a:b:{x+1}` makes both 100h (#2310).
    assert_eq!(functions("a:b:{x+1}\nm:a 1\n"), ["a"]);
    // So do set', a functional amend, a multiple assignment and `set` in
    // brackets: each name below is 100h (#2315).
    assert_eq!(
        functions(
            "`n1`n2 set' (1;{x})\n.[`n3;();:;{x}]\n(n5;n6):(1;{x})\n.c.z:0\n\
             @[`.c;`n10;:;{x}]\nset[`n12;{x}]\nr:(n1;n2 1;n3 1;n5;n6 1;.c.n10 1;n12 1)\n"
        ),
        ["n2", "n3", "n6", ".c.n10", "n12"]
    );
    // An alias, a projection and a derived function: 100h, 104h, 104h and
    // 104h; all of `f`'s arguments given, it is applied (#2316).
    assert_eq!(
        functions("f:{[a;b] a+b}\np:f[;1]\nal:f\nce:count each\nup:upsert\nd:f[1;2]\nr:(p 1;al;ce 1;up;d)\n")
            .into_iter()
            .filter(|name| *name != "f")
            .collect::<Vec<_>>(),
        ["p", "al", "ce", "up"]
    );
    // The last write is what the name holds: -7h, then 100h (#2317).
    assert!(functions("f:{x}\nf:5\nr:f+1\n").is_empty());
    assert_eq!(functions("g:5\ng:{x}\nr:g 1\n"), ["g"]);
}

#[test]
fn a_name_with_a_segment_led_by_an_underscore_is_coloured() {
    // KDB-X: `-4!".x.__h 1"` reads `.x.__h` as one token, and `key `.x`
    // after these two lines is ``__h`_k (#2311).
    assert_eq!(
        functions(".x.__h:{x}\n.x._k:{x}\nq:(.x.__h 1;.x._k 2)\n"),
        [".x.__h", ".x._k"]
    );
}

#[test]
fn a_name_inside_a_file_symbol_is_not_coloured() {
    // KDB-X's `-4!` reads `` `:a `` and `` `:f `` as one symbol token each,
    // whatever function or parameter shares the name (#2313).
    let text = "f:{x}\nh:{[a] r:`:a; `:f 0: a}\n";
    assert!(functions(text).is_empty());
    assert_eq!(parameters(text), [text.rfind('a').unwrap()]);
}

#[test]
fn a_function_a_k_line_defines_or_calls_is_coloured() {
    // KDB-X: after `k)g:{[a] a+1}`, `type g` is 100h and `t:g 3` is 4; a
    // `k)` line calls q's `f` as q does (#2314).
    let text = "k)g:{[a] a+1}\nt:g 3\nf:{x+1}\nk)r:f 1\n";
    assert_eq!(functions(text), ["g", "f"]);
    let at: Vec<usize> = q_lint_rs::semantic_tokens(text)
        .iter()
        .map(|t| t.0)
        .collect();
    assert_eq!(at, [16, 32]);
    // The last write decides, a k one as any other.
    assert!(functions("k)g:{x}\ng:5\nr:g\n").is_empty());
}

#[test]
fn a_root_lambda_is_not_coloured_inside_a_context() {
    use q_lint_rs::{TokenKind, Workspace, index, semantic_tokens_in};
    // q 5: under `\\d .ns`, `m:f 2` is 'f - no fallback to the root `f`,
    // which the workspace, holding this file too, defines (#366).
    let text = "f:{x+1}\n\\d .ns\nm:f 2\n";
    let mut ws = Workspace::default();
    ws.add(&index(text));
    ws.add(&index("g:{x}\n"));
    assert!(
        !semantic_tokens_in(text, &ws, &Default::default())
            .iter()
            .any(|t| t.2 == TokenKind::Function)
    );
}

#[test]
fn a_function_of_the_context_a_file_is_loaded_in_is_coloured() {
    use q_lint_rs::graph::Placement;
    use q_lint_rs::{TokenKind, Workspace, index, semantic_tokens_in};
    // #2053. q 5 loads lib.q and b.q under `\d .aa`: `.aa.gg` calls
    // `.aa.fz`, so b.q's `fz` is a function where it is read before any
    // `\d` of its own, and not after `\d .bb`.
    let text = "gg:{fz x}\nhh:fz 2\n\\d .bb\nkk:fz 3\n";
    let mut ws = Workspace::default();
    ws.add(&index(".aa.fz:{x+1}\n"));
    let placement = Placement {
        contexts: [".aa".to_string()].into(),
        root: false,
    };
    let functions: Vec<usize> = semantic_tokens_in(text, &ws, &placement)
        .iter()
        .filter(|t| t.2 == TokenKind::Function)
        .map(|t| t.0)
        .collect();
    assert_eq!(functions, [4, 13]);
    assert!(
        !semantic_tokens_in(text, &ws, &Placement::default())
            .iter()
            .any(|t| t.2 == TokenKind::Function)
    );
}

#[test]
fn semantic_tokens_survive_a_half_typed_file() {
    // The language server asks for tokens on every keystroke, so it sees
    // every unbalanced state a file passes through on the way to being
    // written - and the scope pass once panicked on two unclosed lambdas.
    for text in [
        "f:{g:{",
        "f:{g:{x",
        "f:{[a] g:{[b] h:{",
        "f:{g:{x}",
        "f:{[a;b",
        "{{{",
        "}}}",
        "f:{\"",
        "f:{g:{\u{1F600}",
    ] {
        let _ = q_lint_rs::semantic_tokens(text);
    }
}

fn codes(findings: &[q_lint_rs::Finding]) -> Vec<&str> {
    findings.iter().map(|f| f.code.as_str()).collect()
}

#[test]
fn a_workspace_defines_names_for_the_files_around_it() {
    use q_lint_rs::{Workspace, index, lint, lint_in};
    let app = "n:cfg\n";
    assert!(codes(&lint(app, "app.q", Profile::Style)).contains(&"QF018"));
    let mut ws = Workspace::default();
    ws.add(&index("cfg:5\n"));
    ws.add(&index(app));
    assert!(!codes(&lint_in(app, "app.q", Profile::Style, &ws)).contains(&"QF018"));
}

#[test]
fn a_workspace_keys_root_and_dotted_names_apart() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5, with a.q's definitions loaded: `yy:xx` under `\d .ns` is 'xx, as
    // there is no root fallback, and a root `cfg` is 'cfg, as `.cfg` is
    // another name (#359).
    let a = "xx:1\n.cfg:2\n";
    let b = "\\d .ns\nyy:xx\n\\d .\ncfg\n";
    let mut ws = Workspace::default();
    ws.add(&index(a));
    ws.add(&index(b));
    let found: Vec<_> = lint_in(b, "b.q", Profile::Style, &ws)
        .into_iter()
        .filter(|f| f.code == "QF018")
        .map(|f| f.line)
        .collect();
    assert_eq!(found, [2, 4]);
}

#[test]
fn a_set_in_a_namespaced_lambda_defines_the_root_name_too() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: after a.q, `.ns.init[]` sets the root `lim` - a symbol resolves in
    // the `\d` of the call - and b.q's `r:lim` is 100 (#765).
    let a = "\\d .ns\ninit:{`lim set 100}\n\\d .\n";
    let b = "r:lim\n";
    let mut ws = Workspace::default();
    ws.add(&index(a));
    ws.add(&index(b));
    assert!(!codes(&lint_in(b, "b.q", Profile::Style, &ws)).contains(&"QF018"));
}

#[test]
fn a_later_system_d_on_the_line_switches_from_where_it_ends() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: `system "d .ns";system "d .";lim:1` leaves the root `lim`, and
    // `lim:1;system "d .ns";k:2` the root `lim` and `.ns.k` (#767).
    let a = "system \"d .ns\";system \"d .\";lim:1\nm:1;system \"d .ns\";k:2\n";
    let b = "r:lim\ns:m\nt:k\n";
    let mut ws = Workspace::default();
    ws.add(&index(a));
    ws.add(&index(b));
    let found: Vec<_> = lint_in(b, "b.q", Profile::Style, &ws)
        .into_iter()
        .filter(|f| f.code == "QF018")
        .map(|f| f.line)
        .collect();
    assert_eq!(found, [3]);
}

#[test]
fn a_foreign_keyword_another_workspace_file_defines_is_a_name() {
    use q_lint_rs::{Workspace, index, lint, lint_in};
    // q 5, with lib.q's definitions loaded: `(f 1b;f 0b)` is 10b (#372).
    let main = "f:{[a] $[a;true;false]}\n";
    assert!(codes(&lint(main, "main.q", Profile::General)).contains(&"QF015"));
    let mut ws = Workspace::default();
    ws.add(&index("true:1b\nfalse:0b\n"));
    ws.add(&index(main));
    assert!(!codes(&lint_in(main, "main.q", Profile::General, &ws)).contains(&"QF015"));
}

#[test]
fn a_foreign_keyword_is_looked_up_in_the_namespace_it_is_read_in() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: under `\d .ns`, `true` is `.ns.true`. lib.q defining it there
    // makes `.ns.f 1` return `yes; a root `true:1b` does not, and the call
    // is 'true (#520).
    let main = "\\d .ns\nf:{$[x;true;false]}\n\\d .\n";
    let found = |lib: &str| {
        let mut ws = Workspace::default();
        ws.add(&index(lib));
        ws.add(&index(main));
        codes(&lint_in(main, "use.q", Profile::General, &ws)).contains(&"QF015")
    };
    assert!(!found("\\d .ns\ntrue:`yes\nfalse:`no\n\\d .\n"));
    assert!(found("true:1b\nfalse:0b\n"));
}

#[test]
fn a_foreign_keyword_is_looked_up_where_the_file_is_loaded() {
    use q_lint_rs::{Workspace, graph::Placement, index, lint_in};
    // KDB-X 5: with lib.q's `.ns.true:0b` loaded, a loader's `\d .ns` /
    // `\l use.q` makes `true` in use.q `.ns.true`, and `.ns.g[]` is 2. The
    // fix to `1b` made it 1 (#2178). So for a read QF018 calls undefined.
    let main = "g:{$[true;1;2]}\nr:vv\n";
    let lib = ".ns.true:0b\n.ns.vv:5\n";
    let found = |placement: Option<Placement>| {
        let mut ws = Workspace::default();
        ws.add(&index(lib));
        ws.add(&index(main));
        if let Some(placement) = placement {
            ws.place(std::path::Path::new("use.q"), &placement);
        }
        let mut codes: Vec<String> = lint_in(main, "use.q", Profile::Style, &ws)
            .into_iter()
            .map(|f| f.code)
            .filter(|c| c == "QF015" || c == "QF018")
            .collect();
        codes.sort();
        codes
    };
    assert_eq!(found(None), ["QF015", "QF018"]);
    let in_ns = Placement {
        contexts: [".ns".to_string()].into(),
        root: false,
    };
    assert_eq!(found(Some(in_ns)), Vec::<String>::new());
    // Loaded in another context, the names are still undefined there.
    let elsewhere = Placement {
        contexts: [".other".to_string()].into(),
        root: false,
    };
    assert_eq!(found(Some(elsewhere)), ["QF015", "QF018"]);
}

#[test]
fn a_lambda_another_file_redefines_has_no_known_rank_in_a_lambda() {
    use q_lint_rs::{Workspace, index, lint, lint_in};
    // q 5, b.q then a.q loaded: `g[]` is 3, as a.q's `f:{x+y}` replaced
    // b.q's `f:{x}` before g ran. A top-level call straight after b.q's own
    // definition meets that one, and is 'rank (#521).
    let in_lambda = "f:{x}\ng:{f[1;2]}\nh:{f(1;2)}\n";
    let found = |src: &str, ws: &Workspace| {
        codes(&lint_in(src, "b.q", Profile::General, ws))
            .into_iter()
            .filter(|c| ["QA012", "QA008"].contains(c))
            .count()
    };
    assert_eq!(found(in_lambda, &Workspace::default()), 1);
    let mut ws = Workspace::default();
    ws.add(&index("f:{x+y}\n"));
    ws.add(&index(in_lambda));
    assert_eq!(found(in_lambda, &ws), 0);

    let top = "f:{x}\nf[1;2]\n";
    assert!(codes(&lint(top, "b.q", Profile::General)).contains(&"QA012"));
    let mut ws = Workspace::default();
    ws.add(&index("f:{x+y}\n"));
    ws.add(&index(top));
    assert!(codes(&lint_in(top, "b.q", Profile::General, &ws)).contains(&"QA012"));
}

#[test]
fn a_numeric_lambda_another_file_redefines_is_not_known_in_a_lambda() {
    use q_lint_rs::{Workspace, index, lint, lint_in};
    // q 5, b.q then a.q loaded: `g[]` is `a, since a.q's `f:{x}` ran last.
    // A top-level call straight after b.q's own `f` is 'type (#522).
    let src = "f:{x+1}\ng:{f[`a]}\n";
    assert!(codes(&lint(src, "b.q", Profile::General)).contains(&"QT002"));
    let mut ws = Workspace::default();
    ws.add(&index("f:{x}\n"));
    ws.add(&index(src));
    assert!(!codes(&lint_in(src, "b.q", Profile::General, &ws)).contains(&"QT002"));
    let top = "f:{x+1}\nr:f[`a]\n";
    let mut ws = Workspace::default();
    ws.add(&index("f:{x}\n"));
    ws.add(&index(top));
    assert!(codes(&lint_in(top, "b.q", Profile::General, &ws)).contains(&"QT002"));
}

#[test]
fn a_name_another_file_also_assigns_is_not_tracked_in_a_lambda() {
    use q_lint_rs::{Workspace, index, lint, lint_in};
    // Alone, a is the atom 1 and indexing it is 'type. With another file
    // assigning a too, which value a lambda's read meets depends on load
    // order; a top-level read after this file's own assignment meets that
    // one whatever was loaded first (q 5: 'type either way).
    let lambda = "a:1\nf:{a[0]}\n";
    assert!(codes(&lint(lambda, "a.q", Profile::General)).contains(&"QT022"));
    let mut ws = Workspace::default();
    ws.add(&index(lambda));
    ws.add(&index("a:1 2 3\n"));
    assert!(!codes(&lint_in(lambda, "a.q", Profile::General, &ws)).contains(&"QT022"));

    let top = "a:1\nr:a[0]\n";
    let mut ws = Workspace::default();
    ws.add(&index(top));
    ws.add(&index("a:1 2 3\n"));
    assert!(codes(&lint_in(top, "a.q", Profile::General, &ws)).contains(&"QT022"));
}

#[test]
fn a_call_to_another_files_lambda_may_reassign_a_top_level_name() {
    use q_lint_rs::{Workspace, index, lint, lint_in};
    // q 5, lib.q then use.q loaded: `r` is 2 4 6 and the insert appends,
    // since lib.q's `init` replaced `b` and `t` first (#523). Without the
    // call between, the read meets use.q's own `b`, and q 5 is 'length.
    let lib = "init:{b::1 2 3; t::([]a:1 2;b:3 4;c:5 6)}\n";
    let found = |src: &str| {
        let mut ws = Workspace::default();
        ws.add(&index(lib));
        ws.add(&index(src));
        codes(&lint_in(src, "use.q", Profile::General, &ws))
            .into_iter()
            .filter(|c| ["QT006", "QT027", "QT022"].contains(c))
            .count()
    };
    let calls = "a:1 2 3\nb:1 2\nt:([]a:1 2;b:3 4)\ninit[]\nr:a+b\n`t insert (7;8;9)\n";
    assert_eq!(codes(&lint(calls, "use.q", Profile::General)).len(), 2);
    assert_eq!(found(calls), 0);
    assert_eq!(found("a:1 2 3\nb:1 2\nr:a+b\ninit[]\n"), 1);
}

#[test]
fn a_name_defined_in_dot_q_is_not_an_unknown_column() {
    use q_lint_rs::{Workspace, index, lint, lint_in};
    // q 5: after `.q.bb:10 20`, `select bb from t` returns bb (#524).
    let query = "t:([]a:1 2)\nr:select bb from t\n";
    assert!(codes(&lint(query, "use.q", Profile::General)).contains(&"QF020"));
    let one = format!(".q.bb:10 20\n{query}");
    assert!(!codes(&lint(&one, "one.q", Profile::General)).contains(&"QF020"));
    let mut ws = Workspace::default();
    ws.add(&index(".q.bb:10 20\n"));
    ws.add(&index(query));
    assert!(!codes(&lint_in(query, "use.q", Profile::General, &ws)).contains(&"QF020"));
}

#[test]
fn an_enclosing_local_is_not_excused_by_another_files_global() {
    use q_lint_rs::{Workspace, index, lint_in};
    // The inner lambda reads its enclosing lambda's parameter, which q does
    // not let it see. A global `tab` in some other program in the same
    // repository would make the read silently wrong, not right.
    let source = "f:{[tab] {count tab} 1}\n";
    let mut ws = Workspace::default();
    ws.add(&index(source));
    ws.add(&index("tab:([]a:1 2)\n"));
    assert!(codes(&lint_in(source, "f.q", Profile::General, &ws)).contains(&"QF005"));
}

#[test]
fn loading_a_table_by_its_path_defines_it() {
    // q 5: `\l data/trades` of a splayed table sets `trades` (#534). A
    // script's name defines nothing.
    let index = q_lint_rs::index("\\l data/trades\n\\l lib/util.q\n\\d .a\n\\l px\n");
    assert!(index.defined.contains("trades") && index.defined.contains(".a.px"));
    assert!(!index.defined.contains("util") && !index.defined.contains("q"));
}

#[test]
fn system_d_switches_context_without_hiding_the_files_names() {
    // q 5 runs `system "d .a"`, `f:{x+1}`, `g:{f[`a]}`, and `.a.g[]` is
    // 'type, as with `\d .a`; `r:{zz}` there is 'zz (#535).
    for open in ["system \"d .a\"", "\\d .a"] {
        let src = format!("{open}\nf:{{x+1}}\ng:{{f[`a]}}\nr:{{zz}}\n");
        let general = lint(&src, "a.q", Profile::General);
        assert!(codes(&general).contains(&"QT002"), "{open}");
        let style = lint(&src, "a.q", Profile::Style);
        assert!(codes(&style).contains(&"QF018"), "{open}");
    }
}

#[test]
fn a_load_after_a_q_prompt_may_define_anything() {
    // q 5 loads `q)\l b.q`, and b.q's `zz:1` is then defined (#536).
    for load in ["\\l b.q", "q)\\l b.q"] {
        let style = lint(&format!("{load}\nr:zz\n"), "e.q", Profile::Style);
        assert!(!codes(&style).contains(&"QF018"), "{load}");
    }
}

#[test]
fn table_columns_and_qsql_assignments_define_no_global() {
    let index =
        q_lint_rs::index("t:([k:`a`b]handle:1 2)\nu:update c:1 from t\nclust.kmeans.update:{x}\n");
    assert!(index.defined.contains("t") && index.defined.contains("u"));
    assert!(!index.defined.contains("handle") && !index.defined.contains("c"));
    // A name that ends in a qSQL keyword is still a name.
    assert!(index.lambdas.contains("clust.kmeans.update"));
}

#[test]
fn system_d_and_a_commented_backslash_d_switch_the_namespace() {
    // q 5: each `f[1;2]` below is 'f - the definition went into the context
    // opened above it - not 'rank. `key `.b` after `system "d .b"` and
    // `k:{1}` is ``k, and `\d .c  / note` opens `.c` as `\d .c` does.
    for open in ["system \"d .foo\"", "system\"d .foo\";", "\\d .foo  / note"] {
        let source = format!("{open}\nf:{{[a] a}}\n\\d .\nf[1;2]\n");
        let found = lint(&source, "t.q", Profile::General);
        assert!(!codes(&found).contains(&"QA012"), "{open}: {found:?}");
    }
    // Inside the context the call is the same function, and the same 'rank;
    // and a `system` string that is not `d`, a computed one, or one in a
    // comment opens none.
    for source in [
        "system \"d .foo\"\nf:{[a] a}\nf[1;2]\n",
        "system \"l x.q\"\nf:{[a] a}\nf[1;2]\n",
        "system \"d \",ns\nf:{[a] a}\nf[1;2]\n",
        "/ system \"d .foo\"\nf:{[a] a}\nf[1;2]\n",
    ] {
        assert!(
            codes(&lint(source, "t.q", Profile::General)).contains(&"QA012"),
            "{source}"
        );
    }
}

/// q 5 refuses `` `guid$ `` and `` `symbol$ `` on a string with 'type, where the
/// other named casts convert char codes, so QT004 cannot say codes for them.
#[test]
fn a_cast_q_refuses_on_a_string_is_not_said_to_convert_codes() {
    let detail = |source: &str| {
        lint(source, "t.q", Profile::Style)
            .into_iter()
            .find(|f| matches!(f.code.as_str(), "QT004" | "QT032"))
            .map(|f| f.detail)
            .unwrap()
    };
    for source in [
        "g:`guid$\"0a369037-75d3-b24d-6721-5a1d44d4bed5\"",
        "s:`symbol$\"ab\"",
    ] {
        assert!(detail(source).contains("'type"), "{source}");
        assert!(!detail(source).contains("code"), "{source}");
    }
    assert!(detail("n:`long$\"12\"").contains("code"));
}

/// QA007 names what q 5 does when the slot it runs as the last test is a
/// literal no test may be: `$[0b;`a;`b;]` is 'type, `$[0b;1;2;]` is null.
#[test]
fn even_slot_conditional_says_type_or_null() {
    for (source, claim) in [
        ("r:{$[x;`a;`b;]}", "'type"),
        ("r:{$[x;1;\"ab\";]}", "'type"),
        ("r:{$[x;1;`a;2]}", "'type"),
        ("r:{$[x;1;2;]}", "null"),
        ("r:{$[x;1;y;2]}", "null"),
    ] {
        let found = lint(source, "t.q", Profile::Style);
        assert!(
            found
                .iter()
                .any(|f| f.code == "QA007" && f.detail.contains(claim)),
            "{source:?}: QA007 should say {claim}: {found:?}"
        );
    }
}

/// QB015 says what q 5 does: `([]c:"ab")` where c="ab" returns its rows, a
/// count that differs from the string's length is 'length, and a symbol or
/// string column is 'type even when the counts agree.
#[test]
fn string_equality_in_a_filter_names_the_row_count() {
    for (source, claim) in [
        (
            "r:select from t where sym=\"EUR\"",
            "'length unless the table has exactly 3 rows",
        ),
        (
            "r:select from t where sym=\"\"",
            "'length unless the table is empty",
        ),
        (
            "r:select from t where s<>\"ab\"",
            "'type even then on a symbol or string column",
        ),
    ] {
        let found = lint(source, "t.q", Profile::General);
        assert!(
            found
                .iter()
                .any(|f| f.code == "QB015" && f.detail.contains(claim)),
            "{source:?}: QB015 should say {claim}: {found:?}"
        );
    }
}

/// QV001 says more than "put it first" of a constraint with the column on the
/// right: q 5 narrows the partitions only for one that starts with the
/// column, and `where d=date, sym=s` measured slower than either order of
/// `date=d` (#2741).
#[test]
fn a_partition_constraint_read_from_the_right_is_told_to_turn_round() {
    for (source, advice) in [
        (
            "r:select from t where sym=`a, d=date",
            "write the constraint with `date` on the left and put it first",
        ),
        (
            "r:select from t where sym=`a, (date=d)",
            "put the `date` constraint first",
        ),
    ] {
        let found = lint(source, "t.q", Profile::Style);
        assert!(
            found
                .iter()
                .any(|f| f.code == "QV001" && f.detail.ends_with(advice)),
            "{source:?}: QV001 should end {advice}: {found:?}"
        );
    }
}

/// QR001 does not call the two the same outright: both sorts are stable,
/// so with d:`a`b`c!1 1 2 q 5 gives `c`b`a for `key reverse asc d` and
/// `c`a`b for `key desc d`, and 0b for `(reverse desc d)~asc d` (#2739).
#[test]
fn reverse_of_a_sort_is_the_other_sort_only_up_to_ties() {
    for (source, claim) in [
        (
            "r:reverse asc d",
            "`reverse asc` is `desc`, in one pass; on",
        ),
        (
            "r:reverse desc d",
            "`reverse desc` is `asc`, in one pass; on",
        ),
        (
            "r:reverse asc d",
            "differ in the order of keys whose values tie",
        ),
    ] {
        let found = lint(source, "t.q", Profile::Style);
        assert!(
            found
                .iter()
                .any(|f| f.code == "QR001" && f.detail.contains(claim)),
            "{source:?}: QR001 should say {claim}: {found:?}"
        );
    }
}

/// QE009 names the iterator the way q 5's error does, whole: `b:,/:a` is
/// '/:, `-':a` is ':, `f\:a` is '\:, and `{+/x}` is '/.
#[test]
fn juxtaposed_derived_names_the_whole_iterator() {
    for (source, claim) in [
        ("b:,/:a", "('/:)"),
        ("c:-':a", "('':)"),
        ("d:f\\:a", "('\\:)"),
        ("e:{+/x}", "('/)"),
        ("g:{count'x}", "('')"),
    ] {
        let found = lint(source, "t.q", Profile::General);
        assert!(
            found
                .iter()
                .any(|f| f.code == "QE009" && f.detail.contains(claim)),
            "{source:?}: QE009 should say {claim}: {found:?}"
        );
    }
}
#[test]
fn an_empty_nested_where_is_reported_on_the_nested_query_alone() {
    // #200: the outer select's where has `b in exec ...` in it.
    let columns: Vec<_> = lint(
        "a:select a from t where b in exec c from u where\n",
        "t.q",
        Profile::General,
    )
    .into_iter()
    .filter(|f| f.code == "QE007")
    .map(|f| f.column)
    .collect();
    assert_eq!(columns, vec![Some(30)]);
}
#[test]
fn a_later_vector_equality_is_reported_at_its_own_constraint() {
    // #215: `s=`a`b` is the second constraint, at column 27.
    let columns: Vec<_> = lint("q:select from t where a>1,s=`a`b\n", "t.q", Profile::Style)
        .into_iter()
        .filter(|f| f.code == "QB008")
        .map(|f| f.column)
        .collect();
    assert_eq!(columns, vec![Some(27)]);
}
#[test]
fn a_vector_comparison_names_the_row_count_that_runs() {
    // #499: q 5 runs `a<>1 2` on a two-row table, so the message cannot say
    // 'length outright, and it names the operator it found.
    let messages: Vec<_> = lint(
        "t:([]a:1 2)\nr:select from t where a<>1 2\ns:select from t where a=1 2 3\n",
        "t.q",
        Profile::Style,
    )
    .into_iter()
    .filter(|f| f.code == "QB008")
    .map(|f| f.detail)
    .collect();
    assert_eq!(messages.len(), 2);
    assert!(messages[0].contains("`<>` against a 2-item vector literal"));
    assert!(messages[0].contains("unless the table has exactly 2 rows"));
    assert!(messages[1].contains("`=` against a 3-item vector literal"));
}
#[test]
fn a_two_character_glyph_before_an_iterator_keyword_is_named_whole() {
    // #2772: `x <= each y` was reported at the `=`, with `x =' y` as the
    // rewrite - another comparison. q 5 runs `1 2<='2 3`.
    for glyph in ["<=", ">=", "<>"] {
        let source = format!("x:1 2;y:2 3\nr:x {glyph} each y\n");
        let found: Vec<_> = lint(&source, "t.q", Profile::General)
            .into_iter()
            .filter(|f| f.code == "QE011")
            .collect();
        assert_eq!(found.len(), 1, "{glyph}: {found:?}");
        assert_eq!((found[0].column, found[0].end_column), (Some(5), Some(7)));
        assert!(
            found[0].detail.contains(&format!("write `x {glyph}' y`")),
            "{}",
            found[0].detail
        );
    }
}
#[test]
fn an_indexed_integer_names_the_error_of_a_closed_handle() {
    // #507: q 5 `a:5; a[0]` is 'Cannot write to handle 5, not 'domain.
    let details: Vec<_> = lint("a:5\nr:a[0]\n", "t.q", Profile::General)
        .into_iter()
        .filter(|f| f.code == "QT022")
        .map(|f| f.detail)
        .collect();
    assert_eq!(details.len(), 1);
    assert!(details[0].contains("'Cannot write to handle"));
    assert!(!details[0].contains("'domain"));
}
#[test]
fn deeply_nested_lambdas_lint_in_bounded_time() {
    // #185: every rule that matched braces from each `{` was quadratic in
    // nesting depth. Generated or hostile input can nest thousands deep, and
    // the language server lints on every keystroke. A fixed bound at 4000
    // deep took 3 s here and over 10 s on a shared CI runner, so it failed
    // with no regression behind it: the ratio of two depths is what is asked.
    // Past q's own limit of 100, which QE001 reports alone (#717), so the
    // rules are run as they are with QE001 deselected.
    let time = |depth: usize| {
        let source = format!("f:{}{}\n", "{".repeat(depth), "}".repeat(depth));
        best_of_three(|| {
            lint_selecting(&source, "t.q", Profile::Style, &Workspace::default(), false);
        })
    };
    time(500); // warm the allocator and the regex caches
    let (small, large) = (time(500), time(4000));
    eprintln!("500 nested lambdas took {small:?} and 4000 {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 5.1 here (47 ms and
    // 240 ms). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "500 nested lambdas took {small:?} and 4000 {large:?}"
    );
}
/// Every finding is placed by its line, which was counted from the file's
/// start for each: a file of block comments, each a QP001 finding built and
/// dropped later, took time quadratic in their number (#706). About 1 s in a
/// debug build after the fix.
/// File-level `noqa` (0.31) asked whether each `/` line sat in a block
/// comment by walking every block, quadratic again in their number.
#[test]
fn many_findings_lint_in_bounded_time() {
    let time = |n: usize| {
        let source = "/\nsome text here {[ ( \"\n\\\n".repeat(n);
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(2500); // warm the allocator and the regex caches
    let (small, large) = (time(2500), time(20000));
    eprintln!("2500 block comments took {small:?} and 20000 {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 7.4 here (231 ms and
    // 1.71 s). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "2500 block comments took {small:?} and 20000 {large:?}"
    );
}
/// Each name read asked whether a lambda around it binds the name by walking
/// every `{` before it, so a file of one-line functions took time quadratic
/// in their number (#705).
#[test]
fn many_functions_lint_in_bounded_time() {
    // The ratio of two sizes, not a bound: a file this size is a few seconds
    // in a debug build on its own. Linear is 8 times the time for 8 times the
    // functions, and quadratic was 17.
    let time = |n: usize| {
        let source: String = (0..n)
            .map(|i| format!("f{i}:{{[x;y] g{i}:x+y; f{}[x;g{i}]}};\n", i.max(1) - 1))
            .collect();
        // The best of three, as in scope_analysis_does_not_scale_quadratically:
        // one preempted run on a shared runner (or under Rosetta, as the
        // x86_64-apple-darwin release leg is) is enough to break the ratio.
        (0..3)
            .map(|_| {
                let started = std::time::Instant::now();
                std::hint::black_box(lint(&source, "t.q", Profile::Style));
                started.elapsed()
            })
            .min()
            .unwrap()
    };
    time(2000); // warm the allocator and the regex caches
    let (small, large) = (time(2000), time(16000));
    assert!(
        large < small * 12,
        "2000 functions took {small:?} and 16000 took {large:?}"
    );
}
/// Each `,` of a where phrase asked whether it is in one by walking back to
/// the keyword past every condition before it, so a long where phrase took
/// time quadratic in its conditions (#707).
#[test]
fn a_long_where_phrase_lints_in_bounded_time() {
    // The ratio of two sizes, best of three, as for many_functions: linear is
    // 8 times the time for 8 times the conditions.
    let time = |n: usize| {
        let conditions: Vec<String> = (0..n).map(|i| format!("c{i}=x{i}")).collect();
        let source = format!("r:select from t where {}\n", conditions.join(","));
        (0..3)
            .map(|_| {
                let started = std::time::Instant::now();
                std::hint::black_box(lint(&source, "t.q", Profile::Style));
                started.elapsed()
            })
            .min()
            .unwrap()
    };
    time(4000); // warm the allocator and the regex caches
    let (small, large) = (time(4000), time(32000));
    eprintln!("4000 conditions took {small:?} and 32000 took {large:?}");
    // Quadratic is 64 times. Linear measures 7.7 here (15 ms and 117 ms on
    // Apple silicon), but the release build's Intel macOS runner, seven
    // times slower, measured 12.4 for the 0.20.0 code - unchanged from
    // 0.19.0 on this path - so 12 was a margin the hardware ate, not a
    // regression. 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "4000 conditions took {small:?} and 32000 took {large:?}"
    );
}
/// A long lambda body: each read was placed in the body's order by walking
/// from its start, each assignment found its lambda by walking back to it,
/// and each line read on to the lambda's end - each quadratic in the body's
/// length (#708).
#[test]
fn a_long_lambda_body_lints_in_bounded_time() {
    let time = |n: usize| {
        let body: String = (0..n).map(|i| format!("  a{i}:x+y*{i};\n")).collect();
        let source = format!("f:{{[x;y]\n{body}  a0}}\n");
        (0..3)
            .map(|_| {
                let started = std::time::Instant::now();
                std::hint::black_box(lint(&source, "t.q", Profile::Style));
                started.elapsed()
            })
            .min()
            .unwrap()
    };
    time(1000); // warm the allocator and the regex caches
    let (small, large) = (time(1000), time(8000));
    eprintln!("a 1000-line lambda took {small:?} and an 8000-line one {large:?}");
    // Quadratic is 64 times; linear is 8. A fixed 10 s bound on a 16000-line
    // lambda measured the runner, not the walk: CI's Linux and Windows
    // runners took 10.5 s for code whose debug build takes 2.8 s on Apple
    // silicon, and master was already within a few percent of the bound.
    // Linear measures 8.1 here (174 ms and 1.41 s). 16 still fails a quadratic walk by
    // four times, as the many-conditions test above does.
    assert!(
        large < small * 16,
        "a 1000-line lambda took {small:?} and an 8000-line one {large:?}"
    );
}
/// Chained qSQL keywords: each one scanned on to the statement's end, more
/// than once over, so a chain took time quadratic in its length (#709).
/// QV001 (0.31) did it again, reading each query's phrase to its end.
#[test]
fn chained_queries_lint_in_bounded_time() {
    let time = |n: usize| {
        let source = format!("r:{}t\n", "select from ".repeat(n));
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(1000); // warm the allocator and the regex caches
    let (small, large) = (time(1000), time(8000));
    eprintln!("1000 chained queries took {small:?} and 8000 {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 6.4 here (91 ms and
    // 583 ms). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "1000 chained queries took {small:?} and 8000 {large:?}"
    );
}
/// A long loop body: QV003 asked of each assignment whether a lambda opened
/// around it by reading from the body's start, and compiled two regexes for
/// it, so a body took time quadratic in its length - 18 s for this one in a
/// debug build, against 1.5 s for the same file without the rule.
#[test]
fn a_long_loop_body_lints_in_bounded_time() {
    let source = |n: usize| {
        let body: String = (0..n).map(|i| format!("  a{i}:a{i},1;\n")).collect();
        format!("do[3;\n{body}  ]\n")
    };
    let found = lint(&source(2000), "t.q", Profile::Uqf);
    assert_eq!(found.iter().filter(|f| f.code == "QV003").count(), 2000);
    let time = |n: usize| {
        let source = source(n);
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(2000); // warm the allocator and the regex caches
    let (small, large) = (time(2000), time(16000));
    eprintln!("a 2000-line loop body took {small:?} and a 16000-line one {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 6.3 here (268 ms and
    // 1.69 s). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "a 2000-line loop body took {small:?} and a 16000-line one {large:?}"
    );
}
/// Many where phrases on one line: each captured, and copied, the rest of
/// the line, so a line of statements took time quadratic in their number -
/// 25 s for 8000 in a release build (#1205).
#[test]
fn a_line_of_where_phrases_lints_in_bounded_time() {
    let time = |n: usize| {
        let source = format!("{}\n", vec!["select from t where c"; n].join(";"));
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(500); // warm the allocator and the regex caches
    let (small, large) = (time(500), time(4000));
    eprintln!("a line of 500 where phrases took {small:?} and of 4000 {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 6.5 here (82 ms and
    // 531 ms). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "a line of 500 where phrases took {small:?} and of 4000 {large:?}"
    );
}
/// The char-column comparison rule compiled a regex for each where phrase's
/// table and scanned the whole file with it, so a file of one-line queries
/// took time quadratic in their number - 15.6 s for 20000 in a release
/// build (#1206).
#[test]
fn many_where_phrases_lint_in_bounded_time() {
    let time = |n: usize| {
        let source: String = (0..n)
            .map(|i| format!("f{i}:{{update a:1 from t where b}}\n"))
            .collect();
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(500); // warm the allocator and the regex caches
    let (small, large) = (time(500), time(4000));
    eprintln!("500 where phrases took {small:?} and 4000 {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 7.3 here (192 ms and
    // 1.39 s). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "500 where phrases took {small:?} and 4000 {large:?}"
    );
}
/// Nested `$[`, `@[` and `.[`: each split its whole contents into slots, the
/// brackets nested in it included, so a deep nest was quadratic (#710). Past
/// q's limit of 100, so read as with QE001 deselected.
#[test]
fn nested_conditionals_lint_in_bounded_time() {
    for (open, close) in [("$[x;", ";0]"), ("@[f;", ";0]"), (".[f;", ";0]")] {
        let time = |depth: usize| {
            let source = format!("a:{}1{}\n", open.repeat(depth), close.repeat(depth));
            best_of_three(|| {
                lint_selecting(&source, "t.q", Profile::Style, &Workspace::default(), false);
            })
        };
        time(2000); // warm the allocator and the regex caches
        let (small, large) = (time(2000), time(16000));
        eprintln!("2000 nested {open} took {small:?} and 16000 {large:?}");
        // Quadratic is 64 times; linear is 8. Linear measures 5.9, 6.1 and 6.3
        // here for the three (66, 70 and 78 ms against 391, 426 and 488 ms).
        assert!(
            large < small * 16,
            "2000 nested {open} took {small:?} and 16000 {large:?}"
        );
    }
}
/// A wide table literal: each column counted its depth from the literal's
/// start (#469), was compared with every column before it for QB019, and
/// each number on the line looked back for the line's start (#711).
#[test]
fn a_wide_table_literal_lints_in_bounded_time() {
    let time = |n: usize| {
        let keys: Vec<String> = (0..n).map(|i| format!("k{i}:1 2")).collect();
        let columns: Vec<String> = (0..n).map(|i| format!("c{i}:3 4")).collect();
        let source = format!("t:([{}] {})\n", keys.join("; "), columns.join("; "));
        best_of_three(|| lint(&source, "t.q", Profile::Style))
    };
    time(2000); // warm the allocator and the regex caches
    let (small, large) = (time(2000), time(16000));
    eprintln!("2000 keys and columns each took {small:?} and 16000 {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 5.6 here (425 ms and
    // 2.38 s). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "2000 keys and columns each took {small:?} and 16000 {large:?}"
    );
}
/// One long vector literal: QE010 looked over the whole run for a number or
/// a date once for each of its items, so `a:1 1 1 ...` took time quadratic in
/// its length - 2.75 s for 40000 items in a release build (#2263).
#[test]
fn a_long_vector_literal_lints_in_bounded_time() {
    let time = |n: usize| {
        let source = format!("a:{}\n", vec!["1"; n].join(" "));
        best_of_three(|| lint(&source, "t.q", Profile::Style))
    };
    time(2000); // warm the allocator and the regex caches
    let (small, large) = (time(2000), time(16000));
    eprintln!("a vector of 2000 items took {small:?} and of 16000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "a vector of 2000 items took {small:?} and of 16000 {large:?}"
    );
}
/// Lambdas nested in each other's bodies: each scope copied its whole body,
/// and each implicit lambda's rank and each body's statements were read over
/// the lambdas nested in it, so time and memory were quadratic in the depth -
/// 4 GB for 32000 (#704). Past q's limit, so read as with QE001 deselected.
#[test]
fn nested_lambda_bodies_lint_in_bounded_time() {
    let time = |depth: usize| {
        let source = format!("a:{}1{}\n", "{x+".repeat(depth), "}".repeat(depth));
        best_of_three(|| {
            lint_selecting(&source, "t.q", Profile::Style, &Workspace::default(), false);
        })
    };
    time(2000); // warm the allocator and the regex caches
    let (small, large) = (time(2000), time(16000));
    eprintln!("2000 nested lambda bodies took {small:?} and 16000 {large:?}");
    // Quadratic is 64 times; linear is 8. Linear measures 7.3 here (227 ms and
    // 1.66 s). 16 still fails a quadratic walk by four times.
    assert!(
        large < small * 16,
        "2000 nested lambda bodies took {small:?} and 16000 {large:?}"
    );
}
/// Tens of thousands of nested parentheses - beyond q's own limit, which
/// refuses a hundred-odd levels with '( - once overflowed the stack, which
/// aborts the whole run and cannot be caught like a panic (#703).
#[test]
fn deeply_nested_parentheses_do_not_overflow_the_stack() {
    let depth = 10000;
    let (open, close) = ("(".repeat(depth), ")".repeat(depth));
    for source in [
        format!("a:{open}1{close}\n"),
        format!("r:til[{open}1{close}]\n"),
        format!("f:{{[{open}a{close}] a}}\n"),
        format!("d:`a`b!{open}1 2{close}\n"),
        format!("f:{{[{open}a{}] a}}\n", ";b)".repeat(depth)),
    ] {
        for profile in [Profile::General, Profile::Uqf] {
            // QE001 reports the depth alone (#717); deselected, every rule
            // still reads the file.
            assert!(
                lint(&source, "t.q", profile)
                    .iter()
                    .any(|f| f.code == "QE001")
            );
            lint_selecting(&source, "t.q", profile, &Workspace::default(), false);
        }
    }
}
/// q 5 holds at most a hundred brackets, braces and parentheses open at once,
/// of any kinds, and refuses the next with '( or '{ or '[ (#717).
#[test]
fn more_than_a_hundred_open_brackets_are_refused() {
    let deep =
        |n: usize, open: &str, close: &str| format!("a:{}1{}\n", open.repeat(n), close.repeat(n));
    for (source, refused) in [
        (deep(100, "(", ")"), false),
        (deep(101, "(", ")"), true),
        (deep(100, "{", "}"), false),
        (deep(101, "{", "}"), true),
        (deep(100, "f[", "]"), false),
        (deep(101, "f[", "]"), true),
        (deep(50, "({", "})"), false),
        (deep(51, "({", "})"), true),
        (deep(101, "$[x;", ";0]"), true),
    ] {
        let found: Vec<_> = lint(&source, "t.q", Profile::General)
            .into_iter()
            .filter(|f| f.code == "QE001")
            .collect();
        assert_eq!(found.len(), usize::from(refused), "{source}");
    }
}
#[test]
fn a_nested_lambda_after_a_sibling_is_scanned_once() {
    // #252: the second nested lambda was taken for a new outer body.
    let found = lint("f:{a:{x}; b:{count:1; x}; a}", "t.q", Profile::Style);
    assert_eq!(found.iter().filter(|f| f.code == "QF003").count(), 1);
}

/// A non-ASCII character right before a glyph: QE008 once sliced the two
/// bytes before the glyph and split the `é` (#234). q refuses the line with
/// 'char, so nothing need be reported, only nothing must panic.
#[test]
fn non_ascii_before_a_glyph_does_not_panic() {
    for source in ["r:`café-x\n", "é-x\n", "x:é+1\n"] {
        lint(source, "t.q", Profile::Uqf);
    }
}
/// A non-ASCII character in a select list: the qSQL tokenizer once took it
/// as a one-byte operator and sliced through the `€` (#235).
#[test]
fn non_ascii_in_a_select_list_does_not_panic() {
    for source in [
        "r:select a€ from t\n",
        "r:select €,b from t\n",
        "r:exec a+€ by b from t\n",
    ] {
        lint(source, "t.q", Profile::Uqf);
    }
}
/// A non-ASCII symbol at the end of a qSQL phrase: the where-phrase walk
/// asked `boundary` about every byte and it sliced through the `é` (#236).
#[test]
fn non_ascii_symbol_in_a_qsql_phrase_does_not_panic() {
    for source in [
        "r:select from t where c=`é\n",
        "r:select `é from t\n",
        "r:select from t where c in `é\n",
    ] {
        lint(source, "t.q", Profile::Uqf);
    }
}
/// A qSQL keyword as a parameter is refused when the lambda is parsed, not
/// when it is called: q 5 `parse "{[select] 1}"` is 'from, as are exec,
/// update and delete (#240). Any other builtin still fails only its calls.
#[test]
fn qsql_keyword_parameter_names_the_parse_error() {
    for source in [
        "f:{[select] 1}\n",
        "f:{[exec] 1}\n",
        "f:{[update] 1}\n",
        "f:{[count;delete] 1}\n",
    ] {
        let f = lint(source, "t.q", Profile::Style);
        let f = f.iter().find(|f| f.code == "QF001").unwrap();
        assert!(
            f.detail.contains("refuses to define this lambda ('from)"),
            "{source}: {}",
            f.detail
        );
    }
    let f = lint("f:{[count] 1}\n", "t.q", Profile::Style);
    assert!(
        f[0].detail.contains("refuses every call"),
        "{}",
        f[0].detail
    );
}
/// QB001 and QB002 report at the code they are about, not at column 1, and
/// QB002 quotes the pattern as it is written rather than with Rust escapes
/// (#243).
#[test]
fn self_comparison_and_like_report_at_the_token() {
    let f = lint(
        "t:([]a:1 2)\nx:1;  y:\"abc\" like \"a\\\\*b*é*\"\nr:select from t where a=a\n",
        "t.q",
        Profile::Style,
    );
    let like = f.iter().find(|f| f.code == "QB002").unwrap();
    assert_eq!((like.line, like.column), (2, Some(15)));
    assert_eq!(like.detail, "like \"a\\\\*b*é*\"");
    let same = f.iter().find(|f| f.code == "QB001").unwrap();
    assert_eq!((same.line, same.column), (3, Some(23)));
}

/// The BOM is no part of the first line as the masker reads it: a comment
/// or block comment that opens there is still one (#221).
#[test]
fn a_byte_order_mark_does_not_turn_a_first_line_comment_into_code() {
    let codes = |s: &str| -> Vec<String> {
        lint(s, "t.q", Profile::General)
            .into_iter()
            .map(|f| f.code)
            .collect()
    };
    assert_eq!(codes("\u{feff}/ uses x==y\na:1\n"), ["QE005"]);
    assert_eq!(codes("\u{feff}/\nprose x==y\n\\\na:1\n"), ["QE005"]);
    assert_eq!(codes("\u{feff}a:\"x\"; b:x==y\n"), ["QE005", "QE004"]);
}
/// QB015 names the row count q needs, which is the string's length in bytes:
/// `"éa"` is three, not two (#227).
#[test]
fn a_filter_string_is_counted_in_bytes() {
    let found = lint("r:select from t where s=\"éa\"\n", "t.q", Profile::Style);
    let qb015 = found.iter().find(|f| f.code == "QB015").expect("QB015");
    assert!(qb015.detail.contains("exactly 3 rows"), "{}", qb015.detail);
}
/// QE002 names the whole char after the backslash, though it is more than
/// one byte (#233).
#[test]
fn an_invalid_escape_names_a_non_ascii_char_whole() {
    let found = lint("a:\"x\\éy\"\n", "t.q", Profile::General);
    let qe002 = found.iter().find(|f| f.code == "QE002").expect("QE002");
    assert_eq!(qe002.detail, "Invalid escape \\é");
}

/// A typed slot binds its pattern's names: q 5 defines `{[a:`j] a}` and checks
/// the type at the call, so `a` is a parameter, not body text (#304). A slot
/// that is no pattern at all is still reported.
#[test]
fn a_typed_parameter_binds_its_name() {
    for source in [
        "f:{[a:`j] a}\n",
        "f:{[a:\"j\";b] a+b}\n",
        "f:{[(a;b):`j] a+b}\n",
    ] {
        let found = lint(source, "t.q", Profile::General);
        assert!(found.is_empty(), "{source}: {found:?}");
    }
    let found = lint("f:{[a+b] a}\n", "t.q", Profile::General);
    assert!(found.iter().any(|f| f.code == "QF007"), "{found:?}");
}

#[test]
fn a_k_line_in_another_file_defines_its_name() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: with x.q's `k)lim:100` loaded, `r:lim` is 100 (#751).
    let reader = "r:lim\n";
    let mut ws = Workspace::default();
    ws.add(&index(reader));
    assert!(codes(&lint_in(reader, "y.q", Profile::Style, &ws)).contains(&"QF018"));
    ws.add(&index("k)lim:100\n"));
    assert!(!codes(&lint_in(reader, "y.q", Profile::Style, &ws)).contains(&"QF018"));
}

#[test]
fn a_namespace_another_file_writes_whole_writes_its_members() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: a.q then b.q's `.cfg,:(enlist`n)!enlist 1 2 3`, and `f[]` is 1
    // (#746).
    let a = ".cfg.n:5\nf:{.cfg.n 0}\n";
    let mut ws = Workspace::default();
    ws.add(&index(a));
    assert!(codes(&lint_in(a, "a.q", Profile::General, &ws)).contains(&"QT022"));
    ws.add(&index(".cfg,:(enlist`n)!enlist 1 2 3\n"));
    assert!(!codes(&lint_in(a, "a.q", Profile::General, &ws)).contains(&"QT022"));
}

#[test]
fn a_table_another_file_changes_in_place_is_not_tracked_in_a_lambda() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: a.q, then b.q changing t in place, and `f[]` selects c and
    // `g[]` inserts the row (#756).
    let a = "t:([]a:1 2)\nf:{select c from t}\ng:{`t insert (3;4)}\n";
    let mut ws = Workspace::default();
    ws.add(&index(a));
    let alone = lint_in(a, "a.q", Profile::General, &ws);
    let alone = codes(&alone);
    assert!(
        alone.contains(&"QF020") && alone.contains(&"QT027"),
        "{alone:?}"
    );
    for b in [
        "update c:0 from `t\n",
        "@[`t;`c;:;0]\n",
        "![`t;();0b;(enlist`c)!enlist 0]\n",
    ] {
        let mut ws = Workspace::default();
        ws.add(&index(a));
        ws.add(&index(b));
        let found = lint_in(a, "a.q", Profile::General, &ws);
        let found = codes(&found);
        assert!(
            !found.contains(&"QF020") && !found.contains(&"QT027"),
            "{b}: {found:?}"
        );
    }
}

#[test]
fn a_table_another_file_keys_in_place_is_not_tracked_in_a_lambda() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: a.q, then b.q's `` `a xkey `k ``, and `f[([]a:1 2)]` joins (#757).
    let a = "k:([]a:1 2;b:3 4)\nf:{x lj k}\n";
    let mut ws = Workspace::default();
    ws.add(&index(a));
    assert!(codes(&lint_in(a, "a.q", Profile::General, &ws)).contains(&"QT026"));
    ws.add(&index("`a xkey `k\n"));
    assert!(!codes(&lint_in(a, "a.q", Profile::General, &ws)).contains(&"QT026"));
}

#[test]
fn a_global_another_file_amends_through_its_context_is_not_tracked_in_a_lambda() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: a.q, then b.q's amend, and `f[]` is 2 4 6 8 (#758).
    let a = "v:1 2 3\nf:{v+1 2 3 4}\n";
    let mut ws = Workspace::default();
    ws.add(&index(a));
    assert!(codes(&lint_in(a, "a.q", Profile::General, &ws)).contains(&"QT006"));
    for b in ["@[`.;`v;,;4]\n", ".[`.;enlist`v;,;4]\n"] {
        let mut ws = Workspace::default();
        ws.add(&index(a));
        ws.add(&index(b));
        assert!(
            !codes(&lint_in(a, "a.q", Profile::General, &ws)).contains(&"QT006"),
            "{b}"
        );
    }
}

#[test]
fn a_multiple_global_assignment_in_another_file_defines_its_names() {
    use q_lint_rs::{Workspace, index, lint_in};
    // q 5: after b.q's `init[]`, `lim` is 1; after c.q, `.ns.lim` is 1
    // (#759).
    for (reader, writer) in [
        ("r:lim\n", "init:{(lim;b)::1 2}\n"),
        ("\\d .ns\nr:lim\n", "(.ns.lim;.ns.b):1 2\n"),
    ] {
        let mut ws = Workspace::default();
        ws.add(&index(reader));
        assert!(codes(&lint_in(reader, "a.q", Profile::Style, &ws)).contains(&"QF018"));
        ws.add(&index(writer));
        assert!(
            !codes(&lint_in(reader, "a.q", Profile::Style, &ws)).contains(&"QF018"),
            "{writer}"
        );
    }
}
#[test]
fn a_builtin_assigned_in_a_namespace_is_refused_not_shadowed() {
    // q 5 refuses `count:42` under `\d .ns` with 'assign: nothing is
    // shadowed, and the file stops loading there (#677).
    let f = lint("\\d .ns\ncount:42\n\\d .\n", "t.q", Profile::General);
    assert_eq!(f.len(), 1);
    assert_eq!(
        (f[0].code.as_str(), f[0].severity.as_str()),
        ("QF004", "error")
    );
    assert!(f[0].detail.contains("'assign"), "{}", f[0].detail);
    assert!(!f[0].why.contains("shadow"), "{}", f[0].why);
}
#[test]
fn qf007_says_whether_q_refuses_the_definition_or_every_call() {
    // q 5 (KDB-X 2026.07.23): `{[a+b] 1}` is 'nyi where it is defined;
    // `{[a`b;x] x}` and `{[a`] 1}` are defined, and every call is 'type
    // (#2239).
    let detail = |source: &str| {
        lint(source, "t.q", Profile::General)
            .into_iter()
            .find(|f| f.code == "QF007")
            .map(|f| f.detail)
            .unwrap_or_default()
    };
    assert!(detail("m:{[a+b] 1}").ends_with("refuses the lambda where it is defined: 'nyi"));
    for source in ["f:{[a`b;x] x}", "n:{[a`] 1}"] {
        let d = detail(source);
        assert!(
            d.ends_with("defines the lambda but refuses every call with 'type"),
            "{d}"
        );
    }
}

#[test]
fn a_finding_is_an_error_exactly_when_q_refuses_the_code() {
    // The scope says whether q refuses the construct, so it decides the
    // severity: a hand-kept list of codes drifted from it (#512, #513).
    use q_lint_rs::{Finding, RULES};
    for rule in RULES.iter().filter(|r| r.scope != "qls") {
        let f = Finding::new("t.q", 1, &rule.code, String::new());
        let expected = if rule.scope == "builtin" {
            "error"
        } else {
            "warning"
        };
        assert_eq!(f.severity, expected, "{} ({})", rule.code, rule.scope);
    }
    let f = lint("a:\"abc\" like \"a*b*\"", "t.q", Profile::General);
    assert_eq!(
        (f[0].code.as_str(), f[0].severity.as_str()),
        ("QB002", "error")
    );
    let f = lint("a:`int$\"12\"", "t.q", Profile::Style);
    assert_eq!(
        (f[0].code.as_str(), f[0].severity.as_str()),
        ("QT004", "warning")
    );
}

#[test]
fn a_column_counts_utf16_code_units_as_the_readme_says() {
    // `==` is the 8th character and the 11th byte; the emoji before it is
    // two UTF-16 units, so the documented column is 9 (#804).
    let found = lint("s:\"\u{1F600}\";a==b\n", "t.q", Profile::General);
    let qe004 = found.iter().find(|f| f.code == "QE004").expect("QE004");
    assert_eq!(qe004.column, Some(9));
}

/// The lints from inferred types read every local of a lambda, and the QK
/// rules every bracket: one long lambda of typed locals, compared and
/// joined, and many parenthesised assignments, must cost time linear in
/// its length (the ratio of two sizes, as above).
#[test]
fn typed_locals_and_version_rules_lint_in_bounded_time() {
    let time = |n: usize| {
        // One long lambda (past the locals the type lints read) and many
        // short ones (each read).
        let body: String = (0..n)
            .map(|i| format!("s{i}:`a; n{i}:1 2; r{i}:s{i}=`b; q{i}:n{i},3 4; (a{i};b{i}):1 2;\n "))
            .collect();
        let short: String = (0..n)
            .map(|i| format!("g{i}:{{s:`a; n:1 2; r:s=`b; q:n,3 4; (a;b):1 2; r}}\n"))
            .collect();
        let source = format!("f:{{[x] {body} x}}\n{short}d:([a:1;b:2])\n");
        (0..3)
            .map(|_| {
                let started = std::time::Instant::now();
                std::hint::black_box(q_lint_rs::lint_every_rule(
                    &source,
                    "t.q",
                    &q_lint_rs::Workspace::default(),
                    true,
                ));
                started.elapsed()
            })
            .min()
            .unwrap()
    };
    time(500);
    let (small, large) = (time(500), time(4000));
    assert!(
        large < small * 12,
        "500 statements took {small:?} and 4000 took {large:?}"
    );
}
/// Accepting each of a file's findings where it is - `--add-noqa`, and an
/// editor's Select All asking for the code actions of every finding - masked
/// a copy of the whole file again for each, and so did the fix of each stale
/// `noqa` (QL003), which `--fix`, `--diff` and Format Document ask for:
/// quadratic in the findings, 22 s for 8000 in an editor (#2335).
#[test]
fn accepting_or_fixing_every_finding_is_linear() {
    let accept = |n: usize| {
        let source: String = (0..n).map(|i| format!("r{i}:a*b+{i};\n")).collect();
        let found = lint(&source, "t.q", Profile::Uqf);
        let accepted = q_lint_rs::suppressions_for(&found, &source);
        assert!(accepted.iter().flatten().count() >= n);
        best_of_three(|| q_lint_rs::suppressions_for(&found, &source))
    };
    accept(1000); // warm the allocator and the regex caches
    let (small, large) = (accept(1000), accept(8000));
    eprintln!("accepting 1000 findings took {small:?} and 8000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "accepting 1000 findings took {small:?} and 8000 {large:?}"
    );
    let fix = |n: usize| {
        let source: String = (0..n)
            .map(|i| format!("g{i}:{{[a] a}} / noqa: QF016\n"))
            .collect();
        let found = lint(&source, "t.q", Profile::Uqf);
        let fixes = q_lint_rs::fixes_for(&found, &source);
        assert_eq!(fixes.iter().filter(|f| f.replacement.is_empty()).count(), n);
        best_of_three(|| q_lint_rs::fixes_for(&found, &source))
    };
    fix(1000);
    let (small, large) = (fix(1000), fix(8000));
    eprintln!("fixing 1000 stale noqa took {small:?} and 8000 {large:?}");
    assert!(
        large < small * 16,
        "fixing 1000 stale noqa took {small:?} and 8000 {large:?}"
    );
}
/// About thirteen patterns built from constants were compiled again on every
/// lint: 2.4 ms before a file's first byte was read, 90% of the time to lint
/// a small one, paid per file by a pre-commit run and per open document by
/// the language server (#2350). Linting a line as a file of its own should
/// cost about what the same line costs inside a larger file.
#[test]
fn a_small_file_pays_no_compilation_of_its_own() {
    let line = "f:{[a;b] a+b};\n";
    let many = line.repeat(400);
    let time = || {
        let one = best_of_three(|| {
            for _ in 0..400 {
                std::hint::black_box(lint(line, "t.q", Profile::Uqf));
            }
        });
        let together = best_of_three(|| lint(&many, "t.q", Profile::Uqf));
        (one, together)
    };
    time(); // warm the allocator and the regex caches
    let (apart, together) = time();
    eprintln!("400 one-line files took {apart:?} and one of 400 lines {together:?}");
    // Compiling per lint made 400 files about 100 times one of 400 lines in
    // a debug build (8.4 s and 85 ms); without it they are about twice.
    assert!(
        apart < together * 16,
        "400 one-line files took {apart:?} and one of 400 lines {together:?}"
    );
}
/// One long line of statements, generated or minified q: QF004's check of
/// each assignment inside an expression asked whether it began a statement
/// by walking every statement on the line, quadratic in them (#2344). Empty
/// statements are statements too, and cheap to make many of.
#[test]
fn a_line_of_many_statements_lints_in_bounded_time() {
    let time = |n: usize| {
        let source = (0..n)
            .map(|i| format!("a{i}:b:c:d:e:f:g:h;;;;;;;;;;"))
            .collect::<String>()
            + "\n";
        best_of_three(|| lint(&source, "t.q", Profile::General))
    };
    time(2500); // warm the allocator and the regex caches
    let (small, large) = (time(2500), time(20000));
    eprintln!("a line of 2500 statements took {small:?} and of 20000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "a line of 2500 statements took {small:?} and of 20000 {large:?}"
    );
}
/// `--fix`, `--diff` and Format Document over a file with a fix on every
/// line: each QP005 fix found its statement among all the file's, each fix
/// copied the rest of the file, and each edit was spliced into the whole
/// text and its lines counted from the top - quadratic in fixes (#2336).
/// Timed with the findings linted once, so only the fixing is measured.
#[test]
fn fixing_every_line_is_linear() {
    let time = |n: usize| {
        let source: String = (0..n).map(|i| format!("r{i}:a*b+{i};\n")).collect();
        let found = lint(&source, "t.q", Profile::Uqf);
        // The findings of the source, and none once it has changed.
        let lint = |s: &str| Ok::<_, ()>(if s == source { found.clone() } else { vec![] });
        let fixed = q_lint_rs::fix_all(&source, false, lint).unwrap();
        assert_eq!(fixed.first.len(), n);
        let changed = q_lint_rs::fix_lines(&source, &[(1, n)], lint).unwrap();
        assert_eq!(changed.text, fixed.text);
        best_of_three(|| {
            q_lint_rs::fix_all(&source, false, lint).unwrap();
            q_lint_rs::fix_lines(&source, &[(1, n)], lint).unwrap();
        })
    };
    time(1000); // warm the allocator and the regex caches
    let (small, large) = (time(1000), time(8000));
    eprintln!("fixing 1000 lines took {small:?} and 8000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "fixing 1000 lines took {small:?} and 8000 {large:?}"
    );
}
/// Every bracket call of a `.Q`, `.h` or `.j` function, correct ones too,
/// asked whether the file assigns the name by compiling a pattern for it and
/// searching the whole file: quadratic in such calls (#2339).
#[test]
fn many_calls_of_a_dotted_builtin_lint_in_bounded_time() {
    let time = |n: usize| {
        let source: String = (0..n)
            .map(|i| format!("p{i}:.Q.dd[hdb;`t{i}];\n"))
            .collect();
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(1000); // warm the allocator and the regex caches
    let (small, large) = (time(1000), time(8000));
    eprintln!("1000 calls of .Q.dd took {small:?} and 8000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "1000 calls of .Q.dd took {small:?} and 8000 {large:?}"
    );
}
/// Many `\d` blocks: rank tracking found the namespace in force at each
/// definition by scanning back over every switch, quadratic in them (#2340).
/// Ten switches a definition, so the scan is most of the time.
#[test]
fn many_namespace_switches_lint_in_bounded_time() {
    let time = |n: usize| {
        let block = |i: usize| format!("\\d .n{i}\n{}f:{{x}}\n\\d .\n", "\\d .m\n".repeat(9));
        let source: String = (0..n).map(block).collect();
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(1000); // warm the allocator and the regex caches
    let (small, large) = (time(1000), time(8000));
    eprintln!("1000 namespace blocks took {small:?} and 8000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "1000 namespace blocks took {small:?} and 8000 {large:?}"
    );
}
/// Many table literals each compared on a char column: the check for those
/// comparisons searched the whole file for each table's name, quadratic in
/// tables (#2342).
#[test]
fn many_table_literals_with_char_columns_lint_in_bounded_time() {
    let time = |n: usize| {
        let source: String = (0..n)
            .map(|i| format!("t{i}:([] c:(\"ab\";\"cd\"));select from t{i} where c=\"ab\";\n"))
            .collect();
        best_of_three(|| q_lint_rs::lint_every_rule(&source, "t.q", &Workspace::default(), true))
    };
    time(1000); // warm the allocator and the regex caches
    let (small, large) = (time(1000), time(8000));
    eprintln!("1000 table literals took {small:?} and 8000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "1000 table literals took {small:?} and 8000 {large:?}"
    );
}
/// A select of many columns on one line: each column's assignment scanned
/// on to the end of the statement for the value it holds, so a wide select
/// was quadratic in its columns (#2346). Blanks between the columns make
/// that scan longer without adding names for every other rule to read.
#[test]
fn a_wide_select_lints_in_bounded_time() {
    let time = |n: usize| {
        let columns: Vec<String> = (0..n).map(|i| format!("c{i}:x{i}")).collect();
        let source = format!(
            "a:select {} from t\n",
            columns.join(&format!("{},", " ".repeat(40)))
        );
        best_of_three(|| lint(&source, "t.q", Profile::General))
    };
    time(1000); // warm the allocator and the regex caches
    let (small, large) = (time(1000), time(8000));
    eprintln!("a select of 1000 columns took {small:?} and of 8000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "a select of 1000 columns took {small:?} and of 8000 {large:?}"
    );
}
/// Navigation and semantic tokens on one long line: whether each name sat on
/// a system command's line was asked by searching back to the line's start,
/// so hover, definition, references, symbols and semantic tokens were
/// quadratic in the line's length (#2347).
#[test]
fn navigation_over_one_long_line_is_linear() {
    let time = |n: usize| {
        let calls: Vec<String> = (0..n).map(|i| format!("f[{i}]")).collect();
        let source = format!("f:{{x}};r:{}\n", calls.join("+"));
        assert!(q_lint_rs::mentions(&source).len() > n);
        best_of_three(|| {
            std::hint::black_box(q_lint_rs::mentions(&source));
            q_lint_rs::semantic_tokens_in(
                &source,
                &Workspace::default(),
                &q_lint_rs::graph::Placement::default(),
            )
        })
    };
    time(2500); // warm the allocator and the regex caches
    let (small, large) = (time(2500), time(20000));
    eprintln!("a line of 2500 calls took {small:?} and of 20000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "a line of 2500 calls took {small:?} and of 20000 {large:?}"
    );
}
/// Navigation over many lambdas without a parameter list: each one's
/// parameters were read from its scope, found by walking every scope in the
/// file, so mentions - references, rename, the call hierarchy, code lenses
/// - were quadratic in such lambdas (#2348).
#[test]
fn navigation_over_many_implicit_lambdas_is_linear() {
    let time = |n: usize| {
        let source: String = (0..n).map(|i| format!("f{i}:{{x}}\n")).collect();
        best_of_three(|| q_lint_rs::mentions(&source))
    };
    time(4000); // warm the allocator and the regex caches
    let (small, large) = (time(4000), time(32000));
    eprintln!("4000 lambdas took {small:?} and 32000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "4000 lambdas took {small:?} and 32000 {large:?}"
    );
}
/// QS007 asked, for each `@param`, whether its run documents some other
/// lambda, and read every lambda in the file to answer: a file documented a
/// function at a time was quadratic in its length (#2865).
#[test]
fn many_documented_functions_lint_in_linear_time() {
    let time = |n: usize| {
        let source: String = (0..n)
            .map(|i| format!("/ @param a x\nf{i}:{{[a] a}}\n"))
            .collect();
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(1000); // warm the allocator and the regex caches
    let (small, large) = (time(1000), time(8000));
    eprintln!("1000 documented functions took {small:?} and 8000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "1000 documented functions took {small:?} and 8000 {large:?}"
    );
}
/// QS007 says what the lambda declares by the names its slots bind: a
/// typed slot's name and a pattern's, not the slots as written (#2778).
#[test]
fn a_stale_param_is_told_the_names_the_signature_binds() {
    let source = "/ @param zz nothing\nf:{[x:`j;(a;b);] x+a+b}\n";
    let found = lint(source, "t.q", Profile::StyleQ);
    let messages: Vec<&str> = found
        .iter()
        .filter(|f| f.code == "QS007")
        .map(|f| f.detail.as_str())
        .collect();
    assert_eq!(
        messages,
        [
            "`@param zz` names a parameter this lambda does not take; it declares \
          [\"x\", \"a\", \"b\"]"
        ]
    );
}
/// QB004 read on from each top-level signal to the next `;` or closer,
/// which in a file of them is the end of the file (#2866).
#[test]
fn many_top_level_signals_lint_in_linear_time() {
    let time = |n: usize| {
        let source: String = (0..n).map(|i| format!("a{i}:'\"x\"\n")).collect();
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(2000); // warm the allocator and the regex caches
    let (small, large) = (time(2000), time(16000));
    eprintln!("2000 signals took {small:?} and 16000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "2000 signals took {small:?} and 16000 {large:?}"
    );
}
/// A file of statements left open - a bad paste or merge. The line each
/// unclosed bracket is reported before was counted from the start of the
/// file; and with QE001 deselected, so that the other rules run, each line
/// read on to the end of its statement, the file's (#2867).
#[test]
fn many_unclosed_statements_lint_in_linear_time() {
    for structure in [true, false] {
        let time = |n: usize| {
            let source: String = (0..n).map(|i| format!("a{i}:(1\n")).collect();
            best_of_three(|| {
                q_lint_rs::lint_every_rule(&source, "t.q", &Workspace::default(), structure)
            })
        };
        time(2500); // warm the allocator and the regex caches
        let (small, large) = (time(2500), time(20000));
        eprintln!("2500 unclosed statements took {small:?} and 20000 {large:?}");
        // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk
        // by four times.
        assert!(
            large < small * 16,
            "2500 unclosed statements took {small:?} and 20000 {large:?}"
        );
    }
}
/// `statement_view` validated the whole scope as UTF-8 again for each
/// query in it, so one lambda of many queries was quadratic (#2868).
#[test]
fn many_queries_in_one_lambda_lint_in_linear_time() {
    let time = |n: usize| {
        let body: String = (0..n)
            .map(|i| format!(" r{i}:select a from t where b>0;\n"))
            .collect();
        let source = format!("f:{{[t]\n{body} }}\n");
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(4000); // warm the allocator and the regex caches
    let (small, large) = (time(4000), time(32000));
    eprintln!("4000 queries took {small:?} and 32000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "4000 queries took {small:?} and 32000 {large:?}"
    );
}
/// A global assigned and read over and over, as a generated or a long
/// imperative script does: each read gathered every assignment of the name
/// to find the one in force (#2869).
#[test]
fn a_global_reassigned_and_read_many_times_lints_in_linear_time() {
    let time = |n: usize| {
        let source = "a:1\nr:a 0\n".repeat(n);
        best_of_three(|| lint(&source, "t.q", Profile::Uqf))
    };
    time(2000); // warm the allocator and the regex caches
    let (small, large) = (time(2000), time(16000));
    eprintln!("2000 reassignments took {small:?} and 16000 {large:?}");
    // Quadratic is 64 times; linear is 8. 16 still fails a quadratic walk by
    // four times.
    assert!(
        large < small * 16,
        "2000 reassignments took {small:?} and 16000 {large:?}"
    );
}

/// A control character where q reads code is 'char in q 5, as a character
/// past ASCII is: a NUL from a binary merge, an ESC from pasted terminal
/// output. A tab, a form feed and a carriage return are blank, and load
/// (#2860).
#[test]
fn a_control_character_in_code_is_reported_as_q_refuses_it() {
    for ch in [
        '\0', '\x01', '\x07', '\x08', '\x0b', '\x0e', '\x1b', '\x1f', '\x7f',
    ] {
        let source = format!("a:1;{ch}b:2\n");
        let found = lint(&source, "t.q", Profile::General);
        let of: Vec<_> = found.iter().filter(|f| f.code == "QE012").collect();
        assert_eq!(of.len(), 1, "{ch:?}: {found:?}");
        assert_eq!((of[0].line, of[0].column), (1, Some(5)), "{ch:?}");
        let named = format!("U+{:04X} ", u32::from(ch));
        assert!(of[0].detail.starts_with(&named), "{}", of[0].detail);
    }
    for ch in ['\t', '\x0c', '\r'] {
        let source = format!("a:1;{ch}b:2\n");
        let found = lint(&source, "t.q", Profile::General);
        assert!(found.iter().all(|f| f.code != "QE012"), "{ch:?}: {found:?}");
    }
}
