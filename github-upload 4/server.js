// Neoblox live server
// - Serves the static game client (./public)
// - Realtime presence/multiplayer, party system, chat, and WebRTC voice signaling over WebSocket at /ws
// - Persists published NeoStudio worlds to disk (./data/worlds.json) via a small REST API,
//   so "Publish to Neoblox" works the same way it does on claude.ai, just backed by this server.
//
// Run: npm install && npm start
// Env: PORT (default 8080)

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const accounts = require('./accounts');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const WORLDS_FILE = path.join(DATA_DIR, 'worlds.json');

// Real, server-enforced admin auth — a client can never just claim to be admin, it has to
// prove it with this password. Override it on your host (Railway → Variables → ADMIN_PASSWORD)
// instead of leaving the default in place once friends know it exists.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ThunderKing2026';

const app = express();

// Basic CORS (harmless if client is same-origin; needed if you ever split hosting)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.json({ limit: '3mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// ---- published worlds (persisted to a JSON file — good enough for a hobby-scale game;
// swap for a real database later if Neoblox takes off) ----
function loadWorlds(){
  try{ return JSON.parse(fs.readFileSync(WORLDS_FILE, 'utf8')); }catch(e){ return []; }
}
function saveWorlds(list){
  try{
    fs.mkdirSync(DATA_DIR, { recursive:true });
    fs.writeFileSync(WORLDS_FILE, JSON.stringify(list));
  }catch(e){ console.error('failed to save worlds.json', e); }
}
let worlds = loadWorlds();
let nextWorldId = worlds.reduce((m, w) => Math.max(m, parseInt(w.id, 10) || 0), 0) + 1;

app.get('/api/worlds', (req, res) => {
  let list = worlds;
  if(req.query.authorId) list = list.filter(w => w.authorId === req.query.authorId);
  const order = req.query.order || 'createdAt';
  list = list.slice().sort((a, b) => (b[order] || 0) - (a[order] || 0));
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json(list.slice(0, limit));
});

app.post('/api/worlds', (req, res) => {
  const id = String(nextWorldId++);
  const world = Object.assign({}, req.body, { id, createdAt: Date.now(), updatedAt: Date.now() });
  worlds.push(world);
  saveWorlds(worlds);
  res.json({ id });
});

app.put('/api/worlds/:id', (req, res) => {
  const idx = worlds.findIndex(w => w.id === req.params.id);
  if(idx < 0) return res.status(404).json({ error:'not found' });
  worlds[idx] = Object.assign({}, worlds[idx], req.body, { updatedAt: Date.now() });
  saveWorlds(worlds);
  res.json({ ok:true });
});

// ---- accounts, tokens, quests, avatar uploads (see accounts.js) ----
function requireAuth(req, res, next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = token && accounts.userForToken(token);
  if(!user) return res.status(401).json({ error:'Not logged in.' });
  req.authedUser = user;
  next();
}

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  const result = accounts.register(username, password);
  if(result.error) return res.status(400).json({ error: result.error });
  accounts.noteLogin(result.user);
  const token = accounts.createSession(result.user.id);
  res.json({ token, user: accounts.publicUser(result.user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = accounts.login(username, password);
  if(result.error) return res.status(400).json({ error: result.error });
  accounts.noteLogin(result.user);
  const token = accounts.createSession(result.user.id);
  res.json({ token, user: accounts.publicUser(result.user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: accounts.publicUser(req.authedUser) });
});

app.post('/api/quests/:id/claim', requireAuth, (req, res) => {
  const result = accounts.claimQuest(req.authedUser, req.params.id);
  if(result.error) return res.status(400).json({ error: result.error });
  res.json({ user: accounts.publicUser(req.authedUser), reward: result.reward });
});

// ---- MPARADISE link: one shared identity + token balance with Storm Royale. ----

// Browser-facing: the signed-in Neoblox player asks for a code to type into the Storm Royale website.
app.post('/api/mparadise/link-code', requireAuth, (req, res) => {
  if(req.authedUser.stormUserId) return res.status(400).json({ error:'Already linked to a Storm Royale account.' });
  res.json({ code: accounts.createLinkCode(req.authedUser.id) });
});

app.post('/api/mparadise/unlink', requireAuth, (req, res) => {
  accounts.unlinkStorm(req.authedUser);
  res.json({ user: accounts.publicUser(req.authedUser) });
});

// Server-to-server only (never the browser): Storm Royale's server calls these, authenticated
// with the shared MPARADISE_LINK_KEY (same convention as Storm Royale's own GAME_API_KEY).
function requireMparadiseKey(req, res, next){
  const key = req.headers['x-mparadise-key'];
  if(!accounts.MPARADISE_LINK_KEY || !key || key !== accounts.MPARADISE_LINK_KEY) return res.status(401).json({ error:'bad key' });
  next();
}

// Called once, when a Storm Royale player redeems the code shown on Neoblox.
app.post('/api/mparadise/redeem', requireMparadiseKey, (req, res) => {
  const { code, stormUserId, stormUsername, ageGroup, kidSettings, coinsSeed } = req.body || {};
  if(!code || !stormUserId) return res.status(400).json({ error:'missing code/stormUserId' });
  const result = accounts.redeemLinkCode(code, { stormUserId, stormUsername, ageGroup, kidSettings, coinsSeed });
  if(result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Called roughly every ~10s while a linked player is online in Storm Royale: mirrors their
// current Roblox coin total (and refreshes the kid-safety flags) — never an award trigger here.
app.post('/api/mparadise/push', requireMparadiseKey, (req, res) => {
  const { stormUserId, stormCoinsMirror, ageGroup, kidSettings } = req.body || {};
  if(!stormUserId) return res.status(400).json({ error:'missing stormUserId' });
  const result = accounts.applyStormPush(stormUserId, { stormCoinsMirror, ageGroup, kidSettings });
  if(result.error) return res.status(404).json(result);
  res.json(result);
});

// ---- cross-play squads: team up with friends playing Storm Royale (the Roblox game or its
// website). Storm Royale's server is the squad hub; these routes relay the signed-in Neoblox
// player's squad actions to it over the MPARADISE link (the player's browser never talks to
// Storm Royale directly). A Neoblox player is keyed `neoblox:<id>` on the hub; their restriction
// flags (from an MPARADISE-linked kid account, if any) ride along so the hub can keep kids out.
function crossIdentity(u, extra){
  return Object.assign({ neobloxId: u.id, name: u.username, restricted: u.restricted || null }, extra || {});
}
async function relayCross(res, path, body){
  try{
    res.json(await accounts.callStorm(path, body));
  }catch(err){
    res.status(err.status || 502).json({ error: err.message || 'Couldn’t reach Storm Royale — try again.' });
  }
}

app.post('/api/crossparty/create', requireAuth, (req, res) => relayCross(res, '/api/mparadise/party/create', crossIdentity(req.authedUser)));
app.post('/api/crossparty/join', requireAuth, (req, res) => relayCross(res, '/api/mparadise/party/join', crossIdentity(req.authedUser, { code: req.body?.code })));
app.post('/api/crossparty/leave', requireAuth, (req, res) => relayCross(res, '/api/mparadise/party/leave', { neobloxId: req.authedUser.id }));
app.post('/api/crossparty/ready', requireAuth, (req, res) => relayCross(res, '/api/mparadise/party/ready', { neobloxId: req.authedUser.id, ready: req.body?.ready === true }));
app.post('/api/crossparty/launch', requireAuth, (req, res) => relayCross(res, '/api/mparadise/party/launch', { neobloxId: req.authedUser.id }));
app.post('/api/crossparty/chat', requireAuth, (req, res) => relayCross(res, '/api/mparadise/party/chat', crossIdentity(req.authedUser, { text: req.body?.text })));
app.post('/api/crossparty/result', requireAuth, (req, res) => relayCross(res, '/api/mparadise/party/result', { neobloxId: req.authedUser.id, kills: req.body?.kills, placement: req.body?.placement, won: req.body?.won }));
// ---- play Storm Royale on Roblox: Storm Royale's server checks the links (Neoblox → Storm Royale →
// Roblox), puts this player's Neoblox look on their Storm Royale character, and returns the Roblox
// launch link (with their squad's code, if they're in one).
app.post('/api/play-roblox', requireAuth, (req, res) => {
  const look = req.body && req.body.look && typeof req.body.look === 'object' ? req.body.look : null;
  relayCross(res, '/api/mparadise/play', { neobloxId: req.authedUser.id, look: look ? { skin: look.skin, shirt: look.shirt, pants: look.pants } : null });
});

// ---- tournaments: the leaderboard lives on Storm Royale (Roblox + Neoblox results together).
// Anyone can look; logged-in players also get their own rank.
app.get('/api/tournament', (req, res) => {
  const h = req.headers.authorization || '';
  const u = h.startsWith('Bearer ') ? accounts.userForToken(h.slice(7)) : null;
  const body = u ? { neobloxId: u.id, restricted: u.restricted || null } : {};
  if(req.query.id) body.id = String(req.query.id).slice(0, 12);
  relayCross(res, '/api/mparadise/tournament', body);
});
app.get('/api/crossparty/state', requireAuth, (req, res) => relayCross(res, '/api/mparadise/party/state', crossIdentity(req.authedUser, { status: 'On Neoblox' })));

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, accounts.AVATARS_DIR),
    filename: (req, file, cb) => cb(null, req.authedUser.id + '.glb'),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.glb$/i.test(file.originalname) || file.mimetype === 'model/gltf-binary';
    cb(ok ? null : new Error('Only .glb files are supported — export/re-export as glTF Binary (.glb).'), ok);
  },
}).single('model');

app.post('/api/avatar', requireAuth, (req, res) => {
  // A Storm Royale-linked kid account carries over the same no-custom-content restriction
  // Storm Royale itself enforces (owned Roblox items only, no arbitrary uploads) — linking
  // doesn't give a parent-approved, locked-down kid account a free pass into this instead.
  if(req.authedUser.restricted && req.authedUser.restricted.isKid){
    return res.status(403).json({ error:'Avatar uploads are off for linked kid accounts.' });
  }
  avatarUpload(req, res, (err) => {
    if(err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if(!req.file) return res.status(400).json({ error: 'No file received.' });
    req.authedUser.avatarFile = req.file.filename;
    accounts.noteAvatarUpload(req.authedUser);
    accounts.markDirty(); accounts.saveNow();
    res.json({ user: accounts.publicUser(req.authedUser) });
  });
});

app.delete('/api/avatar', requireAuth, (req, res) => {
  const u = req.authedUser;
  if(u.avatarFile){
    try{ fs.unlinkSync(path.join(accounts.AVATARS_DIR, u.avatarFile)); }catch(e){}
    u.avatarFile = null;
    accounts.markDirty(); accounts.saveNow();
  }
  res.json({ user: accounts.publicUser(u) });
});

app.use('/api/avatars', express.static(accounts.AVATARS_DIR, {
  maxAge: '1h',
  setHeaders: (res, filePath) => { if(filePath.endsWith('.glb')) res.setHeader('Content-Type', 'model/gltf-binary'); },
}));

app.get('/healthz', (req, res) => res.json({ ok: true, players: players.size, parties: parties.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- state ----
/** id -> { ws, id, name, avatar, x,y,z,ry, anim, world, partyCode, alive } */
const players = new Map();
/** code -> { leader, members: Set<id>, voice: Set<id> } */
const parties = new Map();
/** everyone currently in the site-wide voice room (not party-scoped) */
const globalVoice = new Set();
// Mesh WebRTC means every extra participant adds a connection to everyone else already in the
// room (O(n^2)) — fine for a small hobby-scale hangout, not for hundreds at once, so cap it.
const MAX_GLOBAL_VOICE = 12;

let nextId = 1;
function makeId(){ return 'p' + (nextId++) + '_' + Math.random().toString(36).slice(2,7); }
function makePartyCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for(let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return parties.has(s) ? makePartyCode() : s;
}

function send(ws, msg){
  if(ws.readyState === ws.OPEN){
    try{ ws.send(JSON.stringify(msg)); }catch(e){}
  }
}
function sendTo(id, msg){
  const p = players.get(id);
  if(p) send(p.ws, msg);
}
function broadcastAll(msg, exceptId){
  for(const p of players.values()){
    if(p.id !== exceptId) send(p.ws, msg);
  }
}
function broadcastWorld(world, msg, exceptId){
  for(const p of players.values()){
    if(p.world === world && p.id !== exceptId) send(p.ws, msg);
  }
}
function partyOf(id){
  const p = players.get(id);
  if(!p || !p.partyCode) return null;
  return parties.get(p.partyCode) || null;
}
function partyRoster(code){
  const party = parties.get(code);
  if(!party) return [];
  return [...party.members].map(id => {
    const p = players.get(id);
    return p ? { id: p.id, name: p.name, avatar: p.avatar, inVoice: party.voice.has(id) } : null;
  }).filter(Boolean);
}
function globalVoiceRoster(){
  return [...globalVoice].map(id => {
    const p = players.get(id);
    return p ? { id: p.id, name: p.name } : null;
  }).filter(Boolean);
}
function broadcastGlobalVoiceUpdate(){
  // Sent to everyone online (not just current members) so anyone can see the room is active
  // and choose to join it — that's the point of it being "global".
  broadcastAll({ t:'gvoice_update', members: globalVoiceRoster() });
}
function broadcastPartyUpdate(code){
  const party = parties.get(code);
  if(!party) return;
  const msg = { t:'party_update', code, leader: party.leader, members: partyRoster(code) };
  for(const id of party.members) sendTo(id, msg);
}
function leavePartyInternal(id){
  const p = players.get(id);
  if(!p || !p.partyCode) return;
  const code = p.partyCode;
  const party = parties.get(code);
  p.partyCode = null;
  if(!party) return;
  party.members.delete(id);
  party.voice.delete(id);
  if(party.members.size === 0){
    parties.delete(code);
    return;
  }
  if(party.leader === id){
    party.leader = [...party.members][0];
  }
  broadcastPartyUpdate(code);
}

const HEARTBEAT_MS = 20000;
setInterval(() => {
  for(const p of players.values()){
    if(p.alive === false){
      try{ p.ws.terminate(); }catch(e){}
      continue;
    }
    p.alive = false;
    try{ p.ws.ping(); }catch(e){}
  }
}, HEARTBEAT_MS);

// ---- Thunder Battle rounds -------------------------------------------------------------------
// Thunder Battle's combat runs in the players' browsers (each client applies hits and storm damage
// to itself and announces its own eliminations), so on its own there was no match end, no
// placement, and nothing a leaderboard could trust. The server now runs ROUNDS for everyone in the
// battle world: one shared clock (so the storm closes at the same time for everybody), its own
// count of eliminations from the relayed 'ko' events — with limits that make farming with a second
// account pointless — and placements at the end. Logged-in players' results then go to Storm
// Royale's cross-platform tournament (and to their squad, if they're in one).
const GAME_EVT_PREFIX = 'NBGAME';
const BATTLE_WORLD = 'battle';
const ROUND_MS = Number(process.env.BATTLE_ROUND_MS) || 180000;
const BREAK_MS = Number(process.env.BATTLE_BREAK_MS) || 8000;
const MAX_HIT_DMG = 65;        // the strongest weapon (Boom Launcher)
const MAX_HITS_PER_SEC = 8;
const MAX_KILLS_PER_PAIR = 3;  // the same victim can only feed the same killer 3 times a round
const MIN_DEATH_GAP_MS = Number(process.env.BATTLE_DEATH_GAP_MS) || 2500; // respawning takes 3 s
const battle = { roundId: 0, state: 'idle', startedAt: 0, endsAt: 0, breakUntil: 0, stats: new Map() };

function battlePlayers(){ return [...players.values()].filter(p => p.world === BATTLE_WORLD); }
function battleStat(p){
  let s = battle.stats.get(p.id);
  if(!s){ s = { kills:0, deaths:0, lastDeathAt:0, pair:new Map() }; battle.stats.set(p.id, s); }
  s.name = p.name; s.userId = p.userId;
  return s;
}
function battleRoundMsg(){
  const now = Date.now();
  return {
    t:'battle_round', roundId: battle.roundId, state: battle.state, durationMs: ROUND_MS,
    elapsedMs: battle.state === 'live' ? now - battle.startedAt : 0,
    nextInMs: battle.state === 'break' ? Math.max(0, battle.breakUntil - now) : 0,
  };
}
function startBattleRound(){
  battle.roundId += 1;
  battle.state = 'live';
  battle.startedAt = Date.now();
  battle.endsAt = battle.startedAt + ROUND_MS;
  battle.stats = new Map();
  const here = battlePlayers();
  here.forEach(battleStat);
  const msg = battleRoundMsg();
  here.forEach(p => send(p.ws, msg));
}
function endBattleRound(){
  // placed: everyone still in the arena at the bell, by eliminations, then fewest deaths
  const rows = battlePlayers().map(p => { const s = battleStat(p); return { id:p.id, name:p.name, userId:p.userId, kills:s.kills, deaths:s.deaths }; });
  rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  let place = 0;
  rows.forEach((r, i) => { if(i === 0 || r.kills !== rows[i-1].kills || r.deaths !== rows[i-1].deaths) place = i + 1; r.placement = place; });
  const tiedTop = rows.length > 1 && rows[1].placement === 1;
  rows.forEach(r => { r.won = r.placement === 1 && r.kills > 0 && !tiedTop; });
  battle.state = 'break';
  battle.breakUntil = Date.now() + BREAK_MS;
  const msg = { t:'battle_round_end', roundId: battle.roundId, size: rows.length, nextInMs: BREAK_MS,
    results: rows.map(r => ({ id:r.id, name:r.name, kills:r.kills, deaths:r.deaths, placement:r.placement, won:r.won })) };
  battlePlayers().forEach(p => send(p.ws, msg));
  if(rows.length >= 2) rows.forEach(r => reportBattleResult(r, rows.length)); // a solo round isn't a match
}
function reportBattleResult(r, size){
  if(!r.userId) return; // guests can play, but only accounts go on the leaderboard
  const u = accounts.getUser(r.userId);
  if(!u) return;
  accounts.callStorm('/api/mparadise/tournament/result', { neobloxId:u.id, name:u.username, restricted:u.restricted || null, kills:r.kills, placement:r.placement, size, won:r.won }).catch(() => {});
  // shows in their cross-play squad's "last match" too (the hub ignores it if they aren't in one)
  accounts.callStorm('/api/mparadise/party/result', { neobloxId:u.id, kills:r.kills, placement:r.placement, won:r.won }).catch(() => {});
}
setInterval(() => {
  if(!battlePlayers().length){ battle.state = 'idle'; battle.stats = new Map(); return; }
  const now = Date.now();
  if(battle.state === 'idle') startBattleRound();
  else if(battle.state === 'live' && now >= battle.endsAt) endBattleRound();
  else if(battle.state === 'break' && now >= battle.breakUntil) startBattleRound();
}, 500);

function battleEnter(player){
  if(battle.state === 'idle') return startBattleRound(); // tells everyone in the arena, them included
  if(battle.state === 'live') battleStat(player);
  send(player.ws, battleRoundMsg());
}

// Thunder Battle's game events ride on 'game'-scope chat. The server now checks the two that decide
// who wins — hits and eliminations — before passing anything on, and rewrites them with the names
// it knows (so nobody can put words or kills in someone else's mouth).
function handleGameEvent(player, raw){
  if(raw.length > 2000) return;
  let evt;
  try{ evt = JSON.parse(raw.slice(GAME_EVT_PREFIX.length)); }catch(e){ return; }
  if(!evt || typeof evt !== 'object' || typeof evt.k !== 'string') return;
  const now = Date.now();
  if(evt.k === 'hit'){
    if(player.world !== BATTLE_WORLD || battle.state === 'break') return;
    const dmg = Number(evt.dmg);
    if(!(dmg > 0 && dmg <= MAX_HIT_DMG)) return;
    const target = players.get(String(evt.target || ''));
    if(!target || target.world !== BATTLE_WORLD || target.id === player.id) return;
    player.hitTimes = (player.hitTimes || []).filter(t => now - t < 1000);
    if(player.hitTimes.length >= MAX_HITS_PER_SEC) return;
    player.hitTimes.push(now);
    evt = { k:'hit', target:target.id, by:player.id, byName:player.name, dmg };
  } else if(evt.k === 'ko'){
    if(player.world !== BATTLE_WORLD) return;
    // the sender is always the one eliminated; the killer has to be someone else in the arena
    const k = evt.by ? players.get(String(evt.by)) : null;
    const killer = k && k.world === BATTLE_WORLD && k.id !== player.id ? k : null;
    if(battle.state === 'live'){
      const v = battleStat(player);
      if(now - v.lastDeathAt >= MIN_DEATH_GAP_MS){
        v.lastDeathAt = now;
        v.deaths += 1;
        if(killer){
          const ks = battleStat(killer);
          const n = ks.pair.get(player.id) || 0;
          if(n < MAX_KILLS_PER_PAIR){ ks.pair.set(player.id, n + 1); ks.kills += 1; }
        }
      }
    }
    evt = { k:'ko', by: killer ? killer.id : null, byName: killer ? killer.name : null, victimName: player.name };
  } else if(evt.k === 'crate'){
    evt = { k:'crate', i: Math.floor(Number(evt.i)) || 0 };
  } // 'build' and anything else passes through unchanged
  // everyone else in the world (the sender already applied it locally)
  broadcastWorld(player.world, { t:'chat', scope:'game', from:player.id, name:player.name, text: GAME_EVT_PREFIX + JSON.stringify(evt), ts: now }, player.id);
}

wss.on('connection', (ws) => {
  const id = makeId();
  // world starts as null (not 'lobby') — the player is still on the name-entry screen until
  // their first real 'presence' message says otherwise, so they don't briefly appear to be
  // standing in the lobby (with a not-yet-final name) to everyone already there.
  const player = { ws, id, name:'Player', avatar:null, x:0,y:1,z:0, ry:0, anim:'idle', world:null, partyCode:null, alive:true, isAdmin:false, userId:null };
  players.set(id, player);

  ws.on('pong', () => { player.alive = true; });

  send(ws, {
    t:'welcome',
    id,
    players: [...players.values()].filter(p=>p.id!==id).map(p=>({ id:p.id, name:p.name, avatar:p.avatar, x:p.x,y:p.y,z:p.z, ry:p.ry, anim:p.anim, world:p.world, isAdmin:p.isAdmin })),
    gvoiceMembers: globalVoiceRoster(),
  });

  ws.on('message', (raw) => {
    let msg;
    try{ msg = JSON.parse(raw); }catch(e){ return; }
    if(!msg || typeof msg.t !== 'string') return;

    switch(msg.t){
      case 'hello': {
        // A logged-in session token (see accounts.js) makes this connection an authenticated
        // player — their name comes from their real account (never the client-supplied name,
        // so nobody can impersonate another account's identity) and their uploaded avatar (if
        // any) rides along in the same avatar object the client already broadcasts cosmetics
        // through. No session token at all just means "playing as a guest", same as before —
        // guests can still play, they just don't earn tokens or have an account-tied avatar.
        const authedUser = msg.session ? accounts.userForToken(String(msg.session)) : null;
        if(authedUser){
          player.userId = authedUser.id;
          player.name = authedUser.username.slice(0, 24);
          accounts.noteLogin(authedUser);
        } else {
          player.userId = null;
          player.name = String(msg.name || 'Player').slice(0, 24);
        }
        const avatarIn = msg.avatar || {};
        player.avatar = Object.assign({}, avatarIn, authedUser
          ? { uploadedAvatarUrl: authedUser.avatarFile ? ('/api/avatars/' + authedUser.id + '.glb') : null }
          : {});
        broadcastAll({ t:'player_join', id, name:player.name, avatar:player.avatar, world:player.world, isAdmin:player.isAdmin }, id);
        break;
      }
      case 'presence': {
        player.x = +msg.x || 0; player.y = +msg.y || 0; player.z = +msg.z || 0;
        player.ry = +msg.ry || 0; player.anim = msg.anim || 'idle';
        if(player.userId){
          const u = accounts.getUser(player.userId);
          if(u) accounts.noteMove(u, player.x, player.z);
        }
        if(msg.world && msg.world !== player.world){
          const prevWorld = player.world;
          player.world = msg.world;
          if(player.userId){
            const u = accounts.getUser(player.userId);
            if(u) accounts.noteWorldVisit(u, player.world);
          }
          broadcastWorld(prevWorld, { t:'player_leave_world', id, world: prevWorld }, id);
          broadcastWorld(player.world, { t:'player_join_world', id, name:player.name, avatar:player.avatar, world:player.world, isAdmin:player.isAdmin }, id);
          if(player.world === BATTLE_WORLD) battleEnter(player);
        }
        broadcastWorld(player.world, { t:'presence', id, x:player.x,y:player.y,z:player.z, ry:player.ry, anim:player.anim, world:player.world }, id);
        break;
      }
      case 'admin_auth': {
        // Real server-side check — a client can set whatever it wants locally, but only
        // this comparison against the server's own password can ever set isAdmin=true.
        if(String(msg.pass || '') === ADMIN_PASSWORD){
          player.isAdmin = true;
          send(ws, { t:'admin_ok' });
          broadcastAll({ t:'admin_status', id, name:player.name, isAdmin:true }, id);
        } else {
          send(ws, { t:'admin_fail' });
        }
        break;
      }
      case 'admin_kick': {
        // Visible, announced moderation — never a silent removal. Everyone in the game sees
        // who did it and who it happened to, same as any other chat message.
        if(!player.isAdmin) break;
        const target = players.get(String(msg.targetId || ''));
        if(target && target.id !== player.id){
          broadcastAll({ t:'chat', scope:'global', from:id, name:player.name, text: '🛑 '+player.name+' kicked '+target.name+' from the game.', ts: Date.now() });
          send(target.ws, { t:'kicked', by: player.name });
          setTimeout(() => { try{ target.ws.close(); }catch(e){} }, 150);
        }
        break;
      }
      case 'emote': {
        broadcastWorld(player.world, { t:'emote', id, kind: msg.kind }, id);
        break;
      }
      case 'chat': {
        if(msg.scope === 'game' && typeof msg.text === 'string' && msg.text.indexOf(GAME_EVT_PREFIX) === 0){
          handleGameEvent(player, msg.text);
          break;
        }
        const text = String(msg.text || '').slice(0, 500);
        if(!text.trim()) break;
        if(player.userId){
          const u = accounts.getUser(player.userId);
          if(u && u.restricted && !u.restricted.allowChat){ send(ws, { t:'chat_blocked', reason:'Chat is off for this linked kid account.' }); break; }
          if(u) accounts.noteChat(u);
        }
        const scope = msg.scope === 'party' ? 'party' : msg.scope === 'game' ? 'game' : 'global';
        const out = { t:'chat', scope, from:id, name:player.name, text, ts: Date.now() };
        if(scope === 'party'){
          const party = partyOf(id);
          if(party) for(const mid of party.members) sendTo(mid, out);
          else sendTo(id, out); // solo — echo back so the UI shows it
        } else if(scope === 'game'){
          broadcastWorld(player.world, out); // includes sender
        } else {
          broadcastAll(out); // players map includes the sender, so this reaches everyone
        }
        break;
      }
      case 'party_create': {
        if(player.partyCode) leavePartyInternal(id);
        const code = makePartyCode();
        parties.set(code, { leader: id, members: new Set([id]), voice: new Set() });
        player.partyCode = code;
        if(player.userId){ const u = accounts.getUser(player.userId); if(u) accounts.notePartyJoin(u); }
        broadcastPartyUpdate(code);
        break;
      }
      case 'party_join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const party = parties.get(code);
        if(!party){ send(ws, { t:'party_error', reason:'not_found', code }); break; }
        if(player.partyCode) leavePartyInternal(id);
        party.members.add(id);
        player.partyCode = code;
        if(player.userId){ const u = accounts.getUser(player.userId); if(u) accounts.notePartyJoin(u); }
        broadcastPartyUpdate(code);
        break;
      }
      case 'party_leave': {
        leavePartyInternal(id);
        break;
      }
      case 'party_invite': {
        const target = players.get(msg.targetId);
        if(!target) break;
        let code = player.partyCode;
        if(!code){
          code = makePartyCode();
          parties.set(code, { leader: id, members: new Set([id]), voice: new Set() });
          player.partyCode = code;
          broadcastPartyUpdate(code);
        }
        send(target.ws, { t:'party_invited', from:id, name:player.name, code });
        break;
      }
      case 'gvoice_join': {
        if(player.userId){
          const u0 = accounts.getUser(player.userId);
          if(u0 && u0.restricted && !u0.restricted.allowVoice){ send(ws, { t:'voice_blocked', reason:'Voice is off for this linked kid account.' }); break; }
        }
        if(!globalVoice.has(id) && globalVoice.size >= MAX_GLOBAL_VOICE){ send(ws, { t:'gvoice_full' }); break; }
        if(player.userId){ const u = accounts.getUser(player.userId); if(u) accounts.noteGVoiceJoin(u); }
        globalVoice.add(id);
        const roster = [...globalVoice].filter(v=>v!==id);
        send(ws, { t:'gvoice_roster', peers: roster });
        for(const pid of roster) sendTo(pid, { t:'gvoice_peer_join', id, name: player.name });
        broadcastGlobalVoiceUpdate();
        break;
      }
      case 'gvoice_leave': {
        if(!globalVoice.has(id)) break;
        globalVoice.delete(id);
        for(const pid of globalVoice) sendTo(pid, { t:'gvoice_peer_leave', id });
        broadcastGlobalVoiceUpdate();
        break;
      }
      case 'voice_join': {
        if(player.userId){
          const u0 = accounts.getUser(player.userId);
          if(u0 && u0.restricted && !u0.restricted.allowVoice){ send(ws, { t:'voice_blocked', reason:'Voice is off for this linked kid account.' }); break; }
        }
        const party = partyOf(id);
        if(!party) break;
        party.voice.add(id);
        const roster = [...party.voice].filter(v=>v!==id);
        send(ws, { t:'voice_roster', code: player.partyCode, peers: roster });
        for(const pid of roster) sendTo(pid, { t:'voice_peer_join', id });
        broadcastPartyUpdate(player.partyCode);
        break;
      }
      case 'voice_leave': {
        const party = partyOf(id);
        if(!party) break;
        party.voice.delete(id);
        for(const pid of party.members) if(pid!==id) sendTo(pid, { t:'voice_peer_leave', id });
        broadcastPartyUpdate(player.partyCode);
        break;
      }
      case 'rtc_signal': {
        // relay WebRTC offer/answer/ICE between two voice peers — either two party voice
        // members, or two people both in the global voice room (never a mix of the two).
        if(!msg.to || !msg.data) break;
        const scope = msg.scope === 'global' ? 'global' : 'party';
        if(scope === 'global'){
          if(!globalVoice.has(id) || !globalVoice.has(msg.to)) break;
        } else {
          const party = partyOf(id);
          if(!party || !party.members.has(msg.to)) break;
        }
        sendTo(msg.to, { t:'rtc_signal', from:id, data: msg.data, scope });
        break;
      }
      case 'voice_speaking': {
        // Live "who's talking right now" indicator — relayed only to players who'd actually
        // see this avatar (same world), same trust model as emote/presence: no server-side
        // check that the sender is really in a voice room, since a false positive here is
        // harmless (a mic icon blinking on someone not in voice, at worst).
        broadcastWorld(player.world, { t:'voice_speaking', id, speaking: !!msg.speaking }, id);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    leavePartyInternal(id);
    if(globalVoice.has(id)){
      globalVoice.delete(id);
      for(const pid of globalVoice) sendTo(pid, { t:'gvoice_peer_leave', id });
      broadcastGlobalVoiceUpdate();
    }
    broadcastAll({ t:'player_leave', id, world: player.world });
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Neoblox server listening on :${PORT}`);
  console.log(`  static site: http://localhost:${PORT}/`);
  console.log(`  websocket:   ws://localhost:${PORT}/ws`);
});
