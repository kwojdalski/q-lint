// The switches of the connection and process-admin features (#1032-#1041),
// each its own `enable` setting, and their commands and views. Free of any
// `vscode` import, so node tests it against package.json. A feature turned
// off has its commands hidden (package.json's `when`) and refusing, its
// views, listeners and timers gone, and sends nothing.
//
// Off unless asked for: the environment colour (it recolours the window),
// and scheduled exports, which run queries on their own.

export const ADMIN_SETTINGS = {
  bulkAdd: { key: "processes.bulkAdd.enable", fallback: true, name: "Add Many Processes" },
  importOther: { key: "processes.importOther.enable", fallback: true, name: "Importing from qStudio or the KX extension" },
  credentialCommand: { key: "connection.credentialCommand.enable", fallback: true, name: "The credential command" },
  environmentColor: { key: "processes.environmentColor.enable", fallback: false, name: "The environment colour" },
  processTimeout: { key: "query.processTimeout.enable", fallback: true, name: "The per-process query timeout" },
  cancelLocal: { key: "query.cancelLocal.enable", fallback: true, name: "Interrupt Query on Local Process" },
  asyncQuery: { key: "query.async.enable", fallback: true, name: "Run Query Asynchronously" },
  queryLinks: { key: "query.links.enable", fallback: true, name: "The shareable query link" },
  scheduledExports: { key: "export.schedule.enable", fallback: false, name: "Scheduled export" },
  clientsView: { key: "connectedClients.enable", fallback: true, name: "The Connected Clients view" },
  timerView: { key: "timers.enable", fallback: true, name: "The Timers view" },
} as const;

export type AdminFeature = keyof typeof ADMIN_SETTINGS;

/// Which features are on, read with `get` as `readLive` reads the query
/// settings. Anything but a boolean is the default.
export function readAdmin(get: <T>(key: string, fallback: T) => T): Record<AdminFeature, boolean> {
  const out = {} as Record<AdminFeature, boolean>;
  for (const [feature, { key, fallback }] of Object.entries(ADMIN_SETTINGS)) {
    const value = get<unknown>(key, fallback);
    out[feature as AdminFeature] = typeof value === "boolean" ? value : fallback;
  }
  return out;
}

/// What a command of a feature turned off says.
export function adminOff(feature: AdminFeature): string {
  const { key, name } = ADMIN_SETTINGS[feature];
  return `q-lint: ${name} is turned off. Set q-lint.${key} to true to turn it on.`;
}

export const ADMIN_COMMANDS = {
  bulkAdd: "q-lint.addManyProcesses",
  importQStudio: "q-lint.importQStudioServers",
  importKx: "q-lint.importKxConnections",
  setCredentialCommand: "q-lint.setCredentialCommand",
  setTimeout: "q-lint.setProcessTimeout",
  interrupt: "q-lint.interruptQuery",
  runAsync: "q-lint.queryAsync",
  pendingAsync: "q-lint.showPendingAsyncQueries",
  copyLink: "q-lint.copyQueryLink",
  addSchedule: "q-lint.addScheduledExport",
  manageSchedules: "q-lint.manageScheduledExports",
  refreshClients: "q-lint.refreshConnectedClients",
  closeClient: "q-lint.closeClientHandle",
  refreshTimers: "q-lint.refreshTimers",
  toggleTimer: "q-lint.toggleTimer",
  setTimerInterval: "q-lint.setTimerInterval",
} as const;

export const ADMIN_VIEWS = {
  clients: "q-lint.connectedClients",
  timers: "q-lint.timers",
} as const;
