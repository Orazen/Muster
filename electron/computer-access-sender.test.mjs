import { describe, expect, it } from "vitest";
import { isComputerAccessSender } from "./computer-access-sender.mjs";

function fixture(url = "http://127.0.0.1:8799/app") {
  const mainFrame = { url };
  const sender = { mainFrame, isDestroyed: () => false };
  return { event: { sender, senderFrame: mainFrame }, contents: new Set([sender]) };
}

describe("computer access IPC origin", () => {
  it("accepts only the owned main frame at its actual app origin", () => {
    const { event, contents } = fixture();
    expect(isComputerAccessSender(event, contents, "http://127.0.0.1:8799")).toBe(true);
    expect(isComputerAccessSender(event, new Set(), "http://127.0.0.1:8799")).toBe(false);
    expect(isComputerAccessSender({ ...event, senderFrame: { url: event.senderFrame.url } }, contents, "http://127.0.0.1:8799")).toBe(false);
  });
  it.each(["https://example.com/app", "http://127.0.0.1:8800/app", "http://localhost:8799/app", "file:///app", "data:text/html,hello", "http://name:secret@127.0.0.1:8799/app"])("rejects navigated frame %s", (url) => {
    const { event, contents } = fixture(url);
    expect(isComputerAccessSender(event, contents, "http://127.0.0.1:8799")).toBe(false);
  });
  it("rejects destroyed or incomplete senders", () => {
    const { event, contents } = fixture();
    event.sender.isDestroyed = () => true;
    expect(isComputerAccessSender(event, contents, "http://127.0.0.1:8799")).toBe(false);
    expect(isComputerAccessSender(null, contents, "http://127.0.0.1:8799")).toBe(false);
  });
  it("uses the configured development origin without accepting opaque origins", () => {
    const { event, contents } = fixture("http://127.0.0.1:5199/app");
    expect(isComputerAccessSender(event, contents, "http://127.0.0.1:5199")).toBe(true);
    event.senderFrame.url = "file:///app";
    expect(isComputerAccessSender(event, contents, "file:///other")).toBe(false);
  });
});
