// Server checks for Neoblox: accounts + quests, Avatar Shop, game stats (visits / votes / playing),
// world ownership, only-owned cosmetics, and in-experience state relay.
// Run: npm test   (starts its own server on a spare port with a throwaway data folder)
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random()*1000);
const BASE = 'http://localhost:' + PORT;
const ROOT = path.join(__dirname, '..');
// run a copy of the app in a temp folder so the real ./data is never touched
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neoblox-test-'));
for(const f of ['server.js','accounts.js','market.js','package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f));
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(TMP, 'node_modules'), 'dir');
fs.mkdirSync(path.join(TMP, 'public'));

let passed = 0;
async function check(name, fn){ await fn(); passed++; console.log('  ✓', name); }
async function api(method, p, body, token){
  const headers = { 'content-type':'application/json' };
  if(token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(()=>null) };
}
function wsClient(){
  return new Promise((resolve)=>{
    const ws = new WebSocket('ws://localhost:' + PORT + '/ws');
    const inbox = [];
    ws.on('message', (raw)=>{ try{ inbox.push(JSON.parse(raw)); }catch(e){} });
    ws.on('open', ()=> resolve({ ws, inbox, send:(m)=>ws.send(JSON.stringify(m)) }));
  });
}
const wait = (ms)=> new Promise(r=>setTimeout(r, ms));

(async ()=>{
  const srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_PASSWORD: 'test-admin-secret-42', UNLIMITED_TOKENS: 'RichKid1, someoneelse' }), stdio: 'ignore' });
  try{
    for(let i=0;i<60;i++){ try{ if((await fetch(BASE + '/healthz')).ok) break; }catch(e){} await wait(100); }

    const reg = await api('POST', '/api/auth/register', { username:'shopper1', password:'secret123' });
    const token = reg.data.token;
    await check('sign up gives a session and an empty inventory', async ()=>{
      assert.equal(reg.status, 200);
      assert.deepEqual(reg.data.user.inventory, []);
      assert.equal(reg.data.user.tokens, 0);
    });
    await check('the shop lists items with prices', async ()=>{
      const r = await api('GET', '/api/shop');
      assert.ok(r.data.length >= 10);
      assert.ok(r.data.every(i => i.id && i.name && i.price > 0));
    });
    await check('buying without enough tokens is refused', async ()=>{
      const r = await api('POST', '/api/shop/buy/cap_red', null, token);
      assert.equal(r.status, 400);
      assert.match(r.data.error, /Not enough tokens/);
    });
    await check('the welcome gift quest pays 50 tokens (once)', async ()=>{
      const r = await api('POST', '/api/quests/welcome/claim', null, token);
      assert.equal(r.data.user.tokens, 50);
      const again = await api('POST', '/api/quests/welcome/claim', null, token);
      assert.equal(again.status, 400);
    });
    await check('buying an item takes tokens and adds it to the inventory', async ()=>{
      const r = await api('POST', '/api/shop/buy/cap_red', null, token);
      assert.equal(r.status, 200);
      assert.equal(r.data.user.tokens, 10);
      assert.deepEqual(r.data.user.inventory, ['cap_red']);
      const dup = await api('POST', '/api/shop/buy/cap_red', null, token);
      assert.equal(dup.status, 400);
      const guest = await api('POST', '/api/shop/buy/cap_red');
      assert.equal(guest.status, 401);
    });
    await check('others only see cosmetics you own', async ()=>{
      const a = await wsClient(), b = await wsClient();
      a.send({ t:'hello', name:'x', session: token, avatar:{ accessories:['cap_red','royal_crown'], face:'face_wink' } });
      b.send({ t:'hello', name:'guest', avatar:{ accessories:['cap_red'], face:'face_grin' } });
      await wait(300);
      const joinA = b.inbox.find(m => m.t==='player_join' && m.name==='shopper1');
      assert.ok(joinA, 'b hears a join');
      assert.deepEqual(joinA.avatar.accessories, ['cap_red']); // the crown isn't owned
      assert.equal(joinA.avatar.face, null);
      const joinB = a.inbox.find(m => m.t==='player_join' && m.name==='guest');
      assert.deepEqual(joinB.avatar.accessories, []);       // guests own nothing
      a.ws.close(); b.ws.close();
    });
    await check('joining a game counts a visit and shows as playing', async ()=>{
      const a = await wsClient();
      a.send({ t:'hello', name:'visitor' });
      a.send({ t:'presence', x:0, y:1, z:0, ry:0, world:'play:sky' });
      await wait(300);
      const r = await api('GET', '/api/games');
      const sky = r.data.find(g => g.key==='sky');
      assert.equal(sky.visits, 1);
      assert.equal(sky.playing, 1);
      a.ws.close();
      await wait(200);
      const after = (await api('GET', '/api/games')).data.find(g => g.key==='sky');
      assert.equal(after.playing, 0);
    });
    await check('thumbs up/down need an account and count once per account', async ()=>{
      assert.equal((await api('POST', '/api/games/sky/vote', { v:1 })).status, 401);
      let r = await api('POST', '/api/games/sky/vote', { v:1 }, token);
      assert.equal(r.data.up, 1); assert.equal(r.data.myVote, 1);
      r = await api('POST', '/api/games/sky/vote', { v:-1 }, token);
      assert.equal(r.data.up, 0); assert.equal(r.data.down, 1);
      assert.equal((await api('POST', '/api/games/nope/vote', { v:1 }, token)).status, 404);
    });
    await check('a world published from an account can only be changed by that account', async ()=>{
      const pub = await api('POST', '/api/worlds', { name:'Mine', blocks:[[0,0,0,'plastic']], ownerUserId:'hacker', visits:999 }, token);
      const id = pub.data.id;
      const list = (await api('GET', '/api/worlds')).data;
      const w = list.find(x => x.id===id);
      assert.equal(w.visits, undefined); // clients can't set server fields
      assert.notEqual(w.ownerUserId, 'hacker');
      assert.equal((await api('PUT', '/api/worlds/' + id, { name:'Stolen' })).status, 403);
      const other = await api('POST', '/api/auth/register', { username:'someoneelse', password:'secret123' });
      assert.equal((await api('PUT', '/api/worlds/' + id, { name:'Stolen' }, other.data.token)).status, 403);
      assert.equal((await api('PUT', '/api/worlds/' + id, { name:'Mine v2' }, token)).status, 200);
      const me = await api('GET', '/api/me', null, token);
      assert.ok(me.data.user.quests.find(q => q.id==='world_builder').canClaim);
    });
    await check('world scripts are stored, capped in number and size', async ()=>{
      const many = Array.from({ length: 50 }, (_, i) => ({ id:'s'+i, name:'Script<'+i+'>', code: i === 0 ? 'x'.repeat(25000) : 'print(' + i + ')' }));
      const r = await api('POST', '/api/worlds', { name:'Scripted', blocks:[[0,0,0,'plastic','js','print(1)']], scripts: many });
      const w = (await api('GET', '/api/worlds')).data.find(x => x.id === r.data.id);
      assert.equal(w.scripts.length, 40);
      assert.equal(w.scripts[0].code.length, 20000);
      assert.equal(w.scripts[1].name, 'Script1');
      assert.equal(w.blocks[0][4], 'js');
      const r2 = await api('POST', '/api/worlds', { name:'Bad', scripts: 'nope' });
      assert.equal((await api('GET', '/api/worlds')).data.find(x => x.id === r2.data.id).scripts, undefined);
    });
    await check('pictures: upload, serve safely, list, cover, delete', async ()=>{
      // a real 1×1 PNG
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const up = (body, tok, type)=> fetch(BASE + '/api/images', { method:'POST', headers: Object.assign({ 'content-type': type || 'image/png', 'x-image-name': encodeURIComponent('My <b>Logo</b>.png') }, tok ? { authorization:'Bearer ' + tok } : {}), body });
      assert.equal((await up(png)).status, 401);                                   // needs an account
      const html = await up(Buffer.from('<html><script>alert(1)</script></html>'), token, 'image/png');
      assert.equal(html.status, 400);                                                 // not really a picture
      const r = await up(png, token);
      assert.equal(r.status, 200);
      const img = await r.json();
      assert.match(img.id, /^[a-z0-9]{12,32}$/);
      assert.equal(img.name, 'My bLogo/b');                                           // tags stripped
      const got = await fetch(BASE + img.url);
      assert.equal(got.status, 200);
      assert.equal(got.headers.get('content-type'), 'image/png');
      assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
      assert.match(got.headers.get('content-security-policy'), /sandbox/);
      assert.equal(Buffer.from(await got.arrayBuffer()).length, png.length);
      assert.equal((await fetch(BASE + '/img/../server.js')).status, 404);
      assert.equal((await fetch(BASE + '/img/notarealpictureid0')).status, 404);
      const mine = await api('GET', '/api/images/mine', null, token);
      assert.equal(mine.data.length, 1);
      // a world can use it as its cover; junk covers are dropped
      const w1 = await api('POST', '/api/worlds', { name:'Cover', blocks:[], cover: img.id });
      const w2 = await api('POST', '/api/worlds', { name:'Bad cover', blocks:[], cover: 'javascript:alert(1)' });
      const list = (await api('GET', '/api/worlds')).data;
      assert.equal(list.find(x => x.id === w1.data.id).cover, img.id);
      assert.equal(list.find(x => x.id === w2.data.id).cover, undefined);
      // only the uploader (or an admin) can delete it
      const other = await api('POST', '/api/auth/register', { username:'painter2', password:'secret123' });
      assert.equal((await api('DELETE', '/api/images/' + img.id, null, other.data.token)).status, 403);
      assert.equal((await api('DELETE', '/api/images/' + img.id, null, token)).status, 200);
      assert.equal((await fetch(BASE + img.url)).status, 404);
    });
    await check('admin needs the server\'s own password — the old built-in one no longer works', async ()=>{
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const img = await (await fetch(BASE + '/api/images', { method:'POST', headers:{ 'content-type':'image/png', authorization:'Bearer ' + token }, body: png })).json();
      const del = (pass)=> fetch(BASE + '/api/images/' + img.id, { method:'DELETE', headers:{ 'x-admin-password': pass } });
      assert.equal((await del('ThunderKing2026')).status, 403);
      assert.equal((await del('')).status, 403);
      assert.equal((await del('test-admin-secret-42')).status, 200);
      const c = await wsClient();
      c.send({ t:'hello', name:'Guesser' });
      for(let i = 0; i < 6; i++) c.send({ t:'admin_auth', pass: i < 5 ? 'wrong' + i : 'test-admin-secret-42' });
      await wait(250);
      assert.equal(c.inbox.filter(m => m.t==='admin_fail').length, 6);   // the right one is refused after 5 misses
      assert.ok(!c.inbox.some(m => m.t==='admin_ok'));
      c.ws.close();
      const d = await wsClient();
      d.send({ t:'hello', name:'Owner' }); d.send({ t:'admin_auth', pass:'test-admin-secret-42' });
      await wait(200);
      assert.ok(d.inbox.some(m => m.t==='admin_ok'));
      d.ws.close();
    });
    await check('UNLIMITED_TOKENS accounts buy anything for free; others still pay', async ()=>{
      const rich = await api('POST', '/api/auth/register', { username:'richkid1', password:'secret123' });
      assert.equal(rich.data.user.unlimited, true);
      assert.ok(rich.data.user.tokens > 1000000);
      const shopList = (await api('GET', '/api/shop')).data;
      const priciest = shopList.slice().sort((a, b) => b.price - a.price)[0];
      const bought = await api('POST', '/api/shop/buy/' + priciest.id, null, rich.data.token);
      assert.equal(bought.status, 200);
      assert.ok(bought.data.user.inventory.includes(priciest.id));
      const poor = await api('POST', '/api/auth/register', { username:'poorkid1', password:'secret123' });
      assert.equal(poor.data.user.unlimited, false);
      assert.equal((await api('POST', '/api/shop/buy/' + priciest.id, null, poor.data.token)).status, 400);
    });
    await check('knocked-out state and leaderstats reach others in the same world', async ()=>{
      const a = await wsClient(), b = await wsClient();
      a.send({ t:'hello', name:'A' }); b.send({ t:'hello', name:'B' });
      a.send({ t:'presence', x:0,y:1,z:0, ry:0, world:'play:sky' });
      b.send({ t:'presence', x:0,y:1,z:0, ry:0, world:'play:sky' });
      await wait(200);
      a.send({ t:'pstate', dead:true, stats:{ Stage:3, 'bad<key>':5, Long:'x'.repeat(40) } });
      await wait(200);
      const m = b.inbox.find(x => x.t==='pstate');
      assert.ok(m, 'b gets pstate');
      assert.equal(m.dead, true);
      assert.equal(m.stats.Stage, 3);
      assert.equal(m.stats.badkey, 5);           // sanitized key
      assert.equal(m.stats.Long.length, 16);     // trimmed value
      a.ws.close(); b.ws.close();
    });
    await check('game saves: each account keeps its own progress per game, with limits', async ()=>{
      const game = (await api('POST', '/api/worlds', { name:'Coins', blocks:[] }, token)).data.id;
      const game2 = (await api('POST', '/api/worlds', { name:'Other', blocks:[] })).data.id;
      const other = (await api('POST', '/api/auth/register', { username:'saver2', password:'secret123' })).data.token;
      // needs an account, and a real game
      assert.equal((await api('GET', '/api/saves/' + game)).status, 401);
      assert.equal((await api('GET', '/api/saves/99999', null, token)).status, 404);
      assert.equal((await api('GET', '/api/saves/..%2F..%2Fusers', null, token)).status, 404);
      // nothing saved yet
      let r = await api('GET', '/api/saves/' + game, null, token);
      assert.equal(r.status, 200); assert.equal(r.data.data, null);
      // save, then load it back
      const data = { PlayerData: { 'Player_{me}': { Coins: 42, Items: ['sword'] } } };
      r = await api('PUT', '/api/saves/' + game, { data }, token);
      assert.equal(r.status, 200); assert.ok(r.data.updatedAt > 0);
      r = await api('GET', '/api/saves/' + game, null, token);
      assert.deepEqual(r.data.data, data);
      // another account and another game don't see it
      assert.equal((await api('GET', '/api/saves/' + game, null, other)).data.data, null);
      assert.equal((await api('GET', '/api/saves/' + game2, null, token)).data.data, null);
      // bad shapes and too much data are refused (and don't replace the good save)
      assert.equal((await api('PUT', '/api/saves/' + game, { data:[1,2] }, token)).status, 400);
      assert.equal((await api('PUT', '/api/saves/' + game, { data:'hi' }, token)).status, 400);
      assert.equal((await api('PUT', '/api/saves/' + game, { data:{ big:'x'.repeat(60000) } }, token)).status, 413);
      assert.deepEqual((await api('GET', '/api/saves/' + game, null, token)).data.data, data);
      // a burst of numbered writes from one play session: whatever order they arrive in, the newest wins
      const puts = []; for(let i = 1; i <= 8; i++) puts.push(api('PUT', '/api/saves/' + game, { data:{ n: i }, sid:'burst1', rev: i }, other));
      await Promise.all(puts);
      assert.deepEqual((await api('GET', '/api/saves/' + game, null, other)).data.data, { n: 8 });
      // within one play session, an older write that arrives late doesn't replace a newer one
      assert.equal((await api('PUT', '/api/saves/' + game2, { data:{ v:'new' }, sid:'abc123', rev:5 }, token)).status, 200);
      r = await api('PUT', '/api/saves/' + game2, { data:{ v:'old' }, sid:'abc123', rev:4 }, token);
      assert.equal(r.status, 200); assert.equal(r.data.stale, true);
      assert.deepEqual((await api('GET', '/api/saves/' + game2, null, token)).data.data, { v:'new' });
      assert.equal((await api('PUT', '/api/saves/' + game2, { data:{ v:'next visit' }, sid:'zzz999', rev:1 }, token)).status, 200);
      assert.deepEqual((await api('GET', '/api/saves/' + game2, null, token)).data.data, { v:'next visit' });
      // saving too often is slowed down
      let limited = false;
      for(let i = 0; i < 40 && !limited; i++) limited = (await api('PUT', '/api/saves/' + game, { data:{ i } }, other)).status === 429;
      assert.ok(limited, 'rate limited');
      // on disk: one file per account per game, inside data/saves
      const f = path.join(TMP, 'data', 'saves', 'u' + reg.data.user.id, game + '.json');
      assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).data, data);
    });
    await check('paid items: creators sell passes + products for tokens and earn 70%', async ()=>{
      const reg2 = async (name)=> (await api('POST', '/api/auth/register', { username:name, password:'secret123' })).data;
      const me = async (tok)=> (await api('GET', '/api/me', null, tok)).data.user || (await api('GET', '/api/me', null, tok)).data;
      const creator = await reg2('maker1'), buyer = await reg2('buyer1'), other = await reg2('nosy1');
      await api('POST', '/api/quests/welcome/claim', null, buyer.token);   // buyer: 50 tokens
      const game = (await api('POST', '/api/worlds', { name:'Shop Game', blocks:[] }, creator.token)).data.id;
      const anon = (await api('POST', '/api/worlds', { name:'No Owner', blocks:[] })).data.id;
      const P = (p)=> '/api/market' + p;
      // only the creator adds items; a game published without an account can't sell
      assert.equal((await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'VIP', price:30 }, other.token)).status, 403);
      assert.equal((await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'VIP', price:30 })).status, 401);
      assert.equal((await api('POST', P('/games/' + anon + '/items'), { kind:'pass', name:'VIP', price:30 }, creator.token)).status, 403);
      // checks on what an item can be
      assert.equal((await api('POST', P('/games/' + game + '/items'), { kind:'hat', name:'X', price:5 }, creator.token)).status, 400);
      assert.equal((await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'  ', price:5 }, creator.token)).status, 400);
      assert.equal((await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'X', price:0 }, creator.token)).status, 400);
      assert.equal((await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'X', price:2.5 }, creator.token)).status, 400);
      assert.equal((await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'X', price:5, image:'notapicture1234' }, creator.token)).status, 400);
      const vip = (await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'<b>VIP</b>', desc:'Run faster', price:30 }, creator.token)).data;
      const coins = (await api('POST', P('/games/' + game + '/items'), { kind:'product', name:'100 Coins', price:10 }, creator.token)).data;
      assert.match(vip.id, /^\d+$/); assert.equal(vip.name, 'bVIP/b'); assert.equal(vip.onSale, true);
      // anyone sees the list; only the creator sees sales
      let list = (await api('GET', P('/games/' + game))).data;
      assert.equal(list.items.length, 2); assert.equal(list.items[0].sales, undefined); assert.equal(list.creator, false);
      assert.equal((await api('GET', P('/games/' + game), null, creator.token)).data.items[0].sales, 0);
      // buying: price shown must match, tokens move 30 → creator gets 21 (70%)
      const before = (await me(creator.token)).tokens;
      assert.equal((await api('POST', P('/items/' + vip.id + '/buy'), { price:25 }, buyer.token)).status, 409);
      let r = await api('POST', P('/items/' + vip.id + '/buy'), { price:30 }, buyer.token);
      assert.equal(r.status, 200); assert.equal(r.data.charged, 30); assert.equal(r.data.user.tokens, 20);
      assert.equal((await me(creator.token)).tokens, before + 21);
      assert.equal((await api('POST', P('/items/' + vip.id + '/buy'), { price:30 }, buyer.token)).status, 400);   // already own it
      let mine = (await api('GET', P('/games/' + game + '/mine'), null, buyer.token)).data;
      assert.deepEqual(mine.passes, [vip.id]);
      // not enough tokens
      const pricey = (await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'Mega', price:500 }, creator.token)).data;
      r = await api('POST', P('/items/' + pricey.id + '/buy'), { price:500 }, buyer.token);
      assert.equal(r.status, 400); assert.match(r.data.error, /Not enough tokens — you need 480 more/);
      // products: bought again and again, each one a receipt the game hands out
      r = await api('POST', P('/items/' + coins.id + '/buy'), { price:10 }, buyer.token);
      assert.equal(r.status, 200); assert.ok(r.data.receipt.id);
      const rid = r.data.receipt.id;
      assert.equal((await api('POST', P('/items/' + coins.id + '/buy'), { price:10 }, buyer.token)).status, 200);
      mine = (await api('GET', P('/games/' + game + '/mine'), null, buyer.token)).data;
      assert.equal(mine.receipts.length, 2);
      assert.equal((await api('POST', P('/receipts/' + rid + '/granted'), null, other.token)).status, 404);   // not theirs
      assert.equal((await api('POST', P('/receipts/' + rid + '/granted'), null, buyer.token)).status, 200);
      mine = (await api('GET', P('/games/' + game + '/mine'), null, buyer.token)).data;
      assert.equal(mine.receipts.length, 1);
      assert.equal((await me(buyer.token)).tokens, 0);
      // too many purchases the game hasn't handed out yet: no more for now
      const rich = (await api('POST', '/api/auth/login', { username:'richkid1', password:'secret123' })).data;
      for(let i = 0; i < 5; i++) await api('POST', P('/items/' + coins.id + '/buy'), { price:10 }, rich.token);
      r = await api('POST', P('/items/' + coins.id + '/buy'), { price:10 }, rich.token);
      assert.equal(r.status, 400); assert.match(r.data.error, /hasn't handed out your last purchases/);
      // unlimited-token accounts and the creator buying their own: free, and nobody earns from it
      const c1 = (await me(creator.token)).tokens;
      assert.equal((await api('POST', P('/items/' + pricey.id + '/buy'), { price:500 }, rich.token)).data.charged, 0);
      assert.equal((await api('POST', P('/items/' + pricey.id + '/buy'), { price:500 }, creator.token)).data.charged, 0);
      assert.equal((await me(creator.token)).tokens, c1);
      // the creator's sales: 1 VIP (21) + 2 coins (7 each) — free buys aren't counted
      list = (await api('GET', P('/games/' + game), null, creator.token)).data;
      const byName = Object.fromEntries(list.items.map(i => [i.name, i]));
      assert.equal(byName['bVIP/b'].sales, 1); assert.equal(byName['bVIP/b'].earned, 21);
      assert.equal(byName['100 Coins'].sales, 2); assert.equal(byName['100 Coins'].earned, 14);
      assert.equal(byName.Mega.sales, 0);
      // editing: price changes, off sale; only the creator
      assert.equal((await api('PUT', P('/items/' + vip.id), { price:40 }, other.token)).status, 403);
      assert.equal((await api('PUT', P('/items/' + vip.id), { price:40, onSale:false }, creator.token)).data.price, 40);
      assert.equal((await api('POST', P('/items/' + vip.id + '/buy'), { price:40 }, other.token)).status, 400);    // off sale
      assert.deepEqual((await api('GET', P('/games/' + game + '/mine'), null, buyer.token)).data.passes, [vip.id]); // buyers keep it
      // delete: only items nobody bought
      assert.equal((await api('DELETE', P('/items/' + vip.id), null, creator.token)).status, 400);
      const unsold = (await api('POST', P('/games/' + game + '/items'), { kind:'pass', name:'Unsold', price:5 }, creator.token)).data;
      assert.equal((await api('DELETE', P('/items/' + unsold.id), null, other.token)).status, 403);
      assert.equal((await api('DELETE', P('/items/' + unsold.id), null, creator.token)).status, 200);
      assert.equal((await api('GET', P('/games/' + game))).data.items.length, 3);
      // unknown game / item
      assert.equal((await api('GET', P('/games/99999'))).status, 404);
      assert.equal((await api('POST', P('/items/99999/buy'), {}, buyer.token)).status, 404);
      // kept on disk
      const disk = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'market.json'), 'utf8'));
      assert.ok(disk.items.length === 3 && disk.owned[buyer.user.id].includes(vip.id));
    });
    console.log('\nALL ' + passed + ' NEOBLOX SERVER CHECKS PASSED');
  }catch(err){
    console.error('\nFAILED:', err);
    process.exitCode = 1;
  }finally{
    srv.kill('SIGKILL');
    fs.rmSync(TMP, { recursive:true, force:true });
  }
})();
