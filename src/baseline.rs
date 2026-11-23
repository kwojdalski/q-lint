//! A lint baseline: the findings a tree has today, written to a file, so a
//! later run - `qlinter --baseline FILE`, or any run under a configuration
//! that names `baseline = "FILE"`, the language server's too - reports only
//! the findings that are not in it.
//!
//! A finding is matched on its file, its code and the text of its line with
//! the blanks at either end trimmed, not on its line number: lines added or
//! removed above it, or the line moved, leave it matched. Several findings
//! of one code on lines of the same text are counted, and as many of them
//! as the baseline counted are passed over, the first ones in the file; one
//! more is new. A finding whose line is edited is new, which is the point.
//!
//! ```json
//! {"qlinter-baseline": 1,
//!  "findings": [{"path": "src/a.q", "code": "QS001", "line": "f:{x+1}", "count": 1}]}
//! ```
//!
//! Paths are relative to the baseline file's directory, with `/`, so the
//! file means the same in every checkout.
use q_lint_rs::Finding;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

/// One baseline file, read.
#[derive(Debug, Default)]
pub struct Baseline {
    /// Its directory, which its paths are relative to.
    root: PathBuf,
    /// (path, code, line text) -> how many findings it holds.
    counts: HashMap<(String, String, String), usize>,
}

/// The text a finding is matched on: its line, blanks trimmed.
pub(crate) fn line_text(source: &str, line: usize) -> String {
    source
        .lines()
        .nth(line.saturating_sub(1))
        .unwrap_or("")
        .trim()
        .to_string()
}

/// `path` relative to `root`, with `/`; as it is where it is not under it.
pub(crate) fn relative(root: &Path, path: &Path) -> String {
    let full = crate::config::absolute(path);
    full.strip_prefix(root)
        .unwrap_or(&full)
        .to_string_lossy()
        .replace('\\', "/")
}

impl Baseline {
    pub fn read(file: &Path) -> Result<Baseline, String> {
        let shown = file.display();
        let text = fs::read_to_string(file).map_err(|e| format!("baseline {shown}: {e}"))?;
        let data: Value =
            serde_json::from_str(&text).map_err(|e| format!("baseline {shown}: {e}"))?;
        if data["qlinter-baseline"] != 1 {
            return Err(format!(
                "baseline {shown}: not a qlinter baseline (no \"qlinter-baseline\": 1)"
            ));
        }
        let mut counts = HashMap::new();
        for f in data["findings"].as_array().into_iter().flatten() {
            let (Some(path), Some(code), Some(line)) =
                (f["path"].as_str(), f["code"].as_str(), f["line"].as_str())
            else {
                return Err(format!(
                    "baseline {shown}: each finding needs path, code and line"
                ));
            };
            let n = f["count"].as_u64().unwrap_or(1) as usize;
            *counts
                .entry((path.to_string(), code.to_string(), line.to_string()))
                .or_insert(0) += n;
        }
        let root = crate::config::absolute(file)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        Ok(Baseline { root, counts })
    }

    /// `findings` of one file, `source`, without those the baseline holds.
    /// Returns what was passed over, for a run to say so.
    pub fn filter(&self, path: &str, source: &str, findings: &mut Vec<Finding>) -> usize {
        if self.counts.is_empty() {
            return 0;
        }
        let rel = relative(&self.root, Path::new(path));
        let mut used: HashMap<(String, String), usize> = HashMap::new();
        let before = findings.len();
        // In line order, so the first ones are the ones passed over.
        let mut order: Vec<usize> = (0..findings.len()).collect();
        order.sort_by_key(|&i| (findings[i].line, findings[i].column));
        let mut keep = vec![true; findings.len()];
        for i in order {
            let f = &findings[i];
            let text = line_text(source, f.line);
            let known = self
                .counts
                .get(&(rel.clone(), f.code.clone(), text.clone()))
                .copied()
                .unwrap_or(0);
            let n = used.entry((f.code.clone(), text)).or_insert(0);
            if *n < known {
                *n += 1;
                keep[i] = false;
            }
        }
        let mut k = keep.into_iter();
        findings.retain(|_| k.next().unwrap_or(true));
        before - findings.len()
    }
}

/// The baseline of `findings` as the file `file` will hold it: findings
/// grouped and counted, in path, code and text order, so writing it twice
/// over the same tree gives the same bytes.
pub fn render(file: &Path, findings: &[Finding], sources: &[(String, String)]) -> String {
    let root = crate::config::absolute(file)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let text_of: HashMap<&str, &str> = sources
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect();
    let mut counts: BTreeMap<(String, String, String), usize> = BTreeMap::new();
    for f in findings {
        let source = text_of.get(f.path.as_str()).copied().unwrap_or("");
        let key = (
            relative(&root, Path::new(&f.path)),
            f.code.clone(),
            line_text(source, f.line),
        );
        *counts.entry(key).or_insert(0) += 1;
    }
    let rows: Vec<Value> = counts
        .into_iter()
        .map(|((path, code, line), count)| {
            json!({"path": path, "code": code, "line": line, "count": count})
        })
        .collect();
    let mut out = String::from("{\"qlinter-baseline\": 1, \"findings\": [\n");
    let lines: Vec<String> = rows.iter().map(|r| format!("  {r}")).collect();
    out.push_str(&lines.join(",\n"));
    out.push_str("\n]}\n");
    out
}
