// A long query's progress (#910), as data: how its running time is written
// in the status bar, and whether its end is worth a notification. No
// `vscode` import, so node tests it; `live.ts` keeps the timer and asks.

export interface ProgressSettings {
  /// `q-lint.query.progress.enable`: count the time and notify at all.
  enabled: boolean;
  /// Seconds a query must have run for its end to be notified while the
  /// window is not focused; 0: never.
  notifyAfter: number;
}

/// The settings read as `readLive` reads the query ones, at each query.
export function readProgress(get: <T>(key: string, fallback: T) => T): ProgressSettings {
  const after = get<unknown>("query.notifyAfter", 10);
  return {
    enabled: get<unknown>("query.progress.enable", true) !== false,
    notifyAfter: typeof after === "number" && Number.isFinite(after) && after > 0 ? Math.min(after, 86_400) : 0,
  };
}

/// `millis` as the status bar writes a running query's time: `7s`, `1m 05s`,
/// `2h 03m`. Whole seconds, rounded down, so it never runs ahead.
export function elapsedText(millis: number): string {
  const s = Math.max(0, Math.floor(millis / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const two = (n: number): string => String(n).padStart(2, "0");
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  }
  return `${Math.floor(s / 3600)}h ${two(Math.floor(s / 60) % 60)}m`;
}

/// Whether a query that took `millis` and ended while the window was
/// `focused` or not is notified: only one that ran at least `notifyAfter`
/// seconds, and only when the user is looking elsewhere. One the user
/// aborted is not news to them.
export function shouldNotify(millis: number, focused: boolean, outcome: string, settings: ProgressSettings): boolean {
  return settings.enabled && settings.notifyAfter > 0 && !focused && outcome !== "aborted" && millis >= settings.notifyAfter * 1000;
}

/// What the notification says of a query on `process` that ended with
/// `outcome` after `millis`.
export function finishedText(process: string, millis: number, outcome: string, error?: string): string {
  const took = elapsedText(millis);
  // A notification is a line or two: a long error is cut.
  const said = error === undefined ? undefined : Array.from(error).length > 200 ? `${Array.from(error).slice(0, 199).join("")}…` : error;
  switch (outcome) {
    case "ok":
      return `q-lint: the query on ${process} finished after ${took}.`;
    case "timeout":
      return `q-lint: the query on ${process} ${error ?? "timed out"}.`;
    default:
      return `q-lint: the query on ${process} failed after ${took}${said === undefined ? "" : `: '${said}`}.`;
  }
}
