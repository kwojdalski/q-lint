// The Tickerplant Subscribers view (#1042): the connected tickerplant's
// `.u.w`, by table, read only when Refresh is pressed - never on a timer,
// never when the view is merely shown. The read is one fixed read-only
// lambda (`tpsubs.ts`) on the active connection, through `borrowWhenFree`
// as the Process Explorer reads, so it never interrupts a query. Off
// (q-lint.tickerplant.subscribers.enable), the view is gone, Refresh
// refuses and nothing is sent.
import { commands, window, workspace, type ExtensionContext } from "vscode";
import { borrowWhenFree } from "./infoview";
import type { Live } from "./live";
import { PROCESS_TOOL_COMMANDS, toolOff, toolOn } from "./processtools";
import { ToolTree } from "./toolstree";
import { SUBSCRIBERS, readSubscribers, subscriberTree, type Subscriber } from "./tpsubs";
import { plainMessage } from "./history";

export const SUBSCRIBERS_VIEW = "q-lint.tickerplantSubscribers";

export function registerTickerplantSubscribers(
  context: ExtensionContext,
  live: Live,
): { refresh: () => Promise<Subscriber[] | string>; tree: () => ToolTree } {
  const tree = new ToolTree(context, SUBSCRIBERS_VIEW, "tickerplantSubscribers");
  const on = (): boolean => toolOn((key, fallback) => workspace.getConfiguration("q-lint").get(key, fallback), "tickerplantSubscribers");
  const refresh = async (): Promise<Subscriber[] | string> => {
    if (!on()) {
      const off = toolOff("tickerplantSubscribers");
      void window.showInformationMessage(plainMessage(off));
      return off;
    }
    if (live.activeLabel() === undefined) {
      tree.show([], "Not connected: connect to a tickerplant, then Refresh.");
      return "not connected";
    }
    let got: { value: { process: string; subscribers: Subscriber[] } } | undefined;
    try {
      got = await borrowWhenFree(live, async (connection, process) => ({ process: process.label, subscribers: readSubscribers(await connection.call(SUBSCRIBERS, 0)) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tree.show([], message);
      return message;
    }
    if (got === undefined) {
      tree.show(tree.roots, "The process is busy with a query: Refresh again once it ends.");
      return "busy";
    }
    const { process, subscribers } = got.value;
    tree.show(
      subscriberTree(subscribers),
      subscribers.length === 0
        ? `${process}: no subscribers, read at ${new Date().toLocaleTimeString()}.`
        : `${process}: ${subscribers.length} subscription${subscribers.length === 1 ? "" : "s"}, read at ${new Date().toLocaleTimeString()}.`,
    );
    return subscribers;
  };
  context.subscriptions.push(commands.registerCommand(PROCESS_TOOL_COMMANDS.refreshSubscribers, refresh));
  return { refresh, tree: () => tree };
}
