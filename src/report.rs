//! The reports a run prints besides text and JSON: SARIF for code scanning
//! (`--format sarif`), GitHub workflow commands (`--format github`), and the
//! per-rule tally `--statistics` prints instead of the findings.
//!
//! Every path is relative to the directory qlinter runs in, with `/`, the
//! way a CI job that runs it from the repository root names files.
use crate::baseline;
use q_lint_rs::{Finding, RULES, rule_url};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

/// `path` relative to `cwd`, with `/`; absolute where it is not under it.
fn shown(cwd: &Path, path: &str) -> String {
    baseline::relative(cwd, Path::new(path))
}

/// FNV-1a, 64 bits: a hash whose value is fixed by its definition, so a
/// fingerprint is the same from every build. `std`'s hasher promises no
/// such thing across releases.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// A relative path as a URI reference: each byte outside RFC 3986's
/// unreserved set and `/` percent-encoded, so a space or a `#` in a file
/// name stays part of the path.
fn uri(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn level(severity: &str) -> &'static str {
    match severity {
        "error" => "error",
        "warning" => "warning",
        _ => "note",
    }
}

/// SARIF 2.1.0: one run, the rules its results name, and one result per
/// finding. A result's fingerprint is the baseline's key for it - its file,
/// its code and the text of its line, blanks trimmed - hashed, with the
/// ordinal of findings sharing that key after it: like a baseline entry it
/// survives lines moving above it and changes when its own line does.
pub fn sarif(findings: &[Finding], sources: &[(String, String)], cwd: &Path) -> Value {
    let text_of: HashMap<&str, &str> = sources
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect();
    // Every code a result names, in code order, each with its index.
    let mut codes: BTreeMap<&str, &Finding> = BTreeMap::new();
    for f in findings {
        codes.entry(f.code.as_str()).or_insert(f);
    }
    let index: HashMap<&str, usize> = codes.keys().enumerate().map(|(i, c)| (*c, i)).collect();
    let rules: Vec<Value> = codes
        .values()
        .map(|f| {
            let summary = RULES
                .iter()
                .find(|r| r.code == f.code)
                .map_or(f.why.as_str(), |r| r.summary.as_str());
            let mut rule = json!({
                "id": f.code,
                "name": f.rule,
                "shortDescription": {"text": summary},
                "defaultConfiguration": {"level": level(&f.severity)},
            });
            if let Some(url) = rule_url(&f.code) {
                rule["helpUri"] = json!(url);
            }
            rule
        })
        .collect();
    let mut seen: HashMap<u64, usize> = HashMap::new();
    let results: Vec<Value> = findings
        .iter()
        .map(|f| {
            let path = shown(cwd, &f.path);
            let source = text_of.get(f.path.as_str()).copied().unwrap_or("");
            let key = format!(
                "{path}\0{}\0{}",
                f.code,
                baseline::line_text(source, f.line)
            );
            let hash = fnv1a(&key);
            let n = seen.entry(hash).or_insert(0);
            *n += 1;
            let mut region = json!({"startLine": f.line.max(1)});
            if let Some(c) = f.column {
                region["startColumn"] = json!(c.max(1));
            }
            if let Some(l) = f.end_line {
                region["endLine"] = json!(l.max(f.line.max(1)));
            }
            if let Some(c) = f.end_column {
                region["endColumn"] = json!(c.max(1));
            }
            json!({
                "ruleId": f.code,
                "ruleIndex": index[f.code.as_str()],
                "level": level(&f.severity),
                "message": {"text": f.detail},
                "locations": [{"physicalLocation": {
                    "artifactLocation": {"uri": uri(&path)},
                    "region": region,
                }}],
                "partialFingerprints": {"qlinterBaseline/v1": format!("{hash:016x}:{n}")},
            })
        })
        .collect();
    json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {"driver": {
                "name": "qlinter",
                "version": env!("CARGO_PKG_VERSION"),
                "informationUri": "https://github.com/kwojdalski/q-lint",
                "rules": rules,
            }},
            "results": results,
        }],
    })
}
