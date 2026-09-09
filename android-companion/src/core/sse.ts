// SSE parsing mirroring ios/Sources/CompanionCore/SSE.swift.
// The harness never sends an `event:` field — frames are identified by the
// `kind` inside the single JSON data line. `id:` carries "<streamId>:<seq>".

export interface SSEEvent {
  id: string | null;
  data: string;
}

export class SSEParser {
  private buffer = "";
  private id: string | null = null;
  private dataLines: string[] = [];

  // Feeds a decoded chunk, returns complete events in order.
  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = this.handleLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  private handleLine(line: string): SSEEvent | null {
    // Comment / keepalive (`: keepalive` every 25s on the harness).
    if (line.startsWith(":") || line.length === 0) {
      if (line.length === 0) return this.flush();
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      this.id = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    }
    // event:/retry: and anything else is ignored.
    return null;
  }

  private flush(): SSEEvent | null {
    if (this.dataLines.length === 0) {
      this.id = null;
      return null;
    }
    const event: SSEEvent = { id: this.id, data: this.dataLines.join("\n") };
    this.id = null;
    this.dataLines = [];
    return event;
  }

  // Called before a fresh connection: an incomplete event from a torn stream
  // is discarded, matching the iOS parser's reset semantics.
  reset(): void {
    this.buffer = "";
    this.id = null;
    this.dataLines = [];
  }
}
