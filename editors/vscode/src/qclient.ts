// One connection to a q process, as promises.
//
// Values are encoded and decoded by node-q's codec (MIT,
// github.com/michaelwittig/node-q): every q type, and compressed messages.
// The connection around it is this file's, because an editor needs what
// node-q's own does not give: a connect that gives up and closes what it
// opened, one query at a time, and an abort that is immediate.
//
// The protocol (code.kx.com/q/basics/ipc): the client sends `user:password`,
// a capability byte and a NUL; the process answers one byte, or closes the
// socket to refuse. Each message after that has an 8-byte header - byte 0
// the byte order (1, little-endian), byte 1 the type (0 async, 1 sync,
// 2 response), bytes 4-7 the whole length - and a body.
import * as net from "node:net";
import * as tls from "node:tls";
import { deserialize, serialize } from "node-q/lib/c.js";
import { GRID, GRID_TREE, gridLambda, readGridAnswer, type GridAnswer } from "./grid";
import { RUN, readAnswer, type Answer } from "./query";

/// The process answered with an error (`'msg`), as against the connection
/// failing: the query ran, and this is what it gave.
export class QError extends Error {}

export interface Target {
  host: string;
  port: number;
  user?: string;
  password?: string;
  tls?: boolean;
  /// The name or address a TLS certificate is checked against, when `host`
  /// is not it: a tunnel's loopback end (#908).
  servername?: string;
}

/// How long a connect may take before it is given up.
export const CONNECT_TIMEOUT_MS = 10_000;
/// Compression, timestamps and timespans, and GUIDs: what a kdb+ 3 client
/// announces.
const CAPABILITY = 3;
const ASYNC = 0;
const SYNC = 1;
const RESPONSE = 2;
/// The response to a sync request from the process: a q error.
const SYNC_REFUSED = ((): Buffer => {
  const text = Buffer.from("q-lint answers no sync request", "utf8");
  const message = Buffer.alloc(10 + text.length);
  message.writeUInt8(1, 0);
  message.writeUInt8(RESPONSE, 1);
  message.writeUInt32LE(message.length, 4);
  message.writeInt8(-128, 8);
  text.copy(message, 9);
  return message;
})();

/// A list of statements as the codec must be given it. The codec sends a
/// string that starts with a backtick as a symbol - "`a`b" arrives as the
/// symbol `a`b, which `value` cannot run - so such a statement goes with a
/// space in front, which q reads past. Anything that is not a list of
/// strings goes as it is.
export function statementsOut(arg: unknown): unknown {
  return Array.isArray(arg) && arg.every((s) => typeof s === "string")
    ? arg.map((s: string) => (s.startsWith("`") ? ` ${s}` : s))
    : arg;
}

/// The q type of a message: the first byte of its body. A compressed body
/// starts, after its uncompressed length, with a flag byte and then that
/// byte as a literal, since nothing before it can be copied.
function typeOf(message: Buffer): number | undefined {
  if (message.readUInt8(2) !== 1) {
    return message.length > 8 ? message.readInt8(8) : undefined;
  }
  return message.length > 13 && (message.readUInt8(12) & 1) === 0 ? message.readInt8(13) : undefined;
}

/// The socket closed before the handshake was answered: how a process
/// refuses a user - and all that is seen of a tunnel whose far end reached
/// nothing, which `Live.dial` says in its own words (#1355).
export class ClosedBeforeHandshake extends Error {}

/// A connect's error with its reason in `message`. Node tries each address
/// of a name in turn - `localhost` is `::1` and `127.0.0.1` - and when all
/// fail gives an AggregateError whose own message is empty (#1352): the
/// reasons are in its `errors`.
export function withReason(error: Error): Error {
  if (error.message === "") {
    const inner = (error as { errors?: unknown }).errors;
    const reasons = Array.isArray(inner) ? inner.map((e) => (e instanceof Error ? e.message : "")).filter((m) => m !== "") : [];
    error.message = [...new Set(reasons)].join("; ") || (error as NodeJS.ErrnoException).code || "the connection failed";
  }
  return error;
}

export class QConnection {
  /// What has arrived of the messages not yet read, in the chunks it came
  /// in: joined only once a whole message is there, since joining each
  /// chunk onto all before it is quadratic in a large answer.
  private chunks: Buffer[] = [];
  private size = 0;
  private pending: { resolve: (v: unknown) => void; reject: (e: Error) => void } | undefined;
  private closed = false;
  /// The q type of the last answer, read from the first byte of its body.
  private answerType: number | undefined;
  /// The last answer, the whole message.
  private answerMessage: Buffer | undefined;
  private readonly onClose: (() => void)[] = [];
  /// Listeners for the async messages the process sends, each whole: a
  /// tickerplant's updates to a subscriber (#915).
  private readonly onAsync: ((message: Buffer) => void)[] = [];

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk) => this.received(chunk));
    socket.on("close", () => this.closedNow());
    // An error is followed by a close, which is what callers hear.
    socket.on("error", () => {});
  }

  /// Open a connection, or reject with why not within `timeoutMs` (with no
  /// limit when it is infinite), or once `signal` aborts. A connect given up
  /// is closed, so nothing is left open behind it.
  static open(target: Target, timeoutMs: number = CONNECT_TIMEOUT_MS, signal?: AbortSignal): Promise<QConnection> {
    return new Promise((resolve, reject) => {
      const options = { host: target.host, port: target.port };
      // The name the certificate must be for. An IP address cannot be sent
      // as the server name, and without one the check is against the host
      // dialled: a tunnel's loopback end. So an address given as
      // `servername` is checked here, against the certificate (#1356).
      const name = target.servername ?? target.host;
      const socket = target.tls
        ? tls.connect({
            ...options,
            servername: net.isIP(name) ? undefined : name,
            ...(target.servername !== undefined && net.isIP(name) ? { checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(name, cert) } : {}),
          })
        : net.connect(options);
      let settled = false;
      const cancelled = (): void => fail(new Error(`the connect to ${target.host}:${target.port} was cancelled`));
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancelled);
          socket.destroy();
          reject(error);
        }
      };
      // A timer cannot wait for ever: an infinite delay fires at once.
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => fail(new Error(`no answer from ${target.host}:${target.port} in ${timeoutMs / 1000} s`)), timeoutMs)
        : undefined;
      if (signal?.aborted) {
        cancelled();
        return;
      }
      signal?.addEventListener("abort", cancelled);
      socket.once("error", (error: Error) => fail(withReason(error)));
      // A process that refuses the user closes the socket without a byte.
      socket.once("close", () => fail(new ClosedBeforeHandshake(`${target.host}:${target.port} closed the connection: the user or password was refused`)));
      socket.once(target.tls ? "secureConnect" : "connect", () => {
        const auth = target.user !== undefined ? `${target.user}:${target.password ?? ""}` : "";
        socket.write(Buffer.concat([Buffer.from(auth, "utf8"), Buffer.from([CAPABILITY, 0])]));
      });
      socket.once("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        // q answers with one capability byte, 0 to 6, and a message after
        // it can only open with a header: endianness 0 or 1, type 0 to 2. A
        // service that speaks first (an SSH or SMTP banner) is not q.
        if (chunk[0] > 6 || (chunk.length > 1 && chunk[1] > 1) || (chunk.length > 2 && chunk[2] > 2)) {
          fail(new Error(`${target.host}:${target.port} answered the handshake, but not as a q process does: is it a q process?`));
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelled);
        socket.removeAllListeners();
        const connection = new QConnection(socket);
        // Anything after the capability byte is already a message.
        if (chunk.length > 1) {
          connection.received(chunk.subarray(1));
        }
        resolve(connection);
      });
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  get isBusy(): boolean {
    return this.pending !== undefined;
  }

  /// Run `statements` on the process and read the answer.
  query(statements: string[], size: [number, number]): Promise<Answer> {
    return this.call(RUN, statements, size).then(readAnswer);
  }

  /// Run `statements` as `query` does, and when the value is tabular have
  /// the process send its first `limit` rows for the result panel too;
  /// with `tree`, a dictionary's or a nested list's tree as well.
  queryGrid(statements: string[], size: [number, number], limit: number, tree = false, hold = false): Promise<GridAnswer> {
    const lambda = hold ? gridLambda(tree, true) : tree ? GRID_TREE : GRID;
    return this.call(lambda, statements, size, limit).then(readGridAnswer);
  }

  /// Send `text` as a char vector, as a client that sends a string does,
  /// for the process to evaluate as its `.z.pg` does (`value`, unless it is
  /// set): nothing of ours runs there. Resolves with the value as the codec
  /// decodes it, its q type and the message it came in; rejects with a
  /// `QError` for a q error.
  async evaluate(text: string): Promise<{ value: unknown; type: number | undefined; message?: Buffer }> {
    const body = Buffer.from(text, "utf8");
    // A char vector (type 10, no attribute, its length), built here: the
    // codec sends a string starting with a backtick as a symbol.
    const message = Buffer.alloc(14 + body.length);
    message.writeUInt8(1, 0);
    message.writeUInt8(SYNC, 1);
    message.writeUInt32LE(message.length, 4);
    message.writeInt8(10, 8);
    message.writeUInt32LE(body.length, 10);
    body.copy(message, 14);
    const value = await this.send(message);
    return { value, type: this.answerType, message: this.answerMessage };
  }

  /// Send `expression` applied to `args` as a sync message, and resolve with
  /// what q answers. One at a time: q answers a handle's messages in order,
  /// so a second would only wait behind the first.
  call(expression: string, ...args: unknown[]): Promise<unknown> {
    const sent = args.map(statementsOut);
    const message: Buffer = serialize(sent.length === 0 ? expression : [expression, ...sent]);
    message.writeUInt8(SYNC, 1);
    return this.send(message);
  }

  /// Send `expression` applied to `args` as an async message (#1037): q
  /// runs it and answers nothing, so this connection is not busy meanwhile;
  /// what the expression sends back with `neg[.z.w]` reaches `whenAsync`.
  sendAsync(expression: string, ...args: unknown[]): void {
    if (this.closed) {
      throw new Error("the connection is closed");
    }
    const sent = args.map(statementsOut);
    const message: Buffer = serialize(sent.length === 0 ? expression : [expression, ...sent]);
    message.writeUInt8(ASYNC, 1);
    this.socket.write(message);
  }

  private send(message: Buffer): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("the connection is closed"));
    }
    if (this.pending !== undefined) {
      return Promise.reject(new Error("a query is already running on this connection"));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.socket.write(message);
    });
  }

  /// Close now, a query running or not: the only way to stop waiting for
  /// one, since q has no message that cancels a query.
  abort(): void {
    this.socket.destroy();
    this.closedNow();
  }

  /// Close, letting the process see a clean end.
  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.whenClosed(resolve);
      this.socket.end();
      // A process that does not close its side is not waited for.
      setTimeout(() => this.abort(), 2000).unref();
    });
  }

  /// Run `listener` with each async message the process sends, as the
  /// whole message, header and all; a query's answer is not one.
  whenAsync(listener: (message: Buffer) => void): void {
    this.onAsync.push(listener);
  }

  /// Run `listener` once, when this connection closes for any reason.
  whenClosed(listener: () => void): void {
    if (this.closed) {
      listener();
    } else {
      this.onClose.push(listener);
    }
  }

  /// The chunks that have arrived, as one buffer.
  private joined(): Buffer {
    if (this.chunks.length !== 1) {
      this.chunks = [Buffer.concat(this.chunks, this.size)];
    }
    return this.chunks[0];
  }

  private received(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size >= 8) {
      const length = (this.chunks[0].length >= 8 ? this.chunks[0] : this.joined()).readUInt32LE(4);
      if (length < 8) {
        // Not a q message - a header is 8 bytes - and nothing after it can
        // be read: reading on would take the same 8 bytes for ever.
        this.fail(new Error(`the process sent a message of length ${length}, shorter than its header: is it a q process?`));
        return;
      }
      if (this.size < length) {
        return;
      }
      const all = this.joined();
      const message = all.subarray(0, length);
      const rest = all.subarray(length);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.size = rest.length;
      // Only a response answers a query. Async messages the user's code
      // sends back (`neg[.z.w] x`) are not results: they go to the async
      // listeners, a tickerplant stream's, and are otherwise dropped. A sync
      // one (`.z.w x`) waits for an answer, and the process with it, so it
      // gets an error: q-lint runs nothing a process sends it.
      if (message.readUInt8(1) === SYNC) {
        this.socket.write(SYNC_REFUSED);
        continue;
      }
      if (message.readUInt8(1) !== RESPONSE) {
        for (const listener of this.onAsync) {
          listener(message);
        }
        continue;
      }
      const pending = this.pending;
      this.pending = undefined;
      if (pending === undefined) {
        continue;
      }
      this.answerType = typeOf(message);
      this.answerMessage = message;
      try {
        pending.resolve(deserialize(message, false, true, false, false));
      } catch (error) {
        // A q error arrives as a message of type -128, which the codec
        // throws as an Error holding q's text - but an empty text as null,
        // so an uncompressed one's text is read from the message itself.
        const end = message.indexOf(0, 9);
        const text =
          this.answerType === -128 && message.readUInt8(2) !== 1
            ? message.subarray(9, end < 0 ? undefined : end).toString("utf8")
            : error instanceof Error
              ? error.message
              : String(error);
        pending.reject(this.answerType === -128 ? new QError(text) : error instanceof Error ? error : new Error(text));
      }
    }
  }

  /// Close now, failing a query running with `error`.
  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    this.abort();
  }

  private closedNow(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new Error("the connection closed before the process answered"));
    for (const listener of this.onClose.splice(0)) {
      listener();
    }
  }
}
