// rbx/vr.js — NeoVR: play Neoblox games and walk around the lobby in VR, in the Meta Quest
// browser (WebXR). Press "🥽 VR" in a game; the headset becomes the camera.
//
// Controllers:
//   left thumbstick   walk (where you're looking is forward)       A  jump
//   right thumbstick  turn (snap 30°, or smooth — wrist menu)      B  first ⇄ third person
//   trigger           point and click: menus, on-screen buttons,   X  show/hide the wrist menu
//                     clickable parts                              Y  (free for games)
//
// Hands (put the controllers down — the Quest switches to hand tracking by itself):
//   pinch (thumb + pointer finger)   clicks what you point at; point at the floor, hold the pinch
//                                    and let go to teleport there
//   poke with a finger               presses menu buttons and keyboard keys
//   turn your left palm to your face the hand menu: jump, turn, chat, and the wrist menu's buttons
//
// First person: you see through your avatar's eyes, your hands are blocky hands (with fingers when
// they're tracked), and walking around your room moves your avatar too (walls stop it). Third
// person: the view floats behind your avatar. Your height is measured when VR starts (and on
// Recenter), so the avatar's eyes are where yours are, standing or sitting.
//
// Things that are normally on the screen move into the headset: a wrist menu on your left hand
// (health, leaderboard, chat, view/turning settings, leave, exit VR), a panel that floats in front
// of you when a game shows something — its on-screen labels and buttons, notifications, chat
// messages and Neoblox's buy window — and the chat: a panel with the latest messages, quick
// messages and a keyboard you point at or poke. While you use a menu, the blocky hands turn into
// real Quest controllers in Neoblox's colours, so you can see the buttons. Scripts get the
// controller buttons as Enum.KeyCode.ButtonA… and can check UserInputService.VREnabled.
'use strict';
(function(){
  const VR = window.NeoVR = {};
  const EYE = 1.72;          // the avatar's eye height above its feet
  const BACK = 4.2, UP = 1.1; // third person: how far behind and above
  const SNAP = Math.PI / 6;  // 30°
  const SMOOTH = 2.2;        // radians per second at full stick
  const DEAD = 0.15;         // thumbstick dead zone
  const TELE_FAR = 30;       // how far a teleport can reach (world units)
  const HANDS = 40;          // draw order: hands and controllers after the panels (20) and lasers (30)
  const BUTTON_NAMES = { right:{ 1:'ButtonR1', 4:'ButtonA', 5:'ButtonB' }, left:{ 1:'ButtonL1', 4:'ButtonX', 5:'ButtonY' } };
  const FONT = '"Nunito Sans", system-ui, sans-serif';
  // the Neoblox logo: a cube with a lime top, a cyan side and a purple side, on dark navy
  const LOGO = { lime: 0xc8ff4d, cyan: 0x4de3ff, purple: 0xb06bff, ink: 0x1b2033 };

  const set = Object.assign({ view:'first', turn:'snap' }, (()=>{ try{ return JSON.parse(localStorage.getItem('nb_vr')) || {}; }catch(e){ return {}; } })());
  const save = ()=>{ try{ localStorage.setItem('nb_vr', JSON.stringify(set)); }catch(e){} };

  let supported = false, session = null, starting = false, floor = true;
  let dolly = null, cam = null, scale = 1, calibrated = false, orbit = 0, placed = false;
  let snapReady = true, wristOn = true, palmOn = false;
  let jumpUntil = 0;         // the hand menu's Jump button holds "jump" for a moment
  let menuUntil = 0;         // controllers show as real Quest controllers until then (pointing at a menu)
  let teleports = 0, handHint = false;
  const hands = [];          // per input index: { ray, grip, hand, mesh, laser, dot, src, … }
  let wrist = null, hud = null, hudYaw = null;
  let tele = null;           // the teleport target ring
  const notes = [];          // recent toasts / notifications / chat messages for the floating panel
  let saved = null;          // renderer/scene settings to put back after VR
  let tmp = null;
  const T = ()=> tmp || (tmp = { v: new THREE.Vector3(), v2: new THREE.Vector3(), q: new THREE.Quaternion(), ray: new THREE.Raycaster(), m: new THREE.Matrix4(), m2: new THREE.Matrix4(), up: new THREE.Vector3(0, 1, 0) });

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
      const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
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
    calibrated = false; placed = false; snapReady = true; wristOn = true; palmOn = false; hudYaw = null;
    jumpUntil = 0; menuUntil = 0; handHint = false;
    App.inputAnalog = { x:0, y:0 };
    readControllers.lp = null; readControllers.rp = null;
    hands.forEach(h=>{ h.trig = false; h.toScripts = false; h.pinch = false; h.pdown = false; h.aim = null; h.pokes = {}; });
    chat.open = false; chat.text = ''; chat.caps = false; chat.seen = null;
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
    if(tele && tele.g.parent) tele.g.parent.remove(tele.g);
    if(dolly && dolly.parent) dolly.parent.remove(dolly);
    if(cam && cam.parent === dolly){ dolly.remove(cam); cam.position.set(0, 2, 5); cam.rotation.set(0, 0, 0); cam.scale.set(1, 1, 1); }
    dolly = null; cam = null;
    chat.open = false; if(chat.panel) chat.panel.mesh.visible = false;
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
    buildHands(); buildPanels(); buildChat();
    hands.forEach(h=>{ dolly.add(h.ray); dolly.add(h.grip); dolly.add(h.hand); });
    dolly.add(hud.mesh);
    dolly.add(chat.panel.mesh);
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
  // turn a panel (a child of the play space) to face your head
  function faceHead(mesh){
    const t = T();
    t.m2.lookAt(cam.position, mesh.position, t.up); // +Z (the panel's front) toward the head
    mesh.quaternion.setFromRotationMatrix(t.m2);
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
    dolly.updateMatrixWorld(true);
    const hy = headYaw();
    App.yaw = hy.yaw; App.pitch = hy.pitch;
    readControllers(dt);
    handsTick();
    pointers();
    if(session && cam) pokes();
    if(!session || !cam) return; // a menu button just ended VR
    drawWrist();
    drawHud(hy);
    drawChat();
    chatWatch();
    looks();
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
      const h = hands[i]; if(h) h.src = s;
      if(s.hand) continue; // tracked hands have no sticks or buttons
      if(s.handedness === 'left') left = s; else if(s.handedness === 'right') right = s;
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
    App.input.jump = pressed(right, 4) || performance.now() < jumpUntil;
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
  VR.jump = function(){ jumpUntil = performance.now() + 160; };
  VR.turn = function(dir){ if(dolly) turn(dir < 0 ? SNAP : -SNAP); }; // -1 left, 1 right

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
      const ray = r.xr.getController(i), grip = r.xr.getControllerGrip(i), hand = r.xr.getHand(i);
      const mat = new THREE.MeshLambertMaterial({ color: skin, transparent: true }); // "transparent": drawn after the panels (see makePanel)
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.12), mat);
      mesh.position.set(0, -0.01, 0.03); mesh.renderOrder = HANDS;
      grip.add(mesh);
      const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const laser = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
      laser.renderOrder = 30; laser.frustumCulled = false; laser.visible = false;
      ray.add(laser);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      dot.renderOrder = 31; dot.visible = false;
      ray.add(dot);
      hands.push({ ray, grip, hand, mat, mesh, laser, dot, src: null, trig: false, pinch: false, pdown: false, aim: null, pokes: {}, bones: null, model: null, modelKey: null });
    }
  }

  // Tracked hands: blocky Neoblox hands with fingers, built from the 25 joints the headset tracks.
  const FINGERS = ['thumb', 'index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
  const chain = (f)=> f === 'thumb' ? ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']
    : [f + '-phalanx-proximal', f + '-phalanx-intermediate', f + '-phalanx-distal', f + '-tip'];
  function buildFingers(h){
    const unit = new THREE.BoxGeometry(1, 1, 1);
    h.bones = [];
    FINGERS.forEach(f=>{
      const c = chain(f);
      for(let i = 0; i < c.length - 1; i++){
        const m = new THREE.Mesh(unit, h.mat); m.name = 'vr-finger'; m.renderOrder = HANDS;
        h.hand.add(m);
        h.bones.push({ a: c[i], b: c[i + 1], m, w: f === 'thumb' ? 0.024 : f === 'pinky-finger' ? 0.017 : 0.02 });
      }
    });
    h.palm = new THREE.Mesh(unit, h.mat); h.palm.name = 'vr-palm'; h.palm.renderOrder = HANDS;
    h.hand.add(h.palm);
  }
  // put a box between two joints: `len` along a→b, `up` for which way its top faces
  const BX = new THREE.Vector3(), BY = new THREE.Vector3(), BZ = new THREE.Vector3(), BM = new THREE.Matrix4();
  function boxBetween(m, a, b, up, w, th, extra){
    BZ.copy(a).sub(b); const len = BZ.length();
    if(len < 1e-5){ m.visible = false; return; }
    BZ.multiplyScalar(1 / len);
    BY.copy(up).addScaledVector(BZ, -up.dot(BZ));
    if(BY.lengthSq() < 1e-8) BY.set(0, 1, 0).addScaledVector(BZ, -BZ.y);
    BY.normalize(); BX.crossVectors(BY, BZ);
    BM.makeBasis(BX, BY, BZ);
    m.quaternion.setFromRotationMatrix(BM);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.scale.set(w, th, len + extra);
    m.visible = true;
  }
  function handsTick(){
    let leftPalm = false;
    hands.forEach(h=>{
      const src = h.src, J = h.hand.joints || {};
      const P = (n)=> J[n] && J[n].visible ? J[n].position : null;
      h.tracked = !!(src && src.hand && h.hand.visible && P('wrist'));
      if(!h.tracked){ h.pinch = false; return; }
      if(!h.bones) buildFingers(h);
      if(!handHint){ handHint = true; addNote('✋ Pinch: click · Point at the floor + pinch: teleport · Left palm to your face: menu'); }
      const w = P('wrist'), ip = P('index-finger-phalanx-proximal'), pp = P('pinky-finger-phalanx-proximal'), mp = P('middle-finger-phalanx-proximal');
      if(!ip || !pp || !mp){ h.tracked = false; h.pinch = false; return; }
      // which way the palm faces (out of the palm), worked out from the knuckles
      const a = new THREE.Vector3().subVectors(ip, w), b = new THREE.Vector3().subVectors(pp, w);
      const n = (src.handedness === 'left' ? new THREE.Vector3().crossVectors(b, a) : new THREE.Vector3().crossVectors(a, b)).normalize();
      const knuckles = new THREE.Vector3().addVectors(ip, pp).multiplyScalar(0.5);
      h.normal = n;
      h.up = new THREE.Vector3().subVectors(mp, w).normalize();
      h.center = new THREE.Vector3().addVectors(w, knuckles).multiplyScalar(0.5);
      h.bones.forEach(bn=>{ const A = P(bn.a), B = P(bn.b); if(A && B) boxBetween(bn.m, A, B, n, bn.w, 0.018, 0.008); else bn.m.visible = false; });
      boxBetween(h.palm, w, knuckles, n, ip.distanceTo(pp) + 0.025, 0.028, 0.01);
      // pinch: thumb tip touching the pointer finger's tip
      const tt = P('thumb-tip'), it = P('index-finger-tip');
      if(tt && it){ const d = tt.distanceTo(it); h.pinch = h.pinch ? d < 0.03 : d < 0.018; }
      else h.pinch = false;
      // the hand menu: your left palm turned toward your face
      if(src.handedness === 'left'){
        const f = n.dot(new THREE.Vector3().subVectors(cam.position, h.center).normalize());
        leftPalm = palmOn ? f > 0.45 : f > 0.72;
      }
    });
    palmOn = leftPalm;
  }

  // each hand points: at a panel button, a clickable part, the floor (hands), or nothing.
  // Controllers click with the trigger; hands click (and teleport) with a pinch.
  function pointers(){
    const t = T(), now = performance.now();
    const pans = livePanels();
    pans.forEach(p=>{ p.hoverNext = -1; });
    hands.forEach(h=>{
      const src = h.src;
      h.laser.visible = false; h.dot.visible = false;
      if(!src || !h.ray.visible){ h.trig = false; h.pdown = false; h.aim = null; scriptsUp(h); return; }
      const isHand = !!src.hand;
      h.ray.updateMatrixWorld(true);
      const origin = new THREE.Vector3().setFromMatrixPosition(h.ray.matrixWorld);
      t.q.setFromRotationMatrix(t.m.extractRotation(h.ray.matrixWorld));
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(t.q).normalize();
      const hit = panelHit(origin, dir, src.handedness === 'left', pans);
      let part = null;
      if(!hit && window.NeoScript && NeoScript.rayPick) part = NeoScript.rayPick(origin, dir, false);
      if(hit && hit.button) hit.panel.hoverNext = hit.panel.buttons.indexOf(hit.button);
      if(hit && !isHand && hit.panel.buttons.length) menuUntil = now + 700; // pointing at a menu: the real controllers come out
      let dist = hit ? hit.distance : part ? part.distance : 0;
      let color = hit && hit.button ? 0x4dd2ff : part ? 0xffd400 : 0xffffff;
      if(isHand){
        scriptsUp(h);
        if(h.pinch !== h.pdown){
          h.pdown = h.pinch;
          if(h.pdown){
            if(hit){ if(hit.button) press(hit.panel, hit.button, src); }
            else if(part && window.NeoScript) NeoScript.rayPick(origin, dir, true);
            else h.aim = { ok: false, point: null }; // aiming a teleport until the pinch lets go
          } else if(h.aim){
            if(h.aim.ok) teleportTo(h.aim.point);
            h.aim = null;
          }
        }
        if(h.aim && h.pdown){
          const f = floorHit(origin, dir);
          h.aim = f ? { ok: f.ok, point: f.point } : { ok: false, point: null };
          if(f){ dist = f.distance; color = f.ok ? LOGO.cyan : 0xff5a5a; }
        }
      } else {
        h.aim = null; h.pdown = false;
        const trig = pressed(src, 0);
        if(trig !== h.trig){
          h.trig = trig;
          const side = src.handedness === 'left' ? 'ButtonL2' : 'ButtonR2';
          if(trig && hit){ if(hit.button) press(hit.panel, hit.button, src); }
          else if(trig && part && window.NeoScript) NeoScript.rayPick(origin, dir, true);
          else if(trig){ h.toScripts = true; if(window.NeoScript && NeoScript.vrButton) NeoScript.vrButton(side, true); }
          if(!trig) scriptsUp(h);
        }
      }
      if(dist){
        const local = dist / scale; // the ray lives in the (scaled) play space
        h.laser.visible = true; h.laser.scale.set(1, 1, local);
        h.dot.visible = true; h.dot.position.set(0, 0, -local);
        h.laser.material.color.setHex(color);
      }
    });
    // the teleport target, on the floor where a pinching hand points
    const aimer = hands.find(h=> h.aim && h.aim.point);
    if(aimer && App.scene){
      const r = ring();
      if(r.g.parent !== App.scene) App.scene.add(r.g);
      r.g.position.copy(aimer.aim.point); r.g.position.y += 0.04;
      r.mats.forEach(m=> m.color.setHex(aimer.aim.ok ? LOGO.cyan : 0xff5a5a));
      r.g.visible = true;
    } else if(tele) tele.g.visible = false;
    pans.forEach(p=>{ if(p.hoverNext !== p.hover){ p.hover = p.hoverNext; p.key = ''; } });
  }
  function scriptsUp(h){
    if(!h.toScripts) return;
    h.toScripts = false;
    const side = h.src && h.src.handedness === 'left' ? 'ButtonL2' : 'ButtonR2';
    if(window.NeoScript && NeoScript.vrButton) NeoScript.vrButton(side, false);
  }

  // poke: a tracked finger tip pushing into a panel presses the button under it
  function pokes(){
    const pans = livePanels();
    if(!pans.length) return;
    const tip = new THREE.Vector3(), head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld), inv = new THREE.Matrix4();
    hands.forEach(h=>{
      if(!h.tracked) return;
      const j = h.hand.joints['index-finger-tip'];
      if(!j || !j.visible) return;
      tip.setFromMatrixPosition(j.matrixWorld);
      pans.forEach(pn=>{
        if(pn === wrist && h.src.handedness === 'left') return; // the hand menu is on this hand
        inv.copy(pn.mesh.matrixWorld).invert();
        const lp = tip.clone().applyMatrix4(inv), side = head.clone().applyMatrix4(inv).z >= 0 ? 1 : -1;
        const d = lp.z * side, inside = Math.abs(lp.x) <= pn.w / 2 && Math.abs(lp.y) <= pn.h / 2;
        const st = h.pokes[pn.name] || (h.pokes[pn.name] = { armed: true });
        if(!inside || d > 0.03){ st.armed = true; return; }
        if(st.armed && d < 0.01 && d > -0.06){
          st.armed = false;
          const b = buttonAt(pn, (lp.x / pn.w + 0.5) * pn.c.width, (0.5 - lp.y / pn.h) * pn.c.height);
          if(b) press(pn, b, h.src);
        }
      });
    });
  }

  // ------------------------------------------------------------------ teleporting (hands)
  function ring(){
    if(tele) return tele;
    const g = new THREE.Group(); g.name = 'vr-teleport';
    const m1 = new THREE.MeshBasicMaterial({ color: LOGO.cyan, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    const m2 = m1.clone(); m2.opacity = 0.45;
    const r1 = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.46, 40), m1); r1.rotation.x = -Math.PI / 2;
    const r2 = new THREE.Mesh(new THREE.CircleGeometry(0.14, 24), m2); r2.rotation.x = -Math.PI / 2;
    g.add(r1); g.add(r2); g.visible = false;
    return (tele = { g, mats: [m1, m2] });
  }
  // where a hand's ray meets something you could stand on (and whether you can go there)
  function floorHit(origin, dir){
    const t = T();
    let best = null;
    if(App.mode === 'play' && App.blockGroup){
      t.ray.set(origin, dir); t.ray.far = TELE_FAR;
      const list = App.blockGroup.children.filter(m=> m.visible && !(m.userData.props && m.userData.props.nc));
      const hit = t.ray.intersectObjects(list, false)[0];
      if(hit){
        let up = 0;
        if(hit.face){ const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld); up = hit.face.normal.clone().applyMatrix3(nm).normalize().y; }
        best = { point: hit.point.clone(), up, distance: hit.distance };
      }
    }
    // the flat ground: the lobby's floor, or a game's baseplate
    if(dir.y < -0.02){
      const k = (0 - origin.y) / dir.y;
      if(k > 0 && k < TELE_FAR && (!best || k < best.distance)){
        const pt = origin.clone().addScaledVector(dir, k);
        const ground = App.mode === 'lobby' ? Math.hypot(pt.x, pt.z) < 23 : (typeof worldHasBaseplate === 'function' && worldHasBaseplate() && insideBuildArea(pt));
        if(ground) best = { point: pt, up: 1, distance: k };
      }
    }
    if(!best) return null;
    const pt = best.point;
    let ok = best.up > 0.7;
    if(ok && App.mode === 'play'){
      const top = columnTopAt(pt.x, pt.z, pt.y + 0.3);
      const g = top !== null ? top : (worldHasBaseplate() && insideBuildArea(pt) ? 0 : null);
      ok = g !== null && Math.abs(g - pt.y) < 0.6;
      if(ok) pt.y = g;
    } else if(ok && App.mode === 'lobby'){ ok = Math.hypot(pt.x, pt.z) < 23; pt.y = 0; }
    if(ok && App.player && App.player.pos.distanceTo(pt) > TELE_FAR) ok = false;
    if(ok && App.hum && App.hum.dead) ok = false;
    return { point: pt, ok, distance: best.distance };
  }
  function teleportTo(pt){
    const p = App.player; if(!p || !pt) return;
    if(App.hum && App.hum.dead) return;
    p.pos.set(pt.x, pt.y + 0.01, pt.z);
    if(p.vel) p.vel.set(0, 0, 0);
    if(p.rig) p.rig.group.position.copy(p.pos);
    placed = false; VR.follow.last = null;
    teleports++;
  }

  // ------------------------------------------------------------------ panels (drawn on canvases)
  function makePanel(w, h, px){
    const c = document.createElement('canvas'); c.width = Math.round(w * px); c.height = Math.round(h * px);
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    // Panels are drawn over the world (so a wall can't hide a menu) but still mark their depth, and
    // your hands are drawn after them — so a finger in front of the keyboard shows in front of it,
    // and a hand behind a menu is hidden by it.
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthFunc: THREE.AlwaysDepth, alphaTest: 0.02, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.renderOrder = 20; mesh.frustumCulled = false;
    return { c, x: c.getContext('2d'), tex, mesh, w, h, buttons: [], key: '', hover: -1, flash: -1, flashUntil: 0 };
  }
  function buildPanels(){
    if(wrist) return;
    wrist = makePanel(0.26, 0.31, 1600); wrist.name = 'wrist';
    hud = makePanel(1.2, 0.675, 1066); hud.name = 'hud';
    hud.mesh.visible = false;
  }
  // is it really on screen (it and everything it hangs from is shown, all the way up to the scene)?
  function shown(o){ for(let n = o; n; n = n.parent){ if(!n.visible) return false; if(n === App.scene) return true; } return false; }
  function livePanels(){ return [wrist, hud, chat.panel].filter(p=> p && shown(p.mesh)); }
  function panelHit(origin, dir, skipWrist, pans){
    const t = T();
    const list = (pans || livePanels()).filter(p=> !(skipWrist && p === wrist));
    if(!list.length) return null;
    t.ray.set(origin, dir); t.ray.far = 30;
    let best = null;
    for(const pn of list){
      pn.mesh.updateMatrixWorld(true);
      const hit = t.ray.intersectObject(pn.mesh, false)[0];
      if(!hit || !hit.uv || (best && best.distance <= hit.distance)) continue;
      best = { panel: pn, button: buttonAt(pn, hit.uv.x * pn.c.width, (1 - hit.uv.y) * pn.c.height), distance: hit.distance };
    }
    return best;
  }
  function buttonAt(pn, x, y){ return pn.buttons.find(b=> x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && b.enabled !== false) || null; }
  function buzz(src, s, ms){ try{ const a = src && src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0]; if(a && a.pulse) a.pulse(s, ms); }catch(e){} }
  function press(pn, b, src){
    pn.flash = pn.buttons.indexOf(b); pn.flashUntil = performance.now() + 160;
    buzz(src, 0.35, 25);
    try{ b.act(); }catch(e){ console.error(e); }
    pn.key = '';
  }
  const lit = (pn)=> pn.hover + ':' + (performance.now() < pn.flashUntil ? pn.flash : -1);
  function rr(x, X, Y, W, H, R){ x.beginPath(); x.moveTo(X + R, Y); x.arcTo(X + W, Y, X + W, Y + H, R); x.arcTo(X + W, Y + H, X, Y + H, R); x.arcTo(X, Y + H, X, Y, R); x.arcTo(X, Y, X + W, Y, R); x.closePath(); }
  function button(pn, X, Y, W, H, label, act, opts){
    opts = opts || {};
    const x = pn.x, on = opts.enabled !== false, i = pn.buttons.length;
    const glow = on && (i === pn.hover || (i === pn.flash && performance.now() < pn.flashUntil));
    rr(x, X, Y, W, H, opts.r || 14); x.fillStyle = !on ? 'rgba(70,70,70,0.9)' : opts.color || 'rgba(58,58,58,0.95)'; x.fill();
    if(glow){ x.fillStyle = 'rgba(255,255,255,0.22)'; x.fill(); x.strokeStyle = '#4de3ff'; x.lineWidth = 4; x.stroke(); }
    x.fillStyle = on ? (opts.text || '#fff') : '#9a9a9a'; x.font = '800 ' + (opts.size || 30) + 'px ' + FONT; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(label, X + W / 2, Y + H / 2 + 1, W - 12);
    pn.buttons.push({ x: X, y: Y, w: W, h: H, act, enabled: on, label });
  }
  function coin(x, cx, cy, r){
    const g = x.createRadialGradient(cx - r * .3, cy - r * .4, r * .1, cx, cy, r);
    g.addColorStop(0, '#fff2b0'); g.addColorStop(.45, '#ffc83d'); g.addColorStop(1, '#d49400');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#7a5400'; x.font = '900 ' + Math.round(r * 1.1) + 'px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('N', cx, cy + 1);
  }
  // text that fits in `w` pixels: cut with "…" (or, for what you're typing, keep the end)
  function fit(x, s, w){ s = String(s); if(x.measureText(s).width <= w) return s; let a = [...s]; while(a.length && x.measureText(a.join('') + '…').width > w) a.pop(); return a.join('') + '…'; }
  function tail(x, s, w){ let a = [...String(s)]; if(x.measureText(a.join('')).width <= w) return a.join(''); while(a.length && x.measureText('…' + a.join('')).width > w) a.shift(); return '…' + a.join(''); }

  // the wrist menu: on your left controller, or — with hand tracking — over your left palm when you
  // turn it toward your face
  function drawWrist(){
    if(!wrist) return;
    const lh = hands.find(h=> h.tracked && h.src.handedness === 'left');
    const lc = hands.find(h=> h.src && !h.src.hand && h.src.handedness === 'left');
    if(lh){
      if(wrist.mesh.parent !== dolly){ dolly.add(wrist.mesh); wrist.mesh.rotation.set(0, 0, 0); wrist.near = false; }
      wrist.mesh.visible = palmOn;
      if(!palmOn){ wrist.near = false; return; }
      // just above the palm, toward your face; it follows the hand smoothly (tracking wobbles a bit)
      const want = lh.center.clone().addScaledVector(lh.normal, 0.07).addScaledVector(lh.up, 0.07);
      if(!wrist.near){ wrist.mesh.position.copy(want); wrist.near = true; } else wrist.mesh.position.lerp(want, 0.35);
      faceHead(wrist.mesh);
    } else if(lc){
      if(wrist.mesh.parent !== lc.grip){
        lc.grip.add(wrist.mesh);
        wrist.mesh.position.set(0, 0.075, 0.02); wrist.mesh.rotation.set(-1.0, 0, 0);
      }
      wrist.mesh.visible = wristOn;
      if(!wristOn) return;
    } else { if(wrist.mesh.parent) wrist.mesh.parent.remove(wrist.mesh); return; }
    const h = App.hum, ls = App.leaderstats || {};
    const title = App.mode === 'lobby' ? 'Lobby' : ((App.currentWorldData && App.currentWorldData.name) || 'Game');
    const key = [title, h ? Math.round(h.health) + '/' + h.maxHealth : '', JSON.stringify(ls), set.view, set.turn, chat.open, lit(wrist)].join('|');
    if(key === wrist.key) return;
    wrist.key = key; wrist.buttons = [];
    const x = wrist.x, W = wrist.c.width, H = wrist.c.height;
    x.clearRect(0, 0, W, H);
    rr(x, 4, 4, W - 8, H - 8, 26); x.fillStyle = 'rgba(22,24,28,0.92)'; x.fill();
    x.fillStyle = '#fff'; x.font = '900 34px ' + FONT; x.textAlign = 'left'; x.textBaseline = 'top';
    x.fillText('🥽 ' + title, 26, 22, W - 52);
    let y = 74;
    if(h){
      const f = Math.max(0, Math.min(1, h.health / (h.maxHealth || 100)));
      rr(x, 26, y, W - 52, 22, 11); x.fillStyle = 'rgba(255,255,255,0.15)'; x.fill();
      if(f > 0){ rr(x, 26, y, Math.max(22, (W - 52) * f), 22, 11); x.fillStyle = f > 0.5 ? '#3ddc84' : f > 0.25 ? '#ffd400' : '#ff4d4d'; x.fill(); }
      y += 36;
    }
    const stats = Object.keys(ls).slice(0, 3);
    x.font = '700 26px ' + FONT; x.fillStyle = '#cfd6e4';
    stats.forEach(k=>{ x.fillText(k + ': ' + ls[k], 26, y, W - 52); y += 32; });
    const bh = 58, gap = 10;
    y = Math.max(y + 6, H - 16 - 4 * (bh + gap) + gap);
    // jump / turn / chat (handy with hand tracking, where there are no buttons to press)
    const qw = (W - 52 - 3 * 8) / 4;
    button(wrist, 26, y, qw, bh, '⬆ Jump', ()=> VR.jump(), { size: 22, color: 'rgba(0,176,111,0.95)' });
    button(wrist, 26 + (qw + 8), y, qw, bh, '↺', ()=> VR.turn(-1), { size: 30 });
    button(wrist, 26 + 2 * (qw + 8), y, qw, bh, '↻', ()=> VR.turn(1), { size: 30 });
    button(wrist, 26 + 3 * (qw + 8), y, qw, bh, chat.open ? '💬 Close' : '💬 Chat', ()=> VR.openChat(), { size: 21, color: 'rgba(31,111,209,0.95)' });
    y += bh + gap;
    const bw = (W - 52 - 12) / 2;
    button(wrist, 26, y, bw, bh, set.view === 'first' ? '👁 First person' : '🎥 Third person', ()=> VR.setView(set.view === 'first' ? 'third' : 'first'), { size: 24 });
    button(wrist, 26 + bw + 12, y, bw, bh, set.turn === 'snap' ? '↻ Snap turn' : '↻ Smooth turn', ()=> VR.setTurn(set.turn === 'snap' ? 'smooth' : 'snap'), { size: 24 });
    y += bh + gap;
    button(wrist, 26, y, bw, bh, '⊙ Recenter', ()=> VR.recenter(), { size: 24 });
    button(wrist, 26 + bw + 12, y, bw, bh, '🚪 Leave game', ()=>{ VR.exit(); setTimeout(()=>{ if(typeof backToMenu === 'function') backToMenu(); }, 0); }, { size: 24, color: 'rgba(120,40,40,0.95)' });
    y += bh + gap;
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
    // a little higher while the chat is open, so the chat panel below doesn't cover it
    hud.mesh.position.set(hp.x + Math.sin(hudYaw) * 1.3, hp.y - 0.12 + (chat.open ? 0.22 : 0), hp.z + Math.cos(hudYaw) * 1.3);
    hud.mesh.rotation.set(0, hudYaw + Math.PI, 0);
    hud.mesh.visible = true;
    const key = JSON.stringify([ui.map(u=> [u.id, u.kind, u.text, u.xPct, u.yPct, u.tc, u.bg, u.ts, u.img, u.w]), notes.map(n=> n.text), bannerText, buy, lit(hud)]);
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
      x.font = '800 ' + size + 'px ' + FONT;
      const text = String(u.text || '');
      const tw = Math.min(W * 0.9, x.measureText(text).width + 32), th = size + 22;
      const bg = u.bg || (u.kind === 'button' ? '#00b06f' : 'rgba(18,20,24,0.72)');
      if(u.kind === 'button'){
        button(hud, cx - tw / 2, cy - th / 2, tw, th, text, ()=>{ if(window.NeoScript) NeoScript.guiClick(u.id); }, { size, color: bg });
      } else {
        rr(x, cx - tw / 2, cy - th / 2, tw, th, 10); x.fillStyle = bg; x.fill();
        x.fillStyle = u.tc || '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, cx, cy + 1, tw - 16);
      }
    });
    // notifications along the bottom (not while the buy window is up — it gets the panel to itself)
    let ny = H - 70;
    if(!buy) notes.concat(bannerText ? [{ text: bannerText }] : []).slice().reverse().forEach(n=>{
      x.font = '800 36px ' + FONT;
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
      if(k === 'brand'){ text('', '800 20px ' + FONT, '#9a9a9a', 'left'); x.fillText('NEOBLOX · BUY', bx + 24, y + 26); }
      else if(k === 'pic'){
        const pic = m.item && m.item.image ? picture(m.item.image) : null;
        if(pic) x.drawImage(pic, W / 2 - 60, y + 4, 120, 120);
        else { rr(x, W / 2 - 60, y + 4, 120, 120, 16); x.fillStyle = '#232323'; x.fill(); text('', '64px system-ui', '#fff'); x.fillText(m.item ? (m.item.kind === 'product' ? '🪙' : '🎟️') : '🚫', W / 2, y + 66); }
      }
      else if(k === 'kind'){ text('', '800 20px ' + FONT, '#9ad1ff'); x.fillText(m.kind.toUpperCase(), W / 2, cy); }
      else if(k === 'title'){ text('', '900 36px ' + FONT, '#fff'); x.fillText(m.title, W / 2, cy, bw - 40); }
      else if(k === 'desc'){ text('', '600 22px ' + FONT, '#bdbdbd'); x.fillText(m.desc, W / 2, cy, bw - 40); }
      else if(k === 'done'){ text('', '900 32px ' + FONT, '#3ddc84'); x.fillText(m.done, W / 2, cy); }
      else if(k === 'owned'){ text('', '900 30px ' + FONT, '#fff'); x.fillText('✓ You already own this', W / 2, cy); }
      else if(k === 'price'){
        text('', '900 36px ' + FONT, '#fff', 'left');
        const label = Number(m.price).toLocaleString(), tw = x.measureText(label).width, start = W / 2 - (40 + tw) / 2;
        coin(x, start + 18, cy, 18);
        text('', '900 36px ' + FONT, '#fff', 'left'); x.fillText(label, start + 40, cy + 1);
      }
      else if(k === 'note'){ text('', '600 22px ' + FONT, '#a8a8a8'); x.fillText(note, W / 2, cy, bw - 40); }
      else if(k === 'err'){ text('', '700 22px ' + FONT, '#ff8a8a'); x.fillText(m.err, W / 2, cy, bw - 40); }
      y += h;
    });
    const by2 = y + 24, gap = 16;
    const hasBuy = !!m.buy && !m.login;
    const w2 = hasBuy ? (bw - 48 - gap) / 2 : bw - 48;
    if(hasBuy) button(hud, bx + 24, by2, w2, 66, m.buy.label + (m.buy.price !== undefined ? ' ' + Number(m.buy.price).toLocaleString() + ' tokens' : ''), ()=> NeoMarket.vrPress('buy'), { enabled: m.buy.enabled, color: '#00b06f', size: 26 });
    button(hud, bx + 24 + (hasBuy ? w2 + gap : 0), by2, w2, 66, m.login ? 'OK' : m.cancel, ()=> NeoMarket.vrPress('cancel'), { size: 26 });
  }

  // ------------------------------------------------------------------ chat
  // A panel in front of you, a bit below your eyes: the latest messages, what you're typing, quick
  // messages, and a keyboard. Point and click (trigger or pinch), or poke the keys with a finger.
  // It sends exactly like the chat box on the screen (so game scripts hear it too: player.Chatted).
  const QUICK = ['Hi!', 'GG', 'Follow me!', 'Yes', 'No', 'Thanks!'];
  const KEYS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '\''],
    ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '?'],
    [['😀', 1], ['👍', 1], ['space', 5], ['!', 1], ['send', 3]],
  ];
  const MAX_CHAT = 200;
  const chat = { open: false, text: '', caps: false, scope: 'global', picked: false, panel: null, seen: null, sent: 0 };
  function buildChat(){ if(!chat.panel){ chat.panel = makePanel(0.64, 0.58, 1100); chat.panel.name = 'chat'; chat.panel.mesh.visible = false; } }
  const hasParty = ()=>{ try{ return !!Net.party; }catch(e){ return false; } };
  const myNetId = ()=>{ try{ return Net.id; }catch(e){ return null; } };
  VR.openChat = function(open){
    if(open === undefined) open = !chat.open;
    if(open && (!session || !cam || !dolly)) return false;
    buildChat();
    chat.open = !!open; chat.panel.key = '';
    if(!chat.open){ chat.panel.mesh.visible = false; return true; }
    if(App.mode === 'lobby' && (!chat.picked || !hasParty())) chat.scope = hasParty() ? 'party' : 'global';
    // in front of you, low enough to reach with your hands, tilted toward your face
    const yaw = headYaw().local, hp = cam.position;
    if(chat.panel.mesh.parent !== dolly) dolly.add(chat.panel.mesh);
    chat.panel.mesh.position.set(hp.x + Math.sin(yaw) * 0.42, hp.y - 0.4, hp.z + Math.cos(yaw) * 0.42);
    faceHead(chat.panel.mesh);
    chat.panel.mesh.visible = true;
    chat.panel.mesh.updateMatrixWorld(true);
    return true;
  };
  function chatLines(n){
    try{
      if(App.mode === 'play' && window.RbxHud && RbxHud.chatLog) return RbxHud.chatLog(n).map(m=> m.sys ? { sys: true, text: m.text } : { name: (m.tag || '') + (m.name || 'Player'), who: m.name, text: m.text });
      if(App.mode === 'lobby') return (ChatLogs[chat.scope] || []).slice(-n).map(m=> ({ name: m.name || 'Player', who: m.name, text: m.text }));
    }catch(e){}
    return [];
  }
  function chatSend(text){
    text = String(text || '').trim().slice(0, MAX_CHAT);
    if(!text) return false;
    try{
      if(App.mode === 'play' && window.RbxHud && RbxHud.sendChat){ RbxHud.sendChat(text); chat.sent++; return true; }
      if(App.mode === 'lobby'){
        if(typeof handleChatCommand === 'function' && handleChatCommand(text)){ chat.sent++; return true; }
        if(!Net.connected){ addNote('💬 Chat needs the server — check your connection'); return false; }
        netSend({ t: 'chat', scope: chat.scope === 'party' && hasParty() ? 'party' : 'global', text });
        chat.sent++; return true;
      }
    }catch(e){ console.error(e); }
    return false;
  }
  function typeKey(k){
    if(k === '⌫') chat.text = [...chat.text].slice(0, -1).join('');
    else if(k === '⇧') chat.caps = !chat.caps;
    else if(k === 'send'){ if(chatSend(chat.text)) chat.text = ''; }
    else {
      const s = k === 'space' ? ' ' : chat.caps ? k.toUpperCase() : k;
      if(chat.text.length + s.length <= MAX_CHAT) chat.text += s;
      if(chat.caps && k !== 'space') chat.caps = false; // like a phone: one capital letter
    }
  }
  VR.chat = { send: chatSend, type: typeKey, text: ()=> chat.text, isOpen: ()=> chat.open };
  const NAME_COLORS = ['#fd2943', '#01a2ff', '#02b857', '#a75cff', '#f5a623', '#ff6ec7', '#4de3ff', '#c8ff4d'];
  function nameColor(name){
    if(window.RbxHud && RbxHud.nameColor) return RbxHud.nameColor(name);
    let h = 0; const s = String(name || ''); for(let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return NAME_COLORS[h % NAME_COLORS.length];
  }
  function drawChat(){
    const pn = chat.panel; if(!pn) return;
    pn.mesh.visible = chat.open;
    if(!chat.open) return;
    const lobby = App.mode === 'lobby', party = lobby && hasParty();
    const lines = chatLines(5);
    const key = JSON.stringify([lines, chat.text, chat.caps, chat.scope, lobby, party, lit(pn)]);
    if(key === pn.key) return;
    pn.key = key; pn.buttons = [];
    const x = pn.x, W = pn.c.width, H = pn.c.height;
    x.clearRect(0, 0, W, H);
    rr(x, 4, 4, W - 8, H - 8, 28); x.fillStyle = 'rgba(22,24,28,0.94)'; x.fill();
    // header: who you're talking to, and close
    x.textBaseline = 'middle'; x.textAlign = 'left'; x.fillStyle = '#fff'; x.font = '900 30px ' + FONT;
    x.fillText('💬 Chat', 24, 38);
    if(party) button(pn, 170, 14, 210, 48, chat.scope === 'party' ? '👥 Party' : '🌐 Everyone', ()=>{ chat.scope = chat.scope === 'party' ? 'global' : 'party'; chat.picked = true; }, { size: 22, color: 'rgba(77,227,255,0.25)' });
    else { x.font = '700 22px ' + FONT; x.fillStyle = '#9aa3b2'; x.fillText(lobby ? '🌐 Everyone in the lobby' : 'Everyone in this game', 172, 38); }
    button(pn, W - 24 - 60, 14, 60, 48, '✖', ()=> VR.openChat(false), { size: 24 });
    // the latest messages
    let y = 74;
    rr(x, 16, y, W - 32, 166, 14); x.fillStyle = 'rgba(0,0,0,0.35)'; x.fill();
    if(!lines.length){ x.font = '700 24px ' + FONT; x.fillStyle = '#9aa3b2'; x.textAlign = 'center'; x.fillText('No messages yet — say hi!', W / 2, y + 83); }
    lines.forEach((m, i)=>{
      const ly = y + 22 + i * 31;
      x.textAlign = 'left';
      if(m.sys){ x.font = '700 22px ' + FONT; x.fillStyle = '#9aa3b2'; x.fillText(fit(x, m.text, W - 64), 30, ly); return; }
      x.font = '900 23px ' + FONT; x.fillStyle = nameColor(m.who);
      const who = fit(x, m.name + ':', 250); x.fillText(who, 30, ly);
      const cx = 30 + x.measureText(who).width + 8;
      x.font = '700 23px ' + FONT; x.fillStyle = '#fff'; x.fillText(fit(x, m.text, W - 34 - cx), cx, ly);
    });
    // what you're typing
    y = 250;
    rr(x, 16, y, W - 32, 52, 14); x.fillStyle = '#fff'; x.fill();
    x.font = '700 26px ' + FONT; x.textAlign = 'left';
    if(chat.text){ x.fillStyle = '#111216'; x.fillText(tail(x, chat.text, W - 80) + '|', 30, y + 27); }
    else { x.fillStyle = '#8a93a3'; x.fillText('Type a message…', 30, y + 27); }
    // quick messages: one press sends
    y = 312;
    const qg = 8, qw = (W - 32 - qg * (QUICK.length - 1)) / QUICK.length;
    QUICK.forEach((q, i)=> button(pn, 16 + i * (qw + qg), y, qw, 46, q, ()=> chatSend(q), { size: 21, color: 'rgba(31,111,209,0.95)' }));
    // the keyboard
    y = 370;
    const kg = 6, kh = 46, unit = (W - 32 - 10 * kg) / 11;
    KEYS.forEach((row, r)=>{
      const keys = row.map(k=> Array.isArray(k) ? k : [k, 1]);
      const units = keys.reduce((n, k)=> n + k[1], 0);
      let kx = 16 + (11 - units) * (unit + kg) / 2;
      keys.forEach(([k, u])=>{
        const w = u * unit + (u - 1) * kg;
        const label = k === 'space' ? 'space' : k === 'send' ? 'Send ➤' : k === '⇧' ? '⇧' : chat.caps && k.length === 1 ? k.toUpperCase() : k;
        const color = k === 'send' ? '#00b06f' : k === '⇧' && chat.caps ? 'rgba(77,227,255,0.55)' : (k === '⌫' || k === '⇧') ? 'rgba(90,96,110,0.95)' : 'rgba(58,62,72,0.95)';
        button(pn, kx, y, w, kh, label, ()=> typeKey(k), { size: k === 'send' || k === 'space' ? 24 : 28, color, enabled: k !== 'send' || !!chat.text.trim(), r: 10 });
        kx += w + kg;
      });
      y += kh + kg;
    });
    pn.tex.needsUpdate = true;
  }
  // new messages float up in front of you while the chat panel is closed
  function chatWatch(){
    const me = myNetId();
    let fresh = [];
    try{
      if(App.mode === 'play' && window.RbxHud && RbxHud.chatSeq){
        const n = RbxHud.chatSeq();
        if(chat.seen && chat.seen.k === 'play' && n > chat.seen.n) fresh = RbxHud.chatLog(Math.min(3, n - chat.seen.n));
        chat.seen = { k: 'play', n };
      } else if(App.mode === 'lobby' && typeof ChatLogs !== 'undefined'){
        const g = ChatLogs.global.length, p = ChatLogs.party.length;
        if(chat.seen && chat.seen.k === 'lobby') fresh = ChatLogs.global.slice(chat.seen.g).concat(ChatLogs.party.slice(chat.seen.p).map(m=> Object.assign({ tag: '👥 ' }, m))).slice(-3);
        chat.seen = { k: 'lobby', g, p };
      } else chat.seen = null;
    }catch(e){ chat.seen = null; }
    if(chat.open) return;
    fresh.forEach(m=>{ if(!m.sys && !m.mine && !(me && m.from === me)) addNote('💬 ' + (m.tag || '') + (m.name || 'Player') + ': ' + m.text); });
  }

  // ------------------------------------------------------------------ real Quest controllers
  // Controllers normally look like blocky hands. While you use a menu (point at one, or have the chat
  // or the buy window open) they turn into the real controller you're holding — Quest 3/3S, Quest Pro
  // or Quest 2 — painted in Neoblox's logo colours, with buttons, trigger and thumbstick that move.
  const CTRL_PROFILES = ['meta-quest-touch-plus', 'meta-quest-touch-pro', 'oculus-touch-v3'];
  const CTRL_BUTTON = { xr_standard_trigger: 0, xr_standard_squeeze: 1, xr_standard_thumbstick: 3, x_button: 4, a_button: 4, y_button: 5, b_button: 5, thumbrest: 6, menu: 7 };
  const ctrlModels = new Map();
  function ctrlProfile(src){
    const ps = (src && src.profiles) || [];
    for(const p of ps) if(CTRL_PROFILES.indexOf(p) >= 0) return p;
    return ps.some(p=> /^(meta-quest|oculus-touch)/.test(p)) ? 'meta-quest-touch-plus' : null;
  }
  function ctrlModel(profile, side){
    const k = profile + '/' + side;
    if(!ctrlModels.has(k)) ctrlModels.set(k, new Promise((res)=>{
      if(typeof THREE.GLTFLoader !== 'function') return res(null);
      try{ new THREE.GLTFLoader().load('/vendor/xr-controllers/' + k + '.glb', (g)=> res(paint(g.scene)), undefined, ()=> res(null)); }
      catch(e){ res(null); }
    }));
    return ctrlModels.get(k);
  }
  function paint(root){
    root.name = 'vr-controller';
    root.updateMatrixWorld(true);
    const body = [];
    root.traverse(o=>{
      if(!o.isMesh) return;
      const n = (o.name + ' ' + (o.parent ? o.parent.name : '')).toLowerCase();
      o.renderOrder = HANDS;
      if(/button|thumbstick|thumbrest|menu/.test(n)) o.material = new THREE.MeshLambertMaterial({ color: LOGO.lime, emissive: 0x1a2408, transparent: true });
      else if(/trigger|squeeze/.test(n)) o.material = new THREE.MeshLambertMaterial({ color: LOGO.ink, emissive: 0x05070d, transparent: true });
      else body.push(o);
    });
    // the body: the logo's cyan → purple, from the top of the controller down the handle
    const dir = new THREE.Vector3(0, -0.6, 1).normalize(), v = new THREE.Vector3();
    const c1 = new THREE.Color(LOGO.cyan), c2 = new THREE.Color(LOGO.purple), c = new THREE.Color();
    let lo = Infinity, hi = -Infinity;
    const along = body.map(o=>{
      const pos = o.geometry.attributes.position, a = new Float32Array(pos.count);
      for(let i = 0; i < pos.count; i++){ a[i] = v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).dot(dir); lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
      return a;
    });
    body.forEach((o, j)=>{
      const a = along[j], col = new Float32Array(a.length * 3);
      for(let i = 0; i < a.length; i++){ c.copy(c1).lerp(c2, (a[i] - lo) / ((hi - lo) || 1)); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
      o.material = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0b0d18, transparent: true });
    });
    // what moves when you press: each "<part>_value" node slides between "<part>_min" and "<part>_max"
    const resp = [];
    root.traverse(o=>{
      const m = /^(.*)_value$/.exec(o.name || ''); if(!m) return;
      const min = root.getObjectByName(m[1] + '_min'), max = root.getObjectByName(m[1] + '_max');
      if(!min || !max) return;
      let axis = -1, b = -1;
      if(/_xaxis_pressed$/.test(m[1])) axis = 2;
      else if(/_yaxis_pressed$/.test(m[1])) axis = 3;
      else { b = CTRL_BUTTON[m[1].replace(/_pressed$/, '')]; if(b === undefined) return; }
      resp.push({ node: o, min, max, axis, b });
    });
    root.userData.resp = resp;
    root.visible = false;
    return root;
  }
  function moveParts(model, gp){
    (model.userData.resp || []).forEach(r=>{
      let v = 0;
      if(r.axis >= 0){ const a = gp.axes && gp.axes.length > r.axis ? +gp.axes[r.axis] || 0 : 0; v = (Math.max(-1, Math.min(1, a)) + 1) / 2; }
      else { const b = gp.buttons && gp.buttons[r.b]; v = !b ? 0 : typeof b.value === 'number' ? b.value : b.pressed ? 1 : 0; }
      r.node.quaternion.copy(r.min.quaternion).slerp(r.max.quaternion, v);
      r.node.position.lerpVectors(r.min.position, r.max.position, v);
    });
  }
  const menuInUse = ()=> performance.now() < menuUntil || chat.open || !!(window.NeoMarket && NeoMarket.isOpen && NeoMarket.isOpen());
  function looks(){
    const menu = menuInUse();
    hands.forEach(h=>{
      const src = h.src, ctrl = !!(src && !src.hand && src.gamepad);
      const prof = ctrl ? ctrlProfile(src) : null, k = prof ? prof + '/' + src.handedness : null;
      if(k && h.modelKey !== k){
        // loaded as soon as the controller shows up, so it's ready when you open a menu
        if(h.model && h.model.parent) h.model.parent.remove(h.model);
        h.model = null; h.modelKey = k;
        ctrlModel(prof, src.handedness).then(m=>{
          if(!m || h.modelKey !== k) return;
          hands.forEach(o=>{ if(o !== h && o.model === m){ o.model = null; o.modelKey = null; } });
          h.model = m; h.grip.add(m);
        });
      }
      const on = !!(menu && ctrl && h.model && h.modelKey === k);
      if(h.model) h.model.visible = on;
      h.mesh.visible = !on;
      if(on) moveParts(h.model, src.gamepad);
    });
  }

  // for the automated tests (a simulated headset): the play space, panels and hands
  VR._debug = ()=> ({ dolly, cam, scale, hud, wrist, hands, notes, orbit, floor, chat, palmOn, tele, teleports, menu: menuInUse() });

  document.addEventListener('DOMContentLoaded', ()=>{ checkSupport(); showButton(); });
  if(document.readyState !== 'loading'){ checkSupport(); }
  setInterval(showButton, 700);
})();
