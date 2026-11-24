mod baseline;
mod config;
mod jsonrpc;
mod lsp;
mod qls;
mod report;
use clap::Parser;
use config::{Layer, Overrides, Policy};
use q_lint_rs::{
    RULES, Workspace, balanced, fix_all, fixes_for, index, suppressions_for, whole_edit,
};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::ExitCode,
};

/// `println!`, except that a closed pipe ends the run quietly. `qlinter src |
/// head -1` closes stdout after one line, and `println!` panics on the next
/// write - exit 101 and a backtrace hint for a reader who asked for less.
/// Ruff, following ripgrep, exits 0 on a broken pipe, and so does this.
macro_rules! out {
    ($($arg:tt)*) => {
        emit(format_args!($($arg)*), true)
    };
}

/// The file `--output-file` names: where the report goes instead of stdout.
static OUTPUT_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// That file, created on the first write - not before the arguments are
/// checked and the sources read, so a refused run or a file that is also an
/// input is never truncated. A file that cannot be created exits 2.
fn output() -> Option<&'static fs::File> {
    static OUTPUT: std::sync::OnceLock<fs::File> = std::sync::OnceLock::new();
    let path = OUTPUT_PATH.get()?;
    Some(OUTPUT.get_or_init(|| {
        fs::File::create(path).unwrap_or_else(|e| {
            eprintln!("qlinter: {}: {e}", path.display());
            std::process::exit(2)
        })
    }))
}

/// Write to stdout, or the `--output-file`, ending the line when `newline`;
/// see `out!`. Any other write error is reported and exits 2, as an output
/// failure.
fn emit(text: std::fmt::Arguments, newline: bool) {
    use std::io::Write;
    fn write(to: &mut impl Write, text: std::fmt::Arguments, newline: bool) -> io::Result<()> {
        to.write_fmt(text)?;
        if newline { to.write_all(b"\n") } else { Ok(()) }
    }
    let written = match output() {
        Some(mut file) => write(&mut file, text, newline),
        None => write(&mut io::stdout().lock(), text, newline),
    };
    match written {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe && OUTPUT_PATH.get().is_none() => {
            std::process::exit(0)
        }
        Err(e) => {
            eprintln!("qlinter: writing output: {e}");
            std::process::exit(2);
        }
    }
}

#[derive(Parser)]
#[command(
    name = "qlinter",
    about = "Lint q source without executing it",
    version,
    // clap's default short form is `-V`. Most people reach for `-v` first and
    // nothing here means verbose, so both answer.
    disable_version_flag = true,
    // `qlinter analyze graph src/` is a subcommand, recognised only as the
    // first argument; `qlinter src/` and every flag below still lint, and a
    // directory named `analyze` is linted as `./analyze`. A lint flag after
    // the subcommand is refused rather than silently ignored.
    args_conflicts_with_subcommands = true,
    // `help` stays a path, as it always was: `--help` is the flag.
    disable_help_subcommand = true
)]
struct Args {
    #[arg(short = 'v', short_alias = 'V', long, action = clap::ArgAction::Version)]
    version: (),
    #[command(subcommand)]
    command: Option<Command>,
    paths: Vec<String>,
    /// `text`, `json`, `sarif` (SARIF 2.1.0, for code scanning) or `github`
    /// (workflow commands, which a GitHub Actions run shows as annotations).
    #[arg(long,default_value="text",value_parser=["text","json","sarif","github"])]
    format: String,
    /// The rule set: `general` (what q refuses), `style`, `styleq` or `uqf`.
    /// Wins over `profile` in a configuration file. Without either, `uqf` -
    /// and `style` for `--lsp`.
    #[arg(long, value_parser=["general","style","styleq","uqf"])]
    profile: Option<String>,
    /// The path standard input is linted as. It means stdin is read, `-` or
    /// not, as in Ruff: an editor that pipes a buffer with it and no `-`
    /// wants that buffer linted, not the tree it runs in.
    #[arg(long)]
    stdin_filename: Option<String>,
    /// Use this configuration for every file, instead of the nearest
    /// `.qlinter.toml`, `qlinter.toml` or `pyproject.toml` `[tool.qlinter]`.
    #[arg(long, conflicts_with = "isolated")]
    config: Option<PathBuf>,
    /// Ignore every configuration file; use the defaults and the flags.
    #[arg(long)]
    isolated: bool,
    /// Report what does not run on this q release: `3.6`, `4.0`, `4.1` or
    /// `kdbx` (the QK rules). Wins over `target-version` in a configuration
    /// file; without either, the QK rules report nothing.
    #[arg(long, value_parser = ["3.6", "4.0", "4.1", "kdbx"])]
    target_version: Option<String>,
    /// Report only the findings not in this baseline file, which
    /// `--write-baseline` writes. Wins over `baseline` in a configuration.
    #[arg(long, conflicts_with = "write_baseline")]
    baseline: Option<PathBuf>,
    /// Write every finding of this run to a baseline file (replacing it), and
    /// report none. Later runs given it with `--baseline`, or under a
    /// configuration naming it, report only what is new.
    #[arg(long, conflicts_with_all = ["fix", "diff", "show_settings"])]
    write_baseline: Option<PathBuf>,
    /// Print which configuration governs each path (or `--stdin-filename`)
    /// and the rules it turns on, then exit.
    #[arg(long, conflicts_with_all = ["fix", "diff"])]
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
    /// Apply `exclude` to paths named on the command line too, and to
    /// `--stdin-filename`. Without it an excluded file named explicitly is
    /// still linted, as in Ruff; editors and pre-commit hooks pass it.
    #[arg(long)]
    force_exclude: bool,
    /// Drop findings with this code or prefix, e.g. `--ignore QS001`.
    /// Repeatable or comma-separated, and applied after the configuration.
    #[arg(long, value_delimiter = ',')]
    ignore: Vec<String>,
    /// Print how many findings each rule has, with its summary, most first,
    /// instead of the findings. A list of objects under `--format json`.
    #[arg(long, conflicts_with_all = ["diff", "write_baseline", "show_settings"])]
    statistics: bool,
    /// Write the report to this file (replacing it) instead of stdout, in
    /// whatever format; the exit code is the same.
    #[arg(long)]
    output_file: Option<PathBuf>,
    /// Accept every finding of this run where it is: append `/ noqa: CODE`
    /// to its line, or add the code to the `noqa` already there - the
    /// editor's Quick Fix, made for each. A line it would not be a comment
    /// on (inside a string or a block comment) is left alone.
    #[arg(long, conflicts_with_all = ["fix", "diff", "write_baseline", "show_settings", "statistics"])]
    add_noqa: bool,
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
    /// The flags that shape a CLI run are refused rather than ignored: the
    /// server reads none of them, and one put in an editor's server
    /// arguments would otherwise do nothing and say nothing (#798). It lints
    /// with the builtin backend alone, so `--backend` is one too (#544).
    #[arg(long, conflicts_with_all = ["paths", "rules", "explain", "fix", "diff", "show_settings",
        "stdin_filename", "format", "color", "force_exclude", "unsafe_fixes",
        "backend", "qls_executable", "qls_timeout", "baseline", "write_baseline", "statistics", "output_file", "add_noqa"])]
    lsp: bool,
    /// Colour the text output: `auto` (a terminal, and NO_COLOR unset or empty),
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
#[derive(clap::Subcommand)]
enum Command {
    /// Read a q tree as a whole, without running it.
    Analyze {
        #[command(subcommand)]
        what: Analyze,
    },
}

#[derive(clap::Subcommand)]
enum Analyze {
    /// Print the file-to-file dependency graph as JSON: each file and the
    /// files it depends on, by the global names it reads and the scripts it
    /// loads. Paths are relative to the current directory.
    Graph(GraphArgs),
}

#[derive(clap::Args)]
struct GraphArgs {
    paths: Vec<String>,
    /// `dependencies`: each file and the files it depends on. `dependents`:
    /// each file and the files that depend on it.
    #[arg(long, default_value = "dependencies", value_parser = ["dependencies", "dependents"])]
    direction: String,
    /// Also count a qualified symbol literal, `` `.ns.f ``, as a read of the
    /// name it spells - the way a callback is registered.
    #[arg(long)]
    symbols: bool,
    /// Print `{file: {<direction>, ambiguous, dynamic}}` instead of
    /// `{file: [files]}`: the names more than one file defines, and the
    /// places a name is reached by a value computed at run time.
    #[arg(long)]
    detail: bool,
    /// Leave out paths matching this glob, as `exclude` in a configuration
    /// file does, which is honoured too.
    #[arg(long)]
    exclude: Vec<String>,
    /// Apply `exclude` to paths named on the command line too, as linting's
    /// `--force-exclude` does: without it a file named outright is a node.
    #[arg(long)]
    force_exclude: bool,
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
            .map(|p| config::excluding(&config::absolute(&cwd), p))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("--exclude: {e}"))?,
        config: args.config.clone(),
        isolated: args.isolated,
        target: args
            .target_version
            .as_deref()
            .and_then(q_lint_rs::Target::parse),
        baseline: args.baseline.clone(),
        no_baseline: args.write_baseline.is_some(),
    })
}

/// Refuse a run whose `flag` would write `target` over a file it reads.
///
/// Every flag that writes a file goes through this one check, before
/// anything is written, so a refused run exits 2 and leaves the file as it
/// was: `--write-baseline o.q`, with `o.q` taken for the flag's value and
/// the tree linted, would otherwise replace the source with JSON (#2115).
fn refuse_overwrite(flag: &str, target: Option<&Path>, inputs: &[PathBuf]) -> Result<(), String> {
    let Some(target) = target else {
        return Ok(());
    };
    if inputs.iter().any(|f| same_file(target, f)) {
        return Err(format!(
            "{flag} {}: it is one of the files to lint",
            target.display()
        ));
    }
    Ok(())
}

/// Whether two paths reach one file on disk: compared as files, not names,
/// so a symlink to a source, a hard link, or another case of its name on a
/// disk that ignores case is the source (#2116). A path that names no file
/// yet is no input, unless it is the input's own name.
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        #[cfg(unix)]
        (Ok(x), Ok(y)) => {
            use std::os::unix::fs::MetadataExt;
            (x.dev(), x.ino()) == (y.dev(), y.ino())
        }
        #[cfg(not(unix))]
        (Ok(_), Ok(_)) => match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x
                .to_string_lossy()
                .eq_ignore_ascii_case(&y.to_string_lossy()),
            _ => false,
        },
        _ => config::absolute(a) == config::absolute(b),
    }
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

/// The q files under `paths`, absolute and in order: a directory is walked,
/// skipping what `exclude` names - by default, the usual build and tool
/// directories; a
/// file named outright is taken if it is q, excluded only with
/// `force_exclude`. And whether any path could not be read: like a file that
/// cannot be, it is reported and passed over, and the rest are still linted -
/// one stale path in a pre-commit file list must not hide every finding in
/// every other file - and the caller ends the run in 2.
fn discover(
    paths: Vec<String>,
    policy: &Policy,
    force_exclude: bool,
) -> Result<(BTreeSet<PathBuf>, bool), String> {
    let mut files = BTreeSet::new();
    let mut skipped = false;
    let mut skipped_not_q = false;
    let mut failed = false;
    for name in paths {
        let path = Path::new(&name);
        if let Err(e) = fs::metadata(path) {
            eprintln!("qlinter: {name}: {e}, skipped");
            failed = true;
            continue;
        }
        // A path named here is linted whatever `exclude` says, unless
        // --force-exclude: exclusion is for what a walk discovers.
        if force_exclude && policy.force_excluded(path)? {
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
            eprintln!("qlinter: {name}: not a file or directory, skipped");
            failed = true;
            continue;
        }
        let mut walk = walkdir::WalkDir::new(path).into_iter();
        while let Some(entry) = walk.next() {
            // A directory the walk cannot read - a root-owned cache, a
            // mount - is reported and passed over like a file that cannot be.
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    let at = e.path().unwrap_or(path).display().to_string();
                    match e.io_error() {
                        Some(io) => eprintln!("qlinter: {at}: {io}, skipped"),
                        None => eprintln!("qlinter: {e}, skipped"),
                    }
                    failed = true;
                    continue;
                }
            };
            let p = entry.path();
            if entry.depth() > 0 && policy.excluded(p)? {
                skipped = true;
                if entry.file_type().is_dir() {
                    walk.skip_current_dir();
                }
                continue;
            }
            if p.is_file() && is_q_source(p) {
                files.insert(config::absolute(p));
            }
        }
    }
    if files.is_empty() && !skipped && !failed {
        return Err(if skipped_not_q {
            "No .q files among the paths given".into()
        } else {
            "No .q files found".to_string()
        });
    }
    Ok((files, failed))
}

fn run(args: Args) -> Result<u8, String> {
    if let Some(Command::Analyze {
        what: Analyze::Graph(graph),
    }) = args.command
    {
        return analyze_graph(graph);
    }
    if args.lsp {
        // stdout locked once for the life of the process: the server owns
        // it, and re-locking per message would be pure overhead. stdin is
        // read by a thread of the server's own, which a lock cannot be
        // handed to.
        // The server reads the same `ignore` the command line does, so an
        // editor shows what `qlinter` prints. A configuration it cannot read
        // is reported and passed over rather than fatal: a server that exits
        // gives an editor no diagnostics and no reason why.
        let policy = Policy::new(overrides(&args)?, true);
        let stdout = io::stdout();
        return lsp::serve(io::BufReader::new(io::stdin()), &mut stdout.lock(), &policy);
    }
    if let Some(file) = &args.output_file {
        let _ = OUTPUT_PATH.set(file.clone());
    }
    if args.rules || args.explain.is_some() {
        if args.fix || args.diff {
            return Err("--fix and --diff require q source paths, not --rules or --explain".into());
        }
        if !matches!(args.format.as_str(), "text" | "json") {
            return Err(format!(
                "--format {} reports findings; --rules and --explain print text or json",
                args.format
            ));
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
            out!("{}", serde_json::to_string(&entries).unwrap());
        } else {
            for r in entries {
                // Where the rule runs, in the words docs/rules.md uses: the
                // taxonomy's `builtin` scope is no profile a user can name
                // (#791). JSON keeps the scope as data.
                let runs = match r.scope.as_str() {
                    "builtin" => "every profile",
                    "style" => "style and above",
                    "styleq" => "styleq and above",
                    "uqf" => "uqf",
                    "opt-in" => "no profile: select it by code",
                    "python-hook" => "a Python hook",
                    "qls" => "the qls backend",
                    other => other,
                };
                out!(
                    "{} [{}] {}: {} ({})",
                    r.code,
                    r.category,
                    r.name,
                    r.summary,
                    runs
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
    if args.add_noqa && args.backend == "qls" {
        return Err("--add-noqa requires the builtin backend".into());
    }
    if args.diff && args.format != "text" {
        return Err(format!(
            "--diff cannot be combined with --format {}",
            args.format
        ));
    }
    if args.statistics && !matches!(args.format.as_str(), "text" | "json") {
        return Err(format!(
            "--statistics prints text or json, not --format {}",
            args.format
        ));
    }
    let policy = Policy::new(overrides(&args)?, false);
    if args.show_settings {
        // The buffer an editor pipes is the file it asks about (#806),
        // named `-` or not, as Ruff's `--stdin-filename X -` names it.
        let only_stdin = args.paths.is_empty() || args.paths == ["-"];
        let paths = if let (true, Some(name)) = (only_stdin, &args.stdin_filename) {
            vec![name.clone()]
        } else if args.paths.is_empty() {
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
            out!("{}\n", policy.describe(&probe, &args.backend)?);
        }
        return Ok(0);
    }
    let stdin = args.stdin_filename.is_some() || args.paths.iter().any(|p| p == "-");
    let only_stdin = args.paths.len() <= 1 && args.paths.iter().all(|p| p == "-");
    let paths = if args.paths.is_empty() {
        vec![".".into()]
    } else {
        args.paths
    };
    let mut sources = vec![];
    // Each source's file, beside the name it is shown and configured by:
    // a name that is not UTF-8 is shown lossily, and every read and write
    // goes to the file itself, not to a file of the lossy name (#1194).
    let mut disk: Vec<PathBuf> = vec![];
    let mut failed = false;
    // Files read lossily, which are linted and reported but never fixed.
    let mut lossy = std::collections::HashSet::new();
    // Every file the run reads, which no file it writes may be.
    let mut inputs: Vec<PathBuf> = vec![];
    if stdin {
        if args.fix {
            return Err("--fix needs file paths; use --diff to preview stdin".into());
        }
        if args.add_noqa {
            return Err("--add-noqa needs file paths".into());
        }
        // Refused rather than one of them quietly ignored: the paths, or
        // the buffer the flag names.
        if !only_stdin {
            return Err("Stdin (- or --stdin-filename) must be the only input".into());
        }
        let name = args.stdin_filename.unwrap_or_else(|| "<stdin>".into());
        // The file the buffer is linted as is the file an editor saves it
        // to: a report written there replaces it (#2116).
        if name != "<stdin>" {
            inputs.push(PathBuf::from(&name));
        }
        // Only q source, however the path arrived: a `.k` buffer is a
        // different language, refused as the same file named outright is
        // (#421).
        if name != "<stdin>" && !is_q_source(Path::new(&name)) {
            return Err(format!("--stdin-filename {name}: not a .q file"));
        }
        if name == "<stdin>" || !args.force_exclude || !policy.force_excluded(Path::new(&name))? {
            // Read as bytes and decoded as a file is: a buffer that is not
            // UTF-8 is still q, and is linted but never fixed (#417).
            let mut bytes = vec![];
            io::stdin()
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            let source = match String::from_utf8(bytes) {
                Ok(source) => source,
                Err(e) => {
                    if args.diff {
                        eprintln!(
                            "qlinter: {name}: not valid UTF-8; linted with each invalid byte read as one character, and not fixed: a fix would rewrite bytes it cannot read"
                        );
                    } else {
                        eprintln!(
                            "qlinter: {name}: not valid UTF-8; each invalid byte is read as one character"
                        );
                    }
                    lossy.insert(name.clone());
                    lossy_text(e.as_bytes())
                }
            };
            disk.push(PathBuf::from(&name));
            sources.push((name, source));
        }
    } else {
        let (files, missing) = discover(paths, &policy, args.force_exclude)?;
        failed |= missing;
        inputs.extend(files.iter().cloned());
        for path in files {
            // A file that cannot be read is reported and passed over, and the
            // run ends in exit 2, an input failure, whatever the others find.
            // Aborting here would mean one unreadable file hides every finding
            // in every other file, which is the opposite of useful; exiting 0
            // would tell CI a file nobody linted is clean. Ruff, likewise,
            // reports E902 and goes on, and its exit code is not 0.
            //
            // A file that is not UTF-8 is still q - q reads bytes, and KX's
            // own e/c.q carries Latin-1 after its closing backslash - so it
            // is linted with each invalid byte read as one replacement
            // character, which keeps every line and column where it was.
            // Under --fix or --diff it is still linted and reported, but never
            // fixed: writing the decoded text back would change the bytes
            // this linter could not read.
            match fs::read(&path) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(source) => {
                        sources.push((path.to_string_lossy().into_owned(), source));
                        disk.push(path);
                    }
                    Err(e) => {
                        if args.fix || args.diff {
                            eprintln!(
                                "qlinter: {}: not valid UTF-8; linted with each invalid byte read as one character, and not fixed: a fix would rewrite bytes it cannot read",
                                path.display()
                            );
                        } else {
                            eprintln!(
                                "qlinter: {}: not valid UTF-8; each invalid byte is read as one character",
                                path.display()
                            );
                        }
                        let source = lossy_text(e.as_bytes());
                        let name = path.to_string_lossy().into_owned();
                        lossy.insert(name.clone());
                        sources.push((name, source));
                        disk.push(path);
                    }
                },
                Err(e) => {
                    eprintln!("qlinter: {}: {e}, skipped", path.display());
                    failed = true;
                }
            }
        }
    }
    refuse_overwrite("--output-file", args.output_file.as_deref(), &inputs)?;
    refuse_overwrite("--write-baseline", args.write_baseline.as_deref(), &inputs)?;
    if let Some(file) = &args.write_baseline
        && file
            .extension()
            .is_some_and(|e| ["q", "k", "qnb"].iter().any(|x| e.eq_ignore_ascii_case(x)))
    {
        return Err(format!(
            "--write-baseline {}: a baseline is JSON, not q source; name it as one, such as qlinter-baseline.json",
            file.display()
        ));
    }
    // The files linted together are each other's workspace: a name one
    // defines is not undefined in another. Indexing reads them; nothing runs.
    // One file under two names - a symlink beside its target - is one file's
    // definitions, not two files each defining what the other does, which
    // would leave each name's own `a` "defined elsewhere" (#527).
    // A script loaded under `\d .a` defines in `.a`, as the graph has it:
    // with main.q's `\d .a` / `\l b.q`, b.q's `ff:42` is `.a.ff`, which
    // c.q's `\d .a` / `g:{ff}` reads, and there is no root `ff` for d.q's
    // `h:{ff}` (q 5, #525). Only a file that both switches context and
    // loads can put another in a context.
    let placed = if sources.iter().any(|(_, s)| {
        (s.contains("\\d") || s.contains("\"d ")) && (s.contains("\\l") || s.contains("\"l "))
    }) {
        let cwd = config::absolute(&std::env::current_dir().map_err(|e| e.to_string())?);
        let paths: Vec<_> = sources
            .iter()
            .map(|(name, _)| PathBuf::from(name))
            .collect();
        let reads: Vec<_> = sources
            .iter()
            .map(|(_, source)| q_lint_rs::references(source, false))
            .collect();
        let loads: Vec<_> = reads.iter().map(|r| r.loads.as_slice()).collect();
        q_lint_rs::graph::placements(&paths, &loads, &cwd)
            .into_iter()
            .zip(reads)
            .map(|(placement, read)| Some((placement, read.implicit_defines)))
            .collect()
    } else {
        vec![None; sources.len()]
    };
    let mut workspace = Workspace::default();
    let mut indexed = std::collections::HashSet::new();
    for (((_, source), file), placed) in sources.iter().zip(&disk).zip(placed) {
        if indexed.insert(fs::canonicalize(file).unwrap_or_else(|_| file.clone())) {
            let mut file = index(source);
            if let Some((placement, implicit)) = placed {
                placement.apply(&mut file, &implicit);
            }
            workspace.add(&file);
        }
    }
    if args.add_noqa {
        return add_noqa(&mut sources, &disk, &lossy, &policy, &workspace, failed);
    }
    if args.fix || args.diff {
        let mut fixed = 0;
        let mut changed_files = 0;
        // Fixes a lossily read file wants but cannot be given: under --diff
        // they still mean the run is not clean.
        let mut withheld = 0;
        // One file under two names - a symlink, `d/../a.q` - is linted under
        // each, with each name's configuration (#11), but fixed as the one
        // file it is: each name starts from what the one before it left, or
        // the second write would clobber the first and the second patch
        // would not apply after it (#761).
        let mut current: std::collections::HashMap<PathBuf, String> = Default::default();
        let canonical = |file: &PathBuf| fs::canonicalize(file).unwrap_or_else(|_| file.clone());
        for ((path, source), file) in sources.iter_mut().zip(&disk) {
            if let Some(text) = current.get(&canonical(file)) {
                source.clone_from(text);
            }
            if lossy.contains(path.as_str()) {
                withheld += fixes_for(&policy.lint(source, path, &workspace)?, source)
                    .into_iter()
                    .filter(|fix| fix.batch_safe || args.unsafe_fixes)
                    .count();
                continue;
            }
            // A file whose brackets or strings do not close is never
            // rewritten, even with QE001 deselected: the fixes would read its
            // structure wrong, as Format Document refuses to (#422, #775).
            if !balanced(source) {
                continue;
            }
            let q_lint_rs::Fixed {
                text: updated,
                count,
                passes,
                first,
            } = fix_all(source, args.unsafe_fixes, |text| {
                policy.lint(text, path, &workspace)
            })?;
            if count == 0 {
                continue;
            }
            if args.diff && passes == 1 {
                print_diff(&diff_path(path), source, &first);
            } else if args.diff {
                // The whole run as one edit, since later passes edit text
                // the first pass wrote rather than the file.
                if let Some(whole) = whole_edit(source, &updated) {
                    print_diff(&diff_path(path), source, &[whole]);
                }
            } else if let Err(e) = fs::write(file, &updated) {
                // As for a file that cannot be read: reported, the rest still
                // fixed and linted - this one as it stands on disk - and the
                // run ends in 2.
                eprintln!("qlinter: {path}: {e}, not fixed");
                failed = true;
                continue;
            } else {
                source.clone_from(&updated);
            }
            current.insert(canonical(file), updated);
            fixed += count;
            changed_files += 1;
        }
        if args.diff {
            eprintln!("qlinter: {fixed} fix(es) available in {changed_files} file(s)");
            if withheld > 0 {
                eprintln!(
                    "qlinter: {withheld} more fix(es) not shown, in files that are not valid UTF-8"
                );
            }
            return Ok(if failed {
                2
            } else {
                u8::from(fixed + withheld > 0)
            });
        }
        eprintln!("qlinter: fixed {fixed} finding(s) in {changed_files} file(s)");
        // A name fixed early is linted as the file ended up, after the
        // names that came later wrote to it.
        for ((_, source), file) in sources.iter_mut().zip(&disk) {
            if let Some(text) = current.get(&canonical(file)) {
                source.clone_from(text);
            }
        }
    }
    // What the baseline passes over is counted once, for the run as reported.
    policy.baselined.set(0);
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
    if let Some(file) = &args.write_baseline {
        let text = baseline::render(file, &findings, &sources);
        fs::write(file, text).map_err(|e| format!("{}: {e}", file.display()))?;
        eprintln!(
            "qlinter: wrote {} finding(s) in {} file(s) to the baseline {}",
            findings.len(),
            sources.len(),
            file.display()
        );
        return Ok(if failed { 2 } else { 0 });
    }
    if policy.baselined.get() > 0 {
        eprintln!(
            "qlinter: {} finding(s) in the baseline not shown",
            policy.baselined.get()
        );
    }
    if args.statistics {
        let rows = report::statistics(&findings);
        if args.format == "json" {
            let rows: Vec<_> = rows
                .iter()
                .map(|(code, count, summary)| {
                    serde_json::json!({"code": code, "count": count, "summary": summary})
                })
                .collect();
            out!("{}", serde_json::to_string(&rows).unwrap());
        } else {
            let width = rows.first().map_or(1, |r| r.1.to_string().len());
            for (code, count, summary) in &rows {
                out!("{count:>width$}  {code:<6}  {summary}");
            }
        }
    } else if args.format == "json" {
        out!("{}", serde_json::to_string(&findings).unwrap());
    } else if args.format == "sarif" {
        let cwd = config::absolute(&std::env::current_dir().map_err(|e| e.to_string())?);
        let report = report::sarif(&findings, &sources, &cwd);
        out!("{}", serde_json::to_string_pretty(&report).unwrap());
    } else if args.format == "github" {
        let cwd = config::absolute(&std::env::current_dir().map_err(|e| e.to_string())?);
        for f in &findings {
            out!("{}", report::github(f, &cwd));
        }
    } else {
        let paint = Paint::for_stdout(&args.color);
        for f in &findings {
            let col = f.column.map_or(String::new(), |c| format!(":{c}"));
            let severity = match f.severity.as_str() {
                "error" => paint.red_bold(&f.severity),
                "warning" => paint.yellow_bold(&f.severity),
                other => other.to_string(),
            };
            out!(
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
        out!(
            "qlinter: {} file(s), {} finding(s){tally}",
            sources.len(),
            findings.len()
        );
    }
    // What --fix leaves it could not fix, and the run says so: a finding
    // still listed is otherwise read as one to run --fix on again (#847).
    // Most have a rule with no fix; some a fix that was refused where the
    // finding is, as QP005's is where an operand's end cannot be told; and
    // a file the run never rewrites has no fix for anything in it.
    if args.fix {
        let (mut unfixed, mut editor_only) = (0, 0);
        for (path, source) in &sources {
            let here: Vec<_> = findings.iter().filter(|f| f.path == *path).collect();
            let fixes = if lossy.contains(path.as_str()) || !balanced(source) {
                vec![]
            } else {
                fixes_for(here.iter().copied(), source)
            };
            unfixed += here.len() - fixes.len();
            editor_only += fixes.iter().filter(|fix| !fix.batch_safe).count();
        }
        if unfixed > 0 {
            eprintln!(
                "qlinter: {unfixed} finding(s) left have no fix: --fix again would not change them"
            );
        }
        if editor_only > 0 && !args.unsafe_fixes {
            eprintln!(
                "qlinter: {editor_only} finding(s) left have a fix that only --unsafe-fixes applies"
            );
        }
    }
    if failed {
        return Ok(2);
    }
    Ok(u8::from(findings.iter().any(|f| {
        matches!(f.severity.as_str(), "error" | "warning")
    })))
}

/// `--add-noqa`: each file rewritten with every finding accepted on its
/// line, then a count on standard error. One code per line per pass, each
/// pass linting what the last one wrote, so a second code on a line joins
/// the `noqa` the first put there and every edit is checked as the editor's
/// is. A file is written once, however many names it was linted under, and
/// never when it is not valid UTF-8. Exit 1 when findings are left that no
/// comment on their line could accept, 2 when a file could not be written.
fn add_noqa(
    sources: &mut [(String, String)],
    disk: &[PathBuf],
    lossy: &std::collections::HashSet<String>,
    policy: &Policy,
    workspace: &Workspace,
    mut failed: bool,
) -> Result<u8, String> {
    // More codes than this on one line is not a line anyone will read.
    const PASSES: usize = 64;
    let (mut added, mut changed, mut left, mut stale) = (0, 0, 0, 0);
    // Each file as it is on disk once its first name is done: a later name
    // is linted against that, not the text read before the write (#1199).
    let mut written: std::collections::HashMap<PathBuf, String> = Default::default();
    for ((path, source), disk) in sources.iter_mut().zip(disk) {
        let file = fs::canonicalize(disk).unwrap_or_else(|_| disk.clone());
        if let Some(text) = written.get(&file) {
            source.clone_from(text);
            let found = policy.lint(source, path, workspace)?;
            stale += found.iter().filter(|f| f.code == "QL003").count();
            left += found.iter().filter(|f| f.code != "QL003").count();
            continue;
        }
        if lossy.contains(path.as_str()) {
            left += policy.lint(source, path, workspace)?.len();
            continue;
        }
        let mut text = source.clone();
        let mut here = 0;
        let mut found = policy.lint(&text, path, workspace)?;
        for _ in 0..PASSES {
            let mut lines = std::collections::HashSet::new();
            // A stale noqa (QL003) is removed, never suppressed: naming it in
            // the comment it complains about would only hide the comment.
            let mut edits: Vec<_> = found
                .iter()
                .zip(suppressions_for(&found, &text))
                .filter(|(f, _)| f.code != "QL003")
                .filter_map(|(f, edit)| edit.filter(|_| lines.insert(f.line)))
                .collect();
            if edits.is_empty() {
                break;
            }
            // Each on a line of its own, applied from the end so the earlier
            // offsets hold.
            edits.sort_by_key(|e| std::cmp::Reverse(e.start));
            for e in &edits {
                text.replace_range(e.start..e.end, &e.replacement);
            }
            here += edits.len();
            found = policy.lint(&text, path, workspace)?;
        }
        stale += found.iter().filter(|f| f.code == "QL003").count();
        left += found.iter().filter(|f| f.code != "QL003").count();
        if here == 0 {
            written.insert(file, source.clone());
            continue;
        }
        if let Err(e) = fs::write(disk, &text) {
            eprintln!("qlinter: {path}: {e}, not changed");
            failed = true;
            written.insert(file, source.clone());
            continue;
        }
        *source = text;
        written.insert(file, source.clone());
        added += here;
        changed += 1;
    }
    eprintln!("qlinter: added {added} noqa directive(s) in {changed} file(s)");
    if left > 0 {
        eprintln!(
            "qlinter: {left} finding(s) left: on a line no comment can follow, such as one inside a string or a block comment, or in a file whose brackets do not close"
        );
    }
    if stale > 0 {
        eprintln!(
            "qlinter: {stale} noqa directive(s) suppress nothing (QL003): remove them with --fix --unsafe-fixes"
        );
    }
    Ok(if failed {
        2
    } else {
        u8::from(left + stale > 0)
    })
}

/// `bytes` as text, each byte that is not UTF-8 read as one replacement
/// character, so every column after it stays where it was.
/// `String::from_utf8_lossy` replaces a whole truncated sequence - `E2 82` -
/// with one, which moves the rest of the line one column early.
fn lossy_text(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len());
    for chunk in bytes.utf8_chunks() {
        text.push_str(chunk.valid());
        text.extend(std::iter::repeat_n('\u{FFFD}', chunk.invalid().len()));
    }
    text
}

/// `qlinter analyze graph`: the dependency graph of the q files under the
/// paths given, as JSON with sorted keys, so two runs over one tree print the
/// same bytes. Reads every file and runs none.
fn analyze_graph(args: GraphArgs) -> Result<u8, String> {
    let cwd = config::absolute(&std::env::current_dir().map_err(|e| e.to_string())?);
    let overrides = Overrides {
        profile: None,
        default_profile: "uqf",
        layer: Layer::default(),
        exclude: args
            .exclude
            .iter()
            .map(|p| config::excluding(&cwd, p))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("--exclude: {e}"))?,
        config: None,
        isolated: false,
        target: None,
        baseline: None,
        no_baseline: true,
    };
    let policy = Policy::new(overrides, false);
    let paths = if args.paths.is_empty() {
        vec![".".into()]
    } else {
        args.paths
    };
    let mut sources = vec![];
    let (files, mut failed) = discover(paths, &policy, args.force_exclude)?;
    for path in files {
        // As when linting: a file that is not UTF-8 is still q, and is read
        // with each invalid byte as one replacement character.
        match fs::read(&path) {
            Ok(bytes) => {
                let source = lossy_text(&bytes);
                sources.push((path, source));
            }
            // A file left out is an edge the graph cannot show, so the run
            // still prints what it read and ends in exit 2.
            Err(e) => {
                eprintln!("qlinter: {}: {e}, skipped", path.display());
                failed = true;
            }
        }
    }
    let graph = q_lint_rs::graph::build(&sources, args.symbols, &cwd);
    let show = |p: &Path| relative(p, &cwd);
    let mut edges: std::collections::BTreeMap<String, BTreeSet<String>> =
        graph.keys().map(|p| (show(p), BTreeSet::new())).collect();
    for (file, node) in &graph {
        for dep in &node.dependencies {
            if args.direction == "dependents" {
                edges.entry(show(dep)).or_default().insert(show(file));
            } else {
                edges.entry(show(file)).or_default().insert(show(dep));
            }
        }
    }
    let out = if args.detail {
        let mut detail = serde_json::Map::new();
        for (file, node) in &graph {
            let key = show(file);
            let ambiguous: std::collections::BTreeMap<_, Vec<_>> = node
                .ambiguous
                .iter()
                .map(|(name, defs)| (name.clone(), defs.iter().map(|d| show(d)).collect()))
                .collect();
            let mut entry = serde_json::Map::new();
            entry.insert(args.direction.clone(), serde_json::json!(edges[&key]));
            entry.insert("ambiguous".into(), serde_json::json!(ambiguous));
            entry.insert("dynamic".into(), serde_json::json!(node.dynamic));
            detail.insert(key, serde_json::Value::Object(entry));
        }
        serde_json::to_string_pretty(&detail)
    } else {
        serde_json::to_string_pretty(&edges)
    };
    out!("{}", out.map_err(|e| e.to_string())?);
    Ok(if failed { 2 } else { 0 })
}

/// `path` relative to `base`, through `..` where it lies outside it, joined
/// with `/` on every platform: the graph is data another tool reads, and a
/// key that changes with the OS that printed it is a different key.
fn relative(path: &Path, base: &Path) -> String {
    let common = path
        .components()
        .zip(base.components())
        .take_while(|(a, b)| a == b)
        .count();
    let up = base.components().skip(common).map(|_| "..".to_string());
    let down = path
        .components()
        .skip(common)
        .map(|c| c.as_os_str().to_string_lossy().into_owned());
    up.chain(down).collect::<Vec<_>>().join("/")
}

/// The path a `--diff` header names: relative to the current directory, as
/// Ruff prints it, so `patch -p1` and `git apply` find the file. An absolute
/// path behind `a/` is `a//abs/path`, which patch asks about and git refuses.
/// A relative path - a `--stdin-filename` - is already what was meant. A file
/// outside the current directory is named through `..`, which patch takes;
/// git applies nothing outside the directory it runs in, under any name.
fn diff_path(path: &str) -> String {
    let path = Path::new(path);
    match std::env::current_dir() {
        Ok(cwd) if path.is_absolute() => relative(path, &config::absolute(&cwd)),
        _ => path.display().to_string(),
    }
}

/// A unified diff with three lines of context, built from the edits rather
/// than by pairing lines: a fix may remove a line (a commented-out
/// definition) or join two, and pairing old and new lines by position would
/// misalign every hunk after it. Each change is the whole lines an edit
/// touches, with edits that share a line merged into one, and changes whose
/// context meets share a hunk. The context is what `git apply` checks a
/// patch against; without it, it refuses any hunk not at the start or end of
/// the file unless told `--unidiff-zero`.
fn print_diff(path: &str, before: &str, edits: &[q_lint_rs::Fix]) {
    const CONTEXT: usize = 3;
    // A name with a space in it ends in a TAB, as git and diffutils write
    // it: patch otherwise cuts the name at the space.
    let tab = if path.contains(' ') { "\t" } else { "" };
    out!("--- a/{path}{tab}\n+++ b/{path}{tab}");
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
    // The byte range of whole lines a change replaces, and its edits.
    type Change<'a> = (usize, usize, Vec<&'a q_lint_rs::Fix>);
    let mut changes: Vec<Change> = vec![];
    for edit in edits {
        let from = line_start(edit.start);
        let mut to = line_end(if edit.end > edit.start {
            edit.end - 1
        } else {
            edit.start
        });
        // An edit that removes a newline but leaves text before it on the
        // line joins that text to the next line, which the change must then
        // take in - or the new side ends mid-line, as if at end of file.
        let kept = (edit.start > from || !edit.replacement.is_empty())
            && !edit.replacement.ends_with('\n');
        if kept && edit.end > edit.start && bytes[edit.end - 1] == b'\n' && to < before.len() {
            to = line_end(to);
        }
        match changes.last_mut() {
            Some(last) if from < last.1 => {
                last.1 = last.1.max(to);
                last.2.push(edit);
            }
            _ => changes.push((from, to, vec![edit])),
        }
    }
    // Both ends of a change are line starts, or the end of the text.
    let back = |mut at: usize| {
        for _ in 0..CONTEXT {
            if at > 0 {
                at = line_start(at - 1);
            }
        }
        at
    };
    let forward = |mut at: usize| {
        for _ in 0..CONTEXT {
            if at < before.len() {
                at = line_end(at);
            }
        }
        at
    };
    let mut hunks: Vec<(usize, usize, Vec<Change>)> = vec![];
    for change in changes {
        let (from, to) = (back(change.0), forward(change.1));
        match hunks.last_mut() {
            Some(last) if from <= last.1 => {
                last.1 = to;
                last.2.push(change);
            }
            _ => hunks.push((from, to, vec![change])),
        }
    }
    let lines = |text: &str| text.split_inclusive('\n').count();
    // The file's last line may have no newline, which `patch` needs told.
    let show = |body: &mut String, sign: char, text: &str| {
        for line in text.split_inclusive('\n') {
            body.push(sign);
            body.push_str(line.trim_end_matches('\n'));
            body.push('\n');
            if !line.ends_with('\n') {
                body.push_str("\\ No newline at end of file\n");
            }
        }
    };
    let mut shift = 0isize;
    for (from, to, group) in hunks {
        let mut body = String::new();
        let (mut at, mut new_n) = (from, 0);
        for (start, end, fixes) in group {
            let mut new = String::new();
            let mut cursor = start;
            for edit in fixes {
                new.push_str(&before[cursor..edit.start]);
                new.push_str(&edit.replacement);
                cursor = edit.end;
            }
            new.push_str(&before[cursor..end]);
            show(&mut body, ' ', &before[at..start]);
            // The lines the change leaves alone are context, not a line
            // removed and written back: nested or multi-pass fixes make one
            // change of a span with untouched lines inside it (#518, #671).
            for (sign, line) in line_diff(&before[start..end], &new) {
                show(&mut body, sign, line);
            }
            new_n += lines(&before[at..start]) + lines(&new);
            at = end;
        }
        show(&mut body, ' ', &before[at..to]);
        new_n += lines(&before[at..to]);
        let old_n = lines(&before[from..to]);
        let first = before[..from].matches('\n').count() + 1;
        // A side with no lines names the line before it, as diff does.
        let old_at = if old_n == 0 { first - 1 } else { first };
        let new_first = (first as isize + shift) as usize;
        let new_at = if new_n == 0 { new_first - 1 } else { new_first };
        emit(
            format_args!("@@ -{old_at},{old_n} +{new_at},{new_n} @@\n{body}"),
            false,
        );
        shift += new_n as isize - old_n as isize;
    }
}
/// The lines of `old` and `new` as a diff: each with ' ' where both have
/// it, '-' where only `old` does and '+' where only `new` does - a shortest
/// edit script, as diff finds it (Myers). Past `LIMIT` differing lines the
/// search stops and the whole of each side is the change.
fn line_diff<'a>(old: &'a str, new: &'a str) -> Vec<(char, &'a str)> {
    const LIMIT: isize = 2000;
    let a: Vec<&str> = old.split_inclusive('\n').collect();
    let b: Vec<&str> = new.split_inclusive('\n').collect();
    let (n, m) = (a.len() as isize, b.len() as isize);
    // For each edit count d, the furthest x reached on each diagonal
    // k = x - y, at index k + d of that step's row.
    let mut trace: Vec<Vec<isize>> = vec![];
    let ends = 'search: {
        for d in 0..=(n + m).min(LIMIT) {
            let mut row = vec![0isize; 2 * d as usize + 1];
            for k in (-d..=d).step_by(2) {
                let prev = |k: isize| trace[d as usize - 1][(k + d - 1) as usize];
                let mut x = if d == 0 {
                    0
                } else if k == -d || (k != d && prev(k - 1) < prev(k + 1)) {
                    prev(k + 1)
                } else {
                    prev(k - 1) + 1
                };
                let mut y = x - k;
                while x < n && y < m && a[x as usize] == b[y as usize] {
                    x += 1;
                    y += 1;
                }
                row[(k + d) as usize] = x;
                if x >= n && y >= m {
                    trace.push(row);
                    break 'search true;
                }
            }
            trace.push(row);
        }
        false
    };
    if !ends {
        return a
            .iter()
            .map(|l| ('-', *l))
            .chain(b.iter().map(|l| ('+', *l)))
            .collect();
    }
    // Back from the end: each step's edit, and the common lines after it.
    let mut out = vec![];
    let (mut x, mut y) = (n, m);
    for d in (1..trace.len() as isize).rev() {
        let k = x - y;
        let prev = |k: isize| trace[d as usize - 1][(k + d - 1) as usize];
        let down = k == -d || (k != d && prev(k - 1) < prev(k + 1));
        let (px, pk) = if down {
            (prev(k + 1), k + 1)
        } else {
            (prev(k - 1), k - 1)
        };
        let mid = if down { px } else { px + 1 };
        while x > mid {
            x -= 1;
            y -= 1;
            out.push((' ', a[x as usize]));
        }
        if down {
            y -= 1;
            out.push(('+', b[y as usize]));
        } else {
            x -= 1;
            out.push(('-', a[x as usize]));
        }
        debug_assert_eq!((x, y), (px, px - pk));
    }
    while x > 0 {
        x -= 1;
        out.push((' ', a[x as usize]));
    }
    out.reverse();
    out
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(code) => {
            // A report with nothing in it is still a report: the file is made.
            output();
            ExitCode::from(code)
        }
        Err(error) => {
            eprintln!("qlinter: {error}");
            ExitCode::from(2)
        }
    }
}

/// `--color auto`: a terminal, unless `NO_COLOR` holds something - an empty
/// `NO_COLOR=` does not turn colour off (#426).
fn auto_colour(terminal: bool, no_color: Option<&std::ffi::OsStr>) -> bool {
    terminal && no_color.is_none_or(|v| v.is_empty())
}

/// ANSI colour for the text output, or none.
///
/// Off unless stdout is a terminal, off whenever `NO_COLOR` is set to a
/// nonempty value (https://no-color.org: "when present and not an empty
/// string"), and overridable either way by `--color`. A pipe
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
            // A file is never a terminal, whatever stdout is.
            _ => auto_colour(
                std::io::stdout().is_terminal() && OUTPUT_PATH.get().is_none(),
                std::env::var_os("NO_COLOR").as_deref(),
            ),
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

#[cfg(test)]
mod tests {
    use super::{auto_colour, line_diff};
    use std::ffi::OsStr;

    #[test]
    fn a_line_diff_rebuilds_both_sides_and_keeps_what_they_share() {
        for (old, new, kept) in [
            ("a\nb\nc\n", "a\nB\nc\n", 2),
            ("a\nb\nc\nd\n", "A\nb\nc\nD\n", 2),
            ("a\nb\n", "a\nx\ny\nb\n", 2),
            ("a\nb\nc\n", "a\nc\n", 2),
            ("", "a\n", 0),
            ("a\n", "", 0),
            ("a\nb", "a\nb\n", 1),
            ("x\n", "y\n", 0),
        ] {
            let ops = line_diff(old, new);
            let side = |skip: char| -> String {
                ops.iter()
                    .filter(|(s, _)| *s != skip)
                    .map(|(_, l)| *l)
                    .collect()
            };
            assert_eq!(side('+'), old, "{old:?} -> {new:?}");
            assert_eq!(side('-'), new, "{old:?} -> {new:?}");
            let shared = ops.iter().filter(|(s, _)| *s == ' ').count();
            assert_eq!(shared, kept, "{old:?} -> {new:?}: {ops:?}");
        }
    }

    #[test]
    fn an_empty_no_color_leaves_colour_on() {
        assert!(auto_colour(true, None));
        assert!(auto_colour(true, Some(OsStr::new(""))));
        assert!(!auto_colour(true, Some(OsStr::new("1"))));
        assert!(!auto_colour(false, None));
    }
}
