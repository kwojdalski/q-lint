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
    # The projects on peachq.org's compatibility page (2026-11-13), at the
    # commit each was triaged at. Those already above are not repeated.
    ("aa1024/strQ", "7fa050ffaf385477bc16e946c6ec8ca7955833d7"),
    ("angusmit/qPricer", "9b418d62c9a1843c175a24fc3e0610d8a57ffc61"),
    ("asatirahul/cryptoq", "ffc72c1cdc487595df82de5a7969100bf0c4ade7"),
    ("BuaBook/kdb-common", "d836de1eac943aa1fbc8b4c6237ed49e91333206"),
    ("caolanraff/q-sino", "d7e1ee7b733d72c97ca3322d10588b1b09b77a52"),
    ("dalaing/qcheck", "2c80face5167a6edfa0ae884dc43130b1a28d5c2"),
    ("DataIntellectTech/TorQ", "4be4fc3457bf1a838e976ff2e9892b2babe8c1c3"),
    ("dflynch/kdb-q-ext-vscode", "f363a8913bfc0d4bd7c2becbf5acff6c65a58c0a"),
    ("drewsteele/qYaml", "d62cc5b41d235b10a49b9c572e52c530917a4f05"),
    ("exxeleron/enterprise-components", "c1cc3bbf783bfc395d99fdb44b2754e3cc742f85"),
    ("hanssmail/quantQ", "7a50cc9d3067ce365307b9cb211bd34561db2722"),
    ("jkane17/qtools", "3df046566569913335fc0d1be6b73485082bab5a"),
    ("jlas/ml.q", "bb0c8ca39717023de951351127342ad96dbb0f26"),
    ("jsogarro/qstats", "d2f24f10735288b30fe1d712e8f9079e09efe428"),
    ("kimtang/btick2", "d9055fe20a1c0628b9967a6840bf8f4dbe1aa7fc"),
    ("kwojdalski/uqf", "428405789b2272efec40ce6c4e4900f54d80e2c2"),
    ("nugend/qspec", "9b846b68a8d808e472ba504d18c325b14b468087"),
    ("nugend/qutil", "2bce9deb5585f7166052bfb81012b8d897fedeeb"),
    ("Oiubrab/qSolve", "bf4c3a8d93fb0b055cfe6b69b55dc36c88f083c9"),
    ("patmok/unparse", "079b8a2ad1a18770677bd68ef31b5fa1d38c3864"),
    ("Piohrun/resq", "1a5c4486ce821e3cb6c4f9e79ea04695d6ee98cc"),
    ("quintanar401/qchk", "083306eae29a7e39e5577779ff89c9ce21e8ef2d"),
    ("quintanar401/Qute", "7fd3140489a02d1b7eaa75cf532f78378d663f18"),
    ("SpencerFX/q-desc", "99e7d0a700cbe6b39680ce46aa43d78f43b8c3cb"),
    ("timestored/kdb", "0da819cd1eaaf7f0a7b7e5b509f9acc052770564"),
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
