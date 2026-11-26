// The join assistant (#1049): **q-lint: Join Assistant** asks for two
// tables - a table of the connected process, the query behind the result
// on show, or an expression typed - reads their shapes (`joinassist.ts`),
// and offers the joins they allow, each written out with its keys and
// sorts. The one picked is inserted at the cursor of the q editor (after
// the selection, never over it), or opened in a new q editor when none is
// active: the pick shows exactly what will be written.
//
// The tables are read through `Live.runOnActive`, with the two expressions
// as the code the read-only guard reads, since a query typed is the user's
// own code. Off (q-lint.query.joinAssistant.enable), the command refuses
// and nothing is sent.
import { Position, commands, window, workspace, type ExtensionContext } from "vscode";
import { borrowWhenFree } from "./infoview";
import { TABLES, TABLE_SHAPE, lastSelectedLine, readShape, shapeGuardCode, tableExpression, suggestJoins, type Shape, type Suggestion } from "./joinassist";
import type { Live } from "./live";
import { PROCESS_TOOL_COMMANDS, asCode, isString, listOf, toolOff, toolOn } from "./processtools";
import { statements } from "./statements";
import { iconsEscaped, plainMessage } from "./history";

const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "joinAssistant");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function say(text: string): string {
  void window.showInformationMessage(plainMessage(text));
  return text;
}

/// Write `text` where the user will see it, overwriting nothing: after the
/// selection (or at the cursor) of the active q editor, or in a new one.
export async function writeExpression(text: string): Promise<string> {
  const editor = window.activeTextEditor;
  if (editor !== undefined && editor.document.languageId === "q") {
    const last = lastSelectedLine(editor.selection);
    const at = editor.selection.isEmpty ? editor.selection.active : new Position(last, editor.document.lineAt(last).range.end.character);
    const insert = editor.selection.isEmpty ? text : `\n${text}`;
    await editor.edit((edit) => edit.insert(at, insert));
    return `inserted in ${editor.document.uri.toString()}`;
  }
  await window.showTextDocument(await workspace.openTextDocument({ language: "q", content: `${text}\n` }));
  return "opened in a new editor";
}

export function registerJoinAssistant(
  context: ExtensionContext,
  live: Live,
): { assist: (left?: string, right?: string, pick?: string) => Promise<Suggestion[] | string> } {
  /// One table: a name, the result's query, or an expression typed.
  const choose = async (title: string): Promise<string | undefined> => {
    const got = await borrowWhenFree(live, async (connection) => connection.call(TABLES, 0), 1000).catch(() => undefined);
    const names = got === undefined ? [] : (listOf(got.value, isString) ?? []);
    const result = live.resultOnShow();
    const TYPE = "Type an expression...";
    const picked = await window.showQuickPick(
      [
        ...(result !== undefined && statements(result.code).length === 1 ? [{ label: "Result on show", description: iconsEscaped(Array.from(result.code.trim()).slice(0, 80).join("")), value: result.code.trim() }] : []),
        ...names.map((n) => ({ label: iconsEscaped(n), description: "table", value: tableExpression(n) })),
        { label: TYPE, description: "a table's name or a query", value: "" },
      ],
      { title },
    );
    if (picked === undefined) {
      return undefined;
    }
    if (picked.label !== TYPE) {
      return picked.value;
    }
    return window.showInputBox({ title, prompt: "A table's name, or a query that answers a table: select from trade where date=last date." });
  };

  const assist = async (givenLeft?: string, givenRight?: string, givenPick?: string): Promise<Suggestion[] | string> => {
    if (!on()) {
      return say(toolOff("joinAssistant"));
    }
    if (live.activeLabel() === undefined && givenLeft === undefined) {
      return say("q-lint: not connected to a q process; connect to the one with the tables.");
    }
    // Its tables, and the list of them, would be read on the gateway itself (#2590).
    const refused = live.gatewayRefusal("Join Assistant", [givenLeft ?? "tables[]", givenRight ?? ""].join("\n"));
    if (refused !== undefined) {
      return say(refused);
    }
    const left = givenLeft ?? (await choose("Join Assistant (1 of 2): the left table"));
    if (left === undefined || left.trim() === "") {
      return "no left table";
    }
    const right = givenRight ?? (await choose(`Join Assistant (2 of 2): join ${left.trim()} with which table?`));
    if (right === undefined || right.trim() === "") {
      return "no right table";
    }
    const expressions = [left.trim(), right.trim()];
    let shapes: Shape[];
    try {
      const ran = await live.runOnActive(shapeGuardCode(expressions), async (connection) => [
        readShape(await connection.call(TABLE_SHAPE, asCode(expressions[0])), expressions[0]),
        readShape(await connection.call(TABLE_SHAPE, asCode(expressions[1])), expressions[1]),
      ], "ask", undefined, undefined, true);
      if (ran === undefined) {
        return "nothing was run";
      }
      shapes = ran.value;
    } catch (error) {
      return say(`q-lint: could not read the tables: ${message(error)}`);
    }
    if (!on()) {
      return say(toolOff("joinAssistant"));
    }
    const suggestions = suggestJoins(shapes[0], shapes[1]);
    if (suggestions.length === 0) {
      return say(`q-lint: ${expressions[0]} and ${expressions[1]} share no key, no time column and too few columns for lj, ij, uj, aj or wj.`);
    }
    const picked =
      givenPick !== undefined
        ? suggestions.find((s) => s.join === givenPick)
        : await window.showQuickPick(
            suggestions.map((s) => ({ label: s.join, description: s.expression, detail: s.why, suggestion: s })),
            { title: `Join ${expressions[0]} with ${expressions[1]}: the expression picked is written at the cursor`, matchOnDescription: true },
          ).then((p) => p?.suggestion);
    if (picked !== undefined) {
      await writeExpression(picked.expression);
    }
    return suggestions;
  };
  context.subscriptions.push(
    commands.registerCommand(PROCESS_TOOL_COMMANDS.joinAssistant, (left?: unknown, right?: unknown, pick?: unknown) =>
      assist(typeof left === "string" ? left : undefined, typeof right === "string" ? right : undefined, typeof pick === "string" ? pick : undefined),
    ),
  );
  return { assist };
}
