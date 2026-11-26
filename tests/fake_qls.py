
import json, sys, time

ENCODINGS = {"utf-8": "utf-8", "utf-16": "utf-16-le", "utf-32": "utf-32-le"}
WIDTHS = {"utf-16": 2, "utf-32": 4}

def receive():
    headers = {}
    while (line := sys.stdin.buffer.readline()) != b"\r\n":
        if not line:
            sys.exit(0)
        key, value = line.decode().split(":", 1)
        headers[key.lower()] = value.strip()
    return json.loads(sys.stdin.buffer.read(int(headers["content-length"])))

def send(message):
    body = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    sys.stdout.buffer.flush()

while True:
    message = receive()
    method = message.get("method")
    if method == "initialize":
        if MODE == "crash":
            print("test server crashed", file=sys.stderr, flush=True)
            sys.exit(3)
        if MODE == "invalid":
            sys.stdout.buffer.write(b"Content-Length: 3\r\n\r\nxxx")
            sys.stdout.buffer.flush()
            sys.exit(0)
        if MODE == "init_error":
            send({"id": message["id"], "error": {"code": -32603, "message": "failed"}})
        elif MODE in ENCODINGS:
            assert MODE in message["params"]["capabilities"]["general"]["positionEncodings"]
            send({"id": message["id"], "result": {"capabilities": {"positionEncoding": MODE}}})
        else:
            send({"id": message["id"], "result": {"capabilities": {}}})
    elif method in {"textDocument/didOpen", "textDocument/didChange"}:
        document = message["params"]["textDocument"]
        if method == "textDocument/didChange":
            document["text"] = message["params"]["contentChanges"][0]["text"]
        if MODE == "silent":
            continue
        send({"id": 100, "method": "workspace/configuration", "params": {
            "items": [{"section": "q-lang-server.sourceFiles"}]}})
        reply = receive()
        assert reply["id"] == 100 and reply["result"][0]["includeGlob"] == []
        # Ignore unrelated notifications, and handle requests with no implementation.
        send({"method": "window/logMessage", "params": {"message": "working"}})
        send({"id": 101, "method": "test/unsupported"})
        assert receive()["error"]["code"] == -32601
        diagnostics = []
        if "BAD" in document["text"]:
            diagnostics = [{"range": {"start": {"line": 1, "character": 2},
                                      "end": {"line": 1, "character": 5}},
                            "message": "Invalid café", "code": "syntax", "severity": 2}]
        elif "WIDE" in document["text"]:
            # Counted as the encoding this server named has it; one that
            # named none counts bytes, as qls does.
            before, token = document["text"].split("\n")[0].split("WIDE")[0], "WIDE"
            start = len(before.encode(ENCODINGS.get(MODE, "utf-8"))) // WIDTHS.get(MODE, 1)
            diagnostics = [{"range": {"start": {"line": 0, "character": start},
                                      "end": {"line": 0, "character": start + len(token)}},
                            "message": "Wide", "code": "syntax", "severity": 2}]
        elif "HINT" in document["text"]:
            diagnostics = [{"range": {"start": {"line": 0, "character": 0},
                                      "end": {"line": 0, "character": 1}},
                            "message": "A suggestion", "severity": 4}]
        if MODE == "malformed":
            diagnostics = [{}]
        send({"method": "textDocument/publishDiagnostics", "params": {
            "uri": document["uri"], "diagnostics": diagnostics}})
    elif method == "shutdown":
        if MODE == "hang_shutdown":
            time.sleep(60)
        send({"id": message["id"], "result": None})
    elif method == "exit":
        if MODE == "eof_shutdown":
            sys.stdin.buffer.read()
        break
