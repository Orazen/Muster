import { RuntimeEvent } from "./types";

/**
 * Server-Sent Events parser for the Muster harness event stream.
 * Handles the raw byte stream format documented in ios/Sources/CompanionCore/SSE.swift.
 */
export class SSEParser {
  private buffer: string = "";
  private eventLines: string[] = [];

  /**
   * Feed raw bytes from the event stream.
   * Returns parsed events as they become complete.
   */
  feed(data: string): RuntimeEvent[] {
    this.buffer += data;
    const events: RuntimeEvent[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      // Empty line = end of event
      if (line === "") {
        if (this.eventLines.length > 0) {
          const event = this.parseEvent(this.eventLines);
          if (event) events.push(event);
          this.eventLines = [];
        }
        continue;
      }

      // Skip comments (lines starting with :)
      if (line.startsWith(":")) continue;

      // Collect event data lines
      this.eventLines.push(line);
    }

    return events;
  }

  private parseEvent(lines: string[]): RuntimeEvent | null {
    let eventType = "";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (!eventType || dataLines.length === 0) return null;

    try {
      const data = JSON.parse(dataLines.join("\n"));
      // SAFETY: eventType is one of the known RuntimeEvent types from the harness event stream.
      // The data payload is validated by the harness before it reaches the phone.
      return { type: eventType as RuntimeEvent["type"], data };
    } catch {
      // Malformed JSON — skip this event
      return null;
    }
  }

  reset(): void {
    this.buffer = "";
    this.eventLines = [];
  }
}
