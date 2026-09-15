import { describe, expect, it } from "vitest";

import { speechText } from "./speech-text";

describe("speechText", () => {
  it("passes plain prose through untouched", () => {
    expect(speechText("I finished the report for you.")).toBe("I finished the report for you.");
    expect(speechText("")).toBe("");
  });

  it("names code instead of reciting it", () => {
    const spoken = speechText("Here you go:\n\n```ts\nconst x = 1;\nconsole.log(x);\n```\nDone!");
    expect(spoken).toContain("[ts code shown on screen]");
    expect(spoken).not.toContain("console.log");
    expect(spoken).toContain("Done!");
  });

  it("keeps link words, drops URLs", () => {
    expect(speechText("See the [launch brief](https://example.com/brief).")).toBe("See the launch brief.");
    expect(speechText("visit https://example.com/x now")).toContain("[link]");
    expect(speechText("visit https://example.com/x now")).not.toContain("example.com");
  });

  it("dissolves markdown structure; paragraph breaks become spoken pauses", () => {
    const spoken = speechText("## Summary\n\n- **first** item\n- second\n\n1. step one\n2. step two");
    expect(spoken).toBe("Summary. first item second. step one step two");
  });

  it("collapses tables to readable cells", () => {
    const spoken = speechText("| Bot | Status |\n|---|---|\n| Ada | done |");
    expect(spoken).not.toContain("|");
    expect(spoken).toContain("Ada");
    expect(spoken).toContain("done");
  });

  it("drops emoji tone markers", () => {
    expect(speechText("Great work 🎉 team")).toBe("Great work team");
  });

  it("handles a stream cut mid code-fence", () => {
    const spoken = speechText("Building now:\n\n```sh\nnpm install --save");
    expect(spoken).toContain("[code shown on screen]");
    expect(spoken).not.toContain("npm install");
  });

  it("inline code keeps the word, loses the backticks", () => {
    expect(speechText("Run `muster up` to start")).toBe("Run muster up to start");
  });
});
