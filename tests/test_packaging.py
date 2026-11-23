"""What ships around the binary - its Cargo metadata, the CI that builds it
and the files other tools read to run it - says what the sources say. Each
of these is read by something this repository never runs (crates.io, a
GitHub runner, pre-commit), so a test here is the only place a typo shows."""

import json
import re
import subprocess
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[1]


def workflow(name):
    return yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text())


def steps(job):
    return [s.get("run", "") or s.get("uses", "") for s in job["steps"]]


def test_cargo_metadata_declares_the_package():
    out = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--no-deps", "--offline"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    [package] = json.loads(out)["packages"]
    assert package["license"] == "MIT"
    assert (ROOT / "LICENSE").read_text().startswith("MIT License")
    assert package["repository"] == "https://github.com/kwojdalski/q-lint"
    assert package["description"]
    assert package["keywords"]
    assert re.fullmatch(r"\d+\.\d+", package["rust_version"])


def test_ci_builds_with_the_declared_msrv():
    declared = re.search(r'(?m)^rust-version = "([^"]+)"', (ROOT / "Cargo.toml").read_text())[1]
    job = workflow("ci.yml")["jobs"]["msrv"]
    [toolchain] = [s for s in job["steps"] if s.get("uses", "").startswith("dtolnay/rust-toolchain")]
    assert str(toolchain["with"]["toolchain"]) == declared
    assert "cargo build --locked --all-targets" in steps(job)


def hooks():
    return {h["id"]: h for h in yaml.safe_load((ROOT / ".pre-commit-hooks.yaml").read_text())}


def test_the_pre_commit_hooks_lint_q_and_only_q():
    found = hooks()
    assert set(found) == {"qlinter", "qlinter-system"}
    assert found["qlinter"]["language"] == "rust"
    assert found["qlinter-system"]["language"] == "system"
    for hook in found.values():
        assert hook["entry"] == "qlinter --force-exclude"
        files = re.compile(hook["files"])
        assert files.search("src/a.q") and files.search("deep/dir/b.q")
        assert not files.search("a.k") and not files.search("a.qs") and not files.search("q/readme.md")


def test_the_readme_pre_commit_example_names_a_real_hook():
    readme = (ROOT / "README.md").read_text()
    [example] = re.findall(r"```yaml\n(repos:.*?)```", readme, re.S)
    [repo] = yaml.safe_load(example)["repos"]
    assert repo["repo"] == "https://github.com/kwojdalski/q-lint"
    assert {h["id"] for h in repo["hooks"]} <= set(hooks())


def test_the_release_publishes_sha256sums_beside_the_nine_assets():
    [publish] = [s["run"] for s in workflow("release.yml")["jobs"]["release"]["steps"] if s.get("name") == "Publish"]
    assert "sha256sum" in publish and "> SHA256SUMS" in publish
    assert '-eq 9' in publish
    assert re.search(r"\$\(cat assets\) SHA256SUMS\s*$", publish)


def action():
    return yaml.safe_load((ROOT / "action.yml").read_text())


def test_the_action_downloads_a_pinned_release_and_lints_with_its_format():
    found = action()
    assert found["inputs"]["version"]["required"] is True
    assert found["inputs"]["format"]["default"] == "github"
    assert found["runs"]["using"] == "composite"
    download, lint = found["runs"]["steps"]
    # Each platform the release builds an archive for, by the name it has.
    release = (ROOT / ".github" / "workflows" / "release.yml").read_text()
    for target in re.findall(r"target: (\S+) \}", release):
        if "-" in target:
            assert target in download["run"], target
    assert "releases/download/${ver}" in download["run"]
    assert "SHA256SUMS" in download["run"]
    assert "GITHUB_PATH" in download["run"]
    assert 'qlinter --format "$FORMAT"' in lint["run"]
    # Inputs reach the shell through the environment, never spliced into it.
    for step in (download, lint):
        assert "${{" not in step["run"]


def test_ci_runs_the_action_from_the_checkout():
    job = workflow("ci.yml")["jobs"]["action"]
    runs = [s for s in job["steps"] if s.get("uses") == "./"]
    assert len(runs) == 2
    assert any(s.get("id") == "examples" and s["with"]["paths"] == "examples" for s in runs)
    assert all(s["with"]["version"] for s in runs)


def test_ci_packages_the_vsix_and_the_wheel_and_keeps_them():
    jobs = workflow("ci.yml")["jobs"]
    for job, build in [("extension", "@vscode/vsce package"), ("wheel", "python -m build --wheel")]:
        ran = steps(jobs[job])
        assert any(build in s for s in ran), job
        assert "actions/upload-artifact@v4" in ran, job
        [upload] = [s for s in jobs[job]["steps"] if s.get("uses") == "actions/upload-artifact@v4"]
        assert upload["with"]["if-no-files-found"] == "error", job


def test_ci_checks_invariance_over_the_q_in_this_tree():
    ran = steps(workflow("ci.yml")["jobs"]["rust"])
    [check] = [s for s in ran if "check_invariance.py" in s]
    assert check.split()[-3:] == ["examples", "tests/corpus", "tests/cases"]
    assert ran.index("cargo build --release") < ran.index(check)


def test_ci_runs_the_never_panic_sweep_in_release():
    ran = steps(workflow("ci.yml")["jobs"]["rust"])
    assert "cargo test --release --test never_panic -- --ignored" in ran
