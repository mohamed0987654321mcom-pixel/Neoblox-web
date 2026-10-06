// accounts.js — user accounts, token currency, quests, and avatar uploads for Neoblox.
//
// Self-contained on purpose: server.js just requires this and calls a handful of hooks at the
// right points in its existing WebSocket handlers (hello/presence/chat/party/voice). Persisted
// to ./data/users.json (+ uploaded avatar files under ./data/avatars/*.glb) so accounts, token
// balances and avatars survive restarts — as long as ./data sits on a real persistent volume
// (a Railway Volume in production, or just a normal disk when self-hosting elsewhere). Without
// one this resets on every redeploy, the same limitation worlds.json already had before this.
//
// Passwords are hashed with Node's built-in crypto.scrypt (salt + scrypt + timing-safe compare)
// rather than adding bcrypt as a dependency — scrypt is a well-regarded, memory-hard KDF and
// this avoids a native-module build step on top of what Railway's Railpack builder already does.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');

fs.mkdirSync(AVATARS_DIR, { recursive: true });

function loadUsers(){
  try{ return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }catch(e){ return []; }
}
let users = loadUsers();
let dirty = false;
function markDirty(){ dirty = true; }
function saveNow(){
  if(!dirty) return;
  try{
    fs.mkdirSync(DATA_DIR, { recursive:true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users));
    dirty = false;
  }catch(e){ console.error('failed to save users.json', e); }
}
// Presence updates arrive ~10x/sec per player and touch stats (distanceWalked) — flushing to
// disk on every one of those would hammer the filesystem, so writes batch on a short interval
// instead, plus immediately after anything a player is actively waiting on (register/login/
// claim/avatar upload all call saveNow() directly too).
setInterval(saveNow, 15000);
process.on('SIGTERM', saveNow);
process.on('SIGINT', () => { saveNow(); process.exit(0); });

const byId = new Map();
const byUsernameLower = new Map();
const byStormId = new Map();
function indexUser(u){
  byId.set(u.id, u);
  byUsernameLower.set(u.username.toLowerCase(), u);
  if(u.stormUserId) byStormId.set(String(u.stormUserId), u);
}
users.forEach(indexUser);

let nextUserId = users.reduce((m,u)=>Math.max(m, parseInt(u.id,10)||0), 0) + 1;

function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored){
  const parts = String(stored||'').split(':');
  if(parts.length !== 2) return false;
  const [salt, hash] = parts;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function todayKey(){ return new Date().toISOString().slice(0,10); }

// Server is the single source of truth for what counts as "done" and what it pays — the client
// only ever displays progress it's told, never decides completion or awards itself tokens.
const QUESTS = [
  { id:'first_steps',    title:'First Steps',        desc:'Send your first chat message',  reward:20, repeat:'once',  goal:1,   stat:s=>s.chatCount||0 },
  { id:'chatterbox',     title:'Chatterbox',         desc:'Send 25 chat messages',          reward:50, repeat:'once',  goal:25,  stat:s=>s.chatCount||0 },
  { id:'world_traveler', title:'World Traveler',     desc:'Visit 3 different worlds',       reward:40, repeat:'once',  goal:3,   stat:s=>(s.worldsVisited||[]).length },
  { id:'party_starter',  title:'Party Starter',      desc:'Create or join a party',         reward:25, repeat:'once',  goal:1,   stat:s=>s.partyJoins||0 },
  { id:'voice_of_lobby', title:'Voice of the Lobby', desc:'Join the global voice room',     reward:25, repeat:'once',  goal:1,   stat:s=>s.gvoiceJoins||0 },
  { id:'marathoner',     title:'Marathoner',         desc:'Walk a cumulative 500m',         reward:60, repeat:'once',  goal:500, stat:s=>Math.floor(s.distanceWalked||0) },
  { id:'trendsetter',    title:'Trendsetter',        desc:'Upload a custom avatar model',   reward:50, repeat:'once',  goal:1,   stat:s=>s.hasUploadedAvatar ? 1 : 0 },
  { id:'daily_login',    title:'Daily Check-in',     desc:'Log in today',                   reward:15, repeat:'daily', goal:1,   stat:s=>(s.loginDates||[]).includes(todayKey()) ? 1 : 0 },
];

function freshStats(){
  return { chatCount:0, worldsVisited:[], partyJoins:0, gvoiceJoins:0, distanceWalked:0, hasUploadedAvatar:false, loginDates:[], lastX:null, lastZ:null };
}

function questProgressFor(u){
  const claimed = u.claimedQuests || {};
  return QUESTS.map(q => {
    const progress = Math.min(q.goal, q.stat(u.stats || freshStats()));
    const claimedMark = claimed[q.id];
    const alreadyClaimed = q.repeat === 'daily' ? claimedMark === todayKey() : !!claimedMark;
    return {
      id: q.id, title: q.title, desc: q.desc, reward: q.reward, repeat: q.repeat,
      progress, goal: q.goal,
      complete: progress >= q.goal,
      claimed: alreadyClaimed,
      canClaim: progress >= q.goal && !alreadyClaimed,
    };
  });
}

function publicUser(u){
  return {
    id: u.id,
    username: u.username,
    tokens: u.tokens || 0,
    avatarUrl: u.avatarFile ? ('/api/avatars/' + u.id + '.glb') : null,
    quests: questProgressFor(u),
    mparadise: {
      linked: !!u.stormUserId,
      stormUsername: u.stormUsername || null,
      stormCoins: u.stormCoinsMirror || 0,
      sharedTotal: (u.tokens || 0) + (u.stormCoinsMirror || 0),
      restricted: u.restricted || null,
    },
  };
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
function register(username, password){
  username = String(username||'').trim();
  password = String(password||'');
  if(!USERNAME_RE.test(username)) return { error:'Usernames are 3-20 characters: letters, numbers, underscore only.' };
  if(password.length < 6) return { error:'Password must be at least 6 characters.' };
  if(byUsernameLower.has(username.toLowerCase())) return { error:'That username is already taken.' };
  const u = {
    id: String(nextUserId++),
    username,
    passwordHash: hashPassword(password),
    tokens: 0,
    avatarFile: null,
    stats: freshStats(),
    claimedQuests: {},
    createdAt: Date.now(),
    // MPARADISE cross-platform link (Storm Royale) — all null/0 until the player links an account
    stormUserId: null,
    stormUsername: null,
    stormCoinsMirror: 0,
    restricted: null, // {isKid, allowChat, allowVoice} mirrored from Storm Royale's own kid-safety flags
  };
  users.push(u); indexUser(u); markDirty(); saveNow();
  return { user: u };
}
function login(username, password){
  const u = byUsernameLower.get(String(username||'').trim().toLowerCase());
  if(!u || !verifyPassword(password, u.passwordHash)) return { error:'Wrong username or password.' };
  return { user: u };
}
function getUser(id){ return byId.get(id) || null; }

// ---- sessions: simple bearer tokens, kept in memory only. A redeploy without a bound
// persistent session store logs everyone out (they just log back in) — a deliberate
// simplicity tradeoff, not an oversight; token balances/avatars/quest progress themselves are
// always durable on disk regardless. ----
const sessions = new Map(); // token -> userId
function createSession(userId){
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, userId);
  return token;
}
function userForToken(token){
  const uid = sessions.get(token);
  return uid ? (byId.get(uid) || null) : null;
}

function noteLogin(u){
  if(!u) return;
  u.stats = u.stats || freshStats();
  const today = todayKey();
  if(!(u.stats.loginDates||[]).includes(today)){
    u.stats.loginDates = [...(u.stats.loginDates||[]).slice(-13), today];
    markDirty();
  }
}
function noteChat(u){ if(!u) return; u.stats = u.stats||freshStats(); u.stats.chatCount = (u.stats.chatCount||0)+1; markDirty(); }
function noteWorldVisit(u, world){
  if(!u || !world) return;
  u.stats = u.stats||freshStats();
  if(!(u.stats.worldsVisited||[]).includes(world)){
    u.stats.worldsVisited = [...(u.stats.worldsVisited||[]), world];
    markDirty();
  }
}
function noteMove(u, x, z){
  if(!u) return;
  u.stats = u.stats||freshStats();
  if(u.stats.lastX !== null && u.stats.lastZ !== null){
    const d = Math.hypot(x-u.stats.lastX, z-u.stats.lastZ);
    // A sane per-tick cap (5m) so a teleport/mode-switch/portal jump can't be replayed into
    // free distance — presence ticks land ~10x/sec, so 5m/tick is already a very generous
    // ceiling for genuine walking/running speed.
    if(d > 0 && d < 5){ u.stats.distanceWalked = (u.stats.distanceWalked||0) + d; markDirty(); }
  }
  u.stats.lastX = x; u.stats.lastZ = z;
}
function notePartyJoin(u){ if(!u) return; u.stats = u.stats||freshStats(); u.stats.partyJoins = (u.stats.partyJoins||0)+1; markDirty(); }
function noteGVoiceJoin(u){ if(!u) return; u.stats = u.stats||freshStats(); u.stats.gvoiceJoins = (u.stats.gvoiceJoins||0)+1; markDirty(); }
function noteAvatarUpload(u){ if(!u) return; u.stats = u.stats||freshStats(); u.stats.hasUploadedAvatar = true; markDirty(); }

function claimQuest(u, questId){
  if(!u) return { error:'Not logged in.' };
  const q = QUESTS.find(x=>x.id===questId);
  if(!q) return { error:'No such quest.' };
  const progress = q.stat(u.stats||freshStats());
  if(progress < q.goal) return { error:'Not complete yet.' };
  u.claimedQuests = u.claimedQuests || {};
  const already = q.repeat==='daily' ? u.claimedQuests[q.id]===todayKey() : !!u.claimedQuests[q.id];
  if(already) return { error:'Already claimed.' };
  u.claimedQuests[q.id] = q.repeat==='daily' ? todayKey() : true;
  u.tokens = (u.tokens||0) + q.reward;
  markDirty(); saveNow();
  pushTokensToStorm(u); // best-effort, not awaited — see pushTokensToStorm's own comment
  return { user: u, reward: q.reward };
}

// ---------------------------------------------------------------------------
// MPARADISE link: one shared identity + token balance with Storm Royale (the
// Roblox game + its companion website). Mirrors the exact code-based linking
// flow Storm Royale already uses for its own Roblox link (a short code,
// redeemed on the other side), authenticated server-to-server with a shared
// secret (MPARADISE_LINK_KEY, set the same on both Railway services) rather
// than ever trusting anything the browser says about the other account.
//
// Each side only ever WRITES its own mirror field (stormCoinsMirror here,
// neoblox_tokens_mirror on Storm Royale) — never the other side's number —
// so there's no race to reconcile: the "shared total" shown to the player is
// just tokens + stormCoinsMirror, always safe to recompute.
//
// Storm Royale has its own under-13-with-parent-approval safety system;
// Neoblox has none. Linking is allowed for every account, kids included (no
// exceptions), but a linked kid identity carries Storm Royale's own chat/
// voice restrictions over to Neoblox too, rather than handing a parent-
// approved, locked-down kid account a free pass into Neoblox's unmoderated
// chat/voice/avatar-upload. See `restrictionsFor` below.
const MPARADISE_LINK_KEY = process.env.MPARADISE_LINK_KEY || null;
const STORM_ROYALE_URL = process.env.STORM_ROYALE_URL || 'https://stormroyale.mparadiseplatrforms.com';
if(!MPARADISE_LINK_KEY) console.warn('[mparadise] MPARADISE_LINK_KEY not set: Storm Royale linking is off.');

const linkCodes = new Map(); // code -> { userId, exp }
setInterval(() => {
  const now = Date.now();
  for(const [code, d] of linkCodes) if(d.exp < now) linkCodes.delete(code);
}, 60000).unref();

function restrictionsFor(ageGroup, kidSettings){
  const isKid = ageGroup === 'kid';
  return {
    isKid,
    allowChat: !isKid || !!(kidSettings && kidSettings.chat),
    allowVoice: !isKid || !!(kidSettings && kidSettings.voice),
  };
}

// Neoblox generates the code (shown to the player: "enter this on the Storm Royale website").
function createLinkCode(userId){
  const code = 'nb-' + crypto.randomBytes(4).toString('hex');
  linkCodes.set(code, { userId, exp: Date.now() + 15*60*1000 });
  return code;
}

// Called by Storm Royale's server (never the browser) once the player enters the code there.
function redeemLinkCode(code, storm){
  const pending = linkCodes.get(String(code||''));
  if(!pending) return { error:'That code is wrong or expired.' };
  linkCodes.delete(code);
  const u = byId.get(pending.userId);
  if(!u) return { error:'Neoblox account not found.' };
  if(u.stormUserId && String(u.stormUserId) !== String(storm.stormUserId)) byStormId.delete(String(u.stormUserId));
  u.stormUserId = String(storm.stormUserId);
  u.stormUsername = storm.stormUsername || null;
  u.stormCoinsMirror = Number(storm.coinsSeed) || 0;
  u.restricted = restrictionsFor(storm.ageGroup, storm.kidSettings);
  byStormId.set(u.stormUserId, u);
  markDirty(); saveNow();
  return { neobloxId: u.id, neobloxUsername: u.username, neobloxTokens: u.tokens || 0 };
}

function unlinkStorm(u){
  if(!u || !u.stormUserId) return;
  byStormId.delete(String(u.stormUserId));
  u.stormUserId = null; u.stormUsername = null; u.stormCoinsMirror = 0; u.restricted = null;
  markDirty(); saveNow();
}

// Storm Royale pushes its latest known Coins total (and current safety flags) for a linked
// player roughly every ~10s while they're online in-game — this just mirrors it, it's never
// the trigger for a Neoblox-side award.
function applyStormPush(stormUserId, { stormCoinsMirror, ageGroup, kidSettings }){
  const u = byStormId.get(String(stormUserId));
  if(!u) return { error:'not linked' };
  if(typeof stormCoinsMirror === 'number') u.stormCoinsMirror = Math.max(0, Math.floor(stormCoinsMirror));
  if(ageGroup) u.restricted = restrictionsFor(ageGroup, kidSettings);
  markDirty();
  return { ok:true };
}

// After Neoblox itself awards tokens (claimQuest), best-effort tell Storm Royale the new
// total so its website can show the same combined number. Fire-and-forget: if Storm Royale
// (or the network) is briefly down, the next award call tries again with the latest number —
// nothing here is load-bearing for Neoblox's own (always-authoritative) token balance.
async function pushTokensToStorm(u){
  if(!u || !u.stormUserId || !MPARADISE_LINK_KEY) return;
  try{
    const res = await fetch(STORM_ROYALE_URL + '/api/mparadise/push', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-mparadise-key': MPARADISE_LINK_KEY },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ neobloxId: u.id, neobloxTokens: u.tokens || 0 }),
    });
    if(!res.ok) console.warn('[mparadise] push to Storm Royale failed:', res.status);
  }catch(e){ console.warn('[mparadise] push to Storm Royale failed:', e.message); }
}

// Generic server-to-server call to Storm Royale's MPARADISE API (used by the cross-play squad
// relay in server.js). Same shared-secret auth as pushTokensToStorm; throws with the upstream
// error message + status so the route can pass it straight back to the Neoblox player.
async function callStorm(path, body){
  if(!MPARADISE_LINK_KEY) throw Object.assign(new Error('Cross-play isn’t set up on this server yet.'), { status: 503 });
  const res = await fetch(STORM_ROYALE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-mparadise-key': MPARADISE_LINK_KEY },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if(!res.ok) throw Object.assign(new Error((data && data.error) || ('Storm Royale ' + res.status)), { status: res.status, data });
  return data;
}

module.exports = {
  AVATARS_DIR,
  register, login, getUser, createSession, userForToken, publicUser,
  noteLogin, noteChat, noteWorldVisit, noteMove, notePartyJoin, noteGVoiceJoin, noteAvatarUpload,
  claimQuest, saveNow, markDirty,
  MPARADISE_LINK_KEY, createLinkCode, redeemLinkCode, unlinkStorm, applyStormPush, pushTokensToStorm,
  STORM_ROYALE_URL, callStorm,
};
