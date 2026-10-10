mod config;
mod jsonrpc;
mod lsp;
mod qls;
use clap::Parser;
use config::{Layer, Overrides, Policy};
use q_lint_rs::{RULES, Workspace, fixes_for, index};
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
    /// The rule set: `general` (what q refuses), `style`, `styleq` or `uqf`.
    /// Wins over `profile` in a configuration file. Without either, `uqf` -
    /// and `style` for `--lsp`.
    #[arg(long, value_parser=["general","style","styleq","uqf"])]
    profile: Option<String>,
    #[arg(long, default_value = "<stdin>")]
    stdin_filename: String,
    /// Use this configuration for every file, instead of the nearest
    /// `.qlinter.toml`, `qlinter.toml` or `pyproject.toml` `[tool.qlinter]`.
    #[arg(long, conflicts_with = "isolated")]
    config: Option<PathBuf>,
    /// Ignore every configuration file; use the defaults and the flags.
    #[arg(long)]
    isolated: bool,
    /// Print which configuration governs each path and the rules it turns
    /// on, then exit.
    #[arg(long)]
    show_settings: bool,
    /// Only these rules: codes or prefixes, comma-separated or repeated.
    /// Replaces the profile's set and the configuration's `select`.
    #[arg(long, value_delimiter = ',')]
    select: Option<Vec<String>>,
    /// Rules added to whatever is selected: codes or prefixes.
    #[arg(long, value_delimiter = ',')]
    extend_select: Vec<String>,
    #[arg(long)]
    exclude: Vec<String>,
    /// Drop findings with this code or prefix, e.g. `--ignore QS001`.
    /// Repeatable or comma-separated, and applied after the configuration.
    #[arg(long, value_delimiter = ',')]
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
    #[arg(long, conflicts_with_all = ["paths", "rules", "explain", "fix", "diff", "show_settings"])]
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
/// The command line's share of the settings, which wins over any file.
fn overrides(args: &Args) -> Result<Overrides, String> {
    let selectors = |key: &str, list: &[String]| -> Result<Vec<String>, String> {
        list.iter().map(|s| config::selector(key, s)).collect()
    };
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    Ok(Overrides {
        profile: args.profile.clone(),
        default_profile: if args.lsp { "style" } else { "uqf" },
        layer: Layer {
            select: args
                .select
                .as_deref()
                .map(|s| selectors("--select", s))
                .transpose()?,
            extend_select: selectors("--extend-select", &args.extend_select)?,
            ignore: selectors("--ignore", &args.ignore)?,
        },
        exclude: args
            .exclude
            .iter()
            .map(|p| config::pattern(p).map(|p| (config::absolute(&cwd), p)))
            .collect::<Result<_, _>>()?,
        config: args.config.clone(),
        isolated: args.isolated,
    })
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

fn run(args: Args) -> Result<u8, String> {
    if args.lsp {
        // Locked once for the life of the process: the server owns both
        // streams, and re-locking per message would be pure overhead.
        // The server reads the same `ignore` the command line does, so an
        // editor shows what `qlinter` prints. A configuration it cannot read
        // is reported and passed over rather than fatal: a server that exits
        // gives an editor no diagnostics and no reason why.
        let policy = Policy::new(overrides(&args)?, true);
        let stdin = io::stdin();
        let stdout = io::stdout();
        return lsp::serve(&mut stdin.lock(), &mut stdout.lock(), &policy);
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
    let policy = Policy::new(overrides(&args)?, false);
    if args.show_settings {
        let paths = if args.paths.is_empty() {
            vec![".".to_string()]
        } else {
            args.paths.clone()
        };
        for name in paths {
            // A directory is described as a file inside it would be, so its
            // own configuration counts.
            let path = Path::new(&name);
            let probe = if path.is_dir() {
                path.join("*.q")
            } else {
                path.to_path_buf()
            };
            println!("{}\n", policy.describe(&probe)?);
        }
        return Ok(0);
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
        if args.stdin_filename == "<stdin>" || !policy.excluded(Path::new(&args.stdin_filename))? {
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
            if policy.excluded(path)? {
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
                    files.insert(config::absolute(path));
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
                if policy.excluded(p)? {
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
                    files.insert(config::absolute(p));
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
            let mut edits: Vec<_> = fixes_for(&policy.lint(source, path, &workspace)?, source)
                .into_iter()
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
            findings.extend(policy.lint(source, path, &workspace)?);
        }
    }
    if args.backend != "builtin" {
        findings.extend(qls::lint(
            sources.clone(),
            &args.qls_executable,
            args.qls_timeout,
        )?);
    }
    // qls reports on its own; the configuration still decides what is shown.
    let mut kept = vec![];
    for f in findings {
        if policy.enabled(&f.code, Path::new(&f.path))? {
            kept.push(f);
        }
    }
    let mut findings = kept;
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
