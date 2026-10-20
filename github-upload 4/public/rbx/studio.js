// rbx/studio.js — NeoStudio's editor, laid out like a desktop game studio:
//   • File menu (New, Open your published builds, Publish, Exit) and HOME / MODEL / TEST / VIEW tabs
//   • Select / Move (drag the arrows) / Rotate / Build / Delete tools, Part ▾ shapes, Material ▾, Color ▾
//   • Explorer tree (Workspace, Lighting, ServerScriptService, StarterGui, …) and a Properties grid
//     (Name, Position, Color, Material, Transparency, Shape, Orientation, CanCollide, Gameplay, Stage)
//   • Scripts (JavaScript) in parts, ServerScriptService and buttons — opened in rbx/codeeditor.js
//   • Toolbox of ready-made models, an Output window, copy/paste/duplicate and keyboard shortcuts
//   • Free mouse cursor: click to use the tool, right-drag to look, wheel to zoom, WASD/QE to fly;
//     on touch screens tap to use the tool and drag to look.
// Loaded after the main game script; it overrides the editor's Explorer/Properties renderers.
'use strict';
(function(){
  const UI = window.NeoStudioUI = {};
  const $ = (q, r)=> (r||document).querySelector(q);
  const $$ = (q, r)=> Array.from((r||document).querySelectorAll(q));
  const esc = (t)=> String(t==null?'':t).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const editing = ()=> App.mode==='studio' && !App.studio.testing;

  const COLORS = ['#f2f3f3','#a3a2a5','#635f62','#1b2a35','#c4281c','#ff6b6b','#da8541','#f5cd30','#ffc93c','#a4bd47','#4b974b','#287f47',
                  '#12eed4','#00a2ff','#0d69ac','#2c4592','#6b327c','#b480ff','#ff66cc','#7c5c46','#d7c59a','#cc8e69','#9ff3e9','#ffffff'];
  const SHAPES = [{ id:'block', label:'Block', ic:'■' }, { id:'wedge', label:'Wedge', ic:'◢' }, { id:'sphere', label:'Sphere', ic:'●' }, { id:'cylinder', label:'Cylinder', ic:'▮' }];
  const GAMEPLAY = [{ id:'', label:'None' }, { id:'kill', label:'Kill Brick' }, { id:'checkpoint', label:'Checkpoint' }, { id:'bounce', label:'Jump Pad' }];

  // ------------------------------------------------------------------ Toolbox models
  const pad = (x0,x1,z0,z1,y,type,props)=>{ const a=[]; for(let x=x0;x<=x1;x++) for(let z=z0;z<=z1;z++) a.push([x,y,z,type,null,null,props||null]); return a; };
  const PREFABS = [
    { id:'steps', name:'Obby Steps', blocks:[[0,0,0,'plastic',null,null,{c:'#ff6b6b'}],[0,1,-2,'plastic',null,null,{c:'#ffc93c'}],[0,2,-4,'plastic',null,null,{c:'#4b974b'}],[0,3,-6,'plastic',null,null,{c:'#00a2ff'}],[0,4,-8,'plastic',null,null,{c:'#b480ff'}]] },
    { id:'killjump', name:'Kill Brick Jump', blocks:[].concat(pad(-1,1,0,0,0,'plastic'), pad(-1,1,-2,-1,0,'kill'), pad(-1,1,-3,-3,0,'plastic')) },
    { id:'checkpoint', name:'Checkpoint Pad', blocks: pad(-1,1,-1,1,0,'checkpoint') },
    { id:'launcher', name:'Jump Pad Launch', blocks:[[0,0,0,'bounce']].concat(pad(-1,1,-4,-2,4,'plastic',{c:'#00a2ff'})) },
    { id:'lava', name:'Lava Floor', blocks: pad(-2,2,-2,2,0,'kill') },
    { id:'bridge', name:'Wooden Bridge', blocks: pad(0,0,-6,0,0,'wood') },
    { id:'glass', name:'Glass Bridge', blocks: pad(0,0,-6,0,0,'glass') },
    { id:'house', name:'Little House', blocks:(function(){ const a = pad(-2,2,-2,2,0,'wood');
        for(let y=1;y<=3;y++) for(let i=-2;i<=2;i++){ a.push([i,y,-2,'brick']); a.push([-2,y,i,'brick']); a.push([2,y,i,'brick']); if(!(i===0 && y<3)) a.push([i,y,2,'brick']); }
        return a.concat(pad(-2,2,-2,2,4,'plastic',{c:'#c4281c'})).filter((b,i,arr)=> arr.findIndex(o=>o[0]===b[0]&&o[1]===b[1]&&o[2]===b[2])===i); })() },
    { id:'tree', name:'Blocky Tree', blocks:(function(){ const a = [[0,0,0,'wood'],[0,1,0,'wood'],[0,2,0,'wood']];
        for(let x=-1;x<=1;x++) for(let z=-1;z<=1;z++) for(let y=3;y<=4;y++) if(!(y===4 && Math.abs(x)+Math.abs(z)===2)) a.push([x,y,z,'grass']);
        a.push([0,5,0,'grass']); return a; })() },
    { id:'tower', name:'Watch Tower', blocks:(function(){ const a = [];
        [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([x,z])=>{ for(let y=0;y<5;y++) a.push([x,y,z,'stone']); });
        return a.concat(pad(-1,1,-1,1,5,'wood')); })() },
    { id:'spawnplat', name:'Spawn Platform', blocks: pad(-2,2,-2,2,0,'plastic',{c:'#a3a2a5'}) },
    { id:'neonring', name:'Neon Ring', blocks:(function(){ const a=[]; for(let x=-2;x<=2;x++) for(let z=-2;z<=2;z++) if(Math.abs(x)===2||Math.abs(z)===2) a.push([x,0,z,'neon',null,null,{c:'#b480ff'}]); return a; })() },
    // scripted models: each part carries a JavaScript Script (see rbx/codeeditor.js Examples)
    { id:'coin', name:'Spinning Coin 📜', blocks:[[0,1,0,'neon','js',scriptExample('Coin + leaderboard'),{c:'#ffcd28',s:'cylinder'}]] },
    { id:'mover', name:'Moving Platform 📜', blocks:[[0,2,0,'plastic','js',scriptExample('Moving platform'),{c:'#00a2ff'}]] },
    { id:'fadebridge', name:'Fading Bridge 📜', blocks:[0,-1,-2,-3,-4].map((z, i)=> [0,0,z,'glass','js',scriptExample('Disappearing part'),{c:'#9ff3e9'}]) },
    { id:'speedpad', name:'Speed Pad 📜', blocks:[[0,0,0,'neon','js',scriptExample('Speed pad'),{c:'#12eed4'}]] },
    { id:'spinner', name:'Spinning Bar 📜', blocks:[[0,1,0,'neon','js',
      '// A spinning kill bar — jump over it!\nconst bar = script.Parent;\nbar.Size = new Vector3(9, 0.4, 0.4);\nbar.Gameplay = "KillBrick";\n\ngame.GetService("RunService").Heartbeat.Connect((dt) => {\n  bar.Orientation = bar.Orientation.add(new Vector3(0, 70 * dt, 0));\n});\n',
      {c:'#ff2b2b'}]] },
    { id:'lamp', name:'Lamp 📜', blocks:[[0,0,0,'wood'],[0,1,0,'wood'],[0,2,0,'neon','js',scriptExample('Lamp (light at night)'),{c:'#ffdc8c'}]] },
  ];
  function scriptExample(name){ return (window.NeoCodeEditor && NeoCodeEditor.example) ? NeoCodeEditor.example(name) : ''; }

  // ------------------------------------------------------------------ Output
  const outLines = [];
  // meta (optional): { where, ref, line } — a script error; clicking the line opens that script there
  UI.log = function(text, kind, meta){
    const t = new Date(); const ts = t.toTimeString().slice(0,8);
    outLines.push({ ts, text:String(text), kind:kind||'' });
    if(outLines.length > 200) outLines.shift();
    const body = $('#studioOutputBody'); if(!body) return;
    const row = document.createElement('div');
    row.className = 'so-line' + (kind ? ' '+kind : '') + (meta && meta.ref ? ' jump' : '');
    row.innerHTML = '<span class="t">'+ts+'</span>' + esc(text);
    if(meta && meta.ref){ row.title = 'Open the script at line ' + meta.line; row.addEventListener('click', ()=>{ if(window.NeoCodeEditor) NeoCodeEditor.openRef(meta.where, meta.ref, meta.line); }); }
    body.appendChild(row);
    while(body.children.length > 200) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  };

  // ------------------------------------------------------------------ helpers
  function selectedBlock(){ const s = App.studio.selected; if(!s || s.kind!=='block') return null; const d = App.studio.blocks.get(blockKey(s.x,s.y,s.z)); return d ? { sel:s, data:d } : null; }
  function inBounds(x,y,z){ return Math.abs(x)<=WORLD_BOUND && Math.abs(z)<=WORLD_BOUND && y>=0 && y<=WORLD_MAXY; }
  function free(x,y,z){ return inBounds(x,y,z) && !App.studio.blocks.has(blockKey(x,y,z)); }
  function rebuildKeepCam(){
    const pos = App.studioPos ? App.studioPos.clone() : null, yaw = App.yaw, pitch = App.pitch, sel = App.studio.selected;
    buildStudioScene();
    App.studioPos = pos; App.yaw = yaw; App.pitch = pitch;
    if(sel && sel.kind==='block' && App.studio.blocks.has(blockKey(sel.x,sel.y,sel.z))){ App.studio.selected = sel; refreshStudioSelectionOutline(); renderStudioExplorer(); renderStudioProperties(); }
  }
  function partName(d){ return (d.props && d.props.nm) || (BLOCK_TYPE_BY_ID[d.type] ? BLOCK_TYPE_BY_ID[d.type].label : 'Part'); }
  function partColor(d){ const c = d.props && d.props.c; return c || numToHex((BLOCK_TYPE_BY_ID[d.type]||BLOCK_TYPE_BY_ID.plastic).color); }
  function updateTitle(){ const t = $('#sdTitle'); if(t) t.textContent = (App.studio.lastName || 'Untitled Place') + (App.studio.worldId ? '' : ' — not published yet'); }

  // ------------------------------------------------------------------ Explorer
  const open = new Set(['workspace','startergui','sss']);
  const scriptSel = (sel, kind, ref)=> sel && sel.kind==='script' && sel.where===kind && sel.ref===ref;
  window.renderStudioExplorer = function(){
    const el = $('#studioExplorerBody'); if(!el) return;
    const sel = App.studio.selected;
    const groups = new Map();
    App.studio.blocks.forEach((v,k)=>{ if(!groups.has(v.type)) groups.set(v.type, []); const [x,y,z] = k.split(',').map(Number); groups.get(v.type).push({ x,y,z, d:v }); });
    const row = (depth, attrs, car, icon, label, extra, isSel)=> `<div class="sx-row${isSel?' sel':''}" ${attrs} style="padding-left:${4+depth*14}px"><span class="car">${car||''}</span>${icon}<span>${label}</span>${extra||''}</div>`;
    const caret = (k)=> open.has(k) ? '▾' : '▸';
    let h = row(0, 'data-tog="workspace"', caret('workspace'), '<span class="ic">🌐</span>', 'Workspace', '<span class="dim">('+App.studio.blocks.size+')</span>');
    if(open.has('workspace')){
      h += row(1, 'data-obj="camera"', '', '<span class="ic">📷</span>', 'Camera');
      if(App.studio.baseplate !== false) h += row(1, 'data-obj="baseplate"', '', '<span class="ic part" style="background:#6b6e72"></span>', 'Baseplate', '', sel && sel.kind==='baseplate');
      h += row(1, 'data-obj="spawn"', '', '<span class="ic">★</span>', 'SpawnLocation', '', sel && sel.kind==='spawn');
      if(App.studio.goal) h += row(1, 'data-obj="goal"', '', '<span class="ic">🏆</span>', 'WinPad', '', sel && sel.kind==='goal');
      BLOCK_TYPES.forEach(bt=>{
        const list = groups.get(bt.id); if(!list) return;
        const key = 'g:'+bt.id;
        h += row(1, 'data-tog="'+key+'"', caret(key), '<span class="ic part" style="background:'+numToHex(bt.color)+'"></span>', esc(bt.label)+' parts', '<span class="dim">('+list.length+')</span>');
        if(open.has(key)){
          list.slice(0, 80).forEach(it=>{
            const isSel = sel && sel.kind==='block' && sel.x===it.x && sel.y===it.y && sel.z===it.z;
            const hasScr = !!it.d.script;
            h += row(2, `data-x="${it.x}" data-y="${it.y}" data-z="${it.z}"`, '', '<span class="ic part" style="background:'+esc(partColor(it.d))+'"></span>', esc(partName(it.d)),
              '<span class="dim">'+it.x+', '+it.y+', '+it.z+'</span>' + (hasScr ? '' : '<span class="sx-add" data-addscr-part="'+it.x+','+it.y+','+it.z+'" title="Insert a Script into this part">+</span>'), isSel);
            if(hasScr) h += row(3, `data-scr-part="${it.x},${it.y},${it.z}"`, '', '<span class="ic">📜</span>', 'Script', '', scriptSel(sel, 'part', it.d));
          });
          if(list.length > 80) h += row(2, '', '', '', '<span class="dim">…and '+(list.length-80)+' more</span>');
        }
      });
    }
    h += row(0, 'data-obj="lighting"', '', '<span class="ic">💡</span>', 'Lighting', '<span class="dim">'+esc((App.studio.lighting&&App.studio.lighting.sky)||'day')+'</span>', sel && sel.kind==='lighting');
    h += row(0, '', '', '<span class="ic">👥</span>', 'Players');
    h += row(0, '', '', '<span class="ic">📦</span>', 'ReplicatedStorage');
    const wscripts = App.studio.scripts || [];
    h += row(0, 'data-tog="sss"', wscripts.length ? caret('sss') : '', '<span class="ic">📜</span>', 'ServerScriptService', '<span class="dim">('+wscripts.length+')</span><span class="sx-add" data-addscr-world="1" title="Insert a Script">+</span>');
    if(open.has('sss')) wscripts.forEach((sc, i)=>{
      h += row(1, 'data-scr-world="'+i+'"', '', '<span class="ic">📜</span>', esc(sc.name || 'Script'), '', scriptSel(sel, 'world', sc));
    });
    h += row(0, 'data-tog="startergui"', caret('startergui'), '<span class="ic">🖥</span>', 'StarterGui', '<span class="dim">('+(App.studio.ui||[]).length+')</span>');
    if(open.has('startergui')) (App.studio.ui||[]).forEach(u=>{
      const isSel = sel && sel.kind==='ui' && sel.id===u.id;
      const btn = u.kind==='button';
      h += row(1, 'data-uiid="'+esc(u.id)+'"', '', '<span class="ic">'+(btn?'🔘':'🏷')+'</span>', esc((btn?'TextButton':'TextLabel')+' "'+String(u.text||'').slice(0,14)+'"'), btn && !u.script ? '<span class="sx-add" data-addscr-gui="'+esc(u.id)+'" title="Insert a Script into this button">+</span>' : '', isSel);
      if(btn && u.script) h += row(2, 'data-scr-gui="'+esc(u.id)+'"', '', '<span class="ic">📜</span>', 'Script', '', scriptSel(sel, 'gui', u));
    });
    h += row(0, '', '', '<span class="ic">🎮</span>', 'StarterPlayer');
    h += row(0, '', '', '<span class="ic">🔊</span>', 'SoundService');
    el.innerHTML = h;
    $$('[data-tog]', el).forEach(r=> r.addEventListener('click', ()=>{ const k = r.dataset.tog; if(open.has(k)) open.delete(k); else open.add(k); renderStudioExplorer(); }));
    $$('[data-x]', el).forEach(r=> r.addEventListener('click', ()=> selectStudioBlock(+r.dataset.x, +r.dataset.y, +r.dataset.z)));
    $$('[data-uiid]', el).forEach(r=> r.addEventListener('click', ()=> selectStudioUi(r.dataset.uiid)));
    // scripts: click selects it (Properties) and opens it in the code editor
    const pk = (s)=> App.studio.blocks.get(blockKey.apply(null, s.split(',').map(Number)));
    $$('[data-scr-part]', el).forEach(r=> r.addEventListener('click', ()=> openScript('part', pk(r.dataset.scrPart))));
    $$('[data-scr-world]', el).forEach(r=> r.addEventListener('click', ()=> openScript('world', (App.studio.scripts||[])[+r.dataset.scrWorld])));
    $$('[data-scr-gui]', el).forEach(r=> r.addEventListener('click', ()=> openScript('gui', findStudioUi(r.dataset.scrGui))));
    $$('[data-addscr-part]', el).forEach(b=> b.addEventListener('click', (e)=>{ e.stopPropagation(); insertScript('part', pk(b.dataset.addscrPart)); }));
    $$('[data-addscr-world]', el).forEach(b=> b.addEventListener('click', (e)=>{ e.stopPropagation(); insertScript('world'); }));
    $$('[data-addscr-gui]', el).forEach(b=> b.addEventListener('click', (e)=>{ e.stopPropagation(); insertScript('gui', findStudioUi(b.dataset.addscrGui)); }));
    $$('[data-obj]', el).forEach(r=> r.addEventListener('click', ()=>{
      const o = r.dataset.obj;
      if(o==='camera'){ UI.log('Tip: right-drag to look around, WASD to fly, Q/E down/up, mouse wheel to zoom.'); return; }
      App.studio.selected = { kind:o };
      refreshStudioSelectionOutline(); renderStudioExplorer(); renderStudioProperties();
    }));
    updateTitle();
  };

  // ------------------------------------------------------------------ Properties
  const closedCats = new Set();
  function cat(name, rows){
    const shut = closedCats.has(name);
    return `<div class="sp-cat" data-cat="${esc(name)}"><span class="car">${shut?'▸':'▾'}</span>${esc(name)}</div>` + (shut ? '' : rows.join(''));
  }
  const prow = (label, html)=> `<div class="sp-row"><label title="${esc(label)}">${esc(label)}</label><div>${html}</div></div>`;
  window.renderStudioProperties = function(){
    const el = $('#studioPropertiesBody'); if(!el) return;
    const sel = App.studio.selected;
    if(!sel){ el.innerHTML = '<div class="sp-empty">Select a part in the world or in the Explorer to see its properties.<br><br>Tip: pick the <b>Select</b> tool (C) and click a part.</div>'; return; }
    if(sel.kind==='ui') return renderUiProps(el, sel);
    if(sel.kind==='script') return renderScriptProps(el, sel);
    if(sel.kind==='lighting'){
      const sky = (App.studio.lighting && App.studio.lighting.sky) || 'day';
      el.innerHTML = cat('Appearance', [prow('Sky', `<select id="spSky">${['day','sunset','night'].map(k=>`<option value="${k}"${k===sky?' selected':''}>${k[0].toUpperCase()+k.slice(1)}</option>`).join('')}</select>`)]);
      $('#spSky', el).addEventListener('change', (e)=> setSky(e.target.value));
      wireCats(el); return;
    }
    if(sel.kind==='baseplate'){
      el.innerHTML = cat('Data', [prow('Name','<span class="ro">Baseplate</span>')]) + cat('Behavior', [prow('Enabled', `<input type="checkbox" id="spPlate" ${App.studio.baseplate!==false?'checked':''}>`)]) +
        '<div class="sp-empty">The baseplate is the big grey floor. Turn it off to build an obby over the open sky.</div>';
      $('#spPlate', el).addEventListener('change', (e)=>{ App.studio.baseplate = e.target.checked; rebuildKeepCam(); UI.log('Baseplate '+(e.target.checked?'on':'off')); });
      wireCats(el); return;
    }
    if(sel.kind==='spawn' || sel.kind==='goal'){
      const p = sel.kind==='spawn' ? App.studio.spawn : App.studio.goal;
      if(!p){ App.studio.selected = null; renderStudioProperties(); return; }
      el.innerHTML = cat('Data', [prow('Name', '<span class="ro">'+(sel.kind==='spawn'?'SpawnLocation':'WinPad')+'</span>'), prow('Position', '<span class="ro">'+p.x+', '+p.y+', '+p.z+'</span>')]) +
        '<div class="sp-empty">'+(sel.kind==='spawn' ? 'Players start here. Use the <b>Spawn</b> tool (V) and click a part to move it.' : 'Touching this pad wins the game. Use the <b>Goal</b> tool (G) to move it.')+'</div>' +
        (sel.kind==='goal' ? '<div class="sp-actions"><button class="danger" id="spNoGoal">Remove win pad</button></div>' : '');
      const ng = $('#spNoGoal', el); if(ng) ng.addEventListener('click', ()=>{ App.studio.goal = null; App.studio.selected = null; rebuildKeepCam(); });
      wireCats(el); return;
    }
    const sb = selectedBlock();
    if(!sb){ selectStudioBlock(null); return; }
    const { data } = sb; const p = data.props || {};
    const t = BLOCK_TYPE_BY_ID[data.type] || BLOCK_TYPE_BY_ID.plastic;
    const mats = BLOCK_TYPES.filter(b=>!b.behavior);
    const curMat = t.behavior ? '' : data.type;
    el.innerHTML =
      cat('Data', [
        prow('Name', `<input type="text" id="spName" maxlength="24" value="${esc(p.nm||'')}" placeholder="${esc(t.label)}">`),
        prow('ClassName', '<span class="ro">Part</span>'),
        prow('Position', `<div class="sp-xyz"><input type="number" id="spX" value="${sel.x}" title="X"><input type="number" id="spY" value="${sel.y}" title="Y"><input type="number" id="spZ" value="${sel.z}" title="Z"></div>`),
      ]) +
      cat('Appearance', [
        prow('Color', `<input type="color" id="spColor" value="${esc(partColor(data))}"><span class="ro">${esc(partColor(data))}</span>`),
        prow('Material', `<select id="spMat">${t.behavior?'<option value="" selected>('+esc(t.label)+')</option>':''}${mats.map(m=>`<option value="${m.id}"${m.id===curMat?' selected':''}>${esc(m.label)}</option>`).join('')}</select>`),
        prow('Transparency', `<input type="range" id="spAlpha" min="0" max="0.9" step="0.05" value="${p.t||0}"><span class="ro" id="spAlphaV">${(p.t||0).toFixed(2)}</span>`),
      ]) +
      cat('Part', [
        prow('Shape', `<select id="spShape">${SHAPES.map(s=>`<option value="${s.id}"${(p.s||'block')===s.id?' selected':''}>${s.label}</option>`).join('')}</select>`),
        prow('Orientation', `<select id="spRot">${[0,1,2,3].map(r=>`<option value="${r}"${(p.r||0)===r?' selected':''}>${r*90}°</option>`).join('')}</select>`),
      ]) +
      cat('Behavior', [
        prow('CanCollide', `<input type="checkbox" id="spCollide" ${p.nc?'':'checked'}>`),
        prow('Gameplay', `<select id="spPlay">${GAMEPLAY.map(g=>`<option value="${g.id}"${(t.behavior||'')===g.id?' selected':''}>${g.label}</option>`).join('')}</select>`),
      ].concat(t.behavior==='checkpoint' ? [prow('Stage', `<input type="number" id="spStage" min="1" max="999" value="${p.n||''}" placeholder="auto">`)] : [])) +
      `<div class="sp-cat" data-cat="Script"><span class="car">${closedCats.has('Script')?'▸':'▾'}</span>Script</div>` +
      (closedCats.has('Script') ? '' : scriptBox(!!data.script, 'a part')) +
      `<div class="sp-actions"><button id="spDup">Duplicate (Ctrl+D)</button><button class="danger" id="spDel">Delete (Del)</button></div>`;
    const S = sb.sel;
    $('#spName', el).addEventListener('change', (e)=> setStudioBlockProp(S, 'nm', e.target.value.trim().slice(0,24)));
    const mv = ()=>{ const nx = Math.round(+$('#spX',el).value)||0, ny = Math.round(+$('#spY',el).value)||0, nz = Math.round(+$('#spZ',el).value)||0; moveStudioBlock(S, { x:nx, y:ny, z:nz }); };
    ['#spX','#spY','#spZ'].forEach(id=> $(id, el).addEventListener('change', mv));
    $('#spColor', el).addEventListener('change', (e)=> setStudioBlockProp(S, 'c', e.target.value));
    $('#spMat', el).addEventListener('change', (e)=>{ if(e.target.value) changeStudioBlockType(S, e.target.value); });
    const a = $('#spAlpha', el);
    a.addEventListener('input', ()=>{ $('#spAlphaV', el).textContent = (+a.value).toFixed(2); });
    a.addEventListener('change', ()=> setStudioBlockProp(S, 't', +a.value || null));
    $('#spShape', el).addEventListener('change', (e)=> setStudioBlockProp(S, 's', e.target.value==='block' ? null : e.target.value));
    $('#spRot', el).addEventListener('change', (e)=> setStudioBlockProp(S, 'r', +e.target.value || null));
    $('#spCollide', el).addEventListener('change', (e)=> setStudioBlockProp(S, 'nc', e.target.checked ? null : true));
    $('#spPlay', el).addEventListener('change', (e)=>{
      const g = e.target.value;
      if(g) changeStudioBlockType(S, g);
      else { const back = data.props && data.props.c ? 'plastic' : 'plastic'; changeStudioBlockType(S, back); }
    });
    const st = $('#spStage', el); if(st) st.addEventListener('change', (e)=> setStudioBlockProp(S, 'n', Math.max(0, Math.floor(+e.target.value||0)) || null));
    wireScriptBox(el, 'part', data);
    $('#spDup', el).addEventListener('click', duplicate);
    $('#spDel', el).addEventListener('click', ()=> removeStudioBlock(S.x, S.y, S.z));
    $$('input[type=text], input[type=number]', el).forEach(i=> i.addEventListener('keydown', (e)=>{ e.stopPropagation(); if(e.key==='Enter') i.blur(); }));
    wireCats(el);
  };
  function renderUiProps(el, sel){
    const u = findStudioUi(sel.id);
    if(!u){ selectStudioUi(null); return; }
    el.innerHTML = cat('Data', [prow('Name', '<span class="ro">'+(u.kind==='button'?'TextButton':'TextLabel')+'</span>'), prow('Text', `<input type="text" id="spUiText" maxlength="60" value="${esc(u.text)}">`)]) +
      cat('Position', [prow('X %', `<input type="number" id="spUiX" min="0" max="100" value="${Math.round(u.xPct)}">`), prow('Y %', `<input type="number" id="spUiY" min="0" max="100" value="${Math.round(u.yPct)}">`)]) +
      (u.kind==='button' ? `<div class="sp-cat"><span class="car">▾</span>Script</div>` + scriptBox(!!u.script, 'a button') : '') +
      `<div class="sp-actions"><button class="danger" id="spUiDel">Delete</button></div>`;
    $('#spUiText', el).addEventListener('change', (e)=> setStudioUiField(u.id, 'text', e.target.value.slice(0,60)));
    $('#spUiX', el).addEventListener('change', (e)=> setStudioUiField(u.id, 'xPct', clamp(+e.target.value||0,0,100)));
    $('#spUiY', el).addEventListener('change', (e)=> setStudioUiField(u.id, 'yPct', clamp(+e.target.value||0,0,100)));
    wireScriptBox(el, 'gui', u);
    $('#spUiDel', el).addEventListener('click', ()=> removeStudioUi(u.id));
    $$('input', el).forEach(i=> i.addEventListener('keydown', (e)=> e.stopPropagation()));
    wireCats(el);
  }
  // ------------------------------------------------------------------ scripts
  function scriptBox(has, what){
    return '<div class="sp-scriptrow">' + (has
      ? '<span class="nm">📜 Script</span><button type="button" class="primary" data-sb="open">Edit script</button><button type="button" class="danger" data-sb="del">Remove</button>'
      : '<button type="button" class="primary" data-sb="add">+ Add a Script</button><span class="hint">JavaScript that runs while the game plays — script.Parent is ' + what + '.</span>') + '</div>';
  }
  function wireScriptBox(el, kind, ref){
    const b = (k)=> el.querySelector('[data-sb="'+k+'"]');
    if(b('open')) b('open').addEventListener('click', ()=> openScript(kind, ref));
    if(b('add')) b('add').addEventListener('click', ()=> insertScript(kind, ref));
    if(b('del')) b('del').addEventListener('click', ()=> deleteScript(kind, ref));
  }
  function ownerOf(kind, ref){ return window.NeoCodeEditor ? NeoCodeEditor.ownerOf(kind, ref) : null; }
  function scriptLabel(kind, ref){
    if(kind==='world') return 'ServerScriptService.' + (ref.name || 'Script');
    if(kind==='gui') return 'StarterGui.TextButton.Script';
    return 'Workspace.' + partName(ref) + '.Script';
  }
  function hasScript(kind, ref){ return kind==='world' ? (App.studio.scripts||[]).includes(ref) : !!(ref && ref.script); }
  function openScript(kind, ref){
    if(!ref || !hasScript(kind, ref)) return;
    App.studio.selected = { kind:'script', where:kind, ref };
    refreshStudioSelectionOutline(); renderStudioExplorer(); renderStudioProperties();
    if(window.NeoCodeEditor) NeoCodeEditor.open(ownerOf(kind, ref));
  }
  // Insert a Script: into a part, a button, or ServerScriptService — with starter code, then open it.
  function insertScript(kind, ref){
    if(App.studio.testing){ showToast('Stop the playtest to add scripts'); return; }
    const T = window.NeoCodeEditor ? NeoCodeEditor.templates : { part:'', world:'', gui:'' };
    if(kind==='world'){
      const n = (App.studio.scripts||[]).length;
      ref = addWorldScript(n ? 'Script' + (n+1) : 'Script', T.world);
      if(!ref) return;
      open.add('sss');
    } else if(kind==='gui'){
      if(!ref || ref.kind!=='button'){ showToast('Scripts go in TextButtons'); return; }
      if(!ref.script) ref.script = { lang:'js', code: T.gui };
      open.add('startergui');
    } else {
      if(!ref) return;
      if(!ref.script) setPartScript(ref, T.part);
      open.add('workspace'); open.add('g:'+ref.type);
    }
    UI.log('Inserted a Script into ' + scriptLabel(kind, ref).replace(/\.Script$/, ''), 'ok');
    openScript(kind, ref);
  }
  function deleteScript(kind, ref){
    const owner = ownerOf(kind, ref);
    if(owner && window.NeoCodeEditor) NeoCodeEditor.closeFor(owner);
    if(kind==='world') removeWorldScript(ref);
    else if(kind==='gui') ref.script = null;
    else setPartScript(ref, null);
    UI.log('Removed ' + scriptLabel(kind, ref));
    const sel = App.studio.selected;
    if(sel && sel.kind==='script' && sel.ref===ref) App.studio.selected = null;
    renderStudioExplorer(); renderStudioProperties();
  }
  // Ribbon "Script": into the selected part / button, otherwise ServerScriptService
  UI.insertScript = function(){
    const sb = selectedBlock();
    if(sb) return insertScript('part', sb.data);
    const sel = App.studio.selected;
    if(sel && sel.kind==='ui'){ const u = findStudioUi(sel.id); if(u && u.kind==='button') return insertScript('gui', u); }
    insertScript('world');
  };
  UI.openScript = openScript;
  function renderScriptProps(el, sel){
    if(!hasScript(sel.where, sel.ref)){ App.studio.selected = null; renderStudioProperties(); return; }
    const isWorld = sel.where==='world';
    const parent = isWorld ? 'ServerScriptService' : sel.where==='gui' ? 'TextButton' : partName(sel.ref);
    el.innerHTML = cat('Data', [
        prow('Name', isWorld ? `<input type="text" id="spScrName" maxlength="40" value="${esc(sel.ref.name||'Script')}">` : '<span class="ro">Script</span>'),
        prow('ClassName', '<span class="ro">Script</span>'),
        prow('Parent', '<span class="ro">'+esc(parent)+'</span>'),
        prow('Language', '<span class="ro">JavaScript</span>'),
      ]) +
      '<div class="sp-scriptrow"><button type="button" class="primary" data-sb="open">Edit script</button><button type="button" class="danger" data-sb="del">Delete</button>' +
      '<span class="hint">' + (isWorld ? 'Runs once when the game starts.' : sel.where==='gui' ? 'script.Parent is the button — use MouseButton1Click.' : 'script.Parent is the part — use Touched, ClickDetector…') + '</span></div>';
    const nm = $('#spScrName', el);
    if(nm){
      nm.addEventListener('keydown', (e)=>{ e.stopPropagation(); if(e.key==='Enter') nm.blur(); });
      nm.addEventListener('change', ()=>{ sel.ref.name = (nm.value.replace(/[<>.]/g,'').trim() || 'Script').slice(0, 40); renderStudioExplorer(); if(window.NeoCodeEditor) NeoCodeEditor.refresh(); });
    }
    wireScriptBox(el, sel.where, sel.ref);
    wireCats(el);
  }
  function wireCats(el){ $$('.sp-cat[data-cat]', el).forEach(c=> c.addEventListener('click', ()=>{ const n = c.dataset.cat; if(closedCats.has(n)) closedCats.delete(n); else closedCats.add(n); renderStudioProperties(); })); }

  // ------------------------------------------------------------------ selection box + move arrows
  let selBox = null, hoverBox = null, ghost = null, handles = null;
  const EDGE_GEO = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)); EDGE_GEO.userData.keep = true;
  window.refreshStudioSelectionOutline = function(){
    if(App.studioSelectOutline && App.studioSelectOutline.parent) App.studioSelectOutline.parent.remove(App.studioSelectOutline);
    App.studioSelectOutline = null;
    removeHandles();
    const sel = App.studio.selected;
    if(!App.scene || !sel) return;
    let pos = null;
    if(sel.kind==='block') pos = { x:sel.x+0.5, y:sel.y+0.5, z:sel.z+0.5 };
    else if(sel.kind==='spawn' && App.studio.spawn) pos = { x:App.studio.spawn.x+0.5, y:App.studio.spawn.y+0.05, z:App.studio.spawn.z+0.5 };
    else if(sel.kind==='goal' && App.studio.goal) pos = { x:App.studio.goal.x+0.5, y:App.studio.goal.y+0.05, z:App.studio.goal.z+0.5 };
    if(!pos) return;
    const box = new THREE.LineSegments(EDGE_GEO, new THREE.LineBasicMaterial({ color:0x1e9bff, depthTest:false, transparent:true }));
    if(sel.kind!=='block') box.scale.set(1.6, 0.12, 1.6);
    box.position.set(pos.x, pos.y, pos.z);
    box.renderOrder = 998;
    App.scene.add(box);
    App.studioSelectOutline = box;
    if(sel.kind==='block' && App.studio.tool==='move') addHandles(pos);
  };
  function removeHandles(){ if(handles && handles.parent) handles.parent.remove(handles); handles = null; }
  function addHandles(pos){
    const g = new THREE.Group();
    const axes = [[1,0,0,0xff4d4d],[-1,0,0,0xff4d4d],[0,1,0,0x3ddc84],[0,-1,0,0x3ddc84],[0,0,1,0x3d8bff],[0,0,-1,0x3d8bff]];
    axes.forEach(([x,y,z,col])=>{
      const mat = new THREE.MeshBasicMaterial({ color:col, depthTest:false, transparent:true });
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8), mat); shaft.position.y = 0.25; arrow.add(shaft);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.3, 14), mat); cone.position.y = 0.62; arrow.add(cone);
      const grab = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.9, 8), new THREE.MeshBasicMaterial({ visible:false })); grab.position.y = 0.45; arrow.add(grab);
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), new THREE.Vector3(x,y,z));
      arrow.position.set(x*0.55, y*0.55, z*0.55);
      arrow.traverse(o=>{ o.renderOrder = 999; o.userData.axis = [x,y,z]; });
      g.add(arrow);
    });
    g.position.set(pos.x, pos.y, pos.z);
    App.scene.add(g);
    handles = g;
  }
  function setHover(pick){
    if(!App.scene) return;
    const tool = App.studio.tool;
    if(!hoverBox){ hoverBox = new THREE.LineSegments(EDGE_GEO, new THREE.LineBasicMaterial({ color:0x9fd2ff, depthTest:false, transparent:true, opacity:0.75 })); hoverBox.renderOrder = 997; }
    if(!ghost){ ghost = new THREE.Mesh(BOX_GEO, new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.35, depthWrite:false })); ghost.renderOrder = 996; }
    if(hoverBox.parent !== App.scene) App.scene.add(hoverBox);
    if(ghost.parent !== App.scene) App.scene.add(ghost);
    hoverBox.visible = false; ghost.visible = false;
    if(!pick) return;
    if(['select','move','rotate','erase'].includes(tool) && pick.gx!==undefined){
      hoverBox.visible = true; hoverBox.position.set(pick.gx+0.5, pick.gy+0.5, pick.gz+0.5);
      hoverBox.material.color.setHex(tool==='erase' ? 0xff5c5c : 0x9fd2ff);
    } else if(tool==='place' && inBounds(pick.px, pick.py, pick.pz)){
      ghost.visible = true; ghost.position.set(pick.px+0.5, pick.py+0.5, pick.pz+0.5);
      const col = App.studio.partColor ? hexToNum(App.studio.partColor) : (BLOCK_TYPE_BY_ID[App.studio.selectedBlock]||{color:0xffffff}).color;
      ghost.material.color.setHex(col);
    } else if((tool==='spawn' || tool==='goal' || tool==='prefab') && inBounds(pick.px, pick.py, pick.pz)){
      hoverBox.visible = true; hoverBox.position.set(pick.px+0.5, pick.py+0.5, pick.pz+0.5); hoverBox.material.color.setHex(0xffd23f);
    }
  }
  function clearHover(){ if(hoverBox) hoverBox.visible = false; if(ghost) ghost.visible = false; }

  // ------------------------------------------------------------------ mouse / touch / keys
  const M = { look:false, lx:0, ly:0, drag:null, lastHover:0, down:null };
  function ndcOf(e){ const c = $('#gamecanvas'); const r = c.getBoundingClientRect(); return { x: ((e.clientX - r.left)/r.width)*2-1, y: -((e.clientY - r.top)/r.height)*2+1 }; }
  function pickHandle(ndc){
    if(!handles) return null;
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, App.camera);
    const hits = rc.intersectObject(handles, true);
    return hits.length ? hits[0].object.userData.axis : null;
  }
  function screenOf(v){ const p = v.clone().project(App.camera); const c = $('#gamecanvas'); return { x:(p.x+1)/2*c.clientWidth, y:(1-p.y)/2*c.clientHeight }; }
  function install(){
    const canvas = $('#gamecanvas'); if(!canvas || canvas._sdWired) return; canvas._sdWired = true;
    canvas.addEventListener('mousedown', (e)=>{
      if(!editing() || isTouchDevice()) return;
      closeMenus();
      // clicking the 3D view takes the keyboard back from any Properties box (so WASD/shortcuts work)
      const ae = document.activeElement; if(ae && ae!==document.body && ae.blur) ae.blur();
      if(e.button===2){ M.look = true; M.lx = e.clientX; M.ly = e.clientY; canvas.style.cursor = 'grabbing'; return; }
      if(e.button!==0) return;
      const ndc = ndcOf(e);
      const axis = pickHandle(ndc);
      const sb = selectedBlock();
      if(axis && sb){
        const c0 = new THREE.Vector3(sb.sel.x+0.5, sb.sel.y+0.5, sb.sel.z+0.5);
        const s0 = screenOf(c0), s1 = screenOf(c0.clone().add(new THREE.Vector3(axis[0],axis[1],axis[2])));
        M.drag = { axis, start:{ x:sb.sel.x, y:sb.sel.y, z:sb.sel.z }, mx:e.clientX, my:e.clientY, sv:{ x:s1.x-s0.x, y:s1.y-s0.y } };
        return;
      }
      performBuildAction(ndc);
      if(App.studio.tool==='move') refreshStudioSelectionOutline();
    });
    window.addEventListener('mouseup', (e)=>{
      if(e.button===2 && M.look){ M.look = false; canvas.style.cursor = ''; }
      if(e.button===0 && M.drag){ M.drag = null; renderStudioProperties(); }
    });
    window.addEventListener('mousemove', (e)=>{
      if(!editing()) return;
      if(M.look){
        const dx = e.clientX - M.lx, dy = e.clientY - M.ly; M.lx = e.clientX; M.ly = e.clientY;
        App.yaw -= dx*0.005*(App.settings?App.settings.sens:1);
        App.pitch = clamp(App.pitch - dy*0.004*(App.settings?App.settings.sens:1), -1.45, 1.45);
        return;
      }
      if(M.drag){
        const d = M.drag; const sv = d.sv; const len2 = sv.x*sv.x + sv.y*sv.y;
        if(len2 < 1) return;
        const t = ((e.clientX-d.mx)*sv.x + (e.clientY-d.my)*sv.y) / len2;
        const steps = Math.round(t);
        const sb = selectedBlock(); if(!sb) return;
        const tx = d.start.x + d.axis[0]*steps, ty = d.start.y + d.axis[1]*steps, tz = d.start.z + d.axis[2]*steps;
        if((tx!==sb.sel.x || ty!==sb.sel.y || tz!==sb.sel.z) && free(tx,ty,tz)){ moveStudioBlock(sb.sel, { x:tx, y:ty, z:tz }); refreshStudioSelectionOutline(); }
        return;
      }
      if(e.target !== canvas){ clearHover(); return; }
      const now = performance.now();
      if(now - M.lastHover < 40) return; M.lastHover = now;
      setHover(studioPick(ndcOf(e)));
    });
    canvas.addEventListener('mouseleave', clearHover);
    canvas.addEventListener('wheel', (e)=>{
      if(!editing()) return;
      e.preventDefault();
      if(!App.studioPos) return;
      App.studioPos.addScaledVector(camDirFromYawPitch(App.yaw, App.pitch), -e.deltaY*0.02);
      App.studioPos.y = clamp(App.studioPos.y, 0.6, WORLD_MAXY+12);
    }, { passive:false });
    // touch: a quick tap uses the tool where you tapped (dragging still looks around)
    canvas.addEventListener('pointerdown', (e)=>{ if(e.pointerType==='touch' && editing()){ M.down = { x:e.clientX, y:e.clientY, t:performance.now(), id:e.pointerId }; const ae = document.activeElement; if(ae && ae!==document.body && ae.blur) ae.blur(); } });
    canvas.addEventListener('pointerup', (e)=>{
      if(e.pointerType!=='touch' || !editing() || !M.down || M.down.id!==e.pointerId) return;
      const moved = Math.hypot(e.clientX-M.down.x, e.clientY-M.down.y), dt = performance.now()-M.down.t;
      M.down = null;
      if(moved < 10 && dt < 400){ performBuildAction(ndcOf(e)); if(App.studio.tool==='move') refreshStudioSelectionOutline(); }
    });

    window.addEventListener('keydown', (e)=>{
      if(App.mode!=='studio') return;
      const ae = document.activeElement;
      if(ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA' || ae.tagName==='SELECT')) return;
      if(e.code==='F5'){ e.preventDefault(); e.stopImmediatePropagation(); if(e.shiftKey) stopStudioPlaytest(); else if(!App.studio.testing) startStudioPlaytest(); return; }
      if(!editing()) return;
      const mod = e.ctrlKey || e.metaKey;
      const stop = ()=>{ e.preventDefault(); e.stopImmediatePropagation(); };
      if(mod && e.code==='KeyC'){ stop(); copy(); return; }
      if(mod && e.code==='KeyV'){ stop(); paste(); return; }
      if(mod && e.code==='KeyD'){ stop(); duplicate(); return; }
      if(mod) return;
      if(e.code==='KeyQ'){ App.input.sink = true; return; }
      if(e.code==='KeyE'){ App.input.up = true; return; }
      if(e.code==='KeyM'){ setStudioTool('move'); return; }
      if(e.code==='KeyR'){ const sb = selectedBlock(); if(sb) setStudioBlockProp(sb.sel, 'r', (((sb.data.props||{}).r||0)+1)%4); else setStudioTool('rotate'); return; }
      if(e.code==='KeyF'){ focusSelected(); return; }
      if(e.code==='Escape'){ selectStudioBlock(null); closeMenus(); return; }
      if(e.code==='Delete' || e.code==='Backspace'){ const sb = selectedBlock(); if(sb){ stop(); removeStudioBlock(sb.sel.x, sb.sel.y, sb.sel.z); } return; }
      const nudge = { ArrowLeft:[-1,0,0], ArrowRight:[1,0,0], ArrowUp:[0,0,-1], ArrowDown:[0,0,1], PageUp:[0,1,0], PageDown:[0,-1,0] }[e.code];
      if(nudge){
        const sb = selectedBlock(); if(!sb) return;
        stop();
        const v = e.shiftKey && (e.code==='ArrowUp' || e.code==='ArrowDown') ? [0, e.code==='ArrowUp'?1:-1, 0] : nudge;
        const t = { x:sb.sel.x+v[0], y:sb.sel.y+v[1], z:sb.sel.z+v[2] };
        if(free(t.x,t.y,t.z)){ moveStudioBlock(sb.sel, t); refreshStudioSelectionOutline(); }
      }
    }, true);
    window.addEventListener('keyup', (e)=>{ if(e.code==='KeyQ') App.input.sink = false; if(e.code==='KeyE') App.input.up = false; });
  }
  function focusSelected(){
    const sb = selectedBlock(); if(!sb || !App.studioPos) return;
    const c = new THREE.Vector3(sb.sel.x+0.5, sb.sel.y+0.5, sb.sel.z+0.5);
    App.studioPos.copy(c).addScaledVector(camDirFromYawPitch(App.yaw, App.pitch), -6);
  }

  // ------------------------------------------------------------------ clipboard
  let clip = null;
  function copy(){ const sb = selectedBlock(); if(!sb){ showToast('Select a part first'); return; } clip = { type:sb.data.type, props: sb.data.props ? Object.assign({}, sb.data.props) : null, script: sb.data.script ? Object.assign({}, sb.data.script) : null }; UI.log('Copied '+partName(sb.data)); showToast('Copied'); }
  function paste(at){
    if(!clip){ showToast('Copy a part first (Ctrl+C)'); return; }
    const base = at || (selectedBlock() ? selectedBlock().sel : null) || { x:0, y:0, z:0 };
    // the first free spot: straight up, then around
    const tries = [[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,2,0],[0,3,0]];
    for(const t of tries){
      const x = base.x+t[0], y = base.y+t[1], z = base.z+t[2];
      if(free(x,y,z)){ addStudioBlock(x,y,z, clip.type, clip.props, { script: clip.script }); selectStudioBlock(x,y,z); return; }
    }
    showToast('No room to paste here');
  }
  function duplicate(){ const sb = selectedBlock(); if(!sb){ showToast('Select a part first'); return; } copy(); paste(sb.sel); }

  // ------------------------------------------------------------------ prefabs (Toolbox)
  UI.placePrefab = function(id, ax, ay, az){
    const pf = PREFABS.find(p=>p.id===id); if(!pf) return;
    let placed = 0, skipped = 0;
    deserializeBlocks(pf.blocks).forEach((v,k)=>{
      const [dx,dy,dz] = k.split(',').map(Number);
      const x = ax+dx, y = ay+dy, z = az+dz;
      if(free(x,y,z)){ addStudioBlock(x,y,z, v.type, v.props, { quiet:true, script: v.script }); placed++; } else skipped++;
    });
    if(placed){ SFX.place(); renderStudioExplorer(); }
    UI.log('Inserted "'+pf.name+'" — '+placed+' part'+(placed===1?'':'s')+(skipped?' ('+skipped+' blocked or out of bounds)':''), placed ? 'ok' : 'warn');
  };
  let toolboxRendered = false;
  function renderToolbox(){
    const body = $('#studioToolboxBody'); if(!body) return;
    const q = (($('#stSearch') && $('#stSearch').value) || '').toLowerCase();
    if(!toolboxRendered){
      body.innerHTML = '<input class="st-search" id="stSearch" placeholder="Search models" autocomplete="off"><div class="st-tip">Click a model, then click in the world to drop it in.</div><div class="st-grid" id="stGrid"></div>';
      $('#stSearch').addEventListener('input', renderToolbox);
      $('#stSearch').addEventListener('keydown', (e)=> e.stopPropagation());
      toolboxRendered = true;
    }
    const grid = $('#stGrid');
    grid.innerHTML = PREFABS.filter(p=>!q || p.name.toLowerCase().includes(q)).map(p=>`<div class="st-item${App.studio.tool==='prefab' && App.studio.prefab===p.id ? ' on':''}" data-pf="${p.id}"><img alt="" data-pfimg="${p.id}"><div>${esc(p.name)}</div></div>`).join('');
    $$('[data-pf]', grid).forEach(it=> it.addEventListener('click', ()=>{
      App.studio.prefab = it.dataset.pf; setStudioTool('prefab');
      const pf = PREFABS.find(p=>p.id===it.dataset.pf);
      showToast('Click in the world to place '+pf.name);
      renderToolbox();
    }));
    // pictures, a few at a time
    const imgs = $$('img[data-pfimg]', grid);
    let i = 0;
    const step = ()=>{ const t0 = performance.now(); while(i<imgs.length && performance.now()-t0 < 25){ const img = imgs[i++]; img.src = thumbFor(img.dataset.pfimg); } if(i<imgs.length) setTimeout(step, 16); };
    step();
  }
  const pfThumbs = {};
  function thumbFor(id){ if(pfThumbs[id]) return pfThumbs[id]; const pf = PREFABS.find(p=>p.id===id); if(!pf || !window.NeoHome || !NeoHome.blocksThumb) return ''; return (pfThumbs[id] = NeoHome.blocksThumb(pf.blocks, 160, 160)); }

  // ------------------------------------------------------------------ ribbon menus
  function closeMenus(){ $$('.sd-menu').forEach(m=> m.hidden = true); const f = $('#sdFileMenu'); if(f) f.hidden = true; }
  function toggleMenu(id){ const m = $(id); const was = m.hidden; closeMenus(); m.hidden = !was; }
  function renderPartMenu(){
    $('#sdPartMenu').innerHTML = SHAPES.map(s=>`<button class="sd-mi" data-shape="${s.id}"><span class="sw">${s.ic}</span>${s.label}${(App.studio.partShape||'block')===s.id?' ✓':''}</button>`).join('');
    $$('#sdPartMenu [data-shape]').forEach(b=> b.addEventListener('click', ()=> setShape(b.dataset.shape)));
    $('#sdShapeButtons').innerHTML = SHAPES.map(s=>`<button class="rib-btn${(App.studio.partShape||'block')===s.id?' on':''}" data-shape2="${s.id}"><span class="rib-ic">${s.ic}</span><span>${s.label}</span></button>`).join('');
    $$('[data-shape2]').forEach(b=> b.addEventListener('click', ()=> setShape(b.dataset.shape2)));
    const sh = SHAPES.find(s=>s.id===(App.studio.partShape||'block')); $('#sdPartIcon').textContent = sh ? sh.ic : '■';
  }
  function setShape(id){ App.studio.partShape = id; setStudioTool('place'); closeMenus(); renderPartMenu(); UI.log('New parts: '+id); }
  function renderColorMenu(){
    const cur = App.studio.partColor;
    $('#sdColorMenu').innerHTML = '<div class="sd-colors">' + COLORS.map(c=>`<button style="background:${c}" data-col="${c}" class="${cur===c?'on':''}" title="${c}"></button>`).join('') + '</div>' +
      `<div class="sd-colors-foot">Custom <input type="color" id="sdCustomColor" value="${cur||'#a3a2a5'}"><button id="sdColorReset">Material default</button></div>`;
    $$('#sdColorMenu [data-col]').forEach(b=> b.addEventListener('click', ()=> setColor(b.dataset.col)));
    $('#sdCustomColor').addEventListener('change', (e)=> setColor(e.target.value));
    $('#sdColorReset').addEventListener('click', ()=> setColor(null));
    $('#sdColorDot').style.background = cur || numToHex((BLOCK_TYPE_BY_ID[App.studio.selectedBlock]||BLOCK_TYPE_BY_ID.plastic).color);
  }
  function setColor(c){
    App.studio.partColor = c;
    const sb = selectedBlock();
    if(sb && App.studio.tool!=='place') setStudioBlockProp(sb.sel, 'c', c);
    closeMenus(); renderColorMenu();
  }
  function setSky(sky){ App.studio.lighting = { sky }; rebuildKeepCam(); UI.log('Lighting: '+sky); renderStudioProperties(); }

  // File menu
  function buildFileMenu(){
    const m = document.createElement('div');
    m.className = 'sd-filemenu interactive'; m.id = 'sdFileMenu'; m.hidden = true;
    m.innerHTML = `<button class="sd-mi" data-f="new">📄 New place</button>
      <div class="sd-open-title">Open one of your published builds</div><div id="sdOpenSlot"></div><hr>
      <button class="sd-mi" data-f="publish">⇪ Publish to Neoblox</button>
      <button class="sd-mi" data-f="test">▶ Play test <kbd>F5</kbd></button><hr>
      <button class="sd-mi" data-f="exit">↩ Exit to Home</button>`;
    $('#studioIde').appendChild(m);
    const wp = $('#worldPanel'); if(wp) $('#sdOpenSlot').appendChild(wp);
    m.addEventListener('click', (e)=>{
      const b = e.target.closest('[data-f]');
      if(e.target.closest('.world-row')) { setTimeout(closeMenus, 0); return; }
      if(!b) return;
      closeMenus();
      const f = b.dataset.f;
      if(f==='new'){ $('#btnClearWorld').click(); }
      else if(f==='publish'){ $('#btnPublish').click(); }
      else if(f==='test'){ startStudioPlaytest(); }
      else if(f==='exit'){ handleMenuClick(); }
    });
  }

  function wire(){
    install();
    buildFileMenu();
    $('#sdFileBtn').addEventListener('click', (e)=>{ e.stopPropagation(); toggleMenu('#sdFileMenu'); if(!$('#sdFileMenu').hidden) refreshMyWorldsForStudio(); });
    $('#sdPartBtn').addEventListener('click', (e)=>{ e.stopPropagation(); renderPartMenu(); toggleMenu('#sdPartMenu'); });
    $('#sdMaterialBtn').addEventListener('click', (e)=>{ e.stopPropagation(); toggleMenu('#sdMaterialMenu'); });
    $('#sdColorBtn').addEventListener('click', (e)=>{ e.stopPropagation(); renderColorMenu(); toggleMenu('#sdColorMenu'); });
    document.addEventListener('click', (e)=>{ if(!e.target.closest('.sd-drop') && !e.target.closest('#sdFileMenu') && e.target.id!=='sdFileBtn') closeMenus(); });
    $('#sdCopy').addEventListener('click', copy);
    $('#sdPaste').addEventListener('click', ()=> paste());
    $('#sdDuplicate').addEventListener('click', duplicate);
    $('#toolMove').addEventListener('click', ()=> setStudioTool('move'));
    $('#toolRotate').addEventListener('click', ()=> setStudioTool('rotate'));
    $('#sdToolboxBtn').addEventListener('click', ()=> togglePanel('studioToolboxPanel', true));
    ['#sdInsertScript','#sdInsertScript2'].forEach(id=>{ const b = $(id); if(b) b.addEventListener('click', ()=> UI.insertScript()); });
    const sh = $('#sdScriptHelp'); if(sh) sh.addEventListener('click', ()=>{ if(window.NeoCodeEditor) NeoCodeEditor.help(); });
    $('#sdPlayHome').addEventListener('click', ()=> startStudioPlaytest());
    $('#sdPublishTop').addEventListener('click', ()=> $('#btnPublish').click());
    $('#sdExit').addEventListener('click', ()=> handleMenuClick());
    $('#sdBaseplateBtn').addEventListener('click', ()=>{ App.studio.baseplate = !(App.studio.baseplate!==false); rebuildKeepCam(); UI.log('Baseplate '+(App.studio.baseplate?'on':'off')); });
    $('#sdClearOutput').addEventListener('click', ()=>{ $('#studioOutputBody').innerHTML = ''; });
    $$('[data-quick]').forEach(b=> b.addEventListener('click', ()=>{
      selectPaletteBlock(b.dataset.quick); setStudioTool('place');
      const t = BLOCK_TYPE_BY_ID[b.dataset.quick];
      showToast('Click in the world to place a '+t.label);
    }));
    $$('[data-sky]').forEach(b=> b.addEventListener('click', ()=> setSky(b.dataset.sky)));
    $$('.sd-toggle').forEach(b=> b.addEventListener('click', ()=> togglePanel(b.dataset.panel)));
    $$('[data-close]').forEach(b=> b.addEventListener('click', ()=> togglePanel(b.dataset.close, false)));
    // wrap a few editor functions so the ribbon and Output stay in sync
    const wrap = (name, after)=>{ const f = window[name]; if(typeof f!=='function') return; window[name] = function(){ const r = f.apply(this, arguments); try{ after.apply(this, arguments); }catch(e){} return r; }; };
    wrap('selectPaletteBlock', (id)=>{
      const t = BLOCK_TYPE_BY_ID[id]; if(!t) return;
      $('#sdMaterialIcon').innerHTML = '<span class="sd-colordot" style="background:'+numToHex(t.color)+'"></span>';
      const sb = selectedBlock();
      if(sb && (App.studio.tool==='select' || App.studio.tool==='move') && !$('#sdMaterialMenu').hidden) changeStudioBlockType(sb.sel, id);
      closeMenus(); renderColorMenu();
    });
    wrap('setStudioTool', (tool)=>{
      if(tool!=='prefab') App.studio.prefab = null;
      refreshStudioSelectionOutline();
      if(toolboxRendered) renderToolbox();
      const c = $('#gamecanvas'); if(c) c.style.cursor = tool==='place' || tool==='prefab' ? 'crosshair' : '';
    });
    wrap('startStudioPlaytest', ()=>{ UI.log('▶ Playtest started — Esc for the menu, Shift+F5 or Stop to go back to editing'); setStudioRibbonTab('test'); clearHover(); removeHandles(); });
    wrap('stopStudioPlaytest', ()=>{ UI.log('■ Playtest stopped'); });
    wrap('removeStudioBlock', ()=>{ refreshStudioSelectionOutline(); });
    wrap('addStudioUi', (kind)=> UI.log('Added a '+(kind==='button'?'TextButton':'TextLabel')+' to StarterGui'));
    wrap('goToStudio', ()=>{
      renderPartMenu(); renderColorMenu(); renderToolbox(); updateTitle();
      if(!App.studioPos) App.studioPos = new THREE.Vector3(0, 9, 13);
      if(!outLines.length){
        UI.log('Welcome to NeoStudio! Right-drag to look around, WASD to fly (Q/E down/up), wheel to zoom.');
        UI.log('Build tool (B): click to add parts · Select (C) to edit one in Properties · Move (M) to drag arrows · F5 to play.');
      }
    });
    renderPartMenu(); renderColorMenu();
    selectPaletteBlock(App.studio.selectedBlock || 'plastic');
  }
  function togglePanel(id, show){
    const p = document.getElementById(id); if(!p) return;
    const hide = show===undefined ? !p.classList.contains('sd-hidden') : !show;
    p.classList.toggle('sd-hidden', hide);
    document.body.classList.toggle('sd-no-toolbox', $('#studioToolboxPanel').classList.contains('sd-hidden'));
    document.body.classList.toggle('sd-no-right', $('#studioExplorerPanel').classList.contains('sd-hidden') && $('#studioPropertiesPanel').classList.contains('sd-hidden'));
    document.body.classList.toggle('sd-no-output', $('#studioOutputPanel').classList.contains('sd-hidden'));
    if(id==='studioToolboxPanel' && !hide) renderToolbox();
  }
  UI.onLoaded = function(w){ updateTitle(); if(w) UI.log('Opened "'+(w.name||'Untitled')+'" ('+((w.blocks||[]).length)+' parts)'); else UI.log('New place'); };
  UI.tick = function(){ /* hover/handles are event-driven; nothing per-frame yet */ };

  document.addEventListener('DOMContentLoaded', ()=> setTimeout(wire, 0));
})();
