//! Where a project's settings come from, the way Ruff finds its own.
//!
//! Each file is governed by the configuration closest to it: the first
//! directory, walking up from the file, that holds `.qlinter.toml`,
//! `qlinter.toml`, or a `pyproject.toml` with a `[tool.qlinter]` table (the
//! older `[tool.q-lint]` is read too). In one directory they are tried in that
//! order. A `pyproject.toml` without the table is passed over and the walk goes
//! on, so a Python project's own `pyproject.toml` does not hide the repository
//! root's settings. Where no directory has one, a user-level
//! `$XDG_CONFIG_HOME/qlinter/qlinter.toml` (or `~/.config/qlinter/...`)
//! applies, and after that the built-in defaults.
//!
//! `--config FILE` replaces the search for every file, and `--isolated`
//! ignores configuration altogether. Flags on the command line win over the
//! file: `--profile` over `profile`, and `--select`, `--extend-select` and
//! `--ignore` are applied after the file's own selection.
//!
//! The keys are Ruff's where Ruff has one. In `qlinter.toml` they sit at the
//! top level, and the rule-selection keys may instead go under `[lint]`:
//!
//! ```toml
//! profile = "style"                 # general | style | styleq | uqf
//! extend = "../qlinter.toml"        # inherit, then override
//! exclude = ["generated/", "vendor/*"]
//! extend-exclude = ["scratch"]
//!
//! [lint]
//! select = ["QE", "QF"]             # codes or prefixes; replaces the profile's set
//! extend-select = ["QS001"]         # added to whatever is selected
//! ignore = ["QF016"]
//! per-file-ignores = { "tests/*" = ["QS"] }
//! ```
//!
//! Selection is resolved the way Ruff resolves it: within one file, the most
//! specific selector wins, so `select = ["QF"]` with `ignore = ["QF016"]`
//! keeps every QF rule but one, and `ignore = ["QS"]` with
//! `extend-select = ["QS001"]` keeps QS001 alone. A file that `extend`s
//! another is applied after it, and the command line after both.
//!
//! Nothing here reads q source; a configuration is TOML and is only parsed.

use q_lint_rs::{Finding, Profile, RULES, Workspace, lint_in};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    rc::Rc,
};

const FILES: [&str; 3] = [".qlinter.toml", "qlinter.toml", "pyproject.toml"];
const KEYS: &str = "profile, select, extend-select, ignore, per-file-ignores, exclude, \
                    extend-exclude, extend and [lint]";

/// One step of rule selection: a configuration file's, or the command line's.
#[derive(Clone, Debug, Default)]
pub struct Layer {
    pub select: Option<Vec<String>>,
    pub extend_select: Vec<String>,
    pub ignore: Vec<String>,
}

/// What one configuration file - with everything it extends - says.
#[derive(Clone, Debug, Default)]
pub struct Settings {
    /// The file this came from; `None` for the built-in defaults.
    pub file: Option<PathBuf>,
    profile: Option<String>,
    layers: Vec<Layer>,
    exclude: Vec<(PathBuf, glob::Pattern)>,
    per_file_ignores: Vec<(PathBuf, glob::Pattern, Vec<String>)>,
}

/// What the command line says, which wins over any file.
#[derive(Clone, Debug)]
pub struct Overrides {
    pub profile: Option<String>,
    /// The profile when neither the flag nor a file names one.
    pub default_profile: &'static str,
    pub layer: Layer,
    /// `--exclude`, relative to the directory qlinter runs in.
    pub exclude: Vec<(PathBuf, glob::Pattern)>,
    pub config: Option<PathBuf>,
    pub isolated: bool,
}

/// Settings for any file, found once per directory and remembered.
pub struct Policy {
    overrides: Overrides,
    /// Directory -> the settings governing files in it.
    cache: RefCell<HashMap<PathBuf, Rc<Settings>>>,
    /// A language server must not exit over a bad file: it reports each
    /// problem once and uses the defaults for the files it governs.
    lenient: bool,
    warned: RefCell<HashSet<String>>,
}

impl Policy {
    pub fn new(overrides: Overrides, lenient: bool) -> Self {
        Policy {
            overrides,
            cache: RefCell::default(),
            lenient,
            warned: RefCell::default(),
        }
    }

    /// Forget every file read, after one of them changed on disk.
    pub fn reset(&self) {
        self.cache.borrow_mut().clear();
    }

    /// The settings for `path`, a file or a directory: the configuration
    /// nearest to it, searching from the directory that contains it.
    pub fn settings(&self, path: &Path) -> Result<Rc<Settings>, String> {
        let path = absolute(path);
        let start = path.parent().unwrap_or(&path).to_path_buf();
        match self.find(&start) {
            Ok(settings) => Ok(settings),
            Err(e) if self.lenient => {
                if self.warned.borrow_mut().insert(e.clone()) {
                    eprintln!("qlinter: {e}; using the defaults where it applies");
                }
                Ok(Rc::new(Settings::default()))
            }
            Err(e) => Err(e),
        }
    }

    fn find(&self, start: &Path) -> Result<Rc<Settings>, String> {
        if self.overrides.isolated {
            return Ok(Rc::new(Settings::default()));
        }
        if let Some(explicit) = &self.overrides.config {
            let key = absolute(explicit);
            if let Some(found) = self.cache.borrow().get(&key) {
                return Ok(found.clone());
            }
            let settings = Rc::new(
                load(&key, 0)?
                    .ok_or_else(|| format!("{}: no [tool.qlinter] table", explicit.display()))?,
            );
            self.cache.borrow_mut().insert(key, settings.clone());
            return Ok(settings);
        }
        let mut visited = vec![];
        let mut found = None;
        for dir in start.ancestors() {
            if let Some(cached) = self.cache.borrow().get(dir) {
                found = Some(cached.clone());
                break;
            }
            visited.push(dir.to_path_buf());
            if let Some(settings) = in_directory(dir)? {
                found = Some(Rc::new(settings));
                break;
            }
        }
        let settings = match found {
            Some(settings) => settings,
            None => Rc::new(user_config()?.unwrap_or_default()),
        };
        let mut cache = self.cache.borrow_mut();
        for dir in visited {
            cache.insert(dir, settings.clone());
        }
        Ok(settings)
    }

    /// The profile in force for `path`: the flag, the file, or the default.
    pub fn profile(&self, settings: &Settings) -> String {
        self.overrides
            .profile
            .clone()
            .or_else(|| settings.profile.clone())
            .unwrap_or_else(|| self.overrides.default_profile.to_string())
    }

    /// Whether `path` is excluded, by its configuration or by `--exclude`.
    pub fn excluded(&self, path: &Path) -> Result<bool, String> {
        let settings = self.settings(path)?;
        let full = absolute(path);
        Ok(settings
            .exclude
            .iter()
            .chain(&self.overrides.exclude)
            .any(|(root, pattern)| matches(&full, root, pattern)))
    }

    /// Whether the rule `code` reports on `path`.
    pub fn enabled(&self, code: &str, path: &Path) -> Result<bool, String> {
        let settings = self.settings(path)?;
        Ok(self.selected(&settings, code) && !per_file_ignored(&settings, code, path))
    }

    fn selected(&self, settings: &Settings, code: &str) -> bool {
        let profile = parse_profile(&self.profile(settings));
        let mut on = RULES
            .iter()
            .find(|r| r.code == code)
            .is_none_or(|r| profile.allows_scope(&r.scope));
        for layer in settings.layers.iter().chain([&self.overrides.layer]) {
            on = apply(layer, code, on);
        }
        on
    }

    /// The findings for one file: every rule run, then only those the
    /// configuration selects for this path. Running the broadest profile and
    /// filtering is exact, because a profile only decides which rules report
    /// - none changes what another finds.
    pub fn lint(&self, source: &str, path: &str, ws: &Workspace) -> Result<Vec<Finding>, String> {
        let file = Path::new(path);
        let settings = self.settings(file)?;
        let mut found = lint_in(source, path, Profile::Uqf, ws);
        found.retain(|f| {
            self.selected(&settings, &f.code) && !per_file_ignored(&settings, &f.code, file)
        });
        Ok(found)
    }

    /// What `--show-settings` prints: which file governs `path`, and what it
    /// turns on there.
    pub fn describe(&self, path: &Path) -> Result<String, String> {
        let settings = self.settings(path)?;
        let mut codes: Vec<&str> = RULES
            .iter()
            .map(|r| r.code.as_str())
            .filter(|code| {
                self.selected(&settings, code) && !per_file_ignored(&settings, code, path)
            })
            .collect();
        codes.sort_unstable();
        Ok(format!(
            "file: {}\nconfiguration: {}\nprofile: {}\nrules ({}): {}",
            absolute(path).display(),
            settings
                .file
                .as_ref()
                .map_or("none - built-in defaults".into(), |f| f
                    .display()
                    .to_string()),
            self.profile(&settings),
            codes.len(),
            codes.join(" ")
        ))
    }
}

/// One layer applied to one code: the longest selector that names the code
/// decides, an ignore winning a tie; a `select` that does not name it turns
/// it off; and a layer that does not mention it leaves it as it was.
fn apply(layer: &Layer, code: &str, on: bool) -> bool {
    let longest = |selectors: &mut dyn Iterator<Item = &String>| {
        selectors
            .filter(|s| names(s, code))
            .map(|s| if s == "ALL" { 0 } else { s.len() })
            .max()
    };
    let enable = longest(&mut layer.select.iter().flatten().chain(&layer.extend_select));
    let disable = longest(&mut layer.ignore.iter());
    match (enable, disable) {
        (Some(e), Some(d)) => e > d,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => on && layer.select.is_none(),
    }
}

fn names(selector: &str, code: &str) -> bool {
    selector == "ALL" || code.starts_with(selector)
}

fn per_file_ignored(settings: &Settings, code: &str, path: &Path) -> bool {
    let full = absolute(path);
    settings
        .per_file_ignores
        .iter()
        .any(|(root, pattern, codes)| {
            codes.iter().any(|s| names(s, code)) && matches(&full, root, pattern)
        })
}

/// Ruff's matching: a pattern is tried against the path relative to the
/// configuration's directory and against each directory above it within that
/// root, so `vendor/*` and `vendor` both cover everything under `vendor/`. A
/// pattern with no `/` names a file or directory anywhere below the root, so
/// `generated` excludes every directory of that name.
fn matches(full: &Path, root: &Path, pattern: &glob::Pattern) -> bool {
    let anywhere = !pattern.as_str().contains('/');
    // The walk asks about every directory before entering it, so a name
    // pattern is checked against the path's own name too - wherever the walk
    // started, which may be above or beside the root.
    if anywhere
        && full
            .file_name()
            .is_some_and(|n| pattern.matches(&n.to_string_lossy()))
    {
        return true;
    }
    let Ok(relative) = full.strip_prefix(root) else {
        return false;
    };
    relative
        .ancestors()
        .filter(|p| !p.as_os_str().is_empty())
        .any(|p| {
            pattern.matches(&p.to_string_lossy().replace('\\', "/"))
                || anywhere
                    && p.file_name()
                        .is_some_and(|n| pattern.matches(&n.to_string_lossy()))
        })
}

/// The configuration a directory holds, if it holds one.
fn in_directory(dir: &Path) -> Result<Option<Settings>, String> {
    for name in FILES {
        let path = dir.join(name);
        if path.is_file()
            && let Some(settings) = load(&path, 0)?
        {
            return Ok(Some(settings));
        }
    }
    Ok(None)
}

fn user_config() -> Result<Option<Settings>, String> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    match base.map(|b| b.join("qlinter").join("qlinter.toml")) {
        Some(path) if path.is_file() => load(&path, 0),
        _ => Ok(None),
    }
}

/// Read one configuration file, and what it extends. `None` for a
/// `pyproject.toml` that has no qlinter table, which is not a configuration.
fn load(path: &Path, depth: usize) -> Result<Option<Settings>, String> {
    if depth > 16 {
        return Err(format!(
            "{}: `extend` goes more than 16 files deep",
            path.display()
        ));
    }
    let shown = path.display();
    let text = fs::read_to_string(path).map_err(|e| format!("{shown}: {e}"))?;
    let data: toml::Table = toml::from_str(&text).map_err(|e| format!("{shown}: {e}"))?;
    let pyproject = path.file_name().is_some_and(|n| n == "pyproject.toml");
    let table = if pyproject {
        let tool = match data.get("tool") {
            None => return Ok(None),
            Some(t) => t
                .as_table()
                .ok_or_else(|| format!("{shown}: tool must be a table"))?,
        };
        match (tool.get("qlinter"), tool.get("q-lint")) {
            (Some(_), Some(_)) => {
                return Err(format!(
                    "{shown}: both [tool.qlinter] and [tool.q-lint]; keep one"
                ));
            }
            (Some(t), None) | (None, Some(t)) => t
                .as_table()
                .ok_or_else(|| format!("{shown}: [tool.qlinter] must be a table"))?
                .clone(),
            (None, None) => return Ok(None),
        }
    } else {
        data
    };
    let root = absolute(path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();

    for key in table.keys() {
        if ![
            "profile",
            "select",
            "extend-select",
            "ignore",
            "per-file-ignores",
            "exclude",
            "extend-exclude",
            "extend",
            "lint",
        ]
        .contains(&key.as_str())
        {
            return Err(format!(
                "{shown}: unknown key `{key}`; qlinter reads {KEYS}"
            ));
        }
    }
    let lint = match table.get("lint") {
        None => toml::Table::new(),
        Some(v) => v
            .as_table()
            .ok_or_else(|| format!("{shown}: [lint] must be a table"))?
            .clone(),
    };
    for key in lint.keys() {
        if !["select", "extend-select", "ignore", "per-file-ignores"].contains(&key.as_str()) {
            return Err(format!(
                "{shown}: unknown key `lint.{key}`; [lint] reads select, extend-select, ignore \
                 and per-file-ignores"
            ));
        }
        if table.contains_key(key) {
            return Err(format!(
                "{shown}: `{key}` is set both at the top and under [lint]"
            ));
        }
    }
    let get = |key: &str| lint.get(key).or_else(|| table.get(key));

    let mut settings = match table.get("extend") {
        None => Settings::default(),
        Some(v) => {
            let base = v
                .as_str()
                .ok_or_else(|| format!("{shown}: extend must be a path"))?;
            let base = root.join(base);
            load(&base, depth + 1)?
                .ok_or_else(|| format!("{}: no [tool.qlinter] table to extend", base.display()))?
        }
    };
    settings.file = Some(absolute(path));
    if let Some(v) = table.get("profile") {
        let name = v
            .as_str()
            .filter(|p| ["general", "style", "styleq", "uqf"].contains(p))
            .ok_or_else(|| {
                format!("{shown}: profile must be one of general, style, styleq, uqf")
            })?;
        settings.profile = Some(name.to_string());
    }
    let selectors = |key: &str| -> Result<Option<Vec<String>>, String> {
        get(key)
            .map(|v| {
                v.as_array()
                    .ok_or_else(|| format!("{shown}: {key} must be an array"))?
                    .iter()
                    .map(|s| {
                        s.as_str()
                            .ok_or_else(|| format!("{shown}: {key} must contain strings"))
                            .and_then(|s| selector(key, s))
                    })
                    .collect()
            })
            .transpose()
    };
    settings.layers.push(Layer {
        select: selectors("select")?,
        extend_select: selectors("extend-select")?.unwrap_or_default(),
        ignore: selectors("ignore")?.unwrap_or_default(),
    });
    for key in ["exclude", "extend-exclude"] {
        if let Some(v) = table.get(key) {
            for p in v
                .as_array()
                .ok_or_else(|| format!("{shown}: {key} must be an array"))?
            {
                let p = p
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| format!("{shown}: {key} must contain nonempty strings"))?;
                settings.exclude.push((root.clone(), pattern(p)?));
            }
        }
    }
    if let Some(v) = get("per-file-ignores") {
        let map = v.as_table().ok_or_else(|| {
            format!("{shown}: per-file-ignores must be a table of glob = [codes]")
        })?;
        for (glob, codes) in map {
            let codes = codes
                .as_array()
                .ok_or_else(|| format!("{shown}: per-file-ignores.\"{glob}\" must be an array"))?
                .iter()
                .map(|s| {
                    s.as_str()
                        .ok_or_else(|| format!("{shown}: per-file-ignores must list strings"))
                        .and_then(|s| selector("per-file-ignores", s))
                })
                .collect::<Result<Vec<_>, _>>()?;
            settings
                .per_file_ignores
                .push((root.clone(), pattern(glob)?, codes));
        }
    }
    Ok(Some(settings))
}

pub fn pattern(text: &str) -> Result<glob::Pattern, String> {
    glob::Pattern::new(text.trim().trim_end_matches('/')).map_err(|e| format!("{text}: {e}"))
}

/// A code or a prefix of codes, refused when it names no rule: a typo in a
/// selection would otherwise select or ignore nothing, silently.
pub fn selector(key: &str, text: &str) -> Result<String, String> {
    let text = text.trim();
    if text == "ALL" || (!text.is_empty() && RULES.iter().any(|r| r.code.starts_with(text))) {
        Ok(text.to_string())
    } else {
        Err(format!(
            "{key}: {text} is not a diagnostic code - `qlinter --rules` lists them"
        ))
    }
}

pub fn parse_profile(name: &str) -> Profile {
    match name {
        "general" => Profile::General,
        "style" => Profile::Style,
        "styleq" => Profile::StyleQ,
        _ => Profile::Uqf,
    }
}

/// `path` made absolute and resolved through symlinks. A path that does not
/// exist - an editor buffer never saved - is resolved through its nearest
/// existing ancestor, so `/var/...` on macOS still matches patterns rooted at
/// the `/private/var/...` a configuration file canonicalizes to.
pub fn absolute(path: &Path) -> PathBuf {
    if let Ok(p) = fs::canonicalize(path) {
        return p;
    }
    let lexical = lexical(path);
    for ancestor in lexical.ancestors().skip(1) {
        if let Ok(real) = fs::canonicalize(ancestor)
            && let Ok(rest) = lexical.strip_prefix(ancestor)
        {
            return real.join(rest);
        }
    }
    lexical
}

fn lexical(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    let p = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            _ => result.push(c),
        }
    }
    result
}
