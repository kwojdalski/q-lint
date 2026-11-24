// The SQL tab for KDB-X (#1061): **q-lint: New SQL Query for Process** opens
// an untitled `.sql` editor bound to the q process picked, as New Query for
// Process binds a q one, and reads that process's tables and columns once,
// for completion. **q-lint: Run SQL** (the Run button in that editor's
// title) sends the
// selection, or the whole editor, to the process's SQL engine as
// `.s.e "..."` through the editor's query path - the bound process, the
// result panel, the history, the production confirmation. KDB-X's engine is
// loaded first where the process has none (`\l s.k_`), which the read-only
// guard asks about on a guarded process; a statement that changes data
// (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, ...) is asked about on a
// guarded process too, since the guard cannot read SQL inside a string.
// Completion offers the tables and the columns read when the editor opened,
// and asks the process nothing as you type.
//
// Off (q-lint.sql.enable), the commands are hidden and refuse, completion is
// disposed and nothing is sent.
import {
  CompletionItem,
  CompletionItemKind,
  commands,
  languages,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
} from "vscode";
import { findDiscovered } from "./discovery";
import { borrowWhenFree } from "./infoview";
import { LANGUAGE_COMMANDS, languageOff, languageOn } from "./languagefeatures";
import type { Live } from "./live";
import { CONTROL_COMMANDS } from "./querycontrols";
import { HAS_SQL, LOAD_SQL, SQL_SCHEMA, readSchema, sqlCompletions, sqlQuery, sqlText, sqlWrites } from "./sql";
import { plainMessage } from "./history";

export function registerSql(
  context: ExtensionContext,
  live: Live,
): { registered: () => boolean; schema: (uri: string) => Map<string, string[]> | undefined; editors: () => Map<string, string> } {
  const on = (): boolean => languageOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "sql");
  /// Each SQL editor this opened, by URI, and the process it is bound to.
  const editors = new Map<string, string>();
  const schemas = new Map<string, Map<string, string[]>>();
  let completion: Disposable | undefined;

  const readSchemaOf = async (label: string): Promise<void> => {
    if (live.activeLabel() !== label) {
      return;
    }
    let got;
    try {
      // Kept under `label`: only that process's schema (#1457).
      got = await borrowWhenFree(live, async (connection) => readSchema(await connection.call(SQL_SCHEMA)), undefined, label);
    } catch {
      // Moved elsewhere while it waited, or not read: no completions from it.
      return;
    }
    if (got !== undefined) {
      schemas.set(label, got.value);
    }
  };

  const sync = (): void => {
    if (on() && completion === undefined) {
      completion = languages.registerCompletionItemProvider(
        { language: "sql" },
        {
          provideCompletionItems: (document, position) => {
            const label = editors.get(document.uri.toString());
            const schema = label === undefined ? undefined : schemas.get(label);
            if (schema === undefined) {
              return [];
            }
            const before = document.lineAt(position.line).text.slice(0, position.character);
            return sqlCompletions(schema, before).map((c) => {
              const item = new CompletionItem(c.label, c.kind === "table" ? CompletionItemKind.Class : CompletionItemKind.Field);
              item.detail = c.detail;
              return item;
            });
          },
        },
        ".",
      );
    } else if (!on() && completion !== undefined) {
      completion.dispose();
      completion = undefined;
    }
  };
  sync();

  context.subscriptions.push(
    commands.registerCommand(LANGUAGE_COMMANDS.newSql, async (row?: unknown) => {
      if (!on()) {
        void window.showInformationMessage(plainMessage(languageOff("sql")));
        return undefined;
      }
      const process = await live.pick(row as never, "New SQL query for which q process?");
      if (process === undefined) {
        return undefined;
      }
      const document = await workspace.openTextDocument({ language: "sql", content: `-- SQL for ${process.label} (KDB-X .s.e); q-lint: Run SQL runs it\n` });
      await window.showTextDocument(document);
      await commands.executeCommand(CONTROL_COMMANDS.chooseFileConnection, process.label);
      editors.set(document.uri.toString(), process.label);
      await readSchemaOf(process.label);
      return { uri: document.uri.toString(), label: process.label };
    }),
    commands.registerCommand(LANGUAGE_COMMANDS.runSql, async () => {
      if (!on()) {
        void window.showInformationMessage(plainMessage(languageOff("sql")));
        return undefined;
      }
      const editor = window.activeTextEditor;
      if (editor === undefined || editor.document.languageId !== "sql") {
        void window.showInformationMessage("q-lint: Run SQL runs a .sql editor; open one with q-lint: New SQL Query for Process.");
        return undefined;
      }
      const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      if (sql.replace(/--[^\n]*/g, "").trim() === "") {
        return undefined;
      }
      const uri = editor.document.uri;
      // The process the query goes to, as queryCode picks it: the file's
      // binding, else the active connection - never the process the editor
      // was opened for, once its binding is gone.
      const label = live.fileBinding(uri) ?? live.activeLabel();
      // The text sent, not the text typed: dropping a comment can move a
      // quote and bring a write out of it (#1408).
      const writes = sqlWrites(sqlText(sql));
      if (label === undefined && writes.length > 0) {
        // The guard reads q, not the SQL inside `.s.e "..."`: it can only be
        // asked before the query, about a process known now.
        void window.showInformationMessage(plainMessage(`q-lint: connect to a process, or bind this editor to one, before running SQL that changes data (${writes.join(", ")}), so the read-only guard can check it.`));
        return undefined;
      }
      // A saved process, the connected one as connected to, or a discovered
      // or shared one by its qualified label (#1104).
      const process = label === undefined || writes.length === 0
        ? undefined
        : live.processes().find((p) => p.label === label) ??
          (label === live.activeLabel() ? live.activeProcess() : undefined) ??
          findDiscovered([...live.discovery.discovered(), ...live.sharedList()], label);
      if (label !== undefined && process === undefined && writes.length > 0) {
        void window.showInformationMessage(plainMessage(`q-lint: no q process is labelled "${label}", so the read-only guard cannot check this SQL that changes data (${writes.join(", ")}); nothing was run.`));
        return undefined;
      }
      if (process !== undefined && writes.length > 0) {
        // The guard reads q, not SQL: it is shown a q write so it asks as it
        // would for one.
        if (!(await live.guardAllows("`t insert ()", [process], `This SQL statement (${writes.join(", ")})`))) {
          return undefined;
        }
      }
      // The engine first, where the bound process is connected and has none;
      // one not connected yet loads it in the same query.
      const asked = label !== undefined && live.activeLabel() === label;
      if (asked) {
        const has = await borrowWhenFree(live, async (connection) => connection.call(HAS_SQL));
        if (has !== undefined && has.value === false) {
          try {
            await live.runOnActive(LOAD_SQL, (connection) => connection.call(LOAD_SQL));
          } catch (error) {
            void window.showWarningMessage(plainMessage(`q-lint: could not load KDB-X's SQL engine (s.k_): ${error instanceof Error ? error.message : String(error)}`));
            return undefined;
          }
        }
      }
      const code = sqlQuery(sql, !asked);
      await live.queryCode(code, uri);
      if (label !== undefined) {
        void readSchemaOf(label);
      }
      return code;
    }),
    workspace.onDidCloseTextDocument((d) => void editors.delete(d.uri.toString())),
    workspace.onDidChangeConfiguration((event) => event.affectsConfiguration("q-lint.sql") && sync()),
    { dispose: () => completion?.dispose() },
  );
  return { registered: () => completion !== undefined, schema: (uri) => schemas.get(editors.get(uri) ?? ""), editors: () => editors };
}
