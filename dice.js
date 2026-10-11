import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// Easy-to-change settings
const GRAVITY   = 50;      // stronger than real life so the roll stays snappy
const STEP      = 1 / 60;  // physics step (one recorded frame per step)
const MAX_STEPS = 5 * 60;  // a roll never lasts more than 5 seconds
const CALM_STEPS = 20;     // the roll ends once nothing moved for this many steps
const HOLD_MS   = 5000;    // dice stay on the table this long after stopping
const FADE_MS   = 700;
const RADIUS = { d4: 0.36, d6: 0.28, d8: 0.31, d10: 0.31, d12: 0.31, d20: 0.32 }; // size of each die
const FONT   = { d4: 0.2, d6: 0.42, d8: 0.34, d10: 0.26, d12: 0.36, d20: 0.3 };   // number size on the faces

export const DICE_TYPES = {
  d4:   { faces: 4,   hint: 'd4 (pyramide) : dégâts de dague, Projectile magique' },
  d6:   { faces: 6,   hint: 'd6 (cube) : épée courte, Boule de feu (8d6)' },
  d8:   { faces: 8,   hint: 'd8 : épée longue, soins' },
  d10:  { faces: 10,  hint: 'd10 : armes lourdes' },
  d12:  { faces: 12,  hint: 'd12 : hache à deux mains' },
  d20:  { faces: 20,  hint: 'd20 : attaques, compétences, sauvegardes' },
  d100: { faces: 100, hint: 'd100 (pourcentage) : deux d10, dizaines + unités' },
};

// Shapes
const PHI = (1 + Math.sqrt(5)) / 2;

// (0, ±b, ±c) and its cyclic permutations
function cyclicSigns(b, c) {
  const out = [];
  for (const sb of [-1, 1]) for (const sc of [-1, 1]) {
    out.push([0, sb * b, sc * c], [sb * b, sc * c, 0], [sc * c, 0, sb * b]);
  }
  return out;
}

const CUBE = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) CUBE.push([x, y, z]);

// d10 (pentagonal trapezohedron): two apexes and two offset rings of 5.
// The ring height is chosen so that each 4-corner face is perfectly flat.
function d10Points() {
  const c = Math.cos(Math.PI / 5);
  const ring = (1 - c) / (1 + c);
  const pts = [[0, 1, 0], [0, -1, 0]];
  for (let k = 0; k < 5; k++) {
    const a = (k * 2 * Math.PI) / 5;
    pts.push([Math.cos(a), ring, Math.sin(a)]);
    pts.push([Math.cos(a + Math.PI / 5), -ring, Math.sin(a + Math.PI / 5)]);
  }
  return pts;
}

const RAW_POINTS = {
  d4: () => [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
  d6: () => CUBE,
  d8: () => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
  d10: d10Points,
  d12: () => [...CUBE, ...cyclicSigns(1 / PHI, PHI)],
  d20: () => cyclicSigns(1, PHI),
};

// Corners of a face, counterclockwise seen from outside, starting with the corner the number points to
function orderFace(pts, ids, normal) {
  const center = new THREE.Vector3();
  ids.forEach((m) => center.add(pts[m]));
  center.divideScalar(ids.length);
  const dist = (m) => pts[m].distanceTo(center);
  const R = Math.max(...ids.map(dist));
  const top = ids.find((m) => dist(m) > R - 1e-6);
  const up = pts[top].clone().sub(center).normalize();
  const right = up.clone().cross(normal);
  const angle = (m) => {
    const d = pts[m].clone().sub(center);
    return Math.atan2(d.dot(up), d.dot(right));
  };
  const sorted = ids.slice().sort((p, q) => angle(p) - angle(q));
  const i = sorted.indexOf(top);
  return { ids: [...sorted.slice(i), ...sorted.slice(0, i)], normal, center, up, right, R };
}

// Faces of a convex shape centered on the origin
function hullFaces(pts) {
  const faces = [];
  const eps = 1e-6;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    a.subVectors(pts[j], pts[i]);
    b.subVectors(pts[k], pts[i]);
    n.crossVectors(a, b);
    if (n.lengthSq() < eps) continue;
    n.normalize();
    let d = n.dot(pts[i]);
    if (d < 0) { n.negate(); d = -d; }
    if (pts.some((p) => n.dot(p) > d + eps)) continue;          // not on the outside
    if (faces.some((f) => f.normal.dot(n) > 1 - eps)) continue; // already found
    const ids = pts.map((p, m) => m).filter((m) => Math.abs(n.dot(pts[m]) - d) < eps);
    faces.push(orderFace(pts, ids, n.clone()));
  }
  return faces;
}

const shapes = {};
export function getShape(key) {
  if (shapes[key]) return shapes[key];
  const raw = RAW_POINTS[key]();
  const r0 = Math.max(...raw.map((p) => Math.hypot(...p)));
  const pts = raw.map((p) => new THREE.Vector3(...p).multiplyScalar(RADIUS[key] / r0));
  const faces = hullFaces(pts);
  const body = new CANNON.ConvexPolyhedron({
    vertices: pts.map((p) => new CANNON.Vec3(p.x, p.y, p.z)),
    faces: faces.map((f) => f.ids),
  });
  return (shapes[key] = { key, pts, faces, body, geometry: null });
}

function geometryOf(shape) {
  if (shape.geometry) return shape.geometry;
  const pos = [], nrm = [], uv = [];
  const geo = new THREE.BufferGeometry();
  const d = new THREE.Vector3();
  shape.faces.forEach((f, fi) => {
    const first = pos.length / 3;
    const corner = (m) => {
      const p = shape.pts[m];
      d.subVectors(p, f.center);
      pos.push(p.x, p.y, p.z);
      nrm.push(f.normal.x, f.normal.y, f.normal.z);
      uv.push(0.5 + d.dot(f.right) / (2 * f.R), 0.5 + d.dot(f.up) / (2 * f.R));
    };
    for (let t = 1; t < f.ids.length - 1; t++) { corner(f.ids[0]); corner(f.ids[t]); corner(f.ids[t + 1]); }
    geo.addGroup(first, pos.length / 3 - first, fi);
  });
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return (shape.geometry = geo);
}

// What each die shows
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// A d100 is two d10: one for the tens (00-90), one for the units (0-9). 00 + 0 = 100.
export function piecesFor(dice) {
  const out = [];
  for (const { type, value } of dice) {
    if (type === 'd100') {
      out.push({ shape: 'd10', labels: range(10, (i) => String(i * 10).padStart(2, '0')), result: String(Math.floor((value % 100) / 10) * 10).padStart(2, '0') });
      out.push({ shape: 'd10', labels: range(10, (i) => String(i)), result: String(value % 10) });
    } else {
      out.push({ shape: type, labels: range(DICE_TYPES[type].faces, (i) => String(i + 1)), result: String(value) });
    }
  }
  return out;
}

// Which face points up (for a d4: which corner, that's how a d4 is read)
function topIndex(shape, q) {
  const list = shape.key === 'd4' ? shape.pts : shape.faces.map((f) => f.normal);
  const v = new THREE.Vector3();
  let best = 0, bestY = -Infinity;
  list.forEach((p, i) => {
    const y = v.copy(p).applyQuaternion(q).y;
    if (y > bestY) { bestY = y; best = i; }
  });
  return best;
}

// The server picks the result: write it on the face that ends up on top
export function settleLabels(piece, shape, finalQuat) {
  const labels = piece.labels.slice();
  const up = topIndex(shape, finalQuat);
  const j = labels.indexOf(piece.result);
  [labels[up], labels[j]] = [labels[j], labels[up]];
  return labels;
}

// Physics
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// area: { cx, cz, top, halfX, halfZ, fromX, fromZ, obstacles: [{ x, z, r, h }] }
// The dice bounce inside the area (invisible walls) and are thrown from (fromX, fromZ) toward the center.
export function simulateRoll(pieces, seed, area) {
  const rand = mulberry32(seed);
  const between = (a, b) => a + (b - a) * rand();
  const { cx, cz, top, halfX, halfZ } = area;

  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.defaultContactMaterial.friction = 0.3;
  world.defaultContactMaterial.restitution = 0.35;

  const wall = (x, z, rx, ry) => {
    const body = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    body.position.set(x, top, z);
    body.quaternion.setFromEuler(rx, ry, 0);
    world.addBody(body);
  };
  wall(cx, cz, -Math.PI / 2, 0);        // table top
  wall(cx - halfX, cz, 0, Math.PI / 2); // the 4 invisible sides
  wall(cx + halfX, cz, 0, -Math.PI / 2);
  wall(cx, cz - halfZ, 0, 0);
  wall(cx, cz + halfZ, 0, Math.PI);

  for (const o of area.obstacles || []) {
    const body = new CANNON.Body({ mass: 0, shape: new CANNON.Cylinder(o.r, o.r, o.h, 12) });
    body.position.set(o.x, top + o.h / 2, o.z);
    world.addBody(body);
  }

  let dx = cx - area.fromX, dz = cz - area.fromZ;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const px = -dz, pz = dx; // sideways
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const bodies = pieces.map((piece, i) => {
    const body = new CANNON.Body({
      mass: 1, shape: getShape(piece.shape).body, linearDamping: 0.1, angularDamping: 0.15,
    });
    const col = (i % 3) - 1, row = Math.floor(i / 3);
    body.position.set(
      clamp(area.fromX + px * col * 0.7 - dx * row * 0.3, cx - halfX + 0.4, cx + halfX - 0.4),
      top + 0.8 + row * 0.7,
      clamp(area.fromZ + pz * col * 0.7 - dz * row * 0.3, cz - halfZ + 0.4, cz + halfZ - 0.4)
    );
    body.quaternion.setFromEuler(between(0, 6.3), between(0, 6.3), between(0, 6.3));
    const speed = between(5, 8);
    const side = between(-1, 1);
    body.velocity.set(dx * speed + px * side, between(0, 2), dz * speed + pz * side);
    body.angularVelocity.set(between(-15, 15), between(-15, 15), between(-15, 15));
    world.addBody(body);
    return body;
  });

  const frames = bodies.map(() => []);
  const record = () => bodies.forEach((b, i) => {
    frames[i].push(b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  });
  record();
  // Stopped = nothing visibly moved during the last CALM_STEPS (some shapes creep forever otherwise)
  const barelyMoved = (f) => {
    const a = f.length - 7, b = a - CALM_STEPS * 7;
    return Math.hypot(f[a] - f[b], f[a + 1] - f[b + 1], f[a + 2] - f[b + 2]) < 0.01
      && Math.hypot(f[a + 3] - f[b + 3], f[a + 4] - f[b + 4], f[a + 5] - f[b + 5], f[a + 6] - f[b + 6]) < 0.01;
  };
  for (let s = 0; s < MAX_STEPS; s++) {
    world.step(STEP);
    record();
    if (s >= CALM_STEPS && frames.every(barelyMoved)) break;
  }
  return { frames: frames.map((f) => new Float32Array(f)), count: frames[0].length / 7 };
}

// Look of the dice
const textures = new Map();

function drawLabel(ctx, text, px, underline) {
  ctx.font = `800 ${px}px Cinzel, Georgia, serif`;
  ctx.fillText(text, 0, px * 0.06);
  if (underline) {
    const w = ctx.measureText(text).width;
    ctx.fillRect(-w / 2, px * 0.45, w, px * 0.08);
  }
}

// labels: one number in the middle, or for a d4 one number per corner
function faceTexture(key, labels, look, underline, anisotropy) {
  const id = [key, look.color, look.ink, underline, ...labels].join('|');
  if (textures.has(id)) return textures.get(id);
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = look.color;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = look.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (key === 'd4') {
    labels.forEach((text, i) => {
      const a = Math.PI / 2 + (i * 2 * Math.PI) / 3; // corners, counterclockwise from the top one
      ctx.save();
      ctx.translate(S / 2 + Math.cos(a) * S * 0.28, S / 2 - Math.sin(a) * S * 0.28);
      ctx.rotate(Math.PI / 2 - a); // number points to its corner
      drawLabel(ctx, text, FONT.d4 * S, false);
      ctx.restore();
    });
  } else {
    ctx.translate(S / 2, S / 2);
    drawLabel(ctx, labels[0], FONT[key] * S, underline && (labels[0] === '6' || labels[0] === '9'));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  textures.set(id, tex);
  return tex;
}

// Dice on the table
export class DiceTray {
  constructor(scene, anisotropy = 1) {
    this.scene = scene;
    this.anisotropy = anisotropy;
    this.rolls = [];
  }

  // look: { color, ink }. Returns the time (ms) until the dice stop.
  throw(dice, seed, area, look) {
    const now = performance.now();
    for (const r of this.rolls) if (now >= r.restAt) r.leaveAt = Math.min(r.leaveAt, now); // make room

    const pieces = piecesFor(dice);
    const { frames, count } = simulateRoll(pieces, seed, area);
    const q = new THREE.Quaternion();
    const meshes = pieces.map((piece, i) => {
      const shape = getShape(piece.shape);
      const o = (count - 1) * 7;
      q.fromArray(frames[i], o + 3);
      const labels = settleLabels(piece, shape, q);
      const underline = labels.includes('6') && labels.includes('9');
      const materials = shape.faces.map((f, fi) => new THREE.MeshStandardMaterial({
        map: faceTexture(shape.key, shape.key === 'd4' ? f.ids.map((m) => labels[m]) : [labels[fi]], look, underline, this.anisotropy),
        roughness: 0.45,
      }));
      const mesh = new THREE.Mesh(geometryOf(shape), materials);
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });

    const duration = (count - 1) * STEP * 1000;
    this.rolls.push({ meshes, frames, count, start: now, restAt: now + duration, leaveAt: now + duration + HOLD_MS });
    this.update(now);
    return duration;
  }

  update(now) {
    this.rolls = this.rolls.filter((r) => {
      const f = Math.min(r.count - 1, Math.floor((now - r.start) / 1000 / STEP)) * 7;
      const fade = (now - r.leaveAt) / FADE_MS;
      r.meshes.forEach((mesh, i) => {
        mesh.position.fromArray(r.frames[i], f);
        mesh.quaternion.fromArray(r.frames[i], f + 3);
        if (fade > 0) for (const m of mesh.material) {
          if (!m.transparent) { m.transparent = true; m.needsUpdate = true; }
          m.opacity = Math.max(0, 1 - fade);
        }
      });
      if (fade < 1) return true;
      for (const mesh of r.meshes) {
        this.scene.remove(mesh);
        mesh.material.forEach((m) => m.dispose());
      }
      return false;
    });
  }
}
