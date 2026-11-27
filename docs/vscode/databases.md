# Databases and HDBs

The HDB tools. The [extension README](../../editors/vscode/README.md) has the summary.

- **HDB Browser** (view): a loaded partitioned database's partitions, row
  counts per table and partition, segments and sym file size, read without
  loading data. Under a `.Q.view` it says the figures cover N of M
  partitions.
- **Check Partition Consistency**: missing dates, tables and columns, type
  differences and enumeration problems across partitions.
- **Inspect Sym File**: size, growth and the columns that use it most.
- **Manage HDB Column...**: add, delete, rename or cast a column, or set its
  attribute, in every partition. The script opens for review first.
- **Advise Attributes**: whether `s#`, `u#`, `p#` or `g#` would help each
  column.
- **Document Database**: tables, columns, keys, partitions and functions as
  one document.
- **Write Schema Migration...**: the q that turns one table's schema into
  another's. **Generate Test Data...**: random rows shaped like a table.
