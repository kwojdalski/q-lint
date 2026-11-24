// Where a loaded database's partitions are on disk (#1977), for the q the
// partition check, the sym inspector, the attribute advisor and the column
// manager send. Free of any `vscode` import.
//
// q records where it loaded each partition from: `.Q.PD` holds a directory
// for each value of `.Q.PV` (`.Q.pd` and `.Q.pv` under a view), the segment
// it found the partition in, or `:.` in a database with no par.txt. That is
// the only answer that is right for every segmented database. `.Q.par` is
// not one: it answers the segment a writer would pick for a new partition
// (`p mod count par.txt`), so on a database segmented any other way - by
// date range, by disk, older dates moved - it names directories that do not
// exist. A value can be in two segments, and is then twice in `.Q.PV` with a
// directory each, which is why this takes the lists and not one value.
//
// `PARTITION_DIRS[r;D;V]`: the directory of each partition of `V`, a list
// as long, given the root `r` and where q loaded each from, `D`. Where `D`
// is not as long as `V` - a q that sets no `.Q.PD` - it falls back to
// `.Q.par`. With no par.txt the directory is the root's, as `.Q.par` gives.
export const PARTITION_DIRS =
  "{[r;D;V]$[(0<count V)&count[D]=count V;{[r;s;p]` sv($[s~`:.;r;s];`$string p)}[r]'[D;V];{[r;p]first` vs .Q.par[r;p;`t]}[r]each V]}";
