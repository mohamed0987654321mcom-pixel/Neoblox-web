// rbx/pictures.js — "My Pictures": upload pictures and pick one for a game's cover, a decal on a
// part, or an on-screen ImageLabel. Uploading needs an account. Before upload the picture is
// shrunk (max 1024px) and re-encoded in the browser, which keeps files small and also strips
// photo metadata such as GPS location.
'use strict';
(function(){
  const NP = window.NeoPictures = {};
  const esc = (t)=> String(t==null?'':t).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const MAX_SIDE = 1024;
  let mine = null; // cached list of your pictures

  // ------------------------------------------------------------------ shrink + re-encode
  function loadBitmap(file){
    if(window.createImageBitmap) return createImageBitmap(file).catch(()=> viaImg(file));
    return viaImg(file);
  }
  function viaImg(file){
    return new Promise((res, rej)=>{
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); res(img); };
      img.onerror = ()=>{ URL.revokeObjectURL(url); rej(new Error('That file isn\'t a picture this browser can open.')); };
      img.src = url;
    });
  }
  const toBlob = (c, type, q)=> new Promise(res=> c.toBlob(res, type, q));
  async function prepare(file){
    if(!/^image\//.test(file.type || '') && !/\.(png|jpe?g|webp|gif|heic|heif|bmp)$/i.test(file.name || '')) throw new Error('Choose a picture file (PNG, JPEG, WebP or GIF).');
    const bmp = await loadBitmap(file);
    const w0 = bmp.width, h0 = bmp.height;
    if(!w0 || !h0) throw new Error('That picture is empty.');
    const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0, w, h);
    if(bmp.close) bmp.close();
    // does it use transparency? (decals and on-screen images often do)
    let alpha = false;
    try{ const d = x.getImageData(0, 0, w, h).data; for(let i = 3; i < d.length; i += 16){ if(d[i] < 250){ alpha = true; break; } } }catch(e){}
    let blob = await toBlob(c, 'image/webp', 0.9);
    if(!blob || blob.type !== 'image/webp') blob = alpha ? await toBlob(c, 'image/png') : await toBlob(c, 'image/jpeg', 0.88);
    if(!blob) throw new Error('Couldn\'t read that picture.');
    if(blob.size > 2 * 1024 * 1024) blob = await toBlob(c, 'image/jpeg', 0.75);
    if(!blob || blob.size > 2 * 1024 * 1024) throw new Error('That picture is too big even after shrinking it.');
    return blob;
  }

  // ------------------------------------------------------------------ server
  NP.upload = async function(file){
    if(!Session.token) throw new Error('Log in to upload pictures.');
    const blob = await prepare(file);
    const res = await fetch(netHttpBase() + '/api/images', {
      method:'POST',
      headers:{ 'Content-Type': blob.type, 'Authorization': 'Bearer ' + Session.token, 'X-Image-Name': encodeURIComponent(String(file.name || 'Picture').slice(0, 60)) },
      body: blob,
    });
    let data = null; try{ data = await res.json(); }catch(e){}
    if(!res.ok) throw new Error((data && data.error) || 'Upload failed (' + res.status + ')');
    if(mine) mine.unshift(data);
    return data;
  };
  let mineToken = null;
  NP.list = async function(force){
    if(!Session.token) return [];
    if(mine && !force && mineToken === Session.token) return mine;
    mine = await apiFetch(netHttpBase() + '/api/images/mine');
    mineToken = Session.token;
    return mine;
  };
  NP.remove = async function(id){
    await apiFetch(netHttpBase() + '/api/images/' + encodeURIComponent(id), { method:'DELETE' });
    if(mine) mine = mine.filter(i=> i.id !== id);
  };

  // ------------------------------------------------------------------ the picker
  // NeoPictures.pick({ title, current, onPick(id|null) })
  let modal = null, opts = null, busy = false;
  function build(){
    modal = document.createElement('div');
    modal.className = 'np-back'; modal.hidden = true;
    modal.innerHTML = `<div class="np-modal" role="dialog" aria-modal="true" aria-labelledby="npTitle">
        <div class="np-head"><h3 id="npTitle">Pictures</h3><button type="button" class="np-x" data-np="close" aria-label="Close">✕</button></div>
        <div class="np-sub">Pick one of your pictures, or upload a new one.</div>
        <div class="np-grid"></div>
        <div class="np-foot"><span class="np-msg" role="status"></span><button type="button" class="np-btn ghost" data-np="none">Use no picture</button><button type="button" class="np-btn" data-np="close">Cancel</button></div>
        <input type="file" class="np-file" accept="image/png,image/jpeg,image/webp,image/gif,image/*" hidden>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e)=>{
      if(e.target === modal){ close(); return; }
      const b = e.target.closest('[data-np]');
      if(!b) return;
      const a = b.dataset.np;
      if(a==='close') close();
      else if(a==='none'){ const o = opts; close(); if(o && o.onPick) o.onPick(null); }
      else if(a==='upload'){ if(!Session.token){ close(); if(window.NeoHome && NeoHome.openLogin) NeoHome.openLogin('login', 'Log in to upload pictures for your games'); return; } modal.querySelector('.np-file').click(); }
      else if(a==='pick'){ const o = opts; close(); if(o && o.onPick) o.onPick(b.dataset.id); }
      else if(a==='del'){ e.stopPropagation(); delPic(b.dataset.id); }
    });
    modal.addEventListener('keydown', (e)=>{ e.stopPropagation(); if(e.key==='Escape') close(); });
    modal.querySelector('.np-file').addEventListener('change', async (e)=>{
      const files = Array.from(e.target.files || []).slice(0, 10);
      e.target.value = '';
      if(!files.length) return;
      busy = true; msg('Uploading ' + files.length + ' picture' + (files.length===1?'':'s') + '…'); render();
      let last = null;
      for(const f of files){
        try{ last = await NP.upload(f); }
        catch(err){ msg(err.message || 'Upload failed', true); busy = false; render(); return; }
      }
      busy = false; msg('Uploaded! Tap it to use it.'); render(last && last.id);
    });
  }
  function msg(t, bad){ const m = modal && modal.querySelector('.np-msg'); if(m){ m.textContent = t || ''; m.classList.toggle('bad', !!bad); } }
  async function delPic(id){
    if(!confirmDel(id)) return;
    try{ await NP.remove(id); msg('Deleted'); render(); }
    catch(err){ msg(err.message || 'Couldn\'t delete that', true); }
  }
  let armed = null;
  function confirmDel(id){
    // two taps on 🗑 to delete (no browser dialogs)
    if(armed === id){ armed = null; return true; }
    armed = id; msg('Tap 🗑 again to delete that picture (games using it will show nothing there)');
    setTimeout(()=>{ if(armed === id) armed = null; }, 3000);
    return false;
  }
  async function render(highlight){
    const grid = modal.querySelector('.np-grid');
    const upTile = `<button type="button" class="np-tile np-up" data-np="upload"${busy ? ' disabled' : ''}><span class="plus">${busy ? '…' : '+'}</span><span>${busy ? 'Uploading' : Session.token ? 'Upload picture' : 'Log in to upload'}</span></button>`;
    if(!Session.token){ grid.innerHTML = upTile; return; }
    grid.innerHTML = upTile + '<div class="np-loading">Loading your pictures…</div>';
    let list = [];
    try{ list = await NP.list(); }catch(e){ grid.innerHTML = upTile + '<div class="np-loading">Couldn\'t load your pictures right now.</div>'; return; }
    const cur = opts && opts.current;
    grid.innerHTML = upTile + list.map(p=> `<div class="np-tile${p.id===cur?' cur':''}${p.id===highlight?' new':''}" data-np="pick" data-id="${esc(p.id)}" role="button" tabindex="0" title="${esc(p.name)}">
        <img alt="" loading="lazy" src="${esc(imageUrl(p.id))}"><span class="nm">${esc(p.name)}</span>
        <button type="button" class="np-del" data-np="del" data-id="${esc(p.id)}" aria-label="Delete picture">🗑</button></div>`).join('') +
      (list.length ? '' : '<div class="np-loading">No pictures yet — upload one!</div>');
  }
  function close(){ if(modal) modal.hidden = true; opts = null; armed = null; }
  NP.pick = function(o){
    if(!modal) build();
    opts = o || {};
    modal.querySelector('#npTitle').textContent = opts.title || 'Pictures';
    modal.querySelector('[data-np="none"]').hidden = !opts.current;
    msg('');
    modal.hidden = false;
    render();
  };
  NP.isOpen = ()=> !!(modal && !modal.hidden);
  // forget the cached list when you log in/out
  NP.reset = ()=>{ mine = null; };
})();
