// Paste as q Table (#967), Paste JSON as q and Copy Value as JSON (#968):
// the clipboard's CSV, TSV or JSON put into the editor as the q that gives
// it (`pastetable.ts`, `jsonq.ts`), and a q expression's value copied from
// the connected process as `.j.j` writes it.
//
// The pastes read only the clipboard and write only the editor, at the
// selection. Copy Value as JSON sends the expression through
// `Live.runOnActive`, so the read-only guard (#918) holds it when it would
// change a guarded process. Each has its switch: q-lint.pasteTable.enable,
// and q-lint.jsonConversion.enable for the two JSON commands.
import { commands, env, window, workspace, type ExtensionContext } from "vscode";
import { editorFeatureOff, editorFeatureOn, type EditorFeature } from "./editorfeatures";
import { jsonToQ, toJsonQuery } from "./jsonq";
import type { Live } from "./live";
import { PASTE, pasteTable, MAX_ROWS } from "./pastetable";
import { plainMessage } from "./history";

const on = (feature: EditorFeature): boolean => editorFeatureOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), feature);

/// Whether `feature` is on; says it is off, and how to turn it on, if not.
function allowed(feature: EditorFeature): boolean {
  if (!on(feature)) {
    void window.showInformationMessage(plainMessage(editorFeatureOff(feature)));
    return false;
  }
  return true;
}

/// Put `code` in place of the active editor's selection.
async function insert(code: string, what: string): Promise<boolean> {
  const editor = window.activeTextEditor;
  if (editor === undefined) {
    void window.showInformationMessage(plainMessage(`q-lint: ${what} writes into an editor; open one first.`));
    return false;
  }
  return editor.edit((edit) => {
    for (const selection of editor.selections) {
      edit.replace(selection, code);
    }
  });
}

/// Register the three commands. Each returns what it wrote, for tests.
export function registerPaste(context: ExtensionContext, live: Live): void {
  context.subscriptions.push(
    commands.registerCommand(PASTE.table, async (given?: string): Promise<string | undefined> => {
      if (!allowed("pasteTable")) {
        return undefined;
      }
      const text = typeof given === "string" ? given : await env.clipboard.readText();
      const table = pasteTable(text);
      if ("error" in table) {
        void window.showInformationMessage(plainMessage(`q-lint: Paste as q Table found nothing to paste: ${table.error}`));
        return undefined;
      }
      if (!(await insert(table.code, "Paste as q Table"))) {
        return undefined;
      }
      const kinds = table.names.map((n, i) => `${n} ${table.kinds[i]}`).join(", ");
      const cut = table.dropped > 0 ? ` The first ${MAX_ROWS.toLocaleString("en-US")} rows; ${table.dropped.toLocaleString("en-US")} more were left out.` : "";
      void window.showInformationMessage(
        plainMessage(`q-lint: pasted ${table.rows} row${table.rows === 1 ? "" : "s"}${table.header ? " under a header" : ", with no header row"}: ${kinds}.${cut}`),
      );
      return table.code;
    }),
    commands.registerCommand(PASTE.json, async (given?: string): Promise<string | undefined> => {
      if (!allowed("jsonConversion")) {
        return undefined;
      }
      const text = typeof given === "string" ? given : await env.clipboard.readText();
      const got = jsonToQ(text);
      if ("error" in got) {
        void window.showInformationMessage(plainMessage(`q-lint: Paste JSON as q: ${got.error}`));
        return undefined;
      }
      return (await insert(got.code, "Paste JSON as q")) ? got.code : undefined;
    }),
    commands.registerCommand(PASTE.copyJson, async (given?: string): Promise<string | undefined> => {
      if (!allowed("jsonConversion")) {
        return undefined;
      }
      const file = typeof given === "string" ? undefined : window.activeTextEditor?.document.uri;
      const expression = typeof given === "string" ? given : await live.codeFromEditor();
      if (expression === undefined) {
        return undefined;
      }
      // The editor's value is copied from its file's process (#2442).
      if (!(await live.toFileBinding(file))) {
        return undefined;
      }
      try {
        // On a TorQ gateway, its servers' values joined as Run joins them,
        // made JSON on the gateway (#2433); elsewhere under the backstop,
        // or on a direct process as the plain string it is (#2482).
        const joined = live.gatewayJoinedOnActive(expression, "{.j.j raze x}");
        const ran = await live.runOnActive(expression, (connection) =>
          joined !== undefined
            ? connection.call(joined)
            : connection.isDirect
              ? connection.callPlain(toJsonQuery(expression))
              : connection.guarded((evaluate) => toJsonQuery(expression, evaluate)),
        );
        if (ran === undefined) {
          return undefined;
        }
        if (typeof ran.value !== "string") {
          void window.showInformationMessage(plainMessage(`q-lint: ${ran.process} did not answer with JSON text.`));
          return undefined;
        }
        await env.clipboard.writeText(ran.value);
        void window.showInformationMessage(plainMessage(`q-lint: copied the value from ${ran.process} as JSON (${ran.value.length.toLocaleString("en-US")} characters).`));
        return ran.value;
      } catch (error) {
        void window.showErrorMessage(plainMessage(`q-lint: Copy Value as JSON failed: ${error instanceof Error ? error.message : String(error)}`));
        return undefined;
      }
    }),
  );
}
