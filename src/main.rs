mod jsonrpc;
mod lsp;
mod qls;
use clap::Parser;
use q_lint_rs::{Profile, RULES, lint};
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
    #[arg(long)]
    rules: bool,
    #[arg(long)]
    explain: Option<String>,
    #[arg(long,default_value="builtin",value_parser=["builtin","qls","all"])]
    backend: String,
    #[arg(long, default_value = "qls")]
    qls_executable: String,
    #[arg(long, default_value = "30")]
    qls_timeout: f64,
    /// Run as a language server on stdin/stdout instead of linting paths.
    #[arg(long, conflicts_with_all = ["paths", "rules", "explain"])]
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
fn config(explicit: Option<&Path>) -> Result<(PathBuf, Vec<glob::Pattern>), String> {
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
            if table.keys().any(|k| k != "exclude") {
                return Err("[tool.q-lint] supports only exclude".into());
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
            return Ok((
                fs::canonicalize(path)
                    .map_err(|e| e.to_string())?
                    .parent()
                    .unwrap()
                    .to_path_buf(),
                patterns,
            ));
        }
        if explicit.is_some() {
            return Err("missing [tool.q-lint]".into());
        }
    }
    Ok((cwd, vec![]))
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
        let stdin = io::stdin();
        let stdout = io::stdout();
        return lsp::serve(
            &mut stdin.lock(),
            &mut stdout.lock(),
            profile(&args.profile),
        );
    }
    if args.rules || args.explain.is_some() {
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
    let (root, mut patterns) = config(args.config.as_deref())?;
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
            match fs::read_to_string(&path) {
                Ok(source) => sources.push((path.to_string_lossy().into_owned(), source)),
                Err(e) => eprintln!("qlinter: {}: {e}, skipped", path.display()),
            }
        }
    }
    let mut findings = vec![];
    if args.backend != "qls" {
        for (path, source) in &sources {
            findings.extend(lint(source, path, profile(&args.profile)));
        }
    }
    if args.backend != "builtin" {
        findings.extend(qls::lint(
            sources.clone(),
            &args.qls_executable,
            args.qls_timeout,
        )?);
    }
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
