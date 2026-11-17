// Tasks run one at a time, in the order they were asked for.
//
// A restart stops the client and starts another, awaiting both. Two run at
// once - two quick settings changes, a keystroke each in a text setting -
// interleave: the second stops the client the first already stopped, then
// overwrites the one the first is starting, which keeps running with nothing
// pointing at it. Every document then gets two sets of diagnostics, and
// deactivate never stops the orphan (#549). Queued, each restart sees the
// client the one before it left.
export class Serial {
  private last: Promise<void> = Promise.resolve();

  /// Run `task` after every task asked for before it has settled. A task
  /// that fails does not stop the ones after it.
  run(task: () => Promise<void>): Promise<void> {
    const next = this.last.then(task);
    this.last = next.catch(() => {});
    return next;
  }
}
