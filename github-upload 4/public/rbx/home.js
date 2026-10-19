// rbx/home.js — the Neoblox home: browse and launch experiences (tiles with live 3D thumbnails,
// a page per game with a big Play button, thumbs up/down, visits and who's playing), see who's
// online, edit your Avatar, buy items in the Avatar Shop with tokens, do quests, and Create.
// Loaded after the main game script; it drives the game's own launch functions.
'use strict';
(function(){
  const NH = window.NeoHome = {};
  const $ = (q, r)=> (r||document).querySelector(q);
  const $$ = (q, r)=> Array.from((r||document).querySelectorAll(q));
  const esc = (t)=> String(t==null?'':t).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n)=>{ n = +n||0; if(n>=1e6) return (n/1e6).toFixed(n>=1e7?0:1)+'M'; if(n>=1e3) return (n/1e3).toFixed(n>=1e4?0:1)+'K'; return String(n); };
  const ago = (ts)=>{ if(!ts) return '—'; const d = (Date.now()-ts)/1000; if(d<3600) return Math.max(1,Math.round(d/60))+'m ago'; if(d<86400) return Math.round(d/3600)+'h ago'; if(d<86400*30) return Math.round(d/86400)+'d ago'; return new Date(ts).toLocaleDateString(); };
  const COIN = '<span class="nh-coin">N</span>';
  const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';

  let page = 'home', sortMode = 'popular', shopKind = 'all', avTab = 'body', search = '';
  let community = [];   // published worlds from the server
  let stats = {};       // game key -> { visits, up, down, playing, myVote }
  let shop = [];        // Avatar Shop catalog (from the server)
  let currentKey = null;

  const BUILTIN = [
    { key:'lobby', name:'Neoblox Lobby', creator:'Neoblox', genre:'Hangout', builtin:true, max:50, created: Date.UTC(2026,8,1),
      desc:'The Neoblox hangout. Walk the avenue, meet people from all over, start a party, jump into voice chat and show off your avatar.\n\nPortals in the lobby take you to every Neoblox experience.' },
    { key:'sky', name:'Sky Rush', creator:'Neoblox', genre:'Obby', builtin:true, max:30, created: Date.UTC(2026,8,1),
      desc:'A classic obby high above the clouds! Hop across stepping stones, cross the lava run, ride the jump pad up the tower, balance on the beam and brave the glass bridge.\n\nCheckpoints save your stage. Touch the red bricks and it\'s back to your last checkpoint!' },
    { key:'battle', name:'Thunder Battle', creator:'Neoblox', genre:'Battle Royale', builtin:true, max:20, created: Date.UTC(2026,8,20),
      desc:'Drop from the battle bus, grab weapons from loot crates, build walls and ramps, and stay inside the storm circle.\n\nRounds last 3 minutes — most KOs wins!' },
  ];
  function gameByKey(k){ return BUILTIN.find(g=>g.key===k) || community.find(g=>g.key===k) || null; }
  function allGames(){ return BUILTIN.concat(community); }
  function st(k){ return stats[k] || { visits:0, up:0, down:0, playing:0, myVote:0 }; }
  function rating(k){ const s = st(k); const t = s.up + s.down; return t ? Math.round(100*s.up/t) : null; }

  // ------------------------------------------------------------------ data
  async function loadCommunity(){
    try{
      let rows = [];
      if(typeof Net!=='undefined' && Net.connected){
        const r = await fetch(netHttpBase()+'/api/worlds?order=createdAt&limit=100');
        rows = r.ok ? await r.json() : [];
      } else {
        const col = typeof worldsCol==='function' ? worldsCol() : null;
        if(col){ const snap = await col.orderBy('createdAt','desc').limit(100).get(); rows = snap.docs.map(d=>({ id:d.id, ...d.data() })); }
      }
      community = rows.filter(w=>w && w.id && Array.isArray(w.blocks)).map(w=>({
        key:String(w.id), name: String(w.name||'Untitled').slice(0,40), creator: w.authorName || 'a builder', genre: w.goal ? 'Obby' : 'Adventure',
        builtin:false, max:30, created:w.createdAt, updated:w.updatedAt, world:w, authorId:w.authorId,
        desc: (w.desc ? String(w.desc).slice(0,400) : 'A world built in NeoStudio by '+(w.authorName||'a builder')+'.') + '\n\n' + w.blocks.length + ' parts' + (w.goal ? ' · reach the trophy to win' : ''),
      }));
    }catch(e){ /* offline: just the Neoblox originals */ }
  }
  async function loadStats(){
    try{
      const headers = {}; if(Session.token) headers.Authorization = 'Bearer '+Session.token;
      const r = await fetch(netHttpBase()+'/api/games', { headers });
      if(!r.ok) return;
      const list = await r.json();
      stats = {}; list.forEach(s=>{ stats[s.key] = s; });
    }catch(e){}
  }
  async function loadShop(){
    try{ const r = await fetch(netHttpBase()+'/api/shop'); if(r.ok) shop = await r.json(); }catch(e){}
  }
  NH.refresh = async function(){
    await Promise.all([loadCommunity(), loadStats(), shop.length ? null : loadShop()]);
    render();
  };

  // ------------------------------------------------------------------ thumbnails (rendered in 3D, cached)
  let TR = null;
  function thumbRenderer(){
    if(TR) return TR;
    const canvas = document.createElement('canvas');
    TR = new THREE.WebGLRenderer({ canvas, antialias:true, preserveDrawingBuffer:true, alpha:true });
    TR.setPixelRatio(1);
    TR.shadowMap.enabled = true; TR.shadowMap.type = THREE.PCFSoftShadowMap;
    return TR;
  }
  const thumbCache = {};
  function thumbKey(g, w, h){ return g.key+':'+(g.updated||0)+':'+w+'x'+h; }
  function lightScene(scene, sky, half){
    scene.add(new THREE.HemisphereLight(0xe4efff, 0xa39780, 0.66));
    const sun = new THREE.DirectionalLight(sky==='storm' ? 0xc9c3ff : 0xfff1dc, 0.75);
    sun.position.set(half*0.6, half*1.5, half*0.9);
    sun.castShadow = true; sun.shadow.mapSize.set(1024,1024);
    sun.shadow.camera.left = -half; sun.shadow.camera.right = half; sun.shadow.camera.top = half; sun.shadow.camera.bottom = -half; sun.shadow.camera.far = half*5;
    sun.shadow.bias = -0.001;
    scene.add(sun);
  }
  function addAvatar(scene, prof, x, y, z, ry, pose){
    const rig = buildAvatar(prof);
    rig.group.position.set(x, y, z); rig.group.rotation.y = ry||0;
    animateAvatar(rig, 0.4, pose || { speedFactor:0 });
    scene.add(rig.group);
    return rig;
  }
  const DEMO_FOLKS = [
    { skin:'#f0b98d', shirt:'#ff5c72', pants:'#2a3350', accessories:['cap_red'] },
    { skin:'#8d5524', shirt:'#4dabf7', pants:'#0a0d18', accessories:['headphones'] },
    { skin:'#ffd9b3', shirt:'#69db7c', pants:'#5c3d99', accessories:['party_hat'], face:'face_grin' },
  ];
  function renderThumb(g, w, h){
    const key = thumbKey(g, w, h);
    if(thumbCache[key]) return thumbCache[key];
    let url = '';
    try{ url = g.key==='lobby' ? lobbyThumb(w, h) : worldThumb(g, w, h); }catch(e){ console.warn('thumbnail failed', g.key, e); }
    if(url) thumbCache[key] = url;
    return url;
  }
  function frameCamera(scene, box, w, h, dir){
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(4, size.length()*0.5);
    const cam = new THREE.PerspectiveCamera(40, w/h, 0.1, 2000);
    const d = (dir || new THREE.Vector3(1, 0.85, 1.2)).normalize();
    cam.position.copy(center).addScaledVector(d, radius / Math.tan(THREE.MathUtils.degToRad(20)) * 0.92);
    cam.lookAt(center);
    return cam;
  }
  function worldThumb(g, w, h){
    const R = thumbRenderer(); R.setSize(w, h, false);
    const scene = new THREE.Scene();
    const isBattle = g.key==='battle';
    const world = isBattle ? THUNDER_ARENA : (g.key==='sky' ? SKYRUSH_WORLD : g.world);
    const sky = (world.lighting && world.lighting.sky) || 'day';
    scene.background = isBattle ? makeSkyTexture('#3b2a6b','#c9a4ff') : sky==='night' ? makeSkyTexture('#050a1c','#1f2d55') : sky==='sunset' ? makeSkyTexture('#40407a','#ffb27a') : makeSkyTexture('#2f80dc','#cfe6fb');
    const blocks = deserializeBlocks(world.blocks);
    const box = new THREE.Box3();
    blocks.forEach((v,k)=>{
      const [x,y,z] = k.split(',').map(Number);
      const m = makeBlockMesh(v.type, v.props);
      m.position.set(x+0.5, y+0.5, z+0.5);
      scene.add(m);
      box.expandByPoint(new THREE.Vector3(x, y, z)); box.expandByPoint(new THREE.Vector3(x+1, y+1, z+1));
    });
    if(isBattle){
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(BATTLE_GROUND_R*2, BATTLE_GROUND_R*2), new THREE.MeshStandardMaterial({ map: makeBattleGroundTexture(), roughness:0.9 }));
      ground.rotation.x = -Math.PI/2; ground.receiveShadow = true; scene.add(ground);
      const bus = makeBus(); bus.position.set(-6, 16, 8); bus.scale.setScalar(1.4); scene.add(bus);
    } else if(world.baseplate){
      const plate = makeBaseplate(WORLD_BOUND+2); scene.add(plate);
      box.expandByPoint(new THREE.Vector3(-8, 0, -8)); box.expandByPoint(new THREE.Vector3(8, 0, 8));
    }
    if(box.isEmpty()) box.set(new THREE.Vector3(-4,0,-4), new THREE.Vector3(4,2,4));
    const sp = world.spawn || { x:0, y:1, z:0 };
    if(!isBattle){
      const pad = makeSpawnPad(); pad.position.set(sp.x+0.5, sp.y, sp.z+0.5); scene.add(pad);
      if(world.goal){ const gm = makeGoalMarker(); gm.position.set(world.goal.x+0.5, world.goal.y, world.goal.z+0.5); scene.add(gm); }
      addAvatar(scene, DEMO_FOLKS[0], sp.x+0.5, sp.y, sp.z+0.5, Math.PI*0.8, { speedFactor:0, jumping:true });
    } else {
      addAvatar(scene, DEMO_FOLKS[1], 2.5, 1, 4.5, 0.6, { speedFactor:1 });
      addAvatar(scene, DEMO_FOLKS[0], -2.5, 1, 6.5, -0.4, { speedFactor:1 });
    }
    lightScene(scene, isBattle ? 'storm' : 'day', Math.max(12, box.getSize(new THREE.Vector3()).length()*0.6));
    let camBox = box;
    if(g.key==='sky'){ camBox = new THREE.Box3(new THREE.Vector3(-3,0,-14), new THREE.Vector3(3,3,3)); }
    if(isBattle){ camBox = new THREE.Box3(new THREE.Vector3(-16,0,-12), new THREE.Vector3(16,10,16)); }
    const cam = frameCamera(scene, camBox, w, h, g.key==='sky' ? new THREE.Vector3(0.55, 0.6, 1) : null);
    R.render(scene, cam);
    const url = R.domElement.toDataURL('image/jpeg', 0.86);
    disposeObj(scene);
    return url;
  }
  function lobbyThumb(w, h){
    const R = thumbRenderer(); R.setSize(w, h, false);
    const scene = new THREE.Scene();
    scene.background = makeSkyTexture('#8fd0ff','#eaf7ff');
    const grassTex = makeGrassTexture(); grassTex.repeat && grassTex.repeat.set(8,8);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshLambertMaterial({ map: grassTex, color:0xb6e07a }));
    ground.rotation.x = -Math.PI/2; ground.receiveShadow = true; scene.add(ground);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(6, 80), new THREE.MeshLambertMaterial({ color:0x8b9099 }));
    road.rotation.x = -Math.PI/2; road.position.y = 0.01; road.receiveShadow = true; scene.add(road);
    scene.add(makeBuilding(-7, -6, 0xffd9a0, 0xff6b6b, 0x4dabf7, 'Shop', { ry: Math.PI/2 }));
    scene.add(makeBuilding(7.5, -9, 0xb9e3ff, 0x845ef7, 0xffd43b, 'Studio', { ry: -Math.PI/2 }));
    scene.add(makeTree(-5, 3, 1.1)); scene.add(makeTree(5, 1, 1.0)); scene.add(makeTree(-9, 6, 1.2)); scene.add(makeStreetlamp(3.6, -2));
    addAvatar(scene, DEMO_FOLKS[0], -1.2, 0, 2.5, 0.5, { speedFactor:0, emote:{ type:'wave', startedAt:0 } });
    addAvatar(scene, DEMO_FOLKS[1], 1.4, 0, 1.6, -0.6, { speedFactor:0 });
    addAvatar(scene, DEMO_FOLKS[2], 0.2, 0, -1.2, 0.1, { speedFactor:0, emote:{ type:'cheer', startedAt:0 } });
    scene.traverse(o=>{ if(o.isMesh) o.castShadow = true; });
    lightScene(scene, 'day', 16);
    const cam = new THREE.PerspectiveCamera(42, w/h, 0.1, 400);
    cam.position.set(6.5, 5.2, 10.5); cam.lookAt(0, 1.2, -1);
    R.render(scene, cam);
    const url = R.domElement.toDataURL('image/jpeg', 0.86);
    disposeObj(scene);
    return url;
  }
  // headshots (profile pictures) of avatars — your own and everyone online
  const headCache = {};
  function headshot(prof, size){
    size = size || 150;
    const key = JSON.stringify([prof.skin, prof.shirt, prof.pants, prof.accessories||[], prof.face||null, prof.customSkin||null, size]);
    if(headCache[key]) return headCache[key];
    const R = thumbRenderer(); R.setSize(size, size, false);
    const scene = new THREE.Scene();
    scene.background = null;
    const rig = buildAvatar(prof);
    const skin = prof.customSkin && prof.customSkin!=='admin' && prof.customSkin!=='uploaded' && prof.customSkin!=='thunderbot' && SKIN_REGISTRY[prof.customSkin] ? prof.customSkin : null;
    let pending = false;
    if(skin){
      if(SkinTemplates[skin]) attachSkin(rig, skin);
      else { pending = true; ensureSkinLoaded(skin, ()=>{ Object.keys(headCache).forEach(k=>{ if(k.indexOf('"'+skin+'"')>=0) delete headCache[k]; }); scheduleRender(); }); }
    }
    scene.add(rig.group);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.95));
    const d = new THREE.DirectionalLight(0xffffff, 0.55); d.position.set(2, 4, 5); scene.add(d);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    const headY = RIG.legH + RIG.torsoH + RIG.headS/2;
    cam.position.set(0.55, headY + 0.15, 2.0); cam.lookAt(0, headY - 0.12, 0);
    R.setClearColor(0x000000, 0);
    R.render(scene, cam);
    const url = R.domElement.toDataURL('image/png');
    disposeObj(scene);
    if(!pending) headCache[key] = url;
    return url;
  }
  function myHeadshot(size){ return headshot(Object.assign({}, myAvatarProfile(), { customSkin: Profile.customSkin }), size); }

  // ------------------------------------------------------------------ rendering
  let renderQueued = false;
  function scheduleRender(){ if(renderQueued) return; renderQueued = true; setTimeout(()=>{ renderQueued = false; render(); }, 60); }
  function tileHtml(g){
    const s = st(g.key), r = rating(g.key);
    return `<div class="nh-tile" data-game="${esc(g.key)}">
      <div class="th"><img data-thumb="${esc(g.key)}" alt="">${s.playing>0 ? '' : ''}</div>
      <div class="nm">${esc(g.name)}</div>
      <div class="meta"><span>👍 ${r==null ? '—' : r+'%'}</span><span>👤 ${fmt(s.playing)}</span></div>
    </div>`;
  }
  function fillThumbs(root){
    const imgs = $$('img[data-thumb]', root).filter(i=>!i.src);
    let i = 0;
    const step = ()=>{
      const t0 = performance.now();
      while(i < imgs.length && performance.now() - t0 < 30){
        const img = imgs[i++]; const g = gameByKey(img.dataset.thumb);
        if(g) img.src = renderThumb(g, 300, 300);
      }
      if(i < imgs.length) setTimeout(step, 16);
    };
    step();
  }
  function wireTiles(root){
    $$('.nh-tile[data-game]', root).forEach(t=> t.addEventListener('click', ()=> openGame(t.dataset.game)));
    fillThumbs(root);
  }
  function sortedGames(mode){
    const list = allGames().filter(g=> !search || (g.name+' '+g.creator).toLowerCase().includes(search));
    const pop = (g)=> st(g.key).playing*1000 + st(g.key).visits + (g.builtin ? 0.5 : 0);
    if(mode==='rated') list.sort((a,b)=> (rating(b.key)??-1) - (rating(a.key)??-1) || pop(b)-pop(a));
    else if(mode==='new') list.sort((a,b)=> (b.created||0) - (a.created||0));
    else if(mode==='visits') list.sort((a,b)=> st(b.key).visits - st(a.key).visits);
    else list.sort((a,b)=> pop(b) - pop(a));
    return list;
  }
  function render(){
    renderTop();
    if(page==='home') renderHomePage();
    else if(page==='discover') renderDiscover();
    else if(page==='game') renderGame();
    else if(page==='avatar') renderAvatar();
    else if(page==='shop') renderShop();
    else if(page==='quests') renderQuestsPage();
    else if(page==='create') renderCreate();
  }
  function renderTop(){
    const u = Session.user;
    const right = $('#nhRight');
    if(u){
      right.innerHTML = `<button class="nh-tokens" id="nhTokens" title="Tokens">${COIN}<span>${fmt(u.tokens)}</span></button>
        <button class="nh-me" id="nhMe"><img alt="" src="${myHeadshot(64)}"><span>${esc(u.username)}</span></button>`;
      $('#nhTokens').addEventListener('click', ()=> go('quests'));
      $('#nhMe').addEventListener('click', toggleMeMenu);
    } else {
      right.innerHTML = `<button class="nh-signup-btn" id="nhSignup">Sign Up</button><button class="nh-login-btn" id="nhLogin">Log In</button>`;
      $('#nhSignup').addEventListener('click', ()=> openLogin('register'));
      $('#nhLogin').addEventListener('click', ()=> openLogin('login'));
    }
    $('#nhSideHead').src = myHeadshot(80);
    $('#nhSideName').textContent = u ? u.username : Profile.name;
    $('#nhSideSub').textContent = u ? ('Tokens: '+fmt(u.tokens)) : 'Playing as a guest';
    const claimable = u ? (u.quests||[]).filter(q=>q.canClaim).length : 0;
    const pill = $('#nhQuestPill'); pill.hidden = !claimable; pill.textContent = claimable;
    $$('[data-go]').forEach(a=> a.classList.toggle('on', a.dataset.go===page || (page==='game' && a.dataset.go==='discover' && false)));
    const dot = $('#nhConnDot'); if(dot) dot.classList.toggle('live', !!(typeof Net!=='undefined' && Net.connected));
  }
  function toggleMeMenu(){
    const ex = $('#nhMeMenu'); if(ex){ ex.remove(); return; }
    const m = document.createElement('div');
    m.className = 'nh-menu'; m.id = 'nhMeMenu';
    m.innerHTML = `<button data-act="avatar">🧑 Edit Avatar</button><button data-act="quests">🎯 Quests</button><button data-act="shop">🛍️ Avatar Shop</button><button data-act="logout">↩ Log out</button>`;
    $('#nbHome').appendChild(m);
    m.addEventListener('click', (e)=>{
      const b = e.target.closest('button'); if(!b) return;
      m.remove();
      if(b.dataset.act==='logout'){ clearSession(); showToast('Logged out.'); }
      else go(b.dataset.act);
    });
    setTimeout(()=> document.addEventListener('click', function close(ev){ if(!m.contains(ev.target)){ m.remove(); document.removeEventListener('click', close); } }), 0);
  }
  function renderHomePage(){
    const u = Session.user;
    $('#nhHelloHead').src = myHeadshot(184);
    $('#nhHello').textContent = 'Hello, ' + (u ? u.username : Profile.name) + '!';
    $('#nhHelloSub').textContent = u ? 'Pick up where you left off, or try something new.' : 'Playing as a guest — log in to earn tokens and shop for your avatar.';
    renderOnline();
    const recent = (loadLocal('nb_recent', []) || []).map(gameByKey).filter(Boolean);
    const cont = (recent.length ? recent : BUILTIN).slice(0, 6);
    $('#nhContinue').innerHTML = cont.map(tileHtml).join('');
    wireTiles($('#nhContinue'));
    $('#nhRecommended').innerHTML = sortedGames('popular').slice(0, 12).map(tileHtml).join('');
    wireTiles($('#nhRecommended'));
  }
  function whereLabel(world){
    if(!world) return 'On the home page';
    if(world==='lobby') return 'In the Lobby';
    if(world==='battle') return 'In Thunder Battle';
    if(world==='studio') return 'Creating in NeoStudio';
    if(String(world).indexOf('play:')===0){ const g = gameByKey(String(world).slice(5)); return 'Playing ' + (g ? g.name : 'a world'); }
    return 'Online';
  }
  function renderOnline(){
    const box = $('#nhOnline'); if(!box) return;
    const peers = (typeof Net!=='undefined' && Net.connected) ? Object.values(Net.peers||{}) : [];
    $('#nhOnlineCount').textContent = peers.length ? '('+peers.length+')' : '';
    if(!peers.length){ box.innerHTML = '<div class="nh-empty">'+((typeof Net!=='undefined' && Net.connected) ? 'Nobody else is online right now. Invite a friend!' : 'You\'re offline — online players show up here when the Neoblox server is connected.')+'</div>'; return; }
    box.innerHTML = peers.slice(0, 30).map(p=>{
      const a = p.avatar || {};
      const prof = { skin:a.skin||'#f0b98d', shirt:a.shirt||'#4dabf7', pants:a.pants||'#2a3350', accessories:a.accessories||[], face:a.face||null, customSkin:a.customSkin||null };
      const inGame = p.world && p.world!=='lobby';
      const g = p.world && String(p.world).indexOf('play:')===0 ? String(p.world).slice(5) : (p.world==='battle' ? 'battle' : p.world==='lobby' ? 'lobby' : null);
      return `<div class="nh-friend"${g ? ` data-join="${esc(g)}" style="cursor:pointer" title="Join them"` : ''}><div class="av"><img alt="" src="${headshot(prof, 120)}"><span class="st${inGame?' game':''}"></span></div>
        <div class="nm">${esc(p.name||'Player')}</div><div class="wh">${esc(whereLabel(p.world))}</div></div>`;
    }).join('');
    $$('[data-join]', box).forEach(el=> el.addEventListener('click', ()=> openGame(el.dataset.join)));
  }
  function renderDiscover(){
    $$('#nhSortChips .nh-chip').forEach(c=> c.classList.toggle('on', c.dataset.sort===sortMode));
    const list = sortedGames(sortMode);
    $('#nhDiscoverGrid').innerHTML = list.length ? list.map(tileHtml).join('') : '<div class="nh-empty">No experiences match “'+esc(search)+'”.</div>';
    wireTiles($('#nhDiscoverGrid'));
  }
  function openGame(key){
    if(!gameByKey(key)) return;
    currentKey = key;
    go('game');
  }
  function renderGame(){
    const g = gameByKey(currentKey);
    const el = $('#nhGame');
    if(!g){ el.innerHTML = '<div class="nh-empty">That experience isn\'t available.</div>'; return; }
    const s = st(g.key), r = rating(g.key);
    const upPct = (s.up + s.down) ? Math.round(100*s.up/(s.up+s.down)) : 0;
    el.innerHTML = `<button class="nh-back" id="nhBack">‹ Back</button>
      <div class="nh-game">
        <div><div class="hero"><img id="nhHero" alt=""></div>
          <h2>About</h2><div class="nh-about">${esc(g.desc)}</div></div>
        <div>
          <h1 class="title">${esc(g.name)}</h1>
          <div class="by">By <b>${esc(g.creator)}</b></div>
          <button class="nh-play" id="nhPlayBtn" title="Play">${PLAY_SVG}</button>
          <div class="nh-votes">
            <button class="nh-vote up${s.myVote>0?' on':''}" id="nhUp">👍 ${fmt(s.up)}</button>
            <div class="nh-votebar"><div class="f" style="width:${(s.up+s.down)?upPct:0}%"></div></div>
            <button class="nh-vote down${s.myVote<0?' on':''}" id="nhDown">👎 ${fmt(s.down)}</button>
          </div>
          <div class="nh-stats">
            <div class="nh-stat"><div class="k">Active</div><div class="v">${fmt(s.playing)}</div></div>
            <div class="nh-stat"><div class="k">Visits</div><div class="v">${fmt(s.visits)}</div></div>
            <div class="nh-stat"><div class="k">Rating</div><div class="v">${r==null?'—':r+'%'}</div></div>
            <div class="nh-stat"><div class="k">Genre</div><div class="v">${esc(g.genre)}</div></div>
            <div class="nh-stat"><div class="k">Created</div><div class="v">${g.created ? new Date(g.created).toLocaleDateString() : '—'}</div></div>
            <div class="nh-stat"><div class="k">Updated</div><div class="v">${ago(g.updated || g.created)}</div></div>
            <div class="nh-stat"><div class="k">Server Size</div><div class="v">${g.max}</div></div>
          </div>
        </div>
      </div>
      <h2>You might also like</h2>
      <div class="nh-grid" id="nhAlso"></div>`;
    $('#nhBack').addEventListener('click', ()=> go(lastListPage));
    $('#nhPlayBtn').addEventListener('click', ()=> playGame(g.key));
    $('#nhUp').addEventListener('click', ()=> vote(g.key, s.myVote>0 ? 0 : 1));
    $('#nhDown').addEventListener('click', ()=> vote(g.key, s.myVote<0 ? 0 : -1));
    setTimeout(()=>{ const img = $('#nhHero'); if(img) img.src = renderThumb(g, 768, 432); }, 0);
    $('#nhAlso').innerHTML = sortedGames('popular').filter(x=>x.key!==g.key).slice(0, 6).map(tileHtml).join('');
    wireTiles($('#nhAlso'));
  }
  async function vote(key, v){
    if(!Session.user){ openLogin('login', 'Log in to vote on experiences'); return; }
    try{
      const s = await apiFetch('/api/games/'+encodeURIComponent(key)+'/vote', { method:'POST', body: JSON.stringify({ v }) });
      stats[key] = s; render();
    }catch(e){ showToast(e.message || 'Could not vote right now'); }
  }

  // ------------------------------------------------------------------ launching
  function launch(fn){
    const nameEl = $('#nameInput');
    Profile.name = (nameEl && nameEl.value.trim().slice(0,16)) || Profile.name;
    saveLocal('nb_profile', Profile);
    syncProfileToNet();
    ensureRenderer(); installInputOnce();
    showScreen('hud');
    fn();
  }
  function playGame(key){
    const g = gameByKey(key); if(!g) return;
    const recent = (loadLocal('nb_recent', []) || []).filter(k=>k!==key); recent.unshift(key); saveLocal('nb_recent', recent.slice(0, 8));
    const join = $('#nhJoin');
    $('#nhJoinImg').src = renderThumb(g, 300, 300);
    $('#nhJoinTitle').textContent = g.name;
    join.hidden = false; join.classList.remove('out');
    setTimeout(()=>{
      try{
        if(key==='lobby') launch(()=> goToLobby());
        else if(key==='sky') launch(()=> goToPlay(SKYRUSH_WORLD, null));
        else if(key==='battle') launch(()=> goToBattle());
        else launch(()=> goToPlay(g.world, g.key));
      }finally{
        setTimeout(()=>{ join.classList.add('out'); setTimeout(()=>{ join.hidden = true; }, 380); }, 650);
      }
    }, 60);
  }
  NH.playGame = playGame;

  // ------------------------------------------------------------------ avatar editor
  function renderAvatar(){
    $$('#nhAvTabs .nh-tab').forEach(t=> t.classList.toggle('on', t.dataset.avtab===avTab));
    $$('[data-avpane]').forEach(p=> p.hidden = p.dataset.avpane!==avTab);
    const ni = $('#nameInput'); if(ni && document.activeElement!==ni) ni.value = Profile.name;
    resizePreview();
    if(avTab==='accessories') renderAccPane();
    if(avTab==='characters') renderCharPane();
  }
  function resizePreview(){
    if(typeof previewCtx==='undefined' || !previewCtx) return;
    const c = $('#avatarPreview'); if(!c) return;
    const w = c.clientWidth, h = c.clientHeight;
    if(!w || !h) return;
    previewCtx.renderer.setPixelRatio(Math.min(devicePixelRatio||1, 2));
    previewCtx.renderer.setSize(w, h, false);
    previewCtx.camera.aspect = w/h;
    previewCtx.camera.fov = 30;
    previewCtx.camera.position.set(0, 1.4, 6.6);
    previewCtx.camera.lookAt(0, 1.05, 0);
    previewCtx.camera.updateProjectionMatrix();
  }
  function itemPic(item){
    const prof = { skin:'#d9b08c', shirt:'#6c757d', pants:'#495057', accessories: item.kind==='face' ? [] : [item.id], face: item.kind==='face' ? item.id : null };
    return headshotFor(prof, item);
  }
  const itemPicCache = {};
  function headshotFor(prof, item){
    if(itemPicCache[item.id]) return itemPicCache[item.id];
    const R = thumbRenderer(); R.setSize(160, 160, false);
    const scene = new THREE.Scene();
    const rig = buildAvatar(prof); scene.add(rig.group);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.95));
    const d = new THREE.DirectionalLight(0xffffff, 0.55); d.position.set(2, 4, 5); scene.add(d);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    const headY = RIG.legH + RIG.torsoH + RIG.headS/2;
    if(item.kind==='back'){ rig.group.rotation.y = Math.PI*0.8; cam.position.set(0.6, 1.5, 3.2); cam.lookAt(0, 1.25, 0); }
    else { cam.position.set(0.45, headY + 0.3, 2.1); cam.lookAt(0, headY + (item.kind==='hat' ? 0.05 : -0.05), 0); }
    R.setClearColor(0x000000, 0);
    R.render(scene, cam);
    const url = R.domElement.toDataURL('image/png');
    disposeObj(scene);
    itemPicCache[item.id] = url;
    return url;
  }
  function owned(id){ return !!(Session.user && (Session.user.inventory||[]).includes(id)); }
  function wearing(item){ return item.kind==='face' ? Profile.face===item.id : (Profile.accessories||[]).includes(item.id); }
  function setWear(item, on){
    if(on && Profile.customSkin && Profile.customSkin!=='admin'){
      trySetPersonalSkin('default');
      H_flash('Switched to the Classic body so your items show.');
    }
    if(item.kind==='face'){ Profile.face = on ? item.id : null; }
    else {
      let acc = (Profile.accessories||[]).filter(id=>id!==item.id);
      if(on){
        // one item per back/glasses slot, up to 3 hats
        acc = acc.filter(id=>{ const it = shop.find(s=>s.id===id); if(!it) return false; if(item.kind==='hat') return true; return it.kind!==item.kind; });
        const hats = acc.filter(id=>{ const it = shop.find(s=>s.id===id); return it && it.kind==='hat'; });
        if(item.kind==='hat' && hats.length>=3) acc = acc.filter(id=>id!==hats[0]);
        acc.push(item.id);
      }
      Profile.accessories = acc;
    }
    saveLocal('nb_profile', Profile);
    onProfileVisualChange();
    syncProfileToNet();
    render();
  }
  function H_flash(t){ try{ showToast(t); }catch(e){} }
  function itemCard(item, ctx){
    const own = owned(item.id), wear = own && wearing(item);
    let btn;
    if(!own) btn = `<button class="nh-buy" data-buy="${esc(item.id)}">Buy</button>`;
    else btn = `<button class="nh-buy ${wear?'off':'wear'}" data-wear="${esc(item.id)}">${wear?'Take off':'Wear'}</button>`;
    return `<div class="nh-item${wear?' on':''}">${wear?'<span class="wearing">Wearing</span>':''}
      <div class="pic"><img alt="" src="${itemPic(item)}"></div>
      <div class="nm" title="${esc(item.name)}">${esc(item.name)}</div>
      <div class="pr${own?' owned':''}">${own ? '✓ Owned' : COIN+' '+fmt(item.price)}</div>${btn}</div>`;
  }
  function wireItems(root){
    $$('[data-buy]', root).forEach(b=> b.addEventListener('click', ()=> buy(b.dataset.buy, b)));
    $$('[data-wear]', root).forEach(b=> b.addEventListener('click', ()=>{ const it = shop.find(s=>s.id===b.dataset.wear); if(it) setWear(it, !wearing(it)); }));
  }
  async function buy(id, btn){
    const item = shop.find(s=>s.id===id); if(!item) return;
    if(!Session.user){ openLogin('register', 'Sign up to buy items — new accounts get a 50-token welcome gift!'); return; }
    if((Session.user.tokens||0) < item.price){ showToast('Not enough tokens — finish quests to earn more!'); go('quests'); return; }
    if(!(await confirmBuy(item))) return;
    if(btn) btn.disabled = true;
    try{
      const data = await apiFetch('/api/shop/buy/'+encodeURIComponent(id), { method:'POST' });
      Session.user = data.user;
      showToast('🛍️ You bought '+item.name+'!');
      setWear(item, true);
      refreshAccountUI();
    }catch(e){ showToast(e.message || 'Could not buy that right now'); if(btn) btn.disabled = false; }
  }
  // a "Buy Item" box: the item, its price, your balance after, Buy Now / Cancel
  function confirmBuy(item){
    return new Promise((resolve)=>{
      const m = document.createElement('div');
      m.className = 'nh-modal'; m.id = 'nhBuyModal';
      const after = (Session.user.tokens||0) - item.price;
      m.innerHTML = `<div class="nh-login" style="text-align:center;">
        <h3>Buy Item</h3>
        <img alt="" src="${itemPic(item)}" style="width:120px;height:120px;border-radius:14px;background:#2a2d34;">
        <p style="font-weight:800;margin:14px 0 4px;">Would you like to buy <b>${esc(item.name)}</b> for ${COIN} ${item.price}?</p>
        <p class="fine" style="margin:0 0 16px;">Your balance after this: ${COIN} ${after}</p>
        <div style="display:flex;gap:10px;"><button class="nh-cta green" id="nhBuyYes" style="flex:1;margin:0;">Buy Now</button><button class="nh-cta" id="nhBuyNo" style="flex:1;margin:0;">Cancel</button></div>
      </div>`;
      document.body.appendChild(m);
      const done = (v)=>{ m.remove(); resolve(v); };
      m.querySelector('#nhBuyYes').addEventListener('click', ()=> done(true));
      m.querySelector('#nhBuyNo').addEventListener('click', ()=> done(false));
      m.addEventListener('click', (e)=>{ if(e.target===m) done(false); });
    });
  }
  function renderShop(){
    $$('#nhShopChips .nh-chip').forEach(c=> c.classList.toggle('on', c.dataset.kind===shopKind));
    const grid = $('#nhShopGrid');
    if(!shop.length){ grid.innerHTML = '<div class="nh-empty">The Avatar Shop needs the Neoblox server — it\'s offline right now.</div>'; return; }
    const list = shop.filter(i=> shopKind==='all' || i.kind===shopKind).filter(i=> !search || i.name.toLowerCase().includes(search));
    grid.innerHTML = list.map(i=>itemCard(i)).join('');
    wireItems(grid);
  }
  function renderAccPane(){
    const pane = $('#nhAccPane');
    const mine = shop.filter(i=>owned(i.id));
    if(!Session.user){ pane.innerHTML = '<div class="nh-note"><b>Log in</b> to wear items from the Avatar Shop.</div><button class="nh-cta green" id="nhAccLogin">Log In</button>'; $('#nhAccLogin').addEventListener('click', ()=>openLogin('login')); return; }
    if(!mine.length){ pane.innerHTML = '<div class="nh-note">You don\'t own any items yet. Visit the <b>Avatar Shop</b> to get hats, faces and gear.</div><button class="nh-cta green" id="nhToShop">Go to the Avatar Shop</button>'; $('#nhToShop').addEventListener('click', ()=>go('shop')); return; }
    pane.innerHTML = (Profile.customSkin && Profile.customSkin!=='admin' ? '<div class="nh-note">Items show on the <b>Classic</b> body — wearing one switches you to it.</div>' : '') +
      '<div class="nh-items">' + mine.map(i=>itemCard(i)).join('') + '</div>';
    wireItems(pane);
  }
  function renderCharPane(){
    const pane = $('#nhCharPane');
    const cur = Profile.customSkin || 'default';
    const opts = [{ id:'default', name:'Classic', pic: headshot(Object.assign({}, myAvatarProfile(), { customSkin:null }), 160) },
                  { id:'ender', name:'Ender', pic: headshot({ skin:'#000', shirt:'#000', pants:'#000', customSkin:'ender' }, 160) }];
    if(Admin && Admin.isAdmin) opts.push({ id:'admin', name:'Admin', pic: headshot({ skin:'#000', shirt:'#000', pants:'#000', customSkin:'admin' }, 160) });
    if(Session.user && Session.user.avatarUrl) opts.push({ id:'uploaded', name:'My upload', emoji:'📦' });
    pane.innerHTML = '<div class="nh-items">' + opts.map(o=>`<div class="nh-item${cur===o.id?' on':''}" data-skin="${o.id}">${cur===o.id?'<span class="wearing">Wearing</span>':''}
        <div class="pic">${o.pic ? `<img alt="" src="${o.pic}">` : o.emoji}</div><div class="nm">${esc(o.name)}</div></div>`).join('') + '</div>' +
      '<h2 style="font-size:17px;">Upload your own 3D avatar</h2>' +
      (Session.user ? '<div class="nh-note">Upload a <b>.glb</b> model (up to 20 MB) and wear it everywhere in Neoblox.</div><input type="file" id="nhGlb" accept=".glb" hidden><button class="nh-upload" id="nhGlbBtn">📦 Upload .glb</button> <span class="sub" id="nhGlbStatus"></span>'
                    : '<div class="nh-note"><b>Log in</b> to upload your own 3D avatar.</div>');
    $$('[data-skin]', pane).forEach(el=> el.addEventListener('click', ()=>{
      const r = trySetPersonalSkin(el.dataset.skin); showToast(r.message);
      onProfileVisualChange(); render();
    }));
    const btn = $('#nhGlbBtn'), inp = $('#nhGlb');
    if(btn && inp){
      btn.addEventListener('click', ()=> inp.click());
      inp.addEventListener('change', async ()=>{
        const f = inp.files && inp.files[0]; inp.value = '';
        const status = $('#nhGlbStatus');
        if(!f) return;
        if(!/\.glb$/i.test(f.name)){ status.textContent = 'Only .glb files are supported.'; return; }
        if(f.size > 20*1024*1024){ status.textContent = 'That file is over 20 MB.'; return; }
        status.textContent = 'Uploading…';
        try{
          const form = new FormData(); form.append('model', f);
          const data = await apiFetch('/api/avatar', { method:'POST', body: form });
          Session.user = data.user; refreshAccountUI();
          trySetPersonalSkin('uploaded'); onProfileVisualChange();
          showToast('📦 Uploaded — you\'re wearing it now!');
          render();
        }catch(e){ status.textContent = e.message || 'Upload failed.'; }
      });
    }
  }
  // drag the avatar stage to spin your character
  function installSpin(){
    const c = $('#avatarPreview'); if(!c) return;
    let down = false, lx = 0;
    c.addEventListener('pointerdown', (e)=>{ down = true; lx = e.clientX; try{ c.setPointerCapture(e.pointerId); }catch(err){} });
    c.addEventListener('pointermove', (e)=>{ if(!down || !previewCtx) return; previewCtx.spin = (previewCtx.spin||0) + (e.clientX-lx)*0.012; lx = e.clientX; });
    const up = ()=>{ down = false; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.style.touchAction = 'none';
  }

  // ------------------------------------------------------------------ quests
  const QUEST_ICON = { welcome:'🎁', sky_rusher:'☁️', thunder_rookie:'⚡', world_builder:'🛠️', first_steps:'💬', chatterbox:'🗨️', world_traveler:'🧭', party_starter:'🎉', voice_of_lobby:'🎙️', marathoner:'🏃', trendsetter:'📦', daily_login:'📅' };
  function renderQuestsPage(){
    const box = $('#nhQuests');
    if(!Session.user){ box.innerHTML = '<div class="nh-note"><b>Log in or sign up</b> to do quests and earn tokens. New accounts get a 50-token welcome gift!</div><button class="nh-cta green" id="nhQLogin">Sign Up</button>'; $('#nhQLogin').addEventListener('click', ()=>openLogin('register')); return; }
    const qs = (Session.user.quests||[]).slice().sort((a,b)=> (b.canClaim - a.canClaim) || (a.claimed - b.claimed));
    box.innerHTML = qs.map(q=>{
      const pct = Math.round(100*q.progress/q.goal);
      const act = q.canClaim ? `<button data-claim="${esc(q.id)}">Claim</button>` : q.claimed ? `<span class="done">✓ ${q.repeat==='daily'?'Done today':'Claimed'}</span>` : `<span class="sub">${q.progress}/${q.goal}</span>`;
      return `<div class="nh-quest"><div class="ic">${QUEST_ICON[q.id]||'⭐'}</div>
        <div class="tx"><b>${esc(q.title)}</b><div>${esc(q.desc)}${q.repeat==='daily'?' · daily':''}</div><div class="bar"><i style="width:${pct}%"></i></div></div>
        <div class="rw">${COIN} ${q.reward}</div>${act}</div>`;
    }).join('');
    $$('[data-claim]', box).forEach(b=> b.addEventListener('click', async ()=>{
      b.disabled = true;
      try{ const data = await apiFetch('/api/quests/'+b.dataset.claim+'/claim', { method:'POST' }); Session.user = data.user; refreshAccountUI(); showToast('+'+data.reward+' tokens!'); }
      catch(e){ showToast(e.message || 'Could not claim that quest.'); b.disabled = false; }
    }));
  }

  // ------------------------------------------------------------------ create
  function renderCreate(){
    const art = $('#nhCreateArt');
    if(art && !art.src) art.src = renderThumb(BUILTIN[1], 640, 400);
    const mine = community.filter(g=> g.authorId===Profile.id);
    $('#nhMyGames').innerHTML = mine.length ? mine.map(tileHtml).join('') : '<div class="nh-empty">Nothing published yet — hit Start Creating and build your first experience!</div>';
    wireTiles($('#nhMyGames'));
  }

  // ------------------------------------------------------------------ login modal
  function openLogin(mode, note){
    const m = $('#nhLoginModal'); m.hidden = false;
    const tab = $(mode==='register' ? '#accTabRegister' : '#accTabLogin'); if(tab) tab.click();
    $('#nhLoginTitle').textContent = note || (mode==='register' ? 'Join Neoblox' : 'Log in to Neoblox');
    setTimeout(()=>{ const u = $('#accUsername'); if(u) u.focus(); }, 30);
  }
  NH.openLogin = openLogin;

  // ------------------------------------------------------------------ navigation
  let lastListPage = 'home';
  function go(p){
    if(p!=='game' && ['home','discover','create','shop'].includes(p)) lastListPage = p;
    page = p;
    $$('.nh-page').forEach(s=> s.classList.toggle('on', s.dataset.page===p));
    $$('.nh-bottom [data-go]').forEach(b=> b.classList.toggle('on', b.dataset.go===p));
    $('#nhSide').classList.remove('open');
    const main = $('#nhMain'); if(main) main.scrollTop = 0;
    render();
  }
  NH.go = go;
  NH.onAccount = function(){
    if(Session.user){ const m = $('#nhLoginModal'); if(m) m.hidden = true; }
    if($('#screen-boot') && !$('#screen-boot').hidden){ loadStats().then(render); }
  };

  function wire(){
    document.body.classList.add('nh-on');
    $$('[data-go]').forEach(a=> a.addEventListener('click', (e)=>{ e.preventDefault(); go(a.dataset.go); }));
    $('#nhLogo').addEventListener('click', ()=> go('home'));
    $('#nhBurger').addEventListener('click', ()=> $('#nhSide').classList.toggle('open'));
    $('#nhPartyLink').addEventListener('click', ()=>{ const d = $('#partyDock'); if(d) d.click(); });
    $('#nhSideMe').addEventListener('click', ()=> go('avatar'));
    $('#nhStartCreating').addEventListener('click', ()=> launch(()=> goToStudio()));
    $('#nhLoginClose').addEventListener('click', ()=>{ $('#nhLoginModal').hidden = true; });
    $('#nhLoginModal').addEventListener('click', (e)=>{ if(e.target.id==='nhLoginModal') e.currentTarget.hidden = true; });
    $$('#nhSortChips .nh-chip').forEach(c=> c.addEventListener('click', ()=>{ sortMode = c.dataset.sort; renderDiscover(); }));
    $$('#nhShopChips .nh-chip').forEach(c=> c.addEventListener('click', ()=>{ shopKind = c.dataset.kind; renderShop(); }));
    $$('#nhAvTabs .nh-tab').forEach(t=> t.addEventListener('click', ()=>{ avTab = t.dataset.avtab; renderAvatar(); }));
    const si = $('#nhSearch');
    si.addEventListener('input', ()=>{ search = si.value.trim().toLowerCase(); if(page==='shop') renderShop(); else { if(page!=='discover') go('discover'); else renderDiscover(); } });
    si.addEventListener('keydown', (e)=> e.stopPropagation());
    window.addEventListener('resize', ()=>{ if(page==='avatar') resizePreview(); });
    installSpin();
    // re-render the bits that depend on the profile whenever the avatar changes
    const origVisual = window.onProfileVisualChange;
    if(typeof origVisual==='function'){
      window.onProfileVisualChange = function(){ origVisual.apply(this, arguments); Object.keys(headCache).forEach(k=> delete headCache[k]); scheduleRender(); };
    }
    // live: who's online / player counts
    netOn('connection', ()=> NH.refresh());
    setInterval(()=>{ if(!$('#screen-boot').hidden && page==='home') renderOnline(); }, 4000);
    setInterval(()=>{ if(!$('#screen-boot').hidden) loadStats().then(()=>{ if(page==='home'||page==='discover'||page==='game') render(); }); }, 20000);
    // coming back to the home page (Leave / Menu) refreshes everything
    const origBack = window.backToMenu;
    if(typeof origBack==='function'){
      window.backToMenu = function(){ origBack.apply(this, arguments); document.body.classList.add('nh-on'); NH.refresh(); };
    }
    const origShow = window.showScreen;
    if(typeof origShow==='function'){
      window.showScreen = function(name){ origShow.apply(this, arguments); document.body.classList.toggle('nh-on', name==='boot'); };
    }
    go('home');
    NH.refresh();
  }
  document.addEventListener('DOMContentLoaded', ()=> setTimeout(wire, 0));
})();
