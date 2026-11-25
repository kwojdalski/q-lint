# JSON output

`qlinter --format json` prints the findings as one JSON array on a single
line, sorted by file, line, column, source and rule, and `[]` when there are
none. Every finding is an object with the same twelve keys, in this order; a
key with nothing to say is `null`, never left out:

```json
[{"path":"/repo/src/a.q","line":1,"rule":"reserved-parameter","detail":"Builtin parameter name(s): [\"count\"]; q refuses every call to this lambda ('match or 'nyi)","why":"Builtin name used as a parameter","source":"q-lint","severity":"error","column":3,"end_line":null,"end_column":null,"code":"QF001","category":"names"}]
```

<!-- finding-fields: tests/output_doc.rs checks this table against the serialiser -->
| field | type | meaning |
|---|---|---|
| `path` | string | The file, as an absolute path with symbolic links resolved. Standard input is `<stdin>`, or the name `--stdin-filename` gives, as given. |
| `line` | integer | The line the finding is on, from 1. |
| `rule` | string | The rule's name, `reserved-parameter`; for a qls finding, `qls/` and qls's own code. |
| `detail` | string | What this finding is about, in this place: the names, the values or the construct involved. |
| `why` | string | The rule's summary, as `--rules` prints it; empty for a qls finding. |
| `source` | string | `q-lint` for a builtin rule, `qls` for one reported by `--backend qls`. |
| `severity` | string | `error` for what q refuses (the rules in `general`), `warning` for anything q accepts; a qls finding may also be `information` or `hint`. |
| `column` | integer or null | Where the finding starts on `line`, from 1, counted in UTF-16 code units as an editor counts them: a leading BOM, which an editor hides, is no column, so line 1 reads the same with or without one (QE005, the BOM's own, is at 1). `null` when the rule reports the whole line. |
| `end_line` | integer or null | The line the finding ends on, from 1, when that is not `line`; set only by qls today. |
| `end_column` | integer or null | Where the finding ends, from 1 and in UTF-16 code units, one past its last character, on `end_line` or else on `line`. `null` when the finding has no end of its own. |
| `code` | string | The rule's code, `QF001`: what `--select`, `--ignore`, `noqa` and `--explain` take. |
| `category` | string | The rule's category in [the rule list](rules.md), `names`. |

A finding identifies itself by `code`; `rule` and `why` are for a reader,
and a rule's wording can change between releases where its code does not.

`severity` spells each level one way, as the language server protocol and
qls do: `error`, `warning`, `information` or `hint`. A configuration's
`[severity]` can give a builtin rule any of the four - written `info` or
`information`, reported `information` - so a builtin finding, not only a
qls one, may be `information` or `hint`. Only `error` and `warning` fail the
run; `--format sarif` reports the other two as `note`, `--format github` as
`notice`, and the language server as Information and Hint.

## `--statistics`

`qlinter --statistics --format json` prints, instead of the findings, one
object per rule that has any, the most frequent first:

<!-- statistics-fields: tests/output_doc.rs checks this table against the CLI -->
| field | type | meaning |
|---|---|---|
| `code` | string | The rule's code. |
| `count` | integer | How many findings it has. |
| `summary` | string | The rule's summary, as `why` above. |

The exit code is the one the findings would give: 0 with none, 1 with any.
`--format sarif` and `--format github` are described in the README's
[Reports for CI](../README.md#reports-for-ci).
