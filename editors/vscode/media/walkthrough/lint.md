# See a lint finding

q-lint reads a q file as you type and underlines what it finds. It never runs
the file.

```q
f:{[x;til] x+til}
```

`QF001`: `til` is a q builtin, so q refuses every call to `f`.

Hover the underline for the message; the code links to the rule's page, and
**Quick Fix** (`Cmd+.` / `Ctrl+.`) offers a fix where there is a safe one.
The **Problems** panel lists every finding in the open files.
