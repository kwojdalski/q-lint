// Reading a log file a piece at a time (#1004): from a byte offset to its
// end, line by line, never the whole file in memory, and keeping a line
// still being written for the next read. No `vscode` import, so node tests
// it on files appended while it reads.
import * as fs from "node:fs";

/// Where a file has been read to, the start of a line not yet ended, and
/// which file it was: its inode, once read.
export interface Position {
  offset: number;
  partial: string;
  ino?: number;
}

export const START: Position = { offset: 0, partial: "" };

/// Read `file` from `from` to its end now, calling `line` with each line
/// that ends (without its `\n` or `\r\n`); the position to read from next.
/// A file now shorter than `from` was truncated, and one that is another
/// file - renamed away and made again, as a log is rotated, however long
/// the new one has grown (#1688) - rotated: either is read again from its
/// start (`restarted`).
export async function readFrom(file: string, from: Position, line: (text: string) => void): Promise<Position & { restarted: boolean }> {
  const stat = await fs.promises.stat(file);
  const size = stat.size;
  // 0 where the file system has no inodes to tell files apart.
  const ino = stat.ino !== 0 ? stat.ino : undefined;
  let start = from;
  let restarted = false;
  if (size < from.offset || (from.ino !== undefined && ino !== undefined && from.ino !== ino)) {
    start = START;
    restarted = true;
  }
  if (size === start.offset) {
    return { ...start, ino, restarted };
  }
  // Bytes, not decoded text, are counted and split on `\n`: a byte that is
  // not UTF-8 decodes to U+FFFD, three bytes long (#1079).
  let partial = start.partial;
  const stream = fs.createReadStream(file, { start: start.offset, end: size - 1, highWaterMark: 256 * 1024 });
  let read = 0;
  let rest: Buffer = Buffer.alloc(0);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    read += chunk.length;
    const bytes = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
    let begin = 0;
    for (let nl = bytes.indexOf(0x0a); nl >= 0; nl = bytes.indexOf(0x0a, begin)) {
      const text = partial + bytes.toString("utf8", begin, nl);
      line(text.endsWith("\r") ? text.slice(0, -1) : text);
      partial = "";
      begin = nl + 1;
    }
    rest = bytes.subarray(begin);
  }
  // A character cut in two at the end is left for the next read.
  const held = cutCharacter(rest);
  partial += rest.toString("utf8", 0, rest.length - held);
  return { offset: start.offset + read - held, partial, ino, restarted };
}

/// How many bytes at the end of `bytes` start a UTF-8 character that is
/// not all there yet.
function cutCharacter(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const b = bytes[bytes.length - back];
    if ((b & 0xc0) !== 0x80) {
      const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      return length > back ? back : 0;
    }
  }
  return 0;
}
