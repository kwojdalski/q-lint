// Connection health (#917), as data: the settings, the heartbeat's message,
// how latency is written, and how long a reconnect waits before each try.
// No `vscode` import, so node tests it; `live.ts` keeps the timers.

export interface HealthSettings {
  /// Seconds between heartbeats; 0: none, `q-lint.connection.heartbeat.enable`
  /// being off.
  heartbeat: number;
  /// Reconnect when the process or the network drops the connection.
  autoReconnect: boolean;
  /// Tries before a reconnect gives up.
  reconnectAttempts: number;
}

/// The settings read as `readLive` reads the query ones. Both features are off by
/// default: a heartbeat is a message to the process every few seconds, which
/// a process that logs its clients sees, and a reconnect opens a connection
/// the user did not ask for.
export function readHealth(get: <T>(key: string, fallback: T) => T): HealthSettings {
  const on = get<unknown>("connection.heartbeat.enable", false) === true;
  const interval = get<unknown>("connection.heartbeatInterval", 30);
  const heartbeat = on ? interval : 0;
  const attempts = get<unknown>("connection.reconnectAttempts", 5);
  return {
    // At least a second; at most a day, as a timer takes at most 2^31-1 ms.
    heartbeat: typeof heartbeat === "number" && Number.isFinite(heartbeat) && heartbeat > 0 ? Math.min(Math.max(heartbeat, 1), 86_400) : 0,
    autoReconnect: get<unknown>("connection.autoReconnect.enable", false) === true,
    reconnectAttempts: typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 1 ? Math.min(attempts, 100) : 5,
  };
}

/// What a heartbeat sends: a string the process evaluates as any client's
/// (`.z.pg`), which defines nothing and returns `::`. Any answer, a q error
/// too, is the process answering.
export const HEARTBEAT = "::";

/// Milliseconds a reconnect waits before try `attempt` (from 1): 1 s, then
/// doubling, at most 30 s.
export function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

/// A round trip as the status bar writes it: `3 ms`, `1.2 s`. Rounded
/// first, so 999.6 is `1.0 s`, not `1000 ms` (#1585).
export function latencyText(millis: number): string {
  const ms = Math.max(0, Math.round(millis));
  return ms < 1000 ? `${ms} ms` : `${(millis / 1000).toFixed(1)} s`;
}

/// How long a heartbeat may go unanswered before the status bar says so:
/// the process is busy (q answers one message at a time), or gone.
export const UNANSWERED_MS = 5000;

/// How long a reconnected connection stays up before it counts as held,
/// when no query was answered on it: the reconnects after it start again
/// at the first try (#2129).
export const STEADY_MS = 60_000;
