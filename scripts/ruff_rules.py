"""Turn `ruff rule --all --output-format json` into docs/ruff-rules.md.

The dump is a reference for docs/ruff-applicability.md, which asks which of
the things a mature linter for one language checks have a meaning in another.
Kept as a script so the list can be refreshed against a newer ruff without
anyone retyping it.

    uvx ruff rule --all --output-format json > ruff.json
    python3 scripts/ruff_rules.py ruff.json > docs/ruff-rules.md
"""

import collections
import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    rules = [r for r in json.load(open(sys.argv[1])) if r.get("code")]
    by_linter = collections.defaultdict(list)
    for rule in rules:
        by_linter[rule["linter"]].append(rule)

    print("# ruff's rule set")
    print()
    print(f"All {len(rules)} rules, as a reference for the question in")
    print("[ruff-applicability.md](ruff-applicability.md): which of the things a mature")
    print("linter for one language checks have a meaning in another.")
    print()
    print("Regenerate with:")
    print()
    print("```sh")
    print("uvx ruff rule --all --output-format json > ruff.json")
    print("python3 scripts/ruff_rules.py ruff.json > docs/ruff-rules.md")
    print("```")
    print()
    for linter in sorted(by_linter):
        group = sorted(by_linter[linter], key=lambda r: r["code"])
        print(f"## {linter} ({len(group)})")
        print()
        print("| code | name | summary |")
        print("|---|---|---|")
        for rule in group:
            summary = rule["summary"].replace("|", "\\|")
            print(f"| `{rule['code']}` | {rule['name']} | {summary} |")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
