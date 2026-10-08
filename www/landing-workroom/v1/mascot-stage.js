/** Production host for the approved revision-04 character; character modules remain immutable. */
import { CREW, isCrewRole } from './mascot/crew.js';

export async function mountMascot(container, {
  initialState = 'idle', interactive = true, onReady, onStatus, signal, role = 'default',
} = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError('A mascot container element is required.');
  const previousPosition = container.style.position;
  const poster = container.querySelector('img.mascot-fallback');
  const cleanups = [], resources = new Set();
  let renderer, scene, studio, outfit, disposed = false, available = false, contextLost = false;
  let frameId = 0, tapTimer = 0, stateKeys = [];
  let active = initialState, paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let activeRole = isCrewRole(role) ? role : 'default';
  let requestRender = () => {}, setState = () => false, setRole = () => false, resetClock = () => {};
  const track = resource => { resources.add(resource); return resource; };
  const listen = (target, event, callback, options) => {
    target.addEventListener(event, callback, options);
    cleanups.push(() => target.removeEventListener(event, callback, options));
  };
  function report(status) {
    container.dataset.mascotReady = String(available);
    poster?.setAttribute('aria-hidden', String(available));
    if (renderer) {
      renderer.domElement.hidden = !available;
      renderer.domElement.style.visibility = available ? 'visible' : 'hidden';
      renderer.domElement.setAttribute('aria-hidden', String(!available));
      renderer.domElement.tabIndex = available && interactive ? 0 : -1;
    }
    try { onStatus?.({ available, status }); } catch (error) { console.warn('Mascot status callback failed.', error); }
  }
  function release() {
    if (disposed) return;
    disposed = true; available = false;
    cancelAnimationFrame(frameId); clearTimeout(tapTimer); frameId = 0;
    cleanups.splice(0).forEach(cleanup => { try { cleanup(); } catch {} });
    // Costumes own only their additive meshes; release them before traversing the rig.
    outfit?.dispose(); outfit = null;
    // Traverse even partially constructed scenes and register detached allocations as acquired.
    for (const root of [scene, studio]) root?.traverse(object => {
      if (object.geometry) resources.add(object.geometry);
      if (object.shadow) resources.add(object.shadow);
      for (const material of [].concat(object.material || [])) {
        resources.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
      }
    });
    for (const resource of resources) { try { resource.dispose?.(); } catch {} }
    resources.clear();
    if (renderer) {
      try { renderer.dispose(); renderer.forceContextLoss(); } catch {}
      renderer.domElement.remove();
    }
    container.style.position = previousPosition;
    delete container.dataset.mascotState; delete container.dataset.mascotPaused;
    delete container.dataset.mascotProgress;
    delete container.dataset.mascotRole;
    poster?.removeAttribute('aria-hidden');
  }
  function fail(error) {
    if (disposed) return;
    release(); report('unavailable');
    console.warn('Muster companion is unavailable; the page remains usable.', error);
  }
  const api = {
    get available() { return available; },
    get states() { return stateKeys; },
    setState: key => setState(key),
    getState: () => active,
    setRole: key => setRole(key),
    getRole: () => activeRole,
    setPaused(value) {
      if (disposed) return;
      paused = Boolean(value); resetClock(); container.dataset.mascotPaused = String(paused);
      if (paused && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
      requestRender();
    },
    getPaused: () => paused,
    dispose() { if (!disposed) { release(); report('disposed'); } },
  };
  if (signal?.aborted) { api.dispose(); return api; }
  if (signal) listen(signal, 'abort', () => api.dispose(), { once: true });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  try {
    const [THREE, { createSculpt }, { STATES, sampleMotion, transferPosition }, { drawCompanionFace }, { createCompanionEffects }, { createRoleOutfit }] = await Promise.all([
      import('./mascot/vendor/three.module.js'), import('./mascot/sculpt.js'),
      import('./mascot/companion.js'), import('./mascot/expressions.js'), import('./mascot/effects.js'),
      import('./mascot/role-outfits.js'),
    ]);
    if (disposed || signal?.aborted || !container.isConnected) { api.dispose(); return api; }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const order = Object.keys(STATES); stateKeys = Object.freeze([...order]);
    active = Object.hasOwn(STATES, initialState) ? initialState : 'idle';
    let previousState = active, elapsed = 0, stateTime = 0, inView = true;
    let pointer = { x: 0, y: 0 }, gaze = { x: 0, y: 0 }, drag = null, dragAngle = 0;
    let baseYaw = -.035, baseCameraDistance = 9.4, previousFrame = 0, faceFrame = 0;
    let lastTap = -Infinity, reactionEnd = 0;
    resetClock = () => { previousFrame = 0; };
    const intensity = .65;
    const weights = Object.fromEntries(order.map(key => [key, key === active ? 1 : 0]));
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.03;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D Muster companion. Tap or press Enter to greet. Double-tap or press Space to dance. Drag or use arrow keys to turn. Home resets the view.');
  renderer.domElement.tabIndex = interactive ? 0 : -1;
  renderer.domElement.setAttribute('role', 'img');
  if (!interactive) renderer.domElement.setAttribute('aria-label', 'Muster, your golden AI companion');
  container.append(renderer.domElement);
  renderer.domElement.className = 'mascot-canvas';
  renderer.domElement.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;touch-action:pan-y;';
  scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, .1, 80);
  camera.position.set(0, 2.65, 10.1);
  camera.lookAt(0, 2.13, 0);

  // Local studio reflections, generated without remote textures or models.
  studio = new THREE.Scene();
  studio.background = new THREE.Color('#242719');
  function softbox(x, y, z, w, h, color, intensity) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    panel.material.color.multiplyScalar(intensity);
    panel.position.set(x, y, z); panel.lookAt(0, 1.8, 0); studio.add(panel);
  }
  softbox(-4, 6, 4, 5, 7, '#ffefbb', 3.3);
  softbox(4, 3, 1, 3, 6, '#fcffb1', 2.8);
  softbox(0, 7, -3, 6, 4, '#ffffff', 4);
  softbox(-3, 1, -4, 3, 4, '#c8ffd4', 1.5);
  let environment;
  function rebuildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(renderer);
    let next;
    try { next = pmrem.fromScene(studio, .02); } finally { pmrem.dispose(); }
    if (environment) { resources.delete(environment); environment.dispose(); }
    environment = track(next); scene.environment = environment.texture;
  }
  rebuildEnvironment();

  scene.add(new THREE.HemisphereLight('#fff9d9', '#161b0a', .65));
  const key = new THREE.DirectionalLight('#fff6ce', 3.4);
  key.position.set(-3, 6, 5); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 5, bottom: -4, near: .1, far: 20 });
  key.shadow.bias = -.0003; key.shadow.normalBias = .035;
  scene.add(key);
  const rimLight = new THREE.DirectionalLight('#ffffc2', 2.3); rimLight.position.set(4, 4, -3); scene.add(rimLight);

  const grain = document.createElement('canvas'); grain.width = grain.height = 256;
  const grainContext = grain.getContext('2d');
  const grainPixels = grainContext.createImageData(256, 256);
  let seed = 17;
  for (let i = 0; i < grainPixels.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const value = 90 + (seed / 4294967296) * 76;
    grainPixels.data[i] = grainPixels.data[i + 1] = grainPixels.data[i + 2] = value;
    grainPixels.data[i + 3] = 255;
  }
  grainContext.putImageData(grainPixels, 0, 0);
  const grainMap = new THREE.CanvasTexture(grain); grainMap.wrapS = grainMap.wrapT = THREE.RepeatWrapping; grainMap.repeat.set(9, 9);
  track(grainMap);
  const shell = new THREE.MeshPhysicalMaterial({ color: '#eee04d', metalness: .26, roughness: .34, clearcoat: .28, clearcoatRoughness: .32, envMapIntensity: .70, bumpMap: grainMap, bumpScale: .003 });
  track(shell);
  const trim = new THREE.MeshStandardMaterial({ color: '#a0a83b', metalness: .28, roughness: .5 });
  track(trim);
  const robot = new THREE.Group(); scene.add(robot);
  const sculpt = createSculpt(shell); robot.add(sculpt.mesh);
  const arms = [sculpt.leftArm, sculpt.rightArm];

  // The visor follows the same head surface as the sculpt, with a thin inset lip.
  function squircle(w, h, offset) {
    const positions = [], uvs = [], indices = [];
    const rings = 28, segments = 120;
    for (let i = 0; i <= rings; i++) {
      const r = i / rings;
      for (let j = 0; j <= segments; j++) {
        const a = j / segments * Math.PI * 2;
        const x = Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)), .79) * w / 2 * r;
        const y = Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), .79) * h / 2 * r;
        const depth = sculpt.faceDepth(x, y + 2.85);
        positions.push(x, y + 2.85, depth + offset); uvs.push(x / w + .5, y / h + .5);
        if (i < rings && j < segments) { const n = i * (segments + 1) + j; indices.push(n, n + segments + 1, n + 1, n + 1, n + segments + 1, n + segments + 2); }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
  }
  const bezel = new THREE.Mesh(squircle(1.335, 1.155, .012), trim); robot.add(bezel);
  const screen = document.createElement('canvas'); screen.width = 640; screen.height = 512;
  const ctx = screen.getContext('2d');
  const faceTexture = new THREE.CanvasTexture(screen); faceTexture.colorSpace = THREE.SRGBColorSpace;
  track(faceTexture);
  const glass = new THREE.MeshBasicMaterial({ map: faceTexture, toneMapped: false });
  track(glass);
  const face = new THREE.Mesh(squircle(1.30, 1.12, .022), glass); robot.add(face);

  // Subtle embossed Muster initial, positioned where the reference has its chest stamp.
  const markPoints = [[-.09,1.91],[-.075,2.09],[0,1.98],[.075,2.09],[.09,1.91]].map(([x,y]) => new THREE.Vector3(x,y,sculpt.faceDepth(x,y)+.01));
  const logoPath = new THREE.CatmullRomCurve3(markPoints, false, 'centripetal', .15);
  const logo = new THREE.Mesh(new THREE.TubeGeometry(logoPath, 28, .012, 8, false), trim); robot.add(logo);

  function applyRole(key) {
    const next = key === 'default' ? null : createRoleOutfit(key, {
      robot, leftArm: sculpt.leftArm, rightArm: sculpt.rightArm, faceDepth: sculpt.faceDepth,
    });
    outfit?.dispose(); outfit = next; activeRole = key;
    shell.color.set(key === 'default' ? '#eee04d' : CREW[key].color);
    trim.color.set(key === 'default' ? '#a0a83b' : CREW[key].trim);
    logo.visible = key === 'default';
    container.dataset.mascotRole = key;
    const name = key === 'default' ? 'Muster companion' : `Muster ${CREW[key].name}`;
    renderer.domElement.setAttribute('aria-label', interactive
      ? `Interactive 3D ${name}. Tap or press Enter to greet. Double-tap or press Space to dance. Drag or use arrow keys to turn. Home resets the view.`
      : key === 'default' ? 'Muster, your golden AI companion' : `${name}, your AI teammate`);
  }
  applyRole(activeRole);

  const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 256;
  const shadowCtx = shadowCanvas.getContext('2d'); const grad = shadowCtx.createRadialGradient(128, 128, 0, 128, 128, 125);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)'); grad.addColorStop(.45, 'rgba(0,0,0,0.22)'); grad.addColorStop(1, 'rgba(0,0,0,0)'); shadowCtx.fillStyle = grad; shadowCtx.fillRect(0, 0, 256, 256);
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 3.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false, opacity: .75 })); contact.rotation.x = -Math.PI / 2; contact.position.y = .018; scene.add(contact);

  const rings = [0, 1, 2].map(i => { const mesh = new THREE.Mesh(new THREE.RingGeometry(1.4, 1.415, 96), new THREE.MeshBasicMaterial({ color: '#ffb67b', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })); mesh.rotation.x = -Math.PI / 2; mesh.position.y = .03 + i * .001; scene.add(mesh); return mesh; });
  const confetti = Array.from({ length: 22 }, (_, i) => {
    const mesh = new THREE.Mesh(i % 3 === 0 ? new THREE.SphereGeometry(.035, 8, 8) : new THREE.BoxGeometry(.065, .11, .016), new THREE.MeshStandardMaterial({ color: ['#ffbd85', '#fbefbc', '#a7b4a1', '#faf8f0'][i % 4], metalness: .35, roughness: .3, transparent: true })); scene.add(mesh); return mesh;
  });

  const effects = createCompanionEffects(scene, shell);

    const eyeColor = '#fafbf7';
    let speechLevel = .55;
    function renderFace() {
      drawCompanionFace(ctx, { state: active, previousState, time: elapsed, stateTime, pointer: gaze,
        eyeColor, intensity, speechLevel, transition: paused ? 1 : Math.min(1, stateTime / .32) });
      faceTexture.needsUpdate = true;
    }
    setState = key => {
      if (disposed || !Object.hasOwn(STATES, key)) return false;
      clearTimeout(tapTimer); lastTap = -Infinity;
      previousState = active; active = key; stateTime = 0; reactionEnd = 0;
      container.dataset.mascotState = key;
      try { renderFace(); requestRender(); } catch (error) { fail(error); }
      return !disposed;
    };
    setRole = key => {
      if (disposed || (key !== 'default' && !isCrewRole(key))) return false;
      if (key === activeRole) return true;
      try {
        // A failed costume allocation leaves the current costume/state intact.
        applyRole(key); resize(); requestRender();
      } catch (error) {
        console.warn('Muster teammate outfit could not change.', error);
        return false;
      }
      return !disposed;
    };
    requestRender = () => {
      if (!disposed && available && !contextLost && !frameId && inView && !document.hidden) {
        frameId = requestAnimationFrame(frame);
      }
    };
    function resize() {
      if (disposed || contextLost) return;
      try {
        const rect = container.getBoundingClientRect();
        const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
        renderer.setSize(width, height, false); camera.aspect = width / height;
        const crew = activeRole !== 'default';
        baseCameraDistance = Math.max(crew ? 10 : 9.4, (crew ? 3.9 : 3.15) / (2 * Math.tan(THREE.MathUtils.degToRad(16)) * camera.aspect));
        camera.position.z = baseCameraDistance; camera.updateProjectionMatrix(); requestRender();
      } catch (error) { fail(error); }
    }
    function poseFrame(delta) {
      const lerp = paused ? 1 : 1 - Math.exp(-Math.max(delta, .016) * 6);
      for (const key of order) weights[key] += ((key === active ? 1 : 0) - weights[key]) * lerp;
      if (!paused) { gaze.x += (pointer.x - gaze.x) * lerp; gaze.y += (pointer.y - gaze.y) * lerp; }
      const t = elapsed;
      speechLevel = .35 + .45 * Math.abs(Math.sin(t * 6.8));
      const pose = sampleMotion({ weights, time: t, intensity, active, stateTime, speechLevel });
      const glyphWeight = weights.alerting * (active === 'alerting' ? Math.min(1, stateTime / .55) : 1);
      const scale = Math.max(.01, pose.scale * (1 - glyphWeight * .985));
      robot.position.set(pose.x, pose.y + 2.15 * (1 - scale), 0);
      robot.scale.set(scale, scale * pose.scaleY, scale);
      const expanded = ['orbit', 'radar', 'progress', 'loading', 'uploading', 'sending', 'receiving'].includes(active);
      const targetDistance = expanded ? Math.max(active === 'uploading' ? 11.2 : 9.4, baseCameraDistance,
        3.95 / (2 * Math.tan(THREE.MathUtils.degToRad(16)) * camera.aspect)) : baseCameraDistance;
      camera.position.z += (targetDistance - camera.position.z) * lerp;
      effects.update({ active, weights, time: t, stateTime, intensity, pose, transferPosition });
      const targetYaw = dragAngle - .035 + gaze.x * .13 * (1 - weights.sleeping) * intensity + pose.yaw;
      baseYaw += (targetYaw - baseYaw) * lerp;
      robot.rotation.set(pose.lean, baseYaw + pose.spin, pose.tilt);
      arms[0].rotation.set(pose.leftX, 0, pose.left); arms[1].rotation.set(pose.rightX, 0, pose.right);
      outfit?.update({ time: t, weights, intensity });
      contact.scale.setScalar(Math.max(.15, scale) * (1 - pose.hop * .35 * intensity));
      contact.material.opacity = (.36 - pose.hop * .35 * intensity) * Math.min(1, scale);
      rings.forEach((ring, i) => { const phase = (t * .38 + i / 3) % 1; ring.scale.setScalar(1 + phase * .8); ring.material.opacity = pose.glow * (1 - phase) * .35 * intensity; });
      confetti.forEach((piece, i) => {
        const phase = (t * .36 + i / 22) % 1, angle = i * 2.399;
        piece.visible = pose.sparkles > .015;
        piece.material.opacity = pose.sparkles * Math.sin(phase * Math.PI) * intensity;
        piece.position.set(Math.cos(angle) * (1.1 + phase * .95), 3.5 - phase * 2.8, Math.sin(angle) * .8 - .6);
        piece.rotation.set(t + i, t * 1.6 + i, t * .8);
      });
    }
    function frame(now) {
      frameId = 0;
      if (disposed || contextLost || document.hidden || !inView) { previousFrame = 0; return; }
      const delta = previousFrame ? Math.min((now - previousFrame) / 1000, .05) : 0;
      previousFrame = now;
      try {
        if (!paused) {
          elapsed += delta; stateTime += delta;
          if (reactionEnd && elapsed > reactionEnd) { reactionEnd = 0; setState('idle'); }
        }
        poseFrame(delta);
        if (paused || now - faceFrame > 40) { renderFace(); faceFrame = now; }
        renderer.render(scene, camera); container.dataset.mascotProgress = stateTime.toFixed(1);
        if (!paused) requestRender();
      } catch (error) { fail(error); }
    }
    function react(key) {
      if (!available) return;
      clearTimeout(tapTimer); setState(key); reactionEnd = elapsed + (key === 'playful' ? 3.6 : 3);
    }
    const raycaster = new THREE.Raycaster();
    function hitsMascot(event) {
      const rect = container.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
        1 - (event.clientY - rect.top) / rect.height * 2), camera);
      return raycaster.intersectObjects([sculpt.mesh, effects.group, ...(outfit?.roots || [])], true).some(hit => {
        for (let object = hit.object; object; object = object.parent) if (!object.visible) return false;
        return true;
      });
    }
    if (interactive) {
      listen(renderer.domElement, 'pointermove', event => {
        const rect = container.getBoundingClientRect();
        pointer = { x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - .5) * 2)),
          y: Math.max(-1, Math.min(1, -((event.clientY - rect.top) / rect.height - .5) * 2)) };
        if (drag) {
          drag.moved = Math.max(drag.moved, Math.hypot(event.clientX - drag.x, event.clientY - drag.y));
          if (event.pointerType === 'mouse' && event.buttons === 1 && drag.moved > 8) dragAngle = drag.angle + (event.clientX - drag.x) * .009;
        }
      }, { passive: true });
      listen(renderer.domElement, 'pointerdown', event => {
        if (!available || event.button !== 0) return;
        drag = { x: event.clientX, y: event.clientY, moved: 0, angle: dragAngle };
      }, { passive: true });
      listen(renderer.domElement, 'pointerup', event => {
        if (!available) return;
        const tapped = drag && drag.moved < 8 && hitsMascot(event); drag = null;
        if (!tapped) return;
        const now = performance.now();
        if (now - lastTap < 310) { clearTimeout(tapTimer); lastTap = -Infinity; react('playful'); }
        else { lastTap = now; tapTimer = setTimeout(() => react('waking'), 310); }
      }, { passive: true });
      listen(renderer.domElement, 'pointercancel', () => { drag = null; clearTimeout(tapTimer); });
      listen(renderer.domElement, 'pointerleave', () => { drag = null; pointer = { x: 0, y: 0 }; });
      listen(renderer.domElement, 'keydown', event => {
        if (!available) return;
        if (!['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Enter' || event.key === ' ') react(event.key === 'Enter' ? 'waking' : 'playful');
        else { dragAngle = event.key === 'Home' ? 0 : dragAngle + (event.key === 'ArrowLeft' ? -.18 : .18); requestRender(); }
      });
    }
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(resize); observer.observe(container);
      cleanups.push(() => observer.disconnect());
    } else listen(window, 'resize', resize, { passive: true });
    const visibilityChanged = visible => {
      inView = visible; previousFrame = 0;
      if (!inView && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
      requestRender();
    };
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => visibilityChanged(entries.some(entry => entry.isIntersecting)));
      observer.observe(container); cleanups.push(() => observer.disconnect());
    } else {
      const checkView = () => {
        const rect = container.getBoundingClientRect();
        visibilityChanged(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight);
      };
      listen(window, 'scroll', checkView, { passive: true }); listen(window, 'resize', checkView, { passive: true }); checkView();
    }
    listen(document, 'visibilitychange', () => {
      previousFrame = 0;
      if (document.hidden && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
      requestRender();
    });
    listen(media, 'change', () => api.setPaused(media.matches));
    listen(renderer.domElement, 'webglcontextlost', event => {
      event.preventDefault();
      if (disposed) return;
      contextLost = true; available = false; previousFrame = 0;
      cancelAnimationFrame(frameId); clearTimeout(tapTimer); frameId = 0;
      report('context-lost');
    });
    listen(renderer.domElement, 'webglcontextrestored', () => {
      if (disposed) return;
      try {
        contextLost = false; previousFrame = 0;
        rebuildEnvironment(); resize();
        if (disposed) return;
        poseFrame(0); renderFace(); renderer.render(scene, camera);
        available = true; report('restored'); requestRender();
      } catch (error) { fail(error); }
    });
    resize();
    if (disposed) return api;
    poseFrame(0); renderFace(); renderer.render(scene, camera);
    container.dataset.mascotState = active; container.dataset.mascotPaused = String(paused);
    available = true; report('ready'); requestRender();
    try { onReady?.(api); } catch (error) { console.warn('Mascot ready callback failed.', error); }
    return api;
  } catch (error) { fail(error); return api; }
}
