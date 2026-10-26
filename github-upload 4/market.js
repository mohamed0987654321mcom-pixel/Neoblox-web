// market.js — paid items in Neoblox games, bought with tokens (like Roblox's game passes and
// developer products):
//   - a game pass is bought once and kept forever (VIP, double coins, a special tool)
//   - a developer product can be bought again and again (100 coins, a revive); each purchase
//     makes a receipt that the game's script hands out (ProcessReceipt) — until it does, the
//     receipt stays pending and is delivered again the next time the player joins that game
// Only a game's creator (the account it was published from) can add or change its items. The
// server alone decides prices, takes the tokens and records what each player owns; scripts in the
// game only ever ask. The creator earns 70% of every sale (see accounts.payForGameItem).
// Kept in data/market.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function installMarket(app, ctx){
  const { accounts, requireAuth, optionalUser, worldById, imageExists, DATA_DIR } = ctx;
  const FILE = path.join(DATA_DIR, 'market.json');
  const LIMITS = { perKind: 50, nameLen: 40, descLen: 200, minPrice: 1, maxPrice: 10000, pendingPerGame: 5, buysPerMinute: 20, receiptsKept: 20000 };

  let db = (()=>{ try{ return JSON.parse(fs.readFileSync(FILE, 'utf8')); }catch(e){ return null; } })() || {};
  db.nextId = db.nextId || 1;
  db.items = Array.isArray(db.items) ? db.items : [];
  db.owned = db.owned && typeof db.owned === 'object' ? db.owned : {};      // userId -> [pass ids]
  db.receipts = Array.isArray(db.receipts) ? db.receipts : [];              // developer product purchases
  const byId = new Map(db.items.map(i => [i.id, i]));
  function save(){
    try{
      fs.mkdirSync(DATA_DIR, { recursive:true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    }catch(e){ console.error('failed to save market.json', e); }
  }

  const clean = (s, n)=> String(s == null ? '' : s).replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
  function publicItem(i, forCreator){
    const o = { id: i.id, world: i.world, kind: i.kind, name: i.name, desc: i.desc, price: i.price, image: i.image || null, onSale: !!i.onSale };
    if(forCreator){ o.sales = i.sales || 0; o.earned = i.earned || 0; }
    return o;
  }
  // what a client may set on an item; returns { error } or the cleaned fields
  function itemFields(body, partial){
    const b = body || {}, out = {};
    if(!partial || b.name !== undefined){ out.name = clean(b.name, LIMITS.nameLen); if(!out.name) return { error:'Give it a name.' }; }
    if(!partial || b.desc !== undefined) out.desc = clean(b.desc, LIMITS.descLen);
    if(!partial || b.price !== undefined){
      const p = Number(b.price);
      if(!Number.isInteger(p) || p < LIMITS.minPrice || p > LIMITS.maxPrice) return { error:'Prices are whole numbers of tokens, from ' + LIMITS.minPrice + ' to ' + LIMITS.maxPrice + '.' };
      out.price = p;
    }
    if(!partial || b.image !== undefined){
      if(b.image === null || b.image === '' || b.image === undefined) out.image = null;
      else if(imageExists(b.image)) out.image = b.image;
      else return { error:'That picture doesn\'t exist any more — pick another one.' };
    }
    if(b.onSale !== undefined) out.onSale = !!b.onSale;
    return { fields: out };
  }
  function ownsPass(userId, id){ return Array.isArray(db.owned[userId]) && db.owned[userId].includes(id); }
  function pendingFor(userId, world){ return db.receipts.filter(r => r.buyer === userId && r.world === world && !r.done); }
  const buyBuckets = new Map();
  function buyAllowed(userId){
    const now = Date.now(), b = buyBuckets.get(userId) || { n: LIMITS.buysPerMinute, at: now };
    b.n = Math.min(LIMITS.buysPerMinute, b.n + (now - b.at) * LIMITS.buysPerMinute / 60000); b.at = now;
    buyBuckets.set(userId, b);
    if(b.n < 1) return false;
    b.n -= 1; return true;
  }
  setInterval(()=>{ const old = Date.now() - 120000; buyBuckets.forEach((b, k)=>{ if(b.at < old) buyBuckets.delete(k); }); }, 60000).unref();

  function gameOf(req, res){
    const w = worldById(String(req.params.worldId));
    if(!w){ res.status(404).json({ error:'No such game.' }); return null; }
    return w;
  }
  function itemOf(req, res){
    const i = byId.get(String(req.params.id));
    if(!i){ res.status(404).json({ error:'No such item.' }); return null; }
    return i;
  }
  function mustOwnGame(w, u, res){
    if(!w.ownerUserId || w.ownerUserId !== u.id){ res.status(403).json({ error: w.ownerUserId ? 'Only this game\'s creator can change its items.' : 'Publish this game while logged in to sell items in it.' }); return false; }
    return true;
  }

  // a game's items (anyone); its creator also sees sales and earnings
  app.get('/api/market/games/:worldId', (req, res) => {
    const w = gameOf(req, res); if(!w) return;
    const u = optionalUser(req);
    const creator = !!(u && w.ownerUserId && u.id === w.ownerUserId);
    // off-sale items are listed too (marked onSale:false): players who bought them still own them
    const items = db.items.filter(i => i.world === w.id).map(i => publicItem(i, creator));
    res.json({ items, creator, canSell: !!w.ownerUserId, share: accounts.CREATOR_SHARE });
  });
  // what you own in a game, and purchases the game still has to hand out
  app.get('/api/market/games/:worldId/mine', requireAuth, (req, res) => {
    const w = gameOf(req, res); if(!w) return;
    const u = req.authedUser;
    const passes = (db.owned[u.id] || []).filter(id => { const i = byId.get(id); return i && i.world === w.id; });
    const receipts = pendingFor(u.id, w.id).map(r => ({ id: r.id, item: r.item, price: r.price, at: r.at }));
    res.json({ passes, receipts, creator: w.ownerUserId === u.id });
  });
  app.post('/api/market/games/:worldId/items', requireAuth, (req, res) => {
    const w = gameOf(req, res); if(!w) return;
    const u = req.authedUser;
    if(!mustOwnGame(w, u, res)) return;
    const kind = req.body && req.body.kind === 'product' ? 'product' : req.body && req.body.kind === 'pass' ? 'pass' : null;
    if(!kind) return res.status(400).json({ error:'Pick a game pass or a developer product.' });
    if(db.items.filter(i => i.world === w.id && i.kind === kind).length >= LIMITS.perKind) return res.status(400).json({ error:'A game can have up to ' + LIMITS.perKind + ' ' + (kind === 'pass' ? 'game passes' : 'developer products') + '.' });
    const f = itemFields(req.body, false);
    if(f.error) return res.status(400).json({ error: f.error });
    const item = Object.assign({ id: String(db.nextId++), world: w.id, creator: u.id, kind, onSale: true, sales: 0, earned: 0, createdAt: Date.now(), updatedAt: Date.now() }, f.fields);
    db.items.push(item); byId.set(item.id, item); save();
    res.json(publicItem(item, true));
  });
  app.put('/api/market/items/:id', requireAuth, (req, res) => {
    const i = itemOf(req, res); if(!i) return;
    const w = worldById(i.world);
    if(!w) return res.status(404).json({ error:'No such game.' });
    if(!mustOwnGame(w, req.authedUser, res)) return;
    const f = itemFields(req.body, true);
    if(f.error) return res.status(400).json({ error: f.error });
    Object.assign(i, f.fields, { updatedAt: Date.now() });
    save();
    res.json(publicItem(i, true));
  });
  // Items nobody has bought yet can be deleted; after that they can only go off sale, so buyers keep them.
  app.delete('/api/market/items/:id', requireAuth, (req, res) => {
    const i = itemOf(req, res); if(!i) return;
    const w = worldById(i.world);
    if(!w) return res.status(404).json({ error:'No such game.' });
    if(!mustOwnGame(w, req.authedUser, res)) return;
    if(i.sales > 0 || db.receipts.some(r => r.item === i.id)) return res.status(400).json({ error:'Players have bought this, so it can\'t be deleted — take it off sale instead.' });
    db.items = db.items.filter(x => x !== i); byId.delete(i.id);
    Object.keys(db.owned).forEach(k => { db.owned[k] = db.owned[k].filter(id => id !== i.id); });
    save();
    res.json({ ok:true });
  });

  // Buy. `price` is the price the player was shown: if the creator changed it since, nothing is charged.
  app.post('/api/market/items/:id/buy', requireAuth, (req, res) => {
    const i = itemOf(req, res); if(!i) return;
    const u = req.authedUser;
    const w = worldById(i.world);
    if(!w) return res.status(404).json({ error:'That game isn\'t around any more.' });
    if(!i.onSale) return res.status(400).json({ error:'This isn\'t for sale right now.' });
    const shown = req.body && req.body.price;
    if(shown !== undefined && Number(shown) !== i.price) return res.status(409).json({ error:'The price just changed — it\'s now ' + i.price + ' tokens.', price: i.price });
    if(i.kind === 'pass' && ownsPass(u.id, i.id)) return res.status(400).json({ error:'You already own this pass.' });
    if(i.kind === 'product' && pendingFor(u.id, w.id).length >= LIMITS.pendingPerGame) return res.status(400).json({ error:'This game hasn\'t handed out your last purchases yet — play it to get them first.' });
    if(!buyAllowed(u.id)) return res.status(429).json({ error:'Buying too fast — wait a moment.' });
    const paid = accounts.payForGameItem(u, i.creator, i.price);
    if(paid.error) return res.status(400).json({ error: paid.error });
    // only real, paid sales count (not the creator's own or unlimited-token accounts' free ones)
    if(paid.charged > 0){ i.sales = (i.sales || 0) + 1; i.earned = (i.earned || 0) + paid.earned; }
    let receipt = null;
    if(i.kind === 'pass'){ (db.owned[u.id] = db.owned[u.id] || []).push(i.id); }
    else {
      receipt = { id: crypto.randomBytes(8).toString('hex'), item: i.id, world: w.id, buyer: u.id, price: paid.charged, at: Date.now(), done: false };
      db.receipts.push(receipt);
      // keep the history from growing forever (never dropping one that hasn't been handed out)
      if(db.receipts.length > LIMITS.receiptsKept){ const keep = db.receipts.filter(r => !r.done); const done = db.receipts.filter(r => r.done).slice(-(LIMITS.receiptsKept - keep.length)); db.receipts = done.concat(keep).sort((a, b) => a.at - b.at); }
    }
    save();
    res.json({ ok:true, item: publicItem(i), charged: paid.charged, receipt: receipt && { id: receipt.id, item: receipt.item, price: receipt.price, at: receipt.at }, user: accounts.publicUser(u) });
  });
  // the game's script handed out a developer product purchase (ProcessReceipt returned PurchaseGranted)
  app.post('/api/market/receipts/:id/granted', requireAuth, (req, res) => {
    const r = db.receipts.find(x => x.id === String(req.params.id) && x.buyer === req.authedUser.id);
    if(!r) return res.status(404).json({ error:'No such purchase.' });
    if(!r.done){ r.done = true; r.doneAt = Date.now(); save(); }
    res.json({ ok:true });
  });

  return { ownsPass };
};
