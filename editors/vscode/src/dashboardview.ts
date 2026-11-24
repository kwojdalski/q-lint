// Dashboards of saved queries (#1030) in the editor: **Open Dashboard**
// shows a panel of tiles, each a saved query run on a saved process and
// shown as a table or a chart, and **Add to Dashboard**, on a saved query,
// adds one. What is kept, and what a tile may run, is `dashboard.ts`'s.
//
// A tile runs over a connection of its own (`Live.runApart`, as Query a Tag
// does), so the active connection is left alone; its connect script runs
// first and the query timeout holds. It runs when the panel opens, on its
// Refresh, and every so many seconds only when given an interval: none is
// set unless you set one. A refresh due while the last is still out is
// skipped. Off (q-lint.dashboards.enable), the panel closes, every timer
// stops and nothing is sent; closing the panel stops its timers too.
//
// The page loads only the extension's own files, under a
// Content-Security-Policy that allows no inline code and no network; a
// chart is the SVG `chartSvg` draws, shown as an image, and every name and
// cell goes in as text.
import { randomBytes } from "node:crypto";
import { Uri, ViewColumn, commands, window, workspace, type ExtensionContext, type Webview, type WebviewPanel } from "vscode";
import { chartFromGrid } from "./chartfile";
import {
  DASHBOARDS_KEY,
  REFRESH_CHOICES,
  TILE_ROWS,
  TILE_VIEWS,
  changed,
  dashboardNameProblem,
  parseDashboards,
  tileQueryProblem,
  withDashboard,
  type Dashboard,
  type Tile,
  type TileChange,
  type TileContent,
  type TileView,
} from "./dashboard";
import { DB_COMMANDS, dbOff, dbOn } from "./dbfeatures";
import { toGrid, type GridAnswer } from "./grid";
import type { Live } from "./live";
import { parseSaved, SAVED_QUERIES_KEY, type SavedQuery } from "./savedqueries";
import { plainMessage } from "./history";

const on = (): boolean => dbOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "dashboards");

function say(message: string): string {
  void window.showInformationMessage(plainMessage(message));
  return message;
}

/// What a tile shows of an answer.
export function tileContent(answer: GridAnswer, view: TileView): TileContent {
  if (!answer.ok) return { kind: "error", text: answer.error };
  if (answer.grid === undefined) return { kind: "text", text: answer.text.join("\n") };
  const grid = toGrid(answer.grid, -1);
  if (view === "table") {
    const n = Math.min(TILE_ROWS, grid.cells[0]?.length ?? 0);
    return { kind: "table", columns: grid.columns.map((c) => c.name), rows: [...Array(n).keys()].map((r) => grid.cells.map((c) => c[r] ?? "")), total: grid.total };
  }
  try {
    return { kind: "chart", svg: chartFromGrid(grid, { kind: view, width: 640, height: 320, background: "#ffffff" }), total: grid.total, drawn: grid.cells[0]?.length ?? 0 };
  } catch (error) {
    return { kind: "error", text: error instanceof Error ? error.message : String(error) };
  }
}

export class Dashboards {
  private panel: WebviewPanel | undefined;
  private shown: string | undefined;
  /// Each tile's timer and the seconds it was set for.
  private readonly timers = new Map<string, { timer: ReturnType<typeof setInterval>; every: number }>();
  private readonly running = new Set<string>();
  /// What each tile last showed, for tests.
  readonly contents = new Map<string, TileContent>();
  /// Each tile's last answer, shaped again when its view changes rather
  /// than run again (#1630).
  private readonly answers = new Map<string, GridAnswer>();
  /// When each of them was worked out, as its tile says it.
  private readonly at = new Map<string, string>();
  /// Queries sent, by tile, for tests.
  runs = 0;

  constructor(
    private readonly context: ExtensionContext,
    private readonly live: Live,
  ) {
    context.subscriptions.push(
      commands.registerCommand(DB_COMMANDS.openDashboard, (name?: unknown) => this.open(typeof name === "string" ? name : undefined)),
      commands.registerCommand(DB_COMMANDS.addToDashboard, (query?: unknown, dashboard?: unknown, process?: unknown) =>
        this.add(query as SavedQuery | string | undefined, typeof dashboard === "string" ? dashboard : undefined, typeof process === "string" ? process : undefined),
      ),
      workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.dashboards") && !on() && this.close()),
      { dispose: () => this.close() },
    );
  }

  list(): Dashboard[] {
    return parseDashboards(this.context.workspaceState.get<unknown>(DASHBOARDS_KEY, []));
  }

  private async save(list: Dashboard[]): Promise<void> {
    await this.context.workspaceState.update(DASHBOARDS_KEY, list);
  }

  private saved(): SavedQuery[] {
    return parseSaved(this.context.workspaceState.get<unknown>(SAVED_QUERIES_KEY, []));
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /// Timers running, for tests.
  timerCount(): number {
    return this.timers.size;
  }

  /// The seconds each running timer was set for, for tests.
  timerSeconds(): number[] {
    return [...this.timers.values()].map(({ every }) => every);
  }

  /// A new dashboard named `given`, or a name asked for when none is given
  /// or it cannot be one (the box then holds it); undefined on Escape.
  private async create(given?: string): Promise<Dashboard | undefined> {
    const taken = this.list().map((d) => d.name);
    const name =
      given !== undefined && dashboardNameProblem(given, taken) === undefined
        ? given
        : await window.showInputBox({ title: "Name the new dashboard", value: given, validateInput: (v) => dashboardNameProblem(v, taken) });
    if (name === undefined || dashboardNameProblem(name, taken) !== undefined) return undefined;
    const d: Dashboard = { name: name.trim(), columns: 2, tiles: [] };
    await this.save(withDashboard(this.list(), d));
    return d;
  }

  async open(name?: string): Promise<string> {
    if (!on()) return say(dbOff("dashboards"));
    const list = this.list();
    let d = name === undefined ? undefined : list.find((x) => x.name === name);
    if (d === undefined) {
      const fresh = "$(add) New dashboard...";
      const pick = name !== undefined ? undefined : await window.showQuickPick([...list.map((x) => x.name), fresh], { title: "Open which dashboard?" });
      if (pick === undefined && name === undefined) return "cancelled";
      // A name that is no dashboard's makes one of that name (#1268).
      d = pick === fresh || pick === undefined ? await this.create(name) : list.find((x) => x.name === pick);
    }
    if (d === undefined) return "cancelled";
    this.show(d);
    return d.name;
  }

  async add(query?: SavedQuery | string, dashboard?: string, processLabel?: string): Promise<string> {
    if (!on()) return say(dbOff("dashboards"));
    const saved = this.saved();
    const name = typeof query === "string" ? query : query?.name ?? (await window.showQuickPick(saved.map((q) => q.name), { title: "Add which saved query?" }));
    if (name === undefined) return "cancelled";
    const found = saved.find((q) => q.name === name);
    if (found === undefined) return say(`q-lint: there is no saved query ${name}.`);
    const problem = tileQueryProblem(found.code);
    if (problem !== undefined) return say(`q-lint: ${name} cannot be a tile: ${problem}.`);
    let d = dashboard === undefined ? undefined : this.list().find((x) => x.name === dashboard);
    if (d === undefined && dashboard !== undefined) {
      // A dashboard named that does not exist yet: it is made.
      const problem = dashboardNameProblem(dashboard, this.list().map((x) => x.name));
      if (problem !== undefined) return say(`q-lint: ${problem}.`);
      d = { name: dashboard.trim(), columns: 2, tiles: [] };
    }
    if (d === undefined) {
      const fresh = "$(add) New dashboard...";
      const pick = await window.showQuickPick([...this.list().map((x) => x.name), fresh], { title: `Add ${name} to which dashboard?` });
      if (pick === undefined) return "cancelled";
      d = pick === fresh ? await this.create() : this.list().find((x) => x.name === pick);
    }
    if (d === undefined) return "cancelled";
    const process = processLabel ?? (await this.live.pick(undefined, `Run ${name} on which process?`))?.label;
    if (process === undefined) return "cancelled";
    const tile: Tile = { id: randomBytes(6).toString("hex"), query: name, process, view: "table", refresh: 0 };
    const next = { ...d, tiles: [...d.tiles, tile] };
    await this.save(withDashboard(this.list(), next));
    // Only the new tile runs: the others are drawn from what they showed.
    if (this.shown === next.name) this.render(next, false);
    return tile.id;
  }

  private show(d: Dashboard): void {
    if (this.panel === undefined) {
      this.panel = window.createWebviewPanel("q-lint.dashboard", `Dashboard: ${d.name}`, ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [Uri.joinPath(this.context.extensionUri, "media")],
      });
      this.panel.webview.html = dashboardHtml(this.panel.webview, Uri.joinPath(this.context.extensionUri, "media"));
      this.panel.webview.onDidReceiveMessage((m: unknown) => void this.received(m));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.shown = undefined;
        this.stopTimers();
      });
    } else {
      this.panel.title = `Dashboard: ${d.name}`;
      this.panel.reveal();
    }
    this.shown = d.name;
    this.render(d, true);
  }

  close(): void {
    this.stopTimers();
    this.panel?.dispose();
    this.panel = undefined;
    this.shown = undefined;
  }

  private stopTimers(): void {
    for (const { timer } of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private current(): Dashboard | undefined {
    return this.shown === undefined ? undefined : this.list().find((x) => x.name === this.shown);
  }

  /// Post the layout, set each tile's timer, and run the tiles (all, or
  /// those with nothing shown yet).
  private render(d: Dashboard, runAll: boolean): void {
    void this.panel?.webview.postMessage({
      type: "layout",
      name: d.name,
      columns: d.columns,
      views: TILE_VIEWS,
      intervals: REFRESH_CHOICES,
      tiles: d.tiles,
    });
    // A timer goes with its tile's interval, and is set again when the
    // interval changes (#1123).
    for (const [id, { timer, every }] of this.timers) {
      if (!d.tiles.some((x) => x.id === id && x.refresh > 0 && x.refresh === every)) {
        clearInterval(timer);
        this.timers.delete(id);
      }
    }
    for (const tile of d.tiles) {
      if (tile.refresh > 0 && !this.timers.has(tile.id)) {
        this.timers.set(tile.id, {
          timer: setInterval(() => {
            const now = this.current()?.tiles.find((x) => x.id === tile.id);
            if (now !== undefined && on()) void this.runTile(now, true);
          }, tile.refresh * 1000),
          every: tile.refresh,
        });
      }
      const content = this.contents.get(tile.id);
      if (runAll || content === undefined) void this.runTile(tile, true);
      else void this.panel?.webview.postMessage({ type: "tile", id: tile.id, content, at: this.at.get(tile.id) });
    }
  }

  /// Run one tile and post what it shows. Skipped while its last run is out.
  /// Run `tile` and show its answer. `unattended`: not on the user's
  /// Refresh - on open or its interval - so nothing modal is asked (#1618).
  async runTile(tile: Tile, unattended = false): Promise<void> {
    if (!on() || this.running.has(tile.id)) return;
    const post = (content: TileContent) => {
      const at = new Date().toLocaleTimeString();
      this.contents.set(tile.id, content);
      this.at.set(tile.id, at);
      void this.panel?.webview.postMessage({ type: "tile", id: tile.id, content, at });
    };
    const query = this.saved().find((q) => q.name === tile.query);
    if (query === undefined) return post({ kind: "error", text: `There is no saved query ${tile.query} any more.` });
    const problem = tileQueryProblem(query.code);
    if (problem !== undefined) return post({ kind: "error", text: `Not run: ${problem}.` });
    // Saved, discovered or shared, as Add to Dashboard offered it (#1122).
    const process = this.live.named(tile.process);
    if (process === undefined) return post({ kind: "error", text: `There is no q process ${tile.process}.` });
    this.running.add(tile.id);
    void this.panel?.webview.postMessage({ type: "running", id: tile.id });
    try {
      this.runs++;
      const answer = await this.live.runApart(process, query.code, undefined, { unattended });
      this.answers.set(tile.id, answer);
      // Shown as the tile is set now: its view can change while the run is out (#1339).
      post(tileContent(answer, this.current()?.tiles.find((x) => x.id === tile.id)?.view ?? tile.view));
    } catch (error) {
      post({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running.delete(tile.id);
    }
  }

  private async received(m: unknown): Promise<void> {
    const msg = m as { type?: string; id?: string } & Record<string, unknown>;
    const d = this.current();
    if (d === undefined || !on()) return;
    if (msg.type === "ready") {
      this.render(d, false);
      return;
    }
    if (msg.type === "refresh" && typeof msg.id === "string") {
      const tile = d.tiles.find((t) => t.id === msg.id);
      if (tile !== undefined) await this.runTile(tile);
      return;
    }
    if (msg.type === "refresh-all") {
      for (const t of d.tiles) void this.runTile(t);
      return;
    }
    if (msg.type === "add") {
      await this.add(undefined, d.name);
      return;
    }
    const change = msg as unknown as TileChange;
    if (["refresh-interval", "view", "move", "remove", "columns"].includes(String(msg.type))) {
      const next = changed(d, change);
      await this.save(withDashboard(this.list(), next));
      // A new view shapes the last answer again; nothing is run (#1630).
      const held = change.type === "view" && typeof msg.id === "string" ? this.answers.get(msg.id) : undefined;
      const tile = next.tiles.find((x) => x.id === msg.id);
      if (held !== undefined && tile !== undefined) {
        this.contents.set(tile.id, tileContent(held, tile.view));
      }
      this.render(next, false);
    }
  }

  /// Hand a message to the panel as its page would, for tests.
  receive(m: unknown): Promise<void> {
    return this.received(m);
  }
}

function dashboardHtml(webview: Webview, media: Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const file = (name: string): string => webview.asWebviewUri(Uri.joinPath(media, name)).toString();
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${file("dashboard.css")}">`,
    "<title>q-lint: dashboard</title></head><body>",
    `<script nonce="${nonce}" src="${file("refocus.js")}"></script>`,
    `<script nonce="${nonce}" src="${file("dashboard.js")}"></script>`,
    "</body></html>",
  ].join("\n");
}
