# Open the Process Explorer

The **Process Explorer** lists the connected process's namespaces, and in
each its tables, functions and variables. **Preview** shows a table's first
rows.

It reads the process when you connect, when you refresh it, and after each
query once auto refresh is on - never while you type - and leaves out q's
own namespaces (`q-lint.processExplorer.excludedNamespaces`).
