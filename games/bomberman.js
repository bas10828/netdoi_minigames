'use strict';
const jwt = require('jsonwebtoken');

const GRID_W = 13, GRID_H = 11;
const BOT_NAMES = ['ShadowBot', 'GhostBot', 'CurseBot', 'PhantomBot'];
const RECONNECT_TIMEOUT = 30000;
const CELL = { EMPTY: 0, HARD: 1, SOFT: 2 };
const BASE_SPEED = 3.8;
const PLAYER_R = 0.32;
const SPAWN_POSITIONS = [
  { x: 1, y: 1 }, { x: GRID_W - 2, y: 1 },
  { x: 1, y: GRID_H - 2 }, { x: GRID_W - 2, y: GRID_H - 2 },
];
const POWERUPS = ['range', 'bombs', 'speed', 'wallbreak'];
const BOT_TICK_MS = 200;

const rooms = new Map();
const gameLoops = new Map();
const botTimers = new Map();
let bombIdCounter = 0;
let _pool = null;

// ── Room helpers ───────────────────────────────────────────────────────────────

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? makeCode() : code;
}

function makeRoom(hostId, hostName, roomName) {
  const code = makeCode();
  const room = {
    code, roomName: roomName || `ห้องของ ${hostName}`,
    hostId, hostName, locked: false, phase: 'lobby',
    players: [{ id: hostId, name: hostName, slot: 0, ready: true, isBot: false, connected: true, reconnectTimer: null }],
    spectators: [], gameState: null,
  };
  rooms.set(code, room);
  return room;
}

function roomSummary(r) {
  return {
    code: r.code, roomName: r.roomName, hostName: r.hostName,
    playerCount: r.players.length,
    humanCount: r.players.filter(p => !p.isBot).length,
    botCount: r.players.filter(p => p.isBot).length,
    locked: r.locked, phase: r.phase,
  };
}

function roomInfo(r) {
  return {
    code: r.code, hostId: r.hostId, locked: r.locked, phase: r.phase,
    players: r.players.map(p => ({ id: p.id, name: p.name, slot: p.slot, ready: p.ready, isBot: p.isBot, connected: p.connected })),
  };
}

function freeSlots(r) {
  const taken = new Set(r.players.map(p => p.slot));
  return [0, 1, 2, 3].filter(s => !taken.has(s));
}

function addBotToRoom(r) {
  const free = freeSlots(r);
  if (!free.length) return;
  const slot = free[0];
  r.players.push({ id: `bot-${slot}-${r.code}`, name: BOT_NAMES[slot], slot, ready: true, isBot: true, connected: true, reconnectTimer: null });
}

function removeBotFromRoom(r) {
  const idx = r.players.findIndex(p => p.isBot);
  if (idx !== -1) r.players.splice(idx, 1);
}

function allReady(r) { return r.players.length >= 2 && r.players.every(p => p.ready || p.isBot); }

function broadcastRoomList(nsp) {
  const list = [...rooms.values()].filter(r => !r.locked && r.phase === 'lobby').map(roomSummary);
  nsp.emit('roomListUpdate', list);
}

// ── Physics ────────────────────────────────────────────────────────────────────

function playerCell(p) { return { x: Math.floor(p.x), y: Math.floor(p.y) }; }

function isSolid(gs, cx, cy, pid) {
  if (cx < 0 || cy < 0 || cx >= GRID_W || cy >= GRID_H) return true;
  if (gs.map[cy][cx] !== CELL.EMPTY) return true;
  if (gs.bombs.some(b => b.x === cx && b.y === cy && b.passFor !== pid)) return true;
  return false;
}

function physicsMove(gs, p, dt, pid) {
  if (!p.dx && !p.dy) return;
  const spd = BASE_SPEED * (p.speed || 1) * dt / 1000;
  const R = PLAYER_R;
  let nx = p.x + p.dx * spd, ny = p.y + p.dy * spd;
  if (p.dx) {
    const ex = nx + (p.dx > 0 ? R : -R);
    const cy1 = Math.floor(p.y - R + 0.01), cy2 = Math.floor(p.y + R - 0.01);
    const cx = Math.floor(ex);
    const b1 = isSolid(gs, cx, cy1, pid), b2 = isSolid(gs, cx, cy2, pid);
    if (b1 || b2) {
      nx = p.dx > 0 ? cx - R - 0.001 : cx + 1 + R + 0.001;
      if (b1 !== b2) { const oy = b1 ? cy2 : cy1; ny += Math.sign(oy + 0.5 - p.y) * Math.min(Math.abs(oy + 0.5 - p.y), spd * 2); }
    }
  }
  if (p.dy) {
    const ey = ny + (p.dy > 0 ? R : -R);
    const cx1 = Math.floor(nx - R + 0.01), cx2 = Math.floor(nx + R - 0.01);
    const cy = Math.floor(ey);
    const b1 = isSolid(gs, cx1, cy, pid), b2 = isSolid(gs, cx2, cy, pid);
    if (b1 || b2) {
      ny = p.dy > 0 ? cy - R - 0.001 : cy + 1 + R + 0.001;
      if (b1 !== b2) { const ox = b1 ? cx2 : cx1; nx += Math.sign(ox + 0.5 - nx) * Math.min(Math.abs(ox + 0.5 - nx), spd * 2); }
    }
  }
  p.x = Math.max(R, Math.min(GRID_W - R, nx));
  p.y = Math.max(R, Math.min(GRID_H - R, ny));
}

function checkPowerups(gs, p) {
  const pIdx = gs.powerups.findIndex(pu => Math.abs(p.x - (pu.x + 0.5)) < 0.55 && Math.abs(p.y - (pu.y + 0.5)) < 0.55);
  if (pIdx === -1) return null;
  const pu = gs.powerups[pIdx];
  let wallbreakUser = null;
  if (pu.type === 'range') p.range = Math.min(p.range + 1, 8);
  else if (pu.type === 'bombs') p.maxBombs = Math.min(p.maxBombs + 1, 5);
  else if (pu.type === 'speed') p.speed = Math.min(p.speed + 0.5, 3);
  else if (pu.type === 'wallbreak') { p.hasWallbreak = true; wallbreakUser = { name: p.name, cleared: 0 }; }
  gs.powerups.splice(pIdx, 1);
  return { wallbreakUser, collected: { x: pu.x + 0.5, y: pu.y + 0.5, type: pu.type } };
}

function buildMap() {
  const map = [];
  for (let y = 0; y < GRID_H; y++) {
    map.push([]);
    for (let x = 0; x < GRID_W; x++) {
      if (x % 2 === 0 && y % 2 === 0) { map[y].push(CELL.HARD); continue; }
      const corner = (x <= 2 && y <= 2) || (x >= GRID_W - 3 && y <= 2) || (x <= 2 && y >= GRID_H - 3) || (x >= GRID_W - 3 && y >= GRID_H - 3);
      map[y].push(corner ? CELL.EMPTY : (Math.random() < 0.6 ? CELL.SOFT : CELL.EMPTY));
    }
  }
  return map;
}

function initGameState(room) {
  const map = buildMap();
  const players = {};
  room.players.forEach(p => {
    const pos = SPAWN_POSITIONS[p.slot];
    players[p.id] = {
      id: p.id, name: p.name, slot: p.slot, isBot: p.isBot,
      x: pos.x + 0.5, y: pos.y + 0.5, dx: 0, dy: 0,
      alive: true, speed: 1, maxBombs: 1, range: 1, kills: 0, selfKill: false,
      hasWallbreak: false, fleeUntil: 0, activeBombs: 0, _lastFleeDir: null,
    };
  });
  return {
    map, players, bombs: [], explosions: [], powerups: [],
    wallbreakSpawned: false, tick: 0,
    startedAt: Date.now(), suddenDeathAt: Date.now() + 3 * 60 * 1000, suddenDeathWave: 0,
  };
}

function placeBomb(gs, pid) {
  const p = gs.players[pid];
  if (!p || !p.alive) return null;
  if (p.activeBombs >= p.maxBombs) return null;
  const { x: bx, y: by } = playerCell(p);
  if (gs.bombs.find(b => b.x === bx && b.y === by)) return null;
  const bomb = { id: ++bombIdCounter, x: bx, y: by, ownerId: pid, timer: 3000, range: p.range, passFor: pid };
  gs.bombs.push(bomb);
  p.activeBombs++;
  return bomb;
}

function explodeBomb(gs, bomb, nsp, code) {
  gs.bombs = gs.bombs.filter(b => b.id !== bomb.id);
  const owner = gs.players[bomb.ownerId];
  if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);
  const cells = [{ x: bomb.x, y: bomb.y }];
  [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx, dy]) => {
    for (let i = 1; i <= bomb.range; i++) {
      const nx = bomb.x + dx * i, ny = bomb.y + dy * i;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) break;
      if (gs.map[ny][nx] === CELL.HARD) break;
      cells.push({ x: nx, y: ny });
      if (gs.map[ny][nx] === CELL.SOFT) {
        gs.map[ny][nx] = CELL.EMPTY;
        if (Math.random() < 0.35) {
          const pool = gs.wallbreakSpawned ? POWERUPS.filter(t => t !== 'wallbreak') : POWERUPS;
          const type = pool[Math.floor(Math.random() * pool.length)];
          if (type === 'wallbreak') gs.wallbreakSpawned = true;
          gs.powerups.push({ x: nx, y: ny, type });
        }
        if (!owner?.hasWallbreak) break;
      }
      const chain = gs.bombs.find(b => b.x === nx && b.y === ny);
      if (chain) chain.timer = 0;
    }
  });
  cells.forEach(({ x, y }) => {
    Object.values(gs.players).forEach(p => {
      if (p.alive && Math.floor(p.x) === x && Math.floor(p.y) === y) {
        p.alive = false;
        if (owner && owner.id === p.id) p.selfKill = true;
        else if (owner) owner.kills++;
        nsp.to(code).emit('playerDied', { playerId: p.id });
      }
    });
  });
  gs.explosions.push({ cells, timer: 500 });
  nsp.to(code).emit('explosion', { cells, bombId: bomb.id, ownerId: bomb.ownerId });
  nsp.to(code).emit('mapUpdate', { map: gs.map, powerups: gs.powerups });
}

function alivePlayers(gs) { return Object.values(gs.players).filter(p => p.alive); }

// ── Sudden death ───────────────────────────────────────────────────────────────

function applySuddenDeath(gs, wave, nsp, code) {
  const cells = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (x === wave || y === wave || x === GRID_W - 1 - wave || y === GRID_H - 1 - wave) {
        if (gs.map[y][x] !== CELL.HARD) {
          gs.map[y][x] = CELL.HARD; cells.push({ x, y });
          Object.values(gs.players).forEach(p => {
            if (p.alive && Math.floor(p.x) === x && Math.floor(p.y) === y) {
              p.alive = false; nsp.to(code).emit('playerDied', { playerId: p.id });
            }
          });
        }
      }
    }
  }
  if (cells.length) nsp.to(code).emit('suddenDeath', { cells, map: gs.map });
}

// ── Bot AI ─────────────────────────────────────────────────────────────────────

function isInBlastZone(gs, cx, cy) {
  for (const b of gs.bombs) {
    if (b.x === cx && b.y === cy) return true;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      for (let i = 1; i <= b.range; i++) {
        const nx = b.x + dx*i, ny = b.y + dy*i;
        if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) break;
        if (gs.map[ny][nx] === CELL.HARD) break;
        if (nx === cx && ny === cy) return true;
        if (gs.map[ny][nx] === CELL.SOFT && !gs.players[b.ownerId]?.hasWallbreak) break;
      }
    }
  }
  return false;
}

function bfs(gs, sx, sy, target, thruSoft) {
  const queue = [[sx, sy, null]], visited = new Set([`${sx},${sy}`]);
  while (queue.length) {
    const [cx, cy, first] = queue.shift();
    if (target && cx === target.x && cy === target.y) return first;
    if (!target && !isInBlastZone(gs, cx, cy) && !(cx === sx && cy === sy)) return first;
    for (const [d, dx, dy] of [['up',0,-1],['down',0,1],['left',-1,0],['right',1,0]]) {
      const nx = cx+dx, ny = cy+dy, k = `${nx},${ny}`;
      if (visited.has(k)||nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) continue;
      const cell = gs.map[ny][nx];
      if (cell === CELL.HARD) continue;
      if (!thruSoft && cell === CELL.SOFT) continue;
      if (target && isInBlastZone(gs, nx, ny)) continue;
      visited.add(k); queue.push([nx, ny, first ?? d]);
    }
  }
  return null;
}

function dirToDxDy(dir) {
  return dir==='right'?{dx:1,dy:0}:dir==='left'?{dx:-1,dy:0}:dir==='down'?{dx:0,dy:1}:{dx:0,dy:-1};
}

function startBotAI(room, nsp) {
  if (botTimers.has(room.code)) return;
  const timer = setInterval(() => {
    const r = rooms.get(room.code);
    if (!r || r.phase !== 'playing') { clearInterval(timer); botTimers.delete(room.code); return; }
    const gs = r.gameState;
    Object.values(gs.players).forEach(p => {
      if (!p.isBot || !p.alive) return;
      const { x: px, y: py } = playerCell(p);
      const now = Date.now();
      if (isInBlastZone(gs, px, py) || now < p.fleeUntil) {
        const dir = bfs(gs, px, py, null, false);
        if (dir) {
          const d = dirToDxDy(dir); p.dx = d.dx; p.dy = d.dy;
          p._lastFleeDir = dir;
        } else if (p._lastFleeDir) {
          const d = dirToDxDy(p._lastFleeDir); p.dx = d.dx; p.dy = d.dy;
        } else {
          const perp = [['up',0,-1],['down',0,1],['left',-1,0],['right',1,0]]
            .find(([,ddx,ddy]) => { const nx=px+ddx,ny=py+ddy; return nx>=0&&ny>=0&&nx<GRID_W&&ny<GRID_H&&gs.map[ny][nx]===CELL.EMPTY; });
          if (perp) { const d = dirToDxDy(perp[0]); p.dx = d.dx; p.dy = d.dy; }
          else { p.dx = 0; p.dy = 0; }
        }
        return;
      }
      p._lastFleeDir = null;
      const offCenter = Math.abs(p.x - (px+0.5)) > 0.22 || Math.abs(p.y - (py+0.5)) > 0.22;
      if (!offCenter && p.activeBombs < p.maxBombs && Math.random() < 0.28) {
        const enemies = Object.values(gs.players).filter(q => q.alive && q.id !== p.id);
        const nearTarget = [[0,-1],[0,1],[-1,0],[1,0]].some(([ddx,ddy]) => {
          for (let i=1; i<=p.range; i++) {
            const nx=px+ddx*i, ny=py+ddy*i;
            if (nx<0||ny<0||nx>=GRID_W||ny>=GRID_H) break;
            if (gs.map[ny][nx]===CELL.HARD) break;
            if (gs.map[ny][nx]===CELL.SOFT) return true;
            if (enemies.some(q => Math.hypot(q.x-(nx+0.5), q.y-(ny+0.5)) < 0.8)) return true;
          }
          return false;
        });
        const escDir = bfs({ ...gs, bombs: [...gs.bombs, { x:px, y:py, range:p.range }] }, px, py, null, false);
        if (nearTarget && escDir) {
          const bomb = placeBomb(gs, p.id);
          if (bomb) {
            nsp.to(r.code).emit('bombPlaced', { bomb, playerId: p.id });
            p.fleeUntil = Date.now() + 3400;
            const d = dirToDxDy(escDir); p.dx = d.dx; p.dy = d.dy;
            return;
          }
        }
      }
      const enemies = Object.values(gs.players).filter(q => q.alive && q.id !== p.id);
      let chased = false;
      if (enemies.length) {
        const target = enemies.reduce((a, b) => Math.hypot(a.x-p.x, a.y-p.y) < Math.hypot(b.x-p.x, b.y-p.y) ? a : b);
        const tx = Math.floor(target.x), ty = Math.floor(target.y);
        const dir = bfs(gs, px, py, {x:tx,y:ty}, false) ?? bfs(gs, px, py, {x:tx,y:ty}, true);
        if (dir) { const d = dirToDxDy(dir); p.dx = d.dx; p.dy = d.dy; chased = true; }
      }
      if (!chased) {
        const safe = [['up',0,-1],['down',0,1],['left',-1,0],['right',1,0]].filter(([,ddx,ddy]) => {
          const nx=px+ddx, ny=py+ddy;
          return nx>=0&&ny>=0&&nx<GRID_W&&ny<GRID_H&&gs.map[ny][nx]===CELL.EMPTY&&!gs.bombs.find(b=>b.x===nx&&b.y===ny)&&!isInBlastZone(gs,nx,ny);
        });
        if (safe.length) { const d = dirToDxDy(safe[Math.floor(Math.random()*safe.length)][0]); p.dx = d.dx; p.dy = d.dy; }
        else { p.dx = 0; p.dy = 0; }
      }
    });
  }, BOT_TICK_MS);
  botTimers.set(room.code, timer);
}

// ── Game loop ──────────────────────────────────────────────────────────────────

function startGameLoop(room, nsp) {
  let last = Date.now(), posAcc = 0;
  const timer = setInterval(() => {
    const r = rooms.get(room.code);
    if (!r || r.phase !== 'playing') { clearInterval(timer); gameLoops.delete(room.code); return; }
    const gs = r.gameState;
    const now = Date.now();
    const dt = Math.min(now - last, 50);
    last = now; gs.tick++;

    Object.values(gs.players).forEach(p => {
      if (!p.alive) return;
      gs.bombs.forEach(b => { if (b.passFor === p.id && (Math.floor(p.x) !== b.x || Math.floor(p.y) !== b.y)) delete b.passFor; });
      physicsMove(gs, p, dt, p.id);
      const result = checkPowerups(gs, p);
      if (result) {
        nsp.to(r.code).emit('powerupsUpdate', { powerups: gs.powerups });
        nsp.to(r.code).emit('powerupCollected', { ...result.collected, playerId: p.id });
        if (result.wallbreakUser) nsp.to(r.code).emit('wallbreakUsed', { ...result.wallbreakUser, playerId: p.id });
      }
    });

    const toExplode = [];
    gs.bombs.forEach(b => { b.timer -= dt; if (b.timer <= 0) toExplode.push(b); });
    toExplode.forEach(b => explodeBomb(gs, b, nsp, r.code));
    gs.explosions.forEach(e => { e.timer -= dt; });
    gs.explosions = gs.explosions.filter(e => e.timer > 0);

    if (now > gs.suddenDeathAt) {
      const wave = Math.floor((now - gs.suddenDeathAt) / 2000);
      if (wave > gs.suddenDeathWave) { gs.suddenDeathWave = wave; applySuddenDeath(gs, wave, nsp, r.code); }
    }

    const alive = alivePlayers(gs);
    if (alive.length <= 1) {
      r.phase = 'ended';
      const winner = alive[0] || null;
      const stats = Object.values(gs.players).map(p => ({ id: p.id, name: p.name, slot: p.slot, isBot: p.isBot, alive: p.alive, kills: p.kills, selfKill: p.selfKill }));
      nsp.to(r.code).emit('gameOver', { winner: winner ? { id: winner.id, name: winner.name } : null, stats });
      clearInterval(timer); gameLoops.delete(r.code);
      const bt = botTimers.get(r.code); if (bt) { clearInterval(bt); botTimers.delete(r.code); }
      if (winner && !winner.isBot && _pool) {
        _pool.query('INSERT INTO bomberman_scores (username, room_code, won) VALUES ($1, $2, true)', [winner.name, r.code])
          .catch(e => console.error('bomberman saveWin:', e.message));
      }
      return;
    }

    posAcc += dt;
    if (posAcc >= 16) {
      posAcc = 0;
      const pos = {};
      Object.values(gs.players).forEach(p => {
        pos[p.id] = { x: p.x, y: p.y, dx: p.dx, dy: p.dy, range: p.range, maxBombs: p.maxBombs, speed: p.speed, hasWallbreak: p.hasWallbreak, alive: p.alive };
      });
      nsp.to(r.code).emit('posUpdate', { players: pos, bombs: gs.bombs });
    }
  }, 16);
  gameLoops.set(room.code, timer);
}

// ── Leave / cleanup ────────────────────────────────────────────────────────────

function handleLeave(socket, code, nsp) {
  const r = rooms.get(code);
  if (!r) return;
  const idx = r.players.findIndex(p => p.id === socket.id);
  if (idx !== -1) {
    r.players.splice(idx, 1);
    socket.leave(code);
    if (r.players.filter(p => !p.isBot).length === 0) {
      rooms.delete(code);
      const lt = gameLoops.get(code); if (lt) { clearInterval(lt); gameLoops.delete(code); }
      const bt = botTimers.get(code); if (bt) { clearInterval(bt); botTimers.delete(code); }
    } else {
      if (r.hostId === socket.id) {
        const next = r.players.find(p => !p.isBot);
        if (next) { r.hostId = next.id; r.hostName = next.name; }
      }
      nsp.to(code).emit('roomUpdated', roomInfo(r));
    }
  }
  const si = r.spectators?.findIndex(s => s.id === socket.id) ?? -1;
  if (si !== -1) r.spectators.splice(si, 1);
  broadcastRoomList(nsp);
}

// ── Module export ──────────────────────────────────────────────────────────────

module.exports = function(app, io, pool, JWT_SECRET) {
  _pool = pool;

  pool.query(`
    CREATE TABLE IF NOT EXISTS bomberman_scores (
      id SERIAL PRIMARY KEY,
      username VARCHAR(20) NOT NULL,
      room_code VARCHAR(4) NOT NULL,
      won BOOLEAN NOT NULL DEFAULT false,
      played_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(e => console.error('bomberman table init:', e));

  const nsp = io.of('/bomberman');

  nsp.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('กรุณาล็อกอินก่อน'));
    try {
      socket.data.username = jwt.verify(token, JWT_SECRET).username;
      next();
    } catch { next(new Error('token ไม่ถูกต้อง')); }
  });

  nsp.on('connection', socket => {
    const name = socket.data.username;

    socket.on('listRooms', () => {
      socket.emit('roomList', [...rooms.values()].filter(r => !r.locked && r.phase === 'lobby').map(roomSummary));
    });

    socket.on('createRoom', ({ roomName } = {}) => {
      const r = makeRoom(socket.id, name, roomName);
      socket.join(r.code);
      socket.emit('roomCreated', roomInfo(r));
      broadcastRoomList(nsp);
    });

    socket.on('joinRoom', ({ code } = {}) => {
      const r = rooms.get(code?.toUpperCase());
      if (!r) return socket.emit('joinError', 'ไม่พบห้องนี้');
      if (r.locked) return socket.emit('joinError', 'ห้องถูกล็อคแล้ว');
      if (r.phase !== 'lobby') {
        r.spectators.push({ id: socket.id, name });
        socket.join(r.code);
        socket.emit('joinedAsSpectator', roomInfo(r));
        return;
      }
      const free = freeSlots(r);
      if (!free.length) return socket.emit('joinError', 'ห้องเต็มแล้ว');
      r.players.push({ id: socket.id, name, slot: free[0], ready: false, isBot: false, connected: true, reconnectTimer: null });
      socket.join(r.code);
      socket.emit('roomJoined', roomInfo(r));
      nsp.to(r.code).emit('roomUpdated', roomInfo(r));
      broadcastRoomList(nsp);
    });

    socket.on('rejoinRoom', ({ code } = {}) => {
      const r = rooms.get(code);
      if (!r) return socket.emit('joinError', 'ไม่พบห้องนี้');
      const player = r.players.find(p => p.name === name && !p.isBot);
      if (!player) return socket.emit('joinError', 'ไม่พบผู้เล่นในห้อง');
      if (player.reconnectTimer) { clearTimeout(player.reconnectTimer); player.reconnectTimer = null; }
      const oldId = player.id;
      player.id = socket.id; player.connected = true; player.isBot = false;
      if (r.hostId === oldId) r.hostId = socket.id;
      if (r.gameState?.players[oldId]) {
        r.gameState.players[socket.id] = { ...r.gameState.players[oldId], id: socket.id };
        delete r.gameState.players[oldId];
      }
      socket.join(r.code);
      if (r.phase === 'playing') socket.emit('gameStarted', { gameState: r.gameState, roomInfo: roomInfo(r) });
      else socket.emit('roomJoined', roomInfo(r));
      nsp.to(r.code).emit('roomUpdated', roomInfo(r));
    });

    socket.on('getRoom', ({ code } = {}) => {
      const r = rooms.get(code);
      if (!r) return socket.emit('joinError', 'ไม่พบห้องนี้');
      const player = r.players.find(p => p.id === socket.id);
      if (!player) return socket.emit('joinError', 'ไม่พบห้องนี้');
      if (r.phase === 'playing') socket.emit('gameStarted', { gameState: r.gameState, roomInfo: roomInfo(r) });
      else socket.emit('roomJoined', roomInfo(r));
    });

    socket.on('toggleLock', ({ code } = {}) => {
      const r = rooms.get(code);
      if (!r || r.hostId !== socket.id) return;
      r.locked = !r.locked;
      nsp.to(r.code).emit('roomUpdated', roomInfo(r));
    });

    socket.on('addBot', ({ code } = {}) => {
      const r = rooms.get(code);
      if (!r || r.hostId !== socket.id || r.phase !== 'lobby') return;
      addBotToRoom(r); nsp.to(r.code).emit('roomUpdated', roomInfo(r));
    });

    socket.on('removeBot', ({ code } = {}) => {
      const r = rooms.get(code);
      if (!r || r.hostId !== socket.id || r.phase !== 'lobby') return;
      removeBotFromRoom(r); nsp.to(r.code).emit('roomUpdated', roomInfo(r));
    });

    socket.on('setReady', ({ code, ready } = {}) => {
      const r = rooms.get(code);
      if (!r) return;
      const p = r.players.find(p => p.id === socket.id);
      if (p) p.ready = ready;
      nsp.to(r.code).emit('roomUpdated', roomInfo(r));
    });

    socket.on('startGame', ({ code } = {}) => {
      const r = rooms.get(code);
      if (!r || r.hostId !== socket.id) return;
      if (!allReady(r)) return socket.emit('startError', 'ผู้เล่นยังไม่พร้อมทุกคน');
      if (r.players.length < 2) return socket.emit('startError', 'ต้องมีผู้เล่นอย่างน้อย 2 คน');
      r.phase = 'countdown';
      nsp.to(r.code).emit('countdown', { seconds: 3 });
      let count = 3;
      const cd = setInterval(() => {
        count--;
        if (count > 0) { nsp.to(r.code).emit('countdown', { seconds: count }); return; }
        clearInterval(cd);
        r.phase = 'playing'; r.gameState = initGameState(r);
        nsp.to(r.code).emit('gameStarted', { gameState: r.gameState, roomInfo: roomInfo(r) });
        startGameLoop(r, nsp); startBotAI(r, nsp);
      }, 1000);
    });

    socket.on('setDir', ({ code, dx, dy } = {}) => {
      const r = rooms.get(code);
      if (!r || r.phase !== 'playing') return;
      const p = r.gameState.players[socket.id];
      if (!p?.alive) return;
      p.dx = Math.sign(dx || 0); p.dy = Math.sign(dy || 0);
    });

    socket.on('placeBomb', ({ code } = {}) => {
      const r = rooms.get(code);
      if (!r || r.phase !== 'playing') return;
      const bomb = placeBomb(r.gameState, socket.id);
      if (bomb) nsp.to(r.code).emit('bombPlaced', { bomb, playerId: socket.id });
    });

    socket.on('leaveRoom', ({ code } = {}) => {
      handleLeave(socket, code, nsp);
      socket.emit('leftRoom');
    });

    socket.on('requestRematch', ({ code } = {}) => {
      const r = rooms.get(code);
      if (!r || r.hostId !== socket.id) return;
      r.phase = 'lobby'; r.gameState = null;
      r.players.forEach(p => { p.ready = p.id === r.hostId || p.isBot; });
      nsp.to(r.code).emit('rematch', roomInfo(r));
    });

    socket.on('disconnect', () => {
      rooms.forEach(r => {
        const player = r.players.find(p => p.id === socket.id);
        if (player && !player.isBot) {
          player.connected = false;
          if (r.phase === 'playing') {
            player.isBot = true;
            nsp.to(r.code).emit('playerDisconnected', { playerId: socket.id, name: player.name });
            player.reconnectTimer = setTimeout(() => { player.reconnectTimer = null; }, RECONNECT_TIMEOUT);
          } else {
            // grace period for page navigation — rejoinRoom will cancel this timer
            player.reconnectTimer = setTimeout(() => {
              if (!player.connected) handleLeave(socket, r.code, nsp);
            }, 5000);
          }
        }
        const si = r.spectators?.findIndex(s => s.id === socket.id) ?? -1;
        if (si >= 0) r.spectators.splice(si, 1);
      });
    });
  });
};
