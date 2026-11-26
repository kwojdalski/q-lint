//! `qlinter analyze graph`: which files a q file depends on, read from the
//! names it uses and the scripts it loads, and never by running anything.

use q_lint_rs::graph::{Node, build};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// The graph of in-memory files, keyed and valued by their bare names. The
/// paths are under a directory that does not exist, so nothing is read.
fn graph(files: &[(&str, &str)], symbols: bool) -> BTreeMap<String, Node> {
    let root = Path::new("/no-such-root");
    let sources: Vec<(PathBuf, String)> = files
        .iter()
        .map(|(name, text)| (root.join(name), text.to_string()))
        .collect();
    build(&sources, symbols, &[root.to_path_buf()])
        .into_iter()
        .map(|(p, node)| (p.strip_prefix(root).unwrap().display().to_string(), node))
        .collect()
}

fn deps(g: &BTreeMap<String, Node>, file: &str) -> Vec<String> {
    g[file]
        .dependencies
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect()
}

fn kinds(g: &BTreeMap<String, Node>, file: &str) -> Vec<(usize, &'static str)> {
    g[file].dynamic.iter().map(|d| (d.line, d.kind)).collect()
}

#[test]
fn a_qualified_reference_is_an_edge_to_its_definer() {
    let g = graph(
        &[("lib.q", ".lib.f:{x+1}\n"), ("app.q", "g:{.lib.f x}\n")],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["lib.q"]);
    assert!(deps(&g, "lib.q").is_empty());
}

#[test]
fn a_bare_name_inside_a_context_is_qualified_by_it() {
    let g = graph(
        &[
            ("lib.q", "\\d .lib\nf:{x+1}\n"),
            ("app.q", "\\d .lib\ng:{f x}\n"),
            // The same bare name at the root means `f`, which nobody defines.
            ("root.q", "h:{f x}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["lib.q"]);
    assert!(deps(&g, "root.q").is_empty());
}

#[test]
fn a_bare_name_inside_a_context_does_not_fall_back_to_the_root() {
    // q 5: after `f:{42}`, `\d .a`, `g:{f[]}`, calling `.a.g[]` is 'f.
    let g = graph(
        &[
            ("util.q", "helper:{x}\n"),
            ("app.q", "\\d .app\ng:{helper x}\n"),
            // At the root the same read is the root's own name.
            ("root.q", "g:{helper x}\n"),
        ],
        false,
    );
    assert!(deps(&g, "app.q").is_empty());
    assert_eq!(deps(&g, "root.q"), ["util.q"]);
}

#[test]
fn a_root_name_is_not_the_dotted_name_of_the_same_spelling() {
    // q 5: after `.h2:7`, `value "h2"` is 'h2; after `h3:5`, `value ".h3"`
    // is '.h3. Each read reaches only the file defining its own spelling.
    let g = graph(
        &[
            ("dot.q", ".g:7\n"),
            ("bare.q", "g:1\n"),
            ("bare_read.q", "r:g+1\n"),
            ("dot_read.q", "r:.g+1\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "bare_read.q"), ["bare.q"]);
    assert!(g["bare_read.q"].ambiguous.is_empty());
    assert_eq!(deps(&g, "dot_read.q"), ["dot.q"]);
}

#[test]
fn a_root_name_reaches_a_definition_in_dot_q() {
    // q 5: after `.q.answer:{42}`, `answer[]` is 42 - q searches `.q` from
    // every context (#358). A root definition of its own still comes first.
    let g = graph(
        &[("lib.q", ".q.answer:{42}\n"), ("main.q", "r:answer[]\n")],
        false,
    );
    assert_eq!(deps(&g, "main.q"), ["lib.q"]);
    let g = graph(
        &[
            ("lib.q", ".q.answer:{42}\n"),
            ("root.q", "answer:{1}\n"),
            ("main.q", "r:answer[]\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "main.q"), ["root.q"]);
}

#[test]
fn a_functional_amend_by_name_defines_the_global() {
    // q 5: `@[`.;`foo;:;1]` and `.[`bar;();:;2]` each create the global (#362).
    let g = graph(
        &[
            ("lib.q", "@[`.;`foo;:;1]\n.[`bar;();:;2]\n"),
            ("main.q", "r:foo+bar\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "main.q"), ["lib.q"]);
}

#[test]
fn a_parenthesised_set_target_is_a_definition() {
    // q 5: `(`e) set 5` defines `e` (#363).
    let g = graph(&[("lib.q", "(`e) set 5\n"), ("main.q", "r:e\n")], false);
    assert_eq!(deps(&g, "main.q"), ["lib.q"]);
}

#[test]
fn a_computed_set_target_defines_no_root_name() {
    // q 5: `ns:`.app; (` sv ns,`run) set {x+1}` defines `.app.run`, and
    // `(st`pending) upsert t` writes the table `st` names - neither root
    // `run` nor `pending` (#860). Each set of a symbol list likewise.
    let lib = "ns:`.app\n(` sv ns,`run) set {x+1}\n(st`pending) upsert t\n(st`a`b) set' 1 2\n";
    let g = graph(
        &[("lib.q", lib), ("main.q", "r:(run;pending;a;b)\n")],
        false,
    );
    assert!(deps(&g, "main.q").is_empty(), "{:?}", deps(&g, "main.q"));
    // A symbol alone in parentheses still names its target.
    let g = graph(
        &[
            ("lib.q", "( `e ) set 5\n(`p`q) set' 1 2\n"),
            ("main.q", "r:e+p\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "main.q"), ["lib.q"]);
}

#[test]
fn system_d_and_a_commented_backslash_d_open_a_context() {
    // q 5: after `system "d .b"` and `k:{1}`, `key `.b` is ``k; after
    // `\d .c  / note` and `m:1`, `key `.c` is ``m.
    let g = graph(
        &[
            ("sys.q", "system \"d .b\"\nk:{1}\nsystem \"d .\"\n"),
            ("note.q", "\\d .c  / note\nm:1\n\\d .\n"),
            ("root.q", "k:{2}\nm:2\n"),
            ("app.q", "r:{.b.k[] + .c.m}\n"),
            ("bare.q", "r:{k[] + m}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["note.q", "sys.q"]);
    assert_eq!(deps(&g, "bare.q"), ["root.q"]);
}

#[test]
fn a_nested_context_qualifies_with_its_whole_path() {
    let g = graph(
        &[
            ("lib.q", "\\d .a.b\nf:{x}\n"),
            ("near.q", "\\d .a.b\ng:{f x}\n"),
            // `.a` is not `.a.b`: `f` there is `.a.f`.
            ("far.q", "\\d .a\ng:{f x}\n"),
            ("full.q", "g:{.a.b.f x}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "near.q"), ["lib.q"]);
    assert!(deps(&g, "far.q").is_empty());
    assert_eq!(deps(&g, "full.q"), ["lib.q"]);
}

#[test]
fn a_locals_name_is_not_a_read_of_the_global() {
    let g = graph(
        &[("lib.q", "f:{x}\n"), ("app.q", "g:{[f] f+1}\nh:{f:2; f}\n")],
        false,
    );
    assert!(deps(&g, "app.q").is_empty());
}

#[test]
fn a_file_path_or_symbol_reads_none_of_the_names_inside_it() {
    // q 5 reads each as one symbol: `:` runs on anywhere, `/` after `` `: ``.
    let g = graph(
        &[
            ("lib.q", "trade:1\nsym:`a\nhdb:2\nb:3\n"),
            (
                "app.q",
                "r:`:trade.csv\ns:get `:hdb/sym\nhdel `:hdb/2024.01.01/trade/\nt:`a:b\n",
            ),
            // A symbol handed to `get` still names the global it reads.
            ("get.q", "r:get `trade\n"),
        ],
        false,
    );
    assert!(deps(&g, "app.q").is_empty());
    assert_eq!(deps(&g, "get.q"), ["lib.q"]);
}

#[test]
fn a_key_of_a_defined_dictionary_reaches_its_definer() {
    let g = graph(
        &[
            ("cfg.q", ".cfg.opts:`port`host!(1;`h)\n"),
            ("app.q", "p:{.cfg.opts.port}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["cfg.q"]);
}

#[test]
fn a_name_several_files_define_is_an_edge_to_each_and_listed() {
    let g = graph(
        &[
            ("one.q", "init:{1}\n"),
            ("two.q", "init:{2}\n"),
            ("app.q", "go:{init[]}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["one.q", "two.q"]);
    let definers: Vec<_> = g["app.q"].ambiguous["init"]
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(definers, ["one.q", "two.q"]);
    // One definer and no doubt: nothing is listed.
    assert!(g["one.q"].ambiguous.is_empty());
}

#[test]
fn a_file_that_defines_a_name_itself_still_depends_on_another_definer() {
    let g = graph(
        &[
            ("one.q", "init:{1}\ngo:{init[]}\n"),
            ("two.q", "init:{2}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "one.q"), ["two.q"]);
    assert_eq!(g["one.q"].ambiguous["init"].len(), 2);
}

#[test]
fn dynamic_access_is_listed_and_not_guessed() {
    let source = "\
a:{value \"1+1\"}
b:{get x}
c:{(` sv `a`b) set 1}
d:{y set 1}
e:{system \"l \",x}
";
    let g = graph(&[("dyn.q", source)], false);
    assert_eq!(
        kinds(&g, "dyn.q"),
        [
            (1, "value"),
            (2, "get"),
            (3, "set"),
            (3, "sv"),
            (4, "set"),
            (5, "load")
        ]
    );
}

#[test]
fn literal_targets_and_file_access_are_not_dynamic() {
    let source = "\
`.a.b set 1
set[`.a.c;2]
(`:data/t) set t
(hsym `t) set t
`p`q set' 1 2
x:get `:data/t
y:get hsym `t
z:get `.a.b
w:` sv `:dir`file
v:value d
u:{value \"1\"}
";
    let g = graph(&[("static.q", source)], false);
    // Only the string handed to `value` is out of reach.
    assert_eq!(kinds(&g, "static.q"), [(11, "value")]);
}

#[test]
fn value_of_a_name_holding_a_symbol_is_dynamic_like_get() {
    // #142. q 5 (KDB-X, .z.K 5, .z.k 2026.07.23): `get~value` is 1b - both
    // are `.:` - and after `x:42; nm:`x`, `value nm` and `get nm` are both
    // 42. But `value d` of a dictionary is its values, and reading cannot
    // tell the two apart from `value` alone (#170 tried, and marked 387
    // places over the corpus). So `value` is listed only where the source
    // shows its argument is a symbol: a name the scope assigns nothing but a
    // symbol atom, or a symbol built on the spot with `` `$ `` or `.Q.dd`.
    let source = "\
a:{nm:`x; value nm}
nm:`x
b:value nm
c:{value `$x}
d:{value `$\"f\",x}
e:{value .Q.dd[`a;x]}
f:{value nm}
g:{[nm] value nm}
h:{value x}
dd:`a`b!1 2
i:value dd
syms:`a`b
j:value syms
k:{s:`x; s:s,`y; value s}
l:{t:`x; value t,1}
m:{value[nm]}
n:{p:`$x; value p}
o:{q:`:file; value q}
";
    let g = graph(&[("val.q", source)], false);
    assert_eq!(
        kinds(&g, "val.q"),
        [
            (1, "value"),
            (3, "value"),
            (4, "value"),
            (5, "value"),
            (6, "value"),
            (7, "value"),
            (16, "value"),
            (17, "value")
        ]
    );
}

#[test]
fn a_symbol_resolved_when_a_context_lambda_runs_is_dynamic() {
    // q 5: after `\d .a`, `p:{get `k}`, `\d .`, with a root `k:5` and
    // `.a.k:6`, `.a.p[]` is 5 - the symbol is looked up in the `\d` current
    // at the call, not where the lambda is written - and `.a.m[]` for
    // `m:{`n set 3}` sets the root `n` and leaves `.a.n` undefined.
    let g = graph(
        &[
            ("get.q", "\\d .a\np:{get `k}\nq:{value `k}\n\\d .\n"),
            ("set.q", "\\d .a\nm:{`n set 3}\ns:{set[`o;4]}\n\\d .\n"),
            ("root.q", "k:5\n"),
            ("dotted.q", ".a.k:6\n"),
            ("reads_n.q", "r:{.a.n+.a.o}\n"),
            // `value` of what the drop returns, a dictionary, reaches no name.
            ("drop.q", "\\d .a\nf:{value `c _ x}\n\\d .\n"),
            ("c.q", ".a.c:1\n"),
        ],
        false,
    );
    assert!(kinds(&g, "drop.q").is_empty());
    assert!(deps(&g, "drop.q").is_empty());
    assert!(deps(&g, "get.q").is_empty());
    assert_eq!(kinds(&g, "get.q"), [(2, "get"), (3, "value")]);
    assert_eq!(kinds(&g, "set.q"), [(2, "set"), (3, "set")]);
    assert!(deps(&g, "reads_n.q").is_empty());
}

#[test]
fn a_symbol_outside_a_context_lambda_resolves_where_it_is_written() {
    // q 5: `\d .a`, `` `k set 2 `` at the top level makes `.a.k`; a
    // qualified symbol names one global whatever the `\d`; and a lambda at
    // the root is taken to be called at the root.
    let g = graph(
        &[
            ("top.q", "\\d .a\n`k set 2\n\\d .\n"),
            ("read_top.q", "r:.a.k\n"),
            ("qualified.q", "\\d .a\np:{get `.b.k}\n\\d .\n"),
            ("b.q", ".b.k:1\n"),
            ("rootfn.q", "p:{get `j}\n"),
            ("j.q", "j:1\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "read_top.q"), ["top.q"]);
    assert_eq!(deps(&g, "qualified.q"), ["b.q"]);
    assert!(kinds(&g, "qualified.q").is_empty());
    assert_eq!(deps(&g, "rootfn.q"), ["j.q"]);
    assert!(kinds(&g, "rootfn.q").is_empty());
}

#[test]
fn a_symbol_handed_to_get_is_a_read() {
    let g = graph(
        &[("lib.q", ".lib.x:1\n"), ("app.q", "f:{get `.lib.x}\n")],
        false,
    );
    assert_eq!(deps(&g, "app.q"), ["lib.q"]);
}

#[test]
fn symbol_literals_count_only_with_symbols() {
    let files = [
        ("lib.q", ".lib.cb:{x}\n"),
        ("app.q", ".reg.add[`.lib.cb]\n"),
    ];
    assert!(deps(&graph(&files, false), "app.q").is_empty());
    assert_eq!(deps(&graph(&files, true), "app.q"), ["lib.q"]);
}

#[test]
fn a_name_in_a_string_or_comment_is_not_a_read() {
    let g = graph(
        &[
            ("lib.q", ".lib.f:{x}\n"),
            ("app.q", "/ calls .lib.f\ng:{\"see .lib.f\"} / .lib.f\n"),
        ],
        false,
    );
    assert!(deps(&g, "app.q").is_empty());
}

#[test]
fn a_literal_load_is_an_edge() {
    let g = graph(
        &[
            ("src/util.q", "k:1\n"),
            ("src/app.q", "\\l util.q\n"),
            // Resolved against a directory above the file, as q run from the
            // repository's root would.
            ("src/deep/app.q", "system \"l src/util.q\"\n"),
            ("src/none.q", "\\l missing.q\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "src/app.q"), ["util.q"]);
    assert_eq!(deps(&g, "src/deep/app.q"), ["util.q"]);
    assert!(deps(&g, "src/none.q").is_empty());
}

#[test]
fn system_applied_with_brackets_with_at_or_trapped_loads() {
    // q 5 loads lib.q for each (#762); a path joined at run time is dynamic.
    let g = graph(
        &[
            ("lib.q", "lim:1\n"),
            ("a.q", "@[system;\"l lib.q\";{-1 x}]\n"),
            ("b.q", "system[\"l lib.q\"]\n"),
            ("c.q", "system@\"l lib.q\"\n"),
            ("d.q", "f:{system[\"l \",x]}\n"),
            ("e.q", "f:{@[system;\"l \",x;{-1 x}]}\n"),
        ],
        false,
    );
    for file in ["a.q", "b.q", "c.q"] {
        assert_eq!(deps(&g, file), ["lib.q"], "{file}");
    }
    for file in ["d.q", "e.q"] {
        assert_eq!(kinds(&g, file), [(1, "load")], "{file}");
    }
}

#[test]
fn a_relative_load_after_a_change_of_directory_is_dynamic() {
    // q 5: `\cd lib` then `\l x.q` loads lib/x.q, not the x.q beside the
    // script (#763). A load before the change, or of an absolute path, is
    // still an edge.
    let g = graph(
        &[
            ("x.q", "who:`top\n"),
            ("lib/x.q", "who:`lib\n"),
            ("a.q", "\\cd lib\n\\l x.q\n"),
            ("b.q", "system \"cd lib\"\n\\l x.q\n"),
            ("c.q", "\\l x.q\n\\cd lib\n"),
        ],
        false,
    );
    assert!(deps(&g, "a.q").is_empty());
    assert_eq!(kinds(&g, "a.q"), [(2, "load")]);
    assert!(deps(&g, "b.q").is_empty());
    assert_eq!(kinds(&g, "b.q"), [(2, "load")]);
    assert_eq!(deps(&g, "c.q"), ["x.q"]);
}

#[test]
fn a_relative_load_after_a_directory_load_is_dynamic() {
    // KDB-X: `\l db` leaves the process in db, so the `\l helper.q` after it
    // loads db/helper.q, and fails where only the directory it started in has
    // one (#1365). `\l .` moves nowhere, and a load before the directory's is
    // still an edge.
    let g = graph(
        &[
            ("helper.q", "hh:`root\n"),
            ("db/x.q", "xx:1\n"),
            ("a.q", "\\l db\n\\l helper.q\n"),
            ("b.q", "system \"l db/\"\n\\l helper.q\n"),
            ("c.q", "\\l helper.q\n\\l db\n"),
            ("sub/d.q", "\\l .\n\\l helper.q\n"),
        ],
        false,
    );
    for file in ["a.q", "b.q"] {
        assert_eq!(deps(&g, file), ["x.q"], "{file}");
        assert_eq!(kinds(&g, file), [(2, "load")], "{file}");
    }
    assert_eq!(deps(&g, "c.q"), ["x.q", "helper.q"]);
    assert!(kinds(&g, "c.q").is_empty());
    assert!(deps(&g, "sub/d.q").contains(&"helper.q".to_string()));
    assert!(kinds(&g, "sub/d.q").is_empty());
}

#[test]
fn a_cd_inside_a_block_comment_moves_nothing() {
    // KDB-X: under a block comment holding `\cd lib`, `\l b.q` loads the
    // b.q beside the script (#1363).
    let g = graph(
        &[("b.q", "who:`top\n"), ("a.q", "/\n\\cd lib\n\\\n\\l b.q\n")],
        false,
    );
    assert_eq!(deps(&g, "a.q"), ["b.q"]);
    assert!(kinds(&g, "a.q").is_empty());
}

#[test]
fn a_function_of_ones_own_named_system_loads_nothing() {
    // KDB-X: after `.a.system:{-1 x}`, `.a.system "l b.q"` prints `l b.q`
    // and `bb` stays undefined; such a call with "cd elsewhere" moves nothing,
    // so the `\l c.q` after it is c.q beside the script (#1362).
    let g = graph(
        &[
            ("b.q", "bb:1\n"),
            ("c.q", "cc:1\n"),
            ("a.q", ".a.system:{-1 x}\n.a.system \"l b.q\"\n"),
            (
                "d.q",
                ".d.system:{-1 x}\n.d.system \"cd elsewhere\"\n\\l c.q\n",
            ),
            ("e.q", ".e.system:{-1 x}\np:\"b.q\"\n.e.system \"l \",p\n"),
            // q's own still loads, however it is applied.
            ("f.q", "system \"l b.q\"\n@[system;\"l c.q\";{}]\n"),
        ],
        false,
    );
    assert!(deps(&g, "a.q").is_empty());
    assert_eq!(deps(&g, "d.q"), ["c.q"]);
    for file in ["a.q", "d.q", "e.q"] {
        assert!(kinds(&g, file).is_empty(), "{file}");
    }
    assert_eq!(deps(&g, "f.q"), ["b.q", "c.q"]);
}

#[test]
fn a_trailing_double_colon_composes_and_defines_nothing() {
    // q 5: `g:f[1] count::` composes, and `count` stays q's; `h:f lim::`
    // leaves no `lim`. A line that is only `a::` does define `a` (#764).
    let g = graph(
        &[
            ("a.q", "f:{x+y}\ng:f[1] count::\nh:f lim::\n"),
            ("b.q", "n:count 1 2 3\nr:lim\n"),
            ("c.q", "a::\n"),
            ("d.q", "r:a\n"),
            // A string or a query after the `::` is its value.
            ("e.q", "f:{s::\"\"; t::update a:1 from t}\n"),
            ("g.q", "r:(s;t)\n"),
        ],
        false,
    );
    assert!(deps(&g, "b.q").is_empty());
    assert_eq!(deps(&g, "d.q"), ["c.q"]);
    assert_eq!(deps(&g, "g.q"), ["e.q"]);
}

#[test]
fn a_script_loaded_under_a_context_defines_in_it() {
    // q 5: after `\d .a`, `\l b.q`, `\d .` with b.q's `ff:{1}`, `.a.ff[]`
    // is 1 and `ff` is 'ff. b.q's own `\d .b` does not leak back out: a.q's
    // `xx:1` after the load is `.a.xx`. And c.q, loaded at b.q's root, runs
    // in `.a` too.
    let g = graph(
        &[
            ("a.q", "\\d .a\n\\l b.q\nxx:1\n\\d .\n"),
            ("b.q", "ff:{1}\n.q2.w:2\n\\l c.q\n\\d .b\nyy:1\n"),
            ("c.q", "gg:{2}\n"),
            ("reads_ff.q", "r:.a.ff[]\n"),
            ("reads_gg.q", "r:.a.gg[]\n"),
            ("reads_xx.q", "r:.a.xx\n"),
            ("reads_bxx.q", "r:.b.xx\n"),
            // A qualified write and one under the script's own `\d` are
            // where they say, whatever the context it is loaded in.
            ("reads_aw.q", "r:.a.q2.w\n"),
            ("reads_ayy.q", "r:.a.b.yy\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "reads_ff.q"), ["b.q"]);
    assert_eq!(deps(&g, "reads_gg.q"), ["c.q"]);
    assert_eq!(deps(&g, "reads_xx.q"), ["a.q"]);
    assert!(deps(&g, "reads_bxx.q").is_empty());
    assert!(deps(&g, "reads_aw.q").is_empty());
    assert!(deps(&g, "reads_ayy.q").is_empty());
}

#[test]
fn a_script_loaded_from_several_contexts_defines_in_each() {
    let g = graph(
        &[
            ("a.q", "\\d .a\n\\l lib.q\n\\d .\n"),
            ("b.q", "\\d .b\nsystem \"l lib.q\"\n\\d .\n"),
            ("lib.q", "ff:{1}\n"),
            ("reads.q", "r:.a.ff[]+.b.ff[]+ff[]\n"),
            ("reads_c.q", "r:.c.ff[]\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "reads.q"), ["lib.q"]);
    assert!(g["reads.q"].ambiguous.is_empty());
    assert!(deps(&g, "reads_c.q").is_empty());
}

#[test]
fn a_file_symbol_naming_a_script_is_a_load_whatever_takes_it() {
    let g = graph(
        &[
            ("src/util.q", "k:1\n"),
            // A project's own loader, the way automl writes it.
            ("src/deep/app.q", "loadfile`:src/util.q\n"),
            // Not a script, in a string, in a comment, or not ending at `.q`.
            (
                "src/other.q",
                "r:`:src/util.qd\ns:\"`:src/util.q\"\nt:1 / `:src/util.q\nu:`:src/util.q/x\n",
            ),
        ],
        false,
    );
    assert_eq!(deps(&g, "src/deep/app.q"), ["util.q"]);
    assert!(deps(&g, "src/other.q").is_empty());
}

// The command line.

fn qlinter(cwd: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(cwd)
        .env("XDG_CONFIG_HOME", cwd.join("no-such-config-home"))
        .args(args)
        .output()
        .unwrap()
}

fn tree() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (rel, text) in [
        ("src/lib/a.q", "\\d .a\nf:{x+1}\n\\d .\ninit:{1}\n"),
        ("src/lib/b.q", "init:{2}\n.b.g:{.a.f x}\n"),
        (
            "src/app.q",
            "\\l src/lib/c.q\n\\d .a\nr:{f[x]+.b.g x}\n\\d .\ns:{init[]}\nt:{get x}\nreg:`.b.g\n",
        ),
        ("src/lib/c.q", "k:1\n"),
        ("README.md", "not q\n"),
    ] {
        let path = dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    dir
}

fn stdout(out: &std::process::Output) -> String {
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout.clone()).unwrap()
}

#[test]
fn the_graph_prints_files_and_their_dependencies() {
    let dir = tree();
    let out = stdout(&qlinter(dir.path(), &["analyze", "graph", "src"]));
    assert_eq!(
        out,
        r#"{
  "src/app.q": [
    "src/lib/a.q",
    "src/lib/b.q",
    "src/lib/c.q"
  ],
  "src/lib/a.q": [],
  "src/lib/b.q": [
    "src/lib/a.q"
  ],
  "src/lib/c.q": []
}
"#
    );
}

#[test]
fn the_graph_prints_dependents_with_detail() {
    let dir = tree();
    let out = stdout(&qlinter(
        dir.path(),
        &[
            "analyze",
            "graph",
            "--direction",
            "dependents",
            "--detail",
            "--symbols",
            "src",
        ],
    ));
    let found: serde_json::Value = serde_json::from_str(&out).unwrap();
    let expected = serde_json::json!({
        "src/app.q": {"dependents": [], "ambiguous": {"init": ["src/lib/a.q", "src/lib/b.q"]},
                      "dynamic": [{"line": 6, "kind": "get"}]},
        // A file that defines `init` but never reads it has no doubt to list.
        "src/lib/a.q": {"dependents": ["src/app.q", "src/lib/b.q"], "ambiguous": {}, "dynamic": []},
        "src/lib/b.q": {"dependents": ["src/app.q"], "ambiguous": {}, "dynamic": []},
        "src/lib/c.q": {"dependents": ["src/app.q"], "ambiguous": {}, "dynamic": []},
    });
    assert_eq!(found, expected);
}

#[test]
fn paths_are_relative_to_the_current_directory() {
    let dir = tree();
    let out = stdout(&qlinter(
        &dir.path().join("src/lib"),
        &["analyze", "graph", "c.q", "../app.q"],
    ));
    let found: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(found, serde_json::json!({"../app.q": ["c.q"], "c.q": []}));
}

#[test]
fn exclude_leaves_files_out_of_the_graph() {
    let dir = tree();
    let out = stdout(&qlinter(
        dir.path(),
        &["analyze", "graph", "--exclude", "src/lib/c.q", "src"],
    ));
    let found: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(found.get("src/lib/c.q").is_none());
    assert_eq!(
        found["src/app.q"],
        serde_json::json!(["src/lib/a.q", "src/lib/b.q"])
    );
}

#[test]
fn force_exclude_leaves_out_a_file_named_outright() {
    // A file list from a hook names every file; without the flag a named
    // file is a node whatever `--exclude` says, as when linting (#539).
    let dir = tree();
    let named = ["src/app.q", "src/lib/c.q"];
    let found = |extra: &[&str]| -> serde_json::Value {
        let args = [
            &["analyze", "graph", "--exclude", "src/lib"][..],
            extra,
            &named,
        ]
        .concat();
        serde_json::from_str(&stdout(&qlinter(dir.path(), &args))).unwrap()
    };
    assert!(found(&[]).get("src/lib/c.q").is_some());
    assert_eq!(
        found(&["--force-exclude"]),
        serde_json::json!({"src/app.q": []})
    );
}

#[test]
fn linting_paths_explain_and_lsp_are_unchanged_by_the_subcommand() {
    let dir = tree();
    // A path is still linted, flags before or after it.
    let out = qlinter(dir.path(), &["--format", "json", "src/lib/c.q"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "[]");
    let out = qlinter(dir.path(), &["src/lib/c.q", "--format", "json"]);
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "[]");
    // A directory named like the subcommand is linted when spelled as a path.
    fs::create_dir(dir.path().join("analyze")).unwrap();
    fs::write(dir.path().join("analyze/x.q"), "k:1\n").unwrap();
    let out = qlinter(dir.path(), &["--format", "json", "./analyze"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "[]");
    // `help` is still a path, not a subcommand: reported missing and skipped.
    // The reason between is the OS's own words, so it is not compared.
    let out = qlinter(dir.path(), &["help"]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("qlinter: help: ") && err.contains(", skipped"),
        "{err}"
    );
    assert_eq!(out.status.code(), Some(2));
    // --explain still answers.
    let out = qlinter(dir.path(), &["--explain", "QF005"]);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("QF005 "));
    // --lsp still refuses paths beside it, as before.
    let out = qlinter(dir.path(), &["--lsp", "src"]);
    assert_eq!(out.status.code(), Some(2));
    // A lint flag after the subcommand is refused, not ignored.
    let out = qlinter(dir.path(), &["analyze", "graph", "--fix", "src"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--fix"));
}

#[test]
fn the_language_server_still_starts_and_exits() {
    use std::io::Write;
    let dir = tree();
    let mut child = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .arg("--lsp")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let send = |stdin: &mut std::process::ChildStdin, body: &str| {
        write!(stdin, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    };
    let stdin = child.stdin.as_mut().unwrap();
    send(
        stdin,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}"#,
    );
    send(stdin, r#"{"jsonrpc":"2.0","id":2,"method":"shutdown"}"#);
    send(stdin, r#"{"jsonrpc":"2.0","method":"exit"}"#);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("capabilities"));
}

#[test]
fn a_k_line_defines_the_global_it_assigns() {
    // q 5: with x.q's `k)lim:100` loaded, y.q's `r:lim` is 100 (#751).
    let g = graph(&[("x.q", "k)lim:100\n"), ("y.q", "r:lim\n")], false);
    assert_eq!(deps(&g, "y.q"), ["x.q"]);
}

#[test]
fn a_k_line_reads_the_global_it_names() {
    // KDB-X 5: after c.q's `qdef:{x+1}`, `k)r2:qdef 1` is 2 and the k lambda
    // continued on an indented line, `k)h:{x+` / `  qdef x}`, reads it too
    // (h 1 is 2); a k lambda's parameter of the name is its own (f 5 is 6),
    // and a k line that assigns the name reads nothing (#2120).
    let g = graph(
        &[
            ("c.q", "qdef:{x+1}\ndone:1\n"),
            ("d.q", "k)r2:qdef 1\n"),
            ("e.q", "k)h:{x+\n  qdef x}\n"),
            ("f.q", "k)f:{[qdef] qdef+1}\n"),
            ("g.q", "k)done:2\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "d.q"), ["c.q"]);
    assert_eq!(deps(&g, "e.q"), ["c.q"]);
    assert!(deps(&g, "f.q").is_empty(), "{:?}", deps(&g, "f.q"));
    assert!(deps(&g, "g.q").is_empty(), "{:?}", deps(&g, "g.q"));
}

#[test]
fn a_relative_load_is_tried_against_the_process_directory_first() {
    // q 5, run from the root: sub/a.q's `\l b.q` loads the root's b.q, not
    // sub/b.q beside it (#529).
    let g = graph(
        &[
            ("b.q", "who:`root\n"),
            ("sub/b.q", "who:`sub\n"),
            ("sub/a.q", "\\l b.q\n"),
        ],
        false,
    );
    let deps: Vec<_> = g["sub/a.q"].dependencies.iter().collect();
    assert_eq!(deps, [Path::new("/no-such-root/b.q")]);
}

#[cfg(unix)]
#[test]
fn a_load_of_a_symlink_is_an_edge_to_the_link() {
    // The link is a file of the graph under its own name, and `\l` of that
    // name loads it (q 5); the target was looked up instead (#526).
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("shared")).unwrap();
    fs::create_dir_all(dir.path().join("p/lib")).unwrap();
    fs::write(dir.path().join("shared/real.q"), "f:{x+1}\n").unwrap();
    std::os::unix::fs::symlink("../../shared/real.q", dir.path().join("p/lib/link.q")).unwrap();
    fs::write(dir.path().join("p/main.q"), "\\l lib/link.q\n").unwrap();
    let out = stdout(&qlinter(&dir.path().join("p"), &["analyze", "graph", "."]));
    let found: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        found,
        serde_json::json!({"lib/link.q": [], "main.q": ["lib/link.q"]})
    );
}

#[test]
fn a_bare_name_inside_a_context_reaches_a_definition_in_dot_q() {
    // q 5: `.q.answer:{42}` loaded, then `\d .a`, `g:{answer[]}`: `.a.g[]`
    // is 42. A qualified `.a.answer` is not looked for in `.q` (#530).
    let g = graph(
        &[
            ("lib.q", ".q.answer:{42}\n"),
            ("use.q", "\\d .a\ng:{answer[]}\n\\d .\n"),
            ("dotted.q", "h:{.a.answer[]}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "use.q"), ["lib.q"]);
    assert!(deps(&g, "dotted.q").is_empty());
}

#[test]
fn a_script_loaded_under_a_context_reads_in_it() {
    // q 5: main.q loads d.q, then b.q under `\d .a`; b.q's `g:{helper[]}`
    // reads `.a.helper`, which d.q defines, and `.a.g[]` is 7 (#531). After
    // b.q's own `\d .` a read is the root's again.
    let g = graph(
        &[
            ("d.q", "\\d .a\nhelper:{7}\n\\d .\n"),
            ("b.q", "g:{helper[]}\n"),
            ("c.q", "\\d .\ng:{helper[]}\n"),
            ("main.q", "\\l d.q\n\\d .a\n\\l b.q\n\\l c.q\n\\d .\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "b.q"), ["d.q"]);
    assert!(deps(&g, "c.q").is_empty());
}

#[test]
fn a_loaded_scripts_own_root_is_not_the_loaders_context() {
    // q 5, a.q loading b.q under `\d .a`: b.q's `xx` is `.a.xx`, but after
    // b.q's own `\d .` its `yy` and what it loads stay at the root (#532).
    let g = graph(
        &[
            ("b.q", "xx:1\n\\d .\nyy:2\n\\l e.q\n"),
            ("e.q", "zz:3\n"),
            ("a.q", "\\d .a\n\\l b.q\n\\d .\n"),
            ("c.q", "r:{.a.yy}\ns:{.a.zz}\nt:{.a.xx}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "c.q"), ["b.q"]);
}

#[test]
fn a_loaded_directory_leads_to_the_scripts_in_it() {
    // q 5: `\l db` runs db/init.q, and `fromdir` is 42 after it (#533) -
    // only the scripts directly in it.
    let g = graph(
        &[
            ("db/init.q", "fromdir:42\n"),
            ("db/sub/deep.q", "deep:1\n"),
            ("main.q", "\\l db\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "main.q"), ["init.q"]);
    // Not the head of a path joined at run time; and `\l .` is the current
    // directory, not the one beside the file that says it.
    let g = graph(
        &[
            ("db/init.q", "fromdir:42\n"),
            ("db/reload.q", "f:{system \"l .\"}\n"),
            ("main.q", "L:{system \"l db/\",x}\n"),
        ],
        false,
    );
    assert!(deps(&g, "main.q").is_empty());
    assert_eq!(deps(&g, "db/reload.q"), ["main.q"]);
}

#[test]
fn loading_a_table_by_its_path_defines_it() {
    // q 5: `\l data/trades` sets `trades`, which use.q reads (#534).
    let g = graph(
        &[("init.q", "\\l data/trades\n"), ("use.q", "r:trades\n")],
        false,
    );
    assert_eq!(deps(&g, "use.q"), ["init.q"]);
}

#[test]
fn a_load_after_a_q_prompt_is_an_edge() {
    // q 5 reads `q)\l b.q` as `\l b.q` (#536).
    let g = graph(&[("b.q", "zz:1\n"), ("a.q", "q)\\l b.q\n")], false);
    assert_eq!(deps(&g, "a.q"), ["b.q"]);
}

#[test]
fn a_bracketed_symbol_handed_to_get_or_value_is_a_read() {
    // q 5: after `cfg:5`, `(get[`cfg];value[`cfg];get (`cfg))` is 5 5 5
    // (#537). Not a dynamic place either.
    for read in ["a:get[`cfg]", "a:value[`cfg]", "a:get (`cfg)"] {
        let g = graph(&[("defs.q", "cfg:5\n"), ("use.q", read)], false);
        assert_eq!(deps(&g, "use.q"), ["defs.q"], "{read}");
        assert!(kinds(&g, "use.q").is_empty(), "{read}");
    }
}

#[test]
fn eval_and_a_bracketed_value_of_a_string_are_dynamic() {
    // q 5, after `e5:7`: `eval parse "e5+1"` is 8 and `value("e5")` 7, each
    // reading a name inside a string (#538).
    let g = graph(
        &[(
            "dyn.q",
            "a:eval parse \"e5+1\"\nb:value(\"e5\")\nc:value[\"e5\"]\nd:reval parse \"e5\"\n",
        )],
        false,
    );
    assert_eq!(
        kinds(&g, "dyn.q"),
        [(1, "eval"), (2, "value"), (3, "value"), (4, "eval")]
    );
}

#[test]
fn a_modules_names_live_in_its_own_context() {
    // KDB-X 5, with QPATH holding mymod/init.q: after `` m:use`mymod ``,
    // `` key`.m.mymod `` is ``` ``helper`f`g`export ```, and root `helper`
    // is 'helper. So a root read of `helper` reads nothing the module
    // defines, and `.m.mymod.helper` reads its own (#2320).
    let module = "helper:{x*2}\nf:{helper x+1}\ng:{[a;b] a+b}\nexport:([f;g])\n";
    let g = graph(
        &[
            ("mymod/init.q", module),
            ("other.q", "r:helper 3\n"),
            ("qualified.q", "s:.m.mymod.helper 4\n"),
        ],
        false,
    );
    assert!(deps(&g, "other.q").is_empty());
    assert_eq!(deps(&g, "qualified.q"), ["init.q"]);
}

#[test]
fn use_is_an_edge_to_the_module_it_loads() {
    // KDB-X 5 runs mymod/init.q for `` use`mymod ``, tried as `mymod.q` and
    // then `mymod/init.q` under each directory of its search path; and
    // `` use`pkg.sub `` runs pkg/sub/init.q in `.m.pkg.0sub` (#2323).
    let module = "f:{x+1}\nexport:([f])\n";
    let g = graph(
        &[
            ("mymod/init.q", module),
            ("flat.q", "h:{x}\nexport:([h])\n"),
            ("pkg/sub/init.q", "k:{x+100}\nexport:([k])\n"),
            ("pkg/init.q", "w:{x+7}\nr:use`.sub\nexport:([w;r])\n"),
            ("user.q", "m:use`mymod\nr:m.f 1\n"),
            ("flatuser.q", "a:use `flat\n"),
            ("nested.q", "b:use`pkg.sub\n"),
            ("relative.q", "c:use`pkg\n"),
            ("named.q", "t:.m.pkg.w 1\n"),
            // Not a module: KDB-X refuses `use` of a file with no export.
            ("plain.q", "z:1\n"),
            ("noexport.q", "d:use`plain\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "user.q"), ["init.q"]);
    assert_eq!(deps(&g, "flatuser.q"), ["flat.q"]);
    assert_eq!(
        g["nested.q"].dependencies.iter().collect::<Vec<_>>(),
        [Path::new("/no-such-root/pkg/sub/init.q")]
    );
    assert_eq!(
        g["pkg/init.q"].dependencies.iter().collect::<Vec<_>>(),
        [Path::new("/no-such-root/pkg/sub/init.q")]
    );
    assert_eq!(
        g["relative.q"].dependencies.iter().collect::<Vec<_>>(),
        [Path::new("/no-such-root/pkg/init.q")]
    );
    assert_eq!(
        g["named.q"].dependencies.iter().collect::<Vec<_>>(),
        [Path::new("/no-such-root/pkg/init.q")]
    );
    assert!(deps(&g, "noexport.q").is_empty());
}

/// A script every loader loads under a context defines there and not at the
/// root: after `\d .a` / `\l lib/b.q`, b.q's `ff:42` is `.a.ff`, and q 5 has
/// no `ff` for a root reader, which the lint calls undefined. The graph kept
/// the root name, and an edge from each such reader (#2876).
#[test]
fn a_script_loaded_only_under_a_context_defines_no_root_name() {
    let g = graph(
        &[
            ("main.q", "\\d .a\n\\l lib/b.q\n"),
            ("lib/b.q", "ff:42\n"),
            ("d.q", "h:{ff}\n"),
            ("e.q", "k:{.a.ff}\n"),
            ("f.q", "\\d .a\nm:{ff}\n"),
        ],
        false,
    );
    assert!(deps(&g, "d.q").is_empty());
    assert_eq!(deps(&g, "e.q"), ["b.q"]);
    assert_eq!(deps(&g, "f.q"), ["b.q"]);
    // Loaded at the root as well, it defines there too.
    let g = graph(
        &[
            ("main.q", "\\d .a\n\\l lib/b.q\n"),
            ("other.q", "\\l lib/b.q\n"),
            ("lib/b.q", "ff:42\n"),
            ("d.q", "h:{ff}\n"),
        ],
        false,
    );
    assert_eq!(deps(&g, "d.q"), ["b.q"]);
}
