/**
 * KING OF THE COURT — Retro vertikal multiplayer-tennis
 * Server: Node.js + Express + Socket.io
 *
 * Distributionsmål: Railway.app
 * Servern lyssnar på process.env.PORT (satt automatiskt av Railway).
 *
 * ─────────────────────────────────────────────────────────────────
 * MILJÖVARIABLER (be användaren om dessa istället för att hårdkoda):
 * ─────────────────────────────────────────────────────────────────
 * PORT              -> Sätts automatiskt av Railway. Faller tillbaka på 3000 lokalt.
 * CLIENT_ORIGIN     -> (Valfri) Om frontend och backend körs på olika domäner i
 *                       produktion, be användaren om den fullständiga URL:en till
 *                       frontend-domänen och sätt den här för att låsa CORS.
 *                       Exempel: https://kingofthecourt.up.railway.app
 * DATABASE_URL      -> (Valfri, används INTE i denna version) Om ni senare vill
 *                       spara matchresultat, topplistor eller kontosystem behövs
 *                       en databas (t.ex. PostgreSQL/Redis på Railway). Be då
 *                       användaren om anslutningssträngen och koppla in den här.
 *                       Just nu är allt spelstate helt in-memory och nollställs
 *                       vid omstart av servern.
 * ANALYTICS_API_KEY -> (Valfri) Om ni vill koppla på en analystjänst för att
 *                       mäta spelarengagemang, be användaren om API-nyckeln och
 *                       skicka in den via en egen modul — hårdkoda den aldrig.
 * ─────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────
 * DESIGNBESLUT (uttryckliga antaganden gjorda för att kunna bygga klart
 * utan att behöva stanna upp och fråga om varje detalj):
 * ─────────────────────────────────────────────────────────────────
 * - En "match" består av flera "games" (klassisk tennis-poängräkning:
 *   Love/15/30/40/Deuce/Advantage/Game). Först till 4 games med minst
 *   2 games marginal vinner matchen (en förkortad variant av ett set,
 *   vald för att hinna avgöras inom den 5 minuter långa match-timern).
 * - Om 5-minuterstimern tar slut mitt i en match avgörs vinnaren av:
 *   1) flest vunna games, annars 2) flest poäng i pågående game,
 *   annars 3) slantsingling (extremt osannolikt scenario).
 * - Samma spelare servar hela ett game (växlar varje nytt game), precis
 *   som i riktig tennis.
 * - Om servande spelare inte trycker Space inom 8 sekunder auto-servar
 *   servern åt dem, så en match aldrig kan fastna.
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

// ─────────────────────────────────────────────────────────────────
// SPELKONSTANTER
// ─────────────────────────────────────────────────────────────────
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const PADDLE_WIDTH = 110;
const PADDLE_HEIGHT = 14;
const PADDLE_MARGIN = 24;
const BALL_RADIUS = 8;
const TICK_RATE_MS = 1000 / 30; // 30 uppdateringar/sekund till klienterna
const PADDLE_SPEED = 840; // server-enheter/sekund; samma värde används för klientprediktion

// Matchflöde
const PREGAME_COUNTDOWN_SECONDS = 30;
const MATCH_DURATION_SECONDS = 5 * 60; // 5 minuter
const SET_TARGET_GAMES = 4; // först till 4 games...
const SET_WIN_BY = 2; // ...med minst 2 games marginal
const SERVE_TIMEOUT_MS = 8000; // auto-serve om servande spelare är inaktiv
const POINT_PAUSE_MS = 1400; // paus efter varje poäng innan nästa serve
const GAME_ANNOUNCE_PAUSE_MS = 2600; // längre paus när ett helt game avgjorts
const MATCH_RESULT_DISPLAY_MS = 6000; // hur länge slutresultatet visas

// Slag & fysik
const BASE_BALL_SPEED = 6.2;
const SERVE_SPEED = 7.5;
const SOFT_SPEED_INCREMENT = 0.25;
const HARD_SPEED_INCREMENT = 1.4;
const MAX_BALL_SPEED_SOFT = 13;
const MAX_BALL_SPEED_HARD = 19;
const MAX_BOUNCE_ANGLE_SOFT = Math.PI / 3.6; // ~50°, dämpad vinkel
const SOFT_ANGLE_DAMPING = 0.55;
const MAX_BOUNCE_ANGLE_HARD = Math.PI / 2.6; // ~69°, vassare vinkel

// Slagtajmning
const SWING_COOLDOWN_MS = 220; // spärr mot spam-tryck på Space
const SWING_TIMING_WINDOW_MS = 300; // generöst input-bufferfönster före bollkontakt
const PERFECT_SWING_WINDOW_MS = 125; // tajt fönster närmast kontakt ger ett hårt slag
const LATE_HIT_DISTANCE = 24; // tillåter en kort reaktion precis efter att bollen passerat paddellinjen

// De fyra banorna. Nyckeln används som Socket.io-rumsnamn.
const COURTS = {
  melbourne: { name: 'Melbourne', accent: '#65d7ff' },
  paris: { name: 'Paris', accent: '#ffe06b' },
  london: { name: 'London', accent: '#f7f4e8' },
  newyork: { name: 'New York', accent: '#ffcf56' },
};

// ─────────────────────────────────────────────────────────────────
// STATE (helt in-memory — se kommentar om DATABASE_URL ovan)
// ─────────────────────────────────────────────────────────────────

/** socket.id -> { username, court, role } */
const players = new Map();

/**
 * Enkel in-memory topplista: användarnamn -> { wins, matchesPlayed }.
 * Precis som allt annat state nollställs den vid omstart av servern —
 * se kommentaren om DATABASE_URL högst upp om ni vill göra den persistent.
 * OBS: nycklas på användarnamn (inte konto), så två spelare som råkar
 * välja exakt samma namn delar samma rad — en medveten förenkling.
 */
const leaderboard = new Map();
const LEADERBOARD_LIMIT = 15;

function recordMatchResult(winnerUsername, loserUsername) {
  if (winnerUsername) {
    const entry = leaderboard.get(winnerUsername) || { wins: 0, matchesPlayed: 0 };
    entry.wins += 1;
    entry.matchesPlayed += 1;
    leaderboard.set(winnerUsername, entry);
  }
  if (loserUsername) {
    const entry = leaderboard.get(loserUsername) || { wins: 0, matchesPlayed: 0 };
    entry.matchesPlayed += 1;
    leaderboard.set(loserUsername, entry);
  }
}

function getLeaderboardSnapshot() {
  return Array.from(leaderboard.entries())
    .map(([username, stats]) => ({ username, wins: stats.wins, matchesPlayed: stats.matchesPlayed }))
    .sort((a, b) => b.wins - a.wins || a.matchesPlayed - b.matchesPlayed)
    .slice(0, LEADERBOARD_LIMIT);
}

function broadcastLeaderboard() {
  io.emit('leaderboardData', getLeaderboardSnapshot());
}

// ─────────────────────────────────────────────────────────────────
// BANREKORD — "Flest vinster i rad som King" och "Flest minuter som King",
// PER BANA. Sparas till en lokal JSON-fil så de överlever omstarter.
//
// OBS om Railway: en enkel omstart/krasch av samma deploy behåller filen
// (containerns filsystem lever kvar tills nästa omstart), men en helt NY
// deploy på Railway ger en fräsch container och därmed en tom fil igen —
// om ni vill att rekorden ska överleva även nya deployer behöver ni koppla
// in en Railway Volume monterad på DATA_DIR nedan (eller, som tidigare
// kommentar nämner, en riktig databas via DATABASE_URL).
// ─────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'court-records.json');

function createEmptyCourtRecords() {
  return {
    longestKingStreak: { wins: 0, username: null, achievedAt: null },
    mostKingMinutes: { minutes: 0, username: null, achievedAt: null },
    // Ackumulerad tid som King per användarnamn — behövs för att kunna avgöra
    // "flest minuter som King" över flera separata regeringsperioder.
    cumulativeKingMinutes: {},
  };
}

const courtRecords = {};
for (const courtKey of Object.keys(COURTS)) {
  courtRecords[courtKey] = createEmptyCourtRecords();
}

function loadRecordsFromDisk() {
  try {
    if (!fs.existsSync(RECORDS_FILE)) return;
    const raw = fs.readFileSync(RECORDS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const courtKey of Object.keys(COURTS)) {
      const saved = parsed[courtKey];
      if (!saved) continue;
      courtRecords[courtKey] = {
        longestKingStreak: saved.longestKingStreak || createEmptyCourtRecords().longestKingStreak,
        mostKingMinutes: saved.mostKingMinutes || createEmptyCourtRecords().mostKingMinutes,
        cumulativeKingMinutes: saved.cumulativeKingMinutes || {},
      };
    }
    console.log(`Banrekord inlästa från ${RECORDS_FILE}`);
  } catch (err) {
    console.error('Kunde inte läsa banrekord, startar med tomma rekord:', err.message);
  }
}

let persistTimer = null;
function persistRecords() {
  // Enkel debounce (500ms) så vi inte skriver till disk flera gånger per sekund
  // om flera rekord slås tätt inpå varandra.
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(RECORDS_FILE, JSON.stringify(courtRecords, null, 2), 'utf8');
    } catch (err) {
      console.error('Kunde inte spara banrekord till disk:', err.message);
    }
  }, 500);
}

function getPublicRecords(courtKey) {
  const r = courtRecords[courtKey];
  return {
    longestKingStreak: { ...r.longestKingStreak },
    mostKingMinutes: {
      minutes: Math.round(r.mostKingMinutes.minutes * 10) / 10,
      username: r.mostKingMinutes.username,
      achievedAt: r.mostKingMinutes.achievedAt,
    },
  };
}

function getAllPublicRecords() {
  const out = {};
  for (const courtKey of Object.keys(COURTS)) out[courtKey] = getPublicRecords(courtKey);
  return out;
}

function broadcastRecordsUpdate(courtKey, meta) {
  io.emit('recordsUpdate', { court: courtKey, records: getPublicRecords(courtKey), meta });
}

/** Kallas när en spelare BLIR King — nollställer regeringsperiodens räknare. */
function startKingReign(kingPlayerObj) {
  kingPlayerObj.reignStartedAt = Date.now();
  kingPlayerObj.winStreak = 0;
}

/** Kallas varje gång den regerande Kungen vinner en match (försvarar tronen). */
function registerKingWin(courtKey, kingPlayerObj) {
  kingPlayerObj.winStreak = (kingPlayerObj.winStreak || 0) + 1;
  const records = courtRecords[courtKey];
  if (kingPlayerObj.winStreak > records.longestKingStreak.wins) {
    records.longestKingStreak = {
      wins: kingPlayerObj.winStreak,
      username: kingPlayerObj.username,
      achievedAt: Date.now(),
    };
    persistRecords();
    broadcastRecordsUpdate(courtKey, {
      event: 'new-streak-record',
      username: kingPlayerObj.username,
      streak: kingPlayerObj.winStreak,
    });
  }
}

/**
 * Kallas när en Kungs regeringsperiod tar slut — oavsett om det beror på en
 * matchförlust eller att spelaren kopplade ner. Lägger till den intjänade
 * tiden på spelarens totalsumma för banan och sänder alltid en live-
 * uppdatering (kronbyte är i sig en händelse värd att visa upp).
 */
function endKingReign(courtKey, kingPlayerObj) {
  if (!kingPlayerObj || !kingPlayerObj.reignStartedAt) return;
  const minutes = (Date.now() - kingPlayerObj.reignStartedAt) / 60000;
  const records = courtRecords[courtKey];
  const username = kingPlayerObj.username;
  const newTotal = (records.cumulativeKingMinutes[username] || 0) + minutes;
  records.cumulativeKingMinutes[username] = newTotal;

  let newTimeRecord = false;
  if (newTotal > records.mostKingMinutes.minutes) {
    records.mostKingMinutes = { minutes: newTotal, username, achievedAt: Date.now() };
    newTimeRecord = true;
  }

  persistRecords();
  broadcastRecordsUpdate(courtKey, {
    event: 'reign-ended',
    username,
    finalStreak: kingPlayerObj.winStreak || 0,
    reignMinutes: Math.round(minutes * 10) / 10,
    newTimeRecord,
  });
}


// Läs in tidigare sparade banrekord direkt vid uppstart
loadRecordsFromDisk();

function createEmptyBall() {
  return { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2, vx: 0, vy: 0, speed: BASE_BALL_SPEED };
}

function createEmptyPlayer(id, username) {
  return {
    id,
    username,
    x: CANVAS_WIDTH / 2,
    points: 0,
    games: 0,
    lastSwingAt: 0,
    moveDirection: 0,
    lastPaddleMoveSequence: 0,
  };
}

/** court-key -> rumstate */
const rooms = {};
for (const courtKey of Object.keys(COURTS)) {
  rooms[courtKey] = {
    queue: [], // [{ id, username }] — väntande spelare = åskådare
    king: null,
    challenger: null,
    ball: createEmptyBall(),
    phase: 'waiting', // 'waiting' | 'pregame' | 'playing' | 'finished'
    rally: null, // 'awaiting-serve' | 'live' | 'point-pause' | 'finished'
    server: null, // 'king' | 'challenger' — vem som servar innevarande game
    pregameCountdown: 0,
    matchSecondsRemaining: 0,
    serveDeadline: 0,
    timer: null, // kortlivad timer (pregame-nedräkning / paus mellan poäng)
    matchTimer: null, // 1Hz-nedräkning för de 5 matchminuterna
  };
}

// ─────────────────────────────────────────────────────────────────
// HJÄLPFUNKTIONER — allmänt
// ─────────────────────────────────────────────────────────────────

function sanitizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 16);
  if (trimmed.length < 2) return null;
  if (!/^[\p{L}\p{N} _-]+$/u.test(trimmed)) return null;
  return trimmed;
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function clearMatchTimer(room) {
  if (room.matchTimer) {
    clearInterval(room.matchTimer);
    room.matchTimer = null;
  }
}

function otherRole(role) {
  return role === 'king' ? 'challenger' : 'king';
}

function centerBallStatic(room) {
  room.ball.x = CANVAS_WIDTH / 2;
  room.ball.y = CANVAS_HEIGHT / 2;
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.ball.speed = BASE_BALL_SPEED;
}

/** Formaterar råa poäng enligt riktiga tennisregler: Love/15/30/40/Deuce/Advantage */
function pointLabel(mine, theirs) {
  if (mine >= 3 && theirs >= 3) {
    if (mine === theirs) return 'Deuce';
    return mine > theirs ? 'Advantage' : '40';
  }
  const table = ['Love', '15', '30', '40'];
  return table[Math.min(mine, 3)];
}

// ─────────────────────────────────────────────────────────────────
// LOBBY / STATE-BROADCAST
// ─────────────────────────────────────────────────────────────────

function getPublicState(courtKey) {
  const room = rooms[courtKey];
  return {
    court: courtKey,
    courtName: COURTS[courtKey].name,
    accent: COURTS[courtKey].accent,
    phase: room.phase,
    rally: room.rally,
    server: room.server,
    pregameCountdown: room.pregameCountdown,
    matchSecondsRemaining: room.matchSecondsRemaining,
    king: room.king
      ? {
          username: room.king.username,
          x: room.king.x,
          moveSequence: room.king.lastPaddleMoveSequence,
          points: pointLabel(room.king.points, room.challenger ? room.challenger.points : 0),
          games: room.king.games,
          winStreak: room.king.winStreak || 0,
          reignSeconds: room.king.reignStartedAt ? Math.floor((Date.now() - room.king.reignStartedAt) / 1000) : 0,
        }
      : null,
    challenger: room.challenger
      ? {
          username: room.challenger.username,
          x: room.challenger.x,
          moveSequence: room.challenger.lastPaddleMoveSequence,
          points: pointLabel(room.challenger.points, room.king ? room.king.points : 0),
          games: room.challenger.games,
        }
      : null,
    ball: { x: room.ball.x, y: room.ball.y, vx: room.ball.vx, vy: room.ball.vy },
    queue: room.queue.map((p) => p.username),
    spectatorCount: room.queue.length,
  };
}

function broadcastState(courtKey) {
  io.to(courtKey).emit('state', getPublicState(courtKey));
}

function getLobbySnapshot() {
  const snapshot = {};
  for (const courtKey of Object.keys(COURTS)) {
    const room = rooms[courtKey];
    snapshot[courtKey] = {
      name: COURTS[courtKey].name,
      accent: COURTS[courtKey].accent,
      kingName: room.king ? room.king.username : null,
      challengerName: room.challenger ? room.challenger.username : null,
      queueLength: room.queue.length,
      phase: room.phase,
    };
  }
  return snapshot;
}

function broadcastLobby() {
  io.emit('lobbyUpdate', getLobbySnapshot());
}

function notifyRole(socketId, role, courtKey, extra = {}) {
  const record = players.get(socketId);
  if (record) record.role = role;
  io.to(socketId).emit('role', {
    role,
    court: courtKey,
    courtName: COURTS[courtKey].name,
    accent: COURTS[courtKey].accent,
    ...extra,
  });
}

function broadcastQueuePositions(courtKey) {
  const room = rooms[courtKey];
  room.queue.forEach((p, index) => {
    notifyRole(p.id, 'spectator', courtKey, { position: index + 1, queueLength: room.queue.length });
  });
}

// ─────────────────────────────────────────────────────────────────
// KÖ / ROLLER
// ─────────────────────────────────────────────────────────────────

function fillRoles(courtKey) {
  const room = rooms[courtKey];
  let changed = false;

  if (!room.king && room.queue.length > 0) {
    const next = room.queue.shift();
    room.king = createEmptyPlayer(next.id, next.username);
    startKingReign(room.king);
    notifyRole(next.id, 'king', courtKey);
    changed = true;
  }

  if (room.king && !room.challenger && room.queue.length > 0) {
    const next = room.queue.shift();
    room.challenger = createEmptyPlayer(next.id, next.username);
    notifyRole(next.id, 'challenger', courtKey);
    changed = true;
    startPregame(courtKey);
  }

  if (!room.king && !room.challenger) {
    room.phase = 'waiting';
    room.rally = null;
    clearRoomTimer(room);
    clearMatchTimer(room);
  }

  broadcastQueuePositions(courtKey);
  if (changed) broadcastLobby();
}

function removePlayer(socketId) {
  const record = players.get(socketId);
  if (!record) return;
  players.delete(socketId);

  const room = rooms[record.court];
  if (!room) return;

  room.queue = room.queue.filter((p) => p.id !== socketId);

  let matchDisrupted = false;
  let departingKing = null;
  if (room.king && room.king.id === socketId) {
    departingKing = room.king;
    room.king = null;
    matchDisrupted = true;
  }
  if (room.challenger && room.challenger.id === socketId) {
    room.challenger = null;
    matchDisrupted = true;
  }

  if (matchDisrupted) {
    clearRoomTimer(room);
    clearMatchTimer(room);
    room.phase = 'waiting';
    room.rally = null;

    if (departingKing) endKingReign(record.court, departingKing);

    if (!room.king && room.challenger) {
      // Utmanaren tar automatiskt över tronen om Kungen lämnar
      room.king = createEmptyPlayer(room.challenger.id, room.challenger.username);
      startKingReign(room.king);
      notifyRole(room.king.id, 'king', record.court);
      room.challenger = null;
    } else if (room.king) {
      room.king.points = 0;
      room.king.games = 0;
    }
  }

  fillRoles(record.court);
  broadcastState(record.court);
  broadcastLobby();
}

// ─────────────────────────────────────────────────────────────────
// MATCHFLÖDE — pregame (30s lås + coin toss) → playing → finished
// ─────────────────────────────────────────────────────────────────

function startPregame(courtKey) {
  const room = rooms[courtKey];
  clearRoomTimer(room);
  clearMatchTimer(room);

  room.phase = 'pregame';
  room.rally = null;
  room.pregameCountdown = PREGAME_COUNTDOWN_SECONDS;
  room.matchSecondsRemaining = MATCH_DURATION_SECONDS;
  room.king.points = 0;
  room.king.games = 0;
  room.challenger.points = 0;
  room.challenger.games = 0;
  centerBallStatic(room);

  // Slantsingling: avgör vem som servar första gamet
  const isHeads = Math.random() < 0.5;
  room.server = isHeads ? 'king' : 'challenger';

  io.to(courtKey).emit('match-start-event', {
    court: courtKey,
    courtName: COURTS[courtKey].name,
    accent: COURTS[courtKey].accent,
    king: room.king.username,
    challenger: room.challenger.username,
    server: room.server,
    coinToss: {
      result: isHeads ? 'heads' : 'tails',
      servingRole: room.server,
      servingUsername: room[room.server].username,
    },
    countdownSeconds: PREGAME_COUNTDOWN_SECONDS,
  });

  broadcastState(courtKey);

  room.timer = setInterval(() => {
    room.pregameCountdown -= 1;
    if (room.pregameCountdown <= 0) {
      clearRoomTimer(room);
      beginMatch(courtKey);
      return;
    }
    broadcastState(courtKey);
  }, 1000);
}

function beginMatch(courtKey) {
  const room = rooms[courtKey];
  room.phase = 'playing';
  room.king.moveDirection = 0;
  room.challenger.moveDirection = 0;
  positionBallForServe(room);
  broadcastState(courtKey);

  room.matchTimer = setInterval(() => {
    room.matchSecondsRemaining -= 1;
    if (room.matchSecondsRemaining <= 0) {
      room.matchSecondsRemaining = 0;
      clearMatchTimer(room);
      finishMatchByTime(courtKey);
    }
  }, 1000);
}

function positionBallForServe(room) {
  const serverIsKing = room.server === 'king';
  const serverPlayer = serverIsKing ? room.king : room.challenger;
  room.ball.x = serverPlayer.x;
  room.ball.y = serverIsKing
    ? CANVAS_HEIGHT - PADDLE_MARGIN - PADDLE_HEIGHT / 2 - BALL_RADIUS - 6
    : PADDLE_MARGIN + PADDLE_HEIGHT / 2 + BALL_RADIUS + 6;
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.ball.speed = BASE_BALL_SPEED;
  room.rally = 'awaiting-serve';
  room.serveDeadline = Date.now() + SERVE_TIMEOUT_MS;
  room.king.lastSwingAt = 0;
  room.challenger.lastSwingAt = 0;
}

function launchServe(courtKey, room) {
  const serverIsKing = room.server === 'king';
  const direction = serverIsKing ? -1 : 1; // bollen ska mot motståndaren
  room.ball.speed = SERVE_SPEED;
  room.ball.vy = direction * SERVE_SPEED;
  room.ball.vx = (Math.random() * 2 - 1) * SERVE_SPEED * 0.25;
  room.rally = 'live';
  broadcastState(courtKey);
}

// ─────────────────────────────────────────────────────────────────
// POÄNGRÄKNING — riktiga tennisregler
// ─────────────────────────────────────────────────────────────────

function registerPoint(courtKey, scorerRole) {
  const room = rooms[courtKey];
  if (room.rally !== 'live') return; // säkerhetsspärr mot dubbelregistrering
  room.rally = 'point-pause';
  room.ball.vx = 0;
  room.ball.vy = 0;

  room[scorerRole].points += 1;

  const other = otherRole(scorerRole);
  let gameWon = false;
  let matchEnded = false;

  if (room[scorerRole].points >= 4 && room[scorerRole].points - room[other].points >= 2) {
    gameWon = true;
    room[scorerRole].games += 1;
    room.king.points = 0;
    room.challenger.points = 0;
    room.server = otherRole(room.server); // servern växlar varje nytt game

    io.to(courtKey).emit('gameWon', {
      court: courtKey,
      winner: scorerRole,
      winnerUsername: room[scorerRole].username,
      games: { king: room.king.games, challenger: room.challenger.games },
      nextServer: room.server,
    });

    if (
      room[scorerRole].games >= SET_TARGET_GAMES &&
      room[scorerRole].games - room[other].games >= SET_WIN_BY
    ) {
      matchEnded = true;
      endMatch(courtKey, scorerRole, 'score');
    }
  } else {
    io.to(courtKey).emit('pointWon', {
      court: courtKey,
      winner: scorerRole,
      score: {
        king: pointLabel(room.king.points, room.challenger.points),
        challenger: pointLabel(room.challenger.points, room.king.points),
      },
    });
  }

  broadcastState(courtKey);
  if (matchEnded) return;

  const pauseMs = gameWon ? GAME_ANNOUNCE_PAUSE_MS : POINT_PAUSE_MS;
  clearRoomTimer(room);
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.phase === 'playing') {
      positionBallForServe(room);
      broadcastState(courtKey);
    }
  }, pauseMs);
}

function finishMatchByTime(courtKey) {
  const room = rooms[courtKey];
  let winnerRole;
  if (room.king.games !== room.challenger.games) {
    winnerRole = room.king.games > room.challenger.games ? 'king' : 'challenger';
  } else if (room.king.points !== room.challenger.points) {
    winnerRole = room.king.points > room.challenger.points ? 'king' : 'challenger';
  } else {
    winnerRole = Math.random() < 0.5 ? 'king' : 'challenger';
  }
  endMatch(courtKey, winnerRole, 'time');
}

function endMatch(courtKey, winnerRole, reason) {
  const room = rooms[courtKey];
  clearRoomTimer(room);
  clearMatchTimer(room);
  room.phase = 'finished';
  room.rally = 'finished';
  room.king.moveDirection = 0;
  if (room.challenger) room.challenger.moveDirection = 0;
  room.ball.vx = 0;
  room.ball.vy = 0;

  const loserRole = otherRole(winnerRole);
  const winnerUsername = room[winnerRole].username;
  const loserUsername = room[loserRole] ? room[loserRole].username : null;

  io.to(courtKey).emit('matchEnd', {
    court: courtKey,
    reason, // 'score' | 'time'
    winner: winnerRole,
    winnerUsername,
    loserUsername,
    finalGames: { king: room.king.games, challenger: room.challenger.games },
  });

  recordMatchResult(winnerUsername, loserUsername);
  broadcastLeaderboard();

  // Vinnaren står kvar som/blir Kung. Förloraren hamnar sist i kön.
  if (winnerRole === 'challenger') {
    const oldKing = room.king;
    endKingReign(courtKey, oldKing); // Kungens regeringsperiod tar slut här — han/hon förlorade
    room.king = createEmptyPlayer(room.challenger.id, room.challenger.username);
    startKingReign(room.king); // ny regeringsperiod börjar för den nya Kungen
    notifyRole(room.king.id, 'king', courtKey);
    room.challenger = null;
    if (oldKing) {
      room.queue.push({ id: oldKing.id, username: oldKing.username });
      notifyRole(oldKing.id, 'spectator', courtKey, { position: room.queue.length, queueLength: room.queue.length });
    }
  } else {
    registerKingWin(courtKey, room.king); // Kungen försvarade tronen — räkna upp segersviten
    const loser = room.challenger;
    room.challenger = null;
    if (loser) {
      room.queue.push({ id: loser.id, username: loser.username });
      notifyRole(loser.id, 'spectator', courtKey, { position: room.queue.length, queueLength: room.queue.length });
    }
    room.king.points = 0;
    room.king.games = 0;
  }

  broadcastState(courtKey);
  broadcastLobby();

  room.timer = setTimeout(() => {
    room.timer = null;
    room.phase = 'waiting';
    room.rally = null;
    fillRoles(courtKey); // drar in nästa utmanare ur kön om någon väntar
    broadcastState(courtKey);
  }, MATCH_RESULT_DISPLAY_MS);
}

// ─────────────────────────────────────────────────────────────────
// BOLLFYSIK
// ─────────────────────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function softBounce(room, paddle, direction) {
  const relativeX = clamp((room.ball.x - paddle.x) / (PADDLE_WIDTH / 2), -1, 1) * SOFT_ANGLE_DAMPING;
  const angle = relativeX * MAX_BOUNCE_ANGLE_SOFT;
  room.ball.speed = Math.min(room.ball.speed + SOFT_SPEED_INCREMENT, MAX_BALL_SPEED_SOFT);
  room.ball.vx = room.ball.speed * Math.sin(angle);
  room.ball.vy = direction * room.ball.speed * Math.cos(angle);
}

function hardBounce(room, paddle, direction) {
  const relativeX = clamp((room.ball.x - paddle.x) / (PADDLE_WIDTH / 2), -1, 1);
  const angle = relativeX * MAX_BOUNCE_ANGLE_HARD;
  room.ball.speed = Math.min(room.ball.speed + HARD_SPEED_INCREMENT, MAX_BALL_SPEED_HARD);
  room.ball.vx = room.ball.speed * Math.sin(angle);
  room.ball.vy = direction * room.ball.speed * Math.cos(angle);
}

function updateBall(courtKey, room) {
  room.ball.x += room.ball.vx;
  room.ball.y += room.ball.vy;

  if (room.ball.x - BALL_RADIUS <= 0) {
    room.ball.x = BALL_RADIUS;
    room.ball.vx = Math.abs(room.ball.vx);
  } else if (room.ball.x + BALL_RADIUS >= CANVAS_WIDTH) {
    room.ball.x = CANVAS_WIDTH - BALL_RADIUS;
    room.ball.vx = -Math.abs(room.ball.vx);
  }

  const challengerLineY = PADDLE_MARGIN;
  const kingLineY = CANVAS_HEIGHT - PADDLE_MARGIN;
  const now = Date.now();

  if (
    room.challenger &&
    room.ball.vy < 0 &&
    room.ball.y - BALL_RADIUS <= challengerLineY + PADDLE_HEIGHT / 2 &&
    room.ball.y + BALL_RADIUS >= challengerLineY - PADDLE_HEIGHT / 2 - LATE_HIT_DISTANCE
  ) {
    const swingAge = now - (room.challenger.lastSwingAt || 0);
    const swingBuffered = swingAge >= 0 && swingAge <= SWING_TIMING_WINDOW_MS;
    if (swingBuffered && Math.abs(room.ball.x - room.challenger.x) <= PADDLE_WIDTH / 2 + BALL_RADIUS) {
      room.ball.y = challengerLineY + PADDLE_HEIGHT / 2 + BALL_RADIUS;
      const perfect = swingAge <= PERFECT_SWING_WINDOW_MS;
      if (perfect) {
        hardBounce(room, room.challenger, 1);
      } else {
        softBounce(room, room.challenger, 1);
      }
      room.challenger.lastSwingAt = 0;
      io.to(courtKey).emit('hitFeedback', { role: 'challenger', type: perfect ? 'hard' : 'soft' });
    }
  }

  if (
    room.king &&
    room.ball.vy > 0 &&
    room.ball.y + BALL_RADIUS >= kingLineY - PADDLE_HEIGHT / 2 &&
    room.ball.y - BALL_RADIUS <= kingLineY + PADDLE_HEIGHT / 2 + LATE_HIT_DISTANCE
  ) {
    const swingAge = now - (room.king.lastSwingAt || 0);
    const swingBuffered = swingAge >= 0 && swingAge <= SWING_TIMING_WINDOW_MS;
    if (swingBuffered && Math.abs(room.ball.x - room.king.x) <= PADDLE_WIDTH / 2 + BALL_RADIUS) {
      room.ball.y = kingLineY - PADDLE_HEIGHT / 2 - BALL_RADIUS;
      const perfect = swingAge <= PERFECT_SWING_WINDOW_MS;
      if (perfect) {
        hardBounce(room, room.king, -1);
      } else {
        softBounce(room, room.king, -1);
      }
      room.king.lastSwingAt = 0;
      io.to(courtKey).emit('hitFeedback', { role: 'king', type: perfect ? 'hard' : 'soft' });
    }
  }

  if (room.ball.y - BALL_RADIUS > CANVAS_HEIGHT) {
    registerPoint(courtKey, 'challenger'); // Kungen missade längst ner
  } else if (room.ball.y + BALL_RADIUS < 0) {
    registerPoint(courtKey, 'king'); // Utmanaren missade längst upp
  }
}

// ─────────────────────────────────────────────────────────────────
// EXPRESS — statiska filer (frontend i /public)
// ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ─────────────────────────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('lobbyUpdate', getLobbySnapshot());
  socket.emit('leaderboardData', getLeaderboardSnapshot());
  socket.emit('recordsData', getAllPublicRecords());

  socket.on('joinQueue', (payload) => {
    const { username, court } = payload || {};

    if (!COURTS[court]) {
      socket.emit('errorMsg', 'Invalid court selection.');
      return;
    }

    const cleanUsername = sanitizeUsername(username);
    if (!cleanUsername) {
      socket.emit('errorMsg', 'Enter a player name between 2 and 16 characters.');
      return;
    }

    if (players.has(socket.id)) {
      removePlayer(socket.id);
    }

    socket.join(court);
    players.set(socket.id, { username: cleanUsername, court, role: 'spectator' });
    rooms[court].queue.push({ id: socket.id, username: cleanUsername });

    fillRoles(court);
    broadcastState(court);
    broadcastLobby();
  });

  // Piltangenter — klienten skickar bara riktning. Serverns tick flyttar paddeln.
  socket.on('paddleInput', (payload) => {
    const record = players.get(socket.id);
    if (!record) return;
    const room = rooms[record.court];
    if (!room || room.phase !== 'playing') return;

    const direction = Number(payload && payload.direction);
    const sequence = Number(payload && payload.sequence);
    if (![ -1, 0, 1 ].includes(direction)) return;

    let playerObj = null;
    if (room.king && room.king.id === socket.id) playerObj = room.king;
    if (room.challenger && room.challenger.id === socket.id) playerObj = room.challenger;
    if (!playerObj) return;

    if (!Number.isSafeInteger(sequence) || sequence <= playerObj.lastPaddleMoveSequence) return;
    playerObj.moveDirection = direction;
    playerObj.lastPaddleMoveSequence = sequence;
  });

  // Mellanslag — servar bollen (om spelaren är servande part och bollen väntar)
  // eller registreras som ett tajmat slag om bollen är i spel.
  socket.on('swing', () => {
    const record = players.get(socket.id);
    if (!record) return;
    const room = rooms[record.court];
    if (!room || room.phase !== 'playing') return;

    const isKing = room.king && room.king.id === socket.id;
    const isChallenger = room.challenger && room.challenger.id === socket.id;
    if (!isKing && !isChallenger) return;

    const role = isKing ? 'king' : 'challenger';
    const playerObj = room[role];
    const now = Date.now();
    if (now - (playerObj.lastSwingAt || 0) < SWING_COOLDOWN_MS) return;
    playerObj.lastSwingAt = now;

    if (room.rally === 'awaiting-serve' && room.server === role) {
      launchServe(record.court, room);
    }
  });

  socket.on('leaveQueue', () => {
    removePlayer(socket.id);
  });

  // Åskådare/kö-spelare kan öppna topplistan utan att lämna rummet
  socket.on('requestLeaderboard', () => {
    socket.emit('leaderboardData', getLeaderboardSnapshot());
  });

  // Åskådare/kö-spelare kan öppna banrekorden utan att lämna rummet
  socket.on('requestRecords', () => {
    socket.emit('recordsData', getAllPublicRecords());
  });

  socket.on('disconnect', () => {
    removePlayer(socket.id);
  });
});

// ─────────────────────────────────────────────────────────────────
// SPELLOOP — fysik + broadcast till alla rum med aktiva anslutningar
// ─────────────────────────────────────────────────────────────────
let previousGameTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const deltaSeconds = clamp((now - previousGameTickAt) / 1000, 0, 0.05);
  previousGameTickAt = now;

  for (const courtKey of Object.keys(rooms)) {
    const room = rooms[courtKey];
    if (room.phase !== 'playing') continue;

    for (const playerObj of [room.king, room.challenger]) {
      if (!playerObj || !playerObj.moveDirection) continue;
      playerObj.x = clamp(
        playerObj.x + playerObj.moveDirection * PADDLE_SPEED * deltaSeconds,
        PADDLE_WIDTH / 2,
        CANVAS_WIDTH - PADDLE_WIDTH / 2
      );
    }

    if (room.rally === 'awaiting-serve') {
      // Bollen "svävar" ovanför den servande spelarens paddel tills serven slås
      const serverPlayer = room.server === 'king' ? room.king : room.challenger;
      if (serverPlayer) room.ball.x = serverPlayer.x;

      if (now >= room.serveDeadline) {
        launchServe(courtKey, room);
      }
    } else if (room.rally === 'live') {
      updateBall(courtKey, room);
    }
  }

  for (const courtKey of Object.keys(rooms)) {
    const roomSockets = io.sockets.adapter.rooms.get(courtKey);
    if (roomSockets && roomSockets.size > 0) {
      broadcastState(courtKey);
    }
  }
}, TICK_RATE_MS);

// ─────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`King of the Court-servern körs på port ${PORT}`);
});
