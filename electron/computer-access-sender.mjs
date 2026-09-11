// Only an app-owned top-level renderer at the expected app origin may ask
// main to start native computer control. A subframe or later navigation to
// another site must not inherit this action from a preload bridge.
export function isComputerAccessSender(event, appContents, appUrl) {
  try {
    const sender = event?.sender;
    if (!appContents.has(sender) || sender.isDestroyed() || !event.senderFrame ||
        event.senderFrame !== sender.mainFrame) return false;
    const expected = new URL(appUrl);
    const actual = new URL(event.senderFrame.url);
    return (expected.protocol === "http:" || expected.protocol === "https:") &&
      actual.origin === expected.origin && !actual.username && !actual.password;
  } catch {
    return false;
  }
}
