import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DiceTray, DICE_TYPES } from './dice.js';

// Easy-to-change settings
const TABLE_FILE       = 'Models/Table.glb';
const BEER_FULL_FILE   = 'Models/Beer_full.glb';
const BEER_EMPTY_FILE  = 'Models/Beer_empty.glb';
const TABLE_SIZE       = 10;                  // table size in the scene
const TABLE_ROTATION_DEG = 90;                // table rotation
const TILT_DEG         = 12;                  // 0 = straight from above
const MARGIN           = 1.3;                 // bigger = smaller table on screen
const BG_COLOR         = 0x4a2a8c;
const BEER_HEIGHT      = TABLE_SIZE * 0.09;   // height of a beer
const ORIENT_TO_SEAT   = false;               // true: the nameplate is readable from its side of the table

const SEAT_U = 0.5, SEAT_V = 0.68;     // nameplate position (same values on the server)
const DROP_HU = 0.27, DROP_HV = 0.22; // area around YOUR OWN nameplate where you can drink
const LIFT_HELD = BEER_HEIGHT * 0.5;  // the beer lifts up while held
const DRINK_MS = 2200;                // animation duration (same value on the server)
const DICE_ZONE_U = 0.6;              // dice roll in the middle of the table, between the nameplates
const MAX_DICE = 10;                  // per roll, a d100 counts as two dice (same value on the server)
const DICE_LOG_SIZE = 3;              // results shown at once
const DICE_LOG_MS = 40000;            // a result disappears after this long

const ICONS  = ['🧙', '⚔️', '🏹', '🐉', '🗡️', '🛡️', '🔮', '🍺', '🎲', '🦉', '🧝', '🧛'];
const COLORS = ['#c0392b', '#e67e22', '#d4ac0d', '#27ae60', '#2980b9', '#8e44ad', '#2c3e50', '#d35d9b'];

// Scene
const canvas = document.getElementById('scene');
const message = document.getElementById('message');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);

scene.add(new THREE.HemisphereLight(0xffffff, 0x6a4a9c, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(4, 12, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
scene.add(sun);

// Table
let tableReady = false;
let tableBox = new THREE.Box3(
  new THREE.Vector3(-TABLE_SIZE / 2, -0.5, -TABLE_SIZE / 4),
  new THREE.Vector3(TABLE_SIZE / 2, 0, TABLE_SIZE / 4)
);

const tableSize = new THREE.Vector3();
const tableCenter = new THREE.Vector3();
function updateTableMetrics() {
  tableBox.getSize(tableSize);
  tableBox.getCenter(tableCenter);
}
updateTableMetrics();

// (u, v): position on the table between -1 and 1, 0 = center
function uvToWorld(u, v, y, target) {
  return target.set(tableCenter.x + u * tableSize.x / 2, y, tableCenter.z + v * tableSize.z / 2);
}
function seatSpot(i) {
  return { u: i % 2 === 0 ? -SEAT_U : SEAT_U, v: i < 2 ? -SEAT_V : SEAT_V };
}
function onPlate(u, v, seat) {
  const sp = seatSpot(seat);
  return Math.abs(u - sp.u) < DROP_HU && Math.abs(v - sp.v) < DROP_HV;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function enableShadows(obj) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}

const loader = new GLTFLoader();

loader.load(
  TABLE_FILE,
  (gltf) => {
    const table = gltf.scene;
    table.rotation.y = THREE.MathUtils.degToRad(TABLE_ROTATION_DEG);

    let box = new THREE.Box3().setFromObject(table);
    const size = box.getSize(new THREE.Vector3());
    table.scale.setScalar(TABLE_SIZE / Math.max(size.x, size.z));

    box = new THREE.Box3().setFromObject(table);
    const center = box.getCenter(new THREE.Vector3());
    table.position.x -= center.x;
    table.position.z -= center.z;
    table.position.y -= box.max.y; // table top at y = 0

    enableShadows(table);
    scene.add(table);

    tableBox = new THREE.Box3().setFromObject(table);
    updateTableMetrics();
    tableReady = true;
    fitCamera();
    message.classList.add('hidden');
    refreshWorld();
  },
  undefined,
  (err) => {
    console.error(err);
    message.textContent = `Impossible de charger ${TABLE_FILE}. Vérifie le nom du fichier dans le dossier Models.`;
  }
);

// Beers
const beerTemplates = {}; // 'full' / 'empty' -> 3D object ready to clone
let beerRadius = BEER_HEIGHT * 0.35;

function loadBeer(type, file) {
  loader.load(
    file,
    (gltf) => {
      const obj = gltf.scene;
      obj.scale.setScalar(BEER_HEIGHT / new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3()).y);
      const box = new THREE.Box3().setFromObject(obj);
      const c = box.getCenter(new THREE.Vector3());
      obj.position.x -= c.x;      // centered
      obj.position.z -= c.z;
      obj.position.y -= box.min.y; // base resting at y = 0
      const size = box.getSize(new THREE.Vector3());
      beerRadius = Math.min(size.x, size.z) / 2; // without the handle, for dice to bounce on
      enableShadows(obj);
      const wrapper = new THREE.Group();
      wrapper.add(obj);
      beerTemplates[type] = wrapper;
      refreshWorld();
    },
    undefined,
    (err) => console.error(`Impossible de charger ${file}`, err)
  );
}
loadBeer('full', BEER_FULL_FILE);
loadBeer('empty', BEER_EMPTY_FILE);

const beerObjects = new Map(); // id -> { obj, type, fresh, drinkStart }

function removeBeer(id) {
  const e = beerObjects.get(id);
  if (e) { scene.remove(e.obj); beerObjects.delete(id); }
}

function renderBeers(beers) {
  const ids = new Set(beers.map((b) => b.id));
  for (const id of [...beerObjects.keys()]) if (!ids.has(id)) removeBeer(id);

  for (const b of beers) {
    let e = beerObjects.get(b.id);
    if (e && e.type !== b.type) { removeBeer(b.id); e = null; } // full -> empty
    if (e || !beerTemplates[b.type]) continue;
    const obj = beerTemplates[b.type].clone(true);
    obj.userData.beerId = b.id;
    obj.rotation.y = (b.id * 2.4) % (Math.PI * 2); // a bit of variety
    scene.add(obj);
    beerObjects.set(b.id, { obj, type: b.type, fresh: true, drinkStart: null });
  }
}

// Placement and animation of each beer, every frame
function updateBeers(dt, now) {
  const k = 1 - Math.exp(-dt * 18);
  const top = tableBox.max.y;
  const p = new THREE.Vector3();
  for (const b of state.beers) {
    const e = beerObjects.get(b.id);
    if (!e) continue;
    const o = e.obj;
    uvToWorld(b.u, b.v, top + (b.holder ? LIFT_HELD : 0), p);

    if (b.drinking) {
      // Animation: the mug lifts, tilts toward the drinker, then settles back down
      if (e.drinkStart === null) e.drinkStart = now;
      const t = Math.min((now - e.drinkStart) / DRINK_MS, 1);
      const up = smooth(0, 0.2, t) - smooth(0.85, 1, t);
      const tilt = smooth(0.2, 0.45, t) - smooth(0.7, 0.88, t);
      const dir = b.v < 0 ? -1 : 1; // the drinker is on their nameplate's side
      o.position.set(p.x, p.y + up * BEER_HEIGHT * 0.9, p.z + dir * up * BEER_HEIGHT * 0.35);
      o.rotation.x = dir * tilt * 1.9 + Math.sin(t * 50) * 0.06 * tilt;
      e.fresh = false;
      continue;
    }
    e.drinkStart = null;
    o.rotation.x += (0 - o.rotation.x) * k;
    if (e.fresh) { o.position.copy(p); e.fresh = false; }
    else o.position.lerp(p, k);
  }
}

// Player nameplates
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#1d1230' : '#ffffff';
}

function makePlateTexture(p) {
  const W = 1024, H = 320;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  roundedRect(ctx, 6, 6, W - 12, H - 12, 70);
  ctx.fillStyle = p.color;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();

  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.arc(160, H / 2, 112, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '130px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(p.icon, 160, H / 2 + 8);

  let fontSize = 120;
  const maxWidth = W - 330 - 50;
  ctx.textAlign = 'left';
  ctx.fillStyle = textColorFor(p.color);
  do {
    ctx.font = `700 ${fontSize}px "Alegreya Sans", system-ui, sans-serif`;
    fontSize -= 4;
  } while (ctx.measureText(p.name).width > maxWidth && fontSize > 30);
  ctx.fillText(p.name, 310, H / 2 + 6);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const plateGroups = []; // indexed by seat number

function plateSize() {
  const w = tableSize.x * 0.21;
  return { w, h: w * (320 / 1024) };
}

function renderSeats(seats) {
  for (const g of plateGroups) {
    if (!g) continue;
    scene.remove(g);
    g.traverse((o) => { if (o.isMesh) { o.material.map.dispose(); o.material.dispose(); o.geometry.dispose(); } });
  }
  plateGroups.length = 0;

  const { w: plateW, h: plateH } = plateSize();

  seats.forEach((p, i) => {
    if (!p) return;
    const sp = seatSpot(i);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(plateW, plateH),
      new THREE.MeshBasicMaterial({ map: makePlateTexture(p), transparent: true, toneMapped: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    const group = new THREE.Group();
    group.add(mesh);
    uvToWorld(sp.u, sp.v, tableBox.max.y + 0.03, group.position);
    if (ORIENT_TO_SEAT && sp.v < 0) group.rotation.y = Math.PI;
    scene.add(group);
    plateGroups[i] = group;
  });
}

// The nameplate of whoever holds a beer grows when they can drink on it
function updatePlates(dt) {
  const k = 1 - Math.exp(-dt * 14);
  plateGroups.forEach((g, i) => {
    if (!g) return;
    let target = 1;
    if (drag && i === mySeat) {
      const b = state.beers.find((x) => x.id === drag.id);
      if (b && b.type === 'full' && onPlate(b.u, b.v, i)) target = 1.12;
    }
    g.scale.setScalar(g.scale.x + (target - g.scale.x) * k);
  });
}

// Shared state
let state = { seats: [], beers: [] };
let myRole = null;
let mySeat = -1;
let drag = null; // { id, offU, offV, u, v } while holding a beer

function refreshWorld() {
  if (!tableReady) return;
  renderSeats(state.seats);
  renderBeers(state.beers);
}

// Fixed camera
function fitCamera() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const aspect = w / h;
  const size = tableBox.getSize(new THREE.Vector3());
  const center = tableBox.getCenter(new THREE.Vector3());
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const halfW = (size.x / 2) * MARGIN;
  const halfD = (size.z / 2) * MARGIN;
  const dist = Math.max(halfD / tanV, halfW / (tanV * aspect));
  const tilt = THREE.MathUtils.degToRad(TILT_DEG);
  camera.position.set(center.x, center.y + dist * Math.cos(tilt), center.z + dist * Math.sin(tilt));
  camera.lookAt(center);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

function onResize() {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  fitCamera();
}
window.addEventListener('resize', onResize);
onResize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  updateBeers(dt, performance.now());
  updatePlates(dt);
  tray.update(performance.now());
  renderer.render(scene, camera);
});

// Login and interface
const socket = io();
socket.on('state', (s) => {
  state = s;
  if (drag) { // keep our local position for the beer we are holding
    const b = state.beers.find((x) => x.id === drag.id);
    if (b) { b.u = drag.u; b.v = drag.v; } else drag = null;
  }
  refreshWorld();
});

// Live movement of a beer held by someone else
socket.on('beer:moved', ({ id, u, v }) => {
  if (drag && drag.id === id) return;
  const b = state.beers.find((x) => x.id === id);
  if (b) { b.u = u; b.v = v; }
});

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

const $ = (id) => document.getElementById(id);
const nameInput = $('name');
let color = COLORS[0];
let icon = ICONS[0];

try {
  const saved = JSON.parse(localStorage.getItem('taverne-profil') || '{}');
  if (saved.name) nameInput.value = saved.name;
  if (saved.color) color = saved.color;
  if (ICONS.includes(saved.icon)) icon = saved.icon;
} catch (e) { /* not a big deal */ }

function updatePreview() {
  const pv = $('preview');
  pv.innerHTML = '';
  const plate = document.createElement('div');
  plate.className = 'plate';
  plate.style.background = color;
  plate.style.color = textColorFor(color);
  const ic = document.createElement('span');
  ic.className = 'plate-icon';
  ic.textContent = icon;
  const nm = document.createElement('span');
  nm.className = 'plate-name';
  nm.textContent = nameInput.value.trim() || 'Ton pseudo';
  plate.append(ic, nm);
  pv.append(plate);
}

function buildPickers() {
  const colors = $('colors');
  colors.innerHTML = '';
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.setAttribute('aria-label', `Couleur ${c}`);
    b.setAttribute('aria-pressed', String(c === color));
    b.onclick = () => { color = c; buildPickers(); };
    colors.append(b);
  });
  const custom = document.createElement('label');
  custom.className = 'swatch swatch-custom';
  custom.style.margin = '0';
  custom.title = 'Autre couleur';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = color;
  picker.setAttribute('aria-label', 'Choisir une autre couleur');
  picker.oninput = () => { color = picker.value; updatePreview(); };
  picker.onchange = () => buildPickers();
  custom.append(picker);
  colors.append(custom);

  const icons = $('icons');
  icons.innerHTML = '';
  ICONS.forEach((i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.textContent = i;
    b.setAttribute('aria-label', `Icône ${i}`);
    b.setAttribute('aria-pressed', String(i === icon));
    b.onclick = () => { icon = i; buildPickers(); };
    icons.append(b);
  });
  updatePreview();
}
nameInput.addEventListener('input', updatePreview);
buildPickers();

function enterTable(role, seat = -1) {
  myRole = role;
  mySeat = seat;
  $('login').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('role-badge').textContent = role === 'admin' ? 'Maître du jeu' : `Joueur : ${nameInput.value.trim()}`;
  if (role === 'admin') $('admin-tools').classList.remove('hidden');
  $('dice-ui').classList.remove('hidden');
  $('dice-secret').classList.toggle('hidden', role !== 'admin');
}

$('login-card').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  $('player-error').textContent = '';
  if (!name) { $('player-error').textContent = 'Choisis un pseudo.'; return; }
  socket.emit('join', { role: 'player', name, color, icon }, (res) => {
    if (!res.ok) { $('player-error').textContent = res.error; return; }
    try { localStorage.setItem('taverne-profil', JSON.stringify({ name, color, icon })); } catch (e) { /* not a big deal */ }
    enterTable('player', res.seat);
  });
});

$('admin-btn').addEventListener('click', () => {
  $('admin-error').textContent = '';
  socket.emit('join', { role: 'admin', password: $('admin-pass').value }, (res) => {
    if (!res.ok) { $('admin-error').textContent = res.error; return; }
    enterTable('admin');
  });
});
$('admin-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('admin-btn').click(); } });

$('beer-full').onclick = () => socket.emit('beer:add', { type: 'full' });
$('beer-empty').onclick = () => socket.emit('beer:add', { type: 'empty' });
$('beer-clear').onclick = () => socket.emit('beer:clear');
$('leave').onclick = () => location.reload();

// If the server goes down, go back to the login screen
socket.on('disconnect', () => {
  drag = null;
  myRole = null;
  mySeat = -1;
  $('hud').classList.add('hidden');
  $('admin-tools').classList.add('hidden');
  $('dice-ui').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('player-error').textContent = 'Connexion perdue. Reprends ta place à la table.';
});


// Pick up, move and drink a beer
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
let lastMoveSent = 0;

function aimAt(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

function pointOnTable() {
  dragPlane.constant = -tableBox.max.y;
  return raycaster.ray.intersectPlane(dragPlane, hit);
}

function pickBeerId() {
  const roots = [...beerObjects.values()].map((e) => e.obj);
  const hits = raycaster.intersectObjects(roots, true);
  if (!hits.length) return null;
  let o = hits[0].object;
  while (o && o.userData.beerId === undefined) o = o.parent;
  return o ? o.userData.beerId : null;
}

const clampUv = (x) => Math.max(-0.95, Math.min(0.95, x));

canvas.addEventListener('pointerdown', (e) => {
  if (!myRole || e.button !== 0 || drag) return;
  aimAt(e);
  const id = pickBeerId();
  if (id === null) return;
  const b = state.beers.find((x) => x.id === id);
  if (!b || b.drinking) return;
  if (b.holder && b.holder !== socket.id) { toast("Cette bière est dans la main de quelqu'un d'autre."); return; }
  if (!pointOnTable()) return;

  const u = (hit.x - tableCenter.x) / (tableSize.x / 2);
  const v = (hit.z - tableCenter.z) / (tableSize.z / 2);
  drag = { id, offU: b.u - u, offV: b.v - v, u: b.u, v: b.v };
  b.holder = socket.id; // lift it right away, the server confirms right after
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = 'grabbing';

  socket.emit('beer:grab', { id }, (res) => {
    if (res && res.ok) return;
    if (drag && drag.id === id) { drag = null; canvas.style.cursor = ''; }
    b.holder = null;
    if (res && res.error) toast(res.error);
  });
});

canvas.addEventListener('pointermove', (e) => {
  aimAt(e);
  if (!drag) {
    if (!myRole || e.buttons) return;
    const id = pickBeerId();
    const b = id === null ? null : state.beers.find((x) => x.id === id);
    canvas.style.cursor = b && !b.drinking && (!b.holder || b.holder === socket.id) ? 'grab' : '';
    return;
  }
  if (!pointOnTable()) return;
  const b = state.beers.find((x) => x.id === drag.id);
  if (!b) { drag = null; return; }
  drag.u = clampUv((hit.x - tableCenter.x) / (tableSize.x / 2) + drag.offU);
  drag.v = clampUv((hit.z - tableCenter.z) / (tableSize.z / 2) + drag.offV);
  b.u = drag.u;
  b.v = drag.v;
  const now = performance.now();
  if (now - lastMoveSent > 40) {
    lastMoveSent = now;
    socket.emit('beer:move', { id: drag.id, u: drag.u, v: drag.v });
  }
});

function dropBeer() {
  if (!drag) return;
  const { id, u, v } = drag;
  drag = null;
  canvas.style.cursor = '';
  const b = state.beers.find((x) => x.id === id);
  if (b) b.holder = null;
  socket.emit('beer:release', { id, u, v }, (res) => {
    if (res && res.message) toast(res.message);
  });
}
canvas.addEventListener('pointerup', dropBeer);
canvas.addEventListener('pointercancel', dropBeer);


// Dice
const tray = new DiceTray(scene, renderer.capabilities.getMaxAnisotropy());

// Where the dice can roll: the middle of the table, without touching the nameplates.
// Players throw from their corner, the game master from the right side.
function diceArea(seat) {
  const top = tableBox.max.y;
  const halfX = (tableSize.x / 2) * DICE_ZONE_U;
  const halfZ = Math.max(tableSize.z * 0.12, (SEAT_V * tableSize.z) / 2 - plateSize().h * 0.6 - 0.2);
  const from = seat >= 0 ? seatSpot(seat) : { u: 1, v: 0 };
  const p = new THREE.Vector3();
  const obstacles = state.beers.filter((b) => !b.holder).map((b) => {
    uvToWorld(b.u, b.v, top, p);
    return { x: p.x, z: p.z, r: beerRadius, h: BEER_HEIGHT };
  });
  return {
    cx: tableCenter.x, cz: tableCenter.z, top, halfX, halfZ, obstacles,
    fromX: tableCenter.x + Math.sign(from.u) * halfX * 0.85,
    fromZ: tableCenter.z + Math.sign(from.v) * halfZ * 0.85,
  };
}

socket.on('dice:rolled', (roll) => {
  const look = { color: roll.by.color, ink: textColorFor(roll.by.color) };
  const ms = tableReady ? tray.throw(roll.dice, roll.seed, diceArea(roll.by.seat), look) : 0;
  setTimeout(() => addDiceLog(roll), ms); // the result shows up once the dice stop
});
socket.on('dice:secret', () => toast('🎲 Le maître du jeu lance des dés en secret…'));

function addDiceLog(roll) {
  if (!myRole) return;
  const groups = {};
  for (const d of roll.dice) (groups[d.type] ||= []).push(d.value);
  const total = roll.dice.reduce((n, d) => n + d.value, 0);

  const li = document.createElement('li');
  li.style.borderLeftColor = roll.by.color;
  const tot = document.createElement('span');
  tot.className = 'total';
  tot.textContent = total;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = `${roll.by.icon} ${roll.by.name}${roll.secret ? ' · 🔒 secret' : ''}`;
  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = Object.entries(groups).map(([t, v]) => `${v.length}${t} : ${v.join(', ')}`).join(' · ');
  li.append(tot, who, detail);

  const log = $('dice-log');
  log.append(li);
  while (log.children.length > DICE_LOG_SIZE) log.firstChild.remove();
  setTimeout(() => { li.classList.add('old'); setTimeout(() => li.remove(), 600); }, DICE_LOG_MS);
}

// Small outlines of each die for the buttons
const DIE_ICONS = {
  d4: '<polygon points="12,3 21.5,20 2.5,20"/>',
  d6: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  d8: '<polygon points="12,2 21,12 12,22 3,12"/><line x1="3" y1="12" x2="21" y2="12"/>',
  d10: '<polygon points="12,2 21,11 12,22 3,11"/><polyline points="3,11 12,14.5 21,11"/><line x1="12" y1="14.5" x2="12" y2="22"/>',
  d12: '<polygon points="12,2 21.5,8.9 17.9,20.1 6.1,20.1 2.5,8.9"/><polygon points="12,7 16.3,10.2 14.6,15.3 9.4,15.3 7.7,10.2"/>',
  d20: '<polygon points="12,2 21,7 21,17 12,22 3,17 3,7"/><polygon points="12,7 17,15 7,15"/>',
  d100: '<polygon points="7,3 12,10 7,21 2,10"/><polygon points="17,3 22,10 17,21 12,10"/>',
};

const picked = Object.fromEntries(Object.keys(DICE_TYPES).map((t) => [t, 0]));
const pickedCount = () => Object.entries(picked).reduce((n, [t, k]) => n + k * (t === 'd100' ? 2 : 1), 0);

function updateDiceUi() {
  for (const b of $('dice-picks').children) {
    const n = picked[b.dataset.type];
    b.querySelector('.count').textContent = n;
    b.querySelector('.count').hidden = !n;
    b.classList.toggle('picked', n > 0);
    b.setAttribute('aria-label', `${b.dataset.type}, ${n} choisi${n > 1 ? 's' : ''}`);
  }
  const parts = Object.entries(picked).filter(([, n]) => n).map(([t, n]) => `${n}${t}`);
  const what = parts.length ? parts.join(' + ') : 'Clique sur les dés à lancer';
  $('dice-roll').title = what;
  $('dice-roll').disabled = $('dice-secret').disabled = $('dice-clear').disabled = !parts.length;
}

for (const [type, info] of Object.entries(DICE_TYPES)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'die-btn';
  b.dataset.type = type;
  b.title = `${info.hint}\nClic droit : en retirer un`;
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DIE_ICONS[type]}</svg><span>${type}</span><span class="count"></span>`;
  b.onclick = () => {
    if (pickedCount() + (type === 'd100' ? 2 : 1) > MAX_DICE) { toast(`${MAX_DICE} dés maximum par lancer.`); return; }
    picked[type]++;
    updateDiceUi();
  };
  b.oncontextmenu = (e) => {
    e.preventDefault();
    if (picked[type]) picked[type]--;
    updateDiceUi();
  };
  $('dice-picks').append(b);
}
updateDiceUi();

// The selection stays after a roll, to roll the same dice again easily
function rollDice(secret) {
  const dice = Object.entries(picked).flatMap(([t, n]) => Array(n).fill(t));
  if (!dice.length) return;
  socket.emit('dice:roll', { dice, secret }, (res) => {
    if (res && !res.ok && res.error) toast(res.error);
  });
}
$('dice-roll').onclick = () => rollDice(false);
$('dice-secret').onclick = () => rollDice(true);
$('dice-clear').onclick = () => {
  for (const t in picked) picked[t] = 0;
  updateDiceUi();
};
