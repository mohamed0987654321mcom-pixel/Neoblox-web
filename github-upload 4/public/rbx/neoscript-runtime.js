// rbx/neoscript-runtime.js — the Roblox-style game API that every Neoblox script sees.
//
// This file is NOT loaded into the page. rbx/neoscript.js fetches it as text and runs it inside
// the sandboxed QuickJS engine (vendor/quickjs), before any player-written script. Nothing in
// here can reach the page: the only way out is the one `__host(op, json)` function the host
// hands over, and the host checks and clamps everything that comes through it.
//
// Scripts are JavaScript, but shaped like Roblox Lua:
//   Lua:  script.Parent.Touched:Connect(function(hit) ... end)
//   JS:   script.Parent.Touched.Connect((hit) => { ... })
//   Lua:  wait(1)            JS:  await wait(1)
//   Lua:  Vector3.new(1,2,3) JS:  new Vector3(1, 2, 3)   (Vector3.new(1, 2, 3) works too)
'use strict';
(function(){
  const G = globalThis;
  const HOST = G.__host;
  delete G.__host;
  function host(op, data){
    const r = HOST(op, data === undefined ? '' : JSON.stringify(data));
    if(r === undefined || r === null || r === '') return undefined;
    const o = JSON.parse(r);
    if(o && o.__err) throw new Error(o.__err);
    return o;
  }

  let NOW = 0;               // seconds since the game started (the host's clock)
  let STUDIO = false;
  const SCRIPT_FILES = {};   // compiled file name -> the script's full name, for error messages

  // ------------------------------------------------------------------ output + errors
  function fmt(a, depth){
    depth = depth || 0;
    if(a === undefined) return 'undefined';
    if(a === null) return 'null';
    const t = typeof a;
    if(t === 'string') return a;
    if(t === 'number' || t === 'boolean' || t === 'bigint') return String(a);
    if(t === 'function') return 'function' + (a.name ? ' ' + a.name : '');
    if(t === 'symbol') return a.toString();
    if(a instanceof Instance) return a.Name;
    if(a instanceof Error) return (a.name && a.name !== 'Error' ? a.name + ': ' : '') + a.message;
    if(a.toString !== Object.prototype.toString && typeof a.toString === 'function' && !Array.isArray(a)){ try{ return String(a); }catch(e){} }
    if(depth > 2) return Array.isArray(a) ? '[…]' : '{…}';
    if(Array.isArray(a)) return '[' + a.slice(0, 50).map(v => fmt(v, depth+1)).join(', ') + (a.length > 50 ? ', …' : '') + ']';
    try{ return '{' + Object.keys(a).slice(0, 30).map(k => k + ': ' + fmt(a[k], depth+1)).join(', ') + '}'; }catch(e){ return '[object]'; }
  }
  function out(kind, args){ host('log', { kind, text: args.map(a => fmt(a)).join(' ').slice(0, 2000) }); }
  // Which script (and line) an error came from, read off the stack: scripts are compiled under
  // file names like __nbs3__, mapped back to "Workspace.Lava.Script".
  function whereOf(e){
    const st = e && typeof e.stack === 'string' ? e.stack : '';
    const re = /(__nbs\d+__):(\d+)/g; let m;
    while((m = re.exec(st))){ if(SCRIPT_FILES[m[1]]) return { file: m[1], line: +m[2] }; }
    if(e && e.fileName && SCRIPT_FILES[e.fileName]) return { file: e.fileName, line: +e.lineNumber || 0 };
    return null;
  }
  function reportError(e){
    let msg, timeout = false;
    if(e instanceof Error) msg = (e.name && e.name !== 'Error' ? e.name + ': ' : '') + e.message;
    else msg = fmt(e);
    // the engine stopped a script that ran too long without waiting
    if(e && e.name === 'InternalError' && e.message === 'interrupted'){ timeout = true; msg = 'Script timeout: exhausted allowed execution time — add "await wait()" inside long loops'; }
    const w = whereOf(e);
    const label = w ? SCRIPT_FILES[w.file] + (w.line ? ':' + w.line : '') : '';
    host('log', { kind:'err', text: (label ? label + ': ' : '') + msg, file: w ? w.file : '', line: w ? w.line : 0, timeout });
  }
  G.print = (...a) => out('', a);
  G.warn = (...a) => out('warn', a);
  G.console = Object.freeze({ log: G.print, info: G.print, debug: G.print, warn: G.warn, error: (...a) => out('err', a) });
  // Lua's error("msg") — throws, like Roblox.
  G.error = (msg) => { throw (msg instanceof Error ? msg : new Error(fmt(msg))); };

  // Run a callback the way Roblox runs an event handler: in its own "thread", so an error in it
  // is reported and never stops anything else.
  function spawnFn(fn, args){
    try{
      const r = fn.apply(undefined, args || []);
      if(r && typeof r.then === 'function') r.then(undefined, reportError);
    }catch(e){ reportError(e); }
  }

  // ------------------------------------------------------------------ events (RBXScriptSignal)
  class RBXScriptConnection {
    constructor(sig, fn){ this._sig = sig; this._fn = fn; this.Connected = true; }
    Disconnect(){
      if(!this.Connected) return;
      this.Connected = false;
      const a = this._sig._conns, i = a.indexOf(this);
      if(i >= 0) a.splice(i, 1);
      if(this._sig._watch) this._sig._watch(a.length);
    }
    toString(){ return 'Connection'; }
  }
  RBXScriptConnection.prototype.disconnect = RBXScriptConnection.prototype.Disconnect;
  class RBXScriptSignal {
    constructor(name, watch){ this._name = name || 'Event'; this._conns = []; this._watch = watch || null; }
    Connect(fn){
      if(typeof fn !== 'function') throw new TypeError('Attempt to connect failed: Passed value is not a function');
      const c = new RBXScriptConnection(this, fn);
      this._conns.push(c);
      if(this._watch) this._watch(this._conns.length);
      return c;
    }
    Once(fn){
      if(typeof fn !== 'function') throw new TypeError('Attempt to connect failed: Passed value is not a function');
      const c = this.Connect((...a) => { c.Disconnect(); return fn(...a); });
      return c;
    }
    // const hit = await part.Touched.Wait()  — resolves with the event's first value
    Wait(){ return new Promise(res => { this.Once((...a) => res(a[0])); }); }
    _fire(...args){ const list = this._conns.slice(); for(const c of list) if(c.Connected) spawnFn(c._fn, args); }
    _clear(){ this._conns.forEach(c => { c.Connected = false; }); this._conns = []; if(this._watch) this._watch(0); }
    toString(){ return 'Signal ' + this._name; }
  }
  RBXScriptSignal.prototype.connect = RBXScriptSignal.prototype.Connect;
  RBXScriptSignal.prototype.once = RBXScriptSignal.prototype.Once;

  // ------------------------------------------------------------------ waiting: wait / task / timers
  const timers = []; // { at, fn } — run by the host's per-frame step
  let timerSeq = 1;
  function addTimer(sec, fn){
    sec = Number(sec);
    if(!(sec >= 0)) sec = 0;
    const t = { id: timerSeq++, at: NOW + Math.min(sec, 1e7), fn, dead:false };
    timers.push(t);
    return t;
  }
  function sleep(sec){
    const start = NOW;
    return new Promise(res => addTimer(sec === undefined ? 0 : sec, () => res(NOW - start)));
  }
  G.wait = sleep;
  G.task = Object.freeze({
    wait: sleep,
    spawn(fn, ...args){ if(typeof fn !== 'function') throw new TypeError('task.spawn expects a function'); spawnFn(fn, args); },
    defer(fn, ...args){ if(typeof fn !== 'function') throw new TypeError('task.defer expects a function'); Promise.resolve().then(() => spawnFn(fn, args)); },
    delay(sec, fn, ...args){ if(typeof fn !== 'function') throw new TypeError('task.delay expects a function'); return addTimer(sec, () => spawnFn(fn, args)); },
    cancel(t){ if(t && typeof t === 'object') t.dead = true; },
  });
  G.delay = (sec, fn) => G.task.delay(sec, fn);
  G.spawn = (fn) => G.task.spawn(fn);
  G.setTimeout = (fn, ms, ...args) => { if(typeof fn !== 'function') throw new TypeError('setTimeout expects a function'); return addTimer((+ms || 0) / 1000, () => spawnFn(fn, args)).id; };
  G.setInterval = (fn, ms, ...args) => {
    if(typeof fn !== 'function') throw new TypeError('setInterval expects a function');
    const every = Math.max(0.016, (+ms || 0) / 1000);
    const first = addTimer(every, function run(){ spawnFn(fn, args); const nt = addTimer(every, run); nt.id = first.id; });
    return first.id;
  };
  G.clearTimeout = G.clearInterval = (id) => { timers.forEach(t => { if(t.id === id) t.dead = true; }); };
  G.time = () => NOW;
  G.elapsedTime = () => NOW;
  G.tick = () => Date.now() / 1000;
  G.os = Object.freeze({ time: () => Math.floor(Date.now() / 1000), clock: () => NOW, date: () => new Date() });
  // Lua-style math helpers next to JavaScript's Math
  G.math = Object.freeze({
    random(a, b){
      if(a === undefined) return Math.random();
      if(b === undefined){ b = a; a = 1; }
      a = Math.ceil(a); b = Math.floor(b);
      return Math.floor(Math.random() * (b - a + 1)) + a;
    },
    clamp: (x, a, b) => Math.min(Math.max(x, a), b),
    floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    atan2: Math.atan2, min: Math.min, max: Math.max, pi: Math.PI, huge: Infinity, rad: (d) => d * Math.PI / 180, deg: (r) => r * 180 / Math.PI,
    sign: Math.sign, pow: Math.pow, log: Math.log, exp: Math.exp, noise: (x, y, z) => Math.sin((x||0) * 12.9898 + (y||0) * 78.233 + (z||0) * 37.719) * 0.5,
  });

  // ------------------------------------------------------------------ data types
  const num = (v, what) => { const n = Number(v); if(!Number.isFinite(n)) throw new TypeError(what + ' must be a number'); return n; };
  class Vector3 {
    constructor(x, y, z){ this.X = +x || 0; this.Y = +y || 0; this.Z = +z || 0; Object.freeze(this); }
    static new(x, y, z){ return new Vector3(x, y, z); }
    get x(){ return this.X; } get y(){ return this.Y; } get z(){ return this.Z; }
    get Magnitude(){ return Math.sqrt(this.X*this.X + this.Y*this.Y + this.Z*this.Z); }
    get Unit(){ const m = this.Magnitude; return m ? new Vector3(this.X/m, this.Y/m, this.Z/m) : new Vector3(); }
    add(v){ return new Vector3(this.X + v.X, this.Y + v.Y, this.Z + v.Z); }
    sub(v){ return new Vector3(this.X - v.X, this.Y - v.Y, this.Z - v.Z); }
    mul(v){ return typeof v === 'number' ? new Vector3(this.X*v, this.Y*v, this.Z*v) : new Vector3(this.X*v.X, this.Y*v.Y, this.Z*v.Z); }
    div(v){ return typeof v === 'number' ? new Vector3(this.X/v, this.Y/v, this.Z/v) : new Vector3(this.X/v.X, this.Y/v.Y, this.Z/v.Z); }
    neg(){ return new Vector3(-this.X, -this.Y, -this.Z); }
    Dot(v){ return this.X*v.X + this.Y*v.Y + this.Z*v.Z; }
    Cross(v){ return new Vector3(this.Y*v.Z - this.Z*v.Y, this.Z*v.X - this.X*v.Z, this.X*v.Y - this.Y*v.X); }
    Lerp(v, a){ return new Vector3(this.X + (v.X-this.X)*a, this.Y + (v.Y-this.Y)*a, this.Z + (v.Z-this.Z)*a); }
    FuzzyEq(v, eps){ eps = eps === undefined ? 1e-5 : eps; return Math.abs(this.X-v.X) <= eps && Math.abs(this.Y-v.Y) <= eps && Math.abs(this.Z-v.Z) <= eps; }
    Abs(){ return new Vector3(Math.abs(this.X), Math.abs(this.Y), Math.abs(this.Z)); }
    Floor(){ return new Vector3(Math.floor(this.X), Math.floor(this.Y), Math.floor(this.Z)); }
    Ceil(){ return new Vector3(Math.ceil(this.X), Math.ceil(this.Y), Math.ceil(this.Z)); }
    Min(v){ return new Vector3(Math.min(this.X, v.X), Math.min(this.Y, v.Y), Math.min(this.Z, v.Z)); }
    Max(v){ return new Vector3(Math.max(this.X, v.X), Math.max(this.Y, v.Y), Math.max(this.Z, v.Z)); }
    Angle(v){ const d = this.Magnitude * v.Magnitude; return d ? Math.acos(Math.max(-1, Math.min(1, this.Dot(v) / d))) : 0; }
    equals(v){ return v instanceof Vector3 && v.X === this.X && v.Y === this.Y && v.Z === this.Z; }
    toString(){ return r3(this.X) + ', ' + r3(this.Y) + ', ' + r3(this.Z); }
  }
  ['Add','Sub','Mul','Div'].forEach(k => { Vector3.prototype[k] = Vector3.prototype[k.toLowerCase()]; });
  Vector3.prototype.lerp = Vector3.prototype.Lerp; Vector3.prototype.dot = Vector3.prototype.Dot; Vector3.prototype.cross = Vector3.prototype.Cross;
  Vector3.zero = new Vector3(0,0,0); Vector3.one = new Vector3(1,1,1);
  Vector3.xAxis = new Vector3(1,0,0); Vector3.yAxis = new Vector3(0,1,0); Vector3.zAxis = new Vector3(0,0,1);
  function r3(n){ return String(Math.round(n * 1000) / 1000); }
  const V = (a) => Array.isArray(a) ? new Vector3(a[0], a[1], a[2]) : new Vector3();
  const VA = (v) => [v.X, v.Y, v.Z];

  class Vector2 {
    constructor(x, y){ this.X = +x || 0; this.Y = +y || 0; Object.freeze(this); }
    static new(x, y){ return new Vector2(x, y); }
    get x(){ return this.X; } get y(){ return this.Y; }
    get Magnitude(){ return Math.hypot(this.X, this.Y); }
    toString(){ return r3(this.X) + ', ' + r3(this.Y); }
  }
  Vector2.zero = new Vector2(0, 0);

  const clamp01 = (n) => Math.min(1, Math.max(0, +n || 0));
  class Color3 {
    constructor(r, g, b){ this.R = clamp01(r); this.G = clamp01(g); this.B = clamp01(b); Object.freeze(this); }
    static new(r, g, b){ return new Color3(r, g, b); }
    static fromRGB(r, g, b){ return new Color3((+r||0)/255, (+g||0)/255, (+b||0)/255); }
    static fromHex(h){
      const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(h).trim());
      if(!m) throw new TypeError('Color3.fromHex: "' + h + '" is not a hex color like "#ff0000"');
      let s = m[1]; if(s.length === 3) s = s[0]+s[0]+s[1]+s[1]+s[2]+s[2];
      return Color3.fromRGB(parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16));
    }
    static fromHSV(h, s, v){
      h = ((+h||0) % 1 + 1) % 1; s = clamp01(s); v = clamp01(v);
      const i = Math.floor(h*6), f = h*6 - i, p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
      const [r,g,b] = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i % 6];
      return new Color3(r, g, b);
    }
    get r(){ return this.R; } get g(){ return this.G; } get b(){ return this.B; }
    ToHex(){ return [this.R, this.G, this.B].map(c => Math.round(c*255).toString(16).padStart(2,'0')).join(''); }
    ToHSV(){ const r=this.R,g=this.G,b=this.B, mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn; let h=0;
      if(d){ if(mx===r) h=((g-b)/d)%6; else if(mx===g) h=(b-r)/d+2; else h=(r-g)/d+4; h/=6; if(h<0) h+=1; }
      return [h, mx ? d/mx : 0, mx]; }
    Lerp(c, a){ return new Color3(this.R + (c.R-this.R)*a, this.G + (c.G-this.G)*a, this.B + (c.B-this.B)*a); }
    equals(c){ return c instanceof Color3 && c.ToHex() === this.ToHex(); }
    toString(){ return r3(this.R) + ', ' + r3(this.G) + ', ' + r3(this.B); }
  }
  Color3.prototype.toHex = Color3.prototype.ToHex; Color3.prototype.lerp = Color3.prototype.Lerp;
  const C = (hex) => { try{ return Color3.fromHex(hex); }catch(e){ return new Color3(0.64, 0.64, 0.65); } };
  const CHEX = (c) => '#' + c.ToHex();

  const BRICK = { 'White':'#f2f3f3','Institutional white':'#f8f8f8','Light stone grey':'#e5e4df','Medium stone grey':'#a3a2a5','Dark stone grey':'#635f62',
    'Black':'#1b2a35','Really black':'#111111','Bright red':'#c4281c','Really red':'#ff0000','Bright orange':'#da8541','Neon orange':'#d5733d','Bright yellow':'#f5cd30',
    'New Yeller':'#ffff00','Bright green':'#4b974b','Lime green':'#00ff00','Dark green':'#287f47','Bright blue':'#0d69ac','Really blue':'#0000ff','Toothpaste':'#00ffff',
    'Cyan':'#12eed4','Bright violet':'#6b327c','Magenta':'#aa00aa','Hot pink':'#ff00bf','Pink':'#ff66cc','Brown':'#7c5c46','Reddish brown':'#694028','Sand red':'#957977',
    'Teal':'#12eed4','Gold':'#efb838','Deep orange':'#ffaf00','Royal purple':'#6225d1','Pastel blue':'#80bbdb','Mint':'#b1e5a6','Lavender':'#8c5b9f','Navy blue':'#002060' };
  class BrickColor {
    constructor(name){ const n = BRICK[name] ? name : 'Medium stone grey'; this.Name = n; this.Color = Color3.fromHex(BRICK[n]); Object.freeze(this); }
    static new(name){ if(name instanceof Color3) return BrickColor.fromColor3(name); return new BrickColor(String(name)); }
    static fromColor3(c){ let best = 'Medium stone grey', bd = Infinity; Object.keys(BRICK).forEach(n => { const k = Color3.fromHex(BRICK[n]); const d = (k.R-c.R)**2 + (k.G-c.G)**2 + (k.B-c.B)**2; if(d < bd){ bd = d; best = n; } }); return new BrickColor(best); }
    static Random(){ const k = Object.keys(BRICK); return new BrickColor(k[Math.floor(Math.random()*k.length)]); }
    static Red(){ return new BrickColor('Bright red'); } static Green(){ return new BrickColor('Bright green'); } static Blue(){ return new BrickColor('Bright blue'); }
    static Yellow(){ return new BrickColor('Bright yellow'); } static White(){ return new BrickColor('White'); } static Black(){ return new BrickColor('Black'); }
    toString(){ return this.Name; }
  }

  class UDim { constructor(s, o){ this.Scale = +s || 0; this.Offset = +o || 0; Object.freeze(this); } static new(s, o){ return new UDim(s, o); } toString(){ return this.Scale + ', ' + this.Offset; } }
  class UDim2 {
    constructor(xs, xo, ys, yo){ this.X = new UDim(xs, xo); this.Y = new UDim(ys, yo); Object.freeze(this); }
    static new(xs, xo, ys, yo){ return new UDim2(xs, xo, ys, yo); }
    static fromScale(x, y){ return new UDim2(x, 0, y, 0); }
    static fromOffset(x, y){ return new UDim2(0, x, 0, y); }
    get Width(){ return this.X; } get Height(){ return this.Y; }
    Lerp(u, a){ return new UDim2(this.X.Scale + (u.X.Scale-this.X.Scale)*a, this.X.Offset + (u.X.Offset-this.X.Offset)*a, this.Y.Scale + (u.Y.Scale-this.Y.Scale)*a, this.Y.Offset + (u.Y.Offset-this.Y.Offset)*a); }
    toString(){ return '{' + this.X + '}, {' + this.Y + '}'; }
  }

  // CFrame: a position plus a rotation (3×3 matrix, row-major) — enough for the usual
  // CFrame.new(x,y,z), CFrame.Angles, cf * offset and part.CFrame = … patterns.
  class CFrame {
    constructor(x, y, z, m){
      if(x instanceof Vector3){
        const p = x;
        if(y instanceof Vector3){ return CFrame.lookAt(p, y); }
        x = p.X; y = p.Y; z = p.Z;
      }
      this.X = +x || 0; this.Y = +y || 0; this.Z = +z || 0;
      this._m = m || [1,0,0, 0,1,0, 0,0,1];
      Object.freeze(this);
    }
    static new(x, y, z){ return new CFrame(x, y, z); }
    static Angles(rx, ry, rz){
      const cx = Math.cos(rx||0), sx = Math.sin(rx||0), cy = Math.cos(ry||0), sy = Math.sin(ry||0), cz = Math.cos(rz||0), sz = Math.sin(rz||0);
      // Roblox applies Z, then Y, then X: R = Rx * Ry * Rz
      const m = [ cy*cz, -cy*sz, sy,
                  sx*sy*cz + cx*sz, -sx*sy*sz + cx*cz, -sx*cy,
                 -cx*sy*cz + sx*sz,  cx*sy*sz + sx*cz,  cx*cy ];
      return new CFrame(0, 0, 0, m);
    }
    static fromEulerAnglesXYZ(rx, ry, rz){ return CFrame.Angles(rx, ry, rz); }
    static fromOrientation(rx, ry, rz){ return CFrame.Angles(0, ry, 0).mul(CFrame.Angles(rx, 0, 0)).mul(CFrame.Angles(0, 0, rz)); }
    static fromEulerAnglesYXZ(rx, ry, rz){ return CFrame.fromOrientation(rx, ry, rz); }
    static lookAt(at, target){
      const f = target.sub(at).Unit;
      if(!f.Magnitude) return new CFrame(at.X, at.Y, at.Z);
      let r = f.Cross(new Vector3(0,1,0));
      if(r.Magnitude < 1e-6) r = new Vector3(1,0,0); else r = r.Unit;
      const u = r.Cross(f);
      // columns: right, up, back(-look)
      return new CFrame(at.X, at.Y, at.Z, [r.X, u.X, -f.X, r.Y, u.Y, -f.Y, r.Z, u.Z, -f.Z]);
    }
    get Position(){ return new Vector3(this.X, this.Y, this.Z); }
    get p(){ return this.Position; }
    get Rotation(){ return new CFrame(0, 0, 0, this._m); }
    get LookVector(){ const m = this._m; return new Vector3(-m[2], -m[5], -m[8]); }
    get RightVector(){ const m = this._m; return new Vector3(m[0], m[3], m[6]); }
    get UpVector(){ const m = this._m; return new Vector3(m[1], m[4], m[7]); }
    _rot(v){ const m = this._m; return new Vector3(m[0]*v.X + m[1]*v.Y + m[2]*v.Z, m[3]*v.X + m[4]*v.Y + m[5]*v.Z, m[6]*v.X + m[7]*v.Y + m[8]*v.Z); }
    // cf.mul(otherCFrame) or cf.mul(vector3) — Lua's cf * x
    mul(o){
      if(o instanceof Vector3) return this._rot(o).add(this.Position);
      if(!(o instanceof CFrame)) throw new TypeError('CFrame.mul expects a CFrame or Vector3');
      const a = this._m, b = o._m, m = new Array(9);
      for(let i=0;i<3;i++) for(let j=0;j<3;j++) m[i*3+j] = a[i*3]*b[j] + a[i*3+1]*b[3+j] + a[i*3+2]*b[6+j];
      const p = this._rot(o.Position).add(this.Position);
      return new CFrame(p.X, p.Y, p.Z, m);
    }
    add(v){ return new CFrame(this.X + v.X, this.Y + v.Y, this.Z + v.Z, this._m); }
    sub(v){ return new CFrame(this.X - v.X, this.Y - v.Y, this.Z - v.Z, this._m); }
    Inverse(){ const m = this._m; const t = [m[0],m[3],m[6], m[1],m[4],m[7], m[2],m[5],m[8]]; const inv = new CFrame(0,0,0,t); const p = inv._rot(this.Position); return new CFrame(-p.X, -p.Y, -p.Z, t); }
    PointToWorldSpace(v){ return this.mul(v); }
    PointToObjectSpace(v){ return this.Inverse().mul(v); }
    ToWorldSpace(cf){ return this.mul(cf); }
    ToObjectSpace(cf){ return this.Inverse().mul(cf); }
    Lerp(cf, a){ const p = this.Position.Lerp(cf.Position, a); return new CFrame(p.X, p.Y, p.Z, a < 0.5 ? this._m : cf._m); }
    // Euler angles in Roblox's Orientation order (Y, then X, then Z), radians
    ToOrientation(){
      const m = this._m;
      const x = Math.asin(Math.max(-1, Math.min(1, -m[5])));
      let y, z;
      if(Math.abs(m[5]) < 0.9999999){ y = Math.atan2(m[2], m[8]); z = Math.atan2(m[3], m[4]); }
      else { y = Math.atan2(-m[6], m[0]); z = 0; }
      return [x, y, z];
    }
    ToEulerAnglesYXZ(){ return this.ToOrientation(); }
    ToEulerAnglesXYZ(){ const m = this._m; const y = Math.asin(Math.max(-1, Math.min(1, m[2]))); return [Math.atan2(-m[5], m[8]), y, Math.atan2(-m[1], m[0])]; }
    GetComponents(){ return [this.X, this.Y, this.Z].concat(this._m); }
    toString(){ return this.GetComponents().map(r3).join(', '); }
  }
  CFrame.identity = new CFrame();
  CFrame.prototype.Mul = CFrame.prototype.mul; CFrame.prototype.inverse = CFrame.prototype.Inverse; CFrame.prototype.lerp = CFrame.prototype.Lerp;
  const DEG = Math.PI / 180;
  function cframeFrom(pos, ori){ return new CFrame(pos.X, pos.Y, pos.Z, CFrame.fromOrientation(ori.X*DEG, ori.Y*DEG, ori.Z*DEG)._m); }

  // ------------------------------------------------------------------ Enum
  class EnumItem {
    constructor(type, name, value){ this.EnumType = type; this.Name = name; this.Value = value; Object.freeze(this); }
    toString(){ return 'Enum.' + this.EnumType + '.' + this.Name; }
  }
  function makeEnum(type, names){
    const e = {};
    names.forEach((n, i) => { e[n] = new EnumItem(type, n, i); });
    Object.defineProperty(e, 'GetEnumItems', { value: () => names.map(n => e[n]) });
    return Object.freeze(e);
  }
  const MATERIALS = ['Plastic','SmoothPlastic','Neon','Wood','WoodPlanks','Slate','Concrete','Granite','Marble','Pebble','Cobblestone','Brick','Grass','LeafyGrass','Sand','Ice','Glacier','Glass','ForceField','Metal','DiamondPlate','CorrodedMetal','Foil','Fabric','Rock','Basalt'];
  const KEYS = 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z Zero One Two Three Four Five Six Seven Eight Nine Space Return Tab Backspace LeftShift RightShift LeftControl RightControl LeftAlt RightAlt Up Down Left Right F1 F2 F3 F4 Unknown'.split(' ');
  const Enum = Object.freeze({
    Material: makeEnum('Material', MATERIALS),
    PartType: makeEnum('PartType', ['Block','Ball','Cylinder','Wedge']),
    KeyCode: makeEnum('KeyCode', KEYS),
    UserInputType: makeEnum('UserInputType', ['Keyboard','MouseButton1','MouseButton2','Touch','MouseMovement','None']),
    UserInputState: makeEnum('UserInputState', ['Begin','Change','End','Cancel','None']),
    EasingStyle: makeEnum('EasingStyle', ['Linear','Sine','Quad','Cubic','Quart','Quint','Exponential','Circular','Back','Bounce','Elastic']),
    EasingDirection: makeEnum('EasingDirection', ['In','Out','InOut']),
    PlaybackState: makeEnum('PlaybackState', ['Begin','Delayed','Playing','Paused','Completed','Cancelled']),
    HumanoidStateType: makeEnum('HumanoidStateType', ['Running','Jumping','Freefall','Dead','Landed','None']),
    SortOrder: makeEnum('SortOrder', ['LayoutOrder','Name']),
    NormalId: makeEnum('NormalId', ['Front','Back','Left','Right','Top','Bottom']),
    ProductPurchaseDecision: makeEnum('ProductPurchaseDecision', ['NotProcessedYet','PurchaseGranted']),
    InfoType: makeEnum('InfoType', ['Asset','Product','GamePass','Subscription','Bundle']),
    CurrencyType: makeEnum('CurrencyType', ['Default','Robux','Tix','Tokens']),
  });
  // Pictures are Neoblox uploads, referenced by id. "rbxassetid://…"-style prefixes are accepted
  // so Roblox-looking code works; anything else is kept as text but shows nothing.
  function imageIdOf(v){
    if(v === null || v === undefined) return '';
    const s = String(v).trim().replace(/^(rbxassetid|rbxasset|neoblox|nbimg):\/\//i, '').replace(/^.*\/img\//, '');
    return s.slice(0, 200);
  }
  function enumName(v, type, prop){
    if(v instanceof EnumItem){ if(v.EnumType !== type) throw new TypeError(prop + ' expects an Enum.' + type + ', got ' + v); return v.Name; }
    const s = String(v);
    if(Enum[type][s]) return s;
    const hit = Object.keys(Enum[type]).find(k => k.toLowerCase() === s.toLowerCase());
    if(hit) return hit;
    throw new TypeError('"' + s + '" is not a valid Enum.' + type);
  }

  // ------------------------------------------------------------------ Instances
  // Every Instance is wrapped in a Proxy so that, like Roblox, children can be reached by name
  // (workspace.Lava, player.leaderstats.Coins) and a misspelled property throws instead of
  // silently doing nothing.
  const CLASS_PARENT = {};
  const defClass = (name, parent) => { CLASS_PARENT[name] = parent || null; };
  const RESERVED = new Set(['then', 'toJSON', 'constructor', 'inspect']);
  const proxyHandler = {
    get(t, k, r){
      if(typeof k === 'symbol' || k in t) return Reflect.get(t, k, r);
      if(RESERVED.has(k)) return undefined;
      return t._childNamed(k);
    },
    set(t, k, v, r){
      if(typeof k === 'symbol' || k[0] === '_'){ t[k] = v; return true; }
      let o = t, d = null;
      while(o && !(d = Object.getOwnPropertyDescriptor(o, k))) o = Object.getPrototypeOf(o);
      if(!d) throw new Error(k + ' is not a valid member of ' + t._class + ' "' + t._self.GetFullName() + '"');
      if(d.set){ d.set.call(r, v); return true; }
      throw new Error('Unable to assign property ' + k + '. Property is read only');
    },
    deleteProperty(){ throw new Error('Instances can\'t have properties deleted'); },
  };
  function wrap(t){ const p = new Proxy(t, proxyHandler); t._self = p; t._t = t; return p; }

  class Instance {
    constructor(cls){
      this._class = cls; this._name = cls; this._parent = null; this._children = [];
      this._attrs = null; this._destroyed = false; this._live = false; this._locked = false; this._archivable = true;
      this._propSigs = null; this._attrSigs = null;
      this.ChildAdded = new RBXScriptSignal('ChildAdded');
      this.ChildRemoved = new RBXScriptSignal('ChildRemoved');
      this.DescendantAdded = new RBXScriptSignal('DescendantAdded');
      this.DescendantRemoving = new RBXScriptSignal('DescendantRemoving');
      this.Changed = new RBXScriptSignal('Changed');
      this.AncestryChanged = new RBXScriptSignal('AncestryChanged');
      this.AttributeChanged = new RBXScriptSignal('AttributeChanged');
      this.Destroying = new RBXScriptSignal('Destroying');
    }
    static new(className, parent){ return newInstance(className, parent); }
    get ClassName(){ return this._class; }
    get Name(){ return this._name; }
    set Name(v){ v = String(v).slice(0, 100); if(v === this._t._name) return; this._t._name = v; this._t._changed('Name'); onTreeTouched(this); }
    get Parent(){ return this._t._parent; }
    set Parent(p){ setParent(this, p); }
    get Archivable(){ return this._t._archivable; }
    set Archivable(v){ this._t._archivable = !!v; }
    _childNamed(n){ const c = this._children; for(let i = 0; i < c.length; i++) if(c[i]._t._name === n) return c[i]; return undefined; }
    GetChildren(){ return this._t._children.slice(); }
    GetDescendants(){ const out = []; const walk = (i) => i._t._children.forEach(c => { out.push(c); walk(c); }); walk(this); return out; }
    FindFirstChild(name, recursive){
      const n = String(name);
      const direct = this._t._childNamed(n); if(direct) return direct;
      if(recursive) for(const c of this._t._children){ const f = c.FindFirstChild(n, true); if(f) return f; }
      return null;
    }
    FindFirstChildOfClass(cls){ return this._t._children.find(c => c._t._class === cls) || null; }
    FindFirstChildWhichIsA(cls, recursive){
      for(const c of this._t._children){ if(c.IsA(cls)) return c; }
      if(recursive) for(const c of this._t._children){ const f = c.FindFirstChildWhichIsA(cls, true); if(f) return f; }
      return null;
    }
    FindFirstAncestor(name){ let p = this._t._parent; while(p){ if(p._t._name === name) return p; p = p._t._parent; } return null; }
    FindFirstAncestorOfClass(cls){ let p = this._t._parent; while(p){ if(p._t._class === cls) return p; p = p._t._parent; } return null; }
    FindFirstAncestorWhichIsA(cls){ let p = this._t._parent; while(p){ if(p.IsA(cls)) return p; p = p._t._parent; } return null; }
    // const coins = await player.WaitForChild("leaderstats")
    WaitForChild(name, timeout){
      const n = String(name);
      const have = this._t._childNamed(n);
      if(have) return Promise.resolve(have);
      return new Promise(res => {
        let done = false, warned = null;
        const conn = this._t.ChildAdded.Connect(c => { if(!done && c._t._name === n){ done = true; conn.Disconnect(); if(warned) warned.dead = true; res(c); } });
        if(timeout !== undefined) addTimer(+timeout || 0, () => { if(!done){ done = true; conn.Disconnect(); res(null); } });
        else warned = addTimer(5, () => { if(!done) host('log', { kind:'warn', text:'Infinite yield possible on \'' + this.GetFullName() + ':WaitForChild("' + n + '")\'' }); });
      });
    }
    IsA(cls){ let c = this._t._class; while(c){ if(c === cls) return true; c = CLASS_PARENT[c]; } return cls === 'Instance'; }
    IsDescendantOf(a){ let p = this._t._parent; while(p){ if(p === a) return true; p = p._t._parent; } return false; }
    IsAncestorOf(d){ return !!d && d instanceof Instance && d.IsDescendantOf(this._self); }
    GetFullName(){
      const parts = []; let i = this._self;
      while(i && i._t._class !== 'DataModel'){ parts.unshift(i._t._name); i = i._t._parent; }
      return parts.join('.');
    }
    ClearAllChildren(){ this._t._children.slice().forEach(c => { if(!c._t._locked) c.Destroy(); }); }
    Destroy(){
      const t = this._t;
      if(t._destroyed || t._locked) return;
      t.Destroying._fire(this);
      t._children.slice().forEach(c => c.Destroy());
      if(t._parent) setParent(this, null);
      t._destroyed = true;
      Object.keys(t).forEach(k => { if(t[k] instanceof RBXScriptSignal) t[k]._clear(); });
      if(t._propSigs) Object.values(t._propSigs).forEach(s => s._clear());
    }
    Remove(){ this.Parent = null; }
    Clone(){
      const t = this._t;
      if(!t._archivable || !CREATORS[t._class]) return null;
      const c = newInstance(t._class);
      c._t._name = t._name;
      t._copyTo(c._t);
      if(t._attrs) c._t._attrs = Object.assign({}, t._attrs);
      t._children.forEach(ch => { const cc = ch.Clone(); if(cc) cc.Parent = c; });
      return c;
    }
    _copyTo(){ }
    GetAttribute(n){ const a = this._t._attrs; return a && Object.prototype.hasOwnProperty.call(a, n) ? a[n] : undefined; }
    SetAttribute(n, v){
      n = String(n);
      const ok = v === undefined || v === null || ['string','number','boolean'].includes(typeof v) || v instanceof Vector3 || v instanceof Color3 || v instanceof BrickColor || v instanceof UDim2 || v instanceof CFrame;
      if(!ok) throw new TypeError('SetAttribute: ' + typeof v + ' is not a supported attribute type');
      const t = this._t; if(!t._attrs) t._attrs = {};
      if(v === undefined || v === null) delete t._attrs[n]; else t._attrs[n] = v;
      t.AttributeChanged._fire(n);
      if(t._attrSigs && t._attrSigs[n]) t._attrSigs[n]._fire();
    }
    GetAttributes(){ return Object.assign({}, this._t._attrs || {}); }
    GetAttributeChangedSignal(n){ const t = this._t; if(!t._attrSigs) t._attrSigs = {}; return t._attrSigs[n] || (t._attrSigs[n] = new RBXScriptSignal('AttributeChanged')); }
    GetPropertyChangedSignal(prop){ const t = this._t; if(!t._propSigs) t._propSigs = {}; return t._propSigs[prop] || (t._propSigs[prop] = new RBXScriptSignal(prop + 'Changed')); }
    _changed(prop){ this.Changed._fire(prop); if(this._propSigs && this._propSigs[prop]) this._propSigs[prop]._fire(); }
    // "live" = actually in the game (a part under Workspace, a label under StarterGui…) — the
    // classes that show up on screen override these to create/remove themselves on the host.
    _wantLive(){ return false; }
    _enter(){ }
    _leave(){ }
    toString(){ return this._name; }
  }
  Instance.prototype.findFirstChild = Instance.prototype.FindFirstChild;
  Instance.prototype.destroy = Instance.prototype.Destroy;
  Instance.prototype.getChildren = Instance.prototype.GetChildren;
  Instance.prototype.clone = Instance.prototype.Clone;
  Instance.prototype.isA = Instance.prototype.IsA;
  Instance.prototype.waitForChild = Instance.prototype.WaitForChild;
  defClass('Instance');

  const isInst = (x) => x instanceof Instance;
  function setParent(child, p){
    const t = child._t;
    if(p === undefined) p = null;
    if(t._destroyed) throw new Error('The Parent property of ' + t._name + ' is locked, current parent: NULL, new parent ' + (p ? p.Name : 'NULL'));
    if(t._locked) throw new Error('The Parent property of ' + t._name + ' is locked');
    if(p !== null && !isInst(p)) throw new TypeError('Parent must be an Instance or null');
    const old = t._parent;
    if(p === old) return;
    if(p && (p === child || p.IsDescendantOf(child))) throw new Error('Attempt to set parent of ' + child.GetFullName() + ' to ' + p.GetFullName() + ' would result in circular reference');
    if(old){
      fireUp(old, 'DescendantRemoving', child);
      const oc = old._t._children, i = oc.indexOf(child);
      if(i >= 0) oc.splice(i, 1);
    }
    t._parent = p;
    if(p) p._t._children.push(child);
    syncLive(child);
    if(old) old._t.ChildRemoved._fire(child);
    if(p){ p._t.ChildAdded._fire(child); fireUp(p, 'DescendantAdded', child); }
    t._changed('Parent');
    t.AncestryChanged._fire(child, p);
    onTreeTouched(child); if(old) onTreeTouched(old);
  }
  function fireUp(from, sig, inst){ let a = from; while(a){ a._t[sig]._fire(inst); a = a._t._parent; } }
  function syncLive(inst){
    const t = inst._t;
    const want = !t._destroyed && t._wantLive();
    if(want && !t._live){ t._enter(); t._live = true; }       // an error here (e.g. "Too many parts") goes to the script
    else if(!want && t._live){ t._live = false; t._leave(); }
    t._children.forEach(syncLive);
  }
  let WORKSPACE = null, STARTERGUI = null, LOCAL_PLAYER = null, PLAYERS = null;
  function under(inst, root){ return !!root && (inst === root || inst.IsDescendantOf(root)); }

  // ---------------- parts
  const MAT_TYPE = { Plastic:'Plastic', SmoothPlastic:'Plastic' };
  const SHAPES = ['Block','Ball','Cylinder','Wedge'];
  const GAMEPLAY = ['None','KillBrick','Checkpoint','JumpPad'];
  const PARTS = new Map(); // host id -> part
  class BasePart extends Instance {
    constructor(cls, init){
      super(cls || 'Part');
      init = init || {};
      this._rid = init.id || 0;
      this._p = {
        Position: V(init.pos || [0, 0.5, 0]), Size: V(init.size || [1, 1, 1]), Orientation: V(init.rot || [0, 0, 0]),
        Color: C(init.color || '#a3a2a5'), Material: init.material || 'Plastic', Transparency: +init.t || 0,
        CanCollide: init.cc !== false, Anchored: true, CanTouch: true, Shape: init.shape || 'Block', Gameplay: init.gameplay || 'None',
        Locked: false, CastShadow: true, Reflectance: 0, Massless: false,
      };
      this._vel = new Vector3();
      this.Touched = new RBXScriptSignal('Touched');
      this.TouchEnded = new RBXScriptSignal('TouchEnded');
    }
    _wantLive(){ return under(this._self, WORKSPACE); }
    _enter(){
      const r = host('part.new', { id: this._rid || 0, props: this._all() });
      if(r && r.id){ this._rid = r.id; PARTS.set(r.id, this._self); }
    }
    _leave(){ if(this._rid){ host('part.remove', { id: this._rid }); } }
    _all(){ const o = {}; Object.keys(this._p).forEach(k => { o[k] = enc(this._p[k]); }); return o; }
    _push(k){ if(this._live && this._rid) host('part.set', { id: this._rid, k, v: enc(this._p[k]) }); }
    _get(k){
      if(k === 'Position' && !this._p.Anchored && this._live && this._rid){
        const r = host('part.get', { id: this._rid });
        if(r && r.pos){ this._p.Position = V(r.pos); this._vel = V(r.vel); }
      }
      return this._p[k];
    }
    _set(k, v){
      const t = this._t;
      const old = t._p[k];
      if(old === v || (old && old.equals && old.equals(v))) return;
      t._p[k] = v;
      t._push(k);
      t._changed(k);
    }
    _copyTo(o){ o._p = Object.assign({}, this._p); }
    get CFrame(){ return cframeFrom(this._t._get('Position'), this._t._p.Orientation); }
    set CFrame(cf){
      if(!(cf instanceof CFrame)) throw new TypeError('CFrame must be a CFrame (got ' + typeof cf + ')');
      const o = cf.ToOrientation();
      this._t._set('Orientation', new Vector3(o[0]/DEG, o[1]/DEG, o[2]/DEG));
      this._t._set('Position', cf.Position);
    }
    get BrickColor(){ return BrickColor.fromColor3(this._t._p.Color); }
    set BrickColor(b){ if(!(b instanceof BrickColor)) throw new TypeError('BrickColor must be a BrickColor — try BrickColor.new("Bright red")'); this.Color = b.Color; }
    get AssemblyLinearVelocity(){ this._t._get('Position'); return this._t._vel; }
    set AssemblyLinearVelocity(v){ if(!(v instanceof Vector3)) throw new TypeError('Velocity must be a Vector3'); this._t._vel = v; if(this._t._live && this._t._rid) host('part.set', { id:this._t._rid, k:'Velocity', v:VA(v) }); }
    get Velocity(){ return this.AssemblyLinearVelocity; }
    set Velocity(v){ this.AssemblyLinearVelocity = v; }
    get Mass(){ const s = this._t._p.Size; return s.X * s.Y * s.Z * 0.7; }
    GetMass(){ return this.Mass; }
    GetPivot(){ return this.CFrame; }
    PivotTo(cf){ this.CFrame = cf; }
    GetTouchingParts(){ return []; }
    BreakJoints(){ }
    MakeJoints(){ }
  }
  function enc(v){
    if(v instanceof Vector3) return VA(v);
    if(v instanceof Color3) return CHEX(v);
    return v;
  }
  const PART_PROPS = {
    Position: (v) => { if(!(v instanceof Vector3)) throw new TypeError('Position must be a Vector3 — try new Vector3(0, 5, 0)'); return v; },
    Size: (v) => { if(!(v instanceof Vector3)) throw new TypeError('Size must be a Vector3'); return new Vector3(Math.min(Math.max(v.X, 0.05), 512), Math.min(Math.max(v.Y, 0.05), 512), Math.min(Math.max(v.Z, 0.05), 512)); },
    Orientation: (v) => { if(!(v instanceof Vector3)) throw new TypeError('Orientation must be a Vector3 (degrees)'); return v; },
    Rotation: null,
    Color: (v) => { if(v instanceof Color3) return v; if(typeof v === 'string') return Color3.fromHex(v); throw new TypeError('Color must be a Color3 — try Color3.fromRGB(255, 0, 0)'); },
    Material: (v) => enumName(v, 'Material', 'Material'),
    Transparency: (v) => Math.min(1, Math.max(0, num(v, 'Transparency'))),
    Reflectance: (v) => Math.min(1, Math.max(0, num(v, 'Reflectance'))),
    CanCollide: (v) => !!v, Anchored: (v) => !!v, CanTouch: (v) => !!v, Locked: (v) => !!v, CastShadow: (v) => !!v, Massless: (v) => !!v,
    Shape: (v) => enumName(v, 'PartType', 'Shape'),
    Gameplay: (v) => { const s = String(v); const hit = GAMEPLAY.find(g => g.toLowerCase() === s.toLowerCase()); if(!hit) throw new TypeError('Gameplay must be one of ' + GAMEPLAY.join(', ')); return hit; },
  };
  Object.keys(PART_PROPS).forEach(k => {
    const check = PART_PROPS[k];
    if(!check) return;
    Object.defineProperty(BasePart.prototype, k, {
      get(){
        const v = this._t._get(k);
        if(k === 'Material') return Enum.Material[v] || Enum.Material.Plastic;
        if(k === 'Shape') return Enum.PartType[v] || Enum.PartType.Block;
        return v;
      },
      set(v){ this._t._set(k, check(v)); },
      configurable: true,
    });
  });
  Object.defineProperty(BasePart.prototype, 'Rotation', { get(){ return this.Orientation; }, set(v){ this.Orientation = v; }, configurable:true });
  defClass('PVInstance', 'Instance'); defClass('BasePart', 'PVInstance'); defClass('Part', 'BasePart'); defClass('SpawnLocation', 'Part'); defClass('WedgePart', 'BasePart');

  // The pieces of a player's character: their Position follows the real avatar.
  const BODY_OFFSETS = { HumanoidRootPart:[0,1,0], Torso:[0,1,0], Head:[0,1.55,0], 'Left Arm':[-0.38,1,0], 'Right Arm':[0.38,1,0], 'Left Leg':[-0.13,0.35,0], 'Right Leg':[0.13,0.35,0] };
  class CharacterPart extends BasePart {
    constructor(name, owner){ super('Part', { size: name === 'Head' ? [0.6,0.6,0.6] : name === 'Torso' || name === 'HumanoidRootPart' ? [0.8,0.8,0.4] : [0.3,0.8,0.3] }); this._name = name; this._owner = owner; this._p.CanCollide = false; this._p.Anchored = false; }
    _wantLive(){ return false; }
    _get(k){
      if(k === 'Position'){
        const st = this._owner._state(); const o = BODY_OFFSETS[this._name] || [0,1,0];
        if(st && st.pos) return new Vector3(st.pos[0] + o[0], st.pos[1] + o[1], st.pos[2] + o[2]);
      }
      return this._p[k];
    }
    _set(k, v){
      if(k === 'Position' && this._name === 'HumanoidRootPart'){ this._owner._teleport(new Vector3(v.X, v.Y - 1, v.Z)); return; }
      if(k === 'Position' || k === 'Orientation') return; // other body parts follow the root
      this._p[k] = v; this._changed(k);
    }
    get AssemblyLinearVelocity(){ const st = this._t._owner._state(); return st && st.vel ? V(st.vel) : new Vector3(); }
    set AssemblyLinearVelocity(v){ if(!(v instanceof Vector3)) throw new TypeError('Velocity must be a Vector3'); this._t._owner._setVel(v); }
  }
  class Model extends Instance {
    constructor(cls){ super(cls || 'Model'); this._primary = null; }
    get PrimaryPart(){ return this._t._primary; }
    set PrimaryPart(p){ if(p !== null && !(p instanceof BasePart)) throw new TypeError('PrimaryPart must be a BasePart'); this._t._primary = p; }
    _parts(){ return this.GetDescendants().filter(d => d instanceof BasePart); }
    GetPivot(){ const p = this._t._primary || this._t._parts()[0]; return p ? p.CFrame : new CFrame(); }
    PivotTo(cf){
      const piv = this.GetPivot().Position, to = cf.Position;
      const d = to.sub(piv);
      this._t._parts().forEach(p => { p.Position = p.Position.add(d); });
    }
    MoveTo(pos){ if(!(pos instanceof Vector3)) throw new TypeError('MoveTo expects a Vector3'); this.PivotTo(new CFrame(pos.X, pos.Y, pos.Z)); }
    TranslateBy(d){ this._t._parts().forEach(p => { p.Position = p.Position.add(d); }); }
    GetBoundingBox(){ const ps = this._t._parts(); if(!ps.length) return [new CFrame(), new Vector3()]; let mn = null, mx = null; ps.forEach(p => { const h = p.Size.mul(0.5); const a = p.Position.sub(h), b = p.Position.add(h); mn = mn ? mn.Min(a) : a; mx = mx ? mx.Max(b) : b; }); const c = mn.add(mx).mul(0.5); return [new CFrame(c.X, c.Y, c.Z), mx.sub(mn)]; }
    GetExtentsSize(){ return this.GetBoundingBox()[1]; }
    _copyTo(o){ o._primary = null; }
  }
  defClass('Model', 'PVInstance');
  class Character extends Model {
    constructor(owner){ super('Model'); this._owner = owner; }
    PivotTo(cf){ this._t._owner._teleport(new Vector3(cf.Position.X, cf.Position.Y - 1, cf.Position.Z)); }
    MoveTo(pos){ if(!(pos instanceof Vector3)) throw new TypeError('MoveTo expects a Vector3'); this._t._owner._teleport(new Vector3(pos.X, pos.Y - 1, pos.Z)); }
    GetPivot(){ const st = this._t._owner._state(); const p = st && st.pos ? st.pos : [0,0,0]; return new CFrame(p[0], p[1] + 1, p[2]); }
    Clone(){ return null; }
  }

  class Humanoid extends Instance {
    constructor(owner){
      super('Humanoid'); this._owner = owner;
      this.Died = new RBXScriptSignal('Died');
      this.HealthChanged = new RBXScriptSignal('HealthChanged');
      this.Jumping = new RBXScriptSignal('Jumping');
      this.Running = new RBXScriptSignal('Running');
      this.StateChanged = new RBXScriptSignal('StateChanged');
    }
    _st(){ return this._t._owner._state() || {}; }
    get Health(){ const s = this._t._st(); return s.health !== undefined ? s.health : 100; }
    set Health(v){ this._t._owner._setChar({ health: num(v, 'Health') }); }
    get MaxHealth(){ const s = this._t._st(); return s.max !== undefined ? s.max : 100; }
    set MaxHealth(v){ this._t._owner._setChar({ max: num(v, 'MaxHealth') }); }
    get WalkSpeed(){ const s = this._t._st(); return s.ws !== undefined ? s.ws : 16; }
    set WalkSpeed(v){ this._t._owner._setChar({ ws: num(v, 'WalkSpeed') }); }
    get JumpPower(){ const s = this._t._st(); return s.jp !== undefined ? s.jp : 50; }
    set JumpPower(v){ this._t._owner._setChar({ jp: num(v, 'JumpPower') }); }
    get JumpHeight(){ return this.JumpPower * 0.144; }
    set JumpHeight(v){ this.JumpPower = num(v, 'JumpHeight') / 0.144; }
    get Jump(){ return false; }
    set Jump(v){ if(v) this._t._owner._setChar({ jump: true }); }
    get DisplayName(){ return this._t._owner.DisplayName; }
    get RootPart(){ return this._t._parent ? this._t._parent.FindFirstChild('HumanoidRootPart') : null; }
    get FloorMaterial(){ return Enum.Material.Plastic; }
    get MoveDirection(){ return new Vector3(); }
    get Sit(){ return false; } set Sit(v){ }
    TakeDamage(n){ this._t._owner._setChar({ damage: Math.max(0, num(n, 'TakeDamage amount')) }); }
    ChangeState(){ }
    GetState(){ return this.Health <= 0 ? Enum.HumanoidStateType.Dead : Enum.HumanoidStateType.Running; }
    MoveTo(){ }
    UnequipTools(){ }
    Clone(){ return null; }
  }

  // ---------------- players
  class Player extends Instance {
    constructor(info, local){
      super('Player');
      this._name = info.name || 'Player';
      this._info = info; this._local = !!local; this._char = null; this._pending = null;
      this.CharacterAdded = new RBXScriptSignal('CharacterAdded');
      this.CharacterRemoving = new RBXScriptSignal('CharacterRemoving');
      this.CharacterAppearanceLoaded = new RBXScriptSignal('CharacterAppearanceLoaded');
      this.Chatted = new RBXScriptSignal('Chatted');
      this._respawnAt = null;
    }
    get UserId(){ return this._t._info.userId || 0; }
    get DisplayName(){ return this._t._info.name || this._t._name; }
    get Character(){ return this._t._char; }
    set Character(v){ }
    get AccountAge(){ return 0; }
    get MembershipType(){ return 'None'; }
    get RespawnLocation(){ return this._t._respawnAt; }
    set RespawnLocation(p){
      if(p !== null && !(p instanceof BasePart)) throw new TypeError('RespawnLocation must be a part (or null)');
      this._t._respawnAt = p;
      if(this._t._local) host('player.spawnat', p && p._t._rid ? { id: p._t._rid } : { clear: true });
    }
    get PlayerGui(){ return STARTERGUI; }
    get leaderstats(){ return this._t._childNamed('leaderstats'); }
    _state(){
      if(this._local) return host('char.get');
      return host('pl.get', { id: this._info.id });
    }
    _teleport(v){ if(this._local) host('char.set', { pos: VA(v) }); }
    _setVel(v){ if(this._local) host('char.set', { vel: VA(v) }); }
    _setChar(o){ if(this._local) host('char.set', o); }
    Kick(msg){ if(this._t._local) host('player.kick', { msg: msg === undefined ? '' : fmt(msg).slice(0, 200) }); }
    LoadCharacter(){ if(this._t._local) host('player.respawn'); }
    GetMouse(){ return null; }
    // Neoblox extra: give this player Battle Pass XP (small amounts, capped per game)
    GiveXP(n){ if(this._t._local) host('player.xp', { n: Math.max(0, Math.floor(num(n, 'XP'))) }); }
    IsFriendsWith(){ return false; }
    GetRankInGroup(){ return 0; }
    _copyTo(){ }
    Clone(){ return null; }
  }
  function buildCharacter(player){
    const t = player._t;
    const ch = wrap(new Character(t));
    ch._t._name = t._name;
    const hum = wrap(new Humanoid(t));
    ['HumanoidRootPart','Head','Torso','Left Arm','Right Arm','Left Leg','Right Leg'].forEach(n => { const p = wrap(new CharacterPart(n, t)); p.Parent = ch; });
    hum.Parent = ch;
    ch._t._primary = ch._t._childNamed('HumanoidRootPart');
    return ch;
  }
  function spawnCharacter(player){
    const t = player._t;
    if(t._char){ t.CharacterRemoving._fire(t._char); const old = t._char; t._char = null; try{ old.Destroy(); }catch(e){} }
    const ch = buildCharacter(player);
    ch.Parent = WORKSPACE;
    t._char = ch;
    t.CharacterAdded._fire(ch);
    t.CharacterAppearanceLoaded._fire(ch);
    return ch;
  }

  // ---------------- values / folders / misc
  class ValueBase extends Instance {
    constructor(cls, dflt, check){ super(cls); this._value = dflt; this._check = check; }
    get Value(){ return this._t._value; }
    set Value(v){
      const t = this._t;
      v = t._check(v);
      if(v === t._value) return;
      t._value = v;
      t.Changed._fire(v);
      if(t._propSigs && t._propSigs.Value) t._propSigs.Value._fire();
      onTreeTouched(this);
    }
    _changed(prop){ if(prop !== 'Value' && this._propSigs && this._propSigs[prop]) this._propSigs[prop]._fire(); }
    _copyTo(o){ o._value = this._value; }
  }
  defClass('ValueBase', 'Instance');
  const VALUE_TYPES = {
    IntValue: [0, (v) => { const n = Math.round(num(v, 'Value')); return Math.max(-9007199254740991, Math.min(9007199254740991, n)); }],
    NumberValue: [0, (v) => num(v, 'Value')],
    StringValue: ['', (v) => String(v === undefined || v === null ? '' : v).slice(0, 2000)],
    BoolValue: [false, (v) => !!v],
    ObjectValue: [null, (v) => { if(v !== null && v !== undefined && !isInst(v)) throw new TypeError('ObjectValue.Value must be an Instance'); return v || null; }],
    Vector3Value: [Vector3.zero, (v) => { if(!(v instanceof Vector3)) throw new TypeError('Value must be a Vector3'); return v; }],
    Color3Value: [new Color3(1,1,1), (v) => { if(!(v instanceof Color3)) throw new TypeError('Value must be a Color3'); return v; }],
  };
  Object.keys(VALUE_TYPES).forEach(k => defClass(k, 'ValueBase'));
  defClass('Folder', 'Instance'); defClass('Configuration', 'Instance');

  class ClickDetector extends Instance {
    constructor(){ super('ClickDetector'); this._dist = 32; this.MouseClick = new RBXScriptSignal('MouseClick'); this.MouseHoverEnter = new RBXScriptSignal('MouseHoverEnter'); this.MouseHoverLeave = new RBXScriptSignal('MouseHoverLeave'); this.RightMouseClick = new RBXScriptSignal('RightMouseClick'); }
    get MaxActivationDistance(){ return this._t._dist; }
    set MaxActivationDistance(v){ this._t._dist = Math.max(0, Math.min(1000, num(v, 'MaxActivationDistance'))); if(this._t._live) this._t._enter(); }
    _wantLive(){ const p = this._parent; return !!(p && p._t instanceof BasePart && p._t._live && p._t._rid); }
    _enter(){ this._host = this._parent._t._rid; host('clickable', { id: this._host, on: true, dist: this._dist }); }
    _leave(){ if(this._host){ host('clickable', { id: this._host, on: false }); this._host = 0; } }
    _copyTo(o){ o._dist = this._dist; }
  }
  defClass('ClickDetector', 'Instance');

  class PointLight extends Instance {
    constructor(){ super('PointLight'); this._l = { Brightness: 1, Range: 8, Color: new Color3(1,1,1), Enabled: true }; }
    _wantLive(){ const p = this._parent; return !!(p && p._t instanceof BasePart && p._t._live && p._t._rid); }
    _sync(){ if(this._live) host('light', { id: this._host, on: this._l.Enabled, color: CHEX(this._l.Color), b: this._l.Brightness, r: this._l.Range }); }
    _enter(){ this._host = this._parent._t._rid; this._live = true; this._sync(); }
    _leave(){ if(this._host){ host('light', { id: this._host, on: false }); this._host = 0; } }
    _copyTo(o){ o._l = Object.assign({}, this._l); }
  }
  [['Brightness', (v) => Math.max(0, Math.min(40, num(v, 'Brightness')))], ['Range', (v) => Math.max(0, Math.min(60, num(v, 'Range')))],
   ['Color', (v) => { if(!(v instanceof Color3)) throw new TypeError('Color must be a Color3'); return v; }], ['Enabled', (v) => !!v]].forEach(([k, check]) => {
    Object.defineProperty(PointLight.prototype, k, { get(){ return this._t._l[k]; }, set(v){ this._t._l[k] = check(v); this._t._sync(); this._t._changed(k); }, configurable:true });
  });
  defClass('Light', 'Instance'); defClass('PointLight', 'Light');

  // A picture on one face of a part (Roblox's Decal). Texture is a picture id from My Pictures.
  let decalSeq = 1;
  class Decal extends Instance {
    constructor(init){
      super('Decal');
      init = init || {};
      this._tex = init.image || ''; this._face = init.face || 'Front'; this._key = init.key || ('d' + (decalSeq++)); this._tr = 0; this._color = new Color3(1,1,1);
    }
    get Texture(){ return this._t._tex; }
    set Texture(v){ this._t._tex = imageIdOf(v); this._t._sync(); this._t._changed('Texture'); }
    get Face(){ return Enum.NormalId[this._t._face] || Enum.NormalId.Front; }
    set Face(v){ this._t._face = enumName(v, 'NormalId', 'Face'); this._t._sync(); this._t._changed('Face'); }
    get Transparency(){ return this._t._tr; }
    set Transparency(v){ this._t._tr = Math.min(1, Math.max(0, num(v, 'Transparency'))); this._t._sync(); this._t._changed('Transparency'); }
    get Color3(){ return this._t._color; }
    set Color3(v){ if(!(v instanceof Color3)) throw new TypeError('Color3 must be a Color3'); this._t._color = v; }
    _wantLive(){ const p = this._parent; return !!(p && p._t instanceof BasePart && p._t._live && p._t._rid); }
    _sync(){ if(this._live && this._host) host('decal', { id: this._host, key: this._key, image: this._tex, face: this._face.toLowerCase(), t: this._tr }); }
    _enter(){ this._host = this._parent._t._rid; this._live = true; this._sync(); }
    _leave(){ if(this._host){ host('decal', { id: this._host, key: this._key, clear:true }); this._host = 0; } }
    _copyTo(o){ o._tex = this._tex; o._face = this._face; o._tr = this._tr; }
  }
  defClass('FaceInstance', 'Instance'); defClass('Decal', 'FaceInstance'); defClass('Texture', 'Decal');

  class Sound extends Instance {
    constructor(){ super('Sound'); this._id = ''; this._vol = 0.5; this.Ended = new RBXScriptSignal('Ended'); this.Played = new RBXScriptSignal('Played'); }
    get SoundId(){ return this._t._id; }
    set SoundId(v){ this._t._id = String(v).slice(0, 200); }
    get Volume(){ return this._t._vol; }
    set Volume(v){ this._t._vol = Math.max(0, Math.min(10, num(v, 'Volume'))); }
    get Playing(){ return false; } set Playing(v){ if(v) this.Play(); }
    get IsPlaying(){ return false; }
    get Looped(){ return false; } set Looped(v){ }
    get PlaybackSpeed(){ return 1; } set PlaybackSpeed(v){ }
    get TimeLength(){ return 0.5; }
    Play(){ host('sound', { name: this._t._id, vol: this._t._vol }); this._t.Played._fire(this._t._id); addTimer(0.5, () => this._t.Ended._fire(this._t._id)); }
    Stop(){ } Pause(){ } Resume(){ this.Play(); }
    _copyTo(o){ o._id = this._id; o._vol = this._vol; }
  }
  defClass('Sound', 'Instance');

  class BindableEvent extends Instance {
    constructor(){ super('BindableEvent'); this.Event = new RBXScriptSignal('Event'); }
    Fire(...a){ this._t.Event._fire(...a); }
  }
  class BindableFunction extends Instance {
    constructor(){ super('BindableFunction'); this._fn = null; }
    get OnInvoke(){ return this._t._fn; }
    set OnInvoke(f){ if(f !== null && typeof f !== 'function') throw new TypeError('OnInvoke must be a function'); this._t._fn = f; }
    async Invoke(...a){ if(!this._t._fn) throw new Error('OnInvoke is not set'); return await this._t._fn(...a); }
  }
  // Every script runs on the player's own device, so a RemoteEvent simply calls straight
  // through — Roblox tutorial code that uses them still works.
  class RemoteEvent extends Instance {
    constructor(){ super('RemoteEvent'); this.OnServerEvent = new RBXScriptSignal('OnServerEvent'); this.OnClientEvent = new RBXScriptSignal('OnClientEvent'); }
    FireServer(...a){ this._t.OnServerEvent._fire(LOCAL_PLAYER, ...a); }
    FireClient(player, ...a){ if(player === LOCAL_PLAYER) this._t.OnClientEvent._fire(...a); }
    FireAllClients(...a){ this._t.OnClientEvent._fire(...a); }
  }
  class RemoteFunction extends Instance {
    constructor(){ super('RemoteFunction'); this._s = null; this._c = null; }
    get OnServerInvoke(){ return this._t._s; } set OnServerInvoke(f){ this._t._s = f; }
    get OnClientInvoke(){ return this._t._c; } set OnClientInvoke(f){ this._t._c = f; }
    async InvokeServer(...a){ if(!this._t._s) throw new Error('OnServerInvoke is not set'); return await this._t._s(LOCAL_PLAYER, ...a); }
    async InvokeClient(p, ...a){ if(!this._t._c) throw new Error('OnClientInvoke is not set'); return await this._t._c(...a); }
  }
  ['BindableEvent','BindableFunction','RemoteEvent','RemoteFunction'].forEach(k => defClass(k, 'Instance'));

  class BaseScript extends Instance {
    constructor(cls){ super(cls || 'Script'); this._enabled = true; }
    get Enabled(){ return this._t._enabled; } set Enabled(v){ this._t._enabled = !!v; }
    get Disabled(){ return !this._t._enabled; } set Disabled(v){ this._t._enabled = !v; }
    get Source(){ return ''; }
  }
  defClass('LuaSourceContainer', 'Instance'); defClass('BaseScript', 'LuaSourceContainer'); defClass('Script', 'BaseScript'); defClass('LocalScript', 'BaseScript'); defClass('ModuleScript', 'LuaSourceContainer');

  // ---------------- on-screen GUI (TextLabel / TextButton in StarterGui)
  const GUIS = new Map(); // host id -> gui object
  class GuiObject extends Instance {
    constructor(cls, init){
      super(cls);
      init = init || {};
      this._gid = init.id || '';
      this._g = { Text: init.text !== undefined ? String(init.text) : cls, Visible: init.visible !== false, Position: UDim2.fromScale((init.x !== undefined ? init.x : 50)/100, (init.y !== undefined ? init.y : 50)/100),
        TextColor3: init.tc ? C(init.tc) : null, BackgroundColor3: init.bg ? C(init.bg) : null, TextSize: init.ts || 0, Size: UDim2.fromOffset(200, 50), BackgroundTransparency: 0, ZIndex: 1, LayoutOrder: 0, TextScaled:false, Font:'SourceSans',
        Image: init.img || '' };
      if(cls === 'ImageLabel'){ const w = init.w || 160; this._g.Size = UDim2.fromOffset(w, w); this._g.Text = ''; }
      if(cls === 'TextButton'){
        this.MouseButton1Click = new RBXScriptSignal('MouseButton1Click');
        this.Activated = new RBXScriptSignal('Activated');
        this.MouseButton1Down = new RBXScriptSignal('MouseButton1Down');
        this.MouseButton1Up = new RBXScriptSignal('MouseButton1Up');
      }
      this.MouseEnter = new RBXScriptSignal('MouseEnter');
      this.MouseLeave = new RBXScriptSignal('MouseLeave');
    }
    _wantLive(){ return under(this._self, STARTERGUI) && !this._hiddenByParent(); }
    _hiddenByParent(){ let p = this._parent; while(p && p !== STARTERGUI){ if(p._t._class === 'ScreenGui' && p._t._enabled === false) return true; p = p._t._parent; } return false; }
    _hostProps(){
      const g = this._g;
      const kind = this._class === 'TextButton' ? 'button' : this._class === 'ImageLabel' ? 'image' : 'label';
      return { kind, text: g.Text.slice(0, 200), visible: g.Visible, x: g.Position.X.Scale*100, y: g.Position.Y.Scale*100, tc: g.TextColor3 ? CHEX(g.TextColor3) : null, bg: g.BackgroundColor3 ? CHEX(g.BackgroundColor3) : null, ts: g.TextSize || 0,
        img: g.Image, w: g.Size.X.Offset || 160 };
    }
    _enter(){ const r = host('gui.new', { id: this._gid, props: this._hostProps() }); if(r && r.id){ this._gid = r.id; GUIS.set(r.id, this._self); } }
    _leave(){ if(this._gid) host('gui.remove', { id: this._gid }); }
    _copyTo(o){ o._g = Object.assign({}, this._g); o._gid = ''; }
  }
  const GUI_PROPS = {
    Text: (v) => String(v === undefined || v === null ? '' : (typeof v === 'string' ? v : fmt(v))).slice(0, 200),
    Visible: (v) => !!v,
    Position: (v) => { if(!(v instanceof UDim2)) throw new TypeError('Position must be a UDim2 — try UDim2.fromScale(0.5, 0.1)'); return v; },
    Size: (v) => { if(!(v instanceof UDim2)) throw new TypeError('Size must be a UDim2'); return v; },
    TextColor3: (v) => { if(!(v instanceof Color3)) throw new TypeError('TextColor3 must be a Color3'); return v; },
    BackgroundColor3: (v) => { if(!(v instanceof Color3)) throw new TypeError('BackgroundColor3 must be a Color3'); return v; },
    TextSize: (v) => Math.max(6, Math.min(72, num(v, 'TextSize'))),
    BackgroundTransparency: (v) => Math.max(0, Math.min(1, num(v, 'BackgroundTransparency'))),
    ZIndex: (v) => num(v, 'ZIndex'), LayoutOrder: (v) => num(v, 'LayoutOrder'), TextScaled: (v) => !!v, Font: (v) => String(v),
    Image: (v) => imageIdOf(v),
  };
  Object.keys(GUI_PROPS).forEach(k => {
    Object.defineProperty(GuiObject.prototype, k, {
      get(){ return this._t._g[k]; },
      set(v){
        const t = this._t; v = GUI_PROPS[k](v);
        if(t._g[k] === v || (v && v.equals && v.equals(t._g[k]))) return;
        t._g[k] = v;
        if(t._live && t._gid && ['Text','Visible','Position','TextColor3','BackgroundColor3','TextSize','Image','Size'].includes(k)) host('gui.set', { id: t._gid, props: t._hostProps() });
        t._changed(k);
      },
      configurable: true,
    });
  });
  class ScreenGui extends Instance {
    constructor(){ super('ScreenGui'); this._enabled = true; }
    get Enabled(){ return this._t._enabled; }
    set Enabled(v){ this._t._enabled = !!v; this._t._children.forEach(syncLive); }
    get ResetOnSpawn(){ return false; } set ResetOnSpawn(v){ }
    get IgnoreGuiInset(){ return false; } set IgnoreGuiInset(v){ }
    _copyTo(o){ o._enabled = this._enabled; }
  }
  defClass('GuiBase', 'Instance'); defClass('GuiObject', 'GuiBase'); defClass('TextLabel', 'GuiObject'); defClass('TextButton', 'GuiObject'); defClass('ImageLabel', 'GuiObject'); defClass('Frame', 'GuiObject');
  defClass('LayerCollector', 'GuiBase'); defClass('ScreenGui', 'LayerCollector');

  // ---------------- tweens
  const EASE = {
    Linear: (t) => t, Sine: (t) => 1 - Math.cos(t * Math.PI / 2), Quad: (t) => t*t, Cubic: (t) => t*t*t, Quart: (t) => t*t*t*t, Quint: (t) => t*t*t*t*t,
    Exponential: (t) => t === 0 ? 0 : Math.pow(2, 10*t - 10), Circular: (t) => 1 - Math.sqrt(1 - t*t),
    Back: (t) => 2.70158*t*t*t - 1.70158*t*t,
    Bounce: (t) => 1 - bounceOut(1 - t),
    Elastic: (t) => t === 0 || t === 1 ? t : -Math.pow(2, 10*t - 10) * Math.sin((t*10 - 10.75) * (2*Math.PI/3)),
  };
  function bounceOut(x){ const n = 7.5625, d = 2.75; if(x < 1/d) return n*x*x; if(x < 2/d) return n*(x -= 1.5/d)*x + 0.75; if(x < 2.5/d) return n*(x -= 2.25/d)*x + 0.9375; return n*(x -= 2.625/d)*x + 0.984375; }
  function ease(style, dir, t){
    const f = EASE[style] || EASE.Quad;
    if(dir === 'In') return f(t);
    if(dir === 'Out') return 1 - f(1 - t);
    return t < 0.5 ? f(t*2) / 2 : 1 - f((1 - t)*2) / 2;
  }
  class TweenInfo {
    constructor(time, style, dir, repeatCount, reverses, delay){
      this.Time = time === undefined ? 1 : Math.max(0, num(time, 'Time'));
      this.EasingStyle = style instanceof EnumItem ? style : Enum.EasingStyle[style] || Enum.EasingStyle.Quad;
      this.EasingDirection = dir instanceof EnumItem ? dir : Enum.EasingDirection[dir] || Enum.EasingDirection.Out;
      this.RepeatCount = Math.floor(+repeatCount || 0); this.Reverses = !!reverses; this.DelayTime = Math.max(0, +delay || 0);
      Object.freeze(this);
    }
    static new(...a){ return new TweenInfo(...a); }
  }
  function lerpAny(a, b, t){
    if(typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
    if(a && typeof a.Lerp === 'function') return a.Lerp(b, t);
    return t < 1 ? a : b;
  }
  const TWEENS = new Set();
  class Tween extends Instance {
    constructor(inst, info, goals){
      super('Tween');
      this._inst = inst; this._info = info; this._goals = goals; this._state = 'Begin'; this._el = 0; this._from = null; this._loops = 0; this._back = false;
      this.Completed = new RBXScriptSignal('Completed');
    }
    get Instance(){ return this._t._inst; }
    get TweenInfo(){ return this._t._info; }
    get PlaybackState(){ return Enum.PlaybackState[this._t._state]; }
    Play(){
      const t = this._t;
      if(t._state === 'Playing') return;
      if(t._state !== 'Paused'){ t._el = -t._info.DelayTime; t._loops = 0; t._back = false; t._from = {}; Object.keys(t._goals).forEach(k => { t._from[k] = t._inst[k]; }); }
      t._state = 'Playing'; TWEENS.add(t);
    }
    Pause(){ const t = this._t; if(t._state === 'Playing'){ t._state = 'Paused'; TWEENS.delete(t); } }
    Cancel(){ const t = this._t; if(t._state === 'Playing' || t._state === 'Paused'){ t._state = 'Cancelled'; TWEENS.delete(t); t.Completed._fire(Enum.PlaybackState.Cancelled); } }
    _step(dt){
      this._el += dt;
      if(this._el < 0) return;
      const info = this._info, dur = info.Time;
      let a = dur > 0 ? Math.min(1, this._el / dur) : 1;
      const e = ease(info.EasingStyle.Name, info.EasingDirection.Name, this._back ? 1 - a : a);
      try{ Object.keys(this._goals).forEach(k => { this._inst[k] = lerpAny(this._from[k], this._goals[k], e); }); }
      catch(err){ TWEENS.delete(this); this._state = 'Cancelled'; reportError(err); return; }
      if(a >= 1){
        if(info.Reverses && !this._back){ this._back = true; this._el = 0; return; }
        if(info.RepeatCount < 0 || this._loops < info.RepeatCount){ this._loops++; this._back = false; this._el = 0; return; }
        TWEENS.delete(this); this._state = 'Completed'; this.Completed._fire(Enum.PlaybackState.Completed);
      }
    }
  }
  defClass('TweenBase', 'Instance'); defClass('Tween', 'TweenBase');

  // ------------------------------------------------------------------ services
  class Service extends Instance { constructor(name){ super(name); this._locked = true; } Clone(){ return null; } }
  class DataModel extends Instance {
    constructor(){ super('DataModel'); this._name = 'Game'; this._locked = true; }
    GetService(name){ const s = SERVICES[String(name)]; if(!s) throw new Error('\'' + name + '\' is not a valid Service name'); return s; }
    FindService(name){ return SERVICES[String(name)] || null; }
    get PlaceId(){ return 0; } get GameId(){ return 0; } get JobId(){ return ''; }
    get CreatorId(){ return 0; }
    // game.BindToClose(fn): runs fn when the player leaves the game (a good time to save)
    BindToClose(fn){ if(typeof fn !== 'function') throw new TypeError('BindToClose needs a function'); if(CLOSE_FNS.length < 50) CLOSE_FNS.push(fn); }
    IsLoaded(){ return true; }
    Clone(){ return null; }
  }
  DataModel.prototype.getService = DataModel.prototype.GetService;
  class Workspace extends Service {
    constructor(){ super('Workspace'); this._gravity = 196.2; }
    get Gravity(){ return this._t._gravity; }
    set Gravity(v){ this._t._gravity = Math.max(0, Math.min(1000, num(v, 'Gravity'))); host('gravity', { g: this._t._gravity }); }
    get CurrentCamera(){ return null; }
    get DistributedGameTime(){ return NOW; }
    _wantLive(){ return true; }
    // workspace.Raycast(origin, direction) -> { Instance, Position, Normal, Distance, Material } | null
    Raycast(origin, dir, params){
      if(!(origin instanceof Vector3) || !(dir instanceof Vector3)) throw new TypeError('Raycast expects (origin: Vector3, direction: Vector3)');
      const ignore = [];
      if(params && Array.isArray(params.FilterDescendantsInstances)) params.FilterDescendantsInstances.forEach(i => { if(i instanceof BasePart && i._t._rid) ignore.push(i._t._rid); if(isInst(i)) i.GetDescendants().forEach(d => { if(d instanceof BasePart && d._t._rid) ignore.push(d._t._rid); }); });
      const r = host('raycast', { o: VA(origin), d: VA(dir), ignore });
      if(!r) return null;
      const part = r.id ? PARTS.get(r.id) || null : null;
      return Object.freeze({ Instance: part, Position: V(r.pos), Normal: V(r.normal), Distance: r.dist, Material: part ? part.Material : Enum.Material.Plastic });
    }
    GetPartBoundsInRadius(pos, radius){ const out = []; PARTS.forEach(p => { if(p._t._live && p.Position.sub(pos).Magnitude <= radius) out.push(p); }); return out; }
  }
  class RaycastParams { constructor(){ this.FilterDescendantsInstances = []; this.FilterType = 'Exclude'; this.IgnoreWater = true; } static new(){ return new RaycastParams(); } }
  class Players extends Service {
    constructor(){ super('Players'); this.PlayerAdded = new RBXScriptSignal('PlayerAdded'); this.PlayerRemoving = new RBXScriptSignal('PlayerRemoving'); }
    get LocalPlayer(){ return LOCAL_PLAYER; }
    get MaxPlayers(){ return 30; }
    GetPlayers(){ return this._t._children.filter(c => c instanceof Player); }
    GetPlayerFromCharacter(ch){ if(!ch) return null; return this.GetPlayers().find(p => p._t._char === ch) || null; }
    GetPlayerByUserId(id){ return this.GetPlayers().find(p => p.UserId === id) || null; }
  }
  class Lighting extends Service {
    constructor(){ super('Lighting'); this._clock = 14; }
    get ClockTime(){ return this._t._clock; }
    set ClockTime(v){ const c = ((num(v, 'ClockTime') % 24) + 24) % 24; this._t._clock = c; host('lighting', { clock: c }); this._t._changed('ClockTime'); }
    get TimeOfDay(){ const c = this._t._clock, h = Math.floor(c), m = Math.floor((c - h) * 60); return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':00'; }
    set TimeOfDay(s){ const m = /^(\d+)(?::(\d+))?/.exec(String(s)); if(m) this.ClockTime = (+m[1]) + (+(m[2]||0))/60; }
    GetMinutesAfterMidnight(){ return this._t._clock * 60; }
    SetMinutesAfterMidnight(n){ this.ClockTime = num(n, 'minutes') / 60; }
    get Brightness(){ return 2; } set Brightness(v){ }
    get Ambient(){ return new Color3(0.5,0.5,0.5); } set Ambient(v){ }
    get FogEnd(){ return 100000; } set FogEnd(v){ }
  }
  class RunService extends Service {
    constructor(){ super('RunService'); this.Heartbeat = new RBXScriptSignal('Heartbeat'); this.RenderStepped = new RBXScriptSignal('RenderStepped'); this.Stepped = new RBXScriptSignal('Stepped'); this.PreSimulation = this.Heartbeat; this.PostSimulation = this.Heartbeat; }
    IsStudio(){ return STUDIO; } IsClient(){ return true; } IsServer(){ return true; } IsRunning(){ return true; } IsRunMode(){ return STUDIO; }
  }
  class TweenService extends Service {
    constructor(){ super('TweenService'); }
    Create(inst, info, goals){
      if(!isInst(inst)) throw new TypeError('TweenService.Create: first argument must be an Instance');
      if(!(info instanceof TweenInfo)) throw new TypeError('TweenService.Create: second argument must be a TweenInfo — try new TweenInfo(1)');
      if(!goals || typeof goals !== 'object') throw new TypeError('TweenService.Create: third argument must be a table of goals, like { Position: new Vector3(0, 10, 0) }');
      Object.keys(goals).forEach(k => { if(k[0] === '_' || !(k in inst._t)) throw new Error(k + ' is not a valid member of ' + inst.ClassName); });
      return wrap(new Tween(inst, info, Object.assign({}, goals)));
    }
    GetValue(alpha, style, dir){ return ease(style instanceof EnumItem ? style.Name : String(style), dir instanceof EnumItem ? dir.Name : String(dir), Math.min(1, Math.max(0, +alpha || 0))); }
  }
  class Debris extends Service {
    constructor(){ super('Debris'); }
    AddItem(inst, life){ if(!isInst(inst)) throw new TypeError('Debris.AddItem expects an Instance'); addTimer(life === undefined ? 10 : life, () => { try{ inst.Destroy(); }catch(e){} }); }
  }
  class SoundService extends Service {
    constructor(){ super('SoundService'); }
    PlayLocalSound(s){ if(s instanceof Sound) s.Play(); else host('sound', { name: String(s), vol: 0.5 }); }
  }
  const KEY_STATE = {};
  class UserInputService extends Service {
    constructor(){ super('UserInputService'); this.InputBegan = new RBXScriptSignal('InputBegan'); this.InputEnded = new RBXScriptSignal('InputEnded'); this.InputChanged = new RBXScriptSignal('InputChanged'); this.JumpRequest = new RBXScriptSignal('JumpRequest'); this.TouchTap = new RBXScriptSignal('TouchTap'); }
    get TouchEnabled(){ return !!HOSTINFO.touch; } get KeyboardEnabled(){ return !HOSTINFO.touch; } get MouseEnabled(){ return !HOSTINFO.touch; } get GamepadEnabled(){ return false; }
    IsKeyDown(k){ const n = k instanceof EnumItem ? k.Name : String(k); return !!KEY_STATE[n]; }
    GetFocusedTextBox(){ return null; }
  }
  class StarterGui extends Service {
    constructor(){ super('StarterGui'); }
    // SetCore("SendNotification", { Title, Text, Duration }) / SetCore("ChatMakeSystemMessage", { Text })
    SetCore(name, data){
      data = data || {};
      if(name === 'SendNotification') host('notify', { title: fmt(data.Title === undefined ? '' : data.Title).slice(0, 80), text: fmt(data.Text === undefined ? '' : data.Text).slice(0, 200), dur: +data.Duration || 0 });
      else if(name === 'ChatMakeSystemMessage') host('chat', { text: fmt(data.Text === undefined ? '' : data.Text).slice(0, 200) });
    }
    GetCore(){ return null; }
    SetCoreGuiEnabled(){ }
    GetCoreGuiEnabled(){ return true; }
  }
  const SIMPLE_SERVICES = ['ReplicatedStorage','ServerScriptService','ServerStorage','StarterPlayer','StarterPack','Teams','Chat','HttpService','CollectionService','PathfindingService','PhysicsService','ContextActionService','TextChatService','BadgeService','Selection','GuiService','ContentProvider','LocalizationService','InsertService','TeleportService','ReplicatedFirst','SoundGroup'];

  // ------------------------------------------------------------------ DataStoreService: game saves
  // Each player's progress — coins, levels, items — saved to their Neoblox account (or to this
  // device when they play logged out) and loaded again the next time they play this game:
  //   const store = game.GetService("DataStoreService").GetDataStore("PlayerData");
  //   const coins = (await store.GetAsync("Player_" + player.UserId)) || 0;
  //   await store.SetAsync("Player_" + player.UserId, coins + 1);
  // Scripts run on each player's own device, and that device saves that player's data. So a key
  // with the local player's UserId in it is theirs (on every device they log in on), and a key
  // with SOMEONE ELSE's UserId is skipped here — their own device saves it.
  const CLOSE_FNS = [];
  let LEFT = false, DS_NOTED = false;
  function dsName(v, what){
    if(typeof v === 'number' && Number.isFinite(v)) v = String(v);
    if(typeof v !== 'string' || !v) throw new TypeError(what + ' must be text, like "PlayerData"');
    if(v.length > 50) throw new Error(what + ' can be up to 50 characters');
    return v;
  }
  function dsKey(k){
    k = dsName(k, 'DataStore keys');
    const me = LOCAL_PLAYER ? String(LOCAL_PLAYER.UserId) : '';
    if(me.length >= 3 && k.indexOf(me) >= 0) return k.split(me).join('{me}');
    for(const p of REMOTES.values()){
      const id = String(p.UserId);
      if(id.length >= 3 && k.indexOf(id) >= 0){
        if(!DS_NOTED){ DS_NOTED = true; host('log', { kind:'warn', text:'DataStore: another player\'s key ("' + k + '") was skipped — each player\'s own device saves their data' }); }
        return null;
      }
    }
    return k;
  }
  // what can be saved: numbers, text, true/false, lists and tables of those (like Roblox)
  function dsValue(v, depth){
    if(v === null) return null;
    const t = typeof v;
    if(t === 'string' || t === 'boolean') return v;
    if(t === 'number'){ if(!Number.isFinite(v)) throw new Error('DataStore can\'t save NaN or Infinity'); return v; }
    if(depth > 16) throw new Error('DataStore value is nested too deeply (or a table contains itself)');
    if(Array.isArray(v)) return v.map(x => x === undefined ? null : dsValue(x, depth + 1));
    if(t === 'object' && !isInst(v)){
      const proto = Object.getPrototypeOf(v);
      if(proto === Object.prototype || proto === null){
        const o = {};
        Object.keys(v).forEach(k => { if(v[k] !== undefined) o[k] = dsValue(v[k], depth + 1); });
        return o;
      }
    }
    const what = isInst(v) ? 'an Instance (' + v.ClassName + ')' : v instanceof Vector3 ? 'a Vector3 — save { X: v.X, Y: v.Y, Z: v.Z } instead' : v instanceof Color3 ? 'a Color3 — save color.ToHex() instead' : t === 'function' ? 'a function' : 'that kind of value';
    throw new Error('DataStore can only save numbers, text, true/false, lists and tables — not ' + what);
  }
  const dsGot = (r) => r && Object.prototype.hasOwnProperty.call(r, 'v') ? r.v : undefined;
  class DataStore {
    constructor(name, scope){
      this.Name = name; this.Scope = scope;
      Object.defineProperty(this, '_id', { value: scope === 'global' ? name : name + '/' + scope });
      Object.freeze(this);
    }
    // the saved value, or undefined if nothing is saved under this key yet
    async GetAsync(key){ const k = dsKey(key); if(k === null) return undefined; return dsGot(host('ds.get', { s: this._id, k })); }
    async SetAsync(key, value){
      if(value === undefined) throw new Error('SetAsync needs a value to save — use RemoveAsync to delete a key');
      const v = dsValue(value, 0), k = dsKey(key);
      if(k !== null) host('ds.set', { s: this._id, k, v });
    }
    // store.UpdateAsync(key, (old) => new): change a value based on what's saved; return undefined to cancel
    async UpdateAsync(key, fn){
      if(typeof fn !== 'function') throw new TypeError('UpdateAsync needs a function, like store.UpdateAsync(key, (old) => (old || 0) + 1)');
      const k = dsKey(key); if(k === null) return undefined;
      const nv = fn(dsGot(host('ds.get', { s: this._id, k })));
      if(nv && typeof nv.then === 'function') throw new Error('The UpdateAsync function can\'t wait — return the new value right away');
      if(nv === undefined) return undefined;
      const v = dsValue(nv, 0);
      host('ds.set', { s: this._id, k, v });
      return v;
    }
    // add to a saved number (starts at 0) and return the new total
    async IncrementAsync(key, delta){
      const d = delta === undefined ? 1 : Math.round(num(delta, 'IncrementAsync amount'));
      const k = dsKey(key); if(k === null) return undefined;
      const old = dsGot(host('ds.get', { s: this._id, k }));
      if(old !== undefined && old !== null && typeof old !== 'number') throw new Error('IncrementAsync can only add to a number — "' + key + '" holds ' + (Array.isArray(old) ? 'a list' : typeof old === 'object' ? 'a table' : typeof old));
      const v = (old || 0) + d;
      host('ds.set', { s: this._id, k, v });
      return v;
    }
    // delete a key; returns what was saved there
    async RemoveAsync(key){ const k = dsKey(key); if(k === null) return undefined; return dsGot(host('ds.remove', { s: this._id, k })); }
    toString(){ return this.Name; }
  }
  ['GetAsync','SetAsync','UpdateAsync','IncrementAsync','RemoveAsync'].forEach(m => { DataStore.prototype[m[0].toLowerCase() + m.slice(1)] = DataStore.prototype[m]; });
  class DataStoreService extends Service {
    constructor(){ super('DataStoreService'); this._stores = new Map(); }
    GetDataStore(name, scope){
      name = dsName(name, 'The DataStore name');
      scope = scope === undefined || scope === null ? 'global' : dsName(scope, 'The DataStore scope');
      const id = name + '\u0000' + scope, all = this._t._stores;
      let s = all.get(id);
      if(!s){ if(all.size >= 50) throw new Error('A game can use up to 50 DataStores'); s = new DataStore(name, scope); all.set(id, s); }
      return s;
    }
    GetGlobalDataStore(){ return this.GetDataStore('GlobalDataStore'); }
    GetOrderedDataStore(){ throw new Error('OrderedDataStore (global leaderboards) isn\'t in Neoblox yet — use GetDataStore to save each player\'s progress'); }
    GetRequestBudgetForRequestType(){ return 100; }
  }
  DataStoreService.prototype.getDataStore = DataStoreService.prototype.GetDataStore;

  // ------------------------------------------------------------------ MarketplaceService: paid items
  // Game passes (bought once, kept forever) and developer products (bought again and again),
  // paid for with tokens. The creator makes them in NeoStudio (🛒 Paid Items) and gets their ids.
  //   if (await MarketplaceService.UserOwnsGamePassAsync(player.UserId, 12)) { … }
  //   MarketplaceService.PromptGamePassPurchase(player, 12)    // opens Neoblox's own buy window
  //   MarketplaceService.ProcessReceipt = (receipt) => { …give it…; return Enum.ProductPurchaseDecision.PurchaseGranted; }
  // Scripts never take tokens themselves: the buy window is Neoblox's, outside the game, and only
  // the player can press Buy. Like everything else, each device handles its own player.
  const RECEIPTS = [];
  function marketId(v, what){
    const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
    if(typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new TypeError(what + ' ids are numbers — copy them from 🛒 Paid Items in NeoStudio');
    if(n === 0) throw new Error('Put your ' + what.toLowerCase() + ' id in here — copy it from 🛒 Paid Items in NeoStudio');
    return String(n);
  }
  const isLocal = (player) => !!LOCAL_PLAYER && (player === LOCAL_PLAYER || (typeof player === 'number' && player === LOCAL_PLAYER.UserId));
  function deliverReceipts(){
    const mps = SERVICES.MarketplaceService._t, fn = mps._receipt;
    if(typeof fn !== 'function' || !RECEIPTS.length) return;
    RECEIPTS.splice(0).forEach(r => {
      const info = Object.freeze({ PlayerId: LOCAL_PLAYER ? LOCAL_PLAYER.UserId : 0, ProductId: Number(r.item), PurchaseId: String(r.id), CurrencySpent: r.price || 0, CurrencyType: Enum.CurrencyType.Tokens, PlaceIdWherePurchased: 0 });
      // PurchaseGranted: it's been handed out. Anything else: it's delivered again next time they join.
      const done = (res) => { if(res === Enum.ProductPurchaseDecision.PurchaseGranted) host('mk.granted', { rid: r.id }); };
      try{ const res = fn(info); if(res && typeof res.then === 'function') res.then(done, reportError); else done(res); }
      catch(e){ reportError(e); }
    });
  }
  class MarketplaceService extends Service {
    constructor(){
      super('MarketplaceService'); this._receipt = null;
      this.PromptGamePassPurchaseFinished = new RBXScriptSignal('PromptGamePassPurchaseFinished');
      this.PromptProductPurchaseFinished = new RBXScriptSignal('PromptProductPurchaseFinished');
      this.PromptPurchaseFinished = new RBXScriptSignal('PromptPurchaseFinished');
    }
    // set it to a function: (receiptInfo) => Enum.ProductPurchaseDecision.PurchaseGranted
    get ProcessReceipt(){ return this._t._receipt; }
    set ProcessReceipt(fn){
      if(fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('ProcessReceipt must be a function');
      this._t._receipt = fn || null;
      deliverReceipts();
    }
    // other players are checked on their own devices, so here it's only ever true for the local player
    async UserOwnsGamePassAsync(userId, passId){
      const id = marketId(passId, 'Game pass');
      if(!LOCAL_PLAYER || Number(userId) !== LOCAL_PLAYER.UserId) return false;
      return !!(host('mk.owns', { id }) || {}).v;
    }
    PlayerOwnsAsset(){ return false; }
    PromptGamePassPurchase(player, passId){ const id = marketId(passId, 'Game pass'); if(isLocal(player)) host('mk.prompt', { id, kind:'pass' }); }
    PromptProductPurchase(player, productId){ const id = marketId(productId, 'Developer product'); if(isLocal(player)) host('mk.prompt', { id, kind:'product' }); }
    PromptPurchase(){ throw new Error('PromptPurchase (avatar items) isn\'t in Neoblox — sell game passes or developer products instead'); }
    // name, description, price… of one of this game's items
    async GetProductInfo(id, infoType){
      const kid = marketId(id, 'Item');
      const i = host('mk.info', { id: kid });
      if(!i) throw new Error('This game has no game pass or developer product with id ' + kid);
      const pass = i.kind === 'pass';
      if(infoType === Enum.InfoType.GamePass && !pass) throw new Error(kid + ' is a developer product, not a game pass');
      if(infoType === Enum.InfoType.Product && pass) throw new Error(kid + ' is a game pass, not a developer product');
      return Object.freeze({ Name: i.name, Description: i.desc || '', PriceInRobux: i.price, PriceInTokens: i.price, IconImageAssetId: i.image || '', IsForSale: !!i.onSale,
        ProductId: Number(kid), TargetId: Number(kid), ProductType: pass ? 'Game Pass' : 'Developer Product' });
    }
  }

  // ------------------------------------------------------------------ Instance.new
  const CREATORS = {
    Part: () => wrap(new BasePart('Part')),
    SpawnLocation: () => wrap(new BasePart('SpawnLocation')),
    WedgePart: () => { const p = wrap(new BasePart('WedgePart')); p._t._p.Shape = 'Wedge'; return p; },
    Model: () => wrap(new Model('Model')),
    Folder: () => wrap(new Instance('Folder')),
    Configuration: () => wrap(new Instance('Configuration')),
    ClickDetector: () => wrap(new ClickDetector()),
    PointLight: () => wrap(new PointLight()),
    Sound: () => wrap(new Sound()),
    BindableEvent: () => wrap(new BindableEvent()),
    BindableFunction: () => wrap(new BindableFunction()),
    RemoteEvent: () => wrap(new RemoteEvent()),
    RemoteFunction: () => wrap(new RemoteFunction()),
    TextLabel: () => wrap(new GuiObject('TextLabel')),
    TextButton: () => wrap(new GuiObject('TextButton')),
    ImageLabel: () => wrap(new GuiObject('ImageLabel')),
    Decal: () => wrap(new Decal()),
    ScreenGui: () => wrap(new ScreenGui()),
    Script: () => wrap(new BaseScript('Script')),
    LocalScript: () => wrap(new BaseScript('LocalScript')),
  };
  Object.keys(VALUE_TYPES).forEach(k => { CREATORS[k] = () => wrap(new ValueBase(k, VALUE_TYPES[k][0], VALUE_TYPES[k][1])); });
  let created = 0;
  function newInstance(className, parent){
    const mk = CREATORS[String(className)];
    if(!mk) throw new Error('Unable to create an Instance of type "' + className + '"' + (/^[a-z]/.test(String(className)) ? ' — class names start with a capital letter, like "Part"' : ''));
    if(++created > 20000) throw new Error('Too many objects created — Neoblox scripts can make up to 20000');
    const i = mk();
    if(parent !== undefined && parent !== null) i.Parent = parent;
    return i;
  }

  // ------------------------------------------------------------------ game tree
  const game = wrap(new DataModel());
  const SERVICES = {};
  function addService(inst){ inst._t._parent = game; game._t._children.push(inst); SERVICES[inst._t._class] = inst; return inst; }
  WORKSPACE = addService(wrap(new Workspace()));
  PLAYERS = addService(wrap(new Players()));
  addService(wrap(new Lighting()));
  addService(wrap(new RunService()));
  addService(wrap(new TweenService()));
  addService(wrap(new Debris()));
  addService(wrap(new SoundService()));
  addService(wrap(new UserInputService()));
  STARTERGUI = addService(wrap(new StarterGui()));
  addService(wrap(new DataStoreService()));
  addService(wrap(new MarketplaceService()));
  SIMPLE_SERVICES.forEach(n => addService(wrap(new Service(n))));
  WORKSPACE._t._live = true;
  // game.Workspace, game.Players… are reached by name through the Proxy like any child.

  const HOSTINFO = {};
  function onTreeTouched(inst){
    // leaderstats: whenever something under LocalPlayer.leaderstats changes, show it on the board
    if(!LOCAL_PLAYER || !inst) return;
    if(inst === LOCAL_PLAYER || inst.IsDescendantOf(LOCAL_PLAYER)) scheduleStats();
  }
  let statsQueued = false;
  function scheduleStats(){
    if(statsQueued) return; statsQueued = true;
    Promise.resolve().then(() => {
      statsQueued = false;
      const ls = LOCAL_PLAYER && LOCAL_PLAYER._t._childNamed('leaderstats');
      const out = {};
      if(ls) ls._t._children.slice(0, 6).forEach(v => {
        if(!(v instanceof ValueBase)) return;
        const val = v._t._value;
        out[v._t._name.slice(0, 20)] = typeof val === 'number' ? val : typeof val === 'boolean' ? (val ? 'Yes' : 'No') : fmt(val).slice(0, 30);
      });
      host('stats', out);
    });
  }

  // ------------------------------------------------------------------ globals
  // Instance.new("Part") like Roblox — `new Instance("Part")` works too, and `x instanceof Instance`.
  function InstanceCtor(className, parent){ return newInstance(className, parent); }
  InstanceCtor.prototype = Instance.prototype;
  InstanceCtor.new = newInstance;
  Object.freeze(InstanceCtor);
  Object.assign(G, {
    game, Game: game, workspace: WORKSPACE, Workspace: WORKSPACE,
    Instance: InstanceCtor, Vector3, Vector2, Color3, BrickColor, CFrame, UDim, UDim2, TweenInfo, RaycastParams, Enum,
  });

  // ------------------------------------------------------------------ host entry points
  function makePlayer(info, local){
    const p = wrap(new Player(info, local));
    return p;
  }
  const REMOTES = new Map();
  const NB = {
    // world: { parts:[{id,name,pos,size,rot,color,material,t,cc,shape,gameplay}], ui:[{id,kind,text,x,y}], player:{name,userId}, studio, touch }
    init(json){
      const w = JSON.parse(json);
      STUDIO = !!w.studio; HOSTINFO.touch = !!w.touch;
      (w.parts || []).forEach(p => {
        const part = wrap(new BasePart('Part', p));
        part._t._name = p.name || 'Part';
        part._t._parent = WORKSPACE; WORKSPACE._t._children.push(part);
        part._t._live = true;
        PARTS.set(p.id, part);
        if(p.decal){
          const d = wrap(new Decal({ image: p.decal.image, face: p.decal.face, key: 'w' }));
          d._t._parent = part; part._t._children.push(d);
          d._t._live = true; d._t._host = p.id;
        }
      });
      (w.ui || []).forEach(u => {
        const cls = u.kind === 'button' ? 'TextButton' : u.kind === 'image' ? 'ImageLabel' : 'TextLabel';
        const g = wrap(new GuiObject(cls, u));
        g._t._name = cls;
        g._t._parent = STARTERGUI; STARTERGUI._t._children.push(g);
        g._t._live = true;
        GUIS.set(u.id, g);
      });
      LOCAL_PLAYER = makePlayer(w.player || { name:'Player' }, true);
    },
    // Creates the Script object for a script and returns its "script" global.
    addScript(json){
      const s = JSON.parse(json);
      let parent = SERVICES.ServerScriptService;
      if(s.part) parent = PARTS.get(s.part) || parent;
      if(s.gui) parent = GUIS.get(s.gui) || parent;
      const sc = wrap(new BaseScript('Script'));
      sc._t._name = s.name || 'Script';
      sc._t._parent = parent; parent._t._children.push(sc);
      SCRIPT_FILES[s.file] = sc.GetFullName();
      return sc;
    },
    run(fn, sc){ spawnFn(fn, [sc]); },
    // after every script has started: the player joins, then their character spawns
    join(){
      LOCAL_PLAYER.Parent = PLAYERS;
      PLAYERS._t.PlayerAdded._fire(LOCAL_PLAYER);
      spawnCharacter(LOCAL_PLAYER);
    },
    step(now, dt){
      NOW = now;
      if(timers.length){
        const due = [];
        for(let i = timers.length - 1; i >= 0; i--){ const t = timers[i]; if(t.dead){ timers.splice(i, 1); continue; } if(t.at <= now){ timers.splice(i, 1); due.push(t); } }
        due.sort((a, b) => a.at - b.at || a.id - b.id).forEach(t => { try{ t.fn(); }catch(e){ reportError(e); } });
      }
      if(TWEENS.size) Array.from(TWEENS).forEach(t => t._step(dt));
      const rs = SERVICES.RunService._t;
      if(rs.Stepped._conns.length) rs.Stepped._fire(now, dt);
      if(rs.Heartbeat._conns.length) rs.Heartbeat._fire(dt);
      if(rs.RenderStepped._conns.length) rs.RenderStepped._fire(dt);
    },
    event(json){
      const e = JSON.parse(json);
      switch(e.t){
        case 'touch': case 'untouch': {
          const part = PARTS.get(e.id); const ch = LOCAL_PLAYER && LOCAL_PLAYER._t._char;
          if(!part || !ch || !part._t._live || !part._t._p.CanTouch) return;
          const limb = ch._t._childNamed(e.limb || 'Left Leg') || ch._t._childNamed('HumanoidRootPart');
          (e.t === 'touch' ? part._t.Touched : part._t.TouchEnded)._fire(limb);
          return;
        }
        case 'click': {
          const part = PARTS.get(e.id); if(!part) return;
          part._t._children.forEach(c => { if(c instanceof ClickDetector) c._t.MouseClick._fire(LOCAL_PLAYER); });
          return;
        }
        case 'gui': {
          const g = GUIS.get(e.id); if(!g || !g._t.MouseButton1Click) return;
          g._t.MouseButton1Down._fire(); g._t.MouseButton1Up._fire();
          g._t.MouseButton1Click._fire(); g._t.Activated._fire();
          return;
        }
        case 'input': {
          const key = e.key && Enum.KeyCode[e.key] ? Enum.KeyCode[e.key] : Enum.KeyCode.Unknown;
          if(e.key) KEY_STATE[e.key] = !!e.down;
          const io = Object.freeze({ KeyCode: key, UserInputType: Enum.UserInputType[e.kind] || Enum.UserInputType.Keyboard, UserInputState: e.down ? Enum.UserInputState.Begin : Enum.UserInputState.End, Position: new Vector3(e.x||0, e.y||0, 0), Delta: Vector3.zero });
          const uis = SERVICES.UserInputService._t;
          (e.down ? uis.InputBegan : uis.InputEnded)._fire(io, false);
          if(e.down && e.key === 'Space') uis.JumpRequest._fire();
          return;
        }
        case 'health': {
          const ch = LOCAL_PLAYER && LOCAL_PLAYER._t._char; const hum = ch && ch._t._childNamed('Humanoid');
          if(hum) hum._t.HealthChanged._fire(e.h);
          return;
        }
        case 'died': {
          const ch = LOCAL_PLAYER && LOCAL_PLAYER._t._char; const hum = ch && ch._t._childNamed('Humanoid');
          if(hum){ hum._t.Died._fire(); hum._t.StateChanged._fire(Enum.HumanoidStateType.Running, Enum.HumanoidStateType.Dead); }
          return;
        }
        case 'respawn': if(LOCAL_PLAYER && LOCAL_PLAYER._t._parent) spawnCharacter(LOCAL_PLAYER); return;
        case 'jump': {
          const ch = LOCAL_PLAYER && LOCAL_PLAYER._t._char; const hum = ch && ch._t._childNamed('Humanoid');
          if(hum) hum._t.Jumping._fire(true);
          return;
        }
        case 'chat': if(LOCAL_PLAYER) LOCAL_PLAYER._t.Chatted._fire(String(e.text || '')); return;
        // Neoblox's buy window closed (bought or not), and purchases to hand out
        case 'mkdone': {
          const mps = SERVICES.MarketplaceService._t;
          if(e.kind === 'pass') mps.PromptGamePassPurchaseFinished._fire(LOCAL_PLAYER, Number(e.id), !!e.bought);
          else mps.PromptProductPurchaseFinished._fire(LOCAL_PLAYER ? LOCAL_PLAYER.UserId : 0, Number(e.id), !!e.bought);
          return;
        }
        case 'receipt': if(e.r && e.r.id){ RECEIPTS.push(e.r); deliverReceipts(); } return;
        // the player is leaving (back to the menu, closing the tab, Stop in a playtest): last
        // chance to save — PlayerRemoving for them, then every game.BindToClose function
        case 'leave': {
          if(LEFT || !LOCAL_PLAYER) return;
          LEFT = true;
          if(LOCAL_PLAYER._t._parent) PLAYERS._t.PlayerRemoving._fire(LOCAL_PLAYER);
          CLOSE_FNS.forEach(fn => spawnFn(fn, []));
          return;
        }
        case 'padd': {
          if(REMOTES.has(e.id)) return;
          const p = makePlayer({ id: e.id, name: e.name, userId: e.userId || 0 }, false);
          REMOTES.set(e.id, p);
          p.Parent = PLAYERS;
          PLAYERS._t.PlayerAdded._fire(p);
          const ch = buildCharacter(p); ch.Parent = WORKSPACE; p._t._char = ch; p._t.CharacterAdded._fire(ch);
          return;
        }
        case 'prem': {
          const p = REMOTES.get(e.id); if(!p) return;
          REMOTES.delete(e.id);
          PLAYERS._t.PlayerRemoving._fire(p);
          if(p._t._char){ try{ p._t._char.Destroy(); }catch(err){} }
          p.Parent = null;
          return;
        }
      }
    },
  };
  G.__nb = NB;
})();
