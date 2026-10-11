// Tavern server: serves the site and syncs players (Socket.IO)
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'donjon';
const SEAT_COUNT = 4;
const MAX_BEERS = 40;
const DRINK_MS = 2200; // must match main.js
const DICE_FACES = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100: 100 }; // same list in dice.js
const MAX_DICE = 10;  // per roll, a d100 counts as two dice (same value in main.js)
const ROLL_COOLDOWN_MS = 800;
const GM_LOOK = { name: 'Maître du jeu', color: '#f2b441', icon: '👑' };
const ICONS = ['🧙', '⚔️', '🏹', '🐉', '🗡️', '🛡️', '🔮', '🍺', '🎲', '🦉', '🧝', '🧛'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Only serve the site files (not server.js)
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
for (const f of ['index.html', 'main.js', 'dice.js', 'style.css']) {
  app.get(f === 'index.html' ? '/' : '/' + f, (req, res) => res.sendFile(path.join(__dirname, f)));
}
app.use('/Models', express.static(path.join(__dirname, 'Models')));

// Table state (in memory)
const seats = new Array(SEAT_COUNT).fill(null); // { socketId, name, color, icon }
let beers = [];                                  // { id, type, u, v }
let nextBeerId = 1;
let nextRollId = 1;

function publicState() {
  return {
    seats: seats.map((s) => (s ? { name: s.name, color: s.color, icon: s.icon } : null)),
    beers,
  };
}
const broadcast = () => io.emit('state', publicState());

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const findBeer = (id) => beers.find((b) => b.id === id);

// (u, v) position of each seat's nameplate: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
function seatSpot(seat) {
  return { u: seat % 2 === 0 ? -0.5 : 0.5, v: seat < 2 ? -0.68 : 0.68 };
}

function startDrinking(beer, spot) {
  beer.drinking = true;
  beer.u = spot.u;
  beer.v = spot.v;
  const id = beer.id;
  setTimeout(() => {
    const b = findBeer(id);
    if (!b) return;
    b.drinking = false;
    b.type = 'empty'; // the full beer becomes empty, right where it was drunk on the nameplate
    broadcast();
  }, DRINK_MS);
}

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.role) return ack({ ok: false, error: 'Tu es déjà à la table.' });

    if (data && data.role === 'admin') {
      if (data.password !== ADMIN_PASSWORD) return ack({ ok: false, error: 'Mot de passe incorrect.' });
      socket.data.role = 'admin';
      return ack({ ok: true, role: 'admin' });
    }

    const name = String((data && data.name) || '').trim().slice(0, 16);
    const color = String((data && data.color) || '');
    const icon = String((data && data.icon) || '');
    if (!name) return ack({ ok: false, error: 'Choisis un pseudo.' });
    if (!/^#[0-9a-f]{6}$/i.test(color)) return ack({ ok: false, error: 'Couleur invalide.' });
    if (!ICONS.includes(icon)) return ack({ ok: false, error: 'Icône invalide.' });

    const seat = seats.findIndex((s) => s === null);
    if (seat === -1) return ack({ ok: false, error: 'La table est complète (4 joueurs).' });

    seats[seat] = { socketId: socket.id, name, color, icon };
    socket.data.role = 'player';
    socket.data.seat = seat;
    ack({ ok: true, role: 'player', seat });
    broadcast();
  });

  socket.on('beer:add', (data) => {
    if (socket.data.role !== 'admin') return;
    const type = data && data.type === 'empty' ? 'empty' : 'full';
    if (beers.length >= MAX_BEERS) return;
    // u and v: position on the table, between -1 and 1 (0 = center)
    beers.push({
      id: nextBeerId++,
      type,
      u: (Math.random() - 0.5) * 0.9,
      v: (Math.random() - 0.5) * 0.5,
      holder: null,   // id of the person holding it
      drinking: false,
    });
    broadcast();
  });

  socket.on('beer:clear', () => {
    if (socket.data.role !== 'admin') return;
    beers = [];
    broadcast();
  });

  // Pick up a beer
  socket.on('beer:grab', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!socket.data.role) return reply({ ok: false });
    const b = findBeer(data && data.id);
    if (!b) return reply({ ok: false });
    if (b.drinking) return reply({ ok: false, error: "Cette bière est en train d'être bue." });
    if (b.holder && b.holder !== socket.id) {
      return reply({ ok: false, error: "Cette bière est dans la main de quelqu'un d'autre." });
    }
    if (beers.some((x) => x.holder === socket.id && x.id !== b.id)) {
      return reply({ ok: false, error: 'Tu tiens déjà une bière.' });
    }
    b.holder = socket.id;
    broadcast();
    reply({ ok: true });
  });

  // Move the beer being held (sent often, so keep the message light)
  socket.on('beer:move', (data) => {
    const b = findBeer(data && data.id);
    if (!b || b.holder !== socket.id || !isNum(data.u) || !isNum(data.v)) return;
    b.u = clamp(data.u, -0.95, 0.95);
    b.v = clamp(data.v, -0.95, 0.95);
    socket.broadcast.emit('beer:moved', { id: b.id, u: b.u, v: b.v });
  });

  // Drop the beer. If full and dropped on YOUR OWN nameplate, it gets drunk.
  socket.on('beer:release', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const b = findBeer(data && data.id);
    if (!b || b.holder !== socket.id) return reply({ ok: false });
    if (isNum(data.u) && isNum(data.v)) {
      b.u = clamp(data.u, -0.95, 0.95);
      b.v = clamp(data.v, -0.95, 0.95);
    }
    b.holder = null;

    let message = null;
    if (socket.data.role === 'player') {
      const spot = seatSpot(socket.data.seat); // only YOUR OWN nameplate
      const onPlate = Math.abs(b.u - spot.u) < 0.27 && Math.abs(b.v - spot.v) < 0.22;
      console.log(`[lâcher] ${seats[socket.data.seat].name} : bière #${b.id} (${b.type}) en u=${b.u.toFixed(2)} v=${b.v.toFixed(2)} -> sur sa plaque : ${onPlate ? 'oui' : 'non'}`);
      if (onPlate && b.type === 'full') startDrinking(b, spot);
      else if (onPlate && b.type === 'empty') message = 'Cette chope est vide !';
    }
    broadcast();
    reply({ ok: true, message });
  });

  // Roll dice: the server picks the results so nobody can cheat.
  // A secret roll (game master only) is only sent back to the game master.
  socket.on('dice:roll', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!socket.data.role) return reply({ ok: false });
    const secret = !!(data && data.secret);
    if (secret && socket.data.role !== 'admin') return reply({ ok: false, error: 'Seul le maître du jeu peut lancer en secret.' });
    const types = Array.isArray(data && data.dice) ? data.dice : [];
    if (!types.length || !types.every((t) => Object.hasOwn(DICE_FACES, t))) return reply({ ok: false, error: 'Choisis au moins un dé.' });
    if (types.reduce((n, t) => n + (t === 'd100' ? 2 : 1), 0) > MAX_DICE) {
      return reply({ ok: false, error: `${MAX_DICE} dés maximum par lancer.` });
    }
    const now = Date.now();
    if (now - (socket.data.lastRoll || 0) < ROLL_COOLDOWN_MS) return reply({ ok: false, error: 'Doucement, les dés roulent encore !' });
    socket.data.lastRoll = now;

    const by = socket.data.role === 'admin'
      ? { ...GM_LOOK, seat: -1 }
      : (({ name, color, icon }) => ({ name, color, icon, seat: socket.data.seat }))(seats[socket.data.seat]);
    const roll = {
      id: nextRollId++,
      by,
      secret,
      seed: crypto.randomInt(2 ** 31), // same seed = same throw animation for everyone
      dice: types.map((type) => ({ type, value: crypto.randomInt(1, DICE_FACES[type] + 1) })),
    };
    console.log(`[dés] ${by.name}${secret ? ' (secret)' : ''} : ${roll.dice.map((d) => `${d.type}=${d.value}`).join(' ')}`);
    if (secret) {
      socket.emit('dice:rolled', roll);
      socket.broadcast.emit('dice:secret');
    } else {
      io.emit('dice:rolled', roll);
    }
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    let changed = false;
    for (const b of beers) {
      if (b.holder === socket.id) { b.holder = null; changed = true; }
    }
    if (socket.data.role === 'player') {
      seats[socket.data.seat] = null;
      changed = true;
    }
    if (changed) broadcast();
  });
});

server.listen(PORT, () => {
  console.log(`Taverne ouverte : http://localhost:${PORT}`);
  console.log(`Mot de passe du maître du jeu : ${ADMIN_PASSWORD}`);
});
