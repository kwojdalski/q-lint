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

/// A path, with `/`, as the path of a URI: each byte outside RFC 3986's
/// unreserved set and `/` percent-encoded, so a space, a `#` or a character
/// past ASCII (as its UTF-8 bytes) stays part of the path.
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

/// The `file:` URI (RFC 8089) of an absolute path with `/`: `/a/b.q` is
/// `file:///a/b.q`, a Windows drive's `C:/a/b.q` is `file:///C:/a/b.q`, its
/// drive letter and colon as they are, and a share's `//host/share/b.q` is
/// `file://host/share/b.q`. Windows writes a canonical path behind `\\?\`,
/// which says nothing about the file and is no part of its URI.
fn file_uri(path: &str) -> String {
    let path = path.strip_prefix("//?/").map_or(path.to_string(), |rest| {
        rest.strip_prefix("UNC/")
            .map_or(rest.to_string(), |share| format!("//{share}"))
    });
    if let Some(share) = path.strip_prefix("//") {
        let (host, rest) = share.split_once('/').unwrap_or((share, ""));
        return format!("file://{}/{}", uri(host), uri(rest));
    }
    let b = path.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return format!("file:///{}{}", &path[..2], uri(&path[2..]));
    }
    format!("file://{}", uri(&path))
}

/// Where SARIF says a finding's file is (2.1.0, 3.4): a path under the
/// directory qlinter runs in as a relative reference against `%SRCROOT%`,
/// which the run's `originalUriBaseIds` says is that directory, and any
/// other as its absolute `file:` URI. A bare absolute path is a reference a
/// consumer resolves against a base of its own, not the file (#2098).
fn artifact_location(path: &str) -> Value {
    let b = path.as_bytes();
    let absolute =
        path.starts_with('/') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':');
    if absolute {
        json!({"uri": file_uri(path)})
    } else {
        json!({"uri": uri(path), "uriBaseId": "%SRCROOT%"})
    }
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
    let text_of: HashMap<&str, baseline::SourceLines> = sources
        .iter()
        .map(|(p, s)| (p.as_str(), baseline::SourceLines::new(s)))
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
            let text = text_of
                .get(f.path.as_str())
                .map_or_else(String::new, |lines| lines.text(f.line));
            let key = format!("{path}\0{}\0{text}", f.code);
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
                    "artifactLocation": artifact_location(&path),
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
            // The base the relative locations are read against: the
            // directory qlinter ran in, as a directory's URI ends, in `/`.
            "originalUriBaseIds": {"%SRCROOT%": {"uri": format!(
                "{}/",
                file_uri(&baseline::slashed(cwd)).trim_end_matches('/')
            )}},
            // SARIF 2.1.0 requires it once there are results: a finding's
            // columns count UTF-16 units, as an editor's do.
            "columnKind": "utf16CodeUnits",
        }],
    })
}

/// A workflow command's message, escaped as the Actions runner reads it:
/// `%`, CR and LF.
fn command_data(text: &str) -> String {
    text.replace('%', "%25")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

/// A workflow command's property value: its data escaping, and `:` and `,`,
/// which would otherwise end the value.
fn command_property(text: &str) -> String {
    command_data(text).replace(':', "%3A").replace(',', "%2C")
}

/// One GitHub Actions workflow command per finding - `::error`,
/// `::warning` or `::notice` - which a run shows as an annotation on the
/// line it names.
pub fn github(f: &Finding, cwd: &Path) -> String {
    let kind = match f.severity.as_str() {
        "error" => "error",
        "warning" => "warning",
        _ => "notice",
    };
    let mut props = format!(
        "file={},line={}",
        command_property(&shown(cwd, &f.path)),
        f.line
    );
    if let Some(c) = f.column {
        props.push_str(&format!(",col={c}"));
    }
    if let Some(l) = f.end_line {
        props.push_str(&format!(",endLine={l}"));
    }
    if let Some(c) = f.end_column {
        props.push_str(&format!(",endColumn={c}"));
    }
    format!(
        "::{kind} {props},title={}::{}",
        command_property(&f.code),
        command_data(&f.detail)
    )
}

/// `--statistics`: each code with its count and its rule's summary, the
/// most frequent first and ties in code order.
pub fn statistics(findings: &[Finding]) -> Vec<(String, usize, String)> {
    let mut counts: BTreeMap<&str, (usize, &Finding)> = BTreeMap::new();
    for f in findings {
        counts.entry(f.code.as_str()).or_insert((0, f)).0 += 1;
    }
    let mut rows: Vec<_> = counts
        .into_iter()
        .map(|(code, (n, f))| {
            let summary = RULES
                .iter()
                .find(|r| r.code == code)
                .map_or(f.why.as_str(), |r| r.summary.as_str());
            (code.to_string(), n, summary.to_string())
        })
        .collect();
    // Stable, so codes that tie stay in the map's code order.
    rows.sort_by_key(|r| std::cmp::Reverse(r.1));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(path: &str, detail: &str) -> Finding {
        Finding {
            path: path.into(),
            line: 3,
            rule: "r".into(),
            detail: detail.into(),
            why: String::new(),
            source: "q-lint".into(),
            severity: "warning".into(),
            column: Some(2),
            end_line: Some(3),
            end_column: Some(5),
            code: "QS001".into(),
            category: "style".into(),
        }
    }

    #[test]
    fn sarif_and_baselines_are_linear_in_findings() {
        // Each finding's line text was found by walking its file from the
        // top, for SARIF's fingerprints, --write-baseline and --baseline
        // alike: 9 s for 40,000 findings (#2338).
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("b.json");
        let path = dir.path().join("a.q").to_string_lossy().into_owned();
        let time = |n: usize| {
            let source: String = (0..n).map(|i| format!("a{i}:\"x\"=`y\n")).collect();
            let findings: Vec<Finding> = (1..=n)
                .map(|line| Finding {
                    line,
                    ..finding(&path, "d")
                })
                .collect();
            let sources = vec![(path.clone(), source.clone())];
            std::fs::write(&file, baseline::render(&file, &findings, &sources)).unwrap();
            let known = baseline::Baseline::read(&file).unwrap();
            let mut all = findings.clone();
            assert_eq!(known.filter(&path, &source, &mut all), n);
            (0..3)
                .map(|_| {
                    let started = std::time::Instant::now();
                    std::hint::black_box(sarif(&findings, &sources, dir.path()));
                    std::hint::black_box(baseline::render(&file, &findings, &sources));
                    known.filter(&path, &source, &mut findings.clone());
                    started.elapsed()
                })
                .min()
                .unwrap()
        };
        time(1000); // warm the allocator
        let (small, large) = (time(1000), time(8000));
        // Quadratic is 64 times; linear is 8. 16 still fails a quadratic
        // walk by four times.
        assert!(
            large < small * 16,
            "1000 findings took {small:?} and 8000 {large:?}"
        );
    }

    #[test]
    fn a_workflow_command_escapes_its_properties_and_its_message() {
        let cwd = Path::new("/r");
        let f = finding("/r/a:b,c%.q", "100% sure:\r\nnext, line");
        assert_eq!(
            github(&f, cwd),
            "::warning file=a%3Ab%2Cc%25.q,line=3,col=2,endLine=3,endColumn=5,title=QS001\
             ::100%25 sure:%0D%0Anext, line"
        );
        let mut error = finding("/r/a.q", "x");
        error.severity = "error".into();
        (error.column, error.end_line, error.end_column) = (None, None, None);
        assert_eq!(
            github(&error, cwd),
            "::error file=a.q,line=3,title=QS001::x"
        );
        error.severity = "info".into();
        assert!(github(&error, cwd).starts_with("::notice "));
    }

    #[test]
    fn a_uri_keeps_its_path_and_encodes_the_rest() {
        assert_eq!(uri("src/a b#1.q"), "src/a%20b%231.q");
    }

    /// A URI path's bytes, percent-decoded.
    fn decoded(path: &str) -> String {
        let b = path.as_bytes();
        let (mut out, mut i) = (vec![], 0);
        while i < b.len() {
            if b[i] == b'%' {
                out.push(u8::from_str_radix(&path[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }

    /// SARIF 2.1.0 (3.4) reads `artifactLocation.uri` as a URI reference:
    /// an absolute path is a `file:` URI, a relative one is resolved
    /// against its `uriBaseId`. Each produced here is parsed by an RFC 3986
    /// parser and read back to the path it names (#2098).
    #[test]
    fn a_sarif_location_is_a_uri_that_names_its_file() {
        use iri_string::types::{UriAbsoluteStr, UriReferenceStr, UriStr};
        for (path, host, file_path) in [
            ("/private/tmp/w/c.q", "", "/private/tmp/w/c.q"),
            ("C:/x/a.q", "", "/C:/x/a.q"),
            ("//?/C:/x/a.q", "", "/C:/x/a.q"),
            ("//server/share/a.q", "server", "/share/a.q"),
            ("//?/UNC/server/share/a.q", "server", "/share/a.q"),
            ("/tmp/my dir/zażółć #1.q", "", "/tmp/my dir/zażółć #1.q"),
            ("D:/Program Files/é.q", "", "/D:/Program Files/é.q"),
        ] {
            let loc = artifact_location(path);
            assert_eq!(loc.get("uriBaseId"), None, "{path}");
            let text = loc["uri"].as_str().unwrap();
            let parsed = UriStr::new(text).unwrap_or_else(|e| panic!("{text}: {e}"));
            assert_eq!(parsed.scheme_str(), "file", "{text}");
            assert_eq!(parsed.authority_str(), Some(host), "{text}");
            assert_eq!(decoded(parsed.path_str()), file_path, "{text}");
            assert_eq!(parsed.query(), None, "{text}");
            assert_eq!(parsed.fragment(), None, "{text}");
        }
        // A relative one names its file once read against the run's base.
        let base = format!("{}/", file_uri("/tmp/my dir"));
        let base = UriAbsoluteStr::new(&base).unwrap();
        for (path, full) in [
            ("src/a.q", "/tmp/my dir/src/a.q"),
            ("a b/zażółć #1.q", "/tmp/my dir/a b/zażółć #1.q"),
        ] {
            let loc = artifact_location(path);
            assert_eq!(loc["uriBaseId"], "%SRCROOT%");
            let reference = UriReferenceStr::new(loc["uri"].as_str().unwrap()).unwrap();
            assert!(reference.scheme_str().is_none(), "{path}");
            let resolved = reference.resolve_against(base).to_string();
            let resolved = UriStr::new(&resolved).unwrap();
            assert_eq!(decoded(resolved.path_str()), full);
        }
    }
}
