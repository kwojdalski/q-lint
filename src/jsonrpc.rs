//! Language Server Protocol wire framing, shared by the qls client and the
//! server in `lsp.rs`.
//!
//! LSP is JSON-RPC 2.0 over a stream, with each message preceded by HTTP-style
//! headers and separated from them by a blank line. The only header that
//! matters is `Content-Length`; the rest are ignored by convention.
//!
//! Extracted from `qls.rs`, which had the only copy when the only thing this
//! crate did with LSP was talk to somebody else's server. Two copies of the
//! framing would be two places for a header bug to live, and a header bug
//! looks like a hang rather than an error - the reader blocks forever waiting
//! for bytes that were never counted.
use serde_json::{Value, json};
use std::io::{BufRead, Write};

/// Both caps exist so a malformed or hostile peer cannot make us allocate
/// without bound. 64 KiB of headers is already absurd - real ones are under
/// 60 bytes - and 16 MiB is far past any q source file.
const MAX_HEADER_BYTES: usize = 65536;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Write one message, stamping the JSON-RPC version.
///
/// Flushes: the peer is blocked reading, so a message left in the buffer is a
/// deadlock rather than a delay.
pub fn send(writer: &mut impl Write, mut value: Value) -> Result<(), String> {
    value["jsonrpc"] = json!("2.0");
    let body = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())
        .and_then(|_| writer.write_all(&body))
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}

/// A message the framing delimited but that is not a JSON-RPC message: bad
/// JSON, or JSON that is not an object. The stream is still in step - the
/// body was read to its `Content-Length` - so a server can answer with the
/// error JSON-RPC 2.0 defines for it and read the next message.
#[derive(Debug)]
pub struct Malformed {
    /// `-32700 Parse error` or `-32600 Invalid Request` (JSON-RPC 2.0 §5.1).
    pub code: i64,
    pub message: String,
}

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;

/// Read one message, or report why not.
///
/// `Ok(None)` means the peer closed the stream cleanly at a message boundary,
/// which is how a server learns its editor has gone away. That is distinct
/// from a stream that ends mid-message, which is an error. `Err` is reserved
/// for what loses the framing - after it there is no telling where the next
/// message starts; one bad message in a stream that is still in step is
/// `Ok(Some(Err(_)))`.
pub fn receive(reader: &mut impl BufRead) -> Result<Option<Result<Value, Malformed>>, String> {
    let mut length = None;
    let mut size = 0;
    // A header line that is not `name: value` is wrong, but the blank line
    // still ends the headers and `Content-Length` still counts the body.
    let mut bad_header = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return if size == 0 {
                Ok(None)
            } else {
                Err("stream closed part-way through LSP headers".into())
            };
        }
        size += line.len();
        if size > MAX_HEADER_BYTES {
            return Err("Invalid LSP headers".into());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let Some((k, v)) = line.split_once(':') else {
            bad_header = Some(line.trim_end().to_string());
            continue;
        };
        if k.eq_ignore_ascii_case("content-length") {
            length = Some(
                v.trim()
                    .parse::<usize>()
                    .map_err(|_| "Invalid LSP message size")?,
            );
        }
    }
    let length = length.ok_or("Invalid LSP message size")?;
    // Too big to hold, but counted: skipping it keeps the stream in step, so
    // one huge document costs that document rather than the whole session.
    if length > MAX_BODY_BYTES {
        let skipped = std::io::copy(
            &mut std::io::Read::take(&mut *reader, length as u64),
            &mut std::io::sink(),
        )
        .map_err(|e| e.to_string())?;
        if skipped < length as u64 {
            return Err("stream closed part-way through an LSP message".into());
        }
        return Ok(Some(Err(Malformed {
            code: INVALID_REQUEST,
            message: format!(
                "a message of {length} bytes is over the limit of {MAX_BODY_BYTES}; skipped"
            ),
        })));
    }
    let mut body = vec![0; length];
    std::io::Read::read_exact(reader, &mut body).map_err(|e| e.to_string())?;
    if let Some(line) = bad_header {
        return Ok(Some(Err(Malformed {
            code: PARSE_ERROR,
            message: format!("invalid LSP header: {line:?}"),
        })));
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(e) => {
            return Ok(Some(Err(Malformed {
                code: PARSE_ERROR,
                message: format!("invalid JSON: {e}"),
            })));
        }
    };
    if !value.is_object() {
        return Ok(Some(Err(Malformed {
            code: INVALID_REQUEST,
            message: "a message must be a JSON object".into(),
        })));
    }
    Ok(Some(Ok(value)))
}
