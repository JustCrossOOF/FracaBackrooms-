// Backrooms Drop-in v2 — Uso: npm i socket.io && node server.js
var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT || 3000;
var MAX_PLAYERS = 64;
var TICK_MS = 100;            // simulación + broadcast a 10 Hz
var T = 16;                   // tamaño de tile (igual que el cliente)
var MONSTER_SPEED = 38;       // px/s (el jugador va a 64)
var CATCH_DIST = 9;           // px
var MAX_WEAPONS = 10;
var COLORS = ['#e63946', '#2a9d8f', '#4361ee', '#f4a261', '#9b5de5', '#06d6a0', '#ff70a6', '#e9ecef'];

/* ---------- Mapa determinista (DEBE ser idéntico al del cliente) ---------- */
function hash(a, b) {
  var n = (a * 73856093) ^ (b * 19349663);
  n = ((n ^ (n >>> 15)) * 2654435) | 0;
  n = n ^ (n >>> 13);
  return n >>> 0;
}
function door(r, m) {
  if (r === 0) return false;
  if (r < 3) return !(m === 3 || m === 4);
  return !(m >= 2 && m <= 5);
}
function wall(tx, ty) {
  var mx = tx & 7, my = ty & 7, bx = tx >> 3, by = ty >> 3;
  if (mx === 0) { if (my === 0) return true; return door(hash(bx, by) % 5, my); }
  if (my === 0) return door(hash(bx + 977, by) % 5, mx);
  if (mx >= 2 && mx <= 6 && my >= 2 && my <= 6 && mx !== 3 && mx !== 4 && my !== 3 && my !== 4) {
    return hash(tx, ty) % 4 === 0;
  }
  return false;
}
function randFree(cx, cy, rmin, rmax) {
  for (var i = 0; i < 30; i++) {
    var a = Math.random() * 6.2832, r = rmin + Math.random() * (rmax - rmin);
    var tx = Math.floor((cx + Math.cos(a) * r) / T), ty = Math.floor((cy + Math.sin(a) * r) / T);
    if (!wall(tx, ty)) return { x: tx * T + T / 2, y: ty * T + T / 2 };
  }
  return null;
}

/* ---------- HTTP + Socket.io ---------- */
var html = fs.existsSync(path.join(__dirname, 'index.html')) ? fs.readFileSync(path.join(__dirname, 'index.html')) : '';
var server = http.createServer(function (req, res) {
  var u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  } else { res.writeHead(404); res.end(); }
});
var io = require('socket.io')(server, {
  transports: ['websocket', 'polling'], perMessageDeflate: false, pingInterval: 10000, pingTimeout: 20000
});

/* ---------- Estado ---------- */
var players = {};   // id -> {x,y,c,w,a,t,at,safe,s}
var weps = {};      // id -> {t,x,y}   t: 1 pistola, 2 escopeta, 3 subfusil
var monster = { x: 328, y: 328, stun: 0, stuck: 0 };
var nextId = 1, nextW = 1, count = 0, wc = 0, dirty = false;

function spawnPos(p) { p.x = 56 + Math.floor(Math.random() * 16); p.y = 56 + Math.floor(Math.random() * 16); }

/* ---------- Armas ---------- */
function spawnWeaponNear(p) {
  var pos = randFree(p.x, p.y, 50, 280);
  if (!pos) return;
  var id = nextW++, t = 1 + Math.floor(Math.random() * 3);
  weps[id] = { t: t, x: pos.x, y: pos.y };
  wc++;
  io.emit('w+', [id, t, pos.x, pos.y]);
}
function upkeepWeapons() {
  var ids = Object.keys(players), i, wid;
  for (wid in weps) {
    var w = weps[wid], far = true;
    for (i = 0; i < ids.length; i++) {
      var p = players[ids[i]], dx = w.x - p.x, dy = w.y - p.y;
      if (dx * dx + dy * dy < 360000) { far = false; break; }
    }
    if (far) { delete weps[wid]; wc--; io.emit('w-', +wid); }
  }
  if (wc < Math.min(MAX_WEAPONS, 3 + ids.length * 2) && ids.length > 0) {
    spawnWeaponNear(players[ids[Math.floor(Math.random() * ids.length)]]);
  }
}

/* ---------- Monstruo: BFS acotado sobre la rejilla de tiles ---------- */
var R = 24, N = 2 * R;
var prev = new Int32Array(N * N), queue = new Int32Array(N * N);
var DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];

function plan(tp) {
  var sx = Math.floor(monster.x / T), sy = Math.floor(monster.y / T);
  var tx = Math.floor(tp.x / T), ty = Math.floor(tp.y / T);
  if (sx === tx && sy === ty) return [tp.x, tp.y];
  var ox = sx - R, oy = sy - R, s = R * N + R;
  prev.fill(-2); prev[s] = -1; queue[0] = s;
  var qh = 0, qt = 1, best = s, bd = Math.abs(sx - tx) + Math.abs(sy - ty);
  while (qh < qt) {
    var cur = queue[qh++], cx = ox + (cur % N), cy = oy + ((cur / N) | 0);
    var h = Math.abs(cx - tx) + Math.abs(cy - ty);
    if (h < bd) { bd = h; best = cur; if (!h) break; }
    for (var k = 0; k < 4; k++) {
      var nx = cx + DX[k], ny = cy + DY[k], lx = nx - ox, ly = ny - oy;
      if (lx < 0 || ly < 0 || lx >= N || ly >= N) continue;
      var ni = ly * N + lx;
      if (prev[ni] !== -2 || wall(nx, ny)) continue;
      prev[ni] = cur; queue[qt++] = ni;
    }
  }
  if (best === s) return null;
  var c = best;
  while (prev[c] !== s) c = prev[c];
  return [(ox + (c % N)) * T + T / 2, (oy + ((c / N) | 0)) * T + T / 2];
}

function nearestPlayer() {
  var best = null, bd = Infinity;
  for (var id in players) {
    var p = players[id], dx = p.x - monster.x, dy = p.y - monster.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function moveMonster(dt) {
  if (monster.stun > 0) { monster.stun -= dt; return; }
  var tp = nearestPlayer();
  if (!tp) return;
  var wp = plan(tp);
  if (!wp) {
    monster.stuck += dt;
    if (monster.stuck > 4) {
      var pos = randFree(tp.x, tp.y, 150, 260);
      if (pos) { monster.x = pos.x; monster.y = pos.y; }
      monster.stuck = 0;
    }
    return;
  }
  monster.stuck = 0;
  var dx = wp[0] - monster.x, dy = wp[1] - monster.y, d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.01) return;
  var step = Math.min(d, MONSTER_SPEED * dt);
  monster.x += dx / d * step;
  monster.y += dy / d * step;
}

function respawn(p, id, now) {
  spawnPos(p);
  p.w = 0; p.t = now; p.safe = now + 3000;
  monster.stun = 2;
  p.s.emit('fix', [p.x, p.y, 1]);
  io.emit('pw', [+id, 0]);
  dirty = true;
}

/* ---------- Conexiones ---------- */
io.on('connection', function (socket) {
  if (count >= MAX_PLAYERS) { socket.disconnect(true); return; }
  var id = nextId++, now = Date.now();
  var p = { x: 0, y: 0, c: Math.floor(Math.random() * COLORS.length), w: 0, a: '', t: now, at: 0, safe: now + 3000, s: socket };
  spawnPos(p);
  if (count === 0) {
    var mp = randFree(p.x, p.y, 350, 450);
    if (mp) { monster.x = mp.x; monster.y = mp.y; }
    monster.stun = 0;
  }
  players[id] = p; count++;
  if (wc < 2) spawnWeaponNear(p);

  var list = [], wl = [], k;
  for (k in players) { var q = players[k]; list.push([+k, q.x, q.y, q.c, q.w, q.a]); }
  for (k in weps) wl.push([+k, weps[k].t, weps[k].x, weps[k].y]);
  
  socket.emit('init', { id: id, colors: COLORS, list: list, wl: wl, m: [Math.round(monster.x), Math.round(monster.y)] });
  socket.broadcast.emit('j', [id, p.x, p.y, p.c, p.w, p.a]);

  socket.on('m', function (d) {
    if (!d || typeof d[0] !== 'number' || typeof d[1] !== 'number') return;
    var n = Date.now(), dt = Math.min((n - p.t) / 1000, 1);
    p.t = n;
    var max = 110 * dt + 24, dx = d[0] - p.x, dy = d[1] - p.y;
    if (dx * dx + dy * dy > max * max) { socket.emit('fix', [p.x, p.y]); return; }
    p.x = Math.round(d[0]); p.y = Math.round(d[1]);
    dirty = true;
  });

  socket.on('av', function (s) {
    var n = Date.now();
    if (n - p.at < 400) return;
    p.at = n;
    if (typeof s !== 'string' || !/^[0-9a-f]{64}$/.test(s) || /^0+$/.test(s)) return;
    p.a = s;
    socket.broadcast.emit('av', [id, s]);
  });

  // Manejo de Disparo integrado
  socket.on('shoot', function (data) {
    if (!p.w) return; // Si no tiene arma, ignora
    var dx = data.x - monster.x, dy = data.y - monster.y;
    if (dx * dx + dy * dy < 3600) { // Si el disparo cae cerca del monstruo (~60px)
      monster.stun = 3; // Lo aturde 3 segundos
    }
    socket.broadcast.emit('shot', { id: id, x: data.x, y: data.y });
  });

  socket.on('disconnect', function () {
    delete players[id]; count--;
    io.emit('l', id);
  });
});

/* ---------- Bucle principal ---------- */
var lastT = Date.now(), acc = 0;
setInterval(function () {
  var now = Date.now(), dt = Math.min((now - lastT) / 1000, 0.25);
  lastT = now;
  if (!count) return;

  moveMonster(dt);

  var id, p, wid, w, dx, dy;
  for (id in players) {
    p = players[id];
    for (wid in weps) {
      w = weps[wid]; dx = w.x - p.x; dy = w.y - p.y;
      if (dx * dx + dy * dy < 144 && p.w !== w.t) {
        p.w = w.t; delete weps[wid]; wc--;
        io.emit('w-', +wid);
        io.emit('pw', [+id, p.w]);
        break;
      }
    }
    if (monster.stun <= 0 && now > p.safe) {
      dx = p.x - monster.x; dy = p.y - monster.y;
      if (dx * dx + dy * dy < CATCH_DIST * CATCH_DIST) respawn(p, id, now);
    }
  }

  acc += dt;
  if (acc >= 3) { acc = 0; upkeepWeapons(); }

  var arr = null;
  if (dirty) {
    dirty = false; arr = [];
    for (id in players) arr.push(+id, players[id].x, players[id].y);
  }
  io.volatile.emit('p', arr, Math.round(monster.x), Math.round(monster.y));
}, TICK_MS);

server.listen(PORT, function () { console.log('Backrooms corriendo en puerto ' + PORT); });
