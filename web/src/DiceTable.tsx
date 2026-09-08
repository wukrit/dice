import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { DieGeometry, DieKind, Simulation, Swipe } from './types';

export interface DiceTableHandle {
  play(simulation: Simulation): Promise<void>;
  cancel(): void;
  showPreview(): void;
}

export interface DiceTableProps {
  catalog: DieGeometry[];
  selected: DieKind;
  disabled: boolean;
  onSwipe: (swipe: Swipe) => void;
  onError: (message: string) => void;
  reducedMotion: boolean;
}

const HALF_WIDTH = 3.2;
const HALF_LENGTH = 4.8;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;

type Gesture = {
  id: number;
  x: number;
  y: number;
  startedAt: number;
  start: THREE.Vector3;
};

type Playback = {
  simulation: Simulation;
  startedAt: number;
  duration: number;
  recordedEnd: number;
  indices: number[];
  resolve: () => void;
};

/** Dispose shared resources only once, including textures used by face labels. */
function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      geometries.add(object.geometry);
      const list = Array.isArray(object.material) ? object.material : [object.material];
      list.forEach((material: THREE.Material) => {
        materials.add(material);
        Object.values(material).forEach((value: unknown) => {
          if (value instanceof THREE.Texture) textures.add(value);
        });
      });
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function numberTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Face labels could not be drawn. Please reload this page.');
  context.fillStyle = '#f5f7f7';
  context.font = '600 160px system-ui, -apple-system, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 128, 132, 225);
  // A small engraved underline distinguishes six and nine at any rotation.
  if (text === '6' || text === '9') {
    context.fillRect(100, 215, 56, 7);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function faceText(geometry: DieGeometry, value: number, percentileUnits = false): string {
  if (geometry.kind === 100) {
    const alreadyTens = geometry.faces.some((face) => face.value > 10);
    return String(alreadyTens ? value % 100 : (value % 10) * 10).padStart(2, '0');
  }
  if (geometry.kind === 10 && percentileUnits) return String(value % 10);
  return String(geometry.kind === 10 && value === 0 ? 10 : value);
}

/** The original hull remains exact; narrow inset face panels suggest polished bevels. */
function makeDie(catalog: DieGeometry, percentileUnits = false): THREE.Group {
  const group = new THREE.Group();
  const vertices = catalog.vertices.map((vertex) => new THREE.Vector3(...vertex));
  const hullPositions: number[] = [];
  const hullNormals: number[] = [];
  const panelPositions: number[] = [];
  const panelNormals: number[] = [];
  const labels = new THREE.Group();
  group.add(labels);
  const labelPlane = new THREE.PlaneGeometry(1, 1);
  const labelMaterials = new Map<string, THREE.MeshBasicMaterial>();

  function addLabel(text: string, center: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, size: number) {
    let material = labelMaterials.get(text);
    if (!material) {
      material = new THREE.MeshBasicMaterial({
        map: numberTexture(text),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      labelMaterials.set(text, material);
    }
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    const orthogonalUp = new THREE.Vector3().crossVectors(normal, right).normalize();
    const label = new THREE.Mesh(labelPlane, material);
    label.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, orthogonalUp, normal));
    label.position.copy(center).addScaledVector(normal, 0.003);
    label.scale.set(size, size, 1);
    labels.add(label);
  }

  try {
    for (const face of catalog.faces) {
      const points = face.indices.map((index) => vertices[index]!);
      const normal = new THREE.Vector3(...face.normal).normalize();
      const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(points.length);
      const inset = points.map((point) => point.clone().lerp(center, 0.055).addScaledVector(normal, 0.0007));
      let inradius = Infinity;
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        const edge = b.clone().sub(a);
        inradius = Math.min(inradius, new THREE.Vector3().crossVectors(center.clone().sub(a), edge).length() / edge.length());
      }
      for (let i = 1; i < points.length - 1; i += 1) {
        const order = [0, i, i + 1];
        const cross = new THREE.Vector3().crossVectors(points[i]!.clone().sub(points[0]!), points[i + 1]!.clone().sub(points[0]!));
        if (cross.dot(normal) < 0) [order[1], order[2]] = [order[2]!, order[1]!];
        for (const index of order) {
          hullPositions.push(...points[index]!.toArray());
          hullNormals.push(...normal.toArray());
          panelPositions.push(...inset[index]!.toArray());
          panelNormals.push(...normal.toArray());
        }
      }
      if (catalog.kind === 4) {
        // A tetrahedron is read at its upper vertex. Its number is the value of
        // the opposite (downward) face, repeated near that vertex on all three sides.
        face.indices.forEach((vertexIndex) => {
          const opposite = catalog.faces.find((candidate) => !candidate.indices.includes(vertexIndex));
          if (!opposite) return;
          const point = vertices[vertexIndex]!;
          addLabel(String(opposite.value), center.clone().lerp(point, 0.48), normal, point.clone().sub(center).normalize(), inradius * 0.86);
        });
      } else {
        const up = points[0]!.clone().sub(center).normalize();
        addLabel(faceText(catalog, face.value, percentileUnits), center, normal, up, inradius * 1.85);
      }
    }
    const hull = new THREE.BufferGeometry();
    hull.setAttribute('position', new THREE.Float32BufferAttribute(hullPositions, 3));
    hull.setAttribute('normal', new THREE.Float32BufferAttribute(hullNormals, 3));
    hull.computeBoundingSphere();
    const body = new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: '#213e51', roughness: 0.35, metalness: 0.12 }));
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const panels = new THREE.BufferGeometry();
    panels.setAttribute('position', new THREE.Float32BufferAttribute(panelPositions, 3));
    panels.setAttribute('normal', new THREE.Float32BufferAttribute(panelNormals, 3));
    const faces = new THREE.Mesh(panels, new THREE.MeshStandardMaterial({ color: '#284c63', roughness: 0.42, metalness: 0.08 }));
    faces.receiveShadow = true;
    group.add(faces);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(hull, 12), new THREE.LineBasicMaterial({ color: '#7490a0', transparent: true, opacity: 0.23 }));
    group.add(edges);
    return group;
  } catch (error) {
    disposeTree(group);
    labelPlane.dispose();
    throw error;
  }
}

function restDie(die: THREE.Group, geometry: DieGeometry, x: number, z: number, turn: number) {
  const face = geometry.faces.reduce((best, next) => next.value > best.value ? next : best);
  const target = geometry.kind === 4 ? UP.clone().negate() : UP;
  die.quaternion.setFromUnitVectors(new THREE.Vector3(...face.normal).normalize(), target);
  die.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, turn));
  let bottom = Infinity;
  for (const vertex of geometry.vertices) {
    bottom = Math.min(bottom, new THREE.Vector3(...vertex).applyQuaternion(die.quaternion).y);
  }
  die.position.set(x, -bottom + 0.004, z);
}

function feltTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The dice table could not be drawn. Please reload this page.');
  const pixels = context.createImageData(128, 128);
  let seed = 19;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const shade = 128 + ((seed >>> 24) % 42);
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = shade;
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 8);
  return texture;
}

class TableScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-4, 4, 6, -6, 0.1, 60);
  private readonly raycaster = new THREE.Raycaster();
  private readonly floorPlane = new THREE.Plane(UP, 0);
  private readonly endPosition = new THREE.Vector3();
  private readonly endQuaternion = new THREE.Quaternion();
  private readonly keyLight = new THREE.DirectionalLight('#fff7ed', 2.7);
  private readonly cue = new THREE.Group();
  private readonly dice: THREE.Group[] = [];
  private renderer: THREE.WebGLRenderer | null = null;
  private observer: ResizeObserver | null = null;
  private cueRing: THREE.Mesh | null = null;
  private cueLine: THREE.Line | null = null;
  private gesture: Gesture | null = null;
  private playback: Playback | null = null;
  private animationFrame: number | null = null;
  private contextLost = false;
  private disposed = false;

  constructor(private readonly host: HTMLDivElement, private readonly props: () => DiceTableProps) {}

  init() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'default' });
    const renderer = this.renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color('#eff3f5');
    this.camera.position.set(0, 13, 5);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    const canvas = renderer.domElement;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Three-dimensional dice tray. Drag across the felt and release to throw the selected die. The Roll button also throws without a swipe. Results are shown outside the canvas.');
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' });
    this.host.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('lostpointercapture', this.onPointerCancel);

    this.scene.add(new THREE.HemisphereLight('#f3f8ff', '#7e8992', 1.65));
    this.keyLight.position.set(-3.5, 10, 4);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    Object.assign(this.keyLight.shadow.camera, { left: -7, right: 7, top: 8, bottom: -8, near: 0.5, far: 25 });
    this.keyLight.shadow.bias = -0.00015;
    this.keyLight.shadow.normalBias = 0.018;
    this.keyLight.shadow.radius = 3;
    this.scene.add(this.keyLight);
    this.buildTray();
    this.cueRing = new THREE.Mesh(new THREE.RingGeometry(0.105, 0.127, 40), new THREE.MeshBasicMaterial({ color: '#45697e', transparent: true, opacity: 0.7, depthWrite: false }));
    this.cueRing.rotation.x = -Math.PI / 2;
    this.cue.add(this.cueRing);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    this.cueLine = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: '#45697e', transparent: true, opacity: 0.65, depthWrite: false }));
    this.cueLine.frustumCulled = false;
    this.cue.add(this.cueLine);
    this.cue.visible = false;
    this.scene.add(this.cue);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(this.host);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.showPreview(this.props().selected);
    this.refreshControls();
  }

  private buildTray() {
    const walnut = new THREE.MeshStandardMaterial({ color: '#706055', roughness: 0.7 });
    const slate = new THREE.MeshStandardMaterial({ color: '#71818c', roughness: 0.88 });
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material, rounded = false) => {
      const geometry = rounded ? new RoundedBoxGeometry(w, h, d, 3, Math.min(0.06, h / 3, w / 3, d / 3)) : new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      return mesh;
    };
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: '#eff3f5', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.29;
    ground.receiveShadow = true;
    this.scene.add(ground);
    box(6.94, 0.22, 10.14, 0, -0.13, 0, walnut, true);
    for (const side of [-1, 1]) {
      box(0.26, 0.46, 10.12, side * 3.33, 0.2, 0, walnut, true);
      box(6.42, 0.46, 0.26, 0, 0.2, side * 4.93, walnut, true);
      box(0.018, 0.30, 9.60, side * 3.209, 0.15, 0, slate);
      box(6.4, 0.30, 0.018, 0, 0.15, side * 4.809, slate);
    }
    const felt = new THREE.Mesh(new THREE.PlaneGeometry(HALF_WIDTH * 2, HALF_LENGTH * 2), new THREE.MeshStandardMaterial({ color: '#cad8df', roughness: 0.98, bumpMap: feltTexture(), bumpScale: 0.016 }));
    felt.rotation.x = -Math.PI / 2;
    felt.receiveShadow = true;
    this.scene.add(felt);
    const seam = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-3.08, 0.005, -4.68), new THREE.Vector3(3.08, 0.005, -4.68),
      new THREE.Vector3(3.08, 0.005, 4.68), new THREE.Vector3(-3.08, 0.005, 4.68),
    ]), new THREE.LineBasicMaterial({ color: '#9eafb9', transparent: true, opacity: 0.45 }));
    this.scene.add(seam);
  }

  private readonly resize = () => {
    if (!this.renderer || this.disposed) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const aspect = width / height;
    // Fit the entire tray, not the dice. Zoom never changes during a gesture.
    const viewHeight = Math.max(10.8, 7.6 / aspect);
    this.camera.left = -viewHeight * aspect / 2;
    this.camera.right = viewHeight * aspect / 2;
    this.camera.top = viewHeight / 2;
    this.camera.bottom = -viewHeight / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    // A resize changes the ray projection; never submit half of an old gesture.
    this.clearGesture();
    this.render();
  };

  private render() {
    if (this.renderer && !this.disposed && !this.contextLost) this.renderer.render(this.scene, this.camera);
  }

  refreshControls() {
    if (!this.renderer) return;
    const blocked = this.props().disabled || this.contextLost || !!this.playback;
    this.renderer.domElement.style.cursor = blocked ? 'default' : this.gesture ? 'grabbing' : 'grab';
    if (blocked && this.gesture) {
      this.clearGesture();
      this.render();
    }
  }

  private removeDice() {
    for (const die of this.dice) {
      this.scene.remove(die);
      disposeTree(die);
    }
    this.dice.length = 0;
  }

  showPreview(kind: DieKind) {
    if (this.playback || this.disposed || this.contextLost) return;
    this.removeDice();
    const kinds: DieKind[] = kind === 100 ? [100, 10] : [kind];
    try {
      for (let index = 0; index < kinds.length; index += 1) {
        const geometry = this.props().catalog.find((item) => item.kind === kinds[index]);
        if (!geometry) continue; // The catalog may still be loading.
        const die = makeDie(geometry, kind === 100 && geometry.kind === 10);
        this.dice.push(die);
        this.scene.add(die);
        restDie(die, geometry, kinds.length === 1 ? 0 : (index === 0 ? -0.92 : 0.92), 0, index === 0 ? -0.22 : 0.32);
      }
      this.render();
    } catch (error) {
      this.removeDice();
      this.props().onError(error instanceof Error ? error.message : 'The dice could not be drawn. Please reload this page.');
    }
  }

  play(simulation: Simulation): Promise<void> {
    this.cancel();
    this.clearGesture();
    if (!this.renderer || this.disposed || this.contextLost) {
      this.props().onError('The dice table is unavailable. Please reload this page to restore it.');
      return Promise.resolve();
    }
    const geometries = simulation.tracks.map((track) => this.props().catalog.find((item) => item.kind === track.kind));
    if (!simulation.tracks.length || geometries.some((geometry) => !geometry) ||
        simulation.tracks.some((track) => !track.frames.length || track.frames.some((frame, index) =>
          !Number.isFinite(frame.t) || frame.t < 0 || (index > 0 && frame.t < track.frames[index - 1]!.t) ||
          !frame.p.every(Number.isFinite) || !frame.q.every(Number.isFinite) || frame.q.every((value) => value === 0))) ||
        !Number.isFinite(simulation.duration_ms) || simulation.duration_ms < 0) {
      this.props().onError('This roll recording is incomplete and cannot be replayed.');
      return Promise.resolve();
    }
    this.removeDice();
    try {
      for (const geometry of geometries) {
        const die = makeDie(geometry!, geometry!.kind === 10 && simulation.tracks.some(track => track.kind === 100));
        this.dice.push(die);
        this.scene.add(die);
      }
    } catch (error) {
      this.removeDice();
      this.props().onError(error instanceof Error ? error.message : 'The dice could not be drawn. Please reload this page.');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.playback = {
        simulation,
        startedAt: performance.now(),
        duration: simulation.duration_ms,
        // Frame timestamps keep their recorded spacing; duration_ms is the
        // authoritative wall clock, whether recording t is seconds or milliseconds.
        recordedEnd: Math.max(...simulation.tracks.map((track) => track.frames[track.frames.length - 1]!.t)),
        indices: simulation.tracks.map(() => 0),
        resolve,
      };
      this.refreshControls();
      if (this.props().reducedMotion || simulation.duration_ms === 0) this.finish();
      else {
        this.applyFrame(0);
        this.render();
        this.animationFrame = requestAnimationFrame(this.tick);
      }
    });
  }

  private applyFrame(time: number) {
    const playback = this.playback;
    if (!playback) return;
    playback.simulation.tracks.forEach((track, index) => {
      let cursor = playback.indices[index]!;
      while (cursor + 1 < track.frames.length && track.frames[cursor + 1]!.t <= time) cursor += 1;
      playback.indices[index] = cursor;
      const first = track.frames[cursor]!;
      const next = track.frames[Math.min(cursor + 1, track.frames.length - 1)]!;
      const alpha = next.t > first.t ? clamp((time - first.t) / (next.t - first.t), 0, 1) : 0;
      const die = this.dice[index]!;
      die.position.fromArray(first.p).lerp(this.endPosition.fromArray(next.p), alpha);
      die.quaternion.fromArray(first.q).normalize().slerp(this.endQuaternion.fromArray(next.q).normalize(), alpha);
    });
  }

  private readonly tick = (now: number) => {
    this.animationFrame = null;
    const playback = this.playback;
    if (!playback) return;
    const progress = clamp((now - playback.startedAt) / playback.duration, 0, 1);
    // Browsers suspend RAF in background tabs; elapsed time naturally catches up.
    if (progress >= 1 || this.props().reducedMotion) {
      this.finish();
      return;
    }
    this.applyFrame(progress * playback.recordedEnd);
    this.render();
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private finish() {
    const playback = this.playback;
    if (!playback) return;
    playback.simulation.tracks.forEach((track, index) => {
      const frame = track.frames[track.frames.length - 1]!;
      this.dice[index]!.position.fromArray(frame.p);
      this.dice[index]!.quaternion.fromArray(frame.q).normalize();
    });
    this.render();
    this.cancel();
  }

  cancel() {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    const playback = this.playback;
    this.playback = null;
    playback?.resolve();
    this.refreshControls();
  }

  private worldPoint(event: PointerEvent): THREE.Vector3 | null {
    if (!this.renderer) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.camera);
    return this.raycaster.ray.intersectPlane(this.floorPlane, new THREE.Vector3());
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || this.props().disabled || this.playback || this.contextLost || this.gesture) return;
    const start = this.worldPoint(event);
    if (!start || Math.abs(start.x) > HALF_WIDTH || Math.abs(start.z) > HALF_LENGTH) return;
    event.preventDefault();
    this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, startedAt: performance.now(), start };
    try {
      this.renderer!.domElement.setPointerCapture(event.pointerId);
    } catch {
      this.clearGesture();
      return;
    }
    this.updateCue(start);
    this.refreshControls();
  };

  private updateCue(end: THREE.Vector3) {
    if (!this.gesture || !this.cueRing || !this.cueLine) return;
    this.cue.visible = true;
    this.cueRing.position.set(this.gesture.start.x, 0.026, this.gesture.start.z);
    const attribute = this.cueLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.setXYZ(0, this.gesture.start.x, 0.025, this.gesture.start.z);
    attribute.setXYZ(1, clamp(end.x, -HALF_WIDTH + 0.04, HALF_WIDTH - 0.04), 0.025, clamp(end.z, -HALF_LENGTH + 0.04, HALF_LENGTH - 0.04));
    attribute.needsUpdate = true;
    this.render();
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.gesture?.id) return;
    if (this.props().disabled) {
      this.clearGesture();
      this.render();
      return;
    }
    event.preventDefault();
    const end = this.worldPoint(event);
    if (end) this.updateCue(end);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    event.preventDefault();
    const end = this.worldPoint(event);
    this.clearGesture();
    this.render();
    if (!end || this.props().disabled || this.playback || this.contextLost || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 14) return;
    this.props().onSwipe({
      start: [clamp(gesture.start.x / HALF_WIDTH, -1, 1), clamp(gesture.start.z / HALF_LENGTH, -1, 1)],
      delta: [clamp((end.x - gesture.start.x) / (HALF_WIDTH * 2), -2, 2), clamp((end.z - gesture.start.z) / (HALF_WIDTH * 2), -2, 2)],
      duration_ms: Math.round(clamp(performance.now() - gesture.startedAt, 60, 1200)),
    });
  };

  private readonly onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== this.gesture?.id) return;
    this.clearGesture();
    this.render();
  };

  private clearGesture() {
    const id = this.gesture?.id;
    this.gesture = null;
    this.cue.visible = false;
    const canvas = this.renderer?.domElement;
    if (id !== undefined && canvas?.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    if (canvas) canvas.style.cursor = this.props().disabled || this.playback || this.contextLost ? 'default' : 'grab';
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.cancel();
    this.clearGesture();
    this.props().onError('The graphics connection was interrupted. Reload this page to restore the dice table.');
  };

  private readonly onContextRestored = () => {
    this.props().onError('Graphics are available again. Reload this page to rebuild the dice table.');
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.clearGesture();
    this.observer?.disconnect();
    window.removeEventListener('resize', this.resize);
    const canvas = this.renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', this.onContextLost);
      canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
      canvas.removeEventListener('pointerdown', this.onPointerDown);
      canvas.removeEventListener('pointermove', this.onPointerMove);
      canvas.removeEventListener('pointerup', this.onPointerUp);
      canvas.removeEventListener('pointercancel', this.onPointerCancel);
      canvas.removeEventListener('lostpointercapture', this.onPointerCancel);
    }
    disposeTree(this.scene);
    this.keyLight.shadow.dispose();
    this.scene.clear();
    this.dice.length = 0;
    this.renderer?.dispose();
    canvas?.remove();
    this.renderer = null;
  }
}

export const DiceTable = forwardRef<DiceTableHandle, DiceTableProps>(function DiceTable(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const table = useRef<TableScene | null>(null);
  latest.current = props;

  useImperativeHandle(ref, () => ({
    play: (simulation) => {
      if (table.current) return table.current.play(simulation);
      latest.current.onError('The dice table is not ready. Please reload this page if it does not appear.');
      return Promise.resolve();
    },
    cancel: () => table.current?.cancel(),
    showPreview: () => {
      table.current?.cancel();
      table.current?.showPreview(latest.current.selected);
    },
  }), []);

  useEffect(() => {
    if (!host.current) return;
    const instance = new TableScene(host.current, () => latest.current);
    try {
      instance.init();
      table.current = instance;
    } catch (error) {
      instance.dispose();
      latest.current.onError(error instanceof Error
        ? `The 3D table could not start: ${error.message}`
        : 'The 3D table could not start. Enable WebGL in your browser, then reload this page.');
    }
    return () => {
      table.current = null;
      instance.dispose();
    };
  }, []);

  useEffect(() => {
    table.current?.showPreview(props.selected);
  }, [props.selected, props.catalog]);

  useEffect(() => {
    table.current?.refreshControls();
  }, [props.disabled]);

  return <div ref={host} className="dice-table" style={{ position: 'relative', width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }} />;
});
