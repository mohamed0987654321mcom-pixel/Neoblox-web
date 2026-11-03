// rbx/flagday.js — NeoFlagDay: UAE Flag Day (November 3). On that day (UAE time) Neoblox's Home
// wears the flag's colours — red, green, white and black — with a waving flag banner. The next
// day it's back to normal by itself. Anyone can keep the look after the day ("Keep it after
// today") or switch back to normal at any time (the banner, or the 🇦🇪 switch in the sidebar).
//
// Your choice is remembered on this device (localStorage 'nb_flagday'):
//   'keep'       → the look stays, every day, until you switch it off
//   'off:2026'   → off for that year's Flag Day (it comes back on next year's)
//   (nothing)    → on during Flag Day only
'use strict';
(function(){
  const FD = window.NeoFlagDay = {};
  const KEY = 'nb_flagday';
  const get = ()=>{ try{ return localStorage.getItem(KEY) || ''; }catch(e){ return ''; } };
  const put = (v)=>{ try{ if(v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); }catch(e){} };

  // today's date in the UAE (Asia/Dubai), as { y, md:'11-03' } — the tests can pretend with FD.today
  function uaeToday(){
    if(FD.today) return FD.today;
    if(window.NB_FLAGDAY_TODAY) return window.NB_FLAGDAY_TODAY; // (for the tests)
    try{
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const v = (t)=> (p.find(x=> x.type === t) || {}).value;
      return { y: v('year'), md: v('month') + '-' + v('day') };
    }catch(e){ const d = new Date(Date.now() + 4 * 3600e3); return { y: String(d.getUTCFullYear()), md: String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0') }; }
  }
  FD.isFlagDay = ()=> uaeToday().md === '11-03';
  FD.active = function(){
    const c = get(), t = uaeToday();
    if(c === 'keep') return true;
    return FD.isFlagDay() && c !== 'off:' + t.y;
  };
  FD.choice = get;
  FD.keep = function(){ put('keep'); apply(); if(typeof showToast === 'function') showToast('🇦🇪 Keeping the Flag Day look — switch it off any time in the sidebar'); };
  FD.normal = function(){ put(FD.isFlagDay() ? 'off:' + uaeToday().y : ''); apply(); if(typeof showToast === 'function') showToast('Back to the normal Neoblox look'); };
  FD.toggle = function(){ if(FD.active()) FD.normal(); else { put(FD.isFlagDay() ? '' : 'keep'); apply(); } };

  // ------------------------------------------------------------------ the banner + the switch
  function flagHtml(){
    const N = 24, w = 192 / N;
    let s = '';
    for(let i = 0; i < N; i++) s += '<i class="s" style="background-position:' + (-i * w) + 'px 0,' + (-i * w) + 'px 0;animation-delay:' + (-i * 0.09).toFixed(2) + 's"></i>';
    return '<div class="nbfd-flag" aria-hidden="true"><div class="pole"></div><div class="cloth">' + s + '</div></div>';
  }
  function build(){
    const home = document.querySelector('#nbHome section[data-page="home"]');
    if(home && !document.getElementById('nbfdHero')){
      const el = document.createElement('div');
      el.className = 'nbfd-hero'; el.id = 'nbfdHero';
      el.innerHTML = flagHtml() + '<div class="nbfd-text"><div class="nbfd-kicker">November 3 · Flag Day<span class="ar" lang="ar" dir="rtl">يوم العلم</span></div>' +
        '<h2>🇦🇪 Happy UAE Flag Day!</h2><p id="nbfdSub"></p><div class="nbfd-btns" id="nbfdBtns"></div></div>';
      home.insertBefore(el, home.firstChild);
      el.addEventListener('click', (e)=>{
        const b = e.target.closest('button[data-fd]'); if(!b) return;
        if(b.dataset.fd === 'keep') FD.keep(); else if(b.dataset.fd === 'normal') FD.normal();
      });
    }
    const side = document.getElementById('nhSide');
    if(side && !document.getElementById('nbfdSwitch')){
      const b = document.createElement('button');
      b.className = 'nh-link nbfd-switch'; b.id = 'nbfdSwitch'; b.type = 'button';
      b.innerHTML = '<span class="ic">🇦🇪</span>Flag Day look<span class="tog" aria-hidden="true"></span>';
      b.addEventListener('click', ()=> FD.toggle());
      side.insertBefore(b, side.querySelector('.foot'));
    }
  }
  let applied = null;
  function apply(){
    build();
    const on = FD.active(), today = FD.isFlagDay(), kept = get() === 'keep';
    document.body.classList.toggle('nb-flagday', on);
    document.body.classList.toggle('nbfd-today', today);   // the banner is for the day itself
    document.body.classList.toggle('nbfd-offer', today || kept); // the sidebar switch
    const sw = document.getElementById('nbfdSwitch');
    if(sw){ sw.setAttribute('aria-pressed', on ? 'true' : 'false'); sw.title = on ? 'Switch back to the normal look' : 'Wear the UAE Flag Day look'; }
    const sub = document.getElementById('nbfdSub'), btns = document.getElementById('nbfdBtns');
    if(sub && btns){
      // (the banner only shows while the look is on — to bring it back, there's the sidebar switch)
      sub.textContent = kept ? 'You\'re keeping the flag\'s colours after today too. Switch back to normal any time.'
        : 'Neoblox is wearing the flag\'s colours today — red, green, white and black. Flags go up across the UAE at 11am. Tomorrow it\'s back to normal by itself.';
      btns.innerHTML = kept ? '<span class="kept">✓ Kept</span><button class="normal" data-fd="normal">Back to normal</button>'
        : '<button class="keep" data-fd="keep">Keep it after today</button><button class="normal" data-fd="normal">Back to normal</button>';
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if(meta){ if(meta.dataset.normal === undefined) meta.dataset.normal = meta.content; meta.content = on ? '#00732f' : meta.dataset.normal; }
    applied = on;
  }
  FD.refresh = apply;

  // 11am in the UAE: the flags go up
  function elevenAm(){
    if(!FD.isFlagDay() || !FD.active()) return;
    const t = new Date(Date.now() + 4 * 3600e3), key = 'nb_flagday_11_' + uaeToday().y;
    if(t.getUTCHours() !== 11 || t.getUTCMinutes() > 5) return;
    try{ if(localStorage.getItem(key)) return; localStorage.setItem(key, '1'); }catch(e){}
    if(typeof showToast === 'function') showToast('🇦🇪 It\'s 11am — flags are going up across the UAE!');
  }

  function start(){ apply(); elevenAm(); setInterval(()=>{ const was = applied; apply(); if(was !== applied && !applied && typeof showToast === 'function') showToast('Flag Day is over — back to the normal look'); elevenAm(); }, 60000); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
