"""Fetch the public q corpus that `scripts/corpus_diff.py` is run against.

    python3 scripts/fetch_corpus.py ~/q-corpus
    python3 scripts/corpus_diff.py /tmp/qlinter-before target/release/qlinter ~/q-corpus

A corpus only answers the question it is asked if it holds the shapes a rule
reads. The first one this repository used was almost all one framework, and
twenty rule changes in a row moved nothing on it - not because they were
safe, but because none of its files contained what they matched. These are
other authors' q: KX's own libraries and examples, FINOS, and community code,
written to different habits. Run against them, the default profile reported
55 findings, of which 44 were wrong; the seven causes are fixed and the 10
that are real defects in that code are its authors' to fix.

The second set, from 2026-11-13, adds the open-source projects on peachq.org's
compatibility page that the first set did not already have. These are working
applications and libraries, each tested on PeachQ with its own suite, so they
hold what people actually write. Under the default profile they reported 190
findings. 57 were wrong, from eleven causes (#292-#302). The other 131 are
real errors in the code or fixtures broken on purpose, and two are code from
before a check q has since added.

The code is third-party and is never committed here. Each repository is
pinned to the commit it was triaged at, so a diff over it moves only when the
linter does. `scripts/corpus.py` keeps the list (`scripts/corpus.json`)
current, and lints the corpus against the findings already triaged.
"""

import json
import subprocess
import sys
from pathlib import Path

#: The repositories and their pins live in corpus.json, which corpus.py also
#: reads and `corpus.py pin` rewrites.
REPOS = [(r["repo"], r["commit"]) for r in json.loads((Path(__file__).parent / "corpus.json").read_text())]


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} DIRECTORY")
    root = Path(sys.argv[1]).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    for repo, commit in REPOS:
        target = root / repo.replace("/", "_")
        if not (target / ".git").exists():
            target.mkdir(parents=True, exist_ok=True)
            git("init", "-q", cwd=target)
            git("remote", "add", "origin", f"https://github.com/{repo}.git", cwd=target)
        # One commit, no history: the corpus is the files, not the project.
        git("fetch", "-q", "--depth", "1", "origin", commit, cwd=target)
        git("checkout", "-q", "--detach", commit, cwd=target)
        count = sum(1 for _ in target.rglob("*.q"))
        print(f"{repo}: {count} .q files at {commit[:8]}")


if __name__ == "__main__":
    main()
