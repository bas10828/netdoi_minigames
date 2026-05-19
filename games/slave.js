const jwt = require('jsonwebtoken');

const SUIT_SYM        = ['♣','♦','♥','♠'];
const RANK_DISP       = { 11:'J', 12:'Q', 13:'K', 14:'A', 15:'2' };
const RANK_NAMES      = ['คิง 👑','ควีน 👸','สามัญชน 🧑','สเลฟ 😵'];
const BOT_NAMES       = ['VOID 🖤','REAPER ☠️','APEX ⚡'];
const BOT_THINK       = 1500;
const AUTO_PASS_DELAY = 30000;
const BOT_TAKEOVER_MS = Math.round(AUTO_PASS_DELAY * 0.75);
const TURN_AUTO_SEC   = 10;

function makeCard(rank, si) {
  return { rank, suitIndex: si, display: (RANK_DISP[rank] || rank) + SUIT_SYM[si] };
}
function createDeck() {
  const d = [];
  for (let si = 0; si < 4; si++) for (let r = 3; r <= 15; r++) d.push(makeCard(r, si));
  return d;
}
function shuffle(a) {
  const b = [...a];
  for (let i = b.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [b[i],b[j]]=[b[j],b[i]]; }
  return b;
}
const cardVal  = c => c.rank * 4 + c.suitIndex;
const maxVal   = cs => Math.max(...cs.map(cardVal));
const sortHand = cs => [...cs].sort((a,b) => cardVal(a)-cardVal(b));

function getType(cards) {
  if (!cards?.length) return null;
  const same = cards.every(c => c.rank === cards[0].rank);
  if (cards.length === 1) return 'single';
  if (cards.length === 2 && same) return 'pair';
  if (cards.length === 3 && same) return 'triple';
  if (cards.length === 4 && same) return 'quad';
  return null;
}
function canBeat(newCards, curPlay) {
  const t = getType(newCards);
  if (!t) return false;
  if (!curPlay) return true;
  const ct = curPlay.type, mv = maxVal(curPlay.cards);
  if (ct === 'single') return (t === 'single' && maxVal(newCards) > mv) || t === 'triple';
  if (ct === 'pair')   return (t === 'pair'   && maxVal(newCards) > mv) || t === 'quad';
  if (ct === 'triple') return t === 'triple' && maxVal(newCards) > mv;
  if (ct === 'quad')   return t === 'quad'   && maxVal(newCards) > mv;
  return false;
}

function groupByRank(hand) {
  const m = {};
  hand.forEach((c, i) => { (m[c.rank] = m[c.rank] || []).push(i); });
  return m;
}
function findBotCards(hand, curPlay) {
  if (!curPlay) {
    const best = hand.reduce((a,_,i) => cardVal(hand[i]) < cardVal(hand[a]) ? i : a, 0);
    return [best];
  }
  const ct = curPlay.type, mv = maxVal(curPlay.cards);
  if (ct === 'single') {
    // higher single or lowest triple
    const singles = hand.map((c,i)=>i).filter(i=>cardVal(hand[i])>mv).sort((a,b)=>cardVal(hand[a])-cardVal(hand[b]));
    if (singles.length) return [singles[0]];
    const triples = Object.values(groupByRank(hand))
      .filter(a=>a.length>=3)
      .map(a=>[...a].sort((x,y)=>hand[y].suitIndex-hand[x].suitIndex).slice(0,3))
      .sort((a,b)=>hand[a[0]].rank-hand[b[0]].rank);
    return triples.length ? triples[0] : null;
  }
  if (ct === 'pair') {
    // higher pair or lowest quad
    const pairs = Object.values(groupByRank(hand))
      .filter(a=>a.length>=2)
      .map(a=>a.slice(0,2))
      .filter(p=>maxVal(p.map(i=>hand[i]))>mv)
      .sort((a,b)=>maxVal(a.map(i=>hand[i]))-maxVal(b.map(i=>hand[i])));
    if (pairs.length) return pairs[0];
    const quads = Object.values(groupByRank(hand))
      .filter(a=>a.length>=4)
      .map(a=>a.slice(0,4))
      .sort((a,b)=>hand[a[0]].rank-hand[b[0]].rank);
    return quads.length ? quads[0] : null;
  }
  if (ct === 'triple') {
    // higher triple only
    const triples = Object.values(groupByRank(hand))
      .filter(a=>a.length>=3)
      .map(a=>[...a].sort((x,y)=>hand[y].suitIndex-hand[x].suitIndex).slice(0,3))
      .filter(t=>maxVal(t.map(i=>hand[i]))>mv)
      .sort((a,b)=>maxVal(a.map(i=>hand[i]))-maxVal(b.map(i=>hand[i])));
    return triples.length ? triples[0] : null;
  }
  if (ct === 'quad') {
    // higher quad only
    const quads = Object.values(groupByRank(hand))
      .filter(a=>a.length>=4)
      .map(a=>a.slice(0,4))
      .filter(q=>maxVal(q.map(i=>hand[i]))>mv)
      .sort((a,b)=>maxVal(a.map(i=>hand[i]))-maxVal(b.map(i=>hand[i])));
    return quads.length ? quads[0] : null;
  }
  return null;
}

const rooms = new Map();

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do { id = Array.from({length:4}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(id));
  return id;
}
function initRoom(id) {
  return {
    id, phase: 'lobby', round: 0,
    players: [], hands: {},
    turnOrder: [], turnIdx: 0,
    activeIds: new Set(),
    curPlay: null, passedIds: new Set(),
    finishOrder: [], round1Ranks: null,
    autoPassTimers: {},
    turnAutoTimer: null,
    turnAutoTimerFor: null,
    tableCards: [],
    swapPending: new Set(),
    swapGiving:  {},
    coupedPlayer: null,
  };
}
function getRoomList() {
  return [...rooms.values()]
    .filter(r => r.phase === 'lobby')
    .map(r => ({ id: r.id, humanCount: r.players.filter(p => !p.isBot).length }));
}
function broadcastRoomList(io) { io.emit('roomList', getRoomList()); }

function currentPlayerName(R) { return R.turnOrder[R.turnIdx % R.turnOrder.length]; }
function dealCards(R) {
  const deck = shuffle(createDeck());
  R.players.forEach((p, i) => { R.hands[p.name] = sortHand(deck.filter((_,j) => j % 4 === i)); });
}
function resetForRound(R) {
  clearTurnTimer(R);
  dealCards(R);
  R.activeIds   = new Set(R.turnOrder);
  R.curPlay     = null;
  R.passedIds   = new Set();
  R.finishOrder = [];
  R.tableCards  = [];
  R.coupedPlayer = null;
  R.players.forEach(p => { p.rankLabel = null; });
}
function findFirstPlayer(R) {
  for (const p of R.players)
    if (R.hands[p.name].some(c => c.rank === 3 && c.suitIndex === 0)) return p.name;
  return R.players[0].name;
}
function advanceTurn(R) {
  const n = R.turnOrder.length;
  let next = (R.turnIdx+1) % n;
  for (let i = 0; i < n; i++) {
    const name = R.turnOrder[next];
    if (R.activeIds.has(name) && !R.passedIds.has(name)) break;
    next = (next+1) % n;
  }
  R.turnIdx = next;
}
function setTurnTo(R, name) { R.turnIdx = R.turnOrder.indexOf(name); }
function allOthersPassed(R) {
  if (!R.curPlay) return false;
  return [...R.activeIds].filter(n => n !== R.curPlay.playerId).every(n => R.passedIds.has(n));
}
function getR1Role(R, name) {
  return R.round1Ranks?.find(r => r.name === name)?.rankLabel || null;
}
function broadcast(io, R) {
  R.players.filter(p => p.socketId && !p.isBot).forEach(p => {
    io.to(p.socketId).emit('state', {
      phase: R.phase, round: R.round, roomId: R.id,
      myHand:  R.hands[p.name] || [],
      myTurn:  currentPlayerName(R) === p.name,
      players: R.players.map(pl => ({
        name: pl.name, isBot: pl.isBot, disconnected: pl.disconnected,
        cardCount: (R.hands[pl.name]||[]).length,
        rankLabel: pl.rankLabel,
        isActive: R.activeIds.has(pl.name),
        isTurn: currentPlayerName(R) === pl.name,
        hasPassed: R.passedIds.has(pl.name),
      })),
      curPlay: R.curPlay, tableCards: R.tableCards, round1Ranks: R.round1Ranks,
      slaveHand: R.phase === 'roundEnd' ? (R.hands[R.round1Ranks?.[3]?.name] || []) : [],
      slaveName: R.phase === 'roundEnd' ? R.round1Ranks?.[3]?.name : null,
    });
  });
  scheduleTurnTimer(io, R);
}
function emitLobby(io, R) {
  io.to(R.id).emit('lobby', {
    roomId: R.id,
    players: R.players.map(p => ({ name: p.name, isBot: p.isBot })),
  });
}

function broadcastSwap(io, R) {
  const kingEntry  = R.round1Ranks?.find(r => r.rankLabel === RANK_NAMES[0]);
  const queenEntry = R.round1Ranks?.find(r => r.rankLabel === RANK_NAMES[1]);
  const comEntry   = R.round1Ranks?.find(r => r.rankLabel === RANK_NAMES[2]);
  const slaveEntry = R.round1Ranks?.find(r => r.rankLabel === RANK_NAMES[3]);
  const slaveGiving = slaveEntry
    ? [...R.hands[slaveEntry.name]].sort((a,b) => cardVal(b)-cardVal(a)).slice(0,2) : [];
  const comGiving = comEntry
    ? [...R.hands[comEntry.name]].sort((a,b) => cardVal(b)-cardVal(a)).slice(0,1) : [];
  R.players.filter(p => p.socketId && !p.isBot).forEach(p => {
    const role = getR1Role(R, p.name) || '';
    const data = { phase: 'cardSwap', round: 2, role, myHand: R.hands[p.name] || [] };
    if (kingEntry?.name === p.name) {
      data.mustPick = 2; data.receiving = slaveGiving; data.submitted = !!R.swapGiving[p.name];
    } else if (queenEntry?.name === p.name) {
      data.mustPick = 1; data.receiving = comGiving; data.submitted = !!R.swapGiving[p.name];
    } else if (slaveEntry?.name === p.name) {
      data.giving = slaveGiving;
    } else if (comEntry?.name === p.name) {
      data.giving = comGiving;
    }
    io.to(p.socketId).emit('swapState', data);
  });
}
function scheduleSwapBots(io, R) {
  if (R.phase !== 'cardSwap') return;
  R.players.filter(p => p.isBot && R.swapPending.has(p.name)).forEach(p => {
    const role = getR1Role(R, p.name) || '';
    const mustPick = role.includes('คิง') ? 2 : 1;
    const hand = R.hands[p.name];
    const indices = [...hand.keys()].sort((a,b) => cardVal(hand[a])-cardVal(hand[b])).slice(0, mustPick);
    setTimeout(() => {
      if (R.phase !== 'cardSwap' || !R.swapPending.has(p.name)) return;
      R.swapGiving[p.name] = indices.map(i => hand[i]);
      R.swapPending.delete(p.name);
      if (R.swapPending.size === 0) executeSwap(io, R);
    }, BOT_THINK);
  });
}
function executeSwap(io, R) {
  const kingEntry  = R.round1Ranks.find(r => r.rankLabel === RANK_NAMES[0]);
  const queenEntry = R.round1Ranks.find(r => r.rankLabel === RANK_NAMES[1]);
  const comEntry   = R.round1Ranks.find(r => r.rankLabel === RANK_NAMES[2]);
  const slaveEntry = R.round1Ranks.find(r => r.rankLabel === RANK_NAMES[3]);
  if (kingEntry && slaveEntry) {
    const kn = kingEntry.name, sn = slaveEntry.name;
    const kingGives  = R.swapGiving[kn] || [];
    const slaveGives = [...R.hands[sn]].sort((a,b) => cardVal(b)-cardVal(a)).slice(0,2);
    R.hands[kn] = sortHand([...R.hands[kn].filter(c => !kingGives.includes(c)), ...slaveGives]);
    R.hands[sn] = sortHand([...R.hands[sn].filter(c => !slaveGives.includes(c)), ...kingGives]);
  }
  if (queenEntry && comEntry) {
    const qn = queenEntry.name, cn = comEntry.name;
    const queenGives = R.swapGiving[qn] || [];
    const comGives   = [...R.hands[cn]].sort((a,b) => cardVal(b)-cardVal(a)).slice(0,1);
    R.hands[qn] = sortHand([...R.hands[qn].filter(c => !queenGives.includes(c)), ...comGives]);
    R.hands[cn] = sortHand([...R.hands[cn].filter(c => !comGives.includes(c)), ...queenGives]);
  }
  R.turnOrder   = R.players.map(p => p.name);
  R.activeIds   = new Set(R.turnOrder);
  R.curPlay     = null; R.passedIds = new Set();
  R.finishOrder = []; R.coupedPlayer = null;
  R.players.forEach(p => {
    const r1 = R.round1Ranks?.find(r => r.name === p.name);
    p.rankLabel = r1?.rankLabel || null;
  });
  if (slaveEntry && R.activeIds.has(slaveEntry.name)) setTurnTo(R, slaveEntry.name);
  R.phase = 'playing';
  io.to(R.id).emit('gameStart', { round: 2, roomId: R.id });
  broadcast(io, R);
  scheduleBots(io, R);
}

function doPlay(io, R, playerName, cards) {
  if (!canBeat(cards, R.curPlay)) return { ok:false, msg:'ไพ่ตีไม่ได้' };
  const type = getType(cards);
  R.hands[playerName] = R.hands[playerName].filter(c => !cards.includes(c));
  const finished = R.hands[playerName].length === 0;
  if (finished) {
    R.finishOrder.push(playerName);
    if (R.round === 2 && R.finishOrder.length === 1 && R.round1Ranks) {
      const r1Slave = R.round1Ranks.find(r => r.rankLabel === RANK_NAMES[3]);
      const r1King  = R.round1Ranks.find(r => r.rankLabel === RANK_NAMES[0]);
      if (r1Slave?.name === playerName && r1King && r1King.name !== playerName && R.activeIds.has(r1King.name)) {
        R.coupedPlayer = r1King.name;
        R.activeIds.delete(r1King.name);
        io.to(R.id).emit('coup', { usurper: playerName, deposed: r1King.name });
      }
    }
    if (R.round === 1) {
      io.to(R.id).emit('playerFinished', { name: playerName, rankLabel: RANK_NAMES[R.finishOrder.length - 1] });
    }
    R.activeIds.delete(playerName);
    if (R.activeIds.size <= 1) {
      if (R.activeIds.size === 1) {
        const slaveName = [...R.activeIds][0];
        R.finishOrder.push(slaveName);
        if (R.round === 1) {
          io.to(R.id).emit('playerFinished', { name: slaveName, rankLabel: RANK_NAMES[3] });
        }
      }
      R.activeIds.clear();
      endRound(io, R);
      return { ok:true, ended:true };
    }
  }
  R.curPlay    = { cards, type, playerId:playerName, playerName };
  R.tableCards = [...R.tableCards, ...cards];
  advanceTurn(R);
  broadcast(io, R);
  return { ok:true };
}
function doPass(io, R, playerName) {
  if (!R.curPlay) return { ok:false, msg:'โต๊ะว่าง ต้องเล่นก่อน' };
  R.passedIds.add(playerName);
  const canStillPlay = [...R.activeIds].filter(n => !R.passedIds.has(n));
  if (canStillPlay.length <= 1) {
    const last = R.curPlay.playerId;
    R.curPlay = null; R.passedIds = new Set(); R.tableCards = [];
    if (R.activeIds.has(last)) setTurnTo(R, last);
    else if (canStillPlay.length === 1) setTurnTo(R, canStillPlay[0]);
    else advanceTurn(R);
  } else {
    advanceTurn(R);
  }
  broadcast(io, R);
  return { ok:true };
}
function assignRanks(R) {
  R.finishOrder.forEach((name, i) => {
    const p = R.players.find(p => p.name === name);
    if (p) p.rankLabel = RANK_NAMES[i];
  });
}
function endRound(io, R) {
  clearTurnTimer(R);
  if (R.coupedPlayer && !R.finishOrder.includes(R.coupedPlayer)) R.finishOrder.push(R.coupedPlayer);
  assignRanks(R);
  if (R.round === 1) {
    R.round1Ranks = R.finishOrder.map((name, i) => ({ name, rankLabel: RANK_NAMES[i] }));
    R.phase = 'roundEnd';
    broadcast(io, R);
    const slaveEntry = R.round1Ranks[3];
    const slaveHand  = slaveEntry ? (R.hands[slaveEntry.name] || []) : [];
    setTimeout(() => io.to(R.id).emit('roundEnd', { ranks: R.round1Ranks, slaveHand, slaveName: slaveEntry?.name }), 5000);
  } else {
    R.phase = 'gameOver';
    const r2 = R.finishOrder.map((name, i) => ({ name, rankLabel: RANK_NAMES[i] }));
    broadcast(io, R);
    io.to(R.id).emit('gameOver', { r1: R.round1Ranks, r2 });
  }
}

function clearTimer(R, name) { clearTimeout(R.autoPassTimers[name]); delete R.autoPassTimers[name]; }
function scheduleAutoPass(io, R, name) {
  clearTimer(R, name);
  R.autoPassTimers[name] = setTimeout(() => {
    if (R.phase !== 'playing' || currentPlayerName(R) !== name) return;
    const p = R.players.find(p => p.name === name);
    if (!p?.disconnected) return;
    runBot(io, R, name, false);
    if (!['roundEnd','gameOver'].includes(R.phase)) {
      scheduleBots(io, R);
      if (currentPlayerName(R) === name) scheduleAutoPass(io, R, name);
    }
  }, BOT_TAKEOVER_MS);
}
function clearTurnTimer(R) { clearTimeout(R.turnAutoTimer); R.turnAutoTimer = null; R.turnAutoTimerFor = null; }
function scheduleTurnTimer(io, R) {
  if (R.phase !== 'playing') return;
  const name = currentPlayerName(R);
  if (R.turnAutoTimerFor === name && R.turnAutoTimer) return;
  clearTurnTimer(R);
  const p = R.players.find(p => p.name === name);
  if (!p || p.isBot) return;
  R.turnAutoTimerFor = name;
  R.turnAutoTimer = setTimeout(() => {
    R.turnAutoTimer = null; R.turnAutoTimerFor = null;
    if (R.phase !== 'playing' || currentPlayerName(R) !== name) return;
    runBot(io, R, name, false);
    if (!['roundEnd','gameOver'].includes(R.phase)) scheduleBots(io, R);
  }, TURN_AUTO_SEC * 1000);
}
function scheduleBots(io, R) {
  if (R.phase !== 'playing') return;
  const next = R.players.find(p => p.name === currentPlayerName(R));
  if (!next) return;
  if (next.isBot || next.disconnected)
    setTimeout(() => runBot(io, R, next.name, !!next.isBot), next.isBot ? BOT_THINK : 0);
}
function runBot(io, R, name, isBot) {
  if (R.phase !== 'playing' || currentPlayerName(R) !== name) return;
  const hand = R.hands[name];
  if (!hand?.length) return;
  const indices = findBotCards(hand, R.curPlay);
  const result  = indices ? doPlay(io, R, name, indices.map(i=>hand[i])) : doPass(io, R, name);
  if (!result.ended) scheduleBots(io, R);
}
function addBotPlayers(R) {
  const usedNames = new Set(R.players.map(p => p.name));
  let idx = 0;
  while (R.players.length < 4) {
    const name = BOT_NAMES[idx++] || `BOT-${idx}`;
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    R.players.push({ name, socketId:null, rankLabel:null, isBot:true, disconnected:false });
  }
}
function startGame(io, R, round) {
  R.round = round; R.turnOrder = R.players.map(p => p.name);
  resetForRound(R); setTurnTo(R, findFirstPlayer(R));
  R.phase = 'playing';
  io.to(R.id).emit('gameStart', { round, roomId: R.id });
  broadcast(io, R); scheduleBots(io, R);
}

module.exports = function(app, io, JWT_SECRET) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('กรุณาล็อกอินก่อน'));
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.data.username = payload.username;
      socket.data.roomId   = null;
      next();
    } catch { next(new Error('token ไม่ถูกต้อง')); }
  });

  setInterval(() => {
    for (const R of rooms.values()) {
      if (R.phase !== 'playing') continue;
      const next = R.players.find(p => p.name === currentPlayerName(R));
      if (next?.isBot) runBot(io, R, next.name, true);
    }
  }, 3000);

  app.get('/api/slave/debug', (req, res) => {
    res.json([...rooms.values()].map(R => ({
      id: R.id, phase: R.phase, round: R.round,
      currentPlayer: currentPlayerName(R),
      players: R.players.map(p => ({ name:p.name, isBot:p.isBot, disconnected:p.disconnected, cards:(R.hands[p.name]||[]).length })),
      curPlay: R.curPlay ? { type:R.curPlay.type, by:R.curPlay.playerId } : null,
      activeIds: [...R.activeIds], coupedPlayer: R.coupedPlayer,
    })));
  });

  function getRoom(socket) { return socket.data.roomId ? rooms.get(socket.data.roomId) : null; }

  io.on('connection', socket => {
    const name = socket.data.username;
    console.log('+ connect', socket.id, name);

    socket.on('tryRejoin', () => {
      for (const R of rooms.values()) {
        const p = R.players.find(p => p.name === name && !p.isBot);
        if (!p) continue;
        const wasDisconnected = p.disconnected;
        p.socketId = socket.id; p.disconnected = false;
        socket.data.roomId = R.id; socket.join(R.id);
        clearTimer(R, name);
        if (R.phase === 'lobby') emitLobby(io, R);
        else if (R.phase === 'cardSwap') broadcastSwap(io, R);
        else {
          socket.emit('rejoined', { roomId: R.id });
          broadcast(io, R);
          if (R.phase === 'roundEnd' && R.round1Ranks) {
            const se = R.round1Ranks[3];
            socket.emit('roundEnd', { ranks: R.round1Ranks, slaveHand: se ? (R.hands[se.name]||[]) : [], slaveName: se?.name });
          }
          else if (R.phase === 'gameOver') {
            const r2 = R.finishOrder.map((n, i) => ({ name: n, rankLabel: RANK_NAMES[i] }));
            socket.emit('gameOver', { r1: R.round1Ranks, r2 });
          }
          if (wasDisconnected) io.to(R.id).emit('playerRejoined', { name });
        }
        return;
      }
      socket.emit('rejoinFailed');
    });

    socket.on('getRooms', () => socket.emit('roomList', getRoomList()));

    socket.on('createRoom', () => {
      if (socket.data.roomId) return socket.emit('err', 'คุณอยู่ในห้องแล้ว');
      const id = genRoomId(); const R = initRoom(id);
      rooms.set(id, R);
      R.players.push({ name, socketId:socket.id, rankLabel:null, isBot:false, disconnected:false });
      socket.data.roomId = id; socket.join(id);
      broadcastRoomList(io); emitLobby(io, R);
    });

    socket.on('joinRoom', rawId => {
      const roomId = (rawId||'').toString().toUpperCase().trim();
      if (socket.data.roomId) return socket.emit('err', 'คุณอยู่ในห้องแล้ว');
      const R = rooms.get(roomId);
      if (!R)                  return socket.emit('err', 'ไม่พบห้อง');
      if (R.phase !== 'lobby') return socket.emit('err', 'เกมกำลังเล่นอยู่');
      if (R.players.filter(p=>!p.isBot).length >= 4) return socket.emit('err', 'ห้องเต็ม');
      if (R.players.find(p=>p.name===name)) return socket.emit('err', 'คุณอยู่ในห้องนี้แล้ว');
      R.players.push({ name, socketId:socket.id, rankLabel:null, isBot:false, disconnected:false });
      socket.data.roomId = R.id; socket.join(R.id);
      broadcastRoomList(io); emitLobby(io, R);
      if (R.players.filter(p=>!p.isBot).length === 4) startGame(io, R, 1);
    });

    socket.on('leaveRoom', () => {
      const R = getRoom(socket);
      if (!R || R.phase !== 'lobby') return;
      R.players = R.players.filter(p => p.name !== name);
      socket.leave(R.id); socket.data.roomId = null;
      if (R.players.filter(p=>!p.isBot).length === 0) {
        clearTurnTimer(R); Object.values(R.autoPassTimers).forEach(clearTimeout);
        rooms.delete(R.id);
      } else { emitLobby(io, R); }
      broadcastRoomList(io); socket.emit('leftRoom');
    });

    socket.on('startWithBots', () => {
      const R = getRoom(socket);
      if (!R)                  return socket.emit('err', 'ไม่ได้อยู่ในห้อง');
      if (R.phase !== 'lobby') return socket.emit('err', 'เกมกำลังเล่นอยู่');
      if (!R.players.some(p=>!p.isBot)) return socket.emit('err', 'ต้องมีผู้เล่นจริง 1 คน');
      addBotPlayers(R); broadcastRoomList(io); startGame(io, R, 1);
    });

    socket.on('play', indices => {
      const R = getRoom(socket);
      if (!R || R.phase !== 'playing') return;
      const p = R.players.find(p => p.socketId === socket.id);
      if (!p || currentPlayerName(R) !== p.name) return;
      if (!Array.isArray(indices) || !indices.length) return;
      if (R.passedIds.has(p.name)) return socket.emit('invalid','ผ่านไปแล้ว รอรอบหน้า');
      const hand = R.hands[p.name];
      if (!hand || indices.some(i=>i<0||i>=hand.length)) return socket.emit('invalid','ไม่ถูกต้อง');
      const cards = indices.map(i=>hand[i]);
      if (!getType(cards)) return socket.emit('invalid','ไพ่ที่เลือกไม่ถูกต้อง');
      const r = doPlay(io, R, p.name, cards);
      if (!r.ok) socket.emit('invalid', r.msg);
      else if (!r.ended) scheduleBots(io, R);
    });

    socket.on('pass', () => {
      const R = getRoom(socket);
      if (!R || R.phase !== 'playing') return;
      const p = R.players.find(p => p.socketId === socket.id);
      if (!p || currentPlayerName(R) !== p.name) return;
      const r = doPass(io, R, p.name);
      if (!r.ok) socket.emit('invalid', r.msg);
      else scheduleBots(io, R);
    });

    socket.on('startRound2', () => {
      const R = getRoom(socket);
      if (!R || R.phase !== 'roundEnd') return;
      dealCards(R);
      const kingEntry  = R.round1Ranks?.find(r => r.rankLabel === RANK_NAMES[0]);
      const queenEntry = R.round1Ranks?.find(r => r.rankLabel === RANK_NAMES[1]);
      R.swapPending = new Set(); R.swapGiving = {};
      if (kingEntry)  R.swapPending.add(kingEntry.name);
      if (queenEntry) R.swapPending.add(queenEntry.name);
      R.round = 2; R.phase = 'cardSwap';
      broadcastSwap(io, R); scheduleSwapBots(io, R);
    });

    socket.on('submitSwap', indices => {
      const R = getRoom(socket);
      if (!R || R.phase !== 'cardSwap') return;
      const p = R.players.find(pl => pl.socketId === socket.id);
      if (!p || !R.swapPending.has(p.name)) return socket.emit('err', 'ไม่ใช่เทิร์นแลกของคุณ');
      const role = getR1Role(R, p.name) || '';
      const mustPick = role.includes('คิง') ? 2 : 1;
      const hand = R.hands[p.name];
      if (!Array.isArray(indices) || indices.length !== mustPick)
        return socket.emit('err', `ต้องเลือก ${mustPick} ใบ`);
      if (indices.some(i => typeof i !== 'number' || i < 0 || i >= hand.length))
        return socket.emit('err', 'index ไม่ถูกต้อง');
      R.swapGiving[p.name] = indices.map(i => hand[i]);
      R.swapPending.delete(p.name);
      if (R.swapPending.size === 0) executeSwap(io, R);
      else broadcastSwap(io, R);
    });

    socket.on('requestState', () => {
      const R = getRoom(socket);
      if (!R) return;
      if (R.phase === 'playing') broadcast(io, R);
      else if (R.phase === 'roundEnd') {
        broadcast(io, R);
        if (R.round1Ranks) {
          const se = R.round1Ranks[3];
          socket.emit('roundEnd', { ranks: R.round1Ranks, slaveHand: se ? (R.hands[se.name]||[]) : [], slaveName: se?.name });
        }
      } else if (R.phase === 'gameOver') {
        broadcast(io, R);
        const r2 = R.finishOrder.map((n, i) => ({ name: n, rankLabel: RANK_NAMES[i] }));
        socket.emit('gameOver', { r1: R.round1Ranks, r2 });
      } else if (R.phase === 'lobby') emitLobby(io, R);
      else if (R.phase === 'cardSwap') broadcastSwap(io, R);
    });

    socket.on('newGame', () => {
      const R = getRoom(socket);
      if (!R || R.phase !== 'gameOver') return;
      clearTurnTimer(R); Object.values(R.autoPassTimers).forEach(clearTimeout);
      R.phase='lobby'; R.round=0; R.hands={};
      R.turnOrder=[]; R.turnIdx=0; R.activeIds=new Set();
      R.curPlay=null; R.passedIds=new Set();
      R.finishOrder=[]; R.round1Ranks=null; R.autoPassTimers={}; R.turnAutoTimerFor=null;
      R.tableCards=[]; R.swapPending=new Set(); R.swapGiving={}; R.coupedPlayer=null;
      R.players = R.players.filter(p => !p.isBot);
      R.players.forEach(p => { p.rankLabel=null; });
      broadcastRoomList(io); emitLobby(io, R);
    });

    socket.on('disconnect', () => {
      console.log('- disconnect', socket.id, name);
      const R = getRoom(socket);
      if (!R) return;
      socket.data.roomId = null;
      if (R.phase === 'lobby') {
        R.players = R.players.filter(p => p.socketId !== socket.id);
        if (R.players.filter(p=>!p.isBot).length === 0) {
          clearTurnTimer(R); Object.values(R.autoPassTimers).forEach(clearTimeout);
          rooms.delete(R.id);
        } else { emitLobby(io, R); }
        broadcastRoomList(io);
      } else {
        const p = R.players.find(p => p.socketId === socket.id && !p.isBot);
        if (p) {
          p.socketId=null; p.disconnected=true;
          console.log('⚠ disconnected:', p.name, 'room:', R.id);
          io.to(R.id).emit('playerDisconnected', { name: p.name });
          if (R.phase === 'playing' && currentPlayerName(R) === p.name) scheduleAutoPass(io, R, p.name);
          if (R.phase === 'playing') broadcast(io, R);
        }
      }
    });
  });
};
