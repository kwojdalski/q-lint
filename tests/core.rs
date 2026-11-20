use q_lint_rs::{Profile, Workspace, broken_statement, lint, lint_selecting};
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
fn a_root_lambda_is_not_coloured_inside_a_context() {
    use q_lint_rs::{TokenKind, Workspace, index, semantic_tokens_in};
    // q 5: under `\\d .ns`, `m:f 2` is 'f - no fallback to the root `f`,
    // which the workspace, holding this file too, defines (#366).
    let text = "f:{x+1}\n\\d .ns\nm:f 2\n";
    let mut ws = Workspace::default();
    ws.add(&index(text));
    ws.add(&index("g:{x}\n"));
    assert!(
        !semantic_tokens_in(text, &ws)
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
    // the language server lints on every keystroke. About 1 s in a debug
    // build after the fix, against roughly five times that before it. At 4000
    // deep it took 3 s here and over 10 s on a shared CI runner, so the bound
    // failed with no regression behind it.
    // Past q's own limit of 100, which QE001 reports alone (#717), so the
    // rules are run as they are with QE001 deselected.
    let depth = 2000;
    let source = format!("f:{}{}\n", "{".repeat(depth), "}".repeat(depth));
    let started = std::time::Instant::now();
    lint_selecting(&source, "t.q", Profile::Style, &Workspace::default(), false);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "{depth} nested lambdas took {elapsed:?}"
    );
}
/// Every finding is placed by its line, which was counted from the file's
/// start for each: a file of block comments, each a QP001 finding built and
/// dropped later, took time quadratic in their number (#706). About 1 s in a
/// debug build after the fix.
#[test]
fn many_findings_lint_in_bounded_time() {
    let source = "/\nsome text here {[ ( \"\n\\\n".repeat(20000);
    let started = std::time::Instant::now();
    lint(&source, "t.q", Profile::Uqf);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "20000 block comments took {elapsed:?}"
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
    let body: String = (0..16000).map(|i| format!("  a{i}:x+y*{i};\n")).collect();
    let source = format!("f:{{[x;y]\n{body}  a0}}\n");
    let started = std::time::Instant::now();
    lint(&source, "t.q", Profile::Style);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "a 16000-line lambda took {elapsed:?}"
    );
}
/// Chained qSQL keywords: each one scanned on to the statement's end, more
/// than once over, so a chain took time quadratic in its length (#709).
#[test]
fn chained_queries_lint_in_bounded_time() {
    let source = format!("r:{}t\n", "select from ".repeat(8000));
    let started = std::time::Instant::now();
    lint(&source, "t.q", Profile::Uqf);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "8000 chained queries took {elapsed:?}"
    );
}
/// Nested `$[`, `@[` and `.[`: each split its whole contents into slots, the
/// brackets nested in it included, so a deep nest was quadratic (#710). Past
/// q's limit of 100, so read as with QE001 deselected.
#[test]
fn nested_conditionals_lint_in_bounded_time() {
    let depth = 16000;
    for (open, close) in [("$[x;", ";0]"), ("@[f;", ";0]"), (".[f;", ";0]")] {
        let source = format!("a:{}1{}\n", open.repeat(depth), close.repeat(depth));
        let started = std::time::Instant::now();
        lint_selecting(&source, "t.q", Profile::Style, &Workspace::default(), false);
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(10),
            "{depth} nested {open} took {elapsed:?}"
        );
    }
}
/// A wide table literal: each column counted its depth from the literal's
/// start (#469), was compared with every column before it for QB019, and
/// each number on the line looked back for the line's start (#711).
#[test]
fn a_wide_table_literal_lints_in_bounded_time() {
    let keys: Vec<String> = (0..16000).map(|i| format!("k{i}:1 2")).collect();
    let columns: Vec<String> = (0..16000).map(|i| format!("c{i}:3 4")).collect();
    let source = format!("t:([{}] {})\n", keys.join("; "), columns.join("; "));
    let started = std::time::Instant::now();
    lint(&source, "t.q", Profile::Style);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "32000 columns took {elapsed:?}"
    );
}
/// Lambdas nested in each other's bodies: each scope copied its whole body,
/// and each implicit lambda's rank and each body's statements were read over
/// the lambdas nested in it, so time and memory were quadratic in the depth -
/// 4 GB for 32000 (#704). Past q's limit, so read as with QE001 deselected.
#[test]
fn nested_lambda_bodies_lint_in_bounded_time() {
    let depth = 16000;
    let source = format!("a:{}1{}\n", "{x+".repeat(depth), "}".repeat(depth));
    let started = std::time::Instant::now();
    lint_selecting(&source, "t.q", Profile::Style, &Workspace::default(), false);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "{depth} nested lambda bodies took {elapsed:?}"
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
