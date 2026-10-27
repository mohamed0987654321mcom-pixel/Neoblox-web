// rbx/animate.js — NeoAnimate: draws the animations games play on avatars (AnimationTrack in
// scripts — see rbx/neoscript-runtime.js) on the blocky avatar rig, for your own character and,
// sent over the network, for other players' characters.
//
// An animation is a list of keyframes; each moves some "joints" (h head, t torso = upper body
// bending at the hips, b body = the whole character, la/ra arms, ll/rl legs, y = lift in studs)
// to angles in degrees, easing between keyframes. Several tracks can play at once: higher
// Priority wins on the joints both move, Weight blends, fades blend in and out. Core/Idle tracks
// give way while you walk; Movement and above play over walking.
//
// Each frame: NeoAnimate.unapply(rig) before animateAvatar() puts back exactly what the last
// apply() changed, animateAvatar() poses walking/idle as usual, then apply() adds the tracks on top.
'use strict';
(function(){
  const NA = window.NeoAnimate = {};
  const DEG = Math.PI / 180;
  const JOINTS = ['h', 't', 'b', 'la', 'ra', 'll', 'rl'];
  const MAX_TRACKS = 8;
  // degrees as the scripts write them -> the rig's own rotation (the rig faces +Z, and its
  // "leftArm" pivot is on the character's right side; arms/legs mirror Y/Z so both sides match)
  const SIGN = { h:[1,1,1], t:[1,1,1], b:[1,1,1], ra:[-1,1,-1], la:[-1,-1,1], rl:[-1,1,-1], ll:[-1,-1,1] };
  const PART = { h:'headPivot', ra:'leftArm', la:'rightArm', rl:'leftLeg', ll:'rightLeg' };

  // ------------------------------------------------------------------ easing (same as tweens)
  function bounceOut(x){ const n = 7.5625, d = 2.75; if(x < 1/d) return n*x*x; if(x < 2/d) return n*(x -= 1.5/d)*x + 0.75; if(x < 2.5/d) return n*(x -= 2.25/d)*x + 0.9375; return n*(x -= 2.625/d)*x + 0.984375; }
  const STYLES = [
    (t)=> t, (t)=> 1 - Math.cos(t * Math.PI / 2), (t)=> t*t, (t)=> t*t*t, (t)=> t*t*t*t, (t)=> t*t*t*t*t,
    (t)=> t === 0 ? 0 : Math.pow(2, 10*t - 10), (t)=> 1 - Math.sqrt(1 - t*t), (t)=> 2.70158*t*t*t - 1.70158*t*t,
    (t)=> 1 - bounceOut(1 - t), (t)=> t === 0 || t === 1 ? t : -Math.pow(2, 10*t - 10) * Math.sin((t*10 - 10.75) * (2*Math.PI/3)),
  ];
  function ease(code, t){
    const f = STYLES[Math.floor(code / 3)] || STYLES[0], dir = code % 3;
    if(dir === 0) return f(t);
    if(dir === 1) return 1 - f(1 - t);
    return t < 0.5 ? f(t*2) / 2 : 1 - f((1 - t)*2) / 2;
  }
  const num = (v, lo, hi, d)=>{ const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

  // ------------------------------------------------------------------ animations
  // { len, k:[{ t, e, j:{ joint:[x,y,z] }, l }] } from a script or the network -> per-joint
  // channels, or null if it isn't a valid animation (anything off is dropped, never trusted)
  NA.sanitize = function(d){
    if(!d || typeof d !== 'object' || !Array.isArray(d.k) || !d.k.length || d.k.length > 200) return null;
    const ch = {}, raw = [];
    let last = 0;
    for(const kf of d.k){
      if(!kf || typeof kf !== 'object') return null;
      const t = Number(kf.t);
      if(!Number.isFinite(t) || t < last || t > 60) return null;
      last = t;
      const e = Number.isInteger(kf.e) && kf.e >= 0 && kf.e < STYLES.length * 3 ? kf.e : 2;
      const r = { t, e, j:{} };
      if(kf.j && typeof kf.j === 'object'){
        for(const j of Object.keys(kf.j)){
          if(JOINTS.indexOf(j) < 0) return null;
          const v = kf.j[j];
          if(!Array.isArray(v) || v.length !== 3) return null;
          const a = v.map(n=> num(n, -1440, 1440, 0));
          r.j[j] = a;
          (ch[j] = ch[j] || []).push({ t, v: a, e });
        }
      }
      if(kf.l !== undefined && kf.l !== null){ r.l = num(kf.l, -10, 10, 0); (ch.y = ch.y || []).push({ t, v:[r.l], e }); }
      raw.push(r);
    }
    // a joint that only starts moving later begins from its normal pose at time 0 (so an empty
    // { Time: 0 } keyframe means "start from standing", and a pose eases in instead of jumping)
    const e0 = raw[0].t === 0 ? raw[0].e : 2;
    Object.keys(ch).forEach(j=>{ if(ch[j][0].t > 0) ch[j].unshift({ t:0, v: j === 'y' ? [0] : [0,0,0], e: e0 }); });
    return { len: last, ch, raw: { len: last, k: raw } };
  };
  function sample(keys, p){
    const n = keys.length;
    if(p <= keys[0].t || n === 1) return keys[0].v;
    if(p >= keys[n-1].t) return keys[n-1].v;
    let i = 0;
    while(i < n - 2 && keys[i+1].t <= p) i++;
    const a = keys[i], b = keys[i+1], span = b.t - a.t;
    const u = span > 0 ? ease(a.e, Math.min(1, Math.max(0, (p - a.t) / span))) : 1;
    return a.v.map((x, k)=> x + (b.v[k] - x) * u);
  }

  // ------------------------------------------------------------------ tracks
  let order = 0;
  NA.state = ()=> ({ tracks:new Map(), defs:new Map(), dirty:false });
  function rememberDef(st, id, d){
    st.defs.set(id, d);
    if(st.defs.size > 100){ const first = st.defs.keys().next().value; st.defs.delete(first); }
  }
  // { id, def?, loop, speed, w, prio, fade, pos } — def is sent the first time a track plays
  NA.play = function(st, o){
    if(!st || !o || !Number.isInteger(o.id)) return false;
    let d = o.def ? NA.sanitize(o.def) : null;
    if(d) rememberDef(st, o.id, d); else d = st.defs.get(o.id);
    if(!d) return false;
    let tr = st.tracks.get(o.id);
    if(!tr){
      if(st.tracks.size >= MAX_TRACKS){
        // make room: drop one that's fading out, else the oldest
        let victim = null;
        st.tracks.forEach(x=>{ if(!victim || (!x.playing && victim.playing) || (x.playing === victim.playing && x.order < victim.order)) victim = x; });
        if(victim) st.tracks.delete(victim.id);
      }
      tr = { id: o.id, d, cur:0, order: ++order };
      st.tracks.set(o.id, tr);
    }
    tr.d = d; tr.playing = true;
    tr.loop = !!o.loop;
    tr.speed = num(o.speed, 0, 10, 1);
    tr.wt = num(o.w, 0, 1, 1);
    tr.prio = Number.isInteger(o.prio) ? Math.min(6, Math.max(0, o.prio)) : 3;
    tr.pos = num(o.pos, 0, d.len, 0);
    tr.rate = rateOf(o.fade, 0.1);
    st.dirty = true;
    return true;
  };
  function rateOf(fade, d){ const f = num(fade, 0, 10, d); return f > 0 ? 1 / f : Infinity; }
  NA.stop = function(st, id, fade){
    const tr = st && st.tracks.get(id);
    if(!tr || !tr.playing) return;
    tr.playing = false; tr.rate = rateOf(fade, 0.1);
    st.dirty = true;
  };
  NA.set = function(st, id, o){
    const tr = st && st.tracks.get(id);
    if(!tr || !o) return;
    if(o.loop !== undefined) tr.loop = !!o.loop;
    if(o.speed !== undefined) tr.speed = num(o.speed, 0, 10, tr.speed);
    if(o.w !== undefined){ tr.wt = num(o.w, 0, 1, tr.wt); tr.rate = rateOf(o.fade, 0.1); }
    if(o.prio !== undefined && Number.isInteger(o.prio)) tr.prio = Math.min(6, Math.max(0, o.prio));
    if(o.pos !== undefined) tr.pos = num(o.pos, 0, tr.d.len, tr.pos);
    st.dirty = true;
  };
  NA.clear = function(st){ if(st){ st.tracks.clear(); st.dirty = true; } };
  NA.step = function(st, dt){
    if(!st || !st.tracks.size) return;
    st.tracks.forEach((tr, id)=>{
      if(tr.playing){
        tr.pos += dt * tr.speed;
        const len = tr.d.len;
        if(tr.pos >= len){
          if(tr.loop) tr.pos = len > 0 ? tr.pos % len : 0; // a looped one-keyframe animation just holds its pose
          else { tr.pos = len; tr.playing = false; tr.rate = 1 / 0.15; } // a finished animation fades back out
        }
      }
      const want = tr.playing ? tr.wt : 0;
      tr.cur = tr.rate === Infinity ? want : tr.cur + Math.max(-dt * tr.rate, Math.min(dt * tr.rate, want - tr.cur));
      if(!tr.playing && tr.cur <= 0.0001) st.tracks.delete(id);
    });
  };

  // ------------------------------------------------------------------ posing the rig
  let tmp = null;
  function T(){
    if(tmp) return tmp;
    tmp = { q: new THREE.Quaternion(), q2: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'YXZ'), v: new THREE.Vector3(), hip: new THREE.Vector3() };
    return tmp;
  }
  NA.unapply = function(rig){
    const b = rig && rig._naBase;
    if(!b) return;
    Object.keys(PART).forEach(j=>{ const o = rig[PART[j]]; if(!o) return; o.rotation.set(b.rot[j][0], b.rot[j][1], b.rot[j][2]); o.position.copy(b.pos[j]); });
    if(rig.torso){ rig.torso.position.copy(b.pos.torso); rig.torso.rotation.set(b.torsoRot[0], b.torsoRot[1], b.torsoRot[2]); }
    if(b.skin && rig.customSkinMesh === b.skin.mesh){
      b.skin.joints.forEach(x=> x.o.quaternion.copy(x.q));
      b.skin.mesh.position.copy(b.skin.pos); b.skin.mesh.quaternion.copy(b.skin.q);
    }
    rig._naBase = null;
  };
  // moving: the character is walking/jumping (Core and Idle tracks give way)
  NA.apply = function(rig, st, moving){
    if(!rig || !st || !st.tracks.size || !rig.torso || !window.THREE) return;
    const list = Array.from(st.tracks.values()).filter(tr=> tr.cur > 0.0001 && !(moving && tr.prio < 2)).sort((a, b)=> a.prio - b.prio || a.order - b.order);
    if(!list.length) return;
    NA.unapply(rig);
    // what animateAvatar() left, to blend from and to put back next frame
    const base = { rot:{}, pos:{}, torsoRot:[rig.torso.rotation.x, rig.torso.rotation.y, rig.torso.rotation.z] };
    const P = { t:[0,0,0], b:[0,0,0], y:[0] };
    Object.keys(PART).forEach(j=>{ const o = rig[PART[j]]; if(!o) return; base.rot[j] = [o.rotation.x, o.rotation.y, o.rotation.z]; base.pos[j] = o.position.clone(); P[j] = base.rot[j].slice(); });
    base.pos.torso = rig.torso.position.clone();
    rig._naBase = base;
    list.forEach(tr=>{
      const w = Math.min(1, tr.cur);
      Object.keys(tr.d.ch).forEach(j=>{
        if(!P[j]) return;
        const v = sample(tr.d.ch[j], tr.pos);
        if(j === 'y'){ P.y[0] += (v[0] - P.y[0]) * w; return; }
        const s = SIGN[j];
        for(let k = 0; k < 3; k++){ const target = v[k] * DEG * s[k]; P[j][k] += (target - P[j][k]) * w; }
      });
    });
    const t = T();
    Object.keys(PART).forEach(j=>{ const o = rig[PART[j]]; if(o) o.rotation.set(P[j][0], P[j][1], P[j][2]); });
    // upper body bends at the hips, carrying the arms and head with it
    if(P.t[0] || P.t[1] || P.t[2]){
      t.e.set(P.t[0], P.t[1], P.t[2], 'YXZ'); t.q.setFromEuler(t.e);
      t.hip.set(0, (typeof RIG !== 'undefined' ? RIG.legH : 0.8), 0);
      [rig.torso, rig.leftArm, rig.rightArm, rig.headPivot].forEach(o=>{
        if(!o) return;
        t.v.copy(o.position).sub(t.hip).applyQuaternion(t.q).add(t.hip); o.position.copy(t.v);
        o.quaternion.premultiply(t.q);
      });
    }
    // the whole character turns/tips around its feet, and lifts
    const moved = P.b[0] || P.b[1] || P.b[2] || P.y[0];
    if(moved){
      t.e.set(P.b[0], P.b[1], P.b[2], 'YXZ'); t.q.setFromEuler(t.e);
      [rig.leftLeg, rig.rightLeg, rig.torso, rig.leftArm, rig.rightArm, rig.headPivot].forEach(o=>{
        if(!o) return;
        o.position.applyQuaternion(t.q); o.position.y += P.y[0];
        o.quaternion.premultiply(t.q);
      });
    }
    // a glTF skin (Ender, Admin…) poses its own joints the same way; it turns, tips and lifts
    // as a whole (its upper body can't bend at the hips, so Torso doesn't show on skins)
    const sk = rig.customSkinPivots && rig.customSkinMesh ? skinInfo(rig) : null;
    if(sk){
      const sm = sk.mesh;
      base.skin = { mesh: sm, joints: [], pos: sm.position.clone(), q: sm.quaternion.clone() };
      Object.keys(sk.map).forEach(j=>{
        const o = sk.map[j]; if(!o || !P[j]) return;
        base.skin.joints.push({ o, q: o.quaternion.clone() });
        // the same turn, seen from inside the skin model (which may face the other way)
        t.e.set(P[j][0], P[j][1], P[j][2], 'XYZ'); t.q2.setFromEuler(t.e);
        o.quaternion.copy(sk.qi).multiply(t.q2).multiply(sk.q);
      });
      if(moved){ sm.position.applyQuaternion(t.q); sm.position.y += P.y[0]; sm.quaternion.premultiply(t.q); }
    }
  };
  // Which of a skin's joints is the character's right arm, left leg…, and how the skin model is
  // turned inside the rig — worked out once per skin, from where its joints actually are.
  function skinInfo(rig){
    const sm = rig.customSkinMesh, sp = rig.customSkinPivots;
    if(rig._naSkin && rig._naSkin.mesh === sm) return rig._naSkin;
    rig.group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(rig.group.matrixWorld).invert();
    const xOf = (o)=>{ const v = new THREE.Vector3(); o.getWorldPosition(v); return v.applyMatrix4(inv).x; };
    const map = { h: sp.head || null };
    [['leftArm','rightArm','ra','la'], ['leftLeg','rightLeg','rl','ll']].forEach(([a, b, right, left])=>{
      if(!sp[a] || !sp[b]) return;
      const aRight = xOf(sp[a]) < xOf(sp[b]); // the character's right side is the rig's -X
      map[right] = aRight ? sp[a] : sp[b]; map[left] = aRight ? sp[b] : sp[a];
    });
    rig._naSkin = { mesh: sm, map, q: sm.quaternion.clone(), qi: sm.quaternion.clone().invert() };
    return rig._naSkin;
  }

  // ------------------------------------------------------------------ over the network
  NA.toNet = (st)=> st ? Array.from(st.tracks.values()).filter(tr=> tr.playing).slice(0, MAX_TRACKS)
    .map(tr=> ({ id: tr.id, d: tr.d.raw, loop: tr.loop, speed: tr.speed, w: tr.wt, prio: tr.prio, pos: Math.round(tr.pos * 1000) / 1000 })) : [];
  // another player's tracks: start new ones, update the rest, fade out what's gone
  NA.fromNet = function(list, st){
    st = st || NA.state();
    const seen = new Set();
    (Array.isArray(list) ? list.slice(0, MAX_TRACKS) : []).forEach(o=>{
      if(!o || !Number.isInteger(o.id)) return;
      seen.add(o.id);
      const ex = st.tracks.get(o.id);
      if(ex && ex.playing){
        NA.set(st, o.id, { loop: o.loop, speed: o.speed, prio: o.prio, w: o.w, fade: 0.15 });
        if(Math.abs(num(o.pos, 0, 60, ex.pos) - ex.pos) > 0.3) ex.pos = num(o.pos, 0, ex.d.len, ex.pos);
      } else NA.play(st, { id: o.id, def: st.defs.has(o.id) ? null : o.d, loop: o.loop, speed: o.speed, w: o.w, prio: o.prio, fade: 0.15, pos: o.pos });
    });
    st.tracks.forEach((tr, id)=>{ if(!seen.has(id) && tr.playing) NA.stop(st, id, 0.15); });
    return st;
  };
})();
