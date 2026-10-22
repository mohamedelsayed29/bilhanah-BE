import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { ShapeId } from './catalog';

function outline(width: number, height: number, arch = false) {
  const path = new THREE.Shape(); const half = width / 2; const radius = .07;
  path.moveTo(-half + radius, 0); path.lineTo(half - radius, 0); path.quadraticCurveTo(half, 0, half, radius);
  if (arch) { path.lineTo(half, height - half); path.absarc(0, height - half, half, 0, Math.PI, false); }
  else { path.lineTo(half, height - radius); path.quadraticCurveTo(half, height, half - radius, height); path.lineTo(-half + radius, height); path.quadraticCurveTo(-half, height, -half, height - radius); }
  path.lineTo(-half, radius); path.quadraticCurveTo(-half, 0, -half + radius, 0); path.closePath();
  return path;
}

function printGeometry(width: number, height: number, arch: boolean) {
  const geometry = new THREE.ShapeGeometry(outline(width, height, arch), 48);
  const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  for (let index = 0; index < uv.count; index++) uv.setXY(index, (positions.getX(index) + width / 2) / width, positions.getY(index) / height);
  return geometry;
}

export type StandScene = ReturnType<typeof createStandScene>;
/** On-demand renderer: idle, offscreen and hidden viewers do not keep a render loop alive. */
export function createStandScene(host: HTMLDivElement, onFailure: () => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.transmissionResolutionScale = .5;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement; canvas.tabIndex = 0; canvas.setAttribute('role', 'img'); host.append(canvas);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#e5ecdf');
  const camera = new THREE.PerspectiveCamera(35, 1, .1, 60);
  camera.position.set(3.1, 2.25, 5.4);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.36, 0); controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = .15;
  controls.rotateSpeed = .65; controls.zoomSpeed = .65; controls.minDistance = 3.7; controls.maxDistance = 10;
  controls.minPolarAngle = Math.PI * .12; controls.maxPolarAngle = Math.PI * .86;
  controls.update(); controls.saveState();
  // Keep vertical page scrolling available on touchscreens; horizontal drags orbit the stand.
  canvas.style.touchAction = 'pan-y';
  const room = new RoomEnvironment(); const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room, .04); scene.environment = environment.texture; room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight('#fff9ed', '#a4b49e', 2.2));
  const key = new THREE.DirectionalLight('#fff9ed', 3.5); key.position.set(3, 6, 4); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -4; key.shadow.camera.right = 4; key.shadow.camera.top = 4; key.shadow.camera.bottom = -4; key.shadow.bias = -.0005; key.shadow.normalBias = .02; key.shadow.radius = 5;
  scene.add(key);
  const fill = new THREE.DirectionalLight('#eff8ff', 1.8); fill.position.set(-4, 3, -2); scene.add(fill);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ color: '#e5ecdf', toneMapped: false }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.02; scene.add(floor);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ color: '#344831', opacity: .18 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -.015; shadow.receiveShadow = true; scene.add(shadow);
  const acrylic = new THREE.MeshPhysicalMaterial({ color: '#dbe4d8', transmission: .86, thickness: .1, roughness: .1, ior: 1.49, clearcoat: 1, clearcoatRoughness: .08, envMapIntensity: 1.3 });
  const frontMaterial = new THREE.MeshBasicMaterial({ color: '#fff8ef', toneMapped: false });
  const backMaterial = new THREE.MeshBasicMaterial({ color: '#fff8ef', toneMapped: false });
  let model: THREE.Group | null = null, frame = 0, disposed = false, visible = true, artworkRevision = 0;
  let frontTexture: THREE.CanvasTexture | null = null, backTexture: THREE.CanvasTexture | null = null;

  function render() {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    const changing = controls.update();
    renderer.render(scene, camera);
    host.dataset.yaw = String(Math.round(((controls.getAzimuthalAngle() * 180 / Math.PI) % 360 + 360) % 360));
    host.dataset.distance = controls.getDistance().toFixed(3);
    host.dataset.polar = controls.getPolarAngle().toFixed(3);
    if (changing) requestRender();
  }
  function requestRender() { if (!frame && !disposed && visible && !document.hidden) frame = requestAnimationFrame(render); }
  controls.addEventListener('change', requestRender);
  const observe = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); requestRender();
  }); observe.observe(host);
  const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (!visible && frame) { cancelAnimationFrame(frame); frame = 0; } else requestRender(); }); intersection.observe(host);
  const visibility = () => { if (document.hidden && frame) { cancelAnimationFrame(frame); frame = 0; } else requestRender(); };
  document.addEventListener('visibilitychange', visibility);
  const contextLost = (event: Event) => { event.preventDefault(); onFailure(); };
  canvas.addEventListener('webglcontextlost', contextLost);
  // Wheel zoom is explicit (Ctrl+wheel), leaving ordinary wheel scrolling to the page.
  const wheel = (event: WheelEvent) => { if (!event.ctrlKey) event.stopImmediatePropagation(); };
  canvas.addEventListener('wheel', wheel, { capture: true, passive: true });

  function instant(action: () => void) { const damping = controls.enableDamping; controls.enableDamping = false; action(); controls.update(); controls.enableDamping = damping; requestRender(); }
  function turn(angle: number) { instant(() => controls.rotateLeft(angle)); }
  function zoom(closer: boolean) { instant(() => { if (closer) controls.dollyIn(1 / 1.18); else controls.dollyOut(1 / 1.18); }); }
  function reset() { instant(() => controls.reset()); }
  function keyboard(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowLeft': event.preventDefault(); turn(Math.PI / 12); break;
      case 'ArrowRight': event.preventDefault(); turn(-Math.PI / 12); break;
      case 'ArrowUp': event.preventDefault(); instant(() => controls.rotateUp(Math.PI / 16)); break;
      case 'ArrowDown': event.preventDefault(); instant(() => controls.rotateUp(-Math.PI / 16)); break;
      case '+': case '=': event.preventDefault(); zoom(true); break;
      case '-': event.preventDefault(); zoom(false); break;
      case 'Home': event.preventDefault(); reset(); break;
    }
  }
  canvas.addEventListener('keydown', keyboard);
  requestRender();

  return {
    canvas, turn, zoom, reset,
    setReducedMotion(reduced: boolean) { controls.enableDamping = !reduced; requestRender(); },
    setShape(shape: ShapeId) {
      if (model) { scene.remove(model); model.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); }
      model = new THREE.Group(); const panel = new THREE.Group();
      const width = shape === 'tilt' ? 1.95 : 1.8, height = shape === 'tilt' ? 2.25 : 2.7;
      const geometry = new THREE.ExtrudeGeometry(outline(width, height, shape === 'arch'), { depth: .075, bevelEnabled: true, bevelSize: .012, bevelThickness: .012, bevelSegments: 3, curveSegments: 48 });
      geometry.translate(0, 0, -.0375);
      const body = new THREE.Mesh(geometry, acrylic); panel.add(body);
      const front = new THREE.Mesh(printGeometry(width - .13, height - .14, shape === 'arch'), frontMaterial); front.position.set(0, .07, .052); front.castShadow = true; panel.add(front);
      const back = new THREE.Mesh(printGeometry(width - .13, height - .14, shape === 'arch'), backMaterial); back.rotation.y = Math.PI; back.position.set(0, .07, -.052); panel.add(back);
      panel.position.y = .14; if (shape === 'tilt') panel.rotation.x = -Math.PI / 13;
      model.add(panel);
      const footGeometry = new THREE.ExtrudeGeometry(outline(width + .28, shape === 'tilt' ? 1.35 : .85), { depth: .095, bevelEnabled: true, bevelSize: .035, bevelThickness: .018, bevelSegments: 4, curveSegments: 12 });
      const foot = new THREE.Mesh(footGeometry, acrylic); foot.rotation.x = -Math.PI / 2; foot.position.set(0, .045, shape === 'tilt' ? .3 : .425); model.add(foot);
      scene.add(model); host.dataset.shape = shape; requestRender();
    },
    setArtwork(artwork: { front: HTMLCanvasElement; back: HTMLCanvasElement }) {
      frontTexture?.dispose(); backTexture?.dispose();
      frontTexture = new THREE.CanvasTexture(artwork.front); backTexture = new THREE.CanvasTexture(artwork.back);
      for (const texture of [frontTexture, backTexture]) { texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); }
      frontMaterial.map = frontTexture; frontMaterial.color.set('#ffffff'); frontMaterial.needsUpdate = true;
      backMaterial.map = backTexture; backMaterial.color.set('#ffffff'); backMaterial.needsUpdate = true;
      host.dataset.artwork = String(++artworkRevision);
      requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true; cancelAnimationFrame(frame); observe.disconnect(); intersection.disconnect();
      document.removeEventListener('visibilitychange', visibility); canvas.removeEventListener('keydown', keyboard); canvas.removeEventListener('webglcontextlost', contextLost); canvas.removeEventListener('wheel', wheel, true);
      controls.removeEventListener('change', requestRender); controls.dispose();
      scene.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
      frontTexture?.dispose(); backTexture?.dispose(); frontMaterial.dispose(); backMaterial.dispose(); acrylic.dispose();
      floor.material.dispose(); shadow.material.dispose(); environment.dispose(); key.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    },
  };
}
