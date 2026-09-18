"""Diff two qlinter builds over a body of q, and say what moved.

`tests/corpus/` pins the shapes that have gone wrong before. This is for the
question it cannot answer: what does a change do to q nobody here has seen?
Point it at a directory of real .q files - a work checkout, a vendor drop, a
clone of anything public - and it reports every finding the new build adds or
drops against the old one.

    cargo build --release
    git stash && cargo build --release && cp target/release/qlinter /tmp/before
    git stash pop && cargo build --release
    python3 scripts/corpus_diff.py /tmp/before target/release/qlinter ~/q

Findings are compared on (path, line, code, detail), so a reworded message
shows up as a change too - deliberately, since the message is what a user
reads.

Every false positive this repository has withdrawn was found this way and by
nothing else: 648 of them on `\\d .ns` at end of file, 322 announcing skipped
checks, 151 on a `~` outside a filter.
"""

import argparse
import collections
import json
import os
import subprocess
import sys

BATCH = 200


def findings(binary, files, profile):
    """Every finding `binary` reports, batched so argv stays a sane length."""
    out = []
    for i in range(0, len(files), BATCH):
        batch = files[i : i + BATCH]
        result = subprocess.run(
            [binary, "--profile", profile, "--format", "json", *batch],
            capture_output=True,
            text=True,
        )
        try:
            out.extend(json.loads(result.stdout or "[]"))
        except json.JSONDecodeError:
            print(f"  ! {binary} produced no JSON for a batch of {len(batch)}", file=sys.stderr)
    return out


def key(f):
    return (f["path"], f["line"], f["code"], f.get("detail", ""))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("before", help="the qlinter to compare against")
    p.add_argument("after", help="the qlinter under test")
    p.add_argument("corpus", nargs="+", help="directories or files of q")
    p.add_argument("--profile", default="general", choices=["general", "style", "uqf"])
    p.add_argument("--show", type=int, default=10, help="examples of each change to print")
    args = p.parse_args()

    files = []
    for root in args.corpus:
        if os.path.isfile(root):
            files.append(root)
            continue
        for dirpath, _, names in os.walk(root):
            files.extend(os.path.join(dirpath, n) for n in names if n.endswith(".q"))
    if not files:
        sys.exit("no .q files found")

    before = findings(args.before, files, args.profile)
    after = findings(args.after, files, args.profile)
    b, a = {key(f) for f in before}, {key(f) for f in after}
    added, lost = sorted(a - b), sorted(b - a)

    print(f"{len(files)} files, --profile {args.profile}")
    print(f"  before: {len(before):6}  {dict(collections.Counter(f['code'] for f in before).most_common(5))}")
    print(f"  after:  {len(after):6}  {dict(collections.Counter(f['code'] for f in after).most_common(5))}")
    print()
    print(f"ADDED {len(added)}   {dict(collections.Counter(k[2] for k in added))}")
    for path, line, code, detail in added[: args.show]:
        print(f"    {os.path.basename(path)}:{line} {code}  {detail[:70]}")
    print(f"LOST  {len(lost)}   {dict(collections.Counter(k[2] for k in lost))}")
    for path, line, code, detail in lost[: args.show]:
        print(f"    {os.path.basename(path)}:{line} {code}  {detail[:70]}")

    # Added findings are the ones worth a person's attention: a rule that has
    # started reporting something is either catching more or crying wolf, and
    # only reading them says which.
    return 1 if added else 0


if __name__ == "__main__":
    sys.exit(main())
