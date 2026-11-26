//! What the server draws over the text of a document: parameter names at the
//! arguments of a call and the type a local's assignments settle (inlay
//! hints), a Run lens and a count of references above each function
//! definition (code lenses), and each load's path as a link to the file it
//! loads (document links).
//!
//! Each is read from the source as navigation reads it, and none runs it. A
//! hint names the parameters a function's definition spells, a lens hands
//! the editor the statement to send, and a link goes where Go to Definition
//! on the path goes.
use super::navigate::{Sources, range};
use super::{Lines, file_key, path_of, starts_statement};
use q_lint_rs::graph::Placement;
use q_lint_rs::{Mention, argument_slots, load_paths, mentions, symbol_mentions, typed_locals};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

/// LSP's `InlayHintKind`s: a type, and a parameter.
const TYPE: u8 = 1;
const PARAMETER: u8 = 2;
/// The command a reference count runs: the client's, which shows the
/// references to the name at the position it is given.
const REFERENCES_COMMAND: &str = "q-lint.showReferences";
/// The command a lens runs: the client's, which sends the code it is given
/// to the connected q process as a query from the editor would be sent.
/// Only an editor that registers it is offered lenses (`codeLens.enable`).
const RUN_COMMAND: &str = "q-lint.runDefinition";

/// What the server adds to its capabilities for the requests answered here.
pub(super) fn announce(capabilities: &mut Value, hints: bool, lenses: bool, links: bool) {
    if hints {
        capabilities["inlayHintProvider"] = json!(true);
    }
    if lenses {
        capabilities["codeLensProvider"] = json!({"resolveProvider": false});
    }
    if links {
        capabilities["documentLinkProvider"] = json!({"resolveProvider": false});
    }
}

/// Which of the hints and lenses are on, each by its own setting.
#[derive(Clone, Copy)]
pub(super) struct Shown {
    pub(super) parameter_hints: bool,
    pub(super) type_hints: bool,
    pub(super) run_lenses: bool,
    pub(super) reference_lenses: bool,
}

pub(super) fn answer(method: &str, params: &Value, sources: &Sources, shown: Shown) -> Value {
    match method {
        "textDocument/inlayHint" => {
            let mut hints = vec![];
            if shown.parameter_hints {
                hints.extend(
                    inlay_hints(params, sources)
                        .as_array()
                        .cloned()
                        .into_iter()
                        .flatten(),
                );
            }
            if shown.type_hints {
                hints.extend(type_hints(params, sources));
            }
            json!(hints)
        }
        "textDocument/codeLens" => {
            let mut lenses = vec![];
            if shown.run_lenses {
                lenses.extend(
                    code_lenses(params, sources)
                        .as_array()
                        .cloned()
                        .into_iter()
                        .flatten(),
                );
            }
            if shown.reference_lenses {
                lenses.extend(reference_lenses(params, sources));
            }
            json!(lenses)
        }
        "textDocument/documentLink" => document_links(params, sources),
        _ => Value::Null,
    }
}

/// What a q type is called, by the number `type` gives it: an atom by its
/// own name, a vector as a list of them.
pub(super) fn type_name(kind: i16) -> String {
    let atom = match kind.abs() {
        0 => return "list".into(),
        1 => "boolean",
        4 => "byte",
        5 => "short",
        6 => "int",
        7 => "long",
        8 => "real",
        9 => "float",
        10 if kind > 0 => return "string".into(),
        10 => "char",
        11 => "symbol",
        12 => "timestamp",
        13 => "month",
        14 => "date",
        16 => "timespan",
        17 => "minute",
        18 => "second",
        19 => "time",
        100 => return "lambda".into(),
        _ => return format!("type {kind}h"),
    };
    if kind < 0 {
        atom.into()
    } else {
        format!("{atom} list")
    }
}

/// The inlay hints for types: after the value of a local's first
/// assignment in the range, the type every assignment of it settles -
/// `a:1 2 3` drawn as `a:1 2 3 long list`. None for a local whose type
/// reading cannot settle (`q_lint_rs::typed_locals`).
fn type_hints(params: &Value, sources: &Sources) -> Vec<Value> {
    let Some((_, text)) = sources.document(params) else {
        return vec![];
    };
    let lines = Lines::new(text);
    let offset = |position: &Value| {
        Some(lines.offset(
            position["line"].as_u64()? as usize,
            position["character"].as_u64()? as usize,
        ))
    };
    let from = offset(&params["range"]["start"]).unwrap_or(0);
    let to = offset(&params["range"]["end"]).unwrap_or(text.len());
    typed_locals(text)
        .into_iter()
        .filter(|t| from <= t.end && t.end <= to)
        .map(|t| {
            let name = type_name(t.kind);
            json!({
                "position": lines.json(t.end),
                "label": name,
                "kind": TYPE,
                "paddingLeft": true,
                "tooltip": format!("{}: {name}, type {}h, from its assignments", t.local.name, t.kind),
            })
        })
        .collect()
}

/// `textDocument/inlayHint`: at each argument in the range of a bracketed
/// call to a workspace function, the name of the parameter it is passed
/// as - `f[a:1;b:2]` drawn over `f[1;2]`.
///
/// Only for a function whose every definition declares its parameters in a
/// signature and declares the same ones: `x`, `y` and `z` say nothing a
/// reader does not know, and two definitions that disagree leave which one
/// is called to whatever ran last. Not at an empty slot of a projection,
/// past the last parameter, or at an argument written as the parameter's
/// own name, where the hint would repeat it.
fn inlay_hints(params: &Value, sources: &Sources) -> Value {
    let Some((uri, text)) = sources.document(params) else {
        return json!([]);
    };
    let key = file_key(&path_of(uri));
    let lines = Lines::new(text);
    let offset = |position: &Value| {
        Some(lines.offset(
            position["line"].as_u64()? as usize,
            position["character"].as_u64()? as usize,
        ))
    };
    let from = offset(&params["range"]["start"]).unwrap_or(0);
    let to = offset(&params["range"]["end"]).unwrap_or(text.len());
    let placement = sources.placement(&key);
    let all = mentions(text);
    let mut at: HashMap<usize, Vec<&Mention>> = HashMap::new();
    for m in &all {
        at.entry(m.at).or_default().push(m);
    }
    let mut known: HashMap<Vec<String>, Option<Vec<String>>> = HashMap::new();
    let mut read = HashMap::new();
    let mut hints = vec![];
    // The slots with their strings in them: in the code view a string is
    // blank, and an argument that is one would start after it (#2025).
    for call in argument_slots(text) {
        // A hint is asked for by where it is drawn, as a type's is: an
        // editor asks for the lines it shows, and a call that began above
        // them still has arguments on them (#2952).
        let drawn = |&(start, _): &(usize, usize)| from <= start && start <= to;
        if !call.arguments.iter().any(drawn) {
            continue;
        }
        // A local's or q's own name is no mention; an indexed assignment,
        // `d[k]:v`, is a write.
        let Some(found) = at.get(&call.at) else {
            continue;
        };
        if found.iter().any(|m| m.definition.is_some()) {
            continue;
        }
        let mut names: Vec<String> = found
            .iter()
            .flat_map(|m| sources.names(text, m, &placement))
            .collect();
        names.sort_unstable();
        names.dedup();
        let declared = known
            .entry(names)
            .or_insert_with_key(|names| declared(sources, names, &key, &mut read));
        let Some(declared) = declared else {
            continue;
        };
        for (&(start, len), param) in call.arguments.iter().zip(declared.iter()) {
            // A typed slot is shown by its name alone: `` x:`j: `` reads as
            // an assignment (#2778). An empty slot, the second of
            // `{[a;] a}`, names nothing (#2779).
            let param = q_lint_rs::slot_pattern(param);
            if len == 0
                || param.is_empty()
                || text[start..start + len] == *param
                || !drawn(&(start, len))
            {
                continue;
            }
            hints.push(json!({
                "position": lines.json(start),
                "label": format!("{param}:"),
                "kind": PARAMETER,
                "paddingRight": true,
            }));
        }
    }
    json!(hints)
}

/// Each definition in one file, by each name it answers to: the parameters
/// its signature declares, or `None` for one with no signature or no lambda.
type Declarations = HashMap<String, Vec<Option<Vec<String>>>>;

/// The definitions of the file `key`, read once for every call that asks
/// (`read` holds them): read again for each name, a file of N definitions
/// took N passes over it (#1216).
fn declarations<'r>(
    sources: &Sources,
    key: &str,
    read: &'r mut HashMap<String, Option<Declarations>>,
) -> Option<&'r Declarations> {
    read.entry(key.to_string())
        .or_insert_with(|| {
            let (_, text) = sources.text(key)?;
            let placement = sources.placement(key);
            let mut out = Declarations::new();
            for m in &mentions(&text) {
                let Some(definition) = &m.definition else {
                    continue;
                };
                let params = (definition.function && !definition.detail.is_empty())
                    .then(|| definition.params.clone());
                let mut names = sources.names(&text, m, &placement);
                names.sort_unstable();
                names.dedup();
                for name in names {
                    out.entry(name).or_default().push(params.clone());
                }
            }
            Some(out)
        })
        .as_ref()
}

/// The parameters every definition of the global known by `names` declares
/// in a signature, when there is at least one and they agree.
fn declared(
    sources: &Sources,
    names: &[String],
    from: &str,
    read: &mut HashMap<String, Option<Declarations>>,
) -> Option<Vec<String>> {
    let wanted: HashSet<String> = names.iter().cloned().collect();
    let mut agreed: Option<Vec<String>> = None;
    for key in sources.definers(&wanted, from) {
        let declarations = declarations(sources, key, read)?;
        for params in names.iter().filter_map(|n| declarations.get(n)).flatten() {
            let params = params.as_ref()?;
            match &agreed {
                Some(agreed) if agreed != params => return None,
                Some(_) => {}
                None => agreed = Some(params.clone()),
            }
        }
    }
    agreed.filter(|params| !params.is_empty())
}

/// A function a statement at column 0 defines, as a lens or a test runs
/// it: the name as written at `at` for `len` bytes, the name q gives it
/// once defined, the code that defines it (the statement, wrapped in
/// `\d .ns` and `\d .` when it is written under `\d .ns`, or before the
/// first `\d` of a file that runs in `.ns` alone) and, for a test,
/// the call that runs it once defined and the code that defines the qUnit
/// fixtures that call runs around it (#1590).
pub(super) struct Runnable {
    pub(super) at: usize,
    pub(super) len: usize,
    pub(super) name: String,
    pub(super) code: String,
    pub(super) test: Option<String>,
    pub(super) fixtures: String,
}

/// Whether a function named `name` is a test: its last part starts
/// `test_`, as this repository's suites and uqf's `.qt` ones are written,
/// or `test` and a capital, as qUnit's (`.mytests.testAddition`) are.
pub(super) fn is_test(name: &str) -> bool {
    let leaf = name.rsplit('.').next().unwrap_or(name);
    leaf.starts_with("test_")
        || leaf
            .strip_prefix("test")
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_uppercase()))
}

/// The namespace of `name` as q resolves it, and its last part: `None` for
/// one at the root.
fn namespace_of(name: &str) -> Option<(&str, &str)> {
    name.rsplit_once('.')
        .filter(|(ns, _)| ns.len() > 1 && ns.starts_with('.'))
}

/// qUnit's fixtures (#1590), in the order `.qunit.runTest` runs them around
/// each test of their namespace: `beforeNamespace*` and `setUp*` before it,
/// `tearDown*` and `afterNamespace*` after.
const FIXTURES_BEFORE: [&str; 2] = ["beforeNamespace", "setUp"];
const FIXTURES_AFTER: [&str; 2] = ["tearDown", "afterNamespace"];

/// What qUnit's `.qunit.runTest` does with a test whose run takes longer,
/// or more memory, than its namespace's `qunitConfig` allows (#2103).
const OVER_CONFIG: &str = "exceeded max config time/mem";

/// Each function a statement at column 0 of `text` defines, in order, in
/// a file its loaders put at `placement`.
pub(super) fn runnables(text: &str, placement: &Placement) -> Vec<Runnable> {
    let mut out: Vec<Runnable> = vec![];
    let mut seen = HashSet::new();
    // A file that uses qUnit runs every `test*` of a namespace, as
    // `.qunit.runNsTests` does (#1591).
    let qunit = text.contains(".qunit.");
    // Read once: asked for each definition, the whole file was read again
    // for each (#1216).
    let contexts = q_lint_rs::contexts(text);
    // Where a bare name written before the file's first `\d` lands when
    // the file runs in one context and not at the root - loaded under
    // `\d .lib`, or a KDB-X module, which runs in `.m.<name>`: defined at
    // the root, it is a copy nothing else reads, of a body whose own bare
    // names are not there (#2671).
    let loaded = placement
        .contexts
        .first()
        .filter(|_| !placement.root && placement.contexts.len() == 1);
    // A namespace's `qunitConfig`, where and as it is defined (#2103): not a
    // function, so no runnable, but sent with the tests it configures.
    let mut configs: Vec<(usize, String, String)> = vec![];
    for m in &mentions(text) {
        let Some(definition) = &m.definition else {
            continue;
        };
        if m.at != definition.start || !starts_statement(text, m.at) {
            continue;
        }
        let spelled = &text[m.at..m.at + m.len];
        let statement = text[definition.start..definition.end].trim_end();
        let context = contexts
            .get(
                contexts
                    .partition_point(|(at, _)| *at <= m.at)
                    .wrapping_sub(1),
            )
            .map(|(_, ns)| ns.clone())
            .filter(|ns| !ns.is_empty() && ns != ".")
            .or_else(|| loaded.filter(|_| m.implicit).cloned());
        let code = match &context {
            Some(ns) => format!("\\d {ns}\n{statement}\n\\d ."),
            None => statement.to_string(),
        };
        // Called by the name it has once defined: a bare one before the
        // file's first `\d` is wherever the process puts it, the root for a
        // query.
        let placed = loaded.map(|ns| format!("{ns}.{spelled}"));
        let name = match &placed {
            Some(placed) if m.implicit => placed,
            _ if m.implicit => spelled,
            _ => &m.name,
        };
        if !definition.function {
            if qunit
                && namespace_of(name).is_some_and(|(_, leaf)| leaf == "qunitConfig")
                && configs.iter().all(|(at, _, _)| *at != m.at)
            {
                configs.push((m.at, name.to_string(), code));
            }
            continue;
        }
        if !seen.insert(m.at) {
            continue;
        }
        let qunit_test =
            qunit && namespace_of(name).is_some_and(|(_, leaf)| leaf.starts_with("test"));
        out.push(Runnable {
            at: m.at,
            len: m.len,
            name: name.to_string(),
            test: (is_test(spelled) || qunit_test).then(|| format!("{name}[]")),
            code,
            fixtures: String::new(),
        });
    }
    // A test in a namespace that defines qUnit fixtures runs inside them:
    // they are defined with it, and called around it, the test's error
    // signalled again once its `tearDown*` has run. Only in a file that uses
    // qUnit: elsewhere a `setUp*` or `tearDown*` is the file's own (#1743).
    let wrapped: Vec<(usize, String, String)> = out
        .iter()
        .enumerate()
        .filter_map(|(i, run)| {
            let (ns, _) = namespace_of(&run.name).filter(|_| qunit && run.test.is_some())?;
            let of = |kinds: &[&str]| -> Vec<&Runnable> {
                kinds
                    .iter()
                    .flat_map(|k| {
                        out.iter().filter(move |r| {
                            namespace_of(&r.name)
                                .is_some_and(|(n, leaf)| n == ns && leaf.starts_with(k))
                        })
                    })
                    .collect()
            };
            let (before, after) = (of(&FIXTURES_BEFORE), of(&FIXTURES_AFTER));
            // qUnit's `.qunit.runNsTests` runs each test once for each value
            // its namespace's first `parameters*` gives, with `.ns.parameter`
            // set to it, between its `beforeParameters*` and
            // `afterParameters*` (#2104).
            let mut parameters = of(&["parameters"]);
            parameters.sort_by(|a, b| a.name.cmp(&b.name));
            let parameters = parameters.first().copied();
            let (before_all, after_all) = if parameters.is_some() {
                (of(&["beforeParameters"]), of(&["afterParameters"]))
            } else {
                (vec![], vec![])
            };
            let config = configs
                .iter()
                .find(|(_, name, _)| namespace_of(name).is_some_and(|(n, _)| n == ns));
            if before.is_empty() && after.is_empty() && parameters.is_none() && config.is_none() {
                return None;
            }
            let calls = |rs: &[&Runnable]| -> String {
                rs.iter().map(|r| format!("{}[]; ", r.name)).collect()
            };
            let mut defined: Vec<(usize, &str)> = before
                .iter()
                .chain(&after)
                .chain(&before_all)
                .chain(&after_all)
                .chain(&parameters)
                .map(|r| (r.at, r.code.as_str()))
                .chain(config.map(|(at, _, code)| (*at, code.as_str())))
                .collect();
            defined.sort_by_key(|(at, _)| *at);
            defined.dedup();
            let fixtures = defined
                .iter()
                .map(|(_, code)| format!("{code}\n"))
                .collect();
            // The test alone is timed, as `.qunit.runTest` times it, and
            // fails over what `.ns.qunitConfig[`test]` allows (#2103).
            let protected = format!("@[{{(1b;x[])}};{};{{(0b;x)}}]", run.name);
            let ran = match config {
                Some(_) => {
                    let (_, leaf) = namespace_of(&run.name).unwrap_or_default();
                    format!(
                        "t:.Q.ts[{{{}}};enlist {}]; r:t 1; \
                         c:@[{{.[`{ns};`qunitConfig`{leaf}]}};::;``!``]; \
                         c:(`maxTime`maxMem!0W 0W),$[99h~type c;c;()!()]; \
                         if[r[0]&any t[0]>c`maxTime`maxMem;r:(0b;\"{OVER_CONFIG}\")]; ",
                        protected.replacen(&run.name, "x", 1),
                        run.name,
                    )
                }
                None => format!("r:{protected}; "),
            };
            let once = format!("{}{ran}{}", calls(&before), calls(&after));
            let call = match parameters {
                Some(p) => format!(
                    "{{[] {}p:@[{{x[]}};{};()]; i:0; f:(1b;::); \
                     do[max 1,count p; @[`{ns};`parameter;:;p i]; {once}if[f 0;f:r]; i+:1]; \
                     {}$[f 0;f 1;'f 1]}}[]",
                    calls(&before_all),
                    p.name,
                    calls(&after_all),
                ),
                None => format!("{{[] {once}$[r 0;r 1;'r 1]}}[]"),
            };
            Some((i, fixtures, call))
        })
        .collect();
    for (i, fixtures, call) in wrapped {
        out[i].fixtures = fixtures;
        out[i].test = Some(call);
    }
    out
}

/// `textDocument/codeLens`: above each function a statement at column 0
/// defines, **Run**, which sends that statement to the connected process -
/// under the `\d` it is written in, and back to the root after - and above a
/// test (`is_test`), **Run test** too, which sends it and then calls it with
/// no argument.
///
/// The code is the lens's argument, as the text is when the lenses are
/// asked for: an editor asks again as the document changes.
fn code_lenses(params: &Value, sources: &Sources) -> Value {
    let Some((uri, text)) = sources.document(params) else {
        return json!([]);
    };
    let lines = Lines::new(text);
    let mut lenses = vec![];
    let placement = sources.placement(&file_key(&path_of(uri)));
    for run in runnables(text, &placement) {
        let at = range(&lines, run.at, run.len);
        let lens = |title: &str, code: String| {
            json!({"range": at, "command": {"title": title, "command": RUN_COMMAND,
                                             "arguments": [code, uri]}})
        };
        lenses.push(lens("Run", run.code.clone()));
        if let Some(call) = &run.test {
            lenses.push(lens(
                "Run test",
                format!("{}{}\n{call}", run.fixtures, run.code),
            ));
        }
    }
    json!(lenses)
}

/// `textDocument/codeLens`, the reference counts: above each function a
/// statement at column 0 defines, how many places the indexed files read it
/// (what Find All References lists without the assignments, a symbol that
/// may be the name among them), which opens those references when clicked.
///
/// One pass over the workspace answers every function of the document: a
/// file is read only when it spells one of their names.
fn reference_lenses(params: &Value, sources: &Sources) -> Vec<Value> {
    let Some((uri, text)) = sources.document(params) else {
        return vec![];
    };
    let key = file_key(&path_of(uri));
    let placement = sources.placement(&key);
    let lines = Lines::new(text);
    let mut defined: Vec<(usize, usize, HashSet<String>)> = vec![];
    let mut seen = HashSet::new();
    for m in &mentions(text) {
        let Some(definition) = &m.definition else {
            continue;
        };
        if !definition.function
            || m.at != definition.start
            || !starts_statement(text, m.at)
            || !seen.insert(m.at)
        {
            continue;
        }
        let names: HashSet<String> = sources.names(text, m, &placement).into_iter().collect();
        if !names.is_empty() {
            defined.push((m.at, m.len, names));
        }
    }
    if defined.is_empty() {
        return vec![];
    }
    let leaves: HashSet<&str> = defined
        .iter()
        .flat_map(|(_, _, names)| names.iter().filter_map(|n| n.rsplit('.').next()))
        .collect();
    // Each wanted name to the definitions it counts for: a mention is
    // looked up by its names, not checked against every definition (#1216).
    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, (_, _, wanted)) in defined.iter().enumerate() {
        for name in wanted {
            by_name.entry(name.as_str()).or_default().push(i);
        }
    }
    // Mentions counted by the wanted names they have, and only then given
    // to the definitions those names count for: one name defined n times
    // and read n times was n^2 increments (#2349).
    let mut by_names: HashMap<Vec<&str>, usize> = HashMap::new();
    for file in sources.keys() {
        let Some((_, other)) = sources.text(file) else {
            continue;
        };
        if !leaves.iter().any(|leaf| other.contains(leaf)) {
            continue;
        }
        let placement = sources.placement(file);
        let all = mentions(&other);
        for m in all.iter().filter(|m| m.definition.is_none()) {
            let mut names: Vec<&str> = sources
                .names(&other, m, &placement)
                .iter()
                .filter_map(|name| by_name.get_key_value(name.as_str()).map(|(k, _)| *k))
                .collect();
            if names.is_empty() {
                continue;
            }
            names.sort_unstable();
            names.dedup();
            *by_names.entry(names).or_insert(0) += 1;
        }
        // And each symbol that may be one of the names, as the references
        // the lens opens list it (#2679): by where it is, since one symbol
        // may be the name in its context or at the root.
        // The file is read once for the symbols it spells, not once for
        // each name wanted.
        let known: HashSet<usize> = all.iter().map(|m| m.at).collect();
        let spelled: HashSet<&str> = other
            .match_indices('`')
            .filter_map(|(tick, _)| {
                let rest = &other[tick + 1..];
                let end = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || "_.:/".contains(c)))
                    .unwrap_or(rest.len());
                leaves.get(&rest[..end]).copied()
            })
            .collect();
        let mut symbols: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
        for leaf in spelled {
            for m in symbol_mentions(&other, leaf) {
                if known.contains(&m.at) {
                    continue;
                }
                symbols.entry(m.at).or_default().extend(
                    sources
                        .names(&other, &m, &placement)
                        .iter()
                        .filter_map(|name| by_name.get_key_value(name.as_str()).map(|(k, _)| *k)),
                );
            }
        }
        for (_, mut names) in symbols {
            if names.is_empty() {
                continue;
            }
            names.sort_unstable();
            names.dedup();
            *by_names.entry(names).or_insert(0) += 1;
        }
    }
    let mut counts = vec![0usize; defined.len()];
    for (names, n) in by_names {
        let mut hit: Vec<usize> = names
            .iter()
            .flat_map(|name| &by_name[name])
            .copied()
            .collect();
        hit.sort_unstable();
        hit.dedup();
        for i in hit {
            counts[i] += n;
        }
    }
    defined
        .iter()
        .zip(counts)
        .map(|((at, len, _), n)| {
            let title = if n == 1 {
                "1 reference".to_string()
            } else {
                format!("{n} references")
            };
            json!({"range": range(&lines, *at, *len), "command": {
                "title": title, "command": REFERENCES_COMMAND,
                "arguments": [uri, lines.json(*at)]}})
        })
        .collect()
}

/// `textDocument/documentLink`: the path of each load - `\l path`,
/// `system "l path"` or a file symbol `` `:lib/x.q `` - as a link to the
/// file it loads, followed as Go to Definition follows it: against the
/// workspace folder, then the loading file's own directory and each one
/// above it. No link for a load that reaches no file, or a directory, which
/// loads several.
fn document_links(params: &Value, sources: &Sources) -> Value {
    let Some((uri, text)) = sources.document(params) else {
        return json!([]);
    };
    let key = file_key(&path_of(uri));
    let lines = Lines::new(text);
    load_paths(text)
        .into_iter()
        .filter_map(|(at, len)| {
            let [file] = sources
                .loaded(&key, &text[at..at + len], true)
                .try_into()
                .ok()?;
            Some(json!({
                "range": range(&lines, at, len),
                "target": sources.uri(&file),
                "tooltip": format!("Open {}", super::help::shown(sources, &file)),
            }))
        })
        .collect()
}
