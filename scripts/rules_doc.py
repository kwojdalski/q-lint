"""Write docs/rules.md from src/taxonomy.json.

The taxonomy is the only place a rule's description lives - `--rules` and
`--explain` print from it - so this document is generated from it rather than
written beside it, which is the one way to keep the two from disagreeing.

    python3 scripts/rules_doc.py > docs/rules.md

`tests/rules_doc.rs` fails when the committed file is stale.
"""

import collections
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

PROFILES = {
    "builtin": ("every profile", "source q refuses to run: a parse error, or an error the moment it is called"),
    "style": ("`style` and above", "q that runs and is wrong: a habit, an idiom misread, a construct that says one thing and means another"),
    "styleq": ("`styleq` and above", "conventions the published q style guides state as rules"),
    "uqf": ("`uqf`", "one repository's house conventions"),
    "python-hook": ("a Python hook", "raised by the embedded-q hook, not by this binary"),
    "qls": ("the qls backend", "relayed from KX's qls when `--backend qls` is given"),
}

CATEGORIES = {
    "syntax": "Syntax - source q cannot read at all",
    "names": "Names - parameters, locals, globals and what they shadow",
    "application": "Application - how many arguments a thing takes and how it is called",
    "types-and-shapes": "Types and shapes - literals that cannot be what the operator needs",
    "correctness": "Correctness - q that runs and does the wrong thing",
    "domain": "Domain - literal arguments outside what a builtin accepts",
    "policy": "Policy - one repository's conventions",
    "style-guide": "Style guide - conventions from published q guidance",
    "external": "External - findings relayed from another tool",
}


def main() -> int:
    rules = json.loads((ROOT / "src/taxonomy.json").read_text())
    by_cat = collections.defaultdict(list)
    for r in rules:
        by_cat[r["category"]].append(r)

    print("# Rules")
    print()
    print(f"All {len(rules)} rules, generated from `src/taxonomy.json` - the same data")
    print("`qlinter --rules` and `qlinter --explain <CODE>` print from. Regenerate with")
    print("`python3 scripts/rules_doc.py > docs/rules.md`; a test fails when this is stale.")
    print()
    print("## Where the rules come from")
    print()
    print("Three sources, and the profile a rule lands in says which.")
    print()
    print("**q itself.** Every rule in the `general` set reports something the interpreter")
    print("refuses. Each was settled by running the construct through q rather than by")
    print("reading the reference, and [docs/design.md](design.md) explains why that is")
    print("the line the default holds.")
    print()
    print("**Other linters' hazards, translated.** [docs/ruff-applicability.md](ruff-applicability.md)")
    print("reads ruff's 969 rules by the hazard each encodes rather than by its Python")
    print("mechanism, and lists which survive the translation. Most of the `style` set")
    print("came from that survey, and each was checked against q before it was written.")
    print()
    print("**Published q style guidance.** [qbists/style](https://github.com/qbists/style)")
    print("is Stevan Apter's \"Remarks on Style\" adapted to q; the")
    print("[FINOS q coding guidelines](https://github.com/finos/kdb/blob/main/enterprise-best-practices/q-coding-guidelines.md)")
    print("and its [qdoc](https://github.com/finos/kdb/tree/main/qdoc) convention are the")
    print("enterprise counterpart. The `styleq` set quotes the sentence each rule comes")
    print("from, and `.claude/skills/q-style/SKILL.md` records which guidance was measured")
    print("against real q and refused, with the numbers.")
    print()
    print("## Profiles")
    print()
    print("| profile | reports |")
    print("|---|---|")
    print("| `general` | only what q refuses to run |")
    print("| `style` | `general`, plus q that runs and is wrong |")
    print("| `styleq` | `style`, plus the published style-guide conventions |")
    print("| `uqf` | everything - the default |")
    print()
    print("The default is the broadest. This binary reports all it can see; a consumer")
    print("that wants fewer findings narrows in its own configuration.")
    print()
    for cat, title in CATEGORIES.items():
        group = by_cat.get(cat)
        if not group:
            continue
        print(f"## {title}")
        print()
        print("| code | name | summary | on in |")
        print("|---|---|---|---|")
        for r in sorted(group, key=lambda r: r["code"]):
            scope = PROFILES.get(r["scope"], (r["scope"], ""))[0]
            summary = r["summary"].replace("|", "\\|")
            print(f"| `{r['code']}` | {r['name']} | {summary} | {scope} |")
        print()
    unknown = set(by_cat) - set(CATEGORIES)
    if unknown:
        print(f"<!-- categories without a heading: {sorted(unknown)} -->", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
