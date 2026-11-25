//! Offline q analysis. Unknown expressions are deliberately left unresolved.
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::LazyLock;

macro_rules! re {
    ($pattern:expr) => {{
        static RE: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($pattern).unwrap());
        &*RE
    }};
}
/// Blanks inside one statement, for a pattern to span: spaces and tabs, and a
/// line break only into an indented line, which q continues the statement
/// with. `\s` would run on into the next statement - `r:x like "a*"`, then
/// `` `t insert 1 `` at column 0, is no `like` of a symbol (#722, #725, #730).
macro_rules! blank {
    () => {
        r"(?:[ \t\r]|\n[\r\n]*[ \t])"
    };
}
mod families;
mod intrinsics;
pub mod options;
mod refusals;
mod semantics;
pub use semantics::TokenKind;

/// What one file defines for the files around it: the global names it
/// assigns, each as the one name q resolves it to (`.ns.f` inside `\d .ns`,
/// and `f` - not `.f` - at the root), and which of them it assigns a lambda.
#[derive(Default, Clone, PartialEq, Eq, Debug)]
pub struct FileIndex {
    pub defined: std::collections::HashSet<String>,
    pub lambdas: std::collections::HashSet<String>,
}

/// The definitions of every file in a workspace, as counts of how many files
/// define each name. A file asks what is defined *elsewhere* - by subtracting
/// itself - because its own definitions it reads directly, and because a name
/// another file also assigns is one whose value this file cannot know.
///
/// Building one reads files and never runs them: the same passes the checks
/// use, stopped before any rule.
///
/// And where each file's loaders put it, for one loaded anywhere but the
/// root alone: a name a file reads bare before its first `\d` is read in
/// each context it is loaded in, and a rule that says such a name is
/// undefined has to ask there (#2178).
#[derive(Default, Debug)]
pub struct Workspace {
    defined: std::collections::HashMap<String, usize>,
    lambdas: std::collections::HashMap<String, usize>,
    placements: std::collections::HashMap<std::path::PathBuf, graph::Placement>,
}

/// One key per file for `Workspace::place`, so a file placed under one
/// spelling of its path is found under another: its real path, or for one
/// not on disk - a buffer not yet saved - the real path of the nearest
/// folder above it that is, as the language server keys its files.
fn placement_key(path: &std::path::Path) -> std::path::PathBuf {
    path.ancestors()
        .find_map(|dir| {
            let real = std::fs::canonicalize(dir).ok()?;
            Some(match path.strip_prefix(dir).ok()? {
                rest if rest.as_os_str().is_empty() => real,
                rest => real.join(rest),
            })
        })
        .unwrap_or_else(|| path.to_path_buf())
}

impl Workspace {
    pub fn add(&mut self, file: &FileIndex) {
        for name in &file.defined {
            *self.defined.entry(name.clone()).or_default() += 1;
        }
        for name in &file.lambdas {
            *self.lambdas.entry(name.clone()).or_default() += 1;
        }
    }

    pub fn remove(&mut self, file: &FileIndex) {
        for (map, names) in [
            (&mut self.defined, &file.defined),
            (&mut self.lambdas, &file.lambdas),
        ] {
            for name in names {
                if let Some(count) = map.get_mut(name) {
                    *count -= 1;
                    if *count == 0 {
                        map.remove(name);
                    }
                }
            }
        }
    }

    /// Record where the file `path` is loaded: its `graph::placements`
    /// entry. A file loaded at the root alone is not kept.
    pub fn place(&mut self, path: &std::path::Path, placement: &graph::Placement) {
        if *placement == graph::Placement::default() {
            if !self.placements.is_empty() {
                self.placements.remove(&placement_key(path));
            }
        } else {
            self.placements
                .insert(placement_key(path), placement.clone());
        }
    }

    /// Where the file `path` is loaded, when anywhere but the root alone.
    pub(crate) fn placement(&self, path: &str) -> Option<&graph::Placement> {
        if self.placements.is_empty() {
            return None;
        }
        self.placements
            .get(&placement_key(std::path::Path::new(path)))
    }

    /// Whether a file other than the one whose own definitions are `own`
    /// defines `name`. The file asking may or may not have been added.
    pub(crate) fn defined_elsewhere(
        &self,
        name: &str,
        own: &std::collections::HashSet<String>,
    ) -> bool {
        self.elsewhere_but(name, |n| own.contains(n))
    }

    /// `defined_elsewhere`, for a name read in the file loaded where
    /// `placement` says: a root name, which a read before the file's first
    /// `\d` is, is also the name in each context the file is loaded in -
    /// `true` in a file `\l`oaded under `\d .ns` is `.ns.true` (#2178). A
    /// root read after a `\d .` is asked about those too, which can only
    /// keep a finding back, never make one. The file's own root names are
    /// its own in those contexts as well.
    pub(crate) fn defined_elsewhere_as_loaded(
        &self,
        name: &str,
        own: &std::collections::HashSet<String>,
        placement: Option<&graph::Placement>,
    ) -> bool {
        if self.defined_elsewhere(name, own) {
            return true;
        }
        let Some(placement) = placement.filter(|_| !name.starts_with('.')) else {
            return false;
        };
        placement.contexts.iter().any(|ns| {
            let mine = |n: &str| {
                own.contains(n)
                    || n.strip_prefix(ns.as_str())
                        .and_then(|rest| rest.strip_prefix('.'))
                        .is_some_and(|bare| own.contains(bare))
            };
            self.elsewhere_but(&format!("{ns}.{name}"), mine)
        })
    }

    fn elsewhere_but(&self, name: &str, own: impl Fn(&str) -> bool) -> bool {
        // Or a namespace holding it, written as a whole: `.cfg:d` elsewhere
        // may give `.cfg.n` any value.
        std::iter::once(name)
            .chain(
                name.match_indices('.')
                    .filter(|&(i, _)| i > 0)
                    .map(|(i, _)| &name[..i]),
            )
            .any(|n| self.defined.get(n).copied().unwrap_or(0) > usize::from(own(n)))
    }

    /// Whether any file defines `name`, exactly.
    pub fn defines(&self, name: &str) -> bool {
        self.defined.contains_key(name)
    }

    pub(crate) fn is_lambda(&self, name: &str) -> bool {
        self.lambdas.contains_key(name)
    }

    /// Every name the workspace defines, in no order, with whether a file
    /// assigns it a lambda.
    pub fn names(&self) -> impl Iterator<Item = (&str, bool)> {
        self.defined
            .keys()
            .map(|name| (name.as_str(), self.is_lambda(name)))
    }
}

/// What `source` defines, for indexing it into a `Workspace`.
pub fn index(source: &str) -> FileIndex {
    let v = views(source);
    semantics::index(&v.code, source)
}

/// What one file reads from the files around it, for the dependency graph -
/// the counterpart of `FileIndex`, kept apart from it so the language server,
/// which indexes on every keystroke, does not pay for a graph it never draws.
#[derive(Default, Clone, PartialEq, Eq, Debug)]
pub struct References {
    /// Each global read, as the one name q resolves it to under the `\d`
    /// context in force: `.a.f` inside `\d .a`, and `f` - not `.f` - at the
    /// root.
    pub names: Vec<String>,
    /// The reads written without a leading dot, which q resolves in a
    /// context and, failing that, in `.q`.
    pub relative: Vec<Relative>,
    /// Each global this file assigns, named the same way, as `FileIndex`
    /// does.
    pub defines: Vec<String>,
    /// Those of `defines` assigned before the file's first `\d`, by a name
    /// without a leading dot: a load under `\d .a` puts them in `.a`.
    pub implicit_defines: Vec<String>,
    /// The paths of `\l path`, `system "l path"` and `` `:path.q ``, as
    /// written, each with the `\d` in force where it is loaded, since the
    /// loaded script runs in it: `""` before the file's first `\d`, where
    /// that is whichever context the file is loaded in, and `"."` at the
    /// root after it.
    pub loads: Vec<(String, String)>,
    /// Where a name is reached by a value computed at run time.
    pub dynamic: Vec<Dynamic>,
}

/// A global read by a name without a leading dot: `name` as written, and
/// `resolved` as it appears in `References::names`. `implicit` when it is
/// read before the file's first `\d`, where the context is whichever one
/// the file is loaded in.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Relative {
    pub name: String,
    pub resolved: String,
    pub implicit: bool,
}

/// A place reading cannot see through: `kind` is `value` (of a string),
/// `get` (of anything but a literal), `eval` (or `reval`, of a parse tree),
/// `sv` (a name built from parts), `set` (into a computed name) or `load` (a
/// concatenated `system "l ..."`). A
/// `get`, `value` or `set` of an unqualified symbol inside a lambda written
/// under `\d` is one too: q looks the symbol up in the `\d` current when the
/// lambda is called, which the source does not say.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Dynamic {
    pub line: usize,
    pub kind: &'static str,
}

/// What `source` reads, loads and reaches dynamically. `symbols` also counts
/// a qualified symbol literal, `` `.ns.f ``, as a read of that name.
pub fn references(source: &str, symbols: bool) -> References {
    let v = views(source);
    semantics::references(&v.code, source, symbols)
}

/// A global name at one place in a file: `name` as q resolves it under the
/// `\d` in force, at byte `at` for `len` bytes. `implicit` when it is
/// written without a leading dot before the file's first `\d`, where the
/// context is whichever one the file is loaded in; `definition` when this
/// is a write of the name and not a read.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Mention {
    pub name: String,
    pub implicit: bool,
    pub at: usize,
    pub len: usize,
    pub definition: Option<Definition>,
}

/// One write of a global. `function` when what it assigns is a lambda, with
/// its signature as written in `detail` - `[a;b]`, and empty for an implicit
/// one - and in `params` what a caller of the name passes: the signature's
/// slots, x, y and z as far as a body without one reads them, and for a
/// projection the slots it leaves open. `start..end` is the statement making
/// the write, for an outline to select and fold.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Definition {
    pub function: bool,
    pub detail: String,
    pub params: Vec<String>,
    pub start: usize,
    pub end: usize,
}

/// What a name in the source refers to.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Name {
    Local(Local),
    /// A global at `at`, by each name q may resolve it to, with whether that
    /// name is `Mention::implicit`.
    Global {
        at: usize,
        len: usize,
        names: Vec<(String, bool)>,
    },
}

/// A parameter or local of one lambda, with each place the lambda names it.
/// `declared` is the place, by index, that introduces it: the signature's
/// for a parameter, the first assignment for a local. `implicit` for an x,
/// y or z no signature declares.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Local {
    pub name: String,
    pub implicit: bool,
    pub declared: Option<usize>,
    pub places: Vec<Place>,
}

/// One place a local is named. `write` where it is declared or assigned;
/// `column` inside a qSQL phrase, where the name is the table's column
/// instead whenever the table has one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Place {
    pub at: usize,
    pub len: usize,
    pub write: bool,
    pub column: bool,
}

/// Every global name `source` writes or reads, in order.
pub fn mentions(source: &str) -> Vec<Mention> {
    let v = views(source);
    semantics::navigate::mentions(&v.code, &v.comments, source)
}

/// Each symbol in `source` that spells `leaf` and no more, as the global it
/// would name where something took it for a name. `mentions` holds the ones
/// q is known to take so; the others may be the name or only a symbol.
pub fn symbol_mentions(source: &str, leaf: &str) -> Vec<Mention> {
    let v = views(source);
    semantics::navigate::symbols(&v.code, source, leaf)
}

/// The path of the load at byte `offset` of `source` - `\l path`,
/// `system "l path"` or a file symbol, as `References::loads` reads it - as
/// its start and length, when the offset is in one. Its end counts: a cursor
/// just past the last character is still on the path.
pub fn load_at(source: &str, offset: usize) -> Option<(usize, usize)> {
    let v = views(source);
    semantics::load_paths(&v.code, source)
        .into_iter()
        .find(|path| path.contains(&offset) || path.end == offset)
        .map(|path| (path.start, path.len()))
}

/// What the name at byte `offset` of `source` refers to, when there is one.
pub fn name_at(source: &str, offset: usize) -> Option<Name> {
    let v = views(source);
    semantics::navigate::name_at(&v.code, source, offset)
}

/// The byte range of the local at `offset`, or why it cannot be renamed.
pub fn rename_target(source: &str, offset: usize) -> Result<(usize, usize), String> {
    let v = views(source);
    semantics::navigate::rename_target(&v.code, source, offset)
}

/// The byte ranges to replace with `new` to rename the local at `offset`,
/// or why it cannot be renamed to that.
pub fn rename(source: &str, offset: usize, new: &str) -> Result<Vec<(usize, usize)>, String> {
    let v = views(source);
    semantics::navigate::rename(&v.code, source, offset, new)
}

/// The first of `offsets` in `source` that is inside a lambda with a
/// parameter or local called `name`: where a global renamed to `name` would
/// be hidden by the local.
pub fn shadowing(source: &str, name: &str, offsets: &[usize]) -> Option<usize> {
    let v = views(source);
    semantics::navigate::shadowing(&v.code, source, name, offsets)
}

/// Where `source` hands a global by its name to a word that changes it in
/// place - `` update c:1 from `t ``, `` `c xasc `t ``, `@[`t;..]` - as the
/// start of each such symbol's name.
pub fn changed_by_name(source: &str) -> Vec<usize> {
    let v = views(source);
    semantics::navigate::changed_by_name(&v.code)
}

/// The first of `offsets` of `source` on a `k)` line, where k reads the
/// name: see `semantics::navigate::on_k_line`.
pub fn on_k_line(source: &str, offsets: &[usize]) -> Option<usize> {
    let v = views(source);
    semantics::navigate::on_k_line(&v.code, source, offsets)
}

/// What Extract Function writes for a selection: see `extract`.
pub use semantics::extract::{Extraction, fresh_name};

/// The selection `from..to` of `source` made a lambda of its own - its
/// trimmed range, the lambda's parameters (the locals of the lambda around
/// it that it reads) and body, and where the new definition goes - or why
/// that would change what the code means.
pub fn extract(source: &str, from: usize, to: usize) -> Result<Extraction, String> {
    let v = views(source);
    semantics::extract::extract(&v.code, &v.comments, source, from, to)
}

pub use semantics::layout::Layout as QsqlLayout;

/// Every qSQL query in `source` whose one-line form is longer than `width`
/// characters, laid out on aligned lines - a clause per line, a part's
/// items one per line where they do not fit - as replacements in order.
/// Only blanks change, and only where q reads the result as it read the
/// original (see `semantics::layout`).
pub fn qsql_layouts(source: &str, width: usize) -> Vec<QsqlLayout> {
    let v = views(source);
    semantics::layout::layouts(&v.code, &v.comments, source, width)
}

/// The qSQL query around byte `at` laid out with every clause on its own
/// line, however short it is; `None` where there is none, it cannot be laid
/// out safely, or it is laid out so already.
pub fn qsql_layout_at(source: &str, at: usize, width: usize) -> Option<QsqlLayout> {
    let v = views(source);
    semantics::layout::layout_at(&v.code, &v.comments, source, at, width)
}

pub use semantics::functional::Conversion as QsqlConversion;

/// The qSQL query around byte `at` rewritten in its functional form
/// (`?[t;c;b;a]`, `![t;c;b;a]`); `None` outside a query, and the reason
/// where the text does not settle one (see `semantics::functional`).
pub fn qsql_to_functional(source: &str, at: usize) -> Option<Result<QsqlConversion, String>> {
    let v = views(source);
    semantics::functional::to_functional_at(&v.code, &v.comments, source, at)
}

/// The functional form (`?[...]` or `![...]` of four arguments) around byte
/// `at` written as qSQL; `None` where there is none, and the reason where
/// it has no qSQL spelling this can write.
pub fn functional_to_qsql(source: &str, at: usize) -> Option<Result<QsqlConversion, String>> {
    let v = views(source);
    semantics::functional::to_qsql_at(&v.code, source, at)
}

/// The qSQL query or functional form around byte `at` said in words, as
/// Markdown: what it reads, keeps, groups and returns
/// (`semantics::explain`). `None` outside one.
pub fn explain_qsql(source: &str, at: usize) -> Option<String> {
    let v = views(source);
    semantics::explain::explain_at(&v.code, &v.comments, source, at)
}

/// For each of `offsets` in `source`, the qSQL clause it is written in -
/// `select`, `by`, `from`, `where` and so on - or `None` outside a query,
/// where a name is no column.
pub fn query_clauses(source: &str, offsets: &[usize]) -> Vec<Option<&'static str>> {
    let v = views(source);
    offsets
        .iter()
        .map(|&at| query_clause(&v.code, at.min(v.code.len())))
        .collect()
}

/// A bracketed call around a cursor: the name called, at byte `at` for `len`
/// bytes, and which argument the cursor is in, from 0.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Call {
    pub at: usize,
    pub len: usize,
    pub argument: usize,
}

/// A call written as a name and its brackets: the name at byte `at` for
/// `len` bytes, and each argument as its start and length, blanks trimmed.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BracketCall {
    pub at: usize,
    pub len: usize,
    pub arguments: Vec<(usize, usize)>,
}

/// Every call in `source` written as a name and its brackets, in order.
pub fn bracket_calls(source: &str) -> Vec<BracketCall> {
    let v = views(source);
    semantics::help::bracket_calls(&v.code)
}

/// `bracket_calls`, with a string argument spanning its quotes rather than
/// trimmed away as a blank: the slots as an editor highlights them.
pub fn argument_slots(source: &str) -> Vec<BracketCall> {
    let v = views(source);
    semantics::help::bracket_calls_in(&v.code, &v.comments)
}

/// The paths of the loads in `source` - `\l path`, `system "l path"` and a
/// file symbol - as start and length, in order.
pub fn load_paths(source: &str) -> Vec<(usize, usize)> {
    let v = views(source);
    semantics::load_paths(&v.code, source)
        .into_iter()
        .map(|path| (path.start, path.len()))
        .collect()
}

/// `source` with its strings and comments blanked, byte for byte, as the
/// rules read it: an offset in one is the same offset in the other.
pub fn code_view(source: &str) -> String {
    views(source).code
}

/// Whether the name ending at byte `end` of `code` (a code view) is amended
/// through an index - `v[0]:2`, `v[i][j]+:1` - which writes it (KDB-X).
pub fn amended_at(code: &str, end: usize) -> bool {
    let after = code[end..].trim_start_matches([' ', '\t']);
    let mut rest = after;
    while rest.starts_with('[') {
        let Some(close) = matching(code, code.len() - rest.len(), b'[', b']') else {
            return false;
        };
        rest = code[close..].trim_start_matches([' ', '\t']);
    }
    rest.len() < after.len()
        && (rest.starts_with(':') || re!(r"^[-+*%&|^=<>,#~!?@$]:").is_match(rest))
}

/// What a definition that is no lambda may still be called as: the name at
/// byte `at` for `len` bytes, itself (`al:add`) or projected (`pr:add[;2;]`).
/// `given` is `None` for the name itself, and for a projection says of each
/// slot written whether it holds an argument.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Applied {
    pub at: usize,
    pub len: usize,
    pub given: Option<Vec<bool>>,
}

/// What is being typed at a cursor: the name so far starts at byte `start`,
/// inside a lambda whose parameters and locals are `locals`, under the
/// context `namespace` - `.ns` after `\d .ns`, and empty at the root.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Completing {
    pub start: usize,
    pub locals: Vec<String>,
    pub namespace: String,
}

/// The comment directly above the statement at byte `at`, without its `/`
/// markers: what a hover shows under a function's signature.
pub fn comment_above(source: &str, at: usize) -> String {
    let v = views(source);
    semantics::help::comment_above(&v.comments, source, at)
}

/// The call the cursor at byte `offset` is in, when it is in the brackets
/// of one written as a name.
pub fn call_at(source: &str, offset: usize) -> Option<Call> {
    let v = views(source);
    semantics::help::call_at(&v.code, &v.comments, source, offset)
}

/// What the assignment of the name ending at byte `end` assigns, when that
/// is another name or a projection of one and nothing more.
pub fn applied(source: &str, end: usize) -> Option<Applied> {
    let v = views(source);
    semantics::help::applied(&v.code, source, end)
}

/// The operator or iterator glyph at byte `offset`, as its start and length:
/// nothing in a string, a comment, a name, a number or a system command.
pub fn glyph_at(source: &str, offset: usize) -> Option<(usize, usize)> {
    let v = views(source);
    semantics::help::glyph_at(&v.code, source, offset)
}

/// What Expand Selection grows through from byte `offset` of `source`,
/// innermost first and each holding the last: the token, each bracket's
/// item, contents and whole, and the top-level statement (`semantics::select`).
pub fn selection_ranges(source: &str, offset: usize) -> Vec<(usize, usize)> {
    let v = views(source);
    let balanced = problems(source, &v).is_empty();
    semantics::select::ranges(&v.code, source, &v.string_starts, balanced, offset)
}

/// The name at byte `offset`, a keyword included, as its start and length.
pub fn word_at(source: &str, offset: usize) -> Option<(usize, usize)> {
    let v = views(source);
    semantics::help::word_at(&v.code, source, offset)
}

/// A local whose assignments settle its type, and that type as `type`
/// returns it: see `semantics::infer`.
pub use semantics::infer::{Typed, literal_type};
pub use semantics::version::{Target, reported_for as version_reported_for};

/// Each local of each lambda in `source` whose every assignment is a plain
/// one of a literal of the same type, in order of where it is first named.
pub fn typed_locals(source: &str) -> Vec<Typed> {
    let v = views(source);
    semantics::infer::typed_locals(&v.code, source, &v.comments)
}

/// What is being typed at byte `offset`, or `None` where no name is - in a
/// string, a comment, a symbol, a number or a system command.
pub fn completing(source: &str, offset: usize) -> Option<Completing> {
    let v = views(source);
    semantics::help::completing(&v.code, &v.comments, &v.string_starts, source, offset)
}

/// Where each context begins in `source`, the root's at 0 and then each
/// `\d`'s, and its name, in order: what `Completing::namespace` is at any
/// offset, for every offset at once.
pub fn contexts(source: &str) -> Vec<(usize, String)> {
    let v = views(source);
    semantics::contexts(&v.code, source)
}

pub mod graph;

/// The names in `source` an editor can colour by what they refer to, as byte
/// offset, byte length and kind - in order, and never inside a string or a
/// comment, since those are blank in the view this reads.
pub fn semantic_tokens(source: &str) -> Vec<(usize, usize, TokenKind)> {
    semantic_tokens_in(source, &Workspace::default(), &graph::Placement::default())
}

/// The same, with the functions other files in `ws` define coloured too,
/// for a file its loaders put where `placement` says.
pub fn semantic_tokens_in(
    source: &str,
    ws: &Workspace,
    placement: &graph::Placement,
) -> Vec<(usize, usize, TokenKind)> {
    let v = views(source);
    semantics::tokens(&v.code, source, ws, placement)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Rule {
    pub code: String,
    pub name: String,
    pub category: String,
    pub summary: String,
    pub scope: String,
}
pub static RULES: LazyLock<Vec<Rule>> =
    LazyLock::new(|| serde_json::from_str(include_str!("taxonomy.json")).unwrap());

/// Where a rule is documented: its row in `docs/rules.md`, which
/// `scripts/rules_doc.py` gives an anchor of the code in lower case - the
/// case GitHub folds an anchor's name to, so `#QE001` would name nothing.
/// `None` for a code the taxonomy does not hold, which has no row to open.
pub fn rule_url(code: &str) -> Option<String> {
    RULES.iter().any(|rule| rule.code == code).then(|| {
        format!(
            "https://github.com/kwojdalski/q-lint/blob/master/docs/rules.md#{}",
            code.to_ascii_lowercase()
        )
    })
}
pub(crate) static RESERVED: LazyLock<Vec<String>> =
    LazyLock::new(|| serde_json::from_str(include_str!("reserved.json")).unwrap());

/// Whether q reserves `word`, as `reserved.json` lists the words.
pub fn is_reserved(word: &str) -> bool {
    RESERVED.iter().any(|reserved| reserved == word)
}

/// What a name q defines is, as far as an editor shows it differently.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinKind {
    /// Called with `params`, infix or bracketed.
    Function,
    /// `if`, `do` and `while`: brackets, and no value.
    Control,
    /// A word of a qSQL template, which takes no arguments of its own.
    Query,
    Constant,
    /// A value q keeps current, as `.z.p`.
    Variable,
    /// A name q calls when the script assigns it, as `.z.pg`.
    Callback,
    /// A glyph that takes an argument on each side, as `+` and `#`.
    Operator,
    /// A glyph that derives a function from the one before it, as `/`.
    Iterator,
}

/// One name q defines: every reserved word, the names in `.z`, `.Q`, `.h`
/// and `.j` a script is most likely to meet, and the operator and iterator
/// glyphs. `syntax` is how it is written,
/// `params` what it takes - their count is its rank - `summary` one or two
/// sentences on what it gives back, and `page` where the reference
/// describes it, under <https://code.kx.com/q/ref/>.
///
/// The words are the ones `reserved.json` lists, and the ranks and the
/// qualified names the ones a running q reports and defines
/// (`tests/test_builtins_runtime.py`); the descriptions are this project's
/// own.
#[derive(Debug, Deserialize)]
pub struct Builtin {
    pub name: String,
    pub kind: BuiltinKind,
    pub syntax: String,
    pub params: Vec<String>,
    pub summary: String,
    #[serde(default)]
    pub page: Option<String>,
}
pub static BUILTINS: LazyLock<Vec<Builtin>> =
    LazyLock::new(|| serde_json::from_str(include_str!("builtins.json")).unwrap());

/// The catalogue's entry for `name`, when q defines it.
pub fn builtin(name: &str) -> Option<&'static Builtin> {
    BUILTINS.iter().find(|builtin| builtin.name == name)
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub path: String,
    pub line: usize,
    pub rule: String,
    pub detail: String,
    pub why: String,
    pub source: String,
    pub severity: String,
    pub column: Option<usize>,
    pub end_line: Option<usize>,
    pub end_column: Option<usize>,
    pub code: String,
    pub category: String,
}

/// An edit into the original UTF-8 source. `batch_safe` marks edits whose
/// replacement is sufficiently clear to apply without an editor selection.
/// The text is owned where a rule builds it from the source - `f x` becomes
/// `f[x]` with the argument spelled back out - and borrowed where a rule
/// knows it in advance.
#[derive(Debug)]
pub struct Fix {
    pub start: usize,
    pub end: usize,
    pub replacement: Cow<'static, str>,
    pub title: Cow<'static, str>,
    pub batch_safe: bool,
}

/// Where the argument of a prefix application starts.
///
/// The first thing after the name that is neither whitespace nor a comment.
/// It is found in the raw source because `code` blanks a string literal
/// whole, quotes included - `lg "text"` has nothing left of its argument
/// there. `comments` is the view that keeps a string and blanks a comment,
/// so a position non-blank there is something the program will run.
pub(crate) fn argument_start(raw: &str, comments: &str, after: usize) -> Option<usize> {
    let at = after + raw.get(after..)?.find(|c: char| !c.is_whitespace())?;
    (comments.as_bytes().get(at) != Some(&b' ')).then_some(at)
}

/// Where the argument of a prefix application ends.
///
/// q evaluates right to left, so a name applied without brackets takes
/// everything to its right as its argument: `f x+1` is `f[x+1]`, not
/// `f[x]+1`. The argument therefore runs to the end of the expression `f`
/// itself sits in - the next `;` at this bracket depth, the bracket that
/// closes around it, or the end of the statement. The scan is over the
/// masked code, where comments and string bodies are blanks, so a `;` inside
/// either cannot end anything; the trailing trim is over the raw source, so
/// a string that ends the statement is kept and a comment after it is not.
pub(crate) fn argument_end(code: &str, comments: &str, raw: &str, from: usize) -> Option<usize> {
    let bytes = code.as_bytes();
    let mut depth = 0usize;
    let mut at = from;
    while at < bytes.len() {
        match bytes[at] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            b';' if depth == 0 => break,
            // A statement continues onto the next line only where the line is
            // indented; an unindented one starts a new expression. This is
            // the rule the dictionary-literal check in `semantics` uses, and
            // the two have to agree about where an expression stops.
            b'\n' if depth == 0 && !continues_after(comments, raw, at) => break,
            _ => {}
        }
        at += 1;
    }
    let (raw, comments) = (raw.as_bytes(), comments.as_bytes());
    let mut end = at;
    while end > from && (raw[end - 1].is_ascii_whitespace() || comments[end - 1] == b' ') {
        end -= 1;
    }
    (end > from).then_some(end)
}

/// `argument_end`'s stop for every position of `code` at once, before the
/// trim: a caller asking from many positions on one long statement read it
/// to its end from each (#709). Read from the right, a position stops where
/// its byte ends the expression, or where the one after it - or after the
/// group it opens - stops. The same single depth over every bracket kind.
pub(crate) fn argument_stops(code: &str, comments: &str, raw: &str) -> Vec<usize> {
    let bytes = code.as_bytes();
    let n = bytes.len();
    let mut close = vec![usize::MAX; n];
    let mut open = vec![];
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'(' | b'[' | b'{' => open.push(i),
            b')' | b']' | b'}' => {
                if let Some(o) = open.pop() {
                    close[o] = i + 1;
                }
            }
            _ => {}
        }
    }
    // Whether each newline's statement goes on, as `continues_after` reads
    // it: the next line with code on it is indented.
    let mut continues = std::collections::HashMap::new();
    let mut next_indented = false;
    let mut end = n;
    for (at, _) in code
        .match_indices('\n')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        if !comments[at + 1..end].trim().is_empty() {
            next_indented = raw[at + 1..].starts_with([' ', '\t']);
        }
        continues.insert(at, next_indented);
        end = at + 1;
    }
    let mut stop = vec![n; n + 1];
    for i in (0..n).rev() {
        stop[i] = match bytes[i] {
            b'(' | b'[' | b'{' if close[i] == usize::MAX => n,
            b'(' | b'[' | b'{' => stop[close[i]],
            b')' | b']' | b'}' | b';' => i,
            b'\n' if !continues[&i] => i,
            _ => stop[i + 1],
        };
    }
    stop
}

/// `argument_end` from `argument_stops`.
pub(crate) fn argument_end_from(
    stops: &[usize],
    comments: &str,
    raw: &str,
    from: usize,
) -> Option<usize> {
    let (raw, comments) = (raw.as_bytes(), comments.as_bytes());
    let mut end = stops[from];
    while end > from && (raw[end - 1].is_ascii_whitespace() || comments[end - 1] == b' ') {
        end -= 1;
    }
    (end > from).then_some(end)
}

/// Whether the statement running through the newline at `at` goes on: the
/// next line with code on it is indented. Indentation is read on the raw
/// source - `code` blanks a string's opening quote, so a line that starts
/// with a string looks indented there (#399). A blank or comment-only line
/// is skipped, as q 5 skips it: `a:1+`, a column-0 comment, `  2` is 3.
fn continues_after(comments: &str, raw: &str, at: usize) -> bool {
    comments[at + 1..]
        .split_inclusive('\n')
        .zip(raw[at + 1..].split_inclusive('\n'))
        .find(|(line, _)| !line.trim().is_empty())
        .is_some_and(|(_, line)| line.starts_with([' ', '\t']))
}

/// The qSQL words, in the order a phrase writes them.
const QUERY_WORDS: [&str; 7] = ["select", "exec", "update", "delete", "by", "from", "where"];

/// The qSQL word at `at` in the masked code, if one starts there.
pub(crate) fn query_word(code: &str, at: usize) -> Option<&'static str> {
    // Part of a longer name - `.req.delete`, `clust.dbscan.update` - or a
    // symbol, `` `update ``, is not the keyword; after a drop, `1_select`,
    // it is (#340). `boundary` also refuses an offset inside a multi-byte
    // character, which the callers' byte walk reaches and `code[at..]`
    // would panic on (#352).
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'.';
    if !boundary(code, at) {
        return None;
    }
    QUERY_WORDS.into_iter().find(|w| {
        code[at..].starts_with(w) && !code.as_bytes().get(at + w.len()).is_some_and(|&b| word(b))
    })
}

/// The qSQL clause the expression at `at` is written in: the last qSQL word
/// at its own bracket depth earlier in its statement, or `None` outside a
/// query. The statement starts after the bracket that opens around `at`, a
/// `;` at its depth, or a newline the line after does not continue - the
/// same boundaries `argument_end` stops at, read backwards. A query may
/// span lines, so the line `at` is on does not settle this (#111).
pub(crate) fn query_clause(code: &str, at: usize) -> Option<&'static str> {
    let bytes = code.as_bytes();
    let mut depth = 0usize;
    let mut start = at;
    while start > 0 {
        match bytes[start - 1] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth == 0 => break,
            b'(' | b'[' | b'{' => depth -= 1,
            b';' if depth == 0 => break,
            b'\n' if depth == 0 && !code[start..].starts_with([' ', '\t']) => break,
            _ => {}
        }
        start -= 1;
    }
    let (mut depth, mut clause) = (0usize, None);
    for (i, &b) in bytes.iter().enumerate().take(at).skip(start) {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => clause = query_word(code, i).or(clause),
            _ => {}
        }
    }
    clause
}

/// Where a prefix argument inside a qSQL phrase ends: `argument_end`'s
/// answer, cut at the first comma at its depth - which separates columns,
/// or `where` constraints - or at `by` or `from`, which close the list.
/// Parse trees checked in q 5: `select s:g v,m:avg v by k from t` is
/// `select s:g[v],m:avg v by k from t`. A `where` closes nothing here: before
/// `from` it is the function, `select v:f c where e from t` is
/// `f[c where e]`, and inside the where phrase it is the function too (#771).
/// `None` where the argument holds a
/// query of its own, which this scan does not delimit.
fn query_argument_end(
    code: &str,
    comments: &str,
    raw: &str,
    from: usize,
    end: usize,
) -> Option<usize> {
    let bytes = code.as_bytes();
    let mut depth = 0usize;
    let mut at = from;
    while at < end {
        match bytes[at] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            b',' if depth == 0 => break,
            _ if depth == 0 => match query_word(code, at) {
                Some("by" | "from") => break,
                Some("where") => {}
                Some(_) => return None,
                None => {}
            },
            _ => {}
        }
        at += 1;
    }
    let (raw, comments) = (raw.as_bytes(), comments.as_bytes());
    let mut cut = at;
    while cut > from && (raw[cut - 1].is_ascii_whitespace() || comments[cut - 1] == b' ') {
        cut -= 1;
    }
    (cut > from).then_some(cut)
}

/// Where the right operand of an infix operator ends, the operand starting
/// at `from`. q evaluates right to left, so it runs to the end of the
/// expression the operator sits in, as a prefix argument does - except in a
/// qSQL template, where the phrase it is written in ends first. Parse trees
/// compared in KDB-X (#847):
///
/// - after `select`, `exec`, `update` or `delete` it ends at the phrase's own
///   comma, or at `by` or `from`; after `by`, at the comma or at `from`;
/// - after `where`, at the comma, or where the template does;
/// - after `from` it runs to `where`, or to the template's end: the table is
///   one expression, and a comma in it is a join.
///
/// A comma inside brackets of the operand's own is a join everywhere. With
/// no template open round the operand, one that opens inside it is part of
/// it - `r:a*b+exec c from t` is `a*(b+exec c from t)` - and `from`, `by` and
/// `where` are names like any other. `None` where the end cannot be told: a
/// template opening inside the operand of another's phrase, whose table then
/// takes the commas after it (`where a*b+exec c from u, d` is one
/// constraint), or a qSQL word where no phrase expects one.
fn operand_end(v: &Views, source: &str, from: usize) -> Option<usize> {
    let end = argument_end(&v.code, &v.comments, source, from)?;
    let bytes = v.code.as_bytes();
    // Where the expression starts: after the bracket that opens round the
    // operand, a `;` at its depth, or a newline its statement does not
    // continue past. Indentation is read on the source, as `argument_end`
    // reads it: a line that starts with a string looks indented in `code`.
    let (mut depth, mut unit) = (0usize, from);
    while unit > 0 {
        match bytes[unit - 1] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth == 0 => break,
            b'(' | b'[' | b'{' => depth -= 1,
            b';' if depth == 0 => break,
            b'\n' if depth == 0 && !continues_after(&v.comments, source, unit - 1) => break,
            _ => {}
        }
        unit -= 1;
    }
    // A symbol may spell a qSQL word and is none: `` `:db/select ``.
    let words = unsymbolled(&v.code[unit..end]);
    let word = |at: usize| query_word(&words, at - unit);
    // The phrase the operand is written in: the last qSQL word before it at
    // its depth that the phrase before could be followed by. `where` is the
    // function anywhere but after `from`: `select v:f c where e from t`.
    let (mut depth, mut phrase) = (0usize, None);
    for (at, byte) in bytes.iter().enumerate().take(from).skip(unit) {
        match byte {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => {
                phrase = match (phrase, word(at)) {
                    (_, Some(head @ ("select" | "exec" | "update" | "delete"))) => Some(head),
                    (None, _) | (_, None) => phrase,
                    (Some("from"), Some("where")) => Some("where"),
                    (_, Some("where")) => phrase,
                    (Some("from" | "where"), _) | (Some("by"), Some("by")) => return None,
                    (_, next) => next,
                }
            }
            _ => {}
        }
    }
    let Some(phrase) = phrase else {
        return Some(end);
    };
    let (mut depth, mut at) = (0usize, from);
    while at < end {
        match bytes[at] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            b',' if depth == 0 && phrase != "from" => break,
            _ if depth == 0 => match (phrase, word(at)) {
                (_, None) => {}
                ("from", Some("where")) => break,
                (_, Some("where")) => {}
                ("from" | "where", _) => return None,
                ("by", Some("from")) => break,
                ("by", _) => return None,
                (_, Some("by" | "from")) => break,
                _ => return None,
            },
            _ => {}
        }
        at += 1;
    }
    // A column or grouping phrase is closed by `from`; one that is not has
    // been misread.
    if at == end && !matches!(phrase, "from" | "where") {
        return None;
    }
    let (raw, comments) = (source.as_bytes(), v.comments.as_bytes());
    while at > from && (raw[at - 1].is_ascii_whitespace() || comments[at - 1] == b' ') {
        at -= 1;
    }
    (at > from).then_some(at)
}

/// The right operand of the infix operator at `op`, as the range a pair of
/// parentheses goes round without changing the program. `None` where there
/// is no such range: the operand's end cannot be told (`operand_end`), the
/// operator is applied in brackets, or its right side is a composition.
fn right_operand(v: &Views, source: &str, op: usize) -> Option<(usize, usize)> {
    // An adverb is part of the operator: `a*/:b+c` is `a*/:(b+c)`.
    let mut after = op + 1;
    while v.code[after..].starts_with([':', '/', '\\', '\'']) {
        after += 1;
    }
    let from = argument_start(source, &v.comments, after)?;
    // `a*[b;c]+d` applies `*` in brackets: what follows is its argument
    // list, and in parentheses it would be a table header.
    if source[from..].starts_with('[') {
        return None;
    }
    let end = operand_end(v, source, from)?;
    // A right side ending in an operator or `::` is a composition, not an
    // operand - `1f%1f+exp neg::` - so parentheses would change it.
    if v.comments[from..end].ends_with(|c: char| "+-*%&|^=<>~,#_!?@.$:'/\\".contains(c)) {
        return None;
    }
    Some((from, end))
}

/// Where QP005 (`trap`) or QP007 puts its parentheses in the statement group
/// `group`: round the right operand of the operator just before a change of
/// family - the first that has such an operand - in the last run of the
/// rule's kind that has one. This is the one place that says where the
/// forward fix puts a pair, so a pair is one the fix would write exactly
/// when it is the `right_operand` of a `+`, `-`, `*` or `%` and what it holds
/// opens a run of the other family.
fn precedence_pair(
    v: &Views,
    source: &str,
    group: (usize, usize),
    trap: bool,
) -> Option<(usize, usize)> {
    let (start, end) = group;
    infix_runs(&v.code[start..end])
        .iter()
        .rev()
        .filter(|run| mixes(run) && traps(run) == trap)
        .find_map(|run| {
            // A run is read off the line, not off the expression: on a later
            // line of a template its `from` is a name to `infix_runs`, and
            // `e*f from t where g+h` is one run of two phrases. The operand
            // of the `*` ends before the `+`; a pair there would group
            // nothing, and the fix would never be done. So the pair has to
            // hold the operator that changes family, and where the first
            // change has no such operand the next one is tried.
            (1..run.len())
                .filter(|&k| run[k].1 != run[k - 1].1)
                .find_map(|k| {
                    right_operand(v, source, start + run[k - 1].0)
                        .filter(|&(_, close)| close > start + run[k].0)
                })
        })
}

/// A file's text with one pair of parentheses blanked, for QP008 to ask
/// `right_operand` what the line would be without them. Made once per file
/// and restored after each pair: a copy per pair grew with pairs times file
/// size, on a tree that parenthesises every mix.
struct Unparenthesised {
    v: Views,
    source: String,
}
impl Unparenthesised {
    fn new(v: &Views, source: &str) -> Self {
        Unparenthesised {
            v: Views {
                comments: v.comments.clone(),
                code: v.code.clone(),
                unterminated: None,
                foreign_offsets: vec![],
                open_block: None,
                blocks: vec![],
                string_starts: vec![],
                script_end: None,
            },
            source: source.to_string(),
        }
    }
    /// Writes `byte` at `at` in every text. One byte for one byte, so no
    /// offset moves.
    fn set(&mut self, at: usize, byte: &str) {
        self.v.code.replace_range(at..at + 1, byte);
        self.v.comments.replace_range(at..at + 1, byte);
        self.source.replace_range(at..at + 1, byte);
    }
}

/// QP008's reading of the pair whose `(` is at `open` in the statement
/// group `group`: the operator it is the right operand of, when the pair is
/// one QP005's and QP007's fix would write. The two are opposite
/// conventions, and this is the forward fix read backwards, so removing the
/// pair and fixing forward writes it back byte for byte (#848). A pair is
/// one the fix writes exactly when
///
/// - it follows a `+`, `-`, `*` or `%`, past any adverb and blanks;
/// - without it, `right_operand` of that operator is what it held - so it
///   closes where the operand ends anyway;
/// - without it, the next operator of the operator's run is inside it and of
///   the other family: what it holds opens a run of its own at top level.
///
/// The fix's parse tree is the same before and after - `2*3+4` and `2*(3+4)`
/// are one program - so removing the pair keeps it too, wherever the text
/// left reads as the text was. Not where a token would fuse: `a -(1+b)`
/// would become `a -1+b`, whose `-1` is a literal, and `(b+c)from` the name
/// `cfrom`; nor where what it holds starts with an operator not applied in
/// brackets.
fn restated_pair(
    v: &Views,
    source: &str,
    group: (usize, usize),
    open: usize,
    scratch: &mut Option<Unparenthesised>,
) -> Option<usize> {
    let (start, end) = group;
    let bytes = source.as_bytes();
    let mut op = source[..open].trim_end().len();
    while op > start && v.code[..op].ends_with([':', '/', '\\', '\'']) {
        op -= 1;
    }
    let op = op.checked_sub(1).filter(|&op| op >= start)?;
    if !matches!(v.code.as_bytes()[op], b'+' | b'-' | b'*' | b'%') {
        return None;
    }
    let close = matching(&v.code, open, b'(', b')')? - 1;
    let inner = &source[open + 1..close];
    let numeric = |t: &str| {
        t.starts_with(|c: char| c.is_ascii_digit())
            || t.strip_prefix('.')
                .is_some_and(|t| t.starts_with(|c: char| c.is_ascii_digit()))
    };
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'.';
    // An operator applied in brackets is an operand, `$[c;a;b]` and
    // `@[f;x]` among them: q 5 parses `a+@[f;x]*2` as it does with the pair.
    // Not an adverb or `:`, which would join the operator before.
    let operator = inner.starts_with(|c: char| "+-*%&|^=<>~,#_!?@$:'/\\".contains(c))
        && !inner.strip_prefix('-').is_some_and(numeric)
        && !(inner.as_bytes().get(1) == Some(&b'[') && !inner.starts_with([':', '\'', '/', '\\']));
    let literal = bytes[op] == b'-'
        && open == op + 1
        && op > 0
        && bytes[op - 1].is_ascii_whitespace()
        && numeric(inner);
    let fused =
        inner.bytes().last().is_some_and(word) && bytes.get(close + 1).is_some_and(|&b| word(b));
    if operator || literal || fused {
        return None;
    }
    // The run, read off the group with the pair gone. The `)` may close on a
    // later line, past the group.
    let mut line = v.code[start..end].to_string();
    for at in [open, close].into_iter().filter(|&at| at < end) {
        line.replace_range(at - start..at - start + 1, " ");
    }
    let runs = infix_runs(&line);
    let (run, k) = runs.iter().find_map(|run| {
        let k = run.iter().position(|o| o.0 == op - start)?;
        Some((run, k))
    })?;
    let next = run.get(k + 1)?;
    if next.1 == run[k].1 || start + next.0 > close {
        return None;
    }
    let blanked = scratch.get_or_insert_with(|| Unparenthesised::new(v, source));
    blanked.set(open, " ");
    blanked.set(close, " ");
    let operand = right_operand(&blanked.v, &blanked.source, op);
    blanked.set(open, "(");
    blanked.set(close, ")");
    (operand == Some((open + 1, close))).then_some(op)
}

/// The single source of replacements for the CLI and LSP. Findings have UTF-16
/// positions for editors, while edits use byte offsets to change Rust strings.
pub fn fix_for(finding: &Finding, source: &str) -> Option<Fix> {
    fix_with(finding, source, &views(source))
}

/// The fixes for many findings in one source, masking it once. `fix_for` per
/// finding re-masks the whole file each time, which grows with findings times
/// file size - 1.7 s for 3000 findings in 6000 lines, against 0.13 s to lint.
pub fn fixes_for<'a>(findings: impl IntoIterator<Item = &'a Finding>, source: &str) -> Vec<Fix> {
    let v = views(source);
    findings
        .into_iter()
        .filter_map(|finding| fix_with(finding, source, &v))
        .collect()
}

/// What `fix_all` leaves: the fixed text, how many fixes made it and over
/// how many passes, and the first pass's edits into the original source.
pub struct Fixed {
    pub text: String,
    pub count: usize,
    pub passes: usize,
    pub first: Vec<Fix>,
}

/// Apply fixes to `source` until none applies: what `--fix` writes, `--diff`
/// shows and the language server's formatting returns, from one loop so the
/// three cannot disagree. Only the batch-safe fixes, unless `unsafe_fixes`.
/// `lint` is the caller's policy - its profile, selection and ignores.
///
/// Repeat until nothing applies, as Ruff does: one fix can leave another to
/// make - QF005's fix passes one local in, and the next pass finds the
/// second. Overlapping fixes wait a pass. Capped, so a pair of fixes that
/// undo each other cannot spin.
pub fn fix_all<E>(
    source: &str,
    unsafe_fixes: bool,
    lint: impl FnMut(&str) -> Result<Vec<Finding>, E>,
) -> Result<Fixed, E> {
    fix_loop(source, unsafe_fixes, None, lint)
}

/// `fix_all`, for only the findings reported on `lines` - 1-based and
/// inclusive, in `source` - as an editor asks to format the lines a change
/// touched and leave the rest alone. The lines move with the edits: one a
/// fix inserts or removes shifts those below it, and a fix on one of them
/// keeps the lines it rewrote. A finding whose fix reaches outside its
/// line is still fixed, since the finding is on a line that was asked for.
pub fn fix_lines<E>(
    source: &str,
    lines: &[(usize, usize)],
    lint: impl FnMut(&str) -> Result<Vec<Finding>, E>,
) -> Result<Fixed, E> {
    let mut lines = lines.to_vec();
    fix_loop(source, false, Some(&mut lines), lint)
}

fn fix_loop<E>(
    source: &str,
    unsafe_fixes: bool,
    mut within: Option<&mut Vec<(usize, usize)>>,
    mut lint: impl FnMut(&str) -> Result<Vec<Finding>, E>,
) -> Result<Fixed, E> {
    let mut updated = source.to_string();
    let mut count = 0;
    let (mut passes, mut first) = (0, vec![]);
    for _ in 0..100 {
        let mut found = lint(&updated)?;
        if let Some(lines) = within.as_deref() {
            found.retain(|f| lines.iter().any(|&(a, b)| (a..=b).contains(&f.line)));
        }
        let mut edits: Vec<_> = fixes_for(&found, &updated)
            .into_iter()
            .filter(|fix| fix.batch_safe || unsafe_fixes)
            .collect();
        edits.sort_by_key(|fix| (fix.start, fix.end));
        let mut selected = vec![];
        let mut end = 0;
        for edit in edits {
            if edit.start < end || edit.end > updated.len() {
                continue;
            }
            end = edit.end;
            selected.push(edit);
        }
        if selected.is_empty() {
            break;
        }
        let before = updated.clone();
        for edit in selected.iter().rev() {
            if let Some(lines) = within.as_deref_mut() {
                // From the last edit back, so each one's lines are still
                // those of `before`.
                let line = |at: usize| 1 + before[..at].matches('\n').count();
                let (first, last) = (line(edit.start), line(edit.end));
                let delta = edit.replacement.matches('\n').count() as isize
                    - before[edit.start..edit.end].matches('\n').count() as isize;
                for (a, b) in lines.iter_mut() {
                    let shift = |n: usize| (n as isize + delta).max(1) as usize;
                    if *a > last {
                        (*a, *b) = (shift(*a), shift(*b));
                    } else if *b >= first {
                        *b = shift((*b).max(last)).max(*a);
                    }
                }
            }
            updated.replace_range(edit.start..edit.end, &edit.replacement);
        }
        if updated == before {
            break;
        }
        count += selected.len();
        passes += 1;
        if passes == 1 {
            first = selected;
        }
    }
    Ok(Fixed {
        text: updated,
        count,
        passes,
        first,
    })
}

/// `before` turned into `after` as one edit: the span between what the two
/// texts share at either end, widened to character boundaries. `None` when
/// they are the same text.
pub fn whole_edit(before: &str, after: &str) -> Option<Fix> {
    if before == after {
        return None;
    }
    let prefix = before
        .bytes()
        .zip(after.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = before.as_bytes()[prefix..]
        .iter()
        .rev()
        .zip(after.as_bytes()[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let (mut start, mut old_end, mut new_end) =
        (prefix, before.len() - suffix, after.len() - suffix);
    while !before.is_char_boundary(start) || !after.is_char_boundary(start) {
        start -= 1;
    }
    while !before.is_char_boundary(old_end) || !after.is_char_boundary(new_end) {
        old_end += 1;
        new_end += 1;
    }
    Some(Fix {
        start,
        end: old_end,
        replacement: after[start..new_end].to_string().into(),
        title: "".into(),
        batch_safe: true,
    })
}

fn fix_with(finding: &Finding, source: &str, v: &Views) -> Option<Fix> {
    // A comment is what QL003 edits, so it passes the check below.
    if finding.code == "QL003" {
        return unused_noqa_fix(finding, source, v);
    }
    let line = finding.line.checked_sub(1)?;
    let column = finding.column?.checked_sub(1)?;
    let line_start = if line == 0 {
        0
    } else {
        source.match_indices('\n').nth(line - 1)?.0 + 1
    };
    let text = source.get(line_start..)?.split('\n').next()?;
    let mut units = 0;
    let mut byte = None;
    for (at, ch) in text.char_indices() {
        if units == column {
            byte = Some(at);
            break;
        }
        units += ch.len_utf16();
        if units > column {
            return None;
        }
    }
    let byte = byte.or_else(|| (units == column).then_some(text.len()))?;
    let start = line_start + byte;
    // A fix edits code. A finding that points into a string or a comment is a
    // rule that matched text it should not have, and editing there would make
    // one wrong finding corrupt the file too: QB015 once read the `=` of the
    // string `"="` as an operator, and its fix rewrote the string as
    // `" like "`. Only three rules are about those bytes - an escape inside a
    // string, a definition kept in a comment, and the byte-order mark - and
    // QP005 and QP007 are reported at their line's first character, a string
    // or not, and edit at an operator the masked code holds.
    if !matches!(
        finding.code.as_str(),
        "QE002" | "QL002" | "QE005" | "QP005" | "QP007"
    ) && v.code.as_bytes().get(start) != source.as_bytes().get(start)
        // QT004 by a type char is reported at its quote, and only where
        // the `$` after it is code; its arm reads the rest.
        && !(finding.code == "QT004" && source[start..].starts_with('"'))
    {
        return None;
    }
    // Where the edit begins: the finding's own position, unless an arm says
    // otherwise - removing dead code takes the `;` before it too.
    let mut begin = start;
    let (old, replacement, title, batch_safe): (&str, Cow<str>, Cow<str>, bool) = match finding
        .code
        .as_str()
    {
        "QE004" => match source.get(start..start + 2)? {
            "==" => ("==", "=".into(), "Replace `==` with `=`".into(), true),
            "!=" => ("!=", "<>".into(), "Replace `!=` with `<>`".into(), true),
            "+=" => ("+=", "+:".into(), "Replace `+=` with `+:`".into(), true),
            "-=" => ("-=", "-:".into(), "Replace `-=` with `-:`".into(), true),
            "*=" => ("*=", "*:".into(), "Replace `*=` with `*:`".into(), true),
            "&&" => ("&&", "&".into(), "Replace `&&` with `&`".into(), false),
            "||" => ("||", "|".into(), "Replace `||` with `|`".into(), false),
            _ => return None,
        },
        // like's pattern is a string: `` `a* `` becomes `"a*"`. The old
        // spelling is 'type or a projection, never a boolean, so no
        // working program changes.
        "QB007" => {
            let lead = re!(concat!(r"^like", blank!(), "*`")).find(source.get(start..)?)?;
            let pattern = start + lead.end();
            let mut depth = 0;
            // After a `:` the symbol is a path and takes a `/` too: q 5 parses
            // `` `:b/c `` as one symbol, and cutting it there leaves `/c`, which
            // q refuses to load (#768).
            let mut path = false;
            let len = source[pattern..]
                .char_indices()
                .find(|&(_, c)| match c {
                    '[' => {
                        depth += 1;
                        false
                    }
                    ']' if depth > 0 => {
                        depth -= 1;
                        false
                    }
                    '/' => !path,
                    c => {
                        path |= c == ':';
                        !(c.is_ascii_alphanumeric() || "_.:*?^-".contains(c))
                    }
                })
                .map_or(source.len() - pattern, |(at, _)| at);
            let text = &source[pattern..pattern + len];
            if text.is_empty() || depth != 0 || source[pattern + len..].starts_with('`') {
                return None;
            }
            // One character in quotes is a char atom, which `like` refuses
            // with 'type as it does the symbol (q 5, #564).
            let string = if text.len() == 1 {
                format!("enlist\"{text}\"")
            } else {
                format!("\"{text}\"")
            };
            (
                &source[start..pattern + len],
                format!("{}{string}", &lead.as_str()[..lead.len() - 1]).into(),
                format!("Write the pattern as the string \"{text}\"").into(),
                true,
            )
        }
        // `ss`/`ssr` given one symbol atom: spell it as the string. Only
        // in the editor - the call now returns a string, and whether the
        // caller wanted `` `$ `` back on the result is theirs to say.
        "QT007" => {
            let call = re!(
                    r"^(?:ssr?\s*\[\s*(?:`[A-Za-z0-9_.]*)+\s*[;\]]|ssr?\s*\[[^;\]]*;\s*(?:`[A-Za-z0-9_.]*)+\s*[;\]]|(?:`[A-Za-z0-9_.]*)+\s+ssr?\b)"
                )
                .find(v.code.get(start..)?)?;
            let old = source.get(start..start + call.end())?;
            let symbols: Vec<_> = re!(r"(?:`[A-Za-z0-9_.]*)+").find_iter(old).collect();
            let [symbol] = symbols[..] else {
                return None;
            };
            let name = &symbol.as_str()[1..];
            if name.contains('`') {
                return None;
            }
            (
                old,
                format!(
                    "{}\"{name}\"{}",
                    &old[..symbol.start()],
                    &old[symbol.end()..]
                )
                .into(),
                format!("Pass the string \"{name}\"").into(),
                false,
            )
        }
        // Dropping the `;` returns the value instead of null - a change in
        // behaviour, so only on request.
        "QB012" if source.get(start..)?.starts_with(';') => {
            (";", "".into(), "Return the last expression".into(), false)
        }
        // `a -1` read as subtraction. Which was meant is a guess, so only
        // in the editor.
        "QB010" => {
            let m = re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*[ \t]+-").find(source.get(start..)?)?;
            let name = m.as_str()[..m.len() - 1].trim_end();
            (
                m.as_str(),
                format!("{name} - ").into(),
                format!("Subtract: `{name} - ...`").into(),
                false,
            )
        }
        // `reverse asc x` is `desc x` for a list or table, but not for a
        // dictionary with tied values - q 5 orders the tied keys
        // differently - so only in the editor.
        "QR001" => {
            let m = re!(concat!(r"^reverse", blank!(), r"+(asc|desc)\b"))
                .captures(source.get(start..)?)?;
            let other = if &m[1] == "asc" { "desc" } else { "asc" };
            (
                m.get(0)?.as_str(),
                other.into(),
                format!("Replace `reverse {}` with `{other}`", &m[1]).into(),
                false,
            )
        }
        // `{x} each y` is `y` on a non-empty list, string, dictionary or
        // table, but not always: q 5 gives a general empty list for an
        // empty typed list or table (`type {x} each 0#0` is 0h), and drops
        // `s#`, `g#` and `u#` - so, like QR004, only in the editor (#401).
        // Only where it has an argument - `g:{x} each` is a function, which
        // dropping the words would end.
        "QR002" => {
            let m = re!(r"^\{\s*x\s*\}[ \t]*(?:each\b|')[ \t]*").find(source.get(start..)?)?;
            let before = v.code[..start].trim_end();
            let heads = before.is_empty()
                || before.ends_with(|c: char| ":;([{,+-*%&|<>=~!^#$?@".contains(c));
            let rest = v.code[start + m.end()..].trim_start_matches([' ', '\t']);
            // `count {x} each b` is `count[{x} each b]`, but `count {x}' b`
            // makes `{x}'` infix with `count` on its left - parse trees
            // from q 5 - so only `each` may follow a value.
            if !(heads || m.as_str().contains("each"))
                || rest.is_empty()
                || rest.starts_with([';', ')', ']', '}', '[', '\n', '\r', '\'', '/', '\\'])
            {
                return None;
            }
            // `a{x} each b` is `a b`, not `ab`.
            let gap = if ends_in_token(&source[..start]) {
                " "
            } else {
                ""
            };
            (
                &source[start..start + m.end()],
                gap.into(),
                "Remove the identity `{x} each`".into(),
                false,
            )
        }
        // `abs each x` is `abs x` on every value but the empty list, where
        // `each` gives `()` and the builtin a typed empty list - so only in
        // the editor.
        "QV002" => {
            let m = re!(concat!(
                r"^(?:abs|neg|sqrt|exp|log|floor|ceiling|not|null|signum|reciprocal)",
                r"(?:([ \t]+each\b)|'\[)"
            ))
            .captures(source.get(start..)?)?;
            let whole = m.get(0)?.as_str();
            let name = whole.trim_end_matches('[').trim_end_matches('\'');
            let name = name.split([' ', '\t']).next()?;
            // `abs'[x]` keeps its bracket: `abs[x]`.
            let old = if m.get(1).is_some() {
                whole
            } else {
                &whole[..whole.len() - 1]
            };
            (
                old,
                name.to_string().into(),
                format!("Remove `each`: `{name}` is atomic").into(),
                false,
            )
        }
        // `r:r,x` is `r,:x`, the same value, appended in place. Only in the
        // editor: it is the loop's to decide, and a name another reference
        // shares is copied either way.
        "QV003" => {
            let m =
                re!(r"^(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]*:[ \t]*(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]*,")
                    .captures(source.get(start..)?)?;
            if m[1] != m[2] {
                return None;
            }
            (
                m.get(0)?.as_str(),
                format!("{},:", &m[1]).into(),
                format!("Append in place with `{},:`", &m[1]).into(),
                false,
            )
        }
        // Sorting adds no duplicates, and q 5 agrees on the value and, for
        // a list, the sorted attribute. Not unattended: for a table it does
        // not - `attr distinct asc distinct t` is `` ` `` on KDB-X and
        // `attr asc distinct t` is `` `s `` (#1201) - and x may be one.
        "QR003" => {
            let m = re!(concat!(
                r"^distinct",
                blank!(),
                "+asc",
                blank!(),
                r"+distinct\b"
            ))
            .find(source.get(start..)?)?;
            (
                m.as_str(),
                "asc distinct".into(),
                "Replace with `asc distinct`".into(),
                false,
            )
        }
        // `(a)` becomes `a`, where nothing around it reads differently
        // once the parentheses are gone: `2 (3)` would become the vector
        // `2 3`, `f -(1)` the application `f -1`, and `(2)3` the number 23.
        "QS004" => {
            let m = re!(r"^\(\s*(\.?[A-Za-z][A-Za-z0-9_.]*|-?\d[A-Za-z0-9.]*)\s*\)")
                .captures(source.get(start..)?)?;
            let (whole, token) = (m.get(0)?, &m[1]);
            let numeric = token.starts_with(|c: char| c == '-' || c.is_ascii_digit());
            let before = &source[..start];
            let prev = before.trim_end().chars().next_back();
            // Past a line break too, where an indented line goes on: `(2)`
            // over `  -1` is `(2) -1`, and `2` there would be `2 -1` (#773).
            let next = refusals::continued(&source[start + whole.end()..]);
            let adjacent = source[start + whole.end()..].chars().next();
            if before.ends_with('-')
                || (token.starts_with('-') && !prev.is_none_or(|c| "([{;:".contains(c)))
                || (numeric
                    && (prev.is_some_and(|c| c.is_ascii_digit())
                        || next.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '.')))
                || next.starts_with(':')
            {
                return None;
            }
            let space = adjacent.is_some_and(|c| c.is_ascii_alphanumeric() || "._`\"".contains(c));
            // Likewise before: `(x)(y)` loses both pairs in one pass, and
            // `x` then `y` would be the name `xy`.
            let lead = if ends_in_token(before) { " " } else { "" };
            (
                whole.as_str(),
                format!("{lead}{token}{}", if space { " " } else { "" }).into(),
                format!("Remove the parentheses around `{token}`").into(),
                true,
            )
        }
        // An escape q does not define is refused outright, so doubling the
        // backslash - the text the author typed - changes no working
        // program: `"C:\data"` becomes `"C:\\data"`.
        "QE002" if source.get(start..)?.starts_with('\\') => {
            ("\\", "\\\\".into(), "Escape the backslash".into(), true)
        }
        // Keywords from other languages that have one q spelling. Each
        // throws as an undefined global, so no working program changes.
        "QF015" => {
            let rest = source.get(start..)?;
            let word = re!(r"^[A-Za-z]+").find(rest)?.as_str();
            let (old, new): (&str, &str) = match word {
                "true" => ("true", "1b"),
                "false" => ("false", "0b"),
                "None" => ("None", "(::)"),
                // `return x` is `:x`, where `return` opens the statement.
                "return" => {
                    let before = v.code[..start].trim_end();
                    let opens = before.is_empty()
                        || before.ends_with([';', '[', '{'])
                        || before
                            .strip_suffix(']')
                            .and_then(|b| b.rfind('[').map(|at| &b[..at]))
                            .is_some_and(|b| b.trim_end().ends_with('{'));
                    let m = re!(r"^return[ \t]*").find(rest)?;
                    let next = rest[m.end()..].chars().next();
                    // Nothing after it but a comment is nothing after it:
                    // `:/ c` would be over, which q 5 refuses to load (#404).
                    // Nor an argument in brackets or an iterator: `:[x]` and
                    // `:'[x]` apply `:`, and return its projection (#770).
                    if !opens || next.is_none_or(|c| ";}]\r\n/['".contains(c)) {
                        return None;
                    }
                    (m.as_str(), ":")
                }
                _ => return None,
            };
            (
                old,
                new.into(),
                format!("Replace `{word}` with `{new}`").into(),
                true,
            )
        }
        // A table of scalars is 'rank; enlisting each makes the one row.
        "QT005" => {
            if !v.code.get(start..)?.starts_with("([]") {
                return None;
            }
            let close = matching(&v.code, start, b'(', b')')?;
            let inner = start + 3..close - 1;
            let mut out = String::from("([]");
            let mut at = inner.start;
            for column in slots(&v.code[inner.clone()]) {
                let from = column.as_ptr() as usize - v.code.as_ptr() as usize;
                let colon = re!(r"^\s*[A-Za-z][A-Za-z0-9_]*\s*:").find(column)?;
                out.push_str(&source[at..from + colon.end()]);
                out.push_str("enlist ");
                let value = &source[from + colon.end()..from + column.len()];
                out.push_str(value.trim_start());
                at = from + column.len();
            }
            out.push_str(&source[at..close]);
            (
                &source[start..close],
                out.into(),
                "Enlist each column, for a one-row table".into(),
                true,
            )
        }
        // `col="ab"` is 'length or 'type on all but a char column of as many
        // rows as the string has chars; `like` is the
        // comparison that works on a symbol column. A pattern character
        // in the string would change what it matches, so not then. Only in
        // the editor: on a char column as long as the string, `=` is valid
        // q and compares char by char.
        "QB015" => {
            let m = re!(r#"^=\s*("[^"\\*?\[\]^]*")"#).captures(source.get(start..)?)?;
            let pad = if source[..start].ends_with([' ', '\t']) {
                ""
            } else {
                " "
            };
            (
                m.get(0)?.as_str(),
                format!("{pad}like {}", &m[1]).into(),
                format!("Compare with `like {}`", &m[1]).into(),
                false,
            )
        }
        // Parentheses where q already groups: around the right operand of
        // the operator just before the first change of family. The parse
        // tree is the same - `2*3+4` and `2*(3+4)` are one program. The
        // finding is on its line's first character; the edit is wherever
        // on that line the run is.
        "QP005" | "QP007" => {
            let group = statement_groups(&v.code, source)
                .into_iter()
                .find(|&(a, b)| a <= start && start < b)?;
            let (from, end) = precedence_pair(v, source, group, finding.code == "QP005")?;
            begin = from;
            (
                &source[from..end],
                format!("({})", &source[from..end]).into(),
                "Parenthesise to show the order q evaluates in".into(),
                true,
            )
        }
        // The pair QP005's fix would write, removed: the inverse edit, and
        // the same parse tree.
        "QP008" => {
            let group = statement_groups(&v.code, source)
                .into_iter()
                .find(|&(a, b)| a <= start && start < b)?;
            restated_pair(v, source, group, start, &mut None)?;
            let close = matching(&v.code, start, b'(', b')')?;
            (
                &source[start..close],
                source[start + 1..close - 1].to_string().into(),
                "Remove the parentheses q's order already implies".into(),
                true,
            )
        }
        // `s=`a`b` compares item by item; membership is `in`. When the
        // lengths happen to match `=` runs, so only on request.
        "QB008" => {
            let m = re!(r"^(?:where\s+)?[A-Za-z][A-Za-z0-9_.]*\s*(=)")
                .captures(source.get(start..)?)?;
            let eq = m.get(1)?;
            (
                &source[start..start + eq.end()],
                format!("{} in ", source[start..start + eq.start()].trim_end()).into(),
                "Test membership with `in`".into(),
                false,
            )
        }
        // `f(a;b)` passes one list; brackets pass two arguments. The old
        // form returns a projection rather than failing, so on request.
        "QA008" => {
            let name = re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*").find(v.code.get(start..)?)?;
            let open = start + name.end();
            if !v.code[open..].starts_with('(') {
                return None;
            }
            let close = matching(&v.code, open, b'(', b')')?;
            (
                &source[start..close],
                format!("{}[{}]", name.as_str(), &source[open + 1..close - 1]).into(),
                format!("Call `{}` with brackets", name.as_str()).into(),
                false,
            )
        }
        // `` `int$"12" `` casts character codes; `"I"$` parses the text.
        // Both run, so which was meant is the author's to confirm.
        // `` `symbol$"ab" `` and `` `guid$".." `` are 'type; what was meant is
        // `` `$ `` and `"G"$`.
        // `"j"$"12"` is the same cast by type char, and `"J"$` parses.
        "QT004" if source[start..].starts_with('"') => {
            let m = re!(r#"^"([bhijefpmdznuvt])"[ \t]*\$"#).captures(source.get(start..)?)?;
            let letter = m[1].to_ascii_uppercase();
            (
                m.get(0)?.as_str(),
                format!("\"{letter}\"$").into(),
                format!("Parse the text with `\"{letter}\"$`").into(),
                false,
            )
        }
        "QT004" | "QT032" => {
            let m = re!(r"^`([a-z]+)\s*\$").captures(source.get(start..)?)?;
            let letter = match &m[1] {
                "symbol" => "",
                "boolean" => "B",
                "guid" => "G",
                "byte" => "X",
                "short" => "H",
                "int" => "I",
                "long" => "J",
                "real" => "E",
                "float" => "F",
                "timestamp" => "P",
                "month" => "M",
                "date" => "D",
                "datetime" => "Z",
                "timespan" => "N",
                "minute" => "U",
                "second" => "V",
                "time" => "T",
                _ => return None,
            };
            if letter.is_empty() {
                (
                    m.get(0)?.as_str(),
                    "`$".into(),
                    "Make a symbol with `` `$ ``".into(),
                    false,
                )
            } else {
                (
                    m.get(0)?.as_str(),
                    format!("\"{letter}\"$").into(),
                    format!("Parse the text with `\"{letter}\"$`").into(),
                    false,
                )
            }
        }
        // A statement after a top-level return never runs: remove it and
        // what follows it up to the closing brace, on one line.
        "QB020" => {
            let semi = v.code[..start].trim_end();
            if !semi.ends_with(';') {
                return None;
            }
            let semi = semi.len() - 1;
            begin = semi;
            let (mut depth, mut at) = (0i32, start);
            let bytes = v.code.as_bytes();
            while at < bytes.len() {
                match bytes[at] {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' => depth -= 1,
                    b'}' if depth == 0 => break,
                    b'}' => depth -= 1,
                    _ => {}
                }
                at += 1;
            }
            if at == bytes.len() {
                return None;
            }
            let mut end = at;
            while end > start && source.as_bytes()[end - 1].is_ascii_whitespace() {
                end -= 1;
            }
            // Across lines the edit would take layout and comments with it;
            // the single-line case is the one with one right edit. Measured
            // to the brace in code, not the trimmed end: a `}` inside a
            // trailing comment stops the trim on the first line (#410).
            if end <= start || source[semi..at].contains('\n') {
                return None;
            }
            (
                &source[semi..end],
                "".into(),
                "Remove the code that never runs".into(),
                false,
            )
        }
        // A local nobody reads: keep the expression, drop the name.
        "QF017" => {
            let m = re!(r"^[A-Za-z][A-Za-z0-9_]*[ \t]*:").find(source.get(start..)?)?;
            if source[start + m.end()..].starts_with(':') {
                return None;
            }
            (
                m.as_str(),
                "".into(),
                "Remove the unused assignment, keep the expression".into(),
                false,
            )
        }
        // The UTC clock the convention asks for. A different value, so
        // only on request.
        // The finding sits on the clock it names.
        "QP003" => {
            let m = re!(r"^\.z\.[PTNZD]\b").find(v.code.get(start..)?)?;
            let clock = utc_clock(m.as_str());
            (
                &source[start..start + m.end()],
                clock.clone().into(),
                format!("Use the UTC `{clock}`").into(),
                false,
            )
        }
        // `a=1 and b=0` grouped the way it was meant: `(a=1) and b=0`. The
        // rows returned change, so only on request.
        "QB006" => {
            let m = re!(r"^where\b").find(v.code.get(start..)?)?;
            let phrase = start + m.end();
            // The phrase ends where its statement does: a `;` or a bracket
            // closing round it, at its own depth.
            let (_, group_end) = statement_groups(&v.code, source)
                .into_iter()
                .find(|&(a, b)| a <= start && start < b)?;
            let (mut depth, mut end) = (0i32, phrase);
            for &b in &v.code.as_bytes()[phrase..group_end] {
                match b {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' if depth == 0 => break,
                    b')' | b']' | b'}' => depth -= 1,
                    b';' if depth == 0 => break,
                    _ => {}
                }
                end += 1;
            }
            // A string is blank in the code view, and a blank reads as the
            // space between operands: `a=f "x" and b=0` would group as
            // `(a=f) "x"`. Fill it, so the string stays part of its operand.
            let filled: String = v.code[phrase..end]
                .bytes()
                .zip(v.comments[phrase..end].bytes())
                .map(|(c, s)| {
                    if c != s || !c.is_ascii() {
                        '_'
                    } else {
                        c as char
                    }
                })
                .collect();
            let groups = swallowed_comparisons(&grouped(&filled));
            if groups.is_empty() {
                return None;
            }
            begin = phrase;
            let mut out = String::new();
            let mut at = phrase;
            for (a, b) in groups {
                out.push_str(&source[at..phrase + a]);
                out.push('(');
                out.push_str(&source[phrase + a..phrase + b]);
                out.push(')');
                at = phrase + b;
            }
            (
                &source[phrase..at],
                out.into(),
                "Parenthesise each comparison".into(),
                false,
            )
        }
        // `{x+1} each a` is `a+1`. Not unattended: on an empty typed list
        // `each` returns a general `()` where the arithmetic keeps the type,
        // and `""*2` is 'type in q 5 where each returns `()`.
        "QR004" => {
            let m = re!(
                r"^\{\s*(?:x\s*([-+*%])\s*(-?\d[A-Za-z0-9.]*)|(-?\d[A-Za-z0-9.]*)\s*([-+*%])\s*x)\s*\}[ \t]*(?:each\b|')[ \t]*"
            )
            .captures(source.get(start..)?)?;
            // `{x -1}` indexes x at -1: there is no arithmetic to lift.
            if re!(r"^\{\s*x\s+-\d").is_match(m.get(0)?.as_str()) {
                return None;
            }
            let tick = !m.get(0)?.as_str().contains("each");
            let before = v.code[..start].trim_end();
            let heads = before.is_empty()
                || before.ends_with(|c: char| ":;([{,+-*%&|<>=~!^#$?@".contains(c));
            if tick && !heads {
                return None;
            }
            let from = start + m.get(0)?.end();
            // `{x*2}'[a]` applies in brackets; in the parentheses the
            // rewrite would put round it, `([a])*2` is a keyed table header
            // and gives a dictionary in q 5. QR002 refuses it the same way.
            if source[from..].starts_with('[') {
                return None;
            }
            let mut end = argument_end(&v.code, &v.comments, source, from)?;
            // In a qSQL phrase the argument ends at the column's `,` or at
            // `by`, `from` or `where`, as QP006's does (#350).
            match query_clause(&v.code, start) {
                None => {}
                Some("from") => return None,
                Some(_) => end = query_argument_end(&v.code, &v.comments, source, from, end)?,
            }
            let argument = &source[from..end];
            if argument.trim().is_empty() {
                return None;
            }
            let simple =
                re!(r"^(?:\.?[A-Za-z][A-Za-z0-9_.]*|-?\d[A-Za-z0-9.]*(?: +-?\d[A-Za-z0-9.]*)*)$")
                    .is_match(argument);
            let new = match (m.get(1), m.get(3)) {
                // x on the left: the argument takes parentheses unless it is
                // one token, or `a,b+1` would add to `b` alone.
                (Some(op), _) => {
                    let arg = if simple {
                        argument.into()
                    } else {
                        format!("({argument})")
                    };
                    format!("{arg}{}{}", op.as_str(), &m[2])
                }
                // x on the right takes everything to its right anyway.
                _ => format!("{}{}{argument}", &m[3], &m[4]),
            };
            let gap = if ends_in_token(&source[..start]) {
                " "
            } else {
                ""
            };
            (
                &source[start..end],
                format!("{gap}{new}").into(),
                "Apply the arithmetic to the whole list".into(),
                false,
            )
        }
        // A commented-out definition on one line: delete the line.
        "QL002" => {
            let line_end = source[start..]
                .find('\n')
                .map_or(source.len(), |at| start + at + 1);
            let text = &source[start..line_end];
            let close = text.rfind('}')?;
            let open = text.find('{')?;
            if matching(text, open, b'{', b'}') != Some(close + 1) {
                return None;
            }
            // The whole line, its indentation too: left behind, the
            // indentation would make the next line continue the one above.
            let line_start = source[..start].rfind('\n').map_or(0, |at| at + 1);
            if !source[line_start..start].trim().is_empty() {
                return None;
            }
            begin = line_start;
            (
                &source[line_start..line_end],
                "".into(),
                "Delete the commented-out definition".into(),
                false,
            )
        }
        // Match compares whole operands; a filter wants `=` row by row.
        "QB005" if source.get(start..)?.starts_with('~') => {
            ("~", "=".into(), "Compare row by row with `=`".into(), false)
        }
        // `x` read in a lambda that declares one parameter: read that
        // parameter, which is almost always what was meant.
        "QF010" if source.get(start..)?.starts_with('x') => {
            let brace = v.code[..start].rfind("{[")?;
            let sig = signature(&v.code, source, brace);
            let [param] = sig.slots[..] else {
                return None;
            };
            // A literal pattern, `{[`s] x+1}` or `{[1] x}`, binds no name
            // (q 5, #298), so there is nothing to read in place of `x`.
            if !is_param_name(param) || matching(&v.code, brace, b'{', b'}')? <= start {
                return None;
            }
            let param = param.to_string();
            (
                "x",
                param.clone().into(),
                format!("Read the parameter `{param}`").into(),
                false,
            )
        }
        // `f . ()` is 'type; a niladic call is `f[]`.
        // The finding sits on the `.` it names, and detection has already
        // checked that the parentheses are empty and end the operand.
        "QA004" => {
            let m = re!(r"^\.\s*\(\s*\)").find(source.get(start..)?)?;
            let function = source[..start].trim_end_matches([' ', '\t']);
            if !ends_in_token(function) {
                return None;
            }
            // A symbol naming the function is no failure to replace: q 5
            // gives the projection `` `f[] `` for `` `f . () ``, and `` `f[] ``
            // calls it (#408).
            let named = &v.code[..function.len()];
            if unsymbolled(named).as_bytes().last() != named.as_bytes().last() {
                return None;
            }
            begin = function.len();
            (
                &source[begin..start + m.end()],
                "[]".into(),
                "Call with `[]`".into(),
                true,
            )
        }
        // `til 5.0` is 'type; a float with no fraction is the long it spells.
        "QT008" => {
            let m = re!(r"^til(\s+)(\d+)(?:\.0*[ef]?|[ef])").captures(source.get(start..)?)?;
            let end = m.get(0)?.end();
            // Nor an exponent's sign: `til 2e-1` is no `til 2-1`.
            if source[start + end..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '.')
                || (m[0].ends_with(['e', 'E']) && re!(r"^[+-]\d").is_match(&source[start + end..]))
            {
                return None;
            }
            (
                &source[start..start + end],
                format!("til{}{}", &m[1], &m[2]).into(),
                format!("Pass the long {}", &m[2]).into(),
                true,
            )
        }
        // A number signalled is 'stype; signal it as a string.
        "QT025" => {
            let m =
                re!(r"^'(\s*)(-?\d(?:e-|e\+\d|[A-Za-z0-9.:])*)").captures(source.get(start..)?)?;
            // Only the whole operand: `'10 20` with its first item quoted would
            // be `'"10" 20`, still 'stype, and `'1 2` would be `'enlist"1" 2`,
            // 'type (#1200).
            if !operand_ends(&v.code, &v.comments, start + m.get(0)?.end()) {
                return None;
            }
            // One digit in quotes is a char atom, still 'stype (#565).
            let list = if m[2].len() == 1 { "enlist" } else { "" };
            (
                m.get(0)?.as_str(),
                format!("'{}{list}\"{}\"", &m[1], &m[2]).into(),
                format!("Signal the string \"{}\"", &m[2]).into(),
                true,
            )
        }
        // A nested lambda cannot see its parent's locals; the repair q
        // programmers write is to pass the local in: `{a+x} each l` inside
        // `{[a] ...}` becomes `{[x;a] a+x}[;a] each l`. Verified in q 5. Not
        // unattended: where a global of that name exists the old code reads
        // it, and the new one reads the local.
        "QF005" => {
            let name = re!(r"'([A-Za-z][A-Za-z0-9_]*)'").captures(&finding.detail)?[1].to_string();
            let brace = enclosing_brace(&v.code, start)?;
            let close = matching(&v.code, brace, b'{', b'}')?;
            let sig = signature(&v.code, source, brace);
            // A transformation pattern is no body to pass the local into
            // (#637).
            if start < sig.body {
                return None;
            }
            // q takes at most 8 parameters: a ninth is 'params at load (#337).
            if sig.named && sig.slots.len() >= 8 {
                return None;
            }
            // The local goes last and the projection fills only its slot:
            // first, it would push `x` to a position QS008 then reports (#772).
            let (header, slots) = if sig.named {
                // `{ [b] ...}` is a signature too: q allows space before
                // the `[` (#323).
                let bracket = v.code[brace + 1..].find('[')? + brace + 1;
                let inner = &source[bracket + 1..sig.body - 1];
                (format!("{{[{inner};{name}]"), sig.slots.len())
            } else {
                // Implicit arguments become explicit ones, as many as q
                // gives the lambda - and at least `x`, or the projection
                // would fill every slot and run on the spot. A column in a
                // query is no argument: `{exec sum y from t}` takes one (#777).
                let rank = lambda_rank(&v.code, source, brace, close - 1);
                let params = ["x", "x;y", "x;y;z"][rank - 1];
                (format!("{{[{params};{name}] "), rank)
            };
            // Passed in, the local is read where the lambda is written, so it
            // has to hold a value there: a parameter of the lambda around it,
            // or assigned in an earlier statement. Otherwise q 5 refuses the
            // rewrite with 'a - `{a:{[x;a] a+1}[;a];a}`, and a read before a
            // later `a:2` alike (#769).
            let parent = enclosing_brace(&v.code, brace)?;
            let outer = signature(&v.code, source, parent);
            if !(outer.named
                && outer
                    .slots
                    .iter()
                    .any(|p| pattern_names(p).contains(&name.as_str())))
            {
                let before = top_level(&v.code[outer.body..brace]);
                let mut depth = 0i32;
                let statement = before
                    .bytes()
                    .enumerate()
                    .filter(|&(_, b)| {
                        match b {
                            b'(' | b'[' | b'{' => depth += 1,
                            b')' | b']' | b'}' => depth -= 1,
                            _ => {}
                        }
                        b == b';' && depth == 0
                    })
                    .last()
                    .map_or(0, |(i, _)| i);
                let earlier = &before[..statement];
                let assigned = earlier.match_indices(name.as_str()).any(|(i, _)| {
                    let after = &earlier[i + name.len()..];
                    let op = after.trim_start_matches([' ', '\t']);
                    boundary(earlier, i)
                        && !after
                            .starts_with(|c: char| c.is_ascii_alphanumeric() || "_.".contains(c))
                        && op.starts_with(':')
                        && !op.starts_with("::")
                });
                if !assigned {
                    return None;
                }
            }
            let rest = &source[sig.body..close];
            begin = brace;
            (
                &source[brace..close],
                format!("{header}{rest}[{}{name}]", ";".repeat(slots)).into(),
                format!("Pass `{name}` in as a parameter").into(),
                false,
            )
        }
        // `$[c;a;b;]`: the trailing `;` makes `b` a test. Dropping it gives
        // the if-else the layout says.
        "QA007" => {
            if !v.code.get(start..)?.starts_with("$[") {
                return None;
            }
            let close = matching(&v.code, start + 1, b'[', b']')?;
            let inner = &v.code[start + 2..close - 1];
            let last = slots(inner).last().copied()?;
            if !last.trim().is_empty() {
                return None;
            }
            let semi = start + 2 + inner.len() - last.len() - 1;
            begin = semi;
            (";", "".into(), "Remove the trailing `;`".into(), false)
        }
        // `$[c;a]` is 'type; `if[c;a]` runs `a` when `c` holds.
        // Not straight after a value: `` `int$[a;b] `` would become
        // `` `intif[a;b] ``. And only as a statement of its own: `if` has
        // no value, so `1+if[..]` is still 'type and `enlist if[..]` a silent
        // `::` where q used to raise (#781).
        "QA006"
            if source.get(start..)?.starts_with("$[")
                && !ends_in_token(&source[..start])
                && value_discarded(&v.code, start) =>
        {
            ("$[", "if[".into(), "Use `if[...]`".into(), false)
        }
        // `where a:1` is 'type; the comparison is `=`.
        "QT028" => {
            let m = re!(r"^[A-Za-z][A-Za-z0-9_.]*\s*:").find(source.get(start..)?)?;
            if source[start + m.end()..].starts_with(':') {
                return None;
            }
            begin = start + m.end() - 1;
            (":", "=".into(), "Compare with `=`".into(), true)
        }
        // `2.0 rotate x` and `3.0 mavg x` are 'type; a float with no fraction
        // is the long it spells.
        "QT014" | "QT017" => {
            let m = re!(r"^(\d+)(?:\.0*[ef]?|[ef])").captures(source.get(start..)?)?;
            let end = m.get(0)?.end();
            if !source[start + end..].starts_with([' ', '\t']) {
                return None;
            }
            (
                m.get(0)?.as_str(),
                m[1].to_string().into(),
                format!("Pass the long {}", &m[1]).into(),
                true,
            )
        }
        // `10/2` is over, not division. Usually `%` was meant; `(+)/(l)` is
        // what over looks like, so only on request.
        "QB014" => {
            let at = start + source.get(start..)?.find('/')?;
            if at > start + 1 {
                return None;
            }
            begin = at;
            ("/", "%".into(), "Divide with `%`".into(), false)
        }
        // `a:a` does nothing at best. Remove the statement and its `;`, or
        // the line when it is alone on one - or, inside an expression, just
        // the assignment.
        "QB017" => {
            let m =
                re!(r"^(\.?[A-Za-z][A-Za-z0-9_.]*)\s*::?\s*(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]*(?:;[ \t]*)?")
                    .captures(source.get(start..)?)?;
            if m[1] != m[2] {
                return None;
            }
            let whole = m.get(0)?;
            let line_start = source[..start].rfind('\n').map_or(0, |i| i + 1);
            // Only a whole statement can go. `r:x+b:b` reads the value it
            // assigns, so there only the `b:` is removed: q 5 gives 3 for
            // `{[x;b] r:x+b:b;r}[1;2]` and for `{[x;b] r:x+b;r}[1;2]`.
            let before = v.code[..start].trim_end();
            let statement = before.is_empty()
                || before.ends_with([';', '{'])
                || (start == line_start && enclosing_brace(&v.code, start).is_none())
                || enclosing_brace(&v.code, start).is_some_and(|brace| {
                    let sig = signature(&v.code, source, brace);
                    sig.named && v.code[sig.body..start].trim().is_empty()
                });
            let rest = &source[start + whole.end()..];
            let line_rest = rest.split('\n').next().unwrap_or("");
            // A lambda's last statement is its value: `{[a] a:a}` returns
            // `a`, and `{[a] }` would return null. Keep the name there.
            let last = !whole.as_str().contains(';')
                && v.code[start + whole.end()..].trim_start().starts_with('}')
                && enclosing_brace(&v.code, start).is_some();
            if !statement || last {
                (
                    &source[start..start + m.get(2)?.start()],
                    "".into(),
                    "Remove the self-assignment".into(),
                    false,
                )
            } else if source[line_start..start].trim().is_empty() && line_rest.trim().is_empty() {
                let end = start + whole.end() + line_rest.len();
                let end = (end + 1).min(source.len());
                begin = line_start;
                (
                    &source[line_start..end],
                    "".into(),
                    "Remove the self-assignment".into(),
                    false,
                )
            } else {
                // A `/` comment after it needs the blank before it: `x:1;/ c`
                // is over, which q 5 refuses to load (#403).
                let text = whole.as_str();
                let text = if rest.starts_with('/') {
                    text.trim_end_matches([' ', '\t'])
                } else {
                    text
                };
                (text, "".into(), "Remove the self-assignment".into(), false)
            }
        }
        // The timestamp the convention asks for in place of datetime. A
        // different type, so only on request.
        "QP002" => {
            let line_end = v.code[start..]
                .find('\n')
                .map_or(v.code.len(), |at| start + at);
            // The `"z"` cast is reported on its `$`; its string comes first.
            let start = re!(r#""z"\s*$"#)
                .find(&source[..start])
                .map_or(start, |m| m.start());
            // Matched as the detector matches: on the view without comments,
            // and in code - a string spelling `"0Nz"` or `"15h$"` is data.
            // The `"z"` cast is the one string that is the point, so only
            // its `$` has to be code.
            let line = &v.comments[start..line_end];
            let code = &v.code[start..line_end];
            // Nor a symbol, which may spell a datetime and hold none (#409).
            let line_start = v.code[..start].rfind('\n').map_or(0, |at| at + 1);
            let symbols = unsymbolled(&v.code[line_start..line_end]);
            let symbols = &symbols[start - line_start..];
            let in_code = |m: &regex::Match| {
                if m.as_str().starts_with('"') {
                    code.as_bytes()[m.end() - 1] == b'$'
                } else {
                    code[m.range()] == *m.as_str()
                        && (!m.as_str().starts_with(|c: char| c.is_ascii_digit())
                            || symbols.as_bytes()[m.start()] == code.as_bytes()[m.start()])
                }
            };
            let swaps: [(&regex::Regex, &str); 5] = [
                (re!(r"`datetime(\s*\$)"), "`timestamp$1"),
                (re!(r#""z"(\s*\$)"#), "\"p\"$1"),
                (re!(r"\b15h(\s*\$)"), "12h$1"),
                (re!(r"(^|[^\w.])(-?0[NW])z\b"), "$1${2}p"),
                (re!(r"\b(\d{4}\.\d{2}\.\d{2})T(\d)"), "${1}D$2"),
            ];
            let (m, regex, to) = swaps
                .iter()
                .filter_map(|(r, to)| r.find_iter(line).find(&in_code).map(|m| (m, *r, *to)))
                .min_by_key(|s| s.0.start())?;
            begin = start + m.start();
            (
                &source[begin..start + m.end()],
                regex.replace(m.as_str(), to).into_owned().into(),
                "Use timestamp, not datetime".into(),
                false,
            )
        }
        // A parameter named for a builtin: rename it, and its reads in this
        // lambda's own body - a nested lambda cannot see it, so its uses of
        // the name are the builtin's and stay.
        "QF001" => {
            if !v.code.get(start..)?.starts_with("{[") {
                return None;
            }
            let name =
                re!(r#""([A-Za-z][A-Za-z0-9_]*)""#).captures(&finding.detail)?[1].to_string();
            let close = matching(&v.code, start, b'{', b'}')?;
            let new = format!("{name}Arg");
            if re!(r"\b[A-Za-z][A-Za-z0-9_]*\b")
                .find_iter(&v.code[start..close])
                .any(|w| w.as_str() == new)
            {
                return None;
            }
            let text = &v.code[start..close];
            let mut depth = 0i32;
            let mut out = String::new();
            let mut at = 0;
            let bytes = text.as_bytes();
            for (i, &b) in bytes.iter().enumerate() {
                match b {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ => {}
                }
                let word = depth == 1
                    && text[i..].starts_with(name.as_str())
                    && (i == 0
                        || !(bytes[i - 1].is_ascii_alphanumeric()
                            || b"_.`".contains(&bytes[i - 1])))
                    && !bytes
                        .get(i + name.len())
                        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
                if word && i >= at {
                    out.push_str(&source[start + at..start + i]);
                    out.push_str(&new);
                    at = i + name.len();
                }
            }
            out.push_str(&source[start + at..close]);
            (
                &source[start..close],
                out.into(),
                format!("Rename `{name}` to `{new}`").into(),
                false,
            )
        }
        // A column one edit away from one the table has is a typo.
        "QF020" => {
            let m = re!(r"^`([^`]+)` is not a column of `[^`]+` \(([^)]*)\)")
                .captures(&finding.detail)?;
            let wrong = &m[1];
            let close: Vec<&str> = m[2]
                .split(", ")
                .filter(|c| edit_distance(c, wrong) == 1)
                .collect();
            let [right] = close[..] else {
                return None;
            };
            if !source.get(start..)?.starts_with(wrong) {
                return None;
            }
            (
                &source[start..start + wrong.len()],
                right.to_string().into(),
                format!("Did you mean `{right}`?").into(),
                false,
            )
        }
        // With the blanks after it: q 5 skips an indented first line, so
        // `<BOM> r:1` would load leaving `r` undefined (#663).
        "QE005" if start == 0 && source.starts_with('\u{feff}') => {
            let blanks = source[3..].len() - source[3..].trim_start_matches([' ', '\t']).len();
            (
                &source[..3 + blanks],
                "".into(),
                "Remove byte-order mark".into(),
                true,
            )
        }
        // `f x` becomes `f[x]`. The name is what the finding points at;
        // the argument is everything the application swallows, which the
        // masked code is the only honest place to measure - a `;` inside
        // a string or a trailing comment must not end it.
        "QP006" => {
            let name = re!(r"^\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*")
                .find(v.code.get(start..)?)?
                .as_str();
            let argument = argument_start(source, &v.comments, start + name.len())?;
            let mut end = argument_end(&v.code, &v.comments, source, argument)?;
            // A qSQL phrase ends an expression early: `update t:d 0 from
            // rows` is `d[0] from rows`, not `d[0 from rows]`. After `from`
            // the table is one whole expression up to `where` - q 5 reads
            // `select from g v,w` as `g[v,w]` - and that is left to a person.
            match query_clause(&v.code, start) {
                None => {}
                Some("from") => return None,
                Some(_) => end = query_argument_end(&v.code, &v.comments, source, argument, end)?,
            }
            (
                source.get(start..end)?,
                format!("{name}[{}]", &source[argument..end]).into(),
                format!("Call `{name}` with brackets").into(),
                true,
            )
        }
        // `-x` becomes `neg x`: q 4 read a glyph applied to one argument,
        // `-:x` too, as the monadic form, which q 5 spells only with its
        // keyword - on KDB-X `(-:)x` and `neg x` parse alike, and `(,:)x`
        // and `enlist x` give the same value. Not `<` and `>`: on an atom
        // they are hopen and hclose, on a list a grade, which no one keyword
        // is. Nor `-::a`, nor the file verbs.
        "QE008" => {
            let rest = v.code.get(start..)?;
            let keyword = match rest.as_bytes().first()? {
                b'+' => "flip",
                b'-' => "neg",
                b'*' => "first",
                b'%' => "reciprocal",
                b'!' => "key",
                b'#' => "count",
                b'$' => "string",
                b'&' => "where",
                b'|' => "reverse",
                b'^' => "null",
                b'=' => "group",
                b'~' => "not",
                b',' => "enlist",
                b'@' => "type",
                b'?' => "distinct",
                b'.' => "value",
                b'_' => "floor",
                _ => return None,
            };
            // Nor `..a`, a name typed with one point too many, which
            // `value .a` would run (#2232).
            if rest[1..].starts_with("::") || keyword == "value" && rest[1..].starts_with('.') {
                return None;
            }
            let old = &source[start..start + 1 + usize::from(rest[1..].starts_with(':'))];
            let after = &v.code[start + old.len()..];
            let next = refusals::continued(after);
            // An operand, not another glyph - `a%.%b` - unless one applied
            // with brackets or a negative literal. A `%name%` template
            // placeholder is no reciprocal anybody meant.
            let glyph = next.starts_with(|c: char| "+-*%!#$&|^=<>~,@?._".contains(c))
                && !re!(r"^\.[A-Za-z0-9]").is_match(next);
            if glyph && !(next.as_bytes().get(1) == Some(&b'[') || re!(r"^-\.?\d").is_match(next))
                || keyword == "reciprocal" && re!(r"^[A-Za-z0-9_]+%").is_match(next)
                // `{[a]-1 2}`: whether q 4 read the literal is not certain.
                || keyword == "neg"
                    && v.code[..start].ends_with(']')
                    && next.starts_with(|c: char| c.is_ascii_digit() || c == '.')
            {
                return None;
            }
            let gap = if after.starts_with([' ', '\t', '\r', '\n']) {
                ""
            } else {
                " "
            };
            let lead = if ends_in_token(&source[..start]) {
                " "
            } else {
                ""
            };
            (
                old,
                format!("{lead}{keyword}{gap}").into(),
                format!("Write `{keyword}`, the monadic form q 5 keeps").into(),
                true,
            )
        }
        // `+/x` becomes `(+/)x`: q 4 applied the derived function to what
        // follows, as the parentheses do in q 5 - `(+/)x+y` is `(+/)[x+y]`.
        // The finding is on the last iterator; the operand is a glyph, its
        // k form or a name. Not before `-`, which after `)` is minus, nor a
        // glyph applied with brackets.
        "QE009" => {
            let c = v.code.as_bytes();
            let it = re!(r"^(?:/:|\\:|':|/|\\|')").find(v.code.get(start..)?)?;
            let end = start + it.end();
            let mut run = start;
            loop {
                if run > 0 && b"/\\'".contains(&c[run - 1]) {
                    run -= 1;
                } else if run > 1 && c[run - 1] == b':' && b"/\\'".contains(&c[run - 2]) {
                    run -= 2;
                } else {
                    break;
                }
            }
            let glyph = |b: u8| b"+-*%!#$&|^=<>~,@?".contains(&b);
            let operand = match run.checked_sub(1).map(|p| c[p])? {
                b if glyph(b) => run - 1,
                b':' if run > 1 && (glyph(c[run - 2]) || c[run - 2] == b'.') => run - 2,
                b if b.is_ascii_alphanumeric() || b == b'_' || b == b'.' => {
                    let s = v.code[..run]
                        .rfind(|ch: char| !(ch.is_ascii_alphanumeric() || "._".contains(ch)))
                        .map_or(0, |p| p + 1);
                    // A qSQL word is no operand: `update a from\ t` has
                    // nothing to put in parentheses (#2235).
                    if !c[s].is_ascii_alphabetic() && c[s] != b'.'
                        || !boundary(&v.code, s)
                        || matches!(&v.code[s..run], "from" | "by" | "where")
                    {
                        return None;
                    }
                    s
                }
                _ => return None,
            };
            if operand > 0 && c[operand - 1] == b'`' {
                return None;
            }
            // A bare glyph under each or each-left/right, `(#')x`, is a
            // projection on KDB-X, not the count each `#'x` meant.
            let first = &v.code[run..];
            if operand == run - 1
                && glyph(c[operand])
                && (first.starts_with('\'') && !first.starts_with("':")
                    || first.starts_with("/:")
                    || first.starts_with("\\:"))
            {
                return None;
            }
            let next = refusals::continued(&v.code[end..]);
            if next.starts_with('-') || next.len() > 1 && glyph(c[c.len() - next.len()]) {
                return None;
            }
            begin = operand;
            let derived = &source[operand..end];
            (
                derived,
                format!("({derived})").into(),
                format!("Apply `({derived})` in parentheses").into(),
                true,
            )
        }
        // `cor each x` becomes `(cor) each x`: with nothing on its left q 4
        // took the keyword as each's function, as it does `count each x`,
        // and on KDB-X `(cor) each x` is `each[cor;x]`. With an operand on
        // the left - `x in each y` - what q 4 made of it is not certain, so
        // only in the editor. An iterator keyword before another, `f over
        // each x`, wants `(f over)`, which is the author's to place.
        "QE011" => {
            let m = re!(
                r"^(?:([a-z]+)[ \t]+|([-+*%!&|<>=~,^#$?@])[ \t]*)(each|peach|over|scan|prior)\b"
            )
            .captures(v.code.get(start..)?)?;
            let word = m.get(1).or(m.get(2))?.as_str();
            let iterator = &m[3];
            if matches!(word, "each" | "peach" | "over" | "scan" | "prior") {
                return None;
            }
            let line_start = v.code[..start].rfind('\n').map_or(0, |p| p + 1);
            let line = &source[line_start..];
            let prompt = if line.starts_with("q)") { 2 } else { 0 };
            // Read in the source: `code` blanks a string, which is an operand.
            let left = source
                .get(line_start + timed_prefix(line).max(prompt)..start)?
                .trim_end_matches([' ', '\t']);
            // A signature is no operand: `{[x] cor each y}`.
            let signature = left.ends_with(']')
                && left
                    .bytes()
                    .rev()
                    .scan(0i32, |depth, c| {
                        *depth += i32::from(c == b']') - i32::from(c == b'[');
                        Some(*depth)
                    })
                    .position(|depth| depth == 0)
                    .is_some_and(|p| left[..left.len() - 1 - p].ends_with('{'));
            let infix = !signature
                && left.ends_with(|c: char| c.is_ascii_alphanumeric() || "_.)]}\"`".contains(c));
            (
                &source[start..start + word.len()],
                format!("({word})").into(),
                format!("Write `({word})`, the function {iterator} applies").into(),
                !infix,
            )
        }
        // `hopen `host:5000` takes the leading `:` a handle needs. The old
        // call is 'type and the new one connects - a different program, so
        // only in the editor.
        "QT029" => {
            let m = re!(r"^hopen[ \t]*(?:\[\s*)?`[A-Za-z0-9_.]").find(source.get(start..)?)?;
            let old = &source[start..start + m.end() - 1];
            (
                old,
                format!("{old}:").into(),
                "Add the leading `:` of a handle".into(),
                false,
            )
        }
        // A look-alike pasted from a document becomes the ASCII it stands
        // for: a no-break space a space, a dash or minus sign `-`, a curly
        // quote a straight one. The line was 'char, so no working program
        // changes. An opening double quote is a string only with its curly
        // close on the line, and both are rewritten at once, or the close
        // would be left inside the string.
        "QE012" => {
            let ch = source.get(start..)?.chars().next()?;
            let ascii = match ch {
                '\u{a0}' => " ",
                '\u{2013}' | '\u{2014}' | '\u{2212}' => "-",
                '\u{2018}' | '\u{2019}' => "'",
                '\u{201c}' => "\"",
                _ => return None,
            };
            let old = if ch == '\u{201c}' {
                let body = start + ch.len_utf8();
                let line =
                    &source[body..source[body..].find('\n').map_or(source.len(), |p| body + p)];
                let close = line.find('\u{201d}')?;
                if line[..close].contains(['\\', '\u{201c}', '"']) {
                    return None;
                }
                &source[start..body + close + '\u{201d}'.len_utf8()]
            } else {
                &source[start..start + ch.len_utf8()]
            };
            let replacement = if old.chars().count() > 1 {
                format!(
                    "\"{}\"",
                    &old['\u{201c}'.len_utf8()..old.len() - '\u{201d}'.len_utf8()]
                )
            } else {
                ascii.to_string()
            };
            (
                old,
                replacement.into(),
                format!("Replace U+{:04X} with `{ascii}`", u32::from(ch)).into(),
                true,
            )
        }
        _ => return None,
    };
    // An edit that leaves a `-` against a number makes it a negative
    // literal: `a -{x} each 1 2` would become `a -1 2`, `a` applied to
    // `-1 2` where it was subtraction. Keep the two apart with a space,
    // unless the number was already there - then the `-` was its sign.
    let numeric = |s: &str| {
        let mut c = s.chars();
        match c.next() {
            Some(d) if d.is_ascii_digit() => true,
            Some('.') => c.next().is_some_and(|d| d.is_ascii_digit()),
            _ => false,
        }
    };
    let next: String = replacement
        .chars()
        .chain(source[begin + old.len()..].chars())
        .take(3)
        .collect();
    // Nor may an edit leave two numeric literals with only blanks between:
    // `10 20 30 {x} each 0 2` would become `10 20 30 0 2`, one vector where
    // q 5 indexed (`10 30`), and `r:10 20 30 a:0 2` loses `a:` the same
    // way. No rewrite says the same without brackets, so there is no fix -
    // unless the two were neighbours before the edit too.
    let after: String = replacement
        .chars()
        .chain(source[begin + old.len()..].chars())
        .collect();
    let blank = source[..begin].ends_with([' ', '\t']);
    if ends_in_number(&source[..begin])
        && starts_number(&after, blank)
        && !starts_number(&source[begin..], blank)
    {
        return None;
    }
    // Nor may it leave a negative literal against an operand, where its
    // `-` would read as minus: `{[x]r:-1;x}` would become `{[x]-1;x}`,
    // which q 5 refuses with '- (#563). A blank keeps it a literal. Not
    // QP008's: its `-` follows an operand, where q 5 reads `a-2.5`, `1-2.5`
    // and `` `y-2.5 `` as minus, and a blank would be one F does not give
    // back (#848). Nor QE012's: a dash typed between operands, `1—2`, was
    // meant as minus, which `1 -2` is not.
    let negative = next.starts_with('-') && numeric(&next[1..]);
    let replacement = if !matches!(finding.code.as_str(), "QP008" | "QE012")
        && (source[..begin].ends_with('-') && !numeric(&source[begin..]) && numeric(&next)
            || ends_in_token(&source[..begin]) && negative && !source[begin..].starts_with('-'))
    {
        format!(" {replacement}").into()
    } else {
        replacement
    };
    Some(Fix {
        start: begin,
        end: begin + old.len(),
        replacement,
        title,
        batch_safe,
    })
}
impl Finding {
    pub fn new(path: &str, line: usize, code: &str, detail: String) -> Self {
        let rule = RULES
            .iter()
            .find(|r| r.code == code)
            .expect("registered rule");
        Self {
            path: path.into(),
            line,
            rule: rule.name.clone(),
            detail,
            why: rule.summary.clone(),
            source: "q-lint".into(),
            // An error is what q refuses, which is what the `builtin` scope
            // means (#512); everything q accepts is a warning (#513).
            severity: if rule.scope == "builtin" {
                "error"
            } else {
                "warning"
            }
            .into(),
            column: None,
            end_line: None,
            end_column: None,
            code: rule.code.clone(),
            category: rule.category.clone(),
        }
    }
}
impl Finding {
    /// A finding at byte offset `at` of `source`, with its line and column.
    /// The column is what an editor wants: 1-based, in UTF-16 units, and at
    /// the first non-blank character when `at` is the start of a line - a
    /// rule that reports a line reports the statement on it, not the
    /// indentation before it.
    pub fn at(path: &str, source: &str, at: usize, code: &str, detail: String) -> Self {
        let at = at + source[at..].len() - source[at..].trim_start_matches([' ', '\t']).len();
        let (line, start) = line_at(source, at);
        let mut f = Self::new(path, line, code, detail);
        f.column = Some(source[start..at].encode_utf16().count() + 1);
        f
    }
}
/// The line `at` is on, from 1, and the offset that line starts at: from the
/// installed `LineScope` when `s` is its text, by counting otherwise.
pub(crate) fn line_at(s: &str, at: usize) -> (usize, usize) {
    LINES
        .with(|l| {
            let l = l.borrow();
            let t = l
                .as_ref()
                .filter(|t| t.0 == s.as_ptr() as usize && t.1 == s.len())?;
            let line = t.2.partition_point(|&start| start <= at);
            Some((line, t.2[line - 1]))
        })
        .unwrap_or_else(|| {
            let line = s.as_bytes()[..at].iter().filter(|&&b| b == b'\n').count() + 1;
            (line, s[..at].rfind('\n').map_or(0, |p| p + 1))
        })
}

/// A text's address and length, and the offset each of its lines starts at.
type LineTable = (usize, usize, Vec<usize>);

thread_local! {
    /// The text `LineScope` was installed for, by address and length, and
    /// the offset each of its lines starts at.
    static LINES: std::cell::RefCell<Option<std::rc::Rc<LineTable>>> =
        const { std::cell::RefCell::new(None) };
}

/// Keeps a table of a text's line starts installed for as long as it lives,
/// as `MatchScope` does its brackets: every finding is placed by its line,
/// and counting from the file's start for each was quadratic (#706). The
/// caller keeps the text alive and unchanged while the scope lives.
pub(crate) struct LineScope(Option<std::rc::Rc<LineTable>>);

impl LineScope {
    pub(crate) fn install(text: &str) -> LineScope {
        let starts = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(i, _)| i + 1))
            .collect();
        let table = std::rc::Rc::new((text.as_ptr() as usize, text.len(), starts));
        LineScope(LINES.with(|l| l.replace(Some(table))))
    }
}

impl Drop for LineScope {
    fn drop(&mut self) {
        let previous = self.0.take();
        LINES.with(|l| *l.borrow_mut() = previous);
    }
}
/// q's `.z` names that hold a value rather than a function or a callback:
/// applying one to a negative literal is never meant. `.z.p -0D00:01` is the
/// shape QB010 exists for.
/// q's own `.z` values that are atoms, and so refuse to be applied: each of
/// these given `-1` is an error in q 5. Not `.z.x` and `.z.X`, which are
/// lists - `.z.x -1` is `()`.
const Z_VALUES: &[&str] = &[
    ".z.a", ".z.d", ".z.D", ".z.f", ".z.h", ".z.i", ".z.K", ".z.k", ".z.n", ".z.N", ".z.o", ".z.p",
    ".z.P", ".z.t", ".z.T", ".z.u", ".z.z", ".z.Z",
];

/// The temporal and float ones among them, which `semantics` knows a name
/// bound to holds an atom: 'type indexed or applied (q 5).
pub(crate) const Z_ATOMS: &[&str] = &[
    ".z.d", ".z.D", ".z.K", ".z.k", ".z.n", ".z.N", ".z.p", ".z.P", ".z.t", ".z.T", ".z.z", ".z.Z",
];

/// QB010's message, shared by the `.z` case here and the bound-name case in
/// `semantics`.
/// QA005's message for `peach`, which is `':`: on a rank-2 lambda that is
/// each-prior, not a parallel each - q 5 `{[a;b] a*b} peach 1 2` is `0N 2`,
/// with or without secondaries - and on a higher rank a projection, as under
/// `each`. None for `each`, whose message each caller words itself.
fn peach_detail(iterator: &str, rank: usize) -> Option<String> {
    (iterator == "peach").then(|| {
        if rank == 2 {
            "`peach` is `':`, which on a rank-2 lambda is each-prior: it pairs each item \
             with the one before it rather than running in parallel"
                .to_string()
        } else {
            format!(
                "`peach` supplies one argument to a rank-{rank} lambda, so the result is a \
                 projection, not values"
            )
        }
    })
}

pub(crate) fn apply_not_subtract(name: &str, literal: &str) -> String {
    format!(
        "`{name} {literal}` applies the atom `{name}` to the negative literal `{literal}`, which \
         q refuses: with a space before `-` and none after, the `-` belongs to the literal. \
         `{name} - {}` or `{name}-{}` is subtraction",
        &literal[1..],
        &literal[1..]
    )
}

/// Whether `s` is an atom literal, a number or one symbol, which dot apply
/// refuses as an argument list. Not `10b` or `0x0102`: each digit of a
/// boolean, and each pair of a byte literal past the first, is another item
/// (q 5: `f . 10b` is 1i, `.[f;0x0102]` 3i, and `f . 1b` and `f . 0x01` 'type).
fn scalar_literal(s: &str) -> bool {
    // A clock part is part of the literal: `12:00`, `0D01:00` and
    // `2000.01.01D12:00` are atoms (#738).
    re!(r"^(?:-?\d[A-Za-z0-9.]*(?::\d[A-Za-z0-9.]*)*|`[A-Za-z0-9_.]*)$").is_match(s)
        && !re!(r"^[01]{2,}b$|^0x[0-9a-fA-F]{3,}$").is_match(s)
}

/// The length in `comments` of the char atom `s` starts with - a string of
/// one byte as q counts them, `"a"` or `"\n"` - if it starts with one. In
/// `code` a string is blanks, so `scalar_literal` never sees it (#738).
fn char_atom(s: &str) -> Option<usize> {
    let m = re!(r#"^"((?:\\[0-7]{3}|\\.|[^"\\])*)""#).captures(s)?;
    (q_bytes(&m[1]).len() == 1).then(|| m.get(0).unwrap().end())
}

/// The UTC clock QP003 asks for in place of a local one: the same clock in
/// lower case, but a timestamp for the local datetime `.z.Z`, since `.z.z`
/// is the legacy datetime QP002 reports in the same profile (#519).
fn utc_clock(local: &str) -> String {
    if local == ".z.Z" {
        ".z.p".into()
    } else {
        local.to_ascii_lowercase()
    }
}

fn boundary(s: &str, at: usize) -> bool {
    // Callers walk bytes, so `at` can fall inside a multi-byte character -
    // the middle of a token, never the start of one.
    let Some(before) = s.get(..at) else {
        return false;
    };
    match before.chars().next_back() {
        None => true,
        // `_` joins a name only after that name's own letters: `x_ns` is one
        // name, but `3_ns` is `3 _ ns` - drop, reading `ns` - and so is
        // `(x)_ns`. Verified with parse in q 5: "3_ns" is (_;3;`ns), and so
        // are "1.5_ns", "0x01_ns" and "3j_ns", while "x_ns" is `x_ns.
        Some('_') => !ends_in_name(&before[..before.len() - 1]),
        // Nor after a number's exponent sign, which q reads on past: the `y`
        // of `1e-y` is no name, since `-4!"1e-y"` is one token (#2099).
        Some('-' | '+') => !in_number(s, at - 1),
        Some(c) => !c.is_alphanumeric() && !".`".contains(c),
    }
}
/// Each match of `re` in `hay` that `keep` accepts, looking again one
/// character on from a match it rejects. A plain iterator resumes after the
/// rejected match, so a literal it swallowed is never seen: a number
/// pattern that lets `:` in starts at the `1` of `x1:1.5j`, inside the name,
/// and takes `1.5j` with it.
pub(crate) fn captures_where<'h>(
    re: &regex::Regex,
    hay: &'h str,
    keep: impl Fn(&regex::Captures) -> bool,
) -> Vec<regex::Captures<'h>> {
    let mut out = vec![];
    let mut at = 0;
    while at <= hay.len()
        && let Some(c) = re.captures_at(hay, at)
    {
        let m = c.get(0).unwrap();
        let step = hay[m.start()..].chars().next().map_or(1, char::len_utf8);
        if keep(&c) {
            at = if m.is_empty() {
                m.end() + step
            } else {
                m.end()
            };
            out.push(c);
        } else {
            at = m.start() + step;
        }
    }
    out
}
/// `captures_where`, keeping the matches that start a token in `view`.
pub(crate) fn boundary_captures<'h>(
    re: &regex::Regex,
    hay: &'h str,
    view: &str,
) -> Vec<regex::Captures<'h>> {
    captures_where(re, hay, |c| boundary(view, c.get(0).unwrap().start()))
}
/// `code` with every symbol literal blanked. A symbol runs on past where a
/// name would stop - over `:` anywhere, and over `/` after `` `: `` (q 5
/// `parse` reads "`a:b" and "`:hdb/sym" as one symbol each) - so `boundary`
/// alone takes the words inside `` `:conf/true `` for code.
pub(crate) fn unsymbolled(code: &str) -> String {
    let mut out = code.as_bytes().to_vec();
    for m in re!(r"`(?::[A-Za-z0-9_.:/]*|[A-Za-z0-9_.:]*)").find_iter(code) {
        blank(&mut out[m.range()]);
    }
    String::from_utf8(out).unwrap_or_default()
}
/// Whether `s` ends with a name - letters, digits and `_` that began with a
/// letter - rather than a number, a bracket or an operator. A segment of a
/// dotted name may begin with `_`: `.a.b.__perf` and `.h._ranks` are one name
/// each (q 5 `parse "a._ns"` is `` `a._ns ``), so `_` after `name.` still
/// continues it - while `._ns` with nothing before the dot is no name at all.
pub(crate) fn ends_in_name(s: &str) -> bool {
    let token: Vec<char> = s
        .chars()
        .rev()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    match token.last() {
        Some(c) if c.is_alphabetic() => true,
        // The caller has taken one `_` off already, so `.h._` arrives as `.h.`.
        None | Some('_') => s[..s.len() - token.iter().map(|c| c.len_utf8()).sum::<usize>()]
            .strip_suffix('.')
            .is_some_and(ends_in_name),
        _ => false,
    }
}
/// Whether the expression an operand belongs to ends at `at`.
///
/// q reads right to left, so a right operand is everything to the right of
/// its operator, and a literal there is only the whole operand when nothing
/// follows it but the end of the expression. Naming the characters that may
/// not follow is the wrong way round: almost any glyph continues one -
/// `` `a`b?`b `` is a long, `4 5,6` three items, `0^x` a fill. A rule that
/// judges a literal by its type or length asks this first, or it is judging
/// the start of an expression it has not read.
/// Whether a `$[...]` condition is an infix with a vector literal on one
/// side, which cannot produce the atom `$` needs: `1 2 3>2`, `x>1 2 3`,
/// `` `a`b=`a `` are all 'type there. Only the whole condition, so
/// `any x>1 2 3` - an atom - is not this; and only the operators that pair
/// items, so `~` and `in`, which return one boolean, are not either.
/// Whether a literal, as written in the view that keeps strings, is one q 5
/// refuses as a test wherever it sits - any test of `$[...]`, the test of
/// `if` or `while`, the count of `do`: a symbol (`` `a ``, `` ` ``), a
/// string of other than one char, a symbol or byte vector, or a float, real
/// or guid atom. `$["ab";..]`, `$[`a`b;..]`, `$[0x0102;..]`, `$[1.5;..]`,
/// `$[0n;..]`, `$[1e;..]`, `if[`a;..]` and `do[1.5;..]` are each 'type;
/// `0N` and `0W` are longs and are not, and nor is `-0n`: q 5 reads it as
/// the timespan `0D00:00` (type -16h), while `-0w` is the float.
fn refused_atom_condition(raw: &str) -> bool {
    re!(r#"^"((?:[^"\\]|\\.)*)"$"#)
        .captures(raw)
        .is_some_and(|c| q_bytes(&c[1]).len() != 1)
        // An hsym runs on over `/`: `` `:db/t `` is one symbol (q 5).
        || re!(r"^(?:`(?::[A-Za-z0-9_.:/]*|[A-Za-z0-9_.:]*))+$").is_match(raw)
        || re!(r"^0x(?:[0-9a-fA-F]{2}){2,}$").is_match(raw)
        || re!(r"^-?(?:\d+\.\d*|\.\d+|\d+(?:\.\d*)?(?:e[+-]?\d+|E\d+))[ef]?$|^-?\d+[ef]$|^0[nwNW][ef]?$|^-0[wW][ef]?$|^0Ng$")
            .is_match(raw)
            && !re!(r"^-?0[NW]$").is_match(raw)
}

/// A conditional's test as QB025 compares it: `comments`' text, its strings
/// kept as written and each run of blanks outside them made one space, so
/// `x>1` and `x>1 ` are one test and `s~"a  b"` and `s~"a b"` are two. A
/// string is where `code` is blank and `comments` is not, from a quote.
fn same_test(comments: &str, code: &str) -> String {
    let (text, mask) = (comments.as_bytes(), code.as_bytes());
    let mut out = Vec::with_capacity(text.len());
    let (mut i, mut blank) = (0, false);
    while i < text.len() {
        if text[i] == b'"' && mask[i] == b' ' {
            let mut j = i + 1;
            while j < text.len() && text[j] != b'"' {
                j += if text[j] == b'\\' { 2 } else { 1 };
            }
            let j = (j + 1).min(text.len());
            out.extend_from_slice(&text[i..j]);
            (i, blank) = (j, false);
        } else if text[i].is_ascii_whitespace() {
            if !blank {
                out.push(b' ');
            }
            (i, blank) = (i + 1, true);
        } else {
            out.push(text[i]);
            (i, blank) = (i + 1, false);
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether a `$[...]` test is a literal q 5 refuses with 'type: an atom
/// `refused_atom_condition` names, `()`, a boolean vector, a spaced numeric
/// vector, a comparison of vectors, a general list or `enlist` of an item.
/// `raw` is the test with strings still in it, `cond` the same text from
/// the masked view. q 5: `$[(1;2);1;2]` and `$[enlist 1b;1;2]` are 'type
/// (#633).
fn refused_test(raw: &str, cond: &str) -> bool {
    refused_atom_condition(raw)
        || re!(r"^\(\s*\)$").is_match(cond)
        || (cond.starts_with('(')
            && matching(cond, 0, b'(', b')') == Some(cond.len())
            && slots(&cond[1..cond.len() - 1]).len() > 1)
        || re!(r"^enlist(?:\s+[^\s\[]|\s*\[[^;\[\]]*\]$)").is_match(cond)
        || re!(r"^`[A-Za-z][A-Za-z0-9_.]*$").is_match(cond)
        || re!(r"^[01]{2,}b$").is_match(cond)
        || (re!(r"^-?\d[A-Za-z0-9.]*(?:\s+-?\d[A-Za-z0-9.]*)+$").is_match(cond)
            // Spaced, a `b` suffix is not a boolean vector: `1 0b` is
            // `(1;0b)`, the long 1 - stdout's handle - applied to 0b,
            // which writes it and returns 1. q 5: `$[1 0b;a;b]` is a.
            && !cond.ends_with('b'))
        || vector_comparison(cond)
}

fn vector_comparison(cond: &str) -> bool {
    const VECTOR: &str = r"(?:-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)+|\(\s*-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)+\s*\)|(?:`[A-Za-z0-9_.]*){2,}|[01]{2,}b)";
    const OPERAND: &str = r"(?:-?\d[A-Za-z0-9.]*|`[A-Za-z0-9_.]*|\.?[A-Za-z][A-Za-z0-9_.]*)";
    const OP: &str = r"(?:<=|>=|<>|[=<>+*%&|-])";
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(&format!(
            r"^(?:{VECTOR}\s*{OP}\s*(?:{OPERAND}|{VECTOR})|{OPERAND}\s*{OP}\s*{VECTOR})$"
        ))
        .unwrap()
    });
    RE.is_match(cond)
}
/// Whether the expression an operand belongs to ends at `at`: at a `;`, a
/// closing bracket or the end of the line - or, inside a qSQL phrase, at the
/// `from`, `by` or `where` that ends the phrase and the `,` that separates
/// its columns. q 5: `select b:1+`x from t`, `select b:1+`x,c:a from t`,
/// `select by b:1+`x from t` and `select from t where a=1+`x, a>1` are
/// each 'type, as the same expression on a line of its own is.
/// Where the parentheses around the function from `start` to `end` close,
/// when nothing else is in them: `({...})` or `(f)`.
fn parenthesised(code: &str, start: usize, end: usize) -> Option<usize> {
    let before = code[..start].trim_end_matches([' ', '\t']);
    let open = before.strip_suffix('(').map(|b| b.len())?;
    let close = matching(code, open, b'(', b')')?;
    // `get`: in `({[] count:1)}` the `)` closes inside the lambda, before
    // its end, and the lambda is not what the parentheses hold.
    code.get(end..close - 1)
        .is_some_and(|s| s.trim().is_empty())
        .then_some(close)
}
/// The bracket in a chain of them, from the one at `open` given a function
/// of `rank`, that holds more arguments than what it is applied to takes:
/// its `[`, its slot count and that rank. Each bracket short of a call
/// leaves a projection of the slots still open, and the next applies to it:
/// q 5 `{[a;b] a+b}[1][2;3]` and `[;1][2;3]` are 'rank (#628). A projection
/// given an elided slot is not checked until it runs - q 5 `f[1][;2]` is a
/// projection - so a later bracket counts only when it fills every slot.
fn over_applied(code: &str, open: usize, rank: usize) -> Option<(usize, usize, usize)> {
    let (mut open, mut rank, mut first) = (open, rank, true);
    loop {
        let close = matching(code, open, b'[', b']')?;
        let parts = slots(&code[open + 1..close - 1]);
        let filled = parts.iter().filter(|p| !p.trim().is_empty()).count();
        if filled == 0 && parts.len() == 1 {
            // `f[]`: a call of a rank-1 function, nothing at any other.
            if rank <= 1 {
                return None;
            }
        } else if parts.len() > rank {
            return (first || filled == parts.len()).then_some((open, parts.len(), rank));
        } else {
            rank -= filled;
        }
        if rank == 0 {
            return None;
        }
        let next =
            close + (code[close..].len() - code[close..].trim_start_matches([' ', '\t']).len());
        if !code[next..].starts_with('[') {
            return None;
        }
        (open, first) = (next, false);
    }
}
/// Whether `ss[...]` or `ssr[...]`, its slots split at `open`, gets every
/// argument: two for `ss` and three for `ssr`, none of them empty. Short of
/// that it is a projection, and nothing has run: q 5 `ssr["abc";`a]` and
/// `ssr["abc";""]` are both a function (104h). A slot is judged empty in
/// `comments`, where a string is still text.
fn complete_call(comments: &str, open: usize, parts: &[&str], ssr: bool) -> bool {
    let mut from = open + 1;
    parts.len() == if ssr { 3 } else { 2 }
        && parts.iter().all(|part| {
            let full = !comments[from..from + part.len()].trim().is_empty();
            from += part.len() + 1;
            full
        })
}

/// Whether the right operand starting at `at` is the empty string and
/// nothing else, in any number of parentheses: `""` and `("")`, but not
/// `"","b"`, which is the pattern "b" (q 5: `"abc" ss "","b"` is ,1, #597).
/// The string is blank in `code`, so it is read from `source`.
fn empty_pattern(source: &str, code: &str, comments: &str, at: usize) -> bool {
    let skip =
        |i: usize| i + (source[i..].len() - source[i..].trim_start_matches([' ', '\t']).len());
    let (mut i, mut opens) = (skip(at), 0);
    while source[i..].starts_with('(') {
        opens += 1;
        i = skip(i + 1);
    }
    if !source[i..].starts_with("\"\"") || source[i + 2..].starts_with('"') {
        return false;
    }
    i += 2;
    for _ in 0..opens {
        i = skip(i);
        if !source[i..].starts_with(')') {
            return false;
        }
        i += 1;
    }
    operand_ends(code, comments, i)
}

/// Where the next token after `at` starts, past the blanks of its statement
/// (`blank!`): across a line break only into the indented line that continues
/// it. Where the statement ends at a line break, the offset of a line break.
pub(crate) fn past_blanks(text: &str, at: usize) -> usize {
    at + re!(concat!("^", blank!(), "*"))
        .find(&text[at..])
        .map_or(0, |m| m.end())
}

pub(crate) fn operand_ends(code: &str, comments: &str, at: usize) -> bool {
    // A line break ends the operand unless the next line with code on it is
    // indented, which continues the statement: `where 2` + `  #1b` is
    // `where 2#1b` (#193), and so it is with blank or comment lines between
    // them (#675). Indentation is read in `comments` too: in `code` a string
    // starting a line is blanks and looks indented, but q 5 runs a column-0
    // `"x",1` under `r:1 2 3+1 2` as a statement of its own (#718).
    let next = past_blanks(code, at);
    if code[at..next].contains('\n')
        && comments[past_blanks(comments, at)..].starts_with(['\n', '\r'])
    {
        return true;
    }
    let rest = &code[next..];
    rest.is_empty()
        || rest.starts_with([';', ')', ']', '}', '\n', '\r'])
        || (rest.starts_with(',') && in_qsql_phrase(code, at))
        // A keyword ends the from phrase too: `from t where a>0` (#696).
        || (re!(r"^(?:from|by|where)(?:[^A-Za-z0-9_.]|$)").is_match(rest)
            && qsql_phrase(code, at, false))
}

/// Whether `at` sits at the top level of a select, exec, update or delete
/// phrase: walking back through its statement - to a `;`, an opening
/// bracket or an unindented line - meets the keyword at the same depth.
pub(crate) fn in_qsql_phrase(code: &str, at: usize) -> bool {
    qsql_phrase(code, at, true)
}

/// `in_qsql_phrase`, where `joins` says whether the from phrase is refused:
/// a `,` there joins tables, but a keyword after it still ends the operand.
pub(crate) fn qsql_phrase(code: &str, at: usize, joins: bool) -> bool {
    // Each `,` of a where phrase asks this again, and every walk back to the
    // keyword passed all the conditions before it (#707). So the answer from
    // each top-level `,` passed is kept, for the length of the lint, for the
    // next walk to stop at - only in the text `MatchScope` holds unchanged.
    let cached = in_match_table(code);
    let base = code.as_ptr() as usize;
    let mut passed = vec![];
    let found = qsql_walk(code, at, joins, |i, seen_where| {
        let key = (base, base + i, joins, seen_where);
        let hit = PHRASES.with(|p| p.borrow().get(&key).copied());
        if hit.is_none() && cached {
            passed.push(key);
        }
        hit.filter(|_| cached)
    });
    if !passed.is_empty() {
        PHRASES.with(|p| {
            p.borrow_mut()
                .extend(passed.into_iter().map(|k| (k, found)))
        });
    }
    found
}

fn qsql_walk(
    code: &str,
    at: usize,
    joins: bool,
    mut known: impl FnMut(usize, bool) -> Option<bool>,
) -> bool {
    let b = code.as_bytes();
    let mut depth = 0i32;
    let mut seen_where = false;
    let mut i = at;
    while i > 0 {
        i -= 1;
        match b[i] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            b';' if depth == 0 => return false,
            b'\n' if depth == 0 && !code[i + 1..].starts_with([' ', '\t']) => return false,
            b',' if depth == 0 => {
                if let Some(found) = known(i, seen_where) {
                    return found;
                }
            }
            _ => {}
        }
        if depth != 0 || !b[i].is_ascii_lowercase() || !boundary(code, i) {
            continue;
        }
        let word = |w: &str| {
            code[i..].starts_with(w)
                && !code[i + w.len()..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
        };
        // In the where phrase a `,` separates conditions; in the from
        // phrase it joins - `select from t,u` - so that phrase is not one.
        if word("where") {
            seen_where = true;
        } else if joins && word("from") && !seen_where {
            return false;
        } else if ["select", "exec", "update", "delete"].into_iter().any(word) {
            return true;
        }
    }
    false
}
/// Whether `at` is inside a select, exec, update or delete: walking back
/// through its statement, across the indented lines that continue it and out
/// of any parenthesis or bracket around it, meets the keyword. A `;` ends the
/// statement unless a bracket it sits in is crossed later, and a lambda's
/// `{` ends it, since a name in a lambda is the lambda's: `r:select from t`
/// with `  where return>0.15` reads the column, and `r:select from t;` then
/// `f:{[x] return x}` does not (#680).
fn in_query(code: &str, at: usize) -> bool {
    let b = code.as_bytes();
    let (mut depth, mut ended) = (0i32, false);
    let mut i = at;
    while i > 0 {
        i -= 1;
        match b[i] {
            b')' | b']' | b'}' => depth += 1,
            b'{' if depth == 0 => return false,
            b'(' | b'[' if depth == 0 => ended = false,
            b'(' | b'[' | b'{' => depth -= 1,
            b';' if depth == 0 => ended = true,
            b'\n' if !code[i + 1..].starts_with([' ', '\t', '\r', '\n']) => return false,
            _ => {}
        }
        if depth == 0
            && !ended
            && b[i].is_ascii_lowercase()
            && boundary(code, i)
            && re!(r"^(?:select|exec|update|delete)\b").is_match(&code[i..])
        {
            return true;
        }
    }
    false
}
fn blank(b: &mut [u8]) {
    for c in b {
        if !matches!(*c, b'\n' | b'\r') {
            *c = b' ';
        }
    }
}
/// A filter phrase with parenthesised groups blanked out. The questions the
/// filter rules ask - which operators sit beside which - are about the
/// Whether the `$[...]` at `at` (masked code) is a
/// statement whose value nothing takes: it starts a statement at the root, in
/// a lambda or in the body of `if`, `do` or `while`, and a `;`, the body's
/// `]` or - at the root - the end of the line follows it. The last statement
/// of a lambda is its value.
fn value_discarded(code: &str, at: usize) -> bool {
    let bytes = code.as_bytes();
    // One past the `]`.
    let Some(end) = matching(code, at + 1, b'[', b']') else {
        return false;
    };
    // The innermost bracket open around `at`.
    let mut depth = 0i32;
    let mut open = None;
    for (i, b) in bytes[..at].iter().enumerate().rev() {
        match b {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth == 0 => {
                open = Some(i);
                break;
            }
            b'(' | b'[' | b'{' => depth -= 1,
            _ => {}
        }
    }
    let before = code[..at].trim_end_matches([' ', '\t']);
    let line_start = before.is_empty() || before.ends_with('\n');
    let after = code[end..].trim_start_matches([' ', '\t']);
    match open {
        None => {
            (line_start || before.ends_with(';'))
                && (after.is_empty() || after.starts_with([';', '\n', '\r']))
        }
        // Inside brackets a line break is only whitespace (q 5).
        Some(o) if bytes[o] == b'{' => {
            let head = code[..at].trim_end();
            // The first statement follows the `{` or the signature.
            let signature = bytes.get(o + 1) == Some(&b'[')
                && matching(code, o + 1, b'[', b']') == Some(head.len());
            (head.ends_with([';', '{']) || signature) && after.trim_start().starts_with(';')
        }
        Some(o) if bytes[o] == b'[' => {
            re!(r"(?:^|[^A-Za-z0-9_.])(?:if|do|while)\s*$").is_match(&code[..o])
                && code[..at].trim_end().ends_with(';')
                && after.trim_start().starts_with([';', ']'])
        }
        _ => false,
    }
}
/// The `{` of the innermost lambda around `at`, in masked code.
pub(crate) fn enclosing_brace(code: &str, at: usize) -> Option<usize> {
    // From the installed table where there is one: walking back to the brace
    // made each call linear in the body, and a long body quadratic (#708).
    if let Some(found) = brace_chain(code, at, |end| end.is_none_or(|end| end > at)) {
        return found.first().copied();
    }
    let mut depth = 0i32;
    for (i, b) in code.as_bytes()[..at].iter().enumerate().rev() {
        match b {
            b'}' => depth += 1,
            b'{' if depth == 0 => return Some(i),
            b'{' => depth -= 1,
            _ => {}
        }
    }
    None
}
/// A lambda body with any lambda nested in it blanked, so a name read there
/// is not taken for one read here. Same length as `body`.
fn top_level(body: &str) -> String {
    let mut depth = 0i32;
    let mut out = body.as_bytes().to_vec();
    for byte in &mut out {
        let nested = match *byte {
            b'{' => {
                depth += 1;
                true
            }
            b'}' => {
                depth -= 1;
                true
            }
            _ => depth > 0,
        };
        if nested {
            *byte = b' ';
        }
    }
    // Whole characters are blanked or kept, so this stays UTF-8.
    String::from_utf8(out).unwrap_or_default()
}
/// Levenshtein distance, for a name one typo away from another.
fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let next = (prev + usize::from(ca != *cb))
                .min(row[j] + 1)
                .min(row[j + 1] + 1);
            prev = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}
/// Every expression q reads on its own: a statement, and each
/// `;`-separated slot of a bracket, parenthesis or lambda, at every depth. A
/// top-level statement ends at a newline the next line does not continue by
/// indenting; inside a bracket a newline is nothing to q. Each comes as its
/// own text - a nested group kept as its two brackets and nothing between,
/// as `flat_filter` would blank it - beside the offset into `code` of each
/// byte, and where it starts. One pass, so a deep nest costs no more than a
/// flat file.
fn bare_segments(code: &str, source: &str) -> Vec<(usize, String, Vec<usize>)> {
    let b = code.as_bytes();
    let src = source.as_bytes();
    let mut out = vec![];
    // Each open group: where it starts, its own bytes and their offsets.
    let mut frames: Vec<(usize, Vec<u8>, Vec<usize>)> = vec![(0, vec![], vec![])];
    let emit = |frame: (usize, Vec<u8>, Vec<usize>), out: &mut Vec<_>| {
        if let Ok(text) = String::from_utf8(frame.1)
            && !text.trim().is_empty()
        {
            out.push((frame.0, text, frame.2));
        }
    };
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'(' | b'[' | b'{' => {
                let top = frames.last_mut().unwrap();
                top.1.push(c);
                top.2.push(i);
                frames.push((i + 1, vec![], vec![]));
            }
            b')' | b']' | b'}' if frames.len() > 1 => {
                emit(frames.pop().unwrap(), &mut out);
                let top = frames.last_mut().unwrap();
                top.1.push(c);
                top.2.push(i);
            }
            b';' => {
                let done = std::mem::replace(frames.last_mut().unwrap(), (i + 1, vec![], vec![]));
                emit(done, &mut out);
            }
            b'\n' if frames.len() == 1 && !matches!(src.get(i + 1), Some(b' ' | b'\t')) => {
                emit(
                    std::mem::replace(&mut frames[0], (i + 1, vec![], vec![])),
                    &mut out,
                );
            }
            _ => {
                let top = frames.last_mut().unwrap();
                top.1.push(c);
                top.2.push(i);
            }
        }
    }
    for frame in frames {
        emit(frame, &mut out);
    }
    out
}
/// QB006's logic: the words only. `&` and `|` read the same way, but they
/// are min and max as often as and and or, and there the right-to-left
/// reading is the point: `n>=4|.00002*count text`, `0<x&y`.
static LOGIC: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b(?:and|or)\b").unwrap());
/// A comparison to the left of one: the glyphs, and the words applied infix.
/// q 5 `where a in 1 3 and b=0` is `a in (1 3 and b=0)` too (#735).
static COMPARISON: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"[<>=~]|\b(?:in|within|like)(?:[^A-Za-z0-9_.\[]|$)").unwrap()
});
/// Whether a comparison sits left of an `and`/`or` in `clause`, one bracket
/// depth flattened: QB006's trap. A symbol is no word - `` `in`or `` names
/// two symbols - and an iterated `and/:\:` or `or'` is a derived function
/// someone applied on purpose, so neither counts.
fn comparison_swallowed(clause: &str) -> bool {
    let clause =
        re!(r"`[\w.:/]*").replace_all(clause, |m: &regex::Captures| " ".repeat(m[0].len()));
    LOGIC
        .find_iter(&clause)
        .find(|logic| !clause[logic.end()..].starts_with(['\'', '/', '\\']))
        .is_some_and(|logic| COMPARISON.is_match(&clause[..logic.start()]))
}
/// The comparisons in a where phrase that an `and`/`or` to their right
/// swallows, as byte ranges into `flat` - a phrase `flat_filter` has
/// flattened. Each is an operand left of an `and`/`or` in its clause; q reads
/// `a=1 and b=0` as `a=(1 and b=0)`, so parenthesising every such operand is
/// what the author meant. The last operand of a clause is never swallowed.
pub(crate) fn swallowed_comparisons(flat: &str) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut clause_start = 0;
    for clause in flat.split(',') {
        let mut from = 0;
        for logic in LOGIC.find_iter(clause) {
            let operand = &clause[from..logic.start()];
            if COMPARISON.is_match(operand) {
                let lead = operand.len() - operand.trim_start().len();
                let start = clause_start + from + lead;
                out.push((start, start + operand.trim().len()));
            }
            from = logic.end();
        }
        clause_start += clause.len() + 1;
    }
    out
}
/// top level only, and `(a=1) and b=0` is correct q that must stay quiet.
/// A lambda is a group too: `where {x[`b]~2} each d` matches per row.
pub(crate) fn flat_filter(phrase: &str) -> String {
    let b = phrase.as_bytes();
    let mut flat = b.to_vec();
    let (mut depth, mut i) = (0i32, 0usize);
    while i < b.len() {
        match b[i] {
            b'(' | b'[' | b'{' => {
                depth += 1;
                flat[i] = b' ';
            }
            b')' | b']' | b'}' => {
                depth -= 1;
                flat[i] = b' ';
            }
            _ if depth > 0 => flat[i] = b' ',
            _ => {}
        }
        i += 1;
    }
    String::from_utf8(flat).unwrap()
}
/// `flat_filter` with each blanked bracket and its text filled with `_`
/// rather than blanks, so an operand's extent keeps them: `a=f[b;b] and b=0`
/// groups as `(a=f[b;b])`, not `(a=f)[b;b]` (#405). A group still hides its
/// own `and`/`or` and comparisons, now as `_`.
fn grouped(phrase: &str) -> String {
    let filled = flat_filter(phrase)
        .bytes()
        .zip(phrase.bytes())
        .map(|(f, p)| if f != p && p != b' ' { b'_' } else { f })
        .collect();
    String::from_utf8(filled).unwrap()
}
/// Whether `before` ends in a character that would fuse with a token
/// written straight after it: `a` and `b` are `ab`, `1` and `b` are `1b`.
/// A symbol ending in `:` or `/` is one: `` `:db/ `` and `t` are `` `:db/t ``,
/// and `` `a: `` and `k` are `` `a:k `` (#776).
fn ends_in_token(before: &str) -> bool {
    let line = &before[before.rfind('\n').map_or(0, |p| p + 1)..];
    before.ends_with(|c: char| c.is_ascii_alphanumeric() || "_.`\")]}".contains(c))
        || re!(r"`(?::[A-Za-z0-9_.:/]*|[A-Za-z0-9_.][A-Za-z0-9_.:]*)$").is_match(line)
}
/// Whether `before`, less trailing blanks, ends in a numeric literal: a
/// token of letters, digits, `.` and `:` that begins with a digit or `.5`,
/// so `10 20 30` and `12:00` do, and the name `x1` does not.
fn ends_in_number(before: &str) -> bool {
    let t = before.trim_end_matches([' ', '\t']);
    // A line break into an indented line is a blank too: q joins the two,
    // so `10 20 30` over `  0 2` is one vector (#774).
    let t = if t.len() < before.len() && t.ends_with('\n') {
        t.trim_end()
    } else {
        t
    };
    let start = t
        .char_indices()
        .rfind(|&(_, c)| !(c.is_ascii_alphanumeric() || "._:".contains(c)))
        .map_or(0, |(i, c)| i + c.len_utf8());
    let token = &t[start..];
    !t[..start].ends_with('`') && starts_number(token, false)
}
/// Whether `after`, less leading blanks, opens a numeric literal - `-1`
/// included where a blank comes first (`blank` says one ends the text
/// before), since `1 -1` is a vector and `1-1` a subtraction.
fn starts_number(after: &str, blank: bool) -> bool {
    let t = refusals::continued(after);
    let blank = blank || t.len() < after.len();
    let t = match t.strip_prefix('-') {
        Some(rest) if blank => rest,
        _ => t,
    };
    let mut c = t.chars();
    match c.next() {
        Some(d) if d.is_ascii_digit() => true,
        Some('.') => c.next().is_some_and(|d| d.is_ascii_digit()),
        _ => false,
    }
}
/// Where the where phrase that starts at `from` in masked `code` ends: at a
/// `;` outside brackets, or the bracket that closes around it.
fn phrase_end(code: &str, from: usize) -> usize {
    let mut depth = 0i32;
    for (i, b) in code.bytes().enumerate().skip(from) {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth == 0 => return i,
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth == 0 => return i,
            _ => {}
        }
    }
    code.len()
}
/// Where the number q's tokenizer reads from `at` ends: `text[at..]` starts
/// with a digit, or a point and a digit. It runs on over letters, digits,
/// points and a colon before a digit, and takes a sign only as q does (`-4!`
/// on KDB-X 5): a `-` straight after a lower-case `e` always (`1e-3`, and
/// `1e-` and `1e-y` too), a `+` there only before a digit (`1e+x` is `1e`,
/// `+`, `x`), and none after an upper-case `E` - `1E-3` is `1E`, `-`, `3`
/// (#2057, #2099). The regex patterns that scan a number spell its sign the
/// same way, `e-|e\+\d`.
pub(crate) fn number_end(text: &str, at: usize) -> usize {
    re!(r"^\.?\d(?:e-|e\+\d|:\d|[0-9A-Za-z.])*")
        .find(&text[at..])
        .map_or(at, |m| at + m.end())
}
/// Whether the `+` or `-` at `i` is part of the number written before it:
/// its exponent's sign, as `number_end` reads one. The token is read from the
/// start of the run of letters, digits, points and colons it ends, left to
/// right as q reads it: in `c3:1e-y` the run holds the name `c3`, the `:`
/// and the number `1e-y`.
fn in_number(text: &str, i: usize) -> bool {
    let b = text.as_bytes();
    let mut p = b[..i]
        .iter()
        .rposition(|c| !(c.is_ascii_alphanumeric() || b"._:".contains(c)))
        .map_or(0, |p| p + 1);
    if p > 0 && b[p - 1] == b'`' {
        return false;
    }
    while p < i {
        let c = b[p];
        if c.is_ascii_digit() || c == b'.' && b.get(p + 1).is_some_and(u8::is_ascii_digit) {
            let end = number_end(text, p);
            if end > i {
                return true;
            }
            p = end;
        } else if c.is_ascii_alphabetic() {
            p += b[p..i]
                .iter()
                .take_while(|c| c.is_ascii_alphanumeric() || b"._".contains(c))
                .count();
        } else {
            p += 1;
        }
    }
    false
}
/// Whether a top-level statement mixes `*`/`%` with a binary `+`/`-` - the
/// pair whose right-to-left order readers most often get wrong. A `-` is
/// binary only when it does not introduce a token: `a -b` applies `a` to
/// `-b`, while `a-b`, `a- b` and `a - b` are subtraction. Braces and `;`
/// start fresh statements rather than nesting, so a lambda body on one line
/// is still checked.
/// The `*`/`%` and `+`/`-` operators of `line`, as runs of one expression
/// each - each operator with its offset and whether it multiplies. A `;`, a
/// brace or a `,` ends a run, and a bracket holds runs of its own: in
/// `(a*b)+c` the `*` and the `+` are never in one run, while `(a*b+c)`,
/// `f[a*b+c]` and `r:a*b+c;` each hold one that mixes (#511). A `+`/`-`
/// counts only after an operand, and not as the sign of a literal.
///
/// A qSQL template holds an expression in each phrase, so the word that
/// closes a phrase ends a run as well: `by` and `from` after the template's
/// first word, and `where` after its `from`. In `select a*b from t where
/// c+d` nothing is mixed (#847). Only a template that opens on this line is
/// seen; anywhere else the three are names, or `where` the function.
fn infix_runs(line: &str) -> Vec<Vec<(usize, bool)>> {
    let b = line.as_bytes();
    let mut runs = vec![];
    // The run open at each bracket level, the outermost first, and beside it
    // the phrase of the template open there.
    let mut open: Vec<Vec<(usize, bool)>> = vec![vec![]];
    let mut phrase: Vec<Option<&str>> = vec![None];
    // A symbol may spell a qSQL word; blanking them is put off until a word
    // is met.
    let mut words: Option<String> = None;
    let mut prev = b'\0';
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'(' | b'[' => {
                open.push(vec![]);
                phrase.push(None);
            }
            // A bracket opened on an earlier line closes the run it held.
            b')' | b']' => runs.push(if open.len() > 1 {
                phrase.pop();
                open.pop().unwrap()
            } else {
                phrase[0] = None;
                std::mem::take(&mut open[0])
            }),
            b'{' | b'}' | b';' => {
                runs.push(std::mem::take(open.last_mut().unwrap()));
                *phrase.last_mut().unwrap() = None;
            }
            b',' => runs.push(std::mem::take(open.last_mut().unwrap())),
            b'b' | b'd' | b'e' | b'f' | b's' | b'u' | b'w' if query_word(line, i).is_some() => {
                let word = query_word(words.get_or_insert_with(|| unsymbolled(line)), i);
                let at = phrase.last_mut().unwrap();
                let next = match (*at, word) {
                    (_, Some(head @ ("select" | "exec" | "update" | "delete"))) => Some(head),
                    (Some("from"), Some("where")) => Some("where"),
                    (Some("select" | "exec" | "update" | "delete" | "by"), Some("where")) => *at,
                    (Some("select" | "exec" | "update" | "delete" | "by"), Some(closes)) => {
                        Some(closes)
                    }
                    _ => *at,
                };
                if next != *at && !matches!(next, Some("select" | "exec" | "update" | "delete")) {
                    runs.push(std::mem::take(open.last_mut().unwrap()));
                }
                *at = next;
            }
            b'*' | b'%' => open.last_mut().unwrap().push((i, true)),
            b'+' | b'-' => {
                let operand = matches!(
                    prev,
                    b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b')' | b']' | b'.'
                );
                // After a space and before a digit, `-` is the sign of a
                // literal: `2*3 -1` is `6 -2`, a vector and no subtraction.
                let spaced = i > 0 && b[i - 1].is_ascii_whitespace();
                let digit = |at: usize| b.get(at).is_some_and(u8::is_ascii_digit);
                let introduces = c == b'-'
                    && spaced
                    && (digit(i + 1) || b.get(i + 1) == Some(&b'.') && digit(i + 2));
                // The sign of a float's exponent: `1e-9` is one number, and
                // `1E-9` is three tokens to q (#2099).
                let exponent = in_number(line, i);
                if operand && !introduces && !exponent {
                    open.last_mut().unwrap().push((i, false));
                }
            }
            _ => {}
        }
        if !c.is_ascii_whitespace() {
            prev = c;
        }
    }
    runs.extend(open);
    runs
}
/// Whether a run mixes the two families: a `*` or `%`, and a `+` or `-`.
fn mixes(run: &[(usize, bool)]) -> bool {
    run.iter().any(|o| o.1) && run.iter().any(|o| !o.1)
}
/// Whether a run is the precedence trap, QP005's: some `*` or `%` has a `+`
/// or `-` to its right, which q performs first and school precedence second,
/// so `0.5*bid+ask` is `0.5*(bid+ask)`. A mixed run that is no trap has every
/// `+` and `-` before every `*` and `%`, as `start+step*til n` has: both
/// readings multiply first, and it is QP007's (#847).
fn traps(run: &[(usize, bool)]) -> bool {
    run.iter()
        .position(|o| o.1)
        .is_some_and(|first| run[first..].iter().any(|o| !o.1))
}
/// The top-level statements of a file as byte ranges: a line and the indented
/// lines q continues it with. Shared by the rules that read a statement and
/// the fixes that rewrite one, so both see the same text.
fn statement_groups(code: &str, source: &str) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = vec![];
    let (mut at, mut open) = (0usize, 0i32);
    let lines: Vec<(&str, &str)> = code
        .split_inclusive('\n')
        .zip(source.split_inclusive('\n'))
        .collect();
    // For each line, whether the next line with code on it is indented.
    let mut indented_next = vec![false; lines.len()];
    let mut next = false;
    for (n, &(l, raw)) in lines.iter().enumerate().rev() {
        indented_next[n] = next;
        if !l.trim().is_empty() {
            next = raw.starts_with([' ', '\t']);
        }
    }
    for (n, &(l, raw)) in lines.iter().enumerate() {
        // Indentation is a fact about the source, not about `code`: a
        // comment is blanked to spaces, so a bare `/` reads as indented
        // there and would fold into the line above it, taking the rule
        // that reports it out of reach. Brackets are counted on `code`,
        // where the ones inside strings and comments are already gone.
        //
        // Only the top level folds. Inside a bracket the newlines are
        // already insignificant to q, and the rules below have always
        // read those lines one at a time - folding a table literal or a
        // lambda body into one unit loses findings inside it.
        //
        // A blank or column-0 comment line ends nothing: q 5 reads `a:1+`,
        // a blank line, `  2` as 3. It folds only when an indented line
        // follows it, so a statement's group never takes a comment after it.
        // The next line is the next one with code on it: an indented line
        // inside a block comment continues nothing.
        let continues =
            open == 0 && (raw.starts_with([' ', '\t']) || l.trim().is_empty() && indented_next[n]);
        match out.last_mut() {
            Some(last) if continues => last.1 += l.len(),
            _ => out.push((at, at + l.len())),
        }
        for b in l.bytes() {
            match b {
                b'(' | b'[' | b'{' => open += 1,
                b')' | b']' | b'}' => open -= 1,
                _ => {}
            }
        }
        at += l.len();
    }
    out
}
/// How many items a vector literal written as an argument list holds: a
/// spaced numeric vector, a symbol, boolean or char vector, or `enlist` of
/// one item. `literal` is `arg` with its strings kept. q 5: `{[a;b] a+b} .
/// `a`b`c`, `. 101b` and `. "abc"` are 'rank, and `.[{[a;b] a+b};enlist
/// 1;{x}]` a projection (#630).
fn vector_items(arg: &str, literal: &str) -> Option<usize> {
    let (arg, literal) = (arg.trim(), literal.trim());
    if re!(r"^-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)+$").is_match(arg) {
        Some(arg.split_whitespace().count())
    } else if re!(r"^(?:`[A-Za-z0-9_.:]*){2,}$").is_match(arg) {
        Some(arg.matches('`').count())
    } else if re!(r"^[01]{2,}b$").is_match(arg) {
        Some(arg.len() - 1)
    } else if let Some(body) = literal
        .strip_prefix('"')
        .and_then(|l| l.strip_suffix('"'))
        .filter(|b| !re!(r#"(?:^|[^\\])(?:\\\\)*""#).is_match(b))
    {
        Some(q_bytes(body).len()).filter(|&n| n >= 2)
    } else if re!(r"^enlist\s+[^\s\[]").is_match(arg) {
        Some(1)
    } else {
        None
    }
}
/// The bytes q makes of a string literal's body, the text between its
/// quotes. q strings are bytes, so `"é"` is two items, and an escape is the
/// one byte it stands for: `\n`, `\"`, `\012` (#226).
pub(crate) fn q_bytes(body: &str) -> Vec<u8> {
    let mut out = vec![];
    for m in re!(r"\\[0-7]{3}|\\.|[^\\]").find_iter(body) {
        match m.as_str().strip_prefix('\\') {
            None => out.extend_from_slice(m.as_str().as_bytes()),
            Some(octal) if octal.len() == 3 && octal.bytes().all(|b| b.is_ascii_digit()) => {
                out.push(u32::from_str_radix(octal, 8).unwrap_or(0) as u8)
            }
            Some("n") => out.push(b'\n'),
            Some("t") => out.push(b'\t'),
            Some("r") => out.push(b'\r'),
            Some(other) => out.push(other.as_bytes()[0]),
        }
    }
    out
}
struct Views {
    comments: String,
    code: String,
    unterminated: Option<usize>,
    foreign_offsets: Vec<usize>,
    /// Where a `/`-opened block comment that no later `\` closed began. The
    /// lines after it are blank in both views, so no rule sees them; this is
    /// the only trace that they were swallowed at all.
    open_block: Option<usize>,
    /// Each block comment that does close: where its bare `/` line begins
    /// and where the bare `\` line that ends it does. The outermost only -
    /// one nested inside is part of the comment it is in.
    blocks: Vec<(usize, usize)>,
    /// Where each string literal's opening quote is, in order. A `"` in the
    /// source is one of these, the closing quote of one, an escaped quote, or
    /// part of a comment - and only `views` has followed the text closely
    /// enough to say which.
    string_starts: Vec<usize>,
    /// Where the line that ends the script - a lone `\` outside a block
    /// comment, or `\\` - begins. q reads nothing after it.
    script_end: Option<usize>,
}
impl Views {
    /// Whether `at` is in a block comment: one that closes, from its `/`
    /// line to its `\` line, or the one nothing closes. `blocks` is in
    /// order and holds only the outermost, so they never overlap and a
    /// binary search finds the one that could hold `at`. Asked for each line
    /// of a file, a walk over every block was quadratic in a file of them.
    fn in_block(&self, at: usize) -> bool {
        self.open_block.is_some_and(|open| at >= open)
            || self.blocks[..self.blocks.partition_point(|&(open, _)| open <= at)]
                .last()
                .is_some_and(|&(_, close)| at <= close)
    }
}
/// How much of a source line is a `\t` or `\ts` command, with any `q)`
/// before it, 0 on any other line: these run their argument as q, so after
/// the prefix the line is q (#222).
///
/// A question about the source, not about `code`: `views` blanks the `q)`
/// that q 5 reads `q)\t 1+1` and `q)\l f.q` past (#316), and in `code`
/// such a line looks like an indented one.
///
/// Only a space makes one: q 5 reads `\t<TAB>x` as setting the timer from
/// a non-number ('domain) and `\ts<TAB>x` as the shell command `ts` (#664).
pub(crate) fn timed_prefix(line: &str) -> usize {
    let prompt = if line.starts_with("q)") { 2 } else { 0 };
    re!(r"^\\ts?(?::\d+)? ")
        .find(&line[prompt..])
        .map_or(0, |m| prompt + m.end())
}
/// Whether a statement handed to another language - a `k)` or `p)` line -
/// goes on over `line`, with `rest` the source after it. The one reader of
/// this for the views and for navigation's reading of `k)` lines.
///
/// An indented or blank line continues it. A column-0 comment line ends
/// nothing an indented line continues after it: q 5 hands `t)a`, `/ note`,
/// `  b` to `.t.e` as one statement, and `t)a`, `/ note`, `c:1` as `t)a` and
/// then q (#317). A bare `/` is no comment line but a block comment's
/// opener, and ends the statement: q 5 hands `t)c`, `/`, `  zz`, `\`,
/// `show 1` to `.t.e` as `c` alone and then prints 1 (#2042).
pub(crate) fn foreign_continues(line: &str, rest: &str) -> bool {
    let bare = |l: &str| l.trim_end_matches(['\r', '\n', ' ', '\t']) == "/";
    let comment = |l: &str| l.starts_with('/') && !bare(l);
    line.starts_with([' ', '\t'])
        || line.trim().is_empty()
        || comment(line)
            && rest
                .lines()
                .find(|l| !l.trim().is_empty() && !comment(l))
                .is_some_and(|l| l.starts_with([' ', '\t']))
}
/// The length of the run of language prefixes, `q)` and `k)` as many as
/// are written, that `line` opens with: q reads `q)k)\d .ns` as `\d .ns`
/// (#2194), as the extension's guard does (#2034).
pub(crate) fn language_prefixes(line: &str) -> usize {
    let mut n = 0;
    while line[n..].starts_with("q)") || line[n..].starts_with("k)") {
        n += 2;
    }
    n
}
/// Whether a source line is a system command whose argument is no q: any
/// but `\t` and `\ts`, with or without language prefixes before it.
pub(crate) fn system_command(line: &str) -> bool {
    line[language_prefixes(line)..].starts_with('\\') && timed_prefix(line) == 0
}
/// A `q)` prompt is blank in the views, so its line would read as the
/// indented continuation of the one before. It starts a statement, so the
/// rules see a `;` in its place: q 5 runs `q)a:2.5` and then refuses
/// `q)r:string a 0` with 'type (#585). A `q)\` command is read as a command
/// already, and keeps its blank.
fn prompts_start_statements(source: &str, v: &mut Views) {
    let mut at = 0;
    for line in source.split_inclusive('\n') {
        if line.starts_with("q)")
            && !line[language_prefixes(line)..].starts_with('\\')
            && v.code.as_bytes().get(at) == Some(&b' ')
        {
            v.code.replace_range(at..at + 1, ";");
            v.comments.replace_range(at..at + 1, ";");
        }
        at += line.len();
    }
}
fn views(source: &str) -> Views {
    // A BOM is QE005's to report; the rest of the file is read as q would
    // read it without one, so `<BOM>/ note` is still a comment line (#221).
    if let Some(body) = source.strip_prefix('\u{feff}') {
        let n = source.len() - body.len();
        let mut v = views(body);
        v.comments.insert(0, '\u{feff}');
        v.code.insert(0, '\u{feff}');
        let shift = |at: &mut usize| *at += n;
        v.unterminated.iter_mut().for_each(shift);
        v.foreign_offsets.iter_mut().for_each(shift);
        v.open_block.iter_mut().for_each(shift);
        v.blocks.iter_mut().for_each(|(open, close)| {
            *open += n;
            *close += n;
        });
        v.string_starts.iter_mut().for_each(shift);
        v.script_end.iter_mut().for_each(shift);
        return v;
    }
    let bytes = source.as_bytes();
    let mut comments = bytes.to_vec();
    let mut code = bytes.to_vec();
    let (mut string, mut block, mut ended, mut offset) = (None, 0usize, false, 0);
    let mut foreign = false;
    let mut foreign_offsets = Vec::new();
    let mut open_block = None;
    let mut blocks = Vec::new();
    let mut script_end = None;
    let mut string_starts = Vec::new();
    let mut unterminated = None;
    // Before the first statement, an indented line continues nothing, and q
    // drops it: q 5 loads `/ c` + `  b:1`, `/ c` + blank + `  b:1`,
    // `\d .foo` + `  b:1` and a file starting `  b:1` all leaving b
    // undefined. Comments, blank lines and system commands are not
    // statements, so none of them ends that stretch.
    let mut statement = false;
    // q skips a first line that starts `#!`, the interpreter line of an
    // executable script: q 5 loads `#!/usr/bin/env q` + `show 1` and prints
    // 1. Only the first - a later one is refused with '# (#314).
    if source.starts_with("#!") {
        offset = source.find('\n').map_or(source.len(), |p| p + 1);
        blank(&mut comments[..offset]);
        blank(&mut code[..offset]);
    }
    for line in source[offset..].split_inclusive('\n') {
        let end = offset + line.len();
        let stripped = line.trim_end_matches(['\r', '\n', ' ', '\t']);
        // A string runs on over indented and blank lines only. A line at
        // column 0 starts a statement, so q 5 refuses `s:"abc` + `def"` with
        // '" - and the lambda around such a string with '{ - and reads that
        // line as code.
        if string.is_some() && !stripped.is_empty() && !line.starts_with([' ', '\t']) {
            unterminated = unterminated.or(string.take());
        }
        if !ended && block == 0 && string.is_none() && !statement {
            if line.starts_with([' ', '\t']) && !stripped.trim().is_empty() {
                blank(&mut comments[offset..end]);
                blank(&mut code[offset..end]);
                offset = end;
                continue;
            }
            statement = !stripped.is_empty() && !line.starts_with(['\\', '/', ' ', '\t']);
        }
        if foreign && !foreign_continues(line, &source[end..]) {
            foreign = false;
        }
        if !ended && block == 0 && string.is_none() {
            // Any `x)` line is another language: q hands it to `.x.e`, which
            // is how `p)` reaches embedPy and `k)` reaches k, and a test
            // harness may define `.t.e` for `t)`. `q)` is q itself, and its
            // prefix is stripped below instead.
            let b = line.as_bytes();
            if b.len() >= 2 && b[0].is_ascii_lowercase() && b[0] != b'q' && b[1] == b')' {
                foreign = true;
            }
            if foreign {
                blank(&mut comments[offset..end]);
                blank(&mut code[offset..end]);
                foreign_offsets.push(offset);
                offset = end;
                continue;
            }
        }
        // A command after a run of prefixes is the command, as q reads
        // `q)k)\d .ns` (#2194).
        let prefix = if string.is_none() && line.starts_with("q)") {
            let run = language_prefixes(line);
            if line[run..].starts_with('\\') {
                run
            } else {
                2
            }
        } else {
            0
        };
        // `\t` and `\ts` run their argument as q, so its strings and its
        // comment are masked as on any other line (#222); the command itself
        // stays, for the rules that read system commands.
        let timed = if string.is_none() {
            timed_prefix(line)
        } else {
            0
        };
        // q reads `q)\l f.q` as `\l f.q` (#316), and `q)k)\l f.q` too.
        let command = string.is_none() && line[prefix..].starts_with('\\');
        // q appends an indented line to the command before it, so after any
        // command but `\t` the lines that follow are its argument, not q:
        // `\d .foo` + `  b:1` defines no `b` anywhere (#223).
        if !ended && block == 0 && command {
            statement = timed > 0;
        }
        if ended || block > 0 {
            blank(&mut comments[offset..end]);
            blank(&mut code[offset..end]);
            // Block comments nest: inside one, a bare `/` opens another and
            // a bare `\` closes the innermost. q 5 loads `/`,`/`,`\`,`f:..`,
            // `\`,`g:..` as g alone. `/ x` is a comment line and nests nothing.
            if block > 0 && stripped == "/" {
                block += 1;
            } else if block > 0 && stripped == "\\" {
                block -= 1;
                if block == 0 {
                    blocks.extend(open_block.take().map(|open| (open, offset)));
                }
            }
        } else if string.is_none()
            && (matches!(stripped, "/" | "\\" | "\\\\")
                || re!(r"^(?:q\))?\\\\(?:[ \t]|$)").is_match(stripped))
        {
            // `\\` exits q, so a script ends there as it does at a lone `\`
            // - whatever follows it past a blank: q 5 stops at `\\ / bye`
            // and `\\ 3` (#322), and runs on past `\ / end`. With a `q)`
            // prefix too: q 5 stops at `q)\\` (#584), though `q)\` and `q)/`
            // end nothing.
            block = usize::from(stripped == "/");
            ended = stripped != "/";
            if ended {
                script_end = Some(offset);
            }
            if block > 0 {
                open_block = Some(offset);
            }
            blank(&mut comments[offset..end]);
            blank(&mut code[offset..end]);
        } else if timed == 0 && command {
            // Any other command's argument is no q: a path, a name, or text
            // for the shell. Only what the rules read of it is kept - the
            // command, and the namespace or file of `\d` and `\l`.
            let kept = prefix
                + re!(r"^\\(?:[dl][ \t]+[^ \t\r\n]*|[^ \t\r\n]*)")
                    .find(&line[prefix..])
                    .map_or(0, |m| m.end());
            blank(&mut comments[offset..offset + prefix]);
            blank(&mut code[offset..offset + prefix]);
            blank(&mut comments[offset + kept..end]);
            blank(&mut code[offset + kept..end]);
        } else {
            blank(&mut comments[offset..offset + prefix]);
            blank(&mut code[offset..offset + prefix]);
            let mut i = offset + prefix.max(timed);
            while i < end {
                let c = bytes[i];
                if string.is_some() {
                    blank(&mut code[i..i + 1]);
                    if c == b'\\' && i + 1 < end {
                        blank(&mut code[i + 1..i + 2]);
                        i += 2;
                        continue;
                    }
                    if c == b'"' {
                        string = None;
                    }
                } else if c == b'"' {
                    string = Some(i);
                    string_starts.push(i);
                    code[i] = b' ';
                } else if c == b'/'
                    && (i == offset + prefix
                        || source[..i]
                            .chars()
                            .next_back()
                            .is_some_and(char::is_whitespace))
                {
                    blank(&mut comments[i..end]);
                    blank(&mut code[i..end]);
                    break;
                }
                i += 1;
            }
        }
        offset = end;
    }
    Views {
        comments: String::from_utf8(comments).unwrap(),
        code: String::from_utf8(code).unwrap(),
        unterminated: unterminated.or(string),
        foreign_offsets,
        open_block,
        blocks,
        string_starts,
        script_end,
    }
}
/// Every bracket's match in one text, computed once in a single stack pass.
///
/// Rules call `matching` from every `{`, `[` and `(` they look at, and many
/// of them from every one in the file; done by scanning, that is time
/// quadratic in nesting depth. `lint` installs one of these for `code` for
/// the length of the lint, and `matching` answers from it for that text and
/// any slice of it, falling back to the scan for any other text (#185).
struct MatchTable {
    start: usize,
    len: usize,
    /// For each position: where the group opened there ends, `NO_MATCH` if
    /// it never closes, or `NOT_OPEN` if the position opens no group as
    /// `matching` would read it from there.
    ends: Vec<u32>,
    /// Each `{` in order, with the index in this list of the `{` it opened
    /// inside, `NO_MATCH` at the top level: the lambdas around a position
    /// are found by climbing from the last one before it (#705).
    braces: Vec<(u32, u32)>,
    /// The bracket depth after each bracket, counting every kind as one, as
    /// `slots` does, and each `;` by the depth it sits at: a slice's slots
    /// are then the `;`s at its own depth, found by binary search rather
    /// than by reading through every bracket nested in it (#710).
    depths: Vec<(u32, i32)>,
    semicolons: std::collections::HashMap<i32, Vec<u32>>,
}

const NO_MATCH: u32 = u32::MAX;
const NOT_OPEN: u32 = u32::MAX - 1;

thread_local! {
    static MATCHES: std::cell::RefCell<Option<std::rc::Rc<MatchTable>>> =
        const { std::cell::RefCell::new(None) };
    /// `qsql_phrase`'s answers from each top-level `,` it walked back past,
    /// by the address of the text walked and of the `,`, whether it refused
    /// joins and whether it had passed a `where`. Emptied with the table.
    static PHRASES: std::cell::RefCell<
        std::collections::HashMap<(usize, usize, bool, bool), bool>,
    > = std::cell::RefCell::new(Default::default());
}

/// Whether `s` is the text of the installed `MatchTable` or a slice of it.
fn in_match_table(s: &str) -> bool {
    MATCHES.with(|m| {
        m.borrow().as_ref().is_some_and(|t| {
            let at = s.as_ptr() as usize;
            at >= t.start && at + s.len() <= t.start + t.len
        })
    })
}

/// Keeps a `MatchTable` installed for as long as it lives, restoring
/// whatever was installed before when it drops.
pub(crate) struct MatchScope(Option<std::rc::Rc<MatchTable>>);

impl MatchScope {
    /// Installs the table for `text`. The caller keeps `text` alive and
    /// unchanged while the scope lives - `matching` recognises the text by
    /// its address.
    pub(crate) fn install(text: &str) -> MatchScope {
        let b = text.as_bytes();
        let mut ends = vec![NOT_OPEN; b.len()];
        let mut braces = vec![];
        let (mut depths, mut semicolons) = (vec![], std::collections::HashMap::new());
        // Applicable only below u32 offsets; a larger text keeps scanning.
        if b.len() < NOT_OPEN as usize {
            let mut stacks: [Vec<usize>; 3] = [vec![], vec![], vec![]];
            let mut open_braces: Vec<u32> = vec![];
            let mut depth = 0i32;
            for (i, &c) in b.iter().enumerate() {
                match c {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => depth -= 1,
                    b';' => {
                        semicolons
                            .entry(depth)
                            .or_insert_with(Vec::new)
                            .push(i as u32);
                        continue;
                    }
                    _ => continue,
                }
                depths.push((i as u32, depth));
            }
            let mut i = 0;
            // The same walk `matching` makes, so a position it reads as
            // outside a string is one this reads as outside a string too: from
            // there on the two walks are in the same state and agree.
            while i < b.len() {
                match b[i] {
                    b'"' => {
                        i += 1;
                        while i < b.len() && b[i] != b'"' {
                            i += if b[i] == b'\\' { 2 } else { 1 };
                        }
                    }
                    c @ (b'{' | b'[' | b'(') => {
                        ends[i] = NO_MATCH;
                        stacks[bracket_kind(c)].push(i);
                        if c == b'{' {
                            braces.push((i as u32, *open_braces.last().unwrap_or(&NO_MATCH)));
                            open_braces.push(braces.len() as u32 - 1);
                        }
                    }
                    c @ (b'}' | b']' | b')') => {
                        if let Some(o) = stacks[bracket_kind(c)].pop() {
                            ends[o] = (i + 1) as u32;
                        }
                        if c == b'}' {
                            open_braces.pop();
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
        }
        let table = std::rc::Rc::new(MatchTable {
            start: text.as_ptr() as usize,
            len: text.len(),
            ends,
            braces,
            depths,
            semicolons,
        });
        PHRASES.with(|p| p.borrow_mut().clear());
        MatchScope(MATCHES.with(|m| m.replace(Some(table))))
    }
}

impl Drop for MatchScope {
    fn drop(&mut self) {
        let previous = self.0.take();
        PHRASES.with(|p| p.borrow_mut().clear());
        MATCHES.with(|m| *m.borrow_mut() = previous);
    }
}

fn bracket_kind(c: u8) -> usize {
    match c {
        b'{' | b'}' => 0,
        b'[' | b']' => 1,
        _ => 2,
    }
}

/// Every `{` before `at` in `s` whose lambda closes after `at`, innermost
/// first, from the installed table when `s` is its text. `None` means "not
/// answerable here".
fn enclosing_braces(s: &str, at: usize) -> Option<Vec<usize>> {
    brace_chain(s, at, |end| end.is_some_and(|end| end > at))
}

/// Each `{` before `at` that `keep` accepts by where it closes, innermost
/// first: the braces still open at `at`, and closed ones on the way out to
/// them. From the installed table when `s` is its text, `None` otherwise.
fn brace_chain(s: &str, at: usize, keep: impl Fn(Option<usize>) -> bool) -> Option<Vec<usize>> {
    MATCHES.with(|m| {
        let m = m.borrow();
        let t = m.as_ref()?;
        if s.as_ptr() as usize != t.start || s.len() != t.len {
            return None;
        }
        let mut out = vec![];
        let i = t.braces.partition_point(|&(open, _)| (open as usize) < at);
        let mut next = if i == 0 { NO_MATCH } else { i as u32 - 1 };
        while next != NO_MATCH {
            let (open, parent) = t.braces[next as usize];
            let end = t.ends[open as usize];
            if keep((end != NO_MATCH).then_some(end as usize)) {
                out.push(open as usize);
            }
            next = parent;
        }
        Some(out)
    })
}

/// Where `slots` cuts `s`, from the installed table when `s` is a slice of
/// its text: each `;` in it at the depth it starts at.
fn slot_cuts(s: &str) -> Option<Vec<usize>> {
    MATCHES.with(|m| {
        let m = m.borrow();
        let t = m.as_ref()?;
        let at = s.as_ptr() as usize;
        if at < t.start || at + s.len() > t.start + t.len || t.len >= NOT_OPEN as usize {
            return None;
        }
        let (from, to) = (at - t.start, at - t.start + s.len());
        let i = t.depths.partition_point(|&(p, _)| (p as usize) < from);
        let depth = if i == 0 { 0 } else { t.depths[i - 1].1 };
        let Some(list) = t.semicolons.get(&depth) else {
            return Some(vec![]);
        };
        let first = list.partition_point(|&p| (p as usize) < from);
        Some(
            list[first..]
                .iter()
                .map(|&p| p as usize)
                .take_while(|&p| p < to)
                .map(|p| p - from)
                .collect(),
        )
    })
}

/// `matching` from the installed table, when `s` is a slice of its text and
/// `start` opens a group of `open` there. `None` means "not answerable here".
fn matching_from_table(s: &str, start: usize, open: u8) -> Option<Option<usize>> {
    if s.is_empty() || start >= s.len() || s.as_bytes()[start] != open {
        return None;
    }
    MATCHES.with(|m| {
        let m = m.borrow();
        let t = m.as_ref()?;
        let at = s.as_ptr() as usize;
        if at < t.start || at + s.len() > t.start + t.len {
            return None;
        }
        let offset = at - t.start;
        match t.ends[offset + start] {
            NOT_OPEN => None,
            NO_MATCH => Some(None),
            end => {
                let end = end as usize - offset;
                Some((end <= s.len()).then_some(end))
            }
        }
    })
}

fn matching(s: &str, start: usize, open: u8, close: u8) -> Option<usize> {
    if let Some(answer) = matching_from_table(s, start, open) {
        return answer;
    }
    let b = s.as_bytes();
    let (mut i, mut depth) = (start, 0usize);
    while i < b.len() {
        if b[i] == b'"' {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
        } else if b[i] == open {
            depth += 1;
        } else if b[i] == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}
/// Whether an expression is a boolean on its face: a boolean literal, a
/// `not`/`null`/`all`/`any` application, or one operand compared with what
/// follows it - q evaluates right to left, so the leftmost operator gives the
/// result its type. Anything else, a bare name included, may be any type.
fn boolean_test(s: &str) -> bool {
    re!(r"^[01]+b$").is_match(s)
        || re!(r"^(?:not|null|all|any)\b").is_match(s)
        || re!(
            r#"^(?:-?\d[\w.:]*|`[\w.:]*|\.?[A-Za-z][\w.]*(?:\[[^\[\]]*\])?|\([^()]*\)|"[^"]*")(?:\s*(?:<>|<=|>=|=|<|>|~)|\s+(?:in|like|within)\b)"#
        )
        .is_match(s)
}

pub(crate) fn slots(s: &str) -> Vec<&str> {
    if let Some(cuts) = slot_cuts(s) {
        let mut out = vec![];
        let mut start = 0;
        for cut in cuts {
            out.push(&s[start..cut]);
            start = cut + 1;
        }
        out.push(&s[start..]);
        return out;
    }
    let (mut start, mut depth) = (0, 0i32);
    let mut out = vec![];
    for (i, b) in s.bytes().enumerate() {
        if b"([{ ".contains(&b) && b != b' ' {
            depth += 1;
        } else if b")]}".contains(&b) {
            depth -= 1;
        } else if b == b';' && depth == 0 {
            out.push(&s[start..i]);
            start = i + 1;
        }
    }
    out.push(&s[start..]);
    out
}
/// A lambda parameter name. `_` is absent deliberately: q reads `{[_] ...}` as
/// a body, not a signature, which is what `named` below is about.
fn is_param_name(s: &str) -> bool {
    re!(r"^\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$").is_match(s)
}

/// A q 5 parameter pattern, as written in code with strings blanked: a name,
/// a literal (a string is blank here, so an empty item inside a pattern
/// passes), a list of patterns `(a;b)`, a dictionary `([k;v:p])` or
/// `` `a`b!(a;b) ``, or a table `([]a;b:c)`. q 5 binds each and fails a call
/// only where the argument does not match: `{[(a;b);c] a+b+c}[(1;2);3]` is 6, `{[([k;v])] k+v}[`k`v!1 2]`
/// is 3, `{[1;b] b}[1;2]` is 2 and `{[1] 5} 2` is 'match (#298). `_` is
/// none: `{[(a;_)] a}[(1;2)]` is 'match, as `{[_] 1}[1]` is.
pub(crate) fn is_pattern(s: &str, nested: bool) -> bool {
    pattern_within(s, nested, 0)
}
/// More levels of brackets than q parses: q 5 refuses a hundred-odd levels of
/// parentheses with '(. Code that walks into nesting gives up past it, which
/// keeps tens of thousands of levels from overflowing the stack (#703).
pub(crate) const MAX_NESTING: usize = 256;
/// `is_pattern` at a nesting `depth`; past `MAX_NESTING` it is no pattern.
fn pattern_within(s: &str, nested: bool, depth: usize) -> bool {
    if depth > MAX_NESTING {
        return false;
    }
    let is_pattern = |s: &str, nested: bool| pattern_within(s, nested, depth + 1);
    let s = s.trim();
    let items = |inner: &str, item: &dyn Fn(&str) -> bool| {
        inner.trim().is_empty() || slots(inner).into_iter().all(item)
    };
    let whole = |s: &str| s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len());
    if s.is_empty() {
        nested
    } else if s == "::" {
        // The generic null matches only itself: q 5 `{[(a;b;::)] a+b}
        // (1;2;::)` is 3, and `{[a;::] a}` takes two arguments (#450).
        true
    } else if is_param_name(s)
        || s == "."
        || re!(r"^(?:-?(?:\d|\.\d)[A-Za-z0-9.:]*(?:\s+-?(?:\d|\.\d)[A-Za-z0-9.:]*)*|(?:`[A-Za-z0-9_.:]*)+)$")
            .is_match(s)
            && !s.contains("..")
    {
        true
    } else if let Some(inner) = s.strip_prefix("([]").filter(|_| whole(s)) {
        items(&inner[..inner.len() - 1], &|c| field(c))
    } else if s.starts_with("([")
        && whole(s)
        && let Some(close) = matching(s, 1, b'[', b']')
    {
        // A keyed table: its keys, then any value columns - q 5
        // `{[([k]v)] v} ([k:1 2]v:3 4)` is 3 4 (#740).
        items(&s[2..close - 1], &|c| field(c)) && items(&s[close..s.len() - 1], &|c| field(c))
    } else if whole(s) {
        items(&s[1..s.len() - 1], &|c| is_pattern(c, true))
    } else if let Some(at) = typed_at(s) {
        !iterated_type(s) && is_pattern(&s[..at], nested)
    } else if let Some(at) = first_outside(s, b'!') {
        // A dictionary pattern: keys, then the pattern its values match.
        // q 5 `{[`a`b!(a;b);c] a+b+c}[`a`b!1 2;3]` is 6, and
        // `{[k!(a;b)] k}[`x`y!1 2]` binds the keys to k (#431). No keys is
        // '!, while no values (`{[a!] 1}`) is defined.
        at > 0
            && !iterated_type(s)
            && is_pattern(&s[..at], false)
            && is_pattern(&s[at + 1..], true)
    } else {
        application(s)
    }
}
/// A name applied in a slot: q 5 defines `{[f x] 1}`, `{[a[0]] a}` and
/// `{[a (b;c)] b}`, each with one parameter that binds no name - their names
/// stay globals, read when the lambda is called - and a call may match
/// (`a:`x`y`z; b:1; {[a b] 7}[`y]` is 7). A builtin applied, an operator, an
/// iterator, or a literal at the head is 'nyi where the lambda is defined:
/// `{[count x] 1}`, `{[a+b] 1}`, `{[a'] 1}`, `{[1 a] 1}` (#484).
fn application(s: &str) -> bool {
    let s = s.trim();
    re!(r"^\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*")
        .find(s)
        .is_some_and(|head| s[head.end()..].starts_with([' ', '\t', '\n', '\r', '[', '(', '{']))
        && !re!(r"[-+*%,#$@&|^=<>~!?'/\\]").is_match(s)
        && !re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(s).any(|w| {
            boundary(s, w.start())
                && !s[..w.start()].ends_with(['`', '.'])
                && RESERVED.iter().any(|n| n == w.as_str())
        })
}
/// The patterns `like` at `at` is given, in the order q 5 tries them: a
/// string straight after it, after an iterator on it (`like\\:`, `like/:`,
/// `like'`), in parentheses, as the second argument in brackets, or after a
/// projection `like[x;]`. Through an iterator a list of patterns is tried
/// item by item, up to the first that is not a string of two or more chars -
/// q 5 `"ab" like/: ("c";"a*b*")` is 'type at the "c" - and without one a
/// list is no pattern at all (#442). `code` has strings blanked, `literals`
/// keeps them, at the same offsets.
fn like_patterns<'a>(code: &str, literals: &'a str, at: usize) -> Vec<&'a str> {
    // Blanks are read from `literals`: in `code` a string is blank too.
    let skip =
        |i: usize| i + (literals[i..].len() - literals[i..].trim_start_matches([' ', '\t']).len());
    let mut i = skip(at);
    let iterated = if code[i..].starts_with("\\:") || code[i..].starts_with("/:") {
        i += 2;
        true
    } else if code[i..].starts_with('\'') {
        i += 1;
        true
    } else {
        false
    };
    i = skip(i);
    if !iterated && code[i..].starts_with('[') {
        let Some(close) = matching(code, i, b'[', b']') else {
            return vec![];
        };
        let args = slots(&code[i + 1..close - 1]);
        if args.len() != 2 {
            return vec![];
        }
        let second = args[1].as_ptr() as usize - code.as_ptr() as usize;
        i = if literals[second..second + args[1].len()].trim().is_empty() {
            skip(close)
        } else {
            skip(second)
        };
    }
    // One operand: a string, or a parenthesised group of them.
    fn operand<'a>(code: &str, literals: &'a str, i: usize, list: bool, out: &mut Vec<&'a str>) {
        if literals[i..].starts_with('"') {
            if let Some(end) = literals[i + 1..].find('"') {
                out.push(&literals[i + 1..i + 1 + end]);
            }
        } else if code[i..].starts_with('(')
            && let Some(close) = matching(code, i, b'(', b')')
        {
            let items = slots(&code[i + 1..close - 1]);
            if items.len() > 1 && !list {
                return;
            }
            for item in items {
                let from = item.as_ptr() as usize - code.as_ptr() as usize;
                let lit = &literals[from..from + item.len()];
                let from = from + (lit.len() - lit.trim_start().len());
                let before = out.len();
                operand(code, literals, from, false, out);
                // A char atom or anything but a string ends the list there.
                if out.len() == before || out.last().is_some_and(|p| p.len() == 1) {
                    out.truncate(before);
                    return;
                }
            }
        }
    }
    let mut out = vec![];
    operand(code, literals, i, iterated, &mut out);
    out
}
/// Each name the source assigns under `.q` (`.q.foo:{x+1}`), with the end
/// of the top-level statement that assigns it. q 5 then resolves `foo` from
/// every namespace and refuses it as a parameter, a local or a global, as it
/// does `count` - but only in what it parses afterwards: the statement
/// holding the assignment, lambda and indented lines included, was parsed
/// before it ran, so `g:{.q.foo:{x+1}; foo:2; foo}` still runs (#697).
/// Under `\d .q` a plain `foo:` at the start of a line is the same
/// assignment: q 5 refuses `{[foo] foo}` after `\d .q` / `foo:{x+1}` /
/// `\d .` with 'nyi (#589).
pub(crate) fn dotq_definitions(code: &str, raw: &str) -> Vec<(String, usize)> {
    let b = code.as_bytes();
    let statement_end = |from: usize| {
        let mut depth = 0i32;
        for i in from..b.len() {
            match b[i] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                b'\n'
                    if depth <= 0
                        && !matches!(b.get(i + 1), Some(b' ' | b'\t' | b'\r' | b'\n')) =>
                {
                    return i;
                }
                _ => {}
            }
        }
        b.len()
    };
    // `` `.q.foo set f `` and `` @[`.q;`foo;:;f] `` define it just the same:
    // q 5 then runs `til 1.5` against the new `til` (#720).
    let mut out: Vec<(String, usize)> = [
        re!(r"\.q\.([A-Za-z][A-Za-z0-9_]*)\s*:"),
        re!(r"`\.q\.([A-Za-z][A-Za-z0-9_]*)\s*set\b"),
        re!(r"@\[\s*`\.q\s*;\s*`([A-Za-z][A-Za-z0-9_]*)\s*;\s*:\s*;"),
    ]
    .into_iter()
    .flat_map(|pattern| pattern.captures_iter(code))
    .filter(|c| boundary(code, c.get(0).unwrap().start()))
    .map(|c| (c[1].to_string(), statement_end(c.get(0).unwrap().start())))
    .collect();
    let (mut namespace, mut offset) = (String::new(), 0);
    for line in code.split_inclusive('\n') {
        if let Some(ns) = semantics::opens(line, &raw[offset..offset + line.len()]) {
            namespace = ns;
        } else if namespace == ".q"
            && let Some(c) = re!(r"^[;\s]*([A-Za-z][A-Za-z0-9_]*)\s*:").captures(line)
            && line.starts_with(|c: char| c.is_ascii_alphabetic() || c == ';')
        {
            let at = offset + c.get(1).unwrap().start();
            out.push((c[1].to_string(), statement_end(at)));
        }
        offset += line.len();
    }
    out.sort_by_key(|d| d.1);
    out
}
/// Whether `at` is a column of a table literal, `([] a:1)` or its key
/// `([k:1] a:2)`: the nearest bracket open around it is the literal's.
fn in_table_literal(code: &str, at: usize) -> bool {
    let b = code.as_bytes();
    let mut depth = 0i32;
    for i in (0..at).rev() {
        match b[i] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b'(' => return code[i + 1..].trim_start().starts_with('['),
            b'[' => return code[..i].trim_end().ends_with('('),
            b'{' => return false,
            _ => {}
        }
    }
    false
}
/// Whether a compound or `::` assignment has a value to assign: q 5 refuses
/// `{sum::x}` and `{count,:x}` with 'assign, but `{a:sum::}`, `(sum::)x`,
/// `sum::'x` and `count,:;` apply the function instead (#432).
fn assigns_operand(rest: &str) -> bool {
    let rest = rest.trim_start_matches([' ', '\t']);
    !rest.is_empty() && !rest.starts_with([';', ')', ']', '}', '\'', '[', '/', '\\', '\r', '\n'])
}
/// The first `byte` in `s` outside any bracket, brace or parenthesis.
fn first_outside(s: &str, byte: u8) -> Option<usize> {
    let mut depth = 0i32;
    for (i, b) in s.bytes().enumerate() {
        match b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            _ if b == byte && depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}
/// Where a typed slot's `:type` starts: `a:`j`, `a:"j"` and `(a;b):`j` are
/// the pattern on the left, checked against the type on the right when the
/// lambda is called. q 5 defines the lambda whatever the type names, and
/// with no type at all (`{[a:] a}`), which is also how a masked `a:"j"`
/// reads (#304). Any function after the colon is applied to the argument -
/// `{[a:`$;b] (a;b)}["xy";2]` is (`xy;2), and `a:neg`, `a:{x+1}`, `a:-7h`
/// and `a:0h` each define a slot (#437) - so the slot is typed at its first
/// colon outside brackets.
fn typed_at(s: &str) -> Option<usize> {
    first_outside(s, b':').filter(|&at| at > 0)
}
/// Whether a slot's type, or a dictionary pattern's values, is one q refuses
/// with 'nyi: a type may be any expression but one that starts with an
/// iterator or a colon. q 5 refuses `{[a:'] a}`, `{[a:/] a}`, `{[a::] a}`,
/// `{[a:'b] a}`, `{[a!:] a}` (whose `!:` is a glyph) and `{[a!::] a}`, and
/// takes `{[a:+] a}`, `{[a:b'] a}` and `{[a:] a}` (#577, #594).
fn iterated_type(s: &str) -> bool {
    typed_at(s).is_some_and(|at| {
        s[..at].ends_with('!') || s[at + 1..].trim_start().starts_with([':', '\'', '/', '\\'])
    }) || first_outside(s, b'!').is_some_and(|at| {
        let values = s[at + 1..].trim();
        values == "::" || values.starts_with(['\'', '/', '\\'])
    })
}
/// The names a parameter slot binds: the slot itself when it is a name, and
/// for a pattern every name in it but the keys and columns it matches on -
/// `(a;b)` binds a and b, `([k:p])` binds p, and `1` binds nothing.
pub(crate) fn pattern_names(slot: &str) -> Vec<&str> {
    names_within(slot, 0)
}
/// `pattern_names` at a nesting `depth`; past `MAX_NESTING` it binds nothing.
fn names_within(slot: &str, depth: usize) -> Vec<&str> {
    if depth > MAX_NESTING {
        return vec![];
    }
    let slot = typed_at(slot).map_or(slot, |at| &slot[..at]);
    // A list pattern's items each take their own filter: `(a:neg;b)` binds
    // a and b, and not neg (q 5 `{[(a:neg;b)] (a;b)} 1 2` is -1 2, #668).
    let trimmed = slot.trim();
    if trimmed.starts_with('(')
        && !trimmed.starts_with("([")
        && matching(trimmed, 0, b'(', b')') == Some(trimmed.len())
    {
        return slots(&trimmed[1..trimmed.len() - 1])
            .into_iter()
            .flat_map(|item| names_within(item, depth + 1))
            .collect();
    }
    if application(trimmed) {
        return vec![];
    }
    re!(r"\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*")
        .find_iter(slot)
        .filter(|m| {
            boundary(slot, m.start())
                && !slot[..m.start()].ends_with(['`', '.'])
                && !slot[..m.start()].ends_with(|c: char| c.is_ascii_digit())
                && !slot[m.end()..].trim_start().starts_with(':')
        })
        .map(|m| m.as_str())
        .collect()
}
/// Where a parameter slot would bind a name holding `_`: `Some(true)` for a
/// bare `_` - q 5 defines `{[_] 1}` and `{[(a;_)] a}` and refuses every
/// call with 'match - and `Some(false)` for a name starting with one, which
/// q 5 refuses where the lambda is defined (`{[_a] 1}` and `{[(a;_b)] a}`
/// are '_, #636). What follows a `:` in a slot or list item is the function
/// the argument goes through, not a name: q 5 `{[a:2_] a} 1 2 3` is ,3 (#622).
fn underscore_binding(s: &str, depth: usize) -> Option<bool> {
    let s = s.trim();
    let whole = |s: &str| s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len());
    let worst = |parts: &[&str], f: &dyn Fn(&str) -> Option<bool>| {
        parts.iter().filter_map(|p| f(p)).reduce(|a, b| a || b)
    };
    let inner = |c: &str| underscore_binding(c, depth + 1);
    // Table and keyed-table fields: in `k:p` the name is `p`'s to bind.
    let fields = |c: &str| worst(&c.split(':').collect::<Vec<_>>(), &inner);
    if depth > MAX_NESTING {
        None
    } else if s == "_" {
        Some(true)
    } else if re!(r"^_[A-Za-z0-9_]*$").is_match(s) {
        Some(false)
    } else if s.starts_with("([")
        && whole(s)
        && let Some(close) = matching(s, 1, b'[', b']')
    {
        let mut parts = slots(&s[2..close - 1]);
        parts.extend(slots(&s[close..s.len() - 1]));
        worst(&parts, &fields)
    } else if whole(s) {
        worst(&slots(&s[1..s.len() - 1]), &inner)
    } else if let Some(at) = typed_at(s) {
        inner(&s[..at])
    } else if let Some(at) = first_outside(s, b'!') {
        worst(&[&s[..at], &s[at + 1..]], &inner)
    } else {
        None
    }
}
/// A key or column of a dictionary or table pattern: `k`, or `k:p`.
fn field(s: &str) -> bool {
    match s.split_once(':') {
        Some((name, p)) => is_param_name(name.trim()) && is_pattern(p, true),
        None => is_param_name(s.trim()),
    }
}

/// What q makes of the `[...]` following a `{`.
///
/// q reads those brackets as a parameter list only when every slot is a name
/// or, in q 5, a pattern (see `is_pattern`). Anything else - `{[a+b] ...}`,
/// `{[count x] ...}` - q 5 refuses where the lambda is defined; the rules
/// treat it as taking the implicit x, y and z, which is the rank it would
/// have without the brackets. The rules here
/// and the scope tracking in `semantics` both have to agree with q about
/// which of the two a given `{` is, so they share this.
pub(crate) struct Signature<'a> {
    /// The bracket group, trimmed and split on top-level `;` - empty when
    /// there is no `[` at all.
    pub slots: Vec<&'a str>,
    /// Whether q treats `slots` as parameters rather than as body text.
    pub named: bool,
    /// Where the body starts: after `]` for a signature, after `{` otherwise.
    pub body: usize,
}
/// How many arguments the lambda at `brace` (closing before `end`) takes: its
/// parameter count, 0 for `{[]...}`, or for an implicit signature the
/// highest of x, y and z its own body reads - nested lambdas blanked, so
/// theirs do not count.
pub(crate) fn lambda_rank(code: &str, raw: &str, brace: usize, end: usize) -> usize {
    let sig = signature(code, raw, brace);
    if sig.named {
        return if sig.slots.iter().all(|p| p.is_empty()) {
            0
        } else {
            sig.slots.len()
        };
    }
    // A nested lambda reads its own arguments, so it is left out - as one
    // blank, jumped over from its brace's match: blanking it in a copy of
    // the whole body made a nest of lambdas quadratic (#704).
    let b = code.as_bytes();
    let mut body = vec![];
    let mut i = sig.body;
    while i < end {
        if b[i] == b'{' {
            match matching(code, i, b'{', b'}') {
                Some(close) if close <= end => {
                    body.push(b' ');
                    i = close;
                    continue;
                }
                _ => break,
            }
        }
        body.push(b[i]);
        i += 1;
    }
    // A symbol is not a read: `{x,`y}` takes one argument (#189).
    let body = re!(r"`[A-Za-z0-9_./:]*")
        .replace_all(&String::from_utf8(body).unwrap(), |m: &regex::Captures| {
            " ".repeat(m[0].len())
        })
        .into_owned();
    let body = table_columns_blanked(&outside_query_phrases(&body));
    // Not as part of a dotted name: `.z.s` is the lambda itself, and
    // reading it says nothing about a third argument. After a drop it is a
    // read: `{x,1_y}` takes two (q 5, #339), while `a_y` is one name.
    let reads = |name: &str| {
        body.match_indices(name).any(|(i, _)| {
            boundary(&body, i)
                && !body[i + 1..]
                    .starts_with(|c: char| c.is_ascii_alphanumeric() || "_.".contains(c))
        })
    };
    if reads("z") {
        3
    } else if reads("y") {
        2
    } else {
        1
    }
}
/// `text` with the column names of each table literal blanked, `z` in
/// `([]z:x)` and `([z:1]b:2)`: a column name reads nothing, while its value
/// may - KDB-X `{([]z:x)}` takes one argument, `{([]a:y)}` two. A group
/// assigned to, `([k;v]):d`, is a pattern and no literal. Same length.
pub(crate) fn table_columns_blanked(text: &str) -> String {
    let mut out = text.as_bytes().to_vec();
    for (open, _) in text.match_indices('(') {
        if !text[open + 1..].trim_start().starts_with('[') {
            continue;
        }
        let Some(close) = matching(text, open, b'(', b')') else {
            continue;
        };
        if re!(r"^\s*:([^:]|$)").is_match(&text[close..]) {
            continue;
        }
        let inside = &text[open..close];
        for m in re!(r"[A-Za-z][A-Za-z0-9_]*\s*:").find_iter(inside) {
            if boundary(inside, m.start()) && !inside[m.end()..].starts_with(':') {
                blank(&mut out[open + m.start()..open + m.end() - 1]);
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// A lambda body with the column, by and where phrases of its queries
/// blanked: q leaves the names there out of the implicit signature, so
/// `{select from x where a=y}` takes one argument and `{select from y}` two
/// (q 5, #326). The table after `from` and a `select[n]` limit stay, as
/// does anything after the `;` ending the query. Same length as `body`.
fn outside_query_phrases(body: &str) -> String {
    #[derive(Clone, Copy, PartialEq)]
    enum In {
        Code,
        Phrase,
        Table,
    }
    let b = body.as_bytes();
    let mut out = b.to_vec();
    // Each open bracket: the state it opened in, which a `;` inside it
    // returns to - `(y;1)` in a where phrase is still the phrase, while
    // `f[select ...; y]` reads `y` - and the state now.
    let mut stack = vec![(In::Code, In::Code)];
    let mut keyword_end = None;
    let mut i = 0;
    while i < b.len() {
        let state = stack.last().unwrap().1;
        match b[i] {
            b'(' | b'[' | b'{' => {
                // `select[n]` is a limit, read where the query is.
                let limit =
                    b[i] == b'[' && keyword_end.is_some_and(|k| body[k..i].trim().is_empty());
                let open = if limit { In::Code } else { state };
                stack.push((open, open));
            }
            b')' | b']' | b'}' if stack.len() > 1 => {
                stack.pop();
            }
            b';' => {
                let top = stack.last_mut().unwrap();
                top.1 = top.0;
            }
            _ => {
                // Outside a query, `where` is the function: `{x where y}`.
                if let Some(word) = query_word(body, i)
                    .filter(|w| state != In::Code || !matches!(*w, "by" | "from" | "where"))
                {
                    let next = match word {
                        "select" | "exec" | "update" | "delete" => {
                            keyword_end = Some(i + word.len());
                            In::Phrase
                        }
                        "from" => In::Table,
                        _ => In::Phrase,
                    };
                    stack.last_mut().unwrap().1 = next;
                    i += word.len();
                    continue;
                }
            }
        }
        if stack.last().unwrap().1 == In::Phrase && b[i].is_ascii_alphanumeric() {
            out[i] = b' ';
        }
        i += 1;
    }
    String::from_utf8(out).unwrap()
}
/// Whether `name`, read at `at`, is a parameter or local of a lambda around
/// it - and so not the global a rule may know the rank of. q 5:
/// `f:{x}; g:{[f] f[1;2]}; g[{x+y}]` is 3. A dotted name is always global.
pub(crate) fn shadowed(code: &str, raw: &str, at: usize, name: &str) -> bool {
    if name.contains('.') {
        return false;
    }
    // Only the lambdas around `at`: walking every `{` before it made each
    // call linear in the file, and a file of functions quadratic (#705).
    let braces = enclosing_braces(code, at)
        .unwrap_or_else(|| code[..at].match_indices('{').map(|(i, _)| i).collect());
    for brace in braces {
        let Some(end) = matching(code, brace, b'{', b'}').filter(|&end| end > at) else {
            continue;
        };
        let sig = signature(code, raw, brace);
        // A pattern binds the names in it: `{[(f;a)] f[a;a]}` (#332).
        if if sig.named {
            sig.slots
                .iter()
                .any(|slot| pattern_names(slot).contains(&name))
        } else {
            matches!(name, "x" | "y" | "z")
        } {
            return true;
        }
        // This lambda's own body only: an assignment after its closing brace
        // is another lambda's local, or a global, and one inside a nested
        // lambda is that lambda's local (#187). q has no closures.
        let mut own = code.as_bytes()[sig.body.min(end - 1)..end - 1].to_vec();
        let mut depth = 0i32;
        for c in &mut own {
            match *c {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                _ if depth > 0 => *c = b' ',
                _ => {}
            }
        }
        let body = &String::from_utf8(own).unwrap();
        for (i, _) in body.match_indices(name) {
            let after = body[i + name.len()..].trim_start_matches([' ', '\t']);
            if boundary(body, i)
                && !body[i + name.len()..]
                    .starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
                && after.starts_with(':')
                && !after.starts_with("::")
            {
                return true;
            }
        }
    }
    false
}
/// `code` is the masked view and `raw` the source it was masked from, at the
/// same offsets. Both are needed: a string literal is blank in `code`, and
/// `{["s"] 1}` would otherwise read as the empty parameter list it is not.
pub(crate) fn signature<'a>(code: &'a str, raw: &str, brace: usize) -> Signature<'a> {
    let implicit = |slots| Signature {
        slots,
        named: false,
        body: brace + 1,
    };
    let rest = &code[brace + 1..];
    let bracket = brace + 1 + (rest.len() - rest.trim_start().len());
    if code.as_bytes().get(bracket) != Some(&b'[') {
        return implicit(vec![]);
    }
    let Some(close) = matching(code, bracket, b'[', b']') else {
        return implicit(vec![]);
    };
    let (mut ranges, mut start, mut depth) = (vec![], bracket + 1, 0i32);
    for i in bracket + 1..close - 1 {
        let b = code.as_bytes()[i];
        if b"([{".contains(&b) {
            depth += 1;
        } else if b")]}".contains(&b) {
            depth -= 1;
            // A closer that opened outside the brackets: in `{[a:x+1};b]`
            // the `}` ends the lambda, and the `]` after it is no end of a
            // parameter list - reading one put its body past the lambda.
            if depth < 0 {
                return implicit(vec![]);
            }
        } else if b == b';' && depth == 0 {
            ranges.push((start, i));
            start = i + 1;
        }
    }
    ranges.push((start, close - 1));
    let slots: Vec<&str> = ranges.iter().map(|&(a, b)| code[a..b].trim()).collect();
    // An empty slot is still a parameter - q names it by position, so the
    // trailing `;` in `{[a;b;] ...}` is a third argument rather than nothing.
    // "Empty" has to be judged on `raw`, or a masked literal passes for one.
    // A string is blank in `code`; as a pattern it is a literal like any
    // other, so it is read as one: `{["ab"!(a;b)] a}` has keys (#431).
    // A comment is blank in `code` too, and is no literal: from a ` /` that
    // `code` blanks to the end of its line, it stays blank (#560).
    let literal = |a: usize, b: usize| -> String {
        let (c, r) = (code.as_bytes(), raw.as_bytes());
        let mut comment = false;
        (a..b)
            .map(|i| {
                if r[i] == b'\n' {
                    comment = false;
                } else if c[i] != r[i]
                    && r[i] == b'/'
                    && (i == 0 || r[i - 1].is_ascii_whitespace())
                    && code[i..]
                        .split('\n')
                        .next()
                        .is_some_and(|l| l.trim().is_empty())
                {
                    comment = true;
                }
                if c[i] == r[i] || comment {
                    c[i] as char
                } else {
                    '0'
                }
            })
            .collect()
    };
    // `_` binds no name but is still a slot: q 5 defines `{[a;_] a}` with two
    // parameters and refuses every call with 'match (QF002), and only a
    // third argument is 'rank (#443).
    let names_only = ranges.iter().zip(&slots).all(|(&(a, b), slot)| {
        let nested = !slot.is_empty() || !raw[a..b].trim().is_empty();
        (slot.is_empty() && raw[a..b].trim().is_empty())
            || is_param_name(slot)
            || is_pattern(&literal(a, b), nested)
            || (slot.contains('_') && is_pattern(&literal(a, b).replace('_', "u"), nested))
    });
    if !names_only {
        return implicit(slots);
    }
    Signature {
        slots,
        named: true,
        body: close,
    }
}
/// Whether every bracket and string in `source` closes - what QE001 reports
/// on, asked whether or not QE001 is selected.
pub fn balanced(source: &str) -> bool {
    problems(source, &views(source)).is_empty()
}

/// The statement the first structural problem in `source` is in, as the
/// bytes it spans: from the line that starts it to the line that starts the
/// next, or the end of the file. A string nothing closes is in it too, since
/// a line at column 0 ends a string as it ends a statement. `None` for a
/// source whose brackets and strings all close. What a language server
/// leaves out when it keeps a file's last results around a statement being
/// typed.
pub fn broken_statement(source: &str) -> Option<std::ops::Range<usize>> {
    let v = views(source);
    let (at, _) = problems(source, &v).into_iter().next()?;
    let (mut start, mut offset) = (0, 0);
    for line in v.code.split_inclusive('\n') {
        if begins(source, &v, offset, line) {
            if offset > at {
                return Some(start..offset);
            }
            start = offset;
        }
        offset += line.len();
    }
    Some(start..source.len())
}

/// The most brackets, braces and parentheses q 5 holds open at once.
pub(crate) const DEPTH: usize = 100;

/// Every structural problem in the file, in source order. Each is reported
/// and then recovered from - a statement at column 0 starts with no bracket
/// open, a stray closer is skipped, a mismatched one closes what it meets -
/// so a `noqa` on the first does not hide the next (#413).
fn structure(path: &str, source: &str, v: &Views) -> Vec<Finding> {
    problems(source, v)
        .into_iter()
        .map(|(at, detail)| Finding::at(path, source, at, "QE001", detail))
        .collect()
}

/// Whether the line at `offset`, `line` in the code view, starts a
/// statement. A line at column 0 does, so a bracket still open there never
/// closes: q 5 refuses `f:{[y]` + `  y+1` + `}` with '{ (#225). A comment
/// line is blank here and does not count. Column 0 is read from the source:
/// `views` blanks a line's opening quote, its `q)` prefix and a whole `k)`
/// line, and each still starts a statement - q 5 refuses `f:{[a]` +
/// `"abc",a}` with '{ (#307).
fn begins(source: &str, v: &Views, offset: usize, line: &str) -> bool {
    let raw = &source[offset..offset + line.len()];
    let lead = if raw.starts_with("q)") { 2 } else { 0 };
    raw.starts_with(|ch: char| !ch.is_ascii_whitespace())
        && (!line.trim().is_empty()
            || v.string_starts.binary_search(&(offset + lead)).is_ok()
            || v.foreign_offsets.binary_search(&offset).is_ok())
}

/// `structure`'s problems as the byte each is at and what it says.
fn problems(source: &str, v: &Views) -> Vec<(usize, String)> {
    let mut found = vec![];
    let mut stack: Vec<(u8, usize)> = vec![];
    let mut offset = 0;
    for line in v.code.split_inclusive('\n') {
        let raw = &source[offset..offset + line.len()];
        if let Some(&(c, at)) = stack.last()
            && begins(source, v, offset, line)
        {
            let row = source[..offset].matches('\n').count() + 1;
            found.push((
                at,
                format!(
                    "Unclosed delimiter; expected '{}' before line {row}, which starts at \
                     column 0 and so begins a new statement",
                    c as char
                ),
            ));
            stack.clear();
        }
        // A command's argument is no q, but `\t`'s is, and its brackets
        // close on the lines that continue it (#308).
        if !system_command(raw) {
            for (i, c) in line.bytes().enumerate() {
                if let Some(p) = b"([{ ".iter().position(|&a| a == c).filter(|&p| p < 3) {
                    stack.push((b")]}"[p], offset + i));
                    // q 5 refuses a hundred and one open at once, of any
                    // kinds, with the innermost: `(` 101 deep is '(, and
                    // `({` 51 deep is '{ (#717).
                    if stack.len() == DEPTH + 1 {
                        found.push((
                            offset + i,
                            format!(
                                "More than {DEPTH} brackets, braces and parentheses open at \
                                 once; q 5 refuses this one with '{}",
                                c as char
                            ),
                        ));
                    }
                } else if b")]}".contains(&c) {
                    match stack.pop() {
                        None => {
                            found.push((offset + i, format!("Unexpected closing '{}'", c as char)));
                        }
                        // A closer that some bracket further out wants
                        // closes that one, and what it passes was never
                        // closed: `{ f[1; }` is an unclosed `[`, reported
                        // where it opens - the line being typed - and not at
                        // the `}`, often lines below. A closer nothing open
                        // wants, as in `(1;2]`, is the mistake itself.
                        Some((want, at)) if want != c => {
                            match stack.iter().rposition(|&(w, _)| w == c) {
                                Some(outer) => {
                                    let row = source[..offset].matches('\n').count() + 1;
                                    found.push((
                                        at,
                                        format!(
                                            "Unclosed delimiter; expected '{}' before the '{}' \
                                             on line {row}",
                                            want as char, c as char
                                        ),
                                    ));
                                    stack.truncate(outer);
                                }
                                None => found.push((
                                    offset + i,
                                    format!("Expected '{}', got '{}'", want as char, c as char),
                                )),
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        offset += line.len();
    }
    if let Some(at) = v.unterminated {
        found.push((at, "Unterminated string literal".into()));
    } else if let Some(&(c, at)) = stack.last() {
        found.push((at, format!("Unclosed delimiter; expected '{}'", c as char)));
    }
    // An unclosed bracket is found at its closer and reported where it
    // opens, behind what was found on the way there.
    found.sort_by_key(|&(at, _)| at);
    found
}

/// Lines an editor can fold away, as two bytes of the source: one on the
/// line that stays in view, and one on the last line hidden under it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fold {
    pub start: usize,
    pub end: usize,
    /// A block comment, which an editor can fold apart from the code.
    pub comment: bool,
}

/// What there is to fold in `source`: each brace, bracket and parenthesis
/// that closes on a later line than it opens, and each block comment from
/// its bare `/` to its bare `\`. In source order, an outer before what it
/// holds.
///
/// Read from the view the rules read, so a bracket inside a string or a
/// comment folds nothing, and paired as `structure` pairs them. Nothing at
/// all for a file `structure` reports on: with one bracket unmatched there
/// is no saying which of the others pair, and a guess would move as the
/// line is typed. Nor for a block comment nothing closes - q reads that one
/// to the end of the file, and QE003 says so.
///
/// A fold ends on the line of its closer when nothing follows it there but
/// more closers and a `;`, and on the line before when something does: an
/// editor hides whole lines, and `}[1;2]` or `} each x` is the half of the
/// statement that says what the lambda is for.
pub fn folds(source: &str) -> Vec<Fold> {
    let v = views(source);
    if !problems(source, &v).is_empty() {
        return vec![];
    }
    let mut found: Vec<Fold> = v
        .blocks
        .iter()
        .map(|&(start, end)| Fold {
            start,
            end,
            comment: true,
        })
        .collect();
    let mut stack = vec![];
    let mut offset = 0;
    for line in v.code.split_inclusive('\n') {
        // As `structure` reads them: a command's argument is no q.
        if !system_command(&source[offset..offset + line.len()]) {
            for (i, c) in line.bytes().enumerate() {
                if b"([{".contains(&c) {
                    stack.push(offset + i);
                } else if b")]}".contains(&c)
                    && let Some(start) = stack.pop()
                    // Opened on a line before this one, or nothing to fold.
                    && start < offset
                {
                    let closes_line = line[i + 1..]
                        .trim_matches(|ch: char| ch.is_ascii_whitespace() || ")]};".contains(ch))
                        .is_empty();
                    // `offset - 1` is the break that ends the line before:
                    // there is one, with the opener on a line before this.
                    let end = if closes_line { offset + i } else { offset - 1 };
                    if source[start..end].contains('\n') {
                        found.push(Fold {
                            start,
                            end,
                            comment: false,
                        });
                    }
                }
            }
        }
        offset += line.len();
    }
    found.sort_by_key(|fold| fold.start);
    found
}

/// Which rules a run is asking for.
///
/// The default answers only one question - would q refuse this? - because
/// that is the answer a linter can give without arguing about taste. A rule
/// that fires on source q accepts and runs is describing a habit, not a
/// defect, and lives a profile up.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Profile {
    /// Only what q rejects: a parse error, or an error the moment it runs.
    General,
    /// Adds the constructs q accepts but almost nobody means - a parameter
    /// that shadows a builtin, a filter comparing a column to itself.
    Style,
    /// Adds the conventions published q style guidance states as rules.
    StyleQ,
    /// Adds another repository's own conventions on top of StyleQ.
    Uqf,
}
impl Profile {
    /// Whether a rule of this scope runs under this profile. Public because
    /// the showcase test asks the same question the linter does, rather than
    /// keeping its own copy of the answer.
    pub fn allows_scope(self, scope: &str) -> bool {
        self.allows(scope)
    }
    fn allows(self, scope: &str) -> bool {
        match scope {
            "builtin" => true,
            "style" => self != Profile::General,
            "styleq" => matches!(self, Profile::StyleQ | Profile::Uqf),
            "uqf" => self == Profile::Uqf,
            // In no profile: a rule a configuration selects by code, for a
            // tree that wants more than its profile asks (#847).
            "opt-in" => false,
            // qls and python-hook findings arrive from elsewhere; this is not
            // the place that decides whether they ran.
            _ => true,
        }
    }
}

/// Drops each finding whose line ends in a `/ noqa: CODE[, CODE...]` comment
/// naming its code. Only a trailing comment counts - a `/` the views pass
/// blanked as one, so a `noqa` inside a string literal is text, not a
/// directive - and only the codes it names: a bare `/ noqa` suppresses
/// nothing. Anything after the codes is a free-text reason.
///
/// And each finding whose code a file directive names: a comment line
/// `/ qlinter: noqa: CODE[, CODE...]` at the left margin, anywhere in the
/// file, as Ruff's `# ruff: noqa: CODE` (`file_noqa`).
fn suppress(out: &mut Vec<Finding>, source: &str, v: &Views) {
    let comments = v.comments.as_str();
    let file: Vec<&str> = file_noqa(source, v)
        .into_iter()
        .flat_map(|codes| codes_in(&source[codes]))
        .collect();
    if !file.is_empty() {
        out.retain(|f| !file.contains(&f.code.as_str()));
    }
    let mut noqa: std::collections::HashMap<usize, Vec<&str>> = Default::default();
    let mut offset = 0;
    for (n, line) in source.split_inclusive('\n').enumerate() {
        let end = offset + line.len();
        if let Some(codes) = noqa_codes(source, comments, offset, end) {
            noqa.entry(n + 1)
                .or_default()
                .extend(codes_in(&source[codes]));
        }
        offset = end;
    }
    if !noqa.is_empty() {
        out.retain(|f| {
            !noqa
                .get(&f.line)
                .is_some_and(|codes| codes.contains(&f.code.as_str()))
        });
    }
}

/// The codes the `noqa` comment of the line at `offset..end` names, as the
/// one span of the source that lists them: `QF016, QF017` of
/// `/ noqa: QF016, QF017 reason`. `suppress` reads it and `suppression_for`
/// writes it, so an edit the second makes is one the first honours.
fn noqa_codes(
    source: &str,
    comments: &str,
    offset: usize,
    end: usize,
) -> Option<std::ops::Range<usize>> {
    let (raw, blanked) = (source.as_bytes(), comments.as_bytes());
    let start = (offset..end).find(|&i| {
        raw[i] == b'/'
            && blanked[i] == b' '
            && (i == offset
                || raw[i - 1].is_ascii_whitespace()
                // `views` reads `<BOM>/ note` as a comment line (#221),
                // and so does its noqa (#427).
                || i == 3 && source.starts_with('\u{feff}'))
    })?;
    re!(
        r"(?:^|\s)/+\s*(?i:noqa)\s*:\s*([A-Z]+[0-9]+\b(?:\s*,\s*[A-Z]+[0-9]+\b|\s+[A-Z]+[0-9]+\b)*)"
    )
    .captures(&source[start..end])?
    .get(1)
    .map(|codes| start + codes.start()..start + codes.end())
}

/// Each code of a `noqa` comment's list.
fn codes_in(list: &str) -> impl Iterator<Item = &str> {
    list.split([',', ' ', '\t']).filter(|c| !c.is_empty())
}

/// QL003, Ruff's RUF100: each line's `noqa` codes that suppress nothing - no
/// finding of that code is reported on the line - as one finding per
/// directive, at its list of codes. `found` is every finding the run made,
/// before the profile or a `noqa` took any, and `qe001` the lines QE001
/// reported on before its own early return.
///
/// Only a code whose rule `ran` in this run: a code this build does not
/// know - another tool's, or a later release's - or one whose findings
/// arrive from elsewhere (QLS001, QF006) is left alone, and so is one a
/// profile turned off here, which may fire under another. A configuration
/// lints with every rule and then selects (`Config::lint`), so there a
/// `noqa` for a rule it deselects or ignores counts as used whenever that
/// rule would fire on the line, being there for whoever turns it back on,
/// and is reported only when the rule finds nothing there at all. Not
/// QL003 itself, which a `noqa` names to keep a directive this run cannot
/// see the need for. A line in a block comment or after the end of the
/// script holds no directive, whatever it says.
fn unused_noqa(
    path: &str,
    source: &str,
    v: &Views,
    found: &[Finding],
    qe001: &[usize],
    ran: impl Fn(&str) -> bool,
) -> Vec<Finding> {
    let mut fired: std::collections::HashSet<(usize, &str)> =
        found.iter().map(|f| (f.line, f.code.as_str())).collect();
    fired.extend(qe001.iter().map(|&line| (line, "QE001")));
    let mut out = vec![];
    let mut offset = 0;
    for (n, line) in source.split_inclusive('\n').enumerate() {
        let start = offset;
        offset += line.len();
        if v.in_block(start) || v.script_end.is_some_and(|end| start >= end) {
            continue;
        }
        let Some(codes) = noqa_codes(source, &v.comments, start, offset) else {
            continue;
        };
        let mut unused: Vec<&str> = vec![];
        for code in codes_in(&source[codes.clone()]) {
            if code != "QL003"
                && ran(code)
                && !fired.contains(&(n + 1, code))
                && !unused.contains(&code)
            {
                unused.push(code);
            }
        }
        if unused.is_empty() {
            continue;
        }
        let (s, them) = if unused.len() == 1 {
            ("", "it")
        } else {
            ("s", "them")
        };
        let mut finding = Finding::at(
            path,
            source,
            codes.start,
            "QL003",
            format!(
                "Unused noqa code{s}: {}; nothing on this line reports {them}, so the \
                 directive suppresses nothing",
                unused.join(", ")
            ),
        );
        finding.end_column = finding.column.map(|c| c + codes.len());
        out.push(finding);
    }
    out
}

/// The edit QL003 offers: its unused codes taken out of the directive's
/// list, or the whole directive with the blanks before it when no code would
/// be left. `None` where nothing else is on the line, which would be left
/// blank, or where the edit would change anything but a comment. Not
/// batch-safe: whether a rule fires on a line can turn on the files around
/// it (QF018 reads the workspace), so a `noqa` one run finds unused another
/// may need, and `--fix` does not delete it unattended.
fn unused_noqa_fix(finding: &Finding, source: &str, v: &Views) -> Option<Fix> {
    let unused: Vec<&str> = re!(r"^Unused noqa codes?: ([A-Z0-9, ]+);")
        .captures(&finding.detail)?
        .get(1)?
        .as_str()
        .split(", ")
        .collect();
    let row = finding.line.checked_sub(1)?;
    let start = match row {
        0 => 0,
        _ => source.match_indices('\n').nth(row - 1)?.0 + 1,
    };
    let line = source[start..].split_inclusive('\n').next()?;
    let text = line.trim_end_matches(['\n', '\r']);
    let codes = noqa_codes(source, &v.comments, start, start + line.len())?;
    let kept: Vec<&str> = codes_in(&source[codes.clone()])
        .filter(|c| !unused.contains(c))
        .collect();
    let (at, end, replacement) = if kept.is_empty() {
        // From the slashes that open the directive, and the blanks before.
        let slashes = re!(r"/+[ \t]*(?i:noqa)[ \t]*:[ \t]*$")
            .find(&source[start..codes.start])?
            .start();
        let at = start
            + source[start..start + slashes]
                .trim_end_matches([' ', '\t'])
                .len();
        if at == start {
            return None;
        }
        (at, start + text.len(), String::new())
    } else {
        (codes.start, codes.end, kept.join(", "))
    };
    let mut edited = source.to_string();
    edited.replace_range(at..end, &replacement);
    let after = views(&edited);
    let comment_only = |before: &str, after: &str| {
        let (before, after) = (before.as_bytes(), after.as_bytes());
        let added = at + replacement.len();
        before[..at] == after[..at]
            && before[at..end].iter().all(|&b| b == b' ')
            && after[at..added].iter().all(|&b| b == b' ')
            && before[end..] == after[added..]
    };
    (comment_only(&v.code, &after.code) && comment_only(&v.comments, &after.comments)).then(|| {
        Fix {
            start: at,
            end,
            replacement: replacement.into(),
            title: if kept.is_empty() {
                "Remove the unused noqa".into()
            } else {
                format!("Remove {} from the noqa", unused.join(", ")).into()
            },
            batch_safe: false,
        }
    })
}

/// The code lists of the file's `/ qlinter: noqa: CODE` directives, each as
/// the span of the source that lists them. Only a whole comment line at the
/// left margin, with a blank after its `/` - a bare `/` opens a block - and
/// never one inside a block comment or after the line that ends the script,
/// which q does not read as a line at all.
fn file_noqa(source: &str, v: &Views) -> Vec<std::ops::Range<usize>> {
    let (raw, blanked) = (source.as_bytes(), v.comments.as_bytes());
    let mut out = vec![];
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        // `views` reads `<BOM>/ note` as a comment line (#221).
        let at = if start == 0 && source.starts_with('\u{feff}') {
            3
        } else {
            start
        };
        if raw.get(at) != Some(&b'/') || blanked.get(at) != Some(&b' ') {
            continue;
        }
        if v.in_block(at) || v.script_end.is_some_and(|end| at >= end) {
            continue;
        }
        if let Some(codes) = re!(
            r"^/+[ \t]+(?i:qlinter)[ \t]*:[ \t]*(?i:noqa)[ \t]*:[ \t]*([A-Z]+[0-9]+\b(?:[ \t]*,[ \t]*[A-Z]+[0-9]+\b|[ \t]+[A-Z]+[0-9]+\b)*)"
        )
        .captures(&source[at..offset])
        .and_then(|c| c.get(1))
        {
            out.push(at + codes.start()..at + codes.end());
        }
    }
    out
}

/// The edit that accepts `finding` everywhere in its file: its code added to
/// the file's `/ qlinter: noqa:` directive, or a new directive line at the
/// top of the file - after a `#!` line, which must stay first, and after a
/// byte-order mark. `None` where the code is not one a directive can name,
/// the file's brackets or strings do not close (as `suppression_for`), or
/// the edit would be read as anything but that directive: the edited source
/// must mask exactly as the original does, the new text blank in both views,
/// and its directive must name the code. Never batch-safe.
pub fn file_suppression_for(finding: &Finding, source: &str) -> Option<Fix> {
    let code = finding.code.as_str();
    if !re!(r"^[A-Z]+[0-9]+$").is_match(code) {
        return None;
    }
    let v = views(source);
    if !problems(source, &v).is_empty() {
        return None;
    }
    let directives = file_noqa(source, &v);
    if directives
        .iter()
        .any(|codes| codes_in(&source[codes.clone()]).any(|c| c == code))
    {
        return None;
    }
    let (at, replacement) = match directives.first() {
        Some(codes) => (codes.end, format!(", {code}")),
        None => {
            let bom = if source.starts_with('\u{feff}') { 3 } else { 0 };
            let first = &source[bom..];
            let at = if first.starts_with("#!") {
                first.find('\n').map_or(source.len(), |n| bom + n + 1)
            } else {
                bom
            };
            let newline = if source.contains("\r\n") {
                "\r\n"
            } else {
                "\n"
            };
            // A shebang with no newline after it ends the file.
            let lead = if at == source.len() && at > bom {
                newline
            } else {
                ""
            };
            (at, format!("{lead}/ qlinter: noqa: {code}{newline}"))
        }
    };
    let mut edited = source.to_string();
    edited.insert_str(at, &replacement);
    let after = views(&edited);
    let added = at + replacement.len();
    let comment_only = |before: &str, after: &str| {
        let (before, after) = (before.as_bytes(), after.as_bytes());
        before[..at] == after[..at]
            && after[at..added]
                .iter()
                .all(|&b| b == b' ' || b == b'\n' || b == b'\r')
            && before[at..] == after[added..]
    };
    let named = file_noqa(&edited, &after)
        .into_iter()
        .any(|codes| codes_in(&edited[codes]).any(|c| c == code));
    (named && comment_only(&v.code, &after.code) && comment_only(&v.comments, &after.comments))
        .then(|| Fix {
            start: at,
            end: at,
            replacement: replacement.into(),
            title: format!("Suppress {code} in this file").into(),
            batch_safe: false,
        })
}

/// The edit that accepts `finding` where it is reported: ` / noqa: CODE`
/// after its line, or the code added to the `noqa` already there. `None`
/// where no comment on that line would be one, or would be read as the
/// directive - there is no correct suppression to offer then, and a wrong
/// one is worse than none:
///
/// - a line that ends inside a string: the text would join the string;
/// - a system command, whose argument runs to the end of its line, and a
///   `k)` or `p)` line, which is another language's to read;
/// - a block comment - its bare `/` and `\` stop being bare with anything
///   after them - and what follows the line that ends the script;
/// - a blank line, where the comment would trail nothing;
/// - a file whose brackets or strings do not close. That is reported alone
///   (QE001), and accepting it would put every finding it stood in front of
///   in its place.
///
/// A finding that spans lines is accepted on its first, which is the line
/// `suppress` looks it up by. And the edit is checked rather than trusted:
/// the edited source must mask exactly as the original does, with the new
/// text blank in both views - a comment, and nothing else read differently -
/// and its line must name the code to `noqa_codes`.
///
/// Never batch-safe: accepting a finding is a person's decision, one line at
/// a time, and `--fix` must never make it for them.
pub fn suppression_for(finding: &Finding, source: &str) -> Option<Fix> {
    suppressions_for([finding], source).pop()?
}

/// `suppression_for` each of many findings in one source, in their order,
/// masking it once for them all as `fixes_for` does. Each edit is still
/// checked against a masking of its own: that is the cost of one here.
pub fn suppressions_for<'a>(
    findings: impl IntoIterator<Item = &'a Finding>,
    source: &str,
) -> Vec<Option<Fix>> {
    let v = views(source);
    let balanced = problems(source, &v).is_empty();
    findings
        .into_iter()
        .map(|finding| {
            balanced
                .then(|| suppression_with(finding, source, &v))
                .flatten()
        })
        .collect()
}

fn suppression_with(finding: &Finding, source: &str, v: &Views) -> Option<Fix> {
    let code = finding.code.as_str();
    if !re!(r"^[A-Z]+[0-9]+$").is_match(code) {
        return None;
    }
    let row = finding.line.checked_sub(1)?;
    let start = match row {
        0 => 0,
        _ => source.match_indices('\n').nth(row - 1)?.0 + 1,
    };
    let line = source[start..].split_inclusive('\n').next()?;
    let text = line.strip_suffix('\n').unwrap_or(line);
    let text = text.strip_suffix('\r').unwrap_or(text);
    let in_block = v.in_block(start);
    if text.trim().is_empty()
        || in_block
        || system_command(line)
        || v.script_end.is_some_and(|end| start >= end)
        || v.foreign_offsets.binary_search(&start).is_ok()
    {
        return None;
    }
    // Added to the directive already there, before any reason it gives; or
    // put after the line, in place of the blanks that end it.
    let (at, end, replacement) = match noqa_codes(source, &v.comments, start, start + line.len()) {
        Some(codes) => (codes.end, codes.end, format!(", {code}")),
        // Only blanks are replaced: nothing q reads goes with them.
        None => (
            start + text.trim_end_matches([' ', '\t']).len(),
            start + text.len(),
            format!(" / noqa: {code}"),
        ),
    };
    let mut edited = source.to_string();
    edited.replace_range(at..end, &replacement);
    let after = views(&edited);
    let comment_only = |before: &str, after: &str| {
        let (before, after) = (before.as_bytes(), after.as_bytes());
        let added = at + replacement.len();
        before[..at] == after[..at]
            && after[at..added].iter().all(|&b| b == b' ')
            && before[end..] == after[added..]
    };
    let line_end = start + line.len() - (end - at) + replacement.len();
    let named = noqa_codes(&edited, &after.comments, start, line_end)
        .is_some_and(|codes| codes_in(&edited[codes]).any(|c| c == code));
    (named && comment_only(&v.code, &after.code) && comment_only(&v.comments, &after.comments))
        .then(|| Fix {
            start: at,
            end,
            replacement: replacement.into(),
            title: format!("Suppress {code} on this line").into(),
            batch_safe: false,
        })
}

/// The edit that organises a file's loads, as isort does a Python file's
/// imports: in each run of consecutive `\l` lines, a path loaded twice is
/// loaded once, at its first place, and the rest are sorted - absolute paths
/// (`/`, `~`, `$`, a drive) first and relative ones after, each group by
/// path without regard to case, with a blank line between the two. `None`
/// when nothing would change.
///
/// Loads run in order, and a later file can read what an earlier one
/// defined, so this is a person's decision, made where they ask for it - it
/// is not a fix, and `--fix` never makes it. What it leaves alone, so as not
/// to change more than order: a run with a load that is not a `.q` or `.k`
/// file - `\l db` loads a database and changes directory, which every
/// relative load after it depends on - lines separated by anything at all,
/// a blank line included, which keeps a person's grouping; a load in a block
/// comment or after the line that ends the script; and a file whose
/// brackets or strings do not close.
pub fn organise_loads(source: &str) -> Option<Fix> {
    let v = views(source);
    if !problems(source, &v).is_empty() {
        return None;
    }
    let skipped = |at: usize| v.in_block(at) || v.script_end.is_some_and(|end| at >= end);
    // Each line: where it starts, its text, its line ending, and its path
    // when it is a load.
    let mut lines: Vec<(usize, &str, &str, Option<&str>)> = vec![];
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let ending = &line[body.len()..];
        let path = re!(r"^\\l[ \t]+(\S(?:.*\S)?)[ \t]*$")
            .captures(body)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .filter(|_| !skipped(offset));
        lines.push((offset, body, ending, path));
        offset += line.len();
    }
    let mut edited = String::with_capacity(source.len());
    let mut i = 0;
    while i < lines.len() {
        let (start, body, ending, path) = lines[i];
        if path.is_none() {
            edited.push_str(&source[start..start + body.len() + ending.len()]);
            i += 1;
            continue;
        }
        let run_end = (i..lines.len())
            .find(|&j| lines[j].3.is_none())
            .unwrap_or(lines.len());
        let run = &lines[i..run_end];
        let paths: Vec<&str> = run.iter().filter_map(|l| l.3).collect();
        let files = paths
            .iter()
            .all(|p| re!(r"(?i)\.[qk]$").is_match(p) && !p.contains(char::is_whitespace));
        let text =
            |l: &(usize, &str, &str, Option<&str>)| &source[l.0..l.0 + l.1.len() + l.2.len()];
        if !files {
            run.iter().for_each(|l| edited.push_str(text(l)));
            i = run_end;
            continue;
        }
        let newline = run
            .iter()
            .map(|l| l.2)
            .find(|e| !e.is_empty())
            .unwrap_or("\n");
        let last_ending = run.last().map_or("", |l| l.2);
        let mut seen = std::collections::HashSet::new();
        let mut kept: Vec<(&str, &str)> = run
            .iter()
            .filter(|l| seen.insert(l.3.unwrap()))
            .map(|l| (l.3.unwrap(), l.1))
            .collect();
        let absolute =
            |p: &str| p.starts_with(['/', '~', '$', '\\']) || re!(r"^[A-Za-z]:[\\/]").is_match(p);
        kept.sort_by_key(|&(p, _)| (!absolute(p), p.to_lowercase(), p.to_string()));
        let mut out: Vec<&str> = vec![];
        for (n, &(p, line)) in kept.iter().enumerate() {
            if n > 0 && absolute(kept[n - 1].0) && !absolute(p) {
                out.push("");
            }
            out.push(line);
        }
        edited.push_str(&out.join(newline));
        edited.push_str(last_ending);
        i = run_end;
    }
    let mut fix = whole_edit(source, &edited)?;
    fix.title = "Organise loads".into();
    fix.batch_safe = false;
    Some(fix)
}

/// A text as an editor holds it, and whether a BOM came before it. An
/// editor reads a leading BOM as the file's encoding, not as a character of
/// line 1: it neither shows it nor counts it in a column. The language
/// server reads every closed file through this (#2027), and the CLI places
/// what it reports by it (#2097), so the two agree with each other and with
/// the editor.
pub fn as_an_editor_holds(text: &str) -> (&str, bool) {
    match text.strip_prefix('\u{feff}') {
        Some(rest) => (rest, true),
        None => (text, false),
    }
}

/// `findings` of `source` placed where an editor shows them: in a file that
/// starts with a BOM, every column on line 1 is one UTF-16 unit left of where
/// the rules, which read the BOM as the character it is, count it. QE005
/// alone stays: it is the BOM's own, at 1:1.
pub fn placed_as_an_editor_shows<'a>(
    findings: impl IntoIterator<Item = &'a mut Finding>,
    source: &str,
) {
    if !as_an_editor_holds(source).1 {
        return;
    }
    for f in findings
        .into_iter()
        .filter(|f| f.line == 1 && f.code != "QE005")
    {
        f.column = f.column.map(|c| c.saturating_sub(1).max(1));
        if f.end_line.is_none_or(|l| l == 1) {
            f.end_column = f.end_column.map(|c| c.saturating_sub(1).max(1));
        }
    }
}

pub fn lint(source: &str, path: &str, profile: Profile) -> Vec<Finding> {
    lint_in(source, path, profile, &Workspace::default())
}

/// `lint`, with the definitions of the files around this one. A name another
/// file defines is not undefined here, and a name another file assigns is not
/// one whose value this file can know.
pub fn lint_in(source: &str, path: &str, profile: Profile, ws: &Workspace) -> Vec<Finding> {
    lint_selecting(source, path, profile, ws, true)
}

/// `lint_in`, told whether the configuration reports QE001 here. A file
/// whose brackets do not balance is reported for that alone, since every
/// other rule reads its structure; but when that finding is suppressed - by
/// a `noqa` on its line or by deselecting QE001 - the other rules still run,
/// rather than the suppression silencing the whole file.
pub fn lint_selecting(
    source: &str,
    path: &str,
    profile: Profile,
    ws: &Workspace,
    structure_selected: bool,
) -> Vec<Finding> {
    lint_rules(source, path, profile, ws, structure_selected, false)
}

/// Every rule this binary has, the `opt-in` ones too: what a configuration
/// filters down to the rules it selects. No profile reports an `opt-in`
/// rule, so there is no `Profile` to ask for one with; `structure_selected`
/// is `lint_selecting`'s.
pub fn lint_every_rule(
    source: &str,
    path: &str,
    ws: &Workspace,
    structure_selected: bool,
) -> Vec<Finding> {
    lint_rules(source, path, Profile::Uqf, ws, structure_selected, true)
}

fn lint_rules(
    source: &str,
    path: &str,
    profile: Profile,
    ws: &Workspace,
    structure_selected: bool,
    opt_in: bool,
) -> Vec<Finding> {
    let uqf = profile == Profile::Uqf;
    let _lines = LineScope::install(source);
    let mut v = views(source);
    // The lines QE001 reports on, before a `noqa` takes any: QL003 asks.
    let mut structure_lines = vec![];
    if structure_selected {
        let mut out = structure(path, source, &v);
        structure_lines = out.iter().map(|f| f.line).collect();
        suppress(&mut out, source, &v);
        if !out.is_empty() {
            out.truncate(1);
            return out;
        }
    }
    prompts_start_statements(source, &mut v);
    let code = &v.code;
    let _matches = MatchScope::install(code);
    // A name the file adds to `.q` is reserved from there on, as a builtin
    // is: after q 5 `.q.foo:{x+1}`, `{[x;foo] x}[5;6]` is 'nyi and
    // `{foo:1;0}` and `foo:1` are 'assign (#434).
    let dotq = dotq_definitions(code, source);
    let reserved = |name: &str, at: usize| {
        RESERVED.iter().any(|n| n == name) || dotq.iter().any(|(n, from)| n == name && at > *from)
    };
    // A UTF-8 BOM is not something q tolerates: it reports 'char on the first
    // line and loads nothing. Reported and then carried on past, because the
    // author still wants to know what else is wrong with a file they are
    // about to find unloadable.
    let mut out = semantics::check(path, code, source, &v.comments, ws);
    if source.starts_with('\u{feff}') {
        let mut finding = Finding::at(
            path,
            source,
            0,
            "QE005",
            "Byte-order mark: q reports 'char on the first line and will not load the file".into(),
        );
        finding.end_column = Some(2); // The BOM is one UTF-16 code unit.
        out.push(finding);
    }
    out.extend(intrinsics::check(path, source, code, &v.comments));
    out.extend(families::check(
        path,
        source,
        code,
        &v.comments,
        &v.foreign_offsets,
    ));
    out.extend(refusals::check(path, source, code, &v.comments));
    out.extend(semantics::typelint::check(path, code, source, &v.comments));
    // The QK rules report for a configuration's target version, which only
    // a configuration names: `lint_every_rule` is how one asks.
    if opt_in {
        out.extend(semantics::version::check(path, code, source));
    }
    if let Some(at) = v.open_block {
        out.push(Finding::at(
            path,
            source,
            at,
            "QE003",
            "This bare slash opens a block comment that no later backslash \
             closes, so the rest of the file is comment"
                .into(),
        ));
    }
    let mut add = |at: usize, id: &str, detail: String| {
        let mut finding = Finding::at(path, source, at, id, detail);
        // Every QE004 spelling is two ASCII characters. Keep its diagnostic
        // on the operator so an editor requests the fix for the right one.
        if id == "QE004" {
            let len = if source[at..].starts_with("<=>") {
                3
            } else {
                2
            };
            finding.end_column = finding.column.map(|column| column + len);
        }
        out.push(finding);
    };
    for brace in code.match_indices('{').map(|(i, _)| i) {
        let sig = signature(code, source, brace);
        let at = brace;
        let offenders: Vec<&str> = sig
            .slots
            .iter()
            .copied()
            .filter(|s| !s.is_empty() && !is_param_name(s))
            .collect();
        // `_` has its own code because it has its own cause: it reads as a
        // name but is the drop operator. q 5 defines the lambda and keeps no
        // usable name for the slot - `{[_] 1}[]`, `{[_] 1}[1]` and
        // `{[a;_] a}[1;2]` are each 'match - so it fails on every call.
        // Inside a pattern it is the same: q 5 binds `{[(a;_)] a}` as a
        // one-argument pattern and `{[(a;_)] a}[(1;2)]` is 'match (#338).
        // Either way the brackets are a signature (#443), unless another
        // slot is not.
        let underscore = |s: &str| {
            Some(s)
                .filter(|s| s.contains('_') && is_pattern(&s.replace('_', "u"), false))
                .and_then(|s| underscore_binding(s, 0))
        };
        let underscore_in = |s: &str| underscore(s).is_some();
        let kinds: Vec<bool> = offenders.iter().filter_map(|s| underscore(s)).collect();
        if !kinds.is_empty() {
            add(
                at,
                "QF002",
                if kinds.contains(&true) {
                    "`_` as a lambda parameter: q 5 refuses every call with 'match"
                } else {
                    "A parameter name starting with `_`: q 5 refuses the lambda where it is \
                     defined with '_"
                }
                .into(),
            );
        }
        if !sig.named {
            // Not a parameter list, so none of the rules below apply to it -
            // and neither does the rank the source appears to declare.
            if !sig.slots.is_empty() {
                let underscore = offenders.iter().any(|s| underscore_in(s));
                let rest: Vec<&str> = offenders
                    .into_iter()
                    .filter(|s| !underscore_in(s))
                    .collect();
                // A string literal is blank by the time the rules see it, so
                // there is nothing to quote back - it is still why q refused
                // to read the brackets as a signature.
                let subject = if !rest.is_empty() {
                    format!("{rest:?} is not a parameter name")
                } else if underscore {
                    String::new()
                } else {
                    "A literal is not a parameter name".into()
                };
                // q 5 refuses each where the lambda is defined: an operator,
                // a builtin applied, an iterator or a literal head is 'nyi -
                // `{[a+b] x}`, `{[count x] 1}`, `{[a'] 1}`, `{[1 a] 1}`. A
                // literal, a typed slot or a name applied (`{[f x] 1}`) is a
                // pattern and never gets here (`is_pattern`, #484).
                let consequence = if rest
                    .iter()
                    .any(|s| re!(r"^[-0-9.\s]*\.[-0-9.\s]*$").is_match(s))
                {
                    // A literal with a stray dot: q 5 refuses `{[..] 1}`
                    // with '. and `{[1 .] 1}` with 'nyi (#594).
                    "q 5 refuses the lambda where it is defined"
                } else {
                    "q 5 refuses the lambda where it is defined: 'nyi"
                };
                if !subject.is_empty() {
                    add(at, "QF007", format!("{subject}, so {consequence}"));
                }
            }
            // No parameter list: the rank is the highest of x, y and z its own
            // body reads - nested lambdas have their own - and at least 1.
            // Verified in q 5: `{x+y}[1;2;3]` and `{x}[1;2]` are both 'rank.
            if let Some(end) = matching(code, at, b'{', b'}') {
                let rest = code[end..].trim_start();
                let open = code.len() - rest.len();
                if rest.starts_with('[')
                    && !re!(r"\n\S").is_match(&code[end..open + 1])
                    && let Some(close) = matching(code, open, b'[', b']')
                {
                    let body = outside_query_phrases(&top_level(&code[at + 1..end - 1]));
                    // Not as the head of a dotted name: `y.z` is a global,
                    // and q 5 `{x+y.z}[1;2]` is 'rank.
                    let reads = |name: &str| {
                        // A name starts with a letter: `_y` in `1_y` is a
                        // drop and `y` (#339).
                        re!(r"[A-Za-z][A-Za-z0-9_]*").find_iter(&body).any(|w| {
                            w.as_str() == name
                                && boundary(&body, w.start())
                                && !body[w.end()..].starts_with('.')
                        })
                    };
                    let rank = if reads("z") {
                        3
                    } else if reads("y") {
                        2
                    } else {
                        1
                    };
                    let count = slots(&code[open + 1..close - 1]).len();
                    if count > rank {
                        add(
                            open,
                            "QA002",
                            format!(
                                "{count} argument slots applied to a literal lambda that takes \
                                 {rank}: without a parameter list it takes x, y and z up to the \
                                 highest its body reads, and at least x"
                            ),
                        );
                    }
                }
            }
            continue;
        }
        // From qbists/style, on default arguments:
        //
        //   "Be consistent in your use of `x`, `y`, and `z` to mean the first,
        //    second, and third arguments to a function. If you don't use the
        //    default pattern provided by q, avoid using these letters as local
        //    variables, or as arguments occupying other positions in the
        //    argument list."
        //
        // `{[t;x] ...}` makes `x` the second argument, and every q reader
        // arrives expecting it to be the first.
        for (i, slot) in sig.slots.iter().enumerate() {
            if let Some(expected) = ["x", "y", "z"].iter().position(|n| n == slot)
                && expected != i
            {
                add(
                    at,
                    "QS008",
                    format!(
                        "`{slot}` is parameter {} here; q gives that name to argument {}",
                        i + 1,
                        expected + 1
                    ),
                );
            }
        }
        let params: Vec<_> = sig.slots.clone();
        // Every name a slot binds, a pattern's and a typed slot's included:
        // q 5 `{[(count;b)] b}[(1;2)]` is 'match (#327).
        let bound: Vec<&str> = params.iter().flat_map(|p| pattern_names(p)).collect();
        let bad: Vec<_> = bound.iter().filter(|p| reserved(p, at)).collect();
        // q 5 defines such a lambda but refuses every call to it: 'match for
        // a `.q` name such as count, 'nyi for a k primitive such as til.
        // The keywords by, do, from, if and while still run, and are left out.
        let bad: Vec<_> = bad
            .into_iter()
            .filter(|p| !matches!(**p, "by" | "do" | "from" | "if" | "while"))
            .collect();
        // A typed slot is refused where it is defined: q 5 `{[count:`j] 1}`
        // is 'assign.
        let typed = params
            .iter()
            .any(|p| typed_at(p).is_some() && pattern_names(p).iter().any(|n| bad.contains(&n)));
        // A qSQL keyword is worse: q 5 cannot parse the lambda at all, and a
        // script stops at its definition - `{[select] 1}` is 'from, and so
        // are exec, update and delete; inside a pattern, `{[(select;b)] b}`
        // is ',.
        if bad
            .iter()
            .any(|p| matches!(**p, "select" | "exec" | "update" | "delete"))
        {
            let error = if params
                .iter()
                .any(|p| matches!(*p, "select" | "exec" | "update" | "delete"))
            {
                "from"
            } else {
                ","
            };
            add(
                at,
                "QF001",
                format!(
                    "Builtin parameter name(s): {bad:?}; q refuses to define this lambda \
                     ('{error})"
                ),
            );
        } else if typed {
            add(
                at,
                "QF001",
                format!(
                    "Builtin parameter name(s): {bad:?}; q refuses to define this lambda \
                     ('assign)"
                ),
            );
        } else if !bad.is_empty() {
            add(
                at,
                "QF001",
                format!(
                    "Builtin parameter name(s): {bad:?}; q refuses every call to this lambda \
                     ('match or 'nyi)"
                ),
            );
        }
        // Each name `bound`, so a pattern's count too: q 5 defines
        // `{[(a;a)] a}` and `{[a;(a;b)] a}`, and one binding overwrites the
        // other (#635).
        let mut seen = std::collections::HashSet::new();
        let repeated: Vec<&&str> = bound.iter().filter(|p| !seen.insert(**p)).collect();
        if !repeated.is_empty() {
            add(
                at,
                "QF008",
                format!("Parameter {repeated:?} is declared more than once"),
            );
        }
        // `{[] ...}` is the one empty slot that means what it looks like.
        if params.len() > 1 && params.iter().any(|p| p.is_empty()) {
            add(
                at,
                "QF009",
                format!(
                    "An empty slot in the parameter list is still a parameter, so this lambda \
                     takes {} arguments",
                    params.len()
                ),
            );
        }
        if params.len() > 8 {
            add(
                at,
                "QA001",
                format!(
                    "Lambda declares {} parameters; q allows at most 8",
                    params.len()
                ),
            );
        }
        if let Some(end) = matching(code, at, b'{', b'}') {
            // In parentheses of its own it is still the function applied:
            // q 5 `({[a;b] a+b})[1;2;3]` is 'rank (#629).
            let end = parenthesised(code, at, end).unwrap_or(end);
            let rest = code[end..].trim_start();
            if rest.starts_with('[')
                && !re!(r"\n\S").is_match(&code[end..code.len() - rest.len() + 1])
            {
                let open = code.len() - rest.len();
                let arity = if params.iter().all(|p| p.is_empty()) {
                    0
                } else {
                    params.len()
                };
                if arity <= 8
                    && let Some((at, count, rank)) = over_applied(code, open, arity.max(1))
                {
                    add(
                        at,
                        "QA002",
                        if at == open {
                            format!(
                                "{count} argument slots applied to a {arity}-parameter literal lambda"
                            )
                        } else {
                            format!(
                                "{count} argument slots applied to a projection of a literal \
                                 lambda that takes {rank} more"
                            )
                        },
                    );
                }
            }
            // `each` supplies one argument, so a rank-2-or-more lambda
            // applied under it does not run: it returns projections, which
            // are silently wrong data rather than an error.
            let arity = if params.iter().all(|p| p.is_empty()) {
                0
            } else {
                params.len()
            };
            let rest = code[end..].trim_start();
            // `@'` is each as well: q 5 `{[a;b] a+b}@'1 2` is two projections.
            if arity >= 2
                && let Some(it) = re!(r"\A(?:(?:each|peach)\b|@')").find(rest)
            {
                add(
                    end,
                    "QA005",
                    peach_detail(it.as_str(), arity).unwrap_or_else(|| {
                        format!(
                            "`each` supplies one argument to a {arity}-parameter lambda, so the \
                             results are projections, not values"
                        )
                    }),
                );
            }
        }
    }
    for m in re!(r"@\[\s*\{\s*\[").find_iter(code) {
        let at = m.start();
        let brace = at + code[at..].find('{').unwrap();
        // The slots, not the `;`s: `{[(a;b)] a+b}` takes one argument (#324).
        let sig = signature(code, source, brace);
        if !sig.named {
            continue;
        }
        let arity = sig.slots.iter().filter(|p| !p.is_empty()).count();
        if let Some(end) = matching(code, brace, b'{', b'}') {
            let rest = code[end..].trim_start();
            let open = code.len() - rest.len();
            let mut supplied = 0;
            let mut after = end;
            if rest.starts_with('[')
                && let Some(close) = matching(code, open, b'[', b']')
            {
                supplied = slots(&code[open + 1..close - 1])
                    .iter()
                    .filter(|s| !s.trim().is_empty())
                    .count();
                after = close;
            }
            // An operand juxtaposed after it is one more argument: q 5
            // `@[{[a;b] a+b} 1;2;{x}]` is 3 and `@[{[f;a] f a}neg;1;{x}]` -1,
            // each a complete call (#433). On the next line too: inside the
            // brackets a line break is a blank (#686). A negative literal
            // past a blank is one too: `@[{[a;b] a+b} -1;2;{x}]` is 1 (#590).
            // Not `each` or `peach`, which apply it to each item with one
            // argument: q 5 `@[{[a;b] a+b} each;1 2;{x}]` is a list of
            // projections (#712).
            let next = &source[past_blanks(code, after)..];
            if (next.starts_with(|c: char| c.is_ascii_alphanumeric() || "`(\"{.".contains(c))
                && !re!(r"^p?each\b").is_match(next))
                || (past_blanks(code, after) > after && re!(r"^-\.?\d").is_match(next))
            {
                supplied += 1;
            }
            // Over or scan on a binary function, given one argument, reduces
            // it: q 5 `@[{[a;b] a+b}/;1 2;{x}]` is 3 and with `\` it is 1 3
            // (#514). Each, each-left and each-right still project.
            let iterated = re!(r"^\s*[/\\](?:[^:]|$)").is_match(&code[after..]);
            if arity.saturating_sub(supplied) >= 2 && !(iterated && arity - supplied == 2) {
                add(
                    at,
                    "QA003",
                    format!(
                        "`@` applies its function to one argument; this lambda still takes {}, \
                         so the result is a projection rather than a value, and the error \
                         handler never runs",
                        arity - supplied
                    ),
                );
            }
        }
    }
    // `$[c;a]`: one slot is a projection and three or more are conditional
    // expressions, but exactly two is an error q raises only at runtime.
    for (dollar, _) in code.match_indices("$[") {
        let Some(close) = matching(code, dollar + 1, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[dollar + 2..close - 1]);
        // With two slots and a type on the left, `$[...]` is not a
        // conditional at all but dyadic `$` in bracket form: `$[`long;1.5]`
        // is 2, `$[7h;2.5]` is 3 and `$["J";"12"]` is 12. A string is blank
        // in `code`, so its slot is read from the source.
        // Parentheses and `` `$"..." `` name a type too: q 5 gives 2 for
        // `$[(`long);1.5]` and for `$[`$"long";1.5]`.
        fn bare(mut s: &str) -> &str {
            while s.starts_with('(') && matching(s, 0, b'(', b')') == Some(s.len()) {
                s = s[1..s.len() - 1].trim();
            }
            s
        }
        let first_raw = bare(source[dollar + 2..dollar + 2 + parts[0].len()].trim());
        let cast = parts.len() == 2
            && (re!(r"^`[A-Za-z]*$|^\d+h$").is_match(bare(parts[0].trim()))
                || re!(r#"^(?:`\$\s*)?"[^"]*"$"#).is_match(first_raw));
        if cast {
            continue;
        }
        // Which slots are empty, judged in the view that keeps strings - a
        // string is blank in `code` - and blanks comments, so a comment in
        // a slot does not fill it.
        let mut from = dollar + 2;
        let empty: Vec<bool> = parts
            .iter()
            .map(|part| {
                let blank = v.comments[from..from + part.len()].trim().is_empty();
                from += part.len() + 1;
                blank
            })
            .collect();
        // Only two slots with one empty is a projection of `$`: `$[;y]` and
        // `$[t;]` are casts waiting for an argument (type 104, checked). From
        // three slots up it is a conditional whatever is empty - `$[0b;1;2;]`
        // runs, and returns null.
        if parts.len() == 2 && empty.contains(&true) {
            continue;
        }
        // `$` takes an atom. A vector condition is 'type every time, and it is
        // reached for by people expecting it to vectorise - `?[...]` is the
        // form that does. A symbol or a string is 'type for the same reason.
        // Verified: `$[101b;1;2]`, `$[1 2 3;1;2]`, `$[`a;1;2]` and `$["";1;2]`
        // all raise, while `$[1b;1;2]` and `$[1;1;2]` return 1.
        // The condition is read from `comments` as well, where a string is
        // still text. q 5 also refuses a string of other than one character,
        // a symbol or byte vector, and a float, real or guid atom: `$["ab";..]`,
        // `$[`a`b;..]`, `$[0x0102;..]`, `$[1.5;..]`, `$[0n;..]`, `$[1e;..]`.
        let cond_raw = v.comments[dollar + 2..dollar + 2 + parts[0].len()].trim();
        if let Some(cond) = parts.first().map(|c| c.trim())
            && refused_test(cond_raw, cond)
        {
            add(
                dollar,
                "QA011",
                format!(
                    "`$[{cond_raw};...]` is 'type: the condition must be a boolean, integer, char or temporal atom, and `?[...]` is the vector conditional"
                ),
            );
        }
        let n = parts.len();
        // Every later test is refused the same way once it is reached - a
        // symbol, a string of other than one char, a symbol or byte vector,
        // a float, a vector or `()`: q 5 `$[0b;1;`a;2;3]`, `$[0b;1;"ab";2;3]`,
        // `$[0b;1;101b;2;3]`, `$[0b;1;1 2 3;2;3]` and `$[0b;1;();2;3]` are
        // each 'type. (`$[0b;1;1 0 1b;2;3]` is 3, but `1 0 1b` is no vector:
        // it is 1 applied to 0 1b, the long atom 0.)
        let mut from = dollar + 2 + parts[0].len() + 1;
        for (k, part) in parts.iter().enumerate().skip(1) {
            let raw = v.comments[from..from + part.len()].trim();
            from += part.len() + 1;
            if k % 2 == 0 && k + 1 < n && refused_test(raw, part.trim()) {
                add(
                    dollar,
                    "QA011",
                    format!(
                        "`{raw}` as a later test of `$[...]` is 'type once it is reached: a test must be a boolean, integer, char or temporal atom"
                    ),
                );
            }
        }
        // QB025. A test written again later in the same conditional: if it
        // held the first time, its earlier branch ran, so the later branch
        // never runs - q 5 `$[x>1;`a;x>1;`b;`c]` is `c for 0 and `a for 2,
        // never `b. Nothing runs between the two evaluations but the tests
        // themselves, so only a test that could change its own value is left
        // alone: one that assigns, applies with brackets or a lambda, deals
        // (`?`), signals, or reads the clock, a random number or a handle.
        // So is a literal test.
        if n >= 4 {
            let mut from = dollar + 2;
            let mut tests: Vec<String> = vec![];
            for (k, part) in parts.iter().enumerate() {
                let start = from;
                from += part.len() + 1;
                if k % 2 != 0 || k + 1 >= n {
                    continue;
                }
                // Delimited in `comments`, where a string at either end is
                // still there to keep.
                let raw = &v.comments[start..start + part.len()];
                let at = start + raw.len() - raw.trim_start().len();
                let end = at + raw.trim().len();
                let test = &code[at..end];
                // A test with no name in it is a constant, the same every
                // time: `$[0b;1;0b;2]` is QA007's, and placeholder.
                if !re!(r"(?:^|[^`A-Za-z0-9_.])[A-Za-z]").is_match(test)
                    || test.contains([':', '[', '{', '?', '\''])
                    || re!(r"\.z\.|\b(?:rand|value|get|read0|read1|system|hopen|hclose|eval|reval|getenv|neg)\b")
                        .is_match(test)
                {
                    continue;
                }
                let text = same_test(&v.comments[at..end], &code[at..end]);
                if tests.contains(&text) {
                    add(
                        at,
                        "QB025",
                        format!(
                            "`{}` repeats an earlier test of this $[...]: when it holds, the \
                             earlier branch runs, so this branch never does",
                            v.comments[at..end].trim()
                        ),
                    );
                } else {
                    tests.push(text);
                }
            }
        }
        if n == 2 {
            // Two slots is the cast, and both slots are evaluated before it:
            // when the second is a signal it fires whatever the first holds.
            // Verified: `{[b] $[b;'`boom]}` raises 'boom for 1b and for 0b,
            // so TorQ's `$[b;'err...]; :0b` never reaches its `:0b`.
            let second_start = dollar + 2 + parts[0].len() + 1;
            let signal = v.comments[second_start..second_start + parts[1].len()]
                .trim_start()
                .starts_with('\'');
            // Otherwise two slots are dyadic `$`, and q 5 defines it for more
            // than a type on the left: `$[m;flip m]` multiplies two float
            // matrices and `$[5;"abc"]` pads (#295). What it refuses with
            // 'type is a boolean there - `$[1b;2]`, `$[1=1;2]`, `$[not 0b;2]`.
            // Only a test the text shows to be boolean is reported: a name
            // (`$[c;x]`) could hold a matrix, a count or a type, so it is not.
            if !signal && !boolean_test(bare(parts[0].trim())) {
                continue;
            }
            add(
                dollar,
                "QA006",
                if signal {
                    "Two-slot $[ ... ] is no conditional: both slots always run, so this \
                     signal fires whether or not the test holds"
                } else {
                    "Two-slot $[ ... ] is no conditional q defines; it errors 'type at runtime"
                }
                .into(),
            );
        } else if n >= 4 && n.is_multiple_of(2) {
            // `$[c1;a;c2;b]` pairs every slot off as test-and-result and has
            // nothing left for the else: when no test holds it returns `::`,
            // silently. Verified: `$[0b;1;0b;2]` is `::`, `$[0b;1;0b;2;3]` is 3.
            //
            // A trailing `;` is the common way in: `$[c;a;b;]` reads as an
            // if-else, but b is the second test and the empty slot its result.
            // Verified: `$[0b;1;2;]` is `::`, and `$[0b;`a;`b;]` is 'type.
            // When that last test is a literal no test may be - a symbol, a
            // string - reaching it is 'type rather than null.
            let last: usize = parts[..n - 2].iter().map(|p| p.len() + 1).sum();
            let last = dollar + 2 + last;
            let test = v.comments[last..last + parts[n - 2].len()].trim();
            let outcome = if refused_test(test, parts[n - 2].trim()) {
                format!("and q 5 refuses `{test}` as a test with 'type")
            } else {
                "and the result is null".into()
            };
            let detail = if empty.last() == Some(&true) {
                format!(
                    "The trailing `;` makes this a {n}-slot conditional, not an if-else: the \
                     slot before it is run as another test, {outcome}"
                )
            } else if refused_test(test, parts[n - 2].trim()) {
                format!(
                    "{n}-slot $[ ... ] has no else branch: when no other condition holds it \
                     runs `{test}` as a test, which q 5 refuses with 'type"
                )
            } else {
                format!(
                    "{n}-slot $[ ... ] has no else branch: when no condition holds it \
                     returns null, not an error"
                )
            };
            add(dollar, "QA007", detail);
        }
    }
    // The test of `if` and `while` and the count of `do` are refused for
    // the same literals as the first test of `$[...]`: q 5 `if[`a;1]`,
    // `while["ab";1]`, `if[101b;1]`, `if[1 2;1]`, `do[1.5;1]`, `do[`a;1]`
    // and `do[1 2;1]` are each 'type, while `if[0N;1]`, `do["a";1]`,
    // `do[1b;1]`, `do[2h;1]` and `do[2024.01.01;1]` run.
    // The bracket may follow a blank, or an indented next line: q 5 reads
    // `if` over `  [`a;:1]` as `if[`a;:1]` (#574).
    for m in re!(r"\b(if|while|do)[ \t]*(?:(?:\r?\n[ \t]*)*\r?\n[ \t]+)?\[").captures_iter(code) {
        let at = m.get(0).unwrap().start();
        let open = m.get(0).unwrap().end() - 1;
        if !boundary(code, at) {
            continue;
        }
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[open + 1..close - 1]);
        if parts.len() < 2 {
            continue;
        }
        let raw = v.comments[open + 1..open + 1 + parts[0].len()].trim();
        if refused_atom_condition(raw)
            || re!(r"^\(\s*\)$").is_match(raw)
            || re!(r"^[01]{2,}b$").is_match(raw)
            || (re!(r"^-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)+$").is_match(raw)
                && !raw.ends_with('b'))
        {
            let what = if &m[1] == "do" { "count" } else { "test" };
            add(
                at,
                "QA011",
                format!(
                    "`{}[{raw};...]` is 'type: the {what} must be a boolean, integer, char or temporal atom",
                    &m[1]
                ),
            );
        }
    }
    // Symbols take no arithmetic: `2+`a`, `` `a*2 `` and `2%`b` are all
    // 'type errors. Chars are another matter, version by version - see
    // QT023 - so this rule is a symbol literal next to an infix + - * % and
    // nothing more.
    // Between the symbol and the operator, the statement's blanks: a symbol
    // ending one line and a `-1"..."` print opening the next at column 0 are
    // two statements, not a subtraction - the commonest shape in public q -
    // but an indented line continues it, on either side of the operator and
    // past blank and comment lines (#224, #688).
    // `&` and `|` are min and max, and 'type on a symbol too, as are the
    // word operators (q 5: `a&`b, `a mod 2, 2 xexp `a). Not `^`: a
    // symbol fills a symbol list (`none^s).
    // The null symbol, a lone backtick, is one too: q 5 `` ` + 1 `` is 'type.
    // So is a name that starts with `.` or holds a `:` past its first
    // character: `` `.a+1 `` and `` `a:b+1 `` (q 5: 'type, #600).
    let arithmetic = re!(concat!(
        r"(?:`(?:\.?[A-Za-z][A-Za-z0-9_.:]*)?)+(?:",
        blank!(),
        r"*[+\-*%&|]|",
        blank!(),
        r"+(?:mod|div|xexp|xlog|and|or)[ \t])|(?:[+\-*%&|][ \t]*(?:(?:\r?\n[ \t]*)*\r?\n[ \t]+)?|[ \t](?:mod|div|xexp|xlog|and|or)(?:[ \t]*(?:\r?\n[ \t]*)*\r?\n[ \t]+|[ \t]+))(?:`(?:\.?[A-Za-z][A-Za-z0-9_.:]*)?)+"
    ));
    // Searched one match at a time: a symbol rejected as the right operand
    // may still be the left one of the operator after it - `` 1+`a+1 `` is
    // `` 1+(`a+1) `` - so the search resumes at that symbol (#721).
    let mut from = 0;
    while let Some(m) = arithmetic.find_at(code, from) {
        from = m.end();
        let at = m.start();
        // `like `a*` is a glob, not a product; QB007 owns that one.
        if code[..at].trim_end().ends_with("like") {
            continue;
        }
        // `` `long$x `` is a cast, and the symbol names the type rather than
        // being an operand: `` `long$x-`long$y `` is subtraction of two longs,
        // which q is perfectly happy to evaluate.
        if code[m.end()..].starts_with('$') {
            continue;
        }
        // `` `a -1 ``: a space before the minus and a digit straight after it
        // make a negative literal, and the symbol is applied to it - q 5
        // `parse "`a -1"` is `(,`a;-1)` (#293). `` `a-1 `` and `` `a - 1 ``
        // subtract, and are 'type.
        if m.as_str().starts_with('`')
            && re!(r"[ \t]-$").is_match(m.as_str())
            && re!(r"^\.?\d").is_match(&code[m.end()..])
        {
            continue;
        }
        // A glyph with nothing on its left is monadic, and q 5 refuses
        // `` -`a `` at parse with '-, not 'type: QE008 reports that (#613).
        if m.as_str().starts_with(['+', '-', '*', '%', '&', '|']) {
            let line_start = code[..at].rfind('\n').map_or(0, |n| n + 1);
            let expression = line_start + timed_prefix(&source[line_start..]);
            if refusals::opens_expression(code, source, &v.comments, at, expression) {
                continue;
            }
        }
        // A symbol on the right is only the operand when the expression ends
        // with it: `` 2*`a`b?`b `` multiplies by a long, and `` 1+`a`b!1 2 ``
        // adds to a dictionary. On the left it is the operand whatever
        // follows, since everything to the right is evaluated first.
        if !m.as_str().starts_with('`') && !operand_ends(code, &v.comments, m.end()) {
            from = m.start() + m.as_str().find('`').unwrap();
            continue;
        }
        // Unless what is on its right ends in an operator: that is a
        // projection, and the symbol composes with it - q 5 `` `+n% `` is
        // `+[`]%[n]`, no error - as a template's `` `%name%] `` reads.
        // Nothing on its right at all is a projection too: `` `a+ ``,
        // `` (`a*;1) `` and `` f[`a%] `` build `+[`a]` and run (q 5, #599).
        if m.as_str().starts_with('`') && operand_ends(code, &v.comments, m.end()) {
            continue;
        }
        if m.as_str().starts_with('`') {
            let end = phrase_end(code, m.end());
            let end = code[m.end()..end].find('\n').map_or(end, |n| m.end() + n);
            if code[m.end()..end]
                .trim_end()
                .ends_with(['+', '-', '*', '%', '&', '|'])
            {
                continue;
            }
        }
        add(
            at,
            "QT003",
            "Arithmetic on a symbol literal is a 'type error at runtime".into(),
        );
    }
    // A symbol compares with a symbol and nothing else. Against a number or a
    // string it is 'type, and both spellings appear in real mistakes:
    // `1=`a` and `"abc"=`abc`. Verified that the neighbours are fine - `1="a"`
    // is 0b because a char compares by its code, `` `a=`b `` is 0b, and `~`
    // never raises - so only a symbol facing a non-symbol is reported.
    {
        // A symbol, or a symbol vector: `1 in `a`b` is 'type just as `1=`a` is,
        // and the vector is what `in` is usually given.
        // A file symbol too, `` `:db/t ``, which runs on over `/` (q 5).
        let sym = r"(?:`(?:\.?[A-Za-z][A-Za-z0-9_.:]*|:[A-Za-z0-9_.:/]*))+";
        // An exponent's sign is part of its number: `1e-3` is one float.
        let num =
            r"-?\.?\d(?:e-|e\+\d|[A-Za-z0-9.:])*(?:[ \t]+-?\.?\d(?:e-|e\+\d|[A-Za-z0-9.:])*)*";
        let string = r#""(?:[^"\\]|\\.)*""#;
        let op = r"(?:<=|>=|<>|<|>|=|\bin\b)";
        // A string literal is blanks by the time `code` is built, so the
        // string half of this reads `v.comments`, which keeps strings and
        // blanks comments. A quote there is not necessarily one that opens a
        // string - `("";"=`b")` has `";"` between two - so the string operand
        // has to start where `views` saw a string start.
        // Around the operator, the statement's blanks: `match:`x=` and then a
        // column-0 `1 2 3` are two statements (#743).
        let gap = concat!(blank!(), "*");
        for (pattern, view, quoted) in [
            (
                format!(r"({sym}){gap}{op}{gap}({num})"),
                code.as_str(),
                None,
            ),
            (
                format!(r"({num}){gap}{op}{gap}({sym})"),
                code.as_str(),
                None,
            ),
            (
                format!(r"({string}){gap}{op}{gap}({sym})"),
                v.comments.as_str(),
                Some(1),
            ),
            (
                format!(r"({sym}){gap}{op}{gap}({string})"),
                v.comments.as_str(),
                Some(2),
            ),
        ] {
            // A match that starts inside a name, the `2` of `b2:1=`a`, is
            // looked past rather than taking the comparison with it.
            for m in boundary_captures(&regex::Regex::new(&pattern).unwrap(), view, view) {
                let (at, end) = (m.get(0).unwrap().start(), m.get(0).unwrap().end());
                if let Some(group) = quoted
                    && v.string_starts
                        .binary_search(&m.get(group).unwrap().start())
                        .is_err()
                {
                    continue;
                }
                // Both operands have to be whole. q reads right to left, so
                // the right one is everything to the right of the operator:
                // `` `a in 2 sublist s `` asks about a list of symbols, and
                // `` 1=`a`b?`b `` compares two longs. A symbol before `$` names
                // a cast, and `` `time in 0!t `` unkeys a table. So the
                // comparison has to end here, or it was never this one.
                if !operand_ends(view, &v.comments, end) {
                    continue;
                }
                add(
                    at,
                    "QT015",
                    format!(
                        "`{}` is 'type: a symbol compares with a symbol, not with a number or a string",
                        m.get(0).unwrap().as_str().trim()
                    ),
                );
            }
        }
    }
    // The single-letter `.z` names are the system's own values - `.z.p` the
    // time, `.z.i` the pid, `.z.x` the command line - and q refuses every
    // assignment to one with 'domain, however it is written: `:`, `::`, an
    // amend, an indexed assignment or `set`. Verified for all 52 letters on
    // q 5, where `.z.m` alone takes an assignment: `.z.m:{x}` succeeds.
    // The longer names are the callbacks (`.z.pg`, `.z.ts`, `.z.exit`), and
    // assigning those is how a process installs a handler.
    // Between the name and the colon, the statement's blanks: `start:.z.p`
    // and then a column-0 `::` are two statements (#726).
    for m in re!(concat!(
        r"(?:^|[^A-Za-z0-9_.`])(\.z\.[A-Za-z])(?:\[[^\]]*\])?",
        blank!(),
        r"*[-+*%,&|^#_]?::?|`(\.z\.[A-Za-z])",
        blank!(),
        r"+set\b"
    ))
    .captures_iter(code)
    {
        let name = m.get(1).or_else(|| m.get(2)).unwrap();
        // `.z.p:` must be followed by the value, not be `::`'s first half
        // read as an iterator such as `/:`.
        let after = &code[m.get(0).unwrap().end()..];
        if after.starts_with(['/', '\\', '\''])
            || code[name.end()..].starts_with(|c: char| c.is_alphanumeric())
            || name.as_str() == ".z.m"
        {
            continue;
        }
        // Inside a lambda `.z.s` is that lambda's own binding, and q takes
        // an assignment to it: q 5 runs `{[a] .z.s:a; .z.s}[5]` as 5, and
        // `.z.s::a` and `(.z.s;b):(a;2)` too, nested or not. Only at the top
        // level, `\d` or not, is it 'domain; `` `.z.s set a `` sets the
        // global wherever it is written, and is 'domain too. An amend in a
        // lambda, `.z.s+:a` or `.z.s[0]:a`, works on the lambda, and is
        // 'type (#2096).
        let lambda_self = m.get(1).is_some()
            && name.as_str() == ".z.s"
            && enclosing_brace(code, name.start()).is_some();
        let plain = code[name.end()..m.get(0).unwrap().end()]
            .trim_start()
            .starts_with(':');
        if lambda_self && plain {
            continue;
        }
        add(
            name.start(),
            "QF019",
            if lambda_self {
                "`.z.s` in a lambda is the lambda itself: amending it is 'type".into()
            } else {
                format!(
                    "`{}` is read-only: q refuses any assignment to it with 'domain",
                    name.as_str()
                )
            },
        );
    }
    // And a multiple assignment: q 5 `(.z.i;.z.h):(1;`a)` is 'domain (#506),
    // though `.z.s` in a lambda's is the lambda's own, as above.
    for (at, name) in semantics::global_multi_assignments(code) {
        if re!(r"^\.z\.[A-Za-z]$").is_match(name)
            && name != ".z.m"
            && !(name == ".z.s" && enclosing_brace(code, at).is_some())
        {
            // `at` is the target's start; the finding goes on the name.
            add(
                at + code[at..]
                    .match_indices(name)
                    .find(|(p, _)| {
                        !code[at + p + name.len()..].starts_with(|c: char| c.is_alphanumeric())
                    })
                    .map_or(0, |(p, _)| p),
                "QF019",
                format!("`{name}` is read-only: q refuses any assignment to it with 'domain"),
            );
        }
    }
    // like's pattern is a string, and a symbol literal is the obvious wrong
    // spelling of one. What q does with it depends on what follows. Verified:
    // `"abc" like `abc` is 'type, but a glob character is not part of a
    // symbol - `` `a* `` is the symbol `` `a `` and the operator `*`, and
    // `"abc" like `a*` is `like["abc"]*[`a]`, a projection, returned
    // silently where a boolean was wanted - except in a where phrase, which
    // wants booleans and raises 'type on it.
    for m in re!(concat!(r"\blike", blank!(), r"*`[A-Za-z0-9_.:]*")).find_iter(code) {
        // A backtick before it makes this the symbol `` `like ``, an element of
        // a list rather than the operator - `` `abs`cor`like`mins `` is data.
        if !boundary(code, m.start()) {
            continue;
        }
        let glob = code[m.end()..].starts_with(['*', '?', '[']);
        add(
            m.start(),
            "QB007",
            if glob {
                "like needs a string pattern: a glob is not part of a symbol, so this parses as \
                 a symbol and an operator, and the result is a projection rather than a \
                 boolean - 'type in a where phrase, silent anywhere else"
            } else {
                "like needs a string pattern; a symbol literal is a 'type error at runtime"
            }
            .into(),
        );
    }
    // The bracket form is the same call: q 5 `like[`abc;`a]` and
    // `like["abc";`a`b]` are 'type (#723). Only a complete call - with an
    // empty first slot, `like[;`a]` is a projection and nothing has run.
    for m in re!(concat!(r"\blike", blank!(), r"*\[")).find_iter(code) {
        let open = m.end() - 1;
        if !boundary(code, m.start()) {
            continue;
        }
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[open + 1..close - 1]);
        if parts.len() == 2
            && !v.comments[open + 1..open + 1 + parts[0].len()]
                .trim()
                .is_empty()
            && re!(r"^\s*(?:`[A-Za-z0-9_.:]*)+\s*$").is_match(parts[1])
        {
            add(
                m.start(),
                "QB007",
                "like needs a string pattern; a symbol literal is a 'type error at runtime".into(),
            );
        }
    }
    // The rank of every lambda this file names, for the two call-shape rules
    // below. An implicit signature's rank is the highest of x, y, z its own
    // body mentions, with nested lambdas blanked so theirs do not count.
    // Names are keyed as q resolves them, under the `\d` in force: after
    // `\d .foo`, `f:{x}` defines `.foo.f`, and a root `f[1;2]` is 'f, not
    // 'rank (q 5).
    let mut spaces: Vec<(usize, String)> = vec![(0, String::new())];
    let mut offset = 0;
    for line in code.split_inclusive('\n') {
        if let Some(ns) = semantics::opens(line, &source[offset..offset + line.len()]) {
            spaces.push((offset, ns));
        }
        offset += line.len();
    }
    let qualified = |at: usize, name: &str| -> String {
        let ns = &spaces.iter().rev().find(|(o, _)| *o <= at).unwrap().1;
        if name.starts_with('.') || ns.is_empty() {
            name.to_string()
        } else {
            format!("{ns}.{name}")
        }
    };
    // How deep in lambdas each byte sits. A plain `g:{...}` inside a lambda
    // assigns a local of that lambda, not the global `g` (#188); a dotted
    // name is global wherever it is assigned.
    let mut lambda_depth = vec![0u32; code.len() + 1];
    {
        let mut depth = 0u32;
        for (i, b) in code.bytes().enumerate() {
            lambda_depth[i] = depth;
            match b {
                b'{' => depth += 1,
                b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
        lambda_depth[code.len()] = depth;
    }
    let global_definition = |m: &regex::Captures| -> bool {
        m[1].contains('.') || lambda_depth[m.get(0).unwrap().start()] == 0
    };
    let mut ranks: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    // Where each was last defined.
    let mut defined_at: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*:\s*\{").captures_iter(code) {
        if !global_definition(&m) {
            continue;
        }
        let brace = m.get(0).unwrap().end() - 1;
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let rank = lambda_rank(code, source, brace, end);
        // Only when the name is the lambda, not the result of applying it.
        // `files:{...} each x` and `bids:{...}'[til n]` both assign a list,
        // and treating either as a function of the rank its braces declare
        // makes an ordinary index - `bids[;0]` - look like an over-applied
        // call. So the statement has to end at the closing brace.
        if !code[end..]
            .trim_start_matches([' ', '\t'])
            .starts_with([';', '\n', '\r'])
            && !code[end..].trim_start_matches([' ', '\t']).is_empty()
        {
            continue;
        }
        // A newline ends it only when the next line is not indented: q 5
        // reads `f:{[a] a}` + `  f[1;2]` as one expression, and refuses it
        // with 'f, since the right is evaluated before f is assigned. Blank
        // and comment lines between do not end it either.
        let next = code[end..].trim_start();
        let at = code.len() - next.len();
        let line = source[..at].rfind('\n').map_or(0, |p| p + 1);
        if !next.is_empty()
            && !next.starts_with([';', ')', ']', '}'])
            && source[line..].starts_with([' ', '\t'])
        {
            continue;
        }
        let key = qualified(m.get(0).unwrap().start(), &m[1]);
        defined_at.insert(key.clone(), m.get(0).unwrap().start());
        ranks.insert(key, rank);
    }
    // The same arity check as QA002, for a lambda reached by name. `ranks`
    // already knows what each `name:{...}` takes, so a call with more slots
    // than that is 'rank at runtime - the error QA002 reports when the lambda
    // is written out at the call site.
    //
    // Elided slots still count. `f[1;]` looks like a projection and is one
    // only when the slots fit: against a rank-1 `f` it supplies two and is
    // 'rank, which q confirms. `f[]` supplies none and is a projection at any
    // rank. Names defined more than once are dropped rather than guessed at,
    // since the rank at the call site is whichever definition ran last.
    let mut redefined: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*:\s*\{").captures_iter(code) {
            if !global_definition(&m) {
                continue;
            }
            let name = qualified(m.get(0).unwrap().start(), &m[1]);
            if !seen.insert(name.clone()) {
                redefined.insert(name);
            }
        }
        // Any other assignment to the global counts as well, whatever it
        // assigns: `f::{...}` inside a lambda, `f:expr` at the top level, and
        // `` `f set `` or `set[`f;...]`. q 5: `f:{x}; init:{f::{[a;b] a+b}};
        // init[]; f[1;2]` is 3 (#329). Columns and symbols are not names.
        let mut assigned: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        let view = semantics::local_view(code, true);
        for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*(::?)").captures_iter(&view) {
            let at = m.get(0).unwrap().start();
            let global = &m[2] == "::" || global_definition(&m);
            let end = m.get(0).unwrap().end();
            if !boundary(&view, at) || view[end..].starts_with(':') || !global {
                continue;
            }
            let key = qualified(at, &m[1]);
            // `f::{x}` again at the rank `f` already has changes nothing.
            let brace = end + (view[end..].len() - view[end..].trim_start().len());
            if &m[2] == "::"
                && view[brace..].starts_with('{')
                && matching(code, brace, b'{', b'}')
                    .is_some_and(|e| ranks.get(&key) == Some(&lambda_rank(code, source, brace, e)))
            {
                continue;
            }
            *assigned.entry(key).or_default() += 1;
        }
        for m in
            re!(r"`(\.?[A-Za-z][A-Za-z0-9_.]*)\s+set\b|\bset\s*\[\s*`(\.?[A-Za-z][A-Za-z0-9_.]*)")
                .captures_iter(code)
        {
            let name = m.get(1).or(m.get(2)).unwrap();
            *assigned
                .entry(qualified(name.start(), name.as_str()))
                .or_default() += 1;
        }
        // Each name of a `set'`: q 5 `` f:{x}; `f`g set' ({x+y};1); f[1;2] ``
        // is 3 (#753).
        for (whole, names) in semantics::each_set_targets(code) {
            for name in names {
                *assigned.entry(qualified(whole.start, name)).or_default() += 1;
            }
        }
        // Each name of a multiple assignment, `(f;g):v` or `([f;g]):d` at
        // the top level and `(f;g)::v` anywhere, and the target of a
        // functional amend: `` .[`f;();:;v] ``, or `` @[`.;`f;:;v] `` on a
        // namespace. q 5: `f:{[a;b] a+b}; (f;g):({[a;b;c] a+b+c};1);
        // f[1;2;3]` is 6, and so is each amend (#623).
        for (at, name) in semantics::multi_assignments(code)
            .filter(|&(at, _)| lambda_depth[at] == 0)
            .chain(semantics::global_multi_assignments(code))
        {
            *assigned.entry(qualified(at, name)).or_default() += 1;
        }
        for m in
            re!(r"[.@]\s*\[\s*`(\.?[A-Za-z][A-Za-z0-9_.]*|\.)\s*;\s*((?:`[A-Za-z][A-Za-z0-9_]*)*)")
                .captures_iter(code)
        {
            let (target, members) = (m.get(1).unwrap(), &m[2]);
            if members.is_empty() {
                *assigned
                    .entry(qualified(target.start(), target.as_str()))
                    .or_default() += 1;
            }
            for member in members.split('`').filter(|s| !s.is_empty()) {
                let key = match target.as_str() {
                    "." => member.to_string(),
                    ns => format!("{}.{member}", qualified(target.start(), ns)),
                };
                *assigned.entry(key).or_default() += 1;
            }
        }
        // A namespace or dictionary written as a whole, by any of those or
        // indexed, `.cfg[`f]:v`, or appended, `` `.cfg upsert d ``, may
        // replace each member: q 5 `.ns.f:{x}; .ns:(``f)!(::;{x+y});
        // .ns.f[1;2]` is 3 (#746, #747).
        let mut written: std::collections::HashSet<String> = assigned.keys().cloned().collect();
        for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)\s*\[[^\]]*\]\s*[-+*%&|^=<>,#~!?@$]?:|`(\.?[A-Za-z][A-Za-z0-9_.]*)(?:\s+|\s*\)\s*)upsert\b|\bupsert\s*\[\s*`(\.?[A-Za-z][A-Za-z0-9_.]*)")
            .captures_iter(code)
        {
            let name = m.get(1).or(m.get(2)).or(m.get(3)).unwrap();
            let end = m.get(0).unwrap().end();
            if m.get(2).is_some()
                && !semantics::literal_target(code, name.start() - 1, &code[name.end()..end])
            {
                continue;
            }
            written.insert(qualified(name.start(), name.as_str()));
        }
        redefined.extend(
            ranks
                .keys()
                .filter(|key| {
                    key.match_indices('.')
                        .filter(|&(i, _)| i > 0)
                        .any(|(i, _)| written.contains(&key[..i]))
                })
                .cloned(),
        );
        redefined.extend(
            assigned
                .into_iter()
                .filter(|(_, n)| *n > 1)
                .map(|(name, _)| name),
        );
    }
    // A write the file does not name may give the name another rank, once
    // it runs after the definition - later in the file, or from a lambda
    // called at any time: q 5 `f:{x}; value "f:{x+y}"; f[1;2]` is 3 (#745).
    // One that only changes `\d` defines nothing.
    let unnamed: Vec<usize> = semantics::unnamed_writes(code, &v.comments, source)
        .into_iter()
        .filter(|&(_, kind)| kind != semantics::Unnamed::Context)
        .map(|(at, _)| at)
        .collect();
    let in_lambda = |at: usize| {
        code.as_bytes()[..at].iter().fold(0i32, |d, &c| match c {
            b'{' => d + 1,
            b'}' => d - 1,
            _ => d,
        }) > 0
    };
    let overwritten = |key: &str| {
        let defined = defined_at.get(key).copied().unwrap_or(0);
        unnamed.iter().any(|&at| at > defined || in_lambda(at))
    };
    // Nor is the rank known to a call in a lambda when another file assigns
    // the name: the lambda runs once both are loaded, and meets whichever
    // ran last - q 5 runs b.q's `g:{f[1;2]}` to 3 after a.q's `f:{x+y}`
    // replaced b.q's `f:{x}` (#521). A top-level call after this file's
    // own definition meets that one.
    let own = semantics::index(code, source).defined;
    let placement = ws.placement(path);
    let foreign = |at: usize, key: &str| {
        ws.defined_elsewhere_as_loaded(key, &own, placement) && in_lambda(at)
    };
    // Between the name and its bracket, the statement's blanks and nothing
    // else: a column-0 `[1;2;3]` under `r:f` is a statement of its own
    // (#729), and in `code` a string is blanks too - `f "x" [1]` indexes the
    // string - so the gap is read in `comments`, where a string still shows.
    let gap = |m: &regex::Captures| {
        v.comments[m.get(1).unwrap().end()..m.get(0).unwrap().end() - 1]
            .chars()
            .all(|c| c.is_whitespace() || c == ')')
    };
    for m in re!(concat!(
        r"(\.?[A-Za-z][A-Za-z0-9_.]*)",
        blank!(),
        r"*(\)",
        blank!(),
        r"*)?\["
    ))
    .captures_iter(code)
    {
        let (whole, name) = (m.get(0).unwrap(), m.get(1).unwrap().as_str());
        let key = qualified(whole.start(), name);
        // `(f)[...]` applies `f` as surely: q 5 `(f)[1;2;3]` is 'rank (#629).
        if m.get(2).is_some_and(|p| {
            parenthesised(code, whole.start(), m.get(1).unwrap().end()) != Some(p.start() + 1)
        }) {
            continue;
        }
        if !boundary(code, whole.start())
            || !gap(&m)
            || redefined.contains(&key)
            || overwritten(&key)
            || foreign(whole.start(), &key)
        {
            continue;
        }
        let Some(&rank) = ranks.get(&key) else {
            continue;
        };
        if shadowed(code, source, whole.start(), name) {
            continue;
        }
        let open = whole.end() - 1;
        if rank == 0 {
            continue;
        }
        if let Some((at, count, left)) = over_applied(code, open, rank) {
            add(
                if at == open { whole.start() } else { at },
                "QA012",
                if at == open {
                    format!(
                        "{count} argument slots applied to `{name}`, which takes {rank}: 'rank at runtime"
                    )
                } else {
                    format!(
                        "{count} argument slots applied to a projection of `{name}` that takes \
                         {left} more: 'rank at runtime"
                    )
                },
            );
        }
    }
    // `f(1;2)` hands `f` the single argument `1 2`; for a lambda of rank 2 or
    // more that is a projection, not a call, and it goes on to produce wrong
    // data downstream. Verified: `f:{x+y}; f(1;2)` is `{x+y}[1 2]`. A rank-1
    // lambda given a list is an ordinary call and stays quiet.
    for m in re!(concat!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)", blank!(), r"*\(")).captures_iter(code) {
        let whole = m.get(0).unwrap();
        let name = m.get(1).unwrap().as_str();
        // A name defined twice has whichever rank ran last, as QA012 knows.
        // A column-0 `(1;2)` under `r:f` is its own statement (#724).
        if !boundary(code, whole.start())
            || !gap(&m)
            || redefined.contains(&qualified(whole.start(), name))
            || foreign(whole.start(), &qualified(whole.start(), name))
            || ranks
                .get(&qualified(whole.start(), name))
                .is_none_or(|&r| r < 2)
            || shadowed(code, source, whole.start(), name)
        {
            continue;
        }
        let open = whole.end() - 1;
        if let Some(close) = matching(code, open, b'(', b')')
            && slots(&code[open + 1..close - 1]).len() >= 2
        {
            add(
                whole.start(),
                "QA008",
                format!(
                    "`{name}(...)` passes one list argument to a rank-{} lambda, so this is a \
                     projection, not a call; square brackets separate arguments",
                    ranks[&qualified(whole.start(), name)]
                ),
            );
        }
    }
    // The same for a lambda written out: q 5 `{[a;b] a+b}(1;2)` is
    // `{[a;b] a+b}[1 2]` (#643).
    for (brace, _) in code.match_indices('{') {
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let open = end + (code[end..].len() - code[end..].trim_start_matches([' ', '\t']).len());
        let rank = lambda_rank(code, source, brace, end);
        // A list with an empty item - read in `comments`, where `""` is
        // still text - is itself a projection, applied on purpose: PyKX's
        // `{x y}(`..python;;)` is a conversion function.
        if rank >= 2
            && code[open..].starts_with('(')
            && let Some(close) = matching(code, open, b'(', b')')
            && let items = slots(&code[open + 1..close - 1])
            && items.len() >= 2
            && items.iter().all(|i| {
                let at = i.as_ptr() as usize - code.as_ptr() as usize;
                !v.comments[at..at + i.len()].trim().is_empty()
            })
        {
            add(
                brace,
                "QA008",
                format!(
                    "`{{...}}(...)` passes one list argument to a rank-{rank} lambda, so this is \
                     a projection, not a call; square brackets separate arguments"
                ),
            );
        }
    }
    // QA005 and QA003 for a lambda with no parameter list, whose rank is the
    // x, y and z it reads, and QA003 for a lambda named in this file. q 5:
    // `{x+y} each 1 2` is `{x+y}'[1 2]`, and `@[{x+y};1;{x}]`,
    // `f:{[a;b]a};@[f;1;{x}]` and `.[{[a;b;c]a};1 2;{x}]` each return a
    // projection, so the handler never runs.
    //
    // `each[f;x]` is the same each, for a lambda with a parameter list too:
    // q 5 `each[{[a;b] a+b};1 2]` is `{[a;b] a+b}'[1 2]` (#632).
    for (brace, _) in code.match_indices('{') {
        let named = signature(code, source, brace).named;
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let before = code[..brace].trim_end();
        let bracketed = before.ends_with('[')
            && re!(r"\beach\s*$")
                .find(&before[..before.len() - 1])
                .is_some_and(|m| boundary(code, m.start()))
            && code[end..].trim_start().starts_with(';')
            && matching(code, before.len() - 1, b'[', b']')
                .is_some_and(|close| slots(&code[before.len()..close - 1]).len() == 2);
        if !bracketed && named {
            continue;
        }
        let rank = lambda_rank(code, source, brace, end);
        let it = re!(r"\A(?:(?:each|peach)\b|@')")
            .find(code[end..].trim_start())
            .map(|m| m.as_str());
        if rank >= 2 && (bracketed || it.is_some()) {
            add(
                end,
                "QA005",
                it.and_then(|it| peach_detail(it, rank)).unwrap_or_else(|| {
                    if named {
                        format!(
                            "`each` supplies one argument to a {rank}-parameter lambda, so the \
                             results are projections, not values"
                        )
                    } else {
                        format!(
                            "`each` supplies one argument to a lambda of rank {rank} (it reads \
                             {}), so the results are projections, not values",
                            if rank == 3 { "x, y and z" } else { "x and y" }
                        )
                    }
                }),
            );
        }
    }
    // And a lambda reached by name: q 5 `g:{x+y}; g each 1 2` is
    // `{x+y}'[1 2]`, projections, as the literal is (#503). A name defined
    // twice has whichever rank ran last, as QA012 knows.
    for m in re!(r"(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t]+(each|peach)\b").captures_iter(code) {
        let (whole, name) = (m.get(0).unwrap(), m.get(1).unwrap().as_str());
        let key = qualified(whole.start(), name);
        if !boundary(code, whole.start())
            || redefined.contains(&key)
            || overwritten(&key)
            || shadowed(code, source, whole.start(), name)
        {
            continue;
        }
        let Some(&rank) = ranks.get(&key).filter(|&&r| r >= 2) else {
            continue;
        };
        add(
            whole.start(),
            "QA005",
            peach_detail(&m[2], rank).unwrap_or_else(|| {
                format!(
                    "`each` supplies one argument to `{name}`, which takes {rank}, so the \
                     results are projections, not values"
                )
            }),
        );
    }
    for m in re!(r"([@.])\[").find_iter(code) {
        let open = m.end() - 1;
        if !boundary(code, m.start())
            && !code[..m.start()].ends_with([' ', '\t', '(', '[', ';', ':', '{'])
        {
            continue;
        }
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[open + 1..close - 1]);
        if parts.len() != 3 {
            continue;
        }
        let f = parts[0].trim();
        let f_at = open + 1 + (parts[0].len() - parts[0].trim_start().len());
        let rank = if f.starts_with('{') {
            // A named signature under `@` is the older QA003 loop's.
            if m.as_str() == "@[" && signature(code, source, f_at).named {
                continue;
            }
            match matching(code, f_at, b'{', b'}') {
                Some(end) if end == f_at + f.len() => lambda_rank(code, source, f_at, end),
                _ => continue,
            }
        } else if re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*$").is_match(f) {
            let key = qualified(f_at, f);
            if redefined.contains(&key) || foreign(f_at, &key) || shadowed(code, source, f_at, f) {
                continue;
            }
            match ranks.get(&key) {
                Some(&r) => r,
                None => continue,
            }
        } else {
            continue;
        };
        // `@` supplies one argument; `.` as many as its literal list holds.
        let supplied = if m.as_str() == "@[" {
            1
        } else {
            let arg = parts[1].trim();
            let second = parts[1].as_ptr() as usize - code.as_ptr() as usize;
            let literal = &v.comments[second..second + parts[1].len()];
            if arg.starts_with('(') && matching(arg, 0, b'(', b')') == Some(arg.len()) {
                slots(&arg[1..arg.len() - 1]).len()
            } else if re!(r"^-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)*$").is_match(arg) {
                arg.split_whitespace().count()
            } else if let Some(n) = vector_items(arg, literal) {
                n
            } else {
                continue;
            }
        };
        if rank > supplied && rank >= 2 {
            add(
                m.start(),
                "QA003",
                format!(
                    "`{}` gives this rank-{rank} function {supplied} argument(s), so the result is \
                     a projection rather than a value, and the error handler never runs",
                    &m.as_str()[..1]
                ),
            );
        }
    }
    // The handler of a protected apply is given one argument, the error
    // text, so a handler of rank 2 or more is projected, not run: q 5
    // `@[{'`boom};1;{[e;z] e}]` is `{[e;z] e}["boom"]`, and so with `{x,y}`
    // and with `.[f;args;h]`. Only a lambda written out as the whole third
    // slot - a name may be bound to anything - and only where the first slot
    // is a function rather than data, which makes the three-slot form an
    // amend.
    for m in re!(r"([@.])\[").find_iter(code) {
        let open = m.end() - 1;
        if !boundary(code, m.start())
            && !code[..m.start()].ends_with([' ', '\t', '(', '[', ';', ':', '{'])
        {
            continue;
        }
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[open + 1..close - 1]);
        if parts.len() != 3 {
            continue;
        }
        let f = parts[0].trim();
        if !(f.starts_with('{') || re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*$").is_match(f)) {
            continue;
        }
        let h = parts[2].trim();
        let h_at = parts[2].as_ptr() as usize - code.as_ptr() as usize
            + (parts[2].len() - parts[2].trim_start().len());
        if !h.starts_with('{') || matching(code, h_at, b'{', b'}') != Some(h_at + h.len()) {
            continue;
        }
        let rank = lambda_rank(code, source, h_at, h_at + h.len());
        if rank >= 2 {
            add(
                h_at,
                "QA013",
                format!(
                    "`{}` passes its error handler one argument, the error text; this handler \
                     takes {rank}, so an error returns a projection of it rather than running it",
                    &m.as_str()[..1]
                ),
            );
        }
    }
    // Dot apply of a lambda to a literal: an atom is not an argument list
    // (QA009), and a list longer than the rank is 'rank (QA002 for a lambda
    // written out, QA012 for one named here). q 5: `f . 1` is 'type, and
    // `{x} . (1;2)`, `{[a;b]a} . 1 2 3` and `.[{[a]a};(1;2)]` are 'rank.
    let lambda_ending = |end: usize| -> Option<usize> {
        code[..end]
            .match_indices('{')
            .map(|(o, _)| o)
            .find(|&o| matching(code, o, b'{', b'}') == Some(end))
    };
    let applied = |at: usize, f: &str, f_end: usize| -> Option<(usize, &'static str)> {
        if f.ends_with('}') {
            let open = lambda_ending(f_end)?;
            Some((lambda_rank(code, source, open, f_end), "QA002"))
        } else {
            let name = re!(r"\.?[A-Za-z][A-Za-z0-9_.]*$").find(f)?.as_str();
            let start = f_end - name.len();
            let key = qualified(at, name);
            if !boundary(code, start)
                || redefined.contains(&key)
                || foreign(at, &key)
                || shadowed(code, source, at, name)
            {
                return None;
            }
            ranks.get(&key).map(|&r| (r, "QA012"))
        }
    };
    // `arg` is read in `code`, and its strings in `comments`, where they are
    // still text.
    let items = |arg: &str| -> Option<usize> {
        let at = arg.as_ptr() as usize - code.as_ptr() as usize;
        let literal = &v.comments[at..at + arg.len()];
        let arg = arg.trim();
        if arg.starts_with('(') && matching(arg, 0, b'(', b')') == Some(arg.len()) {
            let n = slots(&arg[1..arg.len() - 1]).len();
            (n > 1).then_some(n)
        } else {
            vector_items(arg, literal)
        }
    };
    let too_many = |rank: usize, n: usize| {
        (rank > 0 && n > rank).then(|| {
            format!(
                "{n} arguments applied through `.` to a function of rank {rank}: 'rank at runtime"
            )
        })
    };
    // The blanks around the dot are optional after a lambda and before a
    // parenthesis: q 5 parses `{x}.(1;2)`, `{x}. 1` and `f .(1;2)` as the
    // same dot apply (#441). A digit straight after it is a float: `f .1`.
    // The argument may start the indented line that continues the
    // statement: q 5 `g:f .` over `  (1;2;3)` is 'rank (#691).
    for m in re!(concat!(r"(?:\}[ \t]*|[ \t])\.(?:", blank!(), r"+|\()")).find_iter(code) {
        let dot = m.start() + m.as_str().find('.').unwrap();
        let left = code[..dot].trim_end_matches([' ', '\t']);
        let Some((rank, id)) = applied(dot, left, left.len()) else {
            continue;
        };
        let quoted = past_blanks(&v.comments, dot + 1);
        if let Some(len) = char_atom(&v.comments[quoted..])
            && operand_ends(code, &v.comments, quoted + len)
        {
            add(
                dot,
                "QA009",
                "Dot apply takes a list of arguments; a scalar here is a 'type error at runtime \
                 (`enlist` it, or use `@`)"
                    .into(),
            );
            continue;
        }
        // Blanks skipped in `comments`: in `code` a string is blank too.
        let after = quoted;
        let rest = &code[after..];
        let end = if rest.starts_with('(') {
            match matching(rest, 0, b'(', b')') {
                Some(e) => e,
                None => continue,
            }
        } else {
            rest.find(|c: char| ";)]}\r\n".contains(c))
                .unwrap_or(rest.len())
        };
        let arg = &rest[..end];
        if !operand_ends(code, &v.comments, after + end) {
            continue;
        }
        if scalar_literal(arg.trim_end_matches([' ', '\t'])) {
            add(
                dot,
                "QA009",
                "Dot apply takes a list of arguments; a scalar here is a 'type error at runtime \
                 (`enlist` it, or use `@`)"
                    .into(),
            );
        } else if let Some(detail) = items(arg).and_then(|n| too_many(rank, n)) {
            add(dot, id, detail);
        }
    }
    for (at, _) in code.match_indices(".[") {
        if code[..at].ends_with(|c: char| c.is_alphanumeric() || "_.".contains(c)) {
            continue;
        }
        let Some(close) = matching(code, at + 1, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[at + 2..close - 1]);
        let f_end = at + 2 + parts[0].trim_end().len();
        // QA004 in brackets: `.[f;()]` is 'type as `f . ()` is, and so is the
        // trap `.[f;();h]`, whose handler swallows it (q 5). With data on
        // the left three arguments are an amend - `.[d;();f]` applies f to
        // d - so the trap only for a lambda written out or named here.
        let second = at + 2 + parts[0].len() + 1;
        if (parts.len() == 2
            || parts.len() == 3 && applied(at, parts[0].trim_end(), f_end).is_some())
            && re!(r"^\s*\(\s*\)\s*$").is_match(&v.comments[second..second + parts[1].len()])
        {
            add(at, "QA004", "`.[f;()]`".into());
        }
        if parts.len() != 2 {
            continue;
        }
        if let Some((rank, id)) = applied(at, parts[0].trim_end(), f_end)
            && let Some(detail) = items(parts[1]).and_then(|n| too_many(rank, n))
        {
            add(at, id, detail);
        }
    }
    // `a -1` is `a` applied to `-1`, not `a` minus one: with whitespace before
    // it and none after, the `-` belongs to the literal. q refuses it only
    // when `a` is an atom - q 5 `a:3; a -1` is 'domain, `a:1.5; a -1` 'type,
    // while `a:1 2 3; a -1` indexes and is 0N - so this reports q's own `.z`
    // atoms, and `semantics` a name it sees bound to an atom. Nor does
    // `sizes -1+n`: a literal that continues into an expression is
    // `sizes[n-1]` - only a literal that ends the statement or bracket.
    //
    // The literal may be temporal: `window_to -0D00:01` and `.z.p -0D00:01`
    // are the same trap with a timespan, and a production timer threw 'type
    // on both. Verified on q 4.0: parse ".z.p -0D00:01" is
    // (`.z.p;-0D00:01:00.000000000).
    for m in
        // `\r` belongs in the trailing class: with `$` in multiline mode the
        // anchor sits before the `\n`, so on a CRLF checkout the carriage
        // return is left between the literal and the anchor and the match is
        // silently lost. Every file git checks out on Windows is CRLF.
        // No `_` in the literal: no q number has one, and `-1_x` is drop.
        // `:` in the literal for a temporal one: `-0D00:01`, `-00:00:01`.
        // A lambda's closing brace ends it too: q 5 `{.z.p -1}[]` is 'type
        // (#678).
        re!(concat!(
            r"(?m)(\.?[A-Za-z][A-Za-z0-9_.]*)",
            blank!(),
            r"+(-\d[A-Za-z0-9.:]*)[ \t\r]*(?:[;\])}]|$)"
        ))
        .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        let (name, literal) = (&m[1], &m[2]);
        // Only q's own atoms here: any other name may hold a list, which
        // `a -1` indexes - q 5 `a:1 2 3; a -1` is 0N - so a name is only
        // reported where `semantics` sees it bound to an atom.
        if !boundary(code, whole.start()) || !Z_VALUES.contains(&name) {
            continue;
        }
        add(whole.start(), "QB010", apply_not_subtract(name, literal));
    }
    // A literal atom is applied the same way: q 5 `"a" -1`, `1b -1`,
    // `0x01 -1` and `(1) -1` are each 'type, while `"ab" -1`, `10b -1` and
    // `(1 2) -1` index (#500). Read where strings are kept, with the atom's
    // quote a real opening one and the minus code.
    for m in re!(r#"(?m)("(?:[^"\\]|\\[0-7]{3}|\\.)"|[01]b|0x[0-9a-fA-F]{1,2}|\([ \t]*(?:"(?:[^"\\]|\\[0-7]{3}|\\.)"|-?\d+(?:\.\d*)?(?:e[+-]?\d+)?[hijef]?|[01]b)[ \t]*\))[ \t]+(-\d[A-Za-z0-9.:]*)[ \t\r]*(?:[;\])]|$)"#)
        .captures_iter(&v.comments)
    {
        let atom = m.get(1).unwrap();
        let quoted = atom
            .as_str()
            .find('"')
            .is_none_or(|q| v.string_starts.contains(&(atom.start() + q)));
        if !quoted
            || !boundary(code, atom.start())
            || (!atom.as_str().starts_with('"') && code.as_bytes()[atom.start()] == b' ')
            || code.as_bytes()[m.get(2).unwrap().start()] != b'-'
        {
            continue;
        }
        add(atom.start(), "QB010", apply_not_subtract(atom.as_str(), &m[2]));
    }
    // Dot apply wants a list of arguments, and a scalar in that slot is a
    // 'type error - even when the left side is itself a list to index.
    // Verified: `.[{x+y};1]`, `.[f;`a]`, `.[1 2 3;0]` all 'type.
    //
    // The slots are split at bracket depth zero: in `.[(1b;`;)f::;args]` the
    // first argument is a list with semicolons of its own, and the second is
    // `args`, not the `` ` `` inside it.
    for (at, _) in code.match_indices(".[") {
        if code[..at].ends_with(|c: char| c.is_alphanumeric() || "_.".contains(c)) {
            continue;
        }
        let Some(close) = matching(code, at + 1, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[at + 2..close - 1]);
        // An empty slot is a projection - `.[;1_x]` waits for its function -
        // judged in the view that keeps strings and blanks comments. No `_` in
        // the number: `1_x` is a drop, not a literal.
        let mut from = at + 2;
        let elided = parts.iter().any(|part| {
            let empty = v.comments[from..from + part.len()].trim().is_empty();
            from += part.len() + 1;
            empty
        });
        let quoted = parts.get(1).map_or("", |part| {
            let second = at + 3 + parts[0].len();
            v.comments[second..second + part.len()].trim()
        });
        if elided
            || parts.len() < 2
            || !(scalar_literal(parts[1].trim()) || char_atom(quoted) == Some(quoted.len()))
        {
            continue;
        }
        add(
            at,
            "QA009",
            "Dot apply takes a list of arguments; a scalar here is a 'type error at runtime \
             (`enlist` it, or use `@`)"
                .into(),
        );
    }
    // `ss` and `ssr` are string functions and refuse a symbol in either the
    // subject or the pattern slot. `trim`, `lower` and `like` accept symbols
    // and are deliberately not here.
    // The bracket form is split into its slots, so the `;` of a call nested
    // in the subject does not start the pattern: `ssr[f[0;`a;s];"b";"c"]`
    // passes a string (#294).
    for m in re!(r"\bssr?\s*\[").find_iter(code) {
        let open = m.end() - 1;
        if !boundary(code, m.start()) {
            continue;
        }
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let symbol = |s: &&str| re!(r"^\s*(?:`[A-Za-z0-9_.]*)+\s*$").is_match(s);
        let parts = slots(&code[open + 1..close - 1]);
        if complete_call(&v.comments, open, &parts, m.as_str().starts_with("ssr"))
            && parts.iter().take(2).any(symbol)
        {
            add(
                m.start(),
                "QT007",
                "ss/ssr work on strings; a symbol literal is a 'type error at runtime".into(),
            );
        }
    }
    for m in re!(concat!(
        r"(?:`[A-Za-z0-9_.]*)+\s+ssr?\b|\bss",
        blank!(),
        r"+`[A-Za-z0-9_.]*"
    ))
    .find_iter(code)
    {
        // `"abc" ss `a` puts the symbol in the pattern slot (q 5: 'type), on
        // the indented next line too (#692). Only when the symbol is the
        // whole pattern: `` `char$98 `` is the char "b", and
        // `"abc" ss `char$98` runs (#598).
        if m.as_str().starts_with('s')
            && (!boundary(code, m.start()) || !operand_ends(code, &v.comments, m.end()))
        {
            continue;
        }
        add(
            m.start(),
            "QT007",
            "ss/ssr work on strings; a symbol literal is a 'type error at runtime".into(),
        );
    }
    // Operators borrowed from other languages. None of these parse: q's
    // equality is `=`, inequality `<>`, and `&&`/`||` are `and`/`or` (or
    // `&`/`|`). `+=` and friends are `+:`.
    //
    // The longer spellings q 5 also refuses, each verified with parse:
    // `x**2`, `x=>y`, `x=<y`, `x<<2`, `x|>f`, `x->y`, `x:=1`, `x%%y`,
    // `x<=>y`, `x+++y`. Only before an operand - `a++` and `a**` with nothing
    // after them parse, as compositions, and `x>>2` parses too.
    for m in re!(r"<=>|\*\*|=>|=<|<<|\|>|->|:=|%%|\+\+|==|!=|&&|\|\||[+\-*]=").find_iter(code) {
        // An `=` applied with brackets is its own token: `c:=[`a;`b]` assigns
        // an equality, and q 5 parses `x+=[1;1]`, `x==[1;1]` and `x:= [1;1]`
        // too - only without the brackets is the pair refused.
        if m.as_str().ends_with('=')
            && code[m.end()..]
                .trim_start_matches([' ', '\t'])
                .starts_with('[')
        {
            continue;
        }
        // So is any second glyph that an iterator derives a function from,
        // applied with brackets: q 5 runs `x||/[y]`, `x**\[y]`, `x==/[y]`
        // and `x||':[y]` (#237), and refuses `x||/y` with '/, not as a pair.
        if re!(r"^(?:[/\\']:?)+\[").is_match(&code[m.end()..]) {
            continue;
        }
        // The file `\l` loads and the context `\d` opens stay in `code`,
        // and are no q: q 5 loads `\l qe4/a==b.q` (#319).
        if system_command(&source[code[..m.start()].rfind('\n').map_or(0, |p| p + 1)..]) {
            continue;
        }
        // With no operand after it - past any iterators and a `::` - every
        // pair parses, as a composition: q 5 reads `f:2==` as `(=[2])'(=)`,
        // and `(1&&)`, `k:2**/`, `m:2->::` and `r:=/` likewise (#646).
        let derived = re!(r"^(?:[/\\']:?)*(?:::)?")
            .find(&code[m.end()..])
            .map_or(0, |d| d.end());
        let rest = &code[past_blanks(code, m.end() + derived)..];
        // A string is blank in `code`, and an operand all the same: q 5
        // refuses `2**"a"` with '* and `t:="a"` with '= (#658).
        let string = source[past_blanks(source, m.end() + derived)..].starts_with('"');
        if !string && (rest.is_empty() || rest.starts_with([';', ')', ']', '}', '\r', '\n'])) {
            continue;
        }
        let (op, meant) = match m.as_str() {
            "==" => ("==", "`=`"),
            "!=" => ("!=", "`<>`"),
            "&&" => ("&&", "`and` (or `&`)"),
            "||" => ("||", "`or` (or `|`)"),
            "**" => ("**", "`xexp`"),
            "=>" => ("=>", "`>=`"),
            "=<" => ("=<", "`<=`"),
            "<<" => ("<<", "`<` (q has no shift operator)"),
            "|>" => ("|>", "plain application, `f x`"),
            "->" => ("->", "a dictionary's `!`, or a lambda"),
            ":=" => (":=", "`:`"),
            "%%" => ("%%", "`mod` (`%` is division)"),
            "<=>" => ("<=>", "`signum x-y`"),
            "++" => ("++", "`+:` or `x+1`"),
            other => (other, "`+:`-style amend"),
        };
        add(
            m.start(),
            "QE004",
            format!("q has no `{op}`; the spelling here is {meant}"),
        );
    }
    // Keywords from other languages are plain names to q, and undefined ones:
    // `return 1` throws 'return. `null` is absent from this list because it
    // is a q function. A file that declares one of these as a parameter or
    // assigns it anywhere has made it a name, and its uses are left alone.
    let mut declared: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (brace, _) in code.match_indices('{') {
        declared.extend(signature(code, source, brace).slots);
    }
    for m in re!(r"([A-Za-z][A-Za-z0-9_]*)\s*:").captures_iter(code) {
        declared.insert(m.get(1).unwrap().as_str());
    }
    // And a multiple assignment's names: q 5 `(true;false):10b` then
    // `show true` prints 1b (#371).
    declared.extend(
        semantics::multi_assignments(code)
            .chain(semantics::global_multi_assignments(code))
            .map(|(_, n)| n),
    );
    // A column: named as a symbol somewhere (`` `sym`return!... ``), or read
    // inside a query, where a bare name is the column before any global.
    for m in re!(r"`([A-Za-z][A-Za-z0-9_]*)").captures_iter(code) {
        declared.insert(m.get(1).unwrap().as_str());
    }
    // Another file of the workspace may define it too: with lib.q's
    // `true:1b` loaded, q 5 runs `{[a] $[a;true;false]}` (#372). Under
    // `\d .ns` the name is `.ns.true`, which a root `true` does not define
    // and lib.q's own `\d .ns` does (q 5, #520).
    let placement = ws.placement(path);
    let elsewhere = |key: &str| ws.defined_elsewhere_as_loaded(key, &Default::default(), placement);
    // Nor can a file that writes globals it does not name say the name is
    // undefined: q 5 runs `\l lib.q` (`true:0b`) then `$[true;`yes;`no]` to
    // `no, which the fix to 1b would turn to `yes (#750).
    let opaque = semantics::opaque(code, &v.comments, source);
    let bare = unsymbolled(code);

    for m in
        re!(r"\b(return|else|elif|elseif|true|false|None|break|continue)\b").captures_iter(&bare)
    {
        let whole = m.get(0).unwrap();
        let name = &m[1];
        let after = code[whole.end()..].trim_start();
        let in_query = in_query(code, whole.start());
        if opaque
            || !boundary(code, whole.start())
            || after.starts_with('.')
            || declared.contains(name)
            || in_query
            || elsewhere(&qualified(whole.start(), name))
            || elsewhere(&format!(".q.{name}"))
        {
            continue;
        }
        add(
            whole.start(),
            "QF015",
            format!("`{name}` is not a q keyword; it resolves as a global and throws '{name}"),
        );
    }
    // A lambda whose last statement ends in `;` returns `::`, whatever that
    // statement computed. Verified: `{x+1;}[1]` is `::`. It is common, and
    // usually meant, after a side-effecting call - and in q a call by
    // juxtaposition (`f x`, `show x`) has the same shape as any other
    // expression. So the rule is only for a last statement that is a bare
    // name or a chain of simple operands joined by infix operators, with no
    // juxtaposition and no brackets: `x+1`, `r`, `a-b` - shapes that can
    // only be computing a value, and here throw it away.
    for (brace, _) in code.match_indices('{') {
        let Some(end) = matching(code, brace, b'{', b'}') else {
            continue;
        };
        let sig = signature(code, source, brace);
        let body = &code[sig.body..end - 1];
        let Some(semi) = body.trim_end().strip_suffix(';').map(str::len) else {
            continue;
        };
        let (mut start, mut depth) = (0, 0i32);
        for (i, c) in body[..semi].bytes().enumerate() {
            match c {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                // Only `;`: in a lambda a newline is whitespace (#328).
                b';' if depth == 0 => start = i + 1,
                _ => {}
            }
        }
        let stmt = body[start..semi].trim();
        let simple = re!(r"^[A-Za-z0-9_.]+(?:\s*(?:<>|<=|>=|[+\-*%=<>&|,#_])\s*[A-Za-z0-9_.]+)*$")
            .is_match(stmt);
        let builtin = RESERVED.iter().any(|n| n == stmt);
        // A string is blank in this view; `f "done"` must not pass for `f`.
        let quoted = v.comments[sig.body + start..sig.body + semi].contains('"');
        if simple && !builtin && !quoted {
            let stmt = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
            add(
                sig.body + semi,
                "QB012",
                format!(
                    "Lambda ends with `;`, so it returns null and `{stmt}` is computed and \
                     discarded"
                ),
            );
        }
    }
    // `type` returns a short - 7h, not `long - so a symbol on the other side
    // of `=` is a 'type error every time. A bare `type=` is a column named
    // type, which is QF013's business, not this rule's. `type` has to be the
    // whole word: `typeTerminal=`count` is a name (#296). Applied by
    // juxtaposition, `type x=`long` is `type (x=`long)`, right to left: only
    // `type[x]=` and `(type x)=` compare the short (q 5: -1h, #429). `in`
    // compares it the same way: q 5 `(type 1) in `long`int` is 'type (#645).
    // Around the operator, the statement's blanks: `is:type[t]=` and then a
    // column-0 `` `a `` are two statements (#743).
    for m in re!(concat!(
        r"\btype\s*\[[^\]]*\]",
        blank!(),
        r"*(?:=|<>|in\b)",
        blank!(),
        r"*`[a-z][A-Za-z0-9_.]*(?:`[A-Za-z0-9_.]*)*|\(\s*type\b[^()]*\)",
        blank!(),
        r"*(?:=|<>|in\b)",
        blank!(),
        r"*`[a-z][A-Za-z0-9_.]*(?:`[A-Za-z0-9_.]*)*|`[a-z]+",
        blank!(),
        r"*(?:=|<>)",
        blank!(),
        r"*type\b"
    ))
    .find_iter(code)
    {
        // The symbol on the right has to be the whole operand:
        // `` type[1]=`a`b?`a `` compares a short with a long.
        // So does a parenthesised one: q 5 `(type 1)=`long` is 'type.
        if !m.as_str().starts_with('`') && !operand_ends(code, &v.comments, m.end()) {
            continue;
        }
        add(
            m.start(),
            "QB013",
            "`type` returns a short (7h, 11h, ...); comparing it to a symbol is a 'type error"
                .into(),
        );
    }
    // Table literals, judged the way q judges them.
    //
    // q checked, per literal shape (`type` of the value; negative is an atom):
    //   `1b` atom, `10b` vector - a boolean literal is an atom only with one
    //   digit; `0x1` and `0x01` atoms, `0x`, `0x012` and `0x0102` vectors -
    //   a byte literal is an atom only with one or two hex digits, and an
    //   odd run is padded (`0x012` is `0x0012`); `"a"` atom, `"ab"` vector.
    //
    // And per table, what q raises:
    //   `([]a:1;b:2)`         'rank   - every column an atom needs `enlist`
    //   `([]a:1 2;b:3 4 5)`   'length - vector columns of different lengths
    //   `([]a:enlist 1;b:2 3)` 'length - `enlist` makes a one-item vector
    //   `([]a:1;b:2 3)`       fine    - an atom extends to the vector's length
    //   `([k:1]v:2 3)`        'rank   - a keyed table needs vectors both sides
    //   `([k:1 2]v:3)`        'rank   - and on both sides means both
    //   `([]a:"a";b:1)`       'rank   - a char is an atom like any other
    for table in re!(r"\(\s*\[").find_iter(code) {
        let at = table.start();
        let Some(close) = matching(code, at, b'(', b')') else {
            continue;
        };
        let inner = &code[at + 1..close - 1];
        // The key group is `[...]`, the value columns follow it. Whitespace,
        // newlines included, may sit before the bracket.
        let bracket = inner.len() - inner.trim_start().len();
        let Some(key_close) = matching(inner, bracket, b'[', b']') else {
            continue;
        };
        let keys = &inner[bracket + 1..key_close - 1];
        let values = &inner[key_close..];
        // Nothing after the brackets is q 5's dictionary literal, not a
        // table: `([a:"";b:"xyz"])` is `` `a`b!("";"xyz") ``, and its values
        // may be any shapes at all.
        if values.trim().is_empty() {
            continue;
        }
        // What a column value is, or None when the text does not say.
        #[derive(PartialEq, Clone, Copy)]
        enum Shape {
            Atom,
            Vector(Option<usize>),
        }
        let shape = |v: &str| -> Option<Shape> {
            let mut v = v.trim();
            // Parentheses only group, and a top-level `;` makes a general
            // list of that many items: `([]a:(1);b:2)` is 'rank and
            // `([]a:(1 2);b:1 2 3)` 'length, as without them (q 5, #620).
            for depth in 0.. {
                if depth == MAX_NESTING
                    || !(v.starts_with('(') && matching(v, 0, b'(', b')') == Some(v.len()))
                    || v[1..v.len() - 1].trim().is_empty()
                {
                    break;
                }
                let items = slots(&v[1..v.len() - 1]);
                if items.len() > 1 {
                    return Some(Shape::Vector(Some(items.len())));
                }
                v = v[1..v.len() - 1].trim();
            }
            // Vectors first. The general numeric-atom pattern would otherwise
            // take `10b` and `0x0102` as atoms, and q says they are not.
            // A tab after `enlist` as much as a space (q 5).
            if let Some(rest) = v
                .strip_prefix("enlist")
                .filter(|r| r.starts_with([' ', '\t']))
            {
                return shape_of_enlist(rest);
            }
            if re!(r"^[01]{2,}b$|^0x(?:[0-9a-fA-F]{3,})?$").is_match(v) {
                let n = if v.ends_with('b') {
                    v.len() - 1
                } else {
                    (v.len() - 2).div_ceil(2)
                };
                return Some(Shape::Vector(Some(n)));
            }
            if re!(r"^(?:`[A-Za-z0-9_.]*){2,}$").is_match(v) {
                return Some(Shape::Vector(Some(v.matches('`').count())));
            }
            // Only the last item takes a type suffix, and never `b`: `1 0b` is
            // the atom `1` applied to `0b`, and `1h 2` does not parse (q 5, #496).
            let suffixed = |item: &str| {
                re!(r"^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+|E\d+)?[a-mo-vx-zA-MO-VX-Z]$|^-?0[nNwW][a-z]$")
                    .is_match(item)
            };
            if re!(
                r"^-?\.?\d(?:e-|e\+\d|[A-Za-z0-9.:])*(?:\s+-?\.?\d(?:e-|e\+\d|[A-Za-z0-9.:])*)+$"
            )
            .is_match(v)
            {
                let items: Vec<&str> = v.split_whitespace().collect();
                let (last, init) = items.split_last().expect("two items or more");
                if init.iter().any(|i| suffixed(i)) || re!(r"\d[bx]$").is_match(last) {
                    return None;
                }
                return Some(Shape::Vector(Some(v.split_whitespace().count())));
            }
            if v == "()" {
                return Some(Shape::Vector(Some(0)));
            }
            if re!(r"^[01]b$|^0x[0-9a-fA-F]{1,2}$|^-?\.?\d(?:e-|e\+\d|[A-Za-z0-9.:])*$|^`[A-Za-z0-9_.]*$")
                .is_match(v)
            {
                return Some(Shape::Atom);
            }
            None
        };
        fn shape_of_enlist(_: &str) -> Option<Shape> {
            Some(Shape::Vector(Some(1)))
        }
        // A string column is blank in this view. Its length is in the source.
        let string_len = |v: &str, offset: usize| -> Option<Shape> {
            let raw = source[at + 1 + offset..at + 1 + offset + v.len()].trim();
            // Counted as q holds it: `"\n\t"` is two chars, not four (#231).
            if let Some(body) = re!(r#"^"((?:\\[0-7]{3}|\\.|[^"\\])*)"$"#).captures(raw) {
                let n = q_bytes(&body[1]).len();
                return Some(if n == 1 {
                    Shape::Atom
                } else {
                    Shape::Vector(Some(n))
                });
            }
            None
        };
        let columns = |group: &str, base: usize| -> Vec<Option<Shape>> {
            let mut out = vec![];
            let mut pos = 0;
            for part in slots(group) {
                let part_start = base + pos;
                pos += part.len() + 1;
                let Some((_, value)) = part.split_once(':') else {
                    if !part.trim().is_empty() {
                        out.push(None);
                    }
                    continue;
                };
                let voff = part_start + part.len() - value.len();
                out.push(shape(value).or_else(|| string_len(value, voff)));
            }
            out
        };
        let key_cols = columns(keys, bracket + 1);
        let val_cols = columns(values, key_close);
        let all = || key_cols.iter().chain(&val_cols);
        if all().count() == 0 {
            continue;
        }
        let known = all().all(|c| c.is_some());
        if !known {
            continue;
        }
        let atoms_only = |cols: &[Option<Shape>]| {
            !cols.is_empty() && cols.iter().all(|c| *c == Some(Shape::Atom))
        };
        // Keyed: both sides have to be vectors. A keyed table is a dictionary
        // of two tables, and either side being a single row is 'rank.
        if !key_cols.is_empty() && (atoms_only(&key_cols) || atoms_only(&val_cols)) {
            add(
                at,
                "QT005",
                "A keyed table literal needs vector columns on both sides of the key; a \
                 single row on either side is a 'rank error"
                    .into(),
            );
            continue;
        }
        if key_cols.is_empty() && atoms_only(&val_cols) {
            add(
                at,
                "QT005",
                "Every column of this table literal is a scalar, which is a 'rank error; a \
                 one-row table needs `enlist`"
                    .into(),
            );
            continue;
        }
        // Vector columns of different lengths. Atoms extend and are ignored.
        let lengths: Vec<usize> = all()
            .filter_map(|c| match c {
                Some(Shape::Vector(Some(n))) => Some(*n),
                _ => None,
            })
            .collect();
        if lengths.len() >= 2 && lengths.iter().any(|&n| n != lengths[0]) {
            add(
                at,
                "QT020",
                format!(
                    "Table literal columns have different lengths ({}), which is a 'length error",
                    lengths
                        .iter()
                        .map(|n| n.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        }
    }
    // `ss` and `ssr` with an empty search pattern. q raises 'length for both:
    // `ss["abc";""]` and `ssr["abc";"";"b"]` checked. The pattern is a string,
    // which is blank in this view, so the check reads the source at the same
    // offsets - a pair of quotes with nothing between them.
    // Only a space or tab may come between: q refuses any other blank with
    // 'char, and a multi-byte one would leave the name's slice mid-character.
    // The function may be parenthesised, `(ss)["abc";""]`, and so may the
    // pattern, `("")` (q 5: both 'length, #619).
    for m in re!(r"(?:\b(ss|ssr)|\((ss|ssr)\))[ \t]*\[").captures_iter(code) {
        let whole = m.get(0).unwrap();
        let name = m.get(1).or(m.get(2)).unwrap().as_str();
        let open = whole.end() - 1;
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[open + 1..close - 1]);
        if !complete_call(&v.comments, open, &parts, name == "ssr") {
            continue;
        }
        // The second slot's span in the source.
        let second_start = open + 1 + parts[0].len() + 1;
        let mut second = source[second_start..second_start + parts[1].len()].trim();
        while let Some(inner) = second.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
            second = inner.trim();
        }
        if second == "\"\"" {
            add(
                whole.start(),
                "QT021",
                format!("`{name}` with an empty pattern is a 'length error"),
            );
        }
    }
    // The same written infix: `"abc" ss ""` is 'length too (q 5). The empty
    // string is blank here, so the source is read at the same offset.
    // `\bss\b` alone: the masked view turns the string's quotes into spaces
    // too, so the whitespace after `ss` is skipped in the source instead.
    for m in re!(r"\bss\b").find_iter(code) {
        if !boundary(code, m.start()) {
            continue;
        }
        if empty_pattern(source, code, &v.comments, m.end()) {
            add(
                m.start(),
                "QT021",
                "`ss` with an empty pattern is a 'length error".into(),
            );
        }
    }
    // A table literal's column named for a builtin: q 5 refuses to build
    // `([]sum:1 2)` or `([sum:1 2]a:3 4)` with 'assign. Only by and from
    // build a table.
    for (at, _) in code.match_indices("([") {
        let Some(close) = matching(code, at, b'(', b')') else {
            continue;
        };
        let Some(keys) = matching(code, at + 1, b'[', b']') else {
            continue;
        };
        // The key columns, then the value columns after the bracket.
        for (start, end) in [(at + 2, keys - 1), (keys, close.saturating_sub(1))] {
            if start >= end {
                continue;
            }
            let mut pos = start;
            for part in code[start..end].split(';') {
                let trimmed = part.trim_start();
                let lead = part.len() - trimmed.len();
                if let Some(m) = re!(r"^([A-Za-z][A-Za-z0-9_]*)\s*:").captures(trimmed)
                    && RESERVED.iter().any(|n| n == &m[1])
                {
                    // by and from build a table (q 5), and are left out.
                    if matches!(&m[1], "by" | "from") {
                        pos += part.len() + 1;
                        continue;
                    }
                    let detail = format!(
                        "Column `{}` is a builtin name: q refuses the literal",
                        &m[1]
                    );
                    add(pos + lead, "QF013", detail);
                }
                pos += part.len() + 1;
            }
        }
    }
    // The same in a query's column or by list: q 5 `select sum:a from t`,
    // `update count:a from t` and `select by max:a from t` are 'assign when
    // parsed. A column named by or from is read as the keyword, and the
    // query fails: `select from:a from t` is 'from, `select by:a from t`
    // 'type and `select a,by:a from t` ', - though `select a by:a from t`
    // is a by phrase, and not this.
    for q in re!(r"\b(?:select|exec|update)\b").find_iter(code) {
        if !boundary(code, q.start()) {
            continue;
        }
        let rest = &code[q.end()..];
        let named = |f: &regex::Match| {
            let after = rest[f.end()..].trim_start_matches([' ', '\t']);
            after.starts_with(':') && !after.starts_with("::")
        };
        let Some(from) = re!(r"\bfrom\b").find_iter(rest).find(|f| !named(f)) else {
            continue;
        };
        let list = &rest[..from.start()];
        if list.contains(['\n', ';']) && re!(r"\n\S").is_match(list) {
            continue;
        }
        let mut depth = 0i32;
        let mut opens = vec![true; list.len()];
        for (i, b) in list.bytes().enumerate() {
            match b {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                _ => {}
            }
            opens[i] = depth == 0;
        }
        for a in re!(r"(?:^|[,\s])([a-z][A-Za-z0-9_]*)\s*:").captures_iter(list) {
            let name = a.get(1).unwrap();
            if !opens[name.start()] || list[a.get(0).unwrap().end()..].starts_with(':') {
                continue;
            }
            let before = list[..name.start()].trim_end();
            if matches!(name.as_str(), "by" | "from") {
                if before.is_empty() || before.ends_with(',') {
                    add(
                        q.end() + name.start(),
                        "QF013",
                        format!(
                            "Column `{}`: q reads it as the keyword, not a column name, and \
                             the query fails",
                            name.as_str()
                        ),
                    );
                }
            } else if RESERVED.iter().any(|n| n == name.as_str()) {
                add(
                    q.end() + name.start(),
                    "QF013",
                    format!(
                        "Column `{}` is a builtin name: q refuses the query ('assign)",
                        name.as_str()
                    ),
                );
            }
        }
    }
    // Match the Python rule's outer-body traversal, including nested assignments.
    // Only a brace outside every lambda already scanned opens an outer body:
    // `{a:{x}; b:{count:1; x}}` is one body, scanned once (#252).
    let mut scanned = 0;
    for (at, _) in code.match_indices('{') {
        if at < scanned {
            continue;
        }
        if let Some(end) = matching(code, at, b'{', b'}') {
            scanned = end;
            let mut offset = at;
            for line in code[at..end].split_inclusive('\n') {
                // A query keyword assigned is refused when the lambda is
                // defined: q 5 `{select:1;0}` is 'from, `{delete:1;0}` 'type.
                for a in re!(r"\b(select|exec|update|delete)\s*:").captures_iter(line) {
                    let m = a.get(0).unwrap();
                    if boundary(line, m.start()) && !line[m.end()..].starts_with(':') {
                        add(
                            offset + m.start(),
                            "QF003",
                            format!("Local assignment to `{}`", &a[1]),
                        );
                    }
                }
                offset += line.len();
            }
            // A column is not a local: in a query phrase or a table literal,
            // `count:1` names one, which is QF013's to report (#192). The
            // view blanks both over their own extent, whatever lines they
            // span.
            let view = semantics::local_view(&code[at..end], true);
            // Global (`sum::1`) and compound (`sum+:1`, `count,:1`) assignment
            // are refused the same: q 5 'assign where the lambda is defined
            // (#432). `sum_:1` is the name `sum_`.
            for a in re!(r"([a-z][a-z0-9_]*)\s*(?:[-+*%,#_^&|!?@$~=<>]|:)?:").captures_iter(&view) {
                let m = a.get(0).unwrap();
                // Read in the source, where a string or symbol is still
                // there to assign: q 5 `{sum::"a"}` is 'assign (#592).
                if m.as_str().len() > a[1].len() + 1 && !assigns_operand(&source[at + m.end()..]) {
                    continue;
                }
                // q 5 takes from and by as locals: {from:1;from+1}[] is 2.
                // A typed parameter, `{[count:`j] 1}`, is QF001's (#327).
                let typed_parameter = enclosing_brace(code, at + m.start()).is_some_and(|b| {
                    let sig = signature(code, source, b);
                    sig.named && at + m.start() < sig.body
                });
                if boundary(&view, m.start())
                    && !view[m.end()..].starts_with(':')
                    && !matches!(&a[1], "from" | "by")
                    && reserved(&a[1], at + m.start())
                    && !typed_parameter
                {
                    add(
                        at + m.start(),
                        "QF003",
                        format!("Local assignment to `{}`", &a[1]),
                    );
                }
            }
        }
    }
    // A builtin as the target of a multiple assignment, `(til;b):1 2` or
    // `([til;b]):d`, or of an indexed one, `til[0]:1`, is refused as `til:1`
    // is: q 5 'nyi or 'match, at the root or when the lambda runs, and an
    // indexed one in a lambda where it is defined. `from` and `by` are
    // accepted, as they are alone (#634).
    {
        let mut namespaces: Vec<(usize, bool)> = vec![(0, false)];
        let mut offset = 0;
        for line in code.split_inclusive('\n') {
            if let Some(ns) = semantics::opens(line, &source[offset..offset + line.len()]) {
                namespaces.push((offset, !ns.is_empty()));
            }
            offset += line.len();
        }
        let indexed = re!(r"\b([a-z][A-Za-z0-9_]*)\s*\[[^\[\]]*\]\s*[-+*%,#_^&|!?@$~=<>]?:")
            .captures_iter(code)
            .filter(|c| {
                let m = c.get(0).unwrap();
                boundary(code, m.start())
                    && !code[m.end()..].starts_with(':')
                    && assigns_operand(&code[m.end()..])
            })
            .map(|c| (c.get(0).unwrap().start(), c.get(1).unwrap().as_str()));
        // With nothing to assign the colons apply the function, as they do
        // after a name: q 5 `d:1f-(cor)::` is a function.
        let assigned = |&(at, _): &(usize, &str)| {
            matching(code, at, b'(', b')').is_some_and(|close| {
                let rest = code[close..].trim_start();
                assigns_operand(rest.trim_start_matches(':'))
            })
        };
        let mut targets: Vec<(usize, &str)> = semantics::multi_assignments(code)
            .chain(semantics::global_multi_assignments(code))
            .filter(assigned)
            .chain(indexed)
            .filter(|&(at, name)| reserved(name, at) && !matches!(name, "from" | "by"))
            .collect();
        targets.sort();
        targets.dedup();
        for (at, name) in targets {
            if enclosing_brace(code, at).is_some() {
                add(at, "QF003", format!("Local assignment to `{name}`"));
            } else if namespaces.iter().rev().find(|(o, _)| *o <= at).unwrap().1 {
                add(at, "QF004", format!("Namespace-level `{name}`"));
            } else {
                // Refused at the root as in a namespace, so QF004's, which
                // `general` holds (#778).
                add(
                    at,
                    "QF004",
                    format!("Root-level assignment to `{name}`: q refuses it"),
                );
            }
        }
    }
    // Documentation that names a parameter the lambda does not have.
    //
    // The FINOS qdoc convention spells this `@param name description`, and
    // real q uses the tag widely even where it uses a different vocabulary
    // around it. A documented name absent from the signature is unambiguous:
    // the signature changed and the comment did not, or the name is a typo -
    // `folderRoot` above a lambda taking `folderRoots`.
    //
    // Only names that are documented and absent. Parameters with no `@param`
    // are not reported: plenty of q is documented in prose, and demanding a
    // tag per parameter is a different and much larger opinion.
    // Read from the source: `v.comments` blanks comments and keeps strings,
    // so the text of a comment exists only here. A match is a comment rather
    // than code because `code` has it blanked at the same offsets. `[ \t]`,
    // not `\s`: a match that starts on a blank line above the block reads
    // its run of `@param` lines as empty (#674).
    for m in re!(r"(?m)^[ \t]*/+[ \t]*@param[ \t]+([A-Za-z][A-Za-z0-9_]*)").captures_iter(source) {
        let name = m.get(1).unwrap();
        if !code[name.start()..name.end()].trim().is_empty() {
            continue;
        }
        // The signature this comment sits above: the next `{[` in the code
        // view, provided only comments and blank lines lie between.
        let rest = &code[m.get(0).unwrap().end()..];
        let Some(brace) = rest.find('{') else {
            continue;
        };
        // Every whole line between has to be another comment line, so the
        // block is describing the lambda directly beneath it. A blank line
        // separates them, and then the comment is about something else. The
        // last line is exempt: it carries the name being assigned, which is
        // what `readFolder:{[...]` looks like from here.
        // The lambda has to be directly beneath the block. One newline means
        // the next line carries it; more means there are lines in between, and
        // each of those has to be another comment line. A blank line among
        // them separates the two, and then the comment is about something
        // else entirely.
        let between = &source[m.get(0).unwrap().end()..m.get(0).unwrap().end() + brace];
        let mut lines = between.split('\n');
        lines.next(); // the rest of the `@param` line itself
        let mut rest_of_block = lines.collect::<Vec<_>>();
        rest_of_block.pop(); // the line the brace is on, carrying the name
        // The run of `@param` lines this one belongs to. When it names
        // exactly the parameters of another lambda in the file, it documents
        // that lambda: two doc blocks written back to back, the first for a
        // function defined further down (uqf's microstructure.q documents
        // cancel_to_trade_ratio_by, then undefined_if_zero, then defines
        // them in the other order). A run that matches no lambda is stale
        // documentation, which is what this rule is for.
        let line_start = source[..m.get(0).unwrap().start()]
            .rfind('\n')
            .map_or(0, |p| p + 1);
        let run: std::collections::BTreeSet<&str> = source[..line_start]
            .lines()
            .rev()
            .take_while(|l| re!(r"^\s*/+\s*@param\b").is_match(l))
            .chain(
                source[line_start..]
                    .lines()
                    .take_while(|l| re!(r"^\s*/+\s*@param\b").is_match(l)),
            )
            .filter_map(|l| {
                re!(r"@param\s+([A-Za-z][A-Za-z0-9_]*)")
                    .captures(l)
                    .map(|c| c.get(1).unwrap().as_str())
            })
            .collect();
        // And only a lambda with no `@param` block of its own above it: one
        // whose documentation is elsewhere - here. Lambdas sharing a
        // parameter list are common (KX ml's many `[config]` functions), and
        // each documented in place is not what a stray run describes.
        let documents_another = code.match_indices('{').any(|(b, _)| {
            let other = signature(code, source, b);
            let at = source[..b].rfind('\n').map_or(0, |p| p + 1);
            let documented = source[..at]
                .lines()
                .rev()
                .take_while(|l| l.trim_start().starts_with('/'))
                .any(|l| re!(r"@param\b").is_match(l));
            other.named
                && !documented
                && other.slots.len() == run.len()
                && other.slots.iter().all(|p| run.contains(p))
        });
        if documents_another {
            continue;
        }
        if rest_of_block
            .iter()
            .any(|l| !l.trim_start().starts_with('/'))
        {
            continue;
        }
        let at = m.get(0).unwrap().end() + brace;
        // The lambda has to be the value assigned. In KX ml's
        // `xv.pcSplit:xv.i.applyIdx{[pc;n;features;target] ...}` it is the
        // argument of a projection, and the block documents what that
        // projection takes - `function` among it.
        let lead = &code[code[..at].rfind('\n').map_or(0, |p| p + 1)..at];
        if !re!(r"^\s*(?:\.?[A-Za-z][A-Za-z0-9_.]*\s*::?)?\s*$").is_match(lead) {
            continue;
        }
        let sig = signature(code, source, at);
        if !sig.named || sig.slots.is_empty() {
            continue;
        }
        // A typed or pattern slot binds names of its own: `a:`j` binds a,
        // `(p;q)` binds p and q (#331).
        if !sig
            .slots
            .iter()
            .any(|slot| pattern_names(slot).contains(&name.as_str()))
        {
            add(
                name.start(),
                "QS007",
                format!(
                    "`@param {}` names a parameter this lambda does not take; it declares {:?}",
                    name.as_str(),
                    sig.slots
                ),
            );
        }
    }
    // `a:a` assigns a name to itself. There is no q in which that is the
    // intention; it is a typo for a different name or for `a:a+...`, and the
    // reader cannot tell which. The right side has to be the whole of the
    // expression, so `a:a+1` and `a:a where a>0` are left alone.
    // Depth zero only, and matched against the real text. Inside a bracket
    // `([]time:time;...)` names a table column after the variable filling it,
    // which is ordinary q. Blanking brackets instead was worse: it collapses
    // `updmeta[`a]:updmeta[`b]` and `res:(f)res` into something that looks
    // like a name assigned to itself, and neither is.
    let depth: Vec<bool> = {
        let mut out = Vec::with_capacity(code.len());
        let mut open = 0i32;
        // `(` and `[` only. A lambda body is statement context - `{[x] b:b}`
        // is the common place to find this - so braces do not count, and the
        // `[x]` signature opens and closes before the body begins.
        for b in code.bytes() {
            if b")]".contains(&b) {
                open -= 1;
            }
            out.push(open <= 0);
            if b"([".contains(&b) {
                open += 1;
            }
        }
        out
    };
    // `::` too, and a last statement that ends at the brace: q 5 `x::x`,
    // `{b:1;b::b}` and `{x:x}` each assign the name to itself.
    //
    // The name has to end the value. A string is blank in `code`, so
    // `a:a"x"` - an index - is checked against the view that keeps it. And a
    // line end ends a statement only where q says it does: at the top level
    // an indented next line continues it (q 5: `x:x` over `  where x>3` is a
    // filter), and inside a lambda a newline is a blank (`{a:1;a:a` over
    // `  +1}` returns 2).
    let ends = |name_end: usize, end: usize| {
        let term = code[name_end..end].trim_end_matches([';', '}']).len() + name_end;
        if !v.comments[name_end..term].trim().is_empty() {
            return false;
        }
        if code[name_end..end].ends_with([';', '}']) {
            return true;
        }
        let rest = &code[end..];
        let Some(next) = rest.find(|c: char| !c.is_whitespace()) else {
            return true;
        };
        if enclosing_brace(code, name_end).is_some() {
            return rest[next..].starts_with([';', '}']);
        }
        let line = code[..end + next].rfind('\n').map_or(0, |i| i + 1);
        !source[line..].starts_with([' ', '\t'])
    };
    // Inside a lambda the name has to be the lambda's own already - a
    // parameter, or assigned earlier in its body. Otherwise the `a:` makes
    // `a` a local that the right side reads before it has a value, and q 5
    // refuses the lambda: `{b:1; a:a; a}` is 'a even with a global `a`.
    // That is QF014's finding. `::` and a dotted name are the global, and
    // `{b:1; a::a}` loads.
    let own = |name: &str, at: usize, op: &str| {
        let Some(brace) = enclosing_brace(code, at) else {
            return true;
        };
        if name.contains('.') || op.trim_start().starts_with("::") {
            return true;
        }
        let sig = signature(code, source, brace);
        if sig.named {
            if sig.slots.contains(&name) {
                return true;
            }
        } else if matches!(name, "x" | "y" | "z") {
            return true;
        }
        let body = top_level(&code[sig.body..at]);
        body.match_indices(name).any(|(i, _)| {
            let after = &body[i + name.len()..];
            let op = after.trim_start_matches([' ', '\t']);
            boundary(&body, i)
                && !after.starts_with(|c: char| c.is_ascii_alphanumeric() || "_.".contains(c))
                && op.starts_with(':')
                && !op.starts_with("::")
        })
    };
    for m in re!(
        r"(?m)(\.?[A-Za-z][A-Za-z0-9_.]*)\s*::?\s*(\.?[A-Za-z][A-Za-z0-9_.]*)[ \t\r]*(?:;|\}|$)"
    )
    .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        if depth.get(whole.start()) == Some(&true)
            && boundary(code, whole.start())
            && m[1] == m[2]
            && ends(m.get(2).unwrap().end(), whole.end())
            && own(&m[1], whole.start(), &whole.as_str()[m[1].len()..])
        {
            add(
                whole.start(),
                "QB017",
                format!("`{}` is assigned to itself", &m[1]),
            );
        }
    }
    // Two literals compared. The answer is fixed before the program runs, so
    // either the comparison is dead or one side was meant to be a name.
    // A side may be a vector - `1 2 3>2` compares the whole of `1 2 3`, so
    // the operand quoted back is all of it, not its last item.
    // The statement's blanks around the operator: `same:`a=` and then a
    // column-0 `` `a `` are two statements (#743).
    for m in re!(concat!(
        r"(-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)*|(?:`[A-Za-z][A-Za-z0-9_.]*)+)",
        blank!(),
        r"*(=|<>|<=|>=|<|>)",
        blank!(),
        r"*(-?\d[A-Za-z0-9.]*(?:[ \t]+-?\d[A-Za-z0-9.]*)*|(?:`[A-Za-z][A-Za-z0-9_.]*)+)"
    ))
    .captures_iter(code)
    {
        let whole = m.get(0).unwrap();
        // The right operand has to be the whole of one. Saying which
        // characters may not follow is the wrong way round in q, where almost
        // any glyph continues an expression - `0<0^x` fills before comparing
        // and `0<1_x` drops before it, and both look like `0<0` and `0<1` to a
        // pattern. So: the comparison ends here, or it was never one.
        if !boundary(code, whole.start()) || !operand_ends(code, &v.comments, whole.end()) {
            continue;
        }
        // Two vectors are QT006's: of different lengths they are an error,
        // not a constant. One side has to be an atom.
        let vector =
            |side: &str| side.trim().contains([' ', '\t']) || side.matches('`').count() > 1;
        // With a vector on one side, a symbol against a number is QT015's
        // 'type alone; two atoms keep both findings, as they always have.
        let symbol = |side: &str| side.trim_start().starts_with('`');
        let either = vector(&m[1]) || vector(&m[3]);
        if (vector(&m[1]) && vector(&m[3])) || (either && symbol(&m[1]) != symbol(&m[3])) {
            continue;
        }
        add(
            whole.start(),
            "QB018",
            format!(
                "`{}` compares two literals; the answer is the same every run",
                whole.as_str().trim()
            ),
        );
    }
    // The same with a char atom on a side, which `code` blanks: q 5
    // `"a"="b"` is 0b and `"a"=97` is 1b, every run. Read from `comments`,
    // where the string is still text; only a one-character string is an atom.
    let char_atom = r#""(?:[^"\\]|\\.)""#;
    let number = r"-?\d[A-Za-z0-9.]*";
    let pair = regex::Regex::new(&format!(
        r"({char_atom}|{number})[ \t]*(=|<>|<=|>=|<|>)[ \t]*({char_atom}|{number})"
    ))
    .unwrap();
    for m in pair.captures_iter(&v.comments) {
        let whole = m.get(0).unwrap();
        // Each quote has to open a string, not close one.
        let opens = |g: regex::Match| {
            !g.as_str().starts_with('"') || v.string_starts.binary_search(&g.start()).is_ok()
        };
        if !(m[1].starts_with('"') || m[3].starts_with('"'))
            || !opens(m.get(1).unwrap())
            || !opens(m.get(3).unwrap())
            || !boundary(&v.comments, whole.start())
            || !operand_ends(&v.comments, &v.comments, whole.end())
        {
            continue;
        }
        add(
            whole.start(),
            "QB018",
            format!(
                "`{}` compares two literals; the answer is the same every run",
                whole.as_str()
            ),
        );
    }
    // QB016 in functional form: `![t;c;0b;cols]` with both a where list
    // and columns is 'nyi (q 5), as the delete phrase is.
    // On the next line too, where q joins it: `!` over `  [t;...]` (#574).
    for m in re!(r"![ \t]*(?:(?:\r?\n[ \t]*)*\r?\n[ \t]+)?\[").find_iter(code) {
        let (bang, open) = (m.start(), m.end() - 1);
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[open + 1..close - 1]);
        if parts.len() != 4 || parts[2].trim() != "0b" {
            continue;
        }
        // Only a where list that plainly holds something: `0#()`, `( )` and
        // `` `symbol$() `` are empty too, and q 5 runs each (#561).
        let filter = parts[1].trim();
        let columns = parts[3].trim();
        let listed = filter.strip_prefix('(').and_then(|f| f.strip_suffix(')'));
        if (re!(r"^(?:enlist\b|,)").is_match(filter)
            || listed.is_some_and(|f| !f.trim().is_empty()))
            && re!(r"^(?:enlist\s*`[A-Za-z_][\w.]*|,`[A-Za-z_][\w.]*|(?:`[A-Za-z_][\w.]*){2,})$")
                .is_match(columns)
        {
            add(
                bang,
                "QB016",
                "`![t;c;0b;cols]` cannot name columns and filter rows at once; that is 'nyi at \
                 runtime"
                    .into(),
            );
        }
    }
    // QB006 in a condition: the same right-to-left reading applies outside
    // a where phrase. q 5: `x:0;y:1;if[x=0 and y=0;...]` runs the branch,
    // since it reads `x=(0 and y=0)`.
    for m in re!(r"(?:\b(?:if|while)|\$)\[").find_iter(code) {
        if m.as_str() != "$[" && !boundary(code, m.start()) {
            continue;
        }
        let open = m.end() - 1;
        let Some(close) = matching(code, open, b'[', b']') else {
            continue;
        };
        let parts = slots(&code[open + 1..close - 1]);
        if parts.len() < 2 || (m.as_str() == "$[" && parts.len() < 3) {
            continue;
        }
        if comparison_swallowed(&flat_filter(parts[0])) {
            add(
                m.start(),
                "QB006",
                "Comparison left of and/or without parentheses: q evaluates right to left, so \
                 it reads `a=1 and b=0` as `a=(1 and b=0)`, not `(a=1) and b=0`"
                    .into(),
            );
        }
    }
    // QB006 everywhere else: an assigned, returned or bracketed boolean
    // reads the same way. q 5: `{[a;b] ok:a>0 and b>0; ok}[1;-1]` is 1b,
    // since it reads `a>(0 and b>0)` (#2092). A condition slot and a where
    // phrase are reported above and below, so they are left to those.
    let conditions: std::collections::HashSet<usize> = re!(r"(?:\b(?:if|while)|\$)\[")
        .find_iter(code)
        .filter(|m| m.as_str() == "$[" || boundary(code, m.start()))
        .map(|m| m.end())
        .collect();
    for (start, mut flat, at) in bare_segments(code, source) {
        if conditions.contains(&start) || flat.trim_start().starts_with('\\') {
            continue;
        }
        if let Some(w) = re!(r"\bwhere\b").find(&flat) {
            flat.truncate(w.start());
        }
        let mut clause_start = 0;
        for clause in flat.split(',') {
            if comparison_swallowed(clause) {
                // At the expression, past a lambda's signature `[]`.
                let body = clause.trim_start();
                let body = body.strip_prefix("[]").unwrap_or(body).trim_start();
                add(
                    at[clause_start + clause.len() - body.len()],
                    "QB006",
                    "Comparison left of and/or without parentheses: q evaluates right to left, \
                     so it reads `a=1 and b=0` as `a=(1 and b=0)`, not `(a=1) and b=0`"
                        .into(),
                );
                break;
            }
            clause_start += clause.len() + 1;
        }
    }
    // `if`, `while` and `do` are statements: each returns `::`, so
    // assigning one assigns null. `$[...]` is the expression form.
    // A global assignment does the same, and so do parentheses of its own:
    // q 5 `a:(if[1b;2])` and `a::if[1b;2]` leave a as `::` (#644).
    for m in re!(r"[A-Za-z0-9_\])]\s*::?\s*(\(\s*)?(if|while|do)\s*\[").captures_iter(code) {
        if let Some(paren) = m.get(1) {
            let open = m.get(0).unwrap().end() - 1;
            let alone = matching(code, open, b'[', b']').is_some_and(|close| {
                matching(code, paren.start(), b'(', b')')
                    // `get`: a `)` before the `]`, as in `a:(if[1b;2)]`,
                    // closes before the bracket does, and is no paren round it.
                    .is_some_and(|end| {
                        code.get(close..end - 1)
                            .is_some_and(|s| s.trim().is_empty())
                    })
            });
            if !alone {
                continue;
            }
        }
        // The gap may legitimately span lines - an assignment continued onto
        // an indented line is ordinary q, inside a lambda body as much as at
        // the top level. What it may not span is a string: that arrives here
        // as blanks, so `\s*` would otherwise step over twenty-six lines of
        // one and join an assignment to an unrelated `if[` far below. The raw
        // source still has the quote that says which happened.
        //
        // This cannot move into the statement loop below to get the bound for
        // free. That loop folds only at the top level, and the continued
        // assignments this rule is about are usually inside a lambda body,
        // where nothing is folded.
        if source[m.get(0).unwrap().range()].contains('"') {
            continue;
        }
        add(
            m.get(0).unwrap().start(),
            "QB011",
            format!(
                "`{}` is a statement and always returns null; `$[...]` is the conditional \
                     that has a value",
                &m[2]
            ),
        );
    }
    let mut namespace = false;
    // A KDB-X module - a file loaded with `use`, which says so by assigning
    // what it exports - runs in a namespace of its own, so a dotted name in
    // it is a sub-namespace as it would be under `\d`: KX's Kafka module
    // defines `i.checkDict` and reads it back as `i.checkDict`.
    let module = re!(r"\bexport\s*:\s*\(").is_match(code);
    let mut depth = 0i32;
    let mut offset = 0;
    // Statements, not lines. q continues a line onto the next when that one
    // begins with whitespace, so `"/" sv string` and an indented `dir,name`
    // below it are one expression - and a rule that reads a line at a time
    // sees two fragments and reports nothing. Verified against q: at column 0
    // the same second line is a separate statement, and an unterminated
    // string on the first line is an error rather than a continuation.
    //
    // Each group is a contiguous byte range, so every `offset + m.start()` in
    // the rules below still lands where it did.
    // Whether each byte sits inside parentheses. There `name:` is a column of
    // a table literal or a key of a dictionary one, written across lines the
    // way TorQ and kdb-parquet write wide tables - not an assignment, and so
    // not the name the naming rules below are about.
    let in_parens: Vec<bool> = {
        let mut depth = 0i32;
        code.bytes()
            .map(|b| {
                match b {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                depth > 0
            })
            .collect()
    };
    let statements = statement_groups(code, source);
    // QP008's copy of the file, made at its first candidate pair.
    let mut unparenthesised = None;
    // QB015's exception: a char column compared with a string as long (#754).
    let char_columns = semantics::char_column_comparisons(code, &v.comments);
    // Where each group's top-level statement ends. Inside a bracket every
    // line is a group of its own, but a query there may go on over the next
    // lines - a newline in a lambda is whitespace - so the query rules read
    // on to here, keeping only what starts in the group (#334).
    // Only as far as the statement the group's last one goes on into: a
    // group inside a lambda read on to the lambda's end, so a long body was
    // quadratic in its lines (#708).
    let statement_end: Vec<usize> = {
        let (mut open, mut ends) = (0i32, vec![0; statements.len()]);
        let mut first = 0;
        for (n, &(start, end)) in statements.iter().enumerate() {
            if open <= 0 {
                first = n;
            }
            for b in code[start..end].bytes() {
                match b {
                    b'(' | b'[' | b'{' => open += 1,
                    b')' | b']' | b'}' => open -= 1,
                    _ => {}
                }
            }
            if open <= 0 || n + 1 == statements.len() {
                ends[first..=n].fill(end);
            }
        }
        for (n, &(start, end)) in statements.iter().enumerate() {
            let mut depth = code[start..end].bytes().fold(0i32, |d, b| match b {
                b'(' | b'[' | b'{' => d + 1,
                b')' | b']' | b'}' => d - 1,
                _ => d,
            });
            depth = depth.max(0);
            let rest = &code.as_bytes()[end..ends[n]];
            for (i, &b) in rest.iter().enumerate() {
                match b {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' | b';' if depth == 0 => {
                        ends[n] = end + i + 1;
                        break;
                    }
                    b')' | b']' | b'}' => depth -= 1,
                    _ => {}
                }
            }
        }
        ends
    };
    for (group, (start, end)) in statements.into_iter().enumerate() {
        let (raw, line, literals) = (
            &source[start..end],
            &code[start..end],
            &v.comments[start..end],
        );
        let (query, query_literals) = (
            &code[start..statement_end[group]],
            &v.comments[start..statement_end[group]],
        );
        // The directives and the bare-slash rule are about one physical line,
        // so they read the first of the group rather than the whole of it.
        let first = line.split_inclusive('\n').next().unwrap_or(line);
        let first_raw = raw.split_inclusive('\n').next().unwrap_or(raw);
        let line_depth = depth;
        for c in line.bytes() {
            if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                depth -= 1;
            }
        }
        // Not after the end of the script: q 5 reads nothing past a lone `\`.
        // Only a `/` alone in column 0 opens one, as the masker reads it: an
        // indented `/` line is not a block comment. Any line of the group:
        // a block between `a:1+` and its continuation `  2` folds into the
        // statement, and still opens a block comment (#318).
        let mut at = start;
        for physical in raw.split_inclusive('\n') {
            if uqf
                && physical.trim_end_matches([' ', '\t', '\r', '\n']) == "/"
                && !v.foreign_offsets.contains(&at)
                && v.script_end.is_none_or(|end| at < end)
            {
                add(at, "QP001", "Bare slash opens a block comment".into());
            }
            at += physical.len();
        }
        // Any blanks between `\d` and its argument, as q 5 reads them:
        // `\d<TAB>.foo` switches and `\d  .` returns to the root (#313).
        if let Some(d) = re!(r"^\\d[ \t]+(\S*)$").captures(first.trim()) {
            namespace = &d[1] != ".";
            // Point at the directive that is still in force at EOF, so the
            // finding names the namespace the file actually ends in.
            offset += line.len();
            continue;
        }
        if system_command(first_raw) {
            offset += line.len();
            continue;
        }
        // `\t` and `\ts` run the rest of their line as q, so the statement
        // rules read it, with the command blanked (#309).
        let timed = timed_prefix(first_raw);
        let untimed;
        let line = if timed > 0 {
            untimed = format!("{}{}", " ".repeat(timed), &line[timed..]);
            untimed.as_str()
        } else {
            line
        };
        // `system "d .ns"` switches as `\d .ns` does (#261).
        if let Some(ns) = semantics::opens(first, first_raw) {
            namespace = !ns.is_empty();
        }
        // More from the same guidelines:
        //
        //   "Do not use unnecessary parentheses - the compiler doesn't need
        //    them, they confuse experienced q coders"
        //
        // Only a parenthesised single token, which is unnecessary whatever the
        // precedence around it. Deciding that in general needs q's precedence,
        // and q's precedence is one rule applied to everything, so "necessary"
        // is a judgement about the reader rather than the parser.
        for m in
            re!(r"\((\s*(?:\.?[A-Za-z][A-Za-z0-9_.]*|-?\d[A-Za-z0-9.]*)\s*)\)").captures_iter(line)
        {
            let whole = m.get(0).unwrap();
            // `f(x)` is a call, not a parenthesised operand, and `(x)` after a
            // name is how q spells one.
            if line[..whole.start()].ends_with(|c: char| c.is_alphanumeric() || "_.`]".contains(c))
            {
                continue;
            }
            // `1_` is drop applied to 1, not a token: the string it drops from
            // is blanks by the time this runs, so the parentheses look empty.
            // No q number contains an underscore, and a name that does is
            // QS001's business.
            // A string between the parentheses is blank in `line` too, so
            // `(system "cd")` would read as `(system)`. The source has it.
            if literals[whole.range()] != *whole.as_str() {
                continue;
            }
            // A keyword in parentheses is a value, not a decorated token:
            // `(mod) . 7 3` is 1, and `mod . 7 3` does not parse. The
            // parentheses there are the point.
            if RESERVED.iter().any(|n| n == m[1].trim()) {
                continue;
            }
            if m[1].contains('_') {
                continue;
            }
            // Next to another literal the parentheses are what keep two
            // tokens apart: `1 2 (3)` indexes `1 2` at 3 (q 5: 0N), and
            // `3 (-1)` applies 3, where `1 2 3` and `3 -1` are vectors.
            // So is one held in parentheses of its own: `(1.5)(2)` is 'type,
            // and with both pairs gone it would be the vector `1.5 2`. The
            // first pair alone can go - `1.5(2)` is the same application -
            // so only the second is left (#516).
            let numeric = m[1]
                .trim()
                .starts_with(|c: char| c == '-' || c.is_ascii_digit());
            if numeric
                && (re!(r"(?:^|[^A-Za-z0-9_.])-?\d[A-Za-z0-9.:]*$|\(\s*-?\d[A-Za-z0-9.:]*\s*\)$")
                    .is_match(line[..whole.start()].trim_end())
                    || line[whole.end()..]
                        .trim_start_matches([' ', '\t'])
                        .starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '.'))
            {
                continue;
            }
            add(
                offset + whole.start(),
                "QS004",
                format!("`{}` wraps a single token in parentheses", whole.as_str()),
            );
        }
        // Names, from the FINOS q coding guidelines:
        //
        //   "**avoid** underscores `_` in names and expressions - `_` is an
        //    operator so names containing it can confuse the reader"
        //
        //   "don't use `.` in names, as this looks like a namespace but its
        //    validity is actually a parser bug ... Do `.myspace.myvar`,
        //    Don't `myspace.myvar`"
        //
        //   "`l` never use letter `l`, looks like number `1` in some fonts"
        //
        // Assignment targets only: a name being read might be someone else's,
        // and there is nothing for the reader of this file to act on. At the
        // start of each line of the statement: an indented line continues
        // it, and `f:{x}` + `  l:1` still assigns `l` (#214) - unless the
        // line continues a qSQL phrase, where `name:` names a column:
        // `r:select` + `  total_qty:sum qty from t` assigns nothing (#694).
        // And at the start of each statement after a `;` or a lambda's `{`:
        // `x:1;my_var:2` and `f:{l:1;l}` assign as the same lines broken
        // after the `;` do (#662).
        for m in re!(r"(?m)(?:^|[;{])[ \t]*(\.?[A-Za-z][A-Za-z0-9_.]*)\s*::?").captures_iter(line) {
            let at = offset + m.get(1).unwrap().start();
            if line[m.get(0).unwrap().end()..].starts_with([':', '='])
                || in_parens[at]
                || in_qsql_phrase(code, at)
            {
                continue;
            }
            let target = m.get(1).unwrap();
            let text = target.as_str();
            if text.contains('_') {
                add(
                    offset + target.start(),
                    "QS001",
                    format!("`{text}` contains `_`, which is also the drop operator"),
                );
            }
            // Only at root. Inside `\d .ns` a dotted name is a sub-namespace -
            // `i.helper` there is `.ns.i.helper`, which q creates properly -
            // and the guidance is about the name at root that merely looks
            // like one.
            if !namespace
                && !module
                && text.trim_start_matches('.').contains('.')
                && !text.starts_with('.')
            {
                add(
                    offset + target.start(),
                    "QS002",
                    format!(
                        "`{text}` has a dot but does not start with one, so it reads as a namespace it is not"
                    ),
                );
            }
            if text == "l" {
                add(
                    offset + target.start(),
                    "QS003",
                    "`l` is hard to tell from `1` in many fonts".into(),
                );
            }
        }
        // Each statement on the line, not only the first, when the line opens
        // at the root: `y:1;sum:2` is 'assign as `sum:2` is (#244).
        let mut heads = vec![(0, line)];
        if line_depth == 0 {
            let mut from = 0;
            for part in slots(line) {
                let lead = part.len() - part.trim_start().len();
                if from > 0 {
                    heads.push((from + lead, &part[lead..]));
                }
                from += part.len() + 1;
            }
        }
        for &(at, head) in &heads {
            // Of the 181 reserved names q refuses to assign inside a namespace
            // all but two: `from` and `by` are accepted there and read back fine,
            // checked one by one. TorQ's email settings define `.email.from`.
            // Compound assignment too: q 5 `count+:1` is 'assign at the root
            // and in a namespace, while `count::1` is accepted in both (#432).
            let compound = |m: &regex::Captures| {
                let end = m.get(0).unwrap().end();
                !head[end..].starts_with(':')
                    && (m[0].trim_end_matches(':').trim_end().len() == m[1].len()
                        || assigns_operand(&source[offset + at + end..]))
            };
            if namespace
                && let Some(m) =
                    re!(r"^([a-z][a-zA-Z0-9_]*)\s*[-+*%,#_^&|!?@$~=<>]?:").captures(head)
                && compound(&m)
                && reserved(&m[1], offset + at)
                && !matches!(&m[1], "from" | "by")
            {
                // Nothing is shadowed: q 5 refuses the assignment with
                // 'assign and the file stops loading there (#677).
                add(
                    offset + at,
                    "QF004",
                    format!(
                        "Namespace-level assignment to `{}`: q refuses it ('assign)",
                        &m[1]
                    ),
                );
            }
            // The root is where q is inconsistent about reserved names:
            // `count:1` and `where:1` it refuses ('assign), `select:1` it
            // cannot parse, but `from:1` and `by:1` it silently accepts. A
            // lambda body at column 0 must not be mistaken for root scope,
            // hence the brace depth.
            if !namespace
                && line_depth == 0
                && let Some(m) =
                    re!(r"^([a-z][a-zA-Z0-9_]*)\s*[-+*%,#_^&|!?@$~=<>]?:").captures(head)
                && compound(&m)
                && reserved(&m[1], offset + at)
            {
                // Checked one by one on q 5: every reserved name but these
                // two is refused at the root, which makes it QF004's and
                // `general`'s; the two q accepts are a habit (#778).
                if matches!(&m[1], "from" | "by") {
                    add(
                        offset + at,
                        "QF012",
                        format!(
                            "Root-level assignment to `{}`: q accepts it, but the name is a query \
                             keyword everywhere else",
                            &m[1]
                        ),
                    );
                } else {
                    add(
                        offset + at,
                        "QF004",
                        format!("Root-level assignment to `{}`: q refuses it", &m[1]),
                    );
                }
            }
        }
        // Inside an expression too, outside a lambda and a query: q 5
        // refuses `a:count:1`, `a:x+count:1`, `a:(til:1)`, `a:first :b`,
        // `a:x[count:1]` and `a:(count::1)` with 'assign, as a file holding
        // `a:x:count:1` stops loading there - `from` and `by` included in
        // none of it (#2231). A query's own assignments are QF013's and
        // QT028's; nothing to assign applies the function (`a:count::`).
        if line_depth == 0 {
            for m in re!(r"\b([a-z][a-zA-Z0-9_]*)\s*[-+*%,#_^&|!?@$~=<>]?:").captures_iter(line) {
                let whole = m.get(0).unwrap();
                let (p, name) = (whole.start(), &m[1]);
                let at = offset + p;
                let end = whole.end() + usize::from(line[whole.end()..].starts_with(':'));
                if heads.iter().any(|&(h, _)| h == p)
                    || !boundary(code, at)
                    || matches!(
                        name,
                        "select" | "exec" | "update" | "delete" | "from" | "by"
                    )
                    || !reserved(name, at)
                    || !assigns_operand(&line[end..])
                    || enclosing_brace(code, at).is_some()
                    || in_query(code, at)
                    || in_table_literal(code, at)
                {
                    continue;
                }
                add(
                    at,
                    "QF004",
                    format!("Assignment to `{name}` inside an expression: q refuses it ('assign)"),
                );
            }
        }
        // The parentheses have to be empty in the source - a string between
        // them is blank in `line`, so `(!).("S=;")` would pass for `. ()` -
        // and the whole of the right operand: `. (),y` applies to a list.
        // Reported at the `.` itself, which is where the fix edits.
        for m in re!(r"\.\s*\(\s*\)").find_iter(line) {
            if re!(r"\(\s*\)$").is_match(&literals[m.range()])
                && operand_ends(code, &v.comments, offset + m.end())
            {
                add(offset + m.start(), "QA004", "`. ()`".into());
            }
        }
        // `/` after a value is the over adverb. `10/2` and `(a+b)/2` are '/
        // parse errors (with a space before it, `/` opens a comment and the
        // rest of the line vanishes - the comment view has already removed
        // that case). Division is `%`.
        // A file symbol is a path, and `` `:data/2024/01 `` has digits either
        // side of its slashes; symbols are blanked first so it is not read
        // as one.
        let unsym = re!(r"`[A-Za-z0-9_.:/]*")
            .replace_all(line, |m: &regex::Captures| " ".repeat(m[0].len()));
        // A bracketed projection with an operand to its left is over, not a
        // misspelled division: `x (1024*)/ 1` and `(10>)(2*)/1` run, and
        // the author meant both. Without that left operand q refuses even
        // the projection - `(2*)/1` is '/ - so only that pairing is let go.
        let over = |m: &regex::Match| {
            if !unsym[m.start()..].starts_with(')') {
                return false;
            }
            let b = unsym.as_bytes();
            let (mut depth, mut open) = (0i32, None);
            for i in (0..=m.start()).rev() {
                match b[i] {
                    b')' => depth += 1,
                    b'(' => {
                        depth -= 1;
                        if depth == 0 {
                            open = Some(i);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let Some(open) = open else { return false };
            // A function named or written in the parentheses too: q 5
            // `3 (g)/1` is 8 and `{x<100} ({x*2})/1` is 128 (#509).
            let inner = unsym[open + 1..m.start()].trim();
            let projection = inner.ends_with(|c: char| "+-*%&|^=<>~,#_!?@.$:".contains(c))
                || re!(r"^\.?[A-Za-z][A-Za-z0-9_.]*$").is_match(inner)
                || (inner.starts_with('{') && inner.ends_with('}'));
            let operand = unsym[..open]
                .trim_end()
                .ends_with(|c: char| c.is_alphanumeric() || ")]}".contains(c));
            projection && operand
        };
        // A digit that ends a name is no number: `0 add2/ 1 2 3` is over
        // with `add2`, 6 on KDB-X (#1297).
        let named = |m: &regex::Match| {
            let b = unsym.as_bytes();
            let mut i = m.start();
            if !b[i].is_ascii_digit() {
                return false;
            }
            while i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_') {
                i -= 1;
            }
            b[i].is_ascii_alphabetic() || b[i] == b'_'
        };
        if let Some(m) = re!(r"[\d)]/\s*[\d(]")
            .find_iter(&unsym)
            .find(|m| !over(m) && !named(m))
        {
            add(
                offset + m.start(),
                "QB014",
                "`/` is the over adverb, not division; q divides with `%`".into(),
            );
        }
        // `delete` takes columns or a where phrase, never both; q says 'nyi.
        // The table is a name or a parenthesised expression - a `select`
        // after `from` would take the `where` for itself, and so is neither.
        for m in re!(r"\bdelete\s+[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s+from\s+").find_iter(query)
        {
            if m.start() >= line.len() {
                break;
            }
            let rest = &query[m.end()..];
            let after = if rest.starts_with('(') {
                matching(query, m.end(), b'(', b')').map(|close| &query[close..])
            } else {
                re!(r"^`?[A-Za-z_][\w.]*")
                    .find(rest)
                    .map(|t| &rest[t.end()..])
            };
            if after.is_some_and(|a| re!(r"^\s+where\b").is_match(a)) {
                add(
                    offset + m.start(),
                    "QB016",
                    "`delete` cannot name columns and filter rows in one phrase; that is 'nyi at \
                     runtime"
                        .into(),
                );
                break;
            }
        }
        // A cast named by symbol converts a string char by char - `long$"123"`
        // is `49 50 51`, and `date$"2024.01.01"` is ten dates - with no error
        // to say so. The uppercase-char cast `"J"$` parses text. `char` and
        // `byte` are legitimate on a string. `symbol` and `guid` convert
        // nothing: q 5 refuses them with 'type, which is QT032's, in general.
        // The backtick has to be code: in `"use `symbol$"` the string's own
        // closing quote once read as the cast's operand (#596). A string in
        // parentheses is the same operand: `` `symbol$("ab") `` (#615). Searched one
        // start at a time, so a rejected match does not hide a later one.
        // The symbol and guid casts by type char and by type number too: q 5
        // `"s"$"ab"`, `"g"$"ab"`, `11h$"ab"` and `2h$"ab"` are 'type, while
        // `-11h$` and `-2h$` parse (#505); for those the `$` has to be code.
        let cast = |mut at: usize| {
            while let Some(m) = re!(
                r#"(?:`(long|int|short|float|real|boolean|date|time|timestamp|timespan|month|minute|second|datetime|symbol|guid)|"([sg])"|(?:^|[^-\w.])(11|2)h)\s*\$\s*(?:"|\(\s*"(?:[^"\\\n]|\\.)*"\s*\))"#
            )
            .captures_at(literals, at)
            {
                let start = m.get(0).unwrap().start();
                let typed = m.get(1).or(m.get(2)).or(m.get(3)).unwrap();
                let dollar = typed.end() + literals[typed.end()..].find('$').unwrap();
                let in_code = if m.get(1).is_some() {
                    line.as_bytes()[typed.start() - 1] == b'`'
                } else {
                    line.as_bytes()[dollar] == b'$'
                };
                // The string has to be the whole operand: in
                // `` `date$"I"$x `` it is the type of another cast, and q 5
                // gives 2019.03.02 for x "7000" (#1202).
                let whole = m.get(0).unwrap();
                let close = if whole.as_str().ends_with(')') {
                    Some(whole.end())
                } else {
                    let mut i = whole.end();
                    let b = literals.as_bytes();
                    while i < b.len() && b[i] != b'"' {
                        i += if b[i] == b'\\' { 2 } else { 1 };
                    }
                    (i < b.len()).then_some(i + 1)
                };
                // A char atom has one code, and that is what the cast gives:
                // `int$"a" is 97i where "I"$"a" is 0Ni (#1298). Symbol and
                // guid refuse it all the same.
                let open = dollar + 1 + literals[dollar + 1..].find('"').unwrap();
                let atom = re!(r#"^"(?:[^"\\]|\\(?:[0-7]{3}|.))""#).is_match(&literals[open..])
                    && m.get(1).is_some_and(|n| !matches!(n.as_str(), "symbol" | "guid"));
                if in_code
                    && !atom
                    && close.is_some_and(|c| operand_ends(code, &v.comments, offset + c))
                {
                    return Some(m);
                }
                at = start + 1;
            }
            None
        };
        if let Some(m) = cast(0) {
            let name = match (m.get(1), m.get(2), m.get(3)) {
                (Some(n), _, _) => n.as_str(),
                (_, Some(c), _) | (_, _, Some(c)) => match c.as_str() {
                    "s" | "11" => "symbol",
                    _ => "guid",
                },
                _ => unreachable!(),
            };
            // At the backtick or the quote, or the number's first digit.
            let at = match (m.get(1).or(m.get(2)), m.get(3)) {
                (Some(n), _) => n.start() - 1,
                (_, Some(n)) => n.start(),
                _ => unreachable!(),
            };
            let ch = match name {
                "long" => "J",
                "int" => "I",
                "short" => "H",
                "float" => "F",
                "real" => "E",
                "boolean" => "B",
                "date" => "D",
                "time" => "T",
                "timestamp" => "P",
                "timespan" => "N",
                "month" => "M",
                "minute" => "U",
                "second" => "V",
                "datetime" => "Z",
                "guid" => "G",
                _ => "",
            };
            // `symbol` and `guid` are the exceptions: q 5 refuses them with
            // 'type rather than converting codes, so they are another rule
            // with another message.
            let code = if matches!(name, "symbol" | "guid") {
                "QT032"
            } else {
                "QT004"
            };
            let detail = if name == "symbol" {
                "`symbol$ on a string is 'type; the cast to symbol is `$\"...\"".to_string()
            } else if name == "guid" {
                "`guid$ on a string is 'type; parsing text is \"G\"$\"...\"".to_string()
            } else {
                format!(
                    "`{name}$ on a string casts each character's code, not the text; parsing \
                     text is \"{ch}\"$\"...\""
                )
            };
            add(offset + at, code, detail);
        }
        // QT004 by a lowercase type char too: q 5 `"j"$"12"` is 49 50, the
        // codes, and `"d"$"20"` two dates near 2000.02.20, where `"J"$"12"`
        // is 12. A lowercase cast of a string is also how q gives a
        // character's code - `"i"$"A"` is 65 - and of every character of a
        // text, so only a literal of two characters or more that reads as a
        // number or a temporal, which is text to parse, and only as the
        // whole operand. Not `"c"` or `"x"`, which keep the characters, nor
        // `"s"` and `"g"`, which q refuses (QT032).
        for m in re!(
            r#""([bhijefpmdznuvt])"[ \t]*\$[ \t]*(\([ \t]*)?"(-?[0-9][0-9.:DTeE+-]+)"([ \t]*\))?"#
        )
        .captures_iter(literals)
        {
            let whole = m.get(0).unwrap();
            let dollar = m.get(1).unwrap().end() + 1;
            let dollar = dollar + literals[dollar..].find('$').unwrap();
            if line.as_bytes()[dollar] != b'$'
                || m.get(2).is_some() != m.get(4).is_some()
                || !operand_ends(code, &v.comments, offset + whole.end())
            {
                continue;
            }
            let letter = &m[1];
            add(
                offset + whole.start(),
                "QT004",
                format!(
                    "\"{letter}\"$ on a string casts each character's code, not the text; \
                     parsing text is \"{}\"$\"...\"",
                    letter.to_ascii_uppercase()
                ),
            );
        }
        // Equality against a string literal in a filter pairs each row with
        // one character. q 5: 'length whenever the row count differs from
        // the string's length, on any column; when they agree, 'type on a
        // symbol or string column (`([]s:`a`b`c)` and `([]s:("ab";"cd"))`),
        // and a row-by-row comparison of chars on a char column -
        // `([]c:"ab")` where c="ab" returns both rows. A one-char string is a
        // char atom and compares fine, so only other lengths are the trap.
        // Both `where` and the operator have to be code. `literals` keeps
        // strings, so an `=` inside `"="` once matched here, its closing quote
        // read as the opening one of the compared string - and the fix turned
        // `"="` into `" like "`. An operator that is code can only be followed
        // by a string's opening quote, so checking it is enough.
        let in_code = |at: usize| query.as_bytes().get(at) == query_literals.as_bytes().get(at);
        // Searched one start at a time, not match after match: a rejected
        // match runs on to the next quote and would swallow a real one.
        let comparison = |from: usize| {
            let mut at = from;
            while let Some(m) =
                re!(r#"(?:=|<>)\s*"((?:[^"\\]|\\.)*)""#).captures_at(query_literals, at)
            {
                let op = m.get(0).unwrap().start();
                let n = q_bytes(&m[1]).len();
                // The `=` of `<=` or `>=` is an order comparison, not the
                // equality this rule is about - and the fix made `c<="ab"`
                // into `c< like "ab"`, which q 5 cannot parse (#407).
                let order = query_literals.as_bytes()[..op].ends_with(b"<")
                    || query_literals.as_bytes()[..op].ends_with(b">");
                // The string has to be the whole right operand: q 5
                // `n="abcd"?"b"` compares n with 1, and `n="abcd"[1]` with
                // "b" (#435).
                if in_code(op)
                    && n != 1
                    && !order
                    && operand_ends(query, query_literals, m.get(0).unwrap().end())
                {
                    return Some((op, n));
                }
                at = op + 1;
            }
            None
        };
        // The string on the left is the same comparison: q 5 `select from
        // ([]s:`ab`cd) where "ab"=s` is 'type (#639). It is the whole left
        // operand when the operator follows its closing quote - q reads
        // right to left, so whatever is before it is applied to the result.
        let left = |from: usize| {
            re!(r#""((?:[^"\\]|\\.)*)"[ \t]*(?:=|<>)"#)
                .captures_iter(&query_literals[from..])
                .map(|m| (from + m.get(0).unwrap().end(), q_bytes(&m[1]).len()))
                .map(|(end, n)| {
                    (
                        end - 1 - usize::from(query_literals[..end].ends_with("<>")),
                        n,
                    )
                })
                .find(|&(op, n)| in_code(op) && n != 1)
        };
        // A where phrase: a qSQL keyword earlier in the statement, and the
        // `=` before the phrase ends. `r:where s="ab"` is the where
        // function on a comparison, and `a:where b; c:x="ab"` two statements.
        // The query has to start in this group; one starting in a later
        // group is that group's to report.
        let filter = re!(r"\bwhere\b").find_iter(query).find(|w| {
            let from = query[..w.start()].rfind(';').map_or(0, |p| p + 1);
            re!(r"\b(?:select|exec|update|delete)\b")
                .find_iter(&query[from..w.start()])
                .last()
                .is_some_and(|k| from + k.start() < line.len())
        });
        if let Some(w) = filter
            && let Some((op, n)) = comparison(w.end()).into_iter().chain(left(w.end())).min()
            && op < phrase_end(query, w.end())
            && !char_columns.contains(&(offset + op))
        {
            let rows = match n {
                0 => "the table is empty".to_string(),
                n => format!("the table has exactly {n} rows"),
            };
            add(
                offset + op,
                "QB015",
                format!(
                    "Equality against a string in a filter pairs each row with one character: \
                     q raises 'length unless {rows}, and 'type even then on a symbol or string \
                     column; `like`, `~` or `in` is the comparison meant"
                ),
            );
        }
        if re!(r"\b(?:where|select|exec|update|delete)\b").is_match(line) {
            let mut search = 0;
            // The statement each comparison is in, and whether a qSQL keyword
            // starts before it there, read on from the last comparison: from
            // the line's start for each, a long where phrase was quadratic
            // (#707).
            let (mut semi, mut scanned, mut keyword) = (0, 0, false);
            // Any comparison is constant against itself: `a<>a` and `a<a`
            // keep no row, `a<=a` every one (#638).
            while let Some(m) =
                re!(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(<>|<=|>=|=|~|<|>)\s*([a-zA-Z_][a-zA-Z0-9_]*)\b")
                    .captures_at(line, search)
            {
                // The right name has to be the whole operand: `c=c i` compares
                // a column with an item of itself. In a filter a `,` ends one
                // condition as well as the statement's own terminators do.
                // An indented next line continues the operand, in a lambda
                // too, where `query` runs on past this line (#695).
                let whole = m.get(3).unwrap().end();
                let rest = &query[past_blanks(query, whole)..];
                let ends =
                    rest.is_empty() || rest.starts_with([',', ';', ')', ']', '}', '\n', '\r']);
                // And the comparison is in the query's own statement, not
                // another one on its line: `n:a=a; r:select from t`.
                let start = m.get(0).unwrap().start();
                if let Some(p) = line[scanned.min(start)..start].rfind(';') {
                    (semi, keyword) = (scanned.min(start) + p + 1, false);
                    scanned = semi;
                }
                if !keyword {
                    keyword = re!(r"\b(?:where|select|exec|update|delete)\b")
                        .find_at(&line[..start], scanned.saturating_sub(8).max(semi))
                        .is_some();
                }
                scanned = start;
                let query = keyword;
                // The left name whole too: `.cfg.a=a` compares a global with
                // the column (#498).
                if m[1] == m[3] && ends && query && boundary(line, start) {
                    add(
                        offset + start,
                        "QB001",
                        format!("`{}{}{}`", &m[1], &m[2], &m[3]),
                    );
                    search = m.get(0).unwrap().end();
                } else {
                    search = m.get(3).unwrap().start();
                }
            }
            // Every `where` on the line, but not one inside a phrase already
            // read: `s:where b=1 2 3; u:select from t where c=1 2` has its
            // filter in the second (#702).
            let mut read_to = 0;
            for w in re!(r"\bwhere\b").find_iter(line) {
                if w.start() < read_to {
                    continue;
                }
                // To the end of the query's statement: after a `;` is another
                // statement, not more of the filter (#344). Read in `query`,
                // which runs on to where the statement's brackets close: in a
                // lambda each line is a group of its own, and a filter after
                // a `where` that ends one is on the next (#679).
                read_to = phrase_end(query, w.end());
                let phrase = flat_filter(&query[w.end()..read_to]);
                // `~` matches whole operands, so a filter gets one boolean for
                // the entire table where it wanted one per row: a 'type error
                // against a column, or worse, a single-row result against a
                // scalar. `~/:`, `~\:` and each-both `~'` supply the row-wise
                // forms and are left alone, which the trailing character class
                // encodes: any other next byte is the trap (#347).
                //
                // Only the filter itself is scanned. A `~` elsewhere on the
                // line is a different expression that happens to share it -
                // `sel:{$[`~y;x;select from x where sym in y]}` in KX's own
                // u.q is a conditional, not a filter, and parenthesised parts
                // are already blanked out of `phrase`.
                // `where` is also the unary operator that turns a boolean
                // vector into indices - `first where v~x` is not a filter and
                // has no rows to compare. Only a qSQL statement brings the
                // column semantics this rule is about, so one has to be named
                // to its left before the phrase counts as a filter at all -
                // in the `where`'s own statement: `r:select from t; where
                // b=1 2 3` is the function again (#701).
                let qsql = qsql_phrase(query, w.start(), false);
                for m in re!(r"~[^/\\']").find_iter(&phrase).filter(|_| qsql) {
                    add(
                        offset + w.end() + m.start(),
                        "QB005",
                        "Match (`~`) in a filter compares whole operands, not rows".into(),
                    );
                }
                // q gives every infix the same precedence, so `a=1 and b=0`
                // reads as `a=(1 and b=0)` - the comparison eats the logic,
                // and the rows that come back are quietly the wrong ones.
                // Only a comparison to the LEFT of an and/or is the trap:
                // `x and b=0` is fine, because the comparison is the
                // logical's right operand and nothing is left to consume.
                // Parenthesising either side is the fix, and the blanking
                // in `flat_filter` is what recognises it.
                // Clause by clause: in a where phrase `,` starts a new
                // condition, so a comparison in one clause and an `or` in the
                // next are not the trap - TorQ's torq.q pairs them that way.
                // Parenthesised groups are blank in `phrase`, so a comma
                // left in it is a top-level one.
                if phrase.split(',').any(comparison_swallowed) {
                    // Quote the reader's own clause where it is short enough
                    // to read: `a=1 and b=3` reads as `a=(1 and b=3)`.
                    let raw_phrase = &source[start + w.end()..];
                    let groups = grouped(&query[w.end()..w.end() + phrase.len()]);
                    let example = swallowed_comparisons(&groups).first().and_then(|&(a, b)| {
                        let operand = &raw_phrase[a..b];
                        let op = re!(r"<>|<=|>=|[<>=]").find_iter(operand).last()?;
                        let clause_end = phrase[b..].find(',').map_or(phrase.len(), |c| b + c);
                        let rest = raw_phrase[b..clause_end].trim_end();
                        let rest = rest.trim_end_matches(';').trim_end();
                        let (lhs, rhs) = (operand[..op.start()].trim(), operand[op.end()..].trim());
                        (operand.len() + rest.len() <= 60 && !rest.contains('\n')).then(|| {
                            format!(
                                "`{operand}{rest}` as `{lhs}{}({rhs}{rest})`, not \
                                 `({operand}){rest}`",
                                op.as_str()
                            )
                        })
                    });
                    add(
                        offset + w.start(),
                        "QB006",
                        format!(
                            "Comparison left of and/or without parentheses: q evaluates right \
                             to left, so it reads {}",
                            example.unwrap_or_else(|| "`a=1 and b=0` as `a=(1 and b=0)`, not \
                                `(a=1) and b=0`"
                                .into())
                        ),
                    );
                }
                // A column equals one value; against a vector literal the
                // phrase is a length error at runtime, and `in` is the
                // operator that was meant.
                // The literal has to be the whole right operand: `a=1 2 3?b`
                // and `a=0 1 2 b` index it first, and q 5 runs both.
                // Each offending constraint at its own start, where the fix
                // is anchored: the first at `where`, a later one after its
                // comma (#215).
                // Read from the phrase with each bracket kept as `_`: q 5 runs
                // `a=1 2 3[0]`, since the index makes it the atom 1 (#627).
                // From the same text as `phrase`, so the two line up: the
                // line alone is shorter when the statement runs on past it,
                // and indexing it at `phrase`'s offsets panicked.
                let groups = grouped(&query[w.end()..read_to]);
                let mut reported = vec![];
                for m in re!(r"(?:=|<>)\s*(?:-?\d[A-Za-z0-9.]*(?:\s+-?\d[A-Za-z0-9.]*)+|`[A-Za-z][A-Za-z0-9_.]*(?:`[A-Za-z0-9_.]*)+)")
                    .find_iter(&phrase)
                    // The `where` function is no filter: `where b=1 2 3` is
                    // the indices of a boolean vector, and q 5 runs it (#343).
                    .filter(|_| qsql)
                {
                    let rest = groups[m.end()..].trim_start();
                    if !(rest.is_empty() || rest.starts_with([',', ';'])) {
                        continue;
                    }
                    let at = match phrase[..m.start()].rfind(',') {
                        None => offset + w.start(),
                        Some(c) => {
                            let clause = &phrase[c + 1..];
                            offset + w.end() + c + 1 + (clause.len() - clause.trim_start().len())
                        }
                    };
                    if reported.contains(&at) {
                        continue;
                    }
                    reported.push(at);
                    // Row by row, so q 5 runs it when the table has as many
                    // rows as the vector has items (#499).
                    let literal = m.as_str().trim_start_matches(['=', '<', '>']).trim();
                    let n = if literal.starts_with('`') {
                        literal.matches('`').count()
                    } else {
                        literal.split_whitespace().count()
                    };
                    let (op, meant) = if m.as_str().starts_with("<>") {
                        ("<>", "`not` with `in` tests")
                    } else {
                        ("=", "`in` tests")
                    };
                    add(
                        at,
                        "QB008",
                        format!(
                            "`{op}` against a {n}-item vector literal in a filter compares row \
                             by row: q raises 'length unless the table has exactly {n} rows; \
                             {meant} membership"
                        ),
                    );
                }
            }
        }
        // QP002, QP003, QP005 and QP007 pass over a test file, but which file
        // is a test is the configuration's to say - a `tests` directory below
        // its root - so that exemption is applied where the root is known,
        // in `Policy::lint` (#800).
        if uqf {
            // Every pattern but the first has to match code: a help table
            // that spells `".z.Z"` or `"0Nz"` in a string uses neither. The
            // first is the one pattern whose string is the point - `"z"$`.
            let in_code = |m: &regex::Match| line[m.range()] == *m.as_str();
            // A symbol may spell a datetime and hold none: `` `2020.01.01T10 ``
            // is -11h in q 5 (#409). Only the literal's own spelling: a
            // symbol naming the clock, `` `.z.z ``, is there to be looked up.
            let symbols = unsymbolled(line);
            // A file handle names a file whatever it spells: `` `:.z.P `` and
            // `` `:log/.z.Z `` read no clock (#651).
            let paths: Vec<_> = re!(r"`:[A-Za-z0-9_.:/]*")
                .find_iter(line)
                .map(|p| p.range())
                .collect();
            let in_path = |at: usize| paths.iter().any(|p| p.contains(&at));
            let in_code = |m: &regex::Match| {
                in_code(m)
                    && !in_path(m.start())
                    && (!m.as_str().starts_with(|c: char| c.is_ascii_digit())
                        || symbols.as_bytes()[m.start()] == line.as_bytes()[m.start()])
            };
            // Reported at the first of them, which is where the fix starts.
            // Any cast whose type string holds a `z` or `Z`: q 5 `"Z"$"2023.01.01"`
            // parses a datetime, and `"zj"$(1.5;2)` makes one item of one;
            // and a date with a bare `T` or a `z`, `2023.01.01T` and
            // `2023.01.01z`, is a datetime too (#501).
            if let Some(at) = re!(r#""[A-Za-z ]*[zZ][A-Za-z ]*"\s*\$"#)
                .find(literals)
                .into_iter()
                .chain(
                    [
                        re!(r"`datetime\s*\$"),
                        re!(r"\b15h\s*\$"),
                        re!(r"(?:^|[^\w.])-?0[NW]z\b"),
                        re!(r"\b\d{4}\.\d{2}\.\d{2}(?:T|z\b)"),
                        // `.z.z` and `.z.Z` are the clock as a datetime (-15h),
                        // and `.my.z.z` is one dotted name of the file's (#510).
                        re!(r"(?:^|[^\w.])\.z\.[zZ]\b"),
                    ]
                    .iter()
                    .filter_map(|regex| regex.find_iter(literals).find(in_code)),
                )
                // The null's pattern takes in the byte before it.
                .map(|m| match m.as_str().find("0N").or(m.as_str().find("0W")) {
                    Some(at) if m.as_str().ends_with('z') => {
                        m.start() + at - usize::from(m.as_str()[..at].ends_with('-'))
                    }
                    // The `"z"` cast on its `$`: the string is not code, and
                    // a fix only starts in code.
                    _ if m.as_str().starts_with('"') => m.end() - 1,
                    // The clock's pattern takes in the byte before it too;
                    // a date's `z`, `2023.01.01z`, is no clock (#501).
                    _ if m.as_str().ends_with(".z.z") || m.as_str().ends_with(".z.Z") => {
                        m.end() - 4
                    }
                    _ => m.start(),
                })
                .min()
            {
                add(offset + at, "QP002", "Legacy datetime value or cast".into());
            }
            // The clock's own name: `x.z.P` is one dotted name, not `.z.P`.
            for m in re!(r"\.z\.[PTNZD]\b")
                .find_iter(literals)
                .filter(|m| {
                    !line[..m.start()]
                        .ends_with(|c: char| c.is_ascii_alphanumeric() || "_.".contains(c))
                })
                .filter(|m| line[m.range()] == *m.as_str() && !in_path(m.start()))
            {
                let utc = utc_clock(m.as_str());
                add(
                    offset + m.start(),
                    "QP003",
                    format!(
                        "`{}` is the local wall clock; the convention is UTC `{}`",
                        m.as_str(),
                        utc
                    ),
                );
            }
            // One run of each kind is reported per line, its last, and the
            // message names the operators of that run. In a trap the `+` or
            // `-` named is the first after the line's first `*` or `%`; in
            // the other kind the two named are neighbours.
            let runs = infix_runs(line);
            let operator = |o: &(usize, bool)| line.as_bytes()[o.0] as char;
            for (id, trap) in [("QP005", true), ("QP007", false)] {
                let Some(run) = runs.iter().rfind(|run| mixes(run) && traps(run) == trap) else {
                    continue;
                };
                let Some(first) = run.iter().position(|o| o.1) else {
                    continue;
                };
                let multiply = operator(&run[first]);
                let detail = if trap {
                    let add = run[first..].iter().find(|o| !o.1).map_or('+', operator);
                    format!(
                        "`{multiply}` with `{add}` to its right and no parentheses: q \
                         evaluates right-to-left and performs the `{add}` first, where \
                         school precedence performs the `{multiply}` first"
                    )
                } else {
                    let add = operator(&run[first - 1]);
                    format!(
                        "`{add}` with `{multiply}` to its right and no parentheses: q \
                         evaluates right-to-left and performs the `{multiply}` first, as \
                         school precedence does"
                    )
                };
                add(offset, id, detail);
            }
            // QP008, the opposite convention: each pair the forward fix
            // would have written, at its `(`.
            for (at, _) in line.match_indices('(') {
                if let Some(op) =
                    restated_pair(&v, source, (start, end), start + at, &mut unparenthesised)
                {
                    add(
                        start + at,
                        "QP008",
                        format!(
                            "Parentheses round the right operand of `{}` that q's order already \
                             implies: q evaluates right-to-left, so the operand is grouped without them",
                            source.as_bytes()[op] as char
                        ),
                    );
                }
            }
        }
        // Infix, or the pattern as the second argument in brackets:
        // `like["abc";"a*b*"]` is 'nyi as well.
        for m in re!(r"\blike\b").find_iter(line) {
            if !boundary(line, m.start()) || line[..m.start()].ends_with('.') {
                continue;
            }
            // q 5 takes one `*` anywhere, or a leading and a trailing pair:
            // "abc" like "a*c" and "*b*" are 1b, "a*b*" and "**" are 'nyi.
            // A `*` inside `[...]` is a literal star, and a `]` straight after
            // the `[` (or `[^`) is a member, not the end: q 5 `"*x" like
            // "[]*]*"` is 1b (#436).
            let refused = |pat: &str| {
                let stars = re!(r"\[\^?\]?[^\]]*\]")
                    .replace_all(pat, "")
                    .matches('*')
                    .count();
                let ends = pat.len() > 2 && pat.starts_with('*') && pat.ends_with('*');
                stars > 2 || (stars == 2 && !ends)
            };
            if let Some(pat) = like_patterns(line, literals, m.end())
                .into_iter()
                .find(|p| refused(p))
            {
                add(offset + m.start(), "QB002", format!("like \"{pat}\""));
            }
        }
        // QB003: `", " sv string clash," - two workers share it"`. `,` binds
        // the literal onto the list before `string` and `sv` run, so each of
        // its characters becomes an item and sv interleaves them - "w1, w2,
        // , -,  , t, w, o, ...". Verified in q 5. Only a literal of two or more
        // characters: one character is a single item (`"/" sv string a,"x"`
        // is "dir/x", as meant), an empty one adds nothing, and two symbols
        // joined - `"/" sv string a,b` - is the path join it looks like, which
        // is why this rule was once withdrawn whole.
        // In brackets too, `sv["/";string a,"ab"]`, and a literal in
        // parentheses of its own is the same literal: q 5 `"/" sv string
        // a,("ab")` is "x/y/a/b" (#642).
        let mut starts: Vec<(usize, usize)> = re!(r"\bsv\s+string\s+")
            .find_iter(line)
            .filter(|m| boundary(line, m.start()))
            .map(|m| (m.start(), m.end()))
            .collect();
        for m in re!(r"\bsv\s*\[").find_iter(line) {
            let open = m.end() - 1;
            if !boundary(line, m.start()) {
                continue;
            }
            let Some(close) = matching(line, open, b'[', b']') else {
                continue;
            };
            let parts = slots(&line[open + 1..close - 1]);
            if parts.len() == 2 {
                let second = parts[1].as_ptr() as usize - line.as_ptr() as usize;
                if let Some(s) = re!(r"^\s*string\s+").find(parts[1]) {
                    starts.push((m.start(), second + s.end()));
                }
            }
        }
        for (report, start) in starts {
            let (mut depth, mut at) = (0i32, start);
            let bytes = line.as_bytes();
            let mut joined = None;
            while at < bytes.len() {
                match bytes[at] {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' if depth == 0 => break,
                    b')' | b']' | b'}' => depth -= 1,
                    b';' if depth == 0 => break,
                    b',' if depth == 0 => {
                        let rest = &literals[at + 1..];
                        let mut quote = at + 1 + (rest.len() - rest.trim_start().len());
                        let paren = literals[quote..].starts_with('(');
                        if paren {
                            let rest = &literals[quote + 1..];
                            quote += 1 + (rest.len() - rest.trim_start().len());
                        }
                        if literals.as_bytes().get(quote) == Some(&b'"')
                            && line.as_bytes().get(quote) != Some(&b'"')
                            && let Some(lit) =
                                re!(r#"^"((?:[^"\\]|\\.)*)""#).captures(&literals[quote..])
                            && re!(r"\\.|[^\\]").find_iter(&lit[1]).count() > 1
                            && (!paren
                                || literals[quote + lit.get(0).unwrap().len()..]
                                    .trim_start()
                                    .starts_with(')'))
                        {
                            joined = Some(lit.get(0).unwrap().as_str().to_string());
                            break;
                        }
                    }
                    _ => {}
                }
                at += 1;
            }
            if let Some(text) = joined {
                add(
                    offset + report,
                    "QB003",
                    format!(
                        "`,{text}` is joined onto the list before `string` and `sv` run, so its \
                         characters become separate items; parenthesise the sv: \
                         `(... sv string x),{text}`"
                    ),
                );
            }
        }
        offset += line.len();
    }
    // String escapes, over the whole file at once. A backslash is in a string
    // exactly when `views` blanked it from `code` and kept it in `comments`;
    // toggling on quotes a statement at a time cannot know that a statement
    // which starts on the second line of a string starts inside one.
    {
        let (b, c) = (v.comments.as_bytes(), code.as_bytes());
        let mut i = 0;
        while i < b.len() {
            if b[i] != b'\\' || c[i] != b' ' {
                i += 1;
                continue;
            }
            // q 5 also takes `\/` as a slash: "a\/b" is "a/b".
            if b.get(i + 1).is_some_and(|c| b"\\\"nrt/".contains(c)) {
                i += 2;
                continue;
            }
            if i + 3 < b.len()
                && b"0123".contains(&b[i + 1])
                && b[i + 1..i + 4].iter().all(|c| b"01234567".contains(c))
            {
                i += 4;
                continue;
            }
            add(
                i,
                "QE002",
                // The whole char after the backslash, which may be more than
                // one byte: `\é` is named as such, not half of it (#233).
                format!(
                    "Invalid escape \\{}",
                    v.comments[i + 1..]
                        .chars()
                        .next()
                        .map(String::from)
                        .unwrap_or_default()
                ),
            );
            i += 2;
        }
    }
    let chars: Vec<_> = v.comments.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].1 == '"' {
            i += 1;
            while i < chars.len() && chars[i].1 != '"' {
                i += if chars[i].1 == '\\' { 2 } else { 1 };
            }
        } else if chars[i].1 == '\''
            && chars.get(i + 1).is_some_and(|c| c.1 == '"')
            // Straight after an operand or a verb, `'` is each, not a
            // signal: q 5 `"ab",'"xy"` is ("ax";"by") (#625).
            && !i
                .checked_sub(1)
                .is_some_and(|p| chars[p].1.is_alphanumeric() || "_)]}\"`+-*%,#$@&|^=<>~!?.".contains(chars[p].1))
        {
            let (mut j, mut depth, mut length) = (i + 1, 0usize, 0);
            while j < chars.len() {
                let c = chars[j].1;
                if c == '"' {
                    let start = chars[j].0 + 1;
                    j += 1;
                    while j < chars.len() && chars[j].1 != '"' {
                        j += if chars[j].1 == '\\' { 2 } else { 1 };
                    }
                    let end = chars.get(j).map_or(v.comments.len(), |c| c.0);
                    length += q_bytes(&v.comments[start..end]).len();
                } else if "([{ ".contains(c) && c != ' ' {
                    depth += 1;
                } else if ")]}".contains(c) {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                } else if c == ';' && depth == 0 {
                    break;
                }
                j += 1;
            }
            // q 5 keeps the first 254 bytes of a signalled string, cutting a
            // multi-byte char in half if it must (#230).
            if length > 254 {
                add(
                    chars[i].0,
                    "QB004",
                    format!(
                        "Thrown message with {length} bytes of literal text; q keeps only the first 254"
                    ),
                );
            }
        }
        i += 1;
    }
    // Before the profile filters anything, so a finding of a rule this
    // profile leaves out still counts as one its `noqa` is there for.
    // The QK rules run only for a configuration (`lint_every_rule`).
    let ran = |code: &str| {
        code == "QE001" && structure_selected
            || code != "QE001"
                && (opt_in || !code.starts_with("QK"))
                && RULES.iter().find(|r| r.code == code).is_some_and(|r| {
                    matches!(r.scope.as_str(), "builtin" | "style" | "styleq" | "uqf")
                        && profile.allows(&r.scope)
                        || opt_in && r.scope == "opt-in"
                })
    };
    let unused = unused_noqa(path, source, &v, &out, &structure_lines, ran);
    out.extend(unused);
    // One choke point: a rule states its scope in the taxonomy and the profile
    // decides whether that scope is wanted. Filtering here rather than guarding
    // sixty emission sites keeps the two from drifting apart.
    out.retain(|f| {
        RULES
            .iter()
            .find(|r| r.code == f.code)
            .is_none_or(|r| profile.allows(&r.scope) || opt_in && r.scope == "opt-in")
    });
    suppress(&mut out, source, &v);
    out.sort_by(|a, b| {
        (&a.path, a.line, &a.rule, &a.detail).cmp(&(&b.path, b.line, &b.rule, &b.detail))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::number_end;

    /// `text` in tokens, blanks left out: a number as `number_end` reads it
    /// (with a `-` before it at the start, after a blank or after an
    /// operator, as q joins a negative literal), a name, or one character.
    fn tokens(text: &str) -> Vec<&str> {
        let b = text.as_bytes();
        let (mut out, mut i) = (vec![], 0);
        let digit = |at: usize| {
            b.get(at).is_some_and(u8::is_ascii_digit)
                || b.get(at) == Some(&b'.') && b.get(at + 1).is_some_and(u8::is_ascii_digit)
        };
        while i < b.len() {
            let start = i;
            if b[i] == b' ' {
                i += 1;
                continue;
            }
            if digit(i) {
                i = number_end(text, i);
            } else if b[i] == b'-'
                && digit(i + 1)
                && (b.get(i.wrapping_sub(1)) == Some(&b' ')
                    || out.last().is_none_or(|t: &&str| {
                        t.len() == 1 && !t.as_bytes()[0].is_ascii_alphanumeric()
                    }))
            {
                i = number_end(text, i + 1);
            } else if b[i].is_ascii_alphabetic() {
                i += b[i..]
                    .iter()
                    .take_while(|c| c.is_ascii_alphanumeric() || **c == b'_' || **c == b'.')
                    .count();
            } else {
                i += 1;
            }
            out.push(&text[start..i]);
        }
        out
    }

    /// A number's tokens are q's own: each literal here with the tokens
    /// `-4!` gives for it on KDB-X 5, blanks left out (#2057, #2099).
    #[test]
    fn a_number_ends_where_q_tokenizes_it() {
        let cases: &[(&str, &[&str])] = &[
            ("1e-3", &["1e-3"]),
            ("1E-3", &["1E", "-", "3"]),
            ("1e+3", &["1e+3"]),
            ("1E+3", &["1E", "+", "3"]),
            ("1E3", &["1E3"]),
            ("1.5E-3", &["1.5E", "-", "3"]),
            ("1.5e-3", &["1.5e-3"]),
            (".5E-3", &[".5E", "-", "3"]),
            (".5e-3", &[".5e-3"]),
            ("1.E-3", &["1.E", "-", "3"]),
            ("1.e-3", &["1.e-3"]),
            ("2E", &["2E"]),
            ("1E", &["1E"]),
            ("1E+", &["1E", "+"]),
            ("1Ef", &["1Ef"]),
            ("2E3f", &["2E3f"]),
            ("1E03", &["1E03"]),
            ("1e-03", &["1e-03"]),
            ("1e-3f", &["1e-3f"]),
            ("1e-3e", &["1e-3e"]),
            ("1e-3e-2", &["1e-3e-2"]),
            ("1e1e-1", &["1e1e-1"]),
            ("2e-3j", &["2e-3j"]),
            ("1e-", &["1e-"]),
            ("1e+", &["1e", "+"]),
            ("1e+x", &["1e", "+", "x"]),
            ("1e-x", &["1e-x"]),
            ("1e-y+1", &["1e-y", "+", "1"]),
            ("1e--3", &["1e-", "-", "3"]),
            ("1e+-3", &["1e", "+", "-3"]),
            ("1e-+3", &["1e-", "+", "3"]),
            ("1e+.5", &["1e", "+", ".5"]),
            ("1e3-2", &["1e3", "-", "2"]),
            ("1e-3-1", &["1e-3", "-", "1"]),
            ("3-1e-3", &["3", "-", "1e-3"]),
            ("x-1E-3", &["x", "-", "1E", "-", "3"]),
            ("x*1e-3", &["x", "*", "1e-3"]),
            ("px-1e-3", &["px", "-", "1e-3"]),
            ("x-2e", &["x", "-", "2e"]),
            ("x -1E-3", &["x", "-1E", "-", "3"]),
            ("1f-3", &["1f", "-", "3"]),
            ("1b-3", &["1b", "-", "3"]),
            ("1d-3", &["1d", "-", "3"]),
            ("1he-2", &["1he-2"]),
            ("0x1e-3", &["0x1e-3"]),
            ("0x1E-3", &["0x1E", "-", "3"]),
            ("0x1e", &["0x1e"]),
            ("0Ne-3", &["0Ne-3"]),
            ("0we-1", &["0we-1"]),
            ("0NE-3", &["0NE", "-", "3"]),
            ("12:00e-1", &["12:00e-1"]),
            ("12:00E-1", &["12:00E", "-", "1"]),
            ("2012.01.01e-3", &["2012.01.01e-3"]),
            ("1E-3 1c", &["1E", "-", "3", "1c"]),
            ("1 2E-3", &["1", "2E", "-", "3"]),
            ("1E5 2.5", &["1E5", "2.5"]),
            ("1e-3 2", &["1e-3", "2"]),
            ("10e-1", &["10e-1"]),
            ("2e10", &["2e10"]),
            ("2e+10", &["2e+10"]),
            ("1.5e-2 1e-1 3", &["1.5e-2", "1e-1", "3"]),
            ("-1e-3", &["-1e-3"]),
            ("-2.5e+2", &["-2.5e+2"]),
        ];
        for (text, want) in cases {
            assert_eq!(tokens(text), *want, "{text}");
        }
    }
}
