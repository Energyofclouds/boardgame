const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Health check endpoint for Render monitoring
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// Serve static client files from 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to serve the main HTML
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Official Las Vegas Money Distribution (54 cards total)
const BANKNOTE_DECK_INITIAL = [
  ...Array(5).fill(10000),
  ...Array(8).fill(20000),
  ...Array(11).fill(30000),
  ...Array(9).fill(40000),
  ...Array(6).fill(50000),
  ...Array(6).fill(60000),
  ...Array(4).fill(70000),
  ...Array(3).fill(80000),
  ...Array(3).fill(90000)
];

const CASINO_NAMES = [
  "1: 골든 너겟 (Golden Nugget)",
  "2: 더 미라지 (The Mirage)",
  "3: 시저스 팰리스 (Caesars)",
  "4: 벨라지오 (Bellagio)",
  "5: 룩소르 (Luxor)",
  "6: 베네시안 (The Venetian)"
];

const COLOR_PRESETS = [
  { color: "#e74c3c", dieClass: "die-red", avatar: "🔴" },
  { color: "#3498db", dieClass: "die-blue", avatar: "🔵" },
  { color: "#2ecc71", dieClass: "die-green", avatar: "🟢" },
  { color: "#f39c12", dieClass: "die-yellow", avatar: "🟡" },
  { color: "#9b59b6", dieClass: "die-purple", avatar: "🟣" }
];

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// In-memory room store: roomCode -> roomData
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function getSanitizedRoom(room) {
  return {
    code: room.code,
    hostSocketId: room.hostSocketId,
    status: room.status,
    players: room.players.map(p => ({
      socketId: p.socketId,
      playerIndex: p.playerIndex,
      name: p.name,
      color: p.color,
      dieClass: p.dieClass,
      avatar: p.avatar,
      isHuman: p.isHuman,
      isConnected: p.isConnected,
      diceLeft: p.diceLeft,
      money: p.money
    })),
    gameState: room.gameState ? {
      round: room.gameState.round,
      totalRounds: room.gameState.totalRounds,
      currentTurnPlayerIndex: room.gameState.currentTurnPlayerIndex,
      casinos: room.gameState.casinos,
      rolledDice: room.gameState.rolledDice,
      selectedDiceNumber: room.gameState.selectedDiceNumber,
      isResolving: room.gameState.isResolving,
      resolvingCasinoIdx: room.gameState.resolvingCasinoIdx,
      logs: room.gameState.logs.slice(-50)
    } : null
  };
}

function startRoundOnServer(room, roundNum) {
  room.gameState.round = roundNum;
  room.gameState.currentTurnPlayerIndex = (roundNum - 1) % room.players.length;
  room.gameState.isResolving = false;
  room.gameState.resolvingCasinoIdx = 0;
  room.gameState.rolledDice = [];
  room.gameState.selectedDiceNumber = null;

  // Reset players dice
  room.players.forEach(p => p.diceLeft = 8);

  // Setup 6 Casinos
  room.gameState.casinos = [];
  for (let c = 1; c <= 6; c++) {
    let bills = [];
    let sum = 0;
    while (sum < 50000) {
      if (room.gameState.deck.length === 0) {
        room.gameState.deck = shuffle(BANKNOTE_DECK_INITIAL);
      }
      let bill = room.gameState.deck.pop();
      bills.push(bill);
      sum += bill;
    }
    bills.sort((a, b) => b - a);

    let dice = {};
    room.players.forEach(p => dice[p.playerIndex] = 0);

    room.gameState.casinos.push({
      number: c,
      name: CASINO_NAMES[c - 1],
      bills: bills,
      dice: dice,
      resolved: false
    });
  }

  addLog(room, `🔔 <b>제 ${roundNum} 라운드</b> 시작! 카지노에 상금이 세팅되었습니다.`);
  checkAndRunAiTurn(room);
}

function addLog(room, msg, type = 'normal') {
  if (!room || !room.gameState) return;
  if (!room.gameState.logs) room.gameState.logs = [];
  room.gameState.logs.push({ msg, type, timestamp: Date.now() });
}

function checkAndRunAiTurn(room) {
  const activePlayer = room.players[room.gameState.currentTurnPlayerIndex];
  if (!activePlayer || activePlayer.isHuman || room.gameState.isResolving || room.status !== 'playing') {
    return;
  }

  // AI Turn simulation
  setTimeout(() => {
    if (room.status !== 'playing' || room.gameState.isResolving) return;
    if (activePlayer.diceLeft <= 0) {
      advanceTurn(room);
      return;
    }

    // AI rolls
    let rolled = [];
    for (let i = 0; i < activePlayer.diceLeft; i++) {
      rolled.push(Math.floor(Math.random() * 6) + 1);
    }
    room.gameState.rolledDice = rolled.sort((a, b) => a - b);
    io.to(room.code).emit('dice_rolled', {
      playerIndex: activePlayer.playerIndex,
      dice: room.gameState.rolledDice,
      isAi: true
    });

    // AI selects best number after thinking
    setTimeout(() => {
      if (room.status !== 'playing') return;
      const counts = {};
      room.gameState.rolledDice.forEach(n => counts[n] = (counts[n] || 0) + 1);

      let bestNum = parseInt(Object.keys(counts)[0]);
      let bestScore = -999999;

      Object.keys(counts).forEach(numStr => {
        const num = parseInt(numStr);
        const count = counts[num];
        const casino = room.gameState.casinos.find(c => c.number === num);
        const topBill = casino.bills[0] || 0;
        const totalCash = casino.bills.reduce((a, b) => a + b, 0);
        const myNewTotal = casino.dice[activePlayer.playerIndex] + count;

        let score = totalCash * 0.4 + topBill * 0.6;
        let competitors = room.players
          .filter(p => p.playerIndex !== activePlayer.playerIndex)
          .map(p => casino.dice[p.playerIndex] || 0);

        competitors.forEach(cCount => {
          if (cCount > 0 && cCount === myNewTotal) {
            if (topBill >= 50000 && count <= 2) score += 35000;
            else score -= 40000;
          }
        });

        const otherMax = Math.max(...competitors, 0);
        if (myNewTotal > otherMax) score += topBill * 0.8;
        score -= count * 4000 + Math.random() * 4000;

        if (score > bestScore) {
          bestScore = score;
          bestNum = num;
        }
      });

      // Place dice
      placeDiceServer(room, activePlayer, bestNum, counts[bestNum]);
    }, 800);
  }, 900);
}

function placeDiceServer(room, player, casinoNum, count) {
  player.diceLeft -= count;
  const casino = room.gameState.casinos.find(c => c.number === casinoNum);
  casino.dice[player.playerIndex] += count;

  addLog(room, `🎲 <b style="color:${player.color}">${player.name}</b>: ${casinoNum}번 카지노에 주사위 <b>${count}개</b> 배치!`);

  room.gameState.rolledDice = [];
  room.gameState.selectedDiceNumber = null;

  // Check if round finishes
  const anyDiceLeft = room.players.some(p => p.diceLeft > 0);
  if (!anyDiceLeft) {
    // All dice placed -> start resolution automatically!
    startResolutionServer(room);
    return;
  }

  advanceTurn(room);
}

function advanceTurn(room) {
  let attempts = 0;
  while (attempts < room.players.length) {
    room.gameState.currentTurnPlayerIndex = (room.gameState.currentTurnPlayerIndex + 1) % room.players.length;
    if (room.players[room.gameState.currentTurnPlayerIndex].diceLeft > 0) {
      break;
    }
    attempts++;
  }

  const nextPlayer = room.players[room.gameState.currentTurnPlayerIndex];
  addLog(room, `👉 <b style="color:${nextPlayer.color}">${nextPlayer.name}</b> 님의 차례입니다.`);

  io.to(room.code).emit('room_state_updated', getSanitizedRoom(room));
  checkAndRunAiTurn(room);
}

// Socket events
io.on('connection', (socket) => {
  // 1. Create room
  socket.on('create_room', ({ nickname }) => {
    const code = generateRoomCode();
    const cleanName = (nickname && nickname.trim()) ? nickname.trim() : '호스트';
    const preset = COLOR_PRESETS[0];

    const hostPlayer = {
      socketId: socket.id,
      playerIndex: 0,
      name: cleanName,
      color: preset.color,
      dieClass: preset.dieClass,
      avatar: preset.avatar,
      isHuman: true,
      isConnected: true,
      diceLeft: 8,
      money: 0
    };

    const room = {
      code,
      hostSocketId: socket.id,
      status: 'lobby',
      players: [hostPlayer],
      gameState: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;

    socket.emit('room_joined', {
      success: true,
      room: getSanitizedRoom(room),
      myPlayerIndex: 0
    });
  });

  // 2. Join room
  socket.on('join_room', ({ roomCode, nickname }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      return socket.emit('join_error', { message: '존재하지 않는 방 코드입니다.' });
    }
    if (room.status !== 'lobby') {
      return socket.emit('join_error', { message: '이미 게임이 진행 중인 방입니다.' });
    }
    if (room.players.length >= 5) {
      return socket.emit('join_error', { message: '방 정원(최대 5명)이 꽉 찼습니다.' });
    }

    const cleanName = (nickname && nickname.trim()) ? nickname.trim() : `플레이어 ${room.players.length + 1}`;
    const nextIdx = room.players.length;
    const preset = COLOR_PRESETS[nextIdx];

    const newPlayer = {
      socketId: socket.id,
      playerIndex: nextIdx,
      name: cleanName,
      color: preset.color,
      dieClass: preset.dieClass,
      avatar: preset.avatar,
      isHuman: true,
      isConnected: true,
      diceLeft: 8,
      money: 0
    };

    room.players.push(newPlayer);
    socket.join(code);
    socket.roomCode = code;

    socket.emit('room_joined', {
      success: true,
      room: getSanitizedRoom(room),
      myPlayerIndex: nextIdx
    });

    io.to(code).emit('player_list_updated', getSanitizedRoom(room));
  });

  // 3. Add AI
  socket.on('add_ai_player', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id || room.status !== 'lobby' || room.players.length >= 5) return;

    const nextIdx = room.players.length;
    const preset = COLOR_PRESETS[nextIdx];
    const aiNames = ["알렉스", "엠마", "데이비드", "루나", "제임스"];

    room.players.push({
      socketId: `ai-${Date.now()}-${nextIdx}`,
      playerIndex: nextIdx,
      name: `${aiNames[nextIdx] || '봇'} (AI)`,
      color: preset.color,
      dieClass: preset.dieClass,
      avatar: "🤖",
      isHuman: false,
      isConnected: true,
      diceLeft: 8,
      money: 0
    });

    io.to(roomCode).emit('player_list_updated', getSanitizedRoom(room));
  });

  // 4. Remove AI / player (host only)
  socket.on('remove_player', ({ roomCode, playerIndex }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id || room.status !== 'lobby') return;
    if (playerIndex <= 0 || playerIndex >= room.players.length) return;

    const removed = room.players.splice(playerIndex, 1)[0];
    // Re-index remaining players
    room.players.forEach((p, idx) => {
      p.playerIndex = idx;
      p.color = COLOR_PRESETS[idx].color;
      p.dieClass = COLOR_PRESETS[idx].dieClass;
      if (p.isHuman && p.avatar !== '👤') p.avatar = COLOR_PRESETS[idx].avatar;
    });

    io.to(roomCode).emit('player_list_updated', getSanitizedRoom(room));
  });

  // 5. Start Game (host only)
  socket.on('start_game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostSocketId !== socket.id || room.status !== 'lobby') return;
    if (room.players.length < 2) {
      return socket.emit('error_message', { message: '최소 2명 이상의 플레이어가 필요합니다.' });
    }

    room.status = 'playing';
    room.gameState = {
      round: 1,
      totalRounds: 4,
      currentTurnPlayerIndex: 0,
      deck: shuffle(BANKNOTE_DECK_INITIAL),
      casinos: [],
      rolledDice: [],
      selectedDiceNumber: null,
      isResolving: false,
      resolvingCasinoIdx: 0,
      logs: []
    };

    startRoundOnServer(room, 1);
    io.to(roomCode).emit('game_started', getSanitizedRoom(room));
  });

  // 6. Roll Dice (active player)
  socket.on('roll_dice', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing' || room.gameState.isResolving) return;

    const activePlayer = room.players[room.gameState.currentTurnPlayerIndex];
    if (!activePlayer || activePlayer.socketId !== socket.id) return;
    if (activePlayer.diceLeft <= 0 || room.gameState.rolledDice.length > 0) return;

    let rolled = [];
    for (let i = 0; i < activePlayer.diceLeft; i++) {
      rolled.push(Math.floor(Math.random() * 6) + 1);
    }
    room.gameState.rolledDice = rolled.sort((a, b) => a - b);
    room.gameState.selectedDiceNumber = null;

    io.to(roomCode).emit('dice_rolled', {
      playerIndex: activePlayer.playerIndex,
      dice: room.gameState.rolledDice,
      isAi: false
    });
  });

  // 7. Select Dice Number
  socket.on('select_dice_number', ({ roomCode, number }) => {
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;

    const activePlayer = room.players[room.gameState.currentTurnPlayerIndex];
    if (!activePlayer || activePlayer.socketId !== socket.id) return;

    room.gameState.selectedDiceNumber = number;
    io.to(roomCode).emit('dice_number_selected', {
      playerIndex: activePlayer.playerIndex,
      number
    });
  });

  // 8. Confirm Place Dice
  socket.on('place_dice', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing' || room.gameState.isResolving) return;

    const activePlayer = room.players[room.gameState.currentTurnPlayerIndex];
    if (!activePlayer || activePlayer.socketId !== socket.id) return;

    const num = room.gameState.selectedDiceNumber;
    if (!num) return;

    const count = room.gameState.rolledDice.filter(n => n === num).length;
    if (count === 0) return;

    placeDiceServer(room, activePlayer, num, count);
  });

  // 9. Proceed Next Casino Resolution (User Skip / Next button)
  socket.on('proceed_next_casino', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing' || !room.gameState || !room.gameState.isResolving) return;

    if (room.resolutionTimer) {
      clearTimeout(room.resolutionTimer);
      room.resolutionTimer = null;
    }
    resolveNextCasinoServer(room);
  });

  // 10. Chat Message
  socket.on('send_chat', ({ roomCode, message }) => {
    const room = rooms.get(roomCode);
    if (!room || !message || !message.trim()) return;

    const sender = room.players.find(p => p.socketId === socket.id);
    if (!sender) return;

    io.to(roomCode).emit('new_chat', {
      senderName: sender.name,
      senderColor: sender.color,
      text: message.trim().substring(0, 100)
    });
  });

  // 11. Disconnect
  socket.on('disconnect', () => {
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
          player.isConnected = false;
          addLog(room, `⚠️ <b>${player.name}</b> 님의 연결이 끊어졌습니다.`);
          io.to(socket.roomCode).emit('room_state_updated', getSanitizedRoom(room));
        }

        // Cleanup empty rooms
        const anyHumansConnected = room.players.some(p => p.isHuman && p.isConnected);
        if (!anyHumansConnected) {
          setTimeout(() => {
            const r = rooms.get(socket.roomCode);
            if (r && !r.players.some(p => p.isHuman && p.isConnected)) {
              rooms.delete(socket.roomCode);
            }
          }, 60000);
        }
      }
    }
  });
});

function startResolutionServer(room) {
  room.gameState.isResolving = true;
  room.gameState.resolvingCasinoIdx = 0;
  addLog(room, `🎰 모든 플레이어의 주사위가 소진되었습니다! <b>카지노 상금 정산</b>을 시작합니다.`, 'win');
  io.to(room.code).emit('room_state_updated', getSanitizedRoom(room));

  // 1초 뒤 첫 번째 카지노(1번) 정산 자동 시작!
  if (room.resolutionTimer) clearTimeout(room.resolutionTimer);
  room.resolutionTimer = setTimeout(() => {
    resolveNextCasinoServer(room);
  }, 1000);
}

function resolveNextCasinoServer(room) {
  if (!room || room.status !== 'playing' || !room.gameState || !room.gameState.isResolving) return;

  if (room.resolutionTimer) {
    clearTimeout(room.resolutionTimer);
    room.resolutionTimer = null;
  }

  const idx = room.gameState.resolvingCasinoIdx;

  if (idx >= 6) {
    // 6개 카지노 모두 정산 완료!
    if (room.gameState.round < room.gameState.totalRounds) {
      addLog(room, `🏁 <b>제 ${room.gameState.round} 라운드 정산 완료!</b> 2초 후 다음 라운드가 시작됩니다.`, 'win');
      io.to(room.code).emit('room_state_updated', getSanitizedRoom(room));

      room.resolutionTimer = setTimeout(() => {
        if (room.status === 'playing') {
          startRoundOnServer(room, room.gameState.round + 1);
          io.to(room.code).emit('room_state_updated', getSanitizedRoom(room));
        }
      }, 2200);
    } else {
      // 4라운드 게임 종료!
      room.status = 'gameover';
      room.gameState.isResolving = false;
      addLog(room, `🏆 <b>모든 라운드가 종료되었습니다! 최종 결과를 발표합니다!</b>`, 'win');
      io.to(room.code).emit('game_over', getSanitizedRoom(room));
    }
    return;
  }

  const casino = room.gameState.casinos[idx];
  if (!casino.resolved) {
    casino.resolved = true;

    let participants = [];
    room.players.forEach(p => {
      const count = casino.dice[p.playerIndex] || 0;
      if (count > 0) {
        participants.push({ player: p, count: count, tied: false });
      }
    });

    let countMap = {};
    participants.forEach(item => {
      countMap[item.count] = (countMap[item.count] || 0) + 1;
    });

    let tiedPlayers = [];
    participants.forEach(item => {
      if (countMap[item.count] > 1) {
        item.tied = true;
        tiedPlayers.push(`${item.player.name} (${item.count}개)`);
      }
    });

    let survivors = participants.filter(item => !item.tied);
    survivors.sort((a, b) => b.count - a.count);

    let payouts = [];
    if (tiedPlayers.length > 0) {
      addLog(room, `⚡ <b>${casino.number}번 카지노 동수 탈락:</b> [${tiedPlayers.join(', ')}] 상쇄 탈락!`, 'tie');
    }

    let billIdx = 0;
    survivors.forEach((item, rk) => {
      if (billIdx < casino.bills.length) {
        const awarded = casino.bills[billIdx];
        item.player.money += awarded;
        payouts.push({ name: item.player.name, amount: awarded, rank: rk + 1 });
        addLog(room, `🎉 <b>${item.player.name}</b> (${item.count}개로 ${rk + 1}등) 👉 $${(awarded/1000)}k 획득!`, 'win');
        billIdx++;
      }
    });

    io.to(room.code).emit('casino_resolution_result', {
      casinoIndex: idx,
      casinoName: casino.name,
      tiedPlayers,
      survivors: survivors.map(s => ({ name: s.player.name, count: s.count })),
      payouts,
      allBills: casino.bills
    });
  }

  room.gameState.resolvingCasinoIdx++;
  io.to(room.code).emit('room_state_updated', getSanitizedRoom(room));

  // 3.2초 뒤 다음 카지노 자동 정산 (유저가 버튼 누르면 즉시 넘어감)
  room.resolutionTimer = setTimeout(() => {
    resolveNextCasinoServer(room);
  }, 3200);
}

// Global process-level error safety guards to prevent Exit 1 crashes
process.on('uncaughtException', (err) => {
  console.error('🔥 Caught uncaughtException:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Caught unhandledRejection:', reason);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎲 Las Vegas Online Server running on 0.0.0.0:${PORT}`);
});
