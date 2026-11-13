#!/usr/bin/env python3
"""Keep the public q corpus current and lint it against a baseline.

`fetch_corpus.py` clones the corpus at the commits it was triaged at, and
`corpus_diff.py` compares two builds over it. Neither answers the question a
corpus raises over time: the projects move on, so what does qlinter say about
them NOW, and which of those findings has nobody looked at yet?

    python3 scripts/corpus.py status                      # pinned vs upstream, per repo
    python3 scripts/corpus.py status --peachq             # ...and projects peachq.org lists that we lack
    python3 scripts/corpus.py sync ~/q-corpus             # clone or fetch, at the pins
    python3 scripts/corpus.py sync ~/q-corpus --latest    # ...or at each upstream HEAD
    python3 scripts/corpus.py lint ~/q-corpus             # findings no one has triaged yet
    python3 scripts/corpus.py accept ~/q-corpus           # after triage: they are known now
    python3 scripts/corpus.py pin ~/q-corpus              # record the checked-out commits

Every command takes `--only PATTERN` (repeatable, a substring of `owner/repo`)
to work on a few repositories, and `lint`/`accept` take `--binary` and
`--profile` (default `general`, the profile whose findings claim q refuses
the code).

THE REPOSITORIES are `scripts/corpus.json`: one entry per repository, its
pinned commit and where it came from. `pin` rewrites it; `sync --latest`
followed by `pin` is how a repository is moved to its upstream HEAD.

THE BASELINE is `scripts/corpus-baseline.json`: every finding someone has
checked against q and found real - a defect in that project, a fixture broken
on purpose - per profile and repository. A finding is keyed on its file, its
code, its message and the TEXT of its line, not the line number, so upstream
edits elsewhere in a file do not make it new. `lint` prints what is not in
the baseline (new: triage it) and what the baseline has that no longer fires
(gone: fixed upstream or by the linter), and exits 1 when anything is new.
`accept` replaces a repository's baseline with its current findings, so run
it only once every new finding has been judged - and a false positive is
fixed in the linter, never accepted.

Each repository is linted in its own qlinter run, as `corpus_diff.py` does:
one project's globals must not define another's names. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOS_FILE = HERE / "corpus.json"
BASELINE_FILE = HERE / "corpus-baseline.json"
PEACHQ_APPS = "https://peachq.org/data/apps/apps.json"


def load_repos() -> list[dict]:
    return json.loads(REPOS_FILE.read_text())


def selected(repos: list[dict], only: list[str] | None) -> list[dict]:
    if not only:
        return repos
    chosen = [r for r in repos if any(p.lower() in r["repo"].lower() for p in only)]
    if not chosen:
        sys.exit(f"--only {' '.join(only)} matches no repository in {REPOS_FILE.name}")
    return chosen


def target(root: Path, repo: str) -> Path:
    return root / repo.replace("/", "_")


def git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def url(repo: str) -> str:
    """Where a repository is fetched from: GitHub, or a path, for tests."""
    return (
        repo
        if "://" in repo or repo.startswith("/")
        else f"https://github.com/{repo}.git"
    )


def upstream_head(repo: str) -> str:
    """The commit upstream's default branch points at, without cloning."""
    out = git("ls-remote", url(repo), "HEAD")
    return out.split()[0] if out else ""


# ------------------------------------------------------------------ status


def status(args: argparse.Namespace) -> int:
    repos = selected(load_repos(), args.only)
    moved = 0
    for r in repos:
        try:
            head = upstream_head(r["repo"])
        except subprocess.CalledProcessError as exc:
            print(f"{r['repo']:45} unreachable: {exc.stderr.strip()[:60]}")
            continue
        if head == r["commit"]:
            print(f"{r['repo']:45} {r['commit'][:8]}  current")
        else:
            moved += 1
            print(f"{r['repo']:45} {r['commit'][:8]}  upstream {head[:8]}")
    print(f"{moved} of {len(repos)} have moved upstream")
    if args.peachq:
        have = {r["repo"].lower() for r in load_repos()}
        with urllib.request.urlopen(PEACHQ_APPS, timeout=30) as response:
            apps = json.load(response)["apps"]
        listed = [
            a["repo"].split("github.com/")[1].strip("/")
            for a in apps
            if "github.com/" in a.get("repo", "")
        ]
        missing = [
            repo
            for repo in listed
            if repo.lower() not in have and repo.lower() != "kwojdalski/q-lint"
        ]
        print(
            f"peachq.org lists {len(listed)} projects; not in the corpus: {', '.join(missing) or 'none'}"
        )
    return 0


# -------------------------------------------------------------------- sync


def sync(args: argparse.Namespace) -> int:
    root = Path(args.dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    for r in selected(load_repos(), args.only):
        where = target(root, r["repo"])
        if not (where / ".git").exists():
            where.mkdir(parents=True, exist_ok=True)
            git("init", "-q", cwd=where)
            git("remote", "add", "origin", url(r["repo"]), cwd=where)
        # One commit, no history: the corpus is the files, not the project.
        ref = "HEAD" if args.latest else r["commit"]
        git("fetch", "-q", "--depth", "1", "origin", ref, cwd=where)
        git("checkout", "-q", "--detach", "FETCH_HEAD", cwd=where)
        commit = git("rev-parse", "HEAD", cwd=where)
        count = sum(1 for _ in where.rglob("*.q"))
        note = "" if commit == r["commit"] else f"  (pinned {r['commit'][:8]})"
        print(f"{r['repo']}: {count} .q files at {commit[:8]}{note}")
    return 0


# ---------------------------------------------------------------- findings


def findings(binary: str, profile: str, where: Path) -> list[dict]:
    """One repository's findings, each reduced to what identifies it."""
    run = subprocess.run(
        [binary, "--isolated", "--profile", profile, "--format", "json", str(where)],
        capture_output=True,
        text=True,
        check=False,  # findings are exit 1; the JSON is the answer either way
    )
    if not run.stdout.strip():
        return []  # no .q files, or nothing to say
    found = []
    for f in json.loads(run.stdout):
        path = Path(f["path"])
        try:
            text = path.read_text(errors="replace").splitlines()[f["line"] - 1].strip()
        except (OSError, IndexError):
            text = ""
        found.append(
            {
                "path": str(path.resolve().relative_to(where.resolve())),
                "code": f["code"],
                "detail": f["detail"],
                "text": text,
                "line": f["line"],
            }
        )
    return found


def key(f: dict) -> tuple:
    return (f["path"], f["code"], f["detail"], f["text"])


def load_baseline() -> dict:
    return json.loads(BASELINE_FILE.read_text()) if BASELINE_FILE.exists() else {}


def checked_out(root: Path, repos: list[dict]) -> list[tuple[dict, Path]]:
    present = [
        (r, target(root, r["repo"]))
        for r in repos
        if (target(root, r["repo"]) / ".git").exists()
    ]
    if not present:
        sys.exit(f"none of the selected repositories is in {root} - run `sync` first")
    return present


def lint(args: argparse.Namespace) -> int:
    root = Path(args.dir).expanduser()
    known = load_baseline().get(args.profile, {})
    new_total = gone_total = 0
    for r, where in checked_out(root, selected(load_repos(), args.only)):
        now = findings(args.binary, args.profile, where)
        before = {key(f) for f in known.get(r["repo"], [])}
        new = [f for f in now if key(f) not in before]
        gone = before - {key(f) for f in now}
        new_total += len(new)
        gone_total += len(gone)
        if new or gone or args.verbose:
            print(
                f"== {r['repo']}: {len(now)} finding(s), {len(new)} new, {len(gone)} gone"
            )
        for f in new:
            print(f"  NEW  {f['path']}:{f['line']} {f['code']} {f['detail'][:100]}")
        for path, code, detail, _ in sorted(gone):
            print(f"  GONE {path} {code} {detail[:100]}")
    print(f"{new_total} new, {gone_total} gone (profile {args.profile})")
    return 1 if new_total else 0


def accept(args: argparse.Namespace) -> int:
    root = Path(args.dir).expanduser()
    baseline = load_baseline()
    known = baseline.setdefault(args.profile, {})
    for r, where in checked_out(root, selected(load_repos(), args.only)):
        now = findings(args.binary, args.profile, where)
        entries = [{k: f[k] for k in ("path", "code", "detail", "text")} for f in now]
        known[r["repo"]] = sorted(
            entries, key=lambda f: (f["path"], f["code"], f["text"])
        )
        print(f"{r['repo']}: {len(now)} finding(s) recorded")
    BASELINE_FILE.write_text(json.dumps(baseline, indent=1, sort_keys=True) + "\n")
    return 0


def pin(args: argparse.Namespace) -> int:
    root = Path(args.dir).expanduser()
    repos = load_repos()
    chosen = {r["repo"] for r in selected(repos, args.only)}
    for r in repos:
        where = target(root, r["repo"])
        if r["repo"] in chosen and (where / ".git").exists():
            commit = git("rev-parse", "HEAD", cwd=where)
            if commit != r["commit"]:
                print(f"{r['repo']}: {r['commit'][:8]} -> {commit[:8]}")
                r["commit"] = commit
    REPOS_FILE.write_text(json.dumps(repos, indent=2) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)

    def command(name: str, fn, help: str, needs_dir: bool = True, lints: bool = False):
        c = sub.add_parser(name, help=help)
        if needs_dir:
            c.add_argument("dir", help="where the corpus is cloned, e.g. ~/q-corpus")
        c.add_argument(
            "--only",
            action="append",
            help="repositories whose owner/repo contains this",
        )
        if lints:
            c.add_argument(
                "--binary", default="target/release/qlinter", help="the qlinter to run"
            )
            c.add_argument(
                "--profile", default="general", choices=["general", "style", "uqf"]
            )
        c.set_defaults(fn=fn)
        return c

    command(
        "status", status, "pinned commit against upstream HEAD", needs_dir=False
    ).add_argument(
        "--peachq",
        action="store_true",
        help="also list projects peachq.org has that the corpus lacks",
    )
    command("sync", sync, "clone or fetch the corpus").add_argument(
        "--latest",
        action="store_true",
        help="each repository's upstream HEAD, not its pin",
    )
    command(
        "lint", lint, "findings the baseline does not have", lints=True
    ).add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="a line for every repository, changed or not",
    )
    command("accept", accept, "record the current findings as triaged", lints=True)
    command("pin", pin, "record the checked-out commits as the pins")
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
