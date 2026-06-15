// LSP Content-Length framing over WebContainer process streams.
//
// The language server speaks the JSON-RPC-over-stdio framing from LSP:
//   Content-Length: <N>\r\n
//   \r\n
//   <N bytes of JSON>
//
// WebContainer hands us a ReadableStream<string> (text chunks, already
// utf-8 decoded) on `proc.output` and a WritableStream<string> on
// `proc.input`. We adapt both into the MessageReader / MessageWriter
// shape that vscode-jsonrpc expects.

import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type Disposable,
  type Message,
  type DataCallback,
  type MessageReader,
  type MessageWriter,
} from 'vscode-jsonrpc';

/** Reader: pull utf-8 string chunks off the WC stream and emit framed messages. */
export class WcStreamReader extends AbstractMessageReader implements MessageReader {
  private callback: DataCallback | null = null;
  private buffer = '';
  private disposed = false;
  private reader: ReadableStreamDefaultReader<string> | null = null;

  constructor(private stream: ReadableStream<string>) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    this.pump();
    return {
      dispose: () => {
        this.disposed = true;
        try { this.reader?.cancel(); } catch { /* noop */ }
      },
    };
  }

  private async pump() {
    try {
      this.reader = this.stream.getReader();
      while (!this.disposed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        this.buffer += value;
        this.drain();
      }
    } catch (err) {
      if (!this.disposed) this.fireError(err);
    } finally {
      if (!this.disposed) this.fireClose();
    }
  }

  private drain() {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed — drop the bad header, keep going.
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      // WebContainer streams emit utf-8 as strings; length is bytes,
      // so encode to verify we have enough.
      const bodyCandidate = this.buffer.slice(bodyStart);
      const bytes = new TextEncoder().encode(bodyCandidate);
      if (bytes.byteLength < length) return; // wait for more

      const bodyBytes = bytes.slice(0, length);
      const bodyText = new TextDecoder('utf-8').decode(bodyBytes);
      const remaining = new TextDecoder('utf-8').decode(bytes.slice(length));
      this.buffer = remaining;

      try {
        const msg = JSON.parse(bodyText) as Message;
        this.callback?.(msg);
      } catch (err) {
        this.fireError(err);
      }
    }
  }
}

/** Writer: JSON.stringify + Content-Length header → WC process stdin. */
export class WcStreamWriter extends AbstractMessageWriter implements MessageWriter {
  private writer: WritableStreamDefaultWriter<string>;
  private errored = false;

  constructor(stream: WritableStream<string>) {
    super();
    this.writer = stream.getWriter();
  }

  async write(msg: Message): Promise<void> {
    if (this.errored) return;
    try {
      const body = JSON.stringify(msg);
      const bytes = new TextEncoder().encode(body).byteLength;
      await this.writer.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
    } catch (err) {
      this.errored = true;
      this.fireError(err, msg, 0);
    }
  }

  end(): void {
    try { this.writer.close(); } catch { /* noop */ }
  }

  dispose(): void {
    super.dispose();
    try { this.writer.releaseLock(); } catch { /* noop */ }
  }
}
