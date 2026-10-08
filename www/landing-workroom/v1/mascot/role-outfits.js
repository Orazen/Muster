import * as THREE from './vendor/three.module.js';
// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- The vendored Three.js export is fixed; alias our costume contour locally.
import { Shape as CostumeContour } from './vendor/three.module.js';
import { CREW, isCrewRole } from './crew.js';

const clamp = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/**
 * Additive, locally authored costume meshes. The approved sculpt, skeleton and
 * face stay intact. Nothing here owns a timer, renderer or shared rig resource.
 */
export function createRoleOutfit(role, { robot, leftArm, rightArm, faceDepth }) {
  if (!isCrewRole(role)) throw new RangeError('Unknown Muster crew role.');
  const group = new THREE.Group();
  group.name = `crew-outfit-${role}`;
  const left = new THREE.Group(), right = new THREE.Group();
  left.name = `crew-left-prop-${role}`; right.name = `crew-right-prop-${role}`;
  const roots = [group, left, right];
  const resources = new Set();
  let disposed = false, animatedProp, movingDetail;
  const track = resource => { resources.add(resource); return resource; };
  const material = (color, options = {}) => track(new THREE.MeshStandardMaterial({
    color, roughness: .66, metalness: .03, ...options,
  }));
  const cloth = material(role === 'developer' ? '#314c76' : '#f3e5c9');
  const seam = material(role === 'developer' ? '#759ac1' : '#c4a984');
  const dark = material(role === 'designer' ? '#65415f' : role === 'coordinator' ? '#514361' : role === 'developer' ? '#26313d' : '#324b47');
  const paper = material('#fff7df');
  const accent = material(CREW[role].color);

  function mesh(name, geometry, mat, parent = group) {
    const item = new THREE.Mesh(track(geometry), mat);
    item.name = name; item.castShadow = true; item.receiveShadow = true;
    parent.add(item); return item;
  }
  function ball(name, at, scale, mat, parent = group) {
    const item = mesh(name, new THREE.SphereGeometry(1, 24, 16), mat, parent);
    item.position.set(...at); item.scale.set(...scale); return item;
  }
  function box(name, width, height, depth, mat, parent = group, radius = .025) {
    const r = Math.min(radius, width / 3, height / 3, depth / 3);
    const w = width / 2 - r, h = height / 2 - r;
    const contour = new CostumeContour();
    contour.moveTo(-w, -h - r); contour.lineTo(w, -h - r);
    contour.quadraticCurveTo(w + r, -h - r, w + r, -h);
    contour.lineTo(w + r, h); contour.quadraticCurveTo(w + r, h + r, w, h + r);
    contour.lineTo(-w, h + r); contour.quadraticCurveTo(-w - r, h + r, -w - r, h);
    contour.lineTo(-w - r, -h); contour.quadraticCurveTo(-w - r, -h - r, -w, -h - r);
    const geometry = new THREE.ExtrudeGeometry(contour, {
      depth: depth - r * 2, bevelEnabled: true, bevelSize: r, bevelThickness: r,
      bevelSegments: 2, curveSegments: 5, steps: 1,
    });
    geometry.translate(0, 0, -depth / 2 + r);
    return mesh(name, geometry, mat, parent);
  }
  function tube(name, points, radius, mat, parent = group, closed = false) {
    const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)), closed);
    return mesh(name, new THREE.TubeGeometry(curve, Math.max(12, points.length * 5), radius, 6, closed), mat, parent);
  }
  // An offset patch of the original torso surface: soft clothing, not a second body.
  function panel(name, bottom, top, from, to, mat, offset = .035) {
    const positions = [], indices = [], rows = 14, columns = 22;
    for (let row = 0; row <= rows; row++) {
      const y = bottom + (top - bottom) * row / rows;
      const radius = faceDepth(0, y) / .82;
      for (let col = 0; col <= columns; col++) {
        const angle = from + (to - from) * col / columns;
        positions.push(Math.sin(angle) * (radius + offset), y, Math.cos(angle) * (radius * .82 + offset));
        if (row < rows && col < columns) {
          const n = row * (columns + 1) + col;
          indices.push(n, n + 1, n + columns + 1, n + 1, n + columns + 2, n + columns + 1);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    return mesh(name, geometry, mat);
  }
  function frontLine(name, points, mat, radius = .012) {
    return tube(name, points.map(([x, y]) => [x, y, faceDepth(x, y) + .07]), radius, mat);
  }
  function pocket(name, x, y, width = .28) {
    const item = box(name, width, .25, .04, cloth);
    item.position.set(x, y, faceDepth(x, y) + .07);
    const lip = box(`${name}-seam`, width * .83, .017, .016, seam);
    lip.position.set(x, y + .08, faceDepth(x, y) + .102);
  }
  function atFin(root, bone, at) {
    // The unchanged bones' rest coordinates are in the robot's local space.
    root.position.set(at[0] - bone.position.x, at[1] - bone.position.y, at[2] - bone.position.z);
  }
  function notebook(parent, name, width, height) {
    box(`${name}-cover`, width, height, .085, dark, parent);
    const pages = box(`${name}-pages`, width - .055, height - .055, .055, paper, parent);
    pages.position.z = .031;
    for (let i = 0; i < 3; i++) {
      const line = box(`${name}-line-${i}`, width * .55, .018, .006, seam, parent, .001);
      line.position.set(.02, height * .20 - i * .10, .065);
    }
  }

  try {
    if (role === 'designer') {
      panel('designer-apron', 1.08, 2.20, -.72, .72, cloth);
      frontLine('designer-apron-left-strap', [[-.44, 2.23], [-.41, 2.04], [-.38, 1.88]], seam, .022);
      frontLine('designer-apron-right-strap', [[.44, 2.23], [.41, 2.04], [.38, 1.88]], seam, .022);
      pocket('designer-apron-pocket', 0, 1.52, .48);
      const hat = new THREE.Group(); hat.name = 'designer-beret'; group.add(hat);
      hat.position.set(-.12, 3.59, -.02); hat.rotation.z = .16;
      ball('designer-beret-crown', [0, .10, 0], [.76, .27, .66], dark, hat);
      ball('designer-beret-band', [0, -.025, .005], [.65, .095, .57], dark, hat);
      ball('designer-beret-tip', [-.09, .36, -.04], [.065, .075, .06], dark, hat);
      atFin(left, leftArm, [-1.03, 1.52, .52]);
      const fan = new THREE.Group(); fan.name = 'designer-swatches'; left.add(fan); animatedProp = fan;
      ['#ef9461', '#edd777', '#7bb9a2', '#8d9ed6'].forEach((color, i) => {
        const card = box(`designer-swatch-${i}`, .18, .51, .028, material(color), fan, .008);
        card.position.set((i - 1.5) * .065, .15, i * .035);
        card.rotation.z = (i - 1.5) * -.24;
      });
      ball('designer-swatch-pin', [0, -.06, .14], [.035, .035, .016], dark, fan);
      atFin(right, rightArm, [1.05, 1.56, .48]);
      const pencil = tube('designer-pencil', [[0, -.11, 0], [0, .36, 0]], .034, dark, right);
      pencil.rotation.z = -.24;
      ball('designer-pencil-tip', [.085, .36, 0], [.025, .05, .025], paper, right);
    } else if (role === 'researcher') {
      panel('researcher-vest-left', 1.15, 2.23, -1.58, -.08, cloth);
      panel('researcher-vest-right', 1.15, 2.23, .08, 1.58, cloth);
      pocket('researcher-left-pocket', -.39, 1.60);
      pocket('researcher-right-pocket', .39, 1.60);
      for (const side of [-1, 1]) {
        const points = Array.from({ length: 32 }, (_, i) => {
          const angle = i / 32 * Math.PI * 2;
          const x = side * .335 + Math.cos(angle) * .276;
          const y = 2.92 + Math.sin(angle) * .325;
          return [x, y, faceDepth(x, y) + .075];
        });
        tube(`researcher-glasses-${side < 0 ? 'left' : 'right'}`, points, .023, dark, group, true);
      }
      frontLine('researcher-glasses-bridge', [[-.065, 2.98], [0, 3.015], [.065, 2.98]], dark, .02);
      tube('researcher-glasses-temple-left', [[-.60, 3.02, .42], [-.79, 3.02, .19], [-.79, 2.96, -.10]], .022, dark);
      tube('researcher-glasses-temple-right', [[.60, 3.02, .42], [.79, 3.02, .19], [.79, 2.96, -.10]], .022, dark);
      atFin(left, leftArm, [-1.04, 1.58, .54]);
      const book = new THREE.Group(); book.name = 'researcher-notebook'; left.add(book); animatedProp = book;
      notebook(book, 'researcher-notebook', .46, .63);
      atFin(right, rightArm, [1.03, 1.55, .55]);
      tube('researcher-magnifier-handle', [[0, -.14, 0], [.07, .10, .025]], .035, dark, right);
      const rim = mesh('researcher-magnifier-rim', new THREE.TorusGeometry(.195, .026, 8, 40), dark, right);
      rim.position.set(.12, .29, .025);
      // Place the complete lens outside the torso silhouette and below the visor.
      const lens = mesh('researcher-magnifier-lens', new THREE.CircleGeometry(.183, 32), material('#cbe7dc', {
        transparent: true, opacity: .18, depthWrite: false, side: THREE.DoubleSide, roughness: .2,
      }), right);
      lens.position.copy(rim.position); lens.castShadow = false;
      tube('researcher-magnifier-glint', [[.04, .405, .03], [.12, .43, .03], [.205, .393, .03]], .012, paper, right);
    } else if (role === 'developer') {
      panel('developer-hoodie', 1.02, 2.22, -Math.PI, Math.PI, cloth);
      // Hood rests behind the head; the entire black visor remains unobstructed.
      const hood = mesh('developer-hood', new THREE.TorusGeometry(.64, .155, 12, 40, Math.PI), cloth);
      hood.position.set(0, 2.29, -.30); hood.rotation.x = -.40;
      frontLine('developer-zip', [[0, 2.19], [0, 1.79], [0, 1.19]], seam, .012);
      frontLine('developer-drawstring-left', [[-.23, 2.21], [-.25, 2.04], [-.23, 1.91]], paper, .017);
      frontLine('developer-drawstring-right', [[.23, 2.21], [.25, 2.04], [.24, 1.91]], paper, .017);
      pocket('developer-hoodie-pocket', 0, 1.45, .55);
      const laptop = new THREE.Group(); laptop.name = 'developer-laptop'; group.add(laptop);
      laptop.position.set(0, 1.60, 1.20); animatedProp = laptop;
      const laptopMaterial = material('#414342', { metalness: .25, roughness: .45 });
      const base = box('developer-laptop-base', 1.04, .07, .54, laptopMaterial, laptop);
      base.position.y = -.22;
      const lid = new THREE.Group(); lid.name = 'developer-laptop-lid'; laptop.add(lid);
      lid.position.set(0, -.19, -.20); lid.rotation.x = -.16; movingDetail = lid;
      const cover = box('developer-laptop-cover', 1.02, .54, .055, laptopMaterial, lid);
      cover.position.y = .27;
      const screen = box('developer-laptop-screen', .89, .40, .009, dark, lid, .002);
      screen.position.set(0, .29, .036);
      const code = material('#99e6e8', { emissive: '#44898c', emissiveIntensity: .18 });
      tube('developer-code-left', [[-.10, .39, .052], [-.23, .29, .052], [-.10, .19, .052]], .018, code, lid);
      tube('developer-code-right', [[.12, .39, .052], [.25, .29, .052], [.12, .19, .052]], .018, code, lid);
      tube('developer-code-slash', [[.065, .405, .052], [-.045, .175, .052]], .016, code, lid);
      atFin(left, leftArm, [-.94, 1.53, .49]);
      atFin(right, rightArm, [.94, 1.53, .49]);
      // Small cuff rims travel with the original fins, rather than replacing them.
      ball('developer-left-cuff', [0, 0, 0], [.19, .095, .18], cloth, left);
      ball('developer-right-cuff', [0, 0, 0], [.19, .095, .18], cloth, right);
    } else {
      panel('coordinator-jacket-left', 1.09, 2.22, -1.65, -.075, cloth);
      panel('coordinator-jacket-right', 1.09, 2.22, .075, 1.65, cloth);
      const collar = material('#ed938b');
      for (const side of [-1, 1]) {
        const points = [[.47 * side, 2.23], [.25 * side, 2.03], [.12 * side, 2.20]];
        if (side > 0) points.reverse();
        const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, y]) => new THREE.Vector3(x, y, faceDepth(x, y) + .075)));
        geometry.computeVertexNormals();
        mesh(`coordinator-${side < 0 ? 'left' : 'right'}-lapel`, geometry, collar);
      }
      pocket('coordinator-jacket-pocket', -.39, 1.57, .29);
      for (const y of [1.89, 1.60, 1.31]) ball(`coordinator-button-${y}`, [.13, y, faceDepth(.13, y) + .065], [.026, .026, .016], dark);
      tube('coordinator-headset-band', [[-.85, 2.92, -.08], [-.77, 3.47, -.10], [0, 3.76, -.10], [.77, 3.47, -.10], [.85, 2.92, -.08]], .046, dark);
      ball('coordinator-headset-left', [-.84, 2.98, -.04], [.115, .25, .20], dark);
      ball('coordinator-headset-right', [.84, 2.98, -.04], [.115, .25, .20], dark);
      tube('coordinator-microphone', [[.86, 2.85, .07], [.86, 2.53, .43], [.60, 2.44, .59]], .023, dark);
      ball('coordinator-microphone-tip', [.60, 2.44, .59], [.065, .042, .045], dark);
      atFin(left, leftArm, [-1.04, 1.61, .52]);
      const board = new THREE.Group(); board.name = 'coordinator-taskboard'; left.add(board); animatedProp = board;
      notebook(board, 'coordinator-taskboard', .51, .68);
      const clip = box('coordinator-board-clip', .19, .09, .05, accent, board);
      clip.position.set(0, .30, .085);
      ['#e48165', '#e7b957', '#7eb792'].forEach((color, i) => {
        ball(`coordinator-task-dot-${i}`, [-.16, .13 - i * .10, .083], [.027, .027, .012], material(color), board);
      });
    }

    robot.add(group); leftArm.add(left); rightArm.add(right);
  } catch (error) {
    roots.forEach(root => root.removeFromParent());
    for (const resource of resources) resource.dispose();
    throw error;
  }

  return {
    role, group, roots,
    // Only costume-local transforms: never modify state, clock, rig or face.
    update({ time = 0, weights = {}, intensity = .65 } = {}) {
      if (disposed) return;
      const t = Number.isFinite(time) ? Math.max(0, time) : 0;
      const energy = clamp(intensity);
      const work = clamp((weights.working || 0) + (weights.writing || 0) + (weights.searching || 0));
      const listen = clamp((weights.listening || 0) + (weights.dictating || 0));
      if (role === 'designer') {
        animatedProp.rotation.z = -.10 + Math.sin(t * 2.8) * .11 * work * energy;
        right.rotation.x = Math.sin(t * 5.0) * .09 * work * energy;
      } else if (role === 'researcher') {
        animatedProp.rotation.z = -.13 + Math.sin(t * 1.6) * .06 * work * energy;
        animatedProp.rotation.y = -.13 + Math.sin(t * 1.3) * .12 * work * energy;
        right.rotation.z = Math.sin(t * 3.2) * .07 * work * energy;
      } else if (role === 'developer') {
        animatedProp.position.y = 1.60 + Math.sin(t * 5.5) * .018 * work * energy;
        movingDetail.rotation.x = -.16 + Math.sin(t * 1.8) * .025 * work * energy;
        left.rotation.x = Math.sin(t * 8) * .07 * work * energy;
        right.rotation.x = Math.sin(t * 8 + Math.PI) * .07 * work * energy;
      } else {
        animatedProp.rotation.z = .07 + Math.sin(t * 2.1) * .065 * Math.max(work, listen) * energy;
        animatedProp.rotation.x = Math.sin(t * 1.7) * .06 * listen * energy;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; roots.forEach(root => root.removeFromParent());
      for (const resource of resources) resource.dispose();
      resources.clear();
    },
  };
}
