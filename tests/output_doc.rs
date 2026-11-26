//! `docs/output.md` lists every key of a JSON finding and of a `--statistics`
//! row. A field added to `Finding`, renamed or dropped changes what every
//! consumer of `--format json` reads, so the list is checked against what the
//! serialiser and the CLI actually write, in order.
use q_lint_rs::{Profile, lint};
use std::process::Command;

/// The first column of the table under the `<!-- {marker}: ... -->` line.
fn documented(marker: &str) -> Vec<String> {
    let doc = include_str!("../docs/output.md").replace("\r\n", "\n");
    let start = doc
        .find(&format!("<!-- {marker}:"))
        .unwrap_or_else(|| panic!("docs/output.md lost its {marker} table"));
    doc[start..]
        .lines()
        .skip(3) // the marker, the header and the rule under it
        .take_while(|line| line.starts_with('|'))
        .map(|line| {
            let field = line.split('|').nth(1).unwrap().trim();
            field.trim_matches('`').to_string()
        })
        .collect()
}

/// An object's keys in the order the text writes them: `serde_json::Value`
/// sorts them, since this crate does not enable `preserve_order`.
fn keys_in_order(text: &str) -> Vec<String> {
    struct Keys;
    impl<'de> serde::de::Visitor<'de> for Keys {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("an object")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut keys = vec![];
            while let Some(key) = map.next_key::<String>()? {
                map.next_value::<serde::de::IgnoredAny>()?;
                keys.push(key);
            }
            Ok(keys)
        }
    }
    serde::Deserializer::deserialize_map(&mut serde_json::Deserializer::from_str(text), Keys)
        .unwrap()
}

#[test]
fn every_finding_field_is_documented_in_order() {
    let [finding] = &lint("f:{[count] count+1}\n", "a.q", Profile::General)[..] else {
        panic!("expected one finding");
    };
    let order = keys_in_order(&serde_json::to_string(finding).unwrap());
    assert_eq!(documented("finding-fields"), order);
}

#[test]
fn every_statistics_field_is_documented() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.q"), "f:{[count] count+1}\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .args(["--isolated", "--statistics", "--format", "json", "a.q"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let mut want = documented("statistics-fields");
    let mut got: Vec<String> = rows[0].as_object().unwrap().keys().cloned().collect();
    want.sort();
    got.sort();
    assert_eq!(want, got);
}

/// The exit code under `--statistics` was documented as 1 with any finding;
/// rows that count only `information` or `hint` findings exit 0, as the run
/// without `--statistics` does (#2768).
#[test]
fn statistics_exits_as_documented_when_no_finding_fails_the_run() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.q"), "f:{[count] count+1}\n").unwrap();
    let exit = |severity: &str| {
        std::fs::write(
            dir.path().join("qlinter.toml"),
            format!("[severity]\nQF001 = \"{severity}\"\n"),
        )
        .unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
            .current_dir(dir.path())
            .env("XDG_CONFIG_HOME", dir.path().join("no-such-config-home"))
            .args(["--statistics", "--format", "json", "a.q"])
            .output()
            .unwrap();
        let rows: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(rows[0]["code"], "QF001", "{severity}");
        out.status.code()
    };
    assert_eq!(
        ["error", "warning", "information", "hint"].map(exit),
        [Some(1), Some(1), Some(0), Some(0)]
    );
    let doc = include_str!("../docs/output.md").replace("\r\n", "\n");
    assert!(!doc.contains("0 with none, 1 with any"));
    assert!(
        doc.contains(
            "1 when any of them is an\n`error` or a `warning`, 0 otherwise - with none, or with rows that count only\n`information` and `hint` findings."
        ),
        "docs/output.md lost its exit code under --statistics"
    );
}

#[test]
fn every_show_settings_field_is_documented_in_order() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.q"), "a:1\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .args(["--isolated", "--show-settings", "--format", "json", "a.q"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let printed = String::from_utf8(out.stdout).unwrap();
    let one = printed
        .trim_end()
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or_else(|| panic!("{printed}"));
    assert_eq!(documented("settings-fields"), keys_in_order(one));
}

#[test]
fn the_documented_example_is_what_the_cli_prints() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.q"), "f:{[count] count+1}\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_qlinter"))
        .current_dir(dir.path())
        .args([
            "--isolated",
            "--profile",
            "general",
            "--format",
            "json",
            "a.q",
        ])
        .output()
        .unwrap();
    let printed = String::from_utf8(out.stdout).unwrap();
    let doc = include_str!("../docs/output.md").replace("\r\n", "\n");
    let example = doc
        .split("```json\n")
        .nth(1)
        .and_then(|rest| rest.split("\n```").next())
        .expect("docs/output.md lost its example");
    // The same apart from where the file is.
    let path = |s: &str| {
        let start = s.find("\"path\":\"").unwrap() + 8;
        let end = start + s[start..].find('"').unwrap();
        format!("{}{}", &s[..start], &s[end..])
    };
    assert_eq!(path(example), path(printed.trim_end()));
    // The path is the file's own, with the platform's separator.
    assert!(
        printed.contains("/a.q\"") || printed.contains("\\\\a.q\""),
        "{printed}"
    );
}
