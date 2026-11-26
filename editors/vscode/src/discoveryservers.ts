// Discovery servers in the Processes view (#874): the servers the user adds,
// kept in `globalState` with their auth header in secret storage, fetched on
// Reload and every `q-lint.discovery.refreshInterval` minutes. What they list
// is kept in memory only. How a server is fetched and its rows built is
// `discovery.ts`'s; this file is the VS Code around it.
import {
  commands,
  EventEmitter,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  window,
  workspace,
  type ExtensionContext,
} from "vscode";
import {
  EMPTY_STATE,
  SHARED_SOURCE,
  downloadedPasswords,
  fetchProcesses,
  parseServers,
  qualified,
  relabelledServers,
  serverDescription,
  serverLabelProblem,
  serverTooltip,
  toDownload,
  urlProblem,
  type Discovered,
  type DiscoveryServer,
  type Row,
  type ServerState,
} from "./discovery";
import { DISCOVERY_COMMANDS, readDiscovery } from "./liveconfig";
import { parseProcesses, passwordKey, passwordsToForget, type Process } from "./processes";
import { iconsEscaped, plainMessage } from "./history";

const SERVERS_KEY = "q-lint.discoveryServers";
/// The discovered processes a password was given for, by server, as
/// `{ [server]: label[] }`: kept, so a server deleted after a reload, before
/// it has listed anything, still forgets them.
const PASSWORDS_KEY = "q-lint.discoveredPasswords";
/// Where each process a password was given for was listed, by server, as
/// `{ [server]: process[] }`: kept, so one listed elsewhere after a reload
/// still forgets its password.
const SEEN_KEY = "q-lint.discoveredSeen";
const secretKey = (label: string): string => `q-lint.discovery.auth.${label}`;

/// What a server command is given: its row, its label, or nothing - then the
/// user picks one.
type ServerArg = Row | string | undefined;

/// The fields Add and Edit Discovery Server take as an argument instead of
/// asking. `secret` is the auth header; on Edit, an empty one removes it.
interface ServerFields {
  label?: string;
  url?: string;
  secret?: string;
}

export class DiscoveryServers {
  private readonly states = new Map<string, ServerState>();
  /// The fetch in progress per server, of which URL and after how many
  /// removals, so a second Reload waits for it.
  private readonly inFlight = new Map<string, { url: string; removals: number; done: Promise<void> }>();
  /// Bumped per server by Remove Processes, so a fetch out at the time
  /// does not bring them back, and by a change of its auth header, so what
  /// a fetch with the old one answers is not kept.
  private readonly removals = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly changed = new EventEmitter<void>();
  /// Fired when a server or what it lists changes: what the view refreshes on.
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: ExtensionContext,
    /// `gone`: a server deleted, or its processes removed - the connection
    /// to one of them is closed, and not reconnected (#2565).
    private readonly saved: { list: () => Process[]; save: (processes: Process[], given: string[]) => Promise<void>; gone?: (server: string) => Promise<void> },
  ) {
    const c = (name: string, run: (...args: never[]) => unknown) => commands.registerCommand(name, run);
    context.subscriptions.push(
      c(DISCOVERY_COMMANDS.add, (fields?: ServerFields) => this.add(fields)),
      c(DISCOVERY_COMMANDS.edit, (arg?: ServerArg, fields?: ServerFields) => this.edit(arg, fields)),
      c(DISCOVERY_COMMANDS.remove, (arg?: ServerArg) => this.remove(arg)),
      c(DISCOVERY_COMMANDS.reload, (arg?: ServerArg) => this.reload(arg)),
      c(DISCOVERY_COMMANDS.download, (arg?: ServerArg) => this.download(arg)),
      c(DISCOVERY_COMMANDS.forget, (arg?: ServerArg) => this.forget(arg)),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.discovery")) {
          this.schedule(false);
        }
      }),
      this.changed,
      { dispose: () => clearInterval(this.timer) },
    );
    this.schedule(true);
    void this.relabel();
  }

  /// Give a stored server labelled as the shared list is another label
  /// (#1889), as Edit would: its auth header goes with it, to the URL it
  /// was given for, and the passwords given for its processes are forgotten.
  private async relabel(): Promise<void> {
    const relabelled = relabelledServers(this.context.globalState.get<unknown>(SERVERS_KEY, []));
    if (relabelled === undefined) {
      return;
    }
    await this.forgetPasswords(SHARED_SOURCE);
    const kept = await this.context.secrets.get(secretKey(SHARED_SOURCE));
    await this.context.secrets.delete(secretKey(SHARED_SOURCE));
    if (kept !== undefined) {
      await this.context.secrets.store(secretKey(relabelled.to), kept);
    }
    await this.context.globalState.update(SERVERS_KEY, relabelled.servers);
    this.changed.fire();
    this.schedule(true);
    void window.showInformationMessage(
      plainMessage(
        `q-lint: the discovery server "${SHARED_SOURCE}" is now "${relabelled.to}": ${SHARED_SOURCE} names the workspace's shared process list. The passwords given for its processes are asked for again.`,
      ),
    );
  }

  servers(): DiscoveryServer[] {
    return parseServers(this.context.globalState.get<unknown>(SERVERS_KEY, []));
  }

  /// Each server with what it last answered.
  discovered(): Discovered[] {
    return this.servers().map((server) => ({ server, state: this.states.get(server.label) ?? EMPTY_STATE }));
  }

  /// Fetch every server now when `now`, and then every interval; with an
  /// interval of 0, only on Reload.
  private schedule(now: boolean): void {
    clearInterval(this.timer);
    this.timer = undefined;
    const minutes = readDiscovery((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback)).refreshInterval;
    if (minutes === 0) {
      return;
    }
    const all = (): void => {
      for (const server of this.servers()) {
        if (!this.states.get(server.label)?.removed) {
          void this.fetch(server);
        }
      }
    };
    if (now) {
      all();
    }
    this.timer = setInterval(all, minutes * 60_000);
  }

  private set(label: string, state: ServerState): void {
    this.states.set(label, state);
    this.changed.fire();
  }

  /// Fetch `server` and keep what it answered. A failure is kept as its
  /// state and shown under its row, never in a message.
  private fetch(server: DiscoveryServer): Promise<void> {
    const removals = this.removals.get(server.label) ?? 0;
    const running = this.inFlight.get(server.label);
    if (running !== undefined) {
      // One of the URL the server had before an edit, or from before its
      // processes were removed, will not be kept: this one follows it.
      const same = running.url === server.url && running.removals === removals;
      return same ? running.done : running.done.then(() => this.fetch(server));
    }
    const before = this.states.get(server.label) ?? EMPTY_STATE;
    this.set(server.label, { ...before, loading: true, removed: false });
    const done = (async () => {
      let state: ServerState;
      try {
        const secret = await this.context.secrets.get(secretKey(server.label));
        const { processes, problems } = await fetchProcesses(server.url, { secret });
        state = { processes, problems, loading: false, fetchedAt: Date.now(), removed: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // What it last listed stays, beside the failure: a refresh that
        // fails once - a 503, a timeout - is no word that its processes are
        // gone, and they are connected to, bound and reconnected by label (#3025).
        state = { processes: before.processes, problems: before.problems, error: message, loading: false, fetchedAt: before.fetchedAt ?? Date.now(), removed: false };
      }
      // A server edited or deleted meanwhile keeps what its new URL answers,
      // and one whose processes were removed meanwhile stays so.
      const now = this.servers().find((s) => s.label === server.label);
      if (now?.url === server.url && (this.removals.get(server.label) ?? 0) === removals) {
        if (state.error === undefined) {
          await this.forgetMoved(server.label, before.processes, state.processes);
        }
        this.set(server.label, state);
      }
    })().finally(() => this.inFlight.delete(server.label));
    this.inFlight.set(server.label, { url: server.url, removals, done });
    return done;
  }

  private async store(servers: DiscoveryServer[]): Promise<void> {
    await this.context.globalState.update(SERVERS_KEY, servers);
    this.changed.fire();
  }

  /// Ask for a server's fields, starting from `from`; undefined if the user
  /// stops part way. `secret` is undefined to keep the stored one.
  private async ask(from: Partial<DiscoveryServer>, taken: Set<string>, stored: boolean): Promise<Required<Pick<ServerFields, "label" | "url">> & { secret?: string } | undefined> {
    const label = await window.showInputBox({
      title: "Discovery server: label",
      value: from.label,
      prompt: "A name for the server, unique among them; its processes are shown under it",
      validateInput: (v) => serverLabelProblem(v, taken),
    });
    if (label === undefined) {
      return undefined;
    }
    const url = await window.showInputBox({
      title: "Discovery server: URL",
      value: from.url ?? "https://",
      prompt: "Answers a GET with a JSON list of {label, host, port, tags?, user?, tls?}",
      validateInput: urlProblem,
    });
    if (url === undefined) {
      return undefined;
    }
    let secret: string | undefined;
    if (stored) {
      const keep = "Keep the stored auth header";
      const change = "Change it";
      const drop = "Send none";
      const picked = await window.showQuickPick([keep, change, drop], { title: "Discovery server: auth header" });
      if (picked === undefined) {
        return undefined;
      }
      secret = picked === drop ? "" : picked === keep ? undefined : await this.askSecret();
      // Escape on the new header cancels the edit, not keeps the old (#1780).
      if (picked === change && secret === undefined) {
        return undefined;
      }
    } else {
      secret = await this.askSecret();
    }
    return secret === undefined && !stored ? undefined : { label: label.trim(), url: url.trim(), secret };
  }

  private askSecret(): Thenable<string | undefined> {
    return window.showInputBox({
      title: "Discovery server: auth header",
      password: true,
      prompt: "Sent as Authorization (such as Bearer <token>), or as Name: value. Kept in VS Code's secret storage. Leave empty for none.",
    });
  }

  private async add(fields?: ServerFields): Promise<void> {
    const servers = this.servers();
    const taken = new Set(servers.map((s) => s.label));
    let answer: { label: string; url: string; secret?: string } | undefined;
    if (fields?.label !== undefined && fields.url !== undefined) {
      const bad = serverLabelProblem(fields.label, taken) ?? urlProblem(fields.url);
      if (bad !== undefined) {
        void window.showErrorMessage(plainMessage(`q-lint: cannot add the discovery server: ${bad}`));
        return;
      }
      answer = { label: fields.label.trim(), url: fields.url.trim(), secret: fields.secret ?? "" };
    } else {
      answer = await this.ask({}, taken, false);
    }
    if (answer === undefined) {
      return;
    }
    // Read again: the list may have changed while the boxes were open.
    const now = this.servers();
    if (now.some((s) => s.label === answer.label)) {
      void window.showErrorMessage(plainMessage(`q-lint: the label "${answer.label}" was taken meanwhile; the discovery server was not added.`));
      return;
    }
    const server = { label: answer.label, url: answer.url };
    await this.keepSecret(server.label, answer.secret);
    await this.store([...now, server]);
    await this.fetch(server);
  }

  /// Forget the passwords given for the processes `label` listed: once the
  /// server is gone, or lists from another URL, a process of the same label
  /// may be another, at another host.
  private async forgetPasswords(label: string): Promise<void> {
    const given = this.given();
    const labels = new Set([...(this.states.get(label)?.processes ?? []).map((p) => p.label), ...(given[label] ?? [])]);
    for (const process of labels) {
      await this.context.secrets.delete(passwordKey({ label: qualified(label, process), server: label }));
    }
    delete given[label];
    await this.context.globalState.update(PASSWORDS_KEY, given);
    await this.keepSeen(label, []);
  }

  /// Forget the password of each process `label` now lists at another
  /// host, port, user or without TLS than where it was given (#1503): it
  /// would be sent there unasked. `before`: what it listed, when nothing
  /// was kept of where. One with neither - a password kept by a version
  /// before 0.37, which recorded nothing of where - is forgotten too, and
  /// asked for again: what is listed now may not be where it was given
  /// (#1878).
  private async forgetMoved(label: string, before: Process[], processes: Process[]): Promise<void> {
    const kept = this.seen()[label] ?? [];
    const seen = [...kept, ...before.filter((p) => !kept.some((k) => k.label === p.label))];
    const unplaced = (this.given()[label] ?? []).filter((g) => processes.some((p) => p.label === g) && !seen.some((s) => s.label === g));
    for (const process of [...passwordsToForget(seen, processes), ...unplaced]) {
      await this.context.secrets.delete(passwordKey({ label: qualified(label, process), server: label }));
      await this.passwordGiven(label, process, false);
    }
    await this.keepSeen(label, processes);
  }

  /// What `SEEN_KEY` holds, read as a list is.
  private seen(): Record<string, Process[]> {
    const stored = this.context.globalState.get<unknown>(SEEN_KEY, {});
    const out: Record<string, Process[]> = Object.create(null);
    if (typeof stored === "object" && stored !== null) {
      for (const [server, list] of Object.entries(stored)) {
        out[server] = parseProcesses(Array.isArray(list) ? list : []).processes;
      }
    }
    return out;
  }

  /// Keep where each process of `server` a password was given for is
  /// listed: in `listed`, or where it was last.
  private async keepSeen(server: string, listed: Process[]): Promise<void> {
    const all = this.seen();
    const given = new Set(this.given()[server] ?? []);
    const next = [...listed, ...(all[server] ?? []).filter((p) => !listed.some((l) => l.label === p.label))]
      .filter((p) => given.has(p.label))
      .map(({ label, host, port, user, tls }) => ({ label, host, port, tags: [], ...(user !== undefined ? { user } : {}), ...(tls ? { tls } : {}) }));
    if (next.length > 0) {
      all[server] = next;
    } else {
      delete all[server];
    }
    await this.context.globalState.update(SEEN_KEY, all);
  }

  /// What `PASSWORDS_KEY` holds, entries that are not lists of labels dropped.
  private given(): Record<string, string[]> {
    const stored = this.context.globalState.get<unknown>(PASSWORDS_KEY, {});
    const out: Record<string, string[]> = Object.create(null);
    if (typeof stored === "object" && stored !== null) {
      for (const [server, labels] of Object.entries(stored)) {
        if (Array.isArray(labels)) {
          out[server] = labels.filter((l): l is string => typeof l === "string");
        }
      }
    }
    return out;
  }

  /// Record, or with `kept` false unrecord, that a password was given for the
  /// process `label` that `server` lists (the label as the server lists it).
  async passwordGiven(server: string, label: string, kept = true): Promise<void> {
    const given = this.given();
    const labels = (given[server] ?? []).filter((l) => l !== label);
    given[server] = kept ? [...labels, label] : labels;
    if (given[server].length === 0) {
      delete given[server];
    }
    await this.context.globalState.update(PASSWORDS_KEY, given);
    await this.keepSeen(server, (this.states.get(server)?.processes ?? []).filter((p) => p.label === label));
  }

  private async keepSecret(label: string, secret: string | undefined): Promise<void> {
    if (secret === undefined) {
      return;
    }
    this.removals.set(label, (this.removals.get(label) ?? 0) + 1);
    await (secret.trim() === ""
      ? this.context.secrets.delete(secretKey(label))
      : this.context.secrets.store(secretKey(label), secret.trim()));
  }

  /// The server a command was given, or one the user picks.
  private async chosen(arg: ServerArg, title: string): Promise<DiscoveryServer | undefined> {
    const servers = this.servers();
    if (typeof arg === "string") {
      const named = servers.find((s) => s.label === arg);
      if (named === undefined) {
        void window.showErrorMessage(plainMessage(`q-lint: no discovery server is labelled "${arg}".`));
      }
      return named;
    }
    if (arg?.kind === "server") {
      return arg.server;
    }
    if (servers.length === 0) {
      void window.showInformationMessage("q-lint: no discovery servers yet.");
      return undefined;
    }
    const picked = await window.showQuickPick(
      servers.map((s) => ({ label: iconsEscaped(s.label), description: iconsEscaped(s.url), server: s })),
      { title, matchOnDescription: true },
    );
    return picked?.server;
  }

  private async edit(arg?: ServerArg, fields?: ServerFields): Promise<void> {
    const old = await this.chosen(arg, "Edit which discovery server?");
    if (old === undefined) {
      return;
    }
    const servers = this.servers();
    const taken = new Set(servers.map((s) => s.label).filter((l) => l !== old.label));
    const stored = (await this.context.secrets.get(secretKey(old.label))) !== undefined;
    let answer: { label: string; url: string; secret?: string } | undefined;
    if (fields !== undefined) {
      answer = { label: (fields.label ?? old.label).trim(), url: (fields.url ?? old.url).trim(), secret: fields.secret };
      const bad = serverLabelProblem(answer.label, taken) ?? urlProblem(answer.url);
      if (bad !== undefined) {
        void window.showErrorMessage(plainMessage(`q-lint: cannot change the discovery server: ${bad}`));
        return;
      }
    } else {
      answer = await this.ask(old, taken, stored);
    }
    if (answer === undefined) {
      return;
    }
    const now = this.servers();
    const problem = !now.some((s) => s.label === old.label)
      ? `"${old.label}" was deleted meanwhile`
      : answer.label !== old.label && now.some((s) => s.label === answer!.label)
        ? `the label "${answer.label}" was taken meanwhile`
        : undefined;
    if (problem !== undefined) {
      void window.showErrorMessage(plainMessage(`q-lint: ${problem}; the discovery server was not changed.`));
      return;
    }
    const server = { label: answer.label, url: answer.url };
    if (server.label !== old.label || server.url !== old.url) {
      await this.forgetPasswords(old.label);
    }
    if (server.label !== old.label) {
      const kept = await this.context.secrets.get(secretKey(old.label));
      await this.context.secrets.delete(secretKey(old.label));
      if (kept !== undefined && answer.secret === undefined) {
        await this.context.secrets.store(secretKey(server.label), kept);
      }
      this.states.delete(old.label);
    } else if (server.url !== old.url) {
      // What another URL listed is not this one's to keep when it fails (#3025).
      this.states.delete(old.label);
    }
    await this.keepSecret(server.label, answer.secret);
    await this.store(now.map((s) => (s.label === old.label ? server : s)));
    await this.fetch(server);
  }

  private async remove(arg?: ServerArg): Promise<void> {
    const server = await this.chosen(arg, "Delete which discovery server?");
    if (server === undefined) {
      return;
    }
    const yes = "Delete";
    const sure = await window.showWarningMessage(
      plainMessage(`Delete the discovery server "${server.label}"? Processes downloaded from it stay in the list.`),
      { modal: true },
      yes,
    );
    if (sure !== yes) {
      return;
    }
    await this.context.secrets.delete(secretKey(server.label));
    await this.forgetPasswords(server.label);
    this.states.delete(server.label);
    await this.store(this.servers().filter((s) => s.label !== server.label));
    await this.saved.gone?.(server.label);
  }

  /// Fetch the server given, or every server when given none.
  private async reload(arg?: ServerArg): Promise<void> {
    const servers = arg === undefined ? this.servers() : [await this.chosen(arg, "Reload which discovery server?")];
    await Promise.all(servers.flatMap((s) => (s === undefined ? [] : [this.fetch(s)])));
  }

  /// Copy what a server lists into the saved processes.
  private async download(arg?: ServerArg): Promise<void> {
    const server = await this.chosen(arg, "Download the processes of which discovery server?");
    if (server === undefined) {
      return;
    }
    const listed = this.states.get(server.label)?.processes ?? [];
    if (listed.length === 0) {
      void window.showInformationMessage(plainMessage(`q-lint: ${server.label} lists no processes to download. Reload it first.`));
      return;
    }
    const saved = this.saved.list();
    const { added, skipped } = toDownload(saved, listed);
    // The labels a password was copied for: no other is kept for one (#1887).
    const given: string[] = [];
    for (const [from, to, label] of downloadedPasswords(server.label, added)) {
      const password = await this.context.secrets.get(from);
      if (password !== undefined) {
        await this.context.secrets.store(to, password);
        given.push(label);
      }
    }
    await this.saved.save([...saved, ...added], given);
    const note = skipped.length ? ` Skipped ${skipped.length} whose label is taken: ${skipped.slice(0, 5).join(", ")}.` : "";
    void window.showInformationMessage(plainMessage(`q-lint: saved ${added.length} process(es) from ${server.label}.${note}`));
  }

  /// Drop what a server lists from the view, until it is reloaded.
  private async forget(arg?: ServerArg): Promise<void> {
    const server = await this.chosen(arg, "Remove the processes of which discovery server?");
    if (server !== undefined) {
      this.removals.set(server.label, (this.removals.get(server.label) ?? 0) + 1);
      this.set(server.label, { ...EMPTY_STATE, removed: true });
      await this.saved.gone?.(server.label);
    }
  }
}

/// The tree item of a row this file owns: the group, a server, a note.
export function discoveryItem(row: Row): TreeItem {
  if (row.kind === "servers") {
    const item = new TreeItem("Discovery Servers", TreeItemCollapsibleState.Expanded);
    item.iconPath = new ThemeIcon("globe");
    item.contextValue = "discoveryServers";
    return item;
  }
  if (row.kind === "server") {
    const { server, state } = row;
    const item = new TreeItem(server.label, TreeItemCollapsibleState.Expanded);
    item.description = serverDescription(state);
    item.iconPath = state.loading
      ? new ThemeIcon("sync~spin")
      : new ThemeIcon("cloud", state.error !== undefined ? new ThemeColor("errorForeground") : undefined);
    item.tooltip = new MarkdownString(
      serverTooltip(server, state.fetchedAt === undefined ? undefined : new Date(state.fetchedAt).toLocaleTimeString()),
    );
    item.contextValue = "discoveryServer";
    return item;
  }
  const text = row.kind === "note" ? row.text : "";
  const item = new TreeItem(text, TreeItemCollapsibleState.None);
  item.tooltip = text;
  if (row.kind === "note") {
    item.iconPath = new ThemeIcon(
      row.level === "error" ? "error" : row.level === "warning" ? "warning" : "info",
      row.level === "error" ? new ThemeColor("errorForeground") : row.level === "warning" ? new ThemeColor("editorWarning.foreground") : undefined,
    );
  }
  item.contextValue = "discoveryNote";
  return item;
}
