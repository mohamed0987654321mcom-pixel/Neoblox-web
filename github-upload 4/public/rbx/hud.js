// rbx/hud.js — the in-experience UI and camera for Neoblox worlds, NeoStudio playtests and
// Thunder Battle, laid out the way players know from big block-game platforms:
//   • top-left buttons: Menu and Chat          • chat window (with bubble chat over heads)
//   • player list with leaderstats (top right)  • health bar (shows when you're hurt)
//   • backpack hotbar (Thunder Battle weapons)  • Esc menu: Players / Settings / Help,
//     Reset Character (R), Leave (L), Resume (Esc)
//   • an orbit camera: right-drag to turn, wheel to zoom (all the way in = first person),
//     Shift = shift-lock, and your character turns to face where it walks.
// Loaded after the main game script; it only uses the game's globals (App, Net, Profile, …).
'use strict';
(function(){
  const H = window.RbxHud = {};
  const C = window.RbxCam = {};

  let root = null, menuEl = null, kind = null, data = null;
  const S = { chatOpen:true, playersOpen:true, menuOpen:false, menuTab:'players', confirmLeave:false,
              unread:0, plHtml:'', plTimer:0, battleStatKey:'', timerStopped:null };
  const chatMsgs = [];
  const bubbles = []; // { sprite, rig, until }

  const NAME_COLORS = ['#fd2943','#01a2ff','#02b857','#b480ff','#ff9a3d','#f5cd30','#ff8fc7','#d7c59a'];
  function nameColor(name){
    let h = 0; const s = String(name||'');
    for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
    return NAME_COLORS[h % NAME_COLORS.length];
  }
  const esc = (t)=> String(t==null?'':t).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function myName(){ return (Session && Session.user && Session.user.username) || Profile.name || 'Player'; }

  const ICON = {
    menu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>',
    chat:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3.5h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7.2L7 21.2V17.5H5a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3z"/></svg>',
    players:'<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 19c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6z"/><circle cx="17" cy="9" r="2.6"/><path d="M15.6 13.2c3.3-.4 6 1.6 6 5.8h-4.4c0-2.3-.6-4.3-1.6-5.8z"/></svg>',
    settings:'<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L14.9 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.4 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.9h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM12.9 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
    help:'<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 16h-2v-2h2zm2.1-7.7-.9.9c-.7.7-1.2 1.3-1.2 2.8h-2v-.5c0-1.1.5-2.1 1.2-2.8l1.2-1.3a2 2 0 1 0-3.4-1.4H8a4 4 0 1 1 7.1 2.3z"/></svg>',
  };

  // ------------------------------------------------------------------ build the DOM
  function build(){
    if(root) return;
    root = document.createElement('div');
    root.id = 'rbxRoot'; root.className = 'rbx-ui';
    root.innerHTML = `
      <div id="rbxTopbar">
        <button class="rbx-tb-btn hit" id="rbxMenuBtn" title="Menu (Esc)">${ICON.menu}</button>
        <button class="rbx-tb-btn hit active" id="rbxChatBtn" title="Chat">${ICON.chat}<span class="badge" id="rbxChatBadge"></span></button>
      </div>
      <div id="rbxTimer"></div>
      <div id="rbxHealth"><div class="fill"></div><div class="txt"></div></div>
      <div id="rbxChat" class="hit">
        <div id="rbxChatLog"></div>
        <div id="rbxChatBar">
          <input id="rbxChatInput" maxlength="200" autocomplete="off" placeholder='To chat click here or press "/" key'>
          <button id="rbxChatSend" title="Send">➤</button>
        </div>
      </div>
      <div id="rbxPlayers" class="hit"></div>
      <div id="rbxHotbar" class="hit"></div>
      <div id="rbxDeath"></div>
      <div id="rbxNotes"></div>`;
    document.body.appendChild(root);

    menuEl = document.createElement('div');
    menuEl.id = 'rbxMenu'; menuEl.className = 'rbx-ui';
    document.body.appendChild(menuEl);

    root.querySelector('#rbxMenuBtn').addEventListener('click', ()=> H.toggleMenu());
    root.querySelector('#rbxChatBtn').addEventListener('click', ()=> setChatOpen(!S.chatOpen));
    const chat = root.querySelector('#rbxChat');
    chat.addEventListener('mouseenter', ()=> chat.classList.add('hover'));
    chat.addEventListener('mouseleave', ()=> chat.classList.remove('hover'));
    const input = root.querySelector('#rbxChatInput');
    input.addEventListener('focus', ()=> chat.classList.add('focused'));
    input.addEventListener('blur', ()=> chat.classList.remove('focused'));
    input.addEventListener('keydown', (e)=>{
      e.stopPropagation();
      if(e.key==='Enter'){ sendChat(input.value); input.value=''; input.blur(); }
      else if(e.key==='Escape'){ input.value=''; input.blur(); }
    });
    root.querySelector('#rbxChatSend').addEventListener('click', ()=>{ sendChat(input.value); input.value=''; });
    menuEl.addEventListener('click', (e)=>{ if(e.target===menuEl) H.closeMenu(); });
  }

  // ------------------------------------------------------------------ show / hide
  H.show = function(k, d){
    build();
    kind = k; data = d || null;
    document.body.classList.add('rbx-exp');
    document.body.classList.toggle('rbx-studio', k==='studio-test');
    document.body.classList.toggle('rbx-battle', k==='battle');
    root.classList.add('on');
    S.timerStopped = null;
    C.reset();
    setChatOpen(S.chatOpen);
    root.querySelector('#rbxPlayers').classList.toggle('closed', !S.playersOpen);
    root.querySelector('#rbxHotbar').classList.toggle('on', k==='battle');
    root.querySelector('#rbxTimer').classList.toggle('on', k==='play' && !!(App.currentWorldData && App.currentWorldData.goal));
    root.querySelector('#rbxDeath').classList.remove('on');
    // every game starts with a fresh chat, like joining a new server
    chatMsgs.length = 0;
    const log = root.querySelector('#rbxChatLog'); if(log) log.innerHTML = '';
    S.unread = 0; updateBadge();
    const where = k==='battle' ? 'Thunder Battle' : k==='studio-test' ? 'your playtest' : ((d && d.name) || (App.currentWorldData && App.currentWorldData.name) || 'the experience');
    addMsg({ sys:true, text:'You joined '+where+'. Say hi! Type /e dance to dance.' });
    S.plHtml = ''; renderPlayers(true);
    H.onHealth();
    renderHotbar();
  };
  H.hide = function(){
    kind = null;
    document.body.classList.remove('rbx-exp','rbx-studio','rbx-battle');
    if(root) root.classList.remove('on');
    H.closeMenu(true);
    clearBubbles();
    if(C.shiftLock()) C.setShiftLock(false);
  };
  H.active = ()=> !!kind;

  // ------------------------------------------------------------------ chat
  function setChatOpen(open){
    S.chatOpen = open;
    if(!root) return;
    root.querySelector('#rbxChat').classList.toggle('closed', !open);
    root.querySelector('#rbxChatBtn').classList.toggle('active', open);
    if(open){ S.unread = 0; updateBadge(); }
  }
  function updateBadge(){
    const b = root && root.querySelector('#rbxChatBadge'); if(!b) return;
    b.textContent = S.unread > 9 ? '9+' : String(S.unread);
    b.classList.toggle('on', S.unread > 0 && !S.chatOpen);
  }
  function addMsg(m){
    if(!root) build();
    chatMsgs.push(m);
    if(chatMsgs.length > 80) chatMsgs.shift();
    const log = root.querySelector('#rbxChatLog');
    const row = document.createElement('div');
    row.className = 'rbx-msg' + (m.sys ? ' sys' : '');
    if(m.sys) row.textContent = m.text;
    else row.innerHTML = (m.tag ? '<span class="who" style="color:#cfd0d1">'+esc(m.tag)+'</span>' : '') +
      '<span class="who" style="color:'+nameColor(m.name)+'">'+esc(m.name)+':</span><span>'+esc(m.text)+'</span>';
    log.appendChild(row);
    while(log.children.length > 80) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    setTimeout(()=> row.classList.add('faded'), 30000);
    if(!S.chatOpen && !m.sys){ S.unread++; updateBadge(); }
  }
  H.addSystemMessage = (text)=> addMsg({ sys:true, text });
  function sendChat(raw){
    const text = String(raw||'').trim();
    if(!text) return;
    if(window.NeoScript) NeoScript.onChat(text); // player.Chatted in the game's scripts
    const low = text.toLowerCase();
    if(low.indexOf('/e ')===0 || low.indexOf('/emote ')===0){
      const what = low.split(/\s+/)[1];
      const map = { wave:'wave', dance:'dance', dance2:'dance', cheer:'cheer', spin:'spin', point:'wave' };
      if(map[what] && kind!=='battle'){ triggerEmote(map[what]); }
      else addMsg({ sys:true, text:'Emotes: /e wave, /e dance, /e cheer, /e spin' });
      return;
    }
    if(text[0]==='/'){
      if(typeof handleChatCommand==='function' && handleChatCommand(text)) return;
      addMsg({ sys:true, text:'Unknown command. Try /e dance' });
      return;
    }
    if(Net.connected){
      netSend({ t:'chat', scope:'game', text }); // the server echoes it back to everyone here, us included
    } else {
      addMsg({ name: myName(), text });
      if(App.player && App.player.rig) bubble(App.player.rig, text);
    }
  }
  netOn('chat', (msg)=>{
    if(!kind || !msg || typeof msg.text!=='string') return;
    if(msg.scope==='game'){
      addMsg({ name: msg.name || 'Player', text: msg.text });
      const rig = msg.from===Net.id ? (App.player && App.player.rig) : (App.remoteAvatars[msg.from] && App.remoteAvatars[msg.from].rig);
      if(rig) bubble(rig, msg.text);
    } else if(msg.scope==='party'){
      addMsg({ tag:'(Party) ', name: msg.name || 'Player', text: msg.text });
    }
  });

  // ---- bubble chat: white speech bubbles over heads, newest at the bottom, gone after a while
  function bubbleTexture(text){
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    const font = '700 30px "Nunito Sans","Segoe UI",Arial,sans-serif';
    x.font = font;
    const maxW = 460, words = String(text).slice(0,140).split(/\s+/), lines = [];
    let line = '';
    words.forEach(w=>{ const t = line ? line+' '+w : w; if(x.measureText(t).width > maxW && line){ lines.push(line); line = w; } else line = t; });
    if(line) lines.push(line);
    const shown = lines.slice(0,4);
    const w = Math.min(maxW, Math.max(...shown.map(l=>x.measureText(l).width))) + 40;
    const h = shown.length*38 + 26 + 16;
    c.width = Math.ceil(w)+8; c.height = Math.ceil(h)+8;
    const ctx = c.getContext('2d');
    ctx.font = font;
    const bw = c.width-8, bh = c.height-8-16, r = 22;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    roundRect(ctx, 6, 6, bw, bh, r); ctx.fill();
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 4, 4, bw, bh, r); ctx.fill();
    ctx.beginPath(); ctx.moveTo(c.width/2-12, bh+3); ctx.lineTo(c.width/2+12, bh+3); ctx.lineTo(c.width/2, bh+18); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1b1d1f'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    shown.forEach((l,i)=> ctx.fillText(l, c.width/2, 4 + 13 + 19 + i*38));
    const tex = new THREE.CanvasTexture(c);
    return { tex, w:c.width, h:c.height };
  }
  function roundRect(ctx, x, y, w, h, r){
    ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }
  function bubble(rig, text){
    if(!rig || !rig.group || typeof THREE==='undefined') return;
    const { tex, w, h } = bubbleTexture(text);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, depthTest:false, transparent:true }));
    const k = 1/170;
    sp.scale.set(w*k, h*k, 1);
    sp.renderOrder = 1001;
    sp.userData.h = h*k;
    rig.group.add(sp);
    // older bubbles on this rig move up to make room
    const mine = bubbles.filter(b=>b.rig===rig);
    if(mine.length >= 3){ removeBubble(mine[0]); }
    bubbles.push({ sprite:sp, rig, until: App.clockT + 9 });
    layoutBubbles(rig);
  }
  function layoutBubbles(rig){
    const base = RIG.legH + RIG.torsoH + RIG.headS + 0.75;
    let y = base;
    bubbles.filter(b=>b.rig===rig).reverse().forEach(b=>{ b.sprite.position.set(0, y + b.sprite.userData.h/2, 0); y += b.sprite.userData.h + 0.06; });
  }
  function removeBubble(b){
    const i = bubbles.indexOf(b); if(i>=0) bubbles.splice(i,1);
    if(b.sprite.parent) b.sprite.parent.remove(b.sprite);
    if(b.sprite.material.map) b.sprite.material.map.dispose();
    b.sprite.material.dispose();
  }
  function clearBubbles(){ bubbles.slice().forEach(removeBubble); }

  // ------------------------------------------------------------------ player list
  function myStats(){
    if(kind==='battle' && App.battle) return { KOs: App.battle.kills||0, Wipeouts: App.battle.deaths||0 };
    return App.leaderstats || {};
  }
  function renderPlayers(force){
    if(!root) return;
    const el = root.querySelector('#rbxPlayers');
    const mine = myStats();
    const rows = [{ name: myName(), color: Profile.shirt, stats: mine, me:true, dead: !!(App.hum && App.hum.dead) }];
    Object.entries(App.remoteAvatars||{}).forEach(([id, av])=>{
      const peer = Net.peers && Net.peers[id];
      const ps = peer && peer.pstate;
      rows.push({ name: av._name || (peer && peer.name) || 'Player', color: av.rig && av.rig.group.userData.shirtColor || '#888', stats: (ps && ps.stats) || {}, dead: !!(ps && ps.dead) });
    });
    const cols = [];
    Object.keys(mine).forEach(k=>{ if(!cols.includes(k)) cols.push(k); });
    rows.forEach(r=> Object.keys(r.stats).forEach(k=>{ if(!cols.includes(k) && cols.length<3) cols.push(k); }));
    if(cols.length){ const k0 = cols[0]; rows.sort((a,b)=> (b.me?0:0) + ((+b.stats[k0]||0) - (+a.stats[k0]||0))); }
    let html = '<div class="rbx-pl-row head"><span class="nm">People</span>' + cols.map(c=>'<span class="st">'+esc(c)+'</span>').join('') + '</div>';
    html += rows.map(r=>'<div class="rbx-pl-row'+(r.me?' me':'')+(r.dead?' dead':'')+'"><span class="ico" style="background:'+esc(r.color)+'"></span><span class="nm">'+esc(r.name)+'</span>' +
      cols.map(c=>'<span class="st">'+esc(r.stats[c]!=null ? r.stats[c] : '—')+'</span>').join('') + '</div>').join('');
    if(force || html !== S.plHtml){ el.innerHTML = html; S.plHtml = html; }
  }
  H.onLeaderstats = ()=> renderPlayers(true);

  // ------------------------------------------------------------------ health
  H.onHealth = function(){
    if(!root) return;
    const box = root.querySelector('#rbxHealth');
    const h = App.hum;
    if(!kind || kind==='battle' || !h){ box.classList.remove('on'); return; }
    const pct = Math.max(0, Math.min(100, (h.health/h.maxHealth)*100));
    box.classList.toggle('on', pct < 100);
    const fill = box.querySelector('.fill');
    fill.style.width = pct+'%';
    fill.style.background = pct > 50 ? '#27c946' : pct > 25 ? '#f5b82e' : '#e2231a';
    box.querySelector('.txt').textContent = Math.ceil(h.health) + ' / ' + h.maxHealth;
  };
  H.onDeath = function(cause){
    if(!root) return;
    const d = root.querySelector('#rbxDeath');
    d.textContent = cause==='kill' ? 'Ouch! Respawning…' : cause==='void' ? 'You fell off the map! Respawning…' : 'Respawning…';
    d.classList.add('on');
    renderPlayers(true);
  };
  H.onRespawn = function(){
    if(root) root.querySelector('#rbxDeath').classList.remove('on');
    H.onHealth(); renderPlayers(true);
  };

  // ------------------------------------------------------------------ notifications
  H.flash = function(text, title){
    if(!root) build();
    const box = root.querySelector('#rbxNotes');
    const n = document.createElement('div');
    n.className = 'rbx-note';
    n.innerHTML = (title ? '<div class="t">'+esc(title)+'</div>' : '') + esc(text);
    box.appendChild(n);
    while(box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(()=>{ n.classList.add('out'); setTimeout(()=> n.remove(), 320); }, 3800);
  };
  H.onWin = function(elapsed){
    S.timerStopped = elapsed;
    H.flash('You finished in '+elapsed+'s!', '🏆 Winner');
    const colors = ['#fd2943','#01a2ff','#02b857','#f5cd30','#b480ff','#ff9a3d'];
    for(let i=0;i<90;i++){
      const c = document.createElement('div');
      c.className = 'rbx-confetti';
      c.style.left = (Math.random()*100)+'vw';
      c.style.background = colors[i%colors.length];
      c.style.animationDuration = (2.2+Math.random()*2.2)+'s';
      c.style.animationDelay = (Math.random()*0.6)+'s';
      document.body.appendChild(c);
      setTimeout(()=> c.remove(), 5200);
    }
  };

  // ------------------------------------------------------------------ backpack (Thunder Battle)
  const WEAPON_ICON = { blaster:'🔫', shotgun:'💥', sniper:'🎯', rocket:'🚀', exotic:'⚡' };
  let hotbarKey = '';
  function renderHotbar(){
    if(!root || kind!=='battle' || !App.battle || typeof WEAPON_ORDER==='undefined') return;
    const b = App.battle;
    const key = WEAPON_ORDER.map(w=>b.owned[w]?1:0).join('') + b.weapon + (b.buildMode?'B':'');
    if(key===hotbarKey) return; hotbarKey = key;
    const bar = root.querySelector('#rbxHotbar');
    bar.innerHTML = WEAPON_ORDER.map((w,i)=>{
      const owned = !!b.owned[w];
      const sel = owned && b.weapon===w && !b.buildMode;
      return '<div class="rbx-slot'+(sel?' sel':'')+(owned?'':' empty')+'" data-i="'+i+'"><span class="k">'+(i+1)+'</span>'+(owned?WEAPON_ICON[w]||'🔫':'')+'<span class="n">'+(owned?esc(WEAPON_TYPES[w].label):'')+'</span></div>';
    }).join('') + '<div class="rbx-slot'+(b.buildMode?' sel':'')+'" data-build="1"><span class="k">B</span>🧱<span class="n">Build</span></div>';
    bar.querySelectorAll('.rbx-slot').forEach(sl=> sl.addEventListener('click', ()=>{
      if(sl.dataset.build){ battleKeydown('KeyB'); return; }
      if(b.buildMode) battleKeydown('KeyB');
      battleKeydown('Digit'+(+sl.dataset.i+1));
    }));
  }

  // ------------------------------------------------------------------ Esc menu
  H.toggleMenu = ()=> S.menuOpen ? H.closeMenu() : H.openMenu();
  H.openMenu = function(tab){
    if(!kind) return;
    build();
    S.menuOpen = true; S.confirmLeave = false;
    if(tab) S.menuTab = tab;
    App.overlayOpen = true;
    Object.keys(App.input).forEach(k=> App.input[k] = false);
    if(document.pointerLockElement){ C._selfUnlock = true; document.exitPointerLock(); }
    menuEl.classList.add('on');
    renderMenu();
  };
  H.closeMenu = function(silent){
    if(!menuEl) return;
    const was = S.menuOpen;
    S.menuOpen = false;
    menuEl.classList.remove('on');
    if(was) App.overlayOpen = false;
  };
  function renderMenu(){
    if(S.confirmLeave){
      menuEl.innerHTML = `<div class="rbx-menu-card"><div class="rbx-menu-body"><div class="rbx-confirm">
        <h3>Leave game?</h3><p>Are you sure you want to leave this experience?</p>
        <div class="rbx-menu-actions">
          <button class="rbx-big-btn danger" id="rbxDoLeave">Leave</button>
          <button class="rbx-big-btn" id="rbxNoLeave">Don't Leave</button>
        </div></div></div></div>`;
      menuEl.querySelector('#rbxDoLeave').addEventListener('click', doLeave);
      menuEl.querySelector('#rbxNoLeave').addEventListener('click', ()=>{ S.confirmLeave = false; renderMenu(); });
      return;
    }
    const tabs = [['players','Players',ICON.players],['settings','Settings',ICON.settings],['help','Help',ICON.help]];
    menuEl.innerHTML = `<div class="rbx-menu-card">
      <div class="rbx-menu-tabs">${tabs.map(t=>`<button class="rbx-menu-tab${S.menuTab===t[0]?' on':''}" data-tab="${t[0]}">${t[2]}${t[1]}</button>`).join('')}</div>
      <div class="rbx-menu-body" id="rbxMenuBody"></div>
      <div class="rbx-menu-actions">
        <button class="rbx-big-btn" id="rbxResetBtn" ${kind==='battle'?'disabled':''}><kbd>R</kbd>Reset Character</button>
        <button class="rbx-big-btn" id="rbxLeaveBtn"><kbd>L</kbd>Leave</button>
        <button class="rbx-big-btn primary" id="rbxResumeBtn"><kbd>Esc</kbd>Resume</button>
      </div></div>`;
    menuEl.querySelectorAll('.rbx-menu-tab').forEach(b=> b.addEventListener('click', ()=>{ S.menuTab = b.dataset.tab; renderMenu(); }));
    menuEl.querySelector('#rbxResetBtn').addEventListener('click', doReset);
    menuEl.querySelector('#rbxLeaveBtn').addEventListener('click', ()=>{ S.confirmLeave = true; renderMenu(); });
    menuEl.querySelector('#rbxResumeBtn').addEventListener('click', ()=> H.closeMenu());
    const body = menuEl.querySelector('#rbxMenuBody');
    if(S.menuTab==='players') renderPlayersTab(body);
    else if(S.menuTab==='settings') renderSettingsTab(body);
    else renderHelpTab(body);
  }
  function renderPlayersTab(body){
    const list = [{ id:null, name: myName(), color: Profile.shirt, me:true }];
    Object.entries(App.remoteAvatars||{}).forEach(([id, av])=> list.push({ id, name: av._name || 'Player', color: av.rig && av.rig.group.userData.shirtColor || '#888' }));
    body.innerHTML = list.map(p=>`<div class="rbx-plist-row"><span class="av" style="background:${esc(p.color)}"></span>
      <span class="nm">${esc(p.name)}${p.me?' <span class="sm">(you)</span>':''}</span>
      ${!p.me && Net.connected ? `<button class="rbx-small-btn" data-invite="${esc(p.id)}">Invite to party</button>` : ''}</div>`).join('') +
      (list.length===1 ? '<div class="sm" style="padding:14px 6px;color:#bdbebe;font-weight:700;">No one else is here yet — invite friends with a party code from the 💬 party button.</div>' : '');
    body.querySelectorAll('[data-invite]').forEach(b=> b.addEventListener('click', ()=>{
      netSend({ t:'party_invite', targetId: b.dataset.invite }); b.textContent = 'Invited!'; b.disabled = true;
    }));
  }
  function renderSettingsTab(body){
    const st = App.settings;
    body.innerHTML = `
      <div class="rbx-set-row"><div><div class="lab">Camera Sensitivity</div><div class="sub">How fast the camera turns</div></div><input type="range" id="rbxSens" min="0.2" max="3" step="0.1" value="${st.sens}"></div>
      <div class="rbx-set-row"><div><div class="lab">Volume</div><div class="sub">Game sounds</div></div><input type="range" id="rbxVol" min="0" max="1" step="0.05" value="${st.volume}"></div>
      <div class="rbx-set-row"><div><div class="lab">Shift Lock Switch</div><div class="sub">Press Shift to lock the camera behind your character</div></div><button class="rbx-switch${st.shiftLock?' on':''}" id="rbxShift"></button></div>
      <div class="rbx-set-row"><div><div class="lab">Shadows</div><div class="sub">Turn off for more speed on older devices</div></div><button class="rbx-switch${st.shadows?' on':''}" id="rbxShadows"></button></div>`;
    body.querySelector('#rbxSens').addEventListener('input', (e)=>{ st.sens = +e.target.value; saveSettings(); });
    body.querySelector('#rbxVol').addEventListener('input', (e)=>{ st.volume = +e.target.value; saveSettings(); });
    body.querySelector('#rbxVol').addEventListener('change', ()=>{ try{ SFX.click(); }catch(e){} });
    body.querySelector('#rbxShift').addEventListener('click', (e)=>{ st.shiftLock = !st.shiftLock; saveSettings(); e.currentTarget.classList.toggle('on', st.shiftLock); if(!st.shiftLock) C.setShiftLock(false); });
    body.querySelector('#rbxShadows').addEventListener('click', (e)=>{
      st.shadows = !st.shadows; saveSettings(); e.currentTarget.classList.toggle('on', st.shadows);
      if(App.sunLight) App.sunLight.castShadow = st.shadows;
    });
  }
  function renderHelpTab(body){
    const items = kind==='battle'
      ? [['Move','W A S D'],['Jump','Space'],['Look around','Click the screen, then move the mouse'],['Fire / place','Left click'],['Weapons','1 – 5'],['Build mode','B'],['Piece type','V'],['Chat','/'],['Player list','Tab'],['Menu','Esc']]
      : [['Move','W A S D'],['Jump','Space'],['Turn the camera','Hold right mouse button and drag'],['Zoom','Mouse wheel  ·  I / O'],['Shift lock','Shift'],['Emotes','/e wave · /e dance'],['Chat','/'],['Player list','Tab'],['Reset character','Esc, then R'],['Menu','Esc']];
    body.innerHTML = '<div class="rbx-help-grid">' + items.map(i=>'<div class="rbx-help-item"><span>'+esc(i[0])+'</span><kbd>'+esc(i[1])+'</kbd></div>').join('') + '</div>' +
      '<p style="color:#bdbebe;font-weight:700;margin:16px 4px 0;">Touch screens: drag the screen to look, use the joystick to move and the ▲ button to jump.</p>';
  }
  function doReset(){
    if(kind==='battle') return;
    H.closeMenu();
    if(typeof humDie==='function') humDie('reset');
  }
  function doLeave(){
    H.closeMenu();
    if(App.mode==='studio' && App.studio.testing){ stopStudioPlaytest(); return; }
    backToMenu();
  }

  // ------------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e)=>{
    if(!kind) return;
    const ae = document.activeElement;
    const typing = ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA');
    if(S.menuOpen){
      if(['Escape','KeyR','KeyL','Enter','Space'].includes(e.code)) e.preventDefault(); // don't also "click" whatever has focus
      if(e.code==='Escape'){ e.preventDefault(); if(S.confirmLeave){ S.confirmLeave=false; renderMenu(); } else H.closeMenu(); }
      else if(e.code==='KeyR' && !S.confirmLeave){ doReset(); }
      else if(e.code==='KeyL'){ if(S.confirmLeave) doLeave(); else { S.confirmLeave = true; renderMenu(); } }
      else if(e.code==='Enter' && S.confirmLeave){ doLeave(); }
      return;
    }
    if(typing) return;
    if(e.code==='Escape'){ e.preventDefault(); H.openMenu(); return; }
    if(e.code==='Slash'){ e.preventDefault(); setChatOpen(true); root.querySelector('#rbxChatInput').focus(); return; }
    if(e.code==='Tab'){ e.preventDefault(); S.playersOpen = !S.playersOpen; root.querySelector('#rbxPlayers').classList.toggle('closed', !S.playersOpen); return; }
    if(kind!=='battle'){
      // Shift on its own toggles shift-lock (on release, so Shift+F5 and friends don't trigger it)
      if(e.code==='ShiftLeft' || e.code==='ShiftRight'){ if(!e.repeat) S.shiftArmed = true; }
      else S.shiftArmed = false;
      if(e.code==='KeyI') C.zoom(-1.2);
      if(e.code==='KeyO') C.zoom(1.2);
    }
  }, true);
  window.addEventListener('keyup', (e)=>{
    if((e.code==='ShiftLeft' || e.code==='ShiftRight') && S.shiftArmed){
      S.shiftArmed = false;
      if(kind && kind!=='battle' && !S.menuOpen && App.settings.shiftLock) C.setShiftLock(!C.shiftLock());
    }
  }, true);

  // ------------------------------------------------------------------ per-frame
  H.tick = function(dt){
    if(!kind || !root) return;
    // bubbles expire
    if(bubbles.length){
      const now = App.clockT;
      bubbles.slice().forEach(b=>{ if(now > b.until || !b.rig.group.parent){ const r = b.rig; removeBubble(b); layoutBubbles(r); } });
    }
    // obby timer
    const tEl = root.querySelector('#rbxTimer');
    if(tEl.classList.contains('on')){
      const v = S.timerStopped != null ? S.timerStopped : (App.clockT - (App.playStart||App.clockT)).toFixed(1);
      tEl.textContent = '⏱ ' + v + 's';
    }
    // Thunder Battle: share KOs / Wipeouts on the leaderboard and keep the backpack in sync
    if(kind==='battle' && App.battle){
      // make room for the player list: the minimap and the kills/battle-pass box move down
      const mm = document.getElementById('bhMinimap');
      if(mm && mm.parentElement && mm.parentElement.id !== 'bhMinimapWrap') mm.parentElement.id = 'bhMinimapWrap';
      const kl = document.getElementById('bhKills');
      const box = kl && kl.parentElement && kl.parentElement.parentElement;
      if(box && box.id !== 'bhStatsWrap') box.id = 'bhStatsWrap';
      const k = (App.battle.kills||0)+':'+(App.battle.deaths||0);
      if(k !== S.battleStatKey){ S.battleStatKey = k; if(Net.connected) netSend({ t:'pstate', stats: myStats() }); renderPlayers(true); }
      renderHotbar();
    }
    const now = performance.now();
    if(now - (S.plAt||0) > 400){ S.plAt = now; renderPlayers(false); }
  };

  // other players knocked out / respawned
  netOn('pstate', (id, dead)=>{
    const av = App.remoteAvatars && App.remoteAvatars[id];
    if(!av) return;
    if(dead && !av._broken && typeof breakApartRig==='function' && humActive()){
      av._broken = true;
      breakApartRig(av.rig, null, id);
    } else if(!dead && av._broken){
      clearDebris(id);
      if(av.rig.group.parent) av.rig.group.parent.remove(av.rig.group);
      delete App.remoteAvatars[id]; // syncRemotePeers builds a fresh one next frame
    }
  });

  // ================================================================== camera
  const cam = { dist:7, min:0.6, max:24, rmb:false, lx:0, ly:0, shift:false, deadTarget:null };
  const camRay = new THREE.Raycaster();
  C.reset = ()=>{ cam.dist = 7; cam.deadTarget = null; };
  C.zoom = (d)=>{ cam.dist = Math.max(cam.min, Math.min(cam.max, cam.dist + d)); if(cam.dist < 1 && d < 0) cam.dist = cam.min; };
  C.shiftLock = ()=> cam.shift;
  C.setShiftLock = function(on){
    cam.shift = !!on;
    const canvas = document.getElementById('gamecanvas');
    if(on){ if(canvas && canvas.requestPointerLock && !isTouchDevice()) canvas.requestPointerLock(); }
    else if(document.pointerLockElement){ C._selfUnlock = true; document.exitPointerLock(); }
    setTimeout(()=>{ const x = document.getElementById('crosshair'); if(x && humActive()) x.hidden = !cam.shift; }, 0);
  };
  C.faceCharacter = function(dt, p, mv, moving){
    if(cam.shift || cam.dist < 1){ p.rig.group.rotation.y = App.yaw; return; }
    if(!moving) return;
    const want = Math.atan2(mv.x, mv.z);
    const cur = p.rig.group.rotation.y;
    const diff = Math.atan2(Math.sin(want-cur), Math.cos(want-cur));
    p.rig.group.rotation.y = cur + diff*Math.min(1, dt*14);
  };
  C.update = function(dt, p, dead){
    if(!App.camera || !p) return;
    let target;
    if(dead && cam.deadTarget) target = cam.deadTarget;
    else { target = new THREE.Vector3(p.pos.x, p.pos.y + 1.55, p.pos.z); cam.deadTarget = target.clone(); }
    const dir = camDirFromYawPitch(App.yaw, App.pitch);
    const first = cam.dist < 1 && !dead;
    let focus = target.clone();
    if(cam.shift && !first){
      const right = new THREE.Vector3(Math.sin(App.yaw-Math.PI/2), 0, Math.cos(App.yaw-Math.PI/2));
      focus.addScaledVector(right, 0.85);
    }
    let d = cam.dist;
    if(!first && App.blockGroup){
      camRay.set(focus, dir.clone().negate());
      camRay.far = d;
      const hits = camRay.intersectObjects(App.blockGroup.children, false).filter(h=>!(h.object.userData.props && (h.object.userData.props.nc || h.object.userData.props.t > 0.5)));
      if(hits.length) d = Math.max(0.5, hits[0].distance - 0.25);
    }
    const pos = first ? target.clone() : focus.clone().addScaledVector(dir, -d);
    if(worldHasBaseplate() && pos.y < 0.25) pos.y = 0.25;
    App.camera.position.copy(pos);
    App.camera.lookAt(first ? target.clone().add(dir) : focus);
    if(!dead && p.rig){
      // first person: your own body is hidden so it doesn't block the view
      p.rig.group.visible = !first;
    }
  };

  // mouse: right-drag turns the camera, the wheel zooms
  function installMouse(){
    const canvas = document.getElementById('gamecanvas');
    if(!canvas || canvas._rbxMouse) return; canvas._rbxMouse = true;
    canvas.addEventListener('mousedown', (e)=>{
      if(!humActive()) return;
      if(e.button===2){ cam.rmb = true; cam.lx = e.clientX; cam.ly = e.clientY; e.preventDefault(); }
    });
    window.addEventListener('mouseup', (e)=>{ if(e.button===2) cam.rmb = false; });
    window.addEventListener('mousemove', (e)=>{
      if(!cam.rmb || !humActive() || document.pointerLockElement) return;
      const dx = e.clientX - cam.lx, dy = e.clientY - cam.ly;
      cam.lx = e.clientX; cam.ly = e.clientY;
      const sens = App.settings ? App.settings.sens : 1;
      App.yaw -= dx * 0.0062 * sens;
      App.pitch = Math.max(-1.35, Math.min(1.1, App.pitch - dy * 0.005 * sens));
    });
    canvas.addEventListener('wheel', (e)=>{
      if(!humActive()) return;
      e.preventDefault();
      C.zoom(e.deltaY * 0.012);
    }, { passive:false });
    document.addEventListener('pointerlockchange', ()=>{
      const locked = document.pointerLockElement === canvas;
      if(locked && cam.shift && !kind){ cam.shift = false; C._selfUnlock = true; document.exitPointerLock(); return; }
      if(!locked){
        const mine = C._selfUnlock; C._selfUnlock = false;
        if(cam.shift){ cam.shift = false; const x = document.getElementById('crosshair'); if(x) setTimeout(()=>{ x.hidden = true; }, 0); }
        // Esc while the cursor was locked (shift-lock, or aiming in Thunder Battle) opens the menu
        if(!mine && kind && !S.menuOpen && (kind==='battle' || humActive())) H.openMenu();
      }
    });
  }
  document.addEventListener('DOMContentLoaded', installMouse);
  if(document.readyState !== 'loading') installMouse();
})();
