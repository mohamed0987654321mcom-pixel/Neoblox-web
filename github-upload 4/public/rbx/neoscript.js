// rbx/neoscript.js — NeoScript: Roblox-style scripting for Neoblox, written in JavaScript.
//
// Every script in a world — a Script inside a part, a Script in ServerScriptService, the script
// on an on-screen button — is plain JavaScript written against a Roblox-shaped API:
//
//   const part = script.Parent;
//   part.Touched.Connect((hit) => {
//     const humanoid = hit.Parent.FindFirstChild("Humanoid");
//     if (humanoid) humanoid.Health = 0;
//   });
//
// Safety: a published world's scripts run on everyone who plays it, so they never run in this
// page. They run inside QuickJS — a separate JavaScript engine compiled to WebAssembly
// (vendor/quickjs) — that has no window, document, network, storage or cookies. The API
// itself (rbx/neoscript-runtime.js) runs in there too; the only way out is the small set of
// host operations below, and each one checks and clamps what it's given. A CPU deadline stops
// runaway loops ("Script timeout") and a memory cap stops runaway allocations.
//
// Scripts run on each player's own device, while they're in a game or in a NeoStudio playtest.
'use strict';
(function(){
  const NS = window.NeoScript = {};
  const ENGINE_JS = 'vendor/quickjs/quickjs.js', ENGINE_WASM = 'vendor/quickjs/quickjs.wasm', RUNTIME_JS = 'rbx/neoscript-runtime.js';
  const LIMITS = { memory: 64 * 1024 * 1024, stack: 192 * 1024, bootMs: 2000, startMs: 500, frameMs: 30, strikes: 4,
                   newParts: 1500, lights: 8, gui: 40, notesPerSec: 4, chatPerSec: 4, soundsPerSec: 12, logsPerSec: 60, xp: 300 };
  const DEG = Math.PI / 180;
  const SOUNDS = ['jump','land','place','erase','portal','publish','goal','oof','checkpoint','boing','click']; // Sound.SoundId / PlayLocalSound names
  const MAT_TO_TYPE = { Plastic:'plastic', SmoothPlastic:'plastic', Fabric:'plastic', Grass:'grass', LeafyGrass:'grass', Slate:'stone', Concrete:'stone', Granite:'stone', Marble:'stone',
    Pebble:'stone', Cobblestone:'stone', Rock:'stone', Basalt:'stone', Wood:'wood', WoodPlanks:'wood', Brick:'brick', Metal:'metal', DiamondPlate:'metal', CorrodedMetal:'metal', Foil:'metal',
    Sand:'sand', Ice:'ice', Glacier:'ice', Glass:'glass', ForceField:'glass', Neon:'neon' };
  const MAT_OF_KIND = { plastic:'Plastic', grass:'Grass', stone:'Slate', wood:'Wood', brick:'Brick', metal:'Metal', sand:'Sand', ice:'Ice', glass:'Glass', neon:'Neon' };
  const SHAPE_IN = { Block:'block', Ball:'sphere', Cylinder:'cylinder', Wedge:'wedge' };
  const SHAPE_OUT = { block:'Block', sphere:'Ball', cylinder:'Cylinder', wedge:'Wedge' };
  const PLAY_IN = { None:null, KillBrick:'kill', Checkpoint:'checkpoint', JumpPad:'bounce' };
  const PLAY_OUT = { kill:'KillBrick', checkpoint:'Checkpoint', bounce:'JumpPad' };
  const fin = (v, d)=>{ const n = Number(v); return Number.isFinite(n) ? n : d; };
  const lim = (v, lo, hi, d)=> Math.min(hi, Math.max(lo, fin(v, d)));
  const vec = (a, m, d)=> Array.isArray(a) && a.length===3 ? [lim(a[0],-m,m,0), lim(a[1],-m,m,0), lim(a[2],-m,m,0)] : (d || [0,0,0]);
  const matOfType = (type)=>{ const bt = BLOCK_TYPE_BY_ID[type] || BLOCK_TYPE_BY_ID.plastic; return MAT_OF_KIND[bt.mat] || 'Plastic'; };
  const meshBehaviorOf = (m)=> m.userData.behavior !== undefined ? m.userData.behavior : blockBehavior(m.userData.blockType);

  // ------------------------------------------------------------------ engine
  let enginePromise = null;
  function loadEngine(){
    if(enginePromise) return enginePromise;
    const abs = (p)=> new URL(p, document.baseURI).href;
    const js = window.NeoQuickJS ? Promise.resolve() : new Promise((res, rej)=>{
      const s = document.createElement('script'); s.src = ENGINE_JS; s.async = true;
      s.onload = ()=> res(); s.onerror = ()=> rej(new Error('couldn\'t download the script engine'));
      document.head.appendChild(s);
    });
    enginePromise = Promise.all([
      js.then(()=> NeoQuickJS.load(abs(ENGINE_WASM))),
      fetch(RUNTIME_JS, { cache:'no-cache' }).then(r=>{ if(!r.ok) throw new Error('couldn\'t download the script runtime'); return r.text(); }),
    ]).then(([Q, src])=> ({ Q, src }));
    enginePromise.catch(()=>{ enginePromise = null; });
    return enginePromise;
  }
  NS.preload = ()=> loadEngine().catch(()=>{});

  // Syntax check for the NeoStudio editor ("Script Analysis"): compiles without running.
  let checker = null;
  NS.check = function(code){
    return loadEngine().then(({ Q })=>{
      if(!checker){ const rt = Q.newRuntime(); rt.setMemoryLimit(16 * 1024 * 1024); rt.setMaxStackSize(LIMITS.stack); const vm = rt.newContext(); checker = { rt, vm }; }
      const vm = checker.vm;
      const r = vm.evalCode('(async function(script){"use strict";' + String(code||'') + '\n})', 'check.js', { compileOnly:true });
      if(r.error){ const e = vm.dump(r.error); r.error.dispose(); return { ok:false, line: e && e.lineNumber || 1, message: (e && e.name ? e.name + ': ' : '') + (e && e.message || String(e)) }; }
      r.value.dispose();
      return { ok:true };
    }).catch((e)=> ({ ok:true, offline:true, message: e && e.message }));
  };

  // ------------------------------------------------------------------ output
  const consoleLines = [];
  function out(kind, text, meta){
    if(S){ const now = performance.now(); if(now - S.logWin > 1000){ S.logWin = now; S.logN = 0; } if(++S.logN > LIMITS.logsPerSec){ if(S.logN === LIMITS.logsPerSec + 1) out2('warn', 'Output is being throttled — a script is printing too much'); return; } }
    out2(kind, text, meta);
  }
  function out2(kind, text, meta){
    text = String(text);
    if(App.mode==='studio' && window.NeoStudioUI) NeoStudioUI.log(text, kind || '', meta);
    consoleLines.push({ kind: kind||'', text, t: new Date().toTimeString().slice(0,8) });
    if(consoleLines.length > 300) consoleLines.shift();
    if(devConsole && !devConsole.hidden) renderConsole();
    if(kind==='err' && App.mode!=='studio') updateConsoleBadge(1);
  }
  NS.log = out2;

  // ------------------------------------------------------------------ sessions
  let S = null, seq = 0;
  NS.active = ()=> !!(S && S.ready);
  // the animations scripts are playing on your character (for the avatar to draw)
  NS.anims = ()=> S && S.anims && S.anims.tracks.size ? S.anims : null;
  NS.session = ()=> S;

  // kind: 'play' (a published/built-in world) or 'studio' (NeoStudio playtest)
  NS.start = function(kind, world){
    NS.stop();
    const scripts = collectScripts(kind, world);
    App.gravMul = 1;
    // Worlds with no scripts at all don't even load the engine.
    if(!scripts.list.length) return;
    const id = ++seq;
    S = { id, kind, ready:false, queue:[], parts:new Map(), files:{}, nextRid:0, loose:new Set(), moved:new Set(), touching:new Map(), strikes:0,
          remotes:new Set(), lastPlayer:App.player, lastDead:false, lastHealth: App.hum ? App.hum.health : 100, logWin:0, logN:0, noteWin:0, noteN:0, chatWin:0, chatN:0,
          sndWin:0, sndN:0, xp:0, made:0, lights:0, gui:new Map(), guiN:0, statKeys:[], statsDirty:false, statsAt:0, sky:null, t0: App.clockT, kick:null, remoteAt:0,
          anims: window.NeoAnimate ? NeoAnimate.state() : null, animAt:0, animShared:false };
    if(kind==='studio' && window.NeoStudioUI) NeoStudioUI.log('Loading '+scripts.list.length+' script'+(scripts.list.length===1?'':'s')+'…');
    // games that save (DataStoreService) get this player's saved data loaded first, so their
    // scripts can read it straight away
    const wantsSaves = scripts.list.some(s=> /DataStore/.test(s.code));
    // …and games that sell things (MarketplaceService) get their items and what this player owns
    const wantsMarket = scripts.list.some(s=> /Marketplace/.test(s.code));
    Promise.all([loadEngine(), wantsSaves ? openSave(kind, world) : null, wantsMarket ? openMarket(kind) : null]).then(([eng, sv, mk])=>{
      if(!S || S.id !== id) return;
      S.save = sv; S.market = mk;
      if(sv) saveNotice(sv, kind);
      boot(eng, scripts);
    }).catch((e)=>{
      if(!S || S.id !== id) return;
      out2('err', 'Scripts couldn\'t start: ' + (e && e.message || e) + ' — check your connection and try again.');
      S = null;
    });
  };

  // Gather every script in the current scene: ServerScriptService, parts, on-screen buttons.
  function collectScripts(kind, world){
    const list = [];
    const worldScripts = kind==='studio' ? (App.studio.scripts || []) : normalizeWorldScripts(world && world.scripts);
    worldScripts.forEach((s, i)=>{ if(s && s.code && s.code.trim()) list.push({ where:'world', name: s.name || 'Script', code: s.code, ref: s }); });
    (App.worldMeshes || new Map()).forEach((m, key)=>{
      const sc = m.userData.script;
      if(!sc || !sc.code || !sc.code.trim()) return;
      list.push({ where:'part', mesh:m, name:'Script', code: sc.code, ref: kind==='studio' ? App.studio.blocks.get(key) : null });
    });
    (App.worldUi || []).forEach(u=>{
      if(u.kind==='button' && u.script && u.script.code && u.script.code.trim()) list.push({ where:'gui', ui:u, name:'Script', code:u.script.code, ref: kind==='studio' ? u : null });
    });
    return { list: list.slice(0, 200) };
  }

  function partRecord(m){
    const u = m.userData; const p = u.props || {};
    const rec = { rid: ++S.nextRid, mesh:m, type:u.blockType, color: p.c || numToHex((BLOCK_TYPE_BY_ID[u.blockType]||BLOCK_TYPE_BY_ID.plastic).color),
      t: p.t || 0, shape: p.s || 'block', size:[1,1,1], rot:[0, (p.r||0)*90, 0], cc: !p.nc, anchored:true, vel:[0,0,0], free:false, own:null, light:null, click:0, removed:false, gridKey: blockKey(u.gx,u.gy,u.gz) };
    u.rid = rec.rid;
    S.parts.set(rec.rid, rec);
    return rec;
  }
  function partSnapshot(rec){
    const m = rec.mesh, u = m.userData, p = u.props || {};
    const bt = BLOCK_TYPE_BY_ID[u.blockType] || BLOCK_TYPE_BY_ID.plastic;
    const beh = meshBehaviorOf(m);
    const face = p.imf || 'front';
    return { id: rec.rid, name: p.nm || bt.label, pos:[m.position.x, m.position.y, m.position.z], size: rec.size, rot: rec.rot, color: rec.color,
      material: matOfType(u.blockType), t: rec.t, cc: rec.cc, shape: SHAPE_OUT[rec.shape] || 'Block', gameplay: PLAY_OUT[beh] || 'None',
      decal: isImageId(p.im) ? { image: p.im, face: face[0].toUpperCase() + face.slice(1) } : null };
  }

  function boot(eng, scripts){
    const { Q, src } = eng;
    let rt, vm;
    try{
      rt = Q.newRuntime();
      rt.setMemoryLimit(LIMITS.memory);
      rt.setMaxStackSize(LIMITS.stack);
      S.deadline = performance.now() + LIMITS.bootMs;
      // Past the deadline: stop whatever is running, then give a short grace period so the
      // runtime can report the timeout before the next interrupt.
      rt.setInterruptHandler(()=>{
        if(!S || performance.now() <= S.deadline) return false;
        S.deadline = performance.now() + 15;
        S.hitDeadline = true;
        return true;
      });
      vm = rt.newContext();
      S.rt = rt; S.vm = vm;
      const hostFn = vm.newFunction('__host', (opH, dataH)=>{
        let res;
        try{ res = hostOp(vm.getString(opH), dataH ? vm.getString(dataH) : ''); }
        catch(e){ res = JSON.stringify({ __err: String(e && e.message || e) }); }
        return res === undefined ? undefined : vm.newString(res);
      });
      vm.setProp(vm.global, '__host', hostFn);
      hostFn.dispose();
      const r = vm.evalCode(src, 'neoscript-runtime.js');
      if(r.error){ const e = vm.dump(r.error); r.error.dispose(); throw new Error('runtime failed: ' + (e && e.message || e)); }
      r.value.dispose();
      const nb = vm.getProp(vm.global, '__nb');
      S.fn = {};
      ['init','addScript','run','join','step','event'].forEach(k=>{ S.fn[k] = vm.getProp(nb, k); });
      nb.dispose();
      const del = vm.evalCode('delete globalThis.__nb;'); if(del.error) del.error.dispose(); else del.value.dispose();
    }catch(e){
      out2('err', 'Scripts couldn\'t start: ' + (e && e.message || e));
      teardownVm({ rt, vm, fn: S && S.fn });
      S = null;
      return;
    }

    // the world as the scripts see it
    const parts = [];
    (App.worldMeshes || new Map()).forEach(m=>{ parts.push(partSnapshot(partRecord(m))); });
    S.initialParts = S.parts.size;
    // on-screen labels/buttons: a private copy, so scripts can change them without touching the build
    App.worldUi = (App.worldUi || []).map(u=> Object.assign({}, u));
    App.worldUi.forEach(u=> S.gui.set(u.id, u));
    renderWorldUi();
    const ui = App.worldUi.map(u=>({ id:u.id, kind:u.kind, text:u.text, x:u.xPct, y:u.yPct, img:u.img, w:u.w }));
    const player = { name: Profile.name || 'Player', userId: userIdOf(Profile.id) };
    const studio = S.kind==='studio';
    S.deadline = performance.now() + LIMITS.bootMs;
    callGuest('init', [JSON.stringify({ parts, ui, player, studio, touch: !!(window.isTouchDevice && isTouchDevice()) })]);
    if(!S) return;

    // start every script: compile it (syntax errors are reported with their line), then run it
    const ridOfMesh = (m)=> m && m.userData.rid;
    scripts.list.forEach((s, i)=>{
      if(!S) return;
      const file = '__nbs' + (i+1) + '__';
      const info = { file, name: s.name };
      let label = 'ServerScriptService.' + s.name;
      if(s.where==='part'){ info.part = ridOfMesh(s.mesh); const p = s.mesh.userData.props || {}; label = 'Workspace.' + (p.nm || (BLOCK_TYPE_BY_ID[s.mesh.userData.blockType]||{}).label || 'Part') + '.Script'; }
      if(s.where==='gui'){ info.gui = s.ui.id; label = 'StarterGui.TextButton.Script'; }
      S.files[file] = { label, ref: s.ref, where: s.where };
      S.deadline = performance.now() + LIMITS.startMs;
      const sc = callGuest('addScript', [JSON.stringify(info)], true);
      if(!sc) return;
      // strict mode: a misspelled variable is an error instead of a silent new global
      const c = vm.evalCode('(async function(script){"use strict";' + s.code + '\n})', file);
      if(c.error){
        const e = vm.dump(c.error); c.error.dispose(); sc.dispose();
        out('err', label + ':' + (e && e.lineNumber || 1) + ': ' + (e && e.name ? e.name + ': ' : '') + (e && e.message || e), metaFor(file, e && e.lineNumber || 1));
        return;
      }
      S.deadline = performance.now() + LIMITS.startMs;
      callGuest('run', [c.value, sc]);
      c.value.dispose(); sc.dispose();
      pump();
    });
    if(!S) return;
    S.deadline = performance.now() + LIMITS.startMs;
    callGuest('join', []);
    pump();
    if(!S) return;
    S.ready = true;
    S.strikes = 0;
    // developer products bought earlier that the game never handed out: give them another go
    if(S.market) S.market.receipts.forEach(r=> queue({ t:'receipt', r }));
    if(studio) out2('ok', 'Scripts running');
  }

  // Call one of the runtime's entry points. Strings/numbers are passed in; handles as-is.
  function callGuest(name, args, keep){
    if(!S || !S.vm) return null;
    const vm = S.vm;
    const made = [];
    const hs = args.map(a=>{
      if(typeof a === 'string'){ const h = vm.newString(a); made.push(h); return h; }
      if(typeof a === 'number'){ const h = vm.newNumber(a); made.push(h); return h; }
      return a;
    });
    const s = S;
    s.inGuest = true;
    let r;
    try{ r = vm.callFunction(s.fn[name], vm.undefined, ...hs); }
    catch(e){ s.inGuest = false; made.forEach(h=> h.dispose()); fatal(e); return null; }
    s.inGuest = false;
    made.forEach(h=> h.dispose());
    if(r.error){ if(S === s) guestError(r.error); r.error.dispose(); return null; }
    if(keep) return r.value;
    r.value.dispose();
    return null;
  }
  function pump(){
    if(!S || !S.rt) return;
    const s = S;
    s.inGuest = true;
    let r;
    try{ r = s.rt.executePendingJobs(-1); }
    catch(e){ s.inGuest = false; fatal(e); return; }
    s.inGuest = false;
    if(r.error){ if(S === s) guestError(r.error); r.error.dispose(); }
  }
  // An error that escaped the runtime itself (the API catches script errors) — usually a timeout.
  function guestError(h){
    let e; try{ e = S.vm.dump(h); }catch(err){ e = { message: String(err) }; }
    const msg = e && e.message || String(e);
    const st = e && e.stack || '';
    const m = /(__nbs\d+__):(\d+)/.exec(st);
    const f = m && S.files[m[1]];
    const where = f ? f.label + ':' + m[2] + ': ' : '';
    if(/interrupted/.test(msg)){
      S.hitDeadline = true;
      out('err', where + 'Script timeout: exhausted allowed execution time — add "await wait()" inside long loops', m ? metaFor(m[1], +m[2]) : null);
    } else if(/out of memory/i.test(msg)){
      out('err', where + 'Out of memory — a script is making too many things');
    } else {
      out('err', where + (e && e.name && e.name!=='Error' ? e.name + ': ' : '') + msg, m ? metaFor(m[1], +m[2]) : null);
    }
  }
  function fatal(e){
    out2('err', 'The script engine crashed and scripts were stopped (' + (e && e.message || e) + ')');
    if(window.NeoQuickJS && NeoQuickJS.reset) NeoQuickJS.reset();
    enginePromise = null; checker = null;
    const s = S; S = null;
    if(s){ s.rt = null; s.vm = null; if(s.save) flushSave(s.save, true); if(s.animShared && Net.connected) netSend({ t:'anim', tracks:[] }); } // a crashed engine can't be cleaned up safely; let it go
  }

  // What the Output window needs to open the script an error came from, at that line.
  function metaFor(file, line){ const f = S && S.files[file]; return f && f.ref ? { ref: f.ref, where: f.where, line: line || 1 } : null; }

  function teardownVm(s){
    if(!s) return;
    try{
      if(s.fn) Object.values(s.fn).forEach(h=>{ if(h && h.alive) h.dispose(); });
      if(s.vm) s.vm.dispose();
      if(s.rt) s.rt.dispose();
    }catch(e){
      // the engine refused to shut down cleanly — start the next game on a fresh copy of it
      if(window.NeoQuickJS && NeoQuickJS.reset) NeoQuickJS.reset();
      enginePromise = null; checker = null;
    }
  }
  NS.stop = function(quiet){
    if(!S) return;
    const s = S;
    if(!s.inGuest) farewell(s, quiet);
    S = null;
    if(s.animShared && Net.connected) netSend({ t:'anim', tracks:[] }); // your animations stop for everyone
    if(s.inGuest){ if(s.save) flushSave(s.save, true); return; } // never free an engine mid-call; it's dropped instead
    teardownVm(s);
    App.gravMul = 1;
    const c = document.getElementById('gamecanvas'); if(c && c.style.cursor==='pointer') c.style.cursor = '';
  };

  // ------------------------------------------------------------------ paid items (MarketplaceService)
  // A game's game passes / developer products (made by its creator in NeoStudio → 🛒 Paid Items),
  // what this player already owns, and purchases the game still has to hand out. In a NeoStudio
  // playtest purchases are only pretend: nothing is charged and nothing is kept.
  let mkTestSeq = 0;
  function openMarket(kind){
    const wid = kind === 'studio' ? App.studio.worldId : App.currentWorldId;
    const world = wid !== null && wid !== undefined && /^\d{1,12}$/.test(String(wid)) ? String(wid) : null;
    const mk = { test: kind === 'studio', world, token: Session.token || null, items:new Map(), owned:new Set(), receipts:[], creator:false, open:false, promptAt:[] };
    if(!world || !window.NeoMarket) return Promise.resolve(mk);
    const within = (p)=> Promise.race([p.catch(()=> null), new Promise(r=> setTimeout(()=> r(null), 8000))]);
    return Promise.all([within(NeoMarket.items(world, true)), !mk.test && mk.token ? within(NeoMarket.mine(world)) : null]).then(([list, mine])=>{
      ((list && list.items) || []).forEach(i=> mk.items.set(String(i.id), i));
      mk.creator = !!(list && list.creator);
      if(mine){ (mine.passes || []).forEach(id=> mk.owned.add(String(id))); mk.receipts = (mine.receipts || []).slice(0, 20); }
      if(!list) out2('warn', 'Couldn\'t load this game\'s paid items — buying is off for now');
      return mk;
    });
  }

  // ------------------------------------------------------------------ game saves (DataStoreService)
  // A player's saved data for one game: { "<DataStore name>": { "<key>": value } }. Logged in, it
  // lives on their account (server.js /api/saves) and follows them to every device; logged out,
  // it stays in this browser. A NeoStudio playtest saves in this browser too, apart from the real
  // game's saves. Changes are written a couple of seconds after a script makes them (and right
  // away when the player leaves); a copy in this browser keeps progress safe if the tab closes or
  // the internet drops before the server has it, and it's sent on the next visit.
  const SAVE_MAX = 50000, SAVE_FLUSH_MS = 2000;
  const SAVES = new Set(); // saves with changes still being written — kept until they're written, even after the game ends
  const isTable = (v)=> !!v && typeof v === 'object' && !Array.isArray(v);
  function u8(str){ let n = str.length; for(let i = 0; i < str.length; i++) if(str.charCodeAt(i) > 127) n += 2; return n; } // never less than the UTF-8 size
  function saveSlotFor(kind, world){
    if(kind === 'studio') return { key: 'nb_save_test_' + (App.studio.worldId || 'draft'), test:true };
    const wid = App.currentWorldId !== null && App.currentWorldId !== undefined ? String(App.currentWorldId) : '';
    const token = Session.token || null;
    const who = Session.user ? 'u' + Session.user.id : token ? 't' + userIdOf(token) : 'guest';
    const game = wid || ('local-' + userIdOf((world && world.name) || 'world'));
    return { key: 'nb_save_' + who + '_' + game, server: !!token && /^\d{1,12}$/.test(wid), world: wid, token };
  }
  function readBackup(key){ try{ const t = localStorage.getItem(key); const b = t ? JSON.parse(t) : null; return b && isTable(b.d) ? b : null; }catch(e){ return null; } }
  function writeBackup(sv){ try{ localStorage.setItem(sv.slot.key, JSON.stringify({ d: sv.data, dirty: sv.unsynced, base: sv.base })); }catch(e){} }
  function newSave(slot){
    return { slot, data:{}, sizes:new Map(), bytes:2, ok:false, err:null, changed:false, unsynced:false, base:0, timer:0, inflight:false, again:false, fails:0, warned:false,
             sid: Math.random().toString(36).slice(2, 10) + Date.now().toString(36), rev:0 };
  }
  function useData(sv, data){
    sv.data = {}; sv.sizes = new Map(); sv.bytes = 2;
    Object.keys(isTable(data) ? data : {}).forEach(s=>{
      const st = data[s]; if(!isTable(st)) return;
      const keys = Object.keys(st); if(!keys.length) return;
      const sc = u8(JSON.stringify(s)) + 3;
      sv.data[s] = st; sv.sizes.set(s + '\u0000', sc); sv.bytes += sc;
      keys.forEach(k=>{ const add = u8(JSON.stringify(k)) + u8(JSON.stringify(st[k])) + 2; sv.sizes.set(s + '\u0000' + k, add); sv.bytes += add; });
    });
  }
  function openSave(kind, world){
    const slot = saveSlotFor(kind, world);
    // still writing this same save from a moment ago (left and came right back)? carry on with it
    for(const old of SAVES) if(old.ok && old.slot.key === slot.key && old.slot.token === slot.token) return Promise.resolve(old);
    const sv = newSave(slot);
    const b = readBackup(slot.key);
    if(!slot.server){ useData(sv, b && b.d); sv.ok = true; return Promise.resolve(sv); }
    const ctl = window.AbortController ? new AbortController() : null;
    const to = setTimeout(()=>{ if(ctl) ctl.abort(); }, 8000);
    return fetch('/api/saves/' + slot.world, { headers:{ Authorization: 'Bearer ' + slot.token }, cache:'no-store', signal: ctl ? ctl.signal : undefined })
      .then(r=> r.json().catch(()=> null).then(j=>{ if(!r.ok) throw new Error(j && j.error || ('the server said ' + r.status)); return j; }))
      .then(j=>{
        sv.base = j && j.updatedAt || 0;
        // progress from last time that never reached the server (tab closed, offline) — used
        // unless the save has changed since then (played on another device in the meantime)
        if(b && b.dirty && (b.base || 0) >= sv.base){ useData(sv, b.d); sv.unsynced = true; sv.changed = true; }
        else useData(sv, j && j.data);
        sv.ok = true;
        if(sv.changed){ SAVES.add(sv); scheduleSave(sv, 500); }
        return sv;
      })
      .catch(e=>{ sv.err = e && e.name === 'AbortError' ? 'the server didn\'t answer' : (e && e.message || String(e)); return sv; })
      .then(v=>{ clearTimeout(to); return v; });
  }
  function saveNotice(sv, kind){
    if(!sv.ok){ out2('warn', 'Couldn\'t load your saved progress (' + sv.err + ') — this game won\'t save until you play it again.'); if(kind !== 'studio') showToast('⚠️ Couldn\'t load your saved progress — this game won\'t save right now'); return; }
    if(kind === 'studio') out2('', '💾 Playtest saves stay on this computer, just for testing — Test → Clear Saves starts fresh.');
    else if(!sv.slot.server && !sv.slot.token) showToast('💾 This game saves your progress on this device — log in to keep it everywhere');
  }
  function saveFor(){
    const sv = S.save;
    if(!sv) throw new Error('DataStoreService isn\'t available in this game');
    if(!sv.ok) throw new Error('Couldn\'t load saved data (' + sv.err + ') — saving is off until the game is played again');
    return sv;
  }
  function saveChanged(sv){ sv.changed = true; if(sv.slot.server) sv.unsynced = true; SAVES.add(sv); scheduleSave(sv); }
  function scheduleSave(sv, ms){ if(sv.timer) return; sv.timer = setTimeout(()=>{ sv.timer = 0; flushSave(sv); }, ms === undefined ? SAVE_FLUSH_MS : ms); }
  function saveWarn(sv, msg){
    out2('warn', 'Your progress couldn\'t be saved: ' + msg);
    if(!sv.warned && !sv.slot.test){ sv.warned = true; showToast('⚠️ Your progress couldn\'t be saved — ' + msg); }
  }
  // Write the save now: to this browser, then (logged in) to the server. `leaving` = the page
  // may be about to close, so the request is sent so that it finishes even then.
  function flushSave(sv, leaving){
    if(!sv || !sv.ok) return;
    if(sv.timer && leaving){ clearTimeout(sv.timer); sv.timer = 0; }
    if(!sv.changed) return;
    writeBackup(sv);
    if(!sv.slot.server){ sv.changed = false; SAVES.delete(sv); return; }
    if(sv.dead) return;
    if(sv.inflight && !leaving){ sv.again = true; return; }
    const rev = ++sv.rev;
    const body = JSON.stringify({ data: sv.data, sid: sv.sid, rev });
    sv.changed = false; sv.inflight = true; sv.again = false;
    fetch('/api/saves/' + sv.slot.world, { method:'PUT', headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + sv.slot.token }, body, keepalive: !!leaving && body.length < 63000 })
      .then(r=> r.json().catch(()=> null).then(j=>({ r, j })))
      .then(({ r, j })=>{
        sv.inflight = false;
        if(r.ok){
          sv.fails = 0;
          if(j && j.updatedAt) sv.base = Math.max(sv.base, j.updatedAt);
          if(rev === sv.rev && !sv.changed){ sv.unsynced = false; writeBackup(sv); SAVES.delete(sv); }
        } else if(r.status === 429 || r.status >= 500){
          retrySave(sv);
        } else {
          // 401/403/404/413: trying again won't help; what was saved in this browser is kept
          sv.dead = true; SAVES.delete(sv);
          saveWarn(sv, r.status === 401 ? 'log in again to keep saving' : (j && j.error || 'the server said ' + r.status));
          return;
        }
        if(sv.again || sv.changed){ sv.changed = true; scheduleSave(sv); }
      }, ()=>{ sv.inflight = false; retrySave(sv); });
  }
  function retrySave(sv){
    sv.changed = true; sv.fails++;
    if(sv.fails === 3) saveWarn(sv, 'no connection — it\'ll keep trying');
    scheduleSave(sv, Math.min(60000, 2000 * Math.pow(2, sv.fails)));
  }
  // The player is leaving this game: PlayerRemoving + game.BindToClose run (a script's last
  // chance to save), then the save is written. quiet = the scripts were stopped for misbehaving,
  // so they don't get to run again.
  function farewell(s, quiet){
    if(!s || s.left) return;
    s.left = true;
    if(!quiet && s.ready && s.vm && S === s){
      s.leaving = true;
      s.deadline = performance.now() + 250;
      callGuest('event', [JSON.stringify({ t:'leave' })]);
      if(S === s) pump();
    }
    if(s.save) flushSave(s.save, true);
  }
  // NeoStudio → Test → Clear Saves: forget what playtests of this build have saved
  NS.clearTestSaves = function(){
    const key = 'nb_save_test_' + (App.studio.worldId || 'draft');
    SAVES.forEach(sv=>{ if(sv.slot.key === key){ if(sv.timer) clearTimeout(sv.timer); SAVES.delete(sv); } });
    if(S && S.save && S.save.slot.key === key){ useData(S.save, {}); S.save.changed = false; }
    try{ localStorage.removeItem(key); }catch(e){}
  };
  NS.flushSaves = function(){ if(S && S.save) flushSave(S.save, true); SAVES.forEach(sv=> flushSave(sv, true)); };
  // closing the tab or switching away: write what's waiting (and say goodbye if the tab is closing)
  window.addEventListener('pagehide', ()=>{ if(S) farewell(S); NS.flushSaves(); });
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'hidden') NS.flushSaves(); });

  // ------------------------------------------------------------------ per frame
  // Called every frame while playing (before the avatar moves): runs waits, tweens and
  // RunService events, then delivers queued events (touches, clicks, keys…).
  NS.step = function(dt){
    if(!S || !S.ready) return;
    S.moved.forEach(rec=>{ if(rec.mesh.userData.carry) rec.mesh.userData.carry.set(0,0,0); });
    S.moved.clear();
    pollState();
    S.deadline = performance.now() + LIMITS.frameMs;
    S.hitDeadline = false;
    const q = S.queue; S.queue = [];
    for(const ev of q){ callGuest('event', [JSON.stringify(ev)]); if(!S) return; }
    callGuest('step', [App.clockT - S.t0, dt]);
    if(!S) return;
    pump();
    if(!S) return;
    if(S.anims){
      NeoAnimate.step(S.anims, dt);
      // others in the game see your animations (a few times a second at most, only when they change)
      if(S.anims.dirty && S.kind === 'play' && Net.connected && App.clockT - S.animAt > 0.2){
        S.anims.dirty = false; S.animAt = App.clockT; S.animShared = true;
        netSend({ t:'anim', tracks: NeoAnimate.toNet(S.anims) });
      }
    }
    stepLoose(dt);
    if(S.hitDeadline){
      if(++S.strikes >= LIMITS.strikes){ out2('err', 'Scripts were stopped: a script kept running without ever waiting. Use "await wait()" inside loops.'); NS.stop(true); return; }
    } else S.strikes = 0;
    if(S.statsDirty && App.clockT - S.statsAt > 0.4){ S.statsDirty = false; S.statsAt = App.clockT; if(Net.connected) netSend({ t:'pstate', stats: App.leaderstats || {} }); }
    // leave the game after this frame is done, never in the middle of it
    if(S.kick !== null){ const msg = S.kick; S.ready = false; setTimeout(()=> doKick(msg), 0); }
  };
  function queue(ev){ if(S && S.ready && S.queue.length < 400) S.queue.push(ev); }

  function pollState(){
    const p = App.player, h = App.hum;
    if(p !== S.lastPlayer){ if(S.lastPlayer && p) queue({ t:'respawn' }); S.lastPlayer = p; S.touching = new Map(); S.lastDead = false; }
    if(h){
      if(h.dead && !S.lastDead) queue({ t:'died' });
      S.lastDead = h.dead;
      if(h.health !== S.lastHealth){ S.lastHealth = h.health; queue({ t:'health', h: h.health }); }
    }
    if(App.clockT - S.remoteAt > 0.5){
      S.remoteAt = App.clockT;
      const now = new Set(Object.keys(App.remoteAvatars || {}));
      now.forEach(id=>{ if(!S.remotes.has(id)){ const av = App.remoteAvatars[id]; queue({ t:'padd', id, name: String(av && av._name || 'Player').slice(0, 24), userId: userIdOf(id) }); } });
      S.remotes.forEach(id=>{ if(!now.has(id)) queue({ t:'prem', id }); });
      S.remotes = now;
    }
  }

  // Touched / TouchEnded for the local player's character, from the same contact test that drives
  // kill bricks and checkpoints. Called right after the avatar moves.
  NS.touches = function(p){
    if(!S || !S.ready || !p) return;
    const h = App.hum;
    const now = new Map();
    if(h && !h.dead) touchedPartsAt(p.pos).forEach(t=>{ const rid = t.mesh.userData.rid; if(rid && !now.has(rid)) now.set(rid, t.below ? 'Left Leg' : 'Torso'); });
    now.forEach((limb, rid)=>{ if(!S.touching.has(rid)) queue({ t:'touch', id:rid, limb }); });
    S.touching.forEach((limb, rid)=>{ if(!now.has(rid)) queue({ t:'untouch', id:rid, limb }); });
    S.touching = now;
  };
  NS.guiClick = (id)=> queue({ t:'gui', id });
  // VR: a laser from a controller. Returns the clickable part it points at (and clicks it when
  // `click`), or null. Same reach rules as clicking with the mouse.
  const RAY = new THREE.Raycaster();
  NS.rayPick = function(origin, dir, click){
    if(!S || !S.ready || !App.blockGroup || !App.player) return null;
    let any = false; S.parts.forEach(r=>{ if(r.click && !r.removed) any = true; });
    if(!any) return null;
    RAY.set(origin, dir); RAY.far = 60;
    const hit = RAY.intersectObjects(App.blockGroup.children.filter(m=> m.visible), false)[0];
    if(!hit) return null;
    const rec = S.parts.get(hit.object.userData.rid);
    if(!rec || !rec.click || App.player.pos.distanceTo(hit.point) > rec.click + 1.5) return null;
    if(click) queue({ t:'click', id: rec.rid });
    return { point: hit.point, distance: hit.distance };
  };
  // VR controller buttons for scripts: Enum.KeyCode.ButtonA/B/X/Y, ButtonL1/R1 (grips), ButtonL2/R2 (triggers)
  NS.vrButton = (key, down)=> queue({ t:'input', key, down: !!down, kind:'Gamepad1' });
  NS.onChat = (text)=> queue({ t:'chat', text: String(text||'').slice(0, 200) });

  // Unanchored parts fall and land on whatever is under them.
  function stepLoose(dt){
    if(!S.loose.size) return;
    const g = GRAVITY * (App.gravMul ?? 1);
    S.loose.forEach(rec=>{
      if(rec.removed){ S.loose.delete(rec); return; }
      const m = rec.mesh, u = m.userData;
      rec.vel[1] -= g * dt;
      const old = m.position.clone();
      m.position.x += rec.vel[0]*dt; m.position.z += rec.vel[2]*dt;
      let ny = m.position.y + rec.vel[1]*dt;
      const floor = floorUnder(rec, m.position.x, m.position.z, old.y - u.hy);
      if(ny - u.hy <= floor && old.y - u.hy >= floor - 0.05){
        ny = floor + u.hy; rec.vel[1] = 0;
        rec.vel[0] *= Math.max(0, 1 - 6*dt); rec.vel[2] *= Math.max(0, 1 - 6*dt);
      }
      m.position.y = ny;
      if(m.position.y < -80){ rec.vel = [0,0,0]; m.position.y = -80; S.loose.delete(rec); }
      markMoved(rec, old);
    });
  }
  function floorUnder(self, x, z, bottom){
    let top = (worldHasBaseplate() && insideBuildArea({ x, z })) ? 0 : -999;
    App.worldMeshes.forEach(m=>{
      if(m === self.mesh) return;
      const u = m.userData;
      if(u.props && u.props.nc) return;
      let t, inCol;
      if(u.free){ inCol = Math.abs(x - m.position.x) <= u.hx && Math.abs(z - m.position.z) <= u.hz; t = m.position.y + u.hy; }
      else { inCol = u.gx===Math.floor(x) && u.gz===Math.floor(z); t = u.gy + 1; }
      if(inCol && t <= bottom + 0.6 && t > top) top = t;
    });
    return top;
  }

  // ------------------------------------------------------------------ parts on the host
  const TMP_BOX = new THREE.Box3();
  function updateExtents(rec){
    const m = rec.mesh, u = m.userData, g = m.geometry;
    m.updateMatrixWorld(true);
    if(!g.boundingBox) g.computeBoundingBox();
    TMP_BOX.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
    u.hx = (TMP_BOX.max.x - TMP_BOX.min.x) / 2;
    u.hy = (TMP_BOX.max.y - TMP_BOX.min.y) / 2;
    u.hz = (TMP_BOX.max.z - TMP_BOX.min.z) / 2;
  }
  // A part a script has moved, resized or turned is no longer on the build grid: it collides as
  // a box at its real position instead (see columnTopAt / touchedPartsAt).
  function freeify(rec){
    const m = rec.mesh, u = m.userData;
    if(!rec.free){
      if(App.worldMeshes.get(rec.gridKey) === m) App.worldMeshes.delete(rec.gridKey);
      App.worldMeshes.set('f' + rec.rid, m);
      u.free = true; rec.free = true;
    }
    updateExtents(rec);
  }
  function markMoved(rec, old){
    const u = rec.mesh.userData;
    if(!u.carry) u.carry = new THREE.Vector3();
    u.carry.x += rec.mesh.position.x - old.x; u.carry.y += rec.mesh.position.y - old.y; u.carry.z += rec.mesh.position.z - old.z;
    S.moved.add(rec);
  }
  function own(rec){
    if(rec.own) return;
    const m = rec.mesh, seen = new Map();
    const cl = (mat)=>{ if(!seen.has(mat)){ const c = mat.clone(); c.userData = {}; seen.set(mat, c); } return seen.get(mat); };
    m.material = Array.isArray(m.material) ? m.material.map(cl) : cl(m.material);
    rec.own = Array.from(seen.values());
  }
  function dropOwn(rec){ if(rec.own){ rec.own.forEach(x=> x.dispose()); rec.own = null; } }
  function kindOf(rec){ return (BLOCK_TYPE_BY_ID[rec.type] || BLOCK_TYPE_BY_ID.plastic).mat; }
  function recolor(rec){
    own(rec);
    const c = hexToNum(rec.color);
    const neon = kindOf(rec)==='neon';
    rec.own.forEach(mt=>{ mt.color.setHex(c); if(neon && mt.emissive) mt.emissive.setHex(c); });
    rec.mesh.userData.props = Object.assign({}, rec.mesh.userData.props, { c: rec.color });
  }
  function refade(rec){
    own(rec);
    const a = Math.min(1, rec.t), k = kindOf(rec);
    const cap = k==='glass' ? 0.45 : k==='ice' ? 0.82 : 1;
    rec.own.forEach(mt=>{
      const want = a > 0 || k==='glass' || k==='ice';
      if(mt.transparent !== want){ mt.transparent = want; mt.needsUpdate = true; }
      mt.opacity = Math.min(1 - a, cap);
      mt.depthWrite = !(a > 0.05) && k!=='glass';
    });
    rec.mesh.visible = a < 0.999;
    rec.mesh.castShadow = a < 0.6;
  }
  function restyle(rec){
    const m = rec.mesh;
    dropOwn(rec);
    const mats = partMaterials(rec.type, rec.color, Math.min(rec.t, 0.95));
    m.geometry = partGeometry(rec.shape);
    m.material = (rec.shape==='block' || rec.shape==='wedge') ? mats.box : mats.single;
    m.userData.blockType = rec.type;
    m.userData.props = Object.assign({}, m.userData.props, { c: rec.color });
    if(rec.t > 0.95) refade(rec); else { m.visible = true; m.castShadow = rec.t < 0.6; }
  }
  function setProp(rec, k, v){
    const m = rec.mesh, u = m.userData;
    switch(k){
      case 'Position': {
        const p = vec(v, 5000); const old = m.position.clone();
        m.position.set(p[0], p[1], p[2]);
        u.gx = Math.floor(p[0]); u.gy = Math.floor(p[1]); u.gz = Math.floor(p[2]);
        freeify(rec); markMoved(rec, old);
        break;
      }
      case 'Size': {
        rec.size = vec(v, 512).map(n=> Math.max(0.05, n));
        m.scale.set(rec.size[0], rec.size[1], rec.size[2]);
        freeify(rec);
        break;
      }
      case 'Orientation': {
        rec.rot = vec(v, 1e6);
        m.rotation.set(rec.rot[0]*DEG, rec.rot[1]*DEG, rec.rot[2]*DEG, 'YXZ');
        freeify(rec);
        break;
      }
      case 'Color': { const c = hexToNum(v); if(c===null) return; rec.color = numToHex(c); recolor(rec); break; }
      case 'Transparency': { rec.t = lim(v, 0, 1, 0); refade(rec); break; }
      case 'Material': {
        const type = MAT_TO_TYPE[v] || 'plastic';
        if(u.behavior === undefined) u.behavior = blockBehavior(u.blockType); // keep a kill brick deadly when its look changes
        rec.type = type; restyle(rec);
        if(rec.t > 0) refade(rec);
        break;
      }
      case 'Shape': { rec.shape = SHAPE_IN[v] || 'block'; restyle(rec); if(rec.t > 0) refade(rec); if(rec.free) updateExtents(rec); break; }
      case 'CanCollide': { rec.cc = !!v; u.props = Object.assign({}, u.props, { nc: rec.cc ? undefined : true }); break; }
      case 'Anchored': {
        rec.anchored = !!v;
        if(rec.anchored) S.loose.delete(rec); else { freeify(rec); S.loose.add(rec); }
        break;
      }
      case 'Velocity': { rec.vel = vec(v, 300); break; }
      case 'Gameplay': { u.behavior = v in PLAY_IN ? PLAY_IN[v] : null; break; }
      case 'CastShadow': { m.castShadow = !!v && rec.t < 0.6; break; }
    }
  }
  function removePartMesh(rec){
    const m = rec.mesh;
    if(m.parent) m.parent.remove(m);
    if(App.worldMeshes.get(rec.gridKey) === m) App.worldMeshes.delete(rec.gridKey);
    if(App.worldMeshes.get('f' + rec.rid) === m) App.worldMeshes.delete('f' + rec.rid);
    S.loose.delete(rec);
    S.touching.delete(rec.rid);
    if(rec.light){ S.lights--; rec.light = null; }
    rec.removed = true;
  }
  function buildPart(rec, props){
    rec.type = MAT_TO_TYPE[props.Material] || 'plastic';
    const c = hexToNum(props.Color); rec.color = c===null ? '#a3a2a5' : numToHex(c);
    rec.t = lim(props.Transparency, 0, 1, 0);
    rec.shape = SHAPE_IN[props.Shape] || 'block';
    rec.size = vec(props.Size, 512, [1,1,1]).map(n=> Math.max(0.05, n));
    rec.rot = vec(props.Orientation, 1e6);
    rec.cc = props.CanCollide !== false;
    rec.anchored = props.Anchored !== false;
    const m = makeBlockMesh(rec.type, { c: rec.color, s: rec.shape==='block' ? undefined : rec.shape, nc: rec.cc ? undefined : true });
    const p = vec(props.Position, 5000);
    m.position.set(p[0], p[1], p[2]);
    m.scale.set(rec.size[0], rec.size[1], rec.size[2]);
    m.rotation.set(rec.rot[0]*DEG, rec.rot[1]*DEG, rec.rot[2]*DEG, 'YXZ');
    m.userData.gx = Math.floor(p[0]); m.userData.gy = Math.floor(p[1]); m.userData.gz = Math.floor(p[2]);
    m.userData.rid = rec.rid;
    m.userData.behavior = props.Gameplay in PLAY_IN ? PLAY_IN[props.Gameplay] : null;
    rec.mesh = m; rec.own = null; rec.free = false; rec.removed = false; rec.gridKey = '';
    App.blockGroup.add(m);
    freeify(rec);
    if(rec.t > 0) refade(rec);
    if(!rec.anchored) S.loose.add(rec);
  }

  // ------------------------------------------------------------------ host operations
  function rate(win, n, max){ const now = performance.now(); if(now - S[win] > 1000){ S[win] = now; S[n] = 0; } return ++S[n] <= max; }
  const OPS = {
    log(d){ if(d.timeout) S.hitDeadline = true; out(d.kind==='err' ? 'err' : d.kind==='warn' ? 'warn' : '', String(d.text||'').slice(0, 2000), d.file ? metaFor(d.file, +d.line||0) : null); },
    'part.new'(d){
      let rec = d.id ? S.parts.get(d.id) : null;
      if(rec && !rec.removed) removePartMesh(rec);
      if(!rec){
        if(S.made >= LIMITS.newParts) throw new Error('Too many parts — scripts can add up to ' + LIMITS.newParts);
        S.made++;
        rec = { rid: ++S.nextRid, mesh:null, vel:[0,0,0], light:null, click:0 };
        S.parts.set(rec.rid, rec);
      }
      if(!App.blockGroup) throw new Error('The world isn\'t loaded');
      buildPart(rec, d.props || {});
      return { id: rec.rid };
    },
    'part.set'(d){ const rec = S.parts.get(d.id); if(rec && !rec.removed) setProp(rec, String(d.k), d.v); },
    'part.remove'(d){ const rec = S.parts.get(d.id); if(rec && !rec.removed) removePartMesh(rec); },
    'part.get'(d){ const rec = S.parts.get(d.id); if(!rec) return null; const p = rec.mesh.position; return { pos:[p.x,p.y,p.z], vel: rec.vel.slice() }; },
    'char.get'(){
      const p = App.player, h = App.hum;
      if(!p) return { pos:null };
      return { pos:[p.pos.x, p.pos.y, p.pos.z], vel:[0, p.vel.y, 0], health: h ? h.health : 100, max: h ? h.maxHealth : 100, dead: !!(h && h.dead),
               ws: 16 * (h && h.walkMul !== undefined ? h.walkMul : 1), jp: 50 * (h && h.jumpMul !== undefined ? h.jumpMul : 1) };
    },
    'char.set'(d){
      const p = App.player, h = App.hum;
      if(!p || !h) return;
      if(d.max !== undefined){ h.maxHealth = lim(d.max, 1, 1e6, 100); if(h.health > h.maxHealth) h.health = h.maxHealth; if(window.RbxHud) RbxHud.onHealth(); }
      if(h.dead) return;
      if(d.pos){ const v = vec(d.pos, 5000); p.pos.set(v[0], v[1], v[2]); p.vel.set(0,0,0); p.grounded = false; if(p.rig) p.rig.group.position.copy(p.pos); }
      if(d.vel){ const v = vec(d.vel, 300); p.vel.y = v[1]; if(v[1] > 0) p.grounded = false; h.knock = (v[0] || v[2]) ? { x:v[0], z:v[2] } : null; }
      if(d.ws !== undefined) h.walkMul = lim(d.ws, 0, 200, 16) / 16;
      if(d.jp !== undefined) h.jumpMul = lim(d.jp, 0, 400, 50) / 50;
      if(d.jump && p.grounded){ p.vel.y = JUMP_SPEED * (h.jumpMul ?? 1); p.grounded = false; SFX.jump(); }
      if(d.damage !== undefined) humDamage(lim(d.damage, 0, 1e6, 0), 'script');
      if(d.health !== undefined){
        const n = lim(d.health, 0, h.maxHealth, h.health);
        if(n <= 0) humDie('script');
        else { h.health = n; if(window.RbxHud) RbxHud.onHealth(); }
      }
    },
    'pl.get'(d){ const av = App.remoteAvatars && App.remoteAvatars[d.id]; if(!av) return { pos:null }; const g = av.rig.group.position; return { pos:[g.x, g.y, g.z], health:100, max:100, ws:16, jp:50 }; },
    'player.kick'(d){ if(!S.leaving) S.kick = String(d.msg||'').slice(0, 200); },
    'player.respawn'(){ if(App.hum) humRespawn(); },
    'player.spawnat'(d){
      if(d.clear){ App.checkpoint = null; return; }
      const rec = S.parts.get(d.id); if(!rec || rec.removed) return;
      const m = rec.mesh, u = m.userData;
      const top = rec.free ? m.position.y + u.hy : u.gy + 1;
      App.checkpoint = { x: Math.floor(m.position.x), y: top, z: Math.floor(m.position.z) };
    },
    'player.xp'(d){
      const n = Math.min(lim(d.n, 0, 100, 0), LIMITS.xp - S.xp);
      if(n > 0 && typeof battlePassAddXp === 'function'){ S.xp += n; battlePassAddXp(Math.floor(n)); }
    },
    stats(d){
      const next = {};
      Object.keys(d || {}).slice(0, 6).forEach(k=>{ const v = d[k]; const key = String(k).replace(/[<>]/g,'').slice(0, 20); if(!key) return; next[key] = typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v*100)/100 : 0) : String(v).slice(0, 30); });
      if(!App.leaderstats) App.leaderstats = {};
      S.statKeys.forEach(k=>{ if(!(k in next)) delete App.leaderstats[k]; });
      Object.assign(App.leaderstats, next);
      S.statKeys = Object.keys(next);
      if(window.RbxHud) RbxHud.onLeaderstats();
      S.statsDirty = true;
    },
    notify(d){
      if(!rate('noteWin', 'noteN', LIMITS.notesPerSec)) return;
      const text = String(d.text||'').slice(0, 200), title = String(d.title||'').slice(0, 80);
      if(window.RbxHud && RbxHud.active && RbxHud.active()) RbxHud.flash(text, title || undefined); else showToast((title ? title + ' — ' : '') + text);
    },
    chat(d){
      if(!rate('chatWin', 'chatN', LIMITS.chatPerSec)) return;
      const text = String(d.text||'').slice(0, 200);
      if(window.RbxHud && RbxHud.addSystemMessage) RbxHud.addSystemMessage(text);
    },
    sound(d){
      if(!rate('sndWin', 'sndN', LIMITS.soundsPerSec)) return;
      const name = String(d.name||'').toLowerCase().replace(/^rbxasset(id)?:\/\/(sounds\/)?/, '').replace(/\.(mp3|ogg|wav)$/, '').trim();
      if(SOUNDS.includes(name) && typeof SFX[name] === 'function') SFX[name]();
    },
    'gui.new'(d){
      const pr = d.props || {};
      let u = d.id ? S.gui.get(d.id) : null;
      if(!u){
        if(S.gui.size >= LIMITS.gui) throw new Error('Too many on-screen labels/buttons (' + LIMITS.gui + ' max)');
        u = { id: 'sg' + (++S.guiN), kind: pr.kind==='button' ? 'button' : pr.kind==='image' ? 'image' : 'label', script:null };
        S.gui.set(u.id, u);
      }
      applyGui(u, pr);
      if(!App.worldUi.includes(u)) App.worldUi.push(u);
      renderWorldUi();
      return { id: u.id };
    },
    'gui.set'(d){ const u = S.gui.get(d.id); if(!u) return; applyGui(u, d.props || {}); if(!patchGui(u)) renderWorldUi(); },
    'gui.remove'(d){ const u = S.gui.get(d.id); if(!u) return; const i = App.worldUi.indexOf(u); if(i >= 0) App.worldUi.splice(i, 1); renderWorldUi(); },
    // a Decal: a picture on one face of a part (key tells several decals on one part apart)
    decal(d){
      const rec = S.parts.get(d.id); if(!rec || rec.removed) return;
      const m = rec.mesh, key = String(d.key || 'w').slice(0, 20);
      m.children.filter(c=> c.userData.decalKey === key).forEach(c=>{ m.remove(c); if(c.material && !c.material.userData.keep) c.material.dispose(); });
      if(d.clear || !isImageId(d.image)) return;
      if(m.children.filter(c=> c.userData.decalKey).length >= 6) return;
      const dm = addDecal(m, d.image, String(d.face||'front'), key);
      if(dm && +d.t > 0){ dm.material = dm.material.clone(); dm.material.userData = {}; dm.material.opacity = 1 - lim(d.t, 0, 1, 0); }
    },
    clickable(d){ const rec = S.parts.get(d.id); if(rec) rec.click = d.on ? lim(d.dist, 0, 1000, 32) || 0.001 : 0; },
    light(d){
      const rec = S.parts.get(d.id); if(!rec || rec.removed) return;
      // switching a light off just dims it: adding/removing lights makes every material recompile
      if(!d.on){ if(rec.light) rec.light.intensity = 0; return; }
      if(!rec.light){ if(S.lights >= LIMITS.lights) return; rec.light = new THREE.PointLight(0xffffff, 1, 8); rec.mesh.add(rec.light); S.lights++; }
      const c = hexToNum(d.color); rec.light.color.setHex(c===null ? 0xffffff : c);
      rec.light.intensity = lim(d.b, 0, 40, 1) * 0.8; rec.light.distance = lim(d.r, 0, 60, 8);
    },
    lighting(d){
      const c = lim(d.clock, 0, 24, 14);
      const sky = (c < 6 || c >= 18.5) ? 'night' : (c < 7.5 || c >= 17) ? 'sunset' : 'day';
      if(sky !== S.sky){ S.sky = sky; applySky(sky); }
    },
    gravity(d){ App.gravMul = lim(d.g, 0, 1000, 196.2) / 196.2; },
    'uis.vr'(){ return { v: !!(window.NeoVR && NeoVR.active()) }; },
    // AnimationTrack on your own character (drawn by rbx/animate.js, and sent to others)
    'anim.play'(d){ if(S.anims) NeoAnimate.play(S.anims, d); },
    'anim.stop'(d){ if(S.anims) NeoAnimate.stop(S.anims, d.id, d.fade); },
    'anim.set'(d){ if(S.anims) NeoAnimate.set(S.anims, d.id, d); },
    // MarketplaceService: what an item is, whether you own a pass, and Neoblox's own buy window
    'mk.info'(d){
      const i = S.market && S.market.items.get(String(d.id));
      return i ? { id:i.id, kind:i.kind, name:i.name, desc:i.desc, price:i.price, image:i.image, onSale:i.onSale } : undefined;
    },
    'mk.owns'(d){ return { v: !!(S.market && S.market.owned.has(String(d.id))) }; },
    'mk.prompt'(d){
      const mk = S.market;
      if(!mk || S.leaving || !window.NeoMarket) return;
      if(mk.open || NeoMarket.isOpen()) return; // one at a time
      const now = performance.now();
      mk.promptAt = mk.promptAt.filter(t=> now - t < 10000);
      if(mk.promptAt.length >= 3){ out('warn', 'A script is opening the buy window too often — it was skipped'); return; }
      mk.promptAt.push(now);
      const id = String(d.id), kind = d.kind === 'product' ? 'product' : 'pass';
      const found = mk.items.get(id), item = found && found.kind === kind ? found : null;
      if(!item) out('warn', 'This game has no ' + (kind === 'pass' ? 'game pass' : 'developer product') + ' with id ' + id + (mk.test ? ' — make one in 🛒 Paid Items (publish your game first)' : ''));
      mk.open = true;
      const s = S;
      setTimeout(()=>{
        NeoMarket.prompt({ item, kind, test: mk.test, creator: mk.creator, owned: kind === 'pass' && mk.owned.has(id), onDone: (bought, res)=>{
          mk.open = false;
          if(S !== s || !s.ready) return; // the game ended meanwhile (a purchase is still kept for next time)
          if(bought && kind === 'pass') mk.owned.add(id);
          queue({ t:'mkdone', kind, id, bought: !!bought });
          if(bought && kind === 'product'){
            const r = res && res.receipt ? res.receipt : { id: 'test' + (++mkTestSeq), item: id, price: 0 };
            mk.receipts.push(r);
            queue({ t:'receipt', r });
          }
        } });
      }, 0);
    },
    'mk.granted'(d){
      const mk = S.market, rid = String(d.rid || '');
      if(!mk) return;
      mk.receipts = mk.receipts.filter(r=> r.id !== rid);
      if(mk.test || !mk.token || !/^[a-f0-9]{16}$/.test(rid)) return;
      fetch(netHttpBase() + '/api/market/receipts/' + rid + '/granted', { method:'POST', headers:{ Authorization: 'Bearer ' + mk.token }, keepalive:true }).catch(()=>{});
    },
    // DataStoreService: the runtime has already checked keys and values; sizes are checked here
    'ds.get'(d){
      const sv = saveFor(), st = sv.data[String(d.s)], k = String(d.k);
      return st && Object.prototype.hasOwnProperty.call(st, k) ? { v: st[k] } : {};
    },
    'ds.set'(d){
      const sv = saveFor(), s = String(d.s||'').slice(0, 101), k = String(d.k||'');
      if(!s || !k || k.length > 50) throw new Error('bad DataStore key');
      const vj = JSON.stringify(d.v === undefined ? null : d.v);
      const add = u8(JSON.stringify(k)) + u8(vj) + 2;
      const storeCost = sv.data[s] ? 0 : u8(JSON.stringify(s)) + 3;
      const id = s + '\u0000' + k;
      const next = sv.bytes - (sv.sizes.get(id) || 0) + add + storeCost;
      if(next > SAVE_MAX) throw new Error('This game\'s save is full — each player can save up to 50 KB per game');
      if(!sv.data[s]){ sv.data[s] = {}; sv.sizes.set(s + '\u0000', storeCost); }
      sv.data[s][k] = JSON.parse(vj);
      sv.sizes.set(id, add); sv.bytes = next;
      saveChanged(sv);
    },
    'ds.remove'(d){
      const sv = saveFor(), s = String(d.s), k = String(d.k), st = sv.data[s];
      if(!st || !Object.prototype.hasOwnProperty.call(st, k)) return {};
      const old = st[k], id = s + '\u0000' + k;
      delete st[k];
      sv.bytes -= sv.sizes.get(id) || 0; sv.sizes.delete(id);
      if(!Object.keys(st).length){ delete sv.data[s]; sv.bytes -= sv.sizes.get(s + '\u0000') || 0; sv.sizes.delete(s + '\u0000'); }
      saveChanged(sv);
      return { v: old };
    },
    raycast(d){
      if(!App.blockGroup) return null;
      const o = vec(d.o, 5000), dir = vec(d.d, 5000);
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      if(!(len > 0)) return null;
      const ray = new THREE.Raycaster(new THREE.Vector3(o[0], o[1], o[2]), new THREE.Vector3(dir[0]/len, dir[1]/len, dir[2]/len), 0, Math.min(len, 2000));
      const ignore = new Set(Array.isArray(d.ignore) ? d.ignore.slice(0, 500) : []);
      const targets = App.blockGroup.children.filter(m=> m.userData && !ignore.has(m.userData.rid));
      if(App.groundMesh && App.groundMesh.visible) targets.push(App.groundMesh);
      const hit = ray.intersectObjects(targets, false)[0];
      if(!hit) return null;
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0,1,0);
      return { id: hit.object.userData.rid || 0, pos:[hit.point.x, hit.point.y, hit.point.z], normal:[n.x, n.y, n.z], dist: hit.distance };
    },
  };
  function hostOp(op, data){
    if(!S) throw new Error('scripts are stopped');
    const f = OPS[op];
    if(!f) throw new Error('unknown operation ' + op);
    const r = f(data ? JSON.parse(data) : {});
    return r === undefined ? undefined : JSON.stringify(r);
  }
  function applyGui(u, pr){
    if(pr.kind && !u.kind) u.kind = pr.kind==='button' ? 'button' : 'label';
    if(pr.text !== undefined) u.text = String(pr.text).slice(0, 200);
    if(pr.x !== undefined) u.xPct = lim(pr.x, -50, 150, 50);
    if(pr.y !== undefined) u.yPct = lim(pr.y, -50, 150, 50);
    u.hidden = pr.visible === false;
    u.tc = hexToNum(pr.tc) === null ? null : numToHex(hexToNum(pr.tc));
    u.bg = hexToNum(pr.bg) === null ? null : numToHex(hexToNum(pr.bg));
    u.ts = pr.ts ? lim(pr.ts, 6, 72, 0) : 0;
    if(u.kind === 'image'){
      if(pr.img !== undefined) u.img = isImageId(pr.img) ? pr.img : null;
      if(pr.w !== undefined) u.w = lim(pr.w, 16, 800, 160);
    }
  }
  function patchGui(u){
    const layer = document.getElementById('worldUiLayer'); if(!layer) return false;
    const el = Array.from(layer.children).find(e=> e.dataset.uid === u.id);
    if(!el) return false;
    if(u.kind !== 'image') el.textContent = String(u.text||'');
    styleWorldUiEl(el, u);
    return true;
  }

  // Lighting.ClockTime: swap the sky live (day / sunset / night).
  function applySky(sky){
    const P = SKY_PRESETS[sky]; if(!P || !App.scene) return;
    App.scene.background = new THREE.Color(P.fog);
    if(App.scene.fog) App.scene.fog.color.setHex(P.fog);
    if(App.skyDome){ App.skyDome.material.map = makeSkyDomeTexture(sky); App.skyDome.material.needsUpdate = true; }
    App.scene.children.forEach(o=>{
      if(o.isHemisphereLight){ o.color.setHex(P.hemiSky); o.groundColor.setHex(P.hemiGround); o.intensity = P.hemiI; }
      if(o.isSprite && o.material && o.material.map === sunDiscTexture()) o.visible = sky !== 'night';
    });
    if(App.sunLight){ App.sunLight.color.setHex(P.sun); App.sunLight.intensity = P.sunI; }
  }

  function doKick(msg){
    NS.stop();
    const text = 'You were kicked from this experience' + (msg ? ': ' + msg : '');
    if(App.mode==='studio' && App.studio.testing){ stopStudioPlaytest(); if(window.NeoStudioUI) NeoStudioUI.log(text, 'warn'); return; }
    backToMenu();
    showToast(text);
  }
  function userIdOf(s){ let h = 7; String(s||'').split('').forEach(c=>{ h = (h * 31 + c.charCodeAt(0)) % 2147483647; }); return h; }

  // ------------------------------------------------------------------ input: clicks, hover, keys
  const KEYMAP = { Space:'Space', Enter:'Return', Tab:'Tab', Backspace:'Backspace', ShiftLeft:'LeftShift', ShiftRight:'RightShift', ControlLeft:'LeftControl', ControlRight:'RightControl',
    AltLeft:'LeftAlt', AltRight:'RightAlt', ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right', F1:'F1', F2:'F2', F3:'F3', F4:'F4' };
  const DIGITS = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine'];
  function keyName(code){
    if(/^Key[A-Z]$/.test(code)) return code.slice(3);
    const d = /^(?:Digit|Numpad)(\d)$/.exec(code); if(d) return DIGITS[+d[1]];
    return KEYMAP[code] || null;
  }
  function typing(){ const ae = document.activeElement; return !!(ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA' || ae.isContentEditable)); }
  const RC = new THREE.Raycaster();
  function pickClickable(e){
    if(!S || !S.ready || !App.blockGroup || !App.camera) return null;
    let any = false; S.parts.forEach(r=>{ if(r.click && !r.removed) any = true; });
    if(!any) return null;
    const c = document.getElementById('gamecanvas'); const rect = c.getBoundingClientRect();
    const ndc = document.pointerLockElement ? { x:0, y:0 } : { x: ((e.clientX - rect.left)/rect.width)*2 - 1, y: -((e.clientY - rect.top)/rect.height)*2 + 1 };
    RC.setFromCamera(ndc, App.camera);
    const hit = RC.intersectObjects(App.blockGroup.children.filter(m=> m.visible), false)[0];
    if(!hit) return null;
    const rec = S.parts.get(hit.object.userData.rid);
    if(!rec || !rec.click || !App.player) return null;
    if(App.player.pos.distanceTo(hit.point) > rec.click + 1.5) return null;
    return rec;
  }
  function install(){
    const c = document.getElementById('gamecanvas');
    if(!c || c._nsWired) return; c._nsWired = true;
    let down = null, lastHover = 0;
    c.addEventListener('pointerdown', (e)=>{
      if(!S || !S.ready) return;
      down = { x:e.clientX, y:e.clientY, t:performance.now(), b:e.button };
      if(e.button===0) queue({ t:'input', down:true, kind: e.pointerType==='touch' ? 'Touch' : 'MouseButton1', x:e.clientX, y:e.clientY });
      if(e.button===2) queue({ t:'input', down:true, kind:'MouseButton2', x:e.clientX, y:e.clientY });
    });
    c.addEventListener('pointerup', (e)=>{
      if(!S || !S.ready || !down) return;
      const d = down; down = null;
      if(d.b===0) queue({ t:'input', down:false, kind: e.pointerType==='touch' ? 'Touch' : 'MouseButton1', x:e.clientX, y:e.clientY });
      if(d.b===2) queue({ t:'input', down:false, kind:'MouseButton2', x:e.clientX, y:e.clientY });
      if(d.b!==0 || Math.hypot(e.clientX-d.x, e.clientY-d.y) > 8 || performance.now()-d.t > 600) return;
      const rec = pickClickable(e);
      if(rec) queue({ t:'click', id: rec.rid });
    });
    c.addEventListener('pointermove', (e)=>{
      if(!S || !S.ready || e.pointerType==='touch' || e.buttons) return;
      const now = performance.now(); if(now - lastHover < 80) return; lastHover = now;
      const rec = pickClickable(e);
      if(rec) c.style.cursor = 'pointer'; else if(c.style.cursor==='pointer') c.style.cursor = '';
    });
    const key = (down)=> (e)=>{
      if(!S || !S.ready || e.repeat || typing()) return;
      const k = keyName(e.code); if(!k) return;
      queue({ t:'input', down, kind:'Keyboard', key:k });
    };
    window.addEventListener('keydown', key(true));
    window.addEventListener('keyup', key(false));
    window.addEventListener('keydown', (e)=>{
      if(e.code==='F9' && App.mode!=='boot' && App.mode!=='lobby'){ e.preventDefault(); toggleConsole(); }
    });
  }

  // ------------------------------------------------------------------ developer console (F9)
  let devConsole = null;
  function buildConsole(){
    devConsole = document.createElement('div');
    devConsole.id = 'nsConsole'; devConsole.className = 'ns-console interactive'; devConsole.hidden = true;
    devConsole.innerHTML = '<div class="ns-con-head"><b>Developer Console</b><span>Output from this game\'s scripts</span><button type="button" data-x="clear">Clear</button><button type="button" data-x="close" aria-label="Close">✕</button></div><div class="ns-con-body"></div>';
    devConsole.querySelector('[data-x=close]').addEventListener('click', ()=>{ devConsole.hidden = true; });
    devConsole.querySelector('[data-x=clear]').addEventListener('click', ()=>{ consoleLines.length = 0; renderConsole(); });
    document.body.appendChild(devConsole);
  }
  function renderConsole(){
    const body = devConsole.querySelector('.ns-con-body');
    body.textContent = '';
    consoleLines.slice(-200).forEach(l=>{
      const row = document.createElement('div'); row.className = 'ns-con-line ' + l.kind;
      const t = document.createElement('span'); t.className = 't'; t.textContent = l.t;
      row.appendChild(t); row.appendChild(document.createTextNode(l.text));
      body.appendChild(row);
    });
    body.scrollTop = body.scrollHeight;
  }
  function toggleConsole(){
    if(!devConsole) buildConsole();
    devConsole.hidden = !devConsole.hidden;
    if(!devConsole.hidden){ renderConsole(); updateConsoleBadge(0, true); }
  }
  NS.toggleConsole = toggleConsole;
  let errCount = 0;
  function updateConsoleBadge(add, reset){ errCount = reset ? 0 : errCount + (add||0); }
  NS.errorCount = ()=> errCount;

  // ------------------------------------------------------------------ old command scripts → JavaScript
  // Worlds made before scripts were JavaScript used a few line-by-line commands (say "hi",
  // color #ff0000, wait 1…). They're rewritten as the same thing in JavaScript when loaded.
  NS.convertLegacy = function(code, event){
    const button = event === 'click';
    const body = [];
    const q = (s)=> JSON.stringify(String(s));
    const text = (a)=>{ const m = String(a).match(/^["'](.*)["']$/); return (m ? m[1] : String(a)).slice(0, 120); };
    const keep = (line, why)=> body.push('// ' + line + (why ? '   (' + why + ')' : ''));
    String(code||'').split('\n').slice(0, 60).forEach(raw=>{
      const line = raw.trim().replace(/;$/, '');
      if(!line){ if(body.length && body[body.length-1] !== '') body.push(''); return; }
      if(line.startsWith('//') || line.startsWith('--')){ body.push('// ' + line.replace(/^(\/\/|--)\s?/, '')); return; }
      let cmd, args;
      const fn = line.match(/^(\w+)\s*\((.*)\)$/);
      if(fn){ cmd = fn[1].toLowerCase(); args = fn[2].trim(); }
      else { const m = line.match(/^(\w+)\s*(.*)$/); if(!m){ keep(line, 'not a command'); return; } cmd = m[1].toLowerCase(); args = m[2].trim(); }
      const n = (d)=>{ const v = parseFloat(String(args).replace(/[()"']/g, '')); return Number.isFinite(v) ? v : d; };
      const partOnly = ()=>{ if(button){ keep(line, 'only works in a part\'s script'); return false; } return true; };
      switch(cmd){
        case 'say': body.push('game.StarterGui.SetCore("SendNotification", { Title: "", Text: ' + q(text(args)) + ' });'); break;
        case 'print': body.push('print(' + q(text(args)) + ');'); break;
        case 'color': { const c = hexToNum(text(args).trim()); if(c===null){ keep(line, 'not a color'); break; } if(partOnly()) body.push('part.Color = Color3.fromHex("' + numToHex(c) + '");'); break; }
        case 'changecolor': {
          const t = args.replace(/["'()]/g, '').trim().toLowerCase(); const bt = BLOCK_TYPE_BY_ID[t];
          if(!bt){ keep(line, 'unknown material'); break; }
          if(!partOnly()) break;
          body.push('part.Material = "' + (MAT_OF_KIND[bt.mat] || 'Plastic') + '";');
          if(bt.behavior){ body.push('part.Color = Color3.fromHex("' + numToHex(bt.color) + '");'); body.push('part.Gameplay = "' + PLAY_OUT[bt.behavior] + '";'); }
          break;
        }
        case 'transparency': if(partOnly()) body.push('part.Transparency = ' + clamp(n(0), 0, 0.95) + ';'); break;
        case 'destroy': if(partOnly()) body.push('part.Destroy();'); break;
        case 'checkpoint': if(partOnly()){ body.push('player.RespawnLocation = part;'); body.push('game.StarterGui.SetCore("SendNotification", { Title: "", Text: "🚩 Checkpoint saved" });'); } break;
        case 'teleport': {
          const p = args.replace(/[()]/g, '').split(',').map(s=> parseFloat(s.trim()));
          if(p.length===3 && p.every(Number.isFinite)) body.push('player.Character.MoveTo(new Vector3(' + (p[0]+0.5) + ', ' + (p[1]+1.3) + ', ' + (p[2]+0.5) + '));');
          else keep(line, 'needs x, y, z');
          break;
        }
        case 'jump': body.push('player.Character.HumanoidRootPart.AssemblyLinearVelocity = new Vector3(0, ' + clamp(n(12), 0, 40) + ', 0);'); break;
        case 'heal': body.push('player.Character.Humanoid.Health += ' + clamp(Math.round(n(0)), 0, 100) + ';'); break;
        case 'damage': body.push('player.Character.Humanoid.TakeDamage(' + clamp(Math.round(n(0)), 0, 100) + ');'); break;
        case 'kill': body.push('player.Character.Humanoid.Health = 0;'); break;
        case 'givexp': body.push('player.GiveXP(' + clamp(Math.round(n(0)), 0, 100) + ');'); break;
        case 'playsound': body.push('game.SoundService.PlayLocalSound(' + q(args.replace(/["'()]/g, '').trim().toLowerCase()) + ');'); break;
        case 'wait': body.push('await wait(' + clamp(n(0), 0, 5) + ');'); break;
        default: keep(line, 'unknown command');
      }
    });
    while(body.length && body[body.length-1] === '') body.pop();
    const inner = body.map(l=> l ? '  ' + l : '').join('\n');
    const head = '// Converted from the old NeoStudio commands to JavaScript.\n';
    if(button) return head + 'const button = script.Parent;\n\nbutton.MouseButton1Click.Connect(async () => {\n  const player = game.Players.LocalPlayer;\n' + inner + '\n});\n';
    return head + 'const part = script.Parent;\n\npart.Touched.Connect(async (hit) => {\n  const player = game.Players.GetPlayerFromCharacter(hit.Parent);\n  if (!player) return;\n' + inner + '\n});\n';
  };

  // where a script's errors point (for the Output window's "open at line" links)
  NS.refOfFile = (file)=> S && S.files[file] ? S.files[file] : null;

  document.addEventListener('DOMContentLoaded', install);
  if(document.readyState !== 'loading') install();
})();
