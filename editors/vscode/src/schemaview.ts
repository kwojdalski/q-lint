// Table templates (#965) and the schema diagram (#966): the VS Code around
// `schema.ts`.
//
// Table Templates, on a table of the Process Explorer, reads the table's
// details with TABLE_INFO - a fixed read-only lambda, borrowed as the
// explorer's hover is - and offers its templates: a read picked runs as the
// explorer's Preview does, through `Live.run`; the insert template opens in
// an editor and is never sent.
//
// Show Schema Diagram reads every table's details in one call of SCHEMA,
// and draws them in a panel with no script: the SVG is written here, every
// name in it escaped, under a policy that allows only the extension's
// stylesheet. Save as SVG and Copy as Mermaid take the diagram on show.
// Each has its own setting; the diagram's panel is closed when its setting
// is turned off.
import { Uri, ViewColumn, commands, env, window, workspace, type ExtensionContext, type WebviewPanel } from "vscode";
import { readExplorer, type Node } from "./explorer";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { SCHEMA, SCHEMA_COLUMNS, SCHEMA_COMMANDS, SCHEMA_PANEL, SCHEMA_TABLES, readSchema, readSchemaTools, schemaLinks, schemaMermaid, schemaSvg, tableTemplates, type SchemaTable } from "./schema";
import { TABLE_INFO, readTableInfo } from "./tableinfo";
import { plainMessage } from "./history";

/// Columns a template reads of a table: all a template writes out.
const TEMPLATE_COLUMNS = 500;

function config<T>(read: (get: <V>(key: string, fallback: V) => V) => T): T {
  const configuration = workspace.getConfiguration("q-lint");
  return read((key, fallback) => configuration.get(key, fallback));
}

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class SchemaTools {
  private panel: WebviewPanel | undefined;
  /// The diagram on show.
  private shown: { process: string; tables: SchemaTable[]; failed: { name: string; error: string }[]; svg: string } | undefined;

  constructor(private readonly context: ExtensionContext, private readonly live: Live) {
    context.subscriptions.push(
      commands.registerCommand(SCHEMA_COMMANDS.templates, (node?: Node) => this.on("templates") && this.templates(node)),
      commands.registerCommand(SCHEMA_COMMANDS.diagram, () => this.on("diagram") && this.diagram()),
      commands.registerCommand(SCHEMA_COMMANDS.saveSvg, (target?: Uri) => this.on("diagram") && this.saveSvg(target)),
      commands.registerCommand(SCHEMA_COMMANDS.mermaid, () => this.on("diagram") && this.copyMermaid()),
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("q-lint.processExplorer.schemaDiagram") && !config(readSchemaTools).diagram) {
          this.panel?.dispose();
          this.shown = undefined;
        }
      }),
      { dispose: () => this.panel?.dispose() },
    );
  }

  /// The diagram on show, for tests: its process, tables and links.
  state(): { process: string; tables: string[]; links: string[]; failed: string[]; svgBytes: number } | undefined {
    const s = this.shown;
    return s === undefined
      ? undefined
      : {
          process: s.process,
          tables: s.tables.map((t) => t.name),
          links: schemaLinks(s.tables).map((l) => `${l.from}.${l.column}->${l.to} (${l.kind})`),
          failed: s.failed.map((f) => f.name),
          svgBytes: s.svg.length,
        };
  }

  private on(feature: "templates" | "diagram"): boolean {
    if (config(readSchemaTools)[feature]) {
      return true;
    }
    const key = feature === "templates" ? "tableTemplates" : "schemaDiagram";
    void window.showInformationMessage(plainMessage(`q-lint: ${feature === "templates" ? "Table Templates" : "the schema diagram"} is turned off. Turn it on with the setting q-lint.processExplorer.${key}.enable.`));
    return false;
  }

  private async templates(node?: Node): Promise<void> {
    if (node?.kind !== "table" || node.name === undefined) {
      void window.showInformationMessage("q-lint: Table Templates works on a table of the Process Explorer: right-click one.");
      return;
    }
    const name = node.name;
    const process = this.live.activeLabel();
    let got;
    try {
      // Only the process the table was listed on, not one connected while
      // it waited (#1457).
      got = await borrowWhenFree(this.live, async (connection) => readTableInfo(await connection.call(TABLE_INFO, name, TEMPLATE_COLUMNS)), 5000, process);
    } catch (error) {
      void window.showWarningMessage(plainMessage(`q-lint: could not read ${name}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (got === undefined) {
      void window.showInformationMessage(plainMessage(`q-lint: could not read ${name}: not connected, or a query is still running. Try again once it ends.`));
      return;
    }
    const picked = await window.showQuickPick(
      tableTemplates(name, got.value).map((t) => ({
        label: t.label,
        description: t.detail,
        detail: t.runs ? t.code : t.code.split("\n")[1],
        template: t,
      })),
      { title: `q-lint: templates for ${name}` },
    );
    // Turned off at the pick: nothing is run or opened (#2421).
    if (picked === undefined || !this.on("templates")) {
      return;
    }
    if (picked.template.runs) {
      // On the process the table was read on: a TorQ gateway itself, not
      // its servers, whose table of that name is another (#3061).
      await this.live.run(picked.template.code, undefined, []);
    } else {
      const document = await workspace.openTextDocument({ language: "q", content: picked.template.code });
      await window.showTextDocument(document);
    }
  }

  private async diagram(): Promise<void> {
    const process = this.live.activeLabel();
    if (process === undefined) {
      void window.showInformationMessage("q-lint: connect to a q process first; the schema diagram draws its tables.");
      return;
    }
    const { excludedNamespaces } = config(readExplorer);
    let got;
    try {
      got = await borrowWhenFree(
        this.live,
        async (connection) => readSchema(await connection.call(SCHEMA, excludedNamespaces.join(" "), SCHEMA_TABLES, SCHEMA_COLUMNS)),
        5000,
        // The diagram is titled with this label: only its tables (#1457).
        process,
      );
    } catch (error) {
      void window.showWarningMessage(plainMessage(`q-lint: could not read the tables of ${process}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (got === undefined) {
      void window.showInformationMessage(plainMessage(`q-lint: could not read the tables of ${process}: a query is still running. Try again once it ends.`));
      return;
    }
    // Turned off while the tables were read: nothing to show (#1479).
    if (!this.on("diagram")) {
      return;
    }
    const { tables, failed } = got.value;
    this.shown = { process, tables, failed, svg: schemaSvg(tables) };
    this.show();
  }

  private show(): void {
    const shown = this.shown;
    if (shown === undefined) {
      return;
    }
    const media = Uri.joinPath(this.context.extensionUri, "media");
    if (this.panel === undefined) {
      const panel = window.createWebviewPanel(SCHEMA_PANEL, "q-lint: schema", { viewColumn: ViewColumn.Active }, { enableScripts: false, localResourceRoots: [media] });
      this.panel = panel;
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
      });
    }
    const webview = this.panel.webview;
    this.panel.title = `Schema: ${shown.process}`;
    const links = schemaLinks(shown.tables);
    const summary =
      shown.tables.length === 0
        ? `${shown.process} holds no tables.`
        : `${shown.tables.length} table${shown.tables.length === 1 ? "" : "s"} on ${shown.process}, ${links.length} link${links.length === 1 ? "" : "s"}${shown.tables.length >= SCHEMA_TABLES ? ` (the first ${SCHEMA_TABLES})` : ""}.`;
    webview.html = [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="UTF-8">',
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource};">`,
      `<link rel="stylesheet" href="${webview.asWebviewUri(Uri.joinPath(media, "schema.css")).toString()}">`,
      `<title>Schema: ${escape(shown.process)}</title></head><body>`,
      `<p class="summary">${escape(summary)}</p>`,
      '<p class="legend"><span class="fk">→ foreign key</span> <span class="link">→ link column</span> <span class="key">key column</span></p>',
      ...(shown.failed.length > 0 ? [`<p class="note">Not read: ${shown.failed.map((f) => `${escape(f.name)} (${escape(f.error)})`).join(", ")}</p>`] : []),
      shown.tables.length > 0 ? `<div class="diagram">${shown.svg}</div>` : "",
      "</body></html>",
    ].join("\n");
    this.panel.reveal(undefined, false);
  }

  private async saveSvg(target?: Uri): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no schema diagram yet. Show one first with q-lint: Show Schema Diagram.");
      return;
    }
    const folder = workspace.workspaceFolders?.[0]?.uri;
    const to =
      target instanceof Uri
        ? target
        : await window.showSaveDialog({
            title: "Save the schema diagram as SVG",
            defaultUri: folder === undefined ? undefined : Uri.joinPath(folder, "schema.svg"),
            filters: { SVG: ["svg"] },
          });
    if (to === undefined) {
      return;
    }
    // The page's stylesheet does not go with the file: plain colours do.
    const svg = shown.svg.replace(/(<svg[^>]*>)/, `$1\n<style>${STANDALONE_STYLE}</style>`);
    try {
      await workspace.fs.writeFile(to, Buffer.from(svg, "utf8"));
    } catch (error) {
      void window.showErrorMessage(plainMessage(`q-lint: could not write ${to.fsPath}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!(target instanceof Uri)) {
      void window.showInformationMessage(plainMessage(`q-lint: saved the schema diagram to ${to.fsPath}.`));
    }
  }

  private async copyMermaid(): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) {
      void window.showInformationMessage("q-lint: no schema diagram yet. Show one first with q-lint: Show Schema Diagram.");
      return;
    }
    await env.clipboard.writeText(schemaMermaid(shown.tables));
    void window.showInformationMessage(plainMessage(`q-lint: copied the schema of ${shown.process} as a Mermaid diagram.`));
  }
}

/// The diagram's colours in a file of its own, light on white.
const STANDALONE_STYLE = [
  ".box{fill:#fff;stroke:#888}",
  ".head{fill:#e8eef7;stroke:#888}",
  "text{fill:#222}",
  ".name{font-weight:bold}",
  ".key{text-decoration:underline}",
  ".type{fill:#777}",
  ".more{fill:#777;font-style:italic}",
  ".edge{stroke:#3a6ea5;stroke-width:1.5}",
  ".edge.link{stroke-dasharray:5 3}",
  ".arrowhead{fill:#3a6ea5}",
].join("");
