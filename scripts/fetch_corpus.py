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

The code is third-party and is never committed here. Each repository is
pinned to the commit it was triaged at, so a diff over it moves only when the
linter does.
"""

import subprocess
import sys
from pathlib import Path

REPOS = [
    ("finos/kdb", "e54032a57fd4d9c1288ef4807f2c9f7c22d1c290"),
    ("jonathonmcmurray/qwebapi", "25c802119b55ca4f3d18703fdf3c5d124781818b"),
    ("jonathonmcmurray/reQ", "6728dd50ed767ffb8818940a51579d4abc8c01d9"),
    ("kxcontrib/cburke", "bf516a050386b4e4b05913eb4c83d43bc6f62acb"),
    ("KxSystems/arrowkdb", "2acffa3fee92e3364c9e6de6adc512d980a1b5c5"),
    ("KxSystems/automl", "f9e39ec791c67c7308bad0fe3e410a85cfccf0b8"),
    ("KxSystems/cookbook", "7f083085205d784c9eacf0c7a1841d66dbb58531"),
    ("KxSystems/embedPy", "2a77b030e0717f5a26fdbe59b1657046eef5635d"),
    ("KxSystems/fusionx", "a6192543fe6b6f6d857f889833108248c325d2a5"),
    ("KxSystems/jupyterq", "1cc895e674be17d8a9992c0bb128508120a34825"),
    ("KxSystems/kafka", "e1790a54d58e4288d446f51ffc8b8e9271b0fb44"),
    ("KxSystems/kdb", "3af0d471926df9e04af19bb5b470174d234a4fef"),
    ("KxSystems/kdb-taq", "bd1b1c68e53694810cb3bfb1df3f5b70ca20613e"),
    ("KxSystems/kdb-tick", "85c08ff192b0a103b323246c7300a37919be6159"),
    ("KxSystems/ml", "5509fa6cfc454c68bf3441672fe1a26cb5a19088"),
    ("KxSystems/mqtt", "4d98447fcfd062fdd0040741d8778292dc1025ff"),
    ("KxSystems/nlp", "9a7f2d3f8daa88a8e8de7b25c7ffc6d7c25447da"),
    ("KxSystems/protobufkdb", "b78a3df44cc0921914eb3c26aedfb25bcf6471cc"),
    ("KxSystems/pykx", "50ec85ba1c65f6baa5c7a2b0723497a06bfcfb5e"),
    ("psaris/funq", "9c95cc27bbdcd977fa0fe498efb0a331e4a5b581"),
    ("psaris/qtips", "14d6983b54147651f14a74ca951abf6a755036a0"),
    ("qbists/studyq", "efe1da1a9c31044580c573f59e9f669d5a646e67"),
    ("simongarland/tick", "d5fdc3d3112ecdf547c42f4a6f2f917cb3bffa50"),
    ("timeseries/kdb", "18822dd8d932d429b8ebacbbde2e3624440d5777"),
]


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
