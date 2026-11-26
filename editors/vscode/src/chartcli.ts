// The command-line chart (#1031): `node out/chartcli.js` draws a CSV or
// JSON table, or the answer to a q query, as an SVG file, for a report or
// a CI job, with nothing but node and the extension's own files. The work
// is `chartfile.ts`'s; this reads the arguments and the input and writes
// the file. A query is read first as the read-only guard reads one, and one
// that would change the process (assign, write a file, run a system
// command) is refused: a chart only reads.
//
//   node out/chartcli.js data.csv -o chart.svg --kind line --title "Fills"
//   node out/chartcli.js --host localhost --port 5000 \
//        --query "select avg px by 5 xbar time.minute from trade" -o px.svg
//
// A password for a query is read from QLINT_CHART_PASSWORD, never from the
// command line. The exit code is 0 when the file was written, 2 for wrong
// arguments and 1 for any other failure, said on stderr.
import { readFileSync, writeFileSync } from "node:fs";
import { CHART_KINDS, chartFromGrid, gridFromFile, gridFromPayload, type ChartKind, type ChartOptions } from "./chartfile";
import type { Grid } from "./grid";
import { writes } from "./guard";

export const USAGE = [
  "usage: node chartcli.js <file.csv|file.json|-> -o <out.svg> [options]",
  "       node chartcli.js --host <host> --port <port> --query <q> -o <out.svg> [options]",
  "",
  "options:",
  `  --kind <${CHART_KINDS.join("|")}>   default line`,
  "  --x <column>        the x axis (default: the first column)",
  "  --y <a,b,...>       the columns plotted (default: every numeric one)",
  "  --title <text>      a title over the chart",
  "  --width <px> --height <px>   default 800 by 450",
  "  --background <colour>        default #ffffff",
  "  --user <name>       for --query; the password is $QLINT_CHART_PASSWORD",
  "  --direct            for --query: send only plain strings, for a process that refuses a lambda",
  "",
  "Writes SVG only. A '-' file reads CSV from stdin (--json for JSON).",
].join("\n");

export interface CliArgs {
  input?: string;
  json: boolean;
  out: string;
  host?: string;
  port?: number;
  user?: string;
  query?: string;
  /// Send the query as plain strings, for a process that refuses a lambda (#2494).
  direct?: boolean;
  options: ChartOptions;
}

/// The arguments read, or why they cannot be.
export function parseArgs(argv: string[]): CliArgs | string {
  const options: ChartOptions = { kind: "line" };
  let input: string | undefined;
  let out: string | undefined;
  let json = false;
  let host: string | undefined;
  let port: number | undefined;
  let user: string | undefined;
  let query: string | undefined;
  let direct = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      switch (a) {
        case "-o":
        case "--out":
          out = value();
          break;
        case "--kind": {
          const k = value();
          if (!CHART_KINDS.includes(k as ChartKind)) return `--kind is one of ${CHART_KINDS.join(", ")}`;
          options.kind = k as ChartKind;
          break;
        }
        case "--x":
          options.x = value();
          break;
        case "--y":
          options.y = value().split(",").map((s) => s.trim()).filter(Boolean);
          break;
        case "--title":
          options.title = value();
          break;
        case "--width":
        case "--height": {
          const n = Number(value());
          if (!Number.isInteger(n) || n < 100 || n > 10000) return `${a} is a whole number of pixels, 100 to 10000`;
          options[a === "--width" ? "width" : "height"] = n;
          break;
        }
        case "--background":
          options.background = value();
          break;
        case "--json":
          json = true;
          break;
        case "--host":
          host = value();
          break;
        case "--port": {
          const n = Number(value());
          if (!Number.isInteger(n) || n < 1 || n > 65535) return "--port is a port number";
          port = n;
          break;
        }
        case "--user":
          user = value();
          break;
        case "--query":
          query = value();
          break;
        case "--direct":
          direct = true;
          break;
        case "-h":
        case "--help":
          return USAGE;
        default:
          if (a.startsWith("-") && a !== "-") return `unknown option ${a}\n\n${USAGE}`;
          if (input !== undefined) return `one input file only\n\n${USAGE}`;
          input = a;
      }
    } catch (error) {
      return (error as Error).message;
    }
  }
  if (out === undefined) return `-o names the SVG file to write\n\n${USAGE}`;
  if (query !== undefined && (host === undefined || port === undefined)) return "--query needs --host and --port";
  if (query === undefined && input === undefined) return `name a CSV or JSON file, or --query\n\n${USAGE}`;
  if (query !== undefined && input !== undefined) return "a file or --query, not both";
  if (direct && query === undefined) return "--direct is for --query";
  if (query !== undefined) {
    const changes = writes(query);
    if (changes.length > 0) return `the query would change the process (${changes.join("; ")}): a chart only reads`;
  }
  return { input, json, out, host, port, user, query, ...(direct ? { direct } : {}), options };
}

/// The grid a query answers, over a connection opened for it and closed.
async function queryGrid(args: CliArgs): Promise<Grid> {
  const { QConnection } = await import("./qclient");
  const { statements } = await import("./statements");
  const password = process.env.QLINT_CHART_PASSWORD;
  const connection = await QConnection.open({ host: args.host!, port: args.port!, ...(args.user ? { user: args.user, password: password ?? "" } : {}) });
  try {
    let answer;
    if (args.direct === true) {
      // Plain strings only, the grid made here from the typed answer (#2494).
      const { runUnwrapped } = await import("./querycontrols");
      connection.direct = () => ({ label: `${args.host}:${args.port}`, from: "process" });
      answer = await runUnwrapped(connection, statements(args.query!), { size: [25, 200], limit: 100_000, unlimited: false, grid: true });
    } else {
      answer = await connection.queryGrid(statements(args.query!), [25, 200], 100_000);
    }
    if (!answer.ok) throw new Error(`the query failed: ${answer.error}`);
    if (answer.grid === undefined) throw new Error("the query's answer is not a table");
    return gridFromPayload(answer.grid);
  } finally {
    await connection.close();
  }
}

/// Run with `argv` (the arguments after the script); the exit code.
export async function main(argv: string[], io = { out: (s: string) => process.stdout.write(s), err: (s: string) => process.stderr.write(s), stdin: () => readFileSync(0, "utf8") }): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    (args === USAGE ? io.out : io.err)(`${args}\n`);
    return args === USAGE ? 0 : 2;
  }
  try {
    const grid =
      args.query !== undefined
        ? await queryGrid(args)
        : args.input === "-"
          ? gridFromFile(args.json ? "stdin.json" : "stdin.csv", io.stdin())
          : gridFromFile(args.input!, readFileSync(args.input!, "utf8"));
    // A query's result past the rows asked for is charted as far as it
    // came, and says so, on the chart and here (#2456).
    const held = grid.cells[0]?.length ?? 0;
    const cut = args.query !== undefined && grid.total > held ? `the first ${held.toLocaleString("en-US")} of ${grid.total.toLocaleString("en-US")} rows` : undefined;
    const options = cut === undefined ? args.options : { ...args.options, title: args.options.title ? `${args.options.title} (${cut})` : cut };
    writeFileSync(args.out, chartFromGrid(grid, options));
    if (cut !== undefined) {
      io.err(`chart: the query answered ${grid.total.toLocaleString("en-US")} rows: only ${cut} are drawn\n`);
    }
    io.out(`wrote ${args.out}\n`);
    return 0;
  } catch (error) {
    io.err(`chart: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}
