//! The thresholds and word lists a few rules read, which a configuration's
//! `[rules.<CODE>]` table may change (#1177).
//!
//! A rule reads them from the options installed for the file being linted,
//! as it reads its line table from `LineScope`: the configuration installs
//! them around a lint, and without one every rule sees its built-in default.
//! What can be set is listed once, in `OPTIONS`, which the configuration
//! checks a table against and the editor's JSON Schema is tested against.

use regex::Regex;
use std::rc::Rc;

/// What a `[rules.<CODE>]` key holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// An integer of at least 1.
    Count,
    /// A nonempty list of words: letters, digits and `_`.
    Words,
    /// A regular expression, Rust's `regex` syntax.
    Pattern,
}

/// One option: the rule, its key, what it holds, and what it does.
pub struct RuleOption {
    pub code: &'static str,
    pub key: &'static str,
    pub kind: Kind,
    pub help: &'static str,
}

/// Every option a configuration may set.
pub const OPTIONS: &[RuleOption] = &[
    RuleOption {
        code: "QS006",
        key: "max-lines",
        kind: Kind::Count,
        help: "Lines of code a lambda may have before QS006 reports it (default 25)",
    },
    RuleOption {
        code: "QL001",
        key: "markers",
        kind: Kind::Words,
        help: "The words in a comment QL001 reports as unfinished work \
               (default TODO, FIXME, XXX, HACK)",
    },
    RuleOption {
        code: "QX002",
        key: "name-pattern",
        kind: Kind::Pattern,
        help: "A case-insensitive regular expression the last part of a name must match \
               for QX002 to read its string as a credential (default \
               (?:password|passwd|pwd|secret|token|api_?key|credentials?)$)",
    },
];

/// The options one file is linted with.
#[derive(Clone, Debug)]
pub struct RuleOptions {
    pub max_lines: usize,
    /// QL001's markers, as one pattern of whole words.
    pub markers: Regex,
    /// QX002's, `None` for the built-in one.
    pub name_pattern: Option<Regex>,
}

impl Default for RuleOptions {
    fn default() -> Self {
        RuleOptions {
            max_lines: 25,
            markers: Regex::new(r"\b(TODO|FIXME|XXX|HACK)\b").unwrap(),
            name_pattern: None,
        }
    }
}

/// A value for one option, already read from the configuration.
pub enum Value {
    Count(i64),
    Words(Vec<String>),
    Pattern(String),
}

impl RuleOptions {
    /// Set `code`'s `key` to `value`, or say why it cannot be.
    pub fn set(&mut self, code: &str, key: &str, value: Value) -> Result<(), String> {
        let known = OPTIONS
            .iter()
            .filter(|o| o.code == code)
            .map(|o| o.key)
            .collect::<Vec<_>>();
        if known.is_empty() {
            let codes: Vec<_> = OPTIONS.iter().map(|o| o.code).collect();
            return Err(format!(
                "[rules.{code}]: {code} has no options; the rules that do are {}",
                codes.join(", ")
            ));
        }
        match (code, key, value) {
            ("QS006", "max-lines", Value::Count(n)) if n >= 1 => {
                self.max_lines = usize::try_from(n).unwrap_or(usize::MAX);
            }
            ("QL001", "markers", Value::Words(words))
                if !words.is_empty()
                    && words.iter().all(|w| {
                        !w.is_empty() && w.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    }) =>
            {
                let alternatives: Vec<_> = words.iter().map(|w| regex::escape(w)).collect();
                self.markers = Regex::new(&format!(r"\b({})\b", alternatives.join("|")))
                    .map_err(|e| format!("[rules.QL001] markers: {e}"))?;
            }
            ("QX002", "name-pattern", Value::Pattern(p)) => {
                let compiled = Regex::new(&format!("(?i){p}"))
                    .map_err(|e| format!("[rules.QX002] name-pattern: {e}"))?;
                self.name_pattern = Some(compiled);
            }
            (_, key, _) if known.contains(&key) => {
                let option = OPTIONS
                    .iter()
                    .find(|o| o.code == code && o.key == key)
                    .unwrap();
                return Err(format!(
                    "[rules.{code}] {key} must be {}",
                    match option.kind {
                        Kind::Count => "an integer of at least 1",
                        Kind::Words => "a nonempty list of words (letters, digits and _)",
                        Kind::Pattern => "a regular expression, as a string",
                    }
                ));
            }
            (_, key, _) => {
                return Err(format!(
                    "[rules.{code}]: unknown option `{key}`; {code} reads {}",
                    known.join(", ")
                ));
            }
        }
        Ok(())
    }
}

thread_local! {
    static INSTALLED: std::cell::RefCell<Option<Rc<RuleOptions>>> =
        const { std::cell::RefCell::new(None) };
}

/// Keeps `options` installed for every rule on this thread while it lives,
/// and puts back what was there before when it goes.
pub struct OptionsScope(Option<Rc<RuleOptions>>);

impl OptionsScope {
    pub fn install(options: Rc<RuleOptions>) -> OptionsScope {
        OptionsScope(INSTALLED.with(|o| o.replace(Some(options))))
    }
}

impl Drop for OptionsScope {
    fn drop(&mut self) {
        let previous = self.0.take();
        INSTALLED.with(|o| *o.borrow_mut() = previous);
    }
}

/// The options installed for this lint, or the defaults.
pub(crate) fn current() -> Rc<RuleOptions> {
    thread_local! {
        static DEFAULT: Rc<RuleOptions> = Rc::new(RuleOptions::default());
    }
    INSTALLED
        .with(|o| o.borrow().clone())
        .unwrap_or_else(|| DEFAULT.with(Rc::clone))
}
