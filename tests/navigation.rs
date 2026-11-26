//! Navigation: the outline, workspace symbols, go to definition, find
//! references, highlights and renaming a local - first as the library reads
//! one file, then as the language server answers an editor over a workspace.
use q_lint_rs::{Name, load_at, mentions, name_at, rename, rename_target};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{Receiver, channel},
    time::Duration,
};

/// Each global `source` mentions: the text at the mention, the name it
/// resolves to, and `w` for a write or `r` for a read.
fn seen(source: &str) -> Vec<(&str, String, char)> {
    mentions(source)
        .iter()
        .map(|m| {
            let kind = if m.definition.is_some() { 'w' } else { 'r' };
            (&source[m.at..m.at + m.len], m.name.clone(), kind)
        })
        .collect()
}

/// Where `context` starts in `source`, `skip` bytes in: the cursor on one
/// name of a line too short to count columns in by eye.
fn at(source: &str, context: &str, skip: usize) -> usize {
    source.find(context).expect("the context is in the source") + skip
}

#[test]
fn a_global_is_named_as_q_resolves_it_under_the_context_in_force() {
    let source = "g:1\nf:{[a] a+g}\n\\d .ns\nh:{f[x]+g}\n.other.v:h 2\n";
    assert_eq!(
        seen(source),
        [
            ("g", "g".to_string(), 'w'),
            ("f", "f".into(), 'w'),
            ("g", "g".into(), 'r'),
            ("h", ".ns.h".into(), 'w'),
            ("f", ".ns.f".into(), 'r'),
            ("g", ".ns.g".into(), 'r'),
            (".other.v", ".other.v".into(), 'w'),
            ("h", ".ns.h".into(), 'r'),
        ]
    );
    // Before the first `\d` a bare name is in whichever context the file is
    // loaded in; after it, the file has said.
    let implicit: Vec<bool> = mentions(source).iter().map(|m| m.implicit).collect();
    assert_eq!(
        implicit,
        [true, true, true, false, false, false, false, false]
    );
}

#[test]
fn a_string_a_comment_and_a_system_command_mention_nothing() {
    let source = "s:\"f in a string\"\n/ f in a comment\n\\l f.q\nt:1 / f again\n";
    assert_eq!(
        seen(source),
        [("s", "s".to_string(), 'w'), ("t", "t".into(), 'w')]
    );
}

#[test]
fn the_command_word_of_a_timed_line_mentions_nothing() {
    // KDB-X: with the `t` of `\t:10` renamed, `\tbl:10 count tbl` goes to
    // the shell and is 'os (#2812). What follows the command is q.
    let source =
        "t:([]a:1 2)\n\\t:10 count t\n\\t count t\n\\t 100\nts:1\n\\ts ts+1\n\\ts:5 ts\nq)\\t t\n";
    assert_eq!(
        seen(source),
        [
            ("t", "t".to_string(), 'w'),
            ("t", "t".into(), 'r'),
            ("t", "t".into(), 'r'),
            ("ts", "ts".into(), 'w'),
            ("ts", "ts".into(), 'r'),
            ("ts", "ts".into(), 'r'),
            ("t", "t".into(), 'r'),
        ]
    );
    let reads: Vec<usize> = mentions(source)
        .iter()
        .filter(|m| m.definition.is_none())
        .map(|m| m.at)
        .collect();
    assert_eq!(reads, [24, 35, 53, 64, 72]);
}

#[test]
fn a_column_and_a_builtin_are_no_global() {
    // `a:` and `b:` in a table literal and `total:` in a query are written
    // as assignments and assign nothing; `count` and `til` are q's own.
    let source = "t:([] a:til 3; b:3#0)\nn:count select total:sum a from t\n";
    assert_eq!(
        seen(source),
        [
            ("t", "t".to_string(), 'w'),
            ("n", "n".into(), 'w'),
            ("a", "a".into(), 'r'),
            ("t", "t".into(), 'r'),
        ]
    );
}

#[test]
fn a_column_delete_names_is_no_mention_of_a_global() {
    // KDB-X drops the column whatever a global `px` holds, so the list of
    // `delete` is no place the global is read (#2806); the `where` of a row
    // delete is an expression, and is, and so is the name a delete from a
    // namespace removes.
    let source = "px:{x}\nr:delete px from t\ns:delete a, px from t\nd:delete from t where a=px\n\
                  delete px from `.\n";
    let reads: Vec<_> = seen(source)
        .into_iter()
        .filter(|(_, _, kind)| *kind == 'r')
        .map(|(text, _, _)| text)
        .collect();
    assert_eq!(reads, ["t", "t", "t", "a", "px", "px"]);
}

/// q 5 after these lines has `h`, `x` and `aa` in the root and nothing else:
/// a symbol is one token over its `:`, and only the expression `\t` times
/// is q (#2775, #2776).
#[test]
fn a_symbol_and_a_system_command_write_no_global() {
    let source = "h:`:localhost:5000\nx:`a:b:c\n\\t:100 1+1\n\\ts:10 aa:2\n\\l c:/q/lib.q\n";
    assert_eq!(
        seen(source),
        [
            ("h", "h".to_string(), 'w'),
            ("x", "x".into(), 'w'),
            ("aa", "aa".into(), 'w')
        ]
    );
}

#[test]
fn every_way_of_writing_a_global_is_a_definition_at_its_name() {
    let source = "`tab set ([] a:1 2)\n@[`.;`amended;:;5]\n.cfg[`key]:1\n\
                  init:{`.app.state set x; counter::0}\n";
    let writes: Vec<(&str, String)> = seen(source)
        .into_iter()
        .filter(|(_, _, kind)| *kind == 'w')
        .map(|(text, name, _)| (text, name))
        .collect();
    assert_eq!(
        writes,
        [
            ("tab", "tab".to_string()),
            ("amended", "amended".into()),
            ("key", ".cfg.key".into()),
            ("init", "init".into()),
            (".app.state", ".app.state".into()),
            ("counter", "counter".into()),
        ]
    );
}

#[test]
fn a_definition_just_after_a_character_of_more_than_one_byte_is_found() {
    // #859: the start of a name was taken one byte past the character before
    // it, which split a BOM or a no-break space and panicked.
    for source in ["\u{feff}f:{x}\n", "x:1;\u{a0}f:{x}\n", "\u{feff}`f set 1\n"] {
        let writes: Vec<_> = seen(source).into_iter().filter(|m| m.1 == "f").collect();
        assert_eq!(writes, [("f", "f".to_string(), 'w')], "{source:?}");
    }
    // One in a string or a comment beside the name is no part of it.
    let source = "s:\"\u{e9}\";f:1 / caf\u{e9}\nr:\"\u{1f600}\",string f\n";
    assert_eq!(
        seen(source),
        [
            ("s", "s".to_string(), 'w'),
            ("f", "f".into(), 'w'),
            ("r", "r".into(), 'w'),
            ("f", "f".into(), 'r'),
        ]
    );
}

#[test]
fn a_definition_carries_its_kind_its_signature_and_its_statement() {
    let source = "limit:10\nadd:{[a;b]\n  a+b}\nneg1:{neg x}\ns:\"ab\";r:1\nm:\"a\n b\" / note\n";
    let all = mentions(source);
    let defined: Vec<_> = all
        .iter()
        .filter_map(|m| Some((m.name.as_str(), m.definition.as_ref()?)))
        .map(|(name, d)| (name, d.function, d.detail.as_str(), &source[d.start..d.end]))
        .collect();
    assert_eq!(
        defined,
        [
            ("limit", false, "", "limit:10"),
            ("add", true, "[a;b]", "add:{[a;b]\n  a+b}"),
            // An implicit signature is not written, so there is none to show.
            ("neg1", true, "", "neg1:{neg x}"),
            // A string the statement ends in is in it, a comment is not (#1215).
            ("s", false, "", "s:\"ab\""),
            ("r", false, "", "r:1"),
            ("m", false, "", "m:\"a\n b\""),
        ]
    );
}

/// Each name `source` defines, with whether its definition is a function.
fn kinds(source: &str) -> Vec<(String, bool)> {
    mentions(source)
        .iter()
        .filter_map(|m| Some((m.name.clone(), m.definition.as_ref()?.function)))
        .collect()
}

#[test]
fn a_lambda_applied_to_empty_brackets_defines_a_value() {
    // KDB-X: `c:{[] 42}[]` and `d:{[a] 7}[]` are -7h, `e:{x}[]` is `::`,
    // and `h:{x+y}[]` a projection, 104h (#2309).
    assert_eq!(
        kinds("c:{[] 42}[]\nd:{[a] 7}[]\ne:{x}[]\nh:{x+y}[]\n"),
        [
            ("c".to_string(), false),
            ("d".into(), false),
            ("e".into(), false),
            ("h".into(), true),
        ]
    );
}

/// Each name `source` defines, once, with whether it holds a function once
/// the file has loaded - what the outline says of it.
fn holds(source: &str) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = vec![];
    for m in mentions(source) {
        if let Some(d) = &m.definition
            && !out.iter().any(|(name, _)| *name == m.name)
        {
            out.push((m.name.clone(), d.holds_function));
        }
    }
    out
}

#[test]
fn a_name_assigned_what_a_function_returns_is_outlined_as_a_value() {
    // KDB-X 5: `type each (upper "s";count 1 2)` is -10 -7h, and `c:count`
    // with `  1 2 3` on the line below is -7h. A string is blank in the code
    // view, and the line below was not read, so each was outlined - and
    // coloured where read - as the function it applies (#2965).
    let named = |names: &[(&str, bool)]| -> Vec<(String, bool)> {
        names.iter().map(|&(n, f)| (n.to_string(), f)).collect()
    };
    assert_eq!(
        holds(
            "a:upper \"s\"\nb:value \"1+1\"\nc:count\n  1 2 3\nd:count\n  \"abc\"\ne:count / \"no\"\nh:count\n/ note\n\n  1 2\ni:count\nj:count each\n  (1 2;3)\nk:count each\n"
        ),
        named(&[
            ("a", false),
            ("b", false),
            ("c", false),
            ("d", false),
            ("e", true),
            ("h", false),
            ("i", true),
            ("j", false),
            ("k", true),
        ])
    );
}

#[test]
fn a_name_is_outlined_by_the_value_q_holds_it_as() {
    let named = |names: &[(&str, bool)]| -> Vec<(String, bool)> {
        names.iter().map(|&(n, f)| (n.to_string(), f)).collect()
    };
    // KDB-X: `a:b:{x+1}` makes both 100h (#2310).
    assert_eq!(holds("a:b:{x+1}\n"), named(&[("a", true), ("b", true)]));
    // Each lambda written by set', a functional amend, a multiple
    // assignment and `set` in brackets is 100h (#2315).
    assert_eq!(
        holds(
            "`n1`n2 set' (1;{x})\n.[`n3;();:;{x}]\n(n5;n6):(1;{x})\n.c.z:0\n@[`.c;`n10;:;{x}]\nset[`n12;{x}]\n"
        ),
        named(&[
            ("n1", false),
            ("n2", true),
            ("n3", true),
            ("n5", false),
            ("n6", true),
            (".c.z", false),
            (".c.n10", true),
            ("n12", true),
        ])
    );
    // An alias, a projection, a derived function and q's own: 100h, 104h,
    // 104h, 104h - and applied to every argument, 3 (#2316).
    assert_eq!(
        holds("f:{[a;b] a+b}\np:f[;1]\nal:f\nce:count each\nup:upsert\nd:f[1;2]\n"),
        named(&[
            ("f", true),
            ("p", true),
            ("al", true),
            ("ce", true),
            ("up", true),
            ("d", false),
        ])
    );
    // The last write, wherever the name is first listed (#2317).
    assert_eq!(holds("f:{x}\nf:5\n"), named(&[("f", false)]));
    assert_eq!(holds("g:5\ng:{x}\n"), named(&[("g", true)]));
}

#[test]
fn a_name_with_a_segment_led_by_an_underscore_is_one_name() {
    // KDB-X defines `.x.__h` and `a._b` (`key `.x` is ``__h, `key `a`
    // ``_b), and `-4!` reads each as one token; `._c` is no name, but `.`,
    // `_` and `c` (#2311).
    assert_eq!(
        seen(".x.__h:{x}\na._b:1\nq:.x.__h a._b\n"),
        [
            (".x.__h", ".x.__h".to_string(), 'w'),
            ("a._b", "a._b".into(), 'w'),
            ("q", "q".into(), 'w'),
            (".x.__h", ".x.__h".into(), 'r'),
            ("a._b", "a._b".into(), 'r'),
        ]
    );
}

#[test]
fn a_key_of_a_dictionary_is_no_member_of_a_namespace() {
    // KDB-X: after `.jobs:(`symbol$())!()`, `.jobs[`daily]:1` adds a key,
    // and `key `.jobs` is `daily with no null - not a namespace; `get
    // `.ns.describe.trades` signals 'trades (#2312). Into a namespace,
    // `.c4[`a]:1` defines `.c4.a` (`key `.c4` is ``x`a).
    let names: Vec<String> = holds(
        ".jobs:(`symbol$())!()\n.jobs[`daily]:1\n\\d .ns\ndescribe:(`symbol$())!()\n\
         .ns.describe[`trades]:\"t\"\n\\d .\n.c4.x:0\n.c4[`a]:1\n",
    )
    .into_iter()
    .map(|(name, _)| name)
    .collect();
    assert_eq!(names, [".jobs", ".ns.describe", ".c4.x", ".c4.a"]);
}

#[test]
fn a_k_lines_assignment_is_outlined_by_the_last_write() {
    // KDB-X: `k)g:{x}` then `g:5` holds 5 (#2314, as #2317 for q lines).
    assert_eq!(holds("k)g:{x}\ng:5\n"), [("g".to_string(), false)]);
    assert_eq!(holds("g:5\nk)g:{x}\n"), [("g".to_string(), true)]);
}

/// Files whose names a real q is asked for: one for each way the outline
/// has been wrong about what `\l` defines, or of what kind (#2309-#2317).
const DEFINED_BY_LOAD: &[&str] = &[
    "c:{[] 42}[]\nd:{[a] 7}[]\nh:{x+y}[]\n",
    "a:b:{x+1}\n",
    ".x.__h:{x}\n.x._k:{x}\nm._b:1\n",
    ".jobs:(`symbol$())!()\n.jobs[`daily]:1\n.c4.x:0\n.c4[`a]:1\n",
    "`n1`n2 set' (1;{x})\n.[`n3;();:;{x}]\n(n5;n6):(1;{x})\n.c.z:0\n@[`.c;`n10;:;{x}]\nset[`n12;{x}]\n",
    "f:{[a;b] a+b}\np:f[;1]\nal:f\nce:count each\nup:upsert\nd:f[1;2]\n",
    "f:{x}\nf:5\ng:5\ng:{x}\n",
    "k)g:{[a] a+1}\nh:5\nk)h:{x}\n",
];

/// What loading the file at `path` defines on the q that QLINT_TEST_Q names:
/// each name, a namespace's members by their whole name, with whether its
/// value is a function (type 100h to 112h).
fn loaded_by_q(q: &str, path: &Path) -> Vec<(String, bool)> {
    let script = format!(
        r#".dmp.isns:{{[v] $[99h<>type v;0b;11h<>type key v;0b;(`)~first key v]}};
.dmp.walk:{{[nm] raze .dmp.one[nm] each (key get nm) except `}};
.dmp.one:{{[nm;k] full:$[nm~`;k;` sv nm,k]; v:@[get;full;{{`dmperr}}]; $[.dmp.isns v; .dmp.walk full; enlist (full;type v)]}};
.dmp.all:{{[] r:raze .dmp.one[`] each (key `.) except `; r,raze {{[n] nm:` sv `,n; v:@[get;nm;0]; $[.dmp.isns v; .dmp.walk nm; enlist (nm;type v)]}} each (key `) except ``q`Q`h`j`z`o`dmp}};
.dmp.before:.dmp.all[];
system "l {}";
.dmp.after:.dmp.all[];
{{-1 "defined ",string[x 0]," ",string x 1}} each .dmp.after where not .dmp.after[;0] in .dmp.before[;0];
exit 0
"#,
        path.display().to_string().replace('\\', "/")
    );
    let dir = path.parent().unwrap();
    let dump = dir.join("dump.q");
    std::fs::write(&dump, script).unwrap();
    let mut words = q.split_whitespace();
    let out = Command::new(words.next().unwrap())
        .args(words)
        .arg(&dump)
        .arg("-q")
        .stdin(Stdio::null())
        .output()
        .expect("run q");
    let text = String::from_utf8_lossy(&out.stdout);
    let mut names: Vec<(String, bool)> = text
        .lines()
        .filter_map(|line| line.strip_prefix("defined "))
        .map(|line| {
            let (name, kind) = line.rsplit_once(' ').unwrap_or_else(|| panic!("{text}"));
            let kind: i16 = kind.parse().unwrap_or_else(|_| panic!("{text}"));
            (name.to_string(), (100..=112).contains(&kind))
        })
        .collect();
    names.sort();
    names
}

#[test]
fn the_outline_names_what_q_defines_by_loading_the_file() {
    let Ok(q) = std::env::var("QLINT_TEST_Q") else {
        eprintln!("QLINT_TEST_Q names no q: the files stand as KDB-X loaded them");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    for (i, source) in DEFINED_BY_LOAD.iter().enumerate() {
        let path = dir.path().join(format!("f{i}.q"));
        std::fs::write(&path, source).unwrap();
        let mut outlined = holds(source);
        outlined.sort();
        assert_eq!(outlined, loaded_by_q(&q, &path), "{source}");
    }
}

#[test]
fn the_path_of_each_kind_of_load_is_found_under_the_cursor() {
    let source =
        "\\l lib/a.q\nsystem \"l lib/b.q\"\nf:`:lib/c.q\n/ \\l lib/d.q\n\\cd lib\n\\l e.q\n";
    let path = |context: &str, skip: usize| {
        load_at(source, at(source, context, skip)).map(|(at, len)| &source[at..at + len])
    };
    assert_eq!(path("lib/a.q", 0), Some("lib/a.q"));
    // Its end counts, as the cursor after the last character.
    assert_eq!(path("lib/a.q", 7), Some("lib/a.q"));
    assert_eq!(path("lib/b.q", 4), Some("lib/b.q"));
    assert_eq!(path("lib/c.q", 2), Some("lib/c.q"));
    // Not a comment, not the command, and not a path read after `\cd`.
    assert_eq!(path("lib/d.q", 2), None);
    assert_eq!(path("\\l lib/a", 1), None);
    assert_eq!(path("e.q", 1), None);
}

/// The local at `offset`: each place it is named, as text offsets, with the
/// index of the one declaring it.
fn local(source: &str, offset: usize) -> (Vec<usize>, Option<usize>) {
    match name_at(source, offset) {
        Some(Name::Local(local)) => (local.places.iter().map(|p| p.at).collect(), local.declared),
        other => panic!("a local was expected, not {other:?}"),
    }
}

#[test]
fn a_local_is_every_place_its_own_lambda_names_it() {
    let source = "f:{[a;b] c:a+b; {[a] a*2} c*a}\n";
    // The parameter, its two reads - and not the inner lambda's own `a`.
    assert_eq!(
        local(source, at(source, "[a;b]", 1)),
        (vec![4, 11, 28], Some(0))
    );
    assert_eq!(
        local(source, at(source, "{[a] a*2}", 2)),
        (vec![18, 21], Some(0))
    );
    // A local is declared where it is first assigned.
    assert_eq!(local(source, at(source, "c*a", 0)), (vec![9, 26], Some(0)));
    // The cursor just after a name is still on it.
    assert_eq!(local(source, at(source, "c:a+b", 1)).0, vec![9, 26]);
}

#[test]
fn a_multiple_assignment_declares_each_name_it_binds() {
    let source = "f:{[d] (p;q):d; p+q}\n";
    let Some(Name::Local(p)) = name_at(source, at(source, "p+q", 0)) else {
        panic!("p is a local");
    };
    assert_eq!(p.declared, Some(0));
    assert!(p.places[0].write && !p.places[1].write);
}

#[test]
fn an_indexed_assignment_writes_the_local_without_declaring_it() {
    // KDB-X: `{[a] a[0]:2; a} 1 2` is 2 2 - the assignment amends `a`
    // (#1246), as do `a[0]+:2` and `a[0;1]:2`.
    for source in [
        "f:{[a] a[0]:2; a}\n",
        "f:{[a] a[0]+:2; a}\n",
        "f:{[a] a[0][1]:2; a}\n",
    ] {
        let Some(Name::Local(a)) = name_at(source, at(source, "a]", 0)) else {
            panic!("a is a local in {source}");
        };
        let writes: Vec<bool> = a.places.iter().map(|p| p.write).collect();
        assert_eq!(writes, [true, true, false], "{source}");
        assert_eq!(a.declared, Some(0), "{source}");
    }
    // An index that is read is no write.
    let source = "f:{[a] b:a[0]; b}\n";
    let Some(Name::Local(a)) = name_at(source, at(source, "a]", 0)) else {
        panic!("a is a local");
    };
    assert!(!a.places[1].write);
}

#[test]
fn a_name_outside_any_lambda_is_a_global_and_whitespace_is_nothing() {
    let source = "g:1\nf:{g+1}\n";
    assert_eq!(
        name_at(source, at(source, "g+1", 0)),
        Some(Name::Global {
            at: 7,
            len: 1,
            names: vec![("g".into(), true)]
        })
    );
    assert_eq!(name_at("a:1\n\n  \nb:2\n", 5), None);
    // q's own words are not names to go to.
    assert_eq!(name_at("n:count 1 2\n", 4), None);
}

#[test]
fn renaming_a_local_rewrites_each_place_and_nothing_else() {
    let source = "a:1\nf:{[a;b] c:a+b; {[a] a*2} c*a}\n";
    let edits = rename(source, at(source, "c*a", 2), "left").unwrap();
    assert_eq!(edits, [(8, 1), (15, 1), (32, 1)]);
    assert_eq!(rename_target(source, at(source, "c*a", 2)), Ok((32, 1)));
}

/// Why renaming the name at `context`+`skip` to `new` is refused.
fn refusal(source: &str, context: &str, skip: usize, new: &str) -> String {
    rename(source, at(source, context, skip), new).expect_err("the rename is refused")
}

#[test]
fn a_global_is_not_renamed_within_one_file() {
    let source = "g:1\nf:{[a] a+g}\n";
    for offset in [0, at(source, "a+g", 2)] {
        let why = rename(source, offset, "h").unwrap_err();
        assert!(why.contains("across the workspace"), "{why}");
        assert_eq!(rename_target(source, offset), Err(why));
    }
}

/// Only a global was ever sent to the language server: a blank, a number, a
/// string, a comment, a symbol and a word of q's were too, by the server
/// that had just been asked (#2959).
#[test]
fn what_is_no_name_is_refused_as_no_name_and_not_as_a_global() {
    let source = "x:count 123\ny:\"str\" / note\nz:`sym\n\nt:([] col:1 2)\n";
    for (context, skip, why) in [
        ("123", 1, "there is no name here to rename"),
        ("str", 1, "there is no name here to rename"),
        ("note", 2, "there is no name here to rename"),
        ("sym", 1, "there is no name here to rename"),
        ("\n\n", 1, "there is no name here to rename"),
        ("count", 2, "`count` is a word of q's own"),
        ("col", 1, "`col` here is neither a local nor a global"),
    ] {
        let offset = at(source, context, skip);
        let refused = rename(source, offset, "new").unwrap_err();
        assert!(refused.starts_with(why), "{context}: {refused}");
        assert_eq!(rename_target(source, offset), Err(refused), "{context}");
    }
    let empty = rename("", 0, "new").unwrap_err();
    assert!(empty.starts_with("there is no name"), "{empty}");
}

/// The same from the server, for a rename and for the question before one.
#[test]
fn the_server_refuses_a_rename_of_no_name_without_naming_itself() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "x:count 123\ny:\"str\" / note\n\n";
    let uri = server.open(dir.path(), "main.q", text);
    for (context, skip) in [
        ("count", 2),
        ("123", 1),
        ("str", 1),
        ("note", 2),
        ("\n\n", 1),
    ] {
        for method in ["textDocument/prepareRename", "textDocument/rename"] {
            let new = json!({"newName": "new"});
            let reply = server.ask(method, &uri, text, context, skip, new);
            assert_eq!(reply["error"]["code"], -32803, "{context}: {reply}");
            let why = reply["error"]["message"].as_str().unwrap();
            assert!(!why.contains("language server"), "{context}: {why}");
        }
    }
}

#[test]
fn an_implicit_parameter_is_not_renamed() {
    let why = refusal("f:{x+1}\n", "x+1", 0, "v");
    assert!(why.contains("implicit parameter"), "{why}");
}

#[test]
fn a_local_read_in_a_query_is_not_renamed_since_it_may_be_a_column() {
    let source = "f:{[t;lim] select from t where size>lim}\n";
    let why = refusal(source, "[t;lim]", 3, "cap");
    assert!(why.contains("qSQL"), "{why}");
    // The table after `from` is no column.
    assert_eq!(
        rename(source, at(source, "[t;lim]", 1), "tbl")
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn a_local_that_names_a_table_literal_column_is_not_renamed() {
    // KDB-X: cols {[a] ([] a; b:3 4)} 1 2 is `a`b, and ([] a+1) and ([a] b)
    // are named a too; renamed, the column would be too (#1305).
    for source in [
        "f:{[a] ([] a; b:3 4)}\n",
        "f:{[a] ([] b:3 4; a+1)}\n",
        "f:{[a] ([a] b:3 4)}\n",
        "f:{[a] ([] c:1 2; g[a])}\n",
    ] {
        let why = refusal(source, "[a]", 1, "zz");
        assert!(why.contains("table literal"), "{source}: {why}");
    }
    // A column with its own name keeps it.
    for source in [
        "f:{[a] ([] c:a; b:3 4)}\n",
        "f:{[a] ([k:a] b:3 4)}\n",
        "f:{[a] ([] b:3 4; c:g[a])}\n",
    ] {
        assert_eq!(
            rename(source, at(source, "[a]", 1), "zz").unwrap().len(),
            2,
            "{source}"
        );
    }
}

#[test]
fn a_new_name_has_to_be_one_the_lambda_can_take() {
    let source = "f:{[a;b] c:a+b; g c}\n";
    assert!(refusal(source, "[a;b]", 1, "1a").contains("not a name"));
    assert!(refusal(source, "[a;b]", 1, "a.b").contains("not a name"));
    assert!(refusal(source, "[a;b]", 1, "count").contains("builtin"));
    // Another local, and a global the lambda reads, which the new name
    // would hide.
    assert!(refusal(source, "[a;b]", 1, "b").contains("already uses"));
    assert!(refusal(source, "[a;b]", 1, "c").contains("already uses"));
    assert!(refusal(source, "[a;b]", 1, "g").contains("already uses"));
    // To its own name is no change, and no refusal.
    assert_eq!(
        rename(source, at(source, "[a;b]", 1), "a").unwrap().len(),
        2
    );
    // A local called x in a lambda without a signature is an argument.
    let why = refusal("f:{a:1; a+2}\n", "a:1", 0, "x");
    assert!(why.contains("implicit parameter"), "{why}");
}

// ---------------------------------------------------------------------------
// The language server, driven as an editor drives it.

struct Server {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    next_id: u64,
}

/// Every framed message on `stdout`, until it closes.
fn read_messages(stdout: ChildStdout) -> Receiver<Value> {
    let (sender, messages) = channel();
    std::thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        loop {
            let mut length = 0;
            loop {
                let mut line = String::new();
                if stdout.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.strip_prefix("Content-Length: ") {
                    length = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            if stdout.read_exact(&mut body).is_err()
                || sender.send(serde_json::from_slice(&body).unwrap()).is_err()
            {
                return;
            }
        }
    });
    messages
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn file_uri(path: &Path) -> String {
    let path = path.display().to_string().replace('\\', "/");
    if path.starts_with('/') {
        format!("file://{path}")
    } else {
        format!("file:///{path}")
    }
}

/// What an editor declares, as far as navigation reads it.
fn client() -> Value {
    json!({"textDocument": {
        "documentSymbol": {"hierarchicalDocumentSymbolSupport": true},
        "rename": {"prepareSupport": true},
    }})
}

impl Server {
    /// A server over the workspace `dir`, holding `files`, with what the
    /// client declares and the options it sends.
    fn over(dir: &Path, files: &[(&str, &str)], client: Value, options: Value) -> (Self, Value) {
        for (name, text) in files {
            if let Some(parent) = dir.join(name).parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(dir.join(name), text).unwrap();
        }
        let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(dir)
            .env("XDG_CONFIG_HOME", dir.join("no-such-config-home"))
            .args(["--lsp"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn qlinter --lsp");
        let stdin = child.stdin.take().unwrap();
        let messages = read_messages(child.stdout.take().unwrap());
        let mut server = Server {
            child,
            stdin,
            messages,
            next_id: 1,
        };
        let reply = server.request(
            "initialize",
            json!({"capabilities": client, "initializationOptions": options,
                   "workspaceFolders": [{"uri": file_uri(dir), "name": "ws"}]}),
        );
        server.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
        (server, reply)
    }

    fn start(dir: &Path, files: &[(&str, &str)]) -> Self {
        Self::over(dir, files, client(), Value::Null).0
    }

    fn send(&mut self, value: Value) {
        let body = serde_json::to_vec(&value).unwrap();
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.stdin.write_all(&body).unwrap();
        self.stdin.flush().unwrap();
    }

    /// The reply to a request, past the diagnostics pushed meanwhile.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        loop {
            let message = self
                .messages
                .recv_timeout(Duration::from_secs(30))
                .expect("the server answers");
            if message["id"] == id {
                return message;
            }
        }
    }

    fn open(&mut self, dir: &Path, name: &str, text: &str) -> String {
        let uri = file_uri(&dir.join(name));
        self.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
            "params":{"textDocument":{"uri":uri,"languageId":"q","version":1,"text":text}}}));
        uri
    }

    /// A request about the name at `context`+`skip` in the open document
    /// `uri`, whose text is `text`.
    fn ask(
        &mut self,
        method: &str,
        uri: &str,
        text: &str,
        context: &str,
        skip: usize,
        extra: Value,
    ) -> Value {
        let offset = at(text, context, skip);
        let line = text[..offset].matches('\n').count();
        let character = text[..offset]
            .rsplit('\n')
            .next()
            .unwrap()
            .encode_utf16()
            .count();
        let mut params = json!({"textDocument": {"uri": uri},
                                "position": {"line": line, "character": character}});
        for (key, value) in extra.as_object().into_iter().flatten() {
            params[key] = value.clone();
        }
        self.request(method, params)
    }
}

/// A range as `(line, start character, end character)`; no name spans lines.
fn span(range: &Value) -> (u64, u64, u64) {
    (
        range["start"]["line"].as_u64().unwrap(),
        range["start"]["character"].as_u64().unwrap(),
        range["end"]["character"].as_u64().unwrap(),
    )
}

/// Locations as `(file name, line, start, end)`, in order.
fn places(result: &Value) -> Vec<(String, u64, u64, u64)> {
    let mut out: Vec<_> = result
        .as_array()
        .unwrap_or_else(|| panic!("a list of locations, not {result}"))
        .iter()
        .map(|l| {
            let uri = l["uri"].as_str().unwrap();
            let (line, start, end) = span(&l["range"]);
            (
                uri.rsplit('/').next().unwrap().to_string(),
                line,
                start,
                end,
            )
        })
        .collect();
    out.sort();
    out
}

fn place(file: &str, line: u64, start: u64, end: u64) -> (String, u64, u64, u64) {
    (file.to_string(), line, start, end)
}

const LIB: &str = "\\d .lib\nadd:{[a;b] a+b}\nlimit:10\n\\d .\nroot_fn:{[v] v*2}\n";
const MAIN: &str = "\\l lib.q\ntotal:.lib.add[1;2]\ncalc:{[n] m:n+.lib.limit; root_fn m}\n\
                    \\d .lib\ntwice:{add[x;x]}\n";

#[test]
fn navigation_is_announced_and_can_be_turned_off() {
    let dir = tempfile::tempdir().unwrap();
    let (_, reply) = Server::over(dir.path(), &[], client(), Value::Null);
    let capabilities = &reply["result"]["capabilities"];
    for provider in [
        "documentSymbolProvider",
        "workspaceSymbolProvider",
        "definitionProvider",
        "referencesProvider",
        "documentHighlightProvider",
    ] {
        assert_eq!(capabilities[provider], true, "{provider}");
    }
    assert_eq!(
        capabilities["renameProvider"],
        json!({"prepareProvider": true})
    );
    // The options form is only for a client that prepares a rename.
    let (_, reply) = Server::over(dir.path(), &[], json!({}), Value::Null);
    assert_eq!(reply["result"]["capabilities"]["renameProvider"], true);

    // Off, nothing is announced - and a client that asks anyway is told
    // there is nothing, not that the method does not exist.
    let options = json!({"navigation": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", LIB)], client(), options);
    let capabilities = &reply["result"]["capabilities"];
    assert!(
        capabilities["definitionProvider"].is_null(),
        "{capabilities}"
    );
    assert!(capabilities["renameProvider"].is_null(), "{capabilities}");
    let uri = server.open(dir.path(), "main.q", MAIN);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        ".lib.add",
        5,
        json!({}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

/// A lambda left open ends where the next statement begins, at column 0:
/// read to the end of the file, `new:{` typed above three definitions made
/// them its body, and none of them was a definition any more (#2960).
#[test]
fn a_lambda_left_open_does_not_take_the_statements_after_it() {
    let defined = |source: &str| -> Vec<(String, String)> {
        mentions(source)
            .into_iter()
            .filter_map(|m| {
                let d = m.definition?;
                Some((m.name, source[d.start..d.end].to_string()))
            })
            .collect()
    };
    let is = |name: &str, statement: &str| (name.to_string(), statement.to_string());
    let rest = [is("f", "f:{[a;b] a+b}"), is("g", "g:{[c] f[c;1]}")];
    for open in ["new:{[a]\n  b:a+1;\n  {[c] c+", "new:(1;", "new:f[1;"] {
        let source = format!("{open}\nf:{{[a;b] a+b}}\ng:{{[c] f[c;1]}}\n");
        let mut all = vec![is("new", open)];
        all.extend(rest.clone());
        assert_eq!(defined(&source), all, "{open}");
    }
    // A line opening a string begins a statement too, and a comment at
    // column 0 does not.
    assert_eq!(
        defined("new:{[a]\n\"abc\",a}\nf:{[a;b] a+b}\ng:{[c] f[c;1]}\n")[1..],
        rest
    );
    assert_eq!(
        defined("new:{[a]\n/ note\n  a}\nf:{[a;b] a+b}\ng:{[c] f[c;1]}\n"),
        [
            is("new", "new:{[a]\n/ note\n  a}"),
            rest[0].clone(),
            rest[1].clone()
        ]
    );
    // A closer at column 0 still closes, as an older q read it.
    assert_eq!(
        defined("new:{[a]\n  a\n}\nf:{[a;b] a+b}\ng:{[c] f[c;1]}\n")[0],
        is("new", "new:{[a]\n  a\n}")
    );
}

/// The same from the server: the outline, the workspace's symbols and
/// another file's Go to Definition keep what follows a lambda being typed.
#[test]
fn the_definitions_after_a_lambda_being_typed_are_still_found() {
    let dir = tempfile::tempdir().unwrap();
    let text = "new:{\nf:{[a;b] a+b}\ng:{[c] f[c;1]}\n";
    let mut server = Server::start(dir.path(), &[("lib.q", text)]);
    let lib = server.open(dir.path(), "lib.q", text);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": lib}}),
    );
    let names: Vec<&str> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["new", "f", "g"], "{reply}");
    let reply = server.request("workspace/symbol", json!({"query": ""}));
    let mut names: Vec<&str> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["f", "g", "new"], "{reply}");
    let main = "r:g 1\n";
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.ask("textDocument/definition", &uri, main, "g 1", 0, json!({}));
    assert_eq!(places(&reply["result"]), [place("lib.q", 2, 0, 1)]);
}

#[test]
fn a_definition_is_found_in_another_file_under_the_context_it_is_written_in() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let lib_add = [place("lib.q", 1, 0, 3)];
    // Qualified, and bare under the `\d .lib` main.q switches to.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        ".lib.add",
        5,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), lib_add);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        "add[x;x]",
        0,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), lib_add);
    // lib.q is back at the root by the time it defines root_fn.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        "root_fn m",
        3,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("lib.q", 4, 0, 7)]);
    // The file was never opened: its location is the one a client can open.
    let found = reply["result"][0]["uri"].as_str().unwrap();
    assert!(
        found.starts_with("file://") && found.ends_with("/lib.q"),
        "{found}"
    );
}

/// Locations as `(file path under the workspace, line)`, in the order given.
fn ordered(result: &Value, dir: &Path) -> Vec<(String, u64)> {
    // An open document is named as the client named it, any other file by
    // its real path.
    let roots = [file_uri(&dir.canonicalize().unwrap()), file_uri(dir)];
    result
        .as_array()
        .unwrap_or_else(|| panic!("a list of locations, not {result}"))
        .iter()
        .map(|l| {
            let uri = l["uri"].as_str().unwrap();
            let file = roots
                .iter()
                .find_map(|root| uri.strip_prefix(&format!("{root}/")))
                .unwrap_or(uri);
            (
                file.to_string(),
                l["range"]["start"]["line"].as_u64().unwrap(),
            )
        })
        .collect()
}

#[test]
fn a_bare_name_four_scripts_define_goes_first_to_its_own_then_to_what_it_loads() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("lib")).unwrap();
    let main = "\\l lib/common.q\nopts:.Q.opt .z.x\nport:opts`port\n";
    let files = [
        ("lib/common.q", "/ defaults\nopts:()!()\n"),
        ("main.q", main),
        // It loads main.q, so may run in the same process.
        ("runner.q", "\\l main.q\nopts:`port`host!1 2\n"),
        // Another program, with an `opts` of its own.
        ("other.q", "opts:.Q.opt .z.x\n"),
    ];
    let mut server = Server::start(dir.path(), &files);
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        main,
        "opts`port",
        0,
        json!({}),
    );
    assert_eq!(
        ordered(&reply["result"], dir.path()),
        [
            ("main.q".to_string(), 1),
            ("lib/common.q".into(), 1),
            ("runner.q".into(), 1)
        ]
    );
    // A file defining it nowhere is given every one, what it loads first.
    let user = "\\l lib/common.q\nport:opts`port\n";
    let uri = server.open(dir.path(), "user.q", user);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        user,
        "opts`port",
        0,
        json!({}),
    );
    assert_eq!(
        ordered(&reply["result"], dir.path()),
        [
            ("lib/common.q".to_string(), 1),
            ("main.q".into(), 1),
            ("other.q".into(), 0),
            ("runner.q".into(), 1)
        ]
    );
}

#[test]
fn the_path_of_a_load_goes_to_the_file_it_loads() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("lib")).unwrap();
    let text = "\\l lib/common.q\nsystem \"l lib/common.q\";\n\\l lib/missing.q\n\\l lib\n";
    let files = [("lib/common.q", "c:1\n"), ("lib/more.q", "m:1\n")];
    let mut server = Server::start(dir.path(), &files);
    let uri = server.open(dir.path(), "main.q", text);
    for (context, skip) in [("\\l lib/common", 4), ("\"l lib/common", 12)] {
        let reply = server.ask(
            "textDocument/definition",
            &uri,
            text,
            context,
            skip,
            json!({}),
        );
        assert_eq!(
            ordered(&reply["result"], dir.path()),
            [("lib/common.q".to_string(), 0)],
            "{context}"
        );
    }
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "missing",
        2,
        json!({}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
    // A directory loads the scripts directly in it.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "\\l lib\n",
        4,
        json!({}),
    );
    assert_eq!(
        ordered(&reply["result"], dir.path()),
        [("lib/common.q".to_string(), 0), ("lib/more.q".into(), 0)]
    );
}

#[test]
fn a_local_goes_to_its_declaration_and_an_unknown_name_nowhere() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        "root_fn m",
        8,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("main.q", 2, 10, 11)]);
    let reply = server.ask("textDocument/definition", &uri, MAIN, "m:n+", 2, json!({}));
    assert_eq!(places(&reply["result"]), [place("main.q", 2, 7, 8)]);
    // A name nothing defines, and a place that is no name at all.
    let text = "f:{missing x}\n\n";
    let uri = server.open(dir.path(), "other.q", text);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "missing",
        2,
        json!({}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
    let reply = server.request(
        "textDocument/definition",
        json!({"textDocument": {"uri": uri}, "position": {"line": 1, "character": 0}}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

#[test]
fn an_open_buffer_is_read_as_the_editor_has_it_not_as_the_disk_does() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    // Unsaved: a comment above pushes the definition a line down.
    server.open(dir.path(), "lib.q", &format!("/ moved\n{LIB}"));
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        MAIN,
        ".lib.add",
        5,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("lib.q", 2, 0, 3)]);
}

/// With `lint.run: "onSave"` only the lint waits for a save: navigation
/// answers from the buffer on screen. A change was kept and not indexed,
/// so a name typed and not yet saved had no definition, and its rename was
/// refused as one no file assigns (#2174).
#[test]
fn with_run_on_save_navigation_reads_the_unsaved_buffer() {
    let dir = tempfile::tempdir().unwrap();
    let (lib, main) = ("f:{x+1}\n", "\\l lib.q\nnewf 1\n");
    let options = json!({"lint": {"run": "onSave"}});
    let files = [("lib.q", lib), ("main.q", main)];
    let (mut server, _) = Server::over(dir.path(), &files, client(), options);
    let uri = server.open(dir.path(), "main.q", main);
    let lib_uri = server.open(dir.path(), "lib.q", lib);
    let typed = "f:{x+1}\nnewf:{[a] a}\n";
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":lib_uri,"version":2},
                  "contentChanges":[{"text":typed}]}}));
    let reply = server.ask("textDocument/definition", &uri, main, "newf", 0, json!({}));
    assert_eq!(places(&reply["result"]), [place("lib.q", 1, 0, 4)]);
    let reply = server.ask(
        "textDocument/rename",
        &lib_uri,
        typed,
        "newf",
        0,
        json!({"newName": "g"}),
    );
    assert_eq!(
        reply["result"]["changes"].as_object().unwrap().len(),
        2,
        "{reply}"
    );
}

/// A file opened by another spelling of its path than the folder's - its
/// real path under a folder opened through a symlink, or another case on a
/// disk that ignores case - and closed again is still the workspace's: the
/// close compared the spelling with the folder's, found it outside, and
/// forgot the file's definitions until a restart (#2172).
#[cfg(unix)]
#[test]
fn a_file_closed_under_another_spelling_of_its_path_stays_in_the_index() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().canonicalize().unwrap().join("Real");
    std::fs::create_dir(&real).unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let lib = "helper:{x+1}\n";
    let main = "\\l lib.q\ng:{helper 1}\n";
    let mut server = Server::start(&link, &[("lib.q", lib), ("main.q", main)]);
    let uri = server.open(&link, "main.q", main);
    let found = |server: &mut Server| {
        let reply = server.ask(
            "textDocument/definition",
            &uri,
            main,
            "helper 1",
            0,
            json!({}),
        );
        places(&reply["result"])
    };
    assert_eq!(found(&mut server), [place("lib.q", 0, 0, 6)]);
    let mut spellings = vec![real.clone()];
    // The same folder in another case, where the disk takes it as one.
    let other_case = real.with_file_name("REAL");
    if other_case.exists() {
        spellings.push(other_case);
    }
    for folder in spellings {
        let opened = server.open(&folder, "lib.q", lib);
        server.send(json!({"jsonrpc":"2.0","method":"textDocument/didClose",
            "params":{"textDocument":{"uri":opened}}}));
        assert_eq!(found(&mut server), [place("lib.q", 0, 0, 6)], "{folder:?}");
        let reply = server.request("workspace/symbol", json!({"query": "helper"}));
        assert_eq!(reply["result"].as_array().unwrap().len(), 1, "{folder:?}");
    }
}

#[test]
fn a_column_delete_names_is_no_reference_and_no_bar_to_a_rename() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "px:{x}\nt:([]a:1 2;px:3 4)\nr:delete px from t\nr2:px 1\n";
    let uri = server.open(dir.path(), "a.q", text);
    let reply = server.ask(
        "textDocument/references",
        &uri,
        text,
        "px:{x}",
        0,
        json!({}),
    );
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 0, 2), place("a.q", 3, 3, 5)]
    );
    // And the rename the column refused goes through, leaving the column.
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        text,
        "px:{x}",
        0,
        json!({"newName": "price"}),
    );
    assert!(reply["error"].is_null(), "{reply}");
    assert!(!reply["result"].is_null(), "{reply}");
}

#[test]
fn a_file_loaded_under_a_context_defines_its_names_there() {
    let dir = tempfile::tempdir().unwrap();
    let part = "helper:{x+1}\nuse:{helper x}\n";
    let files = [("loader.q", "\\d .a\n\\l part.q\n"), ("part.q", part)];
    let mut server = Server::start(dir.path(), &files);
    let text = "r:.a.helper 3\n";
    let uri = server.open(dir.path(), "user.q", text);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        ".a.helper",
        4,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("part.q", 0, 0, 6)]);
    // And part.q's own bare read of it is a reference to the same name.
    let reply = server.ask(
        "textDocument/references",
        &uri,
        text,
        ".a.helper",
        4,
        json!({}),
    );
    assert_eq!(
        places(&reply["result"]),
        [
            place("part.q", 0, 0, 6),
            place("part.q", 1, 5, 11),
            place("user.q", 0, 2, 11)
        ]
    );
}

#[test]
fn a_kdbx_modules_names_are_found_in_its_own_context() {
    // KDB-X 5, with QPATH holding mymod/init.q: `` m:use`mymod `` runs it
    // in `.m.mymod` - `` key`.m.mymod `` is ``` ``helper`f`g`export ``` -
    // and root `helper` is 'helper (#2320).
    let dir = tempfile::tempdir().unwrap();
    let module = "helper:{x*2}\nf:{helper x+1}\ng:{[a;b] a+b}\nexport:([f;g])\n";
    let files = [("mymod/init.q", module), ("user.q", "m:use`mymod\n")];
    let mut server = Server::start(dir.path(), &files);
    let text = "r:helper 3\ns:.m.mymod.helper 4\n";
    let uri = server.open(dir.path(), "other.q", text);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "helper 3",
        0,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), []);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        ".m.mymod.helper",
        10,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("init.q", 0, 0, 6)]);
    // The module's own read is a reference to it, and the root read is not.
    let reply = server.ask(
        "textDocument/references",
        &uri,
        text,
        ".m.mymod.helper",
        10,
        json!({"context": {"includeDeclaration": true}}),
    );
    assert_eq!(
        places(&reply["result"]),
        [
            place("init.q", 0, 0, 6),
            place("init.q", 1, 3, 9),
            place("other.q", 1, 2, 17)
        ]
    );
    let reply = server.request("workspace/symbol", json!({"query": "f"}));
    let names: Vec<&str> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["name"].as_str())
        .collect();
    assert!(names.contains(&".m.mymod.f"), "{names:?}");
    assert!(!names.contains(&"f"), "{names:?}");
}

#[test]
fn a_script_that_assigns_export_keeps_its_names_at_the_root() {
    // KDB-X 5: `\l a.q` then `util 1` is 2, and `key `.m` is `()`. Only a
    // `use` makes a module of a file that assigns `export` (#2668).
    let dir = tempfile::tempdir().unwrap();
    let script = "/ csv helpers\nexport:{[t;f] (`$\":\",f) 0: csv 0: t}\nutil:{x+1}\n";
    let mut server = Server::start(dir.path(), &[("a.q", script)]);
    let text = "r:util 1\n";
    let uri = server.open(dir.path(), "b.q", text);
    let reply = server.ask("textDocument/definition", &uri, text, "util", 0, json!({}));
    assert_eq!(places(&reply["result"]), [place("a.q", 2, 0, 4)]);
    let reply = server.ask("textDocument/hover", &uri, text, "util", 0, json!({}));
    let hover = reply["result"]["contents"]["value"].as_str().unwrap();
    assert!(hover.starts_with("util[x]"), "{hover}");
    let reply = server.request("workspace/symbol", json!({"query": "util"}));
    let names: Vec<&str> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["name"].as_str())
        .collect();
    assert_eq!(names, ["util"]);
}

#[test]
fn a_name_only_its_namespace_or_dot_q_defines_goes_there() {
    let dir = tempfile::tempdir().unwrap();
    let files = [("cfg.q", ".cfg:`n`m!1 2\n"), ("q.q", ".q.answer:{42}\n")];
    let mut server = Server::start(dir.path(), &files);
    let text = "v:.cfg.n\n\\d .u\nf:{answer[]}\n";
    let uri = server.open(dir.path(), "user.q", text);
    // `.cfg` is assigned whole, which is where `.cfg.n` comes from.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        ".cfg.n",
        5,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("cfg.q", 0, 0, 4)]);
    // q looks in `.q` from every context for a name nothing else defines.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "answer",
        0,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("q.q", 0, 0, 9)]);
    let reply = server.ask(
        "textDocument/references",
        &uri,
        text,
        "answer",
        0,
        json!({}),
    );
    assert_eq!(
        places(&reply["result"]),
        [place("q.q", 0, 0, 9), place("user.q", 2, 3, 9)]
    );
}

#[test]
fn references_are_every_file_that_names_it_with_or_without_the_declaration() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let reads = [place("main.q", 1, 6, 14), place("main.q", 4, 7, 10)];
    let reply = server.ask(
        "textDocument/references",
        &uri,
        MAIN,
        ".lib.add",
        5,
        json!({}),
    );
    let mut all = vec![place("lib.q", 1, 0, 3)];
    all.extend(reads.clone());
    assert_eq!(places(&reply["result"]), all);
    let context = json!({"context": {"includeDeclaration": false}});
    let reply = server.ask(
        "textDocument/references",
        &uri,
        MAIN,
        ".lib.add",
        5,
        context.clone(),
    );
    assert_eq!(places(&reply["result"]), reads);

    // A local's are in its own lambda, and its declaration is the one place
    // left out.
    let reply = server.ask("textDocument/references", &uri, MAIN, "m:n+", 0, json!({}));
    assert_eq!(
        places(&reply["result"]),
        [place("main.q", 2, 10, 11), place("main.q", 2, 34, 35)]
    );
    let reply = server.ask("textDocument/references", &uri, MAIN, "m:n+", 0, context);
    assert_eq!(places(&reply["result"]), [place("main.q", 2, 34, 35)]);
}

#[test]
fn highlights_mark_a_write_apart_from_a_read() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "n:0\nbump:{n::n+1; t:x; t+:1; t}\n";
    let uri = server.open(dir.path(), "a.q", text);
    let marks = |reply: &Value| -> Vec<((u64, u64, u64), u64)> {
        reply["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| (span(&h["range"]), h["kind"].as_u64().unwrap()))
            .collect()
    };
    // LSP's DocumentHighlightKind: 2 is a read, 3 a write.
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        text,
        "n::n",
        0,
        json!({}),
    );
    assert_eq!(
        marks(&reply),
        [((0, 0, 1), 3), ((1, 6, 7), 3), ((1, 9, 10), 2)]
    );
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        text,
        "t:x",
        0,
        json!({}),
    );
    assert_eq!(
        marks(&reply),
        [((1, 14, 15), 3), ((1, 19, 20), 3), ((1, 25, 26), 2)]
    );
    // A global amended through an index is written, `v[0]:2` and
    // `v[1]+:3` (KDB-X), and one only indexed is read (#1246).
    let text = "v:1 2\nv[0]:2\nv[1]+:3\nw:v[0]\n";
    let uri = server.open(dir.path(), "b.q", text);
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        text,
        "v:1",
        0,
        json!({}),
    );
    assert_eq!(
        marks(&reply),
        [
            ((0, 0, 1), 3),
            ((1, 0, 1), 3),
            ((2, 0, 1), 3),
            ((3, 2, 3), 2)
        ]
    );
    // A table changed in place by its name is written (#2054). KDB-X 5,
    // `tb:([]c:3 1 2)`: the update makes c 6 2 4, the xasc 2 4 6, the amend
    // -2 -4 -6; the select and `?[`tb;..]` change nothing.
    let text = "tb:([]c:3 1 2)\nupdate c:c*2 from `tb\n`c xasc `tb\n@[`tb;`c;neg]\n\
                delete from `tb where c>5\nselect from `tb\n?[`tb;();0b;()]\n";
    let uri = server.open(dir.path(), "c.q", text);
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        text,
        "tb:",
        0,
        json!({}),
    );
    assert_eq!(
        marks(&reply),
        [
            ((0, 0, 2), 3),
            ((1, 19, 21), 3),
            ((2, 9, 11), 3),
            ((3, 3, 5), 3),
            ((4, 13, 15), 3),
            ((5, 13, 15), 2),
            ((6, 3, 5), 2)
        ]
    );
    // A symbol that may be the name is marked as text, kind 1, wherever
    // Find References lists it: `` `hb in tables `. `` and the `` `hb ``
    // returned, beside the write by name and the read (#2679).
    let text = "init:{[] if[not `hb in tables `.; `hb set ([] w:`symbol$())];\n  `hb}\n\
                r:select from hb\n";
    let uri = server.open(dir.path(), "d.q", text);
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        text,
        "from hb",
        5,
        json!({}),
    );
    assert_eq!(
        marks(&reply),
        [
            ((0, 17, 19), 1),
            ((0, 35, 37), 3),
            ((1, 3, 5), 1),
            ((2, 14, 16), 2)
        ]
    );
}

#[test]
fn a_dictionary_pattern_outlines_what_it_binds_and_not_its_keys() {
    // KDB-X 5 binds vv, b1, b2 and p for these, and neither kk, b nor the
    // filter neg: `value`kk` and `value`b` are 'kk and 'b (#2330, #2329).
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "d:`kk`b!(1;2 3)\n([kk:vv]):d\n([b:(b1;b2)]):d\n([k:p:neg]):`k`z!5 6\n";
    let uri = server.open(dir.path(), "pa.q", text);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    let names: Vec<&str> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["d", "vv", "b1", "b2", "p"]);
    let reply = server.request("workspace/symbol", json!({"query": "kk"}));
    assert_eq!(reply["result"], json!([]), "{reply}");
}

#[test]
fn the_outline_lists_what_the_document_assigns() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "lib.q", LIB);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    let symbols = reply["result"].as_array().unwrap();
    let listed = |symbols: &[Value]| -> Vec<_> {
        symbols
            .iter()
            .map(|s| {
                (
                    s["name"].as_str().unwrap().to_string(),
                    s["kind"].as_u64().unwrap(),
                    s["detail"].as_str().unwrap().to_string(),
                    span(&s["range"]),
                    span(&s["selectionRange"]),
                )
            })
            .collect()
    };
    // LSP's SymbolKind: 3 is a namespace, 12 a function, 13 a variable.
    // `.lib`'s names are under it, by the last part of their name.
    assert_eq!(symbols.len(), 2);
    let lib = &symbols[0];
    assert_eq!((&lib["name"], &lib["kind"]), (&json!(".lib"), &json!(3)));
    assert_eq!(lib["range"]["start"], json!({"line": 1, "character": 0}));
    assert_eq!(lib["range"]["end"], json!({"line": 2, "character": 8}));
    assert_eq!(span(&lib["selectionRange"]), (1, 0, 3));
    assert_eq!(
        listed(lib["children"].as_array().unwrap()),
        [
            (
                "add".to_string(),
                12,
                "[a;b]".to_string(),
                (1, 0, 15),
                (1, 0, 3)
            ),
            ("limit".into(), 13, "".into(), (2, 0, 8), (2, 0, 5)),
        ]
    );
    assert_eq!(
        listed(&symbols[1..]),
        [(
            "root_fn".to_string(),
            12,
            "[v]".to_string(),
            (4, 0, 17),
            (4, 0, 7)
        )]
    );

    // A name assigned again is one line, where it is first assigned - and
    // each assignment is still a definition to go to.
    let text = "state:0\nreset:{state::0}\nstate:1\n";
    let uri = server.open(dir.path(), "state.q", text);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    let names: Vec<_> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["name"].as_str().unwrap(), span(&s["selectionRange"])))
        .collect();
    assert_eq!(names, [("state", (0, 0, 5)), ("reset", (1, 0, 5))]);
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "state::0",
        0,
        json!({}),
    );
    assert_eq!(
        places(&reply["result"]),
        [
            place("state.q", 0, 0, 5),
            place("state.q", 1, 7, 12),
            place("state.q", 2, 0, 5)
        ]
    );

    // A client that does not take the nested form gets the flat one.
    let dir = tempfile::tempdir().unwrap();
    let (mut server, _) = Server::over(dir.path(), &[], json!({}), Value::Null);
    let uri = server.open(dir.path(), "lib.q", LIB);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    let flat = reply["result"].as_array().unwrap();
    assert_eq!(flat.len(), 3);
    assert_eq!(flat[0]["name"], ".lib.add");
    assert_eq!(flat[0]["location"]["uri"], uri);
    assert_eq!(span(&flat[0]["location"]["range"]), (1, 0, 3));
}

/// An outline as `name(child, ...)`, one entry for each top-level symbol.
fn tree(symbols: &Value) -> Vec<String> {
    symbols
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let name = s["name"].as_str().unwrap().to_string();
            match s["children"].as_array() {
                Some(_) => format!("{name}({})", tree(&s["children"]).join(", ")),
                None => name,
            }
        })
        .collect()
}

#[test]
fn the_outline_groups_names_by_the_namespace_they_are_in() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    // One level per namespace written into, `.qetl.io` beside `.qetl.cfg`
    // and not under a `.qetl` of its own; a namespace assigned whole holds
    // the names in it; `\d` names one as a dotted name does - `write` is in
    // `.qetl.io` as `read` is, in a node of its own for being written
    // after `.qetl.cfg` (#2029).
    let text = "opts:.Q.opt .z.x\n.qetl.io.read:{x}\n.qetl.cfg:()!()\n\
                .qetl.cfg.port:5010\n\\d .qetl.io\nwrite:{x}\n\\d .\n.z.ps:{x}\n\
                .qetl.io.batch.size:10\n";
    let uri = server.open(dir.path(), "a.q", text);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    assert_eq!(
        tree(&reply["result"]),
        [
            "opts",
            ".qetl.io(read)",
            ".qetl.cfg(port)",
            ".qetl.io(write)",
            ".z(ps)",
            ".qetl.io.batch(size)",
        ]
    );
    // `.qetl.cfg` is its own assignment, a variable, spanning the names in it.
    let cfg = &reply["result"][2];
    assert_eq!(cfg["kind"], 13);
    assert_eq!(span(&cfg["selectionRange"]), (2, 0, 9));
    assert_eq!(cfg["range"]["end"], json!({"line": 3, "character": 19}));
}

#[test]
fn a_namespace_written_in_two_places_is_a_node_for_each() {
    // #2029: one node for a namespace, spanning from its first name to its
    // last, took in whatever was written between them - `.bb.g` on line 1
    // inside the range of `.aa`, which it is not in - and an editor names
    // the symbol at a position by the first range that holds it.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let outline = |server: &mut Server, name: &str, text: &str| {
        let uri = server.open(dir.path(), name, text);
        let reply = server.request(
            "textDocument/documentSymbol",
            json!({"textDocument": {"uri": uri}}),
        );
        reply["result"].clone()
    };
    let lines = |symbols: &Value| -> Vec<(u64, u64)> {
        let line = |s: &Value, end: &str| s["range"][end]["line"].as_u64().unwrap();
        let all = symbols.as_array().unwrap().iter();
        all.map(|s| (line(s, "start"), line(s, "end"))).collect()
    };
    let symbols = outline(
        &mut server,
        "a.q",
        ".aa.f:{x}\n.bb.g:{x}\n.aa.h:{x+1}\nplain:1\n.aa.k:2\n.aa.l:{\n x}\n\
         \\d .bb\nm:1\n\\d .aa\nn:2\n",
    );
    assert_eq!(
        tree(&symbols),
        [
            ".aa(f)",
            ".bb(g)",
            ".aa(h)",
            "plain",
            ".aa(k, l)",
            ".bb(m)",
            ".aa(n)"
        ]
    );
    // Each spans its own names and nothing else: no two share a line.
    assert_eq!(
        lines(&symbols),
        [(0, 0), (1, 1), (2, 2), (3, 3), (4, 6), (8, 8), (10, 10)]
    );
    // A namespace assigned whole is that assignment where it is written,
    // and a namespace where it is only written into.
    let symbols = outline(
        &mut server,
        "own.q",
        ".cfg.port:1\nother:2\n.cfg:()!()\n.cfg.host:3\n",
    );
    assert_eq!(tree(&symbols), [".cfg(port)", "other", ".cfg(host)"]);
    assert_eq!(lines(&symbols), [(0, 0), (1, 1), (2, 3)]);
    assert_eq!(
        (&symbols[0]["kind"], &symbols[2]["kind"]),
        (&json!(3), &json!(13))
    );
    assert_eq!(span(&symbols[2]["selectionRange"]), (2, 0, 4));
    // A name set inside a statement is written there, not between two
    // statements: it parts nothing, and joins nothing after it.
    let symbols = outline(
        &mut server,
        "in.q",
        ".aa.f:{.bb.g::x}\n.aa.h:1\nplain:{.aa.i::1}\n.aa.j:2\n",
    );
    assert_eq!(
        tree(&symbols),
        [".aa(f, h)", ".bb(g)", "plain", ".aa(i)", ".aa(j)"]
    );
    assert_eq!(lines(&symbols), [(0, 1), (0, 0), (2, 2), (2, 2), (3, 3)]);
}

#[test]
fn workspace_symbols_match_a_query_whatever_its_case() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB), ("main.q", MAIN)]);
    let names = |reply: &Value| -> Vec<(String, u64)> {
        let mut names: Vec<_> = reply["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    s["name"].as_str().unwrap().to_string(),
                    s["kind"].as_u64().unwrap(),
                )
            })
            .collect();
        names.sort();
        names
    };
    let reply = server.request("workspace/symbol", json!({"query": "LIB.A"}));
    assert_eq!(names(&reply), [(".lib.add".to_string(), 12)]);
    assert_eq!(
        places(&json!([reply["result"][0]["location"]])),
        [place("lib.q", 1, 0, 3)]
    );
    let reply = server.request("workspace/symbol", json!({"query": "t"}));
    assert_eq!(
        names(&reply),
        [
            (".lib.limit".to_string(), 13),
            (".lib.twice".into(), 12),
            ("root_fn".into(), 12),
            ("total".into(), 13),
        ]
    );
    // An empty query is every symbol.
    let reply = server.request("workspace/symbol", json!({"query": ""}));
    assert_eq!(names(&reply).len(), 6);
}

#[test]
fn workspace_symbols_rank_an_exact_name_before_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    // 650 names holding `st`, in a file listed before the one defining `st`
    // itself - which the cap of 512 used to drop.
    let many: String = (0..650).map(|n| format!("first{n}:{n}\n")).collect();
    let files = [
        ("a.q", many.as_str()),
        (
            "z.q",
            "st:1\n.u.st:2\nstate:3\n.qetl.bounded.fail_run:{x}\n.qetl.bounded.ok:1\n",
        ),
    ];
    let mut server = Server::start(dir.path(), &files);
    let names = |reply: &Value| -> Vec<String> {
        reply["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect()
    };
    let reply = server.request("workspace/symbol", json!({"query": "st"}));
    let found = names(&reply);
    assert_eq!(found.len(), 512);
    // The name, then its last segment, then what starts with it.
    assert_eq!(found[..3], ["st", ".u.st", "state"]);
    assert_eq!(
        places(&json!([reply["result"][0]["location"]])),
        [place("z.q", 0, 0, 2)]
    );
    // Every word of a query of several, and the letters in order last.
    let reply = server.request("workspace/symbol", json!({"query": "bounded FAIL"}));
    assert_eq!(names(&reply), [".qetl.bounded.fail_run"]);
    let reply = server.request("workspace/symbol", json!({"query": "qbok"}));
    assert_eq!(names(&reply), [".qetl.bounded.ok"]);
}

#[test]
fn a_local_is_renamed_in_its_own_document() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    let reply = server.ask(
        "textDocument/prepareRename",
        &uri,
        MAIN,
        "m:n+",
        0,
        json!({}),
    );
    assert_eq!(span(&reply["result"]["range"]), (2, 10, 11));
    assert_eq!(reply["result"]["placeholder"], "m");
    let new = json!({"newName": "sum_"});
    let reply = server.ask("textDocument/rename", &uri, MAIN, "m:n+", 0, new.clone());
    let edits = reply["result"]["changes"][&uri].as_array().unwrap();
    let spans: Vec<_> = edits.iter().map(|e| span(&e["range"])).collect();
    assert_eq!(spans, [(2, 10, 11), (2, 34, 35)]);
    assert!(edits.iter().all(|e| e["newText"] == "sum_"));
    assert_eq!(reply["result"]["changes"].as_object().unwrap().len(), 1);

    // LSP 3.17's RequestFailed, with why - which an editor shows.
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        MAIN,
        "m:n+",
        0,
        json!({"newName": "n"}),
    );
    assert_eq!(reply["error"]["code"], -32803, "{reply}");
}

#[test]
fn a_position_is_counted_in_utf16_units_as_a_client_counts_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    // `é` is one UTF-16 unit and two bytes; the emoji two units and four.
    let text = "f:{[v] s:\"é😀\"; s,v}\r\ng:{f x}\r\n";
    let uri = server.open(dir.path(), "a.q", text);
    let reply = server.request(
        "textDocument/references",
        json!({"textDocument": {"uri": uri}, "position": {"line": 0, "character": 18}}),
    );
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 4, 5), place("a.q", 0, 18, 19)]
    );
    // A position past the end of its line, or of the document, is its end.
    let reply = server.request(
        "textDocument/definition",
        json!({"textDocument": {"uri": uri}, "position": {"line": 1, "character": 99}}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
    let reply = server.request(
        "textDocument/definition",
        json!({"textDocument": {"uri": uri}, "position": {"line": 99, "character": 0}}),
    );
    assert_eq!(reply["result"], Value::Null, "{reply}");
}

#[test]
fn a_request_with_no_document_is_refused_and_one_for_an_unknown_document_empty() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let reply = server.request(
        "textDocument/definition",
        json!({"position": {"line": 0, "character": 0}}),
    );
    assert_eq!(reply["error"]["code"], -32602, "{reply}");
    // Never opened, and a buffer that is no `.q` file on disk.
    let unknown = file_uri(&dir.path().join("unopened.q"));
    let position = json!({"line": 0, "character": 0});
    let reply = server.request(
        "textDocument/references",
        json!({"textDocument": {"uri": unknown}, "position": position}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
    server.send(json!({"jsonrpc":"2.0","method":"textDocument/didOpen",
        "params":{"textDocument":{"uri":"untitled:Untitled-1","languageId":"q","version":1,"text":"f:{x}\n"}}}));
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": "untitled:Untitled-1"}}),
    );
    assert_eq!(reply["result"], json!([]), "{reply}");
}

#[test]
fn a_file_that_starts_with_a_bom_is_navigated_like_any_other() {
    // #859: the name right after the BOM was cut at its second byte, inside
    // the BOM, and every request resolving it failed.
    let dir = tempfile::tempdir().unwrap();
    let lib = "\u{feff}zz_bom:{[a] a+1}\n";
    let mut server = Server::start(dir.path(), &[("bom.q", lib)]);
    // Open, and sent with its BOM: read from disk the BOM is no part of
    // the text (#2027), so only a client that sends one has the server
    // hold it.
    server.open(dir.path(), "bom.q", lib);
    let text = "r:zz_bom[1]\ng:{zz_bom x}\n";
    let uri = server.open(dir.path(), "use.q", text);
    // The BOM is one UTF-16 unit, so the name is at character 1.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        text,
        "zz_bom[1]",
        3,
        json!({}),
    );
    assert_eq!(places(&reply["result"]), [place("bom.q", 0, 1, 7)]);
    let reply = server.ask("textDocument/hover", &uri, text, "zz_bom[1]", 3, json!({}));
    assert_eq!(
        reply["result"]["contents"]["value"], "zz_bom[a]\n\nbom.q",
        "{reply}"
    );
    let reply = server.ask(
        "textDocument/references",
        &uri,
        text,
        "zz_bom[1]",
        3,
        json!({"context": {"includeDeclaration": true}}),
    );
    assert_eq!(
        places(&reply["result"]),
        [
            place("bom.q", 0, 1, 7),
            place("use.q", 0, 2, 8),
            place("use.q", 1, 3, 9)
        ]
    );
    let reply = server.ask(
        "textDocument/signatureHelp",
        &uri,
        text,
        "zz_bom[1]",
        7,
        json!({}),
    );
    assert_eq!(
        reply["result"]["signatures"][0]["label"], "zz_bom[a]",
        "{reply}"
    );
    let reply = server.ask(
        "textDocument/prepareCallHierarchy",
        &uri,
        text,
        "zz_bom[1]",
        3,
        json!({}),
    );
    let item = &reply["result"][0];
    assert_eq!(item["name"], "zz_bom", "{reply}");
    let reply = server.request("callHierarchy/incomingCalls", json!({"item": item}));
    let callers: Vec<&str> = reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("a list of calls, not {reply}"))
        .iter()
        .map(|call| call["from"]["name"].as_str().unwrap())
        .collect();
    assert!(callers.contains(&"g"), "{reply}");
    let reply = server.request("workspace/symbol", json!({"query": "zz_bom"}));
    let symbol = &reply["result"][0];
    assert_eq!(symbol["name"], "zz_bom", "{reply}");
    assert_eq!(span(&symbol["location"]["range"]), (0, 1, 7));
}

#[test]
fn a_closed_file_with_a_bom_is_placed_as_an_editor_holds_it() {
    // #2027: an editor reads a file's BOM as its encoding, not as a
    // character of line 0, so the text it holds - and applies an edit to -
    // starts at the name. The server kept the BOM in what it read from
    // disk, every place on line 0 of a closed file was one to the right,
    // and a rename from another file turned `gfn:{[a] a+1}` into
    // `ggfz{[a] a+1}`.
    let dir = tempfile::tempdir().unwrap();
    let lib = "\u{feff}gfn:{[a] a+1}\nu1:gfn 2\n";
    let mut server = Server::start(dir.path(), &[("lib.q", lib)]);
    let text = "r:gfn 1\n";
    let uri = server.open(dir.path(), "main.q", text);
    let reply = server.ask("textDocument/definition", &uri, text, "gfn", 1, json!({}));
    assert_eq!(places(&reply["result"]), [place("lib.q", 0, 0, 3)]);
    let reply = server.ask(
        "textDocument/references",
        &uri,
        text,
        "gfn",
        1,
        json!({"context": {"includeDeclaration": true}}),
    );
    assert_eq!(
        places(&reply["result"]),
        [
            place("lib.q", 0, 0, 3),
            place("lib.q", 1, 3, 6),
            place("main.q", 0, 2, 5)
        ]
    );
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        text,
        "gfn",
        1,
        json!({"newName": "gfz"}),
    );
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("lib.q", 0, 0, 3, "gfz"),
            edit("lib.q", 1, 3, 6, "gfz"),
            edit("main.q", 0, 2, 5, "gfz"),
        ],
        "{reply}"
    );
    let reply = server.request("workspace/symbol", json!({"query": "gfn"}));
    let symbol = &reply["result"][0];
    assert_eq!(symbol["name"], "gfn", "{reply}");
    assert_eq!(span(&symbol["location"]["range"]), (0, 0, 3));
    // Opened by a client that does send the BOM as text, it is a character
    // of the document, and the places follow the document.
    server.open(dir.path(), "lib.q", lib);
    let reply = server.ask("textDocument/definition", &uri, text, "gfn", 1, json!({}));
    assert_eq!(places(&reply["result"]), [place("lib.q", 0, 1, 4)]);
}

#[test]
fn a_computed_set_target_is_no_definition_of_the_name_it_ends_in() {
    // #860: q 5 `ns:`.app; (` sv ns,`run) set {x+1}` defines `.app.run`,
    // not a root `run` - nor does `(st`pending) upsert t` write `pending`.
    let dir = tempfile::tempdir().unwrap();
    let lib = "ns:`.app\n(` sv ns,`run) set {x+1}\n(st`pending) upsert t\n(`e) set 5\n";
    let mut server = Server::start(dir.path(), &[("lib.q", lib)]);
    for query in ["run", "pending"] {
        let reply = server.request("workspace/symbol", json!({"query": query}));
        assert_eq!(reply["result"], json!([]), "{reply}");
    }
    let text = "n:exec run from t\nr:pending\ns:e\n";
    let uri = server.open(dir.path(), "use.q", text);
    for context in ["run from", "pending"] {
        let reply = server.ask("textDocument/definition", &uri, text, context, 1, json!({}));
        assert_eq!(reply["result"], json!([]), "{context}: {reply}");
    }
    // A symbol alone in parentheses still names what it sets.
    let reply = server.ask("textDocument/definition", &uri, text, "s:e", 2, json!({}));
    assert_eq!(places(&reply["result"]), [place("lib.q", 3, 2, 3)]);
}

/// Each edit of a rename as `(file name, line, start, end, new text)`.
fn edits(result: &Value) -> Vec<(String, u64, u64, u64, String)> {
    let mut out = vec![];
    for (uri, list) in result["changes"]
        .as_object()
        .unwrap_or_else(|| panic!("a workspace edit, not {result}"))
    {
        for edit in list.as_array().unwrap() {
            let (line, start, end) = span(&edit["range"]);
            out.push((
                uri.rsplit('/').next().unwrap().to_string(),
                line,
                start,
                end,
                edit["newText"].as_str().unwrap().to_string(),
            ));
        }
    }
    out.sort();
    out
}

fn edit(file: &str, line: u64, start: u64, end: u64, new: &str) -> (String, u64, u64, u64, String) {
    (file.to_string(), line, start, end, new.to_string())
}

/// The message of a refused request.
fn refused(reply: &Value) -> String {
    assert_eq!(reply["error"]["code"], -32803, "{reply}");
    reply["error"]["message"].as_str().unwrap().to_string()
}

#[test]
fn a_modules_own_name_is_renamed_and_an_exported_one_refused() {
    // KDB-X 5: `key `.m.mymod` is ``` ``helper`f`g`export ```, names the
    // module's file assigns and none of q's (#2666).
    let dir = tempfile::tempdir().unwrap();
    let module = "helper:{[hh] hh+1}\nf:{helper x}\ng:{[a] a*2}\nexport:([f;g])\n";
    let main = "m:use`mymod\nr:m.f 2\ns:.m.mymod.helper 3\n";
    let mut server = Server::start(dir.path(), &[("main.q", main)]);
    let uri = server.open(dir.path(), "mymod/init.q", module);
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        module,
        "helper:",
        0,
        json!({"newName": "hp"}),
    );
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("init.q", 0, 0, 6, "hp"),
            edit("init.q", 1, 3, 9, "hp"),
            edit("main.q", 2, 11, 17, "hp"),
        ],
        "{reply}"
    );
    // `([f;g])` keys what `use` returns by `f`, and main.q reads `m.f`.
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        module,
        "f:",
        0,
        json!({"newName": "ff"}),
    );
    assert!(refused(&reply).contains("exports"), "{reply}");
}

#[test]
fn a_global_is_renamed_in_every_file_that_names_it_under_its_context() {
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[("lib.q", LIB)]);
    let uri = server.open(dir.path(), "main.q", MAIN);
    // On `.lib.add`, only the last part is renamed: the prepared range and
    // placeholder are `add`.
    let reply = server.ask(
        "textDocument/prepareRename",
        &uri,
        MAIN,
        ".lib.add",
        6,
        json!({}),
    );
    assert_eq!(span(&reply["result"]["range"]), (1, 11, 14), "{reply}");
    assert_eq!(reply["result"]["placeholder"], "add");
    // lib.q writes it bare under `\d .lib`, main.q qualified and bare.
    let want = [
        edit("lib.q", 1, 0, 3, "plus"),
        edit("main.q", 1, 11, 14, "plus"),
        edit("main.q", 4, 7, 10, "plus"),
    ];
    for new in ["plus", ".lib.plus"] {
        let reply = server.ask(
            "textDocument/rename",
            &uri,
            MAIN,
            ".lib.add",
            6,
            json!({"newName": new}),
        );
        assert_eq!(edits(&reply["result"]), want, "{new}: {reply}");
    }
    // From lib.q's bare `add` under `\d .lib` too, and `.lib.plus` is the
    // namespace it resolves to (#2049); another namespace is still refused.
    let lib = server.open(dir.path(), "lib.q", LIB);
    for new in ["plus", ".lib.plus"] {
        let reply = server.ask(
            "textDocument/rename",
            &lib,
            LIB,
            "add:",
            0,
            json!({"newName": new}),
        );
        assert_eq!(edits(&reply["result"]), want, "{new}: {reply}");
    }
    let reply = server.ask(
        "textDocument/rename",
        &lib,
        LIB,
        "add:",
        0,
        json!({"newName": ".other.plus"}),
    );
    assert!(refused(&reply).contains("another namespace"), "{reply}");
    // And from a bare spelling, a name at the root defined in another file.
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        MAIN,
        "root_fn m",
        0,
        json!({"newName": "double"}),
    );
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("lib.q", 4, 0, 7, "double"),
            edit("main.q", 2, 26, 33, "double")
        ]
    );
    // `.lib.limit` is named in main.q, inside `calc`'s lambda, qualified -
    // so a local `m` there hides nothing.
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        MAIN,
        ".lib.limit",
        6,
        json!({"newName": "m"}),
    );
    assert_eq!(edits(&reply["result"]).len(), 2, "{reply}");
}

#[test]
fn a_global_rename_is_refused_where_it_would_change_what_the_code_means() {
    let dir = tempfile::tempdir().unwrap();
    let lib = "helper:{x+1}\ntotal:0\nuse:{[n] helper n}\n";
    let mut server = Server::start(dir.path(), &[("lib.q", lib)]);
    let main = "\\l lib.q\nrun:{[v] helper v}\nt:.z.p\nn:count til 3\nother:.q.x\n";
    let uri = server.open(dir.path(), "main.q", main);
    let ask = |server: &mut Server, context: &str, new: &str| {
        server.ask(
            "textDocument/rename",
            &uri,
            main,
            context,
            0,
            json!({"newName": new}),
        )
    };
    let why = refused(&ask(&mut server, "helper v", "total"));
    assert!(why.contains("`total` is already assigned"), "{why}");
    let why = refused(&ask(&mut server, "helper v", "v"));
    assert!(
        why.contains("parameter or local") && why.contains("main.q:2"),
        "{why}"
    );
    for bad in ["count", "select", "2x", "a-b", ""] {
        let why = refused(&ask(&mut server, "helper v", bad));
        assert!(
            why.contains("builtin") || why.contains("not a name"),
            "{bad}: {why}"
        );
    }
    let why = refused(&ask(&mut server, "helper v", ".elsewhere.helper"));
    assert!(why.contains("last part of a name only"), "{why}");
    // q's own names, and one nothing in the workspace assigns.
    for method in ["textDocument/prepareRename", "textDocument/rename"] {
        let reply = server.ask(method, &uri, main, ".z.p", 3, json!({"newName": "q"}));
        assert!(refused(&reply).contains("namespace q keeps"), "{reply}");
        let reply = server.ask(method, &uri, main, ".q.x", 3, json!({"newName": "q"}));
        assert!(refused(&reply).contains("namespace q keeps"), "{reply}");
    }
    let reply = server.ask(
        "textDocument/prepareRename",
        &uri,
        main,
        "count til",
        0,
        json!({}),
    );
    assert!(
        reply["error"].is_object() || reply["result"].is_null(),
        "{reply}"
    );
    // A name read in a qSQL phrase is a column whenever the table has one
    // (#1207); the table after `from` is a global, and is renamed.
    let query = "foo:1\nr:select foo from t where foo>0\ntab:([] a:1 2)\ns:select from tab\n";
    let quri = server.open(dir.path(), "query.q", query);
    let reply = server.ask(
        "textDocument/rename",
        &quri,
        query,
        "foo:1",
        0,
        json!({"newName": "bar"}),
    );
    let why = refused(&reply);
    assert!(why.contains("qSQL") && why.contains("query.q:2"), "{why}");
    // In parentheses or the brackets of `select[>a]` it is a column too:
    // KDB-X `select from t where (af>1),b>2` over a function `af` is 'type
    // (#2823).
    for (n, phrase) in [
        "select from t where (a>1),b>2",
        "select[>a] from t",
        "select from t where b in (a;b)",
    ]
    .into_iter()
    .enumerate()
    {
        let name = format!("paren{n}.q");
        let text = format!("a:{{x}}\nt:([]a:1 2;b:3 4)\nr7:{phrase}\nr8:a 1\n");
        let puri = server.open(dir.path(), &name, &text);
        let reply = server.ask(
            "textDocument/rename",
            &puri,
            &text,
            "a:{",
            0,
            json!({"newName": "af"}),
        );
        let why = refused(&reply);
        assert!(
            why.contains("qSQL") && why.contains(":3"),
            "{phrase}: {why}"
        );
    }
    let reply = server.ask(
        "textDocument/rename",
        &quri,
        query,
        "tab:",
        0,
        json!({"newName": "tbl"}),
    );
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("query.q", 2, 0, 3, "tbl"),
            edit("query.q", 3, 14, 17, "tbl")
        ]
    );
    // A legal one goes through: lib.q's definition and both calls.
    let reply = ask(&mut server, "helper v", "bump");
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("lib.q", 0, 0, 6, "bump"),
            edit("lib.q", 2, 9, 15, "bump"),
            edit("main.q", 1, 9, 15, "bump")
        ]
    );
}

#[test]
fn a_dotted_read_through_a_global_is_a_use_of_it() {
    // #2017: q reads `ta.c` as column c of the global `ta` (KDB-X 5:
    // `ta:([]c:1 2 3)`, then `sum ta.c` is 6, and under `\d .ns` the same
    // text reads `.ns.ta`), and `.cfg.port` through a `.cfg` assigned whole.
    // A rename that left those reads alone wrote a file that fails on 'ta.c.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "ta:([]c:1 2 3)\nres:sum ta.c\n\\d .ns\ntb:([]c:4 5)\nr:tb.c\n\\d .\n\
                s:.ns.tb.c\n.cfg:()!()\n.cfg.port:5010\np:.cfg.port\n";
    let uri = server.open(dir.path(), "a.q", text);
    let ask = |server: &mut Server, method: &str, context: &str, new: &str| {
        server.ask(method, &uri, text, context, 0, json!({"newName": new}))
    };
    let reply = ask(&mut server, "textDocument/references", "ta:", "");
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 0, 2), place("a.q", 1, 8, 10)]
    );
    let reply = ask(&mut server, "textDocument/documentHighlight", "ta:", "");
    let marks: Vec<_> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| span(&h["range"]))
        .collect();
    assert_eq!(marks, [(0, 0, 2), (1, 8, 10)], "{reply}");
    let reply = ask(&mut server, "textDocument/rename", "ta:", "tk");
    assert_eq!(
        edits(&reply["result"]),
        [edit("a.q", 0, 0, 2, "tk"), edit("a.q", 1, 8, 10, "tk")]
    );
    // From the read itself, the same (#2048): the cursor on `ta` of `ta.c`
    // is on the table, as Go to Definition already had it.
    let reply = ask(&mut server, "textDocument/references", "ta.c", "");
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 0, 2), place("a.q", 1, 8, 10)]
    );
    let reply = ask(&mut server, "textDocument/documentHighlight", "ta.c", "");
    let marks: Vec<_> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (span(&h["range"]), h["kind"].as_u64().unwrap()))
        .collect();
    assert_eq!(marks, [((0, 0, 2), 3), ((1, 8, 10), 2)], "{reply}");
    let reply = ask(&mut server, "textDocument/prepareRename", "ta.c", "");
    assert_eq!(span(&reply["result"]["range"]), (1, 8, 10), "{reply}");
    assert_eq!(reply["result"]["placeholder"], "ta");
    let reply = ask(&mut server, "textDocument/rename", "ta.c", "tk");
    assert_eq!(
        edits(&reply["result"]),
        [edit("a.q", 0, 0, 2, "tk"), edit("a.q", 1, 8, 10, "tk")]
    );
    let reply = ask(&mut server, "textDocument/rename", ".ns.tb.c", "tz");
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("a.q", 3, 0, 2, "tz"),
            edit("a.q", 4, 2, 4, "tz"),
            edit("a.q", 6, 6, 8, "tz")
        ]
    );
    // Under a context, bare and with the context written out.
    let reply = ask(&mut server, "textDocument/rename", "tb:", "tz");
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("a.q", 3, 0, 2, "tz"),
            edit("a.q", 4, 2, 4, "tz"),
            edit("a.q", 6, 6, 8, "tz")
        ]
    );
    // A namespace assigned whole is named by every name in it.
    let reply = ask(&mut server, "textDocument/rename", ".cfg:", "conf");
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("a.q", 7, 1, 4, "conf"),
            edit("a.q", 8, 1, 4, "conf"),
            edit("a.q", 9, 3, 6, "conf")
        ]
    );
}

#[test]
fn a_dotted_read_that_may_not_be_the_global_refuses_the_rename() {
    // #2017. In a qSQL phrase `td.c` is the column `td` followed through a
    // foreign key whenever the table has one, which only the table says;
    // and a name a `\d` puts under the global spells none of it to rewrite.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "td:([]c:1 2 3)\nr:select td.c from t\n";
    let uri = server.open(dir.path(), "a.q", text);
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        text,
        "td:",
        0,
        json!({"newName": "te"}),
    );
    let why = refused(&reply);
    assert!(why.contains("qSQL") && why.contains("a.q:2"), "{why}");
    let text = ".cfg:()!()\n\\d .cfg\nport:5010\n";
    let uri = server.open(dir.path(), "b.q", text);
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        text,
        ".cfg:",
        0,
        json!({"newName": "conf"}),
    );
    let why = refused(&reply);
    assert!(why.contains("`port`") && why.contains("b.q:3"), "{why}");
}

#[test]
fn a_global_named_by_a_symbol_is_renamed_where_q_takes_the_name() {
    // #2018. Each form below takes a global by its name, as KDB-X 5 answers
    // with `tb:([]c:3 1 2)`: `update .. from `tb`, `delete from `tb ..`,
    // `` `c xkey `tb ``, `` `c xasc `tb ``, `xdesc[`c;`tb]`, `` 1!`tb ``,
    // `![`tb;();0b;enlist`d]` and `@[`tb;`c;neg]` change tb in place and
    // return `` `tb ``; `?[`tb;();0b;()]`, `` get`tb ``, `` value `tb ``,
    // `` cols `tb ``, `` meta `tb `` and `` keys `tb `` read it. A rename
    // that left them alone wrote a file that fails on 'tb.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let lines = [
        "tb:([]c:1 2 3;d:4 5 6)",
        "update c:c*2 from `tb;",
        "delete from `tb where c>1;",
        "@[`tb;`c;neg];",
        "r1:get`tb",
        "r2:value `tb",
        "`c xkey `tb;",
        "`c xasc `tb;",
        "xdesc[`c;`tb];",
        "r3:?[`tb;();0b;()]",
        "![`tb;();0b;enlist`d];",
        "r4:(cols `tb;meta[`tb];keys (`tb))",
        "0!`tb;",
        "r5:exec c from `tb",
        "`tb insert enlist 7;",
    ];
    let text = lines.join("\n") + "\n";
    let uri = server.open(dir.path(), "a.q", &text);
    let mut all = vec![];
    for (row, line) in lines.iter().enumerate() {
        let mut from = 0;
        while let Some(at) = line[from..].find("tb") {
            all.push((row as u64, (from + at) as u64));
            from += at + 2;
        }
    }
    assert_eq!(all.len(), 17);
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        &text,
        "tb:",
        0,
        json!({"newName": "tm"}),
    );
    let wanted: Vec<_> = all
        .iter()
        .map(|&(row, at)| edit("a.q", row, at, at + 2, "tm"))
        .collect();
    assert_eq!(edits(&reply["result"]), wanted);
    let reply = server.ask("textDocument/references", &uri, &text, "tb:", 0, json!({}));
    let wanted: Vec<_> = all
        .iter()
        .map(|&(row, at)| place("a.q", row, at, at + 2))
        .collect();
    assert_eq!(places(&reply["result"]), wanted);
    // From the symbol too: it is the name. An insert is a definition, as
    // it makes the table when there is none.
    let reply = server.ask(
        "textDocument/definition",
        &uri,
        &text,
        "tb where",
        0,
        json!({}),
    );
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 0, 2), place("a.q", 14, 1, 3)]
    );
}

#[test]
fn a_string_run_as_q_that_names_the_global_refuses_the_rename() {
    // #3005. KDB-X 5 calls `myf` for `value "myf 1"`, `eval parse "myf 1"`,
    // `eval -5!"myf 1"`, `0 "myf 1"` and a trapped `value`, and `get "myf"`
    // is the function: a rename that changed the definition and left the
    // string made each of them signal 'myf. No edit rewrites a string, so
    // the rename is refused and names the line.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let rename = |server: &mut Server, uri: &str, text: &str, name: &str| {
        server.ask(
            "textDocument/rename",
            uri,
            text,
            &format!("{name}:"),
            0,
            json!({"newName": "renamed"}),
        )
    };
    // Each case has a name of its own, `N` here: the files stay open.
    for (i, ran) in [
        "r:value \"N 1\"",
        "r:eval parse \"N 1\"",
        "r:eval -5!\"N 1\"",
        "r:0 \"N 1\"",
        "r:@[value;\"N 1\";{x}]",
        "r:get \"N\"",
        "r:value \"1+\",\"N 1\"",
        // In a lambda under a `\d`, where the name is looked up at the call.
        "\\d .o\nf:{value \"N 1\"}",
    ]
    .iter()
    .enumerate()
    {
        let (file, name) = (format!("a{i}.q"), format!("ma{i}"));
        let text = format!("N:{{x+1}}\nt:N 2\n{ran}\n").replace('N', &name);
        let uri = server.open(dir.path(), &file, &text);
        let why = refused(&rename(&mut server, &uri, &text, &name));
        let line = text.lines().count();
        assert!(
            why.contains(&format!("`{name}`")) && why.contains(&format!("{file}:{line}")),
            "{ran}: {why}"
        );
    }
    // Not a string nothing runs here, one sent to another process, a local
    // of the string's own lambda, a longer name, or a name in a namespace.
    for (i, kept) in [
        "s:\"N 1\"",
        "h:hopen 5000\nr:h \"N 1\"",
        "r:value \"{[N] N+1} 2\"",
        "r:value \"Ns 1\"",
        "r:value \".o.N 1\"",
    ]
    .iter()
    .enumerate()
    {
        let (file, name) = (format!("b{i}.q"), format!("mb{i}"));
        let text = format!("N:{{x+1}}\nt:N 2\n{kept}\n").replace('N', &name);
        let uri = server.open(dir.path(), &file, &text);
        let reply = rename(&mut server, &uri, &text, &name);
        assert_eq!(
            edits(&reply["result"]),
            [
                edit(&file, 0, 0, 3, "renamed"),
                edit(&file, 1, 2, 5, "renamed")
            ],
            "{kept}: {reply}"
        );
    }
}

#[test]
fn a_symbol_that_may_name_the_global_refuses_the_rename() {
    // #2018. `` `tc in tables[] `` is 1b before a rename of tc and 0b after
    // one that leaves the symbol (KDB-X 5), and nothing in the text says
    // whether a symbol in such a place is the table's name or only data: a
    // column, a key, an enumeration. The rename is refused and names the
    // line; Find References lists the place.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let rename = |server: &mut Server, uri: &str, text: &str, context: &str| {
        server.ask(
            "textDocument/rename",
            uri,
            text,
            context,
            0,
            json!({"newName": "tn"}),
        )
    };
    let text = "tc:([]c:1 2 3)\nr:`tc in tables[]\n";
    let uri = server.open(dir.path(), "a.q", text);
    let why = refused(&rename(&mut server, &uri, text, "tc:"));
    assert!(why.contains("`tc") && why.contains("a.q:2"), "{why}");
    let reply = server.ask("textDocument/references", &uri, text, "tc:", 0, json!({}));
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 0, 2), place("a.q", 1, 3, 5)]
    );
    for (file, text) in [
        // One of a list, a value handed on, a name beside an operator.
        ("b.q", "td:1\nr:get each `tx`td\n"),
        ("c.q", "te:1\nr:f[`te]\n"),
        ("d.q", "tf:1\nr:get `tf,`x\n"),
    ] {
        let uri = server.open(dir.path(), file, text);
        let name = &text[..2];
        let why = refused(&rename(&mut server, &uri, text, &format!("{name}:")));
        assert!(
            why.contains(&format!("`{name}")) && why.contains(&format!("{file}:2")),
            "{why}"
        );
    }
    // A symbol under another context is another name, and one a write
    // already places is that write's: neither is in the way.
    let text = "tg:1\n\\d .o\nr:`tg in tables[]\n@[`.o;`tg;:;2];\n";
    let uri = server.open(dir.path(), "e.q", text);
    let reply = rename(&mut server, &uri, text, "tg:");
    assert_eq!(edits(&reply["result"]), [edit("e.q", 0, 0, 2, "tn")]);
    // A symbol in a lambda written under a `\d` is looked up where the
    // lambda is called (KDB-X 5: `\d .ns`, `f:{get `th}`, `\d .`, then
    // `.ns.f[]` reads the root th). With one th it is that one; with two,
    // which it names is not in the text.
    let text = "\\d .ns\nth:1\nf:{get `th}\n\\d .\n";
    let uri = server.open(dir.path(), "f.q", text);
    let reply = rename(&mut server, &uri, text, "th:");
    assert_eq!(
        edits(&reply["result"]),
        [edit("f.q", 1, 0, 2, "tn"), edit("f.q", 2, 8, 10, "tn")]
    );
    let text = "\\d .ns\nti:1\nf:{get `ti}\n\\d .\nti:2\n";
    let uri = server.open(dir.path(), "g.q", text);
    let why = refused(&rename(&mut server, &uri, text, "ti:1"));
    assert!(why.contains("`ti") && why.contains("g.q:3"), "{why}");
}

#[test]
fn a_global_is_followed_onto_a_k_line() {
    // #2019. A `k)` line names q's globals, under the `\d` in force, and
    // both views blank it. KDB-X 5: `fk:2`, `k)gk:fk+1`, then gk is 3; in
    // k a lambda's parameter or `name:` local hides the global as in q,
    // `([]fk:1 2)` names a column, and `_` is the drop operator, no part of
    // a name: with `ab:10 20 30` and `cc:1`, `k)ab_cc` is 10 30.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let lines = [
        "fk:2",
        "k)gk:fk+1",
        "res:gk",
        "k)hk:{[a] a+fk}",
        "k)ik:{[fk] fk+1}",
        "k)jk:{fk:5;fk+1}",
        "k)lk:(fk;\"fk\";fk_1) / fk",
        "k)mk:([]fk:1 2)",
        "k)nk:{{fk+x}x}",
        "  ,fk",
        "\\d .ns",
        "k)ok:fk",
        "\\d .",
        "k)pk:{fk::x}",
    ];
    let text = lines.join("\n") + "\n";
    let uri = server.open(dir.path(), "a.q", &text);
    let uses = [
        (0, 0),
        (1, 5),
        (3, 12),
        (6, 6),
        (6, 14),
        (8, 7),
        (9, 3),
        (13, 6),
    ];
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        &text,
        "fk:",
        0,
        json!({"newName": "fz"}),
    );
    let wanted: Vec<_> = uses
        .iter()
        .map(|&(row, at)| edit("a.q", row, at, at + 2, "fz"))
        .collect();
    assert_eq!(edits(&reply["result"]), wanted);
    let reply = server.ask("textDocument/references", &uri, &text, "fk:", 0, json!({}));
    let wanted: Vec<_> = uses
        .iter()
        .map(|&(row, at)| place("a.q", row, at, at + 2))
        .collect();
    assert_eq!(places(&reply["result"]), wanted);
    // What a k line assigns is renamed where it is assigned.
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        &text,
        "gk",
        1,
        json!({"newName": "gz"}),
    );
    assert_eq!(
        edits(&reply["result"]),
        [edit("a.q", 1, 2, 4, "gz"), edit("a.q", 2, 4, 6, "gz")]
    );
    // A k lambda's own name would hide the renamed global there, and a
    // symbol on a k line may name it: both refuse, naming the line.
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        &text,
        "fk:",
        0,
        json!({"newName": "a"}),
    );
    let why = refused(&reply);
    assert!(why.contains("a.q:4"), "{why}");
    let text = "fq:2\nk)gq:.:`fq\n";
    let uri = server.open(dir.path(), "b.q", text);
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        text,
        "fq:",
        0,
        json!({"newName": "fz"}),
    );
    let why = refused(&reply);
    assert!(why.contains("`fq") && why.contains("b.q:2"), "{why}");
}

#[test]
fn a_name_with_an_underscore_is_refused_where_a_k_line_reads_it() {
    // #2044. k reads `_` as its drop: KDB-X 5 runs `fk:2`, `k)gk:fk+1` and
    // gk is 3, and refuses `f_k:2`, `k)gk:f_k+1` with 'k. Where no k line
    // names it, `_` is a name's own.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "fk:2\nk)gk:fk+1\nshow gk\nhq:1\nshow hq\n";
    let uri = server.open(dir.path(), "a.q", text);
    for (at, new) in [("fk:", "f_k"), ("gk:", "g_k")] {
        let reply = server.ask(
            "textDocument/rename",
            &uri,
            text,
            at,
            0,
            json!({"newName": new}),
        );
        let why = refused(&reply);
        assert!(why.contains("a.q:2") && why.contains("drop"), "{why}");
    }
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        text,
        "hq:",
        0,
        json!({"newName": "h_q"}),
    );
    assert_eq!(
        edits(&reply["result"]),
        [edit("a.q", 3, 0, 2, "h_q"), edit("a.q", 4, 5, 7, "h_q")]
    );
}

#[test]
fn a_global_a_k_line_assigns_is_defined_there() {
    // #2047. KDB-X 5 runs `fk:2`, `k)gk:fk+1` and gk is 3: the k line
    // assigns a global, which b.q reads once it loads a.q.
    let dir = tempfile::tempdir().unwrap();
    let a = "fk:2\nk)gk:fk+1 / three\nk)hk:{fk::x}\nshow gk\n";
    let b = "\\l a.q\nh:{gk+1}\n";
    let mut server = Server::start(dir.path(), &[("a.q", a), ("b.q", b)]);
    let uri = server.open(dir.path(), "b.q", b);
    let reply = server.ask("textDocument/definition", &uri, b, "gk", 0, json!({}));
    assert_eq!(places(&reply["result"]), [place("a.q", 1, 2, 4)], "{reply}");
    let uri = server.open(dir.path(), "a.q", a);
    let reply = server.request(
        "textDocument/documentSymbol",
        json!({"textDocument": {"uri": uri}}),
    );
    let listed: Vec<_> = reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"))
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().to_string(),
                s["kind"].as_u64().unwrap(),
                span(&s["range"]),
            )
        })
        .collect();
    // The statement, its comment left out; a lambda's value a function.
    assert_eq!(
        listed,
        [
            ("fk".to_string(), 13, (0, 0, 4)),
            ("gk".to_string(), 13, (1, 2, 9)),
            ("hk".to_string(), 12, (2, 2, 12)),
        ],
        "{reply}"
    );
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        a,
        "gk",
        0,
        json!({}),
    );
    let marks: Vec<_> = reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"))
        .iter()
        .map(|h| (span(&h["range"]), h["kind"].as_u64().unwrap()))
        .collect();
    assert_eq!(marks, [((1, 2, 4), 3), ((3, 5, 7), 2)]);
    // `fk::x` in a k lambda writes the global too.
    let reply = server.ask(
        "textDocument/documentHighlight",
        &uri,
        a,
        "fk:",
        0,
        json!({}),
    );
    let marks: Vec<_> = reply["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (span(&h["range"]), h["kind"].as_u64().unwrap()))
        .collect();
    assert_eq!(marks, [((0, 0, 2), 3), ((1, 5, 7), 2), ((2, 6, 8), 3)]);
}

#[test]
fn a_context_switched_on_a_k_line_is_followed() {
    // #2056. KDB-X 5 runs `k)\d .ns`, `ff:1`, `\d .`, and `key `.ns` is
    // ``ff: k's `\d` is q's context.
    let dir = tempfile::tempdir().unwrap();
    let a = "k)\\d .ns\nff:1\n\\d .\ngg:2\n";
    let b = "\\l a.q\nr:.ns.ff+gg\n";
    let mut server = Server::start(dir.path(), &[("a.q", a), ("b.q", b)]);
    let reply = server.request("workspace/symbol", json!({"query": ""}));
    let mut names: Vec<&str> = reply["result"]
        .as_array()
        .unwrap_or_else(|| panic!("{reply}"))
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, [".ns.ff", "gg", "r"], "{reply}");
    let uri = server.open(dir.path(), "b.q", b);
    let reply = server.ask("textDocument/definition", &uri, b, ".ns.ff", 0, json!({}));
    assert_eq!(places(&reply["result"]), [place("a.q", 1, 0, 2)], "{reply}");
    // The command names no global: `d` and `.ns` on it are no reads.
    let uri = server.open(dir.path(), "a.q", a);
    let reply = server.ask("textDocument/references", &uri, a, "ff", 0, json!({}));
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 1, 0, 2), place("b.q", 1, 2, 8)]
    );
}

#[test]
fn a_context_switched_in_each_spelling_q_runs_is_followed_by_the_outline() {
    // #2967. KDB-X 5 defines `.qux.d` after each of these lines and `d:1`:
    // `@[system;"d .x";::]` then `g:{x}` leaves `key `.x` as `` ``g ``. The
    // loads written these ways were followed and the switches were not, so
    // the outline, workspace/symbol and Go to Definition put `d` at the root.
    for switch in [
        "system[\"d .qux\"]",
        "system@\"d .qux\"",
        "system (\"d .qux\")",
        "@[system;\"d .qux\";::]",
        "value \"\\\\d .qux\"",
        "q)system \"d .qux\"",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let a = format!("{switch}\nd:1\n\\d .\ngg:2\n");
        let b = "\\l a.q\nr:.qux.d+gg\n";
        let mut server = Server::start(dir.path(), &[("a.q", &a), ("b.q", b)]);
        let reply = server.request("workspace/symbol", json!({"query": ""}));
        let mut names: Vec<&str> = reply["result"]
            .as_array()
            .unwrap_or_else(|| panic!("{switch}: {reply}"))
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, [".qux.d", "gg", "r"], "{switch}: {reply}");
        let defined: Vec<String> = mentions(&a)
            .iter()
            .filter(|m| m.definition.is_some())
            .map(|m| m.name.clone())
            .collect();
        assert_eq!(defined, [".qux.d", "gg"], "{switch}");
        let uri = server.open(dir.path(), "b.q", b);
        let reply = server.ask("textDocument/definition", &uri, b, ".qux.d", 2, Value::Null);
        assert_eq!(
            places(&reply["result"]),
            [place("a.q", 1, 0, 1)],
            "{switch}: {reply}"
        );
    }
}

#[test]
fn a_context_switched_after_several_language_prefixes_is_followed() {
    // #2194. q reads any run of `q)` and `k)` before a command as the
    // command: on KDB-X 5, each of these lines then `d:1` and `\d .` leaves
    // `.qux.d` 1 and `d` undefined. The outline put `d` at the root.
    for prefix in ["q)k)", "k)q)", "q)q)", "k)k)", "q)k)q)"] {
        let dir = tempfile::tempdir().unwrap();
        let a = format!("{prefix}\\d .qux\nd:1\n\\d .\ngg:2\n");
        let b = "\\l a.q\nr:.qux.d+gg\n";
        let mut server = Server::start(dir.path(), &[("a.q", &a), ("b.q", b)]);
        let reply = server.request("workspace/symbol", json!({"query": ""}));
        let mut names: Vec<&str> = reply["result"]
            .as_array()
            .unwrap_or_else(|| panic!("{prefix}: {reply}"))
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, [".qux.d", "gg", "r"], "{prefix}: {reply}");
        // The outline puts `d` under `.qux`.
        let uri = server.open(dir.path(), "a.q", &a);
        let reply = server.request(
            "textDocument/documentSymbol",
            json!({"textDocument": {"uri": uri}}),
        );
        let outline: Vec<(&str, Vec<&str>)> = reply["result"]
            .as_array()
            .unwrap_or_else(|| panic!("{prefix}: {reply}"))
            .iter()
            .map(|s| {
                let children = s["children"].as_array().into_iter().flatten();
                (
                    s["name"].as_str().unwrap(),
                    children.map(|c| c["name"].as_str().unwrap()).collect(),
                )
            })
            .collect();
        assert_eq!(
            outline,
            [(".qux", vec!["d"]), ("gg", vec![])],
            "{prefix}: {reply}"
        );
        let uri = server.open(dir.path(), "b.q", b);
        let reply = server.ask("textDocument/definition", &uri, b, ".qux.d", 0, json!({}));
        assert_eq!(
            places(&reply["result"]),
            [place("a.q", 1, 0, 1)],
            "{prefix}: {reply}"
        );
        // The command names no global: `d` and `.qux` on it are no reads.
        let uri = server.open(dir.path(), "a.q", &a);
        let reply = server.ask("textDocument/references", &uri, &a, "d:", 0, json!({}));
        assert_eq!(
            places(&reply["result"]),
            [place("a.q", 1, 0, 1), place("b.q", 1, 2, 8)],
            "{prefix}"
        );
    }
}

#[test]
fn a_block_comment_after_a_k_line_is_no_k() {
    // #2042. KDB-X 5 runs `fk:1`, `k)gk:2`, `/`, ` fk in a comment`, `\`,
    // `show fk` and prints 1: the bare `/` opens a block comment after the k
    // statement, its `\` closes it, and `show fk` reads fk. Neither the
    // comment's words nor a script end are k's.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "fk:1\nk)gk:2\n/\n fk in a comment\n\\\nshow fk\n";
    let uri = server.open(dir.path(), "a.q", text);
    let reply = server.ask("textDocument/references", &uri, text, "fk:", 0, json!({}));
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 0, 2), place("a.q", 5, 5, 7)]
    );
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        text,
        "fk:",
        0,
        json!({"newName": "fz"}),
    );
    assert_eq!(
        edits(&reply["result"]),
        [edit("a.q", 0, 0, 2, "fz"), edit("a.q", 5, 5, 7, "fz")]
    );
}

#[test]
fn a_block_comment_inside_a_k_statement_is_no_k_and_does_not_end_it() {
    // #3010. KDB-X 5 loads `k)gk:{[zz] zz+`, `/`, ` zz in a comment`, `\`,
    // `  zz}` as one k lambda: the block comment folds into the statement
    // the indented line continues. So the `zz` after it is the lambda's
    // parameter, as the one before it is, and no use of the global.
    let dir = tempfile::tempdir().unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let text = "zz:1\nk)gk:{[zz] zz+\n/\n zz in a comment\n\\\n  zz}\nshow zz\n";
    let uri = server.open(dir.path(), "a.q", text);
    let reply = server.ask("textDocument/references", &uri, text, "zz:", 0, json!({}));
    assert_eq!(
        places(&reply["result"]),
        [place("a.q", 0, 0, 2), place("a.q", 6, 5, 7)]
    );
}

#[test]
fn a_file_loaded_under_two_contexts_is_renamed_in_both() {
    // #2043. KDB-X 5 runs this main.q and prints 1 1: b.q's one `ff:`
    // defines `.aa.ff` and `.bb.ff`. Renaming it renames both, so the
    // uses of `.bb.ff` follow, and the new name is checked in both.
    let dir = tempfile::tempdir().unwrap();
    let main = "\\d .aa\n\\l b.q\n\\d .bb\n\\l b.q\n\\d .\nshow .aa.ff[]\nshow .bb.ff[]\n";
    let mut server = Server::start(dir.path(), &[("b.q", "ff:{1}\n"), ("main.q", main)]);
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        main,
        ".aa.ff",
        4,
        json!({"newName": "gg"}),
    );
    assert_eq!(
        edits(&reply["result"]),
        [
            edit("b.q", 0, 0, 2, "gg"),
            edit("main.q", 5, 9, 11, "gg"),
            edit("main.q", 6, 9, 11, "gg"),
        ]
    );
    std::fs::write(dir.path().join("c.q"), "\\d .bb\ngg:2\n").unwrap();
    let mut server = Server::start(dir.path(), &[]);
    let uri = server.open(dir.path(), "main.q", main);
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        main,
        ".aa.ff",
        4,
        json!({"newName": "gg"}),
    );
    assert!(
        refused(&reply).contains("`.bb.gg` is already assigned"),
        "{reply}"
    );
}

#[test]
fn a_global_is_not_renamed_while_the_index_is_off() {
    // #2051. With the index off, main.q is not read until it is opened: a
    // rename of ff in lib.q would leave main.q calling an ff that is gone.
    let dir = tempfile::tempdir().unwrap();
    let files = [("lib.q", "ff:{1}\n"), ("main.q", "\\l lib.q\nx:ff[]\n")];
    let options = json!({"workspaceIndex": {"enable": false}});
    let (mut server, _) = Server::over(dir.path(), &files, client(), options);
    let uri = server.open(dir.path(), "lib.q", "ff:{1}\n");
    for method in ["textDocument/prepareRename", "textDocument/rename"] {
        let reply = server.ask(method, &uri, "ff:{1}\n", "ff", 0, json!({"newName": "gg"}));
        assert!(
            refused(&reply).contains("workspace index is off"),
            "{reply}"
        );
    }
    // A local is still renamed: every place it is named is in its lambda.
    let text = "f:{[a] a+1}\n";
    let uri = server.open(dir.path(), "c.q", text);
    let reply = server.ask(
        "textDocument/rename",
        &uri,
        text,
        "a]",
        0,
        json!({"newName": "b"}),
    );
    assert_eq!(edits(&reply["result"]).len(), 2, "{reply}");
}

#[test]
fn rename_can_be_turned_off_on_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let options = json!({"rename": {"enable": false}});
    let (mut server, reply) = Server::over(dir.path(), &[("lib.q", LIB)], client(), options);
    let capabilities = &reply["result"]["capabilities"];
    assert!(capabilities["renameProvider"].is_null(), "{capabilities}");
    // The rest of navigation stays.
    assert_eq!(capabilities["definitionProvider"], true, "{capabilities}");
    let uri = server.open(dir.path(), "main.q", MAIN);
    for method in ["textDocument/prepareRename", "textDocument/rename"] {
        let reply = server.ask(method, &uri, MAIN, "root_fn m", 0, json!({"newName": "g"}));
        assert_eq!(reply["result"], Value::Null, "{reply}");
    }
}
