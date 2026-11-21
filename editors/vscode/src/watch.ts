// Watch Query (#914), as data: the commands, the settings, and what the
// status bar says. No `vscode` import, so node tests it; `live.ts` runs the
// watch, since a watched query runs as any query from the editor does.
//
// A watched query sends code to a process on its own, every few seconds,
// so it is off by default (`q-lint.query.watch.enable`).

export const WATCH = {
  start: "q-lint.watchQuery",
  stop: "q-lint.stopWatchingQuery",
} as const;

/// Set while a query is watched, for Stop Watching Query's `when`.
export const WATCHING = "q-lint.watching";

/// The longest interval, a day: a timer takes at most 2^31-1 ms.
export const LONGEST_INTERVAL = 86_400;

export interface WatchSettings {
  enabled: boolean;
  /// Seconds between runs, offered when a watch starts.
  interval: number;
}

/// Whether `value` is a number of seconds a watch can wait: 1 to a day.
function seconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= LONGEST_INTERVAL;
}

/// The settings read as `readLive` reads the query ones, at each use.
export function readWatch(get: <T>(key: string, fallback: T) => T): WatchSettings {
  const interval = get<unknown>("query.watch.interval", 5);
  return {
    enabled: get<unknown>("query.watch.enable", false) === true,
    interval: seconds(interval) ? interval : 5,
  };
}

/// Why `text` is not an interval, for the input box; undefined when it is.
export function intervalProblem(text: string): string | undefined {
  const n = Number(text.trim());
  return text.trim() !== "" && seconds(n) ? undefined : `A number of seconds, 1 to ${LONGEST_INTERVAL}.`;
}

/// What the status bar says while `label` is watched every `every`
/// seconds, run `runs` times so far.
export function watchText(label: string, every: number, runs: number): string {
  return `$(eye) watching ${label} every ${every}s (${runs})`;
}
