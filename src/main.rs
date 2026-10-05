mod jsonrpc;
mod lsp;
mod qls;
use clap::Parser;
use q_lint_rs::{Profile, RULES, Workspace, fix_for, index, lint_in};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(
    name = "qlinter",
    about = "Lint q source without executing it",
    version,
    // clap's default short form is `-V`. Most people reach for `-v` first and
    // nothing here means verbose, so both answer.
    disable_version_flag = true
)]
struct Args {
    #[arg(short = 'v', short_alias = 'V', long, action = clap::ArgAction::Version)]
    version: (),
    paths: Vec<String>,
    #[arg(long,default_value="text",value_parser=["text","json"])]
    format: String,
    #[arg(long,default_value="uqf",value_parser=["general","style","styleq","uqf"])]
    profile: String,
    #[arg(long, default_value = "<stdin>")]
    stdin_filename: String,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    exclude: Vec<String>,
    /// Drop findings with this diagnostic code, e.g. `--ignore QS001`.
    /// Repeatable, and added to `ignore` in `[tool.q-lint]`.
    #[arg(long)]
    ignore: Vec<String>,
    #[arg(long)]
    rules: bool,
    #[arg(long)]
    explain: Option<String>,
    /// Apply mechanical fixes to files, then report remaining findings.
    #[arg(long, conflicts_with = "diff")]
    fix: bool,
    /// Preview mechanical fixes without changing files.
    #[arg(long, conflicts_with = "fix")]
    diff: bool,
    /// With --fix or --diff, also apply the fixes otherwise only offered in an
    /// editor: those that change what a working program does, or guess at
    /// what was meant. Ruff's flag of the same name.
    #[arg(long)]
    unsafe_fixes: bool,
    #[arg(long,default_value="builtin",value_parser=["builtin","qls","all"])]
    backend: String,
    #[arg(long, default_value = "qls")]
    qls_executable: String,
    #[arg(long, default_value = "30")]
    qls_timeout: f64,
    /// Run as a language server on stdin/stdout instead of linting paths.
    #[arg(long, conflicts_with_all = ["paths", "rules", "explain", "fix", "diff"])]
    lsp: bool,
    /// Colour the text output: `auto` (a terminal, and NO_COLOR unset),
    /// `always`, or `never`.
    #[arg(long, default_value = "auto", value_parser = ["auto", "always", "never"])]
    color: String,
    /// Accepted and ignored. Editors conventionally pass this to a language
    /// server, and some LSP clients append it without being asked - stdio is
    /// the only transport here, so there is nothing for it to select. A
    /// server that exits 2 on an unknown flag gives an editor no diagnostics
    /// and no reason why.
    #[arg(long, hide = true)]
    stdio: bool,
}
/// What `[tool.q-lint]` says: the directory it was found in, the paths it
/// excludes, and the diagnostic codes it ignores.
struct Settings {
    root: PathBuf,
    exclude: Vec<glob::Pattern>,
    ignore: Vec<String>,
}

/// Refuse a code no rule has. An ignore list is read once and then trusted,
/// so a typo in it would silently ignore nothing - the one way this setting
/// could fail without anyone noticing.
fn known_code(code: &str) -> Result<String, String> {
    if RULES.iter().any(|r| r.code == code) {
        Ok(code.to_string())
    } else {
        Err(format!(
            "ignore: {code} is not a diagnostic code - `qlinter --rules` lists them"
        ))
    }
}

fn config(explicit: Option<&Path>) -> Result<Settings, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let paths: Vec<_> = match explicit {
        Some(p) => vec![p.to_path_buf()],
        None => cwd.ancestors().map(|p| p.join("pyproject.toml")).collect(),
    };
    for path in paths {
        if explicit.is_none() && !path.is_file() {
            continue;
        }
        let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let data: toml::Value =
            toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        if data.get("tool").is_some_and(|t| !t.is_table()) {
            return Err("tool must be a table".into());
        }
        if let Some(settings) = data.get("tool").and_then(|t| t.get("q-lint")) {
            let table = settings.as_table().ok_or("[tool.q-lint] must be a table")?;
            if table.keys().any(|k| k != "exclude" && k != "ignore") {
                return Err("[tool.q-lint] supports only exclude and ignore".into());
            }
            let empty = vec![];
            let patterns = match table.get("exclude") {
                None => &empty,
                Some(v) => v.as_array().ok_or("exclude must be an array")?,
            };
            let patterns = patterns
                .iter()
                .map(|v| {
                    let s = v
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or("exclude must contain nonempty strings")?;
                    glob::Pattern::new(s.trim_end_matches('/')).map_err(|e| e.to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let ignore = match table.get("ignore") {
                None => vec![],
                Some(v) => v
                    .as_array()
                    .ok_or("ignore must be an array")?
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| "ignore must contain nonempty strings".to_string())
                            .and_then(known_code)
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            };
            return Ok(Settings {
                root: fs::canonicalize(path)
                    .map_err(|e| e.to_string())?
                    .parent()
                    .unwrap()
                    .to_path_buf(),
                exclude: patterns,
                ignore,
            });
        }
        if explicit.is_some() {
            return Err("missing [tool.q-lint]".into());
        }
    }
    Ok(Settings {
        root: cwd,
        exclude: vec![],
        ignore: vec![],
    })
}

/// The codes to drop: the configuration's and the command line's together.
fn ignored(settings_ignore: &[String], flags: &[String]) -> Result<Vec<String>, String> {
    let mut codes = settings_ignore.to_vec();
    for code in flags {
        codes.push(known_code(code.trim())?);
    }
    Ok(codes)
}
/// Whether a path names q source.
///
/// The extension, and nothing else: this runs before the file is opened, and
/// a linter that reads a path to decide whether to read it has gained nothing.
/// `.k` is deliberately absent - k is a different language that happens to
/// live beside q.
fn is_q_source(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("q"))
}

fn absolute(path: &Path) -> PathBuf {
    if let Ok(p) = fs::canonicalize(path) {
        return p;
    }
    let mut result = PathBuf::new();
    let p = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap().join(path)
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
fn excluded(path: &Path, root: &Path, patterns: &[glob::Pattern]) -> bool {
    let full = absolute(path);
    let Ok(relative) = full.strip_prefix(root) else {
        return false;
    };
    relative
        .ancestors()
        .filter(|p| !p.as_os_str().is_empty())
        .any(|p| patterns.iter().any(|g| g.matches(&p.to_string_lossy())))
}
fn run(args: Args) -> Result<u8, String> {
    if args.lsp {
        // Locked once for the life of the process: the server owns both
        // streams, and re-locking per message would be pure overhead.
        // The server reads the same `ignore` the command line does, so an
        // editor shows what `qlinter` prints. A configuration it cannot read
        // is reported and passed over rather than fatal: a server that exits
        // gives an editor no diagnostics and no reason why.
        let from_config = match config(args.config.as_deref()) {
            Ok(settings) => settings.ignore,
            Err(e) => {
                eprintln!("qlinter: {e}; serving without [tool.q-lint] ignore");
                vec![]
            }
        };
        let ignore = ignored(&from_config, &args.ignore)?;
        let stdin = io::stdin();
        let stdout = io::stdout();
        return lsp::serve(
            &mut stdin.lock(),
            &mut stdout.lock(),
            profile(&args.profile),
            &ignore,
        );
    }
    if args.rules || args.explain.is_some() {
        if args.fix || args.diff {
            return Err("--fix and --diff require q source paths, not --rules or --explain".into());
        }
        let entries: Vec<_> = RULES
            .iter()
            .filter(|r| args.explain.as_ref().is_none_or(|code| r.code == *code))
            .collect();
        if entries.is_empty() {
            return Err(format!(
                "Unknown diagnostic code: {}",
                args.explain.unwrap()
            ));
        }
        if args.format == "json" {
            println!("{}", serde_json::to_string(&entries).unwrap());
        } else {
            for r in entries {
                println!(
                    "{} [{}] {}: {} ({})",
                    r.code, r.category, r.name, r.summary, r.scope
                );
            }
        }
        return Ok(0);
    }
    if !args.qls_timeout.is_finite() || args.qls_timeout <= 0.0 || args.qls_timeout > 1e9 {
        return Err("--qls-timeout must be positive, finite, and at most 1e9 seconds".into());
    }
    if (args.fix || args.diff) && args.backend == "qls" {
        return Err("--fix and --diff require the builtin backend".into());
    }
    if args.diff && args.format == "json" {
        return Err("--diff cannot be combined with --format json".into());
    }
    let settings = config(args.config.as_deref())?;
    let ignore = ignored(&settings.ignore, &args.ignore)?;
    let (root, mut patterns) = (settings.root, settings.exclude);
    for p in &args.exclude {
        patterns.push(glob::Pattern::new(p.trim_end_matches('/')).map_err(|e| e.to_string())?);
    }
    let paths = if args.paths.is_empty() {
        vec![".".into()]
    } else {
        args.paths
    };
    let mut sources = vec![];
    if paths.iter().any(|p| p == "-") {
        if args.fix {
            return Err("--fix needs file paths; use --diff to preview stdin".into());
        }
        if paths.len() != 1 {
            return Err("Stdin (-) must be the only input".into());
        }
        if args.stdin_filename == "<stdin>"
            || !excluded(Path::new(&args.stdin_filename), &root, &patterns)
        {
            let mut source = String::new();
            io::stdin()
                .read_to_string(&mut source)
                .map_err(|e| e.to_string())?;
            sources.push((args.stdin_filename, source));
        }
    } else {
        let mut files = BTreeSet::new();
        let mut skipped = false;
        let mut skipped_not_q = false;
        for name in paths {
            let path = Path::new(&name);
            if !path.exists() {
                return Err(format!("Path does not exist: {name}"));
            }
            if excluded(path, &root, &patterns) {
                skipped = true;
                continue;
            }
            if path.is_file() {
                // Only q source, however the path arrived. `qlinter *` makes
                // every entry in a directory an explicit argument - the shell
                // expanded it, not the user - and one of them is as likely to
                // be a README, a Python script or the q interpreter itself as
                // it is to be q. The rules here describe q and say nothing
                // true about any of those.
                if is_q_source(path) {
                    files.insert(absolute(path));
                } else {
                    skipped_not_q = true;
                }
                continue;
            }
            if !path.is_dir() {
                return Err(format!("Not a file/directory: {name}"));
            }
            let mut walk = walkdir::WalkDir::new(path).into_iter();
            while let Some(entry) = walk.next() {
                let entry = entry.map_err(|e| e.to_string())?;
                let p = entry.path();
                if excluded(p, &root, &patterns) {
                    skipped = true;
                    if entry.file_type().is_dir() {
                        walk.skip_current_dir();
                    }
                    continue;
                }
                if entry.depth() > 0
                    && entry.file_type().is_dir()
                    && [
                        ".git",
                        ".venv",
                        "node_modules",
                        "__pycache__",
                        "build",
                        "dist",
                        "target",
                    ]
                    .iter()
                    .any(|n| entry.file_name() == *n)
                {
                    walk.skip_current_dir();
                    continue;
                }
                if p.is_file() && is_q_source(p) {
                    files.insert(absolute(p));
                }
            }
        }
        if files.is_empty() && !skipped {
            return Err(if skipped_not_q {
                "No .q files among the paths given".into()
            } else {
                "No .q files found".to_string()
            });
        }
        for path in files {
            // A file that cannot be read as text is reported and passed over.
            // Aborting here would mean one unreadable file hides every finding
            // in every other file, which is the opposite of useful.
            //
            // A file that is not UTF-8 is still q - q reads bytes, and KX's
            // own e/c.q carries Latin-1 after its closing backslash - so it
            // is linted with each invalid byte read as one replacement
            // character, which keeps every line and column where it was.
            // Never under --fix or --diff: writing the decoded text back
            // would change the bytes this linter could not read.
            match fs::read(&path) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(source) => sources.push((path.to_string_lossy().into_owned(), source)),
                    Err(_) if args.fix || args.diff => eprintln!(
                        "qlinter: {}: not valid UTF-8, skipped: a fix would rewrite bytes it cannot read",
                        path.display()
                    ),
                    Err(e) => {
                        eprintln!(
                            "qlinter: {}: not valid UTF-8; each invalid byte is read as one character",
                            path.display()
                        );
                        let source = String::from_utf8_lossy(e.as_bytes()).into_owned();
                        sources.push((path.to_string_lossy().into_owned(), source));
                    }
                },
                Err(e) => eprintln!("qlinter: {}: {e}, skipped", path.display()),
            }
        }
    }
    // The files linted together are each other's workspace: a name one
    // defines is not undefined in another. Indexing reads them; nothing runs.
    let mut workspace = Workspace::default();
    for (_, source) in &sources {
        workspace.add(&index(source));
    }
    if args.fix || args.diff {
        let mut fixed = 0;
        let mut changed_files = 0;
        for (path, source) in &mut sources {
            let mut edits: Vec<_> = lint_in(source, path, profile(&args.profile), &workspace)
                .iter()
                .filter(|finding| !ignore.contains(&finding.code))
                .filter_map(|finding| fix_for(finding, source))
                .filter(|fix| fix.batch_safe || args.unsafe_fixes)
                .collect();
            edits.sort_by_key(|fix| (fix.start, fix.end));
            let mut selected = vec![];
            let mut end = 0;
            for edit in edits {
                if edit.start < end || edit.end > source.len() {
                    continue;
                }
                end = edit.end;
                selected.push(edit);
            }
            if selected.is_empty() {
                continue;
            }
            let mut updated = source.clone();
            for edit in selected.iter().rev() {
                updated.replace_range(edit.start..edit.end, &edit.replacement);
            }
            if args.diff {
                print_diff(path, source, &selected);
            } else {
                fs::write(path.as_str(), &updated).map_err(|e| format!("{path}: {e}"))?;
                *source = updated;
            }
            fixed += selected.len();
            changed_files += 1;
        }
        if args.diff {
            eprintln!("qlinter: {fixed} fix(es) available in {changed_files} file(s)");
            return Ok(u8::from(fixed > 0));
        }
        eprintln!("qlinter: fixed {fixed} finding(s) in {changed_files} file(s)");
    }
    let mut findings = vec![];
    if args.backend != "qls" {
        for (path, source) in &sources {
            findings.extend(lint_in(source, path, profile(&args.profile), &workspace));
        }
    }
    if args.backend != "builtin" {
        findings.extend(qls::lint(
            sources.clone(),
            &args.qls_executable,
            args.qls_timeout,
        )?);
    }
    findings.retain(|f| !ignore.contains(&f.code));
    findings.sort_by(|a, b| {
        (&a.path, a.line, a.column, &a.source, &a.rule)
            .cmp(&(&b.path, b.line, b.column, &b.source, &b.rule))
    });
    if args.format == "json" {
        println!("{}", serde_json::to_string(&findings).unwrap());
    } else {
        let paint = Paint::for_stdout(&args.color);
        for f in &findings {
            let col = f.column.map_or(String::new(), |c| format!(":{c}"));
            let severity = match f.severity.as_str() {
                "error" => paint.red_bold(&f.severity),
                "warning" => paint.yellow_bold(&f.severity),
                other => other.to_string(),
            };
            println!(
                "{}:{}{}: {}: {} [{}/{}] {}\n    {}",
                paint.bold(&f.path),
                f.line,
                col,
                severity,
                paint.bold(&f.code),
                f.category,
                f.rule,
                f.detail,
                paint.dim(&f.why)
            );
        }
        let errors = findings.iter().filter(|f| f.severity == "error").count();
        let warnings = findings.iter().filter(|f| f.severity == "warning").count();
        let tally = match (errors, warnings) {
            (0, 0) => String::new(),
            _ => format!(
                " ({}, {})",
                paint.red_bold(&format!(
                    "{errors} error{}",
                    if errors == 1 { "" } else { "s" }
                )),
                paint.yellow_bold(&format!(
                    "{warnings} warning{}",
                    if warnings == 1 { "" } else { "s" }
                )),
            ),
        };
        println!(
            "qlinter: {} file(s), {} finding(s){tally}",
            sources.len(),
            findings.len()
        );
    }
    Ok(u8::from(findings.iter().any(|f| {
        matches!(f.severity.as_str(), "error" | "warning")
    })))
}

/// Zero-context unified diff, built from the edits rather than by pairing
/// lines: a fix may remove a line (a commented-out definition) or join two,
/// and pairing old and new lines by position would misalign every hunk after
/// it. Each hunk is the whole lines an edit touches, with edits that share a
/// line merged into one.
fn print_diff(path: &str, before: &str, edits: &[q_lint_rs::Fix]) {
    println!("--- a/{path}\n+++ b/{path}");
    // On bytes: `end - 1` can sit inside a multi-byte character - a BOM is
    // three - and a newline is one byte wherever it is.
    let bytes = before.as_bytes();
    let line_start = |at: usize| {
        bytes[..at]
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |i| i + 1)
    };
    let line_end = |at: usize| {
        bytes[at..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(before.len(), |i| at + i + 1)
    };
    let mut hunks: Vec<(usize, usize, Vec<&q_lint_rs::Fix>)> = vec![];
    for edit in edits {
        let from = line_start(edit.start);
        let to = line_end(if edit.end > edit.start {
            edit.end - 1
        } else {
            edit.start
        });
        match hunks.last_mut() {
            Some(last) if from < last.1 => {
                last.1 = last.1.max(to);
                last.2.push(edit);
            }
            _ => hunks.push((from, to, vec![edit])),
        }
    }
    let lines = |text: &str| text.split_inclusive('\n').count();
    let mut shift = 0isize;
    for (from, to, group) in hunks {
        let old = &before[from..to];
        let mut new = String::new();
        let mut at = from;
        for edit in group {
            new.push_str(&before[at..edit.start]);
            new.push_str(&edit.replacement);
            at = edit.end;
        }
        new.push_str(&before[at..to]);
        let first = before[..from].matches('\n').count() + 1;
        let (old_n, new_n) = (lines(old), lines(&new));
        // A side with no lines names the line before it, as diff does.
        let old_at = if old_n == 0 { first - 1 } else { first };
        let new_first = (first as isize + shift) as usize;
        let new_at = if new_n == 0 { new_first - 1 } else { new_first };
        println!("@@ -{old_at},{old_n} +{new_at},{new_n} @@");
        // The file's last line may have no newline, which `patch` needs told.
        let show = |sign: char, text: &str| {
            for line in text.split_inclusive('\n') {
                println!("{sign}{}", line.trim_end_matches('\n'));
                if !line.ends_with('\n') {
                    println!("\\ No newline at end of file");
                }
            }
        };
        show('-', old);
        show('+', &new);
        shift += new_n as isize - old_n as isize;
    }
}
/// The `--profile` flag, as the rule set it selects. clap has already refused
/// anything not in the list, so the fallback is unreachable rather than a
/// silent default.
///
/// The default is the broadest profile. This binary's job is to report
/// everything it can see; a consumer that wants fewer findings narrows in its
/// own configuration, where the choice is theirs and stays with their code.
fn profile(name: &str) -> Profile {
    match name {
        "general" => Profile::General,
        "style" => Profile::Style,
        "styleq" => Profile::StyleQ,
        _ => Profile::Uqf,
    }
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("qlinter: {error}");
            ExitCode::from(2)
        }
    }
}

/// ANSI colour for the text output, or none.
///
/// Off unless stdout is a terminal, off whenever `NO_COLOR` is set to anything
/// (https://no-color.org), and overridable either way by `--color`. A pipe
/// into grep or a file gets plain text, which is what the tools on the other
/// end of it expect.
struct Paint {
    on: bool,
}
impl Paint {
    fn for_stdout(flag: &str) -> Self {
        use std::io::IsTerminal;
        let on = match flag {
            "always" => true,
            "never" => false,
            _ => std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
        };
        Self { on }
    }
    fn wrap(&self, codes: &str, text: &str) -> String {
        if self.on {
            format!("\x1b[{codes}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }
    fn red_bold(&self, text: &str) -> String {
        self.wrap("1;31", text)
    }
    fn yellow_bold(&self, text: &str) -> String {
        self.wrap("1;33", text)
    }
    fn bold(&self, text: &str) -> String {
        self.wrap("1", text)
    }
    fn dim(&self, text: &str) -> String {
        self.wrap("2", text)
    }
}
