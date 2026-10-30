// rbx/vr.js — NeoVR: play Neoblox games and walk around the lobby in VR, in the Meta Quest
// browser (WebXR). Press "🥽 VR" in a game; the headset becomes the camera.
//
//   left thumbstick   walk (where you're looking is forward)       A  jump
//   right thumbstick  turn (snap 30°, or smooth — wrist menu)      B  first ⇄ third person
//   trigger           point and click: menus, on-screen buttons,   X  show/hide the wrist menu
//                     clickable parts                              Y  (free for games)
//
// First person: you see through your avatar's eyes, your hands are blocky hands, and walking
// around your room moves your avatar too (walls stop it). Third person: the view floats behind
// your avatar. Your height is measured when VR starts (and on Recenter), so the avatar's eyes are
// where yours are, standing or sitting.
//
// Things that are normally on the screen move into the headset: a wrist menu on your left hand
// (health, leaderboard, view/turning settings, leave, exit VR) and a panel that floats in front
// of you when a game shows something — its on-screen labels and buttons, notifications, and
// Neoblox's buy window. Scripts get the controller buttons as Enum.KeyCode.ButtonA… and can
// check UserInputService.VREnabled.
'use strict';
(function(){
  const VR = window.NeoVR = {};
  const EYE = 1.72;          // the avatar's eye height above its feet
  const BACK = 4.2, UP = 1.1; // third person: how far behind and above
  const SNAP = Math.PI / 6;  // 30°
  const SMOOTH = 2.2;        // radians per second at full stick
  const DEAD = 0.15;         // thumbstick dead zone
  const BUTTON_NAMES = { right:{ 1:'ButtonR1', 4:'ButtonA', 5:'ButtonB' }, left:{ 1:'ButtonL1', 4:'ButtonX', 5:'ButtonY' } };

  const set = Object.assign({ view:'first', turn:'snap' }, (()=>{ try{ return JSON.parse(localStorage.getItem('nb_vr')) || {}; }catch(e){ return {}; } })());
  const save = ()=>{ try{ localStorage.setItem('nb_vr', JSON.stringify(set)); }catch(e){} };

  let supported = false, session = null, starting = false, floor = true;
  let dolly = null, cam = null, scale = 1, calibrated = false, orbit = 0, placed = false;
  let snapReady = true, wristOn = true;
  const hands = [];          // per controller index: { ray, grip, mesh, laser, dot, prev:[], side }
  let wrist = null, hud = null, hudYaw = null, hudShownAt = 0;
  const notes = [];          // recent toasts / notifications for the floating panel
  let saved = null;          // renderer/scene settings to put back after VR
  let tmp = null;
  const T = ()=> tmp || (tmp = { v: new THREE.Vector3(), v2: new THREE.Vector3(), q: new THREE.Quaternion(), ray: new THREE.Raycaster(), m: new THREE.Matrix4() });

  VR.active = ()=> !!session;
  VR.supported = ()=> supported;
  VR.settings = ()=> Object.assign({}, set);

  // ------------------------------------------------------------------ the "🥽 VR" button
  function checkSupport(){
    if(!navigator.xr || !navigator.xr.isSessionSupported) return;
    navigator.xr.isSessionSupported('immersive-vr').then((ok)=>{ supported = !!ok; showButton(); }).catch(()=>{});
  }
  let btn = null;
  function buildButton(){
    if(btn) return;
    const st = document.createElement('style');
    st.textContent = `#nbVrBtn{ position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:60; height:44px; padding:0 16px; border:none; border-radius:12px;
      background:rgba(18,20,24,0.78); color:#fff; font:800 15px 'Nunito Sans', system-ui, sans-serif; display:flex; align-items:center; gap:8px; cursor:pointer; box-shadow:0 6px 18px rgba(0,0,0,.35); }
      #nbVrBtn:hover{ background:rgba(40,44,52,0.9); } #nbVrBtn[hidden]{ display:none; } #nbVrBtn .ic{ font-size:20px; }`;
    document.head.appendChild(st);
    btn = document.createElement('button');
    btn.id = 'nbVrBtn'; btn.type = 'button'; btn.hidden = true;
    btn.title = 'Play in VR on your headset';
    btn.innerHTML = '<span class="ic">🥽</span><span>VR</span>';
    btn.addEventListener('click', ()=> VR.enter());
    document.body.appendChild(btn);
  }
  // offered in games and the lobby, when this browser can do VR (the Meta Quest browser can)
  const canHere = ()=> (App.mode === 'play' || App.mode === 'lobby') && !!App.player && !(App.mode === 'play' && App.studio && App.studio.testing);
  function showButton(){
    if(!document.body) return;
    buildButton();
    btn.hidden = !(supported && !session && !starting && canHere());
  }

  // ------------------------------------------------------------------ start / stop
  VR.enter = async function(){
    if(session || starting || !navigator.xr) return;
    starting = true; showButton();
    const r = App.renderer || ensureRenderer();
    try{
      // must be the first thing after the tap, so the browser counts it as the player's choice
      const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
      floor = true;
      try{ await s.requestReferenceSpace('local-floor'); }catch(e){ floor = false; }
      r.xr.enabled = true;
      r.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');
      await r.xr.setSession(s);
      session = s;
      s.addEventListener('end', onEnd);
      onStart(s);
    }catch(e){
      r.xr.enabled = false;
      showToast('Couldn\'t start VR' + (e && e.message ? ': ' + e.message : ''));
    }finally{ starting = false; showButton(); }
  };
  VR.exit = function(){ if(session) session.end().catch(()=>{}); };

  function onStart(s){
    const r = App.renderer;
    if(document.pointerLockElement) document.exitPointerLock();
    if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if(window.RbxHud && RbxHud.closeMenu) RbxHud.closeMenu(true); // an open menu would stop you moving
    // a headset has to draw two eyes at 72+ frames a second: no shadows, and less detail at the edges
    saved = { shadows: r.shadowMap.enabled };
    r.shadowMap.enabled = false;
    try{ const bl = s.renderState.baseLayer; if(bl && 'fixedFoveation' in bl) bl.fixedFoveation = 1; }catch(e){}
    calibrated = false; placed = false; snapReady = true; wristOn = true; hudYaw = null;
    App.inputAnalog = { x:0, y:0 };
    readControllers.lp = null; readControllers.rp = null;
    hands.forEach(h=>{ h.trig = false; h.toScripts = false; });
    watchNotes(true);
    document.body.classList.add('nb-vr');
    addNote('🥽 Left stick: walk · Right stick: turn · A: jump · B: view · X: menu');
  }
  function onEnd(){
    session = null;
    const r = App.renderer;
    if(saved){ r.shadowMap.enabled = saved.shadows; saved = null; }
    if(App.sunLight && App.sunLight.userData.vrCast !== undefined){ App.sunLight.castShadow = App.sunLight.userData.vrCast; delete App.sunLight.userData.vrCast; }
    r.xr.enabled = false;
    restoreScene();
    if(dolly && dolly.parent) dolly.parent.remove(dolly);
    if(cam && cam.parent === dolly){ dolly.remove(cam); cam.position.set(0, 2, 5); cam.rotation.set(0, 0, 0); cam.scale.set(1, 1, 1); }
    dolly = null; cam = null;
    App.inputAnalog = null; App.input.jump = false;
    if(App.player && App.player.rig) App.player.rig.group.visible = true;
    watchNotes(false);
    document.body.classList.remove('nb-vr');
    showButton();
  }

  // ------------------------------------------------------------------ the play space
  // The headset's camera lives inside a "dolly" — your play space — which is moved to your
  // avatar every frame. Scene changes (lobby portal → game) get a new one.
  function ensureDolly(){
    if(!App.scene || !App.camera) return false;
    if(dolly && dolly.parent === App.scene && cam === App.camera) return true;
    restoreScene();
    if(!dolly){ dolly = new THREE.Group(); dolly.name = 'vr-play-space'; }
    if(cam && cam !== App.camera && cam.parent === dolly) dolly.remove(cam);
    App.scene.add(dolly);
    cam = App.camera; dolly.add(cam);
    cam.position.set(0, 0, 0); cam.rotation.set(0, 0, 0);
    buildHands(); buildPanels();
    hands.forEach(h=>{ dolly.add(h.ray); dolly.add(h.grip); });
    dolly.add(hud.mesh);
    // no sun shadows in VR: they'd be drawn twice a frame (and a frozen old one would linger)
    if(App.sunLight && App.sunLight.userData.vrCast === undefined){ App.sunLight.userData.vrCast = App.sunLight.castShadow; App.sunLight.castShadow = false; }
    // a flat sky picture would stick to your eyes in VR — use its colour instead (the sky dome is fine)
    const sc = App.scene;
    if(sc.background && sc.background.isTexture && !App.skyDome){
      sc.userData.vrBg = sc.background;
      sc.background = new THREE.Color(sc.fog ? sc.fog.color : 0x87b5ff);
    }
    placed = false;
    return true;
  }
  function restoreScene(){
    const sc = dolly && dolly.parent;
    if(sc && sc.userData.vrBg){ sc.background = sc.userData.vrBg; delete sc.userData.vrBg; }
  }
  // your head inside the play space (metres), turned and scaled into the world
  function headOffset(out){
    const yaw = dolly.rotation.y, x = cam.position.x * scale, z = cam.position.z * scale;
    return out.set(x * Math.cos(yaw) + z * Math.sin(yaw), cam.position.y * scale, -x * Math.sin(yaw) + z * Math.cos(yaw));
  }
  function headYaw(){
    const d = T().v2.set(0, 0, -1).applyQuaternion(cam.quaternion);
    return { yaw: Math.atan2(d.x, d.z) + dolly.rotation.y, pitch: Math.asin(Math.max(-1, Math.min(1, d.y))), local: Math.atan2(d.x, d.z) };
  }
  function calibrate(){
    // make your eyes the avatar's eyes, however tall you are (or if you're sitting)
    const h = cam.position.y;
    if(!floor){ scale = 1; calibrated = true; return; }
    if(h < 0.4) return; // no real head height yet
    scale = Math.max(0.7, Math.min(2.2, EYE / h));
    calibrated = true;
  }

  // ------------------------------------------------------------------ every frame (before moving)
  VR.tick = function(dt){
    showButton();
    if(!session) return;
    // VR is for games and the lobby: anywhere else (Thunder Battle, NeoStudio, the menu) ends it
    if(App.mode !== 'play' && App.mode !== 'lobby'){
      if(App.mode === 'battle' || App.mode === 'studio') showToast('🥽 VR is for games and the lobby — this one is on the screen for now');
      VR.exit(); return;
    }
    if(App.mode === 'play' && App.studio && App.studio.testing){ VR.exit(); return; }
    if(!ensureDolly()) return;
    if(!calibrated) calibrate();
    dolly.scale.setScalar(scale);
    const hy = headYaw();
    App.yaw = hy.yaw; App.pitch = hy.pitch;
    readControllers(dt);
    pointers();
    if(!session || !cam) return; // a menu button just ended VR
    drawWrist();
    drawHud(hy);
  };

  function sticks(src){
    const gp = src && src.gamepad; if(!gp) return { x:0, y:0 };
    const a = gp.axes || [];
    const x = a.length >= 4 ? a[2] : (a[0] || 0), y = a.length >= 4 ? a[3] : (a[1] || 0);
    return { x: Math.abs(x) > DEAD ? x : 0, y: Math.abs(y) > DEAD ? y : 0 };
  }
  function pressed(src, i){ const b = src && src.gamepad && src.gamepad.buttons && src.gamepad.buttons[i]; return !!(b && (b.pressed || b.value > 0.75)); }
  function readControllers(dt){
    const srcs = session.inputSources || [];
    let left = null, right = null;
    for(let i = 0; i < srcs.length; i++){
      const s = srcs[i]; if(!s) continue;
      if(s.handedness === 'left') left = s; else if(s.handedness === 'right') right = s;
      const h = hands[i]; if(h) h.src = s;
    }
    for(let i = srcs.length; i < hands.length; i++) hands[i].src = null;
    const ls = sticks(left), rs = sticks(right);
    App.inputAnalog = { x: ls.x, y: -ls.y };
    // turning
    if(set.turn === 'smooth'){ if(rs.x) turn(-rs.x * SMOOTH * dt); }
    else {
      if(snapReady && Math.abs(rs.x) > 0.7){ turn(rs.x > 0 ? -SNAP : SNAP); snapReady = false; }
      else if(Math.abs(rs.x) < 0.3) snapReady = true;
    }
    App.input.jump = pressed(right, 4);
    // buttons: edges go to scripts; B switches view, X shows/hides the wrist menu
    [[left, 'left'], [right, 'right']].forEach(([src, side])=>{
      if(!src) return;
      const key = side === 'left' ? 'lp' : 'rp';
      const prev = readControllers[key] || (readControllers[key] = []);
      [1, 4, 5].forEach(i=>{
        const now = pressed(src, i);
        if(now !== !!prev[i]){
          prev[i] = now;
          if(window.NeoScript && NeoScript.vrButton) NeoScript.vrButton(BUTTON_NAMES[side][i], now);
          if(now && side === 'right' && i === 5) VR.setView(set.view === 'first' ? 'third' : 'first');
          if(now && side === 'left' && i === 4) wristOn = !wristOn;
        }
      });
    });
  }
  function turn(a){
    if(set.view === 'third') orbit += a;
    dolly.rotation.y += a; // first person: follow() keeps your head over the avatar while the room turns
  }
  VR.setView = function(v){
    if(v !== 'first' && v !== 'third') return;
    if(v === 'third' && set.view !== 'third' && cam && dolly) orbit = headYaw().yaw;
    set.view = v; save();
    placed = false;
    if(App.player && App.player.rig) App.player.rig.group.visible = v === 'third';
  };
  VR.setTurn = function(t){ if(t === 'snap' || t === 'smooth'){ set.turn = t; save(); } };
  VR.recenter = function(){
    calibrated = false; placed = false;
    if(cam && dolly){ const hy = headYaw(); orbit = hy.yaw; }
    hudYaw = null;
  };

  // ------------------------------------------------------------------ after moving: where you are
  // face: first person, the avatar faces where you look; third person, where it walks
  VR.face = function(dt, p, mv, moving){
    if(!p || !p.rig) return;
    if(set.view === 'first'){ p.rig.group.rotation.y = App.yaw; return; }
    if(!moving) return;
    const want = Math.atan2(mv.x, mv.z), cur = p.rig.group.rotation.y;
    p.rig.group.rotation.y = cur + Math.atan2(Math.sin(want - cur), Math.cos(want - cur)) * Math.min(1, dt * 14);
  };
  VR.follow = function(dt, p, dead){
    if(!session || !dolly || !cam || !p) return;
    const t = T(), off = headOffset(t.v);
    const yOff = floor ? 0 : EYE;
    // where your head is in your room (metres), and how far it moved since the last frame
    const lx = cam.position.x, lz = cam.position.z, last = VR.follow.last;
    VR.follow.last = { x: lx, z: lz };
    if(set.view === 'first'){
      // walking around your room walks your avatar too (walls stop it)
      if(!dead && placed && last){
        const yaw = dolly.rotation.y, mx = (lx - last.x) * scale, mz = (lz - last.z) * scale;
        const dx = mx * Math.cos(yaw) + mz * Math.sin(yaw), dz = -mx * Math.sin(yaw) + mz * Math.cos(yaw);
        if((dx || dz) && dx * dx + dz * dz < 1){
          if(canEnterColumn(p.pos.x + dx, p.pos.z, p.pos.y)) p.pos.x += dx;
          if(canEnterColumn(p.pos.x, p.pos.z + dz, p.pos.y)) p.pos.z += dz;
          if(p.rig) p.rig.group.position.copy(p.pos);
        }
      }
      dolly.position.set(p.pos.x - off.x, p.pos.y + yOff, p.pos.z - off.z);
      if(p.rig && !dead) p.rig.group.visible = false; // you don't see your own head from inside it
    } else {
      // your head goes BACK behind the avatar (along `orbit`, the way you were looking when you switched)
      const tx = p.pos.x - Math.sin(orbit) * BACK - off.x, tz = p.pos.z - Math.cos(orbit) * BACK - off.z, ty = p.pos.y + UP;
      if(!placed) dolly.position.set(tx, ty + yOff, tz);
      else { const k = 1 - Math.exp(-dt * 6); dolly.position.x += (tx - dolly.position.x) * k; dolly.position.y += (ty + yOff - dolly.position.y) * k; dolly.position.z += (tz - dolly.position.z) * k; }
      if(p.rig && !dead) p.rig.group.visible = true;
    }
    placed = true;
    dolly.updateMatrixWorld(true);
  };

  // ------------------------------------------------------------------ hands + pointing
  function buildHands(){
    if(hands.length) return;
    const r = App.renderer;
    const skin = (typeof Profile !== 'undefined' && Profile.skin) || '#f0b98d';
    for(let i = 0; i < 2; i++){
      const ray = r.xr.getController(i), grip = r.xr.getControllerGrip(i);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.12), new THREE.MeshLambertMaterial({ color: skin }));
      mesh.position.set(0, -0.01, 0.03);
      grip.add(mesh);
      const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const laser = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
      laser.renderOrder = 30; laser.frustumCulled = false; laser.visible = false;
      ray.add(laser);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      dot.renderOrder = 31; dot.visible = false;
      ray.add(dot);
      hands.push({ ray, grip, mesh, laser, dot, src: null, trig: false });
    }
  }
  // each hand points: at a panel button, a clickable part, or nothing — the trigger clicks
  function pointers(){
    const t = T();
    hands.forEach(h=>{
      const src = h.src;
      h.laser.visible = false; h.dot.visible = false;
      if(!src || !h.ray.visible) return;
      h.ray.updateMatrixWorld(true);
      const origin = t.v.setFromMatrixPosition(h.ray.matrixWorld).clone();
      t.q.setFromRotationMatrix(t.m.extractRotation(h.ray.matrixWorld));
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(t.q).normalize();
      let hit = panelHit(origin, dir, src.handedness === 'left'), part = null;
      if(!hit && window.NeoScript && NeoScript.rayPick) part = NeoScript.rayPick(origin, dir, false);
      const dist = hit ? hit.distance : part ? part.distance : 0;
      if(dist){
        const local = dist / scale; // the ray lives in the (scaled) play space
        h.laser.visible = true; h.laser.scale.set(1, 1, local);
        h.dot.visible = true; h.dot.position.set(0, 0, -local);
        h.laser.material.color.setHex(hit && hit.button ? 0x4dd2ff : part ? 0xffd400 : 0xffffff);
      }
      const trig = pressed(src, 0);
      if(trig !== h.trig){
        h.trig = trig;
        const side = src.handedness === 'left' ? 'ButtonL2' : 'ButtonR2';
        if(trig && hit){ if(hit.button) press(hit.panel, hit.button); }
        else if(trig && part && window.NeoScript) NeoScript.rayPick(origin, dir, true);
        else if(trig){ h.toScripts = true; if(window.NeoScript && NeoScript.vrButton) NeoScript.vrButton(side, true); }
        if(!trig && h.toScripts){ h.toScripts = false; if(window.NeoScript && NeoScript.vrButton) NeoScript.vrButton(side, false); }
      }
    });
  }

  // ------------------------------------------------------------------ panels (drawn on canvases)
  function makePanel(w, h, px){
    const c = document.createElement('canvas'); c.width = Math.round(w * px); c.height = Math.round(h * px);
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.renderOrder = 20; mesh.frustumCulled = false;
    return { c, x: c.getContext('2d'), tex, mesh, buttons: [], key: '' };
  }
  function buildPanels(){
    if(wrist) return;
    wrist = makePanel(0.26, 0.21, 1600); wrist.name = 'wrist';
    hud = makePanel(1.2, 0.675, 1066); hud.name = 'hud';
    hud.mesh.visible = false;
  }
  function panelHit(origin, dir, skipWrist){
    const t = T();
    const meshes = [!skipWrist && wrist && wrist.mesh.visible && wrist.mesh.parent ? wrist : null, hud && hud.mesh.visible ? hud : null].filter(Boolean);
    if(!meshes.length) return null;
    t.ray.set(origin, dir); t.ray.far = 30;
    for(const pn of meshes){
      pn.mesh.updateMatrixWorld(true);
      const hit = t.ray.intersectObject(pn.mesh, false)[0];
      if(!hit || !hit.uv) continue;
      const x = hit.uv.x * pn.c.width, y = (1 - hit.uv.y) * pn.c.height;
      const button = pn.buttons.find(b=> x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && b.enabled !== false) || null;
      return { panel: pn, button, distance: hit.distance };
    }
    return null;
  }
  function press(pn, b){ try{ b.act(); }catch(e){ console.error(e); } pn.key = ''; }
  function rr(x, X, Y, W, H, R){ x.beginPath(); x.moveTo(X + R, Y); x.arcTo(X + W, Y, X + W, Y + H, R); x.arcTo(X + W, Y + H, X, Y + H, R); x.arcTo(X, Y + H, X, Y, R); x.arcTo(X, Y, X + W, Y, R); x.closePath(); }
  function button(pn, X, Y, W, H, label, act, opts){
    opts = opts || {};
    const x = pn.x, on = opts.enabled !== false;
    rr(x, X, Y, W, H, 14); x.fillStyle = !on ? 'rgba(70,70,70,0.9)' : opts.color || 'rgba(58,58,58,0.95)'; x.fill();
    x.fillStyle = on ? '#fff' : '#9a9a9a'; x.font = '800 ' + (opts.size || 30) + 'px "Nunito Sans", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(label, X + W / 2, Y + H / 2 + 1, W - 16);
    pn.buttons.push({ x: X, y: Y, w: W, h: H, act, enabled: on, label });
  }
  function coin(x, cx, cy, r){
    const g = x.createRadialGradient(cx - r * .3, cy - r * .4, r * .1, cx, cy, r);
    g.addColorStop(0, '#fff2b0'); g.addColorStop(.45, '#ffc83d'); g.addColorStop(1, '#d49400');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#7a5400'; x.font = '900 ' + Math.round(r * 1.1) + 'px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('N', cx, cy + 1);
  }

  // the wrist menu, on your left hand
  function drawWrist(){
    const leftGrip = hands.find(h=> h.src && h.src.handedness === 'left');
    if(!wrist || !leftGrip){ if(wrist && wrist.mesh.parent) wrist.mesh.parent.remove(wrist.mesh); return; }
    if(wrist.mesh.parent !== leftGrip.grip){
      leftGrip.grip.add(wrist.mesh);
      wrist.mesh.position.set(0, 0.075, 0.02); wrist.mesh.rotation.set(-1.0, 0, 0);
    }
    wrist.mesh.visible = wristOn;
    if(!wristOn) return;
    const h = App.hum, ls = App.leaderstats || {};
    const title = App.mode === 'lobby' ? 'Lobby' : ((App.currentWorldData && App.currentWorldData.name) || 'Game');
    const key = [title, h ? Math.round(h.health) + '/' + h.maxHealth : '', JSON.stringify(ls), set.view, set.turn].join('|');
    if(key === wrist.key) return;
    wrist.key = key; wrist.buttons = [];
    const x = wrist.x, W = wrist.c.width, H = wrist.c.height;
    x.clearRect(0, 0, W, H);
    rr(x, 4, 4, W - 8, H - 8, 26); x.fillStyle = 'rgba(22,24,28,0.92)'; x.fill();
    x.fillStyle = '#fff'; x.font = '900 34px "Nunito Sans", system-ui, sans-serif'; x.textAlign = 'left'; x.textBaseline = 'top';
    x.fillText('🥽 ' + title, 26, 22, W - 52);
    let y = 74;
    if(h){
      const f = Math.max(0, Math.min(1, h.health / (h.maxHealth || 100)));
      rr(x, 26, y, W - 52, 22, 11); x.fillStyle = 'rgba(255,255,255,0.15)'; x.fill();
      if(f > 0){ rr(x, 26, y, Math.max(22, (W - 52) * f), 22, 11); x.fillStyle = f > 0.5 ? '#3ddc84' : f > 0.25 ? '#ffd400' : '#ff4d4d'; x.fill(); }
      y += 36;
    }
    const stats = Object.keys(ls).slice(0, 3);
    x.font = '700 26px "Nunito Sans", system-ui, sans-serif'; x.fillStyle = '#cfd6e4';
    stats.forEach(k=>{ x.fillText(k + ': ' + ls[k], 26, y, W - 52); y += 32; });
    y = Math.max(y + 6, H - 214);
    const bw = (W - 52 - 12) / 2, bh = 58;
    button(wrist, 26, y, bw, bh, set.view === 'first' ? '👁 First person' : '🎥 Third person', ()=> VR.setView(set.view === 'first' ? 'third' : 'first'), { size: 24 });
    button(wrist, 26 + bw + 12, y, bw, bh, set.turn === 'snap' ? '↻ Snap turn' : '↻ Smooth turn', ()=> VR.setTurn(set.turn === 'snap' ? 'smooth' : 'snap'), { size: 24 });
    y += bh + 10;
    button(wrist, 26, y, bw, bh, '⊙ Recenter', ()=> VR.recenter(), { size: 24 });
    button(wrist, 26 + bw + 12, y, bw, bh, '🚪 Leave game', ()=>{ VR.exit(); setTimeout(()=>{ if(typeof backToMenu === 'function') backToMenu(); }, 0); }, { size: 24, color: 'rgba(120,40,40,0.95)' });
    y += bh + 10;
    button(wrist, 26, y, W - 52, bh, '✖ Exit VR', ()=> VR.exit(), { size: 26, color: 'rgba(31,111,209,0.95)' });
    wrist.tex.needsUpdate = true;
  }

  // the floating panel: the game's on-screen labels/buttons/pictures, notifications, the buy window
  const pics = new Map();
  function picture(id){
    let p = pics.get(id);
    if(!p){ p = new Image(); p.onload = ()=>{ if(hud) hud.key = ''; }; p.src = imageUrl(id); pics.set(id, p); }
    return p.complete && p.naturalWidth ? p : null;
  }
  function watchNotes(on){
    if(!on){ if(watchNotes.mo){ watchNotes.mo.disconnect(); watchNotes.mo = null; } notes.length = 0; return; }
    if(watchNotes.mo) return;
    const mo = new MutationObserver((list)=>{
      list.forEach(m=> m.addedNodes.forEach(n=>{ if(n.nodeType === 1 && n.textContent.trim()) addNote(n.textContent.trim()); }));
    });
    ['toastStack', 'rbxNotes'].forEach(id=>{ const el = document.getElementById(id); if(el) mo.observe(el, { childList: true }); });
    watchNotes.mo = mo;
  }
  function addNote(text){ notes.push({ text: text.slice(0, 140), at: performance.now() }); if(notes.length > 3) notes.shift(); }
  VR.notify = addNote;
  function drawHud(hy){
    if(!hud) return;
    const now = performance.now();
    while(notes.length && now - notes[0].at > 4500) notes.shift();
    const banner = document.getElementById('centerBanner');
    const bannerText = banner && !banner.hidden ? [(document.getElementById('bannerTitle') || {}).textContent, (document.getElementById('bannerSub') || {}).textContent].filter(Boolean).join(' — ') : '';
    const ui = App.mode === 'play' ? (App.worldUi || []).filter(u=> !u.hidden) : [];
    const buy = window.NeoMarket && NeoMarket.vrModel ? NeoMarket.vrModel() : null;
    const show = !!(ui.length || notes.length || bannerText || buy);
    if(!show){ hud.mesh.visible = false; hudYaw = null; return; }
    // float in front of you; follow lazily when you look away (and come right back for the buy window)
    const want = hy.local;
    const off = hudYaw === null ? Infinity : Math.abs(Math.atan2(Math.sin(want - hudYaw), Math.cos(want - hudYaw)));
    if(off > 0.75 || (buy && !hud.forBuy)){ hudYaw = want; }
    hud.forBuy = !!buy;
    const hp = cam.position;
    hud.mesh.position.set(hp.x + Math.sin(hudYaw) * 1.3, hp.y - 0.12, hp.z + Math.cos(hudYaw) * 1.3);
    hud.mesh.rotation.set(0, hudYaw + Math.PI, 0);
    hud.mesh.visible = true;
    const key = JSON.stringify([ui.map(u=> [u.id, u.kind, u.text, u.xPct, u.yPct, u.tc, u.bg, u.ts, u.img, u.w]), notes.map(n=> n.text), bannerText, buy]);
    if(key === hud.key) return;
    hud.key = key; hud.buttons = [];
    const x = hud.x, W = hud.c.width, H = hud.c.height;
    x.clearRect(0, 0, W, H);
    // the game's on-screen GUI, laid out like on a screen
    ui.forEach(u=>{
      const cx = Math.max(0, Math.min(100, +u.xPct || 0)) / 100 * W, cy = Math.max(0, Math.min(100, +u.yPct || 0)) / 100 * H;
      if(u.kind === 'image'){
        const w = Math.max(16, Math.min(800, +u.w || 160)) * 1.1;
        const img = isImageId(u.img) ? picture(u.img) : null;
        if(img){ const h2 = w * img.naturalHeight / img.naturalWidth; x.drawImage(img, cx - w / 2, cy - h2 / 2, w, h2); }
        return;
      }
      const size = (u.ts ? Math.max(6, Math.min(72, +u.ts)) : 18) * 2.2;
      x.font = '800 ' + size + 'px "Nunito Sans", system-ui, sans-serif';
      const text = String(u.text || '');
      const tw = Math.min(W * 0.9, x.measureText(text).width + 32), th = size + 22;
      const bg = u.bg || (u.kind === 'button' ? '#00b06f' : 'rgba(18,20,24,0.72)');
      if(u.kind === 'button'){
        button(hud, cx - tw / 2, cy - th / 2, tw, th, text, ()=>{ if(window.NeoScript) NeoScript.guiClick(u.id); }, { size, color: bg });
        if(u.tc){ /* drawn white for contrast in VR */ }
      } else {
        rr(x, cx - tw / 2, cy - th / 2, tw, th, 10); x.fillStyle = bg; x.fill();
        x.fillStyle = u.tc || '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, cx, cy + 1, tw - 16);
      }
    });
    // notifications along the bottom (not while the buy window is up — it gets the panel to itself)
    let ny = H - 70;
    if(!buy) notes.concat(bannerText ? [{ text: bannerText }] : []).slice().reverse().forEach(n=>{
      x.font = '800 36px "Nunito Sans", system-ui, sans-serif';
      const tw = Math.min(W * 0.9, x.measureText(n.text).width + 40);
      rr(x, W / 2 - tw / 2, ny - 30, tw, 60, 14); x.fillStyle = 'rgba(18,20,24,0.85)'; x.fill();
      x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(n.text, W / 2, ny + 1, tw - 24);
      ny -= 70;
    });
    if(buy) drawBuy(buy);
    hud.tex.needsUpdate = true;
  }
  // Neoblox's buy window, inside the headset (the same window as on the page — rbx/market.js)
  function drawBuy(m){
    const x = hud.x, W = hud.c.width, H = hud.c.height;
    const note = !m.note ? '' : typeof m.note === 'string' ? (m.login ? 'Log in on the Neoblox page to buy things (take the headset off)' : m.note)
      : m.note.need !== undefined ? 'You have ' + m.note.have + ' tokens — you need ' + m.note.need + ' more' : 'You have ' + m.note.have + ' tokens · after this: ' + m.note.after;
    // what goes in the window, top to bottom (so it's only as tall as it needs to be)
    const rows = [['brand', 44], ['pic', 132]];
    if(m.kind) rows.push(['kind', 30]);
    rows.push(['title', 50]);
    if(m.desc) rows.push(['desc', 36]);
    if(m.done) rows.push(['done', 48]);
    if(m.owned) rows.push(['owned', 48]);
    if(m.price !== null) rows.push(['price', 56]);
    if(note) rows.push(['note', 36]);
    if(m.err) rows.push(['err', 34]);
    const bw = 560, bh = rows.reduce((n, r)=> n + r[1], 0) + 24 + 66 + 24;
    const bx = W / 2 - bw / 2, by = Math.max(4, H / 2 - bh / 2);
    rr(x, bx, by, bw, bh, 24); x.fillStyle = '#2b2b2b'; x.fill();
    x.strokeStyle = '#474747'; x.lineWidth = 3; x.stroke();
    let y = by;
    const text = (t, font, color, align)=>{ x.font = font; x.fillStyle = color; x.textAlign = align || 'center'; x.textBaseline = 'middle'; };
    rows.forEach(([k, h])=>{
      const cy = y + h / 2;
      if(k === 'brand'){ text('', '800 20px "Nunito Sans", system-ui, sans-serif', '#9a9a9a', 'left'); x.fillText('NEOBLOX · BUY', bx + 24, y + 26); }
      else if(k === 'pic'){
        const pic = m.item && m.item.image ? picture(m.item.image) : null;
        if(pic) x.drawImage(pic, W / 2 - 60, y + 4, 120, 120);
        else { rr(x, W / 2 - 60, y + 4, 120, 120, 16); x.fillStyle = '#232323'; x.fill(); text('', '64px system-ui', '#fff'); x.fillText(m.item ? (m.item.kind === 'product' ? '🪙' : '🎟️') : '🚫', W / 2, y + 66); }
      }
      else if(k === 'kind'){ text('', '800 20px "Nunito Sans", system-ui, sans-serif', '#9ad1ff'); x.fillText(m.kind.toUpperCase(), W / 2, cy); }
      else if(k === 'title'){ text('', '900 36px "Nunito Sans", system-ui, sans-serif', '#fff'); x.fillText(m.title, W / 2, cy, bw - 40); }
      else if(k === 'desc'){ text('', '600 22px "Nunito Sans", system-ui, sans-serif', '#bdbdbd'); x.fillText(m.desc, W / 2, cy, bw - 40); }
      else if(k === 'done'){ text('', '900 32px "Nunito Sans", system-ui, sans-serif', '#3ddc84'); x.fillText(m.done, W / 2, cy); }
      else if(k === 'owned'){ text('', '900 30px "Nunito Sans", system-ui, sans-serif', '#fff'); x.fillText('✓ You already own this', W / 2, cy); }
      else if(k === 'price'){
        text('', '900 36px "Nunito Sans", system-ui, sans-serif', '#fff', 'left');
        const label = Number(m.price).toLocaleString(), tw = x.measureText(label).width, start = W / 2 - (40 + tw) / 2;
        coin(x, start + 18, cy, 18);
        text('', '900 36px "Nunito Sans", system-ui, sans-serif', '#fff', 'left'); x.fillText(label, start + 40, cy + 1);
      }
      else if(k === 'note'){ text('', '600 22px "Nunito Sans", system-ui, sans-serif', '#a8a8a8'); x.fillText(note, W / 2, cy, bw - 40); }
      else if(k === 'err'){ text('', '700 22px "Nunito Sans", system-ui, sans-serif', '#ff8a8a'); x.fillText(m.err, W / 2, cy, bw - 40); }
      y += h;
    });
    const by2 = y + 24, gap = 16;
    const hasBuy = !!m.buy && !m.login;
    const w2 = hasBuy ? (bw - 48 - gap) / 2 : bw - 48;
    if(hasBuy) button(hud, bx + 24, by2, w2, 66, m.buy.label + (m.buy.price !== undefined ? ' ' + Number(m.buy.price).toLocaleString() + ' tokens' : ''), ()=> NeoMarket.vrPress('buy'), { enabled: m.buy.enabled, color: '#00b06f', size: 26 });
    button(hud, bx + 24 + (hasBuy ? w2 + gap : 0), by2, w2, 66, m.login ? 'OK' : m.cancel, ()=> NeoMarket.vrPress('cancel'), { size: 26 });
  }

  // for the automated tests (a simulated headset): the play space, panels and hands
  VR._debug = ()=> ({ dolly, cam, scale, hud, wrist, hands, notes, orbit, floor });

  document.addEventListener('DOMContentLoaded', ()=>{ checkSupport(); showButton(); });
  if(document.readyState !== 'loading'){ checkSupport(); }
  setInterval(showButton, 700);
})();
