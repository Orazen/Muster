import { describe, expect, it } from "vitest";
import { FLOWER_POSES, poseFor, type FlowerPose } from "./flower.js";

/** Counts the pose channels a pose actually differs from idle on — the
 * blobatar legibility rule: every expression must move at least 3 channels
 * so no two neighbours read the same at a glance. */
function channelCount(pose: FlowerPose): number {
  return (["esx", "esy", "tilt", "edy", "edx", "esx2", "esy2", "tilt2", "edy2", "bdy"] as const).filter(
    (k) => pose[k] !== undefined,
  ).length;
}

describe("FLOWER_POSES", () => {
  it("has an idle pose with no channel overrides", () => {
    expect(FLOWER_POSES.idle).toEqual({});
  });

  it("every non-idle pose differs from idle on at least 3 channels", () => {
    for (const [name, pose] of Object.entries(FLOWER_POSES)) {
      if (name === "idle") continue;
      expect(channelCount(pose), `pose ${name}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("poseFor", () => {
  it("defaults to idle", () => {
    expect(poseFor("standing by")).toBe("idle");
    expect(poseFor(null)).toBe("idle");
    expect(poseFor(undefined)).toBe("idle");
  });

  it("covers the app state vocabulary", () => {
    expect(poseFor("celebrating")).toBe("happy");
    expect(poseFor("sleeping")).toBe("sleepy");
    expect(poseFor("searching the web")).toBe("thinking");
    expect(poseFor("writing code")).toBe("focused");
    expect(poseFor("task failed")).toBe("mad");
    expect(poseFor("surprised")).toBe("surprised");
    expect(poseFor("reviewing changes")).toBe("smug");
    expect(poseFor("shy")).toBe("shy");
    expect(poseFor("sick")).toBe("sick");
  });
});
