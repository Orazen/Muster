import {describe, expect, it} from "vitest";
import {setupSurface} from "./setup-surface";
const base = {ready:true,gateDecision:"show" as const,firstRun:true};
describe("one account setup owner", () => {
  it("waits for both account decision and hydration", () => {
    expect(setupSurface({...base,ready:false})).toBe("pending");
    expect(setupSurface({...base,gateDecision:"pending"})).toBe("pending");
  });
  it.each([undefined,{required:false,satisfied:true},{required:true,satisfied:false},{required:true,satisfied:true}])("one wizard for fresh accounts, storage %j", storage => {
    expect(setupSurface({...base,storage})).toBe("wizard");
  });
  it("completed accounts do not get an empty-roster interview", () => {
    expect(setupSurface({...base,gateDecision:"hide"})).toBe("workspace");
  });
  it("repairs revoked storage without requiring another completed interview", () => {
    expect(setupSurface({...base,gateDecision:"hide",storage:{required:true,satisfied:false}})).toBe("wizard");
  });
  it("returns OAuth consent to its one setup flow without trusting success", () => {
    expect(setupSurface({...base,gateDecision:"hide",connectionReturn:true})).toBe("wizard");
    expect(setupSurface({...base,gateDecision:"hide",connectionReturn:true,firstRun:false})).toBe("workspace");
  });
  it("deferring never starts a second interview", () => {
    expect(setupSurface({...base,firstRun:false})).toBe("workspace");
    expect(setupSurface({...base,firstRun:false,storage:{required:true,satisfied:false}})).toBe("connection-notice");
  });
});
