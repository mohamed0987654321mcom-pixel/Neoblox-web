// rbx/market.js — paid items: game passes (buy once, keep forever) and developer products (buy
// again and again), bought with tokens. Three parts:
//   - NeoMarket.prompt(): Neoblox's own buy window. A game's script can ask for it to open
//     (MarketplaceService.PromptGamePassPurchase…), but only the player can press Buy — scripts
//     run in a sandbox and can't reach this window, and Buy only works after a short moment so a
//     window popping up under a click can't be bought by accident.
//   - NeoMarket.manage(): NeoStudio → Test → 🛒 Paid Items, where a game's creator makes items,
//     sets prices and pictures, and sees what they've earned (70% of every sale).
//   - NeoMarket.renderStore(): the "Passes" section on a game's page on Home.
// The server (market.js) decides prices, takes the tokens and keeps track of what you own.
'use strict';
(function(){
  const NM = window.NeoMarket = {};
  const esc = (t)=> String(t==null?'':t).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const COIN = '<span class="nh-coin">N</span>';
  const fmt = (n)=> Number(n || 0).toLocaleString();
  const api = (p, o)=> apiFetch(netHttpBase() + p, o);
  const KIND = { pass:'Game Pass', product:'Developer Product' };
  const ARM_MS = 700; // Buy works after this long

  // ------------------------------------------------------------------ data
  const cache = new Map(); // world id -> { at, token, data }
  NM.items = async function(world, force){
    const k = String(world), c = cache.get(k);
    if(c && !force && c.token === Session.token && Date.now() - c.at < 15000) return c.data;
    const data = await api('/api/market/games/' + encodeURIComponent(k));
    cache.set(k, { at: Date.now(), token: Session.token, data });
    return data;
  };
  NM.mine = async function(world){
    if(!Session.token) return { passes:[], receipts:[] };
    return api('/api/market/games/' + encodeURIComponent(world) + '/mine');
  };
  const forget = (world)=> cache.delete(String(world));
  const picHtml = (item, cls)=> item && item.image ? `<img class="${cls||''}" alt="" src="${esc(imageUrl(item.image))}">` : `<div class="${cls||''} nm-nopic">${item && item.kind === 'product' ? '🪙' : '🎟️'}</div>`;

  // ------------------------------------------------------------------ the buy window
  // NeoMarket.prompt({ item, kind, owned, test, creator, onDone(bought, result) })
  let dlg = null, cur = null;
  function buildDlg(){
    dlg = document.createElement('div');
    dlg.className = 'nm-back nm-buyback'; dlg.hidden = true;
    dlg.innerHTML = `<div class="nm-buy" role="dialog" aria-modal="true" aria-labelledby="nmBuyTitle">
        <div class="nm-buy-brand">Neoblox · Buy</div>
        <div class="nm-buy-body"></div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e)=>{
      if(e.target === dlg){ finish(false); return; }
      const b = e.target.closest('[data-nm]'); if(!b || b.disabled) return;
      const a = b.dataset.nm;
      if(a === 'cancel' || a === 'ok') finish(cur && cur.bought, cur && cur.result);
      else if(a === 'buy') doBuy();
      else if(a === 'login'){ finish(false); if(window.NeoHome && NeoHome.openLogin) NeoHome.openLogin('login', 'Log in to buy things with your tokens'); }
    });
  }
  // While the window is open, keys don't reach the game (no walking off while buying), and
  // Escape closes it wherever the focus is.
  function onKey(e){
    if(!cur) return;
    e.stopImmediatePropagation();
    if(e.type === 'keydown' && e.key === 'Escape'){ e.preventDefault(); finish(cur.bought, cur.result); }
  }
  function body(html){
    const had = dlg.contains(document.activeElement) || document.activeElement === document.body;
    dlg.querySelector('.nm-buy-body').innerHTML = html;
    if(had){ const b = dlg.querySelector('[data-nm="cancel"], [data-nm="ok"]'); if(b) b.focus({ preventScroll:true }); }
  }
  // What the buy window says and offers right now — drawn as HTML here, and inside the headset
  // by rbx/vr.js (NeoMarket.vrModel), so both always agree.
  //   note: text, or { have, need } / { have, after } (token amounts)
  //   buy: { label, enabled, price? } · cancel: 'Cancel' | 'OK' · login: show "Log in"
  function model(){
    const o = cur, i = o.item, u = Session.user;
    const m = { item: i || null, kind: i ? KIND[i.kind] : null, title: i ? i.name : 'Not available', desc: i ? (i.desc || '') : 'This ' + (o.kind === 'product' ? 'item' : 'pass') + ' isn\'t for sale in this game.',
      price: null, done: null, owned: false, note: null, err: '', buy: null, cancel: 'Cancel', login: false };
    const buy = (label, enabled, price)=> ({ label: o.busy ? 'Buying…' : label, enabled: !!enabled && !o.busy, price: o.busy ? undefined : price });
    if(!i){ m.cancel = 'OK'; return m; }
    if(o.bought){ m.done = '✓ ' + (o.test ? 'Test purchase done' : 'Purchase complete'); if(o.test) m.note = 'Playtest — nothing was charged.'; m.cancel = 'OK'; return m; }
    if(o.owned){ m.owned = true; m.cancel = 'OK'; return m; }
    if(!i.onSale){ m.note = 'This isn\'t for sale right now.'; m.cancel = 'OK'; return m; }
    m.price = i.price; m.err = o.error || '';
    if(o.test){ m.note = '🧪 Playtest — a pretend purchase. Nothing is charged.'; m.buy = buy('Buy (test)', o.armed); return m; }
    if(!u){ m.note = 'Log in to buy things with tokens.'; m.login = true; m.err = ''; return m; }
    if(o.creator){ m.note = 'You made this, so it\'s free for you.'; m.buy = buy('Get it free', o.armed); return m; }
    if(u.unlimited){ m.note = 'Free for you — unlimited tokens ∞'; m.buy = buy('Get it free', o.armed); return m; }
    const have = u.tokens || 0;
    if(have < i.price){ m.note = { have, need: i.price - have }; m.err = ''; m.buy = buy('Buy', false); return m; }
    m.note = { have, after: have - i.price };
    m.buy = buy('Buy for', o.armed, i.price);
    return m;
  }
  function render(){
    const m = model(), i = m.item;
    const head = i ? `${picHtml(i, 'nm-buy-pic')}<div class="nm-buy-kind">${m.kind}</div><h3 id="nmBuyTitle">${esc(m.title)}</h3>${m.desc ? `<p class="nm-buy-desc">${esc(m.desc)}</p>` : ''}`
      : `<div class="nm-nopic nm-buy-pic">🚫</div><h3 id="nmBuyTitle">${esc(m.title)}</h3><p class="nm-buy-desc">${esc(m.desc)}</p>`;
    const note = !m.note ? '' : typeof m.note === 'string' ? `<p class="nm-buy-note">${esc(m.note)}</p>`
      : m.note.need !== undefined ? `<p class="nm-buy-note">You have ${COIN} ${fmt(m.note.have)} — you need ${fmt(m.note.need)} more. Finish quests to earn tokens!</p>`
      : `<p class="nm-buy-note">You have ${COIN} ${fmt(m.note.have)} · after this: ${COIN} ${fmt(m.note.after)}</p>`;
    const buy = m.login ? '<button type="button" class="nm-b green" data-nm="login">Log in</button>'
      : m.buy ? `<button type="button" class="nm-b green" data-nm="buy"${m.buy.enabled ? '' : ' disabled'}>${esc(m.buy.label)}${m.buy.price !== undefined ? ' ' + COIN + ' ' + fmt(m.buy.price) : ''}</button>` : '';
    body(`${head}${m.done ? `<div class="nm-buy-done">${esc(m.done)}</div>` : ''}${m.owned ? '<div class="nm-buy-price">✓ You already own this</div>' : ''}${m.price !== null ? `<div class="nm-buy-price">${COIN} ${fmt(m.price)}</div>` : ''}${note}${m.err ? `<p class="nm-buy-err" role="alert">${esc(m.err)}</p>` : ''}<div class="nm-buy-btns">${buy}<button type="button" class="nm-b" data-nm="cancel">${m.cancel}</button></div>`);
  }
  NM.vrModel = ()=> cur ? model() : null;
  // a button pressed in the headset's buy window: 'buy' | 'cancel'
  NM.vrPress = function(a){ if(!cur) return; if(a === 'buy') doBuy(); else finish(cur.bought, cur.result); };
  async function doBuy(){
    const o = cur; if(!o || o.busy || !o.armed) return;
    if(o.test){ o.bought = true; o.result = { test:true }; render(); setTimeout(()=>{ if(cur === o) finish(true, o.result); }, 1200); return; }
    o.busy = true; o.error = null; render();
    try{
      const r = await api('/api/market/items/' + encodeURIComponent(o.item.id) + '/buy', { method:'POST', body: JSON.stringify({ price: o.item.price }) });
      if(cur !== o) return;
      if(r.user){ Session.user = r.user; if(typeof refreshAccountUI === 'function') refreshAccountUI(); }
      forget(o.item.world);
      o.busy = false; o.bought = true; o.result = r; render();
      setTimeout(()=>{ if(cur === o) finish(true, r); }, 1400);
    }catch(e){
      if(cur !== o) return;
      o.busy = false;
      const m = /price just changed — it's now (\d+)/.exec(e.message || '');
      if(m){ o.item = Object.assign({}, o.item, { price: Number(m[1]) }); rearm(o); }
      o.error = e.message || 'Couldn\'t buy that right now';
      render();
    }
  }
  function rearm(o){ o.armed = false; setTimeout(()=>{ if(cur === o){ o.armed = true; render(); } }, ARM_MS); }
  function finish(bought, result){
    if(!cur || cur.busy) return; // never close while a purchase is on its way
    const o = cur; cur = null;
    dlg.hidden = true;
    ['keydown','keyup','keypress'].forEach(t=> window.removeEventListener(t, onKey, true));
    try{ if(o.onDone) o.onDone(!!bought, result || null); }catch(e){ console.error(e); }
  }
  NM.prompt = function(o){
    if(cur) return false;
    if(!dlg) buildDlg();
    cur = Object.assign({ armed:false, busy:false, bought:false, error:null }, o || {});
    if(cur.item) cur.item = Object.assign({}, cur.item);
    if(document.pointerLockElement) document.exitPointerLock();
    ['keydown','keyup','keypress'].forEach(t=> window.addEventListener(t, onKey, true));
    dlg.hidden = false;
    if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
    render();
    rearm(cur);
    return true;
  };
  NM.isOpen = ()=> !!cur;

  // ------------------------------------------------------------------ Home: a game's "Passes"
  NM.renderStore = async function(box, world){
    if(!box) return;
    let data = null, owned = new Set();
    try{ data = await NM.items(world); }catch(e){ box.hidden = true; return; }
    if(Session.token){ try{ owned = new Set(((await NM.mine(world)).passes || []).map(String)); }catch(e){} }
    const passes = (data.items || []).filter(i=> i.kind === 'pass' && (i.onSale || owned.has(String(i.id))));
    if(!passes.length){ box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<h2>Passes</h2><div class="nm-store">' + passes.map(i=>{
      const own = owned.has(String(i.id));
      return `<div class="nm-card">${picHtml(i, 'nm-card-pic')}<div class="nm-card-nm" title="${esc(i.desc || i.name)}">${esc(i.name)}</div>
        ${own ? '<div class="nm-card-own">✓ Owned</div>' : `<button type="button" class="nm-b green" data-buy="${esc(i.id)}">${COIN} ${fmt(i.price)}</button>`}</div>`;
    }).join('') + '</div>';
    box.querySelectorAll('[data-buy]').forEach(b=> b.addEventListener('click', ()=>{
      const item = passes.find(i=> String(i.id) === b.dataset.buy); if(!item) return;
      NM.prompt({ item, kind:'pass', creator: !!data.creator, onDone: (bought)=>{ if(bought){ showToast('🎟️ You bought ' + item.name + '!'); NM.renderStore(box, world); } } });
    }));
  };

  // ------------------------------------------------------------------ NeoStudio: 🛒 Paid Items
  let mg = null, tab = 'pass', editing = null, mgMsg = '';
  function buildMg(){
    mg = document.createElement('div');
    mg.className = 'nm-back nm-mgback'; mg.hidden = true;
    mg.innerHTML = `<div class="nm-mg" role="dialog" aria-modal="true" aria-labelledby="nmMgTitle">
        <div class="nm-mg-head"><h3 id="nmMgTitle">🛒 Paid Items</h3><button type="button" class="nm-x" data-mg="close" aria-label="Close">✕</button></div>
        <div class="nm-mg-body"></div>
      </div>`;
    document.body.appendChild(mg);
    mg.addEventListener('click', onMgClick);
    mg.addEventListener('keydown', (e)=>{ e.stopPropagation(); if(e.key === 'Escape' && !NeoPictures.isOpen()) closeMg(); });
    ['keyup','keypress'].forEach(t=> mg.addEventListener(t, (e)=> e.stopPropagation()));
  }
  function closeMg(){ if(mg) mg.hidden = true; editing = null; }
  let mgData = null;
  async function loadMg(){
    const w = App.studio.worldId;
    const box = mg.querySelector('.nm-mg-body');
    if(!Session.user){
      box.innerHTML = `<p class="nm-mg-sub">Sell game passes and developer products in your game — players pay with tokens and you earn 70% of every sale.</p>
        <div class="nm-mg-empty">Log in to sell items in your games.<br><button type="button" class="nm-b green" data-mg="login">Log in</button></div>`;
      return;
    }
    if(!w){
      box.innerHTML = `<p class="nm-mg-sub">Sell game passes and developer products in your game — players pay with tokens and you earn 70% of every sale.</p>
        <div class="nm-mg-empty">Publish your game first — then you can add things to sell here.<br><button type="button" class="nm-b green" data-mg="publish">Publish</button></div>`;
      return;
    }
    box.innerHTML = '<div class="nm-mg-empty">Loading…</div>';
    try{ mgData = await NM.items(w, true); }
    catch(e){ box.innerHTML = `<div class="nm-mg-empty">Couldn't load this game's items (${esc(e.message || e)}).</div>`; return; }
    if(!mgData.creator){
      box.innerHTML = `<div class="nm-mg-empty">${mgData.canSell ? 'This game belongs to another account, so you can\'t sell items in it.' : 'This game was published without an account, so it can\'t sell items.'}<br>Publish it again from your account (as a new game) to sell things in it.</div>`;
      return;
    }
    renderMg();
  }
  function renderMg(){
    const box = mg.querySelector('.nm-mg-body');
    const items = (mgData.items || []).filter(i=> i.kind === tab);
    const all = mgData.items || [];
    const earned = all.reduce((n, i)=> n + (i.earned || 0), 0), sales = all.reduce((n, i)=> n + (i.sales || 0), 0);
    const help = tab === 'pass'
      ? 'Bought <b>once</b>, kept forever — like VIP, double coins or a special tool. Your script checks <code>UserOwnsGamePassAsync(player.UserId, id)</code>.'
      : 'Bought <b>again and again</b> — like 100 coins or a revive. Your script hands each one out in <code>MarketplaceService.ProcessReceipt</code>.';
    const form = editing && editing.kind === tab ? formHtml(editing) : '';
    box.innerHTML = `
      <div class="nm-mg-earn">Earned so far: <b>${COIN} ${fmt(earned)}</b> from ${fmt(sales)} sale${sales === 1 ? '' : 's'} <span>· you get 70% of every sale</span></div>
      <div class="nm-tabs"><button type="button" class="nm-tab${tab === 'pass' ? ' on' : ''}" data-mg="tab" data-tab="pass">🎟️ Game Passes</button><button type="button" class="nm-tab${tab === 'product' ? ' on' : ''}" data-mg="tab" data-tab="product">🪙 Developer Products</button></div>
      <p class="nm-mg-sub">${help}</p>
      ${form || `<button type="button" class="nm-b green nm-new" data-mg="new">+ New ${tab === 'pass' ? 'game pass' : 'developer product'}</button>`}
      <div class="nm-list">${items.length ? items.map(rowHtml).join('') : (form ? '' : `<div class="nm-mg-empty small">No ${tab === 'pass' ? 'game passes' : 'developer products'} yet.</div>`)}</div>
      <div class="nm-mg-msg" role="status">${esc(mgMsg)}</div>`;
    mgMsg = '';
    const f = box.querySelector('.nm-form');
    if(f){ const n = f.querySelector('[name="name"]'); if(n && !n.value) n.focus(); }
  }
  function rowHtml(i){
    const ed = editing && editing.id === i.id;
    if(ed) return '';
    return `<div class="nm-row${i.onSale ? '' : ' off'}">${picHtml(i, 'nm-row-pic')}
      <div class="nm-row-main"><div class="nm-row-nm">${esc(i.name)}${i.onSale ? '' : ' <span class="nm-off">Off sale</span>'}</div>
        <div class="nm-row-meta">${COIN} ${fmt(i.price)} · ${fmt(i.sales)} sold · earned ${COIN} ${fmt(i.earned)}</div>
        <div class="nm-row-id">ID <code class="nm-id">${esc(i.id)}</code> <button type="button" class="nm-link" data-mg="copy" data-id="${esc(i.id)}">Copy</button> · <button type="button" class="nm-link" data-mg="script" data-id="${esc(i.id)}">Add a script for it</button></div></div>
      <div class="nm-row-btns"><button type="button" class="nm-b" data-mg="edit" data-id="${esc(i.id)}">Edit</button>
        <button type="button" class="nm-b" data-mg="sale" data-id="${esc(i.id)}">${i.onSale ? 'Take off sale' : 'Put on sale'}</button>
        ${i.sales ? '' : `<button type="button" class="nm-b danger" data-mg="del" data-id="${esc(i.id)}">Delete</button>`}</div></div>`;
  }
  function formHtml(e){
    const isNew = !e.id;
    return `<form class="nm-form" autocomplete="off" novalidate>
      <div class="nm-form-pic">${e.image ? `<img alt="" src="${esc(imageUrl(e.image))}">` : `<div class="nm-nopic">${e.kind === 'product' ? '🪙' : '🎟️'}</div>`}
        <button type="button" class="nm-b" data-mg="pic">${e.image ? 'Change picture' : 'Add picture'}</button></div>
      <div class="nm-form-fields">
        <label>Name<input name="name" maxlength="40" value="${esc(e.name || '')}" placeholder="${e.kind === 'pass' ? 'VIP' : '100 Coins'}"></label>
        <label>Description<textarea name="desc" maxlength="200" rows="2" placeholder="${e.kind === 'pass' ? 'Run faster and get a VIP tag' : 'Adds 100 coins to your balance'}">${esc(e.desc || '')}</textarea></label>
        <label>Price (tokens)<input name="price" type="number" min="1" max="10000" step="1" value="${esc(e.price || '')}" placeholder="25"></label>
        <div class="nm-form-btns"><button type="submit" class="nm-b green">${isNew ? 'Create' : 'Save'}</button><button type="button" class="nm-b" data-mg="cancelform">Cancel</button></div>
        <div class="nm-form-err" role="alert">${esc(e.error || '')}</div>
      </div></form>`;
  }
  function readForm(){
    const f = mg.querySelector('.nm-form'); if(!f || !editing) return;
    editing.name = f.querySelector('[name="name"]').value;
    editing.desc = f.querySelector('[name="desc"]').value;
    editing.price = f.querySelector('[name="price"]').value;
  }
  async function saveForm(){
    readForm();
    const e = editing; if(!e) return;
    const price = Number(e.price);
    if(!String(e.name || '').trim()){ e.error = 'Give it a name.'; renderMg(); return; }
    if(!Number.isInteger(price) || price < 1 || price > 10000){ e.error = 'Prices are whole numbers of tokens, from 1 to 10000.'; renderMg(); return; }
    const payload = { name: e.name, desc: e.desc || '', price, image: e.image || null };
    try{
      if(e.id) await api('/api/market/items/' + encodeURIComponent(e.id), { method:'PUT', body: JSON.stringify(payload) });
      else await api('/api/market/games/' + encodeURIComponent(App.studio.worldId) + '/items', { method:'POST', body: JSON.stringify(Object.assign({ kind: e.kind }, payload)) });
      mgMsg = e.id ? 'Saved' : 'Created! Use its ID in a script, or press "Add a script for it".';
      editing = null;
      await loadMg();
    }catch(err){ e.error = err.message || 'Couldn\'t save that'; renderMg(); }
  }
  async function onMgClick(ev){
    if(ev.target === mg){ closeMg(); return; }
    const b = ev.target.closest('[data-mg]');
    if(!b){ return; }
    const a = b.dataset.mg, id = b.dataset.id;
    const item = id ? (mgData && mgData.items || []).find(i=> String(i.id) === id) : null;
    if(a === 'close') closeMg();
    else if(a === 'login'){ closeMg(); if(window.NeoHome && NeoHome.openLogin) NeoHome.openLogin('login', 'Log in to sell items in your games'); }
    else if(a === 'publish'){ closeMg(); const p = document.getElementById('btnPublish'); if(p) p.click(); }
    else if(a === 'tab'){ readForm(); tab = b.dataset.tab; renderMg(); }
    else if(a === 'new'){ editing = { kind: tab, name:'', desc:'', price:'', image:null }; renderMg(); }
    else if(a === 'edit' && item){ editing = Object.assign({}, item); renderMg(); }
    else if(a === 'cancelform'){ editing = null; renderMg(); }
    else if(a === 'pic'){
      readForm();
      NeoPictures.pick({ title:'Picture for this item', current: editing && editing.image, onPick: (pid)=>{ if(editing){ editing.image = pid; renderMg(); } } });
    }
    else if(a === 'sale' && item){
      try{ await api('/api/market/items/' + encodeURIComponent(item.id), { method:'PUT', body: JSON.stringify({ onSale: !item.onSale }) }); mgMsg = item.onSale ? 'Taken off sale — players who bought it keep it' : 'On sale again'; await loadMg(); }
      catch(err){ mgMsg = err.message; renderMg(); }
    }
    else if(a === 'del' && item){
      if(b.dataset.armed !== '1'){ b.dataset.armed = '1'; b.textContent = 'Really delete?'; setTimeout(()=>{ if(b.isConnected){ b.dataset.armed = ''; b.textContent = 'Delete'; } }, 3000); return; }
      try{ await api('/api/market/items/' + encodeURIComponent(item.id), { method:'DELETE' }); mgMsg = 'Deleted'; await loadMg(); }
      catch(err){ mgMsg = err.message; renderMg(); }
    }
    else if(a === 'copy' && item){
      const done = ()=>{ mgMsg = 'Copied ID ' + item.id; renderMg(); };
      try{ navigator.clipboard.writeText(String(item.id)).then(done, done); }catch(e){ done(); }
    }
    else if(a === 'script' && item && window.NeoCodeEditor && window.NeoStudioUI){
      const ex = item.kind === 'pass' ? NeoCodeEditor.example('VIP game pass') : NeoCodeEditor.example('Sell coins (developer product)');
      const label = item.kind === 'pass' ? 'game pass' : 'developer product';
      const code = ex.replace('= 0; // ← paste your ' + label + ' id here', '= ' + item.id + '; // your "' + item.name.replace(/[\\"\n]/g, '') + '" ' + label);
      closeMg();
      NeoStudioUI.insertWorldScript((item.kind === 'pass' ? 'PassScript' : 'ProductScript') + item.id, code);
    }
  }
  mgFormSubmit();
  function mgFormSubmit(){ document.addEventListener('submit', (e)=>{ if(mg && e.target.closest && e.target.closest('.nm-mg')){ e.preventDefault(); saveForm(); } }, true); }
  NM.manage = function(){
    if(!mg) buildMg();
    editing = null; mgMsg = '';
    mg.hidden = false;
    loadMg();
  };
  NM.isManaging = ()=> !!(mg && !mg.hidden);

  document.addEventListener('DOMContentLoaded', wire);
  if(document.readyState !== 'loading') wire();
  function wire(){
    const b = document.getElementById('btnPaidItems');
    if(b && !b._nm){ b._nm = true; b.addEventListener('click', ()=> NM.manage()); }
  }
})();
