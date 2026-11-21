// Reading a log file a piece at a time (#1004): from a byte offset to its
// end, line by line, never the whole file in memory, and keeping a line
// still being written for the next read. No `vscode` import, so node tests
// it on files appended while it reads.
import * as fs from "node:fs";

/// Where a file has been read to, and the start of a line not yet ended.
export interface Position {
  offset: number;
  partial: string;
}

export const START: Position = { offset: 0, partial: "" };

/// Read `file` from `from` to its end now, calling `line` with each line
/// that ends (without its `\n` or `\r\n`); the position to read from next.
/// A file now shorter than `from` was truncated or rotated, and is read
/// again from its start (`restarted`).
export async function readFrom(file: string, from: Position, line: (text: string) => void): Promise<Position & { restarted: boolean }> {
  const size = (await fs.promises.stat(file)).size;
  let start = from;
  let restarted = false;
  if (size < from.offset) {
    start = START;
    restarted = true;
  }
  if (size === start.offset) {
    return { ...start, restarted };
  }
  let partial = start.partial;
  const stream = fs.createReadStream(file, { start: start.offset, end: size - 1, encoding: "utf8", highWaterMark: 256 * 1024 });
  let read = 0;
  for await (const chunk of stream as AsyncIterable<string>) {
    read += Buffer.byteLength(chunk, "utf8");
    const text = partial + chunk;
    let begin = 0;
    for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", begin)) {
      line(text.slice(begin, nl > begin && text[nl - 1] === "\r" ? nl - 1 : nl));
      begin = nl + 1;
    }
    partial = text.slice(begin);
  }
  return { offset: start.offset + read, partial, restarted };
}
