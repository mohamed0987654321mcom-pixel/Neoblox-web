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
for(const f of ['server.js','accounts.js','package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f));
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
  const srv = spawn(process.execPath, ['server.js'], { cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_PASSWORD: 'test-admin-secret-42' }), stdio: 'ignore' });
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
    console.log('\nALL ' + passed + ' NEOBLOX SERVER CHECKS PASSED');
  }catch(err){
    console.error('\nFAILED:', err);
    process.exitCode = 1;
  }finally{
    srv.kill('SIGKILL');
    fs.rmSync(TMP, { recursive:true, force:true });
  }
})();
