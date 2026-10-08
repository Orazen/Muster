import { describe, expect, it } from "vitest";
// @ts-expect-error The shipped public catalog is deliberately plain ESM.
import { CREW, CREW_ROLES, isCrewRole } from "../../../www/landing-workroom/v1/mascot/crew.js";
// @ts-expect-error The production costume module uses the locally vendored Three.js engine.
import { createRoleOutfit } from "../../../www/landing-workroom/v1/mascot/role-outfits.js";
// @ts-expect-error This is the exact Three.js copy used by the shipped renderer.
import * as THREE from "../../../www/landing-workroom/v1/mascot/vendor/three.module.js";
// @ts-expect-error Read the approved surface without extracting a new sculpt per test.
import { faceDepth } from "../../../www/landing-workroom/v1/mascot/sculpt.js";
// @ts-expect-error The approved motion engine is shared unchanged by every costume.
import { STATES, sampleMotion } from "../../../www/landing-workroom/v1/mascot/companion.js";
// @ts-expect-error The approved face engine is shared unchanged by every costume.
import { resolveFace } from "../../../www/landing-workroom/v1/mascot/expressions.js";
import {
  CREW as APP_CREW, CREW_CHARACTERS, CREW_STATES,
  crewMotionState, isCrewCharacter, normalizeCrewState,
} from "./crew";

type Role = "designer" | "researcher" | "developer" | "coordinator";
type Vector = { x: number; y: number; z: number; set(x: number, y: number, z: number): void; toArray(): number[] };
type Resource = { dispose(): void; addEventListener(name: string, listener: () => void): void };
type Geometry = Resource & { attributes: { position: { array: ArrayLike<number> } } };
type Node = {
  name: string; parent: Node | null; children: Node[]; position: Vector; rotation: Vector;
  scale: Vector; matrixWorld: { elements: number[] }; geometry?: Geometry; material?: Resource | Resource[];
  add(...nodes: Node[]): void; traverse(callback: (node: Node) => void): void;
  getObjectByName(name: string): Node | undefined; updateMatrixWorld(force: boolean): void;
};
type Outfit = {
  role: Role; group: Node; roots: Node[];
  update(input: { time?: number; weights?: Record<string, number>; intensity?: number }): void;
  dispose(): void;
};
function rig() {
  // SAFETY: the real Three.js Group inherits these Object3D methods, checked by anchor/matrix tests below.
  const robot = new THREE.Group() as Node;
  // SAFETY: the real Three.js Bone inherits Object3D; its child ownership and rotations are exercised below.
  const leftArm = new THREE.Bone() as Node;
  // SAFETY: the second actual Bone has the same checked Object3D contract, with an independent parent and pose.
  const rightArm = new THREE.Bone() as Node;
  leftArm.position.set(-.69, 2.32, -.015); rightArm.position.set(.69, 2.32, -.015);
  // SAFETY: BoxGeometry is a BufferGeometry with a position attribute and dispose events, exercised below.
  const geometry = new THREE.BoxGeometry(.1, .1, .1) as Geometry;
  // SAFETY: the actual Three material exposes dispose and its event dispatcher; the ownership test observes both.
  const material = new THREE.MeshStandardMaterial({ color: "#eee04d" }) as Resource;
  // SAFETY: the actual Mesh owns the supplied geometry/material and inherits the Object3D traversal contract.
  const body = new THREE.Mesh(geometry, material) as Node;
  body.name = "existing-body"; robot.add(body, leftArm, rightArm);
  return { robot, leftArm, rightArm, faceDepth, geometry, material, body };
}
function costume(role: Role, owner: ReturnType<typeof rig>): Outfit {
  // SAFETY: the local ESM factory returns this documented contract; tests exercise all roots, update and disposal.
  return createRoleOutfit(role, owner) as Outfit;
}
function resourcesFor(outfit: Outfit): Set<Resource> {
  const resources = new Set<Resource>();
  for (const root of outfit.roots) root.traverse(node => {
    if (node.geometry) resources.add(node.geometry);
    if (node.material) for (const material of Array.isArray(node.material) ? node.material : [node.material]) resources.add(material);
  });
  return resources;
}
function matrices(outfit: Outfit): number[][] {
  const values: number[][] = [];
  for (const root of outfit.roots) root.traverse(node => values.push([...node.matrixWorld.elements]));
  return values;
}
function cleanup(owner: ReturnType<typeof rig>, outfit: Outfit) {
  outfit.dispose(); owner.geometry.dispose(); owner.material.dispose();
}

describe("Muster crew catalog compatibility", () => {
  it("has four immutable identities with matching app colours and distinct costumes", () => {
    expect(CREW_ROLES).toEqual(["designer", "researcher", "developer", "coordinator"]);
    expect(CREW_CHARACTERS).toEqual(CREW_ROLES);
    expect(Object.isFrozen(CREW)).toBe(true);
    expect(Object.isFrozen(CREW_ROLES)).toBe(true);
    for (const role of CREW_CHARACTERS) {
      expect(Object.isFrozen(CREW[role])).toBe(true);
      expect(APP_CREW[role].color).toBe(CREW[role].color);
      expect(APP_CREW[role].label).toBe(CREW[role].name);
      expect(Object.hasOwn(STATES, CREW[role].workState)).toBe(true);
    }
    expect(new Set(CREW_CHARACTERS.map(role => CREW[role].color)).size).toBe(4);
    expect(new Set(CREW_CHARACTERS.map(role => CREW[role].costume)).size).toBe(4);
  });

  it("rejects unknown, inherited and legacy values without reclassifying saved avatars", () => {
    for (const value of ["", "default", "flower", "blob", "constructor", "toString", "__proto__", "Designer", null, undefined]) {
      expect(isCrewRole(value), String(value)).toBe(false);
      expect(isCrewCharacter(value), String(value)).toBe(false);
    }
    for (const value of [1, true, {}, ["designer"]]) expect(isCrewRole(value)).toBe(false);
    for (const role of CREW_CHARACTERS) expect(isCrewCharacter(role)).toBe(true);
  });

  it("keeps the full 40-state vocabulary including thinking-dots", () => {
    expect(new Set(CREW_STATES)).toEqual(new Set(Object.keys(STATES)));
    expect(CREW_STATES).toHaveLength(40);
    for (const state of CREW_STATES) expect(normalizeCrewState(state)).toBe(state);
    for (const state of ["", "constructor", "unknown", null, undefined]) expect(normalizeCrewState(state)).toBe("idle");
    expect(crewMotionState("none")).toBeNull();
    expect(crewMotionState("celebrate")).toBe("celebrate");
  });
});

const requiredMeshes = {
  designer: ["designer-beret-crown", "designer-apron", "designer-swatch-0", "designer-pencil"],
  researcher: ["researcher-glasses-left", "researcher-vest-left", "researcher-notebook-cover", "researcher-magnifier-rim", "researcher-magnifier-lens"],
  developer: ["developer-hood", "developer-hoodie", "developer-laptop-screen", "developer-laptop-base", "developer-code-left", "developer-code-right", "developer-code-slash"],
  coordinator: ["coordinator-jacket-left", "coordinator-headset-band", "coordinator-taskboard-cover", "coordinator-task-dot-0", "coordinator-task-dot-1", "coordinator-task-dot-2"],
} satisfies Record<Role, string[]>;

describe.each(["designer", "researcher", "developer", "coordinator"] as const)("%s actual Three.js outfit", role => {
  it("adds real role geometry to body/fin anchors without replacing the existing rig", () => {
    const owner = rig(), outfit = costume(role, owner);
    try {
      expect(outfit.group.parent).toBe(owner.robot);
      expect(outfit.roots[1].parent).toBe(owner.leftArm);
      expect(outfit.roots[2].parent).toBe(owner.rightArm);
      expect(owner.body.parent).toBe(owner.robot);
      for (const name of requiredMeshes[role]) {
        const node = owner.robot.getObjectByName(name);
        expect(node?.geometry, name).toBeDefined();
        expect(node!.geometry!.attributes.position.array.length, name).toBeGreaterThan(36);
        expect(Array.from(node!.geometry!.attributes.position.array).every(Number.isFinite), name).toBe(true);
      }
      expect(owner.robot.getObjectByName("existing-body")).toBe(owner.body);
    } finally { cleanup(owner, outfit); }
  });

  it("leaves both oval-eye centres unobstructed by front accessories", () => {
    const owner = rig(), outfit = costume(role, owner);
    try {
      owner.robot.updateMatrixWorld(true);
      for (const x of [-.335, .335]) {
        const ray = new THREE.Raycaster(new THREE.Vector3(x, 2.92, 5), new THREE.Vector3(0, 0, -1));
        // SAFETY: Three.js ray intersections provide a world-space Vector3 point and the hit Object3D.
        const hits = ray.intersectObjects(outfit.roots, true) as { point: Vector; object: Node }[];
        const obscuring = hits.filter(hit => hit.point.z > faceDepth(x, 2.92) + .023);
        expect(obscuring.map(hit => hit.object.name)).toEqual([]);
      }
    } finally { cleanup(owner, outfit); }
  });

  it("runs its work gesture deterministically without modifying rig poses or expression inputs", () => {
    const owner = rig(), outfit = costume(role, owner);
    try {
      owner.leftArm.rotation.set(.14, .03, -.2); owner.rightArm.rotation.set(-.23, 0, .31);
      const before = [owner.leftArm.rotation.toArray(), owner.rightArm.rotation.toArray()];
      const weights = Object.freeze({ working: 1, listening: 1 });
      outfit.update({ time: .1, weights }); owner.robot.updateMatrixWorld(true);
      const start = matrices(outfit);
      outfit.update({ time: .8, weights }); owner.robot.updateMatrixWorld(true);
      const changed = matrices(outfit);
      expect(changed).not.toEqual(start);
      outfit.update({ time: .8, weights }); owner.robot.updateMatrixWorld(true);
      expect(matrices(outfit)).toEqual(changed);
      expect([owner.leftArm.rotation.toArray(), owner.rightArm.rotation.toArray()]).toEqual(before);
      expect(weights).toEqual({ working: 1, listening: 1 });
      outfit.update({ time: .2, weights, intensity: 0 }); owner.robot.updateMatrixWorld(true);
      const still = matrices(outfit);
      outfit.update({ time: 50, weights, intensity: 0 }); owner.robot.updateMatrixWorld(true);
      expect(matrices(outfit)).toEqual(still);
    } finally { cleanup(owner, outfit); }
  });

  it("accepts every original emotion and morph without changing their face or motion result", () => {
    const owner = rig(), outfit = costume(role, owner);
    try {
      for (const state of Object.keys(STATES)) {
        const weights = Object.freeze({ [state]: 1 });
        const input = Object.freeze({ active: state, weights, time: 1.7, stateTime: 1.7, intensity: .65 });
        const pose = sampleMotion(input);
        const face = resolveFace({ state, time: 1.7, stateTime: 1.7 });
        owner.robot.scale.set(pose.scale, pose.scale * pose.scaleY, pose.scale);
        owner.leftArm.rotation.set(pose.leftX, 0, pose.left);
        owner.rightArm.rotation.set(pose.rightX, 0, pose.right);
        outfit.update(input); owner.robot.updateMatrixWorld(true);
        expect(matrices(outfit).flat().every(Number.isFinite), state).toBe(true);
        expect(sampleMotion(input), state).toEqual(pose);
        expect(resolveFace({ state, time: 1.7, stateTime: 1.7 }), state).toEqual(face);
      }
    } finally { cleanup(owner, outfit); }
  });

  it("detaches and disposes every owned mesh/material once, retaining shared body resources", () => {
    const owner = rig(), outfit = costume(role, owner);
    const counts = new Map<Resource, number>();
    let bodyDisposals = 0;
    for (const resource of resourcesFor(outfit)) {
      counts.set(resource, 0);
      resource.addEventListener("dispose", () => counts.set(resource, (counts.get(resource) ?? 0) + 1));
    }
    owner.geometry.addEventListener("dispose", () => { bodyDisposals++; });
    owner.material.addEventListener("dispose", () => { bodyDisposals++; });
    outfit.dispose(); outfit.dispose(); outfit.update({ time: 10, weights: { working: 1 } });
    expect([...counts.values()].every(count => count === 1)).toBe(true);
    expect(outfit.roots.every(root => root.parent === null)).toBe(true);
    expect(owner.leftArm.children).toEqual([]); expect(owner.rightArm.children).toEqual([]);
    expect(owner.robot.children).toEqual([owner.body, owner.leftArm, owner.rightArm]);
    expect(bodyDisposals).toBe(0);
    owner.geometry.dispose(); owner.material.dispose();
  });
});

it("keeps the researcher's whole magnifier lens outside the torso and below the visor", () => {
  const owner = rig(), outfit = costume("researcher", owner);
  try {
    owner.robot.updateMatrixWorld(true);
    const lens = owner.robot.getObjectByName("researcher-magnifier-lens");
    expect(lens).toBeDefined();
    const [x, y, z] = lens!.matrixWorld.elements.slice(12, 15);
    // A .183-radius disc must not be hidden behind the approved body contour.
    expect(x - .183).toBeGreaterThan(faceDepth(0, y) / .82);
    expect(y + .183).toBeLessThan(2.29);
    expect(z).toBeGreaterThan(.5);
  } finally { cleanup(owner, outfit); }
});

it("rejects an unknown outfit before attaching anything to the rig", () => {
  const owner = rig();
  try {
    expect(() => createRoleOutfit("constructor", owner)).toThrow("Unknown Muster crew role");
    expect(owner.robot.children).toEqual([owner.body, owner.leftArm, owner.rightArm]);
    expect(owner.leftArm.children).toEqual([]); expect(owner.rightArm.children).toEqual([]);
  } finally { owner.geometry.dispose(); owner.material.dispose(); }
});
