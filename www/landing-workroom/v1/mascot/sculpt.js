import * as THREE from './vendor/three.module.js';
import { MarchingCubes } from './vendor/MarchingCubes.js';

// A single closed surface: rounded crown, pear torso, tapered floating tip,
// and two fins grown into the shoulders. There are no separate limb meshes.
const PROFILE = [
  [.20, 0], [.28, .27], [.45, .44], [.72, .61], [1.05, .74],
  [1.40, .85], [1.72, .89], [2.00, .875], [2.23, .815],
  [2.48, .774], [2.73, .80], [2.95, .82], [3.75, 0],
].map(([y, radius]) => [y, radius * radius]);
const slopes = PROFILE.map(([y, radius], i, values) => {
  if (i === 0) return (values[1][1] - radius) / (values[1][0] - y);
  if (i === values.length - 1) return (radius - values[i - 1][1]) / (y - values[i - 1][0]);
  const before = (radius - values[i - 1][1]) / (y - values[i - 1][0]);
  const after = (values[i + 1][1] - radius) / (values[i + 1][0] - y);
  // Monotone Hermite interpolation cannot create unwanted neck rings.
  return before * after <= 0 ? 0 : 2 * before * after / (before + after);
});

function radiusAt(y) {
  if (y <= PROFILE[0][0] || y >= PROFILE.at(-1)[0]) return 0;
  // The crown is an exact ellipse, rather than a spline approaching a point.
  if (y >= 2.95) return .82 * Math.sqrt(Math.max(0, 1 - ((y - 2.95) / .80) ** 2));
  let i = 0;
  while (i < PROFILE.length - 2 && PROFILE[i + 1][0] < y) i++;
  const [a, ra] = PROFILE[i], [b, rb] = PROFILE[i + 1];
  const span = b - a, t = (y - a) / span, t2 = t * t, t3 = t2 * t;
  return Math.sqrt(Math.max(0,
    (2 * t3 - 3 * t2 + 1) * ra + (t3 - 2 * t2 + t) * span * slopes[i]
    + (-2 * t3 + 3 * t2) * rb + (t3 - t2) * span * slopes[i + 1]));
}

const depthRatio = .82;

/** Front depth in mesh/world coordinates; use this for the curved faceplate. */
export function faceDepth(x, y) {
  const radius = radiusAt(y);
  return Math.sqrt(Math.max(0, radius * radius - x * x)) * depthRatio;
}

function bodyDistance(x, y, z) {
  const radial = Math.hypot(x, z / depthRatio);
  if (y < .20) return Math.hypot(radial, y - .20);
  if (y >= 2.95) {
    // A distance approximation with a finite crown gradient prevents the
    // last marching-cubes cell from interpolating into a small pointed tip.
    const dy = y - 2.95;
    const k0 = Math.hypot(radial / .82, dy / .80);
    const k1 = Math.hypot(radial / (.82 * .82), dy / (.80 * .80));
    return k1 > 1e-8 ? k0 * (k0 - 1) / k1 : -.80;
  }
  return radial - radiusAt(y);
}

const finCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(.69, 2.32, -.015),
  new THREE.Vector3(.88, 2.08, -.005),
  new THREE.Vector3(1.035, 1.72, .015),
  new THREE.Vector3(1.08, 1.48, .03),
  new THREE.Vector3(1.05, 1.27, .055),
]);
const finPoints = finCurve.getPoints(28);
const finSegments = finPoints.slice(0, -1).map((a, i) => {
  const b = finPoints[i + 1];
  const dx = b.x - a.x, dy = b.y - a.y, dz = (b.z - a.z) / .82;
  return { ax: a.x, ay: a.y, az: a.z / .82, dx, dy, dz,
    lengthSq: dx * dx + dy * dy + dz * dz, index: i };
});

function finRadius(t) {
  // Broad shoulder, gently full outer fin, smaller round terminal cap.
  return .205 + .028 * Math.sin(Math.PI * t) - .041 * t * t;
}

function finDistance(x, y, z) {
  let nearest = 100;
  x = Math.abs(x); z /= .82;
  for (const s of finSegments) {
    const px = x - s.ax, py = y - s.ay, pz = z - s.az;
    const t = THREE.MathUtils.clamp((px * s.dx + py * s.dy + pz * s.dz) / s.lengthSq, 0, 1);
    const distance = Math.hypot(px - t * s.dx, py - t * s.dy, pz - t * s.dz)
      - finRadius((s.index + t) / finSegments.length);
    nearest = Math.min(nearest, distance);
  }
  return nearest;
}

function smoothUnion(a, b, radius) {
  const h = THREE.MathUtils.clamp(.5 + .5 * (b - a) / radius, 0, 1);
  return THREE.MathUtils.lerp(b, a, h) - radius * h * (1 - h);
}

export function createSculpt(material) {
  const resolution = 88;
  const extraction = new MarchingCubes(resolution, material, false, false, 80000);
  extraction.isolation = 0;
  // Padding on every side keeps the closed surface away from the volume edge.
  const extent = new THREE.Vector3(1.62, 2.08, 1.03);
  const center = new THREE.Vector3(0, 1.97, 0);
  for (let z = 0; z < resolution; z++) {
    const pz = (z / resolution * 2 - 1) * extent.z;
    for (let y = 0; y < resolution; y++) {
      const py = (y / resolution * 2 - 1) * extent.y + center.y;
      for (let x = 0; x < resolution; x++) {
        const px = (x / resolution * 2 - 1) * extent.x;
        const body = bodyDistance(px, py, pz);
        const fin = Math.abs(px) > .43 && py < 2.73 ? finDistance(px, py, pz) : 100;
        // MarchingCubes expects positive values inside the solid.
        extraction.field[x + y * resolution + z * resolution * resolution]
          = -smoothUnion(body, fin, .16);
      }
    }
  }
  extraction.update();

  // Trim the extraction buffers before keeping the static sculpt.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(extraction.positionArray.slice(0, extraction.count * 3), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(extraction.normalArray.slice(0, extraction.count * 3), 3));
  geometry.applyMatrix4(new THREE.Matrix4().compose(center, new THREE.Quaternion(), extent));
  geometry.normalizeNormals();
  extraction.geometry.dispose();

  const vertices = geometry.getAttribute('position');
  const uvs = new Float32Array(vertices.count * 2);
  const skinIndices = new Uint16Array(vertices.count * 4);
  const skinWeights = new Float32Array(vertices.count * 4);
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
    uvs.set([Math.atan2(x, z) / (Math.PI * 2) + .5,
      THREE.MathUtils.clamp((y - .20) / (3.75 - .20), 0, 1)], i * 2);
    const dominance = bodyDistance(x, y, z) - finDistance(x, y, z);
    const weight = THREE.MathUtils.smoothstep(dominance, -.035, .15)
      * THREE.MathUtils.smoothstep(Math.abs(x), .58, .99)
      * (1 - THREE.MathUtils.smoothstep(y, 1.85, 2.47));
    skinIndices.set([0, x < 0 ? 1 : 2, 0, 0], i * 4);
    skinWeights.set([1 - weight, weight, 0, 0], i * 4);
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const bodyBone = new THREE.Bone(); bodyBone.name = 'body';
  const leftArm = new THREE.Bone(); leftArm.name = 'left-flipper'; leftArm.position.set(-.69, 2.32, -.015);
  const rightArm = new THREE.Bone(); rightArm.name = 'right-flipper'; rightArm.position.set(.69, 2.32, -.015);
  bodyBone.add(leftArm, rightArm);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = 'continuous-ghost-sculpt';
  mesh.add(bodyBone);
  mesh.bind(new THREE.Skeleton([bodyBone, leftArm, rightArm]));
  mesh.castShadow = true; mesh.receiveShadow = true;
  // The arm poses exceed the rest-pose bounding sphere.
  mesh.frustumCulled = false;
  mesh.userData.sculptResolution = resolution;
  return { mesh, leftArm, rightArm, bodyBone, faceDepth };
}
