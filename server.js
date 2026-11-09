// Backrooms Drop-in — servidor mínimo. Uso: npm i socket.io && node server.js
var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT || 3000;
var MAX_PLAYERS = 64;
var TICK_MS = 100; // 10 broadcasts por segundo
var COLORS = ['#e63946', '#2a9d8f', '#4361ee', '#f4a261', '#9b5de5', '#06d6a0', '#ff70a6', '#e9ecef'];

var html = fs.readFileSync(path.join(__dirname, 'index.html'));
var server = http.createServer(function (req, res) {
  var u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end();
  }
});

var io = require('socket.io')(server, {
  transports: ['websocket', 'polling'],
  perMessageDeflate: false,
  pingInterval: 10000,
  pingTimeout: 20000
});

var players = {}; // id -> {x, y, c, t}
var nextId = 1;
var count = 0;
var dirty = false;

io.on('connection', function (socket) {
  if (count >= MAX_PLAYERS) { socket.disconnect(true); return; }

  var id = nextId++;
  var p = {
    x: 56 + Math.floor(Math.random() * 16), // zona de aparición libre de muros
    y: 56 + Math.floor(Math.random() * 16),
    c: Math.floor(Math.random() * COLORS.length),
    t: Date.now()
  };
  players[id] = p;
  count++;

  // lista completa para el recién llegado: [id, x, y, color, ...]
  var list = [];
  for (var k in players) {
    var q = players[k];
    list.push(+k, q.x, q.y, q.c);
  }
  socket.emit('init', { id: id, colors: COLORS, list: list });
  socket.broadcast.emit('j', [id, p.x, p.y, p.c]);

  socket.on('m', function (d) {
    if (!d || typeof d[0] !== 'number' || typeof d[1] !== 'number') return;
    var now = Date.now();
    var dt = Math.min((now - p.t) / 1000, 1);
    p.t = now;
    // anti-teletransporte básico (el cliente va a ~64 px/s)
    var max = 110 * dt + 24;
    var dx = d[0] - p.x, dy = d[1] - p.y;
    if (dx * dx + dy * dy > max * max) { socket.emit('fix', [p.x, p.y]); return; }
    p.x = Math.round(d[0]);
    p.y = Math.round(d[1]);
    dirty = true;
  });

  socket.on('disconnect', function () {
    delete players[id];
    count--;
    io.emit('l', id);
  });
});

// Un único broadcast compacto por tick: [id, x, y, id, x, y, ...]
setInterval(function () {
  if (!dirty) return;
  dirty = false;
  var a = [];
  for (var k in players) a.push(+k, players[k].x, players[k].y);
  io.volatile.emit('p', a);
}, TICK_MS);

server.listen(PORT, function () {
  console.log('Backrooms en http://localhost:' + PORT);
});
