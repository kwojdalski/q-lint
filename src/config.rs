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
//! exclude = ["generated/", "vendor/*"]   # a `/` anchors at this file's directory
//! extend-exclude = ["scratch"]          # no `/`: a name at any depth
//!                                       # (added to exclude, or its default)
//!
//! target-version = "4.0"          # 3.6 | 4.0 | 4.1 | kdbx: report what does not run there (QK)
//! baseline = "qlinter-baseline.json" # report only findings not in it (`--write-baseline`)
//! required-version = ">=0.33, <0.34" # refuse to run under any other qlinter
//!
//! [lint]
//! select = ["QE", "QF"]             # codes or prefixes; replaces the profile's set
//! extend-select = ["QS001"]         # added to whatever is selected
//! ignore = ["QF016"]
//! per-file-ignores = { "tests/*" = ["QS"] }
//!
//! [severity]                        # by code or prefix; the longest decides
//! QS = "information"                # error | warning | information (info) | hint
//! QS006 = "warning"
//!
//! [rules.QS006]                     # a rule's own options; `options::OPTIONS` lists them
//! max-lines = 40
//! ```
//!
//! Selection is resolved the way Ruff resolves it: within one file, the most
//! specific selector wins, so `select = ["QF"]` with `ignore = ["QF016"]`
//! keeps every QF rule but one, and `ignore = ["QS"]` with
//! `extend-select = ["QS001"]` keeps QS001 alone. A file that `extend`s
//! another is applied after it, and the command line after both.
//!
//! `[severity]` and `[rules.<CODE>]` may also go under `[lint]`. A file that
//! `extend`s another keeps the base's entries and overrides them one by one:
//! a severity by its selector, an option by its key. A severity only changes
//! how a finding is reported - and whether it fails the run, which only an
//! error or a warning does - never whether it is.
//!
//! Nothing here reads q source; a configuration is TOML and is only parsed.

use crate::baseline::Baseline;
use q_lint_rs::{
    Finding, Profile, RULES, Target, Workspace, lint_every_rule,
    options::{self, OptionsScope, RuleOptions},
    version_reported_for,
};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    rc::Rc,
};

pub const FILES: [&str; 3] = [".qlinter.toml", "qlinter.toml", "pyproject.toml"];
/// What `exclude` is until a configuration sets it, as Ruff's default list
/// is: tool and build directories a walk does not enter, by their own name
/// at any depth. A configuration's own `exclude` replaces it, and
/// `extend-exclude` adds to it.
const DEFAULT_EXCLUDE: [&str; 7] = [
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
    "build",
    "dist",
    "target",
];
/// Every key a configuration's top level may hold, and those `[lint]` may.
/// The editor's JSON Schema, `editors/vscode/schemas/qlinter.schema.json`,
/// is tested against both.
pub const TOP_KEYS: [&str; 14] = [
    "profile",
    "select",
    "extend-select",
    "ignore",
    "per-file-ignores",
    "exclude",
    "extend-exclude",
    "extend",
    "lint",
    "target-version",
    "baseline",
    "required-version",
    "severity",
    "rules",
];
pub const LINT_KEYS: [&str; 6] = [
    "select",
    "extend-select",
    "ignore",
    "per-file-ignores",
    "severity",
    "rules",
];
/// What `profile` may be.
pub const PROFILES: [&str; 4] = ["general", "style", "styleq", "uqf"];
/// What `[severity]` may set a rule to: the names an editor shows, with
/// `info` for `information`.
pub const SEVERITIES: [&str; 5] = ["error", "warning", "info", "information", "hint"];

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
    /// The directory its patterns are rooted at: the file's own, or the
    /// current one for `--config` and a user-level file.
    root: Option<PathBuf>,
    profile: Option<String>,
    layers: Vec<Layer>,
    /// `exclude` and `extend-exclude`, kept apart because they inherit
    /// differently: as in Ruff, a file that `extend`s another replaces its
    /// `exclude` and adds to its `extend-exclude`. `None` until a file sets
    /// it, which is `DEFAULT_EXCLUDE`.
    exclude: Option<Vec<Glob>>,
    extend_exclude: Vec<Glob>,
    /// Replaced, not added to, by a file that sets its own, as in Ruff.
    per_file_ignores: Vec<(Glob, Vec<String>)>,
    /// `target-version`: the release the QK rules check against. None, and
    /// they report nothing.
    target: Option<Target>,
    /// `baseline`: the findings file a run reports only what is new
    /// against, absolute.
    baseline: Option<PathBuf>,
    /// Every file read to make this: `file` and each it extends, whatever
    /// they are called - so a language server knows to re-read when a base
    /// changes (#419).
    sources: Vec<PathBuf>,
    /// `[severity]`: a selector and the severity it reports with, `info`
    /// spelled so; the longest selector that names a code decides.
    severity: Vec<(String, String)>,
    /// `[rules.<CODE>]`: what the rules with options are run with.
    options: Rc<RuleOptions>,
}

/// What the command line says, which wins over any file.
#[derive(Clone, Debug)]
pub struct Overrides {
    pub profile: Option<String>,
    /// The profile when neither the flag nor a file names one.
    pub default_profile: &'static str,
    pub layer: Layer,
    /// `--exclude`, relative to the directory qlinter runs in.
    pub exclude: Vec<Glob>,
    pub config: Option<PathBuf>,
    pub isolated: bool,
    /// `--target-version`, over the configuration's.
    pub target: Option<Target>,
    /// `--baseline FILE`, over the configuration's.
    pub baseline: Option<PathBuf>,
    /// Use no baseline at all: `--write-baseline`, which writes every
    /// finding, and an editor that turned baselines off.
    pub no_baseline: bool,
}

/// A directory searched for a configuration, and the workspace folder a
/// user-level file's settings found from it are rooted at (`None` for any
/// other settings).
type Searched = (PathBuf, Option<PathBuf>);

/// Settings for any file, found once per directory and remembered.
pub struct Policy {
    overrides: Overrides,
    /// Directory -> the settings governing files in it. A user-level file's
    /// patterns are rooted at the workspace folder the file is under, so
    /// its settings are kept by directory and that folder: the same
    /// directory, above two folders, is searched through from both (#2288).
    /// Everything else is kept with `None`.
    cache: RefCell<HashMap<Searched, Rc<Settings>>>,
    /// A language server must not exit over a bad file: it reports each
    /// problem once and uses the defaults for the files it governs.
    lenient: bool,
    warned: RefCell<HashSet<String>>,
    /// What `warned` said and the language server has not yet shown the
    /// user: stderr is a log nobody reads, and a configuration the command
    /// line refuses must not be replaced by the defaults unseen (#2291).
    told: RefCell<Vec<String>>,
    /// An editor's own selection, applied after everything else and only
    /// ever to turn rules off: a rule reports when the configuration and the
    /// command line select it AND this layer does. It is how a language
    /// client's settings narrow what a repository's configuration - the one
    /// CI reads - turns on, without being able to widen it.
    /// Several layers, each of which must select a rule: the editor's
    /// `lint.select`/`lint.ignore`, and the rule families its feature toggles
    /// turn off, which a longer selector in the first must not outrank.
    narrowing: RefCell<Vec<Layer>>,
    /// Each baseline file read, or why it could not be.
    baselines: RefCell<HashMap<PathBuf, Rc<Result<Baseline, String>>>>,
    /// An editor's switch for the baseline, over everything else.
    baseline_off: std::cell::Cell<bool>,
    /// Findings a baseline passed over in this run.
    pub baselined: std::cell::Cell<usize>,
    /// The directories a file no configuration governs takes the deepest
    /// of that holds it as its project root, in place of the current
    /// directory: a language server's workspace folders (`set_roots`).
    roots: RefCell<Vec<PathBuf>>,
}

impl Policy {
    pub fn new(overrides: Overrides, lenient: bool) -> Self {
        Policy {
            overrides,
            cache: RefCell::default(),
            lenient,
            warned: RefCell::default(),
            told: RefCell::default(),
            narrowing: RefCell::default(),
            baselines: RefCell::default(),
            baseline_off: std::cell::Cell::new(false),
            baselined: std::cell::Cell::new(0),
            roots: RefCell::default(),
        }
    }

    /// Root every file no configuration governs at the deepest of `roots`
    /// that holds it, rather than at the current directory: an editor
    /// starts its server in one folder, or anywhere, whatever folder the
    /// file is in (#2109). What was read under other roots is forgotten.
    pub fn set_roots<P: AsRef<Path>>(&self, roots: impl IntoIterator<Item = P>) {
        let roots: Vec<PathBuf> = roots.into_iter().map(|r| absolute(r.as_ref())).collect();
        if *self.roots.borrow() != roots {
            *self.roots.borrow_mut() = roots;
            self.cache.borrow_mut().clear();
        }
    }

    /// The directory the settings of the file `full` take as the project's
    /// top: where the configuration's patterns are rooted, or `base_dir`
    /// when no configuration governs it.
    fn project_root(&self, settings: &Settings, full: &Path) -> Result<PathBuf, String> {
        match &settings.root {
            Some(dir) => Ok(dir.clone()),
            None => self.base_dir(full.parent().unwrap_or(full)),
        }
    }

    /// `project_root`, for `--force-exclude`. With no configuration and no
    /// root, the top of the checkout the file is in comes before the current
    /// directory: that is the same from wherever the run starts, so one file
    /// gets one answer (#2875). Only a file in no checkout is left to the
    /// current directory.
    fn checkout_root(&self, settings: &Settings, full: &Path) -> Result<PathBuf, String> {
        let dir = full.parent().unwrap_or(full);
        if settings.root.is_none()
            && !self.roots.borrow().iter().any(|root| dir.starts_with(root))
            && let Some(top) = dir.ancestors().find(|top| top.join(".git").exists())
        {
            return Ok(top.to_path_buf());
        }
        self.project_root(settings, full)
    }

    /// Where a file in `dir` is rooted when no configuration governs it:
    /// the deepest root holding it, or the current directory.
    fn base_dir(&self, dir: &Path) -> Result<PathBuf, String> {
        let dir = absolute(dir);
        match self
            .roots
            .borrow()
            .iter()
            .filter(|root| dir.starts_with(root))
            .max_by_key(|root| root.components().count())
        {
            Some(root) => Ok(root.clone()),
            None => Ok(absolute(&working_dir(Some(&dir))?)),
        }
    }

    /// Turn every baseline off, or back on: an editor's setting.
    pub fn use_baseline(&self, on: bool) {
        self.baseline_off.set(!on);
    }

    /// The release the QK rules check `settings`' files against.
    pub fn target(&self, settings: &Settings) -> Option<Target> {
        self.overrides.target.or(settings.target)
    }

    /// The baseline file in force for `settings`' files, if any.
    pub fn baseline_file(&self, settings: &Settings) -> Option<PathBuf> {
        if self.overrides.no_baseline || self.baseline_off.get() {
            return None;
        }
        self.overrides
            .baseline
            .as_ref()
            .map(|b| absolute(b))
            .or_else(|| settings.baseline.clone())
    }

    fn baseline(&self, file: &Path) -> Rc<Result<Baseline, String>> {
        if let Some(b) = self.baselines.borrow().get(file) {
            return b.clone();
        }
        let b = Rc::new(Baseline::read(file));
        self.baselines
            .borrow_mut()
            .insert(file.to_path_buf(), b.clone());
        b
    }

    /// Narrow every file's selection by each of `layers`, resolved the way a
    /// configuration's own layer is - the longest selector that names a code
    /// decides - and then intersected with what is already selected: a rule
    /// reports only where every layer selects it (#2294).
    pub fn narrow(&self, layers: Vec<Layer>) {
        *self.narrowing.borrow_mut() = layers;
    }

    /// Say `message` once for the problem `e`, on stderr and to be shown.
    fn warn(&self, message: String, e: &str) {
        if self.warned.borrow_mut().insert(e.to_string()) {
            eprintln!("qlinter: {message}");
            self.told.borrow_mut().push(message);
        }
    }

    /// The problems warned about since the last call, for a language server
    /// to show the user.
    pub fn take_told(&self) -> Vec<String> {
        std::mem::take(&mut *self.told.borrow_mut())
    }

    /// Forget every file read, after one of them changed on disk.
    pub fn reset(&self) {
        self.cache.borrow_mut().clear();
        self.baselines.borrow_mut().clear();
    }

    /// Whether `path` is the file `--config` names, which governs every file
    /// whatever it is called.
    pub fn is_explicit_config(&self, path: &Path) -> bool {
        self.overrides
            .config
            .as_ref()
            .is_some_and(|config| absolute(config) == absolute(path))
    }

    /// Whether `path` is a file some settings read so far were made from -
    /// one found beside the source, one it extends, or `--config` - or a
    /// folder that holds one: an editor's watcher has one event for a
    /// folder moved or deleted and none for the files in it.
    pub fn read_from(&self, path: &Path) -> bool {
        let path = absolute(path);
        self.is_explicit_config(&path)
            || self.baselines.borrow().keys().any(|b| b.starts_with(&path))
            || self
                .cache
                .borrow()
                .values()
                .any(|settings| settings.sources.iter().any(|s| s.starts_with(&path)))
    }

    /// Forget the settings of every directory in the folder `dir`, which
    /// appeared or went, and whether there were any. They were made without
    /// what the folder holds now: a configuration that came with it would
    /// not be searched for, the search having been made already.
    pub fn forget_under(&self, dir: &Path) -> bool {
        let dir = absolute(dir);
        let mut cache = self.cache.borrow_mut();
        let before = cache.len();
        cache.retain(|(searched, _), _| !searched.starts_with(&dir));
        cache.len() != before
    }

    /// What a change to could change the settings read so far: the files
    /// they were made from, and the directories searched for one - a
    /// configuration created there would now be found first - with the
    /// user-level file the search falls back to. Under `--config` and
    /// `--isolated` nothing is searched for.
    pub fn watched(&self) -> (Vec<PathBuf>, Vec<PathBuf>) {
        let cache = self.cache.borrow();
        let mut files: Vec<PathBuf> = cache
            .values()
            .flat_map(|settings| settings.sources.iter().cloned())
            .chain(self.baselines.borrow().keys().cloned())
            .collect();
        let mut dirs = vec![];
        match &self.overrides.config {
            Some(explicit) => files.push(absolute(explicit)),
            None if !self.overrides.isolated => {
                dirs = cache.keys().map(|(dir, _)| dir.clone()).collect();
                files.extend(user_config_path());
            }
            None => {}
        }
        files.sort();
        files.dedup();
        dirs.sort();
        dirs.dedup();
        (files, dirs)
    }

    /// The files a run over `inputs` reads besides them: the configuration
    /// that governs each, with those it extends, and the baseline in force
    /// for it. No flag of the run may write over one, any more than over a
    /// source (#2751). A configuration that does not read names none here:
    /// linting under it is what says so.
    pub fn reads(&self, inputs: &[PathBuf]) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = self.overrides.config.iter().map(|c| absolute(c)).collect();
        for input in inputs {
            if let Ok(settings) = self.settings(input) {
                files.extend(settings.sources.iter().cloned());
                files.extend(self.baseline_file(&settings));
            }
        }
        files.sort();
        files.dedup();
        files
    }

    /// The settings for `path`, a file or a directory: the configuration
    /// nearest to it, searching from the directory that contains it.
    pub fn settings(&self, path: &Path) -> Result<Rc<Settings>, String> {
        let path = absolute(path);
        let start = path.parent().unwrap_or(&path).to_path_buf();
        match self.find(&start) {
            Ok(settings) => Ok(settings),
            Err(e) if self.lenient => {
                self.warn(format!("{e}; using the defaults where it applies"), &e);
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
            let key = (absolute(explicit), None);
            if let Some(found) = self.cache.borrow().get(&key) {
                return Ok(found.clone());
            }
            // Ruff resolves the patterns of a file named by `--config`
            // against the current directory, as it does a user-level one:
            // the file is chosen for this run, not found beside the source.
            let cwd = absolute(&working_dir(None)?);
            let settings = Rc::new(
                load(&key.0, &[], Some(&cwd))?
                    .ok_or_else(|| format!("{}: no [tool.qlinter] table", explicit.display()))?,
            );
            self.cache.borrow_mut().insert(key, settings.clone());
            return Ok(settings);
        }
        let mut visited = vec![];
        let mut found = None;
        let base = self.base_dir(start)?;
        for dir in start.ancestors() {
            {
                let cache = self.cache.borrow();
                let project = (dir.to_path_buf(), None);
                let user = (dir.to_path_buf(), Some(base.clone()));
                if let Some(cached) = cache.get(&project) {
                    found = Some((cached.clone(), None));
                    break;
                }
                if let Some(cached) = cache.get(&user) {
                    found = Some((cached.clone(), user.1));
                    break;
                }
            }
            visited.push(dir.to_path_buf());
            if let Some(settings) = in_directory(dir)? {
                found = Some((Rc::new(settings), None));
                break;
            }
        }
        let (settings, rooted) = match found {
            Some(found) => found,
            None => match user_config(&base)? {
                Some(settings) => (Rc::new(settings), Some(base)),
                None => (Rc::new(Settings::default()), None),
            },
        };
        let mut cache = self.cache.borrow_mut();
        for dir in visited {
            cache.insert((dir, rooted.clone()), settings.clone());
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
        Ok(self.excluded_as(&settings, &absolute(path), true))
    }

    /// `excluded`, for the file `full` under `settings`; `named` is whether
    /// the default list is asked about its own name.
    fn excluded_as(&self, settings: &Settings, full: &Path, named: bool) -> bool {
        // The defaults match the path's own name only, not a directory above
        // it: `qlinter ~/dist/proj` lints proj, and a walk is what skips a
        // `dist` below it.
        let default = named
            && settings.exclude.is_none()
            && full
                .file_name()
                .is_some_and(|n| DEFAULT_EXCLUDE.iter().any(|d| n == *d));
        default
            || settings
                .exclude
                .iter()
                .flatten()
                .chain(&settings.extend_exclude)
                .chain(&self.overrides.exclude)
                .any(|glob| matches(full, glob))
    }

    /// `excluded`, for a path named on the command line with
    /// `--force-exclude`: the default list is also checked against the
    /// directories above it below the project root, as a configured pattern
    /// is against those below its root - so a hook that passes `build/a.q`
    /// skips it, as the walk would (#415), from whatever directory it runs
    /// in (#801).
    pub fn force_excluded(&self, path: &Path) -> Result<bool, String> {
        let settings = self.settings(path)?;
        let full = absolute(path);
        let root = self.checkout_root(&settings, &full)?;
        // The project's top is not a directory of the project, whatever it
        // is called: `qlinter --force-exclude .` in a checkout named
        // `target` linted nothing, and passed (#2874).
        if self.excluded_as(&settings, &full, full != root) {
            return Ok(true);
        }
        // A name pattern names a directory at any depth, and the walk asks
        // about each directory before entering it - so `gen` skips
        // `../other/gen/f.q` in a walk of `../other`. `matches` sees a
        // file's directories only below a pattern's root; past it, as Ruff
        // does, each directory above the file is asked here (#802).
        if full
            .ancestors()
            .skip(1)
            .take_while(|dir| *dir != root)
            .any(|dir| {
                settings
                    .exclude
                    .iter()
                    .flatten()
                    .chain(&settings.extend_exclude)
                    .chain(&self.overrides.exclude)
                    .any(|glob| glob.anywhere && matches(dir, glob))
            })
        {
            return Ok(true);
        }
        if settings.exclude.is_some() {
            return Ok(false);
        }
        Ok(full.strip_prefix(&root).is_ok_and(|relative| {
            relative
                .parent()
                .into_iter()
                .flat_map(Path::components)
                .any(|c| DEFAULT_EXCLUDE.iter().any(|d| c.as_os_str() == *d))
        }))
    }

    /// Whether the rule `code` reports on `path`.
    pub fn enabled(&self, code: &str, path: &Path) -> Result<bool, String> {
        let settings = self.settings(path)?;
        Ok(self.selected(&settings, code) && !per_file_ignored(&settings, code, path))
    }

    fn selected(&self, settings: &Settings, code: &str) -> bool {
        self.configured(settings, code)
            && self
                .narrowing
                .borrow()
                .iter()
                .all(|layer| apply(layer, code, true))
    }

    /// Whether the configuration and flags select `code`, before the
    /// editor's narrowing. The narrowing only hides findings; it must not
    /// change what the analysis sees (#414).
    fn configured(&self, settings: &Settings, code: &str) -> bool {
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
    /// configuration selects for this path. Running them all and filtering
    /// is exact, because a profile only decides which rules report - none
    /// changes what another finds - and it is how a rule in no profile, an
    /// `opt-in` one, is there to be selected by code.
    pub fn lint(&self, source: &str, path: &str, ws: &Workspace) -> Result<Vec<Finding>, String> {
        let file = Path::new(path);
        let settings = self.settings(file)?;
        let structure =
            self.configured(&settings, "QE001") && !per_file_ignored(&settings, "QE001", file);
        // A language server must not stop linting over it: it says so once
        // and keeps the forward rules, which are the profile's.
        let conflict = match self.conflict(&settings, file) {
            Err(e) if self.lenient => {
                self.warn(format!("{e}; reporting {} only", UNDOES.join(" and ")), &e);
                true
            }
            other => other.map(|()| false)?,
        };
        let target = self.target(&settings);
        let mut found = {
            let _options = OptionsScope::install(settings.options.clone());
            let _target = q_lint_rs::TargetScope::install(target);
            lint_every_rule(source, path, ws, structure)
        };
        found.retain(|f| {
            !(conflict && OPPOSITE.contains(&f.code.as_str()))
                && version_reported_for(&f.code, target)
                && self.selected(&settings, &f.code)
                && !per_file_ignored(&settings, &f.code, file)
                && !self.test_exempt(&settings, &f.code, file)
        });
        if let Some(file) = self.baseline_file(&settings) {
            match &*self.baseline(&file) {
                Ok(b) => {
                    let n = b.filter(path, source, &mut found);
                    self.baselined.set(self.baselined.get() + n);
                }
                // A missing or broken baseline is the run's error: reporting
                // everything instead would bury what is new. A language
                // server says so once and reports everything.
                Err(e) if self.lenient => {
                    self.warn(format!("{e}; reporting every finding"), e);
                }
                Err(e) => return Err(e.clone()),
            }
        }
        for f in &mut found {
            if let Some(level) = severity_of(&settings, &f.code) {
                f.severity = level.to_string();
            }
        }
        Ok(found)
    }

    /// Refuses a selection with QP008 and QP005 or QP007 both on for
    /// `path`: opposite conventions, so `--fix` would undo itself. Only where
    /// both would report - a per-file ignore or the tests exemption settles
    /// it - and before any rule runs, so nothing is reported or rewritten.
    /// Under a language server, see `lint`.
    fn conflict(&self, settings: &Settings, path: &Path) -> Result<(), String> {
        let on = |code: &str| {
            self.configured(settings, code)
                && !per_file_ignored(settings, code, path)
                && !self.test_exempt(settings, code, path)
        };
        let name = |code: &str| {
            RULES
                .iter()
                .find(|r| r.code == code)
                .map_or(String::new(), |r| format!(" ({})", r.name))
        };
        for reverse in OPPOSITE.into_iter().filter(|code| on(code)) {
            if let Some(forward) = UNDOES.into_iter().find(|code| on(code)) {
                return Err(format!(
                    "{}: {reverse}{} and {forward}{} are opposite conventions - one removes the \
                     parentheses the other adds, so --fix would undo itself; select one \
                     (`--ignore {forward}`, or drop {reverse})",
                    path.display(),
                    name(reverse),
                    name(forward)
                ));
            }
        }
        Ok(())
    }

    /// A test may build a legacy datetime, read the local clock or mix infix
    /// arithmetic on purpose, so QP002, QP003, QP005 and QP007 pass over a
    /// file in a `tests` directory below the project root: where the
    /// configuration's patterns are rooted, or the current directory when
    /// there is none - in a language server, the workspace folder holding
    /// the file. A `tests` above the root - a checkout under `~/tests` -
    /// exempts nothing, and a rule the command line selects by code reports
    /// regardless (#800, #416).
    fn test_exempt(&self, settings: &Settings, code: &str, path: &Path) -> bool {
        if !["QP002", "QP003", "QP005", "QP007"].contains(&code) {
            return false;
        }
        let cli = &self.overrides.layer;
        if cli
            .select
            .iter()
            .flatten()
            .chain(&cli.extend_select)
            .any(|s| s != "ALL" && names(s, code))
        {
            return false;
        }
        let full = absolute(path);
        let Ok(root) = self.project_root(settings, &full) else {
            return false;
        };
        full.strip_prefix(&root).is_ok_and(|relative| {
            relative
                .parent()
                .is_some_and(|dir| dir.components().any(|c| c.as_os_str() == "tests"))
        })
    }

    /// What `--show-settings` prints: which file governs `path`, and what it
    /// turns on there - only rules that can report under `backend`. A
    /// `python-hook` rule runs in another tool, never in this binary, and
    /// QLS001 comes only from qls. Nor one the `target-version` in force
    /// keeps from reporting, as `lint` keeps it: a QK rule with no target, or
    /// QE008 under a 4.x one, listed as on and then finding nothing (#2748).
    pub fn describe(&self, path: &Path, backend: &str) -> Result<Described, String> {
        let settings = self.settings(path)?;
        self.conflict(&settings, path)?;
        let target = self.target(&settings);
        let runs = |scope: &str| match scope {
            "python-hook" => false,
            "qls" => backend != "builtin",
            _ => backend != "qls",
        };
        let mut codes: Vec<&'static str> = RULES
            .iter()
            .filter(|r| runs(&r.scope))
            .map(|r| r.code.as_str())
            .filter(|code| {
                self.selected(&settings, code)
                    && version_reported_for(code, target)
                    && !per_file_ignored(&settings, code, path)
                    && !self.test_exempt(&settings, code, path)
            })
            .collect();
        codes.sort_unstable();
        Ok(Described {
            file: absolute(path).display().to_string(),
            configuration: settings.file.as_ref().map(|f| f.display().to_string()),
            profile: self.profile(&settings),
            target: target.map(Target::name),
            rules: codes,
        })
    }
}

/// What `--show-settings` says of one path: its keys under `--format json`,
/// in this order, and its lines as text.
#[derive(serde::Serialize)]
pub struct Described {
    file: String,
    /// The file that governs it; none where the built-in defaults do.
    configuration: Option<String>,
    profile: String,
    #[serde(rename = "target-version")]
    target: Option<&'static str>,
    rules: Vec<&'static str>,
}

impl std::fmt::Display for Described {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(
            f,
            "file: {}\nconfiguration: {}\nprofile: {}\ntarget-version: {}\nrules ({}): {}",
            self.file,
            self.configuration
                .as_deref()
                .unwrap_or("none - built-in defaults"),
            self.profile,
            self.target.unwrap_or("none - the QK rules report nothing"),
            self.rules.len(),
            self.rules.join(" ")
        )
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
    // QP008 is the opposite convention to QP005 and QP007: a prefix or
    // `ALL` would turn both sides on, so only its own code selects it.
    let enable = longest(
        &mut layer
            .select
            .iter()
            .flatten()
            .chain(&layer.extend_select)
            .filter(|s| !OPPOSITE.contains(&code) || *s == code),
    );
    let disable = longest(&mut layer.ignore.iter());
    match (enable, disable) {
        (Some(e), Some(d)) => e > d,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => on && layer.select.is_none(),
    }
}

/// The severity `settings` give `code`, if they give one: the longest
/// selector that names it, the last written winning a tie.
fn severity_of<'a>(settings: &'a Settings, code: &str) -> Option<&'a str> {
    settings
        .severity
        .iter()
        .rev()
        .filter(|(s, _)| names(s, code))
        .max_by_key(|(s, _)| if s == "ALL" { 0 } else { s.len() })
        .map(|(_, level)| level.as_str())
}

/// The rules whose convention is the opposite of another's, each beside
/// the rules it undoes: `--fix` with both would write a pair and take it out
/// again, so a file that selects both is refused (#848).
const OPPOSITE: [&str; 1] = ["QP008"];
const UNDOES: [&str; 2] = ["QP005", "QP007"];

fn names(selector: &str, code: &str) -> bool {
    selector == "ALL" || code.starts_with(selector)
}

fn per_file_ignored(settings: &Settings, code: &str, path: &Path) -> bool {
    let full = absolute(path);
    settings.per_file_ignores.iter().any(|(glob, codes)| {
        codes.iter().any(|s| names(s, code)) && matches(&full, glob) != glob.negated
    })
}

/// Ruff's matching: a pattern is tried against the path relative to the
/// configuration's directory and against each directory above it within that
/// root, so `vendor/*` and `vendor` both cover everything under `vendor/`. A
/// pattern with no `/` names a file or directory anywhere below the root, so
/// `generated` excludes every directory of that name; one with a `/`
/// anywhere in it, a trailing one included, is anchored at the root, so
/// `lib/` excludes the root's `lib` and not `tests/lib`.
fn matches(full: &Path, glob: &Glob) -> bool {
    let Glob {
        root,
        pattern,
        anywhere,
        ..
    } = glob;
    let anywhere = *anywhere;
    // On Windows a canonicalized pattern root is `\\?\C:\...` while the walk
    // yields `C:\...`, and the two never share a prefix.
    let (full, root) = (&plain(full), &plain(root));
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
    // An absolute pattern with no glob in it names its root itself.
    if pattern.as_str().is_empty() {
        return true;
    }
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
            && let Some(settings) = load(&path, &[], None)?
        {
            return Ok(Some(settings));
        }
    }
    Ok(None)
}

/// The user-level configuration. Its patterns are rooted at `base`, the
/// current directory (a language server's workspace folder), not at the
/// configuration's own: a file under `~/.config/qlinter/` governs projects
/// elsewhere, and Ruff resolves a user configuration's `exclude` and
/// per-file-ignores against the directory it runs in.
fn user_config(base: &Path) -> Result<Option<Settings>, String> {
    match user_config_path() {
        Some(path) if path.is_file() => load(&path, &[], Some(base)),
        _ => Ok(None),
    }
}

/// Where the user-level configuration is, whether or not it exists.
fn user_config_path() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|base| base.join("qlinter").join("qlinter.toml"))
}

/// Read one configuration file, and what it extends. `None` for a
/// `pyproject.toml` that has no qlinter table, which is not a configuration.
/// Its patterns are rooted at its own directory unless `patterns` says
/// otherwise. `chain` is the files that extend it, outermost first.
fn load(
    path: &Path,
    chain: &[PathBuf],
    patterns: Option<&Path>,
) -> Result<Option<Settings>, String> {
    // A file that extends itself, directly or through others, is a cycle,
    // not a deep chain (#424).
    let here = absolute(path);
    if chain.contains(&here) {
        let names: Vec<_> = chain
            .iter()
            .chain([&here])
            .map(|p| p.display().to_string())
            .collect();
        return Err(format!("`extend` cycle: {}", names.join(" -> ")));
    }
    if chain.len() > 16 {
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
        if !TOP_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "{shown}: unknown key `{key}`; qlinter reads {} and [lint]",
                TOP_KEYS
                    .iter()
                    .filter(|k| **k != "lint")
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", ")
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
        if !LINT_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "{shown}: unknown key `lint.{key}`; [lint] reads {}",
                LINT_KEYS.join(", ")
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
            let chain = [chain, std::slice::from_ref(&here)].concat();
            load(&base, &chain, patterns)?
                .ok_or_else(|| format!("{}: no [tool.qlinter] table to extend", base.display()))?
        }
    };
    settings.file = Some(absolute(path));
    settings.root = Some(patterns.unwrap_or(&root).to_path_buf());
    settings.sources.push(absolute(path));
    if let Some(v) = table.get("profile") {
        let name = v
            .as_str()
            .filter(|p| PROFILES.contains(p))
            .ok_or_else(|| format!("{shown}: profile must be one of {}", PROFILES.join(", ")))?;
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
                            .and_then(|s| selector(key, s).map_err(|e| format!("{shown}: {e}")))
                    })
                    .collect()
            })
            .transpose()
    };
    if let Some(v) = table.get("target-version") {
        let target = v.as_str().and_then(Target::parse).ok_or_else(|| {
            format!(
                "{shown}: target-version must be one of {}",
                Target::NAMES.join(", ")
            )
        })?;
        settings.target = Some(target);
    }
    if let Some(v) = table.get("required-version") {
        let spec = v
            .as_str()
            .ok_or_else(|| format!("{shown}: required-version must be a string"))?;
        let ours = env!("CARGO_PKG_VERSION");
        if !version_matches(spec, ours).map_err(|e| format!("{shown}: required-version: {e}"))? {
            return Err(format!(
                "{shown}: required-version \"{spec}\" does not match this qlinter, {ours}"
            ));
        }
    }
    if let Some(v) = table.get("baseline") {
        let file = v
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("{shown}: baseline must be a path"))?;
        settings.baseline = Some(absolute(&root.join(file)));
    }
    settings.layers.push(Layer {
        select: selectors("select")?,
        extend_select: selectors("extend-select")?.unwrap_or_default(),
        ignore: selectors("ignore")?.unwrap_or_default(),
    });
    // What a file sets replaces what it extends - Ruff lints `gen/` when the
    // base excludes it and the extending file excludes something else - and
    // only `extend-exclude` adds to the base's.
    for key in ["exclude", "extend-exclude"] {
        if let Some(v) = table.get(key) {
            let mut globs = vec![];
            for p in v
                .as_array()
                .ok_or_else(|| format!("{shown}: {key} must be an array"))?
            {
                let p = p
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| format!("{shown}: {key} must contain nonempty strings"))?;
                globs.push(
                    excluding(patterns.unwrap_or(&root), p)
                        .map_err(|e| format!("{shown}: {key}: {e}"))?,
                );
            }
            if key == "exclude" {
                settings.exclude = Some(globs);
            } else {
                settings.extend_exclude.extend(globs);
            }
        }
    }
    if let Some(v) = get("per-file-ignores") {
        settings.per_file_ignores.clear();
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
                        .and_then(|s| {
                            selector("per-file-ignores", s).map_err(|e| format!("{shown}: {e}"))
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            // An initial `!` negates the pattern, in per-file-ignores only:
            // Ruff's `exclude` has no negation.
            let (text, negated) = match glob.trim().strip_prefix('!') {
                Some(rest) => (rest, true),
                None => (glob.as_str(), false),
            };
            let mut rooted = rooted(patterns.unwrap_or(&root), text)
                .map_err(|e| format!("{shown}: per-file-ignores: {e}"))?;
            rooted.negated = negated;
            settings.per_file_ignores.push((rooted, codes));
        }
    }
    if let Some(v) = get("severity") {
        let map = v.as_table().ok_or_else(|| {
            format!("{shown}: severity must be a table of code = \"error\" | \"warning\" | ...")
        })?;
        for (code, level) in map {
            let code = selector("severity", code).map_err(|e| format!("{shown}: {e}"))?;
            let level = level
                .as_str()
                .filter(|l| SEVERITIES.contains(l))
                .ok_or_else(|| {
                    format!(
                        "{shown}: severity.{code} must be error, warning, info, information or \
                         hint, not {level}"
                    )
                })?;
            // One spelling in every report, LSP's and qls's: a consumer
            // filtering on `information` must not miss a finding a
            // configuration spelt `info` (#2122).
            let level = if level == "info" {
                "information"
            } else {
                level
            };
            // What this file says for a selector replaces what it extends.
            settings.severity.retain(|(s, _)| *s != code);
            settings.severity.push((code, level.to_string()));
        }
    }
    if let Some(v) = get("rules") {
        let map = v
            .as_table()
            .ok_or_else(|| format!("{shown}: rules must be a table of [rules.<CODE>] tables"))?;
        let mut rules = (*settings.options).clone();
        for (code, table) in map {
            let table = table
                .as_table()
                .ok_or_else(|| format!("{shown}: rules.{code} must be a table"))?;
            for (key, value) in table {
                let bad = |what: &str| format!("{shown}: [rules.{code}] {key} must be {what}");
                let kind = options::OPTIONS
                    .iter()
                    .find(|o| o.code == code && o.key == key)
                    .map(|o| o.kind);
                let value = match (kind, value) {
                    (Some(options::Kind::Count), toml::Value::Integer(n)) => {
                        options::Value::Count(*n)
                    }
                    (Some(options::Kind::Count), _) => return Err(bad("an integer")),
                    (Some(options::Kind::Words), toml::Value::Array(items)) => {
                        options::Value::Words(
                            items
                                .iter()
                                .map(|w| w.as_str().map(str::to_string))
                                .collect::<Option<_>>()
                                .ok_or_else(|| bad("a list of strings"))?,
                        )
                    }
                    (Some(options::Kind::Words), _) => return Err(bad("a list of strings")),
                    (Some(options::Kind::Pattern), toml::Value::String(p)) => {
                        options::Value::Pattern(p.clone())
                    }
                    (Some(options::Kind::Pattern), _) => return Err(bad("a string")),
                    // Unknown: `set` says what the rule does read.
                    (None, _) => options::Value::Count(0),
                };
                rules
                    .set(code, key, value)
                    .map_err(|e| format!("{shown}: {e}"))?;
            }
        }
        settings.options = Rc::new(rules);
    }
    Ok(Some(settings))
}

/// A version, `X`, `X.Y` or `X.Y.Z`, as numbers; a missing part is 0.
fn version(text: &str) -> Option<[u64; 3]> {
    let mut parts = [0; 3];
    for (n, part) in text.trim().split('.').enumerate() {
        // Digits only: `u64::from_str` would take a leading `+`.
        if n == 3 || part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        parts[n] = part.parse().ok()?;
    }
    Some(parts)
}

/// Whether `ours` satisfies `spec`, `required-version`'s value: clauses
/// joined by commas, each an operator - `==`, `!=`, `>=`, `<=`, `>`, `<` or
/// `~=` (PEP 440's compatible release: `~=0.33.1` is `>=0.33.1, <0.34`) -
/// and a version, or a version alone, which must be the one. An error for a
/// spec that is not one.
fn version_matches(spec: &str, ours: &str) -> Result<bool, String> {
    let ours = version(ours).ok_or_else(|| format!("cannot read this version, {ours}"))?;
    if spec.trim().is_empty() {
        return Err("empty".into());
    }
    let mut all = true;
    for clause in spec.split(',') {
        let clause = clause.trim();
        let (op, rest) = ["==", "!=", ">=", "<=", "~=", ">", "<", "="]
            .into_iter()
            .find_map(|op| clause.strip_prefix(op).map(|rest| (op, rest)))
            .unwrap_or(("==", clause));
        let bad = || format!("`{clause}` is not an operator and a version, such as `>=0.33`");
        let want = version(rest).ok_or_else(bad)?;
        let ok = match op {
            "==" | "=" => ours == want,
            "!=" => ours != want,
            ">=" => ours >= want,
            "<=" => ours <= want,
            ">" => ours > want,
            "<" => ours < want,
            _ => {
                // The last part given may rise; the ones before it are fixed.
                let given = rest.trim().split('.').count();
                if given < 2 {
                    return Err(format!("`{clause}`: ~= needs at least X.Y"));
                }
                ours >= want && ours[..given - 1] == want[..given - 1]
            }
        };
        all &= ok;
    }
    Ok(all)
}

/// `path` without Windows' verbatim prefix: `\\?\C:\x` is `C:\x`. Any
/// other path, and every path elsewhere, is returned as it is.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

pub fn pattern(text: &str) -> Result<glob::Pattern, String> {
    glob::Pattern::new(text.trim().trim_end_matches('/')).map_err(|e| format!("{text}: {e}"))
}

/// An `exclude` or `per-file-ignores` pattern, with the directory it is
/// relative to: a configuration's own, or the current one for `--exclude`.
#[derive(Clone, Debug)]
pub struct Glob {
    root: PathBuf,
    pattern: glob::Pattern,
    /// A bare name, `generated`, which matches a file or directory of that
    /// name anywhere below the root, not only at it.
    anywhere: bool,
    /// A per-file-ignores pattern written `!tests/*`, which applies to every
    /// file the rest of it does not match, as Ruff's does.
    negated: bool,
}

/// `text` as a pattern rooted at `root`. Ruff joins every pattern to its
/// root before matching, so `gen/`, `./gen` and an absolute `/abs/root/gen`
/// all name the root's `gen` - anchored there - and only a bare `gen`, with
/// no `/` in it at all, also matches the name anywhere below it.
/// `rooted`, for an exclusion: one that names its root or a directory above
/// it - `.`, `./`, `..`, or `/` from anywhere - would leave nothing to lint
/// and pass, as an empty one would, so it is refused like one (#803).
pub fn excluding(root: &Path, text: &str) -> Result<Glob, String> {
    let glob = rooted(root, text)?;
    if glob.pattern.as_str().is_empty() && absolute(root).starts_with(&glob.root) {
        return Err(format!(
            "{}: the pattern names the whole tree, so it would exclude every file",
            text.trim()
        ));
    }
    Ok(glob)
}

pub fn rooted(root: &Path, text: &str) -> Result<Glob, String> {
    let trimmed = text.trim();
    // An empty pattern names its root, so it would exclude everything: a
    // script's `--exclude "$UNSET"` would lint nothing and pass (#418).
    if trimmed.is_empty() {
        return Err("a pattern must not be empty".into());
    }
    let written = Path::new(trimmed);
    if written.is_absolute() {
        // The literal part of the path is resolved the way the files are,
        // so `/var/...` still names the `/private/var/...` a walk finds.
        let literal: PathBuf = written
            .components()
            // Only a name can hold a glob: Windows' `\\?\C:` prefix has a `?`.
            .take_while(|c| {
                !matches!(c, std::path::Component::Normal(n) if n.to_string_lossy().contains(['*', '?', '[']))
            })
            .collect();
        let tail = written.strip_prefix(&literal).unwrap_or(Path::new(""));
        return Ok(Glob {
            root: absolute(&literal),
            pattern: pattern(&tail.to_string_lossy().replace('\\', "/"))?,
            anywhere: false,
            negated: false,
        });
    }
    // Leading `./` and `../` are resolved against the root, as Ruff
    // normalises the joined path: from `proj/tests`, `--exclude ../src`
    // names `proj/src`, which a pattern rooted below it could never reach.
    let mut rest = trimmed;
    let mut root = root.to_path_buf();
    loop {
        if let Some(r) = rest.strip_prefix("./") {
            rest = r.trim_start_matches('/');
        } else if let Some(r) = rest.strip_prefix("../") {
            rest = r.trim_start_matches('/');
            root.pop();
        } else if rest == ".." {
            rest = "";
            root.pop();
        } else if rest == "." {
            // The root itself, as `./` is: not a file named `.` (#803).
            rest = "";
        } else {
            break;
        }
    }
    Ok(Glob {
        root,
        pattern: pattern(rest)?,
        // Any `/` anchors, a trailing one included (#117): `lib/` is the
        // root's `lib`, not `tests/lib` - Ruff adds the basename match only
        // for a pattern with no separator in it at all.
        anywhere: rest == trimmed && !rest.contains('/'),
        negated: false,
    })
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

/// The current directory. One removed from under the run - a worktree or a
/// build directory an editor or an agent was started in - is said to be so,
/// where the system's "No such file or directory" named nothing; and where
/// `within` is an absolute path, its directory stands in, so a file named in
/// full is still linted (#2873).
pub fn working_dir(within: Option<&Path>) -> Result<PathBuf, String> {
    match std::env::current_dir() {
        Ok(cwd) => Ok(cwd),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => within
            .filter(|path| path.is_absolute())
            .map(|path| match path.is_dir() {
                true => path.to_path_buf(),
                false => path.parent().unwrap_or(path).to_path_buf(),
            })
            .ok_or_else(|| {
                "the current directory no longer exists; name each file by its absolute path, \
                 or run from a directory that does"
                    .to_string()
            }),
        Err(e) => Err(format!("the current directory: {e}")),
    }
}

/// `path` made absolute and resolved through symlinks. A path that does not
/// exist - an editor buffer never saved - is resolved through its nearest
/// existing ancestor, so `/var/...` on macOS still matches patterns rooted at
/// the `/private/var/...` a configuration file canonicalizes to.
///
/// A symlink itself is not resolved, only the directories it sits in: a link
/// is governed, excluded and reported where it is and by its own name, as
/// Ruff matches a path as walked, not by wherever its target happens to be.
/// Nor is a directory it sits in that is a link out of the directory holding
/// it - a shared tree linked into a project: what is under that link is in
/// the project, where it was resolved out to the target, which the
/// project's configuration does not govern and its excludes cannot name
/// (#2857). A link to somewhere under the directory holding it is resolved
/// as before: `/var` on macOS, or a second name for a directory the walk
/// reaches anyway, which stays the one path.
pub fn absolute(path: &Path) -> PathBuf {
    if is_link(path)
        && let Some(name) = path.file_name()
    {
        return absolute(holder(path)).join(name);
    }
    if let Some(kept) = under_link(path) {
        return kept;
    }
    if let Ok(p) = fs::canonicalize(path) {
        return p;
    }
    let lexical = lexical(path);
    for ancestor in lexical.ancestors().skip(1) {
        if ancestor.exists()
            && let Ok(rest) = lexical.strip_prefix(ancestor)
        {
            return absolute(ancestor).join(rest);
        }
    }
    lexical
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// The directory `path` is in, `.` for a bare name.
fn holder(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

/// `path` under the nearest directory above it that is a link out of the
/// directory holding it, with that link kept and only the rest resolved.
/// None when there is no such link, or `path` leaves it again by a `..`.
fn under_link(path: &Path) -> Option<PathBuf> {
    let (link, target) = path.ancestors().skip(1).find_map(|dir| {
        if !is_link(dir) {
            return None;
        }
        let target = fs::canonicalize(dir).ok()?;
        let outside = !target.starts_with(fs::canonicalize(holder(dir)).ok()?);
        outside.then_some((dir, target))
    })?;
    let real = fs::canonicalize(path).ok()?;
    Some(absolute(link).join(real.strip_prefix(target).ok()?))
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

#[cfg(test)]
mod tests {
    use super::{LINT_KEYS, PROFILES, SEVERITIES, TOP_KEYS, version_matches};
    use q_lint_rs::{
        Target,
        options::{Kind, OPTIONS},
    };
    use serde_json::Value;
    use std::collections::BTreeSet;

    fn read_json(relative: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    fn keys(object: &Value) -> BTreeSet<String> {
        object.as_object().unwrap().keys().cloned().collect()
    }

    fn set(words: &[&str]) -> BTreeSet<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    /// The editor's schema for `.qlinter.toml` (#1178) names exactly the keys
    /// `load` reads - no fewer, so completion offers each, and no more, so
    /// validation passes nothing qlinter would refuse - and the values each
    /// may take.
    #[test]
    fn the_editor_schema_holds_exactly_the_keys_a_configuration_reads() {
        let schema = read_json("editors/vscode/schemas/qlinter.schema.json");
        let defs = &schema["definitions"];
        let resolve = |v: &Value| -> Value {
            match v["$ref"].as_str() {
                Some(r) => defs[r.trim_start_matches("#/definitions/")].clone(),
                None => v.clone(),
            }
        };
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(keys(&schema["properties"]), set(&TOP_KEYS));
        let lint = &schema["properties"]["lint"];
        assert_eq!(lint["additionalProperties"], false);
        assert_eq!(keys(&lint["properties"]), set(&LINT_KEYS));
        let enumerated = |v: &Value| -> BTreeSet<String> {
            v["enum"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(enumerated(&schema["properties"]["profile"]), set(&PROFILES));
        // A release is offered by its name and taken in every spelling
        // `Target::parse` reads (#1976): the names, KDB-X's others, any case,
        // blanks around it. The schema's pattern must agree on each of these.
        let target = &schema["properties"]["target-version"]["anyOf"];
        assert_eq!(enumerated(&target[0]), set(&Target::NAMES));
        assert_eq!(target[1]["type"], "string");
        let spelled = regex::Regex::new(target[1]["pattern"].as_str().unwrap()).unwrap();
        let mut spellings: Vec<String> = Vec::new();
        for word in [
            "3.6", "4.0", "4.1", "kdbx", "kdb-x", "5", "KDBX", "KDB-X", "Kdb-X", "kdb+", "kdb_x",
            "kdb--x", "kdb x", "kx", "4", "4.2", "3.5", "4.00", "40", "4,0", "5.0", "6", "x", "",
        ] {
            for shape in [
                word.to_string(),
                format!(" {word} "),
                format!("\t{word}"),
                format!("v{word}"),
                format!("{word}0"),
                format!("{word} {word}"),
            ] {
                spellings.push(shape);
            }
        }
        for name in Target::NAMES {
            assert!(Target::parse(name).is_some(), "{name}");
        }
        for text in &spellings {
            assert_eq!(
                spelled.is_match(text),
                Target::parse(text).is_some(),
                "target-version = {text:?}"
            );
        }
        for at in [&schema["properties"], &lint["properties"]] {
            let severity = resolve(&at["severity"]);
            assert_eq!(
                enumerated(&severity["additionalProperties"]),
                set(&SEVERITIES)
            );
            let rules = resolve(&at["rules"]);
            assert_eq!(rules["additionalProperties"], false);
            let codes: Vec<&str> = OPTIONS.iter().map(|o| o.code).collect();
            assert_eq!(keys(&rules["properties"]), set(&codes));
            for (code, table) in rules["properties"].as_object().unwrap() {
                assert_eq!(table["additionalProperties"], false, "{code}");
                let options: Vec<_> = OPTIONS.iter().filter(|o| o.code == code).collect();
                let names: Vec<&str> = options.iter().map(|o| o.key).collect();
                assert_eq!(keys(&table["properties"]), set(&names), "{code}");
                for option in options {
                    let ty = &table["properties"][option.key]["type"];
                    let want = match option.kind {
                        Kind::Count => "integer",
                        Kind::Words => "array",
                        Kind::Pattern => "string",
                    };
                    assert_eq!(ty, want, "{code}.{}", option.key);
                }
            }
        }
        // Even Better TOML finds it through the extension's tomlValidation.
        let package = read_json("editors/vscode/package.json");
        let contributed = &package["contributes"]["tomlValidation"][0];
        assert_eq!(contributed["url"], "./schemas/qlinter.schema.json");
        let matched: Vec<_> = contributed["fileMatch"].as_array().unwrap().to_vec();
        assert_eq!(matched, ["qlinter.toml", ".qlinter.toml"]);
    }

    #[test]
    fn a_required_version_reads_ranges_exact_versions_and_compatible_releases() {
        for (spec, ours, want) in [
            (">=0.33, <0.34", "0.33.2", true),
            (">=0.33, <0.34", "0.34.0", false),
            (">=0.33,<0.34", "0.32.9", false),
            ("0.33.2", "0.33.2", true),
            ("==0.33", "0.33.0", true),
            ("==0.33", "0.33.2", false),
            ("!=0.33.2", "0.33.2", false),
            (">0.33.1", "0.33.2", true),
            ("<=0.33.1", "0.33.2", false),
            ("~=0.33.1", "0.33.9", true),
            ("~=0.33.1", "0.34.0", false),
            ("~=0.33", "0.99.0", true),
            ("~=0.33", "1.0.0", false),
            (" >= 0.33 ", "0.33.0", true),
        ] {
            assert_eq!(version_matches(spec, ours), Ok(want), "{spec} vs {ours}");
        }
        for bad in [
            "", "latest", ">=", ">=0.33,", "=>0.33", "0.33.1.2", "~=1", ">=+1", "0.x",
        ] {
            assert!(version_matches(bad, "0.33.2").is_err(), "{bad:?}");
        }
    }
}
