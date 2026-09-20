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
const { WebSocketServer } = require('ws');

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

app.get('/healthz', (req, res) => res.json({ ok: true, players: players.size, parties: parties.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- state ----
/** id -> { ws, id, name, avatar, x,y,z,ry, anim, world, partyCode, alive } */
const players = new Map();
/** code -> { leader, members: Set<id>, voice: Set<id> } */
const parties = new Map();

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

wss.on('connection', (ws) => {
  const id = makeId();
  // world starts as null (not 'lobby') — the player is still on the name-entry screen until
  // their first real 'presence' message says otherwise, so they don't briefly appear to be
  // standing in the lobby (with a not-yet-final name) to everyone already there.
  const player = { ws, id, name:'Player', avatar:null, x:0,y:1,z:0, ry:0, anim:'idle', world:null, vehicle:null, partyCode:null, alive:true, isAdmin:false };
  players.set(id, player);

  ws.on('pong', () => { player.alive = true; });

  send(ws, {
    t:'welcome',
    id,
    players: [...players.values()].filter(p=>p.id!==id).map(p=>({ id:p.id, name:p.name, avatar:p.avatar, x:p.x,y:p.y,z:p.z, ry:p.ry, anim:p.anim, world:p.world, vehicle:p.vehicle, isAdmin:p.isAdmin })),
  });

  ws.on('message', (raw) => {
    let msg;
    try{ msg = JSON.parse(raw); }catch(e){ return; }
    if(!msg || typeof msg.t !== 'string') return;

    switch(msg.t){
      case 'hello': {
        player.name = String(msg.name || 'Player').slice(0, 24);
        player.avatar = msg.avatar || null;
        broadcastAll({ t:'player_join', id, name:player.name, avatar:player.avatar, world:player.world, isAdmin:player.isAdmin }, id);
        break;
      }
      case 'presence': {
        player.x = +msg.x || 0; player.y = +msg.y || 0; player.z = +msg.z || 0;
        player.ry = +msg.ry || 0; player.anim = msg.anim || 'idle';
        // Racing Royale's vehicle state (which car, roughly how fast) — optional, only sent
        // while driving; sanitized to a couple of plain fields so a client can't smuggle
        // arbitrary data into what every other player's browser renders.
        if(msg.vehicle && typeof msg.vehicle === 'object'){
          player.vehicle = { carId: String(msg.vehicle.carId || '').slice(0, 20), speed: +msg.vehicle.speed || 0 };
        } else {
          player.vehicle = null;
        }
        if(msg.world && msg.world !== player.world){
          const prevWorld = player.world;
          player.world = msg.world;
          broadcastWorld(prevWorld, { t:'player_leave_world', id, world: prevWorld }, id);
          broadcastWorld(player.world, { t:'player_join_world', id, name:player.name, avatar:player.avatar, world:player.world, vehicle:player.vehicle, isAdmin:player.isAdmin }, id);
        }
        broadcastWorld(player.world, { t:'presence', id, x:player.x,y:player.y,z:player.z, ry:player.ry, anim:player.anim, world:player.world, vehicle:player.vehicle }, id);
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
        const text = String(msg.text || '').slice(0, 500);
        if(!text.trim()) break;
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
      case 'voice_join': {
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
        // relay WebRTC offer/answer/ICE between two party voice members
        if(!msg.to || !msg.data) break;
        const party = partyOf(id);
        if(!party || !party.members.has(msg.to)) break;
        sendTo(msg.to, { t:'rtc_signal', from:id, data: msg.data });
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    leavePartyInternal(id);
    broadcastAll({ t:'player_leave', id, world: player.world });
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Neoblox server listening on :${PORT}`);
  console.log(`  static site: http://localhost:${PORT}/`);
  console.log(`  websocket:   ws://localhost:${PORT}/ws`);
});
